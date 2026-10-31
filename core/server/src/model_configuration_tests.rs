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
        let directory = tempfile::tempdir().unwrap();
        let mut inputs = ConfigInputs {
            cwd: directory.path().into(),
            homedir: Some(directory.path().into()),
            ..Default::default()
        };
        inputs.config_file = Some(directory.path().join("config.toml"));
        inputs.overrides.data_dir = Some(directory.path().join("data"));
        std::fs::write(
            inputs.config_file.as_ref().unwrap(),
            "schema_version = 2\n[model]\ncatalog_version = 1\n",
        )
        .unwrap();
        let (document, config) = areal_config::models::read_resolved(&inputs, &[]).unwrap();
        let engine = Engine::open(
            &config.data_dir,
            Arc::new(areal_engine::model::UnconfiguredModel),
            Default::default(),
        )
        .unwrap();
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
        let previous = areal_config::models::read(&self.inputs, &[]).unwrap();
        let update = serde_json::from_value(json!({"expectedRevision":previous.revision,"data":[{"id":"fixture","name":"Fixture","endpoint":"http://127.0.0.1:1/v1/chat/completions","protocol":"chat-completions","enabled":true,"apiKeyEnv":key,"models":[{"id":"fixture","enabled":true,"parameters":{}}],"parameters":{}}],"defaultModel":{"providerId":"fixture","modelId":"fixture"}})).unwrap();
        areal_config::models::write(&self.inputs, update, &[])
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
