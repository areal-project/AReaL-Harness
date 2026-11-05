//! Host 监督的 Node 工作台服务：私有通道、方法登记与反向调用。设计见 docs/design/workbench-service.md。
use anyhow::{Context, Result, bail, ensure};
use areal_local_service::native_process::{TrustedChild, TrustedCommand};
use futures_util::future::LocalBoxFuture;
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeSet, HashMap},
    os::fd::OwnedFd,
    path::Path,
    process::Stdio,
    rc::Rc,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    sync::oneshot,
};

/// 私有通道帧上限。Core 的长历史读结果会经反向调用回到服务，沿用桌面 Core 客户端的 64 MiB；
/// 交给客户端的结果仍受客户端协议 1 MiB 限制。
pub(crate) const MAX_FRAME: usize = 64 * 1024 * 1024;
const READY: Duration = Duration::from_secs(20);
const REQUEST: Duration = Duration::from_secs(30);

/// 服务向 Host 发起的调用（`core.request`、`vault.read`）；由 Host 决定是否允许。
pub(crate) type Reverse = Rc<dyn Fn(String, Value) -> LocalBoxFuture<'static, Result<Value>>>;

type Pending = Rc<RefCell<HashMap<u64, oneshot::Sender<Result<Value>>>>>;

pub(crate) struct Workbench {
    child: tokio::sync::Mutex<TrustedChild>,
    methods: BTreeSet<String>,
    pending: Pending,
    next: Cell<u64>,
    closed: Rc<Cell<bool>>,
    writer: Rc<tokio::sync::Mutex<Option<tokio::process::ChildStdin>>>,
}

/// 异常退出后的重启间隔；返回 None 表示停止重启并报告不可用。
pub(crate) fn restart_delay(recent_failures: u32) -> Option<Duration> {
    (recent_failures < 5).then(|| Duration::from_secs((1u64 << recent_failures.min(6)).min(60)))
}

impl Workbench {
    pub(crate) async fn start(
        runtime: &Path,
        runner: &Path,
        data: &Path,
        reverse: Reverse,
    ) -> Result<Self> {
        Ok(Self::start_with(runtime, runner, data, reverse, None)
            .await?
            .0)
    }

    /// 启动后先写一帧引导参数（桌面后台的启动选项），再等 `ready` 帧。
    /// 引导帧带方法名，返回的 `ready` 帧交给调用方读取服务身份。
    pub(crate) async fn start_with(
        runtime: &Path,
        runner: &Path,
        data: &Path,
        reverse: Reverse,
        bootstrap: Option<(&str, Value)>,
    ) -> Result<(Self, Value)> {
        let (reader, writer) = std::os::unix::net::UnixStream::pair()?;
        reader.set_nonblocking(true)?;
        let user_home = bootstrap
            .as_ref()
            .and_then(|(_, params)| params["options"]["userHome"].as_str())
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| data.to_path_buf());
        let mut command = TrustedCommand::supervised(runtime, &[])?;
        command
            .arg(runner)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", user_home)
            .env("AREAL_WORKBENCH_DATA", data)
            .env("TMPDIR", std::env::temp_dir())
            .env("ELECTRON_RUN_AS_NODE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::from(OwnedFd::from(writer)))
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        let mut child = command.spawn().await?;
        if let Some((method, params)) = bootstrap {
            let mut stdin = child.stdin.take().context("workbench stdin missing")?;
            write_frame(
                &mut stdin,
                &json!({"version":1,"method":method,"params":params}),
            )
            .await?;
            child.stdin = Some(stdin);
        }
        let mut lines = BufReader::new(tokio::net::UnixStream::from_std(reader)?);
        let ready = tokio::time::timeout(READY, read_frame(&mut lines))
            .await
            .context("workbench ready timed out")??
            .context("workbench exited before ready")?;
        ensure!(
            ready["version"] == 1 && ready["event"] == "ready",
            "invalid workbench ready frame"
        );
        let methods = ready["methods"]
            .as_array()
            .context("invalid workbench ready frame")?
            .iter()
            .map(|method| method.as_str().map(str::to_owned))
            .collect::<Option<BTreeSet<_>>>()
            .context("invalid workbench ready frame")?;
        let pending: Pending = Rc::default();
        let closed = Rc::new(Cell::new(false));
        let stdin = Rc::new(tokio::sync::Mutex::new(Some(
            child.stdin.take().context("workbench stdin missing")?,
        )));
        let workbench = Self {
            child: tokio::sync::Mutex::new(child),
            methods,
            pending: pending.clone(),
            next: Cell::new(0),
            closed: closed.clone(),
            writer: stdin.clone(),
        };
        tokio::task::spawn_local(async move {
            loop {
                let frame = match read_frame(&mut lines).await {
                    Ok(Some(frame)) => frame,
                    _ => break,
                };
                if frame["event"] == "pages.event" {
                    let _ = reverse("pages.event".into(), frame["params"].clone()).await;
                    continue;
                }
                if let Some(call) = frame["call"].as_str() {
                    let id = frame["id"].clone();
                    let reply = reverse(call.to_owned(), frame["params"].clone());
                    let stdin = stdin.clone();
                    tokio::task::spawn_local(async move {
                        let body = match reply.await {
                            Ok(result) => json!({"version":1,"id":id,"result":result}),
                            Err(error) => {
                                json!({"version":1,"id":id,"error":{"code":crate::server::error_code(&error.to_string()),"message":"Host call failed"}})
                            }
                        };
                        if let Some(stdin) = stdin.lock().await.as_mut() {
                            let _ = write_frame(stdin, &body).await;
                        }
                    });
                    continue;
                }
                let Some(sender) = frame["id"]
                    .as_u64()
                    .and_then(|id| pending.borrow_mut().remove(&id))
                else {
                    continue;
                };
                let _ = sender.send(match frame.get("error") {
                    Some(error) => Err(anyhow::anyhow!(
                        "{}",
                        crate::server::error_code(
                            error["code"].as_str().unwrap_or("CORE_UNAVAILABLE")
                        )
                    )),
                    None => Ok(frame["result"].clone()),
                });
            }
            closed.set(true);
            for (_, sender) in pending.borrow_mut().drain() {
                let _ = sender.send(Err(anyhow::anyhow!("CAPABILITY_UNAVAILABLE")));
            }
        });
        Ok((workbench, ready))
    }

