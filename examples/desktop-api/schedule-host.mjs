// 真实 Core/WS、持久重启和连接权限；Host 只返回配置，不实现调度。
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { trackedMkdtemp } from "../../clients/gui/scripts/support/host-cleanup.cjs";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { spawnNative } from "../../scripts/native-child.mjs";
import { connect } from "./client.mjs";
import { fixture } from "./fixture.mjs";
import { randomUUID } from "node:crypto";
const root = await trackedMkdtemp("/tmp/areal-schedule-host-"),
  state = join(root, "state"),
  ready = join(root, "ready.json");
await mkdir(state);
await writeFile(join(root, "config.toml"), "schema_version=1\n");
const model = await fixture(),
  checks = [],
  clients = [];
let child,
  c,
  meta,
  logs = "",
  anchor,
  mode = "normal",
  pendingPrepare,
  releasePrepare,
  holdStarts = 0;
const heldResponses = new Set();
const proxy = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (raw.includes("legacy-hold") || raw.includes("modern-hold")) {
    holdStarts++;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      'data: {"choices":[{"index":0,"delta":{"content":"legacy running"},"finish_reason":null}]}\n\n',
    );
    heldResponses.add(res);
    res.on("close", () => heldResponses.delete(res));
    return;
  }
  const upstream = await fetch(model.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw,
  });
  res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") });
  for await (const chunk of upstream.body) res.write(chunk);
  res.end();
});
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const modelEndpoint = `http://127.0.0.1:${proxy.address().port}/v1/chat/completions`;

