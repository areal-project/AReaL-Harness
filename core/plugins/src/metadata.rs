//! 管理 API 仅投影公开字段；组件文档和扩展对象不会穿过此白名单。
use crate::{package, remote};
use anyhow::{Context, Result, ensure};
use serde_json::{Map, Value, json};
use std::path::Path;

pub(crate) fn policy(entry: &Value) -> Result<Value> {
    let policy = &entry["policy"];
    ensure!(
        policy.is_null() || policy.is_object(),
        "invalid plugin policy"
    );
    let installation = policy["installation"].as_str().unwrap_or("AVAILABLE");
    let authentication = policy["authentication"].as_str().unwrap_or("ON_INSTALL");
    ensure!(
        matches!(
            installation,
            "AVAILABLE" | "INSTALLED_BY_DEFAULT" | "NOT_AVAILABLE"
        ),
        "invalid installation policy"
    );
    ensure!(
        matches!(authentication, "ON_INSTALL" | "ON_USE"),
        "invalid authentication policy"
    );
    Ok(json!({"installation":installation,"authentication":authentication}))
}
fn optional_text(value: &Value, key: &str) -> Result<Option<String>> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => {
            let text = text.trim();
            ensure!(!text.is_empty(), "empty source selector");
            Ok(Some(text.into()))
        }
        _ => anyhow::bail!("invalid source selector type"),
    }
}
pub(crate) fn source(
    entry: &Value,
    marketplace_root: &Path,
    local_root: Option<&Path>,
) -> Result<Value> {
    if let Some(path) = local_root {
        return Ok(json!({"type":"local","path":path}));
    }
    let source = &entry["source"];
    if source["source"].as_str().or(source["type"].as_str()) == Some("npm") {
        let package = source["package"]
            .as_str()
            .context("npm package missing")?
            .trim();
        let parts: Vec<_> = package.trim_start_matches('@').split('/').collect();
        ensure!(
            (package.starts_with('@') && parts.len() == 2
                || !package.starts_with('@') && parts.len() == 1)
                && parts.iter().all(|s| !s.is_empty()
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))),
            "invalid npm package name"
        );
        let registry = optional_text(source, "registry")?;
        if let Some(registry) = &registry {
            let url = reqwest::Url::parse(registry).context("invalid registry URL")?;
            ensure!(
                matches!(url.scheme(), "http" | "https")
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.query().is_none()
                    && url.fragment().is_none(),
                "invalid registry URL"
            );
        }
        return Ok(
            json!({"type":"npm","package":package,"version":optional_text(source,"version")?,"registry":registry}),
        );
    }
    let kind = source["source"].as_str().or(source["type"].as_str());
    if matches!(kind, Some("archive" | "command" | "pip")) {
        return Ok(json!({"type":kind.unwrap(),"unsupported":true}));
    }
    let github_url;
    let raw_url = if kind == Some("github") {
        let repo = source["repo"]
            .as_str()
            .context("GitHub repository missing")?;
        let parts: Vec<_> = repo.split('/').collect();
        ensure!(
            parts.len() == 2
                && parts.iter().all(|p| !p.is_empty()
                    && *p != "."
                    && *p != ".."
                    && p.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))),
            "invalid GitHub repository"
        );
        github_url = format!("https://github.com/{repo}.git");
        github_url.as_str()
    } else {
        source["url"].as_str().context("Git URL missing")?
    };
    let url = remote::normalize_git_url(raw_url, marketplace_root)?;
    let path = optional_text(source, "path")?
        .map(|path| package::relative(&path))
        .transpose()?;
    let reference = optional_text(source, "ref")?;
    if let Some(reference) = &reference {
        ensure!(
            !reference.starts_with('-')
                && !reference.contains(':')
                && !reference.chars().any(char::is_whitespace),
            "invalid Git ref"
        );
    }
    let sha = optional_text(source, "sha")?;
    if let Some(sha) = &sha {
        ensure!(
            sha.len() == 40 && sha.bytes().all(|b| b.is_ascii_hexdigit()),
            "invalid Git commit selector"
        );
    }
    Ok(json!({"type":"git","url":url,"path":path,"refName":reference,"sha":sha}))
}
fn public_url(value: &Value) -> Option<Value> {
    let text = value.as_str()?;
    let url = reqwest::Url::parse(text).ok()?;
    (matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none())
    .then(|| Value::String(text.into()))
}
pub(crate) fn interface(
    value: Option<&Value>,
    files: Option<&package::Files>,
    root: &Path,
) -> Option<Value> {
    let value = value?.as_object()?;
    let mut result = Map::new();
    for key in [
        "displayName",
        "shortDescription",
        "longDescription",
        "developerName",
        "category",
        "brandColor",
    ] {
        if let Some(text) = value.get(key).and_then(Value::as_str) {
            result.insert(key.into(), Value::String(text.into()));
        }
    }
    if let Some(values) = value.get("capabilities").and_then(Value::as_array) {
        result.insert(
            "capabilities".into(),
            Value::Array(
                values
                    .iter()
                    .filter_map(|v| v.as_str().map(|s| Value::String(s.into())))
                    .collect(),
            ),
        );
    }
    for (key, alias) in [
        ("websiteUrl", "websiteURL"),
        ("privacyPolicyUrl", "privacyPolicyURL"),
        ("termsOfServiceUrl", "termsOfServiceURL"),
        ("composerIconUrl", "composerIconUrl"),
        ("logoUrl", "logoUrl"),
        ("logoDarkUrl", "logoDarkUrl"),
    ] {
        if let Some(url) = value
            .get(key)
            .or_else(|| value.get(alias))
            .and_then(public_url)
        {
            result.insert(key.into(), url);
        }
    }
    if let Some(prompt) = value.get("defaultPrompt") {
        let values = match prompt {
            Value::String(_) => vec![prompt],
            Value::Array(values) => values.iter().collect(),
            _ => vec![],
        };
        let prompts: Vec<_> = values
            .into_iter()
            .filter_map(Value::as_str)
            .map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "))
            .filter(|s| !s.is_empty() && s.chars().count() <= 128)
            .take(3)
            .map(Value::String)
            .collect();
        if !prompts.is_empty() {
            result.insert("defaultPrompt".into(), Value::Array(prompts));
        }
    }
    let asset = |value: &Value| -> Option<Value> {
        let path = package::relative(value.as_str()?).ok()?;
        files?
            .contains_key(&path)
            .then(|| Value::String(root.join(path).to_string_lossy().into_owned()))
    };
    for key in ["composerIcon", "logo", "logoDark"] {
        if let Some(path) = value.get(key).and_then(asset) {
            result.insert(key.into(), path);
        }
    }
    if let Some(values) = value.get("screenshots").and_then(Value::as_array) {
        result.insert(
            "screenshots".into(),
            Value::Array(values.iter().filter_map(asset).collect()),
        );
    }
    if let Some(values) = value.get("screenshotUrls").and_then(Value::as_array) {
        result.insert(
            "screenshotUrls".into(),
            Value::Array(values.iter().filter_map(public_url).collect()),
        );
    }
    (!result.is_empty()).then_some(Value::Object(result))
}

pub(crate) fn catalog_interface(mut interface: Option<Value>, entry: &Value) -> Option<Value> {
    if let Some(category) = entry.get("category").and_then(Value::as_str) {
        interface.get_or_insert_with(|| Value::Object(Map::new()))["category"] =
            Value::String(category.into());
    }
    interface
}
