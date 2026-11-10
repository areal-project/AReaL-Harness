use super::*;

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
