use super::*;
use crate::server::conversation_read::{ConversationReader, HistoryParams};
use crate::server::schedule_connection::{CoreEvent, CoreObservation};

pub(super) enum Viewer {
    Remote(RemoteViewer),
    Conversation {
        project: String,
        reader: ConversationReader,
    },
}
impl Viewer {
    fn project(&self) -> &str {
        match self {
            Self::Remote(viewer) => &viewer.project,
            Self::Conversation { project, .. } => project,
        }
    }
    fn id(&self) -> &str {
        match self {
            Self::Remote(viewer) => &viewer.id,
            Self::Conversation { reader, .. } => reader.subscription(),
        }
    }
}
pub(super) struct RemoteViewer {
    project: String,
    thread_id: String,
    generation: String,
    id: String,
    scope: Vec<String>,
    sequence: u64,
    barrier: u64,
    observation: CoreObservation,
    model: Option<Value>,
    body: Option<FrozenBody>,
}
struct FrozenBody {
    id: String,
    encoded: String,
    turn_id: String,
    item_id: String,
    expires: Instant,
}
impl RemoteViewer {
    fn keys(&self, session: &Session) -> Value {
        json!({"connectionId":session.connection,"gatewayGeneration":session.generation,"projectId":self.project,"serviceGeneration":self.generation,"subscriptionId":self.id})
    }
}
impl Session {
    pub(super) fn observed_model(&self, project: &str) -> Result<Option<Value>> {
        let Some(viewer) = self
            .viewer
            .as_ref()
            .filter(|viewer| viewer.project() == project)
        else {
            return Ok(None);
        };
        match viewer {
            Viewer::Remote(viewer) => {
                ensure!(viewer.observation.current(&self.host), "RESYNC_REQUIRED");
                Ok(viewer.model.clone())
            }
            Viewer::Conversation { reader, .. } => {
                ensure!(reader.current(&self.host), "RESYNC_REQUIRED");
                Ok(reader.model())
            }
        }
    }
    pub(super) async fn next_event(&mut self) -> Result<CoreEvent> {
        match &mut self.viewer {
            Some(Viewer::Remote(viewer)) => viewer
                .observation
                .events
                .recv()
                .await
                .context("RESYNC_REQUIRED"),
            Some(Viewer::Conversation { reader, .. }) => reader.next_event().await,
            None => std::future::pending().await,
        }
    }
    fn conversation_keys(&self, mut value: Value, project: &str) -> Value {
        value["connectionId"] = json!(self.connection);
        value["gatewayGeneration"] = json!(self.generation);
        let _ = project;
        value
    }
    pub(super) fn conversation_active(&self) -> bool {
        matches!(self.viewer, Some(Viewer::Conversation { .. }))
    }
    pub(super) async fn conversation_media(
        &mut self,
        project: &str,
        generation: &str,
        params: &Value,
    ) -> Result<Value> {
        self.authorize(Some(project), "observe")?;
        let (id, current) = self.project(project)?;
        ensure!(current == generation, "RESYNC_REQUIRED");
        let Some(Viewer::Conversation { reader, .. }) = &mut self.viewer else {
            anyhow::bail!("RESYNC_REQUIRED")
        };
        ensure!(
            reader.project() == id && reader.generation() == generation,
            "RESYNC_REQUIRED"
        );
        let value = reader.media(&self.host, params).await;
        self.authorize(Some(project), "observe")?;
        Ok(self.conversation_keys(value?, project))
    }
    pub(super) async fn event(&mut self, event: CoreEvent) -> Result<Option<Value>> {
        if let Some(Viewer::Conversation { project, .. }) = &self.viewer {
            let project = project.clone();
            self.authorize(Some(&project), "observe")?;
            let Some(Viewer::Conversation { reader, .. }) = &mut self.viewer else {
                unreachable!()
            };
            let value = reader.event(&self.host, event).await?;
            self.authorize(Some(&project), "observe")?;
            return Ok(value.map(|value| self.conversation_keys(value, &project)));
        }
        let Some(Viewer::Remote(viewer)) = &self.viewer else {
            return Ok(None);
        };
        ensure!(viewer.observation.current(&self.host), "RESYNC_REQUIRED");
        self.authorize(Some(&viewer.project), "observe")?;
        if event.sequence <= viewer.barrier {
            return Ok(None);
        }
        let params = &event.value["params"];
        let thread = params
            .get("threadId")
            .or_else(|| params["interaction"].get("threadId"))
            .or_else(|| params["thread"].get("id"));
        if thread.and_then(Value::as_str) != Some(viewer.thread_id.as_str()) {
            return Ok(None);
        }
        let method = event.value["method"].as_str().unwrap_or_default();
        if !method.starts_with("item/")
            && !method.starts_with("turn/")
            && !method.starts_with("areal/")
            && !method.starts_with("thread/")
        {
            return Ok(None);
        }
        let project = viewer.project.clone();
        let (native, barrier) = viewer.observation.snapshot(&self.host).await?;
        self.authorize(Some(&project), "observe")?;
        ensure!(
            serde_json::to_vec(&native)?.len() <= 4 * 1024 * 1024,
            "RESOURCE_UNAVAILABLE"
        );
        let goal_control_allowed = self.goal_control_allowed(&project, &native["thread"])?;
        let models = self
            .model_catalog(&project, &viewer.generation, || {
                Ok(native["thread"]["desktop"]["configuration"]
                    .get("model")
                    .cloned())
            })
            .await?;
        let Some(Viewer::Remote(viewer)) = self.viewer.as_mut() else {
            anyhow::bail!("RESYNC_REQUIRED")
        };
        ensure!(viewer.observation.current(&self.host), "RESYNC_REQUIRED");
        let mut snapshot = projection::snapshot(
            &native["thread"],
            &native["ownership"],
            &viewer.scope,
            &viewer.observation.features(),
        )?;
        snapshot["goalControlAllowed"] = json!(goal_control_allowed);
        snapshot = projection::with_models(snapshot, &models["models"])?;
        viewer.sequence += 1;
        viewer.model = native["thread"]["desktop"]["configuration"]
            .get("model")
            .cloned();
        viewer.barrier = barrier;
        let sequence = viewer.sequence;
        let Some(Viewer::Remote(viewer)) = self.viewer.as_ref() else {
            unreachable!()
        };
        let mut value = viewer.keys(self);
        value["event"] = json!("session.updated");
        value["sequence"] = json!(sequence);
        value["snapshot"] = snapshot;
        Ok(Some(value))
    }
    pub(super) fn invalidate_session(&mut self, error: &anyhow::Error) -> Option<Value> {
        let viewer = self.viewer.take()?;
        let viewer = match viewer {
            Viewer::Conversation { project, reader } => {
                return Some(self.conversation_keys(reader.invalidated(error), &project));
            }
            Viewer::Remote(viewer) => viewer,
        };
        let mut value = viewer.keys(self);
        let code = if error.to_string() == "RESOURCE_UNAVAILABLE" {
            "RESOURCE_UNAVAILABLE"
        } else {
            "RESYNC_REQUIRED"
        };
        value["event"] = json!("session.invalidated");
        value["sequence"] = json!(viewer.sequence + 1);
        value["error"] = json!({"code":code,"message":"观察连接已变化；请重新打开会话"});
        value["history"] = json!({"truncated":true,"unavailable":true});
        Some(value)
    }
    pub(super) async fn open_session(
        &mut self,
        project: &str,
        generation: &str,
        params: &Value,
    ) -> Result<Value> {
        if params.get("view").is_some() {
            ensure!(
                self.gui_read
                    && params["view"] == "conversation"
                    && exact(params, &["threadId", "view"]),
                "INVALID_PARAMS"
            );
            let thread_id = text(params, "threadId")?;
            self.viewer = None;
            self.authorize(Some(project), "observe")?;
            let (id, current) = self.project(project)?;
            ensure!(current == generation, "RESYNC_REQUIRED");
            let opened = ConversationReader::open(&self.host, &id, generation, thread_id).await;
            self.authorize(Some(project), "observe")?;
            let (reader, result) = opened?;
            self.viewer = Some(Viewer::Conversation {
                project: project.into(),
                reader,
            });
            return Ok(self.conversation_keys(result, project));
        }
        ensure!(exact(params, &["threadId"]), "INVALID_PARAMS");
        let thread_id = text(params, "threadId")?.to_owned();
        self.viewer = None;
        let (id, _) = self.project(project)?;
        let (service_id, current, _) = self
            .host
            .schedules
            .connections
            .shared_identity(&self.host, &id)?;
        ensure!(current == generation, "RESYNC_REQUIRED");
        let (native, barrier, observation) = self
            .host
            .schedules
            .connections
            .remote_observe(&self.host, &id, generation, &thread_id)
            .await?;
        self.authorize(Some(project), "observe")?;
        ensure!(
            serde_json::to_vec(&native)?.len() <= 4 * 1024 * 1024,
            "RESOURCE_UNAVAILABLE"
        );
        let scope = vec![
            project.into(),
            service_id,
            generation.into(),
            thread_id.clone(),
        ];
        let models = self
            .model_catalog(project, generation, || {
                Ok(native["thread"]["desktop"]["configuration"]
                    .get("model")
                    .cloned())
            })
            .await?;
        ensure!(observation.current(&self.host), "RESYNC_REQUIRED");
        let mut snapshot = projection::snapshot(
            &native["thread"],
            &native["ownership"],
            &scope,
            &observation.features(),
        )?;
        snapshot["goalControlAllowed"] =
            json!(self.goal_control_allowed(project, &native["thread"])?);
        snapshot = projection::with_models(snapshot, &models["models"])?;
        let viewer = RemoteViewer {
            project: project.into(),
            thread_id,
            generation: generation.into(),
            id: uuid::Uuid::new_v4().to_string(),
            scope,
            sequence: 0,
            barrier,
            observation,
            model: native["thread"]["desktop"]["configuration"]
                .get("model")
                .cloned(),
            body: None,
        };
        let mut result = viewer.keys(self);
        result["sequence"] = json!(0);
        result["snapshot"] = snapshot;
        self.viewer = Some(Viewer::Remote(viewer));
        Ok(result)
    }
    pub(super) fn close_session(&mut self, project: &str, params: &Value) -> Result<Value> {
        ensure!(exact(params, &["subscriptionId"]), "INVALID_PARAMS");
        let id = text(params, "subscriptionId")?;
        ensure!(
            self.viewer
                .as_ref()
                .is_none_or(|viewer| viewer.project() == project),
            "FORBIDDEN"
        );
        let closed = self.viewer.as_ref().is_some_and(|viewer| viewer.id() == id);
        if closed {
            self.viewer = None;
        }
        Ok(json!({"closed":closed}))
    }
    pub(super) async fn session_history(
        &self,
        project: &str,
        generation: &str,
        params: &Value,
    ) -> Result<Value> {
        if let Some(Viewer::Conversation {
            project: alias,
            reader,
        }) = &self.viewer
        {
            ensure!(
                self.gui_read && alias == project && reader.generation() == generation,
                "INVALID_PARAMS"
            );
            self.authorize(Some(project), "observe")?;
            let params: HistoryParams = serde_json::from_value(params.clone())
                .map_err(|_| anyhow::anyhow!("INVALID_PARAMS"))?;
            let result = reader.history(&self.host, params).await;
            self.authorize(Some(project), "observe")?;
            return Ok(self.conversation_keys(result?, project));
        }
        ensure!(
            exact(params, &["threadId", "cursor", "limit"]),
            "INVALID_PARAMS"
        );
        let viewer = self
            .viewer
            .as_ref()
            .and_then(|viewer| match viewer {
                Viewer::Remote(viewer) => Some(viewer),
                _ => None,
            })
            .filter(|viewer| {
                viewer.project == project
                    && viewer.thread_id == params["threadId"]
                    && viewer.generation == generation
            })
            .context("INVALID_PARAMS")?;
        ensure!(viewer.observation.current(&self.host), "RESYNC_REQUIRED");
        let result = self
            .rpc(
                project,
                generation,
                "thread/read",
                json!({"threadId":viewer.thread_id,"includeTurns":true}),
            )
            .await?;
        let cursor = params
            .get("cursor")
            .map(|cursor| cursor.as_str().context("INVALID_PARAMS"))
            .transpose()?;
        let limit = params
            .get("limit")
            .map(|limit| limit.as_u64().context("INVALID_PARAMS"))
            .transpose()?
            .unwrap_or(100) as usize;
        let page = projection::history(&result["thread"], &viewer.scope, cursor, limit)?;
        let mut result = viewer.keys(self);
        result["threadId"] = json!(viewer.thread_id);
        result
            .as_object_mut()
            .unwrap()
            .extend(page.as_object().unwrap().clone());
        Ok(result)
    }
    pub(super) async fn session_body(
        &mut self,
        project: &str,
        generation: &str,
        params: &Value,
    ) -> Result<Value> {
        ensure!(
            exact(params, &["threadId", "turnId", "itemId", "cursor"]),
            "INVALID_PARAMS"
        );
        let thread_id = text(params, "threadId")?;
        let turn_id = text(params, "turnId")?;
        let item_id = text(params, "itemId")?;
        let viewer = self
            .viewer
            .as_ref()
            .and_then(|viewer| match viewer {
                Viewer::Remote(viewer) => Some(viewer),
                _ => None,
            })
            .filter(|viewer| {
                viewer.project == project
                    && viewer.thread_id == thread_id
                    && viewer.generation == generation
            })
            .context("INVALID_PARAMS")?;
        ensure!(viewer.observation.current(&self.host), "RESYNC_REQUIRED");
        if params.get("cursor").is_none() {
            let native = self
                .rpc(
                    project,
                    generation,
                    "thread/read",
                    json!({"threadId":thread_id,"includeTurns":true}),
                )
                .await?;
            let item = native["thread"]["turns"]
                .as_array()
                .and_then(|turns| turns.iter().find(|turn| turn["id"] == turn_id))
                .and_then(|turn| turn["items"].as_array())
                .and_then(|items| items.iter().find(|item| item["id"] == item_id))
                .context("FORBIDDEN")?;
            let body = projection::body(item).context("FORBIDDEN")?;
            let encoded = serde_json::to_string(&body)?;
            ensure!(encoded.len() <= 4 * 1024 * 1024, "RESOURCE_UNAVAILABLE");
            let Some(Viewer::Remote(viewer)) = self.viewer.as_mut() else {
                unreachable!()
            };
            viewer.body = Some(FrozenBody {
                id: uuid::Uuid::new_v4().to_string(),
                encoded,
                turn_id: turn_id.into(),
                item_id: item_id.into(),
                expires: Instant::now() + Duration::from_secs(45),
            });
        }
        let Some(Viewer::Remote(viewer)) = self.viewer.as_ref() else {
            anyhow::bail!("RESYNC_REQUIRED")
        };
        let body = viewer.body.as_ref().context("RESYNC_REQUIRED")?;
        let cursor = params
            .get("cursor")
            .map(|cursor| cursor.as_str().context("INVALID_PARAMS"))
            .transpose()?;
        let offset = if let Some(cursor) = cursor {
            let (id, offset) = cursor.split_once(':').context("RESYNC_REQUIRED")?;
            ensure!(id == body.id, "RESYNC_REQUIRED");
            offset.parse::<usize>().context("RESYNC_REQUIRED")?
        } else {
            0
        };
        ensure!(
            body.expires > Instant::now()
                && body.turn_id == turn_id
                && body.item_id == item_id
                && offset < body.encoded.len()
                && body.encoded.is_char_boundary(offset),
            "RESYNC_REQUIRED"
        );
        let mut end = (offset + 32768).min(body.encoded.len());
        while !body.encoded.is_char_boundary(end) {
            end -= 1;
        }
        let mut result = viewer.keys(self);
        result["threadId"] = json!(thread_id);
        result["turnId"] = json!(turn_id);
        result["itemId"] = json!(item_id);
        result["body"] = json!({"version":body.id,"offset":offset,"totalBytes":body.encoded.len(),"chunk":&body.encoded[offset..end]});
        let complete = end == body.encoded.len();
        result["nextCursor"] = if complete {
            Value::Null
        } else {
            json!(format!("{}:{end}", body.id))
        };
        if complete {
            let Some(Viewer::Remote(viewer)) = self.viewer.as_mut() else {
                unreachable!()
            };
            viewer.body = None;
        }
        Ok(result)
    }
}
