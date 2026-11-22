// 有界恢复探索的执行报告必须能证明计划已真实到达，不能仅凭退出码放行。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repo = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const facts = ["loadingWithoutFalseFailure", "boundedRecoveryExploration"];
export function validateExplorationAttempt(detail, plan, exitCode, identity) {
  assert.equal(detail.journeyId, "connection-recovery-exploration");
  assert.deepEqual(detail.identity, identity, "report identity must match this execution");
  assert.equal(detail.exploration?.planSha256, hash(JSON.stringify(plan)), "replay plan differs");
  assert.equal(detail.cleanup?.status, "passed", "cleanup must settle before acceptance");
  const steps = detail.exploration.steps;
  assert(Array.isArray(steps) && steps.length <= plan.actions.length, "invalid executed steps");
  for (const [index, step] of steps.entries()) {
    assert.equal(step.index, index, "step indices must form a prefix");
    assert.equal(step.op, plan.actions[index].op, "action differs from replay plan");
    assert(["passed", "failed"].includes(step.status), "step status must be terminal");
    assert(
      step.status === "passed" || index === steps.length - 1,
      "execution continued after failure",
    );
    assert(step.evidence?.length, "step evidence missing");
    for (const path of step.evidence)
      assert(
        /^[a-f0-9]{64}$/.test(detail.artifacts?.[path] ?? ""),
        "step evidence must be imported and hashed",
      );
  }
  if (detail.status === "passed") {
    assert.equal(exitCode, 0, "passed report requires successful exit");
    assert.equal(detail.firstFailure, null, "passed report cannot retain a failure");
    assert.equal(steps.length, plan.actions.length, "passed report must execute all steps");
    assert(
      steps.every((step) => step.status === "passed"),
      "all steps must pass",
    );
    assert(detail.exploration.initial?.projectId && detail.exploration.initial?.connectionId);
    assert.deepEqual(detail.facts.map((fact) => fact.id).sort(), [...facts].sort());
    assert(detail.facts.every((fact) => fact.status === "passed"));
  } else {
    assert.equal(detail.status, "failed");
    assert.notEqual(exitCode, 0, "failure requires nonzero exit");
    assert(detail.firstFailure, "failed report needs first failure");
    if (detail.firstFailure.kind === "business") {
      const step = steps.at(-1);
      assert(step?.status === "failed", "business failure must identify a failed step");
      assert.equal(detail.firstFailure.stepIndex, step.index);
      assert.equal(detail.firstFailure.action, step.op);
      assert(detail.firstFailure.assertionId, "business failure requires a named assertion");
    }
  }
  return detail;
}

