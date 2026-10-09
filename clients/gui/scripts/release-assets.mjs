import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const require = createRequire(new URL("../app/package.json", import.meta.url));
const { stringify } = require("yaml");
const {
  githubFeedUrl,
  githubReleaseUrl,
  stableVersion,
  validateUpdate,
} = require("../app/src/update/config.cjs");
const [inputArg, outputArg] = process.argv.slice(2);
assert.ok(
  inputArg && outputArg,
  "Usage: node clients/gui/scripts/release-assets.mjs signed-directory new-output-directory",
);
const input = resolve(inputArg),
  output = resolve(outputArg);
const state = JSON.parse(await readFile(join(input, "notarization.json"), "utf8"));
assert.equal(state.phase, "complete", "Signing and notarization must finish before release");
assert.ok(stableVersion(state.version));
const version = state.version;
const resources = join(input, state.appName, "Contents/Resources");
const config = JSON.parse(await readFile(join(resources, "areal-update.json"), "utf8"));
assert.deepEqual(config, { engine: "electron", feedUrl: githubFeedUrl });
const core = require("../app/src/core/bundle.cjs").verifyCoreBundle(resources, {
  hashes: true,
}).manifest;
assert.equal(core.profile, "release");
assert.equal(core.workingTree, false);
const checksum = (bytes, algorithm = "sha256", encoding = "hex") =>
  createHash(algorithm).update(bytes).digest(encoding);
await mkdir(output);
const artifacts = [];
for (const extension of ["zip", "dmg"]) {
  const name = `AReaLHarness-${version}-macos-arm64.${extension}`;
  const bytes = await readFile(join(input, name));
  assert.equal(checksum(bytes), state.artifacts[name].sha256, "Signed artifact changed");
  await cp(join(input, name), join(output, name));
  artifacts.push({
    name,
    size: bytes.length,
    sha256: checksum(bytes),
    sha512: checksum(bytes, "sha512", "base64"),
  });
}
const zip = artifacts[0];
const update = {
  version,
  files: [
    { url: `${githubReleaseUrl}/gui-v${version}/${zip.name}`, sha512: zip.sha512, size: zip.size },
  ],
  path: zip.name,
  sha512: zip.sha512,
  releaseDate: state.completedAt,
};
validateUpdate(update, githubFeedUrl, { engine: "electron" });
await writeFile(join(output, "latest-mac.yml"), stringify(update));
// 发布信息只包含来源和验证摘要，签名日志及本机路径留在本地。
await writeFile(
  join(output, "release.json"),
  JSON.stringify(
    {
      product: "AReaL Harness GUI",
      version,
      tag: `gui-v${version}`,
      repository: "areal-project/AReaL-Harness",
      feedUrl: githubFeedUrl,
      sourceRevision: core.sourceRevision,
      coreVersion: core.productVersion,
      platform: core.platform,
      notarization: Object.fromEntries(
        Object.entries(state.notarization).map(([key, value]) => [
          key,
          { id: value.id, status: value.status },
        ]),
      ),
      packagedGui: state.packagedGui,
      artifacts,
    },
    null,
    2,
  ) + "\n",
);
const names = [...artifacts.map((item) => item.name), "latest-mac.yml", "release.json"];
const sums = await Promise.all(
  names.map(async (name) => `${checksum(await readFile(join(output, name)))}  ${name}\n`),
);
await writeFile(join(output, "SHA256SUMS"), sums.join(""));
console.log(
  JSON.stringify({
    version,
    sourceRevision: core.sourceRevision,
    output,
    files: [...names, "SHA256SUMS"],
  }),
);
