import { readFixtureHost, settleFixtureHostAfterQuit } from "./application-cleanup.mjs";
import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const { waitForServiceProcessExit } = require("../app/src/core/service-client.cjs");
const binary = process.env.AREAL_CORE_BIN || resolve(gui, "../../target/debug/areal");
const scratch = await makeTempDir("al-");
const workspace = join(scratch, "workspace"),
  home = join(scratch, "core");
await mkdir(workspace);
await mkdir(join(scratch, "user/.areal"), { recursive: true });
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
const checks = [],
  errors = [],
  requests = [],
  held = new Set(),
  dialogs = [];
const model = createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (delta, finish_reason = null) =>
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    const tool = (name, args) => {
      send({
        tool_calls: [
          {
            index: 0,
            id: randomUUID(),
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      });
      send({}, "tool_calls");
      res.write(
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    };
    const texts = body.messages.map((m) =>
      typeof m.content === "string"
        ? m.content
        : (m.content ?? []).map((p) => p.text ?? "").join("\n"),
    );
    const context = texts.filter((t) => t.includes("Current authoritative goal: ")).at(-1);
    if (context) {
      const goalText = context.split("Current authoritative goal: ").at(-1);
      let view;
      try {
        view = JSON.parse(goalText);
      } catch (error) {
        throw new Error("Invalid fixture goal context; see model-requests.json", { cause: error });
      }
      if (view.goal.limitsPending) {
        tool("goal_set_limits", { expectedRevision: view.revision, sources: {} });
        return;
      }
      const asked = body.messages.some((m) =>
        m.tool_calls?.some((c) => c.function.name === "ask_user_question"),
      );
      if (!asked) {
        tool("ask_user_question", {
          mode: "async",
          questions: [
            {
              id: "continue",
              title: "Continue the isolated fixture?",
              options: ["Continue", "Wait"],
            },
          ],
        });
        return;
      }
      tool("task_wait", {});
      return;
    }
    send({ content: "Lifecycle fixture is running." });
    held.add(res);
    res.on("close", () => held.delete(res));
  } catch (error) {
    errors.push("model fixture: " + error.stack);
    res.destroy(error);
  }
});
await new Promise((r) => model.listen(0, "127.0.0.1", r));
const config = join(scratch, "config.toml"),
  secondConfig = join(scratch, "second-config.toml");
const toml = `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`;
await writeFile(config, toml);
await writeFile(secondConfig, toml);
const env = {
  ...process.env,
  AREAL_CORE_BIN: binary,
  AREAL_CORE_CONFIG: config,
  AREAL_CORE_HOME: home,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_CORE_USER_HOME: join(scratch, "user"),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
};
for (const key of [
  "AREAL_CORE_WORKSPACE",
  "AREAL_HARNESS_HOME",
  "AREAL_HARNESS_CONFIG",
  "AREAL_CORE_DESKTOP_CONFIG",
])
  delete env[key];
const crashUpdate = process.env.AREAL_LIFECYCLE_CRASH_UPDATE === "1";
let crashDialogs = [];
const testApp = join(scratch, "app");
await mkdir(testApp);
await writeFile(
  join(testApp, "package.json"),
  JSON.stringify({ name: "areal-lifecycle-fixture", main: "bootstrap.cjs" }),
);
await writeFile(
  join(testApp, "bootstrap.cjs"),
  `
if (process.env.AREAL_LIFECYCLE_AUTO_RECOVERY === '1') {
  const {dialog} = require('electron');
  globalThis.__lifecycleDialogs = [];
  dialog.showMessageBox = async (...args) => {
    const options = args.at(-1); globalThis.__lifecycleDialogs.push(options);
    if (options.message === '确认取消后台任务？') return {response:1};
    return {response:options.buttons.indexOf('取消任务并重启')};
  };
}
if (process.env.AREAL_LIFECYCLE_CRASH_UPDATE === '1' && !process.argv.includes('--areal-core-service')) {
  const {ServiceConnection}=require(${JSON.stringify(join(gui, "app/src/core/service-client.cjs"))});
  const original=ServiceConnection.prototype.request;
  ServiceConnection.prototype.request=async function(method,params,mutation){
    const receipt=await original.call(this,method,params,mutation);
    if(method==='lifecycleRequest' && params.kind==='updateDesktop'){
      require('node:fs').writeFileSync(${JSON.stringify(join(scratch, "update-accepted-before-gui-crash.json"))},JSON.stringify({requestId:params.requestId,desktopGeneration:params.expectedDesktopGeneration,receipt,dialogs:globalThis.__updateRecoveryDialogs}));
      process.kill(process.pid,'SIGKILL');
      await new Promise(()=>{});
    }
    return receipt;
  };
}
require(${JSON.stringify(join(gui, "app/src/main.cjs"))});
`,
);
let app,
  page,
  pid,
  tid,
  passed = false;
