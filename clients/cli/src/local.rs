use super::*;
use anyhow::{Context, bail};
use fs2::FileExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    process::Stdio,
    time::Duration,
};
use tokio::process::Child;

pub struct Local {
    pub endpoint: String,
    pub token: String,
    pub profile: Option<Value>,
    pub mcp: Vec<(String, Value)>,
    child: Option<Child>,
    temporary: Option<tempfile::TempDir>,
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
                profile: None,
                mcp: vec![],
                child: None,
                temporary: None,
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
                    .join(".areal-harness"),
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
        let ready = temporary.path().join("ready.json");
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
        let mut command = tokio::process::Command::new("/usr/bin/python3");
        command
            .args(["-I", "-S", "-c"])
            .arg(include_str!("../../../scripts/launch.py"))
            .arg("--bin-dir")
            .arg(std::env::current_exe()?.parent().unwrap())
            .arg("--desktop")
            .arg("--parent-pid")
            .arg(std::process::id().to_string())
            .arg("--workspace")
            .arg(&workspace)
            .arg("--data-dir")
            .arg(run_dir.join("state"))
            .arg("--ready-metadata-file")
            .arg(&ready)
            .arg("--desktop-config")
            .arg(&deployment_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .kill_on_drop(false)
            .envs(env);
        if let Some(path) = &args.config {
            command.arg("--config").arg(path);
        }
        for path in &args.task_credential_command {
            command
                .arg("--task-credential-command")
                .arg(path.canonicalize()?);
        }
        for (flag, enabled) in [
            ("--allow-write", args.allow_write),
            ("--allow-network", args.allow_network),
            ("--allow-concurrent-writes", args.allow_concurrent_writes),
            ("--no-deployment-mcp", args.strict_mcp_config),
        ] {
            if enabled {
                command.arg(flag);
            }
        }
        let child = command
            .spawn()
            .context("launch Harness; Python 3.9+ required")?;
        let mut result = Self {
            endpoint: String::new(),
            token: String::new(),
            profile: Some(json!({"id":profile["id"],"revision":profile["revision"]})),
            mcp,
            child: Some(child),
            temporary: Some(temporary),
            mapping: Some(root.join("sessions")),
            run_dir: Some(run_dir),
            _lock: Some(lock),
        };
        let deadline = tokio::time::Instant::now() + Duration::from_secs(40);
        while !ready.exists() {
            if result.child.as_mut().unwrap().try_wait()?.is_some() {
                bail!("Harness startup failed");
            }
            if tokio::time::Instant::now() > deadline {
                result.close().await?;
                bail!("Harness startup timed out");
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let meta: Value = serde_json::from_slice(&std::fs::read(ready)?)?;
        result.endpoint = meta["endpoint"]
            .as_str()
            .context("invalid ready endpoint")?
            .into();
        result.token = token(std::path::Path::new(
            meta["authFile"].as_str().context("invalid authFile")?,
        ))?;
        Ok(result)
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
    pub async fn close(&mut self) -> Result<()> {
        if let Some(child) = &mut self.child
            && child.try_wait()?.is_none()
        {
            if let Some(pid) = child.id() {
                unsafe {
                    libc::kill(pid as i32, libc::SIGTERM);
                }
            }
            let status = tokio::time::timeout(Duration::from_secs(45), child.wait())
                .await
                .context("launcher cleanup unconfirmed")??;
            ensure!(status.success(), "launcher reported cleanup failure");
        }
        self.child = None;
        self.temporary = None;
        Ok(())
    }
}
