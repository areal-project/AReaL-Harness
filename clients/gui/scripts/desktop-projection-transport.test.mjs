import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { once } from "node:events";
import { withSmokeDeadline } from "./smoke-deadline.mjs";

const require = createRequire(import.meta.url);
const {
  DesktopService,
  PROTOCOL,
} = require("@areal/workbench-service/desktop/core/service-protocol.cjs");
const { ServiceConnection } = require("../app/src/core/service-connection.cjs");
const {
  ProjectionEncoder,
  ProjectionReader,
} = require("../packages/workbench/client/state-projection.cjs");

function fixture() {
  let thread = {
    id: "t",
    turns: [{ id: "turn", items: [{ id: "item", type: "historyDeferred" }] }],
  };
  const backend = {
    projects: new Map(),
    starting: new Map(),
    analytics: { sample() {}, async flush() {} },
    providers: { redact: (value) => value },
    library: { value: { settings: {} } },
    hasWork: () => false,
    snapshot: () => ({ projects: [{ id: "p", state: { threads: { t: thread } } }] }),
    async command(_name, request) {
      if (request.operation === "acquire") return { supported: true };
      thread = {
        ...thread,
        turns: [
          {
            id: "turn",
            items: [
              request.operation === "release"
                ? { id: "item", type: "historyDeferred" }
                : { id: "item", type: "agentMessage", text: "X".repeat(70 * 1024 * 1024) },
            ],
          },
        ],
      };
      return { loaded: request.operation !== "release" };
    },
  };
  return new DesktopService(backend, "large-projection-fixture");
}

