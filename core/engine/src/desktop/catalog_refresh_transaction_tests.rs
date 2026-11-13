use super::*;

#[tokio::test]
async fn provider_changes_notify_after_commit_without_threads() {
    let root = tempfile::tempdir().unwrap();
    let model = Arc::new(
        model::HttpModel::with_protocol(
            "http://127.0.0.1:1/".into(),
            "fixture".into(),
            None,
            model::ModelProtocol::Responses,
        )
        .unwrap(),
    );
    let engine = Engine::open(root.path(), model, Limits::default()).unwrap();
    let mut events = engine.subscribe_model_catalog();
    let provider = serde_json::from_value(json!({"id":"fixture","revision":0,"endpoint":"http://127.0.0.1:1/","protocol":"responses","models":["fixture"]})).unwrap();
    engine.upsert_provider(provider, 0).await.unwrap();
    assert_eq!(events.try_recv().unwrap()["params"]["revision"], 1);
    assert!(engine.provider("fixture").is_ok());
    engine.remove_provider("fixture".into(), 1).await.unwrap();
    assert_eq!(events.try_recv().unwrap()["params"]["revision"], 2);
    assert!(engine.provider("fixture").is_err());
}

#[tokio::test]
async fn provider_save_and_runtime_catalog_refresh_preserve_both_updates() {
    let root = tempfile::tempdir().unwrap();
    for dir in [
        ".agents/plugins",
        "pkg/.claude-plugin",
        "pkg/agents",
        ".agents/skills/review",
    ] {
        std::fs::create_dir_all(root.path().join(dir)).unwrap();
    }
    std::fs::write(
        root.path().join(".agents/plugins/marketplace.json"),
        r#"{"name":"local","plugins":[{"name":"sample","source":"./pkg"}]}"#,
    )
    .unwrap();
    std::fs::write(
        root.path().join("pkg/.claude-plugin/plugin.json"),
        r#"{"name":"sample"}"#,
    )
    .unwrap();
    let store = Arc::new(
        areal_plugins::Store::open(root.path().join("plugins"), root.path().into(), None).unwrap(),
    );
    let model = Arc::new(
        model::HttpModel::with_protocol(
            "http://127.0.0.1:1/".into(),
            "fixture".into(),
            None,
            model::ModelProtocol::Responses,
        )
        .unwrap(),
    );
    let engine = Engine::open(&root.path().join("engine"), model, Limits::default()).unwrap();
    engine.install_plugin_store(store.clone()).unwrap();
    engine
        .install_discovered_skill_sources(root.path().into(), None)
        .unwrap();
    let (ready, release) = engine.store.pause_next_catalog_write();
    let provider = {
        let engine = engine.clone();
        tokio::spawn(async move {
            engine.upsert_provider(serde_json::from_value(json!({"id":"concurrent","revision":0,"endpoint":"http://127.0.0.1:1/","protocol":"responses","models":["fixture"]})).unwrap(), 0).await
        })
    };
    ready.await.unwrap();
    std::fs::write(
        root.path().join("pkg/agents/reviewer.md"),
        "Review concurrently.",
    )
    .unwrap();
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
    std::fs::write(
        root.path().join(".agents/skills/review/SKILL.md"),
        "---\nname: review\ndescription: Concurrent skill\n---\nbody",
    )
    .unwrap();
    let refresh = {
        let engine = engine.clone();
        tokio::spawn(async move {
            tokio::join!(engine.refresh_plugins(), engine.refresh_discovered_skills())
        })
    };
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(25), async {
            while !refresh.is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .is_err(),
        "runtime publication bypassed the pending provider transaction"
    );
    release.send(()).unwrap();
    provider.await.unwrap().unwrap();
    let (plugins, skills) = refresh.await.unwrap();
    plugins.unwrap();
    skills.unwrap();
    for catalog in [
        engine.desktop.catalog.read().unwrap().clone(),
        Catalog::load(&root.path().join("engine")).unwrap(),
    ] {
        assert!(catalog.providers.contains_key("concurrent"));
        assert!(
            catalog
                .profiles
                .values()
                .any(|p| p.id.starts_with("plugin-agent-"))
        );
        assert!(
            catalog
                .profiles
                .values()
                .any(|p| p.id == "areal-discovered-skills" && p.skills.len() == 1)
        );
        assert_eq!(catalog.plugin_origins.len(), 1);
    }
    engine.shutdown().await;
}
