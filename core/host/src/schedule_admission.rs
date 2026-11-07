use crate::{ProjectRegistration, wire::error};
use anyhow::{Context, Result, ensure};
use areal_local_service::storage;
use areal_protocol::tasks::{RunStatus, TaskMode, TaskRun};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{File, OpenOptions},
    future::Future,
    io::{ErrorKind, Write},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Clone)]
pub(crate) struct AdmissionProject {
    pub registration: ProjectRegistration,
    pub metadata_home: PathBuf,
    pub legacy_project_id: String,
    pub scope: Option<PathBuf>,
}
fn workspace(project: &AdmissionProject) -> &Path {
    project
        .scope
        .as_deref()
        .unwrap_or(&project.registration.workspace)
}

pub(crate) trait AdmissionRpc {
    fn request<'a>(
        &'a self,
        project_id: &'a str,
        method: &'a str,
        params: Value,
    ) -> impl Future<Output = Result<Value>> + 'a;
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Task {
    id: String,
    owner: String,
    mode: TaskMode,
    cancelled: bool,
    thread_id: Option<String>,
    source_thread_id: Option<String>,
    runs: Vec<TaskRun>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Family {
    kind: String,
    id: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Reservation {
    version: u32,
    project_id: String,
    root: PathBuf,
    cwd: PathBuf,
    allocation_id: String,
    family: Family,
    token: String,
    task_request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    execution_request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    anchor_thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    task_id: Option<String>,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}
enum Workspace {
    Source { cwd: PathBuf, anchor: String },
    Exclusive(Box<Reservation>),
}
impl Workspace {
    fn cwd(&self) -> &Path {
        match self {
            Self::Source { cwd, .. } => cwd,
            Self::Exclusive(value) => &value.cwd,
        }
    }
    fn anchor(&self) -> &str {
        match self {
            Self::Source { anchor, .. } => anchor,
            Self::Exclusive(value) => value.anchor_thread_id.as_deref().unwrap_or_default(),
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedProject {
    id: String,
    root: PathBuf,
    #[serde(default)]
    projectless: bool,
    projectless_request_id: Option<String>,
}
#[derive(Deserialize)]
struct Allocation {
    root: PathBuf,
    #[serde(default)]
    existing: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Author {
    version: u32,
    root: PathBuf,
    project_id: String,
    session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    creation_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    anchor_thread_id: Option<String>,
}

const SCRATCH_ID: &str = "00000000-0000-4000-a000-5c4a7c400001";
#[derive(Clone)]
struct ScratchClaim {
    request_id: String,
    digest: String,
    anchor: String,
}

fn scratch_root(project: &AdmissionProject) -> Result<Option<PathBuf>> {
    if !matches!(
        project.registration.source,
        crate::ProjectSource::Gui { .. }
    ) {
        return Ok(None);
    }
    let projects =
        read_optional::<Vec<SavedProject>>(&project.metadata_home.join("projects.json"))?
            .unwrap_or_default();
    let Some(saved) = projects
        .iter()
        .find(|saved| saved.id == project.legacy_project_id)
    else {
        return Ok(None);
    };
    if !saved.projectless || saved.projectless_request_id.as_deref() != Some(SCRATCH_ID) {
        return Ok(None);
    }
    let allocations = read_optional::<BTreeMap<String, Allocation>>(
        &project.metadata_home.join("projectless-drafts.json"),
    )?
    .unwrap_or_default();
    let allocation = allocations
        .get(SCRATCH_ID)
        .ok_or_else(|| reject("Scratch 目录分配身份不存在"))?;
    let root = saved.root.canonicalize()?;
    ensure!(
        saved.root == root
            && allocation.root == root
            && project.registration.workspace.canonicalize()? == root,
        reject("Scratch 目录登记身份不一致")
    );
    Ok(Some(root))
}

fn scratch_child(root: &Path, cwd: &Path) -> Result<PathBuf> {
    ensure!(
        cwd.parent() == Some(root),
        reject("Scratch 任务需要真实直接子目录")
    );
    let metadata = std::fs::symlink_metadata(cwd)?;
    ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        reject("Scratch 任务目录不可为链接")
    );
    let child = cwd.canonicalize()?;
    ensure!(
        child == cwd && child.parent() == Some(root),
        reject("Scratch 任务目录身份已变化")
    );
    Ok(child)
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Thread {
    id: String,
    session_id: String,
    cwd: PathBuf,
    parent_thread_id: Option<String>,
    goal_owner: Option<Value>,
    conversation: Option<Value>,
    source: Option<String>,
    desktop: Option<Value>,
    goals: Option<Value>,
}

fn reject(message: &str) -> anyhow::Error {
    error("scheduleWorkspaceRequired", message)
}
fn identifier(value: &str) -> bool {
    !value.is_empty() && value.encode_utf16().count() <= 256 && !value.contains(['\0', '\r', '\n'])
}
fn read_optional<T: DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}
fn reservation_file(project: &AdmissionProject) -> Result<PathBuf> {
    let id = &project.legacy_project_id;
    let valid = match project.registration.source {
        crate::ProjectSource::Cli => {
            identifier(id)
                && id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
        }
        crate::ProjectSource::Gui { .. } => {
            id.len() == 24
                && id
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        }
    };
    ensure!(valid, reject("定时任务工作区身份无效"));
    Ok(project
        .metadata_home
        .join("schedule-authors")
        .join(format!("{id}.json")))
}
fn reservation(project: &AdmissionProject) -> Result<Option<Reservation>> {
    let path = reservation_file(project)?;
    let Some(value) =
        read_optional::<Reservation>(&path).map_err(|_| reject("无法读取原定时任务目录预约"))?
    else {
        return Ok(None);
    };
    let token = format!(
        "schedule:{}",
        storage::digest(&serde_json::to_vec(&json!([
            project.legacy_project_id,
            value.family.kind,
            value.family.id
        ]))?)
    );
    ensure!(
        value.version == 1
            && value.project_id == project.legacy_project_id
            && value.token == token
            && !value.extra.contains_key("kind")
            && matches!(value.family.kind.as_str(), "draft" | "request")
            && identifier(&value.family.id)
            && [&value.task_request_id, &value.allocation_id, &value.token]
                .iter()
                .all(|v| !v.is_empty())
            && [
                &value.execution_request_id,
                &value.anchor_thread_id,
                &value.task_id
            ]
            .iter()
            .all(|v| v.as_ref().is_none_or(|v| identifier(v))),
        reject("定时任务目录预约无效")
    );
    Ok(Some(value))
}

async fn checkout_root(directory: &Path) -> Result<Option<PathBuf>> {
    let output = tokio::process::Command::new("git")
        .arg("-C")
        .arg(directory)
        .args(["rev-parse", "--show-toplevel"])
        .env("LC_ALL", "C")
        .output()
        .await?;
    if output.status.success() {
        let root = std::str::from_utf8(&output.stdout)?.trim();
        return Ok(Some(Path::new(root).canonicalize()?));
    }
    ensure!(
        output.status.code() == Some(128)
            && String::from_utf8_lossy(&output.stderr)
                .lines()
                .any(|line| line.starts_with("fatal: not a git repository (or ")),
        reject("Git 检出目录身份无法核对")
    );
    Ok(None)
}
async fn workspace_root(path: &Path) -> Result<PathBuf> {
    let cwd = path.canonicalize()?;
    Ok(checkout_root(&cwd).await?.unwrap_or(cwd))
}
async fn eligible(project: &AdmissionProject, value: &Reservation) -> Result<()> {
    let projects =
        read_optional::<Vec<SavedProject>>(&project.metadata_home.join("projects.json"))?
            .unwrap_or_default();
    let saved = projects
        .iter()
        .find(|saved| saved.id == project.legacy_project_id)
        .ok_or_else(|| reject("原定时任务的独立目录登记不存在"))?;
    let allocation_id = saved
        .projectless_request_id
        .as_ref()
        .ok_or_else(|| reject("原定时任务没有独立目录分配身份"))?;
    let allocations = read_optional::<BTreeMap<String, Allocation>>(
        &project.metadata_home.join("projectless-drafts.json"),
    )?
    .unwrap_or_default();
    let allocation = allocations
        .get(allocation_id)
        .ok_or_else(|| reject("原定时任务的独立目录分配不存在"))?;
    let root = project.registration.workspace.canonicalize()?;
    let cwd = value.cwd.canonicalize()?;
    ensure!(
        saved.projectless
            && !allocation.existing
            && allocation.root == root
            && saved.root.canonicalize()? == root
            && cwd.starts_with(&root)
            && value.root == root
            && value.allocation_id == *allocation_id,
        reject("定时任务需要为本任务自动分配的独立项目外目录")
    );
    ensure!(
        checkout_root(&root)
            .await?
            .is_none_or(|checkout| checkout == root),
        reject("任务目录位于共享 Git 检出内，不能作为独立调度目录")
    );
    Ok(())
}
async fn request<R: AdmissionRpc, T: DeserializeOwned>(
    rpc: &R,
    project: &AdmissionProject,
    method: &str,
    params: Value,
) -> Result<T> {
    Ok(serde_json::from_value(
        rpc.request(&project.registration.project_id, method, params)
            .await?,
    )?)
}
async fn read_thread<R: AdmissionRpc>(
    rpc: &R,
    project: &AdmissionProject,
    id: &str,
) -> Result<Thread> {
    #[derive(Deserialize)]
    struct Response {
        thread: Thread,
    }
    let response: Response = request(
        rpc,
        project,
        "thread/read",
        json!({"threadId":id,"includeTurns":false}),
    )
    .await?;
    let thread = response.thread;
    ensure!(
        thread.id == id && identifier(&thread.session_id),
        reject("会话执行身份尚未确认")
    );
    ensure!(
        thread.desktop.as_ref().is_none_or(Value::is_object)
            && thread.goals.as_ref().is_none_or(Value::is_object),
        reject("定时执行会话目标结构无效")
    );
    if let Some(conversation) = &thread.conversation {
        ensure!(
            conversation.is_object()
                && conversation.get("kind").is_none_or(Value::is_string)
                && conversation.get("origin").is_none_or(|origin| {
                    origin.is_object() && origin.get("sourceThreadId").is_none_or(Value::is_string)
                }),
            reject("会话来源身份尚未确认")
        );
    }
    if let Some(owner) = &thread.goal_owner {
        ensure!(
            owner.is_object() && owner["threadId"].is_string() && owner["goalId"].is_string(),
            reject("定时执行会话目标结构无效")
        );
    }
    if let Some(goal) = thread
        .goals
        .as_ref()
        .and_then(|goals| goals.get("goal"))
        .filter(|goal| !goal.is_null())
    {
        ensure!(
            goal.is_object()
                && ["id", "threadId", "status"]
                    .iter()
                    .all(|key| goal[key].is_string())
                && goal
                    .get("activeTurnId")
                    .is_none_or(|id| id.is_null() || id.is_string()),
            reject("定时执行会话目标结构无效")
        );
    }
    Ok(thread)
}
fn ordinary(thread: &Thread) -> bool {
    thread
        .parent_thread_id
        .as_ref()
        .is_none_or(|id| id.is_empty())
        && thread.goal_owner.is_none()
        && thread
            .conversation
            .as_ref()
            .is_none_or(|value| value["kind"] != "side")
}
async fn source_workspace<R: AdmissionRpc>(
    rpc: &R,
    project: &AdmissionProject,
    task: &Task,
) -> Result<(Workspace, String)> {
    let source_id = task.source_thread_id.as_deref().filter(|id| identifier(id));
    let anchor_id = task.thread_id.as_deref().filter(|id| identifier(id));
    if matches!(project.registration.source, crate::ProjectSource::Cli)
        && task.source_thread_id.is_none()
    {
        ensure!(
            task.mode == TaskMode::Scheduled
                && task.owner == "desktop-owner"
                && !task.cancelled
                && identifier(&task.id)
                && anchor_id.is_some(),
            reject("CLI 定时任务执行锚点身份尚未确认")
        );
        let anchor_id = anchor_id.unwrap();
        let anchor = read_thread(rpc, project, anchor_id).await?;
        ensure!(
            ordinary(&anchor)
                && anchor.source.as_deref() != Some("nativeTaskAgent")
                && anchor
                    .desktop
                    .as_ref()
                    .is_none_or(|value| value["configuration"]["readOnly"] != true),
            reject("CLI 定时任务执行锚点不可写或不是普通会话")
        );
        let root = project.registration.workspace.canonicalize()?;
        let cwd = anchor.cwd.canonicalize()?;
        ensure!(
            cwd.starts_with(&root),
            reject("CLI 定时任务执行目录不属于登记项目")
        );
        return Ok((
            Workspace::Source {
                cwd,
                anchor: anchor_id.into(),
            },
            anchor.session_id,
        ));
    }
    ensure!(
        task.mode == TaskMode::Scheduled
            && task.owner == "desktop-owner"
            && !task.cancelled
            && identifier(&task.id)
            && source_id.is_some()
            && anchor_id.is_some()
            && source_id != anchor_id,
        reject("普通来源安排的桌面宿主身份尚未确认")
    );
    let source_id = source_id.unwrap();
    let anchor_id = anchor_id.unwrap();
    let source = read_thread(rpc, project, source_id).await?;
    let anchor = read_thread(rpc, project, anchor_id).await?;
    ensure!(
        ordinary(&source)
            && ordinary(&anchor)
            && source.source.as_deref() != Some("nativeTaskAgent")
            && source.desktop.as_ref().is_some_and(
                |value| value.is_object() && value["configuration"]["readOnly"] != true
            ),
        reject("普通来源安排的来源或执行锚点尚未确认")
    );
    let root = project.registration.workspace.canonicalize()?;
    let cwd = source.cwd.canonicalize()?;
    ensure!(
        cwd.starts_with(&root) && anchor.cwd.canonicalize()? == cwd,
        reject("普通来源安排的来源、执行锚点或运行目录已变化")
    );
    Ok((
        Workspace::Source {
            cwd,
            anchor: anchor_id.into(),
        },
        source.session_id,
    ))
}

async fn catalog<R: AdmissionRpc>(
    rpc: &R,
    project: &AdmissionProject,
    session: &str,
) -> Result<Vec<Task>> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Page {
        data: Vec<Task>,
        next_cursor: Option<String>,
        has_more: Option<bool>,
    }
    let schedule = if session.starts_with("schedule:") {
        reservation(project)?
    } else {
        None
    };
    let scratch = scratch_root(project)?.filter(|_| project.scope.is_some());
    let mut rows = Vec::new();
    let mut after: Option<String> = None;
    let mut seen = BTreeSet::new();
    for _ in 0..1000 {
        let raw = rpc
            .request(
                &project.registration.project_id,
                "areal/task/list",
                json!({"limit":100,"after":after}),
            )
            .await?;
        ensure!(
            raw.get("nextCursor").is_some(),
            reject("任务目录分页状态尚未确认")
        );
        let page: Page = serde_json::from_value(raw)?;
        ensure!(
            page.next_cursor.as_deref() != Some("")
                && page
                    .has_more
                    .is_none_or(|more| more == page.next_cursor.is_some()),
            reject("任务目录分页状态尚未确认")
        );
        let mut previous = after.clone();
        let mut scoped_rows = Vec::new();
        for task in &page.data {
            ensure!(
                identifier(&task.id)
                    && seen.insert(task.id.clone())
                    && previous.as_ref().is_none_or(|previous| task.id > *previous),
                reject("任务目录包含无法核对的执行身份")
            );
            previous = Some(task.id.clone());
            if task.mode != TaskMode::Scheduled {
                continue;
            }
            if let Some(root) = &scratch {
                let anchor_id = task
                    .thread_id
                    .as_deref()
                    .filter(|id| identifier(id))
                    .ok_or_else(|| reject("Scratch 任务缺少执行锚点"))?;
                let anchor = read_thread(rpc, project, anchor_id).await?;
                let cwd = scratch_child(root, &anchor.cwd)?;
                if cwd != workspace(project) {
                    continue;
                }
                ensure!(
                    anchor.session_id == session,
                    reject("Scratch 目录已有其他任务作者")
                );
                scoped_rows.push(task.clone());
                continue;
            }
            if task.cancelled {
                continue;
            }
            if matches!(project.registration.source, crate::ProjectSource::Cli)
                && task.source_thread_id.is_none()
                && !session.starts_with("schedule:")
            {
                let current: Task =
                    request(rpc, project, "areal/task/read", json!({"taskId":task.id})).await?;
                ensure!(current.id == task.id, reject("CLI 定时任务身份已变化"));
                let (_, family) = source_workspace(rpc, project, &current).await?;
                ensure!(
                    family == session,
                    reject("目录仍有另一个 CLI 执行锚点的定时任务")
                );
                continue;
            }
            if task
                .source_thread_id
                .as_ref()
                .is_some_and(|id| !id.is_empty())
                && !session.starts_with("schedule:")
            {
                let current: Task =
                    request(rpc, project, "areal/task/read", json!({"taskId":task.id})).await?;
                ensure!(
                    current.id == task.id,
                    reject("普通来源安排的任务身份已变化")
                );
                source_workspace(rpc, project, &current).await?;
                continue;
            }
            ensure!(
                schedule
                    .as_ref()
                    .is_some_and(|schedule| schedule.token == session
                        && schedule.task_id.as_deref() == Some(&task.id)
                        && schedule.anchor_thread_id == task.thread_id),
                reject("目录仍有不属于已核对调度家庭的定时任务，休眠或暂停不释放执行资格")
            );
        }
        if scratch.is_some() {
            rows.extend(scoped_rows);
        } else {
            rows.extend(page.data.iter().cloned());
        }
        if page.next_cursor.is_none() {
            ensure!(
                scratch.is_none() || rows.len() <= 1,
                reject("Scratch 目录存在多个定时任务")
            );
            return Ok(rows);
        }
        ensure!(
            !page.data.is_empty() && page.next_cursor == previous,
            reject("任务目录分页未前进，不能放行写入")
        );
        after = page.next_cursor;
    }
    Err(reject("任务目录尚未完整核对，不能放行写入"))
}

async fn checkout_peers<'a>(
    project: &'a AdmissionProject,
    peers: &'a [AdmissionProject],
    root: &Path,
    exclusive: bool,
) -> Result<Vec<&'a AdmissionProject>> {
    let saved = read_optional::<Vec<SavedProject>>(&project.metadata_home.join("projects.json"))?
        .unwrap_or_default();
    let mut paths = peers
        .iter()
        .filter(|other| other.registration.project_id != project.registration.project_id)
        .map(|other| (other.registration.workspace.clone(), Some(other)))
        .collect::<Vec<_>>();
    for saved in saved {
        if saved.id == project.legacy_project_id {
            continue;
        }
        if !peers.iter().any(|peer| {
            peer.metadata_home == project.metadata_home && peer.legacy_project_id == saved.id
        }) {
            paths.push((saved.root, None));
        }
    }
    let mut output = BTreeMap::new();
    for (path, peer) in paths {
        let other = match workspace_root(&path).await {
            Ok(path) => path,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == ErrorKind::NotFound)
                    && !path.starts_with(root)
                    && !root.starts_with(&path) =>
            {
                continue;
            }
            Err(error) => return Err(error),
        };
        ensure!(
            !exclusive || other == root || (!other.starts_with(root) && !root.starts_with(&other)),
            reject("不同检出或非 Git 执行目录物理重叠，无法确认独占作者")
        );
        if other != root {
            continue;
        }
        let peer = peer.ok_or_else(|| reject("同一检出目录的其他任务目录尚不可核对"))?;
        output.insert(peer.registration.project_id.clone(), peer);
    }
    Ok(output.into_values().collect())
}
fn read_author(path: &Path, root: Option<&Path>) -> Result<Option<Author>> {
    let Some(value) = read_optional::<Author>(path).map_err(|_| reject("目录作者记录无法读取"))?
    else {
        return Ok(None);
    };
    ensure!(
        value.version == 1
            && value.root.is_absolute()
            && !value.project_id.is_empty()
            && !value.session_id.is_empty()
            && root.is_none_or(|root| value.root == root),
        reject("目录作者记录与执行目录不匹配")
    );
    Ok(Some(value))
}
fn overlapping(directory: &Path, root: &Path, schedules_only: bool) -> Result<()> {
    for entry in std::fs::read_dir(directory)? {
        let path = entry?.path();
        if path.extension().is_none_or(|extension| extension != "json") {
            continue;
        }
        let author = read_author(&path, None)?.ok_or_else(|| reject("已有目录作者记录无法核对"))?;
        if schedules_only && !author.session_id.starts_with("schedule:") {
            continue;
        }
        ensure!(
            !(schedules_only && author.root == root)
                && (author.root == root
                    || (!author.root.starts_with(root) && !root.starts_with(&author.root))),
            reject("重叠目录已有作者记录，须核查旧执行身份")
        );
    }
    Ok(())
}
struct ClaimLock {
    path: PathBuf,
    _file: File,
}
impl Drop for ClaimLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}
async fn claim_lock(directory: &Path) -> Result<ClaimLock> {
    let path = directory.join("claim.lock");
    for _ in 0..100 {
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
        {
            Ok(file) => return Ok(ClaimLock { path, _file: file }),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                tokio::time::sleep(Duration::from_millis(10)).await
            }
            Err(error) => return Err(error.into()),
        }
    }
    Err(reject("目录作者登记仍在处理中或中断后尚未核对"))
}
async fn author_session<R: AdmissionRpc>(
    rpc: &R,
    project: &AdmissionProject,
    thread: Thread,
) -> Result<String> {
    let owner = if thread
        .parent_thread_id
        .as_ref()
        .is_some_and(|id| !id.is_empty())
    {
        read_thread(rpc, project, &thread.session_id).await?
    } else {
        thread
    };
    let executable_side = owner.conversation.as_ref().is_some_and(|conversation| {
        conversation["kind"] == "side" && conversation["policy"]["kind"] == "sideExecutableV2"
    });
    if !executable_side {
        return Ok(owner.session_id);
    }
    let conversation = owner.conversation.as_ref().unwrap();
    let id = conversation["origin"]["sourceThreadId"]
        .as_str()
        .context("side source identity missing")?;
    let source = read_thread(rpc, project, id).await?;
    ensure!(
        conversation["version"] == 2
            && source
                .parent_thread_id
                .as_ref()
                .is_none_or(|id| id.is_empty())
            && source
                .conversation
                .as_ref()
                .is_none_or(|value| value["kind"] != "side")
            && owner.cwd.canonicalize()? == source.cwd.canonicalize()?
            && owner.cwd.canonicalize()? == workspace(project).canonicalize()?,
        reject("可执行旁路讨论的来源与执行目录尚未确认")
    );
    Ok(source.session_id)
}
async fn existing_effects<R: AdmissionRpc>(
    rpc: &R,
    project: &AdmissionProject,
    session: &str,
) -> Result<()> {
    let status = rpc
        .request(
            &project.registration.project_id,
            "areal/server/status",
            json!({}),
        )
        .await?;
    let arrays = [
        "activeTurns",
        "resources",
        "unresolvedTools",
        "activeGoals",
        "compactions",
        "workgroups",
    ];
    ensure!(
        status["acceptingWork"] == true
            && arrays.iter().all(|key| status[key].is_array())
            && status["activeTasks"].as_u64().is_some()
            && status["pendingQueueItems"].as_u64().is_some(),
        reject("后台执行状态尚未确认")
    );
    let scratch = scratch_root(project)?.filter(|_| project.scope.is_some());
    if scratch.is_some() && (status["activeTasks"] != 0 || status["pendingQueueItems"] != 0) {
        let overview = rpc
            .request(
                &project.registration.project_id,
                "areal/work/overview",
                json!({"limit":100}),
            )
            .await?;
        ensure!(
            overview["complete"] == true && overview["nextCursor"].is_null(),
            reject("Scratch 活动归属超出有界检查")
        );
        let mut tasks = BTreeSet::new();
        let mut queues = BTreeMap::<String, u64>::new();
        for row in overview["data"]
            .as_array()
            .ok_or_else(|| reject("Scratch 活动归属不可用"))?
        {
            let active = row["kind"] == "taskRun"
                && matches!(
                    row["execution"]["state"].as_str(),
                    Some("queued" | "running" | "waitingForInput" | "waitingForAgents")
                );
            let queue = row["queue"]["pendingCount"]
                .as_u64()
                .ok_or_else(|| reject("Scratch 队列归属不可用"))?;
            if !active && queue == 0 {
                continue;
            }
            let task_id = row["taskId"].as_str();
            if active {
                tasks.insert(
                    task_id
                        .ok_or_else(|| reject("Scratch 活动任务身份不可用"))?
                        .to_owned(),
                );
            }
            let thread_id = if let Some(id) = row["threadId"].as_str() {
                id.to_owned()
            } else {
                let task: Task =
                    request(rpc, project, "areal/task/read", json!({"taskId":task_id})).await?;
                task.thread_id
                    .ok_or_else(|| reject("Scratch 活动任务锚点不可用"))?
            };
            if queue > 0 {
                if let Some(previous) = queues.insert(thread_id.clone(), queue) {
                    ensure!(previous == queue, reject("Scratch 队列快照不一致"));
                }
            }
            let thread = read_thread(rpc, project, &thread_id).await?;
            let cwd = thread.cwd.canonicalize()?;
            if cwd == workspace(project) {
                ensure!(
                    author_session(rpc, project, thread).await? == session,
                    reject("Scratch 目录已有其他活动作者")
                );
            } else {
                ensure!(
                    !cwd.starts_with(workspace(project)) && !workspace(project).starts_with(&cwd),
                    reject("Scratch 活动目录物理重叠")
                );
            }
        }
        ensure!(
            Some(tasks.len() as u64) == status["activeTasks"].as_u64()
                && Some(queues.values().sum::<u64>()) == status["pendingQueueItems"].as_u64(),
            reject("Scratch 活动数量无法完整归属")
        );
        let confirmed = rpc
            .request(
                &project.registration.project_id,
                "areal/work/overview",
                json!({"limit":100}),
            )
            .await?;
        ensure!(confirmed == overview, reject("Scratch 活动归属已变化"));
        let after = rpc
            .request(
                &project.registration.project_id,
                "areal/server/status",
                json!({}),
            )
            .await?;
        ensure!(
            [
                "acceptingWork",
                "activeTasks",
                "pendingQueueItems",
                "activeTurns",
                "resources",
                "unresolvedTools",
                "activeGoals",
                "compactions",
                "workgroups"
            ]
            .iter()
            .all(|key| after[*key] == status[*key]),
            reject("Scratch 活动状态已变化")
        );
    } else {
        ensure!(
            status["activeTasks"] == 0 && status["pendingQueueItems"] == 0,
            reject("后台仍有待结算或无法归属的执行")
        );
    }
    ensure!(
        status["unresolvedTools"].as_array().unwrap().is_empty()
            && status["workgroups"]
                .as_array()
                .unwrap()
                .iter()
                .all(|group| group["status"] != "running" && group["cleanupConfirmed"] == true),
        reject("后台仍有待结算或无法归属的执行")
    );
    let mut ids = BTreeSet::new();
    for key in ["activeGoals", "compactions"] {
        for value in status[key].as_array().unwrap() {
            ids.insert(
                value
                    .as_str()
                    .ok_or_else(|| reject("后台执行状态尚未确认"))?
                    .to_owned(),
            );
        }
    }
    for value in status["activeTurns"].as_array().unwrap() {
        ids.insert(
            value["threadId"]
                .as_str()
                .ok_or_else(|| reject("后台执行状态尚未确认"))?
                .to_owned(),
        );
    }
    for resource in status["resources"].as_array().unwrap() {
        let id = resource["threadId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| reject("后台进程或子任务的写入归属尚未确认"))?;
        ensure!(
            !resource["state"]
                .as_str()
                .is_some_and(|state| matches!(state, "cleanupUnknown" | "unavailable" | "closing")),
            reject("后台进程或子任务的写入归属尚未确认")
        );
        ids.insert(id.into());
    }
    for id in ids {
        let thread = read_thread(rpc, project, &id).await?;
        if scratch.is_some() {
            let cwd = thread.cwd.canonicalize()?;
            if cwd != workspace(project) {
                ensure!(
                    !cwd.starts_with(workspace(project)) && !workspace(project).starts_with(&cwd),
                    reject("Scratch 活动目录物理重叠")
                );
                continue;
            }
        }
        ensure!(
            author_session(rpc, project, thread).await? == session,
            reject("此目录已有其他会话或其后台任务在执行")
        );
    }
    Ok(())
}
async fn directory_admission<R: AdmissionRpc>(
    rpc: &R,
    project: &AdmissionProject,
    peers: &[AdmissionProject],
    session: &str,
    exclusive: bool,
) -> Result<()> {
    directory_admission_inner(rpc, project, peers, session, exclusive, None).await
}
async fn directory_admission_inner<R: AdmissionRpc>(
    rpc: &R,
    project: &AdmissionProject,
    peers: &[AdmissionProject],
    session: &str,
    exclusive: bool,
    scratch: Option<&ScratchClaim>,
) -> Result<()> {
    let root = workspace_root(workspace(project)).await?;
    let checkout_peers = checkout_peers(project, peers, &root, exclusive).await?;
    catalog(rpc, project, session).await?;
    for peer in &checkout_peers {
        catalog(rpc, peer, session).await?;
    }
    // 迁移后多个 GUI 来源共享 Host，原来源中的独占作者记录仍然有效。
    let other_homes = peers
        .iter()
        .map(|peer| &peer.metadata_home)
        .filter(|home| **home != project.metadata_home)
        .collect::<BTreeSet<_>>();
    for home in other_homes {
        let directory = home.join("workspace-authors");
        let _lock = match claim_lock(&directory).await {
            Ok(lock) => lock,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == ErrorKind::NotFound) =>
            {
                continue;
            }
            Err(error) => return Err(error),
        };
        overlapping(&directory, &root, !exclusive)?;
        if exclusive {
            let file = directory.join(format!(
                "{}.json",
                storage::digest(root.as_os_str().as_encoded_bytes())
            ));
            ensure!(
                read_author(&file, Some(&root))?.is_none_or(|author| author.session_id == session),
                reject("此执行目录已保留给另一个会话及其后台任务")
            );
        }
    }
    let directory = project.metadata_home.join("workspace-authors");
    if !exclusive {
        let lock = match claim_lock(&directory).await {
            Ok(lock) => Some(lock),
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == ErrorKind::NotFound) =>
            {
                None
            }
            Err(error) => return Err(error),
        };
        if lock.is_some() {
            overlapping(&directory, &root, true)?;
        }
        ensure!(
            reservation(project)?.is_none(),
            reject("此目录已保留给独立定时任务家庭")
        );
        return Ok(());
    }
    storage::private_dir(&directory)?;
    overlapping(&directory, &root, false)?;
    let file = directory.join(format!(
        "{}.json",
        storage::digest(root.as_os_str().as_encoded_bytes())
    ));
    let mut author = read_author(&file, Some(&root))?;
    if author.is_none() {
        let _lock = claim_lock(&directory).await?;
        overlapping(&directory, &root, false)?;
        author = read_author(&file, Some(&root))?;
        if author.is_none() {
            existing_effects(rpc, project, session).await?;
            for peer in &checkout_peers {
                existing_effects(rpc, peer, session).await?;
            }
            let temporary = directory.join(format!("{}.tmp", uuid::Uuid::new_v4()));
            let mut handle = OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(&temporary)?;
            let mut value = json!({"version":1,"root":root,"projectId":project.legacy_project_id,"sessionId":session});
            if let Some(claim) = scratch {
                value["requestId"] = json!(claim.request_id);
                value["creationDigest"] = json!(claim.digest);
                value["anchorThreadId"] = json!(claim.anchor);
            }
            let written = (|| -> Result<()> {
                handle.write_all(&serde_json::to_vec(&value)?)?;
                handle.sync_all()?;
                Ok(())
            })();
            drop(handle);
            let linked = written.and_then(|()| match std::fs::hard_link(&temporary, &file) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == ErrorKind::AlreadyExists => Ok(()),
                Err(error) => Err(error.into()),
            });
            std::fs::remove_file(&temporary)?;
            linked?;
            author = read_author(&file, Some(&root))?;
        }
    }
    ensure!(
        author.is_some_and(|author| author.session_id == session
            && scratch.is_none_or(
                |claim| author.request_id.as_deref() == Some(&claim.request_id)
                    && author.creation_digest.as_deref() == Some(&claim.digest)
                    && author.anchor_thread_id.as_deref() == Some(&claim.anchor)
            )),
        reject("此执行目录已保留给另一个会话及其后台任务")
    );
    Ok(())
}

