//! Contract assertions established before implementation: no manifest downgrade or
//! overlay merging; immutable full-package snapshots; unsafe sources rejected;
//! isolated catalog failures; restart persistence and stale CAS rejection; gates.
use areal_plugins::Store;
use serde_json::json;
use std::{fs, path::Path};
fn write(root: &Path, path: &str, body: &str) {
    let p = root.join(path);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, body).unwrap();
}
fn fixture() -> tempfile::TempDir {
    let t = tempfile::tempdir().unwrap();
    write(t.path(),".agents/plugins/marketplace.json",&json!({"name":"local","plugins":[{"name":"sample","source":"./pkg"},{"name":"broken","source":"./missing"}]}).to_string());
    write(
        t.path(),
        "pkg/plugin.json",
        r#"{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"sample","version":"1","extensions":{"com.openai":{}}}"#,
    );
    write(
        t.path(),
        "pkg/.codex-plugin/plugin.json",
        r#"{"name":"ignored","interface":{"displayName":"wrong"},"skills":"other","hooks":{}}"#,
    );
    write(
        t.path(),
        "pkg/skills/one/SKILL.md",
        "---\nname: One\ndescription: First\n---\nbody",
    );
    write(
        t.path(),
        "pkg/skills/two/SKILL.md",
        "---\nname: Two\ndescription: Second\n---\nbody",
    );
    write(
        t.path(),
        "pkg/skills/one/agents/openai.yaml",
        "policy:\n  allow_implicit_invocation: false\ndependencies:\n  tools:\n    - type: mcp\n      value: sample\n",
    );
    write(t.path(), "pkg/shared/data.txt", "original");
    t
}
fn open(t: &tempfile::TempDir) -> Store {
    Store::open(t.path().join("state"), t.path().to_owned(), None).unwrap()
}
#[test]
fn component_choices_are_project_local_and_survive_package_updates() {
    use areal_plugins::PluginComponentId;
    let t = fixture();
    let store = open(&t);
    let installed = install(&store, "sample@local", "user", 0).unwrap();
    let selected = installed.installed_skills[0].clone();
    let component = PluginComponentId::Skill {
        id: selected.id.clone(),
    };
    assert!(
        store
            .configure_component(
                &installed.id,
                &component,
                false,
                installed.revision,
                "stale"
            )
            .is_err()
    );
    assert_eq!(
        store.read(&installed.id).unwrap().revision,
        installed.revision
    );
    let disabled = store
        .configure_component(
            &installed.id,
            &component,
            false,
            installed.revision,
            installed.installed_digest.as_ref().unwrap(),
        )
        .unwrap();
    assert!(
        disabled
            .component_choices
            .disabled_skills
            .contains(&selected.id)
    );
    assert!(
        !open(&t)
            .is_skill_enabled(&selected.id, &selected.revision)
            .unwrap()
    );
    assert_eq!(store.enabled_skills().unwrap().len(), 1);
    assert!(
        !store
            .installed_snapshot()
            .unwrap()
            .eligible_skill_refs
            .contains(&(selected.id.clone(), selected.revision.clone()))
    );
    assert!(
        store
            .configure_component(
                &installed.id,
                &component,
                true,
                installed.revision,
                installed.installed_digest.as_ref().unwrap()
            )
            .is_err()
    );
    let other = tempfile::tempdir().unwrap();
    let other_store = Store::open(t.path().join("state"), other.path().into(), None).unwrap();
    assert!(
        other_store
            .is_skill_enabled(&selected.id, &selected.revision)
            .unwrap()
    );
    write(t.path(), "pkg/shared/data.txt", "updated bytes");
    let updated = install(&store, &installed.id, "user", disabled.revision).unwrap();
    let current = updated
        .installed_skills
        .iter()
        .find(|skill| skill.id == selected.id)
        .unwrap();
    assert_ne!(current.revision, selected.revision);
    assert!(
        !store
            .is_skill_enabled(&current.id, &current.revision)
            .unwrap()
    );
    assert!(
        !store
            .is_skill_enabled(&selected.id, &selected.revision)
            .unwrap()
    );
    assert!(
        store
            .configure_component(
                &installed.id,
                &component,
                true,
                updated.revision,
                installed.installed_digest.as_ref().unwrap()
            )
            .is_err()
    );
    let enabled = store
        .configure_component(
            &installed.id,
            &component,
            true,
            updated.revision,
            updated.installed_digest.as_ref().unwrap(),
        )
        .unwrap();
    assert!(
        store
            .is_skill_enabled(&selected.id, &selected.revision)
            .unwrap()
    );
    let disabled = store
        .configure_component(
            &installed.id,
            &component,
            false,
            enabled.revision,
            updated.installed_digest.as_ref().unwrap(),
        )
        .unwrap();
    store.uninstall(&installed.id, disabled.revision).unwrap();
    let revision = store.list().unwrap().revision;
    let reinstalled = install(&store, &installed.id, "user", revision).unwrap();
    assert!(reinstalled.component_choices.disabled_skills.is_empty());
    assert!(
        store
            .is_skill_enabled(&selected.id, &selected.revision)
            .unwrap()
    );
}
#[test]
fn portable_snapshot_restart_and_cas() {
    let t = fixture();
    let a = open(&t);
    let b = open(&t);
    let l = a.list().unwrap();
    assert_eq!(l.data.len(), 1);
    assert!(!l.errors.is_empty());
    let d = install(&a, "sample@local", "user", 0).unwrap();
    assert_eq!(d.name, "sample");
    assert_ne!(d.display_name, "wrong");
    assert_eq!(d.skills.len(), 2);
    assert!(!d.components.contains(&"hooks".into()));
    assert!(
        !d.skills
            .iter()
            .find(|s| s.name == "One")
            .unwrap()
            .allow_implicit_invocation
    );
    assert!(d.diagnostics.iter().any(|s| s.contains("dependencies")));
    write(t.path(), "pkg/shared/data.txt", "changed");
    assert_eq!(
        fs::read_to_string(d.skills[0].package_root.join("shared/data.txt")).unwrap(),
        "original"
    );
    assert!(b.configure(&d.id, "user", false, 0).is_err());
    assert_eq!(open(&t).read(&d.id).unwrap().revision, 1);
    let d = b.configure(&d.id, "project", false, 1).unwrap();
    assert!(
        !a.is_skill_enabled(&d.installed_skills[0].id, &d.installed_skills[0].revision)
            .unwrap()
    );
    let d = a.configure(&d.id, "project", true, 2).unwrap();
    assert!(
        a.is_skill_enabled(&d.installed_skills[0].id, &d.installed_skills[0].revision)
            .unwrap()
    );
    let d = a.configure(&d.id, "user", false, 3).unwrap();
    assert!(d.enabled);
    assert_eq!(a.enabled_skills().unwrap().len(), 2);
    a.uninstall(&d.id, 4).unwrap();
    assert!(d.installed_skills[0].package_root.exists());
    assert_eq!(open(&t).retained_skills().unwrap().len(), 2);
}
#[test]
fn legacy_unsupported_and_schema_rejection() {
    let t = fixture();
    fs::remove_file(t.path().join("pkg/plugin.json")).unwrap();
    write(
        t.path(),
        "pkg/.codex-plugin/plugin.json",
        r#"{"name":"sample","skills":["skills/one","skills/two"],"mcpServers":{"local":{"command":"must-not-run"}},"hooks":{},"apps":{},"onboardingSkill":"skills/one/SKILL.md"}"#,
    );
    let s = open(&t);
    let d = install(&s, "sample@local", "project", 0).unwrap();
    assert_eq!(d.skills.len(), 2);
    assert!(d.skills.iter().any(|s| s.onboarding));
    assert_eq!(d.components.len(), 4);
    assert!(
        d.diagnostics
            .iter()
            .any(|s| s.contains("do not execute") && s.contains("hook definition trust"))
    );
    write(
        t.path(),
        "pkg/plugin.json",
        r#"{"$schema":"https://agent-plugins.org/schemas/9.0.0/plugin.schema.json","name":"sample"}"#,
    );
    assert!(install(&s, "sample@local", "user", 1).is_err());
    assert!(s.read("sample@local").unwrap().installed);
}
#[test]
fn unsafe_packages_rejected() {
    for kind in ["escape", "symlink", "hardlink"] {
        let t = fixture();
        match kind {
            "escape" => write(
                t.path(),
                "pkg/.codex-plugin/plugin.json",
                r#"{"name":"sample","skills":"../outside"}"#,
            ),
            "symlink" => {
                std::os::unix::fs::symlink("../outside", t.path().join("pkg/link")).unwrap()
            }
            _ => {
                write(t.path(), "outside", "secret");
                fs::hard_link(t.path().join("outside"), t.path().join("pkg/link")).unwrap();
            }
        }
        if kind == "escape" {
            fs::remove_file(t.path().join("pkg/plugin.json")).unwrap();
        }
        assert!(
            install(&open(&t), "sample@local", "user", 0).is_err(),
            "{kind}"
        );
    }
}

