import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { stageCoreApp } from "./stage-app.mjs";
const gui = fileURLToPath(new URL("..", import.meta.url));
const root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("GUI package staging currently targets macOS arm64");
const output = resolve(
  process.env.AREAL_GUI_PACKAGE_DIR || join(gui, "dist", `local-${Date.now()}`),
);
await mkdir(output, { recursive: true });
const staged = await mkdtemp("/private/tmp/areal-stage-");
// stageCoreApp 要求新目录；使用临时目录的子目录隔离包管理器发现。
const appStage = join(staged, "app");
const dependencies = await stageCoreApp({ root: gui, destination: appStage });
const release = process.env.AREAL_GUI_RELEASE === "1";
const { githubFeedUrl } = require(join(gui, "app/src/update/config.cjs"));
const updateConfig = join(staged, "areal-update.json");
const nativeUpdateConfig = join(staged, "app-update.yml");
if (release) {
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  if (dirty.trim()) throw new Error("GUI release requires a clean source checkout");
  await writeFile(
    updateConfig,
    JSON.stringify({ engine: "electron", feedUrl: githubFeedUrl }) + "\n",
  );
  // dir 目标不会生成原生更新元数据；在签名前写入同一权威更新源与稳定缓存名。
  await writeFile(nativeUpdateConfig, require("yaml").stringify({
    provider: "generic", url: githubFeedUrl, updaterCacheDirName: "areal-harness-gui-updater",
    useMultipleRangeRequest: false,
  }));
}
const bundle = join(output, "areal-core");
execFileSync(
  "python3",
  [
    join(root, "scripts/package.py"),
    "--profile",
    process.env.AREAL_CORE_PROFILE || (release ? "release" : "debug"),
    "--output",
    bundle,
  ],
  { cwd: root, stdio: "inherit" },
);
const { verifyCoreBundle } = require(join(gui, "app/src/core/bundle.cjs"));
verifyCoreBundle(output, { hashes: true });
const iconset = join(staged, "app.iconset");
await mkdir(iconset);
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    execFileSync(
      "/usr/bin/sips",
      [
        "-z",
        String(size * scale),
        String(size * scale),
        join(gui, "app/assets/icon-1024.png"),
        "--out",
        join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`),
      ],
      { stdio: "ignore" },
    );
  }
}
const icon = join(staged, "app.icns");
execFileSync("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", icon]);
const { build, Platform, Arch } = require("electron-builder");
await build({
  publish: "never",
  targets: Platform.MAC.createTarget(["dir"], Arch.arm64),
  projectDir: appStage,
  config: {
    appId: "org.areal.harness.gui",
    productName: "AReaL Harness GUI",
    directories: { app: appStage, output: join(output, "package") },
    electronVersion: require("electron/package.json").version,
    electronDist: join(require.resolve("electron/package.json"), "../dist"),
    asar: true,
    npmRebuild: false,
    nodeGypRebuild: false,
    files: ["**/*"],
    extraResources: [
      { from: bundle, to: "areal-core" },
      { from: join(gui, "renderer/dist"), to: "areal-gui" },
      ...(release ? [
        { from: updateConfig, to: "areal-update.json" },
        { from: nativeUpdateConfig, to: "app-update.yml" },
      ] : []),
    ],
    mac: { icon, identity: null, notarize: false, category: "public.app-category.developer-tools" },
    publish: null,
  },
});
const app = join(output, "package/mac-arm64/AReaL Harness GUI.app");
if (release) {
  const native = require("yaml").parse(await readFile(join(app, "Contents/Resources/app-update.yml"), "utf8"));
  assert.equal(native.provider, "generic");
  assert.equal(native.url, githubFeedUrl);
  assert.ok(typeof native.updaterCacheDirName === "string" && native.updaterCacheDirName.length > 0);
}
// Apple Silicon 需要有效的本地代码签名；'-' 只做 ad-hoc，不查找证书。
execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
verifyCoreBundle(join(app, "Contents/Resources"), { hashes: true });
const archive = join(output, "AReaL-Harness-GUI-mac-arm64.zip");
execFileSync("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, archive]);
await writeFile(
  join(output, "package-evidence.json"),
  JSON.stringify(
    {
      app,
      archive,
      dependencies,
      core: JSON.parse(await readFile(join(bundle, "manifest.json"), "utf8")),
      signing: "Ad-hoc staging only; run sign:mac for Developer ID signing and app/DMG notarization before installation acceptance",
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ app, archive, evidence: join(output, "package-evidence.json") }));
