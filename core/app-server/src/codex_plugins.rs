//! Codex 0.162.1 plugin management adapter. The package Store remains authoritative.
use super::*;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
areal_protocol::method_catalog! {
    "plugin/list" => Read;
    "plugin/installed" => Read;
    "plugin/read" => Read;
    "plugin/install" => Mutation;
    "plugin/uninstall" => Mutation;
    "plugin/reconcile" => Mutation;
    "plugin/search" => Read;
    "plugin/skill/read" => Read;
    "marketplace/add" => Mutation;
    "marketplace/remove" => Mutation;
    "marketplace/upgrade" => Mutation;
    "plugin/share/save" => Mutation;
    "plugin/share/updateTargets" => Mutation;
    "plugin/share/list" => Read;
    "plugin/share/checkout" => Mutation;
    "plugin/share/delete" => Mutation;
}
fn unavailable() -> RpcError {
    RpcError {
        code: -32004,
        message: "Codex hosted plugin catalog/sharing service is not configured".into(),
        data: Some(json!({"capability":"codexRemotePluginService"})),
    }
}
fn required<'a>(value: &'a Value, key: &str) -> Result<&'a str, RpcError> {
    value[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| RpcError::invalid(format!("{key} is required")))
}
fn array(value: &Value, key: &str) -> Result<Option<Vec<String>>, RpcError> {
    if value[key].is_null() {
        return Ok(None);
    };
    Ok(Some(
        value[key]
            .as_array()
            .ok_or_else(|| RpcError::invalid(format!("{key} must be an array")))?
            .iter()
            .map(|s| {
                s.as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| RpcError::invalid(format!("{key} items must be strings")))
            })
            .collect::<Result<_, _>>()?,
    ))
}
fn catalog_path(root: &str) -> String {
    for relative in [
        ".agents/plugins/marketplace.json",
        ".agents/plugins/api_marketplace.json",
        ".claude-plugin/marketplace.json",
        ".cursor-plugin/marketplace.json",
    ] {
        let p = std::path::Path::new(root).join(relative);
        if p.is_file() {
            return p.to_string_lossy().into_owned();
        }
    }
    root.into()
}
fn complete_interface(value: &Value) -> Value {
    if !value.is_object() {
        return Value::Null;
    }
    let mut value = value.clone();
    for key in [
        "displayName",
        "shortDescription",
        "longDescription",
        "developerName",
        "category",
        "websiteUrl",
        "privacyPolicyUrl",
        "termsOfServiceUrl",
        "defaultPrompt",
        "brandColor",
        "composerIcon",
        "composerIconUrl",
        "logo",
        "logoDark",
        "logoUrl",
        "logoDarkUrl",
    ] {
        if value.get(key).is_none() {
            value[key] = Value::Null;
        }
    }
    for key in ["capabilities", "screenshots", "screenshotUrls"] {
        if value.get(key).is_none() {
            value[key] = json!([]);
        }
    }
    value
}
fn summary(row: &Value) -> Value {
    json!({"id":row["id"],"remotePluginId":null,"version":row["version"],"localVersion":row["installedVersion"],"name":row["name"],"shareContext":null,"source":row.get("catalogSource").filter(|v|v.is_object()).cloned().unwrap_or_else(||json!({"type":"local","path":row["source"]})),"installed":row["installed"],"installedAt":null,"enabled":row["enabled"],"installPolicy":row.pointer("/policy/installation").and_then(Value::as_str).unwrap_or("AVAILABLE"),"installPolicySource":null,"mustShowInstallationInterstitial":null,"authPolicy":row.pointer("/policy/authentication").and_then(Value::as_str).unwrap_or("ON_INSTALL"),"availability":"AVAILABLE","disabledReason":null,"eligiblePlanTypes":null,"interface":complete_interface(&row["interface"]),"keywords":[]})
}
fn skill(row: &Value, enabled: bool) -> Value {
    json!({"name":row["name"],"description":row["description"],"shortDescription":null,"interface":null,"path":row["root"].as_str().map(|p|std::path::Path::new(p).join("SKILL.md").to_string_lossy().into_owned()),"enabled":enabled})
}
fn marketplaces(list: &Value, installed: bool, suggestions: &[String]) -> Vec<Value> {
    list["marketplaces"].as_array().into_iter().flatten().map(|market| {let suffix=format!("@{}",market["name"].as_str().unwrap_or(""));let plugins=list["data"].as_array().into_iter().flatten().filter(|row|row["id"].as_str().is_some_and(|id|id.ends_with(&suffix)) && (!installed || row["installed"]==true || suggestions.iter().any(|s|row["name"]==*s))).map(summary).collect::<Vec<_>>();json!({"name":market["name"],"path":market["root"].as_str().map(catalog_path),"interface":null,"plugins":plugins})}).collect()
}
fn errors(list: &Value) -> Vec<Value> {
    list["errors"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|value| {
            let message = value.as_str()?;
            let prefix = message.split(": ").next()?;
            let path = if prefix.starts_with('/') {
                prefix.to_owned()
            } else if message.starts_with("ambiguous marketplace ") {
                catalog_path(message.split_once(": ")?.1.split(" and ").next()?)
            } else {
                return None;
            };
            Some(json!({"marketplacePath":path,"message":message}))
        })
        .collect()
}
fn selected_root(path: &str) -> Result<PathBuf, RpcError> {
    let path = std::path::Path::new(path);
    if !path.is_absolute() {
        return Err(RpcError::invalid("marketplacePath must be absolute"));
    };
    for suffix in [
        ".agents/plugins/marketplace.json",
        ".agents/plugins/api_marketplace.json",
        ".claude-plugin/marketplace.json",
        ".cursor-plugin/marketplace.json",
    ] {
        if path.ends_with(suffix) {
            let n = std::path::Path::new(suffix).components().count();
            let mut root = path;
            for _ in 0..n {
                root = root
                    .parent()
                    .ok_or_else(|| RpcError::invalid("invalid marketplacePath"))?;
            }
            return Ok(root.into());
        }
    }
    Ok(path.into())
}
async fn selected(engine: &Arc<Engine>, params: &Value) -> Result<(Value, Value), RpcError> {
    if params["remoteMarketplaceName"].is_string() {
        return Err(unavailable());
    }
    let name = required(params, "pluginName")?;
    let list = if let Some(path) = params["marketplacePath"].as_str() {
        engine
            .plugin_wire_list(Some(vec![selected_root(path)?]))
            .await
    } else {
        engine.plugin_wire_list(None).await
    }
    .map_err(map_error)?;
    let path = params["marketplacePath"].as_str();
    let markets = list["marketplaces"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| {
            path.is_none_or(|p| {
                m["root"]
                    .as_str()
                    .is_some_and(|root| p == root || p == catalog_path(root))
            })
        })
        .filter_map(|m| m["name"].as_str())
        .collect::<Vec<_>>();
    let rows = list["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| {
            r["name"] == name
                && r["id"]
                    .as_str()
                    .is_some_and(|id| markets.iter().any(|m| id.ends_with(&format!("@{m}"))))
        })
        .cloned()
        .collect::<Vec<_>>();
    if rows.len() != 1 {
        return Err(RpcError::invalid(
            "plugin selector is unavailable or ambiguous",
        ));
    }
    Ok((list, rows[0].clone()))
}
pub(crate) async fn dispatch(
    engine: &Arc<Engine>,
    identity: &str,
    method: &str,
    params: Value,
) -> Result<Value, RpcError> {
    if !params.is_object() {
        return Err(RpcError::invalid("plugin parameters must be an object"));
    }
    if method.starts_with("plugin/share/") || method == "plugin/skill/read" {
        return Err(unavailable());
    }
    match method {
        "plugin/list" | "plugin/installed" | "plugin/search" => {
            if array(&params, "marketplaceKinds")?.is_some_and(|k| k.iter().any(|v| v != "local")) {
                return Err(unavailable());
            }
            let cwds: Option<Vec<PathBuf>> =
                array(&params, "cwds")?.map(|v| v.into_iter().map(PathBuf::from).collect());
            let personal = method == "plugin/search" && params["scope"] == "personal";
            let list = engine
                .plugin_wire_list(if personal { None } else { cwds.clone() })
                .await
                .map_err(map_error)?;
            if method == "plugin/search" {
                let term = required(&params, "searchTerm")?.to_lowercase();
                let limit = params["limit"].as_u64().unwrap_or(50).clamp(1, 100) as usize;
                if params["scope"]
                    .as_str()
                    .is_some_and(|s| !matches!(s, "global" | "workspace" | "personal"))
                {
                    return Err(RpcError::invalid("invalid plugin search scope"));
                }
                let query=format!("{:x}",Sha256::digest(serde_json::to_vec(&json!({"term":term,"scope":params["scope"],"cwds":cwds,"data":list["data"]})).unwrap()));
                let offset = if let Some(cursor) = params["cursor"].as_str() {
                    let bytes = URL_SAFE_NO_PAD
                        .decode(cursor)
                        .map_err(|_| RpcError::invalid("invalid plugin cursor"))?;
                    let state: Value = serde_json::from_slice(&bytes)
                        .map_err(|_| RpcError::invalid("invalid plugin cursor"))?;
                    if state["query"] != query {
                        return Err(RpcError::invalid(
                            "plugin cursor belongs to changed search; restart search",
                        ));
                    }
                    state["offset"]
                        .as_u64()
                        .and_then(|v| usize::try_from(v).ok())
                        .ok_or_else(|| RpcError::invalid("invalid plugin cursor"))?
                } else {
                    0
                };
                let selected_paths = cwds
                    .as_ref()
                    .into_iter()
                    .flatten()
                    .map(|p| catalog_path(&p.to_string_lossy()))
                    .collect::<Vec<_>>();
                let matches=marketplaces(&list,false,&[]).into_iter().filter(|m|params["scope"]!="workspace"||m["path"].as_str().is_some_and(|p|selected_paths.iter().any(|s|s==p))).flat_map(|m|m["plugins"].as_array().cloned().unwrap_or_default().into_iter().map(move|plugin|json!({"plugin":plugin,"marketplaceName":m["name"],"marketplacePath":m["path"]}))).filter(|p|["name","description"].iter().any(|key|p["plugin"][*key].as_str().is_some_and(|s|s.to_lowercase().contains(&term)))||p["plugin"]["interface"].to_string().to_lowercase().contains(&term)).collect::<Vec<_>>();
                let end = offset.saturating_add(limit).min(matches.len());
                let cursor = (end < matches.len()).then(|| {
                    URL_SAFE_NO_PAD
                        .encode(serde_json::to_vec(&json!({"query":query,"offset":end})).unwrap())
                });
                return Ok(
                    json!({"data":matches.get(offset..end).unwrap_or_default(),"nextCursor":cursor}),
                );
            }
            let suggestions = array(&params, "installSuggestionPluginNames")?.unwrap_or_default();
            let mut result = json!({"marketplaces":marketplaces(&list,method=="plugin/installed",&suggestions),"marketplaceLoadErrors":errors(&list)});
            if method == "plugin/list" {
                result["featuredPluginIds"] = json!([])
            }
            Ok(result)
        }
        "plugin/read" => {
            let (list, row) = selected(engine, &params).await?;
            let id = row["id"].as_str().unwrap();
            let (_, market) = id
                .rsplit_once('@')
                .ok_or_else(|| RpcError::invalid("invalid plugin identity"))?;
            let path = list["marketplaces"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|m| m["name"] == market)
                .and_then(|m| m["root"].as_str())
                .map(catalog_path);
            let components = engine
                .plugin_component_summary(id.into())
                .await
                .map_err(map_error)?;
            let skills = row["skills"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|s| skill(s, row["enabled"] == true))
                .collect::<Vec<_>>();
            let onboarding = row["installedOnboardingSkill"]
                .as_str()
                .filter(|_| row["installed"] == true && row["enabled"] == true)
                .and_then(|id| {
                    row["installedSkills"]
                        .as_array()?
                        .iter()
                        .find(|s| s["id"] == id)
                })
                .map(|s| skill(s, row["enabled"] == true));
            Ok(
                json!({"plugin":{"marketplaceName":market,"marketplacePath":path,"summary":summary(&row),"shareUrl":null,"description":row["description"],"skills":skills,"onboardingSkill":onboarding,"hooks":[],"apps":components["apps"],"appTemplates":[],"mcpServers":components["mcpServers"],"scheduledTasks":null}}),
            )
        }
        "plugin/install" => {
            let (list, mut row) = selected(engine, &params).await?;
            let mut revision = list["revision"].as_u64().unwrap();
            let id = row["id"].as_str().unwrap().to_owned();
            if let Some(path) = params["marketplacePath"].as_str() {
                let root = selected_root(path)?;
                let current = engine.plugin_list().await.map_err(map_error)?;
                if !current["marketplaces"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|m| m["root"] == root.to_string_lossy().as_ref())
                {
                    let registered = engine
                        .plugin_add_marketplace(root, revision)
                        .await
                        .map_err(map_error)?;
                    revision = registered["revision"].as_u64().unwrap();
                }
            }
            if row["sourceDigest"].as_str().unwrap_or("").is_empty() {
                row = engine
                    .plugin_resolve(id.clone(), revision)
                    .await
                    .map_err(map_error)?;
                revision = row["revision"].as_u64().unwrap();
            }
            let request = uuid::Uuid::new_v4().to_string();
            let arguments = json!({"id":id.clone(),"scope":"user","expectedRevision":revision,"source":row["source"],"expectedDigest":row["admissionDigest"].as_str().map(Value::from).unwrap_or_else(||row["sourceDigest"].clone())});
            let reply = engine
                .management_submission(
                    identity.into(),
                    request.clone(),
                    method.into(),
                    params,
                    move |engine| async move {
                        match engine
                            .plugin_install(
                                arguments["id"].as_str().unwrap().into(),
                                "user".into(),
                                revision,
                                PathBuf::from(arguments["source"].as_str().unwrap()),
                                arguments["expectedDigest"].as_str().unwrap().into(),
                            )
                            .await
                        {
                            Ok(v) => json!({"result":v}),
                            Err(e) => json!({"error":map_error(e)}),
                        }
                    },
                )
                .await
                .map_err(map_error)?;
            if let Some(error) = reply.get("error") {
                return Err(RpcError {
                    code: error["code"].as_i64().unwrap_or(-32603),
                    message: error["message"]
                        .as_str()
                        .unwrap_or("installation failed")
                        .into(),
                    data: Some(json!({"requestId":request})),
                });
            }
            Ok(
                json!({"authPolicy":row.pointer("/policy/authentication").and_then(Value::as_str).unwrap_or("ON_INSTALL"),"appsNeedingAuth":engine.plugin_component_summary(id.clone()).await.map_err(map_error)?["appsNeedingAuth"]}),
            )
        }
        "plugin/uninstall" => {
            let id = required(&params, "pluginId")?.to_owned();
            let list = engine.plugin_list().await.map_err(map_error)?;
            engine
                .plugin_uninstall(id, list["revision"].as_u64().unwrap())
                .await
                .map_err(map_error)?;
            Ok(json!({}))
        }
        "plugin/reconcile" => engine.plugin_reconcile_wire().await.map_err(map_error),
        "marketplace/add" => {
            let source = required(&params, "source")?;
            let sparse_paths = array(&params, "sparsePaths")?.unwrap_or_default();
            let before = engine.plugin_list().await.map_err(map_error)?;
            let revision = before["revision"].as_u64().unwrap();
            let local = std::path::Path::new(source);
            let list = if local.is_dir() {
                if !sparse_paths.is_empty() {
                    return Err(RpcError::invalid(
                        "sparsePaths is only supported for Git marketplace sources",
                    ));
                }
                engine
                    .plugin_add_marketplace(
                        local
                            .canonicalize()
                            .map_err(|_| RpcError::invalid("invalid marketplace path"))?,
                        revision,
                    )
                    .await
            } else {
                engine
                    .plugin_add_git_marketplace_sparse(
                        source.into(),
                        params["refName"].as_str().map(str::to_owned),
                        sparse_paths,
                        revision,
                    )
                    .await
            }
            .map_err(map_error)?;
            let old = before["marketplaces"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let market = list["marketplaces"]
                .as_array()
                .and_then(|ms| {
                    ms.iter()
                        .find(|m| {
                            m["root"].as_str().is_some_and(|r| {
                                local
                                    .canonicalize()
                                    .ok()
                                    .is_some_and(|p| p == std::path::Path::new(r))
                            }) || m["sourceUrl"] == source
                        })
                        .or_else(|| ms.iter().find(|m| !old.contains(m)))
                })
                .ok_or_else(|| RpcError::invalid("marketplace catalog missing"))?;
            Ok(
                json!({"marketplaceName":market["name"],"installedRoot":market["root"],"alreadyAdded":old.contains(market)}),
            )
        }
        "marketplace/remove" => {
            let name = required(&params, "marketplaceName")?;
            let list = engine.plugin_list().await.map_err(map_error)?;
            let root = list["marketplaces"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|m| m["name"] == name)
                .and_then(|m| m["root"].as_str())
                .map(PathBuf::from);
            if let Some(root) = &root {
                engine
                    .plugin_remove_marketplace(root.clone(), list["revision"].as_u64().unwrap())
                    .await
                    .map_err(map_error)?;
            }
            Ok(json!({"marketplaceName":name,"installedRoot":root}))
        }
        "marketplace/upgrade" => {
            let list = engine.plugin_list().await.map_err(map_error)?;
            let selected = params["marketplaceName"].as_str().map(str::to_owned);
            let names = list["marketplaces"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|m| selected.as_ref().is_none_or(|s| m["name"] == *s))
                .map(|m| m["name"].clone())
                .collect::<Vec<_>>();
            if selected.is_some() && names.is_empty() {
                return Err(RpcError::invalid("marketplace registration not found"));
            }
            let updated = engine
                .plugin_update_selected_marketplaces(
                    selected.clone(),
                    list["revision"].as_u64().unwrap(),
                )
                .await
                .map_err(map_error)?;
            Ok(
                json!({"selectedMarketplaces":names,"upgradedRoots":updated["marketplaces"].as_array().into_iter().flatten().filter(|m|m["resolvedCommit"].is_string()&&selected.as_ref().is_none_or(|s|m["name"]==*s)).filter_map(|m|m["root"].as_str()).collect::<Vec<_>>(),"errors":[]}),
            )
        }
        _ => Err(RpcError::invalid("unsupported plugin method")),
    }
}
