use super::*;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::Instant,
};

pub(super) struct Audit {
    path: Option<PathBuf>,
    lease: Option<std::fs::File>,
    pub value: Value,
    started: Instant,
}
impl Audit {
    pub fn new(directory: Option<&Path>, body: &Value, purpose: RequestPurpose) -> Self {
        let fields = [
            "model",
            "temperature",
            "top_p",
            "top_k",
            "min_p",
            "presence_penalty",
            "repetition_penalty",
            "reasoning_effort",
            "reasoning",
            "max_completion_tokens",
            "max_output_tokens",
            "tool_choice",
            "parallel_tool_calls",
        ];
        let parameters: serde_json::Map<_, _> = fields
            .iter()
            .filter_map(|key| body.get(*key).map(|v| ((*key).to_owned(), v.clone())))
            .collect();
        let request_id = uuid::Uuid::new_v4().to_string();
        let bytes = serde_json::to_vec(body).unwrap_or_default();
        let mut value = json!({"requestId":request_id,"purpose":format!("{purpose:?}"),"parameters":parameters,
            "bodySha256":format!("{:x}",Sha256::digest(&bytes)),"bodyBytes":bytes.len(),
            "toolCount":body["tools"].as_array().map_or(0,Vec::len),"outcome":"pending",
            "httpAttempts":0,"usage":ModelUsage::default(),"usageObserved":false});
        value["startedAtUnixMs"] = json!(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64
        );
        value["protocol"] = json!(if body.get("input").is_some() {
            "responses"
        } else {
            "chat-completions"
        });
        value["systemMessageCount"] = json!(
            body.get("messages")
                .or_else(|| body.get("input"))
                .and_then(Value::as_array)
                .map(|messages| messages.iter().filter(|m| m["role"] == "system").count())
        );
        // 只保存块摘要，离线比较相邻请求的稳定前缀；不持久化提示词正文。
        value["messageBlocks"] = json!(body.get("messages").or_else(|| body.get("input"))
            .and_then(Value::as_array).into_iter().flatten().map(|message| {
                let encoded = message.to_string();
                json!({"sha256":format!("{:x}",Sha256::digest(encoded.as_bytes())),"bytes":encoded.len()})
            }).collect::<Vec<_>>());
        value["toolSchemaSha256"] = json!(format!(
            "{:x}",
            Sha256::digest(body["tools"].to_string().as_bytes())
        ));
        value["instructionsSha256"] = json!(format!(
            "{:x}",
            Sha256::digest(body["instructions"].to_string().as_bytes())
        ));
        value["promptCacheKeySha256"] = body
            .get("prompt_cache_key")
            .and_then(Value::as_str)
            .map(|key| json!(format!("{:x}", Sha256::digest(key.as_bytes()))))
            .unwrap_or(Value::Null);
        if let Ok((thread, turn)) = REQUEST_OWNER.try_with(Clone::clone) {
            value["threadId"] = json!(thread);
            value["turnId"] = json!(turn);
        }
        let lease = directory.and_then(|directory| {
            let result = (|| {
                let gate = crate::diagnostics::lock(directory)?;
                crate::diagnostics::sweep_model(directory, &gate, false)?;
                crate::diagnostics::lease(directory, &request_id)
            })();
            match result {
                Ok(lease) => Some(lease),
                Err(_) => {
                    tracing::warn!("could not initialize model request audit");
                    None
                }
            }
        });
        let audit = Self {
            path: directory
                .filter(|_| lease.is_some())
                .map(|d| d.join(format!("{request_id}.json"))),
            lease,
            value,
            started: Instant::now(),
        };
        audit.save();
        audit
    }
    pub fn mark_first(&mut self, field: &str) {
        if self.value.get(field).is_none() {
            self.value[field] = json!(self.started.elapsed().as_millis() as u64);
        }
    }
    pub fn save_error_detail(&mut self, detail: &Value) {
        let Some(path) = &self.path else { return };
        let path = path
            .parent()
            .unwrap()
            .join("errors")
            .join(path.file_name().unwrap());
        // tempfile 默认 0600；原文不进入 JSONL、TurnOutcome 或遥测，只写独立私有制品。
        let result = (|| -> std::io::Result<()> {
            let _gate = crate::diagnostics::lock(path.parent().unwrap().parent().unwrap())?;
            let directory = path.parent().unwrap();
            crate::diagnostics::private_dir(directory)?;
            crate::diagnostics::atomic_write(directory, &path, detail.to_string().as_bytes())
        })();
        if result.is_ok() {
            self.value["errorDetailFile"] = json!(path);
        } else {
            tracing::warn!("could not save private model error detail");
        }
    }
    pub fn save_transport_error(&mut self, error: &reqwest::Error, phase: &'static str) {
        // 调用方先移除 URL；底层连接原因仅进入同一份有界、私有错误文件。
        self.save_error_detail(&private_error_detail(&json!({
            "kind":"httpTransport", "phase":phase,
            "timedOut":error.is_timeout(), "connect":error.is_connect(),
            "body":error.is_body(), "decode":error.is_decode(),
            "diagnostic":format!("{error:?}")
        })));
    }
    fn save(&self) {
        if let Some(path) = &self.path {
            let result = (|| -> std::io::Result<()> {
                let directory = path.parent().unwrap();
                let _gate = crate::diagnostics::lock(directory)?;
                crate::diagnostics::atomic_write(
                    directory,
                    path,
                    &crate::diagnostics::encode(&self.value),
                )
            })();
            if result.is_err() {
                tracing::warn!("could not save model request audit");
            }
        }
    }
}

