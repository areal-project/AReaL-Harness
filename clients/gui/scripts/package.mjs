import { makeTempDir } from "./support/temp.mjs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { cp, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { stageCoreApp } from "./stage-app.mjs";
import { stageMacOSService } from "./stage-macos-service.mjs";
import { buildMacOSDmg } from "./macos-dmg.mjs";
import { parseArgs } from "node:util";
import { signLocalMacOSApp } from "./macos-signing-paths.mjs";
const gui = fileURLToPath(new URL("..", import.meta.url));
const root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { values: options } = parseArgs({
  options: {
    help: { type: "boolean" },
    build: { type: "boolean" },
    platform: { type: "string", default: "mac" },
    arch: { type: "string", default: "arm64" },
    formats: { type: "string" },
    signing: { type: "string" },
    output: { type: "string" },
    identity: { type: "string" },
    "keychain-profile": { type: "string" },
    "dmg-only": { type: "boolean" },
    "skip-tests": { type: "boolean" },
  },
});
if (options.help) {
  console.log(
    "Usage: pnpm --dir clients/gui run dist --platform mac --arch arm64 --formats dmg,zip --signing none|adhoc|developer-id [--output NEW_DIRECTORY] [--identity ID --keychain-profile PROFILE] [--skip-tests]\n" +
      "dist builds release Core and GUI. Only native macOS arm64 is supported. none preserves input signatures; no launch trust is implied. developer-id requires both formats and performs notarization/acceptance (post-signing tests may be explicitly skipped). Never publishes. Resume pending Apple work with sign:mac --resume --output OUTPUT/signed.",
  );
  process.exit(0);
}
assert.ok(
  options.platform === "mac" && options.arch === "arm64",
  "Supported GUI target: mac/arm64 only; Linux/Windows and cross-compilation are not implemented",
);
const signing =
  options.signing || (process.env.AREAL_GUI_UNSIGNED_LOCAL === "1" ? "none" : "adhoc");
assert.ok(["none", "adhoc", "developer-id"].includes(signing), "Invalid --signing mode");
assert.ok(!options.formats || !options["dmg-only"], "Choose --formats or --dmg-only");
const formats = (options.formats || (options["dmg-only"] ? "dmg" : "dmg,zip")).split(",");
assert.ok(
  formats.length > 0 &&
    new Set(formats).size === formats.length &&
    formats.every((f) => ["dmg", "zip"].includes(f)),
  "--formats must contain dmg, zip or dmg,zip",
);
const developerId = signing === "developer-id";
assert.ok(
  !options["skip-tests"] || developerId,
  "--skip-tests applies only to Developer ID package acceptance",
);
const identity = options.identity || process.env.CSC_NAME;
const profile = options["keychain-profile"] || process.env.APPLE_KEYCHAIN_PROFILE;
assert.ok(
  developerId || (!options.identity && !options["keychain-profile"]),
  "Signing credentials require --signing developer-id",
);
if (developerId) {
  assert.ok(formats.length === 2, "Developer ID acceptance requires --formats dmg,zip");
  assert.ok(
    identity && profile,
    "Developer ID requires --identity and --keychain-profile (or CSC_NAME/APPLE_KEYCHAIN_PROFILE)",
  );
}
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("Local package acceptance currently targets macOS arm64");
const release = developerId || process.env.AREAL_GUI_RELEASE === "1";
const unsignedLocal = signing === "none";
if (release)
  assert.equal(
    execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(),
    "",
    "GUI release requires a clean source checkout",
  );
