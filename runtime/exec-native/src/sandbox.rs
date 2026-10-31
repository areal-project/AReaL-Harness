//! Runtime-owned path policy. macOS uses Seatbelt; Linux uses Bubblewrap.
//! macOS policy parameters are regular expressions over kernel-resolved paths;
//! they must never be canonicalized by the executor.
use areal_runtime_protocol::{Error, ErrorCode, Result};
use areal_runtime_supervisor::backend::{Execution, ScopeAccess};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::sync::OnceLock;
use std::{collections::BTreeSet, path::Path};

#[cfg(not(target_os = "linux"))]
pub const SEATBELT_PROFILE: &str = "runtimeSeatbeltPathV1";
#[cfg(target_os = "linux")]
pub const BUBBLEWRAP_PROFILE: &str = "runtimeBubblewrapPathV1";
pub const OUTER_CONTAINER_PERF_PROFILE: &str = "outerContainerPerfV1";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Profile {
    #[default]
    Native,
    FullAccess,
    OuterContainerPerf,
}

impl Profile {
    pub fn name(self) -> &'static str {
        match self {
            Self::Native => {
                #[cfg(target_os = "linux")]
                {
                    BUBBLEWRAP_PROFILE
                }
                #[cfg(not(target_os = "linux"))]
                {
                    SEATBELT_PROFILE
                }
            }
            Self::FullAccess => "fullAccess",
            Self::OuterContainerPerf => OUTER_CONTAINER_PERF_PROFILE,
        }
    }
}

pub fn effective_profile(
    profile: Profile,
    access: ScopeAccess,
    has_read_only_paths: bool,
) -> Profile {
    if profile == Profile::FullAccess && (access == ScopeAccess::Restricted || has_read_only_paths)
    {
        Profile::Native
    } else {
        profile
    }
}

