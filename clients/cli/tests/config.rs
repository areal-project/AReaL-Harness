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
        command.args(["-c", "import subprocess,sys; r=subprocess.run(sys.argv[1:]); sys.exit(r.returncode if r.returncode >= 0 else 128-r.returncode)", env!("CARGO_BIN_EXE_areal")]);
        command
    };
    #[cfg(not(target_os = "macos"))]
    let mut command = Command::new(env!("CARGO_BIN_EXE_areal"));
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
        vec!["version"],
        vec!["upgrade", "--help"],
        vec!["config", "--help"],
        vec!["config", "show", "--help"],
        vec!["trajectory", "--help"],
        vec!["trajectory", "status", "--help"],
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
        if args == ["version"] {
            assert_eq!(
                String::from_utf8_lossy(&out.stdout).trim(),
                format!("areal {}", env!("CARGO_PKG_VERSION"))
            );
        }
    }
    assert!(!temp.path().join("home").exists());
}

#[test]
fn trajectory_management_is_model_independent_and_does_not_start_disabled_export() {
    let temp = tempfile::tempdir().unwrap();
    for action in ["status", "retry", "sync-config"] {
        let out = invoke(
            temp.path(),
            &["trajectory", action],
            &[("OTEL_EXPORTER_OTLP_ENDPOINT", "invalid")],
        );
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(out.stderr.is_empty());
        let value: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(value["enabled"], false);
        assert_eq!(value["state"], "disabled");
        assert_eq!(value["worker_running"], false);
        assert_eq!(value["queue"]["pending"], 0);
        assert_eq!(
            value["configPath"],
            temp.path().join("home/config.toml").to_str().unwrap()
        );
    }
    assert!(!temp.path().join("home").exists());
}

#[test]
fn trajectory_status_reports_invalid_destination_without_echoing_credentials() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("config.toml"), "schema_version=2\n[trajectory]\nenabled=true\nendpoint='https://user:private-token@example.com?token=private-query'\n").unwrap();
    let out = invoke(
        temp.path(),
        &["trajectory", "status", "--config", "config.toml"],
        &[],
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let value: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(value["state"], "invalid");
    assert_eq!(value["last_error"], "invalid_endpoint");
    let text = String::from_utf8(out.stdout).unwrap();
    assert!(!text.contains("private-token"));
    assert!(!text.contains("private-query"));
    assert!(out.stderr.is_empty());
    assert!(!temp.path().join("home").exists());
}

#[test]
fn trajectory_suspend_reads_under_config_writer_lock_without_mutating_the_file() {
    use fs2::FileExt;
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("config.toml");
    let original =
        "schema_version=2\n[trajectory]\nenabled=true\nendpoint='invalid'\nspool_dir='queue'\n";
    fs::write(&path, original).unwrap();
    let sync = invoke(
        temp.path(),
        &["trajectory", "sync-config", "--config", "config.toml"],
        &[],
    );
    assert!(
        sync.status.success(),
        "{}",
        String::from_utf8_lossy(&sync.stderr)
    );
    let lock = fs::File::create(temp.path().join(".config.toml.lock")).unwrap();
    lock.lock_exclusive().unwrap();
    let suspended = invoke(
        temp.path(),
        &["trajectory", "suspend", "--config", "config.toml"],
        &[],
    );
    assert!(
        suspended.status.success(),
        "{}",
        String::from_utf8_lossy(&suspended.stderr)
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), original);
    let control: serde_json::Value =
        serde_json::from_slice(&fs::read(temp.path().join("queue/control.json")).unwrap()).unwrap();
    assert_eq!(control["enabled"], false);
    assert_eq!(control["endpoint"], "invalid");
    assert!(suspended.stderr.is_empty());
}

#[test]
fn short_exec_keeps_json_clean_and_remote_ignores_local_trajectory() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("config.toml"), "schema_version=2\n[trajectory]\nenabled=true\nendpoint='https://user:private-token@example.com?token=private-query'\n").unwrap();
    let notice = "轨迹导出需要处理";
    for args in [
        vec![
            "exec",
            "hello",
            "--output-format",
            "json",
            "--workspace",
            "missing",
            "--config",
            "config.toml",
        ],
        vec![
            "--prompt",
            "hello",
            "--workspace",
            "missing",
            "--config",
            "config.toml",
        ],
    ] {
        let out = invoke(temp.path(), &args, &[]);
        let stderr = String::from_utf8_lossy(&out.stderr);
        // 短请求可以先结束；不得为了等待通知延长请求。
        assert!(stderr.matches(notice).count() <= 1, "{stderr}");
        if args.first() == Some(&"exec") {
            let result: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
            assert_eq!(result["type"], "result");
            assert_eq!(result["is_error"], true);
        }
        assert!(!String::from_utf8_lossy(&out.stdout).contains(notice));
        assert!(!stderr.contains("private-token"));
        assert!(!stderr.contains("private-query"));
    }
    let remote = invoke(
        temp.path(),
        &[
            "exec",
            "hello",
            "--endpoint",
            "ws://127.0.0.1:1",
            "--auth-file",
            "missing-auth",
        ],
        &[("AREAL_HARNESS_CONFIG", "config.toml")],
    );
    assert!(!String::from_utf8_lossy(&remote.stderr).contains(notice));
}

