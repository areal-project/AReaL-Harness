"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  validateCommand,
  commandSemantics,
} = require("../packages/workbench/client/desktop-contract.cjs");
test("readiness is a read operation and validates exact installed identity", () => {
  const request = {
    projectId: "p",
    operation: "pluginReadiness",
    id: "fixture@local",
    expectedDigest: "snapshot",
  };
  assert.doesNotThrow(() => validateCommand("manage", request));
  assert.equal(commandSemantics("manage", request).effect, "read");
  for (const bad of [
    { ...request, id: "" },
    { ...request, expectedDigest: "" },
  ])
    assert.throws(() => validateCommand("manage", bad));
});
