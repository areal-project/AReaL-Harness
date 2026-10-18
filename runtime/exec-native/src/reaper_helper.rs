use std::{
    fs::File,
    io::{self, Write},
    os::{fd::FromRawFd, unix::process::CommandExt},
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

static STOPPING: AtomicBool = AtomicBool::new(false);

extern "C" fn stop(_: libc::c_int) {
    STOPPING.store(true, Ordering::Relaxed);
}

struct Receipt(Option<File>);

impl Receipt {
    fn write(&mut self, message: &str) {
        if let Some(file) = &mut self.0 {
            let line: String = message
                .chars()
                .take(200)
                .map(|character| {
                    if matches!(character, '\n' | '\r') {
                        ' '
                    } else {
                        character
                    }
                })
                .collect();
            let _ = writeln!(file, "{line}");
        }
    }

    fn finish(&mut self, message: &str) {
        self.write(message);
        self.0.take();
    }
}

fn children() -> io::Result<Vec<i32>> {
    std::fs::read_to_string(format!("/proc/self/task/{}/children", std::process::id()))?
        .split_whitespace()
        .map(|pid| {
            pid.parse()
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
        })
        .collect()
}

fn setup(filter: i32) -> io::Result<()> {
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = stop as *const () as usize;
        libc::sigemptyset(&mut action.sa_mask);
        for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            if libc::sigaction(signal, &action, std::ptr::null_mut()) < 0 {
                return Err(io::Error::last_os_error());
            }
        }
        action.sa_sigaction = libc::SIG_DFL;
        if libc::sigaction(libc::SIGCHLD, &action, std::ptr::null_mut()) < 0
            || libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) < 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    // 与原 close_fds 行为一致，工作负载只继承标准流和显式 seccomp 描述符。
    for entry in std::fs::read_dir("/proc/self/fd")? {
        let entry = entry?;
        let descriptor: i32 = entry
            .file_name()
            .to_string_lossy()
            .parse()
            .map_err(io::Error::other)?;
        if descriptor < 3 {
            continue;
        }
        let flags = if descriptor == filter {
            0
        } else {
            libc::FD_CLOEXEC
        };
        if unsafe { libc::fcntl(descriptor, libc::F_SETFD, flags) } < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    children()?;
    Ok(())
}

fn supervise(leader: i32, control: i32, receipt: &mut Receipt) -> i32 {
    let mut leader_status = None;
    let mut failure = None;
    let mut deadline = None;
    loop {
        loop {
            let mut status = 0;
            let pid = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
            if pid == 0 {
                break;
            }
            if pid < 0 {
                let error = io::Error::last_os_error();
                match error.raw_os_error() {
                    Some(libc::EINTR) => continue,
                    Some(libc::ECHILD) => {
                        if let Some(message) = failure {
                            receipt.finish(&format!("ERROR {message}"));
                            return 1;
                        }
                        if let Some(status) = leader_status {
                            receipt.finish(&format!("OK {status}"));
                            return 0;
                        }
                        receipt.finish("ERROR execution ended without a leader status");
                        return 1;
                    }
                    _ => {
                        failure.get_or_insert_with(|| format!("cannot wait owned child: {error}"));
                        STOPPING.store(true, Ordering::Relaxed);
                        break;
                    }
                }
            }
            if pid == leader {
                leader_status = Some(status);
                STOPPING.store(true, Ordering::Relaxed);
            }
        }
        if !STOPPING.load(Ordering::Relaxed) {
            let mut descriptor = libc::pollfd {
                fd: control,
                events: libc::POLLIN,
                revents: 0,
            };
            let ready = unsafe { libc::poll(&mut descriptor, 1, 20) };
            if ready > 0 {
                STOPPING.store(true, Ordering::Relaxed);
            } else if ready < 0 && io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
                failure.get_or_insert_with(|| {
                    format!("control pipe failed: {}", io::Error::last_os_error())
                });
                STOPPING.store(true, Ordering::Relaxed);
            }
        }
        if !STOPPING.load(Ordering::Relaxed) {
            continue;
        }
        let until = *deadline.get_or_insert_with(|| Instant::now() + Duration::from_secs(2));
        let owned = children().unwrap_or_else(|error| {
            failure.get_or_insert_with(|| format!("cannot enumerate adopted children: {error}"));
            if leader_status.is_none() {
                vec![leader]
            } else {
                Vec::new()
            }
        });
        for pid in owned {
            if unsafe { libc::kill(pid, libc::SIGKILL) } < 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::ESRCH) {
                    failure.get_or_insert_with(|| format!("cannot stop owned child: {error}"));
                }
            }
        }
        if Instant::now() >= until {
            let message = failure.get_or_insert_with(|| {
                "owned descendants did not exit before cleanup deadline".to_owned()
            });
            receipt.finish(&format!("ERROR {message}"));
        }
        std::thread::sleep(Duration::from_millis(if receipt.0.is_some() {
            10
        } else {
            100
        }));
    }
}

pub fn run() -> i32 {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let descriptor = |index: usize| args.get(index)?.to_str()?.parse::<i32>().ok();
    let (Some(control), Some(receipt), Some(tty), Some(filter)) =
        (descriptor(0), descriptor(1), descriptor(2), descriptor(3))
    else {
        return 1;
    };
    if control < 3
        || receipt < 3
        || control == receipt
        || !matches!(tty, 0 | 1)
        || (filter != -1 && filter < 3)
        || filter == control
        || filter == receipt
        || args.len() < 6
        || args[4] != "--"
    {
        return 1;
    }
    let _control = unsafe { File::from_raw_fd(control) };
    let mut receipt = Receipt(Some(unsafe { File::from_raw_fd(receipt) }));
    let result = setup(filter).and_then(|()| {
        let mut command = Command::new(&args[5]);
        command.args(&args[6..]);
        unsafe {
            command.pre_exec(move || {
                if libc::setsid() < 0 || (tty == 1 && libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0) {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        command.spawn()
    });
    let child = match result {
        Ok(child) => child,
        Err(error) => {
            receipt.finish(&format!("START_FAILED {error}"));
            return 1;
        }
    };
    receipt.write("STARTED");
    for descriptor in [0, 1, 2, filter]
        .into_iter()
        .filter(|descriptor| *descriptor >= 0)
    {
        unsafe {
            libc::close(descriptor);
        }
    }
    supervise(child.id() as i32, control, &mut receipt)
}