const owner = {
  id: "schedule-owner",
  token: randomUUID(),
  permissions: ["observe", "interact", "manage", "tools"],
};
async function until(read, predicate, label, timeout = 20000) {
  const end = Date.now() + timeout;
  let value;
  while (Date.now() < end) {
    value = await read();
    if (predicate(value)) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error(`${label}: ${JSON.stringify(value)}; ${logs}`);
}
async function host(params) {
  if (mode === "fail") throw Error("fixture prepare rejected");
  if (mode === "hold") {
    pendingPrepare = params;
    await new Promise((resolve) => (releasePrepare = resolve));
    if (mode === "normal") return {};
    throw Error("fixture rejected after user stop");
  }
  return {};
}
async function start() {
  const scoped = {
    id: "scoped",
    token: randomUUID(),
    permissions: ["observe", "interact", "manage", "tools"],
    threadIds: anchor ? [anchor] : [],
  };
  await writeFile(
    join(root, "auth.json"),
    JSON.stringify({ version: 1, principals: [owner, scoped] }),
    { mode: 0o600 },
  );
  await writeFile(join(root, "scoped.json"), JSON.stringify({ version: 1, principals: [scoped] }), {
    mode: 0o600,
  });
  await rm(ready, { force: true });
  child = spawnNative(
    resolve("target/debug/areal"),
    [
      "app-server",
      "--listen",
      "127.0.0.1:0",
      "--data-dir",
      state,
      "--config",
      join(root, "config.toml"),
      "--auth-file",
      join(root, "auth.json"),
      "--ready-metadata-file",
      ready,
      "--model",
      "fixture",
      "--model-endpoint",
      modelEndpoint,
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
  child.stderr.on("data", (b) => (logs = (logs + b).slice(-8192)));
  meta = await until(
    () =>
      readFile(ready, "utf8")
        .then(JSON.parse)
        .catch(() => null),
    Boolean,
    "Core ready",
  );
  c = await connect(meta.endpoint, join(root, "auth.json"), host);
  clients.push(c);
}
async function stop() {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  if (child && child.exitCode === null && child.signalCode === null) {
    const done = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    await done;
    clearTimeout(timer);
  }
}
const task = (id) => c.call("areal/task/read", { taskId: id });
async function control(id, action) {
  for (let i = 0; i < 20; i++) {
    const t = await task(id);
    try {
      return await c.call(`areal/task/${action}`, {
        requestId: randomUUID(),
        taskId: id,
        expectedRevision: t.revision,
        ...(["stopRun", "resumeRun"].includes(action) ? { expectedRunId: t.runs.at(-1).id } : {}),
      });
    } catch (e) {
      if (e.code !== -32009) throw e;
    }
  }
  throw Error("control CAS retry exhausted");
}
const create = async (interval = 1, objective = "task-controls-fixture") =>
  c.call("areal/task/create", {
    requestId: randomUUID(),
    mode: "scheduled",
    threadId: anchor,
    objective,
    schedule: {
      at: Math.floor(Date.now() / 1000) - 20,
      ...(interval ? { intervalSeconds: interval } : {}),
    },
  });
try {
  await start();
  anchor = (await c.call("areal/thread/start", { requestId: randomUUID(), cwd: root })).thread.id;
  const offline = await create(1);
  await stop();
  await start();
  const scoped = await connect(meta.endpoint, join(root, "scoped.json"));
  clients.push(scoped);
  await assert.rejects(scoped.call("areal/task/host/ready", {}), (e) => e.code === -32003);
  await assert.rejects(
    scoped.call("areal/task/create", {
      requestId: randomUUID(),
      mode: "scheduled",
      threadId: anchor,
      objective: "forbidden",
      schedule: { at: Math.floor(Date.now() / 1000) + 30 },
    }),
    (e) => e.code === -32003,
  );
  await scoped.call("areal/task/subscribe", { taskId: offline.id });
  assert.equal((await task(offline.id)).runs.length, 0, "Host absence cannot start a Run");
  await c.call("areal/task/host/ready", {});
  const caught = await until(
    () => task(offline.id),
    (t) => t.runs.some((r) => r.status === "completed"),
    "catch-up",
  );
  assert.equal(caught.runs.filter((r) => r.status === "completed").length, 1);
  assert.notEqual(caught.runs[0].threadId, anchor);
  await assert.rejects(
    scoped.call("areal/task/read", { taskId: offline.id }),
    (e) => e.code === -32003,
  );
  assert.ok(
    scoped.events.every((e) => !JSON.stringify(e).includes(caught.runs[0].threadId)),
    "restricted subscription never exposes new Run Thread",
  );
  await control(offline.id, "pause");
  checks.push(
    "offline persisted triggers coalesce once, fresh Thread, restricted create/host/read/stream denied",
  );
  mode = "fail";
  const failed = await create(null);
  const blocked = await until(
    () => task(failed.id),
    (t) => t.runs.at(-1)?.status === "blocked",
    "prepare failure",
  );
  const runId = blocked.runs.at(-1).id;
  assert.equal(blocked.runs.at(-1).threadId, null);
  mode = "normal";
  await control(failed.id, "resumeRun");
  const resumed = await until(
    () => task(failed.id),
    (t) => t.runs.at(-1)?.status === "completed",
    "explicit pre-start retry",
  );
  assert.equal(resumed.runs.length, 1);
  assert.equal(resumed.runs[0].id, runId);
  checks.push("prepare rejection resumes exactly the same never-started Run");
  mode = "hold";
  pendingPrepare = null;
  const editing = await create(10);
  await until(async () => pendingPrepare, Boolean, "edit during preparation");
  const beforeEdit = await task(editing.id);
  await c.call("areal/task/update", {
    requestId: randomUUID(),
    taskId: editing.id,
    expectedRevision: beforeEdit.revision,
    objective: "edited-future",
    schedule: { at: Math.floor(Date.now() / 1000) + 100, intervalSeconds: 10 },
  });
  mode = "normal";
  releasePrepare();
  const unchanged = await until(
    () => task(editing.id),
    (t) => t.runs[0].status === "completed",
    "admitted objective unchanged",
  );
  const execution = await c.call("areal/goal/get", { threadId: unchanged.runs[0].threadId });
  assert.equal(execution.goal.objective, "task-controls-fixture");
  assert.equal(unchanged.objective, "edited-future");
  assert.equal(unchanged.runs[0].objective, "task-controls-fixture");
  await control(editing.id, "pause");
  checks.push(
    "editing during Host preparation affects future schedule only, admitted Run retains its objective",
  );
  mode = "hold";
  pendingPrepare = null;
  const stopping = await create(1);
  await until(async () => pendingPrepare, Boolean, "held preparation");
  await control(stopping.id, "stopRun");
  releasePrepare();
  const stopped = await until(
    () => task(stopping.id),
    (t) => t.runs[0]?.status === "cancelled",
    "stop retained after host error",
  );
  assert.equal(stopped.cancelled, false);
  assert.equal(stopped.paused, false);
  assert.ok(stopped.nextRunAt);
  await control(stopping.id, "pause");
  checks.push("stop during failed prepare remains settled cancellation and preserves recurrence");
  mode = "hold";
  pendingPrepare = null;
  const stale = await create(null);
  await until(async () => pendingPrepare, Boolean, "retiring preparation");
  await c.close();
  mode = "normal";
  c = await connect(meta.endpoint, join(root, "auth.json"), host);
  clients.push(c);
  await c.call("areal/task/host/ready", {});
  releasePrepare();
  const current = await until(
    () => task(stale.id),
    (t) => t.runs.length === 1 && t.runs[0].status === "completed",
    "retired Host catch-up without explicit retry",
  );
  assert.equal(current.runs.length, 1);
  checks.push("retired Host reply cannot create duplicate Run or Thread");

  const modern = await create(null, "modern-hold");
  const running = await until(
    () => task(modern.id),
    (t) => t.runs[0]?.status === "running",
    "modern interrupted fixture",
  );
  await stop();
  await start();
  const beforeRecovery = holdStarts;
  await c.call("areal/task/host/ready", {});
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const interrupted = await task(modern.id);
  assert.equal(
    holdStarts,
    beforeRecovery,
    "Host recovery cannot automatically resume started work",
  );
  assert.ok(["paused", "blocked"].includes(interrupted.runs[0].status));
  await control(modern.id, "resumeRun");
  const same = await until(
    () => task(modern.id),
    (t) => t.runs[0].status === "running" && holdStarts > beforeRecovery,
    "explicit modern same-run resume",
  );
  assert.equal(same.runs.length, 1);
  assert.equal(same.runs[0].id, running.runs[0].id);
  assert.equal(same.runs[0].threadId, running.runs[0].threadId);
  await control(modern.id, "stopRun");
  await until(
    () => task(modern.id),
    (t) => t.runs[0].status === "cancelled",
    "modern resumed stop",
  );
  checks.push(
    "started execution survives Core restart, Host recovery stays paused, explicit resume retains Run/Thread and stop settles",
  );
  const interruptedStop = await create(60, "modern-hold");
  await until(
    () => task(interruptedStop.id),
    (t) => t.runs[0]?.status === "running",
    "stop crash fixture admitted",
  );
  const acceptedStop = await control(interruptedStop.id, "stopRun");
  assert.equal(acceptedStop.runs[0].reason, "stopRequested");
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  await stop();
  const stopPath = join(state, "desktop/task-mode.json");
  const stopSnapshot = JSON.parse(await readFile(stopPath, "utf8"));
  // 重现已持久接受、尚未结算的崩溃切面；保留真实 stopRun receipt。
  stopSnapshot.tasks[interruptedStop.id] = {
    ...stopSnapshot.tasks[interruptedStop.id],
    ...acceptedStop,
  };
  delete stopSnapshot.tasks[interruptedStop.id].pendingQuestions;
  await writeFile(stopPath, JSON.stringify(stopSnapshot));
  await start();
  await c.call("areal/task/host/ready", {});
  const recoveredStop = await until(
    () => task(interruptedStop.id),
    (t) => t.runs[0].status === "cancelled",
    "accepted stop survives restart",
  );
  assert.equal(recoveredStop.cancelled, false);
  assert.equal(recoveredStop.paused, false);
  assert.ok(recoveredStop.nextRunAt);
  await assert.rejects(
    c.call("areal/task/resumeRun", {
      requestId: randomUUID(),
      taskId: interruptedStop.id,
      expectedRevision: recoveredStop.revision,
      expectedRunId: recoveredStop.runs[0].id,
    }),
    (e) => e.code === -32009,
  );
  await control(interruptedStop.id, "pause");
  checks.push(
    "persisted accepted stop before settlement survives restart, cancels Run, rejects resume and preserves recurrence",
  );
  const legacy = await create(null, "legacy-hold");
  const admitted = await until(
    () => task(legacy.id),
    (t) => t.runs.at(-1)?.status === "running",
    "legacy fixture admitted",
  );
  await stop();
  const path = join(state, "desktop/task-mode.json");
  const saved = JSON.parse(await readFile(path, "utf8"));
  saved.version = 2;
  delete saved.preparations;
  const old = saved.tasks[legacy.id];
  delete old.runs[0].startedAt;
  old.paused = false;
  old.schedule.intervalSeconds = 1;
  old.nextRunAt = Math.floor(Date.now() / 1000) - 30;
  await writeFile(path, JSON.stringify(saved));
  await start(); // 无 Host，老执行仍按其原来的恢复规则继续。
  await control(legacy.id, "resumeRun");
  const continuing = await until(
    () => task(legacy.id),
    (t) => t.runs[0].status === "running" && t.skippedRuns > 0,
    "legacy continuation and busy skips",
  );
  assert.equal(continuing.runs.length, 1);
  assert.equal(continuing.runs[0].threadId, admitted.runs[0].threadId);
  assert.ok(continuing.nextRunAt > Math.floor(Date.now() / 1000));
  await control(legacy.id, "stopRun");
  const legacyStopped = await until(
    () => task(legacy.id),
    (t) => t.runs[0].status === "cancelled",
    "legacy stop settles",
  );
  assert.equal(legacyStopped.runs.length, 1);
  assert.equal(legacyStopped.cancelled, false);
  checks.push(
    "version-2 started Run retains original Thread/recovery, consumes busy triggers, and stopRun settles without cancelling recurrence",
  );
  assert.deepEqual(model.failures, []);
  console.log(JSON.stringify({ passed: true, root, checks }));
} finally {
  releasePrepare?.();
  await stop();
  for (const response of heldResponses) response.destroy();
  proxy.closeAllConnections();
  await new Promise((resolve) => proxy.close(resolve));
  await model.close();
  await writeFile(join(root, "evidence.json"), JSON.stringify({ checks, logs }, null, 2));
}
