"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { isUnresolved, noteReconcileRead } = require("../src/desktop/core/project-state.cjs");

test("a submission stops blocking only after Core twice reports no receipt", () => {
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
