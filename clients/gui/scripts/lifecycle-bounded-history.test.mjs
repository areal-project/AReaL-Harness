import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { CoreClient } from "../packages/runtime-client/core.js";
import { CoreTaskModel } from "../packages/workbench/client/core-model.js";

const require = createRequire(new URL("../app/package.json", import.meta.url));
const { WebSocket, WebSocketServer } = require("ws");
const { CoreBackend } = require("../app/src/core/backend.cjs");
const { CoreLibrary } = require("../app/src/core/library.cjs");
const { SharedCoreBackend } = require("../app/src/core/service-client.cjs");
const { LifecycleOperations } = require("../app/src/core/lifecycle-operations.cjs");
const { readOriginalTurn } = require("../app/src/core/local-service.cjs");
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

test("history reads execute against the original Core while interruption still blocks writes", async (t) => {
  const f = await fixture(t, async () => ({ result: baseline([turn("original", "inProgress")]) }));
  await f.backend.readObservation(f.project, "thread");
  f.lifecycle.records.set(f.record.requestId, f.record);
  const request = { projectId: "project", threadId: "thread", viewId: "pending-history" };
  const shared = Object.assign(Object.create(SharedCoreBackend.prototype), {
    status: { lifecycle: { version: 2 } },
    lifecycleReferences: new Map([[f.record.requestId, f.record]]),
    lifecycleReceipts: new Map(),
    hostReferences: new Map(),
    hostReceipts: new Map(),
  });
  for (const [operation, expected] of [
    ["acquire", "supported"],
    ["loadOlder", "data"],
    ["loadItem", "loaded"],
    ["release", "released"],
  ]) {
    const params = {
      ...request,
      operation,
      ...(operation === "loadItem" ? { itemId: "absent-item" } : {}),
    };
    assert.doesNotThrow(() => shared.assertLifecycleScope("history", params));
    assert.ok(Object.hasOwn(await f.backend.command("history", params), expected));
  }
  assert.throws(() => shared.assertLifecycleScope("send", request), {
    code: "LIFECYCLE_INCOMPLETE",
  });
  await assert.rejects(f.backend.command("send", request), { code: "LIFECYCLE_INCOMPLETE" });
  f.project.service = { serviceId, generation: "replacement" };
  await assert.rejects(f.backend.command("history", { ...request, operation: "acquire" }), {
    code: "CONFIRMATION_STALE",
  });
  shared.foreignOwner = true;
  assert.throws(
    () => shared.assertLifecycleScope("history", { ...request, operation: "acquire" }),
    { code: "APPLICATION_OWNER_MISMATCH" },
  );
});

test("snapshot-only terminal transitions record completion once and preserve explicit read state", async (t) => {
  const f = await fixture(t, async () => ({ result: baseline([turn("original", "interrupted")]) }));
  f.project.model.replace({ id: "thread", turns: [turn("original", "inProgress")] });
  await f.backend.readObservation(f.project, "thread");
  await f.backend.library.writes;
  const metadata = () => f.backend.library.value.threads["project:thread"];
  assert.equal(metadata()?.completionId, "original");
  assert.equal(metadata().unread, true);
  await f.backend.library.command({
    operation: "readThread",
    projectId: "project",
    threadId: "thread",
    read: true,
    completionId: "original",
  });
  await f.backend.readObservation(f.project, "thread");
  await f.backend.library.writes;
  assert.equal(metadata().unread, false);
  f.project.model = new CoreTaskModel();
  f.backend.library = new CoreLibrary(f.backend);
  await f.backend.readObservation(f.project, "thread");
  await f.backend.library.writes;
  assert.deepEqual(
    f.backend.library.value.threads,
    {},
    "Opening old terminal history does not create completion activity",
  );
});

test("large-history interrupt and settlement use bounded snapshots and the exact archived turn", async (t) => {
  let active = true;
  const f = await fixture(t, async ({ method, params }) => {
    if (method === "areal/thread/observe") {
      assert.equal(params.mode, "bounded");
      assert.ok(params.maxBytes <= 1048576);
      return {
        result: active
          ? baseline([turn("original", "inProgress")])
          : baseline([turn("newer", "inProgress")], "older"),
      };
    }
    if (method === "turn/interrupt") {
      assert.equal(params.turnId, "original");
      active = false;
      return { result: {} };
    }
    assert.equal(method, "areal/conversation/history");
    assert.equal(params.cursor, "older");
    assert.equal(params.view, "own");
    assert.ok(params.maxBytes <= 1048576);
    return {
      result: {
        snapshotId: "snapshot",
        data: [entry("original", "interrupted")],
        complete: true,
        nextCursor: null,
      },
    };
  });
  const result = await f.lifecycle.request({
    requestId: f.record.requestId,
    kind: "interruptTurn",
    mode: "cancel",
    expectedDesktopGeneration: f.lifecycle.generation,
    expectedTargets: [{ projectId: "project", serviceId, generation }],
    threadId: "thread",
    turnId: "original",
  });
  assert.equal(result.phase, "completed");
  assert.equal((await f.lifecycle.read(result.requestId)).phase, "completed");
  assert.equal(f.calls.filter((call) => call.method === "turn/interrupt").length, 1);
  assert.equal(
    f.calls.some((call) => call.method === "thread/read"),
    false,
  );
  assert.equal(f.project.model.state.threads.thread.turns.at(-1).items[0].text, "after-baseline");
  assert.equal(
    f.calls.some((call) => call.params?.cursor === "never-materialize"),
    false,
  );
});

