//! Host 到工作台服务的路由：懒启动、退避重启、反向调用与 Core 事件转发。设计见 docs/design/workbench-service.md。
use super::Host;
use crate::workbench::{Reverse, Workbench, restart_delay};
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    path::{Path, PathBuf},
    rc::{Rc, Weak},
    time::{Duration, Instant},
};

/// 服务实现、Host 转发的方法。目前只给本机桌面主体；远程设备跨项目统计需单独授权，暂不开放。
pub(super) const METHODS: &[&str] = &[
    "analytics.activity",
    "analytics.import",
    "analytics.read",
    "analytics.sync",
    "library.command",
    "worktree.read",
    "tasks.read",
    "trajectory.read",
    "trajectory.command",
    "feedback.read",
    "feedback.command",
    "manage.read",
    "manage.command",
    "providers.read",
    "providers.command",
    "worktree.command",
    "pages.command",
    "pages.resource",
    "desktop.command",
];
/// 服务经 `core.request` 可调用的 Core 方法：只读。
const CORE_METHODS: &[&str] = &["thread/list", "thread/read"];
/// manage 里会推动执行的管理写操作。manage 能力只表示“能管理本机后台”，
/// 不能顺带成为提交、审批或中断的旁路，因此这些操作另需 submit。
const MANAGE_SUBMIT_OPERATIONS: &[&str] = &[
    "contextCompact",
    "processCloseStdin",
    "processResize",
    "processStart",
    "processTerminate",
    "processWrite",
    "taskRunNow",
    "taskResumeRun",
];
/// 会停止在途工作的管理写操作；停与做分开授权。
const MANAGE_INTERRUPT_OPERATIONS: &[&str] = &["executionCancel", "taskStopRun", "workgroupCancel"];

/// 该 manage 请求除 manage 之外还要的能力。其余管理操作只需 manage。
pub(super) fn manage_capability(method: &str, params: &Value) -> Option<&'static str> {
    if method != "manage.command" {
        return None;
    }
    let operation = params.get("operation")?.as_str()?;
    if MANAGE_SUBMIT_OPERATIONS.contains(&operation) {
        return Some("submit");
    }
    MANAGE_INTERRUPT_OPERATIONS
        .contains(&operation)
        .then_some("interrupt")
}
/// 转给服务的 Core 通知。
const EVENTS: &[&str] = &["turn/started", "turn/completed", "item/completed"];
const FAILURE_WINDOW: Duration = Duration::from_secs(600);

#[derive(Default)]
pub(super) struct Supervisor {
    running: RefCell<Option<Rc<Workbench>>>,
    starting: tokio::sync::Mutex<()>,
    failures: RefCell<Vec<Instant>>,
    stopped: Cell<bool>,
    /// 桌面后台：界面 Main 原来在进程内启动的 CoreBackend + DesktopService，改由 Host 监督。
    backend: Backend,
    page_events: RefCell<Option<tokio::sync::broadcast::Sender<Value>>>,
}

#[derive(Default)]
pub(super) struct Backend {
    running: RefCell<Option<Rc<Workbench>>>,
    starting: tokio::sync::Mutex<()>,
    failures: RefCell<Vec<Instant>>,
    stopped: Cell<bool>,
    /// 已启动后台的项目 profile 与服务身份（不含票据），供 Main 核对所有权。
    ownership: RefCell<Option<(String, Value)>>,
    source: RefCell<Option<String>>,
}

/// Main 传来的桌面后台启动参数。`options` 是界面 Main 的启动选项，Host 只读取并校验路径字段：
/// 数据目录仍是原 GUI home，不搬家。`appRoot` 由 Host 从已签名安装包推导，不接受客户端指定。
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Ensure {
    profile: PathBuf,
    options: Value,
}

/// 服务入口与运行时。打包后在已签名应用的 `Resources/areal-workbench`，用应用自带的 Electron。
pub(super) struct Entry {
    pub runtime: PathBuf,
    pub runner: PathBuf,
}

/// 源码验收用仓库相邻的服务和 Node；发行包仍只接受签名清单。
fn source_entry(bin: &Path, runner: &str) -> Option<Entry> {
    if !cfg!(debug_assertions)
        || bin.file_name()? != "debug"
        || bin.parent()?.file_name()? != "target"
    {
        return None;
    }
    let root = bin.join("../../services/workbench").canonicalize().ok()?;
    let runner = root.join("src").join(runner);
    if !runner.is_file() || !root.join("package.json").is_file() {
        return None;
    }
    let runtime = std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|path| path.join("node"))
        .find_map(|path| path.is_file().then(|| path.canonicalize().ok()).flatten())?;
    Some(Entry { runtime, runner })
}

pub(super) async fn discover(bin: &Path) -> Result<Entry> {
    if let Some(entry) = source_entry(bin, "main.cjs") {
        return Ok(entry);
    }
    let bundle = crate::local_relay::discover_bundle(
        bin,
        "areal-workbench",
        "src/main.cjs",
        &["src/main.cjs", "src/channel.cjs"],
        "CAPABILITY_UNAVAILABLE",
    )
    .await?;
    Ok(Entry {
        runtime: bundle.runtime,
        runner: bundle.runner,
    })
}

/// 桌面后台入口：同一个工作台资源包里的 `src/backend-main.cjs`，仍用应用自带的 Electron。
pub(super) async fn discover_backend(bin: &Path) -> Result<Entry> {
    if let Some(entry) = source_entry(bin, "backend-main.cjs") {
        return Ok(entry);
    }
    let bundle = crate::local_relay::discover_bundle(
        bin,
        "areal-workbench",
        "src/backend-main.cjs",
        &["src/backend-main.cjs", "src/channel.cjs"],
        "CAPABILITY_UNAVAILABLE",
    )
    .await?;
    Ok(Entry {
        runtime: bundle.runtime,
        runner: bundle.runner,
    })
}

/// 复用已发布 source 的项目绑定；Host ID 与后台 alias 从不按字符串或路径猜测。
fn backend_project_alias(host: &Host, source: &str, project: &str) -> Result<String> {
    let registrations: Vec<_> = host
        .slots
        .borrow()
        .values()
        .map(|slot| slot.registration.clone())
        .collect();
    let mut aliases = host
        .migration
        .remote_bindings(source, &registrations)?
        .into_iter()
        .filter(|(id, _)| id == project);
    let (_, alias) = aliases.next().context("RESOURCE_UNAVAILABLE")?;
    ensure!(aliases.next().is_none(), "RESYNC_REQUIRED");
    Ok(alias)
}

