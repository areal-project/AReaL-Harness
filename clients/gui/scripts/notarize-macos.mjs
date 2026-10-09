#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { join, resolve, dirname, basename, sep } from "node:path";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
  realpathSync,
  openSync,
  closeSync,
  unlinkSync,
  rmSync,
  renameSync,
  statSync,
} from "node:fs";
// Core 的摘要校验要求签名后更新清单，并排除后续 Electron 重签。
async function signCoreTools({ directory, manifest, identity, run }) {
  const signed = [];
  for (const relative of [
    "bin/areal",
    "libexec/areal/areal-runtime",
    "libexec/areal/areal-runtime-fs",
  ]) {
    const binary = join(directory, relative);
    assert.equal(hash(binary), manifest.files[relative], "Input Core digest differs: " + relative);
    run("/usr/bin/codesign", [
      "--force",
      "--sign",
      identity,
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

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let repo = resolve(desktop, "../..");
const require = createRequire(join(desktop, "app/package.json"));
const readJSON = (path) => JSON.parse(readFileSync(path, "utf8"));
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
let output, state, lock;

function save() {
  const path = join(output, "notarization.json");
  writeFileSync(path + ".tmp", JSON.stringify(state, null, 2) + "\n");
  // Same-directory rename leaves the previous complete state after interruption.
  renameSync(path + ".tmp", path);
}
function record(bin, args, result) {
  if (output && existsSync(output))
    appendFileSync(
      join(output, "commands.log"),
      JSON.stringify({
        command: [bin, ...args],
        exitCode: result.status,
        stdout: String(result.stdout || ""),
        stderr: String(result.stderr || ""),
      }) + "\n",
    );
}
function run(bin, args, { allowed = [0], stdout, env = process.env } = {}) {
  console.error("→ " + basename(bin) + " " + (args[0] || ""));
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env,
    stdio: ["ignore", stdout ?? "pipe", "pipe"],
  });
  record(bin, args, result);
  if (result.error) throw result.error;
  assert.ok(
    allowed.includes(result.status),
    basename(bin) +
      " failed (" +
      result.status +
      "): " +
      (result.stderr || result.stdout || "See commands.log"),
  );
  return result;
}
function takeLock() {
  try {
    lock = openSync(join(output, ".notarize-lock"), "wx");
  } catch {
    throw new Error(
      "Output is locked. Confirm its previous process stopped before removing .notarize-lock.",
    );
  }
  writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
}
function summary() {
  return {
    status: state.phase,
    output,
    submissions: state.notarization,
    artifacts: state.artifacts,
  };
}
function assertApp() {
  const app = join(output, state.appName);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  const detail = run("/usr/bin/codesign", ["--display", "--verbose=4", app]).stderr;
  assert.ok(detail.includes("TeamIdentifier=" + state.teamId), "App signing Team changed");
  assert.ok(detail.includes("flags=0x10000(runtime)"), "App must use Hardened Runtime");
  const cdhash = /^CDHash=(.+)$/m.exec(detail)?.[1];
  assert.ok(cdhash, "Missing app CodeDirectory hash");
  if (state.cdhash) assert.equal(cdhash, state.cdhash, "Signed app changed after submission");
  else {
    state.cdhash = cdhash;
    save();
  }
}

async function main() {
  const { values: options } = parseArgs({
    options: {
      help: { type: "boolean" },
      app: { type: "string" },
      output: { type: "string" },
      identity: { type: "string" },
      "keychain-profile": { type: "string" },
      resume: { type: "boolean" },
      "wait-seconds": { type: "string", default: "60" },
    },
  });
  if (options.help) {
    console.log(
      "Usage: node clients/gui/scripts/notarize-macos.mjs\n" +
        "  --app /absolute/AReaL\\ Harness.app --output /absolute/new-directory\n" +
        '  --identity "Developer ID Application: Name (TEAMID)" --keychain-profile profile\n' +
        "  [--wait-seconds 60]\n\n" +
        "Resume: --resume --output /absolute/existing-directory [--wait-seconds 60]\n" +
        "Identity/profile can also use CSC_NAME / APPLE_KEYCHAIN_PROFILE.\n" +
        "Requires macOS, Xcode notarytool, installed project dependencies and an existing\n" +
        "AReaL Core GUI .app. Copies input; produces notarized ZIP/DMG and JSON evidence.\n" +
        "Exit 0: complete; 2: Apple still processing (resume); 1: failed, inspect logs.\n" +
        "Never publishes, changes update feeds, creates credentials, or replaces the source app.",
    );
    return;
  }
  assert.equal(process.platform, "darwin", "macOS is required");
  assert.ok(options.output, "--output is required");
  const wait = Number(options["wait-seconds"]);
  assert.ok(Number.isInteger(wait) && wait >= 1 && wait <= 3600, "--wait-seconds must be 1..3600");
  const requestedOutput = resolve(options.output);
  if (options.resume) {
    assert.ok(
      !options.app && !options.identity && !options["keychain-profile"],
      "Resume uses the saved app, identity and profile; do not provide replacements",
    );
    output = realpathSync(requestedOutput);
    state = readJSON(join(output, "notarization.json"));
    assert.equal(state.schema, 1, "Unsupported state schema");
    assert.equal(state.output, output, "Resume in the original output directory");
    takeLock();
    assert.notEqual(
      state.phase,
      "preparing",
      "Signing was interrupted. Inspect logs and start with a new output directory.",
    );
    if (state.phase === "complete") {
      for (const [name, artifact] of Object.entries(state.artifacts)) {
        assert.equal(
          hash(join(output, name)),
          artifact.sha256,
          "Completed artifact changed: " + name,
        );
      }
      console.log(JSON.stringify(summary(), null, 2));
      return;
    }
    assertApp();
  } else {
    // All preflight checks precede output creation or changes to the input app.
    assert.ok(!existsSync(requestedOutput), "Output already exists; use --resume for a known run");
    assert.ok(options.app, "--app is required");
    const source = realpathSync(resolve(options.app));
    assert.ok(source.endsWith(".app"), "--app must be an application bundle");
    output = join(realpathSync(dirname(requestedOutput)), basename(requestedOutput));
    assert.ok(!output.startsWith(source + sep), "Output must not be inside the source app");
    const appName = basename(source);
    const info = JSON.parse(
      execFileSync(
        "/usr/bin/plutil",
        ["-convert", "json", "-o", "-", join(source, "Contents/Info.plist")],
        { encoding: "utf8" },
      ),
    );
    assert.equal(info.CFBundleIdentifier, "org.areal.harness.gui", "Expected an AReaL Harness app");
    assert.match(
      info.CFBundleShortVersionString,
      /^[0-9A-Za-z][0-9A-Za-z.+-]*$/,
      "Invalid app version",
    );
    assert.ok(
      existsSync(join(source, "Contents/Frameworks/Electron Framework.framework")),
      "Missing Electron framework",
    );
    const manifestRelative = "Contents/Resources/areal-core/manifest.json";
    const manifest = readJSON(join(source, manifestRelative));
    assert.equal(manifest.apiVersion, "areal.core.v1", "Missing Core bundle");
    assert.equal(
      manifest.platform,
      "darwin/arm64",
      "This command currently supports macOS arm64 packages",
    );
    const identity = options.identity || process.env.CSC_NAME;
    const profile = options["keychain-profile"] || process.env.APPLE_KEYCHAIN_PROFILE;
    assert.ok(identity && identity !== "-", "A Developer ID Application identity is required");
    assert.ok(profile && !profile.startsWith("-"), "A Keychain profile is required");
    // Resolve only an exact valid identity, never an ambiguous substring.
    const inventory = execFileSync(
      "/usr/bin/security",
      ["find-identity", "-v", "-p", "codesigning"],
      { encoding: "utf8" },
    );
    const matches = [...inventory.matchAll(/([A-F0-9]{40}) "([^"]+)"/g)].filter(
      (match) => match[1] === identity || match[2] === identity,
    );
    assert.equal(
      matches.length,
      1,
      "Identity must match one valid keychain certificate; use SHA-1 if names repeat",
    );
    const teamId = /^Developer ID Application: .+ \(([A-Z0-9]{10})\)$/.exec(matches[0][2])?.[1];
    assert.ok(teamId, "The certificate must be Developer ID Application");
    execFileSync(
      "/usr/bin/xcrun",
      ["notarytool", "history", "--keychain-profile", profile, "--output-format", "json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const builderRequire = createRequire(require.resolve("electron-builder"));
    const { signAsync } = builderRequire("@electron/osx-sign");
    mkdirSync(output);
    takeLock();
    state = {
      schema: 1,
      phase: "preparing",
      output,
      source,
      appName,
      version: info.CFBundleShortVersionString,
      bundleId: info.CFBundleIdentifier,
      identity: matches[0][1],
      identityName: matches[0][2],
      teamId,
      profile,
      coreSourceRevision: manifest.sourceRevision,
      inputManifestSha256: hash(join(source, manifestRelative)),
      notarization: {},
      startedAt: new Date().toISOString(),
    };
    save();
    const app = join(output, appName);
    run("/usr/bin/ditto", [source, app]);
    const core = join(app, "Contents/Resources/areal-core");
    const ignored = await signCoreTools({
      directory: core,
      manifest,
      identity: state.identity,
      run,
    });
    writeFileSync(join(app, manifestRelative), JSON.stringify(manifest, null, 2) + "\n");
    await signAsync({
      app,
      identity: state.identity,
      platform: "darwin",
      type: "distribution",
      gatekeeperAssess: false,
      preAutoEntitlements: false,
      preEmbedProvisioningProfile: false,
      ignore: (path) => ignored.includes(path),
      optionsForFile: () => ({
        hardenedRuntime: true,
        entitlements: join(desktop, "scripts/entitlements.mac.plist"),
      }),
    });
    assertApp();
    run("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, join(output, "app-submission.zip")]);
    state.phase = "signed";
    save();
  }

  async function notarize(kind, archive) {
    const sha256 = hash(archive);
    const receiptPath = join(output, kind + "-submission.json");
    const previous = state.notarization[kind];
    if (previous) assert.equal(previous.sha256, sha256, "Submitted archive bytes changed: " + kind);
    else {
      state.notarization[kind] = { sha256, status: "Prepared" };
      save();
    }
    if (!existsSync(receiptPath)) {
      // Write Apple's stdout directly to a pre-created receipt. If interrupted
      // after upload, an empty receipt blocks duplicate submission on resume.
      const fd = openSync(receiptPath, "wx");
      try {
        const result = run(
          "/usr/bin/xcrun",
          [
            "notarytool",
            "submit",
            archive,
            "--keychain-profile",
            state.profile,
            "--output-format",
            "json",
          ],
          { stdout: fd, allowed: [0, 69] },
        );
        if (
          result.status === 69 &&
          /No Keychain password item found for profile:/.test(result.stderr) &&
          statSync(receiptPath).size === 0
        ) {
          // This observed failure is before authentication/upload. Unlike an
          // unknown interrupted submission it is safe to retry after setup.
          unlinkSync(receiptPath);
        }
        assert.equal(result.status, 0, "Apple upload failed: " + result.stderr);
      } finally {
        closeSync(fd);
      }
    }
    let receipt;
    try {
      receipt = readJSON(receiptPath);
    } catch {
      throw new Error(
        "Incomplete Apple upload receipt: " +
          receiptPath +
          ". Recover the submission ID using notarytool history/info before resuming; do not upload again blindly.",
      );
    }
    assert.match(receipt.id || "", /^[0-9a-f-]{36}$/i, "Invalid Apple submission ID");
    state.notarization[kind].id = receipt.id;
    save();
    const logPath = join(output, kind + "-notary-log.json");
    if (state.notarization[kind].status !== "Accepted") {
      const result = run(
        "/usr/bin/xcrun",
        [
          "notarytool",
          "wait",
          receipt.id,
          "--keychain-profile",
          state.profile,
          "--timeout",
          wait + "s",
          "--output-format",
          "json",
        ],
        { allowed: [0, 1, 124] },
      );
      if (result.status === 124) {
        state.notarization[kind].status = "In Progress";
        save();
        console.log(JSON.stringify(summary(), null, 2));
        process.exitCode = 2;
        return false;
      }
      const status = JSON.parse(result.stdout);
      state.notarization[kind].status = status.status;
      save();
      run("/usr/bin/xcrun", [
        "notarytool",
        "log",
        receipt.id,
        "--keychain-profile",
        state.profile,
        logPath,
      ]);
      assert.equal(status.status, "Accepted", "Apple rejected " + kind + "; inspect " + logPath);
    }
    if (!existsSync(logPath)) {
      run("/usr/bin/xcrun", [
        "notarytool",
        "log",
        receipt.id,
        "--keychain-profile",
        state.profile,
        logPath,
      ]);
    }
    const log = readJSON(logPath);
    assert.equal(log.jobId, receipt.id, "Apple log submission mismatch");
    assert.equal(log.sha256, sha256, "Apple log archive digest mismatch");
    assert.equal(log.status, "Accepted", "Apple log is not accepted");
    return true;
  }

  const app = join(output, state.appName);
  const stem = "AReaLHarness-" + state.version + "-macos-arm64";
  const zip = join(output, stem + ".zip"),
    dmg = join(output, stem + ".dmg");
  if (!(await notarize("zip", join(output, "app-submission.zip")))) return;
  if (state.phase === "signed") {
    run("/usr/bin/xcrun", ["stapler", "staple", app]);
    run("/usr/bin/xcrun", ["stapler", "validate", app]);
    assertApp();
    run("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=2", app]);
    require(join(desktop, "app/src/core/bundle.cjs")).verifyCoreBundle(
      join(app, "Contents/Resources"),
      { hashes: true },
    );
    run(process.execPath, [join(desktop, "scripts/migration-smoke.mjs")], {
      env: { ...process.env, AREAL_GUI_EXECUTABLE: join(app, "Contents/MacOS/AReaL Harness GUI") },
    });
    state.packagedGui = "passed";
    // These paths belong to this locked run and may contain interrupted output.
    for (const path of [zip, dmg, join(output, "dmg-root")])
      rmSync(path, { recursive: true, force: true });
    run("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, zip]);
    const staging = join(output, "dmg-root");
    mkdirSync(staging);
    run("/usr/bin/ditto", [app, join(staging, state.appName)]);
    run("/bin/ln", ["-s", "/Applications", join(staging, "Applications")]);
    run("/usr/bin/hdiutil", [
      "create",
      "-volname",
      "AReaL Harness " + state.version,
      "-srcfolder",
      staging,
      "-format",
      "UDZO",
      "-fs",
      "HFS+",
      dmg,
    ]);
    run("/usr/bin/codesign", ["--force", "--sign", state.identity, "--timestamp", dmg]);
    run("/usr/bin/codesign", ["--verify", "--strict", dmg]);
    const detail = run("/usr/bin/codesign", ["--display", "--verbose=4", dmg]).stderr;
    state.dmgCdhash = /^CDHash=(.+)$/m.exec(detail)?.[1];
    assert.ok(state.dmgCdhash, "Missing DMG CodeDirectory hash");
    state.zipSha256 = hash(zip);
    state.phase = "packaged";
    save();
  }
  assert.equal(hash(zip), state.zipSha256, "Final ZIP changed");
  if (state.phase !== "finalizing" && !(await notarize("dmg", dmg))) return;
  const dmgLog = readJSON(join(output, "dmg-notary-log.json"));
  assert.equal(dmgLog.status, "Accepted", "DMG must have an accepted Apple receipt");
  assert.equal(dmgLog.sha256, state.notarization.dmg.sha256, "DMG receipt digest mismatch");
  run("/usr/bin/codesign", ["--verify", "--strict", dmg]);
  const dmgDetail = run("/usr/bin/codesign", ["--display", "--verbose=4", dmg]).stderr;
  assert.equal(/^CDHash=(.+)$/m.exec(dmgDetail)?.[1], state.dmgCdhash, "Signed DMG changed");
  // Stapling changes DMG bytes. Persist the finalization boundary so a retry
  // after this point validates the ticket instead of comparing upload bytes.
  state.phase = "finalizing";
  save();
  run("/usr/bin/xcrun", ["stapler", "staple", dmg]);
  run("/usr/bin/xcrun", ["stapler", "validate", dmg]);
  run("/usr/bin/codesign", ["--verify", "--strict", dmg]);
  run("/usr/sbin/spctl", [
    "--assess",
    "--type",
    "open",
    "--context",
    "context:primary-signature",
    "--verbose=2",
    dmg,
  ]);
  const mount = join(output, "verify-mount");
  mkdirSync(mount, { recursive: true });
  run("/usr/bin/hdiutil", ["attach", dmg, "-readonly", "-nobrowse", "-mountpoint", mount]);
  let failure;
  try {
    const inside = join(mount, state.appName);
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", inside]);
    run("/usr/bin/xcrun", ["stapler", "validate", inside]);
    run("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=2", inside]);
  } catch (error) {
    failure = error;
  } finally {
    try {
      run("/usr/bin/hdiutil", ["detach", mount]);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
  state.artifacts = Object.fromEntries(
    [zip, dmg].map((path) => [basename(path), { sha256: hash(path) }]),
  );
  writeFileSync(
    join(output, "SHA256SUMS.txt"),
    Object.entries(state.artifacts)
      .map(([name, value]) => value.sha256 + "  " + name + "\n")
      .join(""),
  );
  state.phase = "complete";
  state.completedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify(summary(), null, 2));
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (lock !== undefined) {
    closeSync(lock);
    unlinkSync(join(output, ".notarize-lock"));
  }
}
