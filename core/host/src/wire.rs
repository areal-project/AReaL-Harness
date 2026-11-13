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
    }
    .into()
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
