//! App iframe 只持绑定能力；有副作用的调用复用普通 Turn、审批和持久日志。
use super::*;
#[path = "form_resources.rs"]
mod form_resources;
#[path = "page_tools.rs"]
pub(crate) mod page_tools;
use crate::model::ToolCall;
use areal_protocol::{
    ToolOutcome, ToolStatus,
    plugin_runtime::{OpenFromResult, ResultUnavailable},
};
use sha2::{Digest, Sha256};
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Instance {
    #[serde(default)]
    tool_host_id: Option<String>,
    #[serde(skip)]
    page_tools_retired: bool,
    #[serde(default)]
    runtime_epoch: String,
    instance_id: String,
    identity: String,
    thread_id: String,
    cwd: String,
    plugin: String,
    digest: String,
    server_id: String,
    generation: u64,
    tool_name: String,
    request_id: String,
    request_digest: String,
    resource: Value,
    metadata: Value,
    arguments: Value,
    context: Value,
    #[serde(default)]
    file_resource: Option<Value>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ResultProvenance {
    pub version: u8,
    pub apps_epoch: String,
    pub thread_id: String,
    pub cwd: String,
    pub plugin_id: String,
    pub installed_digest: String,
    pub server_id: String,
    pub generation: u64,
    pub original_tool_name: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResultRef {
    thread_id: String,
    turn_id: String,
    item_id: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum ResultState {
    Preparing,
    Open {
        instance_id: String,
    },
    Closed {
        instance_id: String,
        generation: u64,
    },
    Unavailable {
        reason: ResultUnavailable,
    },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResultOperation {
    identity: String,
    request_id: String,
    digest: String,
    source: ResultRef,
    source_key: String,
    plugin_id: String,
    state: ResultState,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AppStore {
    version: u8,
    result_epoch: String,
    instances: BTreeMap<String, Instance>,
    result_operations: BTreeMap<String, ResultOperation>,
}
fn result_terminal_reserve(operations: &BTreeMap<String, ResultOperation>) -> Result<usize> {
    operations.values().try_fold(0, |reserved, record| {
        let bytes = serde_json::to_vec(record).map_err(invalid)?.len();
        if bytes > 1024 {
            return Err(invalid("result receipt budget exceeded"));
        }
        Ok(reserved + 1024 - bytes)
    })
}
struct SavedResult {
    provenance: ResultProvenance,
    snapshot_sha: String,
    metadata: Value,
    arguments: Value,
    result: Value,
    tool_name: String,
    server: areal_mcp::McpServer,
}
fn unavailable(reason: ResultUnavailable) -> Value {
    json!({"status":"unavailable","reason":reason})
}
fn app_resource(read: &Value, uri: &str) -> std::result::Result<Value, ResultUnavailable> {
    let content = read["contents"]
        .as_array()
        .and_then(|values| {
            values.iter().find(|value| {
                value["uri"] == uri
                    && matches!(
                        value["mimeType"].as_str(),
                        Some("text/html;profile=mcp-app" | "text/html")
                    )
            })
        })
        .ok_or(ResultUnavailable::ResourceRejected)?;
    let html = content["text"]
        .as_str()
        .ok_or(ResultUnavailable::ResourceRejected)?;
    if html.len() > 2 * 1024 * 1024 {
        return Err(ResultUnavailable::ResourceRejected);
    }
    Ok(json!({"uri":uri,"mimeType":content["mimeType"],"html":html,"_meta":content["_meta"]}))
}

#[derive(Clone)]
pub(crate) enum CallOwnerScope {
    Tool,
    Hook { app_generation: Option<u64> },
    CompactionHook { activation: String },
    AppRead { cwd: String, epoch: String },
}
#[derive(Clone)]
pub(crate) struct CallOwner {
    pub token: String,
    pub scope: CallOwnerScope,
    pub cancellation: tokio_util::sync::CancellationToken,
    pub identity: String,
    pub thread: String,
    pub turn: String,
    pub call: String,
    pub instance: Option<String>,
}
struct Form {
    owner: CallOwner,
    request: areal_mcp::ElicitationRequest,
}
// Transient leases: persisted Apps never replay a previous connection's subscriptions.
struct Subscription {
    server: areal_mcp::McpServer,
    instances: std::collections::BTreeSet<String>,
}
pub(crate) struct Manager {
    page_tools: page_tools::Pages,
    pub(super) runtime_epoch: String,
    result_operations: std::sync::RwLock<BTreeMap<String, ResultOperation>>,
    result_changed: tokio::sync::Notify,
    result_failures: std::sync::RwLock<BTreeMap<String, String>>,
    instances: std::sync::RwLock<BTreeMap<String, Instance>>,
    pub(super) mutation: Mutex<()>,
    subscriptions: std::sync::RwLock<BTreeMap<(String, u64, String), Subscription>>,
    settings: std::sync::RwLock<BTreeMap<(String, String, String, u64), Value>>,
    pub(crate) calls: Mutex<BTreeMap<(String, u64), CallOwner>>,
    forms: Mutex<BTreeMap<String, Form>>,
    uploads: Mutex<form_resources::Uploads>,
    reads: std::sync::RwLock<BTreeMap<String, (u64, tokio_util::sync::CancellationToken)>>,
}
impl Manager {
    pub fn open(root: &Path) -> anyhow::Result<Self> {
        let uploads = root.join("desktop/mcp-form-uploads");
        match std::fs::remove_dir_all(uploads) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        let path = root.join("desktop/mcp-apps.json");
        let instances = if path.exists() {
            let bytes = std::fs::read(path)?;
            anyhow::ensure!(bytes.len() <= 8 * 1024 * 1024, "App state budget exceeded");
            let value: Value = serde_json::from_slice(&bytes)?;
            if value.get("version").is_some() {
                let saved: AppStore = serde_json::from_value(value)?;
                anyhow::ensure!(saved.version == 2, "unsupported App state version");
                saved.instances
            } else {
                serde_json::from_value(value)?
            }
        } else {
            BTreeMap::new()
        };
        Ok(Self {
            page_tools: Default::default(),
            runtime_epoch: uuid::Uuid::new_v4().to_string(),
            instances: std::sync::RwLock::new(instances),
            result_operations: Default::default(),
            result_changed: Default::default(),
            result_failures: Default::default(),
            mutation: Mutex::new(()),
            subscriptions: Default::default(),
            settings: Default::default(),
            calls: Mutex::new(BTreeMap::new()),
            forms: Mutex::new(BTreeMap::new()),
            uploads: Mutex::new(form_resources::Uploads::default()),
            reads: Default::default(),
        })
    }
    pub fn generations(&self) -> Vec<u64> {
        let mut reads = self.reads.write().unwrap();
        reads.retain(|_, (_, cancel)| !cancel.is_cancelled());
        self.instances
            .read()
            .unwrap()
            .values()
            .filter(|i| i.runtime_epoch == self.runtime_epoch)
            .map(|i| i.generation)
            .chain(reads.values().map(|(generation, _)| *generation))
            .collect()
    }
}
pub(crate) fn strip_meta(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.remove("_meta");
            map.remove("mcpResult");
            map.remove("mcpServer");
            for value in map.values_mut() {
                strip_meta(value);
            }
        }
        Value::Array(values) => {
            for value in values {
                strip_meta(value);
            }
        }
        _ => {}
    }
}
// Trusted user entrypoints ignore ui.visibility only for their initial invocation.
fn declared_entrypoint(metadata: &Value, arguments: &Value, file: Option<&Value>) -> bool {
    let Some(entries) = metadata["_meta"]["openai/ui"]["entrypoints"].as_array() else {
        return false;
    };
    entries
        .iter()
        .any(|entry| match (entry["type"].as_str(), file) {
            (Some("global" | "thread"), None) => arguments == &json!({}),
            (Some("file"), Some(file)) => {
                let Some(path) = file["path"].as_str().map(Path::new) else {
                    return false;
                };
                let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                    return false;
                };
                path.is_absolute()
                    && arguments["file"]["name"] == name
                    && file["uri"].as_str().is_some_and(|uri| {
                        !uri.is_empty() && arguments["file"]["resourceUri"] == uri
                    })
                    && entry["extensions"].as_array().is_some_and(|extensions| {
                        extensions
                            .iter()
                            .filter_map(Value::as_str)
                            .any(|extension| {
                                extension.starts_with('.')
                                    && name
                                        .to_ascii_lowercase()
                                        .ends_with(&extension.to_ascii_lowercase())
                            })
                    })
            }
            _ => false,
        })
}
pub(crate) fn tool_uri(metadata: &Value) -> Option<&str> {
    metadata
        .pointer("/_meta/ui/resourceUri")
        .or_else(|| metadata.pointer("/_meta/ui~1resourceUri"))
        .or_else(|| metadata.pointer("/_meta/openai/outputTemplate"))
        .and_then(Value::as_str)
}
fn rpc_result(id: Value, result: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"result":result})
}
fn form_supported(schema: &Value) -> bool {
    fn string_schema(v: &Value) -> bool {
        v["type"] == "string"
            && v.as_object().is_some_and(|m| {
                m.keys().all(|k| {
                    matches!(
                        k.as_str(),
                        "type"
                            | "title"
                            | "description"
                            | "default"
                            | "enum"
                            | "enumNames"
                            | "oneOf"
                            | "minLength"
                            | "maxLength"
                            | "pattern"
                            | "format"
                            | "x-openai-suggestions"
                            | "x-openai-input"
                    )
                })
            })
            && v.get("oneOf").is_none_or(|v| {
                v.as_array().is_some_and(|options| {
                    !options.is_empty()
                        && options.iter().all(|o| {
                            o["const"].is_string()
                                && o["title"].is_string()
                                && o.as_object().is_some_and(|m| {
                                    m.keys().all(|k| {
                                        matches!(
                                            k.as_str(),
                                            "const"
                                                | "title"
                                                | "description"
                                                | "x-openai-thumbnail"
                                        )
                                    })
                                })
                        })
                })
            })
    }
    if schema["type"] != "object"
        || schema.as_object().is_none_or(|m| {
            m.keys().any(|k| {
                !matches!(
                    k.as_str(),
                    "type"
                        | "properties"
                        | "required"
                        | "additionalProperties"
                        | "title"
                        | "description"
                )
            })
        })
    {
        return false;
    }
    schema["properties"].as_object().is_some_and(|properties| {
        properties.len() <= 64
            && properties.values().all(|field| {
                let scalar = match field["type"].as_str() {
                    Some("string") => string_schema(field),
                    Some("boolean" | "number" | "integer") => field.as_object().is_some_and(|m| {
                        m.keys().all(|k| {
                            matches!(
                                k.as_str(),
                                "type"
                                    | "title"
                                    | "description"
                                    | "default"
                                    | "minimum"
                                    | "maximum"
                                    | "multipleOf"
                            )
                        })
                    }),
                    Some("array") => {
                        string_schema(&field["items"])
                            && field["items"].get("x-openai-input").is_none()
                            && field.as_object().is_some_and(|m| {
                                m.keys().all(|k| {
                                    matches!(
                                        k.as_str(),
                                        "type"
                                            | "title"
                                            | "description"
                                            | "items"
                                            | "default"
                                            | "minItems"
                                            | "maxItems"
                                            | "uniqueItems"
                                            | "x-openai-input"
                                    )
                                })
                            })
                    }
                    _ => false,
                };
                scalar
                    && field.get("x-openai-input").is_none_or(|input| {
                        matches!(input["type"].as_str(), Some("resource" | "file"))
                            && form_resources::supported_user_options(input)
                            && input.as_object().is_some_and(|m| {
                                m.keys().all(|k| {
                                    matches!(
                                        k.as_str(),
                                        "type" | "selection" | "options" | "userOptions"
                                    )
                                })
                            })
                            && input
                                .get("selection")
                                .is_none_or(|v| matches!(v.as_str(), Some("explicit" | "implicit")))
                            && input["options"].as_array().is_some_and(|options| {
                                options.len() <= 256
                                    && options.iter().all(|o| {
                                        o["uri"]
                                            .as_str()
                                            .is_some_and(|s| !s.is_empty() && s.len() <= 8192)
                                            && o["name"].is_string()
                                    })
                            })
                    })
            })
    }) && jsonschema::validator_for(schema).is_ok()
}
fn form_resources_valid(schema: &Value, content: &Value) -> bool {
    schema["properties"].as_object().is_some_and(|properties| {
        properties.iter().all(|(name, field)| {
            let Some(input) = field.get("x-openai-input") else {
                return true;
            };
            let Some(value) = content.get(name) else {
                return true;
            };
            let selected = if let Some(values) = value.as_array() {
                values.iter().collect::<Vec<_>>()
            } else {
                vec![value]
            };
            selected.iter().all(|uri| {
                input["options"]
                    .as_array()
                    .is_some_and(|options| options.iter().any(|o| &o["uri"] == *uri))
            })
        })
    })
}

