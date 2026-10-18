//! 可信服务进程的 macOS 启动适配；不用于模型命令或 Runtime 权限决策。
use std::{
    io,
    ops::{Deref, DerefMut},
    os::fd::RawFd,
    path::Path,
    process::{ExitStatus, Output, Stdio},
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child as TokioChild, ChildStdin, Command};

#[cfg(target_os = "macos")]
use std::{
    io::Read,
    os::{fd::AsRawFd, unix::net::UnixStream, unix::process::ExitStatusExt},
};

#[cfg(target_os = "macos")]
const BRIDGE: &str = r#"import os,signal,subprocess,sys,time
control=int(sys.argv[1]); inherited=tuple(int(v) for v in sys.argv[2].split(',') if v)
persistent=sys.argv[3]=='1'; argv=sys.argv[4:]; owner=os.getppid()
for i in range(1,len(argv)):
    if argv[i-1]=='--parent-pid' and argv[i]=='@areal-native-parent@': argv[i]=str(os.getpid())
p=subprocess.Popen(argv,pass_fds=inherited)
for fd in inherited: os.close(fd)
def forward(s,f):
    try: p.send_signal(s)
    except ProcessLookupError: pass
for s in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP): signal.signal(s,forward)
try: os.write(control,(str(p.pid)+'\n').encode())
except BrokenPipeError:
    p.kill(); p.wait(); sys.exit(1)
orphaned=None
while p.poll() is None:
    if not persistent and orphaned is None and os.getppid()!=owner:
        orphaned=time.monotonic()+45.0; forward(signal.SIGTERM,None)
    if orphaned is not None and time.monotonic()>=orphaned:
        p.kill(); break
    time.sleep(0.02)
r=p.wait()
try: os.write(control,('exit:'+str(r)+'\n').encode())
except BrokenPipeError: pass
os.close(control)
if r<0:
    if -r not in (signal.SIGKILL,signal.SIGSTOP): signal.signal(-r,signal.SIG_DFL)
    os.kill(os.getpid(),-r)
sys.exit(r)
"#;

pub struct TrustedCommand {
    command: Command,
    #[cfg(target_os = "macos")]
    control: UnixStream,
    #[cfg(target_os = "macos")]
    _child_control: UnixStream,
}

impl TrustedCommand {
    /// 持久宿主脱离首次客户端；其退出仍由公开 service 控制协议决定。
    pub fn persistent(binary: &Path) -> io::Result<Self> {
        Self::new(binary, &[], true)
    }

    /// 受监督进程仅继承调用方明确指定的租约或生命周期描述符。
    pub fn supervised(binary: &Path, inherited: &[RawFd]) -> io::Result<Self> {
        Self::new(binary, inherited, false)
    }

