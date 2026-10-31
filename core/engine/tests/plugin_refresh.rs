use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelEvent, ModelStream, ToolCall},
};
use areal_protocol::{Input, desktop::VersionRef};
use async_trait::async_trait;
use serde_json::json;
use std::{fs, sync::Arc, time::Duration};
use tokio::sync::Semaphore;

struct Fixture {
    release: Arc<Semaphore>,
    read_skill: std::sync::RwLock<Option<VersionRef>>,
}
#[async_trait]
impl Model for Fixture {
    fn name(&self) -> &str {
        "refresh-fixture"
    }
    async fn chat(
        &self,
        messages: Vec<Message>,
        _: Vec<serde_json::Value>,
    ) -> anyhow::Result<ModelStream> {
        let reference = self.read_skill.read().unwrap().clone();
        if let Some(reference) = reference {
            if let Some(result) = messages.iter().find(|message| message.role == "tool") {
                assert!(result.text_content().contains("old immutable body"));
                return Ok(Box::pin(futures_util::stream::iter([Ok(
                    ModelEvent::text("read old snapshot"),
                )])));
            }
            self.release.acquire().await.unwrap().forget();
            return Ok(Box::pin(futures_util::stream::iter([Ok(
                ModelEvent::ToolCall(ToolCall {
                    id: "read-old".into(),
                    name: "skill_read".into(),
                    arguments: json!({"skill":reference}).to_string(),
                }),
            )])));
        }
        self.stream(messages).await
    }
    async fn stream(&self, messages: Vec<Message>) -> anyhow::Result<ModelStream> {
        if messages
            .iter()
            .any(|m| m.role == "user" && m.text_content() == "hold")
        {
            self.release.acquire().await.unwrap().forget();
        }
        Ok(Box::pin(futures_util::stream::iter([Ok(
            ModelEvent::text("done"),
        )])))
    }
}
async fn eventually(mut ready: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !ready() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("refresh exceeded five seconds");
}
#[tokio::test]
async fn development_source_publishes_new_snapshot_while_active_turn_keeps_old_skill() {
    let root = tempfile::tempdir().unwrap();
    for path in [".agents/plugins", "pkg/.claude-plugin", "pkg/skills/review"] {
        fs::create_dir_all(root.path().join(path)).unwrap();
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
    let skill = root.path().join("pkg/skills/review/SKILL.md");
    fs::write(
        &skill,
        "---\nname: review\ndescription: Original\n---\nold immutable body",
    )
    .unwrap();
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
    let digest = store.read(&detail.id).unwrap().installed_digest.unwrap();
    let release = Arc::new(Semaphore::new(0));
    let model = Arc::new(Fixture {
        release: release.clone(),
        read_skill: Default::default(),
    });
    let engine = Engine::open(
        &root.path().join("engine"),
        model.clone(),
        Limits::default(),
    )
    .unwrap();
    engine.install_plugin_store(store.clone()).unwrap();
    engine.plugin_development_link(serde_json::from_value(json!({"requestId":"link","id":detail.id,"expectedRevision":store.list().unwrap().revision,"expectedDigest":digest})).unwrap()).await.unwrap();
    let thread = engine
        .create(root.path().to_string_lossy().into_owned())
        .await
        .unwrap();
    let old = engine.skills(&thread.id).await.unwrap()["data"][0].clone();
    let old: VersionRef =
        serde_json::from_value(json!({"id":old["id"],"revision":old["revision"]})).unwrap();
    *model.read_skill.write().unwrap() = Some(old.clone());
    engine
        .start(&thread.id, vec![Input::text("hold")])
        .await
        .unwrap();
    fs::write(
        &skill,
        "---\nname: review\ndescription: Updated\n---\nnew immutable body",
    )
    .unwrap();
    eventually(|| store.read(&detail.id).unwrap().installed_digest.as_deref() != Some(&digest))
        .await;
    release.add_permits(10);
    engine.wait(&thread.id).await.unwrap();
    *model.read_skill.write().unwrap() = None;
    engine
        .start(&thread.id, vec![Input::text("next")])
        .await
        .unwrap();
    engine.wait(&thread.id).await.unwrap();
    let new = engine.skills(&thread.id).await.unwrap()["data"][0].clone();
    let new: VersionRef =
        serde_json::from_value(json!({"id":new["id"],"revision":new["revision"]})).unwrap();
    assert!(
        engine
            .read_skill(&thread.id, new, "SKILL.md", 0, 8192)
            .await
            .unwrap()["text"]
            .as_str()
            .unwrap()
            .contains("new immutable body")
    );
    engine.shutdown().await;
}
#[tokio::test]
async fn discovered_metadata_refreshes_same_session_and_clears_all_deleted_skills() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join(".agents/skills/review");
    fs::create_dir_all(&dir).unwrap();
    let skill = dir.join("SKILL.md");
    fs::write(
        &skill,
        "---\nname: Review\ndescription: Original\n---\nbody",
    )
    .unwrap();
    let engine = Engine::open(
        &root.path().join("engine"),
        Arc::new(Fixture {
            release: Arc::new(Semaphore::new(10)),
            read_skill: Default::default(),
        }),
        Limits::default(),
    )
    .unwrap();
    engine
        .install_discovered_skill_sources(root.path().into(), None)
        .unwrap();
    let thread = engine
        .create(root.path().to_string_lossy().into_owned())
        .await
        .unwrap();
    let old = thread
        .desktop
        .unwrap()
        .configuration
        .profile
        .unwrap()
        .revision;
    fs::write(&skill, "---\nname: Review\ndescription: Updated\n---\nbody").unwrap();
    eventually(|| {
        engine.profiles()["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"] == "areal-discovered-skills" && p["revision"] != old)
    })
    .await;
    let turn = engine
        .start(&thread.id, vec![Input::text("next")])
        .await
        .unwrap();
    engine.wait(&thread.id).await.unwrap();
    assert_ne!(turn.configuration.unwrap().profile.unwrap().revision, old);
    assert_eq!(
        engine.skills(&thread.id).await.unwrap()["data"][0]["description"],
        "Updated"
    );
    fs::remove_file(&skill).unwrap();
    eventually(|| {
        engine.profiles()["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"] == "areal-discovered-skills" && p["skills"] == json!([]))
    })
    .await;
    let turn = engine
        .start(&thread.id, vec![Input::text("after deletion")])
        .await
        .unwrap();
    engine.wait(&thread.id).await.unwrap();
    assert!(
        turn.configuration
            .unwrap()
            .profile
            .unwrap()
            .skills
            .is_empty()
    );
    assert!(
        engine.skills(&thread.id).await.unwrap()["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn empty_discovery_admits_first_skill_on_existing_session_without_revising_explicit_profile()
{
    let root = tempfile::tempdir().unwrap();
    let engine = Engine::open(
        &root.path().join("engine"),
        Arc::new(Fixture {
            release: Arc::new(Semaphore::new(10)),
            read_skill: Default::default(),
        }),
        Limits::default(),
    )
    .unwrap();
    engine
        .install_discovered_skill_sources(root.path().into(), None)
        .unwrap();
    let thread = engine
        .create(root.path().to_string_lossy().into_owned())
        .await
        .unwrap();
    assert!(
        thread
            .desktop
            .as_ref()
            .unwrap()
            .configuration
            .profile
            .as_ref()
            .unwrap()
            .skills
            .is_empty()
    );
    let explicit = engine
        .create(root.path().to_string_lossy().into_owned())
        .await
        .unwrap();
    let deployment = root.path().join("explicit.json");
    fs::write(&deployment, json!({"profiles":[{"id":"explicit","revision":"one","displayName":"Explicit","instructions":"Fixed profile"}]}).to_string()).unwrap();
    engine.install_deployment(&deployment).unwrap();
    engine.configure_thread(serde_json::from_value(json!({"threadId":explicit.id,"expectedRevision":1,"agentProfile":{"id":"explicit","revision":"one"}})).unwrap()).await.unwrap();
    let dir = root.path().join(".agents/skills/first");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("SKILL.md"),
        "---\nname: first\ndescription: First discovered skill\n---\nbody",
    )
    .unwrap();
    eventually(|| {
        engine.profiles()["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| {
                p["id"] == "areal-discovered-skills" && p["skills"].as_array().unwrap().len() == 1
            })
    })
    .await;
    let automatic = engine
        .start(&thread.id, vec![Input::text("first skill")])
        .await
        .unwrap();
    engine.wait(&thread.id).await.unwrap();
    assert_eq!(
        automatic
            .configuration
            .unwrap()
            .profile
            .unwrap()
            .skills
            .len(),
        1
    );
    let fixed = engine
        .start(&explicit.id, vec![Input::text("fixed")])
        .await
        .unwrap();
    engine.wait(&explicit.id).await.unwrap();
    let fixed = fixed.configuration.unwrap().profile.unwrap();
    assert_eq!(fixed.id, "explicit");
    assert!(fixed.skills.is_empty());
    for revision in 0..70 {
        engine
            .install_default_skills(vec![areal_engine::desktop::SkillLocation {
                id: "synthetic".into(),
                revision: revision.to_string(),
                root: dir.clone(),
                metadata: None,
            }])
            .unwrap();
        assert_eq!(
            engine.profiles()["data"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|p| p["id"] == "areal-discovered-skills")
                .count(),
            1
        );
    }
    assert!(
        engine
            .profile(&VersionRef {
                id: "explicit".into(),
                revision: "one".into()
            })
            .is_ok()
    );
    engine.shutdown().await;
}
