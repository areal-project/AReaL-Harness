//! 过程记录只追加到现有轮次历史，查询与上传开关无关。
use super::*;
use areal_protocol::TraceActivity;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

fn invalid(error: impl std::fmt::Display) -> Error {
    Error::Invalid(error.to_string())
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}
#[derive(Clone)]
pub(crate) struct TraceTimer(Arc<std::sync::Mutex<TimerState>>);
#[derive(Clone)]
struct TimerState {
    finished: bool,
    id: String,
    started: Instant,
    first_content: bool,
}
#[derive(Clone)]
pub(crate) struct RequestTrace {
    pub(crate) engine: Arc<Engine>,
    pub(crate) cell: Arc<Cell>,
    pub(crate) timer: Option<TraceTimer>,
    pub(crate) logical_id: String,
}
tokio::task_local! { pub(crate) static REQUEST_TRACE: RequestTrace; }
impl RequestTrace {
    pub(crate) async fn restart(&self, label: &str) -> anyhow::Result<()> {
        if let (Some(current), Some(next)) = (
            &self.timer,
            self.engine
                .trace_begin(&self.cell, "model", label, None, Some(&self.logical_id))
                .await?,
        ) {
            *current.0.lock().unwrap() = next.0.lock().unwrap().clone();
        }
        Ok(())
    }
}
impl Engine {
    pub(crate) async fn trace_model_permit(
        &self,
        cell: &Cell,
        cancel: &CancellationToken,
    ) -> anyhow::Result<OwnedSemaphorePermit> {
        if let Ok(permit) = self.permits.clone().try_acquire_owned() {
            return Ok(permit);
        }
        let mut timer = self
            .trace_begin(
                cell,
                "modelCapacityWait",
                "Waiting for model capacity",
                None,
                None,
            )
            .await?;
        let acquired = tokio::select! {
            _ = cancel.cancelled() => None,
            permit = self.permits.clone().acquire_owned() => Some(permit),
        };
        let error = match &acquired {
            None => Some("cancelled".to_owned()),
            Some(Err(error)) => Some(error.to_string()),
            _ => None,
        };
        self.trace_finish(cell, &mut timer, error.as_deref())
            .await?;
        acquired
            .ok_or_else(|| anyhow::anyhow!("cancelled"))?
            .map_err(Into::into)
    }
    pub(crate) async fn trace_begin(
        &self,
        cell: &Cell,
        kind: &str,
        label: &str,
        call_id: Option<&str>,
        logical_id: Option<&str>,
    ) -> anyhow::Result<Option<TraceTimer>> {
        let mut state = cell.state.lock().await;
        let Some(active) = &state.active else {
            return Ok(None);
        };
        let turn_id = active.id.clone();
        let mut candidate = state.thread.clone();
        let turn = candidate
            .turns
            .iter_mut()
            .find(|t| t.id == turn_id)
            .ok_or_else(|| anyhow::anyhow!("active turn missing"))?;
        let timer = TimerState {
            id: id(),
            started: Instant::now(),
            first_content: false,
            finished: false,
        };
        let after_item_id = call_id.and_then(|call| turn.items.iter().find(|item| matches!(item, Item::DynamicToolCall { call_id, .. } if call_id == call)).map(|item| item.id().to_owned()))
            .or_else(|| (matches!(kind, "model" | "retryWait")).then(|| turn.trace.activities.iter().rev().find(|a| a.logical_id.as_deref() == logical_id).and_then(|a| a.after_item_id.clone())).flatten())
            .or_else(|| turn.items.last().map(|item| item.id().to_owned()));
        turn.trace.activities.push(TraceActivity {
            after_item_id,
            id: timer.id.clone(),
            kind: kind.into(),
            label: label.into(),
            call_id: call_id.map(str::to_owned),
            logical_id: logical_id.map(str::to_owned),
            started_at_ms: now_ms(),
            completed_at_ms: None,
            duration_ms: None,
            first_content_ms: None,
            usage: None,
            status: "running".into(),
            error: None,
        });
        self.persist(&candidate).await?;
        state.thread = candidate;
        Ok(Some(TraceTimer(Arc::new(std::sync::Mutex::new(timer)))))
    }
    pub(crate) async fn trace_content(
        &self,
        cell: &Cell,
        timer: &mut Option<TraceTimer>,
        event: &model::ModelEvent,
    ) -> anyhow::Result<()> {
        let Some(timer) = timer else {
            return Ok(());
        };
        let mut measured = timer.0.lock().unwrap().clone();
        let content = matches!(event, model::ModelEvent::TextDelta(s) | model::ModelEvent::ReasoningDelta { delta: s, .. } if !s.is_empty());
        let usage = if let model::ModelEvent::Usage(usage) = event {
            Some(usage)
        } else {
            None
        };
        if (!content || measured.first_content) && usage.is_none() {
            return Ok(());
        }
        let mut state = cell.state.lock().await;
        let mut candidate = state.thread.clone();
        if let Some(activity) = candidate
            .turns
            .last_mut()
            .and_then(|t| t.trace.activities.iter_mut().find(|a| a.id == measured.id))
        {
            if content && !measured.first_content {
                measured.first_content = true;
                activity.first_content_ms =
                    Some(measured.started.elapsed().as_millis().min(u64::MAX as u128) as u64);
            }
            if let Some(usage) = usage {
                activity
                    .usage
                    .get_or_insert_with(Default::default)
                    .add_assign(usage);
            }
        }
        self.persist(&candidate).await?;
        *timer.0.lock().unwrap() = measured;
        state.thread = candidate;
        Ok(())
    }
    pub(crate) async fn trace_finish(
        &self,
        cell: &Cell,
        timer: &mut Option<TraceTimer>,
        error: Option<&str>,
    ) -> anyhow::Result<()> {
        let Some(timer) = timer.take() else {
            return Ok(());
        };
        let mut measured = timer.0.lock().unwrap().clone();
        if measured.finished {
            return Ok(());
        }
        measured.finished = true;
        *timer.0.lock().unwrap() = measured.clone();
        let mut state = cell.state.lock().await;
        let mut candidate = state.thread.clone();
        if let Some(activity) = candidate
            .turns
            .last_mut()
            .and_then(|t| t.trace.activities.iter_mut().find(|a| a.id == measured.id))
        {
            activity.completed_at_ms = Some(now_ms());
            activity.duration_ms =
                Some(measured.started.elapsed().as_millis().min(u64::MAX as u128) as u64);
            activity.status = match error {
                Some("cancelled") => "cancelled",
                Some(_) => "failed",
                None => "completed",
            }
            .into();
            activity.error = error.map(str::to_owned);
        }
        self.persist(&candidate).await?;
        state.thread = candidate;
        Ok(())
    }
}

