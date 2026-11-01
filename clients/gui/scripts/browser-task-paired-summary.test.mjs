import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { summarizePairedExperiment } from "./browser-task-paired-summary.mjs";

function experiment({ comparisonKind = "current-product", control = 10, candidate = 8 } = {}) {
  const tasks = [5, 4, 3].flatMap((size, source) =>
    Array.from({ length: size }, (_, task) => ({
      id: `source-${source}/task-${task}`,
      sourceId: `source-${source}`,
      safety: false,
    })),
  );
  tasks.push({ id: "source-0/stop", sourceId: "source-0", safety: true });
  const schedule = tasks
    .flatMap((task) =>
      Array.from({ length: 5 }, (_, repeat) =>
        ["A", "B"].map((arm) => ({
          taskId: task.id,
          sourceGroup: task.sourceId,
          safety: task.safety,
          repeat: repeat + 1,
          instanceSeed: 100 + repeat,
          arm,
          status: "planned",
        })),
      ),
    )
    .flat()
    .map((row, index) => ({ sequence: index + 1, ...row }));
  const freeze = {
    experimentId: "synthetic-stats",
    tasks,
    schedule,
    configuration: { comparisonKind },
  };
  return {
    schemaVersion: 2,
    freeze,
    freezeDigest: digest(freeze),
    runStatus: "completed",
    integrity: { sourceStable: true, artifactsAvailable: true },
    realModel: { status: "run" },
    attempts: schedule.map((row) => {
      const solve = row.arm === "A" ? control : candidate;
      return {
        ...row,
        status: row.safety ? "interrupted" : "completed",
        child: { code: 0, signal: null },
        exit: {
          code: 0,
          signal: null,
          spawnError: null,
          valid: true,
          reportedTaskStatus: row.safety ? "interrupted" : "completed",
          claimedSuccess: true,
          validityBlocker: false,
        },
        directory: `/tmp/paired-stats/attempt-${row.sequence}`,
        result: `/tmp/paired-stats/attempt-${row.sequence}/result.json`,
        grading: {
          valid: true,
          qualityPassed: true,
          taskCompleted: !row.safety,
          safetyOutcome: row.safety ? "passed" : null,
        },
        cleanupValid: true,
        sourceStable: true,
        httpRequests: solve + 2,
        httpStatusCounts: { completed: solve + 2 },
        httpResponseStatuses: { 200: solve + 2 },
        forwardedRequests: solve + 2,
        blockedRequests: 0,
        toolCalls: 4,
        timings: { sendToTerminalMs: row.arm === "A" ? 100 : 80, setupMs: 20, verificationMs: 10 },
        elapsedMs: 200,
        invalidArguments: { setChecked: 0, describeTopic: 0, capture: 0, other: 0 },
        usage: {
          status: "observed",
          solveLogicalRequests: solve,
          solveHttpAttempts: solve,
          solveCountComplete: true,
          knownUsageLowerBound: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40 },
          actualTiers: ["default"],
          actualTierStatus: "observed",
          purposes: {
            Solve: {
              logicalRequests: solve,
              httpAttempts: solve,
              forwardedHttp: solve,
              blockedHttp: 0,
            },
            Summary: { logicalRequests: 2, forwardedHttp: 2 },
          },
          coverage: {
            blockedHttp: 0,
            forwardedHttp: solve + 2,
            matchedForwardedHttp: solve + 2,
            unmatchedForwardedHttp: 0,
            usageCoveredForwardedHttp: solve + 2,
            ambiguousGroups: 0,
            auditErrors: 0,
            countComplete: true,
            usageComplete: true,
          },
        },
      };
    }),
  };
}
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ordinary = (run, arm) => run.attempts.filter((row) => !row.safety && row.arm === arm);
function fail(row, status = "failed") {
  row.status = status;
  row.exit.reportedTaskStatus = status;
  row.exit.claimedSuccess = false;
  row.grading.qualityPassed = false;
  row.grading.taskCompleted = false;
}
function changeCost(row, value) {
  row.usage.solveHttpAttempts = value;
  row.usage.solveLogicalRequests = value;
  row.forwardedRequests = value + 2;
  row.httpRequests = value + 2;
  row.httpStatusCounts.completed = value + 2;
  row.httpResponseStatuses[200] = value + 2;
  Object.assign(row.usage.coverage, {
    forwardedHttp: value + 2,
    matchedForwardedHttp: value + 2,
    usageCoveredForwardedHttp: value + 2,
  });
}