#[test]
fn owned_exec_reaches_launcher_and_reports_its_startup_error() {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir(temp.path().join("workspace")).unwrap();
    let out = invoke(
        temp.path(),
        &[
            "exec",
            "hello",
            "--workspace",
            "workspace",
            "--scratch",
            "missing-scratch",
            "--output-format",
            "json",
        ],
        &[("HOME", temp.path().to_str().unwrap())],
    );
    assert!(!out.status.success());
    let stderr = String::from_utf8_lossy(&out.stderr);
    // 无需 Runtime 产物或模型：launcher 自身的确定性错误证明自派生链已经进入 main。
    assert!(stderr.contains("Local Harness:"), "{stderr}");
    assert!(stderr.contains(r#""state":"failed""#), "{stderr}");
    assert!(
        stderr.contains("Harness startup failed (exit status:"),
        "{stderr}"
    );
    let result: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(result["is_error"], true);
}

#[test]
fn source_build_does_not_self_upgrade() {
    let temp = tempfile::tempdir().unwrap();
    let out = invoke(temp.path(), &["upgrade", "--check"], &[]);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("installer-managed"));
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
        ("AREAL_HARNESS_WATCHDOG_DISABLE", "1"),
        ("AREAL_HARNESS_MAX_TOOL_BUFFER_BYTES", "8388608"),
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
    assert_eq!(json["limits"]["watchdog_disable"], true);
    assert_eq!(json["limits"]["max_tool_buffer_bytes"], 8388608);
    assert_eq!(
        json["sources"]["limits.max_tool_buffer_bytes"]["kind"],
        "env"
    );
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
        &["config", "--config", "file.toml", "validate"],
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
            "app-server",
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
            "app-server",
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
        "config",
        "--config",
        "config.toml",
        "--model",
        "fixture",
        "--model-endpoint",
        "http://127.0.0.1:9/",
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

#[test]
fn platform_identity_never_changes_native_budgets_or_experimental_defaults() {
    let temp = tempfile::tempdir().unwrap();
    for explicit in [false, true] {
        let settings = if explicit {
            "schema_version=2\n[model]\nmax_output_tokens=12345\ncontext_window_tokens=180000\n[context]\nobservation_tokens=4096\nreference_tokens=2048\n[limits]\ncontext_window_bytes=2000000\ncontext_recent_bytes=90000\ncontext_output_reserve_tokens=16000\nmax_empty_completion_retries=1\nmax_repeated_tool_failures=3\n"
        } else {
            "schema_version=2\n"
        };
        fs::write(temp.path().join("config.toml"), settings).unwrap();
        let mut baseline = None;
        for (env_key, task_id) in [
            ("ordinary", "ordinary-task"),
            ("graybox19-example", "ordinary-task"),
            ("ordinary", "example:graybox19-001"),
        ] {
            let out = invoke(
                temp.path(),
                &["config", "show", "--config", "config.toml"],
                &[
                    ("ARENA_ENV_KEY", env_key),
                    ("TASK_ID", task_id),
                    ("AREAL_HARNESS_MODEL", "fixture"),
                    (
                        "AREAL_HARNESS_MODEL_ENDPOINT",
                        "http://127.0.0.1:9/v1/chat/completions",
                    ),
                ],
            );
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            let actual: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
            let projection = serde_json::json!({"model":actual["model"], "limits":actual["limits"], "context":actual["context"]});
            if let Some(ref expected) = baseline {
                assert_eq!(&projection, expected);
            } else {
                baseline = Some(projection);
            }
            for (field, value) in [
                ("context_observation_tokens", 4096),
                ("context_reference_tokens", 2048),
                ("max_empty_completion_retries", 1),
                ("max_repeated_tool_failures", 3),
            ] {
                assert_eq!(actual["limits"][field], if explicit { value } else { 0 });
            }
            if explicit {
                assert_eq!(actual["model"]["max_output_tokens"], 12345);
                assert_eq!(actual["model"]["context_window_tokens"], 180000);
                assert_eq!(actual["limits"]["context_window_bytes"], 2000000);
                assert_eq!(actual["limits"]["context_recent_bytes"], 90000);
                assert_eq!(actual["limits"]["context_output_reserve_tokens"], 16000);
            }
        }
    }
    assert!(!temp.path().join("home").exists());
}
