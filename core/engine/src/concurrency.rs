//! Agent 编排使用的有界结构化并发。模型请求配额由 Engine 单独控制。
use std::future::Future;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

#[derive(Debug, thiserror::Error)]
pub enum GroupError {
    #[error("task group is closed")]
    Closed,
    #[error("task group capacity reached")]
    Full,
    #[error("task cancelled")]
    Cancelled,
    #[error("task failed: {0}")]
    Task(#[from] tokio::task::JoinError),
}

/// 任务属于当前组。等待按完成顺序返回，失败不隐式取消同组任务。
/// `cancel_and_wait` 才保证异步任务已退出；Drop 仅发送取消并中止任务。
pub struct TaskGroup<T: Send + 'static> {
    tasks: JoinSet<std::result::Result<T, GroupError>>,
    cancel: CancellationToken,
    capacity: usize,
}

impl<T: Send + 'static> TaskGroup<T> {
    pub fn new(capacity: usize, parent: &CancellationToken) -> Self {
        Self {
            tasks: JoinSet::new(),
            cancel: parent.child_token(),
            capacity,
        }
    }
    pub fn spawn<F: Future<Output = T> + Send + 'static>(
        &mut self,
        future: F,
    ) -> Result<(), GroupError> {
        if self.cancel.is_cancelled() {
            return Err(GroupError::Closed);
        }
        if self.tasks.len() >= self.capacity {
            return Err(GroupError::Full);
        }
        let cancel = self.cancel.clone();
        self.tasks.spawn(async move {
            tokio::select! { biased; _ = cancel.cancelled() => Err(GroupError::Cancelled), result = future => Ok(result) }
        });
        Ok(())
    }
    pub fn len(&self) -> usize {
        self.tasks.len()
    }
    pub fn is_empty(&self) -> bool {
        self.tasks.is_empty()
    }
    pub async fn wait_any(&mut self) -> Option<Result<T, GroupError>> {
        self.tasks
            .join_next()
            .await
            .map(|r| r.map_err(GroupError::Task).and_then(|r| r))
    }
    pub async fn join(mut self) -> Vec<Result<T, GroupError>> {
        let mut results = Vec::with_capacity(self.len());
        while let Some(result) = self.wait_any().await {
            results.push(result);
        }
        results
    }
    pub async fn cancel_and_wait(&mut self) {
        self.cancel.cancel();
        while self.wait_any().await.is_some() {}
    }
}
impl<T: Send + 'static> Drop for TaskGroup<T> {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

/// 有界 mailbox；发送者在队列满时等待，等待过程可以独立取消。
pub struct Mailbox<T> {
    sender: tokio::sync::mpsc::Sender<T>,
}
impl<T> Clone for Mailbox<T> {
    fn clone(&self) -> Self {
        Self {
            sender: self.sender.clone(),
        }
    }
}
impl<T> Mailbox<T> {
    pub fn bounded(capacity: usize) -> (Self, tokio::sync::mpsc::Receiver<T>) {
        let (sender, receiver) = tokio::sync::mpsc::channel(capacity);
        (Self { sender }, receiver)
    }
    pub async fn send(&self, value: T, cancel: &CancellationToken) -> Result<(), GroupError> {
        tokio::select! { biased; _=cancel.cancelled()=>Err(GroupError::Cancelled),
        result=self.sender.send(value)=>result.map_err(|_|GroupError::Closed) }
    }
}

/// 只启动至多 concurrency 个任务，按完成顺序汇聚结果。
pub async fn map_bounded<I, F, Fut, T>(
    input: I,
    concurrency: usize,
    cancel: &CancellationToken,
    mut run: F,
) -> Result<Vec<T>, GroupError>
where
    I: IntoIterator,
    F: FnMut(I::Item) -> Fut,
    Fut: Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    if concurrency == 0 {
        return Err(GroupError::Full);
    }
    let mut group = TaskGroup::new(concurrency, cancel);
    let mut input = input.into_iter();
    let mut result = Vec::new();
    loop {
        while group.len() < concurrency {
            let Some(item) = input.next() else {
                break;
            };
            group.spawn(run(item))?;
        }
        let Some(value) = group.wait_any().await else {
            return Ok(result);
        };
        match value {
            Ok(value) => result.push(value),
            Err(error) => {
                group.cancel_and_wait().await;
                return Err(error);
            }
        }
    }
}
