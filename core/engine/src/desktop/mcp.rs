//! 管理配置与已连接目录分离；现有 Turn 保留原工具对象与失效标志。
use super::*;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    id: String,
    revision: u64,
    directory_revision: u64,
    config: areal_mcp::ServerConfig,
    #[serde(skip)]
    status: String,
    #[serde(skip)]
    error: Option<String>,
}
pub(crate) struct Manager {
    records: std::sync::RwLock<BTreeMap<String, Record>>,
    connections: Mutex<BTreeMap<String, areal_mcp::Connections>>,
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
            record.status = "disconnected".into();
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
    pub async fn shutdown(&self) -> Result<()> {
        let mut connections = self.connections.lock().await;
        let mut failed = false;
        for connection in connections.values_mut() {
            failed |= connection.shutdown().await.is_err();
        }
        connections.clear();
        self.tools.write().unwrap().clear();
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
            if let Some(mut connection) = connections.remove(&id) {
                engine.desktop.mcp.tools.write().unwrap().remove(&id);
                if connection.shutdown().await.is_err() {
                    let mut records = engine.desktop.mcp.records.write().unwrap();
                    let r = records.get_mut(&id).unwrap();
                    r.status = "cleanupFailed".into();
                    r.error = Some("MCP cleanup unconfirmed".into());
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
                            let _ = connection.shutdown().await;
                            let mut records = engine.desktop.mcp.records.write().unwrap();
                            let r = records.get_mut(&id).unwrap();
                            r.status = "failed".into();
                            r.error =
                                Some("MCP directory conflicts or exceeds the tool budget".into());
                            return Err(invalid(
                                "MCP directory conflicts or exceeds the tool budget",
                            ));
                        }
                        engine
                            .desktop
                            .mcp
                            .tools
                            .write()
                            .unwrap()
                            .insert(id.clone(), tools);
                        connections.insert(id.clone(), connection);
                        let mut records = engine.desktop.mcp.records.write().unwrap();
                        let r = records.get_mut(&id).unwrap();
                        r.status = "connected".into();
                        r.directory_revision += 1;
                    }
                    Err(_) => {
                        let mut records = engine.desktop.mcp.records.write().unwrap();
                        let r = records.get_mut(&id).unwrap();
                        r.status = "failed".into();
                        r.error = Some("MCP connection or discovery failed".into());
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
        let definitions = cell.state.lock().await.thread.dynamic_tools.clone();
        let registry = self
            .registry
            .clone()
            .with_mcp(self.desktop.mcp.tools())?
            .with_dynamic(&definitions)?;
        cell.bindings.write().await.registry = if cell.research {
            registry.research_only()
        } else {
            registry
        };
        Ok(())
    }
}
