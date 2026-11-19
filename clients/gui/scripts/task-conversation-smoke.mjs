import { makeTempDir } from "./support/temp.mjs";
import { until as waitFor } from "./support/desktop-fixture.mjs";
// 真实 Electron / Desktop adapter / Core；模型响应确定化，所有状态与权限来自生产路径。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, rmdir, writeFile, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { CoreClient } from "../packages/runtime-client/core.js";
import {
  assertApplicationStopped,
  cleanupSyntheticHostKeychain,
  closeSmokeApplication,
} from "./application-cleanup.mjs";
import { withSmokeDeadline } from "./smoke-deadline.mjs";
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [
  "AREAL_TASK_CREATION_REGRESSION",
  "AREAL_TASK_LOADING_REGRESSION",
  "AREAL_TASK_DAILY_START_REGRESSION",
  "AREAL_TASK_INLINE_REGRESSION",
  "AREAL_TASK_MANUAL_REGRESSION",
]) {
  assert.ok(
    !process.env[name],
    `${name} still targets the removed global unsaved TaskDraft entry and requires migration. Use test:thread-schedules for the ordinary-Thread replacement; this mode has not passed or been skipped.`,
  );
}
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const binary = process.env.AREAL_CORE_BIN || resolve(gui, "../../target/debug/areal");
const binarySha256 = createHash("sha256")
  .update(await readFile(binary))
  .digest("hex");
const scratch = await makeTempDir("areal-schedule-desktop-");
const rust = process.argv.includes("--rust");
const seedNavigation = process.argv.includes("--seed-navigation");
assert.ok(!seedNavigation || rust, "Navigation projection requires Rust mode");
if (rust && process.platform === "darwin") assert.equal(process.env.AREAL_TEST_HOST_KEYCHAIN, "1");
const legacyTargetOnly = process.argv.includes("--legacy-target-only");
const calendarRegression = process.env.AREAL_TASK_CALENDAR_REGRESSION === "1";
const calendarDropGate = join(scratch, "calendar-drop-response"),
  calendarTrace = join(scratch, "calendar-create-requests.jsonl"),
  calendarReceiptTrace = join(scratch, "calendar-receipt-unavailable.jsonl");
const calendarMainErrors = join(scratch, "calendar-main-errors.jsonl");
const manualCleanup = { exits: [] };
let calendarUnknownRequestId;
let launchApp = process.env.AREAL_GUI_TEST_APP_DIR || join(gui, "app");
const workspace = join(scratch, "workspace"),
  userHome = join(scratch, "user");
await mkdir(workspace);
await mkdir(join(userHome, ".areal"), { recursive: true });
const taskDirectory = join(workspace, "task-working-directory"),
  independentDirectory = join(scratch, "independent-working-directory");
await mkdir(taskDirectory);
await mkdir(independentDirectory);
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
const errors = [],
  checks = [],
  modelRequests = [],
  catalogEvents = [],
  held = new Set();
const legacySetups = [];
const pastDailyAnchor = new Date(Date.now() - 86400000).toISOString().replace(/\.\d{3}Z$/, "Z");
const changedAnchor = new Date(Date.now() + 172800000).toISOString().replace(/\.\d{3}Z$/, "Z");
const blockedOnce = new Set();
const text = (message) =>
  typeof message.content === "string"
    ? message.content
    : (message.content ?? []).map((part) => part.text ?? "").join("\n");
const model = createServer(async (request, response) => {
  try {
    assert.equal(
      request.headers.authorization,
      "Bearer task-fixture-key",
      "every scheduled model request carries its configured credential",
    );
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw),
      messages = body.messages ?? [];
    if (
      messages.some(
        (message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.startsWith("Predict the next user prompt from the conversation data."),
      )
    ) {
      assert.ok(!body.tools?.length, "prompt prediction must not receive tools");
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    modelRequests.push(body);
    if (body.stream === false) {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }),
      );
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (delta, reason = null) =>
      response.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`,
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
    if (messages.some((m) => m.role === "user" && text(m).includes("ORDINARY_TASK_MODEL"))) {
      finish("普通会话模型已受理。");
      return;
    }
    if (
      messages.some(
        (m) => m.role === "system" && text(m).includes("Generate a concise semantic session title"),
      )
    ) {
      finish("每日问候");
      return;
    }
    if (messages.some((m) => text(m).includes("AREAL_TASK_DRAFT"))) {
      const last = messages
        .filter((m) => m.role === "user" && !text(m).startsWith("AReaL runtime context"))
        .at(-1);
      const requestText = text(last ?? {});
      if (requestText.startsWith("LEGACY_EDITOR_SEED")) {
        finish(
          JSON.stringify({
            kind: "proposal",
            message: "保存旧版任务验收前置数据。",
            objective: requestText,
            interactionMode: "interactive",
            schedule: { at: "2040-01-02T09:00:00+08:00" },
          }),
        );
        return;
      }
      if (requestText.includes("过去的每日时间")) {
        finish(
          JSON.stringify({
            kind: "proposal",
            message: "已保存每日任务。",
            objective: "过去的每日时间 SCHEDULE_FIXTURE_COMPLETE",
            interactionMode: "interactive",
            dailyStart: { kind: "nearest" },
            schedule: { at: pastDailyAnchor, intervalSeconds: 86400 },
          }),
        );
        return;
      }
      if (requestText.includes("明确改为一次")) {
        finish(
          JSON.stringify({
            kind: "proposal",
            message: "已保存一次性任务。",
            schedule: { at: changedAnchor, intervalSeconds: null },
          }),
        );
        return;
      }
      if (requestText.includes("过去的一次性时间")) {
        finish(
          JSON.stringify({
            kind: "proposal",
            message: "已保存过期的一次性任务。",
            schedule: { at: pastDailyAnchor, intervalSeconds: null },
          }),
        );
        return;
      }
      if (requestText.includes("旧项目目录验收")) {
        finish(
          JSON.stringify({
            kind: "proposal",
            message: "已保存旧项目任务。",
            objective: "旧项目目录验收 SCHEDULE_FIXTURE_COMPLETE",
            interactionMode: "interactive",
            schedule: { at: changedAnchor },
          }),
        );
        return;
      }
      if (requestText.includes("独立目录验收")) {
        finish(
          JSON.stringify({
            kind: "proposal",
            message: "已保存独立任务。",
            objective: "独立目录验收 SCHEDULE_FIXTURE_COMPLETE",
            interactionMode: "interactive",
            schedule: {
              at: new Date(Date.now() + 4000).toISOString().replace(/\.\d{3}Z$/, "Z"),
              intervalSeconds: 8,
            },
          }),
        );
        return;
      }
      if (calendarRegression && requestText.includes("日历重试验收")) {
        finish(
          JSON.stringify({
            kind: "proposal",
            message: "等待保存。",
            objective: "日历重试验收",
            scheduleV2: {
              version: 1,
              rule: {
                kind: "onceLocal",
                timeZone: "Asia/Shanghai",
                localTime: "09:00",
                date: { kind: "relative", days: 2 },
              },
              misfire: { kind: "skip", maxLatenessSeconds: 300 },
              overlap: "skip",
            },
          }),
        );
        return;
      }
      if (calendarRegression && requestText.includes("日历验收")) {
        if (requestText.includes("旧格式时刻")) {
          finish(
            JSON.stringify({
              kind: "proposal",
              message: "更改时刻。",
              schedule: { at: "2040-01-02T10:00:00+08:00" },
            }),
          );
          return;
        }
        const wrong = requestText.includes("误给固定间隔");
        const monthly = requestText.includes("月末");
        const rule = wrong
          ? { kind: "interval", anchorAt: 2208988800, intervalSeconds: 86400 }
          : {
              kind: "calendar",
              timeZone: "Asia/Shanghai",
              frequency: monthly ? "monthly" : "weekly",
              interval: 1,
              localTime: "09:00",
              anchorDate: "2040-01-01",
              ...(monthly ? { monthDays: ["last"] } : { weekdays: [1, 2, 3, 4, 5] }),
            };
        finish(
          JSON.stringify({
            kind: "proposal",
            message: "日历安排已准备。",
            objective: "日历验收 SCHEDULE_FIXTURE_COMPLETE",
            scheduleV2: {
              version: 1,
              rule,
              misfire: { kind: "skip", maxLatenessSeconds: 300 },
              overlap: "skip",
            },
          }),
        );
        return;
      }
      if (requestText.includes("只修改时刻")) {
        finish(
          JSON.stringify({
            kind: "proposal",
            message: "已更新并保存执行时间。",
            schedule: { at: changedAnchor },
          }),
        );
        return;
      }
      if (requestText.includes("保存失败")) {
        finish(
          JSON.stringify({
            kind: "proposal",
            message: "已保存修改，已更新执行时间。",
            schedule: { at: "broken" },
          }),
        );
        return;
      }
      if (requestText.includes("没有时间")) {
        finish(JSON.stringify({ kind: "question", message: "你希望什么时候执行？" }));
        return;
      }
      if (requestText.includes("取消任务")) {
        finish(
          JSON.stringify({ kind: "control", message: "将取消任务并保留历史。", action: "cancel" }),
        );
        return;
      }
      if (requestText.includes("暂停")) {
        finish(JSON.stringify({ kind: "control", message: "将暂停后续执行。", action: "pause" }));
        return;
      }
      if (requestText.includes("恢复")) {
        finish(JSON.stringify({ kind: "control", message: "将恢复后续执行。", action: "resume" }));
        return;
      }
      if (requestText.includes("更新描述")) {
        finish(
          JSON.stringify({
            kind: "proposal",
            message: "将只汇报阻塞项。",
            objective: "只汇报阻塞项 SCHEDULE_FIXTURE_COMPLETE",
          }),
        );
        return;
      }
      if (requestText.includes("不合法")) {
        finish(
          JSON.stringify({ kind: "proposal", message: "将修改时间。", schedule: { at: "broken" } }),
        );
        return;
      }
      if (requestText.includes("稍后")) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      finish(
        JSON.stringify({
          kind: "proposal",
          message: "每次运行会创建新会话。",
          objective: "检查项目提交和 PR SCHEDULE_FIXTURE_COMPLETE",
          interactionMode: "interactive",
          schedule: {
            at: new Date(Date.now() + 12000).toISOString().replace(/\.\d{3}Z$/, "Z"),
            intervalSeconds: 8,
          },
        }),
      );
      return;
    }
    const contexts = messages.map(text).filter((t) => t.includes("Current authoritative goal: "));
    const goalView = JSON.parse(contexts.at(-1).split("Current authoritative goal: ").at(-1));
    const goal = goalView.goal;
    if (goal.limitsPending) {
      tool("goal_set_limits", { expectedRevision: goalView.revision, sources: {} });
      return;
    }
    if (goal.objective.includes("READ_RESUME") && !blockedOnce.has(goal.id)) {
      blockedOnce.add(goal.id);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      tool("goal_update", {
        expectedRevision: goalView.revision,
        status: "blocked",
        summary: "Earlier Turn finished; waiting for explicit resume.",
        evidence: ["Fixture reached its decision boundary."],
        remaining: ["Resume explicitly"],
        blocker: "Explicit user decision",
      });
      return;
    }
    if (
      goal.objective.includes("READ_RESUME") &&
      goal.report?.status === "blocked" &&
      goal.reportTurnId === goal.activeTurnId
    ) {
      finish("Earlier Turn complete; explicit resume required.");
      return;
    }
    if (goal.objective.includes("HOLD")) {
      send({ content: "运行中，等待用户停止。" });
      held.add(response);
      response.on("close", () => held.delete(response));
      return;
    }
    const lastUser = messages.findLastIndex(
      (m) => m.role === "user" && !text(m).startsWith("AReaL runtime context"),
    );
    if (
      goal.objective.includes("APPROVAL") &&
      !messages
        .slice(lastUser + 1)
        .some((m) => (m.tool_calls ?? []).some((c) => c.function?.name === "fs_create"))
    ) {
      tool("fs_create", {
        path: `workspace://repo/approval-${randomUUID()}.txt`,
        text: "approved",
      });
      return;
    }
    if (goal.report?.status === "complete") {
      finish("SCHEDULE_FIXTURE_DONE");
      return;
    }
    tool("goal_update", {
      expectedRevision: goalView.revision,
      status: "complete",
      summary: "SCHEDULE_FIXTURE_DONE",
      evidence: ["Deterministic fixture completed its requested response."],
      remaining: [],
    });
  } catch (error) {
    errors.push(error.stack);
    response.destroy(error);
  }
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
await writeFile(
  join(userHome, ".areal/config.toml"),
  `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\napi_key_env="AREAL_CREDENTIAL_task_fixture"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n[permissions]\nmode="YOLO"\nask=["fs_create"]\n`,
);
const deployment = join(scratch, "desktop.json");
await writeFile(
  deployment,
  JSON.stringify({
    profiles: [
      {
        id: "standard",
        revision: "v1",
        displayName: "Fixture",
        instructions: "Complete the requested fixture.",
        approvalTools: ["fs_create"],
      },
    ],
  }),
);
const env = {
  ...process.env,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: userHome,
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_CORE_DESKTOP_CONFIG: deployment,
  AREAL_CORE_BIN: binary,
  AREAL_CREDENTIAL_task_fixture: "task-fixture-key",
};
for (const key of [
  "AREAL_CORE_WORKSPACE",
  "AREAL_CORE_CONFIG",
  "AREAL_HARNESS_HOME",
  "AREAL_HARNESS_CONFIG",
])
  delete env[key];
