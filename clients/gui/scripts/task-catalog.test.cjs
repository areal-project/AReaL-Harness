"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { once } = require("node:events");
const { setImmediate } = require("node:timers/promises");
const { createRequire } = require("node:module");
const { WebSocket, WebSocketServer } = createRequire(require.resolve("../app/package.json"))("ws");
const {
  OwnerTasks,
  taskCatalog,
} = require("@areal/workbench-service/desktop/core/task-catalog.cjs");
const {
  TaskNotificationMonitor,
} = require("@areal/workbench-service/desktop/core/notifications.cjs");
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
const scheduled = (id, extra = {}) => ({
  id,
  revision: 1,
  channelSequence: 0,
  mode: "scheduled",
  sourceThreadId: "source",
  threadId: "anchor",
  objectivePreview: id,
  objectiveTruncated: false,
  paused: false,
  cancelled: false,
  deletedAt: null,
  enabled: true,
  nextRunAt: null,
  schedule: null,
  scheduleV2: null,
  skippedRuns: 0,
  lastSkippedAt: null,
  lastTriggerDecision: null,
  runCount: 0,
  latestRun: null,
  activeRun: null,
  hasUnsettledWork: false,
  pendingQuestions: 0,
  pendingQuestionExpiresAt: null,
  ...extra,
});
const completion = (runId) => ({
  kind: "taskCompleted",
  taskId: "owner",
  runId,
  threadId: runId + "-thread",
  questionId: null,
  interactionId: null,
  interactionKind: null,
  objectivePreview: "Completed",
  expiresAt: null,
});
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await setImmediate();
  assert.ok(predicate(), "protocol observation must converge");
}
async function fixture(t, ids = ["owner"], timeoutMs = 1000) {
  const { CoreClient } = await import("../packages/runtime-client/core.js");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const owners = Object.fromEntries(
    ids.map((id) => [
      id,
      {
        id,
        generation: id + "-generation",
        sequence: 0,
        rows: [scheduled(id)],
        attention: [],
        calls: [],
        observed: [],
        reconciled: [],
        notices: [],
        errors: [],
        read: null,
      },
    ]),
  );
  server.on("connection", (socket, request) => {
    const owner = owners[request.url.slice(1)];
    owner.socket = socket;
    socket.on("message", async (raw) => {
      const message = JSON.parse(raw);
      if (message.id === undefined) return;
      owner.calls.push(message);
      const base = () => {
        if (["initialize", "areal/capabilities"].includes(message.method)) {
          const methods = [
            "areal/owner/watch",
            "areal/owner/unwatch",
            "areal/task/directory/list",
            "areal/task/directory/read",
            "areal/task/attention/read",
            "areal/channel/read",
          ];
          return {
            methods,
            methodSemantics: Object.fromEntries(
              methods.map((method) => [
                method,
                { effect: method.startsWith("areal/owner/") ? "subscription" : "read" },
              ]),
            ),
          };
        }
        if (message.method === "areal/owner/watch")
          return {
            generation: owner.generation,
            sequence: owner.sequence,
            directoryRevision: 1,
            attentionRevision: 1,
          };
        if (message.method === "areal/owner/unwatch") return { removed: true };
        if (message.method === "areal/task/directory/list")
          return { generation: owner.generation, revision: 1, data: owner.rows, nextCursor: null };
        if (message.method === "areal/task/directory/read")
          return {
            generation: owner.generation,
            revision: 1,
            data: owner.rows.filter((row) => message.params.taskIds.includes(row.id)),
            removed: message.params.taskIds.filter(
              (id) => !owner.rows.some((row) => row.id === id),
            ),
          };
        if (message.method === "areal/task/attention/read")
          return {
            generation: owner.generation,
            revision: 1,
            data: owner.attention,
            nextCursor: null,
          };
        if (message.method === "areal/channel/read")
          return { data: owner.messages ?? [], hasMore: false, nextSequence: 1 };
        throw new Error("Unexpected RPC " + message.method);
      };
      try {
        const result = owner.read ? await owner.read(message.method, message.params, base) : base();
        if (result !== undefined && socket.readyState === WebSocket.OPEN)
          socket.send(JSON.stringify({ id: message.id, result }));
      } catch (error) {
        if (socket.readyState === WebSocket.OPEN)
          socket.send(
            JSON.stringify({ id: message.id, error: { code: -32000, message: error.message } }),
          );
      }
    });
  });
  const backend = {
    saved: ids.map((id) => ({ id, root: "/work/" + id })),
    projects: new Map(),
    library: { value: { projects: {} } },
    providers: { redact: (value) => value.replaceAll("secret", "[redacted]") },
    lifecycleOperations: { assertProject() {} },
    onChange() {},
    starts: [],
    start() {
      assert.fail("catalog display must not start Core");
    },
    readConnection() {
      assert.fail("catalog display must not authenticate or start Core");
    },
    currentConnection(project, client) {
      return (
        !this.closing &&
        this.projects.get(project.id) === project &&
        project.client === client &&
        !client.closed
      );
    },
    taskWorkspaceOwners: {
      async observeTasks(project, rows) {
        owners[project.id].observed.push(...rows);
      },
    },
  };
  backend.ownerTasks = new OwnerTasks(backend);
  // 目录读取归 Host；这里只替身 Host 的目录投影，Core 元数据仍走真实连接。
  backend.hostCall = async (method, params) => {
    if (method === "tasks.observe") {
      const owner = owners[params.projectId];
      owner.calls.push({ method });
      return {
        data: owner.rows,
        generation: owner.generation,
        sequence: owner.sequence,
        connectionId: owner.id + "-connection",
        connectionGeneration: 1,
      };
    }
    assert.equal(method, "tasks.read");
    const selected = Object.values(owners).filter(
      (owner) => !params.projectId || owner.id === params.projectId,
    );
    await Promise.all(selected.map((owner) => owner.monitor.start()));
    return { data: selected.flatMap((owner) => owner.rows) };
  };
  for (const owner of Object.values(owners)) {
    const client = new CoreClient({
      createSocket: () => new WebSocket(`ws://127.0.0.1:${server.address().port}/${owner.id}`),
      timeoutMs,
    });
    await client.connect();
    const project = {
      id: owner.id,
      root: "/work/" + owner.id,
      client,
      connectionGeneration: 1,
      model: {
        setTask() {
          assert.fail("directory must not pretend to be a full Task");
        },
      },
    };
    owner.project = project;
    backend.projects.set(owner.id, project);
    owner.monitor = new TaskNotificationMonitor(
      backend.ownerTasks,
      project,
      client,
      (notice) => owner.notices.push(notice),
      (error) => owner.errors.push(error),
      async (rows, facts) => {
        owner.reconciled.push({ rows, facts });
      },
    );
    owner.publish = (extra = {}) =>
      backend.ownerTasks.hostEvent({
        projectId: owner.id,
        connectionId: owner.id + "-connection",
        connectionGeneration: 1,
        method: "areal/owner/invalidated",
        params: {
          generation: owner.generation,
          sequence: ++owner.sequence,
          changedTasks: [],
          changedThreads: [],
          facts: [],
          ...extra,
        },
      });
  }
  t.after(async () => {
    backend.ownerTasks.stop();
    for (const owner of Object.values(owners)) owner.monitor.observation.client.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  return { backend, owners };
}

test("baseline completion metadata recovers older hot Runs after host-ready without blocking directory reads", async (t) => {
  const {
    HistoryObservation,
  } = require("@areal/workbench-service/desktop/core/history-observation.cjs");
  const { backend, owners } = await fixture(t);
  const owner = owners.owner,
    entered = deferred(),
    release = deferred(),
    notices = [];
  const usage = {
    accountingComplete: true,
    cachedInputTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reservedTokens: 0,
    timeUsedSeconds: 0,
    tokensUsed: 0,
    turnsStarted: 0,
    unknownRequests: 0,
  };
  const runs = [1, 2, 3].map((index) => ({
    id: "run-" + index,
    threadId: "run-thread-" + index,
    status: index < 3 ? "completed" : "running",
    scheduledAt: index,
    completedAt: index < 3 ? index : null,
    usage,
    waitRequested: false,
    workers: [],
  }));
  owner.rows = [
    scheduled("owner", {
      runCount: 3,
      latestRun: {
        id: "run-3",
        threadId: "run-thread-3",
        status: "running",
        scheduledAt: 3,
        reasonPreview: null,
        reasonTruncated: false,
        startedAt: 3,
        completedAt: null,
      },
    }),
  ];
  const fullTask = {
    id: "owner",
    revision: 1,
    channelSequence: 0,
    mode: "scheduled",
    owner: "desktop",
    objective: "Task",
    interactionMode: "interactive",
    paused: false,
    cancelled: false,
    runCount: 3,
    archivedRunCount: 0,
    runsComplete: true,
    pendingQuestions: 0,
    runs,
  };
  owner.project.summaries = runs.map((run) => ({ id: run.threadId }));
  owner.read = async (method, params, base) => {
    if (method === "areal/task/read") {
      entered.resolve();
      await release.promise;
      return fullTask;
    }
    if (method === "thread/read")
      return {
        thread: {
          id: params.threadId,
          turns: [{ id: params.threadId + "-turn", status: "completed", items: [] }],
        },
      };
    return base();
  };
  const library = { value: { threads: {} } };
  const history = new HistoryObservation({
    ownerTasks: backend.ownerTasks,
    currentConnection: backend.currentConnection.bind(backend),
    requireConnection(project, client) {
      assert.ok(backend.currentConnection(project, client));
    },
    notifications: {
      publish(notice) {
        notices.push(notice);
      },
    },
    providers: backend.providers,
    library,
  });
  await history.startTaskMonitor(owner.project, owner.project.client);
  assert.equal(owner.calls.filter((call) => call.method === "areal/task/read").length, 0);
  owner.project.taskNotificationMonitor.ready();
  await entered.promise;
  const displayed = await taskCatalog(backend, { operation: "observe", projectId: "owner" });
  assert.equal(displayed.data[0].latestRun.status, "running");
  release.resolve();
  await until(() => owner.project.taskNotificationMonitor.pending === null);
  assert.deepEqual(notices, []);
  assert.equal(owner.calls.filter((call) => call.method === "areal/task/read").length, 1);
});

test("failed completion metadata retries without a new owner event or directory refresh", async (t) => {
  const { backend, owners } = await fixture(t);
  const owner = owners.owner;
  await taskCatalog(backend, { operation: "observe" });
  const baselineReads = owner.calls.filter((call) => call.method === "tasks.observe").length;
  let attempts = 0;
  owner.monitor.reconcile = async () => {
    attempts++;
    if (attempts === 1) throw new Error("temporary metadata failure");
  };
  owner.monitor.ready();
  await until(() => owner.errors.length === 1);
  assert.equal(owner.monitor.observation.ready, true);
  await until(() => attempts === 2);
  assert.equal(owner.sequence, 0, "no new event is required for retry");
  assert.equal(owner.calls.filter((call) => call.method === "tasks.observe").length, baselineReads);
  assert.equal(owner.monitor.baselineTasks.size, 0);
  assert.deepEqual(owner.notices, []);
});

test("stopping the completion monitor cancels its pending retry", async (t) => {
  const { backend, owners } = await fixture(t);
  const owner = owners.owner;
  await taskCatalog(backend, { operation: "observe" });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0;
  owner.monitor.reconcile = async () => {
    attempts++;
    throw new Error("metadata remains unavailable");
  };
  owner.monitor.ready();
  await owner.monitor.pending;
  assert.equal(attempts, 1);
  owner.monitor.stop();
  t.mock.timers.tick(120000);
  await setImmediate();
  assert.equal(attempts, 1);
});

for (const mode of ["scheduled", "foreground"])
  test(`a completion fact resolves tombstone ${mode} mode after its directory row is removed`, async (t) => {
    const {
      HistoryObservation,
    } = require("@areal/workbench-service/desktop/core/history-observation.cjs");
    const { backend, owners } = await fixture(t);
    const owner = owners.owner;
    const fact = completion("compacted-completion");
    owner.rows = [];
    owner.project.summaries = [{ id: fact.threadId }];
    const task = {
      id: "owner",
      revision: 2,
      channelSequence: 0,
      mode,
      owner: "desktop",
      objective: "Deleted task",
      interactionMode: "interactive",
      paused: true,
      cancelled: false,
      deletedAt: 1,
      runCount: 1,
      archivedRunCount: 1,
      runsComplete: false,
      pendingQuestions: 0,
      runs: [],
    };
    owner.read = async (method, params, base) => {
      if (method === "areal/task/read") return task;
      if (method === "thread/read")
        return {
          thread: {
            id: params.threadId,
            turns: [{ id: "completed-turn", status: "completed", items: [] }],
          },
        };
      return base();
    };
    const history = new HistoryObservation({
      ownerTasks: backend.ownerTasks,
      currentConnection: backend.currentConnection.bind(backend),
      requireConnection(project, client) {
        assert.ok(backend.currentConnection(project, client));
      },
      notifications: { publish() {} },
      providers: backend.providers,
      library: { value: { threads: {} } },
    });
    await history.startTaskMonitor(owner.project, owner.project.client);
    owner.project.taskNotificationMonitor.ready();
    owner.publish({ changedTasks: ["owner"], facts: [fact] });
    await until(() => owner.calls.some((call) => call.method === "areal/task/read"));
    await until(() => owner.project.taskNotificationMonitor.pending === null);
    assert.equal(owner.project.taskNotificationMonitor.observation.rows.size, 0);
    assert.equal(owner.calls.filter((call) => call.method === "areal/task/read").length, 1);
    assert.ok(!owner.calls.some((call) => call.method === "areal/task/run/read"));
  });

test("completion metadata retry backs off and keeps each retry delay within thirty seconds", async (t) => {
  const { backend, owners } = await fixture(t);
  const owner = owners.owner;
  await taskCatalog(backend, { operation: "observe" });
  const baselineReads = owner.calls.filter((call) => call.method === "tasks.observe").length;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0;
  owner.monitor.reconcile = async () => {
    attempts++;
    throw new Error("metadata remains unavailable");
  };
  owner.monitor.ready();
  await owner.monitor.pending;
  t.mock.timers.tick(200);
  await setImmediate();
  assert.equal(attempts, 1, "failure must not trigger an immediate retry loop");
  for (let step = 0; step < 10; step++) {
    const before = attempts;
    t.mock.timers.tick(30000);
    await setImmediate();
    assert.equal(
      attempts,
      before + 1,
      "an outstanding metadata batch must retry within the capped delay",
    );
  }
  assert.equal(owner.monitor.observation.ready, true);
  assert.equal(owner.calls.filter((call) => call.method === "tasks.observe").length, baselineReads);
  owner.monitor.stop();
});

test("task directory revision advances per project, and conversation-only changes do not advance it", () => {
  let notified = 0;
  const owner = new OwnerTasks({ onChange: () => notified++ });
  owner.changed("a");
  owner.changed("a");
  owner.changed("b");
  owner.changed();
  assert.equal(owner.revision("a"), 2);
  assert.equal(owner.revision("b"), 1);
  assert.equal(owner.revision("c"), 0);
  assert.equal(notified, 4);
});
