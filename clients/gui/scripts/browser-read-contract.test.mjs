import assert from "node:assert/strict";
import { test } from "node:test";
import { CoreClient } from "../packages/runtime-client/core.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { DesktopService, PROTOCOL } = require("@areal/workbench-service/desktop/core/service-protocol.cjs");
const { validToolInput } = require("@areal/workbench-service/desktop/core/browser-tool.cjs");

test("browser observation and capture accept only bounded declared parameters", () => {
  const pageId = "00000000-0000-4000-8000-000000000001";
  assert.equal(
    validToolInput({
      operation: "observe",
      parameters: { pageId, scope: "document", budget: { nodes: 20, textBytes: 1024 } },
    }),
    true,
  );
  assert.equal(
    validToolInput({ operation: "observe", parameters: { pageId, scope: "viewport" } }),
    false,
  );
  assert.equal(
    validToolInput({ operation: "capture", parameters: { pageId, scope: "viewport" } }),
    true,
  );
  assert.equal(
    validToolInput({ operation: "observe", parameters: { pageId, budget: { nodes: 1001 } } }),
    false,
  );
  assert.equal(
    validToolInput({ operation: "capture", parameters: { pageId, scope: "full" } }),
    false,
  );
  assert.equal(
    validToolInput({
      operation: "act",
      parameters: { pageId, snapshotId: pageId, action: { kind: "click", ref: "r1" } },
    }),
    true,
  );
  assert.equal(
    validToolInput({
      operation: "act",
      parameters: {
        pageId,
        snapshotId: pageId,
        action: { kind: "click", ref: "r1", preparedActionId: "forged" },
      },
    }),
    false,
  );
  assert.equal(
    validToolInput({
      operation: "act",
      parameters: {
        pageId,
        snapshotId: pageId,
        action: { kind: "fill", ref: "r1", value: "ok", allow: true },
      },
    }),
    false,
  );
  assert.equal(
    validToolInput({
      operation: "act",
      parameters: { pageId, snapshotId: pageId, action: { kind: "clickAt", x: 320, y: 180 } },
    }),
    true,
  );
  assert.equal(
    validToolInput({
      operation: "act",
      parameters: {
        pageId,
        snapshotId: pageId,
        action: { kind: "drag", fromX: 10, fromY: 20, toX: 300, toY: 210, steps: 4 },
      },
    }),
    true,
  );
  assert.equal(
    validToolInput({
      operation: "act",
      parameters: {
        pageId,
        snapshotId: pageId,
        action: { kind: "pressAt", x: 320, y: 180, key: "ArrowRight" },
      },
    }),
    true,
  );
  assert.equal(
    validToolInput({
      operation: "act",
      parameters: { pageId, snapshotId: pageId, action: { kind: "clickAt", x: -1, y: 180 } },
    }),
    false,
  );
  assert.equal(
    validToolInput({
      operation: "act",
      parameters: {
        pageId,
        snapshotId: pageId,
        action: { kind: "drag", fromX: 1, fromY: 1, toX: 2, toY: 2, steps: 101 },
      },
    }),
    false,
  );
  assert.equal(
    validToolInput({
      operation: "act",
      parameters: {
        pageId,
        snapshotId: pageId,
        action: { kind: "clickAt", x: 320, y: 180, approved: true },
      },
    }),
    false,
  );
  assert.equal(
    validToolInput({ operation: "wait", parameters: { pageId, timeoutMs: 30001 } }),
    false,
  );
  assert.equal(
    validToolInput({
      operation: "navigate",
      parameters: { pageId, url: "http://localhost:3000/next" },
    }),
    true,
  );
  assert.equal(
    validToolInput({ operation: "openDocument", parameters: { pageId, path: "/tmp/report.html" } }),
    true,
  );
  assert.equal(
    validToolInput({
      operation: "openDocument",
      parameters: { pageId, path: "/tmp/report.html", workspacePath: "/tmp" },
    }),
    false,
  );
  assert.equal(
    validToolInput({
      operation: "navigate",
      parameters: { pageId, url: "file:///tmp/report.html" },
    }),
    false,
  );
  assert.equal(
    validToolInput({
      operation: "newPage",
      parameters: { pageId, url: "http://localhost:3000/new" },
    }),
    true,
  );
  assert.equal(
    validToolInput({ operation: "newPage", parameters: { pageId, url: "javascript:alert(1)" } }),
    false,
  );
  assert.equal(
    validToolInput({
      operation: "navigate",
      parameters: { pageId, url: "http://localhost:3000", allow: true },
    }),
    false,
  );
});

