use areal_engine::{
    Engine, Limits,
    desktop::{SkillLocation, SkillMetadata},
    model::UnconfiguredModel,
    tools::DynamicToolHost,
};
use areal_protocol::{DynamicToolResponse, desktop::VersionRef};
use async_trait::async_trait;
use serde_json::json;
use std::{fs, sync::Arc};
use tokio_util::sync::CancellationToken;

struct ProfileHost;
#[async_trait]
impl DynamicToolHost for ProfileHost {
    fn id(&self) -> &str {
        "profile-host"
    }
    fn is_closed(&self) -> bool {
        false
    }
    async fn call(
        &self,
        _: serde_json::Value,
        _: CancellationToken,
    ) -> anyhow::Result<DynamicToolResponse> {
        Ok(DynamicToolResponse {
            success: true,
            content_items: vec![],
            structured_content: Some(json!("profile-tool-ok")),
        })
    }
}

#[tokio::test]
async fn profile_without_workflow_exposes_its_deployed_tool_allowlist() {
    let state = tempfile::tempdir().unwrap();
    let deployment_dir = tempfile::tempdir().unwrap();
    let deployment = deployment_dir.path().join("deployment.json");
    fs::write(
        &deployment,
        serde_json::to_vec(&json!({
            "profiles": [{
                "id": "tool-agent", "revision": "v1", "displayName": "Tool agent",
                "instructions": "", "toolAllowlist": ["plan_read"]
            }, {
                "id": "workflow-agent", "revision": "v1", "displayName": "Workflow agent",
                "instructions": "", "workflow": {"id": "fixture-flow", "revision": "v1"}
            }],
            "skills": [], "workflows": [{
                "id": "fixture-flow", "revision": "v1", "displayName": "Fixture flow",
                "plan": {"objective": "fixture", "tasks": [{"id": "one", "instruction": "run", "writes": []}]}
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    let engine =
        Engine::open(state.path(), Arc::new(UnconfiguredModel), Limits::default()).unwrap();
    engine.install_deployment(&deployment).unwrap();
    let thread = engine
        .create_configured(
            "test-client".into(),
            areal_protocol::desktop::ThreadStart {
                request_id: "start-1".into(),
                cwd: Some("/workspace".into()),
                agent_profile: Some(VersionRef {
                    id: "tool-agent".into(),
                    revision: "v1".into(),
                }),
                model: None,
                parameters: Default::default(),
                dynamic_tools: vec![],
            },
            Arc::new(ProfileHost),
        )
        .await
        .unwrap();
    let inspection = engine.inspect(&thread.id).await.unwrap();
    assert_eq!(inspection["configuration"]["profile"]["id"], "tool-agent");
    assert_eq!(inspection["configuration"]["profile"]["revision"], "v1");
    assert!(
        inspection["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["function"]["name"] == "plan_read")
    );
    assert!(thread.desktop.unwrap().workflow_run.is_none());
    let same_profile = engine
        .configure_thread(
            serde_json::from_value(json!({
                "threadId": thread.id, "expectedRevision": 1,
                "agentProfile": {"id": "tool-agent", "revision": "v1"}
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(same_profile.revision, 2);
    let switch_error = engine
        .configure_thread(
            serde_json::from_value(json!({
                "threadId": thread.id, "expectedRevision": 2,
                "agentProfile": {"id": "workflow-agent", "revision": "v1"}
            }))
            .unwrap(),
        )
        .await
        .unwrap_err();
    assert!(switch_error.to_string().contains("creating a new thread"));
    let workflow_error = engine
        .create_configured(
            "test-client".into(),
            areal_protocol::desktop::ThreadStart {
                request_id: "start-2".into(),
                cwd: Some("/workspace".into()),
                agent_profile: Some(VersionRef {
                    id: "workflow-agent".into(),
                    revision: "v1".into(),
                }),
                model: None,
                parameters: Default::default(),
                dynamic_tools: vec![],
            },
            Arc::new(ProfileHost),
        )
        .await
        .unwrap_err();
    assert!(
        workflow_error
            .to_string()
            .contains("trusted deployment policy")
    );
    assert_eq!(engine.list(None, 100, None).await.unwrap().0.len(), 1);
    engine.shutdown().await;
}

#[tokio::test]
async fn deployment_rejects_a_profile_with_an_unavailable_workflow() {
    let state = tempfile::tempdir().unwrap();
    let deployment_dir = tempfile::tempdir().unwrap();
    let deployment = deployment_dir.path().join("deployment.json");
    fs::write(
        &deployment,
        serde_json::to_vec(&json!({
            "profiles": [{
                "id": "workflow-agent", "revision": "v1", "displayName": "Workflow agent",
                "instructions": "", "workflow": {"id": "missing-flow", "revision": "v1"}
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    let engine =
        Engine::open(state.path(), Arc::new(UnconfiguredModel), Limits::default()).unwrap();
    assert!(
        engine
            .install_deployment(&deployment)
            .unwrap_err()
            .to_string()
            .contains("unavailable workflow revision")
    );
    assert_eq!(engine.profiles()["data"].as_array().unwrap().len(), 0);
    engine.shutdown().await;
}

#[tokio::test]
async fn profile_references_survive_restart_while_resources_are_read_from_current_files() {
    let state = tempfile::tempdir().unwrap();
    let resources = tempfile::tempdir().unwrap();
    let location = |revision: &str| SkillLocation {
        id: "review".into(),
        revision: revision.into(),
        root: resources.path().into(),
        metadata: None,
    };
    let reference = |revision: &str| VersionRef {
        id: "review".into(),
        revision: revision.into(),
    };
    fs::write(resources.path().join("SKILL.md"), "original instructions").unwrap();
    fs::write(resources.path().join("check.md"), "supporting resource").unwrap();
    let engine =
        Engine::open(state.path(), Arc::new(UnconfiguredModel), Limits::default()).unwrap();
    engine.install_default_skills(vec![location("v1")]).unwrap();
    let original = engine.create("/workspace".into()).await.unwrap();
    let configuration = original.desktop.as_ref().unwrap().configuration.clone();
    engine
        .configure_thread(
            serde_json::from_value(serde_json::json!({
                "threadId": original.id,
                "expectedRevision": configuration.revision,
                "selectedSkills": [{"id":"review","revision":"v1"}]
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        engine.skills(&original.id).await.unwrap()["data"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let updated = engine.read(&original.id, true).await.unwrap();
    let revision = updated.desktop.as_ref().unwrap().configuration.revision;
    engine
        .configure_thread(
            serde_json::from_value(serde_json::json!({
                "threadId": original.id,
                "expectedRevision": revision,
                "selectedSkills": []
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        engine.skills(&original.id).await.unwrap()["data"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        engine.skills(&original.id).await.unwrap()["loaded"],
        serde_json::json!({})
    );
    let read = engine
        .read_skill(&original.id, reference("v1"), "check.md", 0, 8192)
        .await
        .unwrap();
    assert_eq!(read["text"], "supporting resource");
    fs::write(resources.path().join("SKILL.md"), "new instructions").unwrap();
    engine.install_default_skills(vec![location("v2")]).unwrap();
    let next = engine.create("/workspace".into()).await.unwrap();
    assert_eq!(
        engine.skills(&original.id).await.unwrap()["data"][0]["revision"],
        "v1"
    );
    assert_eq!(
        engine.skills(&next.id).await.unwrap()["data"][0]["revision"],
        "v2"
    );
    assert_eq!(
        engine
            .read_skill(&original.id, reference("v1"), "SKILL.md", 0, 8192)
            .await
            .unwrap()["text"],
        "new instructions"
    );
    assert!(
        engine
            .read_skill(&original.id, reference("v2"), "SKILL.md", 0, 8192)
            .await
            .is_err()
    );
    engine.shutdown().await;
    drop(engine);
    let engine =
        Engine::open(state.path(), Arc::new(UnconfiguredModel), Limits::default()).unwrap();
    engine.install_default_skills(vec![location("v2")]).unwrap();
    let restored = engine.read(&next.id, true).await.unwrap();
    assert_eq!(
        restored
            .desktop
            .unwrap()
            .configuration
            .profile
            .unwrap()
            .skills,
        [reference("v2")]
    );
    assert_eq!(
        engine
            .read_skill(&next.id, reference("v2"), "SKILL.md", 0, 8192)
            .await
            .unwrap()["text"],
        "new instructions"
    );
    engine.shutdown().await;
}

fn local_skill(root: &std::path::Path) -> SkillLocation {
    SkillLocation {
        id: "fireworks-tech-graph".into(),
        revision: "local-v1".into(),
        root: root.into(),
        metadata: Some(SkillMetadata {
            name: "Technical diagrams".into(),
            description: "Draw a technical diagram using references.".into(),
        }),
    }
}

#[tokio::test]
async fn local_skills_read_current_files_in_pages_without_loading_attachments_at_startup() {
    use std::io::{Seek, SeekFrom, Write};
    let state = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("SKILL.md"), "original body").unwrap();
    fs::create_dir(root.path().join("assets")).unwrap();
    let path = root.path().join("assets/sample-style1-flat.png");
    let mut file = fs::File::create(&path).unwrap();
    file.set_len(4 * 1024 * 1024).unwrap();
    file.seek(SeekFrom::Start(300 * 1024)).unwrap();
    file.write_all(&[0x89, 0x50, 0x4e, 0x47]).unwrap();
    let engine =
        Engine::open(state.path(), Arc::new(UnconfiguredModel), Limits::default()).unwrap();
    let location = local_skill(root.path());
    let reference = VersionRef {
        id: location.id.clone(),
        revision: location.revision.clone(),
    };
    engine.install_default_skills(vec![location]).unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    let listing = engine.skills(&thread.id).await.unwrap();
    assert_eq!(listing["data"][0]["name"], "Technical diagrams");
    assert!(listing["data"][0]["resources"].is_null());
    assert_eq!(listing["loaded"], serde_json::json!({}));
    let page = engine
        .read_skill(
            &thread.id,
            reference.clone(),
            "assets/sample-style1-flat.png",
            300 * 1024,
            4,
        )
        .await
        .unwrap();
    assert_eq!(page["sizeBytes"], 4 * 1024 * 1024);
    assert_eq!(page["dataBase64"], "iVBORw==");
    assert_eq!(page["nextOffset"], 300 * 1024 + 4);
    assert_eq!(page["eof"], false);
    fs::write(root.path().join("SKILL.md"), "edited after startup").unwrap();
    fs::write(&path, "new asset").unwrap();
    for (resource, expected) in [
        ("SKILL.md", "edited after startup"),
        ("assets/sample-style1-flat.png", "new asset"),
    ] {
        assert_eq!(
            engine
                .read_skill(&thread.id, reference.clone(), resource, 0, 8192)
                .await
                .unwrap()["text"],
            expected
        );
    }
    assert!(
        engine
            .read_skill(&thread.id, reference.clone(), "SKILL.md", 0, 8193)
            .await
            .is_err()
    );
    assert!(
        engine
            .read_skill(&thread.id, reference.clone(), "SKILL.md", 1000, 8192)
            .await
            .is_err()
    );
    let eof = engine
        .read_skill(
            &thread.id,
            reference.clone(),
            "assets/sample-style1-flat.png",
            9,
            8192,
        )
        .await
        .unwrap();
    assert_eq!(eof["text"], "");
    assert_eq!(eof["eof"], true);
    fs::remove_file(&path).unwrap();
    assert!(matches!(
        engine
            .read_skill(
                &thread.id,
                reference.clone(),
                "assets/sample-style1-flat.png",
                0,
                8192
            )
            .await,
        Err(areal_engine::Error::NotFound)
    ));
    assert_eq!(
        engine
            .read_skill(&thread.id, reference, "SKILL.md", 0, 8192)
            .await
            .unwrap()["text"],
        "edited after startup"
    );
    engine.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn lazy_reads_reject_parent_paths_links_and_special_files_without_poisoning_the_skill() {
    use std::os::unix::{ffi::OsStrExt, fs::symlink};
    let state = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(root.path().join("SKILL.md"), "body").unwrap();
    fs::write(outside.path().join("secret"), "private").unwrap();
    let engine =
        Engine::open(state.path(), Arc::new(UnconfiguredModel), Limits::default()).unwrap();
    let location = local_skill(root.path());
    let reference = VersionRef {
        id: location.id.clone(),
        revision: location.revision.clone(),
    };
    engine.install_default_skills(vec![location]).unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    // 安装后引入链接，证明读取时仍检查边界，而非仅在发现阶段校验。
    symlink(outside.path().join("secret"), root.path().join("link")).unwrap();
    symlink(outside.path(), root.path().join("linked-dir")).unwrap();
    symlink("SKILL.md", root.path().join("internal-link")).unwrap();
    // 直接创建 FIFO，避免并发重启测试的目录锁在 fork/exec 窗口被子进程继承。
    let fifo = std::ffi::CString::new(root.path().join("fifo").as_os_str().as_bytes()).unwrap();
    // CString 在调用期间有效，权限位只授予当前用户读写。
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    for resource in [
        "../secret",
        "/etc/passwd",
        "link",
        "linked-dir/secret",
        "internal-link",
        "fifo",
        ".",
        "",
    ] {
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            engine.read_skill(&thread.id, reference.clone(), resource, 0, 8192),
        )
        .await
        .unwrap();
        assert!(result.is_err(), "accepted {resource}");
    }
    assert_eq!(
        engine
            .read_skill(&thread.id, reference, "SKILL.md", 0, 8192)
            .await
            .unwrap()["text"],
        "body"
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn explicit_deployments_accept_large_assets_and_legacy_catalogs_without_content_snapshots() {
    let state = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let body = "---\nname: Diagram templates\ndescription: Use this skill for technical diagrams.\n---\noriginal";
    fs::write(root.path().join("SKILL.md"), body).unwrap();
    let large = root.path().join("large.png");
    fs::File::create(&large)
        .unwrap()
        .set_len(4 * 1024 * 1024)
        .unwrap();
    // 旧持久目录的内容哈希不再阻止同一引用读取当前磁盘内容。
    fs::create_dir_all(state.path().join("desktop")).unwrap();
    fs::write(
        state.path().join("desktop/catalog.json"),
        r#"{"skillHashes":{"diagram/v1":"legacy-content-hash"}}"#,
    )
    .unwrap();
    let deployment = root.path().join("deployment.json");
    fs::write(&deployment, serde_json::to_vec(&serde_json::json!({
        "skills":[{"id":"diagram","revision":"v1","root":"."}],
        "profiles":[{"id":"diagrams","revision":"v1","displayName":"Diagrams","instructions":"", "skills":[{"id":"diagram","revision":"v1"}]}]
    })).unwrap()).unwrap();
    let engine =
        Engine::open(state.path(), Arc::new(UnconfiguredModel), Limits::default()).unwrap();
    engine.install_deployment(&deployment).unwrap();
    let profile = engine
        .profile(&VersionRef {
            id: "diagrams".into(),
            revision: "v1".into(),
        })
        .unwrap();
    assert_eq!(profile.skills.len(), 1);
    let mut location = local_skill(root.path());
    location.id = "diagram".into();
    location.revision = "v1".into();
    location.metadata = None;
    engine
        .install_default_skills(vec![location.clone()])
        .unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    let reference = VersionRef {
        id: "diagram".into(),
        revision: "v1".into(),
    };
    let listing = engine.skills(&thread.id).await.unwrap();
    assert_eq!(listing["data"][0]["name"], "Diagram templates");
    assert_eq!(
        listing["data"][0]["description"],
        "Use this skill for technical diagrams."
    );
    assert!(listing["data"][0]["resources"].is_null());
    let page = engine
        .read_skill(
            &thread.id,
            reference.clone(),
            "large.png",
            3 * 1024 * 1024,
            8192,
        )
        .await
        .unwrap();
    assert_eq!(page["sizeBytes"], 4 * 1024 * 1024);
    assert_eq!(page["nextOffset"], 3 * 1024 * 1024 + 8192);
    fs::write(root.path().join("SKILL.md"), "changed after registration").unwrap();
    assert_eq!(
        engine
            .read_skill(&thread.id, reference.clone(), "SKILL.md", 0, 8192)
            .await
            .unwrap()["text"],
        "changed after registration"
    );
    assert_eq!(
        engine.skills(&thread.id).await.unwrap()["data"][0]["name"],
        "Diagram templates"
    );
    engine.install_deployment(&deployment).unwrap();
    let saved: serde_json::Value =
        serde_json::from_slice(&fs::read(state.path().join("desktop/catalog.json")).unwrap())
            .unwrap();
    assert!(saved.get("skillHashes").is_none());
    engine.shutdown().await;
    drop(engine);
    let engine =
        Engine::open(state.path(), Arc::new(UnconfiguredModel), Limits::default()).unwrap();
    engine.install_deployment(&deployment).unwrap();
    assert_eq!(
        engine
            .read_skill(&thread.id, reference, "SKILL.md", 0, 8192)
            .await
            .unwrap()["text"],
        "changed after registration"
    );
    engine.shutdown().await;
}

struct ReadSkillPages;
#[async_trait]
impl areal_engine::model::Model for ReadSkillPages {
    fn name(&self) -> &str {
        "skill-pages-fixture"
    }
    async fn stream(
        &self,
        _: Vec<areal_engine::model::Message>,
    ) -> anyhow::Result<areal_engine::model::ModelStream> {
        unreachable!()
    }
    async fn chat(
        &self,
        messages: Vec<areal_engine::model::Message>,
        _: Vec<serde_json::Value>,
    ) -> anyhow::Result<areal_engine::model::ModelStream> {
        use areal_engine::model::{ModelEvent, ToolCall};
        let results: Vec<_> = messages.iter().filter(|m| m.role == "tool").collect();
        let events = if results.is_empty() {
            ["SKILL.md","binary.bin"].into_iter().map(|resource|ModelEvent::ToolCall(ToolCall {
                id:resource.into(),name:"skill_read".into(),arguments:json!({"skill":{"id":"fireworks-tech-graph","revision":"local-v1"},"resource":resource}).to_string()
            })).collect::<Vec<_>>()
        } else {
            assert_eq!(results.len(), 2);
            let pages: Vec<serde_json::Value> = results
                .iter()
                .map(|m| serde_json::from_str(&m.text_content()).unwrap())
                .collect();
            assert_eq!(pages[0]["text"], "完整技能页");
            assert!(pages[0].get("dataBase64").is_none());
            assert_eq!(pages[0]["nextOffset"], "完整技能页".len());
            assert_eq!(pages[0]["eof"], true);
            assert_eq!(pages[1]["text"], serde_json::Value::Null);
            assert_eq!(pages[1]["dataBase64"], "/wA=");
            assert_eq!(pages[1]["nextOffset"], 2);
            vec![ModelEvent::text("verified exact text and binary pages")]
        };
        Ok(Box::pin(futures_util::stream::iter(
            events.into_iter().map(Ok),
        )))
    }
}
#[tokio::test]
async fn model_skill_reads_avoid_duplicate_text_bytes_while_public_api_retains_binary_contract() {
    let state = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("SKILL.md"), "完整技能页").unwrap();
    fs::write(root.path().join("binary.bin"), [0xff, 0]).unwrap();
    let engine = Engine::open(state.path(), Arc::new(ReadSkillPages), Limits::default()).unwrap();
    engine
        .install_default_skills(vec![local_skill(root.path())])
        .unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    let reference = VersionRef {
        id: "fireworks-tech-graph".into(),
        revision: "local-v1".into(),
    };
    let page = engine
        .read_skill(&thread.id, reference.clone(), "SKILL.md", 0, 8192)
        .await
        .unwrap();
    assert!(page["dataBase64"].is_string());
    let partial = engine
        .read_skill(&thread.id, reference, "SKILL.md", 1, 1)
        .await
        .unwrap();
    assert!(partial["text"].is_null());
    assert!(partial["dataBase64"].is_string());
    assert_eq!(partial["nextOffset"], 2);
    engine
        .start(
            &thread.id,
            vec![areal_protocol::Input::text(
                "Read the fixture skill and its binary reference",
            )],
        )
        .await
        .unwrap();
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), engine.wait(&thread.id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        result.turns.last().unwrap().status,
        areal_protocol::TurnStatus::Completed,
        "{:?}",
        result.turns.last().unwrap().error
    );
    engine.shutdown().await;
}
