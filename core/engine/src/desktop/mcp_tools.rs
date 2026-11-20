use super::*;
use std::collections::BTreeSet;

/// 授权 MCP 工具不超过这个数时照常全量展示；超过才改为按需检索（工具箱第四期定的阈值）。
const EAGER_LIMIT: usize = 20;
const CATALOG_BYTES: usize = 16 * 1024;

#[derive(Default)]
pub(crate) struct ToolExposure {
    catalog: Vec<ToolSummary>,
    common_catalog: Vec<ToolSummary>,
    loaded: BTreeSet<String>,
    offered: Option<BTreeSet<String>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolSummary {
    name: String,
    server_id: String,
    description: String,
}

impl ToolExposure {
    pub(crate) fn remove_common(&mut self, name: &str) {
        self.common_catalog.retain(|tool| tool.name != name);
    }

    pub(crate) fn admits(&self, name: &str) -> bool {
        self.offered
            .as_ref()
            .is_none_or(|names| names.contains(name))
    }

    fn search(&mut self, query: &str, limit: usize) -> Value {
        let query = query.to_lowercase();
        let terms: Vec<_> = query.split_whitespace().collect();
        let mut matches: Vec<_> = self
            .catalog
            .iter()
            .filter(|tool| {
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

    fn search_native(&mut self, query: &str, limit: usize) -> Value {
        // 常用工具已投影为直接入口或程序内 schema；精确搜索不能将它们误报为空。
        // 只读当前授权投影，不增加 lazy 加载集，也不改变模糊搜索和 MCP 搜索。
        if let Some(tool) = self
            .common_catalog
            .iter()
            .find(|tool| tool.name.eq_ignore_ascii_case(query.trim()))
        {
            return json!({
                "tools": [tool], "truncated": false, "schemaStatus": "already_available",
                "schemaLocation": "Use the existing tool definition, or its tools.NAME schema in tool_program when provided there."
            });
        }
        let result = self.search(query, limit);
        if result["tools"]
            .as_array()
            .is_some_and(|tools| !tools.is_empty())
        {
            return result;
        }
        // 只在原检索为空时匹配完整名称；两类目录均来自当前 Turn 的授权投影。
        let terms: BTreeSet<_> = query
            .split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-')
            .filter(|term| !term.is_empty())
            .map(str::to_lowercase)
            .collect();
        let mut matches: Vec<_> = self
            .common_catalog
            .iter()
            .filter(|tool| terms.contains(&tool.name.to_lowercase()))
            .collect();
        if !matches.is_empty() {
            matches.sort_by(|a, b| a.name.cmp(&b.name));
            let truncated = matches.len() > limit;
            matches.truncate(limit);
            return json!({
                "tools": matches, "truncated": truncated, "schemaStatus": "already_available",
                "schemaLocation": "Use the existing tool definition, or its tools.NAME schema in tool_program when provided there."
            });
        }
        // 常用入口也没有命中时，才发现完整 lazy 工具名，避免一句话中的
        // 附带名称改变原有常用工具优先级或额外加载 schema。
        let mut matches: Vec<_> = self
            .catalog
            .iter()
            .filter(|tool| terms.contains(&tool.name.to_lowercase()))
            .collect();
        matches.sort_by(|a, b| a.name.cmp(&b.name));
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
        let (common_catalog, catalog): (Vec<_>, Vec<_>) = definitions
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
                Some(ToolSummary {
                    name: name.into(),
                    server_id: "native".into(),
                    description: d["function"]["description"]
                        .as_str()
                        .unwrap_or("")
                        .chars()
                        .take(256)
                        .collect(),
                })
            })
            .partition(|tool| common_native(&tool.name));
        drop(bindings);
        let mut state = cell.state.lock().await;
        let Some(active) = state.active.as_mut() else {
            return definitions;
        };
        let exposure = &mut active.native_tool_exposure;
        exposure.catalog = catalog;
        exposure.common_catalog = common_catalog;
        let names: BTreeSet<_> = exposure.catalog.iter().map(|t| t.name.as_str()).collect();
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
        Ok(active.native_tool_exposure.search_native(query, limit))
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
            | "skill_load"
            | "skill_resource_read"
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sentence_names_discover_only_authorized_lazy_tools() {
        for name in ["read_history", "inspect_record", "inspect-record"] {
            let entry = ToolSummary {
                name: name.into(),
                server_id: "native".into(),
                description: "Inspect a resource".into(),
            };
            let mut exposure = ToolExposure {
                catalog: vec![entry],
                ..Default::default()
            };
            let query = format!("Use tools.{}: read attached data", name.to_uppercase());
            assert_eq!(exposure.search(&query, 1)["tools"], json!([]));
            let result = exposure.search_native(&query, 1);
            assert_eq!(result["tools"][0]["name"], name);
            assert!(result.get("schemaStatus").is_none());
            assert_eq!(exposure.loaded, BTreeSet::from([name.into()]));
            for query in [
                format!("other_{name}"),
                format!("{name}2"),
                format!("{name}-extra"),
                "unavailable_resource please".into(),
            ] {
                assert_eq!(exposure.search_native(&query, 1)["tools"], json!([]));
            }
            exposure.catalog.clear();
            assert_eq!(exposure.search_native(&query, 1)["tools"], json!([]));
        }
    }

    #[test]
    fn sentence_name_limit_preserves_common_priority_and_bounds_lazy_loading() {
        let mut exposure = ToolExposure {
            catalog: ["z_record", "b_record"]
                .map(|name| ToolSummary {
                    name: name.into(),
                    server_id: "native".into(),
                    description: "Read data".into(),
                })
                .to_vec(),
            common_catalog: vec![ToolSummary {
                name: "a_common".into(),
                server_id: "native".into(),
                description: "Already provided".into(),
            }],
            ..Default::default()
        };
        let result = exposure.search_native("a_common, b_record, z_record please", 2);
        assert_eq!(result["tools"].as_array().unwrap().len(), 1);
        assert_eq!(result["tools"][0]["name"], "a_common");
        assert_eq!(result["schemaStatus"], "already_available");
        assert!(exposure.loaded.is_empty());
        let result = exposure.search_native("b_record, z_record please", 1);
        assert_eq!(result["tools"][0]["name"], "b_record");
        assert_eq!(result["truncated"], true);
        assert!(result.get("schemaStatus").is_none());
        assert_eq!(exposure.loaded, BTreeSet::from(["b_record".into()]));
        let result = exposure.search_native("b_record, z_record please", 2);
        assert_eq!(result["tools"].as_array().unwrap().len(), 2);
        assert_eq!(result["truncated"], false);
        assert_eq!(
            exposure.loaded,
            BTreeSet::from(["b_record".into(), "z_record".into()])
        );
    }

    #[test]
    fn exact_common_search_reports_the_existing_schema() {
        let mut exposure = ToolExposure {
            common_catalog: vec![ToolSummary {
                name: "skill_load".into(),
                server_id: "native".into(),
                description: "Load the complete skill".into(),
            }],
            ..Default::default()
        };

        let result = exposure.search_native(" Skill_Load ", 1);
        assert_eq!(result["schemaStatus"], "already_available");
        assert_eq!(result["tools"][0]["name"], "skill_load");
        assert!(exposure.loaded.is_empty());
    }

    #[test]
    fn unknown_common_search_keeps_existing_matching_behavior() {
        let mut exposure = ToolExposure {
            catalog: vec![ToolSummary {
                name: "read_history".into(),
                server_id: "native".into(),
                description: "Read history".into(),
            }],
            ..Default::default()
        };

        let result = exposure.search_native("missing_tool", 1);
        assert_eq!(result["tools"].as_array().unwrap().len(), 0);
        assert!(result.get("schemaStatus").is_none());
    }

    #[test]
    fn common_tool_names_in_a_sentence_report_the_existing_schema() {
        let mut exposure = ToolExposure {
            common_catalog: vec![
                ToolSummary {
                    name: "image_read".into(),
                    server_id: "native".into(),
                    description: "Read an image".into(),
                },
                ToolSummary {
                    name: "read_file".into(),
                    server_id: "native".into(),
                    description: "Read a file".into(),
                },
            ],
            ..Default::default()
        };

        let result = exposure.search_native("Use tools.IMAGE_READ to inspect the preview", 1);
        assert_eq!(result["schemaStatus"], "already_available");
        assert_eq!(result["tools"][0]["name"], "image_read");
        assert!(exposure.loaded.is_empty());

        let result = exposure.search_native("read_file, image_read", 1);
        assert_eq!(result["tools"].as_array().unwrap().len(), 1);
        assert_eq!(result["truncated"], true);
        assert!(exposure.loaded.is_empty());

        for query in ["other_image_read", "image_read2", "image_read-extra"] {
            assert_eq!(
                exposure.search_native(query, 1)["tools"],
                json!([]),
                "{query} must not match a different tool name"
            );
        }
        // MCP 搜索和按说明匹配的 lazy 命中不受 common 回退影响。
        assert_eq!(exposure.search("image_read preview", 1)["tools"], json!([]));
        exposure.catalog.push(ToolSummary {
            name: "read_history".into(),
            server_id: "native".into(),
            description: "Read image_read history".into(),
        });
        let result = exposure.search_native("image_read history", 1);
        assert_eq!(result["tools"][0]["name"], "read_history");
        assert!(result.get("schemaStatus").is_none());
        assert_eq!(exposure.loaded, BTreeSet::from(["read_history".into()]));
    }
}
