use super::*;
use std::{collections::BTreeMap, path::Path};

fn test_profile() -> SandboxProfile {
    if cfg!(target_os = "linux") {
        SandboxProfile::OuterContainerPerf
    } else {
        SandboxProfile::Native
    }
}

fn execution(root: &Path, code: &str) -> Execution {
    Execution {
        process_id: "test".into(),
        argv: vec!["/bin/sh".into(), "-c".into(), code.into()],
        cwd: root.into(),
        env: BTreeMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
        read_roots: vec![root.into()],
        write_roots: vec![root.into()],
        trusted_executable: None,
        tty: false,
        pipe_stdin: false,
        network: areal_runtime_protocol::NetworkRequest::Deny,
    }
}
async fn collect(
    rx: &mut mpsc::Receiver<Event>,
    backend: &NativeBackend,
) -> (Vec<u8>, Option<i32>) {
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut output = Vec::new();
        let mut exited = None;
        while let Some(event) = rx.recv().await {
            match event {
                Event::Output(_, bytes) => {
                    assert!(exited.is_none());
                    output.extend(bytes);
                }
                Event::Exited { exit_code, .. } => {
                    assert!(exited.is_none());
                    exited = Some(exit_code);
                }
                Event::Closed => return (output, exited.expect("exit before closed")),
            }
        }
        panic!(
            "missing completion: {:?}",
            backend.state.lock().unwrap().failure
        );
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn signal_exit_preserves_the_actual_termination_reason() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let backend = NativeBackend::launch_with_profile(test_profile())
        .await
        .unwrap();
    let mut rx = backend
        .start(execution(&root, "kill -TERM $$"))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut signalled = false;
        while let Some(event) = rx.recv().await {
            match event {
                Event::Exited {
                    exit_code, signal, ..
                } => {
                    if cfg!(target_os = "linux") {
                        // Bubblewrap 将内部命令的信号终止投影为退出码；保留实际宿主进程事实。
                        assert_eq!(exit_code, Some(128 + libc::SIGTERM));
                        assert_eq!(signal, None);
                    } else {
                        assert_eq!(exit_code, None);
                        assert_eq!(signal, Some(libc::SIGTERM));
                    }
                    signalled = true;
                }
                Event::Closed => {
                    assert!(signalled);
                    return;
                }
                Event::Output(_, _) => {}
            }
        }
        panic!("missing signal exit and cleanup acknowledgement");
    })
    .await
    .unwrap();
    backend.shutdown().await.unwrap();
}

#[tokio::test]
async fn pipe_input_and_output_are_drained_before_completion() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let backend = NativeBackend::launch_with_profile(test_profile())
        .await
        .unwrap();
    let mut exec = execution(
        &root,
        "read -r line; printf '%s' \"$line\"; printf stderr >&2; test -z \"$HOME\"",
    );
    exec.pipe_stdin = true;
    let mut rx = backend.start(exec).await.unwrap();
    backend.write("test", "write", b"hello\n").await.unwrap();
    let (output, code) = collect(&mut rx, &backend).await;
    assert_eq!(code, Some(0));
    let output = String::from_utf8(output).unwrap();
    assert!(output.contains("hello") && output.contains("stderr"));
    backend.shutdown().await.unwrap();
}
#[tokio::test]
async fn pty_has_controlling_terminal_and_accepts_input() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let backend = NativeBackend::launch_with_profile(test_profile())
        .await
        .unwrap();
    let mut exec = execution(
        &root,
        "test -t 0 && test -t 1 && test -t 2 || exit 7; read -r line; printf 'received:%s' \"$line\"",
    );
    exec.tty = true;
    let mut rx = backend.start(exec).await.unwrap();
    backend.write("test", "write", b"hello\n").await.unwrap();
    let (output, code) = collect(&mut rx, &backend).await;
    assert_eq!(code, Some(0), "{}", String::from_utf8_lossy(&output));
    assert!(String::from_utf8_lossy(&output).contains("received:hello"));
    backend.shutdown().await.unwrap();
}
#[tokio::test]
async fn terminate_reaps_process_group_and_shutdown_closes_admission() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let backend = NativeBackend::launch_with_profile(test_profile())
        .await
        .unwrap();
    // Exercise fast leader/descendant exit repeatedly: signalling a successfully
    // killed group twice can race zombie reaping and return EPERM on macOS.
    for index in 0..16 {
        let mut exec = execution(&root, "sleep 60 & printf ready; wait");
        exec.process_id = format!("terminate-{index}");
        let id = exec.process_id.clone();
        let mut rx = backend.start(exec).await.unwrap();
        assert!(matches!(rx.recv().await, Some(Event::Output(_, _))));
        backend.terminate(&id).await.unwrap();
        // The shell may finish wait and exit successfully as the group signal
        // kills its last child. Require confirmed exit/EOF, not a signal code.
        collect(&mut rx, &backend).await;
    }
    backend.shutdown().await.unwrap();
    assert!(backend.start(execution(&root, "true")).await.is_err());
}
#[tokio::test]
async fn stalled_output_fails_closed_and_reaps_child() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let backend = NativeBackend::launch_with_profile(test_profile())
        .await
        .unwrap();
    let mut rx = backend
        .start(execution(&root, "exec /usr/bin/yes"))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(2300)).await;
    assert!(backend.state.lock().unwrap().processes.is_empty());
    let mut closed = false;
    while let Some(event) = rx.recv().await {
        closed |= matches!(event, Event::Closed);
    }
    assert!(!closed);
    assert!(backend.shutdown().await.is_err());
}

