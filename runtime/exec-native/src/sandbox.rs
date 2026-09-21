//! Runtime-owned macOS path policy. Parameters are regular expressions over
//! kernel-resolved paths; they must never be canonicalized by the executor.
use areal_runtime_protocol::{Error, ErrorCode, Result};
use areal_runtime_supervisor::backend::Execution;
use std::{collections::BTreeSet, path::Path};

pub const SEATBELT_PROFILE: &str = "runtimeSeatbeltPathV1";
pub const OUTER_CONTAINER_PERF_PROFILE: &str = "outerContainerPerfV1";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Profile {
    #[default]
    Native,
    OuterContainerPerf,
}

impl Profile {
    pub fn name(self) -> &'static str {
        match self {
            Self::Native => SEATBELT_PROFILE,
            Self::OuterContainerPerf => OUTER_CONTAINER_PERF_PROFILE,
        }
    }
}

// Keep system allowances explicit. In particular, /System includes the writable
// Data volume. Shared temporary directories must not become writable either.
// Neither is an appropriate read/write boundary for an ExecutionScope.
const BASE: &str = r#"
(version 1)
(deny default)
(allow process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))
(allow sysctl-read)
(allow process-exec file-read* file-map-executable
  (regex #"^/(System/(Library|iOSSupport/System/Library)|bin|sbin|usr/(bin|sbin|lib|libexec|share))(/|$)"))
(allow file-read* file-test-existence (literal "/"))
(allow file-read*
  (regex #"^/private/(etc/(passwd|group|localtime)|var/select/sh)$")
  (regex #"^/private/var/db/timezone(/|$)")
  (literal "/dev/null") (literal "/dev/zero")
  (literal "/dev/random") (literal "/dev/urandom"))
(allow file-write-data (literal "/dev/null") (literal "/dev/zero"))
(allow file-read-data file-write-data (regex #"^/dev/fd/[012]$"))
"#;

pub fn supported(profile: Profile) -> Result<()> {
    match profile {
        Profile::Native if cfg!(target_os = "macos") => Ok(()),
        Profile::Native => Err(Error::new(
            ErrorCode::Unsupported,
            "the Runtime-owned path sandbox currently requires macOS Seatbelt",
        )),
        Profile::OuterContainerPerf if !cfg!(target_os = "linux") => Err(Error::new(
            ErrorCode::Unsupported,
            "the outer-container perf profile requires Linux",
        )),
        Profile::OuterContainerPerf
            if !Path::new("/.dockerenv").exists() && !Path::new("/run/.containerenv").exists() =>
        {
            Err(Error::new(
                ErrorCode::Unsupported,
                "the outer-container perf profile may only run inside a container",
            ))
        }
        Profile::OuterContainerPerf => Ok(()),
    }
}

pub fn command(execution: &Execution, profile: Profile) -> Result<Vec<String>> {
    supported(profile)?;
    if execution.argv.is_empty() {
        return Err(invalid("sandbox command must not be empty"));
    }
    if profile == Profile::OuterContainerPerf {
        return linux_command(execution);
    }
    let mut command = vec!["/usr/bin/sandbox-exec".into()];
    let mut policy = BASE.to_owned();
    if execution.tty {
        // 仅允许在已有终端描述符上查询/修改终端；不授予其他终端的打开或读写权限。
        policy.push_str("(allow file-ioctl (regex #\"^/dev/(tty|ttys[0-9]+)$\"))\n");
    }
    if execution.network == areal_runtime_protocol::NetworkRequest::Inherit {
        policy.push_str("(allow network*)\n");
    }
    let mut ancestors = BTreeSet::new();
    if let Some(helper) = &execution.trusted_executable {
        command.push(format!("-DHELPER=^{}$", escape(absolute_utf8(helper)?)));
        policy.push_str(
            "(allow process-exec file-read* file-map-executable (regex (param \"HELPER\")))\n",
        );
        for ancestor in helper.ancestors().skip(1) {
            ancestors.insert(escape(absolute_utf8(ancestor)?));
        }
    }
    for (roots, access, prefix) in [
        (
            &execution.read_roots,
            "process-exec file-read* file-map-executable",
            "READ",
        ),
        (&execution.write_roots, "file-write*", "WRITE"),
    ] {
        for (index, root) in roots.iter().enumerate() {
            let path = absolute_utf8(root)?;
            let key = format!("{prefix}{index}");
            let suffix = if path == "/" { "" } else { "(/|$)" };
            // -D parameters are data, not SBPL source. Do not interpolate paths
            // into the policy, even when they contain quotes or newlines.
            command.push(format!("-D{key}=^{}{suffix}", escape(path)));
            policy.push_str(&format!("(allow {access} (regex (param \"{key}\")))\n"));
            for ancestor in root.ancestors().skip(1) {
                ancestors.insert(escape(absolute_utf8(ancestor)?));
            }
        }
    }
    // Only metadata traversal of authorization-root ancestors is needed for
    // getcwd/stat; do not grant content reads of their siblings.
    if !ancestors.is_empty() {
        command.push(format!(
            "-DMETADATA=^({})$",
            ancestors.into_iter().collect::<Vec<_>>().join("|")
        ));
        policy.push_str(
            "(allow file-read-metadata file-test-existence (regex (param \"METADATA\")))\n",
        );
    }
    command.extend(["-p".into(), policy]);
    // Stop sandbox-exec option parsing before the caller's executable, including
    // an executable name starting with '-'. No shell joins or fallback path.
    command.push("--".into());
    // A signed system exec trampoline permits locally built Mach-O tools to
    // undergo normal platform validation under Seatbelt. The script is fixed;
    // caller arguments are separate positional parameters, never shell source.
    command.extend([
        "/bin/sh".into(),
        "-c".into(),
        "exec -- \"$@\"".into(),
        "areal-exec".into(),
    ]);
    command.extend(execution.argv.iter().cloned());
    if command.iter().map(|arg| arg.len() + 1).sum::<usize>() > 128 * 1024 {
        return Err(invalid("sandbox command exceeds the argument budget"));
    }
    Ok(command)
}

// Explicit mounts in a private network/PID namespace. No host-root mount and
// no fallback to unsandboxed execution if Bubblewrap cannot initialize.
fn linux_command(execution: &Execution) -> Result<Vec<String>> {
    let mut argv: Vec<String> = [
        "/usr/bin/bwrap",
        "--unshare-all",
        "--die-with-parent",
        "--cap-drop",
        "ALL",
        "--dev",
        "/dev",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    if execution.network == areal_runtime_protocol::NetworkRequest::Inherit {
        argv.push("--share-net".into());
    }
    argv.extend([
        "--tmpfs".into(),
        "/tmp".into(),
        "--proc".into(),
        "/proc".into(),
    ]);
    for path in [
        "/usr/bin",
        "/usr/local/bin",
        "/usr/local/lib",
        "/usr/local/lib64",
        "/usr/local/libexec",
        "/usr/local/include",
        "/usr/sbin",
        "/usr/lib",
        "/usr/lib64",
        "/usr/libexec",
        "/usr/include",
        "/usr/share",
        "/bin",
        "/sbin",
        "/lib",
        "/lib64",
        "/etc/ld.so.cache",
        "/etc/ld.so.conf",
        "/etc/ld.so.conf.d",
        "/etc/gnucobol",
        "/etc/alternatives",
        "/etc/passwd",
        "/etc/group",
        "/etc/localtime",
        "/etc/resolv.conf",
        "/etc/hosts",
        "/etc/nsswitch.conf",
        "/etc/ssl/certs",
        "/etc/pki",
    ] {
        if Path::new(path).exists() {
            argv.extend(["--ro-bind".into(), path.into(), path.into()]);
        }
    }
    for (roots, option) in [
        (&execution.read_roots, "--ro-bind"),
        (&execution.write_roots, "--bind"),
    ] {
        for root in roots {
            let path = absolute_utf8(root)?;
            // Do not deliberately follow a replaced authorization root.
            if root.canonicalize().ok().as_ref() != Some(root) {
                return Err(invalid(
                    "sandbox authorization root was redirected or removed",
                ));
            }
            argv.extend([option.into(), path.into(), path.into()]);
        }
    }
    if let Some(helper) = &execution.trusted_executable {
        let path = absolute_utf8(helper)?;
        argv.extend(["--ro-bind".into(), path.into(), path.into()]);
    }
    argv.extend([
        "--chdir".into(),
        absolute_utf8(&execution.cwd)?.into(),
        "--".into(),
    ]);
    argv.extend(execution.argv.iter().cloned());
    Ok(argv)
}

fn absolute_utf8(path: &Path) -> Result<&str> {
    path.to_str()
        .filter(|_| path.is_absolute())
        .filter(|path| !path.contains('\0'))
        .ok_or_else(|| invalid("sandbox paths must be absolute UTF-8 paths"))
}

fn escape(path: &str) -> String {
    let mut result = String::new();
    for ch in path.chars() {
        if matches!(
            ch,
            '\\' | '.' | '^' | '$' | '*' | '+' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '|'
        ) {
            result.push('\\');
        }
        result.push(ch);
    }
    result
}

fn invalid(message: &str) -> Error {
    Error::new(ErrorCode::InvalidArgument, message)
}

#[cfg(all(test, target_os = "macos"))]
mod tests;

/// Bubblewrap loads this filter after creating its namespaces. The anonymous
/// descriptor is inherited only by this child, then consumed by Bubblewrap.
#[cfg(target_os = "linux")]
pub fn seccomp(
    command: &mut tokio::process::Command,
    profile: Profile,
    network: areal_runtime_protocol::NetworkRequest,
) -> Result<Option<std::fs::File>> {
    use std::{
        ffi::CString,
        io::Write,
        os::fd::{AsRawFd, FromRawFd},
    };
    if profile != Profile::OuterContainerPerf {
        return Ok(None);
    }
    let architecture = match std::env::consts::ARCH {
        "x86_64" => 0xc000003e,
        "aarch64" => 0xc00000b7,
        _ => {
            return Err(Error::new(
                ErrorCode::Unsupported,
                "unsupported seccomp architecture",
            ));
        }
    };
    let instruction = |code, jt, jf, k| libc::sock_filter { code, jt, jf, k };
    let mut filter = vec![
        instruction(0x20, 0, 0, 4), // load seccomp_data.arch
        instruction(0x15, 1, 0, architecture),
        instruction(0x06, 0, 0, 0x80000000), // kill mismatched ABI
        instruction(0x20, 0, 0, 0),          // load syscall number
        instruction(0x45, 0, 1, 0x40000000), // reject x32 ABI
        instruction(0x06, 0, 0, 0x80000000),
    ];
    for syscall in [
        libc::SYS_socket,
        libc::SYS_socketpair,
        libc::SYS_ptrace,
        libc::SYS_mount,
        libc::SYS_umount2,
        libc::SYS_setns,
        libc::SYS_unshare,
    ] {
        if network == areal_runtime_protocol::NetworkRequest::Inherit
            && matches!(syscall, libc::SYS_socket | libc::SYS_socketpair)
        {
            continue;
        }
        filter.push(instruction(0x15, 0, 1, syscall as u32));
        filter.push(instruction(0x06, 0, 0, 0x00050000 | libc::EPERM as u32));
    }
    filter.push(instruction(0x06, 0, 0, 0x7fff0000)); // allow other syscalls
    let name = CString::new("areal-seccomp").unwrap();
    let fd = unsafe { libc::memfd_create(name.as_ptr(), libc::MFD_CLOEXEC) };
    if fd < 0 {
        return Err(invalid("cannot create seccomp descriptor"));
    }
    let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
    // SAFETY: sock_filter consists of initialized integer fields without padding.
    let bytes = unsafe {
        std::slice::from_raw_parts(
            filter.as_ptr().cast::<u8>(),
            std::mem::size_of_val(filter.as_slice()),
        )
    };
    file.write_all(bytes)
        .map_err(|_| invalid("cannot write seccomp filter"))?;
    use std::io::{Seek, SeekFrom};
    file.seek(SeekFrom::Start(0))
        .map_err(|_| invalid("cannot rewind seccomp filter"))?;
    let fd = file.as_raw_fd();
    command.args(["--seccomp", &fd.to_string()]);
    // SAFETY: fcntl is async-signal-safe and touches only this child's fd table.
    unsafe {
        command.pre_exec(move || {
            if libc::fcntl(fd, libc::F_SETFD, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    Ok(Some(file))
}

#[cfg(not(target_os = "linux"))]
pub fn seccomp(
    _: &mut tokio::process::Command,
    _: Profile,
    _: areal_runtime_protocol::NetworkRequest,
) -> Result<Option<std::fs::File>> {
    Ok(None)
}
