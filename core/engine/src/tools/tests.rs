use super::*;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::time::Instant;

#[test]
fn repeated_failure_count_respects_arguments_outcomes_and_current_item() {
    let call = ToolCall {
        id: "current-call".into(),
        name: "click".into(),
        arguments: r#"{"target":{"text":"A"},"page":1}"#.into(),
    };
    let item = |id: &str,
                tool: &str,
                args: Value,
                outcome: &str,
                status: &str,
                success: Option<bool>|
     -> Item {
        serde_json::from_value(
            json!({"type":"dynamicToolCall","id":id,"tool":tool,"arguments":args,
            "status":status,"success":success,"contentItems":null,"callId":id,
            "execution":{"runtimeEpoch":"e","scopeId":"s","operationId":id,"outcome":outcome}}),
        )
        .unwrap()
    };
    let args = json!({"page":1,"target":{"text":"A"}});
    let failed = item("f", "click", args.clone(), "failed", "failed", Some(false));
    let inspection = item(
        "inspect",
        "read_file",
        json!({"path":"protocol"}),
        "succeeded",
        "completed",
        Some(true),
    );
    assert_eq!(
        consecutive_matching_failures(&[failed.clone(), inspection, failed.clone()], &call),
        2
    );
    let repair = item(
        "repair",
        "fs_write",
        json!({"path":"script"}),
        "succeeded",
        "completed",
        Some(true),
    );
    assert_eq!(
        consecutive_matching_failures(&[failed.clone(), repair], &call),
        0
    );
    let current = item(
        "current",
        "click",
        args.clone(),
        "running",
        "inProgress",
        None,
    );
    let observed = item(
        "read",
        "snapshot",
        json!({}),
        "succeeded",
        "completed",
        Some(true),
    );
    assert_eq!(
        previous_matching_failures(
            &[failed.clone(), observed, failed.clone(), current.clone()],
            &call,
            "current"
        ),
        2
    );
    assert_eq!(previous_matching_failures(&[], &call, "current"), 0);
    let changed = item(
        "other",
        "click",
        json!({"page":2,"target":{"text":"A"}}),
        "failed",
        "failed",
        Some(false),
    );
    assert_eq!(
        consecutive_matching_failures(&[failed.clone(), changed.clone()], &call),
        0
    );
    assert_eq!(previous_matching_failures(&[changed], &call, "current"), 0);
    for (outcome, status, success) in [
        ("succeeded", "completed", Some(true)),
        ("unknown", "failed", Some(false)),
        ("cancelled", "failed", Some(false)),
        ("running", "inProgress", None),
    ] {
        let boundary = item("boundary", "click", args.clone(), outcome, status, success);
        assert_eq!(
            consecutive_matching_failures(&[failed.clone(), boundary.clone()], &call),
            0
        );
        assert_eq!(
            previous_matching_failures(
                &[failed.clone(), boundary.clone(), current.clone()],
                &call,
                "current"
            ),
            0,
            "{outcome}"
        );
        assert_eq!(
            previous_matching_failures(
                &[failed.clone(), boundary, failed.clone(), current.clone()],
                &call,
                "current"
            ),
            1,
            "{outcome}"
        );
    }
}

