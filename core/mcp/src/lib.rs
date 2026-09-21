//! MCP tool client. Transport/lifecycle belong here, model and Turn state stay in Engine.
mod config;
use anyhow::{Context, Result, bail, ensure};
use areal_protocol::{DynamicToolResponse, ToolContent, ToolDefinition};
pub use config::{ServerConfig, TransportConfig, validate};
use rmcp::{
    ClientHandler, RoleClient, ServiceExt,
    model::*,
    service::{NotificationContext, Peer, PeerRequestOptions, RunningService},
    transport::{
        StreamableHttpClientTransport, TokioChildProcess,
        streamable_http_client::StreamableHttpClientTransportConfig,
    },
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    ffi::OsString,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug)]
struct Handler {
    changed: Arc<AtomicBool>,
}
impl ClientHandler for Handler {
    fn get_info(&self) -> ClientInfo {
        ClientInfo::new(
            ClientCapabilities::default(),
            Implementation::new("areal-harness", env!("CARGO_PKG_VERSION")),
        )
        .with_protocol_version(ProtocolVersion::V_2025_11_25)
    }
    async fn on_tool_list_changed(&self, _: NotificationContext<RoleClient>) {
        // An active Turn must keep the schema the model actually saw.
        self.changed.store(true, Ordering::Release);
    }
}

