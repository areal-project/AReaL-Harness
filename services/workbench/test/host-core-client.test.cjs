"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { HostCoreClient } = require("../src/generated/host-core-client.cjs");
const { HostClient } = require("@areal/client/node");
const attached = { lease: "lease", coreInstanceId: "core", coreGeneration: "generation", connectionId: "connection", capabilities: { methods: ["areal/turn/start"] } };
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test("native desktop negotiated frames accept fragmented history while ordinary Host frames stay bounded", () => {
  const result = "x".repeat(1024 * 1024 + 256);
  const bytes = Buffer.from(JSON.stringify({ version: 1, id: "large", result }) + "\n");
  const native = new HostClient({ desktopCore: true });
  let received;
  native.pending.set("large", { resolve: (value) => { received = value; }, reject: assert.fail });
  native.receive(bytes.subarray(0, bytes.length - 1));
  assert.equal(native.pending.has("large"), true);
  native.receive(bytes.subarray(bytes.length - 1));
  assert.equal(received, result);
  const ordinary = new HostClient();
  let rejected;
  ordinary.pending.set("large", { resolve: assert.fail, reject: (error) => { rejected = error; } });
  ordinary.receive(bytes.subarray(0, bytes.length - 1));
  assert.match(rejected.message, /exceeds/);
});

test("Host Core requests keep source, lease and original request; failed transport never replays", async () => {
  const calls = [];
  const client = new HostCoreClient({ sourceId: "source", projectId: "canonical", host: async (method, params) => {
    calls.push({ method, params });
    if (method === "core.attach") return attached;
    if (method === "core.request") throw new Error("lost response");
    return { closed: true };
  } });
  await client.connect();
  await assert.rejects(client.request("areal/turn/start", { requestId: "original", threadId: "thread" }), /lost response/);
  assert.deepEqual(calls.filter((call) => call.method === "core.request"), [{ method: "core.request", params: {
    sourceId: "source", projectId: "canonical", lease: "lease", method: "areal/turn/start", params: { requestId: "original", threadId: "thread" },
  } }]);
  client.close();
});

test("late attach releases only its returned lease and cannot revive a closed projection", async () => {
  const result = deferred();
  const calls = [];
  const client = new HostCoreClient({ sourceId: "s", projectId: "p", host: async (method, params) => {
    calls.push({ method, params });
    return method === "core.attach" ? result.promise : { closed: true };
  } });
  const connecting = client.connect();
  client.close();
  result.resolve(attached);
  await assert.rejects(connecting, /closed during attachment/);
  assert.equal(client.ready, false);
  assert.equal(calls.filter((call) => call.method === "core.detach").length, 1);
  assert.equal(calls.at(-1).params.lease, "lease");
});

test("closing a terminal projection detaches its dedicated lease and leaves primary attached", async () => {
  const calls = [];
  const host = async (method, params) => {
    calls.push({ method, params });
    if (method === "core.attach") return { ...attached, lease: params.scope === "terminal" ? "terminal-lease" : "primary-lease" };
    return method === "core.request" ? { result: { alive: true }, sequence: 0 } : { closed: true };
  };
  const primary = new HostCoreClient({ sourceId: "s", projectId: "p", host });
  const terminal = new HostCoreClient({ sourceId: "s", projectId: "p", scope: "terminal", host });
  await primary.connect(); await terminal.connect();
  terminal.close();
  assert.equal(primary.ready, true);
  assert.deepEqual(await primary.request("areal/capabilities"), { alive: true });
  assert.deepEqual(calls.filter((call) => call.method === "core.detach").map((call) => call.params.lease), ["terminal-lease"]);
  primary.close();
});

test("Core cancellation aborts only the original tool request and close revokes remaining callbacks", async () => {
  const calls = new Map();
  const client = new HostCoreClient({ sourceId: "s", projectId: "p", host: async () => attached,
    onServerRequest: async (_method, _params, context) => {
      const result = deferred();
      calls.set(context.requestId, { ...result, signal: context.signal });
      return result.promise;
    },
  });
  await client.connect();
  const first = client.callback({ lease: "lease", method: "item/tool/call", requestId: "one", params: {} });
  const second = client.callback({ lease: "lease", method: "item/tool/call", requestId: "two", params: {} });
  client.event({ lease: "stale", method: "areal/tool/cancelled", params: { requestId: "one" } });
  assert.equal(calls.get("one").signal.aborted, false);
  client.event({ lease: "lease", method: "areal/tool/cancelled", params: { requestId: "one" } });
  assert.equal(calls.get("one").signal.aborted, true);
  assert.equal(calls.get("two").signal.aborted, false);
  client.close();
  assert.equal(calls.get("two").signal.aborted, true);
  calls.get("one").resolve({}); calls.get("two").resolve({});
  await assert.rejects(first, /owner changed/);
  await assert.rejects(second, /owner changed/);
});

