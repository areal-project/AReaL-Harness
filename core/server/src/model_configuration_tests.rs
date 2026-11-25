use super::*;
use areal_app_server::configuration::ModelConfigurationControl;
use areal_config::ConfigInputs;
use areal_protocol::desktop::{ModelConfigurationApply, ModelConfigurationRead};

struct Fixture {
    _directory: tempfile::TempDir,
    inputs: ConfigInputs,
    control: Arc<Controller>,
}
impl Fixture {
    async fn open() -> Self {
        Self::open_with_providers(None).await
    }
    async fn open_with_providers(providers: Option<Value>) -> Self {
        Self::open_with_file(providers, true).await
    }
    async fn open_with_file(providers: Option<Value>, existing_file: bool) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let mut inputs = ConfigInputs {
            cwd: directory.path().into(),
            homedir: Some(directory.path().into()),
            ..Default::default()
        };
        inputs.overrides.data_dir = Some(directory.path().join("data"));
        if existing_file {
            inputs.config_file = Some(directory.path().join("config.toml"));
            std::fs::write(
                inputs.config_file.as_ref().unwrap(),
                "schema_version = 2\n[model]\ncatalog_version = 1\n",
            )
            .unwrap();
        }
        if let Some(data) = providers {
            let current = areal_config::models::read(&inputs, &[]).unwrap();
            let update = serde_json::from_value(
                json!({"expectedRevision":current.revision,"data":data,"defaultModel":null}),
            )
            .unwrap();
            areal_config::models::write(&inputs, update, &[]).unwrap();
        }
        let (document, config) = areal_config::models::read_resolved(&inputs, &[]).unwrap();
        let engine = Engine::open(
            &config.data_dir,
            Arc::new(areal_engine::model::UnconfiguredModel),
            Default::default(),
        )
        .unwrap();
        let (catalog, _) = configured_models(&config, &inputs.env).unwrap();
        engine.install_configured_models(catalog).unwrap();
        let reload = Reload::open(inputs.clone(), &config, &engine).unwrap();
        let identity = areal_protocol::service::Identity {
            protocol_version: 1,
            service_id: "service-fixture".into(),
            generation: "generation-fixture".into(),
            workspace: directory.path().into(),
            data_dir: config.data_dir.clone(),
            config_fingerprint: "unchanged".into(),
        };
        let control = Controller::new(reload, engine, identity, document).await;
        Self {
            _directory: directory,
            inputs,
            control,
        }
    }
    fn write(&self, key: &str) -> String {
        Self::write_at(&self.inputs, "http://127.0.0.1:1/v1/chat/completions", key)
    }
    fn write_at(inputs: &ConfigInputs, endpoint: &str, key: &str) -> String {
        let previous = areal_config::models::read(inputs, &[]).unwrap();
        let update = serde_json::from_value(json!({"expectedRevision":previous.revision,"data":[{"id":"fixture","name":"Fixture","endpoint":endpoint,"protocol":"chat-completions","enabled":true,"apiKeyEnv":key,"models":[{"id":"fixture","enabled":true,"parameters":{}}],"parameters":{}}],"defaultModel":{"providerId":"fixture","modelId":"fixture"}})).unwrap();
        areal_config::models::write(inputs, update, &[])
            .unwrap()
            .revision
    }
    fn intent(&self, request: &str, revision: String) -> ModelConfigurationApply {
        ModelConfigurationApply {
            request_id: request.into(),
            expected_generation: "generation-fixture".into(),
            expected_applied: serde_json::from_value(
                self.control.engine.model_configuration_status()["applied"].clone(),
            )
            .unwrap(),
            target_revision: revision,
            credentials: [("AREAL_CREDENTIAL_first".into(), "synthetic-first".into())].into(),
        }
    }
    async fn read(&self, id: &str) -> Value {
        self.control
            .read(ModelConfigurationRead {
                request_id: Some(id.into()),
                expected_generation: Some("generation-fixture".into()),
            })
            .await
            .unwrap()
    }
}

