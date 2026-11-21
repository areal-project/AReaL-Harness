const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validateCommand } = require("../packages/workbench/client/desktop-contract.cjs");

test("桌面窄契约接受 Cloud 配置，拒绝无效操作及未声明字段", () => {
  validateCommand("cloud", { operation: "status" }, { serviceOnly: true });
  validateCommand("cloud", {
    operation: "save",
    baseURL: "https://backend.test",
    token: "secret",
  });
  assert.throws(() => validateCommand("cloud", { operation: "execute", shell: "command" }));
  assert.throws(() => validateCommand("cloud", { operation: "save", baseURL: 123 }));
});
