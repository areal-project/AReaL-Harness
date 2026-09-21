//! Runtime-owned Unix process execution. No external agent or RPC executor.
mod pty;
mod sandbox;
pub use sandbox::Profile as SandboxProfile;

use areal_runtime_protocol::{Error, ErrorCode, OutputStream, Result};
use areal_runtime_supervisor::backend::{Backend, Event, Execution};
use async_trait::async_trait;
use std::{
    collections::HashMap,
    io,
    os::unix::process::ExitStatusExt,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    process::{Child, Command},
    sync::{mpsc, watch},
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;

const IO_TIMEOUT: Duration = Duration::from_secs(1);
type Input = Box<dyn AsyncWrite + Unpin + Send>;
struct Process {
    stop: CancellationToken,
    input: tokio::sync::Mutex<Option<Input>>,
    terminal: Option<pty::Master>,
    done: watch::Sender<Option<Result<()>>>,
}
#[derive(Default)]
struct State {
    closed: bool,
    processes: HashMap<String, Arc<Process>>,
    failure: Option<Error>,
}
pub struct NativeBackend {
    profile: SandboxProfile,
    state: Arc<Mutex<State>>,
    stop: CancellationToken,
}
impl NativeBackend {
    pub async fn launch_with_profile(profile: SandboxProfile) -> Result<Self> {
        sandbox::supported(profile)?;
        let program = match profile {
            SandboxProfile::Native => "/usr/bin/sandbox-exec",
            SandboxProfile::OuterContainerPerf => "/usr/bin/bwrap",
        };
        if !std::path::Path::new(program).is_file() {
            return Err(Error::new(
                ErrorCode::Unsupported,
                format!("sandbox executable missing: {program}"),
            ));
        }
        Ok(Self {
            profile,
            state: Arc::new(Mutex::new(State::default())),
            stop: CancellationToken::new(),
        })
    }
}
impl Drop for NativeBackend {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

#[async_trait]
impl Backend for NativeBackend {
    fn sandbox_profile(&self) -> &'static str {
        self.profile.name()
    }
    fn supports_input(&self) -> bool {
        true
    }
    async fn start(&self, execution: Execution) -> Result<mpsc::Receiver<Event>> {
        let argv = sandbox::command(&execution, self.profile)?;
        // Locally linked Mach-O helpers can be killed by AMFI when their
        // spawning parent is a Rust development binary. A signed system parent
        // launches the unchanged sandbox command. It shares our process group
        // and pipes, waits for its child, and preserves signal exit facts.
        // Isolated Python cannot import code from the writable working directory.
        #[cfg(target_os = "macos")]
        let mut command = if execution.trusted_executable.is_some() {
            let mut command = Command::new("/usr/bin/python3");
            command.args(["-I", "-S", "-c", "import os,signal,subprocess,sys; r=subprocess.run(sys.argv[1:]).returncode; signal.signal(-r,signal.SIG_DFL) if r<0 and -r not in (signal.SIGKILL,signal.SIGSTOP) else None; os.kill(os.getpid(),-r) if r<0 else None; sys.exit(r)"]);
            command.arg(&argv[0]);
            command
        } else {
            Command::new(&argv[0])
        };
        #[cfg(not(target_os = "macos"))]
        let mut command = Command::new(&argv[0]);
        let _filter = sandbox::seccomp(&mut command, self.profile, execution.network)?;
        command
            .args(&argv[1..])
            .current_dir(&execution.cwd)
            .env_clear()
            .envs(&execution.env)
            .kill_on_drop(true);
        // No await between admission, spawn and ownership handoff. Shutdown
        // cannot miss a child even if the caller drops its start future.
        let mut state = self.state.lock().unwrap();
        if state.closed || self.stop.is_cancelled() {
            return Err(Error::new(ErrorCode::ScopeClosed, "backend is closed"));
        }
        if state.processes.contains_key(&execution.process_id) {
            return Err(Error::new(ErrorCode::Conflict, "process already exists"));
        }
        let mut input: Option<Input> = None;
        let mut terminal = None;
        let mut outputs: Vec<(OutputStream, Box<dyn AsyncRead + Unpin + Send>)> = Vec::new();
        if execution.tty {
            let (master, slave) = pty::open().map_err(spawn_error)?;
            command
                .stdin(slave.try_clone().map_err(spawn_error)?)
                .stdout(slave.try_clone().map_err(spawn_error)?)
                .stderr(slave);
            // SAFETY: only async-signal-safe syscalls run between fork and exec.
            unsafe {
                command.pre_exec(|| {
                    if libc::setsid() < 0 || libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                        return Err(io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            terminal = Some(master.clone());
            input = Some(Box::new(master.clone()));
            outputs.push((OutputStream::Pty, Box::new(master)));
        } else {
            if cfg!(target_os = "linux") {
                // Own the session at the bwrap launcher, before it forks its
                // namespace init. Both stay in our group, so cancellation also
                // covers the interval before init installs its PDEATHSIG.
                // A new session prevents access to the caller's controlling tty.
                // SAFETY: setsid is async-signal-safe between fork and exec.
                unsafe {
                    command.pre_exec(|| {
                        if libc::setsid() < 0 {
                            return Err(io::Error::last_os_error());
                        }
                        Ok(())
                    });
                }
            } else {
                command.process_group(0);
            }
            command
                .stdin(if execution.pipe_stdin {
                    Stdio::piped()
                } else {
                    Stdio::null()
                })
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
        }
        let mut child = command.spawn().map_err(spawn_error)?;
        // Command retains configured PTY slave descriptors until dropped.
        drop(command);
        if !execution.tty {
            input = child.stdin.take().map(|stdin| Box::new(stdin) as Input);
            outputs.push((OutputStream::Stdout, Box::new(child.stdout.take().unwrap())));
            outputs.push((OutputStream::Stderr, Box::new(child.stderr.take().unwrap())));
        }
        let process = Arc::new(Process {
            stop: self.stop.child_token(),
            input: tokio::sync::Mutex::new(input),
            terminal,
            done: watch::channel(None).0,
        });
        state
            .processes
            .insert(execution.process_id.clone(), process.clone());
        let state = self.state.clone();
        let stop = self.stop.clone();
        let (tx, rx) = mpsc::channel(128);
        tokio::spawn(async move {
            let result = monitor(child, &process, outputs, tx).await;
            let mut state = state.lock().unwrap();
            if let Err(error) = &result {
                state.closed = true;
                stop.cancel();
                state.failure.get_or_insert_with(|| error.clone());
            }
            process.done.send_replace(Some(result));
            state.processes.remove(&execution.process_id);
        });
        Ok(rx)
    }
    async fn write(&self, process_id: &str, _write_id: &str, bytes: &[u8]) -> Result<()> {
        let process = self
            .state
            .lock()
            .unwrap()
            .processes
            .get(process_id)
            .cloned()
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "process has exited"))?;
        tokio::select! {
            _ = process.stop.cancelled() => Err(unavailable("process input was closed")),
            result = async {
                let mut input = process.input.lock().await;
                let input = input.as_mut().ok_or_else(|| Error::new(ErrorCode::Unsupported, "process has no input pipe"))?;
                input.write_all(bytes).await.map_err(|e| unavailable(&format!("process input failed: {e}")))
            } => result,
        }
    }
    fn supports_terminal_control(&self) -> bool {
        true
    }
    async fn resize(&self, process_id: &str, cols: u16, rows: u16) -> Result<()> {
        let process = self
            .state
            .lock()
            .unwrap()
            .processes
            .get(process_id)
            .cloned()
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "process has exited"))?;
        let _input = process.input.lock().await;
        process
            .terminal
            .as_ref()
            .ok_or_else(|| Error::new(ErrorCode::Unsupported, "process is not a PTY"))?
            .resize(cols, rows)
            .map_err(spawn_error)
    }
    async fn close_stdin(&self, process_id: &str) -> Result<()> {
        let process = self
            .state
            .lock()
            .unwrap()
            .processes
            .get(process_id)
            .cloned()
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "process has exited"))?;
        let mut input = process.input.lock().await;
        if let Some(terminal) = &process.terminal {
            let eof = terminal
                .eof_character()
                .map_err(|e| Error::new(ErrorCode::Unsupported, e.to_string()))?;
            if let Some(input) = input.as_mut() {
                input
                    .write_all(&[eof])
                    .await
                    .map_err(|e| unavailable(&e.to_string()))?;
            }
        }
        // 丢弃 ChildStdin 才会向 pipe 发送真实 EOF；PTY 使用终端配置的 VEOF。
        input.take();
        Ok(())
    }
    async fn terminate(&self, process_id: &str) -> Result<()> {
        if let Some(process) = self.state.lock().unwrap().processes.get(process_id) {
            process.stop.cancel();
        }
        Ok(())
    }
    async fn shutdown(&self) -> Result<()> {
        let processes: Vec<_> = {
            let mut state = self.state.lock().unwrap();
            state.closed = true;
            self.stop.cancel();
            state.processes.values().cloned().collect()
        };
        let result = tokio::time::timeout(Duration::from_secs(3), async {
            let mut failure = None;
            for process in processes {
                let mut done = process.done.subscribe();
                loop {
                    if let Some(result) = done.borrow_and_update().clone() {
                        if let Err(error) = result {
                            failure.get_or_insert(error);
                        }
                        break;
                    }
                    if done.changed().await.is_err() {
                        failure.get_or_insert_with(|| cleanup_error("process cleanup lost"));
                        break;
                    }
                }
            }
            // One failed process must not skip waiting for the other owned
            // children. Preserve the failure after every cleanup has settled.
            failure.map_or(Ok(()), Err)
        })
        .await
        .map_err(|_| cleanup_error("process cleanup deadline exceeded"))?;
        result?;
        self.state
            .lock()
            .unwrap()
            .failure
            .clone()
            .map_or(Ok(()), Err)
    }
}

