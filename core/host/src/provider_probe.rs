//! 供应商发现与连接测试只走 Host 网络与 Vault，不启动执行层。
use super::*;
use anyhow::bail;
use futures_util::StreamExt;

#[derive(Debug)]
struct Failure(String);
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RESOURCE_UNAVAILABLE")
    }
}
impl std::error::Error for Failure {}
pub(super) fn failure(message: &'static str) -> anyhow::Error {
    Failure(message.into()).into()
}
pub(super) fn rejection(error: &anyhow::Error) -> Option<Value> {
    error
        .downcast_ref::<Failure>()
        .map(|failure| json!({"code":"RESOURCE_UNAVAILABLE","message":failure.0}))
}
pub(super) fn native(request: &Value) -> bool {
    matches!(request["operation"].as_str(), Some("probe" | "discover"))
}
fn credential(value: &str) -> Result<String> {
    ensure!(
        value.len() <= 16384 && value.bytes().all(|b| (0x20..=0x7e).contains(&b)),
        "INVALID_PARAMS"
    );
    Ok(value.trim().to_owned())
}
fn snapshot(host: &Host, source: &str) -> Result<Value> {
    let options = host.gateway.workbench.utility_options(source)?;
    super::provider_config::import_saved_configuration(host, source, &options)?;
    super::workbench_utility::models_catalog(host, source, &options)
}
async fn key(host: &Host, source: &str, provider: &Value) -> Result<String> {
    saved_key(host, source, provider, false).await
}
pub(super) async fn saved_key(
    host: &Host,
    source: &str,
    provider: &Value,
    interaction_allowed: bool,
) -> Result<String> {
    let Some(reference) = provider["apiKeyEnv"].as_str() else {
        return Ok(String::new());
    };
    let references = host.migration.vault.provider_references(source)?;
    if reference.starts_with("AREAL_CREDENTIAL_") && !references.contains(reference) {
        return Err(failure("供应商凭据不可用，请检查配置。"));
    }
    if references.contains(reference) {
        let value=host.migration.vault.dispatch_async("vault.read",json!({"slot":{"kind":"providerCredential","sourceId":source,"reference":reference},"interactionAllowed":interaction_allowed}),&host.identity.generation,&host.migration).await
            .map_err(|_|failure("无法读取供应商凭据，请解锁安全存储后重试。"))?;
        return credential(
            value["value"]
                .as_str()
                .filter(|key| !key.is_empty())
                .ok_or_else(|| failure("供应商凭据不可用，请检查配置。"))?,
        );
    }
    let options = host.gateway.workbench.utility_options(source)?;
    let mut config = super::workbench_utility::inputs(&options)?;
    for (name, value) in host.gateway.workbench.environment_credentials(source) {
        config.env.insert(name.into(), value.into());
    }
    credential(
        config
            .env
            .get(std::ffi::OsStr::new(reference))
            .and_then(|v| v.to_str())
            .filter(|v| !v.trim().is_empty())
            .ok_or_else(|| failure("供应商环境凭据不可用，请检查配置。"))?,
    )
}
struct Connection {
    endpoint: String,
    protocol: String,
    key: String,
    revision: Option<String>,
}
async fn connection(host: &Host, source: &str, request: &Value) -> Result<Connection> {
    if request["operation"] == "discover" && request.get("connection").is_some() {
        let input = &request["connection"];
        let protocol = match input["protocol"].as_str() {
            Some("responses") => "responses",
            Some("chatCompletions") => "chat-completions",
            _ => bail!("INVALID_PARAMS"),
        };
        let endpoint = super::provider_config::endpoint(
            input["baseUrl"].as_str().context("INVALID_PARAMS")?,
            protocol,
        )?;
        let mut revision = None;
        let secret = match input["credential"]["kind"].as_str() {
            Some("none") => String::new(),
            Some("draft") => credential(
                input["credential"]["value"]
                    .as_str()
                    .context("INVALID_PARAMS")?,
            )?,
            Some("saved") => {
                let saved = snapshot(host, source)?;
                ensure!(
                    saved["revision"] == input["credential"]["expectedRevision"],
                    "TARGET_CHANGED"
                );
                revision = Some(
                    saved["revision"]
                        .as_str()
                        .context("INVALID_RESPONSE")?
                        .to_owned(),
                );
                let provider = saved["data"]
                    .as_array()
                    .context("INVALID_RESPONSE")?
                    .iter()
                    .find(|provider| provider["id"] == input["credential"]["providerId"])
                    .context("TARGET_CHANGED")?;
                key(host, source, provider).await?
            }
            _ => bail!("INVALID_PARAMS"),
        };
        ensure!(
            input["credential"]["kind"] == "none" || !secret.is_empty(),
            "PROVIDER_CREDENTIAL_REQUIRED"
        );
        return Ok(Connection {
            endpoint,
            protocol: protocol.into(),
            key: secret,
            revision,
        });
    }
    let saved = snapshot(host, source)?;
    let provider = saved["data"]
        .as_array()
        .context("INVALID_RESPONSE")?
        .iter()
        .find(|provider| provider["id"] == request["id"])
        .context("TARGET_CHANGED")?;
    if request["operation"] == "probe" {
        ensure!(
            provider["models"].as_array().is_some_and(|models| models
                .iter()
                .any(|model| model["id"] == request["model"] && model["enabled"] != false)),
            "INVALID_PARAMS"
        );
    }
    Ok(Connection {
        endpoint: provider["endpoint"]
            .as_str()
            .context("INVALID_RESPONSE")?
            .into(),
        protocol: provider["protocol"]
            .as_str()
            .context("INVALID_RESPONSE")?
            .into(),
        key: key(host, source, provider).await?,
        revision: Some(
            saved["revision"]
                .as_str()
                .context("INVALID_RESPONSE")?
                .into(),
        ),
    })
}
pub(super) async fn command(host: &Rc<Host>, source: &str, request: &Value) -> Result<Value> {
    ensure!(native(request), "INVALID_PARAMS");
    tokio::time::timeout(Duration::from_secs(30), execute(host, source, request))
        .await
        .map_err(|_| failure("模型连接超时，请检查网络后重试。"))?
}
async fn execute(host: &Rc<Host>, source: &str, request: &Value) -> Result<Value> {
    let connection = connection(host, source, request).await?;
    let network = host
        .gateway
        .workbench
        .model_network(host, source)
        .await
        .map_err(|_| failure("网络代理或补充证书配置不可用，请检查网络设置。"))?;
    host.admission()?;
    ensure!(
        host.gateway.workbench.backend_has_source(source),
        "FORBIDDEN"
    );
    if let Some(revision) = &connection.revision {
        ensure!(
            snapshot(host, source)?["revision"] == *revision,
            "TARGET_CHANGED"
        );
    }
    let url = if request["operation"] == "discover" {
        format!(
            "{}/models",
            super::provider_catalog::base_url(&connection.endpoint)
        )
    } else {
        connection.endpoint.clone()
    };
    let url = url::Url::parse(&url).context("INVALID_PARAMS")?;
    ensure!(
        matches!(url.scheme(), "http" | "https")
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "INVALID_PARAMS"
    );
    let route = if areal_config::proxy::proxy_for_url(&url, &network.proxies).is_some() {
        "proxy"
    } else {
        "direct"
    };
    let route_failure = |message: &str| {
        let label = if route == "proxy" { "代理" } else { "直连" };
        anyhow::Error::from(Failure(format!("请求路径：{label}。{message}")))
    };
    let client = crate::network::client(&network)
        .map_err(|_| route_failure("模型网络连接不可用，请检查代理和证书。"))?;
    let mut upstream=if request["operation"]=="discover"{client.get(url)}else{
        let body=if connection.protocol=="responses"{json!({"model":request["model"],"input":[{"role":"user","content":"Reply with OK."}],"store":false,"stream":true})}
            else{json!({"model":request["model"],"messages":[{"role":"user","content":"Reply with OK."}],"stream":true})};
        client.post(url).json(&body)
    }.header("content-type","application/json");
    if !connection.key.is_empty() {
        upstream = upstream.bearer_auth(&connection.key);
    }
    let response = upstream
        .send()
        .await
        .map_err(|_| route_failure("连接失败，请检查服务地址、网络代理和证书。"))?;
    if !response.status().is_success() {
        return Err(route_failure(if response.status().is_redirection() {
            "模型服务返回重定向，请使用最终服务地址。"
        } else if matches!(response.status().as_u16(), 401 | 403) {
            "认证失败，请检查 API Key 与模型权限。"
        } else {
            "模型服务返回 HTTP 错误，请检查服务状态。"
        }));
    }
    if request["operation"] == "probe" {
        let mut result = probe(response, &connection.protocol)
            .await
            .map_err(|error| {
                if let Some(failure) = error.downcast_ref::<Failure>() {
                    route_failure(&failure.0)
                } else {
                    error
                }
            })?;
        result["networkRoute"] = json!(route);
        return Ok(result);
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| failure("模型列表读取失败，请重试或手动添加模型。"))?;
        if bytes.len() + chunk.len() > 1_048_576 {
            return Err(failure("模型服务响应过大。"));
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| failure("模型服务未返回有效的 JSON 响应。"))?;
    let data = value["data"]
        .as_array()
        .ok_or_else(|| failure("服务未返回模型列表，请手动添加模型。"))?;
    let mut models = Vec::new();
    let mut parameters = serde_json::Map::new();
    for item in data {
        let Some(id) = item["id"].as_str().filter(|id| {
            !id.trim().is_empty()
                && id.encode_utf16().count() <= 256
                && (connection.key.is_empty() || !id.contains(&connection.key))
        }) else {
            continue;
        };
        let id = id.trim().to_owned();
        if !models.contains(&id) {
            if models.len() >= 64 {
                continue;
            }
            models.push(id.clone());
        }
        if let Some(window) = item["context_window"]
            .as_u64()
            .filter(|n| *n > 0 && *n <= 2_000_000)
        {
            parameters.insert(id, json!({"contextWindowTokens":window}));
        } else {
            parameters.remove(&id);
        }
    }
    let mut result = json!({"models":models});
    if !parameters.is_empty() {
        result["modelParameters"] = Value::Object(parameters);
    }
    Ok(result)
}
async fn probe(response: reqwest::Response, protocol: &str) -> Result<Value> {
    let invalid = || failure("模型服务未完成有效的流式文本回复，请检查模型和协议。");
    if !response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(';')
                .next()
                .unwrap_or("")
                .trim()
                .eq_ignore_ascii_case("text/event-stream")
        })
    {
        return Err(invalid());
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    let mut consumed = 0;
    let mut data = Vec::new();
    let mut text = String::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| invalid())?;
        if bytes.len() + chunk.len() > 1_048_576 {
            return Err(invalid());
        }
        bytes.extend_from_slice(&chunk);
        while let Some(end) = bytes[consumed..].iter().position(|b| *b == b'\n') {
            let line = std::str::from_utf8(&bytes[consumed..consumed + end])
                .map_err(|_| invalid())?
                .trim_end_matches('\r');
            consumed += end + 1;
            if let Some(value) = line.strip_prefix("data:") {
                data.push(value.strip_prefix(' ').unwrap_or(value).to_owned());
                continue;
            }
            if !line.is_empty() || data.is_empty() {
                continue;
            }
            let raw = data.join("\n");
            data.clear();
            if raw == "[DONE]" {
                continue;
            }
            let event: Value = serde_json::from_str(&raw).map_err(|_| invalid())?;
            if event.get("error").is_some_and(|error| !error.is_null())
                || matches!(
                    event["type"].as_str(),
                    Some("error" | "response.failed" | "response.incomplete")
                )
            {
                return Err(invalid());
            }
            let complete = if protocol == "responses" {
                if event["type"] == "response.output_text.delta"
                    && let Some(delta) = event["delta"].as_str()
                {
                    text.push_str(delta);
                }
                if event["type"] == "response.completed" {
                    if event["response"]["status"] != "completed" {
                        return Err(invalid());
                    }
                    if text.trim().is_empty() {
                        for item in event["response"]["output"].as_array().into_iter().flatten() {
                            for content in item["content"].as_array().into_iter().flatten() {
                                if content["type"] == "output_text" {
                                    text.push_str(content["text"].as_str().unwrap_or(""));
                                }
                            }
                        }
                    }
                    true
                } else {
                    false
                }
            } else if let Some(choice) = event["choices"]
                .as_array()
                .and_then(|choices| choices.iter().find(|choice| choice["index"] == 0))
            {
                if let Some(delta) = choice["delta"]["content"].as_str() {
                    text.push_str(delta);
                }
                if choice
                    .get("finish_reason")
                    .is_some_and(|reason| !reason.is_null())
                {
                    if choice["finish_reason"] != "stop" {
                        return Err(invalid());
                    }
                    true
                } else {
                    false
                }
            } else {
                false
            };
            if complete {
                if text.trim().is_empty() {
                    return Err(invalid());
                }
                return Ok(json!({"state":"connected"}));
            }
        }
    }
    Err(invalid())
}

#[cfg(test)]
#[path = "provider_probe_tests.rs"]
mod tests;
