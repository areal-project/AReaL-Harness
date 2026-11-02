use reqwest::header::HeaderMap;
use std::{cell::RefCell, collections::VecDeque, rc::Rc};

#[derive(Clone, PartialEq, Eq)]
struct Key {
    epoch: u64,
    model: String,
    thread: String,
    turn: String,
    purpose: String,
}
struct Entry {
    key: Key,
    touched: u64,
    state: Option<String>,
}
#[derive(Default)]
pub(super) struct Affinity {
    entries: VecDeque<Rc<RefCell<Entry>>>,
}
pub(super) struct RequestAffinity {
    entry: Rc<RefCell<Entry>>,
    pub(super) headers: HeaderMap,
}

fn valid(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
impl Affinity {
    pub(super) fn clear(&mut self) {
        self.entries.clear();
    }
    pub(super) fn begin(
        &mut self,
        headers: &HeaderMap,
        model: &str,
        epoch: u64,
        now: u64,
    ) -> Option<RequestAffinity> {
        self.begin_with_bounds(headers, model, epoch, now, 128, 30 * 60_000)
    }
    fn begin_with_bounds(
        &mut self,
        headers: &HeaderMap,
        model: &str,
        epoch: u64,
        now: u64,
        limit: usize,
        ttl: u64,
    ) -> Option<RequestAffinity> {
        let thread = headers.get("x-areal-thread-id")?.to_str().ok()?;
        let turn = headers.get("x-areal-turn-id")?.to_str().ok()?;
        let purpose = headers
            .get("x-areal-model-purpose")
            .map(|v| v.to_str())
            .transpose()
            .ok()?
            .unwrap_or("solve");
        if !valid(thread)
            || !valid(turn)
            || !matches!(purpose, "solve" | "summary" | "permissionReview")
        {
            return None;
        }
        self.entries
            .retain(|entry| now.saturating_sub(entry.borrow().touched) < ttl);
        let key = Key {
            epoch,
            model: model.into(),
            thread: thread.into(),
            turn: turn.into(),
            purpose: purpose.into(),
        };
        let position = self
            .entries
            .iter()
            .position(|entry| entry.borrow().key == key);
        let entry = position
            .map(|i| self.entries.remove(i).unwrap())
            .unwrap_or_else(|| {
                Rc::new(RefCell::new(Entry {
                    key,
                    touched: now,
                    state: None,
                }))
            });
        entry.borrow_mut().touched = now;
        self.entries.push_back(entry.clone());
        while self.entries.len() > limit {
            self.entries.pop_front();
        }
        let mut headers = HeaderMap::new();
        headers.insert("session-id", thread.parse().ok()?);
        headers.insert("thread-id", thread.parse().ok()?);
        if let Some(state) = &entry.borrow().state {
            headers.insert("x-codex-turn-state", state.parse().ok()?);
        }
        Some(RequestAffinity { entry, headers })
    }
    pub(super) fn capture(
        &mut self,
        request: &RequestAffinity,
        headers: &HeaderMap,
        success: bool,
    ) {
        if !success
            || !self
                .entries
                .iter()
                .any(|entry| Rc::ptr_eq(entry, &request.entry))
            || request.entry.borrow().state.is_some()
        {
            return;
        }
        let Some(state) = headers
            .get("x-codex-turn-state")
            .and_then(|v| v.to_str().ok())
        else {
            return;
        };
        if state.is_empty()
            || state.len() > 8192
            || state.bytes().any(|b| matches!(b, b'\r' | b'\n' | 0))
        {
            return;
        }
        request.entry.borrow_mut().state = Some(state.into());
    }
}

#[test]
fn original_js_affinity_oracle_and_late_capture() {
    let steps: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("fixtures/affinity.json")).unwrap();
    let mut pool = Affinity::default();
    let mut now = 0;
    for step in steps {
        now = step["now"].as_u64().unwrap_or(now);
        let headers: HeaderMap = step["headers"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| {
                (
                    k.parse::<reqwest::header::HeaderName>().unwrap(),
                    v.as_str().unwrap().parse().unwrap(),
                )
            })
            .collect();
        let request = pool.begin_with_bounds(
            &headers,
            step["model"].as_str().unwrap(),
            step["epoch"].as_u64().unwrap(),
            now,
            2,
            10,
        );
        let actual = request.as_ref().map(|r| {
            r.headers
                .iter()
                .map(|(k, v)| (k.to_string(), serde_json::json!(v.to_str().unwrap())))
                .collect::<serde_json::Map<_, _>>()
        });
        assert_eq!(serde_json::to_value(actual).unwrap(), step["output"]);
        if let Some(state) = step["capture"].as_str() {
            let mut response = HeaderMap::new();
            response.insert("x-codex-turn-state", state.parse().unwrap());
            pool.capture(request.as_ref().unwrap(), &response, true);
        }
    }
    let headers = [
        (
            "x-areal-thread-id"
                .parse::<reqwest::header::HeaderName>()
                .unwrap(),
            "thread".parse().unwrap(),
        ),
        ("x-areal-turn-id".parse().unwrap(), "turn".parse().unwrap()),
    ]
    .into_iter()
    .collect();
    let request = pool.begin(&headers, "m", 0, 0).unwrap();
    pool.clear();
    let response = [(
        "x-codex-turn-state"
            .parse::<reqwest::header::HeaderName>()
            .unwrap(),
        "late".parse().unwrap(),
    )]
    .into_iter()
    .collect();
    pool.capture(&request, &response, true);
    assert!(pool.entries.is_empty());
}
