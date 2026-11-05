import { attachRemoteHostFixture } from "./remote-host-fixture.cjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import * as crypto from "../packages/remote/src/channel.mjs";
import { CoreClient } from "../packages/runtime-client/core.js";
const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require("../app/node_modules/ws");
const { RemoteControl } = require("@areal/workbench-service/desktop/core/remote.cjs");
const { deviceCommand } = require("@areal/workbench-service/desktop/core/remote-push.cjs");
const { parseRemoteConfig } = require("@areal/workbench-service/desktop/core/remote-config.cjs");
const { RelayTransport } = require("@areal/workbench-service/desktop/core/remote-relay.cjs");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "condition reached within local fixture deadline");
    await pause(5);
  }
}
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "areal-push-"));
  const key = randomBytes(32);
  const encryption = {
    isEncryptionAvailable: () => true,
    encryptString(text) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decryptString(bytes) {
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString();
    },
  };
  const core = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(core, "listening");
  const methods = ["areal/thread/observe", "areal/subscription/remove", "areal/work/overview"];
  const caps = {
    methods,
    methodSemantics: Object.fromEntries(
      methods.map((method) => [
        method,
        { effect: method === "areal/thread/observe" ? "subscription" : "read" },
      ]),
    ),
    features: { atomicObserve: true, atomicObserveOwnership: true, subscriptionRemoval: true },
  };
  const threads = new Map();
  let rows = [];
  const requests = [];
  core.on("connection", (socket) => {
    socket.subscriptions = new Set();
    socket.on("message", (bytes) => {
      const request = JSON.parse(bytes);
      if (request.id === undefined) return;
      requests.push(request);
      let result = {};
      if (request.method === "areal/capabilities") result = caps;
      if (request.method === "areal/thread/observe") {
        socket.subscriptions.add(request.params.threadId);
        result = {
          thread: threads.get(request.params.threadId) ?? {
            id: request.params.threadId,
            turns: [],
          },
          ownership: { kind: "ordinary" },
        };
      }
      if (request.method === "areal/subscription/remove")
        for (const id of request.params.threadIds) socket.subscriptions.delete(id);
      if (request.method === "areal/work/overview") {
        const index = Number(request.params.cursor ?? 0);
        const data = rows.slice(index, index + request.params.limit);
        const end = index + data.length;
        result = {
          data,
          nextCursor: end < rows.length ? String(end) : null,
          complete: end >= rows.length,
        };
      }
      socket.send(JSON.stringify({ id: request.id, result }));
    });
  });
  const endpoint = `ws://127.0.0.1:${core.address().port}`;
  const client = new CoreClient({ createSocket: () => new WebSocket(endpoint) });
  await client.connect();
  const project = {
    id: "p",
    root: home,
    client,
    model: { state: { connected: true, threads: {} }, subscribe: () => () => {} },
    service: { serviceId: "svc", generation: "g" },
    endpoint,
    token: "fixture",
    pending: [],
    outcomes: {},
  };
  const backend = {
    home,
    saved: [{ id: "p", root: home }],
    projects: new Map([["p", project]]),
    async save(name, value) {
      await writeFile(join(home, name), JSON.stringify(value));
    },
  };
  const remote = new RemoteControl({ backend, schedule() {} });
  attachRemoteHostFixture(remote, encryption);
  await remote.init();
  const identity = await crypto.createIdentity(),
    device = await crypto.createIdentity(),
    peer = crypto.identityId(device);
  const grant = {
    devicePeerId: peer,
    displayName: "Phone",
    clientKind: "ios",
    projectIds: ["p"],
    capabilities: ["observe", "answer", "submit"],
    revision: 1,
    status: "active",
    push: { platform: "apns", token: "a".repeat(64), environment: "development" },
  };
  remote.config = { identity, deviceGrants: [grant] };
  const pushes = [];
  remote.relayTransport = {
    pushSupported: true,
    bufferedAmount: 0,
    tryPush(message, current) {
      if (!current()) return false;
      pushes.push(structuredClone(message));
      return true;
    },
    close() {},
  };
  const direct = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(direct, "listening");
  direct.on("connection", (socket) => remote.sessions.accept(socket));
  async function phone() {
    const socket = new WebSocket(`ws://127.0.0.1:${direct.address().port}`);
    await once(socket, "open");
    const wire = crypto.byteChannel(
      (bytes) => socket.send(bytes),
      () => socket.close(),
    );
    socket.on("message", (bytes) => wire.receive(bytes));
    socket.on("close", () => wire.close());
    const secure = await crypto.secureChannel(wire, device, crypto.identityId(identity));
    const messages = secure.messages();
    secure.send({
      method: "hello",
      apiVersion: "areal.remote.v2",
      clientVersion: "test",
      displayName: "Phone",
      clientKind: "ios",
    });
    const ready = (await messages.next()).value;
    return {
      ready,
      socket,
      secure,
      async rpc(method, params = {}, commandId) {
        const id = randomUUID();
        secure.send({ id, method, params, ...(commandId ? { commandId } : {}) });
        let next;
        do {
          next = (await messages.next()).value;
        } while (next?.id !== id);
        return next;
      },
      close() {
        socket.terminate();
      },
    };
  }
  t.after(async () => {
    remote.close();
    client.close();
    for (const server of [core, direct]) {
      for (const socket of server.clients) socket.terminate();
      await new Promise((resolve) => server.close(resolve));
    }
    await rm(home, { recursive: true, force: true });
  });
  return {
    remote,
    project,
    grant,
    home,
    encryption,
    phone,
    pushes,
    threads,
    requests,
    setRows(value) {
      rows = value;
    },
    notify(method, params) {
      for (const socket of core.clients)
        if (socket.subscriptions.has(params.threadId))
          socket.send(JSON.stringify({ method, params }));
    },
    connection: {
      peer,
      grantRevision: 1,
      gatewayGeneration: remote.gatewayGeneration,
      alive: () => true,
    },
  };
}
const attention = (id, kind = "approval") => ({
  attentionRef: id,
  kind,
  threadId: "t",
  summary: "PRIVATE_TITLE_AND_TOOL_ARGUMENTS",
});
const row = (refs, complete = true) => ({ attentionRefs: refs, attentionComplete: complete });
const receipt = (f, turnId, extra = {}) => ({
  admissionState: "accepted",
  threadId: "t",
  turnId,
  remote: {
    hostId: crypto.identityId(f.remote.config.identity),
    devicePeerId: f.grant.devicePeerId,
    projectId: "p",
    commandId: randomUUID(),
    method: "session.send",
  },
  ...extra,
});

