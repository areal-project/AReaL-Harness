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

// 退出由请求惰性发现，首次退出不能从“现在”开始退避而必然拒绝恢复。
// 仍记录这次失败；窗口内后续退出按 1、2、4…秒退避，启动失败也计入上限。
fn record_exit(failures: &RefCell<Vec<Instant>>) -> bool {
    let mut failures = failures.borrow_mut();
    failures.retain(|time| time.elapsed() < FAILURE_WINDOW);
    let first = failures.is_empty();
    failures.push(Instant::now());
    first
}

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
    utility_options: RefCell<Option<Value>>,
    events: RefCell<Vec<Value>>,
    worktree_cleaning: Cell<bool>,
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
pub(super) fn backend_project_alias(host: &Host, source: &str, project: &str) -> Result<String> {
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
    host_dispatch: Option<HostDispatch>,
}
type HostDispatch = (Weak<Host>, String, String, (String, String, String));
impl PreparedExecution {
    pub(super) async fn dispatch(&mut self) -> Result<Value> {
        ensure!(!self.dispatched, "SUBMISSION_UNKNOWN");
        self.dispatched = true;
        if let Some((host, project, method, scope)) = &self.host_dispatch {
            let host = host.upgrade().context("CAPABILITY_UNAVAILABLE")?;
            ensure!(
                host.gateway.workbench.backend_has_source(&self.source),
                "RESYNC_REQUIRED"
            );
            let current = host.gateway.workbench.backend.running.borrow().clone();
            ensure!(
                current
                    .as_ref()
                    .is_some_and(|current| Rc::ptr_eq(current, &self.backend))
                    && !self.backend.closed(),
                "CAPABILITY_UNAVAILABLE"
            );
            let result = host
                .schedules
                .connections
                .remote_request(
                    &host,
                    project,
                    (&scope.0, &scope.1, &scope.2),
                    method,
                    self.params.clone(),
                )
                .await;
            // 回执以 Core 为准；页面租约结算失败不能把已受理的执行改成拒绝或重发。
            let body = match &result {
                Ok(result) => {
                    json!({"connection":self.connection,"handle":self.handle,"result":result})
                }
                Err(_) => json!({"connection":self.connection,"handle":self.handle,"error":true}),
            };
            self.backend.notify("execution.complete", body).await;
            return result;
        }
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
    pub(super) fn tasks_event(&self, host: &Host, canonical: &str, mut body: Value) {
        let Some(source) = self.active_source() else {
            return;
        };
        let Ok(alias) = backend_project_alias(host, &source, canonical) else {
            return;
        };
        body["projectId"] = json!(alias);
        if let Some(backend) = self
            .backend
            .running
            .borrow()
            .clone()
            .filter(|b| !b.closed())
        {
            tokio::task::spawn_local(async move {
                backend.notify("tasks.event", body).await;
            });
        }
    }

    pub(super) fn backend_core_event(&self, project: &str, lease: &str, event: &Value) {
        let backend = self.backend.running.borrow().clone();
        let body = json!({"projectId":project,"lease":lease,"method":event["method"],"params":event["params"],"sequence":event["sequence"]});
        if let Some(backend) = backend {
            tokio::task::spawn_local(async move {
                backend.notify("core.event", body).await;
            });
        } else if self.backend.events.borrow().len() < 4096 {
            self.backend.events.borrow_mut().push(body);
        } else {
            self.backend.stopped.set(true);
        }
    }
    pub(super) async fn backend_core_callback(
        &self,
        project: &str,
        lease: &str,
        method: &str,
        params: &Value,
        request_id: &Value,
    ) -> Result<Value> {
        let backend = self
            .backend
            .running
            .borrow()
            .clone()
            .context("CAPABILITY_UNAVAILABLE")?;
        backend.request("core.callback",json!({"projectId":project,"lease":lease,"method":method,"params":params,"requestId":request_id}),json!({})).await
    }
    pub(super) async fn backend_private(&self, method: &str, params: Value) -> Result<Value> {
        ensure!(
            ["lifecycle.dependencies", "lifecycle.flush"].contains(&method),
            "FORBIDDEN"
        );
        let backend = self
            .backend
            .running
            .borrow()
            .clone()
            .context("CAPABILITY_UNAVAILABLE")?;
        backend.request(method, params, json!({})).await
    }

    pub(super) fn worktree_backend_identity(&self, source: &str) -> Option<Value> {
        if !self.backend_has_source(source)
            || self
                .backend
                .running
                .borrow()
                .as_ref()
                .is_none_or(|backend| backend.closed())
        {
            return None;
        }
        self.backend
            .ownership
            .borrow()
            .as_ref()
            .map(|(_, owner)| owner.clone())
    }
    // 沿用原后台 init/finishSetup 的清理触发，不在每次目录读取时启动清理。
    pub(super) fn schedule_worktree_cleanup(&self, host: &Rc<Host>, source: &str) {
        if (source != "host" && !self.backend_has_source(source))
            || self.backend.worktree_cleaning.replace(true)
        {
            return;
        }
        let source = source.to_owned();
        let owner = if source == "host" {
            None
        } else {
            self.worktree_backend_identity(&source)
        };
        let weak = Rc::downgrade(host);
        let task: futures_util::future::LocalBoxFuture<'static, ()> = Box::pin(async move {
            if let Some(host) = weak.upgrade() {
                let current = source == "host"
                    || (host.gateway.workbench.backend_has_source(&source)
                        && host.gateway.workbench.worktree_backend_identity(&source) == owner);
                if current && host.admission().is_ok() {
                    let _ = super::worktree_catalog::auto_cleanup(&host, &source).await;
                }
                host.gateway.workbench.backend.worktree_cleaning.set(false);
            }
        });
        tokio::task::spawn_local(task);
    }

    #[cfg(test)]
    pub(super) fn test_source(&self, source: &str) {
        *self.backend.source.borrow_mut() = Some(source.into());
    }

    /// 已启动后台所属的来源；资料库、执行、任务与工作树均由 Host 的 Rust 实现负责。
    pub(super) fn active_source(&self) -> Option<String> {
        self.backend.source.borrow().clone()
    }
    pub(super) fn utility_options(&self, source: &str) -> Result<Value> {
        ensure!(
            self.backend.source.borrow().as_deref() == Some(source),
            "FORBIDDEN"
        );
        self.backend
            .utility_options
            .borrow()
            .clone()
            .context("CAPABILITY_UNAVAILABLE")
    }
    pub(super) async fn library_dependencies(&self, source: &str) -> Result<Value> {
        ensure!(self.backend_has_source(source), "FORBIDDEN");
        let backend = self
            .backend
            .running
            .borrow()
            .clone()
            .context("CAPABILITY_UNAVAILABLE")?;
        let result = backend
            .request("library.dependencies", json!({}), json!({}))
            .await?;
        ensure!(
            self.backend_has_source(source)
                && self
                    .backend
                    .running
                    .borrow()
                    .as_ref()
                    .is_some_and(|v| Rc::ptr_eq(v, &backend)),
            "RESYNC_REQUIRED"
        );
        Ok(result)
    }
    pub(super) async fn worktree_changed(&self, source: &str) {
        if !self.backend_has_source(source) {
            return;
        }
        let backend = self.backend.running.borrow().clone();
        if let Some(backend) = backend {
            backend
                .notify("worktree.changed", json!({"sourceId":source}))
                .await;
        }
    }

    pub(super) async fn library_changed(&self) {
        let backend = self.backend.running.borrow().clone();
        if let Some(backend) = backend {
            backend.notify("library.changed", json!({})).await;
        }
    }

    pub(super) fn backend_has_source(&self, source: &str) -> bool {
        self.backend.source.borrow().as_deref() == Some(source)
    }
    pub(super) fn backend_source(&self) -> Option<String> {
        self.backend.source.borrow().clone()
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
            host_dispatch: (response["hostDispatch"] == true).then(|| {
                (
                    Rc::downgrade(host),
                    project.to_owned(),
                    method.to_owned(),
                    scope.clone(),
                )
            }),
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
        if self.backend_has_source(source) {
            let mut result =
                super::worktree_catalog::read_thread_target(host, source, &alias, params.clone())
                    .await?;
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
            return Ok(result);
        }

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
        *self.backend.ownership.borrow_mut() = Some(("test".into(), json!({"serviceId":"test"})));
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
            self.resume_backend(host).await?;
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
        let mut first_exit = false;
        if let Some(workbench) = current {
            if !workbench.closed() {
                return Ok(workbench);
            }
            workbench.stop().await?;
            self.running.borrow_mut().take();
            first_exit = record_exit(&self.failures);
        }
        if !first_exit {
            self.admit()?;
        }
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
        let delay = restart_delay((failures.len() as u32).saturating_sub(2))
            .context("CAPABILITY_UNAVAILABLE")?;
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
    let receipt = backend_receipt_raw(host, principal, command)?;
    if let Some(code) = receipt
        .as_ref()
        .and_then(|value| value["settledFailure"].as_str())
    {
        return Err(anyhow::anyhow!("{code}"));
    }
    if let Some(error) = receipt.as_ref().and_then(|value| value.get("error")) {
        return Err(super::task_catalog::TaskRejection(error.clone()).into());
    }
    Ok(receipt)
}

