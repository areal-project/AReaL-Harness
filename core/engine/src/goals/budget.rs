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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    failure: Option<areal_protocol::TurnOutcome>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Journal {
    goal_id: String,
    requests: BTreeMap<String, Request>,
    seconds: f64,
    timing_complete: bool,
    #[serde(default)]
    settled_usage: areal_protocol::ModelUsage,
    #[serde(default)]
    archive_head: Option<String>,
}
fn token_budget_exhausted() -> anyhow::Error {
    crate::outcome::TerminalFailure::new(
        "GOAL_TOKEN_BUDGET",
        crate::outcome::outcome(
            "GOAL_TOKEN_BUDGET",
            "agent",
            "core_goal_token_budget",
            json!({}),
        ),
    )
    .into()
}
struct Data {
    journal: Journal,
    token_budget: Option<u64>,
    max_active_seconds: Option<u64>,
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
    deadline_changed: tokio::sync::Notify,
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
                settled_usage: Default::default(),
                archive_head: None,
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
            deadline_changed: tokio::sync::Notify::new(),
            data: StdMutex::new(Data {
                journal,
                token_budget: goal.token_budget,
                max_active_seconds: goal.max_active_seconds,
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
    pub(crate) fn set_time_limit(&self, seconds: Option<u64>) {
        self.data.lock().unwrap().max_active_seconds = seconds;
        self.deadline_changed.notify_waiters();
    }
    pub(crate) fn deadline(&self) -> Option<tokio::time::Instant> {
        let d = self.data.lock().unwrap();
        let seconds = d.max_active_seconds?;
        let remaining = Duration::from_secs(seconds).saturating_sub(Duration::from_secs_f64(
            usage(&d).time_used_seconds.max(0.0),
        ));
        let now = tokio::time::Instant::now();
        // 无法表示的旧截止时间保守停止，不能把显式限制误变为无限。
        Some(now.checked_add(remaining).unwrap_or(now))
    }
    // 限制解释发生在首个模型请求后；根与子任务等待同一个可更新截止时间。
    pub(crate) async fn wait_deadline(&self) {
        loop {
            let changed = self.deadline_changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let expires = async {
                match self.deadline() {
                    Some(deadline) => tokio::time::sleep_until(deadline).await,
                    None => std::future::pending::<()>().await,
                }
            };
            tokio::select! { _ = &mut changed => {}, _ = expires => return }
        }
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
    pub(crate) fn owner_status(&self, thread: &str, turn: &str) -> Value {
        let d = self.data.lock().unwrap();
        let requests: Vec<_> = d
            .journal
            .requests
            .values()
            .filter(|r| {
                r.owner
                    .as_ref()
                    .is_some_and(|(t, v)| t == thread && v == turn)
            })
            .collect();
        let pending = requests.iter().filter(|r| !r.settled).count();
        let unknown = requests.iter().filter(|r| r.unknown).count();
        json!({"usageSettled":pending==0 && unknown==0,"pendingRequests":pending,"unknownRequests":unknown,"scope":"this child turn, not the whole Goal"})
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
        if let Some((request_id, request)) = d
            .journal
            .requests
            .iter()
            .filter(|(_, r)| r.unknown && !r.acknowledged)
            // 取消其他请求也会留下未知消费，优先报告确实观察到的模型失败。
            .max_by_key(|(_, r)| r.failure.is_some())
        {
            if let Some(failure) = &request.failure {
                let mut outcome = failure.clone();
                outcome.details = Some(json!({
                    "cause":failure.details,"goalId":self.goal_id,
                    "requestId":request_id,"owner":request.owner,"usageUnknown":true
                }));
                return Err(crate::outcome::TerminalFailure::new(
                    format!(
                        "GOAL_USAGE_UNKNOWN: {} from {} (request {}, owner {:?}); inspect the failed model request, then use /goal-resume to acknowledge the reserved usage and continue",
                        failure.code, failure.source, request_id, request.owner
                    ),
                    outcome,
                ).into());
            }
            anyhow::bail!(
                "GOAL_USAGE_UNKNOWN: model usage is unconfirmed; inspect the failed request, then use /goal-resume to acknowledge the reserved usage and continue"
            );
        }
        if d.token_budget
            .is_some_and(|limit| u.tokens_used.saturating_add(u.reserved_tokens) >= limit)
        {
            return Err(token_budget_exhausted());
        }
        Ok(())
    }
    pub(crate) async fn flush(&self) -> anyhow::Result<()> {
        let gate = self.io.clone().lock_owned().await;
        self.save(gate).await
    }
    async fn save(&self, gate: tokio::sync::OwnedMutexGuard<()>) -> anyhow::Result<()> {
        let (journal, archive) = {
            let mut d = self.data.lock().unwrap();
            checkpoint(&mut d);
            // 仅滚动已确认结算的记录；未知消费与在途预留始终留在热账本。
            let archive = if d.journal.requests.len() >= 128 {
                let settled: BTreeMap<_, _> = d
                    .journal
                    .requests
                    .iter()
                    .filter(|(_, r)| r.settled && !r.unknown)
                    .map(|(id, r)| (id.clone(), r.clone()))
                    .collect();
                if settled.is_empty() {
                    None
                } else {
                    let bytes = serde_json::to_vec(
                        &json!({"previous":d.journal.archive_head,"requests":settled}),
                    )?;
                    use sha2::{Digest, Sha256};
                    let digest = format!("{:x}", Sha256::digest(&bytes));
                    for (id, request) in settled {
                        if let Some(usage) = request.usage {
                            d.journal.settled_usage.add_assign(&usage);
                        }
                        d.journal.requests.remove(&id);
                    }
                    d.journal.archive_head = Some(digest.clone());
                    Some((digest, bytes))
                }
            } else {
                None
            };
            (d.journal.clone(), archive)
        };
        let path = self.path.clone();
        let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
            let _gate = gate;
            let dir = path.parent().unwrap();
            if let Some((digest, bytes)) = archive {
                let archive_dir = dir.join("requests");
                std::fs::create_dir_all(&archive_dir)?;
                let mut file = tempfile::NamedTempFile::new_in(&archive_dir)?;
                std::io::Write::write_all(&mut file, &bytes)?;
                file.as_file().sync_all()?;
                file.persist(archive_dir.join(digest))?;
                std::fs::File::open(&archive_dir)?.sync_all()?;
            }
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
            let u = usage(&d);
            let cap = if let Some(limit) = d.token_budget {
                let available = limit
                    .saturating_sub(u.tokens_used)
                    .saturating_sub(u.reserved_tokens);
                if available <= estimate {
                    return Err(token_budget_exhausted());
                }
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
                    failure: None,
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
        input_tokens: d.journal.settled_usage.input_tokens,
        output_tokens: d.journal.settled_usage.output_tokens,
        cached_input_tokens: d.journal.settled_usage.cached_input_tokens,
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
impl Guard {
    fn record_failure(&self, error: &anyhow::Error) {
        // 仅保存协议分类，不能把上游原文、提示词或凭据复制进共享账本。
        let failure = crate::outcome::turn_error(error).outcome;
        if let Some(request) = self
            .budget
            .data
            .lock()
            .unwrap()
            .journal
            .requests
            .get_mut(&self.key)
        {
            request.failure = failure;
        }
    }
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
}
impl Stream for MeteredStream {
    type Item = anyhow::Result<ModelEvent>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let next = self.inner.as_mut().poll_next(cx);
        if let Poll::Ready(Some(Err(error))) = &next
            && let Some(guard) = &self.guard
        {
            guard.record_failure(error);
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
        // 摘要/推理失败不等于消费未知；仅信任适配器确认的最终用量证据。
        let final_usage_error =
            matches!(&next, Poll::Ready(Some(Err(error))) if error.is::<model::FinalUsageError>());
        if (matches!(next, Poll::Ready(None)) || final_usage_error)
            && let Some(mut guard) = self.guard.take()
        {
            guard.complete = true;
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
    fn replay_protocol(&self) -> Option<crate::model::ModelProtocol> {
        self.inner.replay_protocol()
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
            .await;
        let inner = match inner {
            Ok(inner) => inner,
            Err(error) => {
                guard.record_failure(&error);
                return Err(error);
            }
        };
        Ok(Box::pin(MeteredStream {
            inner,
            guard: Some(guard),
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
    #[tokio::test]
    async fn child_failure_survives_shared_guard_and_journal_reload() {
        let dir = tempfile::tempdir().unwrap();
        let budget = fixture(dir.path(), 100000);
        let (guard, _) = model::REQUEST_OWNER
            .scope(
                ("child".into(), "child-turn".into()),
                budget.reserve(100, RequestPurpose::Solve),
            )
            .await
            .unwrap();
        let request_id = guard.key.clone();
        let failure = crate::outcome::outcome(
            "LLM_RESPONSE_FAILED",
            "infrastructure",
            "provider_stream",
            json!({"eventType":"error"}),
        );
        let mut stream = MeteredStream {
            inner: Box::pin(futures_util::stream::iter([Err(
                crate::outcome::TerminalFailure::new("private provider text", failure).into(),
            )])),
            guard: Some(guard),
        };
        assert!(stream.next().await.unwrap().is_err());
        drop(stream);
        // 其他子请求被取消后也未知，但不能覆盖真正的上游失败来源。
        budget.data.lock().unwrap().journal.requests.insert(
            "cancelled".into(),
            Request {
                owner: None,
                purpose: "Solve".into(),
                reserved: 100,
                usage: None,
                settled: true,
                unknown: true,
                acknowledged: false,
                failure: None,
            },
        );
        budget.flush().await.unwrap();
        let journal_text = std::fs::read_to_string(&budget.path).unwrap();
        assert!(!journal_text.contains("private provider text"));
        let goal: Goal = serde_json::from_value(json!({
            "id":budget.goal_id,"threadId":id(),"objective":"test","status":"blocked",
            "usage":budget.usage(),"settling":false,"waitingForInput":false,
            "waitingForCapacity":false,"unreportedTurns":0
        }))
        .unwrap();
        let restored = Budget::open(dir.path(), &goal).unwrap();
        restored.configure(None, true);
        let error = restored.guard().unwrap_err();
        assert!(
            error
                .to_string()
                .contains("GOAL_USAGE_UNKNOWN: LLM_RESPONSE_FAILED")
        );
        assert!(error.to_string().contains("child-turn"));
        assert!(error.to_string().contains("/goal-resume"));
        let outcome = crate::outcome::turn_error(&error).outcome.unwrap();
        assert_eq!(outcome.source, "provider_stream");
        assert_eq!(outcome.details.as_ref().unwrap()["requestId"], request_id);
        assert_eq!(outcome.details.as_ref().unwrap()["usageUnknown"], true);
        assert!(restored.unknown_pending());
        restored.acknowledge_usage();
        assert!(restored.guard().is_ok());
        assert!(!restored.usage().accounting_complete);
        assert!(restored.usage().reserved_tokens > 0);
    }

    #[tokio::test]
    async fn unlimited_request_journal_rolls_without_resetting_usage() {
        let dir = tempfile::tempdir().unwrap();
        let budget = fixture(dir.path(), 1);
        budget.configure(None, true);
        for _ in 0..4100 {
            let (mut guard, cap) = budget.reserve(100, RequestPurpose::Solve).await.unwrap();
            assert_eq!(cap, None);
            budget
                .data
                .lock()
                .unwrap()
                .journal
                .requests
                .get_mut(&guard.key)
                .unwrap()
                .usage = Some(areal_protocol::ModelUsage {
                input_tokens: 20,
                output_tokens: 10,
                cached_input_tokens: 5,
            });
            guard.complete = true;
            drop(guard);
        }
        budget.flush().await.unwrap();
        let usage = budget.usage();
        assert_eq!(usage.tokens_used, 123000);
        assert_eq!(usage.cached_input_tokens, 20500);
        assert_eq!(usage.reserved_tokens, 0);
        let journal: Journal =
            serde_json::from_slice(&std::fs::read(&budget.path).unwrap()).unwrap();
        assert!(journal.requests.len() < 128);
        assert!(journal.archive_head.is_some());
        let goal: Goal = serde_json::from_value(json!({
            "id":budget.goal_id,"threadId":id(),"objective":"test","status":"paused",
            "usage":usage,"settling":false,"waitingForInput":false,"waitingForCapacity":false,"unreportedTurns":0
        })).unwrap();
        let restored = Budget::open(dir.path(), &goal).unwrap();
        assert_eq!(restored.usage().tokens_used, 123000);
        restored.configure(Some(123000), true);
        assert!(restored.reserve(1, RequestPurpose::Solve).await.is_err());
        restored.configure(None, true);
        let (unknown, _) = restored.reserve(1, RequestPurpose::Solve).await.unwrap();
        drop(unknown);
        assert!(restored.unknown_pending());
        assert!(restored.reserve(1, RequestPurpose::Solve).await.is_err());
    }
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
    async fn terminal_usage_failure_settles_but_partial_usage_stays_unknown() {
        for finalized in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let budget = fixture(dir.path(), 100000);
            let (guard, _) = budget.reserve(100, RequestPurpose::Summary).await.unwrap();
            let error = anyhow::Error::new(model::ModelFailure::Truncated);
            let error = if finalized {
                error.context(model::FinalUsageError)
            } else {
                error
            };
            let mut stream = MeteredStream {
                inner: Box::pin(futures_util::stream::iter([
                    Ok(ModelEvent::Usage(areal_protocol::ModelUsage {
                        input_tokens: 20,
                        cached_input_tokens: 5,
                        output_tokens: 10,
                    })),
                    Err(error),
                ])),
                guard: Some(guard),
            };
            assert!(stream.next().await.unwrap().is_ok());
            assert!(stream.next().await.unwrap().is_err());
            // 调用者遇到错误立即退出，不要求再 poll 一次 EOF 才结算。
            drop(stream);
            assert_eq!(budget.usage().tokens_used, 30);
            assert_eq!(budget.unknown_pending(), !finalized);
            assert_eq!(budget.usage().reserved_tokens == 0, finalized);
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
        crate::generation::settle_cancelled_stream(&mut known, Duration::from_secs(1)).await;
        drop(known);
        assert_eq!(budget.usage().tokens_used, 30);
        assert_eq!(budget.usage().reserved_tokens, 0);
        assert!(!budget.unknown_pending());
        let (guard, _) = budget.reserve(100, RequestPurpose::Summary).await.unwrap();
        let mut missing: ModelStream = Box::pin(MeteredStream {
            inner: Box::pin(futures_util::stream::pending()),
            guard: Some(guard),
        });
        tokio::time::timeout(
            Duration::from_secs(3),
            crate::generation::settle_cancelled_stream(&mut missing, Duration::from_secs(1)),
        )
        .await
        .unwrap();
        drop(missing);
        assert!(budget.unknown_pending());
        assert_eq!(budget.usage().tokens_used, 30);
        assert!(budget.usage().reserved_tokens > 0);
    }
}
