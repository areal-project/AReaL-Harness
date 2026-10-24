//! 管理配置与已连接目录分离；现有 Turn 保留原工具对象与失效标志。
use super::*;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    id: String,
    revision: u64,
    directory_revision: u64,
    config: areal_mcp::ServerConfig,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    cleanup_unconfirmed: bool,
    #[serde(skip)]
    status: String,
    #[serde(skip)]
    error: Option<String>,
}
enum ManagedConnection {
    Live(areal_mcp::Connections),
    #[cfg(test)]
    CleanupFailureFixture,
}
impl ManagedConnection {
    async fn shutdown(&mut self) -> anyhow::Result<()> {
        match self {
            Self::Live(connection) => connection.shutdown().await,
            #[cfg(test)]
            Self::CleanupFailureFixture => Err(areal_mcp::CleanupUnconfirmed.into()),
        }
    }
}
type Slot = Arc<Mutex<Option<ManagedConnection>>>;
pub(crate) struct Manager {
    records: std::sync::RwLock<BTreeMap<String, Record>>,
    connections: std::sync::RwLock<BTreeMap<String, Slot>>,
    persist: Mutex<()>,
    tools: std::sync::RwLock<BTreeMap<String, Vec<areal_mcp::McpTool>>>,
}
impl Manager {
    pub fn open(root: &Path) -> anyhow::Result<Self> {
        let path = root.join("desktop/mcp.json");
        let mut records: BTreeMap<String, Record> = if path.exists() {
            anyhow::ensure!(
                std::fs::metadata(&path)?.len() <= 1024 * 1024,
                "MCP configuration exceeds 1 MiB"
            );
            serde_json::from_slice(&std::fs::read(path)?)?
        } else {
            BTreeMap::new()
        };
        for record in records.values_mut() {
            record.status = if record.cleanup_unconfirmed {
                "cleanupFailed"
            } else {
                "disconnected"
            }
            .into();
        }
        let connections = records
            .keys()
            .map(|id| (id.clone(), Arc::new(Mutex::new(None))))
            .collect();
        Ok(Self {
            records: std::sync::RwLock::new(records),
            connections: std::sync::RwLock::new(connections),
            persist: Mutex::new(()),
            tools: std::sync::RwLock::new(BTreeMap::new()),
        })
    }
    pub(super) fn contains_definition(&self, id: &str) -> bool {
        self.records.read().unwrap().contains_key(id)
    }
    pub fn tools(&self) -> Vec<areal_mcp::McpTool> {
        self.tools
            .read()
            .unwrap()
            .values()
            .flatten()
            .cloned()
            .collect()
    }
    pub async fn shutdown(&self, store: &crate::store::Store) -> Result<()> {
        let slots = self
            .connections
            .read()
            .unwrap()
            .iter()
            .map(|(id, slot)| (id.clone(), slot.clone()))
            .collect::<Vec<_>>();
        let mut failed = false;
        for (id, slot) in slots {
            let mut lifecycle = slot.lock().await;
            let Some(mut connection) = lifecycle.take() else {
                continue;
            };
            let cleanup_failed = connection.shutdown().await.is_err();
            failed |= cleanup_failed;
            if let Some(record) = self.records.write().unwrap().get_mut(&id) {
                record.cleanup_unconfirmed = cleanup_failed;
                record.status = if cleanup_failed {
                    "cleanupFailed"
                } else {
                    "disconnected"
                }
                .into();
                record.error = cleanup_failed.then(|| "MCP cleanup unconfirmed".into());
            }
        }
        let _persist = self.persist.lock().await;
        self.tools.write().unwrap().clear();
        let snapshot = self.records.read().unwrap().clone();
        store
            .save_metadata("mcp", &snapshot)
            .await
            .map_err(invalid)?;
        if failed {
            Err(invalid("MCP cleanup unconfirmed"))
        } else {
            Ok(())
        }
    }
}
impl Engine {
    pub fn mcp_list(&self) -> Value {
        let records = self.desktop.mcp.records.read().unwrap();
        let tools = self.desktop.mcp.tools.read().unwrap();
        json!({"data":records.values().map(|r| {let directory=tools.get(&r.id);let stale=directory.is_some_and(|ts|ts.iter().any(|t|t.is_stale()));json!({"id":r.id,"revision":r.revision,"directoryRevision":r.directory_revision,"config":r.config,"state":if stale {"stale"} else {&r.status},"error":r.error,"tools":directory.map(|ts|ts.iter().map(|t|&t.definition).collect::<Vec<_>>())})}).collect::<Vec<_>>()})
    }
    async fn persist_mcp(&self) -> Result<()> {
        // 调用方已持有短时元数据写门；不跨 MCP 网络等待持有它。
        let snapshot = self.desktop.mcp.records.read().unwrap().clone();
        self.store
            .save_metadata("mcp", &snapshot)
            .await
            .map_err(invalid)
    }
    pub async fn mcp_configure(
        self: &Arc<Self>,
        id: String,
        expected: u64,
        config: areal_mcp::ServerConfig,
    ) -> Result<Value> {
        self.mutate(move |engine| async move {
            if engine.extensions.mcp_servers.contains_key(&id) {
                return Err(invalid(
                    "deployment MCP definitions cannot be changed through RPC",
                ));
            }
            loop {
                // 未登记的新 ID 使用临时槽；验证成功前不增长最多 16 个服务的目录。
                let slot = engine
                    .desktop
                    .mcp
                    .connections
                    .read()
                    .unwrap()
                    .get(&id)
                    .cloned()
                    .unwrap_or_else(|| Arc::new(Mutex::new(None)));
                let _lifecycle = slot.clone().lock_owned().await;
                let _persist = engine.desktop.mcp.persist.lock().await;
                if engine
                    .desktop
                    .mcp
                    .connections
                    .read()
                    .unwrap()
                    .get(&id)
                    .is_some_and(|registered| !Arc::ptr_eq(registered, &slot))
                {
                    continue;
                }
                let mut records = engine.desktop.mcp.records.read().unwrap().clone();
                if records.get(&id).map_or(0, |record| record.revision) != expected {
                    return Err(Error::Conflict);
                }
                if records.get(&id).is_some_and(|record| {
                    record.status != "disconnected" && record.status != "failed"
                }) {
                    return Err(invalid("disconnect MCP before changing its configuration"));
                }
                let record = Record {
                    id: id.clone(),
                    revision: expected
                        .checked_add(1)
                        .ok_or_else(|| invalid("MCP revision exhausted"))?,
                    directory_revision: records
                        .get(&id)
                        .map_or(0, |record| record.directory_revision),
                    config: config.clone(),
                    cleanup_unconfirmed: false,
                    status: "disconnected".into(),
                    error: None,
                };
                records.insert(id.clone(), record.clone());
                areal_mcp::validate(
                    &records
                        .iter()
                        .map(|(id, record)| (id.clone(), record.config.clone()))
                        .collect(),
                )
                .map_err(invalid)?;
                if serde_json::to_vec(&records).map_err(invalid)?.len() > 1024 * 1024 {
                    return Err(invalid("MCP configuration exceeds 1 MiB"));
                }
                engine
                    .store
                    .save_metadata("mcp", &records)
                    .await
                    .map_err(invalid)?;
                engine
                    .desktop
                    .mcp
                    .records
                    .write()
                    .unwrap()
                    .insert(id.clone(), record);
                engine
                    .desktop
                    .mcp
                    .connections
                    .write()
                    .unwrap()
                    .entry(id)
                    .or_insert(slot);
                return Ok(engine.mcp_list());
            }
        })
        .await
    }
    pub async fn mcp_connection(
        self: &Arc<Self>,
        id: String,
        expected: u64,
        connect: bool,
    ) -> Result<Value> {
        self.mutate(move |engine| async move {
            let slot = engine
                .desktop
                .mcp
                .connections
                .read()
                .unwrap()
                .get(&id)
                .cloned()
                .ok_or(Error::NotFound)?;
            // 同服务只允许一个生命周期操作；其他服务不受它的握手/清理延迟影响。
            let mut connection_slot = slot.lock().await;
            let record = engine
                .desktop
                .mcp
                .records
                .read()
                .unwrap()
                .get(&id)
                .cloned()
                .ok_or(Error::NotFound)?;
            if record.revision != expected {
                return Err(Error::Conflict);
            }
            if record.cleanup_unconfirmed || record.status == "cleanupFailed" {
                return Err(invalid(
                    "MCP cleanup unconfirmed; automatic reconnect is blocked",
                ));
            }
            // 在启动宿主前检查目录版本；耗尽时不可留下未接管的新连接。
            let next_directory_revision = if connect {
                Some(
                    record
                        .directory_revision
                        .checked_add(1)
                        .ok_or_else(|| invalid("MCP directory revision exhausted"))?,
                )
            } else {
                None
            };
            if let Some(mut connection) = connection_slot.take() {
                {
                    let mut records = engine.desktop.mcp.records.write().unwrap();
                    let mut tools = engine.desktop.mcp.tools.write().unwrap();
                    records.get_mut(&id).unwrap().status = "disconnecting".into();
                    tools.remove(&id);
                }
                if connection.shutdown().await.is_err() {
                    let _persist = engine.desktop.mcp.persist.lock().await;
                    {
                        let mut records = engine.desktop.mcp.records.write().unwrap();
                        let record = records.get_mut(&id).unwrap();
                        record.cleanup_unconfirmed = true;
                        record.status = "cleanupFailed".into();
                        record.error = Some("MCP cleanup unconfirmed".into());
                    }
                    engine.persist_mcp().await?;
                    return Err(invalid("MCP cleanup unconfirmed"));
                }
            }
            {
                let mut records = engine.desktop.mcp.records.write().unwrap();
                let record = records.get_mut(&id).unwrap();
                record.status = if connect {
                    "connecting"
                } else {
                    "disconnected"
                }
                .into();
                record.error = None;
            }
            if connect {
                let configured = BTreeMap::from([(id.clone(), record.config)]);
                let result = areal_mcp::Connections::connect(
                    &configured,
                    &std::env::vars_os().collect(),
                    Path::new(&engine.default_cwd()),
                    engine.shutdown.child_token(),
                )
                .await;
                match result {
                    Ok(mut connection) => {
                        let tools = connection.tools();
                        let persist = engine.desktop.mcp.persist.lock().await;
                        // 锁序与 mcp_list 相同；跨服务的目录预算校验和发布必须是一次原子提交。
                        let committed = {
                            let mut records = engine.desktop.mcp.records.write().unwrap();
                            let mut directory = engine.desktop.mcp.tools.write().unwrap();
                            let mut combined =
                                directory.values().flatten().cloned().collect::<Vec<_>>();
                            combined.extend(tools.clone());
                            if engine.registry.clone().with_mcp(combined).is_err() {
                                false
                            } else {
                                let record = records.get_mut(&id).unwrap();
                                record.directory_revision = next_directory_revision.unwrap();
                                directory.insert(id.clone(), tools);
                                record.status = "connected".into();
                                true
                            }
                        };
                        if !committed {
                            drop(persist);
                            let cleanup_failed = connection.shutdown().await.is_err();
                            let _persist = engine.desktop.mcp.persist.lock().await;
                            {
                                let mut records = engine.desktop.mcp.records.write().unwrap();
                                let record = records.get_mut(&id).unwrap();
                                record.cleanup_unconfirmed = cleanup_failed;
                                record.status = if cleanup_failed {
                                    "cleanupFailed"
                                } else {
                                    "failed"
                                }
                                .into();
                                record.error = Some(
                                    if cleanup_failed {
                                        "MCP directory rollback cleanup unconfirmed"
                                    } else {
                                        "MCP directory conflicts or exceeds the tool budget"
                                    }
                                    .into(),
                                );
                            }
                            engine.persist_mcp().await?;
                            return Err(invalid(if cleanup_failed {
                                "MCP directory rollback cleanup unconfirmed"
                            } else {
                                "MCP directory conflicts or exceeds the tool budget"
                            }));
                        }
                        *connection_slot = Some(ManagedConnection::Live(connection));
                        engine.persist_mcp().await?;
                    }
                    Err(error) => {
                        let _persist = engine.desktop.mcp.persist.lock().await;
                        {
                            let mut records = engine.desktop.mcp.records.write().unwrap();
                            let record = records.get_mut(&id).unwrap();
                            record.cleanup_unconfirmed = error
                                .chain()
                                .any(|cause| cause.is::<areal_mcp::CleanupUnconfirmed>());
                            record.status = if record.cleanup_unconfirmed {
                                "cleanupFailed"
                            } else {
                                "failed"
                            }
                            .into();
                            record.error = Some(
                                if record.cleanup_unconfirmed {
                                    "MCP connection rollback cleanup unconfirmed"
                                } else {
                                    "MCP connection or discovery failed"
                                }
                                .into(),
                            );
                        }
                        engine.persist_mcp().await?;
                    }
                }
            } else {
                let _persist = engine.desktop.mcp.persist.lock().await;
                engine.persist_mcp().await?;
            }
            Ok(engine.mcp_list())
        })
        .await
    }
    pub(crate) fn managed_registry(
        &self,
        thread: &Thread,
        research: bool,
    ) -> anyhow::Result<crate::tools::Registry> {
        let mut tools = self.desktop.mcp.tools();
        let config = desktop(thread).configuration;
        if !thread.is_read_only_side()
            && !research
            && config.allow_plugin_skills
            && !config.read_only
        {
            tools.extend(self.desktop.plugin_mcp.tools());
        }
        let mut registry = self.registry.clone();
        // 报告能力只接入可信隔离 worker；禁用委派的普通 Engine 保留外部同名工具兼容。
        if (self
            .desktop
            .worker_model
            .load(std::sync::atomic::Ordering::Acquire)
            || thread.source == "workgroupWorker")
            && registry.get("agent_report").is_err()
        {
            registry = registry.with_agents(false, true)?;
        }
        let registry = registry
            .with_mcp(tools)?
            .with_dynamic(&thread.dynamic_tools)?;
        let registry = if !thread.is_read_only_side()
            && !research
            && config.allow_plugin_skills
            && !config.read_only
        {
            self.page_registry(registry, thread)?
        } else {
            registry
        };
        Ok(if thread.is_read_only_side() {
            registry.side_only(thread.side_workspace_read())
        } else if research {
            registry.research_only()
        } else {
            registry
        })
    }
}

