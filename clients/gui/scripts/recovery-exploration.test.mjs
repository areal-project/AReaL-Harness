import assert from "node:assert/strict";
import test from "node:test";
import { generatePlan, minimizePlan, validatePlan } from "./support/recovery-exploration.mjs";

const plan = (actions, seed = 1) => ({ schemaVersion: 1, seed, actions });
const submit = { op: "submit" };
const edit = { op: "edit", text: "recovery-draft-test" };
const failure = {
  status: "failed",
  firstFailure: { kind: "business", assertionId: "draft-preserved", action: "reconnect" },
  cleanup: { status: "passed" },
};
const passed = { status: "passed", firstFailure: null, cleanup: { status: "passed" } };

test("replay rejects executable, unbounded and malformed input before driving anything", () => {
  for (const value of [
    null,
    [],
    plan([]),
    plan([submit], -1),
    plan([submit], 2 ** 32),
    plan([submit], 1.2),
    plan(Array.from({ length: 13 }, () => submit)),
    plan([{ op: "shell", command: "echo unsafe" }, submit]),
    plan([{ op: "reconnect", url: "https://example.com" }, submit]),
    plan([{ op: "edit", text: "a real secret" }, submit]),
    plan([{ op: "edit", text: `recovery-draft-${"a".repeat(90)}` }, submit]),
    plan([{ op: "edit", text: "recovery-draft-" }, submit]),
    { ...plan([submit]), command: "ignored?" },
    { ...plan([submit]), schemaVersion: 2 },
    plan([null, submit]),
    plan(["submit"]),
  ]) {
    assert.throws(() => validatePlan(value), undefined, JSON.stringify(value));
  }
});

test("replay preserves state prerequisites and never drives past an explicit stop", () => {
  assert.throws(() => validatePlan(plan([{ op: "unknown-submit" }, submit])));
  assert.throws(() => validatePlan(plan([edit, { op: "reconnect" }])));
  assert.throws(() => validatePlan(plan([submit, { op: "stop-reconnect" }, edit])));
  const input = plan([edit, submit, { op: "unknown-submit" }, { op: "stop-reconnect" }], 0);
  const normalized = validatePlan(input);
  assert.deepEqual(normalized, input);
  normalized.actions[0].text = "recovery-draft-changed";
  assert.equal(input.actions[0].text, "recovery-draft-test");
});

test("a successful send before the last recovery cannot prove continued usability", () => {
  assert.throws(
    () =>
      validatePlan(
        plan([
          { op: "reconnect" },
          submit,
          { op: "reconnect" },
          submit,
          { op: "idle-reconnect" },
          edit,
        ]),
      ),
    /submission after the last recovery/,
  );
  assert.throws(
    () => validatePlan(plan([submit, { op: "idle-reconnect" }, { op: "stop-reconnect" }])),
    /submission after the last recovery/,
  );
  assert.doesNotThrow(() =>
    validatePlan(
      plan([submit, { op: "idle-reconnect" }, { op: "unknown-submit" }, { op: "stop-reconnect" }]),
    ),
  );
  assert.doesNotThrow(() =>
    validatePlan(plan([{ op: "reconnect" }, submit, { op: "stop-reconnect" }])),
  );
});

test("every generated recovery is followed by a later user submission at every supported bound", () => {
  for (let steps = 4; steps <= 12; steps += 1) {
    for (let seed = 0; seed < 64; seed += 1) {
      const actions = generatePlan({ seed, steps }).actions;
      const lastRecovery = actions.findLastIndex(
        ({ op }) => op === "reconnect" || op === "idle-reconnect",
      );
      assert(lastRecovery >= 0);
      assert(
        actions
          .slice(lastRecovery + 1)
          .some(({ op }) => op === "submit" || op === "unknown-submit"),
        `seed=${seed}, steps=${steps}`,
      );
    }
  }
});

test("generation is reproducible, bounded and explores different operation orders", () => {
  const signatures = new Set();
  const observed = new Set();
  for (let seed = 0; seed < 64; seed += 1) {
    const generated = generatePlan({ seed, steps: 8 });
    assert.deepEqual(generatePlan({ seed, steps: 8 }), generated);
    assert.deepEqual(validatePlan(generated), generated);
    assert.equal(generated.actions.length, 8);
    const operations = generated.actions.map(({ op }) => op);
    assert(operations.includes("edit"));
    assert(operations.some((op) => ["reconnect", "idle-reconnect"].includes(op)));
    assert(operations.includes("submit"));
    signatures.add(operations.join(","));
    operations.forEach((op) => observed.add(op));
  }
  assert(signatures.size > 10, "seeds must explore more than one fixed scenario");
  assert(observed.has("unknown-submit"));
  assert(observed.has("stop-reconnect"));
  for (const steps of [4, 12]) assert.equal(generatePlan({ steps }).actions.length, steps);
  for (const options of [{ steps: 3 }, { steps: 13 }, { steps: 4.5 }, { seed: -1 }])
    assert.throws(() => generatePlan(options));
});

