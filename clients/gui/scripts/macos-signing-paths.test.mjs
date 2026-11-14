import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { preserveSignedPaths, signLocalMacOSApp } from "./macos-signing-paths.mjs";

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

test("Developer ID Core signing replaces build-derived identifiers with stable tool identities", async (t) => {
  const { signCoreTools } = await import("./macos-signing-paths.mjs");
  const { createHash } = await import("node:crypto");
  const root = await mkdtemp(join(tmpdir(), "areal-core-signing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {};
  for (const name of [
    "bin/areal",
    "libexec/areal/areal-runtime",
    "libexec/areal/areal-runtime-fs",
  ]) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), "fixture");
    files[name] = createHash("sha256").update("fixture").digest("hex");
  }
  const calls = [];
  const manifest = { files };
  await signCoreTools({
    directory: root,
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
