import { selectRemoteTransport, requireBrowserTransport } from "./remote-conformance-transport.mjs";
const transport = selectRemoteTransport();
await requireBrowserTransport(transport, "remote-session-observation-e2e");
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { CoreClient } from "../packages/runtime-client/core.js";
import {
  byteChannel,
  createIdentity,
  identityId,
  secureChannel,
} from "../packages/remote/src/channel.mjs";
import { selectConversation, captureSmokeFailure } from "./smoke-navigation.mjs";
import { applicationFixture } from "./application-fixture.mjs";
import { respondToSessionName } from "./model-fixture.mjs";
import {
  nativeReady,
  assertObserve,
  installNavigationProbe,
  drainNavigationProbe,
} from "./remote-native-observation-oracle.mjs";
const unknownOnly = process.env.RC04_UNKNOWN_ONLY === "1";
const gui = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron, chromium } = require("playwright-core");
const { CoreBackend } = require("../app/src/core/backend.cjs");
const { DesktopService } = require("../app/src/core/service-protocol.cjs");
const { serviceIdentity } = require("../app/src/core/service-config.cjs");
const { RemoteControl } = require("../app/src/core/remote.cjs");
const { createOwner } = require("../app/src/core/application-owner.cjs");
const WebSocket = require("ws");
const scratch = await mkdtemp("/private/tmp/areal-remote-rc04-");
// Share one fixture app identity with the externally hosted DesktopService.
const applicationOwner = createOwner(join(scratch, "electron"));
const application = await applicationFixture(gui, join(scratch, "application"), `
require(${JSON.stringify(join(gui, "app/src/core/application-owner.cjs"))}).createOwner = profile => {
  require('node:assert/strict').equal(require('node:fs').realpathSync(profile), ${JSON.stringify(applicationOwner.profile)});
  return ${JSON.stringify(applicationOwner)};
};`);
console.log(`RC04 evidence ${scratch}`);
const workspace = join(scratch, "workspace"),
  home = join(scratch, "desktop"),
  userHome = join(scratch, "user");
await mkdir(workspace);
await mkdir(join(userHome, ".areal"), { recursive: true });
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
const checks = [],
  faults = [],
  errors = [],
  modelRequests = [],
  streams = new Map(),
  nativeFacts = { navigation: [], http: [], observations: [], calls: [], unknown: {} };
const unknownMarker = join(workspace, "unknown-once.txt");
let nativePageId,
  browserStage = 0;
