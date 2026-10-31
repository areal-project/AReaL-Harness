use areal_plugins::Store;
use std::fs;

#[test]
fn empty_home_snapshot_and_doctor_do_not_create_files() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("absent/plugins");
    let snapshot = Store::read_snapshot(root.clone(), None, None, None).unwrap();
    assert_eq!(snapshot.revision, 0);
    assert!(snapshot.list.data.is_empty());
    assert!(!snapshot.runtime_observed);
    assert!(!snapshot.doctor().runtime_observed);
    assert!(!root.parent().unwrap().exists());
}

#[test]
fn malformed_state_is_reported_without_rewriting_it() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("state.json"), b"broken").unwrap();
    assert!(Store::read_snapshot(temp.path().into(), None, None, None).is_err());
    assert_eq!(fs::read(temp.path().join("state.json")).unwrap(), b"broken");
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
}

#[test]
fn offline_user_and_project_snapshots_keep_candidate_and_installed_identities() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let root = home.join("plugins");
    let project_a = temp.path().join("project-a");
    let project_b = temp.path().join("project-b");
    for directory in [
        home.join(".agents/plugins"),
        home.join("pkg/.claude-plugin"),
        home.join("pkg/commands"),
        project_a.clone(),
        project_b.clone(),
    ] {
        fs::create_dir_all(directory).unwrap();
    }
    fs::write(
        home.join(".agents/plugins/marketplace.json"),
        r#"{"name":"local","plugins":[{"name":"sample","source":"./pkg"}]}"#,
    )
    .unwrap();
    fs::write(
        home.join("pkg/.claude-plugin/plugin.json"),
        r#"{"name":"sample"}"#,
    )
    .unwrap();
    fs::write(home.join("pkg/commands/review.md"), "old").unwrap();
    let home = home.canonicalize().unwrap();
    let store = Store::open(root.clone(), project_a.clone(), Some(home.clone())).unwrap();
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
    store
        .configure(&candidate.id, "project", false, installed.revision)
        .unwrap();
    drop(store);
    let user =
        Store::read_snapshot(root.clone(), None, Some(home.clone()), Some(&candidate.id)).unwrap();
    assert!(user.detail.unwrap().enabled);
    let a = Store::read_snapshot(
        root.clone(),
        Some(project_a),
        Some(home.clone()),
        Some(&candidate.id),
    )
    .unwrap();
    assert!(!a.detail.unwrap().enabled);
    let b = Store::read_snapshot(
        root.clone(),
        Some(project_b),
        Some(home.clone()),
        Some(&candidate.id),
    )
    .unwrap();
    assert!(b.detail.unwrap().enabled);
    fs::write(home.join("pkg/commands/review.md"), "new").unwrap();
    let updated = Store::read_snapshot(root.clone(), None, Some(home.clone()), Some(&candidate.id))
        .unwrap()
        .detail
        .unwrap();
    assert_eq!(updated.installed_digest, installed.installed_digest);
    assert_ne!(
        updated.review_digest(),
        updated.installed_digest.as_deref().unwrap()
    );
    fs::rename(home.join("pkg"), home.join("removed-pkg")).unwrap();
    let state_before = fs::read(root.join("state.json")).unwrap();
    let names_before = fs::read_dir(&root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<std::collections::BTreeSet<_>>();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o555)).unwrap();
    let missing =
        Store::read_snapshot(root.clone(), None, Some(home), Some(&candidate.id)).unwrap();
    assert_eq!(
        missing.detail.unwrap().installed_digest,
        installed.installed_digest
    );
    assert_eq!(fs::read(root.join("state.json")).unwrap(), state_before);
    assert_eq!(
        fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<std::collections::BTreeSet<_>>(),
        names_before
    );
    fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
}