async fn task_workspace<R: AdmissionRpc>(
    rpc: &R,
    project: &AdmissionProject,
    peers: &[AdmissionProject],
    task: &Task,
) -> Result<Workspace> {
    task_workspace_inner(rpc, project, peers, task, false).await
}
async fn task_workspace_inner<R: AdmissionRpc>(
    rpc: &R,
    project: &AdmissionProject,
    peers: &[AdmissionProject],
    task: &Task,
    allow_cancelled: bool,
) -> Result<Workspace> {
    if let Some(root) = scratch_root(project)? {
        ensure!(
            project.registration.workspace.canonicalize()? == root,
            reject("Scratch 项目根身份已变化")
        );
        ensure!(
            task.mode == TaskMode::Scheduled
                && task.owner == "desktop-owner"
                && (allow_cancelled || !task.cancelled)
                && task.source_thread_id.is_none(),
            reject("Scratch 任务身份无效")
        );
        let anchor_id = task
            .thread_id
            .as_deref()
            .filter(|id| identifier(id))
            .ok_or_else(|| reject("Scratch 任务缺少执行锚点"))?;
        let anchor = read_thread(rpc, project, anchor_id).await?;
        ensure!(
            ordinary(&anchor)
                && anchor.source.as_deref() != Some("nativeTaskAgent")
                && anchor
                    .desktop
                    .as_ref()
                    .is_none_or(|v| v["configuration"]["readOnly"] != true),
            reject("Scratch 任务锚点无效")
        );
        let child = scratch_child(&root, &anchor.cwd)?;
        let file = project
            .metadata_home
            .join("workspace-authors")
            .join(format!(
                "{}.json",
                storage::digest(child.as_os_str().as_encoded_bytes())
            ));
        let author = read_author(&file, Some(&child))?
            .ok_or_else(|| reject("Scratch 原目录作者尚未确认"))?;
        let request_id = author
            .request_id
            .as_deref()
            .filter(|id| identifier(id))
            .ok_or_else(|| reject("Scratch 原创建请求尚未确认"))?;
        let digest = author
            .creation_digest
            .as_deref()
            .ok_or_else(|| reject("Scratch 原创建摘要尚未确认"))?;
        ensure!(
            author.project_id == project.legacy_project_id
                && author.session_id == anchor.session_id
                && author.anchor_thread_id.as_deref() == Some(anchor_id),
            reject("Scratch 原作者身份已变化")
        );
        let receipts = rpc
            .request(
                &project.registration.project_id,
                "areal/request/read",
                json!({"requestId":request_id}),
            )
            .await?;
        let matching: Vec<_> = receipts["data"]
            .as_array()
            .ok_or_else(|| reject("原任务创建回执不可用"))?
            .iter()
            .filter(|receipt| {
                receipt["method"] == "areal/task/create"
                    && receipt["requestId"] == request_id
                    && receipt["digest"] == digest
                    && receipt["result"]["id"] == task.id
                    && receipt["result"]["threadId"] == anchor_id
                    && receipt["status"] == "completed"
            })
            .collect();
        ensure!(matching.len() == 1, reject("原任务创建回执尚未唯一确认"));
        let mut scoped = project.clone();
        scoped.scope = Some(child.clone());
        let claim = ScratchClaim {
            request_id: request_id.into(),
            digest: digest.into(),
            anchor: anchor_id.into(),
        };
        directory_admission_inner(rpc, &scoped, peers, &anchor.session_id, true, Some(&claim))
            .await?;
        return Ok(Workspace::Source {
            cwd: child,
            anchor: anchor_id.into(),
        });
    }
    let workspace = match reservation(project)? {
        None => {
            let (workspace, session) = source_workspace(rpc, project, &task).await?;
            directory_admission(rpc, project, peers, &session, false).await?;
            workspace
        }
        Some(mut value) => {
            eligible(project, &value).await?;
            ensure!(
                task.thread_id == value.anchor_thread_id,
                reject("原安排的目录或执行锚点已变化")
            );
            if value.task_id.is_none() {
                let receipts = rpc
                    .request(
                        &project.registration.project_id,
                        "areal/request/read",
                        json!({"requestId":value.task_request_id}),
                    )
                    .await?;
                let receipt = receipts["data"].as_array().and_then(|data| {
                    data.iter().find(|receipt| {
                        receipt
                            .get("method")
                            .unwrap_or(&receipt["operation"]["method"])
                            == "areal/task/create"
                            && receipt
                                .get("requestId")
                                .or_else(|| receipt["operation"].get("requestId"))
                                .and_then(Value::as_str)
                                == Some(value.task_request_id.as_str())
                    })
                });
                let bound = receipt
                    .and_then(|receipt| {
                        receipt
                            .get("result")
                            .or_else(|| receipt["response"].get("result"))
                    })
                    .and_then(|result| result["id"].as_str())
                    .or_else(|| receipt.and_then(|receipt| receipt["taskId"].as_str()));
                ensure!(
                    bound == Some(&task.id),
                    reject("原任务创建结果尚未核对，不会将回调绑定到其他安排")
                );
                value =
                    reservation(project)?.ok_or_else(|| reject("定时任务与原目录预约不匹配"))?;
                ensure!(
                    task.thread_id == value.anchor_thread_id
                        && value.task_id.as_deref().is_none_or(|id| id == task.id),
                    reject("定时任务与原目录预约不匹配")
                );
                value.task_id = Some(task.id.clone());
                storage::write(&reservation_file(project)?, &value)?;
            }
            ensure!(
                value.task_id.as_deref() == Some(&task.id),
                reject("此目录属于另一个定时任务，不会改绑")
            );
            directory_admission(rpc, project, peers, &value.token, true).await?;
            Workspace::Exclusive(Box::new(value))
        }
    };
    Ok(workspace)
}

