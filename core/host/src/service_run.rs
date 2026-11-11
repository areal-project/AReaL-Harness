use anyhow::{Result, ensure};
use areal_local_service::storage;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ServiceRun {
    active: bool,
    #[serde(default)]
    managed: bool,
    #[serde(default)]
    pid: u32,
    acknowledged_stop_request_id: Option<String>,
    crashes: Vec<u64>,
    crash_loop_stopped: bool,
}
impl ServiceRun {
    pub(crate) fn prepare(home: &Path, managed: bool) -> Result<Option<Duration>> {
        let path = home.join("host/service-run.json");
        let mut state = storage::read_optional::<Self>(&path)?.unwrap_or_default();
        let stop: Option<Value> = storage::read_optional(&home.join("host/stop.json"))?;
        let completed_stop = stop
            .as_ref()
            .filter(|value| value["state"] == "completed")
            .and_then(|value| value["requestId"].as_str())
            .map(str::to_owned);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)?
            .as_millis()
            .try_into()?;
        let delay = state.begin(managed, completed_stop, now);
        if delay.is_some() {
            state.managed = managed;
            state.pid = std::process::id();
        }
        storage::write(&path, &state)?;
        Ok(delay)
    }
    fn begin(
        &mut self,
        managed: bool,
        completed_stop: Option<String>,
        now: u64,
    ) -> Option<Duration> {
        if !managed {
            self.acknowledged_stop_request_id = completed_stop;
            self.crashes.clear();
            self.crash_loop_stopped = false;
            self.active = true;
            return Some(Duration::ZERO);
        }
        if (completed_stop.is_some() && completed_stop != self.acknowledged_stop_request_id)
            || self.crash_loop_stopped
        {
            return None;
        }
        self.crashes
            .retain(|timestamp| now.saturating_sub(*timestamp) < 300_000);
        let delay = if self.active {
            self.crashes.push(now);
            if self.crashes.len() > 5 {
                self.active = false;
                self.crash_loop_stopped = true;
                return None;
            }
            Duration::from_secs(1 << (self.crashes.len() - 1))
        } else {
            Duration::ZERO
        };
        self.active = true;
        Some(delay)
    }
    pub(crate) fn acknowledge_start(home: &Path) -> Result<()> {
        let path = home.join("host/service-run.json");
        let mut state = storage::read_optional::<Self>(&path)?.unwrap_or_default();
        let stop: Option<Value> = storage::read_optional(&home.join("host/stop.json"))?;
        state.acknowledged_stop_request_id = stop
            .as_ref()
            .filter(|s| s["state"] == "completed")
            .and_then(|s| s["requestId"].as_str())
            .map(str::to_owned);
        state.crashes.clear();
        state.crash_loop_stopped = false;
        state.active = false;
        storage::write(&path, &state)
    }
    pub(crate) fn is_managed_process(home: &Path, pid: u32) -> Result<bool> {
        Ok(
            storage::read_optional::<Self>(&home.join("host/service-run.json"))?
                .is_some_and(|state| state.active && state.managed && state.pid == pid),
        )
    }
    pub(crate) fn finish(home: &Path) -> Result<()> {
        let path = home.join("host/service-run.json");
        let mut state: Self = storage::read(&path)?;
        state.active = false;
        storage::write(&path, &state)
    }
    pub(crate) fn acknowledge_controlled_stop(home: &Path, id: &str) -> Result<Option<String>> {
        let stop: Value = storage::read(&home.join("host/stop.json"))?;
        ensure!(
            stop["requestId"] == id && stop["state"] == "completed",
            "controlled stop changed before exec"
        );
        let path = home.join("host/service-run.json");
        let mut state: Self = storage::read(&path)?;
        let previous = state.acknowledged_stop_request_id.replace(id.into());
        state.active = false;
        storage::write(&path, &state)?;
        Ok(previous)
    }
    pub(crate) fn undo_controlled_stop(
        home: &Path,
        id: &str,
        previous: Option<String>,
    ) -> Result<()> {
        let path = home.join("host/service-run.json");
        let mut state: Self = storage::read(&path)?;
        ensure!(
            state.acknowledged_stop_request_id.as_deref() == Some(id),
            "controlled acknowledgement changed"
        );
        state.acknowledged_stop_request_id = previous;
        storage::write(&path, &state)
    }
}

pub fn offline_service_status(home: &Path) -> Result<Value> {
    let state = storage::read_optional::<ServiceRun>(&home.join("host/service-run.json"))?;
    let stop: Option<Value> = storage::read_optional(&home.join("host/stop.json"))?;
    ensure!(
        state.is_some() || stop.is_some(),
        "Host has no saved service status"
    );
    let identity = storage::read_optional::<String>(&home.join("host/identity.json"))?;
    Ok(serde_json::json!({
        "hostId":identity,
        "state": if state.as_ref().is_some_and(|s| s.crash_loop_stopped) {"crashLoopStopped"} else if state.as_ref().is_some_and(|s| s.active) {"unavailable"} else {"stopped"},
        "stopIntent":stop.as_ref().is_some_and(|s| (s["state"] == "completed" && state.as_ref().and_then(|s| s.acknowledged_stop_request_id.as_deref()) != s["requestId"].as_str()) || (s["state"] != "completed" && !crate::server::settled_refusal(s))),
        "restartPending":crate::server::updates::restart_pending(home)?,
        "automaticRestarts":state.as_ref().map(|s| s.crashes.len().min(5)).unwrap_or(0),
        "live":false
    }))
}

