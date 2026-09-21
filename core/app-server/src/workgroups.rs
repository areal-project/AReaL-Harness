use super::*;
use areal_engine::workgroup::{Plan, service::Start};

pub(super) async fn dispatch(
    engine: Arc<Engine>,
    identity: &str,
    method: &str,
    params: Value,
) -> Result<Value, RpcError> {
    let service = engine
        .workgroups()
        .map_err(|error| RpcError::invalid(error.to_string()))?;
    let result: anyhow::Result<Value> = async {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Target {
            id: String,
        }
        match method {
            "areal/workgroup/policy" => {
                let _: Empty = serde_json::from_value(params)?;
                Ok(json!(service.policy()))
            }
            "areal/workgroup/list" => {
                let _: Empty = serde_json::from_value(params)?;
                Ok(json!({"data":service.list().await}))
            }
            "areal/workgroup/start" => {
                let request: Start = serde_json::from_value(params)?;
                service
                    .start(
                        format!("client:{identity}"),
                        request,
                        CancellationToken::new(),
                    )
                    .await
            }
            "areal/workgroup/artifact" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Artifact {
                    id: String,
                    path: Option<String>,
                    #[serde(default)]
                    offset: usize,
                }
                let p: Artifact = serde_json::from_value(params)?;
                service.artifact(&p.id, None, p.path, p.offset).await
            }
            "areal/workgroup/read" => {
                let p: Target = serde_json::from_value(params)?;
                service.read(&p.id, None).await
            }
            "areal/workgroup/cancel" => {
                let p: Target = serde_json::from_value(params)?;
                service.cancel(&p.id, None).await
            }
            "areal/workgroup/wait" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Wait {
                    id: String,
                    after_revision: u64,
                    timeout_ms: u64,
                }
                let p: Wait = serde_json::from_value(params)?;
                service
                    .wait(
                        &p.id,
                        None,
                        p.after_revision,
                        Duration::from_millis(p.timeout_ms),
                    )
                    .await
            }
            "areal/workgroup/revise" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Revise {
                    id: String,
                    request_id: String,
                    expected_revision: u64,
                    plan: Plan,
                }
                let p: Revise = serde_json::from_value(params)?;
                service
                    .revise(&p.id, None, p.request_id, p.expected_revision, p.plan)
                    .await
            }
            _ => anyhow::bail!("unknown workgroup method"),
        }
    }
    .await;
    result.map_err(|error| RpcError::invalid(error.to_string()))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}
