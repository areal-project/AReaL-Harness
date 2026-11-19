use super::pool::{
    BotService, ConfigureArenaInput, CreateBotInput, PERSONAL_AGENT_BASE_PROMPT, UpdateBotInput,
};
use super::store::{
    BotModelRef, BotStore, ProviderSyncMode, SystemPromptMode, parse_arena_toml_profile,
    validate_workspace_id,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    net::SocketAddr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    net::TcpListener,
    sync::{broadcast, mpsc},
};
use tokio_tungstenite::tungstenite::Message;

/// 可编程的本地 Mock EnvArena app-server（说标准 `areal.core.v1` JSON-RPC 2.0）。
struct MockArenaState {
    connections: AtomicUsize,
    expected_token: Option<String>,
    handshake_delay_ms: u64,
    probe_auth_failed: AtomicBool,
    supports_credential_registration: AtomicBool,
    drop_on_submit: AtomicBool,
    admit_before_drop: AtomicBool,
    hide_receipts_in_observe: AtomicBool,
    request_read_returns_error: AtomicBool,
    /// workspace -> list of RPC methods received (method, params)
    calls: Mutex<Vec<(String, String, Value)>>,
    /// workspace -> threads (thread_id -> thread json)
    threads: Mutex<BTreeMap<String, Vec<Value>>>,
    /// (thread_id, request_id) -> receipt
    receipts: Mutex<HashMap<(String, String), Value>>,
    /// active server push channels per workspace
    push_tx: broadcast::Sender<(String, Value)>,
    next_thread_seq: AtomicUsize,
    next_turn_seq: AtomicUsize,
}

impl MockArenaState {
    fn new() -> Arc<Self> {
        let (push_tx, _) = broadcast::channel(128);
        Arc::new(Self {
            connections: AtomicUsize::new(0),
            expected_token: Some("test-arena-token".into()),
            handshake_delay_ms: 0,
            probe_auth_failed: AtomicBool::new(false),
            supports_credential_registration: AtomicBool::new(false),
            drop_on_submit: AtomicBool::new(false),
            admit_before_drop: AtomicBool::new(false),
            hide_receipts_in_observe: AtomicBool::new(false),
            request_read_returns_error: AtomicBool::new(false),
            calls: Mutex::new(Vec::new()),
            threads: Mutex::new(BTreeMap::new()),
            receipts: Mutex::new(HashMap::new()),
            push_tx,
            next_thread_seq: AtomicUsize::new(1),
            next_turn_seq: AtomicUsize::new(1),
        })
    }

    fn calls_for(&self, method: &str) -> Vec<(String, Value)> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, m, _)| m == method)
            .map(|(ws, _, p)| (ws.clone(), p.clone()))
            .collect()
    }

    fn push_notification(&self, workspace: &str, method: &str, params: Value) {
        let _ = self.push_tx.send((
            workspace.to_owned(),
            json!({
                "jsonrpc": "2.0",
                "method": method,
                "params": params,
            }),
        ));
    }
}

async fn start_mock_arena(state: Arc<MockArenaState>) -> (String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr: SocketAddr = listener.local_addr().unwrap();
    let base_url = format!("ws://{addr}/arena/v1/app-server");
    let handle = tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let state = state.clone();
            tokio::spawn(async move {
                let mut workspace = String::new();
                let mut auth_ok = true;
                let expected = state.expected_token.clone();
                let ws = tokio_tungstenite::accept_hdr_async(
                    stream,
                    |req: &tokio_tungstenite::tungstenite::handshake::server::Request,
                     resp: tokio_tungstenite::tungstenite::handshake::server::Response| {
                        let path = req.uri().path();
                        workspace = path
                            .trim_end_matches('/')
                            .rsplit('/')
                            .next()
                            .unwrap_or("unknown")
                            .to_owned();
                        if let Some(ref exp) = expected {
                            let header = req
                                .headers()
                                .get("authorization")
                                .and_then(|v| v.to_str().ok())
                                .unwrap_or("");
                            if header != format!("Bearer {exp}") {
                                auth_ok = false;
                            }
                        }
                        Ok(resp)
                    },
                )
                .await;
                let Ok(ws) = ws else {
                    return;
                };
                if !auth_ok {
                    return;
                }
                if state.handshake_delay_ms > 0 {
                    tokio::time::sleep(Duration::from_millis(state.handshake_delay_ms)).await;
                }
                state.connections.fetch_add(1, Ordering::SeqCst);
                let (mut sink, mut stream) = ws.split();
                let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
                let mut push_rx = state.push_tx.subscribe();
                let ws_for_push = workspace.clone();
                let out_tx_push = out_tx.clone();
                let push_task = tokio::spawn(async move {
                    while let Ok((target_ws, payload)) = push_rx.recv().await {
                        if target_ws == ws_for_push || target_ws == "*" {
                            let _ = out_tx_push.send(payload.to_string());
                        }
                    }
                });
                let write_task = tokio::spawn(async move {
                    while let Some(text) = out_rx.recv().await {
                        if sink.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                });

                while let Some(Ok(frame)) = stream.next().await {
                    let Message::Text(text) = frame else {
                        if matches!(frame, Message::Close(_)) {
                            break;
                        }
                        continue;
                    };
                    let Ok(msg) = serde_json::from_str::<Value>(&text) else {
                        continue;
                    };
                    let Some(method) = msg["method"].as_str() else {
                        continue;
                    };
                    let id = msg.get("id").cloned();
                    let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));
                    state.calls.lock().unwrap().push((
                        workspace.clone(),
                        method.to_owned(),
                        params.clone(),
                    ));

                    let Some(id) = id else {
                        // Notification (e.g. initialized)
                        continue;
                    };

                    let mut should_drop = false;
                    let response = handle_mock_rpc(
                        &state,
                        &workspace,
                        method,
                        &params,
                        &out_tx,
                        &mut should_drop,
                    );
                    if should_drop {
                        break;
                    }
                    let envelope = match response {
                        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                        Err((code, message)) => json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": { "code": code, "message": message },
                        }),
                    };
                    let _ = out_tx.send(envelope.to_string());
                }
                push_task.abort();
                drop(out_tx);
                let _ = write_task.await;
            });
        }
    });
    (base_url, handle)
}

