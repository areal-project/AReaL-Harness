//! Rust Host 的工作台领域路由与 GUI 来源配置。
use super::Host;
use anyhow::{Context, Result, bail, ensure};
use areal_local_service::storage;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    path::{Path, PathBuf},
    rc::Rc,
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
    "worktree.project.add",
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
    "taskDraftSend",
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
#[derive(Default)]
pub(super) struct Supervisor {
    analytics: Rc<super::analytics::Analytics>,
    providers: Rc<super::provider_catalog::Providers>,
    model_network: tokio::sync::Mutex<
        std::collections::BTreeMap<String, (Value, crate::network::NetworkInput)>,
    >,
    feedback: super::feedback::Feedback,
    trajectory: Rc<super::trajectory::Trajectory>,
    pub(super) side_owners: super::side_owners::SideWindowOwners,
    workspace_ops: super::workspace_ops::WorkspaceOps,
    pub(super) manage_service: super::manage_service::ManageService,
    pub(super) resources: super::resources::Resources,
    pub(super) cloud: super::cloud::Cloud,
    pub(super) projectless: super::projectless::Projectless,
    remote_commands: super::remote_commands::RemoteCommands,
    backend: Backend,
}

#[derive(Default)]
pub(super) struct Backend {
    source: RefCell<Option<String>>,
    utility_options: RefCell<Option<Value>>,
    environment_credentials: RefCell<Option<EnvironmentCredentials>>,
    worktree_cleaning: Cell<bool>,
}

