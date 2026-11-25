import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./support/temp.mjs";
import { applicationFixture } from "./application-fixture.mjs";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const { HostClient } = require("@areal/client/node");
const mode = "crash";
const binary = process.env.AREAL_CORE_BIN;
assert.ok(binary && isAbsolute(binary), "AREAL_CORE_BIN must be an absolute fixed-bundle path");
const sha = (data) => createHash("sha256").update(data).digest("hex");
const hashes = Object.fromEntries(
  await Promise.all(
    ["areal", "areal-runtime", "areal-runtime-fs"].map(async (name) => [
      name,
      sha(await readFile(join(dirname(binary), name))),
    ]),
  ),
);
const scratch = await makeTempDir(`areal-stop-${mode}-`);
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
Object.assign(env, {
  AREAL_CORE_BIN: binary,
  AREAL_CORE_CONFIG: join(scratch, "config.toml"),
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: join(scratch, "user"),
  AREAL_HARNESS_HOME: join(scratch, "harness"),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  NO_PROXY: "127.0.0.1,localhost,::1",
  no_proxy: "127.0.0.1,localhost,::1",
});
await writeFile(env.AREAL_CORE_CONFIG, "schema_version=1\n");
const eventsPath = join(scratch, "events.jsonl");
const bootstrap = `
const { appendFileSync } = require('node:fs');
const record = value => appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(value) + '\\n');
require('electron').dialog.showMessageBox = async (...args) => {
 const options = args.at(-1); const response = options.message === '退出 AReaL Harness？' ? 0 : 1; record({event:'dialog', options, response}); return {response};
};
const { SharedCoreBackend } = require(${JSON.stringify(join(gui, "app/src/core/service-client.cjs"))});
for (const name of ['requestHostStop', 'stopService']) {
 const original = SharedCoreBackend.prototype[name];
 SharedCoreBackend.prototype[name] = async function(...args) {
  record({event:'stop-request', name, args});
  try { const result = await original.apply(this,args); record({event:'stop-receipt',name,result}); return result; }
  catch (error) { record({event:'stop-error',name,message:error.message}); throw error; }
 };
}
`;
const result = {
  mode,
  binary,
  hashes,
  source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  reached: [],
  firstFailure: null,
  unreached: [],
  cleanup: null,
};
const children = [],
  hostPids = [],
  workbenchPids = [];
