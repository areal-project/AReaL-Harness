use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use libp2p_core::upgrade::{InboundConnectionUpgrade, OutboundConnectionUpgrade};
use libp2p_identity::{KeyType, Keypair, PeerId};
use std::time::Duration;

pub(crate) const PROLOGUE: &[u8] = b"areal.remote.v1";
pub(crate) const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);

pub(crate) struct Identity(Keypair);

impl Identity {
    pub(crate) fn from_base64(encoded: &str) -> Result<Self> {
        let bytes = STANDARD.decode(encoded).context("Remote identity base64")?;
        let key = Keypair::from_protobuf_encoding(&bytes).context("Remote identity protobuf")?;
        ensure!(
            key.key_type() == KeyType::Ed25519,
            "Remote identity must be Ed25519"
        );
        Ok(Self(key))
    }

    pub(crate) fn peer(&self) -> PeerId {
        self.0.public().to_peer_id()
    }
}

#[derive(Clone, Copy)]
pub(crate) struct WireLimits {
    pub(crate) max_message_bytes: usize,
}

impl WireLimits {
    pub(crate) fn authenticated() -> Self {
        // 应用消息跨多个 Noise record；保留加密层单 record 的独立上限。
        Self {
            max_message_bytes: 8 * 1024 * 1024,
        }
    }
}

impl Default for WireLimits {
    fn default() -> Self {
        Self {
            max_message_bytes: 256 * 1024,
        }
    }
}

pub(crate) struct AuthenticatedChannel<S> {
    pub(crate) peer: PeerId,
    pub(crate) stream: libp2p_noise::Output<S>,
    pub(crate) limits: WireLimits,
}

/// 直接升级字节流，不运行 multistream 或 muxer 协商。
pub(crate) async fn authenticate<S>(
    stream: S,
    identity: &Identity,
    expected_peer: Option<PeerId>,
    limits: WireLimits,
) -> Result<AuthenticatedChannel<S>>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let config = libp2p_noise::Config::new(&identity.0)?.with_prologue(PROLOGUE.to_vec());
    let handshake = async {
        if expected_peer.is_some() {
            config.upgrade_outbound(stream, "/noise").await
        } else {
            config.upgrade_inbound(stream, "/noise").await
        }
    };
    let (peer, stream) = tokio::time::timeout(HANDSHAKE_TIMEOUT, handshake)
        .await
        .context("Remote Noise handshake timed out")??;
    if let Some(expected) = expected_peer {
        ensure!(peer == expected, "Remote Host identity does not match pin");
    }
    Ok(AuthenticatedChannel {
        peer,
        stream,
        limits,
    })
}

/// 消息头和 JSON 字节可跨任意数量的 Noise record。
pub(crate) async fn read_json<R: AsyncRead + Unpin>(
    reader: &mut R,
    limits: WireLimits,
) -> Result<Option<Vec<u8>>> {
    read_json_with_limits(reader, || limits).await
}

// 在读完长度头时取当前授权上限，避免空闲读取提前冻结 hello 阶段的限制。
pub(crate) async fn read_json_with_limits<R: AsyncRead + Unpin>(
    reader: &mut R,
    limits: impl Fn() -> WireLimits,
) -> Result<Option<Vec<u8>>> {
    let mut length = 0usize;
    for index in 0..8 {
        let mut byte = [0];
        let count = reader.read(&mut byte).await?;
        if count == 0 {
            ensure!(index == 0, "Remote message length is truncated");
            return Ok(None);
        }
        length |= usize::from(byte[0] & 0x7f) << (index * 7);
        ensure!(length <= limits().max_message_bytes, "数据超过传输上限");
        if byte[0] & 0x80 == 0 {
            let mut bytes = vec![0; length];
            reader.read_exact(&mut bytes).await?;
            std::str::from_utf8(&bytes).context("Remote message UTF-8")?;
            serde_json::from_slice::<&serde_json::value::RawValue>(&bytes)
                .context("Remote message JSON")?;
            return Ok(Some(bytes));
        }
    }
    bail!("Remote message length is invalid")
}

