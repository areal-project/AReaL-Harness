use crate::{
    Activity, HostIdentity, HostStatus, LaunchInputs, OpenResult, ProjectRegistration,
    ResolveProject, StopStrategy, VERSION, wire,
};
use anyhow::{Context, Result, ensure};
use areal_local_service::{native_process::TrustedCommand, storage};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{io::BufReader, net::UnixStream};

#[derive(Clone)]
pub struct Client {
    home: PathBuf,
    identity: HostIdentity,
}
impl Client {
    pub async fn tasks_read(&self, params: Value) -> Result<Value> {
        self.call("tasks.read", params).await
    }
    pub async fn tasks_command(&self, params: Value) -> Result<Value> {
        self.call("tasks.command", params).await
    }
    pub async fn worktree_read(&self, params: Value) -> Result<Value> {
        self.call("worktree.read", params).await
    }
    pub async fn worktree_command(&self, command_id: &str, params: Value) -> Result<Value> {
        self.call(
            "worktree.command",
            json!({"commandId":command_id,"request":params}),
        )
        .await
    }

    pub fn identity(&self) -> &HostIdentity {
        &self.identity
    }
    pub fn version_notice(&self) -> Option<String> {
        version_notice(&self.identity.executable_version, env!("CARGO_PKG_VERSION"))
    }
    pub async fn connect() -> Result<Self> {
        Self::connect_at(areal_local_service::raw_home()?).await
    }
    pub async fn connect_at(home: PathBuf) -> Result<Self> {
        let raw_meta = std::fs::symlink_metadata(&home)?;
        ensure!(raw_meta.is_dir(), "Host home must not be a symbolic link");
        let home = storage::canonical_pending(&home)?;
        for directory in [&home, &home.join("host")] {
            let metadata = std::fs::symlink_metadata(directory)?;
            ensure!(
                metadata.is_dir()
                    && metadata.uid() == unsafe { libc::geteuid() }
                    && metadata.mode() & 0o077 == 0,
                "Host discovery directory must be private and owned by this user"
            );
        }
        let identity: HostIdentity = storage::read(&home.join("host/host.json"))?;
        ensure!(
            identity.version == VERSION
                && identity.auth_file == home.join("host/auth.json")
                && identity.socket_path == storage::control_socket(&home.join("host"))?,
            "invalid Host descriptor"
        );
        let client = Self { home, identity };
        client.connection().await?;
        Ok(client)
    }
    pub async fn connect_or_start() -> Result<Self> {
        Self::connect_or_start_at(areal_local_service::raw_home()?).await
    }
    pub async fn connect_or_start_at(home: PathBuf) -> Result<Self> {
        if let Ok(client) = Self::connect_at(home.clone()).await {
            if let Some(notice) = client.version_notice() {
                eprintln!("{notice}");
            }
            return Ok(client);
        }
        let home = storage::prepare_host_home(&home)?;
        let binary = std::env::current_exe()?.canonicalize()?;
        let mut command = TrustedCommand::persistent(&binary)?;
        command
            .env_clear()
            .env("AREAL_HARNESS_HOME", &home)
            .env("AREAL_HARNESS_SERVICE_HOME", &home);
        for name in ["HOME", "PATH", "TMPDIR", "LANG", "AREAL_HOST_WEBSOCKET"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command
            .args(["host", "run"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(storage::open_private(&home.join("host.log"), true)?)
            .kill_on_drop(false);
        let mut child = command.spawn().await?;
        drop(command);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            if let Ok(client) = Self::connect_at(home.clone()).await {
                tokio::spawn(async move {
                    let _ = child.wait().await;
                });
                if let Some(notice) = client.version_notice() {
                    eprintln!("{notice}");
                }
                return Ok(client);
            }
            if let Some(status) = child.try_wait()? {
                ensure!(
                    status.success() || status.code() == Some(73),
                    "Host launch failed: {status}"
                );
            }
            ensure!(
                tokio::time::Instant::now() < deadline,
                "Host startup timed out"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    async fn connection(&self) -> Result<BufReader<UnixStream>> {
        let meta = std::fs::symlink_metadata(&self.identity.socket_path)?;
        ensure!(
            std::os::unix::fs::FileTypeExt::is_socket(&meta.file_type())
                && meta.uid() == unsafe { libc::geteuid() }
                && meta.mode() & 0o077 == 0,
            "invalid Host socket permissions"
        );
        let token: String = storage::read(&self.identity.auth_file)?;
        let stream = UnixStream::connect(&self.identity.socket_path).await?;
        ensure!(
            stream.peer_cred()?.uid() == unsafe { libc::geteuid() },
            "invalid Host peer"
        );
        let mut connection = BufReader::new(stream);
        wire::write(connection.get_mut(),&json!({"version":VERSION,"id":"hello","method":"hello","params":{"protocolVersions":[VERSION],"capabilities":["projects","stopOperations"],"authToken":token}})).await?;
        let response = tokio::time::timeout(Duration::from_secs(10), wire::read(&mut connection))
            .await??
            .context("Host closed handshake")?;
        let result = response_result(response, "hello")?;
        ensure!(
            result["hostId"] == self.identity.host_id
                && result["generation"] == self.identity.generation,
            "Host generation changed; reconnect before a new operation"
        );
        Ok(connection)
    }
    async fn call<T: DeserializeOwned>(&self, method: &str, params: Value) -> Result<T> {
        let mut connection = self.connection().await?;
        let id = uuid::Uuid::new_v4().to_string();
        wire::write(
            connection.get_mut(),
            &json!({"version":VERSION,"id":id,"method":method,"params":params}),
        )
        .await?;
        let response = wire::read(&mut connection)
            .await?
            .context("Host disconnected; reconcile the original requestId before any retry")?;
        Ok(serde_json::from_value(response_result(response, &id)?)?)
    }
    pub async fn web_ticket(
        &self,
        origin: &str,
    ) -> Result<areal_protocol::host::LocalWebTicketResult> {
        self.call(
            "web.ticket",
            json!({"origin":origin,"expectedGeneration":self.identity.generation}),
        )
        .await
    }
    pub async fn web_endpoint(&self) -> Result<areal_protocol::host::LoopbackEndpoint> {
        self.call("web.endpoint", json!({})).await
    }
    pub async fn approve_browser(
        &self,
        request_id: &str,
    ) -> Result<areal_protocol::host::LocalWebApproveResult> {
        self.call(
            "web.approve",
            json!({"requestId":request_id,"expectedGeneration":self.identity.generation}),
        )
        .await
    }
    pub async fn approve_browser_with_scopes(
        &self,
        request_id: &str,
        scopes: &[&str],
    ) -> Result<areal_protocol::host::LocalWebApproveResult> {
        self.call("web.approve", json!({"requestId":request_id,"expectedGeneration":self.identity.generation,"scopes":scopes})).await
    }
    pub async fn browser_devices(&self) -> Result<areal_protocol::host::LocalWebDevicesResult> {
        self.call("web.devices", json!({})).await
    }
    pub async fn revoke_browser(
        &self,
        device_id: &str,
    ) -> Result<areal_protocol::host::LocalWebRevokeResult> {
        self.call(
            "web.revoke",
            json!({"deviceId":device_id,"expectedGeneration":self.identity.generation}),
        )
        .await
    }
    pub async fn status(&self) -> Result<HostStatus> {
        self.call("host.status", json!({})).await
    }
    pub async fn activity(&self) -> Result<Activity> {
        self.call("host.activity", json!({})).await
    }
    pub async fn update_status(&self) -> Result<Value> {
        self.call("host.updateStatus", json!({})).await
    }
    pub async fn prepare_update(
        &self,
        request_id: &str,
        expected_generation: &str,
        target_version: &str,
    ) -> Result<Value> {
        self.call("host.update", json!({"requestId":request_id,"expectedGeneration":expected_generation,"action":"prepare","targetVersion":target_version})).await
            .with_context(|| format!("host.update prepare requestId {request_id}; query the original operation after a lost reply"))
    }
    pub async fn apply_update(
        &self,
        request_id: &str,
        expected_generation: &str,
        target_version: &str,
        strategy: StopStrategy,
    ) -> Result<Value> {
        self.call("host.update", json!({"requestId":request_id,"expectedGeneration":expected_generation,"action":"apply","targetVersion":target_version,"strategy":strategy})).await
            .with_context(|| format!("host.update apply requestId {request_id}; query the original operation after a lost reply"))
    }
    pub async fn list(&self) -> Result<Vec<ProjectRegistration>> {
        let result: Value = self.call("projects.list", json!({})).await?;
        Ok(serde_json::from_value(result["projects"].clone())?)
    }
    pub async fn register(
        &self,
        request_id: &str,
        registration: ProjectRegistration,
    ) -> Result<ProjectRegistration> {
        let result:Value=self.call("projects.register",json!({"requestId":request_id,"expectedGeneration":self.identity.generation,"registration":registration})).await.with_context(||format!("projects.register requestId {request_id}; use host.operation to reconcile a lost response"))?;
        Ok(serde_json::from_value(result["registration"].clone())?)
    }
    pub async fn bind_registration(
        &self,
        request_id: &str,
        registration: ProjectRegistration,
    ) -> Result<ProjectRegistration> {
        let result:Value=self.call("projects.register",json!({"requestId":request_id,"expectedGeneration":self.identity.generation,"registration":registration,"bindExisting":true})).await.with_context(||format!("projects.register requestId {request_id}; use host.operation to reconcile a lost response"))?;
        Ok(serde_json::from_value(result["registration"].clone())?)
    }
    pub async fn ensure(
        &self,
        request_id: &str,
        project_id: &str,
        launch_inputs: Option<LaunchInputs>,
        credentials: BTreeMap<String, String>,
    ) -> Result<OpenResult> {
        self.ensure_with_restart_policy(request_id, project_id, launch_inputs, credentials, false)
            .await
    }
    pub async fn ensure_with_restart_policy(
        &self,
        request_id: &str,
        project_id: &str,
        launch_inputs: Option<LaunchInputs>,
        credentials: BTreeMap<String, String>,
        no_auto_restart: bool,
    ) -> Result<OpenResult> {
        let mut params = json!({"requestId":request_id,"expectedGeneration":self.identity.generation,"projectId":project_id,"credentials":credentials,"noAutoRestart":no_auto_restart});
        if let Some(inputs) = launch_inputs {
            params["launchInputs"] = serde_json::to_value(inputs)?;
        }
        self.call("project.ensure", params).await.with_context(||format!("project.ensure requestId {request_id}; use host.operation to reconcile a lost response"))
    }
    pub async fn open(&self, input: ResolveProject) -> Result<OpenResult> {
        self.open_with_request(&uuid::Uuid::new_v4().to_string(), input)
            .await
    }
    pub async fn open_with_request(
        &self,
        request_id: &str,
        mut input: ResolveProject,
    ) -> Result<OpenResult> {
        let projects = self.list().await?;
        if let Some(existing) = select_project(&projects, &input)? {
            input.registration = existing.clone();
        } else {
            if let Some(id) = &input.requested_project_id {
                input.registration.project_id = id.clone();
            }
            match self
                .register(
                    &uuid::Uuid::new_v4().to_string(),
                    input.registration.clone(),
                )
                .await
            {
                Ok(registration) => input.registration = registration,
                Err(original) => {
                    if original
                        .downcast_ref::<RemoteError>()
                        .is_none_or(|error| error.code != "dataDirConflict")
                    {
                        return Err(original);
                    }
                    let current = self.list().await?;
                    let existing = select_project(&current, &input)?;
                    if let Some(existing) = existing {
                        input.registration = existing.clone();
                    } else {
                        return Err(original);
                    }
                }
            }
        }
        input.launch_inputs.options.data_dir = Some(input.registration.data_dir.clone());
        self.ensure_with_restart_policy(
            request_id,
            &input.registration.project_id,
            Some(input.launch_inputs),
            input.credentials,
            input.no_auto_restart,
        )
        .await
    }
    pub async fn restart(
        &self,
        mut input: ResolveProject,
        strategy: StopStrategy,
    ) -> Result<OpenResult> {
        let projects = self.list().await?;
        let Some(registration) = select_project(&projects, &input)?.cloned() else {
            return self.open(input).await;
        };
        input.registration = registration.clone();
        input.requested_project_id = Some(registration.project_id.clone());
        input.launch_inputs.options.data_dir = Some(registration.data_dir.clone());
        let status = self
            .status()
            .await?
            .projects
            .into_iter()
            .find(|project| project.registration.project_id == registration.project_id)
            .context("projectNotFound")?;
        if status.state == "stopped" {
            return self.open(input).await;
        }
        ensure!(
            matches!(status.state.as_str(), "ready" | "legacyPending"),
            "project is {}; reconcile its existing lifecycle operation before restarting",
            status.state
        );
        let generation = status
            .service
            .as_ref()
            .map(|service| service.identity.generation.as_str())
            .or_else(|| {
                status
                    .migration
                    .as_ref()
                    .and_then(|migration| migration["generation"].as_str())
            })
            .context("service generation unavailable")?;
        let request_id = uuid::Uuid::new_v4().to_string();
        let receipt = self
            .stop_project(&request_id, &registration.project_id, generation, strategy)
            .await?;
        ensure!(
            receipt["state"] == "completed",
            "restart stop is {}; reconcile host.operation requestId {} before activation",
            receipt["state"],
            request_id
        );
        self.open(input).await
    }
    pub async fn reconnect(&self, project_id: &str) -> Result<OpenResult> {
        let project = self
            .status()
            .await?
            .projects
            .into_iter()
            .find(|p| p.registration.project_id == project_id)
            .context("projectNotFound")?;
        let service = project.service.clone();
        ensure!(
            project.state == "ready" && service.is_some(),
            "project is {}; explicit activation required",
            project.state
        );
        Ok(OpenResult { project, service })
    }
    pub async fn stop_project(
        &self,
        request_id: &str,
        project_id: &str,
        service_generation: &str,
        strategy: StopStrategy,
    ) -> Result<Value> {
        self.call("project.stop",json!({"requestId":request_id,"expectedGeneration":self.identity.generation,"projectId":project_id,"serviceGeneration":service_generation,"strategy":strategy})).await.with_context(||format!("project.stop requestId {request_id}; use host.operation to reconcile a lost response"))
    }
    pub async fn stop(
        &self,
        request_id: &str,
        expected_generation: &str,
        strategy: StopStrategy,
    ) -> Result<Value> {
        self.call("host.stop",json!({"requestId":request_id,"expectedGeneration":expected_generation,"strategy":strategy})).await.with_context(||format!("host.stop requestId {request_id}; use host.operation to reconcile a lost response"))
    }
    pub async fn operation(&self, request_id: &str) -> Result<Option<Value>> {
        let result: Value = self
            .call("host.operation", json!({"requestId":request_id}))
            .await?;
        Ok((!result["operation"].is_null()).then(|| result["operation"].clone()))
    }
    pub fn operation_offline(&self, request_id: &str) -> Result<Option<Value>> {
        crate::operation_offline(&self.home, request_id)
    }
    pub async fn subscribe(&self) -> Result<Subscription> {
        let mut connection = self.connection().await?;
        wire::write(
            connection.get_mut(),
            &json!({"version":VERSION,"id":"subscribe","method":"host.subscribe","params":{}}),
        )
        .await?;
        let initial = response_result(
            wire::read(&mut connection)
                .await?
                .context("subscription closed")?,
            "subscribe",
        )?;
        Ok(Subscription {
            connection,
            initial,
        })
    }
    pub fn home(&self) -> &Path {
        &self.home
    }
}

fn version_notice(host: &str, client: &str) -> Option<String> {
    match crate::server::updates::compare_versions(host, client).ok()? {
        std::cmp::Ordering::Less => Some(format!(
            "Host {host} is older than CLI/TUI {client}; upgrade restart pending. Active tasks are preserved. When idle, run areal host stop, then reopen with the newer CLI or desktop application."
        )),
        std::cmp::Ordering::Greater => Some(format!(
            "Connected to newer Host {host} with CLI/TUI {client}; the newer Host is retained without downgrade. Upgrade your CLI/TUI."
        )),
        std::cmp::Ordering::Equal => None,
    }
}
pub struct Subscription {
    connection: BufReader<UnixStream>,
    pub initial: Value,
}
impl Subscription {
    pub async fn next(&mut self) -> Result<Option<Value>> {
        wire::read(&mut self.connection).await
    }
}
#[derive(Debug)]
struct RemoteError {
    code: String,
    message: String,
}
impl std::fmt::Display for RemoteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for RemoteError {}
fn response_result(response: Value, id: &str) -> Result<Value> {
    ensure!(
        response["version"] == VERSION && response["id"] == id,
        "invalid Host response envelope"
    );
    if let Some(error) = response.get("error") {
        return Err(RemoteError {
            code: error["code"].as_str().unwrap_or("internalError").into(),
            message: error["message"]
                .as_str()
                .unwrap_or("Host request failed")
                .into(),
        }
        .into());
    }
    response
        .get("result")
        .cloned()
        .context("missing Host response result")
}

fn select_project<'a>(
    projects: &'a [ProjectRegistration],
    input: &ResolveProject,
) -> Result<Option<&'a ProjectRegistration>> {
    if let Some(id) = &input.requested_project_id {
        let selected = projects.iter().find(|p| &p.project_id == id);
        if let Some(selected) = selected {
            ensure!(
                selected.workspace == input.registration.workspace
                    && (!input.explicit_data_dir
                        || selected.data_dir == input.registration.data_dir),
                "projectConflict: explicit project binding differs"
            );
        }
        return Ok(selected);
    }
    let candidates: Vec<_> = projects
        .iter()
        .filter(|p| {
            p.workspace == input.registration.workspace
                && (!input.explicit_data_dir || p.data_dir == input.registration.data_dir)
        })
        .collect();
    if candidates.len() < 2 {
        return Ok(candidates.first().copied());
    }
    let defaults: Vec<_> = candidates
        .iter()
        .copied()
        .filter(|p| p.default_binding)
        .collect();
    if defaults.len() == 1 {
        return Ok(defaults.first().copied());
    }
    anyhow::bail!(
        "projectAmbiguous: choose a projectId from {}",
        candidates
            .iter()
            .map(|p| p.project_id.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_version_notices_preserve_the_newer_host_and_active_work() {
        let versions = ["0.1.8", "0.1.18", "0.1.19-beta.1", "0.1.19"];
        for (i, host) in versions.iter().enumerate() {
            for (j, client) in versions.iter().enumerate() {
                match i.cmp(&j) {
                    std::cmp::Ordering::Less => {
                        let notice = version_notice(host, client).unwrap();
                        assert!(notice.contains("restart pending"));
                        assert!(notice.contains("Active tasks are preserved"));
                        assert!(notice.contains("When idle"));
                    }
                    std::cmp::Ordering::Greater => {
                        let notice = version_notice(host, client).unwrap();
                        assert!(notice.contains("without downgrade"));
                        assert!(notice.contains("Upgrade your CLI/TUI"));
                    }
                    std::cmp::Ordering::Equal => assert!(version_notice(host, client).is_none()),
                }
            }
        }
        assert!(version_notice("fixture", "0.1.19").is_none());
    }

    #[tokio::test]
    async fn client_connect_or_start_reuses_both_older_and_newer_hosts_without_stop() {
        use std::os::unix::fs::PermissionsExt;
        for version in ["0.1.18", "0.1.19-beta.1", "9.0.0"] {
            let root = tempfile::tempdir().unwrap();
            let home = storage::prepare_host_home(root.path()).unwrap();
            let host_dir = home.join("host");
            storage::private_dir(&host_dir).unwrap();
            let socket = storage::control_socket(&host_dir).unwrap();
            let listener = tokio::net::UnixListener::bind(&socket).unwrap();
            std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600)).unwrap();
            let identity = HostIdentity {
                version: VERSION,
                host_id: "fixture-host".into(),
                generation: "fixture-generation".into(),
                socket_path: socket,
                auth_file: host_dir.join("auth.json"),
                pid: std::process::id(),
                executable_version: version.into(),
            };
            storage::write(&host_dir.join("host.json"), &identity).unwrap();
            storage::write(&identity.auth_file, &"fixture-token").unwrap();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut stream = BufReader::new(stream);
                let request = wire::read(&mut stream).await.unwrap().unwrap();
                assert_eq!(request["method"], "hello");
                wire::write(stream.get_mut(), &json!({"version":VERSION,"id":"hello","result":{"hostId":"fixture-host","generation":"fixture-generation"}})).await.unwrap();
            });
            let client = Client::connect_or_start_at(home.clone()).await.unwrap();
            assert_eq!(client.identity().executable_version, version);
            assert_eq!(client.identity().generation, identity.generation);
            assert_eq!(
                storage::read::<HostIdentity>(&host_dir.join("host.json"))
                    .unwrap()
                    .executable_version,
                version
            );
            assert!(!home.join("host.log").exists());
            server.await.unwrap();
        }
    }
    fn input() -> ResolveProject {
        let registration = ProjectRegistration {
            project_id: "new".into(),
            workspace: "/workspace".into(),
            data_dir: "/default-state".into(),
            source: crate::ProjectSource::Cli,
            default_binding: false,
        };
        ResolveProject {
            explicit_data_dir: false,
            no_auto_restart: false,
            requested_project_id: None,
            launch_inputs: LaunchInputs {
                workspace: registration.workspace.clone(),
                cwd: "/workspace".into(),
                config_home: "/configuration".into(),
                homedir: None,
                config_path: None,
                deployment_path: None,
                schedule_preparation: None,
                environment: BTreeMap::new(),
                credential_names: Vec::new(),
                options: areal_local_service::LocalArgs::default(),
            },
            registration,
            credentials: BTreeMap::new(),
            tool_extensions_file: None,
        }
    }
    #[test]
    fn project_selection_requires_unique_binding_or_explicit_identity() {
        let mut input = input();
        let mut first = input.registration.clone();
        first.project_id = "one".into();
        first.data_dir = "/first".into();
        let mut second = first.clone();
        second.project_id = "two".into();
        second.data_dir = "/second".into();
        assert_eq!(
            select_project(&[first.clone()], &input)
                .unwrap()
                .unwrap()
                .project_id,
            "one"
        );
        assert!(
            select_project(&[first.clone(), second.clone()], &input)
                .unwrap_err()
                .to_string()
                .contains("projectAmbiguous")
        );
        second.default_binding = true;
        assert_eq!(
            select_project(&[first.clone(), second.clone()], &input)
                .unwrap()
                .unwrap()
                .project_id,
            "two"
        );
        input.explicit_data_dir = true;
        input.registration.data_dir = first.data_dir.clone();
        assert_eq!(
            select_project(&[first.clone(), second.clone()], &input)
                .unwrap()
                .unwrap()
                .project_id,
            "one"
        );
        input.requested_project_id = Some("two".into());
        assert!(select_project(&[first.clone(), second.clone()], &input).is_err());
        input.explicit_data_dir = false;
        assert_eq!(
            select_project(&[first, second], &input)
                .unwrap()
                .unwrap()
                .project_id,
            "two"
        );
    }
}
