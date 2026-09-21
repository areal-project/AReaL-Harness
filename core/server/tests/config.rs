use std::{
    fs,
    process::{Command, Output},
};

fn invoke(dir: &std::path::Path, args: &[&str], env: &[(&str, &str)]) -> Output {
    // Exercise the documented Python parent on macOS. On the supported host,
    // AMFI can kill a Rust-spawned fresh binary before main; a Python parent is
    // also used by scripts/launch.py. Linux continues to test direct execution.
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("/usr/bin/python3");
        command.args(["-c", "import subprocess,sys; r=subprocess.run(sys.argv[1:]); sys.exit(r.returncode if r.returncode >= 0 else 128-r.returncode)", env!("CARGO_BIN_EXE_areal-server")]);
        command
    };
    #[cfg(not(target_os = "macos"))]
    let mut command = Command::new(env!("CARGO_BIN_EXE_areal-server"));
    let output = command
        .current_dir(dir)
        .env_clear()
        .env("AREAL_HARNESS_HOME", dir.join("home"))
        .envs(env.iter().copied())
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.code().is_some(),
        "child terminated before returning an exit code: {:?}",
        output.status
    );
    output
}

#[test]
fn help_and_version_do_not_require_model_or_valid_telemetry() {
    let temp = tempfile::tempdir().unwrap();
    for args in [
        vec!["--help"],
        vec!["--version"],
        vec!["config", "--help"],
        vec!["config", "show", "--help"],
    ] {
        let out = invoke(
            temp.path(),
            &args,
            &[("OTEL_EXPORTER_OTLP_ENDPOINT", "invalid")],
        );
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    assert!(!temp.path().join("home").exists());
}

#[test]
fn diagnostics_use_file_and_env_and_cli_without_creating_state_or_leaking_secrets() {
    let temp = tempfile::tempdir().unwrap();
    let config = temp.path().join("file.toml");
    fs::write(&config, "schema_version=1\n[model]\nname='file'\nprovider='fixture'\n[model.providers.fixture]\nendpoint='http://127.0.0.1:9/v1/chat/completions?token=hidden'\napi_key_env='FIXTURE_KEY'\n").unwrap();
    let env = [
        ("FIXTURE_KEY", "private-key"),
        ("AREAL_HARNESS_MODEL", "environment"),
    ];
    let out = invoke(
        temp.path(),
        &[
            "config",
            "show",
            "--sources",
            "--config",
            "file.toml",
            "--model",
            "command",
            "--max-active-turns",
            "5",
            "--max-children-per-turn",
            "3",
            "--max-agent-depth",
            "1",
        ],
        &env,
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let text = String::from_utf8(out.stdout).unwrap();
    let json: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(json["model"]["name"], "command");
    assert_eq!(json["sources"]["model.name"]["kind"], "cli");
    assert_eq!(json["limits"]["max_active_turns"], 5);
    assert_eq!(json["limits"]["max_children_per_turn"], 3);
    assert_eq!(json["limits"]["max_agent_depth"], 1);
    assert_eq!(
        json["model"]["endpoint"],
        "http://127.0.0.1:9/v1/chat/completions"
    );
    assert!(!text.contains("private-key"));
    assert!(!text.contains("hidden"));
    assert!(!temp.path().join("home").exists());
    let out = invoke(
        temp.path(),
        &["--config", "file.toml", "config", "validate"],
        &env,
    );
    assert!(out.status.success());
    let out = invoke(
        temp.path(),
        &["config", "validate", "--config", "file.toml"],
        &[],
    );
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("FIXTURE_KEY"));
    assert!(!temp.path().join("home").exists());
}

#[test]
fn invalid_configuration_fails_before_runtime_or_storage_side_effects() {
    let temp = tempfile::tempdir().unwrap();
    let out = invoke(
        temp.path(),
        &[
            "--runtime",
            "missing-runtime",
            "--workspace",
            ".",
            "--model",
            "fixture",
            "--model-endpoint",
            "https://user:private@host/",
        ],
        &[],
    );
    assert!(!out.status.success());
    let text = String::from_utf8_lossy(&out.stderr);
    assert!(text.contains("model-endpoint"));
    assert!(!text.contains("private"));
    assert!(!text.contains("missing-runtime"));
    assert!(!temp.path().join("home").exists());
    // A TOML data directory inside the execution workspace must be checked by Core.
    fs::write(
        temp.path().join("config.toml"),
        "schema_version=1\n[server]\ndata_dir='data'\n",
    )
    .unwrap();
    let out = invoke(
        temp.path(),
        &[
            "--config",
            "config.toml",
            "--runtime-stdio",
            "--workspace",
            ".",
            "--model",
            "fixture",
            "--model-endpoint",
            "http://127.0.0.1:9/",
        ],
        &[],
    );
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("outside the execution workspace"));
    assert!(!temp.path().join("data").exists());
}

