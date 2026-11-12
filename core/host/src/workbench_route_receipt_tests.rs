//! 从 workbench_route.rs 拆出的测试：写命令回执（明确失败按拒绝结算、回复丢失保持未知且不重放）与后台准入。
use super::*;

#[tokio::test(flavor = "current_thread")]
async fn explicit_backend_failure_settles_as_rejection_not_unknown() {
    tokio::task::LocalSet::new().run_until(async {
        let root = tempfile::tempdir().unwrap();
        let host = Rc::new(crate::server::schedules::tests::fixture(root.path()));
        let runtime = std::env::split_paths(&std::env::var_os("PATH").unwrap())
            .map(|path| path.join("node")).find(|path| path.is_file()).expect("Node is required for the workbench boundary test");
        let runner = root.path().join("refuse.cjs");
        std::fs::write(&runner, r#"
            console.log(JSON.stringify({version:1,event:'ready',methods:['feedback.command','providers.command']}));
            require('node:readline').createInterface({input:process.stdin}).on('line', (line) => {
              const request = JSON.parse(line);
              console.log(JSON.stringify({version:1,id:request.id,error:{code:request.method === 'providers.command' ? 'PROVIDER_CREDENTIAL_REQUIRED' : 'TARGET_CHANGED'}}));
            });
        "#).unwrap();
        let reverse: Reverse = Rc::new(|_, _| Box::pin(async { bail!("FORBIDDEN") }));
        let backend = Workbench::start(&runtime, &runner, root.path(), reverse).await.unwrap();
        *host.gateway.workbench.backend.running.borrow_mut() = Some(Rc::new(backend));
        *host.gateway.workbench.backend.source.borrow_mut() = Some("fixture".into());
        let command = uuid::Uuid::new_v4().to_string();
        let request = json!({"method":"feedback.command","commandId":command,"params":{"sourceId":"fixture","operation":"preference","enabled":true}});
        assert_eq!(backend_command(&host, "local", &request).await.unwrap_err().to_string(), "TARGET_CHANGED");
        // 同一命令再来一次只读原结论，不重新派发，也不留在待核对列表里。
        assert_eq!(backend_command(&host, "local", &request).await.unwrap_err().to_string(), "TARGET_CHANGED");
        assert_eq!(backend_receipt(&host, "local", &command).unwrap_err().to_string(), "TARGET_CHANGED");
        let scope = format!("workbench-{}", areal_local_service::storage::digest(b"local"));
        let (_, snapshot) = host.journal.native_snapshot(&scope).unwrap();
        assert_eq!(snapshot["pending"], json!([]));
        assert_eq!(snapshot["outcomes"][&command]["admissionState"], "rejected");
        let provider_command = uuid::Uuid::new_v4().to_string();
        let provider = json!({"method":"providers.command","commandId":provider_command,"params":{"sourceId":"fixture","operation":"save","expectedRevision":"initial","authentication":"apiKey","provider":{"name":"fixture","baseUrl":"https://example.invalid","protocol":"responses","models":[]}}});
        assert_eq!(backend_command(&host, "local", &provider).await.unwrap_err().to_string(), "PROVIDER_CREDENTIAL_REQUIRED");
        assert_eq!(backend_receipt(&host, "local", &provider_command).unwrap_err().to_string(), "PROVIDER_CREDENTIAL_REQUIRED");
        let (_, snapshot) = host.journal.native_snapshot(&scope).unwrap();
        assert_eq!(snapshot["pending"], json!([]));
        assert_eq!(snapshot["outcomes"][&provider_command]["admissionState"], "rejected");
        host.gateway.workbench.stop_backend().await;
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn lost_backend_reply_keeps_the_original_library_command_unknown() {
    tokio::task::LocalSet::new().run_until(async {
        let root = tempfile::tempdir().unwrap();
        let host = Rc::new(crate::server::schedules::tests::fixture(root.path()));
        let runtime = std::env::split_paths(&std::env::var_os("PATH").unwrap())
            .map(|path| path.join("node")).find(|path| path.is_file()).expect("Node is required for the workbench boundary test");
        let runner = root.path().join("lost-reply.cjs");
        std::fs::write(&runner, r#"
            const fs = require('node:fs');
            console.log(JSON.stringify({version:1,event:'ready',methods:['feedback.command']}));
            require('node:readline').createInterface({input:process.stdin}).on('line', () => {
              fs.appendFileSync(process.env.AREAL_WORKBENCH_DATA + '/effects', 'once\n');
              process.exit(0);
            });
        "#).unwrap();
        let reverse: Reverse = Rc::new(|_, _| Box::pin(async { bail!("FORBIDDEN") }));
        let backend = Workbench::start(&runtime, &runner, root.path(), reverse).await.unwrap();
        *host.gateway.workbench.backend.running.borrow_mut() = Some(Rc::new(backend));
        *host.gateway.workbench.backend.source.borrow_mut() = Some("fixture".into());
        let command = uuid::Uuid::new_v4().to_string();
        let request = json!({"method":"feedback.command","commandId":command,"params":{"sourceId":"fixture","operation":"preference","enabled":true}});
        let first = backend_command(&host, "local", &request).await.unwrap();
        assert_eq!(first["submissionUnknown"], true);
        assert_eq!(backend_command(&host, "local", &request).await.unwrap(), first);
        assert_eq!(std::fs::read_to_string(root.path().join("effects")).unwrap(), "once\n");
        let mut conflict = request.clone();
        conflict["params"]["enabled"] = json!(false);
        assert_eq!(backend_command(&host, "local", &conflict).await.unwrap_err().to_string(), "COMMAND_CONFLICT");
        assert_eq!(backend_receipt(&host, "local", &command).unwrap().unwrap()["submissionUnknown"], true);
        let other_method = json!({"method":"worktree.command","commandId":command,"params":{"sourceId":"fixture","operation":"worktreeSettings","worktreeRoot":"/isolated","branchPrefix":"fixture"}});
        assert_eq!(backend_command(&host, "local", &other_method).await.unwrap_err().to_string(), "COMMAND_CONFLICT");
        host.gateway.workbench.stop_backend().await;
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn lost_provider_reply_keeps_receipt_without_persisting_credentials() {
    tokio::task::LocalSet::new().run_until(async {
        let root = tempfile::tempdir().unwrap();
        let host = Rc::new(crate::server::schedules::tests::fixture(root.path()));
        let runtime = std::env::split_paths(&std::env::var_os("PATH").unwrap())
            .map(|path| path.join("node")).find(|path| path.is_file()).expect("Node is required for the workbench boundary test");
        let runner = root.path().join("lost-reply.cjs");
        std::fs::write(&runner, r#"
            const fs = require('node:fs');
            console.log(JSON.stringify({version:1,event:'ready',methods:['providers.command']}));
            require('node:readline').createInterface({input:process.stdin}).on('line', () => {
              fs.appendFileSync(process.env.AREAL_WORKBENCH_DATA + '/effects', 'once\n');
              process.exit(0);
            });
        "#).unwrap();
        let reverse: Reverse = Rc::new(|_, _| Box::pin(async { bail!("FORBIDDEN") }));
        let backend = Workbench::start(&runtime, &runner, root.path(), reverse).await.unwrap();
        *host.gateway.workbench.backend.running.borrow_mut() = Some(Rc::new(backend));
        *host.gateway.workbench.backend.source.borrow_mut() = Some("fixture".into());
        let command = uuid::Uuid::new_v4().to_string();
        let request = json!({"method":"providers.command","commandId":command,"params":{"sourceId":"fixture","operation":"save","expectedRevision":"initial","apiKey":"synthetic-private-key","provider":{"name":"fixture","baseUrl":"https://example.invalid","protocol":"responses","models":[]}}});
        let first = backend_command(&host, "local", &request).await.unwrap();
        assert_eq!(first["submissionUnknown"], true);
        assert_eq!(backend_command(&host, "local", &request).await.unwrap(), first);
        assert_eq!(std::fs::read_to_string(root.path().join("effects")).unwrap(), "once\n");
        let mut conflict = request.clone();
        conflict["params"]["apiKey"] = json!("rotated-private-key");
        assert_eq!(backend_command(&host, "local", &conflict).await.unwrap_err().to_string(), "COMMAND_CONFLICT");
        assert_eq!(backend_receipt(&host, "local", &command).unwrap().unwrap()["submissionUnknown"], true);
        let other_method = json!({"method":"worktree.command","commandId":command,"params":{"sourceId":"fixture","operation":"worktreeSettings","worktreeRoot":"/isolated","branchPrefix":"fixture"}});
        assert_eq!(backend_command(&host, "local", &other_method).await.unwrap_err().to_string(), "COMMAND_CONFLICT");
        let scope = format!("workbench-{}", areal_local_service::storage::digest(b"local"));
        let (_, snapshot) = host.journal.native_snapshot(&scope).unwrap();
        assert_eq!(snapshot["pending"][0]["params"], json!({}));
        assert!(!snapshot.to_string().contains("synthetic-private-key"));
        host.gateway.workbench.stop_backend().await;
    }).await;
}

fn layout(root: &Path) -> (PathBuf, PathBuf, PathBuf) {
    let contents = root.join("Contents/Resources");
    let bin = contents.join("areal-core/bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(bin.join("areal"), b"").unwrap();
    std::fs::write(contents.join("app.asar"), b"fixture").unwrap();
    std::fs::create_dir_all(root.join("profile")).unwrap();
    std::fs::create_dir_all(root.join("profile/areal-core")).unwrap();
    std::fs::create_dir_all(root.join("host")).unwrap();
    (bin, root.join("profile"), root.join("host"))
}

fn options(root: &Path, bin: &Path) -> Value {
    json!({
        "binary": bin.join("areal"),
        "home": root.join("profile/areal-core"),
        "guiProfile": root.join("profile"),
        "hostHome": root.join("host"),
    })
}

fn code(result: Result<(String, Launch)>) -> String {
    let error = result.err().unwrap();
    error
        .downcast_ref::<crate::wire::Error>()
        .map(|error| error.code.to_owned())
        .unwrap_or_else(|| error.to_string())
}

#[test]
fn backend_launch_only_accepts_the_gui_profile_and_the_host_core() {
    let root = tempfile::tempdir().unwrap();
    let (bin, profile, host_home) = layout(root.path());
    let accepted = launch_at(
        &bin,
        &host_home,
        Ensure {
            profile: profile.clone(),
            options: options(root.path(), &bin),
        },
    )
    .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&accepted.0).unwrap(),
        options(root.path(), &bin)
    );
    assert_eq!(
        accepted.1.app_root,
        root.path()
            .join("Contents/Resources/app.asar")
            .canonicalize()
            .unwrap()
    );

    let mut other_core = options(root.path(), &bin);
    other_core["binary"] = json!(root.path().join("other/bin/areal"));
    std::fs::create_dir_all(root.path().join("other/bin")).unwrap();
    std::fs::write(root.path().join("other/bin/areal"), b"").unwrap();
    assert_eq!(
        code(launch_at(
            &bin,
            &host_home,
            Ensure {
                profile: profile.clone(),
                options: other_core,
            },
        )),
        "invalidRequest"
    );

    let mut other_host = options(root.path(), &bin);
    other_host["hostHome"] = json!(root.path().join("profile"));
    assert_eq!(
        code(launch_at(
            &bin,
            &host_home,
            Ensure {
                profile,
                options: other_host,
            },
        )),
        "invalidRequest"
    );
}

#[test]
fn manage_operations_that_admit_or_stop_work_need_their_own_capability() {
    let capability = |params: Value| manage_capability("manage.command", &params);
    for operation in ["taskRunNow", "taskResumeRun"] {
        assert_eq!(capability(json!({"operation":operation})), Some("submit"));
        let mut params = json!({"sourceId":"source","projectId":"project",
            "operation":operation,"taskId":"task","expectedRevision":2});
        if operation == "taskResumeRun" {
            params["expectedRunId"] = json!("run");
            let missing_guard = params
                .as_object_mut()
                .unwrap()
                .remove("expectedRunId")
                .unwrap();
            assert!(
                serde_json::from_value::<areal_protocol::host::WorkbenchManageCommandParams>(
                    params.clone()
                )
                .is_err()
            );
            params["expectedRunId"] = missing_guard;
        }
        assert!(
            serde_json::from_value::<areal_protocol::host::WorkbenchManageCommandParams>(params)
                .is_ok()
        );
    }
    assert!(
        validate_backend_result(
            "manage.command",
            &json!({
                "accepted":true,"taskId":"task","runId":"run","revision":3
            })
        )
        .is_ok()
    );
    for operation in MANAGE_SUBMIT_OPERATIONS {
        assert_eq!(
            capability(json!({"operation":operation})),
            Some("submit"),
            "{operation}"
        );
    }
    for operation in MANAGE_INTERRUPT_OPERATIONS {
        assert_eq!(
            capability(json!({"operation":operation})),
            Some("interrupt"),
            "{operation}"
        );
    }
    // 只读、目录、插件与配置管理不额外索取提交或中断能力。
    for operation in [
        "pluginComponentConfigure",
        "pluginHooksConfigure",
        "taskPause",
        "planUpdate",
        "serverDrain",
    ] {
        assert_eq!(
            capability(json!({"operation":operation})),
            None,
            "{operation}"
        );
    }
    assert_eq!(
        manage_capability("manage.read", &json!({"operation":"processStart"})),
        None
    );
    assert_eq!(manage_capability("manage.command", &json!({})), None);
    assert_eq!(
        manage_capability("tasks.read", &json!({"operation":"processStart"})),
        None
    );
}

#[test]
fn backend_status_is_not_routed_to_external_clients() {
    assert!(!METHODS.contains(&"backend.ensure") && !METHODS.contains(&"backend.status"));
    assert!(!CORE_METHODS.contains(&"backend.ensure"));
}
