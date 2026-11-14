import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, realpathSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

// 后台服务的 Resources 链接回主应用；跳过物理文件的全部别名，避免二次签名使清单失效。
export function preserveSignedPaths(paths) {
  const protectedPaths = new Set(paths.map((path) => realpathSync(path)));
  return (path) => {
    try {
      return protectedPaths.has(realpathSync(path));
    } catch {
      return false;
    }
  };
}

export async function signLocalMacOSApp(app, run) {
  async function signLibraries(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      // 不沿 Service/Resources 等别名重复签名，Core 清单中的原生字节保持不变。
      if (entry.isDirectory()) await signLibraries(path);
      else if (entry.isFile() && /\.(?:dylib|node)$/.test(entry.name)) {
        // codesign --deep 会保留部分 linker-signed 动态库；严格验证仍可能通过，
        // 但新 SDK 的库在受限子进程加载时会被 AMFI 拒绝，必须先显式签名。
        run("/usr/bin/codesign", ["--force", "--sign", "-", path]);
        run("/usr/bin/codesign", ["--verify", "--strict", path]);
      }
    }
  }
  await signLibraries(join(app, "Contents", "Frameworks"));
  const unpacked = join(app, "Contents", "Resources", "app.asar.unpacked");
  if (existsSync(unpacked)) await signLibraries(unpacked);
  run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", app]);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
}

const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
// Core 的摘要校验要求签名后更新清单，并排除后续 Electron 重签。
export async function signCoreTools({ directory, manifest, identity, run }) {
  const identifiers = {
    "bin/areal": "org.areal.harness.core",
    "libexec/areal/areal-runtime": "org.areal.harness.runtime",
    "libexec/areal/areal-runtime-fs": "org.areal.harness.runtime-fs",
    "libexec/areal/shells/bash": "org.areal.harness.shell.bash",
    "libexec/areal/shells/sh": "org.areal.harness.shell.sh",
  };
  const signed = [];
  for (const relative of [
    "bin/areal",
    "libexec/areal/areal-runtime",
    "libexec/areal/areal-runtime-fs",
    ...["libexec/areal/shells/bash", "libexec/areal/shells/sh"].filter(
      (relative) => relative in manifest.files,
    ),
  ]) {
    const binary = join(directory, relative);
    assert.equal(hash(binary), manifest.files[relative], "Input Core digest differs: " + relative);
    run("/usr/bin/codesign", [
      "--force",
      "--sign",
      identity,
      // Rust linker 的默认标识含构建哈希，升级后会改变钥匙串访问身份。
      "--identifier",
      identifiers[relative],
      "--options",
      "runtime",
      "--timestamp",
      binary,
    ]);
    run("/usr/bin/codesign", ["--verify", "--strict", binary]);
    manifest.files[relative] = hash(binary);
    signed.push(binary);
  }
  manifest.signing = "Developer ID; verify enclosing app notarization";
  return signed;
}
