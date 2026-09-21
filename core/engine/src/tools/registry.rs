use super::*;
use areal_protocol::{DynamicToolResponse, ToolDefinition};
use serde::Serialize;

pub const MAX_ARGUMENT_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct ToolPolicy {
    pub command_wait_ms: u64,
    pub pty_wait_ms: u64,
    pub read_wait_ms: u64,
    /// Zero disables early return on output silence (the default). A positive
    /// value opts into legacy burst coalescing for run_command and read_process.
    pub output_quiet_ms: u64,
}

impl Default for ToolPolicy {
    fn default() -> Self {
        Self {
            command_wait_ms: 120_000,
            pty_wait_ms: 1000,
            read_wait_ms: 120_000,
            output_quiet_ms: 0,
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
        for definition in crate::desktop::definitions() {
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
        self.tools
            .retain(|_, tool| matches!(tool.backend, Backend::Builtin));
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
        self.order.iter().map(|name| &self.tools[name]).map(|tool| json!({"type":"function","function":{"name":tool.definition.name,"description":tool.definition.description,"parameters":tool.definition.input_schema}})).collect()
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