test("minimization removes irrelevant actions but keeps the same reachable failure", async () => {
  const input = plan([edit, { op: "reconnect" }, { op: "idle-reconnect" }, submit]);
  const result = await minimizePlan(input, failure, async (candidate) => {
    validatePlan(candidate);
    return candidate.actions.some(({ op }) => op === "reconnect") ? failure : passed;
  });
  assert.deepEqual(result.plan.actions, [{ op: "reconnect" }, submit]);
  assert.equal(result.minimal, true);
  assert.equal(result.stoppedReason, "single-deletion-minimal");
  assert(result.attempts.length <= 8);
  assert.equal(input.actions.length, 4, "original replay evidence must stay unchanged");
});

test("a different assertion, action, infrastructure error or failed cleanup cannot shrink a bug", async () => {
  const original = plan([edit, { op: "reconnect" }, submit]);
  const alternatives = [
    { ...failure, status: "blocked" },
    { ...failure, firstFailure: { ...failure.firstFailure, kind: "infrastructure" } },
    { ...failure, firstFailure: { ...failure.firstFailure, assertionId: "different" } },
    { ...failure, firstFailure: { ...failure.firstFailure, action: "idle-reconnect" } },
    { ...failure, cleanup: { status: "failed" } },
    passed,
  ];
  for (const alternative of alternatives) {
    const result = await minimizePlan(original, failure, async () => alternative);
    assert.deepEqual(result.plan, original);
    assert(result.attempts.length > 0, "a rejected candidate must have been evaluated");
    assert(result.attempts.every(({ preserved }) => !preserved));
    if (
      alternative.status === "blocked" ||
      alternative.cleanup.status === "failed" ||
      alternative.firstFailure?.kind === "infrastructure"
    ) {
      assert.equal(result.minimal, false, "inconclusive runs cannot establish minimality");
    }
  }
});

test("budget is a strict limit on actual runs and invalid deletions never execute", async () => {
  let calls = 0;
  const input = plan([submit, { op: "reconnect" }, { op: "unknown-submit" }, edit]);
  const result = await minimizePlan(
    input,
    failure,
    async (candidate) => {
      calls += 1;
      validatePlan(candidate);
      assert.equal(candidate.actions[0].op, "submit");
      return passed;
    },
    { maxAttempts: 1 },
  );
  assert.equal(calls, 1);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.minimal, false);
  assert.equal(result.stoppedReason, "budget-exhausted");
  calls = 0;
  const zero = await minimizePlan(
    input,
    failure,
    async () => {
      calls += 1;
      return passed;
    },
    { maxAttempts: 0 },
  );
  assert.equal(calls, 0);
  assert.equal(zero.minimal, false);
  for (const maxAttempts of [-1, 1.5, 33])
    await assert.rejects(() => minimizePlan(input, failure, async () => passed, { maxAttempts }));
});

test("minimization retains post-recovery submission even when an earlier send succeeded", async () => {
  const input = plan([submit, { op: "reconnect" }, { op: "unknown-submit" }, edit]);
  const result = await minimizePlan(input, failure, async (candidate) => {
    assert.notDeepEqual(candidate.actions, [submit, { op: "reconnect" }]);
    return candidate.actions.some(({ op }) => op === "reconnect") ? failure : passed;
  });
  assert.deepEqual(result.plan.actions, [submit, { op: "reconnect" }, { op: "unknown-submit" }]);
  assert.equal(result.minimal, true);
});

test("an unproven original failure is rejected and a runner exception preserves the last valid plan", async () => {
  const input = plan([edit, { op: "reconnect" }, submit]);
  for (const original of [
    passed,
    { ...failure, cleanup: { status: "failed" } },
    { ...failure, firstFailure: { kind: "business", action: "reconnect" } },
  ]) {
    await assert.rejects(() => minimizePlan(input, original, async () => failure));
  }
  const result = await minimizePlan(input, failure, async () => {
    throw new Error("fixture unavailable");
  });
  assert.deepEqual(result.plan, input);
  assert.equal(result.minimal, false);
  assert.equal(result.stoppedReason, "runner-error");
  assert.equal(result.attempts.length, 1);
});
