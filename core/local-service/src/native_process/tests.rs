use super::*;
use std::process::Stdio;
use tokio::io::AsyncWriteExt;

fn python() -> &'static Path {
    Path::new("/usr/bin/python3")
}

async fn gone(pid: u32) {
    gone_within(pid, Duration::from_secs(5)).await;
}

async fn gone_within(pid: u32, limit: Duration) {
    tokio::time::timeout(limit, async {
        while unsafe { libc::kill(pid as i32, 0) } == 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("actual child was not reaped");
}

#[tokio::test]
async fn explicit_descriptors_stdin_argv_and_actual_pid_are_preserved() {
    let (mut report, output) = UnixStream::pair().unwrap();
    report
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let (_unused, excluded) = UnixStream::pair().unwrap();
    let fd = output.as_raw_fd();
    let forbidden = excluded.as_raw_fd();
    // 即使调用方误留其他 inheritable fd，桥也只把明确允许的描述符转交给 Core。
    unsafe {
        assert_eq!(libc::fcntl(forbidden, libc::F_SETFD, 0), 0);
    }
    let mut command = TrustedCommand::supervised(python(), &[fd]).unwrap();
    command.args(["-I", "-S", "-c", "import json,os,sys\ntry: os.fstat(int(sys.argv[2])); leaked=True\nexcept OSError: leaked=False\nos.write(int(sys.argv[1]),json.dumps({'pid':os.getpid(),'ppid':os.getppid(),'input':sys.stdin.read(),'leaked':leaked,'parent':sys.argv[4]}).encode())"])
        .arg(fd.to_string()).arg(forbidden.to_string()).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null());
    command.parent_pid_arg();
    let mut child = command.spawn().await.unwrap();
    drop(command);
    drop(output);
    let pid = child.id().unwrap();
    let bridge = child.child.id().unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all("配置 JSON".as_bytes())
        .await
        .unwrap();
    assert!(child.wait().await.unwrap().success());
    let mut bytes = Vec::new();
    report.read_to_end(&mut bytes).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["pid"], pid);
    assert_eq!(value["ppid"], bridge);
    assert_eq!(value["parent"], bridge.to_string());
    assert_eq!(value["input"], "配置 JSON");
    assert_eq!(value["leaked"], false);
}

