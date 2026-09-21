//! Typed private-pipe client. Dropping a waiter never cancels an admitted RPC.
use areal_runtime_protocol::*;
use futures_util::StreamExt;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::Path,
    process::Stdio,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite, AsyncWriteExt},
    process::{Child, Command},
    sync::{mpsc, oneshot, watch},
    time::Instant,
};
use tokio_util::{
    codec::{FramedRead, LinesCodec},
    sync::CancellationToken,
};

const TIMEOUT: Duration = Duration::from_secs(90);
struct Pending {
    reply: oneshot::Sender<Result<Value>>,
    deadline: Instant,
}
struct Transport {
    writer: mpsc::Sender<Vec<u8>>,
    pending: Mutex<HashMap<u64, Pending>>,
    next: AtomicU64,
    stop: CancellationToken,
    stopped: watch::Sender<Option<Result<()>>>,
}
pub struct Client {
    transport: Arc<Transport>,
    info: ConnectionInfo,
    shutdown: OnceLock<watch::Receiver<Option<Result<()>>>>,
}

impl Client {
    pub async fn launch(
        binary: &Path,
        helper: &Path,
        workspace: &Path,
        writable: bool,
    ) -> Result<Arc<Self>> {
        Self::launch_with_limits(binary, helper, workspace, writable, &Limits::default()).await
    }

    /// Launch with trusted deployment ceilings, advertised back by the Runtime.
    pub async fn launch_with_limits(
        binary: &Path,
        helper: &Path,
        workspace: &Path,
        writable: bool,
        limits: &Limits,
    ) -> Result<Arc<Self>> {
        if limits.wall_time_ms == 0 || limits.output_bytes == 0 || limits.max_processes == 0 {
            return Err(Error::new(
                ErrorCode::InvalidArgument,
                "invalid Runtime limits",
            ));
        }
        // Use the same trusted Python parent as the local launcher on macOS.
        // Direct Rust-to-Rust spawning can be rejected by the host's AMFI before
        // main. Pipes still belong exclusively to this client and the Runtime.
        #[cfg(target_os = "macos")]
        let mut command = {
            let mut command = Command::new("/usr/bin/python3");
            command.args(["-I", "-S", "-c", "import subprocess,sys; p=subprocess.run(sys.argv[1:]); sys.exit(p.returncode if p.returncode>=0 else 128-p.returncode)"]);
            command.arg(binary);
            command
        };
        #[cfg(not(target_os = "macos"))]
        let mut command = Command::new(binary);
        command
            .arg("--file-helper")
            .arg(helper)
            .arg("--workspace")
            .arg(workspace)
            .arg("--wall-time-ms")
            .arg(limits.wall_time_ms.to_string())
            .arg("--output-bytes")
            .arg(limits.output_bytes.to_string())
            .arg("--max-processes")
            .arg(limits.max_processes.to_string())
            .current_dir(workspace)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        if writable {
            command.arg("--allow-write");
        }
        let mut child = command
            .spawn()
            .map_err(|_| unavailable("cannot launch Runtime"))?;
        Self::attach(
            child.stdout.take().unwrap(),
            child.stdin.take().unwrap(),
            Some(child),
        )
        .await
    }

