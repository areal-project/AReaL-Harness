"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { DesktopService } = require("../app/src/core/service-protocol.cjs");
const { GuiTerminalConnections } = require("../app/src/core/gui-terminal-connections.cjs");
const tick = () => new Promise((done) => setImmediate(done));
function socket() {
  return {
    readyState: 1,
    bufferedAmount: 0,
    packets: [],
    send(value, done) {
      this.packets.push(JSON.parse(value));
      done?.();
    },
  };
}
function service() {
  const project = {
    service: { serviceId: "core", generation: "generation" },
    endpoint: "ws://127.0.0.1:1234",
    token: "private",
  };
  const backend = {
    projects: new Map([["project", project]]),
    providers: { redact: (value) => value },
    analytics: { sample() {} },
    starting: new Map(),
    hasWork: () => false,
  };
  const value = new DesktopService(backend, "test");
  value.schedule = () => {};
  return value;
}
test("terminal replies are bound to the original authenticated Main socket", async () => {
  const f = service(),
    a = socket(),
    b = socket();
  f.clients.add(a);
  f.clients.add(b);
  const pending = f.terminalRead(a, "project", "areal/process/start", {
    threadId: "thread",
    requestId: "original",
    lifetime: "connection",
  });
  await tick();
  const dispatched = a.packets.find((packet) => packet.method === "terminalRequest").params;
  assert.equal(dispatched.params.requestId, "original");
  assert.equal(dispatched.token, "private");
  await f.receive(
    b,
    Buffer.from(
      JSON.stringify({
        id: 1,
        method: "terminalResult",
        params: { requestId: dispatched.requestId, result: { id: "spoof" } },
      }),
    ),
  );
  assert.match(
    b.packets.find((packet) => packet.id === 1).error.message,
    /Invalid GUI terminal response/,
  );
  assert.equal(f.terminalPending.size, 1);
  await f.receive(
    a,
    Buffer.from(
      JSON.stringify({
        id: 2,
        method: "terminalResult",
        params: { requestId: dispatched.requestId, result: { id: "real" } },
      }),
    ),
  );
  assert.deepEqual(await pending, { id: "real" });
  assert.equal(f.terminalPending.size, 0);
  await assert.rejects(f.terminalRead(a, "project", "areal/server/stop", {}), /unavailable/);
  f.close();
});
test("terminal errors keep their original UNKNOWN result and close rejects pending dispatch", async () => {
  const f = service(),
    a = socket();
  f.clients.add(a);
  const pending = f.terminalRead(a, "project", "areal/process/write", {
    requestId: "original",
    id: "terminal",
  });
  const dispatched = a.packets.find((packet) => packet.method === "terminalRequest").params;
  const error = {
    message: "lost response",
    submissionUnknown: true,
    requestId: "original",
    recovery: { kind: "queryOriginal" },
  };
  await f.receive(
    a,
    Buffer.from(
      JSON.stringify({
        id: 1,
        method: "terminalResult",
        params: { requestId: dispatched.requestId, error },
      }),
    ),
  );
  await assert.rejects(
    pending,
    (value) =>
      value.submissionUnknown &&
      value.requestId === "original" &&
      value.recovery.kind === "queryOriginal",
  );
  const unresolved = f.terminalRead(a, "project", "areal/process/start", {});
  f.close();
  await assert.rejects(unresolved, /closed; outcome may be unknown/);
});
test("Main terminal connection survives concurrent reads and closes a late handshake", async () => {
  const { CoreClient } = await import("../packages/runtime-client/core.js");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ protocolVersion: 1, serviceId: "core", generation: "generation" }),
  });
  const original = {
    connect: CoreClient.prototype.connect,
    request: CoreClient.prototype.request,
    close: CoreClient.prototype.close,
  };
  const ready = Promise.withResolvers();
  const connected = [],
    calls = [],
    closed = [];
  CoreClient.prototype.connect = function () {
    connected.push(this);
    this.capabilities = { features: { connectionProcesses: true } };
    return ready.promise;
  };
  CoreClient.prototype.request = async function (method, params) {
    calls.push({ client: this, method, params });
    return { id: "terminal" };
  };
  CoreClient.prototype.close = function () {
    closed.push(this);
  };
  try {
    const owner = new GuiTerminalConnections();
    const request = {
      projectId: "project",
      serviceId: "core",
      generation: "generation",
      endpoint: "ws://127.0.0.1:1234",
      token: "private",
      method: "areal/process/start",
      params: { lifetime: "connection", requestId: "original" },
    };
    const pending = owner.request(request);
    await tick();
    owner.close();
    ready.resolve();
    await assert.rejects(pending, /ended during startup/);
    assert.equal(calls.length, 0);
    assert.ok(closed.includes(connected[0]));
    const second = new GuiTerminalConnections();
    await Promise.all([
      second.request(request),
      second.request({ ...request, method: "areal/process/read", params: { id: "terminal" } }),
    ]);
    assert.equal(connected.length, 2);
    assert.equal(calls[0].client, calls[1].client);
    assert.equal(calls[0].params.requestId, "original");
    second.close();
    await assert.rejects(second.request(request), /unavailable/);
    assert.equal(connected.length, 2);
  } finally {
    Object.assign(CoreClient.prototype, original);
    globalThis.fetch = originalFetch;
  }
});