// Review regression assertions: catalogs must share the package no-follow,
// bounded regular-file boundary; local '.' identifies the catalog root itself.
#[test]
fn catalog_root_can_itself_be_a_package() {
    for source in [".", "./"] {
        let t = fixture();
        let state = tempfile::tempdir().unwrap();
        fs::rename(
            t.path().join("pkg/plugin.json"),
            t.path().join("plugin.json"),
        )
        .unwrap();
        fs::rename(t.path().join("pkg/skills"), t.path().join("skills")).unwrap();
        write(
            t.path(),
            ".agents/plugins/marketplace.json",
            &json!({"name":"local","plugins":[{"name":"sample","source":source}]}).to_string(),
        );
        let s = Store::open(state.path().to_owned(), t.path().to_owned(), None).unwrap();
        assert_eq!(
            install(&s, "sample@local", "user", 0).unwrap().skills.len(),
            2
        );
    }
}

#[test]
fn unsafe_catalog_files_are_diagnosed() {
    for kind in ["symlink", "ancestor", "hardlink", "oversize"] {
        let t = fixture();
        let outside = tempfile::tempdir().unwrap();
        let path = t.path().join(".agents/plugins/marketplace.json");
        let catalog = fs::read(&path).unwrap();
        fs::write(outside.path().join("marketplace.json"), catalog).unwrap();
        fs::remove_file(&path).unwrap();
        match kind {
            "symlink" => {
                std::os::unix::fs::symlink(outside.path().join("marketplace.json"), &path).unwrap()
            }
            "ancestor" => {
                fs::remove_dir(path.parent().unwrap()).unwrap();
                std::os::unix::fs::symlink(outside.path(), path.parent().unwrap()).unwrap();
            }
            "hardlink" => fs::hard_link(outside.path().join("marketplace.json"), &path).unwrap(),
            _ => fs::write(&path, vec![b' '; 1024 * 1024 + 1]).unwrap(),
        }
        let result = open(&t).list().unwrap();
        assert!(result.data.is_empty(), "{kind} catalog accepted");
        assert!(
            !result.errors.is_empty(),
            "{kind} catalog missing diagnostic"
        );
    }
}

