use areal_engine::concurrency::{GroupError, Mailbox, TaskGroup, map_bounded};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn group_wait_any_capacity_and_cancel_settle() {
    let cancel = CancellationToken::new();
    let mut group = TaskGroup::new(2, &cancel);
    group.spawn(std::future::pending::<usize>()).unwrap();
    group.spawn(async { 7 }).unwrap();
    assert!(matches!(group.spawn(async { 8 }), Err(GroupError::Full)));
    assert_eq!(group.wait_any().await.unwrap().unwrap(), 7);
    group.cancel_and_wait().await;
    assert!(group.is_empty());
    assert!(matches!(group.spawn(async { 8 }), Err(GroupError::Closed)));
}

#[tokio::test]
async fn mailbox_backpressure_is_cancellable_and_does_not_deliver_cancelled_message() {
    let (mailbox, mut receiver) = Mailbox::bounded(1);
    let cancel = CancellationToken::new();
    mailbox.send(1, &cancel).await.unwrap();
    let blocked = mailbox.send(2, &cancel);
    tokio::pin!(blocked);
    assert!(
        tokio::time::timeout(Duration::from_millis(10), &mut blocked)
            .await
            .is_err()
    );
    cancel.cancel();
    assert!(matches!(blocked.await, Err(GroupError::Cancelled)));
    assert_eq!(receiver.recv().await, Some(1));
    assert!(receiver.try_recv().is_err());
}

#[tokio::test]
async fn bounded_map_obeys_limit_and_collects_every_result() {
    let live = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let cancel = CancellationToken::new();
    let results = map_bounded(0..100, 4, &cancel, |n| {
        let live = live.clone();
        let peak = peak.clone();
        async move {
            let count = live.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(count, Ordering::SeqCst);
            tokio::task::yield_now().await;
            live.fetch_sub(1, Ordering::SeqCst);
            n
        }
    })
    .await
    .unwrap();
    assert_eq!(results.len(), 100);
    assert!(peak.load(Ordering::SeqCst) <= 4);
    assert_eq!(live.load(Ordering::SeqCst), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "capacity benchmark; run explicitly with --ignored --nocapture"]
async fn twenty_thousand_live_tasks_progress_and_cancel() {
    let total = 20_000;
    let cancel = CancellationToken::new();
    let mut group = TaskGroup::new(total, &cancel);
    let entered = Arc::new(AtomicUsize::new(0));
    let ticks = Arc::new(AtomicUsize::new(0));
    let start = std::time::Instant::now();
    for _ in 0..total {
        let entered = entered.clone();
        let ticks = ticks.clone();
        group
            .spawn(async move {
                entered.fetch_add(1, Ordering::SeqCst);
                loop {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    ticks.fetch_add(1, Ordering::Relaxed);
                }
            })
            .unwrap();
    }
    tokio::time::timeout(Duration::from_secs(10), async {
        while entered.load(Ordering::SeqCst) != total {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(ticks.load(Ordering::Relaxed) >= total);
    let stopping = std::time::Instant::now();
    group.cancel_and_wait().await;
    println!(
        "tasks={total} elapsed_ms={} ticks={} cancel_ms={}",
        start.elapsed().as_millis(),
        ticks.load(Ordering::Relaxed),
        stopping.elapsed().as_millis()
    );
    assert!(group.is_empty());
}