#[cfg(test)]
mod cleanup_tests {
    use super::*;
    struct Pending;
    #[async_trait::async_trait]
    impl crate::model::Model for Pending {
        fn name(&self) -> &str {
            "mcp-cleanup-fixture"
        }
        async fn stream(
            &self,
            _: Vec<crate::model::Message>,
        ) -> anyhow::Result<crate::model::ModelStream> {
            std::future::pending().await
        }
    }
    #[tokio::test]
    async fn cleanup_failed_disconnect_cannot_claim_success_or_reconnect() {
        let root = tempfile::tempdir().unwrap();
        let engine = Engine::open(root.path(), Arc::new(Pending), Limits::default()).unwrap();
        let config = serde_json::from_value(json!({"transport":{"type":"stdio","command":"/fixture/never-start","args":[],"cwd":null,"envVars":[]}})).unwrap();
        engine
            .mcp_configure("failed".into(), 0, config)
            .await
            .unwrap();
        {
            let mut records = engine.desktop.mcp.records.write().unwrap();
            let record = records.get_mut("failed").unwrap();
            record.status = "cleanupFailed".into();
            record.error = Some("MCP cleanup unconfirmed".into());
        }
        for connect in [false, true] {
            assert!(
                engine
                    .mcp_connection("failed".into(), 1, connect)
                    .await
                    .is_err()
            );
            assert_eq!(engine.mcp_list()["data"][0]["state"], "cleanupFailed");
        }
        engine.shutdown().await;
    }
}

