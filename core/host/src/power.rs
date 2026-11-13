use super::*;
use std::cell::Cell;
use std::process::Stdio;
use tokio::process::{Child, Command};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Query {
    pub source_id: String,
}
#[derive(Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct View {
    enabled: bool,
    active: bool,
    error: Option<String>,
}
#[derive(Default)]
pub(super) struct Power {
    gate: Mutex<()>,
    views: RefCell<BTreeMap<String, View>>,
    process: RefCell<Option<Child>>,
    cli_active: Cell<bool>,
    closed: Cell<bool>,
}
impl Power {
    pub fn view(&self, source: &str) -> Result<View> {
        self.views
            .borrow()
            .get(source)
            .cloned()
            .ok_or_else(|| error("sourceNotFound", "power source is not published"))
    }
    pub(super) async fn close(&self) {
        self.closed.set(true);
        for view in self.views.borrow_mut().values_mut() {
            view.active = false;
        }
        self.release().await;
    }
    async fn release(&self) {
        let process = self.process.borrow_mut().take();
        if let Some(mut process) = process {
            let _ = process.start_kill();
            let _ = process.wait().await;
        }
    }
    fn running(&self) -> Result<bool> {
        let mut process = self.process.borrow_mut();
        let Some(child) = process.as_mut() else {
            return Ok(false);
        };
        if child.try_wait()?.is_some() {
            process.take();
            anyhow::bail!("sleep protection helper exited");
        }
        Ok(true)
    }
    fn start(&self) -> Result<()> {
        let mut command = if cfg!(target_os = "macos") {
            let mut command = Command::new("/usr/bin/caffeinate");
            command.args(["-i", "-w", &std::process::id().to_string()]);
            command
        } else {
            let mut command = Command::new("/usr/bin/systemd-inhibit");
            command.args([
                "--what=idle:sleep",
                "--mode=block",
                "--who=AReaL",
                "--why=Tasks are running",
                "/bin/cat",
            ]);
            command
        };
        command
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit());
        *self.process.borrow_mut() = Some(command.spawn()?);
        Ok(())
    }
}
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Settings {
    prevent_sleep: Option<bool>,
}
#[derive(Deserialize, Default)]
struct Library {
    #[serde(default)]
    settings: Settings,
}
fn preference(home: &std::path::Path) -> Result<bool> {
    let Some(bytes) = storage::read_bytes(&home.join("library.json"))? else {
        return Ok(true);
    };
    ensure!(
        bytes.len() <= 8 * 1024 * 1024,
        "desktop library exceeds its size limit"
    );
    let library: Library = serde_json::from_slice(&bytes)?;
    Ok(library.settings.prevent_sleep.unwrap_or(true))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Running {
    active_turns: Vec<Value>,
    active_goals: Vec<Value>,
    compactions: Vec<Value>,
    workgroups: Vec<Workgroup>,
}
#[derive(Deserialize)]
struct Workgroup {
    status: String,
}
fn running(value: Value) -> Result<bool> {
    let status: Running = serde_json::from_value(value)?;
    Ok(!status.active_turns.is_empty()
        || !status.active_goals.is_empty()
        || !status.compactions.is_empty()
        || status.workgroups.iter().any(|g| g.status == "running"))
}
impl Host {
    pub(super) async fn refresh_power(&self) -> Result<()> {
        if self.power.closed.get() {
            return Ok(());
        }
        let sources = self.migration.power_sources()?;
        {
            let mut views = self.power.views.borrow_mut();
            views.retain(|id, _| sources.contains_key(id));
            for (id, home) in &sources {
                let view = views.entry(id.clone()).or_insert(View {
                    enabled: true,
                    ..Default::default()
                });
                match preference(home) {
                    Ok(enabled) => {
                        view.enabled = enabled;
                        view.error = None;
                        if !enabled {
                            view.active = false;
                        }
                    }
                    Err(_) => view.error = Some("休眠偏好暂不可用，保留原设置。".into()),
                }
            }
        }
        // 已保存的关闭设置先释放资源，不等待另一轮 Core 状态读取。
        if !self.power.cli_active.get()
            && !self
                .power
                .views
                .borrow()
                .values()
                .any(|view| view.enabled && view.active)
        {
            self.power.release().await;
        }
        let _guard = self.power.gate.lock().await;
        let projects = self
            .slots
            .borrow()
            .values()
            .map(|slot| {
                (
                    slot.registration.clone(),
                    slot.state != "stopped"
                        && (slot.writer.is_some()
                            || slot
                                .service
                                .as_ref()
                                .is_some_and(|service| service.state != State::Stopped)),
                )
            })
            .collect::<Vec<_>>();
        let mut wanted = BTreeMap::<Option<String>, bool>::new();
        let mut unknown = BTreeMap::<Option<String>, bool>::new();
        for (project, known) in projects {
            let source = self.migration.credential_source(&project)?;
            let enabled = source
                .as_ref()
                .is_none_or(|id| self.power.views.borrow().get(id).is_some_and(|v| v.enabled));
            if !enabled || !known {
                continue;
            }
            let status = async {
                let (service, generation, connection) = self
                    .schedules
                    .connections
                    .shared_identity(self, &project.project_id)?;
                let value = self
                    .schedules
                    .connections
                    .remote_request(
                        self,
                        &project.project_id,
                        (&service, &generation, &connection),
                        "areal/server/status",
                        json!({}),
                    )
                    .await?;
                running(value)
            };
            match tokio::time::timeout(Duration::from_secs(5), status).await {
                Ok(Ok(active)) => *wanted.entry(source).or_default() |= active,
                _ => {
                    wanted.insert(source.clone(), true);
                    unknown.insert(source, true);
                }
            }
        }
        for (source, active) in wanted.iter_mut() {
            if source
                .as_ref()
                .is_some_and(|id| self.power.views.borrow().get(id).is_none_or(|v| !v.enabled))
            {
                *active = false;
            }
        }
        let needed = wanted.values().any(|active| *active);
        if self.power.closed.get() {
            return Ok(());
        }
        self.power
            .cli_active
            .set(wanted.get(&None).copied().unwrap_or(false));
        let helper_error = if needed {
            match self.power.running() {
                Ok(true) => None,
                Ok(false) => self
                    .power
                    .start()
                    .err()
                    .map(|_| "系统休眠保护未能启动，请检查系统状态。".to_owned()),
                Err(_) => Some("系统休眠保护进程已退出，请检查系统状态。".to_owned()),
            }
        } else {
            self.power.release().await;
            None
        };
        let active = self.power.process.borrow().is_some();
        for (id, view) in self.power.views.borrow_mut().iter_mut() {
            view.active =
                view.enabled && active && wanted.get(&Some(id.clone())).copied().unwrap_or(false);
            if view.enabled {
                if let Some(error) = &helper_error {
                    view.error = Some(error.clone());
                } else if unknown.get(&Some(id.clone())).copied().unwrap_or(false) {
                    view.error =
                        Some("部分任务状态暂不可用，暂时保留休眠保护；可关闭此选项。".into());
                }
            }
        }
        Ok(())
    }
}
pub(super) async fn run(host: Rc<Host>) {
    let mut interval = tokio::time::interval(Duration::from_secs(2));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        if host.refresh_power().await.is_err() {
            for view in host.power.views.borrow_mut().values_mut() {
                view.error = Some("休眠保护状态暂不可用，请检查后台。".into());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn future_tasks_do_not_hold_sleep_but_real_work_and_saved_opt_out_do() {
        let idle = json!({"activeTasks":17,"pendingQueueItems":9,"activeTurns":[],"activeGoals":[],"compactions":[],"workgroups":[{"status":"completed"}]});
        assert!(!running(idle.clone()).unwrap());
        for field in ["activeTurns", "activeGoals", "compactions"] {
            let mut active = idle.clone();
            active[field] = json!([{}]);
            assert!(running(active).unwrap());
        }
        let mut active = idle.clone();
        active["workgroups"] = json!([{"status":"running"}]);
        assert!(running(active).unwrap());
        let mut missing = idle;
        missing.as_object_mut().unwrap().remove("compactions");
        assert!(running(missing).is_err());
        let home = tempfile::tempdir().unwrap();
        assert!(preference(home.path()).unwrap());
        std::fs::write(
            home.path().join("library.json"),
            r#"{"settings":{"preventSleep":false},"threads":{"unrelated":{}}}"#,
        )
        .unwrap();
        assert!(!preference(home.path()).unwrap());
        std::fs::write(
            home.path().join("library.json"),
            r#"{"settings":{"preventSleep":"false"}}"#,
        )
        .unwrap();
        assert!(preference(home.path()).is_err());
    }
}