assert.ok(!(release && unsignedLocal), "Unsigned local packaging cannot enable release mode");
const output = resolve(
  options.output || process.env.AREAL_GUI_PACKAGE_DIR || join(gui, "dist", `local-${Date.now()}`),
);
try {
  await lstat(output);
  throw new Error("Package output already exists; choose a new --output directory");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
// Explicit command options own child process behavior, rather than inherited mode flags.
process.env.AREAL_GUI_UNSIGNED_LOCAL = unsignedLocal ? "1" : "0";
if (options.build) {
  process.env.AREAL_CORE_PROFILE = "release";
  for (const target of ["release", "gui-install", "gui-build"])
    execFileSync("make", [target], { cwd: root, stdio: "inherit" });
}
await mkdir(output, { recursive: true });
const staged = await makeTempDir("areal-stage-");
// stageCoreApp 要求新目录；使用临时目录的子目录隔离包管理器发现。
const appStage = join(staged, "app");
const dependencies = await stageCoreApp({ root: gui, destination: appStage });
if (process.env.AREAL_GUI_RELAY_CA_CERT) {
  const caPath = resolve(process.env.AREAL_GUI_RELAY_CA_CERT);
  const { normalizeNetworkSetting } = require(join(gui, "app/src/core/desktop-network.cjs"));
  normalizeNetworkSetting("httpProxyCaCertPath", caPath);
  await cp(caPath, join(appStage, "assets/relay-ca.pem"));
}
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
  await writeFile(
    nativeUpdateConfig,
    require("yaml").stringify({
      provider: "generic",
      url: githubFeedUrl,
      updaterCacheDirName: "areal-harness-gui-updater",
      useMultipleRangeRequest: false,
    }),
  );
}
const bundle = join(output, "areal-core");
// 验收可固定已校验的 Core bundle，避免并行 Cargo 构建切换输入字节。
if (process.env.AREAL_GUI_CORE_BUNDLE) {
  await cp(resolve(process.env.AREAL_GUI_CORE_BUNDLE), bundle, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
} else {
  execFileSync(
    "python3",
    [
      join(root, "scripts/package.py"),
      "--profile",
      process.env.AREAL_CORE_PROFILE || (release ? "release" : "debug"),
      "--output",
      bundle,
      ...(unsignedLocal ? ["--unsigned-local"] : []),
    ],
    { cwd: root, stdio: "inherit" },
  );
}
const { verifyCoreBundle } = require(join(gui, "app/src/core/bundle.cjs"));
const coreBundle = verifyCoreBundle(output, { hashes: true });
if (release)
  assert.equal(
    coreBundle.manifest.profile,
    "release",
    "GUI release requires a release Core bundle",
  );
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
      {
        from: join(gui, "native/computer-helper/build/AReaL Computer Helper.app"),
        to: "computer-helper/AReaL Computer Helper.app",
      },
      ...(release
        ? [
            { from: updateConfig, to: "areal-update.json" },
            { from: nativeUpdateConfig, to: "app-update.yml" },
          ]
        : []),
    ],
    mac: { icon, identity: null, notarize: false, category: "public.app-category.developer-tools" },
    publish: null,
  },
});
const app = join(output, "package/mac-arm64/AReaL Harness GUI.app");
const backgroundService = await stageMacOSService(app);
if (release) {
  const native = require("yaml").parse(
    await readFile(join(app, "Contents/Resources/app-update.yml"), "utf8"),
  );
  assert.equal(native.provider, "generic");
  assert.equal(native.url, githubFeedUrl);
  assert.ok(
    typeof native.updaterCacheDirName === "string" && native.updaterCacheDirName.length > 0,
  );
}
// 本机无新增签名模式保留输入签名；不能把拼装后的 bundle 宣称为签名有效。
let signatureVerification;
if (!unsignedLocal) {
  await signLocalMacOSApp(app, (command, args) =>
    execFileSync(command, args, { stdio: "inherit" }),
  );
  signatureVerification = { valid: true };
} else {
  try {
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { stdio: "pipe" });
    signatureVerification = { valid: true };
  } catch (error) {
    signatureVerification = {
      valid: false,
      exitCode: error.status,
      detail: String(error.stderr ?? error.message).trim(),
    };
  }
}
verifyCoreBundle(join(app, "Contents/Resources"), { hashes: true });
const archive =
  formats.includes("zip") && !developerId
    ? join(output, "AReaL-Harness-GUI-mac-arm64.zip")
    : undefined;
if (archive)
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, archive]);
const dmg =
  formats.includes("dmg") && !developerId
    ? await buildMacOSDmg({
        app,
        destination: join(output, "AReaL-Harness-GUI-mac-arm64.dmg"),
        volumeName: "AReaL Harness Preview",
        verifySignatures: !unsignedLocal,
      })
    : undefined;
await writeFile(
  join(output, "package-evidence.json"),
  JSON.stringify(
    {
      target: { platform: options.platform, arch: options.arch },
      formats,
      signingMode: signing,
      app,
      archive,
      dmg,
      dependencies,
      backgroundService,
      builder: {
        node: process.version,
        executable: process.execPath,
        sha256: createHash("sha256")
          .update(await readFile(process.execPath))
          .digest("hex"),
      },
      core: JSON.parse(await readFile(join(bundle, "manifest.json"), "utf8")),
      signing: unsignedLocal
        ? "No new signatures; input signatures preserved; local validation only; launch and bundle trust not established"
        : "Ad-hoc staging only; run sign:mac for Developer ID signing and app/DMG notarization before installation acceptance",
      signatureVerification,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ app, archive, dmg, evidence: join(output, "package-evidence.json") }));

if (developerId) {
  try {
    execFileSync(
      process.execPath,
      [
        join(gui, "scripts/notarize-macos.mjs"),
        "--app",
        app,
        "--output",
        join(output, "signed"),
        "--identity",
        identity,
        "--keychain-profile",
        profile,
        ...(options["skip-tests"] ? ["--skip-tests"] : []),
      ],
      { cwd: root, stdio: "inherit" },
    );
  } catch (error) {
    process.exit(error.status || 1);
  }
}
