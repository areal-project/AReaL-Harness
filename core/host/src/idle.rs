//! 自动休眠只回收执行实例，不改变用户调度意图。
use super::*;
use std::time::Instant;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Release {
    request_id: String,
    expected_generation: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReleasePolicy {
    generation: String,
    stop_request_id: String,
}

impl Host {
    pub(super) fn has_external_clients(&self) -> bool {
        !self.clients.borrow().is_empty()
    }
    pub(super) fn retain_for_gui(&self) -> Result<()> {
        let path = self.home.join("host/release.json");
        if storage::read_optional::<ReleasePolicy>(&path)?
            .is_some_and(|policy| policy.generation == self.identity.generation)
        {
            std::fs::remove_file(path)?;
        }
        Ok(())
    }
    pub(super) fn release_when_unused(&self, input: Release) -> Result<Value> {
        self.generation(&input.expected_generation)?;
        self.admission()?;
        let (digest, _) = self.accepted(&input.request_id, "host.release", &input, "")?;
        let path = self.home.join("host/release.json");
        let policy = storage::read_optional::<ReleasePolicy>(&path)?
            .filter(|policy| policy.generation == self.identity.generation)
            .unwrap_or_else(|| ReleasePolicy {
                generation: self.identity.generation.clone(),
                stop_request_id: uuid::Uuid::new_v4().to_string(),
            });
        storage::write(&path, &policy)?;
        self.save(&input.request_id, &digest, &json!({"version":VERSION,"requestId":input.request_id,"method":"host.release","hostId":self.identity.host_id,"generation":self.identity.generation,"state":"completed"}))?;
        self.changed();
        Ok(
            json!({"requestId":input.request_id,"generation":self.identity.generation,"state":"armed"}),
        )
    }
}

/// 客户端退出只登记回收意图；最后一个认证客户端断开且后台无需求后才停止共享 Host。
pub(super) async fn release_unused(host: Rc<Host>) {
    let mut changes = host.changes.subscribe();
    let mut reported = String::new();
    let mut transient_retries: u32 = 0;
    loop {
        let reason = match try_release(&host).await {
            Err(error) => {
                transient_retries = 0;
                format!("error: {error}")
            }
            Ok(reason) => {
                if reason == "activityUnknownOrBusy" && transient_retries < 8 {
                    transient_retries += 1;
                } else {
                    transient_retries = 0;
                }
                reason.into()
            }
        };
        if reason != reported {
            if reason != "unarmed" {
                eprintln!("Host release: {reason}");
            }
            reported = reason;
        }
        let delay = if transient_retries > 0 {
            transient_release_delay(transient_retries - 1)
        } else {
            Duration::from_secs(30)
        };
        tokio::select! {
            _ = changes.changed() => {},
            _ = tokio::time::sleep(delay) => {},
        }
    }
}

fn transient_release_delay(retry: u32) -> Duration {
    Duration::from_millis(200 * (1_u64 << retry.min(3)))
}

async fn try_release(host: &Rc<Host>) -> Result<&'static str> {
    let path = host.home.join("host/release.json");
    let Some(mut policy) = storage::read_optional::<ReleasePolicy>(&path)? else {
        return Ok("unarmed");
    };
    if policy.generation != host.identity.generation || host.has_external_clients() {
        return Ok("externalClients");
    }
    if let Some(receipt) = host.reconcile(&policy.stop_request_id).await? {
        if receipt["state"] == "completed" {
            host.exit.notify_one();
            return Ok("stopped");
        }
        if !settled_refusal(&receipt) {
            return Ok("originalStopPending");
        }
        policy.stop_request_id = uuid::Uuid::new_v4().to_string();
        storage::write(&path, &policy)?;
    }
    host.admission()?;
    if crate::ServiceInstallation::status(&host.home)?["installed"] == true
        || host.gateway.pending.get() != 0
        || !host.gateway.peers.borrow().is_empty()
    {
        return Ok("backgroundConnectionOrService");
    }
    if host.remote.native_owner()?.is_some() {
        let remote = host.remote.snapshot(&host.migration)?;
        if remote["config"]["enabled"] == true || remote["config"]["relayLocal"]["enabled"] == true
        {
            return Ok("remoteEnabled");
        }
    }
    host.migration.vault.idle()?;
    let activity = host.activity().await;
    if !activity.complete
        || !activity.projects.iter().all(|project| {
            matches!(
                project,
                ProjectActivity::Observed {
                    idle_allowed: true,
                    ..
                }
            )
        })
        || host.has_external_clients()
    {
        return Ok("activityUnknownOrBusy");
    }
    let registrations = host.registrations();
    for registration in registrations {
        if !host.schedules.suppressed(&registration.project_id)
            && schedules::enabled_catalog(&host.bin, &registration).await?
        {
            return Ok("enabledSchedule");
        }
    }
    if storage::read_optional::<ReleasePolicy>(&path)?
        .is_none_or(|current| current.stop_request_id != policy.stop_request_id)
    {
        return Ok("policyWithdrawn");
    }
    let receipt = host
        .stop_host(Stop {
            request_id: policy.stop_request_id,
            expected_generation: host.identity.generation.clone(),
            strategy: StopStrategy::IfIdle,
            suppress_scheduling: false,
            project_id: None,
            service_generation: None,
        })
        .await?;
    if receipt["state"] == "completed" {
        host.exit.notify_one();
    }
    Ok("stopDispatched")
}

