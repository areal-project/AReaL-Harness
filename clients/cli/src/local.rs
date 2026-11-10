use super::*;
use anyhow::Context;
use fs2::FileExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
};

pub struct Local {
    pub endpoint: String,
    pub token: String,
    pub profile: Option<Value>,
    pub mcp: Vec<(String, Value)>,
    mapping: Option<PathBuf>,
    run_dir: Option<PathBuf>,
    _lock: Option<File>,
}
fn protected(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    Ok(())
}
fn token(path: &std::path::Path) -> Result<String> {
    use std::os::unix::fs::PermissionsExt;
    ensure!(
        std::fs::metadata(path)?.permissions().mode() & 0o077 == 0,
        "auth file must have mode 600"
    );
    let v: Value = serde_json::from_str(&read_text(path)?)?;
    Ok(v["principals"][0]["token"]
        .as_str()
        .context("missing launcher identity")?
        .into())
}
impl Local {
    pub async fn start(args: &Cli) -> Result<Self> {
        if let Some(endpoint) = &args.endpoint {
            ensure!(
                args.mcp_config.is_empty() && !args.strict_mcp_config,
                "run-scoped MCP requires an owned Core instance"
            );
            return Ok(Self {
                endpoint: endpoint.clone(),
                token: token(
                    args.auth_file
                        .as_deref()
                        .context("--endpoint requires --auth-file")?,
                )?,
                profile: args
                    .agent
                    .as_deref()
                    .map(areal_local_service::parse_agent_profile)
                    .transpose()?
                    .map(|profile| json!(profile)),
                mcp: vec![],
                mapping: None,
                run_dir: None,
                _lock: None,
            });
        }
        let workspace = args
            .workspace
            .clone()
            .unwrap_or(std::env::current_dir()?)
            .canonicalize()?;
        let root = std::env::var_os("AREAL_HARNESS_HOME")
            .map(PathBuf::from)
            .unwrap_or(
                std::env::home_dir()
                    .context("home unavailable")?
                    .join(".areal"),
            )
            .join("cli");
        ensure!(
            !root.starts_with(&workspace),
            "CLI state must be outside the workspace"
        );
        std::fs::create_dir_all(root.join("sessions"))?;
        std::fs::create_dir_all(root.join("runs"))?;
        let resume_path = if let Some(id) = &args.resume {
            ensure!(uuid::Uuid::parse_str(id).is_ok(), "invalid session ID");
            Some(root.join("sessions").join(format!("{id}.json")))
        } else {
            None
        };
        let run_id = if let Some(path) = &resume_path {
            let m: Value = serde_json::from_slice(
                &std::fs::read(path)
                    .context("session mapping not found; no replacement session was created")?,
            )?;
            ensure!(
                m["workspace"] == workspace.to_string_lossy().as_ref(),
                "session belongs to another workspace"
            );
            let id = m["runId"].as_str().context("invalid session mapping")?;
            uuid::Uuid::parse_str(id)?;
            id.to_owned()
        } else {
            key()
        };
        let run_dir = root.join("runs").join(&run_id);
        std::fs::create_dir_all(&run_dir)?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(run_dir.join("client.lock"))?;
        lock.try_lock_exclusive()
            .context("session already has an active CLI owner")?;
        let temporary = tempfile::Builder::new()
            .prefix("launch-")
            .tempdir_in(&run_dir)?;
        let mut deployment = if let Some(path) = &args.desktop_config {
            let mut d: Value = serde_json::from_str(&read_text(path)?)?;
            if let Some(skills) = d.get_mut("skills").and_then(Value::as_array_mut) {
                for skill in skills {
                    let r = skill["root"].as_str().context("invalid skill root")?;
                    skill["root"] = json!(path.canonicalize()?.parent().unwrap().join(r));
                }
            }
            d
        } else {
            json!({"profiles":[],"skills":[]})
        };
        let object = deployment
            .as_object_mut()
            .context("deployment must be an object")?;
        for field in ["profiles", "skills"] {
            object.entry(field).or_insert_with(|| json!([]));
        }
        let discovered =
            areal_config::skills::discover(Some(&workspace), std::env::home_dir().as_deref())?;
        for warning in &discovered.warnings {
            eprintln!("Warning: {warning}");
        }
        let skill_refs: Vec<_> = discovered
            .skills
            .iter()
            .map(|s| json!({"id":s.id,"revision":s.revision}))
            .collect();
        deployment["skills"]
            .as_array_mut()
            .context("deployment skills must be an array")?
            .extend(discovered.skills.iter().map(|s| json!(s)));
        let instructions = if workspace.join("CLAUDE.md").exists() {
            let path = workspace.join("CLAUDE.md").canonicalize()?;
            ensure!(path.starts_with(&workspace), "CLAUDE.md escaped workspace");
            format!(
                "Project instructions from CLAUDE.md (subject to user instructions and deployment permissions):\n{}",
                read_text(&path)?
            )
        } else {
            String::new()
        };
        let profile = json!({"id":"claude-cli","revision":format!("{:x}",Sha256::digest(format!("{instructions}{skill_refs:?}").as_bytes())),"displayName":"Claude CLI client","instructions":instructions,"skills":skill_refs,"readOnly":args.permission_mode=="plan"});
        deployment["profiles"]
            .as_array_mut()
            .context("deployment profiles must be an array")?
            .push(profile.clone());
        let deployment_path = temporary.path().join("deployment.json");
        protected(&deployment_path, &serde_json::to_vec(&deployment)?)?;
        let mut env = BTreeMap::<String, String>::new();
        let mut mcp = Vec::new();
        for source in &args.mcp_config {
            let raw = if source.starts_with('{') {
                source.clone()
            } else {
                read_text(std::path::Path::new(source))?
            };
            ensure!(raw.len() <= 65536, "MCP config exceeds 64 KiB");
            let value: Value = serde_json::from_str(&raw)?;
            ensure!(
                value
                    .as_object()
                    .is_some_and(|o| o.keys().all(|k| k == "mcpServers")),
                "unsupported MCP config fields"
            );
            for (id, c) in value["mcpServers"]
                .as_object()
                .context("MCP config requires mcpServers")?
            {
                ensure!(
                    !mcp.iter().any(|(name, _)| name == id),
                    "duplicate MCP server"
                );
                let fields = c.as_object().context("MCP server must be an object")?;
                let stdio = c.get("command").is_some();
                let allowed = if stdio {
                    &["type", "command", "args", "env"][..]
                } else {
                    &["type", "url", "headers"][..]
                };
                ensure!(
                    fields.keys().all(|k| allowed.contains(&k.as_str())),
                    "unsupported MCP server fields"
                );
                if let Some(kind) = c.get("type") {
                    ensure!(
                        kind == if stdio { "stdio" } else { "http" },
                        "unsupported MCP transport type"
                    );
                }
                let transport = if let Some(command) = c["command"].as_str() {
                    let mut names = Vec::new();
                    if let Some(values) = c.get("env") {
                        for (name, value) in values.as_object().context("MCP env must be object")? {
                            ensure!(
                                !name.starts_with("MULTICA_")
                                    && !["TMPDIR", "TMP", "TEMP"].contains(&name.as_str()),
                                "MCP config cannot override task identity or temporary directories"
                            );
                            let value = value
                                .as_str()
                                .context("MCP env value must be string")?
                                .to_owned();
                            if let Some(old) = env.insert(name.clone(), value.clone()) {
                                ensure!(old == value, "conflicting run-scoped MCP environment");
                            }
                            names.push(name.clone());
                        }
                    }
                    json!({"type":"stdio","command":command,"args":c.get("args").cloned().unwrap_or(json!([])),"cwd":workspace,"envVars":names})
                } else {
                    let mut bearer = None;
                    if let Some(headers) = c.get("headers") {
                        let headers = headers.as_object().context("MCP headers must be object")?;
                        ensure!(
                            headers.len() == 1 && headers.contains_key("Authorization"),
                            "only explicit Bearer MCP authorization supported"
                        );
                        let secret = headers["Authorization"]
                            .as_str()
                            .and_then(|s| s.strip_prefix("Bearer "))
                            .context("MCP Authorization must be Bearer")?;
                        let name = format!("AREAL_CLI_MCP_{}", mcp.len());
                        env.insert(name.clone(), secret.into());
                        bearer = Some(name);
                    }
                    json!({"type":"streamableHttp","url":c["url"],"bearerTokenEnv":bearer})
                };
                mcp.push((id.clone(), json!({"transport":transport})));
            }
        }
        let options = areal_local_service::LocalArgs {
            workspace: Some(workspace),
            data_dir: Some(run_dir.join("state")),
            desktop_config: Some(deployment_path),
            permissions: args.permissions.clone(),
            scratch: args.scratch.clone(),
            config: args.config.clone(),
            workgroup_policy: args.workgroup_policy.clone(),
            workgroup_toolchain: args.workgroup_toolchain.clone(),
            read_only_path: args.read_only_path.clone(),
            task_credential_command: args.task_credential_command.clone(),
            allow_write: args.allow_write,
            allow_network: args.allow_network,
            allow_concurrent_writes: args.allow_concurrent_writes,
            no_deployment_mcp: args.strict_mcp_config,
            ..Default::default()
        };
        let resolve = || -> Result<areal_host::ResolveProject> {
            let mut input = areal_host::ResolveProject::from_local_args(&options)?;
            for (name, value) in &env {
                if let Some(old) = input.credentials.insert(name.clone(), value.clone()) {
                    ensure!(&old == value, "conflicting model and MCP environment");
                }
                if !input.launch_inputs.credential_names.contains(name) {
                    input.launch_inputs.credential_names.push(name.clone());
                }
            }
            Ok(input)
        };
        // 启动参数先校验，无效时不拉起 Host。
        let input = resolve()?;
        let client = areal_host::Client::connect_or_start().await?;
        let opened = match client.open(input).await {
            // 续接时本进程独占这个会话（client.lock）；权限等启动参数变了，由它显式重启空闲的会话服务。
            Err(error)
                if args.resume.is_some()
                    && format!("{error:#}")
                        .contains(areal_local_service::CONFIGURATION_CONFLICT) =>
            {
                client
                    .restart(resolve()?, areal_host::StopStrategy::IfIdle)
                    .await?
            }
            opened => opened?,
        };
        let service = opened.service()?;
        let profile = args
            .agent
            .as_deref()
            .map(areal_local_service::parse_agent_profile)
            .transpose()?
            .map(|profile| json!(profile))
            .or_else(|| Some(json!({"id":profile["id"],"revision":profile["revision"]})));
        drop(temporary);
        Ok(Self {
            endpoint: service.endpoint.clone(),
            token: token(&service.auth_file)?,
            profile,
            mcp,
            mapping: Some(root.join("sessions")),
            run_dir: Some(run_dir),
            _lock: Some(lock),
        })
    }
    pub fn record(&self, session: &str, workspace: &str) -> Result<()> {
        if let (Some(root), Some(run)) = (&self.mapping, &self.run_dir) {
            let path = root.join(format!("{session}.json"));
            if !path.exists() {
                protected(
                    &path,
                    &serde_json::to_vec(
                        &json!({"version":1,"runId":run.file_name().unwrap().to_string_lossy(),"workspace":workspace}),
                    )?,
                )?;
            }
        }
        Ok(())
    }
}