#[tokio::test]
async fn actual_exit_signals_are_returned_and_reaped() {
    for signal in [libc::SIGTERM, libc::SIGKILL] {
        let mut command = TrustedCommand::supervised(python(), &[]).unwrap();
        command
            .args(["-I", "-S", "-c", "import time; time.sleep(60)"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = command.spawn().await.unwrap();
        drop(command);
        let pid = child.id().unwrap();
        assert_eq!(unsafe { libc::kill(pid as i32, signal) }, 0);
        let status = tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(status.signal(), Some(signal));
        gone(pid).await;
    }
}

#[tokio::test]
async fn bridge_death_is_not_a_clean_exit_and_does_not_leave_core_running() {
    let mut command = TrustedCommand::supervised(python(), &[]).unwrap();
    command
        .args(["-I", "-S", "-c", "import time; time.sleep(60)"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = command.spawn().await.unwrap();
    drop(command);
    let pid = child.id().unwrap();
    assert_eq!(
        unsafe { libc::kill(child.child.id().unwrap() as i32, libc::SIGKILL) },
        0
    );
    assert!(
        child
            .wait()
            .await
            .unwrap_err()
            .to_string()
            .contains("without a matching child receipt")
    );
    gone(pid).await;
}

#[tokio::test]
async fn cancellation_during_pid_handshake_cleans_the_entire_unconfirmed_group() {
    unconfirmed_group_cleanup(false).await;
}

#[tokio::test]
async fn bridge_death_before_pid_handshake_cleans_up_after_try_wait_reaps_it() {
    unconfirmed_group_cleanup(true).await;
}

async fn unconfirmed_group_cleanup(kill_bridge: bool) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("pid");
    let mut command = TrustedCommand::supervised(python(), &[]).unwrap();
    // 在 Popen 后、回传 PID 前暂停桥，覆盖实际子进程已经创建的取消窗口。
    let args: Vec<_> = command
        .command
        .as_std()
        .get_args()
        .map(|a| a.to_owned())
        .collect();
    let mut replacement = Command::new("/usr/bin/python3");
    replacement
        .args(&args[..3])
        .arg(BRIDGE.replace(
            "for fd in inherited:",
            "time.sleep(2)\nfor fd in inherited:",
        ))
        .args(&args[4..]);
    replacement
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let control = command._child_control.as_raw_fd();
    unsafe {
        replacement.pre_exec(move || {
            if libc::fcntl(control, libc::F_SETFD, 0) < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    command.command = replacement;
    command.args(["-I", "-S", "-c", "import os,sys,time; from pathlib import Path; Path(sys.argv[1]).write_text(str(os.getpid())+','+str(os.getppid())); time.sleep(60)"]).arg(&path);
    let task = tokio::spawn(async move { command.spawn().await });
    let (pid, bridge) = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(value) = std::fs::read_to_string(&path)
                && let Some((pid, bridge)) = value.split_once(',')
                && let (Ok(pid), Ok(bridge)) = (pid.parse::<u32>(), bridge.parse::<u32>())
            {
                break (pid, bridge);
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    if kill_bridge {
        assert_eq!(unsafe { libc::kill(bridge as i32, libc::SIGKILL) }, 0);
        let outcome = task.await.unwrap();
        assert!(
            matches!(outcome, Err(error) if error.to_string().contains("before PID handshake"))
        );
    } else {
        task.abort();
        assert!(matches!(task.await, Err(error) if error.is_cancelled()));
    }
    gone(pid).await;
}

#[tokio::test]
async fn supervised_owner_death_cleans_up_but_persistent_service_survives() {
    const CASE: &str = "AREAL_TRUSTED_OWNER_CASE";
    if let Ok(mode) = std::env::var(CASE) {
        let path = std::env::var("AREAL_TRUSTED_OWNER_RECORD").unwrap();
        let mut command = if mode == "persistent" {
            TrustedCommand::persistent(python())
        } else {
            TrustedCommand::supervised(python(), &[])
        }
        .unwrap();
        command
            .args(["-I", "-S", "-c", "import time; time.sleep(60)"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let child = command.spawn().await.unwrap();
        std::fs::write(path, child.id().unwrap().to_string()).unwrap();
        // 不能靠 Rust Drop 清理来冒充真实宿主死亡。
        std::process::exit(0);
    }
    let directory = tempfile::tempdir().unwrap();
    for mode in ["supervised", "persistent"] {
        let path = directory.path().join(mode);
        let status = Command::new(python()).args(["-I", "-S", "-c", "import subprocess,sys; sys.exit(subprocess.run(sys.argv[1:]).returncode)"])
            .arg(std::env::current_exe().unwrap()).args(["--exact", "native_process::tests::supervised_owner_death_cleans_up_but_persistent_service_survives", "--nocapture"])
            .env(CASE, mode).env("AREAL_TRUSTED_OWNER_RECORD", &path).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::inherit()).status().await.unwrap();
        assert!(status.success());
        let pid = std::fs::read_to_string(path)
            .unwrap()
            .parse::<u32>()
            .unwrap();
        if mode == "persistent" {
            tokio::time::sleep(Duration::from_millis(150)).await;
            assert_eq!(
                unsafe { libc::kill(pid as i32, 0) },
                0,
                "persistent host was tied to the CLI lifetime"
            );
            assert_eq!(unsafe { libc::kill(pid as i32, libc::SIGTERM) }, 0);
        }
        gone(pid).await;
    }
}

#[tokio::test]
async fn captured_output_drains_both_pipes_closes_stdin_and_preserves_status() {
    let mut command = TrustedCommand::supervised(python(), &[]).unwrap();
    command.args(["-I", "-S", "-c", "import os,sys; assert sys.stdin.read()==''; os.write(1,b'o'*262144); os.write(2,b'e'*262144); sys.exit(7)"]);
    let result = command.output(Duration::from_secs(5)).await.unwrap();
    assert_eq!(result.status.code(), Some(7));
    assert_eq!(result.stdout, vec![b'o'; 262144]);
    assert_eq!(result.stderr, vec![b'e'; 262144]);
}

#[tokio::test]
async fn captured_output_timeout_and_cancellation_reap_the_real_child_and_bridge() {
    for cancel in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("pid");
        let mut command = TrustedCommand::supervised(python(), &[]).unwrap();
        command.args(["-I", "-S", "-c", "import os,sys,time; from pathlib import Path; Path(sys.argv[1]).write_text(str(os.getpid())+','+str(os.getppid())); time.sleep(60)"]).arg(&path);
        let (observer, handshake) = tokio::sync::oneshot::channel();
        command.handshake_observer = Some(observer);
        let task = tokio::spawn(async move { command.output(Duration::from_secs(30)).await });
        let (pid, bridge) = tokio::time::timeout(Duration::from_secs(5), async {
            let acknowledged = handshake.await.unwrap();
            loop {
                if let Ok(value) = std::fs::read_to_string(&path)
                    && let Some((pid, bridge)) = value.split_once(',')
                    && let (Ok(pid), Ok(bridge)) = (pid.parse::<u32>(), bridge.parse::<u32>())
                {
                    assert_eq!(acknowledged, pid);
                    break (pid, bridge);
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        if cancel {
            task.abort();
            assert!(matches!(task.await, Err(error) if error.is_cancelled()));
        } else {
            // 先等待真实子进程就绪，再触发超时；并发冷启动不应耗尽测试的清理窗口。
            tokio::time::pause();
            tokio::time::advance(Duration::from_secs(30)).await;
            tokio::time::resume();
            assert_eq!(
                task.await.unwrap().unwrap_err().kind(),
                io::ErrorKind::TimedOut
            );
        }
        gone(pid).await;
        gone(bridge).await;
    }
}

#[tokio::test]
async fn captured_output_overflow_cleans_up_the_temporary_child() {
    for fd in [1, 2] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("pid");
        let mut command = TrustedCommand::supervised(python(), &[]).unwrap();
        command.args(["-I", "-S", "-c", "import os,sys,time; from pathlib import Path; Path(sys.argv[1]).write_text(str(os.getpid())); os.write(int(sys.argv[2]),b'x'*3145728); time.sleep(60)"]).arg(&path).arg(fd.to_string());
        let error = command.output(Duration::from_secs(5)).await.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("2 MiB"));
        gone(std::fs::read_to_string(path).unwrap().parse().unwrap()).await;
    }
}

#[tokio::test]
async fn cancelling_timeout_cleanup_waiter_still_reaps_a_stopped_bridge() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("pid");
    let mut command = TrustedCommand::supervised(python(), &[]).unwrap();
    let (observer, handshake) = tokio::sync::oneshot::channel();
    command.handshake_observer = Some(observer);
    command.args(["-I", "-S", "-c", "import os,sys,time; from pathlib import Path; Path(sys.argv[1]).write_text(str(os.getpid())+','+str(os.getppid())); time.sleep(60)"]).arg(&path);
    let (pid, bridge) = {
        let output = command.output(Duration::from_secs(30));
        tokio::pin!(output);
        let (pid, bridge) = tokio::select! {
            result = &mut output => panic!("output completed before fixture readiness: {result:?}"),
            ready = tokio::time::timeout(Duration::from_secs(5), async {
                // 子进程写 PID 与桥发送握手可并发；必须先确认 Rust 已消费握手。
                let acknowledged = handshake.await.unwrap();
                loop {
                    if let Ok(value) = std::fs::read_to_string(&path)
                        && let Some((pid, bridge)) = value.split_once(',')
                        && let (Ok(pid), Ok(bridge)) = (pid.parse::<u32>(), bridge.parse::<u32>())
                    {
                        assert_eq!(acknowledged, pid);
                        break (pid, bridge);
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            }) => ready.unwrap(),
        };
        assert_eq!(unsafe { libc::kill(bridge as i32, libc::SIGSTOP) }, 0);
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(30)).await;
        tokio::time::resume();
        // 显式轮询到超时后的清理等待，再销毁 waiter；不靠 sleep 猜测清理已开始。
        assert!(futures_util::poll!(output.as_mut()).is_pending());
        (pid, bridge)
    };
    // 观察期限覆盖已有的两段 5s 清理预算；不用虚拟时钟催促真实 OS 回收。
    gone_within(bridge, Duration::from_secs(10)).await;
    gone(pid).await;
}
