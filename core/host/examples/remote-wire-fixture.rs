//! 仅用于跨语言 wire 验收。身份从 stdin 读取，不接入生产 Host 或持久状态。
// 只编译 wire 夹具使用的传输模块，未消费接口保留给生产 Gateway。
#[allow(dead_code)]
#[path = "../src/gateway/relay_codec.rs"]
mod relay_codec;
#[allow(dead_code)]
#[path = "../src/gateway/wire.rs"]
mod wire;

use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::io::{AsyncReadExt, AsyncWriteExt};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::{
    io,
    pin::Pin,
    task::{Context as TaskContext, Poll},
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::sync::{Mutex, mpsc};
use tokio_util::compat::TokioAsyncReadCompatExt;

type Output = Arc<Mutex<tokio::io::Stdout>>;

async fn emit(output: &Output, value: Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(&value)?;
    bytes.push(b'\n');
    let mut output = output.lock().await;
    output.write_all(&bytes).await?;
    output.flush().await?;
    Ok(())
}

enum Send {
    Json { id: Value, bytes: Vec<u8> },
    Close,
}

struct MeteredIo<S> {
    stream: S,
    consumed: Arc<AtomicUsize>,
    changed: mpsc::Sender<()>,
}

impl<S: futures_util::io::AsyncRead + Unpin> futures_util::io::AsyncRead for MeteredIo<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        context: &mut TaskContext<'_>,
        bytes: &mut [u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let result = Pin::new(&mut this.stream).poll_read(context, bytes);
        if let Poll::Ready(Ok(count)) = result {
            this.consumed.fetch_add(count, Ordering::SeqCst);
            let _ = this.changed.try_send(());
        }
        result
    }
}

impl<S: futures_util::io::AsyncWrite + Unpin> futures_util::io::AsyncWrite for MeteredIo<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        context: &mut TaskContext<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().stream).poll_write(context, bytes)
    }
    fn poll_flush(self: Pin<&mut Self>, context: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_flush(context)
    }
    fn poll_close(self: Pin<&mut Self>, context: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_close(context)
    }
}

