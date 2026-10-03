//! 请求先持久预留再发送；未落盘的结算在重启后保守恢复为未知消费。
use super::*;
use crate::model::{ModelLoad, ModelStream, RequestPurpose, ToolCallLimits};
use futures_util::Stream;
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    pin::Pin,
    sync::Mutex as StdMutex,
    task::{Context, Poll},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    owner: Option<(String, String)>,
    purpose: String,
    reserved: u64,
    usage: Option<areal_protocol::ModelUsage>,
    settled: bool,
    unknown: bool,
    #[serde(default)]
    acknowledged: bool,
}
#[derive(Clone, Serialize, Deserialize)]
struct Journal {
    goal_id: String,
    requests: BTreeMap<String, Request>,
    seconds: f64,
    timing_complete: bool,
}
struct Data {
    journal: Journal,
    token_budget: Option<u64>,
    running: Option<tokio::time::Instant>,
    running_scopes: usize,
    enabled: bool,
    poisoned: bool,
}
/// 同一个目标的主模型、子模型和 Workgroup 共享的计量上下文。
pub struct Budget {
    goal_id: String,
    path: PathBuf,
    data: StdMutex<Data>,
    io: Arc<Mutex<()>>,
}
impl Budget {
    pub(crate) fn open(root: &Path, goal: &Goal) -> anyhow::Result<Arc<Self>> {
        uuid::Uuid::parse_str(&goal.id)?;
        let dir = root.join("goals");
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(format!("{}.json", goal.id));
        let mut journal = if path.exists() {
            anyhow::ensure!(
                std::fs::metadata(&path)?.len() <= 4 * 1024 * 1024,
                "goal journal capacity exceeded"
            );
            let value: Journal = serde_json::from_slice(&std::fs::read(&path)?)?;
            anyhow::ensure!(value.goal_id == goal.id, "goal journal identity mismatch");
            value
        } else {
            anyhow::ensure!(goal.usage.turns_started == 0, "goal journal missing");
            Journal {
                goal_id: goal.id.clone(),
                requests: BTreeMap::new(),
                seconds: 0.0,
                timing_complete: true,
            }
        };
        if goal.reason.as_deref() == Some("serverRestarted") {
            journal.timing_complete = false;
        }
        for request in journal.requests.values_mut().filter(|r| !r.settled) {
            request.unknown = true;
            request.settled = true;
            journal.timing_complete = false;
        }
        Ok(Arc::new(Self {
            goal_id: goal.id.clone(),
            path,
            io: Arc::new(Mutex::new(())),
            data: StdMutex::new(Data {
                journal,
                token_budget: goal.token_budget,
                running: None,
                running_scopes: 0,
                enabled: false,
                poisoned: false,
            }),
        }))
    }
    pub fn wrap(self: &Arc<Self>, model: Arc<dyn Model>) -> Arc<dyn Model> {
        if model.goal_id() == Some(&self.goal_id) {
            return model;
        }
        Arc::new(MeteredModel {
            inner: model,
            budget: self.clone(),
        })
    }
    pub(crate) fn configure(&self, tokens: Option<u64>, enabled: bool) {
        let mut d = self.data.lock().unwrap();
        d.token_budget = tokens;
        d.enabled = enabled;
    }
    pub(crate) fn begin(&self) {
        let mut d = self.data.lock().unwrap();
        if d.running_scopes == 0 {
            d.running = Some(tokio::time::Instant::now());
        }
        d.running_scopes += 1;
    }
    pub(crate) fn end(&self) {
        let mut d = self.data.lock().unwrap();
        d.running_scopes = d.running_scopes.saturating_sub(1);
        if d.running_scopes == 0 {
            checkpoint(&mut d);
            d.running = None;
        }
    }
    pub(crate) fn usage(&self) -> GoalUsage {
        let d = self.data.lock().unwrap();
        usage(&d)
    }
    pub(crate) fn unknown_pending(&self) -> bool {
        self.data
            .lock()
            .unwrap()
            .journal
            .requests
            .values()
            .any(|r| r.unknown && !r.acknowledged)
    }
    pub(crate) fn acknowledge_usage(&self) {
        for r in self
            .data
            .lock()
            .unwrap()
            .journal
            .requests
            .values_mut()
            .filter(|r| r.unknown)
        {
            r.acknowledged = true;
        }
    }
    pub(crate) fn guard(&self) -> anyhow::Result<()> {
        let d = self.data.lock().unwrap();
        anyhow::ensure!(!d.poisoned, "GOAL_STORAGE_FAILED");
        anyhow::ensure!(d.enabled, "GOAL_STOPPED");
        let u = usage(&d);
        anyhow::ensure!(
            !d.journal
                .requests
                .values()
                .any(|r| r.unknown && !r.acknowledged),
            "GOAL_USAGE_UNKNOWN"
        );
        anyhow::ensure!(
            d.token_budget
                .is_none_or(|limit| u.tokens_used.saturating_add(u.reserved_tokens) < limit),
            "GOAL_TOKEN_BUDGET"
        );
        Ok(())
    }
    pub(crate) async fn flush(&self) -> anyhow::Result<()> {
        let gate = self.io.clone().lock_owned().await;
        self.save(gate).await
    }
    async fn save(&self, gate: tokio::sync::OwnedMutexGuard<()>) -> anyhow::Result<()> {
        let journal = {
            let mut d = self.data.lock().unwrap();
            checkpoint(&mut d);
            d.journal.clone()
        };
        let path = self.path.clone();
        let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
            let _gate = gate;
            let bytes = serde_json::to_vec(&journal)?;
            anyhow::ensure!(
                bytes.len() <= 4 * 1024 * 1024,
                "goal journal capacity exceeded"
            );
            let dir = path.parent().unwrap();
            let mut file = tempfile::NamedTempFile::new_in(dir)?;
            std::io::Write::write_all(&mut file, &bytes)?;
            file.as_file().sync_all()?;
            file.persist(&path)?;
            std::fs::File::open(dir)?.sync_all()?;
            Ok(())
        })
        .await?;
        if result.is_err() {
            self.data.lock().unwrap().poisoned = true;
        }
        result
    }
    async fn reserve(
        self: &Arc<Self>,
        estimate: u64,
        purpose: RequestPurpose,
    ) -> anyhow::Result<(Guard, Option<u64>)> {
        let gate = self.io.clone().lock_owned().await;
        self.guard()?;
        let key = id();
        let cap = {
            let mut d = self.data.lock().unwrap();
            anyhow::ensure!(d.journal.requests.len() < 4096, "GOAL_REQUEST_CAPACITY");
            let u = usage(&d);
            let cap = if let Some(limit) = d.token_budget {
                let available = limit
                    .saturating_sub(u.tokens_used)
                    .saturating_sub(u.reserved_tokens);
                anyhow::ensure!(available > estimate, "GOAL_TOKEN_BUDGET");
                Some((available - estimate).min(16384))
            } else {
                None
            };
            d.journal.requests.insert(
                key.clone(),
                Request {
                    owner: model::REQUEST_OWNER.try_with(Clone::clone).ok(),
                    purpose: format!("{purpose:?}"),
                    reserved: estimate.saturating_add(cap.unwrap_or(16384)),
                    usage: None,
                    settled: false,
                    unknown: false,
                    acknowledged: false,
                },
            );
            cap
        };
        let guard = Guard {
            budget: self.clone(),
            key,
            complete: false,
        };
        self.save(gate).await?;
        Ok((guard, cap))
    }
}
fn checkpoint(d: &mut Data) {
    if let Some(start) = d.running.replace(tokio::time::Instant::now()) {
        d.journal.seconds += start.elapsed().as_secs_f64();
    } else {
        d.running = None;
    }
}
fn usage(d: &Data) -> GoalUsage {
    let mut u = GoalUsage {
        time_used_seconds: d.journal.seconds + d.running.map_or(0.0, |v| v.elapsed().as_secs_f64()),
        accounting_complete: d.journal.timing_complete,
        ..Default::default()
    };
    for request in d.journal.requests.values() {
        if let Some(known) = &request.usage {
            u.input_tokens = u.input_tokens.saturating_add(known.input_tokens);
            u.output_tokens = u.output_tokens.saturating_add(known.output_tokens);
            u.cached_input_tokens = u
                .cached_input_tokens
                .saturating_add(known.cached_input_tokens);
        }
        if !request.settled || request.unknown {
            u.reserved_tokens = u.reserved_tokens.saturating_add(request.reserved);
        }
        if request.unknown {
            u.unknown_requests += 1;
            u.accounting_complete = false;
        }
    }
    u.tokens_used = u.input_tokens.saturating_add(u.output_tokens);
    u
}
struct Guard {
    budget: Arc<Budget>,
    key: String,
    complete: bool,
}
impl Drop for Guard {
    fn drop(&mut self) {
        let mut d = self.budget.data.lock().unwrap();
        if let Some(r) = d.journal.requests.get_mut(&self.key) {
            r.settled = true;
            r.unknown = !self.complete || r.usage.is_none();
        }
    }
}
struct MeteredStream {
    inner: ModelStream,
    guard: Option<Guard>,
    truncated: Option<anyhow::Error>,
}
impl Stream for MeteredStream {
    type Item = anyhow::Result<ModelEvent>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.guard.is_none() {
            return Poll::Ready(None);
        }
        let next = self.inner.as_mut().poll_next(cx);
        // 长度终止已经由解码器确认；先读到 EOF 结算，再把原错误交给消费者。
        // 取消、空闲超时和无用量仍保留 UNKNOWN，不把一般传输错误当作完整响应。
        if let Poll::Ready(Some(Err(error))) = next {
            if self.truncated.is_none()
                && error.downcast_ref::<model::ModelFailure>()
                    == Some(&model::ModelFailure::Truncated)
            {
                self.truncated = Some(error);
                cx.waker().wake_by_ref();
                return Poll::Pending;
            }
            self.guard.take();
            return Poll::Ready(Some(Err(self.truncated.take().unwrap_or(error))));
        }
        if let Poll::Ready(Some(Ok(ModelEvent::Usage(value)))) = &next {
            let guard = self.guard.as_ref().unwrap();
            let mut d = guard.budget.data.lock().unwrap();
            d.journal
                .requests
                .get_mut(&guard.key)
                .unwrap()
                .usage
                .get_or_insert_with(Default::default)
                .add_assign(value);
        }
        if matches!(next, Poll::Ready(None))
            && let Some(mut guard) = self.guard.take()
        {
            guard.complete = true;
        }
        if matches!(next, Poll::Ready(None)) {
            if let Some(error) = self.truncated.take() {
                return Poll::Ready(Some(Err(error)));
            }
        } else if self.truncated.is_some()
            && matches!(next, Poll::Ready(Some(Ok(ref event))) if !matches!(event, ModelEvent::Usage(_)))
        {
            // 失败响应的工具、文本和媒体不向调用方释放；尾部用量仍正常计入审计。
            cx.waker().wake_by_ref();
            return Poll::Pending;
        }
        next
    }
}
struct MeteredModel {
    inner: Arc<dyn Model>,
    budget: Arc<Budget>,
}
#[async_trait::async_trait]
impl Model for MeteredModel {
    fn goal_id(&self) -> Option<&str> {
        Some(&self.budget.goal_id)
    }
    fn check_work(&self) -> anyhow::Result<()> {
        self.budget.guard()?;
        self.inner.check_work()
    }
    fn configure(
        &self,
        p: &areal_protocol::desktop::ModelParameters,
    ) -> anyhow::Result<Arc<dyn Model>> {
        Ok(self.budget.wrap(self.inner.configure(p)?))
    }
    fn share_capacity(&self, inner: Arc<dyn Model>) -> Arc<dyn Model> {
        self.budget.wrap(self.inner.share_capacity(inner))
    }
    fn share_context(&self, inner: Arc<dyn Model>) -> Arc<dyn Model> {
        self.budget.wrap(self.inner.share_context(inner))
    }
    fn name(&self) -> &str {
        self.inner.name()
    }
    fn provider(&self) -> &str {
        self.inner.provider()
    }
    fn capabilities(&self) -> ModelCapabilities {
        self.inner.capabilities()
    }
    fn load(&self) -> Option<ModelLoad> {
        self.inner.load()
    }
    async fn stream(&self, messages: Vec<Message>) -> anyhow::Result<ModelStream> {
        self.chat(messages, vec![]).await
    }
    async fn chat(&self, messages: Vec<Message>, tools: Vec<Value>) -> anyhow::Result<ModelStream> {
        self.chat_for(messages, tools, RequestPurpose::Solve).await
    }
    async fn chat_for(
        &self,
        messages: Vec<Message>,
        tools: Vec<Value>,
        purpose: RequestPurpose,
    ) -> anyhow::Result<ModelStream> {
        self.chat_limited(messages, tools, purpose, None).await
    }
    async fn chat_limited(
        &self,
        messages: Vec<Message>,
        tools: Vec<Value>,
        purpose: RequestPurpose,
        cap: Option<u64>,
    ) -> anyhow::Result<ModelStream> {
        self.chat_with_limits(messages, tools, purpose, ToolCallLimits::default(), cap)
            .await
    }
    async fn chat_with_limits(
        &self,
        messages: Vec<Message>,
        tools: Vec<Value>,
        purpose: RequestPurpose,
        limits: ToolCallLimits,
        outer_cap: Option<u64>,
    ) -> anyhow::Result<ModelStream> {
        let estimate = (context::estimate_tokens(&messages)
            + context::text_tokens(&serde_json::to_string(&tools)?)) as u64;
        let (guard, cap) = self.budget.reserve(estimate, purpose).await?;
        let cap = match (cap, outer_cap) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        let inner = model::GOAL_REQUEST
            .scope(
                (),
                self.inner
                    .chat_with_limits(messages, tools, purpose, limits, cap),
            )
            .await?;
        Ok(Box::pin(MeteredStream {
            inner,
            guard: Some(guard),
            truncated: None,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;
    fn fixture(root: &Path, tokens: u64) -> Arc<Budget> {
        let goal: Goal = serde_json::from_value(json!({
            "id":id(),"threadId":id(),"objective":"test","status":"active",
            "maxTurns":10,"maxActiveSeconds":60,"usage":GoalUsage::default(),
            "settling":false,"waitingForInput":false,"waitingForCapacity":false,"unreportedTurns":0
        }))
        .unwrap();
        let budget = Budget::open(root, &goal).unwrap();
        budget.configure(Some(tokens), true);
        budget
    }
    struct Known;
    #[async_trait::async_trait]
    impl Model for Known {
        fn name(&self) -> &str {
            "known"
        }
        fn configure(
            &self,
            _: &areal_protocol::desktop::ModelParameters,
        ) -> anyhow::Result<Arc<dyn Model>> {
            Ok(Arc::new(Self))
        }
        async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
            Ok(Box::pin(futures_util::stream::iter([Ok(
                ModelEvent::Usage(areal_protocol::ModelUsage {
                    input_tokens: 20,
                    cached_input_tokens: 5,
                    output_tokens: 10,
                }),
            )])))
        }
        async fn chat_limited(
            &self,
            m: Vec<Message>,
            _: Vec<Value>,
            _: RequestPurpose,
            cap: Option<u64>,
        ) -> anyhow::Result<ModelStream> {
            assert!(cap.is_some_and(|v| v > 0));
            self.stream(m).await
        }
    }
    #[tokio::test]
    async fn terminal_length_error_settles_only_after_eof_and_known_usage() {
        for before in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let budget = fixture(dir.path(), 1000);
            let (guard, _) = budget.reserve(100, RequestPurpose::Summary).await.unwrap();
            let usage = || {
                Ok(ModelEvent::Usage(areal_protocol::ModelUsage {
                    input_tokens: 20,
                    cached_input_tokens: 5,
                    output_tokens: 10,
                }))
            };
            let mut events = vec![];
            if before {
                events.push(usage());
            }
            events.push(Err(model::ModelFailure::Truncated.into()));
            events.push(Ok(ModelEvent::text("must not escape a failed response")));
            if !before {
                events.push(usage());
            }
            let mut stream = MeteredStream {
                inner: Box::pin(futures_util::stream::iter(events)),
                guard: Some(guard),
                truncated: None,
            };
            let mut observed = 0;
            while let Some(event) = stream.next().await {
                match event {
                    Ok(ModelEvent::Usage(_)) => observed += 1,
                    Err(error) => {
                        assert_eq!(
                            error.downcast_ref::<model::ModelFailure>(),
                            Some(&model::ModelFailure::Truncated)
                        );
                        break;
                    }
                    _ => panic!("failed response content escaped"),
                }
            }
            drop(stream);
            assert_eq!(observed, 1);
            assert_eq!(budget.usage().tokens_used, 30);
            assert_eq!(budget.usage().reserved_tokens, 0);
            assert_eq!(budget.usage().unknown_requests, 0);
        }
    }

    #[tokio::test]
    async fn missing_usage_transport_failure_and_cancelled_length_drain_stay_unknown() {
        for case in 0..3 {
            let dir = tempfile::tempdir().unwrap();
            let budget = fixture(dir.path(), 1000);
            let (guard, _) = budget.reserve(100, RequestPurpose::Summary).await.unwrap();
            let mut events = vec![];
            if case != 0 {
                events.push(Ok(ModelEvent::Usage(areal_protocol::ModelUsage {
                    input_tokens: 20,
                    cached_input_tokens: 5,
                    output_tokens: 10,
                })));
            }
            events.push(Err(if case == 1 {
                model::ModelFailure::Transport
            } else {
                model::ModelFailure::Truncated
            }
            .into()));
            let source: ModelStream = if case == 2 {
                Box::pin(futures_util::stream::iter(events).chain(futures_util::stream::pending()))
            } else {
                Box::pin(futures_util::stream::iter(events))
            };
            let mut stream = MeteredStream {
                inner: source,
                guard: Some(guard),
                truncated: None,
            };
            let _ = tokio::time::timeout(std::time::Duration::from_millis(20), async {
                while let Some(event) = stream.next().await {
                    if event.is_err() {
                        break;
                    }
                }
            })
            .await;
            drop(stream);
            assert_eq!(budget.usage().unknown_requests, 1);
            assert!(budget.usage().reserved_tokens > 0);
            assert!(!budget.usage().accounting_complete);
        }
    }

    #[tokio::test]
    async fn parallel_reservations_cannot_spend_the_same_remaining_budget() {
        let dir = tempfile::tempdir().unwrap();
        let budget = fixture(dir.path(), 1000);
        let (first, second) = tokio::join!(budget.reserve(100, RequestPurpose::Solve), async {
            tokio::task::yield_now().await;
            budget.reserve(100, RequestPurpose::Summary).await
        });
        let (mut first, cap) = first.unwrap();
        // 一次预留保留剩余输出额度；并发请求必须等已知用量归还后再获准。
        assert_eq!(cap, Some(900));
        assert!(second.is_err());
        budget
            .data
            .lock()
            .unwrap()
            .journal
            .requests
            .get_mut(&first.key)
            .unwrap()
            .usage = Some(areal_protocol::ModelUsage {
            input_tokens: 20,
            cached_input_tokens: 5,
            output_tokens: 10,
        });
        first.complete = true;
        drop(first);
        assert_eq!(budget.usage().tokens_used, 30);
        let (_, cap) = budget.reserve(100, RequestPurpose::Summary).await.unwrap();
        assert_eq!(cap, Some(870));
    }
    #[tokio::test]
    async fn nested_workgroup_pools_model_switch_and_summary_keep_one_ledger() {
        use crate::workgroup::native::SharedModel;
        let dir = tempfile::tempdir().unwrap();
        let budget = fixture(dir.path(), 100000);
        let pool = SharedModel::new(budget.wrap(Arc::new(Known)), 2, 10).unwrap();
        let nested = SharedModel::new(budget.wrap(pool), 2, 10).unwrap();
        let configured = nested.configure(&Default::default()).unwrap();
        let switched = configured.share_capacity(Arc::new(Known));
        for purpose in [RequestPurpose::Solve, RequestPurpose::Summary] {
            let mut stream = switched
                .chat_for(vec![Message::text("user", "work")], vec![], purpose)
                .await
                .unwrap();
            while let Some(event) = stream.next().await {
                event.unwrap();
            }
        }
        assert_eq!(budget.usage().tokens_used, 60);
        assert_eq!(budget.usage().cached_input_tokens, 10);
        assert_eq!(budget.data.lock().unwrap().journal.requests.len(), 2);
        assert!(
            budget
                .data
                .lock()
                .unwrap()
                .journal
                .requests
                .values()
                .any(|r| r.purpose == "Summary")
        );
        assert_eq!(budget.usage().reserved_tokens, 0);
    }
    #[tokio::test]
    async fn bounded_cancel_drain_settles_known_tail_but_keeps_missing_usage_unknown() {
        let dir = tempfile::tempdir().unwrap();
        let budget = fixture(dir.path(), 100000);
        let mut known = budget
            .wrap(Arc::new(Known))
            .chat_for(
                vec![Message::text("user", "work")],
                vec![],
                RequestPurpose::Solve,
            )
            .await
            .unwrap();
        crate::generation::settle_cancelled_stream(&mut known).await;
        drop(known);
        assert_eq!(budget.usage().tokens_used, 30);
        assert_eq!(budget.usage().reserved_tokens, 0);
        assert!(!budget.unknown_pending());
        let (guard, _) = budget.reserve(100, RequestPurpose::Summary).await.unwrap();
        let mut missing: ModelStream = Box::pin(MeteredStream {
            inner: Box::pin(futures_util::stream::pending()),
            guard: Some(guard),
            truncated: None,
        });
        tokio::time::timeout(
            Duration::from_secs(3),
            crate::generation::settle_cancelled_stream(&mut missing),
        )
        .await
        .unwrap();
        drop(missing);
        assert!(budget.unknown_pending());
        assert_eq!(budget.usage().tokens_used, 30);
        assert!(budget.usage().reserved_tokens > 0);
    }
}
