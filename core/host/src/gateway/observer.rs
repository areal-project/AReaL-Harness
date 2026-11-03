use super::*;
use crate::server::schedule_connection::{CoreEvent, CoreObservation};

pub(super) struct Viewer {
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
impl Viewer {
    fn keys(&self, session: &Session) -> Value {
        json!({"connectionId":session.connection,"gatewayGeneration":session.generation,"projectId":self.project,"serviceGeneration":self.generation,"subscriptionId":self.id})
    }
}
impl Session {
    pub(super) fn observed_model(&self, project: &str) -> Result<Option<Value>> {
        let Some(viewer) = self
            .viewer
            .as_ref()
            .filter(|viewer| viewer.project == project)
        else {
            return Ok(None);
        };
        ensure!(viewer.observation.current(&self.host), "RESYNC_REQUIRED");
        Ok(viewer.model.clone())
    }
    pub(super) async fn next_event(&mut self) -> Result<CoreEvent> {
        match &mut self.viewer {
            Some(viewer) => viewer
                .observation
                .events
                .recv()
                .await
                .context("RESYNC_REQUIRED"),
            None => std::future::pending().await,
        }
    }
    pub(super) async fn event(&mut self, event: CoreEvent) -> Result<Option<Value>> {
        let Some(viewer) = &self.viewer else {
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
        let viewer = self.viewer.as_mut().context("RESYNC_REQUIRED")?;
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
        let mut value = self.viewer.as_ref().unwrap().keys(self);
        value["event"] = json!("session.updated");
        value["sequence"] = json!(sequence);
        value["snapshot"] = snapshot;
        Ok(Some(value))
    }
    pub(super) fn invalidate_session(&mut self, error: &anyhow::Error) -> Option<Value> {
        let viewer = self.viewer.take()?;
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
        let viewer = Viewer {
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
        self.viewer = Some(viewer);
        Ok(result)
    }
    pub(super) fn close_session(&mut self, project: &str, params: &Value) -> Result<Value> {
        ensure!(exact(params, &["subscriptionId"]), "INVALID_PARAMS");
        let id = text(params, "subscriptionId")?;
        ensure!(
            self.viewer
                .as_ref()
                .is_none_or(|viewer| viewer.project == project),
            "FORBIDDEN"
        );
        let closed = self.viewer.as_ref().is_some_and(|viewer| viewer.id == id);
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
        ensure!(
            exact(params, &["threadId", "cursor", "limit"]),
            "INVALID_PARAMS"
        );
        let viewer = self
            .viewer
            .as_ref()
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
            self.viewer.as_mut().unwrap().body = Some(FrozenBody {
                id: uuid::Uuid::new_v4().to_string(),
                encoded,
                turn_id: turn_id.into(),
                item_id: item_id.into(),
                expires: Instant::now() + Duration::from_secs(45),
            });
        }
        let viewer = self.viewer.as_ref().context("RESYNC_REQUIRED")?;
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
            self.viewer.as_mut().unwrap().body = None;
        }
        Ok(result)
    }
}
