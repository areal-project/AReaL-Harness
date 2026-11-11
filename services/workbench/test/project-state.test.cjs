"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { isUnresolved, noteReconcileRead } = require("../src/desktop/core/project-state.cjs");
const { SubmissionRecovery } = require("../src/desktop/core/submission-recovery.cjs");

test("missing receipts never admit another mutation on the same thread", async () => {
  const entry = { method: "areal/turn/start", params: { requestId: "original", threadId: "t1" } };
  const snapshot = { version: 1, pending: [entry], outcomes: {} };
  const project = { id: "p1", pending: [entry], outcomes: {} };
  const missing = { confirmed: false, state: "unconfirmed" };
  noteReconcileRead(project, entry, missing);
  noteReconcileRead(project, entry, missing);
  const host = {
    awaitingResponses: new Set(),
    host: { journal: () => ({ change: async (change) => change(snapshot) }) },
    currentConnection: () => false,
    onChange() {},
  };
  const recovery = new SubmissionRecovery(host);
  let dispatched = false;
  await assert.rejects(
    recovery.submitRemote(
      project,
      "areal/turn/start",
      { threadId: "t1" },
      { method: "session.send", capability: "submit", semanticDigest: "new", target: {} },
      async () => {
        dispatched = true;
      },
    ),
    { code: "RESOURCE_BUSY" },
  );
  assert.equal(dispatched, false);
  assert.equal(project.pending[0].params.requestId, "original");
});

test("repeated missing receipts are marked for notice until a result arrives", () => {
  const project = {};
  const entry = { method: "turn/start", params: { requestId: "r1", threadId: "t1" } };
  const missing = { confirmed: false, state: "unconfirmed" };
  noteReconcileRead(project, entry, missing);
  assert.equal(isUnresolved(project, entry), false);
  // 回执存在但还在执行：不是“查不到”，计数清零。
  noteReconcileRead(project, entry, { confirmed: false, state: "running" });
  noteReconcileRead(project, entry, missing);
  assert.equal(isUnresolved(project, entry), false);
  noteReconcileRead(project, entry, missing);
  assert.equal(isUnresolved(project, entry), true);
  noteReconcileRead(project, entry, { confirmed: true });
  assert.equal(isUnresolved(project, entry), false);
});