// Killing a process group covers ordinary descendants. Detached sessions are
// not claimed as verified process-tree cleanup by the public capabilities.
struct Group {
    pid: i32,
    signalled: bool,
}
impl Group {
    fn kill(&mut self) -> io::Result<()> {
        if self.signalled {
            return Ok(());
        }
        if unsafe { libc::kill(-self.pid, libc::SIGKILL) } < 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(error);
            }
        }
        self.signalled = true;
        Ok(())
    }
}
impl Drop for Group {
    fn drop(&mut self) {
        let _ = self.kill();
    }
}

async fn monitor(
    mut child: Child,
    process: &Process,
    outputs: Vec<(OutputStream, Box<dyn AsyncRead + Unpin + Send>)>,
    tx: mpsc::Sender<Event>,
) -> Result<()> {
    let mut group = Group {
        pid: child.id().expect("spawned child has pid") as i32,
        signalled: false,
    };
    let mut readers = JoinSet::new();
    for (stream, mut reader) in outputs {
        let tx = tx.clone();
        let stop = process.stop.clone();
        readers.spawn(async move {
            let result = async {
                let mut bytes = vec![0; 8192];
                loop {
                    let count = reader
                        .read(&mut bytes)
                        .await
                        .map_err(|e| cleanup_error(&format!("output read failed: {e}")))?;
                    if count == 0 {
                        return Ok(());
                    }
                    send(&tx, Event::Output(stream, bytes[..count].to_vec())).await?;
                }
            }
            .await;
            if result.is_err() {
                stop.cancel();
            }
            result
        });
    }
    let status = tokio::select! {
        status = child.wait() => Some(status),
        _ = process.stop.cancelled() => None,
        _ = tx.closed() => None,
    };
    let status = match status {
        Some(status) => status,
        None => match group.kill() {
            Ok(()) => child.wait().await,
            // macOS can reject a signal to an already-exiting group. Accept
            // this only if wait confirms that our leader has actually exited;
            // output EOF is still required below before reporting Closed.
            Err(error) if exited_group_error(&error) => {
                // Signal permission and waitability can change in separate
                // kernel steps. Wait for actual exit, with a bounded deadline.
                let status = tokio::time::timeout(IO_TIMEOUT, child.wait())
                    .await
                    .map_err(|_| cleanup_error(&format!("group termination failed: {error}")))?;
                group.signalled = true;
                status
            }
            Err(error) => return Err(cleanup_error(&format!("group termination failed: {error}"))),
        },
    }
    .map_err(|e| cleanup_error(&format!("wait failed: {e}")))?;
    // Close descendants' inherited pipes before reporting completion. A reaped
    // leader plus stream EOF is the managed-process guarantee, not a claim of
    // complete descendant-tree cleanup.
    if let Err(error) = group.kill() {
        if exited_group_error(&error) {
            group.signalled = true;
        } else {
            return Err(cleanup_error(&format!("group cleanup failed: {error}")));
        }
    }
    process.stop.cancel();
    process.input.lock().await.take();
    tokio::time::timeout(IO_TIMEOUT, async {
        while let Some(result) = readers.join_next().await {
            result.map_err(|e| cleanup_error(&format!("output task failed: {e}")))??;
        }
        Ok::<_, Error>(())
    })
    .await
    .map_err(|_| cleanup_error("output did not close after process exit"))??;
    send(
        &tx,
        Event::Exited {
            exit_code: status.code(),
            signal: status.signal(),
            sandbox_denied: false,
        },
    )
    .await?;
    send(&tx, Event::Closed).await
}
fn exited_group_error(error: &io::Error) -> bool {
    cfg!(target_os = "macos") && error.raw_os_error() == Some(libc::EPERM)
}

async fn send(tx: &mpsc::Sender<Event>, event: Event) -> Result<()> {
    tokio::time::timeout(IO_TIMEOUT, tx.send(event))
        .await
        .map_err(|_| cleanup_error("process output consumer stalled"))?
        .map_err(|_| cleanup_error("process output consumer closed"))
}
fn spawn_error(error: io::Error) -> Error {
    Error::new(
        ErrorCode::InvalidArgument,
        format!("cannot start sandboxed process: {error}"),
    )
}
fn unavailable(message: &str) -> Error {
    Error::new(ErrorCode::Unavailable, message)
}
fn cleanup_error(message: &str) -> Error {
    Error::new(ErrorCode::CleanupFailed, message)
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests;