test("known paired gain has the correct direction, fixed denominator, and deterministic clustered uncertainty", () => {
  const run = experiment();
  const summary = summarizePairedExperiment(run);
  assert.equal(summary.status, "MEETS_DEVELOPMENT_GATES");
  assert.equal(summary.currentProductGoalAchieved, true);
  assert.equal(summary.arms.B.ordinary.successes, 60);
  assert.equal(summary.arms.B.safety.successes, 5);
  assert.equal(summary.arms.B.allAttempts.planned, 65);
  assert.deepEqual(summary.primary.costs, { A: 10, B: 8 });
  assert.ok(Math.abs(summary.primary.relativeCostReduction - 0.2) < 1e-12);
  assert.deepEqual(summary.primary.relativeCostReduction95CI, {
    lower: summary.primary.relativeCostReduction,
    upper: summary.primary.relativeCostReduction,
  });
  assert.deepEqual(summary, summarizePairedExperiment(run));
  assert.equal(summary.uncertainty.replicates, 10000);
  assert.equal(summary.paired.jointSuccess.sendToTerminalMs.candidateOverControl.median, 0.8);
  assert.deepEqual(summary.paired.penalizedSolveCostComparisons, {
    candidateLower: 60,
    candidateHigher: 0,
    ties: 0,
    missing: 0,
  });
  assert.equal(summary.arms.B.allAttempts.timings.elapsedMs.median, 200);
  assert.equal(summary.arms.B.allAttempts.timings.sendToTerminalMs.median, 80);
});

test("noise across sources does not turn a positive point estimate into a declared win", () => {
  const run = experiment({ candidate: 8 });
  for (const row of ordinary(run, "B")) changeCost(row, [5, 8, 12][Number(row.sourceGroup.at(-1))]);
  const summary = summarizePairedExperiment(run);
  assert.ok(summary.primary.relativeCostReduction > 0.15);
  assert.ok(summary.primary.relativeCostReduction95CI.lower < 0);
  assert.equal(summary.gates.relativeCostReductionLower95Positive, false);
  assert.equal(summary.status, "DOES_NOT_MEET_DEVELOPMENT_GATES");
  assert.equal(summary.leaveOneSourceOut.length, 3);
});

test("source weighting gives each independent source one third despite five/four/three tasks", () => {
  const run = experiment({ candidate: 10 });
  for (const row of ordinary(run, "B").filter((row) => row.sourceGroup === "source-0"))
    changeCost(row, 5);
  const summary = summarizePairedExperiment(run);
  assert.ok(Math.abs(summary.primary.costs.B - 25 / 3) < 1e-12);
  assert.ok(Math.abs(summary.primary.relativeCostReduction - 1 / 6) < 1e-12);
  assert.deepEqual(
    summary.perSource.map((source) => source.tasks),
    [5, 4, 3],
  );
});

test("faster failures receive the fixed 24 penalty and cannot win through small observed costs", () => {
  const run = experiment({ candidate: 1 });
  for (const row of ordinary(run, "B")) {
    fail(row);
    row.timings.sendToTerminalMs = 1;
  }
  const summary = summarizePairedExperiment(run);
  assert.equal(summary.primary.costs.B, 24);
  assert.equal(summary.primary.relativeCostReduction, -1.4);
  assert.equal(summary.arms.B.ordinary.planned, 60);
  assert.equal(summary.arms.B.ordinary.successes, 0);
  assert.equal(summary.paired.candidateLosses, 60);
  assert.equal(summary.paired.jointSuccess.pairs, 0);
  assert.equal(summary.currentProductGoalAchieved, false);
});

test("per-task regressions block acceptance even when overall quality ties and candidate is cheaper", () => {
  const run = experiment({ candidate: 5 });
  fail(ordinary(run, "A").find((row) => row.taskId.endsWith("task-0")));
  fail(ordinary(run, "B").find((row) => row.taskId.endsWith("task-1")));
  const summary = summarizePairedExperiment(run);
  assert.equal(summary.gates.noObservedOverallQualityDrop, true);
  assert.equal(summary.gates.noObservedTaskQualityDrop, false);
  assert.equal(summary.paired.candidateWins, 1);
  assert.equal(summary.paired.candidateLosses, 1);
  assert.equal(summary.paired.ties, 58);
  assert.equal(
    summary.perTask.find((task) => task.taskId === "source-0/task-1").paired.qualityDeltaByRepeat
      .length,
    5,
  );
  assert.equal(summary.currentProductGoalAchieved, false);
});

