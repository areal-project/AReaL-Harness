//! 管理写入复用持久受理日志；崩溃后的 pending 是 UNKNOWN，禁止自动执行重试。
use super::*;
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Submission {
    identity: String,
    request_id: String,
    method: String,
    digest: String,
    state: String,
    response: Option<Value>,
    #[serde(default)]
    target: Option<OperationTarget>,
}
impl Submission {
    fn response(&self, hash: &str, operation: OperationRef) -> Result<Value> {
        if self.digest != hash {
            return Err(Error::Rejected(Box::new(Error::Conflict)));
        }
        self.response.clone().ok_or_else(|| {
            let admitted = self.state != "unconfirmed";
            outcome_error(
                operation,
                admitted,
                if admitted {
                    "COMPLETION_UNCONFIRMED"
                } else {
                    "ADMISSION_UNCONFIRMED"
                },
            )
        })
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    version: u32,
    epoch: String,
    entries: BTreeMap<String, Submission>,
}

pub(super) struct Submissions {
    gate: Mutex<BTreeMap<String, std::sync::Weak<Mutex<()>>>>,
    entries: Mutex<Journal>,
    instance_id: String,
    #[cfg(test)]
    crash_point: std::sync::Mutex<Option<String>>,
}
impl Submissions {
    #[cfg(test)]
    pub(super) fn creation_checkpoint(&self, point: &str) {
        if self.crash_point.lock().unwrap().as_deref() == Some(point) {
            // 只供隔离子进程测试，在真实持久化边界模拟不执行清理的进程丢失。
            #[cfg(unix)]
            unsafe {
                libc::raise(libc::SIGKILL);
            }
            std::process::exit(86);
        }
    }
    pub fn open(root: &Path) -> anyhow::Result<Self> {
        let path = root.join("desktop/submissions.json");
        let mut journal = if path.exists() {
            anyhow::ensure!(
                std::fs::metadata(&path)?.len() <= 8 * 1024 * 1024,
                "submission journal exceeds 8 MiB"
            );
            #[derive(Deserialize)]
            #[serde(untagged)]
            enum Stored {
                Current(Journal),
                Legacy(BTreeMap<String, Submission>),
            }
            match serde_json::from_slice(&std::fs::read(&path)?)? {
                Stored::Current(journal) => journal,
                Stored::Legacy(entries) => Journal {
                    version: 1,
                    epoch: uuid::Uuid::new_v4().to_string(),
                    entries,
                },
            }
        } else {
            Journal {
                version: 1,
                epoch: uuid::Uuid::new_v4().to_string(),
                entries: BTreeMap::new(),
            }
        };
        anyhow::ensure!(
            journal.version == 1 && uuid::Uuid::parse_str(&journal.epoch).is_ok(),
            "unsupported submission journal format"
        );
        for record in journal.entries.values_mut() {
            if record.state == "accepted" {
                record.state = "unknown".into();
            }
        }
        // 发布能力前持久化覆盖标识；日志丢失后只能生成新标识，旧请求仍为 UNKNOWN。
        let bytes = serde_json::to_vec(&journal)?;
        anyhow::ensure!(
            bytes.len() <= 8 * 1024 * 1024,
            "submission journal migration exceeds 8 MiB"
        );
        crate::store::write_metadata(&root.join("desktop"), "submissions", &bytes)?;
        Ok(Self {
            gate: Mutex::new(BTreeMap::new()),
            entries: Mutex::new(journal),
            instance_id: uuid::Uuid::new_v4().to_string(),
            #[cfg(test)]
            crash_point: Default::default(),
        })
    }
}
impl Engine {
    pub const MANAGEMENT_RECEIPT_MAX_BYTES: usize = 256 * 1024;

