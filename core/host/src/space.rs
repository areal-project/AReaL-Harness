//! 用户显式创建的隔离空间；不导入旧 Store、任务或凭据，不控制旧 Host。
mod catalog;
pub(crate) mod history;
use anyhow::{Context, Result, ensure};
use areal_local_service::storage;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpaceSource {
    pub profile: PathBuf,
    pub core_home: PathBuf,
    pub host_home: PathBuf,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    version: u32,
    space_id: String,
    source: SpaceSource,
    profile: PathBuf,
    host_home: PathBuf,
    core_home: PathBuf,
    config_home: PathBuf,
    workspace: PathBuf,
    protected_workspaces: Vec<PathBuf>,
}
struct Roots {
    long: PathBuf,
    short: PathBuf,
}
fn directory(path: &Path) -> Result<()> {
    let m = fs::symlink_metadata(path)?;
    ensure!(
        m.is_dir()
            && m.uid() == unsafe { libc::geteuid() }
            && m.mode() & 0o022 == 0
            && path.canonicalize()? == path,
        "space directory identity is unavailable"
    );
    Ok(())
}
fn roots() -> Result<Roots> {
    if let Some(root) = std::env::var_os("AREAL_SPACES_TEST_ROOT") {
        let root = PathBuf::from(root);
        directory(&root)?;
        let marker: Value = storage::read(&root.join(".areal-test-space-root.json"))?;
        ensure!(
            marker == json!({"version":1,"testOnly":true}),
            "invalid isolated space test root"
        );
        return Ok(Roots {
            long: root.join("spaces"),
            short: root.join("hosts"),
        });
    }
    let home = std::env::home_dir().context("home unavailable")?;
    #[cfg(target_os = "macos")]
    let long = home.join("Library/Application Support/AReaL Harness Spaces");
    #[cfg(not(target_os = "macos"))]
    let long = home.join(".local/share/areal-spaces");
    Ok(Roots {
        long,
        short: home.join(".areal/spaces"),
    })
}
fn id(value: &str) -> Result<String> {
    let parsed = uuid::Uuid::parse_str(value)?;
    ensure!(
        parsed.to_string() == value,
        "spaceId must be a canonical UUID"
    );
    Ok(parsed.simple().to_string()[..16].to_string())
}
fn paths(roots: &Roots, space_id: &str, source: SpaceSource) -> Result<Manifest> {
    let short = id(space_id)?;
    let long = roots.long.join(space_id);
    let host = roots.short.join(short);
    ensure!(
        host.join("host/control.sock")
            .as_os_str()
            .as_encoded_bytes()
            .len()
            < 100,
        "Host socket path exceeds the safe platform limit"
    );
    Ok(Manifest {
        version: 1,
        space_id: space_id.into(),
        source,
        profile: long.join("profile"),
        core_home: host.join("core"),
        config_home: host.clone(),
        workspace: long.join("workspace"),
        host_home: host,
        protected_workspaces: Vec::new(),
    })
}
fn manifest_path(roots: &Roots, space_id: &str) -> Result<PathBuf> {
    id(space_id)?;
    Ok(roots.long.join(space_id).join("manifest.json"))
}
fn digest(manifest: &Manifest) -> Result<String> {
    Ok(storage::digest(&serde_json::to_vec(manifest)?))
}
fn summary(manifest: &Manifest) -> Result<Value> {
    Ok(json!({"spaceId":manifest.space_id,"state":"prepared","manifestDigest":digest(manifest)?}))
}
fn full(manifest: &Manifest) -> Result<Value> {
    let mut result = serde_json::to_value(manifest)?;
    result["state"] = json!("prepared");
    result["manifestDigest"] = json!(digest(manifest)?);
    Ok(result)
}
fn private_new(path: &Path, value: &impl Serialize) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    file.write_all(&serde_json::to_vec(value)?)?;
    file.sync_all()?;
    fs::File::open(path.parent().context("parent missing")?)?.sync_all()?;
    Ok(())
}
fn owned_root(path: &Path, manifest: &Manifest) -> Result<()> {
    match fs::create_dir(path) {
        Ok(()) => {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
            private_new(&path.join("space-owner.json"), manifest)?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            directory(path)?;
            let previous: Manifest = storage::read(&path.join("space-owner.json"))
                .context("space preparation outcome unknown; retain the original spaceId")?;
            ensure!(&previous == manifest, "space identity collision");
        }
        Err(e) => return Err(e.into()),
    }
    Ok(())
}
fn validate_source(source: &SpaceSource) -> Result<()> {
    for path in [&source.profile, &source.core_home, &source.host_home] {
        directory(path)?;
    }
    Ok(())
}
fn read_manifest(roots: &Roots, space_id: &str) -> Result<Manifest> {
    let manifest: Manifest = storage::read(&manifest_path(roots, space_id)?)?;
    let mut expected = paths(roots, space_id, manifest.source.clone())?;
    expected.protected_workspaces = manifest.protected_workspaces.clone();
    ensure!(manifest == expected, "space manifest identity mismatch");
    for path in [
        &manifest.profile,
        &manifest.host_home,
        &manifest.core_home,
        &manifest.config_home,
        &manifest.workspace,
    ] {
        directory(path)?;
        ensure!(
            fs::metadata(path)?.mode() & 0o077 == 0,
            "space directory must be private"
        );
    }
    for root in [roots.long.join(space_id), manifest.host_home.clone()] {
        let owner: Manifest = storage::read(&root.join("space-owner.json"))?;
        ensure!(owner == manifest, "space owner mismatch");
    }
    Ok(manifest)
}
fn prepare(roots: &Roots, space_id: &str, source: SpaceSource) -> Result<Value> {
    if manifest_path(roots, space_id)?.exists() {
        let previous = read_manifest(roots, space_id)?;
        ensure!(
            previous.source == source,
            "requestConflict: spaceId already binds another source"
        );
        return summary(&previous);
    }
    validate_source(&source)?;
    let mut manifest = paths(roots, space_id, source)?;
    let owner_path = roots.long.join(space_id).join("space-owner.json");
    if let Some(previous) = storage::read_optional::<Manifest>(&owner_path)? {
        // 发布清单前中断也沿用首次冻结的目录，不能因旧后台变化改绑同一事务。
        manifest.protected_workspaces = previous.protected_workspaces.clone();
        ensure!(
            previous == manifest,
            "requestConflict: spaceId already binds another source"
        );
    } else {
        manifest.protected_workspaces = source_workspaces(&manifest.source)?;
    }
    for target in [&manifest.profile, &manifest.core_home, &manifest.workspace] {
        ensure!(
            !target.starts_with(&manifest.source.profile)
                && !target.starts_with(&manifest.source.core_home),
            "new space overlaps original data"
        );
    }
    inspect(&manifest)?;
    storage::private_dir(&roots.long)?;
    storage::private_dir(&roots.short)?;
    // 各根先写完整身份；缺标记的碰撞或中断目录保持未知，绝不认领。
    owned_root(&roots.long.join(space_id), &manifest)?;
    owned_root(&manifest.host_home, &manifest)?;
    for path in [&manifest.profile, &manifest.core_home, &manifest.workspace] {
        storage::private_dir(path)?;
        ensure!(
            fs::read_dir(path)?.next().is_none(),
            "unfinished space contains unconfirmed data"
        );
    }
    private_new(&manifest_path(roots, space_id)?, &manifest)?;
    summary(&manifest)
}
pub fn prepare_space(space_id: &str, source: SpaceSource) -> Result<Value> {
    prepare(&roots()?, space_id, source)
}
pub fn resolve_space(space_id: &str) -> Result<Value> {
    full(&read_manifest(&roots()?, space_id)?)
}
pub fn active_space() -> Result<Value> {
    active(&roots()?)
}
fn active(roots: &Roots) -> Result<Value> {
    let Some(active) = storage::read_optional::<Value>(&roots.long.join("active.json"))? else {
        return Ok(json!({"spaceId":null}));
    };
    if active == json!({"spaceId":null}) {
        return Ok(active);
    }
    let space_id = active["spaceId"]
        .as_str()
        .context("active space identity is unavailable")?;
    let manifest = read_manifest(roots, space_id)?;
    ensure!(
        active == json!({"spaceId":space_id,"manifestDigest":digest(&manifest)?}),
        "active space identity changed"
    );
    Ok(active)
}
pub fn activate_space(space_id: Option<&str>) -> Result<Value> {
    let roots = roots()?;
    let value = if let Some(space_id) = space_id {
        let manifest = read_manifest(&roots, space_id)?;
        json!({"spaceId":space_id,"manifestDigest":digest(&manifest)?})
    } else {
        json!({"spaceId":null})
    };
    storage::private_dir(&roots.long)?;
    storage::write(&roots.long.join("active.json"), &value)?;
    Ok(value)
}
fn metadata(path: &Path) -> Result<Option<Value>> {
    storage::read_optional(path)
}
fn text(value: &Value, key: &str) -> Option<String> {
    value[key]
        .as_str()
        .filter(|s| s.len() <= 1024)
        .map(str::to_owned)
}
fn inspect(manifest: &Manifest) -> Result<Value> {
    validate_source(&manifest.source)?;
    let projects = metadata(&manifest.source.core_home.join("projects.json"))?.unwrap_or(json!([]));
    let entries = projects
        .as_array()
        .context("invalid old project directory")?;
    ensure!(entries.len() <= 256, "old project directory exceeds limit");
    let mut selected = vec![];
    for project in entries {
        let Some(root) = text(project, "root") else {
            continue;
        };
        let path = PathBuf::from(&root);
        ensure!(path.is_absolute(), "invalid old workspace path");
        let resolved = path.canonicalize().unwrap_or(path);
        ensure!(
            !manifest.workspace.starts_with(&resolved)
                && !resolved.starts_with(&manifest.workspace),
            "new workspace overlaps an old workspace"
        );
        let name = text(project, "name")
            .or_else(|| {
                resolved
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
            })
            .unwrap_or_else(|| "旧项目".into());
        selected.push(
            json!({"id":text(project,"id"),"name":name,"root":root,"execution":"unverified"}),
        );
    }
    let (mut public, provider_catalog_state) = catalog::providers(manifest);
    let claims = manifest.host_home.join("host/recovery-providers");
    if claims.exists() {
        let mut count = 0;
        for entry in fs::read_dir(&claims)? {
            let entry = entry?;
            if entry.path().extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            count += 1;
            ensure!(count <= 128, "provider import directory exceeds limit");
            let claim: Value = storage::read(&entry.path())?;
            let source = claim["sourceProviderId"]
                .as_str()
                .context("provider import source identity unavailable")?;
            ensure!(
                entry.path() == import_claim_path(&manifest.host_home, source),
                "provider import identity changed"
            );
            if !public.iter().any(|row| row["id"] == source) {
                public.push(json!({"id":source,"name":claim["name"],"models":[],"credentials":"notImported","templateDigest":claim["templateDigest"]}));
            }
        }
    }
    for provider in &mut public {
        if let Some(id) = provider["id"].as_str()
            && let Some(operation) = import_projection(&manifest.host_home, id)?
        {
            provider["importOperation"] = operation;
        }
    }
    let (scheduled_tasks, task_catalog_unavailable, tasks_truncated) =
        catalog::tasks(manifest, &selected);
    let (history, history_truncated) = history::catalog(manifest, &selected)?;
    let identity =
        metadata(&manifest.source.host_home.join("host/host.json"))?.unwrap_or(Value::Null);
    let stop = metadata(&manifest.source.host_home.join("host/stop.json"))?.unwrap_or(Value::Null);
    Ok(
        json!({"kind":"space","spaceId":manifest.space_id,"manifestDigest":digest(manifest)?,"workspace":manifest.workspace,"hasExistingData":!selected.is_empty()||!public.is_empty(),"previousHost":{"hostId":text(&identity,"hostId"),"generation":text(&identity,"generation"),"stopState":text(&stop,"state")},"projects":selected,"providers":public,"providerCatalogState":provider_catalog_state,"scheduledTasks":scheduled_tasks,"taskCatalogUnavailable":task_catalog_unavailable,"tasksTruncated":tasks_truncated,"tasks":"notImported","history":history,"historyTruncated":history_truncated}),
    )
}
pub fn inspect_space(space_id: &str) -> Result<Value> {
    inspect(&read_manifest(&roots()?, space_id)?)
}
/// 工作台反向调用 recovery.inspect：只接受可选的 spaceId。
pub(crate) fn inspect_params_for_host(host_home: &Path, params: &Value) -> Result<Value> {
    ensure!(
        params
            .as_object()
            .is_some_and(|o| o.keys().all(|key| key == "spaceId")),
        "INVALID_PARAMS"
    );
    let space_id = params
        .get("spaceId")
        .map(|value| value.as_str().context("INVALID_PARAMS"))
        .transpose()?;
    inspect_for_host(host_home, space_id)
}
pub(crate) fn inspect_for_host(host_home: &Path, space_id: Option<&str>) -> Result<Value> {
    inspect_for_host_at(&roots()?, host_home, space_id)
}
fn inspect_for_host_at(roots: &Roots, host_home: &Path, space_id: Option<&str>) -> Result<Value> {
    if space_id.is_none() && !host_home.join("space-owner.json").exists() {
        return Ok(json!({"kind":"none"}));
    }
    inspect(&manifest_for_host(roots, host_home, space_id)?)
}
fn manifest_for_host(roots: &Roots, host_home: &Path, space_id: Option<&str>) -> Result<Manifest> {
    let owner;
    let space_id = if let Some(space_id) = space_id {
        space_id
    } else {
        owner = storage::read::<Manifest>(&host_home.join("space-owner.json"))?;
        owner.space_id.as_str()
    };
    let manifest = read_manifest(roots, space_id)?;
    ensure!(manifest.host_home == host_home, "FORBIDDEN");
    Ok(manifest)
}

