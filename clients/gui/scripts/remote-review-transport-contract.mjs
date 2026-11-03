// 旧 JS Direct/Core 边界组合保留；末尾另验真实 Rust Host 的审阅客户端路径。
import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeReviewTransport } from "./remote-review-native-fixture.mjs";
import { runWithIsolatedCA } from "./remote-native-push-fixture.mjs";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { BrowserState } from "../renderer/remote-web/browser-state.mjs";
import { SessionBodyReader, CommandState, acceptSessionMessage } from "@areal/remote-client";
import { CoreClient } from "../packages/runtime-client/core.js";
import * as remoteWire from "../packages/remote/src/wire.mjs";
import * as crypto from "../packages/remote/src/channel.mjs";
const require = createRequire(new URL("../app/package.json", import.meta.url));
const WebSocket = require("ws");
const { WebSocketServer } = WebSocket;
const { startDirect } = require("../app/src/core/remote-direct.cjs");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const digest = createHash("sha256").update(png).digest("hex");
const capabilities = {
  features: {
    atomicObserve: true,
    atomicObserveOwnership: true,
    subscriptionRemoval: true,
    taskPauseRunGuard: true,
  },
  methods: ["thread/read", "areal/task/read", "areal/task/pause"],
};
let body = png,
  httpReads = 0,
  callbackCalls = 0,
  nativeCalls = [];
