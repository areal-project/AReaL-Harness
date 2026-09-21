//! 内容地址只用于完整性；访问权来自认证身份和会话归属。
use super::*;
use areal_protocol::{MediaRef, Modality, ToolContent};

pub(crate) const MAX_UPLOAD: usize = 16 * 1024 * 1024;
fn validate_media(mime: &str, bytes: &[u8]) -> Result<Modality> {
    if bytes.is_empty() || bytes.len() > MAX_UPLOAD {
        return Err(Error::Exhausted(
            "media must contain 1..16777216 bytes".into(),
        ));
    }
    let valid = match mime {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        "audio/wav" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WAVE"),
        "audio/mpeg" => {
            bytes.starts_with(b"ID3")
                || (bytes[0] == 0xff && bytes.get(1).is_some_and(|b| b & 0xe0 == 0xe0))
        }
        "application/pdf" => bytes.starts_with(b"%PDF-"),
        "text/plain" => std::str::from_utf8(bytes).is_ok(),
        _ => false,
    };
    if !valid {
        return Err(invalid(
            "unsupported MIME or media signature does not match MIME",
        ));
    }
    Ok(if mime.starts_with("image/") {
        Modality::Image
    } else if mime.starts_with("audio/") {
        Modality::Audio
    } else {
        Modality::File
    })
}
impl Engine {
    pub async fn upload_blob(
        self: &Arc<Self>,
        thread_id: String,
        identity: String,
        call: Option<(String, String)>,
        mime: String,
        bytes: Vec<u8>,
    ) -> Result<MediaRef> {
        validate_media(&mime, &bytes)?;
        self.mutate(move|engine|async move{
            if !engine.accepting_work(){return Err(Error::Closed);}
            let cell=engine.cell(&thread_id).await?;
            let mut state=cell.state.lock().await;
            if let Some((call_id,generation))=&call {
                let host=cell.bindings.read().await.host.clone().ok_or(Error::Conflict)?;
                if host.identity()!=identity || host.id()!=generation || host.is_closed() || state.active.as_ref().is_none_or(|a|a.cancel.is_cancelled()) || !state.thread.turns.last().is_some_and(|turn|turn.items.iter().any(|item|matches!(item,Item::DynamicToolCall{call_id:id,execution,..} if id==call_id && execution.backend.as_deref()==Some("client") && execution.outcome==areal_protocol::ToolOutcome::Running))) { return Err(Error::Conflict); }
            }
            let mut candidate=state.thread.clone();let data=candidate.desktop.get_or_insert_with(Default::default);
            if data.uploads.len()>=128 || data.uploads.iter().map(|m|m.size_bytes).sum::<u64>()+bytes.len() as u64>64*1024*1024 { return Err(Error::Exhausted("thread upload quota reached".into())); }
            let media=engine.store.save_blob(mime,bytes).await.map_err(invalid)?;
            if !data.uploads.iter().any(|old|old.uri==media.uri) { data.uploads.push(media.clone()); }
            engine.persist(&candidate).await?;state.thread=candidate;
            Ok(media)
        }).await
    }
    pub async fn thread_blob(&self, thread_id: &str, blob: &str) -> Result<Vec<u8>> {
        let thread = self.read(thread_id, true).await?;
        let uri = format!("areal://blob/{blob}");
        let associated=thread.desktop.as_ref().is_some_and(|d|d.uploads.iter().any(|m|m.uri==uri)) || thread.turns.iter().flat_map(|t|&t.items).any(|item|matches!(item,Item::AgentMedia{media,..} if media.uri==uri) || matches!(item,Item::DynamicToolCall{content_items:Some(content),..} if content.iter().any(|c|c["media"]["uri"]==uri)));
        if !associated {
            return Err(Error::NotFound);
        }
        self.read_blob(blob).await
    }
    pub(crate) async fn materialize_tool_media(
        &self,
        cell: &Cell,
        content: &mut [ToolContent],
    ) -> Result<()> {
        use base64::Engine as _;
        let configuration = cell
            .state
            .lock()
            .await
            .thread
            .turns
            .last()
            .and_then(|t| t.configuration.clone())
            .unwrap_or_default();
        let capabilities = self.configured_model(&configuration)?.capabilities();
        let mut total = 0;
        for item in content {
            if let ToolContent::InlineMedia {
                modality,
                mime_type,
                data_base64,
            } = item
            {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(data_base64)
                    .map_err(invalid)?;
                let actual = validate_media(mime_type, &bytes)?;
                if &actual != modality || !capabilities.supports_input(actual) {
                    return Err(invalid("model does not support tool media modality"));
                }
                total += bytes.len();
                if total > MAX_UPLOAD {
                    return Err(Error::Exhausted("tool media exceeds 16 MiB".into()));
                }
                let media = self
                    .store
                    .save_blob(mime_type.clone(), bytes)
                    .await
                    .map_err(invalid)?;
                *item = ToolContent::ArealMedia {
                    modality: actual,
                    media,
                };
                continue;
            }
            if let ToolContent::ArealMedia { modality, media } = item {
                if !capabilities.supports_input(*modality) {
                    return Err(invalid("model does not support tool media modality"));
                }
                let state = cell.state.lock().await;
                if !state.thread.desktop.as_ref().is_some_and(|d| {
                    d.uploads.iter().any(|m| {
                        m.uri == media.uri
                            && m.mime_type == media.mime_type
                            && m.size_bytes == media.size_bytes
                    })
                }) {
                    return Err(invalid(
                        "media reference is not an upload owned by this thread",
                    ));
                }
                drop(state);
                let blob = media
                    .uri
                    .strip_prefix("areal://blob/")
                    .ok_or_else(|| invalid("invalid media URI"))?;
                let bytes = self.read_blob(blob).await?;
                if bytes.len() as u64 != media.size_bytes
                    || validate_media(&media.mime_type, &bytes)? != *modality
                {
                    return Err(invalid("media metadata mismatch"));
                }
            }
        }
        Ok(())
    }
}

impl Engine {
    pub(crate) fn validate_uploads(&self, thread: &Thread, input: &[Input]) -> Result<()> {
        for item in input {
            let uri = match item {
                Input::Image { url, .. } | Input::Audio { url } | Input::File { url, .. } => url,
                _ => continue,
            };
            if let Some(id) = uri.strip_prefix("areal://blob/") {
                self.store.blob_path(id).map_err(invalid)?;
                let media = thread
                    .desktop
                    .as_ref()
                    .and_then(|d| d.uploads.iter().find(|m| &m.uri == uri))
                    .ok_or_else(|| invalid("upload does not belong to this Thread"))?;
                let modality = if media.mime_type.starts_with("image/") {
                    Modality::Image
                } else if media.mime_type.starts_with("audio/") {
                    Modality::Audio
                } else {
                    Modality::File
                };
                if item.modality() != modality {
                    return Err(invalid("upload modality mismatch"));
                }
            }
        }
        Ok(())
    }
}
