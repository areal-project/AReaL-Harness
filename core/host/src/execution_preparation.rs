//! Host 准备目录、配置和工具归属；Core 与原请求回执拥有执行结果。
use super::{Host, library_store, session_commands, worktree_catalog};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::rc::{Rc, Weak};

pub(super) struct PreparedCore {
    host: Weak<Host>,
    project: String,
    method: String,
    scope: (String, String, String),
    browser: Option<(String, (String, String, String))>,
}

fn core_result(response: Value) -> Result<Value> {
    if let Some(error) = response.get("error") {
        return Err(crate::server::schedule_connection::RpcFailure(error.clone()).into());
    }
    response.get("result").cloned().context("INVALID_RESPONSE")
}

fn browser_capability(caps: &Value) -> Result<()> {
    ensure!(
        caps["features"]["browserToolAttachment"] == true
            && caps["browserToolBundles"]
                .as_array()
                .is_some_and(|bundles| bundles
                    .iter()
                    .any(|bundle| bundle["bundleId"] == "areal.browser.v1")),
        "CORE_INCOMPATIBLE"
    );
    Ok(())
}

pub(super) async fn prepare_core(
    host: &Rc<Host>,
    source: &str,
    project: &str,
    method: &str,
    params: &mut Value,
) -> Result<PreparedCore> {
    ensure!(
        [
            "areal/thread/start",
            "areal/turn/start",
            "areal/turn/enqueue",
            "turn/steer"
        ]
        .contains(&method)
            && params.is_object(),
        "INVALID_PARAMS"
    );
    let connections = &host.schedules.connections;
    let scope = connections.shared_identity(host, project)?;
    let browser = match connections
        .frontend_browser_lease(host, source, project)
        .await?
    {
        None => None,
        Some(lease) => {
            let identity = connections.workbench_identity(host, project, &lease)?;
            ensure!(
                identity.0 == scope.0 && identity.1 == scope.1,
                "RESYNC_REQUIRED"
            );
            let caps = core_result(
                connections
                    .workbench_request(
                        host,
                        project,
                        &lease,
                        "areal/capabilities",
                        json!({"apiVersion":"areal.core.v1"}),
                    )
                    .await?,
            )?;
            browser_capability(&caps)?;
            if method == "areal/thread/start" {
                params["dynamicTools"] = json!([areal_protocol::desktop::browser_v1_tool()]);
            } else if method != "turn/steer" {
                let thread = params["threadId"].as_str().context("INVALID_PARAMS")?;
                let observed = core_result(
                    connections
                        .workbench_request(
                            host,
                            project,
                            &lease,
                            "thread/read",
                            json!({"threadId":thread,"includeTurns":false}),
                        )
                        .await?,
                )?;
                let state = &observed["thread"];
                if state["status"]["type"] == "idle"
                    && state["desktop"]["archived"] != true
                    && state["parentThreadId"].is_null()
                    && state["conversation"]["policy"]["kind"] != "sideReadOnlyV1"
                {
                    let attached = super::workbench_submissions::submit(host,project,&lease,"areal/thread/tools/attach",json!({"requestId":uuid::Uuid::new_v4().to_string(),"threadId":thread,"expectedToolsetRevision":state["toolsetRevision"].as_u64().unwrap_or(0),"bundleId":"areal.browser.v1"}),false,true).await?;
                    core_result(attached)?;
                }
            }
            Some((lease, identity))
        }
    };
    if params["model"]["providerId"] == "areal_openai" {
        host.ensure_subscription_for_project(source, project)
            .await?;
    }
    ensure!(
        connections.shared_identity(host, project)? == scope,
        "RESYNC_REQUIRED"
    );
    Ok(PreparedCore {
        host: Rc::downgrade(host),
        project: project.into(),
        method: method.into(),
        scope,
        browser,
    })
}

impl PreparedCore {
    pub(super) async fn dispatch(&self, source: &str, params: &Value) -> Result<Value> {
        let host = self.host.upgrade().context("CAPABILITY_UNAVAILABLE")?;
        host.admission()?;
        ensure!(
            host.gateway.workbench.active_source().as_deref() == Some(source),
            "RESYNC_REQUIRED"
        );
        let connections = &host.schedules.connections;
        ensure!(
            connections.shared_identity(&host, &self.project)? == self.scope,
            "RESYNC_REQUIRED"
        );
        if let Some((lease, identity)) = &self.browser {
            ensure!(
                connections.frontend_owns(lease)
                    && connections.workbench_identity(&host, &self.project, lease)? == *identity,
                "CAPABILITY_UNAVAILABLE"
            );
            core_result(
                connections
                    .workbench_request(&host, &self.project, lease, &self.method, params.clone())
                    .await?,
            )
        } else {
            connections
                .remote_request(
                    &host,
                    &self.project,
                    (&self.scope.0, &self.scope.1, &self.scope.2),
                    &self.method,
                    params.clone(),
                )
                .await
        }
    }
}

pub(super) struct PreparedCreation {
    host: Weak<Host>,
    logical: String,
    project: String,
    scope: (String, String, String),
    browser_lease: Option<(String, (String, String, String))>,
    core_params: Value,
}

