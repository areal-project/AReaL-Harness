use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelEvent, ModelStream},
};
use areal_protocol::{Input, desktop::TurnSubmit};
use async_trait::async_trait;
use serde_json::json;
use std::{fs, sync::Arc};
use tokio::sync::Semaphore;

struct FixtureModel {
    release: Arc<Semaphore>,
}
#[async_trait]
impl Model for FixtureModel {
    fn name(&self) -> &str {
        "plugin-template-fixture"
    }
    async fn stream(&self, messages: Vec<Message>) -> anyhow::Result<ModelStream> {
        if messages
            .iter()
            .any(|m| m.role == "user" && m.text_content() == "hold parent")
        {
            self.release.acquire().await.unwrap().forget();
        }
        Ok(Box::pin(futures_util::stream::iter([Ok(
            ModelEvent::text("done"),
        )])))
    }
}

async fn setup() -> (
    tempfile::TempDir,
    Arc<areal_plugins::Store>,
    Arc<Engine>,
    Arc<Semaphore>,
) {
    let root = tempfile::tempdir().unwrap();
    for directory in [
        ".agents/plugins",
        "pkg/.claude-plugin",
        "pkg/commands",
        "pkg/agents",
    ] {
        fs::create_dir_all(root.path().join(directory)).unwrap();
    }
    fs::write(
        root.path().join(".agents/plugins/marketplace.json"),
        r#"{"name":"local","plugins":[{"name":"sample","source":"./pkg"}]}"#,
    )
    .unwrap();
    fs::write(
        root.path().join("pkg/.claude-plugin/plugin.json"),
        r#"{"name":"sample"}"#,
    )
    .unwrap();
    fs::write(
        root.path().join("pkg/commands/review.md"),
        "Review $ARGUMENTS",
    )
    .unwrap();
    fs::write(root.path().join("pkg/agents/reviewer.md"), "---\nname: reviewer\ndescription: Review files\n---\nReview with the inherited permissions.").unwrap();
    let store = Arc::new(
        areal_plugins::Store::open(root.path().join("plugins"), root.path().into(), None).unwrap(),
    );
    let detail = store.read("sample@local").unwrap();
    store
        .install(
            &detail.id,
            "user",
            detail.revision,
            &detail.source,
            detail.review_digest(),
        )
        .unwrap();
    let release = Arc::new(Semaphore::new(0));
    let engine = Engine::open(
        &root.path().join("engine"),
        Arc::new(FixtureModel {
            release: release.clone(),
        }),
        Limits::default(),
    )
    .unwrap();
    engine.install_plugin_store(store.clone()).unwrap();
    (root, store, engine, release)
}

fn command(store: &areal_plugins::Store, thread_id: &str, request_id: &str) -> TurnSubmit {
    let component = store.enabled_component("sample@local").unwrap();
    serde_json::from_value(json!({"requestId":request_id,"threadId":thread_id,"expectedConfigRevision":1,
        "intent":{"type":"message","input":[],"command":{"pluginId":"sample@local","componentId":component.commands[0].identity.component_id,"installedDigest":component.digest,"arguments":"$(do-not-execute) literal"}}})).unwrap()
}

#[tokio::test]
async fn command_admission_keeps_original_receipt_and_rejects_revoked_references() {
    let (root, store, engine, _) = setup().await;
    let thread = engine
        .create(root.path().to_string_lossy().into_owned())
        .await
        .unwrap();
    let request = command(&store, &thread.id, "command-1");
    let response = engine
        .submit_turn("client".into(), request.clone())
        .await
        .unwrap();
    let finished = engine.wait(&thread.id).await.unwrap();
    let saved = serde_json::to_string(&finished).unwrap();
    assert!(saved.contains("Review $(do-not-execute) literal"));
    assert_eq!(
        response["command"]["arguments"],
        "$(do-not-execute) literal"
    );
    store
        .configure(
            "sample@local",
            "user",
            false,
            store.list().unwrap().revision,
        )
        .unwrap();
    assert_eq!(
        engine
            .submit_turn("client".into(), request.clone())
            .await
            .unwrap(),
        response
    );
    let mut changed = serde_json::to_value(&request).unwrap();
    changed["intent"]["command"]["arguments"] = json!("different");
    assert!(
        engine
            .submit_turn("client".into(), serde_json::from_value(changed).unwrap())
            .await
            .is_err()
    );
    let mut rejected = request;
    rejected.request_id = "command-2".into();
    assert!(engine.submit_turn("client".into(), rejected).await.is_err());
    engine.shutdown().await;
}

#[tokio::test]
async fn queued_command_freezes_template_and_arguments_at_admission() {
    let (root, store, engine, release) = setup().await;
    let thread = engine
        .create(root.path().to_string_lossy().into_owned())
        .await
        .unwrap();
    engine
        .start(&thread.id, vec![Input::text("hold parent")])
        .await
        .unwrap();
    let request = command(&store, &thread.id, "queued-command");
    let result = engine.submit_turn("client".into(), request).await.unwrap();
    assert!(result["queueItemId"].is_string());
    let queued = engine
        .read(&thread.id, true)
        .await
        .unwrap()
        .desktop
        .unwrap()
        .queue
        .items;
    assert_eq!(
        serde_json::to_value(&queued[0].input).unwrap()[0]["text"],
        "Review $(do-not-execute) literal"
    );
    store
        .configure(
            "sample@local",
            "user",
            false,
            store.list().unwrap().revision,
        )
        .unwrap();
    release.add_permits(10);
    engine.wait(&thread.id).await.unwrap();
    engine.shutdown().await;
}

