use crate::{Store, package};
use anyhow::{Context, Result, ensure};
use serde_json::Value;
use std::path::PathBuf;

/// 内部输入可以含凭据，禁止作为管理 API 的 JSON 投影。
#[derive(Clone, Debug)]
pub struct ComponentDocument {
    pub portable: bool,
    pub origin: String,
    pub value: Value,
}
#[derive(Clone, Debug)]
pub struct McpComponentDocument {
    pub origin: String,
    pub declaration: areal_mcp::PluginDeclaration,
}
#[derive(Clone, Debug)]
pub struct InstalledComponents {
    pub id: String,
    pub root: PathBuf,
    pub data_root: PathBuf,
    pub digest: String,
    pub user_config_schema: std::collections::BTreeMap<String, crate::UserConfigField>,
    pub user_configuration: crate::PluginUserConfiguration,
    pub commands: Vec<crate::InstalledCommand>,
    pub agents: Vec<crate::InstalledAgent>,
    pub mcp_documents: Vec<McpComponentDocument>,
    pub hook_documents: Vec<ComponentDocument>,
    pub app_documents: Vec<ComponentDocument>,
    pub policy: Value,
    pub diagnostics: Vec<String>,
    pub support: crate::PackageComponentSupport,
    pub disabled_mcp_servers: std::collections::BTreeSet<String>,
}
/// One atomic state-file read for publishing an activation directory. Package
/// bytes remain immutable; concurrent commits cannot mix selection revisions.
pub struct InstalledSnapshot {
    pub retained_skills: Vec<crate::InstalledSkill>,
    pub enabled_skills: Vec<crate::InstalledSkill>,
    pub eligible_skill_refs: std::collections::BTreeSet<(String, String)>,
    pub enabled_ids: std::collections::BTreeSet<String>,
    pub components: Vec<InstalledComponents>,
}
impl Store {
    pub fn installed_snapshot(&self) -> Result<InstalledSnapshot> {
        let state = self.state()?;
        let mut enabled_ids = std::collections::BTreeSet::new();
        for id in state.installed.keys() {
            if self.effective(&state, id)? {
                enabled_ids.insert(id.clone());
            }
        }
        let mut eligible_skill_refs = std::collections::BTreeSet::new();
        for skill in &state.history {
            if self.skill_allowed(&state, skill)? {
                eligible_skill_refs.insert((skill.id.clone(), skill.revision.clone()));
            }
        }
        let mut enabled_skills = Vec::new();
        for detail in state.installed.values() {
            for skill in &detail.skills {
                if self.skill_allowed(&state, skill)? {
                    enabled_skills.push(skill.clone());
                }
            }
        }
        let components = state
            .installed
            .values()
            .map(|detail| self.installed_component(&state, detail))
            .collect::<Result<_>>()?;
        Ok(InstalledSnapshot {
            retained_skills: state.history,
            enabled_skills,
            eligible_skill_refs,
            enabled_ids,
            components,
        })
    }
    pub fn installed_components(&self) -> Result<Vec<InstalledComponents>> {
        self.components(false)
    }
    pub fn enabled_components(&self) -> Result<Vec<InstalledComponents>> {
        self.components(true)
    }
    /// Validate only the selected package. Unrelated packages do not enter a tool's
    /// authorization hot path; metadata changes still force full integrity checks.
    pub fn enabled_component(&self, id: &str) -> Result<InstalledComponents> {
        let state = self.state()?;
        ensure!(
            self.effective(&state, id)?,
            "plugin disabled, uninstalled or statically incompatible"
        );
        let detail = state.installed.get(id).context("plugin not installed")?;
        self.installed_component(&state, detail)
    }
    pub(super) fn installed_component(
        &self,
        state: &crate::State,
        detail: &crate::PluginDetail,
    ) -> Result<InstalledComponents> {
        let mut component = self.read_components(
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
                .unwrap_or(Value::Null),
        )?;
        component.disabled_mcp_servers = self
            .component_choices(state, &detail.id)
            .disabled_mcp_servers;
        if let Some(configuration) = state.user_configuration.get(&detail.id) {
            component.user_configuration.revision = configuration.revision;
            if configuration.installed_digest == detail.review_digest() {
                configuration.validate(&component.user_config_schema)?;
                component.user_configuration = configuration.clone();
            }
        }
        Ok(component)
    }
    fn components(&self, enabled_only: bool) -> Result<Vec<InstalledComponents>> {
        let state = self.state()?;
        let mut result = Vec::new();
        for detail in state.installed.values() {
            if enabled_only && !self.effective(&state, &detail.id)? {
                continue;
            }
            result.push(self.installed_component(&state, detail)?);
        }
        Ok(result)
    }
    pub fn component_preview(&self, id: &str) -> Result<InstalledComponents> {
        let state = self.state()?;
        let (_, details, _) = self.catalogs(&state);
        let detail = details
            .into_iter()
            .find(|d| d.id == id)
            .ok_or_else(|| anyhow::anyhow!("plugin source unavailable"))?;
        ensure!(
            !detail.source_digest.is_empty(),
            "remote component preview requires explicit source resolution"
        );
        let root = state
            .candidates
            .get(id)
            .filter(|c| c.detail.source_digest == detail.source_digest)
            .map(|c| c.root.clone())
            .unwrap_or_else(|| detail.source.clone());
        self.read_components(
            &detail.id,
            detail.review_digest(),
            root,
            detail.definition.as_ref(),
            detail.policy.clone(),
        )
    }
    pub(super) fn read_components(
        &self,
        id: &str,
        digest: &str,
        root: PathBuf,
        definition: Option<&package::Definition>,
        policy: Value,
    ) -> Result<InstalledComponents> {
        let raw_digest = if let Some(definition) = definition {
            definition.validate(id, digest)?;
            &definition.package_digest
        } else {
            ensure!(
                !root.starts_with(self.root.join("cache"))
                    || root.file_name().and_then(|name| name.to_str()) == Some(digest),
                "plugin definition receipt missing"
            );
            digest
        };
        let policy = match definition {
            Some(definition) => crate::metadata::policy(&definition.context.entry)?,
            None => policy,
        };
        let fingerprint = package::fingerprint(&root)?;
        let cache_key = format!("{id}/{digest}");
        if let Some((previous, component)) = self.component_cache.lock().unwrap().get(&cache_key)
            && previous == &fingerprint
            && component.root == root
            && component.digest == digest
            && component.policy == policy
        {
            return Ok(component.clone());
        }
        #[cfg(test)]
        self.component_reads
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let files = package::snapshot(&root)?;
        ensure!(
            package::digest(&files) == raw_digest,
            "installed package integrity mismatch: {}",
            id
        );
        let (mut parsed, selection) =
            package::parse_context(&files, id, &root, &root, definition.map(|d| &d.context))?;
        if let Some(support) = &mut parsed.component_support {
            support.digest = digest.into();
        }
        let portable = selection.portable;
        let overlay = &selection.overlay;
        let mut result = InstalledComponents {
            id: id.to_owned(),
            root,
            data_root: self.root.join("data").join(id),
            digest: digest.to_owned(),
            user_config_schema: crate::configuration::schema(overlay.get("userConfig"))
                .unwrap_or_default(),
            user_configuration: crate::PluginUserConfiguration {
                installed_digest: digest.into(),
                ..Default::default()
            },
            commands: vec![],
            agents: vec![],
            mcp_documents: vec![],
            hook_documents: vec![],
            app_documents: vec![],
            policy,
            diagnostics: vec![],
            disabled_mcp_servers: Default::default(),
            support: parsed
                .component_support
                .context("validated package support report missing")?,
        };
        let templates =
            crate::templates::discover(&files, overlay, selection.claude_defaults, id, digest);
        result.commands = templates.commands;
        result.agents = templates.agents;
        result.mcp_documents = mcp_documents(
            overlay.get("mcpServers"),
            &files,
            portable,
            selection.claude_defaults,
            &mut result.diagnostics,
        )
        .documents
        .into_iter()
        .map(|(_, document)| document)
        .collect();
        result.app_documents = documents(
            overlay.get("apps"),
            ".app.json",
            &files,
            portable,
            &mut result.diagnostics,
        )
        .documents
        .into_iter()
        .map(|(_, document)| document)
        .collect();
        if parsed.components.iter().any(|v| v == "hooks") {
            result.diagnostics.push("hooks: declarations do not execute during discovery; explicit hook definition trust is required".into());
        }
        result.hook_documents = crate::hooks::discover(
            overlay.get("hooks"),
            &files,
            portable,
            &mut result.diagnostics,
        )
        .documents
        .into_iter()
        .map(|(_, document)| document)
        .collect();
        if selection.restricted {
            result.hook_documents.clear();
            result.app_documents.clear();
        }
        if result
            .support
            .compatibility
            .reason_codes
            .iter()
            .any(|reason| {
                matches!(
                    reason.as_str(),
                    "packageDependenciesUnsupported"
                        | "userConfigUnsupported"
                        | "userConfigPositionUnsupported"
                )
            })
        {
            result.commands.clear();
            result.agents.clear();
            result.mcp_documents.clear();
            result.hook_documents.clear();
            result.app_documents.clear();
        }
        ensure!(
            package::fingerprint(&result.root)? == fingerprint,
            "package changed during component validation"
        );
        self.component_cache
            .lock()
            .unwrap()
            .insert(cache_key, (fingerprint, result.clone()));
        Ok(result)
    }
}