#[test]
fn read_file_on_binary_content_explains_supported_alternatives() {
    let workspace = tempfile::tempdir().unwrap();
    std::fs::write(workspace.path().join("binary.dat"), [0xff, 0x00]).unwrap();
    let request = json!({
        "operation": "read_file",
        "path": "workspace://repo/binary.dat",
        "roots": {"repo": workspace.path()}
    });
    let output = std::process::Command::new(navigation::python_executable().unwrap())
        .args([
            "-I",
            "-B",
            "-c",
            include_str!("navigation.py"),
            &request.to_string(),
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    let response: Value = serde_json::from_slice(&output.stdout).unwrap();
    let error = response["error"].as_str().unwrap();
    assert!(error.contains("UTF-8 text only"));
    assert!(error.contains("fs_read"));
    assert!(error.contains("image_read"));
    assert!(!error.contains("codec can't decode"));
}

#[test]
fn removed_single_patch_tool_is_not_registered_or_dispatched() {
    let registry = Registry::new(true, &ToolExtensions::default()).unwrap();
    assert!(registry.get("fs_apply_patch").is_err());
    assert!(registry.get("fs_apply_patches").is_ok());
    assert!(
        registry
            .definitions()
            .iter()
            .all(|tool| tool["function"]["name"] != "fs_apply_patch")
    );
    let legacy = ToolCall {
        id: "legacy".into(),
        name: "fs_apply_patch".into(),
        arguments: json!({"path":"code.py","oldText":"old","newText":"new","expectedSha256":"a".repeat(64)}).to_string(),
    };
    assert!(
        request(&legacy, Path::new("/app"), "epoch", &BTreeMap::new())
            .err()
            .unwrap()
            .to_string()
            .contains("unknown tool")
    );
}

#[test]
fn every_builtin_enforces_required_fields_and_rejects_unknown_arguments() {
    let process = format!("epoch:process:{}", uuid::Uuid::new_v4());
    let examples = json!({
        "task_state":{},
        "fs_read":{"path":"a"},
        "read_file":{"path":"a"},
        "search_files":{"path":".","pattern":"needle"},
        "image_read":{"path":"a.png"},
        "verify_command":{"argv":["/bin/true"]},
        "fs_list":{"path":".","after":null,"limit":10},
        "fs_stat":{"path":"a"},
        "fs_create":{"path":"a","text":"hello"},
        "fs_write":{"path":"a","text":"hello","expectedSha256":null},
        "fs_apply_patches":{"path":"a","patches":[{"oldText":"hello","newText":"world"}],"expectedSha256":"a".repeat(64)},
        "run_command":{"argv":["/bin/true"],"cwd":".","timeoutMs":1000},
        "read_process":{"processId":process},
        "write_process":{"processId":process,"text":"hello"},
        "terminate_process":{"processId":process}
    });
    let registry = Registry::new(true, &ToolExtensions::default()).unwrap();
    let definitions: Vec<_> = registry
        .definitions()
        .into_iter()
        .filter(|d| {
            examples
                .get(d["function"]["name"].as_str().unwrap())
                .is_some()
        })
        .collect();
    assert_eq!(definitions.len(), examples.as_object().unwrap().len());
    for definition in definitions {
        let name = definition["function"]["name"].as_str().unwrap();
        let schema = &definition["function"]["parameters"];
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["additionalProperties"], false);
        let parse = |args: Value| {
            registry.get(name)?.validate_input(&args)?;
            if matches!(
                name,
                "image_read" | "read_file" | "search_files" | "task_state"
            ) {
                return Ok(());
            }
            request(
                &ToolCall {
                    id: "test".into(),
                    name: name.into(),
                    arguments: args.to_string(),
                },
                Path::new("/app"),
                "epoch",
                &BTreeMap::new(),
            )
            .map(|_| ())
        };
        assert!(parse(examples[name].clone()).is_ok(), "{name}");
        for required in schema["required"].as_array().unwrap() {
            let mut args = examples[name].clone();
            args.as_object_mut()
                .unwrap()
                .remove(required.as_str().unwrap());
            assert!(parse(args).is_err(), "{name} accepted missing {required}");
        }
        let mut args = examples[name].clone();
        args["unexpected"] = json!(true);
        assert!(parse(args).is_err(), "{name} accepted an unknown field");
    }
}

#[test]
fn model_output_budget_accounts_for_json_escaping() {
    assert!(model_output_fits(&[], &[], &vec![b'x'; 7000], &[]));
    assert!(model_output_fits(&[], &[], &vec![0; 1000], &[]));
    assert!(!model_output_fits(&[], &[], &vec![0; 3000], &[]));
}

#[test]
fn bounded_journal_preserves_both_ends_with_exact_escaped_budget() {
    assert_eq!(bounded_result("small".into()), "small");
    for unit in ["plain", "\"\\\n\0", "中文😀"] {
        let raw = json!({"output": unit.repeat(MAX_RESULT)}).to_string();
        let bounded = bounded_result(raw.clone());
        assert!(bounded.len() <= MAX_RESULT);
        let view: Value = serde_json::from_str(&bounded).unwrap();
        let head = view["prefix"].as_str().unwrap();
        let tail = view["suffix"].as_str().unwrap();
        assert!(!head.is_empty() && !tail.is_empty());
        assert!(raw.starts_with(head) && raw.ends_with(tail));
        assert_eq!(view["truncatedBytes"], raw.len() - head.len() - tail.len());
    }
}

#[test]
fn invalid_values_are_rejected_without_coercion_or_clamping() {
    for (name, args) in [
        (
            "run_command",
            json!({"argv":["/bin/true"],"cwd":".","timeoutMs":1000,"yieldMs":null}),
        ),
        ("run_command", json!({"argv":[],"cwd":".","timeoutMs":1000})),
        ("fs_read", json!({"path":"a","maxBytes":0})),
        ("fs_read", json!({"path":"a","offset":-1})),
        ("fs_list", json!({"path":".","after":null,"limit":257})),
        ("fs_list", json!({"path":".","after":null,"limit":0})),
    ] {
        let call = ToolCall {
            id: "test".into(),
            name: name.into(),
            arguments: args.to_string(),
        };
        assert!(
            request(&call, Path::new("/app"), "epoch", &BTreeMap::new()).is_err(),
            "{name}: {args}"
        );
    }
}

#[test]
fn relative_and_absolute_paths_stay_inside_the_workspace() {
    let root = Path::new("/app");
    for path in [
        "src/main.py",
        "./src/main.py",
        "/app/src/main.py",
        "workspace://repo/src/main.py",
    ] {
        assert_eq!(
            workspace_uri(path, root).unwrap(),
            "workspace://repo/src/main.py"
        );
    }
    assert_eq!(workspace_uri(".", root).unwrap(), "workspace://repo");
    for path in [
        "../other",
        "src/../../other",
        "/app-other/file",
        "/etc/passwd",
    ] {
        assert!(workspace_uri(path, root).is_err());
    }
}

#[test]
fn omitted_cursor_resumes_but_null_replays_and_explicit_cursor_is_validated() {
    let process = format!("epoch:process:{}", uuid::Uuid::new_v4());
    let cursor = format!("{process}/42");
    let cursors = BTreeMap::from([(process.clone(), cursor.clone())]);
    for (after, expected) in [
        (None, Some(cursor.clone())),
        (Some(Value::Null), None),
        (
            Some(json!(format!("{process}/3"))),
            Some(format!("{process}/3")),
        ),
    ] {
        let mut args = json!({"processId":process});
        if let Some(after) = after {
            args["after"] = after;
        }
        let call = ToolCall {
            id: "read".into(),
            name: "read_process".into(),
            arguments: args.to_string(),
        };
        let Request::ReadProcess(read) =
            request(&call, Path::new("/app"), "epoch", &cursors).unwrap()
        else {
            panic!("expected read")
        };
        assert_eq!(read.after, expected);
        assert_eq!(read.wait_ms, 120_000);
    }
    for extra in [json!({"after":"42"}), json!({"waitMs":-1})] {
        let mut args = json!({"processId":process});
        args.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let call = ToolCall {
            id: "read".into(),
            name: "read_process".into(),
            arguments: args.to_string(),
        };
        assert!(request(&call, Path::new("/app"), "epoch", &cursors).is_err());
    }
}

// A pipe-level Runtime fixture with virtual time: its output endpoint wakes on
// output, exit or the requested timeout, just like the Supervisor's long poll.
async fn process_fixture(
    finish_ms: u64,
    output_ms: Option<u64>,
    stop_reason: Option<&'static str>,
    loss: bool,
) -> Arc<Client> {
    process_fixture_output(finish_ms, output_ms, stop_reason, loss, "ready".into()).await
}

async fn process_fixture_output(
    finish_ms: u64,
    output_ms: Option<u64>,
    stop_reason: Option<&'static str>,
    loss: bool,
    output: String,
) -> Arc<Client> {
    let (pipe, peer) = tokio::io::duplex(64 * 1024);
    let (read, write) = tokio::io::split(pipe);
    let (peer_read, mut peer_write) = tokio::io::split(peer);
    tokio::spawn(async move {
        let mut lines = BufReader::new(peer_read).lines();
        let mut started = Instant::now();
        while let Some(line) = lines.next_line().await.unwrap() {
            let req: Value = serde_json::from_str(&line).unwrap();
            let method = req["method"].as_str().unwrap();
            let result = match method {
                "connection.open" => {
                    json!({"protocolVersion":rt::VERSION,"runtimeEpoch":"epoch","connectionId":"fixture","rootScopeId":"scope","capabilities":{"methods":["fs.execute"]}})
                }
                "scope.create" | "scope.get" | "scope.revoke" | "scope.waitClosed" => {
                    json!({"scopeId":"scope","parentScopeId":null,"state":if method=="scope.waitClosed"{"closed"}else{"active"},"owner":{"taskId":"fixture"},"readRoots":["workspace://repo"],"writeRoots":["workspace://repo"],"network":"deny","limits":{"wallTimeMs":10000,"outputBytes":8388608,"maxProcesses":4},"activeProcesses":0,"outputBytes":0,"cleanupError":null})
                }
                "process.write" => json!({"accepted":true}),
                "process.start" => {
                    started = Instant::now();
                    json!({"processId":"process","scopeId":"scope"})
                }
                "process.get" | "process.wait" => {
                    let exited = started.elapsed().as_millis() >= finish_ms.into();
                    json!({"processId":"process","scopeId":"scope","state":if exited {"exited"} else {"running"},"exitCode":if exited {Some(if stop_reason.is_some() {1} else {0})} else {None},"signal":null,"sandboxDenied":false,"stopReason":if exited {stop_reason} else {None},"cleanupError":null})
                }
                "output.read" => {
                    let params = &req["params"];
                    let wait = params["waitMs"].as_u64().unwrap();
                    assert!(wait <= 1000, "Core must respect Runtime's long-poll limit");
                    let offset = params["after"]
                        .as_str()
                        .and_then(|s| s.rsplit('/').next())
                        .and_then(|s| s.parse::<usize>().ok())
                        .unwrap_or(0);
                    let consumed = offset >= output.len();
                    let elapsed = started.elapsed().as_millis() as u64;
                    let event_ms = output_ms
                        .filter(|_| !consumed)
                        .unwrap_or(finish_ms)
                        .min(finish_ms);
                    if !loss {
                        tokio::time::sleep(Duration::from_millis(
                            wait.min(event_ms.saturating_sub(elapsed)),
                        ))
                        .await;
                    }
                    let elapsed = started.elapsed().as_millis() as u64;
                    let ready = output_ms.is_some_and(|at| elapsed >= at);
                    let end = if ready {
                        (offset + params["maxBytes"].as_u64().unwrap() as usize).min(output.len())
                    } else {
                        offset
                    };
                    let chunks = if ready && !consumed {
                        vec![
                            json!({"cursor":format!("process/{end}"),"stream":"stdout","dataBase64":STANDARD.encode(&output.as_bytes()[offset..end])}),
                        ]
                    } else {
                        vec![]
                    };
                    json!({"chunks":chunks,"nextCursor":format!("process/{end}"),"closed":elapsed >= finish_ms && (output_ms.is_none() || end == output.len()),"gap":loss,"truncated":loss})
                }
                "connection.close" => json!({"closed":true}),
                _ => panic!("unexpected {method}"),
            };
            peer_write
                .write_all(format!("{}\n", json!({"id":req["id"],"result":result})).as_bytes())
                .await
                .unwrap();
            if method == "connection.close" {
                break;
            }
        }
    });
    Client::connect(read, write).await.unwrap()
}

async fn command(client: &Client, yield_ms: Option<u64>, tty: bool) -> (bool, Value) {
    command_with_policy(client, yield_ms, tty, &ToolPolicy::default()).await
}

async fn command_with_policy(
    client: &Client,
    yield_ms: Option<u64>,
    tty: bool,
    policy: &ToolPolicy,
) -> (bool, Value) {
    execute(
        client,
        Request::Command(Command {
            environment: BTreeMap::new(),
            argv: vec!["fixture".into()],
            cwd: "workspace://repo".into(),
            timeout_ms: 300_000,
            yield_ms,
            tty,
            stdin_open: false,
        }),
        "scope",
        "operation",
        policy,
        None,
    )
    .await
    .unwrap()
}

#[tokio::test(start_paused = true)]
async fn silent_command_waits_past_old_poll_limit_in_one_tool_call() {
    let client = process_fixture(65_000, None, None, false).await;
    let started = Instant::now();
    let (success, result) = command(&client, None, false).await;
    assert!(success);
    assert_eq!(result["state"], "exited");
    assert_eq!(result["exitCode"], 0);
    assert_eq!(result["outputClosed"], true);
    assert_eq!(result["commandStatus"], "succeeded");
    assert_eq!(result["outputReadComplete"], true);
    assert_eq!(result["outputIntegrity"], "retained");
    assert_eq!(started.elapsed(), Duration::from_secs(65));
    client.shutdown().await.unwrap();

    // The former 1 s submission / 30 s read policy needs four tool calls for
    // the same silent command. No model or wall-clock sleep is needed here.
    let client = process_fixture(65_000, None, None, false).await;
    let (_, mut result) = command(&client, Some(1000), false).await;
    let mut calls = 1;
    while result["state"] == "running" {
        (_, result) = process_output(
            &client,
            "scope",
            ReadProcess {
                view: OutputView::Auto,
                process_id: "process".into(),
                after: Some(result["nextCursor"].as_str().unwrap().into()),
                wait_ms: 30_000,
            },
            100,
            None,
            8192,
        )
        .await
        .unwrap();
        calls += 1;
    }
    assert_eq!(calls, 4);
    assert_eq!(result["exitCode"], 0);
    client.shutdown().await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn waiting_is_bounded_and_explicit_async_and_pty_defaults_are_preserved() {
    for (yield_ms, tty, expected) in [
        (Some(0), false, 0),
        (None, true, 1000),
        (Some(500), false, 500),
        (None, false, 120_000),
    ] {
        let client = process_fixture(180_000, None, None, false).await;
        let started = Instant::now();
        let (_, result) = command(&client, yield_ms, tty).await;
        assert_eq!(result["state"], "running");
        assert_eq!(result["commandStatus"], "running");
        assert_eq!(result["outputReadComplete"], false);
        assert_eq!(started.elapsed(), Duration::from_millis(expected));
        client.shutdown().await.unwrap();
    }
}

#[tokio::test(start_paused = true)]
async fn explicit_quiet_policy_preserves_legacy_return_and_cursor() {
    let client = process_fixture(65_000, Some(2000), None, false).await;
    let started = Instant::now();
    let (_, result) = command_with_policy(
        &client,
        None,
        false,
        &ToolPolicy {
            output_quiet_ms: 100,
            ..ToolPolicy::default()
        },
    )
    .await;
    assert_eq!(result["state"], "running");
    assert_eq!(result["stdout"], "ready");
    assert_eq!(result["returnReason"], "outputQuiet");
    assert_eq!(started.elapsed(), Duration::from_millis(2100));
    let (_, result) = process_output(
        &client,
        "scope",
        ReadProcess {
            view: OutputView::Auto,
            process_id: "process".into(),
            after: Some(result["nextCursor"].as_str().unwrap().into()),
            wait_ms: 120_000,
        },
        100,
        None,
        8192,
    )
    .await
    .unwrap();
    assert_eq!(result["stdout"], "");
    assert_eq!(result["state"], "exited");
    assert_eq!(started.elapsed(), Duration::from_secs(65));
    client.shutdown().await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn timeout_and_output_loss_are_returned_without_waiting_again() {
    let client = process_fixture(2000, None, Some("wallTime"), false).await;
    let (success, result) = command(&client, None, false).await;
    assert!(!success);
    assert_eq!(result["stopReason"], "wallTime");
    assert_eq!(result["commandStatus"], "terminated");
    client.shutdown().await.unwrap();
    let client = process_fixture(180_000, None, None, true).await;
    let started = Instant::now();
    let (_, result) = command(&client, None, false).await;
    assert_eq!(result["gap"], true);
    assert_eq!(result["truncated"], true);
    assert_eq!(result["outputIntegrity"], "incomplete");
    assert_eq!(started.elapsed(), Duration::ZERO);
    let error = process_output(
        &client,
        "another-turn",
        ReadProcess {
            view: OutputView::Auto,
            process_id: "process".into(),
            after: None,
            wait_ms: 0,
        },
        100,
        None,
        8192,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, rt::ErrorCode::PermissionDenied);
    client.shutdown().await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn caller_can_wait_beyond_two_minutes_without_overflow() {
    for wait_ms in [300_000, u64::MAX] {
        let client = process_fixture(180_000, None, None, false).await;
        let started = Instant::now();
        let (success, result) = command(&client, Some(wait_ms), false).await;
        assert!(success);
        assert_eq!(result["state"], "exited");
        assert_eq!(started.elapsed(), Duration::from_secs(180));
        client.shutdown().await.unwrap();
    }
}

#[test]
fn configured_defaults_and_call_overrides_share_the_published_schema() {
    let policy = ToolPolicy {
        command_wait_ms: 600_000,
        read_wait_ms: 900_000,
        ..ToolPolicy::default()
    };
    let registry = Registry::new(
        true,
        &ToolExtensions {
            policy: policy.clone(),
            ..Default::default()
        },
    )
    .unwrap();
    let process = format!("epoch:process:{}", uuid::Uuid::new_v4());
    for explicit in [None, Some(0), Some(300_000), Some(u64::MAX)] {
        let mut args = json!({"processId":process});
        if let Some(wait) = explicit {
            args["waitMs"] = json!(wait);
        }
        registry
            .get("read_process")
            .unwrap()
            .validate_input(&args)
            .unwrap();
        let call = ToolCall {
            id: "read".into(),
            name: "read_process".into(),
            arguments: args.to_string(),
        };
        let Request::ReadProcess(read) =
            request_with_policy(&call, Path::new("/app"), "epoch", &BTreeMap::new(), &policy)
                .unwrap()
        else {
            panic!()
        };
        assert_eq!(read.wait_ms, explicit.unwrap_or(900_000));
    }
    assert!(
        registry
            .definitions()
            .iter()
            .find(|v| v["function"]["name"] == "run_command")
            .unwrap()["function"]["description"]
            .as_str()
            .unwrap()
            .contains("600000")
    );
}

#[tokio::test(start_paused = true)]
async fn verification_waits_for_exit_after_an_early_output_burst() {
    for stop in [None, Some("wallTime")] {
        let client = process_fixture(5000, Some(10), stop, false).await;
        let started = Instant::now();
        let (passed, result) = verify_command(&client, vec!["fixture".into()])
            .await
            .unwrap();
        assert_eq!(passed, stop.is_none());
        assert_eq!(result["state"], "exited");
        assert_eq!(result["output"], "ready");
        assert_eq!(started.elapsed(), Duration::from_secs(5));
        client.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn aliases_reject_cross_process_cursor_and_cross_file_version() {
    let client = process_fixture(0, None, None, false).await;
    let runtime = RuntimeConfig {
        client: client.clone(),
        workspace: PathBuf::from("/app"),
        writable: true,
        command_scope: None,
        command_scratch: Some(PathBuf::from("/task-scratch")),
    };
    let mut handles = Handles::default();
    let mut result = json!({"processId":"epoch:process:real","nextCursor":"epoch:process:real/4"});
    handles.expose("run_command", &json!({}), &mut result, &runtime);
    let mut args = json!({"processId":result["processId"],"after":result["nextCursor"]});
    handles
        .resolve("read_process", &mut args, &runtime)
        .unwrap();
    assert_eq!(args["processId"], "epoch:process:real");
    let mut wrong = json!({"processId":"other","after":result["nextCursor"]});
    assert!(
        handles
            .resolve("read_process", &mut wrong, &runtime)
            .is_err()
    );
    let mut file = json!({"sha256":"a".repeat(64)});
    handles.expose("fs_read", &json!({"path":"code.py"}), &mut file, &runtime);
    let mut edit = json!({"path":"code.py","text":"new","fileVersion":file["fileVersion"]});
    handles.resolve("fs_write", &mut edit, &runtime).unwrap();
    assert_eq!(edit["expectedSha256"], "a".repeat(64));
    let mut wrong = json!({"path":"other.py","text":"new","fileVersion":file["fileVersion"]});
    assert!(handles.resolve("fs_write", &mut wrong, &runtime).is_err());
    let mut patched = json!({"sha256":"b".repeat(64)});
    handles.expose(
        "fs_apply_patches",
        &json!({"path":"code.py"}),
        &mut patched,
        &runtime,
    );
    assert_ne!(file["fileVersion"], patched["fileVersion"]);
    assert_eq!(patched["path"], "workspace://repo/code.py");
    let mut next_edit =
        json!({"path":"code.py","text":"next","fileVersion":patched["fileVersion"]});
    handles
        .resolve("fs_write", &mut next_edit, &runtime)
        .unwrap();
    assert_eq!(next_edit["expectedSha256"], "b".repeat(64));
    assert!(
        Handles::default()
            .resolve("read_process", &mut result, &runtime)
            .is_err()
    );
    let call = ToolCall {
        id: "cap".into(),
        name: "fs_read".into(),
        arguments: json!({"path":"code.py","maxBytes":1000000}).to_string(),
    };
    assert!(matches!(
        request(&call, Path::new("/app"), "epoch", &BTreeMap::new()).unwrap(),
        Request::File(rt::FileCommand::Read {
            max_bytes: 8192,
            ..
        })
    ));
    client.shutdown().await.unwrap();
}

#[test]
fn shell_command_preserves_pipefail_and_does_not_guess_argv() {
    let registry = Registry::new(true, &ToolExtensions::default()).unwrap();
    let parse = |args: Value| {
        registry.get("run_command")?.validate_input(&args)?;
        request(
            &ToolCall {
                id: "shell".into(),
                name: "run_command".into(),
                arguments: args.to_string(),
            },
            Path::new("/app"),
            "epoch",
            &BTreeMap::new(),
        )
    };
    let Request::Command(shell) = parse(json!({"command":"false | cat"})).unwrap() else {
        panic!()
    };
    assert_eq!(
        shell.argv,
        ["/bin/bash", "-o", "pipefail", "-c", "false | cat"]
    );
    let exit = std::process::Command::new(&shell.argv[0])
        .args(&shell.argv[1..])
        .status()
        .unwrap();
    assert!(!exit.success());
    let Request::Command(direct) = parse(json!({"argv":["printf", "%s", "a | b"]})).unwrap() else {
        panic!()
    };
    assert_eq!(direct.argv, ["printf", "%s", "a | b"]);
    for args in [
        json!({}),
        json!({"argv":"echo hi"}),
        json!({"command":"true","argv":["false"]}),
    ] {
        assert!(parse(args).is_err());
    }
}

#[tokio::test]
async fn observed_versions_and_cursors_are_bounded_and_expire_with_the_turn() {
    let client = process_fixture(0, None, None, false).await;
    let runtime = RuntimeConfig {
        client: client.clone(),
        workspace: PathBuf::from("/app"),
        writable: true,
        command_scope: None,
        command_scratch: None,
    };
    let mut handles = Handles::default();
    let mut first = json!({"sha256":"a".repeat(64)});
    handles.expose(
        "read_file",
        &json!({"path":"code.py"}),
        &mut first,
        &runtime,
    );
    let mut edit = json!({"path":"code.py","patches":[{"oldText":"old","newText":"new"}]});
    handles
        .resolve("fs_apply_patches", &mut edit, &runtime)
        .unwrap();
    assert_eq!(edit["expectedSha256"], "a".repeat(64));
    let mut new = json!({"path":"new.py","text":"new"});
    handles.resolve("fs_write", &mut new, &runtime).unwrap();
    assert!(new["expectedSha256"].is_null()); // Absent CAS, never unconditional overwrite.
    let mut old_cursor = Value::Null;
    for n in 0..1000 {
        let mut file = json!({"sha256":format!("{n:064x}")});
        handles.expose("read_file", &json!({"path":"code.py"}), &mut file, &runtime);
        let mut process = json!({"processId":"epoch:process:one", "nextCursor":format!("epoch:process:one/{n}"),"state":"running"});
        handles.expose("read_process", &json!({}), &mut process, &runtime);
        if n == 0 {
            old_cursor = process;
        }
    }
    assert_eq!(handles.versions.len(), 128);
    assert_eq!(handles.cursors.len(), 1);
    assert_eq!(handles.processes.len(), 1);
    let state = handles.snapshot();
    let mut resumed = json!({"processId":state["processes"][0]["processId"]});
    handles
        .resolve("read_process", &mut resumed, &runtime)
        .unwrap();
    assert_eq!(resumed["processId"], "epoch:process:one");
    let mut stale = json!({"processId":old_cursor["processId"],"after":old_cursor["nextCursor"]});
    assert!(
        handles
            .resolve("read_process", &mut stale, &runtime)
            .is_err()
    );
    let mut patch = json!({"path":"code.py","patches":[{"oldText":"old","newText":"new"}]});
    handles
        .resolve("fs_apply_patches", &mut patch, &runtime)
        .unwrap();
    assert_eq!(patch["expectedSha256"], format!("{:064x}", 999));
    assert!(
        Handles::default()
            .resolve(
                "fs_apply_patches",
                &mut json!({"path":"code.py","patches":[{"oldText":"old","newText":"new"}]}),
                &runtime
            )
            .is_err()
    );
    assert!(
        Handles::default()
            .resolve(
                "read_process",
                &mut json!({"processId":state["processes"][0]["processId"]}),
                &runtime
            )
            .is_err()
    );
    client.shutdown().await.unwrap();
    client.shutdown().await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn default_wait_coalesces_early_output_and_resume_preserves_the_cursor() {
    let client = process_fixture(500, Some(100), None, false).await;
    let started = Instant::now();
    let (success, result) = command(&client, None, false).await;
    assert!(success);
    assert_eq!(result["returnReason"], "completed");
    assert_eq!(result["stdout"], "ready");
    assert_eq!(result["exitCode"], 0);
    assert_eq!(started.elapsed(), Duration::from_millis(500));
    client.shutdown().await.unwrap();

    for initial_wait in [0, 200] {
        let client = process_fixture(5000, Some(100), None, false).await;
        let started = Instant::now();
        let (_, first) = command(&client, Some(initial_wait), false).await;
        assert_eq!(first["returnReason"], "waitBudget");
        let (_, last) = process_output(
            &client,
            "scope",
            ReadProcess {
                view: OutputView::Auto,
                process_id: "process".into(),
                after: Some(first["nextCursor"].as_str().unwrap().into()),
                wait_ms: 10_000,
            },
            0,
            None,
            8192,
        )
        .await
        .unwrap();
        assert_eq!(last["returnReason"], "completed");
        assert_eq!(last["stdout"], if initial_wait == 0 { "ready" } else { "" });
        assert_eq!(started.elapsed(), Duration::from_millis(5000));
        client.shutdown().await.unwrap();
    }
}

#[tokio::test(start_paused = true)]
async fn output_does_not_short_circuit_budgets_pty_deadlines_or_loss() {
    for (yield_ms, tty, expected) in [
        (Some(0), false, 0),
        (None, true, 1000),
        (Some(500), false, 500),
        (None, false, 120_000),
    ] {
        let client = process_fixture(180_000, Some(100), None, false).await;
        let started = Instant::now();
        let (_, result) = command(&client, yield_ms, tty).await;
        assert_eq!(result["returnReason"], "waitBudget");
        assert_eq!(started.elapsed(), Duration::from_millis(expected));
        client.shutdown().await.unwrap();
    }
    for loss in [false, true] {
        let client = process_fixture(2000, Some(100), Some("wallTime"), loss).await;
        let started = Instant::now();
        let (success, result) = command(&client, None, false).await;
        assert_eq!(success, loss); // Loss returns a still-running process; it is not test success.
        assert_eq!(
            result["returnReason"],
            if loss { "outputLoss" } else { "completed" }
        );
        assert_eq!(
            started.elapsed(),
            Duration::from_millis(if loss { 0 } else { 2000 })
        );
        client.shutdown().await.unwrap();
    }
}

#[tokio::test(start_paused = true)]
async fn compressed_pages_can_be_replayed_raw_without_rerunning_command() {
    let raw = format!(
        "{}FAIL test_detail\n    - old value\n    + new value\n",
        "test_x.py::test_ok PASSED [100%]\n".repeat(100)
    );
    let client = process_fixture_output(0, Some(0), None, false, raw.clone()).await;
    let argv = vec!["pytest".to_owned()];
    let (_, mut compact) = process_output(
        &client,
        "scope",
        ReadProcess {
            process_id: "process".into(),
            after: None,
            wait_ms: 0,
            view: OutputView::Auto,
        },
        0,
        Some(&argv),
        8192,
    )
    .await
    .unwrap();
    let (_, replay) = process_output(
        &client,
        "scope",
        ReadProcess {
            process_id: "process".into(),
            after: None,
            wait_ms: 0,
            view: OutputView::Raw,
        },
        0,
        Some(&argv),
        8192,
    )
    .await
    .unwrap();
    assert_eq!(compact["stdout"], raw);
    assert!(compact.get("outputViewActive").is_none());
    // 原始观察先交给持久化，模型投影不能在 Runtime 读页时丢掉原文。
    apply_output_view(&mut compact, &argv);
    assert_eq!(compact["outputViewActive"], true);
    assert!(
        compact["stdout"]
            .as_str()
            .unwrap()
            .contains("    - old value\n    + new value")
    );
    assert!(compact["outputView"].get("text").is_none());
    assert_eq!(replay["stdout"], raw);
    assert!(replay.get("outputView").is_none());
    assert_eq!(compact["nextCursor"], replay["nextCursor"]);
    assert!(compact.to_string().len() < replay.to_string().len());
    client.shutdown().await.unwrap();
}

#[test]
fn pending_verification_pages_recover_handles_hidden_by_ordinary_snapshot() {
    let mut handles = Handles::default();
    for i in 0..87 {
        let alias = format!("p{i:016}");
        let process = format!("runtime-{i}");
        handles.processes.insert(alias.clone(), process.clone());
        handles.process_snapshots.insert(
            alias.clone(),
            json!({"processId":alias,"state":"running","padding":"x".repeat(300)}),
        );
        handles.verification.insert(
            process.clone(),
            format!("workspace://scratch/verification/{i}.json"),
        );
        handles.pending_verifications.insert(process);
    }
    let ordinary = handles.snapshot();
    assert!(ordinary["processes"].as_array().unwrap().len() < 87);
    let mut after = None;
    let mut seen = std::collections::BTreeSet::new();
    loop {
        let page = handles.pending_verification_page(after.as_deref());
        assert_eq!(page["count"], 87);
        assert!(page.to_string().len() < 5000);
        for row in page["items"].as_array().unwrap() {
            assert!(seen.insert(row["processId"].as_str().unwrap().to_owned()));
            assert!(!row["processId"].as_str().unwrap().contains("runtime"));
        }
        after = page["nextAfter"].as_str().map(str::to_owned);
        if after.is_none() {
            break;
        }
    }
    assert_eq!(seen.len(), 87);
    // 终态已观察的失败/取消也应结束等待；分页不承诺验证通过。
    handles.pending_verifications.remove("runtime-86");
    let page = handles.pending_verification_page(Some("p0000000000000085"));
    assert_eq!(page["count"], 86);
    assert!(page["items"].as_array().unwrap().is_empty());
}

struct PendingExecutionGuard;
#[async_trait::async_trait]
impl Model for PendingExecutionGuard {
    fn name(&self) -> &str {
        "pending-execution-guard"
    }
    async fn stream(&self, _: Vec<model::Message>) -> anyhow::Result<model::ModelStream> {
        Ok(Box::pin(futures_util::stream::pending()))
    }
}

#[tokio::test]
async fn research_wait_releases_workspace_and_tool_capacity() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(
        dir.path(),
        Arc::new(PendingExecutionGuard),
        Limits::default(),
    )
    .unwrap();
    let parent = engine.create("/workspace".into()).await.unwrap();
    engine
        .start(&parent.id, vec![Input::text("parent")])
        .await
        .unwrap();
    let (child, _) = engine
        .spawn_child_inner(
            &parent.id,
            vec![Input::text("research")],
            false,
            None,
            None,
            None,
        )
        .await
        .unwrap();
    let parent = engine.cell(&parent.id).await.unwrap();
    for definition in agents::definitions() {
        parent
            .bindings
            .write()
            .await
            .registry
            .insert(definition, Backend::Agent)
            .unwrap();
    }
    let cancel = CancellationToken::new();
    let wait = tokio::spawn({
        let engine = engine.clone();
        let parent = parent.clone();
        let cancel = cancel.clone();
        async move {
            engine
                .tool(
                    &parent,
                    &cancel,
                    ToolCall {
                        id: "research-wait".into(),
                        name: "read_agent".into(),
                        arguments: json!({"threadId":child.id,"waitMs":60000}).to_string(),
                    },
                    usize::MAX,
                )
                .await
        }
    });
    // 观察已提交的调用意图，确保等待工具已经通过准入；不依赖任意 sleep。
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if parent.state.lock().await.thread.turns.last().unwrap().items.iter().any(|item|matches!(item,Item::DynamicToolCall{call_id,..} if call_id=="research-wait")) { break; }
            tokio::task::yield_now().await;
        }
    }).await.unwrap();
    let writer_admitted = engine.workspace_gate.clone().try_write_owned().is_ok();
    let permits = engine.tool_permits.available_permits();
    cancel.cancel();
    wait.await.unwrap().unwrap();
    engine.shutdown().await;
    assert!(
        writer_admitted,
        "a research wait held the workspace read lease, blocking an independent writer and its queued child tools"
    );
    assert_eq!(permits, 4, "research waiting retained execution capacity");
}

#[tokio::test]
async fn research_hooks_keep_workspace_admission_and_can_cancel_while_waiting() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("repo");
    std::fs::create_dir(&workspace).unwrap();
    let workspace = workspace.canonicalize().unwrap();
    let client =
        process_fixture_output(0, Some(0), None, false, r#"{"decision":"allow"}"#.into()).await;
    let engine = Engine::open_with_extensions(
        &dir.path().join("state"),
        Arc::new(PendingExecutionGuard),
        Limits::default(),
        Some(RuntimeConfig {
            client: client.clone(),
            workspace: workspace.clone(),
            writable: true,
            command_scope: None,
            command_scratch: None,
        }),
        ToolExtensions {
            hooks: vec![HookEvent::PreToolUse, HookEvent::PostToolUse]
                .into_iter()
                .map(|event| HookDefinition {
                    name: event.as_str().into(),
                    event,
                    matcher: "read_agent".into(),
                    argv: vec!["fixture-hook".into()],
                    timeout_ms: 1000,
                })
                .collect(),
            ..Default::default()
        },
    )
    .unwrap();
    let parent = engine
        .create(workspace.to_string_lossy().into())
        .await
        .unwrap();
    engine
        .start(&parent.id, vec![Input::text("parent")])
        .await
        .unwrap();
    let (child, _) = engine
        .spawn_child_inner(
            &parent.id,
            vec![Input::text("research")],
            false,
            None,
            None,
            None,
        )
        .await
        .unwrap();
    let parent = engine.cell(&parent.id).await.unwrap();
    for definition in agents::definitions() {
        parent
            .bindings
            .write()
            .await
            .registry
            .insert(definition, Backend::Agent)
            .unwrap();
    }
    for stop in [false, true] {
        let writer = engine.workspace_gate.clone().write_owned().await;
        let call_id = if stop {
            "cancel-hook-wait"
        } else {
            "complete-hooks"
        };
        let cancel = CancellationToken::new();
        let wait = tokio::spawn({
            let engine = engine.clone();
            let parent = parent.clone();
            let cancel = cancel.clone();
            let child = child.id.clone();
            async move {
                engine
                    .tool(
                        &parent,
                        &cancel,
                        ToolCall {
                            id: call_id.into(),
                            name: "read_agent".into(),
                            arguments: json!({"threadId":child,"waitMs":0}).to_string(),
                        },
                        usize::MAX,
                    )
                    .await
            }
        });
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if let Some(Item::DynamicToolCall { execution, .. }) = parent
                    .state
                    .lock()
                    .await
                    .thread
                    .turns
                    .last()
                    .unwrap()
                    .items
                    .iter()
                    .find(|item| matches!(item,Item::DynamicToolCall{call_id:id,..} if id==call_id))
                {
                    assert!(
                        execution.hooks.is_empty(),
                        "hook bypassed the existing writer"
                    );
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        if stop {
            cancel.cancel();
            // 仍持有作者租约，取消必须能结束等待，不能依赖作者先退出。
            tokio::time::timeout(Duration::from_secs(3), wait)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            drop(writer);
        } else {
            drop(writer);
            tokio::time::timeout(Duration::from_secs(3), wait)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
        }
        let state = parent.state.lock().await;
        let Some(Item::DynamicToolCall { execution, .. }) = state
            .thread
            .turns
            .last()
            .unwrap()
            .items
            .iter()
            .find(|item| matches!(item,Item::DynamicToolCall{call_id:id,..} if id==call_id))
        else {
            panic!("missing hook call receipt")
        };
        if stop {
            assert!(execution.hooks.is_empty());
        } else {
            assert_eq!(execution.hooks.len(), 2);
            assert!(
                execution
                    .hooks
                    .iter()
                    .all(|hook| hook.outcome == ToolOutcome::Succeeded)
            );
        }
    }
    engine.shutdown().await;
    client.shutdown().await.unwrap();
}

struct ExternalAgentNamedHost {
    gate: Arc<tokio::sync::RwLock<()>>,
    saw_read_lease: Arc<std::sync::atomic::AtomicBool>,
}

#[async_trait::async_trait]
impl DynamicToolHost for ExternalAgentNamedHost {
    fn id(&self) -> &str {
        "external-agent-name"
    }
    fn is_closed(&self) -> bool {
        false
    }
    async fn call(
        &self,
        _: Value,
        _: CancellationToken,
    ) -> anyhow::Result<areal_protocol::DynamicToolResponse> {
        self.saw_read_lease
            .store(self.gate.try_write().is_err(), Ordering::Release);
        Ok(areal_protocol::DynamicToolResponse {
            success: true,
            content_items: vec![],
            structured_content: None,
        })
    }
}

#[tokio::test]
async fn same_named_external_agent_tool_keeps_workspace_admission() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(
        dir.path(),
        Arc::new(PendingExecutionGuard),
        Limits::default(),
    )
    .unwrap();
    let saw_read_lease = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let host = Arc::new(ExternalAgentNamedHost {
        gate: engine.workspace_gate.clone(),
        saw_read_lease: saw_read_lease.clone(),
    });
    let definition = agents::definitions()
        .into_iter()
        .find(|definition| definition.name == "read_agent")
        .unwrap();
    let thread = engine
        .create_with_tools("/workspace".into(), vec![definition], host)
        .await
        .unwrap();
    engine
        .start(&thread.id, vec![Input::text("parent")])
        .await
        .unwrap();
    let cell = engine.cell(&thread.id).await.unwrap();
    engine
        .tool(
            &cell,
            &CancellationToken::new(),
            ToolCall {
                id: "external-read-agent".into(),
                name: "read_agent".into(),
                arguments: json!({"threadId":"external"}).to_string(),
            },
            usize::MAX,
        )
        .await
        .unwrap();
    engine.shutdown().await;
    assert!(
        saw_read_lease.load(Ordering::Acquire),
        "tool name granted an external backend a coordination exemption"
    );
}

async fn assert_child_creation_gate(exclusive: bool) {
    let dir = tempfile::tempdir().unwrap();
    let limits = if exclusive {
        Limits::default()
    } else {
        Limits {
            max_children_per_turn: 0,
            ..Limits::default()
        }
    };
    let engine = Engine::open(dir.path(), Arc::new(PendingExecutionGuard), limits).unwrap();
    let parent = engine.create("/workspace".into()).await.unwrap();
    let parent_turn = engine
        .start(&parent.id, vec![Input::text("parent")])
        .await
        .unwrap();
    let thread_id = if exclusive {
        engine.spawn_delegated_child(
            serde_json::from_value(json!({"parentThreadId":parent.id,"input":[{"type":"text","text":"writer"}],"workspaceMode":"sharedWrite"})).unwrap(),
            parent_turn.id,
            true,
            None,
        ).await.unwrap().0.id
    } else {
        parent.id.clone()
    };
    let cell = engine.cell(&thread_id).await.unwrap();
    if exclusive {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if cell
                    .state
                    .lock()
                    .await
                    .active
                    .as_ref()
                    .unwrap()
                    .workspace_exclusive
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    {
        let mut bindings = cell.bindings.write().await;
        if bindings.registry.get("workgroup_start").is_err() {
            bindings.registry = bindings.registry.clone().with_workgroups(true).unwrap();
        }
        if bindings.registry.get("agent_spawn").is_err() {
            bindings.registry = bindings.registry.clone().with_agents(true).unwrap();
        }
        for definition in agents::definitions() {
            bindings
                .registry
                .insert(definition, Backend::Agent)
                .unwrap();
        }
    }
    for (name, args) in [
        ("agent_spawn", json!({"prompt":"nested child"})),
        (
            "agent_spawn_configured",
            json!({"input":[{"type":"text","text":"nested configured child"}]}),
        ),
        ("task_spawn", json!({"prompt":"nested task worker"})),
        (
            "delegate_tasks",
            json!({"tasks":["nested research"],"wait":true}),
        ),
        (
            "workgroup_start",
            json!({"requestId":"nested-group","plan":{"objective":"nested work","tasks":[{"id":"child","instruction":"implement","writes":["result.txt"]}]}}),
        ),
    ] {
        cell.bindings
            .read()
            .await
            .registry
            .get(name)
            .unwrap()
            .validate_input(&args)
            .unwrap();
        tokio::time::timeout(
            Duration::from_secs(2),
            engine.tool(
                &cell,
                &CancellationToken::new(),
                ToolCall {
                    id: name.into(),
                    name: name.into(),
                    arguments: args.to_string(),
                },
                usize::MAX,
            ),
        )
        .await
        .unwrap()
        .unwrap();
        let state = cell.state.lock().await;
        let item = state
            .thread
            .turns
            .last()
            .unwrap()
            .items
            .iter()
            .find(|item| matches!(item, Item::DynamicToolCall { call_id, .. } if call_id == name))
            .unwrap();
        let Item::DynamicToolCall {
            success,
            content_items,
            ..
        } = item
        else {
            panic!("missing tool receipt")
        };
        assert_eq!(*success, Some(false), "{name}");
        assert!(
            serde_json::to_string(content_items)
                .unwrap()
                .contains("CHILD_EXECUTION_DISABLED"),
            "{name}: {content_items:?}"
        );
        assert!(state.active.as_ref().unwrap().children.is_empty());
    }
    if exclusive {
        let error = tokio::time::timeout(Duration::from_secs(2), engine.spawn_agent(
            serde_json::from_value(json!({"parentThreadId":thread_id,"input":[{"type":"text","text":"nested RPC child"}]})).unwrap()
        )).await.unwrap().unwrap_err();
        assert!(error.to_string().contains("exclusive writers"));
    }
    engine
        .tool(
            &cell,
            &CancellationToken::new(),
            ToolCall {
                id: "plan-read".into(),
                name: "plan_read".into(),
                arguments: "{}".into(),
            },
            usize::MAX,
        )
        .await
        .unwrap();
    assert!(cell.state.lock().await.thread.turns.last().unwrap().items.iter().any(|item|
        matches!(item, Item::DynamicToolCall { call_id, success: Some(true), .. } if call_id == "plan-read")
    ));
    engine.shutdown().await;
}

#[tokio::test]
async fn exclusive_writer_rejects_legacy_child_creation_without_deadlocking() {
    assert_child_creation_gate(true).await;
}

#[tokio::test]
async fn bounded_isolated_worker_cannot_bypass_its_zero_child_limit() {
    assert_child_creation_gate(false).await;
}

#[test]
fn child_creation_classification_is_bound_to_the_actual_backend() {
    for name in [
        "agent_spawn",
        "agent_spawn_configured",
        "task_spawn",
        "delegate_tasks",
        "workgroup_start",
    ] {
        assert!(!creates_child_execution(name, &Backend::Client));
        assert!(!creates_child_execution(name, &Backend::Builtin));
    }
    for name in [
        "agent_read",
        "agent_wait",
        "agent_cancel",
        "agent_report",
        "workgroup_read",
        "workgroup_wait",
        "workgroup_cancel",
    ] {
        assert!(!creates_child_execution(name, &Backend::Coordination));
    }
    assert!(!creates_child_execution("plan_read", &Backend::Core));
    assert!(!creates_child_execution("read_agent", &Backend::Agent));
}

#[test]
fn command_input_contract_requires_explicit_pipe_and_allows_eof() {
    for open in [false, true] {
        let args = if open {
            json!({"argv":["cat"],"stdinOpen":true})
        } else {
            json!({"argv":["cat"]})
        };
        let call = ToolCall {
            id: "stdin".into(),
            name: "run_command".into(),
            arguments: args.to_string(),
        };
        let Request::Command(command) =
            request(&call, Path::new("/app"), "epoch", &BTreeMap::new()).unwrap()
        else {
            panic!("command")
        };
        assert_eq!(command.stdin_open, open);
    }
    let request: WriteProcess =
        serde_json::from_value(json!({"processId":"p-test","close":true})).unwrap();
    assert!(request.close);
    assert!(request.text.is_empty());
}
