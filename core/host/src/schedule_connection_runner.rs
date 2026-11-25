use super::*;

struct RetryEntry {
    generation: Option<String>,
    preparation: bool,
    deadline: std::time::Instant,
}

pub(crate) async fn run(host: Rc<Host>) {
    let mut workers = JoinSet::new();
    let mut active = std::collections::BTreeSet::new();
    let mut retry = BTreeMap::<String, RetryEntry>::new();
    let mut changes = host.changes.subscribe();
    loop {
        let now = std::time::Instant::now();
        let projects = host
            .slots
            .borrow()
            .iter()
            .filter(|(id, slot)| {
                let owned = !slot.uncertain_start
                    && slot.writer.is_some()
                    && slot
                        .service
                        .as_ref()
                        .is_some_and(|service| service.owner.as_ref() == Some(&host.owner()));
                let eligible = ((slot.state == "ready" || slot.state == "unavailable") && owned)
                    || refresh_path(&host, id).exists();
                if !eligible || active.contains(*id) {
                    return false;
                }
                let current_generation = slot
                    .service
                    .as_ref()
                    .map(|service| service.identity.generation.as_str());
                let current_preparation =
                    !host.schedules.suppressed(id) && !host.schedules.import_blocked(id);
                // 退避只约束同一服务代际与同一准备模式；换代或模式切换后立刻重连，避免正常休眠拖慢新启动。
                retry.get(*id).is_none_or(|entry| {
                    entry.generation.as_deref() != current_generation
                        || entry.preparation != current_preparation
                        || now >= entry.deadline
                })
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in projects {
            active.insert(id.clone());
            let host = host.clone();
            workers.spawn_local(async move {
                let outcome = project(host, id.clone()).await;
                (id, outcome)
            });
        }
        tokio::select! {
            result = workers.join_next(), if !workers.is_empty() => {
                if let Some(Ok((id, outcome))) = result {
                    active.remove(&id);
                    match outcome {
                        WorkerExit::Retired => {
                            retry.remove(&id);
                        }
                        WorkerExit::Failed { generation, preparation, error } => {
                            retry.insert(
                                id.clone(),
                                RetryEntry {
                                    generation: generation.clone(),
                                    preparation,
                                    deadline: std::time::Instant::now() + Duration::from_secs(5),
                                },
                            );
                            let superseded = host.schedules.connections.sessions.borrow().contains_key(&id)
                                || host.slots.borrow().get(&id).is_some_and(|slot| {
                                    slot.state == "ready"
                                        && slot.service.as_ref().is_some_and(|service| {
                                            generation.as_deref() != Some(service.identity.generation.as_str())
                                        })
                                });
                            if !superseded {
                                let _ = host.schedules.preparation_result(&id, Err(error));
                            }
                            host.schedules.wake.notify_one();
                        }
                    }
                    host.schedules.connections.changed.notify_waiters();
                    host.changed();
                }
            },
            _ = changes.changed() => {},
            _ = tokio::time::sleep(Duration::from_secs(1)) => {},
        }
    }
}