test("native browser controls accept bounded intent and reject injected execution details", () => {
  const pageId = "00000000-0000-4000-8000-000000000001";
  const act = (action) =>
    validToolInput({ operation: "act", parameters: { pageId, snapshotId: pageId, action } });
  const wait = (condition) =>
    validToolInput({ operation: "wait", parameters: { pageId, timeoutMs: 500, condition } });
  for (const action of [
    { kind: "scroll", target: "viewport", deltaX: 0, deltaY: 512 },
    { kind: "hover", ref: "r1" },
    { kind: "selectOption", ref: "r1", value: "exact" },
    { kind: "setChecked", ref: "r1", checked: true },
  ]) {
    assert.equal(act(action), true, JSON.stringify(action));
    for (const injected of [{ selector: "#control" }, { backendNodeId: 42 }, { code: "alert(1)" }])
      assert.equal(act({ ...action, ...injected }), false);
  }
  for (const delta of [0.5, 4097, -4097, Infinity, NaN, "10"])
    assert.equal(act({ kind: "scroll", target: "viewport", deltaX: 0, deltaY: delta }), false);
  assert.equal(act({ kind: "scroll", target: "viewport", deltaX: 0, deltaY: 0 }), false);
  assert.equal(act({ kind: "selectOption", ref: "r1", value: "x".repeat(257) }), false);
  assert.equal(act({ kind: "setChecked", ref: "r1", checked: "true" }), false);
  for (const kind of ["checked", "enabled"]) {
    assert.equal(wait({ kind, ref: "r1", value: false }), true);
    assert.equal(wait({ kind, ref: "r1", value: true }), true);
    assert.equal(wait({ kind, ref: "r1", value: "false" }), false);
    assert.equal(wait({ kind, ref: "r1", value: false, selector: "#control" }), false);
  }
});

test("batch accepts only eight observed same-page actions or bounded waits", () => {
  const pageId = "00000000-0000-4000-8000-000000000001";
  const snapshotId = "00000000-0000-4000-8000-000000000002";
  const click = { operation: "act", snapshotId, action: { kind: "click", ref: "r1" } };
  const wait = { operation: "wait", timeoutMs: 50 };
  const input = (steps) => ({ operation: "runBatch", parameters: { pageId, snapshotId, steps } });
  assert.equal(validToolInput(input([click, wait])), true);
  assert.equal(validToolInput(input(Array(8).fill(wait))), true);
  assert.equal(validToolInput(input([])), false);
  assert.equal(validToolInput(input(Array(9).fill(wait))), false);
  assert.equal(validToolInput(input([{ operation: "navigate", url: "http://localhost/" }])), false);
  assert.equal(validToolInput(input([{ ...click, pageId }])), false);
  assert.equal(
    validToolInput(
      input([click, { operation: "act", snapshotId, action: { kind: "clickAt", x: 1, y: 1 } }]),
    ),
    false,
  );
  assert.equal(
    validToolInput({
      operation: "runBatch",
      parameters: { pageId, snapshotId, steps: [click], approved: true },
    }),
    false,
  );
});

test("bound client may answer a browser tool request while ordinary clients reject it", async () => {
  const replies = [];
  const socket = { readyState: 1, send: (data) => replies.push(JSON.parse(data)) };
  const request = {
    id: 9,
    method: "item/tool/call",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      tool: "browser_v1",
      arguments: { operation: "observe", parameters: { pageId: "page-1" } },
    },
  };
  const ordinary = new CoreClient({ createSocket: () => socket });
  ordinary.socket = socket;
  ordinary.receive(JSON.stringify(request));
  assert.equal(replies.at(-1).error.code, -32601);

  const bound = new CoreClient({
    createSocket: () => socket,
    onServerRequest: async () => ({
      success: true,
      contentItems: [{ type: "inputText", text: "fixture sentinel" }],
    }),
  });
  bound.socket = socket;
  bound.receive(JSON.stringify(request));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replies.at(-1).id, 9);
  assert.equal(replies.at(-1).result.contentItems[0].text, "fixture sentinel");
});

