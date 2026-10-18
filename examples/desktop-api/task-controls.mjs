// 真实 Core/WS 与磁盘重启：周期总预算不能被 Goal 更新/恢复绕过，取消不能改写终态历史。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnNative } from "../../scripts/native-child.mjs";
import { connect } from "./client.mjs";
import { fixture } from "./fixture.mjs";

const root = await mkdtemp("/tmp/areal-task-controls-");
const data = join(root, "state"),
  ready = join(root, "ready.json");
const model = await fixture();
const evidence = [];
let child,
  c,
  logs = "";
async function waitFor(read, predicate) {
  const deadline = Date.now() + 20000;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (predicate(value)) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error(`state timeout: ${JSON.stringify(value)}; ${logs}`);
}
async function start() {
  await rm(ready, { force: true });
  child = spawnNative(
    resolve("target/debug/areal"),
    [
      "app-server",
      "--listen",
      "127.0.0.1:0",
      "--data-dir",
      data,
      "--config",
      join(root, "config.toml"),
      "--ready-metadata-file",
      ready,
      "--model",
      "fixture",
      "--model-endpoint",
      model.endpoint,
    ],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        AREAL_HARNESS_HOME: root,
        NO_PROXY: "127.0.0.1,localhost",
        OTEL_SDK_DISABLED: "true",
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  child.stderr.on("data", (b) => {
    logs = (logs + b).slice(-32768);
  });
  const metadata = await waitFor(async () => {
    assert(child.exitCode === null && child.signalCode === null, logs);
    return JSON.parse(await readFile(ready, "utf8").catch(() => "null"));
  }, Boolean);
  c = await connect(metadata.endpoint, metadata.authFile);
}
async function stop() {
  await c?.close();
  c = null;
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    const [code] = await exited;
    clearTimeout(timer);
    assert.equal(code, 0, logs);
  }
}
const task = (id) => c.call("areal/task/read", { taskId: id });
const goal = (threadId) => c.call("areal/goal/get", { threadId });
async function controlTask(id, action) {
  for (let retry = 0; retry < 20; retry++) {
    const view = await task(id);
    try {
      return await c.call(`areal/task/${action}`, {
        requestId: crypto.randomUUID(),
        taskId: id,
        expectedRevision: view.revision,
      });
    } catch (error) {
      if (error.code !== -32009) throw error;
    }
  }
  throw Error("task control remained conflicted");
}
async function controlGoal(threadId, action, patch = {}) {
  const view = await goal(threadId);
  return c.call(`areal/goal/${action}`, {
    requestId: crypto.randomUUID(),
    threadId,
    goalId: view.goal.id,
    expectedRevision: view.revision,
    ...patch,
  });
}
async function create(intervalSeconds) {
  const { thread } = await c.call("areal/thread/start", {
    requestId: crypto.randomUUID(),
    cwd: root,
  });
  return c.call("areal/task/create", {
    requestId: crypto.randomUUID(),
    mode: "scheduled",
    threadId: thread.id,
    objective: "task-controls-fixture",
    tokenBudget: 100000,
    schedule: {
      at: Math.floor(Date.now() / 1000),
      ...(intervalSeconds ? { intervalSeconds } : {}),
    },
  });
}
try {
  await mkdir(data);
  await writeFile(join(root, "config.toml"), "schema_version=1\n");
  await start();
  const finished = await create();
  const beforeCancel = await waitFor(
    () => task(finished.id),
    (t) => t.runs.at(-1)?.status === "completed",
  );
  assert(beforeCancel.runs[0].usage.tokensUsed > 0);
  await controlTask(finished.id, "cancel");
  // 越过调度器 tick，检查异步同步不会改写终态，而非只检查控制响应。
  await new Promise((r) => setTimeout(r, 1200));
  assert.deepEqual((await task(finished.id)).runs, beforeCancel.runs);
  evidence.push("cancel preserves completed Run status, completion time and usage");

  const recurring = await create(2);
  const blocked = await waitFor(
    () => task(recurring.id),
    (t) => t.runs.length >= 2 && t.runs.at(-1)?.status === "blocked",
  );
  assert.equal(blocked.runs.length, 2);
  await controlTask(recurring.id, "pause");
  await waitFor(
    () => goal(recurring.threadId),
    (v) => !v.goal.activeTurnId && !v.goal.settling && v.goal.status !== "active",
  );
  const otherUsage = blocked.runs[0].usage.tokensUsed + blocked.runs[0].usage.reservedTokens;
  const remaining = recurring.tokenBudget - otherUsage;
  assert(otherUsage > 0);
  for (const tokenBudget of [null, remaining + 1]) {
    const before = await goal(recurring.threadId);
    await assert.rejects(
      controlGoal(recurring.threadId, "update", { tokenBudget }),
      (e) => e.code === -32602 && /TASK_TOKEN_BUDGET/.test(e.message),
    );
    const after = await goal(recurring.threadId);
    assert.equal(after.revision, before.revision);
    assert.equal(after.goal.tokenBudget, before.goal.tokenBudget);
  }
  await controlGoal(recurring.threadId, "update", { tokenBudget: remaining });
  evidence.push(
    "Goal update rejects unlimited/excess budgets without saving; exact remaining budget accepted",
  );
  await stop();
  await start();
  const restoredRuns = (await task(finished.id)).runs;
  assert.equal(restoredRuns.length, beforeCancel.runs.length);
  // JSON 持久化往返可能改变浮点耗时的最低有效位；其他历史字段仍须精确一致。
  const comparableRuns = restoredRuns.map((run, index) => {
    const expectedSeconds = beforeCancel.runs[index].usage.timeUsedSeconds;
    const actualSeconds = run.usage.timeUsedSeconds;
    assert(Number.isFinite(actualSeconds) && Number.isFinite(expectedSeconds));
    assert(
      Math.abs(actualSeconds - expectedSeconds) <=
        Number.EPSILON * Math.max(1, Math.abs(expectedSeconds)),
      `restored run duration changed: ${actualSeconds} vs ${expectedSeconds}`,
    );
    return { ...run, usage: { ...run.usage, timeUsedSeconds: expectedSeconds } };
  });
  assert.deepEqual(comparableRuns, beforeCancel.runs);
  assert.equal((await goal(recurring.threadId)).goal.tokenBudget, remaining);
  evidence.push("restart preserves cancelled task history and accepted budget");
  await controlGoal(recurring.threadId, "resume");
  await waitFor(
    () => goal(recurring.threadId),
    (v) => v.goal.status === "blocked" && !v.goal.activeTurnId && !v.goal.settling,
  );
  evidence.push("Goal with valid remaining budget resumes and settles");
  await controlTask(recurring.id, "pause");
  await stop();

  // 模拟旧版已保存的越界额度，验证启动后的恢复入口也会拒绝，而非仅保护新更新。
  const path = join(data, `${recurring.threadId}.json`);
  const record = JSON.parse(await readFile(path, "utf8"));
  record.thread.goals.goal.tokenBudget = remaining;
  await writeFile(path, JSON.stringify(record));
  const taskPath = join(data, "desktop/task-mode.json");
  const taskRecord = JSON.parse(await readFile(taskPath, "utf8"));
  taskRecord.tasks[recurring.id].runs[0].usage.reservedTokens = 17;
  taskRecord.tasks[recurring.id].runs[0].usage.accountingComplete = false;
  await writeFile(taskPath, JSON.stringify(taskRecord));
  await start();
  const beforeResume = await goal(recurring.threadId),
    requests = model.requests.length;
  await assert.rejects(
    controlGoal(recurring.threadId, "resume"),
    (e) => e.code === -32602 && /TASK_TOKEN_BUDGET/.test(e.message),
  );
  const afterResume = await goal(recurring.threadId);
  assert.equal(afterResume.revision, beforeResume.revision);
  assert.equal(afterResume.goal.status, beforeResume.goal.status);
  assert.equal(model.requests.length, requests);
  await assert.rejects(
    controlGoal(recurring.threadId, "update", { tokenBudget: remaining }),
    (e) => e.code === -32602 && /TASK_TOKEN_BUDGET/.test(e.message),
  );
  await controlGoal(recurring.threadId, "update", { tokenBudget: remaining - 17 });
  evidence.push(
    "other Run reservations reduce update/resume allowance; legacy excess cannot issue a model request",
  );
  assert.deepEqual(model.failures, []);
  console.log(
    JSON.stringify({
      status: "passed",
      sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      workingTree: true,
      model: "local-fixture",
      evidence,
    }),
  );
} finally {
  await stop();
  await model.close();
  await rm(root, { recursive: true, force: true });
}
