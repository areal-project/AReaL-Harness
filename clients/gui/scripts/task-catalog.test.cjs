"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { once } = require("node:events");
const { setImmediate } = require("node:timers/promises");
const { createRequire } = require("node:module");
const { WebSocket, WebSocketServer } = createRequire(require.resolve("../app/package.json"))("ws");
const { OwnerTasks, taskCatalog } = require("../app/src/core/task-catalog.cjs");
const { TaskNotificationMonitor } = require("../app/src/core/notifications.cjs");
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
      owner.socket.send(
        JSON.stringify({
          method: "areal/owner/invalidated",
          params: {
            generation: owner.generation,
            sequence: ++owner.sequence,
            changedTasks: [],
            changedThreads: [],
            facts: [],
            ...extra,
          },
        }),
      );
  }
  t.after(async () => {
    backend.ownerTasks.stop();
    for (const owner of Object.values(owners)) owner.monitor.observation.client.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  return { backend, owners };
}

test("display requests share one owner baseline without starting Core or using legacy full lists", async (t) => {
  const { backend, owners } = await fixture(t);
  const entered = deferred(),
    release = deferred();
  owners.owner.read = async (method, _params, base) => {
    if (method === "areal/task/directory/list") {
      entered.resolve();
      await release.promise;
    }
    return base();
  };
  const first = taskCatalog(backend, { operation: "list", projectId: "owner" });
  const second = taskCatalog(backend, { operation: "observe", projectId: "owner", limit: 60 });
  await entered.promise;
  assert.equal(owners.owner.calls.filter((call) => call.method === "areal/owner/watch").length, 1);
  release.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.data[0].id, "owner");
  assert.deepEqual(a.data, b.data);
  assert.deepEqual(backend.starts, []);
  assert.ok(
    !owners.owner.calls.some((call) =>
      ["areal/task/list", "areal/inbox/list", "areal/work/overview"].includes(call.method),
    ),
  );
  assert.equal(a.data[0].runs, undefined);
});
test("CoreClient timeout retains the last complete owner and independent healthy sources", async (t) => {
  const { backend, owners } = await fixture(t, ["blocked", "healthy"], 40);
  await taskCatalog(backend, { operation: "observe" });
  owners.blocked.read = (method, _params, base) =>
    method === "areal/task/directory/list" ? undefined : base();
  owners.blocked.monitor.observation.resetNeeded = true;
  const result = await taskCatalog(backend, { operation: "list" });
  assert.deepEqual(
    result.data.map((row) => row.id),
    ["blocked", "healthy"],
  );
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].projectId, "blocked");
  assert.ok(owners.blocked.errors.some((error) => error.code === "TIMEOUT"));
  assert.equal(result.owners.find((owner) => owner.projectId === "blocked").status, "error");
});
test("differing display limits use the same full bounded cache and exact source filtering", async (t) => {
  const { backend, owners } = await fixture(t);
  owners.owner.rows = [
    scheduled("ordinary", { mode: "foreground" }),
    scheduled("a"),
    scheduled("b"),
    scheduled("other", { sourceThreadId: "different" }),
  ];
  const [small, large] = await Promise.all([
    taskCatalog(backend, { operation: "list", limit: 1 }),
    taskCatalog(backend, {
      operation: "observe",
      projectId: "owner",
      sourceThreadId: "source",
      limit: 3,
    }),
  ]);
  assert.deepEqual(
    small.data.map((row) => row.id),
    ["a"],
  );
  assert.equal(small.hasMore, true);
  assert.deepEqual(
    large.data.map((row) => row.id),
    ["a", "b"],
  );
  assert.equal(large.hasMore, false);
  assert.equal(
    owners.owner.calls.filter((call) => call.method === "areal/task/directory/list").length,
    1,
  );
});
test("metadata and partial errors keep project identity, request identity, and redaction", async (t) => {
  const { backend, owners } = await fixture(t, ["named", "independent", "broken"]);
  backend.library.value.projects.named = { title: "Project title" };
  backend.saved[1].projectless = true;
  owners.broken.read = (method, _params, base) => {
    if (method === "areal/task/directory/list") throw new Error("cannot list secret");
    return base();
  };
  const result = await taskCatalog(backend, { operation: "list" });
  assert.deepEqual(
    result.data.map((row) => [row.id, row.projectId, row.projectName, row.scope]),
    [
      ["named", "named", "Project title", "project"],
      ["independent", "independent", "独立任务", "independent"],
    ],
  );
  assert.match(result.errors[0].message, /cannot list \[redacted\]/);
  const scoped = await taskCatalog(backend, {
    operation: "observe",
    projectId: "independent",
    requestId: "11111111-1111-4111-a111-111111111111",
    viewEpoch: 9,
  });
  assert.equal(scoped.projectId, "independent");
  assert.equal(scoped.viewEpoch, 9);
  assert.equal(scoped.requestId, "11111111-1111-4111-a111-111111111111");
});
for (const change of ["replace", "close", "shutdown"])
  test(`connection ${change} cannot install a late baseline`, async (t) => {
    const { backend, owners } = await fixture(t, ["stale", "healthy"]);
    const entered = deferred(),
      release = deferred();
    owners.stale.read = async (method, _params, base) => {
      if (method === "areal/task/directory/list") {
        entered.resolve();
        await release.promise;
      }
      return base();
    };
    const pending = taskCatalog(backend, { operation: "list" });
    await entered.promise;
    if (change === "replace") owners.stale.project.client = { closed: false };
    if (change === "close") owners.stale.project.client.close();
    if (change === "shutdown") backend.closing = true;
    release.resolve();
    const result = await pending;
    assert.ok(!result.data.some((row) => row.id === "stale"));
    assert.ok(result.errors.some((error) => error.projectId === "stale"));
    assert.deepEqual(owners.stale.observed, []);
  });