    pub async fn management_submission_result(
        &self,
        identity: &str,
        request_id: &str,
        method: &str,
        parameters: &Value,
    ) -> Result<Option<Value>> {
        if !valid_id(request_id) {
            return Err(Error::Rejected(Box::new(invalid("invalid requestId"))));
        }
        let key = digest(&(identity, method, request_id))?;
        let entries = self.desktop.submissions.entries.lock().await;
        entries
            .entries
            .get(&key)
            .map(|record| {
                record.response(
                    &digest(parameters)?,
                    submission_operation(request_id, method, parameters),
                )
            })
            .transpose()
    }

    pub async fn management_submission<F, Fut>(
        self: &Arc<Self>,
        identity: String,
        request_id: String,
        method: String,
        parameters: Value,
        run: F,
    ) -> Result<Value>
    where
        F: FnOnce(Arc<Engine>) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Value> + Send + 'static,
    {
        self.mutate(move |engine| async move {
            if !valid_id(&request_id) {
                return Err(Error::Rejected(Box::new(invalid("invalid requestId"))));
            }
            let key = digest(&(&identity, &method, &request_id))?;
            let hash = digest(&parameters)?;
            let serial = {
                let mut gates = engine.desktop.submissions.gate.lock().await;
                gates.retain(|_, gate| gate.strong_count() > 0);
                if let Some(gate) = gates.get(&key).and_then(std::sync::Weak::upgrade) {
                    gate
                } else {
                    let gate = Arc::new(Mutex::new(()));
                    gates.insert(key.clone(), Arc::downgrade(&gate));
                    gate
                }
            };
            let _request = serial.lock().await;
            let mut entries = engine.desktop.submissions.entries.lock().await;
            let operation = submission_operation(&request_id, &method, &parameters);
            if let Some(record) = entries.entries.get(&key) {
                return record.response(&hash, operation);
            }
            engine.reserve_submission(&mut entries, Submission {
                identity, request_id, method, digest: hash, state: "accepted".into(), response: None,
                target: Some(operation.target.clone()),
            }, operation.clone()).await?;
            drop(entries);
            let mut result = run(engine.clone()).await;
            let mut entries = engine.desktop.submissions.entries.lock().await;
            if serde_json::to_vec(&result).map_err(invalid)?.len() > Self::MANAGEMENT_RECEIPT_MAX_BYTES {
                result = json!({"error":{"code":-32005,
                    "message":"mutation completed; response exceeds receipt budget; inspect authoritative state",
                    "data":{"reason":"RESPONSE_TOO_LARGE"}}});
            }
            // 队列引导的拒绝也要记账，防止同一请求再次运行 UserPromptSubmit hook。
            let rejected_steer = operation.method == "areal/queue/steer"
                && result.pointer("/error/data/outcome/kind").and_then(Value::as_str) == Some("rejected");
            if !rejected_steer && let Some(error) = result.get_mut("error").and_then(Value::as_object_mut) {
                let reason = error.get("data").and_then(|data| data.get("reason"))
                    .and_then(Value::as_str).filter(|value| valid_id(value))
                    .unwrap_or("OPERATION_FAILED").to_owned();
                error.insert("data".into(), json!(OperationFailure {
                    reason, outcome: FailureOutcome::Admitted { operation: operation.clone() }, recovery: Recovery::QueryOriginal,
                }));
            }
            let record = entries.entries.get_mut(&key).unwrap();
            record.state = "completed".into();
            record.response = Some(result.clone());
            if engine.store.save_metadata("submissions", &*entries).await.is_err() {
                let record = entries.entries.get_mut(&key).unwrap();
                record.state = "unknown".into();
                record.response = None;
                return Err(outcome_error(operation, true, "COMPLETION_UNCONFIRMED"));
            }
            Ok(result)
        }).await
    }
    async fn reserve_submission(
        &self,
        journal: &mut Journal,
        record: Submission,
        operation: OperationRef,
    ) -> Result<()> {
        if journal.entries.len() >= 4096 {
            return Err(Error::Rejected(Box::new(Error::Exhausted(
                "submission journal capacity reached; keys are retained for deployment lifetime"
                    .into(),
            ))));
        }
        let key = digest(&(&record.identity, &record.method, &record.request_id))?;
        journal.entries.insert(key.clone(), record);
        let reserved = journal
            .entries
            .values()
            .filter(|r| r.state == "accepted")
            .count()
            .saturating_mul(Self::MANAGEMENT_RECEIPT_MAX_BYTES + 512);
        if serde_json::to_vec(journal)
            .map_err(invalid)?
            .len()
            .saturating_add(reserved)
            > 8 * 1024 * 1024
        {
            journal.entries.remove(&key);
            return Err(Error::Rejected(Box::new(Error::Exhausted(
                "submission journal cannot reserve this response".into(),
            ))));
        }
        if self
            .store
            .save_metadata("submissions", journal)
            .await
            .is_err()
        {
            // 替换已完成而目录同步失败时，发布事实仍不确定；禁止在本代再次执行。
            journal.entries.get_mut(&key).unwrap().state = "unconfirmed".into();
            return Err(outcome_error(operation, false, "ADMISSION_UNCONFIRMED"));
        }
        Ok(())
    }