/// 只存在于当前请求的准备句柄；journal 只保存 Core 参数，不保存可重放句柄。
pub(super) struct PreparedExecution {
    backend: Rc<Workbench>,
    connection: String,
    handle: String,
    pub params: Value,
    pub source: String,
    dispatched: bool,
}
impl PreparedExecution {
    pub(super) async fn dispatch(&mut self) -> Result<Value> {
        ensure!(!self.dispatched, "SUBMISSION_UNKNOWN");
        self.dispatched = true;
        let value = self
            .backend
            .request(
                "execution.dispatch",
                json!({"handle":self.handle}),
                json!({"connection":self.connection}),
            )
            .await?;
        if let Some(error) = value.get("error") {
            ensure!(error["code"].as_i64().is_some(), "INVALID_RESPONSE");
            return Err(crate::server::schedule_connection::RpcFailure(error.clone()).into());
        }
        value.get("result").cloned().context("INVALID_RESPONSE")
    }
}
impl Drop for PreparedExecution {
    fn drop(&mut self) {
        if self.dispatched {
            return;
        }
        let backend = self.backend.clone();
        let params = json!({"connection":self.connection,"handle":self.handle});
        tokio::task::spawn_local(async move {
            backend.notify("execution.cancel", params).await;
        });
    }
}

impl Supervisor {
    pub(super) fn backend_has_source(&self, source: &str) -> bool {
        self.backend.source.borrow().as_deref() == Some(source)
    }

    pub(super) async fn prepare_execution(
        &self,
        host: &Rc<Host>,
        connection: &str,
        project: &str,
        method: &str,
        mut params: Value,
    ) -> Result<Option<PreparedExecution>> {
        // 拉不起后台时按没有桌面后台处理，不挡住不需要桌面工具的提交。
        let _ = self.resume_backend(host).await;
        let Some(source) = self.backend.source.borrow().clone() else {
            return Ok(None);
        };
        let alias = backend_project_alias(host, &source, project)?;
        if method == "workbench/thread/create" {
            params["projectId"] = json!(alias);
        }
        let scope = host.schedules.connections.shared_identity(host, project)?;
        let backend = self
            .backend
            .running
            .borrow()
            .clone()
            .context("CAPABILITY_UNAVAILABLE")?;
        ensure!(!backend.closed(), "CAPABILITY_UNAVAILABLE");
        let response = backend.request("execution.prepare",
            json!({"projectId":alias,"call":{"method":method,"params":params},"coreInstanceId":scope.0,"coreGeneration":scope.1}),
            json!({"connection":connection}),
        ).await?;
        let result = PreparedExecution {
            backend: backend.clone(),
            connection: connection.to_owned(),
            handle: response["handle"]
                .as_str()
                .filter(|value| !value.is_empty() && value.len() <= 128)
                .context("INVALID_RESPONSE")?
                .to_owned(),
            params: response["call"]["params"].clone(),
            source: source.clone(),
            dispatched: false,
        };
        ensure!(response["call"]["method"] == method, "INVALID_RESPONSE");
        ensure!(
            self.backend.source.borrow().as_deref() == Some(source.as_str())
                && backend_project_alias(host, &source, project)? == alias
                && host.schedules.connections.shared_identity(host, project)? == scope
                && self
                    .backend
                    .running
                    .borrow()
                    .as_ref()
                    .is_some_and(|current| Rc::ptr_eq(current, &backend))
                && !backend.closed()
                && result.params.is_object(),
            "RESYNC_REQUIRED"
        );
        ensure!(
            serde_json::to_vec(&result.params)?.len() <= 704 * 1024,
            "LIMIT_EXCEEDED"
        );
        Ok(Some(result))
    }

    pub(super) async fn creation_catalog(
        &self,
        host: &Rc<Host>,
        project: &str,
    ) -> Result<Option<Value>> {
        // 拉不起后台时按没有桌面后台处理，不挡住不需要桌面工具的提交。
        let _ = self.resume_backend(host).await;
        let Some(source) = self.backend.source.borrow().clone() else {
            return Ok(None);
        };
        // 不在桌面资料库里的项目（如 `areal host ensure` 登记的）由 Core 自己的模型目录回答。
        let alias = match backend_project_alias(host, &source, project) {
            Err(error) if error.to_string() == "RESOURCE_UNAVAILABLE" => return Ok(None),
            alias => alias?,
        };
        let backend = self
            .backend
            .running
            .borrow()
            .clone()
            .context("CAPABILITY_UNAVAILABLE")?;
        let result = backend
            .request("creation.catalog", json!({"projectId":alias}), json!({}))
            .await?;
        ensure!(
            self.backend.source.borrow().as_deref() == Some(source.as_str())
                && self
                    .backend
                    .running
                    .borrow()
                    .as_ref()
                    .is_some_and(|current| Rc::ptr_eq(current, &backend))
                && backend_project_alias(host, &source, project)? == alias,
            "RESYNC_REQUIRED"
        );
        ensure!(
            result["models"].is_array() && result["profiles"].is_array(),
            "INVALID_RESPONSE"
        );
        Ok(Some(result))
    }

    pub(super) async fn read_creation(
        &self,
        host: &Rc<Host>,
        project: &str,
        source: &str,
        params: &Value,
    ) -> Result<Value> {
        ensure!(
            self.backend.source.borrow().as_deref() == Some(source),
            "RESYNC_REQUIRED"
        );
        let alias = backend_project_alias(host, source, project)?;
        ensure!(params["projectId"] == alias, "RESYNC_REQUIRED");
        let backend = self
            .backend
            .running
            .borrow()
            .clone()
            .context("CAPABILITY_UNAVAILABLE")?;
        let mut result = backend
            .request(
                "creation.read",
                json!({"projectId":alias,"request":params}),
                json!({}),
            )
            .await?;
        ensure!(
            self.backend.source.borrow().as_deref() == Some(source)
                && self
                    .backend
                    .running
                    .borrow()
                    .as_ref()
                    .is_some_and(|current| Rc::ptr_eq(current, &backend))
                && backend_project_alias(host, source, project)? == alias,
            "RESYNC_REQUIRED"
        );
        if result["state"] == "ready" {
            let execution = result["executionProjectId"]
                .as_str()
                .context("INVALID_RESPONSE")?;
            let registrations: Vec<_> = host
                .slots
                .borrow()
                .values()
                .map(|slot| slot.registration.clone())
                .collect();
            let matches: Vec<_> = host
                .migration
                .remote_bindings(source, &registrations)?
                .into_iter()
                .filter(|(_, alias)| alias == execution)
                .collect();
            ensure!(matches.len() == 1, "RESOURCE_UNAVAILABLE");
            result["executionProjectId"] = json!(matches[0].0);
        }
        Ok(result)
    }

