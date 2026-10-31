use areal_plugins::Store;
use std::fs;

fn fixture() -> (tempfile::TempDir, Store) {
    let temp = tempfile::tempdir().unwrap();
    for directory in [
        ".agents/plugins",
        "pkg/.claude-plugin",
        "pkg/commands",
        "pkg/agents",
    ] {
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
    let store = Store::open(temp.path().join("store"), temp.path().into(), None).unwrap();
    (temp, store)
}
#[test]
fn immutable_commands_keep_namespace_and_literal_arguments() {
    let (temp, store) = fixture();
    fs::write(
        temp.path().join("pkg/commands/review.md"),
        "---\ndescription: Review changes\nargument-hint: '[files]'\n---\nReview $ARGUMENTS",
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
    fs::write(temp.path().join("pkg/commands/review.md"), "changed").unwrap();
    let component = store.enabled_component(&detail.id).unwrap();
    let command = &component.commands[0];
    assert_eq!(command.name, "sample:review");
    assert_eq!(command.identity.installed_digest, detail.review_digest());
    assert_eq!(
        command.expand("$(touch /never) $ARGUMENTS").unwrap(),
        "Review $(touch /never) $ARGUMENTS"
    );
}
#[test]
fn supported_agent_fields_and_unsupported_permissions_are_component_facts() {
    let (temp, store) = fixture();
    fs::write(temp.path().join("pkg/agents/reviewer.md"), "---\nname: reviewer\ndescription: Review changes\ntools: fs_read, file_search\n---\nReview the change.").unwrap();
    fs::write(
        temp.path().join("pkg/agents/unsafe.md"),
        "---\npermissionMode: bypassPermissions\n---\nNever import this agent.",
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
    let component = store.enabled_component(&detail.id).unwrap();
    assert_eq!(component.agents.len(), 1);
    assert_eq!(
        component.agents[0].tool_allowlist.as_ref().unwrap(),
        &["fs_read", "file_search"]
    );
    assert!(component.support.components.iter().any(|row| {
        row.source_field == "agents/unsafe.md"
            && row
                .reason_codes
                .contains(&"templateSemanticsUnsupported".into())
    }));
}

#[test]
fn repeated_command_arguments_are_bounded_before_expansion() {
    let (temp, store) = fixture();
    fs::write(
        temp.path().join("pkg/commands/repeated.md"),
        "$ARGUMENTS".repeat((256 * 1024) / "$ARGUMENTS".len()),
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
    let component = store.enabled_component(&detail.id).unwrap();
    let command = &component.commands[0];
    assert!(command.expand(&"x".repeat(32 * 1024)).is_err());
    assert_eq!(
        command.expand("x").unwrap(),
        "x".repeat((256 * 1024) / "$ARGUMENTS".len())
    );
}

#[test]
fn command_expansion_preserves_literal_arguments_within_input_budget() {
    let (temp, store) = fixture();
    fs::write(
        temp.path().join("pkg/commands/review.md"),
        "Start $ARGUMENTS end $ARGUMENTS",
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
    let component = store.enabled_component(&detail.id).unwrap();
    let command = &component.commands[0];
    assert_eq!(
        command.expand("$ARGUMENTS $(literal)").unwrap(),
        "Start $ARGUMENTS $(literal) end $ARGUMENTS $(literal)"
    );
}