#[derive(Clone)]
pub(crate) enum DocumentSource {
    Manifest(Vec<usize>),
    Path(String),
}
#[derive(Default)]
pub(crate) struct DocumentSelection {
    pub documents: Vec<(DocumentSource, ComponentDocument)>,
    pub rejected: Vec<DocumentSource>,
}
pub(crate) fn documents(
    declaration: Option<&Value>,
    default: &str,
    files: &package::Files,
    portable: bool,
    diagnostics: &mut Vec<String>,
) -> DocumentSelection {
    fn one(
        value: &Value,
        indices: &[usize],
        default: &str,
        files: &package::Files,
        portable: bool,
        result: &mut DocumentSelection,
        diagnostics: &mut Vec<String>,
    ) {
        match value {
            Value::Object(_) => result.documents.push((
                DocumentSource::Manifest(indices.to_vec()),
                ComponentDocument {
                    portable,
                    origin: "manifest".into(),
                    value: value.clone(),
                },
            )),
            Value::Array(values) => {
                if values.is_empty() {
                    result
                        .rejected
                        .push(DocumentSource::Manifest(indices.to_vec()));
                }
                for (index, value) in values.iter().enumerate() {
                    let mut indices = indices.to_vec();
                    indices.push(index);
                    one(
                        value,
                        &indices,
                        default,
                        files,
                        portable,
                        result,
                        diagnostics,
                    );
                }
            }
            Value::String(path) => {
                match package::relative(path).and_then(|path| {
                    let bytes = files
                        .get(&path)
                        .ok_or_else(|| anyhow::anyhow!("missing component document"))?;
                    let value: Value = serde_json::from_slice(&bytes.bytes)?;
                    ensure!(
                        value.is_object() || (default == ".app.json" && value.is_array()),
                        "component document must be an object"
                    );
                    Ok(ComponentDocument {
                        portable,
                        origin: path,
                        value,
                    })
                }) {
                    Ok(document) => result
                        .documents
                        .push((DocumentSource::Path(document.origin.clone()), document)),
                    Err(_) => {
                        result.rejected.push(
                            package::relative(path)
                                .map(DocumentSource::Path)
                                .unwrap_or_else(|_| DocumentSource::Manifest(indices.to_vec())),
                        );
                        diagnostics.push(format!(
                            "{default}: invalid or missing component document: {path}"
                        ));
                    }
                }
            }
            _ => {
                result
                    .rejected
                    .push(DocumentSource::Manifest(indices.to_vec()));
                diagnostics.push(format!("{default}: invalid component declaration"));
            }
        }
    }
    let mut result = DocumentSelection::default();
    if let Some(value) = declaration {
        one(
            value,
            &[],
            default,
            files,
            portable,
            &mut result,
            diagnostics,
        );
    } else if files.contains_key(default) {
        one(
            &Value::String(default.into()),
            &[],
            default,
            files,
            portable,
            &mut result,
            diagnostics,
        );
    }
    result
}

