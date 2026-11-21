// 在冻结源码中恢复两个真实历史缺陷；与绿色基线运行同一生产旅程和证据校验器。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, createWriteStream } from "node:fs";
import { createRequire } from "node:module";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const runner = "clients/gui/scripts/connection-recovery-smoke.mjs";
export const snapshotPaths = [
  "scripts/ci-scope.py",
  "scripts/ci-preflight.py",
  "scripts/verification-evidence.py",
  "scripts/check-journeys.py",
  "scripts/tests/test_architecture_journeys.py",
  "scripts/tests/test_ci_contracts.py",
  "clients/gui/scripts/journey-manifest.json",
  "clients/gui/scripts/test-manifest.json",
  "clients/gui/package.json",
  "docs/development/testing.md",
  "docs/development/testing.en.md",
  runner,
  "clients/gui/scripts/connection-recovery-counterexample.mjs",
  "clients/gui/scripts/connection-recovery-counterexample.test.mjs",
];
export const mutations = [
  {
    id: "premature-unavailable",
    path: "clients/gui/renderer/src/host-snapshot.ts",
    fact: "loadingWithoutFalseFailure",
    assertionId: "loading-no-false-failure",
    triggerEvidence: "loading-observation.json",
    before: `connection: fresh
          ? { state: "ready" }
          : desktopSnapshot?.connection?.state === "unavailable"
            ? desktopSnapshot.connection
            : {
                state: "connecting",
                ...(connectionStage ? { stage: connectionStage } : {}),
              },`,
    after: `connection: {
          state: fresh
            ? "ready"
            : connection.connection === "connecting" ||
                (shell && connection.connection === "offline")
              ? "connecting"
              : "unavailable",
          ...(fresh ? {} : connectionStage ? { stage: connectionStage } : {}),
        },`,
  },
  {
    id: "stale-hibernation-owner",
    path: "clients/gui/renderer/src/state/useSessionNavigation.ts",
    fact: "automaticRecovery",
    assertionId: "idle-automatic-recovery",
    triggerEvidence: "idle-socket-transition.json",
    before: `      previous.hostGeneration === owner.hostGeneration &&
      previous.connectionId === owner.connectionId &&
`,
    after: "",
  },
];

export function mutate(source, mutation) {
  assert.equal(
    source.split(mutation.before).length,
    2,
    `${mutation.id}: expected one exact production boundary`,
  );
  return source.replace(mutation.before, mutation.after);
}

export function judgeAttempt(detail, exitCode, mutation, trigger) {
  assert.equal(
    detail.cleanup.status,
    "passed",
    "fixture cleanup must settle before a result counts",
  );
  if (!mutation) {
    assert.equal(exitCode, 0, "baseline runner must succeed");
    assert.equal(detail.status, "passed", "baseline must prove every required business fact");
    assert(detail.facts.every((fact) => fact.status === "passed"));
    return;
  }
  assert.notEqual(exitCode, 0, "mutation must make the original runner fail");
  assert.equal(detail.status, "failed");
  assert.equal(
    detail.firstFailure?.stage,
    mutation.fact,
    "infrastructure/other-stage failure is not a counterexample",
  );
  assert.equal(
    detail.firstFailure?.assertionId,
    mutation.assertionId,
    "only the target UI oracle can count as detection",
  );
  assert.equal(
    detail.faults?.[mutation.fact]?.injectionReached,
    true,
    "target fault must actually reach this request",
  );
  assert(
    detail.artifacts?.[mutation.triggerEvidence],
    "trigger evidence must be validated by the original importer",
  );
  if (mutation.fact === "loadingWithoutFalseFailure") {
    assert(trigger?.held?.requestId, "held response requires an original request");
    assert.equal(trigger.held.responseHit, trigger.held.requestId);
    assert.equal(
      trigger.held.errorCode,
      null,
      "only a held real successful response exercises loading",
    );
    assert(trigger.held.identity?.connectionId);
    assert(trigger.held.identity?.gatewayGeneration);
  } else {
    assert.equal(trigger?.idleState, "completed");
    assert.equal(trigger?.stopped?.state, "stopped");
    assert.equal(trigger.stopped.scheduleActivationSuppressed, false);
    const { before, after } = trigger.replacement;
    assert(before.connectionId && after.connectionId);
    assert.notEqual(before.connectionId, after.connectionId);
    assert(before.hostId && before.generation);
    assert.equal(after.hostId, before.hostId);
    assert.equal(after.generation, before.generation);
    assert.equal(trigger.successorShell?.connectionId, after.connectionId);
    assert.equal(trigger.successorShell?.gatewayGeneration, after.generation);
    assert(trigger.projectId);
    assert.equal(trigger.successorShell?.project?.projectId, trigger.projectId);
    assert.equal(trigger.successorShell.project.state, "stopped");
    assert.equal(trigger.successorShell.project.scheduleActivationSuppressed, false);
  }
  const target = detail.facts.find((fact) => fact.id === mutation.fact);
  assert.equal(target?.status, "failed", "the targeted business fact must fail");
  assert(target.evidence.length > 0, "target failure must preserve observable evidence");
}

