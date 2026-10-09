#!/usr/bin/env python3
"""按公开 URL 和固定哈希下载输入回放附件；不含原题答案或评分资产。"""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error("output must not exist")
    root = Path(__file__).resolve().parents[1]
    cases = json.loads((root / "tests/fixtures/arena-inputs.json").read_text())
    known = {}
    for case in cases:
        target = args.output / case["case"]
        (target / "assets").mkdir(parents=True)
        # 只验收原附件与工具链；此标记题面不用于模型能力或 Reward 评测。
        (target / "TASK.md").write_text("Public image replay: " + case["case"] + "\n")
        for asset in case["assets"]:
            destination = target / "assets" / asset["name"]
            digest = asset["sha256"]
            if digest in known:
                shutil.copyfile(known[digest], destination)
            elif "file" in asset:
                shutil.copyfile(root / asset["file"], destination)
            else:
                subprocess.run(
                    [
                        "curl",
                        "--fail",
                        "--location",
                        "--silent",
                        "--show-error",
                        "--max-time",
                        "60",
                        "--max-filesize",
                        str(asset["bytes"]),
                        "--output",
                        str(destination),
                        asset["url"],
                    ],
                    check=True,
                )
            with destination.open("rb") as stream:
                actual = hashlib.file_digest(stream, "sha256").hexdigest()
            if actual != digest or destination.stat().st_size != asset["bytes"]:
                raise ValueError("public fixture content changed: " + asset["name"])
            known[digest] = destination
        print(json.dumps({"case": case["case"], "verifiedAssets": len(case["assets"])}))


if __name__ == "__main__":
    main()
