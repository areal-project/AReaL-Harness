use super::*;
use areal_local_service::native_process::TrustedCommand;
use std::{
    collections::{BTreeSet, VecDeque},
    path::Path,
};

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Project {
    // 尚无显式意图的扫描结果不能挡住随后导入的旧停止意图。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    suppressed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    import_blocked: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    preparation_error: Option<String>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct State {
    projects: BTreeMap<String, Project>,
    imported_sources: BTreeSet<String>,
}
pub(super) struct Schedules {
    path: PathBuf,
    state: RefCell<State>,
    pub wake: Notify,
    pub connections: super::schedule_connection::Connections,
}
impl Schedules {
    pub fn load(home: &Path) -> Result<Self> {
        let path = home.join("host/scheduling.json");
        Ok(Self {
            state: RefCell::new(storage::read_optional(&path)?.unwrap_or_default()),
            path,
            wake: Notify::new(),
            connections: super::schedule_connection::Connections::default(),
        })
    }
    fn update(&self, change: impl FnOnce(&mut State)) -> Result<()> {
        let mut state = self.state.borrow().clone();
        change(&mut state);
        storage::write(&self.path, &state)?;
        *self.state.borrow_mut() = state;
        Ok(())
    }
    pub fn suppressed(&self, id: &str) -> bool {
        self.state
            .borrow()
            .projects
            .get(id)
            .is_some_and(|p| p.suppressed == Some(true))
    }
    pub fn import_blocked(&self, id: &str) -> bool {
        self.state
            .borrow()
            .projects
            .get(id)
            .is_some_and(|project| project.import_blocked)
    }
    pub fn error(&self, id: &str) -> Option<String> {
        self.state.borrow().projects.get(id).and_then(|p| {
            if p.suppressed == Some(true) {
                return None;
            }
            p.preparation_error.clone().or_else(|| p.error.clone())
        })
    }
    pub fn suppress(&self, id: &str, suppressed: bool) -> Result<()> {
        self.update(|state| {
            let project = state.projects.entry(id.into()).or_default();
            project.suppressed = Some(suppressed);
            project.import_blocked = false;
            project.error = None;
        })
    }
    pub fn import(
        &self,
        migration: &crate::migration::Migration,
        projects: &[ProjectRegistration],
    ) -> Result<()> {
        let imported = self.state.borrow().imported_sources.clone();
        for source in migration.scheduling_suppressed(&imported, projects)? {
            self.update(|state| match source.suppressed {
                Ok(suppressed) => {
                    for id in source.projects {
                        let project = state.projects.entry(id.clone()).or_default();
                        project.import_blocked = false;
                        if project.error.as_deref() == Some("scheduleImportUnavailable") {
                            project.error = None;
                        }
                        if suppressed.contains(&id) {
                            project.suppressed.get_or_insert(true);
                            if project.suppressed == Some(true) {
                                project.error = None;
                            }
                        }
                    }
                    state.imported_sources.insert(source.source_id);
                }
                Err(_) => {
                    eprintln!(
                        "Host scheduling import is unavailable for source {}",
                        source.source_id
                    );
                    for id in source.projects {
                        let project = state.projects.entry(id).or_default();
                        if project.suppressed.is_none() {
                            project.import_blocked = true;
                            project.error = Some("scheduleImportUnavailable".into());
                        }
                    }
                }
            })?;
        }
        Ok(())
    }
    fn request(&self, id: &str) -> Result<String> {
        if let Some(request) = self
            .state
            .borrow()
            .projects
            .get(id)
            .and_then(|p| p.request_id.clone())
        {
            return Ok(request);
        }
        let request = uuid::Uuid::new_v4().to_string();
        self.update(|state| {
            state.projects.entry(id.into()).or_default().request_id = Some(request.clone())
        })?;
        Ok(request)
    }
    fn settled(&self, id: &str) -> Result<()> {
        self.update(|state| state.projects.entry(id.into()).or_default().request_id = None)
    }
    pub(super) fn result(&self, id: &str, result: Result<()>) -> Result<()> {
        // CLI stderr、配置路径和供应商错误可能含秘密，状态只公开固定的领域错误码。
        let code = result.err().map(|e| {
            e.downcast_ref::<wire::Error>()
                .map(|e| e.code)
                .unwrap_or("scheduleActivationFailed")
                .to_owned()
        });
        self.update(|state| {
            let project = state.projects.entry(id.into()).or_default();
            project.error = if project.suppressed == Some(true) {
                None
            } else {
                code
            };
        })
    }
    pub(super) fn preparation_result(&self, id: &str, result: Result<()>) -> Result<()> {
        let code = result.err().map(|cause| {
            cause
                .downcast_ref::<wire::Error>()
                .map(|cause| cause.code)
                .unwrap_or("schedulePreparationFailed")
                .to_owned()
        });
        self.update(|state| {
            state
                .projects
                .entry(id.into())
                .or_default()
                .preparation_error = code
        })
    }
    fn retry_needed(&self) -> bool {
        self.state
            .borrow()
            .projects
            .values()
            .any(|p| p.suppressed != Some(true) && p.error.is_some())
    }
}