    #[cfg(test)]
    pub(crate) fn methods(&self) -> &BTreeSet<String> {
        &self.methods
    }

    pub(crate) fn closed(&self) -> bool {
        self.closed.get()
    }

    /// Host 推给服务的事件（如 Core 通知）；服务不回复，写不进去就丢弃。
    pub(crate) async fn notify(&self, event: &str, body: Value) {
        if self.closed.get() {
            return;
        }
        let mut frame = json!({"version":1,"event":event});
        if let (Some(frame), Value::Object(body)) = (frame.as_object_mut(), body) {
            frame.extend(body);
        }
        if let Some(stdin) = self.writer.lock().await.as_mut() {
            let _ = write_frame(stdin, &frame).await;
        }
    }

    /// 授权与回执已在 Host 完成；服务只拿到已验证的 context。
    pub(crate) async fn request(
        &self,
        method: &str,
        params: Value,
        context: Value,
    ) -> Result<Value> {
        if self.closed.get() {
            bail!("CAPABILITY_UNAVAILABLE");
        }
        ensure!(self.methods.contains(method), "methodNotFound");
        let id = self.next.get() + 1;
        self.next.set(id);
        let (sender, receiver) = oneshot::channel();
        self.pending.borrow_mut().insert(id, sender);
        let frame = json!({"version":1,"id":id,"method":method,"params":params,"context":context});
        let written = match self.writer.lock().await.as_mut() {
            Some(stdin) => write_frame(stdin, &frame).await.is_ok(),
            None => false,
        };
        if !written {
            self.pending.borrow_mut().remove(&id);
            bail!("CAPABILITY_UNAVAILABLE");
        }
        match tokio::time::timeout(REQUEST, receiver).await {
            Ok(Ok(result)) => result,
            _ => {
                self.pending.borrow_mut().remove(&id);
                bail!("CORE_UNAVAILABLE")
            }
        }
    }

    /// 关闭标准输入让服务自行退出，超时后强制结束。
    pub(crate) async fn stop(&self) -> Result<()> {
        self.writer.lock().await.take();
        let mut child = self.child.lock().await;
        if tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .is_err()
        {
            child.kill().await?;
        }
        Ok(())
    }
}

async fn read_frame(lines: &mut BufReader<tokio::net::UnixStream>) -> Result<Option<Value>> {
    let mut line = Vec::new();
    let read = lines
        .take(MAX_FRAME as u64 + 1)
        .read_until(b'\n', &mut line)
        .await?;
    if read == 0 {
        return Ok(None);
    }
    ensure!(
        line.len() <= MAX_FRAME && line.ends_with(b"\n"),
        "workbench frame too large"
    );
    Ok(Some(serde_json::from_slice(&line)?))
}

