use super::*;

#[test]
fn public_receipts_match_the_original_javascript_field_for_field() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let node = std::env::var_os("AREAL_GUI_NODE_BIN")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| "node".into());
    let output = std::process::Command::new(node)
        .current_dir(&root)
        .arg("clients/gui/scripts/library-rust-reference.cjs")
        .output()
        .expect("Node is required for library differential acceptance");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let fixture: Value = serde_json::from_slice(&output.stdout).unwrap();
    let view = ContextView {
        projects: serde_json::from_value(fixture["context"]["projects"].clone()).unwrap(),
        summaries: serde_json::from_value(fixture["context"]["summaries"].clone()).unwrap(),
        readable: vec![],
    };
    for case in fixture["cases"].as_array().unwrap() {
        let before = case["before"].clone();
        let mut actual = before.clone();
        let previous_layout = layout(&actual);
        let result = apply(&mut actual, &case["request"], &view);
        assert_eq!(
            result.is_err(),
            case["failed"] == true,
            "request {}: {result:?}",
            case["request"]
        );
        if result.is_err() {
            continue;
        }
        if layout(&actual) != previous_layout {
            actual["sidebarRevision"] = json!(before["sidebarRevision"].as_u64().unwrap() + 1);
        }
        assert_eq!(
            crate::shell::library_result(actual.clone()).unwrap(),
            crate::shell::library_result(case["after"].clone()).unwrap(),
            "{}",
            case["request"]
        );
        assert_eq!(
            actual["settings"]["httpProxy"],
            before["settings"]["httpProxy"]
        );
        assert_eq!(
            actual["settings"]["hardwareAcceleration"],
            before["settings"]["hardwareAcceleration"]
        );
    }
}
#[test]
fn stale_drop_is_transactional_and_new_sections_have_fresh_ids() {
    let mut state = json!({"projects":{},"threads":{},"projectOrder":[],"sections":[],"sidebarThreadOrder":[],"sidebarRevision":0,"settings":{}});
    apply(
        &mut state,
        &json!({"operation":"createSection","title":" Group "}),
        &ContextView::default(),
    )
    .unwrap();
    assert_eq!(state["sections"][0]["title"], "Group");
    uuid::Uuid::parse_str(state["sections"][0]["id"].as_str().unwrap()).unwrap();
    let prior = state.clone();
    assert!(
        apply(
            &mut state,
            &json!({"operation":"dropSidebar","expectedSidebarRevision":1}),
            &ContextView::default()
        )
        .is_err()
    );
    assert_eq!(state, prior);
}
