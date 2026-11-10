const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, writeFile, chmod, readFile, realpath, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { prepareUpgrade, selectActiveSpace } = require("../src/desktop/core/space-bootstrap.cjs");

test("upgrade choice reuses the same space request and never starts the old Host", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "areal-bootstrap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "areal");
  const log = join(root, "calls");
  await writeFile(
    binary,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.AREAL_TEST_CALLS, JSON.stringify(args) + '\\n');
console.log(JSON.stringify(args[1] === 'preflight' ? {kind:'upgradeRequired'} : {state:'prepared'}));
`,
  );
  await chmod(binary, 0o700);
  const previous = process.env.AREAL_TEST_CALLS;
  process.env.AREAL_TEST_CALLS = log;
  t.after(() => {
    if (previous === undefined) delete process.env.AREAL_TEST_CALLS;
    else process.env.AREAL_TEST_CALLS = previous;
  });
  const app = { isPackaged: true, getLocale: () => "zh-CN", relaunch() {}, exit() {} };
  const dialog = { showMessageBox: async () => ({ response: 0 }) };
  const input = {
    app,
    dialog,
    binary,
    profile: join(root, "old"),
    coreHome: join(root, "core"),
    hostHome: join(root, "host"),
    startupError: undefined,
  };
  assert.equal(await prepareUpgrade(input), true);
  assert.equal(await prepareUpgrade(input), true);
  const calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(
    calls.map((args) => args[1]),
    ["preflight", "prepare", "activate", "preflight", "prepare", "activate"],
  );
  assert.equal(calls[1][3], calls[4][3]);
  assert.equal(calls[2][3], calls[1][3]);
});

test("explicit isolated profile bypasses active-space selection", () => {
  const env = { AREAL_GUI_USER_DATA: "/tmp/explicit" };
  assert.equal(
    selectActiveSpace({ isPackaged: true }, env, () => {
      throw Error("unexpected CLI");
    }),
    undefined,
  );
  assert.deepEqual(env, { AREAL_GUI_USER_DATA: "/tmp/explicit" });
});

test("unconfirmed activation never continues into the old backend", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "areal-bootstrap-failed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "areal");
  await writeFile(
    binary,
    `#!/usr/bin/env node
if (process.argv[3] === 'activate') process.exit(1);
console.log(JSON.stringify(process.argv[3] === 'preflight' ? {kind:'upgradeRequired'} : {state:'prepared'}));
`,
  );
  await chmod(binary, 0o700);
  let exited = false;
  let count = 0;
  const app = {
    isPackaged: true,
    getLocale: () => "en",
    relaunch() {
      throw Error("unexpected relaunch");
    },
    exit() {
      exited = true;
    },
  };
  const dialog = { showMessageBox: async () => ({ response: count++ === 0 ? 0 : 1 }) };
  const handled = await prepareUpgrade({
    app,
    dialog,
    binary,
    profile: join(root, "old"),
    coreHome: join(root, "core"),
    hostHome: join(root, "host"),
    startupError: undefined,
  });
  assert.equal(handled, true);
  assert.equal(exited, true);
});

test("unreadable active space prevents fallback to the old backend", () => {
  const env = {};
  assert.equal(
    selectActiveSpace({ isPackaged: true }, env, () => "/missing-binary"),
    undefined,
  );
  assert.equal(env.AREAL_SPACE_BOOTSTRAP_ERROR, "1");
});

test("selected space clears inherited old configuration and workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "areal-bootstrap-active-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "areal");
  await writeFile(
    binary,
    `#!/usr/bin/env node
const path = require('node:path');
const root = process.env.AREAL_TEST_ROOT;
const active = {spaceId:'11111111-1111-4111-8111-111111111111',manifestDigest:'digest'};
console.log(JSON.stringify(process.argv[3] === 'active' ? active : {...active, profile:path.join(root,'profile'),coreHome:path.join(root,'core'),hostHome:path.join(root,'host'),configHome:path.join(root,'host')}));
`,
  );
  await chmod(binary, 0o700);
  const env = {
    PATH: process.env.PATH,
    AREAL_TEST_ROOT: root,
    AREAL_CORE_CONFIG: "/old/config",
    AREAL_HARNESS_CONFIG: "/old/other",
    AREAL_CORE_WORKSPACE: "/old/project",
  };
  assert.equal(
    selectActiveSpace({ isPackaged: true }, env, () => binary),
    join(root, "profile"),
  );
  assert.equal(env.AREAL_HARNESS_HOME, join(root, "host"));
  assert.equal(env.AREAL_CORE_CONFIG, undefined);
  assert.equal(env.AREAL_HARNESS_CONFIG, undefined);
  assert.equal(env.AREAL_CORE_WORKSPACE, undefined);
});

test("marked test roots cannot redirect preflight to a real user profile", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "areal-bootstrap-isolated-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "profile"));
  await mkdir(join(root, "core"));
  await mkdir(join(root, "host"));
  await writeFile(
    join(root, ".areal-test-space-root.json"),
    JSON.stringify({ version: 1, testOnly: true }),
    { mode: 0o600 },
  );
  const prior = process.env.AREAL_SPACES_TEST_ROOT;
  process.env.AREAL_SPACES_TEST_ROOT = root;
  t.after(() => {
    if (prior === undefined) delete process.env.AREAL_SPACES_TEST_ROOT;
    else process.env.AREAL_SPACES_TEST_ROOT = prior;
  });
  const app = { isPackaged: true, getLocale: () => "en", relaunch() {}, exit() {} };
  await assert.rejects(
    prepareUpgrade({
      app,
      dialog: {},
      binary: "/not-used",
      profile: "/",
      coreHome: join(root, "core"),
      hostHome: join(root, "host"),
      startupError: undefined,
    }),
    /Invalid isolated upgrade test root/,
  );
});