fn backend_receipt_raw(host: &Host, principal: &str, command: &str) -> Result<Option<Value>> {
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
        "worktree.command" if principal == "local" => serde_json::to_value(
            serde_json::from_value::<areal_protocol::host::LocalWorktreeCommandInput>(
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
    if let Some(mut original) = backend_receipt_raw(host, principal, &command)? {
        ensure!(original["semanticDigest"] == digest, "COMMAND_CONFLICT");
        if let Some(code) = original["settledFailure"].as_str() {
            return Err(anyhow::anyhow!("{code}"));
        }
        if let Some(error) = original.get("error") {
            return Err(super::task_catalog::TaskRejection(error.clone()).into());
        }
        original.as_object_mut().unwrap().remove("semanticDigest");
        return Ok(original);
    }
    if method == "worktree.command" {
        super::worktree_catalog::validate_admission(
            host,
            params["sourceId"].as_str().context("INVALID_PARAMS")?,
            &params,
        )?;
    }
    host.admission()?;
    let source = params["sourceId"]
        .as_str()
        .context("INVALID_PARAMS")?
        .to_owned();
    let native = method == "worktree.command" && source == "host";
    if !native {
        host.gateway.workbench.resume_backend(host).await?;
    }
    let backend = host.gateway.workbench.backend.running.borrow().clone();
    if !native {
        ensure!(
            backend.as_ref().is_some_and(|b| !b.closed()),
            "CAPABILITY_UNAVAILABLE"
        );
        ensure!(
            host.gateway.workbench.backend_has_source(&source),
            "FORBIDDEN"
        );
    }
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
    let source = params["sourceId"]
        .as_str()
        .context("INVALID_PARAMS")?
        .to_owned();
    let mut payload = params;
    payload.as_object_mut().unwrap().remove("sourceId");
    if method == "manage.command" && payload.get("requestId").is_none() {
        payload["requestId"] = json!(command);
    }
    // 资料库、工作树与任务变更由 Host 执行，其余领域交给工作台后台。
    let native_task = method == "manage.command"
        && super::task_catalog::mutation(payload["operation"].as_str().unwrap_or("")).is_some();
    let result = if method == "library.command" {
        super::library_service::command(host, &source, payload).await
    } else if method == "worktree.command" {
        super::worktree_catalog::command(host, &source, payload).await
    } else if native_task {
        payload["sourceId"] = json!(source);
        super::task_catalog::command(host, &payload).await
    } else {
        backend
            .context("CAPABILITY_UNAVAILABLE")?
            .request(method, payload, json!({"principal":principal}))
            .await
    }
    .and_then(|value| {
        if method == "library.command" {
            crate::shell::library_result(value)
        } else {
            validate_backend_result(method, &value)?;
            Ok(value)
        }
    });
    let mut failure = None;
    let mut receipt = match result {
        Ok(value) => {
            json!({"commandId":command,"method":method,"admissionState":"accepted","submissionUnknown":false,"receipt":value,"semanticDigest":digest})
        }
        Err(error) => match native_task
            .then(|| super::task_catalog::definitive_task_rejection(&error))
            .flatten()
        {
            Some(error) => {
                json!({"commandId":command,"method":method,"sourceId":source,"admissionState":"rejected","submissionUnknown":false,"error":error,"semanticDigest":digest})
            }
            // 执行方明确报出的失败按拒绝结算，不留在待核对列表里。
            None if super::gateway_owner::settled_failure(&error.to_string()) => {
                let code = error.to_string();
                failure = Some(error);
                json!({"commandId":command,"method":method,"sourceId":source,"admissionState":"rejected","submissionUnknown":false,"settledFailure":code,"semanticDigest":digest})
            }
            None => unknown,
        },
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
    if let Some(error) = failure {
        return Err(error);
    }
    if let Some(error) = receipt.get("error") {
        return Err(super::task_catalog::TaskRejection(error.clone()).into());
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
    ensure!(request.get("commandId").is_none(), "INVALID_PARAMS");
    let mut params = serde_json::from_value::<areal_protocol::host::DesktopCommandParams>(
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
    let matched = params.source_id.take().is_none_or(|id| source == Some(id));
    ensure!(matched, "FORBIDDEN");
    let params = serde_json::to_value(params)?;
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
    host.gateway.workbench.resume_backend(host).await?;
    ensure!(
        host.gateway.workbench.backend.source.borrow().as_deref() == params["sourceId"].as_str(),
        "FORBIDDEN"
    );
    let source = params["sourceId"]
        .as_str()
        .context("INVALID_PARAMS")?
        .to_owned();
    if method == "tasks.read" && host.gateway.workbench.backend_has_source(&source) {
        return super::task_catalog::read(host, &params).await;
    }
    if method == "manage.read"
        && host.gateway.workbench.backend_has_source(&source)
        && params["operation"]
            .as_str()
            .is_some_and(|op| op.starts_with("task") || op == "inboxList")
    {
        return super::task_catalog::manage_read(host, &params).await;
    }
    if method == "worktree.read" && host.gateway.workbench.backend_has_source(&source) {
        return super::worktree_catalog::read(host, &source, params).await;
    }
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
        let mut first_exit = false;
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
            host.schedules.connections.workbench_close_terminals();
            self.running.borrow_mut().take();
            first_exit = record_exit(&self.failures);
        }
        if !first_exit {
            self.admit()?;
        }
        let source = launch.source_id.clone();
        let record = input.clone();
        *self.source.borrow_mut() = source.clone();
        *self.utility_options.borrow_mut() = Some(launch.options.clone());
        match self.start(host, launch).await {
            Ok((workbench, ownership)) => {
                // 记不下来只影响下次网页自动拉起，不影响这次启动。
                let _ = areal_local_service::storage::write(&launch_record(host), &record);
                *self.source.borrow_mut() = source;
                let workbench = Rc::new(workbench);
                *self.running.borrow_mut() = Some(workbench.clone());
                let watched = workbench.clone();
                let weak_host = Rc::downgrade(host);
                tokio::task::spawn_local(async move {
                    watched.wait_closed().await;
                    if let Some(host) = weak_host.upgrade() {
                        let current = host.gateway.workbench.backend.running.borrow().clone();
                        if current
                            .as_ref()
                            .is_none_or(|current| Rc::ptr_eq(current, &watched))
                        {
                            host.schedules.connections.workbench_close_terminals();
                        }
                    }
                });
                for event in self.events.take() {
                    workbench.notify("core.event", event).await;
                }
                ensure!(!self.stopped.get(), "RESYNC_REQUIRED");
                *self.ownership.borrow_mut() = Some((key, ownership.clone()));
                let source = self.source.borrow().clone();
                if let Some(source) = source {
                    if host.gateway.workbench.backend_has_source(&source) {
                        host.gateway.workbench.library_changed().await;
                    }
                    host.gateway
                        .workbench
                        .schedule_worktree_cleanup(host, &source);
                }
                Ok(ownership)
            }
            Err(error) => {
                host.schedules.connections.workbench_close_terminals();
                self.source.borrow_mut().take();
                self.utility_options.borrow_mut().take();
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
        self.utility_options.borrow_mut().take();
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
        let delay = restart_delay((failures.len() as u32).saturating_sub(2))
            .context("CAPABILITY_UNAVAILABLE")?;
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
                "recovery.importProvider" => host.import_provider(serde_json::from_value(params)?),
                // 桌面命令通道里的插件库操作与网关同一个入口。
                "plugins.read" | "plugins.command" => {
                    super::plugins::request(&host, &call, &params).await
                }
                "recovery.history" => {
                    crate::space::history::for_host(&host.home, serde_json::from_value(params)?)
                        .await
                }
                "recovery.inspect" => crate::space::inspect_params_for_host(&host.home, &params),
                "workbench.utility" => {
                    let source = host
                        .gateway
                        .workbench
                        .backend
                        .source
                        .borrow()
                        .clone()
                        .context("FORBIDDEN")?;
                    super::workbench_utility::execute(&host, &source, params).await
                }
                "pages.event" => {
                    if let Some(sender) = host.gateway.workbench.page_events.borrow().as_ref() {
                        let _ = sender.send(params);
                    }
                    Ok(Value::Null)
                }
                "library.patch" => {
                    let source = host
                        .gateway
                        .workbench
                        .active_source()
                        .context("FORBIDDEN")?;
                    let result = super::library_service::patch(&host, &source, &params)?;
                    host.gateway.workbench.library_changed().await;
                    Ok(result)
                }
                "library.command" => {
                    let source = host
                        .gateway
                        .workbench
                        .active_source()
                        .context("FORBIDDEN")?;
                    super::library_service::command(&host, &source, params).await
                }
                "lifecycle.read" | "lifecycle.command" => {
                    let source = host
                        .gateway
                        .workbench
                        .active_source()
                        .context("FORBIDDEN")?;
                    ensure!(params["sourceId"] == source, "FORBIDDEN");
                    if call == "lifecycle.command" {
                        super::workbench_lifecycle::command(
                            &host,
                            &source,
                            params["request"].clone(),
                        )
                        .await
                    } else {
                        super::workbench_lifecycle::read_request(
                            &host,
                            &source,
                            params["operation"].as_str().context("INVALID_PARAMS")?,
                            &params,
                        )
                        .await
                    }
                }
                "tasks.preview" => {
                    let source = host
                        .gateway
                        .workbench
                        .backend
                        .source
                        .borrow()
                        .clone()
                        .context("FORBIDDEN")?;
                    let mut params = params;
                    params["sourceId"] = json!(source);
                    super::task_catalog::preview(&host, &params).await
                }
                "tasks.owner.read" => {
                    let source = host
                        .gateway
                        .workbench
                        .active_source()
                        .context("FORBIDDEN")?;
                    let mut params = params;
                    params["sourceId"] = json!(source);
                    super::task_catalog::owner_read(&host, &params).await
                }
                "tasks.observe" => {
                    let source = host
                        .gateway
                        .workbench
                        .active_source()
                        .context("FORBIDDEN")?;
                    let mut params = params;
                    params["sourceId"] = json!(source);
                    super::task_catalog::observe(&host, &params).await
                }
                "tasks.read" | "tasks.command" => {
                    let source = host
                        .gateway
                        .workbench
                        .active_source()
                        .context("FORBIDDEN")?;
                    let mut params = params;
                    params["sourceId"] = json!(source);
                    if call == "tasks.read" {
                        super::task_catalog::read(&host, &params).await
                    } else {
                        super::task_catalog::native_command(&host, "local", &params).await
                    }
                }
                "worktree.project.add" => {
                    let source = host
                        .gateway
                        .workbench
                        .active_source()
                        .context("FORBIDDEN")?;
                    super::worktree_catalog::add_project(&host, &source, params).await
                }
                "worktree.thread.prepare" | "worktree.thread.bind" => {
                    let source = host
                        .gateway
                        .workbench
                        .active_source()
                        .context("FORBIDDEN")?;
                    let project = params["projectId"].as_str().context("INVALID_PARAMS")?;
                    if call == "worktree.thread.prepare" {
                        super::worktree_catalog::prepare_thread_target(
                            &host,
                            &source,
                            project,
                            params["request"].clone(),
                        )
                        .await
                    } else {
                        super::worktree_catalog::validate_private_binding(&host, &source, &params)?;
                        super::worktree_catalog::bind_thread_target(
                            &host,
                            &source,
                            project,
                            params["requestId"].as_str().context("INVALID_PARAMS")?,
                            params["params"].clone(),
                        )
                        .await
                    }
                }
                "worktree.read" | "worktree.command" => {
                    let source = host
                        .gateway
                        .workbench
                        .active_source()
                        .context("FORBIDDEN")?;
                    if call == "worktree.read" {
                        super::worktree_catalog::read(&host, &source, params).await
                    } else {
                        let command = params["commandId"]
                            .as_str()
                            .context("INVALID_PARAMS")?
                            .to_owned();
                        let mut params = params["request"].clone();
                        params["sourceId"] = json!(source);
                        backend_command(
                            &host,
                            "local",
                            &json!({"method":call,"commandId":command,"params":params}),
                        )
                        .await
                    }
                }
                "execution.admit" => {
                    let source = params["sourceId"].as_str().context("INVALID_PARAMS")?;
                    let project = params["projectId"].as_str().context("INVALID_PARAMS")?;
                    ensure!(
                        host.gateway.workbench.backend_has_source(source),
                        "FORBIDDEN"
                    );
                    backend_project_alias(&host, source, project)?;
                    host.schedules
                        .connections
                        .workbench_admit(
                            &host,
                            project,
                            Some(params["lease"].as_str().context("INVALID_PARAMS")?),
                            params["name"].as_str().context("INVALID_PARAMS")?,
                            &params["request"],
                        )
                        .await
                }
                "execution.dismiss" => {
                    let source = params["sourceId"].as_str().context("INVALID_PARAMS")?;
                    let project = params["projectId"].as_str().context("INVALID_PARAMS")?;
                    ensure!(
                        host.gateway.workbench.backend_has_source(source),
                        "FORBIDDEN"
                    );
                    backend_project_alias(&host, source, project)?;
                    let lease = params["lease"].as_str().context("INVALID_PARAMS")?;
                    host.schedules
                        .connections
                        .workbench_request(
                            &host,
                            project,
                            lease,
                            "areal/capabilities",
                            json!({"apiVersion":"areal.core.v1"}),
                        )
                        .await?;
                    host.journal.native_dismiss(
                        project,
                        params["requestId"].as_str().context("INVALID_PARAMS")?,
                    )?;
                    Ok(json!({"dismissed":true}))
                }
                "execution.submit" | "execution.reconcile" => {
                    let source = params["sourceId"].as_str().context("INVALID_PARAMS")?;
                    let project = params["projectId"].as_str().context("INVALID_PARAMS")?;
                    ensure!(
                        host.gateway.workbench.backend_has_source(source),
                        "FORBIDDEN"
                    );
                    backend_project_alias(&host, source, project)?;
                    let lease = params["lease"].as_str().context("INVALID_PARAMS")?;
                    let method = params["method"].as_str().context("INVALID_PARAMS")?;
                    if call == "execution.submit" {
                        super::workbench_submissions::submit(
                            &host,
                            project,
                            lease,
                            method,
                            params["params"].clone(),
                            params["remember"] == true,
                        )
                        .await
                    } else {
                        super::workbench_submissions::reconcile(
                            &host,
                            project,
                            lease,
                            method,
                            params["params"].clone(),
                        )
                        .await
                    }
                }
                "cloud.attach" => {
                    let source = host
                        .gateway
                        .workbench
                        .backend
                        .source
                        .borrow()
                        .clone()
                        .context("FORBIDDEN")?;
                    ensure!(params["sourceId"] == source, "FORBIDDEN");
                    host.schedules
                        .connections
                        .workbench_cloud_attach(&host, &source, &params)
                        .await
                }
                "core.attach" | "core.detach" | "core.media" | "core.blob" => {
                    workbench_core_call(&host, &call, &params).await
                }
                "core.request" if params.get("lease").is_some() => {
                    workbench_core_call(&host, &call, &params).await
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

async fn workbench_core_call(host: &Rc<Host>, method: &str, params: &Value) -> Result<Value> {
    let source = params["sourceId"].as_str().context("INVALID_PARAMS")?;
    let project = params["projectId"].as_str().context("INVALID_PARAMS")?;
    ensure!(
        host.gateway.workbench.backend_has_source(source),
        "FORBIDDEN"
    );
    let remote = params["lease"].as_str().is_some_and(|lease| {
        host.schedules
            .connections
            .workbench_remote(source, project, lease)
    });
    if !remote {
        backend_project_alias(host, source, project)?;
    }
    let connections = &host.schedules.connections;
    if method == "core.attach" {
        return connections
            .workbench_attach(host, project, params["scope"].as_str())
            .await;
    }
    let lease = params["lease"].as_str().context("INVALID_PARAMS")?;
    if method == "core.detach" {
        return connections.workbench_detach(host, project, lease);
    }
    if method == "core.blob" {
        return connections
            .workbench_blob(host, project, lease, params)
            .await;
    }
    if method == "core.media" {
        return connections
            .workbench_media(host, project, lease, params)
            .await;
    }
    connections
        .workbench_request(
            host,
            project,
            lease,
            params["method"].as_str().context("INVALID_PARAMS")?,
            params["params"].clone(),
        )
        .await
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

pub(super) fn frontend_options(host: &Host, source: &str, options: Value) -> Result<Value> {
    let profile = host.migration.source_profile(source)?;
    let (_, launch) = launch(host, Ensure { profile, options })?;
    ensure!(launch.source_id.as_deref() == Some(source), "FORBIDDEN");
    Ok(launch.options)
}

#[cfg(test)]
#[path = "workbench_route_receipt_tests.rs"]
mod receipt_tests;
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn task_rejection_is_recovered_for_original_workbench_command() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;
        tokio::task::LocalSet::new().run_until(async {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().canonicalize().unwrap();
            let (host, input, source) = resumable_host(&root);
            host.slots.borrow_mut().get_mut("project").unwrap().registration.source =
                crate::ProjectSource::Gui { profile: input.profile.clone(), legacy_project_id: "logical".into() };
            host.gateway.workbench.ensure_backend(&host, input).await.unwrap();
            host.gateway.workbench.test_source(&source);
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let registration = host.slots.borrow()["project"].registration.clone();
            let service = areal_protocol::service::Service {
                identity: areal_protocol::service::Identity { protocol_version: 1, service_id: "fixture".into(), generation: "first".into(), workspace: registration.workspace, data_dir: registration.data_dir, config_fingerprint: "fixture".into() },
                owner: Some(host.owner()), endpoint: format!("ws://{}/", listener.local_addr().unwrap()), web_url: String::new(), auth_file: host.home.join("core-auth.json"), log_file: host.home.join("core.log"), host_pid: 1, core_pid: 2, state: areal_protocol::service::State::Ready,
            };
            areal_local_service::storage::write(&service.auth_file, &json!({"principals":[{"id":"desktop-owner","token":"fixture"}]})).unwrap();
            let gate = host.slots.borrow()["project"].gate.clone();
            let _guard = gate.write().await;
            { let mut slots = host.slots.borrow_mut(); let slot = slots.get_mut("project").unwrap(); slot.service = Some(service.clone()); slot.state = "ready".into(); let (writer, lifetime) = areal_local_service::OwnerLifetime::pair().unwrap(); slot.writer = Some(writer); slot.lifetime = Some(Rc::new(lifetime)); }
            let count = Rc::new(std::cell::Cell::new(0)); let observed = count.clone();
            let server = tokio::task::spawn_local(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                while let Some(Ok(Message::Text(text))) = socket.next().await {
                    let call: Value = serde_json::from_str(&text).unwrap();
                    if call.get("id").is_none() { continue; }
                    let response = match call["method"].as_str().unwrap() {
                        "initialize" => json!({"id":call["id"],"result":{}}),
                        "areal/conversation/list" | "areal/work/overview" => json!({"id":call["id"],"result":{"data":[],"nextCursor":null}}),
                        "areal/task/stopRun" => { observed.set(observed.get()+1); if call["params"]["taskId"] == "lost" { break; } json!({"id":call["id"],"error":{"code":-32009,"message":"private","data":{"outcome":{"kind":"rejected"}}}}) },
                        method => panic!("unexpected {method}"),
                    };
                    socket.send(Message::Text(response.to_string().into())).await.unwrap();
                }
            });
            let close = host.schedules.connections.connect_test_core(host.clone(), "project", service).await.unwrap();
            let command = uuid::Uuid::new_v4().to_string();
            let request = json!({"method":"manage.command","commandId":command,"params":{"sourceId":source,"projectId":"logical","operation":"taskStopRun","taskId":"task","expectedRevision":9,"expectedRunId":"run"}});
            for _ in 0..2 {
                let error = backend_command(&host, "local", &request).await.unwrap_err();
                assert_eq!(super::super::task_catalog::task_rejection_response(&error).unwrap()["coreCode"], -32009);
            }
            assert_eq!(count.get(), 1);
            let mut changed = request.clone(); changed["params"]["expectedRevision"] = json!(10);
            assert_eq!(backend_command(&host, "local", &changed).await.unwrap_err().to_string(), "COMMAND_CONFLICT");
            let mut foreign = request.clone(); foreign["params"]["sourceId"] = json!("different-source");
            assert_eq!(backend_command(&host, "local", &foreign).await.unwrap_err().to_string(), "COMMAND_CONFLICT");
            assert!(backend_receipt(&host, "local", &command).unwrap_err().downcast_ref::<super::super::task_catalog::TaskRejection>().is_some());
            let mut lost = request.clone(); lost["commandId"] = json!(uuid::Uuid::new_v4().to_string()); lost["params"]["taskId"] = json!("lost");
            let unknown = backend_command(&host, "local", &lost).await.unwrap();
            assert_eq!(unknown["submissionUnknown"], true);
            assert_eq!(backend_command(&host, "local", &lost).await.unwrap(), unknown);
            assert_eq!(count.get(), 2);
            close(); server.abort(); host.gateway.workbench.stop_backend().await;
        }).await;
    }

    // 只替代 Node 业务装配，恢复、来源校验、启动记录和子进程监督均走正式路径。
    fn resumable_host(root: &Path) -> (Rc<Host>, Ensure, String) {
        let mut host = crate::server::schedules::tests::fixture(root);
        host.bin = root.join("target/debug");
        for path in [
            host.bin.clone(),
            root.join("services/workbench/src"),
            root.join("clients/gui/app"),
            root.join("profile"),
            root.join("data"),
        ] {
            areal_local_service::storage::private_dir(&path).unwrap();
        }
        std::fs::write(host.bin.join("areal"), "").unwrap();
        std::fs::write(root.join("services/workbench/package.json"), "{}").unwrap();
        std::fs::write(root.join("services/workbench/src/backend-main.cjs"), r#"
            const readline = require('node:readline');
            const out = frame => console.log(JSON.stringify({version:1,...frame}));
            readline.createInterface({input:process.stdin}).on('line', line => {
                const frame = JSON.parse(line);
                if (frame.method === 'backend.start') {
                    out({event:'ready',methods:['providers.read','pages.command'],service:{pid:process.pid,identity:String(process.pid)}});
                } else if (frame.params?.crash) {
                    process.exit(1);
                } else if (frame.id !== undefined) {
                    out({id:frame.id,result:frame.method === 'providers.read' ? {models:[]} : {pid:process.pid}});
                }
            });
        "#).unwrap();
        let source = crate::migration::Source {
            profile: root.join("profile"),
            core_home: root.join("data"),
            legacy_service_home: root.join("legacy"),
        };
        host.migration
            .attach(source.clone(), "fixture", None)
            .unwrap();
        let imported = host.migration.import(serde_json::from_value(json!({
            "requestId": uuid::Uuid::new_v4().to_string(), "expectedGeneration":host.identity.generation, "source":source,
        })).unwrap(), "fixture", &[], &host.journal).unwrap();
        assert_eq!(imported["kind"], "ready");
        let source_id = host
            .migration
            .navigation_source_id(&source.profile)
            .unwrap()
            .unwrap();
        let input = Ensure {
            profile: source.profile.clone(),
            options: json!({
                "binary":host.bin.join("areal"),"home":source.core_home,"guiProfile":source.profile,"hostHome":host.home,"userHome":root,
            }),
        };
        (Rc::new(host), input, source_id)
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cold_backend_read_and_managed_requests_resume_the_persisted_launch() {
        tokio::task::LocalSet::new().run_until(async {
            let root = tempfile::tempdir().unwrap();
            let root = root.path().canonicalize().unwrap();
            let (host, input, source) = resumable_host(&root);
            host.gateway.workbench.ensure_backend(&host, input).await.unwrap();
            host.gateway.workbench.stop_backend().await;
            assert!(launch_record(&host).is_file());
            // 重建 Host，只有磁盘记录，不保留 Supervisor 内存状态。
            let (host, _, _) = resumable_host(&root);
            let request = json!({"method":"providers.read","params":{"sourceId":source,"operation":"list"}});
            assert_eq!(backend_read(&host, "web:fixture", &request).await.unwrap(), json!({"models":[]}));
            let mut forged = request.clone();
            forged["params"]["sourceId"] = json!("forged");
            assert_eq!(backend_read(&host, "web:fixture", &forged).await.unwrap_err().to_string(), "FORBIDDEN");
            host.gateway.workbench.stop_backend().await;
            let (host, _, _) = resumable_host(&root);
            let page = host.gateway.workbench.request(&host, "pages.command", json!({}), json!({"connection":"fixture"})).await.unwrap();
            assert!(page["pid"].as_u64().is_some());
            host.gateway.workbench.stop_backend().await;
        }).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn backend_first_exit_recovers_immediately_but_repeated_exits_back_off() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let root = tempfile::tempdir().unwrap();
                let (host, input, _) = resumable_host(&root.path().canonicalize().unwrap());
                let original = host
                    .gateway
                    .workbench
                    .ensure_backend(&host, input)
                    .await
                    .unwrap();
                let request = |params| {
                    host.gateway.workbench.request(
                        &host,
                        "pages.command",
                        params,
                        json!({"connection":"fixture"}),
                    )
                };
                assert!(request(json!({"crash":true})).await.is_err());
                let restarted = request(json!({})).await.unwrap();
                assert_ne!(restarted["pid"], original["pid"]);
                assert!(request(json!({"crash":true})).await.is_err());
                let error = request(json!({})).await.unwrap_err();
                assert_eq!(
                    error.downcast_ref::<crate::wire::Error>().unwrap().code,
                    "CAPABILITY_UNAVAILABLE"
                );
                tokio::time::sleep(Duration::from_millis(1100)).await;
                assert!(request(json!({})).await.is_ok());
                host.gateway.workbench.stop_backend().await;
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn analytics_first_exit_recovers_immediately_but_repeated_exits_back_off() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let root = tempfile::tempdir().unwrap();
                let (host, _, _) = resumable_host(&root.path().canonicalize().unwrap());
                std::fs::write(
                    root.path().join("services/workbench/src/main.cjs"),
                    r#"
                const out = frame => console.log(JSON.stringify({version:1,...frame}));
                out({event:'ready',methods:['analytics.read']});
                require('node:readline').createInterface({input:process.stdin}).on('line', line => {
                    const frame = JSON.parse(line);
                    if (frame.params.crash) process.exit(1);
                    out({id:frame.id,result:{pid:process.pid}});
                });
            "#,
                )
                .unwrap();
                let request = |params| {
                    host.gateway
                        .workbench
                        .request(&host, "analytics.read", params, json!({}))
                };
                let original = request(json!({})).await.unwrap();
                assert!(request(json!({"crash":true})).await.is_err());
                let restarted = request(json!({})).await.unwrap();
                assert_ne!(restarted, original);
                assert!(request(json!({"crash":true})).await.is_err());
                assert_eq!(
                    request(json!({})).await.unwrap_err().to_string(),
                    "CAPABILITY_UNAVAILABLE"
                );
                tokio::time::sleep(Duration::from_millis(1100)).await;
                assert!(request(json!({})).await.is_ok());
                host.gateway.workbench.stop().await;
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn backend_business_errors_preserve_only_codes_supported_by_the_host() {
        tokio::task::LocalSet::new().run_until(async {
            let root = tempfile::tempdir().unwrap();
            let host = Rc::new(crate::server::schedules::tests::fixture(root.path()));
            let app = root.path().join("app");
            let package = app.join("node_modules/@areal/workbench-service");
            std::fs::create_dir_all(&package).unwrap();
            std::fs::write(app.join("package.json"), "{}").unwrap();
            std::fs::write(package.join("package.json"), r#"{"exports":{"./desktop/core/service-main.cjs":"./main.cjs"}}"#).unwrap();
            std::fs::write(package.join("main.cjs"), r#"
                exports.createMainDesktop = async () => ({backend:{cloud:{}},adapter:{
                    listen:async () => ({pid:process.pid,identity:'fixture'}),
                    executeRemote:async (_, params) => { throw Object.assign(Error('private detail'), {code:params.code}); }
                },close:async () => {}});
            "#).unwrap();
            let runtime = std::env::split_paths(&std::env::var_os("PATH").unwrap())
                .map(|path| path.join("node")).find(|path| path.is_file()).unwrap();
            let runner = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../services/workbench/src/backend-main.cjs");
            let data = root.path().join("data");
            std::fs::create_dir(&data).unwrap();
            let (backend, _) = Workbench::start_with(&runtime, &runner, root.path(), reverse(&host), Some(("backend.start", json!({
                "appRoot":app,"options":{"home":data,"userHome":root.path()},
            })))).await.unwrap();
            for (code, expected) in [(json!("COMMAND_CONFLICT"), "COMMAND_CONFLICT"), (json!("TURN_BUSY"), "TURN_BUSY"), (json!("MIGRATION_PENDING"), "MIGRATION_PENDING"), (json!("migrationBlocked"), "migrationBlocked"), (json!("ENOENT"), "CORE_UNAVAILABLE"), (json!(-32602), "CORE_UNAVAILABLE")] {
                assert_eq!(backend.request("providers.read", json!({"code":code}), json!({})).await.unwrap_err().to_string(), expected);
            }
            backend.stop().await.unwrap();
        }).await;
    }

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
    async fn local_gui_source_worktree_profile_keeps_native_admission_and_identity() {
        tokio::task::LocalSet::new().run_until(async {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().canonicalize().unwrap();
            let (host, input, source) = resumable_host(&root);
            host.slots.borrow_mut().get_mut("project").unwrap().registration.source =
                crate::ProjectSource::Gui { profile:input.profile.clone(), legacy_project_id:"logical".into() };
            host.gateway.workbench.ensure_backend(&host,input).await.unwrap();
            host.gateway.workbench.test_source(&source);
            assert_eq!(super::super::plugins::backend_project_id(&host,"logical").unwrap(),"project");
            assert_eq!(super::super::plugins::backend_project_id(&host,"other").unwrap_err().to_string(),"RESOURCE_UNAVAILABLE");
            let home=super::super::library_store::source_home(&host,&source).unwrap();
            let creation=uuid::Uuid::new_v4().to_string();
            areal_local_service::storage::private_dir(&home.join("worktree-requests")).unwrap();
            areal_local_service::storage::write(&home.join("worktree-requests").join(format!("{creation}.json")),
                &json!({"requestId":creation,"projectId":"logical","state":"ready","threadId":"original-thread","record":{"directory":root.join("workspace")}})).unwrap();
            let command=uuid::Uuid::new_v4().to_string();
            let request=json!({"method":"worktree.command","commandId":command,"params":{"sourceId":source,"projectId":"logical","operation":"worktreeOpen","requestId":uuid::Uuid::new_v4().to_string(),"worktreeRequestId":creation,"agentProfile":{"id":"areal-standard","revision":"resources-existing"}}});
            let mut old_params=request["params"].clone();
            old_params.as_object_mut().unwrap().remove("agentProfile");
            assert_eq!(serde_json::to_value(serde_json::from_value::<areal_protocol::host::LocalWorktreeCommandInput>(old_params.clone()).unwrap()).unwrap(),
                serde_json::to_value(serde_json::from_value::<areal_protocol::host::WorkbenchWorktreeCommandParams>(old_params).unwrap()).unwrap());
            let receipt=backend_command(&host,"local",&request).await.unwrap();
            assert_eq!(receipt["submissionUnknown"],false);
            assert_eq!(receipt["receipt"]["threadId"],"original-thread");
            assert_eq!(backend_command(&host,"local",&request).await.unwrap(),receipt);
            let mut changed=request.clone();
            changed["params"]["agentProfile"]["revision"]=json!("different-revision");
            assert_eq!(backend_command(&host,"local",&changed).await.unwrap_err().to_string(),"COMMAND_CONFLICT");
            let mut foreign=request.clone();
            foreign["commandId"]=json!(uuid::Uuid::new_v4().to_string());
            foreign["params"]["sourceId"]=json!("foreign-source");
            assert_eq!(backend_command(&host,"local",&foreign).await.unwrap_err().to_string(),"FORBIDDEN");
            assert!(backend_receipt(&host,"local",foreign["commandId"].as_str().unwrap()).unwrap().is_none());
            assert_eq!(backend_command(&host,"web:fixture",&request).await.unwrap_err().to_string(),"INVALID_PARAMS");
            host.gateway.workbench.stop_backend().await;
        }).await;
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
