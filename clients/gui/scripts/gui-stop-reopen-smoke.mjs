import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./support/temp.mjs";
import { applicationFixture } from "./application-fixture.mjs";
import { assertApplicationStopped, stopAndAssertFixtureHost } from "./application-cleanup.mjs";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const { HostClient } = require("@areal/client/node");
const { readOfflineHostReceipt } = require("../app/src/core/host-lifecycle.cjs");
const mode = process.argv[2];
assert.ok(["desktop", "host"].includes(mode), "choose desktop or host");
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
const stopId = randomUUID();
const bootstrap = `
const { appendFileSync } = require('node:fs');
const record = value => appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(value) + '\\n');
require('electron').dialog.showMessageBox = async (...args) => {
 const options = args.at(-1);
 const response = {'退出 AReaL Harness？': 0, '停止所有项目的后台任务？': 1}[options.message];
 if (response === undefined) throw new Error('Unexpected fixture dialog: ' + options.message);
 record({event:'dialog', options, response}); return {response};
};
const { SharedCoreBackend } = require(${JSON.stringify(join(gui, "app/src/core/service-client.cjs"))});
const originalStop = SharedCoreBackend.prototype.requestHostStop;
SharedCoreBackend.prototype.requestHostStop = async function(options) {
 const request = {...options, requestId: ${JSON.stringify(stopId)}};
 record({event:'stop-request', request});
 try { const result = await originalStop.call(this,request); record({event:'stop-receipt',result}); return result; }
 catch (error) { record({event:'stop-error',message:error.message}); throw error; }
};
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
  hosts = [];
let application, app, page, child, originalStop;
const until = async (fn, label, timeout = 60000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timeout: ${label}`);
};
const events = async () =>
  (await readFile(eventsPath, "utf8").catch(() => "")).split("\n").filter(Boolean).map(JSON.parse);
const readHost = async () => {
  try {
    const { pid, hostId, generation } = JSON.parse(
      await readFile(join(env.AREAL_HARNESS_SERVICE_HOME, "host/host.json"), "utf8"),
    );
    return { pid, hostId, generation };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};
async function observeHost() {
  const descriptor = await readHost();
  assert.ok(Number.isSafeInteger(descriptor?.pid) && descriptor.pid > 1);
  process.kill(descriptor.pid, 0);
  const host = new HostClient();
  try {
    await host.connect(env.AREAL_HARNESS_SERVICE_HOME);
    assert.equal(host.hostId, descriptor.hostId);
    assert.equal(host.generation, descriptor.generation);
    const backend = await host.request("backend.status", {});
    assert.equal(backend.owned, false);
    assert.equal(backend.service, null);
    hosts.push(descriptor);
    return descriptor;
  } finally {
    host.close();
  }
}
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
  const firstHost = await observeHost();
  result.before = firstHost;
  originalStop = {
    kind: "stopHost",
    requestId: stopId,
    home: env.AREAL_HARNESS_SERVICE_HOME,
    hostId: firstHost.hostId,
    generation: firstHost.generation,
    strategy: "cancel",
  };
  result.reached.push("first GUI ready");
  await capture("before-stop");
  if (mode === "desktop") {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "常规", exact: true }).click();
    await page.getByRole("button", { name: "打开高级诊断", exact: true }).click();
    const toggle = page.getByRole("switch", { name: "后台服务", exact: true });
    await toggle.waitFor();
    await capture("stop-control");
    await toggle.click();
  } else {
    await app.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu().items[0].submenu;
      const i = menu.items.findIndex((item) => item.id === "shared-host-activity");
      if (i < 0) throw new Error("Missing Host menu");
      menu.items[i + 1].click();
    });
  }
  const receipt = await until(
    async () => (await events()).find((e) => e.event === "stop-receipt"),
    "stop receipt",
  );
  assert.equal(receipt.result?.operation?.phase, "completed");
  assert.equal(receipt.result.stopped, true);
  const requests = (await events()).filter((event) => event.event === "stop-request");
  assert.deepEqual(
    requests.map(({ request }) => request),
    [{ strategy: "cancel", requestId: stopId }],
  );
  result.receipt = receipt;
  result.reached.push("stop receipt completed");
  await capture("after-stop");
  await quit();
  result.reached.push("GUI exited");
  const authoritative = await readOfflineHostReceipt(binary, originalStop);
  assert.equal(authoritative?.state, "completed");
  assert.deepEqual(authoritative, receipt.result.receipt);
  await assertApplicationStopped(binary, env, { pid: child.pid, hostPid: firstHost.pid });
  result.reached.push("original Host and project processes exited");
  await launch();
  result.reached.push("GUI reopened ready");
  await capture("after-reopen");
  const secondHost = await observeHost();
  result.afterReopen = secondHost;
  assert.notEqual(secondHost.pid, firstHost.pid);
  assert.notEqual(secondHost.generation, firstHost.generation);
  result.reached.push("successor Host observed");
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
  try {
    if (app) await quit();
    const current = await readHost();
    if (current && !hosts.some(({ pid }) => pid === current.pid)) hosts.push(current);
    if (current) {
      const originalRequested =
        originalStop?.generation === current.generation &&
        (await events()).some(({ event }) => event === "stop-request");
      if (originalRequested) {
        const receipt = await readOfflineHostReceipt(binary, originalStop);
        assert.equal(receipt?.state, "completed", "original stop remains unconfirmed");
      } else {
        result.cleanupReceipt = await stopAndAssertFixtureHost(binary, env, scratch, {
          pid: child?.pid,
        });
      }
    }
    for (const host of hosts)
      await assertApplicationStopped(binary, env, { pid: child?.pid, hostPid: host.pid });
  } catch (error) {
    result.cleanupError = error.stack;
  }
  await application?.close();
  result.cleanup = {
    hosts,
    gui: children.map(({ pid, exitCode, signalCode }) => ({ pid, exitCode, signalCode })),
  };
  if (result.cleanupError) result.firstFailure ??= "cleanup incomplete";
  const stages = [
    "first GUI ready",
    "stop receipt completed",
    "GUI exited",
    "original Host and project processes exited",
    "GUI reopened ready",
    "successor Host observed",
  ];
  result.unreached = stages.filter((stage) => !result.reached.includes(stage));
  for (const [name, hash] of Object.entries(hashes))
    assert.equal(sha(await readFile(join(dirname(binary), name))), hash);
  await writeFile(join(scratch, "manifest.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (result.firstFailure) process.exitCode = 1;
}
