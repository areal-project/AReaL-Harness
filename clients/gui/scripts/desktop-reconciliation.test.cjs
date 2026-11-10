"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const { CoreBackend } = require("@areal/workbench-service/desktop/core/backend.cjs");
const { snapshotProject } = require("@areal/workbench-service/desktop/core/project-snapshot.cjs");
const { manageTask } = require("@areal/workbench-service/desktop/core/tasks.cjs");
const contract = require("../packages/workbench/client/desktop-contract.cjs");

async function fixture(t, entries, read) {
  const home = await mkdtemp(join(tmpdir(), "areal-desktop-receipts-"));
  const backend = Object.assign(Object.create(CoreBackend.prototype), {
    home,
    rustDomains: [],
    saves: new Map(),
    awaitingResponses: new Set(),
    onChange() {},
    providers: { redact: (value) => value, acceptModelSelection: async () => {}, rejectModel() {} },
    lifecycleOperations: { activeTargets: new Set(), blocking: () => false },
    listThreads: async () => {},
    openThread: async () => {},
  });
  const calls = [];
  const project = {
    id: "project",
    pending: entries,
    outcomes: {},
    configurations: {},
    connectionGeneration: 1,
    model: { state: { connected: true, threads: {} }, setTask() {} },
    client: {
      ready: true,
      closed: false,
      capabilities: { features: { operationOutcomes: true, taskRequestReceipts: true } },
      request: async (method, params) => {
        calls.push({ method, params });
        return read(method, params);
      },
    },
  };
  const journals = new Map();
  const journalFor = (id) => {
    let journal = journals.get(id);
    if (!journal) {
      const owner = id === project.id ? project : backend.projects.get(id);
      let snapshot = structuredClone({
        version: 1,
        pending: owner.pending,
        outcomes: owner.outcomes,
      });
      journal = {
        read: async () => ({ snapshot: structuredClone(snapshot) }),
        change: async (mutate) => {
          snapshot = structuredClone(await mutate(structuredClone(snapshot)));
          return { state: "completed" };
        },
      };
      journals.set(id, journal);
    }
    return journal;
  };
  backend.host = { journal: journalFor };
  t.after(async () => {
    backend.closing = true;
    clearTimeout(project.reconciliation?.timer);
    await rm(home, { recursive: true, force: true });
  });
  return { backend, project, calls };
}
const entry = (method, params) => ({ method, params: { ...params, requestId: randomUUID() } });
const receipt = (item) => ({
  requestId: item.params.requestId,
  method: item.method,
  status: "completed",
  operation: {
    requestId: item.params.requestId,
    method: item.method,
    target: { kind: "task", taskId: item.params.taskId },
  },
  result: { id: item.params.taskId, revision: 2 },
});

test("accepted manual run survives a failed Task refresh without a second submission", async (t) => {
  const item = entry("areal/task/runNow", { taskId: "manual", expectedRevision: 1 });
  const accepted = { taskId: "manual", runId: "original-run", accepted: true, revision: 2 };
  let reads = 0;
  const f = await fixture(t, [], async (method) => {
    assert.equal(method, "areal/task/read");
    if (reads++ === 0) return { id: "manual", mode: "manual" };
    throw new Error("Task view temporarily unavailable");
  });
  f.project.client.capabilities.methods = ["areal/task/runNow"];
  let submissions = 0;
  f.backend.submit = async (_project, method, params, options) => {
    submissions++;
    assert.equal(method, item.method);
    assert.equal(options.requestId, item.params.requestId);
    return accepted;
  };
  const result = await manageTask(f.backend, f.project, {
    operation: "taskRunNow",
    ...item.params,
  });
  assert.deepEqual(result, accepted);
  assert.equal(submissions, 1);
  assert.ok(reads >= 2, "preflight read succeeds; only the post-admission refresh fails");
  assert.ok(f.project.refreshErrors[item.params.requestId]);
  assert.equal(f.project.refreshErrors[item.params.requestId].operation.target.taskId, "manual");
});