    fn new(binary: &Path, inherited: &[RawFd], persistent: bool) -> io::Result<Self> {
        if !binary.is_absolute() || inherited.iter().any(|fd| *fd < 3) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "trusted process requires an absolute executable and explicit non-stdio descriptors",
            ));
        }
        #[cfg(target_os = "macos")]
        let (control, child_control) = UnixStream::pair()?;
        #[cfg(target_os = "macos")]
        let mut command = {
            control.set_nonblocking(true)?;
            let mut command = Command::new("/usr/bin/python3");
            command.args(["-I", "-S", "-c", BRIDGE]);
            command.arg(child_control.as_raw_fd().to_string());
            command.arg(
                inherited
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join(","),
            );
            command.arg(if persistent { "1" } else { "0" }).arg(binary);
            command
        };
        #[cfg(not(target_os = "macos"))]
        let mut command = Command::new(binary);
        let descriptors = inherited.to_vec();
        #[cfg(target_os = "macos")]
        let descriptors = {
            let mut descriptors = descriptors;
            descriptors.push(child_control.as_raw_fd());
            descriptors
        };
        // 独立组只拥有本次桥和子进程。持久宿主使用 setsid，受监督桥使用 setpgid。
        // Linux 保持原有直启拓扑；除了持久宿主，不更改进程组。
        unsafe {
            command.pre_exec(move || {
                if persistent {
                    if libc::setsid() < 0 {
                        return Err(io::Error::last_os_error());
                    }
                } else if cfg!(target_os = "macos") && libc::setpgid(0, 0) < 0 {
                    return Err(io::Error::last_os_error());
                }
                for fd in &descriptors {
                    if libc::fcntl(*fd, libc::F_SETFD, 0) < 0 {
                        return Err(io::Error::last_os_error());
                    }
                }
                Ok(())
            });
        }
        Ok(Self {
            command,
            #[cfg(target_os = "macos")]
            control,
            #[cfg(target_os = "macos")]
            _child_control: child_control,
        })
    }

    /// launcher 检查的是实际父进程；桥另外监督原宿主，避免增加一层后失去死亡通知。
    pub fn parent_pid_arg(&mut self) {
        self.command.arg("--parent-pid");
        #[cfg(target_os = "macos")]
        self.command.arg("@areal-native-parent@");
        #[cfg(not(target_os = "macos"))]
        self.command.arg(std::process::id().to_string());
    }

    pub async fn spawn(&mut self) -> io::Result<TrustedChild> {
        let child = self.command.spawn()?;
        #[cfg(not(target_os = "macos"))]
        {
            Ok(TrustedChild::direct(child))
        }
        #[cfg(target_os = "macos")]
        {
            // 握手未完成时取消 future 也必须清退本次独立组，不能遗留未知宿主。
            let mut pending = Pending {
                group: child.id().unwrap(),
                child: Some(child),
            };
            let mut bytes = Vec::new();
            let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
            loop {
                read_available(&mut self.control, &mut bytes)?;
                if let Some(end) = bytes.iter().position(|byte| *byte == b'\n') {
                    let pid = std::str::from_utf8(&bytes[..end])
                        .ok()
                        .and_then(|s| s.parse::<u32>().ok())
                        .filter(|pid| *pid > 1)
                        .ok_or_else(|| io::Error::other("invalid trusted child PID"))?;
                    let control = self.control.try_clone()?;
                    let mut child = pending.child.take().unwrap();
                    let group = child.id().unwrap();
                    return Ok(TrustedChild {
                        stdin: child.stdin.take(),
                        child,
                        bridge: Some(Bridge {
                            pid,
                            group,
                            control,
                            bytes: bytes[end + 1..].to_vec(),
                        }),
                    });
                }
                if let Some(status) = pending.child.as_mut().unwrap().try_wait()? {
                    return Err(io::Error::other(format!(
                        "trusted process bridge exited before PID handshake: {status}; macOS requires a working /usr/bin/python3 (Xcode Command Line Tools)"
                    )));
                }
                if tokio::time::Instant::now() >= deadline {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "trusted process PID handshake timed out",
                    ));
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
    }

    /// 临时配置预检必须使用同一握手/回执路径，不能经 Deref 调用裸 Command::output。
    pub async fn output(&mut self, limit: Duration) -> io::Result<Output> {
        let deadline = tokio::time::Instant::now() + limit;
        self.command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let child = tokio::time::timeout_at(deadline, self.spawn())
            .await
            .map_err(|_| {
                io::Error::new(io::ErrorKind::TimedOut, "trusted output startup timed out")
            })??;
        let mut temporary = Temporary { child: Some(child) };
        let child = temporary.child.as_mut().unwrap();
        let mut stdout = child.child.stdout.take().unwrap();
        let mut stderr = child.child.stderr.take().unwrap();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let result = tokio::time::timeout_at(deadline, async {
            tokio::try_join!(
                child.wait(),
                capture(&mut stdout, &mut out),
                capture(&mut stderr, &mut err)
            )
        })
        .await;
        match result {
            Ok(Ok((status, _, _))) => {
                drop(temporary.child.take());
                Ok(Output {
                    status,
                    stdout: out,
                    stderr: err,
                })
            }
            other => {
                // 清理归独立任务持有；取消等待者不能再次取消已经开始的回收。
                tokio::spawn(cleanup_temporary(temporary.child.take().unwrap()))
                    .await
                    .map_err(|error| {
                        io::Error::other(format!("trusted output cleanup unconfirmed: {error}"))
                    })??;
                Err(match other {
                    Ok(Err(error)) => error,
                    Err(_) => io::Error::new(io::ErrorKind::TimedOut, "trusted output timed out"),
                    Ok(Ok(_)) => unreachable!(),
                })
            }
        }
    }
}

async fn capture(reader: &mut (impl AsyncRead + Unpin), bytes: &mut Vec<u8>) -> io::Result<()> {
    const MAX_BUFFER: usize = 2 * 1024 * 1024;
    reader
        .take(MAX_BUFFER as u64 + 1)
        .read_to_end(bytes)
        .await?;
    if bytes.len() > MAX_BUFFER {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "trusted output exceeded the 2 MiB stream limit",
        ));
    }
    Ok(())
}

impl Deref for TrustedCommand {
    type Target = Command;
    fn deref(&self) -> &Command {
        &self.command
    }
}
impl DerefMut for TrustedCommand {
    fn deref_mut(&mut self) -> &mut Command {
        &mut self.command
    }
}