    /// 仅已绑定桌面后台的 Host 输入使用该私有投影；故障不能退回遗漏状态的输入。
    pub(super) async fn prepare_input(
        &self,
        host: &Rc<Host>,
        project: &str,
        thread: &str,
        text: &str,
    ) -> Result<String> {
        let source = self.backend.source.borrow().clone();
        if source.is_none() {
            return Ok(text.to_owned());
        }
        let backend = self
            .backend
            .running
            .borrow()
            .clone()
            .context("CAPABILITY_UNAVAILABLE")?;
        ensure!(!backend.closed(), "CAPABILITY_UNAVAILABLE");
        let alias = backend_project_alias(host, source.as_deref().unwrap(), project)?;
        let params = areal_protocol::host::WorkbenchInputPrepareParams {
            project_id: alias.clone(),
            thread_id: thread.to_owned(),
            text: text.to_owned(),
        };
        let result = backend
            .request("input.prepare", serde_json::to_value(params)?, json!({}))
            .await?;
        ensure!(
            *self.backend.source.borrow() == source
                && backend_project_alias(host, source.as_deref().unwrap(), project)? == alias
                && self
                    .backend
                    .running
                    .borrow()
                    .as_ref()
                    .is_some_and(|current| Rc::ptr_eq(current, &backend))
                && !backend.closed(),
            "RESYNC_REQUIRED"
        );
        let result: areal_protocol::host::WorkbenchInputPrepareResult =
            serde_json::from_value(result).context("INVALID_RESPONSE")?;
        ensure!(result.text.len() <= 512 * 1024, "LIMIT_EXCEEDED");
        Ok(result.text)
    }

    #[cfg(test)]
    pub(crate) fn bind_test_backend(&self, backend: Workbench, source: &str) {
        *self.backend.running.borrow_mut() = Some(Rc::new(backend));
        *self.backend.source.borrow_mut() = Some(source.into());
    }

    pub(super) async fn request(
        &self,
        host: &Rc<Host>,
        method: &str,
        params: Value,
        context: Value,
    ) -> Result<Value> {
        ensure!(METHODS.contains(&method), "methodNotFound");
        if matches!(
            method,
            "library.command"
                | "worktree.read"
                | "worktree.command"
                | "tasks.read"
                | "trajectory.read"
                | "trajectory.command"
                | "feedback.read"
                | "feedback.command"
                | "manage.read"
                | "manage.command"
                | "providers.read"
                | "providers.command"
                | "pages.command"
                | "pages.resource"
                | "desktop.command"
        ) {
            let backend = self
                .backend
                .running
                .borrow()
                .clone()
                .context("CAPABILITY_UNAVAILABLE")?;
            ensure!(!backend.closed(), "CAPABILITY_UNAVAILABLE");
            return backend.request(method, params, context).await;
        }
        let workbench = self.running(host).await?;
        workbench.request(method, params, context).await
    }

    /// Core 通知只在服务已运行时转发；服务未启动不为此拉起。
    pub(super) fn core_event(&self, project_id: &str, event: &Value) {
        if !event["method"]
            .as_str()
            .is_some_and(|m| EVENTS.contains(&m))
        {
            return;
        }
        let Some(workbench) = self.running.borrow().clone() else {
            return;
        };
        let body =
            json!({"projectId":project_id,"method":event["method"],"params":event["params"]});
        tokio::task::spawn_local(async move { workbench.notify("core.event", body).await });
    }

    pub(super) async fn stop(&self) {
        self.stopped.set(true);
        let _guard = self.starting.lock().await;
        let running = self.running.borrow_mut().take();
        if let Some(workbench) = running {
            let _ = workbench.stop().await;
        }
    }

    /// 启动或复用桌面后台，返回它的身份（不含票据）。
    pub(super) async fn ensure_backend(&self, host: &Rc<Host>, input: Ensure) -> Result<Value> {
        self.backend.ensure(host, input).await.map_err(|error| {
            if error.to_string() == "CAPABILITY_UNAVAILABLE" {
                crate::wire::error("CAPABILITY_UNAVAILABLE", "后台尚不可用，请按退避恢复连接")
            } else {
                error
            }
        })
    }

    /// 本机网页需要后台而它没在运行时（Host 重启、桌面窗口已关），按桌面上次接受的参数重新拉起。
    /// 参数只含路径，重新走与 `backend.ensure` 相同的校验；从没开过桌面时保持不可用。
    pub(super) async fn resume_backend(&self, host: &Rc<Host>) -> Result<()> {
        if self
            .backend
            .running
            .borrow()
            .as_ref()
            .is_some_and(|backend| !backend.closed())
        {
            return Ok(());
        }
        let Some(input) =
            areal_local_service::storage::read_optional::<Ensure>(&launch_record(host))?
        else {
            return Ok(());
        };
        self.ensure_backend(host, input).await.map(|_| ())
    }

    /// 当前桌面后台的所有权：Main 用它区分“Host 监督的本机后台”和旧应用会话遗留的后台。
    pub(super) async fn backend_status(&self, host: &Rc<Host>) -> Result<Value> {
        self.backend.status(host)
    }

    pub(super) async fn stop_backend(&self) {
        self.backend.stop().await;
    }

    pub(super) fn page_events(&self) -> tokio::sync::broadcast::Receiver<Value> {
        self.page_events
            .borrow_mut()
            .get_or_insert_with(|| tokio::sync::broadcast::channel(32).0)
            .subscribe()
    }

    pub(super) fn disconnect_pages(&self, connection: &str) {
        let Some(backend) = self.backend.running.borrow().clone() else {
            return;
        };
        let connection = connection.to_owned();
        tokio::task::spawn_local(async move {
            backend
                .notify("pages.disconnect", json!({"connection":connection}))
                .await;
        });
    }

    async fn running(&self, host: &Rc<Host>) -> Result<Rc<Workbench>> {
        let _guard = self.starting.lock().await;
        ensure!(!self.stopped.get(), "CAPABILITY_UNAVAILABLE");
        let current = self.running.borrow().clone();
        if let Some(workbench) = current {
            if !workbench.closed() {
                return Ok(workbench);
            }
            self.running.borrow_mut().take();
            self.failures.borrow_mut().push(Instant::now());
        }
        self.admit()?;
        match self.start(host).await {
            Ok(workbench) => {
                let workbench = Rc::new(workbench);
                *self.running.borrow_mut() = Some(workbench.clone());
                Ok(workbench)
            }
            Err(_) => {
                self.failures.borrow_mut().push(Instant::now());
                bail!("CAPABILITY_UNAVAILABLE")
            }
        }
    }

    /// 10 分钟内失败 5 次后不再自动重启；之前按 1、2、4… 秒退避，未到时间直接报不可用。
    fn admit(&self) -> Result<()> {
        let mut failures = self.failures.borrow_mut();
        failures.retain(|time| time.elapsed() < FAILURE_WINDOW);
        let Some(last) = failures.last() else {
            return Ok(());
        };
        ensure!(failures.len() < 5, "CAPABILITY_UNAVAILABLE");
        let delay = restart_delay(failures.len() as u32 - 1).context("CAPABILITY_UNAVAILABLE")?;
        ensure!(last.elapsed() >= delay, "CAPABILITY_UNAVAILABLE");
        Ok(())
    }

    async fn start(&self, host: &Rc<Host>) -> Result<Workbench> {
        let entry = discover(&host.bin).await?;
        let data = host.home.join("workbench");
        areal_local_service::storage::private_dir(&data)?;
        Workbench::start(&entry.runtime, &entry.runner, &data, reverse(host)).await
    }
}