test("socket and pane release fence a late history acquire without releasing another client", async () => {
  const service = fixture(),
    views = new Set(),
    pending = [];
  service.backend.command = async (_name, request) => {
    if (request.operation === "acquire") {
      await new Promise((resolve) => pending.push(resolve));
      views.add(request.viewId);
    }
    if (request.operation === "release") views.delete(request.viewId);
    return { supported: true };
  };
  const connections = [
    new ServiceConnection(
      () => {},
      () => {},
    ),
    new ServiceConnection(
      () => {},
      () => {},
    ),
  ];
  const wait = async (predicate) => {
    for (let i = 0; !predicate(); i++) {
      assert.ok(i < 200);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  try {
    const metadata = await service.listen();
    for (const connection of connections) {
      await connection.connect(metadata);
      await connection.request("hello", { protocol: PROTOCOL, identity: metadata.identity });
    }
    const request = {
      projectId: "p",
      threadId: "t",
      viewId: "shared-user-id",
      operation: "acquire",
    };
    const first = connections[0].request("command", { name: "history", request });
    await wait(() => pending.length === 1);
    pending.shift()();
    await first;
    const second = connections[1].request("command", { name: "history", request });
    await wait(() => pending.length === 1);
    await connections[1].request("command", {
      name: "history",
      request: { ...request, operation: "release" },
    });
    pending.shift()();
    await second;
    assert.equal(
      views.size,
      1,
      "pane cleanup cancels a late acquire while preserving the other socket",
    );
    const late = connections[1].request("command", { name: "history", request }).catch(() => {});
    await wait(() => pending.length === 1);
    connections[1].close();
    await wait(() => service.clients.size === 1);
    pending.shift()();
    await late;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(views.size, 1, "a disconnected acquire cannot pin a view");
    connections[0].close();
    await wait(() => !service.clients.size);
    await wait(() => !views.size);
  } finally {
    for (const connection of connections) connection.close();
    service.close();
  }
});

test("real Desktop service delivers an explicit 70MiB item, command receipt and release without disconnect", async () => {
  const service = fixture();
  let last,
    closed = false;
  const connection = new ServiceConnection(
    (packet) => {
      last = packet;
    },
    () => {
      closed = true;
    },
  );
  try {
    const metadata = await service.listen();
    await connection.connect(metadata);
    await connection.request("hello", { protocol: PROTOCOL, identity: metadata.identity });
    await connection.request("command", {
      name: "history",
      request: { projectId: "p", threadId: "t", viewId: "v", operation: "acquire" },
    });
    const request = {
      projectId: "p",
      threadId: "t",
      viewId: "v",
      operation: "loadItem",
      itemId: "item",
    };
    assert.equal((await connection.request("command", { name: "history", request })).loaded, true);
    assert.equal(
      last.snapshot.projects[0].state.threads.t.turns[0].items[0].text.length,
      70 * 1024 * 1024,
    );
    assert.equal(closed, false);
    assert.equal(
      (
        await connection.request("command", {
          name: "history",
          request: { ...request, operation: "release", itemId: undefined },
        })
      ).loaded,
      false,
    );
    assert.equal(
      last.snapshot.projects[0].state.threads.t.turns[0].items[0].type,
      "historyDeferred",
    );
    assert.equal(closed, false);
  } finally {
    connection.close();
    service.close();
  }
});

function heldSocket() {
  return {
    readyState: 1,
    bufferedAmount: 0,
    sent: [],
    projection: new ProjectionEncoder("held"),
    send(text, callback) {
      this.sent.push({ value: JSON.parse(text), callback });
    },
    terminate() {
      this.readyState = 3;
      this.terminated = true;
    },
  };
}

test("a blocked frame coalesces state without projection gaps and keeps command replies ordered", () => {
  const service = fixture(),
    socket = heldSocket(),
    decoder = new ProjectionReader();
  service.sendPacket(socket, service.packet(), { method: "state" });
  service.sendPacket(socket, service.packet(), { method: "state" });
  service.send(socket, { id: 1, result: "first" });
  service.sendPacket(socket, service.packet(), { method: "state" });
  service.send(socket, { id: 2, result: "second" });
  assert.equal(socket.sent.length, 1, "one frame is in flight until its callback");
  decoder.read(socket.sent[0].value.params.snapshot);
  socket.sent[0].callback();
  assert.equal(socket.sent.length, 2);
  assert.equal(socket.sent[1].value.id, 1);
  socket.sent[1].callback();
  socket.sent[2].callback();
  socket.sent[3].callback();
  decoder.read(socket.sent[2].value.params.snapshot);
  assert.equal(socket.sent[2].value.params.sequence, 3, "only latest pending state is encoded");
  assert.deepEqual(
    socket.sent.filter((frame) => frame.value.id).map((frame) => frame.value.id),
    [1, 2],
  );
});

test("a blocked response queue above 32MiB terminates and cannot send after failure", () => {
  const service = fixture(),
    socket = heldSocket();
  service.send(socket, { id: 0, result: "in flight" });
  service.send(socket, { id: 1, result: "x".repeat(17 * 1024 * 1024) });
  service.send(socket, { id: 2, result: "y".repeat(17 * 1024 * 1024) });
  assert.equal(socket.terminated, true);
  socket.sent[0].callback?.();
  assert.equal(socket.sent.length, 1, "queued replies are discarded on termination");
});

test("coalescing state cannot move a newer packet before an already queued full snapshot reply", () => {
  const service = fixture(),
    socket = heldSocket(),
    reader = new ProjectionReader();
  const original = service.backend.snapshot;
  let version = 1;
  service.backend.snapshot = () => ({ ...original(), version });
  service.sendPacket(socket, service.packet(), { method: "state" });
  version = 2;
  service.sendPacket(socket, service.packet(), { method: "state" });
  version = 3;
  service.sendPacket(socket, service.packet(), { id: 8 }, true);
  version = 4;
  service.sendPacket(socket, service.packet(), { method: "state" });
  for (let i = 0; i < socket.sent.length; i++) socket.sent[i].callback();
  const packets = socket.sent.map((frame) => frame.value.params ?? frame.value.result);
  assert.deepEqual(
    packets.map((packet) => packet.sequence),
    [1, 3, 4],
    "packet order and actual projection order must agree",
  );
  for (const packet of packets) reader.read(packet.snapshot);
  assert.equal(
    reader.value.version,
    4,
    "the reader retains the latest state after all queued frames",
  );
});

function conversation(text, status) {
  return {
    projects: [
      {
        id: "p",
        state: {
          threads: {
            t: {
              id: "t",
              turns: [{ id: "turn", status, items: [{ id: "item", type: "agentMessage", text }] }],
            },
          },
        },
      },
    ],
  };
}

test("a missing delta closes the socket, preserves unknown writes and reconnects from an authoritative baseline", async () => {
  const service = fixture(),
    accepted = Promise.withResolvers(),
    release = Promise.withResolvers(),
    disconnected = Promise.withResolvers(),
    states = [];
  let authoritative = conversation("original", "inProgress"),
    writes = 0;
  service.backend.snapshot = () => structuredClone(authoritative);
  // 手动交付投影帧，精确控制缺帧位置；真实 socket 和生产解码仍参与验收。
  service.schedule = () => {};
  const sendPacket = service.sendPacket.bind(service);
  let handoff = false;
  service.sendPacket = (socket, packet, header, full) => {
    sendPacket(socket, packet, header, full);
    if (full && !handoff) {
      handoff = true;
      authoritative = conversation("completed evidence", "completed");
      service.publish();
    }
  };
  service.backend.command = async (name, request) => {
    assert.equal(name, "manage");
    assert.equal(request.operation, "archive");
    assert.equal(request.requestId, "archive-once");
    writes++;
    accepted.resolve();
    await release.promise;
    return { archived: true };
  };
  const connection = new ServiceConnection(
    (packet) => states.push(packet.snapshot),
    () => disconnected.resolve(),
  );
  try {
    const metadata = await service.listen();
    await connection.connect(metadata);
    const hello = await connection.request("hello", {
      protocol: PROTOCOL,
      identity: metadata.identity,
    });
    assert.deepEqual(hello.snapshot, conversation("original", "inProgress"));
    const socket = [...service.clients][0];
    await connection.request("activity", { focused: false });
    assert.deepEqual(states.at(-1), conversation("completed evidence", "completed"));
    const sequence = socket.projection.sequence;
    for (const oldSequence of [sequence, 1]) {
      socket.send(
        JSON.stringify({
          method: "state",
          params: {
            snapshot: {
              projection: 1,
              stream: socket.projection.stream,
              sequence: oldSequence,
              kind: "full",
              snapshot: conversation("obsolete", "inProgress"),
            },
          },
        }),
      );
    }
    await connection.request("activity", { focused: false });
    assert.ok(
      states.every(
        (snapshot) => snapshot.projects[0].state.threads.t.turns[0].status === "completed",
      ),
    );
    const outcome = connection
      .request(
        "command",
        {
          name: "manage",
          request: {
            projectId: "p",
            operation: "archive",
            threadId: "t",
            requestId: "archive-once",
          },
        },
        true,
      )
      .then(
        () => assert.fail("a dropped reply cannot confirm the write"),
        (error) => error,
      );
    await withSmokeDeadline("archive admitted", () => accepted.promise);
    // 编码但不交付一帧，下一帧引用的 base 因此不在客户端。
    socket.projection.encode(conversation("missing intermediate", "completed"));
    authoritative = conversation("latest durable evidence", "completed");
    service.sendPacket(socket, service.packet(), { method: "state" });
    await withSmokeDeadline("projection gap disconnect", () => disconnected.promise);
    const unknown = await outcome;
    assert.equal(unknown.submissionUnknown, true);
    assert.equal(unknown.requestId, "archive-once");
    assert.equal(unknown.recovery.kind, "queryOriginal");
    assert.deepEqual(states.at(-1), conversation("completed evidence", "completed"));
    release.resolve();
    await connection.connect(metadata);
    const restored = await connection.request("hello", {
      protocol: PROTOCOL,
      identity: metadata.identity,
    });
    assert.deepEqual(restored.snapshot, conversation("latest durable evidence", "completed"));
    assert.deepEqual(restored.snapshot, service.backend.snapshot());
    await connection.request("activity", { focused: false });
    assert.equal(writes, 1, "reconnecting must not resend an unconfirmed write");
  } finally {
    release.resolve();
    connection.close();
    service.close();
  }
});

test("late state and command replies from a replaced socket cannot overwrite the new connection", async () => {
  const service = fixture(),
    accepted = Promise.withResolvers(),
    release = Promise.withResolvers(),
    states = [];
  let authoritative = conversation("old connection", "inProgress"),
    writes = 0;
  service.backend.snapshot = () => structuredClone(authoritative);
  service.schedule = () => {};
  service.backend.command = async () => {
    writes++;
    accepted.resolve();
    await release.promise;
    return { archived: true };
  };
  const connection = new ServiceConnection((packet) => states.push(packet.snapshot));
  let oldClient;
  try {
    const metadata = await service.listen();
    await connection.connect(metadata);
    await connection.request("hello", { protocol: PROTOCOL, identity: metadata.identity });
    oldClient = connection.socket;
    const oldServer = [...service.clients][0];
    authoritative = conversation("new connection evidence", "completed");
    await connection.connect(metadata);
    const hello = await connection.request("hello", {
      protocol: PROTOCOL,
      identity: metadata.identity,
    });
    assert.deepEqual(hello.snapshot, conversation("new connection evidence", "completed"));
    const currentServer = [...service.clients].find((socket) => socket !== oldServer);
    service.sendPacket(currentServer, service.packet(), { method: "state" });
    await connection.request("activity", { focused: false });
    const current = structuredClone(states);
    const result = connection.request(
      "command",
      {
        name: "manage",
        request: { projectId: "p", operation: "archive", threadId: "t", requestId: "new-write" },
      },
      true,
    );
    await withSmokeDeadline("new socket command admitted", () => accepted.promise);
    const id = connection.nextId;
    const stateReceived = once(oldClient, "message");
    service.sendPacket(
      oldServer,
      {
        ...service.packet(),
        snapshot: conversation("late obsolete evidence", "inProgress"),
      },
      { method: "state" },
    );
    await withSmokeDeadline("old socket state received", () => stateReceived);
    assert.deepEqual(states, current);
    const replyReceived = once(oldClient, "message");
    oldServer.send(JSON.stringify({ id, result: { archived: false } }));
    await withSmokeDeadline("old socket reply received", () => replyReceived);
    assert.equal(connection.pending.has(id), true, "old socket cannot settle the current command");
    release.resolve();
    assert.deepEqual(await result, { archived: true });
    assert.equal(writes, 1);
    assert.deepEqual(states.at(-1), conversation("new connection evidence", "completed"));
  } finally {
    release.resolve();
    oldClient?.close();
    connection.close();
    service.close();
  }
});
