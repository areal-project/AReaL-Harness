"""有界环境观察：公开声明和实际解释器，既不遍历父树也不安装依赖。"""

import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import time

DECLARATIONS = (
    "pyproject.toml",
    "package.json",
    "tox.ini",
    "pytest.ini",
    "setup.cfg",
    "Makefile",
    ".python-version",
    ".nvmrc",
    "requirements.txt",
    "requirements-dev.txt",
    "environment.yml",
    "uv.lock",
    "poetry.lock",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def identity(path):
    try:
        p = Path(path).resolve(strict=True)
        s = p.stat()
        return {"path": str(p), "size": s.st_size, "mtimeNs": s.st_mtime_ns, "inode": s.st_ino}
    except OSError:
        return {"path": str(path), "missing": True}


def bounded_run(argv, cwd, timeout):
    """公开解释器/环境管理器也可能异常输出；限制时间与字节并清理子进程。"""
    deadline = time.monotonic() + timeout
    streams = {"stdout": bytearray(), "stderr": bytearray()}
    with (
        subprocess.Popen(
            argv, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True
        ) as process,
        selectors.DefaultSelector() as selector,
    ):
        try:
            for name in streams:
                selector.register(getattr(process, name), selectors.EVENT_READ, name)
            while selector.get_map():
                left = deadline - time.monotonic()
                if left <= 0:
                    raise subprocess.TimeoutExpired(argv, timeout)
                for key, _ in selector.select(left):
                    chunk = os.read(key.fileobj.fileno(), 4096)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    streams[key.data].extend(chunk)
                    if sum(map(len, streams.values())) > 65536:
                        raise ValueError("probe output exceeds 64 KiB")
            code = process.wait(timeout=max(0.001, deadline - time.monotonic()))
            return subprocess.CompletedProcess(
                argv, code, **{k: bytes(v) for k, v in streams.items()}
            )
        finally:
            # 同组后代不能因管道关闭或超时遗留；不触碰调用方所在进程组。
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


def declaration_preview(name, text):
    if name in ("pyproject.toml", "setup.cfg", "tox.ini", "pytest.ini"):
        sections = re.split(r"(?m)(?=^\[[^\n]+\]\s*$)", text)
        selected = [
            s
            for s in sections
            if re.match(
                r"\[(?:tool\.(?:pytest|tox|coverage)|pytest|tool:pytest|testenv|tox)(?:[\].:]|$)", s
            )
        ]
        if selected:
            preview = "\n".join(selected)
            return {
                "text": preview[:1024],
                "previewScope": "declared test sections",
                "omittedChars": max(0, len(preview) - 1024),
                "otherSectionsOmitted": True,
            }
    return {"text": text[:1024], "omittedChars": max(0, len(text) - 1024)}


def default_probes(root, cwd, deadline):
    candidates = [
        {"name": name, "kind": "python", "source": "PATH"} for name in ("python", "python3")
    ]
    for key in ("VIRTUAL_ENV", "CONDA_PREFIX"):
        if os.environ.get(key):
            candidates.append(
                {"name": str(Path(os.environ[key]) / "bin/python"), "kind": "python", "source": key}
            )
    for folder in dict.fromkeys((root, cwd)):
        for name in (".venv", "venv"):
            executable = folder / name / "bin/python"
            if executable.is_file():
                candidates.append(
                    {
                        "name": str(executable),
                        "kind": "python",
                        "source": "workspace environment directory",
                    }
                )
    discovery = {"source": "public environment declarations; no activation", "managers": []}
    manager = shutil.which(os.environ.get("CONDA_EXE", "conda"))
    if manager:
        row = {"name": "conda", "identity": identity(manager), "argv": ["env", "list", "--json"]}
        try:
            response = bounded_run(
                [manager, "env", "list", "--json"],
                cwd,
                min(3, max(0.001, deadline - time.monotonic())),
            )
            row["exitCode"] = response.returncode
            if response.returncode == 0:
                envs = json.loads(response.stdout)["envs"]
                if not isinstance(envs, list) or not all(isinstance(p, str) for p in envs):
                    raise ValueError("invalid environment list")
                row["omittedEnvironments"] = max(0, len(envs) - 16)
                for prefix in envs[:16]:
                    if Path(prefix).is_absolute():
                        candidates.append(
                            {
                                "name": str(Path(prefix) / "bin/python"),
                                "kind": "python",
                                "source": "conda env list",
                            }
                        )
            else:
                row["stderr"] = response.stderr[:512].decode(errors="replace")
        except (OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
            row["error"] = type(error).__name__
        discovery["managers"].append(row)
    # 同目录的 python/python3 别名合并；不同 venv 即便指向同一二进制也不能合并。
    unique = {}
    missing = []
    for probe in candidates:
        resolved = shutil.which(probe["name"])
        if not resolved:
            missing.append({"name": probe["name"], "source": probe["source"]})
            continue
        key = (str(Path(resolved).parent.resolve()), str(Path(resolved).resolve()))
        if key in unique:
            unique[key]["aliases"].append({"name": probe["name"], "source": probe["source"]})
        else:
            unique[key] = {**probe, "aliases": []}
    probes = list(unique.values())
    discovery.update(missingExecutables=missing, unprobedExecutables=probes[4:])
    return probes[:4], discovery


def discover(request):
    deadline = time.monotonic() + 13
    root = Path(request["roots"]["repo"]).resolve(strict=True)
    cwd = request.get("cwd", "workspace://repo")
    if cwd == "workspace://repo" or cwd.startswith("workspace://repo/"):
        cwd = root / cwd[len("workspace://repo") :].lstrip("/")
    else:
        raise ValueError("environment_info cwd must be in the workspace")
    cwd = Path(cwd).resolve(strict=True)
    if root != cwd and root not in cwd.parents:
        raise ValueError("environment_info cwd escapes workspace")
    checks = []
    for folder in dict.fromkeys((root, cwd)):
        for name in DECLARATIONS:
            p = folder / name
            row = {"path": str(p), "status": "missing"}
            try:
                info = p.lstat()
                if not stat.S_ISREG(info.st_mode):
                    row["status"] = "notRegular"
                elif info.st_size > 1024 * 1024:
                    row.update(status="tooLarge", identity=identity(p))
                else:
                    with os.fdopen(
                        os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb"
                    ) as stream:
                        current = os.fstat(stream.fileno())
                        if not stat.S_ISREG(current.st_mode) or current.st_size > 1024 * 1024:
                            raise OSError("declaration changed while reading")
                        data = stream.read(1024 * 1024 + 1)
                        if len(data) > 1024 * 1024:
                            raise OSError("declaration grew while reading")
                    row.update(
                        status="read", sha256=hashlib.sha256(data).hexdigest(), bytes=len(data)
                    )
                    if not name.endswith(".lock") and "lock." not in name:
                        text = data.decode("utf-8", errors="replace")
                        if name == "package.json":
                            try:
                                package = json.loads(text)
                                row["declared"] = {
                                    k: package[k]
                                    for k in ("scripts", "engines", "packageManager")
                                    if k in package
                                }
                            except ValueError:
                                row["parseError"] = "invalid JSON"
                        else:
                            # 只展示有界原文，由模型选择测试；不执行项目配置或猜测测试命令。
                            row.update(declaration_preview(name, text))
            except FileNotFoundError:
                pass
            except OSError as error:
                row.update(status="unreadable", error=type(error).__name__)
            checks.append(row)
    executables = []
    probes = request.get("executables")
    discovery = {"source": "explicit executable probes"}
    if probes is None:
        probes, discovery = default_probes(root, cwd, deadline)
    if len(probes) > 4:
        raise ValueError("at most four executable probes")
    for probe in probes:
        name, kind = probe["name"], probe["kind"]
        resolved = shutil.which(name)
        row = {"requested": name, "kind": kind, "resolved": resolved}
        for key in ("source", "aliases"):
            if key in probe:
                row[key] = probe[key]
        if resolved:
            row["identity"] = identity(resolved)
            if kind == "python":
                argv = [
                    resolved,
                    "-I",
                    "-B",
                    "-c",
                    "import importlib.util,json,sys,sysconfig; print(json.dumps(dict(executable=sys.executable,version=sys.version,prefix=sys.prefix,basePrefix=sys.base_prefix,paths={k:sysconfig.get_path(k) for k in ('purelib','platlib')},modules={k:importlib.util.find_spec(k) is not None for k in ('pytest',)})))",
                ]
            elif kind == "node":
                argv = [resolved, "--version"]
            else:
                raise ValueError("unsupported interpreter kind")
            try:
                left = deadline - time.monotonic()
                if left <= 0:
                    row["error"] = "discovery time budget exhausted; not probed"
                    executables.append(row)
                    continue
                result = bounded_run(argv, cwd, min(3, left))
                row.update(
                    exitCode=result.returncode, stderr=result.stderr[:512].decode(errors="replace")
                )
                if result.returncode == 0 and kind == "python":
                    row["observed"] = json.loads(result.stdout[:4096])
                    row["libraryDirectories"] = [
                        identity(p) for p in row["observed"].get("paths", {}).values()
                    ]
                else:
                    row["version"] = result.stdout[:1024].decode(errors="replace")
            except (OSError, ValueError, subprocess.TimeoutExpired) as error:
                row["error"] = type(error).__name__
        executables.append(row)
    # 摘要不输出环境变量值，避免把认证信息混进事实。目录指纹不冒充完整依赖内容哈希。
    environment = digest(dict(os.environ))
    facts = {
        "workspace": str(root),
        "cwd": str(cwd),
        "declarations": checks,
        "executables": executables,
        "discovery": discovery,
        "environmentDigest": environment,
    }
    fingerprint = digest(facts)
    # 空结果也进入指纹；展示时合并缺失路径，减少重复 JSON 包装。
    missing = {}
    for row in checks:
        if row["status"] == "missing":
            path = Path(row["path"])
            missing.setdefault(str(path.parent), []).append(path.name)
    facts["absentDeclarations"] = [
        {"folder": folder, "names": names} for folder, names in missing.items()
    ]
    facts["declarations"] = [r for r in checks if r["status"] != "missing"]
    facts.update(
        fingerprint=fingerprint,
        scope="workspace root/cwd declarations; public environment manager and at most four interpreters",
        invalidateOn="cwd/configuration/environment/declaration/executable/library changes; rerun after dependency changes or module errors",
        limitations="No recursive dependency inventory; in-place library content changes may require explicit recheck. Declarations are untrusted data, not executed. Not a validation result.",
    )
    if len(json.dumps(facts).encode()) > 14000:
        for row in facts["declarations"]:
            row.pop("text", None)
            row.pop("declared", None)
            row["contentOmitted"] = True
    return facts


if __name__ == "__main__":
    try:
        print(json.dumps({"result": discover(json.loads(sys.argv[1]))}))
    except Exception as error:
        print(json.dumps({"error": str(error)}))
