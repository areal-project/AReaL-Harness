//! 真实 WSS + Noise 传输夹具。应用层仅提供 echo/read，不模拟授权或 Gateway 业务。
// 夹具只消费这几个传输模块的部分接口，不编译生产 Direct 入口。
#[allow(dead_code)]
#[path = "../src/gateway/relay.rs"]
mod relay;
#[allow(dead_code)]
#[path = "../src/gateway/relay_codec.rs"]
mod relay_codec;
#[allow(dead_code)]
#[path = "../src/gateway/wire.rs"]
mod wire;

use anyhow::{Context, Result, bail};
use futures_util::io::AsyncWriteExt;
use relay::{RelayConfig, RelayEvent, RelayOwner};
use serde_json::{Value, json};
use std::{cell::Cell, rc::Rc, sync::Arc};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt as _, BufReader},
    sync::{Mutex, mpsc},
};

type Output = Arc<Mutex<tokio::io::Stdout>>;
async fn emit(output: &Output, value: Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(&value)?;
    bytes.push(b'\n');
    let mut output = output.lock().await;
    output.write_all(&bytes).await?;
    output.flush().await?;
    Ok(())
}
async fn app(
    stream: relay::RelayStream,
    identity: Rc<wire::Identity>,
    id: String,
    generation: u64,
    output: Output,
) -> Result<()> {
    let channel = wire::authenticate(stream, &identity, None, wire::WireLimits::default()).await?;
    emit(&output, json!({"event":"authenticated","channel":id,"generation":generation,"peer":channel.peer.to_string()})).await?;
    let limits = channel.limits;
    let (mut reader, mut writer) = futures_util::io::AsyncReadExt::split(channel.stream);
    let (send, mut sends) = mpsc::channel::<(Vec<u8>, bool)>(8);
    let read_output = output.clone();
    let read_id = id.clone();
    let read = async move {
        while let Some(bytes) = wire::read_json(&mut reader, limits).await? {
            let value: Value = serde_json::from_slice(&bytes)?;
            emit(&read_output, json!({"event":"request","channel":read_id,"generation":generation,"id":value["id"],"method":value["method"]})).await?;
            let response = match value["method"].as_str() {
                Some("echo") => {
                    json!({"id":value["id"],"scope":"native-relay-fixture-echo","result":value["params"]})
                }
                Some("read") => {
                    json!({"id":value["id"],"scope":"native-relay-fixture-read","result":{"value":"fixture only"}})
                }
                Some("large") => {
                    json!({"id":value["id"],"scope":"native-relay-fixture-echo","result":"x".repeat(value["params"]["bytes"].as_u64().context("bytes")?.min(240 * 1024) as usize)})
                }
                Some("close") => json!({"id":value["id"],"result":"flushed"}),
                _ => bail!("fixture supports echo/read/large/close only"),
            };
            let close = value["method"] == "close";
            send.send((serde_json::to_vec(&response)?, close))
                .await
                .context("fixture writer closed")?;
            if close {
                break;
            }
        }
        Ok::<_, anyhow::Error>(())
    };
    let write = async {
        while let Some((bytes, close)) = sends.recv().await {
            wire::write_json(&mut writer, &bytes, limits).await?;
            emit(
                &output,
                json!({"event":"queued","channel":id,"generation":generation,"bytes":bytes.len()}),
            )
            .await?;
            if close {
                writer.close().await?;
                break;
            }
        }
        Ok::<_, anyhow::Error>(())
    };
    tokio::pin!(read, write);
    tokio::select! {
        result = &mut read => { result?; write.await?; },
        result = &mut write => result?,
    }
    Ok(())
}
async fn run() -> Result<()> {
    let output = Arc::new(Mutex::new(tokio::io::stdout()));
    let mut input = BufReader::new(tokio::io::stdin()).lines();
    let first: Value = serde_json::from_str(&input.next_line().await?.context("missing config")?)?;
    let identity = Rc::new(wire::Identity::from_base64(
        first["identity"].as_str().context("identity")?,
    )?);
    emit(
        &output,
        json!({"event":"identity","peer":identity.peer().to_string()}),
    )
    .await?;
    let config = RelayConfig {
        url: first["url"].as_str().context("url")?.to_owned(),
        room: first["room"].as_str().context("room")?.to_owned(),
        capability: first["capability"]
            .as_str()
            .context("capability")?
            .to_owned(),
        local_host: first["localHost"].as_str().map(str::to_owned),
    };
    let (owner, handle, mut events) = RelayOwner::with_counters(config, Default::default());
    let owner = tokio::task::spawn_local(owner.run());
    let mut sessions = tokio::task::JoinSet::new();
    let authorized = Rc::new(Cell::new(true));
    loop {
        tokio::select! {
            event = events.recv() => {
                let Some(event) = event else { break; };
                match event {
                    RelayEvent::Ready { _generation: generation, push } => emit(&output, json!({"event":"ready","generation":generation,"push":push})).await?,
                    RelayEvent::Disconnected { _generation: generation, reason, retry } => emit(&output, json!({"event":"disconnected","generation":generation,"reason":reason,"retry":retry})).await?,
                    RelayEvent::PushUnregistered(token) => emit(&output, json!({"event":"pushUnregistered","token":token})).await?,
                    RelayEvent::PushDropped => emit(&output, json!({"event":"pushDropped"})).await?,
                    RelayEvent::Channel { generation, id, stream } => {
                        emit(&output, json!({"event":"channel","channel":id,"generation":generation})).await?;
                        let identity = identity.clone();
                        let output = output.clone();
                        sessions.spawn_local(async move {
                            let result = app(stream, identity, id.clone(), generation, output.clone()).await;
                            emit(&output, match result { Ok(()) => json!({"event":"sessionClosed","channel":id,"generation":generation}), Err(error) => json!({"event":"sessionError","channel":id,"generation":generation,"error":format!("{error:#}")}) }).await
                        });
                    },
                }
            },
            line = input.next_line() => {
                let Some(line) = line? else { break; };
                let command: Value = serde_json::from_str(&line)?;
                match command["op"].as_str() {
                    Some("stop") => break,
                    Some("reconnect") => handle.reconnect(),
                    Some("abort") => handle.abort(command["generation"].as_u64().context("generation")?, command["channel"].as_str().context("channel")?),
                    Some("authorizePush") => authorized.set(command["value"] == true),
                    Some("push") => {
                        let authorized = authorized.clone();
                        let accepted = handle.try_push(command["value"].clone(), Rc::new(move || authorized.get()));
                        emit(&output, json!({"event":"pushAccepted","accepted":accepted})).await?;
                    },
                    _ => bail!("unknown command"),
                }
            },
            Some(result) = sessions.join_next(), if !sessions.is_empty() => { result??; },
        }
    }
    handle.stop();
    owner.await?;
    sessions.abort_all();
    while sessions.join_next().await.is_some() {}
    emit(&output, json!({"event":"stopped"})).await?;
    Ok(())
}
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    tokio::task::LocalSet::new().run_until(run()).await
}
