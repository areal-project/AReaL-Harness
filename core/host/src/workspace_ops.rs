use super::{Host, session_commands, worktree_catalog};
use anyhow::{Context, Result, anyhow, ensure};
use areal_local_service::storage;
use fs2::FileExt;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs::OpenOptions,
    io::Write,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Component, Path, PathBuf},
    process::Stdio,
    rc::Rc,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

const FILE_LIMIT: usize = 2 * 1024 * 1024;
const BLOB_LIMIT: usize = 8 * 1024 * 1024;
const DIFF_LIMIT: usize = 8 * 1024 * 1024;
const LIST_MAX_ENTRIES: usize = 1000;
const SEARCH_MAX_VISITED: usize = 2000;
const SEARCH_MAX_ENTRIES: usize = 500;
const GIT_TIMEOUT_READ: Duration = Duration::from_secs(30);
const GIT_TIMEOUT_FAST: Duration = Duration::from_secs(10);
const GIT_TIMEOUT_WRITE: Duration = Duration::from_secs(120);

const NOISE_NAMES: &[&str] = &[
    "node_modules",
    ".git",
    ".next",
    "dist",
    "build",
    "target",
    "__pycache__",
    ".venv",
    ".DS_Store",
];

const SCOPE_FIELDS: &[&str] = &[
    "projectId",
    "operation",
    "threadId",
    "sourceThreadId",
    "parentThreadId",
    "logicalProjectId",
    "executionProjectId",
    "requestId",
];

#[derive(Default)]
pub(super) struct WorkspaceOps {
    busy_repos: RefCell<BTreeSet<PathBuf>>,
    file_save_commit: Arc<Mutex<()>>,
}

struct BusyRepoGuard<'a> {
    repos: &'a RefCell<BTreeSet<PathBuf>>,
    path: PathBuf,
}

impl Drop for BusyRepoGuard<'_> {
    fn drop(&mut self) {
        self.repos.borrow_mut().remove(&self.path);
    }
}

struct TempFileGuard(Option<PathBuf>);

impl TempFileGuard {
    fn defuse(&mut self) {
        self.0 = None;
    }
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            let _ = std::fs::remove_file(path);
        }
    }
}

struct ReviewScratch(PathBuf);

impl Drop for ReviewScratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn cmd_err(message: impl Into<String>) -> anyhow::Error {
    let text: String = message.into().chars().take(512).collect();
    crate::wire::error("COMMAND_FAILED", text)
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_git_oid(value: &str) -> bool {
    (40..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn optional_str(value: Option<&Value>) -> Result<Option<&str>> {
    match value {
        None => Ok(None),
        Some(v) => Ok(Some(v.as_str().context("INVALID_PARAMS")?)),
    }
}

fn required_str<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .context("INVALID_PARAMS")
}

fn ensure_allowed_keys(obj: &serde_json::Map<String, Value>, extra: &[&str]) -> Result<()> {
    for (key, val) in obj {
        ensure!(
            SCOPE_FIELDS.contains(&key.as_str()) || extra.contains(&key.as_str()),
            "INVALID_PARAMS"
        );
        if SCOPE_FIELDS.contains(&key.as_str()) && key != "requestId" {
            let text = val.as_str().context("INVALID_PARAMS")?;
            ensure!(!text.is_empty() && text.len() <= 512, "INVALID_PARAMS");
        }
    }
    Ok(())
}

fn validate_request(request: &Value) -> Result<&str> {
    let obj = request.as_object().context("INVALID_PARAMS")?;
    let op = obj
        .get("operation")
        .and_then(Value::as_str)
        .context("INVALID_PARAMS")?;
    ensure!(
        obj.get("projectId")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty()),
        "INVALID_PARAMS"
    );
    match op {
        "list" => {
            ensure_allowed_keys(obj, &["path", "showAll"])?;
            required_str(request, "path")?;
            if let Some(v) = obj.get("showAll") {
                ensure!(v.is_boolean(), "INVALID_PARAMS");
            }
        }
        "search" => {
            ensure_allowed_keys(obj, &["query"])?;
            required_str(request, "query")?;
        }
        "localDirectoryReference" | "read" => {
            ensure_allowed_keys(obj, &["path"])?;
            required_str(request, "path")?;
        }
        "save" => {
            ensure_allowed_keys(obj, &["path", "text", "revision"])?;
            required_str(request, "path")?;
            required_str(request, "text")?;
            required_str(request, "revision")?;
        }
        "review" => {
            ensure_allowed_keys(obj, &["scope", "ref", "summaryOnly"])?;
            if let Some(summary_only) = obj.get("summaryOnly") {
                ensure!(summary_only.is_boolean(), "INVALID_PARAMS");
            }
            if let Some(scope) = optional_str(obj.get("scope"))? {
                ensure!(
                    matches!(
                        scope,
                        "task" | "uncommitted" | "unstaged" | "staged" | "branch" | "commit"
                    ),
                    "INVALID_PARAMS"
                );
            }
            let _ = optional_str(obj.get("ref"))?;
        }
        "reviewCommits" | "reviewBranches" | "status" | "info" | "gitState" => {
            ensure_allowed_keys(obj, &[])?;
        }
        "turnReview" => {
            ensure_allowed_keys(obj, &["threadId", "turnId", "itemId"])?;
            required_str(request, "threadId")?;
            required_str(request, "turnId")?;
            let _ = optional_str(obj.get("itemId"))?;
        }
        "gitStage" | "gitUnstage" => {
            ensure_allowed_keys(obj, &["token", "message", "remote", "targetBranch"])?;
            required_str(request, "token")?;
        }
        "gitCommit" => {
            ensure_allowed_keys(obj, &["token", "message", "remote", "targetBranch"])?;
            required_str(request, "token")?;
            required_str(request, "message")?;
        }
        "gitPush" => {
            ensure_allowed_keys(obj, &["token", "message", "remote", "targetBranch"])?;
            required_str(request, "token")?;
            required_str(request, "remote")?;
            required_str(request, "targetBranch")?;
        }
        _ => return Err(cmd_err("不支持的工作区操作")),
    }
    Ok(op)
}

impl WorkspaceOps {
    pub(super) async fn execute(
        &self,
        host: &Rc<Host>,
        source: &str,
        request: &Value,
    ) -> Result<Value> {
        let operation = request
            .as_object()
            .and_then(|obj| obj.get("operation"))
            .and_then(Value::as_str)
            .context("INVALID_PARAMS")?;
        if operation.starts_with("worktree") {
            let mut payload = request.clone();
            payload["sourceId"] = json!(source);
            let reading = matches!(
                operation,
                "worktreeList" | "worktreeOptions" | "worktreeRead"
            );
            return if reading {
                worktree_catalog::read(host, source, payload).await
            } else {
                worktree_catalog::command(host, source, payload).await
            };
        }

        let op = validate_request(request)?;
        let is_mutation = matches!(
            op,
            "save" | "gitStage" | "gitUnstage" | "gitCommit" | "gitPush"
        );
        let scope = session_commands::resolve_project_scope(
            host,
            source,
            request,
            is_mutation,
            is_mutation,
        )
        .await?;
        if is_mutation {
            host.schedules
                .connections
                .workbench_admit(host, &scope.canonical_id, None, "workspace", request)
                .await?;
        }

        match op {
            "localDirectoryReference" => {
                let raw = required_str(request, "path")?;
                local_directory_reference(raw).await
            }
            "list" => {
                let rel = required_str(request, "path")?.to_owned();
                let show_all = request.get("showAll").and_then(Value::as_bool) == Some(true);
                let ws = scope.workspace.clone();
                tokio::task::spawn_blocking(move || {
                    list_directory(&ws, &rel, show_all)?
                        .ok_or_else(|| cmd_err("目录不存在或不在工作区内"))
                })
                .await?
            }
            "search" => {
                let query = required_str(request, "query")?.to_owned();
                let ws = scope.workspace.clone();
                tokio::task::spawn_blocking(move || search_files(&ws, &query)).await?
            }
            "read" => {
                let rel = required_str(request, "path")?.to_owned();
                let ws = scope.workspace.clone();
                tokio::task::spawn_blocking(move || read_text(&ws, &rel)).await?
            }
            "save" => {
                let rel = required_str(request, "path")?.to_owned();
                let text = required_str(request, "text")?.to_owned();
                let rev = required_str(request, "revision")?.to_owned();
                let ws = scope.workspace.clone();
                let commit = self.file_save_commit.clone();
                tokio::task::spawn_blocking(move || save_text(&ws, &rel, &text, &rev, &commit))
                    .await?
            }
            "status" => file_status(&scope.workspace).await,
            "info" => workspace_info(&scope.workspace, &scope.home).await,
            "reviewCommits" => review_commits(&scope.workspace).await,
            "reviewBranches" => review_branches(&scope.workspace).await,
            "review" => {
                let review_scope = request
                    .get("scope")
                    .and_then(Value::as_str)
                    .unwrap_or("unstaged");
                let reference = request.get("ref").and_then(Value::as_str);
                let mut review =
                    git_review(&scope.workspace, &scope.home, review_scope, reference).await?;
                if request.get("summaryOnly").and_then(Value::as_bool) == Some(true) {
                    // token 和统计仍来自完整改动；后台摘要不通过 Host 帧传输 diff 或行级内容。
                    review["diff"] = json!("");
                    if let Some(files) = review["files"].as_array_mut() {
                        for file in files {
                            *file = json!({
                                "path": file["path"],
                                "additions": file["additions"],
                                "deletions": file["deletions"],
                                "binary": file["binary"],
                                "hunks": [],
                            });
                        }
                    }
                }
                Ok(review)
            }
            "gitState" => git_state(&scope.workspace, &scope.home).await,
            "gitStage" | "gitUnstage" | "gitCommit" | "gitPush" => {
                self.git_change(&scope.workspace, &scope.home, request)
                    .await
            }
            "turnReview" => turn_review(host, &scope, request).await,
            _ => Err(cmd_err("不支持的工作区操作")),
        }
    }

    async fn git_change(&self, workspace: &Path, home: &Path, request: &Value) -> Result<Value> {
        let top_out = run_git(
            workspace,
            &["rev-parse", "--show-toplevel"],
            GIT_TIMEOUT_READ,
        )
        .await
        .map_err(|_| cmd_err("当前目录不是 Git 仓库"))?;
        let top_raw = top_out.trim().to_owned();
        let top = tokio::task::spawn_blocking(move || std::fs::canonicalize(&top_raw))
            .await?
            .map_err(|e| cmd_err(format!("Git 仓库不可用：{e}")))?;

        if !self.busy_repos.borrow_mut().insert(top.clone()) {
            return Err(cmd_err("当前仓库正在执行 Git 操作，请稍后刷新"));
        }
        let _busy = BusyRepoGuard {
            repos: &self.busy_repos,
            path: top.clone(),
        };

        let state = git_state(&top, home).await?;
        let expected_token = required_str(request, "token")?;
        if Some(expected_token) != state["token"].as_str() {
            return Err(cmd_err("Git 状态已变化，请刷新后重试"));
        }
        let unmerged = run_git(&top, &["ls-files", "--unmerged"], GIT_TIMEOUT_READ).await?;
        if !unmerged.trim().is_empty() {
            return Err(cmd_err("存在未解决的合并冲突，请先处理后刷新"));
        }

        let op = required_str(request, "operation")?;
        let head = state["head"].as_str().unwrap_or("");
        let branch = state["branch"].as_str().unwrap_or("");

        match op {
            "gitStage" => {
                run_git_write(&top, &["add", "-A", "--", "."], false).await?;
                Ok(json!({ "applied": true }))
            }
            "gitUnstage" => {
                if !head.is_empty() {
                    run_git_write(&top, &["reset", "--quiet", "HEAD", "--", "."], false).await?;
                } else {
                    run_git_write(&top, &["read-tree", "--empty"], false).await?;
                }
                Ok(json!({ "applied": true }))
            }
            "gitCommit" => {
                let message = required_str(request, "message")?;
                let trimmed = message.trim();
                if trimmed.is_empty()
                    || message.encode_utf16().count() > 10000
                    || message.contains('\0')
                {
                    return Err(cmd_err("请输入有效的提交信息（最多10000字符）"));
                }
                let staged_empty = state["staged"]
                    .as_array()
                    .is_none_or(|items| items.is_empty());
                if staged_empty {
                    return Err(cmd_err("没有已暂存的改动"));
                }
                run_git_write(&top, &["commit", "-m", trimmed], false).await?;
                let new_head = run_git(&top, &["rev-parse", "HEAD"], GIT_TIMEOUT_READ)
                    .await?
                    .trim()
                    .to_owned();
                Ok(json!({ "applied": true, "head": new_head }))
            }
            "gitPush" => {
                if head.is_empty() || branch.is_empty() {
                    return Err(cmd_err("请先在分支上创建提交"));
                }
                let remote = required_str(request, "remote")?;
                let remote_known = state["remotes"]
                    .as_array()
                    .is_some_and(|list| list.iter().any(|item| item.as_str() == Some(remote)));
                if !remote_known {
                    return Err(cmd_err("请选择已配置的远程仓库"));
                }
                let destination = required_str(request, "targetBranch")?;
                if destination.is_empty()
                    || destination.encode_utf16().count() > 512
                    || destination.starts_with('-')
                {
                    return Err(cmd_err("请输入有效的目标分支"));
                }
                let ref_arg = format!("refs/heads/{destination}");
                run_git(&top, &["check-ref-format", &ref_arg], GIT_TIMEOUT_READ)
                    .await
                    .map_err(|_| cmd_err("请输入有效的目标分支"))?;
                let urls_raw = run_git(
                    &top,
                    &["remote", "get-url", "--push", "--all", remote],
                    GIT_TIMEOUT_READ,
                )
                .await?;
                let url_count = urls_raw
                    .trim()
                    .split('\n')
                    .filter(|s| !s.is_empty())
                    .count();
                if url_count != 1 {
                    return Err(cmd_err("此远程配置了多个推送地址，请先在 Git 中明确目标"));
                }
                let mirror_cfg = format!("remote.{remote}.mirror=false");
                let refspec = format!("{head}:refs/heads/{destination}");
                run_git_write(
                    &top,
                    &[
                        "-c",
                        &mirror_cfg,
                        "push",
                        "--porcelain",
                        "--no-force",
                        "--no-follow-tags",
                        "--no-recurse-submodules",
                        "--",
                        remote,
                        &refspec,
                    ],
                    true,
                )
                .await?;
                Ok(json!({
                    "applied": true,
                    "head": head,
                    "remote": remote,
                    "targetBranch": destination
                }))
            }
            _ => Err(cmd_err("不支持的 Git 操作")),
        }
    }
}

async fn local_directory_reference(raw: &str) -> Result<Value> {
    if raw.len() > 4096 || raw.contains('\0') || !Path::new(raw).is_absolute() {
        return Err(cmd_err("无效本机目录路径"));
    }
    let meta = tokio::fs::metadata(raw)
        .await
        .map_err(|_| cmd_err("找不到目标目录"))?;
    if !meta.is_dir() {
        return Err(cmd_err("引用路径不是目录"));
    }
    let name = Path::new(raw)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(raw);
    Ok(json!({
        "path": raw,
        "name": name,
        "type": "directory"
    }))
}

fn resolve_inside(root: &Path, rel: &str) -> Option<PathBuf> {
    if rel.contains('\0') {
        return None;
    }
    let real_root = std::fs::canonicalize(root).ok()?;
    let rel_clean = if rel.is_empty() { "." } else { rel };
    let candidate = real_root.join(rel_clean);
    let real = std::fs::canonicalize(candidate).ok()?;
    if real != real_root && !real.starts_with(&real_root) {
        return None;
    }
    Some(real)
}

fn resolve_file(root: &Path, relative: &str) -> Result<PathBuf> {
    if relative.is_empty() || relative.contains('\0') {
        return Err(cmd_err("未选择文件"));
    }
    let real_root = std::fs::canonicalize(root).map_err(|_| cmd_err("文件不在当前工作区内"))?;
    let candidate = real_root.join(relative);
    let real = std::fs::canonicalize(candidate).map_err(|_| cmd_err("文件不在当前工作区内"))?;
    if real == real_root || !real.starts_with(&real_root) {
        return Err(cmd_err("文件不在当前工作区内"));
    }
    let meta = std::fs::metadata(&real).map_err(|_| cmd_err("无法读取文件"))?;
    if !meta.is_file() || meta.len() > FILE_LIMIT as u64 {
        return Err(cmd_err("仅支持编辑 2 MB 以内的文本文件"));
    }
    Ok(real)
}

fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let mut ai = a.chars().peekable();
    let mut bi = b.chars().peekable();
    while ai.peek().is_some() && bi.peek().is_some() {
        let ac = *ai.peek().unwrap();
        let bc = *bi.peek().unwrap();
        if ac.is_ascii_digit() && bc.is_ascii_digit() {
            let mut an = String::new();
            while let Some(&c) = ai.peek() {
                if c.is_ascii_digit() {
                    an.push(c);
                    ai.next();
                } else {
                    break;
                }
            }
            let mut bn = String::new();
            while let Some(&c) = bi.peek() {
                if c.is_ascii_digit() {
                    bn.push(c);
                    bi.next();
                } else {
                    break;
                }
            }
            let at = an.trim_start_matches('0');
            let bt = bn.trim_start_matches('0');
            let ord = at
                .len()
                .cmp(&bt.len())
                .then_with(|| at.cmp(bt))
                .then_with(|| an.len().cmp(&bn.len()));
            if ord != std::cmp::Ordering::Equal {
                return ord;
            }
        } else {
            let al: String = ai.next().unwrap().to_lowercase().collect();
            let bl: String = bi.next().unwrap().to_lowercase().collect();
            let ord = al.cmp(&bl);
            if ord != std::cmp::Ordering::Equal {
                return ord;
            }
        }
    }
    ai.count().cmp(&bi.count()).then_with(|| a.cmp(b))
}