const http = createServer((req, res) => {
  assert.equal(req.headers.authorization, "Bearer fixture-native-secret");
  assert.equal(req.url, `/areal/blobs/${digest}?threadId=t`);
  httpReads++;
  res.writeHead(body ? 200 : 404, {
    "content-type": "application/octet-stream",
    "cache-control": "private, immutable",
  });
  res.end(body ?? undefined);
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const endpoint = `ws://127.0.0.1:${http.address().port}`;
const sockets = [],
  wss = new WebSocketServer({ server: http });
let callbackResponse;
wss.on("connection", (socket, request) => {
  assert.equal(request.headers.authorization, "Bearer fixture-native-secret");
  sockets.push(socket);
  socket.on("message", (data) => {
    const request = JSON.parse(data);
    if (request.id === "desktop-callback") {
      callbackResponse = request;
      return;
    }
    nativeCalls.push(request.method);
    if (request.method === "initialized") return;
    let result;
    if (request.method === "initialize") result = {};
    else if (request.method === "areal/capabilities") result = capabilities;
    else if (["thread/read", "areal/thread/observe"].includes(request.method))
      result = {
        ownership: { kind: "task", taskId: "task", runId: "run" },
        thread: {
          id: "t",
          turns: [
            {
              id: "turn",
              status: "failed",
              error: { message: "partial model error" },
              items: [
                { id: "text", type: "agentMessage", text: "partial result" },
                {
                  id: "image",
                  type: "agentMedia",
                  modality: "image",
                  media: {
                    uri: `areal://blob/${digest}`,
                    mimeType: "image/png",
                    sizeBytes: png.length,
                  },
                },
              ],
            },
          ],
        },
      };
    else if (request.method === "areal/subscription/remove") result = {};
    else if (request.method === "areal/task/read")
      result = {
        id: "task",
        revision: 1,
        paused: false,
        cancelled: false,
        runs: [{ id: "run", status: "running", workers: [] }],
      };
    else assert.fail(`non-read native request ${request.method}`);
    socket.send(JSON.stringify({ id: request.id, result }));
  });
});
const desktop = new CoreClient({
  createSocket: () =>
    new WebSocket(endpoint, { headers: { Authorization: "Bearer fixture-native-secret" } }),
  onServerRequest: async () => {
    callbackCalls++;
    return { success: true };
  },
});
await desktop.connect();
const project = {
  root: "/unreadable",
  endpoint,
  token: "fixture-native-secret",
  service: { serviceId: "native-fixture", generation: "1" },
  client: desktop,
  model: { state: { connected: true }, subscribe: () => () => {} },
};
const host = await crypto.createIdentity(),
  device = await crypto.createIdentity();
const grant = {
  devicePeerId: crypto.identityId(device),
  status: "active",
  revision: 1,
  projectIds: ["p"],
  capabilities: ["observe", "review", "submit", "interrupt", "answer", "pauseTask"],
};
const remote = {
  gatewayGeneration: "gateway",
  crypto,
  config: { directEnabled: true, identity: host, deviceGrants: [grant] },
  backend: {
    saved: [{ id: "p", root: "/unreadable" }],
    projects: new Map([["p", project]]),
    start() {
      assert.fail("must not start");
    },
    openThread() {
      assert.fail("must not open desktop");
    },
    ensure() {
      assert.fail("must not ensure");
    },
  },
};
remote.sessions = new (require("../app/src/core/remote-session-acceptor.cjs").SessionAcceptor)(
  remote,
);
const direct = await startDirect(remote);
const socket = new WebSocket(direct.ws, { origin: direct.origin });
await once(socket, "open");
const wire = crypto.byteChannel(
  (bytes) => socket.send(bytes),
  () => socket.close(),
);
socket.on("message", (bytes) => wire.receive(bytes));
socket.on("close", () => wire.close());
const secure = await crypto.secureChannel(wire, device, crypto.identityId(host)),
  messages = secure.messages();
let id = 0;
const rpc = async (method, params, projectId = "p") => {
  secure.send({ id: String(++id), method, context: { projectId }, params });
  return (await messages.next()).value;
};
// 使用真实 ready 和真实 task.read 响应驱动生产页面，DOM 是唯一界面边界替身。
async function pauseReachability(ready, request, expected) {
  class Element {
    children = [];
    listeners = new Map();
    style = {};
    dataset = {};
    value = "";
    append(...nodes) {
      this.children.push(...nodes);
    }
    replaceChildren(...nodes) {
      this.children = nodes;
    }
    addEventListener(name, fn) {
      this.listeners.set(name, fn);
    }
  }
  const elements = new Map(),
    element = (id) => {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    };
  const context = createContext({
    document: {
      hidden: false,
      body: { dataset: {} },
      getElementById: element,
      createElement: () => new Element(),
      addEventListener() {},
    },
    window: { addEventListener() {}, dispatchEvent() {} },
    navigator: { onLine: true },
    Event,
    BrowserState: class extends BrowserState {
      constructor(options) {
        super({ ...options, indexedDB: null, sessionStorage: null, channel: null });
      }
    },
    CommandState,
    SessionBodyReader,
    createRemoteWorkbench: () => ({ render() {} }),
    acceptSessionMessage,
    ...crypto,
    ...remoteWire,
    URL,
    URLSearchParams,
    TextEncoder,
    WebSocket,
    location: {
      hash: `#host=${ready.hostId}`,
      pathname: "/remote",
      protocol: "http:",
      host: "localhost",
    },
    history: { replaceState() {} },
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval() {},
    actualReady: ready,
    actualRequest: request,
  });
  const connectionSource = await readFile(
    new URL("../packages/remote-client/src/connection.mjs", import.meta.url),
    "utf8",
  );
  const source = await readFile(new URL("../renderer/remote-web/main.js", import.meta.url), "utf8");
  runInContext(
    connectionSource
      .replace(/^import[\s\S]*?;\n/gm, "")
      .replace("export class RemoteConnection", "class RemoteConnection"),
    context,
  );
  runInContext(source.replace(/^import[\s\S]*?;\n/gm, ""), context);
  await runInContext("browserLoading", context);
  await runInContext(
    'connectionIdentity=actualReady; request=actualRequest; selectedProject="p"; taskPauseTarget={projectId:"p",taskId:"task",runId:"run"}; readTaskPause()',
    context,
  );
  assert.equal(element("task-pause-confirm").disabled, true, "explicit review is still required");
  element("task-pause-reviewed").checked = true;
  element("task-pause-reviewed").listeners.get("change")();
  assert.equal(element("task-pause-confirm").disabled, !expected);
}
async function capabilityCase(granted) {
  grant.capabilities = granted;
  const socket = new WebSocket(direct.ws, { origin: direct.origin });
  await once(socket, "open");
  const wire = crypto.byteChannel(
    (bytes) => socket.send(bytes),
    () => socket.close(),
  );
  socket.on("message", (bytes) => wire.receive(bytes));
  socket.on("close", () => wire.close());
  const secure = await crypto.secureChannel(wire, device, crypto.identityId(host)),
    messages = secure.messages();
  try {
    secure.send({
      method: "hello",
      apiVersion: "areal.remote.v2",
      clientVersion: "fixture",
      displayName: "capability fixture",
    });
    const ready = (await messages.next()).value;
    assert.equal(ready.event, "ready");
    assert.deepEqual([...ready.capabilities].sort(), [...granted].sort());
    let id = 0;
    const request = async (envelope) => {
      secure.send({ id: String(++id), ...envelope });
      const message = (await messages.next()).value;
      if (message.error) throw Object.assign(Error(message.error.message), message.error);
      return message.result;
    };
    const described = await request({ method: "host.describe", params: {} });
    assert.deepEqual([...described.capabilities].sort(), [...granted].sort());
    await pauseReachability(ready, request, granted.includes("pauseTask"));
  } finally {
    const closed = once(socket, "close");
    secure.close();
    await closed;
  }
}
try {
  secure.send({
    method: "hello",
    apiVersion: "areal.remote.v2",
    clientVersion: "fixture",
    displayName: "RC10 fixture",
  });
  const ready = (await messages.next()).value;
  assert.ok(ready.capabilities.includes("review"));
  assert.ok(
    ready.capabilities.includes("pauseTask"),
    "Operator must receive its implemented pauseTask capability",
  );
  assert.ok(ready.methods.includes("artifact.read"));
  assert.equal(ready.limits.artifactChunkBytes, 48 * 1024);
  const observed = await rpc("session.open", { threadId: "t" });
  assert.equal(observed.result.snapshot.ownership.runId, "run");
  const currentRun = await rpc("task.read", { taskId: "task", runId: "run" });
  assert.equal(currentRun.result.runStatus, "running");
  const reviewed = await rpc("review.read", { threadId: "t", turnId: "turn" });
  assert.ok(!reviewed.error, JSON.stringify(reviewed));
  assert.equal(JSON.parse(reviewed.result.review.chunk).turnStatus, "failed");
  assert.equal(
    JSON.parse(reviewed.result.review.chunk).taskRunStatus,
    null,
    "historical Turn A must not inherit current Task Run B status",
  );
  const artifactRef = reviewed.result.artifacts[0].artifactRef;
  assert.equal(JSON.stringify(reviewed).includes(digest), false);
  assert.equal(JSON.stringify(reviewed).includes("fixture-native-secret"), false);
  const image = await rpc("artifact.read", { artifactRef, offset: 0, length: 48 * 1024 });
  assert.ok(!image.error, JSON.stringify(image));
  assert.deepEqual(Buffer.from(image.result.base64, "base64"), png);
  assert.equal(httpReads, 1);
  for (const [method, params] of [
    ["review.read", { threadId: "t", turnId: "turn", path: "/secret" }],
    ["artifact.read", { artifactRef, offset: 0, length: 1, uri: `areal://blob/${digest}` }],
    ["artifact.read", { artifactRef, offset: 0, length: 48 * 1024 + 1 }],
  ])
    assert.equal((await rpc(method, params)).error.code, "INVALID_PARAMS");
  assert.equal(
    (await rpc("artifact.read", { artifactRef: "fake", offset: 0, length: 1 })).error.code,
    "RESOURCE_UNAVAILABLE",
  );
  assert.equal(
    (await rpc("review.read", { threadId: "t", turnId: "turn" }, "other-project")).error.code,
    "FORBIDDEN",
  );
  body = null;
  assert.match(
    (await rpc("artifact.read", { artifactRef, offset: 0, length: 1 })).error.message,
    /原结果|制品/,
  );
  assert.equal(
    (await rpc("artifact.read", { artifactRef, offset: 0, length: 1 })).error.code,
    "RESOURCE_UNAVAILABLE",
  );
  sockets[0].send(JSON.stringify({ id: "desktop-callback", method: "item/tool/call", params: {} }));
  for (let n = 0; n < 100 && !callbackResponse; n++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(callbackCalls, 1);
  assert.equal(callbackResponse.result.success, true);
  assert.equal(project.client, desktop);
  assert.equal(desktop.ready, true);
  assert.ok(
    nativeCalls.every((method) =>
      [
        "initialize",
        "initialized",
        "areal/capabilities",
        "thread/read",
        "areal/thread/observe",
        "areal/subscription/remove",
        "areal/task/read",
      ].includes(method),
    ),
  );
  grant.capabilities = ["observe"];
  assert.equal(
    (await rpc("review.read", { threadId: "t", turnId: "turn" })).error.code,
    "FORBIDDEN",
  );
  const originalClosed = once(socket, "close");
  secure.close();
  await originalClosed;
  for (const granted of [
    ["observe", "review", "submit", "interrupt", "answer", "pauseTask"],
    ["observe", "review"],
    ["observe", "submit", "interrupt", "answer"],
  ])
    await capabilityCase(granted);
  console.log(
    "PASS legacy JS owner actual ready/host.describe grant intersections and production pause UI: Operator reachable, Observer and no-pause legacy disabled",
  );
  console.log(
    "PASS legacy JS owner Noise/Direct exact dispatch, readonly CoreClient, native blob HTTP, hidden refs and Desktop callback noninterference (Core boundary fixture)",
  );
} finally {
  secure.close();
  socket.terminate();
  direct.close();
  remote.sessions.close();
  direct.server.closeAllConnections();
  desktop.close();
  for (const native of sockets) native.terminate();
  wss.close();
  http.closeAllConnections();
  await new Promise((resolve) => http.close(resolve));
}

if (!process.env.RC12_TLS_HOME) {
  test("Rust review transport uses the isolated process CA", async () => {
    await runWithIsolatedCA(import.meta.filename);
  });
} else {
  test(
    "Rust Host preserves original partial review and image while a later Task runs",
    { timeout: 180000 },
    nativeReviewTransport,
  );
}