#[cfg(test)]
mod shutdown_tests {
    use super::*;
    struct Pending;
    #[async_trait::async_trait]
    impl crate::model::Model for Pending {
        fn name(&self) -> &str {
            "cleanup-shutdown-fixture"
        }
        async fn stream(
            &self,
            _: Vec<crate::model::Message>,
        ) -> anyhow::Result<crate::model::ModelStream> {
            std::future::pending().await
        }
    }
    #[tokio::test]
    async fn shutdown_cleanup_failure_survives_store_reopen() {
        let root = tempfile::tempdir().unwrap();
        let engine = Engine::open(root.path(), Arc::new(Pending), Limits::default()).unwrap();
        let config = serde_json::from_value(json!({"transport":{"type":"stdio","command":"/fixture/never-start","args":[],"cwd":null,"envVars":[]}})).unwrap();
        engine
            .mcp_configure("shutdown-failure".into(), 0, config)
            .await
            .unwrap();
        let slot = engine
            .desktop
            .mcp
            .connections
            .read()
            .unwrap()
            .get("shutdown-failure")
            .unwrap()
            .clone();
        *slot.lock().await = Some(ManagedConnection::CleanupFailureFixture);
        engine.shutdown().await;
        assert_eq!(engine.mcp_list()["data"][0]["state"], "cleanupFailed");
        drop(engine);
        // 已完成的 mutation 任务可能仍在释放最后的 Store 引用；等待实际锁释放，不能固定 sleep。
        // 这里只重试明确的目录占用，持续泄漏仍须在有界期限内失败。
        let reopened = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                match Engine::open(root.path(), Arc::new(Pending), Limits::default()) {
                    Ok(engine) => break engine,
                    Err(error)
                        if error
                            .to_string()
                            .contains("another Core owns the data directory") =>
                    {
                        tokio::task::yield_now().await;
                    }
                    Err(error) => panic!("reopen failed: {error:#}"),
                }
            }
        })
        .await
        .expect("old Core did not release its directory lock after shutdown");
        assert_eq!(reopened.mcp_list()["data"][0]["state"], "cleanupFailed");
        assert!(
            reopened
                .mcp_connection("shutdown-failure".into(), 1, true)
                .await
                .is_err()
        );
        reopened.shutdown().await;
    }
}