#[derive(Clone)]
struct DirRow {
    name: String,
    dir: bool,
    size: u64,
    hidden: bool,
}

type DirectoryListing = (String, Vec<DirRow>, bool, usize);

fn list_directory_rows(root: &Path, rel: &str, show_all: bool) -> Result<Option<DirectoryListing>> {
    let Some(dir) = resolve_inside(root, rel) else {
        return Ok(None);
    };
    let Ok(read_dir) = std::fs::read_dir(&dir) else {
        return Ok(None);
    };
    let mut visible = Vec::new();
    for entry in read_dir {
        let Ok(entry) = entry else { continue };
        let name_os = entry.file_name();
        let Some(name) = name_os.to_str().map(str::to_owned) else {
            continue;
        };
        if show_all {
            if name.starts_with(".DS_Store") {
                continue;
            }
        } else if NOISE_NAMES.contains(&name.as_str()) {
            continue;
        }
        visible.push((entry, name));
    }
    let total = visible.len();
    let truncated = total > LIST_MAX_ENTRIES;
    let mut rows = Vec::with_capacity(visible.len().min(LIST_MAX_ENTRIES));
    for (entry, name) in visible.into_iter().take(LIST_MAX_ENTRIES) {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let full = entry.path();
        let mut is_dir = file_type.is_dir();
        let mut size = 0u64;
        if file_type.is_symlink() {
            let full_str = full.to_string_lossy();
            if resolve_inside(root, &full_str).is_none() {
                continue;
            }
            let Ok(meta) = std::fs::metadata(&full) else {
                continue;
            };
            is_dir = meta.is_dir();
            size = meta.len();
        } else if !is_dir && let Ok(meta) = std::fs::metadata(&full) {
            size = meta.len();
        }
        rows.push(DirRow {
            hidden: name.starts_with('.'),
            name,
            dir: is_dir,
            size,
        });
    }
    rows.sort_by(|a, b| match (a.dir, b.dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => natural_cmp(&a.name, &b.name),
    });
    Ok(Some((rel.to_owned(), rows, truncated, total)))
}

fn list_directory(root: &Path, rel: &str, show_all: bool) -> Result<Option<Value>> {
    let Some((path, rows, truncated, total)) = list_directory_rows(root, rel, show_all)? else {
        return Ok(None);
    };
    let entries: Vec<Value> = rows
        .into_iter()
        .map(|row| {
            json!({
                "name": row.name,
                "dir": row.dir,
                "size": row.size,
                "hidden": row.hidden,
            })
        })
        .collect();
    Ok(Some(json!({
        "path": path,
        "entries": entries,
        "truncated": truncated,
        "total": total,
    })))
}

fn search_files(root: &Path, query: &str) -> Result<Value> {
    let trimmed = query.trim();
    if trimmed.is_empty() || query.chars().count() > 256 {
        return Err(cmd_err("无效文件搜索"));
    }
    let needle = trimmed.to_lowercase();
    let mut queue = VecDeque::from([String::new()]);
    let mut visited = BTreeSet::new();
    let mut entries = Vec::new();
    let mut truncated = false;
    while !queue.is_empty()
        && visited.len() < SEARCH_MAX_VISITED
        && entries.len() < SEARCH_MAX_ENTRIES
    {
        let rel = queue.pop_front().unwrap();
        let Some(real) = resolve_inside(root, &rel) else {
            continue;
        };
        if !visited.insert(real) {
            continue;
        }
        let Some((_, rows, dir_truncated, _)) = list_directory_rows(root, &rel, false)? else {
            continue;
        };
        truncated |= dir_truncated;
        for item in rows {
            let item_path = if rel.is_empty() {
                item.name.clone()
            } else {
                format!("{rel}/{}", item.name)
            };
            if item_path.to_lowercase().contains(&needle) {
                entries.push(json!({ "path": item_path, "dir": item.dir }));
            }
            if item.dir {
                queue.push_back(item_path);
            }
            if entries.len() >= SEARCH_MAX_ENTRIES {
                truncated = true;
                break;
            }
        }
    }
    Ok(json!({
        "entries": entries,
        "truncated": truncated || !queue.is_empty(),
    }))
}

fn read_text(root: &Path, relative: &str) -> Result<Value> {
    let file = resolve_file(root, relative)?;
    let bytes = std::fs::read(&file).map_err(|e| cmd_err(format!("读取文件失败：{e}")))?;
    if bytes.len() > FILE_LIMIT || bytes.contains(&0) {
        return Err(cmd_err("该文件不能作为文本编辑"));
    }
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| cmd_err("该文件不能作为文本编辑"))?
        .to_owned();
    Ok(json!({
        "path": relative,
        "text": text,
        "revision": sha256_hex(&bytes),
    }))
}

fn save_text(
    root: &Path,
    relative: &str,
    text: &str,
    expected_revision: &str,
    commit: &Mutex<()>,
) -> Result<Value> {
    if text.len() > FILE_LIMIT {
        return Err(cmd_err("文件内容过大"));
    }
    let file = resolve_file(root, relative)?;
    let bytes = std::fs::read(&file).map_err(|e| cmd_err(format!("读取文件失败：{e}")))?;
    if sha256_hex(&bytes) != expected_revision {
        return Ok(json!({
            "conflict": true,
            "error": "文件已在外部修改。请保留你的草稿并重新读取文件后处理冲突。"
        }));
    }
    let mode = std::fs::metadata(&file)?.permissions().mode() & 0o777;
    let parent = file.parent().context("missing file parent")?;
    let temporary = parent.join(format!(".areal-edit-{}", uuid::Uuid::new_v4()));
    let mut guard = TempFileGuard(Some(temporary.clone()));
    {
        let mut out = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(&temporary)?;
        out.write_all(text.as_bytes())?;
    }
    // 同一个 Host 的保存共享最终复核与替换；写临时文件仍可并行。
    let _commit = commit.lock().map_err(|_| cmd_err("无法完成文本保存"))?;
    let rechecked = resolve_file(root, relative)?;
    let latest_bytes = std::fs::read(&file).map_err(|e| cmd_err(format!("读取文件失败：{e}")))?;
    if rechecked != file || sha256_hex(&latest_bytes) != expected_revision {
        return Ok(json!({
            "conflict": true,
            "error": "文件已在外部修改，未覆盖；请重新读取并处理冲突。"
        }));
    }
    std::fs::rename(&temporary, &file)?;
    guard.defuse();
    Ok(json!({
        "revision": sha256_hex(text.as_bytes()),
        "saved": true,
    }))
}

struct GitOutput {
    status: std::process::ExitStatus,
    stdout: String,
    stderr: String,
}

async fn read_git_pipe(pipe: impl AsyncRead + Unpin, limit: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    pipe.take(limit as u64 + 1).read_to_end(&mut bytes).await?;
    ensure!(bytes.len() <= limit, cmd_err("Git 输出过大"));
    Ok(bytes)
}

