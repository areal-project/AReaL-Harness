import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { assertApplicationStopped } from "./application-cleanup.mjs";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { manageTask, taskOperations } = require("../app/src/core/tasks.cjs");
async function boundaryContract() {
  for (const operation of ["taskHistoryCapabilities", "taskRuns", "taskRun"])
    assert.ok(taskOperations.has(operation), `${operation} is a narrow desktop capability`);
  const calls = [],
    client = {
      capabilities: { methods: ["areal/task/runs/list", "areal/task/run/read"] },
      request: async (method, params) => {
        calls.push({ method, params });
        return { method, params };
      },
    };
  const project = { client },
    backend = { requireConnection: (_project, value) => assert.equal(value, client) };
  assert.deepEqual(await manageTask(backend, project, { operation: "taskHistoryCapabilities" }), {
    enabled: true,
    runNow: false,
  });
  await manageTask(backend, project, {
    operation: "taskRuns",
    taskId: "task",
    cursor: "opaque-page",
    limit: 100,
    arbitraryMethod: "bad",
  });
  assert.deepEqual(calls.at(-1), {
    method: "areal/task/runs/list",
    params: { taskId: "task", cursor: "opaque-page", limit: 100 },
  });
  await manageTask(backend, project, { operation: "taskRun", taskId: "task", runId: "old-run" });
  assert.deepEqual(calls.at(-1), {
    method: "areal/task/run/read",
    params: { taskId: "task", runId: "old-run" },
  });
  for (const request of [
    { operation: "taskRuns", taskId: "task", limit: 0 },
    { operation: "taskRuns", taskId: "task", limit: 101 },
    { operation: "taskRuns", taskId: "task", cursor: 7 },
    { operation: "taskRun", taskId: "task" },
  ])
    await assert.rejects(() => manageTask(backend, project, request));
  client.capabilities.methods = [];
  assert.deepEqual(await manageTask(backend, project, { operation: "taskHistoryCapabilities" }), {
    enabled: false,
    runNow: false,
  });
  await assert.rejects(() =>
    manageTask(backend, project, { operation: "taskRuns", taskId: "task" }),
  );
  console.log("PASS narrow task history adapter contract; Core/Electron not exercised");
}
await boundaryContract();
if (process.argv.includes("--boundary-only")) process.exit(0);
const { _electron: electron } = require("playwright-core");
const binary = process.env.AREAL_CORE_BIN || resolve(gui, "../../target/debug/areal");
const binarySha256 = createHash("sha256")
  .update(await readFile(binary))
  .digest("hex");
const evidenceRoot = process.env.AREAL_TASK_HISTORY_EVIDENCE || (await realpath(tmpdir()));
await mkdir(evidenceRoot, { recursive: true });
const scratch = await mkdtemp(join(evidenceRoot, "task-history-"));
const workspace = join(scratch, "workspace"),
  userHome = join(scratch, "user");
await mkdir(workspace);
await mkdir(join(userHome, ".areal"), { recursive: true });
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
const env = {
  ...process.env,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: userHome,
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_CORE_BIN: binary,
};
for (const key of [
  "AREAL_CORE_WORKSPACE",
  "AREAL_CORE_CONFIG",
  "AREAL_HARNESS_HOME",
  "AREAL_HARNESS_CONFIG",
  "AREAL_CORE_DESKTOP_CONFIG",
])
  delete env[key];
const fixtureApp = join(scratch, "app");
await mkdir(fixtureApp);
await writeFile(
  join(fixtureApp, "package.json"),
  JSON.stringify({ name: "task-history-fixture", main: "bootstrap.cjs" }),
);
await writeFile(
  join(fixtureApp, "bootstrap.cjs"),
  `
const service=require(${JSON.stringify(join(gui, "app/src/core/service-client.cjs"))});
const Backend=service.SharedCoreBackend;
service.SharedCoreBackend=class extends Backend {
 constructor(options) { super(options); global.taskHistoryNotificationOpen=options.onNotificationOpen; global.taskHistoryBackend=this; global.taskHistoryReads=[]; }
 async command(name,request) {
  if(name==='manage'&&request.operation==='taskRun') {
   if(global.taskHistoryRunGate) { global.taskHistoryRunWaiting=request.runId; await global.taskHistoryRunGate; global.taskHistoryRunWaiting=null; }
   if(global.taskHistoryRunFailures>0) { global.taskHistoryRunFailures--; throw Error('TASK_HISTORY_COLD_READ_FAILURE'); }
  }
  const forwarded=name==='manage'&&request.operation==='taskRuns'&&global.taskHistoryHeadLimit&&!request.cursor?{...request,limit:global.taskHistoryHeadLimit}:request;
  if(name==='manage'&&request.operation==='taskRuns'&&!request.cursor&&global.taskHistoryHeadGate) await global.taskHistoryHeadGate;
  if(name==='manage'&&request.operation==='taskRuns'&&request.cursor&&global.taskHistoryTailGate) { global.taskHistoryTailWaiting=request.cursor; await global.taskHistoryTailGate; global.taskHistoryTailWaiting=null; }
  const result=await super.command(name,forwarded);
  if(name==='manage'&&['taskRuns','taskRun'].includes(request.operation)) global.taskHistoryReads.push({operation:request.operation,runId:request.runId,cursor:request.cursor,dataLength:result.data?.length,runCount:result.runCount});
  return result;
 }
};
require(${JSON.stringify(join(gui, "app/src/main.cjs"))});
`,
);
const checks = [],
  errors = [],
  held = new Set(),
  modelRequests = [];
