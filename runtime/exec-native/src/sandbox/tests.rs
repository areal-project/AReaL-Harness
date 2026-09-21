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
            trusted_executable: None,
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