async fn run_git_raw(root: &Path, args: &[&str], timeout: Duration) -> Result<GitOutput> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(root)
        .args(["-c", "core.quotePath=false"])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|e| cmd_err(format!("无法启动 Git：{e}")))?;
    let stdout = child.stdout.take().context("missing Git stdout")?;
    let stderr = child.stderr.take().context("missing Git stderr")?;
    let capture = async {
        tokio::try_join!(
            read_git_pipe(stdout, DIFF_LIMIT * 2),
            read_git_pipe(stderr, DIFF_LIMIT * 2),
            async { Ok(child.wait().await?) },
        )
    };
    let result = tokio::time::timeout(timeout, capture)
        .await
        .map_err(|_| cmd_err("Git 操作超时"))
        .and_then(|output| output);
    if result.is_err() {
        let _ = child.kill().await;
    }
    let (stdout, stderr, status) = result?;
    Ok(GitOutput {
        status,
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}

async fn run_git(root: &Path, args: &[&str], timeout: Duration) -> Result<String> {
    let out = run_git_raw(root, args, timeout).await?;
    if !out.status.success() {
        let msg = out.stderr.trim();
        let detail = if msg.is_empty() {
            format!("Git 命令失败（{}）", out.status)
        } else {
            msg.to_owned()
        };
        return Err(cmd_err(detail));
    }
    Ok(out.stdout)
}

async fn run_git_write(root: &Path, args: &[&str], is_push: bool) -> Result<String> {
    let out = match run_git_raw(root, args, GIT_TIMEOUT_WRITE).await {
        Ok(out) => out,
        Err(_) => {
            if is_push {
                return Err(cmd_err(
                    "推送结果未能确认。请核对远程分支、连接和权限后刷新；不会自动重试。",
                ));
            }
            return Err(cmd_err(
                "Git 操作未完成或结果未能确认。请检查提交身份、签名、仓库钩子或锁，再刷新状态；不会自动重试。",
            ));
        }
    };
    if out.status.success() {
        return Ok(out.stdout);
    }
    if is_push {
        let combined = format!("{}{}", out.stderr, out.stdout).to_lowercase();
        if combined.contains("non-fast-forward")
            || combined.contains("fetch first")
            || combined.contains("[rejected]")
        {
            return Err(cmd_err(
                "推送被拒绝：远程分支包含其他提交。请先在 Git 中合并后刷新，不会自动强推。",
            ));
        }
        return Err(cmd_err(
            "推送结果未能确认。请核对远程分支、连接和权限后刷新；不会自动重试。",
        ));
    }
    Err(cmd_err(
        "Git 操作未完成或结果未能确认。请检查提交身份、签名、仓库钩子或锁，再刷新状态；不会自动重试。",
    ))
}

async fn rev_parse_head_optional(top: &Path) -> Result<String> {
    let out = run_git_raw(top, &["rev-parse", "--verify", "HEAD"], GIT_TIMEOUT_READ).await?;
    if out.status.success() {
        return Ok(out.stdout.trim().to_owned());
    }
    let sym = run_git_raw(top, &["symbolic-ref", "--quiet", "HEAD"], GIT_TIMEOUT_READ).await?;
    let lower = out.stderr.to_lowercase();
    if sym.status.success()
        || lower.contains("unknown revision")
        || lower.contains("needed a single revision")
        || lower.contains("not a valid")
    {
        return Ok(String::new());
    }
    Err(cmd_err(out.stderr.trim().to_owned()))
}

fn worktree_metadata(top: &Path, home: &Path) -> Option<Value> {
    let real_top = std::fs::canonicalize(top).ok()?;
    // 过渡：到 0.2.0 删；迁移前的 worktree 元数据由原目录读取。
    let metadata_path = home.join("worktrees").join(format!(
        "{}.json",
        sha256_hex(real_top.to_string_lossy().as_bytes())
    ));
    if let Ok(Some(record)) = storage::read_optional::<Value>(&metadata_path)
        && record.is_object()
    {
        return Some(record);
    }
    let ops = worktree_catalog::operations(home).ok()?;
    for op in ops {
        if op["deleted"] == true {
            continue;
        }
        let Some(dir) = op["record"]["directory"].as_str() else {
            continue;
        };
        let Ok(real_dir) = std::fs::canonicalize(dir) else {
            continue;
        };
        if real_dir != real_top {
            continue;
        }
        if op["record"]["target"]
            .as_str()
            .is_some_and(|target| Path::new(target).exists())
        {
            return Some(op["record"].clone());
        }
    }
    None
}

async fn file_status(workspace: &Path) -> Result<Value> {
    let directory = tokio::task::spawn_blocking({
        let ws = workspace.to_path_buf();
        move || std::fs::canonicalize(&ws)
    })
    .await??;
    let Ok(top_raw) = run_git(
        &directory,
        &["rev-parse", "--show-toplevel"],
        GIT_TIMEOUT_READ,
    )
    .await
    else {
        return Ok(json!({ "available": false, "entries": [] }));
    };
    let top = PathBuf::from(top_raw.trim());
    let output = run_git(
        &top,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        GIT_TIMEOUT_READ,
    )
    .await?;
    let records: Vec<&str> = output.split('\0').collect();
    let mut entries = Vec::new();
    let mut index = 0usize;
    while index < records.len() {
        let record = records[index];
        index += 1;
        if record.len() < 4 {
            continue;
        }
        let xy = &record[..2];
        let name = &record[3..];
        if xy.contains('R') || xy.contains('C') {
            index += 1;
        }
        let resolved = top.join(name);
        let rel = if let Ok(stripped) = resolved.strip_prefix(&directory) {
            stripped
        } else {
            continue;
        };
        if rel.as_os_str().is_empty() || rel.components().any(|c| matches!(c, Component::ParentDir))
        {
            continue;
        }
        let status = if xy == "??" {
            "U"
        } else if xy.contains('U') || xy == "AA" || xy == "DD" {
            "C"
        } else if xy.contains('D') {
            "D"
        } else if xy.contains('R') {
            "R"
        } else if xy.contains('A') {
            "A"
        } else {
            "M"
        };
        let path_str: String = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
        entries.push(json!({ "path": path_str, "status": status }));
    }
    Ok(json!({ "available": true, "entries": entries }))
}

async fn workspace_info(workspace: &Path, home: &Path) -> Result<Value> {
    let directory = tokio::task::spawn_blocking({
        let ws = workspace.to_path_buf();
        move || std::fs::canonicalize(&ws)
    })
    .await??;
    let top_res = run_git_raw(
        &directory,
        &["rev-parse", "--show-toplevel"],
        GIT_TIMEOUT_READ,
    )
    .await?;
    if !top_res.status.success() {
        let lower = top_res.stderr.to_lowercase();
        if lower.contains("not a git repository") {
            let dir_str = directory.to_string_lossy();
            return Ok(json!({ "directory": dir_str, "root": dir_str, "git": false }));
        }
        return Err(cmd_err(top_res.stderr.trim().to_owned()));
    }
    let top = PathBuf::from(top_res.stdout.trim());
    let record = worktree_metadata(&top, home);
    let branch_raw = run_git(&top, &["branch", "--show-current"], GIT_TIMEOUT_READ).await?;
    let branch = branch_raw.trim();
    let branch = if branch.is_empty() {
        "(detached)"
    } else {
        branch
    };
    let head = rev_parse_head_optional(&top).await?;
    let status = run_git(&top, &["status", "--porcelain"], GIT_TIMEOUT_READ).await?;
    let mut result = json!({
        "directory": directory.to_string_lossy(),
        "root": top.to_string_lossy(),
        "branch": branch,
        "head": head,
        "dirty": !status.is_empty(),
    });
    if let Some(record) = record {
        for key in ["target", "base", "source", "sourceRef", "createdAt"] {
            if let Some(value) = record.get(key)
                && !value.is_null()
            {
                result[key] = value.clone();
            }
        }
    }
    Ok(result)
}

async fn review_commits(workspace: &Path) -> Result<Value> {
    let top_raw = run_git(
        workspace,
        &["rev-parse", "--show-toplevel"],
        GIT_TIMEOUT_READ,
    )
    .await?;
    let top = PathBuf::from(top_raw.trim());
    let head = rev_parse_head_optional(&top).await?;
    if head.is_empty() {
        return Ok(json!({ "head": "", "commits": [], "truncated": false }));
    }
    let log_out = run_git(
        &top,
        &["log", "-z", "-101", "--format=%H%x00%s%x00%ct", &head, "--"],
        GIT_TIMEOUT_FAST,
    )
    .await?;
    let mut fields: Vec<&str> = log_out.split('\0').collect();
    if fields.last() == Some(&"") {
        fields.pop();
    }
    let mut commits = Vec::new();
    for chunk in fields.chunks(3) {
        if chunk.len() < 3 {
            break;
        }
        let id = chunk[0];
        let subject = chunk[1];
        let committed_at: i64 = chunk[2].parse().map_err(|_| cmd_err("提交历史格式无效"))?;
        if !is_git_oid(id) {
            return Err(cmd_err("提交历史格式无效"));
        }
        commits.push(json!({
            "id": id,
            "subject": subject,
            "committedAt": committed_at,
        }));
    }
    let truncated = commits.len() > 100;
    commits.truncate(100);
    Ok(json!({
        "head": head,
        "commits": commits,
        "truncated": truncated,
    }))
}

async fn review_branches(workspace: &Path) -> Result<Value> {
    let top_raw = run_git(
        workspace,
        &["rev-parse", "--show-toplevel"],
        GIT_TIMEOUT_READ,
    )
    .await?;
    let top = PathBuf::from(top_raw.trim());
    let rows = run_git(
        &top,
        &[
            "for-each-ref",
            "--sort=refname",
            "--format=%(refname)%00%(refname:short)%00%(objectname)%00%(symref)",
            "refs/heads/",
            "refs/remotes/",
        ],
        GIT_TIMEOUT_FAST,
    )
    .await?;
    let mut branches = Vec::new();
    for row in rows.split('\n').filter(|line| !line.is_empty()) {
        let mut parts = row.split('\0');
        let ref_name = parts.next().unwrap_or("");
        let short_name = parts.next().unwrap_or("");
        let oid = parts.next().unwrap_or("");
        let symbolic = parts.next().unwrap_or("");
        if !is_git_oid(oid) || short_name.is_empty() || ref_name.is_empty() {
            return Err(cmd_err("分支列表格式无效"));
        }
        if symbolic.is_empty() {
            branches.push(json!({
                "ref": ref_name,
                "name": short_name,
                "id": oid,
            }));
        }
    }
    Ok(json!({ "branches": branches }))
}

struct ParsedHunk {
    old_start: u64,
    old_lines: u64,
    new_start: u64,
    new_lines: u64,
    lines: Vec<Value>,
}

struct ParsedDiffFile {
    path: String,
    additions: u64,
    deletions: u64,
    hunks: Vec<ParsedHunk>,
}

fn parse_hunk_range(value: &str) -> Result<(u64, u64)> {
    let (start, count) = value.split_once(',').unwrap_or((value, "1"));
    Ok((start.parse()?, count.parse()?))
}

fn parse_git_diff_path_pair(header: &str) -> String {
    // Handles `diff --git a/path b/path` (unquoted due to core.quotePath=false).
    let rest = header.strip_prefix("diff --git ").unwrap_or(header).trim();
    if let Some(pos) = rest.rfind(" b/") {
        return rest[pos + 3..].to_owned();
    }
    rest.strip_prefix("a/").unwrap_or(rest).to_owned()
}

fn parse_git_patch(diff: &str, paths: Option<&[String]>) -> Result<Vec<Value>> {
    let mut files: Vec<ParsedDiffFile> = Vec::new();
    let mut old_name = String::new();
    let mut new_name = String::new();
    let mut current: Option<ParsedDiffFile> = None;
    let mut in_hunk = false;
    let mut old_line = 0u64;
    let mut new_line = 0u64;
    let mut old_rem = 0u64;
    let mut new_rem = 0u64;

    let flush = |files: &mut Vec<ParsedDiffFile>,
                 current: &mut Option<ParsedDiffFile>,
                 old_name: &mut String,
                 new_name: &mut String| {
        if let Some(mut file) = current.take() {
            if file.path.is_empty() {
                file.path = if new_name == "/dev/null" {
                    old_name.clone()
                } else {
                    new_name.clone()
                };
            }
            files.push(file);
        }
        old_name.clear();
        new_name.clear();
    };

    for line in diff.split_terminator('\n') {
        if line.starts_with("diff --git ") {
            flush(&mut files, &mut current, &mut old_name, &mut new_name);
            in_hunk = false;
            old_rem = 0;
            new_rem = 0;
            current = Some(ParsedDiffFile {
                path: parse_git_diff_path_pair(line),
                additions: 0,
                deletions: 0,
                hunks: Vec::new(),
            });
            continue;
        }
        if !in_hunk && let Some(header) = line.strip_prefix("@@ -") {
            let Some(file) = current.as_mut() else {
                continue;
            };
            let (old, rest) = header.split_once(" +").context("invalid diff hunk")?;
            let (new, _) = rest.split_once(" @@").context("invalid diff hunk")?;
            let (old_start, old_lines) = parse_hunk_range(old)?;
            let (new_start, new_lines) = parse_hunk_range(new)?;
            old_line = old_start;
            new_line = new_start;
            old_rem = old_lines;
            new_rem = new_lines;
            in_hunk = true;
            file.hunks.push(ParsedHunk {
                old_start,
                old_lines,
                new_start,
                new_lines,
                lines: Vec::new(),
            });
            continue;
        }
        if in_hunk && let Some(file) = current.as_mut() {
            if let Some(header) = line.strip_prefix("@@ -") {
                let (old, rest) = header.split_once(" +").context("invalid diff hunk")?;
                let (new, _) = rest.split_once(" @@").context("invalid diff hunk")?;
                let (old_start, old_lines) = parse_hunk_range(old)?;
                let (new_start, new_lines) = parse_hunk_range(new)?;
                old_line = old_start;
                new_line = new_start;
                old_rem = old_lines;
                new_rem = new_lines;
                file.hunks.push(ParsedHunk {
                    old_start,
                    old_lines,
                    new_start,
                    new_lines,
                    lines: Vec::new(),
                });
                continue;
            }
            if let Some(hunk) = file.hunks.last_mut()
                && (old_rem > 0 || new_rem > 0 || line.starts_with('\\'))
            {
                match line.as_bytes().first() {
                    Some(b'+') if new_rem > 0 => {
                        file.additions += 1;
                        new_rem -= 1;
                        let ln = new_line;
                        new_line += 1;
                        hunk.lines.push(json!({
                            "kind": "add",
                            "text": &line[1..],
                            "oldLine": Value::Null,
                            "newLine": ln,
                        }));
                        continue;
                    }
                    Some(b'-') if old_rem > 0 => {
                        file.deletions += 1;
                        old_rem -= 1;
                        let ln = old_line;
                        old_line += 1;
                        hunk.lines.push(json!({
                            "kind": "del",
                            "text": &line[1..],
                            "oldLine": ln,
                            "newLine": Value::Null,
                        }));
                        continue;
                    }
                    Some(b' ') if old_rem > 0 && new_rem > 0 => {
                        old_rem -= 1;
                        new_rem -= 1;
                        let ol = old_line;
                        let nl = new_line;
                        old_line += 1;
                        new_line += 1;
                        hunk.lines.push(json!({
                            "kind": "context",
                            "text": &line[1..],
                            "oldLine": ol,
                            "newLine": nl,
                        }));
                        continue;
                    }
                    Some(b'\\') => {
                        hunk.lines.push(json!({
                            "kind": "meta",
                            "text": &line[1..],
                            "oldLine": Value::Null,
                            "newLine": Value::Null,
                        }));
                        continue;
                    }
                    _ => {}
                }
            }
            in_hunk = false;
        }
        if current.is_none() && (line.starts_with("--- ") || line.starts_with("Index: ")) {
            current = Some(ParsedDiffFile {
                path: String::new(),
                additions: 0,
                deletions: 0,
                hunks: Vec::new(),
            });
        }
        if let Some(p) = line.strip_prefix("--- ") {
            old_name = p.trim().strip_prefix("a/").unwrap_or(p.trim()).to_owned();
        } else if let Some(p) = line.strip_prefix("+++ ") {
            new_name = p.trim().strip_prefix("b/").unwrap_or(p.trim()).to_owned();
        }
    }
    flush(&mut files, &mut current, &mut old_name, &mut new_name);

    if let Some(paths) = paths
        && files.len() != paths.len()
    {
        return Err(cmd_err("审查期间文件列表已变化，请刷新"));
    }

    Ok(files
        .into_iter()
        .enumerate()
        .map(|(index, file)| {
            let file_path = paths
                .and_then(|list| list.get(index))
                .cloned()
                .unwrap_or(file.path);
            let binary = file.hunks.is_empty();
            let hunks: Vec<Value> = file
                .hunks
                .into_iter()
                .map(|h| {
                    json!({
                        "oldStart": h.old_start,
                        "oldLines": h.old_lines,
                        "newStart": h.new_start,
                        "newLines": h.new_lines,
                        "lines": h.lines,
                    })
                })
                .collect();
            json!({
                "path": file_path,
                "additions": file.additions,
                "deletions": file.deletions,
                "hunks": hunks,
                "binary": binary,
            })
        })
        .collect())
}

async fn git_review(
    workspace: &Path,
    home: &Path,
    scope: &str,
    ref_opt: Option<&str>,
) -> Result<Value> {
    if !matches!(
        scope,
        "task" | "uncommitted" | "unstaged" | "staged" | "branch" | "commit"
    ) {
        return Err(cmd_err("不支持的审查范围"));
    }
    let top_raw = run_git(
        workspace,
        &["rev-parse", "--show-toplevel"],
        GIT_TIMEOUT_READ,
    )
    .await?;
    let top = PathBuf::from(top_raw.trim());
    let record = worktree_metadata(&top, home);
    let head = rev_parse_head_optional(&top).await?;
    let status = run_git(&top, &["status", "--porcelain"], GIT_TIMEOUT_READ).await?;

    let mut base = if scope != "uncommitted" {
        record
            .as_ref()
            .and_then(|r| r.get("base").and_then(Value::as_str))
            .map(str::to_owned)
    } else {
        None
    };
    if base.is_none() {
        base = if !head.is_empty() {
            Some(head.clone())
        } else {
            Some(
                run_git(
                    &top,
                    &["hash-object", "-t", "tree", "/dev/null"],
                    GIT_TIMEOUT_READ,
                )
                .await?
                .trim()
                .to_owned(),
            )
        };
    }
    let mut base = base.unwrap_or_default();
    let mut reference: Option<Value> = None;

    if scope == "branch" || scope == "commit" {
        let user_ref = ref_opt
            .map(str::trim)
            .filter(|s| !s.is_empty() && ref_opt.unwrap_or("").encode_utf16().count() <= 512)
            .ok_or_else(|| cmd_err("请选择基准分支或提交"))?;
        let user_ref_raw = ref_opt.unwrap();
        let target_spec = format!("{user_ref_raw}^{{commit}}");
        let resolved_ref = run_git(
            &top,
            &["rev-parse", "--verify", "--end-of-options", &target_spec],
            GIT_TIMEOUT_READ,
        )
        .await?
        .trim()
        .to_owned();
        if scope == "branch" {
            if head.is_empty() {
                return Err(cmd_err("当前分支尚无提交"));
            }
            base = run_git(
                &top,
                &["merge-base", &head, &resolved_ref],
                GIT_TIMEOUT_READ,
            )
            .await?
            .trim()
            .to_owned();
        } else {
            base = resolved_ref.clone();
        }
        let label = if scope == "commit" {
            run_git(
                &top,
                &["log", "-1", "--format=%s", &resolved_ref, "--"],
                GIT_TIMEOUT_READ,
            )
            .await?
            .trim()
            .to_owned()
        } else {
            run_git(
                &top,
                &[
                    "rev-parse",
                    "--verify",
                    "--abbrev-ref",
                    "--symbolic-full-name",
                    "--end-of-options",
                    user_ref,
                ],
                GIT_TIMEOUT_READ,
            )
            .await?
            .trim()
            .to_owned()
        };
        let label_final = if label.is_empty() {
            resolved_ref.chars().take(7).collect()
        } else {
            label
        };
        reference = Some(json!({ "id": resolved_ref, "label": label_final }));
    }

    let range_args: Vec<&str> = match scope {
        "staged" => vec!["--cached"],
        "unstaged" => vec![],
        "branch" => vec![&base, &head],
        _ => vec![&base],
    };
    let mut diff_args: Vec<&str> = if scope == "commit" {
        vec![
            "show",
            "--format=",
            "--diff-merges=first-parent",
            "--no-ext-diff",
            "--no-textconv",
            "--binary",
            &base,
            "--",
        ]
    } else {
        let mut v = vec!["diff", "--no-ext-diff", "--no-textconv", "--binary"];
        v.extend_from_slice(&range_args);
        v.push("--");
        v
    };
    let mut diff = run_git(&top, &diff_args, GIT_TIMEOUT_READ).await?;

    let names_raw = if scope == "commit" {
        run_git(
            &top,
            &[
                "show",
                "--format=",
                "--diff-merges=first-parent",
                "--name-only",
                "-z",
                &base,
                "--",
            ],
            GIT_TIMEOUT_READ,
        )
        .await?
    } else {
        diff_args.clear();
        diff_args.extend(["diff", "--name-only", "-z"]);
        diff_args.extend_from_slice(&range_args);
        diff_args.push("--");
        run_git(&top, &diff_args, GIT_TIMEOUT_READ).await?
    };
    let mut paths: Vec<String> = names_raw
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();

    if matches!(scope, "task" | "uncommitted" | "unstaged") {
        let untracked_raw = run_git(
            &top,
            &["ls-files", "--others", "--exclude-standard", "-z"],
            GIT_TIMEOUT_READ,
        )
        .await?;
        for file in untracked_raw.split('\0').filter(|s| !s.is_empty()) {
            let out = run_git_raw(
                &top,
                &[
                    "diff",
                    "--no-index",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--binary",
                    "--",
                    "/dev/null",
                    file,
                ],
                GIT_TIMEOUT_READ,
            )
            .await?;
            let added = if out.status.success() || out.status.code() == Some(1) {
                out.stdout
            } else {
                return Err(cmd_err(out.stderr.trim().to_owned()));
            };
            diff.push_str(&added);
            if diff.len() > DIFF_LIMIT {
                return Err(cmd_err("改动过大，请缩小任务范围后审查"));
            }
            paths.push(file.to_owned());
        }
    }

    let mut target_head: Option<String> = None;
    let mut target_status = String::new();
    let mut conflicts: Vec<String> = Vec::new();
    if let Some(rec) = &record
        && let Some(target_str) = rec.get("target").and_then(Value::as_str)
    {
        let target_path = Path::new(target_str);
        target_head = Some(
            run_git(target_path, &["rev-parse", "HEAD"], GIT_TIMEOUT_READ)
                .await?
                .trim()
                .to_owned(),
        );
        target_status = run_git(target_path, &["status", "--porcelain"], GIT_TIMEOUT_READ).await?;
        let conflicts_raw = run_git(
            target_path,
            &["diff", "--name-only", "--diff-filter=U", "-z"],
            GIT_TIMEOUT_READ,
        )
        .await?;
        conflicts = conflicts_raw
            .split('\0')
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect();
    }

    let files = parse_git_patch(&diff, Some(&paths))?;
    let branch_raw = run_git(&top, &["branch", "--show-current"], GIT_TIMEOUT_READ).await?;
    let branch_trimmed = branch_raw.trim();
    let branch = if branch_trimmed.is_empty() {
        "(detached)"
    } else {
        branch_trimmed
    };
    let token_payload = serde_json::to_vec(&json!({
        "head": head,
        "status": status,
        "diff": diff,
        "targetHead": target_head,
        "targetStatus": target_status,
        "scope": scope,
        "base": base,
    }))?;
    let target_val = record
        .as_ref()
        .and_then(|r| r.get("target"))
        .cloned()
        .unwrap_or(Value::Null);
    let mut res = json!({
        "head": head,
        "base": base,
        "diff": diff,
        "files": files,
        "scope": scope,
        "root": top.to_string_lossy(),
        "dirty": !status.is_empty(),
        "target": target_val,
        "branch": branch,
        "targetDirty": !target_status.is_empty(),
        "conflicts": conflicts,
        "token": sha256_hex(&token_payload),
    });
    if let Some(reference) = reference {
        res["reference"] = reference;
    }
    Ok(res)
}

async fn git_state(workspace: &Path, home: &Path) -> Result<Value> {
    let staged = git_review(workspace, home, "staged", None).await?;
    let unstaged = git_review(workspace, home, "unstaged", None).await?;
    if staged["head"] != unstaged["head"] || staged["branch"] != unstaged["branch"] {
        return Err(cmd_err("Git 状态已变化，请刷新后重试"));
    }
    let top = PathBuf::from(staged["root"].as_str().context("INVALID_RESPONSE")?);
    let remotes_raw = run_git(&top, &["remote"], GIT_TIMEOUT_READ).await?;
    let remotes: Vec<String> = remotes_raw
        .split('\n')
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    let mut destinations = Vec::with_capacity(remotes.len());
    for name in &remotes {
        let urls = run_git(
            &top,
            &["remote", "get-url", "--push", "--all", name],
            GIT_TIMEOUT_READ,
        )
        .await?;
        destinations.push(json!([name, urls]));
    }
    let branch_str = staged["branch"].as_str().unwrap_or("");
    let staged_paths: Vec<String> = staged["files"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|f| f["path"].as_str().map(str::to_owned))
        .collect();
    let unstaged_paths: Vec<String> = unstaged["files"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|f| f["path"].as_str().map(str::to_owned))
        .collect();
    let token_payload = serde_json::to_vec(&json!({
        "staged": staged["token"],
        "unstaged": unstaged["token"],
        "branch": branch_str,
        "destinations": destinations,
    }))?;
    Ok(json!({
        "root": staged["root"],
        "head": staged["head"],
        "branch": if branch_str == "(detached)" { "" } else { branch_str },
        "staged": staged_paths,
        "unstaged": unstaged_paths,
        "remotes": remotes,
        "token": sha256_hex(&token_payload),
    }))
}

fn persisted_existing_lock(path: &Path) -> Result<std::fs::File> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file()
            && metadata.uid() == unsafe { libc::geteuid() }
            && metadata.mode() & 0o022 == 0,
        "PERSISTED_HISTORY_UNAVAILABLE"
    );
    file.try_lock_exclusive()
        .map_err(|_| anyhow!("RESOURCE_BUSY"))?;
    Ok(file)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InheritedHistoryPage {
    snapshot_id: String,
    data: Option<Vec<Value>>,
    complete: bool,
    next_cursor: Option<String>,
}

