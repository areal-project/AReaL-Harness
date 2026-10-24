//! Local-only Codex plugin packages. No package code, hooks or MCP is executed.
mod archive;
mod components;
pub mod hook_sources;
pub mod hooks;
mod metadata;
mod package;
mod remote;
mod support;
pub use components::{
    AppDeclaration, ComponentDocument, InstalledComponents, InstalledSnapshot,
    McpComponentDocument, app_declarations,
};
pub use support::{
    CompatibilityState, ComponentCompatibility, ComponentKind, ComponentSupport, ManifestFormat,
    PackageComponentSupport, SupportStatus, SupportValidation,
};
// Codex 0.162.1 marketplace discovery precedence.
const CATALOG_PATHS: &[&str] = &[
    ".agents/plugins/marketplace.json",
    ".agents/plugins/api_marketplace.json",
    ".claude-plugin/marketplace.json",
    ".cursor-plugin/marketplace.json",
];
use anyhow::{Context, Result, ensure};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::os::unix::fs::PermissionsExt;
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

/// Create only the package data leaf through an existing anchored parent.
/// No symlink component may redirect Core's pre-execution directory creation.
pub fn prepare_data_directory(path: &Path) -> Result<()> {
    use rustix::fs::{Mode, OFlags, mkdirat, openat};
    let parent = package::directory(path.parent().context("data directory has no parent")?)?;
    let leaf = path.file_name().context("data directory has no name")?;
    match mkdirat(&parent, leaf, Mode::RWXU) {
        Ok(()) | Err(rustix::io::Errno::EXIST) => {}
        Err(error) => return Err(error.into()),
    }
    openat(
        &parent,
        leaf,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InstalledSkill {
    pub id: String,
    pub revision: String,
    pub root: PathBuf,
    pub package_root: PathBuf,
    pub plugin_id: String,
    pub name: String,
    pub description: String,
    pub allow_implicit_invocation: bool,
    pub onboarding: bool,
    #[serde(default)]
    pub required_tools: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum PluginComponentId {
    Skill { id: String },
    McpServer { id: String },
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ComponentChoices {
    #[serde(default)]
    pub disabled_skills: BTreeSet<String>,
    #[serde(default)]
    pub disabled_mcp_servers: BTreeSet<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InstalledMetadata {
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub version: Option<String>,
    pub interface: Option<serde_json::Value>,
    pub components: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PluginDetail {
    pub revision: u64,
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub version: Option<String>,
    pub installed: bool,
    #[serde(default)]
    pub installed_version: Option<String>,
    #[serde(default)]
    pub installed_digest: Option<String>,
    #[serde(default)]
    pub installed_source_digest: Option<String>,
    #[serde(default)]
    pub admission_digest: Option<String>,
    #[serde(skip)]
    pub(crate) definition: Option<package::Definition>,
    #[serde(default)]
    pub installed_skills: Vec<InstalledSkill>,
    #[serde(default)]
    pub component_choices: ComponentChoices,
    #[serde(default)]
    pub installed_metadata: Option<InstalledMetadata>,
    #[serde(default)]
    pub component_support: Option<PackageComponentSupport>,
    #[serde(default)]
    pub installed_component_support: Option<PackageComponentSupport>,
    #[serde(default)]
    pub installed_onboarding_skill: Option<String>,
    pub enabled: bool,
    pub source: PathBuf,
    pub source_digest: String,
    #[serde(default)]
    pub catalog_source: serde_json::Value,
    #[serde(default)]
    pub policy: serde_json::Value,
    #[serde(default)]
    pub interface: Option<serde_json::Value>,
    #[serde(default)]
    pub source_kind: Option<String>,
    #[serde(default)]
    pub resolved_commit: Option<String>,
    #[serde(default)]
    pub package_version: Option<String>,
    #[serde(default)]
    pub integrity: Option<String>,
    pub components: Vec<String>,
    pub diagnostics: Vec<String>,
    pub skills: Vec<InstalledSkill>,
    #[serde(default)]
    pub required_tools: Vec<String>,
    pub onboarding_skill: Option<String>,
}
impl PluginDetail {
    pub fn review_digest(&self) -> &str {
        self.admission_digest
            .as_deref()
            .unwrap_or(&self.source_digest)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Marketplace {
    pub name: String,
    pub root: PathBuf,
    #[serde(default)]
    pub source_url: Option<String>,
    #[serde(default)]
    pub resolved_commit: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PluginList {
    pub revision: u64,
    pub data: Vec<PluginDetail>,
    pub marketplaces: Vec<Marketplace>,
    pub errors: Vec<String>,
}
#[derive(Debug)]
pub enum StoreError {
    Conflict { expected: u64, actual: u64 },
    NotFound(String),
    SourceChanged { id: String },
}
impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Conflict { expected, actual } => write!(
                f,
                "plugin revision conflict: expected {expected}, actual {actual}"
            ),
            Self::NotFound(id) => write!(f, "plugin not found: {id}"),
            Self::SourceChanged { id } => write!(
                f,
                "plugin selected source or content changed: {id}; refresh the catalog before installing"
            ),
        }
    }
}
impl std::error::Error for StoreError {}
#[derive(Default, Serialize, Deserialize)]
struct State {
    revision: u64,
    #[serde(default)]
    marketplaces: Vec<PathBuf>,
    #[serde(default)]
    installed: BTreeMap<String, PluginDetail>,
    #[serde(default)]
    history: Vec<InstalledSkill>,
    #[serde(default)]
    definitions: BTreeMap<String, package::Definition>,
    #[serde(default)]
    candidates: BTreeMap<String, remote::Candidate>,
    #[serde(default)]
    installed_policies: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    git_marketplaces: BTreeMap<PathBuf, remote::GitPin>,
    #[serde(default)]
    user: BTreeMap<String, bool>,
    #[serde(default)]
    projects: BTreeMap<String, BTreeMap<String, bool>>,
    #[serde(default)]
    component_choices: BTreeMap<String, BTreeMap<String, ComponentChoices>>,
}
pub struct Store {
    component_cache: std::sync::Arc<
        std::sync::Mutex<BTreeMap<String, (package::Fingerprint, InstalledComponents)>>,
    >,
    #[cfg(test)]
    component_reads: std::sync::atomic::AtomicUsize,
    root: PathBuf,
    workspace: PathBuf,
    user_home: Option<PathBuf>,
    discovery_workspaces: Option<Vec<PathBuf>>,
}
impl Store {
    pub fn open(root: PathBuf, workspace: PathBuf, user_home: Option<PathBuf>) -> Result<Self> {
        fs::create_dir_all(&root)?;
        let root = root.canonicalize()?;
        let workspace = workspace.canonicalize()?;
        for name in ["cache", "staging", "data"] {
            fs::create_dir_all(root.join(name))?;
        }
        Ok(Self {
            component_cache: Default::default(),
            #[cfg(test)]
            component_reads: Default::default(),
            root,
            workspace,
            user_home,
            discovery_workspaces: None,
        })
    }
    pub fn workspace(&self) -> &Path {
        &self.workspace
    }
    /// Current authority only; never enumerate packages or contact a source.
    /// Replacements retain old admitted revisions, while disable/uninstall revoke them.
    pub fn enabled_revisions(&self) -> Result<BTreeMap<String, String>> {
        let state = self.state()?;
        let mut revisions = BTreeMap::new();
        for (id, detail) in &state.installed {
            if self.effective(&state, id)? {
                revisions.insert(id.clone(), detail.review_digest().into());
            }
        }
        Ok(revisions)
    }
    fn state(&self) -> Result<State> {
        match fs::read(self.root.join("state.json")) {
            Ok(b) => serde_json::from_slice(&b).context("invalid plugin state; refusing to reset"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(State::default()),
            Err(e) => Err(e.into()),
        }
    }
    fn transact<T>(
        &self,
        expected: u64,
        operation: impl FnOnce(&mut State) -> Result<T>,
    ) -> Result<T> {
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.root.join("state.lock"))?;
        lock.lock_exclusive()?;
        let mut state = self.state()?;
        if state.revision != expected {
            return Err(StoreError::Conflict {
                expected,
                actual: state.revision,
            }
            .into());
        }
        let result = operation(&mut state)?;
        state.revision = state
            .revision
            .checked_add(1)
            .context("plugin revision overflow")?;
        let mut tmp = tempfile::NamedTempFile::new_in(&self.root)?;
        tmp.write_all(&serde_json::to_vec_pretty(&state)?)?;
        tmp.as_file().sync_all()?;
        tmp.persist(self.root.join("state.json"))?;
        File::open(&self.root)?.sync_all()?;
        Ok(result)
    }
    fn enabled(&self, s: &State, id: &str) -> bool {
        let user = s.user.get(id).copied();
        let project = s
            .projects
            .get(&self.workspace.to_string_lossy().into_owned())
            .and_then(|p| p.get(id))
            .copied();
        s.installed.contains_key(id) && project.or(user).unwrap_or(false)
    }
    fn effective(&self, state: &State, id: &str) -> Result<bool> {
        if !self.enabled(state, id) {
            return Ok(false);
        }
        Ok(self
            .installed_support(
                state,
                state.installed.get(id).context("plugin not installed")?,
            )?
            .allowed())
    }
    fn component_choices(&self, state: &State, id: &str) -> ComponentChoices {
        state
            .component_choices
            .get(&self.workspace.to_string_lossy().into_owned())
            .and_then(|plugins| plugins.get(id))
            .cloned()
            .unwrap_or_default()
    }
    fn definition<'a>(
        &self,
        state: &'a State,
        id: &str,
        revision: &str,
        package_digest: &str,
    ) -> Result<Option<&'a package::Definition>> {
        let definition = state.definitions.get(revision);
        if revision != package_digest {
            let definition = definition.context("installed plugin definition receipt missing")?;
            definition.validate(id, revision)?;
            ensure!(
                definition.package_digest == package_digest,
                "definition package digest mismatch"
            );
        } else {
            ensure!(
                definition.is_none(),
                "legacy revision has unexpected definition receipt"
            );
        }
        Ok(definition)
    }
    fn installed_support(
        &self,
        state: &State,
        detail: &PluginDetail,
    ) -> Result<PackageComponentSupport> {
        Ok(self
            .read_components(
                &detail.id,
                detail.review_digest(),
                self.root.join("cache").join(&detail.source_digest),
                self.definition(
                    state,
                    &detail.id,
                    detail.review_digest(),
                    &detail.source_digest,
                )?,
                state
                    .installed_policies
                    .get(&detail.id)
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            )?
            .support)
    }
    fn choice(&self, s: &mut State, id: &str, scope: &str, enabled: bool) -> Result<()> {
        match scope {
            "user" => {
                s.user.insert(id.into(), enabled);
            }
            "project" => {
                s.projects
                    .entry(self.workspace.to_string_lossy().into_owned())
                    .or_default()
                    .insert(id.into(), enabled);
            }
            _ => anyhow::bail!("invalid plugin scope: expected user or project"),
        };
        Ok(())
    }
    fn catalogs(&self, s: &State) -> (Vec<Marketplace>, Vec<PluginDetail>, Vec<String>) {
        let mut roots = s.marketplaces.clone();
        roots.extend(
            self.discovery_workspaces
                .clone()
                .unwrap_or_else(|| vec![self.workspace.clone()]),
        );
        if let Some(home) = &self.user_home {
            roots.push(home.clone());
        }
        roots.sort();
        roots.dedup();
        let mut markets = Vec::new();
        let mut details = BTreeMap::new();
        let mut errors = Vec::new();
        let mut market_names = BTreeMap::new();
        for root in roots {
            let Some(path) = CATALOG_PATHS
                .iter()
                .map(|p| root.join(p))
                .find(|p| fs::symlink_metadata(p).is_ok())
            else {
                continue;
            };
            let load = (|| -> Result<(String, Vec<serde_json::Value>)> {
                let bytes = package::read_catalog(&root, &path)?;
                let v: serde_json::Value = serde_json::from_slice(&bytes)?;
                let name = v["name"]
                    .as_str()
                    .context("marketplace name missing")?
                    .to_owned();
                ensure!(
                    !name.is_empty()
                        && name.len() <= 128
                        && name
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b)),
                    "invalid marketplace name"
                );
                let entries = v["plugins"]
                    .as_array()
                    .context("marketplace plugins missing")?
                    .clone();
                ensure!(entries.len() <= 1024, "marketplace exceeds 1024 entries");
                Ok((name, entries))
            })();
            let (name, entries) = match load {
                Ok(x) => x,
                Err(e) => {
                    errors.push(format!("{}: {e:#}", path.display()));
                    continue;
                }
            };
            if let Some(previous) = market_names.insert(name.clone(), root.clone()) {
                errors.push(format!(
                    "ambiguous marketplace {name}: {} and {}",
                    previous.display(),
                    root.display()
                ));
                details.retain(|id: &String, _| !id.ends_with(&format!("@{name}")));
                continue;
            }
            markets.push(Marketplace {
                name: name.clone(),
                root: root.clone(),
                source_url: s.git_marketplaces.get(&root).map(|pin| pin.url.clone()),
                resolved_commit: s.git_marketplaces.get(&root).map(|pin| pin.commit.clone()),
            });
            let mut seen = std::collections::BTreeSet::new();
            for (index, entry) in entries.into_iter().enumerate() {
                let context = package::CatalogContext {
                    entry: entry.clone(),
                    origin: format!(
                        "{}#/plugins/{index}",
                        path.strip_prefix(&root).unwrap().display()
                    ),
                };
                let loaded = (|| -> Result<PluginDetail> {
                    let n = entry["name"].as_str().context("entry name missing")?;
                    let id = format!("{n}@{name}");
                    ensure!(seen.insert(id.clone()), "duplicate plugin identity: {id}");
                    ensure!(
                        entry
                            .pointer("/policy/installation")
                            .and_then(serde_json::Value::as_str)
                            != Some("NOT_AVAILABLE"),
                        "plugin {id} is NOT_AVAILABLE"
                    );
                    if remote::is_remote(&entry["source"]) {
                        return remote::preview(&entry, &id, &root, s.candidates.get(&id));
                    }
                    let source = if let Some(p) = entry["source"].as_str() {
                        p
                    } else {
                        let src = &entry["source"];
                        ensure!(
                            matches!(
                                src["source"].as_str().or(src["type"].as_str()),
                                Some("local" | "directory")
                            ),
                            "sourceUnsupported: unsupported marketplace source type"
                        );
                        src["path"].as_str().context("local source path missing")?
                    };
                    let source = if matches!(source, "." | "./") {
                        root.clone()
                    } else {
                        root.join(package::relative(source)?)
                    };
                    let files = package::snapshot(&source)?;
                    let cache = self.root.join("cache").join(package::digest(&files));
                    let (mut detail, _) =
                        package::parse_context(&files, &id, &source, &cache, Some(&context))?;
                    detail.catalog_source = metadata::source(&entry, &root, Some(&source))?;
                    detail.policy = metadata::policy(&entry)?;
                    detail.interface = metadata::catalog_interface(detail.interface, &entry);
                    detail.source_kind = Some("local".into());
                    ensure!(detail.name == n, "catalog/manifest plugin name mismatch");
                    Ok(detail)
                })();
                match loaded {
                    Ok(d) => {
                        details.insert(d.id.clone(), d);
                    }
                    Err(e) => {
                        if let Some(n) = entry["name"].as_str() {
                            details.remove(&format!("{n}@{name}"));
                        }
                        errors.push(format!(
                            "{} entry {}: {e:#}",
                            path.display(),
                            entry.get("name").unwrap_or(&serde_json::Value::Null)
                        ))
                    }
                }
            }
        }
        for (id, candidate) in &s.candidates {
            if candidate.detail.source_kind.as_deref() == Some("archive") {
                details.insert(id.clone(), candidate.detail.clone());
            }
        }
        (markets, details.into_values().collect(), errors)
    }
    pub fn list(&self) -> Result<PluginList> {
        let s = self.state()?;
        let (marketplaces, discovered, errors) = self.catalogs(&s);
        let mut data: BTreeMap<_, _> = discovered.into_iter().map(|d| (d.id.clone(), d)).collect();
        for (id, installed) in &s.installed {
            // Never pair installed metadata with a candidate digest: approval
            // covers the complete candidate row. Execution stays on installed_*.
            let report = self.installed_support(&s, installed)?;
            let detail = data.entry(id.clone()).or_insert_with(|| {
                let mut fallback = installed.clone();
                fallback.component_support = None;
                fallback
            });
            detail.installed_component_support = Some(report);
            detail.installed_version = installed.version.clone();
            detail.installed_digest = Some(installed.review_digest().into());
            detail.installed_source_digest = Some(installed.source_digest.clone());
            detail.installed_skills = installed.skills.clone();
            detail.installed_onboarding_skill = installed.onboarding_skill.clone();
            detail.installed_metadata = Some(InstalledMetadata {
                name: installed.name.clone(),
                display_name: installed.display_name.clone(),
                description: installed.description.clone(),
                version: installed.version.clone(),
                interface: installed.interface.clone(),
                components: installed.components.clone(),
            });
        }
        let data = data
            .into_values()
            .map(|mut d| {
                d.revision = s.revision;
                d.installed = s.installed.contains_key(&d.id);
                d.enabled = self.enabled(&s, &d.id);
                d.component_choices = self.component_choices(&s, &d.id);
                d
            })
            .collect();
        Ok(PluginList {
            revision: s.revision,
            data,
            marketplaces,
            errors,
        })
    }
    /// Codex read-only discovery: omitted/empty cwds discover only registered and home catalogs.
    pub fn list_for_workspaces(&self, cwds: &[PathBuf]) -> Result<PluginList> {
        ensure!(cwds.len() <= 64, "too many discovery workspaces");
        let workspaces = cwds
            .iter()
            .map(|p| {
                ensure!(p.is_absolute(), "discovery cwd must be absolute");
                let path = p.canonicalize()?;
                ensure!(path.is_dir(), "discovery cwd must be a directory");
                Ok(path)
            })
            .collect::<Result<Vec<_>>>()?;
        let view = Self {
            component_cache: self.component_cache.clone(),
            #[cfg(test)]
            component_reads: Default::default(),
            root: self.root.clone(),
            workspace: workspaces
                .first()
                .cloned()
                .unwrap_or_else(|| self.root.clone()),
            user_home: self.user_home.clone(),
            discovery_workspaces: Some(workspaces),
        };
        view.list()
    }
    pub fn read(&self, id: &str) -> Result<PluginDetail> {
        self.list()?
            .data
            .into_iter()
            .find(|d| d.id == id)
            .ok_or_else(|| StoreError::NotFound(id.into()).into())
    }
    pub fn add_marketplace(&self, root: &Path, expected_revision: u64) -> Result<PluginList> {
        let root = root.canonicalize()?;
        ensure!(
            CATALOG_PATHS.iter().any(|p| root.join(p).is_file()),
            "marketplace catalog missing"
        );
        self.transact(expected_revision, |s| {
            if !s.marketplaces.contains(&root) {
                s.marketplaces.push(root);
            }
            Ok(())
        })?;
        self.list()
    }
    pub fn install(
        &self,
        id: &str,
        scope: &str,
        expected_revision: u64,
        expected_source: &Path,
        expected_digest: &str,
    ) -> Result<PluginDetail> {
        ensure!(matches!(scope, "user" | "project"), "invalid plugin scope");
        let state = self.state()?;
        let (_, discovered, errors) = self.catalogs(&state);
        let candidate = discovered.into_iter().find(|d| d.id == id).ok_or_else(|| {
            anyhow::anyhow!("plugin source unavailable {id}: {}", errors.join("; "))
        })?;
        if candidate.source != expected_source || candidate.review_digest() != expected_digest {
            return Err(StoreError::SourceChanged { id: id.into() }.into());
        }
        if let Some(revision) = &candidate.admission_digest {
            candidate
                .definition
                .as_ref()
                .context("candidate definition receipt missing")?
                .validate(id, revision)?;
        }
        let content_root = state
            .candidates
            .get(id)
            .filter(|c| {
                c.detail.source == candidate.source
                    && c.detail.source_digest == candidate.source_digest
            })
            .map(|c| c.root.as_path())
            .unwrap_or(&candidate.source);
        let policy = candidate.policy.clone();
        let files = package::snapshot(content_root)?;
        let digest = package::digest(&files);
        if digest != candidate.source_digest {
            return Err(StoreError::SourceChanged { id: id.into() }.into());
        }
        let cache = self.root.join("cache").join(&digest);
        let (mut detail, _) = package::parse_context(
            &files,
            id,
            &candidate.source,
            &cache,
            candidate.definition.as_ref().map(|d| &d.context),
        )?;
        if let Some(definition) = &candidate.definition {
            definition.validate(id, expected_digest)?;
            detail.definition = Some(definition.clone());
            detail.admission_digest = candidate.admission_digest.clone();
            for skill in &mut detail.skills {
                skill.revision = expected_digest.into();
            }
            if let Some(support) = &mut detail.component_support {
                support.digest = expected_digest.into();
            }
        }
        ensure!(
            detail.name == candidate.name,
            "plugin identity changed during installation"
        );
        let stage = tempfile::tempdir_in(self.root.join("staging"))?;
        for (path, bytes) in &files {
            let dest = stage.path().join(path);
            fs::create_dir_all(dest.parent().unwrap())?;
            let mut f = File::create(&dest)?;
            f.write_all(&bytes.bytes)?;
            f.sync_all()?;
            f.set_permissions(fs::Permissions::from_mode(if bytes.executable {
                0o555
            } else {
                0o444
            }))?;
        }
        detail.catalog_source = candidate.catalog_source.clone();
        detail.policy = candidate.policy.clone();
        detail.interface = candidate.interface.clone();
        detail.source_kind = candidate.source_kind.clone();
        detail.resolved_commit = candidate.resolved_commit.clone();
        detail.package_version = candidate.package_version.clone();
        detail.integrity = candidate.integrity.clone();
        detail.installed = true;
        self.transact(expected_revision, |s| {
            let (_, current, _) = self.catalogs(s);
            ensure!(
                current.iter().any(|d| d.id == id
                    && d.source == candidate.source
                    && d.source_digest == digest
                    && d.review_digest() == expected_digest),
                "plugin source changed during installation"
            );
            if cache.exists() {
                ensure!(
                    package::digest(&package::snapshot(&cache)?) == digest,
                    "cached package integrity mismatch"
                );
            } else {
                fs::rename(stage.path(), &cache)?;
                seal_directory(&cache)?;
                File::open(self.root.join("cache"))?.sync_all()?;
            }
            for skill in &detail.skills {
                if !s
                    .history
                    .iter()
                    .any(|old| old.id == skill.id && old.revision == skill.revision)
                {
                    s.history.push(skill.clone());
                }
            }
            if let Some(definition) = &detail.definition {
                s.definitions
                    .insert(detail.review_digest().into(), definition.clone());
            }
            s.installed.insert(id.into(), detail.clone());
            s.installed_policies.insert(id.into(), policy);
            self.choice(s, id, scope, true)?;
            Ok(())
        })?;
        self.read(id)
    }
    pub fn configure(
        &self,
        id: &str,
        scope: &str,
        enabled: bool,
        expected_revision: u64,
    ) -> Result<PluginDetail> {
        self.transact(expected_revision, |s| {
            if !s.installed.contains_key(id) {
                return Err(StoreError::NotFound(id.into()).into());
            }
            self.choice(s, id, scope, enabled)
        })?;
        self.read(id)
    }
    pub fn uninstall(&self, id: &str, expected_revision: u64) -> Result<PluginList> {
        self.transact(expected_revision, |s| {
            if s.installed.remove(id).is_none() {
                return Err(StoreError::NotFound(id.into()).into());
            }
            s.installed_policies.remove(id);
            s.user.remove(id);
            for p in s.projects.values_mut() {
                p.remove(id);
            }
            for choices in s.component_choices.values_mut() {
                choices.remove(id);
            }
            Ok(())
        })?;
        self.list()
    }
    pub fn installed_skills(&self) -> Result<Vec<InstalledSkill>> {
        Ok(self
            .state()?
            .installed
            .into_values()
            .flat_map(|d| d.skills)
            .collect())
    }
    pub fn retained_skills(&self) -> Result<Vec<InstalledSkill>> {
        Ok(self.state()?.history)
    }
    pub fn enabled_skills(&self) -> Result<Vec<InstalledSkill>> {
        let state = self.state()?;
        let mut skills = Vec::new();
        for detail in state.installed.values() {
            for skill in &detail.skills {
                if self.skill_allowed(&state, skill)? {
                    skills.push(skill.clone());
                }
            }
        }
        Ok(skills)
    }
    fn skill_allowed(&self, state: &State, skill: &InstalledSkill) -> Result<bool> {
        Ok(self.effective(state, &skill.plugin_id)?
            && !self
                .component_choices(state, &skill.plugin_id)
                .disabled_skills
                .contains(&skill.id)
            && self.skill_compatible(state, skill)?)
    }
    pub fn configure_component(
        &self,
        id: &str,
        component: &PluginComponentId,
        enabled: bool,
        expected_revision: u64,
        expected_digest: &str,
    ) -> Result<PluginDetail> {
        self.transact(expected_revision, |state| {
            let detail = state
                .installed
                .get(id)
                .ok_or_else(|| StoreError::NotFound(id.into()))?;
            ensure!(
                detail.review_digest() == expected_digest,
                "plugin installed digest changed"
            );
            if let PluginComponentId::Skill { id } = component {
                ensure!(
                    detail.skills.iter().any(|skill| skill.id == *id),
                    "plugin skill not found"
                );
            }
            let choices = state
                .component_choices
                .entry(self.workspace.to_string_lossy().into_owned())
                .or_default()
                .entry(id.into())
                .or_default();
            let (disabled, id) = match component {
                PluginComponentId::Skill { id } => (&mut choices.disabled_skills, id),
                PluginComponentId::McpServer { id } => (&mut choices.disabled_mcp_servers, id),
            };
            if enabled {
                disabled.remove(id);
            } else {
                disabled.insert(id.clone());
            }
            Ok(())
        })?;
        self.read(id)
    }
    fn skill_compatible(&self, state: &State, skill: &InstalledSkill) -> Result<bool> {
        let package_digest = skill
            .package_root
            .file_name()
            .and_then(|name| name.to_str())
            .context("skill package digest missing")?;
        let definition =
            self.definition(state, &skill.plugin_id, &skill.revision, package_digest)?;
        let raw_digest = definition
            .map(|d| d.package_digest.as_str())
            .unwrap_or(&skill.revision);
        ensure!(
            skill.package_root == self.root.join("cache").join(raw_digest),
            "skill package root does not match admitted revision"
        );
        Ok(self
            .read_components(
                &skill.plugin_id,
                &skill.revision,
                skill.package_root.clone(),
                definition,
                state
                    .installed_policies
                    .get(&skill.plugin_id)
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            )?
            .support
            .allowed())
    }
    pub fn is_skill_enabled(&self, id: &str, revision: &str) -> Result<bool> {
        let state = self.state()?;
        match state
            .history
            .iter()
            .find(|skill| skill.id == id && skill.revision == revision)
        {
            Some(skill) => self.skill_allowed(&state, skill),
            None => Ok(false),
        }
    }
}

// Persist directory entries before committing state and deny ordinary
// writes to published directories. P0 intentionally never deletes cache entries.
fn seal_directory(path: &Path) -> Result<()> {
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            seal_directory(&entry.path())?;
        }
    }
    File::open(path)?.sync_all()?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o555))?;
    Ok(())
}