let app,
  page,
  pid,
  workspacePid,
  taskCwd,
  navigationFixture,
  passed = false;
const until = (read, label, timeout = 60000) => waitFor(read, label, { timeout, interval: 150 });
const snapshot = () =>
  legacyTargetOnly
    ? withSmokeDeadline("legacy target snapshot", () =>
        page.evaluate(() => window.arealDesktop.snapshot()),
      )
    : page.evaluate(() => window.arealDesktop.snapshot());
async function call(name, params) {
  const invoke = () =>
    page.evaluate(({ name, params }) => window.arealDesktop.command(name, params), {
      name,
      params,
    });
  const reply = legacyTargetOnly
    ? await withSmokeDeadline(`legacy target ${name}`, invoke)
    : await invoke();
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.value;
}
const task = (id) => call("manage", { projectId: pid, operation: "task", taskId: id });
const control = async (id, operation, runId) => {
  const current = await task(id);
  return call("manage", {
    projectId: pid,
    operation,
    taskId: id,
    expectedRevision: current.revision,
    ...(runId ? { expectedRunId: runId } : {}),
  });
};
async function readAuthoritativeThread(threadId) {
  const owner = (await snapshot()).projects.find((project) => project.id === pid);
  const descriptor = JSON.parse(
    execFileSync(binary, ["service", "status", "--instance", owner.core.instanceId, "--json"], {
      env,
      encoding: "utf8",
    }),
  );
  assert.equal(descriptor.state, "ready");
  assert.equal(descriptor.serviceId, owner.core.instanceId);
  const auth = JSON.parse(await readFile(descriptor.authFile, "utf8"));
  const principal = auth.principals.find((value) => value.permissions.includes("observe"));
  assert.ok(principal?.token);
  const WebSocket = require("ws");
  const client = new CoreClient({
    createSocket: () =>
      new WebSocket(descriptor.endpoint, {
        headers: { Authorization: `Bearer ${principal.token}` },
        followRedirects: false,
      }),
  });
  try {
    await client.connect();
    return (await client.request("thread/read", { threadId, includeTurns: false })).thread;
  } finally {
    client.close();
  }
}
async function prepareLegacyDraft() {
  const prepared = await call("projectless", { operation: "prepare", requestId: randomUUID() });
  await call("connect", { projectId: prepared.projectId });
  const owner = await until(
    async () =>
      (await snapshot()).projects.find(
        (project) => project.id === prepared.projectId && project.state?.connected,
      ),
    "legacy fixture owner ready",
  );
  const started = await call("manage", {
    projectId: owner.id,
    operation: "taskDraftStart",
    draftId: randomUUID(),
    cwd: owner.root,
    timeZone: "Asia/Shanghai",
  });
  return { owner, started };
}
async function legacyProposal(owner, started, message) {
  await call("manage", {
    projectId: owner.id,
    operation: "taskDraftSend",
    threadId: started.threadId,
    text: message,
    timeZone: "Asia/Shanghai",
  });
  return until(async () => {
    const value = await call("manage", {
      projectId: owner.id,
      operation: "taskDraftRead",
      threadId: started.threadId,
    });
    return !value.running && value.proposal && value;
  }, "legacy fixture proposal ready");
}
async function openLegacyFixture() {
  const { owner, started } = await prepareLegacyDraft();
  const proposal = await legacyProposal(owner, started, `LEGACY_EDITOR_SEED ${randomUUID()}`);
  const seed = await call("manage", {
    projectId: owner.id,
    operation: "taskDraftConfirm",
    threadId: started.threadId,
    turnId: proposal.turnId,
    digest: proposal.digest,
  });
  legacySetups.push({
    ownerId: owner.id,
    threadId: started.threadId,
    task: seed,
    boundary:
      "Supported bridge setup creates an existing legacy task; subsequent editing and history use the real TaskCenter UI. This does not prove the removed new-task TaskDraft UI.",
  });
  await page.getByRole("button", { name: `打开定时任务 ${seed.objective}`, exact: true }).click();
  await page.getByRole("main", { name: "定时任务会话", exact: true }).waitFor();
  const chat = page.getByTestId("chat-input");
  await chat.waitFor();
  await until(() => chat.isEditable(), "existing legacy management Composer ready");
  const draft = await call("manage", {
    projectId: owner.id,
    operation: "taskDraftRead",
    threadId: started.threadId,
  });
  assert.equal(draft.thread.cwd, owner.root);
  checks.push(
    "explicit supported-bridge setup opens an existing legacy Task in its retained management UI",
  );
  return { owner, draft, seed, saved: { ownerId: owner.id, threadId: started.threadId } };
}
async function checkLegacyTargetRegression() {
  await page.getByRole("button", { name: "定时任务", exact: true }).click();
  const creation = await openLegacyFixture();
  pid = creation.owner.id;
  const history = await call("manage", {
    projectId: pid,
    operation: "taskDraftHistory",
    taskId: creation.seed.id,
  });
  assert.equal(history.threadId, creation.saved.threadId);
  const original = await call("manage", {
    projectId: pid,
    operation: "taskDraftRead",
    threadId: history.threadId,
  });
  assert.ok(original.messages.some((message) => message.text === creation.seed.objective));
  await page.getByText(creation.seed.objective, { exact: true }).first().waitFor();
  const state = await snapshot();
  const configuration = state.projects.find((project) => project.id === pid).configurations[
    history.threadId
  ];
  const targetLine = configuration.options.appendInstructions
    .split("\n")
    .find((line) => line.startsWith("Current scheduled task: "));
  const target = JSON.parse(targetLine.slice("Current scheduled task: ".length));
  assert.equal(target.taskId, creation.seed.id);
  assert.equal(target.expectedRevision, creation.seed.revision);
  assert.equal(target.owner, undefined, "saved edit context is a reduced target, not a Core Task");
  assert.equal(target.runs, undefined);
  const info = await call("workspace", { projectId: workspacePid, operation: "info" });
  assert.equal(info.directory, workspace);
  const skills = await call("manage", {
    projectId: pid,
    operation: "skills",
    threadId: history.threadId,
  });
  assert.ok(Array.isArray(skills.data), "Skills remain readable after opening legacy history");
  await page.getByRole("button", { name: "返回任务列表", exact: true }).click();
  await page
    .getByRole("button", { name: `打开定时任务 ${creation.seed.objective}`, exact: true })
    .click();
  await until(() => page.getByTestId("chat-input").isEditable(), "legacy history stays responsive");
  checks.push(
    "saved reduced target opens history while snapshots, workspace info and Skills respond",
  );
  await page.screenshot({ path: join(scratch, "legacy-target-open.png") });
  for (const restart of [false, true]) {
    if (restart) {
      await closeOwnedApp();
      await launch();
    }
    if (!restart) {
      await page.reload();
      await page.getByTestId("areal-workbench").waitFor();
    }
    await page.getByRole("button", { name: "定时任务", exact: true }).click();
    await page
      .getByRole("button", { name: `打开定时任务 ${creation.seed.objective}`, exact: true })
      .click();
    await until(
      () => page.getByTestId("chat-input").isEditable(),
      "restored legacy Composer ready",
    );
    const restored = await call("manage", {
      projectId: pid,
      operation: "taskDraftRead",
      threadId: history.threadId,
    });
    assert.equal(restored.threadId, history.threadId);
    assert.deepEqual(restored.messages, original.messages);
    assert.equal(restored.thread.cwd, creation.owner.root);
    assert.equal((await call("tasks", { operation: "list" })).data.length, 1);
    assert.deepEqual((await task(creation.seed.id)).scheduleV2, creation.seed.scheduleV2);
    assert.equal(
      (await snapshot()).projects.find((project) => project.id === pid).configurations[
        history.threadId
      ].options.appendInstructions,
      configuration.options.appendInstructions,
    );
    checks.push(
      `${restart ? "desktop restart" : "renderer reload"} preserves legacy target and history`,
    );
  }
  assert.deepEqual(errors, []);
}
async function launch() {
  app = await electron.launch({
    executablePath: process.env.AREAL_ELECTRON_EXECUTABLE || require("electron"),
    args: [launchApp],
    env,
    timeout: 120000,
  });
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.show();
    window.focus();
  });
  await page.bringToFront();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    const output = message.text();
    if (!output.startsWith("[task-catalog] ")) return;
    try {
      const { kind, requestId, viewEpoch, projectId, rows, at } = JSON.parse(
        output.slice("[task-catalog] ".length),
      );
      if (
        [
          "begin",
          "response_received",
          "epoch_discarded",
          "owner_committed",
          "end",
          "abandoned",
        ].includes(kind) &&
        typeof requestId === "string" &&
        Number.isSafeInteger(viewEpoch) &&
        typeof at === "number"
      )
        catalogEvents.push({ kind, requestId, viewEpoch, projectId, rows, at });
    } catch {}
  });
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await until(async () => (await snapshot()).connection?.state === "ready", "adapter ready");
}
if (calendarRegression) {
  await writeFile(calendarMainErrors, "");
  launchApp = join(scratch, "calendar-app");
  await mkdir(launchApp);
  await writeFile(
    join(launchApp, "package.json"),
    JSON.stringify({ name: "calendar-fixture", main: "bootstrap.cjs" }),
  );
  await writeFile(
    join(launchApp, "bootstrap.cjs"),
    `
process.on('uncaughtExceptionMonitor',(error,origin)=>require('node:fs').appendFileSync(${JSON.stringify(calendarMainErrors)},JSON.stringify({pid:process.pid,origin,name:error.name,message:error.message,stack:error.stack})+'\\n'));
const {CoreBackend}=require(${JSON.stringify(join(gui, "../../services/workbench/src/desktop/core/backend.cjs"))});
const fs=require('node:fs');
const connect=CoreBackend.prototype.connect;
CoreBackend.prototype.connect=async function(...args){
 const {CoreClient}=await import(${JSON.stringify(join(gui, "packages/runtime-client/core.js"))});
 if(!CoreClient.prototype.calendarFixture){
  CoreClient.prototype.calendarFixture=true;
  const clientConnect=CoreClient.prototype.connect;
  CoreClient.prototype.connect=async function(){
  const request=this.request.bind(this);
  this.request=async(method,params,options)=>{
   if(method==='areal/task/create'&&params.objective==='日历重试验收')fs.appendFileSync(${JSON.stringify(calendarTrace)},JSON.stringify(params)+'\\n');
   if(method==='areal/request/read'&&fs.existsSync(${JSON.stringify(calendarDropGate)})&&fs.existsSync(${JSON.stringify(calendarTrace)})){
    const original=fs.readFileSync(${JSON.stringify(calendarTrace)},'utf8').trim().split(String.fromCharCode(10)).filter(Boolean).map(line=>JSON.parse(line));
    if(original.some(entry=>entry.requestId===params.requestId)){fs.appendFileSync(${JSON.stringify(calendarReceiptTrace)},JSON.stringify(params)+'\\n');throw new Error('original calendar receipt fixture unavailable');}
   }
   const result=await request(method,params,options);
   if(method==='areal/task/create'&&params.objective==='日历重试验收'&&fs.existsSync(${JSON.stringify(calendarDropGate)}))throw Object.assign(new Error('calendar accepted response dropped'),{submissionUnknown:true});
   return result;
  };
  return clientConnect.call(this);
  };
 }
 return connect.apply(this,args);
};
require(${JSON.stringify(join(gui, "app/src/main.cjs"))});
`,
  );
}
async function checkCalendarRegression() {
  await page.getByRole("button", { name: "定时任务", exact: true }).click();
  const creation = await openLegacyFixture();
  pid = creation.owner.id;
  await page.getByTestId("chat-input").fill("日历验收，工作日早上09:00执行，误给固定间隔。");
  await page.getByTestId("chat-send-button").click();
  await page.getByRole("alert").filter({ hasText: "工作日" }).first().waitFor();
  assert.equal(
    (await task(creation.seed.id)).revision,
    creation.seed.revision,
    "weekday intent cannot silently replace the saved legacy schedule with a fixed interval",
  );
  await page.getByTestId("chat-input").fill("日历验收，2040年1月1日起工作日早上09:00执行。");
  await page.getByTestId("chat-send-button").click();
  const created = await until(async () => {
    const value = await task(creation.seed.id);
    return (
      value.revision > creation.seed.revision &&
      value.objective === "日历验收 SCHEDULE_FIXTURE_COMPLETE" &&
      value
    );
  }, "legacy task updates to the requested calendar schedule");
  assert.deepEqual(created.scheduleV2.rule.weekdays, [1, 2, 3, 4, 5]);
  assert.deepEqual(created.scheduleV2.misfire, { kind: "skip", maxLatenessSeconds: 300 });
  assert.equal(created.schedule, null);
  await page.getByLabel("后续执行预览", { exact: true }).waitFor();
  await page.getByText("错过 5 分钟后跳过", { exact: false }).first().waitFor();
  const visible = await page
    .getByLabel("后续执行预览", { exact: true })
    .locator("time")
    .allTextContents();
  assert.deepEqual(visible, [
    "2040-01-02 09:00",
    "2040-01-03 09:00",
    "2040-01-04 09:00",
    "2040-01-05 09:00",
    "2040-01-06 09:00",
  ]);
  const authoritative = await call("manage", {
    projectId: pid,
    operation: "taskSchedulePreview",
    schedule: created.scheduleV2,
    count: 5,
  });
  assert.deepEqual(
    authoritative.occurrences.map((o) => o.localTime),
    [
      "2040-01-02T09:00:00+08:00",
      "2040-01-03T09:00:00+08:00",
      "2040-01-04T09:00:00+08:00",
      "2040-01-05T09:00:00+08:00",
      "2040-01-06T09:00:00+08:00",
    ],
  );
  await page.screenshot({ path: join(scratch, "calendar-weekdays.png") });
  const history = await call("manage", {
    projectId: pid,
    operation: "taskDraftHistory",
    taskId: created.id,
  });
  await page.getByTestId("chat-input").fill("日历验收，旧格式时刻改为10:00。");
  await page.getByTestId("chat-send-button").click();
  await page.getByRole("alert").filter({ hasText: "完整日历计划" }).first().waitFor();
  assert.deepEqual(
    (await task(created.id)).scheduleV2,
    created.scheduleV2,
    "ambiguous legacy edit cannot turn calendar into once",
  );
  await page.getByTestId("chat-input").fill("日历验收，改为每月月末09:00执行。");
  await page.getByTestId("chat-send-button").click();
  const edited = await until(async () => {
    const t = await task(created.id);
    return t.scheduleV2?.rule.frequency === "monthly" && t;
  }, "calendar edit saved");
  assert.deepEqual(edited.scheduleV2.rule.monthDays, ["last"]);
  assert.equal(edited.scheduleV2.rule.timeZone, "Asia/Shanghai");
  await until(
    async () =>
      JSON.stringify(
        await page.getByLabel("后续执行预览", { exact: true }).locator("time").allTextContents(),
      ) ===
      JSON.stringify([
        "2040-01-31 09:00",
        "2040-02-29 09:00",
        "2040-03-31 09:00",
        "2040-04-30 09:00",
        "2040-05-31 09:00",
      ]),
    "visible month-end preview agrees with literal dates",
  );
  await page.screenshot({ path: join(scratch, "calendar-month-end.png") });
  await page.getByRole("button", { name: "返回任务列表", exact: true }).click();
  await page.getByText("日历验收 SCHEDULE_FIXTURE_COMPLETE", { exact: true }).first().click();
  await page.getByLabel("后续执行预览", { exact: true }).waitFor();
  assert.equal(
    (await call("manage", { projectId: pid, operation: "taskDraftHistory", taskId: created.id }))
      .threadId,
    history.threadId,
  );
  await page.getByRole("button", { name: "返回任务列表", exact: true }).click();
  const context = await call("manage", {
    projectId: pid,
    operation: "taskScheduleContext",
    timeZone: "Asia/Shanghai",
  });
  const missed = await call("manage", {
    projectId: pid,
    operation: "taskCreate",
    mode: "scheduled",
    objective: "日历错过验收 HOLD",
    scheduleV2: {
      version: 1,
      rule: { kind: "once", at: context.coreNow - 301 },
      misfire: { kind: "skip", maxLatenessSeconds: 300 },
      overlap: "skip",
    },
  });
  const missedState = await until(async () => {
    const t = await task(missed.id);
    return t.lastTriggerDecision?.outcome.kind === "missedWindow" && t;
  }, "Core missed once decision");
  assert.equal(missedState.runs.length, 0);
  await page.getByRole("button", { name: "打开定时任务 日历错过验收 HOLD", exact: true }).click();
  await page.getByText("已超过允许的延迟，跳过 1 次计划执行。", { exact: true }).first().waitFor();
  await page.screenshot({ path: join(scratch, "calendar-missed-once.png") });
  if (!(await page.getByLabel("任务资源面板", { exact: true }).isVisible()))
    await page.getByRole("button", { name: "任务资源", exact: true }).click();
  const immediate = page
    .getByLabel("定时任务安排", { exact: true })
    .getByRole("button", { name: "立即运行", exact: true });
  await until(() => immediate.isEnabled(), "missed schedule permits explicit manual admission");
  await immediate.click();
  const manualAfterMissed = await until(async () => {
    const value = await task(missed.id);
    return value.runs.at(-1)?.status === "running" && value;
  }, "manual run after missed once is running");
  assert.equal(manualAfterMissed.runs.at(-1).trigger, "manual");
  assert.deepEqual(manualAfterMissed.lastTriggerDecision, missedState.lastTriggerDecision);
  assert.equal(manualAfterMissed.nextRunAt, null);
  await page.getByRole("button", { name: "返回任务列表", exact: true }).click();
  const activeRow = page.getByRole("button", {
    name: "打开定时任务 日历错过验收 HOLD",
    exact: true,
  });
  await until(
    async () => (await activeRow.isVisible()) && (await activeRow.innerText()).includes("运行中"),
    "manual run after a missed once displays its active status",
  );
  for (const [label, checked] of [
    ["已开启", true],
    ["已暂停", false],
    ["已完成", false],
  ]) {
    await page.getByRole("button", { name: "筛选任务", exact: true }).click();
    const item = page.getByRole("menuitemcheckbox", { name: label, exact: true });
    if (((await item.getAttribute("aria-checked")) === "true") !== checked) await item.click();
    await page.keyboard.press("Escape");
  }
  await activeRow.waitFor();
  await page.screenshot({ path: join(scratch, "calendar-missed-manual-running.png") });
  await control(missed.id, "taskStopRun", manualAfterMissed.runs.at(-1).id);
  await until(
    async () =>
      ["cancelled", "completed", "failed"].includes((await task(missed.id)).runs.at(-1)?.status),
    "held manual run stops through the ordinary control",
  );
  for (const label of ["已暂停", "已完成"]) {
    await page.getByRole("button", { name: "筛选任务", exact: true }).click();
    const item = page.getByRole("menuitemcheckbox", { name: label, exact: true });
    if ((await item.getAttribute("aria-checked")) !== "true") await item.click();
    await page.keyboard.press("Escape");
  }

  await writeFile(calendarDropGate, "drop");
  const unknownCreation = await prepareLegacyDraft();
  pid = unknownCreation.owner.id;
  const unknownProposal = await legacyProposal(
    unknownCreation.owner,
    unknownCreation.started,
    "日历重试验收，两天后09:00执行。",
  );
  const unknownReply = await page.evaluate(
    (params) => window.arealDesktop.command("manage", params),
    {
      projectId: pid,
      operation: "taskDraftConfirm",
      threadId: unknownCreation.started.threadId,
      turnId: unknownProposal.turnId,
      digest: unknownProposal.digest,
    },
  );
  assert.equal(
    unknownReply.ok,
    false,
    "supplemental legacy bridge confirm surfaces the accepted response loss",
  );
  const unknown = await until(async () => {
    const owner = (await snapshot()).projects.find((p) => p.id === pid);
    return owner.pending?.find(
      (p) => p.method === "areal/task/create" && p.params.objective === "日历重试验收",
    );
  }, "original civil intent retained as UNKNOWN");
  calendarUnknownRequestId = unknown.params.requestId;
  assert.deepEqual(unknown.params.scheduleV2.rule, {
    kind: "onceLocal",
    timeZone: "Asia/Shanghai",
    localTime: "09:00",
    date: { kind: "relative", days: 2 },
  });
  const acceptedUnknown = (await call("tasks", { operation: "list" })).data.filter(
    (t) => t.projectId === pid && t.objective === "日历重试验收",
  );
  assert.equal(acceptedUnknown.length, 1);
  const creates = JSON.parse((await readFile(calendarTrace, "utf8")).trim());
  assert.deepEqual(creates, unknown.params);
  const withheldReceipts = (await readFile(calendarReceiptTrace, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  assert.ok(
    withheldReceipts.length > 0,
    "calendar UNKNOWN fixture actually withholds original receipt reconciliation",
  );
  assert.ok(
    withheldReceipts.every((entry) => entry.requestId === unknown.params.requestId),
    "receipt fault is limited to the exact original calendar request",
  );
  await page.getByRole("button", { name: "打开定时任务 日历重试验收", exact: true }).click();
  await page.screenshot({ path: join(scratch, "calendar-unknown.png") });
  await page.getByRole("button", { name: "返回任务列表", exact: true }).click();
  await page.getByRole("button", { name: "打开定时任务 日历重试验收", exact: true }).click();
  await until(
    async () =>
      !!(await snapshot()).projects
        .find((p) => p.id === pid)
        .pending?.some((p) => p.params.requestId === unknown.params.requestId),
    "same UNKNOWN remains after reopening",
  );
  assert.deepEqual(
    (await snapshot()).projects
      .find((p) => p.id === pid)
      .pending.find((p) => p.params.requestId === unknown.params.requestId).params,
    unknown.params,
  );
  assert.equal(
    (await readFile(calendarTrace, "utf8")).trim().split("\n").length,
    1,
    "reopening never re-resolves or repeats UNKNOWN create",
  );
  await rm(calendarDropGate);
  await writeFile(
    join(scratch, "calendar-manifest.json"),
    JSON.stringify(
      {
        binary,
        binarySha256,
        created,
        edited,
        missedState,
        manualAfterMissed,
        unknown,
        acceptedUnknown,
        unknownReply,
        withheldReceipts,
        legacySetups,
        modelRequests,
        proxies: [],
        injections: [
          "native project-directory chooser returns the isolated fixture workspace",
          "supported TaskDraft bridge seeds existing legacy management UI",
          "supplemental legacy bridge confirm loses the accepted calendar create response and withholds only its exact original receipt reads; catalog revisit proves no replay, not removed creation UI",
          "an existing HOLD model fixture keeps the explicitly requested manual Run observable",
        ],
        clock: "production Core SystemTime; explicit 2040 anchor",
      },
      null,
      2,
    ),
  );
  checks.push(
    "legacy management rejects weekday-to-interval, updates weekday calendar, edits month-end, shows Core preview/skip300 and reopens same history; supplemental legacy confirm preserves original UNKNOWN create through catalog navigation without replay",
  );
  assert.deepEqual(errors, []);
}
async function closeOwnedApp(quitResponse = rust ? 0 : 1, expectHost = rust) {
  const metadata = await readFile(join(scratch, "core/service.json"), "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  const hostIdentity = expectHost ? await observeHostIdentity() : null;
  await app.evaluate(
    ({ dialog }, { trace, quitResponse }) => {
      const fs = process.getBuiltinModule("node:fs");
      if (typeof fs?.appendFileSync !== "function")
        throw Error("Main builtin filesystem is unavailable for quit evidence");
      const old = dialog.showMessageBox;
      dialog.showMessageBox = async (...args) => {
        const options = args.at(-1);
        if (
          [
            "退出 AReaL Harness？",
            "Quit AReaL Harness?",
            "确认取消后台任务？",
            "Cancel background tasks?",
          ].includes(options.message)
        ) {
          fs.appendFileSync(
            trace,
            JSON.stringify({ message: options.message, buttons: options.buttons }) + "\n",
          );
          return { response: quitResponse };
        }
        return old(...args);
      };
    },
    { trace: join(scratch, "manual-quit-dialogs.jsonl"), quitResponse },
  );
  const processHandle = app.process();
  await closeSmokeApplication(app, 20000);
  await until(
    () => processHandle.exitCode !== null || processHandle.signalCode !== null,
    "owned Electron exits naturally",
    15000,
  );
  assert.equal(processHandle.exitCode, 0, "owned Electron quit exit code");
  assert.equal(processHandle.signalCode, null, "owned Electron quit signal");
  if (expectHost)
    assert.deepEqual(await observeHostIdentity(), hostIdentity, "original Host remains available");
  else await assertApplicationStopped(binary, env, metadata);
  manualCleanup.exits.push({
    pid: processHandle.pid,
    exitCode: processHandle.exitCode,
    signal: processHandle.signalCode,
    ...(expectHost ? { hostIdentity } : { applicationStopped: true }),
  });
  app = null;
  page = null;
}
async function observeHostIdentity() {
  const { HostClient } = require("@areal/client/node");
  const host = new HostClient();
  try {
    await host.connect(env.AREAL_HARNESS_SERVICE_HOME);
    return { hostId: host.hostId, generation: host.generation };
  } finally {
    host.close();
  }
}
try {
  await launch();
  if (rust) {
    await until(async () => (await call("serviceStatus", {})).connected, "bootstrap backend ready");
    const stop = JSON.parse(
      execFileSync(binary, ["host", "stop", "--cancel", "--json"], {
        env: { ...env, AREAL_HARNESS_HOME: env.AREAL_HARNESS_SERVICE_HOME },
        encoding: "utf8",
      }),
    );
    assert.equal(stop.state, "completed");
    assert.ok(stop.projects.every((project) => project.receipt?.state === "completed"));
    await writeFile(join(scratch, "rust-bootstrap-stop.json"), JSON.stringify(stop, null, 2));
    await closeOwnedApp(0, false);
    if (seedNavigation) {
      const { createSeedNavigationFixture } = await import("./support/seed-navigation-fixture.mjs");
      const readJson = async (path, fallback) =>
        readFile(path, "utf8")
          .then(JSON.parse)
          .catch((error) => {
            if (error.code === "ENOENT") return fallback;
            throw error;
          });
      const coreHome = env.AREAL_CORE_HOME;
      const fixture = await createSeedNavigationFixture({
        seedHome: resolve(gui, "../../.scratch/one-protocol-rust/seed-real"),
        fixtureRoot: scratch,
        existingProjects: await readJson(join(coreHome, "projects.json"), []),
        existingLibrary: await readJson(join(coreHome, "library.json"), {}),
      });
      navigationFixture = fixture;
      await writeFile(join(coreHome, "projects.json"), JSON.stringify(fixture.projects));
      await writeFile(join(coreHome, "library.json"), JSON.stringify(fixture.library));
    }
    const {
      GuiHostProjects,
    } = require("@areal/workbench-service/desktop/core/gui-host-projects.cjs");
    const projects = new GuiHostProjects({
      binary,
      home: env.AREAL_HARNESS_SERVICE_HOME,
      singletonHeld: true,
      source: {
        profile: env.AREAL_GUI_USER_DATA,
        coreHome: env.AREAL_CORE_HOME,
        legacyServiceHome: env.AREAL_HARNESS_SERVICE_HOME,
      },
    });
    try {
      await projects.init();
      for (const project of navigationFixture?.importedProjects ?? [])
        await projects.register(randomUUID(), project);
      const listing = await projects.client.listProjects();
      for (const project of listing.projects) {
        assert.ok(
          project.workspace.startsWith(scratch + "/"),
          "All registered workspaces must be isolated",
        );
      }
      const receipt = await projects.client.vaultReplace(
        randomUUID(),
        {
          kind: "providerCredential",
          sourceId: projects.sourceId,
          reference: "AREAL_CREDENTIAL_task_fixture",
        },
        0,
        "task-fixture-key",
      );
      assert.equal(receipt.state, "completed");
      await writeFile(
        join(scratch, "fixture-credential-receipt.json"),
        JSON.stringify(receipt, null, 2),
      );
    } finally {
      projects.close();
    }
    const seededStop = JSON.parse(
      execFileSync(binary, ["host", "stop", "--cancel", "--json"], {
        env: { ...env, AREAL_HARNESS_HOME: env.AREAL_HARNESS_SERVICE_HOME },
        encoding: "utf8",
      }),
    );
    await writeFile(join(scratch, "fixture-seed-stop.json"), JSON.stringify(seededStop, null, 2));
    assert.equal(seededStop.state, "completed");
    await launch();
    await until(async () => {
      const record = await readFile(
        join(env.AREAL_HARNESS_SERVICE_HOME, "workbench/backend-launch.json"),
        "utf8",
      )
        .then(JSON.parse)
        .catch(() => null);
      return record !== null;
    }, "Host backend launch record");
  }
  await app.evaluate(({ dialog, BrowserWindow }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    BrowserWindow.getAllWindows()[0].setSize(1488, 1056);
  }, workspace);
  await page.evaluate(() => window.arealDesktop.chooseProject());
  pid = (
    await until(
      async () =>
        (await snapshot()).projects.find((p) => p.root === workspace && p.state?.connected),
      "project ready",
    )
  ).id;
  workspacePid = pid;
  if (seedNavigation) {
    const imported = navigationFixture.importedProjects[0];
    const originalTitle =
      navigationFixture.library.projects[imported.id]?.title || imported.root.split("/").at(-1);
    const row = page.locator(`[data-sidebar-project="${imported.id}"]`);
    await row.waitFor();
    const actions = row.getByRole("button", { name: `项目操作 ${originalTitle}`, exact: true });
    await actions.focus();
    await actions.press("Enter");
    await page.getByRole("menuitem", { name: "置顶项目", exact: true }).click();
    await until(
      async () => (await snapshot()).library.projects[imported.id]?.pinned === true,
      "project pinned",
    );
    await page
      .locator("[data-sidebar-pinned]")
      .locator(`[data-sidebar-project="${imported.id}"]`)
      .waitFor();
    await actions.focus();
    await actions.press("Enter");
    await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
    await page.getByRole("textbox", { name: "名称", exact: true }).fill("隔离导航验收项目");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await until(
      async () => (await snapshot()).library.projects[imported.id]?.title === "隔离导航验收项目",
      "project renamed",
    );
    await row.getByRole("button", { name: "隔离导航验收项目", exact: true }).waitFor();
    checks.push(
      "projected navigation opens in isolated sidebar; GUI pins and renames a projected project",
    );
  }
  if (legacyTargetOnly) {
    await checkLegacyTargetRegression();
    passed = true;
  } else if (calendarRegression) {
    await checkCalendarRegression();
    passed = true;
  } else {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "外观", exact: true }).click();
    await page.getByRole("combobox", { name: "界面主题", exact: true }).click();
    await page.getByRole("option", { name: "浅色", exact: true }).click();
    await until(
      () =>
        page
          .locator("html")
          .evaluate(
            (el) => el.classList.contains("theme-areal-light") && !el.classList.contains("dark"),
          ),
      "light theme",
    );
    await page.getByRole("button", { name: "定时任务", exact: true }).click();
    assert.equal(
      await page.getByLabel("筛选任务归属", { exact: true }).count(),
      0,
      "task directory has no workspace filter",
    );
    const creation = await openLegacyFixture();
    pid = creation.owner.id;
    taskCwd = creation.owner.root;
    let chat = page.getByTestId("chat-input");
    assert.equal(await page.locator(".task-management-composer").count(), 0);
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(await page.locator("[data-v4-composer-dock]").count(), 1);
    await page.screenshot({ path: join(scratch, "task-create-light.png") });
    async function send(message) {
      await chat.fill(message);
      await page.getByTestId("chat-send-button").click();
    }
    await send("检查项目提交和 PR，没有时间。");
    await page.getByText("你希望什么时候执行？", { exact: true }).waitFor();
    assert.equal(
      (await task(creation.seed.id)).revision,
      creation.seed.revision,
      "clarification does not mutate the existing legacy task",
    );
    if (process.env.AREAL_TASK_SCHEDULE_REGRESSION === "1") {
      await send("过去的每日时间，请每天继续执行。");
      const recurring = await until(
        async () =>
          (await call("tasks", { operation: "list" })).data.find((t) =>
            t.objective.includes("过去的每日时间"),
          ),
        "past recurring anchor advances to a future execution",
        6000,
      );
      assert.equal(
        recurring.id,
        creation.seed.id,
        "legacy schedule update preserves the seeded task identity",
      );
      assert.equal(recurring.projectId, pid);
      assert.equal(recurring.scope, "independent");
      const history = await call("manage", {
        projectId: pid,
        operation: "taskDraftHistory",
        taskId: recurring.id,
      });
      const draft = await call("manage", {
        projectId: pid,
        operation: "taskDraftRead",
        threadId: history.threadId,
      });
      assert.equal(draft.thread.cwd, taskCwd);
      checks.push("global creation binds its management Thread to the independent owner directory");
      assert.equal(recurring.schedule.intervalSeconds, 86400);
      assert.ok(recurring.schedule.at > Date.now() / 1000);
      assert.ok(
        recurring.schedule.at <= Date.now() / 1000 + 86400,
        "daily recurrence chooses the next occurrence",
      );
      assert.equal((recurring.schedule.at - Date.parse(pastDailyAnchor) / 1000) % 86400, 0);
      await writeFile(join(scratch, "recurring-task.json"), JSON.stringify(recurring, null, 2));
      await chat.waitFor();
      assert.equal(
        await page.locator(".task-plan-summary").count(),
        0,
        "saved task conversation has no environment banner",
      );
      await page.screenshot({ path: join(scratch, "recurring-normalized.png") });
      checks.push("past recurring anchor advances to a future execution");
      await send("只修改时刻，保留每日频率。");
      const changed = await until(async () => {
        const value = await task(recurring.id);
        return value.schedule.at === Date.parse(changedAnchor) / 1000 && value;
      }, "time-only edit is saved");
      assert.equal(changed.schedule.intervalSeconds, 86400);
      await writeFile(join(scratch, "edited-task.json"), JSON.stringify(changed, null, 2));
      checks.push("time-only edit retains the daily interval in authoritative Core state");
      const beforeRejected = JSON.stringify(changed.schedule);
      await send("保存失败，不合法的时间。");
      await page.getByRole("alert").filter({ hasText: "时间" }).first().waitFor();
      assert.equal(JSON.stringify((await task(recurring.id)).schedule), beforeRejected);
      assert.equal(
        await page.getByText("已保存修改，已更新执行时间。", { exact: true }).count(),
        0,
      );
      await page.screenshot({ path: join(scratch, "rejected-save.png") });
      checks.push("rejected proposal preserves saved schedule and suppresses model success claim");
      await send("过去的一次性时间。");
      await page.getByRole("alert").filter({ hasText: "计划时间已过" }).first().waitFor();
      assert.equal(JSON.stringify((await task(recurring.id)).schedule), beforeRejected);
      assert.equal(await page.getByText("已保存过期的一次性任务。", { exact: true }).count(), 0);
      checks.push("past one-time schedule is rejected without changing the saved task");
      await send("明确改为一次，在新时间执行。");
      const once = await until(async () => {
        const value = await task(recurring.id);
        return value.revision > changed.revision && value.schedule.intervalSeconds == null && value;
      }, "explicit one-time edit clears interval");
      assert.equal(once.schedule.at, Date.parse(changedAnchor) / 1000);
      checks.push(
        "explicit one-time edit clears the interval without treating omitted frequency as a change",
      );
      await page.getByRole("button", { name: "返回任务列表", exact: true }).click();
      const rejected = await page.evaluate(
        ({ projectId, cwd, draftId }) =>
          window.arealDesktop.command("manage", {
            projectId,
            operation: "taskDraftStart",
            draftId,
            cwd,
            timeZone: "Asia/Shanghai",
          }),
        { projectId: workspacePid, cwd: independentDirectory, draftId: randomUUID() },
      );
      assert.equal(rejected.ok, false);
      assert.match(rejected.error.message, /目录/);
      const collision = await page.evaluate(
        ({ directory, requestId }) =>
          window.arealDesktop.command("projectless", {
            operation: "prepare",
            directory,
            requestId,
          }),
        { directory: workspace, requestId: randomUUID() },
      );
      assert.equal(collision.ok, false);
      assert.match(collision.error.message, /已有项目/);
      assert.equal(
        (await snapshot()).projects.find((p) => p.id === workspacePid).projectless,
        undefined,
      );
      checks.push(
        "production bridge preserves project directory containment and rejects independent reclassification of an existing project",
      );
      const legacyStart = await call("manage", {
        projectId: workspacePid,
        operation: "taskDraftStart",
        draftId: randomUUID(),
        cwd: taskDirectory,
        timeZone: "Asia/Shanghai",
      });
      await call("manage", {
        projectId: workspacePid,
        operation: "taskDraftSend",
        threadId: legacyStart.threadId,
        text: "旧项目目录验收，明天执行。",
        timeZone: "Asia/Shanghai",
      });
      const legacyProposal = await until(async () => {
        const value = await call("manage", {
          projectId: workspacePid,
          operation: "taskDraftRead",
          threadId: legacyStart.threadId,
        });
        return !value.running && value.proposal && value;
      }, "legacy bound fixture proposal");
      const legacy = await call("manage", {
        projectId: workspacePid,
        operation: "taskDraftConfirm",
        threadId: legacyStart.threadId,
        turnId: legacyProposal.turnId,
        digest: legacyProposal.digest,
      });
      const legacyHistory = await call("manage", {
        projectId: workspacePid,
        operation: "taskDraftHistory",
        taskId: legacy.id,
      });
      assert.equal(legacyHistory.threadId, legacyStart.threadId);
      await page
        .getByRole("button", { name: `打开定时任务 ${legacy.objective}`, exact: true })
        .click();
      await chat.waitFor();
      await page.getByText("旧项目目录验收，明天执行。", { exact: true }).waitFor();
      assert.equal(
        (
          await call("manage", {
            projectId: workspacePid,
            operation: "taskDraftRead",
            threadId: legacyHistory.threadId,
          })
        ).thread.cwd,
        taskDirectory,
      );
      checks.push(
        "existing project-bound task opens its original management Thread, cwd and history",
      );
      await page.getByRole("button", { name: "返回任务列表", exact: true }).click();
      await rmdir(taskDirectory);
      await page.evaluate(
        (key) => localStorage.removeItem(key),
        `areal-gui:task-edit:${workspacePid}:${legacy.id}`,
      );
      await page
        .getByRole("button", { name: `打开定时任务 ${legacy.objective}`, exact: true })
        .click();
      await chat.waitFor();
      await page.getByText("旧项目目录验收，明天执行。", { exact: true }).waitFor();
      assert.equal(
        (
          await call("manage", {
            projectId: workspacePid,
            operation: "taskDraftRead",
            threadId: legacyHistory.threadId,
          })
        ).thread.cwd,
        taskDirectory,
      );
      checks.push(
        "legacy management history remains available when its bound directory is missing",
      );
      await page.getByRole("button", { name: "返回任务列表", exact: true }).click();
      const next = await openLegacyFixture();
      await chat.fill("独立目录验收，定时执行。");
      await page.getByTestId("chat-send-button").click();
      const independent = await until(
        async () =>
          (await call("tasks", { operation: "list" })).data.find((t) =>
            t.objective.startsWith("独立目录验收"),
          ),
        "independent task created",
      );
      assert.equal(independent.scope, "independent");
      assert.equal(independent.projectId, next.owner.id);
      await call("open", { projectId: independent.projectId, threadId: independent.threadId });
      assert.equal(
        (await snapshot()).projects.find((p) => p.id === independent.projectId).state.threads[
          independent.threadId
        ].cwd,
        next.owner.root,
      );
      const executed = await until(async () => {
        const value = await call("manage", {
          projectId: independent.projectId,
          operation: "task",
          taskId: independent.id,
        });
        return value.runs.some((r) => r.status === "completed") && value;
      }, "independent task executes in its automatic directory");
      const executionId = executed.runs.find((r) => r.status === "completed").threadId;
      await call("open", { projectId: independent.projectId, threadId: executionId });
      assert.equal(
        (await snapshot()).projects.find((p) => p.id === independent.projectId).state.threads[
          executionId
        ].cwd,
        next.owner.root,
      );
      await page.screenshot({ path: join(scratch, "independent-task-saved.png") });
      checks.push(
        "global task retains its automatic independent directory for owner, anchor and actual Run",
      );
      for (const entry of [once, legacy, independent])
        assert.equal(
          await page
            .getByRole("button", { name: `打开定时任务 ${entry.objective}`, exact: true })
            .count(),
          1,
        );
      checks.push(
        "global directory shows legacy project-bound tasks and independent tasks together without a workspace filter",
      );
      passed = true;
    } else {
      await send("每天上午九点，稍后安排。");
      const expectedObjective = "检查项目提交和 PR SCHEDULE_FIXTURE_COMPLETE";
      const created = await until(
        async () =>
          (await call("tasks", { operation: "list" })).data.find(
            (t) =>
              t.id === creation.seed.id &&
              t.revision > creation.seed.revision &&
              t.objectiveTruncated === false &&
              t.objectivePreview === expectedObjective,
          ),
        "Agent updates the seeded legacy task",
      );
      assert.equal(created.id, creation.seed.id, "legacy schedule update preserves task identity");
      assert.ok(
        created.revision > creation.seed.revision,
        "existing fixture cannot satisfy the schedule-update wait",
      );
      const taskId = created.id;
      const savedTask = await task(taskId);
      assert.equal(savedTask.id, taskId);
      assert.equal(savedTask.objective, expectedObjective);
      let resources = page.getByRole("button", { name: "任务资源", exact: true });
      assert.equal(
        await page.getByLabel("任务资源面板").isVisible(),
        false,
        "summary is closed initially",
      );
      assert.equal(await page.locator(".task-resource-sidebar").count(), 0, "no fixed sidebar");
      const closedWidth = (await chat.boundingBox()).width;
      await resources.click();
      await page.getByLabel("任务资源面板").waitFor();
      const openWidth = (await chat.boundingBox()).width;
      assert.ok(Math.abs(openWidth - closedWidth) < 1, "popup does not reserve conversation width");
      assert.ok(!(await page.getByLabel("定时任务安排").innerText()).includes("下次："));
      assert.ok(!(await page.getByLabel("定时任务安排").innerText()).includes("本机执行"));
      await resources.click();
      await until(
        async () => !(await page.getByLabel("任务资源面板").isVisible()),
        "same button closes popup",
      );
      await resources.click();
      await page.getByLabel("任务资源面板").waitFor();
      await page.keyboard.press("Escape");
      await until(
        async () => !(await page.getByLabel("任务资源面板").isVisible()),
        "Escape closes popup",
      );
      checks.push(
        "existing task resource Popover: initially closed, click toggles, Escape dismisses, conversation width unchanged, summary omits execution metadata",
      );
      await page.screenshot({ path: join(scratch, "task-detail-closed.png") });
      await page
        .getByText(/^已保存修改。/)
        .last()
        .waitFor();
      const history = await call("manage", {
        projectId: pid,
        operation: "taskDraftHistory",
        taskId,
      });
      const managementThread = history.threadId;
      assert.ok(managementThread);
      assert.equal(
        (
          await call("manage", {
            projectId: pid,
            operation: "taskDraftRead",
            threadId: managementThread,
          })
        ).thread.cwd,
        taskCwd,
      );
      assert.equal(created.scope, "independent");
      await call("open", { projectId: pid, threadId: created.threadId });
      assert.equal(
        (await snapshot()).projects.find((project) => project.id === pid).state.threads[
          created.threadId
        ].cwd,
        taskCwd,
      );
      await send("更新描述，只汇报阻塞项。");
      const updated = await until(async () => {
        const value = await task(taskId);
        return value.objective === "只汇报阻塞项 SCHEDULE_FIXTURE_COMPLETE" && value;
      }, "Agent updated description");
      assert.equal(updated.id, taskId);
      assert.ok(updated.objective.length > 24);
      const expectedSummary = `${updated.objective.slice(0, 24)}…`;
      await resources.click();
      await page.getByLabel("定时任务安排").getByText(expectedSummary, { exact: true }).waitFor();
      assert.equal(
        (await call("manage", { projectId: pid, operation: "taskDraftHistory", taskId })).threadId,
        managementThread,
      );
      const current = await task(taskId),
        scheduleBefore = JSON.stringify(current.schedule);
      await send("不合法的时间修改。");
      await page.getByRole("alert").filter({ hasText: "时间" }).first().waitFor();
      assert.equal(JSON.stringify((await task(taskId)).schedule), scheduleBefore);
      await send("暂停任务。");
      await until(async () => (await task(taskId)).paused, "Agent paused schedule");
      await send("恢复任务。");
      await until(async () => (await task(taskId)).paused === false, "Agent resumed schedule");
      await resources.click();
      await page.getByLabel("任务资源面板").waitFor();
      await until(
        () =>
          page
            .getByLabel("任务资源面板")
            .evaluate(
              (el) =>
                Number(getComputedStyle(el).opacity) > 0.99 &&
                !el.hasAttribute("data-starting-style"),
            ),
        "light popup finished opening",
      );
      await page.screenshot({ path: join(scratch, "task-detail-light.png") });
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await page.getByRole("button", { name: "外观", exact: true }).click();
      await page.getByRole("combobox", { name: "界面主题", exact: true }).click();
      await page.getByRole("option", { name: "深色", exact: true }).click();
      await until(
        () => page.locator("html").evaluate((el) => el.classList.contains("dark")),
        "dark theme",
      );
      await page.getByRole("button", { name: "定时任务", exact: true }).click();
      await resources.click();
      await page.getByLabel("定时任务安排").waitFor();
      await chat.waitFor();
      await until(
        () =>
          page
            .getByLabel("任务资源面板")
            .evaluate(
              (el) =>
                Number(getComputedStyle(el).opacity) > 0.99 &&
                !el.hasAttribute("data-starting-style"),
            ),
        "dark popup finished opening",
      );
      await page.screenshot({ path: join(scratch, "task-detail-dark.png") });
      const bounds = await page.getByTestId("chat-input").boundingBox();
      assert.ok(bounds.width > 300);
      assert.equal(
        await page
          .getByRole("dialog")
          .filter({ has: page.getByLabel("定时任务安排") })
          .count(),
        1,
        "only the shared resource popup is open",
      );
      assert.equal(await page.locator(".task-draft-dialog").count(), 0);
      assert.equal(await page.locator(".messages-shell").count(), 1);
      assert.equal(await page.locator("[data-v4-composer-dock]").count(), 1);
      assert.ok(!(await page.locator(".messages-shell").innerText()).includes('"kind"'));
      checks.push(
        "shared Messages and Composer; no task textarea/dialog; legacy clarification, schedule and description update, failed proposal, pause/resume; same management Thread; light/dark",
      );
      await page.getByRole("button", { name: "返回任务列表", exact: true }).click();
      await page
        .getByRole("button", {
          name: `打开定时任务 ${(await task(taskId)).objective}`,
          exact: true,
        })
        .click();
      await page.getByText("你希望什么时候执行？", { exact: true }).waitFor();
      await chat.waitFor();
      const reopened = await call("manage", {
        projectId: pid,
        operation: "taskDraftHistory",
        taskId,
      });
      assert.equal(reopened.threadId, managementThread);
      assert.equal((await call("tasks", { operation: "list" })).data.length, 1);
      checks.push("navigation restores full creation/modification history without duplicate task");
      const beforeRestartTask = await task(taskId);
      await closeOwnedApp();
      await launch();
      chat = page.getByTestId("chat-input");
      resources = page.getByRole("button", { name: "任务资源", exact: true });
      await page.getByRole("button", { name: "定时任务", exact: true }).click();
      await page
        .getByRole("button", {
          name: `打开定时任务 ${(await task(taskId)).objective}`,
          exact: true,
        })
        .click();
      await chat.waitFor();
      await page.getByText("你希望什么时候执行？", { exact: true }).waitFor();
      assert.equal(
        (await call("manage", { projectId: pid, operation: "taskDraftHistory", taskId })).threadId,
        managementThread,
      );
      assert.equal(
        (
          await call("manage", {
            projectId: pid,
            operation: "taskDraftRead",
            threadId: managementThread,
          })
        ).thread.cwd,
        taskCwd,
      );
      assert.equal((await snapshot()).projects.find((project) => project.id === pid).root, taskCwd);
      assert.equal((await call("tasks", { operation: "list" })).data.length, 1);
      const afterRestartTask = await task(taskId);
      assert.equal(
        afterRestartTask.cancelled,
        false,
        "confirmed application quit preserves the scheduled definition",
      );
      assert.deepEqual(afterRestartTask.schedule, beforeRestartTask.schedule);
      assert.equal(afterRestartTask.objective, beforeRestartTask.objective);
      checks.push(
        "desktop restart restores the same independent owner, management cwd and history without duplicate task",
      );
      const runs = await until(async () => {
        const value = await task(taskId);
        return value.runs.filter((r) => r.status === "completed").length >= 2 && value.runs;
      }, "two independent scheduled runs");
      assert.notEqual(runs[0].threadId, runs[1].threadId);
      assert.notEqual(runs[0].threadId, managementThread);
      for (const run of runs.slice(0, 2)) {
        const execution = await readAuthoritativeThread(run.threadId);
        assert.equal(execution.id, run.threadId);
        assert.equal(execution.cwd, taskCwd);
      }
      checks.push("scheduled runs retain independent execution Threads");
      checks.push(
        "scheduled execution Threads retain the task independent directory after navigation and restart",
      );
      await page.getByRole("button", { name: "返回任务列表", exact: true }).click();
      await page
        .getByRole("button", {
          name: `打开定时任务 ${(await task(taskId)).objective}`,
          exact: true,
        })
        .click();
      await chat.waitFor();
      await until(
        async () =>
          (await snapshot()).projects.find((project) => project.id === pid)?.configurations?.[
            managementThread
          ],
        "reopened management configuration ready before cancellation",
      );
      await send("取消任务。");
      await until(async () => (await task(taskId)).cancelled, "Agent cancelled schedule");
      await resources.click();
      await page
        .getByLabel("定时任务安排")
        .getByRole("status")
        .filter({ hasText: /^已结束$/ })
        .waitFor();
      await page
        .getByRole("button", { name: `打开自动化 ${(await task(taskId)).objective}`, exact: true })
        .getByText("已取消", { exact: true })
        .waitFor();
      assert.ok((await task(taskId)).runs.length >= 2);
      checks.push("Agent cancellation preserves execution history");
      assert.deepEqual(errors, []);
      passed = true;
    }
  }
} catch (error) {
  errors.push(error.stack ?? String(error));
  await writeFile(join(scratch, "failure-error.txt"), error.stack ?? String(error)).catch(() => {});
  if (page && !page.isClosed()) {
    const ownerId = legacySetups.at(-1)?.ownerId;
    if (ownerId) {
      const observe = await withSmokeDeadline("failure task observation", () =>
        page.evaluate(
          (projectId) => window.arealDesktop.command("tasks", { operation: "observe", projectId }),
          ownerId,
        ),
      ).catch((cause) => ({ error: cause.message }));
      const lifecycle = await withSmokeDeadline("failure lifecycle status", () =>
        page.evaluate(() => window.arealDesktop.command("serviceStatus", {})),
      ).catch((cause) => ({ error: cause.message }));
      await writeFile(
        join(scratch, "failure-owner-observation.json"),
        JSON.stringify({ ownerId, observe, lifecycle }, null, 2),
      );
    }
    await snapshot()
      .then((value) =>
        writeFile(join(scratch, "failure-state.json"), JSON.stringify(value, null, 2)),
      )
      .catch(() => {});
    await page
      .locator("body")
      .ariaSnapshot()
      .then((value) => writeFile(join(scratch, "failure.aria.txt"), value))
      .catch(() => {});
    await page.screenshot({ path: join(scratch, "failure.png") }).catch(() => {});
  }
  throw error;
} finally {
  await rm(calendarDropGate, { force: true });
  for (const response of held) response.destroy();
  if (page && !page.isClosed() && pid && !(legacyTargetOnly && !passed)) {
    try {
      const rows = await call("tasks", { operation: "list", limit: 100 });
      for (const entry of rows.data) {
        if (!entry.cancelled)
          await call("manage", {
            projectId: entry.projectId,
            operation: "taskCancel",
            taskId: entry.id,
            expectedRevision: entry.revision,
          }).catch(() => {});
      }
      await until(
        async () => {
          const state = await call("serviceStatus", {});
          if (state.activeCommands) return false;
          if (!state.busy) return true;
          if (!calendarUnknownRequestId) return false;
          const pending = (await snapshot()).projects.flatMap((project) => project.pending ?? []);
          const onlyOriginal =
            pending.length === 1 &&
            pending[0].method === "areal/task/create" &&
            pending[0].params.requestId === calendarUnknownRequestId;
          if (onlyOriginal) manualCleanup.retainedUnknown = calendarUnknownRequestId;
          return onlyOriginal;
        },
        "fixture cleanup permits only the deliberately retained UNKNOWN receipt",
        20000,
      );
      await app.evaluate(({ dialog }) => {
        const old = dialog.showMessageBox;
        dialog.showMessageBox = async (...args) =>
          args.at(-1).message === "退出 AReaL Harness？" ? { response: 1 } : old(...args);
      });
    } catch (error) {
      errors.push(`cleanup: ${error.message}`);
    }
  }
  {
    const metadata = await readFile(join(scratch, "core/service.json"), "utf8")
      .then(JSON.parse)
      .catch(() => null);
    manualCleanup.adapter = metadata && {
      pid: metadata.pid,
      identity: metadata.identity,
      desktopGeneration: metadata.desktopGeneration,
    };
    if (legacyTargetOnly && !passed) {
      if (metadata) {
        try {
          const command = execFileSync("ps", ["-p", String(metadata.pid), "-o", "command="], {
            encoding: "utf8",
          });
          assert.ok(
            command.includes("--areal-core-service"),
            "failed fixture owns the adapter PID",
          );
          process.kill(metadata.pid, "SIGKILL");
          manualCleanup.forcedAdapterExit = true;
        } catch (error) {
          if (error.code !== "ESRCH" && error.status !== 1)
            errors.push("failed fixture adapter cleanup: " + error.message);
        }
      }
      const handle = app?.process();
      if (handle?.exitCode === null && handle.signalCode === null) {
        handle.kill("SIGKILL");
        await until(() => handle.signalCode !== null, "failed fixture Electron exits", 5000);
        manualCleanup.forcedElectronExit = true;
      }
      app = null;
    }
    try {
      if (app && app.process().exitCode === null && app.process().signalCode === null)
        await closeOwnedApp();
    } catch (error) {
      errors.push("manual cleanup: " + error.message);
    }
    if (rust && app) {
      let handle;
      try {
        handle = app.process();
      } catch {
        // Playwright 已释放退出中的应用对象。
      }
      if (handle && handle.exitCode === null && handle.signalCode === null) {
        manualCleanup.forcedElectronExit = true;
        handle.kill("SIGKILL");
        await until(
          () => handle.exitCode !== null || handle.signalCode !== null,
          "owned Electron forced cleanup exit",
          5000,
        );
      }
    }
    if (rust) {
      try {
        const originalHost = await observeHostIdentity();
        const lastHost = manualCleanup.exits.at(-1)?.hostIdentity;
        if (lastHost) assert.deepEqual(originalHost, lastHost, "cleanup targets original Host");
        const stop = JSON.parse(
          execFileSync(binary, ["host", "stop", "--cancel", "--json"], {
            env: { ...env, AREAL_HARNESS_HOME: env.AREAL_HARNESS_SERVICE_HOME },
            encoding: "utf8",
          }),
        );
        await writeFile(join(scratch, "rust-final-stop.json"), JSON.stringify(stop, null, 2));
        assert.equal(stop.state, "completed");
        assert.equal(stop.hostId, originalHost.hostId);
        assert.equal(stop.generation, originalHost.generation);
        assert.ok(stop.projects.every((project) => project.receipt?.state === "completed"));
      } catch (error) {
        errors.push("Host cleanup: " + error.message);
      }
    }
    try {
      await assertApplicationStopped(binary, env, metadata);
      manualCleanup.applicationStopped = true;
    } catch (error) {
      errors.push("manual cleanup: " + error.message);
    }
    if (!rust && metadata && !manualCleanup.applicationStopped) {
      manualCleanup.assistedServiceStop = true;
      const { ServiceConnection, waitForServiceProcessExit } = require(
        join(import.meta.dirname, "support/desktop-service-fixture.cjs"),
      );
      const connection = new ServiceConnection();
      try {
        await connection.connect(metadata);
        const packet = await connection.request("hello", {
          protocol: metadata.protocol,
          identity: metadata.identity,
        });
        await connection
          .request(
            "stopService",
            {
              protocol: metadata.protocol,
              cancel: true,
              expectedDesktopGeneration: metadata.desktopGeneration,
              expectedTargets: packet.service.targets,
            },
            true,
          )
          .catch((error) => {
            if (!error.message.includes("已请求退出")) throw error;
          });
        await waitForServiceProcessExit(join(scratch, "core"), metadata);
        manualCleanup.desktopExited = true;
      } catch (error) {
        if (!["ENOENT", "ECONNREFUSED", "ESRCH"].includes(error.code))
          errors.push("fallback stop service: " + error.message);
      } finally {
        connection.close();
      }
    }
    if (!rust && app) {
      let handle;
      try {
        handle = app.process();
      } catch {
        // Playwright 已释放退出中的应用对象。
      }
      if (handle && handle.exitCode === null && handle.signalCode === null) {
        manualCleanup.forcedElectronExit = true;
        handle.kill("SIGKILL");
        await until(
          () => handle.exitCode !== null || handle.signalCode !== null,
          "owned Electron forced cleanup exit",
          5000,
        );
      }
    }
    try {
      manualCleanup.instances = JSON.parse(
        execFileSync(binary, ["service", "list", "--json"], { env, encoding: "utf8" }),
      ).map(({ serviceId, workspace, state, hostPid, corePid }) => ({
        serviceId,
        workspace,
        state,
        hostPid,
        corePid,
      }));
      assert.ok(
        manualCleanup.instances.every((instance) => instance.state === "stopped"),
        "owned Core instance remains live",
      );
    } catch (error) {
      errors.push("verify owned Core cleanup: " + error.message);
    }
    manualCleanup.mainErrors = calendarRegression
      ? (await readFile(calendarMainErrors, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
    for (const error of manualCleanup.mainErrors)
      errors.push("uncaught Main " + error.origin + ": " + error.message);
    await writeFile(join(scratch, "manual-cleanup.json"), JSON.stringify(manualCleanup, null, 2));
    if (errors.length) {
      passed = false;
      process.exitCode = 1;
    }
  }
  if (rust) {
    try {
      const entries = await cleanupSyntheticHostKeychain(env.AREAL_HARNESS_SERVICE_HOME, scratch);
      await writeFile(
        join(scratch, "synthetic-keychain-cleanup.json"),
        JSON.stringify(entries, null, 2),
      );
    } catch (error) {
      errors.push(`synthetic Keychain cleanup: ${error.message}`);
      passed = false;
      process.exitCode = 1;
    }
  }
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  await writeFile(join(scratch, "catalog-events.json"), JSON.stringify(catalogEvents, null, 2));
  await writeFile(
    join(scratch, "evidence.json"),
    JSON.stringify(
      {
        passed,
        binary,
        binarySha256,
        checks,
        errors,
        modelRequests: modelRequests.length,
      },
      null,
      2,
    ),
  );
  await writeFile(join(scratch, "model-requests.json"), JSON.stringify(modelRequests, null, 2));
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
        checks,
        errors,
        legacySetups,
        boundaries: [
          "real isolated Electron, preload, Desktop adapter and Core",
          "synthetic local model replies",
          "native directory dialog result is stubbed",
          "existing legacy Task seeded through supported bridge; subsequent editing uses real UI",
          "calendar UNKNOWN create uses explicit legacy bridge confirm plus real catalog navigation; no removed creation-UI claim",
          "new global ordinary creation is covered separately by thread-schedules-smoke",
          "not installed app or real provider",
        ],
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed, scratch, checks, errors }));
}