pub(crate) struct McpDocumentSelection {
    pub documents: Vec<(DocumentSource, McpComponentDocument)>,
    pub rejected: Vec<DocumentSource>,
}
pub(crate) fn mcp_documents(
    declaration: Option<&Value>,
    files: &package::Files,
    portable: bool,
    claude_defaults: bool,
    diagnostics: &mut Vec<String>,
) -> McpDocumentSelection {
    let default = if portable { "mcp.json" } else { ".mcp.json" };
    let mut selected = documents(
        if portable { None } else { declaration },
        default,
        files,
        portable,
        diagnostics,
    );
    if claude_defaults && declaration.is_some() {
        let mut defaults = documents(None, default, files, false, diagnostics);
        defaults.documents.append(&mut selected.documents);
        defaults.rejected.append(&mut selected.rejected);
        selected = defaults;
    }
    let mut selected = McpDocumentSelection {
        documents: selected
            .documents
            .into_iter()
            .map(|(source, document)| {
                (
                    source,
                    McpComponentDocument {
                        origin: document.origin,
                        declaration: areal_mcp::PluginDeclaration::parse(
                            document.portable,
                            document.value,
                        ),
                    },
                )
            })
            .collect(),
        rejected: selected.rejected,
    };
    if !claude_defaults {
        return selected;
    }
    let mut names = std::collections::BTreeSet::new();
    selected.documents = selected
        .documents
        .into_iter()
        .rev()
        .filter_map(|(source, mut document)| {
            if document
                .declaration
                .retain_servers(|name| names.insert(name.to_owned()))
            {
                return None;
            }
            Some((source, document))
        })
        .collect();
    selected.documents.reverse();
    selected
}

