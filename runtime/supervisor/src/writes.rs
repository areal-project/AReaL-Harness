//! Conflict-aware write leases. Only admission bookkeeping is globally locked;
//! disjoint paths execute concurrently. Earlier conflicting waiters retain FIFO
//! priority, so a stream of file edits cannot starve an enclosing shell writer.
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::sync::Notify;

#[derive(Default)]
pub(super) struct Writes {
    root: PathBuf,
    state: Mutex<State>,
    changed: Notify,
}

#[derive(Default)]
struct State {
    next: u64,
    requests: BTreeMap<u64, Request>,
}

struct Request {
    paths: Vec<PathBuf>,
    running: bool,
}

pub(super) struct Lease {
    writes: Arc<Writes>,
    id: u64,
}

fn conflicts(a: &[PathBuf], b: &[PathBuf]) -> bool {
    a.iter()
        .any(|a| b.iter().any(|b| a.starts_with(b) || b.starts_with(a)))
}

impl Writes {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            ..Self::default()
        }
    }
    pub async fn acquire(self: &Arc<Self>, paths: Vec<PathBuf>) -> Lease {
        // All authorized paths are under the canonical, bound workspace. Its
        // spelling (including non-ASCII parent directories) is not a conflict key.
        let paths: Vec<_> = paths
            .into_iter()
            .map(|p| {
                p.strip_prefix(&self.root)
                    .map_or_else(|_| p.clone(), PathBuf::from)
            })
            .collect();
        // Case-insensitive filesystems must not treat aliases as independent
        // writers. Non-ASCII components conservatively lock their ancestor;
        // filesystem-specific Unicode folding is not approximated as exact.
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        let paths = paths
            .into_iter()
            .map(|path| {
                let mut key = PathBuf::new();
                for component in path.components() {
                    let text = component.as_os_str().to_string_lossy();
                    if !text.is_ascii() {
                        break;
                    }
                    key.push(text.to_ascii_lowercase());
                }
                key
            })
            .collect();
        let id = {
            let mut state = self.state.lock().unwrap();
            let id = state.next;
            state.next = state
                .next
                .checked_add(1)
                .expect("write lease sequence exhausted");
            state.requests.insert(
                id,
                Request {
                    paths,
                    running: false,
                },
            );
            id
        };
        // Own the registration before the first await: dropping a queued future
        // removes its reservation, including on deadline, panic or cancellation.
        let lease = Lease {
            writes: self.clone(),
            id,
        };
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let mut state = self.state.lock().unwrap();
                let paths = &state.requests[&id].paths;
                let blocked = state.requests.iter().any(|(&other, request)| {
                    other != id
                        && (request.running || other < id)
                        && conflicts(paths, &request.paths)
                });
                if !blocked {
                    state.requests.get_mut(&id).unwrap().running = true;
                    return lease;
                }
            }
            notified.await;
        }
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        self.writes.state.lock().unwrap().requests.remove(&self.id);
        self.writes.changed.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    async fn entered(writes: &Writes, count: usize) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while writes.state.lock().unwrap().requests.len() != count {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn disjoint_writes_pass_a_blocked_writer_but_conflicting_writes_are_fifo() {
        let writes = Arc::new(Writes::default());
        let first = writes.acquire(vec!["/repo/a/one".into()]).await;
        let queued = tokio::spawn({
            let writes = writes.clone();
            async move { writes.acquire(vec!["/repo/a".into()]).await }
        });
        entered(&writes, 2).await;
        let disjoint = tokio::time::timeout(
            Duration::from_secs(1),
            writes.acquire(vec!["/repo/b/two".into()]),
        )
        .await
        .unwrap();
        let later = tokio::spawn({
            let writes = writes.clone();
            async move { writes.acquire(vec!["/repo/a/two".into()]).await }
        });
        entered(&writes, 4).await;
        assert!(!queued.is_finished() && !later.is_finished());
        drop(first);
        let enclosing = tokio::time::timeout(Duration::from_secs(1), queued)
            .await
            .unwrap()
            .unwrap();
        assert!(!later.is_finished());
        drop(enclosing);
        drop(
            tokio::time::timeout(Duration::from_secs(1), later)
                .await
                .unwrap()
                .unwrap(),
        );
        drop(disjoint);
        assert!(writes.state.lock().unwrap().requests.is_empty());
    }

    #[tokio::test]
    async fn cancelling_a_waiter_releases_its_entire_multi_path_reservation() {
        let writes = Arc::new(Writes::default());
        let first = writes.acquire(vec!["/repo/a".into()]).await;
        let waiter = tokio::spawn({
            let writes = writes.clone();
            async move {
                writes
                    .acquire(vec!["/repo/a".into(), "/repo/b".into()])
                    .await
            }
        });
        entered(&writes, 2).await;
        waiter.abort();
        assert!(matches!(waiter.await, Err(error) if error.is_cancelled()));
        let other = tokio::time::timeout(
            Duration::from_secs(1),
            writes.acquire(vec!["/repo/b".into()]),
        )
        .await
        .unwrap();
        drop((first, other));
        assert!(writes.state.lock().unwrap().requests.is_empty());
    }
}