/// 桌面命令与调度回调共用同一目录作者、任务家庭与运行身份检查。
pub(crate) async fn command<R: AdmissionRpc>(
    project: &AdmissionProject,
    peers: &[AdmissionProject],
    name: &str,
    params: &Value,
    rpc: &R,
) -> Result<()> {
    let operation = params["operation"].as_str().unwrap_or("");
    if name == "manage" && matches!(operation, "taskDraftStart" | "taskDraftConfirm") {
        return Ok(());
    }
    if name == "manage" && operation == "taskCreate" && params["mode"] == "scheduled" {
        return Ok(());
    }
    if name == "manage"
        && matches!(
            operation,
            "taskRunNow" | "taskResume" | "taskResumeRun" | "taskReply" | "taskUpdate"
        )
    {
        if let Some(id) = params["taskId"].as_str().filter(|id| identifier(id)) {
            let task: Task = request(rpc, project, "areal/task/read", json!({"taskId":id})).await?;
            ensure!(task.id == id, reject("任务执行身份尚未确认"));
            if task.mode == TaskMode::Scheduled {
                task_workspace(rpc, project, peers, &task).await?;
                return Ok(());
            }
        }
    }
    let targets = ["threadId", "parentThreadId", "sourceThreadId"]
        .into_iter()
        .filter_map(|field| params[field].as_str().filter(|id| identifier(id)))
        .collect::<BTreeSet<_>>();
    ensure!(!targets.is_empty(), reject("写入需要绑定到具体会话"));
    let mut threads = Vec::new();
    let mut authors = BTreeSet::new();
    for id in targets {
        let thread = read_thread(rpc, project, id).await?;
        let mut scoped = project.clone();
        if let Some(root) = scratch_root(project)? {
            scoped.scope = Some(scratch_child(&root, &thread.cwd)?);
        }
        authors.insert(author_session(rpc, &scoped, thread.clone()).await?);
        threads.push(thread);
    }
    ensure!(authors.len() == 1, reject("一次执行不能包含不同会话作者"));
    let session = authors.into_iter().next().unwrap();
    if (name == "send" || name == "manage" && operation == "taskDraftSend")
        && threads.iter().all(|thread| {
            thread.desktop.as_ref().is_some_and(|desktop| {
                let options = &desktop["configuration"]["options"];
                options["readOnly"] == true
                    && options["appendInstructions"]
                        .as_str()
                        .is_some_and(|text| text.starts_with("AREAL_TASK_DRAFT_V1\n"))
                    && options["toolAllowlist"]
                        .as_array()
                        .is_some_and(Vec::is_empty)
            })
        })
    {
        return Ok(());
    }
    if name == "manage"
        && matches!(operation, "archive" | "unarchive")
        && threads.iter().any(|thread| {
            thread.id == params["threadId"]
                && thread.conversation.as_ref().is_some_and(|conversation| {
                    conversation["kind"] == "side"
                        && conversation["policy"]["kind"] == "sideReadOnlyV1"
                })
        })
    {
        return Ok(());
    }
    ensure!(
        threads.iter().all(|thread| thread
            .conversation
            .as_ref()
            .is_none_or(|conversation| conversation["kind"] != "side"
                || conversation["policy"]["kind"] == "sideExecutableV2")),
        reject("旁路讨论不能作为工作区作者执行写入")
    );
    if matches!(name, "respond" | "continue")
        && scheduled_command(rpc, project, peers, name, params, &threads, &session).await?
    {
        return Ok(());
    }
    if let Some(root) = scratch_root(project)? {
        let first = threads
            .first()
            .ok_or_else(|| reject("Scratch 执行会话缺失"))?;
        let child = scratch_child(&root, &first.cwd)?;
        ensure!(
            threads.iter().all(|thread| thread.cwd == child),
            reject("Scratch 写入不能跨任务目录")
        );
        let file = project
            .metadata_home
            .join("workspace-authors")
            .join(format!(
                "{}.json",
                storage::digest(child.as_os_str().as_encoded_bytes())
            ));
        let author = read_author(&file, Some(&child))?
            .ok_or_else(|| reject("Scratch 原目录作者尚未确认"))?;
        let mut scoped = project.clone();
        scoped.scope = Some(child);
        let tasks = catalog(rpc, &scoped, &author.session_id).await?;
        ensure!(tasks.len() == 1, reject("Scratch 任务身份尚未唯一确认"));
        let task = &tasks[0];
        task_workspace_inner(rpc, project, peers, task, true).await?;
        let mut allowed = BTreeSet::new();
        for id in task
            .thread_id
            .iter()
            .chain(task.runs.iter().flat_map(|run| {
                run.thread_id
                    .iter()
                    .chain(run.workers.iter().map(|worker| &worker.thread_id))
            }))
        {
            let thread = read_thread(rpc, project, id).await?;
            allowed.insert(author_session(rpc, &scoped, thread).await?);
        }
        ensure!(
            allowed.contains(&session),
            reject("Scratch 写入不属于原任务执行")
        );
        return Ok(());
    }
    directory_admission(rpc, project, peers, &session, false).await
}