/// 发现文件消失或换成别的代次后，客户端再也连不上本 Host；继续常驻只会成为残留进程，所以退出且不改动目录里的文件。
pub(crate) async fn until_discovery_lost(home: &Path, generation: &str) {
    while !discovery_lost(home, generation) {
        tokio::time::sleep(Duration::from_secs(30)).await;
    }
}
fn discovery_lost(home: &Path, generation: &str) -> bool {
    match std::fs::read(home.join("host/host.json")) {
        Err(error) => error.kind() == std::io::ErrorKind::NotFound,
        // 读到半截写入时不下结论，等下一轮。
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes)
            .is_ok_and(|identity| identity["generation"] != generation),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn discovery_is_lost_only_when_the_descriptor_is_gone_or_replaced() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        storage::private_dir(&home.join("host")).unwrap();
        let path = home.join("host/host.json");
        storage::write(&path, &serde_json::json!({"generation":"mine"})).unwrap();
        assert!(!discovery_lost(&home, "mine"));
        std::fs::write(&path, b"{\"gener").unwrap();
        assert!(!discovery_lost(&home, "mine"));
        storage::write(&path, &serde_json::json!({"generation":"successor"})).unwrap();
        assert!(discovery_lost(&home, "mine"));
        std::fs::remove_dir_all(&home).unwrap();
        assert!(discovery_lost(&home, "mine"));
    }
    #[test]
    fn controlled_exec_acknowledges_only_original_stop_without_resetting_budget() {
        let root = tempfile::tempdir().unwrap();
        storage::private_dir(&root.path().join("host")).unwrap();
        let state = ServiceRun {
            active: false,
            managed: true,
            pid: std::process::id(),
            crashes: vec![100, 200],
            ..Default::default()
        };
        storage::write(&root.path().join("host/service-run.json"), &state).unwrap();
        storage::write(
            &root.path().join("host/stop.json"),
            &serde_json::json!({"requestId":"original","state":"completed"}),
        )
        .unwrap();
        assert!(ServiceRun::acknowledge_controlled_stop(root.path(), "another").is_err());
        let previous = ServiceRun::acknowledge_controlled_stop(root.path(), "original").unwrap();
        let mut saved: ServiceRun =
            storage::read(&root.path().join("host/service-run.json")).unwrap();
        assert_eq!(saved.crashes, vec![100, 200]);
        assert_eq!(
            saved.begin(true, Some("original".into()), 250),
            Some(Duration::ZERO)
        );
        assert_eq!(saved.crashes, vec![100, 200]);
        ServiceRun::undo_controlled_stop(root.path(), "original", previous).unwrap();
        let saved: ServiceRun = storage::read(&root.path().join("host/service-run.json")).unwrap();
        assert_eq!(saved.acknowledged_stop_request_id, None);
        assert_eq!(saved.crashes, vec![100, 200]);
    }
    #[test]
    fn managed_budget_and_stop_acknowledgement_follow_explicit_intent() {
        let mut state = ServiceRun::default();
        assert_eq!(state.begin(true, None, 1), Some(Duration::ZERO));
        for (attempt, delay) in [1, 2, 4, 8, 16].into_iter().enumerate() {
            assert_eq!(
                state.begin(true, None, (attempt as u64 + 1) * 100),
                Some(Duration::from_secs(delay))
            );
        }
        assert_eq!(state.begin(true, None, 700), None);
        assert!(state.crash_loop_stopped);
        let root = tempfile::tempdir().unwrap();
        storage::private_dir(&root.path().join("host")).unwrap();
        storage::write(&root.path().join("host/service-run.json"), &state).unwrap();
        let offline = offline_service_status(root.path()).unwrap();
        assert_eq!(offline["state"], "crashLoopStopped");
        assert_eq!(offline["automaticRestarts"], 5);
        assert_eq!(state.begin(true, None, 400_000), None);
        assert_eq!(state.begin(false, None, 400_001), Some(Duration::ZERO));
        assert!(state.crashes.is_empty());
        assert_eq!(state.begin(true, Some("stop-one".into()), 400_002), None);
        assert_eq!(state.acknowledged_stop_request_id, None);
        assert_eq!(
            state.begin(false, Some("stop-one".into()), 400_003),
            Some(Duration::ZERO)
        );
        state.active = false;
        assert_eq!(
            state.begin(true, Some("stop-one".into()), 400_004),
            Some(Duration::ZERO)
        );
        assert_eq!(state.begin(true, Some("stop-two".into()), 400_005), None);
    }
}