pub(crate) fn import_context(host_home: &Path, space_id: Option<&str>) -> Result<(String, String)> {
    let manifest = manifest_for_host(&roots()?, host_home, space_id)?;
    ensure!(manifest.config_home == host_home, "FORBIDDEN");
    Ok((manifest.space_id.clone(), digest(&manifest)?))
}
pub(crate) fn import_template(
    host_home: &Path,
    space_id: &str,
    provider: &str,
    expected: &str,
) -> Result<Value> {
    let manifest = manifest_for_host(&roots()?, host_home, Some(space_id))?;
    let (rows, _) = catalog::providers(&manifest);
    let row = rows
        .into_iter()
        .find(|row| row["id"] == provider)
        .context("FORBIDDEN")?;
    ensure!(row["templateDigest"] == expected, "TARGET_CHANGED");
    row.get("template")
        .cloned()
        .context("CAPABILITY_UNAVAILABLE")
}
pub(crate) fn import_claim_path(home: &Path, provider: &str) -> PathBuf {
    home.join("host/recovery-providers")
        .join(format!("{}.json", storage::digest(provider.as_bytes())))
}
fn import_projection(home: &Path, provider: &str) -> Result<Option<Value>> {
    let Some(claim) = storage::read_optional::<Value>(&import_claim_path(home, provider))? else {
        return Ok(None);
    };
    let request = claim["requestId"]
        .as_str()
        .context("invalid provider import claim")?;
    let operation = storage::read_optional::<Value>(&crate::wire::operation_path(home, request))?
        .unwrap_or(Value::Null);
    Ok(Some(
        json!({"requestId":request,"providerId":claim["providerId"],"templateDigest":claim["templateDigest"],"state":if operation["receipt"]["state"] == "completed" {"completed"} else {"admissionUnknown"}}),
    ))
}

