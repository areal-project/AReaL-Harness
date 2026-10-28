use areal_runtime_protocol::*;
use std::{process::Stdio, time::Duration};
use tokio::process::Command;

#[cfg(target_os = "macos")]
#[tokio::test]
async fn desktop_path_runs_installed_tools_in_parent_and_read_only_child() {
    use futures_util::{StreamExt, stream};
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let tools: Vec<_> = ["node", "npm", "pnpm", "rg", "rustc", "cargo", "uv"]
        .into_iter()
        .filter(|tool| {
            ["/opt/homebrew/bin", "/usr/local/bin"]
                .iter()
                .any(|bin| std::path::Path::new(bin).join(tool).is_file())
                || home.as_ref().is_some_and(|home| {
                    [".cargo/bin", ".local/bin"]
                        .iter()
                        .any(|bin| home.join(bin).join(tool).is_file())
                })
        })
        .collect();
    assert!(
        !tools.is_empty(),
        "原生工具链验证需要至少一个已安装的标准工具"
    );
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("source"), "keep").unwrap();
    std::fs::write(outside.path().join("private"), "private").unwrap();
    let binary = std::path::Path::new(env!("CARGO_BIN_EXE_areal-runtime"));
    let client = areal_runtime_client::Client::launch_with_command_path(
        binary,
        &binary.with_file_name("areal-runtime-fs"),
        dir.path(),
        true,
        &Limits::default(),
        "/usr/bin:/bin:/usr/sbin:/sbin",
    )
    .await
    .unwrap();
    let child = client
        .create_scope(CreateScope {
            operation_id: client.operation_id(),
            parent_scope_id: client.info().root_scope_id.clone(),
            owner: Owner {
                task_id: "readonly-tools".into(),
                plugin_instance_id: None,
            },
            permissions: PermissionRequest {
                read_roots: Some(vec!["workspace://repo".into()]),
                write_roots: Some(vec![]),
                network: NetworkRequest::Deny,
            },
            limits: LimitRequest::default(),
        })
        .await
        .unwrap();
    let mut probes = Vec::new();
    for scope in [&client.info().root_scope_id, &child.scope_id] {
        for tool in &tools {
            probes.push((scope.clone(), format!("{tool} --version"), true));
        }
    }
    probes.extend([
        (
            child.scope_id.clone(),
            "printf changed > source".into(),
            false,
        ),
        (
            child.scope_id.clone(),
            format!("cat '{}'", outside.path().join("private").display()),
            false,
        ),
        (
            child.scope_id.clone(),
            "node -e 'require(\"node:net\").createServer().listen(0,\"127.0.0.1\")'".into(),
            false,
        ),
    ]);
    let results: Vec<_> = stream::iter(probes)
        .map(|(scope, code, allowed)| {
            let client = client.clone();
            async move {
                let process = client
                    .start(StartProcess {
                        operation_id: client.operation_id(),
                        scope_id: scope,
                        argv: vec!["/bin/sh".into(), "-c".into(), code.clone()],
                        cwd: "workspace://repo".into(),
                        env: Default::default(),
                        tty: false,
                        pipe_stdin: false,
                        limits: LimitRequest {
                            wall_time_ms: Some(10_000),
                            ..Default::default()
                        },
                    })
                    .await
                    .unwrap();
                let result = client.wait(&process.process_id).await.unwrap();
                if allowed && result.exit_code != Some(0) {
                    let output: serde_json::Value = client
                        .call(
                            "output.read",
                            serde_json::json!({"processId":process.process_id,"maxBytes":8192}),
                        )
                        .await
                        .unwrap();
                    eprintln!("failed-output {code:?} {output}");
                }
                eprintln!(
                    "probe={code:?} allowed={allowed} exit={:?} cleanup={}",
                    result.exit_code, result.cleanup_confirmed
                );
                (code, allowed, result)
            }
        })
        .buffer_unordered(4)
        .collect()
        .await;
    client.shutdown().await.unwrap();
    for (code, allowed, result) in results {
        assert_eq!(result.exit_code == Some(0), allowed, "{code}: {result:?}");
        assert!(result.cleanup_confirmed);
    }
    assert_eq!(
        std::fs::read_to_string(dir.path().join("source")).unwrap(),
        "keep"
    );
}