// Keep system allowances explicit. In particular, /System includes the writable
// Data volume. Shared temporary directories must not become writable either.
// Neither is an appropriate read/write boundary for an ExecutionScope.
// Core 在可信宿主侧解析系统 Python，避免在任务沙箱中启动 xcode-select/xcrun。
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
(allow file-read-metadata (literal "/var") (literal "/tmp") (literal "/etc"))
(allow file-read-metadata (literal "/private") (literal "/private/etc") (literal "/private/etc/gitconfig"))
(allow file-read-metadata
  (literal "/Applications")
  (regex #"^/Applications/Xcode(_[0-9]+([.][0-9]+)*)?[.]app(/Contents(/Developer(/Library(/Frameworks)?)?)?)?$"))
(allow file-read-metadata
  (literal "/Library") (literal "/Library/Developer")
  (literal "/Library/Developer/CommandLineTools")
  (literal "/Library/Developer/CommandLineTools/Library")
  (literal "/Library/Developer/CommandLineTools/Library/Frameworks"))
(allow process-exec file-read* file-map-executable
  (regex #"^/(Applications/Xcode(_[0-9]+([.][0-9]+)*)?[.]app/Contents/Developer|Library/Developer/CommandLineTools)/Library/Frameworks/Python3[.]framework(/|$)"))
(allow file-read-metadata
  (regex #"^/(Applications/Xcode(_[0-9]+([.][0-9]+)*)?[.]app/Contents/Developer|Library/Developer/CommandLineTools)/usr(/(bin|libexec|share))?$"))
(allow process-exec file-read* file-map-executable
  (regex #"^/(Applications/Xcode(_[0-9]+([.][0-9]+)*)?[.]app/Contents/Developer|Library/Developer/CommandLineTools)/usr/(bin/git$|libexec/git-core(/|$))"))
(allow file-read*
  (regex #"^/(Applications/Xcode(_[0-9]+([.][0-9]+)*)?[.]app/Contents/Developer|Library/Developer/CommandLineTools)/usr/share/git-core/templates(/|$)"))
(allow file-read-metadata
  (regex #"^/Applications/Xcode(_[0-9]+([.][0-9]+)*)?[.]app/Contents/Developer/(Toolchains|Platforms)(/MacOSX[.]platform(/Developer)?)?$"))
(allow process-exec file-read* file-map-executable
  (regex #"^/Applications/Xcode(_[0-9]+([.][0-9]+)*)?[.]app/Contents/Developer/Toolchains/XcodeDefault[.]xctoolchain(/|$)")
  (regex #"^/Library/Developer/CommandLineTools/usr/(bin|lib|libexec)(/|$)"))
(allow file-read*
  (regex #"^/Applications/Xcode(_[0-9]+([.][0-9]+)*)?[.]app/Contents/Developer/Platforms/MacOSX[.]platform/Developer/SDKs(/|$)")
  (regex #"^/Library/Developer/CommandLineTools/SDKs(/|$)"))
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
        Profile::FullAccess => Ok(()),
        Profile::Native if cfg!(target_os = "macos") => Ok(()),
        Profile::Native if cfg!(target_os = "linux") && Path::new("/usr/bin/bwrap").is_file() => {
            Ok(())
        }
        Profile::Native => Err(Error::new(
            ErrorCode::Unsupported,
            if cfg!(target_os = "linux") {
                "the Linux Runtime-owned path sandbox requires /usr/bin/bwrap"
            } else {
                "the Runtime-owned path sandbox currently requires macOS Seatbelt"
            },
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

#[cfg(target_os = "linux")]
pub fn preflight(profile: Profile) -> Result<()> {
    if profile != Profile::Native {
        return Ok(());
    }
    linux_proc_mount().map(|_| ())
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy)]
enum LinuxProcMount {
    Private,
    Empty,
}

#[cfg(target_os = "linux")]
fn linux_proc_mount() -> Result<LinuxProcMount> {
    static PREFLIGHT: OnceLock<Result<LinuxProcMount>> = OnceLock::new();
    PREFLIGHT
        .get_or_init(|| {
            match run_linux_preflight(LinuxProcMount::Private) {
                Ok(()) => Ok(LinuxProcMount::Private),
                Err(private_error) => {
                    // 外层容器屏蔽部分 proc 路径时，内层重新挂载 proc 会被内核拒绝。
                    // 空的只读 proc 保留 PID/mount 隔离，绝不绑定外层 proc 或直接执行命令。
                    run_linux_preflight(LinuxProcMount::Empty).map_err(|empty_error| {
                        Error::new(
                            ErrorCode::Unsupported,
                            format!(
                                "{private_error}; empty proc preflight also failed: {empty_error}"
                            ),
                        )
                    })?;
                    Ok(LinuxProcMount::Empty)
                }
            }
        })
        .clone()
}

#[cfg(target_os = "linux")]
fn proc_mount_args(mount: LinuxProcMount) -> &'static [&'static str] {
    match mount {
        LinuxProcMount::Private => &["--proc", "/proc"],
        LinuxProcMount::Empty => &["--tmpfs", "/proc", "--remount-ro", "/proc"],
    }
}

#[cfg(target_os = "linux")]
fn run_linux_preflight(proc_mount: LinuxProcMount) -> Result<()> {
    let mut command = std::process::Command::new("/usr/bin/bwrap");
    command.args([
        "--unshare-all",
        "--die-with-parent",
        "--new-session",
        "--cap-drop",
        "ALL",
        "--dev",
        "/dev",
    ]);
    command.args(proc_mount_args(proc_mount));
    // BusyBox 系统只有 /bin/true；与实际 native 命令一致，绑定其可执行文件及解释器。
    for path in ["/bin", "/usr", "/lib", "/lib64"] {
        if Path::new(path).exists() {
            command.args(["--ro-bind", path, path]);
        }
    }
    command.args(["--", "/bin/true"]);
    command.stdout(std::process::Stdio::null());
    let output = command.output().map_err(|error| {
        Error::new(
            ErrorCode::Unsupported,
            format!("cannot run Linux Bubblewrap preflight: {error}"),
        )
    })?;
    if output.status.success() {
        Ok(())
    } else {
        Err(Error::new(
            ErrorCode::Unsupported,
            format!(
                "Linux Bubblewrap preflight failed ({}): {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        ))
    }
}

#[cfg(target_os = "macos")]
pub fn preflight(profile: Profile) -> Result<()> {
    if profile == Profile::FullAccess {
        return Ok(());
    }
    static PREFLIGHT: OnceLock<Result<()>> = OnceLock::new();
    PREFLIGHT
        .get_or_init(|| {
            let output = std::process::Command::new("/usr/bin/sandbox-exec")
                .args(["-p", BASE, "/usr/bin/true"])
                .stdout(std::process::Stdio::null())
                .output()
                .map_err(|error| {
                    Error::new(
                        ErrorCode::Unsupported,
                        format!("cannot run macOS Seatbelt preflight: {error}"),
                    )
                })?;
            if output.status.success() {
                Ok(())
            } else {
                Err(Error::new(
                    ErrorCode::Unsupported,
                    format!(
                        "macOS Seatbelt preflight failed ({}): {}",
                        output.status,
                        String::from_utf8_lossy(&output.stderr).trim()
                    ),
                ))
            }
        })
        .clone()
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn preflight(profile: Profile) -> Result<()> {
    supported(profile)
}

pub fn command(execution: &Execution, profile: Profile) -> Result<Vec<String>> {
    supported(profile)?;
    if execution.argv.is_empty() {
        return Err(invalid("sandbox command must not be empty"));
    }
    if profile == Profile::OuterContainerPerf {
        return linux_command(execution);
    }
    #[cfg(target_os = "linux")]
    if matches!(profile, Profile::Native | Profile::FullAccess) {
        if profile == Profile::FullAccess
            && execution.scope_access == ScopeAccess::Unrestricted
            && execution.read_only_paths.is_empty()
        {
            return Ok(execution.argv.clone());
        }
        return linux_command(execution);
    }
    if profile == Profile::FullAccess {
        if execution.scope_access == ScopeAccess::Unrestricted
            && execution.read_only_paths.is_empty()
        {
            return Ok(execution.argv.clone());
        }
        // 只读、研究 Agent 和插件的收窄授权不能借部署模式跳过隔离。
        supported(Profile::Native)?;
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
    for (index, root) in execution.toolchain_roots.iter().enumerate() {
        if root.canonicalize().ok().as_ref() != Some(root) {
            return Err(invalid("toolchain root was redirected or removed"));
        }
        command.push(format!(
            "-DTOOLCHAIN{index}=^{}(/|$)",
            escape(absolute_utf8(root)?)
        ));
        policy.push_str(&format!("(allow process-exec file-read* file-map-executable (regex (param \"TOOLCHAIN{index}\")))\n"));
        for ancestor in root.ancestors().skip(1) {
            ancestors.insert(escape(absolute_utf8(ancestor)?));
        }
    }
    for (index, helper) in execution
        .trusted_executable
        .iter()
        .chain(&execution.builtin_executables)
        .enumerate()
    {
        command.push(format!(
            "-DHELPER{index}=^{}$",
            escape(absolute_utf8(helper)?)
        ));
        policy.push_str(&format!(
            "(allow process-exec file-read* file-map-executable (regex (param \"HELPER{index}\")))\n",
        ));
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
    for (index, root) in execution.read_only_paths.iter().enumerate() {
        command.push(format!(
            "-DINPUT{index}=^{}(/|$)",
            escape(absolute_utf8(root)?)
        ));
        policy.push_str(&format!(
            "(deny file-write* (regex (param \"INPUT{index}\")))\n"
        ));
        // 只禁止祖先本身的删除/重命名，仍允许在 scratch 中创建临时文件。
        let parents = root
            .ancestors()
            .skip(1)
            .map(|p| absolute_utf8(p).map(escape))
            .collect::<Result<Vec<_>>>()?;
        command.push(format!("-DINPUTPARENT{index}=^({})$", parents.join("|")));
        policy.push_str(&format!(
            "(deny file-write-unlink (regex (param \"INPUTPARENT{index}\")))\n"
        ));
    }
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
        "--new-session",
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
    argv.extend(["--tmpfs".into(), "/tmp".into()]);
    #[cfg(target_os = "linux")]
    let proc_mount = linux_proc_mount()?;
    #[cfg(target_os = "linux")]
    argv.extend(proc_mount_args(proc_mount).iter().map(|arg| (*arg).into()));
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
    for root in &execution.toolchain_roots {
        if root.canonicalize().ok().as_ref() != Some(root) {
            return Err(invalid("toolchain root was redirected or removed"));
        }
        let path = absolute_utf8(root)?.to_owned();
        argv.extend(["--ro-bind".into(), path.clone(), path]);
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
    // 输入和可写根之间的父目录也必须固定，否则收窄 Scope 仍可重命名中间目录。
    // 仅绑定已授权写入的祖先；写根本身已有挂载，不扩大父目录或兄弟目录的可见范围。
    let mut parents = BTreeSet::new();
    for root in &execution.read_only_paths {
        parents.extend(
            root.ancestors()
                .skip(1)
                .filter(|parent| {
                    !execution
                        .write_roots
                        .iter()
                        .any(|root| root.as_path() == *parent)
                        && execution
                            .write_roots
                            .iter()
                            .any(|root| parent.starts_with(root))
                })
                .map(Path::to_owned),
        );
    }
    for parent in parents {
        let path = absolute_utf8(&parent)?;
        argv.extend(["--bind".into(), path.into(), path.into()]);
    }
    for helper in execution
        .trusted_executable
        .iter()
        .chain(&execution.builtin_executables)
    {
        let path = absolute_utf8(helper)?;
        argv.extend(["--ro-bind".into(), path.into(), path.into()]);
    }
    for protected in &execution.read_only_paths {
        // 保护与可读根的交集；收窄到输入子目录也不能重新获得写权限。
        let visible: BTreeSet<_> = execution
            .read_roots
            .iter()
            .filter_map(|root| {
                if protected.starts_with(root) {
                    Some(protected)
                } else if root.starts_with(protected) {
                    Some(root)
                } else {
                    None
                }
            })
            .collect();
        for root in visible {
            let path = absolute_utf8(root)?;
            argv.extend(["--ro-bind".into(), path.into(), path.into()]);
        }
    }
    // full-access 的根挂载不能覆盖私有 PID namespace 的 proc/dev；否则可经宿主 /proc/PID/root 绕过输入挂载。
    #[cfg(target_os = "linux")]
    argv.extend(proc_mount_args(proc_mount).iter().map(|arg| (*arg).into()));
    argv.extend(["--dev".into(), "/dev".into()]);
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
    argv: &mut Vec<String>,
    profile: Profile,
    network: areal_runtime_protocol::NetworkRequest,
) -> Result<Option<std::fs::File>> {
    use std::{
        ffi::CString,
        io::Write,
        os::fd::{AsRawFd, FromRawFd},
    };
    if !matches!(profile, Profile::Native | Profile::OuterContainerPerf) {
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
        // 新挂载 API 也必须受限，不能通过新 user namespace 移走只读输入挂载。
        libc::SYS_fsopen,
        libc::SYS_fsconfig,
        libc::SYS_fsmount,
        libc::SYS_fspick,
        libc::SYS_open_tree,
        libc::SYS_move_mount,
        libc::SYS_mount_setattr,
        libc::SYS_pivot_root,
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
    // 过滤器只交给实际的 bwrap；外层回收器负责显式传递这个描述符。
    argv.splice(1..1, ["--seccomp".to_owned(), fd.to_string()]);
    Ok(Some(file))
}

#[cfg(not(target_os = "linux"))]
pub fn seccomp(
    _: &mut Vec<String>,
    _: Profile,
    _: areal_runtime_protocol::NetworkRequest,
) -> Result<Option<std::fs::File>> {
    Ok(None)
}

#[cfg(test)]
mod policy_tests {
    use super::*;
    use std::{collections::BTreeMap, path::PathBuf};

    #[cfg(target_os = "linux")]
    #[test]
    fn native_preflight_runs_the_command_inside_its_system_mounts() {
        preflight(Profile::Native).expect("native container must support the Runtime preflight");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn empty_proc_mount_hides_outer_processes_and_rejects_writes() {
        let mut command = std::process::Command::new("/usr/bin/bwrap");
        command.args([
            "--unshare-all",
            "--die-with-parent",
            "--new-session",
            "--cap-drop",
            "ALL",
            "--ro-bind",
            "/",
            "/",
            "--dev",
            "/dev",
        ]);
        command.args(proc_mount_args(LinuxProcMount::Empty));
        command.args([
            "--",
            "/bin/sh",
            "-c",
            "test -d /proc && test ! -e /proc/1/root && ! touch /proc/write-probe",
        ]);
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn linux_public_input_ancestors_are_pinned_inside_narrow_write_roots() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap().join("workspace");
        let parent = root.join("scratch");
        let public = parent.join("public");
        std::fs::create_dir_all(&public).unwrap();
        let outside = root.parent().unwrap().join("private/public");
        std::fs::create_dir_all(&outside).unwrap();
        let execution = Execution {
            process_id: "test-process".into(),
            argv: vec!["/bin/true".into()],
            cwd: root.clone(),
            env: BTreeMap::new(),
            read_roots: vec![root.clone()],
            write_roots: vec![root.clone()],
            read_only_paths: vec![public, outside],
            scope_access: ScopeAccess::Restricted,
            trusted_executable: None,
            builtin_executables: Vec::new(),
            toolchain_roots: Vec::new(),
            tty: false,
            pipe_stdin: false,
            network: areal_runtime_protocol::NetworkRequest::Deny,
        };
        let argv = linux_command(&execution).unwrap();
        let bound: BTreeSet<_> = argv
            .windows(3)
            .filter(|args| args[0] == "--bind")
            .map(|args| PathBuf::from(&args[1]))
            .collect();
        // 固定可写范围内的中间父目录，不能顺便暴露工作区外的祖先或兄弟目录。
        assert_eq!(bound, BTreeSet::from([root, parent]));
    }

    #[test]
    fn narrowed_full_access_selects_native_command_and_syscall_policy() {
        assert_eq!(
            effective_profile(Profile::FullAccess, ScopeAccess::Unrestricted, false),
            Profile::FullAccess
        );
        for (access, protected) in [
            (ScopeAccess::Restricted, false),
            (ScopeAccess::Unrestricted, true),
        ] {
            let profile = effective_profile(Profile::FullAccess, access, protected);
            assert_eq!(profile, Profile::Native);
            #[cfg(target_os = "linux")]
            {
                let mut argv = vec!["/usr/bin/bwrap".into()];
                let filter = seccomp(
                    &mut argv,
                    profile,
                    areal_runtime_protocol::NetworkRequest::Deny,
                )
                .unwrap();
                assert!(filter.is_some());
                assert!(argv.iter().any(|arg| arg == "--seccomp"));
            }
        }
    }

    #[test]
    fn full_access_unrestricted_scope_does_not_require_native_sandbox() {
        let execution = Execution {
            process_id: "test-process".into(),
            argv: vec!["/bin/true".into()],
            cwd: PathBuf::from("/"),
            env: BTreeMap::new(),
            read_roots: vec![PathBuf::from("/")],
            write_roots: Vec::new(),
            read_only_paths: Vec::new(),
            scope_access: ScopeAccess::Unrestricted,
            trusted_executable: None,
            builtin_executables: Vec::new(),
            toolchain_roots: Vec::new(),
            tty: false,
            pipe_stdin: false,
            network: areal_runtime_protocol::NetworkRequest::Inherit,
        };

        assert_eq!(
            command(&execution, Profile::FullAccess).unwrap(),
            execution.argv
        );

        let mut ordinary_process = execution;
        ordinary_process.scope_access = ScopeAccess::Restricted;
        assert!(
            command(&ordinary_process, Profile::FullAccess)
                .map_or(true, |argv| argv != ordinary_process.argv)
        );
    }
}
