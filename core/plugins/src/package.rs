use crate::{InstalledSkill, PluginDetail};
use anyhow::{Context, Result, bail, ensure};
use rustix::fs::{Dir, Mode, OFlags, open, openat};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::File,
    io::Read,
    os::unix::fs::MetadataExt,
    path::{Component, Path, PathBuf},
};
const MAX_BYTES: usize = 64 * 1024 * 1024;
#[derive(Clone, Copy)]
pub(crate) enum SnapshotBudget {
    Plugin,
    Marketplace,
}
struct SnapshotLimits {
    files: usize,
    entries: usize,
    bytes: usize,
}
impl SnapshotBudget {
    fn limits(self) -> SnapshotLimits {
        let (files, entries) = match self {
            Self::Plugin => (4096, 8192),
            Self::Marketplace => (20_000, 20_000),
        };
        SnapshotLimits {
            files,
            entries,
            bytes: MAX_BYTES,
        }
    }
}
pub(crate) struct PackageFile {
    pub bytes: Vec<u8>,
    pub executable: bool,
}
impl std::ops::Deref for PackageFile {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        &self.bytes
    }
}
pub(crate) type Files = BTreeMap<String, PackageFile>;

/// Open every ancestor without following links, then enumerate/read only through
/// anchored descriptors. Concurrent source edits may fail or form a new snapshot;
/// they cannot redirect reads outside the selected package.
pub(crate) fn directory(path: &Path) -> Result<File> {
    ensure!(path.is_absolute(), "package root must be absolute");
    let mut dir = File::from(open(
        "/",
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
        Mode::empty(),
    )?);
    for c in path.components() {
        match c {
            Component::RootDir | Component::CurDir => {}
            Component::Normal(n) => {
                dir = File::from(openat(
                    &dir,
                    n,
                    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                    Mode::empty(),
                )?);
            }
            _ => bail!("parent traversal rejected"),
        }
    }
    Ok(dir)
}
/// Catalogs are untrusted inputs too. Bound actual reads (not just the initial
/// stat), and never open a FIFO or link using the blocking filesystem APIs.
pub(crate) fn read_catalog(root: &Path, path: &Path) -> Result<Vec<u8>> {
    let relative = path
        .strip_prefix(root)
        .context("catalog outside marketplace root")?;
    let mut dir = directory(root)?;
    let mut components = relative.components().peekable();
    while let Some(component) = components.next() {
        let Component::Normal(name) = component else {
            bail!("invalid catalog path")
        };
        let last = components.peek().is_none();
        let flags = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC;
        let mut file = File::from(openat(
            &dir,
            name,
            if last {
                flags
            } else {
                flags | OFlags::DIRECTORY
            },
            Mode::empty(),
        )?);
        if !last {
            dir = file;
            continue;
        }
        let metadata = file.metadata()?;
        ensure!(
            metadata.is_file() && metadata.nlink() == 1,
            "catalog must be a regular single-link file"
        );
        const LIMIT: u64 = 1024 * 1024;
        ensure!(metadata.len() <= LIMIT, "marketplace exceeds 1 MiB");
        let mut bytes = Vec::new();
        file.by_ref().take(LIMIT + 1).read_to_end(&mut bytes)?;
        ensure!(bytes.len() <= LIMIT as usize, "marketplace exceeds 1 MiB");
        let after = file.metadata()?;
        ensure!(
            after.nlink() == 1
                && after.len() == metadata.len()
                && after.mtime() == metadata.mtime()
                && after.mtime_nsec() == metadata.mtime_nsec(),
            "marketplace changed during read"
        );
        return Ok(bytes);
    }
    bail!("catalog file missing")
}
pub(crate) fn snapshot(root: &Path) -> Result<Files> {
    snapshot_with_budget(root, SnapshotBudget::Plugin)
}
pub(crate) fn snapshot_with_budget(root: &Path, budget: SnapshotBudget) -> Result<Files> {
    Ok(read_snapshot(root, true, budget)?.0)
}
pub(crate) type Fingerprint = BTreeMap<String, [u64; 9]>;
fn identity(metadata: &std::fs::Metadata) -> [u64; 9] {
    [
        metadata.dev(),
        metadata.ino(),
        metadata.mode() as u64,
        metadata.nlink(),
        metadata.len(),
        metadata.mtime() as u64,
        metadata.mtime_nsec() as u64,
        metadata.ctime() as u64,
        metadata.ctime_nsec() as u64,
    ]
}
/// Descriptor-relative identity check, including ctime, links and every directory.
/// No file contents are read. A changed fingerprint requires full digest validation.
pub(crate) fn fingerprint(root: &Path) -> Result<Fingerprint> {
    Ok(read_snapshot(root, false, SnapshotBudget::Plugin)?.1)
}
fn read_snapshot(
    root: &Path,
    read_content: bool,
    budget: SnapshotBudget,
) -> Result<(Files, Fingerprint)> {
    struct SnapshotUsage {
        bytes: usize,
        entries: usize,
    }
    fn walk(
        dir: &File,
        prefix: &str,
        files: &mut Files,
        usage: &mut SnapshotUsage,
        read_content: bool,
        fingerprint: &mut Fingerprint,
        limits: &SnapshotLimits,
    ) -> Result<()> {
        let before = identity(&dir.metadata()?);
        fingerprint.insert(prefix.into(), before);
        for entry in Dir::read_from(dir)? {
            let entry = entry?;
            let name = entry
                .file_name()
                .to_str()
                .context("non-UTF8 package path")?;
            if name == "." || name == ".." || name == ".git" {
                continue;
            }
            usage.entries += 1;
            ensure!(
                usage.entries <= limits.entries,
                "package exceeds {} filesystem entries",
                limits.entries
            );
            let path = if prefix.is_empty() {
                name.into()
            } else {
                format!("{prefix}/{name}")
            };
            let mut file = File::from(
                openat(
                    dir,
                    name,
                    OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
                    Mode::empty(),
                )
                .with_context(|| format!("unsafe package entry {path}"))?,
            );
            let metadata = file.metadata()?;
            if metadata.is_dir() {
                walk(
                    &file,
                    &path,
                    files,
                    usage,
                    read_content,
                    fingerprint,
                    limits,
                )?;
            } else {
                fingerprint.insert(path.clone(), identity(&metadata));
                ensure!(
                    metadata.is_file() && metadata.nlink() == 1,
                    "package entry must be a regular single-link file: {path}"
                );
                ensure!(
                    files.len() < limits.files,
                    "package exceeds {} files",
                    limits.files
                );
                ensure!(
                    metadata.len() <= limits.bytes as u64,
                    "package file exceeds 64 MiB: {path}"
                );
                let mut data = Vec::new();
                if read_content {
                    file.by_ref()
                        .take((limits.bytes - usage.bytes + 1) as u64)
                        .read_to_end(&mut data)?;
                    usage.bytes += data.len();
                } else {
                    usage.bytes += metadata.len() as usize;
                }
                ensure!(usage.bytes <= limits.bytes, "package exceeds 64 MiB total");
                let after = file.metadata()?;
                ensure!(
                    identity(&after) == identity(&metadata),
                    "package changed during read: {path}"
                );
                files.insert(
                    path,
                    PackageFile {
                        bytes: data,
                        executable: metadata.mode() & 0o111 != 0,
                    },
                );
            }
        }
        ensure!(
            identity(&dir.metadata()?) == before,
            "package directory changed during read"
        );
        Ok(())
    }
    let mut files = Files::new();
    let mut fingerprint = Fingerprint::new();
    walk(
        &directory(root)?,
        "",
        &mut files,
        &mut SnapshotUsage {
            bytes: 0,
            entries: 0,
        },
        read_content,
        &mut fingerprint,
        &budget.limits(),
    )?;
    Ok((files, fingerprint))
}
pub(crate) fn digest(files: &Files) -> String {
    let mut h = Sha256::new();
    for (p, b) in files {
        h.update((p.len() as u64).to_le_bytes());
        h.update(p.as_bytes());
        h.update((b.len() as u64).to_le_bytes());
        h.update([u8::from(b.executable)]);
        h.update(&b.bytes);
    }
    format!("{:x}", h.finalize())
}
pub(crate) fn relative(s: &str) -> Result<String> {
    ensure!(
        !s.is_empty() && !s.contains('\\'),
        "invalid package-relative path: {s}"
    );
    let p = Path::new(s);
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::Normal(n) => out.push(n),
            Component::CurDir => {}
            _ => bail!("package path escape rejected: {s}"),
        }
    }
    ensure!(!out.as_os_str().is_empty(), "empty package-relative path");
    Ok(out.to_str().context("invalid path")?.into())
}
fn json(files: &Files, path: &str) -> Result<Option<Value>> {
    files
        .get(path)
        .map(|v| serde_json::from_slice(&v.bytes).with_context(|| format!("invalid {path}")))
        .transpose()
}
fn text(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or_default().into()
}
fn paths(v: &Value) -> Result<Vec<String>> {
    match v {
        Value::String(s) => Ok(vec![relative(s)?]),
        Value::Array(a) => a
            .iter()
            .map(|v| relative(v.as_str().context("component path must be string")?))
            .collect(),
        _ => bail!("component paths must be string or array"),
    }
}
fn declaration(v: &Value, files: &Files, label: &str, diagnostics: &mut Vec<String>) -> Result<()> {
    match v {
        Value::String(s) => {
            let p = relative(s)?;
            if !files.contains_key(&p) {
                diagnostics.push(format!("{label}: declared optional file missing: {p}"));
            }
        }
        Value::Array(a) => {
            for x in a {
                declaration(x, files, label, diagnostics)?;
            }
        }
        Value::Object(_) => {}
        _ => diagnostics.push(format!("{label}: unsupported optional declaration: {v}")),
    }
    Ok(())
}
fn asset(v: &Value, files: &Files, diagnostics: &mut Vec<String>) -> Result<()> {
    if let Some(s) = v.as_str() {
        let p = relative(s)?;
        if !files.contains_key(&p) {
            diagnostics.push(format!("interface: optional asset missing: {p}"));
        }
    } else {
        diagnostics.push("interface: optional asset must be a relative path".into());
    }
    Ok(())
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub(crate) struct CatalogContext {
    pub entry: Value,
    pub origin: String,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub(crate) struct Definition {
    pub version: u32,
    pub id: String,
    pub package_digest: String,
    pub source: PathBuf,
    pub context: CatalogContext,
    pub resolved_commit: Option<String>,
    pub integrity: Option<String>,
}
impl Definition {
    pub fn digest(&self) -> Result<String> {
        Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(self)?)))
    }
    pub fn validate(&self, id: &str, revision: &str) -> Result<()> {
        ensure!(
            self.version == 1 && self.id == id && self.digest()? == revision,
            "invalid plugin definition receipt: {id}"
        );
        Ok(())
    }
}
pub(crate) struct Selection {
    pub portable: bool,
    pub format: crate::ManifestFormat,
    pub manifest_path: String,
    pub manifest: Value,
    pub overlay_path: String,
    pub overlay: Value,
    pub inline: bool,
    pub contextual: bool,
    pub restricted: bool,
    pub claude_defaults: bool,
    pub field_origins: BTreeMap<String, String>,
}
pub(crate) const CLAUDE_MERGE_FIELDS: &[&str] = &[
    "skills",
    "commands",
    "agents",
    "hooks",
    "outputStyles",
    "themes",
];
const COMPONENT_FIELDS: &[&str] = &[
    "skills",
    "commands",
    "agents",
    "hooks",
    "mcpServers",
    "outputStyles",
    "themes",
    "lspServers",
    "apps",
    "ui",
    "channels",
];
fn append_paths(base: Option<&Value>, extra: &Value) -> Result<Value> {
    let mut combined = base.map(paths).transpose()?.unwrap_or_default();
    combined.extend(paths(extra)?);
    combined.sort();
    combined.dedup();
    Ok(serde_json::to_value(combined)?)
}
fn hook_events(
    value: Option<&Value>,
    files: &Files,
    field: &str,
) -> Result<(serde_json::Map<String, Value>, BTreeMap<String, String>)> {
    let found = crate::components::documents(value, "hooks/hooks.json", files, false, &mut vec![]);
    ensure!(
        found.rejected.is_empty(),
        "invalid catalog hook declaration"
    );
    let mut events = serde_json::Map::new();
    let mut origins = BTreeMap::new();
    for (source, document) in found.documents {
        let mut origin = match source {
            crate::components::DocumentSource::Manifest(indices) => {
                let mut origin = field.to_owned();
                for index in indices {
                    origin.push_str(&format!("/{index}"));
                }
                origin
            }
            crate::components::DocumentSource::Path(path) => format!("{path}#"),
        };
        if document.value.get("hooks").is_some() {
            origin.push_str("/hooks");
        }
        let value = document.value.get("hooks").unwrap_or(&document.value);
        for (event, groups) in value.as_object().context("hook events must be an object")? {
            let escaped = event.replace('~', "~0").replace('/', "~1");
            origins.insert(
                format!("hooks/hooks/{escaped}"),
                format!("{origin}/{escaped}"),
            );
            events.insert(event.clone(), groups.clone());
        }
    }
    Ok((events, origins))
}
fn select(files: &Files, context: Option<&CatalogContext>) -> Result<Selection> {
    let root = json(files, "plugin.json").unwrap_or(None);
    let portable = root
        .as_ref()
        .and_then(|v| v["$schema"].as_str())
        .is_some_and(|s| s.contains("agent-plugins.org/"));
    if portable {
        ensure!(
            root.as_ref().unwrap()["$schema"]
                == "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
            "unsupported Agent Plugins schema; compatibility fallback prohibited"
        );
    }
    let legacy_path = [
        ".codex-plugin/plugin.json",
        ".claude-plugin/plugin.json",
        ".cursor-plugin/plugin.json",
        ".zcode-plugin/plugin.json",
    ]
    .into_iter()
    .find(|p| files.contains_key(*p));
    let inline = root
        .as_ref()
        .and_then(|r| r.pointer("/extensions/com.openai"))
        .filter(|v| v.is_object());
    let legacy = if portable && inline.is_some() {
        None
    } else {
        legacy_path.map(|p| json(files, p)).transpose()?.flatten()
    };
    let claude_context =
        context.filter(|c| c.origin.starts_with(".claude-plugin/marketplace.json#"));
    let manifestless = !portable && legacy.is_none();
    let manifest = if portable {
        root.as_ref().unwrap().clone()
    } else if let Some(manifest) = legacy.as_ref() {
        manifest.clone()
    } else {
        claude_context
            .context("no supported plugin manifest")?
            .entry
            .clone()
    };
    let manifest_path = if portable {
        "plugin.json".into()
    } else if let Some(path) = legacy_path {
        path.into()
    } else {
        claude_context.unwrap().origin.clone()
    };
    let format = if portable {
        crate::ManifestFormat::Portable1
    } else {
        match legacy_path {
            Some(".codex-plugin/plugin.json") => crate::ManifestFormat::Codex,
            Some(".cursor-plugin/plugin.json") => crate::ManifestFormat::Cursor,
            Some(".zcode-plugin/plugin.json") => crate::ManifestFormat::Zcode,
            _ => crate::ManifestFormat::Claude,
        }
    };
    let mut overlay = if portable {
        inline.or(legacy.as_ref()).cloned().unwrap_or(Value::Null)
    } else {
        manifest.clone()
    };
    let overlay_path = if portable && inline.is_some() {
        "plugin.json#/extensions/com.openai".into()
    } else {
        legacy_path.unwrap_or(&manifest_path).into()
    };
    let claude_defaults = !manifestless && matches!(format, crate::ManifestFormat::Claude);
    let mut contextual = manifestless;
    let mut field_origins = BTreeMap::new();
    if let Some(context) = context {
        let entry = &context.entry;
        let has_components = COMPONENT_FIELDS.iter().any(|key| entry.get(*key).is_some());
        let has_requirements = ["dependencies", "userConfig"]
            .iter()
            .any(|key| entry.get(*key).is_some());
        if let Some(strict) = entry.get("strict") {
            ensure!(strict.is_boolean(), "strict must be boolean");
        }
        contextual |= has_components || has_requirements || entry.get("policy").is_some();
        let merge_fields = if claude_defaults {
            CLAUDE_MERGE_FIELDS
        } else {
            COMPONENT_FIELDS
        };
        if !manifestless && merge_fields.iter().any(|key| entry.get(*key).is_some()) {
            ensure!(
                claude_context.is_some() && matches!(format, crate::ManifestFormat::Claude),
                "catalog component definition conflicts with selected manifest format"
            );
            ensure!(
                entry
                    .get("strict")
                    .map(|v| v.as_bool().context("strict must be boolean"))
                    .transpose()?
                    .unwrap_or(true),
                "strict:false conflicts with manifest and catalog component declarations"
            );
            for key in merge_fields {
                let Some(value) = entry.get(*key) else {
                    continue;
                };
                let merged = match *key {
                    "skills"
                        if overlay.get("skills").is_none()
                            && files.keys().any(|p| p.starts_with("skills/")) =>
                    {
                        append_paths(Some(&Value::String("skills".into())), value)?
                    }
                    "skills" | "commands" | "agents" | "outputStyles" | "themes" => {
                        append_paths(overlay.get(*key), value)?
                    }
                    "hooks" => {
                        let field = format!("{overlay_path}#/hooks");
                        let (mut events, origins) =
                            hook_events(overlay.get("hooks"), files, &field)?;
                        field_origins.extend(origins);
                        let (extra, origins) =
                            hook_events(Some(value), files, &format!("{}/hooks", context.origin))?;
                        events.extend(extra);
                        field_origins.extend(origins);
                        serde_json::json!({"hooks":events})
                    }
                    _ => value.clone(),
                };
                overlay[*key] = merged;
            }
        }
        if contextual && !claude_defaults {
            for key in COMPONENT_FIELDS
                .iter()
                .chain(["dependencies", "userConfig"].iter())
            {
                if let Some(value) = entry.get(*key) {
                    if matches!(*key, "dependencies" | "userConfig") {
                        overlay[*key] = value.clone();
                    }
                    if *key == "mcpServers" || (*key == "hooks" && manifestless) {
                        field_origins.insert((*key).into(), format!("{}/{}", context.origin, key));
                    }
                }
            }
        }
    }
    if (claude_defaults || matches!(format, crate::ManifestFormat::Zcode))
        && let Some(explicit) = overlay.get("skills")
    {
        let mut roots = paths(explicit)?;
        if files.keys().any(|p| p.starts_with("skills/")) {
            roots.push("skills".into());
        }
        roots.sort();
        roots.dedup();
        overlay["skills"] = serde_json::to_value(roots)?;
    }
    let restricted = matches!(
        format,
        crate::ManifestFormat::Claude | crate::ManifestFormat::Zcode
    );
    Ok(Selection {
        portable,
        format,
        manifest_path,
        manifest,
        overlay_path,
        overlay,
        inline: inline.is_some(),
        contextual,
        restricted,
        claude_defaults,
        field_origins,
    })
}
pub(crate) fn bind_definition(detail: &mut PluginDetail, context: CatalogContext) -> Result<()> {
    let definition = Definition {
        version: 1,
        id: detail.id.clone(),
        package_digest: detail.source_digest.clone(),
        source: detail.source.clone(),
        context,
        resolved_commit: detail.resolved_commit.clone(),
        integrity: detail.integrity.clone(),
    };
    let revision = definition.digest()?;
    detail.admission_digest = Some(revision.clone());
    for skill in &mut detail.skills {
        skill.revision = revision.clone();
    }
    if let Some(support) = &mut detail.component_support {
        support.digest = revision;
    }
    detail.definition = Some(definition);
    Ok(())
}
pub(crate) fn parse(files: &Files, id: &str, source: &Path, cache: &Path) -> Result<PluginDetail> {
    Ok(parse_context(files, id, source, cache, None)?.0)
}
pub(crate) fn parse_context(
    files: &Files,
    id: &str,
    source: &Path,
    cache: &Path,
    context: Option<&CatalogContext>,
) -> Result<(PluginDetail, Selection)> {
    let selection = select(files, context)?;
    let portable = selection.portable;
    let manifest = &selection.manifest;
    let overlay = &selection.overlay;
    let mut name = text(manifest, "name");
    if !portable && name.trim().is_empty() {
        name = source
            .file_name()
            .and_then(|n| n.to_str())
            .context("legacy source basename missing")?
            .into();
    }
    ensure!(
        !name.is_empty()
            && name.len() <= 128
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b)),
        "invalid plugin name"
    );
    let mut d = PluginDetail {
        revision: 0,
        id: id.into(),
        name: name.clone(),
        display_name: overlay
            .pointer("/interface/displayName")
            .and_then(Value::as_str)
            .unwrap_or(&name)
            .into(),
        description: text(manifest, "description"),
        version: manifest
            .get("version")
            .and_then(Value::as_str)
            .map(str::to_owned),
        installed: false,
        installed_version: None,
        installed_digest: None,
        installed_source_digest: None,
        admission_digest: None,
        definition: None,
        installed_skills: vec![],
        component_choices: Default::default(),
        installed_metadata: None,
        component_support: None,
        installed_component_support: None,
        installed_onboarding_skill: None,
        enabled: false,
        source: source.into(),
        source_digest: digest(files),
        catalog_source: serde_json::json!({"type":"local","path":source}),
        policy: serde_json::json!({"installation":"AVAILABLE","authentication":"ON_INSTALL"}),
        interface: crate::metadata::interface(overlay.get("interface"), Some(files), cache),
        source_kind: None,
        resolved_commit: None,
        package_version: None,
        integrity: None,
        components: vec![],
        diagnostics: vec![],
        skills: vec![],
        required_tools: vec![],
        onboarding_skill: None,
    };
    if portable && let Some(value) = manifest.pointer("/extensions/org.areal/hostRequirements") {
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct HostRequirements {
            version: u32,
            tools: Vec<String>,
        }
        let requirements: HostRequirements =
            serde_json::from_value(value.clone()).context("invalid org.areal hostRequirements")?;
        ensure!(
            requirements.version == 1,
            "unsupported hostRequirements version"
        );
        ensure!(
            requirements.tools.len() <= 64,
            "too many required host tools"
        );
        let mut seen = std::collections::BTreeSet::new();
        for tool in &requirements.tools {
            ensure!(
                !tool.is_empty()
                    && tool.len() <= 128
                    && tool
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_-.:".contains(&b))
                    && seen.insert(tool.clone()),
                "invalid or duplicate required host tool"
            );
        }
        d.required_tools = requirements.tools;
    }
    if let Some(interface) = overlay.get("interface") {
        if !interface.is_object() {
            d.diagnostics
                .push("interface: optional metadata must be an object".into());
        }
        for key in ["composerIcon", "logo", "logoDark", "iconSmall", "iconLarge"] {
            if let Some(value) = interface.get(key) {
                asset(value, files, &mut d.diagnostics)?;
            }
        }
        if let Some(value) = interface.get("screenshots") {
            if let Some(values) = value.as_array() {
                for value in values {
                    asset(value, files, &mut d.diagnostics)?;
                }
            } else {
                d.diagnostics
                    .push("interface: screenshots must be an array".into());
            }
        }
    }
    let roots = if portable {
        vec!["skills".into()]
    } else {
        overlay
            .get("skills")
            .map(paths)
            .transpose()?
            .unwrap_or_else(|| vec!["skills".into()])
    };
    let onboarding_value = if portable && selection.inline {
        overlay.get("onboardingSkill")
    } else {
        overlay
            .pointer("/extensions/com.openai/onboardingSkill")
            .or_else(|| overlay.get("onboardingSkill"))
    };
    let onboarding = if let Some(value) = onboarding_value {
        if let Some(path) = value.as_str() {
            Some(relative(path)?)
        } else {
            d.diagnostics
                .push("onboardingSkill: optional path must be a string".into());
            None
        }
    } else {
        None
    };
    let revision = digest(files);
    let mut selected = BTreeMap::new();
    for root in roots {
        let direct = if root.ends_with("/SKILL.md") {
            root.clone()
        } else {
            format!("{root}/SKILL.md")
        };
        if files.contains_key(&direct) {
            selected.insert(direct, ());
            continue;
        }
        let prefix = format!("{root}/");
        for p in files.keys() {
            if let Some(rest) = p.strip_prefix(&prefix)
                && rest.ends_with("/SKILL.md")
                && rest.split('/').count() == 2
            {
                selected.insert(p.clone(), ());
            }
        }
        if overlay.get("skills").is_some() && !portable {
            ensure!(
                files.keys().any(|p| p.starts_with(&prefix)),
                "declared skill directory missing: {root}"
            );
        }
    }
    for (path, ()) in selected {
        let skillroot = Path::new(&path).parent().unwrap();
        let stem = skillroot
            .file_name()
            .unwrap()
            .to_str()
            .context("invalid skill name")?;
        let raw = std::str::from_utf8(&files[&path])?;
        let mut meta = Value::Null;
        if let Some(rest) = raw.strip_prefix("---\n") {
            let end = rest
                .find("\n---")
                .or_else(|| rest.find("\n..."))
                .context("unterminated skill frontmatter")?;
            ensure!(end <= 32768, "skill frontmatter exceeds 32 KiB");
            meta = serde_yaml_ng::from_str(&rest[..end])?;
        }
        let mut implicit = true;
        let policy_path = format!("{}/agents/openai.yaml", skillroot.display());
        if let Some(raw) = files.get(&policy_path) {
            let policy: Value =
                serde_yaml_ng::from_slice(raw).context("invalid agents/openai.yaml")?;
            if let Some(v) = policy.pointer("/policy/allow_implicit_invocation") {
                implicit = v
                    .as_bool()
                    .context("allow_implicit_invocation must be boolean")?;
            }
            if let Some(deps) = policy.get("dependencies") {
                d.diagnostics.push(format!(
                    "skill {stem} declared dependencies (not yet resolved): {deps}"
                ));
            }
        }
        let sid = format!(
            "plugin-{:x}-{}",
            Sha256::digest(format!("{id}/{path}").as_bytes()),
            stem.chars()
                .filter(|c| c.is_ascii_alphanumeric() || "-_.".contains(*c))
                .take(40)
                .collect::<String>()
        );
        // Admission matches Engine Skill::load before anything enters durable
        // history; a bad record must never poison startup rehydration.
        let name = meta.get("name").and_then(Value::as_str).unwrap_or(stem);
        let description = meta
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or_default();
        ensure!(
            !name.is_empty() && name.len() <= 256 && description.len() <= 4096,
            "invalid skill metadata: {path} (name must be 1..256 bytes; description at most 4096 bytes)"
        );
        let valid_id = |value: &str| {
            !value.is_empty()
                && value.len() <= 128
                && value
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.' | b':'))
        };
        ensure!(
            valid_id(&sid) && valid_id(&revision),
            "invalid generated skill identity: {path}"
        );
        let onboarding_match = onboarding
            .as_ref()
            .is_some_and(|p| p == &path || Path::new(p) == skillroot);
        if onboarding_match {
            d.onboarding_skill = Some(sid.clone());
        }
        d.skills.push(InstalledSkill {
            id: sid,
            revision: revision.clone(),
            root: cache.join(skillroot),
            package_root: cache.into(),
            plugin_id: id.into(),
            name: name.into(),
            description: description.into(),
            allow_implicit_invocation: implicit,
            onboarding: onboarding_match,
            required_tools: d.required_tools.clone(),
        });
    }
    if onboarding.is_some() && d.onboarding_skill.is_none() {
        d.diagnostics
            .push("onboardingSkill: optional path does not identify a declared skill".into());
    }
    if !d.skills.is_empty() {
        d.components.push("skills".into());
    }
    let mcp = if portable {
        files.contains_key("mcp.json")
    } else {
        overlay.get("mcpServers").is_some() || files.contains_key(".mcp.json")
    };
    if !portable && let Some(v) = overlay.get("mcpServers") {
        declaration(v, files, "mcp", &mut d.diagnostics)?;
    }
    if mcp {
        d.components.push("mcp".into());
        d.diagnostics
            .push("MCP declarations require explicit digest trust and connection".into());
    }
    if overlay.get("hooks").is_some() || files.contains_key("hooks/hooks.json") {
        crate::hooks::discover(overlay.get("hooks"), files, portable, &mut d.diagnostics);
        d.components.push("hooks".into());
        d.diagnostics.push("hooks: declarations do not execute during discovery; explicit hook definition trust is required".into());
    }
    {
        let (key, default, label) = ("apps", ".app.json", "apps");
        let present = if let Some(v) = overlay.get(key) {
            declaration(v, files, label, &mut d.diagnostics)?;
            true
        } else {
            files.contains_key(default)
        };
        if present {
            d.components.push(label.into());
            d.diagnostics
                .push("Connector IDs require explicit mapping and account authentication".into());
        }
    }
    if let Some(commands) = overlay.get("commands") {
        for path in match commands {
            Value::String(path) => vec![path.as_str()],
            Value::Array(values) => values.iter().filter_map(Value::as_str).collect(),
            _ => vec![],
        } {
            relative(path)?;
        }
        d.diagnostics
            .push("explicit legacy commands declaration: migration not yet supported".into());
    } else if files.keys().any(|p| p.starts_with("commands/")) {
        d.diagnostics
            .push("legacy commands migration not yet supported".into());
    }
    d.component_support = Some(crate::support::parse(
        files,
        crate::support::ManifestSelection {
            portable,
            format: selection.format,
            manifest_path: &selection.manifest_path,
            manifest,
            overlay_path: selection.overlay_path.clone(),
            overlay,
            restricted: selection.restricted,
            claude_defaults: selection.claude_defaults,
            field_origins: &selection.field_origins,
            catalog: context,
        },
        &d.skills,
    )?);
    if let Some(support) = &d.component_support {
        d.diagnostics
            .extend(support.compatibility.reason_codes.iter().cloned());
        if selection.restricted {
            for component in &support.components {
                if component.status == crate::SupportStatus::Unsupported {
                    d.diagnostics.push(format!(
                        "{:?}: {}",
                        component.kind,
                        component.reason_codes.join(", ")
                    ));
                }
            }
        }
    }
    if selection.contextual {
        bind_definition(
            &mut d,
            context.context("catalog definition missing")?.clone(),
        )?;
    }
    Ok((d, selection))
}