enum PersistedTurnLookup {
    Found {
        turn: Value,
        file_befores: BTreeMap<String, Vec<u8>>,
    },
    TurnMissingNonFork,
    FallbackToLive,
}

fn is_verified_runtime_write_tool(tool: &str) -> bool {
    matches!(
        tool,
        "fs_create" | "fs_write" | "fs_apply_patch" | "fs_apply_patches"
    )
}

fn validate_file_before_ref(reference: &Value) -> Result<(String, usize)> {
    let obj = reference
        .as_object()
        .ok_or_else(|| cmd_err("历史文件前像引用无效"))?;
    let uri = obj
        .get("uri")
        .and_then(Value::as_str)
        .ok_or_else(|| cmd_err("历史文件前像引用无效"))?;
    let digest = uri
        .strip_prefix("areal://blob/")
        .filter(|d| is_sha256_hex(d))
        .ok_or_else(|| cmd_err("历史文件前像引用无效"))?;
    if obj.get("mimeType").and_then(Value::as_str) != Some("application/octet-stream") {
        return Err(cmd_err("历史文件前像引用无效"));
    }
    let size = obj
        .get("sizeBytes")
        .and_then(Value::as_u64)
        .filter(|n| *n <= BLOB_LIMIT as u64)
        .ok_or_else(|| cmd_err("历史文件前像引用无效"))? as usize;
    Ok((digest.to_owned(), size))
}

fn check_no_deferred_tool_calls(turn: &Value, item_id: Option<&str>) -> Result<()> {
    let deferred = turn["items"].as_array().is_some_and(|items| {
        items.iter().any(|item| {
            item_id.is_none_or(|id| item["id"].as_str() == Some(id))
                && item["type"] == "historyDeferred"
                && item["originalType"] == "dynamicToolCall"
        })
    });
    if deferred {
        return Err(cmd_err("请先加载本轮的完整工具内容，再查看文件变更。"));
    }
    Ok(())
}

fn needed_file_before_items(turn: &Value, item_id: Option<&str>) -> Result<Vec<(String, Value)>> {
    let mut out = Vec::new();
    for item in turn["items"].as_array().into_iter().flatten() {
        let Some(id) = item["id"].as_str() else {
            continue;
        };
        if item_id.is_some_and(|selected| selected != id) {
            continue;
        }
        let tool = item["tool"].as_str().unwrap_or("");
        if item["type"] == "dynamicToolCall"
            && is_verified_runtime_write_tool(tool)
            && item["status"] == "completed"
            && item["success"] == true
            && item["execution"]["backend"] == "runtime"
            && item["execution"]["outcome"] == "succeeded"
            && let Some(reference) = item["execution"].get("fileBefore")
        {
            let _ = validate_file_before_ref(reference)?;
            out.push((id.to_owned(), reference.clone()));
        }
    }
    Ok(out)
}

