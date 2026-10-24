use areal_plugins::{InstalledSkill, PluginDetail, Store};
use serde_json::{Value, json};
use std::{collections::BTreeSet, fs, path::Path, process::Command};

struct Fixture {
    corpus: tempfile::TempDir,
    state: tempfile::TempDir,
}
impl Fixture {
    fn new() -> Self {
        Self {
            corpus: tempfile::tempdir().unwrap(),
            state: tempfile::tempdir().unwrap(),
        }
    }
    fn open(&self) -> Store {
        Store::open(self.state.path().into(), self.corpus.path().into(), None).unwrap()
    }
    fn catalog(&self, entries: Value) {
        write(
            self.corpus.path(),
            ".claude-plugin/marketplace.json",
            &json!({"name":"ecosystem","plugins":entries}).to_string(),
        );
    }
}
fn write(root: &Path, path: &str, body: &str) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, body).unwrap();
}
fn skill(root: &Path, path: &str, name: &str) {
    write(
        root,
        &format!("{path}/SKILL.md"),
        &format!("---\nname: {name}\ndescription: Self-authored fixture\n---\nFixture body.\n"),
    );
}
fn names(skills: &[InstalledSkill]) -> BTreeSet<&str> {
    skills.iter().map(|skill| skill.name.as_str()).collect()
}
fn expected<'a>(names: &[&'a str]) -> BTreeSet<&'a str> {
    names.iter().copied().collect()
}
fn install(store: &Store, selected: &PluginDetail) -> PluginDetail {
    store
        .install(
            &selected.id,
            "user",
            selected.revision,
            &selected.source,
            selected.review_digest(),
        )
        .unwrap()
}
fn entry(name: &str, source: &str, selected: &str) -> Value {
    json!({"name":name,"source":source,"strict":false,"skills":[selected]})
}
fn mcp_names(store: &Store, id: &str) -> BTreeSet<String> {
    store
        .installed_components()
        .unwrap()
        .into_iter()
        .find(|component| component.id == id)
        .unwrap()
        .mcp_documents
        .iter()
        .flat_map(|document| {
            document
                .declaration
                .envelope()
                .filter_map(|entry| match entry {
                    areal_mcp::PluginEnvelopeEntry::Server { name, .. } => Some(name.to_owned()),
                    _ => None,
                })
        })
        .collect()
}

#[test]
fn manifestless_root_entries_project_disjoint_skills_through_install_and_reopen() {
    let f = Fixture::new();
    skill(f.corpus.path(), "skills/alpha", "Alpha");
    skill(f.corpus.path(), "skills/beta", "Beta");
    skill(f.corpus.path(), "skills/unlisted", "Unlisted");
    f.catalog(json!([
        entry("alpha", "./", "./skills/alpha"),
        entry("beta", "./", "./skills/beta")
    ]));
    let store = f.open();
    let list = store.list().unwrap();
    assert!(list.errors.is_empty(), "{:?}", list.errors);
    assert_eq!(list.data.len(), 2);
    let alpha = store.read("alpha@ecosystem").unwrap();
    let beta = store.read("beta@ecosystem").unwrap();
    assert_eq!(names(&alpha.skills), expected(&["Alpha"]));
    assert_eq!(names(&beta.skills), expected(&["Beta"]));
    install(&store, &alpha);
    install(&store, &store.read(&beta.id).unwrap());
    drop(store);
    let reopened = f.open();
    for (id, selected) in [("alpha@ecosystem", "Alpha"), ("beta@ecosystem", "Beta")] {
        let detail = reopened.read(id).unwrap();
        assert_eq!(names(&detail.installed_skills), expected(&[selected]));
        let snapshot = reopened.installed_snapshot().unwrap();
        let selected_skills: Vec<_> = snapshot
            .enabled_skills
            .into_iter()
            .filter(|skill| skill.plugin_id == id)
            .collect();
        assert_eq!(names(&selected_skills), expected(&[selected]));
    }
    let components = reopened.installed_components().unwrap();
    assert_eq!(components.len(), 2);
    assert!(components.iter().all(|component| component.root.is_dir()));
}

