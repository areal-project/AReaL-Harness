#!/usr/bin/env python3
"""通过真实 Runtime 验证受限 Rust 离线编译、链接及只读子作用域。"""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile

MODULE = importlib.util.spec_from_file_location(
    "runtime_smoke", Path(__file__).with_name("runtime-smoke.py")
)
runtime_smoke = importlib.util.module_from_spec(MODULE)
MODULE.loader.exec_module(runtime_smoke)


def check(binary):
    with tempfile.TemporaryDirectory(prefix="areal-native-rust-") as temporary:
        root = Path(temporary).resolve()
        workspace, scratch = root / "workspace", root / "scratch"
        (workspace / "src").mkdir(parents=True)
        scratch.mkdir()
        (workspace / "Cargo.toml").write_text(
            '[package]\nname = "native-rust-probe"\nversion = "0.1.0"\nedition = "2021"\n'
        )
        (workspace / "src/main.rs").write_text('fn main() { println!("RUST_RUNTIME_OK"); }\n')
        (root / "private").write_text("PRIVATE_SENTINEL")
        environment = os.environ.copy()
        environment["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
        runtime = runtime_smoke.Runtime(
            binary,
            workspace,
            ("--scratch", str(scratch), "--wall-time-ms", "60000"),
            env=environment,
        )
        results = []
        try:
            runtime.info = runtime.call("connection.open", {"protocolVersion": "areal.runtime.v0"})
            for local_git in (False, True):
                if local_git:
                    dependency = workspace / "dependency"
                    (dependency / "src").mkdir(parents=True)
                    (dependency / "Cargo.toml").write_text(
                        '[package]\nname = "local-dependency"\nversion = "0.1.0"\nedition = "2021"\n'
                    )
                    (dependency / "src/lib.rs").write_text("pub fn value() -> u8 { 42 }\n")
                    git_environment = environment | {
                        "GIT_CONFIG_GLOBAL": "/dev/null",
                        "GIT_CONFIG_NOSYSTEM": "1",
                    }
                    for arguments in [
                        ["init", "-q"],
                        ["add", "."],
                        [
                            "-c",
                            "user.name=Fixture",
                            "-c",
                            "user.email=fixture@example.invalid",
                            "-c",
                            "core.hooksPath=/dev/null",
                            "commit",
                            "-qm",
                            "fixture",
                        ],
                    ]:
                        subprocess.run(
                            ["/usr/bin/git", *arguments],
                            cwd=dependency,
                            env=git_environment,
                            check=True,
                            capture_output=True,
                        )
                    with (workspace / "Cargo.toml").open("a") as manifest:
                        manifest.write(
                            f'\n[dependencies]\nlocal-dependency = {{ git = "{dependency.as_uri()}" }}\n'
                        )
                    (workspace / "src/main.rs").write_text(
                        "fn main() { assert_eq!(local_dependency::value(), 42); "
                        'println!("RUST_RUNTIME_OK"); }\n'
                    )
                source = (workspace / "src/main.rs").read_text()
                for readonly in (False, True):
                    scope = (
                        runtime.scope()
                        if not readonly
                        else runtime.call(
                            "scope.create",
                            {
                                "operationId": runtime.op(),
                                "parentScopeId": runtime.info["rootScopeId"],
                                "owner": {"taskId": "readonly-rust"},
                                "permissions": {
                                    "readRoots": ["workspace://repo", "workspace://scratch"],
                                    "writeRoots": ["workspace://scratch"],
                                    "network": "deny",
                                },
                            },
                        )["scopeId"]
                    )
                    target = scratch / f"target-{local_git}-{readonly}"
                    offline = "--offline" if readonly or not local_git else ""
                    command = (
                        f"CARGO_HOME={shlex.quote(str(scratch / 'cargo'))} "
                        f"cargo build {offline} --target-dir {shlex.quote(str(target))} "
                        f"&& {shlex.quote(str(target / 'debug/native-rust-probe'))}"
                    )
                    process = runtime.start(scope, command, {"wallTimeMs": 60_000})
                    result = runtime.call("process.wait", {"processId": process})
                    output = runtime_smoke.text(runtime.output(process)).decode(errors="replace")
                    record = {
                        "localGitDependency": local_git,
                        "readonly": readonly,
                        "exitCode": result["exitCode"],
                        "output": output,
                    }
                    results.append(record)
                    print(json.dumps(record, ensure_ascii=False), flush=True)
                    assert result["exitCode"] == 0 and "RUST_RUNTIME_OK" in output, record
                    assert result["cleanupConfirmed"], result
                    denied_commands = [f"cat {shlex.quote(str(root / 'private'))}"]
                    if readonly:
                        denied_commands.append("printf changed > src/main.rs")
                    for denied in denied_commands:
                        process = runtime.start(scope, denied)
                        result = runtime.call("process.wait", {"processId": process})
                        assert result["exitCode"] != 0, (denied, result)
                    assert (workspace / "src/main.rs").read_text() == source
            return results
        finally:
            runtime.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bin-dir", type=Path, required=True)
    args = parser.parse_args()
    check(args.bin_dir.resolve() / "areal-runtime")


if __name__ == "__main__":
    main()
