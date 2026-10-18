import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { spawnNative } from "../../scripts/native-child.mjs";

export async function taskModeMatrix({
  c,
  client,
  startThread,
  workspace,
  endpoint,
  authFile,
  repo,
  model,
}) {
  async function waitTask(client, id, predicate) {
    const snapshot = await client.call("areal/task/subscribe", { taskId: id });
    if (predicate(snapshot)) return snapshot;
    return (
      await client.waitEvent("areal/task/updated", (p) => p.taskId === id && predicate(p.task))
    ).task;
  }
  const terminal = (task) =>
    ["completed", "failed", "blocked", "cancelled"].includes(task.runs.at(-1)?.status);
  async function complete(client, id) {
    const task = await waitTask(client, id, terminal);
    assert.equal(
      task.runs.at(-1).status,
      "completed",
      JSON.stringify({ task, failures: model.failures }),
    );
    return task;
  }
  for (const goal of [false, true]) {
    const { threadId } = await startThread(c, null, {
      agentProfile: { id: "approval", revision: "v1" },
    });
    const child = spawnNative(
      join(repo, "target/debug/areal"),
      [
        "--endpoint",
        endpoint,
        "--auth-file",
        authFile,
        "--resume",
        threadId,
        goal ? "--goal" : "--prompt",
        "headless-policy-fixture",
        ...(goal ? ["--goal-token-budget", "200000"] : []),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "",
      error = "";
    child.stdout.on("data", (b) => (output += b));
    child.stderr.on("data", (b) => (error += b));
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
    let code;
    try {
      [code] = await once(child, "exit");
    } finally {
      clearTimeout(timer);
    }
    assert.equal(code, 0, output + error + JSON.stringify(model.failures));
    assert.match(output, /HEADLESS_POLICY_VERIFIED/);
    const { thread } = await c.call("thread/read", { threadId, includeTurns: true });
    assert.equal(thread.turns.length, goal ? 2 : 1);
    for (const turn of thread.turns)
      assert.equal(turn.configuration.options.interactionMode, "headless");
    assert.equal(thread.desktop.interactions.length, 0);
    assert.equal(await readFile(join(workspace, "headless-evidence.txt"), "utf8"), "verified");
    await assert.rejects(readFile(join(workspace, "headless-forbidden.txt")));
    if (goal) assert.equal(thread.goals.goal.status, "completed");
    const tasks = (await c.call("areal/task/list", {})).data.filter(
      (task) => task.threadId === threadId,
    );
    assert.equal(tasks.length, goal ? 1 : 0);
    assert(tasks.every((task) => task.schedule === null));
  }

  // 前台 Goal 异步问题也能在原连接关闭后，由另一个客户端回复。
  const owner = await client();
  const { threadId } = await startThread(owner);
  const foreground = await owner.call("areal/goal/create", {
    requestId: crypto.randomUUID(),
    threadId,
    expectedRevision: 0,
    objective: "task-channel-fixture",
    tokenBudget: 200000,
  });
  const waiting = await waitTask(
    owner,
    foreground.taskId,
    (task) => task.runs.at(-1)?.status === "waitingForInput",
  );
  assert.equal(waiting.interactionMode, "interactive");
  assert.equal((await c.call("areal/plan/read", { threadId })).steps[0].status, "completed");
  await owner.close();
  const question = (await c.call("areal/inbox/list", {})).data.find(
    (row) => row.taskId === waiting.id,
  ).message;
  await c.call("areal/channel/reply", {
    requestId: crypto.randomUUID(),
    taskId: waiting.id,
    runId: question.runId,
    questionId: question.id,
    answers: { target: "B" },
  });
  assert.equal((await complete(c, waiting.id)).runs[0].usage.turnsStarted, 2);

  // 调度与交互正交：一次性定时任务默认无人值守，重复任务可暂停和取消。
  const scheduledThread = await startThread(c);
  const scheduled = await c.call("areal/task/create", {
    requestId: crypto.randomUUID(),
    mode: "scheduled",
    threadId: scheduledThread.threadId,
    objective: "goal-native-fixture",
    schedule: { at: Math.floor(Date.now() / 1000) + 2 },
    tokenBudget: 200000,
  });
  assert.equal(scheduled.interactionMode, "headless");
  assert.equal(scheduled.runs.length, 0);
  const scheduledDone = await complete(c, scheduled.id);
  assert.equal(scheduledDone.runs.length, 1);
  assert.equal(scheduledDone.nextRunAt, null);
  assert.equal(scheduledDone.runs[0].usage.turnsStarted, 2);
  const periodicThread = await startThread(c);
  let periodic = await c.call("areal/task/create", {
    requestId: crypto.randomUUID(),
    mode: "scheduled",
    threadId: periodicThread.threadId,
    objective: "goal-native-fixture",
    schedule: { at: Math.floor(Date.now() / 1000) + 60, intervalSeconds: 60 },
  });
  for (const action of ["pause", "resume", "cancel"]) {
    periodic = await c.call(`areal/task/${action}`, {
      requestId: crypto.randomUUID(),
      taskId: periodic.id,
      expectedRevision: periodic.revision,
    });
    assert.equal(periodic.cancelled, action === "cancel");
    if (action !== "cancel") assert.equal(periodic.paused, action === "pause");
  }
  assert.equal(periodic.nextRunAt, null);
  assert.equal(periodic.runs.length, 0);

  const before = model.requests.length;
  const workers = await c.call("areal/task/create", {
    requestId: crypto.randomUUID(),
    mode: "background",
    objective: "task-workers-fixture",
    interactionMode: "headless",
    tokenBudget: 200000,
  });
  const workerDone = await complete(c, workers.id);
  assert.equal(workerDone.runs[0].usage.turnsStarted, 2);
  assert.equal(workerDone.runs[0].workers[0].status, "completed");
  assert.equal(workerDone.runs[0].workers[0].settled, true);
  assert.equal(workerDone.runs[0].usage.tokensUsed, (model.requests.length - before) * 14);
  assert.equal(workerDone.runs[0].usage.accountingComplete, true);
  assert.equal(await readFile(join(workspace, "task-worker.txt"), "utf8"), "worker-evidence");
  const status = await c.call("areal/server/status");
  assert.equal(status.activeTurns.length, 0);
  assert.equal(status.restartSafe, true);
}
