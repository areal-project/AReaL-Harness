const { test } = require("node:test");
const assert = require("node:assert/strict");
const { backendURL, cloudServiceURL, CloudClient } = require("../app/src/core/cloud-client.cjs");
test("统一 endpoint 不含平台路由推断，HTTP(S) 可规范化为 WS(S)", () => {
  assert.equal(
    backendURL("https://example.test/app-server/work").href,
    "wss://example.test/app-server/work/",
  );
  assert.equal(backendURL("ws://localhost:4500").href, "ws://localhost:4500/");
  for (const url of [
    "file:///tmp/x",
    "https://user:secret@host/",
    "wss://host/?token=x",
    "wss://host/#x",
  ])
    assert.throws(() => backendURL(url));
  assert.throws(() => new CloudClient({ baseURL: "ws://localhost", token: "a\nb" }));
});

test("固定服务地址按当前 Session ID 派生 workspace，互不共用", () => {
  assert.equal(
    cloudServiceURL("https://example.test").href,
    "wss://example.test/openapi/v1/app-server/",
  );
  assert.throws(() => cloudServiceURL("https://example.test/openapi/v1/app-server/manual-test/"));
  const service = new CloudClient({
    baseURL: "https://example.test/openapi/v1/app-server/",
    token: "test",
  });
  assert.equal(
    service.forWorkspace("session-a").baseURL.href,
    "wss://example.test/openapi/v1/app-server/session-a/",
  );
  assert.notEqual(
    service.forWorkspace("session-a").baseURL.href,
    service.forWorkspace("session-b").baseURL.href,
  );
  assert.throws(() => service.forWorkspace("../bad"));
});