#[test]
fn catalog_only_component_edit_invalidates_reviewed_candidate() {
    let f = Fixture::new();
    skill(f.corpus.path(), "pkg/skills/alpha", "Alpha");
    skill(f.corpus.path(), "pkg/skills/beta", "Beta");
    f.catalog(json!([entry("sample", "./pkg", "./skills/alpha")]));
    let store = f.open();
    let reviewed = store.read("sample@ecosystem").unwrap();
    let package_bytes = fs::read(f.corpus.path().join("pkg/skills/alpha/SKILL.md")).unwrap();
    f.catalog(json!([entry("sample", "./pkg", "./skills/beta")]));
    assert_eq!(
        fs::read(f.corpus.path().join("pkg/skills/alpha/SKILL.md")).unwrap(),
        package_bytes
    );
    assert!(
        store
            .install(
                &reviewed.id,
                "user",
                reviewed.revision,
                &reviewed.source,
                &reviewed.source_digest,
            )
            .is_err(),
        "catalog selection changed after review but installation was accepted"
    );
    assert_eq!(store.list().unwrap().revision, 0);
    assert!(store.installed_skills().unwrap().is_empty());
    let refreshed = store.read(&reviewed.id).unwrap();
    assert_eq!(
        names(&install(&store, &refreshed).installed_skills),
        expected(&["Beta"])
    );
}

#[test]
fn installed_entry_components_remain_frozen_until_explicit_update() {
    let f = Fixture::new();
    skill(f.corpus.path(), "pkg/skills/alpha", "Alpha");
    skill(f.corpus.path(), "pkg/skills/beta", "Beta");
    let selected = |name: &str| {
        let mut selected = entry("sample", "./pkg", &format!("./skills/{name}"));
        selected["mcpServers"] = json!({(name):{"command":"never-started-fixture-server"}});
        selected
    };
    f.catalog(json!([selected("alpha")]));
    let store = f.open();
    let installed = install(&store, &store.read("sample@ecosystem").unwrap());
    assert_eq!(
        mcp_names(&store, &installed.id),
        BTreeSet::from(["alpha".into()])
    );
    f.catalog(json!([selected("beta")]));
    drop(store);
    let reopened = f.open();
    let current = reopened.read(&installed.id).unwrap();
    assert_eq!(names(&current.skills), expected(&["Beta"]));
    assert_eq!(names(&current.installed_skills), expected(&["Alpha"]));
    assert_eq!(current.installed_digest, installed.installed_digest);
    assert_eq!(
        names(&reopened.enabled_skills().unwrap()),
        expected(&["Alpha"])
    );
    assert_eq!(
        mcp_names(&reopened, &installed.id),
        BTreeSet::from(["alpha".into()])
    );
    let updated = install(&reopened, &current);
    assert_eq!(names(&updated.installed_skills), expected(&["Beta"]));
    assert_eq!(
        mcp_names(&f.open(), &installed.id),
        BTreeSet::from(["beta".into()])
    );
}

#[test]
fn claude_strict_manifest_appends_entry_skill_paths() {
    let f = Fixture::new();
    skill(f.corpus.path(), "pkg/skills/manifest", "Manifest");
    skill(f.corpus.path(), "pkg/extra/selected", "Selected");
    skill(f.corpus.path(), "pkg/extra/unlisted", "Unlisted");
    write(
        f.corpus.path(),
        "pkg/.claude-plugin/plugin.json",
        r#"{"name":"sample","skills":["./skills/manifest"]}"#,
    );
    f.catalog(
        json!([{"name":"sample","source":"./pkg","strict":true,"skills":["./extra/selected"]}]),
    );
    let store = f.open();
    let detail = store.read("sample@ecosystem").unwrap();
    assert_eq!(names(&detail.skills), expected(&["Manifest", "Selected"]));
    assert_eq!(
        names(&install(&store, &detail).installed_skills),
        expected(&["Manifest", "Selected"])
    );
}

#[test]
fn claude_non_strict_manifest_and_entry_component_conflict_is_diagnosed() {
    let f = Fixture::new();
    skill(f.corpus.path(), "pkg/skills/manifest", "Manifest");
    skill(f.corpus.path(), "pkg/skills/entry", "Entry");
    write(
        f.corpus.path(),
        "pkg/.claude-plugin/plugin.json",
        r#"{"name":"sample","skills":["./skills/manifest"]}"#,
    );
    f.catalog(json!([entry("sample", "./pkg", "./skills/entry")]));
    let store = f.open();
    let list = store.list().unwrap();
    assert!(
        list.data.is_empty(),
        "conflicting component sources were accepted"
    );
    assert!(
        !list.errors.is_empty(),
        "missing strict conflict diagnostic"
    );
    assert!(store.read("sample@ecosystem").is_err());
    assert!(store.installed_components().unwrap().is_empty());
}