pub struct TrustedChild {
    child: TokioChild,
    pub stdin: Option<ChildStdin>,
    #[cfg(target_os = "macos")]
    bridge: Option<Bridge>,
}

#[cfg(target_os = "macos")]
struct Bridge {
    pid: u32,
    group: u32,
    control: UnixStream,
    bytes: Vec<u8>,
}

impl TrustedChild {
    /// 保留 Runtime/TUI 已有启动和终止策略；此转换不会引入桥。
    pub fn direct(mut child: TokioChild) -> Self {
        Self {
            stdin: child.stdin.take(),
            child,
            #[cfg(target_os = "macos")]
            bridge: None,
        }
    }
    pub fn id(&self) -> Option<u32> {
        let pid = self.child.id()?;
        #[cfg(target_os = "macos")]
        if let Some(bridge) = &self.bridge {
            return Some(bridge.pid);
        }
        Some(pid)
    }
    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        match self.child.try_wait()? {
            Some(status) => self.receipt(status).map(Some),
            None => Ok(None),
        }
    }
    pub async fn wait(&mut self) -> io::Result<ExitStatus> {
        let status = self.child.wait().await?;
        self.receipt(status)
    }
    pub fn start_kill(&mut self) -> io::Result<()> {
        if let Some(pid) = self.id()
            && unsafe { libc::kill(pid as i32, libc::SIGKILL) } != 0
            && io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
    pub async fn kill(&mut self) -> io::Result<()> {
        self.start_kill()?;
        self.wait().await.map(|_| ())
    }
    fn receipt(&mut self, status: ExitStatus) -> io::Result<ExitStatus> {
        #[cfg(target_os = "macos")]
        if let Some(bridge) = &mut self.bridge {
            read_available(&mut bridge.control, &mut bridge.bytes)?;
            let exit = std::str::from_utf8(&bridge.bytes)
                .ok()
                .and_then(|s| s.strip_prefix("exit:"))
                .and_then(|s| s.trim().parse::<i32>().ok());
            if let Some(code) = exit
                && ((code < 0 && status.signal() == Some(-code))
                    || (code >= 0 && status.code() == Some(code)))
            {
                return Ok(status);
            }
            // 桥没有 wait/reap 回执时不能宣称清理完成；清退实际进程并返回 UNKNOWN 型错误。
            if unsafe { libc::getpgid(bridge.pid as i32) } == bridge.group as i32 {
                unsafe {
                    libc::kill(bridge.pid as i32, libc::SIGKILL);
                }
            }
            return Err(io::Error::other(format!(
                "trusted process bridge exited without a matching child receipt: {status}"
            )));
        }
        Ok(status)
    }
}

struct Temporary {
    child: Option<TrustedChild>,
}

impl Drop for Temporary {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            // future 取消也立即终止本次临时调用；专用回收任务继续持有进程对象。
            let _ = child.start_kill();
            tokio::spawn(async move {
                let _ = cleanup_temporary(child).await;
            });
        }
    }
}

async fn cleanup_temporary(mut child: TrustedChild) -> io::Result<()> {
    child.start_kill()?;
    if let Ok(result) = tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
        return result.map(|_| ());
    }
    // 桥被停止等异常不能让配置取消永久等待；此组不包含持久 service。
    #[cfg(target_os = "macos")]
    if let Some(bridge) = &child.bridge {
        unsafe {
            libc::kill(-(bridge.group as i32), libc::SIGKILL);
        }
    }
    child.child.start_kill()?;
    tokio::time::timeout(Duration::from_secs(5), child.child.wait())
        .await
        .map_err(|_| {
            io::Error::new(
                io::ErrorKind::TimedOut,
                "trusted output cleanup unconfirmed",
            )
        })??;
    Err(io::Error::other(
        "trusted output bridge required forced cleanup; child receipt unavailable",
    ))
}

#[cfg(target_os = "macos")]
fn read_available(stream: &mut UnixStream, bytes: &mut Vec<u8>) -> io::Result<()> {
    let mut chunk = [0; 128];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => return Ok(()),
            Ok(n) => {
                bytes.extend_from_slice(&chunk[..n]);
                if bytes.len() > 256 {
                    return Err(io::Error::other("oversized trusted process receipt"));
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
}

#[cfg(target_os = "macos")]
struct Pending {
    group: u32,
    child: Option<TokioChild>,
}
#[cfg(target_os = "macos")]
impl Drop for Pending {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            unsafe {
                libc::kill(-(self.group as i32), libc::SIGKILL);
            }
            // Tokio 负责重收已启动子进程；异步取消不阻塞调用方线程。
            tokio::spawn(async move {
                let _ = child.wait().await;
            });
        }
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests;
