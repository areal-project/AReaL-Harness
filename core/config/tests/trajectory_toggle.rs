use areal_config::{ConfigErrorKind, ConfigInputs, load_management_config, set_trajectory_enabled};
use std::fs;

fn fixture(text: &str) -> (tempfile::TempDir, ConfigInputs) {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("config.toml");
    fs::write(&path, text).unwrap();
    let inputs = ConfigInputs {
        cwd: root.path().into(),
        homedir: Some(root.path().into()),
        config_file: Some(path),
        ..Default::default()
    };
    (root, inputs)
}

#[test]
fn toggling_preserves_other_values_comments_and_queue_identity_and_fences_stale_writes() {
    let original = "schema_version=2\n# retained model and credentials reference\n[model]\nname='fixture'\n[model.providers.default]\nendpoint='http://127.0.0.1:9/v1/chat/completions'\n[trajectory]\n# receiver retained\nenabled=false\nendpoint='https://collector.example/otlp'\nheaders_env='TEST_HEADERS'\nmax_records=42\n";
    let (_root, inputs) = fixture(original);
    let before = load_management_config(&inputs).unwrap();
    let on =
        set_trajectory_enabled(&inputs, true, Some(&before.trajectory.source_revision)).unwrap();
    assert!(on.trajectory.enabled);
    assert_eq!(on.trajectory.source_id, before.trajectory.source_id);
    assert_eq!(on.trajectory.spool_dir, before.trajectory.spool_dir);
    let path = inputs.config_file.as_ref().unwrap();
    let enabled_text = fs::read_to_string(path).unwrap();
    assert!(enabled_text.contains("# receiver retained"));
    assert!(enabled_text.starts_with(original.split("enabled=false").next().unwrap()));
    assert_eq!(
        enabled_text,
        original.replace("enabled=false", "enabled=true")
    );
    assert_eq!(
        load_management_config(&inputs)
            .unwrap()
            .trajectory
            .source_revision,
        on.trajectory.source_revision
    );
    set_trajectory_enabled(&inputs, true, Some(&on.trajectory.source_revision)).unwrap();
    assert_eq!(fs::read_to_string(path).unwrap(), enabled_text);
    let error = set_trajectory_enabled(&inputs, false, Some(&before.trajectory.source_revision))
        .err()
        .unwrap();
    assert_eq!(error.kind, ConfigErrorKind::Conflict);
    assert_eq!(fs::read_to_string(path).unwrap(), enabled_text);
    let off = set_trajectory_enabled(&inputs, false, Some(&on.trajectory.source_revision)).unwrap();
    assert!(!off.trajectory.enabled);
    assert_eq!(off.trajectory.max_records, 42);
    assert_eq!(off.trajectory.headers_env.as_deref(), Some("TEST_HEADERS"));
    assert!(!off.trajectory.spool_dir.exists());
}

#[test]
fn inline_configuration_is_supported_and_writer_lock_rejects_overwrite() {
    let (root, inputs) = fixture(
        "schema_version=2\ntrajectory={enabled=false,endpoint='https://collector.example'}\n",
    );
    let lock = fs::File::create(root.path().join(".config.toml.lock")).unwrap();
    fs2::FileExt::lock_exclusive(&lock).unwrap();
    assert_eq!(
        set_trajectory_enabled(&inputs, true, None)
            .err()
            .unwrap()
            .kind,
        ConfigErrorKind::Conflict
    );
    fs2::FileExt::unlock(&lock).unwrap();
    assert!(
        set_trajectory_enabled(&inputs, true, None)
            .unwrap()
            .trajectory
            .enabled
    );
}

#[test]
fn enabling_requires_existing_valid_receiver_and_rejects_unknown_environment_controls() {
    for endpoint in [
        "",
        "garbage",
        "https://name:secret@collector.example",
        "https://collector.example?token=x",
    ] {
        let text =
            format!("schema_version=2\n[trajectory]\nenabled=false\nendpoint='{endpoint}'\n");
        let (_root, inputs) = fixture(&text);
        assert!(set_trajectory_enabled(&inputs, true, None).is_err());
        assert_eq!(
            fs::read_to_string(inputs.config_file.as_ref().unwrap()).unwrap(),
            text
        );
    }
    let text =
        "schema_version=2\n[trajectory]\nenabled=false\nendpoint='https://collector.example'\n";
    let (_root, mut inputs) = fixture(text);
    inputs
        .env
        .insert("AREAL_HARNESS_TRAJECTORY_ENABLED".into(), "false".into());
    assert_eq!(
        set_trajectory_enabled(&inputs, true, None)
            .err()
            .unwrap()
            .kind,
        ConfigErrorKind::UnknownField
    );
    assert_eq!(
        fs::read_to_string(inputs.config_file.as_ref().unwrap()).unwrap(),
        text
    );
    fs::remove_file(inputs.config_file.as_ref().unwrap()).unwrap();
    assert!(set_trajectory_enabled(&inputs, true, None).is_err());
    assert!(!inputs.config_file.as_ref().unwrap().exists());
}

#[cfg(unix)]
#[test]
fn links_are_rejected_and_private_file_permissions_are_preserved() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let (root, mut inputs) = fixture(
        "schema_version=2\n[trajectory]\nenabled=false\nendpoint='https://collector.example'\n",
    );
    let path = inputs.config_file.clone().unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    set_trajectory_enabled(&inputs, true, None).unwrap();
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let alias = root.path().join("alias.toml");
    symlink(&path, &alias).unwrap();
    inputs.config_file = Some(alias.clone());
    assert!(set_trajectory_enabled(&inputs, false, None).is_err());
    fs::remove_file(&alias).unwrap();
    fs::hard_link(&path, &alias).unwrap();
    assert!(set_trajectory_enabled(&inputs, false, None).is_err());
    assert!(load_management_config(&inputs).unwrap().trajectory.enabled);
}