#[tokio::test]
async fn trusted_launch_inherits_only_granted_network_and_child_scopes_can_deny_it() {
    for network in [NetworkRequest::Deny, NetworkRequest::Inherit] {
        let dir = tempfile::tempdir().unwrap();
        let binary = std::path::Path::new(env!("CARGO_BIN_EXE_areal-runtime"));
        let helper = binary.with_file_name("areal-runtime-fs");
        let client = areal_runtime_client::Client::launch_with_environment(
            binary,
            &helper,
            dir.path(),
            true,
            &Limits::default(),
            "/usr/bin:/bin",
            network,
        )
        .await
        .unwrap();
        assert_eq!(
            client.info().capabilities["rootNetwork"],
            serde_json::to_value(network).unwrap()
        );
        for narrowed in [false, true] {
            let scope = client
                .create_scope(CreateScope {
                    operation_id: client.operation_id(),
                    parent_scope_id: client.info().root_scope_id.clone(),
                    owner: Owner {
                        task_id: "network-boundary".into(),
                        plugin_instance_id: None,
                    },
                    permissions: PermissionRequest {
                        network: if narrowed {
                            NetworkRequest::Deny
                        } else {
                            NetworkRequest::Inherit
                        },
                        ..Default::default()
                    },
                    limits: LimitRequest::default(),
                })
                .await
                .unwrap();
            let process = client
                .start(StartProcess {
                    operation_id: client.operation_id(),
                    scope_id: scope.scope_id,
                    argv: vec![
                        "/usr/bin/python3".into(),
                        "-I".into(),
                        "-B".into(),
                        "-c".into(),
                        "import socket,sys\ntry:\n with socket.socket() as s: s.bind(('127.0.0.1',0))\nexcept PermissionError: sys.exit(42)".into(),
                    ],
                    cwd: "workspace://repo".into(),
                    env: Default::default(),
                    tty: false,
                    pipe_stdin: false,
                    limits: LimitRequest::default(),
                })
                .await
                .unwrap();
            let result = client.wait(&process.process_id).await.unwrap();
            let allowed = network == NetworkRequest::Inherit && !narrowed;
            assert_eq!(
                result.exit_code,
                Some(if allowed { 0 } else { 42 }),
                "network={network:?}, narrowed={narrowed}, result={result:?}"
            );
        }
        client.shutdown().await.unwrap();
    }
}