#[test]
fn zcode_manifest_skill_directory_installs_and_reopens() {
    let f = Fixture::new();
    skill(f.corpus.path(), "pkg/skills/greet", "Greeting");
    write(
        f.corpus.path(),
        "pkg/.zcode-plugin/plugin.json",
        r#"{"name":"sample","version":"0.1.0","skills":"skills"}"#,
    );
    f.catalog(json!([{"name":"sample","source":"./pkg"}]));
    let store = f.open();
    let candidate = store.read("sample@ecosystem").unwrap();
    assert_eq!(names(&candidate.skills), expected(&["Greeting"]));
    install(&store, &candidate);
    assert_eq!(
        names(&f.open().installed_skills().unwrap()),
        expected(&["Greeting"])
    );
    assert_eq!(f.open().installed_components().unwrap().len(), 1);
}

#[test]
fn codex_manifest_keeps_precedence_over_zcode_manifest() {
    let f = Fixture::new();
    skill(f.corpus.path(), "pkg/codex-skills/selected", "Codex");
    skill(f.corpus.path(), "pkg/zcode-skills/ignored", "ZCode");
    write(
        f.corpus.path(),
        "pkg/.codex-plugin/plugin.json",
        r#"{"name":"sample","skills":"codex-skills","mcpServers":{"codex":{"command":"never-started-codex"}}}"#,
    );
    write(
        f.corpus.path(),
        "pkg/.zcode-plugin/plugin.json",
        r#"{"name":"sample","skills":"zcode-skills","mcpServers":{"zcode":{"command":"never-started-zcode"}}}"#,
    );
    f.catalog(json!([{"name":"sample","source":"./pkg"}]));
    let store = f.open();
    let detail = store.read("sample@ecosystem").unwrap();
    assert_eq!(names(&detail.skills), expected(&["Codex"]));
    install(&store, &detail);
    assert_eq!(
        mcp_names(&f.open(), &detail.id),
        BTreeSet::from(["codex".into()])
    );
}

#[test]
fn unsafe_claude_entry_paths_and_unknown_sources_leave_no_installation() {
    for unsafe_kind in ["traversal", "unknown"] {
        let f = Fixture::new();
        let outside = tempfile::tempdir_in(f.corpus.path().parent().unwrap()).unwrap();
        write(
            outside.path(),
            ".claude-plugin/plugin.json",
            r#"{"name":"unsafe","skills":"skills"}"#,
        );
        skill(outside.path(), "skills/escaped", "Escaped");
        let marker = f.state.path().join("SOURCE_EXECUTED");
        let source = if unsafe_kind == "traversal" {
            json!(format!(
                "../{}",
                outside.path().file_name().unwrap().to_str().unwrap()
            ))
        } else {
            json!({"source":"future-executable","command":format!("touch '{}'", marker.display())})
        };
        f.catalog(json!([{"name":"unsafe","source":source,"strict":false,"skills":["skills"]}]));
        let store = f.open();
        let list = store.list().unwrap();
        assert!(list.data.is_empty(), "{unsafe_kind} source was accepted");
        assert!(!list.errors.is_empty(), "missing source diagnostic");
        assert!(store.installed_skills().unwrap().is_empty());
        assert!(!marker.exists());
    }
    let f = Fixture::new();
    skill(f.corpus.path(), "pkg/skills/safe", "Safe");
    skill(f.corpus.path(), "outside", "Escaped");
    f.catalog(json!([entry("unsafe", "./pkg", "../outside")]));
    let list = f.open().list().unwrap();
    assert!(list.data.is_empty(), "entry skill traversal was accepted");
    assert!(!list.errors.is_empty());
}

#[test]
fn zcode_unsupported_executable_declarations_are_visible_and_never_run() {
    let f = Fixture::new();
    skill(f.corpus.path(), "pkg/skills/safe", "Safe");
    let marker = f.state.path().join("EXECUTED");
    let command = format!("touch '{}'", marker.display());
    write(
        f.corpus.path(),
        "pkg/.zcode-plugin/plugin.json",
        &json!({"name":"sample","skills":"skills","commands":{"run":{"command":command}},"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":command}]}]}}).to_string(),
    );
    f.catalog(json!([{"name":"sample","source":"./pkg"}]));
    let store = f.open();
    let detail = store.read("sample@ecosystem").unwrap();
    assert_eq!(names(&detail.skills), expected(&["Safe"]));
    for component in ["commands", "hooks"] {
        assert!(
            detail
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.to_lowercase().contains(component)),
            "missing {component} diagnostic"
        );
    }
    install(&store, &detail);
    f.open().installed_components().unwrap();
    assert!(
        !marker.exists(),
        "declaration executed while discovering or installing"
    );
}