async fn scheduled_command<R: AdmissionRpc>(
    rpc: &R,
    project: &AdmissionProject,
    peers: &[AdmissionProject],
    name: &str,
    params: &Value,
    threads: &[Thread],
    session: &str,
) -> Result<bool> {
    let exclusive = reservation(project)?;
    let scratch_task = if let Some(root) = scratch_root(project)? {
        let child = scratch_child(
            &root,
            &threads
                .first()
                .ok_or_else(|| reject("Scratch 执行会话缺失"))?
                .cwd,
        )?;
        let file = project
            .metadata_home
            .join("workspace-authors")
            .join(format!(
                "{}.json",
                storage::digest(child.as_os_str().as_encoded_bytes())
            ));
        let author = read_author(&file, Some(&child))?
            .ok_or_else(|| reject("Scratch 原目录作者尚未确认"))?;
        let mut scoped = project.clone();
        scoped.scope = Some(child);
        let tasks = catalog(rpc, &scoped, &author.session_id).await?;
        ensure!(tasks.len() == 1, reject("Scratch 任务身份尚未唯一确认"));
        Some(tasks[0].id.clone())
    } else {
        None
    };
    let task_id = if let Some(id) = scratch_task {
        id
    } else if let Some(value) = &exclusive {
        value
            .task_id
            .clone()
            .ok_or_else(|| reject("原定时任务尚未完成绑定"))?
    } else {
        let coordinators = threads
            .iter()
            .filter_map(|thread| {
                thread
                    .goal_owner
                    .as_ref()
                    .and_then(|owner| owner["threadId"].as_str())
                    .or_else(|| {
                        thread
                            .goals
                            .as_ref()
                            .filter(|goals| goals["goal"].is_object())
                            .map(|_| thread.id.as_str())
                    })
            })
            .collect::<BTreeSet<_>>();
        if coordinators.is_empty() {
            return Ok(false);
        }
        let candidates = catalog(rpc, project, session)
            .await?
            .into_iter()
            .filter(|task| {
                task.mode == TaskMode::Scheduled
                    && task.source_thread_id.is_some()
                    && task.runs.iter().any(|run| {
                        run.thread_id
                            .as_ref()
                            .is_some_and(|id| coordinators.contains(id.as_str()))
                    })
            })
            .collect::<Vec<_>>();
        if candidates.is_empty() {
            return Ok(false);
        }
        ensure!(candidates.len() == 1, reject("定时执行的任务归属不唯一"));
        candidates[0].id.clone()
    };
    let task: Task = request(rpc, project, "areal/task/read", json!({"taskId":task_id})).await?;
    ensure!(
        task.id == task_id && task.mode == TaskMode::Scheduled && !task.cancelled,
        reject("原定时任务或目录预约已失效")
    );
    let workspace = task_workspace(rpc, project, peers, &task).await?;
    let current = task
        .runs
        .last()
        .ok_or_else(|| reject("原定时执行身份已变化"))?;
    ensure!(
        task.runs
            .iter()
            .filter(|run| !run.status.terminal())
            .count()
            == 1,
        reject("只有当前未结束的定时执行可继续交互")
    );
    let run: TaskRun = request(
        rpc,
        project,
        "areal/task/run/read",
        json!({"taskId":task.id,"runId":current.id}),
    )
    .await?;
    let active =
        |status: &str| matches!(status, "running" | "waitingForInput" | "waitingForAgents");
    let raw = serde_json::to_value(&run)?;
    ensure!(
        run.id == current.id
            && run.status == current.status
            && run.thread_id == current.thread_id
            && run.goal_id == current.goal_id
            && active(raw["status"].as_str().unwrap_or(""))
            && run.reason.as_deref() != Some("stopRequested"),
        reject("当前定时执行身份已变化")
    );
    let coordinator_id = run
        .thread_id
        .as_deref()
        .filter(|id| identifier(id))
        .ok_or_else(|| reject("当前定时执行身份已变化"))?;
    let coordinator = read_thread(rpc, project, coordinator_id).await?;
    let goal = coordinator
        .goals
        .as_ref()
        .and_then(|goals| goals.get("goal"))
        .ok_or_else(|| reject("当前定时执行目标已结束"))?;
    ensure!(
        coordinator.id != workspace.anchor()
            && coordinator.goal_owner.is_none()
            && goal["id"] == json!(run.goal_id)
            && goal["threadId"] == coordinator.id
            && goal["status"] == "active"
            && coordinator.cwd.canonicalize()? == workspace.cwd(),
        reject("当前定时执行目标已结束或不属于原运行")
    );
    for thread in threads {
        ensure!(
            thread.session_id == session && thread.cwd.canonicalize()? == workspace.cwd(),
            reject("定时执行会话作者或目录已变化")
        );
        let turn = if thread.id == coordinator.id {
            goal["activeTurnId"].as_str()
        } else {
            let worker = raw["workers"]
                .as_array()
                .and_then(|workers| {
                    workers
                        .iter()
                        .find(|worker| worker["threadId"] == thread.id)
                })
                .ok_or_else(|| reject("目标会话不是当前定时执行的未结算 worker"))?;
            ensure!(
                worker["settled"] == false
                    && active(worker["status"].as_str().unwrap_or(""))
                    && worker["turnId"].as_str().is_some_and(identifier)
                    && worker
                        .get("execution")
                        .is_none_or(|execution| execution.is_null()
                            || execution["kind"] == "thread"
                                && execution["threadId"] == thread.id
                                && execution["turnId"] == worker["turnId"])
                    && thread
                        .goal_owner
                        .as_ref()
                        .is_some_and(|owner| owner["threadId"] == coordinator.id
                            && owner["goalId"] == json!(run.goal_id)),
                reject("目标会话不是当前定时执行的未结算 worker")
            );
            if let Some(mut parent) = thread.parent_thread_id.clone() {
                let mut visited = BTreeSet::from([thread.id.clone()]);
                while parent != coordinator.id {
                    ensure!(
                        visited.len() < 32 && visited.insert(parent.clone()),
                        reject("定时 worker 父会话链无法确认")
                    );
                    let value = read_thread(rpc, project, &parent).await?;
                    ensure!(
                        value.cwd.canonicalize()? == workspace.cwd()
                            && value.session_id == thread.session_id
                            && value
                                .goal_owner
                                .as_ref()
                                .is_some_and(|owner| owner["threadId"] == coordinator.id
                                    && owner["goalId"] == json!(run.goal_id)),
                        reject("定时 worker 父会话不属于原运行")
                    );
                    parent = value
                        .parent_thread_id
                        .filter(|id| identifier(id))
                        .ok_or_else(|| reject("定时 worker 父会话链无法确认"))?;
                }
                ensure!(
                    thread.session_id == coordinator.session_id,
                    reject("定时 worker 未继承原运行会话")
                );
            } else {
                ensure!(
                    thread.source.as_deref() == Some("nativeTaskAgent")
                        && thread.session_id == thread.id,
                    reject("独立 worker 运行身份无法确认")
                );
            }
            worker["turnId"].as_str()
        };
        ensure!(
            turn.is_some_and(identifier),
            reject("定时执行当前轮次尚未确认")
        );
        if name == "continue" && params["threadId"] == thread.id {
            ensure!(
                params["expectedTurnId"].as_str() == turn,
                reject("原定时执行轮次已变化")
            );
        }
    }
    Ok(true)
}

