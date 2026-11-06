"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { DesktopService } = require("@areal/workbench-service/desktop/core/service-protocol.cjs");
function fixture(host) {
  const backend = {
    projects: new Map(),
    providers: { redact: (value) => value },
    analytics: { sample() {} },
    starting: new Map(),
    hasWork: () => false,
    hostCall: host,
    host: { sourceId: "source", resolve: () => ({ projectId: "canonical" }) },
    hostCoreClients: new Map(),
    connections: { revokeDesktopToolHost() {} },
  };
  const service = new DesktopService(backend, "fixture");
  service.schedule = () => {};
  const owner = () => {
    const socket = { readyState: 1, bufferedAmount: 0, send() {}, close() {} };
    service.clients.add(socket);
    return socket;
  };
  return { service, owner };
}
const attached = (lease) => ({
  lease,
  coreInstanceId: "core",
  coreGeneration: "generation",
  connectionId: lease,
  capabilities: { methods: ["areal/process/read"], features: { connectionProcesses: true } },
});
test("GUI sockets own separate Host terminal leases and closing one leaves the other readable", async () => {
  const calls = [];
  let sequence = 0;
  const f = fixture(async (method, params) => {
    calls.push({ method, params });
    return method === "core.attach"
      ? attached(`lease-${++sequence}`)
      : method === "core.request"
        ? { result: { chunks: [] }, sequence: 0 }
        : { closed: true };
  });
  const first = f.owner(),
    second = f.owner();
  const a = await f.service.hostTerminalClient(first, "project"),
    b = await f.service.hostTerminalClient(second, "project");
  assert.equal(await f.service.hostTerminalClient(first, "project"), a);
  assert.notEqual(a, b);
  f.service.disconnectClient(first);
  assert.equal(a.closed, true);
  assert.equal(b.ready, true);
  assert.deepEqual(await b.request("areal/process/read", { threadId: "thread", id: "pty" }), {
    chunks: [],
  });
  assert.deepEqual(
    calls.filter((call) => call.method === "core.detach").map((call) => call.params.lease),
    ["lease-1"],
  );
  f.service.disconnectClient(second);
  f.service.close();
});
test("a GUI owner disappearing during attach releases the late original lease", async () => {
  let settle;
  const attaching = new Promise((resolve) => {
    settle = resolve;
  });
  const detached = [];
  const f = fixture(async (method, params) => {
    if (method === "core.attach") return attaching;
    if (method === "core.detach") detached.push(params.lease);
    return { closed: true };
  });
  const owner = f.owner(),
    pending = f.service.hostTerminalClient(owner, "project");
  f.service.disconnectClient(owner);
  settle(attached("original-late-lease"));
  await assert.rejects(pending, /closed during attachment|disconnected/);
  assert.deepEqual(detached, ["original-late-lease"]);
  assert.equal(f.service.hostTerminals.size, 0);
  f.service.close();
});