#[test]
fn directory_source_alias_and_github_preview_use_existing_source_contracts() {
    let f = Fixture::new();
    skill(f.corpus.path(), "pkg/skills/safe", "Safe");
    write(
        f.corpus.path(),
        "pkg/.claude-plugin/plugin.json",
        r#"{"name":"local","skills":"skills"}"#,
    );
    f.catalog(json!([
        {"name":"local","source":{"source":"directory","path":"./pkg"}},
        {"name":"remote","source":{"source":"github","repo":"fixture-owner/fixture-plugin","ref":"main"}}
    ]));
    let store = f.open();
    let list = store.list().unwrap();
    assert!(list.errors.is_empty(), "{:?}", list.errors);
    let local = store.read("local@ecosystem").unwrap();
    assert_eq!(
        names(&install(&store, &local).installed_skills),
        expected(&["Safe"])
    );
    let remote = store.read("remote@ecosystem").unwrap();
    assert!(
        remote.source_digest.is_empty(),
        "preview fetched an unreviewed remote source"
    );
    assert_eq!(remote.catalog_source["type"], "git");
    assert_eq!(
        remote.catalog_source["url"],
        "https://github.com/fixture-owner/fixture-plugin.git"
    );
    assert_eq!(remote.catalog_source["refName"], "main");
}

#[test]
fn typed_git_url_keeps_its_dialect_when_repository_name_ends_in_json() {
    let f = Fixture::new();
    f.catalog(json!([
        {"name":"remote","source":{"source":"url","url":"https://example.invalid/plugin.json"}}
    ]));
    let store = f.open();
    let detail = store.read("remote@ecosystem").unwrap();
    assert_eq!(detail.catalog_source["type"], "git");
    assert_eq!(
        detail.catalog_source["url"],
        "https://example.invalid/plugin.json"
    );
    assert!(detail.source_digest.is_empty());
}

fn git(root: &Path, args: &[&str]) -> String {
    let result = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout).unwrap().trim().into()
}

#[test]
fn local_git_marketplace_preserves_manifestless_entry_selection_after_checkout() {
    let f = Fixture::new();
    skill(f.corpus.path(), "skills/alpha", "Alpha");
    skill(f.corpus.path(), "skills/beta", "Beta");
    f.catalog(json!([
        entry("alpha", "./", "./skills/alpha"),
        entry("beta", "./", "./skills/beta")
    ]));
    git(f.corpus.path(), &["init", "-q"]);
    git(f.corpus.path(), &["add", "."]);
    git(
        f.corpus.path(),
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@invalid",
            "commit",
            "-qm",
            "fixture",
        ],
    );
    let commit = git(f.corpus.path(), &["rev-parse", "HEAD"]);
    let project = tempfile::tempdir().unwrap();
    let store = Store::open(f.state.path().into(), project.path().into(), None).unwrap();
    let registered = store
        .add_git_marketplace(f.corpus.path().to_str().unwrap(), None, 0)
        .unwrap();
    assert!(registered.errors.is_empty(), "{:?}", registered.errors);
    assert_eq!(
        registered.marketplaces[0].resolved_commit.as_deref(),
        Some(commit.as_str())
    );
    let selected = store.read("alpha@ecosystem").unwrap();
    assert_eq!(names(&selected.skills), expected(&["Alpha"]));
    install(&store, &selected);
    let reopened = Store::open(f.state.path().into(), project.path().into(), None).unwrap();
    assert_eq!(
        names(&reopened.installed_skills().unwrap()),
        expected(&["Alpha"])
    );
}

#[test]
fn review_identity_is_entry_scoped_and_legacy_raw_tokens_remain_compatible() {
    let f = Fixture::new();
    skill(f.corpus.path(), "pkg/skills/alpha", "Alpha");
    skill(f.corpus.path(), "pkg/skills/beta", "Beta");
    let alpha = entry("alpha", "./pkg", "skills/alpha");
    let mut beta = entry("beta", "./pkg", "skills/beta");
    f.catalog(json!([alpha, beta]));
    let store = f.open();
    let reviewed = store.read("alpha@ecosystem").unwrap();
    let other = store.read("beta@ecosystem").unwrap();
    assert_eq!(reviewed.source_digest, other.source_digest);
    assert_ne!(reviewed.admission_digest, other.admission_digest);
    assert!(reviewed.admission_digest.is_some());
    assert!(
        store
            .install(
                &reviewed.id,
                "user",
                reviewed.revision,
                &reviewed.source,
                &reviewed.source_digest
            )
            .is_err()
    );
    beta["description"] = json!("Unrelated entry changes");
    f.catalog(json!([alpha, beta]));
    assert_eq!(
        store.read(&reviewed.id).unwrap().review_digest(),
        reviewed.review_digest()
    );
    let installed = install(&store, &reviewed);
    assert_eq!(
        installed.installed_digest.as_deref(),
        Some(reviewed.review_digest())
    );
    assert_eq!(
        installed.installed_source_digest.as_deref(),
        Some(reviewed.source_digest.as_str())
    );
    assert_eq!(
        installed.installed_skills[0].revision,
        reviewed.review_digest()
    );
    assert_eq!(
        store.enabled_revisions().unwrap()[&reviewed.id],
        reviewed.review_digest()
    );
    write(
        f.corpus.path(),
        "legacy/.codex-plugin/plugin.json",
        r#"{"name":"legacy"}"#,
    );
    skill(f.corpus.path(), "legacy/skills/safe", "Legacy");
    f.catalog(json!([{"name":"legacy","source":"./legacy"}]));
    let legacy = store.read("legacy@ecosystem").unwrap();
    assert!(legacy.admission_digest.is_none());
    assert!(
        store
            .install(
                &legacy.id,
                "user",
                legacy.revision,
                &legacy.source,
                &legacy.source_digest
            )
            .is_ok()
    );
}