const until = async (fn, label, timeout = 60000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Timeout: " + label);
};
const state = () => page.evaluate(() => window.arealDesktop.snapshot());
const call = async (name, params) => {
  const result = await page.evaluate(
    ({ name, params }) => window.arealDesktop.command(name, params),
    { name, params },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};
const queue = (s) => s.projects.find((p) => p.id === pid)?.state.queues[tid];
async function launch({ recovery = false } = {}) {
  app = await electron.launch({
    executablePath: require("electron"),
    args: [testApp],
    env: { ...env, AREAL_LIFECYCLE_AUTO_RECOVERY: recovery ? "1" : "0" },
    timeout: 120000,
  });
  await writeFile(
    join(scratch, "run.json"),
    JSON.stringify({ guiPid: app.process().pid, testApp, home }),
  );
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
}
async function closeGui() {
  if (app) {
    await app.close();
    app = null;
  }
}
console.log("Lifecycle evidence:", scratch);
try {
  await launch();
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, workspace);
  await page.evaluate(() => window.arealDesktop.chooseProject());
  pid = (
    await until(
      async () => (await state()).projects.find((p) => p.root === workspace && p.state?.connected),
      "connected project",
    )
  ).id;
  await page.getByTestId("chat-input").fill("hold lifecycle");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  tid = await until(
    () => page.getByTestId("areal-workbench").getAttribute("data-thread-id"),
    "created Thread identity",
  );
  await until(
    async () =>
      requests.length &&
      (await state()).projects[0].state.threads[tid]?.turns.at(-1)?.status === "inProgress",
    "held turn",
  );
  for (const text of ["preserved first", "preserved second"]) {
    await page.getByTestId("chat-input").fill(text);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await until(
      async () => queue(await state())?.items.some((i) => i.input.some((p) => p.text === text)),
      "queued input",
    );
  }
  const original = structuredClone(queue(await state()).items);
  const preservedDraft = "unsent lifecycle draft";
  await page.getByTestId("chat-input").fill(preservedDraft);
  const originalThread = structuredClone(
    (await state()).projects.find((p) => p.id === pid).state.threads[tid],
  );
  const metadata = JSON.parse(await readFile(join(home, "service.json"), "utf8"));
  for (const request of [
    { name: "stop", params: { projectId: pid, threadId: tid } },
    { name: "serviceLifecycle", params: { operation: "stop", expectedTargets: [] } },
  ]) {
    const rejected = await page.evaluate(
      ({ name, params }) => window.arealDesktop.command(name, params),
      request,
    );
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, "INVALID_DESKTOP_REQUEST");
  }
  await call("serviceLifecycle", { operation: "check" });
  assert.equal(
    (await state()).projects.find((p) => p.id === pid).state.threads[tid].turns.at(-1).status,
    "inProgress",
  );
  assert.deepEqual(JSON.parse(await readFile(join(home, "service.json"), "utf8")), metadata);
  checks.push(
    "Main rejects missing pause identity and untrusted lifecycle fields; check is read-only",
  );
  await page.screenshot({ path: join(scratch, "01-live-queue.png") });
  const cancelFromMenu = async (confirm) =>
    app.evaluate(async ({ Menu, dialog }, confirm) => {
      const seen = [];
      dialog.showMessageBox = async (...args) => {
        const options = args.at(-1);
        seen.push(options);
        return { response: options.message === "确认取消后台任务？" && confirm ? 1 : 0 };
      };
      Menu.getApplicationMenu()
        .items[0].submenu.items.find((i) => i.label === "停止后台 Core 服务…")
        .click();
      const deadline = Date.now() + 10000;
      while (!seen.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 200));
      return seen;
    }, confirm);
  const declined = await cancelFromMenu(false);
  dialogs.push(...declined);
  assert.equal(declined.length, 1);
  assert.equal(declined[0].message, "确认取消后台任务？");
  assert.equal(await page.getByTestId("chat-input").innerText(), preservedDraft);
  assert.deepEqual(queue(await state()).items, original);
  assert.equal((await state()).projects[0].state.threads[tid].turns.at(-1).status, "inProgress");
  checks.push(
    "native menu recovery declined confirmation preserves the running turn and both queued inputs",
  );
  const confirmed = await cancelFromMenu(true);
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].message, "确认取消后台任务？");
  dialogs.push(...confirmed);
  await waitForServiceProcessExit(home, metadata);
  assert.equal(requests.length, 1, "cancel never dispatches pending input");
  checks.push("native menu confirmed cancel exits the original Desktop and Core safely");
  await page.getByRole("button", { name: "重新连接后台", exact: true }).click();
  await until(
    async () => (await state()).projects.find((p) => p.id === pid)?.state?.connected,
    "explicit reconnect",
  );
  await call("open", { projectId: pid, threadId: tid });
  await until(async () => queue(await state())?.items.length === 2, "restored queue");
  assert.equal(queue(await state()).paused, true);
  assert.deepEqual(queue(await state()).items, original);
  assert.equal(requests.length, 1);
  assert.equal(await page.getByTestId("chat-input").innerText(), preservedDraft);
  assert.deepEqual(
    (await state()).projects.find((p) => p.id === pid).state.threads[tid].turns.map((t) => t.id),
    originalThread.turns.map((t) => t.id),
  );
  await page.screenshot({ path: join(scratch, "02-reopened-paused.png") });
  checks.push(
    "explicit reconnect preserves Queue identities, bodies and order, remains paused and sends no model request",
  );

  const scheduled = await call("manage", {
    projectId: pid,
    operation: "taskCreate",
    mode: "scheduled",
    objective: "Wait for an explicit lifecycle answer.",
    interactionMode: "asynchronous",
    schedule: { at: Math.floor(Date.now() / 1000) + 2, timeZone: "UTC" },
  });
  const task = () => call("manage", { projectId: pid, operation: "task", taskId: scheduled.id });
  await until(
    async () => (await task()).runs.at(-1)?.status === "waitingForInput",
    "scheduled Run waiting without an active turn",
  );
  const server = await call("manage", { projectId: pid, operation: "server" });
  assert.equal(server.activeTurns.length, 0);
  assert.ok(server.activeGoals.length > 0);
  assert.ok(server.activeTasks > 0);
  const old = JSON.parse(await readFile(join(home, "service.json"), "utf8"));
  const modelRequestsBeforeReopen = requests.length;
  await closeGui();
  env.AREAL_CORE_CONFIG = secondConfig;
  await launch({ recovery: true });
  await until(
    async () => (await state()).connection?.state === "ready",
    "reattach with original launch configuration",
  );
  const startupDialogs = await app.evaluate(() => globalThis.__lifecycleDialogs ?? []);
  dialogs.push(...startupDialogs);
  assert.deepEqual(startupDialogs, []);
  const reattached = JSON.parse(await readFile(join(home, "service.json"), "utf8"));
  assert.deepEqual(
    reattached,
    old,
    "changing the requested config must not replace the running service",
  );
  await until(
    async () => (await state()).backendUpdate?.state === "pending",
    "nonblocking pending update",
  );
  await page.getByRole("button", { name: "更新后台…", exact: true }).waitFor();
  await call("open", { projectId: pid, threadId: tid });
  await until(async () => queue(await state())?.items.length === 2, "queue after startup recovery");
  assert.deepEqual(queue(await state()).items, original);
  assert.equal(queue(await state()).paused, true);
  assert.equal(await page.getByTestId("chat-input").innerText(), preservedDraft);
  const restored = await task();
  assert.equal(restored.id, scheduled.id);
  assert.equal(restored.paused, false);
  assert.equal(restored.runs.at(-1).status, "waitingForInput");
  assert.equal(
    requests.length,
    modelRequestsBeforeReopen,
    "reopening must not run the scheduled task again",
  );
  await page.screenshot({ path: join(scratch, "03-startup-recovered.png") });
  checks.push(
    "reopen with a different config path retains the original service, waiting Run and Queue without dialogs or replay, and shows the original-config notice",
  );
  const updateMetadata = JSON.parse(await readFile(join(home, "service.json"), "utf8"));
  await app.evaluate(({ dialog }) => {
    globalThis.__updateRecoveryDialogs = [];
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      globalThis.__updateRecoveryDialogs.push(options);
      return { response: options.message === "确认取消后台任务？" ? 1 : 0 };
    };
  });
  const updatingGui = app.process();
  await page
    .getByRole("button", { name: "更新后台…", exact: true })
    .click()
    .catch((error) => {
      if (!crashUpdate || !/closed|disconnected/i.test(error.message)) throw error;
    });
  if (crashUpdate) {
    await until(
      () => updatingGui.exitCode !== null || updatingGui.signalCode !== null,
      "only GUI crashes after accepted update",
    );
    app = null;
    const crashed = JSON.parse(
      await readFile(join(scratch, "update-accepted-before-gui-crash.json"), "utf8"),
    );
    assert.equal(crashed.receipt.desktopExit, "requested");
    const control = JSON.parse(
      await readFile(join(env.AREAL_GUI_USER_DATA, "service-control.json"), "utf8"),
    );
    assert.equal(control.references.at(-1).requestId, crashed.requestId);
    crashDialogs = crashed.dialogs;
    await waitForServiceProcessExit(home, updateMetadata);
    await launch({ recovery: true });
    await page.getByRole("button", { name: "更新后台…", exact: true }).waitFor();
    assert.equal(
      (await state()).lifecycle.requestId,
      crashed.requestId,
      "reopen reads the original request",
    );
    assert.equal(
      (await state()).lifecycle.phase,
      "completed",
      "replacement requires confirmed original exit",
    );
    assert.equal(requests.length, modelRequestsBeforeReopen);
    const operationsBefore = (await import("node:fs/promises")).readdir;
    const journalNames = await operationsBefore(join(home, "lifecycle-operations"));
    await page.getByRole("button", { name: "更新后台…", exact: true }).click();
    await until(
      async () => (await state()).connection?.state === "ready" && !(await state()).backendUpdate,
      "finish original update after GUI crash",
    );
    assert.deepEqual(
      await operationsBefore(join(home, "lifecycle-operations")),
      journalNames,
      "finishing the original update never submits another stop",
    );
    checks.push(
      "forced GUI exit after accepted update retains the original request/generation and finishes replacement without a repeated stop or confirmation",
    );
  }
  await waitForServiceProcessExit(home, updateMetadata);
  await until(
    async () => (await state()).connection?.state === "ready" && !(await state()).backendUpdate,
    "updated replacement connected",
  );
  const replacement = JSON.parse(await readFile(join(home, "service.json"), "utf8"));
  assert.notEqual(replacement.pid, updateMetadata.pid);
  await call("open", { projectId: pid, threadId: tid });
  await until(async () => queue(await state())?.items.length === 2, "queue retained after update");
  assert.deepEqual(queue(await state()).items, original);
  assert.equal(queue(await state()).paused, true);
  assert.equal(await page.getByTestId("chat-input").innerText(), preservedDraft);
  const updatedTask = await task();
  assert.equal(updatedTask.id, restored.id);
  assert.equal(updatedTask.paused, restored.paused);
  assert.deepEqual(
    updatedTask.runs.map((run) => run.id),
    restored.runs.map((run) => run.id),
  );
  assert.equal(updatedTask.runs.at(-1).status, "paused");
  assert.equal(
    requests.length,
    modelRequestsBeforeReopen,
    "update must not replay queued input or waiting scheduled Run",
  );
  await page.screenshot({ path: join(scratch, "04-updated-preserved.png") });
  const updateDialogs = crashUpdate
    ? crashDialogs
    : await app.evaluate(() => globalThis.__updateRecoveryDialogs);
  dialogs.push(...updateDialogs);
  assert.equal(updateDialogs.length, 1);
  assert.equal(updateDialogs[0].message, "确认取消后台任务？");
  checks.push(
    "explicit GUI update confirms once, exits the original backend, connects the replacement, and preserves task/run/queue/history identities and unsent draft without replay; no package download/install",
  );
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  errors.push(error.stack);
  await writeFile(
    join(scratch, "failure-state.json"),
    JSON.stringify(await state().catch(() => null), null, 2),
  );
  if (page) await page.screenshot({ path: join(scratch, "failure.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  const guiPid = app?.process().pid;
  let originalHost;
  try {
    originalHost = await readFixtureHost(env);
  } catch (error) {
    errors.push("Host identity: " + error.message);
    passed = false;
  }
  await closeGui().catch((error) => {
    errors.push(error.message);
    passed = false;
  });
  try {
    await settleFixtureHostAfterQuit(binary, env, scratch, { pid: guiPid, host: originalHost });
  } catch (error) {
    errors.push("cleanup: " + error.message);
    passed = false;
  }
  for (const response of held) response.destroy();
  model.closeAllConnections();
  await new Promise((r) => model.close(r));
  await writeFile(join(scratch, "model-requests.json"), JSON.stringify(requests, null, 2));
  if (!passed) process.exitCode = 1;
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed,
        checks,
        errors,
        dialogs,
        crashUpdate,
        source: execFileSync("git", ["rev-parse", "HEAD"]).toString().trim(),
        binary,
        binarySha256: createHash("sha256")
          .update(await readFile(binary))
          .digest("hex"),
        boundary:
          "real Electron menu/startup + Desktop/Core/Runtime; local model; native dialogs injected; no update download/install",
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed, evidence: scratch, checks, errors }));
}
