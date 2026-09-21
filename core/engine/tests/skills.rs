use areal_engine::{
    Engine, Limits,
    desktop::{SkillLocation, SkillMetadata},
    model::UnconfiguredModel,
};
use areal_protocol::desktop::VersionRef;
use std::{fs, sync::Arc};

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
    use std::os::unix::fs::symlink;
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
    assert!(
        std::process::Command::new("mkfifo")
            .arg(root.path().join("fifo"))
            .status()
            .unwrap()
            .success()
    );
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
