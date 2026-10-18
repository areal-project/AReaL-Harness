use super::*;
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::fs::symlink,
    path::PathBuf,
    process::{Command, Output, Stdio},
};

struct Fixture {
    _directory: tempfile::TempDir,
    root: PathBuf,
    allowed: PathBuf,
    cwd: PathBuf,
    outside: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        // All of these characters are data, including SBPL/regex metacharacters.
        let allowed = root.join("授权.\"[]()+$^|\\\n");
        let cwd = root.join("cwd");
        let outside = root.join("outside");
        for path in [&allowed, &cwd, &outside] {
            fs::create_dir(path).unwrap();
        }
        fs::write(allowed.join("fixture"), b"allowed-fixture").unwrap();
        fs::write(outside.join("fixture"), b"outside-fixture").unwrap();
        Self {
            _directory: directory,
            root,
            allowed,
            cwd,
            outside,
        }
    }
    fn execution(&self, argv: Vec<String>) -> Execution {
        Execution {
            process_id: "test-process".into(),
            argv,
            cwd: self.cwd.clone(),
            env: BTreeMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
            read_roots: vec![self.allowed.clone(), self.cwd.clone()],
            write_roots: vec![self.allowed.clone()],
            read_only_paths: Vec::new(),
            scope_access: ScopeAccess::Restricted,
            trusted_executable: None,
            builtin_executables: Vec::new(),
            tty: false,
            pipe_stdin: false,
            network: areal_runtime_protocol::NetworkRequest::Deny,
        }
    }
    fn shell(&self, code: &str, args: &[&Path]) -> Execution {
        self.execution(
            ["/bin/sh", "-c", code, "fixture"]
                .into_iter()
                .map(str::to_owned)
                .chain(args.iter().map(|p| p.to_str().unwrap().into()))
                .collect(),
        )
    }
    fn replace_root(&self) {
        fs::rename(&self.allowed, self.root.join("original")).unwrap();
        symlink(&self.outside, &self.allowed).unwrap();
    }
}

fn prepared(execution: &Execution) -> Vec<String> {
    let argv = command(execution, Profile::Native).unwrap();
    assert_eq!(argv[0], "/usr/bin/sandbox-exec");
    argv
}
fn child_command(argv: &[String], execution: &Execution) -> Command {
    let mut command = Command::new(&argv[0]);
    command
        .args(&argv[1..])
        .current_dir(&execution.cwd)
        .env_clear()
        .envs(&execution.env);
    command
}
fn run(argv: &[String], execution: &Execution) -> Output {
    child_command(argv, execution).output().unwrap()
}
fn denied(output: &Output) {
    assert!(!output.status.success(), "{output:?}");
    assert!(
        !String::from_utf8_lossy(&output.stdout).contains("outside-fixture"),
        "{output:?}"
    );
}

#[test]
fn native_policy_enforces_literal_boundaries_and_no_shared_temp_writes() {
    let fixture = Fixture::new();
    let execution = fixture.shell(
        "cat \"$1/fixture\"; printf written > \"$1/new-file\"; cat \"$1/new-file\"",
        &[&fixture.allowed],
    );
    let output = run(&prepared(&execution), &execution);
    assert!(output.status.success(), "{output:?}");
    assert_eq!(output.stdout, b"allowed-fixturewritten");
    assert!(output.stderr.is_empty(), "{output:?}");

    let mut readonly = fixture.shell("printf denied > \"$1/readonly\"", &[&fixture.allowed]);
    readonly.write_roots.clear();
    denied(&run(&prepared(&readonly), &readonly));
    assert!(!fixture.allowed.join("readonly").exists());

    // Prefix siblings must not match a permission root. Also check the macOS
    // Data-volume alias, which would escape an overbroad /System allowance.
    let prefix = fixture.allowed.with_file_name(format!(
        "{}-sibling",
        fixture.allowed.file_name().unwrap().to_str().unwrap()
    ));
    fs::create_dir(&prefix).unwrap();
    fs::write(prefix.join("fixture"), b"outside-fixture").unwrap();
    let scratch = tempfile::tempdir_in("/private/tmp").unwrap();
    for outside in [
        fixture.outside.clone(),
        prefix,
        Path::new("/System/Volumes/Data").join(fixture.outside.strip_prefix("/").unwrap()),
        scratch.path().to_path_buf(),
    ] {
        let execution = fixture.shell(
            "cat \"$1/fixture\"; printf denied > \"$1/forbidden\"",
            &[&outside],
        );
        denied(&run(&prepared(&execution), &execution));
        assert!(!outside.join("forbidden").exists());
    }
}

#[test]
fn redirect_before_or_after_policy_preparation_cannot_expand_permissions() {
    for replace_before_prepare in [true, false] {
        let fixture = Fixture::new();
        let execution = fixture.shell(
            "cat \"$1/fixture\"; printf denied > \"$1/forbidden\"",
            &[&fixture.allowed],
        );
        if replace_before_prepare {
            fixture.replace_root();
        }
        let argv = prepared(&execution);
        if !replace_before_prepare {
            fixture.replace_root();
        }
        denied(&run(&argv, &execution));
        assert!(!fixture.outside.join("forbidden").exists());
    }
}

#[test]
fn running_process_cannot_follow_a_replaced_authorization_root() {
    let fixture = Fixture::new();
    let execution = fixture.shell(
        "printf 'ready\n'; read -r go; cat \"$1/fixture\"; printf denied > \"$1/forbidden\"",
        &[&fixture.allowed],
    );
    let mut child = child_command(&prepared(&execution), &execution)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut reader = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    assert_eq!(line, "ready\n");
    fixture.replace_root();
    child.stdin.take().unwrap().write_all(b"go\n").unwrap();
    child.stdout = Some(reader.into_inner());
    denied(&child.wait_with_output().unwrap());
    assert!(!fixture.outside.join("forbidden").exists());
}

