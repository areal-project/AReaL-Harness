// Failure cases captured before implementation: wrong window/thread/generation;
// stale asynchronous open/reply; undeclared networks; malformed JSON-RPC;
// cross-server selection; raw file paths; ETag conflict; close during request.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  McpAppsHost,
  appCsp,
  parseDeepLink,
} = require("@areal/workbench-service/desktop/core/mcp-apps.cjs");
assert.throws(() => appCsp({ connectDomains: ["https://ok.test; script-src *"] }));
assert.match(appCsp({}), /connect-src 'none'/);
assert.match(appCsp({ resourceDomains: ["https://*.example.com"] }), /https:\/\/\*.example.com/);
assert.throws(() => parseDeepLink("codex://plugins/x/app/y?path=https%3A%2F%2Fevil.test"));
assert.throws(() => parseDeepLink("codex://plugins/x/app/y?path=%2F%2Fevil.test"));
assert.equal(
  parseDeepLink("codex://plugins/p@apps/app/t?path=%2Fparts%3Fa%3D1").path,
  "/parts?a=1",
);
let owner = true,
  pending,
  calls = [];
const backend = {
  ownsThread: () => owner,
  command: async (_name, value) => {
    calls.push(value);
    if (value.operation === "mcpAppOpen")
      return {
        instanceId: "i",
        serverId: "s",
        generation: "g",
        resource: {
          mimeType: "text/html;profile=mcp-app",
          html: '<script>parent.postMessage({jsonrpc:"2.0",id:1,method:"ui/initialize"},"*")</script>',
        },
        initialArguments: {},
        initialResult: { content: [] },
      };
    if (value.operation === "mcpAppRequest")
      return new Promise((resolve) => {
        pending = resolve;
      });
    return {};
  },
};
const host = new McpAppsHost({ backend, ownerId: 5 });
const app = await host.open(
  { projectId: "p", threadId: "t", serverId: "s", expectedGeneration: "g", toolName: "app" },
  5,
);
assert.ok(app.frameUrl.startsWith("areal-mcp://"));
assert.equal(app.resource, undefined);
assert.throws(() => host.get(app.token, 6));
await assert.rejects(
  host.request(app.token, { jsonrpc: "2.0", id: 1, method: "arbitrary/method" }, 5),
);
await assert.rejects(
  host.request(
    app.token,
    { jsonrpc: "2.0", id: "private", method: "ui/host-file", params: { request: {} } },
    5,
  ),
  /unsupported/,
);
const response = await host.resource(new Request(app.frameUrl));
assert.equal(response.status, 200);
assert.match(response.headers.get("Content-Security-Policy"), /default-src 'none'/);
const waiting = host.request(
  app.token,
  { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read", arguments: {} } },
  5,
);
const repeated = host.request(
  app.token,
  { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read", arguments: {} } },
  5,
);
assert.equal(calls.filter((call) => call.operation === "mcpAppRequest").length, 1);
await assert.rejects(
  host.request(
    app.token,
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "write", arguments: {} } },
    5,
  ),
  /reused/,
);
const repeatedRejected = assert.rejects(repeated, /closed|stale/i);
const rejected = assert.rejects(waiting, /closed|stale/i);
await host.close(app.token, 5);
pending({ jsonrpc: "2.0", id: 2, result: { content: [] } });
await rejected;
await repeatedRejected;
assert.equal((await host.resource(new Request(app.frameUrl))).status, 404);
owner = false;
await assert.rejects(
  host.open(
    { projectId: "p", threadId: "t", serverId: "s", expectedGeneration: "g", toolName: "app" },
    5,
  ),
);

let activeOwner = 5,
  destroyedOwner = false;
