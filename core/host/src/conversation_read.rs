use super::{
    Host,
    conversation_media::{self, MediaCache, MediaParams, MediaReference},
    schedule_connection::{CoreEvent, CoreObservation},
};
use anyhow::{Context, Result, ensure};
use areal_local_service::storage;
use areal_protocol::service::Service;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::{path::PathBuf, sync::Arc};

struct PersistedRead {
    snapshot: areal_engine::PersistedConversation,
    data_dir: PathBuf,
    workspace: PathBuf,
    _capacity: tokio::sync::OwnedSemaphorePermit,
}

fn existing_lock(path: &std::path::Path) -> Result<std::fs::File> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file()
            && metadata.uid() == unsafe { libc::geteuid() }
            && metadata.mode() & 0o022 == 0,
        "PERSISTED_HISTORY_UNAVAILABLE"
    );
    file.try_lock_exclusive()
        .map_err(|_| super::error("RESOURCE_BUSY", "project history is currently owned"))?;
    Ok(file)
}

// 仅已发布、从未建立服务的导入来源可补建互斥锁；仍使用同一服务与 Store 锁顺序。
fn imported_history_lock(path: &std::path::Path) -> Result<std::fs::File> {
    let file = storage::open_private(path, true)?;
    file.try_lock_exclusive()
        .map_err(|_| super::error("RESOURCE_BUSY", "project history is currently owned"))?;
    Ok(file)
}

