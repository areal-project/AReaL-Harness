import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectCapabilities } from "./agent-capabilities.mjs";
import { readTestManifest } from "./test-manifest.mjs";

const gui = fileURLToPath(new URL("../", import.meta.url));
const manifest = await readTestManifest();
const coreContracts = process.argv.includes("--core-contracts");
const available = detectCapabilities();
const coreAvailable = available.includes("core-binary");
const argument = (name) =>
  process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
const planPath = argument("--plan");
const plan = planPath ? JSON.parse(await readFile(planPath, "utf8")) : null;
const item = plan?.items.find((entry) => entry.id === argument("--item"));
if (plan && !item) throw new Error("Runner item is absent from the verification plan");
const candidates = manifest.filter(
  (entry) =>
    entry.layer !== "e2e" &&
    entry.platforms.includes(process.platform) &&
    (coreContracts
      ? entry.requires.includes("core-binary")
      : !entry.requires.includes("core-binary") &&
        !entry.requires.includes("node-24.2.0") &&
        !entry.requires.includes("macos-tools")),
);
const selected = item
  ? item.expectedTests[process.platform]
  : candidates.map((entry) => entry.script);
if (
  !Array.isArray(selected) ||
  new Set(selected).size !== selected.length ||
  selected.some((script) => !candidates.some((entry) => entry.script === script))
)
  throw new Error("Verification plan contains an invalid runner test set");
if (!selected.length) throw new Error(`No portable tests registered for ${process.platform}`);
const mode = coreContracts ? "core-contracts" : "portable";
const runId = randomUUID();
const output = resolve(
  process.env.AREAL_PORTABLE_TEST_REPORT ??
    resolve(gui, `../../target/ci/gui/${mode}/${runId}/report.json`),
);
await mkdir(dirname(output), { recursive: true });
const report = {
  schemaVersion: 1,
  planHash: plan?.planHash ?? null,
  itemId: item?.id ?? null,
  mode,
  runId,
  sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: gui }).toString().trim(),
  trackedDiffSha256: createHash("sha256")
    .update(
      execFileSync("git", ["diff", "HEAD", "--binary", "--no-ext-diff", "--no-textconv"], {
        cwd: gui,
      }),
    )
    .digest("hex"),
  ciRunId: process.env.GITHUB_RUN_ID ?? null,
  ciAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  coreSha256: coreAvailable
    ? createHash("sha256")
        .update(await readFile(process.env.AREAL_CORE_BIN))
        .digest("hex")
    : null,
  status: "running",
  platform: process.platform,
  node: process.version,
  startedAt: new Date().toISOString(),
  available,
  scripts: selected,
  excluded: manifest
    .filter((entry) => entry.layer !== "e2e" && !selected.includes(entry.script))
    .map((entry) => ({
      script: entry.script,
      platformSupported: entry.platforms.includes(process.platform),
      missingRequirements: entry.requires.filter((requirement) => !available.includes(requirement)),
    })),
  results: [],
};
const started = performance.now();
const saveReport = async () => {
  await writeFile(`${output}.tmp`, JSON.stringify(report, null, 2) + "\n");
  await rename(`${output}.tmp`, output);
};
await saveReport();
console.log(JSON.stringify(report));
for (const script of selected) {
  const began = performance.now();
  const missing = manifest
    .find((entry) => entry.script === script)
    .requires.filter((requirement) => !available.includes(requirement));
  const result = missing.length
    ? { status: null, signal: null }
    : spawnSync("pnpm", ["run", script], { cwd: gui, stdio: "inherit" });
  report.results.push({
    script,
    passed: result.status === 0 && !result.error,
    status: missing.length ? "blocked" : result.status === 0 && !result.error ? "passed" : "failed",
    missingRequirements: missing,
    exitCode: result.status,
    signal: result.signal,
    error: result.error?.message,
    elapsedMs: Math.round(performance.now() - began),
  });
  report.elapsedMs = Math.round(performance.now() - started);
  report.passed =
    report.results.length === selected.length && report.results.every((result) => result.passed);
  report.status =
    report.results.length < selected.length
      ? "running"
      : report.passed
        ? "passed"
        : report.results.some((result) => result.status === "blocked")
          ? "blocked"
          : "failed";
  await saveReport();
  if (result.status !== 0 || result.error) process.exitCode = 1;
}
console.log(JSON.stringify({ report: output, passed: report.passed, elapsedMs: report.elapsedMs }));