#[test]
fn fifo_catalog_never_blocks_discovery() {
    let t = fixture();
    let path = t.path().join(".agents/plugins/marketplace.json");
    fs::remove_file(&path).unwrap();
    assert!(
        std::process::Command::new("mkfifo")
            .arg(&path)
            .status()
            .unwrap()
            .success()
    );
    let store = open(&t);
    let (send, receive) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        send.send(store.list()).ok();
    });
    let result = receive
        .recv_timeout(std::time::Duration::from_secs(2))
        .expect("FIFO catalog blocked discovery")
        .unwrap();
    assert!(result.data.is_empty());
    assert!(!result.errors.is_empty());
}

#[test]
fn install_rejects_source_drift_since_selection() {
    for change in ["bytes", "catalog-source"] {
        let t = fixture();
        let store = open(&t);
        let selected = store.read("sample@local").unwrap();
        if change == "bytes" {
            write(t.path(), "pkg/shared/data.txt", "different source bytes");
        } else {
            fs::rename(t.path().join("pkg"), t.path().join("replacement")).unwrap();
            write(
                t.path(),
                ".agents/plugins/marketplace.json",
                &json!({"name":"local","plugins":[{"name":"sample","source":"./replacement"}]})
                    .to_string(),
            );
        }
        assert!(
            store
                .install(
                    &selected.id,
                    "user",
                    selected.revision,
                    &selected.source,
                    &selected.source_digest
                )
                .is_err(),
            "{change} drift silently installed"
        );
        assert_eq!(store.list().unwrap().revision, 0);
        assert!(store.installed_skills().unwrap().is_empty());
    }
}

