"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, writeFile, realpath, rm, symlink } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, dirname } = require("node:path");
const { promisify } = require("node:util");
const childProcess = require("node:child_process");

async function fixture(t, scenario = "main") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "areal-package-users-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, "AReaL Harness GUI.app");
  const executable = join(bundle, "Contents/MacOS/AReaL Harness GUI");
  const main = join(
    bundle,
    "Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler",
  );
  const service = join(
    bundle,
    "Contents/Frameworks/AReaL Harness Service.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler",
  );
  const cli = join(bundle, "Contents/Resources/areal-core/bin/areal");
  for (const path of [executable, main, service, cli]) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "fixture");
  }
  const profile = join(root, "own profile"),
    home = join(root, "own backend");
  const databases = [
    join(profile, "diagnostics/main-crashes"),
    join(home, "diagnostics/desktop-crashes"),
    join(root, "other profile/diagnostics/main-crashes"),
  ];
  for (const path of databases) await mkdir(path, { recursive: true });
  const alias = join(root, "bundle alias.app");
  await symlink(bundle, alias);
  const helper =
    scenario === "service"
      ? service
      : scenario === "cli"
        ? cli
        : scenario === "alias"
          ? join(
              alias,
              "Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler",
            )
          : main;
  const database =
    scenario === "service" || scenario === "crossed"
      ? databases[1]
      : scenario === "foreign"
        ? databases[2]
        : databases[0];
  const uid = process.getuid?.() ?? 0,
    pid = 2147483001;
  const started = "Fri Oct 30 12:00:00 2026";
  const row = (path, time = started, user = uid) =>
    pid + " 1 " + user + " " + time + " " + path + "\n";
  let command = helper + " --monitor-self --database=" + database + " --annotation=prod=AReaL";
  if (scenario === "duplicate") command += " --database=" + database;
  if (scenario === "quoted") command = helper + ' --database="' + database + '"';
  if (scenario === "missing") command = helper + " --monitor-self";
  const original = childProcess.execFile;
  const fake = () => {};
  fake[promisify.custom] = async (_file, args) => {
    if (args.includes("-axo"))
      return {
        stdout:
          scenario === "unparsed"
            ? "unparsed " + helper
            : row(helper, started, scenario === "uid" ? uid + 1 : uid) +
              (scenario === "system uid"
                ? "2147483002 1 -2 Fri Oct 30 12:00:00 2026 /usr/bin/true\n"
                : ""),
        stderr: "",
      };
    if (args.at(-1).endsWith("args="))
      return { stdout: row(command, started, scenario === "uid" ? uid + 1 : uid), stderr: "" };
    return {
      stdout: row(helper, scenario === "changed" ? "Fri Oct 30 12:00:01 2026" : started),
      stderr: "",
    };
  };
  const path = require.resolve("../app/src/update/package-users.cjs");
  childProcess.execFile = fake;
  delete require.cache[path];
  const { assertPackageUsersReleased } = require(path);
  childProcess.execFile = original;
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin" });
  t.after(() => {
    Object.defineProperty(process, "platform", platform);
    delete require.cache[path];
  });
  return {
    run: () => assertPackageUsersReleased({ packaged: true, executable, profile, home }),
    pid,
  };
}

for (const scenario of ["main", "service", "alias", "system uid"])
  test(
    "only the current " + scenario + " reporter is released from the package gate",
    async (t) => {
      const f = await fixture(t, scenario);
      await f.run();
    },
  );

for (const scenario of [
  "foreign",
  "crossed",
  "cli",
  "duplicate",
  "quoted",
  "missing",
  "uid",
  "changed",
])
  test("package gate retains " + scenario + " ownership blockers", async (t) => {
    const f = await fixture(t, scenario);
    await assert.rejects(
      f.run(),
      (error) => error.code === "LIFECYCLE_BLOCKED" && error.message.includes(String(f.pid)),
    );
  });

test("unparsed process enumeration keeps the package gate closed", async (t) => {
  const f = await fixture(t, "unparsed");
  await assert.rejects(f.run(), (error) => error.code === "LIFECYCLE_BLOCKED");
});
