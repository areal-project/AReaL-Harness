#!/usr/bin/env python3
"""Trusted local launcher: owns Core/Runtime and optionally their terminal client."""

import argparse
import contextlib
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import threading
from pathlib import Path

CORE_OPTIONS = (
    "permissions",
    "config",
    "data_dir",
    "listen",
    "model_endpoint",
    "model",
    "model_provider",
    "model_protocol",
    "api_key_env",
    "model_concurrency",
    "max_threads",
    "log_filter",
    "max_active_turns",
    "max_children_per_turn",
    "max_agent_depth",
)

TUI_OPTIONS = ("theme", "color", "tui_config", "no_logo", "ascii", "mouse")


def tui_arguments(args):
    """仅透传客户端选项，保持显式 false 和含空格路径。"""
    return [
        "--" + name.replace("_", "-") + "=" + str(getattr(args, name))
        for name in TUI_OPTIONS
        if getattr(args, name) is not None
    ]


def core_arguments(args):
    """Preserve absence: Core owns defaults, env aliases and TOML precedence."""
    return [
        part
        for name in CORE_OPTIONS
        if getattr(args, name) is not None
        for part in ("--" + name.replace("_", "-"), str(getattr(args, name)))
    ]


def finish(child, timeout=10):
    """Wait for graceful shutdown, then bound cleanup even for a stuck child."""
    try:
        return child.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        child.kill()
        return child.wait()


def reap_children(children):
    for child in reversed(children):
        if child.poll() is None:
            child.terminate()
            finish(child)