#[tokio::test]
async fn existing_thread_sends_with_rotated_provider_key_after_restart() {
    use areal_protocol::{Input, TurnStatus, desktop::TurnStart};
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpListener;

    let fixture = Fixture::open().await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().unwrap()
    );
    let first = Fixture::write_at(&fixture.inputs, &endpoint, "AREAL_CREDENTIAL_first");
    fixture
        .control
        .clone()
        .apply(fixture.intent("first-key", first))
        .await
        .unwrap();
    let old = &fixture.control.engine;
    let thread = old
        .create(fixture.inputs.cwd.to_string_lossy().into())
        .await
        .unwrap();
    let pinned = old
        .configure_thread(
            serde_json::from_value(json!({
                "threadId": thread.id,
            "expectedRevision": 1,
                "model": {"providerId": "fixture", "modelId": "fixture"}
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        pinned.provider.as_ref().unwrap().credential_ref.as_deref(),
        Some("first")
    );
    old.shutdown().await;
    let mut identity = fixture.control.identity.clone();
    drop(fixture.control);

    let rotated = "AREAL_CREDENTIAL_rotated";
    Fixture::write_at(&fixture.inputs, &endpoint, rotated);
    let mut inputs = fixture.inputs.clone();
    inputs
        .env
        .insert(rotated.into(), "synthetic-rotated".into());
    let (document, config) = areal_config::models::read_resolved(&inputs, &[]).unwrap();
    let engine = Engine::open(
        &config.data_dir,
        Arc::new(areal_engine::model::UnconfiguredModel),
        Default::default(),
    )
    .unwrap();
    let (catalog, credentials) = configured_models(&config, &inputs.env).unwrap();
    assert_eq!(credentials.len(), 1);
    for (reference, value) in credentials {
        engine.register_credential(reference, value).unwrap();
    }
    engine.install_configured_models(catalog).unwrap();
    let reload = Reload::open(inputs, &config, &engine).unwrap();
    identity.generation = "generation-after-restart".into();
    let control = Controller::new(reload, engine.clone(), identity.clone(), document).await;

    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut socket = BufReader::new(socket);
        let mut headers = String::new();
        loop {
            let mut line = String::new();
            assert!(socket.read_line(&mut line).await.unwrap() > 0);
            if line == "\r\n" {
                break;
            }
            headers.push_str(&line.to_ascii_lowercase());
        }
        assert!(headers.starts_with("post /v1/chat/completions "));
        assert!(headers.contains("\r\nauthorization: bearer synthetic-rotated\r\n"));
        let length = headers
            .lines()
            .find_map(|line| line.strip_prefix("content-length: "))
            .unwrap()
            .parse()
            .unwrap();
        socket.read_exact(&mut vec![0; length]).await.unwrap();
        let body = concat!(
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":null}]}\n\n",
            "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n",
        );
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        socket.write_all(response.as_bytes()).await.unwrap();
    });
    let start = |request: &str| {
        let params: TurnStart = serde_json::from_value(json!({
            "requestId": request,
            "threadId": thread.id,
            "input": [Input::text("Continue the existing conversation")],
            "expectedConfigRevision": pinned.revision,
            "admissionGuard": {
                "ordinarySession": true,
                "configRevision": pinned.revision
            }
        }))
        .unwrap();
        engine.start_durable("fixture".into(), params, false)
    };
    start("after-rotation").await.unwrap();
    let finished =
        tokio::time::timeout(std::time::Duration::from_secs(10), engine.wait(&thread.id))
            .await
            .unwrap()
            .unwrap();
    server.await.unwrap();
    let turn = finished.turns.last().unwrap();
    assert_eq!(turn.status, TurnStatus::Completed);
    assert_eq!(
        turn.configuration
            .as_ref()
            .and_then(|config| config.provider.as_ref())
            .unwrap()
            .credential_ref
            .as_deref(),
        Some("rotated")
    );
    assert_eq!(
        finished.desktop.unwrap().configuration.provider,
        pinned.provider
    );

    let revision = Fixture::write_at(
        &fixture.inputs,
        "http://127.0.0.1:1/v1/chat/completions",
        rotated,
    );
    let change = ModelConfigurationApply {
        request_id: "different-endpoint".into(),
        expected_generation: identity.generation,
        expected_applied: serde_json::from_value(
            engine.model_configuration_status()["applied"].clone(),
        )
        .unwrap(),
        target_revision: revision,
        credentials: Default::default(),
    };
    control.apply(change).await.unwrap();
    let error = start("after-endpoint-change").await.unwrap_err();
    assert!(error.to_string().contains("CREDENTIAL_UNAVAILABLE"));
    engine.shutdown().await;
}