pub(crate) async fn prepare<R: AdmissionRpc>(
    project: &AdmissionProject,
    peers: &[AdmissionProject],
    params: &Value,
    rpc: &R,
) -> Result<()> {
    if params["intent"] == "create" {
        return prepare_create(project, peers, params, rpc).await;
    }
    let task_id = params["taskId"].as_str().filter(|value| identifier(value));
    let run_id = params["runId"].as_str().filter(|value| identifier(value));
    let thread_id = params["threadId"]
        .as_str()
        .filter(|value| identifier(value));
    let intent = params["intent"].as_str();
    ensure!(
        task_id.is_some()
            && run_id.is_some()
            && thread_id.is_some()
            && matches!(intent, Some("start" | "resume")),
        reject("定时执行准备身份无效")
    );
    let task: Task = request(rpc, project, "areal/task/read", json!({"taskId":task_id})).await?;
    ensure!(
        Some(task.id.as_str()) == task_id && task.mode == TaskMode::Scheduled,
        reject("无法确认原定时任务")
    );
    let workspace = task_workspace(rpc, project, peers, &task).await?;
    let current = task
        .runs
        .last()
        .filter(|current| Some(current.id.as_str()) == run_id)
        .ok_or_else(|| reject("原定时执行身份已变化"))?;
    let run: TaskRun = request(
        rpc,
        project,
        "areal/task/run/read",
        json!({"taskId":task.id,"runId":current.id}),
    )
    .await?;
    ensure!(
        !task.cancelled
            && run.id == current.id
            && run.status == current.status
            && run.thread_id == current.thread_id
            && run.goal_id == current.goal_id
            && run.reason == current.reason
            && !run.status.terminal()
            && run.reason.as_deref() != Some("stopRequested")
            && (intent != Some("start") || run.status == RunStatus::Queued),
        reject("原定时执行已结束或不是当前可准备的执行")
    );
    let expected = if intent == Some("start") {
        Some(workspace.anchor())
    } else {
        run.thread_id.as_deref()
    };
    ensure!(
        thread_id == expected,
        reject("定时执行回调与原执行身份不匹配")
    );
    let thread = read_thread(rpc, project, thread_id.unwrap()).await?;
    ensure!(
        thread.cwd.canonicalize()? == workspace.cwd(),
        reject("定时执行目录已变化，未放行执行")
    );
    Ok(())
}