test("Main rejects a stale Core generation and malformed terminal endpoint", async () => {
  const { CoreClient } = await import("../packages/runtime-client/core.js");
  const original = {
    connect: CoreClient.prototype.connect,
    request: CoreClient.prototype.request,
    close: CoreClient.prototype.close,
  };
  const originalFetch = globalThis.fetch;
  let dispatches = 0,
    closes = 0;
  CoreClient.prototype.connect = async function () {
    return {};
  };
  CoreClient.prototype.request = async function () {
    dispatches++;
  };
  CoreClient.prototype.close = function () {
    closes++;
  };
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ protocolVersion: 1, serviceId: "core", generation: "successor" }),
  });
  const owner = new GuiTerminalConnections();
  const request = {
    projectId: "project",
    serviceId: "core",
    generation: "original",
    endpoint: "ws://127.0.0.1:1234",
    token: "private",
    method: "areal/process/start",
    params: { lifetime: "connection" },
  };
  try {
    await assert.rejects(
      owner.request({ ...request, endpoint: "invalid endpoint" }),
      /unavailable/,
    );
    await assert.rejects(owner.request(request), /identity or generation changed/);
    assert.equal(dispatches, 0);
    assert.equal(closes, 1);
  } finally {
    owner.close();
    Object.assign(CoreClient.prototype, original);
    globalThis.fetch = originalFetch;
  }
});

test("Desktop terminal dispatch retains the journal request and forces connection lifetime", async () => {
  const { manage } = require("../app/src/core/management.cjs");
  const calls = [];
  const terminalRequest = async (method, params) => {
    calls.push({ method, params });
    return { id: "terminal", runtimeEpoch: "epoch" };
  };
  const project = {
    id: "project",
    client: {
      request() {
        assert.fail("must use Main terminal connection");
      },
    },
  };
  const backend = {
    async submit(owner, method, params, options) {
      assert.equal(owner, project);
      assert.equal(options.requestId, "original");
      assert.equal(options.requestCore, terminalRequest);
      return options.requestCore(method, { ...params, requestId: options.requestId });
    },
    onChange() {},
  };
  const result = await manage(
    backend,
    project,
    {
      operation: "processStart",
      projectId: "project",
      threadId: "thread",
      requestId: "original",
      argv: ["/bin/sh"],
      lifetime: "thread",
    },
    { guiTerminalRequest: terminalRequest },
  );
  assert.equal(result.id, "terminal");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.requestId, "original");
  assert.equal(calls[0].params.lifetime, "connection");
});
test("lost terminal start response queries the original receipt through Main without replay", async () => {
  const { SubmissionRecovery } = require("../app/src/core/submission-recovery.cjs");
  const calls = [];
  const project = {
    client: {
      capabilities: {},
      request() {
        assert.fail("Desktop socket must not dispatch or recover this request");
      },
    },
  };
  const requestCore = async (method, params) => {
    calls.push({ method, params });
    if (method === "areal/process/start")
      throw Object.assign(new Error("lost"), { submissionUnknown: true });
    return { status: "completed", result: { id: "original-terminal" } };
  };
  const recovery = {
    async readReceipt(owner, entry, client, timeout, request) {
      assert.equal(owner, project);
      assert.equal(entry.params.requestId, "original");
      assert.equal(request, requestCore);
      return request("areal/request/read", { threadId: "thread", requestId: "original" });
    },
  };
  const result = await SubmissionRecovery.prototype.requestSubmission.call(
    recovery,
    project,
    "areal/process/start",
    { threadId: "thread", requestId: "original", lifetime: "connection" },
    requestCore,
  );
  assert.equal(result.id, "original-terminal");
  assert.deepEqual(
    calls.map((call) => call.method),
    ["areal/process/start", "areal/request/read"],
  );
});