pub(super) const PAGE_BYTES: usize = 128 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Identity {
    project_id: String,
    thread_id: String,
    service_generation: String,
    subscription_id: String,
    sequence: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct HistoryParams {
    thread_id: String,
    subscription_id: String,
    view: HistoryView,
    cursor: Option<String>,
    max_bytes: Option<usize>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum HistoryView {
    Own,
    Inherited,
    Reference,
}

pub(super) struct ConversationReader {
    identity: Identity,
    observation: Option<CoreObservation>,
    persisted: Option<Arc<PersistedRead>>,
    barrier: u64,
    snapshot: Value,
    history_media: std::cell::RefCell<Vec<MediaReference>>,
    media_cache: Option<MediaCache>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum OpenMode {
    Auto,
    Live,
    Persisted,
}

impl ConversationReader {
    /// 统一会话打开入口：由 Host 原子决策 Cloud 连接与观察、本地实时读取或持久化快照回退，
    /// 并在单个端到端总预算内结算（严格小于客户端超时，避免超时后遗留孤立订阅）。
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn open_auto(
        host: &std::rc::Rc<Host>,
        project: &str,
        expected_generation: Option<&str>,
        thread_id: &str,
        mode: OpenMode,
        reconnect: bool,
        allow_persisted: bool,
        cloud_auth: &super::cloud_sessions::CloudActivationAuth,
    ) -> Result<(Self, Value)> {
        let is_cloud = super::cloud_sessions::CloudSessions::is_virtual(project);
        let budget = if is_cloud {
            std::time::Duration::from_secs(135)
        } else {
            std::time::Duration::from_secs(25)
        };
        tokio::time::timeout(
            budget,
            Self::open_auto_inner(
                host,
                project,
                expected_generation,
                thread_id,
                mode,
                reconnect,
                allow_persisted,
                cloud_auth,
            ),
        )
        .await
        .map_err(|_| {
            if is_cloud {
                crate::wire::staged_error(
                    "CLOUD_HANDSHAKE_TIMEOUT",
                    "cloud_connect",
                    "连接云端沙箱超时，请稍后重试。",
                    Some("cloud session open exceeded end-to-end deadline".into()),
                    true,
                )
            } else {
                crate::wire::staged_error(
                    "CORE_CONNECTION_TIMEOUT",
                    "core_connect",
                    "等待项目连接超时，请稍后重试。",
                    Some("local session open exceeded end-to-end deadline".into()),
                    true,
                )
            }
        })?
    }

    #[allow(clippy::too_many_arguments)]
    async fn open_auto_inner(
        host: &std::rc::Rc<Host>,
        project: &str,
        expected_generation: Option<&str>,
        thread_id: &str,
        mode: OpenMode,
        reconnect: bool,
        allow_persisted: bool,
        cloud_auth: &super::cloud_sessions::CloudActivationAuth,
    ) -> Result<(Self, Value)> {
        ensure!(
            !thread_id.is_empty() && thread_id.len() <= 256,
            "INVALID_PARAMS"
        );
        if super::cloud_sessions::CloudSessions::is_virtual(project) {
            ensure!(
                mode != OpenMode::Persisted,
                super::error(
                    "PERSISTED_HISTORY_UNAVAILABLE",
                    "cloud session history is stored on the remote sandbox"
                )
            );
            host.gateway
                .workbench
                .cloud
                .sessions
                .bound_thread(host, project, thread_id)?;
            if mode == OpenMode::Live {
                let generation = expected_generation.context("INVALID_PARAMS")?;
                return Self::open(host, project, generation, thread_id).await;
            }
            let policy = if reconnect {
                super::cloud_sessions::CloudReconnect::Force
            } else {
                super::cloud_sessions::CloudReconnect::Reuse
            };
            let (scope, reused) = host
                .gateway
                .workbench
                .cloud
                .sessions
                .ensure_connected(host, project, policy, cloud_auth)
                .await?;
            match Self::open(host, project, &scope.identity.1, thread_id).await {
                Ok(opened) => {
                    host.gateway.workbench.cloud.sessions.clear_failure_for(
                        host,
                        project,
                        Some(&scope.lease),
                    );
                    return Ok(opened);
                }
                Err(first_error) if reused && !reconnect => {
                    let retryable = first_error
                        .downcast_ref::<crate::wire::Error>()
                        .is_some_and(|err| {
                            matches!(
                                err.code,
                                "CLOUD_CONNECTION_CLOSED"
                                    | "CLOUD_DISCONNECTED"
                                    | "scheduleHostUnavailable"
                            )
                        })
                        || first_error.to_string() == "RESYNC_REQUIRED";
                    if !retryable {
                        host.gateway.workbench.cloud.sessions.record_failure_for(
                            host,
                            project,
                            Some(&scope.lease),
                            &first_error,
                        );
                        return Err(first_error);
                    }
                    // 仅当当前安装租约仍是本次失败的旧租约时才重连；若另一请求已建立继任租约则直接复用。
                    let (fresh_scope, _) = host
                        .gateway
                        .workbench
                        .cloud
                        .sessions
                        .ensure_connected(
                            host,
                            project,
                            super::cloud_sessions::CloudReconnect::IfLease(scope.lease.clone()),
                            cloud_auth,
                        )
                        .await?;
                    match Self::open(host, project, &fresh_scope.identity.1, thread_id).await {
                        Ok(opened) => {
                            host.gateway.workbench.cloud.sessions.clear_failure_for(
                                host,
                                project,
                                Some(&fresh_scope.lease),
                            );
                            return Ok(opened);
                        }
                        Err(error) => {
                            host.gateway.workbench.cloud.sessions.record_failure_for(
                                host,
                                project,
                                Some(&fresh_scope.lease),
                                &error,
                            );
                            return Err(error);
                        }
                    }
                }
                Err(error) => {
                    host.gateway.workbench.cloud.sessions.record_failure_for(
                        host,
                        project,
                        Some(&scope.lease),
                        &error,
                    );
                    return Err(error);
                }
            }
        }
        match mode {
            OpenMode::Persisted => {
                ensure!(
                    allow_persisted,
                    crate::wire::error("methodNotFound", "persisted history was not negotiated")
                );
                Self::open_persisted(host, project, expected_generation, thread_id).await
            }
            OpenMode::Live => {
                let generation = expected_generation.context("INVALID_PARAMS")?;
                Self::open(host, project, generation, thread_id).await
            }
            OpenMode::Auto => {
                let ready_gen = host.ready_generation(project);
                if let Some(generation) = ready_gen {
                    match Self::open(host, project, &generation, thread_id).await {
                        Ok(opened) => return Ok(opened),
                        Err(error) if allow_persisted => {
                            let is_transient = error
                                .downcast_ref::<crate::wire::Error>()
                                .is_some_and(|err| {
                                    matches!(
                                        err.code,
                                        "scheduleHostUnavailable" | "CORE_CONNECTION_TIMEOUT"
                                    )
                                })
                                || matches!(
                                    error.to_string().as_str(),
                                    "RESYNC_REQUIRED" | "CORE_UNAVAILABLE"
                                );
                            if !is_transient {
                                return Err(error);
                            }
                            if let Ok(persisted) =
                                Self::open_persisted(host, project, None, thread_id).await
                            {
                                return Ok(persisted);
                            }
                            if let Some(next_gen) = host.ready_generation(project) {
                                return Self::open(host, project, &next_gen, thread_id).await;
                            }
                            return Err(error);
                        }
                        Err(error) => return Err(error),
                    }
                }
                if allow_persisted {
                    match Self::open_persisted(host, project, None, thread_id).await {
                        Ok(opened) => return Ok(opened),
                        Err(error) => {
                            let busy = error
                                .downcast_ref::<crate::wire::Error>()
                                .is_some_and(|err| err.code == "RESOURCE_BUSY");
                            if busy {
                                // Core 正接管 Store 锁：等待当前 ready 代际建立后切入实时观察。
                                let deadline = tokio::time::Instant::now()
                                    + std::time::Duration::from_secs(10);
                                let mut changes = host.changes.subscribe();
                                while tokio::time::Instant::now() < deadline {
                                    if let Some(generation) = host.ready_generation(project) {
                                        return Self::open(host, project, &generation, thread_id)
                                            .await;
                                    }
                                    let wait =
                                        tokio::time::timeout_at(deadline, changes.changed()).await;
                                    if wait.is_err() {
                                        break;
                                    }
                                }
                            }
                            return Err(error);
                        }
                    }
                }
                if host.schedules.suppressed(project) {
                    return Err(crate::wire::staged_error(
                        "CORE_EXPLICITLY_STOPPED",
                        "conversation_observe",
                        "项目已手动停止，请先恢复项目后再打开对话。",
                        None,
                        false,
                    ));
                }
                Err(crate::wire::staged_error(
                    "CORE_UNAVAILABLE",
                    "conversation_observe",
                    "项目服务尚未就绪，请稍后重试。",
                    Some("local project service is not ready".into()),
                    true,
                ))
            }
        }
    }

    pub(super) async fn open(
        host: &Host,
        project: &str,
        generation: &str,
        thread_id: &str,
    ) -> Result<(Self, Value)> {
        ensure!(
            !thread_id.is_empty() && thread_id.len() <= 256,
            "INVALID_PARAMS"
        );
        let (snapshot, barrier, observation) =
            if super::cloud_sessions::CloudSessions::is_virtual(project) {
                host.gateway
                    .workbench
                    .cloud
                    .sessions
                    .bound_thread(host, project, thread_id)?;
                let scope = host.gateway.workbench.cloud.sessions.scope(host, project)?;
                ensure!(scope.identity.1 == generation, "RESYNC_REQUIRED");
                host.schedules
                    .connections
                    .cloud_observe(
                        host,
                        project,
                        &scope.lease,
                        generation,
                        thread_id,
                        PAGE_BYTES,
                    )
                    .await?
            } else {
                host.schedules
                    .connections
                    .ready(host, project, generation)
                    .await?;
                host.schedules
                    .connections
                    .conversation_observe(host, project, generation, thread_id, PAGE_BYTES)
                    .await?
            };
        check_size(&snapshot)?;
        let reader = Self {
            identity: Identity {
                project_id: project.into(),
                thread_id: thread_id.into(),
                service_generation: generation.into(),
                subscription_id: uuid::Uuid::new_v4().to_string(),
                sequence: 0,
            },
            observation: Some(observation),
            persisted: None,
            barrier,
            snapshot,
            history_media: Default::default(),
            media_cache: None,
        };
        let mut result = reader.keys();
        result["snapshot"] = reader.snapshot.clone();
        Ok((reader, result))
    }

    pub(super) async fn open_persisted(
        host: &Host,
        project: &str,
        expected_generation: Option<&str>,
        thread_id: &str,
    ) -> Result<(Self, Value)> {
        let gate = host.gate(project)?;
        let _guard = gate.read().await;
        ensure!(
            !host.migration.unpublished_reserved(project)?,
            super::error(
                "PERSISTED_HISTORY_UNAVAILABLE",
                "project source is not published"
            )
        );
        let registration = host
            .slots
            .borrow()
            .get(project)
            .context("PERSISTED_HISTORY_UNAVAILABLE")?
            .registration
            .clone();
        let imported_without_service = host
            .slots
            .borrow()
            .get(project)
            .is_some_and(|slot| slot.service.is_none())
            && host
                .migration
                .published()?
                .iter()
                .any(|published| published == &registration);
        let capacity = host
            .read_models
            .persisted_capacity()
            .try_acquire_owned()
            .map_err(|_| super::error("RESOURCE_BUSY", "close another persisted history view"))?;
        let home = host.home.clone();
        let id = thread_id.to_owned();
        let expected = expected_generation.map(str::to_owned);
        let copied = registration.clone();
        let (generation, snapshot, mut baseline, capacity) =
            tokio::task::spawn_blocking(move || -> Result<_> {
                let capacity = capacity;
                let directory = storage::registry(&home, &Host::service_id(&copied))?;
                let descriptor = directory.join("service.json");
                let descriptor_absent = match std::fs::symlink_metadata(&descriptor) {
                    Ok(_) => false,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
                    Err(error) => return Err(error.into()),
                };
                let imported = descriptor_absent && imported_without_service && expected.is_none();
                if imported {
                    ensure!(
                        copied.data_dir.canonicalize()? == copied.data_dir,
                        "PERSISTED_HISTORY_UNAVAILABLE"
                    );
                    storage::private_dir(&directory)?;
                    ensure!(
                        directory.canonicalize()? == directory,
                        "PERSISTED_HISTORY_UNAVAILABLE"
                    );
                }
                let lock = |path: &std::path::Path| {
                    if imported {
                        imported_history_lock(path)
                    } else {
                        existing_lock(path)
                    }
                };
                let _startup = lock(&directory.join("start.lock"))?;
                // 在启动锁内重读；已存在服务绝不降级为无代际读取。
                let service: Option<Service> = storage::read_optional(&descriptor)?;
                ensure!(
                    service.is_some() || imported,
                    "PERSISTED_HISTORY_UNAVAILABLE"
                );
                let data_lock = |path: &std::path::Path| {
                    if service.is_none() {
                        imported_history_lock(path)
                    } else {
                        existing_lock(path)
                    }
                };
                let _service = data_lock(&copied.data_dir.join("service.lock"))?;
                let _store = data_lock(&copied.data_dir.join("owner.lock"))?;
                let binding: Option<PathBuf> =
                    storage::read_optional(&copied.data_dir.join("service-workspace"))?;
                if let Some(service) = &service {
                    ensure!(
                        service.identity.protocol_version == 1
                            && service.identity.service_id == Host::service_id(&copied)
                            && service.identity.data_dir == copied.data_dir
                            && service.identity.workspace == copied.workspace
                            && expected
                                .as_ref()
                                .is_none_or(|generation| generation == &service.identity.generation)
                            && binding.as_ref() == Some(&copied.workspace),
                        "PERSISTED_HISTORY_UNAVAILABLE"
                    );
                } else {
                    ensure!(binding.is_none(), "PERSISTED_HISTORY_UNAVAILABLE");
                }
                let snapshot = areal_engine::PersistedConversation::read(
                    &copied.data_dir,
                    &copied.workspace,
                    &id,
                )?;
                let baseline = snapshot.snapshot(PAGE_BYTES - 256)?;
                ensure!(
                    serde_json::to_value(storage::read_optional::<Service>(&descriptor)?)?
                        == serde_json::to_value(&service)?,
                    "PERSISTED_HISTORY_UNAVAILABLE"
                );
                for (path, file) in [
                    (directory.join("start.lock"), &_startup),
                    (copied.data_dir.join("service.lock"), &_service),
                    (copied.data_dir.join("owner.lock"), &_store),
                ] {
                    let held = file.metadata()?;
                    let named = std::fs::symlink_metadata(path)?;
                    ensure!(
                        named.is_file() && named.dev() == held.dev() && named.ino() == held.ino(),
                        "PERSISTED_HISTORY_UNAVAILABLE"
                    );
                }
                // 无服务的只读订阅使用快照身份，不写服务描述，也不授予执行代际。
                let generation = service
                    .map(|service| service.identity.generation)
                    .unwrap_or_else(|| format!("persisted:{}", snapshot.snapshot_id()));
                Ok((generation, snapshot, baseline, capacity))
            })
            .await?
            .map_err(|cause| {
                if cause.downcast_ref::<super::wire::Error>().is_some() {
                    cause
                } else if cause.to_string() == "PERSISTED_HISTORY_LIMIT" {
                    super::error(
                        "LIMIT_EXCEEDED",
                        "persisted history exceeds the snapshot limit",
                    )
                } else {
                    super::error(
                        "PERSISTED_HISTORY_UNAVAILABLE",
                        format!("cannot inspect persisted history: {cause:#}"),
                    )
                }
            })?;
        let access =
            json!({"kind":"persisted","readOnly":true,"snapshotId":snapshot.snapshot_id()});
        baseline["access"] = access.clone();
        check_size(&baseline)?;
        let reader = Self {
            identity: Identity {
                project_id: project.into(),
                thread_id: thread_id.into(),
                service_generation: generation,
                subscription_id: uuid::Uuid::new_v4().to_string(),
                sequence: 0,
            },
            observation: None,
            persisted: Some(Arc::new(PersistedRead {
                snapshot,
                data_dir: registration.data_dir,
                workspace: registration.workspace,
                _capacity: capacity,
            })),
            barrier: 0,
            snapshot: baseline,
            history_media: Default::default(),
            media_cache: None,
        };
        ensure!(reader.current(host), "RESYNC_REQUIRED");
        let mut result = reader.keys();
        result["snapshot"] = reader.snapshot.clone();
        result["access"] = access;
        Ok((reader, result))
    }

    pub(super) fn project(&self) -> &str {
        &self.identity.project_id
    }
    pub(super) fn generation(&self) -> &str {
        &self.identity.service_generation
    }
    pub(super) fn subscription(&self) -> &str {
        &self.identity.subscription_id
    }
    pub(super) fn current(&self, host: &Host) -> bool {
        if let Some(observation) = &self.observation {
            return observation.current(host);
        }
        let Some(persisted) = &self.persisted else {
            return false;
        };
        host.slots.borrow().get(self.project()).is_some_and(|slot| {
            slot.registration.data_dir == persisted.data_dir
                && slot.registration.workspace == persisted.workspace
                && (slot.state == "starting"
                    || slot
                        .service
                        .as_ref()
                        .is_none_or(|service| service.identity.generation == self.generation()))
        })
    }
    pub(super) fn model(&self) -> Option<Value> {
        self.snapshot["thread"]["desktop"]["configuration"]
            .get("model")
            .cloned()
    }
    fn keys(&self) -> Value {
        let mut value = serde_json::to_value(&self.identity).unwrap();
        value["view"] = json!("conversation");
        value
    }
    pub(super) async fn next_event(&mut self) -> Result<Option<CoreEvent>> {
        let Some(observation) = self.observation.as_mut() else {
            return std::future::pending().await;
        };
        match observation.events.recv().await {
            Ok(event) => Ok(Some(event)),
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => Ok(None),
            Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                anyhow::bail!("RESYNC_REQUIRED")
            }
        }
    }
    pub(super) async fn event(
        &mut self,
        host: &Host,
        event: Option<CoreEvent>,
    ) -> Result<Option<Value>> {
        ensure!(self.current(host), "RESYNC_REQUIRED");
        if let Some(event) = event {
            if event.sequence <= self.barrier {
                return Ok(None);
            }
            let params = &event.value["params"];
            let thread = params
                .get("threadId")
                .or_else(|| params["interaction"].get("threadId"))
                .or_else(|| params["thread"].get("id"));
            if thread.and_then(Value::as_str) != Some(self.identity.thread_id.as_str()) {
                return Ok(None);
            }
        }
        let (snapshot, barrier) = self
            .observation
            .as_ref()
            .context("RESYNC_REQUIRED")?
            .snapshot(host)
            .await?;
        check_size(&snapshot)?;
        let patch = difference(&self.snapshot, &snapshot)?;
        self.snapshot = snapshot;
        self.barrier = barrier;
        let Some(patch) = patch else {
            return Ok(None);
        };
        self.identity.sequence += 1;
        let mut result = self.keys();
        result["event"] = json!("session.updated");
        result["patch"] = patch;
        Ok(Some(result))
    }
    pub(super) async fn history(&self, host: &Host, params: HistoryParams) -> Result<Value> {
        ensure!(
            params.thread_id == self.identity.thread_id
                && params.subscription_id == self.identity.subscription_id,
            "INVALID_PARAMS"
        );
        let max_bytes = params.max_bytes.unwrap_or(PAGE_BYTES);
        ensure!((1024..=PAGE_BYTES).contains(&max_bytes), "INVALID_PARAMS");
        ensure!(
            params
                .cursor
                .as_ref()
                .is_none_or(|cursor| !cursor.is_empty() && cursor.len() <= 16384),
            "INVALID_PARAMS"
        );
        ensure!(self.current(host), "RESYNC_REQUIRED");
        let view = serde_json::to_value(params.view)?;
        let page = if let Some(persisted) = &self.persisted {
            ensure!(
                view == "own",
                super::error(
                    "PERSISTED_HISTORY_VIEW_UNAVAILABLE",
                    "only own history is available in this snapshot"
                )
            );
            let persisted = persisted.clone();
            tokio::task::spawn_blocking(move || {
                persisted.snapshot.history(params.cursor, max_bytes)
            })
            .await??
        } else {
            self.observation
                .as_ref()
                .context("RESYNC_REQUIRED")?
                .history(
                    host,
                    view.as_str().unwrap(),
                    params.cursor.as_deref(),
                    max_bytes,
                )
                .await?
        };
        ensure!(self.current(host), "RESYNC_REQUIRED");
        check_size(&page)?;
        *self.history_media.borrow_mut() = conversation_media::page_references(&page);
        let mut result = self.keys();
        result["page"] = page;
        Ok(result)
    }
    pub(super) async fn media(&mut self, host: &Host, value: &Value) -> Result<Value> {
        let params: MediaParams =
            serde_json::from_value(value.clone()).map_err(|_| anyhow::anyhow!("INVALID_PARAMS"))?;
        ensure!(
            params.view == "conversation"
                && params.thread_id == self.identity.thread_id
                && params.subscription_id == self.identity.subscription_id
                && params.service_generation == self.identity.service_generation,
            "INVALID_PARAMS"
        );
        let offset = params.offset.unwrap_or(0);
        let length = params.length.unwrap_or(32 * 1024);
        ensure!(
            (1..=64 * 1024).contains(&length) && offset < conversation_media::MAX_BYTES,
            "INVALID_PARAMS"
        );
        ensure!(self.current(host), "RESYNC_REQUIRED");
        let requested = MediaReference::requested(&params)?;
        let reference = if let Some(cache) = &self.media_cache
            && cache.reference.matches(&params)
        {
            cache.reference.clone()
        } else if let Some(persisted) = &self.persisted {
            let persisted = persisted.clone();
            let thread = self.identity.thread_id.clone();
            tokio::task::spawn_blocking(move || {
                persisted
                    .snapshot
                    .thread()
                    .turns
                    .iter()
                    .flat_map(|turn| {
                        turn.items.iter().flat_map(|item| {
                            conversation_media::item_references(
                                &thread,
                                &turn.id,
                                &serde_json::to_value(item).unwrap(),
                            )
                        })
                    })
                    .find(|reference| reference.matches(&params))
                    .context("RESOURCE_UNAVAILABLE")
            })
            .await??
        } else {
            conversation_media::snapshot_references(&self.snapshot)
                .into_iter()
                .chain(self.history_media.borrow().iter().cloned())
                .find(|reference| reference.matches(&params))
                .unwrap_or(requested)
        };
        if self
            .media_cache
            .as_ref()
            .is_none_or(|cache| cache.reference != reference)
        {
            self.media_cache = None;
            let cache = if let Some(persisted) = &self.persisted {
                let persisted = persisted.clone();
                let uri = reference.uri.clone();
                let bytes = tokio::task::spawn_blocking(move || {
                    persisted.snapshot.blob(&persisted.data_dir, &uri)
                })
                .await?
                .map_err(|_| anyhow::anyhow!("RESOURCE_UNAVAILABLE"))?;
                conversation_media::from_bytes(reference, bytes)
            } else if let Some(bytes) = self
                .observation
                .as_ref()
                .context("RESYNC_REQUIRED")?
                .remote_media(host, &reference)
                .await?
            {
                conversation_media::from_bytes(reference, bytes)
            } else {
                conversation_media::fetch(
                    self.observation
                        .as_ref()
                        .context("RESYNC_REQUIRED")?
                        .service(),
                    &self.identity.thread_id,
                    reference,
                    || {
                        ensure!(self.current(host), "RESYNC_REQUIRED");
                        Ok(())
                    },
                )
                .await
            };
            ensure!(self.current(host), "RESYNC_REQUIRED");
            self.media_cache = Some(cache?);
        }
        ensure!(self.current(host), "RESYNC_REQUIRED");
        let chunk = self.media_cache.as_ref().unwrap().chunk(offset, length)?;
        let mut result = self.keys();
        result
            .as_object_mut()
            .unwrap()
            .extend(chunk.as_object().unwrap().clone());
        Ok(result)
    }
    pub(super) fn invalidated(&self, error: &anyhow::Error) -> Value {
        let mut result = self.keys();
        result["event"] = json!("session.invalidated");
        result["sequence"] = json!(self.identity.sequence + 1);
        let code = if error.to_string() == "RESOURCE_UNAVAILABLE" {
            "RESOURCE_UNAVAILABLE"
        } else {
            "RESYNC_REQUIRED"
        };
        result["error"] = json!({"code":code,"message":"观察连接已变化；请重新打开会话"});
        result
    }
}

fn check_size(value: &Value) -> Result<()> {
    ensure!(
        serde_json::to_vec(value)?.len() <= PAGE_BYTES,
        "RESOURCE_UNAVAILABLE"
    );
    Ok(())
}

fn without(value: &Value, key: &str) -> Result<Value> {
    let mut head = value.as_object().context("CORE_INCOMPATIBLE")?.clone();
    head.remove(key);
    Ok(Value::Object(head))
}
fn order(values: &[Value]) -> Result<Vec<&str>> {
    values
        .iter()
        .map(|value| value["id"].as_str().context("CORE_INCOMPATIBLE"))
        .collect()
}
fn difference(before: &Value, after: &Value) -> Result<Option<Value>> {
    if before == after {
        return Ok(None);
    }
    let mut patch = json!({"turns":[]});
    let head = |value: &Value| -> Result<Value> {
        let mut head = value.clone();
        head["thread"] = without(&value["thread"], "turns")?;
        Ok(head)
    };
    let after_head = head(after)?;
    if head(before)? != after_head {
        patch["head"] = after_head;
    }
    let old_turns = before["thread"]["turns"]
        .as_array()
        .context("CORE_INCOMPATIBLE")?;
    let new_turns = after["thread"]["turns"]
        .as_array()
        .context("CORE_INCOMPATIBLE")?;
    if order(old_turns)? != order(new_turns)? {
        patch["order"] = json!(order(new_turns)?);
    }
    for turn in new_turns {
        let previous = old_turns.iter().find(|old| old["id"] == turn["id"]);
        if previous == Some(turn) {
            continue;
        }
        let mut change = json!({"id":turn["id"],"items":[]});
        let turn_head = without(turn, "items")?;
        if previous
            .map(|old| without(old, "items"))
            .transpose()?
            .as_ref()
            != Some(&turn_head)
        {
            change["head"] = turn_head;
        }
        let items = turn["items"].as_array().context("CORE_INCOMPATIBLE")?;
        let old_items = previous
            .and_then(|old| old["items"].as_array())
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        if previous.is_none() || order(old_items)? != order(items)? {
            change["order"] = json!(order(items)?);
        }
        for item in items {
            if old_items.iter().find(|old| old["id"] == item["id"]) != Some(item) {
                change["items"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"id":item["id"],"value":item}));
            }
        }
        patch["turns"].as_array_mut().unwrap().push(change);
    }
    Ok(Some(patch))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn conversation_media_binds_subscription_and_reuses_one_authorized_download() {
        use base64::{Engine, engine::general_purpose::STANDARD};
        use futures_util::{SinkExt, StreamExt};
        use sha2::{Digest, Sha256};
        use std::rc::Rc;
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
        };
        use tokio_tungstenite::tungstenite::Message;

        tokio::task::LocalSet::new().run_until(async {
            let root = tempfile::tempdir().unwrap();
            let host = Rc::new(super::super::schedules::tests::fixture(root.path()));
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let registration = host.slots.borrow()["project"].registration.clone();
            let service: areal_protocol::service::Service = serde_json::from_value(json!({
                "protocolVersion":1,"serviceId":"core","generation":"first","workspace":registration.workspace,"dataDir":registration.data_dir,"configFingerprint":"test",
                "owner":null,"endpoint":format!("ws://{}/",listener.local_addr().unwrap()),"webUrl":"","authFile":root.path().join("auth.json"),"logFile":root.path().join("core.log"),"hostPid":1,"corePid":2,"state":"ready"
            })).unwrap();
            areal_local_service::storage::write(&service.auth_file, &json!({"principals":[{"id":"desktop-owner","token":"private-owner"}]})).unwrap();
            {
                let mut slots = host.slots.borrow_mut();
                let slot = slots.get_mut("project").unwrap();
                slot.service = Some(service.clone());
                slot.state = "ready".into();
            }
            let bytes = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aKsAAAAASUVORK5CYII=").unwrap();
            let uri = format!("areal://blob/{:x}", Sha256::digest(&bytes));
            let observed = json!({"thread":{"id":"selected","turns":[{"id":"turn","items":[{"id":"image","type":"agentMedia","media":{"uri":uri,"mimeType":"image/png","sizeBytes":bytes.len()}}]}]}});
            let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
            let expected_bytes = bytes.clone();
            let server = tokio::task::spawn_local(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                for expected in ["initialize", "areal/capabilities", "areal/thread/observe"] {
                    loop {
                        let message = socket.next().await.unwrap().unwrap();
                        let Message::Text(text) = message else { continue; };
                        let request: Value = serde_json::from_str(&text).unwrap();
                        if request["method"] == "initialized" { continue; }
                        assert_eq!(request["method"], expected);
                        let result = match expected { "initialize" => json!({}), "areal/capabilities" => json!({"features":{"conversationObservation":true}}), _ => observed.clone() };
                        socket.send(Message::Text(json!({"id":request["id"],"result":result}).to_string().into())).await.unwrap();
                        break;
                    }
                }
                let (mut http, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    http.read_exact(&mut byte).await.unwrap();
                    request.push(byte[0]);
                    assert!(request.len() < 8192);
                }
                let request = String::from_utf8(request).unwrap();
                assert!(request.lines().next().unwrap().ends_with("?threadId=selected HTTP/1.1"));
                assert!(request.to_ascii_lowercase().contains("authorization: bearer private-owner\r\n"));
                http.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", bytes.len()).as_bytes()).await.unwrap();
                http.write_all(&bytes).await.unwrap();
                drop(http);
                tokio::select! {
                    _ = stop_rx => {},
                    _ = listener.accept() => panic!("a cached image chunk must not download the blob again"),
                }
                drop(socket);
            });
            let close = host.schedules.connections.connect_test_core(host.clone(), "project", service).await.unwrap();
            let (mut reader, _) = ConversationReader::open(&host, "project", "first", "selected").await.unwrap();
            let params = json!({"view":"conversation","threadId":"selected","subscriptionId":reader.subscription(),"serviceGeneration":"first","turnId":"turn","itemId":"image","uri":uri,"length":32});
            for field in ["threadId", "subscriptionId", "serviceGeneration"] {
                let mut wrong = params.clone();
                wrong[field] = json!("foreign");
                assert_eq!(reader.media(&host, &wrong).await.unwrap_err().to_string(), "INVALID_PARAMS");
            }
            let mut wrong = params.clone();
            wrong["uri"] = json!("file:///private/secret");
            assert_eq!(reader.media(&host, &wrong).await.unwrap_err().to_string(), "RESOURCE_UNAVAILABLE");
            let first = reader.media(&host, &params).await.unwrap();
            let mut next = params.clone();
            next["offset"] = first["nextOffset"].clone();
            next["length"] = json!(65536);
            let second = reader.media(&host, &next).await.unwrap();
            assert_eq!(first["subscriptionId"], params["subscriptionId"]);
            assert_eq!(first["sourceThreadId"], "selected");
            let mut result = STANDARD.decode(first["base64"].as_str().unwrap()).unwrap();
            result.extend(STANDARD.decode(second["base64"].as_str().unwrap()).unwrap());
            assert_eq!(result, expected_bytes);
            host.slots.borrow_mut().get_mut("project").unwrap().service.as_mut().unwrap().identity.generation = "second".into();
            assert_eq!(reader.media(&host, &params).await.unwrap_err().to_string(), "RESYNC_REQUIRED");
            stop_tx.send(()).unwrap();
            server.await.unwrap();
            close();
        }).await;
    }

    fn apply(mut snapshot: Value, patch: &Value) -> Value {
        if let Some(head) = patch.get("head") {
            let turns = snapshot["thread"]["turns"].take();
            snapshot = head.clone();
            snapshot["thread"]["turns"] = turns;
        }
        for change in patch["turns"].as_array().unwrap() {
            let turns = snapshot["thread"]["turns"].as_array_mut().unwrap();
            let index = turns
                .iter()
                .position(|turn| turn["id"] == change["id"])
                .unwrap_or_else(|| {
                    turns.push(json!({"id":change["id"],"items":[]}));
                    turns.len() - 1
                });
            let turn = &mut turns[index];
            if let Some(head) = change.get("head") {
                let items = turn["items"].take();
                *turn = head.clone();
                turn["items"] = items;
            }
            for item in change["items"].as_array().unwrap() {
                let items = turn["items"].as_array_mut().unwrap();
                if let Some(old) = items.iter_mut().find(|old| old["id"] == item["id"]) {
                    *old = item["value"].clone();
                } else {
                    items.push(item["value"].clone());
                }
            }
            if let Some(order) = change.get("order") {
                turn["items"] = order
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|id| {
                        turn["items"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .find(|item| item["id"] == *id)
                            .unwrap()
                            .clone()
                    })
                    .collect();
            }
        }
        if let Some(order) = patch.get("order") {
            snapshot["thread"]["turns"] = order
                .as_array()
                .unwrap()
                .iter()
                .map(|id| {
                    snapshot["thread"]["turns"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|turn| turn["id"] == *id)
                        .unwrap()
                        .clone()
                })
                .collect();
        }
        snapshot
    }

    #[test]
    fn conversation_patch_preserves_native_fields_and_only_sends_changed_item() {
        let before = json!({"thread":{"id":"thread","updatedAt":1,"desktop":{"configuration":{"model":{"contextWindow":100000}}},"turns":[
            {"id":"inherited","sourceTurnId":"original","status":"completed","items":[{"id":"old","sourceItemId":"source-old","text":"unchanged".repeat(3000)}]},
            {"id":"active","status":"inProgress","items":[{"id":"image","type":"image","media":{"source":"fixture.png","width":720}},{"id":"answer","type":"agentMessage","text":"one"}]}
        ]},"ownership":{"kind":"main"},"history":{"view":"own","complete":false,"nextCursor":"native-cursor"}});
        let mut after = before.clone();
        after["thread"]["updatedAt"] = json!(2);
        after["thread"]["turns"][1]["items"][1]["text"] = json!("one two");
        let patch = difference(&before, &after).unwrap().unwrap();
        assert_eq!(patch["turns"].as_array().unwrap().len(), 1);
        assert_eq!(patch["turns"][0]["items"].as_array().unwrap().len(), 1);
        assert_eq!(patch["turns"][0]["items"][0]["id"], "answer");
        assert!(patch.get("order").is_none());
        assert_eq!(apply(before.clone(), &patch), after);
        let baseline = serde_json::to_vec(&after).unwrap().len();
        let delta = serde_json::to_vec(&patch).unwrap().len();
        eprintln!("conversation streaming serialized bytes snapshot={baseline} patch={delta}");
        assert!(delta < baseline / 10);
        assert!(difference(&after, &after).unwrap().is_none());

        let mut changed = after.clone();
        changed["thread"]["turns"].as_array_mut().unwrap().remove(0);
        changed["thread"]["turns"][0]["items"]
            .as_array_mut()
            .unwrap()
            .remove(0);
        changed["thread"]["turns"][0]["status"] = json!("completed");
        changed["thread"]["turns"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"new","customMetadata":{"source":"native"},"items":[]}));
        assert_eq!(
            apply(
                after.clone(),
                &difference(&after, &changed).unwrap().unwrap()
            ),
            changed
        );
        assert_eq!(
            apply(
                changed.clone(),
                &difference(&changed, &after).unwrap().unwrap()
            ),
            after
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn imported_missing_workspace_opens_persisted_history_without_service() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let host = super::super::schedules::tests::fixture(&root);
        let source = crate::migration::Source {
            profile: root.join("profile"),
            core_home: root.join("old-core"),
            // 过渡：到 0.2.0 删；旧版服务目录一次性导入测试。
            legacy_service_home: root.join("old-services"),
        };
        for directory in [
            &source.profile,
            &source.core_home,
            // 过渡：到 0.2.0 删；旧版服务目录一次性导入测试。
            &source.legacy_service_home,
        ] {
            storage::private_dir(directory).unwrap();
        }
        let workspace = root.join("workspace");
        let project = "a".repeat(24);
        storage::write(
            &source.core_home.join("projects.json"),
            &json!([{"id":project,"root":workspace}]),
        )
        .unwrap();
        let data = source.core_home.join(&project).join("state");
        storage::private_dir(&data).unwrap();
        let thread = uuid::Uuid::new_v4().to_string();
        let path = data.join(format!("{thread}.json"));
        storage::write(&path, &json!({"version":17,"thread":{"id":thread,"sessionId":thread,"parentThreadId":null,"preview":"fixture","modelProvider":"fixture","createdAt":1,"updatedAt":2,"status":{"type":"idle"},"cwd":workspace,"cliVersion":"fixture","source":"cli","ephemeral":false,"turns":[{"id":"original-turn","status":"completed","items":[{"id":"original-item","type":"agentMessage","text":"original history"}]}]}})).unwrap();
        let original = std::fs::read(&path).unwrap();
        std::fs::remove_dir(&workspace).unwrap();
        // 旧服务已完成清理；新 Host 尚未启动该项目，不能伪造新服务身份。
        let service_id = storage::digest(data.as_os_str().as_encoded_bytes())[..24].to_owned();
        // 过渡：到 0.2.0 删；旧版服务目录一次性导入测试。
        let prior_service_dir =
            storage::registry(&source.legacy_service_home, &service_id).unwrap();
        storage::private_dir(&prior_service_dir).unwrap();
        let service: areal_protocol::service::Service = serde_json::from_value(json!({
            "protocolVersion": 1,
            "serviceId": service_id,
            "generation": uuid::Uuid::new_v4().to_string(),
            "workspace": workspace,
            "dataDir": data,
            "configFingerprint": "fixture",
            "endpoint": "http://127.0.0.1:1",
            "webUrl": "http://127.0.0.1:1",
            "authFile": prior_service_dir.join("auth.json"),
            "logFile": prior_service_dir.join("host.log"),
            "hostPid": 1,
            "corePid": 1,
            "state": "stopped"
        }))
        .unwrap();
        storage::write(&prior_service_dir.join("service.json"), &service).unwrap();
        storage::write(
            &prior_service_dir.join("cleanup.json"),
            &storage::CleanupReceipt {
                version: 1,
                identity: service.identity.clone(),
                owner: service.owner.clone(),
                components: Default::default(),
                cleanup_confirmed: true,
            },
        )
        .unwrap();
        host.migration
            .attach(source.clone(), "importer", None)
            .unwrap();
        let imported = host
            .migration
            .import(
                serde_json::from_value(json!({
                    "requestId": uuid::Uuid::new_v4().to_string(),
                    "expectedGeneration": host.identity.generation,
                    "source": source,
                }))
                .unwrap(),
                "importer",
                &[],
                &host.journal,
            )
            .unwrap();
        assert_eq!(imported["kind"], "ready");
        let registration = host
            .migration
            .published()
            .unwrap()
            .into_iter()
            .find(|r| r.project_id == project)
            .unwrap();
        let directory = storage::registry(&host.home, &Host::service_id(&registration)).unwrap();
        host.slots
            .borrow_mut()
            .insert(project.clone(), super::super::Slot::imported(registration));
        assert!(
            ConversationReader::open_persisted(&host, &project, Some("old-generation"), &thread)
                .await
                .is_err()
        );
        assert!(
            ConversationReader::open_persisted(&host, "project", None, &thread)
                .await
                .is_err(),
            "unimported registrations cannot use the no-service path"
        );
        let owner = storage::open_private(&data.join("owner.lock"), true).unwrap();
        owner.try_lock_exclusive().unwrap();
        assert!(
            ConversationReader::open_persisted(&host, &project, None, &thread)
                .await
                .is_err(),
            "a live Store owner blocks history inspection"
        );
        drop(owner);
        let (reader, opened) = ConversationReader::open_persisted(&host, &project, None, &thread)
            .await
            .unwrap();
        assert!(reader.current(&host));
        assert_eq!(opened["access"]["readOnly"], true);
        assert_eq!(opened["snapshot"]["thread"]["id"], thread);
        assert_eq!(
            opened["snapshot"]["thread"]["turns"][0]["items"][0]["text"],
            "original history"
        );
        assert!(
            opened["serviceGeneration"]
                .as_str()
                .unwrap()
                .starts_with("persisted:")
        );
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert!(!workspace.exists());
        assert!(!directory.join("service.json").exists());
        assert!(!data.join("service-workspace").exists());
        assert!(
            ConversationReader::open_persisted(&host, &project, Some(reader.generation()), &thread)
                .await
                .is_err(),
            "snapshot identity must not be accepted as a service generation"
        );
        host.slots
            .borrow_mut()
            .get_mut(&project)
            .unwrap()
            .registration
            .data_dir = root.join("unrelated");
        assert!(!reader.current(&host));
        assert!(
            ConversationReader::open_persisted(&host, &project, None, &thread)
                .await
                .is_err(),
            "import publication must match the entire registration"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn persisted_reader_stays_current_while_slot_is_starting_and_invalidates_after_ready() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let host = super::super::schedules::tests::fixture(&root);
        let registration = host.slots.borrow()["project"].registration.clone();
        storage::private_dir(&registration.data_dir).unwrap();
        let directory = storage::registry(&host.home, &Host::service_id(&registration)).unwrap();
        storage::private_dir(&directory).unwrap();
        for path in [
            directory.join("start.lock"),
            registration.data_dir.join("service.lock"),
            registration.data_dir.join("owner.lock"),
        ] {
            storage::open_private(&path, true).unwrap();
        }
        storage::write(
            &registration.data_dir.join("service-workspace"),
            &registration.workspace,
        )
        .unwrap();
        let service: areal_protocol::service::Service = serde_json::from_value(json!({
            "protocolVersion": 1,
            "serviceId": Host::service_id(&registration),
            "generation": "first",
            "workspace": registration.workspace,
            "dataDir": registration.data_dir,
            "configFingerprint": "old",
            "endpoint": "http://127.0.0.1:1",
            "webUrl": "http://127.0.0.1:1",
            "authFile": directory.join("auth.json"),
            "logFile": directory.join("host.log"),
            "hostPid": 1,
            "corePid": 2,
            "state": "stopped"
        }))
        .unwrap();
        storage::write(&directory.join("service.json"), &service).unwrap();
        let thread = uuid::Uuid::new_v4().to_string();
        storage::write(
            &registration.data_dir.join(format!("{thread}.json")),
            &json!({
                "version": 17,
                "thread": {
                    "id": thread,
                    "sessionId": thread,
                    "parentThreadId": null,
                    "preview": "fixture",
                    "modelProvider": "fixture",
                    "createdAt": 1,
                    "updatedAt": 2,
                    "status": { "type": "idle" },
                    "cwd": registration.workspace,
                    "cliVersion": "fixture",
                    "source": "cli",
                    "ephemeral": false,
                    "turns": []
                }
            }),
        )
        .unwrap();
        let (reader, _) =
            ConversationReader::open_persisted(&host, "project", Some("first"), &thread)
                .await
                .unwrap();
        assert!(reader.current(&host));
        {
            let mut slots = host.slots.borrow_mut();
            let slot = slots.get_mut("project").unwrap();
            let mut next = service.clone();
            next.identity.generation = "second".into();
            slot.service = Some(next);
            slot.state = "starting".into();
        }
        assert!(
            reader.current(&host),
            "persisted history should remain valid while Core activation is in progress"
        );
        host.slots.borrow_mut().get_mut("project").unwrap().state = "ready".into();
        assert!(
            !reader.current(&host),
            "persisted reader must invalidate once replacement generation is ready"
        );
    }
}
