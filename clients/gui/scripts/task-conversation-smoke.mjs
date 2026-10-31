import { makeTempDir } from "./support/temp.mjs";
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
import { assertApplicationStopped, closeSmokeApplication } from "./application-cleanup.mjs";
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
const legacyTargetOnly = process.argv.includes("--legacy-target-only");
const calendarRegression = process.env.AREAL_TASK_CALENDAR_REGRESSION === "1";
const calendarDropGate = join(scratch, "calendar-drop-response"),
  calendarTrace = join(scratch, "calendar-create-requests.jsonl"),
  calendarReceiptTrace = join(scratch, "calendar-receipt-unavailable.jsonl");
const manualRegression = process.env.AREAL_TASK_MANUAL_REGRESSION === "1";
const manualDropGate = join(scratch, "drop-manual-response"),
  manualTrace = join(scratch, "manual-requests.jsonl");
const manualPrepareGate = join(scratch, "hold-manual-prepare"),
  manualPrepareTrace = join(scratch, "manual-prepares.jsonl");
const manualMainErrors = join(scratch, "manual-main-errors.jsonl");
const manualCleanup = { exits: [] };
let calendarUnknownRequestId;
const manualObjective = "立即运行验收 MANUAL_FIXTURE";
const manualRuns = new Map();
const loadingRegression = process.env.AREAL_TASK_LOADING_REGRESSION === "1";
const creationRegression = process.env.AREAL_TASK_CREATION_REGRESSION;
const creationGate = join(scratch, "hold-task-prepare");
const dailyStartRegression = process.env.AREAL_TASK_DAILY_START_REGRESSION === "1";
const inlineRegression = process.env.AREAL_TASK_INLINE_REGRESSION === "1";
assert.ok(
  !inlineRegression ||
    (!loadingRegression &&
      !dailyStartRegression &&
      process.env.AREAL_TASK_SCHEDULE_REGRESSION !== "1"),
  "run inline regression separately from other task scenarios",
);
const inlineObjective = "定时执行内联验收 INLINE_CONVERSATION";
const inlineRuns = new Map();
const inlineLongToken = "INLINE_LONG_CONTENT_" + "0123456789abcdef".repeat(160);
const inlineLongMarkdown = `执行过程包含需要正常换行的长段落。${"检查任务输出与主会话阅读列保持一致。".repeat(35)}\n\n内联代码 \`${inlineLongToken}\`\n\n\`\`\`sh\nprintf '%s\\n' '${inlineLongToken}'\n\`\`\``;
const dailyClock = join(scratch, "daily-clock");
const loadingRpcGate = join(scratch, "hold-catalog-page");
const loadingPollDelay = join(scratch, "delay-catalog-poll");
const loadingGate = join(scratch, "hold-project"),
  loadingTrace = join(scratch, "loading-trace.log"),
  prepareFailureGate = join(scratch, "fail-projectless-prepare");
