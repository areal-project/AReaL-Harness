use areal_plugins::Store;
use std::fs;

#[test]
fn development_refresh_preserves_disabled_selection_and_immutable_old_command() {
    let temp = tempfile::tempdir().unwrap();
    for directory in [".agents/plugins", "pkg/.claude-plugin", "pkg/commands"] {
        fs::create_dir_all(temp.path().join(directory)).unwrap();
    }
    fs::write(
        temp.path().join(".agents/plugins/marketplace.json"),
        r#"{"name":"local","plugins":[{"name":"sample","source":"./pkg"}]}"#,
    )
    .unwrap();
    fs::write(
        temp.path().join("pkg/.claude-plugin/plugin.json"),
        r#"{"name":"sample"}"#,
    )
    .unwrap();
    let command = temp.path().join("pkg/commands/review.md");
    fs::write(&command, "old body").unwrap();
    let root = temp.path().join("store");
    let store = Store::open(root.clone(), temp.path().into(), None).unwrap();
    let candidate = store.read("sample@local").unwrap();
    let installed = store
        .install(
            &candidate.id,
            "user",
            candidate.revision,
            &candidate.source,
            candidate.review_digest(),
        )
        .unwrap();
    let old = store.enabled_component(&candidate.id).unwrap();
    let list = store
        .development_link(
            &candidate.id,
            installed.revision,
            installed.installed_digest.as_deref().unwrap(),
        )
        .unwrap();
    store
        .configure(&candidate.id, "user", false, list.revision)
        .unwrap();
    fs::write(&command, "new body").unwrap();
    assert!(store.refresh_development_links().unwrap().changed);
    let updated = store.read(&candidate.id).unwrap();
    assert!(!updated.enabled);
    assert_ne!(updated.installed_digest, installed.installed_digest);
    assert_eq!(old.commands[0].body, "old body");
    assert_eq!(
        store.installed_components().unwrap()[0].commands[0].body,
        "new body"
    );
    let revision = updated.revision;
    let reopened = Store::open(root, temp.path().into(), None).unwrap();
    assert!(!reopened.refresh_development_links().unwrap().changed);
    assert_eq!(reopened.list().unwrap().revision, revision);
    reopened
        .development_unlink(&candidate.id, revision)
        .unwrap();
    fs::write(&command, "unlinked body").unwrap();
    assert!(!reopened.refresh_development_links().unwrap().changed);
}

#[test]
fn invalid_development_source_does_not_starve_other_links() {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir_all(temp.path().join(".agents/plugins")).unwrap();
    fs::write(temp.path().join(".agents/plugins/marketplace.json"), r#"{"name":"local","plugins":[{"name":"broken","source":"./broken"},{"name":"working","source":"./working"}]}"#).unwrap();
    for name in ["broken", "working"] {
        fs::create_dir_all(temp.path().join(name).join(".claude-plugin")).unwrap();
        fs::create_dir_all(temp.path().join(name).join("commands")).unwrap();
        fs::write(
            temp.path().join(name).join(".claude-plugin/plugin.json"),
            format!(r#"{{"name":"{name}"}}"#),
        )
        .unwrap();
        fs::write(temp.path().join(name).join("commands/run.md"), "old").unwrap();
    }
    let store = Store::open(temp.path().join("store"), temp.path().into(), None).unwrap();
    for name in ["broken", "working"] {
        let detail = store.read(&format!("{name}@local")).unwrap();
        let installed = store
            .install(
                &detail.id,
                "user",
                detail.revision,
                &detail.source,
                detail.review_digest(),
            )
            .unwrap();
        store
            .development_link(
                &detail.id,
                installed.revision,
                installed.installed_digest.as_deref().unwrap(),
            )
            .unwrap();
    }
    fs::write(
        temp.path().join("broken/.claude-plugin/plugin.json"),
        "invalid",
    )
    .unwrap();
    fs::write(temp.path().join("working/commands/run.md"), "new").unwrap();
    let report = store.refresh_development_links().unwrap();
    assert!(report.changed);
    assert!(report.errors.contains_key("broken@local"));
    assert_eq!(
        store.enabled_component("working@local").unwrap().commands[0].body,
        "new"
    );
    assert_eq!(
        store.enabled_component("broken@local").unwrap().commands[0].body,
        "old"
    );
}