pub(crate) async fn write_json<W: AsyncWrite + Unpin>(
    writer: &mut W,
    bytes: &[u8],
    limits: WireLimits,
) -> Result<()> {
    ensure!(bytes.len() <= limits.max_message_bytes, "数据超过传输上限");
    std::str::from_utf8(bytes).context("Remote message UTF-8")?;
    serde_json::from_slice::<&serde_json::value::RawValue>(bytes).context("Remote message JSON")?;
    let mut length = bytes.len();
    let mut header = Vec::with_capacity(4);
    while length >= 128 {
        header.push((length as u8 & 0x7f) | 0x80);
        length >>= 7;
    }
    header.push(length as u8);
    writer.write_all(&header).await?;
    // 现有 JS 通道分别提交长度头与正文，保留其 Noise record 边界。
    writer.flush().await?;
    writer.write_all(bytes).await?;
    writer.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::io::Cursor;
    use tokio_util::compat::TokioAsyncReadCompatExt;

    const IDENTITY: &str = "CAESQBPbDgaE5lv/gqyv4asbL64lRUmBU9DHlIHKMIx6hCRk0hf/zGyqVa15cPAWASCqiyTwkvIcLwn8n7ipLs5dEIs=";

    #[tokio::test]
    async fn authenticates_the_original_identity_and_enforces_message_limits() {
        let host = Identity::from_base64(IDENTITY).unwrap();
        let client = Identity::from_base64(IDENTITY).unwrap();
        let (left, right) = tokio::io::duplex(4096);
        let limits = WireLimits {
            max_message_bytes: 32,
        };
        let (host_channel, client_channel) = tokio::join!(
            authenticate(left.compat(), &host, None, limits),
            authenticate(right.compat(), &client, Some(host.peer()), limits),
        );
        let mut host_channel = host_channel.unwrap();
        let mut client_channel = client_channel.unwrap();
        assert_eq!(host_channel.peer, client.peer());
        assert_eq!(client_channel.peer, host.peer());
        write_json(&mut client_channel.stream, br#"{"hello":"world"}"#, limits)
            .await
            .unwrap();
        assert_eq!(
            read_json(&mut host_channel.stream, host_channel.limits)
                .await
                .unwrap()
                .unwrap(),
            br#"{"hello":"world"}"#
        );
        assert!(
            write_json(&mut client_channel.stream, &[b' '; 33], limits)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn authenticated_noise_carries_gui_upload_mcp_and_long_read_messages() {
        let identity = Identity::from_base64(IDENTITY).unwrap();
        let limits = WireLimits::authenticated();
        let (left, right) = tokio::io::duplex(4096);
        let (host, client) = tokio::join!(
            authenticate(left.compat(), &identity, None, limits),
            authenticate(right.compat(), &identity, Some(identity.peer()), limits),
        );
        let mut host = host.unwrap();
        let mut client = client.unwrap();
        let upload = serde_json::json!({"id":"upload","method":"attachment.upload","params":{
            "threadId":"thread","uploadId":"upload","mimeType":"application/pdf",
            "sizeBytes":262144,"offset":0,"base64":STANDARD.encode(vec![42; 256 * 1024])
        }});
        let mcp = serde_json::json!({"id":"mcp","method":"session.send","params":{
            "mcpContent":[{"type":"text","text":"m".repeat(512 * 1024)}]
        }});
        for request in [upload, mcp] {
            let bytes = serde_json::to_vec(&request).unwrap();
            assert!(bytes.len() > WireLimits::default().max_message_bytes);
            let (sent, received) = tokio::join!(
                write_json(&mut client.stream, &bytes, client.limits),
                read_json(&mut host.stream, host.limits),
            );
            sent.unwrap();
            assert_eq!(received.unwrap().unwrap(), bytes);
        }
        let response = serde_json::to_vec(&serde_json::json!({"id":"read","result":{
            "event":"session.snapshot","items":[{"type":"message","text":"r".repeat(4 * 1024 * 1024)}]
        }})).unwrap();
        let (sent, received) = tokio::join!(
            write_json(&mut host.stream, &response, host.limits),
            read_json(&mut client.stream, client.limits),
        );
        sent.unwrap();
        assert_eq!(received.unwrap().unwrap(), response);
        // 大消息后仍能复用原 Noise 通道。
        let (sent, received) = tokio::join!(
            write_json(
                &mut client.stream,
                br#"{"method":"host.describe"}"#,
                client.limits
            ),
            read_json(&mut host.stream, host.limits),
        );
        sent.unwrap();
        assert_eq!(received.unwrap().unwrap(), br#"{"method":"host.describe"}"#);
    }

    #[tokio::test]
    async fn message_limits_remain_small_until_authorized_and_bound_authenticated_allocations() {
        let large = serde_json::to_vec(&"x".repeat(256 * 1024)).unwrap();
        assert!(
            write_json(&mut Cursor::new(Vec::new()), &large, WireLimits::default())
                .await
                .is_err()
        );
        let mut encoded = Cursor::new(Vec::new());
        write_json(&mut encoded, &large, WireLimits::authenticated())
            .await
            .unwrap();
        encoded.set_position(0);
        assert!(
            read_json(&mut encoded, WireLimits::default())
                .await
                .is_err()
        );
        let too_large = serde_json::to_vec(&"x".repeat(8 * 1024 * 1024)).unwrap();
        assert!(
            write_json(
                &mut Cursor::new(Vec::new()),
                &too_large,
                WireLimits::authenticated()
            )
            .await
            .is_err()
        );
        // 8 MiB + 1 的长度头必须在分配正文前拒绝。
        assert!(
            read_json(
                &mut Cursor::new(vec![0x81, 0x80, 0x80, 0x04]),
                WireLimits::authenticated()
            )
            .await
            .is_err()
        );

        let limits = std::cell::Cell::new(WireLimits::default());
        let (reader, writer) = tokio::io::duplex(4096);
        let (mut reader, mut writer) = (reader.compat(), writer.compat());
        let reading = read_json_with_limits(&mut reader, || limits.get());
        tokio::pin!(reading);
        // 先开始空闲读取，再完成授权：已挂起的读取也必须使用新上限。
        tokio::select! {
            biased;
            _ = &mut reading => panic!("read should await a message"),
            _ = std::future::ready(()) => {},
        }
        limits.set(WireLimits::authenticated());
        let (sent, received) = tokio::join!(write_json(&mut writer, &large, limits.get()), reading);
        sent.unwrap();
        assert_eq!(received.unwrap().unwrap(), large);
    }

    #[tokio::test]
    async fn rejects_a_different_noise_prologue() {
        let identity = Identity::from_base64(IDENTITY).unwrap();
        let config = libp2p_noise::Config::new(&identity.0)
            .unwrap()
            .with_prologue(b"wrong-prologue".to_vec());
        let (left, right) = tokio::io::duplex(4096);
        let (host, client) = tokio::join!(
            authenticate(left.compat(), &identity, None, WireLimits::default()),
            config.upgrade_outbound(right.compat(), "/noise"),
        );
        assert!(host.is_err());
        assert!(client.is_err());
    }

    #[tokio::test]
    async fn frames_preserve_json_bytes_and_reject_invalid_input() {
        let limits = WireLimits::default();
        let bytes = br#"{ "text": "hello", "n": 1 }"#;
        let mut stream = Cursor::new(Vec::new());
        write_json(&mut stream, bytes, limits).await.unwrap();
        stream.set_position(0);
        assert_eq!(
            read_json(&mut stream, limits).await.unwrap().unwrap(),
            bytes
        );
        assert!(read_json(&mut stream, limits).await.unwrap().is_none());
        for bytes in [
            br#"{"text":"\ud800"}"#.as_slice(),
            br#"{"number":1e400}"#.as_slice(),
        ] {
            let mut stream = Cursor::new(Vec::new());
            write_json(&mut stream, bytes, limits).await.unwrap();
            stream.set_position(0);
            assert_eq!(
                read_json(&mut stream, limits).await.unwrap().unwrap(),
                bytes
            );
        }
        for bytes in [
            vec![0x80],
            vec![0x80, 0x80, 0x20],
            vec![1, 0xff],
            vec![1, b'{'],
        ] {
            assert!(read_json(&mut Cursor::new(bytes), limits).await.is_err());
        }
    }
}