test("repeated cursors and mixed directory generations never replace previous rows", async (t) => {
  const { backend, owners } = await fixture(t);
  await taskCatalog(backend, { operation: "list" });
  for (const kind of ["cursor", "revision", "generation"]) {
    const observation = owners.owner.monitor.observation;
    clearTimeout(observation.retryTimer);
    observation.retryTimer = undefined;
    observation.error = null;
    observation.resetNeeded = true;
    owners.owner.read = (method, params, base) =>
      method === "areal/task/directory/list"
        ? {
            generation: kind === "generation" ? "wrong" : owners.owner.generation,
            revision: kind === "revision" && params.cursor ? 2 : 1,
            data: [scheduled("uncommitted")],
            nextCursor: "same",
          }
        : base();
    const result = await taskCatalog(backend, { operation: "list" });
    assert.equal(result.data[0].id, "owner");
    assert.equal(result.errors.length, 1);
  }
});
test("in-flight dirty ID replay preserves every completion and installs the newest row", async (t) => {
  const { backend, owners } = await fixture(t);
  await taskCatalog(backend, { operation: "observe" });
  const owner = owners.owner,
    entered = deferred(),
    release = deferred();
  let reads = 0;
  owner.read = async (method, _params, base) => {
    if (method === "areal/task/directory/read" && ++reads === 1) {
      const result = base();
      entered.resolve();
      await release.promise;
      return result;
    }
    return base();
  };
  owner.rows = [scheduled("owner", { revision: 2 })];
  owner.publish({ changedTasks: ["owner"], facts: [completion("first")] });
  await entered.promise;
  owner.rows = [scheduled("owner", { revision: 3 })];
  owner.publish({ changedTasks: ["owner"], facts: [completion("second")] });
  await until(() => owner.monitor.observation.sequence === 2);
  release.resolve();
  await until(() => owner.monitor.observation.rows.get("owner").revision === 3);
  assert.equal(owner.notices.length, 2);
  assert.ok(reads >= 2);
  owner.publish({ sequence: 2, facts: [completion("second")] });
  await setImmediate();
  assert.equal(owner.notices.length, 2);
});
test("watch facts during baseline are delivered once and reconciliation waits for host-ready", async (t) => {
  const { backend, owners } = await fixture(t);
  const owner = owners.owner;
  owner.read = (method, _params, base) => {
    if (method === "areal/task/directory/list")
      owner.publish({ changedTasks: ["owner"], facts: [completion("during-baseline")] });
    return base();
  };
  await taskCatalog(backend, { operation: "observe" });
  assert.equal(owner.notices.length, 1);
  assert.equal(owner.reconciled.length, 0);
  await owner.monitor.ready();
  assert.equal(owner.reconciled.flatMap((row) => row.facts).length, 1);
});
test("completion reconciliation drains facts arriving while reconciliation is pending", async (t) => {
  const { backend, owners } = await fixture(t);
  const owner = owners.owner,
    entered = deferred(),
    release = deferred();
  await taskCatalog(backend, { operation: "observe" });
  await owner.monitor.ready();
  owner.monitor.reconcile = async (_rows, facts) => {
    if (facts.length) {
      owner.reconciled.push({ facts });
      if (facts[0].runId === "first") {
        entered.resolve();
        await release.promise;
      }
    }
  };
  owner.publish({ changedTasks: ["owner"], facts: [completion("first")] });
  await entered.promise;
  owner.publish({ changedTasks: ["owner"], facts: [completion("second")] });
  await until(() => owner.monitor.completions.size === 1);
  release.resolve();
  await until(() =>
    owner.reconciled.flatMap((row) => row.facts).some((fact) => fact.runId === "second"),
  );
  assert.equal(owner.monitor.completions.size, 0);
});
test("explicit removal and sequence gaps rebuild from a new barrier", async (t) => {
  const { backend, owners } = await fixture(t);
  const owner = owners.owner;
  await taskCatalog(backend, { operation: "observe" });
  owner.rows = [];
  owner.publish({ changedTasks: ["owner"] });
  await until(() => owner.monitor.observation.rows.size === 0);
  owner.rows = [scheduled("replacement")];
  owner.sequence += 1;
  owner.publish({ changedTasks: ["replacement"] });
  await until(() => owner.monitor.observation.rows.has("replacement"));
  assert.ok(owner.calls.filter((call) => call.method === "areal/owner/watch").length >= 2);
});
test("Inbox expands pending attention channels and separates message and task identity", async (t) => {
  const { backend, owners } = await fixture(t);
  const owner = owners.owner;
  owner.attention = [
    {
      id: "attention",
      kind: "asyncQuestion",
      taskId: "owner",
      runId: "run",
      threadId: null,
      questionId: "message",
      interactionId: null,
      objectivePreview: "Question task",
      summary: "Question",
      expiresAt: null,
    },
  ];
  owner.messages = [
    {
      id: "message",
      runId: "run",
      sequence: 1,
      author: "assistant",
      kind: "question",
      status: "pending",
      createdAt: 1,
      expiresAt: null,
      questions: [],
      required: true,
      inReplyTo: null,
      answers: null,
      text: "Question",
    },
  ];
  const result = await taskCatalog(backend, { operation: "inbox", limit: 1 });
  assert.deepEqual(
    result.data.map((row) => [row.taskId, row.message.runId, row.message.id]),
    [["owner", "run", "message"]],
  );
  assert.equal(owner.calls.filter((call) => call.method === "areal/channel/read").length, 1);
  assert.ok(!owner.calls.some((call) => call.method === "areal/inbox/list"));
});
test("display limit keeps all 1024 cached rows without subscriptions per Task", async (t) => {
  const { backend, owners } = await fixture(t);
  const owner = owners.owner;
  owner.rows = Array.from({ length: 1024 }, (_, index) => scheduled(String(index)));
  const result = await taskCatalog(backend, { operation: "list", limit: 30 });
  assert.equal(result.data.length, 30);
  assert.equal(result.hasMore, true);
  assert.equal(owner.monitor.observation.rows.size, 1024);
  assert.equal(owner.calls.filter((call) => call.method === "areal/owner/watch").length, 1);
  assert.ok(!owner.calls.some((call) => call.method === "areal/task/subscribe"));
});
test("invalid requests and unknown owners are rejected without starting or reading Core", async (t) => {
  const { backend, owners } = await fixture(t);
  const before = owners.owner.calls.length;
  for (const request of [
    { operation: "delete" },
    ...[0, -1, 1025, 1.2, "2"].map((limit) => ({ operation: "list", limit })),
  ])
    await assert.rejects(taskCatalog(backend, request), /无效任务列表请求/);
  await assert.rejects(
    taskCatalog(backend, { operation: "list", projectId: "missing" }),
    /任务所有者不存在/,
  );
  assert.equal(owners.owner.calls.length, before);
  assert.deepEqual(backend.starts, []);
});