fn handle_mock_rpc(
    state: &MockArenaState,
    workspace: &str,
    method: &str,
    params: &Value,
    out_tx: &mpsc::UnboundedSender<String>,
    should_drop: &mut bool,
) -> std::result::Result<Value, (i64, String)> {
    match method {
        "initialize" => Ok(json!({ "userAgent": "mock-arena/0.1" })),
        "areal/capabilities" => {
            let mut methods = vec![
                "areal/capabilities",
                "areal/profile/list",
                "areal/model/list",
                "areal/provider/list",
                "areal/provider/probe",
                "areal/provider/upsert",
                "areal/thread/start",
                "areal/thread/inspect",
                "areal/thread/configure",
                "areal/thread/observe",
                "areal/turn/submit",
                "areal/request/read",
                "turn/interrupt",
                "areal/interaction/respond",
                "areal/context/compact",
                "thread/list",
            ];
            if state
                .supports_credential_registration
                .load(Ordering::SeqCst)
            {
                methods.push("areal/plugin/credentials/register");
            }
            Ok(json!({
                "apiVersion": "areal.core.v1",
                "version": "0.1.7-mock",
                "methods": methods,
            }))
        }
        "areal/plugin/credentials/register" => {
            if !state
                .supports_credential_registration
                .load(Ordering::SeqCst)
            {
                return Err((
                    -32602,
                    "workgroups require a trusted deployment policy".into(),
                ));
            }
            Ok(json!({ "ok": true }))
        }
        "areal/model/list" => Ok(json!({
            "data": [
                {
                    "id": "arena/mock-flash",
                    "providerId": "arena",
                    "modelId": "mock-flash",
                    "displayName": "Mock Flash"
                }
            ]
        })),
        "areal/provider/list" => Ok(json!({
            "data": [
                {
                    "id": "arena",
                    "revision": 1,
                    "endpoint": "https://mock.arena.local/v1/chat/completions",
                    "protocol": "chatCompletions",
                    "models": ["mock-flash"],
                    "credentialRef": "ARENA_MODEL_API_KEY",
                    "credentialState": "available",
                    "connectionState": "unchecked"
                }
            ]
        })),
        "areal/provider/probe" => {
            if state.probe_auth_failed.load(Ordering::SeqCst) {
                Ok(json!({
                    "state": "failed",
                    "error": "API_PROBE_FAILED",
                    "modelId": "mock-flash"
                }))
            } else {
                Ok(json!({
                    "state": "connected",
                    "modelId": "mock-flash",
                    "latencyMs": 12
                }))
            }
        }
        "areal/provider/upsert" => {
            if params["provider"]["id"].as_str() == Some("arena") {
                return Err((
                    -32602,
                    "CONFIGURATION_MANAGED: edit the shared model configuration".into(),
                ));
            }
            state.probe_auth_failed.store(false, Ordering::SeqCst);
            Ok(json!({ "ok": true, "provider": params["provider"] }))
        }
        "thread/list" => {
            let threads = state
                .threads
                .lock()
                .unwrap()
                .get(workspace)
                .cloned()
                .unwrap_or_default();
            Ok(json!({ "data": threads }))
        }
        "areal/thread/start" => {
            let seq = state.next_thread_seq.fetch_add(1, Ordering::SeqCst);
            let tid = format!("thr-{workspace}-{seq}");
            let thread = json!({
                "id": tid,
                "workspace": workspace,
                "options": params["options"],
                "turns": [],
                "desktop": { "receipts": [], "configuration": { "revision": 1 } }
            });
            state
                .threads
                .lock()
                .unwrap()
                .entry(workspace.to_owned())
                .or_default()
                .push(thread.clone());
            Ok(json!({ "thread": thread }))
        }
        "areal/thread/inspect" => Ok(json!({
            "threadId": params["threadId"],
            "configuration": { "revision": 1 },
        })),
        "areal/thread/configure" => {
            let Some(expected_rev) = params["expectedRevision"].as_u64() else {
                return Err((-32602, "missing field `expectedRevision`".into()));
            };
            Ok(json!({
                "threadId": params["threadId"],
                "revision": expected_rev + 1,
                "options": params["options"],
            }))
        }
        "areal/thread/observe" => {
            let tid = params["threadId"].as_str().unwrap_or("");
            let receipts: Vec<Value> = state
                .receipts
                .lock()
                .unwrap()
                .iter()
                .filter(|((t, _), _)| t == tid)
                .map(|(_, v)| v.clone())
                .collect();
            let desktop = if state.hide_receipts_in_observe.load(Ordering::SeqCst) {
                json!({ "configuration": { "revision": 1 } })
            } else {
                json!({ "receipts": receipts, "configuration": { "revision": 1 } })
            };
            Ok(json!({
                "thread": {
                    "id": tid,
                    "turns": [],
                    "desktop": desktop
                }
            }))
        }
        "areal/turn/submit" => {
            if params["expectedConfigRevision"].as_u64().is_none() {
                return Err((-32602, "missing field `expectedConfigRevision`".into()));
            }
            if params["intent"]["type"].as_str() != Some("message") {
                return Err((-32602, "missing field `intent`".into()));
            }
            let tid = params["threadId"].as_str().unwrap_or("").to_owned();
            let rid = params["requestId"].as_str().unwrap_or("").to_owned();
            let turn_seq = state.next_turn_seq.fetch_add(1, Ordering::SeqCst);
            let turn_id = format!("turn-{turn_seq}");
            let receipt = json!({
                "requestId": rid,
                "threadId": tid,
                "turn": { "id": turn_id },
                "status": "admitted"
            });
            if state.drop_on_submit.load(Ordering::SeqCst) {
                if state.admit_before_drop.load(Ordering::SeqCst) {
                    state.receipts.lock().unwrap().insert((tid, rid), receipt);
                }
                *should_drop = true;
                return Ok(Value::Null);
            }
            state
                .receipts
                .lock()
                .unwrap()
                .insert((tid.clone(), rid), receipt.clone());

            // 模拟异步流式推送，不阻塞本次回执返回
            let out_tx = out_tx.clone();
            let tid_push = tid.clone();
            let turn_push = turn_id.clone();
            let user_text = params["intent"]["input"][0]["text"]
                .as_str()
                .unwrap_or("ok")
                .to_owned();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(15)).await;
                let reply = format!("Echo: {user_text}");
                let frames = vec![
                    json!({"jsonrpc":"2.0","method":"turn/started","params":{"threadId":tid_push,"turn":{"id":turn_push}}}),
                    json!({"jsonrpc":"2.0","method":"item/started","params":{"threadId":tid_push,"turnId":turn_push,"item":{"id":"item-1","type":"agentMessage"}}}),
                    json!({"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"threadId":tid_push,"turnId":turn_push,"itemId":"item-1","delta":reply}}),
                    json!({"jsonrpc":"2.0","method":"item/completed","params":{"threadId":tid_push,"turnId":turn_push,"item":{"id":"item-1","type":"agentMessage","text":reply}}}),
                    json!({"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":tid_push,"turn":{"id":turn_push,"status":"completed"}}}),
                ];
                for f in frames {
                    let _ = out_tx.send(f.to_string());
                }
            });
            Ok(receipt)
        }
        "areal/request/read" => {
            if state.request_read_returns_error.load(Ordering::SeqCst) {
                return Err((-32603, "internal error".into()));
            }
            let tid = params["threadId"].as_str().unwrap_or("").to_owned();
            let rid = params["requestId"].as_str().unwrap_or("").to_owned();
            if let Some(receipt) = state.receipts.lock().unwrap().get(&(tid, rid)).cloned() {
                Ok(json!({ "found": true, "receipt": receipt }))
            } else {
                Ok(json!({ "found": false, "receipt": Value::Null }))
            }
        }
        "turn/interrupt" => Ok(json!({ "interrupted": true })),
        "areal/interaction/respond" => {
            if params["requestId"].as_str().is_none()
                || params["threadId"].as_str().is_none()
                || params["turnId"].as_str().is_none()
            {
                return Err((-32602, "missing interaction respond fields".into()));
            }
            Ok(json!({ "resolved": true }))
        }
        "areal/context/compact" => Ok(json!({ "compacted": true })),
        _ => Err((-32601, format!("method not found: {method}"))),
    }
}