#[test]
fn api_marketplace_is_discovered_and_can_be_added() {
    let t = fixture();
    fs::rename(
        t.path().join(".agents/plugins/marketplace.json"),
        t.path().join(".agents/plugins/api_marketplace.json"),
    )
    .unwrap();
    let store = open(&t);
    assert_eq!(store.list().unwrap().data.len(), 1);
    assert_eq!(store.add_marketplace(t.path(), 0).unwrap().data.len(), 1);
}

fn install(
    store: &Store,
    id: &str,
    scope: &str,
    revision: u64,
) -> anyhow::Result<areal_plugins::PluginDetail> {
    let selected = store.read(id)?;
    store.install(
        id,
        scope,
        revision,
        &selected.source,
        &selected.source_digest,
    )
}

#[test]
fn candidate_metadata_matches_selected_digest() {
    let t = fixture();
    let store = open(&t);
    let installed = install(&store, "sample@local", "user", 0).unwrap();
    write(
        t.path(),
        "pkg/plugin.json",
        r#"{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"sample","version":"2","extensions":{"com.openai":{"hooks":{}}}}"#,
    );
    write(
        t.path(),
        "pkg/skills/one/SKILL.md",
        "---\nname: Changed candidate\n---\nnew",
    );
    let candidate = store.read("sample@local").unwrap();
    assert_ne!(candidate.source_digest, installed.source_digest);
    assert_eq!(candidate.version.as_deref(), Some("2"));
    assert!(
        candidate
            .skills
            .iter()
            .any(|s| s.name == "Changed candidate")
    );
    assert!(candidate.components.contains(&"hooks".into()));
    assert!(candidate.installed);
    assert_eq!(candidate.installed_version.as_deref(), Some("1"));
    assert_eq!(
        candidate.installed_digest.as_deref(),
        Some(installed.source_digest.as_str())
    );
    assert!(candidate.installed_skills.iter().any(|s| s.name == "One"));
}

#[test]
fn project_enable_overrides_user_default() {
    let t = fixture();
    let store = open(&t);
    install(&store, "sample@local", "user", 0).unwrap();
    store.configure("sample@local", "user", false, 1).unwrap();
    assert!(
        store
            .configure("sample@local", "project", true, 2)
            .unwrap()
            .enabled
    );
}

#[test]
fn nameless_legacy_ignores_unrelated_root_and_preserves_nested_onboarding() {
    for root in ["not json", r#"{"$schema":"https://other.invalid/schema"}"#] {
        let t = fixture();
        write(
            t.path(),
            ".agents/plugins/marketplace.json",
            r#"{"name":"local","plugins":[{"name":"pkg","source":"./pkg"}]}"#,
        );
        write(t.path(), "pkg/plugin.json", root);
        write(
            t.path(),
            "pkg/.codex-plugin/plugin.json",
            r#"{"name":" ","skills":"skills","extensions":{"com.openai":{"onboardingSkill":"skills/one/SKILL.md"}}}"#,
        );
        let detail = install(&open(&t), "pkg@local", "user", 0).unwrap();
        assert_eq!(detail.name, "pkg");
        assert!(detail.onboarding_skill.is_some());
    }
}