let application, app, page, child, host, cleanupReceipt;
const isAlive = async (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};
const until = async (fn, label, timeout = 60000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timeout: ${label}`);
};
const service = async () => {
  try {
    const { pid, identity, desktopGeneration, owner } = JSON.parse(
      await readFile(join(env.AREAL_CORE_HOME, "service.json"), "utf8"),
    );
    return { pid, identity, desktopGeneration, owner };
  } catch (error) {
    if (error.code === "ENOENT") return { missing: true };
    throw error;
  }
};
const capture = async (name) => {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(scratch, `${name}.png`) }).catch(() => {});
    await writeFile(
      join(scratch, `${name}.txt`),
      await page
        .locator("body")
        .innerText()
        .catch(() => ""),
    );
  }
};
const launch = async () => {
  app = await electron.launch({
    executablePath: require("electron"),
    args: [application.path],
    env,
    timeout: 120000,
  });
  child = app.process();
  children.push(child);
  child.stderr.on(
    "data",
    (data) => void writeFile(join(scratch, "electron.log"), data, { flag: "a" }),
  );
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page
    .locator('[data-testid="areal-workbench"][data-startup-ready="true"]')
    .waitFor({ timeout: 120000 });
  await page.getByRole("button", { name: "设置", exact: true }).waitFor();
  await until(
    async () =>
      (await page.evaluate(() => window.arealDesktop.snapshot())).connection?.state === "ready",
    "GUI ready",
  );
};
const quit = async () => {
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()
      .items[0].submenu.items.find((item) => item.accelerator === "CmdOrCtrl+Q")
      .click(),
  );
  await until(() => child.exitCode !== null || child.signalCode !== null, "GUI exit");
  assert.equal(child.exitCode, 0);
  app = null;
};
console.log("Stop/reopen evidence:", scratch);
try {
  application = await applicationFixture(gui, join(scratch, "app"), bootstrap);
  await launch();
  host = new HostClient({ desktopCore: true });
  await host.connect(env.AREAL_HARNESS_SERVICE_HOME);
  const firstHost = JSON.parse(
    await readFile(join(env.AREAL_HARNESS_SERVICE_HOME, "host/host.json"), "utf8"),
  );
  hostPids.push(firstHost.pid);
  const firstService = await service();
  assert.ok(firstService.pid);
  workbenchPids.push(firstService.pid);
  result.before = {
    hostPid: firstHost.pid,
    hostGeneration: host.generation,
    service: firstService,
  };
  result.reached.push("first GUI ready");
  await capture("before-stop");
  const firstStatus = await host.request("backend.status", {});
  assert.equal(firstStatus.owned, true);
  for (const key of ["pid", "identity", "desktopGeneration"])
    assert.equal(firstStatus.service[key], firstService[key]);
  assert.notEqual(firstService.pid, firstHost.pid);
  assert.equal(firstService.owner.hostId, host.hostId);
  assert.equal(firstService.owner.generation, host.generation);
  const firstOwner = JSON.parse(
    await readFile(join(env.AREAL_CORE_HOME, "backend-owner.json"), "utf8"),
  );
  assert.deepEqual(firstOwner.owner, firstService.owner);
  for (const key of ["pid", "identity", "desktopGeneration"])
    assert.equal(firstOwner.service[key], firstService[key]);
  result.before.status = firstStatus;
  result.before.owner = firstOwner;
  await quit();
  result.reached.push("GUI exited preserving backend");
  assert.equal(await isAlive(firstHost.pid), true);
  assert.equal(await isAlive(firstService.pid), true);
  host.close();
  host = null;
  process.kill(firstService.pid, "SIGKILL");
  process.kill(firstHost.pid, "SIGKILL");
  await until(
    async () => !(await isAlive(firstHost.pid)) && !(await isAlive(firstService.pid)),
    "crashed Host and Workbench exit",
  );
  const orphan = await service();
  assert.deepEqual(orphan, firstService, "original service discovery survives crash");
  result.afterCrash = {
    service: orphan,
    owner: JSON.parse(await readFile(join(env.AREAL_CORE_HOME, "backend-owner.json"), "utf8")),
  };
  result.reached.push("orphan service record retained");
  await launch();
  result.reached.push("GUI reopened ready");
  await capture("after-reopen");
  host = new HostClient({ desktopCore: true });
  await host.connect(env.AREAL_HARNESS_SERVICE_HOME);
  const secondHost = host.identity;
  hostPids.push(secondHost.pid);
  const secondService = await service();
  const secondStatus = await host.request("backend.status", {});
  const secondOwner = JSON.parse(
    await readFile(join(env.AREAL_CORE_HOME, "backend-owner.json"), "utf8"),
  );
  workbenchPids.push(secondService.pid);
  assert.notEqual(host.generation, result.before.hostGeneration);
  assert.equal(secondStatus.owned, true);
  for (const key of ["pid", "identity", "desktopGeneration"])
    assert.equal(secondStatus.service[key], secondService[key]);
  assert.deepEqual(secondOwner.owner, secondService.owner);
  for (const key of ["pid", "identity", "desktopGeneration"])
    assert.equal(secondOwner.service[key], secondService[key]);
  assert.equal(secondService.owner.generation, host.generation);
  assert.equal(secondService.owner.hostId, host.hostId);
  assert.notEqual(secondService.owner.launchId, firstService.owner.launchId);
  assert.equal(secondService.identity, firstService.identity);
  assert.notEqual(secondService.desktopGeneration, firstService.desktopGeneration);
  result.afterReopen = {
    hostPid: secondHost.pid,
    hostGeneration: host.generation,
    service: secondService,
    status: secondStatus,
    owner: secondOwner,
  };
  result.reached.push("successor Host and Workbench identities verified");
} catch (error) {
  result.firstFailure = error.stack;
  if (page && !page.isClosed())
    result.failureState = await page
      .evaluate(() => ({
        snapshot: window.arealDesktop?.snapshot(),
        startupReady: document
          .querySelector('[data-testid="areal-workbench"]')
          ?.getAttribute("data-startup-ready"),
      }))
      .catch(() => null);
  await capture("failure");
} finally {
  if (app && child?.exitCode === null) {
    await quit().catch(() => {});
    await until(() => child.exitCode !== null || child.signalCode !== null, "GUI cleanup").catch(
      () => {},
    );
  }
  host?.close();
  const observer = new HostClient();
  try {
    const recordedHost = JSON.parse(
      await readFile(join(env.AREAL_HARNESS_SERVICE_HOME, "host/host.json"), "utf8").catch(
        () => "null",
      ),
    );
    if (recordedHost?.pid && !hostPids.includes(recordedHost.pid)) hostPids.push(recordedHost.pid);
    const recordedService = await service();
    if (recordedService.pid && !workbenchPids.includes(recordedService.pid))
      workbenchPids.push(recordedService.pid);
    await observer.connect(env.AREAL_HARNESS_SERVICE_HOME);
    const currentHost = JSON.parse(
      await readFile(join(env.AREAL_HARNESS_SERVICE_HOME, "host/host.json"), "utf8"),
    );
    if (!hostPids.includes(currentHost.pid)) hostPids.push(currentHost.pid);
    const currentService = await service();
    if (currentService.pid && !workbenchPids.includes(currentService.pid))
      workbenchPids.push(currentService.pid);
    const receipt = await observer.stop(randomUUID(), observer.generation, "ifIdle");
    assert.equal(receipt.state, "completed");
    cleanupReceipt = receipt;
  } catch (error) {
    if (
      !["ENOENT", "ECONNREFUSED"].includes(error.code) &&
      !error.message.includes("connection closed")
    )
      result.cleanupError = error.stack;
  } finally {
    observer.close();
  }
  const alive = [];
  for (const pid of [...hostPids, ...workbenchPids]) {
    try {
      await until(
        () => {
          try {
            process.kill(pid, 0);
            return false;
          } catch (error) {
            if (error.code === "ESRCH") return true;
            throw error;
          }
        },
        `process ${pid} exits`,
        10000,
      );
    } catch {
      alive.push(pid);
    }
  }
  await application?.close();
  result.cleanup = {
    hostPids,
    workbenchPids,
    alive,
    receipt: cleanupReceipt,
    gui: children.map(({ pid, exitCode, signalCode }) => ({ pid, exitCode, signalCode })),
    service: await service(),
  };
  if (alive.length || result.cleanupError) result.firstFailure ??= "cleanup incomplete";
  const stages = [
    "first GUI ready",
    "GUI exited preserving backend",
    "orphan service record retained",
    "GUI reopened ready",
    "successor Host and Workbench identities verified",
  ];
  result.unreached = stages.filter((stage) => !result.reached.includes(stage));
  for (const [name, hash] of Object.entries(hashes))
    assert.equal(sha(await readFile(join(dirname(binary), name))), hash);
  await writeFile(join(scratch, "manifest.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (result.firstFailure) process.exitCode = 1;
}
