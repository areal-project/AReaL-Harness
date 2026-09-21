//! 扩展路由只校验和投影；权威状态与提交边界由 Engine 持有。
use super::*;
use areal_protocol::desktop::*;

pub(crate) const METHODS: &[&str] = &[
    "areal/provider/probe",
    "areal/workflow/list",
    "areal/workflow/read",
    "areal/workflow/start",
    "areal/thread/archive",
    "areal/blob/release",
    "areal/server/gc",
    "areal/context/read",
    "areal/context/compact",
    "areal/agent/wait",
    "areal/server/status",
    "areal/server/drain",
    "areal/model/list",
    "areal/mcp/list",
    "areal/mcp/read",
    "areal/mcp/configure",
    "areal/mcp/connect",
    "areal/mcp/disconnect",
    "areal/thread/start",
    "areal/thread/configure",
    "areal/thread/inspect",
    "areal/profile/list",
    "areal/profile/read",
    "areal/skill/list",
    "areal/skill/read",
    "areal/plan/read",
    "areal/plan/update",
    "areal/interaction/list",
    "areal/interaction/respond",
    "areal/provider/list",
    "areal/provider/read",
    "areal/provider/upsert",
    "areal/provider/remove",
    "areal/turn/start",
    "areal/turn/enqueue",
    "areal/queue/list",
    "areal/queue/update",
    "areal/queue/remove",
    "areal/queue/reorder",
    "areal/queue/pause",
    "areal/queue/resume",
    "areal/request/read",
];
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SkillRead {
    thread_id: String,
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

pub(crate) async fn dispatch(
    engine: &Arc<Engine>,
    identity: &str,
    method: &str,
    mut params: Value,
) -> Result<Value, RpcError> {
    let mutation = matches!(
        method,
        "areal/thread/configure"
            | "areal/plan/update"
            | "areal/provider/upsert"
            | "areal/provider/remove"
            | "areal/mcp/configure"
            | "areal/mcp/connect"
            | "areal/mcp/disconnect"
            | "areal/queue/update"
            | "areal/queue/remove"
            | "areal/queue/reorder"
            | "areal/queue/pause"
            | "areal/queue/resume"
            | "areal/thread/archive"
            | "areal/blob/release"
    );
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
        if let Some(error) = reply.get("error") {
            return Err(RpcError {
                code: error["code"].as_i64().unwrap_or(-32602),
                message: error["message"]
                    .as_str()
                    .unwrap_or("management operation failed")
                    .into(),
            });
        }
        return Ok(reply["result"].clone());
    }
    dispatch_inner(engine, identity, method, params).await
}

async fn dispatch_inner(
    engine: &Arc<Engine>,
    identity: &str,
    method: &str,
    params: Value,
) -> Result<Value, RpcError> {
    let result = match method {
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
            engine.context_compact(p.thread_id).await
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
            Ok(engine.model_catalog())
        }
        "areal/server/drain" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Drain {
                strategy: String,
                timeout_ms: u64,
            }
            let p: Drain = parse(params)?;
            engine.drain(p.strategy, p.timeout_ms).await
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
            let p: ThreadId = parse(params)?;
            engine.skills(&p.thread_id).await
        }
        "areal/skill/read" => {
            let p: SkillRead = parse(params)?;
            engine
                .read_skill(
                    &p.thread_id,
                    p.skill,
                    p.resource.as_deref().unwrap_or("SKILL.md"),
                    p.offset.unwrap_or(0),
                    p.max_bytes.unwrap_or(8192),
                )
                .await
        }
        "areal/plan/read" => {
            let p: ThreadId = parse(params)?;
            engine.plan(&p.thread_id).await.map(|p| json!(p))
        }
        "areal/plan/update" => engine.update_plan(parse(params)?).await.map(|p| json!(p)),
        "areal/thread/configure" => engine
            .configure_thread(parse(params)?)
            .await
            .map(|c| json!(c)),
        "areal/thread/inspect" => {
            let p: ThreadId = parse(params)?;
            engine.inspect(&p.thread_id).await
        }
        "areal/interaction/list" => {
            let p: ThreadId = parse(params)?;
            engine.interactions(&p.thread_id).await
        }
        "areal/interaction/respond" => engine.respond(parse(params)?).await,
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
        "areal/turn/start" | "areal/turn/enqueue" => {
            engine
                .start_durable(
                    identity.into(),
                    parse(params)?,
                    method == "areal/turn/enqueue",
                )
                .await
        }
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
            if let Some(thread) = p.thread_id {
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