test("Noise device commands persist encrypted receipts, preserve revision, and expose no token", async (t) => {
  const f = await fixture(t);
  const phone = await f.phone();
  assert.ok(phone.ready.capabilities.includes("push"));
  const commandId = randomUUID();
  const params = { platform: "apns", token: "b".repeat(64), environment: "production" };
  assert.deepEqual((await phone.rpc("device.push.register", params, commandId)).result, {
    registered: true,
  });
  assert.deepEqual(
    (
      await phone.rpc(
        "device.push.register",
        { environment: "production", token: params.token.toUpperCase(), platform: "apns" },
        commandId,
      )
    ).result,
    { registered: true },
  );
  assert.equal(f.remote.config.deviceGrants[0].revision, 1);
  const state = f.remote.state();
  assert.equal(state.deviceGrants[0].pushRegistered, true);
  assert.ok(!JSON.stringify(state).includes(params.token));
  assert.equal(state.deviceGrants[0].push, undefined);
  const disk = await readFile(join(f.home, "remote-host-fixture.json"), "utf8");
  assert.ok(!disk.includes(params.token));
  const config = parseRemoteConfig(
    JSON.parse(f.encryption.decryptString(Buffer.from(JSON.parse(disk).encrypted, "base64"))),
  );
  assert.equal(config.deviceGrants[0].push.token, params.token);
  assert.equal(config.pushCommands[0].commandId, commandId);
  assert.deepEqual((await phone.rpc("command.read", { commandId })).result.receipt, {
    registered: true,
  });
  assert.equal(
    (await phone.rpc("command.read", { commandId: randomUUID() })).result.admissionState,
    "notFound",
  );
  assert.equal(
    (await phone.rpc("device.push.register", { ...params, token: "c".repeat(64) }, commandId)).error
      .code,
    "COMMAND_CONFLICT",
  );
  assert.equal(
    (await phone.rpc("device.push.register", { ...params, private: "no" }, randomUUID())).error
      .code,
    "INVALID_PARAMS",
  );
  assert.deepEqual((await phone.rpc("device.push.unregister", {}, randomUUID())).result, {
    registered: false,
  });
  assert.equal(f.remote.config.deviceGrants[0].push, undefined);
  phone.close();
});

