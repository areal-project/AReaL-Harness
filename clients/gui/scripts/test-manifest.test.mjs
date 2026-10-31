import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("./test-manifest.mjs", import.meta.url));
async function fixture(t, entries) {
  const root = await mkdtemp(join(tmpdir(), "areal-manifest-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"));
  await writeFile(join(root, "scripts/one.mjs"), "export {};\n");
  await writeFile(join(root, "scripts/two.mjs"), "export {};\n");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      scripts: {
        "test:one": "node scripts/one.mjs",
        "test:two": "node scripts/two.mjs",
        build: "build",
      },
    }),
  );
  await writeFile(join(root, "scripts/test-manifest.json"), JSON.stringify(entries));
  const run = (...args) =>
    spawnSync(process.execPath, [cli, "--root", root, ...args], { encoding: "utf8" });
  run.root = root;
  return run;
}
const one = {
  script: "test:one",
  layer: "contract",
  platforms: ["darwin", "linux"],
  areas: ["lifecycle"],
  requires: [],
};
const two = {
  script: "test:two",
  layer: "e2e",
  platforms: ["darwin"],
  platformReason: "Fixture requires macOS Electron.",
  areas: ["composer"],
  requires: ["electron"],
};

test("every package test script must have exactly one registration", async (t) => {
  assert.equal((await fixture(t, [one, two]))().status, 0);
  const missing = (await fixture(t, [one]))();
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /test:two/);
  const duplicate = (await fixture(t, [one, two, one]))();
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /duplicate.*test:one/i);
  assert.notEqual((await fixture(t, [one, two, { ...one, script: "test:old" }]))().status, 0);
});

test("invalid metadata cannot enter the selector", async (t) => {
  for (const patch of [
    { layer: "fast" },
    { platforms: ["unknown"] },
    { areas: [] },
    { requires: "electron" },
    { platforms: ["darwin"] },
  ]) {
    assert.notEqual((await fixture(t, [{ ...one, ...patch }, two]))().status, 0);
  }
});

test("selection intersects layer, platform, area, and available requirements", async (t) => {
  const run = await fixture(t, [one, two]);
  const selected = run("--list", "--platform=linux", "--layer=contract", "--area=lifecycle");
  assert.equal(selected.status, 0, selected.stderr);
  assert.deepEqual(JSON.parse(selected.stdout).scripts, ["test:one"]);
  assert.deepEqual(
    JSON.parse(run("--list", "--platform=darwin", "--layer=e2e").stdout).scripts,
    [],
  );
  assert.deepEqual(
    JSON.parse(run("--list", "--platform=darwin", "--layer=e2e", "--available=electron").stdout)
      .scripts,
    ["test:two"],
  );
});

