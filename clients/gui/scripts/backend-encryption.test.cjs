const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DesktopService, PROTOCOL } = require("@areal/workbench-service/desktop/core/service-protocol.cjs");

test("安全存储回调绑定原外壳，其他客户端不能结算，断开后不重发", async (t) => {
  const service = new DesktopService({
    projects: new Map(), starting: new Map(),
    connections: { revokeDesktopToolHost() {} },
    analytics: { sample() {}, async flush() {} },
    providers: { redact: (value) => value },
    library: { value: { settings: {} } },
    hasWork: () => false, snapshot: () => ({ projects: [] }),
  }, "fixture");
  t.after(() => service.close());
  const requests = [];
  const owner = service.connectMain((message) => {
    if (message.method === "encryptionRequest") requests.push(message.params);
  }, () => {});
  const other = service.connectMain(() => {}, () => {});
  await owner.request("hello", { protocol: PROTOCOL, identity: "fixture", capabilities: { computerHost: 1 } });
  await other.request("hello", { protocol: PROTOCOL, identity: "fixture", capabilities: {} });
  const pending = service.encryptionRequest("encrypt", "test-only-secret");
  assert.equal(requests.length, 1);
  const { requestId } = requests[0];
  await assert.rejects(other.request("encryptionResult", { requestId, result: "forged" }), /安全存储回复/);
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
