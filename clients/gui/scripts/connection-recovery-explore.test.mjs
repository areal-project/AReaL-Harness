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

function loadingFailure() {
  const report = evidence();
  Object.assign(report, {
    status: "failed",
    firstFailure: {
      kind: "business",
      stage: "loadingWithoutFalseFailure",
      assertionId: "loading-no-false-failure",
      action: null,
      stepIndex: null,
    },
    facts: [
      {
        id: "loadingWithoutFalseFailure",
        status: "failed",
        evidence: ["loading-observation.json"],
      },
      { id: "boundedRecoveryExploration", status: "pending", evidence: [] },
    ],
    faults: {
      loadingWithoutFalseFailure: {
        injectionReached: true,
        requestId: "shell-request",
        connectionId: "socket",
        evidence: ["loading-observation.json"],
      },
    },
    artifacts: { "loading-observation.json": "b".repeat(64) },
  });
  report.exploration.steps = [];
  const observation = {
    held: {
      requestId: "shell-request",
      responseHit: "shell-request",
      errorCode: null,
      identity: { connectionId: "socket", gatewayGeneration: "host-generation" },
    },
    loading: { startupFailure: true, observedFailures: ["fixture startup error"] },
  };
  return { report, observation };
}

test("an observed initial-loading regression remains a business failure before exploration steps", () => {
  const { report, observation } = loadingFailure();
  assert.equal(validateExplorationAttempt(report, plan, 1, identity, observation), report);
});

test("a loading exception requires the exact fact, matched successful injection and observed failure", () => {
  for (const change of [
    ({ report }) => {
      report.firstFailure.stage = "prerequisites";
    },
    ({ report }) => {
      report.firstFailure.assertionId = "some-other-assertion";
    },
    ({ report }) => {
      report.firstFailure.action = "submit";
    },
    ({ report }) => {
      report.firstFailure.stepIndex = 0;
    },
    ({ report }) => {
      delete report.firstFailure.action;
    },
    ({ report }) => {
      report.exploration.steps = evidence().exploration.steps;
    },
    ({ report }) => {
      report.facts[0].status = "passed";
    },
    ({ report }) => {
      report.facts[1].status = "passed";
    },
    ({ report }) => {
      report.facts[0].evidence = [];
    },
    ({ report }) => {
      report.faults.loadingWithoutFalseFailure.injectionReached = false;
    },
    ({ report }) => {
      report.faults.loadingWithoutFalseFailure.evidence = [];
    },
    ({ report }) => {
      report.artifacts = {};
    },
    ({ observation }) => {
      observation.held.responseHit = "different-request";
    },
    ({ observation }) => {
      observation.held.identity.connectionId = "different-socket";
    },
    ({ observation }) => {
      observation.held.errorCode = "HOST_UNAVAILABLE";
    },
    ({ observation }) => {
      observation.loading = { startupFailure: false, observedFailures: [] };
    },
  ]) {
    const fixture = loadingFailure();
    change(fixture);
    assert.throws(() =>
      validateExplorationAttempt(fixture.report, plan, 1, identity, fixture.observation),
    );
  }
  assert.throws(() => validateExplorationAttempt(loadingFailure().report, plan, 1, identity));
});