test("push writes serialize with revocation, unavailable relay rejects registration, and old 410 cannot remove rotated token", async (t) => {
  const f = await fixture(t);
  f.remote.relayTransport.pushSupported = false;
  await assert.rejects(
    deviceCommand(
      f.remote,
      f.connection,
      { method: "device.push.register", commandId: randomUUID(), params: f.grant.push },
      () => {},
    ),
    { code: "RESOURCE_UNAVAILABLE" },
  );
  f.remote.relayTransport.pushSupported = true;
  await f.remote.control({
    operation: "updateGrant",
    id: f.grant.devicePeerId,
    projects: ["p"],
    preset: "Operator",
  });
  assert.equal(f.remote.config.deviceGrants[0].push.token, f.grant.push.token);
  f.remote.push.unregisterToken("b".repeat(64));
  await f.remote.writes;
  assert.ok(f.remote.config.deviceGrants[0].push);
  f.remote.push.unregisterToken(f.grant.push.token);
  await f.remote.writes;
  assert.equal(f.remote.config.deviceGrants[0].push, undefined);
  const revoke = f.remote.control({ operation: "revoke", id: f.grant.devicePeerId });
  const write = deviceCommand(
    f.remote,
    { ...f.connection, grantRevision: 2 },
    { method: "device.push.register", commandId: randomUUID(), params: f.grant.push },
    () => {},
  );
  await revoke;
  await assert.rejects(write, { code: "GRANT_CHANGED" });
  assert.equal(f.remote.config.deviceGrants[0].push, undefined);
});

test("attention baseline, native identity dedup, immediate collapse counts, online suppression and offline rebaseline", async (t) => {
  const f = await fixture(t);
  f.setRows([row([attention("old")])]);
  await f.remote.push.tick();
  assert.equal(f.pushes.length, 0);
  f.setRows([row([attention("old"), attention("new"), attention("unknown", "executionUnknown")])]);
  await f.remote.push.tick();
  assert.equal(f.pushes.length, 1);
  assert.equal(f.pushes[0].count, 1);
  f.setRows([row([attention("new"), attention("next")])]);
  await f.remote.push.tick();
  assert.equal(f.pushes.length, 2);
  assert.equal(f.pushes[1].count, 2);
  assert.equal(f.pushes[0].collapseId, f.pushes[1].collapseId);
  assert.ok(!JSON.stringify(f.pushes).includes("PRIVATE"));
  f.setRows([row([attention("old"), attention("next")])]);
  await f.remote.push.tick();
  assert.equal(f.pushes.length, 2);
  const phone = await f.phone();
  f.setRows([row([attention("online")])]);
  await f.remote.push.tick();
  assert.equal(f.pushes.length, 2);
  phone.close();
  await until(() => !f.remote.sessions.sockets.size);
  await f.remote.push.tick();
  assert.equal(f.pushes.length, 2);
  f.project.model.state.connected = false;
  await f.remote.push.tick();
  f.project.model.state.connected = true;
  f.setRows([row([attention("offline")])]);
  await f.remote.push.tick();
  assert.equal(f.pushes.length, 2);
  f.setRows([row([attention("revoked")])]);
  f.remote.config.deviceGrants = [{ ...f.grant, capabilities: ["observe"] }];
  await f.remote.push.tick();
  assert.equal(f.pushes.length, 2);
});