/// 跨项目写复用 Host journal。受理后没有可证明的结果就保持 UNKNOWN，重复请求只读原回执。
pub(super) fn backend_receipt(
    host: &Host,
    principal: &str,
    command: &str,
) -> Result<Option<Value>> {
    let command = uuid::Uuid::parse_str(command)
        .context("INVALID_PARAMS")?
        .to_string();
    let (_, snapshot) = host.journal.native_snapshot(&format!(
        "workbench-{}",
        areal_local_service::storage::digest(principal.as_bytes())
    ))?;
    Ok(snapshot["outcomes"].get(&command).cloned().or_else(|| {
        snapshot["pending"]
            .as_array()?
            .iter()
            .find(|row| row["requestId"] == command)
            .map(|row| row["result"].clone())
    }))
}

pub(super) async fn backend_command(
    host: &Rc<Host>,
    principal: &str,
    request: &Value,
) -> Result<Value> {
    let command = request["commandId"].as_str().context("INVALID_PARAMS")?;
    let command = uuid::Uuid::parse_str(command)
        .context("INVALID_PARAMS")?
        .to_string();
    let method = request["method"].as_str().context("INVALID_PARAMS")?;
    let params = match method {
        "library.command" => serde_json::to_value(
            serde_json::from_value::<areal_protocol::host::WorkbenchLibraryParams>(
                request["params"].clone(),
            )
            .context("INVALID_PARAMS")?,
        )?,
        "worktree.command" => serde_json::to_value(
            serde_json::from_value::<areal_protocol::host::WorkbenchWorktreeCommandParams>(
                request["params"].clone(),
            )
            .context("INVALID_PARAMS")?,
        )?,
        "trajectory.command" => serde_json::to_value(
            serde_json::from_value::<areal_protocol::host::WorkbenchTrajectoryCommandParams>(
                request["params"].clone(),
            )
            .context("INVALID_PARAMS")?,
        )?,
        "feedback.command" => serde_json::to_value(
            serde_json::from_value::<areal_protocol::host::WorkbenchFeedbackCommandParams>(
                request["params"].clone(),
            )
            .context("INVALID_PARAMS")?,
        )?,
        "providers.command" => serde_json::to_value(
            serde_json::from_value::<areal_protocol::host::WorkbenchProviderCommandParams>(
                request["params"].clone(),
            )
            .context("INVALID_PARAMS")?,
        )?,
        "manage.command" => serde_json::to_value(
            serde_json::from_value::<areal_protocol::host::WorkbenchManageCommandParams>(
                request["params"].clone(),
            )
            .context("INVALID_PARAMS")?,
        )?,
        _ => bail!("methodNotFound"),
    };
    let digest =
        areal_local_service::storage::digest(&serde_json::to_vec(&json!([method, params]))?);
    if let Some(mut original) = backend_receipt(host, principal, &command)? {
        ensure!(original["semanticDigest"] == digest, "COMMAND_CONFLICT");
        original.as_object_mut().unwrap().remove("semanticDigest");
        return Ok(original);
    }
    host.admission()?;
    host.gateway.workbench.resume_backend(host).await?;
    let backend = host
        .gateway
        .workbench
        .backend
        .running
        .borrow()
        .clone()
        .context("CAPABILITY_UNAVAILABLE")?;
    ensure!(!backend.closed(), "CAPABILITY_UNAVAILABLE");
    ensure!(
        host.gateway.workbench.backend.source.borrow().as_deref() == params["sourceId"].as_str(),
        "FORBIDDEN"
    );
    let scope = format!(
        "workbench-{}",
        areal_local_service::storage::digest(principal.as_bytes())
    );
    let (revision, mut snapshot) = host.journal.native_snapshot(&scope)?;
    let unknown = json!({"commandId":command,"method":method,"admissionState":"accepted","submissionUnknown":true,"semanticDigest":digest});
    // 未知操作只按摘要查询，永不重放；不持久化可能含供应商凭据的请求参数。
    snapshot["pending"]
        .as_array_mut()
        .unwrap()
        .push(json!({"requestId":command,"operationId":command,"method":method,"params":{},"result":unknown}));
    host.journal.native_replace(&scope, revision, snapshot)?;
    let mut payload = params;
    payload.as_object_mut().unwrap().remove("sourceId");
    if method == "manage.command" && payload.get("requestId").is_none() {
        payload["requestId"] = json!(command);
    }
    let result = backend
        .request(method, payload, json!({"principal":principal}))
        .await
        .and_then(|value| {
            if method == "library.command" {
                crate::shell::library_result(value)
            } else {
                validate_backend_result(method, &value)?;
                Ok(value)
            }
        });
    let mut receipt = match result {
        Ok(value) => {
            json!({"commandId":command,"method":method,"admissionState":"accepted","submissionUnknown":false,"receipt":value,"semanticDigest":digest})
        }
        Err(_) => unknown,
    };
    if receipt["submissionUnknown"] == false {
        let (revision, mut snapshot) = host.journal.native_snapshot(&scope)?;
        snapshot["pending"]
            .as_array_mut()
            .unwrap()
            .retain(|row| row["requestId"] != command);
        snapshot["outcomes"][&command] = receipt.clone();
        host.journal.native_replace(&scope, revision, snapshot)?;
    }
    receipt.as_object_mut().unwrap().remove("semanticDigest");
    Ok(receipt)
}

/// 本机网页的桌面命令：与桌面窗口同一用户，由后台按桌面命令合同校验后执行。
/// 不进 Host journal，丢回复与桌面窗口原路径一样只能重新读取。
pub(super) async fn desktop_command(
    host: &Rc<Host>,
    principal: &str,
    request: &Value,
) -> Result<Value> {
    let params = serde_json::from_value::<areal_protocol::host::DesktopCommandParams>(
        request["params"].clone(),
    )
    .context("INVALID_PARAMS")?;
    host.admission()?;
    host.gateway.workbench.resume_backend(host).await?;
    let source = host.gateway.workbench.backend.source.borrow().clone();
    ensure!(
        source.is_some(),
        crate::wire::error(
            "CAPABILITY_UNAVAILABLE",
            "桌面后台未运行，请先打开一次桌面应用"
        )
    );
    ensure!(source.as_deref() == Some(&*params.source_id), "FORBIDDEN");
    let mut params = serde_json::to_value(params)?;
    params.as_object_mut().unwrap().remove("sourceId");
    host.gateway
        .workbench
        .request(
            host,
            "desktop.command",
            params,
            json!({"principal":principal}),
        )
        .await
}

