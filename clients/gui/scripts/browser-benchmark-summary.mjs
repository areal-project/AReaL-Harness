import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const statuses = new Set(["passed", "failed", "not_run", "planned", "blocked", "crashed"]);
const stableJSON = (value) =>
  JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)),
        )
      : entry,
  );

export function distribution(values) {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    min: sorted[0],
    max: sorted.at(-1),
  };
}

function normalize(document) {
  const run = document.benchmark ?? document;
  assert.equal(run.schemaVersion, 1, "Unsupported benchmark schemaVersion");
  assert.ok(
    ["deterministic-core-chain", "native-command"].includes(run.measurementKind),
    "Unknown measurementKind",
  );
  assert.equal(typeof run.benchmarkVersion, "string", "Missing benchmarkVersion");
  assert.ok(
    ["completed", "failed", "blocked", "crashed"].includes(run.runStatus),
    "Invalid runStatus",
  );
  assert.ok(Array.isArray(run.cases), "Missing benchmark cases");
  const cases = run.cases.map((entry) => {
    assert.equal(typeof entry.id, "string", "Case requires an id");
    assert.ok(statuses.has(entry.status), `Invalid case status for ${entry.id}`);
    if (entry.status === "passed")
      assert.ok(
        Number.isFinite(entry.caseMs) && entry.caseMs >= 0,
        `Passed case ${entry.id} requires a measured caseMs`,
      );
    return { ...entry };
  });
  const requiredIds = run.workload?.requiredCaseIds;
  if (run.measurementKind === "deterministic-core-chain") {
    assert.ok(
      Array.isArray(requiredIds) && requiredIds.length,
      "Core benchmark requires its preregistered workload",
    );
    assert.equal(
      new Set(cases.map((entry) => entry.id)).size,
      cases.length,
      "Core cases cannot repeat",
    );
    for (const id of requiredIds) {
      if (!cases.some((entry) => entry.id === id))
        cases.push({ id, required: true, status: "not_run", caseMs: null });
    }
  }
  if (
    run.measurementKind === "native-command" &&
    run.runStatus === "blocked" &&
    cases.length === 0 &&
    !run.plannedCases
  ) {
    cases.push({ id: "native-startup", required: true, status: "blocked", caseMs: null });
  } else if (run.measurementKind === "native-command") {
    assert.ok(
      Array.isArray(run.plannedCases),
      "Native benchmark requires preregistered plannedCases",
    );
    assert.ok(
      Number.isInteger(run.settings?.samples) && run.settings.samples > 0,
      "Native benchmark requires a positive sample count",
    );
    assert.ok(
      Number.isInteger(run.settings?.warmup) && run.settings.warmup >= 0,
      "Native benchmark requires a warmup count",
    );
    const identities = cases.map((entry) =>
      stableJSON([entry.id, entry.sampleIndex, Boolean(entry.warmup)]),
    );
    assert.equal(
      new Set(identities).size,
      identities.length,
      "Native trial identities cannot repeat",
    );
    // 从冻结的场景族和样本数重建分母，防止病例和计划同时被删掉。
    const ids = ["ordinary-legacy", "ordinary-command", "slow-image-legacy", "slow-image-command"];
    for (const id of ids)
      for (const warmup of [true, false]) {
        const count = warmup ? run.settings.warmup : run.settings.samples;
        for (let sampleIndex = 0; sampleIndex < count; sampleIndex++) {
          if (
            !cases.some(
              (entry) =>
                entry.id === id &&
                entry.sampleIndex === sampleIndex &&
                Boolean(entry.warmup) === warmup,
            )
          )
            cases.push({ id, sampleIndex, warmup, status: "not_run", caseMs: null });
        }
      }
  }
  if (Array.isArray(run.plannedCases)) {
    for (const planned of run.plannedCases) {
      if (
        !cases.some(
          (entry) =>
            entry.id === planned.id &&
            entry.sampleIndex === planned.sampleIndex &&
            Boolean(entry.warmup) === Boolean(planned.warmup),
        )
      )
        cases.push({ ...planned, status: "not_run", caseMs: null });
    }
  }
  const scored = cases.filter(
    (entry) => !entry.warmup && !entry.sensitivity && entry.required !== false,
  );
  const complete =
    run.runStatus === "completed" &&
    document.passed !== false &&
    (!run.integrity || run.integrity.status === "verified") &&
    scored.length > 0 &&
    scored.every((entry) => entry.status === "passed");
  return { ...run, cases, scored, complete };
}

function comparisonIdentity(run) {
  const provenance = run.provenance ?? {};
  return stableJSON({
    workload: run.workload ?? run.settings,
    scriptSHA256: provenance.scriptSHA256,
    fixtureSHA256: provenance.fixtureSHA256,
    electron: provenance.electron,
    chromium: provenance.chromium,
    node: provenance.node,
    os: provenance.os,
    arch: provenance.arch,
  });
}