test("bounded incomplete pagination establishes full baseline and never invents resolved references", async (t) => {
  const f = await fixture(t);
  f.setRows(Array.from({ length: 35 }, (_, i) => row([attention(String(i))])));
  await f.remote.push.tick();
  assert.equal(f.pushes.length, 0);
  assert.ok(f.requests.filter((x) => x.method === "areal/work/overview").length <= 32);
  await f.remote.push.tick();
  assert.equal(f.pushes.length, 0);
  f.setRows([row([attention("fresh")])]);
  await f.remote.push.tick();
  assert.equal(f.pushes.length, 1);
  f.project.service.generation = "g2";
  f.setRows([row([attention("hidden")], false)]);
  await f.remote.push.tick();
  f.setRows([row([attention("still-incomplete")], false)]);
  await f.remote.push.tick();
  assert.equal(f.pushes.length, 1);
});

test("exact journal watches survive foreground close, rebuild viewer baseline, and route queued completions only to the owning command", async (t) => {
  const f = await fixture(t);
  f.threads.set("t", {
    id: "t",
    turns: [{ id: "own", status: "inProgress", items: [] }],
    desktop: { queue: { items: [], revision: 0 } },
  });
  const connection = { ...f.connection, connectionId: "viewer", send() {}, close() {} };
  await f.remote.sessions.observers.open(connection, "p", "t", () => {});
  f.remote.push.track("p", receipt(f, "own"));
  await until(() => f.requests.filter((x) => x.method === "areal/thread/observe").length === 2);
  f.remote.sessions.observers.release("viewer");
  assert.equal(f.remote.sessions.observers.projects.get("p").threads.get("t").state, null);
  f.notify("turn/completed", {
    threadId: "t",
    turn: { id: "unrelated", status: "completed", items: [] },
  });
  await pause(20);
  assert.equal(f.pushes.length, 0);
  f.threads.get("t").turns = [{ id: "fresh-view", status: "inProgress", items: [] }];
  let fresh;
  await f.remote.sessions.observers.open(
    { ...connection, connectionId: "viewer2" },
    "p",
    "t",
    (value) => (fresh = value),
  );
  assert.equal(fresh.snapshot.turns[0].id, "fresh-view");
  f.remote.sessions.observers.release("viewer2");
  f.notify("turn/completed", {
    threadId: "t",
    turn: { id: "own", status: "completed", items: [] },
  });
  await until(() => f.pushes.length === 1);
  assert.equal(f.pushes[0].kind, "turnCompleted");
  await until(() => !f.remote.sessions.observers.projects.size);
  const queued = receipt(f, undefined, { receipt: { queueItemId: "q" } });
  f.threads.get("t").desktop.queue.items = [{ id: "q", status: "pending", turnId: null }];
  f.remote.push.track("p", queued);
  await until(() => f.remote.sessions.observers.projects.get("p")?.client?.ready);
  await pause(10);
  f.notify("areal/queue/updated", {
    threadId: "t",
    queue: {
      items: [
        { id: "other", status: "failed", turnId: "other-turn" },
        { id: "q", status: "running", turnId: "queued-turn" },
      ],
    },
  });
  await pause(20);
  assert.equal(f.pushes.length, 1);
  f.notify("areal/queue/updated", {
    threadId: "t",
    queue: { items: [{ id: "q", status: "cancelled", turnId: "queued-turn" }] },
  });
  await until(() => f.pushes.length === 2);
  assert.equal(f.pushes[1].kind, "turnFailed");
  f.remote.push.track("p", queued);
  assert.equal(f.remote.push.turnWatches.size, 0);
});

test("watch baseline suppresses historical completion; revocation, generation, and close release watchers", async (t) => {
  const f = await fixture(t);
  f.threads.set("t", { id: "t", turns: [{ id: "old", status: "completed", items: [] }] });
  f.remote.push.track("p", receipt(f, "old"), true);
  await until(() => !f.remote.push.turnWatches.size);
  assert.equal(f.pushes.length, 0);
  f.threads.get("t").turns = [{ id: "run", status: "inProgress", items: [] }];
  f.remote.push.track("p", receipt(f, "run"));
  await until(() => f.remote.sessions.observers.projects.get("p")?.client?.ready);
  f.remote.config.deviceGrants = [];
  f.remote.sessions.observers.sweep();
  assert.equal(f.remote.sessions.observers.projects.size, 0);
  f.remote.config.deviceGrants = [f.grant];
  f.remote.push.track("p", receipt(f, "run"));
  await until(() => f.remote.sessions.observers.projects.get("p")?.client?.ready);
  f.project.service.generation = "g2";
  f.remote.sessions.observers.sweep();
  assert.equal(f.remote.sessions.observers.projects.size, 0);
  f.remote.push.track("p", receipt(f, "run"));
  await until(() => f.remote.sessions.observers.projects.get("p")?.client?.ready);
  f.remote.close();
  assert.equal(f.remote.push.turnWatches.size, 0);
  assert.equal(f.remote.sessions.observers.projects.size, 0);
  assert.equal(f.remote.push.timer, undefined);
});