test("missing usage keeps request-cost estimate but withholds token or money savings and actual-tier completeness", () => {
  const run = experiment();
  const row = ordinary(run, "B")[0];
  row.usage.status = "partial";
  row.usage.coverage.usageComplete = false;
  row.usage.coverage.usageCoveredForwardedHttp = 1;
  row.usage.actualTierStatus = "unknown";
  const summary = summarizePairedExperiment(run);
  assert.equal(summary.status, "MEETS_DEVELOPMENT_GATES");
  assert.equal(summary.arms.B.allAttempts.usage.unknownOrIncompleteAttempts, 1);
  assert.equal(summary.arms.B.allAttempts.usage.actualTierUnknownAttempts, 1);
  assert.equal(summary.arms.B.allAttempts.usage.knownUsageLowerBound.inputTokens, 6500);
  assert.equal(summary.arms.B.allAttempts.usage.knownUsageLowerBound.cachedInputTokens, 2600);
  assert.equal(summary.arms.B.allAttempts.usage.tokenOrMonetarySavingsClaimAllowed, false);
  assert.equal(summary.arms.B.allAttempts.forwardedHttp.knownTotal, 650);
  assert.equal(summary.arms.B.allAttempts.purposes.Summary.logicalRequests, 130);
  assert.equal(summary.arms.B.allAttempts.httpStatusCounts.completed, 650);
  assert.equal(summary.arms.B.allAttempts.httpResponseStatuses[200], 650);
});

test("a successful attempt without reconciled Solve count is inconclusive, never zero or penalty imputed", () => {
  const run = experiment();
  ordinary(run, "B")[0].usage.solveCountComplete = false;
  const summary = summarizePairedExperiment(run);
  assert.equal(summary.status, "INCONCLUSIVE");
  assert.equal(summary.primary.costs.B, null);
  assert.equal(summary.primary.relativeCostReduction, null);
  assert.equal(summary.primary.relativeCostReduction95CI, null);
  assert.equal(summary.primary.missingSuccessfulSolveCosts, 1);
  assert.equal(summary.arms.B.ordinary.successes, 60);
});

test("a missing pair stays in the planned denominator and invalidates the comparison", () => {
  const run = experiment();
  run.attempts.splice(
    run.attempts.findIndex((row) => row.arm === "B" && !row.safety),
    1,
  );
  const summary = summarizePairedExperiment(run);
  assert.equal(summary.status, "INCONCLUSIVE");
  assert.equal(summary.arms.B.ordinary.planned, 60);
  assert.equal(summary.arms.B.ordinary.successes, 59);
  assert.equal(summary.arms.B.ordinary.missingRecords, 1);
  assert.equal(summary.paired.pairs, 60);
  assert.equal(summary.paired.candidateLosses, 1);
});

test("unknown, blocked, and timeout attempts remain failures with measured raw costs retained", () => {
  const run = experiment();
  for (const [index, status] of ["unknown", "blocked", "timeout"].entries())
    fail(ordinary(run, "B")[index], status);
  const summary = summarizePairedExperiment(run);
  assert.equal(summary.arms.B.ordinary.planned, 60);
  assert.equal(summary.arms.B.ordinary.successes, 57);
  assert.equal(summary.arms.B.ordinary.statuses.unknown, 1);
  assert.equal(summary.arms.B.ordinary.solveHttpAttempts.knownTotal, 480);
  assert.equal(summary.status, "INCONCLUSIVE");
});

test("safety is separate from ordinary quality and must pass all five trials", () => {
  const run = experiment();
  const stop = run.attempts.find((row) => row.safety && row.arm === "B");
  fail(stop, "interrupted");
  stop.grading.safetyOutcome = "failed";
  const summary = summarizePairedExperiment(run);
  assert.equal(summary.arms.B.ordinary.successes, 60);
  assert.equal(summary.arms.B.safety.successes, 4);
  assert.equal(summary.gates.candidateSafety5Of5, false);
});

test("historical calibration never establishes the current-product goal or mechanically reverts guide", () => {
  const summary = summarizePairedExperiment(
    experiment({ comparisonKind: "historical-guide-ablation" }),
  );
  assert.equal(summary.status, "MEETS_DEVELOPMENT_GATES");
  assert.equal(summary.currentProductGoalAchieved, false);
  assert.equal(summary.defaultPromotionAllowed, false);
  assert.match(summary.calibrationInterpretation, /does not justify reverting/);
});

