//! Host 到工作台服务的路由：懒启动、退避重启、反向调用与 Core 事件转发。设计见 docs/design/workbench-service.md。
use super::Host;
use crate::workbench::{Reverse, Workbench, restart_delay};
use anyhow::{Context, Result, bail, ensure};
use areal_local_service::storage;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    os::fd::AsRawFd,
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
    "desktop.command",
];
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
    if method == "feedback.command" {
        return match params["operation"].as_str()? {
            "refine" => Some("submit"),
            "close" => Some("interrupt"),
            _ => None,
        };
    }
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
    analytics: Rc<super::analytics::Analytics>,
    providers: Rc<super::provider_catalog::Providers>,
    feedback: super::feedback::Feedback,
    trajectory: Rc<super::trajectory::Trajectory>,
    pub(super) side_owners: super::side_owners::SideWindowOwners,
    workspace_ops: super::workspace_ops::WorkspaceOps,
    manage_service: super::manage_service::ManageService,
    pub(super) resources: super::resources::Resources,
    pub(super) cloud: super::cloud::Cloud,
    pub(super) projectless: super::projectless::Projectless,
    /// 桌面后台：界面 Main 原来在进程内启动的 CoreBackend + DesktopService，改由 Host 监督。
    backend: Backend,
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
    environment_credentials: RefCell<Option<EnvironmentCredentials>>,
    events: RefCell<Vec<Value>>,
    worktree_cleaning: Cell<bool>,
}

#[derive(Clone)]
struct EnvironmentCredentials {
    source_id: String,
    launch_key: String,
    values: std::collections::BTreeMap<String, String>,
}

/// Main 传来的桌面后台启动参数。`options` 是界面 Main 的启动选项，Host 只读取并校验路径字段：
/// 数据目录仍是原 GUI home，不搬家。`appRoot` 由 Host 从已签名安装包推导，不接受客户端指定。
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Ensure {
    profile: PathBuf,
    options: Value,
    #[serde(default, skip_serializing)]
    environment_credentials: Option<std::collections::BTreeMap<String, String>>,
}