def main():
    parser = argparse.ArgumentParser(
        prog="areal" if "--tui" in sys.argv[1:] else "areal serve", description=__doc__
    )
    parser.add_argument("--bin-dir", type=Path)
    parser.add_argument("--parent-pid", type=int)
    parser.add_argument("--workspace", type=Path)
    parser.add_argument("--scratch", type=Path)
    parser.add_argument("--input-error-file", type=Path)
    parser.add_argument("--read-only-path", action="append", default=[])
    parser.add_argument("--allow-write", action="store_true")
    parser.add_argument("--task-credential-command", action="append", default=[])
    parser.add_argument("--runtime-max-processes", type=int, default=4)
    parser.add_argument("--runtime-max-scopes", type=int, default=256)
    parser.add_argument("--runtime-max-operations", type=int, default=4096)
    parser.add_argument("--workgroup-policy", type=Path)
    parser.add_argument("--workgroup-toolchain", type=Path)
    parser.add_argument("--allow-network", action="store_true")
    parser.add_argument("--allow-concurrent-writes", action="store_true")
    parser.add_argument("--command-timeout-ms", type=int, default=300000)
    parser.add_argument("--desktop-process-timeout-ms", type=int)
    parser.add_argument("--command-output-bytes", type=int, default=8 * 1024 * 1024)
    parser.add_argument("--runtime-output-bytes", type=int)
    parser.add_argument(
        "--sandbox-profile",
        choices=("native", "outer-container-perf", "full-access"),
        default="full-access",
    )
    for name in CORE_OPTIONS:
        parser.add_argument("--" + name.replace("_", "-"))
    parser.add_argument("--tui", action="store_true")
    parser.add_argument("--desktop", action="store_true")
    parser.add_argument("--no-deployment-mcp", action="store_true")
    parser.add_argument("--management", action="store_true")
    parser.add_argument("--ready-file", type=Path)
    parser.add_argument("--ready-metadata-file", type=Path)
    parser.add_argument("--auth-file", type=Path)
    parser.add_argument("--desktop-config", type=Path)
    parser.add_argument("--agent")
    parser.add_argument("--service-info", type=Path)
    parser.add_argument("--startup-timeout", type=float, default=30)
    parser.add_argument("--resume")
    headless = parser.add_mutually_exclusive_group()
    headless.add_argument("--initial-prompt")
    headless.add_argument("--prompt")
    headless.add_argument("--goal")
    parser.add_argument("--goal-token-budget", type=int)
    headless.add_argument("--input-file", type=Path)
    parser.add_argument("--theme", choices=("dark", "light", "terminal"))
    parser.add_argument("--color", choices=("auto", "always", "never"))
    parser.add_argument("--tui-config")
    parser.add_argument("--no-logo", choices=("true", "false"), nargs="?", const="true")
    parser.add_argument("--ascii", choices=("true", "false"), nargs="?", const="true")
    parser.add_argument("--mouse", choices=("true", "false"), nargs="?", const="true")
    args = parser.parse_args()
    if not 1 <= args.runtime_max_processes <= 4294967295:
        parser.error("runtime max processes must be 1..4294967295")
    if not 1 <= args.runtime_max_operations <= 4294967295:
        parser.error("runtime max operations must be 1..4294967295")
    if args.runtime_output_bytes is not None and not (
        args.command_output_bytes <= args.runtime_output_bytes <= 16 * 1024**3
    ):
        parser.error("runtime output budget must cover one command and be at most 16 GiB")
    if args.desktop and args.tui:
        parser.error("--desktop and --tui are mutually exclusive")
    if args.desktop_process_timeout_ms is not None and (
        not args.desktop or not 1 <= args.desktop_process_timeout_ms <= 86400000
    ):
        parser.error("desktop process timeout requires --desktop and must be 1..86400000 ms")
    if not 0 < args.startup_timeout <= 300:
        parser.error("startup timeout must be 0..300 seconds")
    for ready_path in (args.ready_file, args.ready_metadata_file):
        if ready_path is not None and ready_path.exists():
            parser.error(f"ready output already exists: {ready_path}")
    if args.sandbox_profile == "full-access":
        args.allow_write = True
        args.allow_network = True
    if args.workgroup_policy and not args.allow_write:
        parser.error("--workgroup-policy requires --allow-write")
    if args.workgroup_toolchain and not args.workgroup_policy:
        parser.error("--workgroup-toolchain requires --workgroup-policy")
    if (
        not 1 <= args.command_timeout_ms <= 86400000
        or not 1 <= args.command_output_bytes <= 64 * 1024 * 1024
    ):
        parser.error("command timeout must be 1..86400000 ms and output budget 1..67108864 bytes")
    if not args.tui and args.workspace is None:
        parser.error("--workspace is required without --tui")
    if not args.tui and (
        args.resume is not None
        or args.initial_prompt is not None
        or args.prompt is not None
        or args.goal is not None
        or args.input_file is not None
    ):
        parser.error("--resume, --initial-prompt, --prompt, --goal and --input-file require --tui")
    if args.goal_token_budget is not None and (args.goal is None or args.goal_token_budget <= 0):
        parser.error("--goal-token-budget requires --goal and a positive integer")
    if not args.tui and tui_arguments(args):
        parser.error("client appearance options require --tui")
    workspace = (args.workspace or Path.cwd()).resolve()
    if not workspace.is_dir():
        parser.error("workspace must be a directory")
    scratch = args.scratch.resolve() if args.scratch else None
    if scratch and (
        not scratch.is_dir()
        or scratch.is_relative_to(workspace)
        or workspace.is_relative_to(scratch)
    ):
        parser.error("scratch must be an existing directory disjoint from the workspace")
    binary = (args.bin_dir or Path(__file__).resolve().parents[1] / "target/debug").resolve()
    # Homebrew 的 bin 入口是文件符号链接，必须先定位实际安装目录。
    binary = (binary / "areal").resolve().parent
    # 安装包只暴露 areal；Runtime 仍以独立进程执行并沿用私有管道边界。
    runtime_bin = binary.parent / "libexec/areal"
    if not runtime_bin.is_dir():
        runtime_bin = binary
    paths = [
        binary / "areal",
        runtime_bin / "areal-runtime",
        runtime_bin / "areal-runtime-fs",
    ]
    if sys.platform == "linux":
        paths.append(runtime_bin / "areal-runtime-reaper")
    for path in paths:
        if not path.is_file() or not os.access(path, os.X_OK):
            parser.error(
                f"executable missing: {path}; run make build or install all Harness binaries together"
            )
    # A locally owned session uses an ephemeral listener; standalone mode retains
    # the Core configuration. All other defaults/precedence belong to Rust.
    if (args.tui or args.desktop) and args.listen is None:
        args.listen = "127.0.0.1:0"
    overrides = core_arguments(args)
    if args.management or args.desktop:
        overrides.append("--management")
    if args.no_deployment_mcp:
        overrides.append("--no-deployment-mcp")
    core_env = os.environ.copy()
    # Reuse the Rust parser for preflight; no Python copy of TOML/env semantics.
    checked = subprocess.run(
        [str(paths[0]), "config", "show", *overrides],
        env=core_env,
        text=True,
        stdout=subprocess.PIPE,
        check=False,
    )
    if checked.returncode:
        return checked.returncode
    config = json.loads(checked.stdout)
    data = Path(config["server"]["data_dir"]).resolve()
    if data.is_relative_to(workspace):
        parser.error("Core data must be outside the execution workspace")
    if scratch is None:
        scratch = data.parent / "scratch"
        scratch.mkdir(parents=True, exist_ok=True, mode=0o700)
        scratch = scratch.resolve()
    if (
        scratch.is_relative_to(workspace)
        or workspace.is_relative_to(scratch)
        or data.is_relative_to(scratch)
        or scratch.is_relative_to(data)
    ):
        parser.error("scratch must be disjoint from workspace and Core data")
    if args.sandbox_profile != "full-access":
        for path in paths:
            if (
                args.allow_write and path.resolve().is_relative_to(workspace)
            ) or path.resolve().is_relative_to(scratch):
                parser.error(
                    "trusted binaries must exist outside the writable workspace and scratch"
                )
    children = []
    stopping = False

    def owner_alive():
        return args.parent_pid is None or os.getppid() == args.parent_pid

    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    request_read, request_write = os.pipe()
    response_read, response_write = os.pipe()
    lifetime_read, lifetime_write = os.pipe()
    descriptors = {
        request_read,
        request_write,
        response_read,
        response_write,
        lifetime_read,
        lifetime_write,
    }

    def close(*fds):
        for fd in fds:
            os.close(fd)
            descriptors.discard(fd)

    terminal_state = None
    log = None

    def restore_terminal():
        nonlocal terminal_state
        if terminal_state is not None:
            import termios

            termios.tcsetattr(sys.stdin.fileno(), termios.TCSANOW, terminal_state)
            terminal_state = None
            if args.prompt is None and args.goal is None and args.input_file is None:
                # Restore even when the client died before ratatui could do so.
                sys.stderr.write("\x1b[?1049l\x1b[?25h")
                sys.stderr.flush()

    log_lock = threading.Lock()
    log_reader = None
    log_pipe = None
    try:
        if args.tui or args.desktop:
            # Keep service diagnostics out of the full-screen terminal. Unique files avoid
            # truncating another launch's log when the data directory lock rejects us.
            data.mkdir(parents=True, exist_ok=True, mode=0o700)
            log = tempfile.NamedTemporaryFile(
                prefix="launch-", suffix=".log", dir=data, delete=False
            )
            print(
                f"Local Harness: {workspace}\nService log: {log.name}",
                file=sys.stderr,
                flush=True,
            )
        diagnostics = sys.stderr
        if log is not None:
            log_read, log_write = os.pipe()
            log_pipe = log_write

            def capture():
                with os.fdopen(log_read, "rb", buffering=0) as source:
                    while chunk := source.read(8192):
                        with log_lock:
                            if log.tell() + len(chunk) > 1024 * 1024:
                                log.seek(0)
                                log.truncate()
                            log.write(chunk)
                            log.flush()

            log_reader = threading.Thread(target=capture, daemon=True)
            log_reader.start()
            diagnostics = log_write
        with (
            tempfile.TemporaryDirectory(prefix="areal-launch-") as temporary,
            contextlib.ExitStack() as processes,
        ):
            # 启动中断时子进程仍可能写就绪文件；必须先回收进程，再删除临时目录。
            processes.callback(reap_children, children)
            ready = args.ready_file or Path(temporary) / "ready"
            metadata = args.ready_metadata_file or Path(temporary) / "ready.json"
            runtime = subprocess.Popen(
                [
                    str(paths[1]),
                    "--workspace",
                    str(workspace),
                    *(["--scratch", str(scratch)] if scratch else []),
                    *(
                        value
                        for path in args.read_only_path
                        for value in ["--read-only-path", path]
                    ),
                    "--file-helper",
                    str(paths[2]),
                    "--wall-time-ms",
                    str(max(args.command_timeout_ms, args.desktop_process_timeout_ms or 0)),
                    "--output-bytes",
                    str(args.command_output_bytes),
                    *(
                        ["--cumulative-output-bytes", str(args.runtime_output_bytes)]
                        if args.runtime_output_bytes is not None
                        else []
                    ),
                    "--max-processes",
                    str(args.runtime_max_processes),
                    "--max-scopes",
                    str(args.runtime_max_scopes),
                    "--max-operations",
                    str(args.runtime_max_operations),
                    *[
                        part
                        for command in args.task_credential_command
                        for part in ("--task-credential-command", command)
                    ],
                    "--output-window-bytes",
                    str(min(args.command_output_bytes, 8 * 1024 * 1024)),
                    *(["--allow-network"] if args.allow_network else []),
                    *(["--allow-concurrent-writes"] if args.allow_concurrent_writes else []),
                    *(["--sandbox-profile", args.sandbox_profile] if args.sandbox_profile else []),
                    *(["--allow-write"] if args.allow_write else []),
                ],
                stdin=request_read,
                stdout=response_write,
                stderr=diagnostics,
                env={
                    **{
                        name: os.environ[name]
                        for name in ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM")
                        if name in os.environ
                    },
                    **{
                        name: os.environ[name]
                        for name in (
                            "MULTICA_TOKEN",
                            "MULTICA_TASK_ID",
                            "MULTICA_AGENT_ID",
                            "MULTICA_WORKSPACE_ID",
                            "MULTICA_SERVER_URL",
                            "MULTICA_RUNTIME_PROVIDER",
                        )
                        if args.task_credential_command and name in os.environ
                    },
                },
            )
            children.append(runtime)
            print(f"AReaL launcher Runtime PID: {runtime.pid}", file=sys.stderr, flush=True)
            close(request_read, response_write)
            core = subprocess.Popen(
                [
                    str(paths[0]),
                    "app-server",
                    "--runtime-stdio",
                    *(
                        ["--command-timeout-ms", str(args.command_timeout_ms)]
                        if args.desktop_process_timeout_ms is not None
                        else []
                    ),
                    "--supervisor-fd",
                    str(lifetime_read),
                    "--workspace",
                    str(workspace),
                    *(["--command-scratch", str(scratch)] if scratch else []),
                    *overrides,
                    *(["--service-info", str(args.service_info)] if args.service_info else []),
                    *(
                        ["--workgroup-policy", str(args.workgroup_policy.resolve())]
                        if args.workgroup_policy
                        else []
                    ),
                    *(
                        ["--workgroup-toolchain", str(args.workgroup_toolchain.resolve())]
                        if args.workgroup_toolchain
                        else []
                    ),
                    "--ready-file",
                    str(ready),
                    "--ready-metadata-file",
                    str(metadata),
                    *(["--auth-file", str(args.auth_file)] if args.auth_file else []),
                    *(
                        ["--desktop-config", str(args.desktop_config)]
                        if args.desktop_config
                        else []
                    ),
                    *(["--allow-write"] if args.allow_write else []),
                ],
                stdin=response_read,
                stdout=request_write,
                stderr=diagnostics,
                env=core_env,
                pass_fds=(lifetime_read,),
            )
            children.append(core)
            print(f"AReaL launcher Core PID: {core.pid}", file=sys.stderr, flush=True)
            close(response_read, request_write, lifetime_read)
            # Neither parent retains an extra writer: Core death reaches Runtime as EOF.
            tui = None
            client_code = 0
            deadline = time.monotonic() + args.startup_timeout
            while not (ready.exists() and metadata.exists()):
                if stopping or not owner_alive():
                    return 0
                if core.poll() is not None or runtime.poll() is not None:
                    raise RuntimeError("local Harness stopped before becoming ready")
                if time.monotonic() >= deadline:
                    raise RuntimeError("local Harness startup timed out")
                time.sleep(0.05)
            if args.tui:
                if sys.stdin.isatty():
                    import termios

                    terminal_state = termios.tcgetattr(sys.stdin.fileno())
                tui = subprocess.Popen(
                    [
                        str(paths[0]),
                        "--endpoint",
                        ready.read_text(),
                        "--auth-file",
                        json.loads(metadata.read_text())["authFile"],
                        *([f"--resume={args.resume}"] if args.resume is not None else []),
                        *([f"--agent={args.agent}"] if args.agent is not None else []),
                        *([f"--prompt={args.prompt}"] if args.prompt is not None else []),
                        *([f"--goal={args.goal}"] if args.goal is not None else []),
                        *(
                            [f"--goal-token-budget={args.goal_token_budget}"]
                            if args.goal_token_budget is not None
                            else []
                        ),
                        *tui_arguments(args),
                        *(["--input-file", str(args.input_file)] if args.input_file else []),
                        *(
                            ["--input-error-file", str(args.input_error_file)]
                            if args.input_error_file
                            else []
                        ),
                        *(["--", args.initial_prompt] if args.initial_prompt is not None else []),
                    ]
                )
                children.append(tui)
            while (
                core.poll() is None
                and runtime.poll() is None
                and not stopping
                and owner_alive()
                and (tui is None or tui.poll() is None)
            ):
                time.sleep(0.05)
            if tui is not None:
                if tui.poll() is None:
                    tui.terminate()
                client_code = finish(tui)
                restore_terminal()
            if core.poll() is None:
                core.terminate()
            core_code = finish(core, 15)
            # A graceful Core closes its private pipes, allowing Runtime to clean up.
            runtime_code = finish(runtime, 20)
            if runtime_code:
                print(f"Runtime cleanup failed (exit {runtime_code})", file=sys.stderr)
            code = 0 if core_code == 0 and runtime_code == 0 and client_code == 0 else 1
            if code and log is not None:
                raise RuntimeError("local Harness or TUI failed")
            return code
    except (OSError, RuntimeError) as error:
        print(
            json.dumps(
                {"state": "failed", "reason": str(error), "logFile": log.name if log else None}
            ),
            file=sys.stderr,
        )
        if log is not None:
            with log_lock:
                log.seek(0, os.SEEK_END)
                log.seek(max(0, log.tell() - 32768))
                print(log.read().decode(errors="replace"), file=sys.stderr)
                log.seek(0, os.SEEK_END)
        return 1
    finally:
        for ready_path in (args.ready_file, args.ready_metadata_file):
            if ready_path is not None:
                ready_path.unlink(missing_ok=True)
        for fd in descriptors:
            os.close(fd)
        reap_children(children)
        restore_terminal()
        if log_pipe is not None:
            os.close(log_pipe)
        if log_reader is not None:
            log_reader.join(timeout=2)
        if log is not None:
            log.close()
            # 固定最多八份日志；不因每次桌面启动无限增长。
            logs = sorted(data.glob("launch-*.log"), key=lambda p: p.stat().st_mtime, reverse=True)
            for previous in logs[8:]:
                previous.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
