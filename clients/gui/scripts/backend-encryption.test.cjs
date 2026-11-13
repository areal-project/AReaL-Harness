const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  DesktopService,
  PROTOCOL,
} = require("@areal/workbench-service/desktop/core/service-protocol.cjs");

test("安全存储回调绑定原外壳，其他客户端不能结算，断开后不重发", async (t) => {
  const service = new DesktopService(
    {
      projects: new Map(),
      starting: new Map(),
      connections: { revokeDesktopToolHost() {} },
      analytics: { sample() {}, async flush() {} },
      providers: { redact: (value) => value },
      library: { value: { settings: {} } },
      hasWork: () => false,
      snapshot: () => ({ projects: [] }),
    },
    "fixture",
  );
  t.after(() => service.close());
  const requests = [];
  const owner = service.connectMain(
    (message) => {
      if (message.method === "encryptionRequest") requests.push(message.params);
    },
    () => {},
  );
  const other = service.connectMain(
    () => {},
    () => {},
  );
  await owner.request("hello", {
    protocol: PROTOCOL,
    identity: "fixture",
    capabilities: { computerHost: 1 },
  });
  await other.request("hello", { protocol: PROTOCOL, identity: "fixture", capabilities: {} });
  const pending = service.encryptionRequest("encrypt", "test-only-secret");
  assert.equal(requests.length, 1);
  const { requestId } = requests[0];
  await assert.rejects(
    other.request("encryptionResult", { requestId, result: "forged" }),
    /安全存储回复/,
  );
  await owner.request("encryptionResult", { requestId, result: "sealed" });
  assert.equal(await pending, "sealed");
  assert.ok(!JSON.stringify(service.packet()).includes("test-only-secret"));
  const disconnected = assert.rejects(service.encryptionRequest("decrypt", "ciphertext"), /断开/);
  owner.close();
  await disconnected;
  await assert.rejects(service.encryptionRequest("decrypt", "ciphertext"), /不可用/);
  assert.equal(requests.length, 2);
  assert.equal(service.encryptionPending.size, 0);
});

test("service status counts backend commands until their real operation settles", async (t) => {
  const { CoreBackend } = require("@areal/workbench-service/desktop/core/backend.cjs");
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const backend = {
    projects: new Map(),
    starting: new Map(),
    activeCommands: 0,
    lifecycleOperations: { assertRegistration() {}, attach() {} },
    analytics: { sample() {}, async flush() {} },
    providers: { redact: (value) => value },
    library: { value: { settings: {} } },
    hasWork: () => false,
    snapshot: () => ({ projects: [] }),
    addProjectPath: () => held,
  };
  const service = new DesktopService(backend, "fixture");
  t.after(() => service.close());
  const pending = CoreBackend.prototype.addProject.call(backend, "/fixture");
  assert.equal(service.packet().service.activeCommands, 1);
  release("done");
  assert.equal(await pending, "done");
  assert.equal(service.packet().service.activeCommands, 0);
});

test("service status excludes its own inspection while retaining other GUI blockers", async (t) => {
  const { SharedCoreBackend } = require("../app/src/core/service-client.cjs");
  const backend = {
    projects: new Map(),
    starting: new Map(),
    activeCommands: 0,
    connections: { revokeDesktopToolHost() {} },
    analytics: { sample() {}, async flush() {} },
    providers: { redact: (value) => value },
    library: { value: { settings: {} } },
    hasWork: () => false,
    refreshHostProjects: async () => {},
    snapshot: () => ({
      library: {
        projects: {},
        threads: {},
        projectOrder: [],
        sections: [],
        sidebarThreadOrder: [],
        sidebarRevision: 0,
        settings: {},
      },
      projects: [],
    }),
  };
  const service = new DesktopService(backend, "fixture");
  t.after(() => service.close());
  const owner = service.connectMain(
    () => {},
    () => {},
  );
  await owner.request("hello", { protocol: PROTOCOL, identity: "fixture", capabilities: {} });
  const client = {
    status: { connected: true },
    connection: owner,
    metadata: owner.metadata,
    requireConnection() {
      return this.connection;
    },
    resources: SharedCoreBackend.prototype.resources,
  };
  const status = () => SharedCoreBackend.prototype.serviceStatus.call(client);
  const idle = await status();
  assert.equal(idle.activeCommands, 0);
  assert.equal(idle.clients, 1);
  assert.equal(idle.canStop, true);
  const peer = service.connectMain(
    () => {},
    () => {},
  );
  await peer.request("hello", { protocol: PROTOCOL, identity: "fixture", capabilities: {} });
  assert.equal((await status()).canStop, false);
  peer.close();
  assert.equal((await status()).canStop, true);
});