test("baseline completion metadata recovers older hot Runs after host-ready without blocking directory reads", async (t) => {
  const { HistoryObservation } = require("../app/src/core/history-observation.cjs");
  const { backend, owners } = await fixture(t);
  const owner = owners.owner,
    entered = deferred(),
    release = deferred(),
    recorded = [],
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
  const library = {
    value: { threads: {} },
    async recordScheduledCompletion(projectId, run, completionId) {
      this.value.threads[`${projectId}:${run.threadId}`] = { scheduledCompletionId: run.id };
      recorded.push([run.id, completionId]);
    },
  };
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
  assert.deepEqual(recorded, []);
  release.resolve();
  await until(() => recorded.length === 2);
  assert.deepEqual(
    recorded.map(([id]) => id),
    ["run-1", "run-2"],
  );
  assert.deepEqual(notices, []);
  assert.equal(owner.calls.filter((call) => call.method === "areal/task/read").length, 1);
});

test("failed completion metadata retries without a new owner event or directory refresh", async (t) => {
  const { backend, owners } = await fixture(t);
  const owner = owners.owner;
  await taskCatalog(backend, { operation: "observe" });
  const baselineReads = owner.calls.filter(
    (call) => call.method === "areal/task/directory/list",
  ).length;
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
  assert.equal(
    owner.calls.filter((call) => call.method === "areal/task/directory/list").length,
    baselineReads,
  );
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
    const { HistoryObservation } = require("../app/src/core/history-observation.cjs");
    const { backend, owners } = await fixture(t);
    const owner = owners.owner;
    const recorded = [];
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
      library: {
        value: { threads: {} },
        async recordScheduledCompletion(_projectId, run, completionId) {
          recorded.push([run.id, run.threadId, completionId]);
        },
      },
    });
    await history.startTaskMonitor(owner.project, owner.project.client);
    owner.project.taskNotificationMonitor.ready();
    owner.publish({ changedTasks: ["owner"], facts: [fact] });
    await until(() => owner.calls.some((call) => call.method === "areal/task/read"));
    await until(() => owner.project.taskNotificationMonitor.pending === null);
    assert.equal(owner.project.taskNotificationMonitor.observation.rows.size, 0);
    assert.deepEqual(
      recorded,
      mode === "scheduled" ? [[fact.runId, fact.threadId, "completed-turn"]] : [],
    );
    assert.equal(owner.calls.filter((call) => call.method === "areal/task/read").length, 1);
    assert.ok(!owner.calls.some((call) => call.method === "areal/task/run/read"));
  });

test("completion metadata retry backs off and keeps each retry delay within thirty seconds", async (t) => {
  const { backend, owners } = await fixture(t);
  const owner = owners.owner;
  await taskCatalog(backend, { operation: "observe" });
  const baselineReads = owner.calls.filter(
    (call) => call.method === "areal/task/directory/list",
  ).length;
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
  assert.equal(
    owner.calls.filter((call) => call.method === "areal/task/directory/list").length,
    baselineReads,
  );
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