// 与 CI 共用业务证据导入器，先验证目录内文件和摘要，再检查探索的有序步骤。
const identityScript = `import pathlib,runpy,subprocess,json,sys
root=pathlib.Path(sys.argv[1])
scope=runpy.run_path(str(root/'scripts/ci-scope.py'))
revision=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
print(json.dumps({'sourceRevision':revision,'inputHash':scope['input_key'](root,revision)}))`;
const importScript = `import pathlib,runpy,json,sys
root=pathlib.Path(sys.argv[1]); path=pathlib.Path(sys.argv[2])
module=runpy.run_path(str(root/'scripts/verification-evidence.py'))
contract={'journeyId':'connection-recovery-exploration','terminalFacts':['loadingWithoutFalseFailure','boundedRecoveryExploration']}
detail=module['read_journey_report'](path,contract,json.loads(sys.argv[3]))
print(json.dumps(detail))`;
const json = (path, value) => writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 });

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      seed: { type: "string", default: "1" },
      cases: { type: "string", default: "3" },
      steps: { type: "string", default: "6" },
      replay: { type: "string" },
      output: { type: "string" },
      shrink: { type: "boolean", default: false },
      "shrink-attempts": { type: "string", default: "6" },
    },
  });
  const { generatePlan, validatePlan, minimizePlan } =
    await import("./support/recovery-exploration.mjs");
  const boundedInteger = (name, low, high) => {
    const value = Number(values[name]);
    assert(
      Number.isInteger(value) && value >= low && value <= high,
      `${name} must be ${low}..${high}`,
    );
    return value;
  };
  const count = boundedInteger("cases", 1, 6);
  const seed = boundedInteger("seed", 0, 0xffffffff);
  const steps = boundedInteger("steps", 4, 12);
  const maxAttempts = boundedInteger("shrink-attempts", 0, 8);
  const plans = values.replay
    ? [validatePlan(JSON.parse(await readFile(resolve(values.replay), "utf8")))]
    : Array.from({ length: count }, (_, index) =>
        generatePlan({ seed: (seed + index) >>> 0, steps }),
      );
  const output = resolve(
    values.output ?? join(repo, "target/connection-exploration", `${Date.now()}-${process.pid}`),
  );
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output); // 已有目录拒绝覆盖，首跑与重试分别保留。
  const identity = JSON.parse(
    execFileSync("python3", ["-c", identityScript, repo], { encoding: "utf8" }),
  );
  identity.runnerSha256 = hash(
    await readFile(join(repo, "clients/gui/scripts/connection-recovery-smoke.mjs")),
  );
  const summary = {
    schemaVersion: 1,
    status: "running",
    identity,
    mode: values.replay ? "replay" : "explore",
    plannedCases: plans.length,
    attempts: [],
    bounds: { cases: plans.length, maxActions: 12, shrinkAttempts: maxAttempts },
    scope:
      "Source Web UI with real Host/Core; controlled socket replacement and ifIdle; no Host process replacement, real idle timer, installed package or physical-device claim",
  };
  const save = () => json(join(output, "result.json"), summary);
  await save();
  const run = async (plan, label) => {
    const directory = join(output, `${String(summary.attempts.length).padStart(2, "0")}-${label}`);
    await mkdir(directory);
    const planPath = join(directory, "plan.json");
    await json(planPath, plan);
    const reportPath = join(directory, "report.json");
    const attempt = { label, directory, planSha256: hash(JSON.stringify(plan)), status: "running" };
    summary.attempts.push(attempt);
    await save();
    const log = createWriteStream(join(directory, "runner.log"), { mode: 0o600 });
    const child = spawn(
      process.execPath,
      [join(repo, "clients/gui/scripts/connection-recovery-smoke.mjs")],
      {
        cwd: repo,
        env: {
          ...process.env,
          AREAL_RECOVERY_PLAN: planPath,
          AREAL_JOURNEY_REPORT: reportPath,
          AREAL_VERIFICATION_IDENTITY: JSON.stringify(identity),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    let result;
    try {
      const exitCode = await new Promise((accept, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => accept(signal ? -1 : code));
      });
      const current = JSON.parse(
        execFileSync("python3", ["-c", identityScript, repo], { encoding: "utf8" }),
      );
      assert.equal(current.inputHash, identity.inputHash, "source changed during exploration");
      const detail = JSON.parse(
        execFileSync("python3", ["-c", importScript, repo, reportPath, JSON.stringify(identity)], {
          encoding: "utf8",
        }),
      );
      validateExplorationAttempt(detail, plan, exitCode, identity);
      await json(join(directory, "evidence.json"), detail);
      result = {
        status:
          detail.status === "failed" && detail.firstFailure?.kind !== "business"
            ? "blocked"
            : detail.status,
        firstFailure: detail.firstFailure,
        cleanup: detail.cleanup,
      };
      Object.assign(attempt, result, { exitCode, evidence: join(directory, "evidence.json") });
    } catch (error) {
      result = {
        status: "blocked",
        firstFailure: { kind: "verifier", message: error.message },
        cleanup: { status: "unknown" },
      };
      Object.assign(attempt, result);
    } finally {
      await new Promise((accept) => log.end(accept));
      await save();
    }
    return result;
  };
  for (const [index, plan] of plans.entries()) {
    const result = await run(plan, `case-${index}`);
    if (result.status !== "passed") {
      summary.firstFailure = { ...result.firstFailure, attempt: summary.attempts.length - 1 };
      if (
        values.shrink &&
        result.firstFailure?.kind === "business" &&
        result.cleanup?.status === "passed"
      ) {
        const reduced = await minimizePlan(plan, result, (candidate) => run(candidate, "shrink"), {
          maxAttempts,
        });
        await json(join(output, "reduced-plan.json"), reduced.plan);
        summary.reduction = {
          attempts: reduced.attempts.length,
          minimal: reduced.minimal,
          stoppedReason: reduced.stoppedReason,
          replay:
            "pnpm --dir clients/gui test:connection-recovery-explore --replay <output>/reduced-plan.json",
        };
      }
      break;
    }
  }
  summary.status = summary.firstFailure
    ? summary.firstFailure.kind === "business"
      ? "failed"
      : "blocked"
    : "passed";
  summary.unexecutedCases =
    plans.length - summary.attempts.filter((attempt) => attempt.label.startsWith("case-")).length;
  await save();
  console.log(
    JSON.stringify({ status: summary.status, output, firstFailure: summary.firstFailure ?? null }),
  );
  return summary.status === "passed" ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