pub(super) async fn backend_read(
    host: &Rc<Host>,
    principal: &str,
    request: &Value,
) -> Result<Value> {
    let method = request["method"].as_str().context("INVALID_PARAMS")?;
    let mut params = match method {
        "worktree.read" => serde_json::to_value(
            serde_json::from_value::<areal_protocol::host::WorkbenchWorktreeReadParams>(
                request["params"].clone(),
            )
            .context("INVALID_PARAMS")?,
        )?,
        "tasks.read" => serde_json::to_value(
            serde_json::from_value::<areal_protocol::host::WorkbenchTasksReadParams>(
                request["params"].clone(),
            )
            .context("INVALID_PARAMS")?,
        )?,
        "trajectory.read" => serde_json::to_value(
            serde_json::from_value::<areal_protocol::host::WorkbenchTrajectoryReadParams>(
                request["params"].clone(),
            )
            .context("INVALID_PARAMS")?,
        )?,
        "feedback.read" => serde_json::to_value(
            serde_json::from_value::<areal_protocol::host::WorkbenchFeedbackReadParams>(
                request["params"].clone(),
            )
            .context("INVALID_PARAMS")?,
        )?,
        "providers.read" => serde_json::to_value(
            serde_json::from_value::<areal_protocol::host::WorkbenchProviderReadParams>(
                request["params"].clone(),
            )
            .context("INVALID_PARAMS")?,
        )?,
        "manage.read" => serde_json::to_value(
            serde_json::from_value::<areal_protocol::host::WorkbenchManageReadParams>(
                request["params"].clone(),
            )
            .context("INVALID_PARAMS")?,
        )?,
        _ => bail!("methodNotFound"),
    };
    ensure!(
        host.gateway.workbench.backend.source.borrow().as_deref() == params["sourceId"].as_str(),
        "FORBIDDEN"
    );
    params.as_object_mut().unwrap().remove("sourceId");
    let value = host
        .gateway
        .workbench
        .request(host, method, params, json!({"principal":principal}))
        .await?;
    validate_backend_result(method, &value)?;
    Ok(value)
}

fn validate_backend_result(method: &str, value: &Value) -> Result<()> {
    match method {
        "tasks.read" => {
            serde_json::from_value::<areal_protocol::host::WorkbenchTasksReadResult>(
                value.clone(),
            )?;
        }
        "trajectory.read" | "trajectory.command" => {
            serde_json::from_value::<areal_protocol::host::WorkbenchTrajectoryStatus>(
                value.clone(),
            )?;
        }
        "feedback.read" | "feedback.command" => {
            serde_json::from_value::<areal_protocol::host::WorkbenchFeedbackValue>(value.clone())?;
        }
        "worktree.read" | "worktree.command" => {
            serde_json::from_value::<areal_protocol::host::WorkbenchWorktreeValue>(value.clone())?;
        }
        "providers.read" | "providers.command" => {
            serde_json::from_value::<areal_protocol::host::WorkbenchProviderValue>(value.clone())?;
        }
        "manage.read" => {
            serde_json::from_value::<areal_protocol::host::WorkbenchManageReadResult>(
                value.clone(),
            )?;
        }
        "manage.command" => {
            serde_json::from_value::<areal_protocol::host::WorkbenchManageCommandReceipt>(
                value.clone(),
            )?;
        }
        _ => bail!("methodNotFound"),
    }
    Ok(())
}

impl Backend {
    async fn ensure(&self, host: &Rc<Host>, input: Ensure) -> Result<Value> {
        let (key, launch) = launch(host, input.clone())?;
        let _guard = self.starting.lock().await;
        ensure!(!self.stopped.get(), "CAPABILITY_UNAVAILABLE");
        let current = self.running.borrow().clone();
        if let Some(workbench) = current {
            if !workbench.closed() {
                let owner = self.ownership.borrow().clone();
                if let Some((current, ownership)) = owner {
                    ensure!(current == key, "CONFLICT");
                    // 旧版本启动的后台没有留下记录；桌面再次接上时补记，网页之后才能自行拉起。
                    let _ = areal_local_service::storage::write(&launch_record(host), &input);
                    return Ok(ownership);
                }
            }
            workbench.stop().await?;
            self.running.borrow_mut().take();
            self.failures.borrow_mut().push(Instant::now());
        }
        self.admit()?;
        let source = launch.source_id.clone();
        let record = input.clone();
        match self.start(host, launch).await {
            Ok((workbench, ownership)) => {
                // 记不下来只影响下次网页自动拉起，不影响这次启动。
                let _ = areal_local_service::storage::write(&launch_record(host), &record);
                *self.source.borrow_mut() = source;
                *self.running.borrow_mut() = Some(Rc::new(workbench));
                *self.ownership.borrow_mut() = Some((key, ownership.clone()));
                Ok(ownership)
            }
            Err(error) => {
                self.failures.borrow_mut().push(Instant::now());
                Err(error)
            }
        }
    }

    fn status(&self, host: &Rc<Host>) -> Result<Value> {
        let alive = self
            .running
            .borrow()
            .as_ref()
            .is_some_and(|workbench| !workbench.closed());
        let ownership = self.ownership.borrow().clone().map(|(_, value)| value);
        Ok(json!({
            "hostId": host.identity.host_id,
            "generation": host.identity.generation,
            "owned": alive && ownership.is_some(),
            "service": ownership.filter(|_| alive),
        }))
    }

    async fn stop(&self) {
        self.stopped.set(true);
        let _guard = self.starting.lock().await;
        self.ownership.borrow_mut().take();
        let running = self.running.borrow_mut().take();
        if let Some(workbench) = running {
            let _ = workbench.stop().await;
        }
    }

    fn admit(&self) -> Result<()> {
        let mut failures = self.failures.borrow_mut();
        failures.retain(|time| time.elapsed() < FAILURE_WINDOW);
        let Some(last) = failures.last() else {
            return Ok(());
        };
        ensure!(failures.len() < 5, "CAPABILITY_UNAVAILABLE");
        let delay = restart_delay(failures.len() as u32 - 1).context("CAPABILITY_UNAVAILABLE")?;
        ensure!(last.elapsed() >= delay, "CAPABILITY_UNAVAILABLE");
        Ok(())
    }

    async fn start(&self, host: &Rc<Host>, launch: Launch) -> Result<(Workbench, Value)> {
        let entry = discover_backend(&host.bin).await?;
        let data = host.home.join("workbench");
        areal_local_service::storage::private_dir(&data)?;
        let bootstrap = json!({
            "appRoot": launch.app_root,
            "options": launch.options,
            "retired": self.ownership.borrow().as_ref().map(|(_, value)| value.clone()),
        });
        let (workbench, ready) = Workbench::start_with(
            &entry.runtime,
            &entry.runner,
            &data,
            reverse(host),
            Some(("backend.start", bootstrap)),
        )
        .await?;
        let service = ready
            .get("service")
            .cloned()
            .context("invalid workbench ready frame")?;
        ensure!(
            service.is_object()
                && service["pid"].as_u64().is_some_and(|pid| pid > 1)
                && service["identity"]
                    .as_str()
                    .is_some_and(|value| !value.is_empty()),
            "invalid workbench ready frame"
        );
        Ok((
            workbench,
            json!({
                "hostId": host.identity.host_id,
                "generation": host.identity.generation,
                "pid": service["pid"],
                "identity": service["identity"],
                "desktopGeneration": service.get("desktopGeneration").cloned().unwrap_or(Value::Null),
            }),
        ))
    }
}

