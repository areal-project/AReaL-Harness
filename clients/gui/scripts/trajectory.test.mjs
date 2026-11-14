import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { trackedMkdtemp } from "./support/host-cleanup.cjs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(new URL("../app/package.json", import.meta.url));
const { TrajectoryExport, publicStatus } = require("@areal/workbench-service/trajectory");
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

async function fixture(t) {
  const directory = await trackedMkdtemp(join(tmpdir(), "areal-trajectory-gui-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = join(directory, "core fixture.cjs"),
    response = join(directory, "response.json"),
    calls = join(directory, "calls.json");
  await writeFile(
    binary,
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.FIXTURE_CALLS, JSON.stringify({args:process.argv.slice(2), home:process.env.AREAL_HARNESS_HOME, credential:process.env.AREAL_CREDENTIAL_fixture}));
const value=fs.readFileSync(process.env.FIXTURE_RESPONSE,'utf8');
if(value==='fail') { process.stderr.write('credential fixture-secret rejected'); process.exit(1); }
process.stdout.write(value);
`,
    { mode: 0o700 },
  );
  await writeFile(response, JSON.stringify(status));
  const exporter = new TrajectoryExport({
    binary,
    config: status.configPath,
    hooks: {
      environment: () => ({
        ...process.env,
        AREAL_HARNESS_HOME: directory,
        FIXTURE_CALLS: calls,
        FIXTURE_RESPONSE: response,
      }),
    },
    providers: {
      config: { refreshCredentials: async () => {} },
      environment: () => ({ AREAL_CREDENTIAL_fixture: "fixture-secret" }),
      redact: (text) => text.replaceAll("fixture-secret", "[redacted]"),
    },
  });
  return { exporter, response, calls, directory };
}

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

test(
  "pending background status does not block a real provider apply or count as work",
  { timeout: 5000 },
  async (t) => {
    const backend = await backendFixture(t);
    const pendingStatus = deferred(),
      applyEntered = deferred(),
      releaseApply = deferred();
    t.after(() => {
      pendingStatus.resolve(status);
      releaseApply.resolve();
    });
    let reads = 0,
      statusSettled = false;
    backend.trajectory.command = (request) => {
      validateCommand("trajectory", request);
      assert.equal(request.operation, "status");
      return ++reads === 1 ? pendingStatus.promise : Promise.resolve(status);
    };
    const stages = [];
    const proof = {
      serviceId: "service-project",
      generation: "generation-project",
      applied: { revision: "previous", sequence: 0 },
      modelRevision: "model-previous",
      credentialStates: {},
    };
    const project = {
      id: "project",
      root: join(tmpdir(), "trajectory-admission-project"),
      pending: [],
      model: { state: { threads: {}, queues: {} } },
      service: { serviceId: proof.serviceId, generation: proof.generation },
      providerRevision: "previous",
      client: {
        ready: true,
        capabilities: {
          methods: [
            "areal/server/modelConfiguration/read",
            "areal/server/modelConfiguration/apply",
          ],
        },
        request: async (method, params) => {
          stages.push(method);
          if (method === "areal/server/modelConfiguration/read") {
            assert.deepEqual(params, { expectedGeneration: proof.generation });
            return proof;
          }
          if (method === "areal/server/status") return { restartSafe: true };
          if (method === "areal/model/list") return { data: [] };
          assert.equal(method, "areal/server/modelConfiguration/apply");
          assert.equal(typeof params.requestId, "string");
          assert.deepEqual(params, {
            requestId: params.requestId,
            expectedGeneration: proof.generation,
            expectedApplied: proof.applied,
            targetRevision: "current",
            credentials: {},
          });
          applyEntered.resolve();
          await releaseApply.promise;
          const result = {
            ...proof,
            applied: { revision: "current", sequence: 1 },
            modelRevision: "model-current",
          };
          return {
            ...result,
            operation: { requestId: params.requestId, state: "applied", result },
          };
        },
      },
    };
    backend.projects.set(project.id, project);
    backend.host.sourceId = "fixture-source";
    backend.host.client.sourceState = async () => ({
      sourceId: backend.host.sourceId,
      credentials: { references: [] },
    });
    backend.host.bindings.set(project.id, {
      projectId: project.id,
      sourceId: backend.host.sourceId,
      workspace: project.root,
      dataDir: join(backend.home, "project"),
      scratchDir: join(backend.home, "scratch"),
      alias: { profile: backend.home, legacyProjectId: project.id },
    });
    // Host/Core I/O 用无凭据夹具；配置准入、应用回执校验和结果投影仍走真实实现。
    backend.providers.config.execute = async (operation) => {
      assert.equal(operation, "read");
      return {
        path: join(tmpdir(), "trajectory-admission.toml"),
        revision: "current",
        data: [],
        defaultModel: null,
      };
    };
    backend.restartProject = async () => {
      throw new Error("model configuration must not restart Core");
    };
    const reading = backend.command("trajectory", { operation: "status" }).then((value) => {
      statusSettled = true;
      return value;
    });
    assert.equal(backend.activeCommands, 0);
    const applying = backend.command("providers", {
      operation: "apply",
      expectedRevision: "current",
    });
    await Promise.race([
      applyEntered.promise,
      applying.then(() => {
        throw new Error("apply completed before receipt");
      }),
    ]);
    assert.equal(backend.providerUpdating, true);
    assert.equal(statusSettled, false);
    assert.deepEqual(await backend.command("trajectory", { operation: "status" }), status);
    for (const [name, request] of [
      ["trajectory", { operation: "retry" }],
      ["send", { projectId: project.id, threadId: "thread", text: "fixture" }],
    ]) {
      await assert.rejects(backend.command(name, request), /配置正在应用/);
    }
    assert.equal(backend.activeCommands, 0);
    releaseApply.resolve();
    const applied = await applying;
    assert.deepEqual(stages, [
      "areal/server/modelConfiguration/read",
      "areal/server/status",
      "areal/server/modelConfiguration/apply",
      "areal/model/list",
    ]);
    assert.equal(applied.pendingApply, false);
    assert.equal(applied.projects[0].applied, true);
    assert.equal(backend.providerUpdating, false);
    assert.equal(statusSettled, false);
    pendingStatus.resolve(status);
    assert.deepEqual(await reading, status);
    assert.equal(backend.activeCommands, 0);
  },
);

test("read-only status keeps real validation and closing checks while retry keeps configuration gates", async (t) => {
  const { exporter } = await fixture(t);
  const backend = await backendFixture(t);
  backend.trajectory = exporter;
  for (const gate of ["providerUpdating", "resourcesUpdating"]) {
    backend[gate] = true;
    assert.deepEqual(await backend.command("trajectory", { operation: "status" }), status);
    await assert.rejects(
      backend.command("trajectory", { operation: "status", config: "/other.toml" }),
      { code: "INVALID_DESKTOP_REQUEST" },
    );
    await assert.rejects(backend.command("trajectory", { operation: "retry" }), /配置正在应用/);
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
  for (const [name, request] of [
    ["trajectory", { operation: "status" }],
    ["trajectory", { operation: "retry" }],
    ["send", { projectId: "p", threadId: "t", text: "hello" }],
  ]) {
    await assert.rejects(backend.command(name, request), /应用正在退出/);
  }
  assert.equal(backend.activeCommands, 0);
});

test("explicit retry and ordinary send still count as work and release admission on completion or failure", async (t) => {
  const backend = await backendFixture(t);
  const retry = deferred(),
    retryEntered = deferred(),
    submitted = deferred(),
    releaseSend = deferred();
  t.after(() => {
    retry.resolve(status);
    releaseSend.resolve();
  });
  backend.trajectory.command = (request) => {
    validateCommand("trajectory", request);
    if (request.operation === "retry") {
      retryEntered.resolve();
      return retry.promise;
    }
    return Promise.resolve(status);
  };
  const retrying = backend.command("trajectory", { operation: "retry" });
  await Promise.race([
    retryEntered.promise,
    retrying.then(() => {
      throw new Error("retry completed before admission");
    }),
  ]);
  assert.equal(backend.activeCommands, 1);
  await assert.rejects(
    backend.command("providers", { operation: "apply", expectedRevision: "fixture" }),
    /请等待任务和操作完成/,
  );
  assert.deepEqual(await backend.command("trajectory", { operation: "status" }), status);
  assert.equal(backend.activeCommands, 1);
  const retryFailure = new Error("fixture retry failed");
  const rejected = assert.rejects(retrying, (error) => error === retryFailure);
  retry.reject(retryFailure);
  await rejected;
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
    /请等待任务和操作完成/,
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

test("fixed CLI arguments preserve GUI config and environment; only public fields cross IPC", async (t) => {
  const { exporter, response, calls, directory } = await fixture(t);
  await writeFile(
    response,
    JSON.stringify({
      ...status,
      credential: "must-not-cross-ipc",
      records: [{ ...status.records[0], content: "private trajectory" }],
    }),
  );
  assert.deepEqual(await exporter.command({ operation: "status" }), status);
  assert.deepEqual(JSON.parse(await readFile(calls, "utf8")), {
    args: ["trajectory", "status", "--config", status.configPath],
    home: directory,
  });
  assert.deepEqual(await exporter.command({ operation: "retry" }), status);
  assert.equal(JSON.parse(await readFile(calls, "utf8")).args[1], "retry");
  assert.equal(JSON.parse(await readFile(calls, "utf8")).credential, "fixture-secret");
  const toggle = { operation: "setEnabled", enabled: false, expectedRevision: "a".repeat(64) };
  assert.deepEqual(await exporter.command(toggle), status);
  const toggled = JSON.parse(await readFile(calls, "utf8"));
  assert.deepEqual(toggled.args, [
    "trajectory",
    "set-enabled",
    "false",
    "--expected-revision",
    toggle.expectedRevision,
    "--config",
    status.configPath,
  ]);
  assert.equal(toggled.credential, "fixture-secret");
  await assert.rejects(exporter.command({ operation: "status", config: "/other.toml" }), {
    code: "INVALID_DESKTOP_REQUEST",
  });
});

test("invalid CLI responses fail explicitly and stderr uses credential redaction", async (t) => {
  const { exporter, response } = await fixture(t);
  for (const value of [
    "not-json",
    JSON.stringify({ ...status, queue: { ...status.queue, failed: -1 } }),
    JSON.stringify({ ...status, records: [{ ...status.records[0], status: "unknown" }] }),
  ]) {
    await writeFile(response, value);
    await assert.rejects(exporter.command({ operation: "status" }), /无效的数据飞轮状态/);
  }
  await writeFile(response, "fail");
  await assert.rejects(
    exporter.command({ operation: "retry" }),
    (error) => error.message.includes("[redacted]") && !error.message.includes("fixture-secret"),
  );
});

test("retry refreshes Host credentials before constructing the upload environment", async (t) => {
  const { exporter, calls } = await fixture(t);
  let credential = "stale-fixture";
  exporter.backend.providers.config.refreshCredentials = async () => {
    credential = "rotated-fixture";
  };
  exporter.backend.providers.environment = () => ({ AREAL_CREDENTIAL_fixture: credential });
  await exporter.command({ operation: "retry" });
  assert.equal(JSON.parse(await readFile(calls, "utf8")).credential, "rotated-fixture");
});

test("credential refresh gates retry but never blocks read-only status", async (t) => {
  const { exporter, calls } = await fixture(t);
  let refreshes = 0;
  exporter.backend.providers.config.refreshCredentials = async () => {
    refreshes++;
    throw new Error("Host 凭据来源已变化");
  };
  // 只读状态不解密凭据，刷新失败不能让用户看不到队列。
  assert.deepEqual(await exporter.command({ operation: "status" }), status);
  assert.equal(refreshes, 0);
  const afterStatus = JSON.parse(await readFile(calls, "utf8"));
  assert.deepEqual(afterStatus.args.slice(0, 2), ["trajectory", "status"]);
  // 重试必须先用新凭据构造环境；刷新失败时不能启动上传 CLI。
  await assert.rejects(exporter.command({ operation: "retry" }), /Host 凭据来源已变化/);
  assert.equal(refreshes, 1);
  assert.deepEqual(JSON.parse(await readFile(calls, "utf8")), afterStatus);
});

test("status remains readable when the GUI credential vault cannot be unlocked", async (t) => {
  const { exporter } = await fixture(t);
  exporter.backend.providers.environment = () => {
    throw new Error("fixture vault locked");
  };
  assert.deepEqual(await exporter.command({ operation: "status" }), status);
  await assert.rejects(exporter.command({ operation: "retry" }), /fixture vault locked/);
});

test("optional execution metadata is projected without changing legacy records", async (t) => {
  const { exporter, response } = await fixture(t);
  const metadata = {
    turn_id: "turn-42",
    event_name: "areal.turn.completed",
    model_name: "fixture-model",
    harness_version: "0.1.4",
    execution_duration_ms: 0,
    occurred_at: 800,
  };
  const enriched = { ...status, records: [{ ...status.records[0], ...metadata }] };
  await writeFile(
    response,
    JSON.stringify({
      ...enriched,
      records: [{ ...enriched.records[0], internal_trace: "private" }],
    }),
  );
  assert.deepEqual(await exporter.command({ operation: "status" }), enriched);
  const missing = {
    ...status,
    records: [{ ...status.records[0], occurred_at: null, model_name: null }],
  };
  await writeFile(response, JSON.stringify(missing));
  assert.deepEqual(await exporter.command({ operation: "status" }), missing);
  for (const invalid of [
    { model_name: 5 },
    { occurred_at: "800" },
    { execution_duration_ms: -1 },
  ]) {
    await writeFile(
      response,
      JSON.stringify({ ...status, records: [{ ...status.records[0], ...invalid }] }),
    );
    await assert.rejects(exporter.command({ operation: "status" }), /无效的数据飞轮状态/);
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