test("Main service connection forwards terminal results on the original privileged channel", async (t) => {
  const { WebSocketServer } = require("ws");
  const { ServiceConnection } = require("../app/src/core/service-connection.cjs");
  const { PROTOCOL } = require("../app/src/core/service-protocol.cjs");
  const { once } = require("node:events");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  let received;
  const result = Promise.withResolvers();
  server.on("connection", (socket) => {
    socket.on("message", (bytes) => {
      const message = JSON.parse(bytes);
      received = message;
      socket.send(JSON.stringify({ id: message.id, result: null }));
      result.resolve();
    });
    socket.send(
      JSON.stringify({
        method: "terminalRequest",
        params: {
          requestId: 42,
          projectId: "project",
          method: "areal/process/read",
          params: { id: "terminal" },
        },
      }),
    );
  });
  const connection = new ServiceConnection(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async (request) => {
      assert.equal(request.requestId, 42);
      return { chunks: [{ dataBase64: "ZGF0YQ==" }] };
    },
  );
  t.after(async () => {
    connection.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise((done) => server.close(done));
  });
  await connection.connect({
    protocol: PROTOCOL,
    endpoint: `ws://127.0.0.1:${server.address().port}`,
    token: "a".repeat(64),
    identity: "fixture",
    pid: 1234,
  });
  await result.promise;
  assert.equal(received.method, "terminalResult");
  assert.equal(received.params.requestId, 42);
  assert.deepEqual(received.params.result, { chunks: [{ dataBase64: "ZGF0YQ==" }] });
});

test("failed and closed terminal connections permit only a later explicit connection", async () => {
  const { CoreClient } = await import("../packages/runtime-client/core.js");
  const original = {
    connect: CoreClient.prototype.connect,
    request: CoreClient.prototype.request,
    close: CoreClient.prototype.close,
    onClose: CoreClient.prototype.onClose,
  };
  const originalFetch = globalThis.fetch;
  const clients = [],
    listeners = new Map(),
    calls = [];
  CoreClient.prototype.connect = async function () {
    clients.push(this);
    if (clients.length === 1) throw new Error("handshake failed");
    this.capabilities = { features: { connectionProcesses: true } };
    return this.capabilities;
  };
  CoreClient.prototype.onClose = function (listener) {
    listeners.set(this, listener);
    return () => {};
  };
  CoreClient.prototype.close = function () {
    this.closed = true;
    listeners.get(this)?.();
  };
  CoreClient.prototype.request = async function (method, params) {
    calls.push({ client: this, method, params });
    if (method === "areal/process/write") {
      this.close();
      throw Object.assign(new Error("write response lost"), { submissionUnknown: true });
    }
    return { id: "terminal" };
  };
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ protocolVersion: 1, serviceId: "core", generation: "generation" }),
  });
  const owner = new GuiTerminalConnections();
  const request = {
    projectId: "project",
    serviceId: "core",
    generation: "generation",
    endpoint: "ws://127.0.0.1:1234",
    token: "private",
    method: "areal/process/start",
    params: { lifetime: "connection", requestId: "original" },
  };
  try {
    await assert.rejects(owner.request(request), /handshake failed/);
    assert.equal(
      owner.connections.size,
      0,
      "failed readiness must not poison later explicit requests",
    );
    await owner.request({
      ...request,
      params: { lifetime: "connection", requestId: "new-explicit-request" },
    });
    assert.equal(clients.length, 2);
    await assert.rejects(
      owner.request({
        ...request,
        method: "areal/process/write",
        params: { id: "terminal", requestId: "original-write" },
      }),
      (error) => error.submissionUnknown === true,
    );
    assert.equal(clients.length, 2, "a lost in-flight write must not reconnect or replay itself");
    assert.equal(owner.connections.size, 0);
    await owner.request({
      ...request,
      method: "areal/request/read",
      params: { threadId: "thread", requestId: "original-write" },
    });
    assert.equal(clients.length, 3);
    listeners.get(clients[1])();
    assert.equal(
      owner.connections.get("project").client,
      clients[2],
      "late old close must not remove its replacement",
    );
    assert.deepEqual(
      calls.map((call) => [call.method, call.params.requestId]),
      [
        ["areal/process/start", "new-explicit-request"],
        ["areal/process/write", "original-write"],
        ["areal/request/read", "original-write"],
      ],
    );
    owner.close();
    await assert.rejects(owner.request(request), /unavailable/);
    assert.equal(clients.length, 3);
  } finally {
    owner.close();
    Object.assign(CoreClient.prototype, original);
    globalThis.fetch = originalFetch;
  }
});
