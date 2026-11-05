//! Host 到工作台服务的路由：懒启动、退避重启、反向调用与 Core 事件转发。设计见 docs/design/workbench-service.md。
use super::Host;
use crate::workbench::{Reverse, Workbench, restart_delay};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    path::{Path, PathBuf},
    rc::{Rc, Weak},
    time::{Duration, Instant},
};

/// 服务实现、Host 转发的方法。目前只给本机桌面主体；远程设备跨项目统计需单独授权，暂不开放。
pub(super) const METHODS: &[&str] = &[
    "analytics.activity",
    "analytics.import",
    "analytics.read",
    "analytics.sync",
];
/// 服务经 `core.request` 可调用的 Core 方法：只读。
const CORE_METHODS: &[&str] = &["thread/list", "thread/read"];
/// 转给服务的 Core 通知。
const EVENTS: &[&str] = &["turn/started", "turn/completed", "item/completed"];
const FAILURE_WINDOW: Duration = Duration::from_secs(600);

#[derive(Default)]
pub(super) struct Supervisor {
    running: RefCell<Option<Rc<Workbench>>>,
    starting: tokio::sync::Mutex<()>,
    failures: RefCell<Vec<Instant>>,
    stopped: Cell<bool>,
}

/// 服务入口与运行时。打包后在已签名应用的 `Resources/areal-workbench`，用应用自带的 Electron。
pub(super) struct Entry {
    pub runtime: PathBuf,
    pub runner: PathBuf,
}

pub(super) async fn discover(bin: &Path) -> Result<Entry> {
    let bundle = crate::local_relay::discover_bundle(
        bin,
        "areal-workbench",
        "src/main.cjs",
        &["src/main.cjs", "src/channel.cjs"],
        "CAPABILITY_UNAVAILABLE",
    )
    .await?;
    Ok(Entry {
        runtime: bundle.runtime,
        runner: bundle.runner,
    })
}

impl Supervisor {
    pub(super) async fn request(
        &self,
        host: &Rc<Host>,
        method: &str,
        params: Value,
        context: Value,
    ) -> Result<Value> {
        ensure!(METHODS.contains(&method), "methodNotFound");
        let workbench = self.running(host).await?;
        workbench.request(method, params, context).await
    }

    /// Core 通知只在服务已运行时转发；服务未启动不为此拉起。
    pub(super) fn core_event(&self, project_id: &str, event: &Value) {
        if !event["method"]
            .as_str()
            .is_some_and(|m| EVENTS.contains(&m))
        {
            return;
        }
        let Some(workbench) = self.running.borrow().clone() else {
            return;
        };
        let body =
            json!({"projectId":project_id,"method":event["method"],"params":event["params"]});
        tokio::task::spawn_local(async move { workbench.notify("core.event", body).await });
    }

    pub(super) async fn stop(&self) {
        self.stopped.set(true);
        let _guard = self.starting.lock().await;
        let running = self.running.borrow_mut().take();
        if let Some(workbench) = running {
            let _ = workbench.stop().await;
        }
    }

    async fn running(&self, host: &Rc<Host>) -> Result<Rc<Workbench>> {
        let _guard = self.starting.lock().await;
        ensure!(!self.stopped.get(), "CAPABILITY_UNAVAILABLE");
        let current = self.running.borrow().clone();
        if let Some(workbench) = current {
            if !workbench.closed() {
                return Ok(workbench);
            }
            self.running.borrow_mut().take();
            self.failures.borrow_mut().push(Instant::now());
        }
        self.admit()?;
        match self.start(host).await {
            Ok(workbench) => {
                let workbench = Rc::new(workbench);
                *self.running.borrow_mut() = Some(workbench.clone());
                Ok(workbench)
            }
            Err(_) => {
                self.failures.borrow_mut().push(Instant::now());
                bail!("CAPABILITY_UNAVAILABLE")
            }
        }
    }

    /// 10 分钟内失败 5 次后不再自动重启；之前按 1、2、4… 秒退避，未到时间直接报不可用。
    fn admit(&self) -> Result<()> {
        let mut failures = self.failures.borrow_mut();
        failures.retain(|time| time.elapsed() < FAILURE_WINDOW);
        let Some(last) = failures.last() else {
            return Ok(());
        };
        ensure!(failures.len() < 5, "CAPABILITY_UNAVAILABLE");
        let delay = restart_delay(failures.len() as u32 - 1).context("CAPABILITY_UNAVAILABLE")?;
        ensure!(last.elapsed() >= delay, "CAPABILITY_UNAVAILABLE");
        Ok(())
    }