#[test]
fn catalog_policy_and_dependency_changes_reject_old_review_and_preserve_installed_definition() {
    for field in ["policy", "dependencies"] {
        let f = Fixture::new();
        skill(f.corpus.path(), "pkg/skills/alpha", "Alpha");
        let mut selected = entry("sample", "./pkg", "skills/alpha");
        f.catalog(json!([selected]));
        let store = f.open();
        let reviewed = store.read("sample@ecosystem").unwrap();
        selected[field] = if field == "policy" {
            json!({"authentication":"ON_USE"})
        } else {
            json!({"private-sdk":"1.0"})
        };
        f.catalog(json!([selected]));
        let changed = store.read(&reviewed.id).unwrap();
        assert_eq!(reviewed.source_digest, changed.source_digest);
        assert_ne!(reviewed.review_digest(), changed.review_digest());
        assert!(
            store
                .install(
                    &reviewed.id,
                    "user",
                    reviewed.revision,
                    &reviewed.source,
                    reviewed.review_digest()
                )
                .is_err()
        );
        install(&store, &changed);
        if field == "policy" {
            assert_eq!(
                store.installed_components().unwrap()[0].policy["authentication"],
                "ON_USE"
            );
        } else {
            assert!(store.enabled_skills().unwrap().is_empty());
            assert!(store.enabled_components().unwrap().is_empty());
        }
    }
}

#[test]
fn retained_skill_revision_survives_update_catalog_removal_and_revocation() {
    let f = Fixture::new();
    skill(f.corpus.path(), "pkg/skills/alpha", "Alpha");
    skill(f.corpus.path(), "pkg/skills/beta", "Beta");
    f.catalog(json!([entry("sample", "./pkg", "skills/alpha")]));
    let store = f.open();
    let installed = install(&store, &store.read("sample@ecosystem").unwrap());
    let old = installed.installed_skills[0].clone();
    f.catalog(json!([entry("sample", "./pkg", "skills/beta")]));
    install(&store, &store.read(&installed.id).unwrap());
    fs::remove_file(f.corpus.path().join(".claude-plugin/marketplace.json")).unwrap();
    let reopened = f.open();
    assert!(reopened.is_skill_enabled(&old.id, &old.revision).unwrap());
    assert!(
        reopened
            .installed_snapshot()
            .unwrap()
            .eligible_skill_refs
            .contains(&(old.id.clone(), old.revision.clone()))
    );
    assert_eq!(
        names(&reopened.enabled_skills().unwrap()),
        expected(&["Beta"])
    );
    let current = reopened.read(&installed.id).unwrap();
    reopened
        .configure(&current.id, "user", false, current.revision)
        .unwrap();
    assert!(!reopened.is_skill_enabled(&old.id, &old.revision).unwrap());
    let current = reopened.read(&installed.id).unwrap();
    reopened
        .configure(&current.id, "user", true, current.revision)
        .unwrap();
    let current = reopened.read(&installed.id).unwrap();
    reopened.uninstall(&current.id, current.revision).unwrap();
    assert!(!reopened.is_skill_enabled(&old.id, &old.revision).unwrap());
}