test("manual-run receipt reconciles its original request and refreshes a Task rather than its admission reply", async (t) => {
  const item = entry("areal/task/runNow", { taskId: "manual", expectedRevision: 1 });
  const accepted = { taskId: "manual", runId: "original-run", accepted: true, revision: 2 };
  const task = { id: "manual", revision: 2, runs: [{ id: "original-run", status: "running" }] };
  const installed = [];
  const f = await fixture(t, [item], async (method) => {
    if (method === "areal/request/read") return { data: [{ ...receipt(item), result: accepted }] };
    assert.equal(method, "areal/task/read");
    return task;
  });
  f.project.model.setTask = (value) => installed.push(value);
  await f.backend.reconcile(f.project);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.project.outcomes[item.params.requestId].accepted, true);
  assert.deepEqual(f.project.pending, []);
  assert.deepEqual(installed, [task]);
  assert.deepEqual(
    f.calls.map((call) => call.method),
    ["areal/request/read", "areal/task/read"],
  );
});

test("command declarations distinguish mixed reads, subscriptions and recoverable writes", () => {
  for (const name of Object.keys(contract.commandDefinitions))
    assert.ok(contract.commandDefinitions[name][2], name);
  for (const [name, operation, effect] of [
    ["manage", "task", "read"],
    ["manage", "taskWatch", "subscription"],
    ["manage", "taskPause", "mutation"],
    ["manage", "pluginSubmission", "read"],
    ["side", "context", "read"],
    ["resources", "skillRead", "read"],
    ["providers", "revealKey", "read"],
    ["library", "readThread", "mutation"],
  ])
    assert.equal(
      contract.commandSemantics(name, { operation }).effect,
      effect,
      `${name}/${operation}`,
    );
  assert.equal(contract.commandSemantics("create", {}).requestId, "requestId");
  assert.equal(
    contract.commandSemantics("manage", { operation: "taskDraftStart" }).requestId,
    "draftId",
  );
  assert.throws(() => contract.commandSemantics("manage", { operation: "futureRead" }));
});
test("task reconciliation ignores crossed targets and settles independent receipt after a failed lookup", async (t) => {
  const a = entry("areal/task/pause", { taskId: "a" }),
    b = entry("areal/task/update", { taskId: "b" });
  let phase = 0;
  const f = await fixture(t, [a, b], async (method, params) => {
    assert.equal(method, "areal/request/read");
    if (params.requestId === a.params.requestId) {
      if (phase === 0) throw new Error("lookup unavailable");
      return {
        data: [
          {
            ...receipt(a),
            operation: { ...receipt(a).operation, target: { kind: "task", taskId: "other" } },
          },
        ],
      };
    }
    return { data: [receipt(b)] };
  });
  await f.backend.reconcile(f.project);
  phase++;
  assert.equal(f.project.outcomes[b.params.requestId]?.accepted, true);
  assert.deepEqual(f.project.pending, [a]);
  await f.backend.reconcile(f.project);
  assert.deepEqual(f.project.pending, [a]);
});
test("completed error receipt preserves admitted execution failure", async (t) => {
  const item = entry("areal/provider/upsert", {});
  const f = await fixture(t, [item], async () => ({
    data: [
      {
        method: item.method,
        requestId: item.params.requestId,
        operation: {
          method: item.method,
          requestId: item.params.requestId,
          target: { kind: "project" },
        },
        status: "failed",
        accepted: false,
        error: { message: "effect failed after admission", code: -32603 },
      },
    ],
  }));
  await f.backend.reconcile(f.project);
  assert.equal(f.project.outcomes[item.params.requestId]?.accepted, true);
  assert.equal(f.project.outcomes[item.params.requestId]?.status, "failed");
  assert.equal(f.project.pending.length, 0);
});
test("legacy configuration recovery only observes and retains unknown original identity", async (t) => {
  const item = {
    method: "areal/thread/configure",
    localOnly: true,
    params: { threadId: "thread", expectedRevision: 1 },
  };
  const f = await fixture(t, [item], async (method) => {
    assert.equal(method, "areal/thread/inspect");
    return { configuration: { revision: 1 } };
  });
  await f.backend.reconcile(f.project);
  assert.deepEqual(f.project.pending, [item]);
  assert.equal(item.params.requestId, undefined);
  assert.equal(
    f.calls.some((call) => call.method === "areal/thread/configure"),
    false,
  );
});

