use super::*;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::time::Instant;

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
        "fs_apply_patch":{"path":"a","oldText":"hello","newText":"world","expectedSha256":"a".repeat(64)},
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
                    json!({"protocolVersion":rt::VERSION,"runtimeEpoch":"epoch","connectionId":"fixture","rootScopeId":"scope","capabilities":{}})
                }
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
                    let consumed = params["after"] == "process/5";
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
                    let chunks = if ready && !consumed {
                        vec![
                            json!({"cursor":"process/5","stream":"stdout","dataBase64":STANDARD.encode("ready")}),
                        ]
                    } else {
                        vec![]
                    };
                    json!({"chunks":chunks,"nextCursor":if ready {"process/5"} else {"process/0"},"closed":elapsed >= finish_ms,"gap":loss,"truncated":loss})
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
            argv: vec!["fixture".into()],
            cwd: "workspace://repo".into(),
            timeout_ms: 300_000,
            yield_ms,
            tty,
        }),
        "scope",
        "operation",
        policy,
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
                process_id: "process".into(),
                after: Some(result["nextCursor"].as_str().unwrap().into()),
                wait_ms: 30_000,
            },
            100,
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
            process_id: "process".into(),
            after: Some(result["nextCursor"].as_str().unwrap().into()),
            wait_ms: 120_000,
        },
        100,
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
            process_id: "process".into(),
            after: None,
            wait_ms: 0,
        },
        100,
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
        "fs_apply_patch",
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
    let mut edit = json!({"path":"code.py","oldText":"old","newText":"new"});
    handles
        .resolve("fs_apply_patch", &mut edit, &runtime)
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
    let mut patch = json!({"path":"code.py","oldText":"old","newText":"new"});
    handles
        .resolve("fs_apply_patch", &mut patch, &runtime)
        .unwrap();
    assert_eq!(patch["expectedSha256"], format!("{:064x}", 999));
    assert!(
        Handles::default()
            .resolve(
                "fs_apply_patch",
                &mut json!({"path":"code.py","oldText":"old","newText":"new"}),
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
                process_id: "process".into(),
                after: Some(first["nextCursor"].as_str().unwrap().into()),
                wait_ms: 10_000,
            },
            0,
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
