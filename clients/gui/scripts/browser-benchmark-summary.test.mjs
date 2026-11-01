import assert from "node:assert/strict";
import test from "node:test";
import { distribution, summarizeBenchmarks } from "./browser-benchmark-summary.mjs";

const trial = (id, caseMs, rest = {}) => ({ id, status: "passed", caseMs, ...rest });
const core = (cases, rest = {}) => ({
  schemaVersion: 1,
  benchmarkVersion: "browser-core-v1",
  measurementKind: "deterministic-core-chain",
  runStatus: "completed",
  workload: { requiredCaseIds: ["navigate", "fill"] },
  provenance: {
    scriptSHA256: "script",
    fixtureSHA256: "fixture",
    sourceHead: "baseline",
    electron: "44",
  },
  cases,
  ...rest,
});

test("reports the median and range of complete repeated tasks", () => {
  const runs = [20, 10, 30].map((ms) => core([trial("navigate", ms), trial("fill", ms + 5)]));
  const [summary] = summarizeBenchmarks(runs, { compare: true });
  assert.equal(summary.completedRuns, 3);
  assert.deepEqual(summary.cases[0].caseMs, { count: 3, median: 20, min: 10, max: 30 });
  assert.deepEqual(distribution([null, 2, 4, undefined]), { count: 2, median: 3, min: 2, max: 4 });
});

test("an omitted required case remains not_run and withholds the latency score", () => {
  const [summary] = summarizeBenchmarks([core([trial("navigate", 1)])]);
  assert.equal(summary.completedRuns, 0);
  assert.equal(summary.eligibleForLatencyComparison, false);
  assert.equal(summary.cases.find((entry) => entry.id === "fill").statuses.not_run, 1);
  assert.ok(summary.cases.every((entry) => entry.caseMs === null));
});

test("a failed fast task cannot improve a complete run's score", () => {
  const runs = [
    core([trial("navigate", 100), trial("fill", 100)]),
    core([trial("navigate", 1), trial("fill", 2, { status: "failed" })], { runStatus: "failed" }),
  ];
  const [summary] = summarizeBenchmarks(runs);
  assert.equal(summary.completedRuns, 1);
  assert.equal(summary.eligibleForLatencyComparison, false);
  assert.ok(summary.cases.every((entry) => entry.caseMs === null));
  assert.equal(summary.cases[1].failedCaseMs.median, 2);
});

test("expected denial remains a quality pass with a real tool failure", () => {
  const [summary] = summarizeBenchmarks([
    core([
      trial("navigate", 10),
      trial("fill", 20, {
        expectedDenial: true,
        toolFailureCount: 1,
        unexpectedFailureCount: 0,
        sideEffects: 0,
      }),
    ]),
  ]);
  assert.equal(summary.completedRuns, 1);
  assert.equal(summary.cases[1].work.toolFailureCount.total, 1);
  assert.equal(summary.cases[1].work.unexpectedFailureCount.total, 0);
  assert.equal(summary.cases[0].work.imageBytes.unknown, 1);
});

test("setup failure remains blocked even when no scenario started", () => {
  const [summary] = summarizeBenchmarks([core([], { runStatus: "blocked" })]);
  assert.equal(summary.runStatuses.blocked, 1);
  assert.equal(summary.cases.length, 2);
  assert.ok(summary.cases.every((entry) => entry.statuses.not_run === 1));
});

test("comparison rejects changed workload or runner provenance", () => {
  const baseline = core([trial("navigate", 10), trial("fill", 20)]);
  for (const candidate of [
    { ...baseline, workload: { requiredCaseIds: ["navigate"] } },
    { ...baseline, provenance: { ...baseline.provenance, scriptSHA256: "changed" } },
    { ...baseline, provenance: { ...baseline.provenance, electron: "45" } },
  ])
    assert.throws(
      () => summarizeBenchmarks([baseline, candidate], { compare: true }),
      /inconsistent workload or execution provenance/,
    );
  assert.throws(
    () => summarizeBenchmarks([core(baseline.cases, { provenance: {} })], { compare: true }),
    /lacks script\/fixture provenance/,
  );
});

test("different product versions have separate distributions", () => {
  const baseline = core([trial("navigate", 100), trial("fill", 200)]);
  const candidate = {
    ...baseline,
    provenance: { ...baseline.provenance, sourceHead: "candidate" },
    cases: [trial("navigate", 10), trial("fill", 20)],
  };
  const summary = summarizeBenchmarks([baseline, candidate], { compare: true });
  assert.equal(summary.length, 2);
  assert.equal(summary[0].cases[0].caseMs.median, 100);
  assert.equal(summary[1].cases[0].caseMs.median, 10);
});

