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
}

pub(crate) trait AdmissionRpc {
    fn request<'a>(
        &'a self,
        project_id: &'a str,
        method: &'a str,
        params: Value,
    ) -> impl Future<Output = Result<Value>> + 'a;
}

#[derive(Deserialize)]
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
    Exclusive(Reservation),
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
}
#[derive(Deserialize)]
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
) -> Result<()> {
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
        for task in &page.data {
            ensure!(
                identifier(&task.id)
                    && seen.insert(task.id.clone())
                    && previous.as_ref().is_none_or(|previous| task.id > *previous),
                reject("任务目录包含无法核对的执行身份")
            );
            previous = Some(task.id.clone());
            if task.mode != TaskMode::Scheduled || task.cancelled {
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
        if page.next_cursor.is_none() {
            return Ok(());
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
            && owner.cwd.canonicalize()? == project.registration.workspace.canonicalize()?,
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
    ensure!(
        status["activeTasks"] == 0
            && status["pendingQueueItems"] == 0
            && status["unresolvedTools"].as_array().unwrap().is_empty()
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
    let root = workspace_root(&project.registration.workspace).await?;
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
            let value = json!({"version":1,"root":root,"projectId":project.legacy_project_id,"sessionId":session});
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
        author.is_some_and(|author| author.session_id == session),
        reject("此执行目录已保留给另一个会话及其后台任务")
    );
    Ok(())
}

pub(crate) async fn prepare<R: AdmissionRpc>(
    project: &AdmissionProject,
    peers: &[AdmissionProject],
    params: &Value,
    rpc: &R,
) -> Result<()> {
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
                                .unwrap_or(&value.task_request_id)
                                == value.task_request_id
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
            Workspace::Exclusive(value)
        }
    };
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ProjectSource;

    struct Rpc {
        task: Value,
        run: Value,
        threads: BTreeMap<String, Value>,
    }
    impl AdmissionRpc for Rpc {
        async fn request(&self, _: &str, method: &str, params: Value) -> Result<Value> {
            match method {
                "areal/task/read" => Ok(self.task.clone()),
                "areal/task/run/read" => Ok(self.run.clone()),
                "thread/read" => Ok(
                    json!({"thread":self.threads.get(params["threadId"].as_str().unwrap()).context("unknown thread")?}),
                ),
                "areal/task/list" => {
                    Ok(json!({"data":[self.task],"nextCursor":null,"hasMore":false}))
                }
                "areal/server/status" => Ok(
                    json!({"acceptingWork":true,"activeTurns":[],"resources":[],"unresolvedTools":[],"activeGoals":[],"compactions":[],"workgroups":[],"activeTasks":0,"pendingQueueItems":0}),
                ),
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
        (project, Rpc { task, run, threads })
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
