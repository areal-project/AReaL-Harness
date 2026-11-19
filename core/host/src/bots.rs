//! Personal Agent（Bot）Host 领域入口：承接注册表、EnvArena 沙箱连接池与事件流。
//! 对外统一经 `bots.read` / `bots.command` 与 `bots.event` 提供给 GUI、网页、CLI 及远程端。
#[path = "bots/arena.rs"]
pub(crate) mod arena;
#[path = "bots/events.rs"]
mod events;
#[path = "bots/pool.rs"]
pub(crate) mod pool;
#[path = "bots/store.rs"]
pub(crate) mod store;
#[cfg(test)]
#[path = "bots/tests.rs"]
mod tests;

use super::Host;
use anyhow::{Context, Result, ensure};
use pool::{BotService, ConfigureArenaInput, CreateBotInput, UpdateBotInput};
use serde_json::{Value, json};
use std::path::Path;
use store::{BotModelRef, BotStore, ProviderSyncMode, SystemPromptMode};
use tokio::sync::broadcast;

pub(super) const METHODS: &[&str] = &["bots.read", "bots.command"];

const READS: &[&str] = &["list", "get", "settings", "observe", "models", "reconcile"];
const WRITES: &[&str] = &[
    "configureArena",
    "create",
    "update",
    "remove",
    "connect",
    "disconnect",
    "send",
    "interrupt",
    "respondInteraction",
    "compact",
    "resetConversation",
    "upsertProvider",
];

fn allowed_fields(operation: &str) -> Option<&'static [&'static str]> {
    Some(match operation {
        "list" | "settings" => &[],
        "get" | "observe" | "models" | "reconcile" | "connect" | "disconnect" | "interrupt"
        | "compact" | "resetConversation" => &["id"],
        "configureArena" => &["baseUrl", "profile", "token", "clearToken"],
        "create" => &[
            "name",
            "avatar",
            "description",
            "workspace",
            "starterPrompts",
            "systemPromptMode",
            "preferences",
            "modelOverride",
            "providerSyncMode",
        ],
        "update" => &[
            "id",
            "expectedRevision",
            "name",
            "avatar",
            "description",
            "starterPrompts",
            "systemPromptMode",
            "preferences",
            "modelOverride",
            "providerSyncMode",
        ],
        "remove" => &["id", "expectedRevision"],
        "send" => &["id", "text", "input", "requestId"],
        "respondInteraction" => &["id", "interactionId", "response"],
        "upsertProvider" => &["id", "provider", "expectedRevision", "modelOverride"],
        _ => return None,
    })
}

pub(crate) struct Bots {
    service: BotService,
}

impl Bots {
    pub(crate) fn load(host_home: &Path) -> Result<Self> {
        let store = BotStore::new(host_home);
        let service = BotService::load(store)?;
        Ok(Self { service })
    }

    pub(crate) fn subscribe_events(&self) -> broadcast::Receiver<Value> {
        self.service.subscribe_events()
    }
}

/// Host 网关入口（Loopback / Web / GUI）：读直接返回，写返回标准回执信封。
/// 若远端发送发生传输中断，如实透出 `admissionState: "unknown", submissionUnknown: true`。
pub(super) async fn gateway(host: &Host, method: &str, request: &Value) -> Result<Value> {
    let params = &request["params"];
    if method == "bots.read" {
        ensure!(request.get("commandId").is_none(), "INVALID_PARAMS");
        return self::request(host, method, params).await;
    }
    let command = request["commandId"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 128)
        .context("INVALID_PARAMS")?;
    let receipt = self::request_with_command_id(host, method, params, Some(command)).await?;
    let submission_unknown = receipt["submissionUnknown"].as_bool().unwrap_or(false);
    let admission_state = if submission_unknown {
        "unknown"
    } else {
        "accepted"
    };
    Ok(json!({
        "commandId": command,
        "method": method,
        "admissionState": admission_state,
        "submissionUnknown": submission_unknown,
        "receipt": receipt,
    }))
}

fn harness_provider(host: &Host, model: &BotModelRef) -> Result<Value> {
    let workbench = &host.gateway.workbench;
    workbench.restore_source(host)?;
    let source = workbench
        .active_source()
        .context("BOT_MODEL_AUTH_REQUIRED")?;
    let options = workbench.utility_options(&source)?;
    super::provider_config::import_saved_configuration(host, &source, &options)?;
    let catalog = super::workbench_utility::models_catalog(host, &source, &options)?;
    let id = model.provider_id.as_deref().context("INVALID_PARAMS")?;
    catalog["data"]
        .as_array()
        .and_then(|providers| {
            providers.iter().find(|provider| {
                provider["id"] == id
                    && provider["enabled"] == true
                    && provider["models"].as_array().is_some_and(|models| {
                        models
                            .iter()
                            .any(|entry| entry["id"] == model.model_id && entry["enabled"] == true)
                    })
            })
        })
        .cloned()
        .context("BOT_MODEL_AUTH_REQUIRED")
}

