use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};
pub const MAX_FRAME: usize = 1024 * 1024;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub version: u32,
    pub id: String,
    pub method: String,
    pub params: Value,
}
#[derive(Debug)]
pub struct Error {
    pub code: &'static str,
    pub message: String,
    pub stage: Option<&'static str>,
    pub detail: Option<String>,
    pub retryable: Option<bool>,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for Error {}
pub fn error(code: &'static str, message: impl Into<String>) -> anyhow::Error {
    Error {
        code,
        message: message.into(),
        stage: None,
        detail: None,
        retryable: None,
    }
    .into()
}
pub fn staged_error(
    code: &'static str,
    stage: &'static str,
    message: impl Into<String>,
    detail: Option<String>,
    retryable: bool,
) -> anyhow::Error {
    Error {
        code,
        message: message.into(),
        stage: Some(stage),
        detail: detail.map(|text| sanitize_detail(&text)),
        retryable: Some(retryable),
    }
    .into()
}
/// 脱敏并截断错误细节：先检查私密关键词，再移除 URL userinfo / 查询参数 / 片段与控制字符，
/// 确保不会把凭据、令牌或原始用户输入写进日志或协议错误。
pub fn sanitize_detail(raw: &str) -> String {
    let lowered = raw.to_ascii_lowercase();
    for needle in [
        "bearer ",
        "authorization",
        "token",
        "api_key",
        "apikey",
        "x-api-key",
        "password",
        "passwd",
        "secret",
        "cookie",
        "credential",
        "private_key",
    ] {
        if lowered.contains(needle) {
            return "redacted transport error".into();
        }
    }
    let scrubbed = scrub_urls(raw);
    let mut cleaned = String::with_capacity(scrubbed.len().min(240));
    let mut prev_space = false;
    for ch in scrubbed.chars() {
        let ch = if ch.is_control() { ' ' } else { ch };
        if ch == ' ' {
            if prev_space {
                continue;
            }
            prev_space = true;
        } else {
            prev_space = false;
        }
        cleaned.push(ch);
        if cleaned.len() >= 240 {
            break;
        }
    }
    cleaned.trim().to_owned()
}
fn scrub_urls(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for (idx, word) in raw.split_whitespace().enumerate() {
        if idx > 0 {
            out.push(' ');
        }
        if let Some(scheme_pos) = word.find("://") {
            let prefix = &word[..scheme_pos + 3];
            let rest = &word[scheme_pos + 3..];
            // 剥离查询参数与片段，避免任意 query 值进入诊断信息。
            let without_query = rest.split(['?', '#']).next().unwrap_or("");
            // 剥离 authority 中的 userinfo（user:pass@host）。
            let authority_end = without_query.find('/').unwrap_or(without_query.len());
            let authority = &without_query[..authority_end];
            let path = &without_query[authority_end..];
            out.push_str(prefix);
            if let Some((_, host)) = authority.rsplit_once('@') {
                out.push_str("[redacted]@");
                out.push_str(host);
            } else {
                out.push_str(authority);
            }
            out.push_str(path);
        } else {
            out.push_str(word);
        }
    }
    out
}
pub fn diagnostic_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..8].to_owned()
}
pub fn request_id(id: &str) -> Result<()> {
    uuid::Uuid::parse_str(id).map_err(|_| error("invalidRequest", "requestId must be a UUID"))?;
    Ok(())
}
pub fn operation_path(home: &Path, id: &str) -> PathBuf {
    home.join("host/operations").join(format!(
        "{}.json",
        areal_local_service::storage::digest(id.as_bytes())
    ))
}
pub async fn read(reader: &mut (impl AsyncBufRead + Unpin)) -> Result<Option<Value>> {
    read_buffered(reader, &mut Vec::new()).await
}
pub async fn read_buffered(
    reader: &mut (impl AsyncBufRead + Unpin),
    bytes: &mut Vec<u8>,
) -> Result<Option<Value>> {
    read_buffered_limit(reader, bytes, MAX_FRAME).await
}
pub(crate) async fn read_buffered_limit(
    reader: &mut (impl AsyncBufRead + Unpin),
    bytes: &mut Vec<u8>,
    limit: usize,
) -> Result<Option<Value>> {
    loop {
        let buf = reader.fill_buf().await?;
        if buf.is_empty() {
            ensure!(bytes.is_empty(), "truncated frame");
            return Ok(None);
        }
        let end = buf.iter().position(|b| *b == b'\n').map(|i| i + 1);
        let n = end.unwrap_or(buf.len());
        ensure!(bytes.len() + n <= limit, "frame exceeds 1 MiB");
        bytes.extend_from_slice(&buf[..n]);
        reader.consume(n);
        if end.is_some() {
            let value = serde_json::from_slice(bytes)?;
            bytes.clear();
            return Ok(Some(value));
        }
    }
}
pub async fn write(writer: &mut (impl AsyncWrite + Unpin), value: &impl Serialize) -> Result<()> {
    let mut bytes = serde_json::to_vec(value)?;
    bytes.push(b'\n');
    ensure!(bytes.len() <= MAX_FRAME, "frame exceeds 1 MiB");
    writer.write_all(&bytes).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn interrupted_subscription_read_keeps_partial_frame() {
        let (mut writer, reader) = tokio::io::duplex(128);
        let mut reader = tokio::io::BufReader::new(reader);
        let mut bytes = Vec::new();
        writer.write_all(b"{\"x\":").await.unwrap();
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(10),
                read_buffered(&mut reader, &mut bytes)
            )
            .await
            .is_err()
        );
        writer.write_all(b"1}\n").await.unwrap();
        assert_eq!(
            read_buffered(&mut reader, &mut bytes)
                .await
                .unwrap()
                .unwrap()["x"],
            1
        );
    }
    #[tokio::test]
    async fn frame_limit_rejects_unterminated_input_without_unbounded_buffering() {
        let bytes = vec![b' '; MAX_FRAME + 1];
        assert!(
            read(&mut tokio::io::BufReader::new(bytes.as_slice()))
                .await
                .unwrap_err()
                .to_string()
                .contains("1 MiB")
        );
        assert!(
            read(&mut tokio::io::BufReader::new(&b"{\"x\":1}"[..]))
                .await
                .is_err()
        );
        let value = read(&mut tokio::io::BufReader::new(&b"{\"x\":1}\n"[..]))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(value["x"], 1);
    }
}
