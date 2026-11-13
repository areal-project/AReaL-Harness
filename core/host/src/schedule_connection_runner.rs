use super::*;

pub(crate) async fn run(host: Rc<Host>) {
    let mut workers = JoinSet::new();
    let mut active = std::collections::BTreeSet::new();
    let mut retry = BTreeMap::new();
    let mut changes = host.changes.subscribe();
    loop {
        let projects = host
            .slots
            .borrow()
            .iter()
            .filter(|(id, slot)| {
                let owned_retry = slot.state == "unavailable"
                    && !slot.uncertain_start
                    && slot.writer.is_some()
                    && slot
                        .service
                        .as_ref()
                        .is_some_and(|service| service.owner.as_ref() == Some(&host.owner()));
                (slot.state == "ready" || owned_retry || refresh_path(&host, id).exists())
                    && !active.contains(*id)
                    && retry
                        .get(*id)
                        .is_none_or(|deadline| std::time::Instant::now() >= *deadline)
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in projects {
            active.insert(id.clone());
            let host = host.clone();
            workers.spawn_local(async move {
                let result = project(host, id.clone()).await;
                (id, result)
            });
        }
        tokio::select! {
            result = workers.join_next(), if !workers.is_empty() => {
                if let Some(Ok((id, result))) = result {
                    active.remove(&id);
                    retry.insert(id.clone(), std::time::Instant::now() + Duration::from_secs(5));
                    host.schedules.connections.sessions.borrow_mut().remove(&id);
                    host.schedules.connections.changed.notify_waiters();
                    host.changed();
                    let _ = host.schedules.preparation_result(&id, result);
                    host.schedules.wake.notify_one();
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            },
            _ = changes.changed() => {},
            _ = tokio::time::sleep(Duration::from_secs(1)) => {},
        }
    }
}
