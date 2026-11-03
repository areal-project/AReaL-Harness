"""有界环境观察：公开声明和实际解释器，既不遍历父树也不安装依赖。"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys

DECLARATIONS = (
    "pyproject.toml", "package.json", "tox.ini", "pytest.ini", "setup.cfg",
    "Makefile", ".python-version", ".nvmrc", "requirements.txt",
    "requirements-dev.txt", "environment.yml", "uv.lock", "poetry.lock",
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
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


def discover(request):
    root = Path(request["roots"]["repo"]).resolve(strict=True)
    cwd = request.get("cwd", "workspace://repo")
    if cwd == "workspace://repo" or cwd.startswith("workspace://repo/"):
        cwd = root / cwd[len("workspace://repo"):].lstrip("/")
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
                    with os.fdopen(os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as stream:
                        current = os.fstat(stream.fileno())
                        if not stat.S_ISREG(current.st_mode) or current.st_size > 1024 * 1024:
                            raise OSError("declaration changed while reading")
                        data = stream.read(1024 * 1024 + 1)
                        if len(data) > 1024 * 1024:
                            raise OSError("declaration grew while reading")
                    row.update(status="read", sha256=hashlib.sha256(data).hexdigest(), bytes=len(data))
                    if not name.endswith(".lock") and "lock." not in name:
                        text = data.decode("utf-8", errors="replace")
                        if name == "package.json":
                            try:
                                package = json.loads(text)
                                row["declared"] = {k: package[k] for k in ("scripts", "engines", "packageManager") if k in package}
                            except ValueError:
                                row["parseError"] = "invalid JSON"
                        else:
                            # 只展示有界原文，由模型选择测试；不执行项目配置或猜测测试命令。
                            row["text"] = text[:1024]
                            row["omittedChars"] = max(0, len(text) - 1024)
            except FileNotFoundError:
                pass
            except OSError as error:
                row.update(status="unreadable", error=type(error).__name__)
            checks.append(row)
    executables = []
    probes = request.get("executables", [{"name": "python", "kind": "python"}, {"name": "python3", "kind": "python"}])
    if len(probes) > 4:
        raise ValueError("at most four executable probes")
    for probe in probes:
        name, kind = probe["name"], probe["kind"]
        resolved = shutil.which(name)
        row = {"requested": name, "kind": kind, "resolved": resolved}
        if resolved:
            row["identity"] = identity(resolved)
            if kind == "python":
                argv = [resolved, "-I", "-B", "-c", "import json,sys,sysconfig; print(json.dumps(dict(executable=sys.executable,version=sys.version,prefix=sys.prefix,basePrefix=sys.base_prefix,paths={k:sysconfig.get_path(k) for k in ('purelib','platlib')})))"]
            elif kind == "node":
                argv = [resolved, "--version"]
            else:
                raise ValueError("unsupported interpreter kind")
            try:
                result = subprocess.run(argv, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=3)
                row.update(exitCode=result.returncode, stderr=result.stderr[:512].decode(errors="replace"))
                if result.returncode == 0 and kind == "python":
                    row["observed"] = json.loads(result.stdout[:4096])
                    row["libraryDirectories"] = [identity(p) for p in row["observed"].get("paths", {}).values()]
                else:
                    row["version"] = result.stdout[:1024].decode(errors="replace")
            except (OSError, ValueError, subprocess.TimeoutExpired) as error:
                row["error"] = type(error).__name__
        executables.append(row)
    # 摘要不输出环境变量值，避免把认证信息混进事实。目录指纹不冒充完整依赖内容哈希。
    environment = digest(dict(os.environ))
    facts = {"workspace": str(root), "cwd": str(cwd), "declarations": checks,
             "executables": executables, "environmentDigest": environment}
    fingerprint = digest(facts)
    # 空结果也进入指纹；展示时合并缺失路径，减少重复 JSON 包装。
    facts["absentDeclarations"] = [r["path"] for r in checks if r["status"] == "missing"]
    facts["declarations"] = [r for r in checks if r["status"] != "missing"]
    facts.update(fingerprint=fingerprint, scope="workspace root and cwd only; selected executable probes",
                 invalidateOn="cwd/configuration/environment/declaration/executable/library changes; rerun after dependency changes or module errors",
                 limitations="No recursive dependency inventory; in-place library content changes may require explicit recheck. Declarations are untrusted data, not executed. Not a validation result.")
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
