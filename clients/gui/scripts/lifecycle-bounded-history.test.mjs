import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { CoreClient } from "../packages/runtime-client/core.js";
import { CoreTaskModel } from "../packages/workbench/client/core-model.js";

const require = createRequire(new URL("../app/package.json", import.meta.url));
const { WebSocket, WebSocketServer } = require("ws");
const { CoreBackend } = require("@areal/workbench-service/desktop/core/backend.cjs");
const { CoreLibrary } = require("@areal/workbench-service/desktop/core/library.cjs");
const {
  LifecycleOperations,
} = require("@areal/workbench-service/desktop/core/lifecycle-operations.cjs");
const { readOriginalTurn } = require("@areal/workbench-service/desktop/core/local-service.cjs");
const serviceId = "a".repeat(24),
  generation = "original-generation";
const turn = (id, status) => ({ id, status, items: [] });
const baseline = (turns, nextCursor = null) => ({
  thread: { id: "thread", turns },
  history: { snapshotId: "snapshot", nextCursor, complete: !nextCursor },
});
const entry = (id, status) => ({
  sourceThreadId: "thread",
  sourceTurnId: id,
  sourceTurnStatus: status,
  sourceItemId: "large-item",
  turn: { id, status },
  item: {
    type: "historyDeferred",
    id: "large-item",
    totalBytes: 100 * 1024 * 1024,
    cursor: "never-materialize",
    version: "v1",
  },
});

