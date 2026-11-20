import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import {
  preserveSignedPaths,
  signLocalMacOSApp,
  createSigningFilter,
} from "./macos-signing-paths.mjs";

test("outer signing preserves Core bytes through main and background-service resource paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "areal-sign-paths-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const contents = join(root, "Candidate.app/Contents");
  const shared = join(contents, "Resources");
  const service = join(contents, "Frameworks/Service.app/Contents");
  await mkdir(shared, { recursive: true });
  await mkdir(service, { recursive: true });
  await symlink("../../../Resources", join(service, "Resources"));
  const names = [
    "areal-core/bin/areal",
    "areal-core/libexec/areal/areal-runtime",
    "areal-core/libexec/areal/areal-runtime-fs",
  ];
  const paths = [];
  for (const name of names) {
    const path = join(shared, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "signed Core: " + name);
    paths.push(path);
  }
  const others = [
    join(contents, "MacOS/GUI"),
    join(service, "MacOS/Service"),
    join(contents, "Frameworks/Native.framework/Versions/A/Native"),
  ];
  for (const other of others) {
    await mkdir(join(other, ".."), { recursive: true });
    await writeFile(other, "unsigned nested executable");
  }
  const ignore = preserveSignedPaths(paths);
  for (const path of [
    ...paths,
    ...names.map((name) => join(service, "Resources", name)),
    ...others,
  ]) {
    if (!ignore(path)) await writeFile(path, "outer signature");
  }
  for (let i = 0; i < paths.length; i++)
    assert.equal(await readFile(paths[i], "utf8"), "signed Core: " + names[i]);
  for (const other of others) assert.equal(await readFile(other, "utf8"), "outer signature");
  assert.equal(ignore(join(contents, "Resources/areal-core/LICENSE")), false);
});

test("missing protected input fails closed rather than silently ignoring another path", () => {
  assert.throws(() => preserveSignedPaths([join(tmpdir(), "absent-areal-signing-core", "areal")]));
});

test("local signing covers nested libraries before enclosing bundles without following resource aliases", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "areal-local-signing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, "Candidate.app");
  const frameworks = join(app, "Contents/Frameworks");
  const libraries = [
    "Electron.framework/Versions/A/Libraries/libmedia.dylib",
    "Service.app/Contents/Frameworks/Native.framework/addon.node",
  ];
  for (const name of libraries) {
    await mkdir(join(frameworks, name, ".."), { recursive: true });
    await writeFile(join(frameworks, name), "native fixture");
  }
  const resources = join(app, "Contents/Resources");
  await mkdir(resources);
  const addon = join(
    resources,
    "app.asar.unpacked/node_modules/@crowecawcaw/xa11y-darwin-arm64/xa11y.darwin-arm64.node",
  );
  await mkdir(join(addon, ".."), { recursive: true });
  await writeFile(addon, "native fixture");
  await writeFile(join(resources, "core.dylib"), "protected Core bytes");
  await symlink("../../../Resources", join(frameworks, "Service.app/Contents/Resources"));
  await symlink("../../Resources", join(frameworks, "ResourceAlias"));
  const calls = [];
  await signLocalMacOSApp(app, (command, args) => calls.push({ command, args }));
  assert.equal(calls.length, 8);
  assert.deepEqual(
    calls.filter((call) => call.args[0] === "--force").map((call) => call.args.at(-1)),
    [...libraries.map((name) => join(frameworks, name)), addon, app],
  );
  assert.equal(
    calls.some((call) => call.args.at(-1).includes("ResourceAlias")),
    false,
  );
  assert.equal(await readFile(join(resources, "core.dylib"), "utf8"), "protected Core bytes");
  assert.deepEqual(calls.at(-1).args, ["--verify", "--deep", "--strict", app]);
});

test("a failed nested signature prevents sealing an incomplete local app", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "areal-failed-signing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, "Candidate.app");
  await mkdir(join(app, "Contents/Frameworks"), { recursive: true });
  await writeFile(join(app, "Contents/Frameworks/library.dylib"), "fixture");
  const calls = [];
  await assert.rejects(
    signLocalMacOSApp(app, (_command, args) => {
      calls.push(args);
      throw new Error("nested signing failed");
    }),
    /nested signing failed/,
  );
  assert.equal(calls.length, 1);
  assert.equal(
    calls.some((args) => args.at(-1) === app),
    false,
  );
});