#[test]
fn optional_unsupported_declarations_diagnose_without_hiding_skills() {
    let t = fixture();
    fs::remove_file(t.path().join("pkg/plugin.json")).unwrap();
    write(
        t.path(),
        "pkg/.codex-plugin/plugin.json",
        r#"{"name":"sample","hooks":false,"mcpServers":"missing.json","commands":"custom-commands","interface":{"composerIcon":"missing.png","logo":false,"screenshots":["also-missing.png"]}}"#,
    );
    let d = install(&open(&t), "sample@local", "user", 0).unwrap();
    assert_eq!(d.skills.len(), 2);
    for component in ["hooks", "mcp", "interface"] {
        assert!(
            d.diagnostics
                .iter()
                .any(|s| s.to_lowercase().contains(component)),
            "missing {component} diagnostic"
        );
    }
    let support = d.installed_component_support.as_ref().unwrap();
    let command = support
        .components
        .iter()
        .find(|component| component.kind == areal_plugins::ComponentKind::Commands)
        .unwrap();
    assert_eq!(command.source_field, ".codex-plugin/plugin.json#/commands");
    assert_eq!(command.status, areal_plugins::SupportStatus::Unsupported);
    assert_eq!(command.reason_codes, ["templateDeclarationUnsupported"]);
    assert!(!command.required);
    assert_eq!(
        support.compatibility.state,
        areal_plugins::CompatibilityState::Allowed
    );
}

#[test]
fn interface_assets_cannot_escape_package() {
    for field in ["composerIcon", "logo", "logoDark"] {
        let t = fixture();
        write(t.path(),"pkg/plugin.json",&json!({"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"sample","extensions":{"com.openai":{"interface":{field:"../outside.png"}}}}).to_string());
        assert!(
            install(&open(&t), "sample@local", "user", 0).is_err(),
            "{field} escape accepted"
        );
    }
}

#[test]
fn invalid_skill_metadata_cannot_poison_retained_state() {
    for (name, description) in [
        (String::new(), "valid".into()),
        ("n".repeat(257), "valid".into()),
        ("valid".into(), "d".repeat(4097)),
    ] {
        let t = fixture();
        let store = open(&t);
        write(
            t.path(),
            "pkg/skills/one/SKILL.md",
            &format!(
                "---\nname: {}\ndescription: {}\n---\nbody",
                serde_json::to_string(&name).unwrap(),
                serde_json::to_string(&description).unwrap()
            ),
        );
        assert!(
            install(&store, "sample@local", "user", 0).is_err(),
            "invalid metadata committed"
        );
        assert_eq!(store.list().unwrap().revision, 0);
        assert!(open(&t).retained_skills().unwrap().is_empty());
    }
}

#[test]
fn portable_legacy_overlay_onboarding_is_suppressed_by_empty_inline() {
    for inline in [false, true] {
        let t = fixture();
        let mut manifest = json!({"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"sample"});
        if inline {
            manifest["extensions"] = json!({"com.openai":{}});
        }
        write(t.path(), "pkg/plugin.json", &manifest.to_string());
        write(
            t.path(),
            "pkg/.codex-plugin/plugin.json",
            r#"{"name":"ignored","extensions":{"com.openai":{"onboardingSkill":"skills/one/SKILL.md"}}}"#,
        );
        let detail = install(&open(&t), "sample@local", "user", 0).unwrap();
        assert_eq!(detail.onboarding_skill.is_some(), !inline);
        assert_eq!(detail.installed_onboarding_skill.is_some(), !inline);
        assert_eq!(
            detail.skills.iter().filter(|s| s.onboarding).count(),
            usize::from(!inline)
        );
    }
}