test("only the Main owner disconnect revokes its Core tool connection and successor drops ownerless hosts", async (t) => {
  const { once } = await import("node:events");
  const WebSocket = require("ws");
  const { CoreBackend } = require("@areal/workbench-service/desktop/core/backend.cjs");
  const { ProjectConnections } = require("@areal/workbench-service/desktop/core/project-connections.cjs");
  const project = { id: "project", model: { state: { threads: {} } } };
  const backend = Object.assign(Object.create(CoreBackend.prototype), {
    projects: new Map([[project.id, project]]),
    starting: new Map(),
    providers: { redact: (value) => value },
    analytics: { sample() {} },
    snapshot: () => ({}),
    hasWork: () => false,
  });
  backend._connections = new ProjectConnections(backend);
  const service = new DesktopService(backend, "owner-fixture");
  service.schedule = () => {};
  const descriptor = await service.listen();
  t.after(() => service.close());
  const sockets = [];
  t.after(() => {
    for (const socket of sockets) socket.terminate();
  });
  const main = async (owns = true) => {
    const socket = new WebSocket(descriptor.endpoint, {
      headers: { Authorization: `Bearer ${descriptor.token}` },
    });
    sockets.push(socket);
    await once(socket, "open");
    const packet = once(socket, "message");
    socket.send(
      JSON.stringify({
        id: 1,
        method: "hello",
        params: {
          protocol: PROTOCOL,
          identity: "owner-fixture",
          capabilities: owns ? { computerHost: 1 } : {},
        },
      }),
    );
    await packet;
    return socket;
  };
  const observer = await main(false);
  const owner = await main();
  const lease = backend.desktopToolOwner();
  const core = {
    closed: false,
    close() {
      this.closed = true;
    },
  };
  project.client = core;
  backend.connections.claimDesktopToolHost(project, core);
  const observerClosed = once(
    [...service.clients].find((socket) => socket !== lease),
    "close",
  );
  observer.close();
  await observerClosed;
  assert.equal(core.closed, false);
  const ownerClosed = once(lease, "close");
  owner.close();
  await ownerClosed;
  assert.equal(service.closed, false);
  assert.equal(backend.desktopToolOwner(), null);
  assert.equal(core.closed, true);

  const ownerless = {
    closed: false,
    close() {
      this.closed = true;
    },
  };
  project.client = ownerless;
  await main();
  assert.equal(ownerless.closed, true, "successor cannot adopt an active ownerless task host");
  const successor = {
    closed: false,
    close() {
      this.closed = true;
    },
  };
  project.client = successor;
  backend.connections.claimDesktopToolHost(project, successor);
  backend.connections.revokeDesktopToolHost(lease);
  assert.equal(
    successor.closed,
    false,
    "late old owner cleanup cannot close successor Core connection",
  );
  const closingOwner = backend.desktopToolOwner();
  closingOwner._readyState = WebSocket.CLOSING;
  assert.equal(backend.desktopToolOwner(), null);
  const closingObserver = {
    closed: false,
    close() {
      this.closed = true;
    },
  };
  project.client = closingObserver;
  await main();
  assert.equal(
    closingObserver.closed,
    true,
    "successor also retires observers created during old owner's close handshake",
  );
  closingOwner._readyState = WebSocket.OPEN;
});