pub(super) async fn prepare(
    host: &Rc<Host>,
    source: &str,
    logical: &str,
    input: &Value,
) -> Result<PreparedCreation> {
    let object = input.as_object().context("INVALID_PARAMS")?;
    ensure!(
        object.keys().all(|key| [
            "projectId",
            "requestId",
            "worktree",
            "options",
            "parameters",
            "profile",
            "model",
            "browserEnabled"
        ]
        .contains(&key.as_str())),
        "INVALID_PARAMS"
    );
    let id = input["requestId"].as_str().context("INVALID_PARAMS")?;
    uuid::Uuid::parse_str(id).context("INVALID_PARAMS")?;
    ensure!(
        input.get("browserEnabled").is_none_or(Value::is_boolean),
        "INVALID_PARAMS"
    );
    let mut options = json!({"permissionPreset":"ask"});
    if let Some(requested) = input.get("options") {
        options
            .as_object_mut()
            .unwrap()
            .extend(requested.as_object().context("INVALID_PARAMS")?.clone());
    }
    // 先验证客户端配置，非法配置不能先产生工作树或创建记录。
    let mut params: areal_protocol::desktop::ThreadStart = serde_json::from_value(json!({
        "requestId":id,"options":options,"model":input.get("model"),
        "parameters":input.get("parameters").cloned().unwrap_or(json!({})),"agentProfile":input.get("profile")
    })).context("INVALID_PARAMS")?;
    let target =
        worktree_catalog::prepare_thread_target(host, source, logical, input.clone()).await?;
    let project = target["projectId"]
        .as_str()
        .context("INVALID_RESPONSE")?
        .to_owned();
    let root = target["root"]
        .as_str()
        .context("INVALID_RESPONSE")?
        .to_owned();
    let connections = &host.schedules.connections;
    let scope = connections.shared_identity(host, &project)?;
    let caps = session_commands::core_capabilities(host, &project).await?;
    ensure!(
        session_commands::has_method(&caps, "areal/thread/start")
            && session_commands::has_method(&caps, "areal/request/read"),
        "CORE_INCOMPATIBLE"
    );
    params.cwd = Some(root);
    params.creation_admission = Some(
        serde_json::from_value(caps["features"]["threadCreationJournal"]["binding"].clone())
            .context("CORE_INCOMPATIBLE")?,
    );
    if input.get("profile").is_none() {
        params.agent_profile = target
            .get("resourceProfile")
            .filter(|value| !value.is_null())
            .cloned()
            .map(serde_json::from_value)
            .transpose()?;
    }
    if params
        .model
        .as_ref()
        .is_some_and(|model| model.provider_id == "areal_openai")
    {
        host.ensure_subscription_for_project(source, &project)
            .await?;
    }
    let browser_lease = if input["browserEnabled"] == true {
        browser_capability(&caps)?;
        let lease = connections
            .frontend_browser_lease(host, source, &project)
            .await?
            .context("CAPABILITY_UNAVAILABLE")?;
        params.dynamic_tools = vec![areal_protocol::desktop::browser_v1_tool()];
        let identity = connections.workbench_identity(host, &project, &lease)?;
        ensure!(
            identity.0 == scope.0 && identity.1 == scope.1,
            "RESYNC_REQUIRED"
        );
        Some((lease, identity))
    } else {
        None
    };
    ensure!(
        connections.shared_identity(host, &project)? == scope,
        "RESYNC_REQUIRED"
    );
    Ok(PreparedCreation {
        host: Rc::downgrade(host),
        logical: logical.into(),
        project,
        scope,
        browser_lease,
        core_params: serde_json::to_value(params)?,
    })
}

impl PreparedCreation {
    pub(super) async fn dispatch(&self, source: &str, input: &Value) -> Result<Value> {
        let host = self.host.upgrade().context("CAPABILITY_UNAVAILABLE")?;
        host.admission()?;
        ensure!(
            host.gateway.workbench.active_source().as_deref() == Some(source),
            "RESYNC_REQUIRED"
        );
        ensure!(
            host.schedules
                .connections
                .shared_identity(&host, &self.project)?
                == self.scope,
            "RESYNC_REQUIRED"
        );
        if let Some((lease, identity)) = &self.browser_lease {
            ensure!(
                host.schedules.connections.frontend_owns(lease),
                "CAPABILITY_UNAVAILABLE"
            );
            ensure!(
                host.schedules
                    .connections
                    .workbench_identity(&host, &self.project, lease)?
                    == *identity,
                "RESYNC_REQUIRED"
            );
        }
        let id = input["requestId"].as_str().context("INVALID_PARAMS")?;
        worktree_catalog::bind_thread_target_with_lease(
            &host,
            source,
            &self.logical,
            id,
            self.core_params.clone(),
            self.browser_lease.as_ref().map(|(lease, _)| lease.as_str()),
        )
        .await?;
        let result =
            worktree_catalog::read_thread_target(&host, source, &self.logical, input.clone())
                .await?;
        if let Some(thread) = result["threadId"].as_str() {
            let alias = result["executionProjectId"]
                .as_str()
                .context("INVALID_RESPONSE")?;
            session_commands::record_thread_owner(
                &library_store::source_home(&host, source)?,
                alias,
                thread,
            );
        }
        Ok(result)
    }
}
