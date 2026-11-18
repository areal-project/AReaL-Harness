"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  validateCommand,
  commandSemantics,
} = require("../packages/workbench/client/desktop-contract.cjs");
const {
  validateManagementResponse,
} = require("../packages/workbench/client/desktop-contract/management.cjs");
const snapshot = {
  revision: 0,
  scope: { kind: "user" },
  observedAt: 1,
  runtimeObserved: false,
  list: { revision: 0, data: [], marketplaces: [], errors: [] },
  detail: null,
};

test("offline requests allow a projectless read and reject caller supplied filesystem roots", () => {
  for (const operation of ["pluginStoreSnapshot", "pluginStoreDoctor"]) {
    const request = { operation };
    assert.doesNotThrow(() => validateCommand("manage", request));
    assert.equal(commandSemantics("manage", request).effect, "read");
    for (const field of ["configHome", "workspace", "root", "credentials"])
      assert.throws(() => validateCommand("manage", { ...request, [field]: "/untrusted" }));
  }
  assert.throws(() => validateCommand("manage", { operation: "plugins" }));
  // 直接添加的 MCP 是用户级插件：没有选中项目时也能读、存、删。
  for (const request of [
    { operation: "mcp" },
    {
      operation: "mcpSave",
      name: "docs",
      server: { url: "https://mcp.example.test" },
      expectedRevision: 0,
    },
    { operation: "mcpRemove", name: "docs", expectedRevision: 1 },
  ])
    assert.doesNotThrow(() => validateCommand("manage", request));
});
test("read failures and unobserved runtime cannot masquerade as an empty healthy result", () => {
  const request = { operation: "pluginStoreSnapshot" };
  assert.doesNotThrow(() => validateManagementResponse(request, snapshot));
  for (const bad of [
    { ...snapshot, runtimeObserved: true },
    { ...snapshot, list: {} },
    { ...snapshot, revision: -1 },
    { ...snapshot, observedAt: null },
    { ...snapshot, detail: {} },
  ])
    assert.throws(() => validateManagementResponse(request, bad));
});