#[tokio::test]
async fn model_display_names_follow_applied_configuration_and_provider_identity() {
    let providers = |name: &str, provider_name: &str| {
        json!([
            {"id":"restored_5b32d70932a684ff87cd0f22","name":provider_name,"endpoint":"http://127.0.0.1:1/v1/chat/completions","protocol":"chat-completions","enabled":true,"models":[{"id":"shared","displayName":name,"enabled":true,"parameters":{}}],"parameters":{}},
            {"id":"second","name":"Second","endpoint":"http://127.0.0.1:1/v1/chat/completions","protocol":"chat-completions","enabled":true,"models":[{"id":"shared","displayName":"Second model","enabled":true,"parameters":{}},{"id":"unnamed","enabled":true,"parameters":{}}],"parameters":{}}
        ])
    };
    let fixture =
        Fixture::open_with_providers(Some(providers("First model", "Restored supplier"))).await;
    let restored_id = "restored_5b32d70932a684ff87cd0f22";
    let supplier_name = |catalog: &Value| {
        catalog["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|model| model["providerId"] == restored_id)
            .unwrap()["providerName"]
            .clone()
    };
    let names = |catalog: &Value| {
        catalog["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|model| {
                (
                    (model["providerId"].clone(), model["modelId"].clone()),
                    model.get("displayName").cloned(),
                )
            })
            .collect::<Vec<_>>()
    };
    let before = fixture.control.engine.model_catalog().await;
    assert_eq!(supplier_name(&before), "Restored supplier");
    assert!(names(&before).contains(&(
        (json!(restored_id), json!("shared")),
        Some(json!("First model"))
    )));
    assert!(names(&before).contains(&(
        (json!("second"), json!("shared")),
        Some(json!("Second model"))
    )));
    assert!(names(&before).contains(&((json!("second"), json!("unnamed")), None)));
    let current = areal_config::models::read(&fixture.inputs, &[]).unwrap();
    let update = serde_json::from_value(json!({"expectedRevision":current.revision,"data":providers("Renamed model", "Renamed supplier"),"defaultModel":null})).unwrap();
    let saved = areal_config::models::write(&fixture.inputs, update, &[]).unwrap();
    assert_eq!(
        names(&fixture.control.engine.model_catalog().await),
        names(&before)
    );
    let mut intent = fixture.intent("rename", saved.revision.clone());
    intent.credentials.clear();
    let receipt = fixture.control.clone().apply(intent).await.unwrap();
    assert_eq!(receipt["applied"]["revision"], saved.revision);
    let after = fixture.control.engine.model_catalog().await;
    assert_eq!(supplier_name(&after), "Renamed supplier");
    assert!(names(&after).contains(&(
        (json!(restored_id), json!("shared")),
        Some(json!("Renamed model"))
    )));
    assert!(names(&after).contains(&(
        (json!("second"), json!("shared")),
        Some(json!("Second model"))
    )));
    assert!(names(&after).contains(&((json!("second"), json!("unnamed")), None)));
    fixture.control.engine.shutdown().await;
}

#[tokio::test]
async fn first_default_model_file_applies_without_restarting_but_permissions_still_require_restart()
{
    let fixture = Fixture::open_with_file(None, false).await;
    let path = areal_config::models::read(&fixture.inputs, &[])
        .unwrap()
        .path;
    assert!(!path.exists());
    let revision = fixture.write("AREAL_CREDENTIAL_first");
    assert!(path.is_file());
    let result = fixture
        .control
        .clone()
        .apply(fixture.intent("first-save", revision.clone()))
        .await
        .unwrap();
    assert_eq!(
        result["applied"],
        json!({"revision": revision, "sequence": 1})
    );
    assert_eq!(result["credentialStates"]["fixture"], "available");
    assert_eq!(
        fixture.read("first-save").await["operation"]["state"],
        "applied"
    );

    let mut text = std::fs::read_to_string(&path).unwrap();
    text.push_str("\n[permissions]\nmode = \"ASK_PERMISSIONS\"\n");
    std::fs::write(path, text).unwrap();
    let changed = areal_config::models::read(&fixture.inputs, &[]).unwrap();
    let error = fixture
        .control
        .clone()
        .apply(fixture.intent("permissions-change", changed.revision))
        .await
        .unwrap_err();
    assert_eq!(
        error.data.unwrap()["reason"],
        "DEPLOYMENT_CHANGE_REQUIRES_RESTART"
    );
    assert_eq!(
        fixture.control.engine.model_configuration_status()["applied"],
        result["applied"]
    );
    fixture.control.engine.shutdown().await;
}

#[tokio::test]
async fn apply_is_idempotent_and_credentials_are_immutable() {
    let fixture = Fixture::open().await;
    let revision = fixture.write("AREAL_CREDENTIAL_first");
    let request = fixture.intent("rotate", revision.clone());
    let expected = request.expected_applied.clone();
    let first = fixture.control.clone().apply(request).await.unwrap();
    assert_eq!(first["applied"], json!({"revision":revision,"sequence":1}));
    assert_eq!(first["credentialStates"]["fixture"], "available");
    let mut duplicate = fixture.intent("rotate", revision.clone());
    duplicate.expected_applied = expected.clone();
    let again = fixture.control.clone().apply(duplicate).await.unwrap();
    assert_eq!(again["applied"], first["applied"]);
    let mut changed = fixture.intent("rotate", revision);
    changed.expected_applied = expected;
    changed
        .credentials
        .insert("AREAL_CREDENTIAL_first".into(), "synthetic-other".into());
    assert!(fixture.control.clone().apply(changed).await.is_err());
    let receipt = fixture.read("rotate").await;
    assert_eq!(receipt["operation"]["state"], "applied");
    assert!(!receipt.to_string().contains("synthetic"));
    fixture.control.engine.shutdown().await;
}