    pub async fn creation_admission(&self, identity: &str) -> CreationAdmission {
        CreationAdmission {
            identity: identity.into(),
            journal_epoch: self.desktop.submissions.entries.lock().await.epoch.clone(),
            core_instance_id: self.desktop.submissions.instance_id.clone(),
        }
    }

    pub(super) async fn creation_result(
        &self,
        identity: &str,
        request_id: &str,
        hash: &str,
    ) -> Result<Option<String>> {
        let key = digest(&(identity, "areal/thread/start", request_id))?;
        let journal = self.desktop.submissions.entries.lock().await;
        journal
            .entries
            .get(&key)
            .map(|record| {
                let response = record.response(
                    hash,
                    submission_operation(request_id, "areal/thread/start", &json!({})),
                )?;
                response["result"]["threadId"]
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| invalid("invalid creation receipt"))
            })
            .transpose()
    }

    pub(super) async fn begin_creation(
        &self,
        identity: &str,
        request: &ThreadStart,
        hash: String,
    ) -> Result<()> {
        let operation = submission_operation(&request.request_id, "areal/thread/start", &json!({}));
        let mut journal = self.desktop.submissions.entries.lock().await;
        self.reserve_submission(
            &mut journal,
            Submission {
                identity: identity.into(),
                request_id: request.request_id.clone(),
                method: "areal/thread/start".into(),
                digest: hash,
                state: "accepted".into(),
                response: None,
                target: Some(OperationTarget::Project),
            },
            operation,
        )
        .await
    }

    pub(super) fn creation_unconfirmed(&self, request_id: &str) -> Error {
        outcome_error(
            submission_operation(request_id, "areal/thread/start", &json!({})),
            true,
            "COMPLETION_UNCONFIRMED",
        )
    }

    pub(super) async fn complete_creation(
        &self,
        identity: &str,
        request_id: &str,
        thread_id: &str,
    ) -> Result<()> {
        let key = digest(&(identity, "areal/thread/start", request_id))?;
        let operation = submission_operation(
            request_id,
            "areal/thread/start",
            &json!({"threadId":thread_id}),
        );
        let mut journal = self.desktop.submissions.entries.lock().await;
        let record = journal.entries.get_mut(&key).unwrap();
        record.state = "completed".into();
        record.target = Some(operation.target.clone());
        record.response = Some(json!({"result":{"threadId":thread_id}}));
        if self
            .store
            .save_metadata("submissions", &*journal)
            .await
            .is_err()
        {
            let record = journal.entries.get_mut(&key).unwrap();
            record.state = "unknown".into();
            record.response = None;
            return Err(outcome_error(operation, true, "COMPLETION_UNCONFIRMED"));
        }
        Ok(())
    }

