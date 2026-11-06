//! 项目内工作树的 Git 执行与持久回执；原请求未知时只观察，不重放副作用。
use crate::Engine;
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs::{File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::OpenOptionsExt,
    path::{Component, Path, PathBuf},
    time::Duration,
};
use tokio::io::AsyncReadExt;

const LIMIT: usize = 8 * 1024 * 1024;
fn text<'a>(input: &'a Value, key: &str) -> Result<&'a str> {
    input[key]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 4096 && !s.chars().any(char::is_control))
        .with_context(|| format!("invalid worktree {key}"))
}
fn fields(input: &Value, allowed: &[&str]) -> Result<()> {
    ensure!(
        input
            .as_object()
            .is_some_and(|object| object.keys().all(|key| allowed.contains(&key.as_str()))),
        "invalid worktree request fields"
    );
    Ok(())
}
fn request_id(input: &Value, key: &str) -> Result<String> {
    Ok(uuid::Uuid::parse_str(text(input, key)?)?.to_string())
}
fn now() -> String {
    chrono::DateTime::<chrono::Utc>::from(std::time::SystemTime::now())
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn absolute(value: &str) -> Result<PathBuf> {
    let path = PathBuf::from(value);
    ensure!(
        path.is_absolute()
            && !path
                .components()
                .any(|part| matches!(part, Component::ParentDir | Component::CurDir)),
        "worktree path must be absolute without traversal"
    );
    ensure!(
        !value.chars().any(char::is_control),
        "invalid worktree path"
    );
    Ok(path)
}
fn parents(path: &Path, create: bool) -> Result<()> {
    let mut cursor = PathBuf::new();
    for part in path.components() {
        cursor.push(part);
        let metadata = match std::fs::symlink_metadata(&cursor) {
            Ok(meta) => meta,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if !create {
                    continue;
                }
                std::fs::create_dir(&cursor)?;
                std::fs::symlink_metadata(&cursor)?
            }
            Err(error) => return Err(error.into()),
        };
        ensure!(
            metadata.is_dir() && !metadata.file_type().is_symlink(),
            "worktree path traverses a link or file"
        );
    }
    Ok(())
}
fn read_json(path: &Path) -> Result<Option<Value>> {
    let mut file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    ensure!(
        file.metadata()?.is_file() && file.metadata()?.len() <= LIMIT as u64,
        "invalid worktree receipt file"
    );
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(LIMIT as u64 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= LIMIT, "worktree receipt exceeds limit");
    Ok(Some(serde_json::from_slice(&bytes)?))
}
fn save(path: &Path, value: &Value, once: bool) -> Result<()> {
    let root = path
        .parent()
        .context("worktree receipt directory missing")?;
    std::fs::create_dir_all(root)?;
    parents(root, false)?;
    let mut file = tempfile::NamedTempFile::new_in(root)?;
    file.as_file_mut().write_all(&serde_json::to_vec(value)?)?;
    file.as_file().sync_all()?;
    if once {
        file.persist_noclobber(path).map_err(|error| error.error)?;
    } else {
        file.persist(path).map_err(|error| error.error)?;
    }
    File::open(root)?.sync_all()?;
    Ok(())
}
async fn git(root: &Path, args: &[&str], checkout: bool) -> Result<String> {
    let mut fixed: Vec<String> = [
        "core.hooksPath=/dev/null",
        "core.fsmonitor=false",
        "core.untrackedCache=false",
        "submodule.recurse=false",
        "gc.auto=0",
        "maintenance.auto=false",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    if checkout {
        let names = git_config_filters(root).await?;
        for driver in names {
            fixed.extend([
                format!("filter.{driver}.clean="),
                format!("filter.{driver}.smudge="),
                format!("filter.{driver}.process="),
                format!("filter.{driver}.required=false"),
            ]);
        }
    }
    git_with(root, args, &fixed, false).await
}
async fn git_config_filters(root: &Path) -> Result<BTreeSet<String>> {
    let output = git_with(
        root,
        &[
            "config",
            "--null",
            "--name-only",
            "--get-regexp",
            "^filter\\..*\\.(clean|smudge|process|required)$",
        ],
        &["core.hooksPath=/dev/null".into()],
        true,
    )
    .await?;
    Ok(output
        .split('\0')
        .filter_map(|name| {
            name.strip_prefix("filter.")?
                .rsplit_once('.')
                .map(|(driver, _)| driver.to_owned())
        })
        .collect())
}
async fn git_with(
    root: &Path,
    args: &[&str],
    fixed: &[String],
    allow_missing: bool,
) -> Result<String> {
    let mut command = tokio::process::Command::new("git");
    command.arg("-C").arg(root);
    for config in fixed {
        command.arg("-c").arg(config);
    }
    for (key, _) in std::env::vars_os() {
        if key
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("GIT_")
        {
            command.env_remove(key);
        }
    }
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn()?;
    let mut stdout = child
        .stdout
        .take()
        .context("git stdout missing")?
        .take(LIMIT as u64 + 1);
    let mut stderr = child
        .stderr
        .take()
        .context("git stderr missing")?
        .take(65537);
    let result = tokio::time::timeout(Duration::from_secs(120), async {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let (a, b, status) = tokio::join!(
            stdout.read_to_end(&mut out),
            stderr.read_to_end(&mut err),
            child.wait()
        );
        a?;
        b?;
        ensure!(
            out.len() <= LIMIT && err.len() <= 65536,
            "git output exceeds limit"
        );
        let status = status?;
        ensure!(
            status.success() || (allow_missing && status.code() == Some(1)),
            "Git operation failed ({status})"
        );
        Ok::<_, anyhow::Error>(String::from_utf8(out)?)
    })
    .await
    .context("git operation timed out")?;
    if result.is_err() {
        let _ = child.kill().await;
    }
    result
}
async fn identity(root: &Path) -> Result<(PathBuf, PathBuf)> {
    let root = PathBuf::from(
        git(root, &["rev-parse", "--show-toplevel"], false)
            .await?
            .trim(),
    )
    .canonicalize()?;
    let common = PathBuf::from(
        git(
            &root,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            false,
        )
        .await?
        .trim(),
    )
    .canonicalize()?;
    Ok((root, common))
}
async fn list(root: &Path) -> Result<Vec<Value>> {
    let output = git(root, &["worktree", "list", "--porcelain", "-z"], false).await?;
    let mut rows = Vec::new();
    let mut current = json!({});
    for field in output.split('\0') {
        if field.is_empty() {
            if current.get("root").is_some() {
                rows.push(current);
                current = json!({});
            }
            continue;
        }
        if let Some(root) = field.strip_prefix("worktree ") {
            current["root"] = json!(root);
        } else if let Some(head) = field.strip_prefix("HEAD ") {
            current["head"] = json!(head);
        } else if let Some(branch) = field.strip_prefix("branch ") {
            current["branch"] = json!(branch.strip_prefix("refs/heads/").unwrap_or(branch));
        } else if field.starts_with("locked") {
            current["locked"] = json!(true);
        } else if field.starts_with("prunable") {
            current["prunable"] = json!(true);
        } else if field == "detached" {
            current["detached"] = json!(true);
        }
    }
    if current.get("root").is_some() {
        rows.push(current);
    }
    Ok(rows)
}
fn transition(value: &mut Value, state: &str, message: Option<String>) {
    value["state"] = json!(state);
    let id = value["requestId"].as_str().unwrap_or_default().to_owned();
    let events = value["events"].as_array_mut().unwrap();
    let mut event = json!({"id":format!("{id}:{}",events.len()),"state":state,"time":now()});
    if let Some(message) = message {
        event["message"] = json!(message);
    }
    events.push(event);
}
impl Engine {
    /// 目录读取不创建工作树或重试未结算的请求。
    pub async fn worktree_read(&self, params: Value) -> Result<Value> {
        let root = PathBuf::from(self.default_cwd()).canonicalize()?;
        match text(&params, "operation")? {
            "worktreeList" => {
                fields(&params, &["operation"])?;
                Ok(json!({"worktrees":list(&root).await?}))
            }
            "worktreeOptions" => {
                fields(&params, &["operation", "projectId", "sourceRoot"])?;
                let selected = params["sourceRoot"]
                    .as_str()
                    .map(PathBuf::from)
                    .unwrap_or_else(|| root.clone())
                    .canonicalize()?;
                ensure!(
                    identity(&selected).await?.1 == identity(&root).await?.1,
                    "source worktree is not in the same repository"
                );
                let branches = git(
                    &selected,
                    &[
                        "for-each-ref",
                        "--format=%(refname:short)",
                        "refs/heads",
                        "refs/remotes",
                    ],
                    false,
                )
                .await?;
                Ok(
                    json!({"worktrees":list(&root).await?,"branches":branches.lines().collect::<Vec<_>>()}),
                )
            }
            "worktreeInspect" => {
                fields(
                    &params,
                    &["operation", "requestId", "legacyOperation", "allowDirty"],
                )?;
                ensure!(
                    params.get("allowDirty").is_none_or(Value::is_boolean),
                    "invalid allowDirty"
                );
                let id = request_id(&params, "requestId")?;
                let path = self
                    .data_dir()
                    .join("worktree-requests")
                    .join(format!("{id}.json"));
                let value = read_json(&path)?
                    .or_else(|| params.get("legacyOperation").cloned())
                    .context("worktree creation missing")?;
                ensure!(value["requestId"] == id, "worktree identity mismatch");
                Self::inspect_worktree(&root, &value, params["allowDirty"] == true).await?;
                Ok(value)
            }
            "worktreeRead" => {
                fields(&params, &["operation", "projectId", "requestId"])?;
                let id = request_id(&params, "requestId")?;
                let path = self
                    .data_dir()
                    .join("worktree-requests")
                    .join(format!("{id}.json"));
                let Some(mut value) = read_json(&path)? else {
                    return Ok(json!({"state":"missing"}));
                };
                if matches!(value["state"].as_str(), Some("creating" | "unknown"))
                    && value["record"].is_object()
                {
                    let observed = async {
                        let record = &value["record"];
                        let directory = absolute(text(record, "directory")?)?;
                        parents(&directory, false)?;
                        let (actual, common) = identity(&directory).await?;
                        ensure!(
                            actual == directory
                                && record["commonDir"] == common.to_string_lossy().as_ref(),
                            "worktree identity changed"
                        );
                        ensure!(
                            git(
                                &directory,
                                &["symbolic-ref", "--quiet", "--short", "HEAD"],
                                false
                            )
                            .await?
                            .trim()
                                == text(record, "branch")?,
                            "worktree branch changed"
                        );
                        ensure!(
                            git(
                                &directory,
                                &[
                                    "status",
                                    "--porcelain=v1",
                                    "--untracked-files=all",
                                    "--ignored=matching"
                                ],
                                true
                            )
                            .await?
                            .trim()
                            .is_empty(),
                            "worktree checkout incomplete"
                        );
                        git(
                            &directory,
                            &["merge-base", "--is-ancestor", text(record, "base")?, "HEAD"],
                            false,
                        )
                        .await?;
                        ensure!(
                            Path::new(text(record, "cwd")?).is_dir(),
                            "worktree project directory missing"
                        );
                        Ok::<(), anyhow::Error>(())
                    }
                    .await;
                    if observed.is_ok() {
                        transition(&mut value, "created", None);
                        save(&path, &value, false)?;
                    }
                }
                if value["deletion"]["status"] == "running" && value["record"].is_object() {
                    let destination = absolute(text(&value["record"], "directory")?)?;
                    if !destination.try_exists()?
                        && !list(&root)
                            .await?
                            .iter()
                            .any(|tree| tree["root"] == destination.to_string_lossy().as_ref())
                    {
                        if git(
                            &root,
                            &[
                                "show-ref",
                                "--verify",
                                &format!("refs/heads/{}", text(&value["record"], "branch")?),
                            ],
                            false,
                        )
                        .await
                        .is_ok()
                        {
                            value["deleted"] = json!(true);
                            value["deletedAt"] = json!(now());
                            value["deletion"]["status"] = json!("succeeded");
                            let mut result = json!({"requestId":value["deletion"]["requestId"],"creationId":id,"removed":true});
                            for key in ["directory", "branch", "target"] {
                                result[key] = value["record"][key].clone();
                            }
                            value["deletion"]["result"] = result;
                            save(&path, &value, false)?;
                        }
                    }
                }
                Ok(value)
            }
            _ => bail!("unsupported worktree read"),
        }
    }
    pub async fn worktree_command(&self, params: Value) -> Result<Value> {
        let operation = text(&params, "operation")?.to_owned();
        fields(
            &params,
            match operation.as_str() {
                "worktreeCreate" => &[
                    "operation",
                    "projectId",
                    "requestId",
                    "source",
                    "sourceRoot",
                    "ref",
                    "worktreeRoot",
                    "branch",
                    "branchPrefix",
                    "fetchBeforeCreate",
                    "environmentId",
                ],
                "worktreeCancel" => &["operation", "projectId", "requestId", "worktreeRequestId"],
                "worktreeDelete" => &[
                    "operation",
                    "projectId",
                    "requestId",
                    "worktreeRequestId",
                    "automatic",
                    "legacyOperation",
                ],
                _ => bail!("unsupported Core worktree command"),
            },
        )?;
        let request = request_id(&params, "requestId")?;
        let root = PathBuf::from(self.default_cwd()).canonicalize()?;
        let directory = self.data_dir().join("worktree-requests");
        let command_path = directory.join(format!("{request}.command.json"));
        let semantic = json!({"operation":operation,"params":params});
        // 持久准入先于 Git；同 ID 不同参数拒绝，未有结果的同 ID 永不重放。
        if let Some(original) = read_json(&command_path)? {
            ensure!(original["semantic"] == semantic, "COMMAND_CONFLICT");
            if let Some(result) = original.get("result") {
                return Ok(result.clone());
            }
            if operation == "worktreeCreate" {
                return Ok(read_json(&directory.join(format!("{request}.json")))?
                    .unwrap_or(json!({"state":"unknown"})));
            }
            bail!("SUBMISSION_UNKNOWN");
        }
        ensure!(self.accepting_work(), "Core is not accepting work");
        save(&command_path, &json!({"semantic":semantic}), true)?;
        let result = match operation.as_str() {
            "worktreeCreate" => Self::create_worktree(&root, &params, &directory).await,
            "worktreeCancel" => {
                let id = request_id(&params, "worktreeRequestId")?;
                let path = directory.join(format!("{id}.json"));
                let mut value = read_json(&path)?.context("worktree request missing")?;
                value["intent"] = json!("cancel");
                if !matches!(
                    value["state"].as_str(),
                    Some("ready" | "failed" | "cancelled")
                ) {
                    transition(
                        &mut value,
                        "cancelled",
                        Some("创建已取消，已创建目录保留".into()),
                    );
                }
                save(&path, &value, false)?;
                Ok(value)
            }
            "worktreeDelete" => Self::remove_worktree(&root, &params, &directory).await,
            _ => bail!("unsupported Core worktree command"),
        };
        match result {
            Ok(result) => {
                save(
                    &command_path,
                    &json!({"semantic":semantic,"result":result}),
                    false,
                )?;
                Ok(result)
            }
            Err(error) => Err(error),
        }
    }
    async fn create_worktree(root: &Path, params: &Value, storage: &Path) -> Result<Value> {
        let request = request_id(params, "requestId")?;
        let project = text(params, "projectId")?;
        let path = storage.join(format!("{request}.json"));
        let mut value = json!({"kind":"checkout","requestId":request,"projectId":project,"parameters":params,"state":"creating","events":[],"createdAt":now()});
        save(&path, &value, true)?;
        let result=async {
            let (origin,common)=identity(root).await?;
            let selected=params["sourceRoot"].as_str().map(PathBuf::from).unwrap_or_else(||root.to_path_buf()).canonicalize()?;
            let (target,selected_common)=identity(&selected).await?;
            ensure!(common==selected_common,"source worktree is not in the same repository");
            let relative=root.strip_prefix(&origin)?;
            let worktree_root=absolute(text(params,"worktreeRoot")?)?;
            parents(&worktree_root,false)?;
            for checkout in list(&target).await? {
                ensure!(!worktree_root.starts_with(text(&checkout,"root")?),"worktree root is inside an existing checkout");
            }
            let prefix=params["branchPrefix"].as_str().unwrap_or("areal/task");
            let branch=params["branch"].as_str().map(str::to_owned).unwrap_or_else(||format!("{prefix}-{request}"));
            ensure!(!branch.starts_with('-') && !branch.chars().any(char::is_control),"invalid branch");
            git(&target,&["check-ref-format","--branch",&branch],false).await?;
            if params["fetchBeforeCreate"]==true { git(&target,&["fetch","--all","--no-recurse-submodules","--no-auto-maintenance"],false).await?; }
            let source=params["source"].as_str().unwrap_or("head");
            ensure!(matches!(source,"head"|"branch"),"unsupported worktree source");
            let source_head=git(&target,&["rev-parse","--verify","HEAD"],false).await?.trim().to_owned();
            let reference=if source=="branch" { text(params,"ref")? } else { "HEAD" };
            ensure!(!reference.starts_with('-'),"invalid source ref");
            let base=git(&target,&["rev-parse","--verify","--end-of-options",&format!("{reference}^{{commit}}")],false).await?.trim().to_owned();
            let destination=worktree_root.join(format!("task-{request}"));
            parents(&worktree_root,true)?;
            ensure!(!destination.try_exists()?,"worktree destination already exists");
            let record=json!({"requestId":request,"target":target,"sourceCwd":target.join(relative),"relativeCwd":relative,"sourceHead":source_head,"source":source,"sourceRef":if source=="branch" {json!(reference)} else {Value::Null},"base":base,"branch":branch,"directory":destination,"cwd":destination.join(relative),"commonDir":common,"copied":[],"createdAt":value["createdAt"]});
            value["record"]=record.clone();
            save(&path,&value,false)?;
            // 目录先登记后进入 Git；失去回复只能读原记录和 Git 身份，不再次运行 add。
            git(&target,&["worktree","add","--no-checkout","-b",&branch,destination.to_str().context("invalid destination")?,&base],false).await?;
            git(&destination,&["read-tree",&base],false).await?;
            git(&destination,&["checkout-index","--all"],true).await?;
            let (actual,actual_common)=identity(&destination).await?;
            ensure!(actual==destination && actual_common==common,"worktree identity changed");
            ensure!(destination.join(relative).is_dir(),"relative project directory unavailable in new worktree");
            ensure!(git(&destination,&["status","--porcelain=v1","--untracked-files=all","--ignored=matching"],true).await?.trim().is_empty(),"worktree checkout incomplete");
            Ok::<_,anyhow::Error>(())
        }.await;
        match result {
            Ok(()) => transition(&mut value, "created", None),
            Err(error) => {
                let uncertain = value.get("record").is_some();
                transition(
                    &mut value,
                    if uncertain { "unknown" } else { "failed" },
                    Some(error.to_string()),
                );
                value["message"] = json!(error.to_string());
            }
        }
        save(&path, &value, false)?;
        Ok(value)
    }
    async fn inspect_worktree(
        root: &Path,
        value: &Value,
        allow_dirty: bool,
    ) -> Result<(PathBuf, PathBuf)> {
        let record = &value["record"];
        ensure!(
            matches!(
                value["state"].as_str(),
                Some("created" | "ready" | "cancelled" | "failed")
            ),
            "worktree creation remains unconfirmed"
        );
        let destination = absolute(text(record, "directory")?)?;
        let (origin, origin_common) = identity(root).await?;
        let recorded_target = absolute(text(record, "target")?)?;
        let (target, common) = identity(&recorded_target).await?;
        ensure!(
            target == recorded_target && common == origin_common,
            "source repository identity changed"
        );
        parents(&destination, false)?;
        let (actual, actual_common) = identity(&destination).await?;
        ensure!(
            actual == destination
                && actual != target
                && actual != origin
                && actual_common == common
                && record["commonDir"] == common.to_string_lossy().as_ref(),
            "worktree identity changed"
        );
        ensure!(
            git(
                &destination,
                &["symbolic-ref", "--quiet", "--short", "HEAD"],
                false
            )
            .await?
            .trim()
                == text(record, "branch")?,
            "worktree branch changed"
        );
        let trees = list(root).await?;
        let tree = trees
            .iter()
            .find(|tree| tree["root"] == destination.to_string_lossy().as_ref())
            .context("worktree is not registered")?;
        ensure!(
            trees.first() != Some(tree) && tree["locked"] != true && tree["prunable"] != true,
            "worktree is primary, locked or prunable"
        );
        ensure!(
            allow_dirty
                || git(
                    &destination,
                    &[
                        "status",
                        "--porcelain=v1",
                        "--untracked-files=all",
                        "--ignored=matching"
                    ],
                    true
                )
                .await?
                .trim()
                .is_empty(),
            "worktree contains modified, untracked or ignored files"
        );
        ensure!(
            !git(&destination, &["ls-files", "--stage"], false)
                .await?
                .lines()
                .any(|line| line.starts_with("160000 ")),
            "worktree has submodules"
        );
        let head = git(&destination, &["rev-parse", "HEAD"], false)
            .await?
            .trim()
            .to_owned();
        git(
            &destination,
            &["merge-base", "--is-ancestor", text(record, "base")?, &head],
            false,
        )
        .await
        .context("worktree creation base changed")?;
        git(
            &target,
            &["merge-base", "--is-ancestor", &head, "HEAD"],
            false,
        )
        .await
        .context("worktree has unmerged commits")?;
        Ok((target, destination))
    }
    async fn remove_worktree(root: &Path, params: &Value, storage: &Path) -> Result<Value> {
        let creation = request_id(params, "worktreeRequestId")?;
        let request = request_id(params, "requestId")?;
        let path = storage.join(format!("{creation}.json"));
        let mut value = read_json(&path)?
            .or_else(|| params.get("legacyOperation").cloned())
            .context("worktree creation missing")?;
        ensure!(
            value["requestId"] == creation,
            "worktree creation identity mismatch"
        );
        if value["deleted"] == true {
            return Ok(value);
        }
        let (target, destination) = Self::inspect_worktree(root, &value, false).await?;
        value["deletion"] = json!({"requestId":request,"status":"running","blockers":[]});
        save(&path, &value, false)?;
        git(
            &target,
            &[
                "worktree",
                "remove",
                destination.to_str().context("invalid destination")?,
            ],
            false,
        )
        .await?;
        value["deleted"] = json!(true);
        value["deletedAt"] = json!(now());
        value["deletion"] = json!({"requestId":request,"status":"succeeded","result":{"requestId":request,"creationId":creation,"directory":destination,"target":target,"branch":value["record"]["branch"],"removed":true}});
        save(&path, &value, false)?;
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn repository(root: &Path) {
        std::fs::create_dir(root).unwrap();
        git(root, &["init", "-q"], false).await.unwrap();
        git(
            root,
            &["config", "user.email", "fixture@example.test"],
            false,
        )
        .await
        .unwrap();
        git(root, &["config", "user.name", "Fixture"], false)
            .await
            .unwrap();
        std::fs::write(root.join("tracked"), "committed\n").unwrap();
        git(root, &["add", "tracked"], false).await.unwrap();
        git(root, &["commit", "-qm", "fixture"], false)
            .await
            .unwrap();
    }
    #[tokio::test]
    async fn fixed_commit_creation_preserves_source_and_deletion_keeps_untracked_files() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().canonicalize().unwrap();
        let root = directory.join("source");
        repository(&root).await;
        std::fs::write(root.join("tracked"), "source dirty\n").unwrap();
        std::fs::write(root.join("private"), "source untracked\n").unwrap();
        let creation = uuid::Uuid::new_v4().to_string();
        let storage = directory.join("state");
        let params = json!({"projectId":"project","requestId":creation,"worktreeRoot":directory.join("trees"),"branchPrefix":"fixture"});
        let value = Engine::create_worktree(&root, &params, &storage)
            .await
            .unwrap();
        assert_eq!(value["state"], "created", "{value}");
        let target = PathBuf::from(value["record"]["directory"].as_str().unwrap());
        assert_eq!(
            std::fs::read_to_string(target.join("tracked")).unwrap(),
            "committed\n"
        );
        assert!(!target.join("private").exists());
        assert_eq!(
            std::fs::read_to_string(root.join("tracked")).unwrap(),
            "source dirty\n"
        );
        std::fs::write(target.join("keep"), "do not delete\n").unwrap();
        assert!(Engine::inspect_worktree(&root, &value, true).await.is_ok());
        assert!(
            Engine::inspect_worktree(&root, &value, false)
                .await
                .is_err()
        );
        let mut changed_identity = value.clone();
        changed_identity["record"]["branch"] = json!("different-branch");
        assert!(
            Engine::inspect_worktree(&root, &changed_identity, true)
                .await
                .is_err()
        );
        let remove =
            json!({"requestId":uuid::Uuid::new_v4().to_string(),"worktreeRequestId":creation});
        assert!(
            Engine::remove_worktree(&root, &remove, &storage)
                .await
                .is_err()
        );
        assert!(target.join("keep").exists());
        std::fs::remove_file(target.join("keep")).unwrap();
        let removed = Engine::remove_worktree(&root, &remove, &storage)
            .await
            .unwrap();
        assert_eq!(removed["deleted"], true);
        assert!(!target.exists());
        assert!(
            git(
                &root,
                &[
                    "show-ref",
                    "--verify",
                    &format!("refs/heads/{}", value["record"]["branch"].as_str().unwrap())
                ],
                false
            )
            .await
            .is_ok()
        );
    }
    #[tokio::test]
    async fn creation_disables_repository_checkout_filters_and_rejects_foreign_sources() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().canonicalize().unwrap();
        let root = directory.join("source");
        repository(&root).await;
        std::fs::write(root.join(".gitattributes"), "tracked filter=fixture\n").unwrap();
        git(&root, &["add", ".gitattributes"], false).await.unwrap();
        git(&root, &["commit", "-qm", "attributes"], false)
            .await
            .unwrap();
        let marker = directory.join("filter-ran");
        git(
            &root,
            &[
                "config",
                "filter.fixture.smudge",
                &format!("touch {}; cat", marker.display()),
            ],
            false,
        )
        .await
        .unwrap();
        git(&root, &["config", "filter.fixture.required", "true"], false)
            .await
            .unwrap();
        let params = json!({"projectId":"project","requestId":uuid::Uuid::new_v4().to_string(),"worktreeRoot":directory.join("trees")});
        let value = Engine::create_worktree(&root, &params, &directory.join("state"))
            .await
            .unwrap();
        assert_eq!(value["state"], "created", "{value}");
        assert!(!marker.exists());
        let foreign = directory.join("foreign");
        repository(&foreign).await;
        let params = json!({"projectId":"project","requestId":uuid::Uuid::new_v4().to_string(),"sourceRoot":foreign,"worktreeRoot":directory.join("trees")});
        let rejected = Engine::create_worktree(&root, &params, &directory.join("state"))
            .await
            .unwrap();
        assert_eq!(rejected["state"], "failed");
    }
}
