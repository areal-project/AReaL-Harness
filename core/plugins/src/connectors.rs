//! 市场 `connectors.json`：把插件 `.app.json` 声明的连接器 ID 在安装时解析成普通远程 MCP。
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path};

pub(crate) const CATALOG: &str = "connectors.json";
const SCHEMA: &str = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

/// 返回 `连接器 ID → {service, server}`，server 是 Agent Plugins MCP 服务声明；
/// 市场未收录的 ID 不出现在结果里，由连接状态报告为不支持。
pub(crate) fn resolve(market_root: &Path, app_ids: &[String]) -> Result<BTreeMap<String, Value>> {
    if app_ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    let path = market_root.join(CATALOG);
    if std::fs::symlink_metadata(&path).is_err() {
        return Ok(BTreeMap::new());
    }
    let catalog: Value =
        serde_json::from_slice(&crate::package::read_catalog(market_root, &path)?)?;
    ensure!(
        catalog["version"] == 1,
        "unsupported connectors.json version"
    );
    let services = catalog["services"]
        .as_array()
        .context("connectors.json services missing")?;
    let mut result = BTreeMap::new();
    for id in app_ids {
        let Some(service) = services.iter().find(|service| {
            service["id"].as_str() == Some(id)
                || service["aliases"]
                    .as_array()
                    .is_some_and(|aliases| aliases.iter().any(|alias| alias.as_str() == Some(id)))
        }) else {
            continue;
        };
        let name = service["id"].as_str().context("connector id missing")?;
        let url = service["mcp"]["url"]
            .as_str()
            .context("connector url missing")?;
        ensure!(url.starts_with("https://"), "connector url must use https");
        let mut server = json!({"type":"streamable-http","url":url});
        if let Some(auth) = service.get("auth") {
            server["extensions"] = json!({"com.openai":{"auth":auth}});
        }
        result.insert(id.clone(), json!({"service":name,"server":server}));
    }
    Ok(result)
}

/// 解析结果存为一份可移植 MCP 文档，与包内声明走同一条校验与连接路径。
pub(crate) fn document(connectors: &BTreeMap<String, Value>) -> Value {
    let servers: serde_json::Map<String, Value> = connectors
        .values()
        .filter_map(|c| Some((c["service"].as_str()?.to_owned(), c["server"].clone())))
        .collect();
    json!({"$schema":SCHEMA,"mcpServers":servers})
}

/// 连接器 ID → 解析出的服务名。
pub(crate) fn services(connectors: &BTreeMap<String, Value>) -> BTreeMap<String, String> {
    connectors
        .iter()
        .filter_map(|(id, c)| Some((id.clone(), c["service"].as_str()?.to_owned())))
        .collect()
}