async fn write_frame(stdin: &mut tokio::process::ChildStdin, frame: &Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(frame)?;
    ensure!(bytes.len() < MAX_FRAME, "LIMIT_EXCEEDED");
    bytes.push(b'\n');
    stdin.write_all(&bytes).await?;
    stdin.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node() -> Option<std::path::PathBuf> {
        [
            "/opt/node22/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
            "/opt/homebrew/bin/node",
        ]
        .into_iter()
        .map(std::path::PathBuf::from)
        .find(|path| path.is_file())
    }

    const RUNNER: &str = r#"
const readline = require("node:readline");
const out = (frame) => process.stdout.write(JSON.stringify({ version: 1, ...frame }) + "\n");
out({ event: "ready", methods: ["library.read", "library.crash"] });
const calls = new Map();
let next = 0;
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const frame = JSON.parse(line);
  if (frame.method === undefined) return calls.get(frame.id)?.(frame);
  if (frame.method === "library.crash") process.exit(3);
  const id = `w${++next}`;
  const reply = await new Promise((resolve) => {
    calls.set(id, resolve);
    out({ id, call: "core.request", params: { projectId: frame.context.projectId } });
  });
  out({ id: frame.id, result: { echo: frame.params, core: reply.result ?? reply.error } });
});
"#;

    #[tokio::test(flavor = "current_thread")]
    async fn routes_requests_and_reverse_calls_and_reports_exit() {
        let Some(node) = node() else { return };
        tokio::task::LocalSet::new()
            .run_until(async {
                let root = tempfile::tempdir().unwrap();
                let runner = root.path().join("runner.cjs");
                std::fs::write(&runner, RUNNER).unwrap();
                let calls: Rc<RefCell<Vec<(String, Value)>>> = Rc::default();
                let seen = calls.clone();
                let reverse: Reverse = Rc::new(move |call, params| {
                    seen.borrow_mut().push((call.clone(), params.clone()));
                    Box::pin(async move {
                        ensure!(call == "core.request", "FORBIDDEN");
                        Ok(json!({"project":params["projectId"]}))
                    })
                });
                let workbench = Workbench::start(&node, &runner, root.path(), reverse)
                    .await
                    .unwrap();
                assert!(workbench.methods().contains("library.read"));
                let result = workbench
                    .request("library.read", json!({"q":1}), json!({"projectId":"p"}))
                    .await
                    .unwrap();
                assert_eq!(result, json!({"echo":{"q":1},"core":{"project":"p"}}));
                assert_eq!(calls.borrow()[0].0, "core.request");
                assert_eq!(
                    workbench
                        .request("library.write", json!({}), json!({}))
                        .await
                        .unwrap_err()
                        .to_string(),
                    "methodNotFound"
                );
                let crashed = workbench
                    .request("library.crash", json!({}), json!({}))
                    .await
                    .unwrap_err();
                assert_eq!(crashed.to_string(), "CAPABILITY_UNAVAILABLE");
                assert_eq!(
                    workbench
                        .request("library.read", json!({}), json!({}))
                        .await
                        .unwrap_err()
                        .to_string(),
                    "CAPABILITY_UNAVAILABLE"
                );
                workbench.stop().await.unwrap();
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn starts_the_shipped_service_entry() {
        let Some(node) = node() else { return };
        tokio::task::LocalSet::new()
            .run_until(async {
                let root = tempfile::tempdir().unwrap();
                let runner = Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../services/workbench/src/main.cjs")
                    .canonicalize()
                    .unwrap();
                let reverse: Reverse = Rc::new(|_, _| Box::pin(async { bail!("FORBIDDEN") }));
                let workbench = Workbench::start(&node, &runner, root.path(), reverse)
                    .await
                    .unwrap();
                assert!(workbench.methods().contains("analytics.read"));
                let turn = json!({"id":"t1","usage":{"inputTokens":4,"outputTokens":1,"cachedInputTokens":0}});
                workbench
                    .notify(
                        "core.event",
                        json!({"projectId":"p","method":"turn/completed","params":{"threadId":"a","turn":turn}}),
                    )
                    .await;
                let summary = workbench
                    .request("analytics.read", json!({}), json!({}))
                    .await
                    .unwrap();
                assert_eq!(summary["tokens"], 5);
                assert_eq!(summary["undatedTokens"], 0);
                workbench.stop().await.unwrap();
                let saved: Value = serde_json::from_slice(
                    &std::fs::read(root.path().join("analytics.json")).unwrap(),
                )
                .unwrap();
                assert_eq!(saved["turns"]["[\"p\",\"a\",\"t1\"]"]["usage"]["inputTokens"], 4);
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn bootstrap_frame_arrives_before_ready_and_is_reported() {
        let Some(node) = node() else { return };
        const BOOTSTRAP: &str = r#"
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.method !== "backend.start") process.exit(4);
  process.stdout.write(
    JSON.stringify({ version: 1, event: "ready", methods: [], service: { pid: 7, identity: frame.params.appRoot } }) + "\n",
  );
});
lines.on("close", () => process.exit(0));
"#;
        tokio::task::LocalSet::new()
            .run_until(async {
                let root = tempfile::tempdir().unwrap();
                let runner = root.path().join("backend-runner.cjs");
                std::fs::write(&runner, BOOTSTRAP).unwrap();
                let reverse: Reverse = Rc::new(|_, _| Box::pin(async { bail!("FORBIDDEN") }));
                let (workbench, ready) = Workbench::start_with(
                    &node,
                    &runner,
                    root.path(),
                    reverse,
                    Some(("backend.start", json!({"appRoot":"approot"}))),
                )
                .await
                .unwrap();
                assert!(workbench.methods().is_empty());
                assert_eq!(ready["service"]["identity"], "approot");
                workbench.stop().await.unwrap();
            })
            .await;
    }

    #[test]
    fn restart_backs_off_then_gives_up() {
        let delays: Vec<_> = (0..6).map(restart_delay).collect();
        assert_eq!(
            delays,
            [1, 2, 4, 8, 16]
                .into_iter()
                .map(|s| Some(Duration::from_secs(s)))
                .chain([None])
                .collect::<Vec<_>>()
        );
    }
}
