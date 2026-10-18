use serde_json::{Value, json};
use std::{fs, os::unix::fs::PermissionsExt, path::Path, process::Command};

fn run(root: &Path, request: &Value) -> Value {
    // 隔离测试子进程环境，避免修改并行测试共用的宿主环境。
    let output = Command::new(env!("CARGO_BIN_EXE_areal-runtime-fs"))
        .args(["--search", &request.to_string()])
        .env("PATH", root.join("host-tools"))
        .env("RIPGREP_CONFIG_PATH", root.join("rg-config"))
        .output()
        .unwrap();
    assert!(output.status.success(), "{:?}", output);
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn embedded_search_needs_no_host_tools_and_preserves_selection_and_globs() {
    let temp = tempfile::tempdir().unwrap();
    let outer = temp.path();
    let repo = outer.join("repo with spaces");
    fs::create_dir_all(repo.join("selected[1]")).unwrap();
    fs::create_dir_all(outer.join("host-tools")).unwrap();
    fs::create_dir(repo.join(".git")).unwrap();
    fs::write(outer.join("host-tools/rg"), "#!/bin/sh\nexit 99\n").unwrap();
    fs::set_permissions(
        outer.join("host-tools/rg"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    fs::write(outer.join("rg-config"), "--glob=!*.py\n").unwrap();
    fs::write(outer.join(".ignore"), "keep.py\n").unwrap();
    fs::write(repo.join(".gitignore"), "ignored.py\n").unwrap();
    fs::write(repo.join("selected[1]/keep.py"), "needle 中文\n").unwrap();
    fs::write(repo.join("selected[1]/ignored.py"), "needle ignored\n").unwrap();
    fs::write(repo.join("outside.py"), "needle outside\n").unwrap();
    let mut request = json!({"path":"workspace://repo/selected[1]", "roots":{"repo":repo}, "pattern":"needle", "context":0});
    let result = run(outer, &request);
    assert_eq!(result["result"]["limited"], false);
    assert_eq!(result["result"]["matches"].as_array().unwrap().len(), 1);
    assert_eq!(result["result"]["matches"][0]["text"], "needle 中文\n");
    request["glob"] = json!("!*.py");
    assert_eq!(run(outer, &request)["result"]["matches"], json!([]));
    request["glob"] = json!("*.py");
    assert_eq!(
        run(outer, &request)["result"]["matches"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    request["pattern"] = json!("[");
    assert!(
        run(outer, &request)["error"]
            .as_str()
            .unwrap()
            .contains("search failed")
    );
}