test("settlement follows own pages without treating a different active turn as completion", async (t) => {
  const f = await fixture(t, async ({ method, params }) => {
    if (method === "areal/thread/observe")
      return { result: baseline([turn("newer", "inProgress")], "page-1") };
    assert.equal(method, "areal/conversation/history");
    return {
      result:
        params.cursor === "page-1"
          ? {
              snapshotId: "snapshot",
              data: [entry("other", "completed")],
              nextCursor: "page-2",
              complete: false,
            }
          : {
              snapshotId: "snapshot",
              data: [entry("original", "interrupted")],
              nextCursor: null,
              complete: true,
            },
    };
  });
  await f.lifecycle.inspectInterrupt(f.record, f.target);
  assert.equal(f.target.phase, "completed");
  assert.equal(f.calls.filter((call) => call.method === "areal/conversation/history").length, 2);
  assert.equal(
    f.calls.some((call) => call.method === "turn/interrupt"),
    false,
  );
});

test("missing original turn leaves its admission unresolved", async (t) => {
  const f = await fixture(t, async ({ method }) => {
    assert.equal(method, "areal/thread/observe");
    return { result: baseline([turn("newer", "inProgress")]) };
  });
  await f.lifecycle.inspectInterrupt(f.record, f.target);
  assert.equal(f.target.phase, "acceptedPending");
  assert.equal(
    f.calls.some((call) => call.method === "turn/interrupt"),
    false,
  );
});

test("changed generation during a history read cannot settle the original target", async (t) => {
  const f = await fixture(t, async ({ method }) => {
    if (method === "areal/thread/observe")
      return { result: baseline([turn("newer", "inProgress")], "older") };
    assert.equal(method, "areal/conversation/history");
    f.project.service = { serviceId, generation: "successor" };
    return {
      result: {
        snapshotId: "snapshot",
        data: [entry("original", "completed")],
        complete: true,
        nextCursor: null,
      },
    };
  });
  await assert.rejects(f.lifecycle.inspectInterrupt(f.record, f.target), {
    code: "CONFIRMATION_STALE",
  });
  assert.equal(f.target.phase, "acceptedPending");
});

test("replaced live client cannot authorize an interrupt from the old observation", async (t) => {
  const f = await fixture(t, async ({ method }) => {
    assert.equal(method, "areal/thread/observe");
    f.project.client = { ready: true };
    return { result: baseline([turn("original", "inProgress")]) };
  });
  await f.lifecycle.interrupt(f.record, f.target);
  assert.equal(f.target.phase, "blocked");
  assert.equal(f.target.error.code, "STALE_CONNECTION");
  assert.equal(
    f.calls.some((call) => call.method === "turn/interrupt"),
    false,
  );
  assert.equal(f.project.model.state.threads.thread, undefined);
});

test("legacy Core keeps explicit full-read interruption compatibility", async (t) => {
  let active = true;
  const f = await fixture(
    t,
    async ({ method, params }) => {
      if (method === "turn/interrupt") {
        active = false;
        return { result: {} };
      }
      assert.equal(method, "thread/read");
      assert.equal(params.includeTurns, true);
      return {
        result: {
          thread: {
            id: "thread",
            turns: [turn("original", active ? "inProgress" : "interrupted")],
          },
        },
      };
    },
    { bounded: false },
  );
  await f.lifecycle.interrupt(f.record, f.target);
  assert.equal(f.target.phase, "completed");
  assert.equal(f.calls.filter((call) => call.method === "turn/interrupt").length, 1);
});

async function descriptorFixture(f, expectedGeneration = generation) {
  delete f.backend.host;
  const authFile = join(f.scratch, "auth.json");
  await writeFile(
    authFile,
    JSON.stringify({
      principals: [{ permissions: ["observe", "interact", "manage"], token: "fixture-token" }],
    }),
  );
  const descriptor = {
    protocolVersion: 1,
    state: "ready",
    serviceId,
    generation: expectedGeneration,
    configFingerprint: "fixture",
    workspace: await realpath(f.project.root),
    dataDir: await realpath(join(f.backend.home, "project", "state")),
    endpoint: `ws://127.0.0.1:${f.server.address().port}`,
    authFile,
  };
  f.backend.binary = join(f.scratch, "service-fixture");
  await writeFile(
    f.backend.binary,
    `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(descriptor))});\n`,
    { mode: 0o700 },
  );
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