    /// The caller must supply an exclusive, trusted transport to one Runtime.
    pub async fn connect<R, W>(read: R, write: W) -> Result<Arc<Self>>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        Self::attach(read, write, None).await
    }

    async fn attach<R, W>(read: R, write: W, mut child: Option<Child>) -> Result<Arc<Self>>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (writer, outgoing) = mpsc::channel(128);
        let transport = Arc::new(Transport {
            writer,
            pending: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            stop: CancellationToken::new(),
            stopped: watch::channel(None).0,
        });
        let owned = transport.clone();
        let startup_guard = transport.stop.clone().drop_guard();
        tokio::spawn(async move {
            let reason = {
                let read = read_loop(read, &owned);
                let write = write_loop(write, outgoing);
                let timer = async {
                    let mut interval = tokio::time::interval(Duration::from_millis(100));
                    loop {
                        interval.tick().await;
                        if owned
                            .pending
                            .lock()
                            .unwrap()
                            .values()
                            .any(|p| p.deadline <= Instant::now())
                        {
                            break;
                        }
                    }
                };
                tokio::pin!(read, write, timer);
                tokio::select! { _ = owned.stop.cancelled() => "Runtime client was closed".to_owned(), result = &mut read => result, result = &mut write => result, _ = &mut timer => "Runtime request deadline exceeded".to_owned() }
            };
            owned.stop.cancel();
            for (_, pending) in owned.pending.lock().unwrap().drain() {
                let _ = pending.reply.send(Err(unavailable(&format!(
                    "{reason}; outcome may be UNKNOWN; do not replay"
                ))));
            }
            let result = if let Some(child) = child.as_mut() {
                match tokio::time::timeout(Duration::from_secs(8), child.wait()).await {
                    Ok(Ok(status)) if status.success() => Ok(()),
                    other => {
                        if other.is_err() {
                            let _ = child.kill().await;
                        }
                        Err(Error::new(
                            ErrorCode::CleanupFailed,
                            format!("Runtime did not confirm a clean shutdown: {other:?}"),
                        ))
                    }
                }
            } else {
                Ok(())
            };
            owned.stopped.send_replace(Some(result));
        });
        let initialized = rpc(
            &transport,
            "connection.open",
            json!({"protocolVersion":VERSION}),
        )
        .await
        .and_then(|value| {
            serde_json::from_value::<ConnectionInfo>(value)
                .map_err(|_| unavailable("invalid Runtime handshake"))
        });
        match initialized {
            Ok(info) if info.protocol_version == VERSION => {
                startup_guard.disarm();
                Ok(Arc::new(Self {
                    transport,
                    info,
                    shutdown: OnceLock::new(),
                }))
            }
            result => {
                transport.stop.cancel();
                let error = result
                    .err()
                    .unwrap_or_else(|| unavailable("Runtime version mismatch"));
                if let Err(cleanup) = wait_stopped(&transport).await {
                    return Err(Error::new(
                        ErrorCode::CleanupFailed,
                        format!("{error}; {cleanup}"),
                    ));
                }
                Err(error)
            }
        }
    }
    pub fn info(&self) -> &ConnectionInfo {
        &self.info
    }
    pub fn is_closed(&self) -> bool {
        self.transport.stop.is_cancelled()
    }
    pub fn operation_id(&self) -> String {
        format!("{}:op:{}", self.info.runtime_epoch, uuid::Uuid::new_v4())
    }
    pub async fn call<P: Serialize, R: DeserializeOwned>(
        &self,
        method: &str,
        params: P,
    ) -> Result<R> {
        let params = serde_json::to_value(params)
            .map_err(|_| Error::new(ErrorCode::InvalidArgument, "invalid RPC arguments"))?;
        let mut timeout = rpc_timeout(method);
        if matches!(method, "fs.execute" | "process.start" | "process.wait")
            && let Some(wall) = self.info.capabilities["processLimits"]["wallTimeMs"].as_u64()
        {
            // A queued write/start and process.wait can last the full process
            // lifetime. The transport must not fence a valid long command.
            timeout = timeout.max(Duration::from_millis(wall).saturating_add(TIMEOUT));
        }
        let result = rpc_timed(&self.transport, method, params, timeout).await?;
        serde_json::from_value(result).map_err(|_| {
            self.transport.stop.cancel();
            unavailable("Runtime response violates its contract")
        })
    }
    pub async fn create_scope(&self, request: CreateScope) -> Result<ScopeInfo> {
        self.call("scope.create", request).await
    }
    pub async fn close_scope(&self, scope: &str) -> Result<ScopeInfo> {
        let _: ScopeInfo = self.call("scope.revoke", json!({"scopeId":scope})).await?;
        let deadline = Instant::now() + Duration::from_secs(12);
        loop {
            match self
                .call("scope.waitClosed", json!({"scopeId":scope}))
                .await
            {
                Err(error)
                    if error.code == ErrorCode::ResourceExhausted && Instant::now() < deadline =>
                {
                    tokio::time::sleep(Duration::from_millis(25)).await
                }
                result => return result,
            }
        }
    }
    pub async fn start(&self, request: StartProcess) -> Result<ProcessRef> {
        self.call("process.start", request).await
    }
    pub async fn output(&self, request: ReadOutput) -> Result<OutputPage> {
        self.call("output.read", request).await
    }
    pub async fn wait(&self, process: &str) -> Result<ProcessInfo> {
        self.call("process.wait", json!({"processId":process}))
            .await
    }
    pub async fn process(&self, process: &str) -> Result<ProcessInfo> {
        self.call("process.get", json!({"processId":process})).await
    }
    pub async fn terminate(&self, process: &str) -> Result<()> {
        let _: Value = self
            .call("process.terminate", json!({"processId":process}))
            .await?;
        Ok(())
    }
    pub async fn filesystem(&self, request: FileRequest) -> Result<Value> {
        self.call("fs.execute", request).await
    }
    pub async fn write(&self, request: ProcessInput) -> Result<Value> {
        self.call("process.write", request).await
    }
    pub async fn status(&self) -> Result<Value> {
        self.call("runtime.status", json!({})).await
    }
    pub async fn resize(&self, request: ResizeProcess) -> Result<Value> {
        self.call("process.resize", request).await
    }
    pub async fn close_stdin(&self, request: CloseStdin) -> Result<Value> {
        self.call("process.closeStdin", request).await
    }
    pub async fn shutdown(&self) -> Result<()> {
        // Own the close operation independently of any caller waiting for it.
        // An unexpected EOF is not evidence that the Runtime cleaned up.
        let mut done = self
            .shutdown
            .get_or_init(|| {
                let (done, received) = watch::channel(None);
                let transport = self.transport.clone();
                tokio::spawn(async move {
                    let closed = if transport.stop.is_cancelled() {
                        Err(unavailable(
                            "Runtime disconnected without a cleanup acknowledgement",
                        ))
                    } else {
                        rpc(&transport, "connection.close", json!({}))
                            .await
                            .and_then(|result| {
                                if result["closed"] == true {
                                    Ok(())
                                } else {
                                    Err(unavailable(
                                        "Runtime returned an invalid cleanup acknowledgement",
                                    ))
                                }
                            })
                    };
                    transport.stop.cancel();
                    let stopped = wait_stopped(&transport).await;
                    done.send_replace(Some(stopped.and(closed)));
                });
                received
            })
            .clone();
        loop {
            if let Some(result) = done.borrow().clone() {
                return result;
            }
            done.changed()
                .await
                .map_err(|_| unavailable("Runtime shutdown task lost"))?;
        }
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        self.transport.stop.cancel();
    }
}