export function summarizeBenchmarks(documents, { compare = false } = {}) {
  assert.ok(documents.length, "At least one benchmark document is required");
  const runs = documents.map(normalize);
  const families = new Map();
  for (const run of runs) {
    const family = `${run.measurementKind}/${run.benchmarkVersion}`;
    if (!families.has(family)) families.set(family, []);
    families.get(family).push(run);
  }
  if (compare)
    for (const [family, entries] of families) {
      const reference = comparisonIdentity(entries[0]);
      const provenance = entries[0].provenance;
      assert.ok(
        provenance?.scriptSHA256 && provenance?.fixtureSHA256,
        `${family} lacks script/fixture provenance for comparison`,
      );
      for (const run of entries)
        assert.equal(
          comparisonIdentity(run),
          reference,
          `${family} has inconsistent workload or execution provenance`,
        );
    }
  const groups = new Map();
  for (const run of runs) {
    const provenance = run.provenance ?? {};
    const product = {
      sourceHead: provenance.sourceHead,
      diffSHA256: provenance.diffSHA256,
      coreBinarySHA256: provenance.coreBinarySHA256,
      hashes: provenance.hashes,
      browserAutomationDistSHA256: provenance.browserAutomationDistSHA256,
      sourceHashes: provenance.sourceHashes,
      distHashes: provenance.distHashes,
    };
    const productId = createHash("sha256").update(stableJSON(product)).digest("hex").slice(0, 12);
    const group = `${run.measurementKind}/${run.benchmarkVersion}/${productId}`;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(run);
  }
  return [...groups].map(([group, entries]) => {
    const complete = entries.every((entry) => entry.complete);
    const allCases = entries.flatMap((entry) => entry.scored);
    const ids = [...new Set(allCases.map((entry) => entry.id))];
    return {
      group,
      measurementKind: entries[0].measurementKind,
      runs: entries.length,
      completedRuns: entries.filter((entry) => entry.complete).length,
      eligibleForLatencyComparison: complete,
      runStatuses: Object.fromEntries(
        ["completed", "failed", "blocked", "crashed"].map((status) => [
          status,
          entries.filter((entry) => entry.runStatus === status).length,
        ]),
      ),
      elapsedMs: distribution(entries.map((entry) => entry.elapsedMs)),
      cases: ids.map((id) => {
        const trials = allCases.filter((entry) => entry.id === id);
        const counts = Object.fromEntries(
          [...statuses].map((status) => [
            status,
            trials.filter((entry) => entry.status === status).length,
          ]),
        );
        return {
          id,
          trials: trials.length,
          statuses: counts,
          // 丢失或失败的任务不能通过删掉慢样本让主指标改善。
          caseMs:
            complete && counts.passed === trials.length
              ? distribution(trials.map((entry) => entry.caseMs))
              : null,
          failedCaseMs: distribution(
            trials.filter((entry) => entry.status !== "passed").map((entry) => entry.caseMs),
          ),
          terminalMs: complete ? distribution(trials.map((entry) => entry.terminalMs)) : null,
          verificationMs: complete
            ? distribution(trials.map((entry) => entry.verificationMs ?? entry.oracleMs))
            : null,
          work: Object.fromEntries(
            [
              "modelRequests",
              "browserCalls",
              "approvalCount",
              "toolFailureCount",
              "unexpectedFailureCount",
              "toolResultBytes",
              "resultTextBytes",
              "imageBytes",
              "siteRequests",
              "sideEffects",
              "commandsStarted",
              "commandsFinished",
            ].map((field) => [
              field,
              {
                total: trials.reduce(
                  (sum, trial) => sum + (Number.isFinite(trial[field]) ? trial[field] : 0),
                  0,
                ),
                unknown: trials.filter((trial) => !Number.isFinite(trial[field])).length,
              },
            ]),
          ),
        };
      }),
      diagnosticCases: entries.flatMap((entry) => entry.diagnosticCases ?? []),
      excludedWarmupOrSensitivity: entries
        .flatMap((entry) => entry.cases)
        .filter((entry) => entry.warmup || entry.sensitivity).length,
      realModel: "not_run",
    };
  });
}

const display = (value) =>
  value
    ? `${value.median.toFixed(1)} ms [${value.min.toFixed(1)}, ${value.max.toFixed(1)}], n=${value.count}`
    : "withheld";

async function main() {
  const args = process.argv.slice(2);
  const compare = args.includes("--compare");
  const json = args.includes("--json");
  const paths = args.filter((arg) => !["--", "--compare", "--json"].includes(arg));
  assert.ok(
    paths.length && paths.every((path) => !path.startsWith("--")),
    "Usage: node browser-benchmark-summary.mjs [--compare] [--json] <run-manifest.json|RESULT.json> ...",
  );
  const documents = await Promise.all(
    paths.map(async (path) => JSON.parse(await readFile(path, "utf8"))),
  );
  const result = summarizeBenchmarks(documents, { compare });
  if (json) console.log(JSON.stringify(result, null, 2));
  else
    for (const group of result) {
      console.log(
        `${group.group}: ${group.completedRuns}/${group.runs} complete runs; latency comparison ${group.eligibleForLatencyComparison ? "eligible" : "withheld"}; real model not_run`,
      );
      console.log(
        `  run status ${JSON.stringify(group.runStatuses)}; elapsed ${display(group.elapsedMs)}`,
      );
      for (const entry of group.cases) {
        console.log(
          `  ${entry.id}: ${entry.statuses.passed}/${entry.trials} passed; case ${display(entry.caseMs)}; failed ${display(entry.failedCaseMs)}; status ${JSON.stringify(entry.statuses)}`,
        );
        console.log(`    work ${JSON.stringify(entry.work)}`);
      }
      console.log(
        `  diagnostic polls ${group.diagnosticCases.length}; excluded warmup/sensitivity ${group.excludedWarmupOrSensitivity}`,
      );
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
