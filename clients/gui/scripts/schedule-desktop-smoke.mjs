import { makeTempDir } from "./support/temp.mjs";
// 真实 Electron / Desktop adapter / Core；模型响应确定化，所有状态与权限来自生产路径。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  assertApplicationStopped,
  cleanupSyntheticHostKeychain,
  closeSmokeApplication,
} from "./application-cleanup.mjs";
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const binary = process.env.AREAL_CORE_BIN || resolve(gui, "../../target/debug/areal");
const binarySha256 = createHash("sha256")
  .update(await readFile(binary))
  .digest("hex");
const scratch = await makeTempDir("areal-schedule-desktop-");
const rust = process.argv.includes("--rust");
const rustDomains = ["library-rust", "execution-rust", "tasks-rust", "worktree-rust"];
if (rust && process.platform === "darwin") assert.equal(process.env.AREAL_TEST_HOST_KEYCHAIN, "1");
const workspace = join(scratch, "workspace"),
  userHome = join(scratch, "user");
await mkdir(workspace);
await mkdir(join(userHome, ".areal"), { recursive: true });
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
const errors = [],
  checks = [],
  modelRequests = [],
  held = new Set();
const blockedOnce = new Set();
const text = (message) =>
  typeof message.content === "string"
    ? message.content
    : (message.content ?? []).map((part) => part.text ?? "").join("\n");