impl Engine {
    /// 查询沿已有委派归属鉴权；隔离历史只通过可信工厂读取，不打开第二个 Store owner。
    pub async fn execution_trace(
        &self,
        thread_id: &str,
        execution_id: Option<&str>,
        worker_thread_id: Option<&str>,
        cursor: Option<String>,
    ) -> Result<Value> {
        use areal_protocol::delegation::ExecutionRef;
        let mut sources = Vec::new();
        let mut isolated = false;
        let mut source_live = true;
        let thread = if let Some(execution_id) = execution_id {
            let record = self.execution_record(thread_id, execution_id).await?;
            match &record.execution {
                Some(ExecutionRef::Thread { thread_id, .. }) => self.read(thread_id, true).await?,
                Some(ExecutionRef::Workgroup {
                    workgroup_id,
                    automatic,
                }) => {
                    isolated = true;
                    source_live = self
                        .execution_workgroups(*automatic)?
                        .trace_live(workgroup_id, &crate::delegation::owner_key(&record.owner))
                        .await
                        .map_err(invalid)?;
                    let threads = self
                        .execution_workgroups(*automatic)?
                        .trace(workgroup_id, &crate::delegation::owner_key(&record.owner))
                        .await
                        .map_err(invalid)?;
                    sources = threads
                        .iter()
                        .map(|t| json!({"threadId":t.id,"title":t.preview}))
                        .collect();
                    let selected =
                        worker_thread_id.or_else(|| threads.first().map(|t| t.id.as_str()));
                    threads
                        .iter()
                        .find(|t| Some(t.id.as_str()) == selected)
                        .cloned()
                        .ok_or(Error::NotFound)?
                }
                None => return Err(invalid("execution has no confirmed trace source")),
            }
        } else {
            if worker_thread_id.is_some() {
                return Err(invalid("worker thread requires an execution"));
            }
            self.read(thread_id, true).await?
        };
        let linked: HashSet<_> = thread
            .desktop
            .as_ref()
            .into_iter()
            .flat_map(|d| &d.executions)
            .filter_map(|r| match &r.execution {
                Some(ExecutionRef::Thread { thread_id, .. }) => Some(thread_id.clone()),
                _ => None,
            })
            .collect();
        let mut legacy_sources = Vec::new();
        if !isolated {
            let mut after: Option<String> = None;
            loop {
                let (children, next) = self.list(after.as_deref(), 100, Some(&thread.id)).await?;
                legacy_sources.extend(
                    children
                        .into_iter()
                        .filter(|t| !linked.contains(&t.id))
                        .map(|t| json!({"threadId":t.id,"title":t.preview})),
                );
                if next.is_none() {
                    break;
                }
                after = next;
            }
        }
        let state_confirmed = source_live
            || thread
                .turns
                .iter()
                .all(|turn| turn.status != TurnStatus::InProgress);
        let id = thread.id.clone();
        let active_turn = thread
            .turns
            .last()
            .filter(|t| t.status == areal_protocol::TurnStatus::InProgress)
            .cloned();
        let queue = thread.desktop.as_ref().map(|d| d.queue.clone());
        let title = thread.preview.clone();
        let parent = thread.parent_thread_id.clone();
        let page = self
            .store
            .own_history_page(
                thread,
                format!("trace:{thread_id}:{}", execution_id.unwrap_or_default()),
                cursor,
                262144,
                None,
                None,
            )
            .await?;
        let executions = if isolated {
            json!({"data":[],"nextOffset":null})
        } else {
            self.execution_list(&id, 0, 100).await?
        };
        Ok(
            json!({"threadId":id,"parentThreadId":parent,"title":title,"page":page,"activeTurn":active_turn,"sources":sources,"legacySources":legacy_sources,"executions":executions,"queue":queue,"readAtMs":now_ms(),"stateConfirmed":state_confirmed}),
        )
    }
}