#[tokio::test]
async fn caller_arguments_are_data_not_shell_source() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let backend = NativeBackend::launch_with_profile(test_profile())
        .await
        .unwrap();
    let literal = "-p 'quoted' $(touch injected) `touch injected2` ;\n中文";
    let mut exec = execution(&root, "");
    exec.argv = vec!["/usr/bin/printf".into(), "%s".into(), literal.into()];
    let mut rx = backend.start(exec).await.unwrap();
    let (output, code) = collect(&mut rx, &backend).await;
    assert_eq!(code, Some(0));
    assert_eq!(output, literal.as_bytes());
    assert!(!root.join("injected").exists());
    assert!(!root.join("injected2").exists());
    backend.shutdown().await.unwrap();
}

#[tokio::test]
async fn termination_racing_natural_exit_still_confirms_completion() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let backend = NativeBackend::launch_with_profile(test_profile())
        .await
        .unwrap();
    for index in 0..32 {
        let mut exec = execution(&root, "/usr/bin/head -c 9000 /dev/zero");
        exec.process_id = format!("exit-race-{index}");
        let id = exec.process_id.clone();
        let mut rx = backend.start(exec).await.unwrap();
        assert!(matches!(rx.recv().await, Some(Event::Output(_, _))));
        backend.terminate(&id).await.unwrap();
        collect(&mut rx, &backend).await;
    }
    backend.shutdown().await.unwrap();
}

#[tokio::test]
async fn shutdown_waits_for_all_active_children() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let backend = NativeBackend::launch_with_profile(test_profile())
        .await
        .unwrap();
    let mut receivers = Vec::new();
    for index in 0..3 {
        let mut exec = execution(&root, "printf ready; exec /bin/sleep 60");
        exec.process_id = format!("shutdown-{index}");
        let mut rx = backend.start(exec).await.unwrap();
        assert!(matches!(rx.recv().await, Some(Event::Output(_, _))));
        receivers.push(rx);
    }
    backend.shutdown().await.unwrap();
    assert!(backend.state.lock().unwrap().processes.is_empty());
    for mut rx in receivers {
        let (_, code) = collect(&mut rx, &backend).await;
        assert_eq!(code, None);
    }
}

// Linux's private PID namespace is a stronger boundary than a process group.
// Exercise bounded fanout, grandchildren and setsid; this does not claim a
// per-Scope descendant-count or memory limit, nor the same guarantee on macOS.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn namespace_exit_and_cancel_stop_detached_grandchildren() {
    for cancel in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let backend = NativeBackend::launch_with_profile(test_profile())
            .await
            .unwrap();
        let script = r#"
import os, time
from pathlib import Path
for index in range(12):
    if os.fork() == 0:
        os.setsid()
        if os.fork() == 0:
            while True:
                with open('ticks-' + str(index), 'a') as f: f.write('tick\n')
                time.sleep(.02)
        while True: time.sleep(1)
until = time.monotonic() + 3
while len(list(Path('.').glob('ticks-*'))) != 12:
    assert time.monotonic() < until
    time.sleep(.01)
print('ready', flush=True)
if os.environ['WAIT'] == '1':
    while True: time.sleep(1)
"#;
        let mut exec = execution(&root, "");
        exec.argv = vec!["/usr/bin/python3".into(), "-c".into(), script.into()];
        exec.env
            .insert("WAIT".into(), if cancel { "1" } else { "0" }.into());
        let mut rx = backend.start(exec).await.unwrap();
        let first = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .unwrap();
        assert!(matches!(first, Some(Event::Output(_, _))), "{first:?}");
        if cancel {
            backend.terminate("test").await.unwrap();
        }
        collect(&mut rx, &backend).await;
        let sizes = || {
            let mut files: Vec<_> = std::fs::read_dir(&root)
                .unwrap()
                .map(|e| {
                    let e = e.unwrap();
                    (e.file_name(), e.metadata().unwrap().len())
                })
                .collect();
            files.sort();
            files
        };
        let before = sizes();
        assert_eq!(before.len(), 12);
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(
            before,
            sizes(),
            "detached descendants survived namespace cleanup"
        );
        backend.shutdown().await.unwrap();
    }
}
