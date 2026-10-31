use areal_plugins::Store;
use serde_json::{Value, json};
use std::{fs, path::Path};

const ID: &str = "sample@local";
fn write(root: &Path, path: &str, value: &str) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, value).unwrap();
}
fn fixture(manifest_path: &str, manifest: Value) -> tempfile::TempDir {
    let temp = tempfile::tempdir().unwrap();
    write(
        temp.path(),
        ".agents/plugins/marketplace.json",
        &json!({"name":"local","plugins":[{"name":"sample","source":"./pkg"}]}).to_string(),
    );
    write(
        temp.path(),
        &format!("pkg/{manifest_path}"),
        &manifest.to_string(),
    );
    write(
        temp.path(),
        "pkg/skills/example/SKILL.md",
        "---\nname: Example\ndescription: Fixture skill\n---\nbody",
    );
    temp
}
fn portable(extension: Value) -> Value {
    json!({"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"sample","extensions":extension})
}
fn open(temp: &tempfile::TempDir) -> Store {
    Store::open(temp.path().join("state"), temp.path().to_owned(), None).unwrap()
}
fn read(store: &Store) -> Value {
    serde_json::to_value(store.read(ID).unwrap()).unwrap()
}
fn install(store: &Store) -> Value {
    let detail = store.read(ID).unwrap();
    serde_json::to_value(
        store
            .install(
                ID,
                "user",
                detail.revision,
                &detail.source,
                &detail.source_digest,
            )
            .unwrap(),
    )
    .unwrap()
}
fn rows(detail: &Value, field: &str) -> Vec<Value> {
    detail[field]["components"]
        .as_array()
        .expect("exact-byte component report missing")
        .clone()
}

#[test]
fn supported_formats_have_digest_bound_skill_reports() {
    for (path, manifest, format) in [
        ("plugin.json", portable(json!({})), "portable1"),
        (
            ".codex-plugin/plugin.json",
            json!({"name":"sample"}),
            "codex",
        ),
        (
            ".claude-plugin/plugin.json",
            json!({"name":"sample"}),
            "claude",
        ),
        (
            ".cursor-plugin/plugin.json",
            json!({"name":"sample"}),
            "cursor",
        ),
    ] {
        let temp = fixture(path, manifest);
        let store = open(&temp);
        let detail = read(&store);
        assert_eq!(detail["componentSupport"]["digest"], detail["sourceDigest"]);
        assert_eq!(detail["componentSupport"]["manifestFormat"], format);
        assert_eq!(rows(&detail, "componentSupport")[0]["kind"], "skills");
        assert_eq!(rows(&detail, "componentSupport")[0]["status"], "supported");
        assert_eq!(
            detail["componentSupport"]["compatibility"]["state"],
            "allowed"
        );
        assert_eq!(detail["installedComponentSupport"], Value::Null);
        let installed = install(&store);
        assert_eq!(
            installed["installedComponentSupport"]["digest"],
            installed["installedDigest"]
        );
        assert_eq!(store.enabled_skills().unwrap().len(), 1);
    }
}

#[test]
fn unsupported_declarations_stay_individual_opaque_and_optional() {
    let temp = fixture(
        ".claude-plugin/plugin.json",
        json!({"name":"sample","commands":{"review":{"command":"SECRET_COMMAND"},"build":"commands/build.md"},"agents":[{"prompt":"SECRET_AGENT"},"agents/reviewer.md"],"ui":{"surfaces":{"panel":{"token":"SECRET_UI"},"toolbar":false}}}),
    );
    write(temp.path(), "pkg/commands/build.md", "build");
    write(temp.path(), "pkg/agents/reviewer.md", "review");
    let store = open(&temp);
    let detail = install(&store);
    let report = rows(&detail, "installedComponentSupport");
    for kind in ["commands", "agents", "uiSurfaces"] {
        let selected: Vec<_> = report.iter().filter(|row| row["kind"] == kind).collect();
        assert_eq!(selected.len(), 2, "lost {kind} declaration");
        if kind == "agents" {
            assert_eq!(
                selected
                    .iter()
                    .filter(|row| row["status"] == "supported")
                    .count(),
                1
            );
            assert_eq!(
                selected
                    .iter()
                    .filter(|row| row["status"] == "unsupported")
                    .count(),
                1
            );
        } else {
            assert!(selected.iter().all(|row| row["status"] == "unsupported"));
            assert!(
                selected
                    .iter()
                    .all(|row| !row["reasonCodes"].as_array().unwrap().is_empty())
            );
        }
    }
    let serialized = serde_json::to_string(&detail["installedComponentSupport"]).unwrap();
    for secret in ["SECRET_COMMAND", "SECRET_AGENT", "SECRET_UI"] {
        assert!(!serialized.contains(secret));
    }
    assert_eq!(
        detail["installedComponentSupport"]["compatibility"]["state"],
        "allowed"
    );
    assert_eq!(store.enabled_skills().unwrap().len(), 1);
    assert_eq!(store.installed_snapshot().unwrap().enabled_skills.len(), 1);
}

#[test]
fn required_static_compatibility_gates_every_existing_effective_selection() {
    for (required, extra) in [
        (
            json!(["commands"]),
            json!({"commands":{"run":{"command":"do not execute"}}}),
        ),
        (json!(["mcp"]), json!({})),
    ] {
        let mut manifest = portable(
            json!({"org.areal":{"componentRequirements":{"version":1,"requiredKinds":required}}}),
        );
        manifest["extensions"]["com.openai"] = extra;
        let temp = fixture("plugin.json", manifest);
        let store = open(&temp);
        let detail = install(&store);
        assert_eq!(detail["enabled"], true, "scope intent is retained");
        assert_eq!(
            detail["installedComponentSupport"]["compatibility"]["state"],
            "blocked"
        );
        assert!(
            !detail["installedComponentSupport"]["compatibility"]["reasonCodes"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(detail["installedSkills"].as_array().unwrap().len(), 1);
        assert_eq!(store.installed_components().unwrap().len(), 1);
        assert_eq!(store.enabled_components().unwrap().len(), 0);
        assert!(store.enabled_component(ID).is_err());
        assert_eq!(store.enabled_revisions().unwrap().len(), 0);
        assert_eq!(store.enabled_skills().unwrap().len(), 0);
        let snapshot = store.installed_snapshot().unwrap();
        assert_eq!(snapshot.enabled_skills.len(), 0);
        assert_eq!(snapshot.enabled_ids.len(), 0);
        let skill = &detail["installedSkills"][0];
        assert!(
            !store
                .is_skill_enabled(
                    skill["id"].as_str().unwrap(),
                    skill["revision"].as_str().unwrap()
                )
                .unwrap()
        );
    }
}

#[test]
fn partial_mcp_envelope_blocks_only_when_required_and_dynamic_gates_are_separate() {
    let temp = fixture(
        "plugin.json",
        portable(
            json!({"org.areal":{"componentRequirements":{"version":1,"requiredKinds":["mcp"]}}}),
        ),
    );
    write(temp.path(), "pkg/mcp.json", r#"{"mcpServers":42}"#);
    let store = open(&temp);
    let detail = install(&store);
    let report = rows(&detail, "installedComponentSupport");
    assert_eq!(
        report.iter().find(|row| row["kind"] == "mcp").unwrap()["status"],
        "partial"
    );
    assert_eq!(
        detail["installedComponentSupport"]["compatibility"]["state"],
        "blocked"
    );
    let temp = fixture(
        "plugin.json",
        portable(
            json!({"org.areal":{"componentRequirements":{"version":1,"requiredKinds":["mcp"]}}}),
        ),
    );
    write(
        temp.path(),
        "pkg/mcp.json",
        r#"{"mcpServers":{"local":{"command":"NEVER_EXECUTE","required":true}}}"#,
    );
    let store = open(&temp);
    let detail = install(&store);
    let row = rows(&detail, "installedComponentSupport")
        .into_iter()
        .find(|row| row["kind"] == "mcp")
        .unwrap();
    assert_eq!(row["status"], "supported");
    assert!(
        row["activationRequirements"]
            .as_array()
            .unwrap()
            .contains(&json!("explicitMcpTrust"))
    );
    assert_eq!(
        detail["installedComponentSupport"]["compatibility"]["state"],
        "allowed"
    );
    assert_eq!(store.enabled_components().unwrap().len(), 1);
}

#[test]
fn required_extension_is_strict_portable_only() {
    for requirements in [
        json!({"version":2,"requiredKinds":[]}),
        json!({"version":1,"requiredKinds":["mystery"]}),
        json!({"version":1,"requiredKinds":["skills","skills"]}),
        json!({"version":1,"requiredKinds":"skills"}),
        json!({"version":1,"requiredKinds":[],"unknown":true}),
        json!({"requiredKinds":[]}),
        json!(null),
    ] {
        let temp = fixture(
            "plugin.json",
            portable(json!({"org.areal":{"componentRequirements":requirements}})),
        );
        let list = open(&temp).list().unwrap();
        assert_eq!(
            list.data.len(),
            0,
            "invalid requirements accepted: {requirements}"
        );
        assert!(!list.errors.is_empty());
    }
    let temp = fixture(
        ".codex-plugin/plugin.json",
        json!({"name":"sample","required":["commands"],"extensions":{"org.areal":{"componentRequirements":{"version":99}}}}),
    );
    let store = open(&temp);
    assert_eq!(
        install(&store)["installedComponentSupport"]["compatibility"]["state"],
        "allowed"
    );
}

#[test]
fn candidate_change_restart_old_state_and_missing_source_keep_exact_installed_report() {
    let temp = fixture("plugin.json", portable(json!({})));
    let store = open(&temp);
    let installed = install(&store);
    let installed_digest = installed["installedDigest"].clone();
    let mut state: Value =
        serde_json::from_slice(&fs::read(temp.path().join("state/state.json")).unwrap()).unwrap();
    for detail in state["installed"].as_object_mut().unwrap().values_mut() {
        detail.as_object_mut().unwrap().remove("componentSupport");
        detail
            .as_object_mut()
            .unwrap()
            .remove("installedComponentSupport");
    }
    fs::write(
        temp.path().join("state/state.json"),
        serde_json::to_vec(&state).unwrap(),
    )
    .unwrap();
    write(
        temp.path(),
        "pkg/plugin.json",
        &portable(json!({"com.openai":{"commands":{"new":{"command":"SECRET_NEW"}}}})).to_string(),
    );
    let detail = read(&open(&temp));
    assert_ne!(detail["sourceDigest"], installed_digest);
    assert_eq!(detail["componentSupport"]["digest"], detail["sourceDigest"]);
    assert_eq!(
        detail["installedComponentSupport"]["digest"],
        installed_digest
    );
    assert_eq!(rows(&detail, "installedComponentSupport").len(), 1);
    assert_eq!(rows(&detail, "componentSupport").len(), 2);
    fs::remove_file(temp.path().join("pkg/plugin.json")).unwrap();
    let detail = read(&open(&temp));
    assert_eq!(detail["componentSupport"], Value::Null);
    assert_eq!(
        detail["installedComponentSupport"]["digest"],
        installed_digest
    );
    assert_eq!(open(&temp).enabled_skills().unwrap().len(), 1);
}

#[test]
fn formats_paths_and_cache_integrity_fail_closed() {
    let temp = fixture(
        "plugin.json",
        json!({"$schema":"https://agent-plugins.org/schemas/99/plugin.schema.json","name":"sample"}),
    );
    write(
        temp.path(),
        "pkg/.claude-plugin/plugin.json",
        r#"{"name":"sample"}"#,
    );
    assert_eq!(open(&temp).list().unwrap().data.len(), 0);
    let temp = fixture(".zcode-plugin/plugin.json", json!({"name":"sample"}));
    let list = open(&temp).list().unwrap();
    assert_eq!(list.data.len(), 1);
    assert!(list.errors.is_empty());
    assert_eq!(
        serde_json::to_value(&list.data[0]).unwrap()["componentSupport"]["manifestFormat"],
        "zcode"
    );
    for key in ["commands", "agents"] {
        let mut manifest = json!({"name":"sample"});
        manifest[key] = json!(["../escape.md"]);
        let temp = fixture(".claude-plugin/plugin.json", manifest);
        assert_eq!(open(&temp).list().unwrap().data.len(), 0);
    }
    let temp = fixture("plugin.json", portable(json!({})));
    let store = open(&temp);
    let detail = install(&store);
    #[cfg(unix)]
    {
        let cache = temp
            .path()
            .join("state/cache")
            .join(detail["installedDigest"].as_str().unwrap())
            .join("plugin.json");
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&cache, fs::Permissions::from_mode(0o644)).unwrap();
        fs::write(&cache, "{}").unwrap();
        assert!(open(&temp).read(ID).is_err());
        assert!(open(&temp).enabled_revisions().is_err());
    }
}

#[test]
fn unresolved_remote_report_is_unknown_and_implicit_unsupported_files_are_visible() {
    let temp = fixture("plugin.json", portable(json!({})));
    write(temp.path(), "pkg/commands/one.md", "opaque");
    write(temp.path(), "pkg/agents/one.md", "opaque");
    let detail = read(&open(&temp));
    let report = rows(&detail, "componentSupport");
    for kind in ["commands", "agents"] {
        assert_eq!(report.iter().filter(|row| row["kind"] == kind).count(), 1);
    }
    write(temp.path(),".agents/plugins/marketplace.json",&json!({"name":"local","plugins":[{"name":"sample","source":{"source":"git","url":"https://invalid.example/package.git"}}]}).to_string());
    let detail = read(&open(&temp));
    assert_eq!(detail["sourceDigest"], "");
    assert_eq!(detail["componentSupport"], Value::Null);
}

#[test]
fn historical_skill_compatibility_survives_replacement_and_restart() {
    for initially_blocked in [true, false] {
        let blocked = portable(
            json!({"org.areal":{"componentRequirements":{"version":1,"requiredKinds":["commands"]}},"com.openai":{"commands":{"run":{"command":"never execute"}}}}),
        );
        let temp = fixture(
            "plugin.json",
            if initially_blocked {
                blocked.clone()
            } else {
                portable(json!({}))
            },
        );
        let store = open(&temp);
        let installed = install(&store);
        let old = &installed["installedSkills"][0];
        let id = old["id"].as_str().unwrap();
        let revision = old["revision"].as_str().unwrap();
        assert_eq!(
            store.is_skill_enabled(id, revision).unwrap(),
            !initially_blocked
        );
        fs::remove_dir_all(temp.path().join("pkg/skills")).unwrap();
        write(
            temp.path(),
            "pkg/plugin.json",
            &portable(json!({})).to_string(),
        );
        assert_eq!(install(&store)["installedSkills"], json!([]));
        for view in [&store, &open(&temp)] {
            assert_eq!(
                view.is_skill_enabled(id, revision).unwrap(),
                !initially_blocked,
                "historical compatibility changed after an allowed replacement; initially_blocked={initially_blocked}"
            );
        }
        write(temp.path(), "pkg/plugin.json", &blocked.to_string());
        install(&store);
        assert!(!store.is_skill_enabled(id, revision).unwrap());
        write(
            temp.path(),
            "pkg/plugin.json",
            &portable(json!({})).to_string(),
        );
        install(&store);
        store
            .configure(ID, "user", false, store.list().unwrap().revision)
            .unwrap();
        assert!(!store.is_skill_enabled(id, revision).unwrap());
        store
            .configure(ID, "user", true, store.list().unwrap().revision)
            .unwrap();
        assert_eq!(
            store.is_skill_enabled(id, revision).unwrap(),
            !initially_blocked
        );
        store.uninstall(ID, store.list().unwrap().revision).unwrap();
        assert!(!open(&temp).is_skill_enabled(id, revision).unwrap());
    }
}

#[test]
fn hook_support_matches_selected_typed_documents_without_execution() {
    let command = json!({"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"echo never execute"}]}]}});
    let cases = [
        (
            "mcp_tool",
            None,
            json!({"hooks":{"PreToolUse":[{"hooks":[{"type":"mcp_tool","server":"local","tool":"check"}]}]}}),
            false,
            vec!["supported"],
            1,
            "allowed",
        ),
        (
            "mcp",
            None,
            json!({"hooks":{"PreToolUse":[{"hooks":[{"type":"mcp","server":"local","tool":"check"}]}]}}),
            false,
            vec!["partial"],
            0,
            "blocked",
        ),
        (
            "wrapper",
            None,
            json!({"PreToolUse":[{"hooks":[{"type":"command","command":"echo never"}]}]}),
            false,
            vec!["partial"],
            0,
            "blocked",
        ),
        (
            "typed_timeout",
            None,
            json!({"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"echo never","timeout":"bad"}]}]}}),
            false,
            vec!["partial"],
            0,
            "blocked",
        ),
        (
            "path",
            Some(json!("./custom.json")),
            command.clone(),
            false,
            vec!["supported"],
            1,
            "allowed",
        ),
        (
            "fallback",
            Some(json!("custom.json")),
            command.clone(),
            true,
            vec!["partial", "supported"],
            1,
            "blocked",
        ),
        (
            "unsupported_handler",
            None,
            json!({"hooks":{"PreToolUse":[{"hooks":[{"type":"prompt","prompt":"never"}]}]}}),
            false,
            vec!["partial"],
            0,
            "blocked",
        ),
        (
            "unknown_event",
            None,
            json!({"hooks":{"UnknownEvent":[{"hooks":[{"type":"command","command":"echo never"}]}]}}),
            false,
            vec!["partial"],
            0,
            "blocked",
        ),
    ];
    let mut failures = vec![];
    for (name, declaration, document, fallback, expected, count, compatibility) in cases {
        let mut extensions =
            json!({"org.areal":{"componentRequirements":{"version":1,"requiredKinds":["hooks"]}}});
        if let Some(declaration) = &declaration {
            extensions["com.openai"] = json!({"hooks":declaration});
        }
        let temp = fixture("plugin.json", portable(extensions));
        write(
            temp.path(),
            if declaration.is_some() {
                "pkg/custom.json"
            } else {
                "pkg/hooks/hooks.json"
            },
            &document.to_string(),
        );
        if fallback {
            write(temp.path(), "pkg/hooks/hooks.json", &command.to_string());
        }
        let store = open(&temp);
        let detail = install(&store);
        let component = store.installed_components().unwrap().remove(0);
        assert_eq!(
            areal_plugins::hooks::normalize(&component)
                .unwrap()
                .entries
                .len(),
            count,
            "actual Hook parser changed for {name}"
        );
        let mut actual: Vec<_> = rows(&detail, "installedComponentSupport")
            .into_iter()
            .filter(|row| row["kind"] == "hooks")
            .map(|row| row["status"].as_str().unwrap().to_owned())
            .collect();
        actual.sort();
        if actual != expected
            || detail["installedComponentSupport"]["compatibility"]["state"] != compatibility
        {
            failures.push(format!("{name}: statuses={actual:?}, compatibility={}, expected={expected:?}/{compatibility}", detail["installedComponentSupport"]["compatibility"]["state"]));
        }
        assert_eq!(
            detail["installedComponentSupport"]["validation"]["platform"],
            "unverified"
        );
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn app_support_distinguishes_manifest_paths_from_connector_documents() {
    let cases = [
        (
            "single",
            None,
            json!({"id":"github","name":"GitHub"}),
            "supported",
            "allowed",
        ),
        (
            "map",
            None,
            json!({"github":{"name":"GitHub"}}),
            "supported",
            "allowed",
        ),
        (
            "array",
            None,
            json!([{"id":"github"}]),
            "supported",
            "allowed",
        ),
        (
            "paths",
            Some(json!(["./connectors.json"])),
            json!({"apps":[{"id":"github"}]}),
            "supported",
            "allowed",
        ),
        ("invalid", None, json!({"id":42}), "partial", "blocked"),
        (
            "missing_id",
            None,
            json!([{"name":"GitHub"}]),
            "partial",
            "blocked",
        ),
    ];
    let mut failures = vec![];
    for (name, declaration, document, status, compatibility) in cases {
        let mut extensions =
            json!({"org.areal":{"componentRequirements":{"version":1,"requiredKinds":["apps"]}}});
        if let Some(declaration) = &declaration {
            extensions["com.openai"] = json!({"apps":declaration});
        }
        let temp = fixture("plugin.json", portable(extensions));
        write(
            temp.path(),
            if declaration.is_some() {
                "pkg/connectors.json"
            } else {
                "pkg/.app.json"
            },
            &document.to_string(),
        );
        let store = open(&temp);
        let detail = install(&store);
        let component = store.installed_components().unwrap().remove(0);
        assert_eq!(
            component.app_documents.len(),
            1,
            "actual document selection changed for {name}"
        );
        assert_eq!(component.app_documents[0].value, document);
        let actual: Vec<_> = rows(&detail, "installedComponentSupport")
            .into_iter()
            .filter(|row| row["kind"] == "apps")
            .map(|row| row["status"].as_str().unwrap().to_owned())
            .collect();
        if actual != [status]
            || detail["installedComponentSupport"]["compatibility"]["state"] != compatibility
        {
            failures.push(format!(
                "{name}: statuses={actual:?}, compatibility={}, expected={status}/{compatibility}",
                detail["installedComponentSupport"]["compatibility"]["state"]
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
