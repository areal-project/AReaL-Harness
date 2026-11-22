import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { validateExplorationAttempt } from "./connection-recovery-explore.mjs";

const plan = { schemaVersion: 1, seed: 7, actions: [{ op: "submit" }] };
const digest = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
const identity = { sourceRevision: "fixture", inputHash: "frozen" };
function evidence() {
  return {
    journeyId: "connection-recovery-exploration",
    identity,
    status: "passed",
    firstFailure: null,
    cleanup: { status: "passed" },
    exploration: {
      planSha256: digest,
      initial: { projectId: "project", connectionId: "socket", threadId: null },
      steps: [{ index: 0, op: "submit", status: "passed", evidence: ["step-0.json"] }],
    },
    artifacts: { "step-0.json": "a".repeat(64) },
    facts: [
      { id: "loadingWithoutFalseFailure", status: "passed" },
      { id: "boundedRecoveryExploration", status: "passed" },
    ],
  };
}
test("a fabricated green run cannot omit the planned submission", () => {
  const report = evidence();
  report.exploration.steps = [];
  assert.throws(() => validateExplorationAttempt(report, plan, 0, identity), /steps/);
});
test("replay rejects a different plan or stale build identity", () => {
  const report = evidence();
  report.exploration.planSha256 = "different";
  assert.throws(() => validateExplorationAttempt(report, plan, 0, identity), /plan/);
  assert.throws(
    () => validateExplorationAttempt(evidence(), plan, 0, { inputHash: "other" }),
    /identity/,
  );
});
test("a passed step needs an imported artifact and the exact ordered action", () => {
  const report = evidence();
  report.artifacts = {};
  assert.throws(() => validateExplorationAttempt(report, plan, 0, identity), /evidence/);
  report.artifacts = evidence().artifacts;
  report.exploration.steps[0].op = "reconnect";
  assert.throws(() => validateExplorationAttempt(report, plan, 0, identity), /action/);
});
test("cleanup or failure cannot be hidden behind a zero exit code", () => {
  const report = evidence();
  report.cleanup.status = "failed";
  assert.throws(() => validateExplorationAttempt(report, plan, 0, identity), /cleanup/);
  const failed = evidence();
  failed.firstFailure = { kind: "business", assertionId: "duplicate-send" };
  assert.throws(() => validateExplorationAttempt(failed, plan, 0, identity), /failure/);
});
test("a valid complete imported report is accepted", () => {
  assert.doesNotThrow(() => validateExplorationAttempt(evidence(), plan, 0, identity));
});