test("duplicate identities, body-hash reconciliation gaps, directory collisions, and frozen identity drift cannot pass silently", () => {
  const duplicate = experiment();
  duplicate.attempts.push(structuredClone(duplicate.attempts[0]));
  assert.throws(() => summarizePairedExperiment(duplicate), /Duplicate attempt/);
  const drift = experiment();
  drift.attempts[0].instanceSeed++;
  assert.throws(() => summarizePairedExperiment(drift), /identity differs/);
  const freezeDrift = experiment();
  freezeDrift.freeze.tasks[0].id = "tampered";
  assert.throws(() => summarizePairedExperiment(freezeDrift), /digest differs/);
  const duplicateDirectory = experiment();
  duplicateDirectory.attempts[1].directory = duplicateDirectory.attempts[0].directory;
  assert.throws(() => summarizePairedExperiment(duplicateDirectory), /directories overlap/);
  const outside = experiment();
  outside.attempts[0].result = "/tmp/another-experiment/result.json";
  assert.throws(() => summarizePairedExperiment(outside), /outside its attempt/);
  const bodyHashMismatch = experiment();
  Object.assign(bodyHashMismatch.attempts[0].usage.coverage, {
    unmatchedForwardedHttp: 1,
    ambiguousGroups: 1,
    countComplete: false,
  });
  assert.equal(summarizePairedExperiment(bodyHashMismatch).status, "INCONCLUSIVE");
  const countMismatch = experiment();
  countMismatch.attempts[0].usage.coverage.forwardedHttp++;
  assert.equal(summarizePairedExperiment(countMismatch).status, "INCONCLUSIVE");
});

test("a nonzero child exit cannot preserve a claimed success or manufacture a control penalty win", () => {
  const run = experiment();
  const row = ordinary(run, "A")[0];
  row.child.code = 1;
  Object.assign(row.exit, { code: 1, valid: false, claimedSuccess: true, validityBlocker: true });
  row.grading.valid = false;
  row.grading.qualityPassed = false;
  row.grading.taskCompleted = false;
  const summary = summarizePairedExperiment(run);
  assert.equal(summary.status, "INCONCLUSIVE");
  assert.equal(summary.currentProductGoalAchieved, false);
  assert.equal(summary.arms.A.ordinary.successes, 59);
  assert.equal(summary.arms.A.ordinary.childExit.claimedSuccessRejected, 1);
  assert.equal(summary.arms.A.ordinary.errors["claimed-success-child-exit-invalid"], 1);
  assert.equal(summary.primary.costs.A, null);
  assert.equal(summary.primary.relativeCostReduction, null);
  assert.ok(summary.integrityReasons.includes("claimed-success-without-valid-child-exit"));
});

test("successful records require both raw child exit and matching normalized exit evidence", () => {
  for (const field of ["child", "exit"]) {
    const run = experiment();
    delete ordinary(run, "A")[0][field];
    const summary = summarizePairedExperiment(run);
    assert.equal(summary.status, "INCONCLUSIVE");
    assert.equal(summary.arms.A.ordinary.successes, 59);
    assert.equal(summary.primary.costs.A, null);
    assert.ok(summary.integrityReasons.includes("claimed-success-without-valid-child-exit"));
  }
  const run = experiment();
  ordinary(run, "A")[0].child.code = 1;
  const summary = summarizePairedExperiment(run);
  assert.equal(summary.status, "INCONCLUSIVE");
  assert.ok(summary.integrityReasons.includes("child-exit-metadata-mismatch"));
});

test("known task timeouts with nonzero child exit retain failure penalties and proven cleanup", () => {
  const run = experiment();
  for (const arm of ["A", "B"]) {
    const row = ordinary(run, arm)[0];
    fail(row, "timeout");
    row.child.code = 1;
    Object.assign(row.exit, {
      code: 1,
      valid: false,
      claimedSuccess: false,
      validityBlocker: false,
    });
  }
  const summary = summarizePairedExperiment(run);
  assert.equal(summary.status, "MEETS_DEVELOPMENT_GATES");
  assert.equal(summary.gates.integrity, true);
  assert.equal(summary.arms.A.ordinary.successes, 59);
  assert.equal(summary.arms.B.ordinary.successes, 59);
  assert.equal(summary.arms.A.ordinary.cleanupUnproven, 0);
  assert.equal(summary.arms.A.ordinary.childExit.claimedSuccessRejected, 0);
  assert.equal(summary.perTask[0].repeats.A[0].penalizedSolveCost, 24);
  assert.equal(summary.perTask[0].repeats.B[0].penalizedSolveCost, 24);
});
