import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { respondToSessionName } from "./model-fixture.mjs";
import {
  assertApplicationStopped,
  closeSmokeApplication,
  readFixtureHost,
  settleFixtureHostAfterQuit,
} from "./application-cleanup.mjs";
import { captureSmokeFailure, selectConversation } from "./smoke-navigation.mjs";
import { makeTempDir } from "./support/temp.mjs";
import { openProjectInDesktop, sendReady } from "./support/journey-fixture.mjs";
import { withCore } from "./support/core-observation.mjs";

const gui = resolve(import.meta.dirname, "..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const { readOfflineHostReceipt } = require("../app/src/core/host-lifecycle.cjs");
const { HostClient } = require("@areal/client/node");
const { nativeText } = require("@areal/workbench/node/native-i18n");
const binary = resolve(process.env.AREAL_CORE_BIN || join(gui, "../../target/debug/areal"));
const scratch = await makeTempDir("areal-lifecycle-");
const workspace = join(scratch, "demo");
const userHome = join(scratch, "user");
await mkdir(workspace);
await mkdir(userHome);
const checks = [],
  errors = [],
  requests = [],
  stops = [];
let application, page, originalHost, electronPid, threadId, finalStop;
const model = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    if (respondToSessionName(input, response)) return;
    requests.push({ count: input.messages.length });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const delta = { content: "Lifecycle fixture is running." };
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
    // Core 取消原轮次时关闭此响应；测试不会人为完成正在运行的业务。
  } catch (error) {
    errors.push(error.message);
    response.destroy();
  }
});
await new Promise((ready) => model.listen(0, "127.0.0.1", ready));
const config = join(scratch, "config.toml");
await writeFile(
  config,
  `schema_version=1\n[model]\ncatalog_version=1\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\nmodels=[{id="fixture",enabled=true}]\n`,
);
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) && key !== "ELECTRON_RUN_AS_NODE",
  ),
);
Object.assign(env, {
  HOME: userHome,
  AREAL_CORE_BIN: binary,
  AREAL_CORE_CONFIG: config,
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: userHome,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_HARNESS_HOME: join(scratch, "configuration"),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
});
const binarySha256 = createHash("sha256")
  .update(await readFile(binary))
  .digest("hex");
async function until(read, label) {
  const end = Date.now() + 30000;
  do {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 60));
  } while (Date.now() < end);
  throw Error(`Timeout: ${label}`);
}
const workbench = () => page.getByTestId("areal-workbench");
const command = (name, params) =>
  page.evaluate(({ name, params }) => window.arealDesktop.command(name, params), { name, params });