impl Engine {
    async fn app_save(&self, instances: BTreeMap<String, Instance>) -> Result<()> {
        let operations = self
            .desktop
            .mcp_apps
            .result_operations
            .read()
            .unwrap()
            .clone();
        self.app_commit(instances, operations).await
    }
    fn app_file_fits(
        &self,
        instances: &BTreeMap<String, Instance>,
        operations: &BTreeMap<String, ResultOperation>,
    ) -> Result<bool> {
        let candidate = AppStore {
            version: 2,
            result_epoch: self.desktop.mcp_apps.runtime_epoch.clone(),
            instances: instances.clone(),
            result_operations: operations.clone(),
        };
        Ok(serde_json::to_vec(&candidate).map_err(invalid)?.len()
            + result_terminal_reserve(operations)?
            <= 8 * 1024 * 1024)
    }
    async fn app_commit(
        &self,
        instances: BTreeMap<String, Instance>,
        result_operations: BTreeMap<String, ResultOperation>,
    ) -> Result<()> {
        if result_operations.len() > 1024
            || result_operations
                .values()
                .any(|record| serde_json::to_vec(record).map_or(true, |bytes| bytes.len() > 1024))
        {
            return Err(invalid("result receipt budget exceeded"));
        }
        let records = AppStore {
            version: 2,
            result_epoch: self.desktop.mcp_apps.runtime_epoch.clone(),
            instances,
            result_operations,
        };
        let bytes = serde_json::to_vec(&records).map_err(invalid)?;
        if bytes.len() + result_terminal_reserve(&records.result_operations)? > 8 * 1024 * 1024 {
            return Err(invalid("App state budget exceeded"));
        }
        self.store
            .save_metadata("mcp-apps", &records)
            .await
            .map_err(invalid)?;
        *self.desktop.mcp_apps.instances.write().unwrap() = records.instances;
        *self.desktop.mcp_apps.result_operations.write().unwrap() = records.result_operations;
        self.desktop.mcp_apps.result_changed.notify_waiters();
        Ok(())
    }
    async fn app_scope(&self, thread: &str) -> Result<Arc<Cell>> {
        let cell = self.cell(thread).await?;
        let state = cell.state.lock().await;
        self.ensure_hook_session_open(&cell, &state.thread)?;
        let config = desktop(&state.thread).configuration;
        if state.thread.is_read_only_side()
            || cell.research
            || cell.exclusive_writer
            || state.thread.parent_thread_id.is_some()
            || state.thread.source == "nativeTaskAgent"
            || config.read_only
        {
            return Err(invalid("App unavailable in this execution scope"));
        }
        drop(state);
        Ok(cell)
    }
    async fn app_bound(
        &self,
        identity: &str,
        thread: &str,
        instance: &str,
        generation: u64,
    ) -> Result<(
        Instance,
        super::plugin_mcp::Generation,
        areal_mcp::McpServer,
    )> {
        let saved = self
            .desktop
            .mcp_apps
            .instances
            .read()
            .unwrap()
            .get(instance)
            .cloned()
            .ok_or(Error::NotFound)?;
        if saved.runtime_epoch != self.desktop.mcp_apps.runtime_epoch
            || saved.identity != identity
            || saved.thread_id != thread
            || saved.generation != generation
        {
            return Err(invalid("App owner or generation mismatch"));
        }
        let cell = self.app_scope(thread).await?;
        if cell.state.lock().await.thread.cwd != saved.cwd {
            return Err(invalid("App project binding changed"));
        }
        let (owner, server) = self.plugin_server(&saved.server_id, generation).await?;
        if owner.plugin != saved.plugin || owner.digest != saved.digest {
            return Err(invalid("App package binding changed"));
        }
        Ok((saved, owner, server))
    }
    pub async fn mcp_apps_list(&self, thread_id: Option<String>) -> Result<Value> {
        self.refresh_plugins().await?;
        if let Some(thread) = thread_id {
            self.app_scope(&thread).await?;
        }
        let mut data = vec![];
        for owner in self.desktop.plugin_mcp.generations() {
            for server in &owner.servers {
                let info = serde_json::to_value(server.info()).map_err(invalid)?;
                let tools: Vec<_> = owner
                    .tools
                    .iter()
                    .filter(|t| t.server_name() == server.name())
                    .map(|t| {
                        let mut value = serde_json::to_value(t.metadata()).unwrap_or(Value::Null);
                        value["toolName"] = json!(t.definition.name);
                        value
                    })
                    .collect();
                let mut capabilities = info["capabilities"].clone();
                if let Some(extensions) = info["capabilities"]["extensions"].as_object()
                    && let Some(object) = capabilities.as_object_mut()
                {
                    object.extend(extensions.clone());
                }

                data.push(json!({"serverId":server.name(),"generation":server.generation(),"protocolVersion":info["protocolVersion"],"pluginId":owner.plugin,"installedDigest":owner.digest,"tools":tools,"capabilities":capabilities,"title":info["serverInfo"]["title"],"icons":info["serverInfo"]["icons"],"instructions":info["instructions"]}));
            }
        }
        Ok(json!({"data":data,"requestEpoch":self.desktop.mcp_apps.runtime_epoch}))
    }
    #[allow(clippy::too_many_arguments)]
    pub async fn mcp_app_open(
        self: &Arc<Self>,
        identity: String,
        host: Option<Arc<dyn crate::tools::DynamicToolHost>>,
        thread_id: String,
        server_id: String,
        expected_generation: u64,
        tool_name: String,
        arguments: Option<Value>,
        request_id: String,
        file_resource: Option<Value>,
        deep_link: Option<String>,
    ) -> Result<Value> {
        if !valid_id(&request_id) {
            return Err(invalid("invalid requestId"));
        }
        let cell = self.app_scope(&thread_id).await?;
        let (owner, server) = self.plugin_server(&server_id, expected_generation).await?;
        let tool = owner
            .tools
            .iter()
            .find(|t| {
                t.server_name() == server_id
                    && (t.original_name() == tool_name || t.definition.name == tool_name)
            })
            .ok_or(Error::NotFound)?;
        let metadata = serde_json::to_value(tool.metadata()).map_err(invalid)?;
        let manual_entrypoint = declared_entrypoint(
            &metadata,
            &arguments.clone().unwrap_or_else(|| json!({})),
            file_resource.as_ref(),
        );
        if !tool.is_app_visible() && !manual_entrypoint {
            return Err(invalid("tool is not App-visible or a declared entrypoint"));
        }
        let uri = tool_uri(&metadata)
            .ok_or_else(|| invalid("tool does not declare an App resource"))?
            .to_owned();
        let args = arguments.clone().unwrap_or_else(|| json!({}));
        if !args.is_object() {
            return Err(invalid("App arguments must be an object"));
        }
        let hash = digest(
            &json!({"server":server_id,"generation":expected_generation,"tool":tool_name,"args":arguments,"fileResource":file_resource,"deepLink":deep_link}),
        )?;
        let _guard = self.desktop.mcp_apps.mutation.lock().await;
        let existing = self
            .desktop
            .mcp_apps
            .instances
            .read()
            .unwrap()
            .values()
            .find(|i| {
                i.identity == identity && i.thread_id == thread_id && i.request_id == request_id
            })
            .cloned();
        let saved = if let Some(existing) = existing {
            if existing.runtime_epoch != self.desktop.mcp_apps.runtime_epoch {
                return Err(invalid(
                    "App belongs to a previous Core session; open a new instance",
                ));
            }
            if existing.tool_host_id.as_deref() != host.as_ref().map(|h| h.id()) {
                return Err(invalid("App original Host mismatch"));
            }
            if existing.request_digest != hash {
                return Err(Error::Conflict);
            }
            drop(_guard);
            existing
        } else {
            drop(_guard);
            let read = self
                .app_read_resource(&identity, &thread_id, None, &server, &uri)
                .await?;
            let _guard = self.desktop.mcp_apps.mutation.lock().await;
            self.plugin_server(&server_id, expected_generation).await?;
            if self
                .desktop
                .mcp_apps
                .instances
                .read()
                .unwrap()
                .values()
                .any(|i| {
                    i.identity == identity && i.thread_id == thread_id && i.request_id == request_id
                })
            {
                return Err(Error::Conflict);
            }
            let resource = app_resource(&read, &uri).map_err(|_| {
                invalid("App HTML resource missing, invalid MIME or budget exceeded")
            })?;
            let state = cell.state.lock().await;
            self.ensure_hook_session_open(&cell, &state.thread)?;
            let saved = Instance {
                tool_host_id: host.as_ref().map(|h| h.id().to_owned()),
                page_tools_retired: false,
                runtime_epoch: self.desktop.mcp_apps.runtime_epoch.clone(),
                instance_id: id(),
                identity: identity.clone(),
                thread_id: thread_id.clone(),
                cwd: state.thread.cwd.clone(),
                plugin: owner.plugin.clone(),
                digest: owner.digest.clone(),
                server_id: server_id.clone(),
                generation: expected_generation,
                tool_name: tool.definition.name.clone(),
                request_id: request_id.clone(),
                request_digest: hash,
                resource,
                metadata: metadata.clone(),
                arguments: args.clone(),
                context: Value::Null,
                file_resource: file_resource.clone(),
            };
            let mut instances = self.desktop.mcp_apps.instances.read().unwrap().clone();
            instances.insert(saved.instance_id.clone(), saved.clone());
            self.app_save(instances).await?;
            saved
        };
        let initial_result = if arguments.is_some() {
            Some(
                self.app_tool_turn(
                    identity,
                    thread_id.clone(),
                    server_id.clone(),
                    expected_generation,
                    tool.definition.name.clone(),
                    args,
                    format!("{request_id}:initial"),
                    Some(saved.instance_id.clone()),
                    file_resource,
                    manual_entrypoint,
                )
                .await?,
            )
        } else {
            None
        };
        Ok(
            json!({"instanceId":saved.instance_id,"serverId":server_id,"generation":expected_generation,"toolMetadata":metadata,"resource":saved.resource,"initialArguments":saved.arguments,"initialResult":initial_result,"hostContext":{"threadId":thread_id,"modelContext":saved.context,"deepLink":deep_link}}),
        )
    }
    pub async fn mcp_app_request(
        self: &Arc<Self>,
        identity: String,
        thread_id: String,
        instance_id: String,
        generation: u64,
        request: Value,
        request_id: Option<String>,
    ) -> Result<Value> {
        let (saved, owner, server) = self
            .app_bound(&identity, &thread_id, &instance_id, generation)
            .await?;
        if request["jsonrpc"] != "2.0" {
            return Err(invalid("invalid JSON-RPC envelope"));
        }
        let method = request["method"]
            .as_str()
            .ok_or_else(|| invalid("missing JSON-RPC method"))?;
        let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
        if serde_json::to_vec(&params).map_err(invalid)?.len()
            > if method == "ui/host-file" {
                3 * 1024 * 1024
            } else {
                64 * 1024
            }
        {
            return Err(invalid("App request exceeds budget"));
        }
        let cursor = || params["cursor"].as_str().map(str::to_owned);
        let uri = || {
            params["uri"]
                .as_str()
                .ok_or_else(|| invalid("resource URI required"))
        };
        let result = match method {
            "ui/initialize" => {
                json!({"protocolVersion":"2026-01-26","hostInfo":{"name":"AReaL","version":env!("CARGO_PKG_VERSION")},"hostCapabilities":{"serverTools":{},"serverResources":{},"updateModelContext":{}},"hostContext":{"threadId":thread_id,"modelContext":saved.context}})
            }
            "tools/call" => {
                let name = params["name"]
                    .as_str()
                    .ok_or_else(|| invalid("tool name required"))?;
                let tool = owner
                    .tools
                    .iter()
                    .find(|t| {
                        t.server_name() == server.name()
                            && (t.original_name() == name || t.definition.name == name)
                    })
                    .ok_or(Error::NotFound)?;
                if !tool.is_app_visible() {
                    return Err(invalid("tool is not App-visible"));
                }
                let request_id =
                    request_id.ok_or_else(|| invalid("tool call requires durable requestId"))?;
                self.app_tool_turn(
                    identity.clone(),
                    thread_id.clone(),
                    server.name().into(),
                    generation,
                    tool.definition.name.clone(),
                    params
                        .get("arguments")
                        .cloned()
                        .unwrap_or_else(|| json!({})),
                    request_id,
                    Some(instance_id.clone()),
                    saved.file_resource.clone(),
                    false,
                )
                .await?
            }
            "resources/list" => serde_json::to_value(
                server
                    .list_resources(cursor(), self.shutdown.child_token())
                    .await
                    .map_err(invalid)?,
            )
            .map_err(invalid)?,
            "resources/templates/list" => serde_json::to_value(
                server
                    .list_resource_templates(cursor(), self.shutdown.child_token())
                    .await
                    .map_err(invalid)?,
            )
            .map_err(invalid)?,
            "resources/read" => {
                self.app_read_resource(
                    &identity,
                    &thread_id,
                    Some(instance_id.clone()),
                    &server,
                    uri()?,
                )
                .await?
            }
            "resources/subscribe" | "resources/unsubscribe" => {
                let uri = uri()?;
                if uri.len() > 8192 {
                    return Err(invalid("resource URI exceeds budget"));
                }
                let _guard = self.desktop.mcp_apps.mutation.lock().await;
                // The App may have closed while this request waited for the gate.
                let (_, _, server) = self
                    .app_bound(&identity, &thread_id, &instance_id, generation)
                    .await?;
                let key = (server.name().to_owned(), generation, uri.to_owned());
                let subscribed = {
                    let mut subscriptions = self.desktop.mcp_apps.subscriptions.write().unwrap();
                    subscriptions.retain(|_, subscription| !subscription.server.is_revoked());
                    subscriptions.contains_key(&key)
                };
                if method == "resources/subscribe" {
                    if !subscribed {
                        server
                            .subscribe(uri, self.shutdown.child_token())
                            .await
                            .map_err(invalid)?;
                    }
                    if server.is_revoked() {
                        return Err(invalid("server generation revoked"));
                    }
                    self.desktop
                        .mcp_apps
                        .subscriptions
                        .write()
                        .unwrap()
                        .entry(key)
                        .or_insert_with(|| Subscription {
                            server,
                            instances: Default::default(),
                        })
                        .instances
                        .insert(instance_id.clone());
                } else {
                    let last = {
                        let mut subscriptions =
                            self.desktop.mcp_apps.subscriptions.write().unwrap();
                        let last = subscriptions.get_mut(&key).is_some_and(|subscription| {
                            subscription.instances.remove(&instance_id)
                                && subscription.instances.is_empty()
                        });
                        if last {
                            subscriptions.remove(&key);
                        }
                        last
                    };
                    // An App cannot release another App's lease; unknown/duplicate release is local.
                    // Remove ownership before I/O: a failed/unknown response must not replay it.
                    if last && !server.is_revoked() {
                        server
                            .unsubscribe(uri, self.shutdown.child_token())
                            .await
                            .map_err(invalid)?;
                    }
                }
                json!({})
            }
            "ui/update-model-context" => {
                let context = params.clone();
                if !context.is_object() {
                    return Err(invalid("model context must be an object"));
                }
                let _guard = self.desktop.mcp_apps.mutation.lock().await;
                let mut instances = self.desktop.mcp_apps.instances.read().unwrap().clone();
                {
                    let current = instances.get_mut(&instance_id).ok_or(Error::NotFound)?;
                    if current.identity != identity
                        || current.thread_id != thread_id
                        || current.generation != generation
                        || current.runtime_epoch != self.desktop.mcp_apps.runtime_epoch
                    {
                        return Err(invalid("App owner or generation mismatch"));
                    }
                    current.context = context;
                }
                self.app_save(instances).await?;
                json!({})
            }
            "ui/host-file" if params["request"]["method"] == "openai/resources/write" => {
                let request_id =
                    request_id.ok_or_else(|| invalid("file write requires durable requestId"))?;
                let file_request = params["request"].clone();
                let parameters = json!({"thread":thread_id,"instance":instance_id,"generation":generation,"request":file_request});
                let response = self
                    .management_submission(
                        identity.clone(),
                        request_id,
                        "areal/mcp/app/file/write".into(),
                        parameters,
                        move |engine| async move {
                            let outcome = async {
                                let (current, _, _) = engine
                                    .app_bound(&identity, &thread_id, &instance_id, generation)
                                    .await?;
                                engine.app_host_file(&current, &file_request).await
                            }
                            .await;
                            match outcome {
                                Ok(result) => json!({"result":result}),
                                Err(error) => {
                                    json!({"error":{"code":-32000,"message":error.to_string()}})
                                }
                            }
                        },
                    )
                    .await?;
                if let Some(error) = response.get("error") {
                    return Ok(json!({"jsonrpc":"2.0","id":request["id"],"error":error}));
                }
                response["result"].clone()
            }
            "ui/host-file" => self.app_host_file(&saved, &params["request"]).await?,
            "ui/host-authorize" => {
                let operation = params["method"]
                    .as_str()
                    .or_else(|| params["operation"].as_str())
                    .unwrap_or("");
                if !matches!(
                    operation,
                    "resources/read"
                        | "resources/subscribe"
                        | "resources/unsubscribe"
                        | "openai/resources/write"
                        | "openai/files/open"
                        | "ui/message"
                ) {
                    return Err(invalid("host operation unsupported"));
                }
                json!({"authorized":true,"instanceId":instance_id,"generation":generation})
            }
            "ui/notifications/initialized" | "ui/notifications/size-changed" => json!({}),
            _ => {
                return Ok(
                    json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32601,"message":"unsupported App method"}}),
                );
            }
        };
        Ok(rpc_result(request["id"].clone(), result))
    }
    // This operation is reachable only through trusted Main, never the App bridge.
    async fn app_host_file(&self, saved: &Instance, request: &Value) -> Result<Value> {
        let file = saved
            .file_resource
            .as_ref()
            .ok_or_else(|| invalid("App has no file grant"))?;
        let uri = file["uri"]
            .as_str()
            .ok_or_else(|| invalid("file grant URI missing"))?;
        if request["params"]["uri"] != uri {
            return Err(invalid("resource does not match this App's file grant"));
        }
        let path = file["path"]
            .as_str()
            .ok_or_else(|| invalid("file grant path missing"))?;
        let relative = Path::new(path).strip_prefix(&saved.cwd).map_err(invalid)?;
        if relative.as_os_str().is_empty()
            || relative
                .components()
                .any(|p| !matches!(p, std::path::Component::Normal(_)))
        {
            return Err(invalid("file grant must be within this workspace"));
        }
        let path = relative
            .to_str()
            .ok_or_else(|| invalid("file path must be UTF-8"))?
            .to_owned();
        let cell = self.cell(&saved.thread_id).await?;
        let configuration = desktop(&cell.state.lock().await.thread).configuration;
        let permissions = self.permission_config();
        let denied = |name: &str| {
            permissions
                .deny
                .iter()
                .any(|p| crate::permissions::matches_tool(p, name))
        };
        let allowed = |name: &str| {
            configuration
                .tool_allowlist
                .as_ref()
                .is_none_or(|v| v.iter().any(|n| n == name))
        };
        if denied("fs_read") || !allowed("fs_read") {
            return Err(invalid("workspace read capability denied"));
        }
        let writable = self
            .runtime
            .as_ref()
            .is_some_and(|r| r.writable && r.workspace == Path::new(&saved.cwd))
            && !configuration.read_only
            && allowed("fs_write")
            && !denied("fs_write")
            && cell.bindings.read().await.registry.get("fs_write").is_ok();
        let method = request["method"].as_str().unwrap_or("").to_owned();
        if !matches!(method.as_str(), "resources/read" | "openai/resources/write") {
            return Err(invalid("unsupported host file operation"));
        }
        if method == "openai/resources/write" && !writable {
            return Err(invalid("workspace write capability denied"));
        }
        let root = saved.cwd.clone();
        let uri = uri.to_owned();
        let params = request["params"].clone();
        tokio::task::spawn_blocking(move || host_file(root, path, uri, method, params, writable))
            .await
            .map_err(invalid)?
    }
    pub(super) async fn revoke_plugin_apps_without_mutation_lock(
        &self,
        plugin: &str,
        generations: &std::collections::BTreeSet<u64>,
    ) -> Result<()> {
        let mut instances = self.desktop.mcp_apps.instances.read().unwrap().clone();
        let closed: Vec<_> = instances
            .values()
            .filter(|instance| instance.plugin == plugin)
            .cloned()
            .collect();
        for instance in &closed {
            self.desktop
                .mcp_apps
                .page_tools
                .revoke_instance(&instance.instance_id);
        }
        instances.retain(|_, instance| instance.plugin != plugin);
        let mut operations = self
            .desktop
            .mcp_apps
            .result_operations
            .read()
            .unwrap()
            .clone();
        for record in operations
            .values_mut()
            .filter(|record| record.plugin_id == plugin)
        {
            if matches!(
                record.state,
                ResultState::Preparing | ResultState::Open { .. }
            ) {
                record.state = ResultState::Unavailable {
                    reason: ResultUnavailable::SourceDisabled,
                };
            }
        }
        self.app_commit(instances, operations).await?;
        self.desktop
            .mcp_apps
            .subscriptions
            .write()
            .unwrap()
            .retain(|(_, generation, _), _| !generations.contains(generation));
        self.desktop
            .mcp_apps
            .settings
            .write()
            .unwrap()
            .retain(|(_, _, _, generation), _| !generations.contains(generation));
        self.desktop
            .mcp_apps
            .reads
            .write()
            .unwrap()
            .retain(|_, (generation, cancel)| {
                if generations.contains(generation) {
                    cancel.cancel();
                    false
                } else {
                    true
                }
            });
        for instance in closed {
            if let Ok(cell) = self.raw_cell(&instance.thread_id).await {
                cell.emit("areal/mcp/app/notification",json!({"threadId":instance.thread_id,"instanceId":instance.instance_id,"generation":instance.generation,"notification":{"jsonrpc":"2.0","method":"ui/notifications/closed"}}));
            }
        }
        Ok(())
    }

    pub async fn mcp_app_close(
        self: &Arc<Self>,
        identity: String,
        thread_id: String,
        instance_id: String,
        generation: u64,
    ) -> Result<Value> {
        // 失效实例仍可关闭，且不能借关闭触碰别人的实例。
        let _guard = self.desktop.mcp_apps.mutation.lock().await;
        let saved = self
            .desktop
            .mcp_apps
            .instances
            .read()
            .unwrap()
            .get(&instance_id)
            .cloned();
        let Some(saved) = saved else {
            return Ok(json!({"closed":true}));
        };
        if saved.identity != identity
            || saved.thread_id != thread_id
            || saved.generation != generation
        {
            return Err(invalid("App owner or generation mismatch"));
        }
        // Recheck live ownership under the gate. Stale instances remain closable, but
        // cannot send cleanup to a revoked/replaced connection or changed package.
        let live = if let Ok(cell) = self.raw_cell(&thread_id).await {
            saved.runtime_epoch == self.desktop.mcp_apps.runtime_epoch
                && cell.state.lock().await.thread.cwd == saved.cwd
                && self
                    .plugin_server(&saved.server_id, generation)
                    .await
                    .is_ok_and(|(owner, _)| {
                        owner.plugin == saved.plugin && owner.digest == saved.digest
                    })
        } else {
            false
        };
        let mut instances = self.desktop.mcp_apps.instances.read().unwrap().clone();
        instances.remove(&instance_id);
        let mut operations = self
            .desktop
            .mcp_apps
            .result_operations
            .read()
            .unwrap()
            .clone();
        for record in operations.values_mut() {
            if matches!(&record.state, ResultState::Open { instance_id: current } if current == &instance_id)
            {
                record.state = ResultState::Closed {
                    instance_id: instance_id.clone(),
                    generation,
                };
            }
        }
        self.desktop
            .mcp_apps
            .page_tools
            .revoke_instance(&instance_id);
        self.app_commit(instances, operations).await?;
        for owner in self.desktop.mcp_apps.calls.lock().await.values() {
            if owner.identity == identity
                && owner.thread == thread_id
                && owner.instance.as_deref() == Some(&instance_id)
            {
                owner.cancellation.cancel();
            }
        }
        let releases = {
            let mut subscriptions = self.desktop.mcp_apps.subscriptions.write().unwrap();
            let mut releases = Vec::new();
            subscriptions.retain(|(_, _, uri), subscription| {
                if subscription.server.is_revoked() {
                    return false;
                }
                if subscription.instances.remove(&instance_id) && subscription.instances.is_empty()
                {
                    if live {
                        releases.push((uri.clone(), subscription.server.clone()));
                    }
                    return false;
                }
                true
            });
            releases
        };
        drop(_guard);
        let mut cleanup_error = None;
        for (uri, server) in releases {
            if !server.is_revoked()
                && let Err(error) = server.unsubscribe(&uri, self.shutdown.child_token()).await
            {
                cleanup_error.get_or_insert_with(|| invalid(error));
            }
        }
        if let Some(error) = cleanup_error {
            return Err(error);
        }
        Ok(json!({"closed":true}))
    }
    pub async fn mcp_extension_call(
        self: &Arc<Self>,
        identity: String,
        thread_id: String,
        server_generation: (String, u64),
        kind: String,
        arguments: Value,
        request_id: String,
    ) -> Result<Value> {
        let (server_id, expected_generation) = server_generation;
        self.app_scope(&thread_id).await?;
        let (owner, server) = self.plugin_server(&server_id, expected_generation).await?;
        let info = serde_json::to_value(server.info()).map_err(invalid)?;
        let capabilities = &info["capabilities"]["extensions"];
        let settings_key = (
            identity.clone(),
            thread_id.clone(),
            server_id.clone(),
            expected_generation,
        );
        let mut args = arguments;
        let name = match kind.as_str() {
            "settingsRead" => capabilities["openai/settings"]["readTool"]
                .as_str()
                .map(str::to_owned),
            "settingsUpdate" => {
                let current = self
                    .desktop
                    .mcp_apps
                    .settings
                    .read()
                    .unwrap()
                    .get(&settings_key)
                    .cloned()
                    .ok_or_else(|| invalid("read current settings before update"))?;
                let changes = args["set"]
                    .as_object()
                    .ok_or_else(|| invalid("settings update requires set object"))?;
                for (key, value) in changes {
                    let property = current["schema"]["properties"]
                        .get(key)
                        .ok_or_else(|| invalid("unknown settings property"))?;
                    if !jsonschema::validator_for(property)
                        .map_err(invalid)?
                        .is_valid(value)
                    {
                        return Err(invalid("invalid settings value"));
                    }
                }
                capabilities["openai/settings"]["updateTool"]
                    .as_str()
                    .map(str::to_owned)
            }
            "settingsAction" => {
                let name = args["toolName"]
                    .as_str()
                    .ok_or_else(|| invalid("settings action toolName required"))?
                    .to_owned();
                let current = self
                    .desktop
                    .mcp_apps
                    .settings
                    .read()
                    .unwrap()
                    .get(&settings_key)
                    .cloned()
                    .ok_or_else(|| invalid("read current settings before action"))?;
                if !current["layout"].as_array().is_some_and(|groups| {
                    groups.iter().any(|g| {
                        g["items"].as_array().is_some_and(|items| {
                            items
                                .iter()
                                .any(|i| i["kind"] == "tool" && i["tool"] == name)
                        })
                    })
                }) {
                    return Err(invalid(
                        "tool is not referenced by current same-server settings layout",
                    ));
                }
                args = json!({});
                Some(name)
            }
            "mentionsSearch" => capabilities["openai/mentions"]["searchTool"]
                .as_str()
                .map(str::to_owned)
                .or_else(|| {
                    if !capabilities["openai/mentions"].is_null() {
                        return None;
                    }
                    owner
                        .tools
                        .iter()
                        .find(|t| {
                            t.server_name() == server.name()
                                && serde_json::to_value(t.metadata()).is_ok_and(|v| {
                                    v["_meta"]["openai/extensions"]["mentions/search"].is_object()
                                })
                        })
                        .map(|t| t.original_name().to_owned())
                }),
            _ => return Err(invalid("unsupported extension kind")),
        }
        .ok_or_else(|| invalid("server did not declare the requested extension"))?;
        let tool = owner
            .tools
            .iter()
            .find(|t| {
                t.server_name() == server.name() && t.original_name() == name && t.is_app_visible()
            })
            .ok_or_else(|| invalid("extension tool missing or not App-visible"))?;
        let metadata = serde_json::to_value(tool.metadata()).map_err(invalid)?;
        if matches!(kind.as_str(), "settingsRead" | "mentionsSearch")
            && metadata["annotations"]["readOnlyHint"] != true
        {
            return Err(invalid("extension tool must declare readOnlyHint"));
        }
        if kind == "settingsRead" && (!metadata["outputSchema"].is_object() || args != json!({})) {
            return Err(invalid(
                "settings read requires outputSchema and empty arguments",
            ));
        }
        let result = self
            .app_tool_turn(
                identity,
                thread_id,
                server_id,
                expected_generation,
                tool.definition.name.clone(),
                args,
                request_id,
                None,
                None,
                false,
            )
            .await?;
        if kind == "settingsRead" && result["isError"] != true {
            let settings = result["structuredContent"].clone();
            if !settings["schema"]["properties"].is_object() || !settings["values"].is_object() {
                return Err(invalid("invalid SettingsReadResult"));
            }
            for (name, property) in settings["schema"]["properties"].as_object().unwrap() {
                if !matches!(
                    property["type"].as_str(),
                    Some("boolean" | "string" | "integer" | "number")
                ) || !settings["values"].as_object().unwrap().contains_key(name)
                {
                    return Err(invalid("unsupported or incomplete settings schema"));
                }
            }
            self.desktop
                .mcp_apps
                .settings
                .write()
                .unwrap()
                .insert(settings_key, settings);
        }
        Ok(result)
    }
    #[allow(clippy::too_many_arguments)]
    async fn app_tool_turn(
        self: &Arc<Self>,
        identity: String,
        thread_id: String,
        server_id: String,
        generation: u64,
        tool_name: String,
        arguments: Value,
        request_id: String,
        instance: Option<String>,
        file_resource: Option<Value>,
        manual_entrypoint: bool,
    ) -> Result<Value> {
        let cell = self.app_scope(&thread_id).await?;
        let (owner, _) = self.plugin_server(&server_id, generation).await?;
        let tool = owner
            .tools
            .iter()
            .find(|t| t.server_name() == server_id && t.definition.name == tool_name)
            .cloned()
            .ok_or(Error::NotFound)?;
        if manual_entrypoint {
            if !declared_entrypoint(
                &serde_json::to_value(tool.metadata()).map_err(invalid)?,
                &arguments,
                file_resource.as_ref(),
            ) {
                return Err(invalid("tool is not a matching declared entrypoint"));
            }
        } else if !tool.is_app_visible() {
            return Err(invalid("tool is not App-visible"));
        }
        if !arguments.is_object() {
            return Err(invalid("tool arguments must be an object"));
        }
        if file_resource.as_ref().is_some_and(|f| {
            f["uri"].as_str().is_none()
                || f["path"]
                    .as_str()
                    .is_none_or(|p| !Path::new(p).is_absolute())
        }) {
            return Err(invalid("trusted file resource is invalid"));
        }
        let hash = digest(
            &json!({"server":server_id,"generation":generation,"tool":tool_name,"arguments":arguments,"instance":instance,"fileResource":file_resource}),
        )?;
        let method = "areal/mcp/app/tool";
        let _gate = self.desktop.lifecycle.gate.lock().await;
        let mut state = cell.state.lock().await;
        let data = desktop(&state.thread);
        let turn_id = if let Some(previous) = receipt(&data, &identity, &request_id, method, &hash)?
        {
            previous["turnId"]
                .as_str()
                .ok_or_else(|| invalid("invalid saved App receipt"))?
                .to_owned()
        } else {
            if state.active.is_some() || state.compacting {
                return Err(Error::Conflict);
            }
            if data.archived
                || data.queue.paused
                || data
                    .queue
                    .items
                    .iter()
                    .any(|item| matches!(item.status.as_str(), "pending" | "running"))
            {
                return Err(Error::Conflict);
            }
            let _ordinary = self.ordinary_admission(&state.thread).await?;
            self.check_turn_available(&cell, &state).await?;
            let (mut candidate, turn) = self.prepare_app_tool_turn(
                &state.thread,
                format!("App tool request: {}", tool.original_name()),
            )?;
            let permit = self.reserve_active_turn()?;
            remember(
                candidate.desktop.get_or_insert_with(Default::default),
                &identity,
                &request_id,
                method,
                hash,
                json!({"turnId":turn.id,"mcpAppInstance":instance}),
            );
            self.persist(&candidate).await?;
            state.thread = candidate;
            let mut args = arguments;
            if let Some(object) = args.as_object_mut() {
                object.remove("_meta");
            } else {
                return Err(invalid("tool arguments must be an object"));
            }
            let mut meta = None;
            if let Some(file) = file_resource {
                let _uri = file["uri"]
                    .as_str()
                    .ok_or_else(|| invalid("trusted file URI required"))?;
                let path = file["path"]
                    .as_str()
                    .ok_or_else(|| invalid("trusted file path required"))?;
                if !Path::new(path).is_absolute() {
                    return Err(invalid("trusted file path must be absolute"));
                }
                meta = Some(serde_json::Map::from_iter([(
                    "openai/resource".into(),
                    json!({"path":path}),
                )]));
            }
            let call = ToolCall {
                id: id(),
                name: tool.definition.name.clone(),
                arguments: args.to_string(),
            };
            self.activate_with_tool(
                &cell,
                &mut state,
                &turn,
                self.shutdown.child_token(),
                permit,
                (Some(call), meta),
            );
            // App 可继续其冻结旧代；工具入口仍按实时 Store 检查撤销。
            state.active.as_mut().unwrap().registry = self
                .registry
                .clone()
                .with_mcp(vec![tool])
                .and_then(|r| r.with_dynamic(&state.thread.dynamic_tools))
                .map_err(|e| e.to_string());
            turn.id
        };
        drop(state);
        drop(_gate);
        let mut settled = cell.settled.subscribe();
        loop {
            let state = cell.state.lock().await;
            if state.active.as_ref().is_none_or(|a| a.id != turn_id) {
                break;
            }
            drop(state);
            settled.changed().await.map_err(invalid)?;
        }
        let state = cell.state.lock().await;
        let turn = state
            .thread
            .turns
            .iter()
            .find(|t| t.id == turn_id)
            .ok_or_else(|| invalid("accepted App turn is unavailable; refusing replay"))?;
        let result = turn.items.iter().find_map(|i| {
            if let Item::DynamicToolCall { execution, .. } = i {
                Some((execution.outcome.clone(), execution.result_snapshot.clone()))
            } else {
                None
            }
        });
        drop(state);
        let Some((outcome, snapshot)) = result else {
            return Err(invalid(
                "accepted App turn did not produce a tool result; refusing replay",
            ));
        };
        if outcome == ToolOutcome::Unknown {
            return Err(invalid(
                "App tool result UNKNOWN; inspect and acknowledge before another turn",
            ));
        }
        if let Some(reference) = snapshot {
            let blob = reference
                .uri
                .strip_prefix("areal://blob/")
                .ok_or_else(|| invalid("invalid result reference"))?;
            let value: Value =
                serde_json::from_slice(&self.store.read_blob(blob).await.map_err(invalid)?)
                    .map_err(invalid)?;
            if let Some(raw) = value.get("mcpResult") {
                return Ok(raw.clone());
            }
            return Ok(value);
        }
        Err(invalid("App result snapshot unavailable; refusing replay"))
    }
    async fn validate_mcp_owner(
        &self,
        owner: &CallOwner,
        server: &str,
        generation: u64,
    ) -> Result<()> {
        if owner.cancellation.is_cancelled() {
            return Err(invalid("MCP caller ended"));
        }
        let cell = self.cell(&owner.thread).await?;
        match &owner.scope {
            CallOwnerScope::CompactionHook { activation } => {
                let state = cell.state.lock().await;
                if !state.compacting
                    || state.compaction_owner.as_ref().is_none_or(|current| {
                        current.token != *activation || current.cancellation.is_cancelled()
                    })
                {
                    return Err(invalid("MCP hook compaction owner ended"));
                }
            }
            CallOwnerScope::Tool | CallOwnerScope::Hook { .. } => {
                if cell
                    .state
                    .lock()
                    .await
                    .active
                    .as_ref()
                    .is_none_or(|a| a.id != owner.turn)
                {
                    return Err(invalid("MCP caller turn ended"));
                }
                if let Some(instance) = &owner.instance {
                    let source_generation = match owner.scope {
                        CallOwnerScope::Hook {
                            app_generation: Some(g),
                        } => g,
                        _ => generation,
                    };
                    self.app_bound(&owner.identity, &owner.thread, instance, source_generation)
                        .await?;
                }
            }
            CallOwnerScope::AppRead { cwd, epoch } => {
                self.app_scope(&owner.thread).await?;
                self.plugin_server(server, generation).await?;
                if epoch != &self.desktop.mcp_apps.runtime_epoch
                    || cell.state.lock().await.thread.cwd != *cwd
                {
                    return Err(invalid("MCP App read binding changed"));
                }
                if let Some(instance) = &owner.instance {
                    self.app_bound(&owner.identity, &owner.thread, instance, generation)
                        .await?;
                }
            }
        }
        Ok(())
    }
    pub(crate) async fn hook_call_owner(
        self: &Arc<Self>,
        cell: &Cell,
        call: &ToolCall,
    ) -> Result<CallOwner> {
        {
            let state = cell.state.lock().await;
            if state.active.is_none() && state.compacting {
                let mut owner = state.compaction_owner.clone().ok_or(Error::Conflict)?;
                owner.scope = CallOwnerScope::CompactionHook {
                    activation: owner.token.clone(),
                };
                owner.token = id();
                owner.call = call.id.clone();
                return Ok(owner);
            }
        }
        let mut owner = self.mcp_call_owner(cell, call).await?;
        let generation = if let Some(instance) = &owner.instance {
            Some(
                self.desktop
                    .mcp_apps
                    .instances
                    .read()
                    .unwrap()
                    .get(instance)
                    .ok_or(Error::NotFound)?
                    .generation,
            )
        } else {
            None
        };
        owner.scope = CallOwnerScope::Hook {
            app_generation: generation,
        };
        Ok(owner)
    }
    pub(crate) fn mcp_request_context(
        self: &Arc<Self>,
        owner: CallOwner,
        server: String,
        generation: u64,
        tool: Option<areal_mcp::McpTool>,
    ) -> areal_mcp::RequestOwner {
        let engine = Arc::downgrade(self);
        areal_mcp::RequestOwner::new(owner.token.clone(), move || {
            let engine = engine.clone();
            let owner = owner.clone();
            let server = server.clone();
            let tool = tool.clone();
            Box::pin(async move {
                let engine = engine
                    .upgrade()
                    .ok_or_else(|| anyhow::anyhow!("Core ended"))?;
                if let Some(tool) = tool {
                    engine.check_plugin_mcp(&tool).await?;
                } else {
                    engine
                        .plugin_server(&server, generation)
                        .await
                        .map_err(|e| anyhow::anyhow!(e.to_string()))?;
                }
                engine
                    .validate_mcp_owner(&owner, &server, generation)
                    .await
                    .map_err(|e| anyhow::anyhow!(e.to_string()))
            })
        })
    }
    async fn app_read_resource(
        self: &Arc<Self>,
        identity: &str,
        thread: &str,
        instance: Option<String>,
        server: &areal_mcp::McpServer,
        uri: &str,
    ) -> Result<Value> {
        let admission = self.desktop.lifecycle.gate.lock().await;
        let cell = self.app_scope(thread).await?;
        let cancellation = self.shutdown.child_token();
        let _drop = cancellation.clone().drop_guard();
        let owner = CallOwner {
            token: id(),
            scope: CallOwnerScope::AppRead {
                cwd: cell.state.lock().await.thread.cwd.clone(),
                epoch: self.desktop.mcp_apps.runtime_epoch.clone(),
            },
            cancellation: cancellation.clone(),
            identity: identity.into(),
            thread: thread.into(),
            turn: String::new(),
            call: String::new(),
            instance,
        };
        self.desktop.mcp_apps.reads.write().unwrap().insert(
            owner.token.clone(),
            (server.generation(), cancellation.clone()),
        );
        let key = (server.name().to_owned(), server.generation());
        {
            let mut calls = self.desktop.mcp_apps.calls.lock().await;
            if calls.contains_key(&key) {
                return Err(invalid("MCP server has an active caller"));
            }
            calls.insert(key.clone(), owner.clone());
        }
        drop(admission);
        let owner_token = owner.token.clone();
        let context =
            self.mcp_request_context(owner, server.name().into(), server.generation(), None);
        let result = server
            .read_resource_owned(uri, cancellation, Some(&context))
            .await;
        {
            let mut calls = self.desktop.mcp_apps.calls.lock().await;
            if calls.get(&key).is_some_and(|o| o.token == owner_token) {
                calls.remove(&key);
            }
        }
        serde_json::to_value(result.map_err(invalid)?).map_err(invalid)
    }
    pub(crate) async fn mcp_call_owner(&self, cell: &Cell, call: &ToolCall) -> Result<CallOwner> {
        let state = cell.state.lock().await;
        let turn = state.active.as_ref().ok_or(Error::Conflict)?.id.clone();
        let identity = desktop(&state.thread)
            .receipts
            .iter()
            .find(|r| r.result["turnId"] == turn || r.result["turn"]["id"] == turn)
            .map(|r| r.identity.clone())
            .unwrap_or_default();
        let instance = desktop(&state.thread)
            .receipts
            .iter()
            .find(|r| r.result["turnId"] == turn)
            .and_then(|r| r.result["mcpAppInstance"].as_str().map(str::to_owned));
        Ok(CallOwner {
            token: id(),
            scope: CallOwnerScope::Tool,
            cancellation: self.shutdown.child_token(),
            identity,
            thread: cell.id.clone(),
            turn,
            call: call.id.clone(),
            instance,
        })
    }
    pub(super) fn spawn_mcp_forms(
        self: &Arc<Self>,
        mut receiver: tokio::sync::mpsc::Receiver<areal_mcp::ElicitationRequest>,
    ) {
        let weak = Arc::downgrade(self);
        let cancel = self.shutdown.clone();
        self.tasks.spawn(async move{loop{let request=tokio::select!{_=cancel.cancelled()=>break,r=receiver.recv()=>match r{Some(r)=>r,None=>break}};let Some(engine)=weak.upgrade()else{break;};let owner=engine.desktop.mcp_apps.calls.lock().await.get(&(request.server.clone(),request.generation)).cloned();
            if !form_supported(&request.params["requestedSchema"]){let _=request.respond(json!({"action":"decline"}));continue;}
            if let Some(owner)=owner.filter(|o|!o.identity.is_empty() && !o.cancellation.is_cancelled() && request.owner.as_ref().is_none_or(|token|token==&o.token)){let request_id=id();if let Ok(cell)=engine.cell(&owner.thread).await{cell.emit("areal/mcp/form/requested",json!({"threadId":owner.thread,"requestId":request_id,"serverId":request.server,"generation":request.generation}));}engine.desktop.mcp_apps.forms.lock().await.insert(request_id,Form{owner,request});}else{let _=request.respond(json!({"action":"cancel"}));}
        }});
    }
    pub async fn mcp_forms_list(&self, thread_id: String) -> Result<Value> {
        self.app_scope(&thread_id).await?;
        let mut forms = self.desktop.mcp_apps.forms.lock().await;
        forms.retain(|_, f| {
            !f.request.cancellation.is_cancelled() && !f.owner.cancellation.is_cancelled()
        });
        Ok(
            json!({"data":forms.iter().filter(|(_,f)|f.owner.thread==thread_id).map(|(id,f)|json!({"requestId":id,"threadId":thread_id,"turnId":f.owner.turn,"callId":f.owner.call,"instanceId":f.owner.instance,"serverId":f.request.server,"generation":f.request.generation,"message":f.request.params["message"],"requestedSchema":f.request.params["requestedSchema"]})).collect::<Vec<_>>()}),
        )
    }
    pub async fn mcp_form_respond(
        self: &Arc<Self>,
        identity: String,
        thread_id: String,
        request_id: String,
        response: Value,
    ) -> Result<Value> {
        let mut response = if response == json!({"unsupported":true}) {
            json!({"action":"decline"})
        } else {
            response
        };
        self.app_scope(&thread_id).await?;
        let mut forms = self.desktop.mcp_apps.forms.lock().await;
        let form = forms.get(&request_id).ok_or(Error::NotFound)?;
        if form.owner.identity != identity
            || form.owner.thread != thread_id
            || form.request.cancellation.is_cancelled()
        {
            return Err(invalid("form owner mismatch or request expired"));
        }
        self.validate_mcp_owner(&form.owner, &form.request.server, form.request.generation)
            .await?;
        if response["action"] == "accept" {
            if !form_supported(&form.request.params["requestedSchema"]) {
                return Err(invalid("unsupported form schema"));
            }
            let schema = self
                .resolve_form_resources(&request_id, form, &mut response)
                .await?;
            let validator = jsonschema::options()
                .should_validate_formats(true)
                .build(&schema)
                .map_err(invalid)?;
            if !validator.is_valid(&response["content"])
                || !form_resources_valid(&schema, &response["content"])
            {
                return Err(invalid("form response does not match complete schema"));
            }
        }
        let form = forms.remove(&request_id).unwrap();
        form.request.respond(response).map_err(invalid)?;
        Ok(json!({"responded":true}))
    }
    pub(crate) async fn app_model_context(&self, thread: &str) -> Vec<Value> {
        let instances: Vec<_> = self
            .desktop
            .mcp_apps
            .instances
            .read()
            .unwrap()
            .values()
            .filter(|i| {
                i.runtime_epoch == self.desktop.mcp_apps.runtime_epoch
                    && i.thread_id == thread
                    && !i.context.is_null()
            })
            .cloned()
            .collect();
        let mut context = vec![];
        for instance in instances {
            if self.plugin_component(&instance.plugin).await.is_ok() {
                let mut data = instance.context;
                strip_meta(&mut data);
                context.push(json!({"instanceId":instance.instance_id,"serverId":instance.server_id,"context":data}));
            }
        }
        context
    }
}
impl Engine {
    fn prepare_app_tool_turn(&self, thread: &Thread, text: String) -> Result<(Thread, Turn)> {
        let mut candidate = thread.clone();
        let configuration = self.freeze_configuration(desktop(thread).configuration);
        let turn = Turn {
            trace: Default::default(),
            interruption: None,
            continued_from_turn_id: None,
            id: id(),
            started_at: Some(now()),
            completed_at: None,
            duration_ms: None,
            goal: None,
            instruction_snapshot: None,
            instruction_attribution: None,
            generation: None,
            configuration: Some(configuration),
            status: TurnStatus::InProgress,
            error: None,
            items: vec![Item::UserMessage {
                id: id(),
                content: vec![Input::text(text)],
            }],
            usage: None,
        };
        candidate.turns.push(turn.clone());
        candidate.updated_at = now();
        candidate.status = ThreadStatus::Active {
            active_flags: vec![],
        };
        if self.limits.max_history_bytes > 0
            && serde_json::to_vec(&candidate)
                .map_err(invalid)?
                .len()
                .saturating_add(self.limits.max_output_bytes.saturating_mul(6))
                > self.limits.max_history_bytes
        {
            return Err(Error::Exhausted(
                "insufficient history for App tool turn".into(),
            ));
        }
        Ok((candidate, turn))
    }
}
impl Engine {
    pub(super) fn spawn_mcp_resource_updates(self: &Arc<Self>, server: areal_mcp::McpServer) {
        let mut updates = server.resource_updates();
        let weak = Arc::downgrade(self);
        let cancel = self.shutdown.clone();
        self.tasks.spawn(async move {
            while let Ok(update) = updates.recv(cancel.clone()).await {
                let Some(engine) = weak.upgrade() else { break; };
                // Also orders subscribe-time notifications after ownership is committed and
                // prevents a queued notification from escaping after close/unsubscribe.
                let _guard = engine.desktop.mcp_apps.mutation.lock().await;
                if server.is_revoked() { break; }
                let instances = engine.desktop.mcp_apps.subscriptions.read().unwrap()
                    .get(&(update.server.clone(), update.generation, update.uri.clone()))
                    .map(|subscription| subscription.instances.clone()).unwrap_or_default();
                let owners: Vec<_> = engine.desktop.mcp_apps.instances.read().unwrap().values()
                    .filter(|i| i.runtime_epoch == engine.desktop.mcp_apps.runtime_epoch
                        && i.server_id == update.server && i.generation == update.generation
                        && instances.contains(&i.instance_id)).cloned().collect();
                for owner in owners {
                    if let Ok(cell) = engine.cell(&owner.thread_id).await {
                        if server.is_revoked() { break; }
                        cell.emit("areal/mcp/app/notification", json!({"threadId":owner.thread_id,"instanceId":owner.instance_id,"generation":update.generation,"notification":{"jsonrpc":"2.0","method":"notifications/resources/updated","params":{"uri":update.uri}}}));
                    }
                }
            }
            // Revocation does not acquire mutation (open may hold it while revoking).
            // Cleanup is memory-only; subsequent operations also discard revoked handles.
            if let Some(engine) = weak.upgrade() {
                engine.desktop.mcp_apps.subscriptions.write().unwrap()
                    .retain(|_, subscription| !subscription.server.is_revoked());
            }
        });
    }
}
impl Engine {
    pub async fn mcp_tool_result(&self, thread_id: String, call_id: String) -> Result<Value> {
        let thread = self.read(&thread_id, true).await?;
        let snapshot = thread
            .turns
            .iter()
            .flat_map(|t| &t.items)
            .find_map(|i| match i {
                Item::DynamicToolCall {
                    id,
                    call_id: call,
                    execution,
                    ..
                } if call == &call_id || id == &call_id => execution.result_snapshot.clone(),
                _ => None,
            })
            .ok_or(Error::NotFound)?;
        let bytes = self
            .store
            .read_blob(
                snapshot
                    .uri
                    .strip_prefix("areal://blob/")
                    .ok_or_else(|| invalid("invalid MCP result reference"))?,
            )
            .await
            .map_err(invalid)?;
        let value: Value = serde_json::from_slice(&bytes).map_err(invalid)?;
        if value.get("mcpResult").is_none() {
            return Err(Error::NotFound);
        }
        let mut result = value["mcpServer"].clone();
        result["mcpResult"] = value["mcpResult"].clone();
        Ok(result)
    }
}
impl Engine {
    pub async fn mcp_form_preview(
        self: &Arc<Self>,
        identity: String,
        thread_id: String,
        request_id: String,
        target: Value,
    ) -> Result<Value> {
        self.app_scope(&thread_id).await?;
        let (server_id, generation, cancellation, call_owner) = {
            let forms = self.desktop.mcp_apps.forms.lock().await;
            let form = forms.get(&request_id).ok_or(Error::NotFound)?;
            if form.owner.identity != identity
                || form.owner.thread != thread_id
                || form.request.cancellation.is_cancelled()
            {
                return Err(invalid("form owner mismatch or expired"));
            }
            let advertised = form.request.params["requestedSchema"]["properties"]
                .as_object()
                .is_some_and(|fields| {
                    fields.values().any(|field| {
                        field["x-openai-input"]["options"]
                            .as_array()
                            .is_some_and(|options| {
                                options.iter().any(|option| {
                                    option["_meta"]["openai/preview"]["target"] == target
                                })
                            })
                    })
                });
            if !advertised {
                return Err(invalid(
                    "preview target was not advertised by this pending form",
                ));
            }
            (
                form.request.server.clone(),
                form.request.generation,
                form.request.cancellation.clone(),
                form.owner.clone(),
            )
        };
        let (owner, server) = self.plugin_server(&server_id, generation).await?;
        match target["type"].as_str() {
            Some("resource_link") => {
                let uri = target["uri"]
                    .as_str()
                    .ok_or_else(|| invalid("preview URI required"))?;
                let context =
                    self.mcp_request_context(call_owner, server_id.clone(), generation, None);
                let resource = server
                    .read_resource_owned(uri, cancellation, Some(&context))
                    .await
                    .map_err(invalid)?;
                Ok(
                    json!({"type":"resource_link","serverId":server_id,"generation":generation,"resource":resource}),
                )
            }
            Some("mcp_app_tool") => {
                let name = target["name"]
                    .as_str()
                    .ok_or_else(|| invalid("preview tool name required"))?;
                let tool = owner
                    .tools
                    .iter()
                    .find(|t| {
                        t.server_name() == server_id
                            && t.original_name() == name
                            && t.is_app_visible()
                    })
                    .ok_or_else(|| invalid("preview tool unavailable"))?;
                let metadata = serde_json::to_value(tool.metadata()).map_err(invalid)?;
                if tool_uri(&metadata).is_none() {
                    return Err(invalid("preview tool has no App resource"));
                }
                Ok(
                    json!({"type":"mcp_app_tool","serverId":server_id,"generation":generation,"toolName":name,"arguments":target.get("arguments").cloned().unwrap_or_else(||json!({})),"requiresIdleTurn":true}),
                )
            }
            _ => Err(invalid("unsupported preview target")),
        }
    }
}

