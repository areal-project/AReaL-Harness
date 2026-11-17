import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { trackedMkdtemp } from "./support/host-cleanup.cjs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(new URL("../app/package.json", import.meta.url));
const { publicStatus } = require("@areal/workbench/desktop-contract/trajectory");
const { CoreBackend } = require("@areal/workbench-service/desktop/core/backend.cjs");
const { validateCommand } = require("@areal/workbench/desktop-contract");
const { hostCoreClient } = createRequire(import.meta.url)("./support/host-core-fixture.cjs");
const status = {
  enabled: true,
  state: "degraded",
  endpoint: "https://collector.example.test/ingest",
  configPath: "/isolated/config with spaces.toml",
  spool_dir: "/isolated/spool",
  worker_running: false,
  queue: {
    pending: 1,
    uploading: 0,
    failed: 1,
    uploaded: 3,
    evicted: 2,
    bytes: 128,
    max_bytes: 1024,
    dropped_memory: 1,
    dropped_oversize: 0,
  },
  last_error: "authentication_failed",
  last_success_at: 1000,
  records: [
    {
      id: "batch-1",
      status: "failed",
      created_at: 900,
      uploaded_at: null,
      attempts: 2,
      next_attempt_at: 2000,
      bytes: 128,
      error: "authentication_failed",
    },
  ],
  limits: { max_retries: 5, upload_interval_ms: 1000, max_memory_bytes: 4096 },
};

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("capture restart fences configuration changes during original Host cleanup", async () => {
  for (const scenario of ["changed", "unchanged", "ordinary", "cleanup-incomplete"]) {
    const stopped = deferred();
    const calls = [];
    const project = { id: "project", service: { serviceId: "service", generation: "original" } };
    let current = "capture-revision";
    const backend = {
      stopProjectForUpdate: CoreBackend.prototype.stopProjectForUpdate,
      lifecycleOperations: {
        generation: "desktop",
        assertProject: (id) => assert.equal(id, project.id),
        request: async (request) => {
          assert.equal(request.kind, "updateProject");
          assert.equal(request.mode, "ifIdle");
          assert.deepEqual(request.expectedTargets, [
            { projectId: project.id, serviceId: "service", generation: "original" },
          ]);
          calls.push("stop");
          await stopped.promise;
          return { phase: scenario === "cleanup-incomplete" ? "acceptedPending" : "completed" };
        },
      },
      providers: {
        config: {
          current: async () => {
            calls.push("read");
            return { revision: current };
          },
        },
      },
      launch: async () => calls.push("launch"),
      connect: async () => calls.push("connect"),
      reconcile: async () => calls.push("reconcile"),
      resources: { worktrees: { apply: async () => calls.push("worktree") } },
    };
    const restarting = CoreBackend.prototype.restartProject.call(
      backend,
      project,
      scenario === "ordinary" ? undefined : { expectedRevision: current },
    );
    assert.deepEqual(calls, ["stop"]);
    if (scenario === "changed" || scenario === "ordinary") current = "unrelated-model-edit";
    stopped.resolve();
    if (scenario === "changed") {
      await assert.rejects(restarting, /配置已有其它变化/);
      assert.deepEqual(calls, ["stop", "read"]);
      continue;
    }
    if (scenario === "cleanup-incomplete") {
      await assert.rejects(restarting, { code: "LIFECYCLE_INCOMPLETE" });
      assert.deepEqual(calls, ["stop"]);
      continue;
    }
    await restarting;
    assert.deepEqual(calls, [
      "stop",
      ...(scenario === "unchanged" ? ["read"] : []),
      "launch",
      "connect",
      "reconcile",
      "worktree",
    ]);
  }
});