async function coreState() {
  return withCore({ binary, env, gui, workspace, threadId }, async (client) => {
    const [{ thread }, queue] = await Promise.all([
      client.request("thread/read", { threadId, includeTurns: true }),
      client.request("areal/queue/list", { threadId }),
    ]);
    assert.equal(thread.id, threadId);
    return { thread, queue };
  });
}
async function projectStatus() {
  const client = new HostClient();
  try {
    await client.connect(env.AREAL_HARNESS_SERVICE_HOME);
    return (await client.status()).projects.find(
      ({ registration }) => registration.workspace === workspace,
    );
  } finally {
    client.close();
  }
}
async function menuStop(confirm) {
  return application.evaluate(
    async ({ dialog, Menu }, { confirm, stopMenu, defaultLabel }) => {
      const dialogs = [];
      const show = dialog.showMessageBox;
      const menu = Menu.getApplicationMenu().items.flatMap((item) => item.submenu?.items ?? []);
      const target = menu.find(({ label }) => [stopMenu, defaultLabel].includes(label));
      if (!target) throw Error("Native stop menu unavailable");
      dialog.showMessageBox = async (...args) => {
        const { message, buttons } = args.at(-1);
        dialogs.push({ message, buttons });
        return { response: confirm ? 1 : 0 };
      };
      try {
        await target.click(target);
        return dialogs;
      } finally {
        dialog.showMessageBox = show;
      }
    },
    { confirm, stopMenu: nativeText("host.stopMenu"), defaultLabel: "Stop background…" },
  );
}
async function verifyStop(host, { replacing = false } = {}) {
  const stopped = await until(async () => {
    const path = join(env.AREAL_HARNESS_SERVICE_HOME, "host", "stop.json");
    const receipt = await readFile(path, "utf8")
      .then(JSON.parse)
      .catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
    return receipt?.generation === host.generation && receipt.state === "completed"
      ? receipt
      : null;
  }, "original Host stop receipt");
  const reference = {
    kind: "stopHost",
    home: env.AREAL_HARNESS_SERVICE_HOME,
    hostId: host.hostId,
    generation: host.generation,
    requestId: stopped.requestId,
    strategy: "cancel",
    pid: host.pid,
  };
  stops.push(reference);
  if (!replacing) await assertApplicationStopped(binary, env, { hostPid: host.pid });
  await until(() => {
    try {
      process.kill(host.pid, 0);
      return false;
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      return true;
    }
  }, "original Host process exits");
  assert.equal((await readOfflineHostReceipt(binary, reference))?.state, "completed");
  return stopped;
}
console.log("Lifecycle evidence:", scratch);
try {
  application = await electron.launch({
    executablePath: require("electron"),
    args: [
      join(gui, "app"),
      ...(process.platform === "darwin" ? ["-ApplePersistenceIgnoreState", "YES"] : []),
    ],
    env,
    timeout: 120000,
  });
  electronPid = application.process().pid;
  page = await application.firstWindow();
  page.setDefaultTimeout(30000);
  page.on("pageerror", (error) => errors.push(error.message));
  await workbench().waitFor({ timeout: 120000 });
  await application.context().addInitScript(() => {
    const key = "areal-gui:application-preferences";
    localStorage.setItem(
      key,
      JSON.stringify({
        ...JSON.parse(localStorage.getItem(key) ?? "{}"),
        locale: "zh-CN",
        followUp: "queue",
        nextPromptSuggestions: false,
      }),
    );
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('[data-startup-ready="true"][data-testid="areal-workbench"]').waitFor();
  originalHost = await readFixtureHost(env);
  assert.ok(originalHost?.pid > 1);
  await openProjectInDesktop(application, page, workspace);
  await page.getByRole("button", { name: "选择模型", exact: true }).click();
  await page.getByRole("radio", { name: "fixture", exact: true }).click();
  const input = page.getByTestId("chat-input");
  const send = page.getByTestId("chat-send-button");
  await input.fill("hold lifecycle");
  await sendReady(page);
  await send.click();
  threadId = await until(() => workbench().getAttribute("data-thread-id"), "original thread");
  await page.getByText("Lifecycle fixture is running.", { exact: true }).waitFor();
  const originalProject = await projectStatus();
  assert.ok(originalProject?.service?.generation);
  const originalTurn = (await coreState()).thread.turns.at(-1);
  assert.equal(originalTurn.status, "inProgress");

  for (const text of ["preserved first", "preserved second"]) {
    await input.fill(text);
    await send.click();
    await until(
      async () =>
        (await coreState()).queue.items.some((item) =>
          item.input.some((part) => part.text === text),
        ),
      "original queue item",
    );
  }
  const originalQueue = (await coreState()).queue.items;
  const preservedDraft = "unsent lifecycle draft";
  await input.fill(preservedDraft);

  const alias = await workbench().getAttribute("data-project-id");
  assert.ok(alias);
  for (const [name, params] of [
    ["stop", { projectId: alias, threadId }],
    ["serviceLifecycle", { operation: "stop", expectedTargets: [] }],
  ]) {
    const rejected = await command(name, params);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, "INVALID_DESKTOP_REQUEST");
  }
  assert.equal((await command("serviceLifecycle", { operation: "check" })).ok, true);
  assert.equal((await projectStatus()).service.generation, originalProject.service.generation);
  assert.equal((await coreState()).thread.turns.at(-1)?.status, "inProgress");
  checks.push("checking and invalid lifecycle commands preserve the original active Core");

  const declined = await menuStop(false);
  assert.equal(declined.length, 1);
  assert.equal(await input.innerText(), preservedDraft);
  assert.deepEqual((await coreState()).queue.items, originalQueue);
  assert.equal((await coreState()).thread.turns.at(-1)?.status, "inProgress");
  assert.equal(
    await readFixtureHost(env).then(({ generation }) => generation),
    originalHost.generation,
  );

  const confirmed = await menuStop(true);
  assert.deepEqual(confirmed, declined);
  await verifyStop(originalHost);
  await page.reload({ waitUntil: "domcontentloaded" });
  await workbench().waitFor();
  const ticket = await page.evaluate(async () => {
    try {
      await window.arealDesktop.getHostTicket();
      return "issued";
    } catch {
      return "unavailable";
    }
  });
  assert.equal(ticket, "unavailable", "document reload and ticket retry cannot start another Host");
  assert.equal(await readFixtureHost(env), null);
  assert.equal(requests.length, 1, "stop never sends queued input");
  checks.push("native menu cancellation and confirmed stop preserve queued input without replay");

  const reconnect = page.getByRole("button", { name: "重新连接后台", exact: true }).first();
  await reconnect.click();
  const successor = await until(async () => {
    const current = await readFixtureHost(env);
    return current?.generation !== originalHost.generation && current;
  }, "successor Host generation");
  originalHost = successor;
  await selectConversation(page, threadId);
  const opened = await command("connect", { projectId: alias, threadId });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const reopened = await projectStatus();
  assert.notEqual(reopened.service.generation, originalProject.service.generation);
  const retained = await coreState();
  assert.equal(retained.thread.turns.at(-1).id, originalTurn.id);
  assert.equal(retained.thread.turns.at(-1).status, "interrupted");
  assert.equal(retained.queue.paused, true);
  assert.deepEqual(retained.queue.items, originalQueue);
  assert.equal(requests.length, 1);
  assert.equal(await input.innerText(), preservedDraft);
  await page.screenshot({ path: join(scratch, "reopened-paused.png") });
  checks.push("explicit reconnect preserves original turn, paused queue and draft");

  await application.evaluate(({ dialog }) => {
    globalThis.lifecycleUpdatePrompts = [];
    dialog.showMessageBox = async (...args) => {
      globalThis.lifecycleUpdatePrompts.push(args.at(-1).message);
      return { response: 1 };
    };
  });
  const updated = await command("serviceLifecycle", { operation: "update" });
  assert.equal(updated.ok, true, JSON.stringify(updated));
  assert.equal(updated.value.stopped, true);
  const afterUpdate = await readFixtureHost(env);
  assert.ok(afterUpdate && afterUpdate.generation !== successor.generation);
  originalHost = afterUpdate;
  const updateReceipt = await verifyStop(successor, { replacing: true });
  assert.equal(updateReceipt.requestId, updated.value.operation.requestId);
  assert.equal((await application.evaluate(() => globalThis.lifecycleUpdatePrompts)).length, 1);
  for (const pid of [reopened.service.hostPid, reopened.service.corePid]) {
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }
  const resumed = await command("connect", { projectId: alias, threadId, resumeScheduling: true });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  await selectConversation(page, threadId);
  const afterUpdateThread = await coreState();
  assert.equal(afterUpdateThread.thread.turns.at(-1).id, originalTurn.id);
  assert.deepEqual(afterUpdateThread.queue.items, originalQueue);
  assert.equal(afterUpdateThread.queue.paused, true);
  assert.equal(await input.innerText(), preservedDraft);
  assert.equal(requests.length, 1);
  checks.push("explicit update replaces the original Host after one confirmed stop without replay");
} catch (error) {
  errors.push(error.stack ?? String(error));
  if (page && !page.isClosed()) await captureSmokeFailure(page, scratch, error);
} finally {
  if (application) {
    try {
      await application.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 });
      });
      await closeSmokeApplication(application, 30000);
    } catch (error) {
      errors.push(`Electron cleanup: ${error.message}`);
    }
  }
  try {
    const current = originalHost ?? (await readFixtureHost(env));
    if (current)
      finalStop = await settleFixtureHostAfterQuit(binary, env, scratch, {
        host: current,
        pid: electronPid,
      });
    else
      await assertApplicationStopped(binary, env, { pid: electronPid, hostPid: originalHost?.pid });
  } catch (error) {
    errors.push(`Host cleanup: ${error.message}`);
  }
  model.closeAllConnections();
  await new Promise((close) => model.close(close));
  const manifest = {
    passed: errors.length === 0,
    checks,
    errors,
    requests,
    stops,
    finalStop: finalStop?.requestId,
    electronPid,
    threadId,
    binarySha256,
    evidence: scratch,
  };
  await writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest));
  if (!manifest.passed) process.exitCode = 1;
}
