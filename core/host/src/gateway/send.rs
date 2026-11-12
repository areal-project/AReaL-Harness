use super::*;
use serde::Deserialize;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Message {
    thread_id: String,
    expected_config_revision: u64,
    text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    enqueue: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expected_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    attachments: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    conversation_quotes: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mcp_content: Option<Value>,
}
#[derive(Serialize)]
struct Semantic<'a> {
    method: &'a str,
    #[serde(flatten)]
    params: &'a Message,
}
impl Session {
    pub(super) async fn send_session(
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
        ensure!(
            request["params"]
                .get("enqueue")
                .is_none_or(Value::is_boolean)
                && request["params"]
                    .get("expectedTurnId")
                    .is_none_or(Value::is_string),
            "INVALID_PARAMS"
        );
        let mut params: Message =
            serde_json::from_value(request["params"].clone()).context("INVALID_PARAMS")?;
        ensure!(
            !params.thread_id.is_empty()
                && params.thread_id.len() <= 128
                && params.expected_config_revision <= 9_007_199_254_740_991
                && (self.gui_write
                    || (params.attachments.is_none()
                        && params.conversation_quotes.is_none()
                        && params.mcp_content.is_none()
                        && !params.text.trim().is_empty()))
                && params.text.len() <= 64 * 1024
                && params
                    .expected_turn_id
                    .as_ref()
                    .is_none_or(|id| id.len() <= 128),
            "INVALID_PARAMS"
        );
        params.expected_turn_id = params.expected_turn_id.filter(|id| !id.is_empty());
        // 与桌面 Main 的 messageInput 同一套组装与上限；提前算出，非法输入不进 journal。
        message_input(&params).context("INVALID_PARAMS")?;
        let command = text(request, "commandId")?.to_ascii_lowercase();
        ensure!(command.len() == 36, "INVALID_PARAMS");
        uuid::Uuid::parse_str(&command).map_err(|_| fail("INVALID_PARAMS"))?;
        let digest = areal_local_service::storage::digest(&serde_json::to_vec(&Semantic {
            method: "session.send",
            params: &params,
        })?);
        self.authorize(Some(project), "submit")?;
        if let Some(record) = self.command_record(project, &command)? {
            ensure!(
                record["remote"]["semanticDigest"] == digest,
                "COMMAND_CONFLICT"
            );
            return self.command_result(project, Some(&record), &command).await;
        }
        let result = self
            .admit_send(project, generation, request, &params, &command, &digest)
            .await;
        if result.is_err() {
            self.authorize(Some(project), "submit")?;
            if let Some(record) = self.command_record(project, &command)? {
                ensure!(
                    record["remote"]["semanticDigest"] == digest,
                    "COMMAND_CONFLICT"
                );
                return self.command_result(project, Some(&record), &command).await;
            }
        }
        result
    }
    async fn admit_send(
        &self,
        project: &str,
        generation: &str,
        request: &Value,
        params: &Message,
        command: &str,
        digest: &str,
    ) -> Result<Value> {
        ensure!(
            request["context"]["gatewayGeneration"] == self.generation
                && request["context"]["grantRevision"] == self.grant["revision"]
                && request["context"]["serviceGeneration"] == generation,
            "RESYNC_REQUIRED"
        );
        let (id, _) = self.project(project)?;
        let scope = self
            .host
            .schedules
            .connections
            .shared_identity(&self.host, &id)?;
        let caps = self
            .rpc(project, generation, "areal/capabilities", json!({}))
            .await?;
        // 受理前只观察一次：既用来替没指定的客户端选择“立即发/排队”，也用于下面的前置检查。
        // Core 的 admissionGuard 在锁内再校验一遍，这里看到的状态过期也不会误受理。
        let (observed, _, _observation) = self
            .host
            .schedules
            .connections
            .remote_observe(&self.host, &id, generation, &params.thread_id)
            .await?;
        let state = projection::snapshot(
            &observed["thread"],
            &observed["ownership"],
            &[
                project.to_owned(),
                scope.0.clone(),
                scope.1.clone(),
                params.thread_id.clone(),
            ],
            &caps["features"],
        )?;
        let (enqueue, expected_turn) = match params.enqueue {
            Some(enqueue) => (enqueue, params.expected_turn_id.clone()),
            // 客户端不指定时由 Host 决定：有进行中的轮次就排到它后面，否则立即发。
            None => {
                let turn = state["activeTurnId"].as_str().map(str::to_owned);
                (turn.is_some(), turn)
            }
        };
        let method = if enqueue {
            "areal/turn/enqueue"
        } else {
            "areal/turn/start"
        };
        ensure!(
            caps["features"][if enqueue {
                "turnEnqueueAdmissionGuard"
            } else {
                "turnStartAdmissionGuard"
            }] == true
                && caps["features"]["atomicObserveOwnership"] == true
                && caps["features"]["threadCreationJournal"]["binding"].is_object()
                && caps["methods"]
                    .as_array()
                    .is_some_and(|methods| [method, "areal/request/read"]
                        .iter()
                        .all(|required| methods.iter().any(|method| method == required))),
            "CORE_INCOMPATIBLE"
        );
        let mut effective = params.clone();
        if self.uses_workbench_execution() {
            effective.text = self
                .host
                .gateway
                .workbench
                .prepare_input(&self.host, &id, &params.thread_id, &params.text)
                .await?;
        }
        let operation = uuid::Uuid::new_v4().to_string();
        let mut guard =
            json!({"ordinarySession":true,"configRevision":params.expected_config_revision});
        if enqueue {
            guard["expectedTurnId"] = json!(expected_turn);
        }
        let native: areal_protocol::desktop::TurnStart = serde_json::from_value(
            json!({"requestId":operation,"threadId":params.thread_id,"input":message_input(&effective)?,"expectedConfigRevision":params.expected_config_revision,"admissionGuard":guard}),
        )?;
        let native = serde_json::to_value(native)?;
        let mut execution = if self.uses_workbench_execution() {
            self.host
                .gateway
                .workbench
                .prepare_execution(&self.host, &self.connection, &id, method, native.clone())
                .await?
        } else {
            None
        };
        if let Some(prepared) = &execution {
            ensure!(prepared.params == native, "INVALID_RESPONSE");
        }
        self.authorize(Some(project), "submit")?;
        if let Some(record) = self.command_record(project, command)? {
            ensure!(
                record["remote"]["semanticDigest"] == digest,
                "COMMAND_CONFLICT"
            );
            return self.command_result(project, Some(&record), command).await;
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
            state["ownership"]["kind"] == "ordinary",
            "TASK_CONTROL_REQUIRED"
        );
        if enqueue {
            ensure!(
                state["activeTurnId"]
                    .as_str()
                    .is_some_and(|turn| Some(turn) == expected_turn.as_deref()),
                "TARGET_CHANGED"
            );
        } else {
            ensure!(
                state["activeTurnId"].is_null() && state["status"] == "idle",
                "TURN_BUSY"
            );
            ensure!(state["queue"]["pendingCount"] == 0, "TARGET_CHANGED");
        }
        ensure!(
            state["configRevision"] == params.expected_config_revision,
            "TARGET_CHANGED"
        );
        let native: areal_protocol::desktop::TurnStart = serde_json::from_value(native.clone())?;
        let native_digest = areal_local_service::storage::digest(&serde_json::to_vec(&native)?);
        let native = serde_json::to_value(native)?;
        let record = json!({"method":method,"operationId":operation,"params":native,"nativeDigest":native_digest,"coreScope":{"serviceId":scope.0,"generation":scope.1,"connectionId":scope.2,"storeBinding":caps["features"]["threadCreationJournal"]["binding"]},"threadId":params.thread_id,"remote":{"hostId":self.host_peer,"devicePeerId":self.peer,"projectId":project,"commandId":command,"method":"session.send","capability":"submit","admittedGrantRevision":self.grant["revision"],"semanticDigest":digest,"target":{"threadId":params.thread_id,"expectedConfigRevision":params.expected_config_revision}}});
        ensure!(
            serde_json::to_vec(&record)?.len() <= self.command_pending_bytes(),
            "LIMIT_EXCEEDED"
        );
        self.host.journal.native_preflight(&id, &record, true)?;
        self.host
            .schedules
            .connections
            .workbench_core_admit(&self.host, &id, None, method, &record["params"])
            .await?;
        let (revision, snapshot) = self.host.journal.native_snapshot(&id)?;
        self.authorize(Some(project), "submit")?;
        self.host
            .journal
            .native_admit(&id, revision, snapshot, record.clone(), true)?;
        let _sending = gateway_owner::push::sending(&self.host, &record);
        let response = if let Some(prepared) = &mut execution {
            prepared.dispatch().await
        } else {
            self.host
                .schedules
                .connections
                .remote_request(
                    &self.host,
                    &id,
                    (&scope.0, generation, &scope.2),
                    method,
                    native,
                )
                .await
        };
        let mut settled = record.clone();
        match response {
            Ok(result) => {
                if !Self::submission_receipt(&mut settled, &result) {
                    self.authorize(Some(project), "submit")?;
                    return Ok(Self::command_view(Some(&record), command));
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
                    self.authorize(Some(project), "submit")?;
                    return Ok(Self::command_view(Some(&record), command));
                };
                settled["admissionState"] = json!("rejected");
                settled["error"] = if rejected.0["code"] == -32602
                    && rejected.0["message"]
                        .as_str()
                        .is_some_and(|message| message.contains("UNSUPPORTED_PROFILE:"))
                {
                    json!({"code":"UNSUPPORTED_PROFILE","coreCode":-32602})
                } else {
                    rejected.0.clone()
                };
            }
        }
        let settled = self.settle_command(&id, settled)?;
        gateway_owner::push::track(&self.host, &id, project, &settled, false);
        self.authorize(Some(project), "submit")?;
        Ok(Self::command_view(Some(&settled), command))
    }
    pub(super) fn submission_receipt(record: &mut Value, result: &Value) -> bool {
        if matches!(
            record["remote"]["method"].as_str(),
            Some("task.pause" | "task.question.reply")
        ) {
            return tasks::apply_result(record, result);
        } else if record["remote"]["method"] == "session.control" {
            return controls::apply_result(record, result);
        } else if record["method"] == "areal/turn/enqueue" {
            let Some(queue) = result["queueItemId"]
                .as_str()
                .filter(|id| !id.is_empty() && id.len() <= 128)
            else {
                return false;
            };
            record["receipt"] = json!({"queueItemId":queue});
        } else {
            let Some(turn) = result["turn"]["id"]
                .as_str()
                .filter(|id| !id.is_empty() && id.len() <= 128)
            else {
                return false;
            };
            record["turnId"] = json!(turn);
        }
        record["admissionState"] = json!("accepted");
        true
    }
    pub(super) async fn reconcile_submission(
        &self,
        project: &str,
        record: &Value,
    ) -> Result<Value> {
        if record.get("admissionState").is_some() || record["method"] == "turn/steer" {
            return Ok(record.clone());
        }
        self.authorize(
            Some(project),
            record["remote"]["capability"].as_str().unwrap_or("submit"),
        )?;
        let id = self.project_id(project)?;
        let Ok(scope) = self
            .host
            .schedules
            .connections
            .shared_identity(&self.host, &id)
        else {
            return Ok(record.clone());
        };
        if record["coreScope"]["serviceId"] != scope.0 {
            return Ok(record.clone());
        }
        let result: Result<Value> = async {
            let caps = self
                .rpc(project, &scope.1, "areal/capabilities", json!({}))
                .await?;
            let binding = &caps["features"]["threadCreationJournal"]["binding"];
            let original = &record["coreScope"]["storeBinding"];
            ensure!(
                original["identity"].is_string()
                    && original["journalEpoch"].is_string()
                    && binding["identity"] == original["identity"]
                    && binding["journalEpoch"] == original["journalEpoch"],
                "RESYNC_REQUIRED"
            );
            let task = record["params"].get("taskId");
            let thread = record["params"].get("threadId");
            let target = if let Some(task) = task {
                json!({"kind":"task","taskId":task})
            } else {
                json!({"kind":"thread","threadId":thread.context("RESOURCE_UNAVAILABLE")?})
            };
            let operation = record["params"]["requestId"]
                .as_str()
                .context("RESOURCE_UNAVAILABLE")?;
            let read = self
                .rpc(
                    project,
                    &scope.1,
                    "areal/request/read",
                    if task.is_some() {
                        json!({"requestId":operation})
                    } else {
                        json!({"threadId":thread,"requestId":operation})
                    },
                )
                .await?;
            ensure!(
                self.host
                    .schedules
                    .connections
                    .shared_identity(&self.host, &id)?
                    == scope,
                "RESYNC_REQUIRED"
            );
            let expected = areal_protocol::submissions::ExpectedSubmission {
                method: record["method"]
                    .as_str()
                    .context("RESOURCE_UNAVAILABLE")?
                    .into(),
                params: record["params"].clone(),
                operation: Some(
                    json!({"requestId":operation,"method":record["method"],"target":target}),
                ),
                digest: Some(
                    record["nativeDigest"]
                        .as_str()
                        .context("RESOURCE_UNAVAILABLE")?
                        .into(),
                ),
                identity: Some(
                    original["identity"]
                        .as_str()
                        .context("RESOURCE_UNAVAILABLE")?
                        .into(),
                ),
                strict: true,
            };
            let receipt = areal_protocol::submissions::reconcile(
                &expected,
                &read,
                &Value::Null,
                thread.and_then(Value::as_str),
            )
            .context("RESOURCE_UNAVAILABLE")?;
            ensure!(receipt["status"] == "completed", "RESOURCE_UNAVAILABLE");
            Ok(receipt["result"].clone())
        }
        .await;
        self.authorize(
            Some(project),
            record["remote"]["capability"].as_str().unwrap_or("submit"),
        )?;
        let Ok(result) = result else {
            return Ok(record.clone());
        };
        let mut settled = record.clone();
        if !Self::submission_receipt(&mut settled, &result) {
            return Ok(record.clone());
        }
        let settled = self.settle_command(&id, settled)?;
        if record["remote"]["method"] == "session.send" {
            gateway_owner::push::track(&self.host, &id, project, &settled, true);
        }
        Ok(settled)
    }
}

