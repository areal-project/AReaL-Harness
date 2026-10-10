//! 请求传输限额独立于 token 估算；拒绝时只保存大小和阶段。
use super::*;
use std::io::{self, Write};

const MAX_REQUEST_ASSEMBLY_BYTES: usize = 128 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
#[error(
    "model request exceeds byte budget at {stage}: {actual} bytes > {limit}; read fewer/smaller image views or compact history"
)]
pub(super) struct RequestTooLarge {
    pub actual: usize,
    pub limit: usize,
    pub stage: &'static str,
}

pub(super) struct MediaBudget {
    used: usize,
    limit: usize,
}
impl MediaBudget {
    pub fn new(limit: usize) -> Self {
        Self { used: 0, limit }
    }
    pub fn consume(&mut self, bytes: usize) -> Result<()> {
        self.used = self.used.saturating_add(bytes);
        if self.used > self.limit {
            return Err(RequestTooLarge {
                actual: self.used,
                limit: self.limit,
                stage: "materialized_media",
            }
            .into());
        }
        Ok(())
    }
}

struct Counter(usize);
impl Write for Counter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0 = self.0.saturating_add(bytes.len());
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl HttpModel {
    pub(super) fn materialization_limit(&self) -> usize {
        // WebSocket 需要完整历史来核对续接；发送限额只作用于最终增量封套。
        if self.options.responses_websocket {
            MAX_REQUEST_ASSEMBLY_BYTES
        } else {
            self.options.max_request_bytes
        }
    }

    pub(super) fn reject_request(
        &self,
        actual: usize,
        limit: usize,
        stage: &'static str,
        purpose: RequestPurpose,
    ) -> anyhow::Error {
        let error: anyhow::Error = RequestTooLarge {
            actual,
            limit,
            stage,
        }
        .into();
        let mut audit = audit::Audit::new(
            self.audit_directory.as_deref(),
            &json!({"model":self.name}),
            purpose,
        );
        audit.value["outcome"] = json!("failed");
        audit.value["error"] = json!(error.to_string());
        audit.value["protocol"] = json!(match self.protocol {
            ModelProtocol::Responses => "responses",
            ModelProtocol::ChatCompletions => "chat-completions",
        });
        audit.value["bodyBytes"] = if stage == "serialized_request" {
            json!(actual)
        } else {
            Value::Null
        };
        if stage == "request_materialization" {
            audit.value["serializedHistoryBytes"] = json!(actual);
        } else if stage != "serialized_request" {
            audit.value["contentBytesLowerBound"] = json!(actual);
        }
        audit.value["bodySha256"] = Value::Null;
        audit.value["requestSent"] = json!(false);
        audit.value["terminalOutcome"] = json!(terminal_outcome(&error));
        error
    }

    pub(super) fn check_request_size(
        &self,
        body: &Value,
        limit: usize,
        stage: &'static str,
        purpose: RequestPurpose,
    ) -> Result<()> {
        // 先流式计数，不为被拒绝的 JSON 分配同等大小的编码缓冲区。
        let mut count = Counter(0);
        serde_json::to_writer(&mut count, body)?;
        if count.0 > limit {
            return Err(self.reject_request(count.0, limit, stage, purpose));
        }
        Ok(())
    }

    pub(super) fn encode_request(&self, body: &Value, purpose: RequestPurpose) -> Result<Vec<u8>> {
        self.check_request_size(
            body,
            self.options.max_request_bytes,
            "serialized_request",
            purpose,
        )?;
        Ok(serde_json::to_vec(body)?)
    }

    pub(super) async fn preflight_media(
        &self,
        messages: &[Message],
        purpose: RequestPurpose,
    ) -> Result<()> {
        let mut bytes = 0usize;
        for message in messages {
            if message.provider_context.is_some() {
                continue;
            }
            for part in &message.content {
                let size = match part {
                    ContentPart::Text(text) => text.len(),
                    ContentPart::Audio {
                        source: MediaSource::Url(url),
                    } if url.starts_with("data:audio/") => {
                        url.split_once(',').map_or(0, |(_, data)| data.len())
                    }
                    ContentPart::Image { source, .. }
                    | ContentPart::Audio { source }
                    | ContentPart::File { source, .. } => match source {
                        MediaSource::Url(url) => url.len(),
                        MediaSource::LocalPath(path) => {
                            let metadata = tokio::fs::metadata(path)
                                .await
                                .context("cannot inspect local media")?;
                            anyhow::ensure!(
                                metadata.is_file()
                                    && metadata.len() <= MAX_LOCAL_MEDIA_BYTES as u64,
                                "local media must be a regular file no larger than 16 MiB"
                            );
                            (metadata.len() as usize).div_ceil(3) * 4
                        }
                    },
                };
                bytes = bytes.saturating_add(size);
                if bytes > self.materialization_limit() {
                    return Err(self.reject_request(
                        bytes,
                        self.materialization_limit(),
                        "content_lower_bound",
                        purpose,
                    ));
                }
            }
        }
        Ok(())
    }
}

pub(super) async fn read_local_media(path: &str) -> Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let file = tokio::fs::File::open(path)
        .await
        .context("cannot open local media")?;
    let metadata = file.metadata().await?;
    anyhow::ensure!(
        metadata.is_file() && metadata.len() <= MAX_LOCAL_MEDIA_BYTES as u64,
        "local media must be a regular file no larger than 16 MiB"
    );
    let mut bytes = Vec::new();
    file.take(MAX_LOCAL_MEDIA_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .await?;
    anyhow::ensure!(
        bytes.len() <= MAX_LOCAL_MEDIA_BYTES,
        "local media grew beyond 16 MiB during read"
    );
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn exact_wire_budget_counts_escaping_tools_and_repeated_media() {
        for protocol in [ModelProtocol::ChatCompletions, ModelProtocol::Responses] {
            let model = HttpModel::with_protocol(
                "http://127.0.0.1:1".into(),
                "fixture".into(),
                None,
                protocol,
            )
            .unwrap()
            .with_options(ModelOptions {
                max_request_bytes: 1024,
                ..Default::default()
            })
            .unwrap();
            let body = json!({"text":"\n".repeat(600),"tools":[{"name":"read"}]});
            let error = model
                .encode_request(&body, RequestPurpose::Solve)
                .unwrap_err();
            let outcome = terminal_outcome(&error).unwrap();
            assert_eq!(outcome.code, "MODEL_REQUEST_TOO_LARGE");
            assert_eq!(
                outcome.details.as_ref().unwrap()["actualBytes"],
                serde_json::to_vec(&body).unwrap().len()
            );
            assert_eq!(outcome.details.unwrap()["requestSent"], false);
            assert_eq!(
                model
                    .encode_request(&json!("x".repeat(1022)), RequestPurpose::Solve)
                    .unwrap()
                    .len(),
                1024
            );
            let message = Message {
                content: vec![
                    ContentPart::Image {
                        source: MediaSource::Url(format!(
                            "data:image/png;base64,{}",
                            "x".repeat(600)
                        )),
                        detail: None
                    };
                    2
                ],
                ..Message::text("user", "")
            };
            assert!(
                model
                    .preflight_media(&[message], RequestPurpose::Solve)
                    .await
                    .is_err()
            );
            assert!(!is_network_error(&error));
            let result = model
                .chat(vec![Message::text("user", "\n".repeat(600))], vec![])
                .await;
            let error = match result {
                Err(error) => error,
                Ok(_) => panic!("oversized request was sent"),
            };
            assert_eq!(
                terminal_outcome(&error).unwrap().code,
                "MODEL_REQUEST_TOO_LARGE"
            );
        }
    }
}