const lifecycleCalls = [];
const lifecycleBackend = {
  ownsThread: () => true,
  snapshot: () => ({ projects: [] }),
  command: async (_name, request) => {
    lifecycleCalls.push(request);
    return request.operation === "mcpAppOpen"
      ? {
          instanceId: "instance-" + lifecycleCalls.length,
          serverId: "s",
          generation: "g",
          resource: { mimeType: "text/html;profile=mcp-app", html: "<p>owned</p>" },
        }
      : {};
  },
};
const ownerHost = new McpAppsHost({
  backend: lifecycleBackend,
  ownerId: () => {
    if (destroyedOwner) throw Error("Object has been destroyed");
    return activeOwner;
  },
});
const openOwned = (owner) =>
  ownerHost.open(
    { projectId: "p", threadId: "t", serverId: "s", expectedGeneration: "g", toolName: "app" },
    owner,
  );
const originalOwnerApp = await openOwned(5);
activeOwner = 6;
assert.throws(() => ownerHost.get(originalOwnerApp.token, 5), /closed|stale/);
assert.throws(() => ownerHost.get(originalOwnerApp.token, 6), /closed|stale/);
await assert.rejects(
  ownerHost.request(originalOwnerApp.token, { jsonrpc: "2.0", id: 1, method: "tools/list" }, 6),
  /closed|stale/,
);
await assert.rejects(ownerHost.close(originalOwnerApp.token, 6), /Invalid app owner/);
const replacementOwnerApp = await openOwned(6);
assert.equal(
  ownerHost.get(replacementOwnerApp.token, 6).instanceId,
  replacementOwnerApp.instanceId,
);
destroyedOwner = true;
assert.equal(
  ownerHost.notification({
    projectId: "p",
    threadId: "t",
    instanceId: originalOwnerApp.instanceId,
    generation: "g",
    notification: { jsonrpc: "2.0", method: "ui/notifications/closed" },
  }),
  true,
);
ownerHost.dispose();
assert.deepEqual(
  lifecycleCalls
    .filter((request) => request.operation === "mcpAppClose")
    .map((request) => request.instanceId),
  [originalOwnerApp.instanceId, replacementOwnerApp.instanceId],
);
assert.equal((await ownerHost.resource(new Request(replacementOwnerApp.frameUrl))).status, 404);

let releaseOpen;
activeOwner = 5;
const pendingCalls = [];
const pendingOwnerHost = new McpAppsHost({
  ownerId: () => activeOwner,
  backend: {
    ownsThread: () => true,
    command: async (_name, request) => {
      pendingCalls.push(request);
      if (request.operation === "mcpAppOpen")
        return new Promise((resolve) => {
          releaseOpen = resolve;
        });
      return {};
    },
  },
});
const changingOwnerOpen = pendingOwnerHost.open(
  { projectId: "p", threadId: "t", serverId: "s", expectedGeneration: "g", toolName: "app" },
  5,
);
const staleOpenRejected = assert.rejects(changingOwnerOpen, /invalid|stale/i);
activeOwner = 6;
releaseOpen({
  instanceId: "pending-original-owner",
  serverId: "s",
  generation: "g",
  resource: { mimeType: "text/html;profile=mcp-app", html: "<p>stale</p>" },
});
await staleOpenRejected;
assert.deepEqual(
  pendingCalls.filter((request) => request.operation === "mcpAppClose"),
  [
    {
      operation: "mcpAppClose",
      projectId: "p",
      threadId: "t",
      instanceId: "pending-original-owner",
      generation: "g",
    },
  ],
);

