//! 仅通过继承的私有 stdin/stdout 接受一个调用方；关闭输入即撤销连接资源。
pub mod components;
use areal_runtime_protocol::*;
use areal_runtime_supervisor::Supervisor;
use components::RuntimeHost;
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite, AsyncWriteExt},
    sync::{Semaphore, mpsc},
};
use tokio_util::{
    codec::{FramedRead, LinesCodec},
    sync::CancellationToken,
    task::TaskTracker,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: Value,
    method: String,
    params: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Open {
    protocol_version: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScopeId {
    scope_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProcessId {
    process_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OperationId {
    operation_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}

pub async fn serve<R, W>(
    read: R,
    write: W,
    host: Arc<RuntimeHost>,
    stop: CancellationToken,
) -> Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let runtime = host.supervisor();
    let (responses, mut outgoing) = mpsc::channel::<Value>(64);
    let writer_stop = stop.clone();
    let mut writer = tokio::spawn(async move {
        let mut write = write;
        while let Some(response) = outgoing.recv().await {
            let mut bytes = serde_json::to_vec(&response).expect("serializable response");
            bytes.push(b'\n');
            if write.write_all(&bytes).await.is_err() || write.flush().await.is_err() {
                writer_stop.cancel();
                return Err(Error::new(
                    ErrorCode::Unavailable,
                    "Runtime output transport closed",
                ));
            }
        }
        Ok(())
    });
    let requests = TaskTracker::new();
    let in_flight = Arc::new(Mutex::new(HashSet::new()));
    let permits = Arc::new(Semaphore::new(32));
    let mut frames = FramedRead::new(read, LinesCodec::new_with_max_length(MAX_FRAME_BYTES));
    let mut initialized = false;
    let mut close_id = None;
    loop {
        let frame = tokio::select! {
            biased;
            _ = stop.cancelled() => break,
            frame = frames.next() => frame,
        };
        let Some(frame) = frame else {
            break;
        };
        let frame = match frame {
            Ok(frame) => frame,
            Err(_) => {
                send(
                    &responses,
                    response(
                        Value::Null,
                        Err(Error::new(
                            ErrorCode::InvalidRequest,
                            "frame exceeds limit or transport failed",
                        )),
                    ),
                    &stop,
                );
                break;
            }
        };
        let request: Request = match serde_json::from_str(&frame) {
            Ok(request) => request,
            Err(_) => {
                send(
                    &responses,
                    response(
                        Value::Null,
                        Err(Error::new(
                            ErrorCode::InvalidRequest,
                            "expected id, method and object params",
                        )),
                    ),
                    &stop,
                );
                continue;
            }
        };
        let valid_id = request
            .id
            .as_str()
            .is_some_and(|s| !s.is_empty() && s.len() <= 128)
            || request.id.is_i64()
            || request.id.is_u64();
        if !valid_id || !request.params.is_object() {
            send(
                &responses,
                response(
                    Value::Null,
                    Err(Error::new(
                        ErrorCode::InvalidRequest,
                        "invalid request id or params",
                    )),
                ),
                &stop,
            );
            continue;
        }
        if request.method == "connection.open" {
            let result = if initialized {
                Err(Error::new(
                    ErrorCode::Conflict,
                    "connection is already initialized",
                ))
            } else {
                parse::<Open>(request.params).and_then(|open| {
                    if open.protocol_version != VERSION {
                        Err(Error::new(
                            ErrorCode::Unsupported,
                            "unsupported Runtime protocol version",
                        ))
                    } else {
                        initialized = true;
                        Ok(json!(runtime.connection_info()))
                    }
                })
            };
            send(&responses, response(request.id, result), &stop);
            continue;
        }
        if !initialized {
            send(
                &responses,
                response(
                    request.id,
                    Err(Error::new(
                        ErrorCode::Unauthenticated,
                        "connection.open is required",
                    )),
                ),
                &stop,
            );
            continue;
        }
        let key = request.id.to_string();
        if in_flight.lock().unwrap().contains(&key) {
            send(
                &responses,
                response(
                    request.id,
                    Err(Error::new(
                        ErrorCode::Conflict,
                        "request id is already in flight",
                    )),
                ),
                &stop,
            );
            continue;
        }
        if request.method == "connection.close" {
            if let Err(error) = parse::<Empty>(request.params) {
                send(&responses, response(request.id, Err(error)), &stop);
                continue;
            }
            close_id = Some(request.id);
            break;
        }
        // 控制与查询不占长等待许可，避免 process.wait 洪水阻止撤销。
        if let Some(result) = immediate(&runtime, &request.method, request.params.clone()) {
            send(&responses, response(request.id, result), &stop);
            continue;
        }
        let permit = match permits.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                send(
                    &responses,
                    response(
                        request.id,
                        Err(Error::new(
                            ErrorCode::ResourceExhausted,
                            "too many pending Runtime requests",
                        )),
                    ),
                    &stop,
                );
                continue;
            }
        };
        in_flight.lock().unwrap().insert(key.clone());
        let pending = in_flight.clone();
        let runtime = runtime.clone();
        let responses = responses.clone();
        let stop = stop.clone();
        requests.spawn(async move {
            let _permit = permit;
            let result = dispatch(runtime, &request.method, request.params).await;
            send(&responses, response(request.id, result), &stop);
            pending.lock().unwrap().remove(&key);
        });
    }
    let cleanup = host.shutdown().await;
    requests.close();
    requests.wait().await;
    if let Some(id) = close_id {
        send(
            &responses,
            response(id, cleanup.clone().map(|_| json!({"closed":true}))),
            &stop,
        );
    }
    drop(responses);
    let output = match tokio::time::timeout(Duration::from_secs(2), &mut writer).await {
        Ok(Ok(result)) => result,
        _ => {
            writer.abort();
            let _ = writer.await;
            Err(Error::new(
                ErrorCode::Unavailable,
                "Runtime response writer did not drain",
            ))
        }
    };
    cleanup?;
    output
}
fn parse<T: serde::de::DeserializeOwned>(params: Value) -> Result<T> {
    serde_json::from_value(params).map_err(|_| {
        Error::new(
            ErrorCode::InvalidArgument,
            "invalid, missing or unsupported parameters",
        )
    })
}
fn immediate(runtime: &Supervisor, method: &str, params: Value) -> Option<Result<Value>> {
    Some(match method {
        "scope.create" => parse(params)
            .and_then(|request| runtime.create_scope(request))
            .map(|v| json!(v)),
        "scope.get" => parse::<ScopeId>(params)
            .and_then(|p| runtime.scope(&p.scope_id))
            .map(|v| json!(v)),
        "scope.revoke" => parse::<ScopeId>(params)
            .and_then(|p| runtime.revoke(&p.scope_id))
            .map(|v| json!(v)),
        "owner.revoke" => parse(params)
            .and_then(|request| runtime.revoke_owner(request))
            .map(|v| json!(v)),
        "runtime.status" => parse::<Empty>(params).map(|_| runtime.status()),
        "process.get" => parse::<ProcessId>(params)
            .and_then(|p| runtime.process(&p.process_id))
            .map(|v| json!(v)),
        "process.terminate" => parse::<ProcessId>(params)
            .and_then(|p| runtime.terminate(&p.process_id))
            .map(|_| json!({"accepted":true})),
        "operation.get" => parse::<OperationId>(params)
            .and_then(|p| runtime.operation(&p.operation_id))
            .map(|v| json!(v)),
        "process.start" | "process.write" | "process.resize" | "process.closeStdin"
        | "scope.waitClosed" | "process.wait" | "output.read" | "fs.execute" => {
            return None;
        }
        _ => Err(Error::new(
            ErrorCode::Unsupported,
            "method is not in this Runtime's advertised capabilities",
        )),
    })
}
async fn dispatch(runtime: Arc<Supervisor>, method: &str, params: Value) -> Result<Value> {
    match method {
        "fs.execute" => runtime.filesystem(parse(params)?).await,
        "process.write" => runtime.write(parse(params)?).await,
        "process.resize" => runtime.resize(parse(params)?).await,
        "process.closeStdin" => runtime.close_stdin(parse(params)?).await,
        "process.start" => Ok(json!(runtime.start(parse(params)?).await?)),
        "scope.waitClosed" => Ok(json!(
            runtime
                .wait_closed(&parse::<ScopeId>(params)?.scope_id)
                .await?
        )),
        "process.wait" => Ok(json!(
            runtime
                .wait_process(&parse::<ProcessId>(params)?.process_id)
                .await?
        )),
        "output.read" => Ok(json!(runtime.output(parse(params)?).await?)),
        _ => Err(Error::new(
            ErrorCode::Unsupported,
            "method is not supported",
        )),
    }
}
fn response(id: Value, result: Result<Value>) -> Value {
    match result {
        Ok(result) => json!({"id":id,"result":result}),
        Err(error) => json!({"id":id,"error":error}),
    }
}
fn send(sender: &mpsc::Sender<Value>, response: Value, stop: &CancellationToken) {
    if sender.try_send(response).is_err() {
        stop.cancel();
    }
}
