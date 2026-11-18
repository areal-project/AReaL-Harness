//! 普通 MCP 工具、Hook、扩展与表单共享原调用身份，不持有页面运行状态。
use super::*;
#[path = "form_resources.rs"]
mod form_resources;
use crate::model::ToolCall;
use areal_protocol::ToolOutcome;

#[derive(Clone)]
pub(crate) enum CallOwnerScope {
    Tool,
    Hook,
    CompactionHook { activation: String },
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
}
struct Form {
    owner: CallOwner,
    request: areal_mcp::ElicitationRequest,
}
pub(crate) struct Manager {
    settings: std::sync::RwLock<BTreeMap<(String, String, String, u64), Value>>,
    pub(crate) calls: Mutex<BTreeMap<(String, u64), CallOwner>>,
    forms: Mutex<BTreeMap<String, Form>>,
    uploads: Mutex<form_resources::Uploads>,
}
impl Manager {
    pub fn open(root: &Path) -> anyhow::Result<Self> {
        match std::fs::remove_dir_all(root.join("desktop/mcp-form-uploads")) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        Ok(Self {
            settings: Default::default(),
            calls: Default::default(),
            forms: Default::default(),
            uploads: Mutex::new(form_resources::Uploads::default()),
        })
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
    async fn mcp_interaction_scope(&self, thread: &str) -> Result<Arc<Cell>> {
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
            return Err(invalid(
                "MCP interaction unavailable in this execution scope",
            ));
        }
        drop(state);
        Ok(cell)
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
        self.mcp_interaction_scope(&thread_id).await?;
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
                    .mcp_interactions
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
                    .mcp_interactions
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
            .extension_tool_turn(
                identity,
                thread_id,
                server_id,
                expected_generation,
                tool.definition.name.clone(),
                args,
                request_id,
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
                .mcp_interactions
                .settings
                .write()
                .unwrap()
                .insert(settings_key, settings);
        }
        Ok(result)
    }
    #[allow(clippy::too_many_arguments)]
    async fn extension_tool_turn(
        self: &Arc<Self>,
        identity: String,
        thread_id: String,
        server_id: String,
        generation: u64,
        tool_name: String,
        arguments: Value,
        request_id: String,
    ) -> Result<Value> {
        let cell = self.mcp_interaction_scope(&thread_id).await?;
        let (owner, _) = self.plugin_server(&server_id, generation).await?;
        let tool = owner
            .tools
            .iter()
            .find(|t| t.server_name() == server_id && t.definition.name == tool_name)
            .cloned()
            .ok_or(Error::NotFound)?;
        if !tool.is_app_visible() {
            return Err(invalid("extension tool is not App-visible"));
        }
        if !arguments.is_object() {
            return Err(invalid("tool arguments must be an object"));
        }
        let hash = digest(
            &json!({"server":server_id,"generation":generation,"tool":tool_name,"arguments":arguments,"instance":null,"fileResource":null}),
        )?;
        // 已持久化扩展调用沿原命名空间与摘要查询，不能因移除页面而重放。
        let method = "areal/mcp/app/tool";
        let _gate = self.desktop.lifecycle.gate.lock().await;
        let mut state = cell.state.lock().await;
        let data = desktop(&state.thread);
        let turn_id = if let Some(previous) = receipt(&data, &identity, &request_id, method, &hash)?
        {
            previous["turnId"]
                .as_str()
                .ok_or_else(|| invalid("invalid saved MCP extension receipt"))?
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
            let (mut candidate, turn) = self.prepare_extension_tool_turn(
                &state.thread,
                format!("MCP extension tool request: {}", tool.original_name()),
            )?;
            let permit = self.reserve_active_turn()?;
            remember(
                candidate.desktop.get_or_insert_with(Default::default),
                &identity,
                &request_id,
                method,
                hash,
                json!({"turnId":turn.id}),
            );
            self.persist(&candidate).await?;
            state.thread = candidate;
            let mut args = arguments;
            if let Some(object) = args.as_object_mut() {
                object.remove("_meta");
            } else {
                return Err(invalid("tool arguments must be an object"));
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
                (Some(call), None),
            );
            // 扩展入口按实时 Store 检查撤权，冻结的工具不恢复已撤销权限。
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
            .ok_or_else(|| {
                invalid("accepted MCP extension turn is unavailable; refusing replay")
            })?;
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
                "accepted MCP extension turn did not produce a tool result; refusing replay",
            ));
        };
        if outcome == ToolOutcome::Unknown {
            return Err(invalid(
                "MCP extension tool result UNKNOWN; inspect and acknowledge before another turn",
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
        Err(invalid(
            "MCP extension result snapshot unavailable; refusing replay",
        ))
    }
    async fn validate_mcp_owner(&self, owner: &CallOwner) -> Result<()> {
        if owner.cancellation.is_cancelled() {
            return Err(invalid("MCP caller ended"));
        }
        let cell = self.cell(&owner.thread).await?;
        let state = cell.state.lock().await;
        match &owner.scope {
            CallOwnerScope::CompactionHook { activation } => {
                if !state.compacting
                    || state.compaction_owner.as_ref().is_none_or(|current| {
                        current.token != *activation || current.cancellation.is_cancelled()
                    })
                {
                    return Err(invalid("MCP hook compaction owner ended"));
                }
            }
            CallOwnerScope::Tool | CallOwnerScope::Hook => {
                if state
                    .active
                    .as_ref()
                    .is_none_or(|active| active.id != owner.turn)
                {
                    return Err(invalid("MCP caller turn ended"));
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
        owner.scope = CallOwnerScope::Hook;
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
                    .validate_mcp_owner(&owner)
                    .await
                    .map_err(|e| anyhow::anyhow!(e.to_string()))
            })
        })
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
        Ok(CallOwner {
            token: id(),
            scope: CallOwnerScope::Tool,
            cancellation: self.shutdown.child_token(),
            identity,
            thread: cell.id.clone(),
            turn,
            call: call.id.clone(),
        })
    }
    pub(super) fn spawn_mcp_forms(
        self: &Arc<Self>,
        mut receiver: tokio::sync::mpsc::Receiver<areal_mcp::ElicitationRequest>,
    ) {
        let weak = Arc::downgrade(self);
        let cancel = self.shutdown.clone();
        self.tasks.spawn(async move{loop{let request=tokio::select!{_=cancel.cancelled()=>break,r=receiver.recv()=>match r{Some(r)=>r,None=>break}};let Some(engine)=weak.upgrade()else{break;};let owner=engine.desktop.mcp_interactions.calls.lock().await.get(&(request.server.clone(),request.generation)).cloned();
            if !form_supported(&request.params["requestedSchema"]){let _=request.respond(json!({"action":"decline"}));continue;}
            if let Some(owner)=owner.filter(|o|!o.identity.is_empty() && !o.cancellation.is_cancelled() && request.owner.as_ref().is_none_or(|token|token==&o.token)){let request_id=id();if let Ok(cell)=engine.cell(&owner.thread).await{cell.emit("areal/mcp/form/requested",json!({"threadId":owner.thread,"requestId":request_id,"serverId":request.server,"generation":request.generation}));}engine.desktop.mcp_interactions.forms.lock().await.insert(request_id,Form{owner,request});}else{let _=request.respond(json!({"action":"cancel"}));}
        }});
    }
    pub async fn mcp_forms_list(&self, thread_id: String) -> Result<Value> {
        self.mcp_interaction_scope(&thread_id).await?;
        let mut forms = self.desktop.mcp_interactions.forms.lock().await;
        forms.retain(|_, f| {
            !f.request.cancellation.is_cancelled() && !f.owner.cancellation.is_cancelled()
        });
        Ok(
            json!({"data":forms.iter().filter(|(_,f)|f.owner.thread==thread_id).map(|(id,f)|json!({"requestId":id,"threadId":thread_id,"turnId":f.owner.turn,"callId":f.owner.call,"instanceId":null,"serverId":f.request.server,"generation":f.request.generation,"message":f.request.params["message"],"requestedSchema":f.request.params["requestedSchema"]})).collect::<Vec<_>>()}),
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
        self.mcp_interaction_scope(&thread_id).await?;
        let mut forms = self.desktop.mcp_interactions.forms.lock().await;
        let form = forms.get(&request_id).ok_or(Error::NotFound)?;
        if form.owner.identity != identity
            || form.owner.thread != thread_id
            || form.request.cancellation.is_cancelled()
        {
            return Err(invalid("form owner mismatch or request expired"));
        }
        self.validate_mcp_owner(&form.owner).await?;
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
    fn prepare_extension_tool_turn(&self, thread: &Thread, text: String) -> Result<(Thread, Turn)> {
        let mut candidate = thread.clone();
        let configuration = self.freeze_configuration(desktop(thread).configuration);
        let turn = Turn {
            process_receipts: Vec::new(),
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
                created_at: None,
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
                "insufficient history for MCP extension tool turn".into(),
            ));
        }
        Ok((candidate, turn))
    }
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
    pub async fn mcp_form_preview(
        self: &Arc<Self>,
        identity: String,
        thread_id: String,
        request_id: String,
        target: Value,
    ) -> Result<Value> {
        self.mcp_interaction_scope(&thread_id).await?;
        let (server_id, generation, cancellation, call_owner) = {
            let forms = self.desktop.mcp_interactions.forms.lock().await;
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
        let (_, server) = self.plugin_server(&server_id, generation).await?;
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
            _ => Err(invalid("unsupported preview target")),
        }
    }

    pub(super) fn revoke_mcp_interaction_settings(
        &self,
        generations: &std::collections::BTreeSet<u64>,
    ) {
        self.desktop
            .mcp_interactions
            .settings
            .write()
            .unwrap()
            .retain(|(_, _, _, generation), _| !generations.contains(generation));
    }
    pub(super) async fn close_thread_mcp_interactions(
        self: &Arc<Self>,
        thread: &str,
    ) -> Result<()> {
        for owner in self.desktop.mcp_interactions.calls.lock().await.values() {
            if owner.thread == thread {
                owner.cancellation.cancel();
            }
        }
        while self
            .desktop
            .mcp_interactions
            .calls
            .lock()
            .await
            .values()
            .any(|owner| owner.thread == thread)
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        Ok(())
    }
}
