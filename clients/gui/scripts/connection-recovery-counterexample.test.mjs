import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  judgeAttempt,
  judgeExplorationAttempt,
  copyDependencies,
  mutate,
  mutations,
  snapshotPaths,
  summarizeAttempts,
} from "./connection-recovery-counterexample.mjs";

test("dependency copies isolate virtual-store writes and relocate workspace links", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "areal-counterexample-dependencies-"));
  try {
    const source = join(temporary, "source");
    const target = join(temporary, "target");
    await mkdir(join(source, "node_modules/.pnpm/example"), { recursive: true });
    await mkdir(join(source, "package"));
    await mkdir(join(target, "package"), { recursive: true });
    await writeFile(join(source, "node_modules/.pnpm/example/value"), "original");
    await symlink(".pnpm/example", join(source, "node_modules/example"));
    await symlink(join(source, "package"), join(source, "node_modules/workspace"));
    await copyDependencies(
      join(source, "node_modules"),
      join(target, "node_modules"),
      source,
      target,
    );
    assert.equal((await lstat(join(target, "node_modules/.pnpm"))).isSymbolicLink(), false);
    assert.equal(
      await realpath(join(target, "node_modules/workspace")),
      await realpath(join(target, "package")),
    );
    await writeFile(join(target, "node_modules/example/value"), "modified");
    assert.equal(await readFile(join(source, "node_modules/example/value"), "utf8"), "original");
    await symlink(temporary, join(source, "node_modules/escape"));
    await assert.rejects(
      copyDependencies(
        join(source, "node_modules"),
        join(temporary, "rejected"),
        source,
        join(temporary, "rejected-root"),
      ),
      /escapes the source checkout/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

const failedJourney = (fact) => ({
  status: "failed",
  firstFailure: {
    stage: fact,
    kind: "business",
    assertionId: mutations.find((mutation) => mutation.fact === fact)?.assertionId,
  },
  faults: { [fact]: { injectionReached: true } },
  artifacts: {
    "loading-observation.json": "a".repeat(64),
    "idle-socket-transition.json": "b".repeat(64),
  },
  cleanup: { status: "passed" },
  facts: [{ id: fact, status: "failed", evidence: ["failure.json"] }],
});
const reachedTrigger = {
  projectId: "project",
  successorShell: {
    connectionId: "socket-2",
    gatewayGeneration: "generation",
    project: { projectId: "project", state: "stopped", scheduleActivationSuppressed: false },
  },
  held: {
    requestId: "request",
    responseHit: "request",
    errorCode: null,
    identity: { connectionId: "socket", gatewayGeneration: "generation" },
  },
  idleState: "completed",
  stopped: { state: "stopped", scheduleActivationSuppressed: false },
  replacement: {
    before: { connectionId: "socket-1", hostId: "host", generation: "generation" },
    after: { connectionId: "socket-2", hostId: "host", generation: "generation" },
  },
};

test("both mutations address one current production boundary and leave other bytes intact", async () => {
  for (const mutation of mutations) {
    const source = await readFile(new URL(`../../../${mutation.path}`, import.meta.url), "utf8");
    const changed = mutate(source, mutation);
    assert.notEqual(changed, source);
    assert.equal(changed.length, source.length - mutation.before.length + mutation.after.length);
    assert.throws(() => mutate(changed, mutation), /expected one exact production boundary/);
    assert.throws(
      () => mutate(source + mutation.before, mutation),
      /expected one exact production boundary/,
    );
  }
});

test("only the expected business failure counts as a detected historical defect", () => {
  for (const mutation of mutations) {
    const detail = failedJourney(mutation.fact);
    assert.doesNotThrow(() => judgeAttempt(detail, 1, mutation, reachedTrigger));
    assert.throws(() => judgeAttempt(detail, 0, mutation), /original runner fail/);
    assert.throws(
      () => judgeAttempt({ ...detail, firstFailure: { stage: "prerequisites" } }, 1, mutation),
      /infrastructure/,
    );
    assert.throws(
      () => judgeAttempt({ ...detail, cleanup: { status: "failed" } }, 1, mutation),
      /cleanup/,
    );
    assert.throws(
      () =>
        judgeAttempt(
          { ...detail, facts: [{ id: mutation.fact, status: "pending", evidence: [] }] },
          1,
          mutation,
          reachedTrigger,
        ),
      /targeted business fact/,
    );
    assert.throws(
      () =>
        judgeAttempt(
          { ...detail, facts: [{ id: mutation.fact, status: "failed", evidence: [] }] },
          1,
          mutation,
          reachedTrigger,
        ),
      /observable evidence/,
    );
  }
});

test("a stage error cannot count without matched injection and the target UI assertion", () => {
  for (const mutation of mutations) {
    const detail = failedJourney(mutation.fact);
    assert.throws(
      () =>
        judgeAttempt(
          { ...detail, firstFailure: { stage: mutation.fact } },
          1,
          mutation,
          reachedTrigger,
        ),
      /target UI oracle/,
    );
    assert.throws(
      () => judgeAttempt({ ...detail, faults: {} }, 1, mutation, reachedTrigger),
      /actually reach/,
    );
    assert.throws(
      () => judgeAttempt({ ...detail, artifacts: {} }, 1, mutation, reachedTrigger),
      /original importer/,
    );
  }
  assert.throws(() =>
    judgeAttempt(failedJourney(mutations[0].fact), 1, mutations[0], {
      ...reachedTrigger,
      held: { ...reachedTrigger.held, responseHit: "other-request" },
    }),
  );
  assert.throws(() =>
    judgeAttempt(failedJourney(mutations[1].fact), 1, mutations[1], {
      ...reachedTrigger,
      stopped: { state: "stopped", scheduleActivationSuppressed: true },
    }),
  );
  assert.throws(() =>
    judgeAttempt(failedJourney(mutations[1].fact), 1, mutations[1], {
      ...reachedTrigger,
      replacement: {
        before: reachedTrigger.replacement.before,
        after: reachedTrigger.replacement.before,
      },
    }),
  );
});

test("baseline needs business success as well as process success", () => {
  const detail = { status: "passed", cleanup: { status: "passed" }, facts: [{ status: "passed" }] };
  assert.doesNotThrow(() => judgeAttempt(detail, 0, null));
  assert.throws(
    () => judgeAttempt(failedJourney("automaticRecovery"), 0, null),
    /every required business fact/,
  );
  assert.throws(() => judgeAttempt(detail, 1, null), /runner must succeed/);
});

test("summary distinguishes controlled detection from unmeasured human time", () => {
  const attempts = [
    { id: "baseline", status: "passed", exitCode: 0, evidenceValidated: true },
    ...mutations.map(({ id }) => ({ id, status: "passed", evidenceValidated: true })),
  ];
  assert.equal(summarizeAttempts(attempts).targetDefectsDetected, 2);
  assert.equal(summarizeAttempts(attempts).baselineFalsePositive, false);
  assert.equal(summarizeAttempts(attempts).evidenceComplete, true);
  assert.equal(summarizeAttempts(attempts).humanMinutes, null);
  assert.equal(summarizeAttempts(attempts).canConfirmHumanTimeReduction, false);
  assert.equal(summarizeAttempts([]).baselineFalsePositive, null);
  assert.equal(summarizeAttempts(attempts.slice(0, 1)).evidenceComplete, false);
  assert.equal(summarizeAttempts([{ ...attempts[0], exitCode: 1 }]).baselineFalsePositive, true);
});

test("snapshot allowlist excludes concurrent production UI edits", () => {
  assert(snapshotPaths.includes("clients/gui/scripts/connection-recovery-smoke.mjs"));
  assert(!snapshotPaths.some((path) => path.startsWith("clients/gui/renderer/")));
  assert.equal(new Set(snapshotPaths).size, snapshotPaths.length);
});

const explorationFailure = {
  kind: "business",
  assertionId: "exploration-recovery-progress",
  action: "idle-reconnect",
};
const explorationPlan = {
  schemaVersion: 1,
  seed: 21,
  actions: [
    { op: "edit", text: "recovery-draft-probe" },
    { op: "reconnect" },
    { op: "idle-reconnect" },
    { op: "submit" },
    { op: "unknown-submit" },
    { op: "stop-reconnect" },
  ],
};
const reducedExplorationPlan = {
  ...explorationPlan,
  actions: [{ op: "idle-reconnect" }, { op: "submit" }],
};
function explorationCase(mutant = false) {
  const detail = (status, firstFailure) => ({
    status,
    firstFailure,
    cleanup: { status: "passed" },
  });
  const original = detail(mutant ? "failed" : "passed", mutant ? explorationFailure : null);
  const records = [{ plan: explorationPlan, evidence: original }];
  if (mutant)
    records.push({ plan: reducedExplorationPlan, evidence: detail("failed", explorationFailure) });
  return {
    summary: {
      status: original.status,
      firstFailure: original.firstFailure,
      plannedCases: 1,
      unexecutedCases: 0,
      attempts: records.map(({ evidence }, index) => ({
        ...evidence,
        label: index ? "shrink" : "case-0",
        exitCode: evidence.status === "passed" ? 0 : 1,
      })),
      ...(mutant
        ? { reduction: { attempts: 1, minimal: false, stoppedReason: "budget-exhausted" } }
        : {}),
    },
    records,
  };
}

test("exploration baseline and targeted replay require settled real attempts", () => {
  const baseline = explorationCase();
  assert.doesNotThrow(() => judgeExplorationAttempt(baseline.summary, 0, null, baseline.records));
  assert.throws(() => judgeExplorationAttempt(baseline.summary, 1, null, baseline.records));
  assert.throws(() => judgeExplorationAttempt({ ...baseline.summary, attempts: [] }, 0, null, []));
  const mutant = explorationCase(true);
  assert.doesNotThrow(() =>
    judgeExplorationAttempt(
      mutant.summary,
      1,
      mutations[1],
      mutant.records,
      reducedExplorationPlan,
    ),
  );
  assert.throws(() =>
    judgeExplorationAttempt(
      mutant.summary,
      0,
      mutations[1],
      mutant.records,
      reducedExplorationPlan,
    ),
  );
});

test("exploration cannot accept blocked, unrelated or uncleared failure as a counterexample", () => {
  for (const change of [
    (value) => {
      value.summary.firstFailure.kind = "infrastructure";
    },
    (value) => {
      value.summary.firstFailure.assertionId = "other-oracle";
    },
    (value) => {
      value.summary.firstFailure.action = "reconnect";
    },
    (value) => {
      value.summary.attempts[1].cleanup.status = "failed";
    },
    (value) => {
      value.summary.attempts[1].status = "blocked";
    },
    (value) => {
      value.records[1].evidence.firstFailure.kind = "verifier";
    },
    (value) => {
      value.summary.reduction.attempts = 0;
    },
    (value) => {
      value.summary.reduction.stoppedReason = "inconclusive-attempt";
    },
    (value) => {
      value.summary.unexecutedCases = 1;
    },
    (value) => {
      value.records[0].plan.actions = [{ op: "submit" }];
    },
  ]) {
    const value = structuredClone(explorationCase(true));
    change(value);
    assert.throws(() =>
      judgeExplorationAttempt(
        value.summary,
        1,
        mutations[1],
        value.records,
        reducedExplorationPlan,
      ),
    );
  }
});

test("reduced replay must be legal and have actually reproduced the same failure", () => {
  const value = explorationCase(true);
  assert.throws(() =>
    judgeExplorationAttempt(value.summary, 1, mutations[1], value.records, {
      ...reducedExplorationPlan,
      actions: [{ op: "submit" }],
    }),
  );
  assert.throws(() =>
    judgeExplorationAttempt(value.summary, 1, mutations[1], value.records, {
      ...reducedExplorationPlan,
      actions: [{ op: "unknown-submit" }, { op: "submit" }],
    }),
  );
  const passed = structuredClone(value);
  Object.assign(passed.summary.attempts[1], { status: "passed", firstFailure: null, exitCode: 0 });
  Object.assign(passed.records[1].evidence, { status: "passed", firstFailure: null });
  assert.throws(() =>
    judgeExplorationAttempt(
      passed.summary,
      1,
      mutations[1],
      passed.records,
      reducedExplorationPlan,
    ),
  );
});
