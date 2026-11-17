//! 资源设置沿来源与项目登记选路径；Host 串行写入，Core 继续拥有执行与生效代际。
use super::{
    Host, gui_project, library_store, schedule_connection, workbench_route, workbench_utility,
    worktree_catalog,
};
use crate::{
    builtin_skills,
    schedule_resources::{self, ResourceState},
};
use anyhow::{Context, Result, ensure};
use areal_local_service::storage;
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    rc::Rc,
};
use tokio::sync::Mutex;

#[derive(Default)]
pub(super) struct Resources {
    gate: Mutex<()>,
}
fn text<'a>(request: &'a Value, key: &str) -> Result<&'a str> {
    request[key].as_str().context("INVALID_PARAMS")
}
fn private_tree(home: &Path, path: &Path) -> Result<()> {
    let relative = path.strip_prefix(home)?;
    let mut current = home.to_owned();
    for part in relative.components() {
        ensure!(
            matches!(part, std::path::Component::Normal(_)),
            "INVALID_PARAMS"
        );
        current.push(part);
        match fs::create_dir(&current) {
            Ok(()) => fs::set_permissions(&current, fs::Permissions::from_mode(0o700))?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        ensure!(
            current.symlink_metadata()?.is_dir(),
            "resource directory must not be a link"
        );
    }
    Ok(())
}
fn state(home: &Path) -> Result<(Value, ResourceState)> {
    let value = match fs::read(home.join("resources.json")) {
        Ok(bytes) => {
            ensure!(bytes.len() <= 1024 * 1024, "LIMIT_EXCEEDED");
            serde_json::from_slice(&bytes)?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            json!({"revision":0,"skills":{}})
        }
        Err(error) => return Err(error.into()),
    };
    let parsed: ResourceState = serde_json::from_value(value.clone())?;
    ensure!(
        parsed.revision <= 9_007_199_254_740_991,
        "invalid resource revision"
    );
    Ok((value, parsed))
}
struct Scope {
    base: PathBuf,
    managed: PathBuf,
    name: String,
    project: bool,
}
fn resolve_scope(
    host: &Host,
    source: &str,
    home: &Path,
    options: &Value,
    request: &Value,
) -> Result<Scope> {
    let project = request["scope"] == "project";
    ensure!(project || request["scope"] == "user", "INVALID_PARAMS");
    let (base, name) = if project {
        let registration = worktree_catalog::project(host, source, text(request, "projectId")?)?;
        let alias = workbench_route::backend_project_alias(host, source, &registration.project_id)?;
        (registration.workspace, alias)
    } else {
        (
            workbench_utility::inputs(options)?
                .homedir
                .context("user home missing")?,
            "user".into(),
        )
    };
    Ok(Scope {
        base,
        managed: home.join("resources").join(&name).join("skills"),
        name,
        project,
    })
}
impl Resources {
    pub(super) async fn prepare_creator(
        &self,
        host: &Rc<Host>,
        source: &str,
        request: &Value,
    ) -> Result<Value> {
        ensure!(
            request
                .as_object()
                .is_some_and(|object| object
                    .keys()
                    .all(|key| ["projectId", "profile"].contains(&key.as_str()))),
            "INVALID_PARAMS"
        );
        let alias = text(request, "projectId")?;
        let home = library_store::source_home(host, source)?;
        ensure!(
            worktree_catalog::saved_projects(&home)?
                .iter()
                .any(|row| row["id"] == alias && row["projectless"] != true),
            "请先选择要创建 Skill 的项目"
        );
        let registration = worktree_catalog::project(host, source, alias)?;
        super::session_commands::ensure_project(host, &registration.project_id).await?;
        host.schedules
            .connections
            .refresh_gui(host, &registration.project_id)
            .await?;
        let inputs = schedule_connection::inputs(host, &registration.project_id)?;
        let current = crate::launch::remote_profile(&inputs)?
            .map(serde_json::to_value)
            .transpose()?;
        let profile = match request.get("profile") {
            Some(profile) => {
                let _: areal_protocol::desktop::VersionRef =
                    serde_json::from_value(profile.clone()).context("INVALID_PARAMS")?;
                match &inputs.schedule_preparation {
                    Some(crate::SchedulePreparation::Managed {
                        default_profile, ..
                    }) if profile == default_profile => current,
                    _ => Some(profile.clone()),
                }
            }
            None => current,
        }
        .context("当前部署未配置默认任务配置，现有草稿已保留")?;
        let descriptor = builtin_skills::descriptor(&home)?;
        let scope = host
            .schedules
            .connections
            .shared_identity(host, &registration.project_id)?;
        let skills = host
            .schedules
            .connections
            .remote_request(
                host,
                &registration.project_id,
                (&scope.0, &scope.1, &scope.2),
                "areal/skill/list",
                json!({"agentProfile":profile}),
            )
            .await?;
        ensure!(
            host.schedules
                .connections
                .shared_identity(host, &registration.project_id)?
                == scope,
            "RESYNC_REQUIRED"
        );
        ensure!(
            skills["data"].as_array().is_some_and(|rows| rows
                .iter()
                .any(|row| row["available"] == true
                    && row["id"] == descriptor["skill"]["id"]
                    && row["revision"] == descriptor["skill"]["revision"])),
            "当前任务配置未提供官方 Skill Creator 的确切版本，现有草稿已保留"
        );
        Ok(
            json!({"projectId":alias,"profile":profile,"skill":descriptor["skill"],"provenance":descriptor["provenance"]}),
        )
    }

    pub(super) async fn command(
        &self,
        host: &Rc<Host>,
        source: &str,
        request: &Value,
    ) -> Result<Value> {
        let _: areal_protocol::host::LocalDesktopResourceParams =
            serde_json::from_value(request.clone()).context("INVALID_PARAMS")?;
        let _guard = self.gate.lock().await;
        host.admission()?;
        let home = library_store::source_home(host, source)?;
        let options = gui_project::options(host, source)?;
        let operation = text(request, "operation")?;
        if operation == "builtinSkill" {
            ensure!(request["id"] == builtin_skills::ID, "INVALID_PARAMS");
            return builtin_skills::descriptor(&home);
        }
        if matches!(operation, "hooks" | "hooksSave") {
            return hooks(host, source, &home, &options, request);
        }
        let scope = resolve_scope(host, source, &home, &options, request)?;
        let (mut value, state) = state(&home)?;
        let rows = schedule_resources::scan_rows(
            &scope.base,
            &scope.managed,
            &scope.name,
            scope.project,
            &state,
        )?;
        if operation == "skills" {
            let overrides = if !scope.project && request.get("projectId").is_some() {
                let mut local = request.clone();
                local["scope"] = json!("project");
                let scope = resolve_scope(host, source, &home, &options, &local)?;
                schedule_resources::scan_rows(
                    &scope.base,
                    &scope.managed,
                    &scope.name,
                    true,
                    &state,
                )?
            } else {
                Default::default()
            };
            let data: Vec<_> = rows
                .into_iter()
                .map(|(id, mut row)| {
                    row["overridden"] = json!(overrides.contains_key(&id));
                    row
                })
                .collect();
            return Ok(
                json!({"revision":state.revision,"data":data,"customDeployment":!gui_project::managed(host,&options)?}),
            );
        }
        let id = text(request, "id")?;
        if operation == "skillRead" {
            let row = rows
                .get(id)
                .filter(|row| row.get("error").is_none())
                .context("skill unreadable")?;
            let content = schedule_resources::bounded(
                &PathBuf::from(row["root"].as_str().context("skill unreadable")?).join("SKILL.md"),
                256 * 1024,
            )?;
            let truncated = content.len() > 256 * 1024;
            let mut end = content.len().min(256 * 1024);
            while !content.is_char_boundary(end) {
                end -= 1;
            }
            return Ok(json!({"content":&content[..end],"truncated":truncated}));
        }
        ensure!(
            request["expectedRevision"].as_u64() == Some(state.revision),
            "配置已变化，请刷新后重试"
        );
        ensure!(
            state.revision < 9_007_199_254_740_991,
            "resource revision exhausted"
        );
        match operation {
            "skillToggle" => {
                ensure!(
                    rows.get(id).is_some_and(|row| row.get("error").is_none()),
                    "skill unavailable"
                );
                let enabled = request["enabled"].as_bool().context("INVALID_PARAMS")?;
                if value["skills"].get(&scope.name).is_none() {
                    value["skills"][&scope.name] = json!({});
                }
                value["skills"][&scope.name][id] = json!(enabled);
            }
            "skillSave" => {
                ensure!(
                    id != builtin_skills::ID && schedule_resources::valid_id(id),
                    "invalid skill id"
                );
                ensure!(!rows.contains_key(id), "skill already exists");
                let content = text(request, "content")?;
                ensure!(
                    !content.trim().is_empty() && content.len() <= 128 * 1024,
                    "invalid skill content"
                );
                for key in ["name", "description"] {
                    ensure!(
                        request
                            .get(key)
                            .is_none_or(|v| v.is_null() || v.is_string()),
                        "INVALID_PARAMS"
                    );
                }
                let header = serde_yaml_ng::to_string(
                    &json!({"name":request.get("name"),"description":request.get("description")}),
                )?;
                let metadata = schedule_resources::metadata(&format!("---\n{header}---\n"), id)?;
                let header = serde_yaml_ng::to_string(
                    &json!({"name":metadata.name,"description":metadata.description}),
                )?;
                private_tree(&home, &scope.managed)?;
                let directory = scope.managed.join(id);
                fs::create_dir(&directory)?;
                fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
                let mut file = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(directory.join("SKILL.md"))?;
                file.write_all(format!("---\n{header}---\n{}\n", content.trim()).as_bytes())?;
                file.sync_all()?;
            }
            _ => anyhow::bail!("INVALID_PARAMS"),
        }
        value["revision"] = json!(state.revision + 1);
        storage::write(&home.join("resources.json"), &value)?;
        Ok(json!({"revision":state.revision+1,"warning":null}))
    }
}
struct Hooks {
    path: PathBuf,
    external: bool,
    revision: String,
    value: Value,
    mode: u32,
}
fn current(home: &Path, options: &Value) -> Result<Hooks> {
    let config = areal_config::load_service_config(&workbench_utility::inputs(options)?)?.0;
    let external = config.tool_extensions_file.is_some();
    let path = config
        .tool_extensions_file
        .unwrap_or_else(|| home.join("tool-extensions.json"));
    let (raw, missing, mode) = match fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&path)
    {
        Ok(mut file) => {
            use std::io::Read;
            let meta = file.metadata()?;
            ensure!(
                meta.is_file() && meta.len() <= 1024 * 1024,
                "invalid hook file"
            );
            let mut bytes = Vec::new();
            std::io::Read::by_ref(&mut file)
                .take(1024 * 1024 + 1)
                .read_to_end(&mut bytes)?;
            ensure!(bytes.len() <= 1024 * 1024, "LIMIT_EXCEEDED");
            (
                String::from_utf8(bytes)?,
                false,
                meta.permissions().mode() & 0o777,
            )
        }
        Err(error) if !external && error.kind() == std::io::ErrorKind::NotFound => {
            ("{}".into(), true, 0o600)
        }
        Err(error) => return Err(error.into()),
    };
    let extensions: areal_engine::tools::ToolExtensions = serde_json::from_str(&raw)?;
    extensions.validate()?;
    let value: Value = serde_json::from_str(&raw)?;
    ensure!(value.is_object(), "invalid extensions document");
    let revision = storage::digest(&serde_json::to_vec(&json!([path, raw, missing]))?);
    Ok(Hooks {
        path,
        external,
        revision,
        value,
        mode,
    })
}
fn public(host: &Host, source: &str, home: &Path, current: Hooks) -> Result<Value> {
    let projects = worktree_catalog::saved_projects(home)?
        .into_iter()
        .map(|row| {
            let registration = worktree_catalog::project(
                host, source, row["id"].as_str().context("invalid project")?,
            )?;
            let connected = host.schedules.connections
                .shared_identity(host, &registration.project_id).is_ok();
            let applied = connected && schedule_connection::inputs(host, &registration.project_id)
                .ok()
                .and_then(|input| input.environment.get("AREAL_HARNESS_TOOL_EXTENSIONS").cloned())
                .and_then(|path| fs::read(path).ok())
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .is_some_and(|value| value == current.value);
            Ok(json!({"projectId":row["id"],"root":row["root"],"connected":connected,"applied":applied}))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(
        json!({"path":current.path,"external":current.external,"revision":current.revision,"hooks":current.value.get("hooks").cloned().unwrap_or(json!([])),"projects":projects}),
    )
}
fn hooks(
    host: &Host,
    source: &str,
    home: &Path,
    options: &Value,
    request: &Value,
) -> Result<Value> {
    let old = current(home, options)?;
    if request["operation"] == "hooks" {
        return public(host, source, home, old);
    }
    ensure!(
        request["expectedRevision"] == old.revision,
        "钩子配置已变化，请刷新后重新保存"
    );
    let hooks = request["hooks"].as_array().context("INVALID_PARAMS")?;
    ensure!(hooks.len() <= 64, "too many hooks");
    let mut value = old.value.clone();
    value["hooks"] = json!(hooks);
    let bytes = serde_json::to_vec_pretty(&value)?;
    ensure!(bytes.len() <= 1024 * 1024, "LIMIT_EXCEEDED");
    let extensions: areal_engine::tools::ToolExtensions = serde_json::from_slice(&bytes)?;
    extensions.validate()?;
    let temporary = old
        .path
        .parent()
        .context("invalid hooks path")?
        .join(format!(".areal-hooks-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(old.mode)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        ensure!(
            current(home, options)?.revision == old.revision,
            "hooks changed externally"
        );
        fs::rename(&temporary, &old.path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result?;
    public(host, source, home, current(home, options)?)
}
