#!/usr/bin/env python3
"""从验收 bundle 生成版本化归档、校验和及 Homebrew formula。"""

import argparse
import base64
import hashlib
import json
import re
import runpy
import shutil
import tarfile
import tempfile
from pathlib import Path

TARGETS = {"darwin/arm64": "aarch64-apple-darwin", "linux/x86_64": "x86_64-unknown-linux-gnu"}
ROOT = Path(__file__).resolve().parents[1]


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


def assemble(core_assets, gui_assets, output, version, revision):
    """只汇总同一提交的完整产物；不允许缺 GUI 或复用旧 Core。"""
    if not re.fullmatch(r"\d+\.\d+\.\d+", version) or not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("invalid release version or revision")
    installer = runpy.run_path(str(ROOT / "scripts/install.py"))
    sources = {}
    manifests = {}
    for platform, target in TARGETS.items():
        name = f"areal-harness-v{version}-{target}.tar.gz"
        archive_path = core_assets / name
        installer["verify_archive"](archive_path, core_assets / (name + ".sha256"), name)
        with tempfile.TemporaryDirectory(prefix="areal-release-verify-") as temporary:
            bundle = installer["extract_bundle"](archive_path, Path(temporary))
            installer["verify_bundle"](bundle, version, platform)
            manifest = json.loads((bundle / "manifest.json").read_text())
        if (
            manifest.get("manifestVersion") != 2
            or manifest.get("profile") != "release"
            or manifest.get("workingTree") is not False
            or manifest.get("sourceRevision") != revision
            or (
                platform == "linux/x86_64"
                and not any(
                    p.get("glibc") and p.get("verifiedVersion") == "2.35"
                    for p in manifest.get("prerequisites", [])
                )
            )
        ):
            raise ValueError("Core release identity or baseline mismatch")
        manifest_name = f"manifest-{target}.json"
        if json.loads((core_assets / manifest_name).read_text()) != manifest:
            raise ValueError("sidecar manifest differs from archive")
        manifests[platform] = manifest
        sources[name] = archive_path
        sources[manifest_name] = core_assets / manifest_name
    if len({(m["apiVersion"], m["stateVersion"]) for m in manifests.values()}) != 1:
        raise ValueError("Core platform contracts differ")

    gui = json.loads((gui_assets / "release.json").read_text())
    gui_version = gui.get("version", "")
    declared = [
        json.loads((ROOT / path).read_text())["version"]
        for path in ("clients/gui/package.json", "clients/gui/app/package.json")
    ]
    if (
        declared != [gui_version, gui_version]
        or gui.get("sourceRevision") != revision
        or gui.get("coreVersion") != "areal " + version
        or gui.get("platform") != "darwin/arm64"
        or gui.get("repository") != "areal-project/AReaL-Harness"
        or gui.get("tag") != "gui-v" + gui_version
        or gui.get("feedUrl")
        != "https://github.com/areal-project/AReaL-Harness/releases/download/gui-update-channel/"
        or gui.get("packagedGui") != "passed"
        or gui.get("packagedModelSelection") != "passed"
        or any(
            gui.get("notarization", {}).get(kind, {}).get("status") != "Accepted"
            for kind in ("zip", "dmg")
        )
    ):
        raise ValueError("GUI release identity or signed-package acceptance mismatch")
    names = {f"AReaLHarness-{gui_version}-macos-arm64.{ext}" for ext in ("zip", "dmg")}
    if len(gui.get("artifacts", [])) != 2 or {a["name"] for a in gui["artifacts"]} != names:
        raise ValueError("GUI requires exactly the versioned ZIP and DMG")
    for artifact in gui["artifacts"]:
        path = gui_assets / artifact["name"]
        installer["verify_archive"](path, gui_assets / "SHA256SUMS", path.name)
        digest = base64.b64encode(hashlib.sha512(path.read_bytes()).digest()).decode()
        if (
            sha(path) != artifact["sha256"]
            or path.stat().st_size != artifact["size"]
            or digest != artifact["sha512"]
        ):
            raise ValueError("GUI artifact digest or size mismatch")
        sources[path.name] = path
    for name in ("release.json", "latest-mac.yml"):
        installer["verify_archive"](gui_assets / name, gui_assets / "SHA256SUMS", name)
        sources[name] = gui_assets / name
    # 用已验证 ZIP 的摘要生成清单，保留旧客户端严格要求的 gui-v 地址。
    zip_asset = next(a for a in gui["artifacts"] if a["name"].endswith(".zip"))
    update = {
        "version": gui_version,
        "files": [
            {
                "url": f"https://github.com/areal-project/AReaL-Harness/releases/download/{gui['tag']}/{zip_asset['name']}",
                "sha512": zip_asset["sha512"],
                "size": zip_asset["size"],
            }
        ],
        "path": zip_asset["name"],
        "sha512": zip_asset["sha512"],
    }
    output.mkdir(parents=True, exist_ok=False)
    for name, source in sources.items():
        shutil.copy2(source, output / name)
    shutil.copy2(ROOT / "scripts/install.py", output / "install.py")
    formula(output / f"areal-harness-v{version}-aarch64-apple-darwin.tar.gz", output / "areal.rb")
    # JSON 是 YAML 的子集，避免发布汇总依赖额外的 YAML 解析器。
    (output / "latest-mac.yml").write_text(json.dumps(update, indent=2) + "\n")
    assets = [
        {"name": p.name, "size": p.stat().st_size, "sha256": sha(p)}
        for p in sorted(output.iterdir())
    ]
    (output / "release-manifest.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "version": version,
                "tag": "v" + version,
                "sourceRevision": revision,
                "guiVersion": gui_version,
                "guiCompatibilityTag": gui["tag"],
                "assets": assets,
            },
            indent=2,
        )
        + "\n"
    )
    (output / "SHA256SUMS").write_text(
        "".join(f"{sha(p)}  {p.name}\n" for p in sorted(output.iterdir()))
    )
    return output


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
    complete = commands.add_parser("assemble", help="validate and combine Core and notarized GUI")
    complete.add_argument("--core-assets", type=Path, required=True)
    complete.add_argument("--gui-assets", type=Path, required=True)
    complete.add_argument("--output", type=Path, required=True)
    complete.add_argument("--version", required=True)
    complete.add_argument("--revision", required=True)
    args = parser.parse_args()
    if args.command == "archive":
        print(archive(args.bundle, args.output))
    elif args.command == "formula":
        formula(args.archive, args.output, args.url)
    else:
        print(assemble(args.core_assets, args.gui_assets, args.output, args.version, args.revision))


if __name__ == "__main__":
    main()
