use crate::ProjectStatus;
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::CString,
    fs::{File, OpenOptions},
    io::Read,
    os::fd::{AsRawFd, FromRawFd},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

const MAX_LIBRARY_BYTES: u64 = 8 * 1024 * 1024;
const MAX_ENTRIES: usize = 65_536;

pub(crate) struct NavigationSource {
    pub source_id: String,
    pub core_home: PathBuf,
    pub bindings: Vec<NavigationBinding>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NavigationBinding {
    pub project_id: String,
    pub alias: String,
    #[serde(skip)]
    pub owned: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logical_project_id: Option<String>,
    pub projectless: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShellView {
    pub projects: Vec<ShellProject>,
    pub navigation: Vec<SourceNavigation>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShellProject {
    pub project_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias: Option<ProjectAlias>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logical_project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<WorktreeDisplay>,
    pub projectless: bool,
    pub workspace: PathBuf,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_generation: Option<String>,
    pub summaries: Summaries,
    pub attention: Attention,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectAlias {
    pub source_id: String,
    pub project_id: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorktreeDisplay {
    pub state: String,
    pub directory: PathBuf,
    pub checkout_root: PathBuf,
    pub branch: String,
    pub base: String,
    pub source_root: PathBuf,
    pub request_id: String,
    pub automatic: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub(crate) enum Summaries {
    Fresh { items: Vec<NavigationSummary> },
    Cached { items: Vec<NavigationSummary> },
    Unknown { items: Vec<NavigationSummary> },
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub(crate) enum Attention {
    Fresh { count: u64 },
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NavigationSummary {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation: Option<ConversationKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<f64>,
    #[serde(default)]
    pub desktop: SummaryDesktop,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub(crate) struct ConversationKind {
    pub kind: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
pub(crate) struct SummaryDesktop {
    #[serde(default)]
    pub archived: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NavigationMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unread: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_order: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scheduled_completion_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub(crate) struct Section {
    pub id: String,
    pub title: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceNavigation {
    pub source_id: String,
    pub state: NavigationState,
    pub bindings: Vec<NavigationBinding>,
    pub projects: BTreeMap<String, NavigationMetadata>,
    pub threads: BTreeMap<String, NavigationMetadata>,
    pub project_order: Vec<String>,
    pub sections: Vec<Section>,
    pub sidebar_thread_order: Vec<String>,
    pub sidebar_revision: u64,
    pub preferences: NavigationPreferences,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NavigationPreferences {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sidebar_sort: Option<SortMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sidebar_sort_chats: Option<SortMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sidebar_sort_projects: Option<SortMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sidebar_sort_pinned: Option<SortMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_pinned: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_completed: Option<bool>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SortMode {
    Manual,
    Priority,
    UpdatedAt,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum NavigationState {
    Available,
    Unknown,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Library {
    #[serde(default)]
    settings: NavigationPreferences,
    #[serde(default)]
    projects: BTreeMap<String, CachedMetadata>,
    #[serde(default)]
    threads: BTreeMap<String, NavigationMetadata>,
    #[serde(default)]
    project_order: Vec<String>,
    #[serde(default)]
    sections: Vec<Section>,
    #[serde(default)]
    sidebar_thread_order: Vec<String>,
    #[serde(default)]
    sidebar_revision: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedMetadata {
    #[serde(flatten)]
    metadata: NavigationMetadata,
    #[serde(default)]
    navigation_summaries: Option<Vec<NavigationSummary>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectMetadata {
    id: String,
    #[serde(rename = "root")]
    _root: String,
    #[serde(default)]
    logical_project_id: Option<String>,
    #[serde(default)]
    worktree_request_id: Option<String>,
    #[serde(default)]
    projectless: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeOperation {
    request_id: String,
    project_id: String,
    execution_project_id: Option<String>,
    state: String,
    source_root: Option<PathBuf>,
    #[serde(default)]
    automatic: bool,
    record: Option<WorktreeRecord>,
}

#[derive(Deserialize)]
struct WorktreeRecord {
    directory: PathBuf,
    cwd: Option<PathBuf>,
    branch: String,
    base: String,
    target: PathBuf,
}

pub(crate) fn snapshot(
    statuses: &[ProjectStatus],
    sources: &[NavigationSource],
) -> Result<ShellView> {
    let mut projects: BTreeMap<_, _> = statuses
        .iter()
        .map(|status| {
            let id = status.registration.project_id.clone();
            (
                id.clone(),
                ShellProject {
                    project_id: id,
                    alias: None,
                    logical_project_id: None,
                    worktree: None,
                    projectless: false,
                    workspace: status.registration.workspace.clone(),
                    state: status.state.clone(),
                    service_generation: status
                        .service
                        .as_ref()
                        .map(|service| service.identity.generation.clone()),
                    summaries: Summaries::Unknown { items: Vec::new() },
                    attention: Attention::Unknown,
                },
            )
        })
        .collect();
    let mut navigation = Vec::new();
    for source in sources {
        let library = read_library(&source.core_home.join("library.json"))?;
        let index: Vec<ProjectMetadata> =
            read_document(&source.core_home.join("projects.json"))?.unwrap_or_default();
        ensure!(
            index.len() <= MAX_ENTRIES,
            "navigation project limit exceeded"
        );
        let mut index_ids = BTreeSet::new();
        ensure!(
            index.iter().all(|item| index_ids.insert(&item.id)),
            "sourceConflict: duplicate navigation project"
        );
        let mut bindings = source.bindings.clone();
        for binding in &mut bindings {
            if let Some(metadata) = index.iter().find(|item| item.id == binding.alias) {
                if let Some(logical_alias) = &metadata.logical_project_id {
                    let logical = source
                        .bindings
                        .iter()
                        .find(|item| &item.alias == logical_alias)
                        .context("sourceConflict: logical navigation project is not registered")?;
                    ensure!(
                        binding
                            .logical_project_id
                            .as_ref()
                            .is_none_or(|id| id == &logical.project_id),
                        "sourceConflict: logical navigation project changed"
                    );
                    binding.logical_project_id = Some(logical.project_id.clone());
                }
                binding.projectless |= metadata.projectless;
            }
        }
        let state = if library.is_some() {
            NavigationState::Available
        } else {
            NavigationState::Unknown
        };
        let library = library.unwrap_or_default();
        let aliases: BTreeSet<_> = source
            .bindings
            .iter()
            .map(|binding| binding.alias.as_str())
            .collect();
        let belongs = |key: &str| {
            key.split_once(':')
                .is_some_and(|(alias, _)| aliases.contains(alias))
        };
        for binding in &bindings {
            let Some(project) = projects.get_mut(&binding.project_id) else {
                continue;
            };
            if !binding.owned {
                continue;
            }
            ensure!(
                project.alias.is_none(),
                "sourceConflict: project has multiple navigation owners"
            );
            project.alias = Some(ProjectAlias {
                source_id: source.source_id.clone(),
                project_id: binding.alias.clone(),
            });
            project.logical_project_id = binding.logical_project_id.clone();
            project.projectless = binding.projectless;
            if let Some(metadata) = index.iter().find(|item| item.id == binding.alias) {
                project.worktree =
                    read_worktree_display(source, binding, metadata, &project.workspace)?;
            }
            let cached = library
                .projects
                .get(&binding.alias)
                .and_then(|metadata| metadata.navigation_summaries.clone());
            project.summaries = if let Some(items) = cached {
                validate_summaries(&items)?;
                Summaries::Cached { items }
            } else {
                let prefix = format!("{}:", binding.alias);
                let items = library
                    .threads
                    .keys()
                    .filter_map(|key| key.strip_prefix(&prefix))
                    .map(|id| NavigationSummary {
                        id: id.into(),
                        parent_thread_id: None,
                        conversation: None,
                        name: None,
                        preview: None,
                        created_at: None,
                        updated_at: None,
                        desktop: SummaryDesktop::default(),
                    })
                    .collect();
                Summaries::Unknown { items }
            };
        }
        navigation.push(SourceNavigation {
            source_id: source.source_id.clone(),
            state,
            bindings,
            projects: library
                .projects
                .into_iter()
                .filter(|(id, _)| aliases.contains(id.as_str()))
                .map(|(id, metadata)| (id, metadata.metadata))
                .collect(),
            threads: library
                .threads
                .into_iter()
                .filter(|(key, _)| belongs(key))
                .collect(),
            project_order: library
                .project_order
                .into_iter()
                .filter(|id| aliases.contains(id.as_str()))
                .collect(),
            sections: library.sections,
            sidebar_thread_order: library
                .sidebar_thread_order
                .into_iter()
                .filter(|key| belongs(key))
                .collect(),
            sidebar_revision: library.sidebar_revision,
            preferences: library.settings,
        });
    }
    Ok(ShellView {
        projects: projects.into_values().collect(),
        navigation,
    })
}

pub(crate) fn apply_observation(
    project: &mut ShellProject,
    generation: &str,
    summaries: Vec<Value>,
    attention_count: Option<u64>,
) -> Result<()> {
    ensure!(
        project.state == "ready" && project.service_generation.as_deref() == Some(generation),
        "shell observation generation changed"
    );
    let items: Vec<NavigationSummary> = summaries
        .into_iter()
        .map(serde_json::from_value)
        .collect::<std::result::Result<_, _>>()
        .context("invalid Core navigation summaries")?;
    validate_summaries(&items)?;
    project.summaries = Summaries::Fresh { items };
    project.attention = attention_count
        .map(|count| Attention::Fresh { count })
        .unwrap_or(Attention::Unknown);
    Ok(())
}

fn validate_summaries(items: &[NavigationSummary]) -> Result<()> {
    ensure!(
        items.len() <= MAX_ENTRIES,
        "navigation summary limit exceeded"
    );
    let mut ids = BTreeSet::new();
    for item in items {
        ensure!(
            !item.id.is_empty() && ids.insert(&item.id),
            "invalid or duplicate navigation summary id"
        );
    }
    Ok(())
}

fn read_worktree_display(
    source: &NavigationSource,
    binding: &NavigationBinding,
    metadata: &ProjectMetadata,
    workspace: &Path,
) -> Result<Option<WorktreeDisplay>> {
    let Some(request_id) = &metadata.worktree_request_id else {
        return Ok(None);
    };
    ensure!(
        request_id.len() == 36 && uuid::Uuid::parse_str(request_id).is_ok(),
        "sourceConflict: invalid worktree request id"
    );
    let logical_alias = metadata
        .logical_project_id
        .as_ref()
        .context("sourceConflict: worktree has no logical project")?;
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_NONBLOCK)
        .open(source.core_home.join("worktree-requests"));
    let directory = match directory {
        Ok(directory) => directory,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("worktree display is unavailable"),
    };
    ensure!(
        directory.metadata()?.uid() == unsafe { libc::geteuid() },
        "invalid worktree display directory"
    );
    let name = CString::new(format!("{request_id}.json"))?;
    // 固定目录句柄阻止目录替换或软链把读取导向其它来源。
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    if fd == -1 {
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::NotFound {
            return Ok(None);
        }
        return Err(error).context("worktree display is unavailable");
    }
    let operation: WorktreeOperation = read_file(unsafe { File::from_raw_fd(fd) })?;
    ensure!(
        operation.request_id == *request_id
            && operation.project_id == *logical_alias
            && operation
                .execution_project_id
                .as_ref()
                .is_none_or(|id| id == &binding.alias),
        "sourceConflict: worktree display identity changed"
    );
    let Some(record) = operation.record else {
        return Ok(None);
    };
    ensure!(
        operation.execution_project_id.as_ref() == Some(&binding.alias)
            && record.cwd.as_deref().unwrap_or(&record.directory) == workspace,
        "sourceConflict: worktree display workspace changed"
    );
    ensure!(
        matches!(
            operation.state.as_str(),
            "creating"
                | "created"
                | "binding"
                | "settingUp"
                | "ready"
                | "cancelled"
                | "failed"
                | "unknown"
        ),
        "invalid worktree display state"
    );
    Ok(Some(WorktreeDisplay {
        state: operation.state,
        directory: workspace.to_path_buf(),
        checkout_root: record.directory,
        branch: record.branch,
        base: record.base,
        source_root: operation.source_root.unwrap_or(record.target),
        request_id: operation.request_id,
        automatic: operation.automatic,
    }))
}

fn read_document<T: DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path);
    let file = match file {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("navigation library is unavailable"),
    };
    read_file(file).map(Some)
}

fn read_file<T: DeserializeOwned>(mut file: File) -> Result<T> {
    let before = file.metadata()?;
    ensure!(
        before.is_file()
            && before.uid() == unsafe { libc::geteuid() }
            && before.len() <= MAX_LIBRARY_BYTES,
        "invalid navigation library file"
    );
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_LIBRARY_BYTES + 1)
        .read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    ensure!(
        bytes.len() as u64 <= MAX_LIBRARY_BYTES
            && before.len() == after.len()
            && before.mtime() == after.mtime()
            && before.mtime_nsec() == after.mtime_nsec(),
        "navigation library changed during read"
    );
    serde_json::from_slice(&bytes).context("invalid navigation metadata")
}

fn read_library(path: &Path) -> Result<Option<Library>> {
    let Some(value) = read_document::<Value>(path)? else {
        return Ok(None);
    };
    check_library(value).map(Some)
}

/// Host 代桌面写资料库前，用读取时的同一套限制检查要写的内容。
pub(crate) fn validate_library(bytes: &[u8]) -> Result<()> {
    ensure!(
        bytes.len() as u64 <= MAX_LIBRARY_BYTES,
        "invalid navigation library file"
    );
    check_library(serde_json::from_slice(bytes)?).map(|_| ())
}

/// 资料库命令只返回与导航读模型相同的公开字段，不透传桌面配置和缓存正文。
pub(crate) fn library_result(value: Value) -> Result<Value> {
    ensure!(
        [
            "projects",
            "threads",
            "projectOrder",
            "sections",
            "sidebarThreadOrder",
            "sidebarRevision",
            "settings"
        ]
        .iter()
        .all(|key| value.get(key).is_some()),
        "invalid library command result"
    );
    let library = check_library(value)?;
    let projects: BTreeMap<_, _> = library
        .projects
        .into_iter()
        .map(|(id, entry)| (id, entry.metadata))
        .collect();
    Ok(serde_json::json!({
        "projects": projects, "threads": library.threads, "projectOrder": library.project_order,
        "sections": library.sections, "sidebarThreadOrder": library.sidebar_thread_order,
        "sidebarRevision": library.sidebar_revision, "settings": library.settings,
    }))
}

fn check_library(value: Value) -> Result<Library> {
    ensure!(value.is_object(), "invalid navigation library");
    let library: Library = serde_json::from_value(value).context("invalid navigation library")?;
    let entries = library.projects.len()
        + library.threads.len()
        + library.project_order.len()
        + library.sections.len()
        + library.sidebar_thread_order.len()
        + library
            .projects
            .values()
            .map(|metadata| {
                metadata.navigation_summaries.as_ref().map_or(0, Vec::len)
                    + metadata.metadata.thread_order.as_ref().map_or(0, Vec::len)
            })
            .sum::<usize>();
    ensure!(
        entries <= MAX_ENTRIES,
        "navigation library entry limit exceeded"
    );
    Ok(library)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ProjectRegistration, ProjectSource};
    use serde_json::json;

    fn status(id: &str) -> ProjectStatus {
        ProjectStatus {
            registration: ProjectRegistration {
                project_id: id.into(),
                workspace: PathBuf::from("/workspace"),
                data_dir: PathBuf::from("/private-state"),
                source: ProjectSource::Cli,
                default_binding: true,
            },
            state: "stopped".into(),
            service: None,
            migration: None,
            schedule_activation_suppressed: false,
            schedule_activation_error: None,
        }
    }
    fn source(home: &Path) -> NavigationSource {
        NavigationSource {
            source_id: "approved-source".into(),
            core_home: home.into(),
            bindings: vec![NavigationBinding {
                project_id: "canonical".into(),
                alias: "legacy".into(),
                owned: true,
                logical_project_id: None,
                projectless: false,
            }],
        }
    }
    fn write(home: &Path, name: &str, value: Value) {
        std::fs::write(home.join(name), serde_json::to_vec(&value).unwrap()).unwrap();
    }

    #[test]
    fn command_result_preserves_library_contract_without_desktop_secrets() {
        let value = json!({"projects":{"p":{"title":"Renamed","worktreeEnvironments":[{"secret":"private"}],"navigationSummaries":[{"id":"thread","preview":"cached body"}]}},
            "threads":{},"projectOrder":["p"],"sections":[],"sidebarThreadOrder":[],"sidebarRevision":3,
            "settings":{"sidebarSort":"manual","httpProxy":"private","worktrees":{"token":"private"}}});
        let result = library_result(value).unwrap();
        assert_eq!(result["projects"]["p"], json!({"title":"Renamed"}));
        assert_eq!(result["settings"], json!({"sidebarSort":"manual"}));
        assert!(!result.to_string().contains("private"));
        assert!(!result.to_string().contains("cached body"));
        assert!(
            serde_json::from_value::<areal_protocol::host::WorkbenchLibraryState>(result).is_ok()
        );
        assert!(library_result(json!({})).is_err());
    }

    #[test]
    fn current_library_preserves_navigation_without_exposing_private_fields() {
        let root = tempfile::tempdir().unwrap();
        let input = json!({
            "projects": {"legacy": {"title":"Named project","pinned":true,
                "threadOrder":["thread"],"worktreeEnvironments":[{"secret":"private"}],
                "navigationSummaries":[{"id":"thread","name":"Named thread","preview":"Preview",
                    "createdAt":12,"updatedAt":18,"conversation":{"kind":"main","private":"secret"},
                    "desktop":{"archived":true,"configuration":{"token":"secret"}},"turns":["private"]}]},
                "unregistered":{"title":"Do not disclose"}},
            "threads":{"legacy:thread":{"title":"Renamed","unread":true,"completionId":"done",
                "scheduledCompletionId":"run","sectionId":"section"},"unregistered:thread":{"name":"private"}},
            "projectOrder":["legacy","unregistered"],"sections":[{"id":"section","title":"Work"}],
            "sidebarThreadOrder":["legacy:thread","unregistered:thread"],"sidebarRevision":7,
            "settings":{"sidebarSort":"priority","showPinned":false,"showCompleted":true,
                "httpProxy":"secret","worktrees":{"token":"secret"}}
        });
        write(root.path(), "library.json", input.clone());
        let sources = [source(root.path())];
        let first = snapshot(&[status("canonical"), status("cli")], &sources).unwrap();
        let result = serde_json::to_value(&first).unwrap();
        assert_eq!(result["projects"][0]["summaries"]["state"], "cached");
        assert_eq!(
            result["projects"][0]["summaries"]["items"][0]["desktop"],
            json!({"archived":true})
        );
        assert_eq!(
            result["projects"][1]["summaries"],
            json!({"state":"unknown","items":[]})
        );
        assert_eq!(
            result["navigation"][0]["threads"]["legacy:thread"]["completionId"],
            "done"
        );
        assert_eq!(result["navigation"][0]["projectOrder"], json!(["legacy"]));
        assert_eq!(
            result["navigation"][0]["preferences"],
            json!({"sidebarSort":"priority","showPinned":false,"showCompleted":true})
        );
        let text = serde_json::to_string(&result).unwrap();
        assert!(
            !text.contains("secret") && !text.contains("private") && !text.contains("unregistered")
        );
        assert_eq!(
            serde_json::from_slice::<Value>(
                &std::fs::read(root.path().join("library.json")).unwrap()
            )
            .unwrap(),
            input
        );
        write(
            root.path(),
            "library.json",
            json!({"projects":{"legacy":{"title":"Changed","navigationSummaries":[]}},"sidebarRevision":8}),
        );
        let next =
            serde_json::to_value(snapshot(&[status("canonical")], &sources).unwrap()).unwrap();
        assert_eq!(
            next["navigation"][0]["projects"]["legacy"]["title"],
            "Changed"
        );
        assert_eq!(
            next["projects"][0]["summaries"],
            json!({"state":"cached","items":[]})
        );
        assert_eq!(next["projects"][0]["attention"], json!({"state":"unknown"}));
    }

    #[test]
    fn absent_cache_remains_unknown_and_metadata_placeholders_are_not_complete() {
        let root = tempfile::tempdir().unwrap();
        let sources = [source(root.path())];
        let absent =
            serde_json::to_value(snapshot(&[status("canonical")], &sources).unwrap()).unwrap();
        assert_eq!(absent["navigation"][0]["state"], "unknown");
        assert_eq!(
            absent["projects"][0]["summaries"],
            json!({"state":"unknown","items":[]})
        );
        assert!(!root.path().join("library.json").exists());
        write(
            root.path(),
            "library.json",
            json!({"threads":{"legacy:known":{"title":"Known"}}}),
        );
        let partial =
            serde_json::to_value(snapshot(&[status("canonical")], &sources).unwrap()).unwrap();
        assert_eq!(partial["projects"][0]["summaries"]["state"], "unknown");
        assert_eq!(
            partial["projects"][0]["summaries"]["items"][0]["id"],
            "known"
        );
    }

    #[test]
    fn current_index_maps_logical_aliases_only_to_registered_projects() {
        let root = tempfile::tempdir().unwrap();
        let mut source = source(root.path());
        source.bindings.push(NavigationBinding {
            project_id: "worktree".into(),
            alias: "tree-alias".into(),
            owned: true,
            logical_project_id: None,
            projectless: false,
        });
        write(
            root.path(),
            "projects.json",
            json!([{"id":"tree-alias","root":"/ignored", "logicalProjectId":"legacy", "projectless":true,"environment":{"secret":"private"}}]),
        );
        let result = serde_json::to_value(
            snapshot(&[status("canonical"), status("worktree")], &[source]).unwrap(),
        )
        .unwrap();
        assert_eq!(result["projects"][1]["logicalProjectId"], "canonical");
        assert_eq!(result["projects"][1]["workspace"], "/workspace");
        assert_eq!(result["projects"][1]["projectless"], true);
        assert!(!result.to_string().contains("private"));
        write(
            root.path(),
            "projects.json",
            json!([{"id":"legacy","root":"/workspace","logicalProjectId":"unregistered"}]),
        );
        assert!(snapshot(&[status("canonical")], &[self::source(root.path())]).is_err());
    }

    #[test]
    fn worktree_display_uses_only_the_bound_current_record_without_changing_sources() {
        let root = tempfile::tempdir().unwrap();
        let request_id = "00000000-0000-4000-8000-000000000001";
        let mut source = source(root.path());
        source.bindings.push(NavigationBinding {
            project_id: "worktree".into(),
            alias: "tree-alias".into(),
            owned: true,
            logical_project_id: None,
            projectless: false,
        });
        let index = json!([{"id":"tree-alias","root":"/workspace",
            "logicalProjectId":"legacy","worktreeRequestId":request_id}]);
        write(root.path(), "projects.json", index.clone());
        let sources = [source];
        let statuses = [status("canonical"), status("worktree")];
        let read = || serde_json::to_value(snapshot(&statuses, &sources).unwrap()).unwrap();
        assert!(read()["projects"][1].get("worktree").is_none());
        std::fs::create_dir(root.path().join("worktree-requests")).unwrap();
        write(
            root.path(),
            "worktree-requests/unrelated.json",
            json!("unreadable old record"),
        );
        let name = format!("worktree-requests/{request_id}.json");
        let operation = json!({"requestId":request_id,"projectId":"legacy",
            "executionProjectId":"tree-alias","state":"ready","automatic":true,
            "sourceRoot":"/source/subdirectory","environment":{"secret":"private"},
            "events":[{"message":"private"}],"parameters":{"token":"private"},
            "record":{"directory":"/checkout","cwd":"/workspace","branch":"feature",
                "base":"main","target":"/source","copied":["private"],"config":{"secret":"private"}}});
        write(root.path(), &name, operation.clone());
        let result = read();
        assert_eq!(
            result["projects"][1]["worktree"],
            json!({
                "state":"ready","directory":"/workspace","checkoutRoot":"/checkout",
                "branch":"feature","base":"main","sourceRoot":"/source/subdirectory",
                "requestId":request_id,"automatic":true
            })
        );
        assert!(!result.to_string().contains("private"));
        for (name, expected) in [("projects.json", &index), (name.as_str(), &operation)] {
            assert_eq!(
                serde_json::from_slice::<Value>(&std::fs::read(root.path().join(name)).unwrap())
                    .unwrap(),
                *expected
            );
        }
        let mut no_record = operation.clone();
        no_record.as_object_mut().unwrap().remove("record");
        write(root.path(), &name, no_record);
        assert!(read()["projects"][1].get("worktree").is_none());
        let mut fallback = operation;
        fallback.as_object_mut().unwrap().remove("sourceRoot");
        fallback.as_object_mut().unwrap().remove("automatic");
        fallback["record"].as_object_mut().unwrap().remove("cwd");
        fallback["record"]["directory"] = json!("/workspace");
        write(root.path(), &name, fallback);
        assert_eq!(read()["projects"][1]["worktree"]["sourceRoot"], "/source");
        assert_eq!(read()["projects"][1]["worktree"]["automatic"], false);
    }

    #[test]
    fn worktree_display_rejects_conflicts_unsafe_paths_and_unbounded_files() {
        let root = tempfile::tempdir().unwrap();
        let request_id = "00000000-0000-4000-8000-000000000001";
        let mut source = source(root.path());
        source.bindings.push(NavigationBinding {
            project_id: "worktree".into(),
            alias: "tree-alias".into(),
            owned: true,
            logical_project_id: None,
            projectless: false,
        });
        let mut index = json!([{"id":"tree-alias","root":"/workspace",
            "logicalProjectId":"legacy","worktreeRequestId":request_id}]);
        write(root.path(), "projects.json", index.clone());
        let sources = [source];
        let statuses = [status("canonical"), status("worktree")];
        let read = || snapshot(&statuses, &sources);
        std::fs::create_dir(root.path().join("worktree-requests")).unwrap();
        let name = format!("worktree-requests/{request_id}.json");
        let operation = json!({"requestId":request_id,"projectId":"legacy",
            "executionProjectId":"tree-alias","state":"ready",
            "record":{"directory":"/workspace","branch":"feature","base":"main","target":"/source"}});
        for (field, value) in [
            ("requestId", json!("different")),
            ("projectId", json!("other")),
            ("executionProjectId", json!("other")),
            ("state", json!("invented")),
        ] {
            let mut bad = operation.clone();
            bad[field] = value;
            write(root.path(), &name, bad);
            assert!(read().is_err(), "{field} conflict was accepted");
        }
        let mut bad = operation.clone();
        bad["record"]["cwd"] = json!("/other");
        write(root.path(), &name, bad);
        assert!(read().is_err());
        index[0]["worktreeRequestId"] = json!("../outside");
        write(root.path(), "projects.json", index.clone());
        assert!(read().is_err());
        index[0]["worktreeRequestId"] = json!(request_id);
        write(root.path(), "projects.json", index);
        let path = root.path().join(&name);
        std::fs::File::create(&path)
            .unwrap()
            .set_len(MAX_LIBRARY_BYTES + 1)
            .unwrap();
        assert!(read().is_err());
        std::fs::remove_file(&path).unwrap();
        let target = root.path().join("outside.json");
        std::fs::write(&target, serde_json::to_vec(&operation).unwrap()).unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();
        assert!(read().is_err());
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(root.path().join("worktree-requests")).unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("worktree-requests")).unwrap();
        assert!(read().is_err());
        assert_eq!(
            serde_json::from_slice::<Value>(&std::fs::read(target).unwrap()).unwrap(),
            operation
        );
    }

    #[test]
    fn malformed_symlink_and_oversized_metadata_fail_instead_of_becoming_empty() {
        let root = tempfile::tempdir().unwrap();
        let sources = [source(root.path())];
        let path = root.path().join("library.json");
        std::fs::write(&path, b"{broken").unwrap();
        assert!(snapshot(&[status("canonical")], &sources).is_err());
        std::fs::write(&path, b"[]").unwrap();
        assert!(snapshot(&[status("canonical")], &sources).is_err());
        std::fs::remove_file(&path).unwrap();
        let target = root.path().join("target.json");
        std::fs::write(&target, b"{}").unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();
        assert!(snapshot(&[status("canonical")], &sources).is_err());
        std::fs::remove_file(&path).unwrap();
        std::fs::File::create(&path)
            .unwrap()
            .set_len(MAX_LIBRARY_BYTES + 1)
            .unwrap();
        assert!(snapshot(&[status("canonical")], &sources).is_err());
    }

    #[test]
    fn only_complete_same_generation_observation_can_replace_cached_summaries() {
        let mut project = snapshot(&[status("canonical")], &[])
            .unwrap()
            .projects
            .remove(0);
        project.state = "ready".into();
        project.service_generation = Some("generation".into());
        assert!(apply_observation(&mut project, "old", vec![], Some(0)).is_err());
        assert!(matches!(project.summaries, Summaries::Unknown { .. }));
        apply_observation(&mut project,"generation",vec![json!({"id":"thread","desktop":{"archived":false,"configuration":{"secret":"private"}}})],Some(3)).unwrap();
        assert!(matches!(project.attention, Attention::Fresh { count: 3 }));
        assert!(!serde_json::to_string(&project).unwrap().contains("private"));
        let fresh = project.clone();
        assert!(
            apply_observation(
                &mut project,
                "generation",
                vec![json!({"id":"same"}), json!({"id":"same"})],
                Some(0)
            )
            .is_err()
        );
        assert_eq!(project, fresh);
        project.state = "stopped".into();
        assert!(apply_observation(&mut project, "generation", vec![], Some(0)).is_err());
    }
}