#[test]
fn missing_or_tampered_context_receipts_and_cache_fail_closed() {
    for corruption in ["missing", "definition", "cache"] {
        let f = Fixture::new();
        skill(f.corpus.path(), "pkg/skills/alpha", "Alpha");
        f.catalog(json!([entry("sample", "./pkg", "skills/alpha")]));
        let store = f.open();
        let installed = install(&store, &store.read("sample@ecosystem").unwrap());
        let old = installed.installed_skills[0].clone();
        if corruption == "cache" {
            use std::os::unix::fs::PermissionsExt;
            let path = old.root.join("SKILL.md");
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
            fs::write(path, "tampered").unwrap();
        } else {
            let state_path = f.state.path().join("state.json");
            let mut state: Value = serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
            if corruption == "missing" {
                state.as_object_mut().unwrap().remove("definitions");
            } else {
                state["definitions"]
                    .as_object_mut()
                    .unwrap()
                    .values_mut()
                    .next()
                    .unwrap()["context"]["entry"]["skills"] = json!(["skills/other"]);
            }
            fs::write(state_path, serde_json::to_vec(&state).unwrap()).unwrap();
        }
        assert!(
            store.installed_components().is_err(),
            "{corruption} retained cached components"
        );
        assert!(
            f.open().installed_snapshot().is_err(),
            "{corruption} survived restart"
        );
        assert!(
            f.open().is_skill_enabled(&old.id, &old.revision).is_err(),
            "{corruption} allowed old skill"
        );
    }
}

