#!/usr/bin/env python3
"""从验收 bundle 生成版本化归档、校验和及 Homebrew formula。"""

import argparse
import hashlib
import json
import re
import shutil
import tarfile
from pathlib import Path

TARGETS = {"darwin/arm64": "aarch64-apple-darwin", "linux/x86_64": "x86_64-unknown-linux-gnu"}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def archive(bundle, output):
    manifest = json.loads((bundle / "manifest.json").read_text())
    version = manifest["productVersion"].removeprefix("areal ")
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", version):
        raise ValueError("invalid product version")
    if manifest["profile"] != "release" or manifest["workingTree"]:
        raise ValueError("release artifacts require a clean release-profile bundle")
    if manifest["platform"] == "linux/x86_64":
        glibc = next(
            (p.get("verifiedVersion") for p in manifest.get("prerequisites", []) if "glibc" in p),
            None,
        )
        if glibc != "2.35":
            raise ValueError("Linux release must be built against the verified glibc 2.35 baseline")
    target = TARGETS[manifest["platform"]]
    output.mkdir(parents=True, exist_ok=True)
    path = output / f"areal-harness-v{version}-{target}.tar.gz"
    if path.exists():
        raise ValueError("archive already exists")
    with tarfile.open(path, "w:gz") as stream:
        stream.add(bundle, arcname="areal")
    (output / (path.name + ".sha256")).write_text(f"{sha(path)}  {path.name}\n")
    shutil.copy2(bundle / "manifest.json", output / f"manifest-{target}.json")
    return path


def formula(path, output, url=None):
    match = re.fullmatch(
        r"areal-harness-v(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)-aarch64-apple-darwin.tar.gz", path.name
    )
    if not match:
        raise ValueError("formula requires a macOS arm64 archive")
    version = match[1]
    url = (
        url
        or f"https://github.com/areal-project/AReaL-Harness/releases/download/v{version}/{path.name}"
    )
    # JSON 字符串与本处 Ruby 双引号字面量兼容；拒绝 Ruby 插值。
    if "#{" in url or not url.startswith(("https://", "file://")):
        raise ValueError("unsupported formula URL")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(f'''class Areal < Formula
  desc "Agent harness with a terminal UI and local tool runtime"
  homepage "https://github.com/areal-project/AReaL-Harness"
  url {json.dumps(url)}
  version "{version}"
  sha256 "{sha(path)}"
  license "Apache-2.0"

  depends_on arch: :arm64
  depends_on macos: :sequoia
  depends_on xcode: :clt

  def install
    prefix.install "bin", "libexec", "manifest.json", "LICENSE"
  end

  def caveats
    <<~EOS
      Configure your model in ~/.areal/config.toml before starting a task.
      Stop shared services before upgrading: areal service stop --workspace /path/to/workspace
      This developer release is ad-hoc signed, not Developer ID notarized.
    EOS
  end

  test do
    assert_equal "areal {version}", shell_output("#{{bin}}/areal --version").strip
    assert_path_exists prefix/"libexec/areal/areal-runtime"
    assert_path_exists prefix/"libexec/areal/areal-runtime-fs"
  end
end
''')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    pack = commands.add_parser("archive")
    pack.add_argument("--bundle", type=Path, required=True)
    pack.add_argument("--output", type=Path, required=True)
    brew = commands.add_parser("formula")
    brew.add_argument("--archive", type=Path, required=True)
    brew.add_argument("--output", type=Path, required=True)
    brew.add_argument("--url", help="local file URL for prepublication Homebrew verification")
    args = parser.parse_args()
    if args.command == "archive":
        print(archive(args.bundle, args.output))
    else:
        formula(args.archive, args.output, args.url)


if __name__ == "__main__":
    main()