#[tokio::test]
async fn failures_do_not_publish_and_unknown_read_does_not_apply() {
    let fixture = Fixture::open().await;
    let before = fixture.control.engine.model_configuration_status();
    let revision = fixture.write("AREAL_CREDENTIAL_first");
    let mut stale = fixture.intent("stale", revision.clone());
    stale.expected_generation = "retired".into();
    assert!(fixture.control.clone().apply(stale).await.is_err());
    let mut unexpected = fixture.intent("extra", revision.clone());
    unexpected.credentials.insert(
        "AREAL_CREDENTIAL_unrelated".into(),
        "synthetic-extra".into(),
    );
    assert!(fixture.control.clone().apply(unexpected).await.is_err());
    assert_eq!(
        fixture.read("extra").await["operation"]["state"],
        "rejected"
    );
    assert_eq!(
        fixture.read("never-sent").await["operation"]["state"],
        "unknown"
    );
    assert_eq!(
        fixture.control.engine.model_configuration_status()["applied"],
        before["applied"]
    );
    std::fs::remove_file(
        fixture
            .control
            .engine
            .data_dir()
            .join("desktop/catalog.json"),
    )
    .ok();
    std::fs::create_dir(
        fixture
            .control
            .engine
            .data_dir()
            .join("desktop/catalog.json"),
    )
    .unwrap();
    assert!(
        fixture
            .control
            .clone()
            .apply(fixture.intent("io", revision))
            .await
            .is_err()
    );
    assert_eq!(
        fixture.control.engine.model_configuration_status()["applied"],
        before["applied"]
    );
    fixture.control.engine.shutdown().await;
}

#[tokio::test]
async fn accepted_apply_survives_caller_cancellation() {
    let fixture = Fixture::open().await;
    let revision = fixture.write("AREAL_CREDENTIAL_first");
    let guard = fixture.control.reload.lock().await;
    let control = fixture.control.clone();
    let request = fixture.intent("dropped", revision.clone());
    let caller = tokio::spawn(async move { control.apply(request).await });
    loop {
        if fixture.read("dropped").await["operation"]["state"] == "running" {
            break;
        }
        tokio::task::yield_now().await;
    }
    caller.abort();
    drop(guard);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if fixture.read("dropped").await["operation"]["state"] == "applied" {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        fixture.control.engine.model_configuration_status()["applied"],
        json!({"revision":revision,"sequence":1})
    );
    fixture.control.engine.shutdown().await;
}

#[tokio::test]
async fn context_defaults_and_user_overrides_survive_configuration_hot_apply() {
    let fixture = Fixture::open().await;
    for (index, report, user, expected, source) in [
        (0, Some(500000), None, 500000, "provider"),
        (1, Some(500000), Some(900000), 900000, "user"),
        (2, Some(600000), None, 600000, "provider"),
        (3, None, None, 131072, "fallback"),
    ] {
        let previous = areal_config::models::read(&fixture.inputs, &[]).unwrap();
        let mut model = json!({"id":"opaque","enabled":true,"parameters":{}});
        if let Some(window) = report {
            model["reportedContextWindowTokens"] = json!(window);
        }
        if let Some(window) = user {
            model["parameters"]["contextWindowTokens"] = json!(window);
        }
        let update = serde_json::from_value(json!({
            "expectedRevision":previous.revision,
            "data":[{"id":"fixture","name":"Fixture","endpoint":"http://127.0.0.1:1/v1/chat/completions",
                "protocol":"chat-completions","enabled":true,"models":[model],"parameters":{}}],
            "defaultModel":{"providerId":"fixture","modelId":"opaque"}
        })).unwrap();
        let saved = areal_config::models::write(&fixture.inputs, update, &[]).unwrap();
        let mut intent = fixture.intent(&format!("context-{index}"), saved.revision);
        intent.credentials.clear();
        fixture.control.clone().apply(intent).await.unwrap();
        let catalog = fixture.control.engine.model_catalog().await;
        let model = catalog["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|model| model["providerId"] == "fixture")
            .unwrap();
        assert_eq!(model["effectiveContextWindowTokens"], expected);
        assert_eq!(model["windowSource"], source);
        assert_eq!(model["userBudgetTokens"], json!(user));
        assert_eq!(model["reportedWindowTokens"], json!(report));
        let thread = fixture
            .control
            .engine
            .create(fixture.inputs.cwd.to_string_lossy().into())
            .await
            .unwrap();
        let context = fixture
            .control
            .engine
            .context_read(&thread.id, 0, 16)
            .await
            .unwrap();
        assert_eq!(context["budget"]["windowTokens"], expected);
        assert_eq!(context["budget"]["windowSource"], source);
        assert_eq!(context["budget"]["inputLimitTokens"], expected - 16384);
    }
    fixture.control.engine.shutdown().await;
}