fn source_workspaces(source: &SpaceSource) -> Result<Vec<PathBuf>> {
    let rows = metadata(&source.core_home.join("projects.json"))?.unwrap_or(json!([]));
    let rows = rows.as_array().context("invalid old project directory")?;
    ensure!(rows.len() <= 256, "old project directory exceeds limit");
    rows.iter()
        .map(|row| {
            let path = PathBuf::from(
                row["root"]
                    .as_str()
                    .context("old workspace identity missing")?,
            );
            ensure!(path.is_absolute(), "old workspace must be absolute");
            storage::canonical_pending(&path)
        })
        .collect()
}
// 空间归属来自持久 owner，不依赖可切换的 active 标记。旧目录未核实前一直保持执行隔离。
pub(crate) fn validate_workspace(host_home: &Path, workspace: &Path) -> Result<()> {
    let Some(owner) = storage::read_optional::<Manifest>(&host_home.join("space-owner.json"))?
    else {
        return Ok(());
    };
    ensure!(owner.host_home == host_home, "FORBIDDEN");
    let verified = read_manifest(&roots()?, &owner.space_id)?;
    ensure!(verified == owner, "FORBIDDEN");
    validate_workspace_for_manifest(&verified, workspace)
}
fn validate_workspace_for_manifest(manifest: &Manifest, workspace: &Path) -> Result<()> {
    let workspace = workspace.canonicalize()?;
    let mut protected = manifest.protected_workspaces.clone();
    protected.extend([
        manifest.source.profile.clone(),
        manifest.source.core_home.clone(),
        manifest.source.host_home.clone(),
    ]);
    protected.extend(source_workspaces(&manifest.source)?);
    for old in protected {
        let old = storage::canonical_pending(&old)?;
        ensure!(
            !workspace.starts_with(&old) && !old.starts_with(&workspace),
            crate::wire::error(
                "migrationBlocked",
                "旧工作区仍需核实后台状态，请在独立工作区继续；旧历史可只读查看。"
            )
        );
    }
    Ok(())
}