export function summarizeAttempts(attempts) {
  const baseline = attempts.find((attempt) => attempt.id === "baseline");
  const detected = mutations.filter((mutation) =>
    attempts.some((attempt) => attempt.id === mutation.id && attempt.status === "passed"),
  ).length;
  return {
    targetDefectsDetected: detected,
    targetDefectsTotal: mutations.length,
    detectionRate: detected / mutations.length,
    baselineFalsePositive: baseline?.exitCode === undefined ? null : baseline.exitCode !== 0,
    evidenceComplete:
      attempts.length === 3 && attempts.every((attempt) => attempt.evidenceValidated === true),
    humanMinutes: null,
    canConfirmHumanTimeReduction: false,
    interpretation:
      "Known historical mutations, not newly discovered unknown bugs; no measured human-time saving.",
  };
}

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = async (path, value) => writeFile(path, JSON.stringify(value, null, 2) + "\n");
const inside = (root, path) => {
  const name = relative(root, path);
  return name !== ".." && !name.startsWith("../") && !isAbsolute(name);
};
async function exists(path) {
  return lstat(path).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
}
async function command(
  program,
  args,
  { cwd = repo, env = process.env, log, allowFailure = false } = {},
) {
  const output = log ? createWriteStream(log, { flags: "wx" }) : null;
  const child = spawn(program, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (data) => {
    if (output) output.write(data);
    else stdout += data;
  });
  child.stderr.on("data", (data) => {
    if (output) output.write(data);
    else process.stderr.write(data);
  });
  let code;
  try {
    code = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", (status, signal) => done(signal ? 128 : status));
    });
  } finally {
    if (output) await new Promise((done) => output.end(done));
  }
  if (code !== 0 && !allowFailure)
    throw new Error(`${program} exited ${code}; ${log ?? "see stderr"}`);
  return { code, stdout };
}

// 独立 CoW 副本允许 pnpm 重建安装状态；.pnpm 不得经符号链接写回主树。
export async function copyDependencies(source, target, sourceRoot, targetRoot) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isSymbolicLink()) {
      const value = await readlink(from);
      const actual = resolve(dirname(from), value);
      assert(inside(sourceRoot, actual), `dependency link escapes the source checkout: ${from}`);
      await symlink(isAbsolute(value) ? join(targetRoot, relative(sourceRoot, actual)) : value, to);
    } else if (entry.isFile()) {
      await cp(from, to, {
        errorOnExist: true,
        force: false,
        mode: constants.COPYFILE_FICLONE,
      });
    } else if (entry.isDirectory()) {
      if ([".cache", ".vite", ".vite-temp", ".vitest-cache"].includes(entry.name)) continue;
      await copyDependencies(from, to, sourceRoot, targetRoot);
    } else {
      throw new Error(`unsupported dependency filesystem entry: ${from}`);
    }
  }
}