#[tokio::test]
async fn plugin_agent_uses_profile_and_parent_permissions_then_rejects_new_spawn() {
    let (root, store, engine, release) = setup().await;
    let profile = engine.profiles()["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"].as_str().unwrap().starts_with("plugin-agent-"))
        .unwrap()
        .clone();
    let thread = engine
        .create(root.path().to_string_lossy().into_owned())
        .await
        .unwrap();
    let deployment = root.path().join("parent.json");
    fs::write(&deployment, json!({"profiles":[{"id":"parent","revision":"v1","displayName":"Parent","instructions":"","readOnly":true,"toolAllowlist":["plan_read"],"approvalTools":["plan_read"]}]}).to_string()).unwrap();
    engine.install_deployment(&deployment).unwrap();
    engine.configure_thread(serde_json::from_value(json!({"threadId":thread.id,"expectedRevision":1,"agentProfile":{"id":"parent","revision":"v1"}})).unwrap()).await.unwrap();
    engine
        .start(&thread.id, vec![Input::text("hold parent")])
        .await
        .unwrap();
    let request = json!({"parentThreadId":thread.id,"input":[{"type":"text","text":"child"}],"agentProfile":{"id":profile["id"],"revision":profile["revision"]},"workspaceMode":"sharedReadOnly"});
    let child = engine
        .spawn_agent(serde_json::from_value(request.clone()).unwrap())
        .await
        .unwrap();
    let config = &child["turn"]["configuration"];
    assert_eq!(config["readOnly"], true);
    assert_eq!(config["toolAllowlist"], json!(["plan_read"]));
    assert_eq!(config["options"]["approvalTools"], json!(["plan_read"]));
    assert_eq!(
        config["profile"]["instructions"],
        "Review with the inherited permissions."
    );
    store
        .configure(
            "sample@local",
            "user",
            false,
            store.list().unwrap().revision,
        )
        .unwrap();
    assert!(
        engine
            .spawn_agent(serde_json::from_value(request).unwrap())
            .await
            .is_err()
    );
    release.add_permits(10);
    engine.wait(&thread.id).await.unwrap();
    engine.shutdown().await;
}

#[tokio::test]
async fn replaced_agent_revisions_release_catalog_capacity_and_preserve_frozen_history() {
    let (root, store, engine, release) = setup().await;
    let old = engine.profiles()["data"][0].clone();
    let reference = json!({"id":old["id"],"revision":old["revision"]});
    let thread = engine
        .create(root.path().to_string_lossy().into_owned())
        .await
        .unwrap();
    engine
        .configure_thread(
            serde_json::from_value(
                json!({"threadId":thread.id,"expectedRevision":1,"agentProfile":reference}),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    let active = engine
        .start(&thread.id, vec![Input::text("hold parent")])
        .await
        .unwrap();
    for revision in 0..70 {
        fs::write(
            root.path().join("pkg/agents/reviewer.md"),
            format!("Revision {revision}"),
        )
        .unwrap();
        let detail = store.read("sample@local").unwrap();
        engine
            .plugin_install(
                detail.id,
                "user".into(),
                detail.revision,
                detail.source,
                detail.source_digest,
            )
            .await
            .unwrap();
        assert_eq!(engine.profiles()["data"].as_array().unwrap().len(), 1);
        assert!(
            engine
                .plugin_component_summary("sample@local".into())
                .await
                .unwrap()["agentDiagnostics"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
    assert!(
        engine
            .profile(&serde_json::from_value(reference).unwrap())
            .is_err()
    );
    assert_eq!(
        active.configuration.unwrap().profile.unwrap().instructions,
        "Review with the inherited permissions."
    );
    release.add_permits(10);
    engine.wait(&thread.id).await.unwrap();
    assert_eq!(
        engine
            .read(&thread.id, true)
            .await
            .unwrap()
            .desktop
            .unwrap()
            .configuration
            .profile
            .unwrap()
            .instructions,
        "Review with the inherited permissions."
    );
    engine.shutdown().await;
    drop(engine);
    let reopened = Engine::open(
        &root.path().join("engine"),
        Arc::new(FixtureModel { release }),
        Limits::default(),
    )
    .unwrap();
    reopened.install_plugin_store(store).unwrap();
    assert_eq!(
        reopened
            .read(&thread.id, true)
            .await
            .unwrap()
            .desktop
            .unwrap()
            .configuration
            .profile
            .unwrap()
            .instructions,
        "Review with the inherited permissions."
    );
    assert_eq!(reopened.profiles()["data"].as_array().unwrap().len(), 1);
    reopened.shutdown().await;
}