async fn run() -> Result<()> {
    let output = Arc::new(Mutex::new(tokio::io::stdout()));
    let mut input = BufReader::new(tokio::io::stdin()).lines();
    let first: Value = serde_json::from_str(&input.next_line().await?.context("missing init")?)?;
    if first["op"] == "codec" {
        let result = match first["method"].as_str() {
            Some("decodeMessage") => relay_codec::decode_message(
                first["text"].as_str().context("text")?,
                first["binary"].as_bool().unwrap_or(false),
            )
            .map(|value| value.into_value()),
            Some("decodeData") => relay_codec::decode_data(first["data"].as_str().context("data")?)
                .map(|bytes| json!(STANDARD.encode(bytes))),
            Some("encodeData") => relay_codec::encode_data(
                first["channel"].as_str().context("channel")?,
                &STANDARD.decode(first["data"].as_str().context("data")?)?,
            )
            .map(Value::String),
            _ => bail!("unknown codec method"),
        };
        let response = match result {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => json!({"ok":false,"error":error.to_string()}),
        };
        return emit(&output, response).await;
    }
    let identity = wire::Identity::from_base64(first["identity"].as_str().context("identity")?)?;
    if first["op"] == "identity" {
        return emit(&output, json!({"peer":identity.peer().to_string()})).await;
    }
    ensure!(first["op"] == "init", "unknown operation");
    let peer = first["hostPeer"].as_str().map(str::parse).transpose()?;
    let limits = wire::WireLimits {
        max_message_bytes: first["maxMessageBytes"].as_u64().unwrap_or(256 * 1024) as usize,
    };
    let max_buffered = first["maxBufferedBytes"].as_u64().unwrap_or(1024 * 1024) as usize;
    let pending = Arc::new(AtomicUsize::new(0));
    let (transport, outer) = tokio::io::duplex(2 * 1024 * 1024);
    let consumed = Arc::new(AtomicUsize::new(0));
    let (changed, mut changes) = mpsc::channel(1);
    let transport = MeteredIo {
        stream: transport.compat(),
        consumed: consumed.clone(),
        changed,
    };
    let metrics_output = output.clone();
    let metrics_task = tokio::spawn(async move {
        while changes.recv().await.is_some() {
            emit(
                &metrics_output,
                json!({"event":"consumed","total":consumed.load(Ordering::SeqCst)}),
            )
            .await?;
        }
        Ok::<_, anyhow::Error>(())
    });
    let (mut raw_read, mut raw_write) = tokio::io::split(outer);
    let bytes_output = output.clone();
    let bytes_task = tokio::spawn(async move {
        loop {
            let mut header = [0; 2];
            if raw_read.read(&mut header[..1]).await? == 0 {
                return Ok::<_, anyhow::Error>(());
            }
            raw_read.read_exact(&mut header[1..]).await?;
            let length = usize::from(u16::from_be_bytes(header));
            let mut bytes = vec![0; length + 2];
            bytes[..2].copy_from_slice(&header);
            raw_read.read_exact(&mut bytes[2..]).await?;
            emit(
                &bytes_output,
                json!({"event":"bytes","data":STANDARD.encode(&bytes)}),
            )
            .await?;
        }
    });
    let (send, mut sends) = mpsc::channel(16);
    let command_pending = pending.clone();
    let mut commands = tokio::spawn(async move {
        while let Some(line) = input.next_line().await? {
            ensure!(line.len() <= 3 * 1024 * 1024, "fixture command too large");
            let command: Value = serde_json::from_str(&line)?;
            match command["op"].as_str() {
                Some("bytes") => {
                    let bytes = STANDARD.decode(command["data"].as_str().context("bytes")?)?;
                    ensure!(bytes.len() <= 2 * 1024 * 1024, "fixture receive limit");
                    raw_write.write_all(&bytes).await?;
                }
                Some("send") => {
                    let bytes = STANDARD.decode(command["data"].as_str().context("send")?)?;
                    let previous = command_pending.fetch_add(bytes.len(), Ordering::SeqCst);
                    ensure!(
                        bytes.len() <= limits.max_message_bytes
                            && previous + bytes.len() <= max_buffered,
                        "数据超过传输上限"
                    );
                    send.send(Send::Json {
                        id: command["id"].clone(),
                        bytes,
                    })
                    .await?;
                }
                Some("close") => {
                    send.send(Send::Close).await?;
                    return Ok::<_, anyhow::Error>(());
                }
                Some("eof") => {
                    raw_write.shutdown().await?;
                }
                Some("abort") => bail!("fixture aborted"),
                _ => bail!("unknown fixture command"),
            }
        }
        Ok(())
    });
    let channel_output = output.clone();
    let result = {
        let session = async {
            let channel = wire::authenticate(transport, &identity, peer, limits).await?;
            emit(
                &channel_output,
                json!({"event":"ready","peer":channel.peer.to_string()}),
            )
            .await?;
            let (mut read, mut write) = channel.stream.split();
            let read_output = channel_output.clone();
            let reader = async move {
                while let Some(bytes) = wire::read_json(&mut read, channel.limits).await? {
                    emit(
                        &read_output,
                        json!({"event":"message","data":STANDARD.encode(bytes)}),
                    )
                    .await?;
                }
                Ok::<_, anyhow::Error>(())
            };
            let writer = async move {
                while let Some(command) = sends.recv().await {
                    match command {
                        Send::Json { id, bytes } => {
                            wire::write_json(&mut write, &bytes, limits).await?;
                            pending.fetch_sub(bytes.len(), Ordering::SeqCst);
                            emit(
                                &channel_output,
                                json!({"event":"sent","id":id,"size":bytes.len()}),
                            )
                            .await?;
                        }
                        Send::Close => {
                            write.close().await?;
                            return Ok::<_, anyhow::Error>(());
                        }
                    }
                }
                Ok(())
            };
            tokio::pin!(reader, writer);
            tokio::select! { result = &mut reader => result, result = &mut writer => result }
        };
        tokio::pin!(session);
        tokio::select! {
            result = &mut session => result,
            result = &mut commands => { result??; session.await }
        }
    };
    commands.abort();
    // 通道 close 已写入底层缓冲，等字节泵排尽后再报告 done。
    bytes_task.await??;
    metrics_task.await??;
    result?;
    emit(&output, json!({"event":"done"})).await
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    if let Err(error) = run().await {
        let output = Arc::new(Mutex::new(tokio::io::stdout()));
        let _ = emit(
            &output,
            json!({"event":"error","error":format!("{error:#}")}),
        )
        .await;
        std::process::exit(1);
    }
}
