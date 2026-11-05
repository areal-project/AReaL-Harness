use super::*;
use crate::server::conversation_media;
use serde::Deserialize;
use std::collections::{HashMap, VecDeque};

pub(super) const METHODS: &[&str] = &["attachment.upload"];

/// 单块原始字节上限；base64 后仍远小于 1 MiB 的帧上限。
pub(crate) const CHUNK_BYTES: usize = 256 * 1024;
const ACTIVE: usize = 4;
const RECEIPTS: usize = 64;

#[derive(Default)]
pub(super) struct Uploads {
    active: HashMap<String, Upload>,
    done: VecDeque<(String, String, String, Value)>,
}

struct Upload {
    project: String,
    thread_id: String,
    mime: String,
    size: usize,
    bytes: Vec<u8>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Chunk {
    thread_id: String,
    upload_id: String,
    mime_type: String,
    size_bytes: usize,
    offset: usize,
    base64: String,
}

impl Session {
    /// 附件按 uploadId 分块送进 Host，收齐后由 Host 交给 Core；
    /// 末块重发返回同一份回执，Core 按内容去重，所以重试不会多存一份。
    pub(super) async fn upload_attachment(
        &mut self,
        project: &str,
        generation: &str,
        request: &Value,
    ) -> Result<Value> {
        ensure!(
            self.gui_write
                && request.get("commandId").is_none()
                && exact(
                    &request["context"],
                    &[
                        "projectId",
                        "gatewayGeneration",
                        "grantRevision",
                        "serviceGeneration"
                    ]
                ),
            "INVALID_PARAMS"
        );
        self.authorize(Some(project), "submit")?;
        let chunk: Chunk =
            serde_json::from_value(request["params"].clone()).context("INVALID_PARAMS")?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&chunk.base64)
            .map_err(|_| fail("INVALID_PARAMS"))?;
        let upload_id = chunk.upload_id.to_ascii_lowercase();
        ensure!(
            !chunk.thread_id.is_empty()
                && chunk.thread_id.len() <= 128
                && upload_id.len() == 36
                && uuid::Uuid::parse_str(&upload_id).is_ok()
                && !chunk.mime_type.is_empty()
                && chunk.mime_type.len() <= 128
                && chunk
                    .mime_type
                    .bytes()
                    .all(|b| b.is_ascii_graphic() || b == b' ')
                && (1..=conversation_media::MAX_BYTES).contains(&chunk.size_bytes)
                && (1..=CHUNK_BYTES).contains(&bytes.len())
                && chunk.offset.saturating_add(bytes.len()) <= chunk.size_bytes,
            "INVALID_PARAMS"
        );
        let same = |p: &str, t: &str, m: &str| {
            p == project && t == chunk.thread_id && m == chunk.mime_type
        };
        if let Some((_, p, t, receipt)) = self.uploads.done.iter().find(|(id, ..)| *id == upload_id)
        {
            ensure!(
                same(p, t, &chunk.mime_type) && receipt["receivedBytes"] == chunk.size_bytes,
                "COMMAND_CONFLICT"
            );
            return Ok(receipt.clone());
        }
        ensure!(
            request["context"]["gatewayGeneration"] == self.generation
                && request["context"]["grantRevision"] == self.grant["revision"],
            "RESYNC_REQUIRED"
        );
        let (_, current) = self.project(project)?;
        ensure!(current == generation, "RESYNC_REQUIRED");
        let upload = match self.uploads.active.get_mut(&upload_id) {
            Some(upload) => {
                ensure!(
                    same(&upload.project, &upload.thread_id, &upload.mime)
                        && upload.size == chunk.size_bytes,
                    "COMMAND_CONFLICT"
                );
                upload
            }
            None => {
                ensure!(chunk.offset == 0, "TARGET_CHANGED");
                ensure!(self.uploads.active.len() < ACTIVE, "CAPACITY_EXCEEDED");
                self.uploads
                    .active
                    .entry(upload_id.clone())
                    .or_insert(Upload {
                        project: project.into(),
                        thread_id: chunk.thread_id.clone(),
                        mime: chunk.mime_type.clone(),
                        size: chunk.size_bytes,
                        bytes: Vec::with_capacity(chunk.size_bytes),
                    })
            }
        };
        if chunk.offset < upload.bytes.len() {
            // 回复丢失后的重发：内容必须和已收的一致。
            ensure!(
                upload.bytes.get(chunk.offset..chunk.offset + bytes.len()) == Some(&bytes[..]),
                "COMMAND_CONFLICT"
            );
        } else {
            ensure!(chunk.offset == upload.bytes.len(), "TARGET_CHANGED");
            upload.bytes.extend_from_slice(&bytes);
        }
        let received = upload.bytes.len();
        if received < upload.size {
            return Ok(json!({"uploadId":upload_id,"receivedBytes":received}));
        }
        // 交给 Core 失败时保留缓冲，客户端重发末块即可再试。
        let body = upload.bytes.clone();
        let (id, _) = self.project(project)?;
        let service = self
            .host
            .slots
            .borrow()
            .get(&id)
            .and_then(|slot| slot.service.clone())
            .context("CORE_UNAVAILABLE")?;
        let media =
            conversation_media::upload(&service, &chunk.thread_id, &chunk.mime_type, body).await?;
        self.uploads.active.remove(&upload_id);
        let receipt = json!({"uploadId":upload_id,"receivedBytes":received,"attachment":media});
        if self.uploads.done.len() == RECEIPTS {
            self.uploads.done.pop_front();
        }
        self.uploads
            .done
            .push_back((upload_id, project.into(), chunk.thread_id, receipt.clone()));
        Ok(receipt)
    }
}