// 使用合成 HOME、临时密钥和独立 SSH agent；不访问开发者凭据、Keychain 或真实远端。
#[tokio::test]
async fn git_identity_and_ssh_agent_follow_effective_scope_permissions() {
    let temp = tempfile::Builder::new()
        .prefix("areal-git-")
        .tempdir_in("/tmp")
        .unwrap();
    let root = temp.path().canonicalize().unwrap();
    let home = root.join("home");
    let repo = root.join("repo");
    let scratch = root.join("scratch");
    for path in [&home, &repo, &scratch] {
        std::fs::create_dir(path).unwrap();
    }
    let config = "[user]\nname = Runtime Fixture\nemail = runtime@example.invalid\n[commit]\ngpgSign = false\n[core]\nhooksPath = /dev/null\n";
    std::fs::write(home.join(".gitconfig"), config).unwrap();
    let socket = root.join("agent.sock");
    // 前台 agent 由测试持有，任何失败都会关闭它；不复用登录会话的 agent。
    let mut agent = Command::new("/usr/bin/ssh-agent")
        .args(["-D", "-a"])
        .arg(&socket)
        .env_clear()
        .env("HOME", &home)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !socket.exists() {
            assert!(agent.try_wait().unwrap().is_none());
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let key = root.join("key");
    assert!(
        Command::new("/usr/bin/ssh-keygen")
            .args([
                "-q",
                "-t",
                "ed25519",
                "-N",
                "",
                "-C",
                "runtime-fixture",
                "-f"
            ])
            .arg(&key)
            .env_clear()
            .env("HOME", &home)
            .stdin(Stdio::null())
            .status()
            .await
            .unwrap()
            .success()
    );
    assert!(
        Command::new("/usr/bin/ssh-add")
            .arg(&key)
            .env_clear()
            .env("HOME", &home)
            .env("SSH_AUTH_SOCK", &socket)
            .stdin(Stdio::null())
            .status()
            .await
            .unwrap()
            .success()
    );
    let public_key = std::fs::read_to_string(key.with_extension("pub")).unwrap();
    std::fs::write(repo.join("signing-key.pub"), &public_key).unwrap();
    std::fs::write(
        repo.join("allowed-signers"),
        format!("runtime@example.invalid {public_key}"),
    )
    .unwrap();
    // 签名时磁盘只剩公钥，成功必须来自 agent，不能被私钥文件回退掩盖。
    std::fs::remove_file(&key).unwrap();
    for protected in [false, true] {
        #[cfg(target_os = "macos")]
        let mut command = {
            let mut command = Command::new("/usr/bin/python3");
            command.args(["-I", "-S", "-c", "import subprocess,sys; r=subprocess.run(sys.argv[1:]).returncode; sys.exit(r if r>=0 else 128-r)"]);
            command.arg(env!("CARGO_BIN_EXE_areal-runtime"));
            command
        };
        #[cfg(not(target_os = "macos"))]
        let mut command = Command::new(env!("CARGO_BIN_EXE_areal-runtime"));
        if protected {
            command.arg("--read-only-path").arg(&home);
        }
        let mut daemon = command
            .arg("--workspace")
            .arg(&repo)
            .arg("--scratch")
            .arg(&scratch)
            .args([
                "--sandbox-profile",
                "full-access",
                "--wall-time-ms",
                "10000",
            ])
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", &home)
            .env("SSH_AUTH_SOCK", &socket)
            .env("MODEL_KEY", "synthetic-model-secret")
            .env("GITHUB_TOKEN", "synthetic-git-secret")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let client = areal_runtime_client::Client::connect(
            daemon.stdout.take().unwrap(),
            daemon.stdin.take().unwrap(),
        )
        .await
        .unwrap();
        let parent = client.info().root_scope_id.clone();
        let mut scopes = vec![(parent.clone(), !protected)];
        for (reads, writes, network) in [
            (None, None, NetworkRequest::Deny),
            (
                Some(vec![
                    "workspace://repo".into(),
                    "workspace://scratch".into(),
                ]),
                Some(vec!["workspace://scratch".into()]),
                NetworkRequest::Inherit,
            ),
        ] {
            let child = client
                .create_scope(CreateScope {
                    operation_id: client.operation_id(),
                    parent_scope_id: parent.clone(),
                    owner: Owner {
                        task_id: "git-environment".into(),
                        plugin_instance_id: None,
                    },
                    permissions: PermissionRequest {
                        read_roots: reads,
                        write_roots: writes,
                        network,
                    },
                    limits: LimitRequest::default(),
                })
                .await
                .unwrap();
            scopes.push((child.scope_id, false));
        }
        for (scope_id, unrestricted) in scopes {
            let code = if unrestricted {
                // 真正完成 SSH 签名和验证；只移除 socket 的负对照必须失败且不改变 HEAD。
                r#"set -e
                    test -z "${MODEL_KEY-}${GITHUB_TOKEN-}"
                    test -S "$SSH_AUTH_SOCK"
                    /usr/bin/ssh-add -l
                    git init -q
                    printf fixture > fixture
                    git add fixture
                    git -c gpg.format=ssh -c user.signingkey=signing-key.pub -c commit.gpgsign=true commit -qm fixture
                    git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=allowed-signers verify-commit HEAD
                    test "$(git log -1 --format='%an <%ae>|%cn <%ce>')" = 'Runtime Fixture <runtime@example.invalid>|Runtime Fixture <runtime@example.invalid>'
                    before=$(git rev-parse HEAD)
                    if SSH_AUTH_SOCK= git -c gpg.format=ssh -c user.signingkey=signing-key.pub -c commit.gpgsign=true commit --allow-empty -qm missing-agent; then
                        echo 'unexpected signing success without agent' >&2
                        exit 1
                    fi
                    test "$(git rev-parse HEAD)" = "$before"
                "#
            } else {
                "set -e; test -z \"${SSH_AUTH_SOCK-}${MODEL_KEY-}${GITHUB_TOKEN-}\"; test \"$HOME\" = \"$TMPDIR\"; test ! -e \"$HOME/.gitconfig\""
            };
            let process = client
                .start(StartProcess {
                    operation_id: client.operation_id(),
                    scope_id,
                    argv: vec!["/bin/sh".into(), "-c".into(), code.into()],
                    cwd: "workspace://repo".into(),
                    env: std::collections::BTreeMap::from([(
                        "TMPDIR".into(),
                        scratch.to_string_lossy().into_owned(),
                    )]),
                    tty: false,
                    pipe_stdin: false,
                    limits: LimitRequest::default(),
                })
                .await
                .unwrap();
            let result = client.wait(&process.process_id).await.unwrap();
            let output: serde_json::Value = client
                .call(
                    "output.read",
                    serde_json::json!({"processId":process.process_id,"maxBytes":8192}),
                )
                .await
                .unwrap();
            assert_eq!(
                result.exit_code,
                Some(0),
                "protected={protected} unrestricted={unrestricted}: {output}"
            );
            assert!(result.cleanup_confirmed);
        }
        client.shutdown().await.unwrap();
        assert!(daemon.wait().await.unwrap().success());
    }
    agent.kill().await.unwrap();
    assert_eq!(
        std::fs::read_to_string(home.join(".gitconfig")).unwrap(),
        config
    );
}

// End-to-end contract: the public client/daemon admission reaches the native
// sandbox, and a same-task ordinary command can release two concurrent hooks.
#[tokio::test]
async fn native_hook_group_allows_progress_without_releasing_foreign_exclusion() {
    let dir = tempfile::tempdir().unwrap();
    #[cfg(target_os = "macos")]
    let mut command = {
        // 与产品启动桥接一致，由系统父进程启动本地原生程序，保留原退出状态和管道。
        let mut command = Command::new("/usr/bin/python3");
        command.args(["-I", "-S", "-c", "import subprocess,sys; r=subprocess.run(sys.argv[1:]).returncode; sys.exit(r if r>=0 else 128-r)"]);
        command.arg(env!("CARGO_BIN_EXE_areal-runtime"));
        command
    };
    #[cfg(not(target_os = "macos"))]
    let mut command = Command::new(env!("CARGO_BIN_EXE_areal-runtime"));
    let mut daemon = command
        .arg("--workspace")
        .arg(dir.path())
        .args([
            "--allow-write",
            "--max-processes",
            "8",
            "--wall-time-ms",
            "5000",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let read = daemon.stdout.take().unwrap();
    let write = daemon.stdin.take().unwrap();
    let client = areal_runtime_client::Client::connect(read, write)
        .await
        .unwrap();
    let root = client.info().root_scope_id.clone();
    let scope = |parent: String| CreateScope {
        operation_id: client.operation_id(),
        parent_scope_id: parent,
        owner: Owner {
            task_id: "native-hook-fixture".into(),
            plugin_instance_id: None,
        },
        permissions: PermissionRequest::default(),
        limits: LimitRequest::default(),
    };
    let task = client
        .create_participant_scope(CreateParticipantScope {
            authority_scope_id: root.clone(),
            scope: scope(root.clone()),
            participation: ScopeParticipation::Task {
                admission_window_ms: 4000,
            },
        })
        .await
        .unwrap();
    let hook = client
        .create_participant_scope(CreateParticipantScope {
            authority_scope_id: root.clone(),
            scope: scope(task.scope_id.clone()),
            participation: ScopeParticipation::Hook {
                task_scope_id: task.scope_id.clone(),
            },
        })
        .await
        .unwrap();
    let command = |scope: String, text: &str| StartProcess {
        operation_id: client.operation_id(),
        scope_id: scope,
        argv: vec!["/bin/sh".into(), "-c".into(), text.into()],
        cwd: "workspace://repo".into(),
        env: Default::default(),
        tty: false,
        pipe_stdin: false,
        limits: LimitRequest::default(),
    };
    let first = client
        .start(command(
            hook.scope_id.clone(),
            "touch hook-one; while [ ! -e release ]; do sleep 0.02; done",
        ))
        .await
        .unwrap();
    let second = client
        .start(command(
            hook.scope_id,
            "touch hook-two; while [ ! -e release ]; do sleep 0.02; done",
        ))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while !dir.path().join("hook-one").exists() || !dir.path().join("hook-two").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let foreign = {
        let client = client.clone();
        let req = command(root, "touch foreign");
        tokio::spawn(async move { client.start(req).await })
    };
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(!foreign.is_finished());
    assert!(!dir.path().join("foreign").exists());
    let own = client
        .start(command(task.scope_id, "touch release"))
        .await
        .unwrap();
    for process in [&first, &second, &own] {
        assert_eq!(
            client.wait(&process.process_id).await.unwrap().exit_code,
            Some(0)
        );
    }
    let foreign = foreign.await.unwrap().unwrap();
    assert_eq!(
        client.wait(&foreign.process_id).await.unwrap().exit_code,
        Some(0)
    );
    assert!(dir.path().join("foreign").exists());
    client.shutdown().await.unwrap();
    assert!(daemon.wait().await.unwrap().success());
}
