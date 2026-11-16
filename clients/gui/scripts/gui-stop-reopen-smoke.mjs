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
let application, app, page, child, host;
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
const service = async () => {
  try {
    const { pid, identity, desktopGeneration } = JSON.parse(
      await readFile(join(env.AREAL_CORE_HOME, "service.json"), "utf8"),
    );
    return { pid, identity, desktopGeneration };
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
  host = new HostClient();
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
  result.receipt = receipt;
  result.afterStop = await service();
  result.reached.push("stop receipt completed");
  await capture("after-stop");
  await quit();
  result.reached.push("GUI exited");
  host.close();
  host = null;
  await until(() => {
    try {
      process.kill(firstHost.pid, 0);
      return false;
    } catch (error) {
      if (error.code === "ESRCH") return true;
      throw error;
    }
  }, "original Host exits");
  const oldWorkbenchAlive = (() => {
    try {
      process.kill(firstService.pid, 0);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
  })();
  result.beforeReopen = { oldHostAlive: false, oldWorkbenchAlive, service: await service() };
  assert.equal(oldWorkbenchAlive, false, "original Workbench exits before GUI reopens");
  assert.equal(result.beforeReopen.service.missing, true, "retired service metadata is removed");
  await launch();
  result.reached.push("GUI reopened ready");
  await capture("after-reopen");
  host = new HostClient();
  await host.connect(env.AREAL_HARNESS_SERVICE_HOME);
  const secondHost = JSON.parse(
    await readFile(join(env.AREAL_HARNESS_SERVICE_HOME, "host/host.json"), "utf8"),
  );
  hostPids.push(secondHost.pid);
  const secondService = await service();
  assert.ok(secondService.pid);
  workbenchPids.push(secondService.pid);
  result.afterReopen = {
    hostPid: secondHost.pid,
    hostGeneration: host.generation,
    service: secondService,
  };
  assert.notEqual(host.generation, result.before.hostGeneration);
  assert.notEqual(secondService.pid, firstService.pid);
  assert.notEqual(secondService.desktopGeneration, firstService.desktopGeneration);
  result.reached.push("successor Host and workbench observed");
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
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
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
    const receipt = await observer.stop(randomUUID(), observer.generation, "cancel");
    assert.equal(receipt.state, "completed");
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
    gui: children.map(({ pid, exitCode, signalCode }) => ({ pid, exitCode, signalCode })),
    service: await service(),
  };
  if (alive.length || result.cleanupError) result.firstFailure ??= "cleanup incomplete";
  const stages = [
    "first GUI ready",
    "stop receipt completed",
    "GUI exited",
    "GUI reopened ready",
    "successor Host and workbench observed",
  ];
  result.unreached = stages.filter((stage) => !result.reached.includes(stage));
  for (const [name, hash] of Object.entries(hashes))
    assert.equal(sha(await readFile(join(dirname(binary), name))), hash);
  await writeFile(join(scratch, "manifest.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (result.firstFailure) process.exitCode = 1;
}