#[cfg(test)]
mod isolation_tests {
    use super::*;
    struct Pending;
    #[async_trait::async_trait]
    impl crate::model::Model for Pending {
        fn name(&self) -> &str {
            "mcp-isolation"
        }
        async fn stream(
            &self,
            _: Vec<crate::model::Message>,
        ) -> anyhow::Result<crate::model::ModelStream> {
            std::future::pending().await
        }
    }
    #[tokio::test]
    async fn slow_a_handshake_does_not_block_b_control() {
        let root = tempfile::tempdir().unwrap();
        let log = root.path().join("owned-peer.jsonl");
        let engine = Engine::open(root.path(), Arc::new(Pending), Limits::default()).unwrap();
        let fixture =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/mcp-server.py");
        let config = serde_json::from_value(json!({"transport":{"type":"stdio","command":"/usr/bin/python3","args":[fixture,log,"hang-startup"],"cwd":null,"envVars":[]},"startupTimeoutMs":1500})).unwrap();
        engine.mcp_configure("a".into(), 0, config).await.unwrap();
        let other: areal_mcp::ServerConfig = serde_json::from_value(json!({"transport":{"type":"stdio","command":"/fixture/never-start","args":[],"cwd":null,"envVars":[]}})).unwrap();
        engine
            .mcp_configure("b".into(), 0, other.clone())
            .await
            .unwrap();
        let a_engine = engine.clone();
        let a = tokio::spawn(async move { a_engine.mcp_connection("a".into(), 1, true).await });
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if std::fs::read_to_string(&log)
                    .unwrap_or_default()
                    .contains("initialize")
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let b = tokio::time::timeout(
            std::time::Duration::from_millis(300),
            engine.mcp_connection("b".into(), 1, false),
        )
        .await;
        let updated = tokio::time::timeout(
            std::time::Duration::from_millis(300),
            engine.mcp_configure("b".into(), 1, other),
        )
        .await;
        a.await.unwrap().unwrap();
        let list = engine.mcp_list();
        let b_record = list["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|record| record["id"] == "b")
            .unwrap();
        assert_eq!(
            b_record["revision"], 2,
            "late A result overwrote B revision"
        );
        assert!(
            updated.is_ok_and(|result| result.is_ok()),
            "A blocked B configuration"
        );
        engine.shutdown().await;
        assert!(
            b.is_ok_and(|result| result.is_ok()),
            "A's handshake blocked unrelated B disconnect"
        );
    }
    #[tokio::test]
    async fn concurrent_new_id_configuration_has_one_revision_winner() {
        let root = tempfile::tempdir().unwrap();
        let engine = Engine::open(root.path(), Arc::new(Pending), Limits::default()).unwrap();
        let config: areal_mcp::ServerConfig = serde_json::from_value(json!({"transport":{"type":"stdio","command":"/fixture/never-start","args":[],"cwd":null,"envVars":[]}})).unwrap();
        let (a, b) = tokio::join!(
            engine.mcp_configure("same".into(), 0, config.clone()),
            engine.mcp_configure("same".into(), 0, config)
        );
        assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
        assert!(matches!(a, Err(Error::Conflict)) || matches!(b, Err(Error::Conflict)));
        assert_eq!(engine.desktop.mcp.connections.read().unwrap().len(), 1);
        let restored = Manager::open(root.path()).unwrap();
        assert_eq!(restored.records.read().unwrap()["same"].revision, 1);
        engine.shutdown().await;
    }
    #[tokio::test]
    async fn concurrent_directory_publish_preserves_global_budget_and_cleans_rollback() {
        let root = tempfile::tempdir().unwrap();
        let engine = Engine::open(root.path(), Arc::new(Pending), Limits::default()).unwrap();
        let fixture =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/mcp-server.py");
        for id in ["a", "b"] {
            let config = serde_json::from_value(json!({"transport":{"type":"stdio","command":"/usr/bin/python3","args":[fixture,root.path().join(format!("{id}.jsonl")),"budget-tools"],"cwd":null,"envVars":[]},"startupTimeoutMs":2000})).unwrap();
            engine.mcp_configure(id.into(), 0, config).await.unwrap();
        }
        let (a, b) = tokio::join!(
            engine.mcp_connection("a".into(), 1, true),
            engine.mcp_connection("b".into(), 1, true)
        );
        assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
        let list = engine.mcp_list();
        let records = list["data"].as_array().unwrap();
        assert_eq!(
            records.iter().filter(|r| r["state"] == "connected").count(),
            1
        );
        assert_eq!(engine.desktop.mcp.tools().len(), 70);
        assert!(
            engine
                .registry
                .clone()
                .with_mcp(engine.desktop.mcp.tools())
                .is_ok()
        );
        let failed = records.iter().find(|r| r["state"] == "failed").unwrap();
        assert_eq!(failed["directoryRevision"], 0);
        assert!(
            std::fs::read_to_string(
                root.path()
                    .join(format!("{}.jsonl", failed["id"].as_str().unwrap()))
            )
            .unwrap()
            .contains("exited")
        );
        engine.shutdown().await;
    }
    #[tokio::test]
    async fn exhausted_directory_revision_rejects_before_starting_a_host() {
        let root = tempfile::tempdir().unwrap();
        let log = root.path().join("must-not-start.jsonl");
        let engine = Engine::open(root.path(), Arc::new(Pending), Limits::default()).unwrap();
        let fixture =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/mcp-server.py");
        let config = serde_json::from_value(json!({"transport":{"type":"stdio","command":"/usr/bin/python3","args":[fixture,log],"cwd":null,"envVars":[]}})).unwrap();
        engine
            .mcp_configure("exhausted".into(), 0, config)
            .await
            .unwrap();
        engine
            .desktop
            .mcp
            .records
            .write()
            .unwrap()
            .get_mut("exhausted")
            .unwrap()
            .directory_revision = u64::MAX;
        assert!(
            matches!(engine.mcp_connection("exhausted".into(), 1, true).await, Err(Error::Invalid(message)) if message == "MCP directory revision exhausted")
        );
        assert!(!log.exists());
        assert_eq!(engine.mcp_list()["data"][0]["state"], "disconnected");
        engine.shutdown().await;
    }
}