async fn read_persisted_turn_for_review(
    host: &Host,
    canonical_id: &str,
    thread_id: &str,
    turn_id: &str,
    item_id: Option<&str>,
) -> Result<PersistedTurnLookup> {
    let Ok(gate) = host.gate(canonical_id) else {
        return Ok(PersistedTurnLookup::FallbackToLive);
    };
    let _guard = gate.read().await;
    if host
        .migration
        .unpublished_reserved(canonical_id)
        .unwrap_or(true)
    {
        return Ok(PersistedTurnLookup::FallbackToLive);
    }
    let Some(registration) = host
        .slots
        .borrow()
        .get(canonical_id)
        .map(|slot| slot.registration.clone())
    else {
        return Ok(PersistedTurnLookup::FallbackToLive);
    };
    let home = host.home.clone();
    let tid = thread_id.to_owned();
    let turn_key = turn_id.to_owned();
    let item_key = item_id.map(str::to_owned);
    tokio::task::spawn_blocking(move || -> Result<PersistedTurnLookup> {
        let Ok(directory) = storage::registry(&home, &Host::service_id(&registration)) else {
            return Ok(PersistedTurnLookup::FallbackToLive);
        };
        let Ok(_startup) = persisted_existing_lock(&directory.join("start.lock")) else {
            return Ok(PersistedTurnLookup::FallbackToLive);
        };
        let Ok(_service_lock) =
            persisted_existing_lock(&registration.data_dir.join("service.lock"))
        else {
            return Ok(PersistedTurnLookup::FallbackToLive);
        };
        let Ok(_owner_lock) = persisted_existing_lock(&registration.data_dir.join("owner.lock"))
        else {
            return Ok(PersistedTurnLookup::FallbackToLive);
        };
        let Ok(service) =
            storage::read::<areal_protocol::service::Service>(&directory.join("service.json"))
        else {
            return Ok(PersistedTurnLookup::FallbackToLive);
        };
        let Ok(sw) = storage::read::<PathBuf>(&registration.data_dir.join("service-workspace"))
        else {
            return Ok(PersistedTurnLookup::FallbackToLive);
        };
        if service.identity.protocol_version != 1
            || service.identity.service_id != Host::service_id(&registration)
            || service.identity.data_dir != registration.data_dir
            || service.identity.workspace != registration.workspace
            || sw != registration.workspace
        {
            return Ok(PersistedTurnLookup::FallbackToLive);
        }
        let Ok(snapshot) = areal_engine::PersistedConversation::read(
            &registration.data_dir,
            &registration.workspace,
            &tid,
        ) else {
            return Ok(PersistedTurnLookup::FallbackToLive);
        };
        let thread_json = serde_json::to_value(snapshot.thread())?;
        let found_turn = thread_json["turns"]
            .as_array()
            .and_then(|turns| turns.iter().find(|t| t["id"] == turn_key))
            .cloned();
        let outcome = match found_turn {
            Some(turn) => {
                check_no_deferred_tool_calls(&turn, item_key.as_deref())?;
                let mut file_befores = BTreeMap::new();
                for (item_id_key, reference) in
                    needed_file_before_items(&turn, item_key.as_deref())?
                {
                    let (digest, expected_size) = validate_file_before_ref(&reference)?;
                    let uri = reference["uri"].as_str().unwrap();
                    let Ok(bytes) = snapshot.blob(&registration.data_dir, uri) else {
                        return Err(cmd_err("历史文件前像与记录的大小或哈希不一致"));
                    };
                    if bytes.len() != expected_size || sha256_hex(&bytes) != digest {
                        return Err(cmd_err("历史文件前像与记录的大小或哈希不一致"));
                    }
                    file_befores.insert(item_id_key, bytes);
                }
                PersistedTurnLookup::Found { turn, file_befores }
            }
            None => {
                if thread_json["conversation"]["kind"] == "fork" {
                    PersistedTurnLookup::FallbackToLive
                } else {
                    PersistedTurnLookup::TurnMissingNonFork
                }
            }
        };
        let Ok(latest_service) =
            storage::read::<areal_protocol::service::Service>(&directory.join("service.json"))
        else {
            return Ok(PersistedTurnLookup::FallbackToLive);
        };
        if serde_json::to_value(&latest_service)? != serde_json::to_value(&service)? {
            return Ok(PersistedTurnLookup::FallbackToLive);
        }
        for (path, file) in [
            (directory.join("start.lock"), &_startup),
            (registration.data_dir.join("service.lock"), &_service_lock),
            (registration.data_dir.join("owner.lock"), &_owner_lock),
        ] {
            let held = file.metadata()?;
            let Ok(named) = std::fs::symlink_metadata(path) else {
                return Ok(PersistedTurnLookup::FallbackToLive);
            };
            if !named.is_file() || named.dev() != held.dev() || named.ino() != held.ino() {
                return Ok(PersistedTurnLookup::FallbackToLive);
            }
        }
        Ok(outcome)
    })
    .await?
}

fn apply_recorded_patches(before: &str, patches: &[Value]) -> Result<String> {
    if patches.is_empty() || patches.len() > 32 {
        return Err(cmd_err("本轮补丁无法按公开记录重建，请使用工作区审查"));
    }
    let mut text = before.to_owned();
    for patch in patches {
        let Some(old) = patch.get("oldText").and_then(Value::as_str) else {
            return Err(cmd_err("本轮补丁无法按公开记录重建，请使用工作区审查"));
        };
        let Some(new) = patch.get("newText").and_then(Value::as_str) else {
            return Err(cmd_err("本轮补丁无法按公开记录重建，请使用工作区审查"));
        };
        if old.is_empty() {
            return Err(cmd_err("本轮补丁无法按公开记录重建，请使用工作区审查"));
        }
        let Some(first) = text.find(old) else {
            return Err(cmd_err("本轮补丁无法按公开记录重建，请使用工作区审查"));
        };
        if text.rfind(old) != Some(first) {
            return Err(cmd_err("本轮补丁无法按公开记录重建，请使用工作区审查"));
        }
        let mut next = String::with_capacity(text.len() - old.len() + new.len());
        next.push_str(&text[..first]);
        next.push_str(new);
        next.push_str(&text[first + old.len()..]);
        text = next;
    }
    Ok(text)
}

#[derive(Clone)]
struct TextVersion {
    text: String,
    hash: String,
}

#[derive(Clone)]
struct ChangedVersion {
    before: String,
    after: String,
}

type ReconstructedTurnChanges = (Vec<(String, ChangedVersion)>, Vec<Value>);