function chunk(response, delta, finish_reason = null) {
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
}
function finish(response, content = "RC04_RESULT") {
  chunk(response, { content });
  chunk(response, {}, "stop");
  response.end("data: [DONE]\n\n");
}
function tool(response, name, args) {
  chunk(response, {
    tool_calls: [
      {
        index: 0,
        id: randomUUID(),
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  });
  chunk(response, {}, "tool_calls");
  response.end("data: [DONE]\n\n");
}
async function until(predicate, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timeout: ${label}`);
}
const model = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const part of request) raw += part;
    const body = JSON.parse(raw);
    if (respondToSessionName(body, response)) {
      modelRequests.push({ at: Date.now(), auxiliary: "sessionName", bytes: raw.length });
      return;
    }
    const all = JSON.stringify(body.messages),
      hasTool = body.messages.some((value) => value.role === "tool");
    modelRequests.push({
      at: Date.now(),
      browser: body.tools?.some((value) => value.function?.name === "browser_v1"),
      bytes: raw.length,
    });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (all.includes("RC04_UNKNOWN") && !hasTool) {
      tool(response, "run_command", {
        command: `printf x >> '${unknownMarker}'; sleep 60`,
        timeoutMs: 120000,
      });
      return;
    }
    if (body.tools?.some((value) => value.function?.name === "browser_v1")) {
      await until(() => nativePageId, "native page claim");
      if (browserStage++ % 3 === 0)
        tool(response, "browser_v1", { operation: "describe", parameters: {} });
      else if (browserStage % 3 === 2)
        tool(response, "browser_v1", {
          operation: "observe",
          parameters: { pageId: nativePageId },
        });
      else finish(response, "RC04_NATIVE_PAGE_OBSERVED");
      return;
    }
    const mode = all.match(/RC04_STREAM_[A-Z]+/)?.[0];
    if (mode) {
      streams.set(mode, response);
      response.on("close", () => {
        if (streams.get(mode) === response) streams.delete(mode);
      });
      chunk(response, { content: "BEGIN|" });
      return;
    }
    finish(response);
  } catch (error) {
    errors.push(`model: ${error.message}`);
    response.destroy();
  }
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const site = createServer((request, response) => {
  const requestId = randomUUID();
  const record = (event) =>
    nativeFacts.http.push({
      at: Date.now(),
      requestId,
      event,
      method: request.method,
      url: request.url,
    });
  record("request");
  request.on("aborted", () => record("aborted"));
  response.on("finish", () => record("finish"));
  response.on("close", () => record(response.writableFinished ? "closed" : "aborted-response"));
  response.setHeader("Content-Type", "text/html");
  response.end(
    '<!doctype html><title>RC04 Native</title><h1>RC04_NATIVE_SENTINEL</h1><input aria-label="Unsaved" value="RC04_UNSAVED"><script>window.nativeSentinel=crypto.randomUUID()</script>',
  );
});
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
const siteUrl = `http://127.0.0.1:${site.address().port}/`;
const modelConfig = `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`;
await writeFile(join(userHome, ".areal/config.toml"), modelConfig);
const deployment = join(scratch, "desktop.json");
await writeFile(
  deployment,
  JSON.stringify({
    profiles: [
      {
        id: "fixture",
        revision: "v1",
        displayName: "Fixture",
        instructions: "Use requested tools then report result.",
      },
    ],
  }),
);
const backendOptions = {
  applicationOwner,
  binary: process.env.AREAL_CORE_BIN || resolve(root, "target/debug/areal"),
  home,
  harnessHome: join(scratch, "registry"),
  userHome,
  desktopConfig: deployment,
  desktopProcesses: true,
};
const backend = new CoreBackend(backendOptions);
const env = {
  ...process.env,
  AREAL_CORE_BIN: backend.binary,
  AREAL_CORE_HOME: home,
  AREAL_CORE_USER_HOME: userHome,
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_CORE_DESKTOP_CONFIG: deployment,
};
for (const key of [
  "AREAL_CORE_WORKSPACE",
  "AREAL_CORE_CONFIG",
  "AREAL_HARNESS_HOME",
  "AREAL_HARNESS_CONFIG",
  "ELECTRON_RUN_AS_NODE",
])
  delete env[key];
let service,
  remote,
  app,
  desktop,
  browser,
  page,
  writer,
  project,
  projectId,
  proxy,
  passed = false,
  navigationProbeStarted = false;
const clients = [],
  remoteSockets = [],
  secureOutputs = new Map();
let dropPeer,
  dropCount = 0,
  staleEvent,
  recordedBaseline,
  unknownWatch,
  unknownEvent,
  observeThread,
  holdObserve = false,
  heldObserve;
// 诊断只记录边界元信息，不保存请求输入、快照、认证或端点。
function frameMetadata(message) {
  const value = message.result?.snapshot ? message.result : message;
  return Object.fromEntries(
    Object.entries({
      id: message.id,
      method: message.method,
      event: message.event,
      threadId: message.params?.threadId ?? value.snapshot?.threadId,
      connectionId: value.connectionId,
      gatewayGeneration: value.gatewayGeneration,
      serviceGeneration: value.serviceGeneration,
      subscriptionId: value.subscriptionId,
      projectId: value.projectId,
      sequence: value.sequence,
      errorCode: message.error?.code ?? value.error?.code,
    }).filter(([, value]) => value !== undefined),
  );
}
const diagnostic = { mode: unknownOnly ? "unknown-only" : "full", events: [], dropped: 0 },
  clientIds = new WeakMap();
let diagnosticPhase = "setup",
  nextClientId = 0;
function clientId(client) {
  if (!client) return null;
  if (!clientIds.has(client)) clientIds.set(client, `core-${++nextClientId}`);
  return clientIds.get(client);
}
function trace(event, fields = {}) {
  if (!unknownOnly) return;
  const owner = project ?? [...backend.projects.values()].find((value) => value.client);
  if (diagnostic.events.length >= 6000) {
    diagnostic.dropped++;
    return;
  }
  diagnostic.events.push({
    index: diagnostic.events.length,
    at: Date.now(),
    phase: diagnosticPhase,
    event,
    serviceGeneration: owner?.service?.generation,
    currentClientId: clientId(owner?.client),
    ...fields,
  });
}
function phase(value) {
  diagnosticPhase = value;
  trace("phase");
}
if (unknownOnly) {
  const connect = CoreClient.prototype.connect,
    close = CoreClient.prototype.close,
    request = CoreClient.prototype.request;
  CoreClient.prototype.connect = function (...args) {
    const client = this,
      id = clientId(client),
      createSocket = client.createSocket;
    const owner = [...backend.projects.values()].find((p) => p.client === client);
    const clientGeneration = owner?.service?.generation ?? project?.service?.generation;
    trace("client-created", {
      clientId: id,
      clientGeneration,
      primary: [...backend.projects.values()].some((p) => p.client === client),
    });
    client.createSocket = function (...socketArgs) {
      const socket = createSocket.apply(this, socketArgs),
        requests = new Map(),
        send = socket.send;
      trace("socket-created", { clientId: id, clientGeneration });
      socket.send = function (...sendArgs) {
        let message;
        try {
          message = JSON.parse(String(sendArgs[0]));
        } catch {}
        if (message) {
          const metadata = frameMetadata(message);
          if (message.id !== undefined && message.method) requests.set(message.id, metadata);
          trace("socket-send", {
            clientId: id,
            clientGeneration,
            bytes: Buffer.byteLength(String(sendArgs[0])),
            ...metadata,
          });
        }
        return send.apply(this, sendArgs);
      };
      socket.addEventListener("message", (event) => {
        let message;
        try {
          message = JSON.parse(String(event.data));
        } catch {}
        const request = requests.get(message?.id);
        trace("socket-message", {
          clientId: id,
          clientGeneration,
          bytes: Buffer.byteLength(event.data),
          ...request,
          ...frameMetadata(message ?? {}),
        });
        if (message?.id !== undefined && !message.method) requests.delete(message.id);
      });
      socket.addEventListener("error", (event) =>
        trace("socket-error", {
          clientId: id,
          clientGeneration,
          errorCode: event.error?.code,
          ready: client.ready,
          closed: client.closed,
        }),
      );
      socket.addEventListener("close", (event) =>
        trace("socket-close", {
          clientId: id,
          clientGeneration,
          code: event.code,
          wasClean: event.wasClean,
          ready: client.ready,
          closed: client.closed,
        }),
      );
      return socket;
    };
    const result = connect.apply(this, args);
    result.then(
      () =>
        trace("client-ready", {
          clientId: id,
          clientGeneration,
          ready: client.ready,
          closed: client.closed,
        }),
      (error) =>
        trace("client-connect-error", { clientId: id, clientGeneration, errorCode: error.code }),
    );
    return result;
  };
  CoreClient.prototype.request = function (...args) {
    const id = clientId(this);
    trace("client-request", {
      clientId: id,
      method: args[0],
      threadId: args[1]?.threadId,
      ready: this.ready,
      closed: this.closed,
    });
    const result = request.apply(this, args);
    result.then(
      () =>
        trace("client-request-settled", {
          clientId: id,
          method: args[0],
          threadId: args[1]?.threadId,
        }),
      (error) =>
        trace("client-request-error", {
          clientId: id,
          method: args[0],
          threadId: args[1]?.threadId,
          errorCode: error.code,
        }),
    );
    return result;
  };
  CoreClient.prototype.close = function (...args) {
    const caller = new Error().stack
      ?.split("\n")
      .slice(2, 5)
      .map((line) => line.trim().replace(root, "<root>"));
    trace("client-close-called", {
      clientId: clientId(this),
      ready: this.ready,
      closed: this.closed,
      caller,
    });
    return close.apply(this, args);
  };
  for (const name of ["connect", "restartProject", "reconnectProject"]) {
    const original = backend[name];
    backend[name] = function (...args) {
      const owner = args[0],
        attemptId = randomUUID();
      trace("backend-start", { method: name, attemptId, ownerClientId: clientId(owner?.client) });
      const result = original.apply(this, args);
      result.then(
        () =>
          trace("backend-settled", {
            method: name,
            attemptId,
            ownerClientId: clientId(owner?.client),
          }),
        (error) =>
          trace("backend-error", {
            method: name,
            attemptId,
            ownerClientId: clientId(owner?.client),
            errorCode: error.code,
          }),
      );
      return result;
    };
  }
  const sync = backend.analytics.syncProject;
  backend.analytics.syncProject = function (...args) {
    const attemptId = randomUUID();
    trace("analytics-start", { attemptId, ownerClientId: clientId(args[0]?.client) });
    const result = sync.apply(this, args);
    result.then(
      () => trace("analytics-settled", { attemptId, ownerClientId: clientId(args[0]?.client) }),
      (error) => trace("analytics-error", { attemptId, errorCode: error.code }),
    );
    return result;
  };
}
// 故障只延迟/丢弃真实边界消息；认证、授权及 Core 结果保持原样。
async function observerProxy(endpoint) {
  const server = new WebSocket.WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const links = new Set();
  let holdNext = false,
    held,
    captured;
  server.on("connection", (down, request) => {
    const up = new WebSocket(endpoint, {
      headers: { Authorization: request.headers.authorization },
      maxPayload: 64 * 1024 * 1024,
    });
    const link = { up, down, requests: new Map(), buffer: [] };
    links.add(link);
    down.pause();
    up.on("open", () => down.resume());
    down.on("message", (data) => {
      const message = JSON.parse(data);
      if (message.id) link.requests.set(message.id, message.method);
      up.send(data.toString());
    });
    up.on("message", (data) => {
      const message = JSON.parse(data);
      if (holdNext && link.requests.get(message.id) === "areal/thread/observe") {
        holdNext = false;
        held = link;
        captured?.();
      }
      if (held === link) link.buffer.push(data);
      else if (down.readyState === 1) down.send(data.toString());
    });
    for (const socket of [up, down]) socket.on("error", () => {});
    down.on("close", () => {
      up.terminate();
      links.delete(link);
    });
    up.on("close", () => down.close());
  });
  return {
    endpoint: `ws://127.0.0.1:${server.address().port}`,
    hold() {
      holdNext = true;
      return new Promise((resolve) => {
        captured = resolve;
      });
    },
    release() {
      const link = held;
      held = null;
      for (const data of link?.buffer.splice(0) ?? [])
        if (link.down.readyState === 1) link.down.send(data.toString());
    },
    close() {
      for (const link of links) {
        link.up.terminate();
        link.down.terminate();
      }
      server.close();
    },
  };
}
async function connectWriter() {
  const client = new CoreClient({
    createSocket: () =>
      new WebSocket(project.service.endpoint, {
        headers: { Authorization: `Bearer ${project.token}` },
        maxPayload: 64 * 1024 * 1024,
      }),
  });
  await client.connect();
  clients.push(client);
  return client;
}
async function createThread(text) {
  const { thread } = await writer.request("areal/thread/start", { requestId: randomUUID() });
  if (text) await startTurn(thread.id, text);
  return thread.id;
}
async function startTurn(threadId, text) {
  return writer.request("areal/turn/start", {
    requestId: randomUUID(),
    threadId,
    expectedConfigRevision: 1,
    input: [{ type: "text", text }],
  });
}
async function readThread(threadId) {
  return (await writer.request("thread/read", { threadId, includeTurns: true })).thread;
}
async function settled(threadId) {
  return until(
    async () => {
      const value = await readThread(threadId);
      return value.status.type === "idle" ? value : null;
    },
    `Thread settled ${threadId}`,
    60000,
  );
}
async function desktopCommand(name, params) {
  const reply = await desktop.evaluate(
    ({ name, params }) => window.arealDesktop.command(name, params),
    { name, params },
  );
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.value;
}
async function pairBrowser() {
  const invite = await remote.control({ operation: "pair" });
  const target = await browser.newPage();
  await target.addInitScript(() => localStorage.setItem(
    "areal-gui:application-preferences", JSON.stringify({ nextPromptSuggestions: false }),
  ));
  target.setDefaultTimeout(15000);
  target.on("pageerror", (error) => errors.push(error.message));
  await target.goto(invite.payload);
  await target.getByRole("button", { name: "连接电脑" }).click();
  await target
    .getByRole("status")
    .getByText(/等待桌面确认/)
    .waitFor();
  const pending = await until(() => remote.state().pending[0], "pending real Noise identity");
  await desktop.getByRole("button", { name: "设置", exact: true }).click();
  await desktop.getByRole("button", { name: "手机连接", exact: true }).click();
  const approval = desktop.getByRole("group", { name: `确认设备 ${pending.id}` });
  await approval.getByLabel("workspace", { exact: true }).check();
  await approval.getByRole("radio", { name: "仅查看", exact: true }).check();
  await approval.getByRole("button", { name: "确认配对", exact: true }).click();
  await target
    .getByRole("status")
    .getByText(/已连接/)
    .waitFor();
  return { page: target, peer: pending.id };
}
async function chooseDetail(target, threadId) {
  if (await target.getByRole("button", {name:"返回项目列表",exact:true}).isVisible())
    await target.getByRole("button", {name:"返回项目列表",exact:true}).click();
  const projectButton=target.getByRole("button",{name:"workspace",exact:true});
  if(await projectButton.getAttribute("aria-expanded")==="true")await projectButton.click();
  await projectButton.click();
  // Bind the real public row to Core identity; overview titles may use first-input previews.
  const row=target.locator(`.remote-session-row[data-thread-id="${threadId}"]`);
  await until(async()=>{
    if(await row.isVisible())return true;
    const more=target.getByRole("button",{name:/^(Show more|加载更多)$/});
    if(await more.first().isVisible())await more.first().click();
    return false;
  },"original Thread visible after project refresh");
  await row.click();
}
async function openDetail(target, threadId) {
  await chooseDetail(target, threadId);
  await until(async()=>await target.locator('.remote-chat-heading').getAttribute('data-thread-id')===threadId && !(await target.locator('#session-error').textContent()),'Remote baseline');
}
async function detailState(target) {return target.locator('.remote-chat-heading').evaluate(el=>el.dataset);}
// Electron evaluate 不提供 Node require；文件写入留在父进程，丢失诊断必须显式标记。
async function drainNativeDiagnostics(phase) {
  if (!app || !navigationProbeStarted) return;
  try {
    const batch = await app.evaluate(drainNavigationProbe);
    const { events, ...status } = batch;
    (nativeFacts.navigationEvents ??= []).push(...events);
    (nativeFacts.navigationDrains ??= []).push({ phase, at: Date.now(), ...status });
    if (!batch.complete) nativeFacts.navigationIncomplete = true;
    await appendFile(
      join(scratch, "native-navigation.jsonl"),
      [...events, { event: "diagnostics-drain", phase, at: Date.now(), ...status }]
        .map((value) => JSON.stringify(value) + "\n")
        .join(""),
    );
  } catch (error) {
    nativeFacts.navigationIncomplete = true;
    (nativeFacts.navigationDrainErrors ??= []).push({
      phase,
      at: Date.now(),
      error: error.stack ?? String(error),
    });
  }
}
async function createOversizeFixture() {
  phase("oversize-history");
  const largeId = await createThread();
  const oversizeFixture = (nativeFacts.oversizeFixture = {
    threadId: largeId,
    bulkMethod: "turn/start",
    turnIds: [],
    primaryLimitBytes: 4 * 1024 * 1024,
    rpcEnvelopeHeadroomBytes: 1024,
  });
  for (let n = 0; n < 6; n++) {
    // 大历史构造不额外保存整段输入的提交回执，避免把 Desktop 列表限额混入 observer 历史限额。
    const reply = await writer.request("turn/start", {
      threadId: largeId,
      input: [{ type: "text", text: `RC04_BIG_${n}_` + "x".repeat(800000) }],
    });
    oversizeFixture.turnIds.push(reply.turn?.id);
    assert.ok(
      typeof reply.turn?.id === "string" && reply.turn.id.length,
      "real bulk Turn identity",
    );
    await settled(largeId);
  }
  const largeNative = await readThread(largeId);
  const historyJson = JSON.stringify(largeNative);
  const receipts = largeNative.desktop?.receipts ?? [];
  Object.assign(oversizeFixture, {
    historyBytes: Buffer.byteLength(historyJson),
    historySha256: createHash("sha256").update(historyJson).digest("hex"),
    receiptCount: receipts.length,
    receiptCountsByMethod: receipts.reduce((counts, receipt) => {
      counts[receipt.method] = (counts[receipt.method] ?? 0) + 1;
      return counts;
    }, {}),
  });
  assert.ok(
    oversizeFixture.historyBytes > oversizeFixture.primaryLimitBytes,
    "real native history exceeds observer cap",
  );
  assert.equal(
    oversizeFixture.receiptCountsByMethod["areal/turn/start"] ?? 0,
    0,
    "bulk setup has no durable start receipts",
  );
  assert.equal(new Set(oversizeFixture.turnIds).size, 6);
  assert.ok(
    oversizeFixture.turnIds.every((id) => largeNative.turns.some((turn) => turn.id === id)),
  );
  const list = await writer.request("thread/list", { limit: 100 });
  const listJson = JSON.stringify(list);
  Object.assign(oversizeFixture, {
    listMeasuredAt: Date.now(),
    listBytes: Buffer.byteLength(listJson),
    listSha256: createHash("sha256").update(listJson).digest("hex"),
    listedThreadIds: list.data.map((thread) => thread.id),
    nextCursor: list.nextCursor,
  });
  assert.equal(list.nextCursor, null, "fixture list measurement includes all Threads");
  assert.ok(
    oversizeFixture.listedThreadIds.includes(largeId),
    "large history Thread remains in the measured list",
  );
  assert.ok(
    oversizeFixture.listBytes + oversizeFixture.rpcEnvelopeHeadroomBytes <
      oversizeFixture.primaryLimitBytes,
    "actual complete thread/list fits original Desktop receive cap with RPC envelope headroom",
  );
  assert.equal(project.model.state.threads[largeId], undefined);
  return largeId;
}
try {
  await backend.init();
  projectId = await backend.addProject(workspace);
  project = await backend.start(projectId);
  writer = await connectWriter();
  assert.equal(
    writer.capabilities.features.atomicObserveOwnership,
    true,
    "Core declares atomic ownership",
  );
  const baselineId = await createThread("RC04_BASELINE");
  await settled(baselineId);
  service = new DesktopService(backend, await serviceIdentity(backendOptions));
  // 只扣住真实 observe 回执的交付，原生调用和原有校验保持原样。
  const realSend = service.send.bind(service),
    realReceive = service.receive.bind(service);
  service.send = (socket, message) => {
    if (
      message.method === "browserRequest" &&
      message.params?.threadId === observeThread &&
      message.params.operation === "observe"
    )
      nativeFacts.observations.push({ at: Date.now(), request: structuredClone(message.params) });
    return realSend(socket, message);
  };
  service.receive = (socket, bytes) => {
    let message;
    try {
      message = JSON.parse(bytes.toString());
    } catch {
      return realReceive(socket, bytes);
    }
    const observation =
      message.method === "browserResult" &&
      nativeFacts.observations.find(
        (value) => value.request.requestId === message.params?.requestId,
      );
    if (observation) {
      observation.receivedAt = Date.now();
      observation.response = structuredClone(message.params);
      observation.originalBytesSha256 = createHash("sha256").update(bytes).digest("hex");
      if (holdObserve && !heldObserve && observation.request.phase === "execute") {
        holdObserve = false;
        heldObserve = { socket, bytes, observation };
        return;
      }
    }
    return realReceive(socket, bytes);
  };
  const encryptionFixture = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "fixture",
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString("utf8"),
  };
  remote = service.remote = new RemoteControl(service, encryptionFixture);
  await remote.init();
  await remote.control({ operation: "enableDirect" });
  const realCrypto = remote.crypto;
  remote.crypto = {
    ...realCrypto,
    async secureChannel(...args) {
      const secure = await realCrypto.secureChannel(...args),
        send = secure.send.bind(secure);
      secureOutputs.set(secure.peer, { send, secure });
      const messages = secure.messages.bind(secure);
      secure.messages = async function* () {
        for await (const message of messages()) {
          trace("host-incoming", frameMetadata(message));
          if (
            heldObserve &&
            secure.peer === nativeFacts.closeOverlap?.peer &&
            message.method === "subscription.close"
          )
            nativeFacts.closeOverlap.closeRequest = structuredClone(message);
          yield message;
        }
      };
      secure.send = (message) => {
        trace("host-outgoing", { origin: "natural", ...frameMetadata(message) });
        if (
          secure.peer === nativeFacts.closeOverlap?.peer &&
          nativeFacts.closeOverlap?.closeRequest?.id === message.id &&
          message.id !== undefined
        )
          nativeFacts.closeOverlap.closeResponse = structuredClone(message);
        if (message.result?.snapshot) {
          recordedBaseline = structuredClone(message.result);
          secureOutputs.get(secure.peer).baseline = structuredClone(message.result);
        }
        if (message.event === "session.updated") {
          staleEvent = structuredClone(message);
          if (
            secure.peer === unknownWatch?.peer &&
            message.snapshot?.threadId === unknownWatch.threadId
          )
            unknownEvent = structuredClone(message);
          if (dropPeer === secure.peer && dropCount > 0) {
            dropCount--;
            faults.push({ type: "drop-real-session-update", sequence: message.sequence });
            return;
          }
        }
        send(message);
      };
      return secure;
    },
  };
  const descriptor = await service.listen();
  await writeFile(join(home, "service.json"), JSON.stringify(descriptor), { mode: 0o600 });
  app = await electron.launch({
    executablePath: process.env.AREAL_ELECTRON_EXECUTABLE || require("electron"),
    args: [application.path],
    env,
    timeout: 60000,
  });
  desktop = await app.firstWindow();
  await desktop.getByTestId("areal-workbench").waitFor({ timeout: 60000 });
  await desktop.evaluate(() => localStorage.setItem(
    "areal-gui:application-preferences", JSON.stringify({ nextPromptSuggestions: false }),
  ));
  await desktop.reload();
  desktop.setDefaultTimeout(15000);
  await desktop.getByTestId("areal-workbench").waitFor({ timeout: 60000 });
  let desktopConnection;
  try {
    await until(async () => {
      desktopConnection = (await desktop.evaluate(() => window.arealDesktop.snapshot())).connection;
      return desktopConnection?.state === "ready";
    }, "production Desktop ready");
  } catch (error) {
    throw new Error(`Desktop startup not ready: ${JSON.stringify(desktopConnection ?? null)}`, {
      cause: error,
    });
  }
  checks.push("production Desktop snapshot connection ready before pairing");
  browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  const paired = await pairBrowser();
  page = paired.page;
  const initialDesktopClient = project.client;
  if (!unknownOnly) {
    proxy = await observerProxy(project.endpoint);
    project.endpoint = proxy.endpoint;
    await openDetail(page, baselineId);
    assert.match(await page.locator("#remote-session-ui .messages").textContent(), /RC04_RESULT/);
    assert.equal((await detailState(page)).configRevision,"1");
    assert.equal((await detailState(page)).ownership,"ordinary");
    const native = await readThread(baselineId);
    const nativeItemIds = native.turns.flatMap((turn) =>
      turn.items.filter((item) => item.type === "userMessage" || item.type === "agentMessage" && item.text?.trim()).map((item) => item.id),
    );
    assert.deepEqual(
      await page
        .locator("[data-side-item-id]")
        .evaluateAll((values) => values.map((value) => value.dataset.sideItemId)),
      nativeItemIds,
    );
    assert.equal(
      project.model.state.threads[baselineId],
      undefined,
      "Remote did not open desktop projection",
    );
    checks.push(
      "real Noise and production Desktop local approval; production Remote detail matches Core Thread/Turn/Item IDs and configRevision",
    );
    await writer.request("areal/thread/configure", {
      threadId: baselineId,
      expectedRevision: 1,
      options: { appendInstructions: "RC04 config revision" },
    });
    await until(
      async () => (await detailState(page)).configRevision==="2",
      "native configuration revision event",
    );
    checks.push(
      "native configuration revision changes propagate and trigger atomic ownership refresh",
    );
    const streamId = await createThread("RC04_STREAM_BOUNDARY");
    await until(() => streams.has("RC04_STREAM_BOUNDARY"), "live model stream");
    const captured = proxy.hold();
    await chooseDetail(page, streamId);
    await captured;
    chunk(streams.get("RC04_STREAM_BOUNDARY"), { content: "DURING_BASELINE|" });
    finish(streams.get("RC04_STREAM_BOUNDARY"), "END");
    await settled(streamId);
    proxy.release();
    await until(
      async () =>
        (await page.locator("#remote-session-ui .messages").textContent()).includes(
          "BEGIN|DURING_BASELINE|END",
        ),
      "batched atomic baseline + deltas",
    );
    assert.equal(await page.locator("[data-side-item-id]").count(), 2);
    checks.push(
      "T13: exact real Core observe response held while stream changes, then released with deltas; no missing/duplicate final text in production UI",
    );
    await page.screenshot({ path: join(scratch, "session-boundary.png"), fullPage: true });
    const gapId = await createThread("RC04_STREAM_GAP");
    await until(() => streams.has("RC04_STREAM_GAP"), "gap stream");
    await openDetail(page, gapId);
    await writer.request("areal/turn/enqueue", {
      requestId: randomUUID(),
      threadId: gapId,
      expectedConfigRevision: 1,
      input: [{ type: "text", text: "RC04_QUEUED" }],
    });
    const queue = await writer.request("areal/queue/list", { threadId: gapId });
    await writer.request("areal/queue/pause", {
      requestId: randomUUID(),
      threadId: gapId,
      expectedRevision: queue.revision,
    });
    await until(
      async () => (await detailState(page)).queueCount==="1" && (await detailState(page)).queuePaused==="true",
      "native queue count and pause projected",
    );
    const beforeGap = recordedBaseline.subscriptionId;
    dropPeer = paired.peer;
    dropCount = 1;
    chunk(streams.get("RC04_STREAM_GAP"), { content: "DROPPED|" });
    await until(() => dropCount === 0, "one real event dropped");
    chunk(streams.get("RC04_STREAM_GAP"), { content: "AFTER_GAP|" });
    await until(
      () => recordedBaseline.subscriptionId !== beforeGap,
      "sequence gap replaces baseline",
    );
    finish(streams.get("RC04_STREAM_GAP"), "DONE");
    await until(
      async () =>
        (await page.locator("#remote-session-ui .messages").textContent()).includes(
          "BEGIN|DROPPED|AFTER_GAP|DONE",
        ),
      "gap repair exact content",
    );
    const oldEvent = structuredClone(staleEvent),
      oldConnection = recordedBaseline.connectionId;
    [...remote.direct.sockets].find((value) => value.remotePeer === paired.peer).terminate();
    await page
      .getByRole("status")
      .getByText(/已断开/)
      .waitFor();
    assert.equal(await page.locator("[data-side-item-id]").count(), 0);
    await page.getByRole("button", { name: "连接电脑" }).click();
    await until(() => recordedBaseline.connectionId !== oldConnection, "fresh connection baseline");
    secureOutputs.get(paired.peer).send(oldEvent);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.match(
      await page.locator("#remote-session-ui .messages").textContent(),
      /BEGIN\|DROPPED\|AFTER_GAP\|DONE/,
    );
    assert.equal(recordedBaseline.snapshot.threadId, gapId);
    faults.push({
      type: "late-real-old-connection-message",
      oldConnection,
      currentConnection: recordedBaseline.connectionId,
    });
    checks.push(
      "T14/T15: one real output dropped -> sequence resync replaces baseline; disconnect clears text; reconnect rejects delayed old-connection event",
    );
    const peerTwo = await pairBrowser();
    await openDetail(peerTwo.page, gapId);
    await page.getByRole("button", { name: "返回项目列表", exact: true }).click();
    const queueAfter = await writer.request("areal/queue/list", { threadId: gapId });
    await writer.request("areal/queue/remove", {
      requestId: randomUUID(),
      threadId: gapId,
      expectedRevision: queueAfter.revision,
      queueItemId: queueAfter.items.find((value) => value.status === "pending").id,
    });
    await startTurn(gapId, "RC04_STREAM_GAP");
    await until(() => streams.has("RC04_STREAM_GAP"), "second viewer stream");
    finish(streams.get("RC04_STREAM_GAP"), "OTHER_VIEWER_REMAINS");
    await until(
      async () =>
        (await peerTwo.page.locator("#remote-session-ui .messages").textContent()).includes(
          "OTHER_VIEWER_REMAINS",
        ),
      "other viewer ref stays alive",
    );
    checks.push(
      "same Thread across devices shares observation; closing one detail releases only its reference",
    );
    const ownershipId = await createThread("RC04_STREAM_OWNERSHIP");
    await until(() => streams.has("RC04_STREAM_OWNERSHIP"), "ordinary busy Thread");
    await openDetail(page, ownershipId);
    await openDetail(peerTwo.page, ownershipId);
    const task = await writer.request("areal/task/create", {
      requestId: randomUUID(),
      mode: "background",
      threadId: ownershipId,
      objective: "RC04 ownership queued",
    });
    const queuedTask = await until(async () => {
      const value = await writer.request("areal/task/read", { taskId: task.id });
      return value.runs.some((run) => run.status === "queued") ? value : null;
    }, "queued TaskRun behind ordinary active Turn");
    await openDetail(page, (await detailState(page)).threadId);
    await until(
      async () => (await detailState(page)).taskId===task.id,
      "live Core ownership replaces shared baseline",
    );
    await until(
      async () =>
        (await detailState(peerTwo.page)).taskId===task.id,
      "other viewer receives rebaseline ownership",
    );
    await writer.request("areal/task/cancel", {
      requestId: randomUUID(),
      taskId: task.id,
      expectedRevision: queuedTask.revision,
    });
    await until(async () => {
      const value = await writer.request("areal/task/read", { taskId: task.id });
      return value.runs.every(
        (run) =>
          ["completed", "failed", "cancelled"].includes(run.status) &&
          run.workers.every((worker) => worker.settled),
      );
    }, "cancelled queued Run settled");
    await openDetail(page, (await detailState(page)).threadId);
    await until(
      async () => (await detailState(page)).ownership==="ordinary",
      "cancelled queued task releases ordinary Thread rights",
    );
    finish(streams.get("RC04_STREAM_OWNERSHIP"), "OWNERSHIP_DONE");
    await settled(ownershipId);
    checks.push(
      "Core atomic ownership provenance: Task-only queued Run and cancellation visible on explicit shared-viewer rebaseline, no Gateway Task scan",
    );
    await peerTwo.page.close();
    const slowId = await createThread("RC04_STREAM_SLOW");
    await until(() => streams.has("RC04_STREAM_SLOW"), "slow-consumer stream");
    await openDetail(page, slowId);
    await desktop.getByRole("button", { name: "设置", exact: true }).click();
    await desktop.getByRole("button", { name: "手机连接", exact: true }).click();
    const slowIdentity = await createIdentity(),
      slowPeer = identityId(slowIdentity);
    const slowInvite = new URL((await remote.control({ operation: "pair" })).payload);
    const slowSocket = new WebSocket(remote.direct.ws, { origin: remote.direct.origin });
    remoteSockets.push(slowSocket);
    await once(slowSocket, "open");
    const slowWire = byteChannel(
      (bytes) => slowSocket.send(bytes),
      () => slowSocket.close(),
    );
    slowSocket.on("message", (bytes) => slowWire.receive(bytes));
    slowSocket.on("close", () => slowWire.close());
    const slowSecure = await secureChannel(
      slowWire,
      slowIdentity,
      identityId(remote.config.identity),
    );
    const slowMessages = slowSecure.messages();
    slowSecure.send({
      method: "hello",
      apiVersion: "areal.remote.v2",
      clientVersion: "rc04",
      displayName: "Slow consumer",
      inviteSecret: new URLSearchParams(slowInvite.hash.slice(1)).get("invite"),
    });
    assert.equal((await slowMessages.next()).value.event, "pairing");
    const slowApproval = desktop.getByRole("group", { name: `确认设备 ${slowPeer}` });
    await slowApproval.getByLabel("workspace", { exact: true }).check();
    await slowApproval.getByRole("radio", { name: "仅查看", exact: true }).check();
    await slowApproval.getByRole("button", { name: "确认配对", exact: true }).click();
    assert.equal((await slowMessages.next()).value.event, "ready");
    slowSecure.send({
      id: "slow-open",
      method: "session.open",
      context: { projectId },
      params: { threadId: slowId },
    });
    assert.equal((await slowMessages.next()).value.id, "slow-open");
    const slowHostSocket = [...remote.direct.sockets].find(
      (value) => value.remotePeer === slowPeer,
    );
    chunk(streams.get("RC04_STREAM_SLOW"), { content: "界".repeat(340) });
    await until(
      async () =>
        (await page.locator(".assistant-message .conversation-markdown").last().textContent()) ===
        "BEGIN|" + "界".repeat(340),
      "complete live Unicode body",
    );
    slowSocket._socket.pause();
    let sent = 0,
      maximumBuffered = 0,
      maximumCombinedQueued = 0;
    for (; sent < 18000 && slowHostSocket.readyState === 1; sent++) {
      chunk(streams.get("RC04_STREAM_SLOW"), { content: "x" });
      maximumBuffered = Math.max(maximumBuffered, slowHostSocket.bufferedAmount);
      const plaintextQueued = secureOutputs.get(slowPeer).secure.bufferedBytes;
      maximumCombinedQueued = Math.max(
        maximumCombinedQueued,
        slowHostSocket.bufferedAmount + plaintextQueued,
      );
      assert.ok(slowHostSocket.bufferedAmount <= 1024 * 1024);
      assert.ok(plaintextQueued <= 1024 * 1024);
      assert.ok(maximumCombinedQueued <= 2 * 1024 * 1024);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.notEqual(
      slowHostSocket.readyState,
      1,
      `paused TCP consumer isolated after ${sent} updates, buffered ${maximumBuffered}`,
    );
    finish(streams.get("RC04_STREAM_SLOW"), "SLOW_DONE");
    await settled(slowId);
    await until(
      async () => (await detailState(page)).status==="idle",
      "normal device still observes completion",
    );
    assert.equal(await page.locator("#session-error").textContent(), "");
    assert.equal(project.client.ready, true);
    const originalSlowText=(await readThread(slowId)).turns.at(-1).items.findLast(item=>item.type==="agentMessage").text;
    assert.equal(originalSlowText,"BEGIN|" + "界".repeat(340) + "x".repeat(sent) + "SLOW_DONE");
    await until(async()=>await page.locator(".assistant-message .conversation-markdown").last().textContent()===originalSlowText,"full body preserves every original Unicode character and later delta");
    slowSocket._socket.resume();
    slowSocket.terminate();
    faults.push({
      type: "actual-TCP-reader-pause",
      sentUpdates: sent,
      maximumBuffered,
      maximumCombinedQueued,
      plaintextLimit: 1024 * 1024,
      transportLimit: 1024 * 1024,
      limit: 2 * 1024 * 1024,
      isolated: true,
    });
    checks.push(
      "T15: actual paused TCP consumer reaches bounded send backpressure and is isolated; second production browser and Desktop/Core continue",
    );
    const historyId = await createThread();
    for (let n = 0; n < 55; n++) {
      await startTurn(historyId, `RC04_HISTORY_${n}_` + (n === 0 ? "界".repeat(1000) : ""));
      await settled(historyId);
    }
    await openDetail(page, historyId);
    assert.equal(await page.locator("[data-side-item-id]").count(), 100);
    await page.getByRole("button", { name: "更早历史", exact: true }).click();
    await until(
      async () =>
        (await page.locator("#remote-session-ui .messages").textContent()).includes("RC04_HISTORY_0_"),
      "earlier native history",
    );
    assert.equal(await page.locator("[data-side-item-id]").count(), 10);
    await until(async()=>await page.locator(".user-message .user-bubble").first().textContent()==="RC04_HISTORY_0_" + "界".repeat(1000),"complete earlier original body");
    const preview = await page.locator(".user-message .user-bubble").first().textContent();
    assert.equal(preview.includes("\uFFFD"), false);
    checks.push(
      "55 real turns: bounded 100-item window + earlier 10-item page; complete original Unicode body loaded through bounded session.body pages",
    );
    await page.screenshot({ path: join(scratch, "session-history.png"), fullPage: true });
    // 只通过既有桌面接口建立 Native Browser；不修改其实现或伪造工具响应。
    const browserThread = await desktopCommand("create", {
      projectId,
      profile: { id: "fixture", revision: "v1" },
    });
    // 配对审批仍停留在设置页，先通过返回按钮恢复会话侧栏。
    await desktop.getByRole("button", { name: "返回应用", exact: true }).click();
    await desktop
      .getByTestId("areal-workbench")
      .and(desktop.locator('[data-view="workspace"]'))
      .waitFor();
    await selectConversation(desktop, browserThread.threadId);
    await app.evaluate(({ dialog, BrowserWindow, app }, origin) => {
      const original = dialog.showMessageBox;
      dialog.showMessageBox = async (...args) => {
        const options = args.at(-1);
        if (
          options?.title === "允许本地开发站点" &&
          options.message === `允许此浏览工作区访问 ${origin}？`
        )
          return { response: 1, checkboxChecked: false };
        return original(...args);
      };
      app.focus({ steal: true });
      BrowserWindow.getAllWindows()[0].focus();
    }, new URL(siteUrl).origin);
    const existingContents = await app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().map((value) => value.id),
    );
    // 仅追加诊断监听器；loadURL 原始参数、返回 Promise 和安全监听器均不改变。
    navigationProbeStarted = true;
    await app.evaluate(installNavigationProbe, { url: siteUrl });
    await desktop.keyboard.press("Meta+t");
    await desktop.locator(".preview-panel").waitFor();
    const previewState = () =>
      desktop.evaluate(
        ({ projectId, threadId }) =>
          window.arealDesktop.preview({ operation: "state", projectId, threadId }),
        { projectId, threadId: browserThread.threadId },
      );
    const stateBeforeLoad = await until(async () => {
      const state = await previewState();
      return state.browser?.pageId ? state : null;
    }, "public native page identity before navigation");
    nativePageId = stateBeforeLoad.browser.pageId;
    const nativeContentsId = await app.evaluate(({ webContents }, existing) => {
      const created = webContents
        .getAllWebContents()
        .filter((value) => !existing.includes(value.id));
      if (created.length !== 1)
        throw new Error(`Expected exactly one new native WebContents, got ${created.length}`);
      globalThis.rc04InstallLoadProbe(created[0]);
      return created[0].id;
    }, existingContents);
    nativeFacts.targetWebContentsId = nativeContentsId;
    nativeFacts.navigation.push({
      event: "before-initial-load",
      at: Date.now(),
      state: stateBeforeLoad,
    });
    await app.evaluate((_electron, state) => {
      globalThis.rc04PublicState = state;
    }, stateBeforeLoad);
    await desktop.evaluate(
      ({ projectId, threadId, url }) =>
        window.arealDesktop.preview({ operation: "navigate", projectId, threadId, url }),
      { projectId, threadId: browserThread.threadId, url: siteUrl },
    );
    const nativePage = async () =>
      app.evaluate(
        async ({ webContents }, { url, id }) => {
          const target = webContents.fromId(id);
          if (!target || target.isDestroyed()) return null;
          const facts = { id: target.id, url: target.getURL(), loading: target.isLoading() };
          if (facts.url !== url || facts.loading) return facts;
          return {
            ...facts,
            ...(await target.executeJavaScript(
              `({readyState:document.readyState,sentinel:window.nativeSentinel,unsaved:document.querySelector('[aria-label="Unsaved"]')?.value})`,
            )),
          };
        },
        { url: siteUrl, id: nativeContentsId },
      );
    const expectedPage = {
      pageId: nativePageId,
      url: siteUrl,
      nativeWebContentsId: nativeContentsId,
    };
    const readyPage = () =>
      until(async () => {
        const state = await previewState(),
          native = await nativePage();
        nativeFacts.navigation.push({ event: "readiness", at: Date.now(), state, native });
        if (state.error) throw new Error(`Native navigation: ${state.error}`);
        return nativeReady(state, native, expectedPage) ? native : null;
      }, "exact error-free native page document");
    let loaded;
    try {
      loaded = await readyPage();
      nativeFacts.initialNavigation = "passed";
    } catch (error) {
      nativeFacts.initialNavigation = "failed";
      nativeFacts.firstNavigationError = error.stack;
      const failedState = await previewState();
      nativeFacts.navigation.push({
        event: "first-navigation-failed",
        at: Date.now(),
        state: failedState,
      });
      await drainNativeDiagnostics("first-navigation-failed");
      await desktop.screenshot({ path: join(scratch, "native-first-navigation-failed.png") });
      if (!/\(-3\)/.test(failedState.error ?? "")) throw error;
      nativeFacts.navigation.push({
        event: "explicit-visible-retry",
        at: Date.now(),
        state: failedState,
      });
      await app.evaluate((_electron, state) => {
        globalThis.rc04PublicState = state;
      }, failedState);
      await desktop.getByRole("button", { name: "重试", exact: true }).click();
      await until(
        async () => !(await previewState()).error,
        "visible retry clears prior navigation error",
      );
      loaded = await readyPage();
      nativeFacts.initialNavigation = "failed-then-recovered-once";
    }
    await drainNativeDiagnostics("navigation-ready");
    assert.equal(loaded.id, nativeContentsId);
    const editedInput = `RC04_EDITED_${randomUUID()}`;
    nativeFacts.inputEdit = await app.evaluate(
      async ({ webContents }, { id, value }) => {
        const target = webContents.fromId(id);
        return target.executeJavaScript(
          `(() => { const input=document.querySelector('[aria-label="Unsaved"]'); const before=input.value; input.value=${JSON.stringify(value)}; input.dispatchEvent(new Event('input',{bubbles:true})); return {before,after:input.value}; })()`,
        );
      },
      { id: nativeContentsId, value: editedInput },
    );
    assert.equal(nativeFacts.inputEdit.before, "RC04_UNSAVED");
    assert.equal(nativeFacts.inputEdit.after, editedInput);
    const beforeNative = (nativeFacts.beforeNative = await nativePage());
    assert.equal(beforeNative.unsaved, editedInput);
    // Current GUI attaches the fixed Browser bundle on ordinary Thread creation.
    await until(
      () =>
        project.model.state.threads[browserThread.threadId]?.dynamicTools?.some(
          (tool) => tool.name === "browser_v1",
        ),
      "Core native tool attachment",
    );
    await openDetail(page, browserThread.threadId);
    nativeFacts.browserBaseline = structuredClone(secureOutputs.get(paired.peer).baseline);
    observeThread = browserThread.threadId;
    holdObserve = true;
    const offNative = project.client.onNotification((method, params) => {
      if (
        params.threadId === observeThread &&
        params.item?.type === "dynamicToolCall" &&
        params.item.tool === "browser_v1"
      )
        nativeFacts.calls.push({
          method,
          at: Date.now(),
          turnId: params.turnId,
          item: structuredClone(params.item),
        });
    });
    await desktopCommand("send", {projectId,threadId:browserThread.threadId,text:"Observe the current native page"});
    // Each approval binds a distinct native call. Wait for the prepared observe
    // card so a second click cannot target the previous describe request.
    await desktop.getByRole("button",{name:"允许一次",exact:true}).click();
    await desktop.getByText("操作：observe",{exact:true}).waitFor();
    await desktop.getByRole("button",{name:"允许一次",exact:true}).click();
    const claim = await until(async () => {
      const state = await previewState();
      return state.browser?.control === "agent" ? state : null;
    }, "native browser claim");
    assert.equal(claim.browser.pageId, nativePageId);
    const claimEntry = [...service.browserClaims.entries()].find(([, value]) =>
      value.pages.has(nativePageId),
    );
    assert.ok(claimEntry, "exact page has a Desktop claim");
    const [claimKey, originalClaim] = claimEntry,
      originalPageClaim = originalClaim.pages.get(nativePageId),
      desktopClient = project.client;
    const assertRetention = async () => {
      assert.equal(project.client, desktopClient);
      assert.equal(desktopClient.ready, true);
      assert.equal(service.browserClaims.get(claimKey), originalClaim);
      assert.equal(originalClaim.pages.get(nativePageId), originalPageClaim);
      const current = await nativePage(),
        state = await previewState();
      nativeFacts.retention = {
        at: Date.now(),
        native: current,
        state,
        pageClaim: structuredClone(originalPageClaim),
      };
      assert.ok(nativeReady(state, current, expectedPage));
      assert.equal(state.browser.control, "agent");
      assert.deepEqual(current, beforeNative);
    };
    await until(() => heldObserve, "actual matching native observe response held", 10000);
    const firstObservation = heldObserve.observation;
    const pending = service.browserPending.get(firstObservation.request.requestId);
    nativeFacts.closeOverlap = {
      heldAt: Date.now(),
      peer: paired.peer,
      request: firstObservation.request,
      pending: Boolean(pending),
      pageClaim: structuredClone(originalPageClaim),
    };
    assert.ok(pending && pending.socket === heldObserve.socket);
    await page.getByRole("button", { name: "返回项目列表", exact: true }).click();
    await page.locator("#session").waitFor({ state: "hidden" });
    await until(
      () => nativeFacts.closeOverlap.closeResponse,
      "actual Remote subscription close response",
      5000,
    );
    assert.equal(
      nativeFacts.closeOverlap.closeRequest.params.subscriptionId,
      nativeFacts.browserBaseline.subscriptionId,
    );
    assert.equal(nativeFacts.closeOverlap.closeResponse.result?.closed, true);
    nativeFacts.closeOverlap.closedAt = Date.now();
    assert.equal(service.browserPending.get(firstObservation.request.requestId), pending);
    await assertRetention();
    firstObservation.releasedAt = Date.now();
    firstObservation.releasedBytesSha256 = createHash("sha256")
      .update(heldObserve.bytes)
      .digest("hex");
    assert.equal(firstObservation.releasedBytesSha256, firstObservation.originalBytesSha256);
    await realReceive(heldObserve.socket, heldObserve.bytes);
    heldObserve = null;
    const waitObserve = async (observation) => {
      const thread = await until(
        async () => {
          const value = await readThread(browserThread.threadId);
          observation.coreThread = value;
          return value.turns.some(
            (turn) => turn.id === observation.request.turnId && turn.status === "completed",
          )
            ? value
            : null;
        },
        "exact Core observe Turn completed",
        60000,
      );
      observation.coreThread = thread;
      assertObserve(observation, thread, {
        ...expectedPage,
        threadId: browserThread.threadId,
        turnId: observation.request.turnId,
      });
      await assertRetention();
      return thread;
    };
    await waitObserve(firstObservation);
    await drainNativeDiagnostics("first-observe-completed");
    checks.push(
      "T17: Remote detail closes while actual native observe response is pending delivery; original unchanged response completes exact Core call on retained page, edited input and ToolHost claim",
    );
    await desktop.screenshot({ path: join(scratch, "desktop-native-after-close.png") });
    const primarySocket = desktopClient.socket;
    const primaryTransport = (nativeFacts.primaryTransport = {
      harnessClientId: randomUUID(),
      serviceId: project.service.serviceId,
      serviceGeneration: project.service.generation,
      attachedAt: Date.now(),
      events: [],
    });
    // 只追加原有 Primary socket 的诊断监听，不替换消息处理或连接策略。
    primarySocket.addEventListener("error", (event) =>
      primaryTransport.events.push({
        at: Date.now(),
        event: "error",
        code: event.error?.code,
        message: event.error?.message ?? event.message,
        sameClient: project.client === desktopClient,
        sameSocket: desktopClient.socket === primarySocket,
      }),
    );
    primarySocket.addEventListener("close", (event) =>
      primaryTransport.events.push({
        at: Date.now(),
        event: "close",
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
        sameClient: project.client === desktopClient,
        sameSocket: desktopClient.socket === primarySocket,
      }),
    );
    const largeId = await createOversizeFixture();
    await chooseDetail(page, largeId);
    await until(
      async () =>
        (await page.locator("#session-error").textContent()).includes("RESOURCE_UNAVAILABLE"),
      "oversized native history explicit unavailable",
    );
    assert.equal(project.client, desktopClient);
    assert.equal(desktopClient.ready, true);
    await assertRetention();
    const previousTurns = new Set(
      (await readThread(browserThread.threadId)).turns.map((turn) => turn.id),
    );
    const observationCount = nativeFacts.observations.length;
    nativeFacts.postOversizeSubmission = await desktopCommand("send", {
      projectId,
      threadId: browserThread.threadId,
      text: "Observe the same native page again",
    });
    await desktop.getByRole("button",{name:"允许一次",exact:true}).click();
    await desktop.getByText("操作：observe",{exact:true}).waitFor();
    await desktop.getByRole("button",{name:"允许一次",exact:true}).click();
    const nextObservation = await until(
      () =>
        nativeFacts.observations
          .slice(observationCount)
          .find((value) => value.request.phase === "execute" && !previousTurns.has(value.request.turnId) && value.response),
      "new original Turn native observe",
      60000,
    );
    assert.notEqual(nextObservation.request.turnId, firstObservation.request.turnId);
    await waitObserve(nextObservation);
    await drainNativeDiagnostics("postoversize-observe-completed");
    offNative();
    checks.push(
      "native history >4 MiB rejects only dedicated observer; a new original Core Turn executes matched successful native observe with retained page, edited input and claim",
    );
    await page.screenshot({
      path: join(scratch, "session-oversized-unavailable.png"),
      fullPage: true,
    });
  } else {
    await createOversizeFixture();
    assert.equal(project.client, initialDesktopClient);
    assert.equal(initialDesktopClient.ready, true);
  }
  phase("unknown-original");
  const unknownId = await createThread();
  unknownWatch = { peer: paired.peer, threadId: unknownId };
  await openDetail(page, unknownId);
  nativeFacts.unknown.startReply = await startTurn(unknownId, "RC04_UNKNOWN");
  await until(async () => {
    try {
      return (await readFile(unknownMarker, "utf8")) === "x";
    } catch {
      return false;
    }
  }, "real Runtime effect begins");
  const inFlight = await until(async () => {
    const thread = await readThread(unknownId);
    for (const turn of thread.turns)
      for (const item of turn.items ?? [])
        if (
          item.type === "dynamicToolCall" &&
          item.tool === "run_command" &&
          item.status === "inProgress" &&
          item.execution?.outcome === "running"
        )
          return { threadId: thread.id, turnId: turn.id, item: structuredClone(item) };
  }, "actual in-flight Runtime operation identity");
  nativeFacts.unknown.inFlight = inFlight;
  assert.equal(inFlight.item.execution.backend, "runtime");
  assert.equal(inFlight.turnId, nativeFacts.unknown.startReply.turn.id);
  for (const key of ["runtimeEpoch", "scopeId", "operationId"])
    assert.ok(
      typeof inFlight.item.execution[key] === "string" && inFlight.item.execution[key].length,
      key,
    );
  const oldGeneration = project.service.generation;
  const preRestartEvent = await until(
    () =>
      unknownEvent?.serviceGeneration === oldGeneration &&
      unknownEvent.snapshot?.threadId === unknownId &&
      unknownEvent.subscriptionId &&
      unknownEvent.snapshot.turns.some(
        (turn) =>
          turn.id === inFlight.turnId &&
          turn.items.some(
            (item) => item.id === inFlight.item.id && item.executionOutcome === "running",
          ),
      )
        ? structuredClone(unknownEvent)
        : null,
    "exact old UNKNOWN Thread event",
  );
  nativeFacts.unknown.staleEvent = preRestartEvent;
  phase("intentional-core-loss");
  process.kill(project.service.corePid, "SIGKILL");
  await until(() => writer.closed && !project.client?.ready, "Core failure in flight");
  await until(
    async () => (await page.locator("#session-error").textContent()).includes("RESYNC_REQUIRED"),
    "Remote invalidated on native Core loss",
  );
  phase("restart");
  await backend.restartProject(project);
  writer = await connectWriter();
  nativeFacts.unknown.newGeneration = project.service.generation;
  assert.notEqual(project.service.generation, oldGeneration);
  await openDetail(page, unknownId);
  await until(
    async () =>
      (await page.locator("#session-attention").textContent()).includes("executionUnknown"),
    "restarted Core UNKNOWN in production Remote",
  );
  const assertUnknown = async (phase) => {
    const thread = await readThread(unknownId),
      turn = thread.turns.find((value) => value.id === inFlight.turnId);
    const item = turn?.items.find(
      (value) => value.id === inFlight.item.id && value.callId === inFlight.item.callId,
    );
    nativeFacts.unknown[phase] = { thread, item };
    assert.equal(turn?.status, "failed");
    assert.equal(item?.execution?.outcome, "unknown");
    assert.ok(!item.execution.inspection);
    for (const key of ["runtimeEpoch", "scopeId", "operationId"])
      assert.equal(item.execution[key], inFlight.item.execution[key], key);
    assert.equal(
      thread.turns
        .flatMap((value) => value.items ?? [])
        .filter((value) => value.type === "dynamicToolCall" && value.tool === "run_command").length,
      1,
    );
    assert.equal(await readFile(unknownMarker, "utf8"), "x");
  };
  const newBaseline = (nativeFacts.unknown.newBaseline = structuredClone(
    secureOutputs.get(paired.peer).baseline,
  ));
  assert.equal(newBaseline.snapshot.threadId, unknownId);
  assert.equal(newBaseline.serviceGeneration, project.service.generation);
  assert.notEqual(newBaseline.subscriptionId, preRestartEvent.subscriptionId);
  assert.ok(
    newBaseline.snapshot.attentionRefs.some(
      (value) =>
        value.kind === "executionUnknown" &&
        value.threadId === unknownId &&
        value.turnId === inFlight.turnId &&
        value.itemId === inFlight.item.id,
    ),
  );
  trace("unknown-baseline", frameMetadata({ result: newBaseline }));
  await assertUnknown("afterRestart");
  phase("after-restart-oracle-passed");
  phase("stale-injection");
  trace("host-outgoing", { origin: "explicit-stale-injection", ...frameMetadata(preRestartEvent) });
  secureOutputs.get(paired.peer).send(preRestartEvent);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.match(await page.locator("#session-attention").textContent(), /executionUnknown/);
  assert.equal((await detailState(page)).threadId,unknownId);
  assert.equal(await page.locator(`[data-side-item-id="${inFlight.item.id}"]`).count(), 1);
  assert.match(await page.locator(`[data-side-item-id="${inFlight.item.id}"]`).textContent(), /UNKNOWN/i);
  await assertUnknown("afterStaleEvent");
  phase("after-stale-oracle-passed");
  faults.push({
    type: "late-real-old-service-message",
    oldGeneration,
    newGeneration: project.service.generation,
    threadId: unknownId,
    subscriptionId: preRestartEvent.subscriptionId,
    connectionId: preRestartEvent.connectionId,
    gatewayGeneration: preRestartEvent.gatewayGeneration,
    sequence: preRestartEvent.sequence,
  });
  checks.push(
    "T16: same in-flight Runtime Turn/call/operation becomes UNKNOWN after Core restart, with no inspection/acknowledgement/replay; exact old Thread/subscription/generation event is rejected",
  );
  await page.screenshot({ path: join(scratch, "session-unknown-restart.png"), fullPage: true });
  await drainNativeDiagnostics("unknown-restart-completed");
  passed = true;
} catch (error) {
  trace("failure", { errorCode: error.code });
  errors.push(error.stack ?? String(error));
  await drainNativeDiagnostics("failure");
  if (page) {
    try {
      await page.screenshot({ path: join(scratch, "remote-failure.png"), fullPage: true });
      await writeFile(join(scratch, "remote-failure.txt"), await page.locator("body").innerText());
    } catch {}
  }
  if (desktop) await captureSmokeFailure(desktop, scratch, error);
  process.exitCode = 1;
} finally {
  await drainNativeDiagnostics("before-app-close");
  if (nativeFacts.navigationIncomplete) {
    passed = false;
    process.exitCode = 1;
    errors.push("Native navigation diagnostic trace is incomplete; see drain/overflow metadata");
  }
  if (unknownOnly) {
    // 原始对象仅用于原有断言；落盘只保留执行身份与结果，不保留正文。
    for (const key of ["staleEvent", "newBaseline"])
      if (nativeFacts.unknown[key])
        nativeFacts.unknown[key] = frameMetadata(
          key === "newBaseline" ? { result: nativeFacts.unknown[key] } : nativeFacts.unknown[key],
        );
    for (const key of ["inFlight", "afterRestart", "afterStaleEvent"])
      if (nativeFacts.unknown[key]) {
        const value = nativeFacts.unknown[key],
          item = value.item;
        nativeFacts.unknown[key] = {
          threadId: value.threadId ?? value.thread?.id,
          turnId:
            value.turnId ??
            value.thread?.turns.find((turn) => turn.items.some((i) => i.id === item?.id))?.id,
          itemId: item?.id,
          callId: item?.callId,
          outcome: item?.execution?.outcome,
          runtimeEpoch: item?.execution?.runtimeEpoch,
          scopeId: item?.execution?.scopeId,
          operationId: item?.execution?.operationId,
          inspection: Boolean(item?.execution?.inspection),
        };
      }
    if (nativeFacts.unknown.startReply)
      nativeFacts.unknown.startReply = { turnId: nativeFacts.unknown.startReply.turn.id };
    if (diagnostic.dropped) {
      passed = false;
      process.exitCode = 1;
      errors.push("UNKNOWN diagnostic overflow");
    }
    await writeFile(join(scratch, "unknown-diagnostic.json"), JSON.stringify(diagnostic, null, 2));
  }
  await writeFile(join(scratch, "native-browser-facts.json"), JSON.stringify(nativeFacts, null, 2));
  for (const socket of remoteSockets) socket.terminate();
  for (const client of clients) client.close();
  await browser?.close();
  await application.close();
  await app?.close();
  service?.close();
  proxy?.close();
  for (const value of backend.projects.values()) {
    try {
      await value.client?.request("areal/server/drain", { strategy: "cancel", timeoutMs: 30000 });
    } catch {}
  }
  const instances = [...backend.projects.values()].map((value) => value.service).filter(Boolean);
  await backend.disconnect();
  const cleanup = [];
  for (const instance of instances) {
    try {
      const descriptorPath = join(
        scratch,
        "registry",
        "services",
        instance.serviceId,
        "service.json",
      );
      const current = JSON.parse(await readFile(descriptorPath, "utf8"));
      assert.equal(current.hostPid, instance.hostPid);
      assert.equal(current.generation, instance.generation);
      const command = execFileSync("ps", ["-p", String(instance.hostPid), "-o", "command="], {
        encoding: "utf8",
      });
      assert.ok(command.startsWith(`${backend.binary} service-host`));
      process.kill(instance.hostPid, "SIGTERM");
      await until(
        async () => JSON.parse(await readFile(descriptorPath, "utf8")).state === "stopped",
        "fixture host cleanup",
        30000,
      );
      cleanup.push({
        serviceId: instance.serviceId,
        state: "stopped",
        method: "owned fixture host SIGTERM, no UNKNOWN acknowledgement",
      });
    } catch (error) {
      cleanup.push({ serviceId: instance.serviceId, error: error.message });
      passed = false;
      process.exitCode = 1;
    }
  }
  for (const server of [model, site]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  const manifest = {
    passed,
    checks,
    faults,
    errors,
    cleanup,
    modelRequests,
    nativeFacts,
    source: {
      revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      dirty: execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" }).trim(),
      diffSha256: createHash("sha256")
        .update(execFileSync("git", ["diff", "HEAD"], { cwd: root }))
        .digest("hex"),
    },
    core: {
      binary: backend.binary,
      sha256: createHash("sha256")
        .update(await readFile(backend.binary))
        .digest("hex"),
    },
    effectiveConfig: {
      modelConfig,
      deployment: JSON.parse(await readFile(deployment, "utf8")),
      registry: join(scratch, "registry"),
      userHome,
    },
    authFlow:
      "real Noise invitation; production Desktop UI project selection and Observer approval; no preinstalled grant",
    transport: "Direct loopback; transparent real-Core transport fault proxy",
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    notRun: [
      "next-prompt predictions (disabled); auxiliary session names use the shared model fixture",
      "application-owner lifecycle (shared Main/Host identity fixture)",
      "actual system keychain (safeStorage boundary fixture)",
      "installed/signed package",
      "public HTTPS/WSS",
      "Relay",
      "physical mobile devices",
      "Core hydration CPU isolation",
    ],
  };
  await writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ passed, evidence: scratch, checks, errors, cleanup }));
}