test("an authenticated owner claim refuses a request from another Core generation", async () => {
  const pageId = "00000000-0000-4000-8000-000000000001";
  const sent = [];
  const owner = {
    readyState: 1,
    bufferedAmount: 0,
    send: (data, done) => {
      sent.push(JSON.parse(data));
      done();
    },
  };
  const project = {
    client: { closed: false },
    service: { serviceId: "core-1", generation: "generation-1" },
    model: { state: { threads: { "thread-1": { dynamicTools: [{ name: "browser_v1" }] } } } },
  };
  const backend = {
    projects: new Map([["project-1", project]]),
    starting: new Set(),
    snapshot: () => ({}),
    hasWork: () => false,
    providers: { redact: (value) => value },
    connections: { revokeDesktopToolHost() {} },
    bindBrowserHostForClaim: async () => {},
    currentConnection: (current, client) => current.client === client && !client.closed,
  };
  const service = new DesktopService(backend, "fixture-identity");
  const receive = (id, method, params) =>
    service.receive(owner, Buffer.from(JSON.stringify({ id, method, params })));
  await receive(1, "hello", {
    protocol: PROTOCOL,
    identity: "fixture-identity",
    capabilities: { computerHost: 1 },
  });
  await receive(2, "browserClaim", {
    protocol: "areal.browser.host.v1",
    operations: [
      "describe",
      "observe",
      "capture",
      "act",
      "wait",
      "navigate",
      "openDocument",
      "newPage",
      "diagnostics",
      "runBatch",
      "command",
    ],
    available: true,
    coreInstanceId: "core-1",
    projectId: "project-1",
    threadId: "thread-1",
    pageId,
    browserHostId: "host-1",
    hostGeneration: 1,
    pageGeneration: 1,
    controlEpoch: 1,
  });
  assert.equal(sent.at(-1).result.claimed, true);
  const result = await service.browserRead({
    projectId: "project-1",
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "call-1",
    coreInstanceId: "core-1",
    coreGeneration: "generation-2",
    arguments: { operation: "observe", parameters: { pageId } },
  });
  assert.match(JSON.stringify(result), /host_unavailable/);
  assert.equal(
    sent.some((packet) => packet.method === "browserRequest"),
    false,
  );
  assert.equal(service.browserClaims.size, 0);
  clearTimeout(service.timer);
});

test("revoked or competing claim cannot publish after the Core bind awaits", async () => {
  const pageId = "00000000-0000-4000-8000-000000000001";
  const sent = [];
  const owner = {
    readyState: 1,
    bufferedAmount: 0,
    send: (data, done) => {
      sent.push(JSON.parse(data));
      done();
    },
  };
  const other = {
    readyState: 1,
    bufferedAmount: 0,
    send: (data, done) => {
      sent.push(JSON.parse(data));
      done();
    },
  };
  const project = {
    client: { closed: false },
    service: { serviceId: "core-1", generation: "generation-1" },
    model: { state: { threads: { "thread-1": { dynamicTools: [{ name: "browser_v1" }] } } } },
  };
  const binds = [];
  const backend = {
    projects: new Map([["project-1", project]]),
    starting: new Set(),
    snapshot: () => ({}),
    hasWork: () => false,
    providers: { redact: (value) => value },
    bindBrowserHostForClaim: () => new Promise((resolve) => binds.push(resolve)),
    connections: { revokeDesktopToolHost() {} },
    currentConnection: (current, client) => current.client === client && !client.closed,
  };
  const service = new DesktopService(backend, "fixture-identity");
  const receive = (socket, id, method, params) =>
    service.receive(socket, Buffer.from(JSON.stringify({ id, method, params })));
  const claim = (host, epoch = 1) => ({
    protocol: "areal.browser.host.v1",
    operations: [
      "describe",
      "observe",
      "capture",
      "act",
      "wait",
      "navigate",
      "openDocument",
      "newPage",
      "diagnostics",
      "runBatch",
      "command",
    ],
    available: true,
    coreInstanceId: "core-1",
    projectId: "project-1",
    threadId: "thread-1",
    pageId,
    browserHostId: host,
    hostGeneration: 1,
    pageGeneration: 1,
    controlEpoch: epoch,
  });
  await receive(owner, 1, "hello", {
    protocol: PROTOCOL,
    identity: "fixture-identity",
    capabilities: { computerHost: 1 },
  });
  await receive(other, 2, "hello", { protocol: PROTOCOL, identity: "fixture-identity" });

  const revoked = receive(owner, 3, "browserClaim", claim("host-1"));
  await Promise.resolve();
  await receive(owner, 4, "browserRevoke", {
    projectId: "project-1",
    threadId: "thread-1",
    pageId,
  });
  binds.shift()();
  await revoked;
  assert.equal(sent.find((packet) => packet.id === 3)?.result?.claimed, undefined);
  assert.equal(service.browserClaims.size, 0, "revoked control cannot resurrect a pending page");

  const first = receive(owner, 5, "browserClaim", claim("host-1", 2));
  await Promise.resolve();
  const competing = receive(other, 6, "browserClaim", claim("host-2", 2));
  await Promise.resolve();
  for (const release of binds.splice(0)) release();
  await Promise.all([first, competing]);
  assert.equal(
    sent.find((packet) => packet.id === 6)?.result?.claimed,
    undefined,
    "another live host cannot overtake a pending claim",
  );
  assert.equal(
    service.browserClaims.get(JSON.stringify(["project-1", "thread-1"]))?.browserHostId,
    "host-1",
  );
  clearTimeout(service.timer);
});

