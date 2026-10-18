use super::*;

const TREE: &str = r#"
import os, pathlib, time
deadline = time.monotonic() + 8
def record(name):
    pathlib.Path(name + '.pid').write_text(str(os.getpid()))
def running():
    return time.monotonic() < deadline and not pathlib.Path('stop').exists()
record('leader')
if os.fork() == 0:
    os.setsid()
    record('middle')
    if os.fork() == 0:
        record('detached')
        for fd in (0, 1, 2):
            os.close(fd)
        while running():
            with open('ticks', 'a') as output:
                output.write('.')
            time.sleep(.01)
        os._exit(0)
    while running() and not pathlib.Path('exit').exists():
        time.sleep(.005)
    os._exit(0)
while not pathlib.Path('ticks').exists() and running():
    time.sleep(.005)
print('ready', flush=True)
while running() and not pathlib.Path('exit').exists():
    time.sleep(.005)
os.wait()
os._exit(23)
"#;

struct Fixture(tempfile::TempDir);

impl Fixture {
    fn new() -> Self {
        Self(tempfile::tempdir().unwrap())
    }

    fn root(&self) -> std::path::PathBuf {
        self.0.path().canonicalize().unwrap()
    }

    fn execution(&self, id: &str, profile: SandboxProfile, tty: bool) -> Execution {
        let mut exec = execution(&self.root(), "");
        exec.process_id = id.into();
        exec.tty = tty;
        if matches!(profile, SandboxProfile::FullAccess) {
            exec.scope_access = ScopeAccess::Unrestricted;
        }
        exec.argv = vec![
            "/usr/bin/python3".into(),
            "-I".into(),
            "-S".into(),
            "-c".into(),
            TREE.into(),
        ];
        exec
    }

    async fn ready(&self, receiver: &mut mpsc::Receiver<Event>) {
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(3), receiver.recv())
                .await
                .unwrap(),
            Some(Event::Output(_, _))
        ));
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    async fn assert_stopped(&self) {
        let before = std::fs::metadata(self.root().join("ticks")).unwrap().len();
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert_eq!(
            before,
            std::fs::metadata(self.root().join("ticks")).unwrap().len()
        );
        for name in ["leader", "middle", "detached"] {
            let pid: i32 = std::fs::read_to_string(self.root().join(format!("{name}.pid")))
                .unwrap()
                .parse()
                .unwrap();
            assert_eq!(
                unsafe { libc::kill(pid, 0) },
                -1,
                "{name} {pid} survived cleanup"
            );
            assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::write(self.root().join("stop"), "stop");
    }
}

#[tokio::test]
async fn observed_detached_descendants_stop_on_exit_cancel_and_shutdown() {
    for profile in [SandboxProfile::Native, SandboxProfile::FullAccess] {
        for mode in ["exit", "cancel", "shutdown", "drop"] {
            let fixture = Fixture::new();
            let backend = NativeBackend::launch_with_profile(profile).await.unwrap();
            let mut receiver = backend
                .start(fixture.execution("tree", profile, mode == "cancel"))
                .await
                .unwrap();
            fixture.ready(&mut receiver).await;
            match mode {
                "exit" => std::fs::write(fixture.root().join("exit"), "exit").unwrap(),
                "cancel" => backend.terminate("tree").await.unwrap(),
                "shutdown" => backend.shutdown().await.unwrap(),
                "drop" => {
                    drop(receiver);
                    let _ = backend.shutdown().await;
                    fixture.assert_stopped().await;
                    continue;
                }
                _ => unreachable!(),
            }
            let (_, code) = collect(&mut receiver, &backend).await;
            if mode == "exit" {
                assert_eq!(code, Some(23));
            }
            fixture.assert_stopped().await;
            backend.shutdown().await.unwrap();
        }
    }
}

#[tokio::test]
async fn detached_cleanup_does_not_signal_parallel_execution() {
    let backend = NativeBackend::launch_with_profile(SandboxProfile::FullAccess)
        .await
        .unwrap();
    let first = Fixture::new();
    let second = Fixture::new();
    let mut first_rx = backend
        .start(first.execution("first", SandboxProfile::FullAccess, false))
        .await
        .unwrap();
    let mut second_rx = backend
        .start(second.execution("second", SandboxProfile::FullAccess, false))
        .await
        .unwrap();
    first.ready(&mut first_rx).await;
    second.ready(&mut second_rx).await;
    backend.terminate("first").await.unwrap();
    collect(&mut first_rx, &backend).await;
    first.assert_stopped().await;
    let before = std::fs::metadata(second.root().join("ticks"))
        .unwrap()
        .len();
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert!(
        std::fs::metadata(second.root().join("ticks"))
            .unwrap()
            .len()
            > before
    );
    backend.shutdown().await.unwrap();
    collect(&mut second_rx, &backend).await;
    second.assert_stopped().await;
}