pub(super) async fn request(host: &Host, method: &str, params: &Value) -> Result<Value> {
    request_with_command_id(host, method, params, None).await
}

async fn request_with_command_id(
    host: &Host,
    method: &str,
    params: &Value,
    command_id: Option<&str>,
) -> Result<Value> {
    let obj = params.as_object().context("INVALID_PARAMS")?;
    let operation = obj
        .get("operation")
        .and_then(Value::as_str)
        .context("INVALID_PARAMS")?;
    let allowed = allowed_fields(operation).context("INVALID_PARAMS")?;
    ensure!(
        if method == "bots.read" {
            READS.contains(&operation)
        } else {
            WRITES.contains(&operation)
        },
        "INVALID_PARAMS"
    );
    ensure!(
        obj.keys()
            .all(|key| key == "operation" || allowed.contains(&key.as_str())),
        "INVALID_PARAMS"
    );

    let service = &host.bots.service;
    match operation {
        "list" => service.list(),
        "settings" => Ok(serde_json::to_value(service.settings()?)?),
        "get" => service.get(req_str(params, "id")?),
        "observe" => service.observe(req_str(params, "id")?).await,
        "models" => service.models(req_str(params, "id")?).await,
        "reconcile" => service.reconcile(req_str(params, "id")?).await,
        "configureArena" => {
            let input = ConfigureArenaInput {
                base_url: opt_nullable_str(params, "baseUrl")?,
                profile: opt_nullable_str(params, "profile")?,
                token: opt_str(params, "token")?.map(str::to_owned),
                clear_token: params
                    .get("clearToken")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            };
            service.configure_arena(input)
        }
        "create" => {
            let input = CreateBotInput {
                name: req_str(params, "name")?.to_owned(),
                avatar: opt_str(params, "avatar")?.map(str::to_owned),
                description: opt_str(params, "description")?.map(str::to_owned),
                workspace: opt_str(params, "workspace")?.map(str::to_owned),
                starter_prompts: opt_string_vec(params, "starterPrompts")?.unwrap_or_default(),
                system_prompt_mode: opt_enum(params, "systemPromptMode")?.unwrap_or_default(),
                preferences: opt_str(params, "preferences")?
                    .unwrap_or_default()
                    .to_owned(),
                model_override: opt_model_ref(params, "modelOverride")?,
                provider_sync_mode: opt_enum(params, "providerSyncMode")?.unwrap_or_default(),
            };
            service.create(input)
        }
        "update" => {
            let model_override = if let Some(val) = params.get("modelOverride") {
                if val.is_null() {
                    Some(None)
                } else {
                    Some(Some(parse_model_ref(val)?))
                }
            } else {
                None
            };
            let input = UpdateBotInput {
                id: req_str(params, "id")?.to_owned(),
                expected_revision: opt_u64(params, "expectedRevision")?,
                name: opt_str(params, "name")?.map(str::to_owned),
                avatar: opt_str(params, "avatar")?.map(str::to_owned),
                description: opt_str(params, "description")?.map(str::to_owned),
                starter_prompts: opt_string_vec(params, "starterPrompts")?,
                system_prompt_mode: opt_enum::<SystemPromptMode>(params, "systemPromptMode")?,
                preferences: opt_str(params, "preferences")?.map(str::to_owned),
                model_override,
                provider_sync_mode: opt_enum::<ProviderSyncMode>(params, "providerSyncMode")?,
            };
            let existing = service.find_bot(&input.id)?;
            if input
                .provider_sync_mode
                .unwrap_or(existing.provider_sync_mode)
                == ProviderSyncMode::HostSync
                && (input.provider_sync_mode.is_some() || input.model_override.is_some())
            {
                let model = input
                    .model_override
                    .as_ref()
                    .unwrap_or(&existing.model_override)
                    .as_ref()
                    .context("INVALID_PARAMS")?;
                let provider = harness_provider(host, model)?;
                service
                    .check_harness_model(&input.id, model, &provider, true)
                    .await?;
                ensure!(harness_provider(host, model)? == provider, "TARGET_CHANGED");
            }
            service.update(input).await
        }
        "remove" => service.remove(req_str(params, "id")?, opt_u64(params, "expectedRevision")?),
        "connect" => service.connect(req_str(params, "id")?).await,
        "disconnect" => service.disconnect(req_str(params, "id")?),
        "send" => {
            let bot_id = req_str(params, "id")?;
            let request_id = opt_str(params, "requestId")?
                .or(command_id)
                .map(str::to_owned)
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let input = parse_send_input(params)?;
            let bot = service.find_bot(bot_id)?;
            if bot.provider_sync_mode == ProviderSyncMode::HostSync
                && bot.pending_submission.is_none()
            {
                let model = bot
                    .model_override
                    .as_ref()
                    .context("BOT_MODEL_AUTH_REQUIRED")?;
                let provider = harness_provider(host, model)?;
                service
                    .check_harness_model(bot_id, model, &provider, false)
                    .await?;
                let current = service.find_bot(bot_id)?;
                ensure!(
                    current.model_override == bot.model_override
                        && current.provider_sync_mode == bot.provider_sync_mode
                        && harness_provider(host, model)? == provider,
                    "TARGET_CHANGED"
                );
            }
            service.send(bot_id, input, &request_id).await
        }
        "interrupt" => service.interrupt(req_str(params, "id")?).await,
        "respondInteraction" => {
            let bot_id = req_str(params, "id")?;
            let interaction_id = req_str(params, "interactionId")?;
            let response = params.get("response").cloned().context("INVALID_PARAMS")?;
            service
                .respond_interaction(bot_id, interaction_id, response)
                .await
        }
        "compact" => service.compact(req_str(params, "id")?).await,
        "resetConversation" => service.reset_conversation(req_str(params, "id")?).await,
        "upsertProvider" => {
            let bot_id = req_str(params, "id")?;
            let provider = params.get("provider").cloned().context("INVALID_PARAMS")?;
            ensure!(provider.is_object(), "INVALID_PARAMS");
            service
                .upsert_provider(
                    bot_id,
                    provider,
                    opt_u64(params, "expectedRevision")?,
                    opt_model_ref(params, "modelOverride")?,
                )
                .await
        }
        _ => anyhow::bail!("INVALID_PARAMS"),
    }
}