fn new_test_service(base_url: &str, token: Option<&str>) -> (tempfile::TempDir, BotService) {
    let dir = tempfile::tempdir().unwrap();
    let store = BotStore::with_arena_config_path(dir.path(), None);
    let service = BotService::load_with_timeout(store, Duration::from_secs(5)).unwrap();
    service
        .configure_arena(ConfigureArenaInput {
            base_url: Some(Some(base_url.to_owned())),
            profile: None,
            token: token.map(str::to_owned),
            clear_token: false,
        })
        .unwrap();
    (dir, service)
}

#[test]
fn store_credentials_isolation_toml_and_validation() {
    let dir = tempfile::tempdir().unwrap();
    let store = BotStore::with_arena_config_path(dir.path(), None);
    let service = BotService::load(store).unwrap();

    service
        .configure_arena(ConfigureArenaInput {
            base_url: Some(Some("wss://arena.example.test/v1/app-server/".into())),
            profile: None,
            token: Some("super-secret-token-xyz".into()),
            clear_token: false,
        })
        .unwrap();

    // Token 绝不可出现在公开设置或 registry.json 中
    let settings = service.settings().unwrap();
    assert!(settings.ready);
    assert!(settings.has_token);
    let settings_json = serde_json::to_string(&settings).unwrap();
    assert!(!settings_json.contains("super-secret-token-xyz"));

    let registry_raw = std::fs::read_to_string(dir.path().join("bots/registry.json")).unwrap();
    assert!(!registry_raw.contains("super-secret-token-xyz"));
    let creds_raw = std::fs::read_to_string(dir.path().join("bots/credentials.json")).unwrap();
    assert!(creds_raw.contains("super-secret-token-xyz"));

    // Clear token
    service
        .configure_arena(ConfigureArenaInput {
            base_url: None,
            profile: None,
            token: None,
            clear_token: true,
        })
        .unwrap();
    assert!(!service.settings().unwrap().has_token);
    assert!(!service.settings().unwrap().ready);

    // TOML parser handles sections, comments, quotes
    let toml = r#"
[dev]
base_url = "https://dev.example.test/api"
token = "dev-tok"

[prod]
# comment
baseurl = "https://prod.example.test/arena/v1/app-server"
token = "prod-tok"
"#;
    let (prod_url, prod_tok) = parse_arena_toml_profile(toml, "prod").unwrap();
    assert_eq!(prod_url, "https://prod.example.test/arena/v1/app-server");
    assert_eq!(prod_tok, "prod-tok");
    let (_, dev_tok) = parse_arena_toml_profile(toml, "dev").unwrap();
    assert_eq!(dev_tok, "dev-tok");

    // Workspace validator rejects traversal & invalid characters
    assert!(validate_workspace_id("bot-weekly_1").is_ok());
    assert!(validate_workspace_id("../etc").is_err());
    assert!(validate_workspace_id("-leading-dash").is_err());
    assert!(validate_workspace_id("has space").is_err());
    assert!(validate_workspace_id("").is_err());
    assert!(validate_workspace_id(&"a".repeat(65)).is_err());

    // CRUD + optimistic concurrency
    let created = service
        .create(CreateBotInput {
            name: "周报助手".into(),
            avatar: Some("📝".into()),
            description: Some("整理周报".into()),
            workspace: Some("weekly-helper".into()),
            starter_prompts: vec!["汇总本周进展".into()],
            system_prompt_mode: SystemPromptMode::PersonalAgent,
            preferences: "用中文要点输出".into(),
            model_override: None,
            provider_sync_mode: ProviderSyncMode::Auto,
        })
        .unwrap();
    let bot_id = created["bot"]["id"].as_str().unwrap().to_owned();
    let rev = created["revision"].as_u64().unwrap();
    assert_eq!(created["bot"]["workspace"], "weekly-helper");

    // Duplicate workspace rejected
    assert!(
        service
            .create(CreateBotInput {
                name: "重复".into(),
                avatar: None,
                description: None,
                workspace: Some("weekly-helper".into()),
                starter_prompts: vec![],
                system_prompt_mode: SystemPromptMode::PersonalAgent,
                preferences: String::new(),
                model_override: None,
                provider_sync_mode: ProviderSyncMode::Auto,
            })
            .is_err()
    );

    // Wrong expectedRevision rejected on remove
    let err = service.remove(&bot_id, Some(rev + 99)).unwrap_err();
    assert_eq!(err.to_string(), "TARGET_CHANGED");

    service.remove(&bot_id, Some(rev)).unwrap();
    assert_eq!(service.list().unwrap()["bots"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn wake_single_flight_prompt_injection_and_provider_health() {
    let mut state = MockArenaState::new();
    Arc::get_mut(&mut state).unwrap().handshake_delay_ms = 60;
    state.probe_auth_failed.store(true, Ordering::SeqCst);
    let (base_url, server) = start_mock_arena(state.clone()).await;
    let (_dir, service) = new_test_service(&base_url, Some("test-arena-token"));

    let created = service
        .create(CreateBotInput {
            name: "日程助手".into(),
            avatar: None,
            description: None,
            workspace: Some("calendar-bot".into()),
            starter_prompts: vec![],
            system_prompt_mode: SystemPromptMode::PersonalAgent,
            preferences: "偏好上午安排深度工作".into(),
            model_override: None,
            provider_sync_mode: ProviderSyncMode::Auto,
        })
        .unwrap();
    let bot_id = created["bot"]["id"].as_str().unwrap().to_owned();

    // 4 个并发 connect 必须合并为 1 次 WS 建连
    let (r1, r2, r3, r4) = tokio::join!(
        service.connect(&bot_id),
        service.connect(&bot_id),
        service.connect(&bot_id),
        service.connect(&bot_id),
    );
    let res = r1.unwrap();
    assert!(r2.is_ok() && r3.is_ok() && r4.is_ok());
    assert_eq!(state.connections.load(Ordering::SeqCst), 1);

    // 验证 Personal Agent systemPrompt 与 appendInstructions 均注入到了 areal/thread/start
    let starts = state.calls_for("areal/thread/start");
    assert_eq!(starts.len(), 1);
    assert_eq!(
        starts[0].1["options"]["systemPrompt"],
        json!(PERSONAL_AGENT_BASE_PROMPT)
    );
    assert_eq!(
        starts[0].1["options"]["appendInstructions"],
        json!("偏好上午安排深度工作")
    );

    // 探测 401 应准确上报 authFailed
    assert_eq!(res["providerHealth"]["status"], "authFailed");
    assert_eq!(
        res["providerHealth"]["supportsCredentialRegistration"],
        false
    );

    // 尝试覆盖受管内置 arena provider 应返回 PROVIDER_MANAGED
    let managed_err = service
        .upsert_provider(
            &bot_id,
            json!({
                "id": "arena",
                "baseUrl": "https://custom.local/v1",
                "protocol": "responses",
                "models": ["gpt-6.1-terra"]
            }),
            None,
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(managed_err.to_string(), "PROVIDER_MANAGED");

    // 远端不支持 areal/plugin/credentials/register 时，传入 apiKey 必须诚实报错 REMOTE_CREDENTIAL_UNSUPPORTED
    let cred_err = service
        .upsert_provider(
            &bot_id,
            json!({
                "id": "custom",
                "baseUrl": "https://custom.local/v1",
                "protocol": "responses",
                "apiKey": "secret-token-value",
                "models": ["gpt-6.1-terra"]
            }),
            None,
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(cred_err.to_string(), "REMOTE_CREDENTIAL_UNSUPPORTED");

    // 调用 upsertProvider（无自定义 apiKey）应将 baseUrl 规范化为 /responses，热同步 modelOverride 并返回 bot
    let upserted = service
        .upsert_provider(
            &bot_id,
            json!({
                "id": "custom",
                "baseUrl": "https://custom.local/v1",
                "apiStyle": "openai-responses"
            }),
            None,
            Some(BotModelRef {
                provider_id: Some("custom".into()),
                model_id: "gpt-6.1-terra".into(),
            }),
        )
        .await
        .unwrap();
    assert_eq!(upserted["providerHealth"]["status"], "ready");
    assert_eq!(upserted["bot"]["id"], bot_id);
    assert_eq!(upserted["bot"]["modelOverride"]["providerId"], "custom");
    assert_eq!(upserted["bot"]["modelOverride"]["modelId"], "gpt-6.1-terra");
    let upsert_calls = state.calls_for("areal/provider/upsert");
    let last_wire = &upsert_calls.last().unwrap().1["provider"];
    assert_eq!(last_wire["endpoint"], "https://custom.local/v1/responses");
    assert_eq!(last_wire["protocol"], "responses");
    assert_eq!(last_wire["models"], json!(["gpt-6.1-terra"]));

    server.abort();
}

#[tokio::test]
async fn dynamic_preferences_hot_sync_sleeping_and_ready() {
    let state = MockArenaState::new();
    let (base_url, server) = start_mock_arena(state.clone()).await;
    let (_dir, service) = new_test_service(&base_url, Some("test-arena-token"));

    let created = service
        .create(CreateBotInput {
            name: "写作助手".into(),
            avatar: None,
            description: None,
            workspace: Some("writer-bot".into()),
            starter_prompts: vec![],
            system_prompt_mode: SystemPromptMode::PersonalAgent,
            preferences: "第一版偏好".into(),
            model_override: None,
            provider_sync_mode: ProviderSyncMode::Auto,
        })
        .unwrap();
    let bot_id = created["bot"]["id"].as_str().unwrap().to_owned();

    // 首次 connect 创建线程并同步 v1
    service.connect(&bot_id).await.unwrap();
    assert_eq!(state.calls_for("areal/thread/configure").len(), 0);

    // Ready 状态直接更新偏好 -> 立即触发 areal/thread/configure
    let updated = service
        .update(UpdateBotInput {
            id: bot_id.clone(),
            expected_revision: None,
            name: None,
            avatar: None,
            description: None,
            starter_prompts: None,
            system_prompt_mode: None,
            preferences: Some("第二版偏好：短句输出".into()),
            model_override: None,
            provider_sync_mode: None,
        })
        .await
        .unwrap();
    assert_eq!(updated["bot"]["preferencesDirty"], false);
    let configs = state.calls_for("areal/thread/configure");
    assert_eq!(configs.len(), 1);
    assert_eq!(
        configs[0].1["options"]["appendInstructions"],
        json!("第二版偏好：短句输出")
    );

    // 断开进入 Sleeping 后修改偏好 -> 标脏，不立刻建连
    service.disconnect(&bot_id).unwrap();
    let dirty = service
        .update(UpdateBotInput {
            id: bot_id.clone(),
            expected_revision: None,
            name: None,
            avatar: None,
            description: None,
            starter_prompts: None,
            system_prompt_mode: None,
            preferences: Some("第三版偏好：英文回复".into()),
            model_override: None,
            provider_sync_mode: None,
        })
        .await
        .unwrap();
    assert_eq!(dirty["bot"]["preferencesDirty"], true);
    assert_eq!(state.calls_for("areal/thread/configure").len(), 1);

    // 下次 observe 唤醒时自动补同步 areal/thread/configure
    let observed = service.observe(&bot_id).await.unwrap();
    assert_eq!(observed["bot"]["preferencesDirty"], false);
    let configs = state.calls_for("areal/thread/configure");
    assert_eq!(configs.len(), 2);
    assert_eq!(
        configs[1].1["options"]["appendInstructions"],
        json!("第三版偏好：英文回复")
    );

    server.abort();
}

#[tokio::test]
async fn send_streaming_events_preview_and_control_ops() {
    let state = MockArenaState::new();
    let (base_url, server) = start_mock_arena(state.clone()).await;
    let (_dir, service) = new_test_service(&base_url, Some("test-arena-token"));

    let created = service
        .create(CreateBotInput {
            name: "测试助手".into(),
            avatar: None,
            description: None,
            workspace: Some("stream-bot".into()),
            starter_prompts: vec![],
            system_prompt_mode: SystemPromptMode::PersonalAgent,
            preferences: String::new(),
            model_override: None,
            provider_sync_mode: ProviderSyncMode::Auto,
        })
        .unwrap();
    let bot_id = created["bot"]["id"].as_str().unwrap().to_owned();
    let mut rx = service.subscribe_events();

    let sent = service
        .send(
            &bot_id,
            vec![json!({"type": "text", "text": "你好 Bot"})],
            "req-stream-1",
        )
        .await
        .unwrap();
    assert_eq!(sent["admissionState"], "accepted");
    assert_eq!(sent["submissionUnknown"], false);

    // 收集流式事件直到 turnCompleted
    let mut kinds = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    while tokio::time::Instant::now() < deadline {
        if let Ok(Ok(ev)) = tokio::time::timeout(Duration::from_millis(500), rx.recv()).await {
            if ev["botId"].as_str() == Some(&bot_id) {
                let kind = ev["kind"].as_str().unwrap_or("").to_owned();
                kinds.push(kind.clone());
                if kind == "turnCompleted" {
                    break;
                }
            }
        }
    }
    assert!(kinds.contains(&"turnStarted".to_owned()), "kinds={kinds:?}");
    assert!(
        kinds.contains(&"messageDelta".to_owned()),
        "kinds={kinds:?}"
    );
    assert!(
        kinds.contains(&"itemCompleted".to_owned()),
        "kinds={kinds:?}"
    );
    assert!(
        kinds.contains(&"turnCompleted".to_owned()),
        "kinds={kinds:?}"
    );

    // 摘要应更新为 Agent 回复
    let detail = service.get(&bot_id).unwrap();
    assert_eq!(detail["bot"]["lastMessagePreview"], "Echo: 你好 Bot");
    let first_thread = detail["bot"]["activeThreadId"].as_str().unwrap().to_owned();

    // interrupt / respondInteraction / compact / resetConversation
    assert_eq!(
        service.interrupt(&bot_id).await.unwrap()["interrupted"],
        true
    );
    service
        .respond_interaction(
            &bot_id,
            "int-1",
            json!({"turnId": "turn-1", "decision": "approve"}),
        )
        .await
        .unwrap();
    service.compact(&bot_id).await.unwrap();
    let reset = service.reset_conversation(&bot_id).await.unwrap();
    let second_thread = reset["bot"]["activeThreadId"].as_str().unwrap().to_owned();
    assert_ne!(first_thread, second_thread);
    assert_eq!(reset["bot"]["workspace"], "stream-bot");

    server.abort();
}

#[tokio::test]
async fn unknown_submission_never_replays_and_reconciles_authoritatively() {
    let state = MockArenaState::new();
    let (base_url, server) = start_mock_arena(state.clone()).await;
    let (_dir, service) = new_test_service(&base_url, Some("test-arena-token"));

    let created = service
        .create(CreateBotInput {
            name: "可靠性助手".into(),
            avatar: None,
            description: None,
            workspace: Some("reconcile-bot".into()),
            starter_prompts: vec![],
            system_prompt_mode: SystemPromptMode::PersonalAgent,
            preferences: String::new(),
            model_override: None,
            provider_sync_mode: ProviderSyncMode::Auto,
        })
        .unwrap();
    let bot_id = created["bot"]["id"].as_str().unwrap().to_owned();

    // Case A: 远端受理后立刻断连 -> UNKNOWN，不得重放，reconcile 后收敛为 admitted
    state.drop_on_submit.store(true, Ordering::SeqCst);
    state.admit_before_drop.store(true, Ordering::SeqCst);
    let unknown = service
        .send(
            &bot_id,
            vec![json!({"type": "text", "text": "转账 100"})],
            "req-unknown-a",
        )
        .await
        .unwrap();
    assert_eq!(unknown["admissionState"], "unknown");
    assert_eq!(unknown["submissionUnknown"], true);
    assert_eq!(state.calls_for("areal/turn/submit").len(), 1);

    // 同一 requestId + 相同内容再次 send：直接返回 unknown，绝不重发 RPC
    let same = service
        .send(
            &bot_id,
            vec![json!({"type": "text", "text": "转账 100"})],
            "req-unknown-a",
        )
        .await
        .unwrap();
    assert_eq!(same["admissionState"], "unknown");
    assert_eq!(state.calls_for("areal/turn/submit").len(), 1);

    // 不同内容 send：必须被 SUBMISSION_PENDING 拦住
    let blocked = service
        .send(
            &bot_id,
            vec![json!({"type": "text", "text": "另一条消息"})],
            "req-other",
        )
        .await
        .unwrap_err();
    assert_eq!(blocked.to_string(), "SUBMISSION_PENDING");

    // reconcile 查回执 -> admitted 并解除 pendingSubmission
    state.drop_on_submit.store(false, Ordering::SeqCst);
    let rec_a = service.reconcile(&bot_id).await.unwrap();
    assert_eq!(rec_a["status"], "admitted");
    assert_eq!(rec_a["pending"], false);
    assert!(service.get(&bot_id).unwrap()["bot"]["pendingSubmission"].is_null());

    // Case B: 远端未受理即断连，且 observe 缺少权威 receipts 且 request/read 失败 -> 保持 unknown
    state.drop_on_submit.store(true, Ordering::SeqCst);
    state.admit_before_drop.store(false, Ordering::SeqCst);
    let _ = service
        .send(
            &bot_id,
            vec![json!({"type": "text", "text": "测试未受理"})],
            "req-unknown-b",
        )
        .await
        .unwrap();
    state.drop_on_submit.store(false, Ordering::SeqCst);
    state
        .request_read_returns_error
        .store(true, Ordering::SeqCst);
    state.hide_receipts_in_observe.store(true, Ordering::SeqCst);
    let rec_still_unknown = service.reconcile(&bot_id).await.unwrap();
    assert_eq!(rec_still_unknown["status"], "unknown");
    assert_eq!(rec_still_unknown["pending"], true);

    // 恢复权威证据 -> reconcile 明确收敛为 notAdmitted
    state
        .request_read_returns_error
        .store(false, Ordering::SeqCst);
    state
        .hide_receipts_in_observe
        .store(false, Ordering::SeqCst);
    let rec_b = service.reconcile(&bot_id).await.unwrap();
    assert_eq!(rec_b["status"], "notAdmitted");
    assert_eq!(rec_b["pending"], false);

    server.abort();
}

#[tokio::test]
async fn draining_transitions_to_sleeping_and_auto_wakes_on_next_send() {
    let state = MockArenaState::new();
    let (base_url, server) = start_mock_arena(state.clone()).await;
    let (_dir, service) = new_test_service(&base_url, Some("test-arena-token"));

    let created = service
        .create(CreateBotInput {
            name: "休眠测试".into(),
            avatar: None,
            description: None,
            workspace: Some("drain-bot".into()),
            starter_prompts: vec![],
            system_prompt_mode: SystemPromptMode::PersonalAgent,
            preferences: String::new(),
            model_override: None,
            provider_sync_mode: ProviderSyncMode::Auto,
        })
        .unwrap();
    let bot_id = created["bot"]["id"].as_str().unwrap().to_owned();
    let mut rx = service.subscribe_events();

    service.connect(&bot_id).await.unwrap();
    assert_eq!(
        service.get(&bot_id).unwrap()["bot"]["connectionState"]["kind"],
        "ready"
    );
    assert_eq!(state.connections.load(Ordering::SeqCst), 1);

    // 模拟 Arena 发送 areal/server/draining
    state.push_notification(
        "drain-bot",
        "areal/server/draining",
        json!({ "reason": "idle" }),
    );

    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    let mut saw_sleeping = false;
    while tokio::time::Instant::now() < deadline {
        if let Ok(Ok(ev)) = tokio::time::timeout(Duration::from_millis(200), rx.recv()).await {
            if ev["kind"] == "stateChanged"
                && ev["botId"] == bot_id
                && ev["state"]["kind"] == "sleeping"
            {
                saw_sleeping = true;
                break;
            }
        }
    }
    assert!(
        saw_sleeping,
        "expected draining to transition bot to sleeping"
    );

    // 下次 send 自动重新建连并成功
    let sent = service
        .send(
            &bot_id,
            vec![json!({"type": "text", "text": "醒来干活"})],
            "req-after-drain",
        )
        .await
        .unwrap();
    assert_eq!(sent["admissionState"], "accepted");
    assert_eq!(state.connections.load(Ordering::SeqCst), 2);

    server.abort();
}

#[tokio::test]
async fn lru_eviction_preserves_bot_with_active_turn() {
    let state = MockArenaState::new();
    let (base_url, server) = start_mock_arena(state.clone()).await;
    let (_dir, service) = new_test_service(&base_url, Some("test-arena-token"));

    let mut ids = Vec::new();
    for i in 1..=6 {
        let created = service
            .create(CreateBotInput {
                name: format!("Bot {i}"),
                avatar: None,
                description: None,
                workspace: Some(format!("pool-bot-{i}")),
                starter_prompts: vec![],
                system_prompt_mode: SystemPromptMode::PersonalAgent,
                preferences: String::new(),
                model_override: None,
                provider_sync_mode: ProviderSyncMode::Auto,
            })
            .unwrap();
        ids.push(created["bot"]["id"].as_str().unwrap().to_owned());
    }

    // 依次连接前 5 个 Bot（填满连接池上限 5）
    for id in &ids[..5] {
        service.connect(id).await.unwrap();
    }
    // 标记 Bot 1 正在运行 turn（未结束）
    state.push_notification(
        "pool-bot-1",
        "turn/started",
        json!({ "turn": { "id": "busy-turn-1" } }),
    );
    tokio::time::sleep(Duration::from_millis(40)).await;
    assert_eq!(
        service.get(&ids[0]).unwrap()["bot"]["activeTurnId"],
        json!("busy-turn-1")
    );

    // 连接第 6 个 Bot，应驱逐某个空闲 Bot，而绝不能驱逐正在跑 turn 的 Bot 1
    service.connect(&ids[5]).await.unwrap();
    assert_eq!(
        service.get(&ids[0]).unwrap()["bot"]["connectionState"]["kind"],
        "ready"
    );
    assert_eq!(
        service.get(&ids[5]).unwrap()["bot"]["connectionState"]["kind"],
        "ready"
    );

    let sleeping_idle = ids[1..5]
        .iter()
        .filter(|id| service.get(id).unwrap()["bot"]["connectionState"]["kind"] == "sleeping")
        .count();
    assert_eq!(sleeping_idle, 1, "expected exactly 1 idle bot evicted");

    server.abort();
}

#[tokio::test(flavor = "current_thread")]
async fn host_gateway_validates_fields_and_propagates_unknown_admission() {
    let state = MockArenaState::new();
    let (base_url, server) = start_mock_arena(state.clone()).await;
    let dir = tempfile::tempdir().unwrap();
    let host = crate::server::schedules::tests::fixture(dir.path());

    // 未知字段必须被拒绝
    let bad = super::gateway(
        &host,
        "bots.read",
        &json!({"params": {"operation": "list", "unexpectedField": 1}}),
    )
    .await;
    assert!(bad.is_err());

    // bots.read 不允许携带 commandId
    let bad_cmd = super::gateway(
        &host,
        "bots.read",
        &json!({"commandId": "01234567-89ab-cdef-0123-456789abcdef", "params": {"operation": "list"}}),
    )
    .await;
    assert!(bad_cmd.is_err());

    // 配置 Arena + 创建 Bot + 触发 UNKNOWN
    let cmd_id = uuid::Uuid::new_v4().to_string();
    let cfg = super::gateway(
        &host,
        "bots.command",
        &json!({
            "commandId": cmd_id,
            "params": {
                "operation": "configureArena",
                "baseUrl": base_url,
                "token": "test-arena-token"
            }
        }),
    )
    .await
    .unwrap();
    assert_eq!(cfg["admissionState"], "accepted");

    let created = super::gateway(
        &host,
        "bots.command",
        &json!({
            "commandId": uuid::Uuid::new_v4().to_string(),
            "params": {
                "operation": "create",
                "name": "网关测试 Bot",
                "workspace": "gw-bot"
            }
        }),
    )
    .await
    .unwrap();
    let bot_id = created["receipt"]["bot"]["id"].as_str().unwrap().to_owned();

    state.drop_on_submit.store(true, Ordering::SeqCst);
    let send_res = super::gateway(
        &host,
        "bots.command",
        &json!({
            "commandId": uuid::Uuid::new_v4().to_string(),
            "params": {
                "operation": "send",
                "id": bot_id,
                "text": "断网测试"
            }
        }),
    )
    .await
    .unwrap();
    assert_eq!(send_res["admissionState"], "unknown");
    assert_eq!(send_res["submissionUnknown"], true);

    server.abort();
}

#[tokio::test]
async fn shared_model_requires_matching_remote_provider_and_live_authorization() {
    let state = MockArenaState::new();
    let (base_url, server) = start_mock_arena(state.clone()).await;
    let (_dir, service) = new_test_service(&base_url, Some("test-arena-token"));
    let created = service
        .create(CreateBotInput {
            name: "Harness model".into(),
            avatar: None,
            description: None,
            workspace: Some("harness-model".into()),
            starter_prompts: vec![],
            system_prompt_mode: SystemPromptMode::PersonalAgent,
            preferences: String::new(),
            model_override: None,
            provider_sync_mode: ProviderSyncMode::Auto,
        })
        .unwrap();
    let id = created["bot"]["id"].as_str().unwrap();
    let model = BotModelRef {
        provider_id: Some("arena".into()),
        model_id: "mock-flash".into(),
    };
    let provider = json!({"endpoint":"https://mock.arena.local/v1/chat/completions", "protocol":"chat-completions"});
    let wrong = json!({"endpoint":"https://other.example/v1/chat/completions", "protocol":"chat-completions"});
    assert_eq!(
        service
            .check_harness_model(id, &model, &wrong, true)
            .await
            .unwrap_err()
            .to_string(),
        "BOT_MODEL_AUTH_REQUIRED"
    );
    state.probe_auth_failed.store(true, Ordering::SeqCst);
    assert_eq!(
        service
            .check_harness_model(id, &model, &provider, true)
            .await
            .unwrap_err()
            .to_string(),
        "BOT_MODEL_AUTH_REQUIRED"
    );
    assert!(state.calls_for("areal/turn/submit").is_empty());
    state.probe_auth_failed.store(false, Ordering::SeqCst);
    service
        .check_harness_model(id, &model, &provider, true)
        .await
        .unwrap();
    assert_eq!(
        state.calls_for("areal/provider/probe").last().unwrap().1["model"],
        "mock-flash"
    );
    let sent = service
        .send(
            id,
            vec![json!({"type":"text","text":"Shared model test"})],
            "shared-model-test",
        )
        .await
        .unwrap();
    assert_eq!(sent["admissionState"], "accepted");
    assert_eq!(state.calls_for("areal/turn/submit").len(), 1);
    assert!(
        state
            .calls_for("areal/plugin/credentials/register")
            .is_empty()
    );
    assert!(state.calls_for("areal/provider/upsert").is_empty());
    server.abort();
}

/// 真实 EnvArena `[prod]` 端到端冒烟验证（隔离 tempdir，不触碰真实 `~/.areal`）。
/// 运行命令：`TMPDIR=/tmp .agents/scripts/with-ci-env.sh cargo test -p areal-host live_env_arena_prod_smoke -- --ignored --nocapture`
#[tokio::test]
#[ignore]
async fn live_env_arena_prod_smoke() {
    let dir = tempfile::tempdir().unwrap();
    let store = BotStore::new(dir.path());
    let service = BotService::load(store).unwrap();

    // 使用 ~/.arena-online-gateway/config.toml 中的 [prod] 配置
    let settings = service.settings().unwrap();
    assert!(
        settings.ready && settings.has_token,
        "Expected ~/.arena-online-gateway/config.toml to provide Arena credentials"
    );

    let workspace = std::env::var("ARENA_SMOKE_WORKSPACE").unwrap_or_else(|_| {
        format!(
            "bot-model-smoke-{}",
            &uuid::Uuid::new_v4().simple().to_string()[..12]
        )
    });
    let created = service
        .create(CreateBotInput {
            name: "Phase1 Live Smoke Bot".into(),
            avatar: Some("🧪".into()),
            description: Some("Host Stage 1 live smoke test".into()),
            workspace: Some(workspace),
            starter_prompts: vec!["汇报当前状态".into()],
            system_prompt_mode: SystemPromptMode::PersonalAgent,
            preferences: "请始终用简短中文回复。".into(),
            model_override: None,
            provider_sync_mode: ProviderSyncMode::Auto,
        })
        .unwrap();
    let bot_id = created["bot"]["id"].as_str().unwrap().to_owned();

    let connected = service.connect(&bot_id).await.unwrap();
    println!(
        "LIVE CONNECT OK: state={}, models={}, providers={}, providerHealth={}",
        connected["bot"]["connectionState"],
        connected["models"].as_array().map(|a| a.len()).unwrap_or(0),
        connected["providers"]
            .as_array()
            .map(|a| a.len())
            .unwrap_or(0),
        connected["providerHealth"]
    );
    assert_eq!(connected["bot"]["connectionState"]["kind"], "ready");
    assert!(connected["bot"]["activeThreadId"].as_str().is_some());

    // 验证偏好热更新（areal/thread/configure）
    let updated = service
        .update(UpdateBotInput {
            id: bot_id.clone(),
            expected_revision: None,
            name: None,
            avatar: None,
            description: None,
            starter_prompts: None,
            system_prompt_mode: None,
            preferences: Some("请始终用简短中文回复，并附带日期。".into()),
            model_override: None,
            provider_sync_mode: None,
        })
        .await
        .unwrap();
    assert_eq!(updated["bot"]["preferencesDirty"], false);

    // 验证 observe + models + disconnect
    let observed = service.observe(&bot_id).await.unwrap();
    assert!(observed["thread"]["id"].as_str().is_some());
    let models = service.models(&bot_id).await.unwrap();
    assert!(!models["models"].as_array().unwrap().is_empty());

    let request = uuid::Uuid::new_v4().to_string();
    let marker = "AREAL_BOT_SMOKE_OK";
    let sent = service
        .send(
            &bot_id,
            vec![json!({
                "type":"text", "text":format!("Reply with exactly {marker}.")
            })],
            &request,
        )
        .await
        .unwrap();
    assert_eq!(sent["admissionState"], "accepted");
    let turn_id = sent["receipt"]["turn"]["id"]
        .as_str()
        .or_else(|| sent["receipt"]["turnId"].as_str())
        .expect("remote receipt has a turn ID");
    tokio::time::timeout(std::time::Duration::from_secs(90), async {
        loop {
            let view = service.observe(&bot_id).await.unwrap();
            let turns = view["thread"]["turns"].as_array().unwrap();
            if let Some(turn) = turns.iter().find(|turn| turn["id"] == turn_id) {
                let status = turn["status"].as_str().unwrap_or("");
                if status == "completed" {
                    assert!(turn["items"].as_array().unwrap().iter().any(|item| {
                        item["type"] == "agentMessage"
                            && item["text"]
                                .as_str()
                                .is_some_and(|text| text.contains(marker))
                    }));
                    assert_eq!(turns.iter().filter(|turn| turn["id"] == turn_id).count(), 1);
                    break;
                }
                assert_ne!(status, "failed", "remote inference failed");
                assert_ne!(status, "interrupted");
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    })
    .await
    .expect("remote turn did not complete");
    println!("LIVE SEND OK: original remote turn completed and returned the marker");

    let disc = service.disconnect(&bot_id).unwrap();
    assert_eq!(disc["bot"]["connectionState"]["kind"], "sleeping");
}

#[tokio::test]
async fn upsert_provider_registers_credentials_when_supported_and_resyncs_on_wake() {
    let state = MockArenaState::new();
    state
        .supports_credential_registration
        .store(true, Ordering::SeqCst);
    let (base_url, server) = start_mock_arena(state.clone()).await;
    let (_dir, service) = new_test_service(&base_url, Some("test-arena-token"));

    let created = service
        .create(CreateBotInput {
            name: "Credential Bot".into(),
            avatar: None,
            description: None,
            workspace: Some("cred-bot".into()),
            starter_prompts: vec![],
            system_prompt_mode: SystemPromptMode::PersonalAgent,
            preferences: String::new(),
            model_override: None,
            provider_sync_mode: ProviderSyncMode::Auto,
        })
        .unwrap();
    let bot_id = created["bot"]["id"].as_str().unwrap().to_owned();
    let connected = service.connect(&bot_id).await.unwrap();
    assert_eq!(
        connected["providerHealth"]["supportsCredentialRegistration"],
        true
    );

    let upserted = service
        .upsert_provider(
            &bot_id,
            json!({
                "id": "gateway",
                "endpoint": "https://gateway.example/api/v1",
                "protocol": "chatCompletions",
                "apiKey": "fake-provider-key-for-test",
                "models": ["model-a"]
            }),
            None,
            Some(BotModelRef {
                provider_id: Some("gateway".into()),
                model_id: "model-a".into(),
            }),
        )
        .await
        .unwrap();
    assert_eq!(upserted["providerHealth"]["status"], "ready");
    let reg_calls = state.calls_for("areal/plugin/credentials/register");
    assert_eq!(reg_calls.len(), 1);
    assert_eq!(
        reg_calls[0].1["credentials"]["bot_provider_gateway"],
        "fake-provider-key-for-test"
    );
    let upsert_calls = state.calls_for("areal/provider/upsert");
    assert_eq!(
        upsert_calls[0].1["provider"]["endpoint"],
        "https://gateway.example/api/v1/chat/completions"
    );
    assert_eq!(
        upsert_calls[0].1["provider"]["credentialRef"],
        "bot_provider_gateway"
    );

    // 断连重连后应自动重同步凭据与自定义 Provider
    service.disconnect(&bot_id).unwrap();
    service.connect(&bot_id).await.unwrap();
    assert_eq!(
        state.calls_for("areal/plugin/credentials/register").len(),
        2
    );
    assert_eq!(state.calls_for("areal/provider/upsert").len(), 2);

    server.abort();
}

#[tokio::test]
async fn observe_and_turn_completed_prevent_stuck_active_turn_id() {
    let state = MockArenaState::new();
    let (base_url, server) = start_mock_arena(state.clone()).await;
    let (_dir, service) = new_test_service(&base_url, Some("test-arena-token"));

    let created = service
        .create(CreateBotInput {
            name: "Turn State Bot".into(),
            avatar: None,
            description: None,
            workspace: Some("turn-state-bot".into()),
            starter_prompts: vec![],
            system_prompt_mode: SystemPromptMode::PersonalAgent,
            preferences: String::new(),
            model_override: None,
            provider_sync_mode: ProviderSyncMode::Auto,
        })
        .unwrap();
    let bot_id = created["bot"]["id"].as_str().unwrap().to_owned();
    service.connect(&bot_id).await.unwrap();

    // 发送后 activeTurnId 被设置
    let sent = service
        .send(
            &bot_id,
            vec![json!({"type": "text", "text": "ping"})],
            "req-turn-1",
        )
        .await
        .unwrap();
    let turn_id = sent["receipt"]["turn"]["id"]
        .as_str()
        .or_else(|| sent["receipt"]["turnId"].as_str())
        .unwrap()
        .to_owned();
    assert_eq!(sent["bot"]["activeTurnId"], turn_id);

    // 即使 observe 观察到线程已回到 idle，也必须清空残留的 activeTurnId
    let observed = service.observe(&bot_id).await.unwrap();
    assert!(observed["bot"]["activeTurnId"].is_null());

    // 模拟 fast-fail 竞态：turn/completed 先到达，后续再 set_active_turn 不得重新锁死
    service.mark_turn_completed(&bot_id, Some("turn-fast-fail"));
    service.set_active_turn(&bot_id, Some("turn-fast-fail".into()));
    assert!(service.get(&bot_id).unwrap()["bot"]["activeTurnId"].is_null());

    server.abort();
}