fn unavailable(message: &str) -> Error {
    Error::new(ErrorCode::Unavailable, message)
}
async fn wait_stopped(transport: &Transport) -> Result<()> {
    let mut done = transport.stopped.subscribe();
    loop {
        if let Some(result) = done.borrow().clone() {
            return result;
        }
        done.changed()
            .await
            .map_err(|_| unavailable("Runtime shutdown acknowledgement lost"))?;
    }
}
async fn rpc(transport: &Transport, method: &str, params: Value) -> Result<Value> {
    rpc_timed(transport, method, params, rpc_timeout(method)).await
}
fn rpc_timeout(method: &str) -> Duration {
    if matches!(
        method,
        "fs.execute" | "process.start" | "process.wait" | "output.read"
    ) {
        TIMEOUT
    } else {
        Duration::from_secs(12)
    }
}
async fn rpc_timed(
    transport: &Transport,
    method: &str,
    params: Value,
    timeout: Duration,
) -> Result<Value> {
    let deadline = Instant::now().checked_add(timeout).ok_or_else(|| {
        Error::new(
            ErrorCode::InvalidArgument,
            "Runtime deadline exceeds clock range",
        )
    })?;
    let id = transport.next.fetch_add(1, Ordering::Relaxed);
    let mut bytes = serde_json::to_vec(&json!({"id":id,"method":method,"params":params})).unwrap();
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(Error::new(
            ErrorCode::InvalidArgument,
            "Runtime request exceeds frame limit",
        ));
    }
    bytes.push(b'\n');
    let (reply, received) = oneshot::channel();
    {
        let mut pending = transport.pending.lock().unwrap();
        if transport.stop.is_cancelled() {
            return Err(unavailable("Runtime is closed"));
        }
        let capacity = if matches!(
            method,
            "connection.open"
                | "connection.close"
                | "scope.get"
                | "scope.revoke"
                | "owner.revoke"
                | "process.terminate"
        ) {
            128
        } else {
            112
        };
        if pending.len() >= capacity {
            return Err(Error::new(
                ErrorCode::ResourceExhausted,
                "Runtime client RPC capacity reached",
            ));
        }
        pending.insert(id, Pending { reply, deadline });
        if transport.writer.try_send(bytes).is_err() {
            pending.remove(&id);
            return Err(unavailable("Runtime request was not queued"));
        }
    }
    received
        .await
        .map_err(|_| unavailable("Runtime response lost; do not replay"))?
}
async fn read_loop<R: AsyncRead + Unpin>(read: R, transport: &Transport) -> String {
    let mut lines = FramedRead::new(read, LinesCodec::new_with_max_length(MAX_FRAME_BYTES));
    while let Some(line) = lines.next().await {
        let line = match line {
            Ok(line) => line,
            Err(error) => return format!("Runtime response read failed: {error}"),
        };
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            return "Runtime returned invalid JSON".into();
        };
        let Some(id) = value["id"].as_u64() else {
            return "Runtime returned an invalid response ID".into();
        };
        if value.get("result").is_some() == value.get("error").is_some() {
            return "Runtime must return exactly one result or error".into();
        }
        let result = if let Some(error) = value.get("error") {
            let Ok(error) = serde_json::from_value::<Error>(error.clone()) else {
                return "Runtime returned an invalid error".into();
            };
            Err(error)
        } else {
            Ok(value["result"].clone())
        };
        let Some(pending) = transport.pending.lock().unwrap().remove(&id) else {
            return "Runtime returned an unknown response ID".into();
        };
        let _ = pending.reply.send(result);
    }
    "Runtime closed its response pipe".into()
}
async fn write_loop<W: AsyncWrite + Unpin>(
    mut write: W,
    mut outgoing: mpsc::Receiver<Vec<u8>>,
) -> String {
    while let Some(bytes) = outgoing.recv().await {
        if let Err(error) = write.write_all(&bytes).await {
            return format!("Runtime request write failed: {error}");
        }
        if let Err(error) = write.flush().await {
            return format!("Runtime request flush failed: {error}");
        }
    }
    "Runtime request queue was closed".into()
}