fn launch_record(host: &Host) -> PathBuf {
    host.home.join("workbench/backend-launch.json")
}

struct Launch {
    source_id: Option<String>,
    app_root: PathBuf,
    options: Value,
}

/// 校验桌面后台的启动参数。数据目录保持已登记的原 GUI home，Host 数据目录必须是自己；
/// Core 程序必须在 Host 自己的 Core 目录内；`appRoot` 从安装包推导，不接受客户端指定。
fn launch(host: &Host, input: Ensure) -> Result<(String, Launch)> {
    let source = host
        .migration
        .navigation_source_id(&input.profile)?
        .context("GUI_SOURCE_PENDING")?;
    let home = host
        .migration
        .power_sources()?
        .remove(&source)
        .context("GUI_SOURCE_PENDING")?;
    ensure!(
        Path::new(input.options["home"].as_str().unwrap_or_default()).canonicalize()?
            == home.canonicalize()?,
        "invalidRequest"
    );
    let (key, mut launch) = launch_at(&host.bin, &host.home, input)?;
    launch.source_id = Some(source);
    Ok((key, launch))
}

fn launch_at(bin: &Path, host_home: &Path, input: Ensure) -> Result<(String, Launch)> {
    let invalid = |message: &str| crate::wire::error("invalidRequest", message);
    let bin = &bin.canonicalize().unwrap_or_else(|_| bin.to_path_buf());
    let host_home = host_home
        .canonicalize()
        .unwrap_or_else(|_| host_home.to_path_buf());
    let profile = input
        .profile
        .canonicalize()
        .map_err(|_| invalid("profile is not a directory"))?;
    ensure!(profile.is_dir(), invalid("profile is not a directory"));
    let options = input.options;
    let object = options
        .as_object()
        .context(invalid("options must be an object"))?;
    for key in ["binary", "home", "guiProfile", "hostHome"] {
        ensure!(
            object.get(key).is_some_and(Value::is_string),
            invalid("options are incomplete")
        );
    }
    let path = |key: &str| -> Result<PathBuf> {
        PathBuf::from(object[key].as_str().unwrap_or_default())
            .canonicalize()
            .map_err(|_| invalid("options contain a missing path"))
    };
    let home = path("home")?;
    ensure!(home.is_dir(), invalid("backend home is not a directory"));
    let gui_profile = path("guiProfile")?;
    ensure!(gui_profile == profile, invalid("profile mismatch"));
    let reported_host = path("hostHome")?;
    ensure!(
        reported_host == host_home,
        invalid("backend belongs to another Host")
    );
    let binary = path("binary")?;
    ensure!(
        binary.parent() == Some(bin.as_path())
            && binary.file_name().is_some_and(|name| name == "areal"),
        invalid("Core executable is not the Host Core")
    );
    let source = source_entry(bin, "backend-main.cjs").is_some();
    let app_root = bin
        .join(if source {
            "../../clients/gui/app"
        } else {
            "../../app.asar"
        })
        .canonicalize()
        .map_err(|_| anyhow::anyhow!("CAPABILITY_UNAVAILABLE"))?;
    ensure!(
        if source {
            app_root.is_dir()
        } else {
            app_root.is_file()
        },
        "CAPABILITY_UNAVAILABLE"
    );
    Ok((
        serde_json::to_string(&options)?,
        Launch {
            app_root,
            options,
            source_id: None,
        },
    ))
}

/// 服务向 Host 的反向调用。服务只经 Host 取项目与 Core，Host 做代次检查。
pub(super) fn reverse(host: &Rc<Host>) -> Reverse {
    let host: Weak<Host> = Rc::downgrade(host);
    Rc::new(move |call, params| {
        let host = host.clone();
        Box::pin(async move {
            let host = host.upgrade().context("CAPABILITY_UNAVAILABLE")?;
            match call.as_str() {
                "pages.event" => {
                    if let Some(sender) = host.gateway.workbench.page_events.borrow().as_ref() {
                        let _ = sender.send(params);
                    }
                    Ok(Value::Null)
                }
                "projects.list" => Ok(projects(&host)),
                "core.request" => core_request(&host, &params).await,
                _ => bail!("FORBIDDEN"),
            }
        })
    })
}

fn projects(host: &Host) -> Value {
    let projects: Vec<_> = host
        .slots
        .borrow()
        .values()
        .map(|slot| json!({"projectId":slot.registration.project_id,"ready":slot.state == "ready"}))
        .collect();
    json!({ "projects": projects })
}