test("invalid response budget is rejected before a mutation reaches Host", async () => {
  const calls = [];
  const client = new HostCoreClient({ sourceId: "s", projectId: "p", host: async (method) => { calls.push(method); return attached; } });
  await client.connect();
  await assert.rejects(client.request("areal/turn/start", { requestId: "r" }, { maxResponseBytes: 0 }), RangeError);
  assert.deepEqual(calls, ["core.attach"]);
  client.close();
});

test("Host submission and reconciliation preserve original identity and admission errors", async () => {
  const calls = [];
  const client = new HostCoreClient({ sourceId: "source", projectId: "project", host: async (method, params) => {
    calls.push({ method, params });
    if (method === "core.attach") return attached;
    if (method === "execution.submit") return { error: { code: -32011, message: "original admitted", data: {
      outcome: { kind: "admitted" }, recovery: { kind: "queryOriginal" }, reason: "COMPLETION_UNCONFIRMED",
    } } };
    if (method === "execution.reconcile") return { confirmed: false, state: "unconfirmed" };
    return { closed: true };
  } });
  await client.connect();
  const params = { requestId: "original", threadId: "thread", input: [] };
  await assert.rejects(client.submit("areal/turn/submit", params, true), (error) => {
    assert.equal(error.outcome.kind, "admitted");
    assert.equal(error.recovery.kind, "queryOriginal");
    return true;
  });
  assert.deepEqual(await client.reconcile("areal/turn/submit", { requestId: "original", threadId: "thread" }), { confirmed: false, state: "unconfirmed" });
  assert.equal(calls.filter((call) => call.method === "execution.submit").length, 1);
  assert.deepEqual(calls[1].params, { sourceId: "source", projectId: "project", lease: "lease", method: "areal/turn/submit", params, remember: true });
  assert.equal(calls[2].params.params.requestId, "original");
  client.close();
});


test("a snapshot installs before later increments even when Host forwards events before its reply", async () => {
  const response = deferred();
  const client = new HostCoreClient({ sourceId: "s", projectId: "p", host: async (method) =>
    method === "core.attach" ? attached : method === "core.request" ? response.promise : { closed: true } });
  await client.connect();
  const seen = [];
  client.onNotification((_method, params) => seen.push(params.value));
  const reading = client.request("areal/thread/observe", { threadId: "thread" }, {
    onResult: (value) => seen.push(value.snapshot),
  });
  client.event({ lease: "lease", sequence: 4, method: "item/completed", params: { threadId: "thread", value: "already in snapshot" } });
  client.event({ lease: "lease", sequence: 6, method: "item/completed", params: { threadId: "thread", value: "later delta" } });
  assert.deepEqual(seen, []);
  response.resolve({ result: { snapshot: "snapshot" }, sequence: 5 });
  await reading;
  assert.deepEqual(seen, ["snapshot", "later delta"]);
  client.close();
});

test("a rejected observation preserves the prior projection and does not revoke its lease", async () => {
  const response = deferred();
  const calls = [];
  const client = new HostCoreClient({ sourceId: "s", projectId: "p", host: async (method) => {
    calls.push(method);
    return method === "core.attach" ? attached : response.promise;
  } });
  await client.connect();
  const seen = [];
  client.onNotification((_method, params) => seen.push(params.value));
  const reading = client.request("areal/thread/observe", { threadId: "thread" }, { onResult: () => assert.fail("rejected snapshot must not install") });
  client.event({ lease: "lease", sequence: 4, method: "item/completed", params: { threadId: "thread", value: "delta" } });
  response.resolve({ error: { code: -32602, message: "HISTORY_BUDGET_TOO_SMALL" } });
  await assert.rejects(reading, /HISTORY_BUDGET_TOO_SMALL/);
  assert.deepEqual(seen, ["delta"]);
  assert.equal(client.closed, false);
  assert.deepEqual(calls, ["core.attach", "core.request"]);
  client.close();
});