test("Relay push frames share the pacing queue and recheck authorization before wire send", async () => {
  const frames = [];
  let valid = true;
  const transport = Object.assign(Object.create(RelayTransport.prototype), {
    closed: false,
    ready: true,
    pushSupported: true,
    draining: false,
    paceTimer: null,
    channels: new Map(),
    controls: new Map(),
    pushGuards: new Map(),
    controlBytes: 0,
    maxFrameBytes: 65536,
    frameInterval: 1,
    bytesPerSecond: 1e6,
    nextSendAt: performance.now() + 20,
    remote: { sessions: { sendBufferedBytes: () => 0 } },
    socket: {
      readyState: 1,
      bufferedAmount: 0,
      send(text, callback) {
        frames.push(JSON.parse(text));
        callback();
      },
    },
  });
  const message = {
    type: "push",
    token: "a".repeat(64),
    environment: "development",
    collapseId: "c",
    kind: "attention",
    count: 1,
    target: { projectId: "p" },
  };
  assert.equal(
    transport.tryPush(message, () => valid),
    true,
  );
  valid = false;
  await pause(35);
  assert.equal(frames.length, 0);
  valid = true;
  assert.equal(
    transport.tryPush(message, () => valid),
    true,
  );
  await pause(10);
  assert.equal(frames[0].type, "push");
  transport.pushSupported = false;
  assert.equal(
    transport.tryPush(message, () => valid),
    false,
  );
  transport.clearPacing();
});

test("enqueue admission journal preserves exact queue identity across durable reload", async (t) => {
  const f = await fixture(t);
  const { SubmissionRecovery } = require("@areal/workbench-service/desktop/core/submission-recovery.cjs");
  const { parseSubmissionOutcomes } = require("@areal/workbench-service/desktop/core/project-state.cjs");
  const journalPath = join(f.home, "host-journal-fixture.json");
  const journal = {
    async read() {
      try {
        return { snapshot: JSON.parse(await readFile(journalPath, "utf8")) };
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return {
          snapshot: structuredClone({
            version: 1,
            pending: f.project.pending,
            outcomes: f.project.outcomes,
          }),
        };
      }
    },
    async change(mutate) {
      const { snapshot } = await this.read();
      await writeFile(journalPath, JSON.stringify(await mutate(snapshot)));
      return { state: "completed" };
    },
  };
  const recovery = new SubmissionRecovery({
    ...f.remote.backend,
    host: { journal: () => journal },
    onChange() {},
  });
  const operationId = randomUUID();
  const entry = {
    method: "areal/turn/enqueue",
    operationId,
    params: { threadId: "t", requestId: operationId },
    remote: {
      ...receipt(f, "unused").remote,
      capability: "submit",
      admittedGrantRevision: 1,
      semanticDigest: "a".repeat(64),
      target: { threadId: "t" },
    },
  };
  f.project.pending = [entry];
  await recovery.rememberRemoteOutcome(f.project, entry, { queueItemId: "native-queue-id" }, null);
  const disk = parseSubmissionOutcomes((await journal.read()).snapshot.outcomes);
  assert.equal(disk[operationId].receipt.queueItemId, "native-queue-id");
  assert.equal(disk[operationId].turnId, undefined);
  assert.equal(f.project.pending.length, 0);
  await assert.rejects(
    recovery.rememberRemoteOutcome(
      f.project,
      { ...entry, operationId: randomUUID() },
      { queueItemId: null },
      null,
    ),
    /原生关联/,
  );
});