// Each helper operation anchors traversal to directory descriptors and refuses symlinks.
fn host_file(
    root: String,
    path: String,
    uri: String,
    method: String,
    params: Value,
    writable: bool,
) -> Result<Value> {
    use areal_runtime_protocol::{ExpectedFile, FileCommand, FileHelperRequest, MAX_FILE_CHUNK};
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    let execute = |command| {
        areal_runtime_fs::execute(FileHelperRequest {
            root: root.clone(),
            command,
        })
    };
    let mut bytes = Vec::new();
    let mut etag = String::new();
    loop {
        let chunk = execute(FileCommand::Read {
            path: path.clone(),
            offset: bytes.len() as u64,
            max_bytes: MAX_FILE_CHUNK,
        })
        .map_err(invalid)?;
        if chunk["size"].as_u64().unwrap_or(u64::MAX) > 2 * 1024 * 1024 {
            return Err(invalid("file exceeds 2 MiB host budget"));
        }
        let digest = chunk["sha256"]
            .as_str()
            .ok_or_else(|| invalid("file digest missing"))?;
        if !etag.is_empty() && etag != digest {
            return Err(Error::Conflict);
        }
        etag = digest.to_owned();
        bytes.extend(
            STANDARD
                .decode(chunk["dataBase64"].as_str().unwrap_or(""))
                .map_err(invalid)?,
        );
        if chunk["eof"] == true {
            break;
        }
    }
    if method == "resources/read" {
        let mut content =
            json!({"uri":uri,"_meta":{"openai/resource":{"etag":etag,"writable":writable}}});
        let representation = params["_meta"]["openai/resource"]["representation"].as_str();
        if representation == Some("blob") {
            content["blob"] = json!(STANDARD.encode(&bytes));
        } else if let Ok(text) = std::str::from_utf8(&bytes) {
            content["text"] = json!(text);
        } else if representation == Some("text") {
            return Err(invalid("requested text representation is not UTF-8"));
        } else {
            content["blob"] = json!(STANDARD.encode(&bytes));
        }
        return Ok(json!({"contents":[content]}));
    }
    if params
        .get("ifMatch")
        .is_some_and(|v| v.as_str() != Some(etag.as_str()))
    {
        return Ok(json!({"outcome":"conflict","etag":etag}));
    }
    let replacement = match (params.get("text"), params.get("blob")) {
        (Some(Value::String(text)), None) => text.as_bytes().to_vec(),
        (None, Some(Value::String(blob))) => STANDARD.decode(blob).map_err(invalid)?,
        _ => return Err(invalid("supply exactly one text or blob replacement")),
    };
    if replacement.len() > MAX_FILE_CHUNK {
        return Ok(json!({"outcome":"too-large","maxBytes":MAX_FILE_CHUNK}));
    }
    match execute(FileCommand::Write {
        path: path.clone(),
        data_base64: STANDARD.encode(&replacement),
        expected: ExpectedFile::Sha256 { value: etag },
    }) {
        Ok(value) => Ok(json!({"outcome":"saved","etag":value["sha256"]})),
        Err(error) if error.code == areal_runtime_protocol::ErrorCode::Conflict => {
            let current = execute(FileCommand::Read {
                path,
                offset: 0,
                max_bytes: 1,
            })
            .map_err(invalid)?;
            Ok(json!({"outcome":"conflict","etag":current["sha256"]}))
        }
        Err(error) => Err(invalid(format!(
            "file write failed; do not automatically replay: {error}"
        ))),
    }
}

