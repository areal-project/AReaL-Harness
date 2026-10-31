"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ScheduledOwnerActivation } = require("../app/src/core/schedule-owner-activation.cjs");

const backend = (start) => {
  const owner = { id: "owner", root: "/owner" };
  let changes = 0;
  return {
    changes: () => changes,
    value: {
      saved: [owner],
      closing: false,
      onChange: () => changes++,
      lifecycleOperations: { schedulingSuppressed: () => false, assertProject: () => {} },
      worktrees: { assertAvailable: () => {} },
      ownerTasks: { preview: async () => ({ data: [{ enabled: true }] }) },
      providers: { redact: (text) => text },
      start,
    },
  };
};

test("a failed owner activation is reported and retried instead of tried once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0;
  const host = backend(async () => {
    attempts++;
    if (attempts === 1) throw new Error("port in use");
  });
  const activation = new ScheduledOwnerActivation(host.value);
  await activation.start();
  assert.equal(activation.error("owner"), "port in use");
  assert.equal(host.changes(), 1);
  t.mock.timers.tick(5000);
  await activation.pending;
  assert.equal(attempts, 2);
  assert.equal(activation.error("owner"), null);
  assert.equal(host.changes(), 2);
  activation.stop();
});