/// 只读取现存后台，不负责启动、停止或核对未决操作。
pub async fn preflight_space(source: SpaceSource) -> Result<Value> {
    for path in [&source.profile, &source.core_home, &source.host_home] {
        ensure!(path.is_absolute(), "source paths must be absolute");
        match fs::symlink_metadata(path) {
            Ok(_) => directory(path)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    let projects = metadata(&source.core_home.join("projects.json"))?;
    let providers = metadata(&source.core_home.join("providers.json"))?;
    let has_existing = projects
        .as_ref()
        .and_then(Value::as_array)
        .is_some_and(|v| !v.is_empty())
        || providers.as_ref().is_some_and(|v| {
            v.as_array()
                .or_else(|| v["data"].as_array())
                .or_else(|| v["providers"].as_array())
                .is_some_and(|v| !v.is_empty())
        });
    if !has_existing {
        return Ok(json!({"kind":"normal","hasExistingData":false}));
    }
    let Some(identity) = metadata(&source.host_home.join("host/host.json"))? else {
        return Ok(json!({"kind":"normal","hasExistingData":true}));
    };
    let observed = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        let client = crate::Client::connect_at(source.host_home.clone()).await?;
        client.status().await
    })
    .await;
    let status = match observed {
        Ok(Ok(status)) => status,
        _ => {
            return Ok(json!({"kind":"blocked","hasExistingData":true,"reason":"hostUnreachable"}));
        }
    };
    let previous = json!({"hostId":status.host_id,"generation":status.generation});
    if identity["hostId"] != status.host_id || identity["generation"] != status.generation {
        return Ok(
            json!({"kind":"blocked","hasExistingData":true,"previousHost":previous,"reason":"identityChanged"}),
        );
    }
    let stop = metadata(&source.host_home.join("host/stop.json"))?.unwrap_or(Value::Null);
    let reason = if status.stop_intent
        && stop["generation"] == status.generation
        && stop["state"] == "admissionUnknown"
    {
        Some("stopUnknown")
    } else if status
        .projects
        .iter()
        .any(|project| project.schedule_activation_error.as_deref() == Some("migrationBlocked"))
    {
        Some("migrationBlocked")
    } else {
        None
    };
    Ok(match reason {
        Some(reason) => {
            json!({"kind":"upgradeRequired","hasExistingData":true,"previousHost":previous,"reason":reason})
        }
        None => json!({"kind":"normal","hasExistingData":true,"previousHost":previous}),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Roots, SpaceSource) {
        let temp = tempfile::tempdir_in("/tmp").unwrap();
        let base = temp.path().canonicalize().unwrap();
        let source = SpaceSource {
            profile: base.join("old-profile"),
            core_home: base.join("old-core"),
            host_home: base.join("old-host"),
        };
        for path in [&source.profile, &source.core_home, &source.host_home] {
            storage::private_dir(path).unwrap();
        }
        let roots = Roots {
            long: base.join("spaces"),
            short: base.join("hosts"),
        };
        (temp, roots, source)
    }
    #[test]
    fn new_space_is_empty_idempotent_and_catalog_never_exports_credentials_or_settles_unknown() {
        let (_temp, roots, source) = fixture();
        let old = source.profile.join("project");
        storage::private_dir(&old).unwrap();
        storage::write(
            &source.core_home.join("projects.json"),
            &json!([{"id":"old-project","root":old,"name":"旧项目"}]),
        )
        .unwrap();
        storage::write(&source.core_home.join("providers.json"),&json!({"data":[{"id":"arena","name":"Arena","apiKey":"secret-must-not-appear","models":[{"id":"fixture"}]}]})).unwrap();
        storage::private_dir(&source.host_home.join("host")).unwrap();
        let receipt = source.host_home.join("host/stop.json");
        storage::write(
            &receipt,
            &json!({"requestId":"old-request","state":"admissionUnknown"}),
        )
        .unwrap();
        let before = fs::read(&receipt).unwrap();
        let space_id = uuid::Uuid::new_v4().to_string();
        let first = prepare(&roots, &space_id, source.clone()).unwrap();
        assert_eq!(prepare(&roots, &space_id, source.clone()).unwrap(), first);
        let manifest = read_manifest(&roots, &space_id).unwrap();
        assert!(fs::read_dir(&manifest.workspace).unwrap().next().is_none());
        assert!(fs::read_dir(&manifest.core_home).unwrap().next().is_none());
        let catalog = inspect(&manifest).unwrap();
        assert_eq!(catalog["tasks"], "notImported");
        assert_eq!(catalog["previousHost"]["stopState"], "admissionUnknown");
        assert!(!catalog.to_string().contains("secret-must-not-appear"));
        assert_eq!(fs::read(&receipt).unwrap(), before);
        let changed = SpaceSource {
            profile: source.core_home.clone(),
            ..source
        };
        assert!(prepare(&roots, &space_id, changed).is_err());
        // 清单发布前中断可沿同一 owner 恢复，不生成第二目录。
        fs::remove_file(manifest_path(&roots, &space_id).unwrap()).unwrap();
        assert_eq!(
            prepare(&roots, &space_id, manifest.source.clone()).unwrap(),
            first
        );
    }
    #[test]
    fn space_rejects_unowned_collision_and_workspace_overlap() {
        let (_temp, roots, source) = fixture();
        let space_id = uuid::Uuid::new_v4().to_string();
        storage::private_dir(&roots.long.join(&space_id)).unwrap();
        assert!(prepare(&roots, &space_id, source.clone()).is_err());
        assert!(!manifest_path(&roots, &space_id).unwrap().exists());
        let other = uuid::Uuid::new_v4().to_string();
        storage::write(
            &source.core_home.join("projects.json"),
            &json!([{"id":"broad","root":roots.long.parent().unwrap()}]),
        )
        .unwrap();
        assert!(
            prepare(&roots, &other, source)
                .unwrap_err()
                .to_string()
                .contains("overlaps")
        );
        assert!(!roots.long.join(other).exists());
    }
    #[test]
    fn v18_config_catalog_excludes_credentials_and_preserves_disabled_template_and_preview() {
        let (_temp, roots, source) = fixture();
        let config = "schema_version=2\n[model.providers.arena]\nname='Synthetic Arena'\nendpoint='https://example.invalid/v1/responses'\nprotocol='responses'\nenabled=true\napi_key_env='SECRET_REFERENCE_CANARY'\nmodels=[{id='fixture'}]\n";
        fs::write(source.host_home.join("config.toml"), config).unwrap();
        let project = "a".repeat(24);
        let thread = uuid::Uuid::new_v4().to_string();
        let workspace = source.profile.join("project");
        storage::private_dir(&workspace).unwrap();
        storage::write(
            &source.core_home.join("projects.json"),
            &json!([{"id":project,"root":workspace}]),
        )
        .unwrap();
        storage::write(&source.core_home.join("library.json"),&json!({"projects":{&project:{"navigationSummaries":[{"id":thread,"preview":"Old title"}]}}})).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        prepare(&roots, &id, source.clone()).unwrap();
        let manifest = read_manifest(&roots, &id).unwrap();
        let result = inspect(&manifest).unwrap();
        assert_eq!(result["providerCatalogState"], "available");
        assert_eq!(result["providers"].as_array().unwrap().len(), 1);
        let provider = &result["providers"][0];
        assert_eq!(provider["template"]["enabled"], false);
        assert_eq!(
            provider["template"]["baseUrl"],
            "https://example.invalid/v1"
        );
        assert!(provider["templateDigest"].as_str().is_some());
        assert!(!result.to_string().contains("SECRET_REFERENCE_CANARY"));
        assert_eq!(result["history"][0]["title"], "Old title");
        assert_eq!(
            fs::read_to_string(source.host_home.join("config.toml")).unwrap(),
            config
        );
        let original_digest = provider["templateDigest"].clone();
        let claim = import_claim_path(&manifest.host_home, "arena");
        storage::private_dir(claim.parent().unwrap()).unwrap();
        let request = uuid::Uuid::new_v4().to_string();
        storage::write(&claim,&json!({"sourceProviderId":"arena","name":"Original name","requestId":request,"providerId":"restored","templateDigest":original_digest})).unwrap();
        fs::write(
            source.host_home.join("config.toml"),
            config.replace("Synthetic Arena", "Changed name"),
        )
        .unwrap();
        let changed = inspect(&manifest).unwrap();
        assert_ne!(changed["providers"][0]["templateDigest"], original_digest);
        assert_eq!(
            changed["providers"][0]["importOperation"]["templateDigest"],
            original_digest
        );
        fs::write(source.host_home.join("config.toml"), "schema_version=2\n").unwrap();
        let removed = inspect(&manifest).unwrap();
        assert_eq!(removed["providers"][0]["id"], "arena");
        assert_eq!(
            removed["providers"][0]["importOperation"]["requestId"],
            request
        );
        assert_eq!(
            removed["providers"][0]["importOperation"]["state"],
            "admissionUnknown"
        );
        assert!(removed["providers"][0].get("template").is_none());
    }
    #[test]
    fn space_fence_covers_equal_parent_child_symlink_and_retains_removed_old_root() {
        let (_temp, roots, source) = fixture();
        let old = source.profile.join("project");
        let child = old.join("child");
        storage::private_dir(&child).unwrap();
        storage::write(
            &source.core_home.join("projects.json"),
            &json!([{"id":"old","root":old}]),
        )
        .unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        prepare(&roots, &id, source.clone()).unwrap();
        let manifest = read_manifest(&roots, &id).unwrap();
        let alias = source.profile.join("alias");
        std::os::unix::fs::symlink(&old, &alias).unwrap();
        for path in [&old, &child, &source.profile, &alias] {
            assert!(validate_workspace_for_manifest(&manifest, path).is_err());
        }
        assert!(validate_workspace_for_manifest(&manifest, &manifest.workspace).is_ok());
        storage::write(&source.core_home.join("projects.json"), &json!([])).unwrap();
        assert!(validate_workspace_for_manifest(&manifest, &old).is_err());
        assert_eq!(manifest.config_home, manifest.host_home);
        assert_eq!(
            inspect_for_host_at(&roots, &source.host_home, None).unwrap(),
            json!({"kind":"none"})
        );
    }
    #[test]
    fn prepared_space_retry_keeps_frozen_source_when_old_project_directory_changes() {
        let (_temp, roots, source) = fixture();
        let old = source.profile.join("original");
        storage::private_dir(&old).unwrap();
        storage::write(
            &source.core_home.join("projects.json"),
            &json!([{"id":"original","root":old}]),
        )
        .unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let first = prepare(&roots, &id, source.clone()).unwrap();
        let before = read_manifest(&roots, &id).unwrap();
        storage::write(&source.core_home.join("projects.json"), &json!([])).unwrap();
        assert_eq!(prepare(&roots, &id, source.clone()).unwrap(), first);
        assert_eq!(
            read_manifest(&roots, &id).unwrap().protected_workspaces,
            before.protected_workspaces
        );
        fs::remove_file(manifest_path(&roots, &id).unwrap()).unwrap();
        assert_eq!(prepare(&roots, &id, source).unwrap(), first);
    }
    #[test]
    fn new_space_cannot_execute_inside_previous_profile_core_or_host_data() {
        let (_temp, roots, source) = fixture();
        let id = uuid::Uuid::new_v4().to_string();
        prepare(&roots, &id, source.clone()).unwrap();
        let manifest = read_manifest(&roots, &id).unwrap();
        for old in [&source.profile, &source.core_home, &source.host_home] {
            let child = old.join("nested");
            storage::private_dir(&child).unwrap();
            for path in [old, &child, old.parent().unwrap()] {
                assert!(
                    validate_workspace_for_manifest(&manifest, path).is_err(),
                    "source data must be fenced"
                );
            }
        }
        assert!(validate_workspace_for_manifest(&manifest, &manifest.workspace).is_ok());
    }
    #[test]
    fn corrupt_active_selection_never_falls_back_to_the_original_space() {
        let (_temp, roots, source) = fixture();
        assert_eq!(active(&roots).unwrap(), json!({"spaceId":null}));
        let space_id = uuid::Uuid::new_v4().to_string();
        let prepared = prepare(&roots, &space_id, source).unwrap();
        let path = roots.long.join("active.json");
        for invalid in [
            json!({}),
            json!({"spaceId":7}),
            json!({"spaceId":null,"extra":true}),
            json!({"spaceId":space_id,"manifestDigest":"changed"}),
        ] {
            storage::write(&path, &invalid).unwrap();
            assert!(active(&roots).is_err());
        }
        let selected = json!({"spaceId":space_id,"manifestDigest":prepared["manifestDigest"]});
        storage::write(&path, &selected).unwrap();
        assert_eq!(active(&roots).unwrap(), selected);
        let manifest = read_manifest(&roots, &space_id).unwrap();
        let catalog = inspect_for_host_at(&roots, &manifest.host_home, None).unwrap();
        assert_eq!(catalog["workspace"], json!(manifest.workspace));
        assert_eq!(
            inspect_for_host_at(&roots, &manifest.source.host_home, None).unwrap(),
            json!({"kind":"none"})
        );
        assert!(inspect_for_host_at(&roots, &manifest.source.host_home, Some(&space_id)).is_err());
        storage::write(&path, &json!({"spaceId":null})).unwrap();
        assert_eq!(active(&roots).unwrap(), json!({"spaceId":null}));
    }
}