test("queued continuation binds to its persisted queue turn and loses entry on removal, takeover or owner loss", async () => {
  const sent = [];
  let service,
    requestId = 10,
    queue = { items: [{ id: "queued-user-message", status: "pending", turnId: null }] };
  const owner = {
    readyState: 1,
    bufferedAmount: 0,
    send: (data, done) => {
      const packet = JSON.parse(data);
      sent.push(packet);
      done();
      if (packet.method === "browserRequest")
        queueMicrotask(() => {
          void receive("browserResult", {
            requestId: packet.params.requestId,
            result: { claimed: true },
          });
        });
    },
  };
  let reads = 0,
    pendingQueueRead = null,
    acceptedQueueId = "queued-user-message";
  const client = {
    closed: false,
    request: async (method, params) => {
      assert.equal(method, "areal/queue/list");
      assert.equal(params.threadId, "thread-1");
      reads++;
      return pendingQueueRead ? pendingQueueRead() : queue;
    },
  };
  const project = {
    client,
    service: { serviceId: "core-1", generation: "generation-1" },
    model: {
      state: { threads: { "thread-1": { turns: [{ id: "old-active", status: "inProgress" }] } } },
    },
  };
  const backend = {
    projects: new Map([["project-1", project]]),
    starting: new Set(),
    snapshot: () => ({}),
    hasWork: () => false,
    providers: { redact: (value) => value },
    currentConnection: (current, connection) => current.client === connection && !connection.closed,
    command: async (_name, _request, context) => {
      context.onBrowserTurnQueued?.(acceptedQueueId);
      return {};
    },
  };
  service = new DesktopService(backend, "queue-fixture");
  const receive = (method, params) =>
    service.receive(owner, Buffer.from(JSON.stringify({ id: ++requestId, method, params })));
  const send = () =>
    receive("command", {
      name: "send",
      request: { projectId: "project-1", threadId: "thread-1", text: "Continue in the Browser" },
    });
  const describe = (turnId) =>
    service.browserRead({
      projectId: "project-1",
      threadId: "thread-1",
      turnId,
      callId: `call-${turnId}`,
      coreInstanceId: "core-1",
      coreGeneration: "generation-1",
      arguments: { operation: "describe", parameters: {} },
    });
  const dispatched = () => sent.filter((packet) => packet.method === "browserRequest");
  try {
    await receive("hello", { protocol: PROTOCOL, identity: "queue-fixture" });
    await send();
    assert.equal(
      service.browserEntrypoints.size,
      1,
      "accepted queued input retains a Browser entry",
    );
    await describe("old-active");
    assert.equal(dispatched().length, 0, "old callback must not consume queued authorization");
    assert.equal(service.browserEntrypoints.size, 1);
    queue = {
      items: [{ id: "queued-user-message", status: "running", turnId: "exact-queued-turn" }],
    };
    await describe("unrelated-next-turn");
    assert.equal(dispatched().length, 0, "next turn is not an authority mapping");
    await describe("exact-queued-turn");
    assert.equal(dispatched().length, 1);
    assert.equal(dispatched()[0].params.turnId, "exact-queued-turn");
    assert.equal(service.browserEntrypoints.size, 0, "entry is consumed once");
    assert.ok(reads >= 3, "each queued claim resolves against Core queue state");
    acceptedQueueId = "queued-first";
    await send();
    acceptedQueueId = "queued-second";
    await send();
    queue = {
      items: [
        { id: "queued-first", status: "running", turnId: "first-queued-turn" },
        { id: "queued-second", status: "pending", turnId: null },
      ],
    };
    await describe("old-active");
    assert.equal(dispatched().length, 1);
    await describe("first-queued-turn");
    assert.equal(
      dispatched().length,
      2,
      "second queued message cannot overwrite first accepted authorization",
    );
    assert.equal(
      service.browserEntrypoints.size,
      1,
      "first consumption preserves second queued entry",
    );
    queue.items[0].status = "completed";
    queue.items[1] = { id: "queued-second", status: "running", turnId: "second-queued-turn" };
    await describe("second-queued-turn");
    assert.equal(dispatched().length, 3);
    assert.equal(service.browserEntrypoints.size, 0);
    acceptedQueueId = "queued-user-message";
    await send();
    queue = { items: [{ id: "queued-user-message", status: "removed", turnId: null }] };
    await describe("exact-queued-turn");
    assert.equal(service.browserEntrypoints.size, 0, "removed input revokes authorization");
    await send();
    acceptedQueueId = "second-revoked-message";
    await send();
    acceptedQueueId = "queued-user-message";
    await receive("browserRevoke", { projectId: "project-1", threadId: "thread-1" });
    queue = {
      items: [{ id: "queued-user-message", status: "running", turnId: "exact-queued-turn" }],
    };
    await describe("exact-queued-turn");
    assert.equal(dispatched().length, 3, "human input revokes queued authorization");
    await send();
    let releaseQueue;
    pendingQueueRead = () =>
      new Promise((resolve) => {
        releaseQueue = resolve;
      });
    const waiting = describe("exact-queued-turn");
    await new Promise((resolve) => setImmediate(resolve));
    await receive("browserRevoke", { projectId: "project-1", threadId: "thread-1" });
    releaseQueue(queue);
    await waiting;
    pendingQueueRead = null;
    assert.equal(dispatched().length, 3, "late queue response cannot revive a revoked entry");
    await send();
    acceptedQueueId = "second-owner-message";
    await send();
    project.client = { ...client };
    await describe("exact-queued-turn");
    assert.equal(
      service.browserEntrypoints.size,
      0,
      "owner reconnect cannot inherit queued authorization",
    );
    assert.equal(dispatched().length, 3);
  } finally {
    service.close();
  }
});

