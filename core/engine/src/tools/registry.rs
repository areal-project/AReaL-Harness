use super::*;
use areal_protocol::{DynamicToolResponse, ToolDefinition};
use serde::Serialize;

pub const MAX_ARGUMENT_BYTES: usize = crate::model::MAX_TOOL_ARGUMENT_BYTES;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct ToolPolicy {
    pub result_views: ResultViewPolicy,
    pub command_wait_ms: u64,
    pub pty_wait_ms: u64,
    pub read_wait_ms: u64,
    /// Zero disables early return on output silence (the default). A positive
    /// value opts into legacy burst coalescing for run_command and read_process.
    pub output_quiet_ms: u64,
    /// Maximum bytes collected into one model-visible output page. The cursor
    /// remains available when a command produces more output.
    pub output_page_bytes: usize,
}

impl Default for ToolPolicy {
    fn default() -> Self {
        Self {
            result_views: ResultViewPolicy::default(),
            command_wait_ms: 120_000,
            pty_wait_ms: 1000,
            read_wait_ms: 120_000,
            output_quiet_ms: 0,
            output_page_bytes: 8192,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResultViewMode {
    Off,
    #[default]
    Observe,
    On,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct ResultViewPolicy {
    pub mode: ResultViewMode,
    pub search_groups: bool,
    pub repeat_lines: bool,
    /// 无损文件行包装独立于搜索/命令视图实验开关。
    pub file_lines: bool,
}

impl Default for ResultViewPolicy {
    fn default() -> Self {
        Self {
            mode: ResultViewMode::Observe,
            search_groups: true,
            repeat_lines: true,
            file_lines: true,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandTool {
    pub definition: ToolDefinition,
    pub argv: Vec<String>,
    pub timeout_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum HookEvent {
    PreToolUse,
    PostToolUse,
    PostToolUseFailure,
}

impl HookEvent {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::PreToolUse => "PreToolUse",
            Self::PostToolUse => "PostToolUse",
            Self::PostToolUseFailure => "PostToolUseFailure",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HookDefinition {
    pub name: String,
    pub event: HookEvent,
    /// Exact tool name or "*". No shell or regex interpolation.
    pub matcher: String,
    pub argv: Vec<String>,
    pub timeout_ms: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct ToolExtensions {
    /// Opt-in native research agents; budgets are shared by this Engine.
    pub agents: Option<AgentToolsConfig>,
    pub policy: ToolPolicy,
    pub tools: Vec<CommandTool>,
    pub hooks: Vec<HookDefinition>,
    pub mcp_servers: BTreeMap<String, areal_mcp::ServerConfig>,
    pub plugins: BTreeMap<String, super::plugins::PluginConfig>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentToolsConfig {
    pub max_model_requests: usize,
    pub max_tool_calls: usize,
    pub max_worker_model_requests: usize,
    pub max_worker_tool_calls: usize,
    pub worker_timeout_seconds: u64,
}

#[async_trait::async_trait]
pub trait DynamicToolHost: Send + Sync {
    fn id(&self) -> &str;
    fn identity(&self) -> &str {
        self.id()
    }
    fn is_closed(&self) -> bool;
    async fn call(
        &self,
        request: Value,
        cancel: CancellationToken,
    ) -> anyhow::Result<DynamicToolResponse>;
}

#[derive(Clone)]
pub(crate) enum Backend {
    Builtin,
    Agent,
    Coordination,
    Core,
    Command(CommandTool),
    Client,
    Mcp(areal_mcp::McpTool),
    Plugin(super::plugins::PluginTool),
}

pub(crate) struct RegisteredTool {
    pub definition: ToolDefinition,
    pub backend: Backend,
    input: jsonschema::Validator,
    output: Option<jsonschema::Validator>,
}

impl RegisteredTool {
    pub fn validate_input(&self, arguments: &Value) -> anyhow::Result<()> {
        self.input
            .validate(arguments)
            .map_err(|e| anyhow::anyhow!("invalid tool arguments at {}: {}", e.instance_path, e))
    }
    pub fn validate_output(&self, result: &Value) -> anyhow::Result<()> {
        if let Some(output) = &self.output {
            output.validate(result).map_err(|e| {
                anyhow::anyhow!("invalid tool result at {}: {}", e.instance_path, e)
            })?;
        }
        Ok(())
    }
}

#[derive(Clone, Default)]
pub(crate) struct Registry {
    tools: BTreeMap<String, Arc<RegisteredTool>>,
    order: Vec<String>,
}

struct OfflineSchemas;
impl jsonschema::Retrieve for OfflineSchemas {
    fn retrieve(
        &self,
        _: &jsonschema::Uri<String>,
    ) -> std::result::Result<Value, Box<dyn std::error::Error + Send + Sync>> {
        Err("tool schemas must contain their references; external retrieval is disabled".into())
    }
}

fn compile(schema: &Value) -> anyhow::Result<jsonschema::Validator> {
    anyhow::ensure!(
        serde_json::to_vec(schema)?.len() <= MAX_ARGUMENT_BYTES,
        "tool schema exceeds 64 KiB"
    );
    jsonschema::options()
        .with_draft(jsonschema::Draft::Draft202012)
        .with_retriever(OfflineSchemas)
        .with_pattern_options(jsonschema::PatternOptions::regex())
        .build(schema)
        .map_err(|e| anyhow::anyhow!("invalid tool schema: {e}"))
}

impl Registry {
    /// 缺少部署 scratch 时，不向模型提供无法执行的验证工具。
    pub fn with_command_scratch(mut self, available: bool) -> Self {
        if !available {
            self.tools.remove("verify_command");
            self.order.retain(|name| name != "verify_command");
        }
        self
    }

    /// Generated from the deployed Runtime, not a second Core timeout policy.
    pub fn with_runtime_limits(mut self, limits: &rt::Limits) -> anyhow::Result<Self> {
        anyhow::ensure!(
            limits.wall_time_ms > 0,
            "Runtime command deadline must be positive"
        );
        if let Some(entry) = self.tools.get("run_command") {
            let mut definition = entry.definition.clone();
            definition.input_schema["properties"]["timeoutMs"]["maximum"] =
                json!(limits.wall_time_ms);
            for branch in definition.input_schema["oneOf"].as_array_mut().unwrap() {
                branch["properties"]["timeoutMs"]["maximum"] = json!(limits.wall_time_ms);
            }
            definition.description.push_str(&format!(
                " This Runtime permits timeoutMs from 1 through {} (including write-queue time). yieldMs/read_process.waitMs only control waiting, not the execution deadline.", limits.wall_time_ms));
            let input = compile(&definition.input_schema)?;
            self.tools.insert(
                "run_command".into(),
                Arc::new(RegisteredTool {
                    definition,
                    backend: Backend::Builtin,
                    input,
                    output: None,
                }),
            );
        }
        Ok(self)
    }

    pub fn new(runtime: bool, extensions: &ToolExtensions) -> anyhow::Result<Self> {
        anyhow::ensure!(
            (1024..=MAX_ARGUMENT_BYTES / 2).contains(&extensions.policy.output_page_bytes),
            "outputPageBytes must be between 1024 and 32768"
        );
        anyhow::ensure!(
            runtime || (extensions.tools.is_empty() && extensions.hooks.is_empty()),
            "command tools and hooks require a Runtime"
        );
        areal_mcp::validate(&extensions.mcp_servers)?;
        anyhow::ensure!(
            extensions.plugins.len() <= 16,
            "at most 16 plugin hosts are supported"
        );
        for (id, config) in &extensions.plugins {
            anyhow::ensure!(runtime, "plugins require a Runtime");
            anyhow::ensure!(
                !id.is_empty()
                    && id.len() <= 64
                    && id
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-')),
                "invalid plugin id"
            );
            config.validate()?;
        }
        let mut registry = Self::default();
        for definition in crate::desktop::definitions()
            .into_iter()
            .chain(crate::goals::definitions())
        {
            registry.insert(definition, Backend::Core)?;
        }
        if runtime {
            for definition in super::definitions_with_policy(&extensions.policy) {
                let f = &definition["function"];
                registry.insert(
                    ToolDefinition {
                        name: f["name"].as_str().unwrap().into(),
                        description: f["description"].as_str().unwrap().into(),
                        input_schema: f["parameters"].clone(),
                        output_schema: None,
                    },
                    Backend::Builtin,
                )?;
            }
        }
        if let Some(config) = &extensions.agents {
            anyhow::ensure!(runtime, "native research agents require Runtime");
            anyhow::ensure!(
                (1..=4096).contains(&config.max_model_requests)
                    && (1..=8192).contains(&config.max_tool_calls),
                "invalid shared agent budgets"
            );
            anyhow::ensure!(
                (1..=config.max_model_requests).contains(&config.max_worker_model_requests)
                    && (1..=config.max_tool_calls).contains(&config.max_worker_tool_calls)
                    && (1..=7200).contains(&config.worker_timeout_seconds),
                "invalid research agent budgets"
            );
            for definition in super::agents::definitions() {
                registry.insert(definition, Backend::Agent)?;
            }
        }
        for tool in &extensions.tools {
            validate_command(&tool.argv, tool.timeout_ms)?;
            registry.insert(tool.definition.clone(), Backend::Command(tool.clone()))?;
        }
        anyhow::ensure!(
            extensions.hooks.len() <= 64,
            "at most 64 hooks are supported"
        );
        let mut names = HashSet::new();
        for hook in &extensions.hooks {
            validate_command(&hook.argv, hook.timeout_ms)?;
            anyhow::ensure!(
                !hook.name.is_empty() && hook.name.len() <= 128 && names.insert(&hook.name),
                "hook names must be nonempty and unique"
            );
            anyhow::ensure!(
                hook.matcher == "*"
                    || (!hook.matcher.is_empty()
                        && hook.matcher.len() <= 64
                        && hook
                            .matcher
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')),
                "hook matcher must be an exact tool name or *"
            );
        }
        Ok(registry)
    }
    pub fn with_mcp(mut self, tools: Vec<areal_mcp::McpTool>) -> anyhow::Result<Self> {
        for tool in tools {
            self.insert(tool.definition.clone(), Backend::Mcp(tool))?;
        }
        Ok(self)
    }
    pub fn with_dynamic(&self, definitions: &[ToolDefinition]) -> anyhow::Result<Self> {
        let mut registry = self.clone();
        for definition in definitions {
            registry.insert(definition.clone(), Backend::Client)?;
        }
        Ok(registry)
    }
    pub fn with_plugins(mut self, tools: Vec<super::plugins::PluginTool>) -> anyhow::Result<Self> {
        for tool in tools {
            self.insert(tool.definition.clone(), Backend::Plugin(tool))?;
        }
        Ok(self)
    }
    pub(crate) fn insert(
        &mut self,
        definition: ToolDefinition,
        backend: Backend,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(self.tools.len() < 128, "tool registry exceeds 128 tools");
        anyhow::ensure!(
            !definition.name.is_empty()
                && definition.name.len() <= 64
                && definition
                    .name
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-'),
            "tool names must be 1..64 ASCII letters, digits, underscores or hyphens"
        );
        anyhow::ensure!(
            !definition.description.is_empty() && definition.description.len() <= 8192,
            "tool descriptions must be 1..8192 bytes"
        );
        anyhow::ensure!(
            !self.tools.contains_key(&definition.name),
            "duplicate tool name: {}",
            definition.name
        );
        anyhow::ensure!(
            definition.input_schema["type"] == "object",
            "tool input schema must describe an object"
        );
        let input = compile(&definition.input_schema)?;
        let output = definition.output_schema.as_ref().map(compile).transpose()?;
        self.order.push(definition.name.clone());
        self.tools.insert(
            definition.name.clone(),
            Arc::new(RegisteredTool {
                definition,
                backend,
                input,
                output,
            }),
        );
        Ok(())
    }
    pub fn research_only(mut self) -> Self {
        self.tools.retain(|name, tool| {
            matches!(tool.backend, Backend::Builtin)
                || (matches!(name.as_str(), "read_tool_result" | "read_history")
                    && matches!(tool.backend, Backend::Core))
        });
        self.order.retain(|name| self.tools.contains_key(name));
        self
    }
    pub fn get(&self, name: &str) -> anyhow::Result<Arc<RegisteredTool>> {
        self.tools
            .get(name)
            .cloned()
            .with_context(|| format!("unknown tool: {name}"))
    }
    pub fn definitions(&self) -> Vec<Value> {
        self.order
            .iter()
            .map(|name| &self.tools[name])
            .map(|tool| {
                let mut parameters = tool.definition.input_schema.clone();
                if matches!(tool.backend, Backend::Builtin) && tool.definition.name == "run_command" {
                    // 部分端点拒绝顶层 oneOf；仅简化模型投影，执行校验仍使用原始契约。
                    parameters.as_object_mut().unwrap().remove("oneOf");
                }
                json!({"type":"function","function":{"name":tool.definition.name,"description":tool.definition.description,"parameters":parameters}})
            })
            .collect()
    }
}

pub(super) fn validate_command(argv: &[String], timeout_ms: u64) -> anyhow::Result<()> {
    anyhow::ensure!(
        !argv.is_empty() && argv.len() <= 256 && argv.iter().all(|arg| !arg.contains('\0')),
        "extension command requires valid argv"
    );
    anyhow::ensure!(
        timeout_ms > 0,
        "extension command timeoutMs must be positive"
    );
    Ok(())
}

impl ToolExtensions {
    /// Validate configuration without starting Runtime or executing commands.
    pub fn validate(&self) -> anyhow::Result<()> {
        Registry::new(true, self).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn research_can_retrieve_its_own_results_without_other_desktop_tools() {
        let registry = Registry::new(true, &ToolExtensions::default())
            .unwrap()
            .research_only();
        let names: Vec<_> = registry
            .definitions()
            .into_iter()
            .map(|d| d["function"]["name"].as_str().unwrap().to_owned())
            .collect();
        assert!(names.iter().any(|n| n == "read_tool_result"));
        assert!(!names.iter().any(|n| n == "plan_read"));
    }
    #[test]
    fn verification_tool_requires_deployment_scratch() {
        for available in [false, true] {
            let registry = Registry::new(true, &ToolExtensions::default())
                .unwrap()
                .with_command_scratch(available);
            assert_eq!(registry.tools.contains_key("verify_command"), available);
            assert_eq!(
                registry
                    .definitions()
                    .iter()
                    .any(|d| d["function"]["name"] == "verify_command"),
                available
            );
            assert!(registry.tools.contains_key("run_command"));
        }
    }

    #[test]
    fn command_model_schema_keeps_runtime_validation() {
        let registry = Registry::new(true, &ToolExtensions::default())
            .unwrap()
            .with_runtime_limits(&rt::Limits {
                wall_time_ms: 7000,
                ..Default::default()
            })
            .unwrap();
        let command = registry.get("run_command").unwrap();
        let definitions = registry.definitions();
        let advertised = &definitions
            .iter()
            .find(|d| d["function"]["name"] == "run_command")
            .unwrap()["function"];
        let mut expected = command.definition.input_schema.clone();
        expected.as_object_mut().unwrap().remove("oneOf");
        assert_eq!(advertised["parameters"], expected);
        assert!(
            advertised["description"]
                .as_str()
                .unwrap()
                .contains("exactly one of command/argv")
        );
        for args in [
            json!({"command":"true","timeoutMs":7000}),
            json!({"argv":["true"],"timeoutMs":7000}),
        ] {
            command.validate_input(&args).unwrap();
            compile(&advertised["parameters"])
                .unwrap()
                .validate(&args)
                .unwrap();
        }
        for args in [
            json!({}),
            json!({"command":"true","argv":["true"]}),
            json!({"argv":["true"],"timeoutMs":7001}),
            json!({"command":""}),
            json!({"argv":[]}),
            json!({"command":"true","unexpected":true}),
        ] {
            assert!(command.validate_input(&args).is_err(), "{args}");
        }

        // 同名外部工具仍保留其完整契约，不按名称删除用户 schema 的约束。
        let mut external = Registry::default();
        external
            .insert(command.definition.clone(), Backend::Client)
            .unwrap();
        assert_eq!(
            external.definitions()[0]["function"]["parameters"],
            command.definition.input_schema
        );
    }

    #[test]
    fn command_schema_and_validation_share_the_deployed_deadline() {
        for maximum in [7000, 120_000] {
            let registry = Registry::new(true, &ToolExtensions::default())
                .unwrap()
                .with_runtime_limits(&rt::Limits {
                    wall_time_ms: maximum,
                    ..Default::default()
                })
                .unwrap();
            let command = registry.get("run_command").unwrap();
            assert_eq!(
                command.definition.input_schema["properties"]["timeoutMs"]["maximum"],
                maximum
            );
            let branches = command.definition.input_schema["oneOf"].as_array().unwrap();
            assert_eq!(branches.len(), 2);
            for (branch, args) in branches.iter().zip([
                json!({"command":"true","cwd":".","timeoutMs":maximum}),
                json!({"argv":["true"],"cwd":".","timeoutMs":maximum}),
            ]) {
                assert_eq!(branch["type"], "object");
                let validator = compile(branch).unwrap();
                assert!(validator.is_valid(&args));
                command.validate_input(&args).unwrap();
                let mut over_limit = args;
                over_limit["timeoutMs"] = json!(maximum + 1);
                assert!(!validator.is_valid(&over_limit));
                assert!(command.validate_input(&over_limit).is_err());
            }
            for args in [
                json!({}),
                json!({"command":"true","argv":["true"]}),
                json!({"command":""}),
                json!({"argv":[]}),
                json!({"command":"true","unexpected":true}),
            ] {
                assert!(command.validate_input(&args).is_err(), "{args}");
                assert!(
                    branches
                        .iter()
                        .all(|b| !compile(b).unwrap().is_valid(&args))
                );
            }
            assert!(
                command
                    .validate_input(&json!({"argv":["true"],"cwd":".","timeoutMs":maximum}))
                    .is_ok()
            );
            assert!(
                command
                    .validate_input(&json!({"argv":["true"],"cwd":".","timeoutMs":maximum+1}))
                    .is_err()
            );
            // A polling interval is not an execution deadline.
            assert!(
                registry
                    .get("read_process")
                    .unwrap()
                    .validate_input(&json!({"processId":"p","waitMs":maximum+1}))
                    .is_ok()
            );
        }
    }
    fn definition(schema: Value) -> ToolDefinition {
        ToolDefinition {
            name: "lookup".into(),
            description: "Find a value".into(),
            input_schema: schema,
            output_schema: Some(json!({"type":"integer"})),
        }
    }
    #[test]
    fn validates_real_json_schema_refs_combinators_and_outputs() {
        let schema = json!({"type":"object","required":["value"],"properties":{"value":{"$ref":"#/$defs/value"}},"additionalProperties":false,"$defs":{"value":{"oneOf":[{"type":"integer","minimum":1},{"type":"string","pattern":"^[a-z]+$"}]}}});
        let registry = Registry::default()
            .with_dynamic(&[definition(schema.clone())])
            .unwrap();
        assert_eq!(registry.definitions()[0]["function"]["parameters"], schema);
        let tool = registry.get("lookup").unwrap();
        for args in [json!({"value":1}), json!({"value":"abc"})] {
            tool.validate_input(&args).unwrap();
        }
        for args in [
            json!({}),
            json!({"value":0}),
            json!({"value":"A"}),
            json!({"value":1,"extra":2}),
        ] {
            assert!(tool.validate_input(&args).is_err());
        }
        tool.validate_output(&json!(4)).unwrap();
        assert!(tool.validate_output(&json!("4")).is_err());
    }
    #[test]
    fn rejects_invalid_schemas_external_refs_and_name_collisions() {
        for schema in [
            json!({"type":"object","required":true}),
            json!({"type":"object","$ref":"https://example.com/schema"}),
            json!({"type":"object","$ref":"file:///tmp/schema"}),
        ] {
            assert!(
                Registry::default()
                    .with_dynamic(&[definition(schema)])
                    .is_err()
            );
        }
        let d = definition(json!({"type":"object"}));
        assert!(Registry::default().with_dynamic(&[d.clone(), d]).is_err());
        let mut d = definition(json!({"type":"object"}));
        d.name = "fs_read".into();
        assert!(
            Registry::new(true, &ToolExtensions::default())
                .unwrap()
                .with_dynamic(&[d])
                .is_err()
        );
        let mut d = definition(json!({"type":"object"}));
        d.name = "shell;exec".into();
        assert!(Registry::default().with_dynamic(&[d]).is_err());
    }
}