const watchGates = [];
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
const regressionFailures = [];
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
      if (manualRegression && requestText.includes("立即运行验收")) {
        finish(
          JSON.stringify({
            kind: "proposal",
            message: "将保存手动验证任务。",
            objective: manualObjective,
            interactionMode: "interactive",
            dailyStart: { kind: "explicit", source: "后天的这个时间开始" },
            schedule: { at: changedAnchor, intervalSeconds: 86400 },
          }),
        );
        return;
      }
      if (requestText.includes("创建体验验收")) {
        finish(
          JSON.stringify({
            kind: "proposal",
            message: "将保存安排。",
            objective: requestText,
            interactionMode: "interactive",
            schedule: { at: changedAnchor },
          }),
        );
        return;
      }
      if (inlineRegression && requestText.includes("定时执行内联验收")) {
        finish(
          JSON.stringify({
            kind: "proposal",
            message: "将创建内联执行验收任务。",
            objective: inlineObjective,
            interactionMode: "interactive",
            schedule: {
              at: new Date(Date.now() + 6000).toISOString().replace(/\.\d{3}Z$/, "Z"),
              intervalSeconds: 12,
            },
          }),
        );
        return;
      }
      if (requestText.includes("每日起点验收") || requestText.includes("沿用刚才日期")) {
        if (requestText.includes("先确认开始日期")) {
          finish(JSON.stringify({ kind: "question", message: "每天几点问好？" }));
          return;
        }
        const explicit = messages.some((m) => m.role === "user" && text(m).includes("从明天开始"));
        const at = requestText.includes("春季跳时")
          ? "2027-03-15T02:30:00"
          : requestText.includes("秋季重复")
            ? "2027-11-08T01:30:00"
            : "2040-04-02T10:10:00";
        const dailyStart = requestText.includes("意图缺失")
          ? undefined
          : requestText.includes("来源伪造")
            ? { kind: "explicit", source: "用户从未提供的开始日" }
            : explicit
              ? { kind: "explicit", source: "从明天开始" }
              : { kind: "nearest" };
        finish(
          JSON.stringify({
            kind: "proposal",
            message: "将保存每日问候。",
            objective: requestText,
            interactionMode: "interactive",
            dailyStart,
            schedule: { at, intervalSeconds: 86400 },
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
    if (manualRegression && goal.objective === manualObjective) {
      if (goal.report?.status === "complete") {
        finish("MANUAL_FIXTURE_DONE");
        return;
      }
      const entry = {
        connected: () => !response.destroyed && !response.writableEnded,
        release: () => {
          assert.ok(!response.destroyed, "manual fixture stream remains connected");
          held.delete(response);
          tool("goal_update", {
            expectedRevision: goalView.revision,
            status: "complete",
            summary: "MANUAL_FIXTURE_REPORT",
            evidence: ["Manual execution requested by the saved Task button."],
            remaining: [],
          });
        },
      };
      manualRuns.set(goal.id, entry);
      send({ content: "MANUAL_FIXTURE_RUNNING" });
      held.add(response);
      response.on("close", () => held.delete(response));
      return;
    }
    if (inlineRegression && goal.objective === inlineObjective) {
      let run = inlineRuns.get(goal.id);
      if (!run) {
        const index = inlineRuns.size + 1;
        run = {
          index,
          progress: `第 ${index} 次执行中：INLINE_PROGRESS_${index}。`,
          final: `第 ${index} 次执行完成：INLINE_FINAL_${index}。`,
          release: null,
        };
        inlineRuns.set(goal.id, run);
        send({ content: run.progress + "\n\n" + inlineLongMarkdown });
        held.add(response);
        response.on("close", () => held.delete(response));
        // 由断言释放流，避免固定延迟让慢机器只能看到完成后的结果。
        run.release = () => {
          assert.ok(!response.destroyed, "inline fixture stream remains connected");
          held.delete(response);
          tool("run_command", {
            argv: ["printf", "%s\n", inlineLongToken],
            cwd: "workspace://repo",
            timeoutMs: 5000,
          });
        };
        return;
      }
      if (goal.report?.status !== "complete") {
        tool("goal_update", {
          expectedRevision: goalView.revision,
          status: "complete",
          summary: `INLINE_REPORT_${run.index}`,
          evidence: ["内联执行中间响应与真实长命令已由界面验收。"],
          remaining: [],
        });
        return;
      }
      finish(run.final);
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
if (creationRegression) {
  const file = join(userHome, ".areal/config.toml");
  await writeFile(
    file,
    (await readFile(file, "utf8")).replace(
      "[permissions]",
      'models=[{id="fixture",enabled=true},{id="gpt-6.1-sol",enabled=true},{id="gpt-6-sol",enabled=true}]\n[permissions]',
    ),
  );
}
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
  passed = false;
async function until(fn, label, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw Error(`Timeout: ${label}`);
}
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
  await page.getByRole("button", { name: `打开自动化 ${seed.objective}`, exact: true }).click();
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
  await page.getByRole("button", { name: "关闭任务详情", exact: true }).click();
  await page
    .getByRole("button", { name: `打开自动化 ${creation.seed.objective}`, exact: true })
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
      .getByRole("button", { name: `打开自动化 ${creation.seed.objective}`, exact: true })
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
async function assertGlobalCreation() {
  const main = page.getByRole("main", { name: "新建定时任务", exact: true });
  await main.waitFor();
  assert.equal(
    await main.getByLabel("任务归属", { exact: true }).count(),
    0,
    "new task has no project affiliation selector",
  );
  assert.equal(
    await main.getByLabel("工作目录", { exact: true }).count(),
    0,
    "new task has no working directory field",
  );
  assert.equal(
    await main.getByRole("button", { name: "开始配置", exact: true }).count(),
    0,
    "new task requires no start-configuration gate",
  );
  assert.equal(await main.locator(".task-plan-summary").count(), 0);
  const chat = page.getByTestId("chat-input");
  await chat.waitFor();
  const saved = await until(async () => {
    const draft = await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)),
      `areal-gui:task-draft:${workspacePid}`,
    );
    return draft?.threadId && draft.ownerId && draft;
  }, "authoritative independent management admission ready");
  await until(() => chat.isEditable(), "automatic independent configuration Composer ready");
  const owner = (await snapshot()).projects.find((project) => project.id === saved.ownerId);
  assert.equal(owner.projectless, true);
  assert.notEqual(owner.id, workspacePid);
  assert.notEqual(owner.root, workspace);
  assert.notEqual(owner.root, taskDirectory);
  const draft = await call("manage", {
    projectId: owner.id,
    operation: "taskDraftRead",
    threadId: saved.threadId,
  });
  assert.equal(draft.thread.cwd, owner.root);
  return { saved, owner, draft };
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
if (loadingRegression || creationRegression) {
  launchApp = join(scratch, "app");
  await mkdir(launchApp);
  await writeFile(
    join(launchApp, "package.json"),
    JSON.stringify({ name: "task-loading-fixture", main: "bootstrap.cjs" }),
  );
  await writeFile(
    join(launchApp, "bootstrap.cjs"),
    `
const {CoreBackend}=require(${JSON.stringify(join(gui, "app/src/core/backend.cjs"))});
const {existsSync,appendFileSync,unlinkSync}=require('node:fs');
const {join}=require('node:path');
const start=CoreBackend.prototype.start, readConnection=CoreBackend.prototype.readConnection, execute=CoreBackend.prototype.executeCommand;
async function holdProject(project){
 if(project?.root.endsWith('slow-workspace')&&existsSync(${JSON.stringify(loadingGate)})){
  appendFileSync(${JSON.stringify(loadingTrace)},'project pending\\n');
  while(existsSync(${JSON.stringify(loadingGate)}))await new Promise(resolve=>setTimeout(resolve,50));
 }
}
function instrumentProject(value,project){
 if(${JSON.stringify(loadingRegression)}&&!value.loadingFixture){
  value.loadingFixture=true;
  const setTask=value.model.setTask.bind(value.model);
  value.model.setTask=task=>{if(!/^(READY_TASK_|DELAYED_OWNER_TASK)/.test(task.objective))setTask(task);};
 }
 if(${JSON.stringify(loadingRegression)}&&project?.root.endsWith('slow-workspace')&&!value.client.loadingFixture){
  value.client.loadingFixture=true;
  const request=value.client.request.bind(value.client);
  value.client.request=async(method,params)=>{
   if(method==='areal/task/list'&&params.limit===30&&existsSync(${JSON.stringify(loadingRpcGate)})){
    appendFileSync(${JSON.stringify(loadingTrace)},'catalog page '+(params.after||'first')+'\\n');
    if(!params.after){const page=await request(method,params);return {...page,nextCursor:'fixture-second'};}
    while(existsSync(${JSON.stringify(loadingRpcGate)}))await new Promise(resolve=>setTimeout(resolve,25));
    appendFileSync(${JSON.stringify(loadingTrace)},'catalog page released\\n');
    const page=await request(method,{limit:30});
    return {...page,data:page.data.map(row=>({...row,objective:'LATE_CATALOG_TASK'}))};
   }
   if(method==='areal/task/list'&&params.limit===30&&existsSync(${JSON.stringify(loadingPollDelay)})){
    appendFileSync(${JSON.stringify(loadingTrace)},'catalog poll pending\\n');
    const page=await request(method,params);
    await new Promise(resolve=>setTimeout(resolve,700));
    appendFileSync(${JSON.stringify(loadingTrace)},'catalog poll returned\\n');
    return page;
   }
   return request(method,params);
  };
 }
 return value;
}
CoreBackend.prototype.start=async function(id){
 const project=this.saved.find(project=>project.id===id);
 await holdProject(project);
 return instrumentProject(await start.call(this,id),project);
};
CoreBackend.prototype.readConnection=async function(id,signal){
 const project=this.saved.find(project=>project.id===id);
 await holdProject(project);
 const connection=await readConnection.call(this,id,signal);
 instrumentProject(connection.project,project);
 return connection;
};
CoreBackend.prototype.executeCommand=async function(name,request,context){
 if(name==='projectless'&&request.operation==='prepare'){
  appendFileSync(${JSON.stringify(loadingTrace)},'projectless prepare '+request.requestId+'\\n');
  if(existsSync(${JSON.stringify(creationGate)})){
   appendFileSync(${JSON.stringify(loadingTrace)},'creation prepare pending\\n');
   while(existsSync(${JSON.stringify(creationGate)}))await new Promise(resolve=>setTimeout(resolve,25));
  }
  if(existsSync(${JSON.stringify(prepareFailureGate)})){
   unlinkSync(${JSON.stringify(prepareFailureGate)});
   throw new Error('独立任务初始化验收失败，请重试。');
  }
 }
 if(name==='manage'&&request.operation==='taskDraftStart')appendFileSync(${JSON.stringify(loadingTrace)},'draft start '+request.projectId+' '+request.draftId+'\\n');
 const result=await execute.call(this,name,request,context);
 if(name==='manage'&&request.operation==='taskDraftRead'&&result.thread)appendFileSync(${JSON.stringify(loadingTrace)},'creation thread ready\\n');
 if(name==='manage'&&request.operation==='taskWatch'){
  const gate=join(${JSON.stringify(scratch)},'watch-'+request.taskId);
  if(existsSync(gate)){
   appendFileSync(${JSON.stringify(loadingTrace)},'watch pending '+request.taskId+'\\n');
   while(existsSync(gate))await new Promise(resolve=>setTimeout(resolve,50));
   appendFileSync(${JSON.stringify(loadingTrace)},'watch returned '+request.taskId+'\\n');
  }
 }
 return result;
};
require(${JSON.stringify(join(gui, "app/src/main.cjs"))});
`,
  );
}
if (manualRegression || calendarRegression) {
  await writeFile(manualMainErrors, "");
  launchApp = join(scratch, "manual-app");
  await mkdir(launchApp);
  await writeFile(
    join(launchApp, "package.json"),
    JSON.stringify({ name: "manual-run-fixture", main: "bootstrap.cjs" }),
  );
  await writeFile(
    join(launchApp, "bootstrap.cjs"),
    `
process.on('uncaughtExceptionMonitor',(error,origin)=>require('node:fs').appendFileSync(${JSON.stringify(manualMainErrors)},JSON.stringify({pid:process.pid,origin,name:error.name,message:error.message,stack:error.stack})+'\\n'));
const {CoreBackend}=require(${JSON.stringify(join(gui, "app/src/core/backend.cjs"))});
const fs=require('node:fs');
const connect=CoreBackend.prototype.connect;
CoreBackend.prototype.connect=async function(...args){
 const {CoreClient}=await import(${JSON.stringify(join(gui, "packages/runtime-client/core.js"))});
 if(!CoreClient.prototype.manualFixture){
  CoreClient.prototype.manualFixture=true;
  const clientConnect=CoreClient.prototype.connect;
  CoreClient.prototype.connect=async function(){
  const serverRequest=this.onServerRequest;
  this.onServerRequest=async(method,params,context)=>{
   if(method==='areal/task/prepare'&&fs.existsSync(${JSON.stringify(manualPrepareGate)})){
    fs.appendFileSync(${JSON.stringify(manualPrepareTrace)},JSON.stringify(params)+'\\n');
    while(fs.existsSync(${JSON.stringify(manualPrepareGate)})&&!context.signal.aborted)await new Promise(resolve=>setTimeout(resolve,25));
   }
   return serverRequest(method,params,context);
  };
  const request=this.request.bind(this);
  this.request=async(method,params,options)=>{
   if(method==='areal/task/create'&&params.objective==='日历重试验收')fs.appendFileSync(${JSON.stringify(calendarTrace)},JSON.stringify(params)+'\\n');
   if(method==='areal/task/runNow')fs.appendFileSync(${JSON.stringify(manualTrace)},JSON.stringify(params)+'\\n');
   if(method==='areal/request/read'&&fs.existsSync(${JSON.stringify(manualDropGate)})){
    const original=fs.readFileSync(${JSON.stringify(manualTrace)},'utf8').trim().split(String.fromCharCode(10)).filter(Boolean).map(line=>JSON.parse(line));
    if(params.taskId||original.some(entry=>entry.requestId===params.requestId))throw new Error('receipt read fixture unavailable');
   }
   if(method==='areal/request/read'&&fs.existsSync(${JSON.stringify(calendarDropGate)})&&fs.existsSync(${JSON.stringify(calendarTrace)})){
    const original=fs.readFileSync(${JSON.stringify(calendarTrace)},'utf8').trim().split(String.fromCharCode(10)).filter(Boolean).map(line=>JSON.parse(line));
    if(original.some(entry=>entry.requestId===params.requestId)){fs.appendFileSync(${JSON.stringify(calendarReceiptTrace)},JSON.stringify(params)+'\\n');throw new Error('original calendar receipt fixture unavailable');}
   }
   const result=await request(method,params,options);
   if(method==='areal/task/create'&&params.objective==='日历重试验收'&&fs.existsSync(${JSON.stringify(calendarDropGate)}))throw Object.assign(new Error('calendar accepted response dropped'),{submissionUnknown:true});
   if(method==='areal/task/runNow'&&fs.existsSync(${JSON.stringify(manualDropGate)}))throw Object.assign(new Error('accepted response fixture dropped'),{submissionUnknown:true});
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
if (dailyStartRegression) {
  await writeFile(dailyClock, String(Date.parse("2040-04-01T10:08:00+08:00")));
  launchApp = join(scratch, "daily-app");
  await mkdir(launchApp);
  await writeFile(
    join(launchApp, "package.json"),
    JSON.stringify({ name: "daily-start-fixture", main: "bootstrap.cjs" }),
  );
  await writeFile(
    join(launchApp, "bootstrap.cjs"),
    `
const Module=require('node:module'),fs=require('node:fs');
const target=${JSON.stringify(join(gui, "app/src/core/task-draft.cjs"))};
const compile=Module._extensions['.cjs']??Module._extensions['.js'];
Module._extensions['.cjs']=function(module,file){
 if(file!==target)return compile(module,file);
 const source=fs.readFileSync(file,'utf8');
 const clock=${JSON.stringify(dailyClock)};
 module._compile('const Date=class extends globalThis.Date { constructor(...args){super(...(args.length?args:[Number(require("node:fs").readFileSync('+JSON.stringify(clock)+',"utf8"))]));} static now(){return Number(require("node:fs").readFileSync('+JSON.stringify(clock)+',"utf8"));} };\\n'+source,file);
};
const {CoreBackend}=require(${JSON.stringify(join(gui, "app/src/core/backend.cjs"))});
const execute=CoreBackend.prototype.executeCommand;
CoreBackend.prototype.executeCommand=async function(name,request,context){
 const measured=name==='projectless'&&request.operation==='prepare'||name==='manage'&&['taskDraftStart','taskDraftConfirm'].includes(request.operation);
 const start=performance.now();let ok=false;
 try{const result=await execute.call(this,name,request,context);ok=true;return result;}
 finally{if(measured)fs.appendFileSync(${JSON.stringify(join(scratch, "command-timings.jsonl"))},JSON.stringify({name,operation:request.operation,elapsedMs:performance.now()-start,ok})+'\\n');}
};
require(${JSON.stringify(join(gui, "app/src/main.cjs"))});
`,
  );
}
async function checkDailyStartRegression() {
  const timezone = await page.context().newCDPSession(page);
  await page.getByRole("button", { name: "定时任务", exact: true }).click();
  const cases = [
    {
      name: "今天时间未到",
      clock: "2040-04-01T10:08:00+08:00",
      message: "每日起点验收，每天早上10:10给我问好。",
      expected: "2040-04-01T10:10:00+08:00",
    },
    {
      name: "今天时间已过",
      clock: "2040-04-01T10:12:00+08:00",
      message: "每日起点验收，每天早上10:10给我问好。",
      expected: "2040-04-02T10:10:00+08:00",
    },
    {
      name: "今天恰好到点",
      clock: "2040-04-01T10:10:00+08:00",
      message: "每日起点验收，每天早上10:10给我问好。",
      expected: "2040-04-02T10:10:00+08:00",
    },
    {
      name: "明确明天开始",
      clock: "2040-04-01T10:08:00+08:00",
      message: "每日起点验收，从明天开始，每天早上10:10给我问好。",
      expected: "2040-04-02T10:10:00+08:00",
    },
    {
      name: "明确明天后补时刻",
      clock: "2040-04-01T10:08:00+08:00",
      question: "每日起点验收，从明天开始每天给我问好，先确认开始日期。",
      message: "10:10，沿用刚才日期。",
      expected: "2040-04-02T10:10:00+08:00",
    },
    {
      name: "任务内容中的明天",
      clock: "2040-04-01T10:08:00+08:00",
      message: "每日起点验收，每天早上10:10总结明天的计划。",
      expected: "2040-04-01T10:10:00+08:00",
    },
    {
      name: "春季跳时后",
      zone: "America/New_York",
      clock: "2027-03-14T04:00:00-04:00",
      message: "每日起点验收，春季跳时，每天02:30问好。",
      expected: "2027-03-15T02:30:00-04:00",
    },
    {
      name: "秋季重复时刻",
      zone: "America/New_York",
      clock: "2027-11-07T01:45:00-04:00",
      message: "每日起点验收，秋季重复，每天01:30问好。",
      expected: "2027-11-07T01:30:00-05:00",
    },
    {
      name: "旧提案意图缺失",
      clock: "2040-04-01T10:08:00+08:00",
      message: "每日起点验收，意图缺失，每天10:10问好。",
      reject: "每日任务缺少有效的首次日期说明",
    },
    {
      name: "开始日期来源伪造",
      clock: "2040-04-01T10:08:00+08:00",
      message: "每日起点验收，来源伪造，每天10:10问好。",
      reject: "每日任务的首次日期缺少你的原文说明",
    },
  ];
  const results = [];
  for (const entry of cases) {
    await timezone.send("Emulation.setTimezoneOverride", {
      timezoneId: entry.zone ?? "Asia/Shanghai",
    });
    await writeFile(dailyClock, String(Date.parse(entry.clock)));
    const openStarted = performance.now();
    await page.getByRole("button", { name: "新建定时任务", exact: true }).click();
    const creation = await assertGlobalCreation();
    pid = creation.owner.id;
    const openElapsedMs = performance.now() - openStarted;
    if (entry.question) {
      await page.getByTestId("chat-input").fill(entry.question);
      await page.getByTestId("chat-send-button").click();
      await page.getByText("每天几点问好？", { exact: true }).waitFor();
    }
    await page.getByTestId("chat-input").fill(entry.message);
    await page.getByTestId("chat-send-button").click();
    if (entry.reject) {
      await page.getByRole("alert").filter({ hasText: entry.reject }).first().waitFor();
      assert.equal(
        (await call("tasks", { operation: "list" })).data.some((t) => t.projectId === pid),
        false,
        entry.name + " must not create a task",
      );
      checks.push("daily start rejects " + entry.name);
      await page.getByRole("button", { name: "关闭创建对话", exact: true }).click();
      continue;
    }
    const created = await until(
      async () =>
        (await call("tasks", { operation: "list" })).data.find((t) => t.projectId === pid),
      "daily task persists",
    );
    results.push({ ...entry, openElapsedMs, saved: created });
    await writeFile(join(scratch, "daily-start-results.json"), JSON.stringify(results, null, 2));
    assert.equal(created.schedule.at, Date.parse(entry.expected) / 1000, entry.name);
    assert.equal(
      created.nextRunAt,
      Date.parse(entry.expected) / 1000,
      entry.name + " authoritative nextRunAt",
    );
    assert.equal(created.schedule.intervalSeconds, 86400);
    assert.equal(created.schedule.timeZone, entry.zone ?? "Asia/Shanghai");
    await page
      .getByText(/^已创建任务。/)
      .last()
      .waitFor();
    await page.screenshot({ path: join(scratch, "daily-" + results.length + ".png") });
    checks.push("daily start " + entry.name + " saves " + entry.expected);
    await page.getByRole("button", { name: "关闭任务详情", exact: true }).click();
  }
  assert.deepEqual(errors, []);
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
  await page.getByRole("button", { name: "关闭任务详情", exact: true }).click();
  await page.getByText("日历验收 SCHEDULE_FIXTURE_COMPLETE", { exact: true }).first().click();
  await page.getByLabel("后续执行预览", { exact: true }).waitFor();
  assert.equal(
    (await call("manage", { projectId: pid, operation: "taskDraftHistory", taskId: created.id }))
      .threadId,
    history.threadId,
  );
  await page.getByRole("button", { name: "关闭任务详情", exact: true }).click();
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
  await page.getByRole("button", { name: "打开自动化 日历错过验收 HOLD", exact: true }).click();
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
  await page.getByRole("button", { name: "关闭任务详情", exact: true }).click();
  const activeRow = page.getByRole("button", { name: "打开自动化 日历错过验收 HOLD", exact: true });
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
  await page.getByRole("button", { name: "打开自动化 日历重试验收", exact: true }).click();
  await page.screenshot({ path: join(scratch, "calendar-unknown.png") });
  await page.getByRole("button", { name: "关闭任务详情", exact: true }).click();
  await page.getByRole("button", { name: "打开自动化 日历重试验收", exact: true }).click();
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
async function checkCreationRegression() {
  const admitted = await call("create", {
    projectId: workspacePid,
    model: { providerId: "fixture", modelId: "gpt-6.1-sol" },
    parameters: { reasoningEffort: "none" },
  });
  await call("send", {
    projectId: workspacePid,
    threadId: admitted.threadId,
    text: "ORDINARY_TASK_MODEL 第一模型",
  });
  await until(
    async () =>
      (await snapshot()).projects
        .find((p) => p.id === workspacePid)
        .state.threads[admitted.threadId].turns.at(-1)?.status === "completed",
    "ordinary model selection admitted",
  );
  const remembered = (await snapshot()).projects.find(
    (p) => p.id === workspacePid,
  ).lastAcceptedModel;
  assert.equal(remembered.modelId, "gpt-6.1-sol");
  assert.equal(remembered.reasoningEffort, "none");
  await page.getByRole("button", { name: "定时任务", exact: true }).click();
  if (creationRegression !== "model") await writeFile(creationGate, "hold");
  const openStart = performance.now();
  await page.getByRole("button", { name: "新建定时任务", exact: true }).click();
  const chat = page.getByTestId("chat-input");
  let draftText = "创建体验验收，明天早上问好，保留中文草稿。";
  let inputReadyMs;
  if (creationRegression !== "model") {
    await until(
      async () => (await readFile(loadingTrace, "utf8")).includes("creation prepare pending"),
      "independent preparation held",
    );
    assert.equal(
      await chat.count(),
      1,
      "new task input must render before independent Core preparation completes",
    );
    assert.equal(await chat.isEditable(), true, "new task input is editable while Core prepares");
    inputReadyMs = performance.now() - openStart;
    await chat.fill(draftText);
    await page.screenshot({ path: join(scratch, "creation-preparing.png") });
    assert.equal(
      await page.getByTestId("chat-send-button").isDisabled(),
      true,
      "no submission before real management Thread exists",
    );
    assert.equal((await call("tasks", { operation: "list" })).data.length, 0);
    const savedBefore = await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)),
      `areal-gui:task-draft:${workspacePid}`,
    );
    await page.getByRole("button", { name: "关闭创建对话", exact: true }).click();
    await page.getByRole("button", { name: "新建定时任务", exact: true }).click();
    await until(
      async () => (await chat.textContent()).trim() === draftText,
      "closing and reopening retains preparing text",
    );
    assert.equal(
      await page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key)).draftId,
        `areal-gui:task-draft:${workspacePid}`,
      ),
      savedBefore.draftId,
    );
    await chat.focus();
    await chat.press("End");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.debugger.attach("1.3"),
    );
    const ime = (method, params) =>
      app.evaluate(
        async ({ BrowserWindow }, { method, params }) =>
          BrowserWindow.getAllWindows()[0].webContents.debugger.sendCommand(method, params),
        { method, params },
      );
    const preparingInput = await chat.elementHandle();
    try {
      await ime("Input.imeSetComposition", { text: "你好", selectionStart: 2, selectionEnd: 2 });
      await until(
        async () => (await chat.textContent()).includes("你好"),
        "Chromium composition candidate visible",
      );
      await rm(creationGate);
      await until(
        async () => (await readFile(loadingTrace, "utf8")).includes("creation thread ready"),
        "real management read returns during composition",
      );
      assert.equal(
        await preparingInput.evaluate((el) => el.isConnected),
        true,
        "active composition editor is retained until candidate commit",
      );
      await ime("Input.insertText", { text: "你好" });
      draftText += "你好";
    } finally {
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.debugger.detach(),
      );
    }
    checks.push(
      "preparing draft survives close/reopen and Chromium composition commit across authoritative Thread readiness",
    );
  }
  const creation = await assertGlobalCreation();
  pid = creation.owner.id;
  await until(
    async () => !(await page.getByTestId("chat-send-button").isDisabled()),
    "real management Composer handoff enables send",
  );
  const configuration = creation.draft.thread.desktop.configuration;
  await writeFile(
    join(scratch, "creation-result.json"),
    JSON.stringify(
      { inputReadyMs, preparedMs: performance.now() - openStart, remembered, configuration },
      null,
      2,
    ),
  );
  assert.deepEqual(
    configuration.model,
    { providerId: "fixture", modelId: "gpt-6.1-sol" },
    "new management inherits the last admitted ordinary model",
  );
  assert.equal(
    configuration.parameters.reasoningEffort,
    "none",
    "new management inherits explicit none effort",
  );
  if (creationRegression !== "model")
    assert.equal(
      (await chat.textContent()).trim(),
      draftText,
      "typed text survives preparation and editor handoff",
    );
  else await chat.fill(draftText);
  await page.getByTestId("chat-send-button").click();
  const created = await until(
    async () => (await call("tasks", { operation: "list" })).data.find((t) => t.projectId === pid),
    "task saved through inherited model",
  );
  const request = modelRequests.find((body) =>
    (body.messages ?? []).some((m) => text(m).includes("AREAL_TASK_DRAFT")),
  );
  assert.equal(request.model, "gpt-6.1-sol");
  assert.equal(request.reasoning_effort, "none");
  assert.deepEqual(
    (await snapshot()).projects.find((p) => p.id === workspacePid).lastAcceptedModel,
    remembered,
    "management submission does not overwrite ordinary model preference",
  );
  checks.push(
    "new scheduled management inherits last admitted model and explicit none; actual model request matches",
  );
  if (inputReadyMs !== undefined)
    checks.push(
      "editable local draft survives held independent preparation and real Composer handoff",
    );
  const history = await call("manage", {
    projectId: pid,
    operation: "taskDraftHistory",
    taskId: created.id,
  });
  const newer = await call("create", {
    projectId: workspacePid,
    model: { providerId: "fixture", modelId: "gpt-6-sol" },
    parameters: { reasoningEffort: "high" },
  });
  await call("send", {
    projectId: workspacePid,
    threadId: newer.threadId,
    text: "ORDINARY_TASK_MODEL 第二模型",
  });
  await until(
    async () =>
      (await snapshot()).projects.find((p) => p.id === workspacePid).lastAcceptedModel?.modelId ===
      "gpt-6-sol",
    "newer ordinary preference admitted",
  );
  await page.getByRole("button", { name: "关闭任务详情", exact: true }).click();
  await page.getByRole("button", { name: `打开自动化 ${created.objective}`, exact: true }).click();
  await chat.waitFor();
  const reopened = await call("manage", {
    projectId: pid,
    operation: "taskDraftRead",
    threadId: history.threadId,
  });
  assert.equal(
    reopened.thread.desktop.configuration.model.modelId,
    "gpt-6.1-sol",
    "reopening does not overwrite existing management selection",
  );
  assert.equal(reopened.thread.desktop.configuration.parameters.reasoningEffort, "none");
  checks.push(
    "reopened management keeps its model and effort after a newer ordinary model admission",
  );
  await page.getByRole("button", { name: "关闭任务详情", exact: true }).click();
  await page.getByRole("button", { name: "新建定时任务", exact: true }).click();
  const next = await assertGlobalCreation();
  assert.equal(next.draft.thread.desktop.configuration.model.modelId, "gpt-6-sol");
  assert.equal(next.draft.thread.desktop.configuration.parameters.reasoningEffort, "high");
  checks.push("another new scheduled management follows newer admitted model and effort");
  const recoveryText = "创建体验验收，快速恢复时保留的草稿。";
  const targetKey = `areal-gui:draft:${next.owner.id}:${next.saved.threadId}`;
  await page.getByRole("button", { name: "关闭创建对话", exact: true }).click();
  await page.evaluate(
    ({ sourceKey, targetKey, recoveryText }) => {
      const source = JSON.parse(localStorage.getItem(sourceKey));
      localStorage.setItem(sourceKey, JSON.stringify({ ...source, text: recoveryText }));
      localStorage.removeItem(targetKey);
      const original = window.requestAnimationFrame,
        frames = [];
      window.requestAnimationFrame = (callback) => {
        frames.push(callback);
        return -frames.length;
      };
      window.releaseTaskFrames = () => {
        window.requestAnimationFrame = original;
        frames.forEach((callback) => original(callback));
      };
      document.querySelector('button[aria-label="新建定时任务"]').click();
    },
    { sourceKey: `areal-gui:task-draft:${workspacePid}`, targetKey, recoveryText },
  );
  try {
    await until(
      async () =>
        (await page.evaluate((key) => localStorage.getItem(key), targetKey)) === recoveryText,
      "fast authoritative read retains draft before initial editor hydration",
    );
  } finally {
    await page.evaluate(() => {
      window.releaseTaskFrames();
      delete window.releaseTaskFrames;
    });
  }
  await until(
    async () => (await chat.textContent()).trim() === recoveryText,
    "recovered Composer displays retained text",
  );
  checks.push("fast recovered Thread preserves persisted text before preparing editor hydration");
  await page.getByRole("button", { name: "关闭创建对话", exact: true }).click();
  await page.evaluate(
    (key) => localStorage.removeItem(key),
    `areal-gui:task-draft:${workspacePid}`,
  );
  const catalog = await call("providers", { operation: "list" });
  await call("providers", {
    operation: "saveAndApply",
    expectedRevision: catalog.revision,
    provider: {
      id: "fixture",
      name: "Fixture",
      baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
      protocol: "chatCompletions",
      enabled: true,
      parameters: {},
      models: [
        { id: "fixture", enabled: true, parameters: {} },
        { id: "gpt-6.1-sol", enabled: true, parameters: {} },
        { id: "gpt-6-sol", enabled: false, parameters: {} },
      ],
    },
  });
  await page.getByRole("button", { name: "新建定时任务", exact: true }).click();
  const fallback = await assertGlobalCreation();
  pid = fallback.owner.id;
  await page
    .getByText("上次使用的模型当前不可用，请确认或重新选择模型。", { exact: true })
    .waitFor();
  await chat.fill("创建体验验收，模型不可用回退。");
  await page.getByTestId("chat-send-button").click();
  await until(
    async () => (await call("tasks", { operation: "list" })).data.some((t) => t.projectId === pid),
    "fallback model saves task",
  );
  const fallbackRequest = modelRequests.findLast((body) =>
    (body.messages ?? []).some((m) => text(m).includes("AREAL_TASK_DRAFT")),
  );
  assert.equal(
    fallbackRequest.model,
    "fixture",
    "unavailable remembered model falls back to current Core default",
  );
  checks.push(
    "unavailable remembered model uses current fallback with visible notice and actual request",
  );
  await page.screenshot({ path: join(scratch, "creation-model.png") });
  assert.deepEqual(errors, []);
}
async function checkLoadingRegression() {
  const primary = await call("projectless", {
    operation: "prepare",
    requestId: randomUUID(),
    directory: independentDirectory,
  });
  await call("connect", { projectId: primary.projectId });
  pid = (
    await until(
      async () =>
        (await snapshot()).projects.find((p) => p.id === primary.projectId && p.state?.connected),
      "primary independent owner ready",
    )
  ).id;
  const slow = join(scratch, "slow-workspace");
  await mkdir(slow);
  const slowPrepared = await call("projectless", {
    operation: "prepare",
    requestId: randomUUID(),
    directory: slow,
  });
  await call("connect", { projectId: slowPrepared.projectId });
  const slowProject = await until(
    async () =>
      (await snapshot()).projects.find(
        (p) => p.id === slowPrepared.projectId && p.state?.connected,
      ),
    "second project ready",
  );
  for (let index = 0; index < 3; index++) {
    const root = join(scratch, `ready-workspace-${index}`);
    await mkdir(root);
    const prepared = await call("projectless", {
      operation: "prepare",
      requestId: randomUUID(),
      directory: root,
    });
    await call("connect", { projectId: prepared.projectId });
    const owner = await until(
      async () =>
        (await snapshot()).projects.find((p) => p.id === prepared.projectId && p.state?.connected),
      "healthy owner ready",
    );
    await call("manage", {
      projectId: owner.id,
      operation: "taskCreate",
      mode: "scheduled",
      objective: `READY_TASK_OWNER_${index}`,
      interactionMode: "interactive",
      schedule: { at: Math.floor(Date.now() / 1000) + 86400, timeZone: "Asia/Shanghai" },
    });
  }
  const create = (objective) =>
    call("manage", {
      projectId: pid,
      operation: "taskCreate",
      mode: "scheduled",
      objective,
      interactionMode: "interactive",
      schedule: { at: Math.floor(Date.now() / 1000) + 86400, timeZone: "Asia/Shanghai" },
    });
  const first = await create("READY_TASK_FIRST"),
    second = await create("READY_TASK_SECOND");
  for (let index = 0; index < 6; index++) await create(`READY_TASK_SCROLL_${index}`);
  await call("manage", {
    projectId: slowProject.id,
    operation: "taskCreate",
    mode: "scheduled",
    objective: "DELAYED_OWNER_TASK",
    interactionMode: "interactive",
    schedule: { at: Math.floor(Date.now() / 1000) + 86400, timeZone: "Asia/Shanghai" },
  });
  assert.equal(
    (await snapshot()).projects.find((p) => p.id === pid).state.tasks?.[first.id],
    undefined,
    "healthy rows must come from catalog response rather than prefilled projection",
  );
  for (const entry of [first, second]) {
    const gate = join(scratch, "watch-" + entry.id);
    watchGates.push(gate);
    await writeFile(gate, "hold");
  }
  await writeFile(loadingGate, "hold");
  await page.getByRole("button", { name: "定时任务", exact: true }).click();
  const traced = async (value) =>
    (await readFile(loadingTrace, "utf8").catch(() => "")).includes(value);
  await until(() => traced("project pending"), "global catalog waits on unrelated project");
  const startupPendingAt = Date.now();
  await page
    .getByRole("button", { name: "打开自动化 READY_TASK_FIRST", exact: true })
    .waitFor({ timeout: 4000 });
  for (let index = 0; index < 3; index++)
    await page
      .getByRole("button", { name: `打开自动化 READY_TASK_OWNER_${index}`, exact: true })
      .waitFor({ timeout: 4000 });
  await page.getByText("其余任务仍在读取…", { exact: true }).waitFor();
  assert.equal(await page.getByText("没有符合筛选条件的定时任务。", { exact: true }).count(), 0);
  assert.equal(await page.getByText("正在读取任务…", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "打开自动化 READY_TASK_FIRST", exact: true }).click();
  await until(() => traced("watch pending " + first.id), "first subscription receipt held");
  assert.equal(
    await page.getByTestId("chat-input").count(),
    0,
    "pending subscription cannot start management Composer",
  );
  assert.equal(
    await page.locator(".task-plan-summary").count(),
    0,
    "existing management loading has no environment banner",
  );
  await page.getByRole("button", { name: "打开自动化 READY_TASK_SECOND", exact: true }).click();
  await until(() => traced("watch pending " + second.id), "second subscription receipt held");
  await rm(watchGates[0]);
  await until(
    () => traced("watch returned " + first.id),
    "first receipt arrives after selection changed",
  );
  await call("manage", { projectId: pid, operation: "task", taskId: first.id });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await page
    .getByRole("main", { name: "定时任务会话" })
    .getByText("正在读取会话…", { exact: false })
    .waitFor();
  assert.equal(
    await page.getByTestId("chat-input").count(),
    0,
    "late first receipt cannot enable second task Composer",
  );
  await rm(watchGates[1]);
  const chat = page.getByTestId("chat-input");
  await chat.waitFor();
  await until(() => chat.isEditable(), "selected task Composer enabled by its own receipt");
  assert.equal(await page.locator(".task-plan-summary").count(), 0);
  await chat.fill("检查现有任务，没有时间。");
  await page.getByTestId("chat-send-button").click();
  await page.getByText("你希望什么时候执行？", { exact: true }).waitFor();
  const management = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)),
    `areal-gui:task-edit:${pid}:${second.id}`,
  );
  assert.equal(
    (
      await call("manage", {
        projectId: pid,
        operation: "taskDraftRead",
        threadId: management.threadId,
      })
    ).thread.cwd,
    independentDirectory,
  );
  await until(
    () => Date.now() - startupPendingAt >= 6500,
    "startup readiness remains pending beyond the catalog RPC deadline",
    10000,
  );
  const startupPending = {
    elapsedMs: Date.now() - startupPendingAt,
    pending: await page.getByText("其余任务仍在读取…", { exact: true }).count(),
    errors: await page.getByRole("alert").allTextContents(),
  };
  await writeFile(
    join(scratch, "catalog-startup-pending.json"),
    JSON.stringify(startupPending, null, 2),
  );
  if (
    startupPending.pending !== 1 ||
    startupPending.errors.some((value) => value.includes("任务目录读取超时"))
  )
    regressionFailures.push(
      "owner startup readiness produced a false 5 s catalog timeout instead of staying pending",
    );
  await page.screenshot({ path: join(scratch, "ready-task-while-catalog-pending.png") });
  checks.push(
    "ready task opens and sends through Composer before unrelated catalog returns; pending and stale subscription receipts do not enable management",
  );
  assert.equal(
    await page.getByRole("button", { name: "打开自动化 DELAYED_OWNER_TASK", exact: true }).count(),
    0,
  );
  await rm(loadingGate);
  const obsoleteRetry = page.getByRole("button", { name: "重试读取 slow-workspace", exact: true });
  if (await obsoleteRetry.count()) await obsoleteRetry.click();
  await page.getByRole("button", { name: "打开自动化 DELAYED_OWNER_TASK", exact: true }).waitFor();
  await until(
    async () => (await page.getByText("其余任务仍在读取…", { exact: true }).count()) === 0,
    "catalog completes after startup readiness releases",
  );
  assert.equal(
    (await call("tasks", { operation: "list" })).data.some((row) => row.id === first.id),
    true,
    "omitted owner preserves global catalog",
  );
  assert.ok(
    Array.isArray((await call("tasks", { operation: "inbox" })).data),
    "omitted owner preserves Inbox catalog",
  );
  checks.push(
    "owner startup stays pending beyond 6.5 s and recovers after release; healthy owners, global list and Inbox remain supported",
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1280, height: 720 }),
  );
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await page.locator(".task-list-scroll").evaluate((element) => {
    element.scrollTop = 40;
  });
  await page.evaluate(() => {
    const capture = () => {
      const list = document.querySelector(".task-list-scroll");
      return {
        at: performance.now(),
        scrollTop: list.scrollTop,
        scrollHeight: list.scrollHeight,
        clientHeight: list.clientHeight,
        statuses: [...list.querySelectorAll('[role="status"]')].map(
          (element) => element.textContent,
        ),
        rows: [...list.querySelectorAll(".task-list-row")].map((element) => ({
          label: element.getAttribute("aria-label"),
          selected: element.getAttribute("aria-pressed"),
          small: element.querySelectorAll("small").length,
          rect: element.getBoundingClientRect().toJSON(),
        })),
      };
    };
    window.taskPollGeometry = {
      samples: [capture()],
      timer: setInterval(() => window.taskPollGeometry.samples.push(capture()), 50),
    };
  });
  await writeFile(loadingPollDelay, "delay");
  const pollCount = async (marker) =>
    (await readFile(loadingTrace, "utf8")).split(marker).length - 1;
  await until(
    async () => (await pollCount("catalog poll pending")) >= 1,
    "background catalog RPC enters its real delayed response",
  );
  await page.screenshot({ path: join(scratch, "catalog-background-refresh-pending.png") });
  await until(
    async () => (await pollCount("catalog poll returned")) >= 3,
    "three repeated background catalog RPCs return real data",
    15000,
  );
  await rm(loadingPollDelay);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const pollGeometry = await page.evaluate(() => {
    clearInterval(window.taskPollGeometry.timer);
    const samples = window.taskPollGeometry.samples;
    delete window.taskPollGeometry;
    return samples;
  });
  const baseline = pollGeometry[0],
    changed = pollGeometry.filter(
      (sample) =>
        sample.statuses.length ||
        sample.scrollTop !== baseline.scrollTop ||
        sample.rows.length !== baseline.rows.length ||
        sample.rows.some((row, index) => {
          const previous = baseline.rows[index];
          return (
            row.label !== previous?.label ||
            row.selected !== previous.selected ||
            row.small !== previous.small ||
            ["x", "y", "width", "height"].some(
              (key) => Math.abs(row.rect[key] - previous.rect[key]) > 1,
            )
          );
        }),
    );
  const pollEvidence = {
    polls: await pollCount("catalog poll returned"),
    samples: pollGeometry,
    changedSamples: changed.length,
  };
  await writeFile(
    join(scratch, "catalog-background-refresh-geometry.json"),
    JSON.stringify(pollEvidence, null, 2),
  );
  assert.ok(
    baseline.scrollHeight > baseline.clientHeight && baseline.scrollTop > 0,
    "refresh check preserves a nonzero scroll position in an overflowing real catalog",
  );
  assert.equal(
    baseline.rows.filter((row) => row.selected === "true").length,
    1,
    "refresh check begins with the current task selected",
  );
  if (changed.length)
    regressionFailures.push(
      `background catalog refresh changes row geometry, status lines, scroll or selection in ${changed.length} observed frames`,
    );
  checks.push(
    "three delayed real background catalog polls measured against row bounds, metadata line count, selected task and nonzero list scroll",
  );
  await writeFile(loadingRpcGate, "hold");
  await until(() => traced("catalog page fixture-second"), "second page RPC held");
  await page.getByRole("alert").filter({ hasText: "任务目录读取超时" }).waitFor({ timeout: 10000 });
  assert.equal(
    await page.getByRole("button", { name: "打开自动化 DELAYED_OWNER_TASK", exact: true }).count(),
    1,
    "RPC failure retains previous complete owner rows",
  );
  assert.ok((await page.getByText("读取失败 · 上次读取", { exact: true }).count()) > 0);
  await page.getByRole("button", { name: "返回对话", exact: true }).click();
  await page.getByRole("button", { name: "定时任务", exact: true }).click();
  await page
    .getByRole("button", { name: "打开自动化 READY_TASK_FIRST", exact: true })
    .waitFor({ timeout: 4000 });
  await page.getByText("其余任务仍在读取…", { exact: true }).waitFor();
  const beforeRelease = await readFile(loadingTrace, "utf8");
  assert.equal(
    beforeRelease.split("catalog page fixture-second").length - 1,
    1,
    "reentering and retries share the held underlying page",
  );
  await rm(loadingRpcGate);
  await page.getByRole("button", { name: "打开自动化 DELAYED_OWNER_TASK", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "打开自动化 LATE_CATALOG_TASK", exact: true }).count(),
    0,
    "expired page cannot publish to new view",
  );
  assert.equal(
    Object.values(
      (await snapshot()).projects.find((p) => p.id === slowProject.id).state.tasks ?? {},
    ).some((row) => row.objective === "LATE_CATALOG_TASK"),
    false,
    "expired page cannot update backend projection",
  );
  checks.push(
    "RPC timeout retains complete rows; rapid navigation starts fresh epoch while sharing outstanding page; expired data never publishes",
  );
  const commit = catalogEvents.find(
    (event) => event.kind === "owner_committed" && event.projectId === pid && event.rows > 0,
  );
  assert.ok(commit, "healthy owner has an actual React commit event");
  const response = catalogEvents.find(
    (event) =>
      event.kind === "response_received" &&
      event.requestId === commit.requestId &&
      event.viewEpoch === commit.viewEpoch &&
      event.projectId === pid,
  );
  assert.ok(
    response && response.at <= commit.at,
    "healthy response precedes its correlated visible commit",
  );
  const terminals = new Set();
  for (const event of catalogEvents.filter((event) => ["end", "abandoned"].includes(event.kind))) {
    const identity = `${event.viewEpoch}:${event.requestId}`;
    assert.ok(!terminals.has(identity), "each catalog batch has one terminal event");
    terminals.add(identity);
  }
  checks.push(
    "structured renderer evidence ties healthy response to visible commit and uniquely terminates catalog batches",
  );
  await page.getByRole("button", { name: "关闭任务详情", exact: true }).click();
  const retainedId = randomUUID(),
    retainedText = "保留初始化失败前的任务描述";
  await page.evaluate(
    ({ projectId, cwd, draftId, text }) =>
      localStorage.setItem(
        `areal-gui:task-draft:${projectId}`,
        JSON.stringify({ draftId, location: { kind: "project", projectId, cwd }, text }),
      ),
    { projectId: workspacePid, cwd: taskDirectory, draftId: retainedId, text: retainedText },
  );
  await writeFile(prepareFailureGate, "fail once");
  await page.getByRole("button", { name: "新建定时任务", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "独立任务初始化验收失败，请重试。" }).waitFor();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.equal(await page.getByTestId("chat-input").isEditable(), true);
  assert.equal(
    await page.getByTestId("chat-send-button").isDisabled(),
    true,
    "failed preparation retains local editing without admission",
  );
  const failed = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)),
    `areal-gui:task-draft:${workspacePid}`,
  );
  assert.equal(failed.draftId, retainedId);
  assert.equal(failed.text, retainedText);
  assert.equal(failed.location.kind, "independent");
  assert.equal(
    (await readFile(loadingTrace, "utf8")).split("projectless prepare " + retainedId).length - 1,
    1,
    "failed prepare waits for explicit retry",
  );
  await page.getByRole("button", { name: "重试", exact: true }).click();
  const created = await assertGlobalCreation();
  assert.equal(created.saved.draftId, retainedId);
  assert.equal(created.saved.location.kind, "independent");
  assert.equal((await page.getByTestId("chat-input").textContent()).trim(), retainedText);
  assert.equal(
    (await readFile(loadingTrace, "utf8")).split("projectless prepare " + retainedId).length - 1,
    2,
    "explicit retry prepares the same independent draft",
  );
  checks.push(
    "legacy unadmitted draft keeps text and independent location through prepare failure; only explicit Retry admits the same draft independently",
  );
  checks.push(
    "new task opens directly in an independent Composer without project, directory or start controls",
  );
  await page.getByRole("button", { name: "关闭创建对话", exact: true }).click();
  const key = `areal-gui:task-draft:${workspacePid}`;
  await page.evaluate(
    ({ key, saved }) =>
      localStorage.setItem(key, JSON.stringify({ ...saved, threadId: undefined })),
    { key, saved: created.saved },
  );
  await page.getByRole("button", { name: "新建定时任务", exact: true }).click();
  const recovered = await assertGlobalCreation();
  assert.equal(recovered.saved.draftId, created.saved.draftId);
  assert.equal(recovered.saved.ownerId, created.saved.ownerId);
  assert.equal(recovered.saved.threadId, created.saved.threadId);
  assert.equal(recovered.draft.thread.cwd, created.owner.root);
  checks.push(
    "prepared independent owner retries the same draft identity and recovers its original Thread",
  );
  await page.getByRole("button", { name: "关闭创建对话", exact: true }).click();
  await page.evaluate(
    ({ key, saved }) =>
      localStorage.setItem(
        key,
        JSON.stringify({ ...saved, threadId: undefined, pending: "start" }),
      ),
    { key, saved: created.saved },
  );
  const startsBefore = (await readFile(loadingTrace, "utf8")).split("draft start ").length;
  await page.getByRole("button", { name: "新建定时任务", exact: true }).click();
  await page
    .getByText("提交结果尚未确认，请核对当前任务；不会自动重复提交。", { exact: false })
    .waitFor();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.equal(await page.getByTestId("chat-input").count(), 0);
  assert.equal(
    (await readFile(loadingTrace, "utf8")).split("draft start ").length,
    startsBefore,
    "pending draft does not resubmit configuration admission",
  );
  const pending = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), key);
  assert.equal(pending.ownerId, created.saved.ownerId);
  assert.equal(pending.draftId, created.saved.draftId);
  assert.equal(pending.pending, "start");
  checks.push(
    "admitted pending draft keeps its owner and request identity without automatic replay",
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(
    regressionFailures,
    [],
    "catalog startup and background refresh regression failures",
  );
}
async function checkInlineRegression() {
  await page.getByRole("button", { name: "定时任务", exact: true }).click();
  await page.getByRole("button", { name: "新建定时任务", exact: true }).click();
  const creation = await assertGlobalCreation();
  pid = creation.owner.id;
  taskCwd = creation.owner.root;
  const send = async (message) => {
    await page.getByTestId("chat-input").fill(message);
    await page.getByTestId("chat-send-button").click();
  };
  const question = "检查执行结果，没有时间。",
    request = "定时执行内联验收，请定期汇报执行结果。";
  await send(question);
  await page.getByText("你希望什么时候执行？", { exact: true }).waitFor();
  await send(request);
  await page
    .getByText(/^已创建任务。/)
    .last()
    .waitFor();
  const created = await until(
    async () =>
      (await call("tasks", { operation: "list" })).data.find(
        (t) => t.objective === inlineObjective,
      ),
    "UI creates inline task",
  );
  assert.equal(created.projectId, pid);
  assert.equal(created.scope, "independent");
  const history = await call("manage", {
    projectId: pid,
    operation: "taskDraftHistory",
    taskId: created.id,
  });
  const managementThread = history.threadId;
  assert.equal(managementThread, creation.saved.threadId);
  const readManagement = () =>
    call("manage", { projectId: pid, operation: "taskDraftRead", threadId: managementThread });
  const readCore = async (threadId) => {
    // CoreBackend lives in the shared service, not Electron Main. Observe the
    // original Core directly without hydrating the GUI's execution projection.
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
      return (await client.request("thread/read", { threadId, includeTurns: true })).thread;
    } finally {
      client.close();
    }
  };
  const originalCore = await readCore(managementThread);
  const original = await readManagement();
  assert.equal(original.thread.turns.length, 2, "clarification and creation turns are retained");
  assert.equal(original.running, false);
  const completed = [];
  const main = () => page.getByRole("main", { name: "定时任务会话", exact: true });
  const inline = () => main().getByLabel("定时任务执行记录", { exact: true });
  const row = (id) => inline().locator(`[data-task-run-id="${id}"]`);
  const message = (scope, value) =>
    scope
      .locator("[data-turn-id] .assistant-message .conversation-markdown")
      .getByText(value, { exact: true });
  const inlineLayout = [];
  async function recordInlineLayout(runId, label) {
    if (label === "completed") {
      const progress = row(runId)
        .getByRole("button", { name: /^执行过程/ })
        .first();
      if ((await progress.count()) && (await progress.getAttribute("aria-expanded")) === "false")
        await progress.click();
      await row(runId).locator(".conversation-code-content").first().waitFor();
    }
    for (const width of [1488, 1040]) {
      await app.evaluate(
        ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 1056),
        width,
      );
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      const measurement = await row(runId).evaluate(
        (element, { label, width }) => {
          const column = document.querySelector(
            ".task-chat-pane > .messages-shell > .messages > .message-column",
          );
          const embedded = element.querySelector(".messages-embedded");
          const rect = (target) => target.getBoundingClientRect().toJSON();
          const code = embedded.querySelector(".conversation-code-content");
          const descendants = [];
          const collect = (root) => {
            for (const node of root.querySelectorAll("*")) {
              descendants.push(node);
              if (node.shadowRoot) collect(node.shadowRoot);
            }
          };
          if (code) collect(code);
          const scrollers = descendants.filter(
            (node) =>
              ["auto", "scroll"].includes(getComputedStyle(node).overflowX) &&
              node.scrollWidth > node.clientWidth + 20,
          );
          return {
            label,
            width,
            column: rect(column),
            run: rect(element),
            embedded: rect(embedded),
            readingLimit: parseFloat(getComputedStyle(column).maxWidth),
            turns: [...embedded.querySelectorAll("[data-turn-id]")].map((node) => ({
              rect: rect(node),
              display: getComputedStyle(node).display,
              direction: getComputedStyle(node).flexDirection,
            })),
            codeScrollers: scrollers.map((node) => ({
              clientWidth: node.clientWidth,
              scrollWidth: node.scrollWidth,
            })),
            embeddedScroll: getComputedStyle(embedded).overflowY,
          };
        },
        { label, width },
      );
      inlineLayout.push(measurement);
      await writeFile(join(scratch, "inline-layout.json"), JSON.stringify(inlineLayout, null, 2));
      if (
        measurement.run.width > measurement.column.width + 1 ||
        measurement.embedded.right > measurement.column.right + 1 ||
        measurement.embedded.left < measurement.column.left - 1 ||
        measurement.turns.some((turn) => turn.rect.right > measurement.column.right + 1)
      )
        regressionFailures.push(`${label} at ${width}px exceeds shared reading-column bounds`);
      if (!measurement.codeScrollers.length)
        regressionFailures.push(`${label} at ${width}px lacks internal long-code scrolling`);
      if (["auto", "scroll"].includes(measurement.embeddedScroll))
        regressionFailures.push(
          `${label} at ${width}px creates an independent vertical scroll viewport`,
        );
      await page.screenshot({ path: join(scratch, `inline-${label}-${width}.png`) });
    }
  }
  async function assertManagement() {
    assert.equal(await main().count(), 1);
    assert.equal(
      await page.getByLabel("任务资源面板", { exact: true }).isVisible(),
      false,
      "resources stay closed",
    );
    assert.equal(
      await page.getByTestId("chat-input").count(),
      1,
      "only the management input exists",
    );
    assert.equal(await main().getByTestId("chat-input").count(), 1);
    assert.equal(
      await page.locator("[data-v4-composer-dock]").count(),
      1,
      "run histories do not mount extra composers",
    );
    assert.equal(await inline().getByTestId("chat-input").count(), 0);
    const current = await readManagement();
    assert.equal(current.threadId, managementThread);
    assert.deepEqual(
      (await readCore(managementThread)).turns,
      originalCore.turns,
      "authoritative management Turns remain unchanged",
    );
    assert.deepEqual(
      current.thread.turns,
      original.thread.turns,
      "run output must not be copied into management Turns",
    );
    assert.deepEqual(current.messages, original.messages, "creation messages remain unchanged");
    for (const value of [question, "你希望什么时候执行？", request]) {
      const item = main().getByText(value, { exact: true });
      await item.waitFor();
      assert.equal(await item.count(), 1, "creation message renders once");
    }
    for (const turn of original.thread.turns) {
      const item = main().locator(`[data-turn-id="${turn.id}"]`);
      await item.waitFor();
      assert.equal(await item.count(), 1, "original creation Turn renders once");
    }
  }
  for (const index of [1, 2]) {
    const fixture = await until(
      () => [...inlineRuns.values()].find((run) => run.index === index),
      `scheduled run ${index} reaches live response`,
    );
    // 在读取 Task（会更新桌面投影）之前等待界面自行显示，不能靠测试轮询补齐订阅。
    await message(inline(), fixture.progress).waitFor();
    assert.equal(await inline().count(), 1);
    const running = await task(created.id);
    const run = running.runs.find(
      (entry) => !completed.some((previous) => previous.id === entry.id),
    );
    assert.ok(run?.threadId, "real Core run owns an execution Thread");
    assert.notEqual(run.threadId, managementThread);
    assert.notEqual(run.threadId, created.threadId);
    assert.equal(await row(run.id).count(), 1);
    const live = message(row(run.id), fixture.progress);
    await live.waitFor();
    assert.equal(await live.count(), 1);
    assert.equal(await row(run.id).locator('[data-turn-status="inProgress"]').count(), 1);
    assert.equal(await message(row(run.id), fixture.final).count(), 0);
    await assertManagement();
    if (index === 1) await recordInlineLayout(run.id, "live");
    await new Promise((resolve) => setTimeout(resolve, 1800));
    assert.equal(
      await live.isVisible(),
      true,
      "intermediate reply remains visible before fixture release",
    );
    assert.equal(
      (await task(created.id)).runs.find((entry) => entry.id === run.id).status,
      "running",
    );
    if (index === 2) await control(created.id, "taskPause");
    await page.screenshot({ path: join(scratch, `task-inline-live-${index}.png`) });
    fixture.release();
    fixture.release = null;
    await message(row(run.id), fixture.final).waitFor();
    await until(
      async () =>
        (await task(created.id)).runs.find((entry) => entry.id === run.id)?.status === "completed",
      `run ${index} completes`,
    );
    completed.push(run);
    if (index === 1) await recordInlineLayout(run.id, "completed");
    checks.push(
      `inline run ${index}: live standard message before completion, exact final reply with resources closed`,
    );
  }
  assert.notEqual(completed[0].id, completed[1].id);
  assert.notEqual(completed[0].threadId, completed[1].threadId);
  assert.deepEqual(
    regressionFailures,
    [],
    "embedded execution conversation preserves shared reading layout",
  );
  async function assertRestored(label) {
    await inline().waitFor();
    for (const [offset, run] of completed.entries()) {
      const fixture = [...inlineRuns.values()].find((entry) => entry.index === offset + 1);
      await message(row(run.id), fixture.final).waitFor();
      const source = await readCore(run.threadId);
      const finalTurns = source.turns.filter((turn) =>
        turn.items.some(
          (item) =>
            item.type === "agentMessage" &&
            item.phase !== "commentary" &&
            item.text === fixture.final,
        ),
      );
      assert.equal(
        finalTurns.length,
        1,
        "fixture final is persisted in the actual execution Thread",
      );
      assert.equal(
        await row(run.id)
          .locator(`[data-turn-id="${finalTurns[0].id}"] .assistant-message .conversation-markdown`)
          .getByText(fixture.final, { exact: true })
          .count(),
        1,
        "inline final uses the real execution Turn",
      );
      assert.equal(await row(run.id).count(), 1, label + " renders each Run once");
      assert.equal(
        await message(row(run.id), fixture.final).count(),
        1,
        label + " renders each final once",
      );
      assert.equal(
        await message(inline(), fixture.final).count(),
        1,
        label + " has no duplicate final in another Run",
      );
    }
    assert.equal(
      await inline().locator("[data-task-run-id]").count(),
      2,
      label + " contains exactly two runs",
    );
    const saved = await task(created.id);
    assert.equal(saved.runs.length, 2);
    assert.equal(saved.paused, true);
    assert.equal(inlineRuns.size, 2, "no additional execution requests");
    await assertManagement();
    assert.deepEqual(errors, []);
    await page.screenshot({ path: join(scratch, `task-inline-${label}.png`) });
    checks.push(
      `inline ${label}: both outputs restored once, original creation Turns unchanged, single management Composer`,
    );
  }
  await assertRestored("completed");
  await page.getByRole("button", { name: "关闭任务详情", exact: true }).click();
  await page.getByRole("button", { name: `打开自动化 ${inlineObjective}`, exact: true }).click();
  await assertRestored("navigation");
  await app.close();
  await launch();
  await page.getByRole("button", { name: "定时任务", exact: true }).click();
  await page.getByRole("button", { name: `打开自动化 ${inlineObjective}`, exact: true }).click();
  await assertRestored("reopen");
}
async function closeOwnedApp() {
  const metadata = await readFile(join(scratch, "core/service.json"), "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  await app.evaluate(
    ({ dialog }, trace) => {
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
          return { response: 1 };
        }
        return old(...args);
      };
    },
    join(scratch, "manual-quit-dialogs.jsonl"),
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
  await assertApplicationStopped(binary, env, metadata);
  manualCleanup.exits.push({
    pid: processHandle.pid,
    exitCode: processHandle.exitCode,
    signal: processHandle.signalCode,
    applicationStopped: true,
  });
  app = null;
  page = null;
}
async function checkManualRegression() {
  await page.getByRole("button", { name: "定时任务", exact: true }).click();
  await page.getByRole("button", { name: "新建定时任务", exact: true }).click();
  const creation = await assertGlobalCreation();
  pid = creation.owner.id;
  await page.getByTestId("chat-input").fill("立即运行验收，后天的这个时间开始，每天执行。");
  await page.getByTestId("chat-send-button").click();
  const created = await until(
    async () =>
      (await call("tasks", { operation: "list" })).data.find(
        (row) => row.objective === manualObjective,
      ),
    "saved manual verification Task",
  );
  await control(created.id, "taskPause");
  const before = await task(created.id),
    plan = (value) => ({
      schedule: value.schedule,
      nextRunAt: value.nextRunAt,
      paused: value.paused,
      skippedRuns: value.skippedRuns,
    });
  const showResources = async () => {
    if (!(await page.getByLabel("任务资源面板", { exact: true }).isVisible()))
      await page.getByRole("button", { name: "任务资源", exact: true }).click();
  };
  await showResources();
  const runNow = () => page.getByRole("button", { name: "立即运行", exact: true });
  await until(() => runNow().isEnabled(), "saved paused Task offers immediate execution");
  await runNow().click();
  const first = await until(async () => {
    const value = await task(created.id);
    return value.runs[0]?.threadId && value;
  }, "manual Run owns real execution Thread");
  assert.deepEqual(plan(first), plan(before));
  assert.equal(first.runCount, 1);
  assert.equal(first.runs[0].trigger, "manual");
  assert.equal(await runNow().isDisabled(), true);
  await page.getByRole("button", { name: "查看当前运行", exact: true }).waitFor();
  assert.ok((await page.getByLabel("定时任务执行记录").innerText()).includes("手动触发"));
  await page.screenshot({ path: join(scratch, "manual-running.png") });
  await page.getByRole("button", { name: "查看当前运行", exact: true }).click();
  await until(
    async () =>
      (await snapshot()).projects.find((project) => project.id === pid).state.threads[
        first.runs[0].threadId
      ]?.turns?.length,
    "current Run opens authoritative Thread",
  );
  await page.getByRole("button", { name: "定时任务", exact: true }).click();
  await page.getByRole("button", { name: `打开自动化 ${manualObjective}`, exact: true }).click();
  const fixture = await until(() => [...manualRuns.values()][0], "manual fixture stream");
  fixture.release();
  const complete = await until(async () => {
    const value = await task(created.id);
    return value.runs[0]?.status === "completed" && value;
  }, "manual Run completes");
  assert.deepEqual(plan(complete), plan(before));
  await until(
    async () =>
      (await snapshot()).library.threads[`${pid}:${first.runs[0].threadId}`]
        ?.scheduledCompletionId === first.runs[0].id,
    "manual completion uses existing unread record",
  );
  assert.equal((await snapshot()).library.threads[`${pid}:${first.runs[0].threadId}`].unread, true);
  await showResources();
  await page
    .getByLabel("任务资源面板")
    .getByText("MANUAL_FIXTURE_REPORT", { exact: false })
    .first()
    .waitFor();
  await page.screenshot({ path: join(scratch, "manual-complete.png") });
  checks.push(
    "real saved Task click preserves paused plan, blocks a second Run, opens execution Thread and records report/unread",
  );
  await writeFile(manualDropGate, "held");
  await writeFile(manualPrepareGate, "held");
  await runNow().click();
  const second = await until(async () => {
    const value = await task(created.id);
    return value.runCount === 2 && value;
  }, "dropped response has one durable accepted Run");
  await until(
    async () =>
      readFile(manualPrepareTrace, "utf8")
        .then((text) => text.includes(second.runs[1].id))
        .catch(() => false),
    "real Host preparation held after admission",
  );
  assert.equal(second.runs[1].threadId, null);
  await until(
    async () =>
      (await snapshot()).projects
        .find((project) => project.id === pid)
        .pending.some((entry) => entry.method === "areal/task/runNow"),
    "lost response remains in durable pending journal",
  );
  const pending = (await snapshot()).projects
    .find((project) => project.id === pid)
    .pending.find((entry) => entry.method === "areal/task/runNow");
  assert.equal(await runNow().isDisabled(), true);
  const instance = (await snapshot()).projects.find((project) => project.id === pid).core
    .instanceId;
  const service = JSON.parse(
    await readFile(
      join(env.AREAL_HARNESS_SERVICE_HOME, "services", instance, "service.json"),
      "utf8",
    ),
  );
  assert.ok(
    Number.isInteger(service.corePid) && service.corePid > 0,
    "crash targets this fixture Core PID",
  );
  manualCleanup.crashTarget = {
    instance,
    serviceId: service.serviceId,
    corePid: service.corePid,
    hostPid: service.hostPid,
  };
  process.kill(service.corePid, "SIGKILL");
  await until(() => {
    try {
      process.kill(service.corePid, 0);
      return false;
    } catch (error) {
      if (error.code === "ESRCH") return true;
      throw error;
    }
  }, "fixture Core exits abruptly during held preparation");
  const adapter = JSON.parse(await readFile(join(scratch, "core/service.json"), "utf8"));
  const oldGui = app.process();
  assert.equal(adapter.applicationOwner.profile, env.AREAL_GUI_USER_DATA);
  assert.ok(Number.isInteger(adapter.pid) && adapter.pid > 0);
  manualCleanup.intentionalCrash = {
    guiPid: oldGui.pid,
    adapterPid: adapter.pid,
    originalCorePid: service.corePid,
    runId: second.runs[1].id,
    requestId: pending.params.requestId,
  };
  const crashPid = (pid) => {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  const exited = (pid) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if (error.code === "ESRCH") return true;
      throw error;
    }
  };
  crashPid(oldGui.pid);
  await until(() => oldGui.signalCode === "SIGKILL", "intentional old GUI crash exits");
  crashPid(adapter.pid);
  await until(() => exited(adapter.pid), "intentional old adapter crash exits");
  const replacement = JSON.parse(
    await readFile(
      join(env.AREAL_HARNESS_SERVICE_HOME, "services", instance, "service.json"),
      "utf8",
    ),
  );
  assert.ok(Number.isInteger(replacement.corePid) && replacement.corePid > 0);
  Object.assign(manualCleanup.intentionalCrash, {
    corePid: replacement.corePid,
    hostPid: replacement.hostPid,
  });
  crashPid(replacement.corePid);
  await until(
    () => exited(replacement.corePid) && exited(replacement.hostPid),
    "intentional replacement Core crash releases its original host",
  );
  app = null;
  page = null;
  await rm(manualPrepareGate);
  await rm(manualDropGate);
  await launch();
  await until(
    async () =>
      !(await snapshot()).projects
        .find((project) => project.id === pid)
        ?.pending.some((entry) => entry.method === "areal/task/runNow"),
    "reopen reconciles original request receipt",
  );
  const recovered = await until(async () => {
    const value = await task(created.id);
    return value.runs[1]?.goalId && value;
  }, "same accepted Run acquires its Goal after Core restart");
  const secondFixture = await until(() => {
    const entry = manualRuns.get(recovered.runs[1].goalId);
    return entry?.connected() && entry;
  }, "same Run has a connected fixture stream after Core restart");
  secondFixture.release();
  const restored = await until(async () => {
    const value = await task(created.id);
    return value.runs[1]?.status === "completed" && value;
  }, "recovered manual Run completes");
  assert.equal(restored.runCount, 2);
  assert.equal(restored.runs[1].id, second.runs[1].id);
  assert.deepEqual(plan(restored), plan(before));
  const trace = (await readFile(manualTrace, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(
    trace.filter((entry) => entry.requestId === pending.params.requestId).length,
    1,
    "recovery never replays runNow",
  );
  await page.getByRole("button", { name: "定时任务", exact: true }).click();
  await page.getByRole("button", { name: `打开自动化 ${manualObjective}`, exact: true }).click();
  await showResources();
  await until(() => runNow().isEnabled(), "original receipt releases saved Task controls");
  checks.push(
    "dropped accepted response persists UNKNOWN across intentional Core and desktop crashes; the new instance recovers the same Run and original receipt without replay",
  );
  await page.screenshot({ path: join(scratch, "manual-recovered.png") });
  assert.deepEqual(errors, []);
}
try {
  await launch();
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
  if (legacyTargetOnly) {
    await checkLegacyTargetRegression();
    passed = true;
  } else if (calendarRegression) {
    await checkCalendarRegression();
    passed = true;
  } else if (manualRegression) {
    await checkManualRegression();
    passed = true;
  } else if (creationRegression) {
    await checkCreationRegression();
    passed = true;
  } else if (inlineRegression) {
    await checkInlineRegression();
    passed = true;
  } else if (dailyStartRegression) {
    await checkDailyStartRegression();
    passed = true;
  } else if (loadingRegression) {
    await checkLoadingRegression();
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
      await page.getByRole("button", { name: "关闭任务详情", exact: true }).click();
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
        .getByRole("button", { name: `打开自动化 ${legacy.objective}`, exact: true })
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
      await page.getByRole("button", { name: "关闭任务详情", exact: true }).click();
      await rmdir(taskDirectory);
      await page.evaluate(
        (key) => localStorage.removeItem(key),
        `areal-gui:task-edit:${workspacePid}:${legacy.id}`,
      );
      await page
        .getByRole("button", { name: `打开自动化 ${legacy.objective}`, exact: true })
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
      await page.getByRole("button", { name: "关闭任务详情", exact: true }).click();
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
            .getByRole("button", { name: `打开自动化 ${entry.objective}`, exact: true })
            .count(),
          1,
        );
      checks.push(
        "global directory shows legacy project-bound tasks and independent tasks together without a workspace filter",
      );
      passed = true;
    } else {
      await send("每天上午九点，稍后安排。");
      const created = await until(
        async () =>
          (await call("tasks", { operation: "list" })).data.find(
            (t) =>
              t.id === creation.seed.id &&
              t.revision > creation.seed.revision &&
              t.objective.includes("SCHEDULE_FIXTURE_COMPLETE"),
          ),
        "Agent updates the seeded legacy task",
      );
      assert.equal(created.id, creation.seed.id, "legacy schedule update preserves task identity");
      assert.ok(
        created.revision > creation.seed.revision,
        "existing fixture cannot satisfy the schedule-update wait",
      );
      const taskId = created.id;
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
        .getByText(/^已创建任务。/)
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
      await until(
        async () => (await task(taskId)).objective.startsWith("只汇报阻塞项"),
        "Agent updated description",
      );
      await resources.click();
      await page
        .getByLabel("定时任务安排")
        .getByText("只汇报阻塞项 SCHEDULE_FIXTURE_COMPLETE", { exact: true })
        .waitFor();
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
      await page.getByRole("button", { name: "关闭任务详情", exact: true }).click();
      await page
        .getByRole("button", { name: `打开自动化 ${(await task(taskId)).objective}`, exact: true })
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
        .getByRole("button", { name: `打开自动化 ${(await task(taskId)).objective}`, exact: true })
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
      await page.getByRole("button", { name: "关闭任务详情", exact: true }).click();
      await page
        .getByRole("button", { name: `打开自动化 ${(await task(taskId)).objective}`, exact: true })
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
      await page.getByLabel("定时任务安排").getByText("已取消", { exact: true }).waitFor();
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
  await rm(manualPrepareGate, { force: true });
  await rm(manualDropGate, { force: true });
  await rm(calendarDropGate, { force: true });
  await rm(creationGate, { force: true });
  await rm(loadingGate, { force: true });
  await rm(loadingRpcGate, { force: true });
  await rm(prepareFailureGate, { force: true });
  for (const gate of watchGates) await rm(gate, { force: true });
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
      await assertApplicationStopped(binary, env, metadata);
      manualCleanup.applicationStopped = true;
    } catch (error) {
      errors.push("manual cleanup: " + error.message);
    }
    if (metadata && !manualCleanup.applicationStopped) {
      manualCleanup.assistedServiceStop = true;
      const {
        ServiceConnection,
        waitForServiceProcessExit,
      } = require("../app/src/core/service-client.cjs");
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
    if (app) {
      const handle = app.process();
      if (handle.exitCode === null && handle.signalCode === null) {
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
    manualCleanup.mainErrors =
      manualRegression || calendarRegression
        ? (await readFile(manualMainErrors, "utf8"))
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
        regressionFailures,
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
