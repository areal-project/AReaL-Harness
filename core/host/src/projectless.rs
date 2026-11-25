//! 项目外目录先持久预约，再创建目录和登记项目；重试只恢复原预约。
use super::{Host, gui_project, library_store, worktree_catalog};
use anyhow::{Context, Result, ensure};
use areal_local_service::storage;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
    rc::Rc,
};

const SCRATCH_ID: &str = "00000000-0000-4000-a000-5c4a7c400001";
#[derive(Default)]
pub(super) struct Projectless {
    // 跨 await 的预约与登记共用串行入口，避免同一来源的旧整表覆盖新预约。
    pending: tokio::sync::Mutex<()>,
}
#[derive(Deserialize, Serialize)]
struct Allocation {
    root: PathBuf,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    existing: bool,
}
fn existing_directory(path: &str, reject_parent: bool) -> Result<PathBuf> {
    let path = Path::new(path);
    ensure!(
        path.is_absolute()
            && (!reject_parent
                || !path
                    .components()
                    .any(|part| part == std::path::Component::ParentDir)),
        "INVALID_PARAMS"
    );
    let path = path.canonicalize()?;
    ensure!(path.is_dir(), "projectless directory unavailable");
    Ok(path)
}
fn create_directory(path: &Path) -> Result<()> {
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)?;
    ensure!(path.is_dir(), "projectless directory unavailable");
    Ok(())
}
fn directory(host: &Host, source: &str, options: &Value) -> Result<PathBuf> {
    let state = library_store::read_source(host, source)?;
    let path = match state["settings"]["projectlessDirectory"].as_str() {
        Some(path) => PathBuf::from(path),
        None => super::workbench_utility::inputs(options)?
            .homedir
            .context("user home missing")?
            .join("Documents/AReaL"),
    };
    ensure!(path.is_absolute(), "INVALID_PARAMS");
    Ok(path)
}
fn normal_project(home: &Path, root: &Path) -> Result<bool> {
    let projects =
        storage::read_optional::<Vec<Value>>(&home.join("projects.json"))?.unwrap_or_default();
    Ok(projects.iter().any(|project| {
        project["root"]
            .as_str()
            .is_some_and(|path| Path::new(path) == root)
            && project["projectless"] != true
    }))
}
impl Projectless {
    pub(super) async fn command(
        &self,
        host: &Rc<Host>,
        source: &str,
        request: &Value,
    ) -> Result<Value> {
        host.admission()?;
        let options = gui_project::options(host, source)?;
        let operation = request["operation"].as_str().context("INVALID_PARAMS")?;
        let fields: &[&str] = match operation {
            "catalog" | "scratch" => &["operation"],
            "directory" => &["operation", "path"],
            "prepare" => &["operation", "requestId", "directory"],
            _ => anyhow::bail!("INVALID_PARAMS"),
        };
        ensure!(
            request
                .as_object()
                .context("INVALID_PARAMS")?
                .keys()
                .all(|key| fields.contains(&key.as_str())),
            "INVALID_PARAMS"
        );
        if operation == "catalog" {
            return super::gateway_owner::projectless_models(host, source, &options);
        }
        let _pending = self.pending.lock().await;
        host.admission()?;
        ensure!(
            gui_project::options(host, source)? == options,
            "RESYNC_REQUIRED"
        );
        if operation == "directory" {
            let path =
                existing_directory(request["path"].as_str().context("INVALID_PARAMS")?, false)?;
            library_store::change(host, source, |state| {
                state["settings"]["projectlessDirectory"] = json!(path);
                Ok(())
            })?;
            return Ok(json!({"directory":path}));
        }
        let home = library_store::source_home(host, source)?;
        let scratch = operation == "scratch";
        let id = if scratch {
            SCRATCH_ID
        } else {
            request["requestId"].as_str().context("INVALID_PARAMS")?
        };
        ensure!(
            uuid::Uuid::parse_str(id).is_ok_and(|value| value.to_string() == id),
            "INVALID_PARAMS"
        );
        let selected = if scratch {
            let config = super::workbench_utility::inputs(&options)?;
            let base = config
                .env
                .get(std::ffi::OsStr::new("AREAL_HARNESS_HOME"))
                .map(PathBuf::from)
                .or_else(|| config.homedir.map(|home| home.join(".areal")))
                .context("configuration home missing")?
                .join("scratch");
            create_directory(&base)?;
            Some(base.canonicalize()?)
        } else {
            request
                .get("directory")
                .map(|value| existing_directory(value.as_str().context("INVALID_PARAMS")?, true))
                .transpose()?
        };
        let path = home.join("projectless-drafts.json");
        let mut allocations: BTreeMap<String, Allocation> =
            storage::read_optional(&path)?.unwrap_or_default();
        ensure!(
            allocations
                .values()
                .all(|allocation| allocation.root.is_absolute()),
            "invalid projectless allocations"
        );
        if let Some(original) = allocations.get(id) {
            ensure!(
                selected.as_ref().is_none_or(|path| path == &original.root),
                "projectless draft already bound to original directory"
            );
        } else {
            let existing = selected.is_some();
            let root = match selected {
                Some(root) => root,
                None => {
                    let base = directory(host, source, &options)?;
                    create_directory(&base)?;
                    base.canonicalize()?.join(id)
                }
            };
            ensure!(
                !normal_project(&home, &root)?,
                "directory belongs to an existing project"
            );
            allocations.insert(id.into(), Allocation { root, existing });
            storage::write(&path, &allocations)?;
        }
        let allocation = &allocations[id];
        ensure!(
            !normal_project(&home, &allocation.root)?,
            "directory belongs to an existing project"
        );
        let projects =
            storage::read_optional::<Vec<Value>>(&home.join("projects.json"))?.unwrap_or_default();
        if allocation.existing || projects.iter().any(|row| row["projectlessRequestId"] == id) {
            ensure!(
                allocation.root.is_dir(),
                "original projectless directory unavailable"
            );
        } else {
            create_directory(&allocation.root)?;
        }
        ensure!(
            allocation.root.canonicalize()? == allocation.root,
            "projectless directory replaced"
        );
        let result = worktree_catalog::add_project(
            host,
            source,
            json!({"root":allocation.root,"projectlessRequestId":id}),
        )
        .await?;
        ensure!(
            !normal_project(&home, &allocation.root)?,
            "directory belongs to an existing project"
        );
        Ok(json!({"projectId":result["projectId"],"cwd":allocation.root}))
    }
}