impl Engine {
    async fn result_source_server(
        &self,
        source: &ResultProvenance,
    ) -> std::result::Result<(super::plugin_mcp::Generation, areal_mcp::McpServer), ResultUnavailable>
    {
        if source.version != 1 || source.apps_epoch != self.desktop.mcp_apps.runtime_epoch {
            return Err(ResultUnavailable::StaleSourceEpoch);
        }
        let component = self
            .plugin_component(&source.plugin_id)
            .await
            .map_err(|_| ResultUnavailable::SourceDisabled)?;
        if component.digest != source.installed_digest {
            return Err(ResultUnavailable::PackageChanged);
        }
        let (owner, server) = self
            .plugin_server(&source.server_id, source.generation)
            .await
            .map_err(|_| ResultUnavailable::SourceUnavailable)?;
        if owner.plugin != source.plugin_id || owner.digest != source.installed_digest {
            return Err(ResultUnavailable::PackageChanged);
        }
        Ok((owner, server))
    }
    async fn saved_result(
        &self,
        input: &OpenFromResult,
    ) -> std::result::Result<SavedResult, ResultUnavailable> {
        let thread = self
            .read(&input.thread_id, true)
            .await
            .map_err(|_| ResultUnavailable::SourceUnavailable)?;
        let item = thread
            .turns
            .iter()
            .find(|turn| turn.id == input.turn_id)
            .and_then(|turn| turn.items.iter().find(|item| item.id() == input.item_id))
            .ok_or(ResultUnavailable::NotSuccessful)?;
        let Item::DynamicToolCall {
            status: ToolStatus::Completed,
            success: Some(true),
            arguments,
            execution,
            ..
        } = item
        else {
            return Err(ResultUnavailable::NotSuccessful);
        };
        if !matches!(execution.outcome, ToolOutcome::Succeeded)
            || execution.backend.as_deref() != Some("mcp")
        {
            return Err(ResultUnavailable::NotSuccessful);
        }
        let snapshot = execution
            .result_snapshot
            .as_ref()
            .ok_or(ResultUnavailable::MissingProvenance)?;
        let sha = snapshot
            .uri
            .strip_prefix("areal://blob/")
            .ok_or(ResultUnavailable::CorruptSnapshot)?;
        if snapshot.size_bytes > areal_protocol::MAX_TOOL_RESULT_BYTES as u64 {
            return Err(ResultUnavailable::CorruptSnapshot);
        }
        use tokio::io::AsyncReadExt;
        let path = self
            .store
            .blob_path(sha)
            .map_err(|_| ResultUnavailable::CorruptSnapshot)?;
        let file = tokio::fs::File::open(path)
            .await
            .map_err(|_| ResultUnavailable::CorruptSnapshot)?;
        let mut bytes = Vec::new();
        file.take(snapshot.size_bytes + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| ResultUnavailable::CorruptSnapshot)?;
        if bytes.len() as u64 != snapshot.size_bytes
            || format!("{:x}", Sha256::digest(&bytes)) != sha
        {
            return Err(ResultUnavailable::CorruptSnapshot);
        }
        let raw: Value =
            serde_json::from_slice(&bytes).map_err(|_| ResultUnavailable::CorruptSnapshot)?;
        let source: ResultProvenance = serde_json::from_value(raw["mcpServer"]["source"].clone())
            .map_err(|_| ResultUnavailable::MissingProvenance)?;
        if !raw["mcpResult"].is_object() {
            return Err(ResultUnavailable::MissingProvenance);
        }
        if source.thread_id != input.thread_id || source.cwd != thread.cwd {
            return Err(ResultUnavailable::SourceUnavailable);
        }
        self.app_scope(&input.thread_id)
            .await
            .map_err(|_| ResultUnavailable::SourceUnavailable)?;
        let (owner, server) = self.result_source_server(&source).await?;
        let tool = owner
            .tools
            .iter()
            .find(|tool| {
                tool.server_name() == source.server_id
                    && tool.generation() == source.generation
                    && tool.original_name() == source.original_tool_name
            })
            .ok_or(ResultUnavailable::SourceUnavailable)?;
        let metadata = raw["mcpServer"]["toolMetadata"].clone();
        if tool_uri(&metadata).is_none() {
            return Err(ResultUnavailable::ResourceRejected);
        }
        Ok(SavedResult {
            provenance: source,
            snapshot_sha: sha.into(),
            metadata,
            arguments: execution
                .effective_arguments
                .clone()
                .unwrap_or_else(|| arguments.clone()),
            result: raw["mcpResult"].clone(),
            tool_name: tool.definition.name.clone(),
            server,
        })
    }
    pub async fn mcp_app_open_from_result(
        self: &Arc<Self>,
        identity: String,
        host: Option<Arc<dyn crate::tools::DynamicToolHost>>,
        input: OpenFromResult,
    ) -> Result<Value> {
        if identity.is_empty()
            || identity.len() > 256
            || ![&input.thread_id, &input.turn_id, &input.item_id]
                .into_iter()
                .all(|value| valid_id(value))
            || input.request_id.len() > 128
        {
            return Err(invalid("invalid result identity"));
        }
        let parts: Vec<_> = input.request_id.split('.').collect();
        if parts.len() != 3
            || parts[0] != "result-v1"
            || uuid::Uuid::parse_str(parts[1]).is_err()
            || uuid::Uuid::parse_str(parts[2]).is_err()
        {
            return Err(invalid("invalid result requestId"));
        }
        if parts[1] != self.desktop.mcp_apps.runtime_epoch {
            return Ok(unavailable(ResultUnavailable::StaleSourceEpoch));
        }
        let source = ResultRef {
            thread_id: input.thread_id.clone(),
            turn_id: input.turn_id.clone(),
            item_id: input.item_id.clone(),
        };
        let request_key = digest(&json!([identity, input.request_id]))?;
        let tool_host_id = host.as_ref().map(|h| h.id().to_owned());
        let request_digest = digest(&json!([identity, source, tool_host_id]))?;
        {
            let _guard = self.desktop.mcp_apps.mutation.lock().await;
            if let Some(record) = self
                .desktop
                .mcp_apps
                .result_operations
                .read()
                .unwrap()
                .get(&request_key)
            {
                if record.digest != request_digest {
                    return Err(Error::Conflict);
                }
                match record.state {
                    ResultState::Closed { .. } => return Ok(json!({"status":"closed"})),
                    ResultState::Unavailable { reason } => return Ok(unavailable(reason)),
                    _ => {}
                }
            }
        }
        let resolved = self.saved_result(&input).await;
        let source_key = match &resolved {
            Ok(saved) => digest(&json!([identity, source, saved.snapshot_sha, tool_host_id]))?,
            Err(_) => request_key.clone(),
        };
        let _guard = self.desktop.mcp_apps.mutation.lock().await;
        let mut operations = self
            .desktop
            .mcp_apps
            .result_operations
            .read()
            .unwrap()
            .clone();
        if let Some(record) = operations.get(&request_key) {
            if record.digest != request_digest {
                return Err(Error::Conflict);
            }
            match record.state {
                ResultState::Closed { .. } => return Ok(json!({"status":"closed"})),
                ResultState::Unavailable { reason } => return Ok(unavailable(reason)),
                _ => {}
            }
            if let Err(reason) = resolved {
                let mut instances = self.desktop.mcp_apps.instances.read().unwrap().clone();
                let affected = record.source_key.clone();
                for record in operations
                    .values_mut()
                    .filter(|record| record.source_key == affected)
                {
                    if let ResultState::Open { instance_id } = &record.state {
                        instances.remove(instance_id);
                    }
                    if matches!(
                        record.state,
                        ResultState::Preparing | ResultState::Open { .. }
                    ) {
                        record.state = ResultState::Unavailable { reason };
                    }
                }
                self.app_commit(instances, operations).await?;
                return Ok(unavailable(reason));
            }
        } else {
            if operations.len() >= 1024 {
                return Ok(unavailable(ResultUnavailable::CapacityReached));
            }
            let state = match &resolved {
                Err(reason) => ResultState::Unavailable { reason: *reason },
                Ok(_) => operations
                    .values()
                    .find(|record| {
                        record.source_key == source_key
                            && matches!(
                                record.state,
                                ResultState::Preparing | ResultState::Open { .. }
                            )
                    })
                    .map(|record| record.state.clone())
                    .unwrap_or(ResultState::Preparing),
            };
            let launch = matches!(state, ResultState::Preparing)
                && !operations.values().any(|record| {
                    record.source_key == source_key
                        && matches!(record.state, ResultState::Preparing)
                });
            let record = ResultOperation {
                identity: identity.clone(),
                request_id: input.request_id.clone(),
                digest: request_digest,
                source,
                source_key: source_key.clone(),
                plugin_id: resolved
                    .as_ref()
                    .map(|saved| saved.provenance.plugin_id.clone())
                    .unwrap_or_default(),
                state,
            };
            let mut terminal_budget = record.clone();
            terminal_budget.state = ResultState::Closed {
                instance_id: "x".repeat(64),
                generation: u64::MAX,
            };
            if serde_json::to_vec(&terminal_budget).map_err(invalid)?.len() > 1024 {
                return Err(invalid("result receipt exceeds budget"));
            }
            operations.insert(request_key.clone(), record);
            let instances = self.desktop.mcp_apps.instances.read().unwrap().clone();
            if !self.app_file_fits(&instances, &operations)? {
                return Ok(unavailable(ResultUnavailable::CapacityReached));
            }
            self.app_commit(instances, operations).await?;
            if let Err(reason) = resolved {
                return Ok(unavailable(reason));
            }
            if launch {
                let saved = resolved.map_err(|_| invalid("result source unavailable"))?;
                let initial_result = saved.result.clone();
                let engine = self.clone();
                let work_key = source_key.clone();
                tokio::spawn(async move {
                    if let Err(error) = engine
                        .prepare_saved_result(
                            identity,
                            tool_host_id,
                            input,
                            work_key.clone(),
                            saved,
                        )
                        .await
                    {
                        engine
                            .desktop
                            .mcp_apps
                            .result_failures
                            .write()
                            .unwrap()
                            .insert(work_key, error.to_string());
                        engine.desktop.mcp_apps.result_changed.notify_waiters();
                    }
                });
                drop(_guard);
                return self
                    .wait_result_operation(&request_key, &initial_result)
                    .await;
            }
        }
        let saved = resolved.map_err(|_| invalid("result source unavailable"))?;
        drop(_guard);
        self.wait_result_operation(&request_key, &saved.result)
            .await
    }
    async fn wait_result_operation(&self, key: &str, initial_result: &Value) -> Result<Value> {
        loop {
            let changed = self.desktop.mcp_apps.result_changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let guard = self.desktop.mcp_apps.mutation.lock().await;
            let record = self
                .desktop
                .mcp_apps
                .result_operations
                .read()
                .unwrap()
                .get(key)
                .cloned()
                .ok_or(Error::NotFound)?;
            match record.state {
                ResultState::Closed { .. } => return Ok(json!({"status":"closed"})),
                ResultState::Unavailable { reason } => return Ok(unavailable(reason)),
                ResultState::Open { instance_id } => {
                    let saved = self
                        .desktop
                        .mcp_apps
                        .instances
                        .read()
                        .unwrap()
                        .get(&instance_id)
                        .cloned()
                        .ok_or(Error::NotFound)?;
                    return Ok(
                        json!({"status":"open","instance":{"instanceId":saved.instance_id,"serverId":saved.server_id,"generation":saved.generation,"toolMetadata":saved.metadata,"resource":saved.resource,"initialArguments":saved.arguments,"initialResult":initial_result,"hostContext":{"threadId":saved.thread_id,"modelContext":saved.context}}}),
                    );
                }
                ResultState::Preparing => {
                    if let Some(error) = self
                        .desktop
                        .mcp_apps
                        .result_failures
                        .read()
                        .unwrap()
                        .get(&record.source_key)
                    {
                        return Err(invalid(format!(
                            "result preparation unresolved; retain the original requestId: {error}"
                        )));
                    }
                    drop(guard);
                    changed.await;
                }
            }
        }
    }
    async fn prepare_saved_result(
        self: &Arc<Self>,
        identity: String,
        tool_host_id: Option<String>,
        input: OpenFromResult,
        source_key: String,
        saved: SavedResult,
    ) -> Result<()> {
        let uri = tool_uri(&saved.metadata)
            .ok_or_else(|| invalid("missing App resource"))?
            .to_owned();
        let resource = self
            .app_read_resource(&identity, &input.thread_id, None, &saved.server, &uri)
            .await
            .map_err(|_| ResultUnavailable::ResourceReadFailed)
            .and_then(|read| app_resource(&read, &uri));
        let _guard = self.desktop.mcp_apps.mutation.lock().await;
        let mut operations = self
            .desktop
            .mcp_apps
            .result_operations
            .read()
            .unwrap()
            .clone();
        if !operations.values().any(|record| {
            record.source_key == source_key && matches!(record.state, ResultState::Preparing)
        }) {
            return Ok(());
        }
        let target = self.raw_cell(&input.thread_id).await.ok();
        let target_state = match &target {
            Some(cell) => Some(cell.state.lock().await),
            None => None,
        };
        let resource = match resource {
            Ok(resource) => match self.result_source_server(&saved.provenance).await {
                Ok(_) => match (&target, &target_state) {
                    (Some(cell), Some(state))
                        if state.thread.cwd == saved.provenance.cwd
                            && self.ensure_hook_session_open(cell, &state.thread).is_ok()
                            && !desktop(&state.thread).configuration.read_only =>
                    {
                        Ok(resource)
                    }
                    _ => Err(ResultUnavailable::SourceUnavailable),
                },
                Err(reason) => Err(reason),
            },
            Err(reason) => Err(reason),
        };
        let mut instances = self.desktop.mcp_apps.instances.read().unwrap().clone();
        let state = match resource {
            Ok(resource) => {
                let instance_id = id();
                let instance = Instance {
                    tool_host_id,
                    page_tools_retired: false,
                    runtime_epoch: self.desktop.mcp_apps.runtime_epoch.clone(),
                    instance_id: instance_id.clone(),
                    identity,
                    thread_id: input.thread_id,
                    cwd: saved.provenance.cwd,
                    plugin: saved.provenance.plugin_id,
                    digest: saved.provenance.installed_digest,
                    server_id: saved.provenance.server_id,
                    generation: saved.provenance.generation,
                    tool_name: saved.tool_name,
                    request_id: input.request_id,
                    request_digest: source_key.clone(),
                    resource,
                    metadata: saved.metadata,
                    arguments: saved.arguments,
                    context: Value::Null,
                    file_resource: None,
                };
                instances.insert(instance_id.clone(), instance);
                ResultState::Open { instance_id }
            }
            Err(reason) => ResultState::Unavailable { reason },
        };
        for record in operations.values_mut().filter(|record| {
            record.source_key == source_key && matches!(record.state, ResultState::Preparing)
        }) {
            record.state = state.clone();
        }
        if !self.app_file_fits(&instances, &operations)? {
            if let ResultState::Open { instance_id } = &state {
                instances.remove(instance_id);
            }
            for record in operations.values_mut().filter(|record| {
                record.source_key == source_key && matches!(record.state, ResultState::Open { .. })
            }) {
                record.state = ResultState::Unavailable {
                    reason: ResultUnavailable::CapacityReached,
                };
            }
        }
        self.app_commit(instances, operations).await
    }
}

impl Engine {
    pub(super) async fn close_thread_apps(self: &Arc<Self>, thread_id: &str) -> Result<()> {
        for owner in self.desktop.mcp_apps.calls.lock().await.values() {
            if owner.thread == thread_id {
                owner.cancellation.cancel();
            }
        }
        let instances: Vec<_> = self
            .desktop
            .mcp_apps
            .instances
            .read()
            .unwrap()
            .values()
            .filter(|instance| instance.thread_id == thread_id)
            .cloned()
            .collect();
        for instance in instances {
            self.mcp_app_close(
                instance.identity,
                instance.thread_id,
                instance.instance_id,
                instance.generation,
            )
            .await?;
        }
        while self
            .desktop
            .mcp_apps
            .calls
            .lock()
            .await
            .values()
            .any(|owner| owner.thread == thread_id)
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        Ok(())
    }
}
