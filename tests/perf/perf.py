#!/usr/bin/env python3
"""Local Docker E2E and performance runner for AReaL-Harness."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import random
import re
import shlex
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import tomllib
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable
from urllib.parse import urlsplit, urlunsplit

from perf_metrics import (
    numeric as numeric,
    percentile as percentile,
    median as median,
    observed_tokens as observed_tokens,
    all_attempt_metrics as all_attempt_metrics,
    pairwise_comparisons as pairwise_comparisons,
    usage_total as usage_total,
    paired_comparisons as paired_comparisons,
    aggregate as aggregate,
    comparison as comparison,
)
from perf_report import (
    render_report as render_report,
    terminal_supports_color as terminal_supports_color,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
CASES_ROOT = REPO_ROOT / "tests" / "perf" / "cases"
PRO_ROOT = REPO_ROOT / "tests" / "perf" / "suites" / "pro"
DEFAULT_OUTPUT = REPO_ROOT / "target" / "perf"
DEFAULT_IMAGE = "areal-perf-runner:local"
DEFAULT_MODEL_CONFIG = REPO_ROOT / "tests" / "perf" / "model.toml"
DEFAULT_GATEWAY_IMAGE = "oaklight/llm-rosetta-gateway:0.13.0"
DEFAULT_BASE_IMAGE = "alpine:3.22.4"
DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org"
DEFAULT_CODEX_VERSION = "0.145.0"
DEFAULT_CLAUDE_CODE_VERSION = "2.1.273"
DEFAULT_DSH_VERSION = "0.1.2-alpha.5"
GATEWAY_PORT = 8765
IDENTIFIER = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
ENV_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
PROTOCOL_TYPES = {
    "completions": "openai_chat",
    "response": "openai_responses",
    "responses": "openai_responses",
    "anthropic": "anthropic",
}


class PerfError(RuntimeError):
    pass


def run_command(
    command: list[str], *, timeout: int | None = None, check: bool = True
) -> subprocess.CompletedProcess[str]:
    try:
        completed = subprocess.run(
            command, text=True, capture_output=True, timeout=timeout, check=False
        )
    except FileNotFoundError as error:
        raise PerfError(f"command not found: {command[0]}") from error
    except subprocess.TimeoutExpired as error:
        raise PerfError(f"command timed out: {command[0]}") from error
    if check and completed.returncode != 0:
        message = (
            completed.stderr.strip() or completed.stdout.strip() or f"exit {completed.returncode}"
        )
        raise PerfError(f"{command[0]} failed: {message}")
    return completed


def atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    temporary.replace(path)


def path_in(root: Path, relative: str, kind: str) -> Path:
    candidate = (root / relative).resolve()
    if candidate != root.resolve() and root.resolve() not in candidate.parents:
        raise PerfError(f"{kind} escapes task directory: {relative}")
    return candidate


def command_array(value: object, name: str) -> list[str]:
    if (
        not isinstance(value, list)
        or not value
        or not all(isinstance(item, str) and item for item in value)
    ):
        raise PerfError(f"{name} must be a non-empty string array")
    return value


def resolve_task(value: str) -> Path:
    if value == "lite":
        value = "python-fix-001"
    if value.startswith("pro/"):
        value = str(PRO_ROOT / "cases" / value.removeprefix("pro/"))
    supplied = Path(value)
    task_dir = supplied.resolve() if supplied.exists() else (CASES_ROOT / value).resolve()
    if not (task_dir / "task.toml").is_file():
        raise PerfError(f"task not found: {value}")
    return task_dir


def resolve_tasks(value: str, cases: list[str] | None = None) -> list[Path]:
    if cases and value != "pro":
        raise PerfError("--case is only supported with --task pro")
    if value != "pro":
        return [resolve_task(value)]
    benchmark = json.loads((PRO_ROOT / "benchmark.json").read_text())
    keys = [entry["env_ref"]["key"] for entry in benchmark["spec"]["env_refs"]]
    if cases:
        if len(cases) != len(set(cases)):
            raise PerfError("--case must not contain duplicate case IDs")
        unknown = sorted(set(cases) - set(keys))
        if unknown:
            raise PerfError("unknown pro case IDs: " + ", ".join(unknown))
        keys = [key for key in keys if key in cases]
    return [resolve_task(f"pro/{key}") for key in keys]


def load_task(task_dir: Path) -> dict[str, Any]:
    with (task_dir / "task.toml").open("rb") as handle:
        task = tomllib.load(handle)
    if task.get("schema_version") != 1:
        raise PerfError("task schema_version must be 1")
    task_id = task.get("id")
    if not isinstance(task_id, str) or not IDENTIFIER.fullmatch(task_id):
        raise PerfError("task id must be a lowercase filesystem-safe identifier")
    workspace_path = task.get("workspace", {}).get("path")
    prompt_path = task.get("prompt", {}).get("path")
    environment = task.get("environment")
    if environment is not None:
        if (
            not isinstance(environment, dict)
            or not isinstance(environment.get("image"), str)
            or not environment["image"]
        ):
            raise PerfError("environment.image must name the task image")
        if environment.get("platform") != "linux/amd64" or environment.get("workdir") != "/app":
            raise PerfError("pro environments require linux/amd64 and /app")
        if task.get("grader", {}).get("mode") != "reuse_agent":
            raise PerfError("pro environments require grader.mode=reuse_agent")
        source_path = path_in(task_dir, environment["source"], "environment source")
        source = json.loads(source_path.read_text())
        context = environment_context(task_dir, task)
        origin = json.loads((context / "origin.json").read_text())
        if (
            source["key"] != task_id
            or environment["image"] != f"areal-perf-env:{task_id}"
            or origin.get("source_env_sha256")
            != hashlib.sha256(source_path.read_bytes()).hexdigest()
        ):
            raise PerfError("environment must match its pinned EnvArena source")
    elif (
        not isinstance(workspace_path, str)
        or not path_in(task_dir, workspace_path, "workspace").is_dir()
    ):
        raise PerfError("workspace.path must name a directory inside the task")
    if not isinstance(prompt_path, str) or not path_in(task_dir, prompt_path, "prompt").is_file():
        raise PerfError("prompt.path must name a file inside the task")
    command_array(task.get("grader", {}).get("command"), "grader.command")
    grader_path = task.get("grader", {}).get("path", "grader")
    if not isinstance(grader_path, str) or not path_in(task_dir, grader_path, "grader").is_dir():
        raise PerfError("grader.path must name a directory inside the task")
    for relative in task.get("agent", {}).get("files", []):
        if (
            not isinstance(relative, str)
            or not path_in(task_dir, relative, "agent input").is_file()
        ):
            raise PerfError("agent.files entries must name files inside the task")
    limits = task.get("limits", {})
    timeout = limits.get("timeout_seconds", 300)
    cpus = limits.get("cpus", 2.0)
    pids = limits.get("pids", 256)
    memory = limits.get("memory", "2g")
    network = limits.get("network", "bridge")
    if not isinstance(timeout, int) or timeout < 1 or timeout > 86400:
        raise PerfError("limits.timeout_seconds must be 1..86400")
    if not isinstance(cpus, (int, float)) or cpus <= 0:
        raise PerfError("limits.cpus must be positive")
    if not isinstance(pids, int) or pids < 1:
        raise PerfError("limits.pids must be positive")
    if not isinstance(memory, str) or not re.fullmatch(r"[1-9][0-9]*(?:[bkmg])?", memory.lower()):
        raise PerfError("limits.memory must be a Docker memory value such as 2g")
    if network not in {"bridge", "none"}:
        raise PerfError("limits.network must be bridge or none")
    tolerance = task.get("comparison", {}).get("score_regression_tolerance", 0.0)
    if not isinstance(tolerance, (int, float)) or isinstance(tolerance, bool) or tolerance < 0:
        raise PerfError("comparison.score_regression_tolerance must be a non-negative number")
    for runner, config in task.get("runners", {}).items():
        if runner not in {"codex", "claudecode", "dsh"}:
            command_array(config.get("command"), f"runners.{runner}.command")
    for pattern in task.get("acceptance", {}).get("required_artifacts", []):
        if (
            not isinstance(pattern, str)
            or Path(pattern).is_absolute()
            or ".." in Path(pattern).parts
        ):
            raise PerfError(
                "required artifact patterns must stay inside the agent output directory"
            )
    return task


def load_model_config(path: Path, model_override: str | None = None) -> dict[str, Any]:
    if not path.is_file():
        raise PerfError(f"model config not found: {path}; start from tests/perf/model.example.toml")
    try:
        with path.open("rb") as handle:
            raw = tomllib.load(handle)
    except tomllib.TOMLDecodeError as error:
        raise PerfError(f"invalid model config {path}: {error}") from error
    if raw.get("schema_version") != 1:
        raise PerfError("model config schema_version must be 1")
    model = model_override or raw.get("model")
    if not isinstance(model, str) or not model.strip():
        raise PerfError("model config model must be a non-empty string")
    base_url = raw.get("base_url")
    if not isinstance(base_url, str):
        raise PerfError("model config base_url must be an HTTP(S) URL")
    parsed = urlsplit(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise PerfError("model config base_url must be an HTTP(S) URL")
    try:
        parsed.port
    except ValueError as error:
        raise PerfError("model config base_url has an invalid port") from error
    if parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise PerfError("model config base_url cannot contain credentials, query, or fragment")
    protocol = raw.get("protocol", "responses")
    if not isinstance(protocol, str) or protocol.lower() not in PROTOCOL_TYPES:
        raise PerfError("model config protocol must be completions, responses, or anthropic")
    protocol = "responses" if protocol.lower() == "response" else protocol.lower()
    api_key_env = raw.get("api_key_env")
    if not isinstance(api_key_env, str) or not ENV_IDENTIFIER.fullmatch(api_key_env):
        raise PerfError("model config api_key_env must be an environment variable name")
    if not os.environ.get(api_key_env):
        raise PerfError(f"model credential environment variable is not set: {api_key_env}")

    parameters = raw.get("parameters", {})
    if not isinstance(parameters, dict):
        raise PerfError("model config parameters must be a table")
    allowed = {"reasoning_effort", "reasoning_summary", "verbosity"}
    unknown = sorted(set(parameters) - allowed)
    if unknown:
        raise PerfError(f"unsupported model parameters: {', '.join(unknown)}")
    effort = parameters.get("reasoning_effort")
    if effort is not None and effort not in {"minimal", "low", "medium", "high", "xhigh"}:
        raise PerfError("parameters.reasoning_effort must be minimal, low, medium, high, or xhigh")
    summary = parameters.get("reasoning_summary")
    if summary is not None and summary not in {"auto", "concise", "detailed", "none"}:
        raise PerfError("parameters.reasoning_summary must be auto, concise, detailed, or none")
    verbosity = parameters.get("verbosity")
    if verbosity is not None and verbosity not in {"low", "medium", "high"}:
        raise PerfError("parameters.verbosity must be low, medium, or high")
    runner_upstreams = raw.get("runner_upstreams", {})
    if not isinstance(runner_upstreams, dict):
        raise PerfError("runner_upstreams must be a table")
    for runner, upstream in runner_upstreams.items():
        if (
            runner not in {"harness", "codex", "claudecode"}
            or not isinstance(upstream, dict)
            or set(upstream) != {"base_url", "protocol"}
        ):
            raise PerfError(
                "runner_upstreams entries require a known runner, base_url and protocol"
            )
        if not isinstance(upstream["base_url"], str) or not isinstance(upstream["protocol"], str):
            raise PerfError("runner upstream base_url and protocol must be strings")
        url = urlsplit(upstream["base_url"])
        if (
            url.scheme not in {"http", "https"}
            or not url.hostname
            or url.username
            or url.password
            or url.query
            or url.fragment
        ):
            raise PerfError(
                "runner upstream requires an HTTP(S) URL without credentials, query or fragment"
            )
        try:
            url.port
        except ValueError as error:
            raise PerfError("runner upstream has an invalid port") from error
        if upstream["protocol"] not in PROTOCOL_TYPES:
            raise PerfError("runner upstream has an unsupported protocol")
    return {
        "path": str(path.resolve()),
        "model": model.strip(),
        "base_url": base_url.rstrip("/"),
        "protocol": protocol,
        "api_key_env": api_key_env,
        "parameters": parameters,
        "runner_upstreams": runner_upstreams,
    }


def docker_upstream_url(base_url: str) -> str:
    parsed = urlsplit(base_url)
    if parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        return base_url
    host = "host.docker.internal"
    if parsed.port is not None:
        host += f":{parsed.port}"
    return urlunsplit((parsed.scheme, host, parsed.path, "", ""))


def gateway_config(model_config: dict[str, Any]) -> dict[str, Any]:
    provider_type = PROTOCOL_TYPES[model_config["protocol"]]
    model_entry: dict[str, Any] = {
        "provider": "upstream",
        "capabilities": ["text", "tools", "reasoning"],
    }
    # Rosetta 0.13's OpenAI defaults clamp xhigh to high. Preserve the
    # explicitly requested effort: some compatible backends reject high.
    if model_config.get("parameters", {}).get("reasoning_effort") == "xhigh" and provider_type in {
        "openai_chat",
        "openai_responses",
    }:
        model_entry["reasoning_override"] = {"effort_range": ["minimal", "xhigh"]}
    return {
        "providers": {
            "upstream": {
                "type": provider_type,
                "api_key": "${" + model_config["api_key_env"] + "}",
                "base_url": docker_upstream_url(model_config["base_url"]),
            }
        },
        "models": {model_config["model"]: model_entry},
        "server": {
            "host": "0.0.0.0",
            "port": GATEWAY_PORT,
            "open_on_no_keys": True,
            "credential_visible": False,
            "data_dir": "/tmp/llm-rosetta",
        },
        "debug": {"log_bodies": False},
    }


def hash_tree(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix().encode()
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        if path.is_symlink():
            target = os.readlink(path).encode()
            digest.update(b"L" + len(target).to_bytes(8, "big") + target)
        elif path.is_file():
            digest.update(b"F")
            with path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
        elif path.is_dir():
            digest.update(b"D")
    return digest.hexdigest()


def runner_source_paths() -> list[Path]:
    """纳入本地源码改动，排除依赖与构建产物。"""
    paths = [
        REPO_ROOT / ".dockerignore",
        REPO_ROOT / "Cargo.toml",
        REPO_ROOT / "Cargo.lock",
        REPO_ROOT / "scripts" / "launch.py",
        REPO_ROOT / "tests" / "e2e" / "docker" / "Dockerfile",
    ]
    paths.extend((REPO_ROOT / "tests" / "perf").glob("*.py"))
    excluded = {"node_modules", "dist", "target", ".venv", ".ruff_cache", "__pycache__", ".git"}
    for directory in ("tests/perf/runner", "runtime", "core", "clients"):
        for root, directories, files in os.walk(REPO_ROOT / directory):
            directories[:] = [name for name in directories if name not in excluded]
            paths.extend(
                Path(root) / name
                for name in files
                if name != ".DS_Store" and not name.endswith((".pyc", ".pyo", ".tmp"))
            )
    return sorted(paths)


def runner_source_hash() -> str:
    digest = hashlib.sha256()
    paths = runner_source_paths()
    for path in paths:
        relative = path.relative_to(REPO_ROOT).as_posix().encode()
        contents = path.read_bytes()
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        digest.update(len(contents).to_bytes(8, "big"))
        digest.update(contents)
    return digest.hexdigest()


def git_provenance() -> dict[str, Any]:
    commit = run_command(["git", "rev-parse", "HEAD"], check=False).stdout.strip() or None
    status = run_command(["git", "status", "--porcelain"], check=False).stdout
    return {"commit": commit, "dirty": bool(status.strip())}


def image_provenance(
    image: str, *, pull_if_missing: bool = False, docker_platform: str | None = None
) -> dict[str, Any]:
    completed = run_command(["docker", "image", "inspect", image], check=False)
    if completed.returncode != 0 and pull_if_missing:
        print(f"Pulling pinned image {image}...", flush=True)
        run_command(
            ["docker", "pull", *(["--platform", docker_platform] if docker_platform else []), image]
        )
        completed = run_command(["docker", "image", "inspect", image], check=False)
    if completed.returncode != 0:
        raise PerfError(f"Docker image is unavailable: {image}; run scripts/perf build")
    inspected = json.loads(completed.stdout)[0]
    labels = inspected.get("Config", {}).get("Labels") or {}
    return {
        "reference": image,
        "id": inspected.get("Id"),
        "repo_digests": inspected.get("RepoDigests", []),
        "created": inspected.get("Created"),
        "architecture": inspected.get("Architecture"),
        "codex_installed": labels.get("io.areal.perf.codex-installed") == "1",
        "codex_version": labels.get("org.opencontainers.image.version"),
        "claudecode_installed": labels.get("io.areal.perf.claudecode-installed") == "1",
        "claudecode_version": labels.get("io.areal.perf.claudecode-version"),
        "dsh_installed": labels.get("io.areal.perf.dsh-installed") == "1",
        "dsh_version": labels.get("io.areal.perf.dsh-version"),
        "source_sha256": labels.get("io.areal.perf.source-sha256"),
        "environment_sha256": labels.get("io.areal.perf.environment-sha256"),
    }


def build_runner_image(
    image: str,
    *,
    base_image: str,
    codex_version: str,
    npm_registry: str,
    without_codex: bool = False,
    claude_code_version: str = DEFAULT_CLAUDE_CODE_VERSION,
    without_claudecode: bool = False,
    docker_platform: str | None = None,
    runtime_smoke: bool = True,
    claudecode_npm_registry: str = "https://registry.npmjs.org",
    with_dsh: bool = False,
    dsh_version: str = DEFAULT_DSH_VERSION,
) -> int:
    command = [
        "docker",
        "build",
        "--file",
        str(REPO_ROOT / "tests/e2e/docker/Dockerfile"),
        "--build-arg",
        f"BASE_IMAGE={base_image}",
        "--build-arg",
        f"CODEX_VERSION={codex_version}",
        "--build-arg",
        f"INSTALL_CODEX={0 if without_codex else 1}",
        "--build-arg",
        f"CLAUDE_CODE_VERSION={claude_code_version}",
        "--build-arg",
        f"INSTALL_CLAUDE_CODE={0 if without_claudecode else 1}",
        "--build-arg",
        f"CLAUDE_CODE_NPM_REGISTRY={claudecode_npm_registry}",
        "--build-arg",
        f"INSTALL_DSH={1 if with_dsh else 0}",
        "--build-arg",
        f"DSH_VERSION={dsh_version}",
        "--build-arg",
        f"NPM_REGISTRY={npm_registry}",
        "--build-arg",
        f"PERF_SOURCE_SHA256={runner_source_hash()}",
        "--tag",
        image,
        str(REPO_ROOT),
    ]
    if docker_platform:
        command[2:2] = ["--platform", docker_platform]
    exit_code = subprocess.run(command, cwd=REPO_ROOT, check=False).returncode
    if exit_code == 0 and runtime_smoke:
        exit_code = smoke_runtime_profile(image)
    return exit_code


def smoke_runtime_profile(image: str, python: str = "python3") -> int:
    with tempfile.TemporaryDirectory(prefix="areal-perf-smoke-") as temporary:
        workspace = Path(temporary) / "workspace"
        workspace.mkdir(mode=0o755)
        (workspace / "existing").write_text("original\n")
        (workspace / "existing").chmod(0o644)
        with trial_ownership(image, workspace, python=python):
            command = [
                "docker",
                "run",
                "--rm",
                "--read-only",
                "--user",
                "0:0",
                "--security-opt",
                "seccomp=unconfined",
                "--security-opt",
                "systempaths=unconfined",
                "--tmpfs",
                "/tmp:rw,nosuid,nodev,size=128m",
                "--mount",
                mount(workspace, "/workspace"),
                "--tmpfs",
                "/output:rw,size=16m",
                "--network",
                "bridge",
                "--entrypoint",
                python,
                image,
                "/opt/areal-perf/runtime_smoke.py",
            ]
            status = subprocess.run(command, cwd=REPO_ROOT, check=False).returncode
        if status == 0 and (workspace / "existing").read_text() != "patched\n":
            raise PerfError("Runtime smoke did not modify the host-staged file")
        return status


def smoke_claudecode_profile(image: str) -> int:
    return subprocess.run(
        [
            "docker",
            "run",
            "--rm",
            "--read-only",
            "--network",
            "none",
            "--tmpfs",
            "/tmp:rw,size=512m",
            "--tmpfs",
            "/workspace:rw,size=16m",
            "--tmpfs",
            "/task:rw,size=1m",
            "--tmpfs",
            "/output:rw,size=16m",
            "--entrypoint",
            "python3",
            image,
            "/opt/areal-perf/claudecode_smoke.py",
        ],
        cwd=REPO_ROOT,
        check=False,
    ).returncode


def smoke_loop(args: argparse.Namespace) -> int:
    """Exercise each real CLI with a deterministic model and no external network."""
    for runner in args.runner or ["harness", "codex", "claudecode"]:
        with tempfile.TemporaryDirectory(prefix="areal-perf-loop-") as temporary:
            workspace = Path(temporary) / "workspace"
            workspace.mkdir(mode=0o755)
            (workspace / "loop-existing.txt").write_text("original")
            (workspace / "loop-existing.txt").chmod(0o644)
            with trial_ownership(args.image, workspace, python=args.python):
                command = [
                    "docker",
                    "run",
                    "--rm",
                    "--read-only",
                    "--network",
                    "none",
                    "--user",
                    "0:0",
                    "--security-opt",
                    "seccomp=unconfined",
                    "--security-opt",
                    "systempaths=unconfined",
                    "--tmpfs",
                    "/tmp:rw,nosuid,nodev,size=512m",
                    "--mount",
                    mount(workspace, "/workspace"),
                    "--tmpfs",
                    "/task:rw,size=1m",
                    "--tmpfs",
                    "/output:rw,size=16m",
                    "--env",
                    f"AREAL_PERF_RUNNER={runner}",
                    "--entrypoint",
                    args.python,
                    args.image,
                    "/opt/areal-perf/loop_fixture.py",
                ]
                status = subprocess.run(command, cwd=REPO_ROOT, check=False).returncode
        if status != 0:
            return status
    return 0


def ensure_runner_image(image: str) -> None:
    if image != DEFAULT_IMAGE:
        return
    inspected = run_command(["docker", "image", "inspect", image], check=False)
    current_hash = None
    if inspected.returncode == 0:
        labels = json.loads(inspected.stdout)[0].get("Config", {}).get("Labels") or {}
        current_hash = labels.get("io.areal.perf.source-sha256")
    expected_hash = runner_source_hash()
    if current_hash == expected_hash:
        return
    reason = "missing" if inspected.returncode != 0 else "out of date"
    print(f"Runner image is {reason}; rebuilding {image}...", flush=True)
    exit_code = build_runner_image(
        image,
        base_image=DEFAULT_BASE_IMAGE,
        codex_version=DEFAULT_CODEX_VERSION,
        npm_registry=DEFAULT_NPM_REGISTRY,
    )
    if exit_code != 0:
        raise PerfError(f"failed to rebuild runner image: {image}")


def mount(source: Path, destination: str, readonly: bool = False) -> str:
    value = f"type=bind,src={source.resolve()},dst={destination}"
    return value + (",readonly" if readonly else "")


@contextmanager
def trial_ownership(image: str, *paths: Path, python: str = "python3"):
    """Align private trial copies with the root runner, then return them to the host."""
    owners = [
        (f"/trial/{index}", path.stat().st_uid, path.stat().st_gid)
        for index, path in enumerate(paths)
    ]
    command = ["docker", "run", "--rm", "--read-only", "--network", "none", "--user", "0:0"]
    for index, path in enumerate(paths):
        command.extend(["--mount", mount(path, f"/trial/{index}")])
    command.extend(["--entrypoint", python, image, "/opt/areal-perf/trial_ownership.py"])
    try:
        run_command([*command, json.dumps([(path, 0, 0) for path, _, _ in owners])])
        yield
    finally:
        # Agent/grader containers are removed before this runs, even on cancel.
        run_command([*command, json.dumps(owners)])


def docker_remove(name: str) -> None:
    run_command(["docker", "rm", "--force", name], check=False)


def stop_gateway(handle: dict[str, str] | None, run_dir: Path) -> None:
    if not handle:
        return
    logs = run_command(["docker", "logs", handle["container"]], check=False)
    (run_dir / "gateway.log").write_text(logs.stdout + logs.stderr)
    docker_remove(handle["container"])
    run_command(["docker", "network", "rm", handle["network"]], check=False)


def start_gateway(
    run_dir: Path,
    model_config: dict[str, Any],
    gateway_image: str,
    runner_image: str,
) -> dict[str, str]:
    token = uuid.uuid4().hex[:12]
    network = f"areal-perf-{token}"
    container = f"areal-perf-gateway-{token}"
    config_path = run_dir / "gateway.config.json"
    atomic_json(config_path, gateway_config(model_config))
    run_command(["docker", "network", "create", network])
    command = [
        "docker",
        "run",
        "--detach",
        "--name",
        container,
        "--network",
        network,
        "--add-host",
        "host.docker.internal:host-gateway",
        # The pinned amd64 gateway is a self-extracting executable.
        "--read-only",
        "--tmpfs",
        "/tmp:rw,exec,nosuid,nodev,size=256m",
        "--mount",
        mount(config_path, "/config/config.jsonc", True),
        "--env",
        model_config["api_key_env"],
        gateway_image,
    ]
    try:
        run_command(command)
        probe = (
            "import sys,time,urllib.request\n"
            "deadline=time.monotonic()+60\n"
            "while time.monotonic()<deadline:\n"
            " try:\n"
            f"  urllib.request.urlopen('http://{container}:{GATEWAY_PORT}/health', timeout=1).read(); sys.exit(0)\n"
            " except Exception:\n"
            "  time.sleep(.25)\n"
            "sys.exit(1)\n"
        )
        health = run_command(
            [
                "docker",
                "run",
                "--rm",
                "--network",
                network,
                "--entrypoint",
                "python3",
                runner_image,
                "-c",
                probe,
            ],
            check=False,
            timeout=75,
        )
        if health.returncode != 0:
            logs = run_command(["docker", "logs", container], check=False)
            detail = (logs.stderr or logs.stdout).strip()[-2000:]
            raise PerfError(f"llm-rosetta gateway did not become ready: {detail}")
    except Exception:
        docker_remove(container)
        run_command(["docker", "network", "rm", network], check=False)
        raise
    return {
        "container": container,
        "network": network,
        "url": f"http://{container}:{GATEWAY_PORT}",
    }


def read_json_or(path: Path, fallback: dict[str, Any]) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else fallback
    except (OSError, json.JSONDecodeError):
        return fallback


def container_state(name: str) -> dict[str, Any]:
    completed = run_command(["docker", "inspect", name], check=False)
    if completed.returncode != 0:
        return {}
    state = json.loads(completed.stdout)[0].get("State", {})
    return {
        "status": state.get("Status"),
        "exit_code": state.get("ExitCode"),
        "oom_killed": state.get("OOMKilled"),
        "error": state.get("Error") or None,
    }


def run_container(
    command: list[str], name: str, log_dir: Path, timeout: int
) -> tuple[int, dict[str, Any]]:
    try:
        completed = run_command(command, timeout=timeout, check=False)
        (log_dir / f"{name}.stdout.log").write_text(completed.stdout[-1_000_000:])
        (log_dir / f"{name}.stderr.log").write_text(completed.stderr[-1_000_000:])
        return completed.returncode, container_state(name)
    except PerfError:
        run_command(["docker", "kill", name], check=False)
        return 124, container_state(name)
    finally:
        docker_remove(name)


def fetch_pro(args: argparse.Namespace) -> int:
    """Validate the vendored task/test snapshot; scoring has no OSS dependency."""
    for directory in resolve_tasks("pro"):
        load_task(directory)
        if not (directory / "oracle/test_outputs.py").is_file():
            raise PerfError(f"pro acceptance tests missing: {directory}")
    print("pro: 20 local tasks and acceptance tests are ready; no reward downloads required")
    return 0


def environment_context(task_dir: Path, task: dict[str, Any]) -> Path:
    relative = task["environment"].get("build")
    if not isinstance(relative, str) or not relative:
        raise PerfError("environment.build must name the local Docker build context")
    context = path_in(task_dir, relative, "environment build context")
    if not (context / "Dockerfile").is_file() or not (context / "origin.json").is_file():
        raise PerfError("environment build context requires Dockerfile and origin.json")
    grader = path_in(task_dir, task.get("grader", {}).get("path", "grader"), "grader")
    if context == task_dir.resolve() or context == grader or context in grader.parents:
        raise PerfError("environment build context must exclude the grader")
    for path in context.rglob("*"):
        if path.is_symlink() and context not in path.resolve().parents:
            raise PerfError("environment build context symlink escapes its directory")
    return context


def environment_source_hash(context: Path) -> str:
    # Git 保存可执行位；COPY 会受其影响，也必须参与缓存身份。
    modes = [
        (path.relative_to(context).as_posix(), bool(path.stat().st_mode & 0o111))
        for path in sorted(context.rglob("*"))
        if path.is_file()
    ]
    return hashlib.sha256((hash_tree(context) + json.dumps(modes)).encode()).hexdigest()


def prepare_base_environment(task_dir: Path, task: dict[str, Any]) -> dict[str, Any]:
    environment = task["environment"]
    context = environment_context(task_dir, task)
    # 独立 context 不含 oracle；内容变化必须重新构建，不能复用旧 tag。
    fingerprint = environment_source_hash(context)
    reference = f"{environment['image']}-{fingerprint[:16]}"
    inspected = run_command(["docker", "image", "inspect", reference], check=False)
    if inspected.returncode != 0:
        print(f"Building public task environment {reference}...", flush=True)
        completed = subprocess.run(
            [
                "docker",
                "build",
                "--platform",
                environment["platform"],
                "--label",
                f"io.areal.perf.environment-sha256={fingerprint}",
                "-t",
                reference,
                str(context),
            ],
            check=False,
        )
        if completed.returncode:
            raise PerfError(f"failed to build task environment: {reference}")
    result = image_provenance(reference)
    if result["architecture"] != "amd64" or result["environment_sha256"] != fingerprint:
        raise PerfError(f"task environment identity mismatch: {reference}")
    result["build_sha256"] = fingerprint
    return result


def build_pro(args: argparse.Namespace) -> int:
    for directory in resolve_tasks("pro", args.case):
        result = prepare_base_environment(directory, load_task(directory))
        print(result["reference"])
    return 0


def verify_environment_runtime(task_dir: Path, task: dict[str, Any], image: str) -> None:
    context = environment_context(task_dir, task)
    checks = [
        ("runtime.sha256", ["sha256sum", "--quiet", "-c", "/tmp/runtime.sha256"]),
        ("verify_runtime.py", ["python3", "-B", "/tmp/verify_runtime.py"]),
    ]
    for name, command in checks:
        path = context / name
        if path.is_file():
            # 安装 runner 也可能升级系统库，必须再次检查，且不向容器注入 oracle。
            run_command(
                [
                    "docker",
                    "run",
                    "--rm",
                    "--platform",
                    task["environment"]["platform"],
                    "--network",
                    "none",
                    "--read-only",
                    "--mount",
                    mount(path, f"/tmp/{name}", True),
                    "--entrypoint",
                    command[0],
                    image,
                    *command[1:],
                ]
            )


def prepare_environment_image(
    task_dir: Path, task: dict[str, Any], runners: list[str]
) -> dict[str, Any]:
    environment = task["environment"]
    source = prepare_base_environment(task_dir, task)
    fingerprint = hashlib.sha256(
        (runner_source_hash() + str(source["id"]) + f":dsh={int('dsh' in runners)}").encode()
    ).hexdigest()[:16]
    reference = f"areal-perf-pro:{task['id']}-{fingerprint}"
    inspected = run_command(["docker", "image", "inspect", reference], check=False)
    if inspected.returncode != 0:
        if (
            build_runner_image(
                reference,
                base_image=source["reference"],
                codex_version=DEFAULT_CODEX_VERSION,
                npm_registry=DEFAULT_NPM_REGISTRY,
                docker_platform=environment["platform"],
                runtime_smoke=False,
                with_dsh="dsh" in runners,
            )
            != 0
        ):
            raise PerfError(f"failed to build pro runner image: {reference}")
    verify_environment_runtime(task_dir, task, reference)
    if "harness" in runners and smoke_runtime_profile(reference, "python3.11") != 0:
        raise PerfError(f"pro image failed Runtime sandbox smoke: {reference}")
    result = image_provenance(reference)
    result["environment_image"] = source
    return result


def trial_evaluation(
    task: dict[str, Any],
    agent: dict[str, Any],
    grader: dict[str, Any],
    artifacts: dict[str, list[str]],
) -> tuple[bool, dict[str, Any]]:
    score = grader.get("score")
    valid = (
        agent.get("execution_started") is True
        and isinstance(score, (int, float))
        and not isinstance(score, bool)
        and math.isfinite(score)
    )
    passed = (
        agent.get("status") == "completed"
        and grader.get("status") == "passed"
        and all(artifacts.values())
        and (
            not task.get("acceptance", {}).get("require_terminal_event", True)
            or agent.get("terminal_event_seen") is True
        )
    )
    return passed, {
        "valid": valid,
        "score": float(score) if valid else None,
        "metrics": grader.get("metrics", {}) if valid else {},
        "invalid_reason": None
        if valid
        else (
            "agent infrastructure failure"
            if agent.get("execution_started") is not True
            else "grader did not produce a valid score"
        ),
    }


def run_environment_trial(
    task_dir: Path,
    task: dict[str, Any],
    runner: str,
    sequence: int,
    run_dir: Path,
    image: str,
    pass_env: Iterable[str],
    provenance: dict[str, Any],
    model_config: dict[str, Any] | None,
    gateway: dict[str, str] | None,
) -> dict[str, Any]:
    if runner == "fixture":
        raise PerfError("fixture is only available for lite")
    if not model_config or not gateway:
        raise PerfError("pro requires a model and gateway")
    trial_dir = run_dir / "trials" / f"{sequence:03d}-{runner}"
    trial_dir.mkdir(parents=True)
    output = trial_dir / "output"
    output.mkdir()
    agent_task = trial_dir / "agent-task"
    stage_agent_task(task_dir, task, agent_task)
    container = f"areal-perf-pro-{uuid.uuid4().hex[:12]}"
    started = time.monotonic()
    command = [
        "docker",
        "run",
        "--detach",
        "--name",
        container,
        "--platform",
        task["environment"]["platform"],
        "--network",
        gateway["network"],
        *docker_limits(task),
        "--mount",
        mount(agent_task, "/task", True),
        "--mount",
        mount(output, "/output"),
        "--mount",
        mount(run_dir / "runner", "/opt/areal-perf", True),
        "--env",
        f"AREAL_PERF_RUNNER={runner}",
        "--env",
        f"AREAL_PERF_WORKSPACE={task['environment']['workdir']}",
        "--env",
        f"AREAL_PERF_MODEL={model_config['model']}",
        "--env",
        f"AREAL_PERF_GATEWAY_URL={gateway['url']}",
        "--env",
        f"AREAL_PERF_MODEL_PARAMETERS={json.dumps(model_config['parameters'])}",
        "--env",
        f"AREAL_PERF_REDACT_ENV_NAMES={','.join(sorted(set(pass_env)))}",
    ]
    if runner == "harness":
        command.extend(
            ["--security-opt", "seccomp=unconfined", "--security-opt", "systempaths=unconfined"]
        )
    for name in sorted(set(pass_env)):
        if name in os.environ:
            command.extend(["--env", name])
    command.extend(["--entrypoint", "sleep", image, "infinity"])
    states = {}
    agent = {
        "status": "failed",
        "runner": runner,
        "execution_started": False,
        "termination_reason": "missing_agent_result",
        "terminal_event_seen": False,
        "duration_ms": None,
        "usage": {},
        "resources": {},
        "milestones_ms": {},
        "activity": {
            "turns": 0,
            "assistant_turns": 0,
            "tool_calls": 0,
            "tool_successes": 0,
            "tool_failures": 0,
        },
    }
    grader = {"status": "failed", "score": None, "metrics": {}, "duration_ms": None}
    try:
        run_command(command)
        completed = run_command(
            [
                "docker",
                "exec",
                container,
                "python3.11",
                "/opt/areal-perf/agent_entrypoint.py",
            ],
            timeout=task["limits"]["timeout_seconds"] + 45,
            check=False,
        )
        (trial_dir / "agent-container.log").write_text(completed.stdout + completed.stderr)
        states["agent"] = container_state(container)
        agent = read_json_or(output / "agent-result.json", agent)
        # Inject hidden acceptance tests only after the agent exits.
        for filename in ("grader-result.json", "grader-tests.json"):
            (output / filename).unlink(missing_ok=True)
        run_command(["docker", "exec", container, "mkdir", "-p", "/tests"])
        run_command(["docker", "cp", f"{task_dir / 'oracle'}/.", f"{container}:/tests"])
        # The judge needs the original task PATH but no model credentials.
        completed = run_command(
            [
                "docker",
                "exec",
                "--workdir",
                task["environment"]["workdir"],
                container,
                "python3.11",
                "/opt/areal-perf/pro_grader.py",
            ],
            timeout=task["grader"]["timeout_seconds"] + 15,
            check=False,
        )
        (trial_dir / "grader-container.log").write_text(completed.stdout + completed.stderr)
        states["grader"] = container_state(container)
        grader = read_json_or(output / "grader-result.json", grader)
        copied = run_command(
            ["docker", "cp", f"{container}:/app", str(trial_dir / "workspace")], check=False
        )
        if copied.returncode != 0:
            (trial_dir / "workspace-copy.log").write_text(copied.stderr)
    except PerfError as error:
        agent = read_json_or(output / "agent-result.json", agent)
        grader = {**grader, "status": "failed", "score": None, "error": str(error)}
    finally:
        docker_remove(container)
    artifacts = required_artifacts(output, task)
    passed, evaluation = trial_evaluation(task, agent, grader, artifacts)
    trial = {
        "schema_version": 1,
        "sequence": sequence,
        "runner": runner,
        "task_id": task["id"],
        "status": "passed" if passed else "failed",
        "total_duration_ms": round((time.monotonic() - started) * 1000, 3),
        "agent": agent,
        "grader": grader,
        "evaluation": evaluation,
        "required_artifacts": artifacts,
        "containers": states,
        "provenance": provenance,
    }
    trial["trace_metrics"] = agent.get("trace_metrics", {})
    atomic_json(trial_dir / "trial.json", trial)
    return trial


def docker_limits(task: dict[str, Any]) -> list[str]:
    limits = task.get("limits", {})
    return [
        "--cpus",
        str(limits.get("cpus", 2.0)),
        "--memory",
        str(limits.get("memory", "2g")),
        "--pids-limit",
        str(limits.get("pids", 256)),
    ]


def required_artifacts(output: Path, task: dict[str, Any]) -> dict[str, list[str]]:
    found: dict[str, list[str]] = {}
    for pattern in task.get("acceptance", {}).get("required_artifacts", []):
        found[pattern] = sorted(
            path.relative_to(output).as_posix() for path in output.glob(pattern) if path.is_file()
        )
    return found


def stage_agent_task(task_dir: Path, task: dict[str, Any], destination: Path) -> None:
    destination.mkdir()
    shutil.copy2(task_dir / "task.toml", destination / "task.toml")
    inputs = [task["prompt"]["path"], *task.get("agent", {}).get("files", [])]
    for relative in dict.fromkeys(inputs):
        source = path_in(task_dir, relative, "agent input")
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def run_trial(
    task_dir: Path,
    task: dict[str, Any],
    runner: str,
    sequence: int,
    run_dir: Path,
    image: str,
    pass_env: Iterable[str],
    provenance: dict[str, Any],
    model_config: dict[str, Any] | None,
    gateway: dict[str, str] | None,
) -> dict[str, Any]:
    if "environment" in task:
        return run_environment_trial(
            task_dir,
            task,
            runner,
            sequence,
            run_dir,
            image,
            pass_env,
            provenance,
            model_config,
            gateway,
        )
    if runner not in {"codex", "claudecode", "dsh", *task.get("runners", {}).keys()}:
        raise PerfError(f"task {task['id']} does not configure runner {runner}")
    trial_dir = run_dir / "trials" / f"{sequence:03d}-{runner}"
    workspace = trial_dir / "workspace"
    output = trial_dir / "output"
    agent_task = trial_dir / "agent-task"
    trial_dir.mkdir(parents=True)
    output.mkdir()
    stage_agent_task(task_dir, task, agent_task)
    source = path_in(task_dir, task["workspace"]["path"], "workspace")
    shutil.copytree(source, workspace, symlinks=True)
    before_hash = hash_tree(workspace)
    container_token = uuid.uuid4().hex[:12]
    agent_name = f"areal-perf-agent-{container_token}"
    network = (
        gateway["network"]
        if gateway and runner != "fixture"
        else task.get("limits", {}).get("network", "bridge")
    )
    agent_command = [
        "docker",
        "run",
        "--name",
        agent_name,
        "--read-only",
        "--user",
        "0:0",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=512m",
    ]
    if runner == "harness":
        # Runtime's Bubblewrap sandbox needs clone/unshare. No
        # capabilities are added; the tool process receives Bubblewrap's seccomp.
        agent_command.extend(
            ["--security-opt", "seccomp=unconfined", "--security-opt", "systempaths=unconfined"]
        )
    agent_command.extend(
        [
            "--network",
            network,
            *docker_limits(task),
            "--mount",
            mount(agent_task, "/task", True),
            "--mount",
            mount(workspace, "/workspace"),
            "--mount",
            mount(output, "/output"),
            "--env",
            f"AREAL_PERF_RUNNER={runner}",
        ]
    )
    if model_config and runner != "fixture":
        if not gateway:
            raise PerfError("real runner trial requires the llm-rosetta gateway")
        agent_command.extend(
            [
                "--env",
                f"AREAL_PERF_MODEL={model_config['model']}",
                "--env",
                f"AREAL_PERF_GATEWAY_URL={gateway['url']}",
                "--env",
                f"AREAL_PERF_MODEL_PARAMETERS={json.dumps(model_config['parameters'], separators=(',', ':'))}",
            ]
        )
    for name in sorted(set(pass_env)):
        if name in os.environ:
            agent_command.extend(["--env", name])
    agent_command.extend(
        ["--env", f"AREAL_PERF_REDACT_ENV_NAMES={','.join(sorted(set(pass_env)))}"]
    )
    agent_command.append(image)
    grader_name = f"areal-perf-grader-{container_token}"
    grader_command = [
        "docker",
        "run",
        "--name",
        grader_name,
        "--read-only",
        "--network",
        "none",
        "--user",
        "0:0",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=256m",
        *docker_limits(task),
        "--mount",
        mount(task_dir, "/task", True),
        "--mount",
        mount(
            path_in(task_dir, task.get("grader", {}).get("path", "grader"), "grader"),
            "/grader",
            True,
        ),
        "--mount",
        mount(workspace, "/workspace", True),
        "--mount",
        mount(output, "/output"),
        "--entrypoint",
        "python3",
        image,
        "/opt/areal-perf/grader_entrypoint.py",
    ]
    grader_timeout = int(task.get("grader", {}).get("timeout_seconds", 60)) + 15
    with trial_ownership(image, workspace, output):
        started = time.monotonic()
        agent_exit, agent_container = run_container(
            agent_command,
            agent_name,
            trial_dir,
            int(task.get("limits", {}).get("timeout_seconds", 300)) + 45,
        )
        grader_exit, grader_container = run_container(
            grader_command, grader_name, trial_dir, grader_timeout
        )
    agent = read_json_or(
        output / "agent-result.json",
        {
            "schema_version": 1,
            "runner": runner,
            "status": "failed",
            "exit_code": agent_exit,
            "termination_reason": "missing_agent_result",
            "terminal_event_seen": False,
            "execution_started": False,
            "duration_ms": None,
            "resources": {},
            "usage": {},
            "activity": {},
            "milestones_ms": {},
        },
    )
    grader = read_json_or(
        output / "grader-result.json",
        {
            "schema_version": 1,
            "status": "failed",
            "exit_code": grader_exit,
            "error": "missing_grader_result",
            "duration_ms": None,
            "score": None,
            "metrics": {},
        },
    )
    artifacts = required_artifacts(output, task)
    passed, evaluation = trial_evaluation(task, agent, grader, artifacts)
    trial = {
        "schema_version": 1,
        "sequence": sequence,
        "task_id": task["id"],
        "runner": runner,
        "status": "passed" if passed else "failed",
        "total_duration_ms": round((time.monotonic() - started) * 1000, 3),
        "workspace_sha256_before": before_hash,
        "workspace_sha256_after": hash_tree(workspace),
        "agent": agent,
        "grader": grader,
        "evaluation": evaluation,
        "required_artifacts": artifacts,
        "containers": {"agent": agent_container, "grader": grader_container},
        "provenance": provenance,
    }
    trial["trace_metrics"] = agent.get("trace_metrics", {})
    atomic_json(trial_dir / "trial.json", trial)
    return trial


def write_report(run_dir: Path) -> dict[str, Any]:
    run = read_json_or(run_dir / "run.json", {})
    if not run:
        raise PerfError(f"run.json not found in {run_dir}")
    is_pro = run["task"].get("suite") == "pro"
    summary = aggregate(run.get("trials", []), failed_as_zero=is_pro)
    tolerance = float(run.get("task", {}).get("score_regression_tolerance", 0.0))
    task = {**run["task"], "score_regression_tolerance": tolerance}
    runtime_details = [
        trial.get("agent", {}).get("runtime")
        for trial in run.get("trials", [])
        if trial.get("runner") == "harness" and trial.get("agent", {}).get("runtime")
    ]
    harness_runtime = runtime_details[0] if runtime_details else run.get("harness_runtime")
    report = {
        "schema_version": 1,
        "run_id": run["run_id"],
        "status": run.get("status", "unknown"),
        "planned_trials": run.get("planned_trials", len(run.get("schedule", []))),
        "completed_trials": len(run.get("trials", [])),
        "interrupted_attempts": run.get("interrupted_attempts", []),
        "snapshots": run.get("snapshots"),
        "task": task,
        "created_at": run["created_at"],
        "provenance": run["provenance"],
        "model": run.get("model"),
        "model_config": run.get("model_config"),
        "harness_runtime": harness_runtime,
        "summary": summary,
        "comparison": comparison(summary, tolerance),
        "pairwise_comparisons": pairwise_comparisons(run.get("trials", []), tolerance),
        "paired_comparisons": paired_comparisons(run.get("trials", [])),
        "trials": run.get("trials", []),
    }
    if is_pro:
        paired = report["paired_comparisons"]["codex"]
        matched = paired["total_wall_ms"]["matched_tasks"]
        if report["comparison"]["status"] != "incomplete":
            report["comparison"]["status"] = "complete" if matched else "effect_only"
            if matched:
                report["comparison"].pop("reason", None)
            else:
                report["comparison"]["reason"] = (
                    "both runners need passing samples for the same task to compare performance"
                )
        report["comparison"]["performance_basis"] = "median of matched successful per-task ratios"
        for name in ("total_wall_ms", "total_tokens", "assistant_turns", "tool_calls"):
            pairs = paired[name]["pairs"]
            report["comparison"][name] = {
                "harness": median(pair["harness"] for pair in pairs),
                "codex": median(pair["codex"] for pair in pairs),
                "delta": median(pair["harness"] - pair["codex"] for pair in pairs),
                "ratio": paired[name]["median_ratio"],
                "matched_tasks": len(pairs),
            }
        report["per_case"] = {
            case_id: aggregate(
                [trial for trial in run.get("trials", []) if trial.get("task_id") == case_id],
                failed_as_zero=True,
            )
            for case_id in run["task"]["cases"]
        }
        report["task"]["aggregation"] = {"method": "mean", "failed_task_policy": "failed_as_zero"}
    atomic_json(run_dir / "report.json", report)
    return report


def check_model_route(model_config: dict[str, Any] | None) -> None:
    """Transport readiness only, outside trial timings; preflight verifies inference."""
    if model_config is None:
        return
    parsed = urlsplit(model_config["base_url"])
    try:
        with socket.create_connection(
            (parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80)), timeout=10
        ) as connection:
            if parsed.scheme == "https":
                with ssl.create_default_context().wrap_socket(
                    connection, server_hostname=parsed.hostname
                ):
                    pass
    except OSError as error:
        raise PerfError(
            f"model route unavailable ({type(error).__name__}); dispatch paused, preserve this run and resume after connectivity recovers"
        ) from None


def validate_resume(saved: dict[str, Any], current: dict[str, Any]) -> None:
    for field in ("model_config", "task"):
        if saved[field] != current[field]:
            raise PerfError(f"cannot resume: frozen {field} differs")
    fields = (
        ("task_id", "runner", "repeat")
        if any("repeat" in item for item in saved["schedule"])
        else ("task_id", "runner")
    )

    def schedule_counts(run):
        from collections import Counter

        return Counter(tuple(item.get(field) for field in fields) for item in run["schedule"])

    if schedule_counts(saved) != schedule_counts(current):
        raise PerfError("cannot resume: task/runner/repeat schedule differs")
    for field in ("source_sha256", "image", "gateway", "task_images", "host_architecture"):
        if saved["provenance"].get(field) != current["provenance"].get(field):
            raise PerfError(f"cannot resume: frozen {field} differs")
    sequences = [trial["sequence"] for trial in saved["trials"]]
    if len(sequences) != len(set(sequences)) or any(
        value < 1 or value > len(saved["schedule"]) for value in sequences
    ):
        raise PerfError("cannot resume: invalid recorded trial sequence")
    for trial in saved["trials"]:
        expected = saved["schedule"][trial["sequence"] - 1]
        if any(trial.get(field) != expected.get(field) for field in fields):
            raise PerfError("cannot resume: trial does not match its scheduled task and runner")


def execute(args: argparse.Namespace, runners: list[str]) -> int:
    task_dirs = resolve_tasks(args.task, getattr(args, "case", None))
    tasks = [(directory, load_task(directory)) for directory in task_dirs]
    if any("environment" in task for _, task in tasks) and "fixture" in runners:
        raise PerfError("fixture is only available for lite")
    real_run = any(runner != "fixture" for runner in runners)
    model_config = (
        load_model_config(Path(args.model_config).resolve(), args.model) if real_run else None
    )
    if (
        "claudecode" in runners
        and model_config
        and model_config["parameters"].get("reasoning_effort") == "minimal"
    ):
        raise PerfError("Claude Code does not support reasoning_effort=minimal")
    ensure_runner_image(args.image)
    if (
        "harness" in runners
        and not any("environment" in task for _, task in tasks)
        and smoke_runtime_profile(args.image) != 0
    ):
        raise PerfError("runner image failed the Runtime Docker sandbox smoke")
    image = image_provenance(args.image)
    if (
        "dsh" in runners
        and not any("environment" in task for _, task in tasks)
        and not image.get("dsh_installed")
    ):
        raise PerfError("DSH requires a runner image built with --with-dsh")
    task_images = {}
    for directory, task in tasks:
        if "environment" in task:
            task_images[task["id"]] = prepare_environment_image(directory, task, runners)
        else:
            task_images[task["id"]] = image
    gateway_image = image_provenance(args.gateway_image, pull_if_missing=True) if real_run else None
    seed = args.seed if args.seed is not None else random.SystemRandom().randrange(2**32)
    schedule = [
        (index, runner, repeat)
        for repeat in range(1, args.repeat + 1)
        for index in range(len(tasks))
        for runner in runners
    ]
    random.Random(seed).shuffle(schedule)
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    task_id = "pro" if args.task == "pro" else tasks[0][1]["id"]
    task_root = PRO_ROOT if args.task == "pro" else task_dirs[0]
    run_dir = Path(args.output).resolve() / task_id / run_id
    provenance = {
        "git": git_provenance(),
        "image": image,
        "host_platform": sys.platform,
        "source_sha256": runner_source_hash(),
        "host_architecture": platform.machine(),
        "python": sys.version.split()[0],
    }
    normalized_arch = {"aarch64": "arm64", "x86_64": "amd64"}
    host_arch = normalized_arch.get(
        provenance["host_architecture"], provenance["host_architecture"]
    )
    if image.get("architecture") and image["architecture"] != host_arch:
        print(
            f"warning: image architecture {image['architecture']} differs from host {host_arch}; results include emulation overhead",
            file=sys.stderr,
        )
    run: dict[str, Any] = {
        "schema_version": 1,
        "run_id": run_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "task": {
            "id": task_id,
            "path": str(task_root),
            "sha256": hash_tree(task_root),
            "suite": tasks[0][1].get("suite"),
            "cases": [task["id"] for _, task in tasks],
            "score_regression_tolerance": float(
                tasks[0][1].get("comparison", {}).get("score_regression_tolerance", 0.0)
            ),
        },
        "seed": seed,
        "model": model_config["model"] if model_config else None,
        "model_config": model_config,
        "schedule": [
            {"task_id": tasks[index][1]["id"], "runner": runner, "repeat": repeat}
            for index, runner, repeat in schedule
        ],
        "provenance": provenance,
        "trials": [],
    }
    if gateway_image:
        run["provenance"]["gateway"] = gateway_image
    if any("environment" in task for _, task in tasks):
        run["provenance"]["task_images"] = task_images
        run["provenance"]["benchmark"] = json.loads((PRO_ROOT / "benchmark.json").read_text())
        run["provenance"]["grader"] = {
            "policy": "areal-pro-strict-v1",
            "source_sha256": hash_tree(PRO_ROOT / "cases"),
            "platform_reward_used": False,
        }
        if host_arch != "amd64":
            print(
                "warning: pro uses linux/amd64 task images; results on this host include emulation overhead",
                file=sys.stderr,
            )
    if getattr(args, "resume_run", None):
        saved_dir = Path(args.resume_run).resolve()
        saved = read_json_or(saved_dir / "run.json", {})
        if not saved:
            raise PerfError("resume run.json is missing")
        validate_resume(saved, run)
        run_dir, run = saved_dir, saved
        indices = {task["id"]: index for index, (_, task) in enumerate(tasks)}
        schedule = [
            (indices[item["task_id"]], item["runner"], item.get("repeat"))
            for item in run["schedule"]
        ]
    run_dir.mkdir(parents=True, exist_ok=True)
    if not getattr(args, "resume_run", None):
        shutil.copytree(
            REPO_ROOT / "tests/perf/runner",
            run_dir / "runner",
            ignore=shutil.ignore_patterns("__pycache__"),
        )
        shutil.copy2(REPO_ROOT / "tests/perf/trace_metrics.py", run_dir / "runner/trace_metrics.py")
        for directory, task in tasks:
            shutil.copytree(directory, run_dir / "tasks" / task["id"], symlinks=True)
        run["snapshots"] = {
            "runner_sha256": hash_tree(run_dir / "runner"),
            "tasks": {task["id"]: hash_tree(run_dir / "tasks" / task["id"]) for _, task in tasks},
        }
    snapshots = run.get("snapshots")
    if (
        not snapshots
        or snapshots["runner_sha256"] != hash_tree(run_dir / "runner")
        or any(
            digest != hash_tree(run_dir / "tasks" / task_id)
            for task_id, digest in snapshots["tasks"].items()
        )
    ):
        raise PerfError("frozen runner/task snapshot is missing or has changed; start a new run")
    tasks = [(run_dir / "tasks" / task["id"], task) for _, task in tasks]
    run["status"] = "running"
    run.pop("stop_reason", None)
    run["planned_trials"] = len(schedule)
    atomic_json(run_dir / "run.json", run)
    gateways = {}
    try:
        if model_config:
            gateways["default"] = (
                start_gateway(
                    run_dir,
                    model_config,
                    gateway_image.get("id") or args.gateway_image,
                    image.get("id") or args.image,
                ),
                run_dir,
            )
            for runner, upstream in model_config.get("runner_upstreams", {}).items():
                if runner not in runners:
                    continue
                directory = run_dir / f"gateway-{runner}"
                directory.mkdir(exist_ok=True)
                gateways[runner] = (
                    start_gateway(
                        directory,
                        {**model_config, **upstream},
                        gateway_image.get("id") or args.gateway_image,
                        image.get("id") or args.image,
                    ),
                    directory,
                )
        completed = {trial["sequence"] for trial in run["trials"]}
        for sequence, (index, runner, repeat) in enumerate(schedule, 1):
            if sequence in completed:
                continue
            pending_directory = run_dir / "trials" / f"{sequence:03d}-{runner}"
            if pending_directory.exists():
                recovered = read_json_or(pending_directory / "trial.json", {})
                if (
                    recovered
                    and recovered.get("sequence") == sequence
                    and recovered.get("runner") == runner
                    and recovered.get("task_id") == tasks[index][1]["id"]
                    and recovered.get("repeat", repeat) == repeat
                ):
                    if repeat is not None:
                        recovered["repeat"] = repeat
                        atomic_json(pending_directory / "trial.json", recovered)
                    run["trials"].append(recovered)
                    atomic_json(run_dir / "run.json", run)
                    continue
                preserved = pending_directory.with_name(
                    pending_directory.name + "-interrupted-" + uuid.uuid4().hex[:8]
                )
                pending_directory.rename(preserved)
                run.setdefault("interrupted_attempts", []).append(
                    str(preserved.relative_to(run_dir))
                )
                atomic_json(run_dir / "run.json", run)
            route = (
                {**model_config, **model_config.get("runner_upstreams", {}).get(runner, {})}
                if model_config
                else None
            )
            check_model_route(route)
            task_dir, task = tasks[index]
            print(f"[{sequence}/{len(schedule)}] {runner} {task['id']}", flush=True)
            task_image = task_images[task["id"]]
            trial = run_trial(
                task_dir,
                task,
                runner,
                sequence,
                run_dir,
                task_image.get("id") or task_image["reference"],
                args.pass_env,
                {**provenance, "image": task_image, "task_sha256": hash_tree(task_dir)},
                {**model_config, **model_config.get("runner_upstreams", {}).get(runner, {})}
                if model_config
                else None,
                gateways.get(runner, gateways.get("default", (None, None)))[0],
            )
            if repeat is not None:
                trial["repeat"] = repeat
            atomic_json(run_dir / "trials" / f"{sequence:03d}-{runner}" / "trial.json", trial)
            run["trials"].append(trial)
            atomic_json(run_dir / "run.json", run)
            print(f"  {trial['status']} ({trial['total_duration_ms']:.0f} ms)", flush=True)
            if args.fail_fast and trial["status"] != "passed":
                run["status"] = "paused"
                run["stop_reason"] = "trial_failed"
                break
        else:
            run["status"] = "complete"
    except (Exception, KeyboardInterrupt):
        run["status"] = "paused"
        raise
    finally:
        atomic_json(run_dir / "run.json", run)
        write_report(run_dir)
        for gateway, directory in gateways.values():
            stop_gateway(gateway, directory)
    report = write_report(run_dir)
    print(render_report(report, color=terminal_supports_color()))
    print(f"\nEvidence: {run_dir}")
    passed = (
        all(trial["status"] == "passed" for trial in report["trials"])
        and report["comparison"].get("score_regression") is not True
    )
    return 0 if passed or args.allow_failures else 1


def build_image(args: argparse.Namespace) -> int:
    return build_runner_image(
        args.image,
        base_image=args.base_image,
        codex_version=args.codex_version,
        npm_registry=args.npm_registry,
        without_codex=args.without_codex,
        claude_code_version=args.claudecode_version,
        without_claudecode=args.without_claudecode,
        claudecode_npm_registry=args.claudecode_npm_registry,
        with_dsh=args.with_dsh,
        dsh_version=args.dsh_version,
    )


def doctor(args: argparse.Namespace) -> int:
    checks: list[tuple[str, bool, str]] = []
    checks.append(("Python >= 3.11", sys.version_info >= (3, 11), sys.version.split()[0]))
    docker = shutil.which("docker")
    checks.append(("Docker CLI", docker is not None, docker or "not found"))
    server = (
        run_command(["docker", "info", "--format", "{{.ServerVersion}}"], check=False)
        if docker
        else None
    )
    checks.append(
        (
            "Docker daemon",
            bool(server and server.returncode == 0),
            server.stdout.strip() if server and server.returncode == 0 else "unavailable",
        )
    )
    image = run_command(["docker", "image", "inspect", args.image], check=False) if docker else None
    checks.append(("Runner image", bool(image and image.returncode == 0), args.image))
    codex_installed = False
    if image and image.returncode == 0:
        labels = json.loads(image.stdout)[0].get("Config", {}).get("Labels") or {}
        codex_installed = labels.get("io.areal.perf.codex-installed") == "1"
    checks.append(
        (
            "Codex in image",
            codex_installed,
            "installed" if codex_installed else "fixture/Harness-only image",
        )
    )
    claude_installed = bool(
        image and image.returncode == 0 and labels.get("io.areal.perf.claudecode-installed") == "1"
    )
    checks.append(
        (
            "Claude Code in image",
            claude_installed,
            labels.get("io.areal.perf.claudecode-version", "not installed")
            if claude_installed
            else "not installed",
        )
    )
    gateway = (
        run_command(["docker", "image", "inspect", args.gateway_image], check=False)
        if docker
        else None
    )
    checks.append(
        (
            "LLM-Rosetta image",
            bool(gateway and gateway.returncode == 0),
            args.gateway_image
            if gateway and gateway.returncode == 0
            else "not found; run will pull it",
        )
    )
    try:
        model_config = load_model_config(Path(args.model_config).resolve())
        checks.append(
            ("Model config", True, f"{model_config['model']} via {model_config['protocol']}")
        )
        checks.append(("Model credential", True, model_config["api_key_env"]))
    except PerfError as error:
        checks.append(("Model config", False, str(error)))
    for name, passed, detail in checks:
        print(f"{'PASS' if passed else 'FAIL'} {name}: {detail}")
    return 0 if all(passed for _, passed, _ in checks) else 1


def self_test(_: argparse.Namespace) -> int:
    commands = [
        [
            sys.executable,
            "-c",
            "import pathlib,sys; [compile(pathlib.Path(p).read_text(), p, 'exec') for p in sys.argv[1:]]",
            "tests/perf/perf.py",
            "tests/perf/runner/agent_entrypoint.py",
            "tests/perf/runner/runtime_client.py",
            "tests/perf/runner/runtime_smoke.py",
            "tests/perf/runner/core_entrypoint.py",
            "tests/perf/runner/pro_tests.py",
            "tests/perf/runner/grader_entrypoint.py",
            "tests/perf/runner/pro_grader.py",
            "tests/perf/runner/claudecode_smoke.py",
        ],
        [sys.executable, "-m", "unittest", "discover", "-s", "tests/perf/tests", "-v"],
    ]
    environment = dict(os.environ)
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    for command in commands:
        completed = subprocess.run(command, cwd=REPO_ROOT, env=environment, check=False)
        if completed.returncode != 0:
            return completed.returncode
    return 0


InputFunction = Callable[[str], str]
OutputFunction = Callable[[str], None]


def ask(
    label: str,
    *,
    default: str | None = None,
    required: bool = False,
    input_fn: InputFunction = input,
    output_fn: OutputFunction = print,
) -> str:
    suffix = f" [{default}]" if default is not None else ""
    while True:
        try:
            value = input_fn(f"{label}{suffix}: ").strip()
        except EOFError as error:
            raise PerfError(
                "interactive input ended; use ./scripts/perf <subcommand> for automation"
            ) from error
        if value:
            return value
        if default is not None:
            return default
        if not required:
            return ""
        output_fn("A value is required.")


def choose(
    label: str,
    options: list[tuple[str, str]],
    *,
    default: int = 0,
    input_fn: InputFunction = input,
    output_fn: OutputFunction = print,
) -> str:
    output_fn(label)
    for index, (_, description) in enumerate(options, 1):
        output_fn(f"  {index}. {description}")
    while True:
        raw = ask("Select", default=str(default + 1), input_fn=input_fn, output_fn=output_fn)
        try:
            selected = int(raw) - 1
        except ValueError:
            selected = -1
        if 0 <= selected < len(options):
            return options[selected][0]
        output_fn(f"Choose a number from 1 to {len(options)}.")


def choose_many(
    label: str,
    options: list[tuple[str, str]],
    *,
    defaults: tuple[str, ...],
    input_fn: InputFunction = input,
    output_fn: OutputFunction = print,
) -> list[str]:
    output_fn(label)
    for index, (_, description) in enumerate(options, 1):
        output_fn(f"  {index}. {description}")
    default_indices = ",".join(
        str(index) for index, (value, _) in enumerate(options, 1) if value in defaults
    )
    while True:
        raw = ask(
            "Select one or more", default=default_indices, input_fn=input_fn, output_fn=output_fn
        )
        try:
            indices = list(dict.fromkeys(int(part.strip()) - 1 for part in raw.split(",")))
        except ValueError:
            indices = []
        if indices and all(0 <= index < len(options) for index in indices):
            return [options[index][0] for index in indices]
        output_fn(f"Choose comma-separated numbers from 1 to {len(options)}.")


def ask_positive_int(
    label: str,
    default: int,
    *,
    input_fn: InputFunction = input,
    output_fn: OutputFunction = print,
) -> int:
    while True:
        raw = ask(label, default=str(default), input_fn=input_fn, output_fn=output_fn)
        try:
            value = int(raw)
        except ValueError:
            value = 0
        if value > 0:
            return value
        output_fn("Enter a positive integer.")


def ask_yes_no(
    label: str,
    default: bool,
    *,
    input_fn: InputFunction = input,
    output_fn: OutputFunction = print,
) -> bool:
    hint = "Y/n" if default else "y/N"
    while True:
        value = ask(f"{label} ({hint})", input_fn=input_fn, output_fn=output_fn).lower()
        if not value:
            return default
        if value in {"y", "yes"}:
            return True
        if value in {"n", "no"}:
            return False
        output_fn("Enter y or n.")


def interactive_arguments(
    *,
    input_fn: InputFunction = input,
    output_fn: OutputFunction = print,
) -> list[str] | None:
    output_fn("AReaL-Harness local E2E/perf")
    task_options = [
        ("lite", "lite — python-fix-001"),
        ("pro", "pro — harness-bench-terminal@1.0.0 (20 cases)"),
    ]
    task_options.extend(
        (path.name, path.name)
        for path in sorted(CASES_ROOT.iterdir())
        if path.name != "python-fix-001" and (path / "task.toml").is_file()
    )
    task = choose(
        "Task",
        task_options,
        input_fn=input_fn,
        output_fn=output_fn,
    )
    runner_options = [("harness", "AReaL-Harness"), ("codex", "Codex")]
    if task == "lite":
        runner_options.append(("fixture", "Fixture"))
    runner_options.append(("claudecode", "Claude Code"))
    runner_options.append(("dsh", "DSH (requires --with-dsh image)"))
    runners = choose_many(
        "Runners",
        runner_options,
        defaults=("harness", "codex"),
        input_fn=input_fn,
        output_fn=output_fn,
    )
    arguments = ["run", "--task", task]
    for runner in runners:
        arguments.extend(["--runner", runner])
    if any(runner != "fixture" for runner in runners):
        model_config = ask(
            "Model config",
            default=str(DEFAULT_MODEL_CONFIG.relative_to(REPO_ROOT)),
            input_fn=input_fn,
            output_fn=output_fn,
        )
        arguments.extend(["--model-config", model_config])
    repeat = ask_positive_int(
        "Repeat", 5 if len(runners) > 1 else 1, input_fn=input_fn, output_fn=output_fn
    )
    image = ask("Image", default=DEFAULT_IMAGE, input_fn=input_fn, output_fn=output_fn)
    arguments.extend(["--repeat", str(repeat), "--image", image])
    arguments.append("--allow-failures")
    extra_env = ask(
        "Extra environment names (comma-separated)", input_fn=input_fn, output_fn=output_fn
    )
    for name in (part.strip() for part in extra_env.split(",")):
        if name:
            arguments.extend(["--pass-env", name])

    output_fn("")
    output_fn(f"Command: ./scripts/perf {shlex.join(arguments)}")
    if not ask_yes_no("Continue", True, input_fn=input_fn, output_fn=output_fn):
        return None
    return arguments


def interactive(_: argparse.Namespace) -> int:
    if not sys.stdin.isatty():
        raise PerfError(
            "interactive mode requires a terminal; use ./scripts/perf <subcommand> for automation"
        )
    arguments = interactive_arguments()
    if arguments is None:
        print("Canceled.")
        return 0
    return dispatch(arguments)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    subcommands = result.add_subparsers(dest="subcommand", required=True)
    build = subcommands.add_parser("build", help="build the pinned local runner image")
    build.add_argument("--image", default=DEFAULT_IMAGE)
    build.add_argument("--base-image", default=DEFAULT_BASE_IMAGE)
    build.add_argument("--codex-version", default=DEFAULT_CODEX_VERSION)
    build.add_argument("--claudecode-version", default=DEFAULT_CLAUDE_CODE_VERSION)
    build.add_argument("--claudecode-npm-registry", default="https://registry.npmjs.org")
    build.add_argument("--npm-registry", default=DEFAULT_NPM_REGISTRY)
    build.add_argument(
        "--without-codex",
        action="store_true",
        help="build a Harness/fixture image without the Codex comparison runner",
    )
    build.add_argument("--without-claudecode", action="store_true", help="omit Claude Code")
    build.add_argument(
        "--with-dsh", action="store_true", help="install pinned DSH and its durable-trace adapter"
    )
    build.add_argument("--dsh-version", default=DEFAULT_DSH_VERSION)
    build.set_defaults(function=build_image)

    check = subcommands.add_parser("doctor", help="check local prerequisites")
    check.add_argument("--image", default=DEFAULT_IMAGE)
    check.add_argument("--gateway-image", default=DEFAULT_GATEWAY_IMAGE)
    check.add_argument("--model-config", default=str(DEFAULT_MODEL_CONFIG))
    check.set_defaults(function=doctor)

    def execution_arguments(command: argparse.ArgumentParser) -> None:
        command.add_argument(
            "--task",
            required=True,
            help="lite, pro (all 20), pro/<case>, case id or task directory",
        )
        command.add_argument(
            "--case",
            action="append",
            metavar="CASE_ID",
            help="select a pro subset; repeat once per case (requires --task pro)",
        )
        command.add_argument("--repeat", type=int, default=1)
        command.add_argument("--image", default=DEFAULT_IMAGE)
        command.add_argument("--output", default=str(DEFAULT_OUTPUT))
        command.add_argument("--seed", type=int)
        command.add_argument(
            "--resume-run",
            type=Path,
            help="continue an interrupted run with the same frozen code, images, tasks and model config",
        )
        command.add_argument("--pass-env", action="append", default=[], metavar="NAME")
        command.add_argument(
            "--model-config",
            default=str(DEFAULT_MODEL_CONFIG),
            help="TOML connection config for real runners",
        )
        command.add_argument("--model", help="override the model id from --model-config")
        command.add_argument("--gateway-image", default=DEFAULT_GATEWAY_IMAGE)
        command.add_argument(
            "--fail-fast",
            action="store_true",
            help="pause after the first failed trial, preserving evidence",
        )
        command.add_argument(
            "--allow-failures",
            action="store_true",
            help="return success after reporting failed trials (interactive mode default)",
        )

    run = subcommands.add_parser("run", help="run one or more agent implementations")
    execution_arguments(run)
    run.add_argument(
        "--runner",
        required=True,
        action="append",
        choices=("harness", "codex", "claudecode", "dsh", "fixture"),
        help="repeat to include multiple runners in one report",
    )
    run.set_defaults(function=lambda args: execute(args, args.runner))

    compare = subcommands.add_parser(
        "compare", help="compare Harness and Codex with randomized trial order"
    )
    execution_arguments(compare)
    compare.set_defaults(function=lambda args: execute(args, ["harness", "codex"]))

    report = subcommands.add_parser(
        "report", help="print and refresh the JSON report from a run directory"
    )
    report.add_argument("run_dir", type=Path)
    report.set_defaults(
        function=lambda args: (
            print(
                render_report(write_report(args.run_dir.resolve()), color=terminal_supports_color())
            ),
            0,
        )[1]
    )

    test = subcommands.add_parser(
        "self-test", help="validate the suite without Docker or model access"
    )
    test.set_defaults(function=self_test)

    fetch = subcommands.add_parser(
        "fetch-pro", help="validate the local pro tasks and acceptance tests (no downloads)"
    )
    fetch.set_defaults(function=fetch_pro)

    pro_build = subcommands.add_parser(
        "build-pro", help="build pro task environments from public Dockerfiles (no model needed)"
    )
    pro_build.add_argument("--case", action="append", help="select a pro case; repeat for a subset")
    pro_build.set_defaults(function=build_pro)

    claude_smoke = subcommands.add_parser(
        "smoke-claudecode", help="test the real Claude CLI against a local Messages fixture"
    )
    claude_smoke.add_argument("--image", default=DEFAULT_IMAGE)
    claude_smoke.set_defaults(function=lambda args: smoke_claudecode_profile(args.image))

    loop = subcommands.add_parser(
        "smoke-loop", help="test real agent tool loops using a fixed local model (no API key)"
    )
    loop.add_argument("--image", default=DEFAULT_IMAGE)
    loop.add_argument(
        "--python", default="python3", help="Python 3.11+ executable inside the image"
    )
    loop.add_argument(
        "--runner",
        action="append",
        choices=("harness", "codex", "claudecode"),
        help="default: all three agents",
    )
    loop.set_defaults(function=smoke_loop)

    menu = subcommands.add_parser(
        "interactive", help="choose and configure a workflow interactively"
    )
    menu.set_defaults(function=interactive)
    return result


def dispatch(arguments: list[str] | None = None) -> int:
    args = parser().parse_args(arguments)
    if hasattr(args, "repeat") and args.repeat < 1:
        raise PerfError("--repeat must be positive")
    for name in getattr(args, "pass_env", []):
        if not ENV_IDENTIFIER.fullmatch(name):
            raise PerfError(f"invalid environment variable name: {name}")
    return args.function(args)


def main() -> int:
    return dispatch()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except PerfError as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(2)
    except KeyboardInterrupt:
        print("\nCanceled.", file=sys.stderr)
        raise SystemExit(130)