const model = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw),
      messages = body.messages ?? [];
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
    if (
      messages.some((m) => text(m).includes("AREAL_TASK_DRAFT")) ||
      !body.tools?.some((t) => t.function?.name === "goal_update")
    ) {
      finish(
        JSON.stringify({
          kind: "proposal",
          message: "安排好了，每次运行会创建新会话。",
          objective: "SCHEDULE_FIXTURE_COMPLETE",
          interactionMode: "interactive",
          schedule: {
            at: new Date(Date.now() + 8000).toISOString().replace(/\.\d{3}Z$/, "Z"),
            intervalSeconds: 6,
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
  `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n[permissions]\nmode="YOLO"\nask=["fs_create"]\n`,
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
const snapshot = () => page.evaluate(() => window.arealDesktop.snapshot());
async function call(name, params) {
  const reply = await page.evaluate(
    ({ name, params }) => window.arealDesktop.command(name, params),
    { name, params },
  );
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
async function launch() {
  app = await electron.launch({
    executablePath: process.env.AREAL_ELECTRON_EXECUTABLE || require("electron"),
    args: [join(gui, "app")],
    env,
    timeout: 120000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await until(async () => (await snapshot()).connection?.state === "ready", "adapter ready");
}
try {
  await launch();
  if (rust) {
    await until(async () => (await call("serviceStatus", {})).connected, "bootstrap backend ready");
    await page.evaluate((domains) => {
      localStorage.setItem("areal.oneProtocol.reads", "1");
      localStorage.setItem(
        "areal.oneProtocol.domains",
        ["backend", "library", "tasks", "worktree", ...domains].join(","),
      );
    }, rustDomains);
    const stop = JSON.parse(
      execFileSync(binary, ["host", "stop", "--cancel", "--json"], {
        env: { ...env, AREAL_HARNESS_HOME: env.AREAL_HARNESS_SERVICE_HOME },
        encoding: "utf8",
      }),
    );
    await writeFile(join(scratch, "rust-bootstrap-stop.json"), JSON.stringify(stop, null, 2));
    assert.equal(stop.state, "completed");
    assert.ok(stop.projects.every((project) => project.receipt?.state === "completed"));
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0 });
    });
    await closeSmokeApplication(app);
    await assertApplicationStopped(binary, env, null);
    await launch();
    await until(async () => {
      const record = await readFile(
        join(env.AREAL_HARNESS_SERVICE_HOME, "workbench/backend-launch.json"),
        "utf8",
      )
        .then(JSON.parse)
        .catch(() => null);
      return rustDomains.every((domain) => record?.options?.rustDomains?.includes(domain));
    }, "Rust backend launch domains");
  }
  await app.evaluate(({ dialog, BrowserWindow }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    BrowserWindow.getAllWindows()[0].setSize(1440, 960);
  }, workspace);
  await page.evaluate(() => window.arealDesktop.chooseProject());
  pid = (
    await until(
      async () =>
        (await snapshot()).projects.find((p) => p.root === workspace && p.state?.connected),
      "project ready",
    )
  ).id;
  await page.getByRole("button", { name: "定时任务", exact: true }).click();
  await page.getByRole("button", { name: "新建定时任务", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("textbox", { name: "指令", exact: true })
    .fill("SCHEDULE_FIXTURE_COMPLETE");
  await page.screenshot({ path: join(scratch, "schedule-create.png") });
  await dialog.getByRole("button", { name: "创建", exact: true }).click();
  let schedule = await until(
    async () =>
      (await call("tasks", { operation: "list" })).data.find(
        (t) => t.objectivePreview === "SCHEDULE_FIXTURE_COMPLETE" && t.objectiveTruncated === false,
      ),
    "task saved through scheduled task form",
  );
  pid = schedule.executionProjectId ?? schedule.projectId;
  assert.ok(pid, "catalog supplies the actual task owner");
  const scheduleId = schedule.id;
  schedule = await task(scheduleId);
  assert.equal(schedule.id, scheduleId);
  assert.equal(schedule.objective, "SCHEDULE_FIXTURE_COMPLETE");
  assert.ok(schedule.scheduleV2, "form persists its schedule");
  schedule = await call("manage", {
    projectId: pid,
    operation: "taskUpdate",
    taskId: schedule.id,
    expectedRevision: schedule.revision,
    schedule: {
      at: Math.floor(Date.now() / 1000) + 8,
      intervalSeconds: 6,
      timeZone: "Asia/Shanghai",
    },
    delivery: "newThread",
  });
  assert.equal(schedule.interactionMode, "interactive");
  assert.equal(schedule.schedule.timeZone, "Asia/Shanghai");
  await page.getByLabel("定时任务会话").waitFor();
  await page.getByRole("button", { name: "任务资源", exact: true }).click();
  await page.getByLabel("任务资源面板").waitFor();
  await page.getByLabel("定时任务安排").waitFor();
  assert.equal(await page.getByLabel("任务执行方式").count(), 0);
  const recurring = await until(async () => {
    const value = await task(schedule.id);
    return value.runs.filter((r) => r.status === "completed").length >= 2 && value;
  }, "two completed runs");
  for (const run of recurring.runs.slice(0, 2)) {
    const row = page.locator(`[data-task-run-id="${run.id}"]`);
    await row.getByRole("status").filter({ hasText: "已完成" }).waitFor();
    await row.getByText("SCHEDULE_FIXTURE_DONE", { exact: true }).waitFor();
    assert.equal(await row.getByRole("alert").count(), 0, "run conversation projected");
  }
  assert.notEqual(recurring.runs[0].threadId, recurring.runs[1].threadId);
  assert.notEqual(recurring.runs[0].threadId, schedule.threadId);
  await control(schedule.id, "taskPause");
  assert.equal(
    await page.getByLabel("定时任务会话").count(),
    1,
    "runs do not switch the selected surface",
  );
  await page.screenshot({ path: join(scratch, "schedule-history.png") });
  const initialRequests = new Map();
  for (const request of modelRequests) {
    for (const message of request.messages ?? []) {
      const content = text(message);
      if (!content.includes("Current authoritative goal: ")) continue;
      const view = JSON.parse(content.split("Current authoritative goal: ").at(-1));
      if (!initialRequests.has(view.threadId)) initialRequests.set(view.threadId, request);
    }
  }
  for (const run of recurring.runs.slice(0, 2))
    assert.ok(
      !initialRequests
        .get(run.threadId)
        .messages.some((m) => text(m).includes("SCHEDULE_FIXTURE_DONE")),
      "new run excludes previous model results",
    );
  await until(async () => {
    const value = await snapshot();
    return recurring.runs
      .slice(0, 2)
      .every((run) => value.library.threads[`${pid}:${run.threadId}`]?.unread);
  }, "unopened scheduled results marked unread");
  checks.push(
    "form creation, fixture short schedule, two new execution Threads with no inherited results, visible plan/history without focus switch",
  );
  const holding = await call("manage", {
    projectId: pid,
    operation: "taskCreate",
    mode: "scheduled",
    objective: "SCHEDULE_FIXTURE_HOLD",
    interactionMode: "interactive",
    schedule: {
      at: Math.floor(Date.now() / 1000) + 2,
      intervalSeconds: 2,
      timeZone: "Asia/Shanghai",
    },
  });
  const active = await until(async () => {
    const value = await task(holding.id);
    return value.runs.at(-1)?.status === "running" && value;
  }, "holding run");
  await until(async () => (await task(holding.id)).skippedRuns > 0, "overlap skipped");
  await control(holding.id, "taskPause");
  assert.equal(
    (await task(holding.id)).runs.at(-1).status,
    "running",
    "pause affects future triggers only",
  );
  await control(holding.id, "taskStopRun", active.runs.at(-1).id);
  await until(
    async () => (await task(holding.id)).runs.at(-1).status === "cancelled",
    "current run stopped",
  );
  assert.equal((await task(holding.id)).paused, true);
  checks.push(
    "overlap skipped, pause leaves current run active, explicit stop settles current run",
  );
  const approval = await call("manage", {
    projectId: pid,
    operation: "taskCreate",
    mode: "scheduled",
    objective: "SCHEDULE_FIXTURE_APPROVAL",
    interactionMode: "interactive",
    schedule: { at: Math.floor(Date.now() / 1000) + 2, timeZone: "Asia/Shanghai" },
  });
  const approvalRun = await until(async () => {
    const value = await task(approval.id);
    return value.runs.at(-1)?.threadId && value.runs.at(-1);
  }, "approval run Thread");
  await call("open", { projectId: pid, threadId: approvalRun.threadId });
  // 用户明确打开运行会话，审批复用普通 Conversation UI。
  await page
    .getByRole("button", { name: `打开定时任务 ${approval.objective}`, exact: true })
    .click();
  const approvalRow = page.locator(`[data-task-run-id="${approvalRun.id}"]`);
  await approvalRow.getByRole("button", { name: "允许一次", exact: true }).waitFor();
  await page.screenshot({ path: join(scratch, "schedule-approval.png") });
  if (process.env.AREAL_SCHEDULE_APPROVAL_EXPIRY === "1") {
    await until(
      async () => {
        const value = await task(approval.id);
        return (
          value.runs.at(-1)?.reason === "approvalExpired" && value.runs.at(-1)?.status === "blocked"
        );
      },
      "approval expires and resources settle",
      330000,
    );
    await call("open", { projectId: pid, threadId: approvalRun.threadId });
    const state = (await snapshot()).projects.find((p) => p.id === pid).state;
    const before = state.threads[approvalRun.threadId];
    const expired = state.interactions[approvalRun.threadId].data.find(
      (i) => i.status === "expired",
    );
    assert.ok(expired, "original approval expired");
    assert.equal(before.status.type, "idle", "expired Turn resources settled");
    await control(approval.id, "taskResumeRun", approvalRun.id);
    await until(async () => {
      const _value = (await snapshot()).projects.find((p) => p.id === pid).state.threads[
        approvalRun.threadId
      ];
      const state = (await snapshot()).projects.find((p) => p.id === pid).state;
      return state.interactions[approvalRun.threadId].data.some(
        (i) => i.status === "pending" && i.requestId !== expired.requestId,
      );
    }, "fresh approval after explicit same-run resume");
    assert.equal((await task(approval.id)).runs.at(-1).id, approvalRun.id);
    checks.push(
      "default 300-second approval expiry settles Turn, explicit same-run resume creates fresh approval",
    );
  }
  await approvalRow
    .getByRole("button", { name: "允许一次", exact: true })
    .and(page.locator(":enabled"))
    .click();
  await until(
    async () => (await task(approval.id)).runs.at(-1)?.status === "completed",
    "approved run completed",
  );
  checks.push("scheduled execution uses ordinary approval card and completes after approval");
  const independent = await call("projectless", { operation: "prepare", requestId: randomUUID() });
  const once = await call("manage", {
    projectId: independent.projectId,
    operation: "taskCreate",
    mode: "scheduled",
    objective: "SCHEDULE_FIXTURE_INDEPENDENT",
    schedule: { at: Math.floor(Date.now() / 1000) + 2, timeZone: "Asia/Shanghai" },
  });
  const finished = await until(async () => {
    const value = await call("manage", {
      projectId: independent.projectId,
      operation: "task",
      taskId: once.id,
    });
    return value.runs.at(-1)?.status === "completed" && value;
  }, "independent one-shot");
  assert.equal(finished.nextRunAt, null);
  assert.notEqual(finished.runs[0].threadId, once.threadId);
  assert.ok((await snapshot()).projects.find((p) => p.id === independent.projectId).projectless);
  checks.push(
    "independent workspace one-shot uses the same desktop Host admission and fresh Thread",
  );
  const multi = await call("manage", {
    projectId: pid,
    operation: "taskCreate",
    mode: "scheduled",
    objective: "SCHEDULE_FIXTURE_READ_RESUME",
    schedule: { at: Math.floor(Date.now() / 1000) + 2, timeZone: "Asia/Shanghai" },
  });
  const multiRun = await until(async () => {
    const value = await task(multi.id);
    return value.runs[0]?.threadId && value.runs[0];
  }, "multi-Turn Thread");
  await call("open", { projectId: pid, threadId: multiRun.threadId });
  await until(
    async () => (await task(multi.id)).runs[0].status === "blocked",
    "earlier Turn blocked",
  );
  const earlier = await until(
    async () => (await snapshot()).library.threads[`${pid}:${multiRun.threadId}`]?.completionId,
    "earlier Turn completion event",
  );
  await call("library", {
    operation: "readThread",
    projectId: pid,
    threadId: multiRun.threadId,
    read: true,
    completionId: earlier,
  });
  await page.getByRole("button", { name: "定时任务", exact: true }).click();
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0 });
  });
  await closeSmokeApplication(app);
  app = null;
  page = null;
  await launch();
  await task(multi.id);
  assert.equal(
    (await snapshot()).library.threads[`${pid}:${multiRun.threadId}`].unread,
    false,
    "earlier read survives app restart",
  );
  await control(multi.id, "taskResumeRun", multiRun.id);
  await until(
    async () => (await task(multi.id)).runs[0].status === "completed",
    "unopened resumed Run completes",
  );
  await until(async () => {
    const meta = (await snapshot()).library.threads[`${pid}:${multiRun.threadId}`];
    return meta.unread && meta.completionId !== earlier;
  }, "final Turn result becomes unread after restart");
  checks.push(
    "read earlier Turn survives app restart; unopened same-Run resume marks its new final Turn unread",
  );
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  console.error(error);
  if (page) {
    await writeFile(
      join(scratch, "failure-state.json"),
      JSON.stringify(await snapshot(), null, 2),
    ).catch(() => {});
    await page.screenshot({ path: join(scratch, "failure.png") }).catch(() => {});
  }
  throw error;
} finally {
  for (const response of held) response.destroy();
  if (page && pid) {
    try {
      const rows = await call("tasks", { operation: "list", limit: 100 });
      for (const entry of rows.data) {
        if (!entry.cancelled) await control(entry.id, "taskCancel").catch(() => {});
      }
      await until(
        async () => {
          const state = await call("serviceStatus", {});
          return !state.busy && !state.activeCommands;
        },
        "fixture cleanup",
        20000,
      );
      if (!rust) {
        await app.evaluate(({ dialog }) => {
          const old = dialog.showMessageBox;
          dialog.showMessageBox = async (...args) =>
            args.at(-1).message === "停止共享后台服务？" ? { response: 1 } : old(...args);
        });
        await call("stopService", {});
      }
    } catch (error) {
      errors.push(`cleanup: ${error.message}`);
    }
  }
  let originalHost = null;
  if (rust) {
    const { HostClient } = require("@areal/client/node");
    const host = new HostClient();
    try {
      await host.connect(env.AREAL_HARNESS_SERVICE_HOME);
      originalHost = { hostId: host.hostId, generation: host.generation };
      if (app)
        await app.evaluate(({ dialog }) => {
          const old = dialog.showMessageBox;
          dialog.showMessageBox = async (...args) =>
            args.at(-1).message === "退出 AReaL Harness？" ? { response: 0 } : old(...args);
        });
    } catch (error) {
      errors.push(`Host identity: ${error.message}`);
      passed = false;
    } finally {
      host.close();
    }
  }
  if (app)
    await closeSmokeApplication(app).catch((error) => {
      errors.push(`Electron cleanup: ${error.message}`);
      passed = false;
    });
  if (rust) {
    const { HostClient } = require("@areal/client/node");
    const host = new HostClient();
    try {
      assert.ok(originalHost, "original Host identity was captured");
      await host.connect(env.AREAL_HARNESS_SERVICE_HOME);
      assert.equal(host.hostId, originalHost.hostId);
      assert.equal(host.generation, originalHost.generation);
      const stop = await host.stop(randomUUID(), originalHost.generation, "cancel");
      await writeFile(join(scratch, "rust-final-stop.json"), JSON.stringify(stop, null, 2));
      assert.equal(stop.state, "completed");
      assert.equal(stop.hostId, originalHost.hostId);
      assert.equal(stop.generation, originalHost.generation);
      assert.ok(stop.projects.every((project) => project.receipt?.state === "completed"));
      const entries = await cleanupSyntheticHostKeychain(env.AREAL_HARNESS_SERVICE_HOME, scratch);
      await writeFile(
        join(scratch, "synthetic-keychain-cleanup.json"),
        JSON.stringify(entries, null, 2),
      );
    } catch (error) {
      errors.push(`Rust cleanup: ${error.message}`);
      passed = false;
      process.exitCode = 1;
    } finally {
      host.close();
    }
  }
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  await writeFile(
    join(scratch, "evidence.json"),
    JSON.stringify(
      { passed, binary, binarySha256, checks, errors, modelRequests: modelRequests.length },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed, scratch, checks, errors }));
}