fn req_str<'a>(params: &'a Value, key: &str) -> Result<&'a str> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 16384 && !s.contains('\0'))
        .context("INVALID_PARAMS")
}

fn opt_str<'a>(params: &'a Value, key: &str) -> Result<Option<&'a str>> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if !s.contains('\0') => Ok(Some(s.as_str())),
        _ => anyhow::bail!("INVALID_PARAMS"),
    }
}

fn opt_nullable_str(params: &Value, key: &str) -> Result<Option<Option<String>>> {
    match params.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(s)) if !s.contains('\0') => Ok(Some(Some(s.clone()))),
        _ => anyhow::bail!("INVALID_PARAMS"),
    }
}

fn opt_u64(params: &Value, key: &str) -> Result<Option<u64>> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => Ok(Some(v.as_u64().context("INVALID_PARAMS")?)),
    }
}

fn opt_string_vec(params: &Value, key: &str) -> Result<Option<Vec<String>>> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(items)) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                out.push(item.as_str().context("INVALID_PARAMS")?.to_owned());
            }
            Ok(Some(out))
        }
        _ => anyhow::bail!("INVALID_PARAMS"),
    }
}

fn opt_enum<T: serde::de::DeserializeOwned>(params: &Value, key: &str) -> Result<Option<T>> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(val) => Ok(Some(
            serde_json::from_value(val.clone()).map_err(|_| anyhow::anyhow!("INVALID_PARAMS"))?,
        )),
    }
}

fn opt_model_ref(params: &Value, key: &str) -> Result<Option<BotModelRef>> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(val) => Ok(Some(parse_model_ref(val)?)),
    }
}

fn parse_model_ref(val: &Value) -> Result<BotModelRef> {
    let model_ref: BotModelRef =
        serde_json::from_value(val.clone()).map_err(|_| anyhow::anyhow!("INVALID_PARAMS"))?;
    ensure!(
        !model_ref.model_id.is_empty() && model_ref.model_id.len() <= 256,
        "INVALID_PARAMS"
    );
    if let Some(pid) = &model_ref.provider_id {
        ensure!(!pid.is_empty() && pid.len() <= 128, "INVALID_PARAMS");
    }
    Ok(model_ref)
}

fn parse_send_input(params: &Value) -> Result<Vec<Value>> {
    if let Some(input) = params.get("input") {
        let arr = input.as_array().context("INVALID_PARAMS")?;
        ensure!(!arr.is_empty() && arr.len() <= 32, "INVALID_PARAMS");
        return Ok(arr.clone());
    }
    let text = params
        .get("text")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty() && s.len() <= 65536 && !s.contains('\0'))
        .context("INVALID_PARAMS")?;
    Ok(vec![json!({
        "type": "text",
        "text": text,
    })])
}