const python = `import importlib.util, json, os, pathlib, shutil, sys
root = pathlib.Path(sys.argv[1]); mode = sys.argv[2]
sys.path.insert(0, str(root / "scripts"))
def load(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), root / ("scripts/" + name + ".py"))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module
if mode == "artifacts":
    v = load("verification"); source = pathlib.Path(sys.argv[3]); destination = root / "target/debug"
    receipt = json.loads((source / v.RECEIPT).read_text()); v.check_files(source, receipt)
    if receipt["inputHash"] != v.source_input_hash(root): raise ValueError("existing Core build does not match frozen source")
    for name in v.artifact_files():
        target = destination / name; target.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(source / name, target)
    v.check_files(destination, receipt)
    (destination / v.RECEIPT).write_text(json.dumps(receipt))
    print(json.dumps({"source":str(source),"files":receipt["files"],"inputHash":receipt["inputHash"]}))
elif mode == "plan":
    scope = load("ci-scope"); plan = scope.repository_plan(root, "HEAD")
    item = next(row for row in plan["items"] if row["id"] == "smoke:test:connection-recovery")
    identity = {"planHash":plan["planHash"], **plan["source"], "ciRunId":os.getenv("GITHUB_RUN_ID"), "ciAttempt":os.getenv("GITHUB_RUN_ATTEMPT")}
    print(json.dumps({"plan":plan,"identity":identity,"contract":item["journeyEvidence"]}))
elif mode == "import":
    state = json.loads(pathlib.Path(sys.argv[3]).read_text()); evidence = load("verification-evidence")
    scope = load("ci-scope")
    if scope.input_key(root, state["identity"]["baseRevision"]) != state["identity"]["inputHash"]: raise ValueError("source changed during journey")
    detail = evidence.read_journey_report(pathlib.Path(sys.argv[4]), state["contract"], state["identity"])
    plan = state["plan"]; check = "smoke:test:connection-recovery"; exit_code = int(sys.argv[5])
    result = {"id":check,"status":"passed" if exit_code == 0 and detail["status"] == "passed" else "failed","exitCode":exit_code,"journeyReport":sys.argv[4],"journeyEvidence":detail}
    pending = [row["id"] for row in plan["items"] if row["id"] != check]
    report = {"schemaVersion":1,"kind":"verification-report","identity":state["identity"],"platform":sys.platform,"status":"failed" if result["status"] == "failed" else "pending","overallStatus":"pending-full","selectedRequired":[check],"pendingRequired":pending,"results":[result] + [{"id":row["id"],"status":"pending","exitCode":None,"reason":"not executed by this isolated counterexample experiment"} for row in plan["items"] if row["id"] != check and sys.platform in row["platforms"]]}
    report["evidence"] = evidence.build(plan, report); evidence.validate(report, plan)
    pathlib.Path(sys.argv[3]).with_name("report.json").write_text(json.dumps(report, indent=2) + "\\n")
    print(json.dumps(detail))
`;

