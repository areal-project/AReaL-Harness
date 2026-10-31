use crate::{InstalledSkill, package};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum ComponentKind {
    Skills,
    Mcp,
    Hooks,
    Apps,
    Commands,
    Agents,
    UiSurfaces,
    OutputStyles,
    Themes,
    Lsp,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SupportStatus {
    Supported,
    Partial,
    Unsupported,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ManifestFormat {
    Portable1,
    Codex,
    Claude,
    Cursor,
    Zcode,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ComponentSupport {
    pub kind: ComponentKind,
    pub source_field: String,
    pub status: SupportStatus,
    pub reason_codes: Vec<String>,
    pub supported_schema: Option<String>,
    pub required: bool,
    pub activation_requirements: Vec<String>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum CompatibilityState {
    Allowed,
    Blocked,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ComponentCompatibility {
    pub state: CompatibilityState,
    pub reason_codes: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SupportValidation {
    pub scope: String,
    pub provider: String,
    pub platform: String,
    pub distribution: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PackageComponentSupport {
    pub digest: String,
    pub manifest_format: ManifestFormat,
    pub components: Vec<ComponentSupport>,
    pub compatibility: ComponentCompatibility,
    pub validation: SupportValidation,
}
impl PackageComponentSupport {
    pub(crate) fn allowed(&self) -> bool {
        self.compatibility.state == CompatibilityState::Allowed
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ComponentRequirements {
    version: u32,
    required_kinds: Vec<ComponentKind>,
}
pub(crate) struct ManifestSelection<'a> {
    pub portable: bool,
    pub format: ManifestFormat,
    pub manifest_path: &'a str,
    pub manifest: &'a Value,
    pub overlay_path: String,
    pub overlay: &'a Value,
    pub restricted: bool,
    pub claude_defaults: bool,
    pub field_origins: &'a std::collections::BTreeMap<String, String>,
    pub catalog: Option<&'a package::CatalogContext>,
}
fn field(path: &str, key: &str) -> String {
    if path.contains('#') {
        format!("{path}/{key}")
    } else {
        format!("{path}#/{key}")
    }
}
fn reserve(rows: &[ComponentSupport], count: usize) -> Result<()> {
    ensure!(
        rows.len().saturating_add(count) <= 4096,
        "package exceeds 4096 component declarations"
    );
    Ok(())
}
fn pointer(base: &str, key: &str) -> Result<String> {
    ensure!(
        key.len() <= 256,
        "component declaration identity exceeds 256 bytes"
    );
    Ok(format!(
        "{base}/{}",
        key.replace('~', "~0").replace('/', "~1")
    ))
}
fn row(kind: ComponentKind, source_field: String, supported: bool) -> ComponentSupport {
    let (schema, requirements): (Option<&str>, &[&str]) = match kind {
        ComponentKind::Skills => (
            Some("areal-skill-metadata-v1"),
            &["installed", "enabled", "profileAllowsPluginSkills"],
        ),
        ComponentKind::Mcp => (
            Some("areal-mcp-document-envelope-v1"),
            &[
                "installed",
                "enabled",
                "profileAllowsPluginSkills",
                "explicitMcpTrust",
                "mcpConnection",
                "authenticationWhenDeclared",
            ],
        ),
        ComponentKind::Hooks => (
            Some("codex-0.162.1-hook-handler-envelope"),
            &[
                "installed",
                "enabled",
                "profileAllowsPluginSkills",
                "explicitHookDefinitionTrust",
                "readOnlyHookConsentWhenApplicable",
            ],
        ),
        ComponentKind::Apps => (
            Some("areal-connector-declaration-envelope-v1"),
            &[
                "installed",
                "enabled",
                "connectorMapping",
                "authentication",
                "mcpConnection",
            ],
        ),
        ComponentKind::Commands => (
            Some("areal-markdown-command-v1"),
            &["installed", "enabled", "normalTurnAdmission"],
        ),
        ComponentKind::Agents => (
            Some("areal-agent-profile-template-v1"),
            &["installed", "enabled", "profileAdmission"],
        ),
        _ => (None, &[]),
    };
    ComponentSupport {
        kind,
        source_field,
        status: if supported {
            SupportStatus::Supported
        } else {
            SupportStatus::Unsupported
        },
        reason_codes: if supported {
            vec![]
        } else {
            vec!["componentNotImplemented".into()]
        },
        supported_schema: if supported {
            schema.map(str::to_owned)
        } else {
            None
        },
        required: false,
        activation_requirements: requirements.iter().map(|s| (*s).into()).collect(),
    }
}
fn partial(kind: ComponentKind, field: String, reason: &str) -> ComponentSupport {
    let mut result = row(kind, field, true);
    result.status = SupportStatus::Partial;
    result.reason_codes = vec![reason.into()];
    result.supported_schema = None;
    result
}
fn unsupported(
    value: &Value,
    kind: ComponentKind,
    field: &str,
    rows: &mut Vec<ComponentSupport>,
) -> Result<()> {
    reserve(
        rows,
        match value {
            Value::Array(values) => values.len().max(1),
            Value::Object(values) => values.len().max(1),
            _ => 1,
        },
    )?;
    match value {
        Value::Array(values) => {
            for (index, value) in values.iter().enumerate() {
                if let Some(path) = value.as_str() {
                    package::relative(path)?;
                }
                rows.push(row(kind, pointer(field, &index.to_string())?, false));
            }
            if values.is_empty() {
                rows.push(row(kind, field.into(), false));
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                if let Some(path) = value.as_str() {
                    package::relative(path)?;
                }
                rows.push(row(kind, pointer(field, key)?, false));
            }
            if values.is_empty() {
                rows.push(row(kind, field.into(), false));
            }
        }
        _ => {
            if let Some(path) = value.as_str() {
                package::relative(path)?;
            }
            rows.push(row(kind, field.into(), false));
        }
    }
    Ok(())
}
fn mcp(
    declaration: &areal_mcp::PluginDeclaration,
    field: &str,
    rows: &mut Vec<ComponentSupport>,
) -> Result<()> {
    use areal_mcp::PluginEnvelopeEntry;
    let entries = declaration.envelope();
    reserve(rows, entries.len())?;
    for entry in entries {
        let nested = match entry {
            PluginEnvelopeEntry::Server { nested, .. }
            | PluginEnvelopeEntry::Empty { nested }
            | PluginEnvelopeEntry::Invalid { nested } => nested,
        };
        let field = if nested {
            pointer(field, "mcpServers")?
        } else {
            field.into()
        };
        rows.push(match entry {
            PluginEnvelopeEntry::Server { name, object, .. } => {
                let source = pointer(&field, name)?;
                if object {
                    row(ComponentKind::Mcp, source, true)
                } else {
                    partial(ComponentKind::Mcp, source, "invalidMcpEnvelope")
                }
            }
            PluginEnvelopeEntry::Empty { .. } => {
                partial(ComponentKind::Mcp, field, "emptyMcpEnvelope")
            }
            PluginEnvelopeEntry::Invalid { .. } => {
                partial(ComponentKind::Mcp, field, "invalidMcpEnvelope")
            }
        });
    }
    Ok(())
}
fn document_field(source: crate::components::DocumentSource, manifest_field: &str) -> String {
    match source {
        crate::components::DocumentSource::Manifest(indices) => {
            let mut field = manifest_field.to_owned();
            for index in indices {
                field.push_str(&format!("/{index}"));
            }
            field
        }
        crate::components::DocumentSource::Path(path) => format!("{path}#"),
    }
}
fn hooks(
    declaration: Option<&Value>,
    field: &str,
    files: &package::Files,
    portable: bool,
    rows: &mut Vec<ComponentSupport>,
) -> Result<()> {
    let discovered = crate::hooks::discover(declaration, files, portable, &mut vec![]);
    reserve(rows, discovered.rejected.len())?;
    for origin in discovered.rejected {
        rows.push(partial(
            ComponentKind::Hooks,
            document_field(origin, field),
            "invalidHookDeclaration",
        ));
    }
    for (source, document) in discovered.documents {
        let base = document_field(source, field);
        for (path, supported) in crate::hooks::support(&document.value) {
            reserve(rows, 1)?;
            let mut field = base.clone();
            for key in path {
                field = pointer(&field, &key)?;
            }
            rows.push(if supported {
                row(ComponentKind::Hooks, field, true)
            } else {
                partial(ComponentKind::Hooks, field, "unsupportedHookEnvelope")
            });
        }
    }
    Ok(())
}
fn apps(
    declaration: Option<&Value>,
    field: &str,
    files: &package::Files,
    portable: bool,
    rows: &mut Vec<ComponentSupport>,
) -> Result<()> {
    let selected =
        crate::components::documents(declaration, ".app.json", files, portable, &mut vec![]);
    reserve(rows, selected.rejected.len())?;
    for origin in selected.rejected {
        rows.push(partial(
            ComponentKind::Apps,
            document_field(origin, field),
            "invalidConnectorDeclaration",
        ));
    }
    for (source, document) in selected.documents {
        let mut base = document_field(source, field);
        if document.value.get("apps").is_some() {
            base = pointer(&base, "apps")?;
        }
        for declaration in crate::app_declarations(&document.value) {
            reserve(rows, 1)?;
            let field = match declaration.key {
                Some(key) => pointer(&base, &key)?,
                None => base.clone(),
            };
            rows.push(if declaration.summary.is_some() {
                row(ComponentKind::Apps, field, true)
            } else {
                partial(ComponentKind::Apps, field, "invalidConnectorEnvelope")
            });
        }
    }
    Ok(())
}
fn document(
    value: &Value,
    kind: ComponentKind,
    field: &str,
    files: &package::Files,
    portable: bool,
    rows: &mut Vec<ComponentSupport>,
) -> Result<()> {
    match value {
        Value::Array(values) => {
            for (index, value) in values.iter().enumerate() {
                document(
                    value,
                    kind,
                    &pointer(field, &index.to_string())?,
                    files,
                    portable,
                    rows,
                )?;
            }
            if values.is_empty() {
                rows.push(partial(kind, field.into(), "emptyComponentDeclaration"));
            }
        }
        Value::String(path) => {
            let path = package::relative(path)?;
            match files
                .get(&path)
                .and_then(|file| serde_json::from_slice::<Value>(&file.bytes).ok())
            {
                Some(value) => mcp(
                    &areal_mcp::PluginDeclaration::parse(portable, value),
                    &format!("{path}#"),
                    rows,
                )?,
                None => rows.push(partial(
                    kind,
                    field.into(),
                    "componentDocumentMissingOrInvalid",
                )),
            }
        }
        value => mcp(
            &areal_mcp::PluginDeclaration::parse(portable, value.clone()),
            field,
            rows,
        )?,
    }
    Ok(())
}
pub(crate) fn parse(
    files: &package::Files,
    selection: ManifestSelection<'_>,
    skills: &[InstalledSkill],
) -> Result<PackageComponentSupport> {
    let mut components = Vec::new();
    for skill in skills {
        let path = skill
            .root
            .strip_prefix(&skill.package_root)?
            .join("SKILL.md");
        components.push(row(
            ComponentKind::Skills,
            path.to_string_lossy().into(),
            true,
        ));
    }
    let overlay = selection.overlay;
    let mcp_documents = crate::components::mcp_documents(
        overlay.get("mcpServers"),
        files,
        selection.portable,
        selection.claude_defaults,
        &mut vec![],
    );
    if selection.claude_defaults {
        let manifest_field = field(&selection.overlay_path, "mcpServers");
        for origin in &mcp_documents.rejected {
            components.push(partial(
                ComponentKind::Mcp,
                document_field(origin.clone(), &manifest_field),
                "componentDocumentMissingOrInvalid",
            ));
        }
        for (origin, document) in &mcp_documents.documents {
            mcp(
                &document.declaration,
                &document_field(origin.clone(), &manifest_field),
                &mut components,
            )?;
        }
    } else if selection.portable {
        if files.contains_key("mcp.json") {
            document(
                &Value::String("mcp.json".into()),
                ComponentKind::Mcp,
                "mcp.json",
                files,
                selection.portable,
                &mut components,
            )?;
        }
    } else if let Some(value) = overlay.get("mcpServers") {
        document(
            value,
            ComponentKind::Mcp,
            &field(&selection.overlay_path, "mcpServers"),
            files,
            selection.portable,
            &mut components,
        )?;
    } else if files.contains_key(".mcp.json") {
        document(
            &Value::String(".mcp.json".into()),
            ComponentKind::Mcp,
            ".mcp.json",
            files,
            selection.portable,
            &mut components,
        )?;
    }
    hooks(
        overlay.get("hooks"),
        &field(&selection.overlay_path, "hooks"),
        files,
        selection.portable,
        &mut components,
    )?;
    apps(
        overlay.get("apps"),
        &field(&selection.overlay_path, "apps"),
        files,
        selection.portable,
        &mut components,
    )?;
    for key in ["commands", "agents"] {
        if let Some(value) = overlay.get(key) {
            let values = match value {
                Value::Array(values) => values.iter().collect::<Vec<_>>(),
                Value::Object(values) => values.values().collect(),
                _ => vec![value],
            };
            for value in values {
                if let Some(path) = value.as_str() {
                    package::relative(path)?;
                }
            }
        }
    }
    let templates = crate::templates::discover(
        files,
        overlay,
        selection.claude_defaults,
        "support",
        "support",
    );
    let mut declarations = vec![(selection.manifest, selection.manifest_path)];
    if selection.portable {
        declarations.push((overlay, selection.overlay_path.as_str()));
    } else if let Some(catalog) = selection.catalog
        && catalog.origin != selection.manifest_path
    {
        declarations.push((&catalog.entry, catalog.origin.as_str()));
    }
    for (kind, path, reason) in templates.reports {
        reserve(&components, 1)?;
        let mut origin = path.clone();
        let key = if kind == ComponentKind::Commands {
            "commands"
        } else {
            "agents"
        };
        for (manifest, declaration_path) in &declarations {
            if let Some(value) = manifest.get(key) {
                let field = field(declaration_path, key);
                let entries: Vec<(String, &Value)> = match value {
                    Value::Array(values) => values
                        .iter()
                        .enumerate()
                        .map(|(index, value)| (format!("{field}/{index}"), value))
                        .collect(),
                    Value::Object(values) => values
                        .iter()
                        .map(|(key, value)| (format!("{field}/{key}"), value))
                        .collect(),
                    _ => vec![(field, value)],
                };
                for (field, value) in entries {
                    if value
                        .as_str()
                        .and_then(|value| package::relative(value).ok())
                        .as_deref()
                        == Some(path.as_str())
                        || path
                            .strip_prefix(&format!("{key}#/"))
                            .is_some_and(|suffix| field.ends_with(&format!("/{suffix}")))
                    {
                        origin = field;
                    }
                }
            }
        }
        let mut report = row(kind, origin, reason.is_none());
        if let Some(reason) = reason {
            report.reason_codes = vec![reason.into()];
        }
        components.push(report);
    }
    for (kind, key) in [
        (ComponentKind::OutputStyles, "outputStyles"),
        (ComponentKind::Themes, "themes"),
        (ComponentKind::Lsp, "lspServers"),
    ] {
        let mut declared = false;
        for (manifest, path) in &declarations {
            if selection.claude_defaults
                && *path != selection.manifest_path
                && !package::CLAUDE_MERGE_FIELDS.contains(&key)
            {
                continue;
            }
            if let Some(value) = manifest.get(key) {
                unsupported(value, kind, &field(path, key), &mut components)?;
                declared = true;
            }
        }
        if !declared {
            for path in files
                .keys()
                .filter(|path| path.starts_with(&format!("{key}/")))
            {
                reserve(&components, 1)?;
                ensure!(
                    path.len() <= 1024,
                    "component declaration path exceeds 1024 bytes"
                );
                components.push(row(kind, path.clone(), false));
            }
        }
    }
    for (manifest, path) in declarations {
        if selection.claude_defaults && path != selection.manifest_path {
            continue;
        }
        if let Some(value) = manifest.pointer("/ui/surfaces") {
            unsupported(
                value,
                ComponentKind::UiSurfaces,
                &format!("{}/surfaces", field(path, "ui")),
                &mut components,
            )?;
        }
    }
    ensure!(
        components.len() <= 4096,
        "package exceeds 4096 component declarations"
    );
    ensure!(
        components.iter().all(|row| row.source_field.len() <= 1024),
        "component declaration path exceeds 1024 bytes"
    );
    let required = if selection.portable {
        selection
            .manifest
            .pointer("/extensions/org.areal/componentRequirements")
            .map(|value| -> Result<Vec<ComponentKind>> {
                let requirements: ComponentRequirements = serde_json::from_value(value.clone())
                    .context("invalid org.areal componentRequirements")?;
                ensure!(
                    requirements.version == 1,
                    "unsupported componentRequirements version"
                );
                ensure!(
                    requirements.required_kinds.len() <= 10,
                    "too many required component kinds"
                );
                let mut kinds = BTreeSet::new();
                for kind in &requirements.required_kinds {
                    ensure!(kinds.insert(*kind), "duplicate required component kind");
                }
                Ok(requirements.required_kinds)
            })
            .transpose()?
            .unwrap_or_default()
    } else {
        vec![]
    };
    for component in &mut components {
        for (key, origin) in selection.field_origins {
            let original = field(&selection.overlay_path, key);
            if component.source_field == original
                || component
                    .source_field
                    .strip_prefix(&original)
                    .is_some_and(|rest| rest.starts_with('/'))
            {
                component.source_field = component.source_field.replacen(&original, origin, 1);
            }
        }
        if selection.restricted
            && matches!(component.kind, ComponentKind::Hooks | ComponentKind::Apps)
        {
            component.status = SupportStatus::Unsupported;
            component.supported_schema = None;
            component.reason_codes = vec!["hostRuntimeUnsupported".into()];
        }
        if selection
            .manifest
            .pointer("/extensions/org.areal/hostRequirements")
            .is_some()
        {
            component
                .activation_requirements
                .push("declaredHostTools".into());
        }
    }
    let mut reasons = Vec::new();
    let nonempty = |v: &Value| {
        !v.is_null()
            && match v {
                Value::Array(v) => !v.is_empty(),
                Value::Object(v) => !v.is_empty(),
                _ => true,
            }
    };
    if [selection.manifest, overlay]
        .iter()
        .any(|v| v.get("dependencies").is_some_and(nonempty))
    {
        reasons.push("packageDependenciesUnsupported".into());
    }
    fn references(value: &Value) -> bool {
        match value {
            Value::String(value) => {
                value.contains("${user_config.") || value.contains("${userConfig.")
            }
            Value::Array(values) => values.iter().any(references),
            Value::Object(values) => values.values().any(references),
            _ => false,
        }
    }
    let mut unsupported_positions = [selection.manifest, overlay].iter().any(|manifest| {
        manifest.as_object().is_some_and(|fields| {
            fields.iter().any(|(key, value)| {
                !matches!(key.as_str(), "userConfig" | "mcpServers" | "extensions")
                    && references(value)
            })
        })
    }) || selection
        .manifest
        .pointer("/extensions/com.openai")
        .is_some_and(|extension| {
            extension.as_object().is_some_and(|fields| {
                fields.iter().any(|(key, value)| {
                    !matches!(key.as_str(), "userConfig" | "mcpServers") && references(value)
                })
            })
        });
    unsupported_positions |=
        crate::hooks::discover(overlay.get("hooks"), files, selection.portable, &mut vec![])
            .documents
            .iter()
            .any(|(_, document)| references(&document.value));
    unsupported_positions |= crate::components::documents(
        overlay.get("apps"),
        ".app.json",
        files,
        selection.portable,
        &mut vec![],
    )
    .documents
    .iter()
    .any(|(_, document)| references(&document.value));
    unsupported_positions |= selection
        .manifest
        .get("extensions")
        .and_then(Value::as_object)
        .is_some_and(|extensions| {
            extensions
                .iter()
                .any(|(key, value)| key != "com.openai" && references(value))
        });
    if unsupported_positions {
        reasons.push("userConfigPositionUnsupported".into());
    }
    let user_schema = crate::configuration::schema(overlay.get("userConfig"));
    let unsupported_config = match &user_schema {
        Err(_) => true,
        Ok(schema) => {
            let fields = schema
                .iter()
                .map(|(key, field)| (key.clone(), field.sensitive))
                .collect();
            mcp_documents
                .documents
                .iter()
                .any(|(_, document)| document.declaration.validate_user_config(&fields).is_err())
        }
    };
    if unsupported_config
        || (selection.manifest.get("userConfig").is_some() && overlay.get("userConfig").is_none())
    {
        reasons.push("userConfigUnsupported".into());
    }
    if !reasons.is_empty() {
        for component in &mut components {
            component.status = SupportStatus::Unsupported;
            component.reason_codes.extend(reasons.clone());
            component.activation_requirements.extend(reasons.clone());
        }
    }

    for kind in required {
        let mut found = false;
        let mut supported = true;
        for component in components.iter_mut().filter(|row| row.kind == kind) {
            component.required = true;
            found = true;
            supported &= component.status == SupportStatus::Supported;
        }
        if !found {
            reasons.push(format!(
                "requiredKindMissing:{}",
                serde_json::to_value(kind)?.as_str().unwrap()
            ));
        } else if !supported {
            reasons.push(format!(
                "requiredKindUnsupported:{}",
                serde_json::to_value(kind)?.as_str().unwrap()
            ));
        }
    }
    Ok(PackageComponentSupport {
        digest: package::digest(files),
        manifest_format: selection.format,
        components,
        compatibility: ComponentCompatibility {
            state: if reasons.is_empty() {
                CompatibilityState::Allowed
            } else {
                CompatibilityState::Blocked
            },
            reason_codes: reasons,
        },
        validation: SupportValidation {
            scope: "staticParserContract".into(),
            provider: "unverified".into(),
            platform: "unverified".into(),
            distribution: "unverified".into(),
        },
    })
}