pub(super) async fn run(host: Rc<Host>) {
    let mut attempt = 0u32;
    loop {
        scan(&host).await;
        host.changed();
        if host.schedules.retry_needed() {
            let delay = Duration::from_secs((5u64 << attempt.min(6)).min(300));
            attempt = attempt.saturating_add(1);
            tokio::select! { _ = host.schedules.wake.notified() => {attempt = 0;}, _ = tokio::time::sleep(delay) => {} }
        } else {
            attempt = 0;
            host.schedules.wake.notified().await;
        }
    }
}
async fn scan(host: &Host) {
    let projects = host
        .slots
        .borrow()
        .values()
        .map(|slot| slot.registration.clone())
        .collect::<Vec<_>>();
    if host.schedules.import(&host.migration, &projects).is_err() {
        eprintln!("Host scheduling import could not be read");
        return;
    }
    let queue = RefCell::new(host.slots.borrow().keys().cloned().collect::<VecDeque<_>>());
    let worker = || async {
        loop {
            let Some(id) = queue.borrow_mut().pop_front() else {
                return;
            };
            if host.schedules.suppressed(&id)
                || host.schedules.import_blocked(&id)
                || host.admission().is_err()
            {
                continue;
            }
            let result = activate(host, &id).await;
            if host.schedules.result(&id, result).is_err() {
                host.schedules
                    .state
                    .borrow_mut()
                    .projects
                    .entry(id)
                    .or_default()
                    .error = Some("scheduleStateUnavailable".into());
                eprintln!("Host scheduling state could not be saved");
            }
        }
    };
    tokio::join!(worker(), worker());
}
async fn activate(host: &Host, id: &str) -> Result<()> {
    host.admission()?;
    if super::schedule_connection::activation_pending(host, id).await? {
        return Ok(());
    }
    if host.migration.unpublished_reserved(id)? {
        return Err(error("migrationBlocked", "unpublished schedule owner"));
    }
    let registration = host.slots.borrow()[id].registration.clone();
    host.migration.assert_scheduling_available(&registration)?;
    let pending = host
        .schedules
        .state
        .borrow()
        .projects
        .get(id)
        .and_then(|p| p.request_id.clone());
    if let Some(request) = pending
        && let Some(receipt) = host.reconcile(&request).await?
    {
        match receipt["state"].as_str() {
            Some("completed") => {
                host.schedules.settled(id)?;
            }
            Some("blocked") => {
                host.schedules.settled(id)?;
                return Err(error(
                    "scheduleActivationBlocked",
                    "original activation was blocked",
                ));
            }
            _ => {
                return Err(error(
                    "scheduleAdmissionUnknown",
                    "reconcile original scheduled activation",
                ));
            }
        }
    }
    let status = host.project_status(id).await;
    if status.state == "ready" && status.service.is_some() {
        return Ok(());
    }
    if !enabled_catalog(&host.bin, &registration).await? {
        return Ok(());
    }
    let inputs = host
        .home
        .join("host/launch")
        .join(storage::digest(id.as_bytes()))
        .join("inputs.json");
    if !inputs.try_exists()? {
        return Err(error(
            "configurationConflict",
            "scheduled activation requires saved launch inputs",
        ));
    }
    let request = host.schedules.request(id)?;
    let result = host
        .ensure_cause(
            Ensure {
                request_id: request.clone(),
                expected_generation: host.identity.generation.clone(),
                project_id: id.into(),
                no_auto_restart: false,
                resume_scheduling: false,
                launch_inputs: None,
                credentials: BTreeMap::new(),
            },
            true,
        )
        .await;
    match host.receipt(&request)? {
        Some(record)
            if matches!(
                record.receipt["state"].as_str(),
                Some("completed" | "blocked")
            ) =>
        {
            host.schedules.settled(id)?;
        }
        None => {
            host.schedules.settled(id)?;
        }
        _ => {}
    }
    result?;
    Ok(())
}
async fn enabled_catalog(bin: &Path, registration: &ProjectRegistration) -> Result<bool> {
    let mut command = TrustedCommand::supervised(&bin.join("areal"), &[])?;
    command
        .env_clear()
        .args(["service", "task-catalog", "--workspace"])
        .arg(&registration.workspace)
        .arg("--data-dir")
        .arg(&registration.data_dir)
        .args(["--limit", "1024", "--json"]);
    for name in ["HOME", "PATH", "TMPDIR", "LANG"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    let output = command.output(Duration::from_secs(5)).await?;
    ensure!(
        output.status.success(),
        error(
            "scheduleCatalogUnavailable",
            "published catalog command failed"
        )
    );
    let value: Value = serde_json::from_slice(&output.stdout)?;
    catalog_enabled(value, registration)
}
fn catalog_enabled(value: Value, registration: &ProjectRegistration) -> Result<bool> {
    let (target, _) =
        areal_local_service::catalog_target(&registration.workspace, &registration.data_dir)?;
    ensure!(
        value["version"] == 2
            && value["source"] == "published"
            && value["executionState"] == "unobserved"
            && value["target"] == serde_json::to_value(target)?,
        error(
            "scheduleCatalogInvalid",
            "published catalog identity mismatch"
        )
    );
    match value["catalog"]["kind"].as_str() {
        Some("empty") => Ok(false),
        Some("requiresCore") => Err(error(
            "scheduleCatalogRequiresCore",
            "published catalog requires Core",
        )),
        Some("snapshot") => {
            let catalog = &value["catalog"];
            ensure!(
                catalog["hasMore"].is_boolean(),
                error("scheduleCatalogInvalid", "invalid catalog coverage")
            );
            ensure!(
                catalog["rootDigest"]
                    .as_str()
                    .is_some_and(|d| d.len() == 64 && d.bytes().all(|c| c.is_ascii_hexdigit())),
                error("scheduleCatalogInvalid", "invalid catalog digest")
            );
            let data = catalog["data"]
                .as_array()
                .ok_or_else(|| error("scheduleCatalogInvalid", "invalid catalog rows"))?;
            ensure!(
                data.len() <= 1024
                    && data
                        .iter()
                        .all(|row| row["mode"] == "scheduled" && row["enabled"].is_boolean()),
                error("scheduleCatalogInvalid", "invalid schedule rows")
            );
            let enabled = data.iter().any(|row| row["enabled"] == true);
            ensure!(
                enabled || catalog["hasMore"] == false,
                error(
                    "scheduleCatalogIncomplete",
                    "published catalog is incomplete"
                )
            );
            Ok(enabled)
        }
        _ => Err(error("scheduleCatalogInvalid", "invalid published catalog")),
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use crate::ProjectSource;

    pub(in crate::server) fn fixture(root: &Path) -> Host {
        let home = root.join("home");
        for path in [
            &home,
            &home.join("host/operations"),
            &root.join("workspace"),
        ] {
            storage::private_dir(path).unwrap();
        }
        let registration = ProjectRegistration {
            project_id: "project".into(),
            workspace: root.join("workspace"),
            data_dir: home.join("data"),
            source: ProjectSource::Cli,
            default_binding: false,
        };
        let (changes, _) = watch::channel(0);
        Host {
            home: home.clone(),
            bin: root.join("bin"),
            identity: HostIdentity {
                version: VERSION,
                host_id: uuid::Uuid::new_v4().to_string(),
                generation: uuid::Uuid::new_v4().to_string(),
                socket_path: home.join("socket"),
                auth_file: home.join("auth"),
                pid: std::process::id(),
                executable_version: "fixture".into(),
            },
            token: "fixture".into(),
            slots: RefCell::new(BTreeMap::from([(
                "project".into(),
                Slot::imported(registration),
            )])),
            stop: RefCell::new(None),
            host_stop_gate: Mutex::new(()),
            changes,
            exit: Notify::new(),
            migration: crate::migration::Migration::new(&home).unwrap().into(),
            gateway: super::gateway_owner::Gateway::default(),
            subscriptions: super::subscriptions::Subscriptions::default(),
            power: super::power::Power::default(),
            read_models: Default::default(),
            loopback: super::loopback::Loopback::default(),
            journal: crate::journal::Journal::new(&home).unwrap(),
            remote: crate::remote_state::RemoteState::new(&home),
            schedules: Schedules::load(&home).unwrap(),
        }
    }
    fn input(host: &Host, resume: bool) -> Ensure {
        Ensure {
            request_id: uuid::Uuid::new_v4().to_string(),
            expected_generation: host.identity.generation.clone(),
            project_id: "project".into(),
            no_auto_restart: false,
            resume_scheduling: resume,
            launch_inputs: None,
            credentials: BTreeMap::new(),
        }
    }
    fn catalog(host: &Host, catalog: Value) -> Value {
        let registration = host.slots.borrow()["project"].registration.clone();
        let (target, _) =
            areal_local_service::catalog_target(&registration.workspace, &registration.data_dir)
                .unwrap();
        json!({"version":2,"source":"published","executionState":"unobserved","target":target,"catalog":catalog})
    }
    #[test]
    fn catalog_requires_positive_published_evidence_and_keeps_incomplete_distinct() {
        let directory = tempfile::tempdir().unwrap();
        let host = fixture(directory.path());
        let registration = &host.slots.borrow()["project"].registration;
        assert!(!catalog_enabled(catalog(&host, json!({"kind":"empty"})), registration).unwrap());
        for (catalog_value, code) in [
            (
                json!({"kind":"requiresCore","reason":"legacyFormat"}),
                "scheduleCatalogRequiresCore",
            ),
            (
                json!({"kind":"snapshot","rootDigest":"a".repeat(64),"hasMore":true,"data":[{"mode":"scheduled","enabled":false}]}),
                "scheduleCatalogIncomplete",
            ),
        ] {
            let error = catalog_enabled(catalog(&host, catalog_value), registration).unwrap_err();
            assert_eq!(error.downcast_ref::<wire::Error>().unwrap().code, code);
        }
        assert!(catalog_enabled(catalog(&host,json!({"kind":"snapshot","rootDigest":"a".repeat(64),"hasMore":true,"data":[{"mode":"scheduled","enabled":true}]})),registration).unwrap());
        let mut wrong = catalog(&host, json!({"kind":"empty"}));
        wrong["target"]["workspace"] = json!("/foreign");
        assert_eq!(
            catalog_enabled(wrong, registration)
                .unwrap_err()
                .downcast_ref::<wire::Error>()
                .unwrap()
                .code,
            "scheduleCatalogInvalid"
        );
    }
    #[tokio::test(flavor = "current_thread")]
    async fn suppression_survives_passive_status_and_only_explicit_resume_clears_it() {
        let directory = tempfile::tempdir().unwrap();
        let host = fixture(directory.path());
        host.schedules.suppress("project", true).unwrap();
        assert!(host.status().await.projects[0].schedule_activation_suppressed);
        assert!(Schedules::load(&host.home).unwrap().suppressed("project"));
        assert!(host.ensure(input(&host, false)).await.is_err());
        assert!(host.schedules.suppressed("project"));
        let resume = input(&host, true);
        let request = resume.request_id.clone();
        assert!(host.ensure(resume).await.is_err());
        assert!(!Schedules::load(&host.home).unwrap().suppressed("project"));
        assert_eq!(
            host.receipt(&request).unwrap().unwrap().receipt["state"],
            "blocked"
        );
    }
    #[tokio::test(flavor = "current_thread")]
    async fn schedule_guard_waits_for_project_gate_and_does_not_admit_after_stop() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let directory = tempfile::tempdir().unwrap();
                let host = Rc::new(fixture(directory.path()));
                let gate = host.gate("project").unwrap();
                let guard = gate.lock().await;
                let request = input(&host, false);
                let id = request.request_id.clone();
                let worker = host.clone();
                let task =
                    tokio::task::spawn_local(
                        async move { worker.ensure_cause(request, true).await },
                    );
                tokio::task::yield_now().await;
                host.schedules.suppress("project", true).unwrap();
                drop(guard);
                assert_eq!(
                    task.await
                        .unwrap()
                        .unwrap_err()
                        .downcast_ref::<wire::Error>()
                        .unwrap()
                        .code,
                    "schedulingSuppressed"
                );
                assert!(host.receipt(&id).unwrap().is_none());
            })
            .await;
    }
    #[tokio::test(flavor = "current_thread")]
    async fn unknown_scheduled_admission_keeps_original_request_across_restart() {
        let directory = tempfile::tempdir().unwrap();
        let host = fixture(directory.path());
        let request = host.schedules.request("project").unwrap();
        storage::write(&wire::operation_path(&host.home,&request),&Operation {digest:"fixture".into(),receipt:json!({"requestId":request,"projectId":"project","method":"project.ensure","state":"admissionUnknown"}),evidence:Value::Null}).unwrap();
        let before = std::fs::read(wire::operation_path(&host.home, &request)).unwrap();
        let error = activate(&host, "project").await.unwrap_err();
        assert_eq!(
            error.downcast_ref::<wire::Error>().unwrap().code,
            "scheduleAdmissionUnknown"
        );
        assert_eq!(
            Schedules::load(&host.home)
                .unwrap()
                .request("project")
                .unwrap(),
            request
        );
        assert_eq!(
            std::fs::read(wire::operation_path(&host.home, &request)).unwrap(),
            before
        );
        assert_eq!(
            std::fs::read_dir(host.home.join("host/operations"))
                .unwrap()
                .count(),
            1
        );
    }
    #[tokio::test(flavor = "current_thread")]
    async fn published_catalog_children_obey_two_worker_limit_without_starting_projects() {
        let directory = tempfile::tempdir().unwrap();
        let host = fixture(directory.path());
        storage::private_dir(&host.bin).unwrap();
        let meter = host.bin.join("meter.json");
        storage::write(&meter, &json!({"active":0,"maximum":0,"calls":0})).unwrap();
        let script = r#"#!/usr/bin/python3
import fcntl, hashlib, json, os, pathlib, sys, time
meter=pathlib.Path(__file__).with_name('meter.json')
def count(delta):
    with meter.open('r+') as file:
        fcntl.flock(file,fcntl.LOCK_EX)
        state=json.load(file)
        state['active']+=delta
        state['maximum']=max(state['maximum'],state['active'])
        if delta>0: state['calls']+=1
        file.seek(0); file.truncate(); json.dump(state,file); file.flush()
count(1)
try:
    time.sleep(0.1)
    workspace=str(pathlib.Path(sys.argv[sys.argv.index('--workspace')+1]).resolve())
    data=str(pathlib.Path(sys.argv[sys.argv.index('--data-dir')+1]).resolve())
    print(json.dumps({'version':2,'source':'published','executionState':'unobserved','target':{'workspace':workspace,'dataDir':data,'instanceId':hashlib.sha256(os.fsencode(data)).hexdigest()[:24]},'catalog':{'kind':'empty'}}))
finally:
    count(-1)
"#;
        std::fs::write(host.bin.join("areal"), script).unwrap();
        std::fs::set_permissions(
            host.bin.join("areal"),
            std::fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        let registration = host.slots.borrow()["project"].registration.clone();
        for index in 0..4 {
            let mut project = registration.clone();
            project.project_id = format!("project-{index}");
            project.data_dir = host.home.join(format!("data-{index}"));
            host.slots
                .borrow_mut()
                .insert(project.project_id.clone(), Slot::imported(project));
        }
        scan(&host).await;
        let meter: Value = storage::read(&meter).unwrap();
        assert_eq!(meter["calls"], 5);
        assert_eq!(meter["active"], 0);
        assert!((1..=2).contains(&meter["maximum"].as_u64().unwrap()));
        for id in host.slots.borrow().keys() {
            assert!(host.schedules.error(id).is_none());
            assert!(
                !host
                    .home
                    .join("host/launch")
                    .join(storage::digest(id.as_bytes()))
                    .exists()
            );
        }
        assert_eq!(
            std::fs::read_dir(host.home.join("host/operations"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn legacy_import_failure_is_source_local_and_resume_wins_when_import_recovers() {
        let directory = tempfile::tempdir().unwrap();
        let host = fixture(directory.path());
        let core = directory.path().join("legacy-core");
        storage::private_dir(&core).unwrap();
        let source = crate::migration::Source {
            profile: directory.path().join("profile"),
            core_home: core.clone(),
            legacy_service_home: directory.path().join("legacy-services"),
        };
        let ids = ["a".repeat(24), "b".repeat(24)];
        storage::write(&core.join("projects.json"),&json!([{"id":ids[0],"root":directory.path().join("workspace")},{"id":ids[1],"root":directory.path().join("workspace")}])).unwrap();
        host.migration
            .attach(source.clone(), "fixture", None)
            .unwrap();
        let imported=host.migration.import(serde_json::from_value(json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":host.identity.generation,"source":source})).unwrap(),"fixture",&[],&host.journal).unwrap();
        assert_eq!(imported["kind"], "ready");
        let projects = host.migration.published().unwrap();
        let lifecycle = core.join("lifecycle-operations");
        storage::private_dir(&lifecycle).unwrap();
        let path = lifecycle.join(format!("{}.json", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"{").unwrap();
        host.schedules
            .result(
                &ids[1],
                Err(error("scheduleCatalogUnavailable", "before import")),
            )
            .unwrap();
        host.schedules.import(&host.migration, &projects).unwrap();
        assert!(!host.schedules.import_blocked("project"));
        for id in &ids {
            assert!(host.schedules.import_blocked(id));
            assert_eq!(
                host.schedules.error(id).as_deref(),
                Some("scheduleImportUnavailable")
            );
        }
        assert!(host.schedules.state.borrow().imported_sources.is_empty());
        host.schedules.suppress(&ids[0], false).unwrap();
        host.schedules.import(&host.migration, &projects).unwrap();
        assert!(!host.schedules.import_blocked(&ids[0]));
        storage::write(&path,&json!({"version":1,"targets":[{"projectId":ids[0],"scheduleActivationSuppressed":true},{"projectId":ids[1],"scheduleActivationSuppressed":true}]})).unwrap();
        host.schedules.import(&host.migration, &projects).unwrap();
        assert!(!host.schedules.suppressed(&ids[0]));
        assert!(host.schedules.suppressed(&ids[1]));
        assert!(!host.schedules.import_blocked(&ids[1]));
        assert_eq!(host.schedules.state.borrow().imported_sources.len(), 1);
        host.schedules.suppress(&ids[1], false).unwrap();
        let restarted = Schedules::load(&host.home).unwrap();
        restarted.import(&host.migration, &projects).unwrap();
        assert!(!restarted.suppressed(&ids[1]));
    }

    #[test]
    fn maintenance_project_stop_preserves_existing_scheduling_intent() {
        let directory = tempfile::tempdir().unwrap();
        let host = fixture(directory.path());
        for suppressed in [false, true] {
            host.schedules.suppress("project", suppressed).unwrap();
            let stop = Stop {
                request_id: uuid::Uuid::new_v4().to_string(),
                expected_generation: host.identity.generation.clone(),
                strategy: StopStrategy::Cancel,
                suppress_scheduling: false,
                project_id: Some("project".into()),
                service_generation: Some("original".into()),
            };
            host.accepted(&stop.request_id, "project.stop", &stop, "project")
                .unwrap();
            host.apply_scheduling_intent(&stop.request_id).unwrap();
            assert_eq!(
                Schedules::load(&host.home).unwrap().suppressed("project"),
                suppressed
            );
        }
    }

    #[test]
    fn interrupted_scheduling_intent_is_recoverable_without_replaying_stop_or_activation() {
        let directory = tempfile::tempdir().unwrap();
        let host = fixture(directory.path());
        let stop = Stop {
            suppress_scheduling: true,
            request_id: uuid::Uuid::new_v4().to_string(),
            expected_generation: host.identity.generation.clone(),
            strategy: StopStrategy::Cancel,
            project_id: Some("project".into()),
            service_generation: Some("original".into()),
        };
        host.accepted(&stop.request_id, "project.stop", &stop, "project")
            .unwrap();
        assert!(!host.schedules.suppressed("project"));
        host.apply_scheduling_intent(&stop.request_id).unwrap();
        assert!(Schedules::load(&host.home).unwrap().suppressed("project"));
        let resume = input(&host, true);
        host.accepted(&resume.request_id, "project.ensure", &resume, "project")
            .unwrap();
        host.apply_scheduling_intent(&resume.request_id).unwrap();
        host.apply_scheduling_intent(&stop.request_id).unwrap();
        assert!(!Schedules::load(&host.home).unwrap().suppressed("project"));
        let ordinary = input(&host, false);
        assert!(
            serde_json::to_value(ordinary)
                .unwrap()
                .get("resumeScheduling")
                .is_none()
        );
    }
    #[tokio::test(flavor = "current_thread")]
    async fn successful_activation_scan_does_not_clear_preparation_failure() {
        let directory = tempfile::tempdir().unwrap();
        let host = fixture(directory.path());
        let gate = host.gate("project").unwrap();
        let _guard = gate.lock().await;
        let registration = host.slots.borrow()["project"].registration.clone();
        let (writer, lifetime) = OwnerLifetime::pair().unwrap();
        {
            let mut slots = host.slots.borrow_mut();
            let slot = slots.get_mut("project").unwrap();
            slot.writer = Some(writer);
            slot.lifetime = Some(Rc::new(lifetime));
            slot.state = "ready".into();
            slot.service = Some(serde_json::from_value(json!({"protocolVersion":1,"serviceId":"fixture","generation":"fixture","workspace":registration.workspace,"dataDir":registration.data_dir,"configFingerprint":"fixture","owner":host.owner(),"endpoint":"ws://127.0.0.1:1/","webUrl":"","authFile":"/tmp/auth","logFile":"/tmp/log","hostPid":1,"corePid":2,"state":"ready"})).unwrap());
        }
        host.schedules
            .preparation_result(
                "project",
                Err(error(
                    "scheduleAdmissionUnknown",
                    "original refresh blocked",
                )),
            )
            .unwrap();
        scan(&host).await;
        assert_eq!(
            host.schedules.error("project").as_deref(),
            Some("scheduleAdmissionUnknown")
        );
        let loaded = Schedules::load(&host.home).unwrap();
        assert_eq!(
            loaded.error("project").as_deref(),
            Some("scheduleAdmissionUnknown")
        );
        loaded.suppress("project", true).unwrap();
        assert!(loaded.error("project").is_none());
        loaded.suppress("project", false).unwrap();
        assert_eq!(
            loaded.error("project").as_deref(),
            Some("scheduleAdmissionUnknown")
        );
        loaded.preparation_result("project", Ok(())).unwrap();
        assert!(loaded.error("project").is_none());
    }
    #[tokio::test(flavor = "current_thread")]
    async fn ordinary_ensure_after_stop_keeps_suppression_without_waiting_for_scheduler() {
        let directory = tempfile::tempdir().unwrap();
        let host = fixture(directory.path());
        host.schedules.suppress("project", true).unwrap();
        let request = input(&host, false);
        let (digest, _) = host
            .accepted(&request.request_id, "project.ensure", &request, "project")
            .unwrap();
        let expected = json!({"service":{"generation":"ordinary-core"}});
        host.finish_mutation(&request.request_id, &digest, Ok(expected.clone()))
            .unwrap();
        let result = tokio::time::timeout(Duration::from_millis(100), host.ensure(request))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result, expected);
        assert!(host.schedules.suppressed("project"));
    }
}