fn reconstruct_turn_changes(
    turn: &Value,
    item_id: Option<&str>,
    file_befores: &BTreeMap<String, Vec<u8>>,
    allow_partial: bool,
) -> Result<ReconstructedTurnChanges> {
    if turn["status"] != "completed" {
        return Err(cmd_err("本轮尚未完成，无法比较文件版本"));
    }
    let all_items = turn["items"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let mut selected_items: Vec<&Value> = all_items.iter().collect();
    if let Some(target_id) = item_id {
        if target_id.is_empty() {
            return Err(cmd_err("指定工具记录不属于此轮次"));
        }
        let matches: Vec<&Value> = all_items
            .iter()
            .filter(|item| item["id"].as_str() == Some(target_id))
            .collect();
        if matches.len() != 1 {
            return Err(cmd_err("指定工具记录不属于此轮次"));
        }
        let item = matches[0];
        let tool = item["tool"].as_str().unwrap_or("");
        if item["type"] != "dynamicToolCall"
            || !is_verified_runtime_write_tool(tool)
            || item["status"] != "completed"
            || item["success"] != true
            || item["execution"]["backend"] != "runtime"
            || item["execution"]["outcome"] != "succeeded"
        {
            return Err(cmd_err("指定工具不是已成功完成的文件写入"));
        }
        if item["execution"].get("fileBefore").is_some() {
            selected_items = vec![item];
        }
    }

    let mut observed: BTreeMap<String, TextVersion> = BTreeMap::new();
    let mut changed: BTreeMap<String, ChangedVersion> = BTreeMap::new();
    let mut order: Vec<String> = Vec::new();
    let mut unavailable: BTreeMap<String, String> = BTreeMap::new();

    for item in selected_items {
        if item["type"] != "dynamicToolCall"
            || item["status"] != "completed"
            || item["success"] != true
            || item["execution"]["backend"] != "runtime"
            || item["execution"]["outcome"] != "succeeded"
        {
            continue;
        }
        let tool = item["tool"].as_str().unwrap_or("");
        let patch_tool = matches!(tool, "fs_apply_patch" | "fs_apply_patches");
        if !patch_tool && !matches!(tool, "fs_read" | "fs_create" | "fs_write") {
            continue;
        }
        let result_parts: Vec<&Value> = item["contentItems"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|part| matches!(part["type"].as_str(), Some("inputText" | "text")))
            .collect();
        let parsed_result = if result_parts.len() == 1 {
            result_parts[0]["text"]
                .as_str()
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        } else {
            None
        };
        let exec = &item["execution"];
        let args = if exec
            .as_object()
            .is_some_and(|obj| obj.contains_key("effectiveArguments"))
        {
            &exec["effectiveArguments"]
        } else {
            &item["arguments"]
        };
        let Some(result) = parsed_result else {
            return Err(cmd_err("本轮文件版本记录不完整，请使用工作区审查"));
        };
        let Some(args_obj) = args.as_object() else {
            return Err(cmd_err("本轮文件版本记录不完整，请使用工作区审查"));
        };
        let Some(uri) = result.get("path").and_then(Value::as_str) else {
            return Err(cmd_err("本轮文件版本记录不完整，请使用工作区审查"));
        };
        let Some(rel_path) = uri.strip_prefix("workspace://repo/") else {
            return Err(cmd_err("本轮文件版本记录不完整，请使用工作区审查"));
        };
        let Some(digest) = result.get("sha256").and_then(Value::as_str) else {
            return Err(cmd_err("本轮文件版本记录不完整，请使用工作区审查"));
        };
        let Some(size) = result.get("size").and_then(Value::as_u64) else {
            return Err(cmd_err("本轮文件版本记录不完整，请使用工作区审查"));
        };
        if args_obj.get("path").and_then(Value::as_str) != Some(uri)
            || !is_sha256_hex(digest)
            || size > BLOB_LIMIT as u64
        {
            return Err(cmd_err("本轮文件版本记录不完整，请使用工作区审查"));
        }
        if rel_path.is_empty()
            || rel_path.contains(['\r', '\n', '\t'])
            || rel_path
                .split('/')
                .any(|part| matches!(part, ".." | "." | ""))
        {
            return Err(cmd_err("本轮文件路径无法比较"));
        }
        let rel_path = rel_path.to_owned();
        if unavailable.contains_key(&rel_path) {
            continue;
        }

        let step: Result<bool> = (|| -> Result<bool> {
            if tool == "fs_read" {
                let offset_ok = match args_obj.get("offset") {
                    None | Some(Value::Null) => true,
                    Some(v) => v.as_u64() == Some(0),
                };
                if !offset_ok
                    || result.get("eof") != Some(&Value::Bool(true))
                    || result.get("text").and_then(Value::as_str).is_none_or(|t| {
                        t.len() as u64 != size || sha256_hex(t.as_bytes()) != digest
                    })
                {
                    return Ok(false);
                }
                let text = result["text"].as_str().unwrap().to_owned();
                if let Some(prev_changed) = changed.get(&rel_path)
                    && sha256_hex(prev_changed.after.as_bytes()) != digest
                {
                    return Err(cmd_err("本轮文件在工具之间发生了外部变化，无法归并版本"));
                }
                observed.insert(
                    rel_path.clone(),
                    TextVersion {
                        text,
                        hash: digest.to_owned(),
                    },
                );
                return Ok(false);
            }

            let creation = !patch_tool
                && (tool == "fs_create" || args_obj.get("expectedSha256") == Some(&Value::Null));
            let mut previous = observed.get(&rel_path).cloned();

            if let Some(reference) = exec.get("fileBefore") {
                let id_str = item["id"].as_str().unwrap_or("");
                let expected_sha = args_obj
                    .get("expectedSha256")
                    .and_then(Value::as_str)
                    .filter(|s| is_sha256_hex(s));
                let ref_size = reference.get("sizeBytes").and_then(Value::as_u64);
                let ref_mime = reference.get("mimeType").and_then(Value::as_str);
                let ref_uri = reference.get("uri").and_then(Value::as_str);
                let bytes = file_befores.get(id_str);
                let (Some(expected_sha), Some(ref_size), Some(bytes)) =
                    (expected_sha, ref_size, bytes)
                else {
                    return Err(cmd_err("本轮写入前的文件证据无法验证，请使用工作区审查"));
                };
                if creation
                    || ref_mime != Some("application/octet-stream")
                    || bytes.len() > BLOB_LIMIT
                    || bytes.len() as u64 != ref_size
                    || ref_uri != Some(format!("areal://blob/{expected_sha}").as_str())
                    || sha256_hex(bytes.as_slice()) != expected_sha
                {
                    return Err(cmd_err("本轮写入前的文件证据无法验证，请使用工作区审查"));
                }
                let decoded = std::str::from_utf8(bytes)
                    .map_err(|_| cmd_err("写入前的文件不是有效 UTF-8，历史文本比较不可用"))?
                    .to_owned();
                if let Some(prev_changed) = changed.get(&rel_path)
                    && sha256_hex(prev_changed.after.as_bytes()) != expected_sha
                {
                    return Err(cmd_err("本轮文件在工具之间发生了外部变化，无法归并版本"));
                }
                previous = Some(TextVersion {
                    text: decoded,
                    hash: expected_sha.to_owned(),
                });
            }

            let after = if patch_tool {
                let Some(expected_sha) = args_obj.get("expectedSha256").and_then(Value::as_str)
                else {
                    return Err(cmd_err("本轮缺少写入前的完整文件版本，请使用工作区审查"));
                };
                let Some(prev) = &previous else {
                    return Err(cmd_err("本轮缺少写入前的完整文件版本，请使用工作区审查"));
                };
                if prev.hash != expected_sha {
                    return Err(cmd_err("本轮缺少写入前的完整文件版本，请使用工作区审查"));
                }
                let patches = args_obj
                    .get("patches")
                    .and_then(Value::as_array)
                    .map(Vec::as_slice)
                    .unwrap_or(&[]);
                let patched = apply_recorded_patches(&prev.text, patches)?;
                if patched.len() as u64 != size || sha256_hex(patched.as_bytes()) != digest {
                    return Err(cmd_err("本轮补丁结果与确认版本不一致"));
                }
                patched
            } else {
                let Some(text) = args_obj.get("text").and_then(Value::as_str) else {
                    return Err(cmd_err("本轮写入文本与确认版本不一致"));
                };
                if text.len() as u64 != size || sha256_hex(text.as_bytes()) != digest {
                    return Err(cmd_err("本轮写入文本与确认版本不一致"));
                }
                if creation && changed.contains_key(&rel_path) {
                    return Err(cmd_err("本轮文件重复创建，缺少完整版本链"));
                }
                if !creation {
                    let expected_sha = args_obj.get("expectedSha256").and_then(Value::as_str);
                    if previous
                        .as_ref()
                        .is_none_or(|p| Some(p.hash.as_str()) != expected_sha)
                    {
                        return Err(cmd_err("本轮缺少写入前的完整文件版本，请使用工作区审查"));
                    }
                }
                text.to_owned()
            };

            let before = if creation {
                String::new()
            } else {
                previous.map(|p| p.text).unwrap_or_default()
            };
            if item_id.is_some_and(|target| item["id"].as_str() == Some(target)) {
                changed.clear();
                order.clear();
                order.push(rel_path.clone());
                changed.insert(rel_path.clone(), ChangedVersion { before, after });
                return Ok(true);
            }
            if !changed.contains_key(&rel_path) {
                order.push(rel_path.clone());
                changed.insert(
                    rel_path.clone(),
                    ChangedVersion {
                        before,
                        after: after.clone(),
                    },
                );
            } else if let Some(entry) = changed.get_mut(&rel_path) {
                entry.after = after.clone();
            }
            observed.insert(
                rel_path.clone(),
                TextVersion {
                    text: after,
                    hash: digest.to_owned(),
                },
            );
            Ok(false)
        })();

        match step {
            Ok(true) => break,
            Ok(false) => {}
            Err(error) => {
                if !allow_partial || item_id.is_some() {
                    return Err(error);
                }
                changed.remove(&rel_path);
                observed.remove(&rel_path);
                order.retain(|p| p != &rel_path);
                let msg = error
                    .downcast_ref::<crate::wire::Error>()
                    .map(|e| e.message.clone())
                    .unwrap_or_else(|| error.to_string());
                unavailable.insert(rel_path, msg);
            }
        }
    }

    let ordered_changes = order
        .into_iter()
        .filter_map(|path| {
            let v = changed.remove(&path)?;
            (v.before != v.after).then_some((path, v))
        })
        .collect();
    let unavailable_files = unavailable
        .into_iter()
        .map(|(path, reason)| json!({ "path": path, "reason": reason }))
        .collect();
    Ok((ordered_changes, unavailable_files))
}

fn rewrite_patch_body_headers(raw_diff: &str, rel_path: &str) -> String {
    let lines = raw_diff.split_terminator('\n');
    let mut out = String::new();
    for line in lines {
        if line.starts_with("--- ") {
            out.push_str(&format!("--- a/{rel_path}\n"));
        } else if line.starts_with("+++ ") {
            out.push_str(&format!("+++ b/{rel_path}\n"));
        } else {
            out.push_str(line);
            out.push('\n');
        }
    }
    if !raw_diff.ends_with('\n') && out.ends_with('\n') {
        out.pop();
    }
    out
}

async fn render_turn_diff_and_files(
    home: &Path,
    changes: Vec<(String, ChangedVersion)>,
) -> Result<(String, Vec<Value>)> {
    if changes.is_empty() {
        return Ok((String::new(), Vec::new()));
    }
    let scratch = ReviewScratch(home.join(format!("review-{}", uuid::Uuid::new_v4())));
    std::fs::DirBuilder::new().mode(0o700).create(&scratch.0)?;
    let before_file = scratch.0.join("before");
    let after_file = scratch.0.join("after");

    let mut combined_diff = String::new();
    let mut review_files = Vec::with_capacity(changes.len());

    for (rel_path, version) in changes {
        if version.before.contains('\0') || version.after.contains('\0') {
            return Err(cmd_err("历史版本包含二进制内容，无法生成文本比较"));
        }
        for (path, text) in [
            (&before_file, &version.before),
            (&after_file, &version.after),
        ] {
            let mut file = OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(path)?;
            file.write_all(text.as_bytes())?;
        }
        let output = tokio::time::timeout(
            GIT_TIMEOUT_FAST,
            Command::new("git")
                .args([
                    "-c",
                    "core.autocrlf=false",
                    "diff",
                    "--no-index",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--no-color",
                    "--no-renames",
                    "--no-indent-heuristic",
                    "--diff-algorithm=myers",
                    "--unified=4",
                    "--",
                ])
                .arg(&before_file)
                .arg(&after_file)
                .current_dir(&scratch.0)
                .env("LC_ALL", "C")
                .kill_on_drop(true)
                .output(),
        )
        .await??;
        ensure!(
            output.status.code() == Some(1) && output.stdout.len() <= 4 * 1024 * 1024,
            cmd_err("无法生成本轮文件比较")
        );
        let raw_stdout = std::str::from_utf8(&output.stdout)?;
        let header = format!("diff --git a/{rel_path} b/{rel_path}\n");
        let body = if let Some(pos) = raw_stdout.find("\n--- ") {
            rewrite_patch_body_headers(&raw_stdout[pos + 1..], &rel_path)
        } else {
            String::new()
        };
        let file_diff = format!("{header}{body}");
        combined_diff.push_str(&file_diff);
        let mut parsed = parse_git_patch(&file_diff, Some(std::slice::from_ref(&rel_path)))?;
        if let Some(mut entry) = parsed.pop() {
            entry["beforeText"] = json!(version.before);
            entry["afterText"] = json!(version.after);
            review_files.push(entry);
        }
    }
    Ok((combined_diff, review_files))
}

async fn turn_review(
    host: &Rc<Host>,
    scope: &session_commands::ResolvedScope,
    request: &Value,
) -> Result<Value> {
    let thread_id = request
        .get("threadId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| cmd_err("请选择已完成的任务轮次"))?;
    let turn_id = request
        .get("turnId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| cmd_err("请选择已完成的任务轮次"))?;
    let item_id = request.get("itemId").and_then(Value::as_str);

    let (turn, file_befores) = if host
        .schedules
        .connections
        .shared_identity(host, &scope.canonical_id)
        .is_err()
    {
        match read_persisted_turn_for_review(host, &scope.canonical_id, thread_id, turn_id, item_id)
            .await?
        {
            PersistedTurnLookup::Found { turn, file_befores } => (turn, file_befores),
            PersistedTurnLookup::TurnMissingNonFork => {
                return Err(cmd_err("轮次不属于当前任务"));
            }
            PersistedTurnLookup::FallbackToLive => {
                fetch_live_turn_and_blobs(host, &scope.canonical_id, thread_id, turn_id, item_id)
                    .await?
            }
        }
    } else {
        fetch_live_turn_and_blobs(host, &scope.canonical_id, thread_id, turn_id, item_id).await?
    };

    let (changes, unavailable_files) =
        reconstruct_turn_changes(&turn, item_id, &file_befores, true)?;
    let (diff, files) = render_turn_diff_and_files(&host.home, changes).await?;

    let turn_id_out = turn["id"].as_str().unwrap_or(turn_id);
    let version = if let Some(id) = item_id {
        format!("turn:{turn_id_out}:item:{id}")
    } else {
        format!("turn:{turn_id_out}")
    };
    let token_payload = serde_json::to_vec(&json!({
        "turnId": turn_id_out,
        "itemId": item_id,
        "diff": diff,
    }))?;
    let unavailable_names: Vec<&str> = unavailable_files
        .iter()
        .filter_map(|f| f["path"].as_str())
        .collect();
    let notice = if !unavailable_names.is_empty() {
        format!(
            "仅显示本轮可验证的文件工具修改；未包含 {}：文件版本无法完整验证。",
            unavailable_names.join("、")
        )
    } else if item_id.is_none() {
        "仅显示本轮可验证的文件工具修改；Shell 或外部编辑不计入。".to_owned()
    } else {
        "仅显示该次可验证的文件工具修改，不使用当前磁盘版本。".to_owned()
    };

    let mut result = json!({
        "root": scope.workspace.to_string_lossy(),
        "diff": diff,
        "unavailableFiles": unavailable_files,
        "files": files,
        "scope": if item_id.is_none() { "last-turn" } else { "tool" },
        "turnId": turn_id_out,
        "head": format!("{version}:after"),
        "base": format!("{version}:before"),
        "token": sha256_hex(&token_payload),
        "notice": notice,
    });
    if let Some(id) = item_id {
        result["itemId"] = json!(id);
    }
    Ok(result)
}

async fn fetch_live_turn_and_blobs(
    host: &Rc<Host>,
    canonical_id: &str,
    thread_id: &str,
    turn_id: &str,
    item_id: Option<&str>,
) -> Result<(Value, BTreeMap<String, Vec<u8>>)> {
    session_commands::ensure_project(host, canonical_id).await?;
    let res = session_commands::shared_rpc(
        host,
        canonical_id,
        "thread/read",
        json!({ "threadId": thread_id, "includeTurns": true }),
    )
    .await?;
    let thread = &res["thread"];
    let mut turn = thread["turns"]
        .as_array()
        .and_then(|turns| turns.iter().find(|t| t["id"] == turn_id))
        .cloned();

    if turn.is_none() && thread["conversation"]["kind"] == "fork" {
        let Some(expected_snap) = thread["conversation"]["historySeed"]["snapshotId"].as_str()
        else {
            return Err(cmd_err("继承历史快照已变化"));
        };
        let mut cursor: Option<String> = None;
        let mut partial = String::new();
        let mut partial_item_id: Option<String> = None;
        let mut assembled: Option<Value> = None;
        loop {
            let mut params = json!({
                "threadId": thread_id,
                "view": "inherited",
                "maxBytes": 262144,
            });
            if let Some(c) = &cursor {
                params["cursor"] = json!(c);
            }
            let raw_page = session_commands::shared_rpc(
                host,
                canonical_id,
                "areal/conversation/history",
                params,
            )
            .await?;
            let page: InheritedHistoryPage = serde_json::from_value(raw_page)?;
            if page.snapshot_id != expected_snap {
                return Err(cmd_err("继承历史快照已变化"));
            }
            for mut entry in page.data.unwrap_or_default() {
                if let Some(fragment) = entry.get("fragment").and_then(Value::as_object) {
                    let offset_utf8 = fragment
                        .get("offsetUtf8")
                        .and_then(Value::as_u64)
                        .ok_or_else(|| cmd_err("继承历史分片不连续"))?;
                    let src_item = entry.get("sourceItemId").and_then(Value::as_str);
                    if offset_utf8 != partial.len() as u64
                        || (!partial.is_empty() && partial_item_id.as_deref() != src_item)
                    {
                        return Err(cmd_err("继承历史分片不连续"));
                    }
                    partial_item_id = src_item.map(str::to_owned);
                    let frag_text = fragment
                        .get("text")
                        .and_then(Value::as_str)
                        .ok_or_else(|| cmd_err("继承历史分片不连续"))?;
                    partial.push_str(frag_text);
                    let total_bytes = fragment
                        .get("totalBytes")
                        .and_then(Value::as_u64)
                        .ok_or_else(|| cmd_err("继承历史分片长度无效"))?;
                    if partial.len() as u64 > total_bytes {
                        return Err(cmd_err("继承历史分片长度无效"));
                    }
                    if (partial.len() as u64) < total_bytes {
                        continue;
                    }
                    entry = serde_json::from_str(&partial)?;
                    partial.clear();
                    partial_item_id = None;
                } else if !partial.is_empty() {
                    return Err(cmd_err("继承历史分片不连续"));
                }
                if entry["sourceTurnId"].as_str() != Some(turn_id) {
                    continue;
                }
                if assembled.is_none() {
                    let mut base_turn = entry["turn"].clone();
                    if !base_turn.is_object() {
                        base_turn = json!({});
                    }
                    base_turn["id"] = json!(turn_id);
                    base_turn["status"] = entry["sourceTurnStatus"].clone();
                    base_turn["items"] = json!([]);
                    assembled = Some(base_turn);
                }
                if let Some(t) = assembled.as_mut() {
                    t["items"]
                        .as_array_mut()
                        .unwrap()
                        .push(entry["item"].clone());
                }
            }
            if page.complete {
                if !partial.is_empty() {
                    return Err(cmd_err("继承历史分片不完整"));
                }
                break;
            }
            let Some(next) = page
                .next_cursor
                .filter(|n| !n.is_empty() && Some(n) != cursor.as_ref())
            else {
                return Err(cmd_err("继承历史游标未推进"));
            };
            cursor = Some(next);
        }
        turn = assembled;
    }

    let Some(turn) = turn else {
        return Err(cmd_err("轮次不属于当前任务"));
    };
    check_no_deferred_tool_calls(&turn, item_id)?;

    let mut file_befores = BTreeMap::new();
    for (item_id_key, reference) in needed_file_before_items(&turn, item_id)? {
        let (digest, expected_size) = validate_file_before_ref(&reference)?;
        let uri = reference["uri"].as_str().unwrap();
        let bytes = host
            .schedules
            .connections
            .shared_read_blob(host, canonical_id, thread_id, uri)
            .await
            .map_err(|e| cmd_err(format!("历史文件前像读取失败：{e}")))?;
        if bytes.len() != expected_size || sha256_hex(&bytes) != digest {
            return Err(cmd_err("历史文件前像与记录的大小或哈希不一致"));
        }
        file_befores.insert(item_id_key, bytes);
    }

    Ok((turn, file_befores))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::workbench_route::desktop_command;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    fn test_host(root: &Path) -> (Rc<Host>, String, String, PathBuf) {
        let mut host = crate::server::schedules::tests::fixture(root);
        host.bin = root.join("target/debug");
        storage::private_dir(&host.bin).unwrap();
        storage::private_dir(&root.join("profile")).unwrap();
        storage::private_dir(&root.join("data")).unwrap();
        let source = crate::migration::Source {
            profile: root.join("profile"),
            core_home: root.join("data"),
            // 过渡：到 0.2.0 删；导入夹具沿用迁移来源字段。
            legacy_service_home: root.join("legacy"),
        };
        host.migration
            .attach(source.clone(), "fixture", None)
            .unwrap();
        let imported = host
            .migration
            .import(
                serde_json::from_value(json!({
                    "requestId": uuid::Uuid::new_v4().to_string(),
                    "expectedGeneration": host.identity.generation,
                    "source": source,
                }))
                .unwrap(),
                "fixture",
                &[],
                &host.journal,
            )
            .unwrap();
        assert_eq!(imported["kind"], "ready");
        let source_id = host
            .migration
            .navigation_source_id(&source.profile)
            .unwrap()
            .unwrap();
        let alias = "fedcba9876543210fedcba98".to_owned();
        let workspace = root.join("project");
        storage::private_dir(&workspace).unwrap();
        {
            let mut slots = host.slots.borrow_mut();
            let slot = slots.get_mut("project").unwrap();
            slot.registration.workspace = workspace.clone();
            slot.registration.source = crate::ProjectSource::Gui {
                profile: source.profile.clone(),
                // 过渡：到 0.2.0 删；导入夹具沿用迁移来源字段。
                legacy_project_id: alias.clone(),
            };
        }
        storage::write(
            &source.core_home.join("projects.json"),
            &json!([{ "id": alias, "root": workspace }]),
        )
        .unwrap();
        let host = Rc::new(host);
        host.gateway.workbench.test_source(&source_id);
        (host, source_id, alias, workspace)
    }

    async fn run_cmd(host: &Rc<Host>, request: Value) -> Result<Value> {
        desktop_command(
            host,
            "local-desktop",
            "conn-1",
            &json!({
                "id": uuid::Uuid::new_v4().to_string(),
                "method": "desktop.command",
                "params": {
                    "command": "workspace",
                    "request": request,
                }
            }),
        )
        .await
    }

    fn git_sync(dir: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    async fn start_mock_core(
        host: &Rc<Host>,
        workspace: &Path,
    ) -> (tokio::task::JoinHandle<()>, Box<dyn Fn()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let registration = host.slots.borrow()["project"].registration.clone();
        let service = areal_protocol::service::Service {
            identity: areal_protocol::service::Identity {
                protocol_version: 1,
                service_id: "fixture".into(),
                generation: "gen-1".into(),
                workspace: registration.workspace,
                data_dir: registration.data_dir,
                config_fingerprint: "fixture".into(),
            },
            owner: Some(host.owner()),
            endpoint: format!("ws://{}/", listener.local_addr().unwrap()),
            web_url: String::new(),
            auth_file: host.home.join("core-auth.json"),
            log_file: host.home.join("core.log"),
            host_pid: 1,
            core_pid: 2,
            state: areal_protocol::service::State::Ready,
        };
        storage::write(
            &service.auth_file,
            &json!({"principals":[{"id":"desktop-owner","token":"fixture"}]}),
        )
        .unwrap();
        {
            let mut slots = host.slots.borrow_mut();
            let slot = slots.get_mut("project").unwrap();
            slot.service = Some(service.clone());
            slot.state = "ready".into();
            let (writer, lifetime) = areal_local_service::OwnerLifetime::pair().unwrap();
            slot.writer = Some(writer);
            slot.lifetime = Some(Rc::new(lifetime));
        }
        let ws = workspace.to_path_buf();
        let server = tokio::task::spawn_local(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            while let Some(Ok(Message::Text(text))) = socket.next().await {
                let call: Value = serde_json::from_str(&text).unwrap();
                if call.get("id").is_none() {
                    continue;
                }
                let method = call["method"].as_str().unwrap();
                let params = &call["params"];
                let result = match method {
                    "initialize" => json!({}),
                    "areal/task/list" => json!({ "data": [], "nextCursor": null }),
                    "thread/read" => json!({
                        "thread": {
                            "id": params["threadId"].as_str().unwrap(),
                            "sessionId": "session-1",
                            "cwd": ws,
                            "conversation": { "kind": "ordinary", "policy": { "kind": "ordinaryV1" } },
                            "turns": [],
                            "desktop": { "configuration": { "revision": 1, "options": { "permissionPreset": "ask" } } }
                        }
                    }),
                    _ => json!({}),
                };
                socket
                    .send(Message::Text(
                        json!({"jsonrpc":"2.0","id":call["id"],"result":result})
                            .to_string()
                            .into(),
                    ))
                    .await
                    .unwrap();
            }
        });
        let close = host
            .schedules
            .connections
            .connect_test_core(host.clone(), "project", service)
            .await
            .unwrap();
        (server, close)
    }

    #[tokio::test(flavor = "current_thread")]
    async fn workspace_file_ops_confine_symlinks_and_conditional_save() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let root = tempfile::tempdir().unwrap();
                let base = root.path().canonicalize().unwrap();
                let (host, _source, alias, workspace) = test_host(&base);

                // 1. localDirectoryReference
                let ext_dir = base.join(" 中文 notes (v2)#1> ");
                std::fs::create_dir_all(&ext_dir).unwrap();
                let ext_file = base.join("outside.txt");
                std::fs::write(&ext_file, "outside\n").unwrap();

                let ref_res = run_cmd(
                    &host,
                    json!({ "projectId": alias, "operation": "localDirectoryReference", "path": ext_dir }),
                )
                .await
                .unwrap();
                assert_eq!(ref_res["type"], "directory");
                assert_eq!(ref_res["name"], " 中文 notes (v2)#1> ");
                assert_eq!(ref_res["path"], json!(ext_dir));
                let link = base.join("selected-link");
                std::os::unix::fs::symlink(ext_dir, &link).unwrap();
                for path in [link.to_str().unwrap(), "/"] {
                    let reference = run_cmd(
                        &host,
                        json!({"projectId":alias,"operation":"localDirectoryReference","path":path}),
                    )
                    .await
                    .unwrap();
                    assert_eq!(reference["path"], path);
                }
                let missing = base.join("missing-directory");
                for (id, path) in [
                    (alias.as_str(), "relative/path"),
                    (alias.as_str(), missing.to_str().unwrap()),
                    ("unknown", link.to_str().unwrap()),
                ] {
                    assert!(
                        run_cmd(
                            &host,
                            json!({"projectId":id,"operation":"localDirectoryReference","path":path}),
                        )
                        .await
                        .is_err()
                    );
                }
                assert!(
                    run_cmd(
                        &host,
                        json!({ "projectId": alias, "operation": "localDirectoryReference", "path": ext_file }),
                    )
                    .await
                    .is_err()
                );

                // 2. list (showAll, NOISE, escaping vs inside symlinks)
                std::fs::create_dir_all(workspace.join("node_modules")).unwrap();
                std::fs::create_dir_all(workspace.join("src")).unwrap();
                std::fs::create_dir_all(workspace.join("notes")).unwrap();
                std::fs::write(workspace.join("src/app.ts"), "export const x = 1;\n").unwrap();
                std::fs::write(workspace.join("notes/app_notes.md"), "app note\n").unwrap();
                std::fs::write(workspace.join(".DS_Store"), "junk").unwrap();
                std::fs::write(workspace.join(".hidden"), "secret").unwrap();
                std::os::unix::fs::symlink(workspace.join("src"), workspace.join("linked-src"))
                    .unwrap();
                std::os::unix::fs::symlink(&ext_file, workspace.join("escape-link.txt")).unwrap();

                let default_list = run_cmd(
                    &host,
                    json!({ "projectId": alias, "operation": "list", "path": "", "showAll": false }),
                )
                .await
                .unwrap();
                let names: Vec<&str> = default_list["entries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|e| e["name"].as_str().unwrap())
                    .collect();
                assert!(names.contains(&"src"));
                assert!(names.contains(&"linked-src"));
                assert!(names.contains(&".hidden"));
                assert!(!names.contains(&"node_modules"));
                assert!(!names.contains(&".DS_Store"));
                assert!(!names.contains(&"escape-link.txt"));

                let all_list = run_cmd(
                    &host,
                    json!({ "projectId": alias, "operation": "list", "path": "", "showAll": true }),
                )
                .await
                .unwrap();
                let all_names: Vec<&str> = all_list["entries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|e| e["name"].as_str().unwrap())
                    .collect();
                assert!(all_names.contains(&"node_modules"));
                assert!(!all_names.contains(&".DS_Store"));

                // 3. search & read & escape rejection
                let found = run_cmd(
                    &host,
                    json!({ "projectId": alias, "operation": "search", "query": "APP" }),
                )
                .await
                .unwrap();
                assert!(
                    found["entries"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|e| e["path"] == "notes/app_notes.md")
                );
                assert!(
                    found["entries"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|e| e["path"] == "src/app.ts" || e["path"] == "linked-src/app.ts")
                );
                assert!(
                    run_cmd(
                        &host,
                        json!({ "projectId": alias, "operation": "read", "path": "../outside.txt" }),
                    )
                    .await
                    .is_err()
                );
                assert!(
                    run_cmd(
                        &host,
                        json!({ "projectId": alias, "operation": "read", "path": "escape-link.txt" }),
                    )
                    .await
                    .is_err()
                );
                let read_res = run_cmd(
                    &host,
                    json!({ "projectId": alias, "operation": "read", "path": "src/app.ts" }),
                )
                .await
                .unwrap();
                let rev1 = read_res["revision"].as_str().unwrap().to_owned();
                assert_eq!(read_res["text"], "export const x = 1;\n");
                // Read operations must not wake Core.
                assert!(
                    host.schedules
                        .connections
                        .shared_identity(&host, "project")
                        .is_err()
                );

                // 4. save requires Core & valid threadId (admission check), then supports save + conflict
                let (server, close_core) = start_mock_core(&host, &workspace).await;
                assert!(
                    run_cmd(
                        &host,
                        json!({
                            "projectId": alias,
                            "operation": "save",
                            "path": "src/app.ts",
                            "text": "export const x = 2;\n",
                            "revision": rev1,
                        }),
                    )
                    .await
                    .is_err()
                );
                let stale = run_cmd(
                    &host,
                    json!({
                        "projectId": alias,
                        "threadId": "thread-1",
                        "operation": "save",
                        "path": "src/app.ts",
                        "text": "export const x = 2;\n",
                        "revision": "0".repeat(64),
                    }),
                )
                .await
                .unwrap();
                assert_eq!(stale["conflict"], true);

                let saved = run_cmd(
                    &host,
                    json!({
                        "projectId": alias,
                        "threadId": "thread-1",
                        "operation": "save",
                        "path": "src/app.ts",
                        "text": "export const x = 2;\n",
                        "revision": rev1,
                    }),
                )
                .await
                .unwrap();
                assert_eq!(saved["saved"], true);
                assert_eq!(
                    std::fs::read_to_string(workspace.join("src/app.ts")).unwrap(),
                    "export const x = 2;\n"
                );

                let file = workspace.join("src/concurrent.txt");
                let base = "0".repeat(FILE_LIMIT);
                std::fs::write(&file, &base).unwrap();
                let revision = sha256_hex(base.as_bytes());
                let drafts: Vec<_> = (1..=8).map(|n| n.to_string().repeat(FILE_LIMIT)).collect();
                let results = futures_util::future::join_all(drafts.iter().map(|draft| {
                    run_cmd(
                        &host,
                        json!({
                            "projectId": alias,
                            "threadId": "thread-1",
                            "operation": "save",
                            "path": "src/concurrent.txt",
                            "text": draft,
                            "revision": revision,
                        }),
                    )
                }))
                .await;
                let results: Vec<_> = results.into_iter().map(Result::unwrap).collect();
                let winners: Vec<_> = results
                    .iter()
                    .enumerate()
                    .filter(|(_, result)| result["saved"] == true)
                    .collect();
                assert_eq!(winners.len(), 1, "{results:?}");
                assert_eq!(results.iter().filter(|value| value["conflict"] == true).count(), 7);
                assert_eq!(std::fs::read_to_string(&file).unwrap(), drafts[winners[0].0]);

                close_core();
                server.abort();
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn git_pipe_stops_reading_on_overflow_before_eof() {
        let (reader, mut writer) = tokio::io::duplex(16);
        tokio::io::AsyncWriteExt::write_all(&mut writer, b"too much output")
            .await
            .unwrap();
        let error = tokio::time::timeout(Duration::from_secs(1), read_git_pipe(reader, 8))
            .await
            .unwrap()
            .unwrap_err();
        assert!(error.to_string().contains("Git 输出过大"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn oversized_git_diff_returns_an_error_and_allows_next_git_request() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join("large.txt"),
            "large diff line\n".repeat(1_200_000),
        )
        .unwrap();
        let error = run_git_raw(
            root.path(),
            &["diff", "--no-index", "--", "/dev/null", "large.txt"],
            GIT_TIMEOUT_FAST,
        )
        .await
        .err()
        .expect("oversized diff must be refused");
        assert!(error.to_string().contains("Git 输出过大"), "{error}");
        assert!(
            run_git(root.path(), &["--version"], GIT_TIMEOUT_FAST)
                .await
                .unwrap()
                .starts_with("git version ")
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn workspace_review_summary_preserves_counts_and_token_without_large_payload() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let root = tempfile::tempdir().unwrap();
                let base = root.path().canonicalize().unwrap();
                let (host, _source, alias, workspace) = test_host(&base);
                git_sync(&workspace, &["init", "-b", "main"]);
                git_sync(&workspace, &["config", "user.name", "Tester"]);
                git_sync(
                    &workspace,
                    &["config", "user.email", "tester@example.invalid"],
                );
                std::fs::write(workspace.join("large.txt"), "baseline\n").unwrap();
                git_sync(&workspace, &["add", "."]);
                git_sync(&workspace, &["commit", "-m", "baseline"]);
                std::fs::write(workspace.join("large.txt"), "new line\n".repeat(30_000)).unwrap();
                std::fs::write(workspace.join("new.txt"), "untracked\n").unwrap();
                let request =
                    json!({"projectId": alias, "operation": "review", "scope": "unstaged"});
                let detailed = run_cmd(&host, request.clone()).await.unwrap();
                assert!(serde_json::to_vec(&detailed).unwrap().len() > 1024 * 1024);
                let mut summary_request = request.clone();
                summary_request["summaryOnly"] = json!(true);
                let summary = run_cmd(&host, summary_request).await.unwrap();
                assert!(serde_json::to_vec(&summary).unwrap().len() < 16 * 1024);
                assert_eq!(summary["diff"], "");
                for key in ["token", "head", "base", "scope", "dirty", "root", "branch"] {
                    assert_eq!(summary[key], detailed[key], "{key}");
                }
                let files = summary["files"].as_array().unwrap();
                assert_eq!(files.len(), 2);
                for file in files {
                    let original = detailed["files"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|original| original["path"] == file["path"])
                        .unwrap();
                    for key in ["path", "additions", "deletions", "binary"] {
                        assert_eq!(file[key], original[key], "{key}");
                    }
                    assert_eq!(file["hunks"], json!([]));
                    assert_eq!(file.as_object().unwrap().len(), 5);
                }
                let large = files
                    .iter()
                    .find(|file| file["path"] == "large.txt")
                    .unwrap();
                assert_eq!(large["additions"], 30_000);
                assert_eq!(large["deletions"], 1);
                let mut explicit_detail = request.clone();
                explicit_detail["summaryOnly"] = json!(false);
                assert_eq!(run_cmd(&host, explicit_detail).await.unwrap(), detailed);
                let mut invalid = request;
                invalid["summaryOnly"] = json!("true");
                assert_eq!(
                    validate_request(&invalid).unwrap_err().to_string(),
                    "INVALID_PARAMS"
                );
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn workspace_git_review_and_mutations_run_without_node_backend() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let root = tempfile::tempdir().unwrap();
                let base = root.path().canonicalize().unwrap();
                let (host, _source, alias, workspace) = test_host(&base);

                // Non-git info & status before git init.
                let pre_info =
                    run_cmd(&host, json!({ "projectId": alias, "operation": "info" }))
                        .await
                        .unwrap();
                assert_eq!(pre_info["git"], false);
                let pre_status =
                    run_cmd(&host, json!({ "projectId": alias, "operation": "status" }))
                        .await
                        .unwrap();
                assert_eq!(pre_status["available"], false);

                // Initialize repo + bare remote.
                let bare = base.join("remote.git");
                std::fs::create_dir_all(&bare).unwrap();
                git_sync(&bare, &["init", "--bare"]);
                git_sync(&workspace, &["init", "-b", "main"]);
                git_sync(&workspace, &["config", "user.name", "Tester"]);
                git_sync(&workspace, &["config", "user.email", "tester@example.invalid"]);
                std::fs::write(workspace.join("tracked.txt"), "one\n").unwrap();
                git_sync(&workspace, &["add", "tracked.txt"]);
                git_sync(&workspace, &["commit", "-m", "initial commit"]);
                git_sync(&workspace, &["remote", "add", "origin", bare.to_str().unwrap()]);

                // Tracked modification + untracked file.
                std::fs::write(workspace.join("tracked.txt"), "two\n").unwrap();
                std::fs::write(workspace.join("new.txt"), "fresh\n").unwrap();

                let info = run_cmd(&host, json!({ "projectId": alias, "operation": "info" }))
                    .await
                    .unwrap();
                assert_eq!(info["branch"], "main");
                assert_eq!(info["dirty"], true);

                let status = run_cmd(&host, json!({ "projectId": alias, "operation": "status" }))
                    .await
                    .unwrap();
                assert_eq!(status["available"], true);
                let status_entries = status["entries"].as_array().unwrap();
                assert!(status_entries.iter().any(|e| e["path"] == "tracked.txt" && e["status"] == "M"));
                assert!(status_entries.iter().any(|e| e["path"] == "new.txt" && e["status"] == "U"));

                let commits = run_cmd(
                    &host,
                    json!({ "projectId": alias, "operation": "reviewCommits" }),
                )
                .await
                .unwrap();
                assert_eq!(commits["commits"].as_array().unwrap().len(), 1);
                let head_oid = commits["head"].as_str().unwrap().to_owned();

                let branches = run_cmd(
                    &host,
                    json!({ "projectId": alias, "operation": "reviewBranches" }),
                )
                .await
                .unwrap();
                assert!(
                    branches["branches"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|b| b["name"] == "main")
                );

                let unstaged = run_cmd(
                    &host,
                    json!({ "projectId": alias, "operation": "review", "scope": "unstaged" }),
                )
                .await
                .unwrap();
                let review_paths: Vec<&str> = unstaged["files"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|f| f["path"].as_str().unwrap())
                    .collect();
                assert!(review_paths.contains(&"tracked.txt"));
                assert!(review_paths.contains(&"new.txt"));

                let commit_rev = run_cmd(
                    &host,
                    json!({ "projectId": alias, "operation": "review", "scope": "commit", "ref": head_oid }),
                )
                .await
                .unwrap();
                assert_eq!(commit_rev["scope"], "commit");
                assert_eq!(commit_rev["files"][0]["path"], "tracked.txt");

                let worktrees_via_ws = run_cmd(
                    &host,
                    json!({ "projectId": alias, "operation": "worktreeList" }),
                )
                .await
                .unwrap();
                assert!(worktrees_via_ws["worktrees"].is_array());

                // Git mutations require Core + admission (and threadId), reject stale token, and push cleanly.
                let (server, close_core) = start_mock_core(&host, &workspace).await;
                let gs0 = run_cmd(&host, json!({ "projectId": alias, "operation": "gitState" }))
                    .await
                    .unwrap();
                assert_eq!(gs0["remotes"], json!(["origin"]));

                assert!(
                    run_cmd(
                        &host,
                        json!({
                            "projectId": alias,
                            "threadId": "thread-1",
                            "operation": "gitStage",
                            "token": "stale-token"
                        }),
                    )
                    .await
                    .is_err()
                );

                let staged = run_cmd(
                    &host,
                    json!({
                        "projectId": alias,
                        "threadId": "thread-1",
                        "operation": "gitStage",
                        "token": gs0["token"],
                        "message": "",
                        "remote": "origin",
                        "targetBranch": "main"
                    }),
                )
                .await
                .unwrap();
                assert_eq!(staged["applied"], true);

                let gs1 = run_cmd(&host, json!({ "projectId": alias, "operation": "gitState" }))
                    .await
                    .unwrap();
                assert!(gs1["staged"].as_array().unwrap().len() == 2);

                let unstage = run_cmd(
                    &host,
                    json!({
                        "projectId": alias,
                        "threadId": "thread-1",
                        "operation": "gitUnstage",
                        "token": gs1["token"]
                    }),
                )
                .await
                .unwrap();
                assert_eq!(unstage["applied"], true);

                let gs2 = run_cmd(&host, json!({ "projectId": alias, "operation": "gitState" }))
                    .await
                    .unwrap();
                assert!(gs2["staged"].as_array().unwrap().is_empty());

                run_cmd(
                    &host,
                    json!({
                        "projectId": alias,
                        "threadId": "thread-1",
                        "operation": "gitStage",
                        "token": gs2["token"]
                    }),
                )
                .await
                .unwrap();
                let gs3 = run_cmd(&host, json!({ "projectId": alias, "operation": "gitState" }))
                    .await
                    .unwrap();

                let committed = run_cmd(
                    &host,
                    json!({
                        "projectId": alias,
                        "threadId": "thread-1",
                        "operation": "gitCommit",
                        "token": gs3["token"],
                        "message": "second commit"
                    }),
                )
                .await
                .unwrap();
                assert_eq!(committed["applied"], true);
                let pushed_head = committed["head"].as_str().unwrap().to_owned();

                let gs4 = run_cmd(&host, json!({ "projectId": alias, "operation": "gitState" }))
                    .await
                    .unwrap();
                let pushed = run_cmd(
                    &host,
                    json!({
                        "projectId": alias,
                        "threadId": "thread-1",
                        "operation": "gitPush",
                        "token": gs4["token"],
                        "remote": "origin",
                        "targetBranch": "main"
                    }),
                )
                .await
                .unwrap();
                assert_eq!(pushed["applied"], true);
                assert_eq!(pushed["head"], pushed_head);
                assert_eq!(
                    git_sync(&bare, &["rev-parse", "refs/heads/main"]).trim(),
                    pushed_head
                );

                close_core();
                server.abort();
            })
            .await;
    }

    #[test]
    fn turn_review_checks_deferred_content_only_within_the_requested_item() {
        let turn = json!({"items":[
            {"id":"loaded", "type":"dynamicToolCall"},
            {"id":"deferred", "type":"historyDeferred", "originalType":"dynamicToolCall"}
        ]});
        assert!(check_no_deferred_tool_calls(&turn, Some("loaded")).is_ok());
        assert!(check_no_deferred_tool_calls(&turn, Some("deferred")).is_err());
        assert!(check_no_deferred_tool_calls(&turn, None).is_err());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn turn_review_reads_stopped_persisted_history_without_waking_core() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let root = tempfile::tempdir().unwrap();
                let base = root.path().canonicalize().unwrap();
                let (host, _source, alias, workspace) = test_host(&base);
                let registration = host.slots.borrow()["project"].registration.clone();

                storage::private_dir(&registration.data_dir).unwrap();
                storage::private_dir(&registration.data_dir.join("blobs")).unwrap();
                let registry_dir =
                    storage::registry(&host.home, &Host::service_id(&registration)).unwrap();
                storage::private_dir(&registry_dir).unwrap();
                for path in [
                    registry_dir.join("start.lock"),
                    registration.data_dir.join("service.lock"),
                    registration.data_dir.join("owner.lock"),
                ] {
                    storage::open_private(&path, true).unwrap();
                }
                storage::write(
                    &registration.data_dir.join("service-workspace"),
                    &registration.workspace,
                )
                .unwrap();
                let service: areal_protocol::service::Service = serde_json::from_value(json!({
                    "protocolVersion": 1,
                    "serviceId": Host::service_id(&registration),
                    "generation": "gen-stopped",
                    "workspace": registration.workspace,
                    "dataDir": registration.data_dir,
                    "configFingerprint": "fixture",
                    "endpoint": "ws://127.0.0.1:1",
                    "webUrl": "http://127.0.0.1:1",
                    "authFile": registry_dir.join("auth.json"),
                    "logFile": registry_dir.join("host.log"),
                    "hostPid": 99999999,
                    "corePid": 99999998,
                    "state": "stopped"
                }))
                .unwrap();
                storage::write(&registry_dir.join("service.json"), &service).unwrap();

                let before_bytes = b"before line\n";
                let before_sha = sha256_hex(before_bytes);
                let after_text = "after line\n";
                let after_sha = sha256_hex(after_text.as_bytes());
                let blob_path = registration.data_dir.join("blobs").join(&before_sha);
                std::fs::write(&blob_path, before_bytes).unwrap();
                std::fs::set_permissions(&blob_path, std::fs::Permissions::from_mode(0o600))
                    .unwrap();

                let thread_id = uuid::Uuid::new_v4().to_string();
                let record = json!({
                    "version": 17,
                    "thread": {
                        "id": thread_id,
                        "sessionId": thread_id,
                        "parentThreadId": Value::Null,
                        "preview": "turn review",
                        "modelProvider": "fixture",
                        "createdAt": 1,
                        "updatedAt": 2,
                        "status": { "type": "idle" },
                        "cwd": workspace,
                        "cliVersion": "fixture",
                        "source": "cli",
                        "ephemeral": false,
                        "turns": [{
                            "id": "turn-1",
                            "status": "completed",
                            "items": [
                                {
                                    "id": "write-ok",
                                    "callId": "call-ok",
                                    "type": "dynamicToolCall",
                                    "tool": "fs_write",
                                    "status": "completed",
                                    "success": true,
                                    "arguments": {
                                        "path": "workspace://repo/a.txt",
                                        "text": after_text,
                                        "expectedSha256": before_sha
                                    },
                                    "execution": {
                                        "backend": "runtime",
                                        "runtimeEpoch": "epoch-1",
                                        "scopeId": "scope-1",
                                        "operationId": "op-ok",
                                        "outcome": "succeeded",
                                        "fileBefore": {
                                            "uri": format!("areal://blob/{before_sha}"),
                                            "mimeType": "application/octet-stream",
                                            "sizeBytes": before_bytes.len()
                                        }
                                    },
                                    "contentItems": [{
                                        "type": "text",
                                        "text": json!({
                                            "path": "workspace://repo/a.txt",
                                            "sha256": after_sha,
                                            "size": after_text.len()
                                        }).to_string()
                                    }]
                                },
                                {
                                    "id": "write-broken",
                                    "callId": "call-broken",
                                    "type": "dynamicToolCall",
                                    "tool": "fs_write",
                                    "status": "completed",
                                    "success": true,
                                    "arguments": {
                                        "path": "workspace://repo/broken.txt",
                                        "text": "new\n",
                                        "expectedSha256": "f".repeat(64)
                                    },
                                    "execution": {
                                        "backend": "runtime",
                                        "runtimeEpoch": "epoch-1",
                                        "scopeId": "scope-1",
                                        "operationId": "op-broken",
                                        "outcome": "succeeded"
                                    },
                                    "contentItems": [{
                                        "type": "text",
                                        "text": json!({
                                            "path": "workspace://repo/broken.txt",
                                            "sha256": sha256_hex(b"new\n"),
                                            "size": 4
                                        }).to_string()
                                    }]
                                }
                            ]
                        }]
                    }
                });
                let record_path = registration.data_dir.join(format!("{thread_id}.json"));
                storage::write(&record_path, &record).unwrap();
                areal_engine::PersistedConversation::read(
                    &registration.data_dir,
                    &registration.workspace,
                    &thread_id,
                )
                .unwrap();

                let whole_turn = run_cmd(
                    &host,
                    json!({
                        "projectId": alias,
                        "operation": "turnReview",
                        "threadId": thread_id,
                        "turnId": "turn-1"
                    }),
                )
                .await
                .unwrap();
                assert_eq!(whole_turn["scope"], "last-turn");
                assert_eq!(whole_turn["files"][0]["path"], "a.txt");
                assert_eq!(whole_turn["files"][0]["beforeText"], "before line\n");
                assert_eq!(whole_turn["files"][0]["afterText"], "after line\n");
                assert_eq!(whole_turn["unavailableFiles"][0]["path"], "broken.txt");

                let single_item = run_cmd(
                    &host,
                    json!({
                        "projectId": alias,
                        "operation": "turnReview",
                        "threadId": thread_id,
                        "turnId": "turn-1",
                        "itemId": "write-ok"
                    }),
                )
                .await
                .unwrap();
                assert_eq!(single_item["scope"], "tool");
                assert_eq!(single_item["itemId"], "write-ok");
                assert!(
                    single_item["unavailableFiles"]
                        .as_array()
                        .unwrap()
                        .is_empty()
                );

                // Core must remain stopped (no wake triggered).
                assert!(
                    host.schedules
                        .connections
                        .shared_identity(&host, "project")
                        .is_err()
                );
            })
            .await;
    }
}
