//! 内容地址只用于完整性；访问权来自认证身份和会话归属。
use super::*;
use crate::model::{Model, ModelProtocol};
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
    pub(crate) fn validate_fork_model_compatibility(
        &self,
        thread: &Thread,
        model: &dyn Model,
    ) -> Result<()> {
        if let Some(areal_protocol::Conversation::Fork { history_seed, .. }) = &thread.conversation
        {
            let prefix = self
                .store
                .read_fork_snapshot(&history_seed.snapshot_id)
                .map_err(|e| Error::Storage(e.to_string()))?;
            validate_fork_prefix_compatibility(&prefix, model)?;
        }
        Ok(())
    }

    /// 创建时验证整个继承前缀，拒绝任何目标适配器会丢失的上下文或媒体。
    pub(crate) async fn validate_fork_replay(
        &self,
        prefix: &[Turn],
        model: &dyn Model,
    ) -> Result<()> {
        validate_fork_prefix_compatibility(prefix, model)?;
        for item in prefix.iter().flat_map(|turn| &turn.items) {
            match item {
                Item::UserMessage { content, .. } => {
                    for input in content {
                        match input {
                            Input::Image { url, .. }
                            | Input::Audio { url }
                            | Input::File { url, .. }
                                if url.starts_with("areal://blob/") =>
                            {
                                self.verify_inherited_blob(url, None, false).await?;
                            }
                            Input::LocalImage { .. } | Input::LocalAudio { .. } => {
                                return Err(invalid("MODEL_CONTEXT_INCOMPATIBLE"));
                            }
                            _ => {}
                        }
                    }
                }
                Item::AgentMedia { media, .. } => {
                    self.verify_inherited_blob(&media.uri, Some(media), false)
                        .await?;
                }
                Item::DynamicToolCall {
                    content_items,
                    execution,
                    ..
                } => {
                    if let Some(items) = content_items {
                        for value in items {
                            match serde_json::from_value::<ToolContent>(value.clone())
                                .map_err(invalid)?
                            {
                                ToolContent::ArealMedia { media, .. } => {
                                    self.verify_inherited_blob(&media.uri, Some(&media), false)
                                        .await?;
                                }
                                ToolContent::InputText { .. } => {}
                                ToolContent::InlineMedia { .. } => {
                                    return Err(invalid("MODEL_CONTEXT_INCOMPATIBLE"));
                                }
                            }
                        }
                    }
                    if let Some(media) = &execution.result_snapshot {
                        self.verify_inherited_blob(&media.uri, Some(media), true)
                            .await?;
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }

    async fn verify_inherited_blob(
        &self,
        uri: &str,
        media: Option<&MediaRef>,
        raw_result: bool,
    ) -> Result<()> {
        let id = uri
            .strip_prefix("areal://blob/")
            .ok_or_else(|| invalid("MODEL_CONTEXT_INCOMPATIBLE"))?;
        let bytes = self
            .store
            .read_blob(id)
            .await
            .map_err(|_| invalid("MODEL_CONTEXT_INCOMPATIBLE"))?;
        if format!("{:x}", Sha256::digest(&bytes)) != id
            || media.is_some_and(|m| {
                m.size_bytes != bytes.len() as u64
                    || if raw_result {
                        m.mime_type != "application/json"
                    } else {
                        validate_media(&m.mime_type, &bytes).is_err()
                    }
            })
        {
            return Err(invalid("MODEL_CONTEXT_INCOMPATIBLE"));
        }
        Ok(())
    }

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
        let snapshot = match &thread.conversation {
            Some(areal_protocol::Conversation::Fork { history_seed, .. }) => {
                Some(&history_seed.snapshot_id)
            }
            Some(areal_protocol::Conversation::Side {
                reference_snapshot, ..
            }) => Some(&reference_snapshot.snapshot_id),
            _ => None,
        };
        let inherited = match snapshot {
            Some(snapshot) => self
                .store
                .read_fork_snapshot(snapshot)
                .map_err(|e| Error::Storage(e.to_string()))?,
            None => Vec::new(),
        };
        let associated=thread.desktop.as_ref().is_some_and(|d|d.uploads.iter().any(|m|m.uri==uri))
            || thread.turns.iter().chain(inherited.iter()).flat_map(|t|&t.items).any(|item| match item {
                Item::UserMessage { content, .. } => content.iter().any(|input| matches!(input,
                    Input::Image { url, .. } | Input::Audio { url } | Input::File { url, .. } if url == &uri)),
                Item::AgentMedia { media, .. } => media.uri == uri,
                Item::DynamicToolCall { content_items, execution, .. } => execution.result_snapshot.as_ref().is_some_and(|m|m.uri==uri)
                    || content_items.as_ref().is_some_and(|items|items.iter().any(|c|c["media"]["uri"]==uri)),
                _ => false,
            });
        if !associated {
            return Err(Error::NotFound);
        }
        let bytes = self.read_blob(blob).await?;
        if format!("{:x}", Sha256::digest(&bytes)) != blob {
            return Err(Error::NotFound);
        }
        Ok(bytes)
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

fn validate_fork_prefix_compatibility(prefix: &[Turn], model: &dyn Model) -> Result<()> {
    let capabilities = model.capabilities();
    for item in prefix.iter().flat_map(|turn| &turn.items) {
        match item {
            Item::UserMessage { content, .. }
                if content
                    .iter()
                    .any(|input| !capabilities.supports_input(input.modality())) =>
            {
                return Err(invalid("MODEL_MODALITY_INCOMPATIBLE"));
            }
            Item::AgentMedia { modality, .. } if !capabilities.supports_input(*modality) => {
                return Err(invalid("MODEL_MODALITY_INCOMPATIBLE"));
            }
            Item::DynamicToolCall {
                content_items: Some(items),
                ..
            } => {
                for item in items {
                    let part: ToolContent =
                        serde_json::from_value(item.clone()).map_err(invalid)?;
                    if let ToolContent::ArealMedia { modality, .. } = part
                        && !capabilities.supports_input(modality)
                    {
                        return Err(invalid("MODEL_MODALITY_INCOMPATIBLE"));
                    }
                }
            }
            Item::ModelContext { value, .. } => match value["type"].as_str() {
                Some("areal_request_context" | "chat_reasoning") => {}
                Some("reasoning" | "function_call")
                    if model.replay_protocol() == Some(ModelProtocol::Responses) => {}
                _ => return Err(invalid("MODEL_CONTEXT_INCOMPATIBLE")),
            },
            _ => {}
        }
    }
    Ok(())
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
