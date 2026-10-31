use areal_plugins::{PluginConfigValue, Store};
use std::{collections::BTreeMap, fs};

fn fixture() -> (tempfile::TempDir, Store) {
    let temp = tempfile::tempdir().unwrap();
    for directory in [".agents/plugins", "pkg/.zcode-plugin"] {
        fs::create_dir_all(temp.path().join(directory)).unwrap();
    }
    fs::write(
        temp.path().join(".agents/plugins/marketplace.json"),
        r#"{"name":"local","plugins":[{"name":"sample","source":"./pkg"}]}"#,
    )
    .unwrap();
    fs::write(temp.path().join("pkg/.zcode-plugin/plugin.json"), r#"{"name":"sample","userConfig":{"device":{"type":"string","default":"iPhone 16"},"token":{"type":"string","sensitive":true,"required":true}},"mcpServers":{"fixture":{"command":"fixture-not-executed","env":{"DEVICE":"${user_config.device}","TOKEN":"${user_config.token}"}}}}"#).unwrap();
    let store = Store::open(temp.path().join("store"), temp.path().into(), None).unwrap();
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
    (temp, store)
}
#[test]
fn configuration_has_private_refs_public_presence_and_cas() {
    let (_temp, store) = fixture();
    let before = store.read("sample@local").unwrap();
    assert_eq!(before.user_configuration.missing_required, vec!["token"]);
    let values = BTreeMap::from([(
        "token".into(),
        PluginConfigValue::SecretRef("private-canary-reference".into()),
    )]);
    let list = store
        .configure_user_values(
            &before.id,
            before.revision,
            before.installed_digest.as_deref().unwrap(),
            values.clone(),
        )
        .unwrap();
    let public = serde_json::to_string(&list).unwrap();
    assert!(!public.contains("private-canary-reference"));
    assert!(
        store
            .configure_user_values(
                &before.id,
                before.revision,
                before.installed_digest.as_deref().unwrap(),
                values
            )
            .is_err()
    );
    let component = store.enabled_component(&before.id).unwrap();
    assert_eq!(component.digest, before.installed_digest.unwrap());
    assert!(component.user_configuration.revision > 0);
    let bindings = component
        .user_configuration
        .mcp_bindings(&component.user_config_schema, |reference| {
            assert_eq!(reference, "private-canary-reference");
            Ok("secret-canary-value".into())
        })
        .unwrap();
    assert_eq!(bindings["device"].value, "iPhone 16");
    let declaration = &component.mcp_documents[0].declaration;
    assert!(
        declaration
            .normalize(&component.root, &component.data_root)
            .is_err()
    );
    let bound = declaration.bind_user_config(&bindings).unwrap();
    let normalized = bound
        .normalize(&component.root, &component.data_root)
        .unwrap();
    assert_eq!(normalized.servers.len(), 1);
    assert!(
        !serde_json::to_string(&normalized.servers["fixture"].redacted_view())
            .unwrap()
            .contains("secret-canary")
    );
}
#[test]
fn secret_plaintext_type_and_sensitive_defaults_are_rejected() {
    let (temp, store) = fixture();
    let before = store.read("sample@local").unwrap();
    assert!(
        store
            .configure_user_values(
                &before.id,
                before.revision,
                before.installed_digest.as_deref().unwrap(),
                BTreeMap::from([(
                    "token".into(),
                    PluginConfigValue::String("plaintext".into())
                )])
            )
            .is_err()
    );
    fs::write(temp.path().join("pkg/.zcode-plugin/plugin.json"), r#"{"name":"sample","userConfig":{"token":{"type":"string","sensitive":true,"default":"secret-default-canary"}}}"#).unwrap();
    let candidate = store.read("sample@local").unwrap();
    assert!(
        !serde_json::to_string(&candidate)
            .unwrap()
            .contains("secret-default-canary")
    );
    assert!(
        candidate
            .component_support
            .unwrap()
            .compatibility
            .reason_codes
            .contains(&"userConfigUnsupported".into())
    );
}

#[test]
fn unsupported_configuration_consumers_are_explicit_and_do_not_execute() {
    let (temp, store) = fixture();
    fs::write(temp.path().join("pkg/.zcode-plugin/plugin.json"), r#"{"name":"sample","userConfig":{"token":{"type":"string","sensitive":true}},"hooks":{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"${user_config.token}"}]}]}}}"#).unwrap();
    let candidate = store.read("sample@local").unwrap();
    assert!(
        candidate
            .component_support
            .as_ref()
            .unwrap()
            .compatibility
            .reason_codes
            .contains(&"userConfigPositionUnsupported".into())
    );
    store
        .install(
            &candidate.id,
            "user",
            candidate.revision,
            &candidate.source,
            candidate.review_digest(),
        )
        .unwrap();
    assert!(
        store.installed_components().unwrap()[0]
            .hook_documents
            .is_empty()
    );
}

#[test]
fn configuration_references_in_external_documents_are_rejected() {
    let (temp, store) = fixture();
    fs::create_dir_all(temp.path().join("pkg/hooks")).unwrap();
    fs::write(temp.path().join("pkg/hooks/hooks.json"), r#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"${user_config.token}"}]}]}}"#).unwrap();
    fs::write(
        temp.path().join("pkg/.zcode-plugin/plugin.json"),
        r#"{"name":"sample","userConfig":{"token":{"type":"string","sensitive":true}}}"#,
    )
    .unwrap();
    let candidate = store.read("sample@local").unwrap();
    assert!(
        candidate
            .component_support
            .unwrap()
            .compatibility
            .reason_codes
            .contains(&"userConfigPositionUnsupported".into())
    );
}

#[test]
fn configuration_epoch_survives_package_changes_and_uninstall_without_values() {
    let (temp, store) = fixture();
    let installed = store.read("sample@local").unwrap();
    store
        .configure_user_values(
            &installed.id,
            installed.revision,
            installed.installed_digest.as_deref().unwrap(),
            BTreeMap::from([(
                "token".into(),
                PluginConfigValue::SecretRef("retired-private-reference".into()),
            )]),
        )
        .unwrap();
    let configured = store.read(&installed.id).unwrap();
    let epoch = configured.user_configuration.revision;
    assert!(epoch > 0);
    fs::write(temp.path().join("pkg/new-file"), "new immutable package").unwrap();
    let candidate = store.read(&installed.id).unwrap();
    let updated = store
        .install(
            &candidate.id,
            "user",
            candidate.revision,
            &candidate.source,
            candidate.review_digest(),
        )
        .unwrap();
    assert_ne!(updated.installed_digest, installed.installed_digest);
    let current = store.enabled_component(&installed.id).unwrap();
    assert_eq!(current.user_configuration.revision, epoch);
    assert!(current.user_configuration.values.is_empty());
    assert_eq!(current.user_configuration.installed_digest, current.digest);
    assert_eq!(updated.user_configuration.missing_required, vec!["token"]);
    assert!(
        !serde_json::to_string(&updated)
            .unwrap()
            .contains("retired-private-reference")
    );
    store.uninstall(&installed.id, updated.revision).unwrap();
    let candidate = store.read(&installed.id).unwrap();
    store
        .install(
            &candidate.id,
            "user",
            candidate.revision,
            &candidate.source,
            candidate.review_digest(),
        )
        .unwrap();
    let reopened = Store::open(temp.path().join("store"), temp.path().into(), None).unwrap();
    let reinstalled = reopened.enabled_component(&installed.id).unwrap();
    assert_eq!(reinstalled.user_configuration.revision, epoch);
    assert!(reinstalled.user_configuration.values.is_empty());
}
