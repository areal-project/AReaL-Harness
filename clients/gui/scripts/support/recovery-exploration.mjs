import assert from "node:assert/strict";

const operations = new Set([
  "edit",
  "reconnect",
  "idle-reconnect",
  "submit",
  "unknown-submit",
  "stop-reconnect",
]);
const recoveryOperations = new Set(["reconnect", "idle-reconnect"]);

function objectKeys(value, expected) {
  assert(value && typeof value === "object" && !Array.isArray(value), "Expected an object");
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), "Unexpected fields");
}

function checkSeed(seed) {
  assert(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff, "Seed must be uint32");
}

export function validatePlan(value) {
  objectKeys(value, ["schemaVersion", "seed", "actions"]);
  assert.equal(value.schemaVersion, 1, "Unsupported replay schema");
  checkSeed(value.seed);
  assert(Array.isArray(value.actions), "Replay actions must be an array");
  assert(value.actions.length >= 1 && value.actions.length <= 12, "Replay requires 1..12 actions");
  let submitted = false;
  let lastRecovery = -1;
  let lastSubmission = -1;
  const actions = value.actions.map((action, index) => {
    objectKeys(action, action?.op === "edit" ? ["op", "text"] : ["op"]);
    assert(operations.has(action.op), "Unsupported replay action");
    if (action.op === "edit") {
      assert(
        typeof action.text === "string" &&
          action.text.length <= 100 &&
          /^recovery-draft-[a-z0-9-]+$/.test(action.text),
        "Replay edits must contain bounded synthetic text",
      );
      return { op: action.op, text: action.text };
    }
    if (action.op === "unknown-submit") assert(submitted, "UNKNOWN needs an existing Thread");
    if (action.op === "submit") submitted = true;
    if (recoveryOperations.has(action.op)) lastRecovery = index;
    if (action.op === "submit" || action.op === "unknown-submit") lastSubmission = index;
    if (action.op === "stop-reconnect")
      assert.equal(index, value.actions.length - 1, "Explicit stop must be terminal");
    return { op: action.op };
  });
  assert(submitted, "A replay must prove submission");
  assert(lastSubmission > lastRecovery, "A replay needs a submission after the last recovery");
  return { schemaVersion: 1, seed: value.seed, actions };
}

export function generatePlan({ seed = 1, steps = 6 } = {}) {
  checkSeed(seed);
  assert(Number.isInteger(steps) && steps >= 4 && steps <= 12, "Generate 4..12 actions");
  let state = seed;
  // 固定整数运算确保相同种子跨进程产生相同动作；实际异步次序另由运行证据记录。
  const choose = (values) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let word = Math.imul(state ^ (state >>> 15), state | 1);
    word ^= word + Math.imul(word ^ (word >>> 7), word | 61);
    return values[((word ^ (word >>> 14)) >>> 0) % values.length];
  };
  const actions = [];
  let edited = false;
  let recovered = false;
  let submitted = false;
  let needsSubmission = false;
  for (let index = 0; index < steps; index += 1) {
    const choices = [
      "edit",
      "reconnect",
      "idle-reconnect",
      "submit",
      ...(submitted ? ["unknown-submit"] : []),
      ...(index === steps - 1 ? ["stop-reconnect"] : []),
    ].filter((op) => {
      const nextEdited = edited || op === "edit";
      const nextRecovered = recovered || recoveryOperations.has(op);
      const nextSubmitted = submitted || op === "submit";
      const nextNeedsSubmission = recoveryOperations.has(op)
        ? true
        : op === "submit" || op === "unknown-submit"
          ? false
          : needsSubmission;
      // 尚未恢复时要预留“恢复、提交”两步；不能把恢复前的成功提交计为活性证据。
      const remainingRequired =
        Number(!nextEdited) + (!nextRecovered ? 2 : !nextSubmitted || nextNeedsSubmission ? 1 : 0);
      return remainingRequired <= steps - index - 1;
    });
    assert(choices.length > 0, "Remaining action budget must satisfy recovery obligations");
    const op = choose(choices);
    actions.push(op === "edit" ? { op, text: `recovery-draft-${seed}-${index}` } : { op });
    edited ||= op === "edit";
    recovered ||= recoveryOperations.has(op);
    submitted ||= op === "submit";
    if (recoveryOperations.has(op)) needsSubmission = true;
    if (op === "submit" || op === "unknown-submit") needsSubmission = false;
  }
  return validatePlan({ schemaVersion: 1, seed, actions });
}

function businessFailure(report) {
  return (
    report?.status === "failed" &&
    report.cleanup?.status === "passed" &&
    report.firstFailure?.kind === "business" &&
    typeof report.firstFailure.assertionId === "string" &&
    report.firstFailure.assertionId.length > 0 &&
    (report.firstFailure.action === undefined || operations.has(report.firstFailure.action))
  );
}

export async function minimizePlan(plan, failure, run, { maxAttempts = 8 } = {}) {
  let current = validatePlan(plan);
  assert(
    businessFailure(failure),
    "Only a proven business failure with settled cleanup can shrink",
  );
  assert(typeof run === "function", "Replay runner is required");
  assert(
    Number.isInteger(maxAttempts) && maxAttempts >= 0 && maxAttempts <= 32,
    "Minimization allows 0..32 attempts",
  );
  const attempts = [];
  const done = (minimal, stoppedReason) => ({ plan: current, attempts, minimal, stoppedReason });
  let index = 0;
  while (index < current.actions.length) {
    let candidate;
    try {
      candidate = validatePlan({
        ...current,
        actions: current.actions.filter((_, actionIndex) => actionIndex !== index),
      });
    } catch {
      index += 1;
      continue;
    }
    if (attempts.length >= maxAttempts) return done(false, "budget-exhausted");
    const attempt = { candidate, preserved: false };
    attempts.push(attempt);
    try {
      // 驱动器获得独立副本，不能修改已保存的候选轨迹。
      attempt.result = await run(validatePlan(candidate));
    } catch (error) {
      attempt.error = { name: error?.name ?? "Error", message: String(error?.message ?? error) };
      return done(false, "runner-error");
    }
    const result = attempt.result;
    attempt.preserved =
      businessFailure(result) &&
      result.firstFailure.assertionId === failure.firstFailure.assertionId &&
      result.firstFailure.action === failure.firstFailure.action;
    if (attempt.preserved) {
      current = candidate;
      index = 0;
    } else if (
      result?.cleanup?.status !== "passed" ||
      (result.status !== "passed" && !businessFailure(result))
    ) {
      return done(false, "inconclusive-attempt");
    } else {
      index += 1;
    }
  }
  // 仅证明当前序列的合法单步删除均未保留目标失败，不宣称全局最短。
  return done(true, "single-deletion-minimal");
}