#[test]
fn old_environment_still_configures_default_provider() {
    let temp = tempfile::tempdir().unwrap();
    let out = invoke(
        temp.path(),
        &["config", "show"],
        &[
            ("AREAL_MODEL", "old"),
            ("AREAL_MODEL_ENDPOINT", "http://127.0.0.1:9/"),
            ("AREAL_API_KEY", "old-secret"),
        ],
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let text = String::from_utf8(out.stdout).unwrap();
    assert!(!text.contains("old-secret"));
    let value: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(value["model"]["name"], "old");
    assert_eq!(value["model"]["api_key_env"], "AREAL_API_KEY");
}

#[test]
fn extensions_are_validated_without_executing_commands_or_creating_state() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(
        temp.path().join("config.toml"),
        "schema_version=1\n[tools]\nextensions_file='tools.json'\n",
    )
    .unwrap();
    let args = [
        "--config",
        "config.toml",
        "--model",
        "fixture",
        "--model-endpoint",
        "http://127.0.0.1:9/",
        "config",
        "validate",
    ];
    let mut extensions = serde_json::json!({"policy":{"commandWaitMs":600000},"tools":[{"definition":{"name":"fixture","description":"Fixture","inputSchema":{"type":"object"}},"argv":["/bin/sh","-c","touch should-not-exist"],"timeoutMs":1000}]});
    extensions["mcpServers"] = serde_json::json!({
        "stdio": {"transport":{"type":"stdio","command":"/bin/sh","args":["-c","touch mcp-should-not-exist"]}},
        "remote": {"transport":{"type":"streamableHttp","url":"http://127.0.0.1:9/mcp","bearerTokenEnv":"UNSET_MCP_TOKEN"}}
    });
    fs::write(temp.path().join("tools.json"), extensions.to_string()).unwrap();
    let out = invoke(temp.path(), &args, &[]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(!temp.path().join("should-not-exist").exists());
    assert!(!temp.path().join("mcp-should-not-exist").exists());
    assert!(!temp.path().join("home").exists());
    for invalid in [
        serde_json::json!({"policy":{"commandWaitMs":-1}}),
        serde_json::json!({"unknown":true}),
        serde_json::json!({"mcpServers":{"bad":{"transport":{"type":"streamableHttp","url":"file:///mcp"}}}}),
        serde_json::json!({"tools":[{"definition":{"name":"fixture","description":"Fixture","inputSchema":{"type":"object","$ref":"https://example.com/schema"}},"argv":["/bin/true"],"timeoutMs":1000}]}),
    ] {
        fs::write(temp.path().join("tools.json"), invalid.to_string()).unwrap();
        assert!(!invoke(temp.path(), &args, &[]).status.success());
    }
    fs::remove_file(temp.path().join("tools.json")).unwrap();
    fs::create_dir(temp.path().join("tools.json")).unwrap();
    assert!(!invoke(temp.path(), &args, &[]).status.success());
    assert!(!temp.path().join("home").exists());
}
