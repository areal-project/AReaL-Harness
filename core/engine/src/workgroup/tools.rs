//! Coordination tools operate on Core state, outside Runtime/tool/model permits.
use super::service::{Service, Start};
use crate::tools::registry::Backend;
use crate::*;
use areal_protocol::ToolDefinition;
use serde::Deserialize;

pub(crate) fn definitions() -> Vec<ToolDefinition> {
    let string = json!({"type":"string","minLength":1,"maxLength":128});
    let task_id =
        json!({"type":"string","minLength":1,"maxLength":80,"pattern":"^[A-Za-z0-9_-]+$"});
    let plan = json!({"type":"object","required":["objective","tasks"],"additionalProperties":false,
        "properties":{"objective":{"type":"string","minLength":1,"maxLength":32000},"tasks":{"type":"array","minItems":1,"maxItems":64,
        "items":{"type":"object","additionalProperties":false,"required":["id","instruction","writes"],"properties":{
        "configuration":{"type":["object","null"],"properties":{"agentProfile":{"type":"object"},"model":{"type":"object"},"skills":{"type":"array"},"toolAllowlist":{"type":"array","items":{"type":"string"}},"readOnly":{"type":"boolean"}},"additionalProperties":false},"id":task_id,"instruction":{"type":"string","minLength":1,"maxLength":32000},"writes":{"type":"array","minItems":0,"maxItems":256,"uniqueItems":true,"items":{"type":"string","minLength":1,"maxLength":4096}},
        "depends":{"type":"array","maxItems":64,"uniqueItems":true,"items":task_id},"integrationDepends":{"type":"array","maxItems":64,"uniqueItems":true,"items":task_id},
        "checks":{"type":"array","maxItems":16,"items":{"type":"array","minItems":1,"maxItems":128,"items":{"type":"string"}}}}}}}});
    [
        ("workgroup_start", "Dispatch a bounded plan into isolated workspaces. Use only for substantial independent work; use one worker for coupled work. depends blocks execution; integrationDepends allows work against an explicit interface in instruction but blocks acceptance. Deployment final checks and allowed writes are immutable. Reuse requestId for retries. Result is a verified candidate, not an edit of the user's checkout.",
            json!({"requestId":string,"plan":plan,"workers":{"type":"integer","minimum":1,"maximum":32},"admission":{"enum":["fixed","auto","adaptive"]}}),vec!["requestId","plan"]),
        ("workgroup_artifact", "Read the final verified change list or a changed file in bounded byte chunks. baseSha256 is the original file version for conditional application to the parent workspace. Never overwrite a newer parent file without reconciling it. Null path lists changes.",json!({"id":string,"path":{"type":["string","null"]},"offset":{"type":"integer","minimum":0}}),vec!["id"]),
        ("workgroup_read", "Read this Turn's workgroup state, plan revision and verified result.", json!({"id":string}),vec!["id"]),
        ("workgroup_wait", "Wait for a state revision without holding model or execution capacity. Use the returned revision as afterRevision. Finishing this Turn also joins its groups and summarizes their final results.",json!({"id":string,"afterRevision":{"type":"integer","minimum":0},"timeoutMs":{"type":"integer","minimum":0,"maximum":60000}}),vec!["id","afterRevision"]),
        ("workgroup_revise", "Revise unstarted tasks or append tasks inside the original write scope. Retain existing task IDs/order/checks. Started contracts cannot change. Use planRevision for compare-and-swap, requestId for deduplication.",json!({"id":string,"requestId":string,"expectedRevision":{"type":"integer","minimum":0},"plan":plan}),vec!["id","requestId","expectedRevision","plan"]),
        ("workgroup_cancel", "Request cancellation; wait until state settles to confirm cleanup.",json!({"id":string}),vec!["id"]),
    ].into_iter().map(|(name,description,properties,required)| ToolDefinition {
        name:name.into(),description:description.into(),input_schema:json!({"type":"object","additionalProperties":false,"properties":properties,"required":required}), output_schema:None,
    }).collect()
}