fn blob_url(value: &Value) -> Option<&str> {
    value.as_str().filter(|url| {
        url.strip_prefix("areal://blob/").is_some_and(|id| {
            !id.is_empty()
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
    })
}

/// 桌面 `media.cjs` messageInput 的移植：正文、引用、附件与 MCP 内容按同一顺序与上限组装。
/// 已发布客户端只会带正文，结果与原来的单个文本项相同。
pub(super) fn rich_message_input(text: &str, values: &Value) -> Result<Vec<areal_protocol::Input>> {
    message_input(&Message {
        thread_id: String::new(),
        expected_config_revision: 0,
        text: text.to_owned(),
        enqueue: None,
        expected_turn_id: None,
        attachments: values.get("attachments").cloned(),
        conversation_quotes: values.get("conversationQuotes").cloned(),
        mcp_content: values.get("mcpContent").cloned(),
    })
}
fn message_input(params: &Message) -> Result<Vec<areal_protocol::Input>> {
    use areal_protocol::Input;
    let mut input = Vec::new();
    if !params.text.trim().is_empty() {
        input.push(Input::text(params.text.clone()));
    }
    let quotes = match &params.conversation_quotes {
        None => Vec::new(),
        Some(value) => value.as_array().context("quotes")?.clone(),
    };
    let units = |text: &str| text.encode_utf16().count();
    ensure!(
        quotes.len() <= 8
            && quotes.iter().all(|quote| {
                exact(quote, &["text"])
                    && quote["text"]
                        .as_str()
                        .is_some_and(|text| !text.trim().is_empty() && units(text) <= 8000)
            })
            && quotes
                .iter()
                .map(|quote| units(quote["text"].as_str().unwrap_or_default()))
                .sum::<usize>()
                <= 16000,
        "quotes"
    );
    if !quotes.is_empty() {
        let values: Vec<Value> = quotes
            .iter()
            .map(|quote| json!({"text":quote["text"]}))
            .collect();
        input.push(Input::text(format!(
            "# userselect:\n```userselect\n{}\n```",
            serde_json::to_string(&values)?
        )));
    }
    let media = match &params.attachments {
        None => Vec::new(),
        Some(value) => value.as_array().context("attachments")?.clone(),
    };
    ensure!(media.len() <= 16, "attachments");
    for item in &media {
        let kind = item["type"].as_str().unwrap_or_default();
        let url = blob_url(&item["url"]).context("attachment")?;
        ensure!(
            item.as_object().is_some_and(|object| object
                .keys()
                .all(|key| matches!(key.as_str(), "type" | "url" | "name" | "mimeType" | "_meta"))),
            "attachment"
        );
        input.push(match kind {
            "image" => Input::Image {
                url: url.into(),
                detail: None,
            },
            "audio" => Input::Audio { url: url.into() },
            "file" => Input::File {
                url: url.into(),
                name: Some(
                    item["name"]
                        .as_str()
                        .unwrap_or_default()
                        .chars()
                        .take(255)
                        .collect(),
                ),
                mime_type: item["mimeType"].as_str().map(str::to_owned),
            },
            _ => anyhow::bail!("attachment"),
        });
    }
    let mut blocks = match &params.mcp_content {
        None => Vec::new(),
        Some(value) => value.as_array().context("mcpContent")?.clone(),
    };
    for item in &media {
        if let Some(meta) = item.get("_meta") {
            let mut link = json!({"type":"resource_link","uri":item["url"],"name":item["name"].as_str().or(item["type"].as_str()).unwrap_or_default().chars().take(255).collect::<String>(),"_meta":meta});
            if let Some(mime) = item["mimeType"].as_str() {
                link["mimeType"] = json!(mime);
            }
            blocks.push(link);
        }
    }
    ensure!(blocks.len() <= 32, "mcpContent");
    let mut total = 0;
    for block in blocks {
        total += serde_json::to_vec(&block)?.len();
        input.push(Input::mcp_text(block).map_err(|error| anyhow::anyhow!(error))?);
    }
    ensure!(total <= MCP_CONTENT_BYTES, "mcpContent");
    ensure!(!input.is_empty(), "empty");
    Ok(input)
}
/// 桌面每块 64 KiB、最多 32 块；经 Host 时整条命令要放进 1 MiB 帧，所以总量另设上限。
pub(crate) const MCP_CONTENT_BYTES: usize = 512 * 1024;

pub(crate) fn write_limits() -> Value {
    json!({"commandTextBytes":64 * 1024,"commandPendingBytes":super::GUI_WRITE_PENDING_BYTES,"attachments":16,"quotes":8,"quoteUnits":16000,"mcpBlocks":32,"mcpBlockBytes":64 * 1024,"mcpContentBytes":MCP_CONTENT_BYTES,"uploadChunkBytes":super::uploads::CHUNK_BYTES,"uploadBytes":crate::server::conversation_media::MAX_BYTES})
}