async fn prepare_create<R: AdmissionRpc>(
    project: &AdmissionProject,
    peers: &[AdmissionProject],
    params: &Value,
    rpc: &R,
) -> Result<()> {
    let request_id = params["requestId"]
        .as_str()
        .filter(|id| identifier(id))
        .ok_or_else(|| reject("定时创建请求身份无效"))?;
    let digest = params["requestDigest"]
        .as_str()
        .filter(|value| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        })
        .ok_or_else(|| reject("定时创建请求摘要无效"))?;
    let anchor_id = params["threadId"]
        .as_str()
        .filter(|id| identifier(id))
        .ok_or_else(|| reject("定时创建执行锚点无效"))?;
    let source_id = match params.get("sourceThreadId") {
        None | Some(Value::Null) => None,
        Some(Value::String(id)) if identifier(id) => Some(id.clone()),
        _ => return Err(reject("定时创建来源身份无效")),
    };
    if matches!(project.registration.source, crate::ProjectSource::Cli) || source_id.is_some() {
        let task = Task {
            id: request_id.into(),
            owner: "desktop-owner".into(),
            mode: TaskMode::Scheduled,
            cancelled: false,
            thread_id: Some(anchor_id.into()),
            source_thread_id: source_id,
            runs: vec![],
        };
        let (_, session) = source_workspace(rpc, project, &task).await?;
        return directory_admission(rpc, project, peers, &session, false).await;
    }
    let anchor = read_thread(rpc, project, anchor_id).await?;
    ensure!(
        ordinary(&anchor)
            && anchor.source.as_deref() != Some("nativeTaskAgent")
            && anchor
                .desktop
                .as_ref()
                .is_none_or(|v| v["configuration"]["readOnly"] != true),
        reject("定时创建执行锚点不可写或不是普通会话")
    );
    if let Some(root) = scratch_root(project)? {
        ensure!(
            project.registration.workspace.canonicalize()? == root,
            reject("Scratch 项目根身份已变化")
        );
        let child = scratch_child(&root, &anchor.cwd)?;
        let mut scoped = project.clone();
        scoped.scope = Some(child);
        let claim = ScratchClaim {
            request_id: request_id.into(),
            digest: digest.into(),
            anchor: anchor_id.into(),
        };
        return directory_admission_inner(
            rpc,
            &scoped,
            peers,
            &anchor.session_id,
            true,
            Some(&claim),
        )
        .await;
    }
    let root = project.registration.workspace.canonicalize()?;
    let cwd = anchor.cwd.canonicalize()?;
    let projects =
        read_optional::<Vec<SavedProject>>(&project.metadata_home.join("projects.json"))?
            .unwrap_or_default();
    let allocation_id = projects
        .iter()
        .find(|saved| saved.id == project.legacy_project_id)
        .and_then(|saved| saved.projectless_request_id.clone())
        .ok_or_else(|| reject("原定时任务没有独立目录分配身份"))?;
    let family = Family {
        kind: "request".into(),
        id: request_id.into(),
    };
    let token = format!(
        "schedule:{}",
        storage::digest(&serde_json::to_vec(&json!([
            project.legacy_project_id,
            family.kind,
            family.id
        ]))?)
    );
    let candidate = Reservation {
        version: 1,
        project_id: project.legacy_project_id.clone(),
        root,
        cwd,
        allocation_id,
        family,
        token,
        task_request_id: request_id.into(),
        execution_request_id: None,
        anchor_thread_id: Some(anchor_id.into()),
        task_id: None,
        extra: BTreeMap::new(),
    };
    eligible(project, &candidate).await?;
    let directory = project.metadata_home.join("schedule-authors");
    storage::private_dir(&directory)?;
    let _lock = claim_lock(&directory).await?;
    let existing = reservation(project)?;
    let mut chosen = if let Some(value) = existing {
        ensure!(
            value.root == candidate.root
                && value.cwd == candidate.cwd
                && value.allocation_id == candidate.allocation_id
                && value.task_request_id == request_id
                && value.anchor_thread_id.as_deref() == Some(anchor_id)
                && value
                    .extra
                    .get("creationDigest")
                    .is_none_or(|previous| previous.as_str() == Some(digest)),
            reject("此目录已保留给不同的定时创建请求")
        );
        value
    } else {
        candidate
    };
    directory_admission(rpc, project, peers, &chosen.token, true).await?;
    if chosen.extra.get("creationDigest").is_none() {
        chosen.extra.insert("creationDigest".into(), json!(digest));
        storage::write(&reservation_file(project)?, &chosen)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ProjectSource;

    struct Rpc {
        task: Value,
        run: Value,
        threads: BTreeMap<String, Value>,
        empty_catalog: bool,
        receipt: Value,
        status: Option<Value>,
        overview: Option<Value>,
    }
    impl AdmissionRpc for Rpc {
        async fn request(&self, _: &str, method: &str, params: Value) -> Result<Value> {
            match method {
                "areal/task/read" => Ok(self.task.clone()),
                "areal/task/run/read" => Ok(self.run.clone()),
                "areal/request/read" => Ok(self.receipt.clone()),
                "areal/work/overview" => self.overview.clone().context("missing overview"),
                "thread/read" => Ok(
                    json!({"thread":self.threads.get(params["threadId"].as_str().unwrap()).context("unknown thread")?}),
                ),
                "areal/task/list" => Ok(
                    json!({"data":if self.empty_catalog {vec![]} else {vec![self.task.clone()]},"nextCursor":null,"hasMore":false}),
                ),
                "areal/server/status" => Ok(self.status.clone().unwrap_or_else(|| json!({"acceptingWork":true,"activeTurns":[],"resources":[],"unresolvedTools":[],"activeGoals":[],"compactions":[],"workgroups":[],"activeTasks":0,"pendingQueueItems":0}))),
                _ => anyhow::bail!("unexpected method {method}"),
            }
        }
    }
    fn fixture(base: &Path) -> (AdmissionProject, Rpc) {
        let workspace = base.join("workspace");
        let metadata_home = base.join("metadata");
        storage::private_dir(&workspace).unwrap();
        storage::private_dir(&metadata_home).unwrap();
        let workspace = workspace.canonicalize().unwrap();
        let metadata_home = metadata_home.canonicalize().unwrap();
        let project = AdmissionProject {
            registration: ProjectRegistration {
                project_id: "host-project".into(),
                workspace: workspace.clone(),
                data_dir: base.join("data"),
                source: ProjectSource::Gui {
                    profile: base.join("profile"),
                    legacy_project_id: "a".repeat(24),
                },
                default_binding: false,
            },
            metadata_home,
            legacy_project_id: "a".repeat(24),
            scope: None,
        };
        let run = json!({"id":"run","threadId":null,"goalId":null,"status":"queued","reason":null,
            "scheduledAt":0,"completedAt":null,"usage":areal_protocol::goals::GoalUsage::default(),"waitRequested":false});
        let task = json!({"id":"task","revision":1,"channelSequence":0,"owner":"desktop-owner","mode":"scheduled",
            "interactionMode":"interactive","objective":"test","threadId":"anchor","sourceThreadId":"source",
            "schedule":null,"nextRunAt":null,"paused":false,"cancelled":false,"tokenBudget":null,"maxTurns":null,
            "maxActiveSeconds":null,"runs":[run]});
        let threads = ["source", "anchor", "coordinator"].into_iter().map(|id| (id.into(), json!({
            "id":id,"sessionId":format!("session-{id}"),"cwd":workspace,"desktop":{"configuration":{"readOnly":false}}
        }))).collect();
        (
            project,
            Rpc {
                task,
                run,
                threads,
                empty_catalog: false,
                receipt: json!({"data":[]}),
                status: None,
                overview: None,
            },
        )
    }
    #[tokio::test]
    async fn scratch_children_keep_distinct_authors_and_original_receipts() {
        let base = tempfile::tempdir().unwrap();
        let (project, mut rpc) = fixture(base.path());
        let root = &project.registration.workspace;
        let first = root.join("first");
        let second = root.join("second");
        std::fs::create_dir(&first).unwrap();
        std::fs::create_dir(&second).unwrap();
        storage::write(&project.metadata_home.join("projects.json"), &json!([{"id":project.legacy_project_id,"root":root,"projectless":true,"projectlessRequestId":SCRATCH_ID}])).unwrap();
        storage::write(
            &project.metadata_home.join("projectless-drafts.json"),
            &json!({(SCRATCH_ID):{"root":root,"existing":true}}),
        )
        .unwrap();
        let mut mismatched = project.clone();
        mismatched.registration.workspace = first.clone();
        assert!(scratch_root(&mismatched).is_err());
        rpc.threads.get_mut("anchor").unwrap()["cwd"] = json!(first);
        rpc.threads.get_mut("coordinator").unwrap()["cwd"] = json!(second);
        rpc.empty_catalog = true;
        let first_request = json!({"intent":"create","requestId":"first","requestDigest":"a".repeat(64),"threadId":"anchor"});
        prepare(&project, &[], &first_request, &rpc).await.unwrap();
        prepare(&project, &[], &first_request, &rpc).await.unwrap();
        let mut conflict = first_request.clone();
        conflict["requestId"] = json!("other");
        assert!(prepare(&project, &[], &conflict, &rpc).await.is_err());
        rpc.threads.get_mut("source").unwrap()["cwd"] = json!(first);
        conflict["threadId"] = json!("source");
        assert!(prepare(&project, &[], &conflict, &rpc).await.is_err());
        rpc.threads.get_mut("source").unwrap()["cwd"] = json!(root);
        let mut digest_conflict = first_request.clone();
        digest_conflict["requestDigest"] = json!("b".repeat(64));
        assert!(
            prepare(&project, &[], &digest_conflict, &rpc)
                .await
                .is_err()
        );
        rpc.task["sourceThreadId"] = Value::Null;
        rpc.empty_catalog = false;
        rpc.status = Some(
            json!({"acceptingWork":true,"activeTurns":[],"resources":[],"unresolvedTools":[],"activeGoals":[],"compactions":[],"workgroups":[],"activeTasks":1,"pendingQueueItems":0}),
        );
        rpc.overview = Some(
            json!({"complete":true,"nextCursor":null,"data":[{"kind":"taskRun","taskId":"task","threadId":"anchor","execution":{"state":"running"},"queue":{"pendingCount":0}}]}),
        );
        rpc.overview.as_mut().unwrap()["complete"] = json!(false);
        assert!(prepare(&project, &[], &json!({"intent":"create","requestId":"second","requestDigest":"b".repeat(64),"threadId":"coordinator"}), &rpc).await.is_err());
        rpc.overview.as_mut().unwrap()["complete"] = json!(true);
        prepare(&project, &[], &json!({"intent":"create","requestId":"second","requestDigest":"b".repeat(64),"threadId":"coordinator"}), &rpc).await.unwrap();
        assert!(prepare(&project, &[], &json!({"intent":"create","requestId":"root","requestDigest":"c".repeat(64),"threadId":"source"}), &rpc).await.is_err());
        #[cfg(unix)]
        {
            let link = root.join("link");
            std::os::unix::fs::symlink(&first, &link).unwrap();
            rpc.threads.get_mut("source").unwrap()["cwd"] = json!(link);
            assert!(prepare(&project, &[], &json!({"intent":"create","requestId":"link","requestDigest":"c".repeat(64),"threadId":"source"}), &rpc).await.is_err());
        }
        rpc.status = None;
        let task: Task = serde_json::from_value(rpc.task.clone()).unwrap();
        assert!(task_workspace(&rpc, &project, &[], &task).await.is_err());
        let good = json!({"method":"areal/task/create","requestId":"first","digest":"a".repeat(64),"status":"completed","result":{"id":"task","threadId":"anchor"}});
        rpc.receipt = json!({"data":[good.clone(),good.clone()]});
        assert!(task_workspace(&rpc, &project, &[], &task).await.is_err());
        rpc.receipt = json!({"data":[good]});
        assert_eq!(
            task_workspace(&rpc, &project, &[], &task)
                .await
                .unwrap()
                .cwd(),
            first
        );
        rpc.threads.insert("side".into(), json!({"id":"side","sessionId":"side-session","cwd":first,"conversation":{"version":2,"kind":"side","origin":{"sourceThreadId":"anchor"},"policy":{"kind":"sideExecutableV2"}}}));
        command(&project, &[], "send", &json!({"threadId":"side"}), &rpc)
            .await
            .unwrap();
        rpc.threads.get_mut("side").unwrap()["conversation"]["policy"]["kind"] =
            json!("sideReadOnlyV1");
        assert!(
            command(&project, &[], "send", &json!({"threadId":"side"}), &rpc)
                .await
                .is_err()
        );
        command(
            &project,
            &[],
            "manage",
            &json!({"operation":"archive","threadId":"side"}),
            &rpc,
        )
        .await
        .unwrap();
        rpc.run["threadId"] = json!("run-thread");
        rpc.run["goalId"] = json!("goal");
        rpc.run["status"] = json!("running");
        rpc.task["runs"][0] = rpc.run.clone();
        rpc.threads.insert("run-thread".into(), json!({"id":"run-thread","sessionId":"run-session","cwd":first,"goals":{"goal":{"id":"goal","threadId":"run-thread","status":"active","activeTurnId":"original-turn"}}}));
        command(
            &project,
            &[],
            "continue",
            &json!({"threadId":"run-thread","expectedTurnId":"original-turn"}),
            &rpc,
        )
        .await
        .unwrap();
        assert!(
            command(
                &project,
                &[],
                "continue",
                &json!({"threadId":"run-thread","expectedTurnId":"stale-turn"}),
                &rpc
            )
            .await
            .is_err()
        );
        rpc.task["cancelled"] = json!(true);
        command(&project, &[], "send", &json!({"threadId":"anchor"}), &rpc)
            .await
            .unwrap();
        rpc.threads.insert(
            "stranger".into(),
            json!({"id":"stranger","sessionId":"stranger","cwd":first}),
        );
        assert!(
            command(&project, &[], "send", &json!({"threadId":"stranger"}), &rpc)
                .await
                .is_err()
        );
        assert!(
            command(
                &project,
                &[],
                "manage",
                &json!({"operation":"taskRunNow","taskId":"task"}),
                &rpc
            )
            .await
            .is_err()
        );
        rpc.receipt["data"][0]["digest"] = json!("b".repeat(64));
        assert!(
            command(&project, &[], "send", &json!({"threadId":"anchor"}), &rpc)
                .await
                .is_err()
        );
    }
    #[tokio::test]
    async fn create_reserves_original_anchor_and_rejects_other_requests() {
        let base = tempfile::tempdir().unwrap();
        let (project, mut rpc) = fixture(base.path());
        rpc.empty_catalog = true;
        storage::write(&project.metadata_home.join("projects.json"), &json!([{"id":project.legacy_project_id,"root":project.registration.workspace,"projectless":true,"projectlessRequestId":"allocation"}])).unwrap();
        storage::write(
            &project.metadata_home.join("projectless-drafts.json"),
            &json!({"allocation":{"root":project.registration.workspace}}),
        )
        .unwrap();
        let params = json!({"intent":"create","requestDigest":"a".repeat(64),"requestId":"request","threadId":"anchor"});
        prepare(&project, &[], &params, &rpc).await.unwrap();
        let value = reservation(&project).unwrap().unwrap();
        assert_eq!(value.family.kind, "request");
        assert_eq!(value.task_request_id, "request");
        assert_eq!(value.anchor_thread_id.as_deref(), Some("anchor"));
        assert!(value.task_id.is_none());
        assert_eq!(value.extra["creationDigest"], "a".repeat(64));
        prepare(&project, &[], &params, &rpc).await.unwrap();
        let mut changed = params.clone();
        changed["requestDigest"] = json!("b".repeat(64));
        assert!(prepare(&project, &[], &changed, &rpc).await.is_err());
        assert!(
            prepare(
                &project,
                &[],
                &json!({"intent":"create","requestDigest":"a".repeat(64),"requestId":"other","threadId":"anchor"}),
                &rpc
            )
            .await
            .is_err()
        );
        assert!(
            prepare(
                &project,
                &[],
                &json!({"intent":"create","requestDigest":"a".repeat(64),"requestId":"request","threadId":"coordinator"}),
                &rpc
            )
            .await
            .is_err()
        );
        assert_eq!(
            reservation(&project).unwrap().unwrap().task_request_id,
            "request"
        );
    }
    #[tokio::test]
    async fn created_reservation_binds_only_the_original_core_receipt() {
        let base = tempfile::tempdir().unwrap();
        let (project, mut rpc) = fixture(base.path());
        let mut value = exclusive(&project, &mut rpc);
        value.task_id = None;
        storage::write(&reservation_file(&project).unwrap(), &value).unwrap();
        author(&project, &value.token);
        assert!(prepare(&project, &[], &params(), &rpc).await.is_err());
        assert!(reservation(&project).unwrap().unwrap().task_id.is_none());
        rpc.receipt = json!({"data":[{"method":"areal/task/create","result":{"id":"task"}}]});
        assert!(prepare(&project, &[], &params(), &rpc).await.is_err());
        assert!(reservation(&project).unwrap().unwrap().task_id.is_none());
        rpc.receipt = json!({"data":[{"method":"areal/task/create","requestId":"other","result":{"id":"task"}}]});
        assert!(prepare(&project, &[], &params(), &rpc).await.is_err());
        assert!(reservation(&project).unwrap().unwrap().task_id.is_none());
        rpc.receipt = json!({"data":[{"method":"areal/task/create","requestId":"request","result":{"id":"task"}}]});
        prepare(&project, &[], &params(), &rpc).await.unwrap();
        assert_eq!(
            reservation(&project).unwrap().unwrap().task_id.as_deref(),
            Some("task")
        );
    }
    #[tokio::test]
    async fn create_preserves_matching_legacy_draft_reservation() {
        let base = tempfile::tempdir().unwrap();
        let (project, mut rpc) = fixture(base.path());
        let mut value = exclusive(&project, &mut rpc);
        value.family = Family {
            kind: "draft".into(),
            id: "draft".into(),
        };
        value.token = format!(
            "schedule:{}",
            storage::digest(
                &serde_json::to_vec(&json!([project.legacy_project_id, "draft", "draft"])).unwrap()
            )
        );
        value.execution_request_id = Some("original-execution".into());
        storage::write(&reservation_file(&project).unwrap(), &value).unwrap();
        author(&project, &value.token);
        rpc.empty_catalog = true;
        prepare(
            &project,
            &[],
            &json!({"intent":"create","requestDigest":"a".repeat(64),"requestId":"request","threadId":"anchor"}),
            &rpc,
        )
        .await
        .unwrap();
        let actual = reservation(&project).unwrap().unwrap();
        assert_eq!(actual.family.kind, "draft");
        assert_eq!(actual.token, value.token);
        assert_eq!(actual.extra["creationDigest"], "a".repeat(64));
        assert_eq!(actual.task_id.as_deref(), Some("task"));
        assert_eq!(
            actual.execution_request_id.as_deref(),
            Some("original-execution")
        );
    }
    #[tokio::test]
    async fn create_rejects_another_project_on_the_same_directory() {
        let base = tempfile::tempdir().unwrap();
        let (project, mut rpc) = fixture(base.path());
        rpc.empty_catalog = true;
        let mut other = project.clone();
        other.registration.project_id = "other-host-project".into();
        other.legacy_project_id = "b".repeat(24);
        other.registration.source = ProjectSource::Gui {
            profile: base.path().join("profile"),
            legacy_project_id: other.legacy_project_id.clone(),
        };
        storage::write(&project.metadata_home.join("projects.json"), &json!([
            {"id":project.legacy_project_id,"root":project.registration.workspace,"projectless":true,"projectlessRequestId":"allocation"},
            {"id":other.legacy_project_id,"root":other.registration.workspace,"projectless":true,"projectlessRequestId":"other-allocation"}
        ])).unwrap();
        storage::write(&project.metadata_home.join("projectless-drafts.json"), &json!({
            "allocation":{"root":project.registration.workspace},"other-allocation":{"root":other.registration.workspace}
        })).unwrap();
        prepare(
            &project,
            &[other.clone()],
            &json!({"intent":"create","requestDigest":"a".repeat(64),"requestId":"first","threadId":"anchor"}),
            &rpc,
        )
        .await
        .unwrap();
        assert!(
            prepare(
                &other,
                &[project.clone()],
                &json!({"intent":"create","requestDigest":"a".repeat(64),"requestId":"second","threadId":"anchor"}),
                &rpc
            )
            .await
            .is_err()
        );
        assert!(reservation(&other).unwrap().is_none());
    }
    #[tokio::test]
    async fn cli_anchor_only_schedule_checks_real_workspace_and_thread_identity() {
        let base = tempfile::tempdir().unwrap();
        let (mut project, mut rpc) = fixture(base.path());
        project.registration.source = ProjectSource::Cli;
        project.legacy_project_id = "host-project".into();
        rpc.task.as_object_mut().unwrap().remove("sourceThreadId");
        rpc.threads
            .get_mut("anchor")
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove("desktop");
        let task: Task = serde_json::from_value(rpc.task.clone()).unwrap();
        let (_, session) = source_workspace(&rpc, &project, &task).await.unwrap();
        assert_eq!(session, "session-anchor");
        prepare(&project, &[], &params(), &rpc).await.unwrap();
        rpc.task["threadId"] = json!("coordinator");
        assert!(catalog(&rpc, &project, "session-anchor").await.is_err());
        catalog(&rpc, &project, "session-coordinator")
            .await
            .unwrap();
        rpc.task["threadId"] = json!("anchor");
        let anchor = rpc.threads["anchor"].clone();
        for invalid in [
            json!({"desktop":{"configuration":{"readOnly":true}}}),
            json!({"source":"nativeTaskAgent"}),
            json!({"conversation":{"kind":"side"}}),
            json!({"parentThreadId":"parent"}),
            json!({"cwd":base.path()}),
        ] {
            let mut changed = anchor.clone();
            changed
                .as_object_mut()
                .unwrap()
                .extend(invalid.as_object().unwrap().clone());
            rpc.threads.insert("anchor".into(), changed);
            assert!(
                source_workspace(&rpc, &project, &task).await.is_err(),
                "{invalid}"
            );
        }
        rpc.threads.insert("anchor".into(), anchor);
        project.registration.source = ProjectSource::Gui {
            profile: base.path().join("profile"),
            legacy_project_id: "a".repeat(24),
        };
        assert!(source_workspace(&rpc, &project, &task).await.is_err());
    }

    fn params() -> Value {
        json!({"taskId":"task","runId":"run","threadId":"anchor","intent":"start"})
    }
    fn exclusive(project: &AdmissionProject, rpc: &mut Rpc) -> Reservation {
        rpc.task.as_object_mut().unwrap().remove("sourceThreadId");
        let family = Family {
            kind: "request".into(),
            id: "request".into(),
        };
        let token = format!(
            "schedule:{}",
            storage::digest(
                &serde_json::to_vec(&json!([project.legacy_project_id, family.kind, family.id]))
                    .unwrap()
            )
        );
        let value = Reservation {
            version: 1,
            project_id: project.legacy_project_id.clone(),
            root: project.registration.workspace.clone(),
            cwd: project.registration.workspace.clone(),
            allocation_id: "allocation".into(),
            family,
            token,
            task_request_id: "request".into(),
            execution_request_id: None,
            anchor_thread_id: Some("anchor".into()),
            task_id: Some("task".into()),
            extra: BTreeMap::new(),
        };
        storage::private_dir(&project.metadata_home.join("schedule-authors")).unwrap();
        storage::write(&reservation_file(project).unwrap(), &value).unwrap();
        storage::write(&project.metadata_home.join("projects.json"), &json!([
            {"id":project.legacy_project_id,"root":project.registration.workspace,"projectless":true,"projectlessRequestId":"allocation"}
        ])).unwrap();
        storage::write(
            &project.metadata_home.join("projectless-drafts.json"),
            &json!({
                "allocation":{"root":project.registration.workspace,"existing":false}
            }),
        )
        .unwrap();
        value
    }
    fn author(project: &AdmissionProject, session: &str) {
        let directory = project.metadata_home.join("workspace-authors");
        storage::private_dir(&directory).unwrap();
        let root = &project.registration.workspace;
        storage::write(&directory.join(format!("{}.json", storage::digest(root.as_os_str().as_encoded_bytes()))),
            &json!({"version":1,"root":root,"projectId":project.legacy_project_id,"sessionId":session})).unwrap();
    }

    #[tokio::test]
    async fn scheduled_continue_keeps_the_current_coordinator_turn() {
        let base = tempfile::tempdir().unwrap();
        let (project, mut rpc) = fixture(base.path());
        rpc.run["threadId"] = json!("coordinator");
        rpc.run["goalId"] = json!("goal");
        rpc.run["status"] = json!("running");
        rpc.task["runs"][0] = rpc.run.clone();
        rpc.threads.get_mut("coordinator").unwrap()["goals"] = json!({"goal":{"id":"goal","threadId":"coordinator","status":"active","activeTurnId":"original-turn"}});
        command(
            &project,
            &[],
            "continue",
            &json!({"threadId":"coordinator","expectedTurnId":"original-turn"}),
            &rpc,
        )
        .await
        .unwrap();
        assert!(
            command(
                &project,
                &[],
                "continue",
                &json!({"threadId":"coordinator","expectedTurnId":"stale-turn"}),
                &rpc
            )
            .await
            .is_err()
        );
    }
    #[tokio::test]
    async fn source_preparation_checks_current_run_owner_and_physical_directory() {
        let base = tempfile::tempdir().unwrap();
        let (project, mut rpc) = fixture(base.path());
        prepare(&project, &[], &params(), &rpc).await.unwrap();
        rpc.run["reason"] = json!("stopRequested");
        assert!(prepare(&project, &[], &params(), &rpc).await.is_err());
        rpc.run["reason"] = Value::Null;
        rpc.task["owner"] = json!("other-owner");
        assert!(prepare(&project, &[], &params(), &rpc).await.is_err());
        rpc.task["owner"] = json!("desktop-owner");
        rpc.threads.get_mut("anchor").unwrap()["cwd"] = json!(base.path());
        assert!(prepare(&project, &[], &params(), &rpc).await.is_err());
    }
    #[tokio::test]
    async fn resume_uses_run_coordinator_and_rejects_stale_summary() {
        let base = tempfile::tempdir().unwrap();
        let (project, mut rpc) = fixture(base.path());
        rpc.run["threadId"] = json!("coordinator");
        rpc.run["status"] = json!("paused");
        rpc.task["runs"][0] = rpc.run.clone();
        let mut request = params();
        request["intent"] = json!("resume");
        request["threadId"] = json!("coordinator");
        prepare(&project, &[], &request, &rpc).await.unwrap();
        rpc.task["runs"][0]["status"] = json!("running");
        assert!(prepare(&project, &[], &request, &rpc).await.is_err());
    }
    #[tokio::test]
    async fn source_schedule_keeps_legacy_exclusive_directory_blocked() {
        let base = tempfile::tempdir().unwrap();
        let (project, rpc) = fixture(base.path());
        author(&project, "schedule:legacy-family");
        assert!(prepare(&project, &[], &params(), &rpc).await.is_err());
        assert!(
            !project
                .metadata_home
                .join("workspace-authors/claim.lock")
                .exists()
        );
    }
    #[tokio::test]
    async fn exclusive_schedule_checks_allocation_and_never_overwrites_author() {
        let base = tempfile::tempdir().unwrap();
        let (project, mut rpc) = fixture(base.path());
        let reservation = exclusive(&project, &mut rpc);
        author(&project, "other-session");
        let file = project
            .metadata_home
            .join("workspace-authors")
            .join(format!(
                "{}.json",
                storage::digest(
                    project
                        .registration
                        .workspace
                        .as_os_str()
                        .as_encoded_bytes()
                )
            ));
        let original = std::fs::read(&file).unwrap();
        assert!(prepare(&project, &[], &params(), &rpc).await.is_err());
        assert_eq!(std::fs::read(&file).unwrap(), original);
        author(&project, &reservation.token);
        prepare(&project, &[], &params(), &rpc).await.unwrap();
        storage::write(
            &project.metadata_home.join("projectless-drafts.json"),
            &json!({"allocation":{"root":project.registration.workspace,"existing":true}}),
        )
        .unwrap();
        assert!(prepare(&project, &[], &params(), &rpc).await.is_err());
    }
    #[tokio::test]
    async fn malformed_reservation_does_not_fall_back_to_source_schedule() {
        let base = tempfile::tempdir().unwrap();
        let (project, rpc) = fixture(base.path());
        storage::private_dir(&project.metadata_home.join("schedule-authors")).unwrap();
        storage::write(&reservation_file(&project).unwrap(), &json!({"version":1})).unwrap();
        assert!(prepare(&project, &[], &params(), &rpc).await.is_err());
    }
    #[tokio::test]
    async fn unconnected_saved_peer_in_same_checkout_blocks_preparation() {
        let base = tempfile::tempdir().unwrap();
        let (project, rpc) = fixture(base.path());
        storage::write(
            &project.metadata_home.join("projects.json"),
            &json!([
                {"id":"other-project","root":project.registration.workspace}
            ]),
        )
        .unwrap();
        assert!(prepare(&project, &[], &params(), &rpc).await.is_err());
    }
    #[tokio::test]
    async fn another_gui_source_keeps_its_existing_schedule_author() {
        let base = tempfile::tempdir().unwrap();
        let (project, rpc) = fixture(base.path());
        let other_base = base.path().join("other-source");
        storage::private_dir(&other_base).unwrap();
        let (mut other, _) = fixture(&other_base);
        other.registration.project_id = "other-project".into();
        let directory = other.metadata_home.join("workspace-authors");
        storage::private_dir(&directory).unwrap();
        storage::write(&directory.join("old.json"), &json!({
            "version":1,"root":project.registration.workspace,"projectId":"legacy-owner","sessionId":"schedule:old-family"
        })).unwrap();
        assert!(prepare(&project, &[other], &params(), &rpc).await.is_err());
        assert!(!directory.join("claim.lock").exists());
    }
    #[tokio::test]
    async fn damaged_git_checkout_is_not_treated_as_an_untracked_directory() {
        let base = tempfile::tempdir().unwrap();
        let (project, rpc) = fixture(base.path());
        std::fs::write(
            project.registration.workspace.join(".git"),
            "gitdir: /missing-host-admission-fixture\n",
        )
        .unwrap();
        assert!(prepare(&project, &[], &params(), &rpc).await.is_err());
    }
}
