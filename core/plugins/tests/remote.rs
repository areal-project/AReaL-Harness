//! 预先选定失败方式：远程列表副作用、可变 ref、旧 CAS、篡改包、归档链接、失败更新及凭据外泄。
use areal_plugins::Store;
use serde_json::json;
use std::{fs, path::Path, process::Command};
fn write(root: &Path, path: &str, body: &str) {
    let p = root.join(path);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, body).unwrap();
}
fn git(root: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap().trim().into()
}
fn manifest() -> &'static str {
    r#"{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"sample","extensions":{"com.openai":{}}}"#
}
#[test]
fn git_subdir_resolution_pin_cas_drift_and_components() {
    let t = tempfile::tempdir().unwrap();
    let repo = t.path().join("repo");
    fs::create_dir(&repo).unwrap();
    write(&repo, "pkg/plugin.json", manifest());
    write(
        &repo,
        "pkg/mcp.json",
        r#"{"mcpServers":{"valid":{"command":"echo","env":{"SECRET":"private-secret"}},"invalid":7}}"#,
    );
    write(
        &repo,
        "pkg/.app.json",
        r#"{"apps":[{"id":"connector_fixture"}]}"#,
    );
    git(&repo, &["init", "-q"]);
    git(&repo, &["add", "."]);
    git(
        &repo,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@invalid",
            "commit",
            "-qm",
            "initial",
        ],
    );
    let pin = git(&repo, &["rev-parse", "HEAD"]);
    write(t.path(),".agents/plugins/marketplace.json",&json!({"name":"fixture","plugins":[{"name":"sample","source":{"source":"git-subdir","url":repo,"path":"pkg"},"policy":{"authentication":"ON_INSTALL","installation":"AVAILABLE"}}]}).to_string());
    let store = Store::open(t.path().join("state"), t.path().into(), None).unwrap();
    let preview = store.read("sample@fixture").unwrap();
    assert!(preview.source_digest.is_empty());
    assert!(
        store
            .install(&preview.id, "user", 0, &preview.source, "")
            .is_err()
    );
    let d = store.resolve_remote(&preview.id, 0).unwrap();
    assert_eq!(d.resolved_commit.as_deref(), Some(pin.as_str()));
    assert_eq!(d.revision, 1);
    assert!(store.resolve_remote(&d.id, 0).is_err());
    let installed = store
        .install(&d.id, "user", 1, &d.source, d.review_digest())
        .unwrap();
    write(&repo, "pkg/plugin.json", "broken");
    git(&repo, &["add", "."]);
    git(
        &repo,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@invalid",
            "commit",
            "-qm",
            "drift",
        ],
    );
    assert!(store.resolve_remote(&d.id, 2).is_err());
    assert_eq!(
        store.read(&d.id).unwrap().installed_digest,
        installed.installed_digest
    );
    let c = store.enabled_components().unwrap();
    assert_eq!(c.len(), 1);
    assert_eq!(c[0].mcp_documents.len(), 1);
    assert_eq!(c[0].app_documents.len(), 1);
    assert_eq!(c[0].policy["authentication"], "ON_INSTALL");
    assert!(!c[0].root.join(".git").exists());
    assert!(
        !serde_json::to_string(&store.read(&d.id).unwrap())
            .unwrap()
            .contains("private-secret")
    );
    store.configure(&d.id, "user", false, 2).unwrap();
    assert!(store.enabled_components().unwrap().is_empty());
    assert_eq!(store.installed_components().unwrap().len(), 1);
}
#[test]
fn git_marketplace_and_bad_component_sibling() {
    let t = tempfile::tempdir().unwrap();
    let repo = t.path().join("repo");
    fs::create_dir(&repo).unwrap();
    write(
        &repo,
        ".agents/plugins/marketplace.json",
        r#"{"name":"gitmarket","plugins":[{"name":"sample","source":"pkg"}]}"#,
    );
    write(
        &repo,
        "pkg/.codex-plugin/plugin.json",
        r#"{"name":"sample","mcpServers":["missing.json","valid.json"],"hooks":{}}"#,
    );
    write(
        &repo,
        "pkg/valid.json",
        r#"{"mcpServers":{"ok":{"command":"echo"}}}"#,
    );
    git(&repo, &["init", "-q"]);
    git(&repo, &["add", "."]);
    git(
        &repo,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@invalid",
            "commit",
            "-qm",
            "initial",
        ],
    );
    let store = Store::open(t.path().join("state"), t.path().into(), None).unwrap();
    let list = store
        .add_git_marketplace(repo.to_str().unwrap(), None, 0)
        .unwrap();
    let d = &list.data[0];
    store
        .install(&d.id, "user", 1, &d.source, &d.source_digest)
        .unwrap();
    let c = store.enabled_components().unwrap();
    assert_eq!(c[0].mcp_documents.len(), 1);
    assert!(c[0].diagnostics.iter().any(|v| v.contains("missing")));
    assert!(
        c[0].diagnostics
            .iter()
            .any(|v| v.contains("hook definition trust"))
    );
}
fn archive(link: bool) -> Vec<u8> {
    let mut tar = tar::Builder::new(Vec::new());
    for (path, body) in [
        ("package/plugin.json", manifest()),
        ("package/bin/fixture", "#!/bin/sh\nprintf executable-ok\n"),
        (
            "package/package.json",
            r#"{"name":"@fixture/sample","version":"1.2.0","scripts":{"install":"touch LIFECYCLE_EXECUTED"}}"#,
        ),
    ] {
        let mut h = tar::Header::new_gnu();
        h.set_size(body.len() as u64);
        h.set_mode(if path == "package/bin/fixture" {
            0o755
        } else {
            0o644
        });
        h.set_cksum();
        tar.append_data(&mut h, path, body.as_bytes()).unwrap();
    }
    if link {
        let mut h = tar::Header::new_gnu();
        h.set_entry_type(tar::EntryType::Symlink);
        h.set_size(0);
        h.set_mode(0o777);
        h.set_link_name("/tmp/escape").unwrap();
        h.set_cksum();
        tar.append_data(&mut h, "package/escape", std::io::empty())
            .unwrap();
    }
    let bytes = tar.into_inner().unwrap();
    let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    use std::io::Write;
    gzip.write_all(&bytes).unwrap();
    gzip.finish().unwrap()
}
fn registry(bytes: Vec<u8>, corrupt: bool) -> (String, std::thread::JoinHandle<()>) {
    use base64::Engine;
    use sha2::{Digest, Sha512};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let url = base.clone();
    let thread = std::thread::spawn(move || {
        for _ in 0..2 {
            let (mut s, _) = listener.accept().unwrap();
            let mut input = [0; 4096];
            let n = s.read(&mut input).unwrap();
            let req = String::from_utf8_lossy(&input[..n]);
            let body = if req.starts_with("GET /archive ") {
                bytes.clone()
            } else {
                let hash = if corrupt {
                    Sha512::digest(b"wrong")
                } else {
                    Sha512::digest(&bytes)
                };
                json!({"versions":{"1.2.0":{"name":"@fixture/sample","version":"1.2.0","dist":{"tarball":format!("{url}/archive"),"integrity":format!("sha512-{}",base64::engine::general_purpose::STANDARD.encode(hash))}}},"dist-tags":{"latest":"1.2.0"}}).to_string().into_bytes()
            };
            write!(
                s,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            s.write_all(&body).unwrap();
        }
    });
    (base, thread)
}
#[test]
fn scoped_npm_registry_integrity_scripts_and_unsafe_archive() {
    for (link, corrupt, selector) in [
        (false, false, "^1.0.0"),
        (false, false, "1.2"),
        (false, false, ">=1.0.0 <2.0.0 || >=3"),
        (true, false, "latest"),
        (false, true, "1.2.0"),
    ] {
        let t = tempfile::tempdir().unwrap();
        let (registry, server) = registry(archive(link), corrupt);
        write(t.path(),".agents/plugins/marketplace.json",&json!({"name":"fixture","plugins":[{"name":"sample","source":{"source":"npm","package":"@fixture/sample","version":selector,"registry":registry}}]}).to_string());
        let store = Store::open(t.path().join("state"), t.path().into(), None).unwrap();
        assert!(
            store
                .read("sample@fixture")
                .unwrap()
                .source_digest
                .is_empty()
        );
        let result = store.resolve_remote("sample@fixture", 0);
        server.join().unwrap();
        if link || corrupt {
            assert!(result.is_err());
            assert_eq!(store.list().unwrap().revision, 0);
        } else {
            let d = result.unwrap();
            assert_eq!(d.package_version.as_deref(), Some("1.2.0"));
            store
                .install(&d.id, "user", 1, &d.source, &d.source_digest)
                .unwrap();
            assert!(
                !store.enabled_components().unwrap()[0]
                    .root
                    .join("LIFECYCLE_EXECUTED")
                    .exists()
            );
        }
    }
}
#[test]
fn portable_overlay_is_replaced_and_installed_cache_is_validated() {
    use std::os::unix::fs::PermissionsExt;
    let t = tempfile::tempdir().unwrap();
    write(
        t.path(),
        ".agents/plugins/marketplace.json",
        r#"{"name":"fixture","plugins":[{"name":"sample","source":"pkg"}]}"#,
    );
    write(t.path(), "pkg/plugin.json", manifest());
    write(
        t.path(),
        "pkg/.codex-plugin/plugin.json",
        r#"{"name":"sample","apps":"legacy-app.json","mcpServers":{"legacy":{"command":"wrong"}}}"#,
    );
    write(
        t.path(),
        "pkg/legacy-app.json",
        r#"{"apps":[{"id":"must_not_load"}]}"#,
    );
    write(
        t.path(),
        "pkg/mcp.json",
        r#"{"mcpServers":{"portable":{"command":"echo"}}}"#,
    );
    let store = Store::open(t.path().join("state"), t.path().into(), None).unwrap();
    let d = store.read("sample@fixture").unwrap();
    store
        .install(&d.id, "user", 0, &d.source, &d.source_digest)
        .unwrap();
    let c = store.installed_components().unwrap();
    assert!(c[0].app_documents.is_empty());
    assert_eq!(c[0].mcp_documents.len(), 1);
    assert!(
        c[0].mcp_documents[0]
            .declaration
            .normalize(&c[0].root, &c[0].data_root)
            .is_err(),
        "portable source must retain strict MCP schema validation"
    );
    let path = c[0].root.join("mcp.json");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    fs::write(&path, "{}").unwrap();
    assert!(store.installed_components().is_err());
}
#[test]
fn npm_executable_mode_survives_install_without_running_lifecycle() {
    use std::os::unix::fs::PermissionsExt;
    let t = tempfile::tempdir().unwrap();
    let (registry, server) = registry(archive(false), false);
    write(t.path(), ".agents/plugins/marketplace.json", &json!({"name":"fixture","plugins":[{"name":"sample","source":{"source":"npm","package":"@fixture/sample","registry":registry}}]}).to_string());
    let store = Store::open(t.path().join("state"), t.path().into(), None).unwrap();
    let d = store.resolve_remote("sample@fixture", 0).unwrap();
    server.join().unwrap();
    store
        .install(&d.id, "user", 1, &d.source, &d.source_digest)
        .unwrap();
    let root = store.enabled_components().unwrap().remove(0).root;
    assert_eq!(
        fs::metadata(root.join("bin/fixture"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o555
    );
    assert!(!root.join("LIFECYCLE_EXECUTED").exists());
    // 测试显式调用可信 fixture，不是 npm 生命周期执行。
    let result = Command::new(root.join("bin/fixture"))
        .current_dir(t.path())
        .output()
        .unwrap();
    assert!(result.status.success());
    assert_eq!(result.stdout, b"executable-ok");
}
fn commit_fixture(repo: &Path, message: &str) {
    git(repo, &["add", "."]);
    git(
        repo,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@invalid",
            "commit",
            "-qm",
            message,
        ],
    );
}
#[test]
fn git_marketplace_refresh_replaces_registration_but_preserves_install() {
    let t = tempfile::tempdir().unwrap();
    let repo = t.path().join("repo");
    fs::create_dir(&repo).unwrap();
    write(
        &repo,
        ".agents/plugins/marketplace.json",
        r#"{"name":"fixture","plugins":[{"name":"sample","source":"pkg"}]}"#,
    );
    write(&repo, "pkg/plugin.json", manifest());
    git(&repo, &["init", "-q"]);
    commit_fixture(&repo, "A");
    let reference = git(&repo, &["branch", "--show-current"]);
    let store = Store::open(t.path().join("state"), t.path().into(), None).unwrap();
    let a = store
        .add_git_marketplace(repo.to_str().unwrap(), Some(&reference), 0)
        .unwrap()
        .data
        .remove(0);
    let installed = store
        .install(&a.id, "user", 1, &a.source, &a.source_digest)
        .unwrap();
    write(&repo, "pkg/new.txt", "B");
    commit_fixture(&repo, "B");
    let updated = store
        .add_git_marketplace(repo.to_str().unwrap(), Some(&reference), 2)
        .unwrap();
    assert!(updated.errors.is_empty(), "{:?}", updated.errors);
    assert_eq!(updated.marketplaces.len(), 1);
    assert_eq!(
        updated.marketplaces[0].resolved_commit.as_deref(),
        Some(git(&repo, &["rev-parse", "HEAD"]).as_str())
    );
    let b = &updated.data[0];
    assert_ne!(b.source_digest, a.source_digest);
    assert_eq!(b.installed_digest, installed.installed_digest);
    assert_eq!(
        store.enabled_components().unwrap()[0].digest,
        a.source_digest
    );
    assert!(
        store
            .install(&a.id, "user", 3, &a.source, &a.source_digest)
            .is_err()
    );
    store
        .install(&b.id, "user", 3, &b.source, &b.source_digest)
        .unwrap();
    assert_eq!(
        store.enabled_components().unwrap()[0].digest,
        b.source_digest
    );
}
#[test]
fn full_git_marketplace_has_separate_checkout_and_package_limits() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let t = tempfile::tempdir().unwrap();
    let repo = t.path().join("repo");
    fs::create_dir(&repo).unwrap();
    write(
        &repo,
        ".agents/plugins/marketplace.json",
        r#"{"name":"large","plugins":[{"name":"sample","source":"packages/sample"},{"name":"oversized","source":"packages/oversized"}]}"#,
    );
    write(&repo, "packages/sample/plugin.json", manifest());
    write(
        &repo,
        "packages/oversized/plugin.json",
        r#"{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"oversized","extensions":{"com.openai":{}}}"#,
    );
    for index in 0..4100 {
        write(&repo, &format!("unrelated/{index}.txt"), "fixture\n");
    }
    for index in 0..4097 {
        write(
            &repo,
            &format!("packages/oversized/{index}.txt"),
            "fixture\n",
        );
    }
    git(&repo, &["init", "-q"]);
    commit_fixture(&repo, "A");
    let reference = git(&repo, &["branch", "--show-current"]);
    let initial_commit = git(&repo, &["rev-parse", "HEAD"]);
    let source = repo.to_str().unwrap();
    let store = Store::open(t.path().join("state"), t.path().into(), None).unwrap();
    let first = store
        .add_git_marketplace_sparse(source, Some(&reference), &[], 0)
        .expect("full marketplace checkout must have its own limits");
    assert_eq!(first.revision, 1);
    assert_eq!(first.marketplaces.len(), 1);
    assert_eq!(first.marketplaces[0].name, "large");
    assert_eq!(
        first.marketplaces[0].resolved_commit.as_deref(),
        Some(initial_commit.as_str())
    );
    let root = &first.marketplaces[0].root;
    let root_identity = fs::metadata(root).unwrap();
    assert_eq!(fs::read_dir(root.join("unrelated")).unwrap().count(), 4100);
    assert_eq!(
        fs::read_to_string(root.join("unrelated/4099.txt")).unwrap(),
        "fixture\n"
    );
    assert_eq!(root_identity.permissions().mode() & 0o222, 0);
    assert_eq!(
        fs::metadata(root.join("unrelated/4099.txt"))
            .unwrap()
            .permissions()
            .mode()
            & 0o222,
        0
    );
    assert_eq!(first.errors.len(), 1, "{:?}", first.errors);
    assert!(first.errors[0].ends_with("entry \"oversized\": package exceeds 4096 files"));
    assert_eq!(first.data.len(), 1);
    let sample = &first.data[0];
    assert_eq!(sample.id, "sample@large");
    let initial_digest = "f5c7b23ba7457d90f0d7032d7a518e6eb9b1673e275f0b32dd63638ea143c7f9";
    assert_eq!(sample.source_digest, initial_digest);
    let rejected = store
        .install(
            "oversized@large",
            "user",
            1,
            &root.join("packages/oversized"),
            "",
        )
        .unwrap_err();
    assert!(rejected.to_string().contains("package exceeds 4096 files"));
    assert_eq!(store.list().unwrap().revision, 1);
    let installed = store
        .install(&sample.id, "user", 1, &sample.source, initial_digest)
        .unwrap();
    assert!(installed.installed && installed.enabled);
    assert_eq!(installed.installed_digest.as_deref(), Some(initial_digest));

    let repeated = store
        .add_git_marketplace(source, Some(&reference), 2)
        .unwrap();
    assert_eq!(repeated.revision, 3);
    assert_eq!(repeated.marketplaces.len(), 1);
    assert_eq!(repeated.marketplaces[0].root, *root);
    assert_eq!(
        repeated.marketplaces[0].resolved_commit.as_deref(),
        Some(initial_commit.as_str())
    );
    let reused = fs::metadata(&repeated.marketplaces[0].root).unwrap();
    assert_eq!(
        (reused.dev(), reused.ino()),
        (root_identity.dev(), root_identity.ino())
    );
    assert_eq!(repeated.data.len(), 1);
    assert_eq!(repeated.data[0].source_digest, initial_digest);

    write(&repo, "packages/sample/new.txt", "B");
    commit_fixture(&repo, "B");
    let updated_commit = git(&repo, &["rev-parse", "HEAD"]);
    let updated = store.update_marketplaces(3).unwrap();
    assert_eq!(updated.revision, 4);
    assert_eq!(updated.marketplaces.len(), 1);
    let updated_root = &updated.marketplaces[0].root;
    assert_ne!(updated_root, root);
    assert_eq!(
        updated.marketplaces[0].resolved_commit.as_deref(),
        Some(updated_commit.as_str())
    );
    assert_eq!(
        fs::read_to_string(updated_root.join("packages/sample/new.txt")).unwrap(),
        "B"
    );
    assert!(!root.join("packages/sample/new.txt").exists());
    assert_eq!(
        fs::read_dir(updated_root.join("unrelated"))
            .unwrap()
            .count(),
        4100
    );
    assert_eq!(updated.errors.len(), 1, "{:?}", updated.errors);
    assert!(updated.errors[0].ends_with("entry \"oversized\": package exceeds 4096 files"));
    assert_eq!(updated.data.len(), 1);
    assert_eq!(
        updated.data[0].source_digest,
        "3659547d2a11136eceda552c2e6bee1e93e067a3fac0195ed3fa77839a2cfda9"
    );
    assert_eq!(
        updated.data[0].installed_digest.as_deref(),
        Some(initial_digest)
    );
    assert_eq!(
        store.enabled_components().unwrap()[0].digest,
        initial_digest
    );
}
#[test]
fn relative_git_source_resolves_from_marketplace_root() {
    let t = tempfile::tempdir().unwrap();
    let repo = t.path().join("repo");
    fs::create_dir(&repo).unwrap();
    write(&repo, "plugin.json", manifest());
    git(&repo, &["init", "-q"]);
    commit_fixture(&repo, "initial");
    write(
        t.path(),
        ".agents/plugins/marketplace.json",
        r#"{"name":"fixture","plugins":[{"name":"sample","source":{"source":"url","url":"./repo"}}]}"#,
    );
    let store = Store::open(t.path().join("state"), t.path().into(), None).unwrap();
    let d = store.resolve_remote("sample@fixture", 0).unwrap();
    assert_eq!(
        d.resolved_commit.as_deref(),
        Some(git(&repo, &["rev-parse", "HEAD"]).as_str())
    );
}
#[test]
fn marketplace_refresh_failure_and_remove_preserve_installed_content() {
    let t = tempfile::tempdir().unwrap();
    let repo = t.path().join("repo");
    fs::create_dir(&repo).unwrap();
    let catalog = r#"{"name":"fixture","plugins":[{"name":"sample","source":"pkg"}]}"#;
    write(&repo, ".agents/plugins/marketplace.json", catalog);
    write(&repo, "pkg/plugin.json", manifest());
    git(&repo, &["init", "-q"]);
    commit_fixture(&repo, "A");
    let store = Store::open(t.path().join("state"), t.path().into(), None).unwrap();
    let a = store
        .add_git_marketplace(repo.to_str().unwrap(), None, 0)
        .unwrap()
        .data
        .remove(0);
    store
        .install(&a.id, "user", 1, &a.source, &a.source_digest)
        .unwrap();
    let original_root = store.list().unwrap().marketplaces[0].root.clone();
    write(&repo, ".agents/plugins/marketplace.json", "invalid");
    commit_fixture(&repo, "invalid update");
    assert!(store.update_marketplaces(2).is_err());
    assert_eq!(store.list().unwrap().revision, 2);
    assert_eq!(store.list().unwrap().marketplaces[0].root, original_root);
    assert_eq!(
        store.enabled_components().unwrap()[0].digest,
        a.source_digest
    );
    write(&repo, ".agents/plugins/marketplace.json", catalog);
    write(&repo, "pkg/new.txt", "B");
    commit_fixture(&repo, "B");
    let b = store.update_marketplaces(2).unwrap();
    assert_eq!(b.revision, 3);
    assert_eq!(b.marketplaces.len(), 1);
    assert_ne!(b.marketplaces[0].root, original_root);
    assert_eq!(
        b.data[0].installed_digest.as_deref(),
        Some(a.source_digest.as_str())
    );
    assert!(
        store
            .remove_marketplace(&b.marketplaces[0].root, 2)
            .is_err()
    );
    let removed = store
        .remove_marketplace(&b.marketplaces[0].root, 3)
        .unwrap();
    assert!(removed.marketplaces.is_empty());
    assert!(removed.data[0].installed && removed.data[0].enabled);
    assert_eq!(
        store.enabled_components().unwrap()[0].digest,
        a.source_digest
    );
    assert!(store.remove_marketplace(t.path(), 4).is_err());
}
#[test]
fn distinct_git_sources_cannot_replace_an_existing_marketplace_name() {
    let t = tempfile::tempdir().unwrap();
    let store = Store::open(t.path().join("state"), t.path().into(), None).unwrap();
    for (index, name) in ["one", "two"].iter().enumerate() {
        let repo = t.path().join(name);
        fs::create_dir(&repo).unwrap();
        write(
            &repo,
            ".agents/plugins/marketplace.json",
            r#"{"name":"fixture","plugins":[]}"#,
        );
        git(&repo, &["init", "-q"]);
        commit_fixture(&repo, name);
        let result = store.add_git_marketplace(repo.to_str().unwrap(), None, index as u64);
        if index == 0 {
            assert!(result.is_ok());
        } else {
            assert!(result.is_err());
        }
    }
    let list = store.list().unwrap();
    assert_eq!(list.revision, 1);
    assert_eq!(list.marketplaces.len(), 1);
    assert!(list.errors.is_empty());
}
#[test]
fn public_metadata_is_typed_whitelisted_and_bound_to_selected_overlay() {
    let t = tempfile::tempdir().unwrap();
    write(t.path(), ".agents/plugins/marketplace.json", &json!({"name":"fixture","plugins":[{"name":"sample","source":{"source":"local","path":"./pkg","headers":{"token":"source-secret"}},"policy":{"installation":"INSTALLED_BY_DEFAULT","authentication":"ON_USE","token":"policy-secret"}}]}).to_string());
    write(t.path(), "pkg/plugin.json", &json!({"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"sample","extensions":{"com.openai":{"interface":{"displayName":"Selected","shortDescription":"Short","websiteURL":"https://example.test","logo":"./icon.svg","defaultPrompt":["  one   prompt  ","x".repeat(129),"two","three","four"],"headers":{"token":"interface-secret"}}}}}).to_string());
    write(
        t.path(),
        "pkg/.codex-plugin/plugin.json",
        r#"{"name":"ignored","interface":{"displayName":"legacy-secret","longDescription":"legacy-secret"}}"#,
    );
    write(t.path(), "pkg/icon.svg", "<svg/>");
    write(
        t.path(),
        "pkg/.app.json",
        r#"{"apps":[{"id":"connector_one"},{"id":"connector_two"}]}"#,
    );
    let store = Store::open(t.path().join("state"), t.path().into(), None).unwrap();
    let d = store.read("sample@fixture").unwrap();
    let value = serde_json::to_value(&d).unwrap();
    assert_eq!(
        value["catalogSource"],
        json!({"type":"local","path":t.path().canonicalize().unwrap().join("pkg")})
    );
    assert_eq!(
        value["policy"],
        json!({"installation":"INSTALLED_BY_DEFAULT","authentication":"ON_USE"})
    );
    assert_eq!(value["interface"]["displayName"], "Selected");
    assert_eq!(value["interface"]["websiteUrl"], "https://example.test");
    assert_eq!(
        value["interface"]["defaultPrompt"],
        json!(["one prompt", "two", "three"])
    );
    assert!(
        value["interface"]["logo"]
            .as_str()
            .unwrap()
            .ends_with(&format!("cache/{}/icon.svg", d.source_digest))
    );
    assert!(!value.to_string().contains("secret"));
    store
        .install(&d.id, "user", 0, &d.source, d.review_digest())
        .unwrap();
    assert_eq!(
        store.enabled_components().unwrap()[0].app_documents[0].value["apps"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}
#[test]
fn remote_preview_has_normalized_source_and_safe_catalog_interface_without_fetch() {
    let t = tempfile::tempdir().unwrap();
    write(t.path(), ".agents/plugins/marketplace.json", &json!({"name":"fixture","plugins":[{"name":"git","source":{"source":"git-subdir","url":"openai/plugins","path":"./sample","ref":"main","sha":"0123456789012345678901234567890123456789","token":"source-secret"},"interface":{"displayName":"Git preview","env":{"SECRET":"interface-secret"}}},{"name":"npm","source":{"source":"npm","package":"@fixture/sample","version":"^1.0.0","registry":"https://registry.example.test","token":"source-secret"}}]}).to_string());
    let store = Store::open(t.path().join("state"), t.path().into(), None).unwrap();
    let git = serde_json::to_value(store.read("git@fixture").unwrap()).unwrap();
    assert_eq!(
        git["catalogSource"],
        json!({"type":"git","url":"https://github.com/openai/plugins.git","path":"sample","refName":"main","sha":"0123456789012345678901234567890123456789"})
    );
    assert_eq!(git["interface"]["displayName"], "Git preview");
    assert!(!git.to_string().contains("secret"));
    let npm = serde_json::to_value(store.read("npm@fixture").unwrap()).unwrap();
    assert_eq!(
        npm["catalogSource"],
        json!({"type":"npm","package":"@fixture/sample","version":"^1.0.0","registry":"https://registry.example.test"})
    );
    assert_eq!(
        npm["policy"],
        json!({"installation":"AVAILABLE","authentication":"ON_INSTALL"})
    );
}

// Failure boundaries selected before implementation: sparse checkout must not
// materialize unselected directories; update keeps the exact selection and pin;
// unsafe paths/missing catalog fail atomically without expanding to full checkout.
#[test]
fn sparse_marketplace_snapshots_and_updates_preserve_selection() {
    let t = tempfile::tempdir().unwrap();
    let repo = t.path().join("repo");
    fs::create_dir(&repo).unwrap();
    write(
        &repo,
        ".agents/plugins/marketplace.json",
        r#"{"name":"sparse","plugins":[{"name":"sample","source":"packages/selected"}]}"#,
    );
    write(&repo, "packages/selected/plugin.json", manifest());
    write(&repo, "packages/unselected/private.txt", "not selected");
    write(&repo, "unrelated/large.txt", "not selected");
    write(&repo, "README.md", "cone mode retains root files");
    git(&repo, &["init", "-q"]);
    git(&repo, &["config", "uploadpack.allowFilter", "true"]);
    let source = format!("file://{}", repo.display());
    commit_fixture(&repo, "A");
    let reference = git(&repo, &["branch", "--show-current"]);
    let store = Store::open(t.path().join("state"), t.path().into(), None).unwrap();
    let paths = vec![".agents/plugins".to_owned(), "packages/selected".to_owned()];
    let first = store
        .add_git_marketplace_sparse(&source, Some(&reference), &paths, 0)
        .unwrap();
    assert!(first.errors.is_empty(), "{:?}", first.errors);
    let root = &first.marketplaces[0].root;
    assert!(root.join("packages/selected/plugin.json").exists());
    assert!(root.join(".agents/plugins/marketplace.json").exists());
    assert!(root.join("README.md").exists());
    assert!(
        !root.join("packages/unselected").exists(),
        "unselected files were materialized"
    );
    assert!(!root.join("unrelated").exists());
    let installed = store
        .install(
            "sample@sparse",
            "user",
            1,
            &first.data[0].source,
            &first.data[0].source_digest,
        )
        .unwrap();
    write(&repo, "packages/selected/updated.txt", "B");
    write(&repo, "unrelated/later.txt", "excluded");
    commit_fixture(&repo, "B");
    let store = Store::open(t.path().join("state"), t.path().into(), None).unwrap();
    let updated = store.update_marketplaces(2).unwrap();
    assert!(
        updated.marketplaces[0]
            .root
            .join("packages/selected/updated.txt")
            .exists()
    );
    assert!(!updated.marketplaces[0].root.join("unrelated").exists());
    assert!(
        !updated.marketplaces[0]
            .root
            .join("packages/unselected")
            .exists()
    );
    assert_eq!(
        updated.marketplaces[0].resolved_commit.as_deref(),
        Some(git(&repo, &["rev-parse", "HEAD"]).as_str())
    );
    assert_eq!(updated.data[0].installed_digest, installed.installed_digest);
    for unsafe_path in [
        "../outside",
        "/absolute",
        "packages/../unrelated",
        "--no-cone",
        "packages/*",
        "packages\\selected",
        ".",
        "packages\nother",
    ] {
        assert!(
            store
                .add_git_marketplace_sparse(&source, None, &[unsafe_path.into()], 3)
                .is_err(),
            "accepted unsafe sparse path"
        );
        assert_eq!(store.list().unwrap().revision, 3);
    }
    assert!(
        store
            .add_git_marketplace_sparse(&source, None, &["packages/selected".into()], 3)
            .is_err(),
        "missing catalog must not trigger full checkout"
    );
    assert_eq!(store.list().unwrap().revision, 3);
    let full = store
        .add_git_marketplace(&source, Some(&reference), 3)
        .unwrap();
    assert!(
        full.marketplaces[0]
            .root
            .join("unrelated/later.txt")
            .exists()
    );
}