test("browser describe examples expose valid checkbox and command-topic parameters", async () => {
  const pageId = "00000000-0000-4000-8000-000000000001";
  const service = new DesktopService(
    { projects: new Map(), starting: new Set(), snapshot: () => ({}), hasWork: () => false },
    "guidance-fixture",
  );
  service.browserClaims.set(JSON.stringify(["project-1", "thread-1"]), {
    socket: { readyState: 1 },
    coreInstanceId: "core-1",
    coreGeneration: "generation-1",
    browserHostId: "host-1",
    hostGeneration: 1,
    pages: new Map([[pageId, { pageId, pageGeneration: 1, controlEpoch: 1 }]]),
  });
  try {
    const result = await service.browserRead({
      projectId: "project-1",
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      coreInstanceId: "core-1",
      coreGeneration: "generation-1",
      arguments: { operation: "describe", parameters: {} },
    });
    assert.equal(result.success, true);
    const description = JSON.parse(result.contentItems[0].text);
    const checkbox = description.examples.find(
      (example) => example.operation === "act" && example.parameters.action?.kind === "setChecked",
    );
    const topic = description.examples.find(
      (example) =>
        example.operation === "describe" &&
        example.parameters.topic === "command.playwright.locator",
    );
    assert.ok(checkbox, "the model receives an explicit checked:boolean action example");
    assert.ok(topic, "the model receives a supported describe topic example");
    for (const example of [checkbox, topic]) {
      const input = structuredClone(example);
      if (input.parameters.pageId) input.parameters.pageId = pageId;
      if (input.parameters.snapshotId) input.parameters.snapshotId = pageId;
      if (input.parameters.action?.ref) input.parameters.action.ref = "r1";
      assert.equal(validToolInput(input), true, JSON.stringify(input));
    }
    assert.equal(checkbox.parameters.action.checked, true);
    assert.match(description.parameterGuide, /checked.*boolean/);
    assert.match(description.parameterGuide, /command\.<method>/);
    assert.equal(
      validToolInput({
        operation: "act",
        parameters: {
          pageId,
          snapshotId: pageId,
          action: { kind: "setChecked", ref: "r1", value: true },
        },
      }),
      false,
    );
    assert.equal(validToolInput({ operation: "describe", parameters: { topic: "act" } }), false);
  } finally {
    clearTimeout(service.timer);
  }
});
