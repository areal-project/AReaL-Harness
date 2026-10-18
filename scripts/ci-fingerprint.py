"""只记录工具版本与锁文件哈希，不记录环境、凭据或用户路径。"""

import hashlib
import json
from pathlib import Path
import platform
import subprocess

ROOT = Path(__file__).resolve().parents[1]
versions = {}
for tool in ("rustc", "cargo", "cargo-audit", "node", "npm", "pnpm", "cmake", "python3"):
    try:
        result = subprocess.run([tool, "--version"], text=True, capture_output=True, timeout=15)
        versions[tool] = result.stdout.splitlines()[0] if result.returncode == 0 else "unavailable"
    except (OSError, subprocess.TimeoutExpired):
        versions[tool] = "unavailable"
locks = (
    "Cargo.lock",
    "package-lock.json",
    "runtime/sdk-typescript/package-lock.json",
    "core/sdk-typescript/package-lock.json",
    "clients/gui/pnpm-lock.yaml",
)
print(
    json.dumps(
        {
            "platform": platform.system(),
            "architecture": platform.machine(),
            "tools": versions,
            "locks": {
                lock: hashlib.sha256((ROOT / lock).read_bytes()).hexdigest() for lock in locks
            },
        },
        indent=2,
    )
)
