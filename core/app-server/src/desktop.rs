//! 扩展路由只校验和投影；权威状态与提交边界由 Engine 持有。
use super::*;
use areal_protocol::desktop::*;

areal_protocol::method_catalog! {
    "areal/side/start" => Mutation, Thread;
    "areal/side/create" => Mutation, Thread;
    "areal/side/close" => Mutation, Thread;
    "areal/side/context/read" => Read;
    "areal/thread/fork" => Mutation, Thread;
    "areal/conversation/history" => Read;
    "areal/conversation/list" => Read;
    "areal/conversation/unarchive" => Mutation, Management;
    "areal/permissions/read" => Read;
    "areal/permissions/forget" => Mutation;
    "areal/goal/get" => Read;
    "areal/goal/create" => Mutation;
    "areal/goal/update" => Mutation;
    "areal/goal/pause" => Mutation;
    "areal/goal/resume" => Mutation;
    "areal/goal/clear" => Mutation;
    "areal/provider/probe" => Mutation;
    "areal/workflow/list" => Read;
    "areal/workflow/read" => Read;
    "areal/workflow/start" => Mutation;
    "areal/thread/archive" => Mutation, Management;
    "areal/blob/release" => Mutation, Management;
    "areal/server/gc" => Mutation;
    "areal/context/read" => Read;
    "areal/context/compact" => Mutation;
    "areal/agent/wait" => Read;
    "areal/server/status" => Read;
    "areal/server/drain" => Mutation;
    "areal/model/list" => Read;
    "areal/mcp/list" => Read;
    "areal/mcp/read" => Read;
    "areal/mcp/configure" => Mutation, Management;
    "areal/mcp/connect" => Mutation, Management;
    "areal/mcp/disconnect" => Mutation, Management;
    "areal/plugin/list" => Read;
    "areal/plugin/read" => Read;
    "areal/plugin/importArchive" => Mutation, Management;
    "areal/plugin/install" => Mutation, Management;
    "areal/plugin/configure" => Mutation, Management;
    "areal/plugin/component/configure" => Mutation, Management;
    "areal/plugin/uninstall" => Mutation, Management;
    "areal/plugin/setup" => Mutation, Management;
    "areal/marketplace/add" => Mutation, Management;
    "areal/marketplace/addGit" => Mutation, Management;
    "areal/marketplace/remove" => Mutation, Management;
    "areal/marketplace/update" => Mutation, Management;
    "areal/plugin/resolve" => Mutation, Management;
    "areal/thread/start" => Mutation, Thread;
    "areal/thread/configure" => Mutation, Thread;
    "areal/thread/prediction" => Mutation;
    "areal/thread/inspect" => Read;
    "areal/profile/list" => Read;
    "areal/profile/read" => Read;
    "areal/skill/list" => Read;
    "areal/skill/read" => Read;
    "areal/plan/read" => Read;
    "areal/plan/update" => Mutation, Management;
    "areal/interaction/list" => Read;
    "areal/interaction/respond" => Mutation;
    "areal/provider/list" => Read;
    "areal/provider/read" => Read;
    "areal/provider/upsert" => Mutation, Management;
    "areal/provider/remove" => Mutation, Management;
    "areal/turn/start" => Mutation, Thread;
    "areal/turn/enqueue" => Mutation, Thread;
    "areal/turn/submit" => Mutation, Thread;
    "areal/queue/list" => Read;
    "areal/queue/steer" => Mutation, Thread;
    "areal/queue/update" => Mutation, Management;
    "areal/queue/remove" => Mutation, Management;
    "areal/queue/reorder" => Mutation, Management;
    "areal/queue/pause" => Mutation, Management;
    "areal/queue/resume" => Mutation, Management;
    "areal/request/read" => Read;
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SkillList {
    thread_id: Option<String>,
    agent_profile: Option<VersionRef>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SkillRead {
    thread_id: Option<String>,
    agent_profile: Option<VersionRef>,
    skill: VersionRef,
    resource: Option<String>,
    offset: Option<usize>,
    max_bytes: Option<usize>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderUpsert {
    provider: Provider,
    expected_revision: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderRemove {
    id: String,
    expected_revision: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Id {
    id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RequestRead {
    creation_admission: Option<CreationAdmission>,
    thread_id: Option<String>,
    request_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueueEdit {
    thread_id: String,
    expected_revision: u64,
    queue_item_id: Option<String>,
    input: Option<Vec<Input>>,
    queue_item_ids: Option<Vec<String>>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogRefreshRequired {
    revision: u64,
    catalog_refresh_required: bool,
}

fn plugin_catalog_mutation_result(catalog: Value) -> areal_engine::Result<Value> {
    let size = serde_json::to_vec(&json!({"result": &catalog}))
        .map_err(|error| Error::Invalid(error.to_string()))?
        .len();
    if size <= Engine::MANAGEMENT_RECEIPT_MAX_BYTES {
        return Ok(catalog);
    }
    let revision = catalog["revision"]
        .as_u64()
        .ok_or_else(|| Error::Invalid("invalid plugin directory revision".into()))?;
    serde_json::to_value(CatalogRefreshRequired {
        revision,
        catalog_refresh_required: true,
    })
    .map_err(|error| Error::Invalid(error.to_string()))
}

pub(crate) async fn dispatch_with_budget(
    engine: &Arc<Engine>,
    identity: &str,
    method: &str,
    params: Value,
    overhead: usize,
) -> Result<Value, RpcError> {
    if method == "areal/conversation/history" && params["view"] == "own" {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct OwnHistory {
            thread_id: String,
            view: String,
            cursor: Option<String>,
            max_bytes: Option<usize>,
        }
        let request: OwnHistory = parse(params)?;
        debug_assert_eq!(request.view, "own");
        let budget = super::bounded_history_budget(request.max_bytes, overhead)?;
        return engine
            .own_history(identity, &request.thread_id, request.cursor, budget)
            .await
            .map_err(map_error);
    }
    dispatch(engine, identity, method, params).await
}

pub(crate) async fn dispatch(
    engine: &Arc<Engine>,
    identity: &str,
    method: &str,
    mut params: Value,
) -> Result<Value, RpcError> {
    #[cfg(test)]
    crate::rpc_isolation_tests::pause(&mut params).await;
    if method == "areal/thread/configure" && params.get("requestId").is_some() {
        let request = params["requestId"].as_str().ok_or_else(|| {
            rejected(
                RpcError::invalid("requestId must be a string"),
                "INVALID_REQUEST",
            )
        })?;
        let mut legacy_params = params.clone();
        // 旧日志摘要来自移除 requestId 的原始 JSON，重新序列化配置会改变缺省字段。
        legacy_params.as_object_mut().unwrap().remove("requestId");
        if let Some(reply) = engine
            .management_submission_result(identity, request, method, &legacy_params)
            .await
            .map_err(map_error)?
        {
            return management_reply(reply);
        }
    }
    let mutation = matches!(
        method,
        "areal/plan/update"
            | "areal/provider/upsert"
            | "areal/provider/remove"
            | "areal/mcp/configure"
            | "areal/mcp/connect"
            | "areal/mcp/disconnect"
            | "areal/plugin/importArchive"
            | "areal/plugin/install"
            | "areal/plugin/configure"
            | "areal/plugin/component/configure"
            | "areal/plugin/uninstall"
            | "areal/plugin/setup"
            | "areal/marketplace/add"
            | "areal/marketplace/addGit"
            | "areal/marketplace/remove"
            | "areal/marketplace/update"
            | "areal/plugin/resolve"
            | "areal/queue/update"
            | "areal/queue/steer"
            | "areal/queue/remove"
            | "areal/queue/reorder"
            | "areal/queue/pause"
            | "areal/queue/resume"
            | "areal/thread/archive"
            | "areal/conversation/unarchive"
            | "areal/blob/release"
    );
    if method == "areal/conversation/unarchive"
        && params
            .get("requestId")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
    {
        return Err(RpcError::invalid("requestId is required for unarchive"));
    }
    if mutation
        && (method.starts_with("areal/plugin/") || method.starts_with("areal/marketplace/"))
        && params
            .get("requestId")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
    {
        return Err(RpcError::invalid(
            "requestId is required for plugin mutations",
        ));
    }
    if mutation && params.get("requestId").is_some() {
        let request = params
            .as_object_mut()
            .unwrap()
            .remove("requestId")
            .unwrap()
            .as_str()
            .ok_or_else(|| RpcError::invalid("requestId must be a string"))?
            .to_owned();
        let method = method.to_owned();
        let owner = identity.to_owned();
        let snapshot = params.clone();
        if method == "areal/plugin/setup" || method == "areal/queue/steer" {
            params["requestId"] = json!(request);
        }
        let reply = engine
            .management_submission(
                identity.into(),
                request,
                method.clone(),
                snapshot,
                move |engine| async move {
                    match dispatch_inner(&engine, &owner, &method, params).await {
                        Ok(v) => json!({"result":v}),
                        Err(e) => json!({"error":e}),
                    }
                },
            )
            .await
            .map_err(map_error)?;
        return management_reply(reply);
    }
    dispatch_inner(engine, identity, method, params).await
}

fn management_reply(reply: Value) -> Result<Value, RpcError> {
    if let Some(error) = reply.get("error") {
        return Err(RpcError {
            code: error["code"].as_i64().unwrap_or(-32602),
            message: error["message"]
                .as_str()
                .unwrap_or("management operation failed")
                .into(),
            data: error.get("data").cloned(),
        });
    }
    Ok(reply["result"].clone())
}

pub(crate) async fn create_side(
    engine: &Arc<Engine>,
    identity: &str,
    params: Value,
    host: Option<Arc<dyn areal_engine::tools::DynamicToolHost>>,
) -> Result<Value, RpcError> {
    let request: SideCreate = parse(params)?;
    let request_id = request.request_id.clone();
    let (mut thread, mut turn) = engine
        .side_create(identity.into(), request, host)
        .await
        .map_err(map_error)?;
    thread.turns.clear();
    thread.context_checkpoint = None;
    thread.history_archive = None;
    if let Some(turn) = &mut turn {
        turn.items.clear();
    }
    Ok(json!({"thread":thread,"turn":turn,"requestId":request_id}))
}

async fn dispatch_inner(
    engine: &Arc<Engine>,
    identity: &str,
    method: &str,
    params: Value,
) -> Result<Value, RpcError> {
    let result = match method {
        "areal/side/create" => return create_side(engine, identity, params, None).await,
        "areal/side/close" => engine.side_close(identity.into(), parse(params)?).await,
        "areal/side/start" => {
            let request: SideStart = parse(params)?;
            let request_id = request.request_id.clone();
            match engine.side_start(identity.into(), request).await {
                Ok((mut thread, mut turn)) => {
                    // 创建和同键核对只返回摘要；完整历史仍从权威读取入口恢复。
                    thread.turns.clear();
                    thread.context_checkpoint = None;
                    thread.history_archive = None;
                    turn.items.clear();
                    Ok(json!({"thread":thread,"turn":turn,"requestId":request_id}))
                }
                Err(Error::Conflict) => {
                    return Err(rejected(
                        RpcError {
                            code: -32010,
                            message: "request key conflicts with an existing Side".into(),
                            data: Some(json!({"reason":"REQUEST_CONFLICT","retryable":false})),
                        },
                        "REQUEST_REJECTED",
                    ));
                }
                Err(Error::Invalid(reason))
                    if matches!(
                        reason.as_str(),
                        "SOURCE_KIND_UNSUPPORTED"
                            | "ANCHOR_NOT_FOUND"
                            | "TURN_NOT_TERMINAL"
                            | "HISTORY_UNRESOLVED"
                            | "PROFILE_NOT_SUPPORTED"
                            | "MODEL_CONTEXT_INCOMPATIBLE"
                            | "WORKSPACE_READ_UNAVAILABLE"
                            | "STALE_SELECTION"
                            | "SELECTION_TOO_LARGE"
                    ) =>
                {
                    return Err(rejected(
                        RpcError {
                            code: -32010,
                            message: reason.clone(),
                            data: Some(json!({"reason":reason,"retryable":false})),
                        },
                        "REQUEST_REJECTED",
                    ));
                }
                Err(error) => return Err(map_error(error)),
            }
        }
        "areal/side/context/read" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct ReadContext {
                thread_id: String,
                evidence_ref: Option<String>,
                cursor: Option<String>,
                max_bytes: Option<usize>,
            }
            let p: ReadContext = parse(params)?;
            engine
                .side_context_read(&p.thread_id, p.evidence_ref, p.cursor, p.max_bytes)
                .await
        }
        "areal/thread/fork" => {
            let request: ForkThread = parse(params)?;
            let request_id = request.request_id.clone();
            match engine.fork_thread(identity.into(), request).await {
                Ok(mut thread) => {
                    // 目标之后可能已积累大历史，幂等响应保持与首次创建相同的摘要边界。
                    thread.turns.clear();
                    thread.context_checkpoint = None;
                    thread.history_archive = None;
                    Ok(json!({"thread":thread,"requestId":request_id}))
                }
                Err(Error::Conflict) => {
                    return Err(rejected(
                        RpcError {
                            code: -32010,
                            message: "request key conflicts with an existing Fork".into(),
                            data: Some(json!({"reason":"REQUEST_CONFLICT","retryable":false})),
                        },
                        "REQUEST_REJECTED",
                    ));
                }
                Err(Error::Invalid(reason))
                    if matches!(
                        reason.as_str(),
                        "SOURCE_KIND_UNSUPPORTED"
                            | "ANCHOR_NOT_FOUND"
                            | "TURN_NOT_TERMINAL"
                            | "HISTORY_UNRESOLVED"
                            | "HISTORY_INTEGRITY"
                            | "PROFILE_NOT_SUPPORTED"
                            | "MODEL_CONTEXT_INCOMPATIBLE"
                            | "MODEL_MODALITY_INCOMPATIBLE"
                    ) =>
                {
                    return Err(rejected(
                        RpcError {
                            code: -32010,
                            message: reason.clone(),
                            data: Some(json!({"reason":reason,"retryable":false})),
                        },
                        "REQUEST_REJECTED",
                    ));
                }
                Err(Error::Storage(message))
                    if message.contains("fork snapshot exceeds history limit")
                        || message.contains("history segment exceeds size limit") =>
                {
                    return Err(RpcError {
                        code: -32010,
                        message: "Fork history exceeds the configured snapshot limit".into(),
                        data: Some(json!({"reason":"HISTORY_LIMIT_EXCEEDED","retryable":false})),
                    });
                }
                Err(Error::Exhausted(message))
                    if message.contains("session history limit reached") =>
                {
                    return Err(RpcError {
                        code: -32010,
                        message: "Fork history exceeds the configured session limit".into(),
                        data: Some(json!({"reason":"HISTORY_LIMIT_EXCEEDED","retryable":false})),
                    });
                }
                Err(Error::Storage(message))
                    if message.contains("history segment integrity check failed")
                        || message.contains("fork snapshot") =>
                {
                    return Err(RpcError {
                        code: -32010,
                        message: "Fork source history failed integrity validation".into(),
                        data: Some(json!({"reason":"HISTORY_INTEGRITY","retryable":false})),
                    });
                }
                Err(error) => return Err(map_error(error)),
            }
        }
        "areal/conversation/history" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct ReadHistory {
                thread_id: String,
                view: String,
                cursor: Option<String>,
                max_bytes: Option<usize>,
            }
            let p: ReadHistory = parse(params)?;
            engine
                .conversation_history(&p.thread_id, &p.view, p.cursor, p.max_bytes)
                .await
        }
        "areal/goal/get" => {
            let p: ThreadId = parse(params)?;
            engine.goal_get(&p.thread_id).await
        }
        "areal/goal/create" => engine.goal_create(identity.into(), parse(params)?).await,
        "areal/goal/update" => {
            let p: areal_protocol::goals::GoalUpdate = parse(params)?;
            engine
                .goal_control(identity.into(), "update".into(), p.control.clone(), Some(p))
                .await
        }
        "areal/goal/pause" | "areal/goal/resume" | "areal/goal/clear" => {
            engine
                .goal_control(
                    identity.into(),
                    method.rsplit('/').next().unwrap().into(),
                    parse(params)?,
                    None,
                )
                .await
        }
        "areal/provider/probe" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Probe {
                id: String,
                model: Option<String>,
            }
            let p: Probe = parse(params)?;
            engine.probe_provider(&p.id, p.model).await
        }
        "areal/workflow/list" => {
            let _: ModelList = parse(params)?;
            Ok(engine.workflows())
        }
        "areal/workflow/read" => {
            let p: VersionRef = parse(params)?;
            engine.workflow(&p).map(|w| json!(w))
        }
        "areal/workflow/start" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Start {
                workflow: VersionRef,
                request_id: String,
                workers: Option<usize>,
                #[serde(default)]
                admission: areal_engine::workgroup::Admission,
            }
            let p: Start = parse(params)?;
            engine
                .start_workflow(
                    identity.into(),
                    p.workflow,
                    p.request_id,
                    p.workers,
                    p.admission,
                )
                .await
        }
        "areal/thread/archive" => {
            let p: ThreadId = parse(params)?;
            engine.archive_thread(p.thread_id).await
        }
        "areal/conversation/unarchive" => {
            let p: ThreadId = parse(params)?;
            engine.unarchive_conversation(p.thread_id).await
        }
        "areal/blob/release" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Release {
                thread_id: String,
                uri: String,
            }
            let p: Release = parse(params)?;
            engine.release_upload(p.thread_id, p.uri).await
        }
        "areal/server/gc" => {
            let _: ModelList = parse(params)?;
            engine.garbage_collect().await
        }
        "areal/context/read" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Read {
                thread_id: String,
                offset: Option<usize>,
                limit: Option<usize>,
            }
            let p: Read = parse(params)?;
            engine
                .context_read(&p.thread_id, p.offset.unwrap_or(0), p.limit.unwrap_or(16))
                .await
        }
        "areal/context/compact" => {
            let p: ThreadId = parse(params)?;
            engine
                .context_compact_owned(identity.into(), p.thread_id)
                .await
        }
        "areal/agent/wait" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Wait {
                parent_thread_id: String,
                thread_ids: Vec<String>,
                timeout_ms: Option<u64>,
            }
            let p: Wait = parse(params)?;
            engine
                .wait_children(
                    &p.parent_thread_id,
                    p.thread_ids,
                    p.timeout_ms.unwrap_or(60000),
                )
                .await
        }
        "areal/server/status" => {
            let _: ModelList = parse(params)?;
            Ok(engine.server_status().await)
        }
        "areal/model/list" => {
            let _: ModelList = parse(params)?;
            Ok(engine.model_catalog().await)
        }
        "areal/server/drain" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Drain {
                strategy: String,
                timeout_ms: u64,
                #[serde(default)]
                idle_timeout_ms: Option<u64>,
            }
            let p: Drain = parse(params)?;
            engine
                .drain_with_idle(p.strategy, p.timeout_ms, p.idle_timeout_ms)
                .await
        }
        "areal/plugin/list" => {
            let _: ModelList = parse(params)?;
            engine.plugin_list().await
        }
        "areal/plugin/read" => {
            let p: Id = parse(params)?;
            engine.plugin_read(p.id).await
        }
        "areal/marketplace/add" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Add {
                root: std::path::PathBuf,
                expected_revision: u64,
            }
            let p: Add = parse(params)?;
            engine
                .plugin_add_marketplace(p.root, p.expected_revision)
                .await
                .and_then(plugin_catalog_mutation_result)
        }
        "areal/plugin/resolve" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Resolve {
                id: String,
                expected_revision: u64,
            }
            let p: Resolve = parse(params)?;
            engine.plugin_resolve(p.id, p.expected_revision).await
        }
        "areal/marketplace/addGit" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct AddGit {
                url: String,
                #[serde(default)]
                ref_name: Option<String>,
                #[serde(default)]
                sparse_paths: Vec<String>,
                expected_revision: u64,
            }
            let p: AddGit = parse(params)?;
            engine
                .plugin_add_git_marketplace_sparse(
                    p.url,
                    p.ref_name,
                    p.sparse_paths,
                    p.expected_revision,
                )
                .await
                .and_then(plugin_catalog_mutation_result)
        }
        "areal/marketplace/remove" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Remove {
                root: std::path::PathBuf,
                expected_revision: u64,
            }
            let p: Remove = parse(params)?;
            engine
                .plugin_remove_marketplace(p.root, p.expected_revision)
                .await
                .and_then(plugin_catalog_mutation_result)
        }
        "areal/marketplace/update" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Update {
                expected_revision: u64,
            }
            let p: Update = parse(params)?;
            engine
                .plugin_update_marketplaces(p.expected_revision)
                .await
                .and_then(plugin_catalog_mutation_result)
        }
        "areal/plugin/importArchive" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Import {
                path: std::path::PathBuf,
                expected_revision: u64,
            }
            let p: Import = parse(params)?;
            engine
                .plugin_import_archive(p.path, p.expected_revision)
                .await
        }
        "areal/plugin/install" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Install {
                id: String,
                scope: String,
                expected_revision: u64,
                source: std::path::PathBuf,
                expected_digest: String,
            }
            let p: Install = parse(params)?;
            engine
                .plugin_install(
                    p.id,
                    p.scope,
                    p.expected_revision,
                    p.source,
                    p.expected_digest,
                )
                .await
        }
        "areal/plugin/configure" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Configure {
                id: String,
                scope: String,
                enabled: bool,
                expected_revision: u64,
            }
            let p: Configure = parse(params)?;
            engine
                .plugin_configure(p.id, p.scope, p.enabled, p.expected_revision)
                .await
        }
        "areal/plugin/component/configure" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct ComponentConfigure {
                id: String,
                component: areal_engine::PluginComponentId,
                enabled: bool,
                expected_revision: u64,
                expected_digest: String,
            }
            let p: ComponentConfigure = parse(params)?;
            engine
                .plugin_component_configure(
                    p.id,
                    p.component,
                    p.enabled,
                    p.expected_revision,
                    p.expected_digest,
                )
                .await
        }
        "areal/plugin/uninstall" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Uninstall {
                id: String,
                expected_revision: u64,
            }
            let p: Uninstall = parse(params)?;
            engine
                .plugin_uninstall(p.id, p.expected_revision)
                .await
                .and_then(plugin_catalog_mutation_result)
        }
        "areal/plugin/setup" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Setup {
                id: String,
                #[serde(default)]
                thread_id: Option<String>,
                request_id: String,
            }
            let p: Setup = parse(params)?;
            engine
                .plugin_setup(identity.into(), p.id, p.thread_id, p.request_id)
                .await
        }
        "areal/mcp/list" => {
            let _: ModelList = parse(params)?;
            Ok(engine.mcp_list())
        }
        "areal/mcp/read" => {
            let p: Id = parse(params)?;
            engine.mcp_list()["data"]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["id"] == p.id)
                .cloned()
                .ok_or(Error::NotFound)
        }
        "areal/mcp/configure" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Configure {
                id: String,
                expected_revision: u64,
                config: areal_engine::desktop::McpConfig,
            }
            let p: Configure = parse(params)?;
            engine
                .mcp_configure(p.id, p.expected_revision, p.config)
                .await
        }
        "areal/mcp/connect" | "areal/mcp/disconnect" => {
            let p: ProviderRemove = parse(params)?;
            engine
                .mcp_connection(p.id, p.expected_revision, method == "areal/mcp/connect")
                .await
        }
        "areal/profile/list" => {
            let _: ModelList = parse(params)?;
            Ok(engine.profiles())
        }
        "areal/profile/read" => Ok(json!(engine.profile(&parse(params)?).map_err(map_error)?)),
        "areal/skill/list" => {
            let p: SkillList = parse(params)?;
            match (p.thread_id, p.agent_profile) {
                (Some(thread_id), None) => engine.skills(&thread_id).await,
                (None, Some(profile)) => engine.profile_skills(&profile),
                _ => Err(Error::Invalid("provide threadId or agentProfile".into())),
            }
        }
        "areal/skill/read" => {
            let p: SkillRead = parse(params)?;
            let resource = p.resource.as_deref().unwrap_or("SKILL.md");
            let offset = p.offset.unwrap_or(0);
            let max_bytes = p.max_bytes.unwrap_or(8192);
            match (p.thread_id, p.agent_profile) {
                (Some(thread_id), None) => {
                    engine
                        .read_skill(&thread_id, p.skill, resource, offset, max_bytes)
                        .await
                }
                (None, Some(profile)) => {
                    engine
                        .read_profile_skill(profile, p.skill, resource, offset, max_bytes)
                        .await
                }
                _ => Err(Error::Invalid("provide threadId or agentProfile".into())),
            }
        }
        "areal/plan/read" => {
            let p: ThreadId = parse(params)?;
            engine.plan(&p.thread_id).await.map(|p| json!(p))
        }
        "areal/plan/update" => engine.update_plan(parse(params)?).await.map(|p| json!(p)),
        "areal/thread/prediction" => engine
            .prompt_prediction(parse(params)?)
            .await
            .map(|value| json!(value)),
        "areal/thread/configure" => engine
            .configure_thread_as(identity.into(), parse(params)?)
            .await
            .map_err(atomic_mutation_error)
            .map(|c| json!(c)),
        "areal/thread/inspect" => {
            let p: ThreadId = parse(params)?;
            engine.inspect(&p.thread_id).await
        }
        "areal/interaction/list" => {
            let p: ThreadId = parse(params)?;
            engine.interactions(&p.thread_id).await
        }
        "areal/permissions/read" => {
            let p: ThreadId = parse(params)?;
            engine.permission_read(&p.thread_id).await
        }
        "areal/permissions/forget" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Forget {
                thread_id: String,
                #[serde(default)]
                project: bool,
            }
            let p: Forget = parse(params)?;
            engine.permission_forget(p.thread_id, p.project).await
        }
        "areal/interaction/respond" => engine
            .respond(parse(params)?)
            .await
            .map_err(control_mutation_error),
        "areal/provider/list" => {
            let _: ModelList = parse(params)?;
            Ok(engine.providers())
        }
        "areal/provider/read" => {
            let p: Id = parse(params)?;
            engine.provider(&p.id).map(|p| engine.provider_view(&p))
        }
        "areal/provider/upsert" => {
            let p: ProviderUpsert = parse(params)?;
            engine
                .upsert_provider(p.provider, p.expected_revision)
                .await
                .map(|p| json!(p))
        }
        "areal/provider/remove" => {
            let p: ProviderRemove = parse(params)?;
            engine
                .remove_provider(p.id, p.expected_revision)
                .await
                .map(|()| json!({}))
        }
        // These owners validate before committing the Turn/queue and receipt together.
        // Storage and admitted outcome errors must retain their uncertainty.
        "areal/turn/start" | "areal/turn/enqueue" => engine
            .start_durable(
                identity.into(),
                parse(params)?,
                method == "areal/turn/enqueue",
            )
            .await
            .map_err(atomic_mutation_error),
        "areal/turn/submit" => engine
            .submit_turn(identity.into(), parse(params)?)
            .await
            .map_err(atomic_mutation_error),
        "areal/queue/steer" => engine.steer_queue(identity.into(), parse(params)?).await,
        "areal/queue/list" => {
            let p: ThreadId = parse(params)?;
            engine.queue(&p.thread_id).await.map(|q| json!(q))
        }
        "areal/queue/update"
        | "areal/queue/remove"
        | "areal/queue/reorder"
        | "areal/queue/pause"
        | "areal/queue/resume" => {
            let p: QueueEdit = parse(params.clone())?;
            let action = method.rsplit('/').next().unwrap();
            let valid = match action {
                "update" => {
                    p.queue_item_id.is_some() && p.input.is_some() && p.queue_item_ids.is_none()
                }
                "remove" => {
                    p.queue_item_id.is_some() && p.input.is_none() && p.queue_item_ids.is_none()
                }
                "reorder" => {
                    p.queue_item_id.is_none() && p.input.is_none() && p.queue_item_ids.is_some()
                }
                _ => p.queue_item_id.is_none() && p.input.is_none() && p.queue_item_ids.is_none(),
            };
            if !valid {
                return Err(RpcError::invalid("queue fields do not match operation"));
            }
            engine
                .edit_queue(p.thread_id, p.expected_revision, action.into(), params)
                .await
                .map(|q| json!(q))
        }
        "areal/request/read" => {
            let p: RequestRead = parse(params)?;
            if let Some(original) = p.creation_admission {
                if p.thread_id.is_some() {
                    return Err(RpcError::invalid(
                        "creationAdmission requires unscoped request lookup",
                    ));
                }
                engine
                    .resolve_creation_admission(identity, &p.request_id, original)
                    .await
            } else if let Some(thread) = p.thread_id {
                engine
                    .request_status(identity, &thread, &p.request_id)
                    .await
            } else {
                engine.find_request(identity, &p.request_id).await
            }
        }
        _ => return Err(RpcError::method()),
    };
    result.map_err(map_error)
}