pub struct AppDeclaration {
    pub key: Option<String>,
    pub summary: Option<Value>,
}
pub fn app_declarations(value: &Value) -> Vec<AppDeclaration> {
    let apps = value.get("apps").unwrap_or(value);
    let values = if let Some(array) = apps.as_array() {
        array
            .iter()
            .enumerate()
            .map(|(index, value)| (Some(index.to_string()), value.clone()))
            .collect::<Vec<_>>()
    } else if apps.get("id").is_some() {
        vec![(None, apps.clone())]
    } else if let Some(object) = apps.as_object() {
        object
            .iter()
            .map(|(key, value)| {
                let mut value = value.clone();
                if value.is_object() && value.get("id").is_none() {
                    value["id"] = Value::String(key.clone());
                }
                (Some(key.clone()), value)
            })
            .collect()
    } else {
        vec![(None, apps.clone())]
    };
    if values.is_empty() {
        return vec![AppDeclaration {
            key: None,
            summary: None,
        }];
    }
    values
        .into_iter()
        .map(|(key, value)| {
            let summary = value["id"].as_str().map(|id| {
                let mut summary =
                    serde_json::json!({"id":id,"name":value["name"].as_str().unwrap_or(id)});
                for key in ["description", "installUrl", "category"] {
                    summary[key] = value
                        .get(key)
                        .cloned()
                        .filter(Value::is_string)
                        .unwrap_or(Value::Null);
                }
                summary
            });
            AppDeclaration { key, summary }
        })
        .collect()
}

#[cfg(test)]
mod review_tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt, sync::atomic::Ordering};

    #[test]
    fn unchanged_component_refresh_reuses_content_but_tampering_invalidates() {
        let t = tempfile::tempdir().unwrap();
        fs::create_dir_all(t.path().join(".agents/plugins")).unwrap();
        fs::create_dir_all(t.path().join("pkg/.codex-plugin")).unwrap();
        fs::write(
            t.path().join(".agents/plugins/marketplace.json"),
            r#"{"name":"local","plugins":[{"name":"sample","source":"./pkg"}]}"#,
        )
        .unwrap();
        fs::write(
            t.path().join("pkg/.codex-plugin/plugin.json"),
            r#"{"name":"sample"}"#,
        )
        .unwrap();
        fs::write(t.path().join("pkg/asset"), vec![b'a'; 1024 * 1024]).unwrap();
        let store = Store::open(t.path().join("plugins"), t.path().into(), None).unwrap();
        let d = store.read("sample@local").unwrap();
        store
            .install(&d.id, "user", d.revision, &d.source, &d.source_digest)
            .unwrap();
        for _ in 0..5 {
            assert_eq!(store.enabled_components().unwrap().len(), 1);
        }
        assert_eq!(
            store.component_reads.load(Ordering::Relaxed),
            1,
            "unchanged refresh reread package bytes"
        );
        let path = store
            .root
            .join("cache")
            .join(&d.source_digest)
            .join("asset");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        fs::write(&path, vec![b'b'; 1024 * 1024]).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o444)).unwrap();
        assert!(
            store.enabled_components().is_err(),
            "same-size modified asset reused trusted cache"
        );
    }
}
