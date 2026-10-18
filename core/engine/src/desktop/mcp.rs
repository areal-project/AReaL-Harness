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
pub(crate) struct Manager {
    records: std::sync::RwLock<BTreeMap<String, Record>>,
    connections: Mutex<BTreeMap<String, ManagedConnection>>,
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
        Ok(Self {
            records: std::sync::RwLock::new(records),
            connections: Mutex::new(BTreeMap::new()),
            tools: std::sync::RwLock::new(BTreeMap::new()),
        })
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
        let mut connections = self.connections.lock().await;
        let mut failed = false;
        for (id, connection) in connections.iter_mut() {
            let cleanup_failed = connection.shutdown().await.is_err();
            failed |= cleanup_failed;
            if let Some(record) = self.records.write().unwrap().get_mut(id) {
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
        connections.clear();
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
    pub async fn mcp_configure(
        self: &Arc<Self>,
        id: String,
        expected: u64,
        config: areal_mcp::ServerConfig,
    ) -> Result<Value> {
        self.mutate(move |engine| async move {
            let _guard = engine.desktop.mcp.connections.lock().await;
            if engine.extensions.mcp_servers.contains_key(&id) {
                return Err(invalid(
                    "deployment MCP definitions cannot be changed through RPC",
                ));
            }
            let mut records = engine.desktop.mcp.records.read().unwrap().clone();
            if records.get(&id).map_or(0, |r| r.revision) != expected {
                return Err(Error::Conflict);
            }
            if records
                .get(&id)
                .is_some_and(|r| r.status != "disconnected" && r.status != "failed")
            {
                return Err(invalid("disconnect MCP before changing its configuration"));
            }
            records.insert(
                id.clone(),
                Record {
                    id: id.clone(),
                    revision: expected + 1,
                    directory_revision: records.get(&id).map_or(0, |r| r.directory_revision),
                    config,
                    cleanup_unconfirmed: false,
                    status: "disconnected".into(),
                    error: None,
                },
            );
            areal_mcp::validate(
                &records
                    .iter()
                    .map(|(id, r)| (id.clone(), r.config.clone()))
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
            *engine.desktop.mcp.records.write().unwrap() = records;
            Ok(engine.mcp_list())
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
            let mut connections = engine.desktop.mcp.connections.lock().await;
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
            if let Some(mut connection) = connections.remove(&id) {
                engine.desktop.mcp.tools.write().unwrap().remove(&id);
                if connection.shutdown().await.is_err() {
                    let snapshot = {
                        let mut records = engine.desktop.mcp.records.write().unwrap();
                        let r = records.get_mut(&id).unwrap();
                        r.status = "cleanupFailed".into();
                        r.cleanup_unconfirmed = true;
                        r.error = Some("MCP cleanup unconfirmed".into());
                        records.clone()
                    };
                    engine
                        .store
                        .save_metadata("mcp", &snapshot)
                        .await
                        .map_err(invalid)?;
                    return Err(invalid("MCP cleanup unconfirmed"));
                }
            }
            {
                let mut records = engine.desktop.mcp.records.write().unwrap();
                let r = records.get_mut(&id).unwrap();
                r.status = if connect {
                    "connecting"
                } else {
                    "disconnected"
                }
                .into();
                r.error = None;
            }
            if connect {
                let env = std::env::vars_os().collect();
                let configured = BTreeMap::from([(id.clone(), record.config)]);
                let result = areal_mcp::Connections::connect(
                    &configured,
                    &env,
                    Path::new(&engine.default_cwd()),
                    engine.shutdown.child_token(),
                )
                .await;
                match result {
                    Ok(mut connection) => {
                        let tools = connection.tools();
                        let mut combined = engine.desktop.mcp.tools();
                        combined.extend(tools.clone());
                        if engine.registry.clone().with_mcp(combined).is_err() {
                            let cleanup_failed = connection.shutdown().await.is_err();
                            let snapshot = {
                                let mut records = engine.desktop.mcp.records.write().unwrap();
                                let r = records.get_mut(&id).unwrap();
                                r.cleanup_unconfirmed = cleanup_failed;
                                r.status = if cleanup_failed {
                                    "cleanupFailed"
                                } else {
                                    "failed"
                                }
                                .into();
                                r.error = Some(
                                    "MCP directory conflicts or exceeds the tool budget".into(),
                                );
                                records.clone()
                            };
                            engine
                                .store
                                .save_metadata("mcp", &snapshot)
                                .await
                                .map_err(invalid)?;
                            return Err(invalid(if cleanup_failed {
                                "MCP directory rollback cleanup unconfirmed"
                            } else {
                                "MCP directory conflicts or exceeds the tool budget"
                            }));
                        }
                        engine
                            .desktop
                            .mcp
                            .tools
                            .write()
                            .unwrap()
                            .insert(id.clone(), tools);
                        connections.insert(id.clone(), ManagedConnection::Live(connection));
                        let mut records = engine.desktop.mcp.records.write().unwrap();
                        let r = records.get_mut(&id).unwrap();
                        r.status = "connected".into();
                        r.directory_revision += 1;
                    }
                    Err(error) => {
                        let mut records = engine.desktop.mcp.records.write().unwrap();
                        let r = records.get_mut(&id).unwrap();
                        r.cleanup_unconfirmed = error
                            .chain()
                            .any(|cause| cause.is::<areal_mcp::CleanupUnconfirmed>());
                        r.status = if r.cleanup_unconfirmed {
                            "cleanupFailed"
                        } else {
                            "failed"
                        }
                        .into();
                        r.error = Some(
                            if r.cleanup_unconfirmed {
                                "MCP connection rollback cleanup unconfirmed"
                            } else {
                                "MCP connection or discovery failed"
                            }
                            .into(),
                        );
                    }
                }
            }
            let snapshot = engine.desktop.mcp.records.read().unwrap().clone();
            engine
                .store
                .save_metadata("mcp", &snapshot)
                .await
                .map_err(invalid)?;
            Ok(engine.mcp_list())
        })
        .await
    }
    pub(crate) async fn refresh_managed_tools(&self, cell: &Cell) -> anyhow::Result<()> {
        let state = cell.state.lock().await;
        let side = state.thread.is_side();
        let side_workspace_read = state.thread.side_workspace_read();
        let definitions = state.thread.dynamic_tools.clone();
        drop(state);
        let registry = self
            .registry
            .clone()
            .with_mcp(self.desktop.mcp.tools())?
            .with_dynamic(&definitions)?;
        cell.bindings.write().await.registry = if side {
            registry.side_only(side_workspace_read)
        } else if cell.research {
            registry.research_only()
        } else {
            registry
        };
        Ok(())
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
        engine.desktop.mcp.connections.lock().await.insert(
            "shutdown-failure".into(),
            ManagedConnection::CleanupFailureFixture,
        );
        engine.shutdown().await;
        assert_eq!(engine.mcp_list()["data"][0]["state"], "cleanupFailed");
        drop(engine);
        let reopened = Engine::open(root.path(), Arc::new(Pending), Limits::default()).unwrap();
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