const nativeIds = [
  "ordinary-legacy",
  "ordinary-command",
  "slow-image-legacy",
  "slow-image-command",
];
const native = (rest = {}) => {
  const cases = nativeIds.flatMap((id) => [
    trial(id, 300, { sampleIndex: 0, warmup: true }),
    trial(id, 20, { sampleIndex: 0, warmup: false }),
    trial(id, 40, { sampleIndex: 1, warmup: false }),
  ]);
  return {
    schemaVersion: 1,
    benchmarkVersion: "browser-navigation-native-v1",
    measurementKind: "native-command",
    runStatus: "completed",
    settings: { samples: 2, warmup: 1 },
    plannedCases: cases.map(({ id, sampleIndex, warmup }) => ({ id, sampleIndex, warmup })),
    cases,
    ...rest,
  };
};

test("native trials, warmup and Core measurements never mix", () => {
  const summary = summarizeBenchmarks([
    core([trial("navigate", 100), trial("fill", 200)]),
    native(),
  ]);
  assert.equal(summary.length, 2);
  assert.equal(summary[1].cases[0].caseMs.median, 30);
  assert.equal(summary[1].cases[0].trials, 2);
  assert.equal(summary[1].excludedWarmupOrSensitivity, 4);
});

test("native preregistered missing samples cannot disappear", () => {
  const input = native();
  input.cases = input.cases.filter(
    (entry) => entry.id !== "slow-image-command" || entry.sampleIndex !== 1,
  );
  const [summary] = summarizeBenchmarks([input]);
  assert.equal(summary.completedRuns, 0);
  assert.equal(
    summary.cases.find((entry) => entry.id === "slow-image-command").statuses.not_run,
    1,
  );
  assert.ok(summary.cases.every((entry) => entry.caseMs === null));
});

test("native missing roster, missing groups and duplicate sample identities cannot qualify", () => {
  const input = native();
  assert.throws(
    () => summarizeBenchmarks([{ ...input, plannedCases: undefined }]),
    /requires preregistered/,
  );
  assert.throws(
    () => summarizeBenchmarks([{ ...input, cases: [...input.cases, input.cases[0]] }]),
    /cannot repeat/,
  );
  const [summary] = summarizeBenchmarks([
    { ...input, plannedCases: [], cases: [trial("ordinary-command", 1, { sampleIndex: 0 })] },
  ]);
  assert.equal(summary.eligibleForLatencyComparison, false);
  assert.equal(summary.cases.length, 4);
  assert.equal(
    summary.cases.reduce((count, entry) => count + entry.statuses.not_run, 0),
    7,
  );
});

test("changed execution artifacts withhold the score", () => {
  const [summary] = summarizeBenchmarks([
    core([trial("navigate", 10), trial("fill", 20)], { integrity: { status: "changed" } }),
  ]);
  assert.equal(summary.completedRuns, 0);
  assert.equal(summary.eligibleForLatencyComparison, false);
});

test("native actual dist changes create separate distributions", () => {
  const baseline = native({
    provenance: { sourceHead: "same", distHashes: { "electron.cjs": "old" } },
  });
  const candidate = native({
    provenance: { sourceHead: "same", distHashes: { "electron.cjs": "new" } },
  });
  assert.equal(summarizeBenchmarks([baseline, candidate]).length, 2);
});

test("Core builds with different loaded renderer assets remain separate", () => {
  const before = core([trial("navigate", 100), trial("fill", 200)], {
    provenance: { sourceHead: "same", hashes: { "renderer/dist/assets/app.js": "old" } },
  });
  const after = core([trial("navigate", 10), trial("fill", 20)], {
    provenance: { sourceHead: "same", hashes: { "renderer/dist/assets/app.js": "new" } },
  });
  assert.equal(summarizeBenchmarks([before, after]).length, 2);
});

test("native launch failures remain counted without an initialized workload", () => {
  const [summary] = summarizeBenchmarks([
    {
      schemaVersion: 1,
      benchmarkVersion: "browser-navigation-native-v1",
      measurementKind: "native-command",
      runStatus: "blocked",
      cases: [],
      error: { message: "Electron has not started" },
    },
  ]);
  assert.equal(summary.runs, 1);
  assert.equal(summary.completedRuns, 0);
  assert.equal(summary.runStatuses.blocked, 1);
  assert.equal(summary.cases[0].statuses.blocked, 1);
  assert.equal(summary.eligibleForLatencyComparison, false);
});
