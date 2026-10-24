"use strict";
const assert = require("node:assert/strict");
const { test, after } = require("node:test");
const { mkdtemp, mkdir, realpath, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const coreProcess = require("../app/src/core/core-process.cjs");
const originalExecute = coreProcess.executeCore;
let execute;
coreProcess.executeCore = (...args) => execute(...args);
const { taskCatalog } = require("../app/src/core/task-catalog.cjs");
const { validateCommand, validateCommandResponse, commandSemantics } = require("../packages/workbench/client/desktop-contract.cjs");
after(() => { coreProcess.executeCore = originalExecute; });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const request = { operation: "preview", projectId: "owner", requestId: "11111111-1111-1111-1111-111111111111", viewEpoch: 4 };

async function fixture(t) {
  const home = await mkdtemp("/private/tmp/areal-catalog-preview-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, "workspace"), dataDir = join(home, "owner", "state");
  await Promise.all([mkdir(root), mkdir(dataDir, { recursive: true })]);
  const target = { workspace: await realpath(root), dataDir: await realpath(dataDir) };
  target.instanceId = createHash("sha256").update(target.dataDir).digest("hex").slice(0, 24);
  const task = { id: "scheduled", mode: "scheduled", sourceThreadId: "source", objective: "Saved task", revision: 99, runs: [] };
  const response = { version: 1, target, source: "published", executionState: "unobserved", catalog: { kind: "snapshot", rootDigest: "a".repeat(64), data: [task], hasMore: false } };
  const calls = [];
  execute = async (binary, args, options) => { calls.push({ binary, args, options }); return { stdout: JSON.stringify(response) }; };
  const backend = { home, binary: "/trusted/areal", saved: [{ id: "owner", root }], library: { value: { projects: {} } },
    hooks: { environment: () => ({ FIXTURE: "1" }) }, providers: { redact: value => value },
    lifecycleOperations: { assertProject() {} },
    readConnection() { assert.fail("preview must not start or authenticate Core"); },
    projects: new Map([["owner", { model: { setTask() { assert.fail("published rows must not enter the live model"); } } }]]),
    taskWorkspaceOwners: { observeTasks() { assert.fail("preview must not alter execution-owner observations"); } } };
  return { backend, response, calls, task };
}

test("preview is a bounded read capability with an unobserved response", () => {
  validateCommand("tasks", request);
  assert.equal(commandSemantics("tasks", request).effect, "read");
  const response = { ...request, data: [], errors: [], hasMore: false, source: "published", executionState: "unobserved", owners: [{ projectId: "owner", status: "unobserved" }] };
  validateCommandResponse("tasks", request, response);
  for (const extra of [{ source: "live" }, { executionState: "ready" }, { owners: [{ projectId: "owner", status: "ready", connectionGeneration: 1 }] }])
    assert.throws(() => validateCommandResponse("tasks", request, { ...response, ...extra }));
  assert.throws(() => validateCommand("tasks", { ...request, path: "/private/state" }));
});

test("published preview uses only trusted CLI and keeps model and execution ownership unchanged", async t => {
  const f = await fixture(t);
  const result = await taskCatalog(f.backend, { ...request, limit: 12, sourceThreadId: "source" });
  assert.equal(result.source, "published");
  assert.equal(result.executionState, "unobserved");
  assert.equal(result.data[0].id, f.task.id);
  assert.equal(result.data[0].projectId, "owner");
  assert.deepEqual(result.owners, [{ projectId: "owner", status: "unobserved" }]);
  assert.equal(result.requestId, request.requestId);
  assert.equal(result.viewEpoch, request.viewEpoch);
  assert.deepEqual(f.calls[0].args, ["service", "task-catalog", "--workspace", f.backend.saved[0].root, "--data-dir", join(f.backend.home, "owner", "state"), "--limit", "12", "--source-thread-id", "source", "--json"]);
  assert.equal(f.calls[0].binary, "/trusted/areal");
  assert.ok(f.calls[0].options.timeout > 0 && f.calls[0].options.timeout <= 10000);
  assert.ok(f.calls[0].options.maxBuffer <= 2 * 1024 * 1024);
});

test("preview rejects wrong target and observation metadata", async t => {
  const f = await fixture(t), valid = structuredClone(f.response);
  for (const value of [
    { ...valid, target: { ...valid.target, workspace: "/other" } },
    { ...valid, target: { ...valid.target, dataDir: "/other" } },
    { ...valid, target: { ...valid.target, instanceId: "0".repeat(24) } },
    { ...valid, executionState: "ready" },
    { ...valid, source: "live" },
    { ...valid, version: 2 },
    { ...valid, catalog: { ...valid.catalog, rootDigest: "invalid" } },
    { ...valid, catalog: { ...valid.catalog, data: [{ id: "interactive", mode: "interactive" }] } },
  ]) {
    execute = async () => ({ stdout: JSON.stringify(value) });
    const result = await taskCatalog(f.backend, request);
    assert.deepEqual(result.data, []);
    assert.equal(result.errors.length, 1);
    assert.equal(result.owners[0].status, "error");
  }
});

test("missing and legacy catalog remain unobserved and preserve live fallback", async t => {
  const f = await fixture(t);
  for (const catalog of [{ kind: "empty" }, { kind: "requiresCore", reason: "unbound" }, { kind: "requiresCore", reason: "legacyFormat" }, { kind: "requiresCore", reason: "readBudgetExceeded" }]) {
    f.response.catalog = catalog;
    const result = await taskCatalog(f.backend, request);
    assert.deepEqual(result.data, []);
    assert.equal(result.executionState, "unobserved");
    assert.equal(result.owners[0].status, "unobserved");
  }
});

test("preview rejects a different source Thread from the bounded source request", async t => {
  const f = await fixture(t);
  f.response.catalog.data[0].sourceThreadId = "other-source";
  const result = await taskCatalog(f.backend, { ...request, sourceThreadId: "source" });
  assert.deepEqual(result.data, []);
  assert.equal(result.errors.length, 1);
});

test("removed or lifecycle-blocked execution owner cannot publish late preview", async t => {
  const f = await fixture(t), gate = deferred();
  execute = async () => { await gate.promise; return { stdout: JSON.stringify(f.response) }; };
  const pending = taskCatalog(f.backend, request);
  await new Promise(resolve => setImmediate(resolve));
  f.backend.saved = [];
  gate.resolve();
  const result = await pending;
  assert.deepEqual(result.data, []);
  assert.equal(result.errors.length, 1);
  f.backend.saved = [{ id: "owner", root: f.response.target.workspace }];
  f.backend.lifecycleOperations.assertProject = () => { throw new Error("owner stopping"); };
  assert.equal((await taskCatalog(f.backend, request)).errors.length, 1);
});

test("logical preview keeps each execution owner mapping", async t => {
  const f = await fixture(t);
  const executionRoot = join(f.backend.home, "execution-workspace"), executionData = join(f.backend.home, "execution", "state");
  const otherRoot = join(f.backend.home, "other-workspace"), otherData = join(f.backend.home, "other", "state");
  await Promise.all([mkdir(executionRoot), mkdir(executionData, { recursive: true }), mkdir(otherRoot), mkdir(otherData, { recursive: true })]);
  f.backend.saved.push({ id: "execution", logicalProjectId: "owner", root: executionRoot });
  f.backend.saved.push({ id: "other", root: otherRoot });
  const gate = deferred();
  let active = 0, maximumActive = 0;
  execute = async (_binary, args) => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    await gate.promise;
    const dataDir = await realpath(args[args.indexOf("--data-dir") + 1]);
    const workspace = await realpath(args[args.indexOf("--workspace") + 1]);
    active--;
    return { stdout: JSON.stringify({ ...f.response, target: { workspace, dataDir, instanceId: createHash("sha256").update(dataDir).digest("hex").slice(0, 24) } }) };
  };
  const first = taskCatalog(f.backend, request), second = taskCatalog(f.backend, { ...request, projectId: "other" });
  await new Promise(resolve => setImmediate(resolve));
  gate.resolve();
  const [result, other] = await Promise.all([first, second]);
  assert.equal(result.data.length, 2);
  assert.equal(other.data.length, 1, "concurrent logical owners must retain every execution owner");
  assert.ok(maximumActive <= 2, "published CLI concurrency stays bounded across logical requests");
  assert.deepEqual(other.errors, []);
  assert.deepEqual(result.data.map(row => [row.projectId, row.executionProjectId]), [["owner", undefined], ["owner", "execution"]]);
  assert.deepEqual(result.owners, [{ projectId: "owner", status: "unobserved" }]);
});
