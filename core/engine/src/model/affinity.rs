//! 通用 Responses 请求身份；HTTP 短期路由状态不进入正文、历史或持久日志。
//! 显式正文缓存键由可信请求所有者派生，不复用服务端响应状态。
use super::RequestPurpose;
use reqwest::{
    StatusCode,
    header::{HeaderMap, HeaderValue},
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

#[derive(Clone, Hash, PartialEq, Eq)]
struct Key {
    model: uuid::Uuid,
    thread: String,
    turn: String,
    purpose: RequestPurpose,
}

struct Entry {
    touched: Instant,
    state: Arc<OnceLock<HeaderValue>>,
}

pub(super) struct Pool {
    entries: Mutex<HashMap<Key, Entry>>,
    max_entries: usize,
    idle: Duration,
}

impl Default for Pool {
    fn default() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            max_entries: 128,
            idle: Duration::from_secs(1800),
        }
    }
}

pub(super) struct Lease {
    thread: HeaderValue,
    state: Arc<OnceLock<HeaderValue>>,
}

pub(super) fn prompt_cache_key(
    model: &str,
    credential: Option<&str>,
    owner: Option<(String, String)>,
    purpose: RequestPurpose,
) -> Option<String> {
    let (thread, turn) = owner?;
    if !valid_identity(&thread) || !valid_identity(&turn) {
        return None;
    }
    // 同线程跨 Turn/进程重建保持稳定；模型、凭据与辅助用途隔离。
    // 不将凭据原文、工作区或业务内容作为传输键，也不改变历史前缀。
    let mut digest = Sha256::new();
    for part in [
        "areal.responses.prompt-cache.v1",
        model,
        credential.unwrap_or_default(),
        &thread,
        &format!("{purpose:?}"),
    ] {
        digest.update((part.len() as u64).to_le_bytes());
        digest.update(part.as_bytes());
    }
    Some(format!("{:x}", digest.finalize()))
}

fn valid_identity(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
}

impl Pool {
    pub(super) fn begin(
        &self,
        model: uuid::Uuid,
        owner: Option<(String, String)>,
        purpose: RequestPurpose,
    ) -> Option<Lease> {
        self.begin_at(model, owner, purpose, Instant::now())
    }

    fn begin_at(
        &self,
        model: uuid::Uuid,
        owner: Option<(String, String)>,
        purpose: RequestPurpose,
        now: Instant,
    ) -> Option<Lease> {
        let (thread, turn) = owner?;
        if !valid_identity(&thread) || !valid_identity(&turn) {
            return None;
        }
        let header = HeaderValue::from_str(&thread).ok()?;
        let key = Key {
            model,
            thread,
            turn,
            purpose,
        };
        let mut entries = self.entries.lock().unwrap();
        entries.retain(|_, entry| now.saturating_duration_since(entry.touched) < self.idle);
        let entry = entries.entry(key).or_insert_with(|| Entry {
            touched: now,
            state: Arc::new(OnceLock::new()),
        });
        entry.touched = now;
        let state = entry.state.clone();
        while entries.len() > self.max_entries {
            let oldest = entries
                .iter()
                .min_by_key(|(_, entry)| entry.touched)
                .map(|(key, _)| key.clone())
                .unwrap();
            entries.remove(&oldest);
        }
        Some(Lease {
            thread: header,
            state,
        })
    }
}

impl Lease {
    pub(super) fn headers(&self) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("session-id", self.thread.clone());
        headers.insert("thread-id", self.thread.clone());
        if let Some(state) = self.state.get() {
            headers.insert("x-codex-turn-state", state.clone());
        }
        headers
    }

    pub(super) fn capture(&self, status: StatusCode, headers: &HeaderMap) {
        if status.is_success()
            && let Some(value) = headers.get("x-codex-turn-state")
            && !value.is_empty()
            && value.as_bytes().len() <= 8192
            && value.to_str().is_ok()
        {
            // 迟到请求只持有原槽；回收或换配置后不能重新插入池或污染新槽。
            let _ = self.state.set(value.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn owner(turn: &str) -> Option<(String, String)> {
        Some(("thread".into(), turn.into()))
    }
    fn capture(lease: &Lease, value: &str) {
        let mut headers = HeaderMap::new();
        headers.insert("x-codex-turn-state", HeaderValue::from_str(value).unwrap());
        lease.capture(StatusCode::OK, &headers);
    }

    #[test]
    fn first_state_is_scoped_by_model_thread_turn_and_purpose() {
        let pool = Pool::default();
        let model = uuid::Uuid::new_v4();
        let first = pool
            .begin(model, owner("turn"), RequestPurpose::Solve)
            .unwrap();
        assert_eq!(first.headers()["session-id"], "thread");
        capture(&first, "first");
        capture(&first, "later");
        assert_eq!(
            pool.begin(model, owner("turn"), RequestPurpose::Solve)
                .unwrap()
                .headers()["x-codex-turn-state"],
            "first"
        );
        for (scope, value, purpose) in [
            (uuid::Uuid::new_v4(), owner("turn"), RequestPurpose::Solve),
            (model, owner("other"), RequestPurpose::Solve),
            (
                model,
                Some(("child".into(), "turn".into())),
                RequestPurpose::Solve,
            ),
            (model, owner("turn"), RequestPurpose::Summary),
            (model, owner("turn"), RequestPurpose::PermissionReview),
        ] {
            assert!(
                !pool
                    .begin(scope, value, purpose)
                    .unwrap()
                    .headers()
                    .contains_key("x-codex-turn-state")
            );
        }
        assert!(pool.begin(model, None, RequestPurpose::Solve).is_none());
        assert!(
            pool.begin(
                model,
                Some(("bad\r\nowner".into(), "turn".into())),
                RequestPurpose::Solve
            )
            .is_none()
        );
    }

    #[test]
    fn eviction_expiry_and_invalid_responses_do_not_resurrect_state() {
        let pool = Pool {
            max_entries: 1,
            idle: Duration::from_secs(10),
            ..Default::default()
        };
        let model = uuid::Uuid::new_v4();
        let now = Instant::now();
        let old = pool
            .begin_at(model, owner("old"), RequestPurpose::Solve, now)
            .unwrap();
        pool.begin_at(
            model,
            owner("new"),
            RequestPurpose::Solve,
            now + Duration::from_secs(1),
        )
        .unwrap();
        capture(&old, "late");
        let fresh = pool
            .begin_at(
                model,
                owner("old"),
                RequestPurpose::Solve,
                now + Duration::from_secs(2),
            )
            .unwrap();
        assert!(!fresh.headers().contains_key("x-codex-turn-state"));
        let mut headers = HeaderMap::new();
        headers.insert("x-codex-turn-state", HeaderValue::from_static("failure"));
        fresh.capture(StatusCode::SERVICE_UNAVAILABLE, &headers);
        capture(&fresh, &"x".repeat(8193));
        assert!(!fresh.headers().contains_key("x-codex-turn-state"));
        capture(&fresh, "valid");
        let expired = pool
            .begin_at(
                model,
                owner("old"),
                RequestPurpose::Solve,
                now + Duration::from_secs(12),
            )
            .unwrap();
        capture(&fresh, "late-expired");
        assert!(!expired.headers().contains_key("x-codex-turn-state"));
        assert_eq!(pool.entries.lock().unwrap().len(), 1);
    }
}