test("only a matching retired-instance proof settles creation as not admitted", async (t) => {
  const binding = { identity: "owner", journalEpoch: randomUUID(), coreInstanceId: randomUUID() };
  const item = entry("areal/thread/start", { creationAdmission: binding });
  let proof;
  const f = await fixture(t, [item], async (method, params) => {
    assert.equal(method, "areal/request/read");
    assert.deepEqual(params.creationAdmission, binding);
    return { data: [], ...(proof ? { creationAdmission: proof } : {}) };
  });
  f.project.client.capabilities.features.threadCreationJournal = {
    version: 1,
    binding: { ...binding, coreInstanceId: randomUUID() },
  };
  const expected = {
    ...binding,
    requestId: item.params.requestId,
    method: item.method,
    status: "notAdmitted",
  };
  for (const value of [
    undefined,
    { ...expected, status: "unconfirmed" },
    { ...expected, status: "admitted" },
    { ...expected, requestId: randomUUID() },
    { ...expected, identity: "other-owner" },
    { ...expected, journalEpoch: randomUUID() },
    { ...expected, coreInstanceId: randomUUID() },
  ]) {
    proof = value;
    await f.backend.reconcile(f.project);
    assert.deepEqual(f.project.pending, [item]);
    assert.equal(f.project.outcomes[item.params.requestId], undefined);
  }
  proof = expected;
  f.project.client.capabilities.features.threadCreationJournal.binding = binding;
  await f.backend.reconcile(f.project);
  assert.deepEqual(f.project.pending, [item], "same-instance absence is never a rejection");
  f.project.client.capabilities.features.threadCreationJournal.binding = {
    ...binding,
    coreInstanceId: randomUUID(),
  };
  await f.backend.reconcile(f.project);
  assert.deepEqual(f.project.pending, []);
  assert.equal(f.project.outcomes[item.params.requestId].accepted, false);
  assert.equal(f.project.outcomes[item.params.requestId].admissionState, "notAdmitted");
  assert.equal(f.project.outcomes[item.params.requestId].status, "failed");
  assert.ok(f.calls.every((call) => call.method === "areal/request/read"));
});

test("legacy creation never infers rejection from a negative proof without its original binding", async (t) => {
  const item = entry("areal/thread/start", {});
  const f = await fixture(t, [item], async () => ({
    data: [],
    creationAdmission: {
      identity: "owner",
      journalEpoch: randomUUID(),
      coreInstanceId: randomUUID(),
      requestId: item.params.requestId,
      method: item.method,
      status: "notAdmitted",
    },
  }));
  await f.backend.reconcile(f.project);
  assert.deepEqual(f.project.pending, [item]);
  assert.equal(f.project.outcomes[item.params.requestId], undefined);
});

test("a proven rejection is persisted before pending is removed and never resubmits", async (t) => {
  const binding = { identity: "owner", journalEpoch: randomUUID(), coreInstanceId: randomUUID() };
  const item = entry("areal/thread/start", { creationAdmission: binding });
  const f = await fixture(t, [item], async () => ({
    data: [],
    creationAdmission: {
      ...binding,
      requestId: item.params.requestId,
      method: item.method,
      status: "notAdmitted",
    },
  }));
  f.project.client.capabilities.features.threadCreationJournal = {
    version: 1,
    binding: { ...binding, coreInstanceId: randomUUID() },
  };
  const journal = f.backend.host.journal(f.project.id);
  const change = journal.change;
  journal.change = async (mutate) => {
    const { snapshot } = await journal.read();
    const next = mutate(snapshot);
    if (Object.keys(next.outcomes).length) throw new Error("fixture: outcome disk unavailable");
    return change(mutate);
  };
  await f.backend.reconcile(f.project);
  assert.deepEqual(f.project.pending, [item]);
  journal.change = change;
  await f.backend.reconcile(f.project);
  assert.deepEqual(f.project.pending, []);
  assert.equal(f.project.outcomes[item.params.requestId].accepted, false);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every((call) => call.method === "areal/request/read"));
});

test("new creation freezes its advertised Core binding and send time in the pending record", async (t) => {
  const binding = { identity: "owner", journalEpoch: randomUUID(), coreInstanceId: randomUUID() };
  let original;
  const f = await fixture(t, [], async (method, params) => {
    assert.equal(method, "areal/thread/start");
    original = structuredClone(f.project.pending[0]);
    assert.deepEqual(original.params.creationAdmission, binding);
    assert.ok(Number.isFinite(Date.parse(original.createdAt)));
    assert.deepEqual(params.creationAdmission, binding);
    return { thread: { id: "created-once" } };
  });
  f.project.client.capabilities.features.threadCreationJournal = { version: 1, binding };
  await f.backend.submit(f.project, "areal/thread/start", {});
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.project.pending, []);
  assert.ok(original);
});