test("real Host Relay transport negotiates push, drops rate errors, consumes 410, and resets capability on close", async (t) => {
  const f = await fixture(t);
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  let relaySocket;
  let header;
  const frames = [];
  server.on("connection", (socket, request) => {
    relaySocket = socket;
    header = request.headers["x-areal-relay-capabilities"];
    socket.on("message", (bytes) => {
      const message = JSON.parse(bytes);
      frames.push(message);
      if (message.role === "host")
        socket.send(
          JSON.stringify({
            type: "ready",
            push: true,
            limits: {
              framesPerSecond: 12,
              bytesPerSecond: 524288,
              maxFrameBytes: 131072,
              heartbeatIntervalMs: 15000,
            },
          }),
        );
    });
  });
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  f.remote.config.relay = `http://127.0.0.1:${server.address().port}`;
  f.remote.relayTransport = new RelayTransport(f.remote);
  await until(() => f.remote.connected);
  assert.equal(header, "push");
  assert.equal(f.remote.relayTransport.pushSupported, true);
  relaySocket.send(JSON.stringify({ type: "error", code: "LIMIT_EXCEEDED" }));
  await until(() => f.remote.push.diagnostic === "push-dropped");
  assert.equal(f.remote.connected, true);
  const message = {
    type: "push",
    token: f.grant.push.token,
    environment: "development",
    collapseId: "local-wire",
    kind: "attention",
    count: 1,
    target: { projectId: "p" },
  };
  assert.equal(
    f.remote.relayTransport.tryPush(message, () => true),
    true,
  );
  await until(() => frames.some((frame) => frame.type === "push"));
  relaySocket.send(
    JSON.stringify({ type: "pushResult", token: f.grant.push.token, status: "unregistered" }),
  );
  await until(() => !f.remote.config.deviceGrants[0].push);
  assert.equal(f.remote.connected, true);
  relaySocket.close();
  await until(() => !f.remote.connected);
  assert.equal(f.remote.relayTransport.pushSupported, false);
});

test("pacing preserves newer collapse count while a prior push callback is in flight", async () => {
  const frames = [];
  const callbacks = [];
  const transport = Object.assign(Object.create(RelayTransport.prototype), {
    closed: false,
    ready: true,
    pushSupported: true,
    draining: false,
    paceTimer: null,
    channels: new Map(),
    controls: new Map(),
    pushGuards: new Map(),
    controlBytes: 0,
    maxFrameBytes: 65536,
    frameInterval: 0,
    bytesPerSecond: 1e12,
    nextSendAt: 0,
    remote: { sessions: { sendBufferedBytes: () => 0 }, push: {} },
    socket: {
      readyState: 1,
      bufferedAmount: 0,
      send(text, callback) {
        frames.push(JSON.parse(text));
        callbacks.push(callback);
      },
      terminate() {
        assert.fail("push must not disconnect business transport");
      },
    },
  });
  const message = {
    type: "push",
    token: "a".repeat(64),
    environment: "development",
    collapseId: "c",
    kind: "attention",
    count: 1,
    target: { projectId: "p" },
  };
  transport.tryPush(message, () => true);
  transport.tryPush({ ...message, count: 2 }, () => true);
  callbacks.shift()();
  await until(() => frames.length === 2);
  assert.deepEqual(
    frames.map((frame) => frame.count),
    [1, 2],
  );
  callbacks.shift()();
  transport.tryPush({ ...message, target: { projectId: "x".repeat(257) } }, () => true);
  assert.equal(frames.length, 2);
  transport.tryPush(message, () => true);
  await until(() => callbacks.length === 1);
  callbacks.shift()(new Error("fixture send failure"));
  assert.equal(transport.remote.push.diagnostic, "push-dropped");
  transport.clearPacing();
});

