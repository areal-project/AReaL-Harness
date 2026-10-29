//! 未打开会话不常驻巨大 State；目录读取临时解码元数据，执行前显式恢复正文。
use super::*;
use std::ops::{Deref, DerefMut};
use tokio::sync::{MutexGuard, TryLockError};

enum Contents {
    Loaded(Box<State>),
    Dormant {
        json: String,
        pinned: Option<Box<State>>,
        fields: catalog::ConversationFields,
    },
}

pub(crate) struct StateSlot {
    contents: Mutex<Contents>,
    loaded: AtomicBool,
}

impl State {
    fn recovered(thread: Thread) -> Self {
        Self {
            prediction_source: None,
            thread,
            active: None,
            poisoned: false,
            compacting: false,
            compaction_owner: None,
            quarantined_admission: None,
        }
    }
}

impl StateSlot {
    pub(crate) fn new(thread: Thread, deferred: bool) -> Self {
        let contents = if deferred {
            Contents::Dormant {
                json: serde_json::to_string(&thread).expect("validated metadata serializes"),
                pinned: None,
                fields: catalog::ConversationFields::new(&thread),
            }
        } else {
            Contents::Loaded(Box::new(State::recovered(thread)))
        };
        Self {
            contents: Mutex::new(contents),
            loaded: AtomicBool::new(!deferred),
        }
    }

    pub(crate) fn is_loaded(&self) -> bool {
        self.loaded.load(Ordering::Acquire)
    }

    pub(crate) async fn lock(&self) -> Guard<'_> {
        Guard::new(self.contents.lock().await, &self.loaded)
    }

    pub(crate) async fn lock_for_catalog(
        &self,
        filter: Option<&ConversationFilter>,
    ) -> Option<Guard<'_>> {
        let guard = self.contents.lock().await;
        if let Contents::Dormant { fields, .. } = &*guard
            && filter.is_some_and(|filter| !fields.included(filter))
        {
            return None;
        }
        Some(Guard::new(guard, &self.loaded))
    }

    pub(crate) fn try_lock(&self) -> std::result::Result<Guard<'_>, TryLockError> {
        self.contents
            .try_lock()
            .map(|guard| Guard::new(guard, &self.loaded))
    }
}

pub(crate) struct Guard<'a> {
    guard: MutexGuard<'a, Contents>,
    projection: Option<Box<State>>,
    changed: bool,
    was_pinned: bool,
    promote: bool,
    loaded: &'a AtomicBool,
}

impl<'a> Guard<'a> {
    fn new(mut guard: MutexGuard<'a, Contents>, loaded: &'a AtomicBool) -> Self {
        let was_pinned = matches!(
            &*guard,
            Contents::Dormant {
                pinned: Some(_),
                ..
            }
        );
        let projection = match &mut *guard {
            Contents::Loaded(_) => None,
            Contents::Dormant { json, pinned, .. } => Some(pinned.take().unwrap_or_else(|| {
                Box::new(State::recovered(
                    serde_json::from_str(json).expect("internally encoded metadata decodes"),
                ))
            })),
        };
        Self {
            guard,
            projection,
            changed: false,
            was_pinned,
            promote: false,
            loaded,
        }
    }

    pub(crate) fn materialized(&mut self) {
        self.promote = true;
    }
}

impl Deref for Guard<'_> {
    type Target = State;
    fn deref(&self) -> &State {
        match &*self.guard {
            Contents::Loaded(state) => state,
            Contents::Dormant { .. } => self.projection.as_ref().unwrap(),
        }
    }
}

impl DerefMut for Guard<'_> {
    fn deref_mut(&mut self) -> &mut State {
        self.changed = true;
        match &mut *self.guard {
            Contents::Loaded(state) => state,
            Contents::Dormant { .. } => self.projection.as_mut().unwrap(),
        }
    }
}

impl Drop for Guard<'_> {
    fn drop(&mut self) {
        let Some(state) = self.projection.take() else {
            return;
        };
        if self.promote {
            *self.guard = Contents::Loaded(state);
            self.loaded.store(true, Ordering::Release);
            return;
        }
        let Contents::Dormant {
            json,
            pinned,
            fields,
        } = &mut *self.guard
        else {
            unreachable!()
        };
        if self.changed || self.was_pinned {
            *fields = catalog::ConversationFields::new(&state.thread);
            match serde_json::to_string(&state.thread) {
                Ok(encoded) => *json = encoded,
                Err(_) => {
                    *pinned = Some(state);
                    return;
                }
            }
        }
        // 非持久运行标记不能在临时元数据投影释放时丢失；真正加载前仍禁止提交快照。
        if state.active.is_some()
            || state.poisoned
            || state.compacting
            || state.compaction_owner.is_some()
            || state.quarantined_admission.is_some()
            || state.prediction_source.is_some()
        {
            *pinned = Some(state);
        }
    }
}

pub(crate) struct Events(std::sync::OnceLock<broadcast::Sender<Value>>);
impl Events {
    pub(crate) fn new(deferred: bool) -> Self {
        let events = Self(std::sync::OnceLock::new());
        if !deferred {
            let _ = events.0.set(broadcast::channel(128).0);
        }
        events
    }
    pub(crate) fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.0.get_or_init(|| broadcast::channel(128).0).subscribe()
    }
    pub(crate) fn send(
        &self,
        value: Value,
    ) -> std::result::Result<usize, broadcast::error::SendError<Value>> {
        match self.0.get() {
            Some(events) => events.send(value),
            None => Err(broadcast::error::SendError(value)),
        }
    }
}