test("a rebuilt journal retains only this project's live submission and settles its original request", async (t) => {
  const started = Promise.withResolvers();
  const response = Promise.withResolvers();
  const requestId = randomUUID();
  const f = await fixture(t, [], async (method) => {
    if (method === "areal/request/read") return { data: [] };
    assert.equal(method, "areal/thread/start");
    started.resolve();
    return response.promise;
  });
  const submitting = f.backend.submit(f.project, "areal/thread/start", {}, { requestId });
  await started.promise;
  const original = f.project.pending[0];
  const other = entry("areal/queue/pause", { threadId: "other-thread" });
  await f.backend.changePending(f.project, () => structuredClone([original, other]));
  const anotherProject = {
    ...f.project,
    id: "another-project",
    pending: [structuredClone(original)],
  };
  f.backend.projects = new Map([
    [f.project.id, f.project],
    [anotherProject.id, anotherProject],
  ]);
  f.backend.cloudConversations = {
    mergeSnapshot: (_id, state) => state,
    projection: () => ({ summaries: [] }),
  };
  f.backend.ownerTasks = { revision: () => 0 };
  f.backend.lifecycleOperations.schedulingSuppressed = () => false;
  f.backend.host.scheduling = () => ({ suppressed: false, activationError: null });
  f.backend.providers.catalog = (models) => models;
  f.backend.providers.manages = () => false;
  f.project.model.getSnapshot = () => null;
  const snapshot = (project) => snapshotProject(f.backend, project, new Set());
  try {
    assert.notEqual(f.project.pending[0], original);
    await assert.rejects(
      f.backend.submit(f.project, "areal/thread/start", {}, { requestId }),
      /请求标识已使用/,
    );
    assert.deepEqual(
      snapshot(f.project).pending.map((item) => item.awaitingResponse),
      [true, false],
    );
    assert.equal(snapshot(anotherProject).pending[0].awaitingResponse, false);
    assert.deepEqual(await f.backend.readSubmission(f.project, original.method, original.params), {
      confirmed: false,
      state: "admitted",
    });
    assert.equal(
      f.calls.length,
      1,
      "the live submission is not reconciled while its response is pending",
    );
    assert.deepEqual(
      await f.backend.readSubmission(anotherProject, original.method, original.params),
      {
        confirmed: false,
        state: "unconfirmed",
      },
    );
    assert.deepEqual(await f.backend.readSubmission(f.project, other.method, other.params), {
      confirmed: false,
      state: "unconfirmed",
    });
  } finally {
    response.resolve({ thread: { id: "created-once" } });
    await submitting;
  }
  assert.deepEqual(f.project.pending, [other]);
  assert.equal(f.project.outcomes[requestId].threadId, "created-once");
  assert.deepEqual(anotherProject.pending, [original]);
  assert.equal(snapshot(anotherProject).pending[0].awaitingResponse, false);
  assert.equal(f.calls.filter((call) => call.method === "areal/thread/start").length, 1);
});

test("a journal rebuilt while reading a receipt settles only the original pending identity", async (t) => {
  const item = entry("areal/task/update", { taskId: "task", expectedRevision: 1 });
  const other = entry("areal/task/update", { taskId: "other-task", expectedRevision: 1 });
  const f = await fixture(t, [item], async (method) => {
    if (method === "areal/request/read") {
      await f.backend.changePending(f.project, () => structuredClone([item, other]));
      return { data: [receipt(item)] };
    }
    assert.equal(method, "areal/task/read");
    return { id: "task", mode: "manual", revision: 2 };
  });
  await f.backend.reconcile(f.project);
  assert.deepEqual(f.project.pending, [other]);
  assert.equal(f.project.outcomes[item.params.requestId].status, "completed");
  assert.equal(f.project.outcomes[other.params.requestId], undefined);
});