#[test]
fn dependencies_and_user_configuration_never_reach_execution_documents() {
    for requirement in ["dependencies", "userConfig"] {
        let f = Fixture::new();
        skill(f.corpus.path(), "pkg/skills/alpha", "Alpha");
        let mut manifest = json!({"name":"sample","skills":"skills","mcpServers":{"safe":{"command":"fixture-do-not-start"}},"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"fixture-do-not-start"}]}]}});
        manifest[requirement] = if requirement == "dependencies" {
            json!({"private-host-sdk":"1.0"})
        } else {
            json!({"token":{"type":"string","required":true,"default":"PRIVATE_DEFAULT"}})
        };
        write(
            f.corpus.path(),
            "pkg/.zcode-plugin/plugin.json",
            &manifest.to_string(),
        );
        f.catalog(json!([{"name":"sample","source":"./pkg"}]));
        let store = f.open();
        let selected = store.read("sample@ecosystem").unwrap();
        assert!(
            !serde_json::to_string(&selected)
                .unwrap()
                .contains("PRIVATE_DEFAULT")
        );
        assert_eq!(
            serde_json::to_value(&selected).unwrap()["componentSupport"]["compatibility"]["state"],
            "blocked"
        );
        install(&store, &selected);
        assert!(store.enabled_skills().unwrap().is_empty());
        assert!(store.enabled_components().unwrap().is_empty());
        let components = store.installed_components().unwrap();
        assert!(components[0].mcp_documents.is_empty());
        assert!(components[0].hook_documents.is_empty());
    }
    let f = Fixture::new();
    skill(f.corpus.path(), "pkg/skills/alpha", "Alpha");
    write(
        f.corpus.path(),
        "pkg/.zcode-plugin/plugin.json",
        r#"{"name":"sample","mcpServers":{"safe":{"command":"fixture-do-not-start"}},"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"fixture-do-not-start"}]}]}}"#,
    );
    f.catalog(json!([{"name":"sample","source":"./pkg"}]));
    let store = f.open();
    install(&store, &store.read("sample@ecosystem").unwrap());
    let components = store.enabled_components().unwrap();
    assert_eq!(components[0].mcp_documents.len(), 1);
    assert!(components[0].hook_documents.is_empty());
    assert_eq!(store.enabled_skills().unwrap().len(), 1);
}

#[test]
fn portable_host_requirements_are_exact_metadata_and_unknown_versions_reject() {
    let f = Fixture::new();
    skill(f.corpus.path(), "pkg/skills/alpha", "Alpha");
    let mut manifest = json!({"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"sample","extensions":{"org.areal":{"hostRequirements":{"version":1,"tools":["browser_v1","computer_v1"]}}}});
    write(f.corpus.path(), "pkg/plugin.json", &manifest.to_string());
    f.catalog(json!([{"name":"sample","source":"./pkg"}]));
    let store = f.open();
    let selected = store.read("sample@ecosystem").unwrap();
    assert_eq!(selected.required_tools, vec!["browser_v1", "computer_v1"]);
    assert_eq!(selected.skills[0].required_tools, selected.required_tools);
    install(&store, &selected);
    assert_eq!(
        f.open().installed_skills().unwrap()[0].required_tools,
        selected.required_tools
    );
    for invalid in [
        json!({"version":2,"tools":["browser_v1"]}),
        json!({"version":1,"tools":["browser_v1","browser_v1"]}),
        json!({"version":1,"tools":["browser_v1"],"grant":true}),
    ] {
        manifest["extensions"]["org.areal"]["hostRequirements"] = invalid;
        write(f.corpus.path(), "pkg/plugin.json", &manifest.to_string());
        let list = store.list().unwrap();
        assert!(!list.errors.is_empty());
        assert!(list.data[0].component_support.is_none());
    }
}

#[test]
fn malformed_strict_and_unsupported_source_types_do_not_resolve_or_install() {
    let f = Fixture::new();
    skill(f.corpus.path(), "pkg/skills/alpha", "Alpha");
    f.catalog(json!([{"name":"bad","source":"./pkg","strict":"false"}]));
    assert!(!f.open().list().unwrap().errors.is_empty());
    for kind in ["archive", "command", "pip"] {
        f.catalog(json!([{"name":"sample","source":{"source":kind,"url":"https://example.invalid/package","command":"never-execute"}}]));
        let store = f.open();
        let selected = store.read("sample@ecosystem").unwrap();
        assert!(
            selected
                .diagnostics
                .iter()
                .any(|d| d.contains("sourceUnsupported"))
        );
        assert!(
            store
                .resolve_remote(&selected.id, selected.revision)
                .is_err()
        );
        assert!(
            store
                .install(
                    &selected.id,
                    "user",
                    selected.revision,
                    &selected.source,
                    selected.review_digest()
                )
                .is_err()
        );
    }
}

#[test]
fn strict_component_diagnostics_keep_original_origins_and_hook_event_replacement() {
    let f = Fixture::new();
    skill(f.corpus.path(), "pkg/skills/alpha", "Alpha");
    let hook = |command: &str| json!({"hooks":[{"type":"command","command":command}]});
    write(f.corpus.path(),"pkg/.claude-plugin/plugin.json",&json!({"name":"sample","commands":["commands/manifest.md"],"hooks":{"hooks":{"SessionStart":[hook("manifest-one"),hook("manifest-two")],"Stop":[hook("manifest-stop")]}}}).to_string());
    f.catalog(json!([{"name":"sample","source":"./pkg","commands":["commands/entry.md"],"hooks":{"hooks":{"SessionStart":[hook("entry-one")]}}}]));
    let store = f.open();
    let detail = store.read("sample@ecosystem").unwrap();
    let report = serde_json::to_value(&detail).unwrap();
    let rows = report["componentSupport"]["components"].as_array().unwrap();
    let commands: BTreeSet<_> = rows
        .iter()
        .filter(|r| r["kind"] == "commands")
        .map(|r| r["sourceField"].as_str().unwrap())
        .collect();
    assert_eq!(
        commands,
        BTreeSet::from([
            ".claude-plugin/plugin.json#/commands/0",
            ".claude-plugin/marketplace.json#/plugins/0/commands/0"
        ])
    );
    let hooks: Vec<_> = rows.iter().filter(|r| r["kind"] == "hooks").collect();
    assert_eq!(
        hooks.len(),
        2,
        "entry must replace only SessionStart matchers"
    );
    assert!(hooks.iter().all(|row| row["status"] == "unsupported"));
    assert!(
        hooks
            .iter()
            .any(|row| row["sourceField"]
                == ".claude-plugin/plugin.json#/hooks/hooks/Stop/0/hooks/0")
    );
    assert!(hooks.iter().any(|row| row["sourceField"]
        == ".claude-plugin/marketplace.json#/plugins/0/hooks/hooks/SessionStart/0/hooks/0"));
    install(&store, &detail);
    assert!(
        store.enabled_components().unwrap()[0]
            .hook_documents
            .is_empty()
    );
}

#[test]
fn claude_manifest_ignores_entry_only_fields_in_both_strict_modes() {
    for strict in [true, false] {
        let f = Fixture::new();
        write(
            f.corpus.path(),
            "pkg/.claude-plugin/plugin.json",
            r#"{"name":"sample","mcpServers":{"manifest":{"command":"never-started"}}}"#,
        );
        f.catalog(json!([{"name":"sample","source":"./pkg","strict":strict,
            "mcpServers":{"entry":{"command":"never-started"}},
            "lspServers":{"entry":{"command":"never-started"}},
            "userConfig":{"token":{"type":"string"}},"channels":["entry"],
            "apps":[{"id":"entry"}],"ui":{"surfaces":["entry"]}}]));
        let store = f.open();
        let detail = store.read("sample@ecosystem").unwrap();
        let report = serde_json::to_value(&detail).unwrap();
        let rows = report["componentSupport"]["components"]
            .as_array()
            .expect("entry-only fields must not conflict with the manifest");
        assert_eq!(
            rows.len(),
            1,
            "entry-only declarations must not appear in support"
        );
        assert_eq!(
            rows[0]["sourceField"],
            ".claude-plugin/plugin.json#/mcpServers/manifest"
        );
        assert_eq!(rows[0]["status"], "supported");
        install(&store, &detail);
        assert_eq!(
            mcp_names(&store, &detail.id),
            BTreeSet::from(["manifest".into()])
        );
    }
}

#[test]
fn claude_manifest_retains_its_requirements_when_entry_clears_them() {
    let f = Fixture::new();
    write(
        f.corpus.path(),
        "pkg/.claude-plugin/plugin.json",
        r#"{"name":"sample","userConfig":{"token":{"type":"string"}},"dependencies":["required"],"mcpServers":{"manifest":{"command":"never-started"}}}"#,
    );
    f.catalog(json!([{"name":"sample","source":"./pkg","userConfig":{},"dependencies":[]}]));
    let store = f.open();
    let detail = store.read("sample@ecosystem").unwrap();
    let report = serde_json::to_value(&detail).unwrap();
    let reasons = report["componentSupport"]["compatibility"]["reasonCodes"]
        .as_array()
        .unwrap();
    assert!(reasons.contains(&json!("userConfigUnsupported")));
    assert!(reasons.contains(&json!("packageDependenciesUnsupported")));
    install(&store, &detail);
    assert!(mcp_names(&store, &detail.id).is_empty());
}

#[test]
fn claude_manifest_skill_paths_add_to_default_skills() {
    let f = Fixture::new();
    skill(f.corpus.path(), "pkg/skills/default", "Default");
    skill(f.corpus.path(), "pkg/extra/selected", "Extra");
    write(
        f.corpus.path(),
        "pkg/.claude-plugin/plugin.json",
        r#"{"name":"sample","skills":["./extra"]}"#,
    );
    f.catalog(json!([{"name":"sample","source":"./pkg"}]));
    let store = f.open();
    let detail = store.read("sample@ecosystem").unwrap();
    assert_eq!(names(&detail.skills), expected(&["Default", "Extra"]));
    install(&store, &detail);
    drop(store);
    assert_eq!(
        names(&f.open().enabled_skills().unwrap()),
        expected(&["Default", "Extra"])
    );
}

#[test]
fn claude_manifest_mcp_merges_default_and_explicit_documents_with_last_name_winning() {
    let f = Fixture::new();
    write(
        f.corpus.path(),
        "pkg/.mcp.json",
        r#"{"mcpServers":{"default":{"command":"default"},"shared":{"url":"https://old.invalid/mcp"}}}"#,
    );
    write(
        f.corpus.path(),
        "pkg/extra.json",
        r#"{"mcpServers":{"file":{"command":"file"},"shared":{"url":"https://middle.invalid/mcp"}}}"#,
    );
    write(
        f.corpus.path(),
        "pkg/.claude-plugin/plugin.json",
        r#"{"name":"sample","mcpServers":["./extra.json",{"shared":{"url":"https://last.invalid/mcp"},"inline":{"command":"inline"}}]}"#,
    );
    f.catalog(json!([{"name":"sample","source":"./pkg"}]));
    let store = f.open();
    let detail = store.read("sample@ecosystem").unwrap();
    let report = serde_json::to_value(&detail).unwrap();
    let sources: BTreeSet<_> = report["componentSupport"]["components"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["kind"] == "mcp")
        .map(|row| row["sourceField"].as_str().unwrap())
        .collect();
    assert_eq!(
        sources,
        BTreeSet::from([
            ".mcp.json#/mcpServers/default",
            "extra.json#/mcpServers/file",
            ".claude-plugin/plugin.json#/mcpServers/1/shared",
            ".claude-plugin/plugin.json#/mcpServers/1/inline"
        ])
    );
    install(&store, &detail);
    drop(store);
    let components = f.open().installed_components().unwrap();
    let documents = &components[0].mcp_documents;
    let servers: Vec<_> = documents
        .iter()
        .flat_map(|d| {
            d.declaration
                .normalize(&components[0].root, &components[0].data_root)
                .unwrap()
                .servers
        })
        .collect();
    assert_eq!(
        servers.len(),
        4,
        "effective server names must be unique for Engine admission"
    );
    assert_eq!(
        servers
            .iter()
            .find(|(name, _)| name.as_str() == "shared")
            .unwrap()
            .1
            .endpoint(),
        Some("https://last.invalid/mcp")
    );
    assert_eq!(
        documents
            .iter()
            .map(|d| d.origin.as_str())
            .collect::<Vec<_>>(),
        vec![".mcp.json", "extra.json", "manifest"]
    );
    assert_eq!(
        fs::read_to_string(components[0].root.join(".mcp.json")).unwrap(),
        r#"{"mcpServers":{"default":{"command":"default"},"shared":{"url":"https://old.invalid/mcp"}}}"#
    );
}