export async function runCounterexamples({ source = repo, output, binaryDirectory } = {}) {
  source = await realpath(source);
  output = output
    ? resolve(output)
    : await mkdtemp(join(tmpdir(), "areal-connection-counterexamples-"));
  await mkdir(output, { recursive: true });
  assert(!(await exists(join(output, "result.json"))), "refusing to overwrite an existing attempt");
  const tree = join(output, "worktree");
  const result = {
    schemaVersion: 1,
    status: "running",
    output,
    source,
    worktree: tree,
    snapshotPaths,
    attempts: [null, ...mutations].map((mutation) => ({
      id: mutation?.id ?? "baseline",
      status: "pending",
      expectedFailure: mutation?.fact ?? null,
      expected: mutation
        ? { fact: mutation.fact, status: "failed" }
        : { facts: "all", status: "passed" },
    })),
    cleanup: { status: "pending" },
  };
  let created = false;
  let safeToRemove = true;
  try {
    const revision = (await command("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim();
    result.sourceRevision = revision;
    const patch = (
      await command("git", ["diff", "--binary", "--no-ext-diff", "HEAD", "--", ...snapshotPaths], {
        cwd: source,
      })
    ).stdout;
    await writeFile(join(output, "snapshot.patch"), patch);
    result.snapshotPatchSha256 = hash(patch);
    await command("git", ["worktree", "add", "--detach", tree, revision], {
      cwd: source,
      log: join(output, "worktree-add.log"),
    });
    created = true;
    if (patch) await command("git", ["apply", join(output, "snapshot.patch")], { cwd: tree });
    const untracked = (
      await command(
        "git",
        ["ls-files", "--others", "--exclude-standard", "-z", "--", ...snapshotPaths],
        { cwd: source },
      )
    ).stdout
      .split("\0")
      .filter(Boolean);
    result.untracked = {};
    for (const path of untracked) {
      assert(snapshotPaths.includes(path), "only explicit pilot files can enter the snapshot");
      assert((await lstat(join(source, path))).isFile(), "snapshot inputs must be regular files");
      await mkdir(dirname(join(tree, path)), { recursive: true });
      await cp(join(source, path), join(tree, path), { errorOnExist: true, force: false });
      result.untracked[path] = hash(await readFile(join(tree, path)));
    }
    const packages = (
      await command("git", ["ls-files", "-z", "--", "**/package.json", "package.json"], {
        cwd: tree,
      })
    ).stdout
      .split("\0")
      .filter(Boolean);
    for (const directory of new Set([
      source,
      ...packages.map((path) => dirname(join(source, path))),
    ])) {
      if (await exists(join(directory, "node_modules")))
        await copyDependencies(
          join(directory, "node_modules"),
          join(tree, relative(source, directory), "node_modules"),
          source,
          tree,
        );
    }
    const require = createRequire(join(source, "clients/gui/app/package.json"));
    const modules = require("yaml").parse(
      await readFile(join(source, "clients/gui/node_modules/.modules.yaml"), "utf8"),
    );
    assert(typeof modules.storeDir === "string" && isAbsolute(modules.storeDir));
    const storeDirectory = /^v\d+$/.test(basename(modules.storeDir))
      ? dirname(modules.storeDir)
      : modules.storeDir;
    result.dependencies = {
      strategy: "independent-copy-on-write-and-offline-frozen-install",
      storeDirectory,
      status: "running",
      log: join(output, "dependencies-install.log"),
    };
    await json(join(output, "result.json"), result);
    await command(
      "pnpm",
      [
        "--dir",
        "clients/gui",
        "install",
        "--offline",
        "--frozen-lockfile",
        "--store-dir",
        storeDirectory,
      ],
      { cwd: tree, log: result.dependencies.log },
    );
    result.dependencies.status = "passed";
    const coreSource = resolve(
      binaryDirectory ?? process.env.AREAL_COUNTEREXAMPLE_CORE_DIR ?? join(source, "target/debug"),
    );
    result.coreArtifacts = JSON.parse(
      (await command("python3", ["-c", python, tree, "artifacts", coreSource], { cwd: tree }))
        .stdout,
    );
    const originals = new Map(
      await Promise.all(
        mutations.map(async (mutation) => [
          mutation.path,
          await readFile(join(tree, mutation.path), "utf8"),
        ]),
      ),
    );
    const runnerHash = hash(await readFile(join(tree, runner)));
    result.runnerSha256 = runnerHash;
    for (const mutation of [null, ...mutations]) {
      const id = mutation?.id ?? "baseline";
      const directory = join(output, id);
      await mkdir(directory);
      const attempt = result.attempts.find((entry) => entry.id === id);
      Object.assign(attempt, { status: "running", directory });
      for (const [path, text] of originals) await writeFile(join(tree, path), text);
      if (mutation) {
        const before = originals.get(mutation.path);
        const after = mutate(before, mutation);
        await writeFile(join(tree, mutation.path), after);
        attempt.mutation = {
          path: mutation.path,
          beforeSha256: hash(before),
          afterSha256: hash(after),
        };
        const mutationPatch = (await command("git", ["diff", "--", mutation.path], { cwd: tree }))
          .stdout;
        await writeFile(join(directory, "mutation.patch"), mutationPatch);
        attempt.mutation.patchSha256 = hash(mutationPatch);
      }
      await json(join(output, "result.json"), result);
      // 基线先构建本树所有 JS 依赖；后续只重建发生变异的 Renderer。
      await command(
        "pnpm",
        mutation ? ["--dir", "clients/gui/renderer", "build"] : ["--dir", "clients/gui", "build"],
        { cwd: tree, log: join(directory, "build.log") },
      );
      await command(
        "python3",
        [
          "scripts/verification.py",
          "--root",
          tree,
          "doctor",
          "--core",
          join(tree, "target/debug/areal"),
          "--report",
          join(directory, "startup.json"),
        ],
        { cwd: tree, log: join(directory, "doctor.log") },
      );
      const state = JSON.parse(
        (await command("python3", ["-c", python, tree, "plan"], { cwd: tree })).stdout,
      );
      attempt.identity = state.identity;
      await json(join(directory, "plan.json"), state.plan);
      await json(join(directory, "identity.json"), state);
      assert.equal(
        hash(await readFile(join(tree, runner))),
        runnerHash,
        "original journey assertions changed",
      );
      const reportPath = join(directory, "journey/report.json");
      await mkdir(dirname(reportPath));
      safeToRemove = false;
      const execution = await command(process.execPath, [runner], {
        cwd: tree,
        log: join(directory, "runner.log"),
        allowFailure: true,
        env: {
          ...process.env,
          AREAL_CORE_BIN: join(tree, "target/debug/areal"),
          AREAL_JOURNEY_REPORT: reportPath,
          AREAL_VERIFICATION_IDENTITY: JSON.stringify(state.identity),
        },
      });
      attempt.exitCode = execution.code;
      const detail = JSON.parse(
        (
          await command(
            "python3",
            [
              "-c",
              python,
              tree,
              "import",
              join(directory, "identity.json"),
              reportPath,
              String(execution.code),
            ],
            { cwd: tree },
          )
        ).stdout,
      );
      await json(join(directory, "imported-journey.json"), detail);
      attempt.evidenceValidated = true;
      attempt.observed = detail.facts;
      attempt.firstFailure = detail.firstFailure;
      attempt.unreached = detail.unreached;
      attempt.cleanup = detail.cleanup;
      safeToRemove = detail.cleanup.status === "passed";
      const trigger = mutation
        ? JSON.parse(await readFile(join(dirname(reportPath), mutation.triggerEvidence), "utf8"))
        : undefined;
      attempt.fault = mutation ? detail.faults?.[mutation.fact] : null;
      judgeAttempt(detail, execution.code, mutation, trigger);
      attempt.status = "passed";
    }
    result.status = "passed";
  } catch (error) {
    result.status = "failed";
    result.error = error.message;
    if (result.dependencies?.status === "running") result.dependencies.status = "failed";
    const active = result.attempts.find((attempt) => attempt.status === "running");
    if (active?.status === "running") active.status = "failed";
  } finally {
    result.metrics = summarizeAttempts(result.attempts);
    if (created && safeToRemove) {
      try {
        await command("git", ["worktree", "remove", "--force", tree], {
          cwd: source,
          log: join(output, "worktree-remove.log"),
        });
        result.cleanup = { status: "passed", worktreeRemoved: true };
      } catch (error) {
        result.cleanup = { status: "failed", error: error.message };
        result.status = "failed";
      }
    } else
      result.cleanup = {
        status: created ? "blocked" : "passed",
        worktreeRemoved: !created,
        reason: created
          ? "retained until original fixture cleanup is proven"
          : "no worktree created",
      };
    await json(join(output, "result.json"), result);
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert(
    args.length === 0 || (args.length === 2 && args[0] === "--output"),
    "usage: node connection-recovery-counterexample.mjs [--output NEW_DIRECTORY]",
  );
  const result = await runCounterexamples({ output: args[1] });
  console.log(
    JSON.stringify({
      status: result.status,
      report: join(result.output, "result.json"),
      error: result.error,
    }),
  );
  process.exitCode = result.status === "passed" ? 0 : 1;
}
