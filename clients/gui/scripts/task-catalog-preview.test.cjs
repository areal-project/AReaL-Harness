"use strict";
const { makeTempDir } = require("./support/temp.mjs");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdir, rm } = require("node:fs/promises");
const { join } = require("node:path");
const {
  taskCatalog,
  OwnerTasks,
} = require("@areal/workbench-service/desktop/core/task-catalog.cjs");
const {
  validateCommand,
  validateCommandResponse,
  commandSemantics,
} = require("../packages/workbench/client/desktop-contract.cjs");
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
const request = {
  operation: "preview",
  projectId: "owner",
  requestId: "11111111-1111-1111-1111-111111111111",
  viewEpoch: 4,
};

async function fixture(t) {
  const home = await makeTempDir("areal-catalog-preview-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, "workspace"),
    dataDir = join(home, "owner", "state");
  await Promise.all([mkdir(root), mkdir(dataDir, { recursive: true })]);
  const task = {
    id: "scheduled",
    mode: "scheduled",
    sourceThreadId: "source",
    objectivePreview: "Saved task",
    objectiveTruncated: false,
    revision: 99,
    channelSequence: 0,
    threadId: null,
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
  };
  const response = { data: [task], hasMore: false, coverage: { kind: "snapshot" }, readAt: 1 };
  const calls = [];
  const backend = {
    home,
    rustDomains: [],
    async hostCall(name, params) {
      assert.equal(name, "tasks.preview");
      calls.push(params);
      return response;
    },
    binary: "/trusted/areal",
    host: { resolve: (id) => ({ dataDir: join(home, id, "state") }) },
    saved: [{ id: "owner", root }],
    library: { value: { projects: {} } },
    hooks: { environment: () => ({ FIXTURE: "1" }) },
    providers: { redact: (value) => value },
    lifecycleOperations: { assertProject() {} },
    readConnection() {
      assert.fail("preview must not start or authenticate Core");
    },
    projects: new Map([
      [
        "owner",
        {
          model: {
            setTask() {
              assert.fail("published rows must not enter the live model");
            },
          },
        },
      ],
    ]),
    taskWorkspaceOwners: {
      observeTasks() {
        assert.fail("preview must not alter execution-owner observations");
      },
    },
  };
  backend.ownerTasks = new OwnerTasks(backend);
  return { backend, response, calls, task, root };
}

test("preview is a bounded read capability with an unobserved response", () => {
  validateCommand("tasks", request);
  assert.equal(commandSemantics("tasks", request).effect, "read");
  const response = {
    ...request,
    data: [],
    errors: [],
    hasMore: false,
    source: "published",
    executionState: "unobserved",
    owners: [
      {
        projectId: "owner",
        status: "unobserved",
        source: "published",
        coverage: { kind: "empty" },
        readAt: 1,
      },
    ],
  };
  validateCommandResponse("tasks", request, response);
  for (const extra of [
    { source: "live" },
    { executionState: "ready" },
    { owners: [{ projectId: "owner", status: "ready", connectionGeneration: 1 }] },
  ])
    assert.throws(() => validateCommandResponse("tasks", request, { ...response, ...extra }));
  assert.throws(() => validateCommand("tasks", { ...request, path: "/private/state" }));
});

test("Host published preview keeps model and execution ownership unchanged", async (t) => {
  const f = await fixture(t);
  const result = await taskCatalog(f.backend, { ...request, limit: 12, sourceThreadId: "source" });
  assert.equal(result.source, "published");
  assert.equal(result.executionState, "unobserved");
  assert.equal(result.data[0].id, f.task.id);
  assert.equal(result.data[0].projectId, "owner");
  assert.equal(result.owners[0].projectId, "owner");
  assert.equal(result.owners[0].status, "unobserved");
  assert.equal(result.owners[0].source, "published");
  assert.deepEqual(result.owners[0].coverage, { kind: "snapshot" });
  assert.ok(Number.isSafeInteger(result.owners[0].readAt));
  assert.equal(result.requestId, request.requestId);
  assert.equal(result.viewEpoch, request.viewEpoch);
  const again = await taskCatalog(f.backend, { ...request, sourceThreadId: "source" });
  assert.equal(again.data[0].id, f.task.id);
  assert.equal(f.calls.length, 1, "same owner scopes share one bounded published cache");
});

test("unavailable or malformed Host previews never become live observations", async (t) => {
  const f = await fixture(t);
  for (const value of [
    { ...f.response, data: [{ id: "invalid", mode: "interactive" }] },
    { ...f.response, hasMore: "false" },
    { ...f.response, coverage: null },
    { ...f.response, readAt: "now" },
  ]) {
    f.backend.hostCall = async () => value;
    const result = await taskCatalog(f.backend, request);
    assert.deepEqual(result.data, []);
    assert.equal(result.errors.length, 1);
    assert.equal(result.owners[0].status, "error");
  }
  f.backend.hostCall = async () => {
    throw new Error("original Store binding unavailable");
  };
  assert.equal((await taskCatalog(f.backend, request)).errors.length, 1);
});

test("foreign alias preview leaves original Store resolution inside Host", async (t) => {
  const f = await fixture(t);
  f.backend.host.resolve = () => assert.fail("backend must not resolve an original Host Store");
  const result = await taskCatalog(f.backend, request);
  assert.deepEqual(result.errors, []);
  assert.equal(result.data[0].id, f.task.id);
});

test("missing catalog stays empty while migration failures preserve the previous snapshot", async (t) => {
  const f = await fixture(t);
  Object.assign(f.response, { data: [], hasMore: false, coverage: { kind: "empty" } });
  const empty = await taskCatalog(f.backend, request);
  assert.deepEqual(empty.data, []);
  assert.equal(empty.owners[0].status, "unobserved");
  assert.deepEqual(empty.owners[0].coverage, { kind: "empty" });
  Object.assign(f.response, { data: [f.task], hasMore: false, coverage: { kind: "snapshot" } });
  await taskCatalog(f.backend, { ...request, operation: "list" });
  for (const reason of ["unbound", "legacyFormat", "readBudgetExceeded"]) {
    Object.assign(f.response, {
      data: [],
      hasMore: false,
      coverage: { kind: "requiresCore", reason },
    });
    const query = { ...request, operation: "list" };
    const result = await taskCatalog(f.backend, query);
    assert.equal(result.data[0].id, f.task.id);
    assert.equal(result.owners[0].status, "error");
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, new RegExp(reason));
    assert.equal(f.backend.ownerTasks.published.get("owner").data[0].id, f.task.id);
    validateCommandResponse("tasks", query, result);
  }
});