async fn core_request(host: &Host, params: &Value) -> Result<Value> {
    let object = params.as_object().context("INVALID_PARAMS")?;
    ensure!(
        object
            .keys()
            .all(|key| matches!(key.as_str(), "projectId" | "method" | "params")),
        "INVALID_PARAMS"
    );
    let project = params["projectId"].as_str().context("INVALID_PARAMS")?;
    let method = params["method"].as_str().context("INVALID_PARAMS")?;
    ensure!(CORE_METHODS.contains(&method), "FORBIDDEN");
    let body = params.get("params").cloned().unwrap_or_else(|| json!({}));
    ensure!(body.is_object(), "INVALID_PARAMS");
    ensure!(host.slots.borrow().contains_key(project), "NOT_FOUND");
    let connections = &host.schedules.connections;
    let (service, generation, connection) = connections.shared_identity(host, project)?;
    connections
        .remote_request(
            host,
            project,
            (&service, &generation, &connection),
            method,
            body,
        )
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn pages_bind_authenticated_connection_and_forward_disconnect_without_a_journal() {
        tokio::task::LocalSet::new().run_until(async {
            let root = tempfile::tempdir().unwrap();
            let host = Rc::new(crate::server::schedules::tests::fixture(root.path()));
            let runtime = std::env::split_paths(&std::env::var_os("PATH").unwrap())
                .map(|path| path.join("node")).find(|path| path.is_file()).expect("Node is required");
            let runner = root.path().join("pages.cjs");
            std::fs::write(&runner, r#"
                const out = value => console.log(JSON.stringify({version:1,...value}));
                out({event:'ready',methods:['pages.command','pages.resource']});
                require('node:readline').createInterface({input:process.stdin}).on('line', line => {
                  const frame = JSON.parse(line);
                  if (frame.event === 'pages.disconnect') {
                    out({event:'pages.event',params:{connection:frame.connection,token:'page',notification:{jsonrpc:'2.0',method:'ui/notifications/closed'}}});
                  } else {
                    out({id:frame.id,result:{owner:frame.context.connection}});
                  }
                });
            "#).unwrap();
            let backend = Workbench::start(&runtime, &runner, root.path(), reverse(&host)).await.unwrap();
            *host.gateway.workbench.backend.running.borrow_mut() = Some(Rc::new(backend));
            let mut first = crate::server::gateway_owner::LocalSession::new(host.clone(), "first".into()).unwrap();
            let mut second = crate::server::gateway_owner::LocalSession::new(host.clone(), "second".into()).unwrap();
            let request = json!({"id":"page","method":"pages.command","params":{"operation":"close","token":"page"}});
            assert_eq!(first.request(&request).await.unwrap()["owner"], "first");
            assert_eq!(second.request(&request).await.unwrap()["owner"], "second");
            let mut forged = request.clone();
            forged["context"] = json!({"connection":"second"});
            assert_eq!(first.request(&forged).await.unwrap_err().to_string(), "INVALID_PARAMS");
            forged = request.clone();
            forged["params"]["connection"] = json!("second");
            assert_eq!(first.request(&forged).await.unwrap_err().to_string(), "INVALID_PARAMS");
            let mut events = host.gateway.workbench.page_events();
            host.gateway.workbench.disconnect_pages("first");
            let event = tokio::time::timeout(Duration::from_secs(2), events.recv()).await.unwrap().unwrap();
            assert_eq!(event["connection"], "first");
            assert_eq!(event["notification"]["method"], "ui/notifications/closed");
            assert!(backend_receipt(&host, "local", &uuid::Uuid::new_v4().to_string()).unwrap().is_none());
            host.gateway.workbench.stop_backend().await;
        }).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn lost_backend_reply_keeps_the_original_library_command_unknown() {
        tokio::task::LocalSet::new().run_until(async {
            let root = tempfile::tempdir().unwrap();
            let host = Rc::new(crate::server::schedules::tests::fixture(root.path()));
            let runtime = std::env::split_paths(&std::env::var_os("PATH").unwrap())
                .map(|path| path.join("node")).find(|path| path.is_file()).expect("Node is required for the workbench boundary test");
            let runner = root.path().join("lost-reply.cjs");
            std::fs::write(&runner, r#"
                const fs = require('node:fs');
                console.log(JSON.stringify({version:1,event:'ready',methods:['library.command']}));
                require('node:readline').createInterface({input:process.stdin}).on('line', () => {
                  fs.appendFileSync(process.env.AREAL_WORKBENCH_DATA + '/effects', 'once\n');
                  process.exit(0);
                });
            "#).unwrap();
            let reverse: Reverse = Rc::new(|_, _| Box::pin(async { bail!("FORBIDDEN") }));
            let backend = Workbench::start(&runtime, &runner, root.path(), reverse).await.unwrap();
            *host.gateway.workbench.backend.running.borrow_mut() = Some(Rc::new(backend));
            *host.gateway.workbench.backend.source.borrow_mut() = Some("fixture".into());
            let command = uuid::Uuid::new_v4().to_string();
            let request = json!({"method":"library.command","commandId":command,"params":{"sourceId":"fixture","operation":"createSection","title":"fixture"}});
            let first = backend_command(&host, "local", &request).await.unwrap();
            assert_eq!(first["submissionUnknown"], true);
            assert_eq!(backend_command(&host, "local", &request).await.unwrap(), first);
            assert_eq!(std::fs::read_to_string(root.path().join("effects")).unwrap(), "once\n");
            let mut conflict = request.clone();
            conflict["params"]["title"] = json!("changed");
            assert_eq!(backend_command(&host, "local", &conflict).await.unwrap_err().to_string(), "COMMAND_CONFLICT");
            assert_eq!(backend_receipt(&host, "local", &command).unwrap().unwrap()["submissionUnknown"], true);
            let other_method = json!({"method":"worktree.command","commandId":command,"params":{"sourceId":"fixture","operation":"worktreeSettings","worktreeRoot":"/isolated","branchPrefix":"fixture"}});
            assert_eq!(backend_command(&host, "local", &other_method).await.unwrap_err().to_string(), "COMMAND_CONFLICT");
            host.gateway.workbench.stop_backend().await;
        }).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn lost_provider_reply_keeps_receipt_without_persisting_credentials() {
        tokio::task::LocalSet::new().run_until(async {
            let root = tempfile::tempdir().unwrap();
            let host = Rc::new(crate::server::schedules::tests::fixture(root.path()));
            let runtime = std::env::split_paths(&std::env::var_os("PATH").unwrap())
                .map(|path| path.join("node")).find(|path| path.is_file()).expect("Node is required for the workbench boundary test");
            let runner = root.path().join("lost-reply.cjs");
            std::fs::write(&runner, r#"
                const fs = require('node:fs');
                console.log(JSON.stringify({version:1,event:'ready',methods:['providers.command']}));
                require('node:readline').createInterface({input:process.stdin}).on('line', () => {
                  fs.appendFileSync(process.env.AREAL_WORKBENCH_DATA + '/effects', 'once\n');
                  process.exit(0);
                });
            "#).unwrap();
            let reverse: Reverse = Rc::new(|_, _| Box::pin(async { bail!("FORBIDDEN") }));
            let backend = Workbench::start(&runtime, &runner, root.path(), reverse).await.unwrap();
            *host.gateway.workbench.backend.running.borrow_mut() = Some(Rc::new(backend));
            *host.gateway.workbench.backend.source.borrow_mut() = Some("fixture".into());
            let command = uuid::Uuid::new_v4().to_string();
            let request = json!({"method":"providers.command","commandId":command,"params":{"sourceId":"fixture","operation":"save","expectedRevision":"initial","apiKey":"synthetic-private-key","provider":{"name":"fixture","baseUrl":"https://example.invalid","protocol":"responses","models":[]}}});
            let first = backend_command(&host, "local", &request).await.unwrap();
            assert_eq!(first["submissionUnknown"], true);
            assert_eq!(backend_command(&host, "local", &request).await.unwrap(), first);
            assert_eq!(std::fs::read_to_string(root.path().join("effects")).unwrap(), "once\n");
            let mut conflict = request.clone();
            conflict["params"]["apiKey"] = json!("rotated-private-key");
            assert_eq!(backend_command(&host, "local", &conflict).await.unwrap_err().to_string(), "COMMAND_CONFLICT");
            assert_eq!(backend_receipt(&host, "local", &command).unwrap().unwrap()["submissionUnknown"], true);
            let other_method = json!({"method":"worktree.command","commandId":command,"params":{"sourceId":"fixture","operation":"worktreeSettings","worktreeRoot":"/isolated","branchPrefix":"fixture"}});
            assert_eq!(backend_command(&host, "local", &other_method).await.unwrap_err().to_string(), "COMMAND_CONFLICT");
            let scope = format!("workbench-{}", areal_local_service::storage::digest(b"local"));
            let (_, snapshot) = host.journal.native_snapshot(&scope).unwrap();
            assert_eq!(snapshot["pending"][0]["params"], json!({}));
            assert!(!snapshot.to_string().contains("synthetic-private-key"));
            host.gateway.workbench.stop_backend().await;
        }).await;
    }

    fn layout(root: &Path) -> (PathBuf, PathBuf, PathBuf) {
        let contents = root.join("Contents/Resources");
        let bin = contents.join("areal-core/bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("areal"), b"").unwrap();
        std::fs::write(contents.join("app.asar"), b"fixture").unwrap();
        std::fs::create_dir_all(root.join("profile")).unwrap();
        std::fs::create_dir_all(root.join("profile/areal-core")).unwrap();
        std::fs::create_dir_all(root.join("host")).unwrap();
        (bin, root.join("profile"), root.join("host"))
    }

    fn options(root: &Path, bin: &Path) -> Value {
        json!({
            "binary": bin.join("areal"),
            "home": root.join("profile/areal-core"),
            "guiProfile": root.join("profile"),
            "hostHome": root.join("host"),
        })
    }

    fn code(result: Result<(String, Launch)>) -> String {
        let error = result.err().unwrap();
        error
            .downcast_ref::<crate::wire::Error>()
            .map(|error| error.code.to_owned())
            .unwrap_or_else(|| error.to_string())
    }

    #[test]
    fn backend_launch_only_accepts_the_gui_profile_and_the_host_core() {
        let root = tempfile::tempdir().unwrap();
        let (bin, profile, host_home) = layout(root.path());
        let accepted = launch_at(
            &bin,
            &host_home,
            Ensure {
                profile: profile.clone(),
                options: options(root.path(), &bin),
            },
        )
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&accepted.0).unwrap(),
            options(root.path(), &bin)
        );
        assert_eq!(
            accepted.1.app_root,
            root.path()
                .join("Contents/Resources/app.asar")
                .canonicalize()
                .unwrap()
        );

        let mut other_core = options(root.path(), &bin);
        other_core["binary"] = json!(root.path().join("other/bin/areal"));
        std::fs::create_dir_all(root.path().join("other/bin")).unwrap();
        std::fs::write(root.path().join("other/bin/areal"), b"").unwrap();
        assert_eq!(
            code(launch_at(
                &bin,
                &host_home,
                Ensure {
                    profile: profile.clone(),
                    options: other_core,
                },
            )),
            "invalidRequest"
        );

        let mut other_host = options(root.path(), &bin);
        other_host["hostHome"] = json!(root.path().join("profile"));
        assert_eq!(
            code(launch_at(
                &bin,
                &host_home,
                Ensure {
                    profile,
                    options: other_host,
                },
            )),
            "invalidRequest"
        );
    }

    #[test]
    fn manage_operations_that_admit_or_stop_work_need_their_own_capability() {
        let capability = |params: Value| manage_capability("manage.command", &params);
        for operation in ["taskRunNow", "taskResumeRun"] {
            assert_eq!(capability(json!({"operation":operation})), Some("submit"));
            let mut params = json!({"sourceId":"source","projectId":"project",
                "operation":operation,"taskId":"task","expectedRevision":2});
            if operation == "taskResumeRun" {
                params["expectedRunId"] = json!("run");
                let missing_guard = params
                    .as_object_mut()
                    .unwrap()
                    .remove("expectedRunId")
                    .unwrap();
                assert!(
                    serde_json::from_value::<areal_protocol::host::WorkbenchManageCommandParams>(
                        params.clone()
                    )
                    .is_err()
                );
                params["expectedRunId"] = missing_guard;
            }
            assert!(
                serde_json::from_value::<areal_protocol::host::WorkbenchManageCommandParams>(
                    params
                )
                .is_ok()
            );
        }
        assert!(
            validate_backend_result(
                "manage.command",
                &json!({
                    "accepted":true,"taskId":"task","runId":"run","revision":3
                })
            )
            .is_ok()
        );
        for operation in MANAGE_SUBMIT_OPERATIONS {
            assert_eq!(
                capability(json!({"operation":operation})),
                Some("submit"),
                "{operation}"
            );
        }
        for operation in MANAGE_INTERRUPT_OPERATIONS {
            assert_eq!(
                capability(json!({"operation":operation})),
                Some("interrupt"),
                "{operation}"
            );
        }
        // 只读、目录、插件与配置管理不额外索取提交或中断能力。
        for operation in [
            "pluginConfigure",
            "pluginInstall",
            "marketplaceAddGit",
            "taskPause",
            "planUpdate",
            "serverDrain",
        ] {
            assert_eq!(
                capability(json!({"operation":operation})),
                None,
                "{operation}"
            );
        }
        assert_eq!(
            manage_capability("manage.read", &json!({"operation":"processStart"})),
            None
        );
        assert_eq!(manage_capability("manage.command", &json!({})), None);
        assert_eq!(
            manage_capability("tasks.read", &json!({"operation":"processStart"})),
            None
        );
    }

    #[test]
    fn backend_status_is_not_routed_to_external_clients() {
        assert!(!METHODS.contains(&"backend.ensure") && !METHODS.contains(&"backend.status"));
        assert!(!CORE_METHODS.contains(&"backend.ensure"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn reverse_calls_are_read_only_and_scoped_to_registered_projects() {
        let root = tempfile::tempdir().unwrap();
        let host = Rc::new(crate::server::schedules::tests::fixture(root.path()));
        let reverse = reverse(&host);
        let listed = reverse("projects.list".into(), json!({})).await.unwrap();
        assert_eq!(listed["projects"][0]["projectId"], "project");
        for (call, params, code) in [
            ("vault.read", json!({"slot":"x"}), "FORBIDDEN"),
            (
                "core.request",
                json!({"projectId":"project","method":"turn/start","params":{}}),
                "FORBIDDEN",
            ),
            (
                "core.request",
                json!({"projectId":"other","method":"thread/read","params":{}}),
                "NOT_FOUND",
            ),
            (
                "core.request",
                json!({"projectId":"project","method":"thread/read","extra":1}),
                "INVALID_PARAMS",
            ),
        ] {
            let error = reverse(call.into(), params).await.unwrap_err();
            assert_eq!(error.to_string(), code, "{call}");
        }
    }

    #[test]
    fn restarts_back_off_and_stop_after_five_failures() {
        let supervisor = Supervisor::default();
        assert!(supervisor.admit().is_ok());
        supervisor.failures.borrow_mut().push(Instant::now());
        assert!(supervisor.admit().is_err());
        *supervisor.failures.borrow_mut() = vec![Instant::now() - Duration::from_secs(2)];
        assert!(supervisor.admit().is_ok());
        *supervisor.failures.borrow_mut() = vec![Instant::now() - Duration::from_secs(120); 5];
        assert!(supervisor.admit().is_err());
        *supervisor.failures.borrow_mut() =
            vec![Instant::now() - FAILURE_WINDOW - Duration::from_secs(1); 5];
        assert!(supervisor.admit().is_ok());
    }
}