const model = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    modelRequests.push(body);
    if (body.stream === false) {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Task history fixture" } }],
        }),
      );
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (delta, finish_reason = null) =>
      response.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    const end = () => {
      response.write(
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    };
    const finish = (content) => {
      send({ content });
      send({}, "stop");
      end();
    };
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
      end();
    };
    const texts = (body.messages ?? []).map((message) =>
      typeof message.content === "string"
        ? message.content
        : (message.content ?? []).map((part) => part.text ?? "").join("\n"),
    );
    if (texts.some((text) => text.includes("AREAL_TASK_DRAFT"))) {
      finish(
        JSON.stringify({ kind: "control", message: "将取消任务并保留历史。", action: "cancel" }),
      );
      return;
    }
    const context = texts.findLast((text) => text.includes("Current authoritative goal: "));
    if (!context) {
      finish("Task history fixture");
      return;
    }
    const goalView = JSON.parse(context.split("Current authoritative goal: ").at(-1));
    if (goalView.goal.limitsPending) {
      tool("goal_set_limits", { expectedRevision: goalView.revision, sources: {} });
      return;
    }
    if (goalView.goal.objective === "TASK_HISTORY_ARCHIVE_FIXTURE") {
      if (goalView.goal.report?.status === "complete") {
        finish("TASK_HISTORY_REAL_RUN_COMPLETED");
        return;
      }
      tool("goal_update", {
        expectedRevision: goalView.revision,
        status: "complete",
        summary: "TASK_HISTORY_REAL_RUN_COMPLETED",
        evidence: ["Deterministic task history fixture completed its response."],
        remaining: [],
      });
      return;
    }
    assert.equal(goalView.goal.objective, "TASK_HISTORY_CAPACITY_REAL_GOAL");
    send({ content: "CAPACITY_REAL_GOAL_HELD" });
    held.add(response);
    response.on("close", () => held.delete(response));
  } catch (error) {
    errors.push(error.message);
    response.destroy(error);
  }
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
await writeFile(
  join(userHome, ".areal/config.toml"),
  `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n[permissions]\nmode="YOLO"\n`,
);
let app,
  page,
  pid,
  taskId,
  coldThreadId,
  electronProcess,
  passed = false;
async function until(fn, label, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error(`Timeout: ${label}`);
}
const snapshot = () => page.evaluate(() => window.arealDesktop.snapshot());
async function call(name, params) {
  const reply = await page.evaluate(
    ({ name, params }) => window.arealDesktop.command(name, params),
    { name, params },
  );
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.value;
}
async function launch() {
  app = await electron.launch({
    executablePath: process.env.AREAL_ELECTRON_EXECUTABLE || require("electron"),
    args: [fixtureApp],
    env,
    timeout: 120000,
  });
  electronProcess = app.process();
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await until(async () => (await snapshot()).connection?.state === "ready", "adapter ready");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
}
async function stopOwnedService() {
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 });
  });
  const metadata = await app.evaluate(() => global.taskHistoryBackend.metadata);
  let timer;
  try {
    await Promise.race([
      app.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("owned Electron close timed out")), 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  app = null;
  page = null;
  await waitForElectronExit();
  await assertApplicationStopped(binary, env, metadata);
}
async function waitForElectronExit() {
  if (!electronProcess || electronProcess.exitCode !== null || electronProcess.signalCode !== null)
    return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("owned Electron did not exit")), 15000);
    electronProcess.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
