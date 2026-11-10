//! 旧配置与任务目录的白名单投影；不读取 Vault 或进程环境，不恢复任务。
use super::*;

fn template(
    name: &str,
    endpoint: &str,
    protocol: &str,
    models: Value,
    parameters: Value,
) -> Option<Value> {
    let url = url::Url::parse(endpoint).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let protocol = match protocol {
        "responses" => "responses",
        "chat-completions" | "chatCompletions" => "chatCompletions",
        _ => return None,
    };
    let base = endpoint.trim_end_matches('/');
    let base = base
        .strip_suffix("/chat/completions")
        .or_else(|| base.strip_suffix("/responses"))
        .unwrap_or(base);
    Some(
        json!({"name":name,"baseUrl":base,"protocol":protocol,"enabled":false,"models":models,"parameters":parameters}),
    )
}
pub(super) fn providers(manifest: &Manifest) -> (Vec<Value>, &'static str) {
    let mut public = Vec::new();
    let mut unavailable = false;
    let path = manifest.source.host_home.join("config.toml");
    if path.exists() {
        let loaded = (|| -> Result<_> {
            let before = fs::symlink_metadata(&path)?;
            ensure!(
                before.is_file()
                    && before.uid() == unsafe { libc::geteuid() }
                    && before.mode() & 0o022 == 0
                    && before.len() <= 1024 * 1024,
                "untrusted source configuration"
            );
            let inputs = areal_config::ConfigInputs {
                cwd: manifest.source.core_home.clone(),
                homedir: None,
                env: [(
                    "AREAL_HARNESS_HOME".into(),
                    manifest.source.host_home.as_os_str().to_owned(),
                )]
                .into(),
                config_file: Some(path.clone()),
                ..Default::default()
            };
            // 空 env 阻止解析任何真实环境凭据，返回后只投影 data 的允许字段。
            let value = areal_config::models::read(&inputs, &[])?;
            let after = fs::symlink_metadata(&path)?;
            ensure!(
                (
                    before.dev(),
                    before.ino(),
                    before.len(),
                    before.mtime(),
                    before.mtime_nsec(),
                    before.ctime(),
                    before.ctime_nsec()
                ) == (
                    after.dev(),
                    after.ino(),
                    after.len(),
                    after.mtime(),
                    after.mtime_nsec(),
                    after.ctime(),
                    after.ctime_nsec()
                ),
                "source configuration changed"
            );
            ensure!(value.data.len() <= 128, "provider catalogue exceeds limit");
            Ok(value.data)
        })();
        match loaded {
            Ok(rows) => {
                for row in rows {
                    let protocol = serde_json::to_value(row.protocol).unwrap_or(Value::Null);
                    let models = serde_json::to_value(&row.models).unwrap_or(json!([]));
                    let candidate = template(
                        &row.name,
                        &row.endpoint,
                        protocol.as_str().unwrap_or(""),
                        models,
                        json!(row.parameters),
                    );
                    let mut value = json!({"id":row.id,"name":row.name,"models":row.models.iter().map(|m|m.id.clone()).collect::<Vec<_>>(),"credentials":"notImported"});
                    if let Some(candidate) = candidate {
                        value["templateDigest"] =
                            json!(storage::digest(&serde_json::to_vec(&candidate).unwrap()));
                        value["template"] = candidate;
                    } else {
                        unavailable = true;
                    }
                    public.push(value);
                }
            }
            Err(_) => unavailable = true,
        }
    }
    let legacy = (|| -> Result<Vec<Value>> {
        let value = metadata(&manifest.source.core_home.join("providers.json"))?
            .unwrap_or(json!({"data":[]}));
        let rows = value
            .as_array()
            .or_else(|| value["data"].as_array())
            .or_else(|| value["providers"].as_array())
            .context("invalid provider catalogue")?;
        ensure!(rows.len() <= 128, "provider catalogue exceeds limit");
        Ok(rows.clone())
    })();
    match legacy {
        Ok(rows) => {
            for row in rows {
                let id = text(&row, "id");
                if public.iter().any(|p| p["id"] == json!(id)) {
                    continue;
                }
                let name = text(&row, "name").or_else(|| id.clone());
                let models = row["models"]
                    .as_array()
                    .map(|rows| {
                        rows.iter()
                            .take(256)
                            .filter_map(|m| m.as_str().map(str::to_owned).or_else(|| text(m, "id")))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                let mut value =
                    json!({"id":id,"name":name,"models":models,"credentials":"notImported"});
                if let (Some(name), Some(base), Some(protocol), Ok(models), Ok(parameters)) = (
                    name,
                    row["baseUrl"].as_str(),
                    row["protocol"].as_str(),
                    serde_json::from_value::<Vec<areal_config::models::ModelConfig>>(
                        row["models"].clone(),
                    ),
                    serde_json::from_value::<areal_config::models::Parameters>(
                        row.get("parameters").cloned().unwrap_or(json!({})),
                    ),
                ) && let Some(candidate) =
                    template(&name, base, protocol, json!(models), json!(parameters))
                {
                    value["templateDigest"] =
                        json!(storage::digest(&serde_json::to_vec(&candidate).unwrap()));
                    value["template"] = candidate;
                }
                public.push(value);
            }
        }
        Err(_) => unavailable = true,
    }
    let state = if unavailable {
        if public.is_empty() {
            "unavailable"
        } else {
            "partial"
        }
    } else {
        "available"
    };
    (public, state)
}
pub(super) fn tasks(manifest: &Manifest, projects: &[Value]) -> (Vec<Value>, Vec<String>, bool) {
    let mut selected = Vec::new();
    let mut unavailable = Vec::new();
    let mut truncated = false;
    for project in projects {
        let Some(id) = project["id"]
            .as_str()
            .filter(|id| id.len() == 24 && id.bytes().all(|c| c.is_ascii_hexdigit()))
        else {
            continue;
        };
        let root = manifest.source.core_home.join(id).join("state");
        if !root.exists() {
            continue;
        }
        if root.canonicalize().ok().as_ref() != Some(&root) {
            unavailable.push(id.to_owned());
            continue;
        }
        match areal_engine::read_published_task_catalog(&root, None, 256) {
            Ok(areal_engine::PublishedTaskCatalog::Snapshot { data, has_more, .. }) => {
                truncated |= has_more;
                for row in data {
                    if selected.len() >= 256 {
                        truncated = true;
                        break;
                    }
                    selected.push(json!({"projectId":id,"taskId":row.id,"title":row.objective_preview,"schedule":row.schedule,"scheduleV2":row.schedule_v2,"imported":false}));
                }
            }
            Ok(areal_engine::PublishedTaskCatalog::Empty) => {}
            _ => unavailable.push(id.to_owned()),
        }
    }
    (selected, unavailable, truncated)
}
