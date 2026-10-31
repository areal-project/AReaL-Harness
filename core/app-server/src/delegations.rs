//! 统一委派 RPC 与长等待共用有界并发槽，权限由连接入口校验。
use super::*;
pub(crate) const METHODS: &[&str] = &[
    "areal/agent/delegate",
    "areal/execution/list",
    "areal/execution/read",
    "areal/execution/trace",
    "areal/execution/traceResult",
    "areal/execution/wait",
    "areal/execution/cancel",
    "areal/execution/apply",
    "areal/execution/artifact",
];
pub(crate) async fn dispatch(
    engine: &Arc<Engine>,
    method: &str,
    params: Value,
) -> Result<Value, RpcError> {
    match method {
        "areal/execution/traceResult" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Read {
                thread_id: String,
                execution_id: String,
                worker_thread_id: String,
                uri: String,
            }
            let p: Read = parse(params)?;
            engine
                .execution_trace_result(&p.thread_id, &p.execution_id, &p.worker_thread_id, &p.uri)
                .await
                .map(|bytes| json!({"bytes":bytes}))
                .map_err(map_error)
        }
        "areal/execution/trace" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Trace {
                thread_id: String,
                execution_id: Option<String>,
                worker_thread_id: Option<String>,
                cursor: Option<String>,
            }
            let p: Trace = parse(params)?;
            engine
                .execution_trace(
                    &p.thread_id,
                    p.execution_id.as_deref(),
                    p.worker_thread_id.as_deref(),
                    p.cursor,
                )
                .await
                .map_err(map_error)
        }
        "areal/agent/delegate" => {
            let request: areal_protocol::delegation::DelegationRequest = parse(params)?;
            engine.delegate(request).await.map_err(map_error)
        }
        "areal/execution/list" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct List {
                parent_thread_id: String,
                #[serde(default)]
                offset: usize,
                limit: Option<usize>,
            }
            let p: List = parse(params)?;
            engine
                .execution_list(&p.parent_thread_id, p.offset, p.limit.unwrap_or(50))
                .await
                .map_err(map_error)
        }
        "areal/execution/artifact" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Artifact {
                parent_thread_id: String,
                execution_id: String,
                path: Option<String>,
                #[serde(default)]
                offset: usize,
            }
            let p: Artifact = parse(params)?;
            engine
                .execution_artifact(&p.parent_thread_id, &p.execution_id, p.path, p.offset)
                .await
                .map_err(map_error)
        }
        "areal/execution/read"
        | "areal/execution/wait"
        | "areal/execution/cancel"
        | "areal/execution/apply" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Target {
                parent_thread_id: String,
                execution_id: String,
                timeout_ms: Option<u64>,
                mode: Option<String>,
                offset: Option<usize>,
            }
            let p: Target = parse(params)?;
            if p.offset.is_some() && method != "areal/execution/read" {
                return Err(RpcError::invalid("offset is only valid for execution/read"));
            }
            if p.timeout_ms.is_some() && method != "areal/execution/wait" {
                return Err(RpcError::invalid(
                    "timeoutMs is only valid for execution/wait",
                ));
            }
            if p.mode.is_some() && method != "areal/execution/cancel" {
                return Err(RpcError::invalid("mode is only valid for execution/cancel"));
            }
            if p.mode
                .as_deref()
                .is_some_and(|mode| !matches!(mode, "graceful" | "force"))
            {
                return Err(RpcError::invalid("invalid cancellation mode"));
            }
            match method {
                "areal/execution/read" => {
                    engine
                        .execution_read_page(
                            &p.parent_thread_id,
                            &p.execution_id,
                            p.offset.unwrap_or(0),
                        )
                        .await
                }
                "areal/execution/wait" => {
                    engine
                        .execution_wait(
                            &p.parent_thread_id,
                            &p.execution_id,
                            p.timeout_ms.unwrap_or(10000),
                        )
                        .await
                }
                "areal/execution/cancel" => {
                    engine
                        .execution_cancel(
                            &p.parent_thread_id,
                            &p.execution_id,
                            p.mode.as_deref() == Some("force"),
                        )
                        .await
                }
                _ => {
                    engine
                        .execution_apply(&p.parent_thread_id, &p.execution_id)
                        .await
                }
            }
            .map_err(map_error)
        }
        _ => Err(RpcError::method()),
    }
}