const TTL: Duration = Duration::from_secs(15 * 60);

#[derive(Default)]
pub(super) struct IdleWindow {
    since: Option<Instant>,
}

impl IdleWindow {
    pub(super) fn reset(&mut self) {
        self.since = None;
    }

    fn observe(&mut self, idle: bool, now: Instant, ttl: Duration) -> bool {
        if !idle {
            self.reset();
            return false;
        }
        now.duration_since(*self.since.get_or_insert(now)) >= ttl
    }
}

pub(super) async fn run(host: Rc<Host>) {
    let mut interval = tokio::time::interval(Duration::from_secs(30));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut pending = BTreeMap::<String, String>::new();
    let mut changes = host.changes.subscribe();
    loop {
        let changed = tokio::select! {
            _ = interval.tick() => false,
            _ = changes.changed() => true,
        };
        let release = storage::read_optional::<ReleasePolicy>(&host.home.join("host/release.json"))
            .ok()
            .flatten()
            .is_some_and(|policy| policy.generation == host.identity.generation)
            && !host.has_external_clients();
        if changed && !release {
            continue;
        }
        if host.admission().is_err() {
            continue;
        }
        // 未确认的停止只核查原请求，不为下一次巡检换 ID。
        for (project, request) in pending.clone() {
            match host.reconcile(&request).await {
                Ok(Some(receipt))
                    if receipt["state"] == "completed" || settled_refusal(&receipt) =>
                {
                    pending.remove(&project);
                }
                _ => {}
            }
        }
        let projects = host
            .slots
            .borrow()
            .iter()
            .filter(|(id, slot)| slot.state == "ready" && !pending.contains_key(*id))
            .filter_map(|(id, slot)| {
                slot.service
                    .clone()
                    .map(|service| (id.clone(), slot.registration.clone(), service))
            })
            .collect::<Vec<_>>();
        for (id, registration, service) in projects {
            let observed = crate::activity::observe(
                &host.home,
                &registration,
                &host.owner(),
                true,
                Some(&service),
            )
            .await;
            let idle = matches!(
                observed,
                Ok(ProjectActivity::Observed {
                    idle_allowed: true,
                    ..
                })
            );
            let due = {
                let mut slots = host.slots.borrow_mut();
                let Some(slot) = slots.get_mut(&id) else {
                    continue;
                };
                if slot.state != "ready"
                    || slot
                        .service
                        .as_ref()
                        .is_none_or(|current| current.identity != service.identity)
                {
                    slot.idle.reset();
                    continue;
                }
                slot.idle.observe(
                    idle,
                    Instant::now(),
                    if release { Duration::ZERO } else { TTL },
                )
            };
            if !due {
                continue;
            }
            // 只为即将到期或尚未结算的任务保活；未来计划由 Host 提前唤醒。
            if !host.schedules.suppressed(&id)
                && !matches!(
                    schedules::activation_due(&host.bin, &registration).await,
                    Ok(false)
                )
            {
                if let Some(slot) = host.slots.borrow_mut().get_mut(&id) {
                    slot.idle.reset();
                }
                continue;
            }
            if release && host.has_external_clients() {
                continue;
            }
            let request = uuid::Uuid::new_v4().to_string();
            let result = host
                .stop_project(Stop {
                    request_id: request.clone(),
                    expected_generation: host.identity.generation.clone(),
                    strategy: StopStrategy::IfIdle,
                    suppress_scheduling: false,
                    project_id: Some(id.clone()),
                    service_generation: Some(service.identity.generation),
                })
                .await;
            if host
                .receipt(&request)
                .ok()
                .flatten()
                .is_some_and(|record| !record.settled())
            {
                pending.insert(id.clone(), request);
            }
            if let Some(slot) = host.slots.borrow_mut().get_mut(&id) {
                slot.idle.reset();
            }
            if let Err(error) = result {
                eprintln!("Idle project hibernation deferred: {error}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Client;

    #[test]
    #[ignore = "internal subprocess entry"]
    fn release_host_entry() {
        let home = PathBuf::from(std::env::var_os("AREAL_RELEASE_TEST_HOME").unwrap());
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(crate::run(RunOptions {
                home,
                bin_dir: std::env::current_exe().unwrap().parent().unwrap().into(),
            }))
            .unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn real_host_release_waits_for_a_subscriber_then_exits_and_releases_its_lock() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().canonicalize().unwrap().join("host");
        let mut child = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "server::idle::tests::release_host_entry",
                "--ignored",
                "--nocapture",
            ])
            .env_clear()
            .env("HOME", root.path())
            .env("AREAL_RELEASE_TEST_HOME", &home)
            .kill_on_drop(true)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::inherit())
            .spawn()
            .unwrap();
        let client = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                if let Ok(client) = Client::connect_at(home.clone()).await {
                    break client;
                }
                assert!(
                    child.try_wait().unwrap().is_none(),
                    "test Host exited before discovery"
                );
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let subscriber = client.subscribe().await.unwrap();
        let receipt = client
            .release_when_unused(&uuid::Uuid::new_v4().to_string())
            .await
            .unwrap();
        assert_eq!(receipt["state"], "armed");
        assert!(
            tokio::time::timeout(Duration::from_secs(2), child.wait())
                .await
                .is_err(),
            "another client must keep Host alive"
        );
        drop(subscriber);
        assert!(
            tokio::time::timeout(Duration::from_secs(15), child.wait())
                .await
                .unwrap()
                .unwrap()
                .success()
        );
        let lock = storage::open_private(&home.join("host.lock"), false).unwrap();
        fs2::FileExt::try_lock_exclusive(&lock).unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn quit_release_records_an_idempotent_policy_without_claiming_process_exit() {
        let root = tempfile::tempdir().unwrap();
        let host = schedules::tests::fixture(root.path());
        let request = uuid::Uuid::new_v4().to_string();
        let input = json!({"requestId":request,"expectedGeneration":host.identity.generation});
        let armed = host.dispatch("host.release", input.clone()).await.unwrap();
        assert_eq!(armed["state"], "armed");
        assert_eq!(armed["requestId"], request);
        assert!(host.stop.borrow().is_none());
        assert_eq!(
            host.dispatch("host.release", input.clone()).await.unwrap(),
            armed
        );
        assert_eq!(
            host.receipt(&request).unwrap().unwrap().receipt["state"],
            "completed"
        );
        let mut stale = input;
        stale["expectedGeneration"] = json!("previous-generation");
        assert!(host.dispatch("host.release", stale).await.is_err());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn release_preserves_another_client_and_stops_only_after_the_last_disconnect() {
        let root = tempfile::tempdir().unwrap();
        let host = Rc::new(schedules::tests::fixture(root.path()));
        host.slots.borrow_mut().clear();
        host.dispatch("host.release", json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":host.identity.generation})).await.unwrap();
        host.clients
            .borrow_mut()
            .insert("other-client".into(), None);
        try_release(&host).await.unwrap();
        assert!(host.stop.borrow().is_none());
        host.clients.borrow_mut().remove("other-client");
        try_release(&host).await.unwrap();
        assert_eq!(host.stop.borrow().as_ref().unwrap()["state"], "completed");
    }

    #[test]
    fn hibernation_requires_continuous_observed_idle_and_resets_on_activity() {
        let mut window = IdleWindow::default();
        let start = Instant::now();
        assert!(!window.observe(true, start, TTL));
        assert!(!window.observe(true, start + TTL - Duration::from_secs(1), TTL));
        assert!(window.observe(true, start + TTL, TTL));
        assert!(!window.observe(false, start + TTL, TTL));
        assert!(!window.observe(true, start + TTL + Duration::from_secs(1), TTL));
        window.reset();
        assert!(!window.observe(true, start + TTL * 3, TTL));
        assert!(window.observe(true, start + TTL * 4, TTL));
    }

    #[test]
    fn transient_release_backoff_starts_at_200ms_and_caps_at_1600ms() {
        assert_eq!(transient_release_delay(0), Duration::from_millis(200));
        assert_eq!(transient_release_delay(1), Duration::from_millis(400));
        assert_eq!(transient_release_delay(2), Duration::from_millis(800));
        assert_eq!(transient_release_delay(3), Duration::from_millis(1600));
        assert_eq!(transient_release_delay(7), Duration::from_millis(1600));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn release_unused_recovers_within_two_seconds_after_transient_busy_clears() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let root = tempfile::tempdir().unwrap();
                let host = Rc::new(schedules::tests::fixture(root.path()));
                {
                    let mut slots = host.slots.borrow_mut();
                    let slot = slots.get_mut("project").unwrap();
                    slot.state = "starting".into();
                    slot.uncertain_start = true;
                }
                host.dispatch(
                    "host.release",
                    json!({
                        "requestId": uuid::Uuid::new_v4().to_string(),
                        "expectedGeneration": host.identity.generation,
                    }),
                )
                .await
                .unwrap();
                let worker = tokio::task::spawn_local(release_unused(host.clone()));
                tokio::time::sleep(Duration::from_millis(50)).await;
                assert!(host.stop.borrow().is_none());
                // Clear the transient blocker without sending host.changed() to verify the 200ms retry timer.
                host.slots.borrow_mut().clear();
                tokio::time::timeout(Duration::from_secs(2), host.exit.notified())
                    .await
                    .expect("release_unused should recover via short backoff without waiting 30s");
                assert_eq!(host.stop.borrow().as_ref().unwrap()["state"], "completed");
                worker.abort();
            })
            .await;
    }
}