/// 剩余桌面后台入口；发行包使用签名资源内的运行时。
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
    owner: PreparedOwner,
    pub params: Value,
    pub source: String,
    dispatched: bool,
}
enum PreparedOwner {
    Creation(super::execution_preparation::PreparedCreation),
    Core(super::execution_preparation::PreparedCore),
}
impl PreparedExecution {
    pub(super) async fn dispatch(&mut self) -> Result<Value> {
        ensure!(!self.dispatched, "SUBMISSION_UNKNOWN");
        self.dispatched = true;
        match &self.owner {
            PreparedOwner::Creation(creation) => {
                creation.dispatch(&self.source, &self.params).await
            }
            PreparedOwner::Core(core) => core.dispatch(&self.source, &self.params).await,
        }
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
    pub(super) fn owns_client_process(&self, pid: u32) -> bool {
        self.backend
            .running
            .borrow()
            .as_ref()
            .is_some_and(|child| child.owns_process(pid))
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
    pub(super) fn provider_revision(&self, host: &Host, source: &str) -> Option<String> {
        self.backend_has_source(source)
            .then(|| self.providers.revision(host, source).ok())
            .flatten()
    }
    pub(super) fn backend_source(&self) -> Option<String> {
        self.backend.source.borrow().clone()
    }
    pub(super) fn has_running_backend(&self) -> bool {
        self.backend
            .running
            .borrow()
            .as_ref()
            .is_some_and(|child| !child.closed())
    }
    #[cfg(test)]
    pub(super) fn set_test_environment_credentials(
        &self,
        source: &str,
        values: std::collections::BTreeMap<String, String>,
    ) {
        *self.backend.environment_credentials.borrow_mut() = Some(EnvironmentCredentials {
            source_id: source.to_owned(),
            launch_key: String::new(),
            values,
        });
    }
    #[cfg(test)]
    pub(super) fn set_test_source_and_options(&self, source: &str, options: Value) {
        *self.backend.source.borrow_mut() = Some(source.to_owned());
        *self.backend.utility_options.borrow_mut() = Some(options);
    }

    pub(super) async fn prepare_execution(
        &self,
        host: &Rc<Host>,
        _connection: &str,
        project: &str,
        method: &str,
        mut params: Value,
    ) -> Result<Option<PreparedExecution>> {
        if method == "workbench/thread/create" {
            self.restore_source(host)?;
            let source = self.active_source().context("CAPABILITY_UNAVAILABLE")?;
            let alias = backend_project_alias(host, &source, project)?;
            ensure!(
                params.get("projectId").is_none_or(|id| id == &alias),
                "INVALID_PARAMS"
            );
            params["projectId"] = json!(alias);
            let creation =
                super::execution_preparation::prepare(host, &source, &alias, &params).await?;
            return Ok(Some(PreparedExecution {
                owner: PreparedOwner::Creation(creation),
                params,
                source,
                dispatched: false,
            }));
        }
        self.restore_source(host)?;
        let Some(source) = self.active_source() else {
            return Ok(None);
        };
        backend_project_alias(host, &source, project)?;
        let core =
            super::execution_preparation::prepare_core(host, &source, project, method, &mut params)
                .await?;
        Ok(Some(PreparedExecution {
            owner: PreparedOwner::Core(core),
            params,
            source,
            dispatched: false,
        }))
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
        let mut result =
            super::worktree_catalog::read_thread_target(host, source, &alias, params.clone())
                .await?;
        ensure!(
            self.backend_has_source(source)
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
        if method.starts_with("analytics.") {
            return self
                .analytics
                .request(host, method, &params, &context)
                .await;
        }
        if method == "providers.read" {
            self.restore_source(host)?;
            let source = self.backend_source().context("CAPABILITY_UNAVAILABLE")?;
            return self.providers.read(host, &source);
        }
        if matches!(
            method,
            "worktree.read"
                | "worktree.command"
                | "tasks.read"
                | "manage.read"
                | "manage.command"
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
        bail!("methodNotFound")
    }

    /// 统计直接观察 Core 事实，不为事件启动工作台。
    pub(super) fn core_event(&self, home: &Path, project_id: &str, event: &Value) {
        self.analytics.observe(home, project_id, event);
    }

    pub(super) async fn stop(&self) {
        self.analytics.flush();
    }

    pub(super) async fn discover_provider(
        &self,
        host: &Rc<Host>,
        source: &str,
        connection: Value,
    ) -> Result<Value> {
        super::provider_probe::command(
            host,
            source,
            &json!({"operation":"discover","connection":connection}),
        )
        .await
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

    pub(super) fn credential_names(&self, host: &Host, input: Ensure) -> Result<Value> {
        ensure!(input.environment_credentials.is_none(), "INVALID_PARAMS");
        let (_, launch) = launch(host, input)?;
        match environment_credential_names(&launch.options) {
            Ok(names) => Ok(json!({"names": names})),
            Err(error)
                if error
                    .downcast_ref::<areal_config::ConfigError>()
                    .is_some_and(|error| error.kind != areal_config::ConfigErrorKind::Io) =>
            {
                Ok(json!({"names": [], "configurationError": true}))
            }
            Err(error) => Err(error),
        }
    }

    pub(super) fn environment_credentials(
        &self,
        source: &str,
    ) -> std::collections::BTreeMap<String, String> {
        self.backend
            .environment_credentials
            .borrow()
            .as_ref()
            .filter(|credentials| credentials.source_id == source)
            .map(|credentials| credentials.values.clone())
            .unwrap_or_default()
    }

    pub(super) fn project_environment_credentials(
        &self,
        project: &crate::ProjectRegistration,
        source: Option<&str>,
        names: &mut Vec<String>,
    ) -> std::collections::BTreeMap<String, String> {
        let credentials = if matches!(project.source, crate::ProjectSource::Gui { .. }) {
            source
                .map(|source| self.environment_credentials(source))
                .unwrap_or_default()
        } else {
            Default::default()
        };
        for name in credentials.keys() {
            if !names.contains(name) {
                names.push(name.clone());
            }
        }
        credentials
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

    /// 原生领域只恢复经过校验的来源与配置输入，不为读取目录启动过渡后台。
    pub(super) fn restore_source(&self, host: &Host) -> Result<()> {
        if self.active_source().is_some() {
            return Ok(());
        }
        let Some(input) = storage::read_optional::<Ensure>(&launch_record(host))? else {
            return Ok(());
        };
        let (_, launch) = launch(host, input)?;
        *self.backend.source.borrow_mut() = launch.source_id;
        *self.backend.utility_options.borrow_mut() = Some(launch.options);
        if let Some(source) = self.backend_source() {
            // 配置导入失败只由模型读取/执行报告，不阻塞任务目录与历史等独立读取。
            let _ = super::provider_config::import_saved_configuration(
                host,
                &source,
                &self.utility_options(&source)?,
            );
        }
        Ok(())
    }

    /// 当前桌面后台的所有权：Main 用它区分“Host 监督的本机后台”和旧应用会话遗留的后台。
    pub(super) async fn backend_status(&self, host: &Rc<Host>) -> Result<Value> {
        self.backend.status(host)
    }

    pub(super) async fn stop_backend(&self) {
        self.backend.stop().await;
    }

    pub(super) fn disconnect_connection(&self, host: &Rc<Host>, connection: &str) {
        self.side_owners.disconnect(host, connection);
        let Some(backend) = self.backend.running.borrow().clone() else {
            return;
        };
        let connection = connection.to_owned();
        tokio::task::spawn_local(async move {
            backend
                .notify("connection.disconnect", json!({"connection":connection}))
                .await;
        });
    }
}

fn backend_rejection(receipt: &Value, error: &Value) -> anyhow::Error {
    if matches!(
        receipt["method"].as_str(),
        Some("providers.command" | "trajectory.command")
    ) && error["code"] == "RESOURCE_UNAVAILABLE"
    {
        return crate::wire::error(
            "RESOURCE_UNAVAILABLE",
            error["message"].as_str().unwrap_or("供应商连接不可用"),
        );
    }
    if receipt["method"] == "manage.command" && error.get("data").is_none() {
        let code = match error["code"].as_str() {
            Some("COMMAND_FAILED") => Some("COMMAND_FAILED"),
            Some("scheduleWorkspaceRequired") => Some("scheduleWorkspaceRequired"),
            Some("RESOURCE_UNAVAILABLE") => Some("RESOURCE_UNAVAILABLE"),
            Some("INVALID_PARAMS") => Some("INVALID_PARAMS"),
            Some("FORBIDDEN") => Some("FORBIDDEN"),
            Some("TARGET_CHANGED") => Some("TARGET_CHANGED"),
            Some("PROFILE_NOT_SUPPORTED") => Some("PROFILE_NOT_SUPPORTED"),
            _ => None,
        };
        if let Some(code) = code {
            return crate::wire::error(
                code,
                error["message"].as_str().unwrap_or("Host command failed"),
            );
        }
    }
    super::task_catalog::TaskRejection(error.clone()).into()
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
    if let Some(value) = &receipt
        && let Some(error) = value.get("error")
    {
        return Err(backend_rejection(value, error));
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
            return Err(backend_rejection(&original, error));
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
    let standalone_worktree = method == "worktree.command" && source == "host";
    let native_task = method == "manage.command"
        && super::task_catalog::mutation(params["operation"].as_str().unwrap_or("")).is_some();
    let native_manage = method == "manage.command" && !native_task;
    if !standalone_worktree {
        host.gateway.workbench.restore_source(host)?;
        ensure!(
            host.gateway.workbench.active_source().is_some(),
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
    let native_library = method == "library.command";
    let native_provider = method == "providers.command";
    let native_feedback = method == "feedback.command";
    let native_trajectory = method == "trajectory.command";
    let result = if native_library {
        super::library_service::command(host, &source, payload).await
    } else if method == "worktree.command" {
        super::worktree_catalog::command(host, &source, payload).await
    } else if native_provider {
        if super::provider_probe::native(&payload) {
            super::provider_probe::command(host, &source, &payload).await
        } else {
            host.gateway
                .workbench
                .providers
                .write(host, &source, &command, &payload)
                .await
        }
    } else if native_feedback {
        host.gateway
            .workbench
            .feedback
            .command(host, &source, &command, payload)
            .await
    } else if native_trajectory {
        host.gateway
            .workbench
            .trajectory
            .command(host, &source, payload)
            .await
    } else if native_task {
        payload["sourceId"] = json!(source);
        super::task_catalog::command(host, &payload).await
    } else if native_manage {
        host.gateway
            .workbench
            .manage_service
            .command_rpc(host, &source, &command, payload)
            .await
    } else {
        bail!("methodNotFound")
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
            .or_else(|| {
                native_provider
                    .then(|| super::provider_probe::rejection(&error))
                    .flatten()
            })
            .or_else(|| {
                native_feedback
                    .then(|| super::feedback::rejection(&error))
                    .flatten()
            })
            .or_else(|| {
                native_trajectory
                    .then(|| super::trajectory::rejection(&error))
                    .flatten()
            })
            .or_else(|| {
                native_manage
                    .then(|| super::manage_service::rejection(&error))
                    .flatten()
            }) {
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
        return Err(backend_rejection(&receipt, error));
    }
    receipt.as_object_mut().unwrap().remove("semanticDigest");
    Ok(receipt)
}

pub(super) fn desktop_command_capability(params: &Value) -> Option<&'static str> {
    let command = params.get("command")?.as_str()?;
    let operation = params
        .get("request")
        .and_then(|req| req.get("operation"))
        .and_then(Value::as_str);
    match command {
        "editMessage" | "continue" | "fork" => Some("submit"),
        "manage" => {
            let op = operation?;
            if MANAGE_SUBMIT_OPERATIONS.contains(&op) {
                Some("submit")
            } else if MANAGE_INTERRUPT_OPERATIONS.contains(&op) {
                Some("interrupt")
            } else {
                None
            }
        }
        "prediction" if operation == Some("request") => Some("submit"),
        "queueEdit" if matches!(operation, Some("update" | "reorder" | "resume" | "steer")) => {
            Some("submit")
        }
        "side" if matches!(operation, Some("start" | "send" | "create")) => Some("submit"),
        _ => None,
    }
}

/// 本机网页的桌面命令：与桌面窗口同一用户，由后台按桌面命令合同校验后执行。
/// 不进 Host journal，丢回复与桌面窗口原路径一样只能重新读取。
pub(super) async fn desktop_command(
    host: &Rc<Host>,
    principal: &str,
    connection: &str,
    request: &Value,
) -> Result<Value> {
    use areal_protocol::host::DesktopCommandParamsFieldCommand as Cmd;
    ensure!(request.get("commandId").is_none(), "INVALID_PARAMS");
    let mut params = serde_json::from_value::<areal_protocol::host::DesktopCommandParams>(
        request["params"].clone(),
    )
    .context("INVALID_PARAMS")?;
    host.admission()?;
    let native_command = match params.command {
        Cmd::Value3 => Some("chatgpt"),
        Cmd::Value4 => Some("cloud"),
        Cmd::Value6 => Some("configure"),
        Cmd::Value8 => Some("continue"),
        Cmd::Value9 => Some("dismissRecovery"),
        Cmd::Value10 => Some("editMessage"),
        Cmd::Value12 => Some("fork"),
        Cmd::Value15 => Some("manage"),
        Cmd::Value18 => Some("prediction"),
        Cmd::Value19 => Some("prepareCreator"),
        Cmd::Value20 => Some("projectless"),
        Cmd::Value22 => Some("queue"),
        Cmd::Value23 => Some("queueEdit"),
        Cmd::Value24 => Some("reconcile"),
        Cmd::Value26 => Some("resources"),
        Cmd::Value27 => Some("side"),
        Cmd::Value30 => Some("workspace"),
        _ => None,
    };
    if let Some(command) = native_command {
        host.gateway.workbench.restore_source(host)?;
        let source = host.gateway.workbench.active_source().ok_or_else(|| {
            crate::wire::error(
                "CAPABILITY_UNAVAILABLE",
                "桌面后台未运行，请先打开一次桌面应用",
            )
        })?;
        ensure!(
            params.source_id.take().is_none_or(|id| id == source),
            "FORBIDDEN"
        );
        return match command {
            "cloud" => {
                host.gateway
                    .workbench
                    .cloud
                    .settings(host, &source, &params.request)
                    .await
            }
            "prepareCreator" => {
                host.gateway
                    .workbench
                    .resources
                    .prepare_creator(host, &source, &params.request)
                    .await
            }
            "resources" => {
                host.gateway
                    .workbench
                    .resources
                    .command(host, &source, &params.request)
                    .await
            }
            "projectless" => {
                host.gateway
                    .workbench
                    .projectless
                    .command(host, &source, &params.request)
                    .await
            }
            "chatgpt" => host.chatgpt_desktop_command(&source, &params.request).await,
            "manage" => {
                host.gateway
                    .workbench
                    .manage_service
                    .desktop_command(host, principal, &source, &params.request)
                    .await
            }
            "side" => {
                host.gateway
                    .workbench
                    .side_owners
                    .command(host, &source, connection, &params.request)
                    .await
            }
            "workspace" => {
                host.gateway
                    .workbench
                    .workspace_ops
                    .execute(host, &source, &params.request)
                    .await
            }
            _ => super::session_commands::execute(host, &source, command, &params.request).await,
        };
    }
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
            json!({"principal":principal,"connection":connection}),
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
    host.gateway.workbench.restore_source(host)?;
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
    if method == "providers.read" {
        return host.gateway.workbench.providers.read(host, &source);
    }
    if method == "trajectory.read" {
        return host
            .gateway
            .workbench
            .trajectory
            .read(host, &source, params);
    }
    if method == "feedback.read" {
        return host
            .gateway
            .workbench
            .feedback
            .read(host, &source, params)
            .await;
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
    if method == "manage.read" {
        params.as_object_mut().unwrap().remove("sourceId");
        let value = host
            .gateway
            .workbench
            .manage_service
            .read_rpc(host, &source, params)
            .await?;
        validate_backend_result(method, &value)?;
        return Ok(value);
    }
    let _ = principal;
    bail!("methodNotFound")
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
        if let Some(credentials) = &input.environment_credentials
            && !credentials.is_empty()
        {
            let allowed = environment_credential_names(&launch.options)?;
            ensure!(
                credentials.keys().all(|name| allowed.contains(name)),
                "INVALID_PARAMS"
            );
        }
        let _guard = self.starting.lock().await;
        ensure!(!self.stopped.get(), "CAPABILITY_UNAVAILABLE");
        let current = self.running.borrow().clone();
        let mut first_exit = false;
        if let Some(workbench) = current {
            if !workbench.closed() {
                let owner = self.ownership.borrow().clone();
                if let Some((current, ownership)) = owner {
                    ensure!(current == key, "CONFLICT");
                    if let Some(credentials) = &input.environment_credentials {
                        let source = launch.source_id.clone().context("GUI_SOURCE_PENDING")?;
                        *self.environment_credentials.borrow_mut() = Some(EnvironmentCredentials {
                            source_id: source,
                            launch_key: key.clone(),
                            values: credentials.clone(),
                        });
                    }
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
        let source_id = source.clone().context("GUI_SOURCE_PENDING")?;
        let previous = self.environment_credentials.borrow().clone();
        let credentials = if let Some(credentials) = &input.environment_credentials {
            credentials.clone()
        } else {
            previous
                .filter(|credentials| {
                    credentials.source_id == source_id && credentials.launch_key == key
                })
                .map(|credentials| credentials.values)
                .unwrap_or_default()
        };
        *self.environment_credentials.borrow_mut() = Some(EnvironmentCredentials {
            source_id,
            launch_key: key.clone(),
            values: credentials,
        });
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
                self.environment_credentials.borrow_mut().take();
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
        let ownership = self.ownership.borrow_mut().take();
        let options = self.utility_options.borrow_mut().take();
        self.environment_credentials.borrow_mut().take();
        let running = self.running.borrow_mut().take();
        if let Some(workbench) = running {
            if workbench.stop().await.is_err() {
                eprintln!("Workbench stop: child exit could not be confirmed");
                return;
            }
            if let (Some((_, owner)), Some(options)) = (ownership, options)
                && retire_backend_record(&options, &owner).is_err()
            {
                eprintln!("Workbench stop: discovery retirement could not be completed");
            }
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
        let owner = crate::workbench_owner::BackendOwner::acquire(
            Path::new(
                launch.options["home"]
                    .as_str()
                    .context("backend home missing")?,
            ),
            &host.identity,
        )?;
        let bootstrap = json!({
            "appRoot": launch.app_root,
            "options": launch.options,
            "retired": self.ownership.borrow().as_ref().map(|(_, value)| value.clone()),
            "owner": owner.identity,
            "leaseFd": owner.lease.as_raw_fd(),
        });
        let (workbench, ready) = Workbench::start_with(
            &entry.runtime,
            &entry.runner,
            &data,
            reverse(host),
            Some(("backend.start", bootstrap)),
            &[owner.lease.as_raw_fd()],
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
        owner.ready(&service)?;
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

fn retire_backend_record(options: &Value, owner: &Value) -> Result<()> {
    let home = options["home"].as_str().context("backend home missing")?;
    let path = Path::new(home).join("service.json");
    let Some(bytes) = areal_local_service::storage::read_bytes(&path)? else {
        return Ok(());
    };
    let record: Value = serde_json::from_slice(&bytes)?;
    let persisted = areal_local_service::storage::read_optional::<Value>(
        &Path::new(home).join("backend-owner.json"),
    )?;
    // 子进程关闭异常或被强制结束时未必执行 finally；Host 等到退出后只结算自己持有的身份。
    if ["pid", "identity", "desktopGeneration"]
        .iter()
        .all(|key| record[key] == owner[key])
        && persisted.is_some_and(|persisted| {
            persisted["owner"]["hostId"] == owner["hostId"]
                && persisted["owner"]["generation"] == owner["generation"]
                && record["owner"] == persisted["owner"]
        })
    {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

fn launch_record(host: &Host) -> PathBuf {
    host.home.join("workbench/backend-launch.json")
}

fn environment_credential_names(options: &Value) -> Result<std::collections::BTreeSet<String>> {
    let inputs = super::workbench_utility::inputs(options)?;
    let (document, resolved) = areal_config::models::read_resolved(&inputs, &[])?;
    Ok(document
        .data
        .into_iter()
        .filter_map(|provider| provider.api_key_env)
        .chain(resolved.model.api_key_env)
        .chain(resolved.trajectory.headers_env)
        .filter(|name| !name.starts_with("AREAL_CREDENTIAL_"))
        .collect())
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
    let source = cfg!(debug_assertions)
        && bin.file_name().is_some_and(|name| name == "debug")
        && bin
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|name| name == "target")
        && bin.join("../../clients/gui/app").is_dir();
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
                "projectless.command" => {
                    let source = host
                        .gateway
                        .workbench
                        .active_source()
                        .context("FORBIDDEN")?;
                    host.gateway
                        .workbench
                        .projectless
                        .command(&host, &source, &params)
                        .await
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
                            params["rejectKnown"] == true,
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
                "cloud.settings" | "cloud.configured.attach" => {
                    let source = host
                        .gateway
                        .workbench
                        .active_source()
                        .context("FORBIDDEN")?;
                    ensure!(params["sourceId"] == source, "FORBIDDEN");
                    if call == "cloud.settings" {
                        host.gateway
                            .workbench
                            .cloud
                            .settings(&host, &source, &params["request"])
                            .await
                    } else {
                        host.gateway
                            .workbench
                            .cloud
                            .attach(&host, &source, &params)
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
                _ => bail!("FORBIDDEN"),
            }
        })
    })
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

pub(super) fn frontend_options(
    host: &Host,
    source: &str,
    options: Value,
    environment_credentials: Option<std::collections::BTreeMap<String, String>>,
) -> Result<Value> {
    host.admission()?;
    let input = Ensure {
        profile: host.migration.source_profile(source)?,
        options,
        environment_credentials,
    };
    let (key, launch) = launch(host, input.clone())?;
    ensure!(launch.source_id.as_deref() == Some(source), "FORBIDDEN");
    if let Some(credentials) = &input.environment_credentials
        && !credentials.is_empty()
    {
        let allowed = environment_credential_names(&launch.options)?;
        ensure!(
            credentials.keys().all(|name| allowed.contains(name)),
            "INVALID_PARAMS"
        );
    }
    let backend = &host.gateway.workbench.backend;
    // 独立终端附件保留自己的来源和选项，不能改绑当前工作台或写它的凭据。
    if backend
        .source
        .borrow()
        .as_deref()
        .is_some_and(|active| active != source)
    {
        ensure!(
            input
                .environment_credentials
                .as_ref()
                .is_none_or(|credentials| credentials.is_empty()),
            "CONFLICT"
        );
        return Ok(launch.options);
    }
    if backend
        .running
        .borrow()
        .as_ref()
        .is_some_and(|running| !running.closed())
    {
        ensure!(
            backend
                .ownership
                .borrow()
                .as_ref()
                .is_some_and(|(existing, _)| existing == &key),
            "CONFLICT"
        );
    }
    let previous = backend.environment_credentials.borrow().clone();
    let credentials = input.environment_credentials.clone().unwrap_or_else(|| {
        previous
            .filter(|previous| previous.source_id == source && previous.launch_key == key)
            .map(|previous| previous.values)
            .unwrap_or_default()
    });
    // 只持久化经校验的路径；环境凭据只留在Host内存，不写入启动记录。
    storage::private_dir(launch_record(host).parent().unwrap())?;
    storage::write(&launch_record(host), &input)?;
    host.retain_for_gui()?;
    *backend.source.borrow_mut() = Some(source.into());
    *backend.utility_options.borrow_mut() = Some(launch.options.clone());
    *backend.environment_credentials.borrow_mut() = Some(EnvironmentCredentials {
        source_id: source.into(),
        launch_key: key,
        values: credentials,
    });
    // 模型配置失败不阻塞独立的历史和管理读取，模型入口保留原错误。
    let _ = super::provider_config::import_saved_configuration(host, source, &launch.options);
    Ok(launch.options)
}

#[cfg(test)]
#[path = "workbench_route_receipt_tests.rs"]
mod receipt_tests;
#[cfg(test)]
#[path = "workbench_route_tests.rs"]
mod tests;