impl Drop for Audit {
    fn drop(&mut self) {
        if self.value["outcome"] == "pending" {
            self.value["outcome"] = json!("interrupted_or_unfinished");
        }
        self.value["durationMs"] = json!(self.started.elapsed().as_millis() as u64);
        self.save();
        // Keep a single collectable stream as well as individual crash-visible
        // snapshots. Artifact catalogs can otherwise fill before late requests.
        if let Some(path) = &self.path {
            let append = (|| -> std::io::Result<()> {
                let directory = path.parent().unwrap();
                let gate = crate::diagnostics::lock(directory)?;
                crate::diagnostics::append_jsonl(directory, &self.value)?;
                // 最终记录发布后才释放租约，清理不能删除在途请求或中断其原文写入。
                self.lease.take();
                std::fs::remove_file(
                    directory
                        .join(".leases")
                        .join(path.file_name().unwrap())
                        .with_extension("lock"),
                )?;
                crate::diagnostics::sweep_model(directory, &gate, false)
            })();
            if append.is_err() {
                tracing::warn!("could not append model request audit");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[tokio::test]
    async fn transport_failures_keep_private_phase_and_cause_without_url_or_public_leaks() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for phase in ["request", "responseBody"] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = format!(
                "http://{}/responses?private-query-marker",
                listener.local_addr().unwrap()
            );
            let server = tokio::spawn(async move {
                let (mut connection, _) = listener.accept().await.unwrap();
                let mut received = Vec::new();
                while !received.windows(4).any(|window| window == b"\r\n\r\n") {
                    let mut bytes = [0; 1024];
                    let count = connection.read(&mut bytes).await.unwrap();
                    assert!(count > 0);
                    received.extend_from_slice(&bytes[..count]);
                }
                if phase == "responseBody" {
                    connection.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 9999\r\nConnection: close\r\n\r\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"r\"}}\n\n").await.unwrap();
                }
                connection.shutdown().await.unwrap();
            });
            let directory = tempfile::tempdir().unwrap();
            let mut http = HttpModel::with_protocol(
                endpoint,
                "fixture".into(),
                None,
                ModelProtocol::Responses,
            )
            .unwrap()
            .with_audit_directory(directory.path().to_owned())
            .with_options(ModelOptions {
                max_retries: 0,
                ..Default::default()
            })
            .unwrap();
            // 该 TCP fixture 必须直连；不改变产品对用户代理配置的处理。
            http.client = reqwest::Client::builder().no_proxy().build().unwrap();
            let response = http
                .chat(vec![Message::text("user", "private-input-marker")], vec![])
                .await;
            if phase == "request" {
                assert!(response.is_err());
            } else {
                let events = response.unwrap().collect::<Vec<_>>().await;
                assert!(events.iter().any(Result::is_err));
            }
            server.await.unwrap();
            let journal = std::fs::read_to_string(directory.path().join("requests.jsonl")).unwrap();
            let row: Value = serde_json::from_str(journal.lines().last().unwrap()).unwrap();
            assert_eq!(row["outcome"], "failed");
            let path = Path::new(row["errorDetailFile"].as_str().unwrap());
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            let raw = std::fs::read_to_string(path).unwrap();
            let detail: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(detail["error"]["kind"], "httpTransport");
            assert_eq!(detail["error"]["phase"], phase);
            assert!(!detail["error"]["diagnostic"].as_str().unwrap().is_empty());
            assert!(!raw.contains("private-query-marker"));
            for private in [
                "private-input-marker",
                "private-query-marker",
                "httpTransport",
                "diagnostic",
            ] {
                assert!(!journal.contains(private));
            }
        }
    }

    #[test]
    fn provider_error_is_private_and_not_copied_into_audit() {
        let directory = tempfile::tempdir().unwrap();
        let mut audit = Audit::new(Some(directory.path()), &json!({}), RequestPurpose::Solve);
        let error = StreamError::from_value(&json!({"message":"private prompt and key"}), "error");
        assert!(!format!("{error:?}").contains("private prompt and key"));
        assert!(
            !serde_json::to_string(&error)
                .unwrap()
                .contains("private prompt and key")
        );
        audit.save_error_detail(&error.private_detail.0);
        let path = PathBuf::from(audit.value["errorDetailFile"].as_str().unwrap());
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let detail: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(detail["error"]["message"], "private prompt and key");
        drop(audit);
        assert!(
            !std::fs::read_to_string(directory.path().join("requests.jsonl"))
                .unwrap()
                .contains("private prompt and key")
        );
        let large = StreamError::from_value(&json!({"message":"中".repeat(20000)}), "error");
        assert_eq!(large.private_detail.0["truncated"], true);
        assert!(
            large.private_detail.0["rawJsonPrefix"]
                .as_str()
                .unwrap()
                .len()
                <= 16 * 1024
        );
    }
}
