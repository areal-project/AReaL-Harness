//! 用户直接添加的 MCP：每个服务生成一个只含该服务的本地插件，走与其他插件相同的安装、启用与连接。
use crate::{PluginDetail, PluginList, Store};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{fs, path::PathBuf};

/// 本地 MCP 插件所在市场名；插件 id 为 `<服务名>@local-mcp`。
pub const LOCAL_MCP_MARKETPLACE: &str = "local-mcp";
const CATALOG: &str = ".agents/plugins/marketplace.json";

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 32
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

impl Store {
    pub(crate) fn local_mcp_root(&self) -> PathBuf {
        self.root.join(LOCAL_MCP_MARKETPLACE)
    }
    fn local_mcp_entries(&self) -> Result<Vec<Value>> {
        match fs::read(self.local_mcp_root().join(CATALOG)) {
            Ok(bytes) => Ok(serde_json::from_slice::<Value>(&bytes)?["plugins"]
                .as_array()
                .cloned()
                .unwrap_or_default()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(e.into()),
        }
    }
    fn write_local_mcp_catalog(&self, entries: Vec<Value>) -> Result<()> {
        let path = self.local_mcp_root().join(CATALOG);
        fs::create_dir_all(path.parent().context("catalog parent")?)?;
        let body = json!({"name": LOCAL_MCP_MARKETPLACE, "plugins": entries});
        let mut tmp = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
        std::io::Write::write_all(&mut tmp, &serde_json::to_vec_pretty(&body)?)?;
        tmp.persist(path)?;
        Ok(())
    }

    /// 直接添加的 MCP 服务及其声明，按名字排序；供设置页编辑。
    pub fn local_mcp_servers(&self) -> Result<Vec<(String, Value)>> {
        let mut servers = Vec::new();
        for entry in self.local_mcp_entries()? {
            let Some(name) = entry["name"].as_str().filter(|name| valid_name(name)) else {
                continue;
            };
            let path = self
                .local_mcp_root()
                .join("plugins")
                .join(name)
                .join(".mcp.json");
            let document: Value = serde_json::from_slice(&fs::read(path)?)?;
            servers.push((name.to_owned(), document["mcpServers"][name].clone()));
        }
        servers.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(servers)
    }

    /// 保存（新增或替换）一个直接添加的 MCP 服务，并以用户默认启用安装。
    ///
    /// `server` 是 Codex `.mcp.json` 里单个服务的声明，支持 stdio、HTTP、header、
    /// 环境变量引用与 OAuth；密钥值不写进包。
    pub fn save_local_mcp(
        &self,
        name: &str,
        server: &Value,
        expected_revision: u64,
    ) -> Result<PluginDetail> {
        ensure!(valid_name(name), "invalid MCP server name");
        let document = json!({"mcpServers": {name: server}});
        let outcome = areal_mcp::normalize_plugin_document(
            false,
            &document,
            &self.root.join("staging"),
            &self.root.join("data"),
        )?;
        if let Some(diagnostic) = outcome.diagnostics.first() {
            anyhow::bail!("invalid MCP server: {}", diagnostic.message);
        }
        ensure!(outcome.servers.contains_key(name), "invalid MCP server");
        let package = self.local_mcp_root().join("plugins").join(name);
        let staged = self
            .local_mcp_root()
            .join("plugins")
            .join(format!(".{name}.new"));
        let _ = fs::remove_dir_all(&staged);
        fs::create_dir_all(staged.join(".codex-plugin"))?;
        fs::write(
            staged.join(".codex-plugin/plugin.json"),
            serde_json::to_vec_pretty(&json!({
                "name": name,
                "version": "1.0.0",
                "description": format!("MCP server {name}, added directly by the user."),
                "interface": {"displayName": name, "category": "MCP"},
            }))?,
        )?;
        fs::write(
            staged.join(".mcp.json"),
            serde_json::to_vec_pretty(&document)?,
        )?;
        let _ = fs::remove_dir_all(&package);
        fs::rename(&staged, &package)?;
        let mut entries = self.local_mcp_entries()?;
        if !entries.iter().any(|entry| entry["name"] == name) {
            entries.push(json!({"name": name, "source": {"source": "local", "path": format!("./plugins/{name}")}, "category": "MCP"}));
            self.write_local_mcp_catalog(entries)?;
        }
        let id = format!("{name}@{LOCAL_MCP_MARKETPLACE}");
        let candidate = self.read(&id)?;
        self.install(
            &id,
            "user",
            expected_revision,
            &candidate.source,
            candidate.review_digest(),
        )
    }

    /// 卸载直接添加的 MCP 并删掉生成的包；已安装快照按原有规则保留给历史引用。
    pub fn remove_local_mcp(&self, name: &str, expected_revision: u64) -> Result<PluginList> {
        ensure!(valid_name(name), "invalid MCP server name");
        let id = format!("{name}@{LOCAL_MCP_MARKETPLACE}");
        self.uninstall(&id, expected_revision)?;
        let entries = self
            .local_mcp_entries()?
            .into_iter()
            .filter(|entry| entry["name"] != name)
            .collect();
        self.write_local_mcp_catalog(entries)?;
        let _ = fs::remove_dir_all(self.local_mcp_root().join("plugins").join(name));
        self.list()
    }
}
