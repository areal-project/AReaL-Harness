use super::*;
use std::collections::BTreeSet;

const EAGER_LIMIT: usize = 16;
const CATALOG_BYTES: usize = 16 * 1024;

#[derive(Default)]
pub(crate) struct ToolExposure {
    catalog: Vec<ToolSummary>,
    loaded: BTreeSet<String>,
    offered: Option<BTreeSet<String>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolSummary {
    name: String,
    server_id: String,
    description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    invocation: Option<NativeInvocation>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeInvocation {
    entrypoint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    member: Option<String>,
}

impl ToolExposure {
    pub(crate) fn admits(&self, name: &str) -> bool {
        self.offered
            .as_ref()
            .is_none_or(|names| names.contains(name))
    }

    fn search(&mut self, query: &str, limit: usize) -> Value {
        let query = query.trim().to_lowercase();
        let terms: Vec<_> = query.split_whitespace().collect();
        let mut matches: Vec<_> = self
            .catalog
            .iter()
            .filter(|tool| {
                // 常用入口只补精确名称，避免挤占原有模糊发现的有界结果。
                if tool.invocation.is_some()
                    && common_native(&tool.name)
                    && tool.name.to_lowercase() != query
                {
                    return false;
                }
                let text =
                    format!("{} {} {}", tool.name, tool.server_id, tool.description).to_lowercase();
                terms.iter().all(|term| text.contains(term))
            })
            .cloned()
            .collect();
        matches.sort_by_key(|tool| (tool.name.to_lowercase() != query, tool.name.clone()));
        let truncated = matches.len() > limit;
        matches.truncate(limit);
        self.loaded
            .extend(matches.iter().map(|tool| tool.name.clone()));
        json!({"tools": matches, "truncated": truncated})
    }
}

impl Engine {
    pub(crate) async fn project_native_tools(
        &self,
        cell: &Cell,
        mut definitions: Vec<Value>,
    ) -> Vec<Value> {
        if !self.extensions.policy.compact_tools
            || !definitions
                .iter()
                .any(|d| d["function"]["name"] == "tool_search")
        {
            return definitions;
        }
        let bindings = cell.bindings.read().await;
        let program_only = self.extensions.policy.programmatic_tools_only
            && definitions
                .iter()
                .any(|d| d["function"]["name"] == "tool_program");
        let catalog: Vec<_> = definitions
            .iter()
            .filter_map(|d| {
                let name = d["function"]["name"].as_str()?;
                let entry = bindings.registry.get(name).ok()?;
                if !matches!(
                    entry.backend,
                    crate::tools::Backend::Builtin
                        | crate::tools::Backend::Core
                        | crate::tools::Backend::Agent
                        | crate::tools::Backend::Coordination
                ) {
                    return None;
                }
                let through_program = program_only
                    && crate::tools::program::eligible(&entry)
                    && !self
                        .extensions
                        .policy
                        .programmatic_direct_tools
                        .iter()
                        .any(|n| n == name);
                Some(ToolSummary {
                    name: name.into(),
                    server_id: "native".into(),
                    description: d["function"]["description"]
                        .as_str()
                        .unwrap_or("")
                        .chars()
                        .take(256)
                        .collect(),
                    invocation: Some(NativeInvocation {
                        entrypoint: if through_program {
                            "tool_program"
                        } else {
                            name
                        }
                        .into(),
                        member: through_program.then(|| format!("tools.{name}")),
                    }),
                })
            })
            .collect();
        drop(bindings);
        let mut state = cell.state.lock().await;
        let Some(active) = state.active.as_mut() else {
            return definitions;
        };
        let exposure = &mut active.native_tool_exposure;
        exposure.catalog = catalog;
        // 常用入口也可被搜索解释，但不能因此延迟原来已展示的 schema。
        let names: BTreeSet<_> = exposure
            .catalog
            .iter()
            .filter(|t| !common_native(&t.name))
            .map(|t| t.name.as_str())
            .collect();
        definitions.retain(|d| {
            let name = d["function"]["name"].as_str().unwrap_or("");
            !names.contains(name) || exposure.loaded.contains(name)
        });
        // 目录只列名字，详情在发现之后进入下一次请求；不复制完整 schema。
        if let Some(search) = definitions
            .iter_mut()
            .find(|d| d["function"]["name"] == "tool_search")
        {
            let directory = exposure
                .catalog
                .iter()
                .filter(|t| !common_native(&t.name))
                .map(|t| t.name.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            let description = search["function"]["description"].as_str().unwrap_or("");
            search["function"]["description"] =
                json!(format!("{description} Available names: {directory}"));
        }
        definitions
    }

    pub(super) async fn native_tool_search(
        &self,
        cell: &Cell,
        turn_id: &str,
        args: &Value,
    ) -> Result<Value> {
        if !self.extensions.policy.compact_tools {
            return Err(invalid("compact tools are disabled"));
        }
        let query = args["query"]
            .as_str()
            .ok_or_else(|| invalid("query is required"))?;
        let limit = args["limit"].as_u64().unwrap_or(4) as usize;
        if query.len() > 512 || !(1..=8).contains(&limit) {
            return Err(invalid("invalid native search budget"));
        }
        let mut state = cell.state.lock().await;
        let active = state
            .active
            .as_mut()
            .filter(|a| a.id == turn_id)
            .ok_or(Error::Conflict)?;
        let mut result = active.native_tool_exposure.search(query, limit);
        result["guidance"] = json!(
            "Use each result's invocation on the NEXT model request; no further search is needed. entrypoint is the model tool name; member means call it inside tool_program code, with its parameters shown in that tool's description. Do not call newly discovered tools in this batch. An empty result means no catalog match, not that a tool is unavailable; use an exact name from the current definitions or directory."
        );
        Ok(result)
    }

    pub(crate) async fn project_mcp_tools(
        &self,
        cell: &Cell,
        mut definitions: Vec<Value>,
    ) -> Vec<Value> {
        if !self.extensions.policy.lazy_mcp_schemas {
            return definitions;
        }
        let bindings = cell.bindings.read().await;
        let catalog: Vec<_> = definitions
            .iter()
            .filter_map(|definition| {
                let name = definition["function"]["name"].as_str()?;
                let entry = bindings.registry.get(name).ok()?;
                let crate::tools::Backend::Mcp(tool) = &entry.backend else {
                    return None;
                };
                Some(ToolSummary {
                    name: name.into(),
                    server_id: tool.server_name().into(),
                    description: definition["function"]["description"]
                        .as_str()
                        .unwrap_or("")
                        .chars()
                        .take(256)
                        .collect(),
                    invocation: None,
                })
            })
            .collect();
        drop(bindings);
        let search_available = definitions
            .iter()
            .any(|d| d["function"]["name"] == "mcp_tool_search");
        let mut state = cell.state.lock().await;
        let Some(active) = state.active.as_mut() else {
            return definitions;
        };
        let exposure = &mut active.tool_exposure;
        if catalog.len() <= EAGER_LIMIT || !search_available {
            definitions.retain(|d| d["function"]["name"] != "mcp_tool_search");
            exposure.offered = None;
            return definitions;
        }
        exposure.catalog = catalog;
        let names: BTreeSet<_> = exposure.catalog.iter().map(|t| t.name.as_str()).collect();
        definitions.retain(|definition| {
            let name = definition["function"]["name"].as_str().unwrap_or("");
            !names.contains(name) || exposure.loaded.contains(name)
        });
        exposure.offered = Some(
            definitions
                .iter()
                .filter_map(|d| d["function"]["name"].as_str().map(str::to_owned))
                .collect(),
        );
        let mut directory = String::new();
        for tool in &exposure.catalog {
            let line = format!("\n{} [{}]: {}", tool.name, tool.server_id, tool.description);
            if directory.len() + line.len() > CATALOG_BYTES {
                break;
            }
            directory.push_str(&line);
        }
        if let Some(search) = definitions
            .iter_mut()
            .find(|d| d["function"]["name"] == "mcp_tool_search")
        {
            search["function"]["description"] = json!(format!(
                "Search the current Turn's authorized MCP tools by name, server or description. Matching schemas become available on the NEXT model request. Do not call newly discovered tools in the same batch. Results contain summaries only. This bounded directory can omit entries; search queries cover all authorized entries.{directory}"
            ));
        }
        definitions
    }

    pub(super) async fn mcp_tool_search(
        &self,
        cell: &Cell,
        turn_id: &str,
        args: &Value,
    ) -> Result<Value> {
        if !self.extensions.policy.lazy_mcp_schemas {
            return Err(invalid("MCP schema search experiment is disabled"));
        }
        let query = args["query"]
            .as_str()
            .ok_or_else(|| invalid("query is required"))?;
        let limit = args["limit"].as_u64().unwrap_or(8) as usize;
        if query.len() > 512 || !(1..=8).contains(&limit) {
            return Err(invalid("invalid MCP search budget"));
        }
        let mut state = cell.state.lock().await;
        let active = state
            .active
            .as_mut()
            .filter(|a| a.id == turn_id)
            .ok_or(Error::Conflict)?;
        Ok(active.tool_exposure.search(query, limit))
    }
}

fn common_native(name: &str) -> bool {
    matches!(
        name,
        "tool_search"
            | "tool_program"
            | "read_file"
            | "search_files"
            | "edit_files"
            | "run_command"
            | "verify_command"
            | "read_process"
            | "write_process"
            | "terminate_process"
            | "image_read"
            | "read_tool_result"
            | "environment_info"
    )
}
