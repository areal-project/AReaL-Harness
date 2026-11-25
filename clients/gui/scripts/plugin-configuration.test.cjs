"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { validateCommand } = require("../packages/workbench/client/desktop-contract.cjs");
const requestId = "00000000-0000-4000-a000-000000000111";
const baseRequest = {
  projectId: "p",
  operation: "pluginUserConfigSave",
  id: "example@local",
  expectedRevision: 3,
  expectedDigest: "fixed",
  requestId,
  values: {},
  secrets: {},
};
test("browser writes reject private references and internal operations", () => {
  assert.throws(() =>
    validateCommand("manage", {
      ...baseRequest,
      values: { TOKEN: { kind: "secretRef", value: "stolen" } },
    }),
  );
  assert.throws(() =>
    validateCommand("manage", { ...baseRequest, operation: "pluginUserConfigSet" }),
  );
});