#[test]
fn sandbox_cannot_be_replaced_and_caller_arguments_cannot_be_options() {
    let fixture = Fixture::new();
    let execution = fixture.execution(vec![
        "/usr/bin/sandbox-exec".into(),
        "-p".into(),
        "(version 1)(allow default)".into(),
        "/bin/cat".into(),
        fixture.outside.join("fixture").to_str().unwrap().into(),
    ]);
    denied(&run(&prepared(&execution), &execution));
    let execution = fixture.execution(vec!["-p".into(), "(version 1)(allow default)".into()]);
    denied(&run(&prepared(&execution), &execution));
}

#[test]
fn resolved_system_python_reads_workspace_without_expanding_file_permissions() {
    let fixture = Fixture::new();
    let execution = fixture.execution(vec![
        areal_runtime_host_tools::system_python()
            .unwrap()
            .to_str()
            .unwrap()
            .into(),
        "-I".into(),
        "-B".into(),
        "-c".into(),
        "import json,pathlib,sys; print(json.dumps(pathlib.Path(sys.argv[1]).read_text()))".into(),
        fixture.allowed.join("fixture").to_str().unwrap().into(),
    ]);
    let output = run(&prepared(&execution), &execution);
    assert!(output.status.success(), "{output:?}");
    assert_eq!(output.stdout, b"\"allowed-fixture\"\n");
    let mut outside = execution.clone();
    *outside.argv.last_mut().unwrap() = fixture.outside.join("fixture").to_str().unwrap().into();
    denied(&run(&prepared(&outside), &outside));
}

#[test]
fn versioned_xcode_python_policy_preserves_framework_boundary() {
    let fixture = Fixture::new();
    for (app, allowed) in [
        ("Xcode.app", true),
        ("Xcode_16.4.app", true),
        ("Xcode_26.0.1.app", true),
        ("Xcode_evil.app", false),
        ("Xcode_16..4.app", false),
    ] {
        let framework = format!("{app}/Contents/Developer/Library/Frameworks/Python3.framework");
        let python = format!("/Applications/{framework}/Versions/3.9/bin/python3.9");
        assert_eq!(
            areal_runtime_host_tools::is_macos_system_python(Path::new(&python)),
            allowed
        );
        let local = fixture.root.join(&framework);
        fs::create_dir_all(&local).unwrap();
        let program = local.join("python-fixture");
        fs::write(&program, "#!/bin/sh\nprintf python-fixture").unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
        let execution = fixture.execution(vec![program.to_str().unwrap().into()]);
        let mut argv = prepared(&execution);
        // 在临时树中执行同一策略，覆盖 CI 的版本目录；不修改系统 Xcode 或选择器。
        let policy = argv.iter().position(|arg| arg == "-p").unwrap() + 1;
        argv[policy] = argv[policy].replace(
            "Applications",
            escape(fixture.root.to_str().unwrap()).trim_start_matches('/'),
        );
        let output = run(&argv, &execution);
        assert_eq!(output.status.success(), allowed, "{app}: {output:?}");
        if allowed {
            assert_eq!(output.stdout, b"python-fixture");
            let sibling = local.with_file_name("Python3.framework-sibling");
            fs::create_dir(&sibling).unwrap();
            fs::write(sibling.join("secret"), "outside-fixture").unwrap();
            for code in [
                format!("cat '{}'", sibling.join("secret").display()),
                format!("printf forbidden > '{}/new-file'", local.display()),
            ] {
                let denied_execution = fixture.shell(&code, &[]);
                let mut denied_argv = prepared(&denied_execution);
                denied_argv[policy] = argv[policy].clone();
                denied(&run(&denied_argv, &denied_execution));
            }
            assert!(!local.join("new-file").exists());
        }
        assert!(!areal_runtime_host_tools::is_macos_system_python(
            Path::new(&format!("/Applications/{framework}-sibling/bin/python3"))
        ));
    }
}

#[test]
fn full_access_executes_host_commands_but_narrowed_scopes_stay_sandboxed() {
    let fixture = Fixture::new();
    let mut execution = fixture.shell(
        "printf host > \"$1/new\" && cat \"$1/new\"",
        &[&fixture.outside],
    );
    execution.read_roots = vec![PathBuf::from("/")];
    execution.write_roots = vec![PathBuf::from("/")];
    execution.scope_access = ScopeAccess::Unrestricted;
    execution.network = areal_runtime_protocol::NetworkRequest::Inherit;
    let argv = command(&execution, Profile::FullAccess).unwrap();
    assert_eq!(argv, execution.argv);
    let output = run(&argv, &execution);
    assert!(output.status.success(), "{output:?}");
    assert_eq!(output.stdout, b"host");
    fs::remove_file(fixture.outside.join("new")).unwrap();
    execution.write_roots = vec![fixture.allowed.clone()];
    execution.scope_access = ScopeAccess::Restricted;
    let argv = command(&execution, Profile::FullAccess).unwrap();
    assert_eq!(argv[0], "/usr/bin/sandbox-exec");
    assert!(!run(&argv, &execution).status.success());
    assert!(!fixture.outside.join("new").exists());
    execution.write_roots = vec![PathBuf::from("/")];
    execution.network = areal_runtime_protocol::NetworkRequest::Deny;
    assert_eq!(
        command(&execution, Profile::FullAccess).unwrap()[0],
        "/usr/bin/sandbox-exec"
    );
}