test("temporary directory helper resolves platform aliases", async (t) => {
  const { makeTempDir } = await import("./support/temp.mjs");
  const { realpath } = await import("node:fs/promises");
  const dir = await makeTempDir("areal-temp-test-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(dir, await realpath(dir));
  assert.equal(dir.startsWith(await realpath(tmpdir())), true);
});

test("registered tests reject macOS temporary literals in source and imported helpers", async (t) => {
  const run = await fixture(t, [one, two]);
  await writeFile(
    join(run.root, "scripts/one.mjs"),
    'export const location = "/private/tmp/case";\n',
  );
  const direct = run();
  assert.notEqual(direct.status, 0);
  assert.match(direct.stderr, /one\.mjs.*platform-specific temporary path/);
  await writeFile(join(run.root, "scripts/one.mjs"), 'import "./helper.mjs";\n');
  await writeFile(
    join(run.root, "scripts/helper.mjs"),
    "export const location = `/var/folders/case`;\n",
  );
  const imported = run();
  assert.notEqual(imported.status, 0);
  assert.match(imported.stderr, /helper\.mjs.*platform-specific temporary path/);
  await writeFile(
    join(run.root, "scripts/helper.mjs"),
    'export const text = "a diagnostic mentioning /private/tmp";\n',
  );
  assert.equal(run().status, 0);
});

test("source audit patterns do not exempt actual temporary path literals", async (t) => {
  const run = await fixture(t, [one, two]);
  const pattern = String.raw`export const audit = (source) => /\/private\/tmp/.test(source);`;
  await writeFile(join(run.root, "scripts/one.mjs"), 'import "./helper.mjs";\n');
  await writeFile(join(run.root, "scripts/helper.mjs"), pattern);
  assert.equal(run().status, 0);
  await writeFile(
    join(run.root, "scripts/helper.mjs"),
    `${pattern}\nexport const location = "/private/tmp/case";\n`,
  );
  const actualPath = run();
  assert.notEqual(actualPath.status, 0);
  assert.match(actualPath.stderr, /helper\.mjs.*platform-specific temporary path/);
});

test("runner reports preserve failed attempts and separate Core from portable evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "areal-runner-report-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gui = join(root, "clients/gui");
  const scripts = join(gui, "scripts");
  const bin = join(root, "bin");
  await mkdir(scripts, { recursive: true });
  await mkdir(bin);
  for (const name of ["run-portable-tests.mjs", "test-manifest.mjs"])
    await copyFile(new URL(name, import.meta.url), join(scripts, name));
  await writeFile(
    join(gui, "package.json"),
    JSON.stringify({ scripts: { "test:one": "one", "test:core": "core" } }),
  );
  await writeFile(
    join(scripts, "test-manifest.json"),
    JSON.stringify([
      { ...one, requires: [] },
      { ...one, script: "test:core", requires: ["core-binary"] },
    ]),
  );
  await writeFile(
    join(bin, "pnpm"),
    `#!${process.execPath}\nprocess.exit(process.env.FAIL_RUNNER === '1' ? 23 : 0);\n`,
    { mode: 0o755 },
  );
  const core = join(bin, "core");
  await writeFile(core, `#!${process.execPath}\nconsole.log('{}');\n`, { mode: 0o755 });
  for (const args of [
    ["init", "-q"],
    [
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "user.name=fixture",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture",
    ],
  ])
    assert.equal(spawnSync("git", args, { cwd: root }).status, 0);
  const execute = (args, fail = false) => {
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      AREAL_CORE_BIN: args.length ? core : "",
      FAIL_RUNNER: fail ? "1" : "0",
    };
    delete env.AREAL_PORTABLE_TEST_REPORT;
    return spawnSync(process.execPath, [join(scripts, "run-portable-tests.mjs"), ...args], {
      cwd: gui,
      env,
      encoding: "utf8",
    });
  };
  const failed = execute([], true);
  assert.notEqual(failed.status, 0, failed.stderr);
  const portableRoot = join(root, "target/ci/gui/portable");
  const [first] = await readdir(portableRoot);
  const original = await readFile(join(portableRoot, first, "report.json"), "utf8");
  const report = JSON.parse(original);
  assert.equal(report.status, "failed");
  assert.equal(report.results[0].exitCode, 23);
  assert.equal(report.sourceRevision.length, 40);
  assert.equal(report.trackedDiffSha256.length, 64);
  assert.equal(report.coreSha256, null);
  assert.equal(execute([]).status, 0);
  assert.equal((await readdir(portableRoot)).length, 2);
  assert.equal(await readFile(join(portableRoot, first, "report.json"), "utf8"), original);
  assert.equal(execute(["--core-contracts"]).status, 0);
  const coreRoot = join(root, "target/ci/gui/core-contracts");
  const [coreRun] = await readdir(coreRoot);
  const coreReport = JSON.parse(await readFile(join(coreRoot, coreRun, "report.json"), "utf8"));
  assert.equal(coreReport.status, "passed");
  assert.deepEqual(coreReport.scripts, ["test:core"]);
  assert.equal(coreReport.coreSha256.length, 64);
});
