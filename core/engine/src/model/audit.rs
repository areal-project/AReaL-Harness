use super::*;
use sha2::{Digest, Sha256};
use std::{
    io::Write,
    path::{Path, PathBuf},
    time::Instant,
};

pub(super) struct Audit {
    path: Option<PathBuf>,
    pub value: Value,
    started: Instant,
}
impl Audit {
    pub fn new(directory: Option<&Path>, body: &Value, purpose: RequestPurpose) -> Self {
        let fields = [
            "model",
            "temperature",
            "top_p",
            "top_k",
            "min_p",
            "presence_penalty",
            "repetition_penalty",
            "reasoning_effort",
            "reasoning",
            "max_completion_tokens",
            "max_output_tokens",
            "tool_choice",
            "parallel_tool_calls",
        ];
        let parameters: serde_json::Map<_, _> = fields
            .iter()
            .filter_map(|key| body.get(*key).map(|v| ((*key).to_owned(), v.clone())))
            .collect();
        let request_id = uuid::Uuid::new_v4().to_string();
        let bytes = serde_json::to_vec(body).unwrap_or_default();
        let mut value = json!({"requestId":request_id,"purpose":format!("{purpose:?}"),"parameters":parameters,
            "bodySha256":format!("{:x}",Sha256::digest(&bytes)),"bodyBytes":bytes.len(),
            "toolCount":body["tools"].as_array().map_or(0,Vec::len),"outcome":"pending",
            "httpAttempts":0,"usage":ModelUsage::default(),"usageObserved":false});
        value["startedAtUnixMs"] = json!(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64
        );
        value["systemMessageCount"] = json!(
            body["messages"]
                .as_array()
                .map(|messages| messages.iter().filter(|m| m["role"] == "system").count())
        );
        if let Ok((thread, turn)) = REQUEST_OWNER.try_with(Clone::clone) {
            value["threadId"] = json!(thread);
            value["turnId"] = json!(turn);
        }
        let audit = Self {
            path: directory.map(|d| d.join(format!("{request_id}.json"))),
            value,
            started: Instant::now(),
        };
        audit.save();
        audit
    }
    fn save(&self) {
        if let Some(path) = &self.path {
            let result = (|| -> std::io::Result<()> {
                std::fs::create_dir_all(path.parent().unwrap())?;
                let temporary = path.with_extension("tmp");
                std::fs::write(&temporary, self.value.to_string())?;
                std::fs::rename(temporary, path)
            })();
            if result.is_err() {
                tracing::warn!("could not save model request audit");
            }
        }
    }
}
impl Drop for Audit {
    fn drop(&mut self) {
        if self.value["outcome"] == "pending" {
            self.value["outcome"] = json!("interrupted_or_unfinished");
        }
        self.value["durationMs"] = json!(self.started.elapsed().as_millis() as u64);
        self.save();
        // Keep a single collectable stream as well as individual crash-visible
        // snapshots. Artifact catalogs can otherwise fill before late requests.
        if let Some(path) = &self.path {
            let append = (|| -> std::io::Result<()> {
                let mut file = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(path.parent().unwrap().join("requests.jsonl"))?;
                file.write_all(format!("{}\n", self.value).as_bytes())
            })();
            if append.is_err() {
                tracing::warn!("could not append model request audit");
            }
        }
    }
}