#[derive(Clone, Debug)]
pub struct McpTool {
    pub definition: ToolDefinition,
    server: Arc<str>,
    original_name: String,
    peer: Peer<RoleClient>,
    changed: Arc<AtomicBool>,
    timeout: Option<Duration>,
}
impl McpTool {
    pub fn is_stale(&self) -> bool {
        self.changed.load(Ordering::Acquire)
    }
    pub async fn call(
        &self,
        arguments: Value,
        cancel: CancellationToken,
    ) -> Result<DynamicToolResponse> {
        ensure!(
            !self.changed.load(Ordering::Acquire),
            "MCP tool directory invalidated; reconnect at an idle boundary"
        );
        let arguments = arguments
            .as_object()
            .context("MCP arguments must be an object")?
            .clone();
        let request = ClientRequest::CallToolRequest(CallToolRequest::new(
            CallToolRequestParams::new(self.original_name.clone()).with_arguments(arguments),
        ));
        // Use the SDK's single cancellable request, without automatic MRTR resubmission.
        let deadline = async {
            match self.timeout {
                Some(duration) => tokio::time::sleep(duration).await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::pin!(deadline);
        let mut handle = tokio::select! {
            biased;
            _ = cancel.cancelled() => bail!("MCP call cancelled before submission"),
            _ = &mut deadline => bail!("MCP request submission timed out; outcome is UNKNOWN"),
            handle = self.peer.send_cancellable_request(request, PeerRequestOptions::no_options()) => handle.map_err(|_| anyhow::anyhow!("MCP {} request could not be submitted; outcome is UNKNOWN", self.server))?,
        };
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => None,
            _ = &mut deadline => None,
            result = &mut handle.rx => Some(result),
        };
        let Some(result) = result else {
            let _ = tokio::time::timeout(
                Duration::from_secs(1),
                handle.cancel(Some("AReaL tool timeout or cancellation".into())),
            )
            .await;
            bail!(
                "MCP {} call cancelled or timed out; outcome is UNKNOWN",
                self.server
            );
        };
        let result = result
            .map_err(|_| anyhow::anyhow!("MCP {} disconnected; outcome is UNKNOWN", self.server))?
            .map_err(|_| {
                anyhow::anyhow!(
                    "MCP {} returned a protocol/transport error; outcome is UNKNOWN",
                    self.server
                )
            })?;
        let ServerResult::CallToolResult(result) = result else {
            bail!("MCP returned an incomplete or unexpected result; outcome is UNKNOWN");
        };
        let value = serde_json::to_value(result)?;
        ensure!(
            serde_json::to_vec(&value)?.len() <= 24 * 1024 * 1024,
            "MCP result exceeds 24 MiB; outcome is UNKNOWN"
        );
        convert_result(value)
    }
}

fn convert_result(value: Value) -> Result<DynamicToolResponse> {
    let mut items = Vec::new();
    for content in value["content"]
        .as_array()
        .context("MCP result is not a completed tools/call response")?
    {
        match content["type"].as_str() {
            Some("text") => items.push(ToolContent::InputText {
                text: content["text"].as_str().context("invalid MCP text")?.into(),
            }),
            Some("image" | "audio") => items.push(ToolContent::InlineMedia {
                modality: if content["type"] == "image" {
                    areal_protocol::Modality::Image
                } else {
                    areal_protocol::Modality::Audio
                },
                mime_type: content["mimeType"]
                    .as_str()
                    .context("missing MCP media MIME")?
                    .into(),
                data_base64: content["data"]
                    .as_str()
                    .context("missing MCP media data")?
                    .into(),
            }),
            Some("resource") if content["resource"]["blob"].is_string() => {
                items.push(ToolContent::InlineMedia {
                    modality: areal_protocol::Modality::File,
                    mime_type: content["resource"]["mimeType"]
                        .as_str()
                        .context("missing MCP resource MIME")?
                        .into(),
                    data_base64: content["resource"]["blob"].as_str().unwrap().into(),
                })
            }
            Some("resource") if content["resource"]["text"].is_string() => {
                items.push(ToolContent::InputText {
                    text: content.to_string(),
                })
            }
            Some("resource_link") => items.push(ToolContent::InputText {
                text: content.to_string(),
            }),
            _ => bail!("MCP returned unsupported non-text content; outcome is UNKNOWN"),
        }
    }
    let text_bytes: usize = items
        .iter()
        .map(|item| match item {
            ToolContent::InputText { text } => text.len(),
            _ => 0,
        })
        .sum();
    ensure!(
        text_bytes
            + value
                .get("structuredContent")
                .map_or(0, |v| v.to_string().len())
            <= 16 * 1024,
        "MCP text result exceeds 16 KiB; outcome is UNKNOWN"
    );
    Ok(DynamicToolResponse {
        success: !value["isError"].as_bool().unwrap_or(false),
        content_items: items,
        structured_content: value.get("structuredContent").cloned(),
    })
}

/// Owns live connections. Startup failures roll back all earlier connections.
pub struct Connections {
    services: Vec<RunningService<RoleClient, Handler>>,
    tools: Vec<McpTool>,
}
impl Connections {
    pub async fn connect(
        servers: &BTreeMap<String, ServerConfig>,
        env: &BTreeMap<OsString, OsString>,
        base: &Path,
        cancel: CancellationToken,
    ) -> Result<Self> {
        validate(servers)?;
        let mut connections = Self {
            services: Vec::new(),
            tools: Vec::new(),
        };
        for (name, config) in servers {
            let deadline =
                tokio::time::Instant::now() + Duration::from_millis(config.startup_timeout_ms);
            let connected = tokio::select! {
                biased;
                _ = cancel.cancelled() => Err(anyhow::anyhow!("MCP startup cancelled")),
                value = tokio::time::timeout_at(deadline, connect_one(name, config, env, base)) => value.map_err(|_| anyhow::anyhow!("MCP {name} startup timed out")).and_then(|r| r),
            };
            let result = match connected {
                Ok(service) => {
                    connections.services.push(service);
                    let service = connections.services.last().unwrap();
                    tokio::select! {
                        biased;
                        _ = cancel.cancelled() => Err(anyhow::anyhow!("MCP startup cancelled")),
                        value = tokio::time::timeout_at(deadline, discover(name, config, service)) => value.map_err(|_| anyhow::anyhow!("MCP {name} discovery timed out")).and_then(|r| r),
                    }
                }
                Err(e) => Err(e),
            };
            match result {
                Ok(tools) if tools.len() + connections.tools.len() <= 128 => {
                    connections.tools.extend(tools)
                }
                other => {
                    let error = other
                        .err()
                        .unwrap_or_else(|| anyhow::anyhow!("MCP tools exceed 128"));
                    if let Err(cleanup) = connections.shutdown().await {
                        return Err(error.context(cleanup));
                    }
                    return Err(error);
                }
            }
        }
        Ok(connections)
    }
    pub fn tools(&self) -> Vec<McpTool> {
        self.tools.clone()
    }
    pub async fn shutdown(&mut self) -> Result<()> {
        for tool in &self.tools {
            tool.changed.store(true, Ordering::Release);
        }
        let mut failed = false;
        for service in &mut self.services {
            failed |= !matches!(
                service.close_with_timeout(Duration::from_secs(5)).await,
                Ok(Some(_))
            );
        }
        self.services.clear();
        ensure!(!failed, "MCP shutdown could not be confirmed");
        Ok(())
    }
}

async fn connect_one(
    name: &str,
    config: &ServerConfig,
    env: &BTreeMap<OsString, OsString>,
    base: &Path,
) -> Result<RunningService<RoleClient, Handler>> {
    let handler = Handler {
        changed: Arc::new(AtomicBool::new(false)),
    };
    let service = match &config.transport {
        TransportConfig::Stdio {
            command,
            args,
            cwd,
            env_vars,
        } => {
            let mut process = tokio::process::Command::new(command);
            process.args(args).env_clear().kill_on_drop(true);
            // PATH is needed to resolve ordinary executables. Everything else is opt-in.
            if let Some(path) = env.get(std::ffi::OsStr::new("PATH")) {
                process.env("PATH", path);
            }
            for name in env_vars {
                process.env(
                    name,
                    env.get(std::ffi::OsStr::new(name))
                        .with_context(|| format!("missing MCP environment variable {name}"))?,
                );
            }
            process.current_dir(
                cwd.as_ref()
                    .map_or_else(|| base.to_owned(), |p| base.join(p)),
            );
            let (transport, _) = TokioChildProcess::builder(process)
                .stderr(std::process::Stdio::null())
                .spawn()
                .with_context(|| format!("cannot start MCP {name}"))?;
            handler.serve(transport).await
        }
        TransportConfig::StreamableHttp {
            url,
            bearer_token_env,
        } => {
            let mut config = StreamableHttpClientTransportConfig::with_uri(url.clone())
                .reinit_on_expired_session(false)
                .max_sse_event_size(4 * 1024 * 1024);
            if let Some(name) = bearer_token_env {
                let token = env
                    .get(std::ffi::OsStr::new(name))
                    .and_then(|v| v.to_str())
                    .filter(|v| !v.is_empty() && v.bytes().all(|b| (0x21..=0x7e).contains(&b)))
                    .with_context(|| {
                        format!("missing or invalid MCP bearer token environment variable {name}")
                    })?;
                config = config.auth_header(token);
            }
            let client = reqwest_mcp::Client::builder()
                .redirect(reqwest_mcp::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .build()?;
            handler
                .serve(StreamableHttpClientTransport::with_client(client, config))
                .await
        }
    };
    // SDK errors can include a private URL, headers or server-provided payloads.
    service.map_err(|_| anyhow::anyhow!("MCP {name} initialization failed"))
}

async fn discover(
    name: &str,
    config: &ServerConfig,
    service: &RunningService<RoleClient, Handler>,
) -> Result<Vec<McpTool>> {
    ensure!(
        service
            .peer_info()
            .is_some_and(|info| info.capabilities.tools.is_some()),
        "MCP {name} does not advertise tools"
    );
    let mut tools = Vec::new();
    let mut seen = HashSet::new();
    let mut cursors = HashSet::new();
    let mut cursor = None;
    for _ in 0..128 {
        let page = service
            .list_tools(Some(PaginatedRequestParams::default().with_cursor(cursor)))
            .await
            .map_err(|_| anyhow::anyhow!("MCP {name} tools/list failed"))?;
        ensure!(
            seen.len() + page.tools.len() <= 128,
            "MCP {name} advertises more than 128 tools"
        );
        for tool in page.tools {
            ensure!(
                seen.insert(tool.name.to_string()),
                "MCP {name} returned duplicate tool names"
            );
            ensure!(
                !tool.name.is_empty() && tool.name.len() <= 256,
                "invalid MCP tool name"
            );
            if config
                .enabled_tools
                .as_ref()
                .is_some_and(|enabled| !enabled.iter().any(|n| n == &*tool.name))
            {
                continue;
            }
            let alias = alias(name, &tool.name);
            tools.push(McpTool {
                definition: ToolDefinition {
                    name: alias,
                    description: tool
                        .description
                        .map(|d| d.into_owned())
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| format!("MCP {name}: {}", tool.name)),
                    input_schema: Value::Object((*tool.input_schema).clone()),
                    output_schema: tool.output_schema.map(|s| Value::Object((*s).clone())),
                },
                server: name.into(),
                original_name: tool.name.into_owned(),
                peer: service.peer().clone(),
                changed: service.service().changed.clone(),
                timeout: config.call_timeout_ms.map(Duration::from_millis),
            });
        }
        match page.next_cursor {
            Some(next) => {
                ensure!(
                    cursors.insert(next.clone()),
                    "MCP {name} repeated pagination cursor"
                );
                cursor = Some(next);
            }
            None => {
                if let Some(enabled) = &config.enabled_tools {
                    ensure!(
                        enabled.iter().all(|n| seen.contains(n)),
                        "MCP {name} enabledTools contains an undiscovered name"
                    );
                }
                return Ok(tools);
            }
        }
    }
    bail!("MCP {name} discovery exceeded 128 pages")
}

fn alias(server: &str, tool: &str) -> String {
    let simple = format!("mcp__{server}__{tool}");
    if simple.len() <= 64
        && tool
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return simple;
    }
    let digest = format!("{:x}", Sha256::digest(format!("{server}\0{tool}")));
    format!("mcp__{server}__{}", &digest[..24])
}
