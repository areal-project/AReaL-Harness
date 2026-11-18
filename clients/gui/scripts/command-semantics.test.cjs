"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const contract = require("../packages/workbench/client/desktop-contract.cjs");

test("command declarations distinguish mixed reads, subscriptions and recoverable writes", () => {
  for (const name of Object.keys(contract.commandDefinitions))
    assert.ok(contract.commandDefinitions[name][2], name);
  for (const [name, operation, effect] of [
    ["manage", "task", "read"],
    ["manage", "taskWatch", "subscription"],
    ["manage", "taskPause", "mutation"],
    ["manage", "pluginSubmission", "read"],
    ["side", "context", "read"],
    ["resources", "skillRead", "read"],
    ["providers", "revealKey", "read"],
    ["library", "readThread", "mutation"],
  ])
    assert.equal(
      contract.commandSemantics(name, { operation }).effect,
      effect,
      `${name}/${operation}`,
    );
  assert.equal(contract.commandSemantics("create", {}).requestId, "requestId");
  assert.equal(
    contract.commandSemantics("manage", { operation: "taskDraftStart" }).requestId,
    "draftId",
  );
  assert.throws(() => contract.commandSemantics("manage", { operation: "futureRead" }));
});
