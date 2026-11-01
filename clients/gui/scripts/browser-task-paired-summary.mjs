import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { distribution } from "./browser-benchmark-summary.mjs";

const ARMS = ["A", "B"];
const SEED = "browser-hillclimb-v2-stats-20261031";
const REPLICATES = 10000;
const PENALTY = 24;
const statuses = new Set([
  "planned",
  "running",
  "unknown",
  "completed",
  "interrupted",
  "failed",
  "blocked",
  "timeout",
  "crashed",
  "cancelled",
  "error",
]);
const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const count = (value) => Number.isInteger(value) && value >= 0;
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const key = ({ taskId, repeat, arm }) => JSON.stringify([taskId, repeat, arm]);
const identity = ({ sequence, taskId, sourceGroup, repeat, instanceSeed, safety, arm }) => ({
  sequence,
  taskId,
  sourceGroup,
  repeat,
  instanceSeed,
  safety,
  arm,
});
const percentile = (sorted, fraction) =>
  sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
const interval = (values) => {
  if (!values.length || values.some((value) => !Number.isFinite(value))) return null;
  const sorted = values.toSorted((a, b) => a - b);
  return { lower: percentile(sorted, 0.025), upper: percentile(sorted, 0.975) };
};

function randomSource(seed) {
  let state = createHash("sha256").update(seed).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// 冻结计划拥有分母；缺回执保留为未运行，不能从结果文件反推样本集合。
function normalize(manifest) {
  assert.equal(manifest.schemaVersion, 2, "Expected paired manifest schema 2");
  const freeze = manifest.freeze;
  assert.ok(
    freeze && Array.isArray(freeze.tasks) && Array.isArray(freeze.schedule),
    "Missing frozen plan",
  );
  assert.equal(
    manifest.freezeDigest,
    createHash("sha256").update(JSON.stringify(freeze)).digest("hex"),
    "Frozen plan digest differs",
  );
  assert.equal(freeze.tasks.length, 13, "Expected 12 ordinary tasks and one safety task");
  const tasks = new Map(freeze.tasks.map((task) => [task.id, task]));
  assert.equal(tasks.size, freeze.tasks.length, "Duplicate frozen task");
  assert.equal(
    freeze.tasks.filter((task) => task.safety === true).length,
    1,
    "Expected one safety task",
  );
  const sources = [
    ...new Set(freeze.tasks.filter((task) => !task.safety).map((task) => task.sourceId)),
  ].sort();
  assert.equal(sources.length, 3, "Expected three independent source groups");
  assert.ok(
    sources.every((source) => typeof source === "string" && source.length),
    "Missing source identity",
  );
  assert.equal(freeze.schedule.length, 130, "Expected 130 planned attempts");
  const planned = new Map();
  const sequences = new Set();
  for (const row of freeze.schedule) {
    const task = tasks.get(row.taskId);
    assert.ok(task, "Scheduled task is outside frozen catalog");
    assert.equal(row.sourceGroup, task.sourceId, "Scheduled source differs");
    assert.equal(row.safety, task.safety === true, "Scheduled task kind differs");
    assert.ok(
      ARMS.includes(row.arm) && Number.isInteger(row.repeat) && row.repeat >= 1 && row.repeat <= 5,
      "Invalid arm/repeat",
    );
    assert.ok(
      Number.isInteger(row.sequence) &&
        row.sequence >= 1 &&
        row.sequence <= 130 &&
        !sequences.has(row.sequence),
      "Invalid or duplicate sequence",
    );
    assert.ok(!planned.has(key(row)), "Duplicate scheduled pair identity");
    planned.set(key(row), row);
    sequences.add(row.sequence);
  }
  for (const task of tasks.values())
    for (const arm of ARMS)
      for (let repeat = 1; repeat <= 5; repeat++)
        assert.ok(planned.has(key({ taskId: task.id, arm, repeat })), "Missing frozen pair");
  assert.ok(Array.isArray(manifest.attempts), "Missing attempt records");
  const actual = new Map();
  const directories = new Set();
  for (const attempt of manifest.attempts) {
    const id = key(attempt);
    assert.ok(planned.has(id), "Attempt is outside frozen schedule");
    assert.ok(!actual.has(id), "Duplicate attempt identity");
    assert.deepEqual(
      identity(attempt),
      identity(planned.get(id)),
      "Attempt identity differs from freeze",
    );
    assert.ok(statuses.has(attempt.status), "Unknown attempt status");
    if (attempt.directory !== undefined) {
      assert.ok(isAbsolute(attempt.directory), "Attempt directory must be absolute");
      const directory = resolve(attempt.directory);
      assert.ok(
        [...directories].every(
          (existing) =>
            existing !== directory &&
            !existing.startsWith(`${directory}${sep}`) &&
            !directory.startsWith(`${existing}${sep}`),
        ),
        "Attempt output directories overlap",
      );
      directories.add(directory);
      if (attempt.result)
        assert.equal(
          dirname(resolve(attempt.result)),
          directory,
          "Result is outside its attempt directory",
        );
    }
    actual.set(id, attempt);
  }
  return {
    freeze,
    sources,
    tasks,
    rows: freeze.schedule.map((row) => ({
      ...row,
      ...(actual.get(key(row)) ?? { status: "planned", missingRecord: true }),
    })),
  };
}

const gradingClaimsSuccess = (row) =>
  row.grading?.qualityPassed === true ||
  row.grading?.taskCompleted === true ||
  row.grading?.safetyOutcome === "passed";
const exitMetadataAligned = (row) =>
  row.child &&
  row.exit &&
  row.exit.code === (row.child.code ?? null) &&
  row.exit.signal === (row.child.signal ?? null) &&
  row.exit.spawnError === (row.child.spawnError ?? null) &&
  row.exit.valid === (row.child.code === 0 && !row.child.signal && !row.child.spawnError) &&
  row.exit.reportedTaskStatus === row.status &&
  typeof row.exit.claimedSuccess === "boolean" &&
  row.exit.validityBlocker === (row.exit.claimedSuccess && !row.exit.valid);
const normalExitProven = (row) =>
  exitMetadataAligned(row) &&
  row.exit.valid === true &&
  row.child.code === 0 &&
  !row.child.signal &&
  !row.child.spawnError;
const claimedSuccessRejected = (row) =>
  row.exit?.validityBlocker === true ||
  ((gradingClaimsSuccess(row) || row.exit?.claimedSuccess === true) &&
    (!normalExitProven(row) || row.exit.claimedSuccess !== true));
const successful = (row) =>
  !claimedSuccessRejected(row) &&
  normalExitProven(row) &&
  row.grading?.valid === true &&
  row.grading?.qualityPassed === true &&
  (row.safety
    ? row.grading.safetyOutcome === "passed" && row.status === "interrupted"
    : row.grading.taskCompleted === true && row.status === "completed");
const httpReconciled = (row) =>
  row.usage?.coverage?.countComplete === true &&
  count(row.forwardedRequests) &&
  row.forwardedRequests <= PENALTY &&
  count(row.blockedRequests) &&
  row.httpRequests === row.forwardedRequests + row.blockedRequests &&
  row.usage.coverage.blockedHttp === row.blockedRequests &&
  row.usage.coverage.forwardedHttp === row.forwardedRequests &&
  row.usage.coverage.matchedForwardedHttp === row.forwardedRequests &&
  row.usage.coverage.unmatchedForwardedHttp === 0 &&
  row.usage.coverage.ambiguousGroups === 0 &&
  row.usage.coverage.auditErrors === 0;
const solveKnown = (row) =>
  row.usage?.solveCountComplete === true &&
  httpReconciled(row) &&
  count(row.usage?.solveHttpAttempts) &&
  row.usage.solveHttpAttempts <= PENALTY;
const cost = (row) =>
  claimedSuccessRejected(row)
    ? null
    : successful(row)
      ? solveKnown(row)
        ? row.usage.solveHttpAttempts
        : null
      : PENALTY;

function summarizeRows(rows) {
  const statusCounts = {};
  const errors = {};
  const knownUsageLowerBound = {};
  const purposes = {};
  const httpStatusCounts = {};
  const httpResponseStatuses = {};
  const invalidArguments = { setChecked: 0, describeTopic: 0, capture: 0, other: 0 };
  for (const row of rows) {
    statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
    if (!successful(row)) {
      const reason = claimedSuccessRejected(row)
        ? "claimed-success-child-exit-invalid"
        : (row.grading?.unknownReason ?? row.reason ?? row.status);
      errors[reason] = (errors[reason] ?? 0) + 1;
    }
    for (const [target, values] of [
      [httpStatusCounts, row.httpStatusCounts],
      [httpResponseStatuses, row.httpResponseStatuses],
    ])
      for (const [status, value] of Object.entries(values ?? {}))
        if (count(value)) target[status] = (target[status] ?? 0) + value;
    for (const [field, value] of Object.entries(row.usage?.knownUsageLowerBound ?? {}))
      if (finite(value)) knownUsageLowerBound[field] = (knownUsageLowerBound[field] ?? 0) + value;
    for (const [purpose, metrics] of Object.entries(row.usage?.purposes ?? {})) {
      purposes[purpose] ??= {};
      for (const [field, value] of Object.entries(metrics))
        if (count(value)) purposes[purpose][field] = (purposes[purpose][field] ?? 0) + value;
    }
    for (const field of Object.keys(invalidArguments))
      if (count(row.invalidArguments?.[field]))
        invalidArguments[field] += row.invalidArguments[field];
  }
  const observedCount = (extract) => ({
    knownTotal: rows.reduce((sum, row) => sum + (count(extract(row)) ? extract(row) : 0), 0),
    missingAttempts: rows.filter((row) => !count(extract(row))).length,
  });
  const usageComplete = (row) =>
    row.usage?.coverage?.usageComplete === true &&
    solveKnown(row) &&
    row.usage.coverage.usageCoveredForwardedHttp === row.forwardedRequests &&
    row.usage.status === "observed";
  return {
    planned: rows.length,
    successes: rows.filter(successful).length,
    quality: rows.filter(successful).length / rows.length,
    statuses: statusCounts,
    errors,
    missingRecords: rows.filter((row) => row.missingRecord).length,
    childExit: {
      normalExitProven: rows.filter(normalExitProven).length,
      claimedSuccessRejected: rows.filter(claimedSuccessRejected).length,
      metadataMismatches: rows.filter((row) => row.child && row.exit && !exitMetadataAligned(row))
        .length,
    },
    cleanupUnproven: rows.filter((row) => row.cleanupValid !== true).length,
    sourceIdentityUnproven: rows.filter((row) => row.sourceStable !== true).length,
    solveLogicalRequests: observedCount((row) => row.usage?.solveLogicalRequests),
    solveHttpAttempts: observedCount((row) => row.usage?.solveHttpAttempts),
    forwardedHttp: observedCount((row) => row.forwardedRequests),
    blockedHttp: observedCount((row) => row.blockedRequests),
    toolCalls: observedCount((row) => row.toolCalls),
    purposes,
    httpStatusCounts,
    httpResponseStatuses,
    httpStatusUnknownAttempts: rows.filter(
      (row) => !row.httpStatusCounts || !row.httpResponseStatuses,
    ).length,
    invalidArguments,
    usage: {
      completeAttempts: rows.filter(usageComplete).length,
      partialAttempts: rows.filter((row) => row.usage?.status === "partial").length,
      unknownOrIncompleteAttempts: rows.filter((row) => !usageComplete(row)).length,
      knownUsageLowerBound,
      cachedInputIsIncludedInInput: true,
      tokenOrMonetarySavingsClaimAllowed: false,
      actualTiers: [...new Set(rows.flatMap((row) => row.usage?.actualTiers ?? []))].sort(),
      actualTierUnknownAttempts: rows.filter(
        (row) => row.usage?.actualTierStatus !== "observed" || !usageComplete(row),
      ).length,
      scope:
        "All attempts including auxiliary/recovery requests; known lower bounds are not complete billing totals; cached input is not added to input.",
    },
    timings: Object.fromEntries(
      ["sendToTerminalMs", "setupMs", "verificationMs", "elapsedMs"].map((field) => [
        field,
        {
          ...distribution(
            rows.map((row) => (field === "elapsedMs" ? row.elapsedMs : row.timings?.[field])),
          ),
          missingAttempts: rows.filter(
            (row) => !finite(field === "elapsedMs" ? row.elapsedMs : row.timings?.[field]),
          ).length,
        },
      ]),
    ),
  };
}

function pairedDistribution(rows) {
  const pairs = new Map();
  for (const row of rows) {
    const id = JSON.stringify([row.taskId, row.repeat]);
    if (!pairs.has(id)) pairs.set(id, {});
    pairs.get(id)[row.arm] = row;
  }
  const entries = [...pairs.values()].sort(
    (left, right) => left.A.repeat - right.A.repeat || left.A.taskId.localeCompare(right.A.taskId),
  );
  const joint = entries.filter(({ A, B }) => successful(A) && successful(B));
  const ratio = (extract) => {
    const values = joint
      .filter(({ A, B }) => finite(extract(A)) && finite(extract(B)) && extract(A) > 0)
      .map(({ A, B }) => extract(B) / extract(A));
    return { candidateOverControl: distribution(values), pairs: values.length };
  };
  return {
    pairs: entries.length,
    candidateWins: entries.filter(({ A, B }) => successful(B) && !successful(A)).length,
    candidateLosses: entries.filter(({ A, B }) => successful(A) && !successful(B)).length,
    ties: entries.filter(({ A, B }) => successful(A) === successful(B)).length,
    penalizedSolveCostComparisons: {
      candidateLower: entries.filter(
        ({ A, B }) => cost(A) !== null && cost(B) !== null && cost(B) < cost(A),
      ).length,
      candidateHigher: entries.filter(
        ({ A, B }) => cost(A) !== null && cost(B) !== null && cost(B) > cost(A),
      ).length,
      ties: entries.filter(
        ({ A, B }) => cost(A) !== null && cost(B) !== null && cost(B) === cost(A),
      ).length,
      missing: entries.filter(({ A, B }) => cost(A) === null || cost(B) === null).length,
    },
    qualityDeltaByRepeat: entries.map(({ A, B }) => ({
      taskId: A.taskId,
      sourceGroup: A.sourceGroup,
      repeat: A.repeat,
      control: Number(successful(A)),
      candidate: Number(successful(B)),
    })),
    jointSuccess: {
      pairs: joint.length,
      scope: "Conditional on both arms succeeding; not the primary efficiency estimate.",
      solveHttp: ratio((row) => (solveKnown(row) ? row.usage.solveHttpAttempts : null)),
      sendToTerminalMs: ratio((row) => row.timings?.sendToTerminalMs),
    },
  };
}

export function summarizePairedExperiment(manifest) {
  const { freeze, sources, tasks, rows } = normalize(manifest);
  const ordinary = rows.filter((row) => !row.safety);
  const arms = Object.fromEntries(
    ARMS.map((arm) => [
      arm,
      {
        ordinary: summarizeRows(ordinary.filter((row) => row.arm === arm)),
        safety: summarizeRows(rows.filter((row) => row.safety && row.arm === arm)),
        allAttempts: summarizeRows(rows.filter((row) => row.arm === arm)),
      },
    ]),
  );
  const perTask = [...tasks.values()].map((task) => {
    const selected = rows.filter((row) => row.taskId === task.id);
    const costs = Object.fromEntries(
      ARMS.map((arm) => {
        const values = selected.filter((row) => row.arm === arm).map(cost);
        return [arm, task.safety || values.includes(null) ? null : mean(values)];
      }),
    );
    return {
      taskId: task.id,
      sourceGroup: task.sourceId,
      safety: task.safety === true,
      arms: Object.fromEntries(
        ARMS.map((arm) => [arm, summarizeRows(selected.filter((row) => row.arm === arm))]),
      ),
      penalizedSolveCost: costs,
      paired: pairedDistribution(selected),
      repeats: Object.fromEntries(
        ARMS.map((arm) => [
          arm,
          selected
            .filter((row) => row.arm === arm)
            .sort((left, right) => left.repeat - right.repeat)
            .map((row) => ({
              repeat: row.repeat,
              status: row.status,
              success: successful(row),
              penalizedSolveCost: row.safety ? null : cost(row),
              actualSolveHttpAttempts: row.usage?.solveHttpAttempts ?? null,
              sendToTerminalMs: row.timings?.sendToTerminalMs ?? null,
            })),
        ]),
      ),
    };
  });
  const perSource = sources.map((sourceGroup) => {
    const selected = perTask.filter((task) => !task.safety && task.sourceGroup === sourceGroup);
    return {
      sourceGroup,
      tasks: selected.length,
      arms: Object.fromEntries(
        ARMS.map((arm) => [
          arm,
          {
            planned: selected.reduce((n, task) => n + task.arms[arm].planned, 0),
            successes: selected.reduce((n, task) => n + task.arms[arm].successes, 0),
            penalizedSolveCost: selected.some((task) => task.penalizedSolveCost[arm] === null)
              ? null
              : mean(selected.map((task) => task.penalizedSolveCost[arm])),
          },
        ]),
      ),
    };
  });
  const estimate = (selected) => {
    const costs = Object.fromEntries(
      ARMS.map((arm) => [
        arm,
        selected.some((source) => source.arms[arm].penalizedSolveCost === null)
          ? null
          : mean(selected.map((source) => source.arms[arm].penalizedSolveCost)),
      ]),
    );
    const qualityDifference =
      selected.reduce((n, source) => n + source.arms.B.successes - source.arms.A.successes, 0) /
      selected.reduce((n, source) => n + source.arms.A.planned, 0);
    return {
      costs,
      relativeCostReduction:
        costs.A === null || costs.B === null || costs.A === 0 ? null : 1 - costs.B / costs.A,
      qualityDifference,
    };
  };
  const point = estimate(perSource);
  const random = randomSource(SEED);
  const bootstrap = Array.from({ length: REPLICATES }, () =>
    estimate(sources.map(() => perSource[Math.floor(random() * perSource.length)])),
  );
  const qualityCI = interval(bootstrap.map((sample) => sample.qualityDifference));
  const costCI = interval(bootstrap.map((sample) => sample.relativeCostReduction));
  const missingSuccessCost = ordinary.filter((row) => successful(row) && !solveKnown(row)).length;
  const integrityReasons = [];
  if (manifest.runStatus !== "completed") integrityReasons.push("experiment-not-completed");
  if (manifest.realModel?.status !== "run") integrityReasons.push("real-provider-not-run");
  if (manifest.integrity?.sourceStable !== true || manifest.integrity?.artifactsAvailable !== true)
    integrityReasons.push("frozen-artifact-identity-unproven");
  if (
    rows.some((row) => row.missingRecord || ["planned", "running", "unknown"].includes(row.status))
  )
    integrityReasons.push("missing-or-unsettled-attempts");
  if (rows.some((row) => row.status !== "planned" && !row.directory))
    integrityReasons.push("attempt-output-directory-unproven");
  if (rows.some(claimedSuccessRejected))
    integrityReasons.push("claimed-success-without-valid-child-exit");
  if (rows.some((row) => row.child && row.exit && !exitMetadataAligned(row)))
    integrityReasons.push("child-exit-metadata-mismatch");
  if (rows.some((row) => row.cleanupValid !== true)) integrityReasons.push("cleanup-unproven");
  if (rows.some((row) => row.sourceStable !== true))
    integrityReasons.push("attempt-artifact-identity-unproven");
  if (rows.some((row) => !httpReconciled(row)))
    integrityReasons.push("http-audit-reconciliation-incomplete");
  if (missingSuccessCost) integrityReasons.push("successful-attempt-solve-cost-missing");
  if (rows.some((row) => row.grading?.unknownReason))
    integrityReasons.push("oracle-evidence-unknown");
  if (point.costs.A === 0 || (point.relativeCostReduction !== null && costCI === null))
    integrityReasons.push("undefined-control-or-bootstrap-cost-ratio");
  const gates = {
    integrity: integrityReasons.length === 0,
    candidateOrdinaryAtLeast57Of60: arms.B.ordinary.successes >= 57,
    candidateSafety5Of5: arms.B.safety.successes === 5,
    noObservedOverallQualityDrop: arms.B.ordinary.successes >= arms.A.ordinary.successes,
    noObservedSourceQualityDrop: perSource.every(
      (source) => source.arms.B.successes >= source.arms.A.successes,
    ),
    noObservedTaskQualityDrop: perTask.every(
      (task) => task.arms.B.successes >= task.arms.A.successes,
    ),
    pairedQualityLower95AtLeastMinus005: qualityCI !== null && qualityCI.lower >= -0.05,
    relativeCostReductionAtLeast015:
      point.relativeCostReduction !== null && point.relativeCostReduction >= 0.15,
    relativeCostReductionLower95Positive: costCI !== null && costCI.lower > 0,
  };
  const passed = Object.values(gates).every(Boolean);
  const currentProductComparison = freeze.configuration?.comparisonKind === "current-product";
  return {
    schemaVersion: 1,
    experimentId: freeze.experimentId,
    freezeDigest: manifest.freezeDigest,
    baseline: "A",
    candidate: "B",
    status: !gates.integrity
      ? "INCONCLUSIVE"
      : passed
        ? "MEETS_DEVELOPMENT_GATES"
        : "DOES_NOT_MEET_DEVELOPMENT_GATES",
    comparisonKind: currentProductComparison ? "current-product" : "historical-guide-ablation",
    currentProductGoalAchieved: passed && currentProductComparison,
    defaultPromotionAllowed: false,
    calibrationInterpretation: currentProductComparison
      ? null
      : "Historical causal calibration only. No efficiency gain does not justify reverting the mechanically verified guide. This comparison cannot establish the current-product 15-percent goal.",
    uncertainty: {
      method: "paired source-cluster percentile bootstrap",
      seed: SEED,
      replicates: REPLICATES,
      confidenceLevel: 0.95,
      independentSourceGroups: sources.length,
      scope:
        "Three development sources only; conditional uncertainty, not independent confirmation or general browser capability evidence.",
    },
    primary: {
      metric: "macro-source-weighted penalized Solve HTTP cost",
      failurePenalty: PENALTY,
      failurePenaltyIsActualUsage: false,
      ...point,
      qualityDifference95CI: qualityCI,
      relativeCostReduction95CI: costCI,
      missingSuccessfulSolveCosts: missingSuccessCost,
    },
    gates,
    integrityReasons,
    arms,
    perSource,
    perTask,
    leaveOneSourceOut: sources.map((sourceGroup) => ({
      omittedSource: sourceGroup,
      ...estimate(perSource.filter((source) => source.sourceGroup !== sourceGroup)),
    })),
    paired: pairedDistribution(ordinary),
    timingScope:
      "Primary timing is sendToTerminalMs. elapsedMs includes verification and stop observation and is reported separately.",
  };
}

async function main() {
  const paths = process.argv.slice(2).filter((arg) => arg !== "--");
  assert.equal(paths.length, 1, "Usage: node browser-task-paired-summary.mjs <manifest.json>");
  console.log(
    JSON.stringify(
      summarizePairedExperiment(JSON.parse(await readFile(paths[0], "utf8"))),
      null,
      2,
    ),
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