test("Developer ID Core signing retains credential identities across build bytes and locations", async (t) => {
  const { signCoreTools } = await import("./macos-signing-paths.mjs");
  const { createHash } = await import("node:crypto");
  const root = await mkdtemp(join(tmpdir(), "areal-core-signing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const build of ["previous", "successor"]) {
    const directory = join(root, build);
    const files = {};
    for (const name of [
      "bin/areal",
      "libexec/areal/areal-runtime",
      "libexec/areal/areal-runtime-fs",
    ]) {
      await mkdir(join(directory, name, ".."), { recursive: true });
      await writeFile(join(directory, name), build);
      files[name] = createHash("sha256").update(build).digest("hex");
    }
    const calls = [];
    const manifest = { files };
    await signCoreTools({
      directory,
      manifest,
      identity: "test-identity",
      run: (_command, args) => calls.push(args),
    });
    const signs = calls.filter((args) => args.includes("--sign"));
    assert.deepEqual(
      signs.map((args) => args[args.indexOf("--identifier") + 1]),
      ["org.areal.harness.core", "org.areal.harness.runtime", "org.areal.harness.runtime-fs"],
    );
    assert.ok(signs.every((args) => args.includes("--timestamp") && args.includes("runtime")));
  }
});

test("default packaging stops before building when distribution signing credentials are absent", async () => {
  const { spawnSync } = await import("node:child_process");
  const env = { ...process.env };
  for (const name of ["CSC_NAME", "APPLE_KEYCHAIN_PROFILE", "AREAL_GUI_UNSIGNED_LOCAL"])
    delete env[name];
  const result = spawnSync(process.execPath, [new URL("./package.mjs", import.meta.url).pathname], {
    env,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Developer ID requires --identity and --keychain-profile/);
});

test("distribution signing selects native code once and leaves data to the resource seal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "areal-sign-filter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, "Candidate.app");
  const framework = join(app, "Contents/Frameworks/Native.framework");
  await mkdir(join(framework, "Versions/A"), { recursive: true });
  const native = join(framework, "Versions/A/Native");
  await writeFile(native, Buffer.from("cffaedfe00000000", "hex"));
  await symlink("A", join(framework, "Versions/Current"));
  await symlink("Versions/Current/Native", join(framework, "Native"));
  const resources = join(app, "Contents/Resources");
  await mkdir(resources);
  const data = join(resources, "locale.pak");
  await writeFile(data, Buffer.from([0, 1, 2, 3, 4]));
  const core = join(resources, "core");
  await writeFile(core, Buffer.from("cafebabe00000000", "hex"));
  const ignore = createSigningFilter({ app, protectedPaths: [core] });
  assert.equal(ignore(data), true);
  assert.equal(ignore(native), false);
  assert.equal(ignore(join(framework, "Native")), true);
  assert.equal(ignore(join(framework, "Versions/Current/Native")), true);
  assert.equal(ignore(core), true);
  assert.equal(ignore(framework), false);
  assert.equal(ignore(app), false);
  assert.throws(() => ignore(join(resources, "missing")));
});

test(
  "filtered signing still seals resources and rejects later resource edits",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "areal-sign-seal-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const app = join(root, "Fixture.app");
    await mkdir(join(app, "Contents/MacOS"), { recursive: true });
    await mkdir(join(app, "Contents/Resources"));
    await copyFile("/usr/bin/true", join(app, "Contents/MacOS/fixture"));
    await writeFile(
      join(app, "Contents/Info.plist"),
      `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.areal.signing.fixture</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
    );
    const resource = join(app, "Contents/Resources/locale.pak");
    await writeFile(resource, Buffer.from([0, 1, 2, 3, 4]));
    const require = createRequire(new URL("../app/package.json", import.meta.url));
    const builderRequire = createRequire(require.resolve("electron-builder"));
    const { signAsync } = builderRequire("@electron/osx-sign");
    const targets = [];
    await signAsync({
      app,
      platform: "darwin",
      identity: "-",
      identityValidation: false,
      gatekeeperAssess: false,
      preAutoEntitlements: false,
      preEmbedProvisioningProfile: false,
      ignore: createSigningFilter({ app, protectedPaths: [] }),
      optionsForFile: (path) => {
        targets.push(path);
        return {
          hardenedRuntime: true,
          entitlements: new URL("./entitlements.mac.plist", import.meta.url).pathname,
        };
      },
    });
    assert.ok(targets.includes(app));
    assert.ok(targets.includes(join(app, "Contents/MacOS/fixture")));
    assert.ok(!targets.includes(resource));
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
    await writeFile(resource, "changed resource");
    assert.throws(() =>
      execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { stdio: "pipe" }),
    );
  },
);

test(
  "notarization timing preserves failed runs across resume without contacting Apple",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "areal-sign-timing-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const { realpath } = await import("node:fs/promises");
    const output = await realpath(root);
    await writeFile(
      join(output, "notarization.json"),
      JSON.stringify({
        schema: 1,
        output,
        phase: "signed",
        appName: "Missing.app",
        historyPreflight: { passed: true },
      }),
    );
    for (let i = 0; i < 2; i++) {
      const result = spawnSync(
        process.execPath,
        [new URL("./notarize-macos.mjs", import.meta.url).pathname, "--resume", "--output", output],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 1, result.stderr);
    }
    const events = (await readFile(join(output, "notarization-timings.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(new Set(events.map((event) => event.runId)).size, 2);
    assert.deepEqual(
      events.map((event) => event.status),
      ["running", "failed", "running", "failed"],
    );
    const commands = (await readFile(join(output, "commands.log"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(commands.length, 2);
    for (const record of commands) {
      assert.equal(record.command[0], "/usr/bin/codesign");
      assert.equal(record.command[1], "--verify");
      assert.ok(record.durationMs >= 0);
      assert.notEqual(record.exitCode, 0);
    }
  },
);