test("preview filters the shared bounded cache to the requested source Thread", async (t) => {
  const f = await fixture(t);
  f.response.data[0].sourceThreadId = "other-source";
  const result = await taskCatalog(f.backend, { ...request, sourceThreadId: "source" });
  assert.deepEqual(result.data, []);
  assert.deepEqual(result.errors, []);
});

test("removed or lifecycle-blocked execution owner cannot publish late preview", async (t) => {
  const f = await fixture(t),
    gate = deferred();
  f.backend.hostCall = async () => {
    await gate.promise;
    return f.response;
  };
  const pending = taskCatalog(f.backend, request);
  await new Promise((resolve) => setImmediate(resolve));
  f.backend.saved = [];
  gate.resolve();
  const result = await pending;
  assert.deepEqual(result.data, []);
  assert.equal(result.errors.length, 1);
  f.backend.saved = [{ id: "owner", root: f.root }];
  f.backend.lifecycleOperations.assertProject = () => {
    throw new Error("owner stopping");
  };
  assert.equal((await taskCatalog(f.backend, request)).errors.length, 1);
});

test("logical preview keeps each execution owner mapping", async (t) => {
  const f = await fixture(t);
  const executionRoot = join(f.backend.home, "execution-workspace"),
    executionData = join(f.backend.home, "execution", "state");
  const otherRoot = join(f.backend.home, "other-workspace"),
    otherData = join(f.backend.home, "other", "state");
  await Promise.all([
    mkdir(executionRoot),
    mkdir(executionData, { recursive: true }),
    mkdir(otherRoot),
    mkdir(otherData, { recursive: true }),
  ]);
  f.backend.saved.push({ id: "execution", logicalProjectId: "owner", root: executionRoot });
  f.backend.saved.push({ id: "other", root: otherRoot });
  const gate = deferred();
  let active = 0,
    maximumActive = 0;
  f.backend.hostCall = async () => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    await gate.promise;
    active--;
    return structuredClone(f.response);
  };
  const first = taskCatalog(f.backend, request),
    second = taskCatalog(f.backend, { ...request, projectId: "other" });
  await new Promise((resolve) => setImmediate(resolve));
  gate.resolve();
  const [result, other] = await Promise.all([first, second]);
  assert.equal(result.data.length, 2);
  assert.equal(other.data.length, 1, "concurrent logical owners must retain every execution owner");
  assert.ok(
    maximumActive <= 2,
    "published preview concurrency stays bounded across logical requests",
  );
  assert.deepEqual(other.errors, []);
  assert.deepEqual(
    result.data.map((row) => [row.projectId, row.executionProjectId]),
    [
      ["owner", undefined],
      ["owner", "execution"],
    ],
  );
  assert.equal(result.owners[0].projectId, "owner");
  assert.equal(result.owners[0].status, "unobserved");
  assert.equal(result.owners[0].source, "published");
  assert.deepEqual(result.owners[0].coverage, { kind: "snapshot" });
  assert.ok(Number.isSafeInteger(result.owners[0].readAt));
});