#[derive(Clone)]
struct EnvironmentCredentials {
    launch_key: String,
    source_id: String,
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
    /// 同一来源的探测与 Core 共用网络快照；配置变化后失效，系统代理随 Host 代际重读。
    pub(super) async fn model_network(
        &self,
        host: &Host,
        source: &str,
    ) -> Result<crate::network::NetworkInput> {
        let configured = |library: &Value| {
            let settings = &library["settings"];
            Value::Object(
                ["httpProxy", "httpProxyNoProxy", "httpProxyCaCertPath"]
                    .into_iter()
                    .filter_map(|key| settings.get(key).map(|value| (key.into(), value.clone())))
                    .collect(),
            )
        };
        let mut snapshots = self.model_network.lock().await;
        let settings = configured(&super::library_store::read_source(host, source)?);
        if let Some((saved, input)) = snapshots.get(source)
            && *saved == settings
        {
            return Ok(input.clone());
        }
        let environment = std::env::vars_os()
            .filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?)))
            .collect();
        let input = crate::network::desktop(&settings, &environment).await?;
        ensure!(
            configured(&super::library_store::read_source(host, source)?) == settings,
            "RESYNC_REQUIRED"
        );
        snapshots.insert(source.into(), (settings, input.clone()));
        Ok(input)
    }

    pub(super) fn provider_updating(&self) -> bool {
        self.providers.updating()
    }
    // 沿用原后台 init/finishSetup 的清理触发，不在每次目录读取时启动清理。
    pub(super) fn schedule_worktree_cleanup(&self, host: &Rc<Host>, source: &str) {
        if (source != "host" && !self.backend_has_source(source))
            || self.backend.worktree_cleaning.replace(true)
        {
            return;
        }
        let source = source.to_owned();
        let weak = Rc::downgrade(host);
        let task: futures_util::future::LocalBoxFuture<'static, ()> = Box::pin(async move {
            if let Some(host) = weak.upgrade() {
                let current =
                    source == "host" || host.gateway.workbench.backend_has_source(&source);
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

    pub(super) async fn analytics_request(
        &self,
        host: &Rc<Host>,
        method: &str,
        params: &Value,
        context: &Value,
    ) -> Result<Value> {
        self.analytics.request(host, method, params, context).await
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

    pub(super) fn disconnect_connection(&self, host: &Rc<Host>, connection: &str) {
        self.side_owners.disconnect(host, connection);
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
    host.journal.native_receipt(
        &format!("workbench-{}", storage::digest(principal.as_bytes())),
        &command,
    )
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
    let unknown = json!({"commandId":command,"method":method,"admissionState":"accepted","submissionUnknown":true,"semanticDigest":digest});
    if let Some(mut original) =
        host.journal
            .native_admit_workbench(&scope, &command, method, unknown.clone())?
    {
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
        receipt = host
            .journal
            .native_settle_workbench(&scope, &command, method, &digest, receipt)?;
    }
    if let Some(error) = failure {
        return Err(error);
    }
    if let Some(code) = receipt["settledFailure"].as_str() {
        return Err(anyhow::anyhow!("{code}"));
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
        "media" if operation == Some("release") => Some("submit"),
        _ => None,
    }
}

/// 桌面与本机网页共用 Host 的命令入口；各领域负责准入、持久化及回执。
pub(super) fn desktop_command<'a>(
    host: &'a Rc<Host>,
    principal: &'a str,
    connection: &'a str,
    request: &'a Value,
) -> futures_util::future::LocalBoxFuture<'a, Result<Value>> {
    // 多领域分发的 future 固定在堆上，避免每个调用方内联保存整棵异步状态。
    Box::pin(async move {
        use areal_protocol::host::DesktopCommandParamsFieldCommand as Cmd;
        ensure!(request.get("commandId").is_none(), "INVALID_PARAMS");
        let mut params = serde_json::from_value::<areal_protocol::host::DesktopCommandParams>(
            request["params"].clone(),
        )
        .context("INVALID_PARAMS")?;
        host.admission()?;
        let command = match params.command {
            Cmd::Value1 => "chatgpt",
            Cmd::Value2 => "cloud",
            Cmd::Value3 => "cloudSession",
            Cmd::Value4 => "configure",
            Cmd::Value5 => "connect",
            Cmd::Value6 => "continue",
            Cmd::Value7 => "dismissRecovery",
            Cmd::Value8 => "editMessage",
            Cmd::Value9 => "fork",
            Cmd::Value10 => "manage",
            Cmd::Value11 => "media",
            Cmd::Value12 => "prediction",
            Cmd::Value13 => "prepareCreator",
            Cmd::Value14 => "projectless",
            Cmd::Value15 => "queue",
            Cmd::Value16 => "queueEdit",
            Cmd::Value17 => "reconcile",
            Cmd::Value18 => "remoteControl",
            Cmd::Value19 => "resources",
            Cmd::Value20 => "side",
            Cmd::Value21 => "workspace",
            Cmd::Value22 => "recovery",
        };
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
        match command {
            "recovery" => {
                let mut query = params.request;
                let operation = query
                    .as_object_mut()
                    .context("INVALID_PARAMS")?
                    .remove("operation")
                    .context("INVALID_PARAMS")?;
                match operation.as_str() {
                    Some("history") => {
                        crate::space::history::for_host(&host.home, serde_json::from_value(query)?)
                            .await
                    }
                    Some("importProvider") => host.import_provider(serde_json::from_value(query)?),
                    Some("inspect" | "openWorkspace") => {
                        let catalog = crate::space::inspect_params_for_host(&host.home, &query)?;
                        if operation == "inspect" {
                            return Ok(catalog);
                        }
                        let root = catalog["workspace"]
                            .as_str()
                            .context("RESOURCE_UNAVAILABLE")?;
                        super::worktree_catalog::add_project(host, &source, json!({"root":root}))
                            .await
                    }
                    _ => anyhow::bail!("INVALID_PARAMS"),
                }
            }
            "remoteControl" => {
                host.gateway
                    .workbench
                    .remote_commands
                    .command(host, &source, &params.request)
                    .await
            }
            "cloudSession" => {
                Box::pin(host.gateway.workbench.cloud.sessions.command(
                    host,
                    &source,
                    &params.request,
                ))
                .await
            }
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
            "media" => Box::pin(attachment_inventory_command(host, &source, &params.request)).await,
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
        }
    })
}

async fn attachment_inventory_command(
    host: &Rc<Host>,
    source: &str,
    request: &Value,
) -> Result<Value> {
    use super::session_commands::{resolve_project_scope, shared_rpc};
    let thread = request["threadId"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 256)
        .context("INVALID_PARAMS")?;
    let release = match request["operation"].as_str() {
        Some("list") => false,
        Some("release") => true,
        _ => bail!("INVALID_PARAMS"),
    };
    let scope = resolve_project_scope(host, source, request, release, true).await?;
    if !release {
        let result = shared_rpc(
            host,
            &scope.canonical_id,
            "thread/read",
            json!({"threadId": thread, "includeTurns": false}),
        )
        .await?;
        let desktop = &result["thread"]["desktop"];
        return Ok(json!({
            "uploads": desktop["uploads"].as_array().map(Vec::as_slice).unwrap_or_default(),
            "archived": desktop["archived"] == true,
        }));
    }
    let uri = request["uri"].as_str().context("INVALID_PARAMS")?;
    super::conversation_media::digest(uri).map_err(|_| anyhow::anyhow!("INVALID_PARAMS"))?;
    let id = match request.get("requestId") {
        Some(id) => id.as_str().context("INVALID_PARAMS")?.to_owned(),
        None => uuid::Uuid::new_v4().to_string(),
    };
    super::workbench_submissions::submit_shared(
        host,
        &scope.canonical_id,
        "areal/blob/release",
        json!({"threadId": thread, "uri": uri, "requestId": id}),
        true,
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
        return super::task_catalog::read(host, principal, &params).await;
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
    options: Value,
}

/// 校验原生 GUI 来源配置，数据目录保持已登记的 GUI home，Core 必须与 Host 同属一套构建。
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
    Ok((
        serde_json::to_string(&options)?,
        Launch {
            options,
            source_id: None,
        },
    ))
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
