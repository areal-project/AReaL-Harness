"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { validateCommand } = require("../packages/workbench/client/desktop-contract.cjs");
const reference = {
  pluginId: "example@local",
  componentId: "commands/review.md",
  installedDigest: "fixed",
  arguments: "file with spaces.ts --strict",
};
const requestId = "00000000-0000-4000-a000-000000000111";
test("steering and queue edits reject plugin commands", () => {
  for (const name of ["steer", "queueEdit"])
    assert.throws(() =>
      validateCommand(name, {
        projectId: "p",
        threadId: "t",
        text: "message",
        command: reference,
        requestId,
      }),
    );
});
test("the browser boundary rejects malformed identity, unknown command fields, and oversized raw arguments", () => {
  for (const command of [
    { ...reference, installedDigest: "" },
    { ...reference, arguments: null },
    { ...reference, body: "injected template" },
    { ...reference, arguments: "字".repeat(22000) },
  ])
    assert.throws(() =>
      validateCommand("send", { projectId: "p", threadId: "t", command, requestId }),
    );
  assert.doesNotThrow(() =>
    validateCommand("send", { projectId: "p", threadId: "t", command: reference, requestId }),
  );
});