// Core RPC 是故障注入边界；生命周期、持久回执、同步显示投影和真实 socket 仍走产品实现。
async function fixture(t, respond, { bounded = true } = {}) {
  const scratch = await mkdtemp(join(tmpdir(), "areal-lifecycle-history-"));
  const workspace = join(scratch, "workspace"),
    home = join(scratch, "desktop");
  await mkdir(workspace);
  await mkdir(join(home, "project", "state"), { recursive: true });
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const calls = [],
    errors = [],
    closed = [];
  const capabilities = {
    methods: ["turn/interrupt", "areal/thread/observe", "areal/conversation/history"],
    features: { boundedObservation: bounded, boundedHistory: bounded },
  };
  server.on("connection", (socket) => {
    closed.push(once(socket, "close"));
    socket.on("message", async (raw) => {
      const message = JSON.parse(raw);
      if (message.id === undefined) return;
      calls.push(message);
      try {
        if (["initialize", "areal/capabilities"].includes(message.method)) {
          socket.send(JSON.stringify({ id: message.id, result: capabilities }));
          return;
        }
        if (bounded && message.method === "thread/read" && message.params.includeTurns) {
          socket.send(
            JSON.stringify({
              id: message.id,
              error: {
                code: -32000,
                message: "Full history exceeds the supported 64 MiB response limit",
                data: { reason: "RESPONSE_TOO_LARGE", retryable: false },
              },
            }),
          );
          return;
        }
        const reply = await respond(message, socket);
        socket.send(JSON.stringify({ id: message.id, ...reply }));
        if (
          message.method === "areal/thread/observe" &&
          reply.result?.thread.turns.some((value) => value.id === "newer")
        )
          socket.send(
            JSON.stringify({
              method: "item/agentMessage/delta",
              params: {
                threadId: "thread",
                turnId: "newer",
                itemId: "live",
                delta: "after-baseline",
              },
            }),
          );
      } catch (error) {
        errors.push(error);
        socket.send(
          JSON.stringify({ id: message.id, error: { code: -32000, message: error.message } }),
        );
      }
    });
  });
  const client = new CoreClient({
    createSocket: () => new WebSocket(`ws://127.0.0.1:${server.address().port}`),
  });
  const project = {
    id: "project",
    root: workspace,
    model: new CoreTaskModel(),
    pending: [],
    configurations: {},
    summaries: [],
    connectionGeneration: 1,
    client,
    service: { serviceId, generation },
  };
  const backend = Object.assign(Object.create(CoreBackend.prototype), {
    home,
    harnessHome: join(scratch, "registry"),
    host: {
      home: join(scratch, "registry"),
      resolve: () => ({ dataDir: join(home, "project", "state") }),
    },
    projects: new Map([["project", project]]),
    saves: new Map(),
    providers: { redact: (value) => value },
    onChange() {},
    saved: [{ id: project.id, root: workspace }],
    hooks: { environment: () => ({}) },
    // 启动快照由 Host 给出；各用例再按需换成自己的 Host 回答。
    hostCall: async (_method, params) => ({ desktopGeneration: params.ownerNonce, records: [] }),
  });
  const lifecycle = (backend.lifecycleOperations = new LifecycleOperations(backend));
  backend.library = new CoreLibrary(backend);
  t.after(async () => {
    client.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
    await backend.library.writes;
    await rm(scratch, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  await client.connect();
  client.onNotification((method, params) => project.model.event(method, params));
  await lifecycle.init();
  const target = {
    projectId: project.id,
    serviceId,
    generation,
    requestId: randomUUID(),
    phase: "acceptedPending",
  };
  const record = {
    requestId: randomUUID(),
    kind: "interruptTurn",
    mode: "cancel",
    threadId: "thread",
    turnId: "original",
    targets: [target],
  };
  return { scratch, server, calls, client, project, backend, lifecycle, target, record, closed };
}

for (const operation of ["request", "read", "reconcile"]) {
  test(`Rust completed ${operation} projects terminal before client receipt delivery`, async (t) => {
    let status = "inProgress";
    const f = await fixture(t, async () => ({ result: baseline([turn("original", status)]) }));
    await f.backend.readObservation(f.project, "thread");
    f.backend.rustDomains = ["execution-rust"];
    f.backend.host.sourceId = "source";
    const receipt = {
      ...f.record,
      version: 1,
      desktopGeneration: f.lifecycle.generation,
      phase: "completed",
      desktopExit: "notRequested",
      sharedHost: true,
      targets: f.record.targets.map((target) => ({ ...target, phase: "completed" })),
    };
    f.backend.hostCall = async (method) => {
      assert.equal(method, operation === "request" ? "lifecycle.command" : "lifecycle.read");
      return structuredClone(receipt);
    };
    status = "interrupted";
    const before = f.calls.length;
    const result =
      operation === "request"
        ? await f.lifecycle.request({
            requestId: receipt.requestId,
            kind: receipt.kind,
            mode: receipt.mode,
            expectedDesktopGeneration: receipt.desktopGeneration,
            expectedTargets: receipt.targets,
            threadId: receipt.threadId,
            turnId: receipt.turnId,
          })
        : await f.lifecycle[operation](receipt.requestId);
    assert.equal(result.phase, "completed");
    assert.equal(
      f.project.model.state.threads.thread.turns.at(-1).status,
      "interrupted",
      "终态投影先于Main可延迟的回执交付，不能依赖独立完成通知",
    );
    assert.deepEqual(
      f.calls.slice(before).map((call) => call.method),
      ["areal/thread/observe"],
      "完成证明后只读一次，不重派停止或完整历史读取",
    );
  });
}

for (const boundary of ["successor-generation", "late-response", "failed-read"]) {
  test(`Rust completed receipt preserves proof across ${boundary}`, async (t) => {
    let status = "inProgress";
    let f;
    f = await fixture(t, async () => {
      if (status === "interrupted" && boundary === "failed-read")
        return { error: { code: -32000, message: "fixture observation unavailable" } };
      if (status === "interrupted" && boundary === "late-response") {
        f.project.service = { serviceId, generation: "successor" };
        f.project.model.replace({ id: "thread", turns: [turn("successor", "inProgress")] });
      }
      return { result: baseline([turn("original", status)]) };
    });
    await f.backend.readObservation(f.project, "thread");
    f.backend.rustDomains = ["execution-rust"];
    f.backend.host.sourceId = "source";
    const receipt = {
      ...f.record,
      version: 1,
      desktopGeneration: f.lifecycle.generation,
      phase: "completed",
      desktopExit: "notRequested",
      sharedHost: true,
      targets: f.record.targets.map((target) => ({ ...target, phase: "completed" })),
    };
    f.backend.hostCall = async () => structuredClone(receipt);
    if (boundary === "successor-generation")
      f.project.service = { serviceId, generation: "successor" };
    status = "interrupted";
    const before = f.calls.length;
    const result = await f.lifecycle.read(receipt.requestId);
    assert.equal(result.phase, "completed", "投影读取失败或换代不能降级原权威完成证明");
    assert.equal(f.project.model.state.threads.thread.turns.at(-1).status, "inProgress");
    if (boundary === "successor-generation") assert.equal(f.calls.length, before);
    else
      assert.deepEqual(
        f.calls.slice(before).map((call) => call.method),
        ["areal/thread/observe"],
      );
    if (boundary === "late-response")
      assert.equal(
        f.project.model.state.threads.thread.turns.at(-1).id,
        "successor",
        "迟到旧快照不能覆盖后继代际",
      );
    if (boundary === "failed-read")
      assert.equal(f.project.observationErrors.thread.refreshPending, false);
  });
}
async function descriptorFixture(f, expectedGeneration = generation) {
  let observer;
  f.backend.host = {
    sourceId: "fixture-source",
    resolve: () => ({ projectId: "project" }),
    observe: async () => ({ descriptor: { serviceId, generation: expectedGeneration } }),
  };
  f.backend.hostCall = async (method, params) => {
    if (method === "core.attach") {
      assert.equal(params.scope, "observer");
      observer = new CoreClient({
        createSocket: () => new WebSocket(`ws://127.0.0.1:${f.server.address().port}`),
      });
      await observer.connect();
      return {
        lease: "fixture-observer",
        coreInstanceId: serviceId,
        coreGeneration: expectedGeneration,
        connectionId: "fixture-connection",
        capabilities: observer.capabilities,
      };
    }
    if (method === "core.detach") {
      observer.close();
      return { closed: true };
    }
    assert.equal(method, "core.request");
    assert.equal(params.lease, "fixture-observer");
    try {
      return { result: await observer.request(params.method, params.params), sequence: 0 };
    } catch (error) {
      if (typeof error.code !== "number") throw error;
      return { error: { code: error.code, message: error.message, data: error.data } };
    }
  };
}

test("offline original-generation inspection negotiates bounded metadata and closes its temporary client", async (t) => {
  let observations = 0;
  const f = await fixture(t, async ({ method, params }) => {
    if (method === "areal/thread/observe") {
      observations++;
      assert.equal(params.maxBytes, observations === 1 ? 262144 : 1048576);
      if (observations === 1)
        return {
          error: {
            code: -32012,
            message: "metadata",
            data: { reason: "HISTORY_BUDGET_TOO_SMALL" },
          },
        };
      return { result: baseline([turn("newer", "inProgress")], "older") };
    }
    assert.equal(method, "areal/conversation/history");
    return {
      result: {
        snapshotId: "snapshot",
        data: [entry("original", "interrupted")],
        complete: true,
        nextCursor: null,
      },
    };
  });
  await descriptorFixture(f);
  const result = await readOriginalTurn(f.backend, f.target, "thread", "original");
  assert.equal(result.id, "original");
  assert.equal(result.status, "interrupted");
  await f.closed[1];
  assert.equal(
    f.calls.some((call) => call.method === "thread/read"),
    false,
  );
  assert.equal(
    f.calls.some((call) => call.params?.cursor === "never-materialize"),
    false,
  );
});

test("offline inspection refuses a successor before opening an observation socket", async (t) => {
  const f = await fixture(t, async () => {
    throw new Error("must not inspect successor");
  });
  await descriptorFixture(f, "successor");
  await assert.rejects(readOriginalTurn(f.backend, f.target, "thread", "original"), {
    code: "CONFIRMATION_STALE",
  });
  assert.equal(f.closed.length, 1);
});
