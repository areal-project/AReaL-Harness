//! Bot 连接池、状态机、偏好热同步、双轨 Provider 探测与 UNKNOWN 恢复。
use super::{
    arena::{ArenaConnection, DEFAULT_HANDSHAKE_TIMEOUT},
    events::{
        build_thread_options, extract_input_preview, handle_arena_notification, map_arena_error,
    },
    store::{
        BotCustomProvider, BotModelRef, BotRecord, BotRegistry, BotStore, PendingSubmission,
        ProviderSyncMode, PublicArenaSettings, SystemPromptMode, build_workspace_ws_url,
        generate_workspace_id, normalize_provider_endpoint, normalize_provider_protocol, now_secs,
        truncate_preview, validate_avatar, validate_base_url, validate_description, validate_name,
        validate_preferences, validate_starter_prompts, validate_workspace_id,
    },
};
use anyhow::{Context, Result, anyhow, ensure};
use areal_local_service::storage;
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{Notify, broadcast};

const MAX_ACTIVE_CONNECTIONS: usize = 5;
const EVENT_CHANNEL_CAPACITY: usize = 512;
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_COMPLETED_TURN_IDS: usize = 32;

pub(crate) const PERSONAL_AGENT_BASE_PROMPT: &str = "\
You are a dedicated Personal Agent (Bot) working inside your own persistent workspace (/home/workspace).
Respond naturally, clearly, and concisely in the user's language, focusing on helpful outcomes rather than raw engineering logs.
When the user shares durable preferences, personal facts, ongoing goals, or explicit 'remember this' requests, maintain them in /home/workspace/AGENTS.md (which is automatically loaded on every turn) and keep structured reference notes under /home/workspace/memory/ when appropriate.
Only mention internal files or tools when relevant to the user's request.";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum BotConnectionState {
    Sleeping,
    Waking,
    Ready,
    Error { message: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderHealth {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub supports_credential_registration: bool,
}

impl Default for ProviderHealth {
    fn default() -> Self {
        Self {
            status: "unchecked",
            provider_id: None,
            model_id: None,
            message: None,
            supports_credential_registration: false,
        }
    }
}

struct ActiveSession {
    connection: ArenaConnection,
    last_used_at: i64,
    active_turn_id: Option<String>,
    completed_turn_ids: VecDeque<String>,
    models: Vec<Value>,
    providers: Vec<Value>,
    provider_health: ProviderHealth,
}

#[derive(Clone)]
pub(crate) struct BotService {
    store: BotStore,
    handshake_timeout: Duration,
    registry: Arc<Mutex<BotRegistry>>,
    states: Arc<Mutex<BTreeMap<String, BotConnectionState>>>,
    sessions: Arc<Mutex<BTreeMap<String, ActiveSession>>>,
    waking: Arc<Mutex<BTreeMap<String, Arc<Notify>>>>,
    events: broadcast::Sender<Value>,
}

#[derive(Clone, Debug)]
pub(crate) struct CreateBotInput {
    pub name: String,
    pub avatar: Option<String>,
    pub description: Option<String>,
    pub workspace: Option<String>,
    pub starter_prompts: Vec<String>,
    pub system_prompt_mode: SystemPromptMode,
    pub preferences: String,
    pub model_override: Option<BotModelRef>,
    pub provider_sync_mode: ProviderSyncMode,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct UpdateBotInput {
    pub id: String,
    pub expected_revision: Option<u64>,
    pub name: Option<String>,
    pub avatar: Option<String>,
    pub description: Option<String>,
    pub starter_prompts: Option<Vec<String>>,
    pub system_prompt_mode: Option<SystemPromptMode>,
    pub preferences: Option<String>,
    pub model_override: Option<Option<BotModelRef>>,
    pub provider_sync_mode: Option<ProviderSyncMode>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct ConfigureArenaInput {
    pub base_url: Option<Option<String>>,
    pub profile: Option<Option<String>>,
    pub token: Option<String>,
    pub clear_token: bool,
}

impl BotService {
    pub(crate) fn load(store: BotStore) -> Result<Self> {
        Self::load_with_timeout(store, DEFAULT_HANDSHAKE_TIMEOUT)
    }

    pub(crate) fn load_with_timeout(store: BotStore, handshake_timeout: Duration) -> Result<Self> {
        let registry = store.load()?;
        let (events, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        Ok(Self {
            store,
            handshake_timeout,
            registry: Arc::new(Mutex::new(registry)),
            states: Arc::new(Mutex::new(BTreeMap::new())),
            sessions: Arc::new(Mutex::new(BTreeMap::new())),
            waking: Arc::new(Mutex::new(BTreeMap::new())),
            events,
        })
    }

    pub(crate) fn subscribe_events(&self) -> broadcast::Receiver<Value> {
        self.events.subscribe()
    }

    fn emit(&self, event: Value) {
        let _ = self.events.send(event);
    }

    fn emit_state(&self, bot_id: &str, workspace: &str, state: &BotConnectionState) {
        self.emit(json!({
            "kind": "stateChanged",
            "botId": bot_id,
            "workspace": workspace,
            "state": state,
        }));
    }

    pub(super) fn emit_bot_event(
        &self,
        kind: &str,
        bot_id: &str,
        workspace: &str,
        connection_id: &str,
        payload: Value,
    ) {
        self.emit(json!({
            "kind": kind,
            "botId": bot_id,
            "workspace": workspace,
            "connectionId": connection_id,
            "payload": payload,
        }));
    }

    pub(super) fn drop_session_if_current(&self, bot_id: &str, connection_id: &str) -> bool {
        let mut sessions = self.sessions.lock().unwrap();
        if sessions
            .get(bot_id)
            .is_some_and(|s| s.connection.connection_id() == connection_id)
            && let Some(session) = sessions.remove(bot_id)
        {
            session.connection.close();
            return true;
        }
        false
    }

    pub(super) fn set_active_turn(&self, bot_id: &str, turn_id: Option<String>) {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.get_mut(bot_id) {
            if let Some(ref tid) = turn_id
                && session.completed_turn_ids.iter().any(|done| done == tid)
            {
                return;
            }
            session.active_turn_id = turn_id;
            session.last_used_at = now_secs();
        }
    }

    pub(super) fn mark_turn_completed(&self, bot_id: &str, turn_id: Option<&str>) {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.get_mut(bot_id) {
            if let Some(tid) = turn_id
                && !tid.is_empty()
            {
                if !session.completed_turn_ids.iter().any(|done| done == tid) {
                    if session.completed_turn_ids.len() >= MAX_COMPLETED_TURN_IDS {
                        session.completed_turn_ids.pop_front();
                    }
                    session.completed_turn_ids.push_back(tid.to_owned());
                }
                if session.active_turn_id.as_deref() == Some(tid) {
                    session.active_turn_id = None;
                }
            } else {
                session.active_turn_id = None;
            }
            session.last_used_at = now_secs();
        }
    }

    fn reconcile_active_turn_from_thread(&self, bot_id: &str, thread: &Value) {
        let status_type = thread["status"]["type"]
            .as_str()
            .or_else(|| thread["status"].as_str());
        let active_from_thread = if status_type == Some("active") {
            thread["turns"].as_array().and_then(|turns| {
                turns.iter().rev().find_map(|turn| {
                    let st = turn["status"].as_str()?;
                    if matches!(st, "inProgress" | "running" | "active") {
                        turn["id"].as_str().map(str::to_owned)
                    } else {
                        None
                    }
                })
            })
        } else {
            None
        };
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.get_mut(bot_id) {
            session.active_turn_id = active_from_thread;
        }
    }

    pub(super) fn set_state(&self, bot_id: &str, workspace: &str, state: BotConnectionState) {
        self.states
            .lock()
            .unwrap()
            .insert(bot_id.to_owned(), state.clone());
        self.emit_state(bot_id, workspace, &state);
    }

    fn state_of(&self, bot_id: &str) -> BotConnectionState {
        self.states
            .lock()
            .unwrap()
            .get(bot_id)
            .cloned()
            .unwrap_or(BotConnectionState::Sleeping)
    }

    fn bot_view(&self, record: &BotRecord) -> Value {
        let state = self.state_of(&record.id);
        let (active_turn_id, provider_health, models_count) = {
            let sessions = self.sessions.lock().unwrap();
            match sessions.get(&record.id) {
                Some(session) if !session.connection.is_closed() => (
                    session.active_turn_id.clone(),
                    Some(session.provider_health.clone()),
                    session.models.len(),
                ),
                _ => (None, None, 0),
            }
        };
        let mut value = serde_json::to_value(record).unwrap_or(Value::Null);
        if let Some(obj) = value.as_object_mut() {
            obj.insert(
                "connectionState".into(),
                serde_json::to_value(&state).unwrap(),
            );
            obj.insert(
                "preferencesDirty".into(),
                json!(record.synced_preferences_revision < record.preferences_revision),
            );
            obj.insert("activeTurnId".into(), json!(active_turn_id));
            obj.insert("providerHealth".into(), json!(provider_health));
            obj.insert("modelsCount".into(), json!(models_count));
        }
        value
    }

    pub(crate) fn list(&self) -> Result<Value> {
        let (revision, arena, bots) = {
            let reg = self.registry.lock().unwrap();
            let mut bots: Vec<Value> = reg.bots.iter().map(|b| self.bot_view(b)).collect();
            bots.sort_by(|a, b| {
                let a_ts = a["lastActiveAt"].as_i64().unwrap_or(0);
                let b_ts = b["lastActiveAt"].as_i64().unwrap_or(0);
                b_ts.cmp(&a_ts)
            });
            (reg.revision, reg.arena.clone(), bots)
        };
        let arena_settings = self.store.public_arena_settings(&arena)?;
        Ok(json!({
            "revision": revision,
            "arena": arena_settings,
            "bots": bots,
        }))
    }

    pub(crate) fn get(&self, bot_id: &str) -> Result<Value> {
        let record = self.find_bot(bot_id)?;
        let (models, providers, provider_health) = {
            let sessions = self.sessions.lock().unwrap();
            match sessions.get(bot_id) {
                Some(session) if !session.connection.is_closed() => (
                    session.models.clone(),
                    session.providers.clone(),
                    Some(session.provider_health.clone()),
                ),
                _ => (Vec::new(), Vec::new(), None),
            }
        };
        Ok(json!({
            "bot": self.bot_view(&record),
            "models": models,
            "providers": providers,
            "providerHealth": provider_health,
        }))
    }

    pub(crate) fn settings(&self) -> Result<PublicArenaSettings> {
        let arena = self.registry.lock().unwrap().arena.clone();
        self.store.public_arena_settings(&arena)
    }

    pub(crate) fn configure_arena(&self, input: ConfigureArenaInput) -> Result<Value> {
        if let Some(ref token) = input.token {
            self.store.save_token(Some(token))?;
        } else if input.clear_token {
            self.store.save_token(None)?;
        }
        let (revision, public) = {
            let mut reg = self.registry.lock().unwrap();
            if let Some(base_url) = input.base_url {
                reg.arena.base_url = match base_url {
                    Some(raw) if !raw.trim().is_empty() => Some(validate_base_url(&raw)?),
                    _ => None,
                };
            }
            if let Some(profile) = input.profile {
                reg.arena.profile = match profile {
                    Some(raw) if !raw.trim().is_empty() => {
                        let trimmed = raw.trim();
                        ensure!(
                            trimmed.len() <= 64
                                && trimmed
                                    .bytes()
                                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
                            "INVALID_PARAMS"
                        );
                        Some(trimmed.to_owned())
                    }
                    _ => None,
                };
            }
            reg.revision += 1;
            self.store.save(&reg)?;
            let public = self.store.public_arena_settings(&reg.arena)?;
            (reg.revision, public)
        };
        self.emit(json!({
            "kind": "registryChanged",
            "revision": revision,
        }));
        Ok(json!({
            "revision": revision,
            "arena": public,
        }))
    }

    pub(crate) fn create(&self, input: CreateBotInput) -> Result<Value> {
        let name = validate_name(&input.name)?;
        let avatar = match input.avatar {
            Some(ref raw) if !raw.trim().is_empty() => validate_avatar(raw)?,
            _ => "🤖".to_owned(),
        };
        let description = match input.description {
            Some(ref raw) => validate_description(raw)?,
            None => String::new(),
        };
        let starter_prompts = validate_starter_prompts(input.starter_prompts)?;
        let preferences = validate_preferences(&input.preferences)?;
        let workspace = match input.workspace {
            Some(ref raw) if !raw.trim().is_empty() => {
                let trimmed = raw.trim();
                validate_workspace_id(trimmed)?;
                trimmed.to_owned()
            }
            _ => generate_workspace_id(&name),
        };
        let now = now_secs();
        let record = BotRecord {
            id: format!("bot_{}", uuid::Uuid::new_v4().simple()),
            name,
            avatar,
            description,
            workspace,
            starter_prompts,
            system_prompt_mode: input.system_prompt_mode,
            preferences,
            preferences_revision: 1,
            synced_preferences_revision: 0,
            model_override: input.model_override,
            provider_sync_mode: input.provider_sync_mode,
            custom_providers: Vec::new(),
            thread_request_id: uuid::Uuid::new_v4().to_string(),
            active_thread_id: None,
            last_message_preview: String::new(),
            last_active_at: now,
            created_at: now,
            updated_at: now,
            pending_submission: None,
        };
        let revision = {
            let mut reg = self.registry.lock().unwrap();
            ensure!(reg.bots.len() < super::store::MAX_BOTS, "CAPACITY_EXCEEDED");
            ensure!(
                !reg.bots.iter().any(|b| b.workspace == record.workspace),
                "CONFLICT"
            );
            reg.bots.push(record.clone());
            reg.revision += 1;
            self.store.save(&reg)?;
            reg.revision
        };
        self.emit(json!({
            "kind": "registryChanged",
            "revision": revision,
        }));
        Ok(json!({
            "revision": revision,
            "bot": self.bot_view(&record),
        }))
    }

    pub(crate) async fn update(&self, input: UpdateBotInput) -> Result<Value> {
        let (revision, updated, config_changed) = {
            let mut reg = self.registry.lock().unwrap();
            if let Some(expected) = input.expected_revision {
                ensure!(reg.revision == expected, "TARGET_CHANGED");
            }
            let bot = reg
                .bots
                .iter_mut()
                .find(|b| b.id == input.id)
                .context("NOT_FOUND")?;
            let mut config_changed = false;
            if let Some(name) = input.name {
                bot.name = validate_name(&name)?;
            }
            if let Some(avatar) = input.avatar {
                bot.avatar = validate_avatar(&avatar)?;
            }
            if let Some(description) = input.description {
                bot.description = validate_description(&description)?;
            }
            if let Some(prompts) = input.starter_prompts {
                bot.starter_prompts = validate_starter_prompts(prompts)?;
            }
            if let Some(mode) = input.system_prompt_mode
                && bot.system_prompt_mode != mode
            {
                bot.system_prompt_mode = mode;
                config_changed = true;
            }
            if let Some(preferences) = input.preferences {
                let validated = validate_preferences(&preferences)?;
                if bot.preferences != validated {
                    bot.preferences = validated;
                    config_changed = true;
                }
            }
            if let Some(model_override) = input.model_override
                && bot.model_override != model_override
            {
                bot.model_override = model_override;
                config_changed = true;
            }
            if let Some(sync_mode) = input.provider_sync_mode {
                bot.provider_sync_mode = sync_mode;
            }
            if config_changed {
                bot.preferences_revision += 1;
            }
            bot.updated_at = now_secs();
            let snapshot = bot.clone();
            reg.revision += 1;
            self.store.save(&reg)?;
            (reg.revision, snapshot, config_changed)
        };

        // 如果 Bot 当前在线且配置变化，立即通过 areal/thread/configure 热同步。
        let mut final_record = updated;
        if config_changed {
            let active_conn = self.active_connection(&final_record.id);
            if let (Some(conn), Some(thread_id)) =
                (active_conn, final_record.active_thread_id.clone())
                && self
                    .sync_thread_configuration(&conn, &thread_id, &final_record)
                    .await
                    .is_ok()
            {
                final_record = self
                    .mark_preferences_synced(&final_record.id, final_record.preferences_revision)?;
            }
        }
        self.emit(json!({
            "kind": "registryChanged",
            "revision": revision,
        }));
        Ok(json!({
            "revision": revision,
            "bot": self.bot_view(&final_record),
        }))
    }

    pub(crate) fn remove(&self, bot_id: &str, expected_revision: Option<u64>) -> Result<Value> {
        self.disconnect(bot_id)?;
        let revision = {
            let mut reg = self.registry.lock().unwrap();
            if let Some(expected) = expected_revision {
                ensure!(reg.revision == expected, "TARGET_CHANGED");
            }
            let before = reg.bots.len();
            reg.bots.retain(|b| b.id != bot_id);
            ensure!(reg.bots.len() < before, "NOT_FOUND");
            reg.revision += 1;
            self.store.save(&reg)?;
            reg.revision
        };
        self.states.lock().unwrap().remove(bot_id);
        self.emit(json!({
            "kind": "registryChanged",
            "revision": revision,
        }));
        Ok(json!({
            "revision": revision,
            "removed": true,
        }))
    }

    pub(crate) fn disconnect(&self, bot_id: &str) -> Result<Value> {
        let bot = self.find_bot(bot_id)?;
        let closed = {
            let mut sessions = self.sessions.lock().unwrap();
            if let Some(session) = sessions.remove(bot_id) {
                session.connection.close();
                true
            } else {
                false
            }
        };
        self.set_state(bot_id, &bot.workspace, BotConnectionState::Sleeping);
        Ok(json!({
            "bot": self.bot_view(&bot),
            "disconnected": closed,
        }))
    }

    pub(crate) async fn connect(&self, bot_id: &str) -> Result<Value> {
        let (_conn, bot) = self.ensure_ready(bot_id).await?;
        let (models, providers, provider_health) = self.session_catalog(bot_id);
        Ok(json!({
            "bot": self.bot_view(&bot),
            "models": models,
            "providers": providers,
            "providerHealth": provider_health,
        }))
    }

    pub(crate) async fn observe(&self, bot_id: &str) -> Result<Value> {
        let (conn, bot) = self.ensure_ready(bot_id).await?;
        let thread_id = bot
            .active_thread_id
            .clone()
            .context("Bot thread not initialized")?;
        let observed = if conn.supports_method("areal/thread/observe") {
            conn.request("areal/thread/observe", json!({ "threadId": thread_id }))
                .await
                .map_err(map_arena_error)?
        } else {
            conn.request(
                "thread/read",
                json!({ "threadId": thread_id, "includeTurns": true }),
            )
            .await
            .map_err(map_arena_error)?
        };
        let thread = observed.get("thread").cloned().unwrap_or(observed);
        self.reconcile_active_turn_from_thread(bot_id, &thread);
        let (models, providers, provider_health) = self.session_catalog(bot_id);
        Ok(json!({
            "bot": self.bot_view(&bot),
            "thread": thread,
            "models": models,
            "providers": providers,
            "providerHealth": provider_health,
        }))
    }

    pub(crate) async fn models(&self, bot_id: &str) -> Result<Value> {
        let (conn, bot) = self.ensure_ready(bot_id).await?;
        let (models, providers, provider_health) = self.refresh_catalog(&conn, &bot).await?;
        Ok(json!({
            "botId": bot.id,
            "bot": self.bot_view(&bot),
            "models": models,
            "providers": providers,
            "providerHealth": provider_health,
        }))
    }

    pub(super) async fn check_harness_model(
        &self,
        bot_id: &str,
        model: &BotModelRef,
        provider: &Value,
        probe: bool,
    ) -> Result<()> {
        let (conn, _) = self.ensure_ready(bot_id).await?;
        let id = model.provider_id.as_deref().context("INVALID_PARAMS")?;
        let remote = conn
            .request("areal/provider/list", json!({}))
            .await
            .map_err(map_arena_error)?;
        ensure!(
            remote["data"]
                .as_array()
                .is_some_and(|items| items.iter().any(|item| {
                    item["id"] == id
                        && item["credentialState"] != "unavailable"
                        && item["endpoint"] == provider["endpoint"]
                        && normalize_provider_protocol(item["protocol"].as_str()).ok()
                            == normalize_provider_protocol(provider["protocol"].as_str()).ok()
                        && item["models"].as_array().is_some_and(|models| {
                            models.iter().any(|value| value == &model.model_id)
                        })
                })),
            "BOT_MODEL_AUTH_REQUIRED"
        );
        if !probe {
            return Ok(());
        }
        ensure!(
            conn.supports_method("areal/provider/probe"),
            "BOT_MODEL_AUTH_REQUIRED"
        );
        let proof = conn
            .request_with_timeout(
                "areal/provider/probe",
                json!({"id": id, "model": model.model_id}),
                PROBE_TIMEOUT,
            )
            .await
            .map_err(map_arena_error)?;
        ensure!(
            proof["state"] == "connected" && proof["modelId"] == model.model_id,
            "BOT_MODEL_AUTH_REQUIRED"
        );
        Ok(())
    }

    pub(crate) async fn upsert_provider(
        &self,
        bot_id: &str,
        provider: Value,
        expected_revision: Option<u64>,
        model_override: Option<BotModelRef>,
    ) -> Result<Value> {
        let (conn, _) = self.ensure_ready(bot_id).await?;
        ensure!(
            conn.supports_method("areal/provider/upsert"),
            "CAPABILITY_UNAVAILABLE"
        );
        let obj = provider.as_object().context("INVALID_PARAMS")?;
        let provider_id = obj
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| {
                !s.is_empty()
                    && s.len() <= 64
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
            })
            .context("INVALID_PARAMS")?
            .to_owned();

        let raw_protocol = obj
            .get("protocol")
            .or_else(|| obj.get("apiStyle"))
            .and_then(Value::as_str);
        let protocol = normalize_provider_protocol(raw_protocol)?.to_owned();

        let raw_endpoint = obj
            .get("endpoint")
            .or_else(|| obj.get("baseUrl"))
            .and_then(Value::as_str)
            .context("INVALID_PARAMS")?;
        let endpoint = normalize_provider_endpoint(raw_endpoint, &protocol)?;

        let mut model_ids: Vec<String> = Vec::new();
        if let Some(arr) = obj.get("models").and_then(Value::as_array) {
            for item in arr {
                let model = item
                    .as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty() && s.len() <= 256)
                    .context("INVALID_PARAMS")?;
                if !model_ids.iter().any(|existing| existing == model) {
                    model_ids.push(model.to_owned());
                }
            }
        }
        let requested_model_id = model_override
            .as_ref()
            .map(|m| m.model_id.trim().to_owned())
            .filter(|s| !s.is_empty() && s.len() <= 256);
        if let Some(ref model_id) = requested_model_id
            && !model_ids.iter().any(|existing| existing == model_id)
        {
            model_ids.push(model_id.clone());
        }
        ensure!(
            !model_ids.is_empty() && model_ids.len() <= 64,
            "INVALID_PARAMS"
        );

        let api_key = obj
            .get("apiKey")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let mut credential_ref = obj
            .get("credentialRef")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty() && s.len() <= 128)
            .map(str::to_owned);

        if let Some(secret) = api_key {
            if !conn.supports_method("areal/plugin/credentials/register") {
                return Err(anyhow!("REMOTE_CREDENTIAL_UNSUPPORTED"));
            }
            let target_ref = credential_ref
                .clone()
                .unwrap_or_else(|| format!("bot_provider_{provider_id}"));
            conn.request(
                "areal/plugin/credentials/register",
                json!({
                    "credentials": {
                        target_ref.clone(): secret,
                    }
                }),
            )
            .await
            .map_err(map_arena_error)?;
            self.store.save_provider_key(&target_ref, secret)?;
            credential_ref = Some(target_ref);
        }

        let expected = match expected_revision {
            Some(rev) => rev,
            None => {
                let list = conn
                    .request("areal/provider/list", json!({}))
                    .await
                    .map_err(map_arena_error)?;
                list["data"]
                    .as_array()
                    .and_then(|arr| arr.iter().find(|item| item["id"] == provider_id))
                    .and_then(|item| item["revision"].as_u64())
                    .unwrap_or(0)
            }
        };

        let parameters = obj
            .get("parameters")
            .filter(|v| v.is_object())
            .cloned()
            .unwrap_or_else(|| json!({}));
        let mut wire_provider = json!({
            "id": provider_id,
            "revision": expected,
            "endpoint": endpoint,
            "protocol": protocol,
            "models": model_ids,
            "parameters": parameters,
        });
        if let Some(ref cred_ref) = credential_ref {
            wire_provider["credentialRef"] = json!(cred_ref);
        }

        let upserted = conn
            .request(
                "areal/provider/upsert",
                json!({
                    "provider": wire_provider,
                    "expectedRevision": expected,
                }),
            )
            .await
            .map_err(|err| {
                if let super::arena::ArenaError::Rpc { ref message, .. } = err
                    && message.contains("CONFIGURATION_MANAGED")
                {
                    return anyhow!("PROVIDER_MANAGED");
                }
                map_arena_error(err)
            })?;

        let custom_entry = BotCustomProvider {
            id: provider_id.clone(),
            endpoint: endpoint.clone(),
            protocol: protocol.clone(),
            models: model_ids.clone(),
            credential_ref: credential_ref.clone(),
        };
        let next_model_override = requested_model_id.map(|model_id| BotModelRef {
            provider_id: Some(provider_id.clone()),
            model_id,
        });
        let (revision, updated_bot, model_changed) = {
            let mut reg = self.registry.lock().unwrap();
            let entry = reg
                .bots
                .iter_mut()
                .find(|b| b.id == bot_id)
                .context("NOT_FOUND")?;
            if let Some(slot) = entry
                .custom_providers
                .iter_mut()
                .find(|p| p.id == custom_entry.id)
            {
                *slot = custom_entry;
            } else {
                entry.custom_providers.push(custom_entry);
            }
            let mut model_changed = false;
            if let Some(ref next_model) = next_model_override
                && entry.model_override.as_ref() != Some(next_model)
            {
                entry.model_override = Some(next_model.clone());
                entry.preferences_revision += 1;
                model_changed = true;
            }
            entry.updated_at = now_secs();
            let snapshot = entry.clone();
            reg.revision += 1;
            self.store.save(&reg)?;
            (reg.revision, snapshot, model_changed)
        };
        let mut bot = updated_bot;
        if model_changed
            && let Some(thread_id) = bot.active_thread_id.clone()
            && self
                .sync_thread_configuration(&conn, &thread_id, &bot)
                .await
                .is_ok()
        {
            bot = self.mark_preferences_synced(&bot.id, bot.preferences_revision)?;
        }
        let (models, providers, provider_health) = self.refresh_catalog(&conn, &bot).await?;
        self.emit(json!({
            "kind": "registryChanged",
            "revision": revision,
        }));
        Ok(json!({
            "revision": revision,
            "bot": self.bot_view(&bot),
            "provider": upserted,
            "models": models,
            "providers": providers,
            "providerHealth": provider_health,
        }))
    }

    /// 发送消息：写操作前先持久化 pendingSubmission；传输中断保留 UNKNOWN 状态，绝不自动重放。
    pub(crate) async fn send(
        &self,
        bot_id: &str,
        input: Vec<Value>,
        request_id: &str,
    ) -> Result<Value> {
        ensure!(
            !input.is_empty() && !request_id.is_empty(),
            "INVALID_PARAMS"
        );
        let existing = self.find_bot(bot_id)?;
        let digest = storage::digest(serde_json::to_string(&input)?.as_bytes());
        if let Some(pending) = &existing.pending_submission {
            if pending.request_id == request_id && pending.digest == digest {
                return Ok(json!({
                    "bot": self.bot_view(&existing),
                    "admissionState": "unknown",
                    "submissionUnknown": true,
                    "pendingSubmission": pending,
                }));
            }
            return Err(anyhow!("SUBMISSION_PENDING"));
        }

        let (conn, bot) = self.ensure_ready(bot_id).await?;
        let thread_id = bot
            .active_thread_id
            .clone()
            .context("Bot thread not initialized")?;

        let config_revision = self
            .read_thread_config_revision(&conn, &thread_id)
            .await
            .unwrap_or(1);

        let preview = extract_input_preview(&input);
        let pending = PendingSubmission {
            request_id: request_id.to_owned(),
            thread_id: thread_id.clone(),
            digest,
            preview: preview.clone(),
            created_at: now_secs(),
        };
        self.set_pending_submission(bot_id, Some(pending.clone()))?;

        let (submit_method, submit_params) = if conn.supports_method("areal/turn/submit") {
            (
                "areal/turn/submit",
                json!({
                    "threadId": thread_id,
                    "requestId": request_id,
                    "expectedConfigRevision": config_revision,
                    "intent": {
                        "type": "message",
                        "input": input,
                    },
                }),
            )
        } else {
            (
                "areal/turn/start",
                json!({
                    "threadId": thread_id,
                    "requestId": request_id,
                    "expectedConfigRevision": config_revision,
                    "input": input,
                }),
            )
        };
        let submit_result = conn.request(submit_method, submit_params).await;

        match submit_result {
            Ok(receipt) => {
                let updated = self.finish_submission_success(bot_id, &preview)?;
                if let Some(turn_id) = receipt["turn"]["id"]
                    .as_str()
                    .or_else(|| receipt["turnId"].as_str())
                {
                    self.set_active_turn(bot_id, Some(turn_id.to_owned()));
                }
                Ok(json!({
                    "bot": self.bot_view(&updated),
                    "admissionState": "accepted",
                    "submissionUnknown": false,
                    "receipt": receipt,
                }))
            }
            Err(err) if err.is_rpc() => {
                // Core 明确拒绝（未受理），安全清除未决状态。
                let _ = self.set_pending_submission(bot_id, None);
                Err(map_arena_error(err))
            }
            Err(_transport_err) => {
                // 传输中断或超时：保留 pendingSubmission，禁止重放，等待 reconcile 核对回执。
                let current = self.find_bot(bot_id)?;
                Ok(json!({
                    "bot": self.bot_view(&current),
                    "admissionState": "unknown",
                    "submissionUnknown": true,
                    "pendingSubmission": pending,
                }))
            }
        }
    }

    /// 核对未决提交：通过权威回执与线程观察结算，绝不重放写请求。
    pub(crate) async fn reconcile(&self, bot_id: &str) -> Result<Value> {
        let bot = self.find_bot(bot_id)?;
        let Some(pending) = bot.pending_submission.clone() else {
            return Ok(json!({
                "bot": self.bot_view(&bot),
                "pending": false,
                "status": "idle",
            }));
        };
        let (conn, bot) = match self.ensure_ready(bot_id).await {
            Ok(pair) => pair,
            Err(_) => {
                return Ok(json!({
                    "bot": self.bot_view(&bot),
                    "pending": true,
                    "status": "unknown",
                    "pendingSubmission": pending,
                }));
            }
        };

        let mut request_read_confirmed_missing = false;
        if conn.supports_method("areal/request/read") {
            match conn
                .request(
                    "areal/request/read",
                    json!({
                        "threadId": pending.thread_id,
                        "requestId": pending.request_id,
                    }),
                )
                .await
            {
                Ok(found)
                    if !found.is_null() && found.get("receipt").is_some_and(|r| !r.is_null()) =>
                {
                    let updated = self.finish_submission_success(bot_id, &pending.preview)?;
                    return Ok(json!({
                        "bot": self.bot_view(&updated),
                        "pending": false,
                        "status": "admitted",
                        "receipt": found["receipt"],
                    }));
                }
                Ok(found) if found.get("found") == Some(&json!(true)) => {
                    let updated = self.finish_submission_success(bot_id, &pending.preview)?;
                    return Ok(json!({
                        "bot": self.bot_view(&updated),
                        "pending": false,
                        "status": "admitted",
                        "receipt": found,
                    }));
                }
                Ok(found) if found.get("found") == Some(&json!(false)) || found.is_null() => {
                    request_read_confirmed_missing = true;
                }
                Ok(_) => {}
                Err(err) if err.is_transport() => {
                    return Ok(json!({
                        "bot": self.bot_view(&bot),
                        "pending": true,
                        "status": "unknown",
                        "pendingSubmission": pending,
                    }));
                }
                Err(_) => {}
            }
        }

        // 用权威线程快照二次核对 receipts 列表。
        let observed = match conn
            .request(
                "areal/thread/observe",
                json!({ "threadId": pending.thread_id }),
            )
            .await
        {
            Ok(val) => val,
            Err(err) if err.is_transport() => {
                return Ok(json!({
                    "bot": self.bot_view(&bot),
                    "pending": true,
                    "status": "unknown",
                    "pendingSubmission": pending,
                }));
            }
            Err(err) => return Err(map_arena_error(err)),
        };

        let thread = observed.get("thread").cloned().unwrap_or(observed);
        let receipts = thread["desktop"]["receipts"].as_array();
        let receipt = receipts.and_then(|list| {
            list.iter()
                .find(|item| item["requestId"].as_str() == Some(pending.request_id.as_str()))
                .cloned()
        });
        if let Some(receipt) = receipt {
            let updated = self.finish_submission_success(bot_id, &pending.preview)?;
            Ok(json!({
                "bot": self.bot_view(&updated),
                "pending": false,
                "status": "admitted",
                "receipt": receipt,
                "thread": thread,
            }))
        } else if request_read_confirmed_missing || receipts.is_some() {
            // 仅在远端给出覆盖原 requestId 的权威回执列表或明确未找到时，才解除未决状态。
            let updated = self.set_pending_submission(bot_id, None)?;
            Ok(json!({
                "bot": self.bot_view(&updated),
                "pending": false,
                "status": "notAdmitted",
                "thread": thread,
            }))
        } else {
            Ok(json!({
                "bot": self.bot_view(&bot),
                "pending": true,
                "status": "unknown",
                "pendingSubmission": pending,
                "thread": thread,
            }))
        }
    }

    pub(crate) async fn interrupt(&self, bot_id: &str) -> Result<Value> {
        let bot = self.find_bot(bot_id)?;
        let Some(conn) = self.active_connection(bot_id) else {
            self.set_active_turn(bot_id, None);
            return Ok(json!({ "interrupted": false, "bot": self.bot_view(&bot) }));
        };
        let Some(thread_id) = bot.active_thread_id.as_deref() else {
            self.set_active_turn(bot_id, None);
            return Ok(json!({ "interrupted": false, "bot": self.bot_view(&bot) }));
        };
        let result = conn
            .request("turn/interrupt", json!({ "threadId": thread_id }))
            .await
            .map_err(map_arena_error)?;
        self.set_active_turn(bot_id, None);
        Ok(json!({
            "interrupted": true,
            "result": result,
            "bot": self.bot_view(&bot),
        }))
    }

    pub(crate) async fn respond_interaction(
        &self,
        bot_id: &str,
        interaction_id: &str,
        response: Value,
    ) -> Result<Value> {
        ensure!(!interaction_id.is_empty(), "INVALID_PARAMS");
        let (conn, bot) = self.ensure_ready(bot_id).await?;
        let thread_id = bot
            .active_thread_id
            .clone()
            .context("Bot thread not initialized")?;
        let turn_id = response["turnId"]
            .as_str()
            .map(str::to_owned)
            .or_else(|| {
                self.sessions
                    .lock()
                    .unwrap()
                    .get(bot_id)
                    .and_then(|s| s.active_turn_id.clone())
            })
            .context("INVALID_PARAMS")?;
        let mut params = json!({
            "requestId": interaction_id,
            "threadId": thread_id,
            "turnId": turn_id,
        });
        if let Some(decision) = response.get("decision") {
            params["decision"] = decision.clone();
        }
        if let Some(answers) = response.get("answers") {
            params["answers"] = answers.clone();
        }
        if let Some(digest) = response.get("argumentsDigest") {
            params["argumentsDigest"] = digest.clone();
        }
        let result = conn
            .request("areal/interaction/respond", params)
            .await
            .map_err(map_arena_error)?;
        Ok(json!({
            "bot": self.bot_view(&bot),
            "result": result,
        }))
    }

    pub(crate) async fn compact(&self, bot_id: &str) -> Result<Value> {
        let (conn, bot) = self.ensure_ready(bot_id).await?;
        let thread_id = bot
            .active_thread_id
            .clone()
            .context("Bot thread not initialized")?;
        let result = conn
            .request("areal/context/compact", json!({ "threadId": thread_id }))
            .await
            .map_err(map_arena_error)?;
        Ok(json!({
            "bot": self.bot_view(&bot),
            "result": result,
        }))
    }

    /// 在同一 UPFS 工作区内开启全新对话 Thread（保留 `/home/workspace/AGENTS.md` 长期记忆）。
    pub(crate) async fn reset_conversation(&self, bot_id: &str) -> Result<Value> {
        let existing = self.find_bot(bot_id)?;
        ensure!(existing.pending_submission.is_none(), "SUBMISSION_PENDING");
        let (conn, _) = self.ensure_ready(bot_id).await?;
        let new_request_id = uuid::Uuid::new_v4().to_string();
        let record = {
            let mut reg = self.registry.lock().unwrap();
            let bot = reg
                .bots
                .iter_mut()
                .find(|b| b.id == bot_id)
                .context("NOT_FOUND")?;
            bot.thread_request_id = new_request_id;
            bot.active_thread_id = None;
            bot.synced_preferences_revision = 0;
            bot.last_message_preview.clear();
            bot.updated_at = now_secs();
            let snapshot = bot.clone();
            reg.revision += 1;
            self.store.save(&reg)?;
            snapshot
        };
        let bot = self.ensure_thread_and_preferences(&conn, record).await?;
        let revision = self.registry.lock().unwrap().revision;
        self.emit(json!({
            "kind": "registryChanged",
            "revision": revision,
        }));
        Ok(json!({
            "revision": revision,
            "bot": self.bot_view(&bot),
        }))
    }

    pub(super) fn find_bot(&self, bot_id: &str) -> Result<BotRecord> {
        self.registry
            .lock()
            .unwrap()
            .bots
            .iter()
            .find(|b| b.id == bot_id)
            .cloned()
            .context("NOT_FOUND")
    }

    fn active_connection(&self, bot_id: &str) -> Option<ArenaConnection> {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.get_mut(bot_id)
            && !session.connection.is_closed()
            && !session.connection.is_draining()
        {
            session.last_used_at = now_secs();
            return Some(session.connection.clone());
        }
        None
    }

    fn session_catalog(&self, bot_id: &str) -> (Vec<Value>, Vec<Value>, Option<ProviderHealth>) {
        let sessions = self.sessions.lock().unwrap();
        match sessions.get(bot_id) {
            Some(session) if !session.connection.is_closed() => (
                session.models.clone(),
                session.providers.clone(),
                Some(session.provider_health.clone()),
            ),
            _ => (Vec::new(), Vec::new(), None),
        }
    }

    async fn ensure_ready(&self, bot_id: &str) -> Result<(ArenaConnection, BotRecord)> {
        loop {
            let bot = self.find_bot(bot_id)?;
            if let Some(conn) = self.active_connection(bot_id) {
                let synced = self.ensure_thread_and_preferences(&conn, bot).await?;
                return Ok((conn, synced));
            }
            // 同一个 Bot 的并发唤醒走单飞（single-flight），避免打开重复 WS 连接。
            let existing_waiter = {
                let mut map = self.waking.lock().unwrap();
                if let Some(notify) = map.get(bot_id) {
                    Some(notify.clone())
                } else {
                    map.insert(bot_id.to_owned(), Arc::new(Notify::new()));
                    None
                }
            };
            if let Some(waiter) = existing_waiter {
                waiter.notified().await;
                if let Some(conn) = self.active_connection(bot_id) {
                    let bot = self.find_bot(bot_id)?;
                    let synced = self.ensure_thread_and_preferences(&conn, bot).await?;
                    return Ok((conn, synced));
                }
                if let BotConnectionState::Error { message } = self.state_of(bot_id) {
                    return Err(anyhow!(message));
                }
                continue;
            }

            let wake_result = self.wake_bot(&bot).await;
            let notify = self.waking.lock().unwrap().remove(bot_id);
            if let Some(notify) = notify {
                notify.notify_waiters();
            }
            return wake_result;
        }
    }

    async fn resync_custom_providers(&self, conn: &ArenaConnection, bot: &BotRecord) {
        if bot.custom_providers.is_empty() || !conn.supports_method("areal/provider/upsert") {
            return;
        }
        let existing_list = conn
            .request("areal/provider/list", json!({}))
            .await
            .ok()
            .and_then(|v| v["data"].as_array().cloned())
            .unwrap_or_default();
        let can_register_creds = conn.supports_method("areal/plugin/credentials/register");
        for custom in &bot.custom_providers {
            if let Some(ref cred_ref) = custom.credential_ref
                && can_register_creds
                && let Ok(Some(secret)) = self.store.load_provider_key(cred_ref)
            {
                let _ = conn
                    .request(
                        "areal/plugin/credentials/register",
                        json!({
                            "credentials": {
                                cred_ref.clone(): secret,
                            }
                        }),
                    )
                    .await;
            }
            let expected = existing_list
                .iter()
                .find(|item| item["id"].as_str() == Some(custom.id.as_str()))
                .and_then(|item| item["revision"].as_u64())
                .unwrap_or(0);
            let mut wire = json!({
                "id": custom.id,
                "revision": expected,
                "endpoint": custom.endpoint,
                "protocol": custom.protocol,
                "models": custom.models,
                "parameters": {},
            });
            if let Some(ref cred_ref) = custom.credential_ref {
                wire["credentialRef"] = json!(cred_ref);
            }
            let _ = conn
                .request(
                    "areal/provider/upsert",
                    json!({
                        "provider": wire,
                        "expectedRevision": expected,
                    }),
                )
                .await;
        }
    }

    async fn wake_bot(&self, bot: &BotRecord) -> Result<(ArenaConnection, BotRecord)> {
        self.set_state(&bot.id, &bot.workspace, BotConnectionState::Waking);
        let arena_cfg = {
            let arena = self.registry.lock().unwrap().arena.clone();
            match self.store.resolve_arena_config(&arena) {
                Ok(cfg) => cfg,
                Err(err) => {
                    self.set_state(
                        &bot.id,
                        &bot.workspace,
                        BotConnectionState::Error {
                            message: err.to_string(),
                        },
                    );
                    return Err(err);
                }
            }
        };
        let ws_url = build_workspace_ws_url(&arena_cfg.ws_base_url, &bot.workspace)?;
        let conn = match ArenaConnection::connect(&ws_url, &arena_cfg.token, self.handshake_timeout)
            .await
        {
            Ok(conn) => conn,
            Err(err) => {
                self.set_state(
                    &bot.id,
                    &bot.workspace,
                    BotConnectionState::Error {
                        message: err.to_string(),
                    },
                );
                return Err(map_arena_error(err));
            }
        };

        self.resync_custom_providers(&conn, bot).await;
        let (models, providers, provider_health) = self.probe_catalog(&conn, bot).await;
        self.evict_lru_if_needed(&bot.id);
        let connection_id = conn.connection_id().to_owned();
        {
            let mut sessions = self.sessions.lock().unwrap();
            sessions.insert(
                bot.id.clone(),
                ActiveSession {
                    connection: conn.clone(),
                    last_used_at: now_secs(),
                    active_turn_id: None,
                    completed_turn_ids: VecDeque::new(),
                    models,
                    providers,
                    provider_health,
                },
            );
        }
        self.spawn_event_pump(
            bot.id.clone(),
            bot.workspace.clone(),
            connection_id,
            conn.clone(),
        );
        let synced = match self.ensure_thread_and_preferences(&conn, bot.clone()).await {
            Ok(record) => record,
            Err(err) => {
                conn.close();
                self.sessions.lock().unwrap().remove(&bot.id);
                self.set_state(
                    &bot.id,
                    &bot.workspace,
                    BotConnectionState::Error {
                        message: err.to_string(),
                    },
                );
                return Err(err);
            }
        };
        self.set_state(&bot.id, &bot.workspace, BotConnectionState::Ready);
        Ok((conn, synced))
    }

    fn evict_lru_if_needed(&self, incoming_bot_id: &str) {
        let victim = {
            let sessions = self.sessions.lock().unwrap();
            if sessions.len() < MAX_ACTIVE_CONNECTIONS {
                None
            } else {
                sessions
                    .iter()
                    .filter(|(id, s)| id.as_str() != incoming_bot_id && s.active_turn_id.is_none())
                    .min_by_key(|(_, s)| s.last_used_at)
                    .map(|(id, _)| id.clone())
            }
        };
        if let Some(victim_id) = victim {
            let _ = self.disconnect(&victim_id);
        }
    }

    async fn probe_catalog(
        &self,
        conn: &ArenaConnection,
        bot: &BotRecord,
    ) -> (Vec<Value>, Vec<Value>, ProviderHealth) {
        let supports_credential_registration =
            conn.supports_method("areal/plugin/credentials/register");
        let models = conn
            .request("areal/model/list", json!({}))
            .await
            .ok()
            .and_then(|v| v["data"].as_array().cloned())
            .unwrap_or_default();
        let providers = conn
            .request("areal/provider/list", json!({}))
            .await
            .ok()
            .and_then(|v| v["data"].as_array().cloned())
            .unwrap_or_default();

        let target_provider_id = bot
            .model_override
            .as_ref()
            .and_then(|m| m.provider_id.clone())
            .filter(|pid| {
                providers
                    .iter()
                    .any(|p| p["id"].as_str() == Some(pid.as_str()))
            })
            .or_else(|| {
                providers
                    .first()
                    .and_then(|p| p["id"].as_str().map(str::to_owned))
            });

        let provider_health = if let Some(pid) = target_provider_id {
            if conn.supports_method("areal/provider/probe") {
                match conn
                    .request_with_timeout(
                        "areal/provider/probe",
                        json!({ "id": pid }),
                        PROBE_TIMEOUT,
                    )
                    .await
                {
                    Ok(probe) => {
                        let model_id = probe["modelId"].as_str().map(str::to_owned);
                        if probe["state"].as_str() == Some("failed") {
                            let err_code = probe["error"].as_str().unwrap_or("API_PROBE_FAILED");
                            let message = if !supports_credential_registration {
                                format!(
                                    "远端模型通道探测失败（{err_code}）：当前 EnvArena 沙箱默认凭据鉴权失败，且该版本暂不支持运行时写入自定义 API Key。"
                                )
                            } else {
                                format!(
                                    "远端模型通道探测失败（{err_code}），请在右侧设置中检查或配置可用 Provider。"
                                )
                            };
                            ProviderHealth {
                                status: "authFailed",
                                provider_id: Some(pid),
                                model_id,
                                message: Some(message),
                                supports_credential_registration,
                            }
                        } else {
                            ProviderHealth {
                                status: "ready",
                                provider_id: Some(pid),
                                model_id,
                                message: None,
                                supports_credential_registration,
                            }
                        }
                    }
                    Err(_) => ProviderHealth {
                        status: "unchecked",
                        provider_id: Some(pid),
                        model_id: None,
                        message: None,
                        supports_credential_registration,
                    },
                }
            } else {
                ProviderHealth {
                    status: "unchecked",
                    provider_id: Some(pid),
                    model_id: None,
                    message: None,
                    supports_credential_registration,
                }
            }
        } else {
            ProviderHealth {
                status: "unavailable",
                provider_id: None,
                model_id: None,
                message: Some("远端沙箱未配置模型 Provider。".into()),
                supports_credential_registration,
            }
        };

        (models, providers, provider_health)
    }

    async fn refresh_catalog(
        &self,
        conn: &ArenaConnection,
        bot: &BotRecord,
    ) -> Result<(Vec<Value>, Vec<Value>, ProviderHealth)> {
        let (models, providers, health) = self.probe_catalog(conn, bot).await;
        {
            let mut sessions = self.sessions.lock().unwrap();
            if let Some(session) = sessions.get_mut(&bot.id) {
                session.models = models.clone();
                session.providers = providers.clone();
                session.provider_health = health.clone();
            }
        }
        Ok((models, providers, health))
    }

    async fn ensure_thread_and_preferences(
        &self,
        conn: &ArenaConnection,
        mut bot: BotRecord,
    ) -> Result<BotRecord> {
        if bot.active_thread_id.is_none() {
            let profile = conn
                .request("areal/profile/list", json!({}))
                .await
                .ok()
                .and_then(|v| v["data"].as_array().and_then(|arr| arr.first()).cloned())
                .and_then(|item| {
                    let id = item["id"].as_str()?;
                    let revision = item["revision"].as_str()?;
                    Some(json!({ "id": id, "revision": revision }))
                });

            let mut params = json!({
                "requestId": bot.thread_request_id,
                "options": build_thread_options(&bot),
            });
            if let Some(profile) = profile {
                params["agentProfile"] = profile;
            }
            if let Some(model_ref) = &bot.model_override
                && let Some(provider_id) = &model_ref.provider_id
            {
                params["model"] = json!({
                    "providerId": provider_id,
                    "modelId": model_ref.model_id,
                });
            }

            let started = conn
                .request("areal/thread/start", params)
                .await
                .map_err(map_arena_error)?;
            let thread_id = started["thread"]["id"]
                .as_str()
                .context("Arena areal/thread/start missing thread.id")?
                .to_owned();

            bot = {
                let mut reg = self.registry.lock().unwrap();
                let entry = reg
                    .bots
                    .iter_mut()
                    .find(|b| b.id == bot.id)
                    .context("NOT_FOUND")?;
                entry.active_thread_id = Some(thread_id);
                entry.synced_preferences_revision = entry.preferences_revision;
                entry.updated_at = now_secs();
                let snapshot = entry.clone();
                self.store.save(&reg)?;
                snapshot
            };
            return Ok(bot);
        }

        if bot.synced_preferences_revision < bot.preferences_revision
            && let Some(thread_id) = bot.active_thread_id.clone()
        {
            self.sync_thread_configuration(conn, &thread_id, &bot)
                .await?;
            bot = self.mark_preferences_synced(&bot.id, bot.preferences_revision)?;
        }
        Ok(bot)
    }

    async fn read_thread_config_revision(
        &self,
        conn: &ArenaConnection,
        thread_id: &str,
    ) -> Result<u64> {
        if conn.supports_method("areal/thread/inspect")
            && let Ok(inspected) = conn
                .request("areal/thread/inspect", json!({ "threadId": thread_id }))
                .await
            && let Some(rev) = inspected["configuration"]["revision"].as_u64()
        {
            return Ok(rev);
        }
        let observed = conn
            .request("areal/thread/observe", json!({ "threadId": thread_id }))
            .await
            .map_err(map_arena_error)?;
        let thread = observed.get("thread").unwrap_or(&observed);
        Ok(thread["desktop"]["configuration"]["revision"]
            .as_u64()
            .or_else(|| thread["configuration"]["revision"].as_u64())
            .unwrap_or(1))
    }

    async fn sync_thread_configuration(
        &self,
        conn: &ArenaConnection,
        thread_id: &str,
        bot: &BotRecord,
    ) -> Result<()> {
        let expected_revision = self.read_thread_config_revision(conn, thread_id).await?;
        let mut params = json!({
            "threadId": thread_id,
            "expectedRevision": expected_revision,
            "requestId": uuid::Uuid::new_v4().to_string(),
            "options": build_thread_options(bot),
        });
        if let Some(model_ref) = &bot.model_override
            && let Some(provider_id) = &model_ref.provider_id
        {
            params["model"] = json!({
                "providerId": provider_id,
                "modelId": model_ref.model_id,
            });
        }
        if bot.model_override.is_none() {
            params["resetModel"] = json!(true);
        }
        conn.request("areal/thread/configure", params)
            .await
            .map_err(map_arena_error)?;
        Ok(())
    }

    fn mark_preferences_synced(&self, bot_id: &str, synced_rev: u64) -> Result<BotRecord> {
        let mut reg = self.registry.lock().unwrap();
        let (changed, snapshot) = {
            let entry = reg
                .bots
                .iter_mut()
                .find(|b| b.id == bot_id)
                .context("NOT_FOUND")?;
            let changed = entry.synced_preferences_revision < synced_rev;
            if changed {
                entry.synced_preferences_revision = synced_rev;
            }
            (changed, entry.clone())
        };
        if changed {
            self.store.save(&reg)?;
        }
        Ok(snapshot)
    }

    fn set_pending_submission(
        &self,
        bot_id: &str,
        pending: Option<PendingSubmission>,
    ) -> Result<BotRecord> {
        let mut reg = self.registry.lock().unwrap();
        let entry = reg
            .bots
            .iter_mut()
            .find(|b| b.id == bot_id)
            .context("NOT_FOUND")?;
        entry.pending_submission = pending;
        entry.updated_at = now_secs();
        let snapshot = entry.clone();
        self.store.save(&reg)?;
        Ok(snapshot)
    }

    fn finish_submission_success(&self, bot_id: &str, preview: &str) -> Result<BotRecord> {
        let mut reg = self.registry.lock().unwrap();
        let entry = reg
            .bots
            .iter_mut()
            .find(|b| b.id == bot_id)
            .context("NOT_FOUND")?;
        entry.pending_submission = None;
        if !preview.is_empty() {
            entry.last_message_preview = truncate_preview(preview);
        }
        let now = now_secs();
        entry.last_active_at = now;
        entry.updated_at = now;
        let snapshot = entry.clone();
        self.store.save(&reg)?;
        Ok(snapshot)
    }

    pub(super) fn update_last_preview(&self, bot_id: &str, text: &str) {
        let preview = truncate_preview(text);
        if preview.is_empty() {
            return;
        }
        let mut reg = self.registry.lock().unwrap();
        if let Some(entry) = reg.bots.iter_mut().find(|b| b.id == bot_id) {
            entry.last_message_preview = preview;
            let now = now_secs();
            entry.last_active_at = now;
            entry.updated_at = now;
            let _ = self.store.save(&reg);
        }
    }

    fn spawn_event_pump(
        &self,
        bot_id: String,
        workspace: String,
        connection_id: String,
        conn: ArenaConnection,
    ) {
        let mut rx = conn.subscribe();
        let service = self.clone();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(notif) => {
                        let is_current = {
                            let sessions = service.sessions.lock().unwrap();
                            sessions
                                .get(&bot_id)
                                .is_some_and(|s| s.connection.connection_id() == connection_id)
                        };
                        if !is_current {
                            break;
                        }
                        if handle_arena_notification(
                            &service,
                            &bot_id,
                            &workspace,
                            &connection_id,
                            notif,
                        ) {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }
}