    async fn start(&self, host: &Rc<Host>) -> Result<Workbench> {
        let entry = discover(&host.bin).await?;
        let data = host.home.join("workbench");
        areal_local_service::storage::private_dir(&data)?;
        Workbench::start(&entry.runtime, &entry.runner, &data, reverse(host)).await
    }
}

/// 服务向 Host 的反向调用。服务只经 Host 取项目与 Core，Host 做代次检查。
pub(super) fn reverse(host: &Rc<Host>) -> Reverse {
    let host: Weak<Host> = Rc::downgrade(host);
    Rc::new(move |call, params| {
        let host = host.clone();
        Box::pin(async move {
            let host = host.upgrade().context("CAPABILITY_UNAVAILABLE")?;
            match call.as_str() {
                "projects.list" => Ok(projects(&host)),
                "core.request" => core_request(&host, &params).await,
                _ => bail!("FORBIDDEN"),
            }
        })
    })
}

fn projects(host: &Host) -> Value {
    let projects: Vec<_> = host
        .slots
        .borrow()
        .values()
        .map(|slot| json!({"projectId":slot.registration.project_id,"ready":slot.state == "ready"}))
        .collect();
    json!({ "projects": projects })
}

async fn core_request(host: &Host, params: &Value) -> Result<Value> {
    let object = params.as_object().context("INVALID_PARAMS")?;
    ensure!(
        object
            .keys()
            .all(|key| matches!(key.as_str(), "projectId" | "method" | "params")),
        "INVALID_PARAMS"
    );
    let project = params["projectId"].as_str().context("INVALID_PARAMS")?;
    let method = params["method"].as_str().context("INVALID_PARAMS")?;
    ensure!(CORE_METHODS.contains(&method), "FORBIDDEN");
    let body = params.get("params").cloned().unwrap_or_else(|| json!({}));
    ensure!(body.is_object(), "INVALID_PARAMS");
    ensure!(host.slots.borrow().contains_key(project), "NOT_FOUND");
    let connections = &host.schedules.connections;
    let (service, generation, connection) = connections.shared_identity(host, project)?;
    connections
        .remote_request(
            host,
            project,
            &service,
            &generation,
            &connection,
            method,
            body,
        )
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn reverse_calls_are_read_only_and_scoped_to_registered_projects() {
        let root = tempfile::tempdir().unwrap();
        let host = Rc::new(crate::server::schedules::tests::fixture(root.path()));
        let reverse = reverse(&host);
        let listed = reverse("projects.list".into(), json!({})).await.unwrap();
        assert_eq!(listed["projects"][0]["projectId"], "project");
        for (call, params, code) in [
            ("vault.read", json!({"slot":"x"}), "FORBIDDEN"),
            (
                "core.request",
                json!({"projectId":"project","method":"turn/start","params":{}}),
                "FORBIDDEN",
            ),
            (
                "core.request",
                json!({"projectId":"other","method":"thread/read","params":{}}),
                "NOT_FOUND",
            ),
            (
                "core.request",
                json!({"projectId":"project","method":"thread/read","extra":1}),
                "INVALID_PARAMS",
            ),
        ] {
            let error = reverse(call.into(), params).await.unwrap_err();
            assert_eq!(error.to_string(), code, "{call}");
        }
    }

    #[test]
    fn restarts_back_off_and_stop_after_five_failures() {
        let supervisor = Supervisor::default();
        assert!(supervisor.admit().is_ok());
        supervisor.failures.borrow_mut().push(Instant::now());
        assert!(supervisor.admit().is_err());
        *supervisor.failures.borrow_mut() = vec![Instant::now() - Duration::from_secs(2)];
        assert!(supervisor.admit().is_ok());
        *supervisor.failures.borrow_mut() = vec![Instant::now() - Duration::from_secs(120); 5];
        assert!(supervisor.admit().is_err());
        *supervisor.failures.borrow_mut() =
            vec![Instant::now() - FAILURE_WINDOW - Duration::from_secs(1); 5];
        assert!(supervisor.admit().is_ok());
    }
}