pub(crate) fn summary(value: &Value) -> Value {
    let record = &value["record"];
    let excerpt =
        |text: &Value, n: usize| text.as_str().map(|s| s.chars().take(n).collect::<String>());
    let tasks = record["tasks"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let mut result = json!({"id":value["id"],"revision":record["revision"],"planRevision":record["planRevision"],
        "status":record["status"],"head":record["head"],"candidatePath":value["candidatePath"],
        "cleanupConfirmed":record["cleanupConfirmed"],"error":excerpt(&record["error"],256),
        "finalCheck":{"passed":record["finalCheck"]["passed"],"output":excerpt(&record["finalCheck"]["output"],256)},
        "admission":{"maxWorkers":record["admission"]["maxWorkers"],"targetWorkers":record["admission"]["targetWorkers"],"peakInflight":record["admission"]["peakInflight"]},
        "tasks":tasks.iter().map(|t| json!({"id":t["spec"]["id"],"status":t["status"],"generation":t["generation"]})).collect::<Vec<_>>(),
        "feedback":tasks.iter().filter(|t|t["feedback"].as_str().is_some_and(|s|!s.is_empty())).take(4)
            .map(|t|json!({"id":t["spec"]["id"],"text":excerpt(&t["feedback"],64)})).collect::<Vec<_>>()});
    // Retain valid structured results even for maximum IDs or very deep paths.
    if serde_json::to_vec(&result).is_ok_and(|b| b.len() > 14 * 1024) {
        result["candidatePath"] = Value::Null;
        result["feedback"] = Value::Null;
        result["detailsAvailable"] = json!(true);
    }
    result
}

pub(crate) fn summaries(values: &[Value]) -> Vec<Value> {
    let mut results: Vec<_> = values.iter().map(summary).collect();
    if serde_json::to_vec(&results).is_ok_and(|b| b.len() > 32 * 1024) {
        for result in &mut results {
            result["tasks"] = Value::Null;
            result["feedback"] = Value::Null;
            result["candidatePath"] = Value::Null;
            result["finalCheck"]["output"] = Value::Null;
            result["detailsAvailable"] = json!(true);
        }
    }
    results
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Target {
    id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Wait {
    id: String,
    after_revision: u64,
    #[serde(default = "default_wait")]
    timeout_ms: u64,
}
fn default_wait() -> u64 {
    10000
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Revise {
    id: String,
    request_id: String,
    expected_revision: u64,
    plan: super::Plan,
}

impl Engine {
    pub fn workgroups(&self) -> anyhow::Result<&Arc<Service>> {
        self.workgroups
            .get()
            .context("workgroups require a trusted deployment policy")
    }
    pub fn attach_workgroups(&self, service: Arc<Service>) -> anyhow::Result<()> {
        self.workgroups
            .set(service)
            .map_err(|_| anyhow::anyhow!("workgroup service already attached"))
    }
    pub(crate) async fn coordinate(
        &self,
        owner: &str,
        name: &str,
        args: &Value,
        cancel: &CancellationToken,
    ) -> anyhow::Result<Value> {
        let service = self.workgroups()?;
        let value = match name {
            "workgroup_start" => {
                service
                    .start(
                        owner.into(),
                        serde_json::from_value::<Start>(args.clone())?,
                        cancel.clone(),
                    )
                    .await?
            }
            "workgroup_artifact" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Artifact {
                    id: String,
                    path: Option<String>,
                    #[serde(default)]
                    offset: usize,
                }
                let p: Artifact = serde_json::from_value(args.clone())?;
                return service.artifact(&p.id, Some(owner), p.path, p.offset).await;
            }
            "workgroup_read" => {
                let p: Target = serde_json::from_value(args.clone())?;
                service.read(&p.id, Some(owner)).await?
            }
            "workgroup_cancel" => {
                let p: Target = serde_json::from_value(args.clone())?;
                service.cancel(&p.id, Some(owner)).await?
            }
            "workgroup_wait" => {
                let p: Wait = serde_json::from_value(args.clone())?;
                tokio::select! { biased; _=cancel.cancelled()=>anyhow::bail!("cancelled"),
                value=service.wait(&p.id,Some(owner),p.after_revision,Duration::from_millis(p.timeout_ms))=>value? }
            }
            "workgroup_revise" => {
                let p: Revise = serde_json::from_value(args.clone())?;
                service
                    .revise(
                        &p.id,
                        Some(owner),
                        p.request_id,
                        p.expected_revision,
                        p.plan,
                    )
                    .await?
            }
            _ => anyhow::bail!("unknown coordination tool"),
        };
        Ok(summary(&value))
    }
}

impl crate::tools::Registry {
    pub(crate) fn with_workgroups(mut self, enabled: bool) -> anyhow::Result<Self> {
        if enabled {
            for definition in definitions() {
                self.insert(definition, Backend::Coordination)?;
            }
        }
        Ok(self)
    }
}
