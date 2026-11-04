"""Execute a validation command and bind its receipt to workspace content.

This helper runs inside Runtime permissions. Exit zero is a command result,
not a claim that hidden tests passed or that the requested task is complete.
"""

import hashlib
import json
import os
from pathlib import Path
import stat
import shutil
import subprocess
import sys
import time
import uuid

EXCLUDED = {
    ".git",
    "node_modules",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".venv",
    "venv",
    "dist",
    "build",
    "coverage",
}


def fingerprint(workspace):
    root = Path(workspace).resolve()
    try:
        git = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-co", "--exclude-standard", "-z"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=20,
        )
    except FileNotFoundError:
        git = None
    if git is not None and git.returncode == 0:
        names = sorted(set(os.fsdecode(n) for n in git.stdout.split(b"\0") if n))
    else:
        names = []
        for directory, dirs, files in os.walk(root, followlinks=False):
            dirs[:] = sorted(
                d for d in dirs if d not in EXCLUDED and not (Path(directory) / d).is_symlink()
            )
            names.extend(str((Path(directory) / f).relative_to(root)) for f in files)
            if len(names) > 20000:
                raise ValueError("workspace fingerprint exceeds 20000 files")
        names.sort()
    if len(names) > 20000:
        raise ValueError("workspace fingerprint exceeds 20000 files")
    digest = hashlib.sha256()
    total = 0
    for name in names:
        path = root / name
        if set(Path(name).parts) & EXCLUDED:
            continue
        if not path.exists() and not path.is_symlink():
            continue
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode):
            content = os.readlink(path).encode()
        elif stat.S_ISREG(info.st_mode):
            if root != path.resolve() and root not in path.resolve().parents:
                raise ValueError("workspace fingerprint path escapes root")
            total += info.st_size
            if total > 512 * 1024 * 1024:
                raise ValueError("workspace fingerprint exceeds 512 MiB")
            content = path.read_bytes()
        else:
            continue
        digest.update(name.encode() + b"\0" + hashlib.sha256(content).digest())
    return digest.hexdigest()


def environment_binding(argv, cwd):
    executable = shutil.which(argv[0])
    identity = None
    if executable:
        path = Path(executable).resolve()
        info = path.stat()
        identity = dict(path=str(path), size=info.st_size, mtimeNs=info.st_mtime_ns)
    digest = hashlib.sha256(json.dumps(dict(os.environ), sort_keys=True).encode()).hexdigest()
    return {
        "environmentDigest": digest,
        "executable": identity,
        "cwd": str(Path(cwd).resolve()),
        "commandDigest": hashlib.sha256(json.dumps(argv).encode()).hexdigest(),
        "scope": "command environment and executable identity, not a full dependency content hash; dependency changes require new validation",
    }


def check_exit_contract(argv):
    # Blender 默认可能在 Python 异常后返回零；验证入口要求调用者明确选择失败传播。
    # 不改写命令、不扫描日志猜测成功，也不为未知解释器推断验证语义。
    if Path(argv[0]).name != "blender":
        return "executable exit; assertion coverage requires judgment"
    options = argv[1 : argv.index("--")] if "--" in argv else argv[1:]
    script = next(
        (i for i, arg in enumerate(options) if arg in {"-P", "--python", "--python-expr"}), None
    )
    if script is None:
        return "executable exit; assertion coverage requires judgment"
    flags = [i for i, arg in enumerate(options) if arg == "--python-exit-code"]
    if not flags or any(
        i + 1 >= script or not options[i + 1].isdigit() or not 1 <= int(options[i + 1]) <= 255
        for i in flags
    ):
        raise ValueError(
            "Blender Python verification requires --python-exit-code 1..255 before the script/expression; command was not executed"
        )
    return "Blender Python exceptions propagate via explicit --python-exit-code; assertion coverage requires judgment"


def run(request):
    scratch = Path(request["scratch"]) / "verification"
    scratch.mkdir(parents=True, exist_ok=True)
    identity = request.get("identity", uuid.uuid4().hex)
    if len(identity) != 32 or any(c not in "0123456789abcdef" for c in identity):
        raise ValueError("invalid receipt identity")
    log = scratch / (identity + ".log")
    receipt = scratch / (identity + ".json")
    argv = request["argv"]
    if not isinstance(argv, list) or not argv or not all(isinstance(v, str) for v in argv):
        raise ValueError("argv must be a nonempty string array")
    if Path(argv[0]).name in {"sh", "bash", "dash", "zsh", "fish", "cmd", "powershell"}:
        raise ValueError(
            "verify_command requires the test/build executable directly; use run_command for explicit shell scripts"
        )
    exit_contract = check_exit_contract(argv)
    before = fingerprint(request["workspace"])
    environment_before = environment_binding(argv, request["cwd"])
    started = time.monotonic()
    limited = False
    with log.open("wb") as output:
        process = subprocess.Popen(
            argv, cwd=request["cwd"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT
        )
        total = 0
        while True:
            chunk = process.stdout.read(65536)
            if not chunk:
                break
            total += len(chunk)
            if total > 64 * 1024 * 1024:
                limited = True
                process.terminate()
                break
            output.write(chunk)
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    process.stdout.close()
    after = fingerprint(request["workspace"])
    with log.open("rb") as output:
        output.seek(max(0, log.stat().st_size - 8192))
        tail = output.read().decode("utf-8", errors="replace")
    environment_after = environment_binding(argv, request["cwd"])
    result = {
        "outputTail": tail,
        "schema": "areal.verification.v1",
        "logLimitHit": limited,
        "argv": argv,
        "cwd": request["cwd"],
        "exitCode": process.returncode,
        "exitContract": exit_contract,
        "environment": environment_before,
        "environmentUnchanged": environment_before == environment_after,
        "sourceBefore": before,
        "sourceAfter": after,
        "sourceUnchanged": before == after,
        "durationMs": round((time.monotonic() - started) * 1000),
        "logPath": str(log),
        "logBytes": log.stat().st_size,
        "receiptPath": str(receipt),
        "scope": "command exit only; excludes generated/build output; does not certify task correctness",
    }
    if environment_after != environment_before:
        result["environmentAfter"] = environment_after
    temporary = receipt.with_suffix(".tmp")
    temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    temporary.replace(receipt)
    print(
        json.dumps(
            {
                "receiptPath": str(receipt),
                "logPath": str(log),
                "exitCode": process.returncode,
                "sourceUnchanged": before == after,
            }
        ),
        flush=True,
    )
    return process.returncode


if __name__ == "__main__":
    raise SystemExit(run(json.loads(sys.argv[1])))