    pub async fn resolve_creation_admission(
        &self,
        identity: &str,
        request_id: &str,
        original: CreationAdmission,
    ) -> Result<Value> {
        if !valid_id(request_id)
            || uuid::Uuid::parse_str(&original.journal_epoch).is_err()
            || uuid::Uuid::parse_str(&original.core_instance_id).is_err()
        {
            return Err(invalid("invalid creation admission lookup"));
        }
        let mut result = self.find_request(identity, request_id).await?;
        let journal = self.desktop.submissions.entries.lock().await;
        let admitted =
            journal
                .entries
                .contains_key(&digest(&(identity, "areal/thread/start", request_id))?)
                || result["data"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| r["method"] == "areal/thread/start");
        // 只对已退役的原代际给负结论：迟到的绑定请求在新代际会被拒绝。
        // 同代际可能仍有排队请求，覆盖不一致也无法证明日志连续，均保持 UNKNOWN。
        let uncertain = journal
            .entries
            .get(&digest(&(identity, "areal/thread/start", request_id))?)
            .is_some_and(|entry| entry.state == "unconfirmed");
        let status = if original.identity != identity || uncertain {
            "unconfirmed"
        } else if admitted {
            "admitted"
        } else if original.journal_epoch == journal.epoch
            && original.core_instance_id != self.desktop.submissions.instance_id
        {
            "notAdmitted"
        } else {
            "unconfirmed"
        };
        result["creationAdmission"] = json!({"status":status,"identity":original.identity,"requestId":request_id,
            "method":"areal/thread/start","journalEpoch":original.journal_epoch,"coreInstanceId":original.core_instance_id});
        Ok(result)
    }

    pub async fn management_receipts(&self, identity: &str, request_id: &str) -> Value {
        let entries = self.desktop.submissions.entries.lock().await;
        let records: Vec<Value> = entries
            .entries
            .values()
            .filter(|r| r.identity == identity && r.request_id == request_id)
            .map(|r| {
                let mut value = json!(r);
                let operation = OperationRef {
                    request_id: r.request_id.clone(),
                    method: r.method.clone(),
                    target: r.target.clone().unwrap_or(OperationTarget::Project),
                };
                value["operation"] = json!(operation);
                value["status"] = json!(if r.state == "unconfirmed" {
                    "unconfirmed"
                } else if r
                    .response
                    .as_ref()
                    .is_some_and(|reply| reply.get("error").is_some())
                {
                    "failed"
                } else if r.response.is_some() {
                    "completed"
                } else {
                    "admitted"
                });
                if let Some(response) = &r.response {
                    if let Some(result) = response.get("result") {
                        value["result"] = result.clone();
                    }
                    if let Some(error) = response.get("error") {
                        value["error"] = error.clone();
                    }
                }
                if let OperationTarget::Thread { thread_id } = operation.target {
                    value["threadId"] = json!(thread_id);
                }
                value
            })
            .collect();
        json!({"data":records,"retention":"deploymentLifetime","capacity":4096})
    }
}

fn submission_operation(request_id: &str, method: &str, parameters: &Value) -> OperationRef {
    OperationRef {
        request_id: request_id.into(),
        method: method.into(),
        target: parameters
            .get("taskId")
            .and_then(Value::as_str)
            .filter(|id| valid_id(id))
            .map(|id| OperationTarget::Task { task_id: id.into() })
            .or_else(|| {
                parameters
                    .get("threadId")
                    .and_then(Value::as_str)
                    .filter(|id| valid_id(id))
                    .map(|id| OperationTarget::Thread {
                        thread_id: id.into(),
                    })
            })
            .unwrap_or(OperationTarget::Project),
    }
}

fn outcome_error(operation: OperationRef, admitted: bool, reason: &str) -> Error {
    Error::OperationOutcome(Box::new(OperationFailure {
        reason: reason.into(),
        outcome: if admitted {
            FailureOutcome::Admitted { operation }
        } else {
            FailureOutcome::Unconfirmed { operation }
        },
        recovery: Recovery::QueryOriginal,
    }))
}

#[cfg(test)]
mod tests;
