use super::*;
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pause {
    task_id: String,
    expected_run_id: String,
    expected_revision: u64,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reply {
    task_id: String,
    run_id: String,
    question_id: String,
    answers: BTreeMap<String, String>,
}
struct Mutation {
    params: Value,
    target: Value,
    capability: &'static str,
    method: &'static str,
}
fn identity(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|id| !id.is_empty() && id.len() <= 128)
}
fn revision(value: &Value) -> bool {
    value.as_u64().is_some_and(|n| n <= 9_007_199_254_740_991)
}
fn pause_state(task: &Value, run_id: &Value) -> Value {
    let runs = task["runs"].as_array();
    let run = runs.and_then(|runs| runs.iter().find(|run| run["id"] == *run_id));
    let workers = run
        .and_then(|run| run["workers"].as_array())
        .is_some_and(|workers| workers.iter().all(|worker| worker["settled"] == true));
    let status = run
        .map(|run| run["status"].clone())
        .unwrap_or(json!("unavailable"));
    json!({"taskId":task["id"],"runId":run_id,"revision":task["revision"],"taskPaused":task["paused"]==true,"taskCancelled":task["cancelled"]==true,"currentRunId":runs.and_then(|runs|runs.last()).map(|run|run["id"].clone()),"runStatus":status,"reason":run.and_then(|run|run["reason"].as_str()).map(|reason|reason.chars().take(128).collect::<String>()),"workersSettled":workers,"settled":task["paused"]==true&&workers&&matches!(status.as_str(),Some("paused"|"completed"|"failed"|"cancelled")),"provesCommandAdmission":false})
}
pub(crate) fn native_digest(method: &str, params: &Value) -> Result<String> {
    let bytes = match method {
        "areal/task/pause" => serde_json::to_vec(&serde_json::from_value::<
            areal_protocol::tasks::TaskControl,
        >(params.clone())?)?,
        "areal/channel/reply" => serde_json::to_vec(&serde_json::from_value::<
            areal_protocol::tasks::ChannelReply,
        >(params.clone())?)?,
        _ => return Err(fail("INVALID_PARAMS")),
    };
    Ok(areal_local_service::storage::digest(&bytes))
}
pub(crate) fn apply_result(record: &mut Value, result: &Value) -> bool {
    let params = &record["params"];
    let receipt = if record["method"] == "areal/task/pause" {
        if result["id"] != params["taskId"]
            || result["paused"] != true
            || result["runs"]
                .as_array()
                .and_then(|runs| runs.last())
                .is_none_or(|run| run["id"] != params["expectedRunId"])
            || !revision(&result["revision"])
            || params["expectedRevision"]
                .as_u64()
                .is_none_or(|old| result["revision"].as_u64() != old.checked_add(1))
        {
            return false;
        }
        json!({"taskId":result["id"],"runId":params["expectedRunId"],"revision":result["revision"],"paused":true})
    } else {
        if result["accepted"] != true
            || !["messageId", "taskId", "runId"]
                .iter()
                .all(|key| identity(&result[key]))
            || result["taskId"] != params["taskId"]
            || result["runId"] != params["runId"]
            || !revision(&result["channelSequence"])
            || result["channelSequence"] == 0
        {
            return false;
        }
        json!({"accepted":true,"messageId":result["messageId"],"taskId":result["taskId"],"runId":result["runId"],"channelSequence":result["channelSequence"]})
    };
    record["receipt"] = receipt;
    record["admissionState"] = json!("accepted");
    true
}
impl Session {
    async fn task_state(
        &self,
        project: &str,
        generation: &str,
        target: &Value,
    ) -> Result<(Value, Option<Value>, bool, Value)> {
        let id = self.project_id(project)?;
        let scope = self
            .host
            .schedules
            .connections
            .shared_identity(&self.host, &id)?;
        let check = || -> Result<()> {
            self.authorize(Some(project), "observe")?;
            ensure!(
                self.host
                    .schedules
                    .connections
                    .shared_identity(&self.host, &id)?
                    == scope,
                "RESYNC_REQUIRED"
            );
            Ok(())
        };
        let caps = self
            .rpc(project, generation, "areal/capabilities", json!({}))
            .await?;
        ensure!(
            ["areal/task/read"]
                .into_iter()
                .chain(target.get("questionId").map(|_| "areal/channel/read"))
                .all(|method| caps["methods"]
                    .as_array()
                    .is_some_and(|methods| methods.iter().any(|item| item == method))),
            "CORE_INCOMPATIBLE"
        );
        let task = self
            .rpc(
                project,
                generation,
                "areal/task/read",
                json!({"taskId":target["taskId"]}),
            )
            .await
            .map_err(|error| {
                if error
                    .downcast_ref::<crate::server::schedule_connection::RpcFailure>()
                    .is_some_and(|failure| {
                        matches!(failure.0["code"].as_i64(), Some(-32004 | -32009))
                    })
                {
                    fail("TARGET_CHANGED")
                } else {
                    error
                }
            })?;
        check()?;
        ensure!(
            serde_json::to_vec(&task)?.len() <= 4 * 1024 * 1024,
            "RESOURCE_UNAVAILABLE"
        );
        ensure!(
            task["id"] == target["taskId"]
                && target.get("runId").is_none_or(|id| task["runs"]
                    .as_array()
                    .is_some_and(|runs| runs.iter().any(|run| run["id"] == *id))),
            "TARGET_CHANGED"
        );
        if target.get("questionId").is_none() {
            return Ok((task, None, true, caps));
        }
        let mut after = 0u64;
        let mut bytes = 0;
        let mut item = None;
        let mut complete = false;
        for _ in 0..8 {
            let result = self
                .rpc(
                    project,
                    generation,
                    "areal/channel/read",
                    json!({"taskId":target["taskId"],"afterSequence":after,"limit":100}),
                )
                .await?;
            check()?;
            bytes += serde_json::to_vec(&result)?.len();
            if bytes > 4 * 1024 * 1024 {
                break;
            }
            let rows = result["data"].as_array().context("TARGET_CHANGED")?;
            ensure!(
                result["taskId"] == target["taskId"] && rows.len() <= 100,
                "TARGET_CHANGED"
            );
            item = rows
                .iter()
                .find(|item| {
                    item["id"] == target["questionId"]
                        && item["runId"] == target["runId"]
                        && item["kind"] == "question"
                })
                .cloned();
            if item.is_some() || result["hasMore"] != true {
                complete = true;
                break;
            }
            let Some(next) = result["nextSequence"]
                .as_u64()
                .filter(|next| *next > after && *next <= 9_007_199_254_740_991)
            else {
                break;
            };
            after = next;
        }
        check()?;
        ensure!(item.is_some() || !complete, "TARGET_CHANGED");
        Ok((task, item, complete, caps))
    }
    pub(super) async fn task_read(
        &self,
        project: &str,
        generation: &str,
        params: &Value,
        question: bool,
    ) -> Result<Value> {
        ensure!(
            exact(
                params,
                if question {
                    &["taskId", "runId", "questionId"]
                } else {
                    &["taskId", "runId"]
                }
            ),
            "INVALID_PARAMS"
        );
        ensure!(
            identity(&params["taskId"])
                && params.get("runId").is_none_or(identity)
                && (!question || (identity(&params["runId"]) && identity(&params["questionId"]))),
            "INVALID_PARAMS"
        );
        let (task, item, complete, caps) = self.task_state(project, generation, params).await?;
        if !question {
            let mut result = pause_state(&task, &params["runId"]);
            result["projectId"] = json!(project);
            result["serviceGeneration"] = json!(generation);
            result["available"] = json!(
                identity(&params["runId"])
                    && result["currentRunId"] == params["runId"]
                    && task["paused"] != true
                    && task["cancelled"] != true
                    && revision(&task["revision"])
                    && caps["features"]["taskPauseRunGuard"] == true
                    && caps["methods"].as_array().is_some_and(|methods| methods
                        .iter()
                        .any(|method| method == "areal/task/pause"))
            );
            return Ok(result);
        }
        let item = item.unwrap_or(Value::Null);
        let questions = &item["questions"];
        let complete = complete
            && questions
                .as_array()
                .is_some_and(|q| !q.is_empty() && q.len() <= 8)
            && serde_json::to_vec(questions)?.len() <= 32 * 1024;
        let run = task["runs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|run| run["id"] == params["runId"])
            .unwrap();
        Ok(
            json!({"projectId":project,"serviceGeneration":generation,"taskId":params["taskId"],"runId":params["runId"],"questionId":params["questionId"],"kind":"asyncQuestion","taskPaused":task["paused"]==true,"taskCancelled":task["cancelled"]==true,"runStatus":run["status"],"status":item.get("status").cloned().unwrap_or(json!("unavailable")),"expiresAt":item["expiresAt"],"complete":complete,"questions":if complete{questions.clone()}else{json!([])}}),
        )
    }
    pub(super) async fn task_command(
        &self,
        project: &str,
        generation: &str,
        request: &Value,
    ) -> Result<Value> {
        ensure!(
            exact(
                &request["context"],
                &[
                    "projectId",
                    "gatewayGeneration",
                    "grantRevision",
                    "serviceGeneration"
                ]
            ),
            "INVALID_PARAMS"
        );
        let pause = request["method"] == "task.pause";
        let (params, target, capability, method) = if pause {
            let params: Pause =
                serde_json::from_value(request["params"].clone()).context("INVALID_PARAMS")?;
            let params = serde_json::to_value(params)?;
            ensure!(
                identity(&params["taskId"])
                    && identity(&params["expectedRunId"])
                    && revision(&params["expectedRevision"]),
                "INVALID_PARAMS"
            );
            (params.clone(), params, "pauseTask", "areal/task/pause")
        } else {
            let params: Reply =
                serde_json::from_value(request["params"].clone()).context("INVALID_PARAMS")?;
            let params = serde_json::to_value(params)?;
            ensure!(
                ["taskId", "runId", "questionId"]
                    .iter()
                    .all(|key| identity(&params[key]))
                    && params["answers"]
                        .as_object()
                        .is_some_and(|answers| !answers.is_empty()
                            && answers.len() <= 8
                            && answers.iter().all(|(id, answer)| !id.is_empty()
                                && id.len() <= 128
                                && answer
                                    .as_str()
                                    .is_some_and(
                                        |answer| !answer.trim().is_empty() && answer.len() <= 4096
                                    ))),
                "INVALID_PARAMS"
            );
            let target = json!({"taskId":params["taskId"],"runId":params["runId"],"questionId":params["questionId"]});
            (params, target, "answer", "areal/channel/reply")
        };
        let bytes = if pause {
            #[derive(Serialize)]
            struct Ordered<'a> {
                method: &'a str,
                #[serde(flatten)]
                params: Pause,
            }
            serde_json::to_vec(&Ordered {
                method: "task.pause",
                params: serde_json::from_value(params.clone())?,
            })?
        } else {
            #[derive(Serialize)]
            struct Ordered<'a> {
                method: &'a str,
                #[serde(flatten)]
                params: Reply,
            }
            serde_json::to_vec(&Ordered {
                method: "task.question.reply",
                params: serde_json::from_value(params.clone())?,
            })?
        };
        let digest = areal_local_service::storage::digest(&bytes);
        let command = text(request, "commandId")?.to_ascii_lowercase();
        uuid::Uuid::parse_str(&command).map_err(|_| fail("INVALID_PARAMS"))?;
        self.authorize(Some(project), capability)?;
        if let Some(record) = self.command_record(project, &command)? {
            return self
                .task_original(project, &record, &params, &command, &digest)
                .await;
        }
        let mutation = Mutation {
            params,
            target,
            capability,
            method,
        };
        let result = self
            .admit_task(project, generation, request, &mutation, &command, &digest)
            .await;
        if result.is_err() {
            self.authorize(Some(project), capability)?;
            if let Some(record) = self.command_record(project, &command)? {
                return self
                    .task_original(project, &record, &mutation.params, &command, &digest)
                    .await;
            }
        }
        result
    }
    async fn task_original(
        &self,
        project: &str,
        record: &Value,
        params: &Value,
        command: &str,
        digest: &str,
    ) -> Result<Value> {
        if record["remote"]["semanticDigest"] == digest {
            return self.command_result(project, Some(record), command).await;
        }
        ensure!(gateway_owner::legacy::is_legacy(record), "COMMAND_CONFLICT");
        let mut native = params.clone();
        native["requestId"] = record["operationId"].clone();
        let id = self.project_id(project)?;
        let verified = gateway_owner::legacy::task_retry(
            &self.host,
            &self.source_id,
            &id,
            project,
            record,
            &native,
        )
        .await;
        self.authorize(
            Some(project),
            record["remote"]["capability"]
                .as_str()
                .context("COMMAND_CONFLICT")?,
        )?;
        match verified? {
            Some(record) => self.command_result(project, Some(&record), command).await,
            None => {
                let mut value = Self::command_view(Some(record), command);
                value["admissionState"] = json!("unknown");
                value["submissionUnknown"] = json!(true);
                Ok(value)
            }
        }
    }
    async fn admit_task(
        &self,
        project: &str,
        generation: &str,
        request: &Value,
        mutation: &Mutation,
        command: &str,
        digest: &str,
    ) -> Result<Value> {
        let params = &mutation.params;
        let target = &mutation.target;
        let capability = mutation.capability;
        let method = mutation.method;
        ensure!(
            request["context"]["gatewayGeneration"] == self.generation
                && request["context"]["grantRevision"] == self.grant["revision"]
                && self.project(project)?.1 == generation,
            "RESYNC_REQUIRED"
        );
        let id = self.project_id(project)?;
        let scope = self
            .host
            .schedules
            .connections
            .shared_identity(&self.host, &id)?;
        let pause = method == "areal/task/pause";
        let read_target = if pause {
            json!({"taskId":params["taskId"],"runId":params["expectedRunId"]})
        } else {
            target.clone()
        };
        let (task, item, complete, caps) =
            self.task_state(project, generation, &read_target).await?;
        self.authorize(Some(project), capability)?;
        if let Some(record) = self.command_record(project, command)? {
            return self
                .task_original(project, &record, params, command, digest)
                .await;
        }
        ensure!(
            self.host
                .schedules
                .connections
                .shared_identity(&self.host, &id)?
                == scope,
            "RESYNC_REQUIRED"
        );
        ensure!(
            caps["methods"]
                .as_array()
                .is_some_and(|methods| methods.iter().any(|item| item == method))
                && (!pause || caps["features"]["taskPauseRunGuard"] == true),
            "CORE_INCOMPATIBLE"
        );
        if pause {
            ensure!(
                task["runs"]
                    .as_array()
                    .and_then(|runs| runs.last())
                    .is_some_and(|run| run["id"] == params["expectedRunId"])
                    && task["revision"] == params["expectedRevision"]
                    && task["cancelled"] != true,
                "TARGET_CHANGED"
            );
        } else {
            let item = item.unwrap_or(Value::Null);
            let questions = item["questions"]
                .as_array()
                .filter(|questions| !questions.is_empty() && questions.len() <= 8)
                .context("REVIEW_INCOMPLETE")?;
            ensure!(
                complete && serde_json::to_vec(questions)?.len() <= 32 * 1024,
                "REVIEW_INCOMPLETE"
            );
            let run = task["runs"]
                .as_array()
                .unwrap()
                .iter()
                .find(|run| run["id"] == params["runId"])
                .unwrap();
            ensure!(
                task["cancelled"] != true
                    && item["status"] == "pending"
                    && item["expiresAt"].as_f64().is_none_or(|at| at
                        > std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs_f64())
                    && !matches!(
                        run["status"].as_str(),
                        Some("completed" | "failed" | "cancelled")
                    ),
                "TARGET_CHANGED"
            );
            let answers = params["answers"].as_object().unwrap();
            ensure!(
                answers.len() == questions.len()
                    && questions.iter().all(|q| q["id"]
                        .as_str()
                        .and_then(|id| answers.get(id))
                        .is_some_and(|answer| q["allowFreeText"] == true
                            || q["options"]
                                .as_array()
                                .is_some_and(|options| options.contains(answer)))),
                "INVALID_PARAMS"
            );
        }
        let operation = uuid::Uuid::new_v4().to_string();
        let mut native = params.clone();
        native["requestId"] = json!(operation);
        let native = if pause {
            serde_json::to_value(
                serde_json::from_value::<areal_protocol::tasks::TaskControl>(native)?,
            )?
        } else {
            serde_json::to_value(
                serde_json::from_value::<areal_protocol::tasks::ChannelReply>(native)?,
            )?
        };
        let binding = &caps["features"]["threadCreationJournal"]["binding"];
        ensure!(
            binding["identity"].is_string() && binding["journalEpoch"].is_string(),
            "CORE_INCOMPATIBLE"
        );
        let record = json!({"method":method,"operationId":operation,"params":native,"nativeDigest":native_digest(method,&native)?,"coreScope":{"serviceId":scope.0,"generation":scope.1,"connectionId":scope.2,"storeBinding":binding},"remote":{"hostId":self.host_peer,"devicePeerId":self.peer,"projectId":project,"commandId":command,"method":request["method"],"capability":capability,"admittedGrantRevision":self.grant["revision"],"semanticDigest":digest,"target":target}});
        let (revision, mut snapshot) = self.host.journal.native_snapshot(&id)?;
        ensure!(
            snapshot["pending"].as_array().unwrap().len()
                + snapshot["outcomes"].as_object().unwrap().len()
                < 4096,
            "CAPACITY_EXCEEDED"
        );
        snapshot["pending"]
            .as_array_mut()
            .unwrap()
            .push(record.clone());
        self.host.journal.native_replace(&id, revision, snapshot)?;
        let _sending = gateway_owner::push::sending(&self.host, &record);
        let response = self
            .host
            .schedules
            .connections
            .remote_request(
                &self.host, &id, &scope.0, generation, &scope.2, method, native,
            )
            .await;
        let mut settled = record.clone();
        match response {
            Ok(result) => {
                if !apply_result(&mut settled, &result) {
                    return self.command_result(project, Some(&record), command).await;
                }
            }
            Err(error) => {
                let Some(rejected) = error
                    .downcast_ref::<crate::server::schedule_connection::RpcFailure>()
                    .filter(|failure| {
                        matches!(
                            failure.0["data"]["outcome"]["kind"].as_str(),
                            Some("rejected" | "noMutation")
                        )
                    })
                else {
                    return self.command_result(project, Some(&record), command).await;
                };
                settled["admissionState"] = json!("rejected");
                settled["error"] = rejected.0.clone();
            }
        }
        let settled = self.settle_command(&id, settled)?;
        self.command_result(project, Some(&settled), command).await
    }
    pub(super) async fn task_observation(&self, project: &str, record: &Value) -> Value {
        let method = record["remote"]["method"].as_str().unwrap_or_default();
        let source = if method == "task.pause" {
            "task.read"
        } else {
            "task.question.read"
        };
        let observed: Result<Value> = async {
            let (_, generation) = self.project(project)?;
            let mut target = record["remote"]["target"].clone();
            if method == "task.pause" {
                target = json!({"taskId":target["taskId"],"runId":target["expectedRunId"]});
            }
            let mut read = self
                .task_read(project, &generation, &target, method != "task.pause")
                .await?;
            read["source"] = json!(source);
            read["provesCommandAdmission"] = json!(false);
            Ok(read)
        }
        .await;
        observed.unwrap_or_else(
            |_| json!({"source":source,"status":"unavailable","provesCommandAdmission":false}),
        )
    }
}
