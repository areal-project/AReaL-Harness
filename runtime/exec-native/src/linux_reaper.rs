//! Linux 执行树使用独立 subreaper，避免在 Tokio 宿主争抢其他 Child 的退出状态。
use areal_runtime_protocol::{Error, ErrorCode};
use std::{
    fs::File,
    io::{self, Read},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::process::ExitStatusExt,
    },
    process::ExitStatus,
    time::Duration,
};
use tokio::{
    io::unix::AsyncFd,
    process::{Child, Command},
    time::{Instant, timeout, timeout_at},
};

const RECEIPT_LIMIT: usize = 1024;
const CLEANUP_TIMEOUT: Duration = Duration::from_millis(2500);
const START_TIMEOUT: Duration = Duration::from_secs(3);

pub struct Reaper {
    lifetime: Option<File>,
    child_lifetime: Option<File>,
    child_receipt: Option<File>,
    receipt: AsyncFd<File>,
    buffer: Vec<u8>,
    startup: Option<String>,
    startup_deadline: Option<Instant>,
    parsed: Option<Result<ExitStatus, String>>,
    deadline: Option<Instant>,
}

fn pipe() -> io::Result<(File, File)> {
    let mut fds = [-1; 2];
    // SAFETY: 成功后只为两个新描述符各建立一次所有权。
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { (File::from_raw_fd(fds[0]), File::from_raw_fd(fds[1])) })
}

pub fn helper_path() -> io::Result<std::path::PathBuf> {
    let mut helper = std::env::current_exe()?;
    helper.set_file_name("areal-runtime-reaper");
    if cfg!(test)
        && helper
            .parent()
            .is_some_and(|parent| parent.ends_with("deps"))
    {
        helper = helper
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("areal-runtime-reaper");
    }
    Ok(helper)
}