test("a rebuilt Remote control journal preserves the original interaction and operation identity", async (t) => {
  const started = Promise.withResolvers();
  const response = Promise.withResolvers();
  const f = await fixture(t, [], async () => {
    throw new Error("control recovery must not query Core while dispatch is pending");
  });
  const remote = {
    hostId: "host",
    devicePeerId: "device",
    projectId: f.project.id,
    commandId: "command",
    method: "interaction.respond",
    capability: "control",
    semanticDigest: "digest",
    target: {},
  };
  const submitting = f.backend.submit(
    f.project,
    "areal/interaction/respond",
    {
      requestId: "interaction-request",
      threadId: "thread",
      turnId: "turn",
    },
    {
      remote,
      dispatch: async () => {
        started.resolve();
        return response.promise;
      },
    },
  );
  await started.promise;
  const original = f.project.pending[0];
  const other = {
    ...structuredClone(original),
    operationId: randomUUID(),
    remote: { ...remote, commandId: "other-command" },
  };
  await f.backend.changePending(f.project, () => structuredClone([original, other]));
  try {
    const recovered = await f.backend.readRemoteRecord(f.project, remote);
    assert.equal(recovered.params.requestId, "interaction-request");
    assert.equal(recovered.operationId, original.operationId);
    assert.equal(f.calls.length, 0);
    await f.backend.reconcile(f.project);
    assert.deepEqual(f.project.pending, [original, other]);
  } finally {
    response.resolve({});
    await submitting;
  }
  assert.deepEqual(f.project.pending, [other]);
  assert.equal(f.project.outcomes[original.operationId].admissionState, "accepted");
  assert.equal(f.project.outcomes[other.operationId], undefined);
});

test("conflicting side creation returns the original operation identity without another write", async (t) => {
  const item = entry("areal/side/create", { sourceThreadId: "parent" });
  const f = await fixture(t, [item], async () => {
    throw new Error("must not dispatch");
  });
  await assert.rejects(
    f.backend.submit(
      f.project,
      item.method,
      { sourceThreadId: "parent" },
      { requestId: randomUUID() },
    ),
    (error) => {
      assert.equal(error.requestId, item.params.requestId);
      assert.equal(error.outcome.operation.requestId, item.params.requestId);
      assert.equal(error.outcome.kind, "unconfirmed");
      assert.equal(error.recovery.kind, "queryOriginal");
      return true;
    },
  );
  assert.deepEqual(f.project.pending, [item]);
  assert.equal(f.calls.length, 0);
});

for (const failed of [false, true]) {
  test(`side manual recovery settles the original ${failed ? "failed" : "successful"} receipt through the shared journal`, async (t) => {
    const item = entry("areal/side/create", { sourceThreadId: "parent" });
    const f = await fixture(t, [item], async (method) => {
      assert.equal(method, "areal/request/read");
      return {
        data: [
          {
            requestId: item.params.requestId,
            method: item.method,
            threadId: "child",
            operation: {
              requestId: item.params.requestId,
              method: item.method,
              target: { kind: "thread", threadId: "child" },
            },
            status: failed ? "failed" : "completed",
            ...(failed
              ? { error: { code: -32000, message: "Side creation failed" } }
              : { result: { thread: { id: "child" }, turn: { id: "turn" } } }),
          },
        ],
      };
    });
    f.backend.worktrees = { assertAvailable() {}, records: new Map() };
    f.backend.worktreeAdmission = { admit: async () => {} };
    f.backend.start = async () => f.project;
    f.backend.refreshAfterAdmission = async () => {};
    f.project.client.capabilities.methods = ["areal/side/start"];
    const request = {
      operation: "recover",
      projectId: f.project.id,
      method: item.method,
      ...item.params,
    };
    const result = await f.backend.dispatchCommand({ name: "side", request }, {});
    contract.validateCommandResponse("side", request, result);
    assert.equal(result.confirmed, true);
    assert.deepEqual(f.project.pending, []);
    assert.equal(f.project.outcomes[item.params.requestId].status, failed ? "failed" : "completed");
    if (failed) {
      assert.equal(result.status, "failed");
      assert.equal(result.accepted, true, "a failed admitted operation is not a rejection");
      assert.match(result.message, /Side creation failed/);
    } else {
      assert.equal(result.threadId, "child");
      assert.equal(result.turnId, "turn");
    }
    assert.equal(f.calls.length, 1);
  });
}

test("side recovery with a different source cannot consume the original pending receipt", async (t) => {
  const item = entry("areal/side/create", { sourceThreadId: "parent" });
  const f = await fixture(t, [item], async () => {
    throw new Error("must not read");
  });
  await assert.rejects(
    f.backend.readSubmission(f.project, item.method, { ...item.params, sourceThreadId: "other" }),
    /身份不匹配/,
  );
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.project.pending, [item]);
});
