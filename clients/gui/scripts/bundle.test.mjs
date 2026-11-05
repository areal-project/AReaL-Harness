import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";

const { coreBundleFiles, verifyCoreBundle } = createRequire(import.meta.url)(
  "../../../services/workbench/src/desktop/core/bundle.cjs",
);
const shellFiles = ["bash", "sh", "COPYING", "corresponding-source.tar.gz", "build.json"].map(
  (name) => "libexec/areal/shells/" + name,
);

function fixture(t, shells) {
  const resources = mkdtempSync(join(tmpdir(), "areal-bundle-integrity-"));
  t.after(() => rmSync(resources, { recursive: true, force: true }));
  const root = join(resources, "areal-core");
  const manifest = {
    manifestVersion: 1,
    apiVersion: "areal.core.v1",
    platform: "darwin/arm64",
    stateVersion: 12,
    files: {},
    ...(shells ? { thirdPartyComponents: [{ name: "Bash" }] } : {}),
  };
  for (const file of [
    "bin/areal",
    "libexec/areal/areal-runtime",
    "libexec/areal/areal-runtime-fs",
    ...(shells ? shellFiles : []),
  ]) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "original " + file);
    manifest.files[file] = createHash("sha256")
      .update("original " + file)
      .digest("hex");
  }
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  const verify = () =>
    verifyCoreBundle(resources, { platform: "darwin", arch: "arm64", hashes: true });
  return { root, manifest, verify };
}

test("legacy bundles retain their original component contract", (t) => {
  fixture(t, false).verify();
});

test("private shell executable, license and source tampering is rejected", (t) => {
  const { root, verify } = fixture(t, true);
  verify();
  for (const file of shellFiles) {
    writeFileSync(join(root, file), "modified");
    assert.throws(verify, /校验失败/);
    writeFileSync(join(root, file), "original " + file);
  }
  verify();
});

test("declared shell components require complete assets and safe manifest paths", (t) => {
  const { manifest } = fixture(t, true);
  delete manifest.files[shellFiles[0]];
  assert.throws(() => coreBundleFiles(manifest), /缺少私有 shell/);
  manifest.files[shellFiles[0]] = "digest";
  manifest.files["libexec/areal/shells/../outside"] = "digest";
  assert.throws(() => coreBundleFiles(manifest), /路径无效/);
});