impl Engine {
    pub async fn execution_trace_result(
        &self,
        parent: &str,
        execution_id: &str,
        worker: &str,
        uri: &str,
    ) -> Result<Vec<u8>> {
        use areal_protocol::delegation::ExecutionRef;
        let record = self.execution_record(parent, execution_id).await?;
        match &record.execution {
            Some(ExecutionRef::Workgroup {
                workgroup_id,
                automatic,
            }) => self
                .execution_workgroups(*automatic)?
                .trace_result(
                    workgroup_id,
                    &crate::delegation::owner_key(&record.owner),
                    worker,
                    uri,
                )
                .await
                .map_err(invalid),
            Some(ExecutionRef::Thread { thread_id, .. }) if thread_id == worker => {
                self.thread_blob(
                    worker,
                    uri.strip_prefix("areal://blob/")
                        .ok_or_else(|| invalid("invalid result URI"))?,
                )
                .await
            }
            _ => Err(Error::NotFound),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Message, Model, ModelEvent, ModelStream};
    use futures_util::{StreamExt, stream};
    use tokio::sync::Notify;

    struct GatedModel {
        entered: Arc<Notify>,
        content: Arc<Notify>,
        finish: Arc<Notify>,
    }
    #[async_trait::async_trait]
    impl Model for GatedModel {
        fn name(&self) -> &str {
            "trace-gated-model"
        }
        async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
            self.entered.notify_one();
            self.content.notified().await;
            let finish = self.finish.clone();
            Ok(Box::pin(
                stream::iter(vec![Ok(ModelEvent::TextDelta("trace answer".into()))]).chain(
                    stream::once(async move {
                        finish.notified().await;
                        Ok(ModelEvent::Usage(areal_protocol::ModelUsage {
                            input_tokens: 7,
                            output_tokens: 2,
                            ..Default::default()
                        }))
                    }),
                ),
            ))
        }
    }
    #[tokio::test]
    async fn request_wait_content_terminal_and_saved_history_are_distinct() {
        let dir = tempfile::tempdir().unwrap();
        let model = Arc::new(GatedModel {
            entered: Arc::new(Notify::new()),
            content: Arc::new(Notify::new()),
            finish: Arc::new(Notify::new()),
        });
        let engine = Engine::open(dir.path(), model.clone(), Limits::default()).unwrap();
        let thread = engine.create("/fixture".into()).await.unwrap();
        engine
            .start(&thread.id, vec![Input::text("inspect timing")])
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10), model.entered.notified())
            .await
            .unwrap();
        let page = engine
            .execution_trace(&thread.id, None, None, None)
            .await
            .unwrap();
        assert_eq!(page["activeTurn"]["trace"]["queueDurationMs"], 0);
        let attempt = &page["activeTurn"]["trace"]["activities"][0];
        assert_eq!(attempt["kind"], "model");
        assert_eq!(attempt["status"], "running");
        assert!(attempt["firstContentMs"].is_null());
        let saved = engine
            .store
            .read_thread_snapshot_sync(&thread.id, 1024 * 1024, true)
            .unwrap();
        assert_eq!(saved.turns[0].trace.activities[0].status, "running");
        model.content.notify_one();
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let thread = engine.read(&thread.id, true).await.unwrap();
                if thread.turns[0].trace.activities[0]
                    .first_content_ms
                    .is_some()
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        model.finish.notify_one();
        let completed = engine.wait(&thread.id).await.unwrap();
        let trace = &completed.turns[0].trace.activities[0];
        assert_eq!(trace.status, "completed");
        assert_eq!(trace.usage.as_ref().unwrap().output_tokens, 2);
        assert!(trace.duration_ms.unwrap() >= trace.first_content_ms.unwrap());
        assert!(trace.completed_at_ms.is_some());
        assert!(completed.turns[0].duration_ms.unwrap() >= trace.duration_ms.unwrap());
        engine.shutdown().await;
        drop(engine);
        let reopened = Engine::open(dir.path(), model, Limits::default()).unwrap();
        let saved = reopened
            .execution_trace(&thread.id, None, None, None)
            .await
            .unwrap();
        assert!(saved["activeTurn"].is_null());
        assert!(
            saved["page"]["data"]
                .as_array()
                .unwrap()
                .iter()
                .any(|row| row["turn"]["trace"]["activities"][0]["status"] == "completed")
        );
        assert!(
            reopened
                .execution_trace(&thread.id, None, Some("foreign"), None)
                .await
                .is_err()
        );
        reopened.shutdown().await;
    }

    #[tokio::test]
    async fn native_factory_reads_live_worker_without_taking_store_ownership() {
        use crate::workgroup::service::{Factory, NativeFactory};
        let dir = tempfile::tempdir().unwrap();
        let attempt = dir.path().join("bindings/attempt-0");
        std::fs::create_dir_all(&attempt).unwrap();
        let model = Arc::new(GatedModel {
            entered: Arc::new(Notify::new()),
            content: Arc::new(Notify::new()),
            finish: Arc::new(Notify::new()),
        });
        let engine =
            Engine::open(&attempt.join("history"), model.clone(), Limits::default()).unwrap();
        let thread = engine.create("/worker-fixture".into()).await.unwrap();
        std::fs::write(
            attempt.join("binding.json"),
            serde_json::to_vec(&json!({"threadId":thread.id})).unwrap(),
        )
        .unwrap();
        engine
            .start(&thread.id, vec![Input::text("isolated input")])
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10), model.entered.notified())
            .await
            .unwrap();
        let factory = NativeFactory {
            worker_limits: Limits::default(),
            catalog: None,
            model: model.clone(),
            watchdog_disable: false,
            tool_call_limits: Default::default(),
            runtime: "unused".into(),
            file_helper: "unused".into(),
            toolchain: None,
        };
        // 以真实 Store 保存原文和其历史引用，验证读取不会接管 worker 的写锁。
        let raw = b"worker original result\n".to_vec();
        let media = engine
            .store
            .save_blob("text/plain".into(), raw.clone())
            .await
            .unwrap();
        {
            let cell = engine.raw_cell(&thread.id).await.unwrap();
            let mut state = cell.state.lock().await;
            state.thread.turns[0].items.push(serde_json::from_value(json!({
                "type":"dynamicToolCall","id":id(),"tool":"fixture","arguments":{},"status":"completed","success":true,"callId":"raw-fixture",
                "execution":{"runtimeEpoch":"fixture","scopeId":"fixture","operationId":"fixture","outcome":"succeeded","resultSnapshot":media}
            })).unwrap());
            engine.persist(&state.thread).await.unwrap();
        }
        assert_eq!(
            factory
                .trace_result(dir.path(), &thread.id, &media.uri)
                .await
                .unwrap(),
            raw
        );
        assert!(
            factory
                .trace_result(dir.path(), "foreign", &media.uri)
                .await
                .is_err()
        );
        let traces = factory.trace(dir.path()).await.unwrap();
        assert_eq!(traces.len(), 1);
        assert_eq!(traces[0].turns[0].trace.activities[0].status, "running");
        assert!(
            matches!(&traces[0].turns[0].items[0], Item::UserMessage { content, .. } if content[0].as_text() == "isolated input")
        );
        assert!(
            factory
                .trace_result(dir.path(), "foreign", "areal://blob/../../private")
                .await
                .is_err()
        );
        model.content.notify_one();
        model.finish.notify_one();
        engine.wait(&thread.id).await.unwrap();
        engine.shutdown().await;
    }
    #[tokio::test]
    async fn http_retries_retain_each_failed_attempt_and_wait() {
        use axum::{Router, response::IntoResponse, routing::post};
        use std::sync::atomic::{AtomicUsize, Ordering};
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let app = Router::new().route("/", post(move || {
            let seen = seen.clone();
            async move {
                if seen.fetch_add(1, Ordering::SeqCst) == 0 {
                    return (axum::http::StatusCode::SERVICE_UNAVAILABLE, "unavailable").into_response();
                }
                let body = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"retry succeeded\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2,\"total_tokens\":5}}\n\ndata: [DONE]\n\n";
                ([(axum::http::header::CONTENT_TYPE, "text/event-stream")], body).into_response()
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let dir = tempfile::tempdir().unwrap();
        let model = Arc::new(
            crate::model::HttpModel::new(
                format!("http://{address}/"),
                "retry-fixture".into(),
                None,
            )
            .unwrap(),
        );
        let engine = Engine::open(dir.path(), model, Limits::default()).unwrap();
        let thread = engine.create("/fixture".into()).await.unwrap();
        engine
            .start(&thread.id, vec![Input::text("inspect retries")])
            .await
            .unwrap();
        let completed = tokio::time::timeout(Duration::from_secs(10), engine.wait(&thread.id))
            .await
            .unwrap()
            .unwrap();
        let activities = &completed.turns[0].trace.activities;
        let attempts: Vec<_> = activities.iter().filter(|a| a.kind == "model").collect();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(attempts.len(), 2);
        assert_eq!(attempts[0].status, "failed");
        assert_eq!(attempts[1].status, "completed", "{:?}", completed.turns[0]);
        assert_eq!(attempts[0].logical_id, attempts[1].logical_id);
        assert_eq!(attempts[0].after_item_id, attempts[1].after_item_id);
        assert_eq!(
            activities
                .iter()
                .filter(|a| a.kind == "retryWait" && a.status == "completed")
                .count(),
            1
        );
        assert_eq!(completed.turns[0].status, TurnStatus::Completed);
        engine.shutdown().await;
        server.abort();
    }
    #[tokio::test]
    async fn legacy_nested_children_are_readable_and_stop_counting_after_shutdown() {
        struct Held(std::sync::atomic::AtomicUsize);
        #[async_trait::async_trait]
        impl Model for Held {
            fn name(&self) -> &str {
                "legacy-nested-trace"
            }
            async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
                self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(Box::pin(stream::pending()))
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let model = Arc::new(Held(std::sync::atomic::AtomicUsize::new(0)));
        let engine = Engine::open(dir.path(), model.clone(), Limits::default()).unwrap();
        let parent = engine.create("/fixture".into()).await.unwrap();
        engine
            .start(&parent.id, vec![Input::text("parent")])
            .await
            .unwrap();
        let (child, _) = engine
            .spawn_child(&parent.id, vec![Input::text("child")])
            .await
            .unwrap();
        let (nested, _) = engine
            .spawn_child(&child.id, vec![Input::text("nested evidence")])
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            while model.0.load(std::sync::atomic::Ordering::SeqCst) < 3 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let root = engine
            .execution_trace(&parent.id, None, None, None)
            .await
            .unwrap();
        assert!(
            root["legacySources"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v["threadId"] == child.id)
        );
        let branch = engine
            .execution_trace(&child.id, None, None, None)
            .await
            .unwrap();
        assert!(
            branch["legacySources"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v["threadId"] == nested.id)
        );
        let leaf = engine
            .execution_trace(&nested.id, None, None, None)
            .await
            .unwrap();
        assert_eq!(
            leaf["activeTurn"]["items"][0]["content"][0]["text"],
            "nested evidence"
        );
        assert_eq!(
            leaf["activeTurn"]["trace"]["activities"][0]["kind"],
            "model"
        );
        tokio::time::timeout(Duration::from_secs(15), engine.shutdown())
            .await
            .unwrap();
        let stopped = engine
            .execution_trace(&nested.id, None, None, None)
            .await
            .unwrap();
        assert!(stopped["activeTurn"].is_null());
        assert!(
            stopped["page"]["data"]
                .as_array()
                .unwrap()
                .iter()
                .all(|v| v["turn"]["status"] != "inProgress")
        );
    }
}
