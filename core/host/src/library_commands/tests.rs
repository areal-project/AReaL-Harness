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

#[test]
fn non_navigation_settings_validate_normalize_and_reject_invalid_values() {
    let mut state = json!({"projects":{},"threads":{},"projectOrder":[],"sections":[],"sidebarThreadOrder":[],"sidebarRevision":0,"settings":{}});
    apply(
        &mut state,
        &json!({"operation":"settings","key":"preventSleep","value":true}),
        &ContextView::default(),
    )
    .unwrap();
    apply(
        &mut state,
        &json!({"operation":"settings","key":"busyEnter","value":"steer"}),
        &ContextView::default(),
    )
    .unwrap();
    apply(
        &mut state,
        &json!({"operation":"settings","key":"terminalFontFamily","value":"  JetBrains Mono  "}),
        &ContextView::default(),
    )
    .unwrap();
    apply(
        &mut state,
        &json!({"operation":"settings","key":"httpProxy","value":"http://127.0.0.1:7890/"}),
        &ContextView::default(),
    )
    .unwrap();
    apply(
        &mut state,
        &json!({"operation":"settings","key":"snapShot","value":{
            "snapShotEnabled":true,"snapShotIncludeAccessibility":true,
            "snapShotShortcut":{"kind":"both-shift-keys"},
            "snapShotPlaySound":true,"snapShotSound":"soft-pop",
            "snapShotFlash":true,"snapShotAnimations":true,"setupStep":"complete"
        }}),
        &ContextView::default(),
    )
    .unwrap();
    assert_eq!(state["settings"]["preventSleep"], true);
    assert_eq!(state["settings"]["busyEnter"], "steer");
    assert_eq!(state["settings"]["terminalFontFamily"], "JetBrains Mono");
    assert_eq!(state["settings"]["httpProxy"], "http://127.0.0.1:7890");
    assert_eq!(state["settings"]["snapShot"]["snapShotEnabled"], true);

    for invalid in [
        json!({"operation":"settings","key":"computerControlEnabled","value":true}),
        json!({"operation":"settings","key":"busyEnter","value":"unknown"}),
        json!({"operation":"settings","key":"httpProxy","value":"not-a-url"}),
        json!({"operation":"settings","key":"terminalFontFamily","value":"bad\nfont"}),
        json!({"operation":"settings","key":"snapShot","value":{
            "snapShotEnabled":true,"snapShotIncludeAccessibility":true,
            "snapShotShortcut":{"key":"s","metaKey":false,"ctrlKey":false,"shiftKey":false,"altKey":false,"modKey":false},
            "snapShotPlaySound":true,"snapShotSound":"soft-pop",
            "snapShotFlash":true,"snapShotAnimations":true
        }}),
    ] {
        assert_eq!(
            apply(&mut state, &invalid, &ContextView::default())
                .unwrap_err()
                .to_string(),
            "INVALID_PARAMS",
            "{invalid}"
        );
    }
}