async function taskFiles(root) {
  const found = [];
  for (const item of await readdir(root, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue;
    const path = join(root, item.name);
    if (item.isDirectory()) found.push(...(await taskFiles(path)));
    else if (item.name === "task-mode.json") found.push(path);
  }
  return found;
}
const readTask = () => call("manage", { projectId: pid, operation: "task", taskId });
try {
  await launch();
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, workspace);
  await page.evaluate(() => window.arealDesktop.chooseProject());
  pid = (
    await until(
      async () =>
        (await snapshot()).projects.find(
          (project) => project.root === workspace && project.state?.connected,
        ),
      "fixture project ready",
    )
  ).id;
  const created = await call("manage", {
    projectId: pid,
    operation: "taskCreate",
    mode: "scheduled",
    objective: "TASK_HISTORY_ARCHIVE_FIXTURE",
    schedule: { at: Math.floor(Date.now() / 1000) + 86400, timeZone: "Asia/Shanghai" },
  });
  taskId = created.id;
  const execution = await call("create", { projectId: pid });
  coldThreadId = execution.threadId;
  assert.equal(typeof coldThreadId, "string");
  await stopOwnedService();
  const candidates = await taskFiles(join(scratch, "core"));
  assert.equal(
    candidates.length,
    1,
    "fixture locates its sole owned task catalog without assuming version or task key encoding",
  );
  const path = candidates[0];
  const fixture = structuredClone(created),
    start = Math.floor(Date.now() / 1000) - 20000;
  delete fixture.runCount;
  delete fixture.archivedRunCount;
  delete fixture.runsComplete;
  const usage = {
    inputTokens: 4,
    cachedInputTokens: 0,
    outputTokens: 3,
    tokensUsed: 7,
    reservedTokens: 0,
    unknownRequests: 0,
    turnsStarted: 1,
    timeUsedSeconds: 1,
    accountingComplete: true,
  };
  fixture.runs = Array.from({ length: 160 }, (_, index) => ({
    id: `history-run-${String(index).padStart(3, "0")}`,
    threadId: index === 0 ? coldThreadId : null,
    goalId: null,
    status: "completed",
    reason: null,
    objective: `Original objective ${index}`,
    scheduledAt: start + index * 60,
    startedAt: start + index * 60,
    completedAt: start + index * 60 + 1,
    usage,
    waitRequested: false,
    workers:
      index === 0
        ? [
            {
              threadId: coldThreadId,
              turnId: "cold-worker-turn",
              status: "completed",
              settled: true,
            },
          ]
        : [],
  }));
  fixture.runs[159].acceptedSchedule = {
    taskRevision: fixture.revision,
    scheduleV2: {
      version: 1,
      rule: {
        kind: "calendar",
        timeZone: "America/New_York",
        frequency: "daily",
        interval: 1,
        localTime: "09:00",
        anchorDate: "2026-10-01",
      },
      misfire: { kind: "coalesce" },
      overlap: "skip",
    },
  };
  fixture.messages = [
    {
      id: "cold-report",
      sequence: 1,
      runId: "history-run-000",
      author: "system",
      kind: "report",
      status: "published",
      createdAt: start + 1,
      expiresAt: null,
      questions: [],
      required: false,
      inReplyTo: null,
      answers: null,
      text: "COLD_RUN_REPORT_SENTINEL",
    },
    {
      id: "cold-worker-report",
      sequence: 2,
      runId: "history-run-000",
      author: coldThreadId,
      kind: "workerReport",
      status: "published",
      createdAt: start + 2,
      expiresAt: null,
      questions: [],
      required: false,
      inReplyTo: null,
      answers: null,
      text: "COLD_WORKER_REPORT_SENTINEL",
    },
  ];
  fixture.channelSequence = 2;
  fixture.paused = true;
  fixture.revision++;
  const store = { version: 3, tasks: { [taskId]: fixture }, receipts: [], preparations: {} };
  await writeFile(path, JSON.stringify(store));
  checks.push(
    "setup only: isolated stopped legacy v3 snapshot contains 160 terminal runs and exact cold Thread/worker/report identities",
  );
  await launch();
  const capabilities = await call("manage", {
    projectId: pid,
    operation: "taskHistoryCapabilities",
  });
  assert.equal(capabilities.enabled, true, "integrated Core advertises run history methods");
  const migrated = await readTask();
  assert.equal(migrated.runCount, 160);
  assert.ok(migrated.runs.length <= 128);
  assert.equal(migrated.runsComplete, false);
  assert.equal(migrated.archivedRunCount, 160 - migrated.runs.length);
  const oldest = await call("manage", {
    projectId: pid,
    operation: "taskRun",
    taskId,
    runId: "history-run-000",
  });
  assert.equal(oldest.threadId, coldThreadId);
  assert.equal(oldest.workers[0].turnId, "cold-worker-turn");
  const first = await call("manage", { projectId: pid, operation: "taskRuns", taskId, limit: 100 });
  assert.equal(first.data.length, 100);
  assert.equal(first.hasMore, true);
  assert.equal(typeof first.nextCursor, "string");
  const second = await call("manage", {
    projectId: pid,
    operation: "taskRuns",
    taskId,
    cursor: first.nextCursor,
    limit: 100,
  });
  assert.equal(new Set([...first.data, ...second.data].map((run) => run.id)).size, 160);
  assert.equal(second.hasMore, false);
  checks.push(
    "real Core migrates legacy history, bounds the hot window, resolves exact cold run and pages all 160 IDs without duplicates",
  );
  await app.evaluate(() => {
    global.taskHistoryRunFailures = 1;
  });
  await app.evaluate((_electron, target) => global.taskHistoryNotificationOpen(target), {
    projectId: pid,
    taskId,
    runId: "history-run-000",
  });
  await page.getByRole("alert").filter({ hasText: "TASK_HISTORY_COLD_READ_FAILURE" }).waitFor();
  await page.getByRole("button", { name: "重试读取通知运行", exact: true }).click();
  const revealed = page.locator('.task-resource-history [data-run-id="history-run-000"]');
  await revealed.waitFor();
  await until(
    async () => revealed.evaluate((node) => node.contains(document.activeElement)),
    "cold notification focuses its exact resolved run",
  );
  await page.getByRole("button", { name: "任务资源", exact: true }).click();
  await page.getByLabel("任务资源面板", { exact: true }).waitFor({ state: "detached" });
  assert.equal(
    await page.getByLabel("任务资源面板", { exact: true }).count(),
    0,
    "user can close notification reveal without reopening",
  );
  await call("open", { projectId: pid, threadId: coldThreadId });
  await page.getByRole("button", { name: "定时任务", exact: true }).click();
  await page
    .getByRole("button", { name: "打开自动化 TASK_HISTORY_ARCHIVE_FIXTURE", exact: true })
    .click();
  assert.equal(
    await page.getByLabel("任务资源面板", { exact: true }).count(),
    0,
    "ordinary task navigation preserves explicitly closed notification panel",
  );
  const acceptedRun = fixture.runs[159];
  const acceptedLabel = await page.evaluate(
    (seconds) =>
      new Date(seconds * 1000).toLocaleString(undefined, { timeZone: "America/New_York" }),
    acceptedRun.scheduledAt,
  );
  const embeddedRun = page.locator('[data-task-run-id="history-run-159"]');
  await embeddedRun.waitFor();
  assert(
    (await embeddedRun.innerText()).includes(acceptedLabel),
    "embedded history uses the accepted calendar timezone after task revision changes",
  );
  const acceptedRow = await call("manage", {
    projectId: pid,
    operation: "taskRun",
    taskId,
    runId: acceptedRun.id,
  });
  assert.equal(acceptedRow.acceptedSchedule.scheduleV2.rule.timeZone, "America/New_York");
  assert((await readTask()).revision > acceptedRow.acceptedSchedule.taskRevision);
  await writeFile(
    join(scratch, "accepted-timezone.json"),
    JSON.stringify(
      {
        acceptedRow,
        display: await embeddedRun.innerText(),
        expected: acceptedLabel,
        currentSchedule: (await readTask()).schedule,
      },
      null,
      2,
    ),
  );
  checks.push(
    "embedded real GUI and durable run history preserve accepted calendar timezone after the task revision changes",
  );

  const coreBeforeReconnect = (await snapshot()).projects.find(
    (project) => project.id === pid,
  ).core;
  const readsBeforeReconnect = await app.evaluate(() => global.taskHistoryReads.length);
  await app.evaluate(() => {
    global.taskHistoryOldConnection = global.taskHistoryBackend.connection;
    global.taskHistoryOldConnection.socket.terminate();
  });
  await until(
    async () =>
      (await snapshot()).connection?.state === "ready" &&
      (await app.evaluate(
        () =>
          global.taskHistoryBackend.connection !== global.taskHistoryOldConnection &&
          global.taskHistoryBackend.connection?.socket.readyState === 1 &&
          global.taskHistoryBackend.status.connected,
      )),
    "shared observation transport reconnects",
  );
  const coreAfterReconnect = (await snapshot()).projects.find((project) => project.id === pid).core;
  assert.equal(coreAfterReconnect.instanceId, coreBeforeReconnect.instanceId);
  assert.equal(coreAfterReconnect.connectionGeneration, coreBeforeReconnect.connectionGeneration);
  await writeFile(
    join(scratch, "reconnect.json"),
    JSON.stringify(
      {
        coreBeforeReconnect,
        coreAfterReconnect,
        readsBeforeReconnect,
        readsAfterReconnect: await app.evaluate(() => global.taskHistoryReads.length),
        transportReplaced: true,
      },
      null,
      2,
    ),
  );
  assert.equal(
    await page.getByLabel("任务资源面板", { exact: true }).count(),
    0,
    "reconnect preserves explicitly closed notification panel",
  );
  checks.push(
    "shared observation transport actually reconnects to the same Core instance and generation while the explicitly closed notification panel remains closed",
  );
  await app.evaluate((_electron, target) => global.taskHistoryNotificationOpen(target), {
    projectId: pid,
    taskId,
    runId: "history-run-000",
  });
  await revealed.waitFor();
  await page.getByRole("button", { name: "任务资源", exact: true }).click();
  await page.getByLabel("任务资源面板", { exact: true }).waitFor({ state: "detached" });
  await app.evaluate(() => {
    global.taskHistoryRunGate = new Promise((resolve) => {
      global.taskHistoryReleaseRun = () => {
        global.taskHistoryRunGate = null;
        resolve();
      };
    });
  });
  await app.evaluate((_electron, target) => global.taskHistoryNotificationOpen(target), {
    projectId: pid,
    taskId,
    runId: "history-run-001",
  });
  await page.getByText("正在读取通知运行…", { exact: true }).waitFor();
  await until(
    () => app.evaluate(() => global.taskHistoryRunWaiting === "history-run-001"),
    "the exact run read reaches its Main barrier",
  );
  await page.getByRole("button", { name: "任务资源", exact: true }).click();
  await page.getByLabel("任务资源面板", { exact: true }).waitFor({ state: "detached" });
  const readsBeforeRelease = await app.evaluate(() => global.taskHistoryReads.length);
  await app.evaluate(() => global.taskHistoryReleaseRun());
  await until(
    () =>
      app.evaluate(
        (_electron, before) =>
          global.taskHistoryReads
            .slice(before)
            .some((read) => read.operation === "taskRun" && read.runId === "history-run-001"),
        readsBeforeRelease,
      ),
    "pending exact run read completes after panel close",
  );
  assert.equal(
    (await call("manage", { projectId: pid, operation: "taskHistoryCapabilities" })).enabled,
    true,
    "same Renderer read completes after the exact run result",
  );
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.equal(
    await page.getByRole("button", { name: "任务资源", exact: true }).getAttribute("aria-expanded"),
    "false",
    "exact run completion preserves the closed resource button",
  );
  assert.equal(
    await page.getByLabel("任务资源面板", { exact: true }).count(),
    0,
    "exact run completion preserves panel close during pending reveal",
  );
  checks.push(
    "injected exact cold-read failure stays visible with retry; real Core retry focuses the exact run; manual close survives navigation, reconnect and delayed read; a new explicit event for the same run opens anew; native OS notification delivery is not exercised",
  );
  await stopOwnedService();
  await launch();
  await page.getByRole("button", { name: "定时任务", exact: true }).click();
  await page
    .getByRole("button", { name: "打开自动化 TASK_HISTORY_ARCHIVE_FIXTURE", exact: true })
    .click();
  await page.getByRole("button", { name: "任务资源", exact: true }).click();
  const history = page.locator(".task-resource-history");
  await history.waitFor();
  await history.getByText(/运行记录 · 共\s*160\s*次/).waitFor();
  assert.equal(
    await history.locator('[data-run-id="history-run-000"]').count(),
    0,
    "cold run is outside the hot window before paging",
  );
  await history.getByRole("button", { name: "加载更早运行", exact: true }).click();
  const cold = history.locator('[data-run-id="history-run-000"]');
  await cold.waitFor();
  await cold.getByText("Original objective 0", { exact: false }).waitFor();
  await cold.getByText("COLD_RUN_REPORT_SENTINEL", { exact: true }).first().waitFor();
  const coldWorker = cold.getByLabel(`worker ${coldThreadId}`, { exact: true });
  assert.equal(await coldWorker.getAttribute("data-worker-turn"), "cold-worker-turn");
  await coldWorker.getByText("COLD_WORKER_REPORT_SENTINEL", { exact: true }).waitFor();
  assert.equal(await cold.getByRole("button", { name: "继续本次运行", exact: true }).count(), 0);
  assert.equal(await cold.getByRole("button", { name: "停止本次运行", exact: true }).count(), 0);
  const runIds = await history
    .locator("[data-run-id]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-run-id")));
  assert.equal(runIds.length, 160);
  assert.equal(new Set(runIds).size, 160);
  assert.equal(
    await history.getByRole("button", { name: "加载更早运行", exact: true }).count(),
    0,
    "all 160 runs exhaust the historical tail",
  );
  const current = await readTask();
  const updated = await call("manage", {
    projectId: pid,
    operation: "taskUpdate",
    taskId,
    expectedRevision: current.revision,
    schedule: { at: Math.floor(Date.now() / 1000) + 2, timeZone: "Asia/Shanghai" },
  });
  await call("manage", {
    projectId: pid,
    operation: "taskResume",
    taskId,
    expectedRevision: updated.revision,
  });
  await until(
    async () => (await readTask()).runCount === 161,
    "a real newly admitted run extends migrated history",
  );
  await history.getByText(/运行记录 · 共\s*161\s*次/).waitFor();
  assert.equal(await history.locator("[data-run-id]").count(), 161, "all loaded runs stay listed");
  assert.equal(
    await history.getByRole("button", { name: "加载更早运行", exact: true }).count(),
    0,
    "head refresh preserves an exhausted historical tail after run 161",
  );
  assert.equal(
    await history.locator('[data-run-id="history-run-000"]').count(),
    1,
    "head refresh retains the oldest loaded run",
  );
  checks.push(
    "after all160 seeded records load, a real scheduled admission creates run161 and head refresh retains the full loaded tail without resurrecting load more",
  );
  await app.evaluate(() => {
    global.taskHistoryHeadLimit = 3;
    global.taskHistoryHeadGate = new Promise((resolve) => {
      global.taskHistoryReleaseHead = () => {
        global.taskHistoryHeadGate = null;
        resolve();
      };
    });
  });
  let latest = await until(async () => {
    const value = await readTask();
    return (
      value.runs.every((run) => ["completed", "failed", "cancelled"].includes(run.status)) && value
    );
  }, "the first new run settles");
  const recurring = await call("manage", {
    projectId: pid,
    operation: "taskUpdate",
    taskId,
    expectedRevision: latest.revision,
    schedule: {
      at: Math.floor(Date.now() / 1000) + 2,
      intervalSeconds: 1,
      timeZone: "Asia/Shanghai",
    },
  });
  if (recurring.paused)
    await call("manage", {
      projectId: pid,
      operation: "taskResume",
      taskId,
      expectedRevision: recurring.revision,
    });
  latest = await until(async () => {
    const value = await readTask();
    return value.runCount >= 165 && value;
  }, "several real admissions exceed the short head page");
  await until(async () => {
    latest = await readTask();
    const reply = await page.evaluate((request) => window.arealDesktop.command("manage", request), {
      projectId: pid,
      operation: "taskPause",
      taskId,
      expectedRevision: latest.revision,
    });
    if (reply.ok) {
      assert.equal(reply.value.paused, true);
      return true;
    }
    assert.equal(reply.error.code, -32009, JSON.stringify(reply));
    return false;
  }, "public pause accepts a current Task revision after burst admissions");
  await app.evaluate(() => global.taskHistoryReleaseHead());
  await history.getByRole("button", { name: "刷新运行记录", exact: true }).waitFor();
  const shortHead = await app.evaluate(() =>
    global.taskHistoryReads.findLast((read) => read.operation === "taskRuns" && !read.cursor),
  );
  assert.equal(shortHead.dataLength, 3, "the gap scenario uses the actual shorter Core page");
  await history.getByRole("button", { name: "刷新运行记录", exact: true }).click();
  await until(
    async () =>
      (await history.getByRole("button", { name: "刷新运行记录", exact: true }).count()) === 0,
    "explicit refresh resets traversal after head gap",
  );
  assert.equal(
    await history.getByRole("button", { name: "加载更早运行", exact: true }).count(),
    1,
    "explicit refresh restores a valid new tail continuation",
  );
  await app.evaluate(() => {
    global.taskHistoryTailGate = new Promise((resolve) => {
      global.taskHistoryReleaseTail = () => {
        global.taskHistoryTailGate = null;
        resolve();
      };
    });
  });
  await history.getByRole("button", { name: "加载更早运行", exact: true }).click();
  const pendingTailCursor = await until(
    () => app.evaluate(() => global.taskHistoryTailWaiting),
    "the older history read reaches its Main barrier",
  );
  let beforeTailAdmission = await until(async () => {
    const value = await readTask();
    return (
      value.runs.every((run) => ["completed", "failed", "cancelled"].includes(run.status)) && value
    );
  }, "burst admissions settle before the held tail read");
  const tailCount = beforeTailAdmission.runCount;
  const once = await call("manage", {
    projectId: pid,
    operation: "taskUpdate",
    taskId,
    expectedRevision: beforeTailAdmission.revision,
    schedule: {
      at: Math.floor(Date.now() / 1000) + 2,
      intervalSeconds: null,
      timeZone: "Asia/Shanghai",
    },
  });
  await call("manage", {
    projectId: pid,
    operation: "taskResume",
    taskId,
    expectedRevision: once.revision,
  });
  await until(
    async () => (await readTask()).runCount === tailCount + 1,
    "a new run arrives while the frozen tail read is pending",
  );
  const headReadsBeforeTail = await app.evaluate(
    () =>
      global.taskHistoryReads.filter((read) => read.operation === "taskRuns" && !read.cursor)
        .length,
  );
  await app.evaluate(() => global.taskHistoryReleaseTail());
  await until(
    () =>
      app.evaluate(
        (_electron, cursor) =>
          global.taskHistoryReads.some(
            (read) => read.operation === "taskRuns" && read.cursor === cursor,
          ),
        pendingTailCursor,
      ),
    "the exact held tail read completes",
  );
  await until(
    () =>
      app.evaluate(
        (_electron, before) =>
          global.taskHistoryReads.filter((read) => read.operation === "taskRuns" && !read.cursor)
            .length > before,
        headReadsBeforeTail,
      ),
    "tail response with a newer total still causes a head refresh",
  );
  while (await history.getByRole("button", { name: "加载更早运行", exact: true }).count()) {
    await history.getByRole("button", { name: "加载更早运行", exact: true }).click();
    await until(
      async () =>
        !(await history.getByRole("button", { name: "加载更早运行", exact: true }).count()) ||
        (await history.getByRole("button", { name: "加载更早运行", exact: true }).isEnabled()),
      "older page completes",
    );
  }
  assert.equal(
    await history.locator("[data-run-id]").count(),
    (await readTask()).runCount,
    "paging after explicit refresh closes the burst gap",
  );
  await app.evaluate(() => {
    global.taskHistoryHeadLimit = 0;
  });
  checks.push(
    "a bounded three-record Core head page after several real admissions exposes an explicit refresh; a new arrival during a held frozen-tail read still triggers a fresh head query and paging loads the entire run count",
  );
  await page.screenshot({ path: join(scratch, "cold-run-history.png") });
  await cold.getByRole("button", { name: "打开执行会话", exact: true }).click();
  await until(
    async () =>
      (await page.getByTestId("areal-workbench").getAttribute("data-thread-id")) === coldThreadId &&
      (await page.getByTestId("areal-workbench").getAttribute("data-project-id")) === pid,
    "cold history opens its exact original execution Thread",
  );
  checks.push(
    "real TaskCenter loads older history without duplicate rows, retains cold report and worker identity, offers no terminal-run controls and opens the original execution Thread",
  );
  await stopOwnedService();
  await launch();
  const capacity = await call("manage", {
    projectId: pid,
    operation: "taskCreate",
    mode: "scheduled",
    objective: "TASK_HISTORY_CAPACITY_REAL_GOAL",
    schedule: { at: Math.floor(Date.now() / 1000) + 2, timeZone: "Asia/Shanghai" },
  });
  const readCapacity = () =>
    call("manage", { projectId: pid, operation: "task", taskId: capacity.id });
  let admitted = await until(async () => {
    const value = await readCapacity();
    return (
      value.runs.some(
        (run) =>
          run.goalId && run.threadId && !["completed", "failed", "cancelled"].includes(run.status),
      ) && value
    );
  }, "a real admitted capacity run has its original Goal and Thread");
  const liveRun = admitted.runs.find(
    (run) =>
      run.goalId && run.threadId && !["completed", "failed", "cancelled"].includes(run.status),
  );
  await until(() => held.size === 1, "the real capacity Goal reaches its held model response");
  const goal = await call("manage", {
    projectId: pid,
    operation: "goal",
    threadId: liveRun.threadId,
  });
  await call("manage", {
    projectId: pid,
    operation: "goalPause",
    threadId: liveRun.threadId,
    goalId: liveRun.goalId,
    expectedRevision: goal.revision,
  });
  admitted = await until(async () => {
    const value = await readCapacity();
    return (
      value.runs.some(
        (run) => run.id === liveRun.id && run.status === "paused" && run.reason !== "stopRequested",
      ) && value
    );
  }, "public Goal pause retains its real nonterminal run without clearing usage");
  const channel = await call("manage", {
    projectId: pid,
    operation: "taskChannel",
    taskId: capacity.id,
    limit: 100,
  });
  assert.equal(channel.hasMore, false);
  await stopOwnedService();
  const capacityFiles = await taskFiles(join(scratch, "core"));
  assert.equal(capacityFiles.length, 1);
  const originalRun = admitted.runs.find(
    (run) =>
      run.goalId && run.threadId && !["completed", "failed", "cancelled"].includes(run.status),
  );
  const seededCapacity = structuredClone(admitted);
  delete seededCapacity.runCount;
  delete seededCapacity.archivedRunCount;
  delete seededCapacity.runsComplete;
  seededCapacity.messages = channel.data;
  const seededReceipts = Array.from({ length: 8192 }, (_, index) => ({
    identity: "fixture-seeded-past-owner",
    method: "pause",
    requestId: `fixture-old-${index}`,
    digest: "0".repeat(64),
    result: { fixture: true, index },
  }));
  const capacityStore = JSON.stringify({
    version: 3,
    tasks: { [capacity.id]: seededCapacity },
    receipts: seededReceipts,
    preparations: {},
  });
  assert.ok(
    Buffer.byteLength(capacityStore) < 32 * 1024 * 1024,
    "bounded isolated v3 migration fixture",
  );
  await writeFile(capacityFiles[0], capacityStore);
  await launch();
  await page.getByRole("button", { name: "定时任务", exact: true }).click();
  await page
    .getByRole("button", { name: "打开自动化 TASK_HISTORY_CAPACITY_REAL_GOAL", exact: true })
    .click();
  await page.getByRole("button", { name: "任务资源", exact: true }).click();
  const capacityHistory = page.locator(".task-resource-history");
  await capacityHistory.waitFor();
  const active = capacityHistory.locator(`[data-run-id="${originalRun.id}"]`);
  await active.getByRole("button", { name: "停止本次运行", exact: true }).click();
  await until(async () => {
    const value = await readCapacity();
    return value.runs.some(
      (run) =>
        run.id === originalRun.id && ["completed", "failed", "cancelled"].includes(run.status),
    );
  }, "GUI stop settles the original real run at historical receipt capacity");
  await page.getByRole("button", { name: "任务资源", exact: true }).click();
  await page.getByLabel("任务资源面板", { exact: true }).waitFor({ state: "detached" });
  await page.getByTestId("chat-input").fill("取消任务。");
  await page.getByTestId("chat-send-button").click();
  const cancelled = await until(async () => {
    const value = await readCapacity();
    return value.cancelled && value;
  }, "GUI management conversation cancels at historical receipt capacity");
  assert.equal(cancelled.runs.find((run) => run.id === originalRun.id).goalId, originalRun.goalId);
  assert.equal(
    cancelled.runs.find((run) => run.id === originalRun.id).threadId,
    originalRun.threadId,
  );
  await stopOwnedService();
  await launch();
  const durable = await readCapacity();
  assert.equal(durable.cancelled, true);
  assert.equal(durable.runs.find((run) => run.id === originalRun.id).status, "cancelled");
  checks.push(
    "8192 explicitly seeded historical pause receipts migrate with a real publicly admitted Run/Goal/Thread; real GUI stop and management cancel succeed, retain identity and remain cancelled after restart",
  );
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  errors.push(error.stack ?? error.message);
  if (page) {
    await writeFile(
      join(scratch, "failure-state.json"),
      JSON.stringify(await snapshot(), null, 2),
    ).catch(() => {});
    await page.screenshot({ path: join(scratch, "failure.png") }).catch(() => {});
  }
  throw error;
} finally {
  if (app)
    await app
      .evaluate(() => {
        global.taskHistoryReleaseRun?.();
        global.taskHistoryReleaseHead?.();
        global.taskHistoryReleaseTail?.();
      })
      .catch(() => {});
  for (const response of held) response.destroy();
  if (app) {
    try {
      await stopOwnedService();
    } catch (error) {
      errors.push(`cleanup: ${error.message}`);
      if (
        electronProcess &&
        electronProcess.exitCode === null &&
        electronProcess.signalCode === null
      )
        electronProcess.kill("SIGKILL");
      app = null;
      page = null;
      await waitForElectronExit().catch((failure) => errors.push(`cleanup: ${failure.message}`));
    }
  }
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  let cleanupPassed = false;
  try {
    await assertApplicationStopped(binary, env);
    cleanupPassed = true;
  } catch (error) {
    errors.push(`cleanup: ${error.message}`);
  }
  const binarySha256After = createHash("sha256")
    .update(await readFile(binary))
    .digest("hex");
  const binaryUnchanged = binarySha256After === binarySha256;
  if (!binaryUnchanged) errors.push("Core binary changed during task history acceptance");
  const cleanup = {
    applicationStopped: cleanupPassed,
    electronExited:
      !electronProcess || electronProcess.exitCode !== null || electronProcess.signalCode !== null,
  };
  passed = passed && errors.length === 0;
  if (!passed) process.exitCode = 1;
  await writeFile(join(scratch, "model-requests.json"), JSON.stringify(modelRequests, null, 2));
  await writeFile(
    join(scratch, "evidence.json"),
    JSON.stringify(
      { passed, binary, binarySha256, binarySha256After, binaryUnchanged, cleanup, checks, errors },
      null,
      2,
    ),
  );
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed,
        sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: gui,
          encoding: "utf8",
        }).trim(),
        diff: execFileSync("git", ["diff", "--stat"], { cwd: gui, encoding: "utf8" }),
        binary,
        binarySha256,
        binarySha256After,
        binaryUnchanged,
        cleanup,
        checks,
        errors,
        boundaries: [
          "real isolated Electron, preload, desktop adapter and Core",
          "160 terminal runs and8192 old receipts are explicit stopped legacy v3 setup",
          "new runs and capacity Run/Goal/Thread use public admission",
          "notification input and transient read faults are injected at Main service-client boundary",
          "native OS notification delivery, real providers and packaged app are not exercised",
        ],
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed, scratch, checks, errors }));
}