const resultEpoch = "4ea7926c-c58c-4671-928f-9bbb27b42b04";
const resultRequest = (n) =>
  `result-v1.${resultEpoch}.00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const resultRef = { projectId: "p", threadId: "t", turnId: "turn-2", itemId: "item-2" };
const resultCalls = [];
let resultRelease, resultReply;
const resultDescriptor = {
  instanceId: "saved-result",
  serverId: "s",
  generation: 7,
  resource: { mimeType: "text/html;profile=mcp-app", html: "<p>saved</p>" },
  initialArguments: { changedByHook: true },
  initialResult: { structuredContent: { answer: 42 }, _meta: { privateMarker: "APP_ONLY" } },
};
const resultHost = new McpAppsHost({
  ownerId: 5,
  backend: {
    ownsThread: (projectId, threadId) => projectId === "p" && threadId === "t",
    command: async (_name, request) => {
      resultCalls.push(request);
      if (request.operation === "mcpAppOpenFromResult") {
        if (resultReply) return resultReply;
        return new Promise((resolve) => {
          resultRelease = resolve;
        });
      }
      return {};
    },
  },
});
assert.equal(
  typeof resultHost.openFromResult,
  "function",
  "Main must expose the strict saved-result operation",
);
const firstResult = resultHost.openFromResult({ ...resultRef, requestId: resultRequest(1) }, 5);
const concurrentResult = resultHost.openFromResult(
  { ...resultRef, requestId: resultRequest(1) },
  5,
);
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(resultCalls, [
  { operation: "mcpAppOpenFromResult", ...resultRef, requestId: resultRequest(1) },
]);
resultRelease({ status: "open", instance: resultDescriptor });
const firstResultReply = await firstResult;
assert.equal(firstResultReply.status, "open");
const resultApp = firstResultReply.app;
assert.deepEqual(
  await concurrentResult,
  firstResultReply,
  "concurrent exact result requests reuse the complete descriptor",
);
assert.equal(resultApp.resource, undefined);
assert.deepEqual(resultApp.initialArguments, { changedByHook: true });
assert.deepEqual(resultApp.initialResult, resultDescriptor.initialResult);
resultReply = { status: "open", instance: resultDescriptor };
assert.deepEqual(
  await resultHost.openFromResult({ ...resultRef, requestId: resultRequest(2) }, 5),
  firstResultReply,
  "Core instance reuse must retain Main token and frame URL",
);
for (const field of [
  "html",
  "resourceUri",
  "arguments",
  "serverId",
  "expectedGeneration",
  "identity",
  "callId",
]) {
  await assert.rejects(
    resultHost.openFromResult({ ...resultRef, requestId: resultRequest(3), [field]: "forged" }, 5),
    /invalid|unsupported/i,
  );
}
await assert.rejects(
  resultHost.openFromResult({ ...resultRef, requestId: resultRequest(3) }, 6),
  /owner|stale/i,
);
await resultHost.close(resultApp.token, 5);
assert.equal((await resultHost.resource(new Request(resultApp.frameUrl))).status, 404);
resultReply = { status: "closed" };
assert.deepEqual(
  await resultHost.openFromResult({ ...resultRef, requestId: resultRequest(1) }, 5),
  { status: "closed" },
);
resultReply = { status: "unavailable", reason: "staleSourceEpoch" };
assert.deepEqual(
  await resultHost.openFromResult({ ...resultRef, requestId: resultRequest(4) }, 5),
  resultReply,
);
resultReply = {
  status: "open",
  instance: {
    ...resultDescriptor,
    instanceId: "saved-result-html",
    resource: { mimeType: "text/html", html: "<p>utf8</p>" },
  },
};
const plainHtml = await resultHost.openFromResult({ ...resultRef, requestId: resultRequest(5) }, 5);
assert.equal(plainHtml.status, "open", "saved results accept the existing Core HTML MIME contract");
await resultHost.close(plainHtml.app.token, 5);
resultReply = {
  status: "open",
  instance: {
    ...resultDescriptor,
    resource: { mimeType: "text/html;profile=mcp-app", html: "界".repeat(700000) },
  },
};
assert.deepEqual(
  await resultHost.openFromResult({ ...resultRef, requestId: resultRequest(6) }, 5),
  { status: "unavailable", reason: "resourceRejected" },
);
resultReply = {
  status: "open",
  instance: {
    ...resultDescriptor,
    resource: {
      ...resultDescriptor.resource,
      _meta: { ui: { csp: { connectDomains: ["https://bad.test;script-src *"] } } },
    },
  },
};
assert.deepEqual(
  await resultHost.openFromResult({ ...resultRef, requestId: resultRequest(7) }, 5),
  { status: "unavailable", reason: "resourceRejected" },
);
assert.equal(
  resultCalls.filter((call) => call.operation === "mcpAppOpen").length,
  0,
  "saved-result opening never invokes the business entrypoint",
);
let staleResultRelease;
const staleResultCalls = [];
let resultOwnerDestroyed = false;
const staleResultHost = new McpAppsHost({
  ownerId: () => {
    if (resultOwnerDestroyed) throw Error("Object has been destroyed");
    return 5;
  },
  backend: {
    ownsThread: () => true,
    command: async (_name, request) => {
      staleResultCalls.push(request);
      return request.operation === "mcpAppOpenFromResult"
        ? new Promise((resolve) => {
            staleResultRelease = resolve;
          })
        : {};
    },
  },
});
const disposedResult = staleResultHost.openFromResult(
  { ...resultRef, requestId: resultRequest(8) },
  5,
);
await new Promise((resolve) => setImmediate(resolve));
resultOwnerDestroyed = true;
staleResultHost.dispose();
staleResultRelease({ status: "open", instance: resultDescriptor });
assert.deepEqual(await disposedResult, { status: "unavailable", reason: "sourceUnavailable" });
assert.deepEqual(
  staleResultCalls.filter((call) => call.operation === "mcpAppClose"),
  [
    {
      operation: "mcpAppClose",
      projectId: "p",
      threadId: "t",
      instanceId: "saved-result",
      generation: 7,
    },
  ],
);
let unknownClose = true;
const closingCalls = [];
const closingHost = new McpAppsHost({
  ownerId: 5,
  backend: {
    ownsThread: () => true,
    command: async (_name, request) => {
      closingCalls.push(request);
      if (request.operation === "mcpAppOpenFromResult")
        return {
          status: "open",
          instance: {
            ...resultDescriptor,
            instanceId: unknownClose ? "saved-result" : "saved-result-reopened",
          },
        };
      if (request.operation === "mcpAppClose" && unknownClose)
        throw Object.assign(Error("close outcome unknown"), {
          code: "RESPONSE_UNKNOWN",
          submissionUnknown: true,
        });
      return { closed: true };
    },
  },
});
const closingApp = (
  await closingHost.openFromResult({ ...resultRef, requestId: resultRequest(9) }, 5)
).app;
await assert.rejects(closingHost.close(closingApp.token, 5), /unknown/);
assert.equal((await closingHost.resource(new Request(closingApp.frameUrl))).status, 404);
await assert.rejects(
  closingHost.openFromResult({ ...resultRef, requestId: resultRequest(10) }, 5),
  /closing|unknown|核对/i,
);
assert.equal(closingCalls.filter((call) => call.operation === "mcpAppOpenFromResult").length, 1);
unknownClose = false;
await closingHost.close(closingApp.token, 5);
assert.deepEqual(
  closingCalls.filter((call) => call.operation === "mcpAppClose"),
  Array(2).fill({
    operation: "mcpAppClose",
    projectId: "p",
    threadId: "t",
    instanceId: "saved-result",
    generation: 7,
  }),
);
assert.equal(
  (await closingHost.openFromResult({ ...resultRef, requestId: resultRequest(10) }, 5)).status,
  "open",
);
closingHost.dispose();
for (const scenario of [
  { name: "matching close before first adoption", generation: 7, expected: "unavailable" },
  { name: "other generation does not close the pending result", generation: 6, expected: "open" },
  {
    name: "other thread does not close the pending result",
    generation: 7,
    threadId: "other",
    expected: "open",
  },
  {
    name: "other instance does not close the pending result",
    generation: 7,
    instanceId: "other",
    expected: "open",
  },
  {
    name: "bounded terminal facts fail the pending adoption closed",
    generation: 7,
    extraCloses: 9,
    expected: "unavailable",
  },
]) {
  let release;
  const earlyCalls = [];
  const earlyHost = new McpAppsHost({
    ownerId: 5,
    backend: {
      ownsThread: () => true,
      command: async (_name, request) => {
        earlyCalls.push(request);
        return request.operation === "mcpAppOpenFromResult"
          ? new Promise((resolve) => {
              release = resolve;
            })
          : { closed: true };
      },
    },
  });
  const opening = earlyHost.openFromResult({ ...resultRef, requestId: resultRequest(11) }, 5);
  for (let i = 0; i < (scenario.extraCloses ?? 1); i++)
    earlyHost.notification({
      projectId: "p",
      threadId: scenario.threadId ?? "t",
      instanceId: scenario.extraCloses
        ? `other-${i}`
        : (scenario.instanceId ?? resultDescriptor.instanceId),
      generation: scenario.generation,
      notification: { jsonrpc: "2.0", method: "ui/notifications/closed" },
    });
  release({ status: "open", instance: resultDescriptor });
  const reply = await opening;
  assert.equal(reply.status, scenario.expected, scenario.name);
  if (reply.status === "unavailable") {
    assert.deepEqual(reply, { status: "unavailable", reason: "resourceRejected" });
    assert.deepEqual(
      earlyCalls.filter((call) => call.operation === "mcpAppClose"),
      [
        {
          operation: "mcpAppClose",
          projectId: "p",
          threadId: "t",
          instanceId: "saved-result",
          generation: 7,
        },
      ],
    );
  } else {
    assert.equal((await earlyHost.resource(new Request(reply.app.frameUrl + "view"))).status, 200);
    await earlyHost.close(reply.app.token, 5);
  }
}
console.log(
  "Fake Core closed notification wins over first adoption with bounded pending facts; other instances, threads and generations remain open.",
);
console.log(
  "Saved-result Main boundary retains exact owner/token, coalesces concurrent requests, rejects untrusted source fields and closes invalid late results.",
);

// Main file-resource integration tests grant/delegation only. Core descriptor-anchored
// reads, CAS writes, and ancestor-swap races require the real Runtime acceptance test.
const { mkdtemp, writeFile, readFile, rm, symlink } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const {
  authorizeFile,
  fileRequest,
} = require("@areal/workbench-service/desktop/core/mcp-apps-files.cjs");
const directory = await mkdtemp(join(tmpdir(), "areal-mcp-apps-"));
try {
  await writeFile(join(directory, "document.txt"), "one");
  const fileBackend = { snapshot: () => ({ projects: [{ id: "p", root: directory }] }) };
  const file = await authorizeFile(fileBackend, "p", "document.txt");
  assert.ok(!file.uri.includes(directory));
  const delegated = [];
  const call = (method, params) =>
    fileRequest(
      file,
      { jsonrpc: "2.0", id: 42, method, params: { uri: file.uri, ...params } },
      () => {},
      () => {},
      async (request) => {
        delegated.push(request);
        return { jsonrpc: "2.0", id: request.id, result: { delegated: true } };
      },
    );
  assert.deepEqual(await call("resources/read", {}), { delegated: true });
  assert.deepEqual(
    await call("openai/resources/write", { text: "two", ifMatch: "original-etag" }),
    { delegated: true },
  );
  assert.deepEqual(
    delegated.map((request) => request.method),
    ["resources/read", "openai/resources/write"],
  );
  assert.equal(delegated[1].params.ifMatch, "original-etag");
  assert.equal(
    await readFile(join(directory, "document.txt"), "utf8"),
    "one",
    "Main must not read/write resource bytes",
  );
  await assert.rejects(
    fileRequest(
      file,
      { method: "resources/read", params: { uri: file.uri } },
      () => {},
      () => {},
      async () => ({ error: { code: -32000, message: "rejected" } }),
    ),
    /Core file operation/,
  );
  await assert.rejects(
    fileRequest(
      file,
      { method: "resources/read", params: { uri: "areal-file://another" } },
      () => {},
      () => {},
    ),
  );
  await symlink("/etc/hosts", join(directory, "escape"));
  await assert.rejects(authorizeFile(fileBackend, "p", "escape"));
  const boundaryCalls = [];
  const delegatedHost = new McpAppsHost({
    ownerId: 5,
    backend: {
      ...fileBackend,
      ownsThread: () => true,
      command: async (_name, value) => {
        boundaryCalls.push(value);
        if (value.operation === "mcpAppOpen")
          return {
            instanceId: "file-instance",
            serverId: "s",
            generation: "g",
            resource: { mimeType: "text/html;profile=mcp-app", html: "<p>file</p>" },
          };
        if (value.operation === "mcpAppClose") return {};
        return { jsonrpc: "2.0", id: value.request.id, result: { delegated: true } };
      },
    },
  });
  const ownedApp = await delegatedHost.open(
    {
      projectId: "p",
      threadId: "t",
      serverId: "s",
      expectedGeneration: "g",
      toolName: "app",
      filePath: "document.txt",
    },
    5,
  );
  const grant = boundaryCalls.find((value) => value.operation === "mcpAppOpen").fileResource;
  const original = {
    jsonrpc: "2.0",
    id: "file-read",
    method: "resources/read",
    params: { uri: grant.uri },
  };
  assert.equal((await delegatedHost.request(ownedApp.token, original, 5)).result.delegated, true);
  await delegatedHost.request(ownedApp.token, original, 5);
  const privateCalls = boundaryCalls.filter((value) => value.request?.method === "ui/host-file");
  assert.equal(privateCalls.length, 1, "duplicate app ID must not replay private Core operation");
  assert.deepEqual(privateCalls[0].request.params, { request: original });
  assert.equal(privateCalls[0].instanceId, "file-instance");
  assert.equal(privateCalls[0].generation, "g");
  assert.equal(privateCalls[0].threadId, "t");
  assert.equal(privateCalls[0].projectId, "p");
  assert.match(privateCalls[0].requestId, /^[0-9a-f-]{36}$/);
  assert(
    boundaryCalls.findIndex((value) => value.request?.method === "ui/host-authorize") <
      boundaryCalls.findIndex((value) => value.request?.method === "ui/host-file"),
  );
  await delegatedHost.close(ownedApp.token, 5);
  await call("resources/subscribe", {});
  assert.ok(file.watcher);
  await call("resources/unsubscribe", {});
  assert.equal(file.watcher, null);
} finally {
  await rm(directory, { recursive: true, force: true });
}
console.log(
  "MCP Apps host integration passed: ownership, stale completion, CSP, deep links, opaque file grants, private Core file delegation, subscriptions, symlink escape. External Core transport is fake; CAS/ancestor-race/native sandbox remain separate gates.",
);

// Exercise the real official bridge protocol parser: SDK 2 moves request _meta into context.
const rendererRequire = createRequire(new URL("../renderer/package.json", import.meta.url));
const { AppBridge } = await import(
  rendererRequire.resolve("@modelcontextprotocol/ext-apps/app-bridge")
);
const messages = [];
let messageMetadata;
const transport = {
  start: async () => {},
  send: async (message) => {
    messages.push(message);
  },
  close: async () => {},
};
const bridge = new AppBridge(null, { name: "areal-test", version: "1" }, { message: { text: {} } });
bridge.onmessage = async (params, extra) => {
  messageMetadata = extra.mcpReq._meta;
  assert.equal(params.role, "user");
  return {};
};
await bridge.connect(transport);
transport.onmessage({
  jsonrpc: "2.0",
  id: 1,
  method: "ui/initialize",
  params: {
    appInfo: { name: "fixture", version: "1" },
    protocolVersion: "2026-01-26",
    appCapabilities: {},
  },
});
await new Promise((resolve) => setImmediate(resolve));
assert.equal(messages[0].result.protocolVersion, "2026-01-26");
transport.onmessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
await new Promise((resolve) => setImmediate(resolve));
transport.onmessage({
  jsonrpc: "2.0",
  id: 2,
  method: "ui/message",
  params: {
    role: "user",
    content: [{ type: "text", text: "draft" }],
    _meta: { "openai/message": { target: "new", send: false } },
  },
});
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(messageMetadata, { "openai/message": { target: "new", send: false } });
await bridge.close();
console.log("Official AppBridge initialize/message metadata integration passed.");
