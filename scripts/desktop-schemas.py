"""临时生成全部桌面 schema 后比较或原子替换，失败不截断已提交契约。"""

import argparse
import json
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
GENERATORS = [
    ("areal-engine", "desktop-schema", [], "areal-core-v1.json"),
    ("areal-engine", "desktop-schema", ["--native-host"], "native-host-v2.json"),
    ("areal-protocol", "service-schema", [], "local-service-v1.json"),
]


def normalized(value):
    return json.dumps(json.loads(value), sort_keys=True, separators=(",", ":"))


def artifact_executable(output, example):
    paths = set()
    for line in output.splitlines():
        message = json.loads(line)
        if (
            message.get("reason") == "compiler-artifact"
            and message.get("target", {}).get("name") == example
            and "example" in message.get("target", {}).get("kind", [])
            and message.get("executable")
        ):
            paths.add(Path(message["executable"]))
    if len(paths) != 1:
        raise ValueError(f"expected one freshly built executable for {example}, got {paths}")
    return paths.pop()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="areal-schema-") as temporary:
        prepared = []
        for package, example, arguments, name in GENERATORS:
            artifacts = subprocess.check_output(
                [
                    "cargo",
                    "build",
                    "--locked",
                    "-q",
                    "--message-format=json",
                    "-p",
                    package,
                    "--example",
                    example,
                ],
                cwd=ROOT,
                text=True,
            )
            executable = artifact_executable(artifacts, example)
            # 只执行本次构建返回的路径，兼容 CARGO_TARGET_DIR 与配置 target-dir。
            value = subprocess.check_output([str(executable), *arguments], cwd=ROOT)
            normalized(value)
            generated = Path(temporary) / name
            generated.write_bytes(value)
            prepared.append((generated, ROOT / "schemas" / name))
        for generated, committed in prepared:
            if args.write:
                staged = committed.with_suffix(".json.tmp")
                staged.write_bytes(generated.read_bytes())
                staged.replace(committed)
            elif normalized(generated.read_bytes()) != normalized(committed.read_bytes()):
                raise SystemExit(f"schema differs: {committed.name}; run make desktop-schemas")
            print(f"schema verified: {committed.name}")


if __name__ == "__main__":
    main()