test("device receipts stay peer scoped, survive unknown save outcomes, and remain readable without an online project", async (t) => {
  const f = await fixture(t);
  const phone = await f.phone();
  const commandId = randomUUID();
  const params = { platform: "apns", token: "d".repeat(64), environment: "production" };
  const save = f.remote.backend.save;
  f.remote.backend.save = async (...args) => {
    await save(...args);
    throw new Error("private fixture storage path");
  };
  const unknown = await phone.rpc("device.push.register", params, commandId);
  assert.equal(unknown.error.submissionUnknown, true);
  assert.ok(!JSON.stringify(unknown).includes("private fixture"));
  f.remote.backend.save = save;
  await f.remote.init();
  f.project.model.state.connected = false;
  const known = await phone.rpc("command.read", { commandId });
  assert.equal(known.result.admissionState, "accepted");
  assert.equal(known.result.receipt.registered, true);
  f.remote.config.deviceGrants.push({ ...f.grant, devicePeerId: "other" });
  let other;
  await deviceCommand(
    f.remote,
    { ...f.connection, peer: "other" },
    { method: "command.read", params: { commandId } },
    (value) => {
      other = value;
    },
  );
  assert.equal(other.admissionState, "notFound");
  phone.close();
});

test("notification send authorization includes the project generation at actual drain time", async (t) => {
  const f = await fixture(t);
  let guard;
  f.remote.relayTransport.tryPush = (_message, authorized) => {
    guard = authorized;
    return true;
  };
  const message = {
    type: "push",
    token: f.grant.push.token,
    environment: "development",
    collapseId: "g",
    kind: "attention",
    count: 1,
    target: { projectId: "p" },
  };
  f.remote.push.send(f.grant, message, "answer");
  assert.equal(guard(), true);
  f.project.service.generation = "replacement";
  assert.equal(guard(), false);
});

test("unavailable old turns release notification capacity, and a steered queue item follows its exact native turn", async (t) => {
  const f = await fixture(t);
  f.threads.set("t", {
    id: "t",
    turns: [{ id: "latest", status: "inProgress", items: [] }],
    desktop: { queue: { revision: 1, items: [] } },
  });
  f.remote.push.track("p", receipt(f, "missing-old"), true);
  await until(() => !f.remote.push.turnWatches.size);
  assert.equal(f.pushes.length, 0);
  assert.equal(f.remote.push.diagnostic, "push-turn-unavailable");
  f.threads.get("t").desktop.queue.items = [
    { id: "steered-q", status: "steered", turnId: "steered-turn" },
  ];
  f.remote.push.track("p", receipt(f, undefined, { receipt: { queueItemId: "steered-q" } }));
  await until(
    () => f.requests.filter((request) => request.method === "areal/thread/observe").length === 2,
  );
  await pause(10);
  f.notify("turn/completed", {
    threadId: "t",
    turn: { id: "latest", status: "completed", items: [] },
  });
  await pause(10);
  assert.equal(f.pushes.length, 0);
  f.notify("turn/completed", {
    threadId: "t",
    turn: { id: "steered-turn", status: "completed", items: [] },
  });
  await until(() => f.pushes.length === 1);
  assert.equal(f.pushes[0].kind, "turnCompleted");
  await until(() => !f.remote.push.turnWatches.size);
  assert.equal(f.remote.sessions.observers.projects.size, 0);
});

for (const status of ["completed", "failed"]) {
  for (const baseline of [true, false]) {
    test(`steered queue ${status} before observation releases capacity and ${baseline ? "suppresses historical" : "sends fresh"} notification`, async (t) => {
      const f = await fixture(t);
      f.threads.set("t", {
        id: "t",
        turns: [
          { id: "own-turn", status, items: [] },
          { id: "latest", status: "inProgress", items: [] },
        ],
        desktop: {
          queue: {
            revision: 1,
            items: [{ id: "steered-q", status: "steered", turnId: "own-turn" }],
          },
        },
      });
      f.remote.push.track(
        "p",
        receipt(f, undefined, { receipt: { queueItemId: "steered-q" } }),
        baseline,
      );
      await until(() => !f.remote.push.turnWatches.size);
      assert.equal(f.remote.sessions.observers.projects.size, 0);
      assert.deepEqual(
        f.pushes.map((push) => ({ kind: push.kind, target: push.target })),
        baseline
          ? []
          : [
              {
                kind: status === "completed" ? "turnCompleted" : "turnFailed",
                target: { projectId: "p", threadId: "t" },
              },
            ],
      );
    });
  }
}
