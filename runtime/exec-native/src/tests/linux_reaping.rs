use super::*;
use std::path::PathBuf;

#[tokio::test]
async fn reaper_does_not_pass_unrelated_inherited_descriptors_to_payload() {
    use std::os::fd::AsRawFd;
    let unrelated = tempfile::tempfile().unwrap();
    let descriptor = unrelated.as_raw_fd();
    let argv = vec![
        "/bin/sh".into(),
        "-c".into(),
        format!("test ! -e /proc/self/fd/{descriptor}"),
    ];
    let (mut command, mut reaper) = crate::linux_reaper::prepare(&argv, false, None).unwrap();
    unsafe {
        command.pre_exec(move || {
            if libc::fcntl(descriptor, libc::F_SETFD, 0) < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn().unwrap();
    reaper.spawned();
    drop(command);
    tokio::time::timeout(Duration::from_secs(3), async {
        reaper.started(&mut child).await.unwrap();
        assert!(reaper.finish(&mut child).await.unwrap().success());
    })
    .await
    .unwrap();
}

const DETACHED_TREE: &str = r#"
import os, pathlib, sys, time

def record(name):
    pid = os.getpid()
    ticks = pathlib.Path('/proc/%d/stat' % pid).read_text().rsplit(')', 1)[1].split()[19]
    path = pathlib.Path(name + '.pid')
    temporary = path.with_suffix('.tmp')
    temporary.write_text('%d %s' % (pid, ticks))
    temporary.replace(path)

record('leader')
middle = os.fork()
if middle == 0:
    os.setsid()
    record('middle')
    if os.fork() != 0:
        os._exit(0)
    record('detached')
    for fd in (0, 1, 2):
        os.close(fd)
    while True:
        with open('ticks', 'a') as output:
            output.write('.')
        if len(sys.argv) > 2 and sys.argv[2] == 'exit-descendant':
            while not pathlib.Path('ready').exists():
                time.sleep(.005)
            os._exit(0)
        time.sleep(.02)
os.waitpid(middle, 0)
deadline = time.monotonic() + 3
while not pathlib.Path('ticks').exists():
    assert time.monotonic() < deadline
    time.sleep(.01)
pathlib.Path('ready').write_text('ready')
print('ready', flush=True)
if sys.argv[1] == 'exit':
    sys.exit(23)
while True:
    time.sleep(1)
"#;

struct TreeFixture {
    directory: tempfile::TempDir,
}

impl TreeFixture {
    fn new() -> Self {
        Self {
            directory: tempfile::tempdir().unwrap(),
        }
    }

    fn root(&self) -> PathBuf {
        self.directory.path().canonicalize().unwrap()
    }

    fn execution(&self, id: &str, exit: bool) -> Execution {
        let mut exec = unrestricted(&self.root(), id, "");
        exec.argv = vec![
            "/usr/bin/python3".into(),
            "-I".into(),
            "-S".into(),
            "-c".into(),
            DETACHED_TREE.into(),
            if exit { "exit" } else { "wait" }.into(),
        ];
        exec
    }

    fn identities(&self) -> Vec<(i32, String)> {
        ["detached", "middle", "leader"]
            .into_iter()
            .filter_map(|name| {
                let text =
                    std::fs::read_to_string(self.directory.path().join(format!("{name}.pid")))
                        .ok()?;
                let (pid, ticks) = text.split_once(' ')?;
                Some((pid.parse().ok()?, ticks.to_owned()))
            })
            .collect()
    }

    async fn ready(&self) {
        tokio::time::timeout(Duration::from_secs(4), async {
            while !self.directory.path().join("ready").exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("detached fixture did not become ready");
        assert_eq!(self.identities().len(), 3);
    }

    fn assert_reaped(&self) {
        let identities = self.identities();
        assert_eq!(identities.len(), 3);
        // 只检查停止写文件会把 zombie 误当作已清理；这里要求 /proc 条目消失。
        for (pid, _) in identities {
            assert!(
                !Path::new(&format!("/proc/{pid}")).exists(),
                "process {pid} remains after execution completion: {:?}",
                std::fs::read_to_string(format!("/proc/{pid}/stat"))
            );
        }
    }

    async fn wait_reaped(&self) {
        let identities = self.identities();
        assert_eq!(identities.len(), 3);
        tokio::time::timeout(Duration::from_secs(5), async {
            while identities
                .iter()
                .any(|(pid, _)| Path::new(&format!("/proc/{pid}")).exists())
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("abandoned execution left live or zombie descendants");
        self.assert_reaped();
    }

    async fn assert_running(&self) {
        let leader = std::fs::read_to_string(self.directory.path().join("leader.pid")).unwrap();
        let (pid, ticks) = leader.split_once(' ').unwrap();
        assert_eq!(start_ticks(pid.parse().unwrap()).as_deref(), Some(ticks));
        let ticks_path = self.directory.path().join("ticks");
        let before = std::fs::metadata(&ticks_path).unwrap().len();
        tokio::time::timeout(Duration::from_secs(2), async {
            while std::fs::metadata(&ticks_path).unwrap().len() == before {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("terminating another execution stopped this descendant");
    }
}

impl Drop for TreeFixture {
    fn drop(&mut self) {
        // 失败路径也仅清理本夹具记录且 startTicks 未变的 PID，先后代再 leader。
        // 正常路径已经完全回收，此处不应再发任何信号。
        for (pid, ticks) in self.identities() {
            if start_ticks(pid).as_deref() == Some(ticks.as_str()) {
                // SAFETY: PID 来自本测试夹具并已核对创建时间，不使用进程名或通配组。
                unsafe {
                    libc::kill(pid, libc::SIGKILL);
                    libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG);
                }
            }
        }
    }
}

fn start_ticks(pid: i32) -> Option<String> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    Some(
        stat.rsplit_once(')')?
            .1
            .split_whitespace()
            .nth(19)?
            .to_owned(),
    )
}

fn unrestricted(root: &Path, id: &str, code: &str) -> Execution {
    let mut exec = execution(root, code);
    exec.process_id = id.into();
    exec.scope_access = ScopeAccess::Unrestricted;
    exec
}

async fn full_access() -> NativeBackend {
    NativeBackend::launch_with_profile(SandboxProfile::FullAccess)
        .await
        .unwrap()
}

async fn completion(rx: &mut mpsc::Receiver<Event>) -> (Vec<u8>, Option<i32>, Option<i32>) {
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut output = Vec::new();
        let mut status = None;
        while let Some(event) = rx.recv().await {
            match event {
                Event::Output(_, bytes) => {
                    assert!(status.is_none());
                    output.extend(bytes);
                }
                Event::Exited {
                    exit_code, signal, ..
                } => {
                    assert!(status.replace((exit_code, signal)).is_none());
                }
                Event::Closed => {
                    let (exit_code, signal) = status.expect("exit precedes closed");
                    return (output, exit_code, signal);
                }
            }
        }
        panic!("execution closed without cleanup acknowledgement");
    })
    .await
    .expect("execution did not finish and reap within five seconds")
}

#[tokio::test]
async fn full_access_leader_exit_reaps_detached_grandchildren() {
    let backend = full_access().await;
    let fixture = TreeFixture::new();
    let mut rx = backend
        .start(fixture.execution("exit-tree", true))
        .await
        .unwrap();
    fixture.ready().await;
    let (_, code, signal) = completion(&mut rx).await;
    assert_eq!((code, signal), (Some(23), None));
    fixture.assert_reaped();
    backend.shutdown().await.unwrap();
}

#[tokio::test]
async fn full_access_cancel_and_shutdown_reap_detached_grandchildren() {
    for shutdown in [false, true] {
        let backend = full_access().await;
        let fixture = TreeFixture::new();
        let mut rx = backend
            .start(fixture.execution("cancel-tree", false))
            .await
            .unwrap();
        fixture.ready().await;
        tokio::time::timeout(Duration::from_secs(5), async {
            if shutdown {
                backend.shutdown().await.unwrap();
            } else {
                backend.terminate("cancel-tree").await.unwrap();
            }
        })
        .await
        .expect("cancellation did not drain its descendants");
        completion(&mut rx).await;
        fixture.assert_reaped();
        backend.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn repeated_parallel_executions_do_not_reap_each_others_children() {
    let backend = full_access().await;
    for round in 0..3 {
        let first = TreeFixture::new();
        let second = TreeFixture::new();
        let first_id = format!("first-{round}");
        let second_id = format!("second-{round}");
        let mut first_rx = backend
            .start(first.execution(&first_id, false))
            .await
            .unwrap();
        let mut second_rx = backend
            .start(second.execution(&second_id, false))
            .await
            .unwrap();
        first.ready().await;
        second.ready().await;
        tokio::time::timeout(Duration::from_secs(5), backend.terminate(&first_id))
            .await
            .expect("first execution cancellation timed out")
            .unwrap();
        completion(&mut first_rx).await;
        first.assert_reaped();
        second.assert_running().await;
        tokio::time::timeout(Duration::from_secs(5), backend.terminate(&second_id))
            .await
            .expect("second execution cancellation timed out")
            .unwrap();
        completion(&mut second_rx).await;
        second.assert_reaped();
    }
    backend.shutdown().await.unwrap();
}

#[tokio::test]
async fn full_access_preserves_exit_signal_pipe_and_controlling_terminal() {
    let backend = full_access().await;
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    for (id, command, expected) in [
        ("exit-code", "exit 37", (Some(37), None)),
        ("signal", "kill -TERM $$", (None, Some(libc::SIGTERM))),
    ] {
        let mut rx = backend
            .start(unrestricted(&root, id, command))
            .await
            .unwrap();
        let (_, code, signal) = completion(&mut rx).await;
        assert_eq!((code, signal), expected);
    }
    for tty in [false, true] {
        let id = if tty { "pty" } else { "pipe" };
        let code = if tty {
            "test -t 0 && test -t 1 && test -t 2 || exit 7; printf '' >/dev/tty || exit 8; read -r line; printf 'received:%s' \"$line\""
        } else {
            "read -r line; printf 'received:%s' \"$line\"; printf ':stderr' >&2"
        };
        let mut exec = unrestricted(&root, id, code);
        exec.tty = tty;
        exec.pipe_stdin = !tty;
        let mut rx = backend.start(exec).await.unwrap();
        backend.write(id, "input", b"hello\n").await.unwrap();
        let (output, code, signal) = completion(&mut rx).await;
        assert_eq!((code, signal), (Some(0), None));
        let output = String::from_utf8(output).unwrap();
        assert!(output.contains("received:hello"), "{output}");
        assert!(tty || output.contains(":stderr"), "{output}");
    }
    backend.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn startup_failure_keeps_parallel_execution_and_backend_usable() {
    let backend = full_access().await;
    let fixture = TreeFixture::new();
    let mut running = backend
        .start(fixture.execution("running", false))
        .await
        .unwrap();
    fixture.ready().await;

    for _ in 0..4 {
        let mut missing = unrestricted(&fixture.root(), "missing", "");
        missing.argv = vec![fixture.root().join("does-not-exist").display().to_string()];
        let error = match tokio::time::timeout(Duration::from_secs(5), backend.start(missing))
            .await
            .expect("startup failure was not reported")
        {
            Err(error) => error,
            Ok(_) => panic!("missing executable was admitted as a successful start"),
        };
        assert_eq!(
            error.code,
            areal_runtime_protocol::ErrorCode::InvalidArgument
        );

        // 错误回执后立即复用同一 ID，中间不等待，覆盖 ack 先于移除登记的竞态。
        let mut retried = backend
            .start(unrestricted(&fixture.root(), "missing", "exit 19"))
            .await
            .unwrap();
        let (_, code, signal) = completion(&mut retried).await;
        assert_eq!((code, signal), (Some(19), None));
        fixture.assert_running().await;
    }
    tokio::time::timeout(Duration::from_secs(5), backend.terminate("running"))
        .await
        .expect("parallel execution did not stop")
        .unwrap();
    completion(&mut running).await;
    fixture.assert_reaped();
    backend.shutdown().await.unwrap();
}

#[tokio::test]
async fn adopted_exited_descendant_is_reaped_while_leader_keeps_running() {
    let backend = full_access().await;
    let fixture = TreeFixture::new();
    let mut exec = fixture.execution("long-lived-leader", false);
    exec.argv.push("exit-descendant".into());
    let mut rx = backend.start(exec).await.unwrap();
    fixture.ready().await;

    let identities = fixture.identities();
    let (descendant, _) = &identities[0];
    tokio::time::timeout(Duration::from_secs(3), async {
        while Path::new(&format!("/proc/{descendant}")).exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("adopted zombie was retained until leader exit");

    let (leader, ticks) = &identities[2];
    assert_eq!(start_ticks(*leader).as_deref(), Some(ticks.as_str()));
    let stat = std::fs::read_to_string(format!("/proc/{leader}/stat")).unwrap();
    assert_ne!(
        stat.rsplit_once(')').unwrap().1.split_whitespace().next(),
        Some("Z"),
        "leader exited before the adopted child was checked"
    );
    tokio::time::timeout(
        Duration::from_secs(5),
        backend.terminate("long-lived-leader"),
    )
    .await
    .expect("long-lived leader did not stop")
    .unwrap();
    completion(&mut rx).await;
    fixture.assert_reaped();
    backend.shutdown().await.unwrap();
}

#[tokio::test]
async fn backend_and_receiver_drop_reap_detached_descendants() {
    for drop_receiver in [false, true] {
        let backend = full_access().await;
        let fixture = TreeFixture::new();
        let mut rx = backend
            .start(fixture.execution("abandoned", false))
            .await
            .unwrap();
        fixture.ready().await;
        if drop_receiver {
            drop(rx);
            fixture.wait_reaped().await;
            // 丢失输出消费者可以使 backend fail closed，但仍必须完成回收。
            let _ = tokio::time::timeout(Duration::from_secs(5), backend.shutdown())
                .await
                .expect("receiver drop prevented shutdown from settling");
        } else {
            drop(backend);
            completion(&mut rx).await;
            fixture.assert_reaped();
        }
    }
}

#[tokio::test]
async fn dropping_reaper_owner_closes_lifetime_and_reaps_descendants() {
    let fixture = TreeFixture::new();
    let exec = fixture.execution("owner-drop", false);
    let (mut command, mut reaper) = crate::linux_reaper::prepare(&exec.argv, false, None).unwrap();
    command
        .current_dir(fixture.root())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = command.spawn().unwrap();
    reaper.spawned();
    drop(command);
    reaper.started(&mut child).await.unwrap();
    fixture.ready().await;

    // 不调用 terminate：模拟 Runtime owner 消失后，由控制管道 EOF 自行清理。
    drop(reaper);
    let status = tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .expect("reaper did not finish after owner disappeared")
        .unwrap();
    assert!(status.success(), "{status}");
    fixture.assert_reaped();
}
