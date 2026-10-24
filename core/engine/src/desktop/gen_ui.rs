use super::*;
use areal_protocol::{ToolDefinition, ToolStatus, TurnStatus};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub(crate) const GUIDANCE: &str = include_str!("gen-ui-authoring.md");
const MAX_HTML_BYTES: usize = 48 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Artifact {
    artifact_id: String,
    path: String,
    digest: String,
    blob: String,
    thread_id: String,
    turn_id: String,
    call_id: String,
}

pub(crate) fn definition() -> ToolDefinition {
    ToolDefinition {
        name: "gen_ui_publish".into(),
        description: "Publish an immutable interactive answer HTML fragment in the protected answer store. Returns its absolute managed path for ::visualize. This grants no workspace file, command, network, or tool access. Available in main and Side conversations.".into(),
        input_schema: json!({"type":"object","properties":{"name":{"type":"string","pattern":"^[a-z0-9]+(-[a-z0-9]+)*$","maxLength":80},"html":{"type":"string","minLength":1,"maxLength":49152}},"required":["name","html"],"additionalProperties":false}),
        output_schema: None,
    }
}
impl Engine {
    pub(crate) async fn gen_ui_publish(
        &self,
        thread_id: &str,
        turn_id: &str,
        call_id: &str,
        args: &Value,
    ) -> Result<Value> {
        if !self.extensions.gen_ui {
            return Err(invalid("Generated answers are not enabled on this service"));
        }
        let name = args["name"]
            .as_str()
            .ok_or_else(|| invalid("Missing name"))?;
        let html = args["html"]
            .as_str()
            .ok_or_else(|| invalid("Missing HTML"))?;
        if html.is_empty() || html.len() > MAX_HTML_BYTES {
            return Err(invalid("HTML fragment exceeds 48 KiB"));
        }
        let artifact_id = digest(&(thread_id, turn_id, call_id, name, html))?;
        let blob = self
            .store
            .save_blob("text/html".into(), html.as_bytes().to_vec())
            .await
            .map_err(invalid)?;
        let digest = blob
            .uri
            .strip_prefix("areal://blob/")
            .ok_or_else(|| invalid("Invalid artifact blob"))?
            .to_owned();
        let path = self
            .store
            .publish_gen_ui(&artifact_id, name, &digest)
            .await
            .map_err(invalid)?;
        let artifact = Artifact {
            artifact_id: artifact_id.clone(),
            path,
            digest,
            blob: blob.uri,
            thread_id: thread_id.into(),
            turn_id: turn_id.into(),
            call_id: call_id.into(),
        };
        self.store
            .save_metadata(&format!("gen-ui-{artifact_id}"), &artifact)
            .await
            .map_err(invalid)?;
        Ok(json!({"artifactId":artifact.artifact_id,"path":artifact.path,"digest":artifact.digest}))
    }

    pub async fn gen_ui_source(
        &self,
        thread_id: &str,
        turn_id: &str,
        item_id: &str,
        path: Option<&str>,
    ) -> Result<Value> {
        let thread = self.read(thread_id, true).await?;
        let turn = thread
            .turns
            .iter()
            .find(|turn| turn.id == turn_id)
            .ok_or_else(|| invalid("Source turn unavailable"))?;
        if turn.status != TurnStatus::Completed {
            return Err(invalid("Generated source is not complete"));
        }
        let Item::AgentMessage { text, .. } = turn
            .items
            .iter()
            .find(|item| item.id() == item_id)
            .ok_or_else(|| invalid("Source item unavailable"))?
        else {
            return Err(invalid("Generated source must be an assistant message"));
        };
        let mut artifacts = Vec::new();
        let read_only = thread.desktop.as_ref().is_some_and(|state| state.archived);
        let Some(path) = path else {
            return Ok(json!({"text":text,"artifacts":artifacts,"readOnly":read_only}));
        };
        if path.len() > 4096 {
            return Err(invalid("Artifact path too long"));
        }
        for source_turn in &thread.turns {
            for item in &source_turn.items {
                if source_turn.id == turn_id && item.id() == item_id {
                    break;
                }
                let Item::DynamicToolCall {
                    tool,
                    arguments,
                    call_id,
                    status: ToolStatus::Completed,
                    success: Some(true),
                    ..
                } = item
                else {
                    continue;
                };
                if tool != "gen_ui_publish" {
                    continue;
                }
                let Some(name) = arguments["name"].as_str() else {
                    continue;
                };
                let Some(html) = arguments["html"].as_str() else {
                    continue;
                };
                let id = digest(&(thread_id, &source_turn.id, call_id, name, html))?;
                let record = tokio::fs::read(
                    self.store
                        .root()
                        .join("desktop")
                        .join(format!("gen-ui-{id}.json")),
                )
                .await
                .map_err(invalid)?;
                let artifact: Artifact = serde_json::from_slice(&record).map_err(invalid)?;
                if artifact.thread_id != thread_id
                    || artifact.turn_id != source_turn.id
                    || artifact.call_id != *call_id
                    || artifact.artifact_id != id
                {
                    return Err(invalid("Artifact provenance mismatch"));
                }
                if artifact.path != path {
                    continue;
                }
                let managed = self
                    .store
                    .root()
                    .join("gen-ui-output")
                    .join(&id)
                    .join(format!("{name}.html"));
                if artifact.path != managed.to_string_lossy() {
                    return Err(invalid("Artifact path mismatch"));
                }
                let bytes = tokio::fs::read(managed).await.map_err(invalid)?;
                if bytes.len() > MAX_HTML_BYTES
                    || format!("{:x}", Sha256::digest(&bytes)) != artifact.digest
                {
                    return Err(invalid("Artifact digest mismatch"));
                }
                let html = String::from_utf8(bytes).map_err(invalid)?;
                let mut value = serde_json::to_value(artifact).map_err(invalid)?;
                value["html"] = json!(html);
                artifacts.push(value);
                return Ok(json!({"text":text,"artifacts":artifacts,"readOnly":read_only}));
            }
            if source_turn.id == turn_id {
                break;
            }
        }
        Ok(json!({"text":text,"artifacts":artifacts,"readOnly":read_only}))
    }
}
