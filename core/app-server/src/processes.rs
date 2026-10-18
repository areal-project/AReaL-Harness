use super::*;
use areal_protocol::desktop::ProcessStart;

pub(crate) const METHODS: &[&str] = &[
    "areal/process/acknowledgeCleanup",
    "areal/process/start",
    "areal/process/list",
    "areal/process/get",
    "areal/process/read",
    "areal/process/write",
    "areal/process/resize",
    "areal/process/closeStdin",
    "areal/process/terminate",
    "areal/process/wait",
    "areal/thread/closeResources",
];
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Target {
    thread_id: String,
    id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Read {
    thread_id: String,
    id: String,
    after: Option<String>,
    max_bytes: Option<usize>,
    wait_ms: Option<u64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Wait {
    thread_id: String,
    id: String,
    timeout_ms: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Control {
    thread_id: String,
    id: String,
    request_id: String,
    data_base64: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
}
pub(crate) async fn dispatch(
    engine: &Arc<Engine>,
    identity: &str,
    method: &str,
    params: Value,
) -> Result<Value, RpcError> {
    let result = match method {
        "areal/process/acknowledgeCleanup" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Attestation {
                thread_id: String,
                id: String,
                note: String,
            }
            let p: Attestation = parse(params)?;
            engine
                .acknowledge_process_cleanup(identity.into(), p.thread_id, p.id, p.note)
                .await
        }
        "areal/process/start" => {
            let p: ProcessStart = parse(params)?;
            engine.process_start(identity.into(), p).await
        }
        "areal/process/list" => {
            let p: ThreadId = parse(params)?;
            engine.processes(&p.thread_id).await
        }
        "areal/process/get" => {
            let p: Target = parse(params)?;
            engine.process_get(&p.thread_id, &p.id).await
        }
        "areal/process/read" => {
            let p: Read = parse(params)?;
            engine
                .process_read(
                    &p.thread_id,
                    &p.id,
                    p.after,
                    p.max_bytes.unwrap_or(65536),
                    p.wait_ms.unwrap_or(0),
                )
                .await
        }
        "areal/process/wait" => {
            let p: Wait = parse(params)?;
            engine.process_wait(&p.thread_id, &p.id, p.timeout_ms).await
        }
        "areal/thread/closeResources" => {
            let p: ThreadId = parse(params)?;
            engine.close_resources(p.thread_id).await
        }
        "areal/process/write"
        | "areal/process/resize"
        | "areal/process/closeStdin"
        | "areal/process/terminate" => {
            let p: Control = parse(params.clone())?;
            let action = method.rsplit('/').next().unwrap();
            let valid = match action {
                "write" => p.data_base64.is_some() && p.cols.is_none() && p.rows.is_none(),
                "resize" => {
                    p.data_base64.is_none()
                        && p.cols.is_some_and(|n| n > 0)
                        && p.rows.is_some_and(|n| n > 0)
                }
                _ => p.data_base64.is_none() && p.cols.is_none() && p.rows.is_none(),
            };
            if !valid {
                return Err(RpcError::invalid(
                    "process control fields do not match operation",
                ));
            }
            engine
                .process_control(
                    identity.into(),
                    p.thread_id,
                    p.id,
                    p.request_id,
                    action.into(),
                    params,
                )
                .await
        }
        _ => return Err(RpcError::method()),
    };
    result.map_err(map_error)
}
