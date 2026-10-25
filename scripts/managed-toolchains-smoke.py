#!/usr/bin/env python3
"""隔离 HOME/最小 PATH 下的真实 Runtime 工具链回归；不联网、不安装工具。"""

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import time

MODULE = importlib.util.spec_from_file_location(
    "runtime_smoke", Path(__file__).with_name("runtime-smoke.py")
)
runtime_smoke = importlib.util.module_from_spec(MODULE)
MODULE.loader.exec_module(runtime_smoke)


def write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


def copy_install(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    if os.uname().sysname == "Darwin":
        subprocess.run(["/bin/cp", "-cR", str(source), str(destination)], check=True)
    elif source.is_dir():
        shutil.copytree(source, destination, symlinks=True)
    else:
        shutil.copy2(source, destination)


def fixture(root, name, node, npm, pnpm):
    home, repo, scratch = (root / part for part in ("home", "repo", "scratch"))
    for path in (home, repo, scratch):
        path.mkdir(parents=True)
    write(home / ".ssh/private", "PRIVATE_SENTINEL")
    write(repo / "source", "keep")
    env = {"HOME": str(home), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "PRIVATE_TOKEN": "secret"}
    paths = {
        "nvm": ".nvm/versions/node/v23.11.0",
        "nvm-custom": "custom manager/versions/node/v23.11.0",
        "mise": ".local/share/mise/installs/node/23.11.0",
        "mise-custom": "custom mise installs/node/23.11.0",
        "fnm": ".local/share/fnm/node-versions/v23.11.0/installation",
        "asdf": ".asdf/installs/nodejs/23.11.0",
        "volta": ".volta/tools/image/node/23.11.0",
        "pyenv": ".pyenv/versions/3.13.1",
        "rustup": ".rustup/toolchains/stable-test-target",
        "user-cli": ".local",
    }
    install = home / paths[name]
    (install / "bin").mkdir(parents=True)
    write(install / "lib/resource", name)
    probe = install / "bin/managed-probe"
    probe.write_text(f"#!/bin/sh\n/bin/cat {shlex.quote(str(install / 'lib/resource'))}\n")
    probe.chmod(0o755)
    if name == "user-cli":
        # 独立 CLI 只有 bin；不能借此开放整个 .local。
        probe.write_text(f"#!/bin/sh\nprintf '%s' {shlex.quote(name)}\n")
    if name.startswith("nvm"):
        base = home / (".nvm" if name == "nvm" else "custom manager")
        write(base / "alias/default", "23\n")
        if name.endswith("custom"):
            env["NVM_DIR"] = str(base)
    elif name.startswith("mise"):
        write(
            home / ".config/mise/config.toml",
            "[tools]\nnode = '23'\n[env]\nPRIVATE_TOKEN = 'do-not-export'\n",
        )
        if name.endswith("custom"):
            env["MISE_INSTALLS_DIR"] = str(home / "custom mise installs")
        # 验证显式 shim 位序在受限执行中被实际安装替换。
        shim = home / ".local/share/mise/shims"
        shim.mkdir(parents=True)
        env["PATH"] = f"{shim}:{env['PATH']}"
    elif name == "fnm":
        base = home / ".local/share/fnm"
        env["FNM_DIR"] = str(base)
        (base / "aliases").mkdir()
        (base / "aliases/default").symlink_to(install)
    elif name == "asdf":
        write(home / ".tool-versions", "nodejs 23.11.0\n")
    elif name == "volta":
        write(home / ".volta/tools/user/platform.json", '{"node":"23.11.0"}')
    elif name == "pyenv":
        write(home / ".pyenv/version", "3.13.1\n")
    elif name == "rustup":
        write(home / ".rustup/settings.toml", "default_toolchain = 'stable-test-target'\n")
    real_node = name in ("nvm", "mise")
    if real_node:
        copy_install(node, install / "bin/node")
        for tool, source, entry in [("npm", npm, "npm-cli.js"), ("pnpm", pnpm, "pnpm.cjs")]:
            copy_install(source, install / f"lib/node_modules/{tool}")
            (install / f"bin/{tool}").symlink_to(f"../lib/node_modules/{tool}/bin/{entry}")
        # 版本查询不经过测试 runner 和嵌套子进程，不能替代真实工具链验收。
        write(
            repo / "package.json",
            json.dumps(
                {
                    "private": True,
                    "scripts": {"test": "node --test --test-reporter=tap child.test.cjs"},
                }
            ),
        )
        write(
            repo / "child.test.cjs",
            "const test=require('node:test'),assert=require('node:assert/strict');\n"
            "const {spawnSync}=require('node:child_process');\n"
            "test('child inherits managed Node',()=>{"
            "const child=spawnSync('node',['-p','process.execPath'],{encoding:'utf8'});"
            "assert.equal(child.status,0,JSON.stringify({signal:child.signal,stderr:child.stderr}));"
            "assert.equal(child.stdout.trim(),process.execPath);});\n",
        )
    return home, repo, scratch, install, env, real_node


def run_case(args, root, name, tools):
    started = time.monotonic()
    home, repo, scratch, install, env, real_node = fixture(root / name, name, *tools)
    startup = time.monotonic()
    runtime = runtime_smoke.Runtime(
        args.bin_dir / "areal-runtime",
        repo,
        ["--scratch", str(scratch), "--max-processes", "8", "--wall-time-ms", "10000"],
        env=env,
    )
    checks = []
    try:
        runtime.info = runtime.call("connection.open", {"protocolVersion": "areal.runtime.v0"})
        startup_ms = (time.monotonic() - startup) * 1000
        child = runtime.call(
            "scope.create",
            {
                "operationId": runtime.op(),
                "parentScopeId": runtime.info["rootScopeId"],
                "owner": {"taskId": name},
                "permissions": {
                    "readRoots": ["workspace://repo", "workspace://scratch"],
                    "writeRoots": ["workspace://scratch"],
                    "network": "deny",
                },
            },
        )["scopeId"]
        for scope_name, scope in [("parent", runtime.info["rootScopeId"]), ("child", child)]:
            probes = [("installed-tool", "managed-probe", True, name)]
            if real_node:
                probes.extend(
                    [
                        (
                            "node-install",
                            "node -p process.execPath",
                            True,
                            str(install / "bin/node"),
                        ),
                        ("npm", "npm --version", True, None),
                        ("pnpm", "pnpm --version", True, None),
                        (
                            "node-test-child",
                            "node --test --test-reporter=tap child.test.cjs",
                            True,
                            None,
                        ),
                        ("npm-test-child", "npm test", True, None),
                        ("pnpm-test-child", "pnpm test", True, None),
                    ]
                )
            probes.extend(
                [
                    (
                        "scratch",
                        'test -n "$HOME" && test "$HOME" = "$TMPDIR" && test -z "$PRIVATE_TOKEN" && printf ok > "$TMPDIR/test"',
                        True,
                        None,
                    ),
                    ("credentials", f"cat {shlex.quote(str(home / '.ssh/private'))}", False, None),
                    (
                        "toolchain-write",
                        f"printf bad > {shlex.quote(str(install / 'bin/managed-probe'))}",
                        False,
                        None,
                    ),
                ]
            )
            if scope_name == "child":
                probes.append(("source-write", "printf bad > source", False, None))
                if real_node:
                    probes.append(
                        (
                            "network",
                            'node -e \'require("node:net").createServer().listen(0,"127.0.0.1")\'',
                            False,
                            None,
                        )
                    )
            for label, command, allowed, expected in probes:
                process = runtime.start(scope, command)
                result = runtime.call("process.wait", {"processId": process})
                output = runtime.output(process)
                content = b"".join(
                    base64.b64decode(chunk["dataBase64"]) for chunk in output["chunks"]
                ).decode(errors="replace")
                passed = (result["exitCode"] == 0) == allowed and result["cleanupConfirmed"]
                if expected is not None:
                    passed = passed and content.strip() == expected
                if label.endswith("-test-child"):
                    passed = passed and {"# tests 1", "# pass 1", "# fail 0"}.issubset(
                        content.splitlines()
                    )
                checks.append(
                    {
                        "scope": scope_name,
                        "probe": label,
                        "allowed": allowed,
                        "pass": passed,
                        "result": result,
                        "output": content,
                    }
                )
        closed = runtime.call("connection.close", {})
        assert closed["closed"] is True
        assert (repo / "source").read_text() == "keep"
        return {
            "case": name,
            "seconds": time.monotonic() - started,
            "startupMs": startup_ms,
            "checks": checks,
            "environment": runtime.info["capabilities"].get("commandEnvironment"),
            "pass": all(c["pass"] for c in checks),
        }
    except Exception as error:
        return {
            "case": name,
            "seconds": time.monotonic() - started,
            "checks": checks,
            "pass": False,
            "error": str(error),
        }
    finally:
        runtime.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bin-dir", type=Path, default=Path("target/debug"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--npm-package", type=Path, required=True)
    parser.add_argument("--pnpm-package", type=Path, required=True)
    args = parser.parse_args()
    args.bin_dir = args.bin_dir.resolve()
    tools = [args.node.resolve(), args.npm_package.resolve(), args.pnpm_package.resolve()]
    assert all(p.exists() for p in tools), "使用本机已有工具，不下载测试依赖"
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="areal-managed-tools-") as temp:
        with ThreadPoolExecutor(max_workers=8) as pool:
            cases = [
                "nvm",
                "nvm-custom",
                "mise",
                "mise-custom",
                "fnm",
                "asdf",
                "volta",
                "pyenv",
                "rustup",
                "user-cli",
            ]
            results = list(
                pool.map(lambda name: run_case(args, Path(temp).resolve(), name, tools), cases)
            )
    report = {
        "seconds": time.monotonic() - started,
        "concurrency": 8,
        "rounds": 1,
        "liveModelCalls": 0,
        "results": results,
        "pass": all(r["pass"] for r in results),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({k: v for k, v in report.items() if k != "results"}))
    for result in results:
        print(result["case"], "PASS" if result["pass"] else "FAIL", result.get("error", ""))
    raise SystemExit(0 if report["pass"] else 1)


if __name__ == "__main__":
    main()
