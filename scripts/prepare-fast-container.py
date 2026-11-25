"""在 Linux 宿主构建并暂存快速容器验证所需的二进制与测试可执行文件。"""

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]

TEST_GROUPS = [
    (
        "native-runtime",
        [
            "cargo",
            "test",
            "--locked",
            "-p",
            "areal-runtime-exec-native",
            "-p",
            "areal-runtime",
            "--features",
            "areal-runtime/native-tests",
            "--no-run",
            "--message-format=json",
        ],
        [],
    ),
    (
        "provider-replay",
        [
            "cargo",
            "test",
            "--locked",
            "-p",
            "areal-engine",
            "--features",
            "native-tests",
            "--test",
            "provider_replay",
            "--no-run",
            "--message-format=json",
        ],
        [],
    ),
    (
        "side-workspace-read",
        [
            "cargo",
            "test",
            "--locked",
            "-p",
            "areal-app-server",
            "--test",
            "side_workspace_read",
            "--no-run",
            "--message-format=json",
        ],
        ["--ignored"],
    ),
]

RUNNER_SOURCE = """import json
from pathlib import Path
import subprocess
import sys

manifest = json.loads(Path("/src/target/ci/test-binaries.json").read_text())
exit_code = 0
for entry in manifest:
    cmd = [entry["binary"], *entry["args"]]
    print(f"==> running {entry['group']}: {' '.join(cmd)}", flush=True)
    completed = subprocess.run(cmd, cwd="/src")
    if completed.returncode != 0:
        exit_code = completed.returncode
raise SystemExit(exit_code)
"""


def extract_executables(output):
    executables = []
    seen = set()
    for line in output.splitlines():
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        if (
            message.get("reason") == "compiler-artifact"
            and message.get("profile", {}).get("test")
            and message.get("executable")
        ):
            path = Path(message["executable"])
            if path not in seen:
                seen.add(path)
                executables.append(path)
    return executables


def stage_binary(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    destination.chmod(0o755)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--bin-dir",
        type=Path,
        default=ROOT / "target/debug",
        help="Directory containing freshly built areal, areal-runtime, areal-runtime-fs and areal-runtime-reaper",
    )
    args = parser.parse_args()
    bin_dir = args.bin_dir.resolve()
    runtime_out = ROOT / "target/ci-container-bin"
    tests_out = ROOT / "target/ci-container-tests"
    for directory in (runtime_out, tests_out):
        if directory.exists():
            shutil.rmtree(directory)
        directory.mkdir(parents=True)

    for name in ("areal", "areal-runtime", "areal-runtime-fs", "areal-runtime-reaper"):
        source = bin_dir / name
        if not source.is_file():
            raise SystemExit(f"missing built binary: {source}")
        stage_binary(source, runtime_out / name)

    # 复用宿主已安装的锁定 Node 24.22.1，避免 Ubuntu 24.04 apt 旧版 Node 18 与重复下载。
    node_bin = shutil.which("node")
    if not node_bin:
        raise SystemExit("missing host node executable")
    stage_binary(Path(node_bin).resolve(), runtime_out / "node")

    for name in ("areal-runtime", "areal-runtime-fs", "areal-runtime-reaper"):
        stage_binary(bin_dir / name, tests_out / name)
    stage_binary(bin_dir / "areal-runtime-reaper", tests_out / "deps/areal-runtime-reaper")

    manifest = []
    for group, command, extra_args in TEST_GROUPS:
        completed = subprocess.run(command, cwd=ROOT, text=True, capture_output=True)
        if completed.returncode != 0:
            sys.stderr.write(completed.stderr)
            raise SystemExit(completed.returncode)
        binaries = extract_executables(completed.stdout)
        if not binaries:
            raise SystemExit(f"no test binaries built for {group}")
        for binary in binaries:
            target = tests_out / "deps" / binary.name
            stage_binary(binary, target)
            manifest.append(
                {
                    "group": group,
                    "binary": f"/src/target/ci/deps/{binary.name}",
                    "args": extra_args,
                }
            )

    (tests_out / "test-binaries.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (tests_out / "run-container-tests.py").write_text(RUNNER_SOURCE)
    print(f"staged {len(manifest)} container test binaries in {tests_out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