pub fn prepare(argv: &[String], tty: bool, filter: Option<&File>) -> io::Result<(Command, Reaper)> {
    if argv.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "empty execution",
        ));
    }
    let (child_lifetime, lifetime) = pipe()?;
    let (receipt, child_receipt) = pipe()?;
    // AsyncFd 必须使用非阻塞描述符，才能在取消后安全继续读取同一份回执。
    if unsafe { libc::fcntl(receipt.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    let child_fds = [
        child_lifetime.as_raw_fd(),
        child_receipt.as_raw_fd(),
        filter.map_or(-1, AsRawFd::as_raw_fd),
    ];
    let mut command = Command::new(helper_path()?);
    command
        .arg(child_fds[0].to_string())
        .arg(child_fds[1].to_string())
        .arg(if tty { "1" } else { "0" })
        .arg(child_fds[2].to_string())
        .arg("--")
        .args(argv)
        .kill_on_drop(false);
    // 这里只执行 async-signal-safe fcntl；复杂回收逻辑在 exec 后的独立进程中运行。
    unsafe {
        command.pre_exec(move || {
            for fd in child_fds.into_iter().filter(|fd| *fd >= 0) {
                if libc::fcntl(fd, libc::F_SETFD, 0) < 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    Ok((
        command,
        Reaper {
            lifetime: Some(lifetime),
            child_lifetime: Some(child_lifetime),
            child_receipt: Some(child_receipt),
            receipt: AsyncFd::new(receipt)?,
            buffer: Vec::new(),
            startup: None,
            startup_deadline: None,
            parsed: None,
            deadline: None,
        },
    ))
}

impl Reaper {
    pub fn spawned(&mut self) {
        self.child_lifetime.take();
        self.child_receipt.take();
    }

    pub fn terminate(&mut self) {
        self.lifetime.take();
        self.deadline
            .get_or_insert_with(|| Instant::now() + CLEANUP_TIMEOUT);
    }

    async fn read_line(&mut self) -> Result<String, String> {
        loop {
            if let Some(end) = self.buffer.iter().position(|byte| *byte == b'\n') {
                let line = std::str::from_utf8(&self.buffer[..end])
                    .map_err(|_| "execution reaper returned non-UTF-8 receipt".to_owned())?
                    .to_owned();
                // STARTED 和最终状态可能同次读入；只消费当前行，保留下一阶段数据。
                self.buffer.drain(..=end);
                return Ok(line);
            }
            if self.buffer.len() >= RECEIPT_LIMIT {
                return Err("execution reaper receipt exceeds limit".to_owned());
            }
            let mut ready = self.receipt.readable().await.map_err(|e| e.to_string())?;
            let mut bytes = [0; 256];
            let available = bytes.len().min(RECEIPT_LIMIT - self.buffer.len());
            match ready.try_io(|fd| {
                let mut file = fd.get_ref();
                file.read(&mut bytes[..available])
            }) {
                Ok(Ok(0)) => {
                    return Err("execution reaper exited without cleanup receipt".to_owned());
                }
                Ok(Ok(count)) => self.buffer.extend_from_slice(&bytes[..count]),
                Ok(Err(error)) => {
                    return Err(format!("cannot read execution reaper receipt: {error}"));
                }
                Err(_) => continue,
            }
        }
    }

    pub async fn started(&mut self, child: &mut Child) -> Result<(), Error> {
        let deadline = *self
            .startup_deadline
            .get_or_insert_with(|| Instant::now() + START_TIMEOUT);
        if self.startup.is_none() {
            let line = timeout_at(deadline, self.read_line())
                .await
                .map_err(|_| {
                    Error::new(
                        ErrorCode::CleanupFailed,
                        "execution reaper startup timed out",
                    )
                })?
                .map_err(|message| Error::new(ErrorCode::CleanupFailed, message))?;
            self.startup = Some(line);
        }
        let line = self.startup.as_deref().expect("startup receipt was stored");
        if line == "STARTED" {
            return Ok(());
        }
        if let Some(message) = line.strip_prefix("START_FAILED ") {
            // 确认没有 payload 且 helper 已被回收后，保留原先的单次启动失败语义。
            let helper = timeout_at(deadline, child.wait())
                .await
                .map_err(|_| {
                    Error::new(
                        ErrorCode::CleanupFailed,
                        "execution reaper did not exit after startup failure",
                    )
                })?
                .map_err(|error| {
                    Error::new(
                        ErrorCode::CleanupFailed,
                        format!("cannot wait failed execution reaper: {error}"),
                    )
                })?;
            if helper.code() != Some(1) {
                return Err(Error::new(
                    ErrorCode::CleanupFailed,
                    format!("execution reaper returned inconsistent startup failure: {helper}"),
                ));
            }
            return Err(Error::new(
                ErrorCode::InvalidArgument,
                format!("cannot start sandboxed process: {message}"),
            ));
        }
        Err(Error::new(
            ErrorCode::CleanupFailed,
            format!("execution reaper returned invalid startup receipt: {line}"),
        ))
    }

    async fn read_receipt(&mut self) -> Result<ExitStatus, String> {
        if let Some(result) = &self.parsed {
            return result.clone();
        }
        let line = self.read_line().await?;
        let result = if let Some(status) = line.strip_prefix("OK ") {
            status
                .parse::<i32>()
                .map_err(|_| "execution reaper returned invalid exit status".to_owned())
                .and_then(|status| {
                    if libc::WIFEXITED(status) || libc::WIFSIGNALED(status) {
                        Ok(ExitStatus::from_raw(status))
                    } else {
                        Err("execution reaper returned unfinished exit status".to_owned())
                    }
                })
        } else if let Some(error) = line.strip_prefix("ERROR ") {
            Err(format!("execution reaper cleanup failed: {error}"))
        } else {
            Err("execution reaper returned invalid receipt".to_owned())
        };
        self.parsed = Some(result.clone());
        result
    }

    pub async fn finish(&mut self, child: &mut Child) -> Result<ExitStatus, String> {
        // buffer/parsed 留在对象内；select 取消本 future 后重入不会丢失半条回执。
        let leader = if let Some(deadline) = self.deadline {
            timeout_at(deadline, self.read_receipt())
                .await
                .map_err(|_| "execution reaper cleanup receipt timed out".to_owned())??
        } else {
            self.read_receipt().await?
        };
        // 失败回执在上面立即返回；仍有 D 态后代时，helper 继续收养并等待。
        let helper = timeout(Duration::from_secs(1), child.wait())
            .await
            .map_err(|_| "execution reaper did not exit after cleanup receipt".to_owned())?
            .map_err(|error| format!("cannot wait execution reaper: {error}"))?;
        if !helper.success() {
            return Err(format!("execution reaper failed after cleanup: {helper}"));
        }
        Ok(leader)
    }
}