async function backendFixture(t) {
  const home = await trackedMkdtemp(join(tmpdir(), "areal-trajectory-backend-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const backend = new CoreBackend({ binary: process.execPath, home });
  backend.saved = [];
  return backend;
}

test("trajectory operations require Host protocol while invalid requests and shutdown gates stay intact", async (t) => {
  const backend = await backendFixture(t);
  await assert.rejects(backend.command("trajectory", { operation: "status" }), /Host protocol/);
  await assert.rejects(backend.command("trajectory", { operation: "retry" }), /Host protocol/);
  for (const gate of ["providerUpdating", "resourcesUpdating"]) {
    backend[gate] = true;
    await assert.rejects(
      backend.command("trajectory", { operation: "status", config: "/other.toml" }),
      { code: "INVALID_DESKTOP_REQUEST" },
    );
    await assert.rejects(backend.command("trajectory", { operation: "retry" }), /Host protocol/);
    await assert.rejects(backend.command("trajectory", { operation: "unknown" }), {
      code: "INVALID_DESKTOP_REQUEST",
    });
    await assert.rejects(
      backend.command("send", { projectId: "p", threadId: "t", text: "hello" }),
      /配置正在应用/,
    );
    assert.equal(backend.activeCommands, 0);
    backend[gate] = false;
  }
  await assert.rejects(backend.command("trajectory", { operation: "unknown" }), {
    code: "INVALID_DESKTOP_REQUEST",
  });
  assert.equal(backend.activeCommands, 0);
  backend.closing = true;
  for (const [name, request, pattern] of [
    ["trajectory", { operation: "status" }, /Host protocol/],
    ["trajectory", { operation: "retry" }, /Host protocol/],
    ["send", { projectId: "p", threadId: "t", text: "hello" }, /应用正在退出/],
  ]) {
    await assert.rejects(backend.command(name, request), pattern);
  }
  assert.equal(backend.activeCommands, 0);
});

test("ordinary send still counts as work and releases admission on completion", async (t) => {
  const backend = await backendFixture(t);
  const submitted = deferred(),
    releaseSend = deferred();
  t.after(() => {
    releaseSend.resolve();
  });
  await assert.rejects(backend.command("trajectory", { operation: "retry" }), /Host protocol/);
  assert.equal(backend.activeCommands, 0);

  const project = {
    id: "a".repeat(24),
    root: backend.home,
    model: { state: { threads: {} } },
    client: await hostCoreClient({
      capabilities: { methods: ["areal/turn/submit"], features: { ordinaryTurnSubmit: true } },
      request: async (method, params) => {
        if (method === "thread/read") {
          assert.deepEqual(params, { threadId: "thread", includeTurns: false });
          return { thread: { id: "thread", sessionId: "thread" } };
        }
        assert.equal(method, "areal/task/list");
        assert.deepEqual(params, { limit: 100 });
        return { data: [], nextCursor: null };
      },
    }),
    configurations: { thread: { revision: 0 } },
  };
  backend.start = async (id) => {
    assert.equal(id, project.id);
    return project;
  };
  backend.submit = async (value, method, params) => {
    assert.equal(value, project);
    assert.equal(method, "areal/turn/submit");
    assert.deepEqual(params, {
      threadId: "thread",
      expectedConfigRevision: 0,
      intent: { type: "message", input: [{ type: "text", text: "fixture" }] },
    });
    submitted.resolve();
    await releaseSend.promise;
    return { turn: { id: "turn" } };
  };
  const sending = backend.command("send", {
    projectId: project.id,
    threadId: "thread",
    text: "fixture",
  });
  await Promise.race([
    submitted.promise,
    sending.then(() => {
      throw new Error("send completed before submit");
    }),
  ]);
  assert.equal(backend.activeCommands, 1);
  await assert.rejects(
    backend.command("providers", { operation: "apply", expectedRevision: "fixture" }),
    { code: "CAPABILITY_UNAVAILABLE" },
  );
  releaseSend.resolve();
  await sending;
  assert.equal(backend.activeCommands, 0);
});

test("desktop trajectory capability rejects configuration and destination overrides", () => {
  for (const operation of ["status", "retry"])
    validateCommand("trajectory", { operation }, { serviceOnly: true });
  for (const params of [
    {},
    { operation: "sync-config" },
    { operation: "retry", endpoint: "https://untrusted.example" },
    { operation: "status", config: "/other.toml" },
    { operation: "status", projectId: "project" },
  ]) {
    assert.throws(() => validateCommand("trajectory", params), { code: "INVALID_DESKTOP_REQUEST" });
  }
});

test("optional execution metadata is projected without changing legacy records", () => {
  const metadata = {
    turn_id: "turn-42",
    event_name: "areal.turn.completed",
    model_name: "fixture-model",
    harness_version: "0.1.4",
    execution_duration_ms: 0,
    occurred_at: 800,
  };
  const enriched = { ...status, records: [{ ...status.records[0], ...metadata }] };
  assert.deepEqual(
    publicStatus({
      ...enriched,
      credential: "must-not-cross-ipc",
      records: [{ ...enriched.records[0], internal_trace: "private" }],
    }),
    enriched,
  );
  const missing = {
    ...status,
    records: [{ ...status.records[0], occurred_at: null, model_name: null }],
  };
  assert.deepEqual(publicStatus(missing), missing);
  for (const invalid of [
    { model_name: 5 },
    { occurred_at: "800" },
    { execution_duration_ms: -1 },
  ]) {
    assert.throws(
      () =>
        publicStatus({
          ...status,
          records: [{ ...status.records[0], ...invalid }],
        }),
      /无效的数据飞轮状态/,
    );
  }
});

test("model timing keeps fractional calls and bounded window summary without private fields", () => {
  const summary = {
    scope: "recent_records",
    record_limit: 100,
    records_considered: 1,
    model_calls: 1,
    total_duration_ms: 125.5,
    mean_duration_ms: 125.5,
    max_duration_ms: 125.5,
  };
  const expected = {
    ...status,
    records: [
      {
        ...status.records[0],
        event_name: "gen_ai.client.inference.operation.details",
        model_call_duration_ms: 125.5,
      },
    ],
    model_call_summary: summary,
  };
  assert.deepEqual(
    publicStatus({ ...expected, model_call_summary: { ...summary, raw_request: "private" } }),
    expected,
  );
  assert.deepEqual(publicStatus(status), status);
  const unknown = {
    ...status,
    records: [{ ...status.records[0], model_call_duration_ms: null }],
    model_call_summary: {
      ...summary,
      model_calls: 0,
      total_duration_ms: null,
      mean_duration_ms: null,
      max_duration_ms: null,
    },
  };
  assert.deepEqual(publicStatus(unknown), unknown);
  const overflow = {
    ...expected,
    model_call_summary: { ...summary, total_duration_ms: null, mean_duration_ms: null },
  };
  assert.deepEqual(publicStatus(overflow), overflow);
});

test("invalid timing, wrong event and unbounded or mismatched summaries do not cross IPC", () => {
  const record = {
    ...status.records[0],
    event_name: "gen_ai.client.inference.operation.details",
    model_call_duration_ms: 0,
  };
  const summary = {
    scope: "recent_records",
    record_limit: 100,
    records_considered: 1,
    model_calls: 1,
    total_duration_ms: 0,
    mean_duration_ms: 0,
    max_duration_ms: 0,
  };
  const enriched = { ...status, records: [record], model_call_summary: summary };
  assert.equal(publicStatus(enriched).records[0].model_call_duration_ms, 0);
  for (const value of [-1, Infinity, NaN, "125.5"])
    assert.throws(
      () => publicStatus({ ...enriched, records: [{ ...record, model_call_duration_ms: value }] }),
      /无效的数据飞轮状态/,
    );
  assert.throws(
    () =>
      publicStatus({ ...enriched, records: [{ ...record, event_name: "areal.turn.completed" }] }),
    /无效的数据飞轮状态/,
  );
  for (const patch of [
    { scope: "all_history" },
    { record_limit: 101 },
    { records_considered: 101 },
    { records_considered: 0 },
    { model_calls: 2 },
    { model_calls: -1 },
    { model_calls: 0 },
    { max_duration_ms: null },
    { mean_duration_ms: null },
    { total_duration_ms: Infinity },
    { max_duration_ms: -1 },
  ])
    assert.throws(
      () => publicStatus({ ...enriched, model_call_summary: { ...summary, ...patch } }),
      /无效的数据飞轮状态/,
    );
});
