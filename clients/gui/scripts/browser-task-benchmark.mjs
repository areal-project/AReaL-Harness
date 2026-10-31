import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  mkdir,
  readFile,
  readdir,
  writeFile,
  rename,
  realpath,
  stat,
  open,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { arch, loadavg, platform, release, cpus } from "node:os";
import {
  BUDGET,
  TASK_IDS,
  TASK_CATALOG,
  SINGLE_TASK_CATALOG,
  GENERATED_TASK,
  SOURCE_GROUP,
  PAIRED_TASK_CATALOG,
  gradeTask,
} from "./browser-task-benchmark-catalog.mjs";
import { externalSourcesManifest } from "./browser-task-external-sources.mjs";
import { makeTempDir } from "./support/temp.mjs";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const sha = (value) => createHash("sha256").update(value).digest("hex");
export function parseOptions(argv) {
  const options = { mode: "plan", authorized: false };
  let modes = 0;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (["--plan", "--fixture", "--real"].includes(flag)) {
      options.mode = flag.slice(2);
      modes++;
    } else if (flag === "--authorized") options.authorized = true;
    else if (flag === "--resume") options.resume = true;
    else if (
      [
        "--output",
        "--protocol",
        "--upstream",
        "--model",
        "--credential-env",
        "--paired-config",
        "--task",
      ].includes(flag)
    ) {
      assert.ok(argv[index + 1] && !argv[index + 1].startsWith("--"), `${flag} requires a value`);
      options[
        {
          "--output": "output",
          "--protocol": "protocol",
          "--upstream": "upstream",
          "--model": "model",
          "--credential-env": "credentialEnv",
          "--paired-config": "pairedConfig",
          "--task": "taskId",
        }[flag]
      ] = argv[++index];
    } else throw Error(`Unknown flag ${flag}`);
  }
  assert.ok(modes <= 1, "Choose one of --plan, --fixture, --real");
  assert.ok(
    !(options.taskId && options.pairedConfig),
    "--task is a standalone acceptance and cannot select a paired workload subset",
  );
  assert.ok(
    !(options.taskId && options.resume),
    "Standalone tasks are never replayed through --resume",
  );
  if (options.taskId)
    assert.ok(
      SINGLE_TASK_CATALOG.some((task) => task.id === options.taskId),
      "Unknown standalone task",
    );
  return options;
}

export function cleanChildEnvironment(environment, credentialEnv) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) =>
        key !== credentialEnv &&
        !/^(AREAL_|OPENAI_|ANTHROPIC_|CODEX_|CHATGPT_)/.test(key) &&
        !/(API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|CREDENTIAL)/i.test(key),
    ),
  );
}

// 所有重试、辅助请求和权限模型请求都经过同一计数门；不转换供应商协议。
export async function createProviderGate({ upstream, secret, recordPath }) {
  const target = new URL(upstream);
  assert.ok(["https:", "http:"].includes(target.protocol));
  assert.ok(
    !target.username && !target.password && !target.search && !target.hash,
    "Upstream URL must not carry credentials or query data",
  );
  const attempts = [];
  const active = new Set();
  let closed = false;
  let forwardedCount = 0;
  let writes = Promise.resolve();
  const persist = () => {
    if (recordPath) {
      const snapshot = structuredClone(attempts);
      writes = writes.then(() => atomicJSON(recordPath, snapshot));
    }
    return writes;
  };
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/_status") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ inFlight: active.size }));
      return;
    }
    const record = {
      ordinal: attempts.length + 1,
      startedAtUnixMs: Date.now(),
      status: "received",
      httpStatus: null,
    };
    attempts.push(record);
    await persist();
    let body = Buffer.alloc(0);
    try {
      for await (const chunk of request) {
        body = Buffer.concat([body, chunk]);
        assert.ok(body.length <= 16 * 1024 * 1024, "Model request exceeds 16 MiB");
      }
      record.bodySHA256 = sha(body);
      record.bodyBytes = body.length;
      const value = JSON.parse(body);
      record.parameters = Object.fromEntries(
        ["model", "reasoning", "service_tier", "max_output_tokens", "temperature"]
          .filter((key) => value[key] !== undefined)
          .map((key) => [key, value[key]]),
      );
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/responses");
      assert.ok(!closed && forwardedCount < BUDGET.maxHttpRequests, "All-request cap reached");
      assert.equal(value.model, "gpt-6.1-terra");
      assert.ok(
        Number.isInteger(value.max_output_tokens) &&
          value.max_output_tokens > 0 &&
          value.max_output_tokens <= BUDGET.maxOutputTokensPerRequest,
        "Unbounded model output request rejected",
      );
      assert.equal(value.temperature, undefined, "Temperature must remain omitted");
      assert.equal(value.service_tier, "default");
      assert.equal(value.reasoning?.effort, "medium");
      const forward = target.protocol === "https:" ? httpsRequest : httpRequest;
      const pending = forward(target, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${secret}`,
          "Content-Length": body.length,
        },
      });
      active.add(pending);
      const settle = (status) => {
        if (!active.delete(pending)) return;
        record.status = status;
        record.endedAtUnixMs = Date.now();
        void persist().catch(() => {});
      };
      record.status = "forwarded";
      record.forwarded = true;
      forwardedCount++;
      pending.once("response", (incoming) => {
        record.httpStatus = incoming.statusCode;
        void persist().catch(() => {});
        response.writeHead(incoming.statusCode, {
          "Content-Type": incoming.headers["content-type"] ?? "text/event-stream",
        });
        incoming.on("end", () => settle("completed"));
        incoming.on("error", () => {
          settle("response_error");
          response.destroy();
        });
        incoming.pipe(response);
      });
      pending.on("error", () => {
        settle("transport_error");
        if (!response.headersSent) response.writeHead(502);
        response.end("Provider transport failed");
      });
      response.on("close", () => {
        if (!response.writableFinished) {
          settle("cancelled");
          pending.destroy();
        }
      });
      await persist();
      pending.end(body);
    } catch (error) {
      record.status = "blocked";
      record.reason = error.message;
      await persist();
      if (!response.headersSent) response.writeHead(429);
      response.end("Request blocked by pilot budget or frozen configuration");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    endpoint: `${origin}/v1/responses`,
    statusEndpoint: `${origin}/_status`,
    attempts,
    flush: () => writes,
    get inFlight() {
      return active.size;
    },
    async close() {
      closed = true;
      for (const pending of active) pending.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await writes;
    },
  };
}

async function provenance() {
  const require = createRequire(join(gui, "app/package.json"));
  const binary = process.env.AREAL_CORE_BIN ?? join(root, ".local/dev-bin/areal");
  const paths = [
    "scripts/browser-task-benchmark.mjs",
    "scripts/browser-task-benchmark-catalog.mjs",
    "scripts/browser-task-benchmark-driver.mjs",
    "scripts/automation-core-smoke.mjs",
    "app/src/core/browser-tool.cjs",
    "app/src/core/service-protocol.cjs",
    "app/src/core/preview-native/native-targets.cjs",
    "packages/browser-automation/src/upstream/browser/browserPlaywrightLocatorExecutor.ts",
    "packages/browser-automation/dist/index.cjs",
    "app/src/core/preview-native/documents.cjs",
    "renderer/dist/index.html",
    "pnpm-lock.yaml",
    "packages/browser-automation/dist/electron.cjs",
  ];
  const assets = await readdir(join(gui, "renderer/dist/assets")).catch(() => []);
  paths.push(
    ...assets
      .filter((path) => /\.(js|css)$/.test(path))
      .map((path) => `renderer/dist/assets/${path}`),
  );
  const hashes = Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [path, await readFile(join(gui, path)).then(sha, () => null)]),
    ),
  );
  hashes.coreBinary = await readFile(binary).then(sha, () => null);
  hashes.electronExecutable = await readFile(
    process.env.AREAL_ELECTRON_EXECUTABLE ?? require("electron"),
  ).then(sha, () => null);
  return {
    sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    dirtyDiffSHA256: sha(execFileSync("git", ["diff", "HEAD"], { cwd: root })),
    hashes,
  };
}

export function usageSummary(audits) {
  const observed = audits.filter((audit) => audit.usageObserved === true);
  const actualTiers = [
    ...new Set(observed.map((audit) => audit.usageDetails?.serviceTier).filter(Boolean)),
  ];
  return {
    status: audits.length && observed.length === audits.length ? "observed" : "unknown",
    requests: audits.length,
    requestsWithUsage: observed.length,
    httpAttempts: audits.reduce((n, audit) => n + (audit.httpAttempts ?? 0), 0),
    knownUsageLowerBound: observed.reduce((sum, audit) => {
      for (const [key, value] of Object.entries(audit.usage ?? {}))
        if (typeof value === "number") sum[key] = (sum[key] ?? 0) + value;
      return sum;
    }, {}),
    actualTiers,
    actualTierStatus:
      actualTiers.length &&
      observed.length === audits.length &&
      observed.every((audit) => audit.usageDetails?.serviceTier)
        ? "observed"
        : "unknown",
  };
}

export async function runChild(configuration, directory, options) {
  const configPath = join(directory, "child-config.json");
  await atomicJSON(configPath, configuration);
  const env = cleanChildEnvironment(process.env, options.credentialEnv);
  env.AREAL_CORE_BIN =
    options.arm?.coreBinary ?? process.env.AREAL_CORE_BIN ?? join(root, ".local/dev-bin/areal");
  if (options.arm?.electronExecutable ?? process.env.AREAL_ELECTRON_EXECUTABLE)
    env.AREAL_ELECTRON_EXECUTABLE =
      options.arm?.electronExecutable ?? process.env.AREAL_ELECTRON_EXECUTABLE;
  const child = spawn(
    process.execPath,
    [
      options.arm?.launcherPath ?? join(gui, "scripts/automation-core-smoke.mjs"),
      ...(options.arm ? ["--app-root", options.arm.appRoot] : []),
      "--suite",
      "browser",
      "--task-benchmark-config",
      configPath,
    ],
    { env, cwd: options.arm?.appRoot ?? root, stdio: ["ignore", "pipe", "pipe"] },
  );
  const log = [];
  child.stdout.on("data", (chunk) => log.push(chunk));
  child.stderr.on("data", (chunk) => log.push(chunk));
  // setup 120 秒、任务 180 秒、终止结算 10 秒和既有 cleanup 预留。
  const timer = setTimeout(() => child.kill("SIGTERM"), BUDGET.childTerminateAfterMs);
  const force = setTimeout(() => child.kill("SIGKILL"), BUDGET.childKillAfterMs);
  const outcome = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ spawnError: error.message }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  clearTimeout(force);
  await writeFile(join(directory, "child.log"), Buffer.concat(log));
  return { ...outcome, pid: child.pid };
}

export async function atomicJSON(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, path);
}

const forwardedRequest = (request) =>
  request.forwarded === true ||
  ["forwarded", "completed", "cancelled", "transport_error", "response_error"].includes(
    request.status,
  );

export function reconcileUsage(audits, requests, auditErrors = []) {
  const summary = usageSummary(audits);
  const forwarded = requests.filter(forwardedRequest);
  const groups = new Map();
  for (const request of requests) {
    if (!request.bodySHA256) continue;
    const group = groups.get(request.bodySHA256) ?? { requests: [], audits: [] };
    group.requests.push(request);
    groups.set(request.bodySHA256, group);
  }
  for (const audit of audits) {
    const group = groups.get(audit.bodySha256) ?? { requests: [], audits: [] };
    group.audits.push(audit);
    groups.set(audit.bodySha256, group);
  }
  const purposes = {};
  let unmatchedForwarded = forwarded.filter((request) => !request.bodySHA256).length;
  let matchedForwarded = 0;
  let usageCoveredForwarded = 0;
  let ambiguousGroups = 0;
  for (const group of groups.values()) {
    const sent = group.requests.filter(forwardedRequest).length;
    const auditAttempts = group.audits.reduce(
      (n, audit) =>
        n +
        (Number.isInteger(audit.httpAttempts) && audit.httpAttempts > 0 ? audit.httpAttempts : 0),
      0,
    );
    const names = [...new Set(group.audits.map((audit) => audit.purpose))];
    if (
      !group.audits.length ||
      auditAttempts !== group.requests.length ||
      names.length !== 1 ||
      !names[0]
    ) {
      unmatchedForwarded += sent;
      ambiguousGroups++;
      continue;
    }
    matchedForwarded += sent;
    const purpose = purposes[names[0]] ?? {
      logicalRequests: 0,
      httpAttempts: 0,
      forwardedHttp: 0,
      blockedHttp: 0,
    };
    purpose.logicalRequests += group.audits.length;
    purpose.httpAttempts += auditAttempts;
    purpose.forwardedHttp += sent;
    purpose.blockedHttp += group.requests.length - sent;
    purposes[names[0]] = purpose;
    // 重试前的计费未知，终态单份 usage 不能证明每次 HTTP 都有回执。
    if (
      group.audits.every((audit) => audit.usageObserved === true && audit.httpAttempts === 1) &&
      sent === group.audits.length
    )
      usageCoveredForwarded += sent;
  }
  const countComplete =
    forwarded.length > 0 &&
    matchedForwarded === forwarded.length &&
    ambiguousGroups === 0 &&
    auditErrors.length === 0;
  const usageComplete = countComplete && usageCoveredForwarded === forwarded.length;
  return {
    ...summary,
    status: usageComplete ? "observed" : summary.requestsWithUsage ? "partial" : "unknown",
    actualTierStatus:
      usageComplete && summary.actualTierStatus === "observed" ? "observed" : "unknown",
    solveLogicalRequests: purposes.Solve?.logicalRequests ?? null,
    solveHttpAttempts: purposes.Solve?.forwardedHttp ?? null,
    solveCountComplete: countComplete && Boolean(purposes.Solve),
    purposes,
    coverage: {
      forwardedHttp: forwarded.length,
      blockedHttp: requests.filter((request) => request.status === "blocked").length,
      matchedForwardedHttp: matchedForwarded,
      unmatchedForwardedHttp: unmatchedForwarded,
      usageCoveredForwardedHttp: usageCoveredForwarded,
      ambiguousGroups,
      auditErrors: auditErrors.length,
      countComplete,
      usageComplete,
    },
  };
}

export function buildPairedSchedule(
  tasks = PAIRED_TASK_CATALOG,
  seed = "browser-hillclimb-v2-guide-20261031",
) {
  const instanceSeeds = [104729, 130363, 155921, 181081, 206369];
  const pairs = tasks
    .flatMap((task) =>
      instanceSeeds.map((instanceSeed, index) => ({
        taskId: task.id,
        sourceGroup: task.sourceId,
        safety: task.safety === true,
        repeat: index + 1,
        instanceSeed,
        order: sha(`${seed}|pair|${task.id}|${index + 1}`),
      })),
    )
    .sort((a, b) => a.order.localeCompare(b.order));
  return pairs
    .flatMap(({ order: _order, ...pair }) => {
      const first =
        parseInt(sha(`${seed}|arm|${pair.taskId}|${pair.repeat}`).slice(0, 2), 16) % 2 === 0;
      return (first ? ["A", "B"] : ["B", "A"]).map((arm) => ({ ...pair, arm }));
    })
    .map((attempt, index) => ({ sequence: index + 1, ...attempt, status: "planned" }));
}

async function hashTree(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const hashes = {};
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (["node_modules", ".git", ".scratch"].includes(entry.name)) continue;
    const key = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(hashes, await hashTree(path, key));
    else if (entry.isFile()) hashes[key] = sha(await readFile(path));
    else if (entry.isSymbolicLink()) {
      const actual = await realpath(path);
      if ((await stat(actual)).isFile()) hashes[key] = sha(await readFile(actual));
    }
  }
  return hashes;
}

export async function armProvenance(arm) {
  for (const field of ["appRoot", "launcherPath", "coreBinary", "electronExecutable"])
    assert.ok(
      typeof arm[field] === "string" && resolve(arm[field]) === arm[field],
      `Arm ${field} must be absolute`,
    );
  assert.equal(
    await realpath(arm.launcherPath),
    await realpath(join(gui, "scripts/automation-core-smoke.mjs")),
    "Both arms must use the frozen common launcher",
  );
  const appPath = arm.appRoot;
  const productGUI = dirname(appPath);
  const productRoot = resolve(appPath, "../../..");
  const packageJSON = JSON.parse(await readFile(join(appPath, "package.json"), "utf8"));
  const resolvedPackages = {};
  const packageHashes = {};
  for (const name of Object.keys(packageJSON.dependencies).filter((name) =>
    name.startsWith("@areal/"),
  )) {
    const path = await realpath(join(appPath, "node_modules", name));
    resolvedPackages[name] = path;
    packageHashes[name] = await hashTree(path);
  }
  const contents = resolve(dirname(arm.electronExecutable), "..");
  const electronBundle = {};
  for (const file of [
    "Info.plist",
    "Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
    "Frameworks/Electron Framework.framework/Resources/Info.plist",
  ])
    electronBundle[file] = await readFile(join(contents, file)).then(sha, () => null);
  if (platform() === "darwin")
    assert.ok(
      Object.values(electronBundle).every(Boolean),
      "Electron bundle identity is incomplete",
    );
  return {
    appRoot: await realpath(arm.appRoot),
    appPath: await realpath(appPath),
    productRoot,
    mainEntry: await realpath(join(appPath, packageJSON.main)),
    launcherPath: await realpath(arm.launcherPath),
    coreBinary: await realpath(arm.coreBinary),
    electronExecutable: await realpath(arm.electronExecutable),
    sourceHead: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: productRoot,
      encoding: "utf8",
    }).trim(),
    owningDiffSHA256: sha(
      execFileSync(
        "git",
        [
          "diff",
          "--binary",
          "HEAD",
          "--",
          "clients/gui/app",
          "clients/gui/packages",
          "clients/gui/renderer",
        ],
        { cwd: productRoot },
      ),
    ),
    hashes: {
      mainSources: await hashTree(join(appPath, "src")),
      packageJSON: sha(await readFile(join(appPath, "package.json"))),
      renderer: await hashTree(join(productGUI, "renderer/dist")),
      packages: packageHashes,
      lockfile: sha(await readFile(join(productGUI, "pnpm-lock.yaml"))),
      coreBinary: sha(await readFile(arm.coreBinary)),
      runtimeBinaries: Object.fromEntries(
        await Promise.all(
          ["areal-runtime", "areal-runtime-fs", "areal-runtime-reaper"].map(async (file) => [
            file,
            sha(await readFile(join(dirname(arm.coreBinary), file))),
          ]),
        ),
      ),
      electronExecutable: sha(await readFile(arm.electronExecutable)),
      electronBundle,
    },
    resolvedPackages,
  };
}

export async function pairedProvenance(configuration) {
  return {
    harness: {
      root,
      scripts: await hashTree(join(gui, "scripts")),
      mainHelpers: await hashTree(join(gui, "app/src")),
      runtimeClientPath: await realpath(join(gui, "packages/runtime-client")),
      runtimeClient: await hashTree(join(gui, "packages/runtime-client")),
    },
    arms: {
      A: await armProvenance(configuration.arms.A),
      B: await armProvenance(configuration.arms.B),
    },
  };
}

export function attemptIdentity(attempt) {
  const { sequence, taskId, sourceGroup, repeat, instanceSeed, safety, arm } = attempt;
  return { sequence, taskId, sourceGroup, repeat, instanceSeed, safety, arm };
}

export function validateCompletedReceipt(attempt, receipt, freezeDigest) {
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.freezeDigest, freezeDigest, "Attempt freeze differs");
  assert.deepEqual(receipt.identity, attemptIdentity(attempt), "Attempt identity differs");
  assert.deepEqual(
    attemptIdentity(receipt.attempt),
    attemptIdentity(attempt),
    "Completed receipt belongs to another attempt",
  );
  assert.equal(receipt.complete, true, "Only completed receipts may be resumed");
  assert.equal(receipt.attempt.sourceStable, true, "Artifact drift cannot be resumed");
  assert.equal(receipt.attempt.cleanupValid, true, "Unproven cleanup blocks the next attempt");
  assert.ok(
    ["completed", "failed", "interrupted", "timeout", "blocked"].includes(receipt.attempt.status),
    "Unsettled attempt cannot be resumed",
  );
}

export function validateFrozenProvider(provider, upstream, required = false) {
  assert.equal(provider?.name, "Arena", "Paired experiments require the frozen Arena provider");
  assert.equal(provider.protocol, "responses");
  assert.match(
    provider.endpointSHA256 ?? "",
    /^[a-f0-9]{64}$/,
    "Frozen endpoint SHA256 is required",
  );
  if (upstream === undefined && !required) return;
  assert.ok(upstream, "Explicit frozen upstream endpoint is required");
  const target = new URL(upstream);
  assert.ok(
    ["https:", "http:"].includes(target.protocol) &&
      !target.username &&
      !target.password &&
      !target.search &&
      !target.hash,
    "Upstream must be an HTTP(S) URL without credentials, query, or fragment",
  );
  assert.equal(
    sha(upstream),
    provider.endpointSHA256,
    "Upstream differs from the frozen provider endpoint",
  );
}

export function applyChildExit(result, child) {
  const valid = child.code === 0 && !child.signal && !child.spawnError;
  const claimedSuccess =
    result.grading?.qualityPassed === true || result.grading?.taskCompleted === true;
  result.exit = {
    code: child.code ?? null,
    signal: child.signal ?? null,
    spawnError: child.spawnError ?? null,
    valid,
    reportedTaskStatus: result.status,
    claimedSuccess,
    validityBlocker: claimedSuccess && !valid,
  };
  if (result.exit.validityBlocker)
    result.grading = {
      ...result.grading,
      valid: false,
      taskCompleted: false,
      qualityPassed: false,
      safetyOutcome:
        result.grading.safetyOutcome === "passed" ? "failed" : result.grading.safetyOutcome,
      checks: { ...result.grading.checks, successfulChildExit: false },
    };
  return result;
}

export async function runPairedExperiment(options) {
  const configuration = JSON.parse(await readFile(resolve(options.pairedConfig), "utf8"));
  validateFrozenProvider(configuration.provider, options.upstream, options.mode === "real");
  assert.match(configuration.experimentId, /^[a-z0-9][a-z0-9-]+$/);
  assert.ok(
    configuration.arms?.A && configuration.arms?.B,
    "Explicit A/B arm artifacts are required",
  );
  const output = options.output
    ? resolve(options.output)
    : await makeTempDir("areal-browser-paired-");
  await mkdir(output, { recursive: true });
  const lockPath = join(output, "runner.lock");
  const lock = await open(lockPath, "wx");
  await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  try {
    const manifestPath = join(output, "manifest.json");
    const configDigest = sha(JSON.stringify(configuration));
    const provenance = await pairedProvenance(configuration);
    const freeze = {
      experimentId: configuration.experimentId,
      configuration,
      configDigest,
      provider: configuration.provider,
      provenance,
      tasks: PAIRED_TASK_CATALOG,
      sources: externalSourcesManifest,
      budgets: BUDGET,
      model: {
        name: "gpt-6.1-terra",
        protocol: "responses",
        reasoningEffort: "medium",
        serviceTier: "default",
      },
      policy: { normalControlsOnly: true, arbitraryEvaluation: "denied", taskReruns: 0 },
      schedule: buildPairedSchedule(PAIRED_TASK_CATALOG, configuration.seed),
    };
    const freezeDigest = sha(JSON.stringify(freeze));
    let manifest;
    if (options.resume) {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      assert.equal(
        manifest.freezeDigest,
        freezeDigest,
        "Frozen configuration, harness, or product artifacts drifted",
      );
      assert.deepEqual(
        manifest.attempts.map(attemptIdentity),
        freeze.schedule.map(attemptIdentity),
      );
    } else {
      await assert.rejects(
        readFile(manifestPath),
        "Existing experiment requires --resume; receipts are never overwritten",
      );
      manifest = {
        schemaVersion: 2,
        benchmarkVersion: "browser-paired-task-v2",
        freeze,
        freezeDigest,
        phase: options.mode,
        runStatus: "planned",
        attempts: structuredClone(freeze.schedule),
        realModel: { status: "not_run" },
        environment: {
          node: process.version,
          os: `${platform()} ${release()}`,
          arch: arch(),
          cpuCount: cpus().length,
          loadAverage: loadavg(),
        },
      };
      await atomicJSON(manifestPath, manifest);
    }
    if (options.mode === "plan") {
      console.log(
        JSON.stringify({
          manifest: manifestPath,
          freezeDigest,
          attempts: manifest.attempts.length,
          realModel: "not_run",
        }),
      );
      return manifest;
    }
    if (options.mode === "real") {
      assert.equal(options.authorized, true, "Provider authorization flag is required");
      assert.equal(options.protocol, "responses");
      assert.equal(options.model, "gpt-6.1-terra");
      assert.ok(
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(options.credentialEnv ?? "") &&
          process.env[options.credentialEnv],
        "Explicit credential environment is required",
      );
      assert.ok(options.upstream, "Explicit upstream endpoint is required");
    }
    manifest.phase = options.mode;
    manifest.runStatus = "running";
    const save = () => atomicJSON(manifestPath, manifest);
    for (const attempt of manifest.attempts) {
      const identity = attemptIdentity(attempt);
      const directory = join(
        output,
        "attempts",
        `${String(attempt.sequence).padStart(3, "0")}-${attempt.taskId.replaceAll("/", "-")}-r${attempt.repeat}-${attempt.arm}`,
      );
      const receiptPath = join(directory, "attempt.json");
      if (attempt.status !== "planned") {
        const receipt = JSON.parse(
          await readFile(receiptPath, "utf8").catch(() => {
            throw Error(
              `UNKNOWN attempt ${attempt.sequence}; missing completed receipt, no replay allowed`,
            );
          }),
        );
        validateCompletedReceipt(attempt, receipt, freezeDigest);
        assert.equal(sha(await readFile(join(directory, "result.json"))), receipt.resultSHA256);
        assert.equal(
          sha(await readFile(join(directory, "http-requests.json"))),
          receipt.httpSHA256,
        );
        Object.assign(attempt, receipt.attempt);
        continue;
      }
      const current = await pairedProvenance(configuration);
      assert.deepEqual(
        current,
        provenance,
        "Artifacts drifted before attempt; start a new experiment after repair",
      );
      await mkdir(join(output, "attempts"), { recursive: true });
      await mkdir(directory);
      Object.assign(attempt, { status: "running", startedAt: new Date().toISOString(), directory });
      await save();
      let gate;
      const resultPath = join(directory, "result.json");
      try {
        if (options.mode === "real")
          gate = await createProviderGate({
            upstream: options.upstream,
            secret: process.env[options.credentialEnv],
            recordPath: join(directory, "http-requests.json"),
          });
        const child = await runChild(
          {
            mode: options.mode,
            taskId: attempt.taskId,
            instanceSeed: attempt.instanceSeed,
            protocol: options.protocol,
            model: options.model,
            modelEndpoint: gate?.endpoint,
            statusEndpoint: gate?.statusEndpoint,
            resultPath,
            identity,
            freezeDigest,
            normalControlsOnly: true,
          },
          directory,
          { ...options, arm: configuration.arms[attempt.arm] },
        );
        attempt.child = child;
        const result = JSON.parse(await readFile(resultPath, "utf8"));
        assert.deepEqual(result.identity, identity, "Child receipt identity differs");
        assert.equal(result.freezeDigest, freezeDigest);
        await gate?.flush();
        result.httpRequests = gate?.attempts ?? [];
        result.providerInFlightAtCleanup = gate?.inFlight ?? 0;
        result.grading = gradeTask(attempt.taskId, result);
        applyChildExit(result, child);
        const after = await pairedProvenance(configuration);
        const sourceStable = JSON.stringify(after) === JSON.stringify(provenance);
        const cleanupValid =
          !child.signal &&
          result.cleanup?.electronStopped === true &&
          result.cleanup?.applicationStopped === true &&
          result.providerInFlightAtCleanup === 0;
        result.integrity = { sourceStable };
        result.usage = reconcileUsage(
          result.audits ?? [],
          result.httpRequests,
          result.auditErrors ?? [],
        );
        await atomicJSON(resultPath, result);
        const invalidArguments = { setChecked: 0, describeTopic: 0, capture: 0, other: 0 };
        const toolCalls = (result.history?.turns ?? [])
          .flatMap((turn) => turn.items ?? [])
          .filter((item) => item.type === "dynamicToolCall");
        for (const call of toolCalls) {
          if (call.success === true || !JSON.stringify(call).includes("INVALID_ARGUMENT")) continue;
          const key =
            call.arguments?.operation === "capture"
              ? "capture"
              : call.arguments?.operation === "describe"
                ? "describeTopic"
                : JSON.stringify(call.arguments).includes("setChecked")
                  ? "setChecked"
                  : "other";
          invalidArguments[key]++;
        }
        Object.assign(attempt, {
          status: result.status ?? "unknown",
          grading: result.grading,
          exit: result.exit,
          cleanup: result.cleanup,
          cleanupValid,
          sourceStable,
          evidence: result.evidence,
          result: resultPath,
          timings: result.timings ?? null,
          elapsedMs: result.elapsedMs ?? null,
          usage: result.usage,
          processes: result.processes,
          httpResponseStatuses: Object.fromEntries(
            [...new Set(result.httpRequests.map((request) => request.httpStatus ?? "unknown"))].map(
              (status) => [
                status,
                result.httpRequests.filter(
                  (request) => (request.httpStatus ?? "unknown") === status,
                ).length,
              ],
            ),
          ),
          httpStatusCounts: Object.fromEntries(
            [...new Set(result.httpRequests.map((request) => request.status))].map((status) => [
              status,
              result.httpRequests.filter((request) => request.status === status).length,
            ]),
          ),
          httpRequests: result.httpRequests.length,
          forwardedRequests: result.httpRequests.filter(forwardedRequest).length,
          blockedRequests: result.httpRequests.filter((item) => item.status === "blocked").length,
          toolCalls: toolCalls.length,
          invalidArguments,
          endedAt: new Date().toISOString(),
        });
        await atomicJSON(join(directory, "http-requests.json"), result.httpRequests);
        await atomicJSON(receiptPath, {
          schemaVersion: 1,
          identity,
          freezeDigest,
          complete: cleanupValid && sourceStable && attempt.status !== "unknown",
          resultSHA256: sha(await readFile(resultPath)),
          httpSHA256: sha(await readFile(join(directory, "http-requests.json"))),
          attempt,
        });
        if (!cleanupValid || !sourceStable || attempt.status === "unknown") {
          manifest.runStatus = "blocked";
          manifest.blocker = `Attempt ${attempt.sequence} has unproven cleanup, UNKNOWN, or artifact drift; no next attempt is allowed`;
        }
      } catch (error) {
        attempt.status = "unknown";
        attempt.reason = error.message;
        manifest.runStatus = "blocked";
        manifest.blocker = `Attempt ${attempt.sequence} requires authoritative reconciliation; replay is forbidden`;
      } finally {
        if (gate) {
          attempt.httpRequests = gate.attempts.length;
          attempt.forwardedRequests = gate.attempts.filter(forwardedRequest).length;
          manifest.realModel.status =
            attempt.forwardedRequests > 0 ? "run" : manifest.realModel.status;
          await gate.close();
          await atomicJSON(join(directory, "http-requests.json"), gate.attempts);
        }
        await save();
      }
      if (manifest.runStatus === "blocked") break;
    }
    if (manifest.runStatus !== "blocked") manifest.runStatus = "completed";
    manifest.integrity = {
      sourceStable: manifest.attempts.every((attempt) => attempt.sourceStable),
      artifactsAvailable: true,
    };
    await save();
    console.log(
      JSON.stringify({
        manifest: manifestPath,
        runStatus: manifest.runStatus,
        realModel: manifest.realModel.status,
        freezeDigest,
      }),
    );
    if (manifest.runStatus !== "completed") process.exitCode = 1;
    return manifest;
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.pairedConfig) return runPairedExperiment(options);
  const taskIds = options.taskId ? [options.taskId] : TASK_IDS;
  const tasks = options.taskId
    ? SINGLE_TASK_CATALOG.filter((task) => task.id === options.taskId)
    : TASK_CATALOG;
  const output = options.output
    ? resolve(options.output)
    : await makeTempDir("areal-browser-task-pilot-");
  await mkdir(output, { recursive: true });
  if (options.taskId)
    await assert.rejects(
      readFile(join(output, "manifest.json")),
      "Standalone acceptance requires a new output directory; attempts are never replayed",
    );
  const before = await provenance();
  const manifest = {
    schemaVersion: 1,
    benchmarkVersion: options.taskId
      ? "browser-single-task-acceptance-v1"
      : "browser-real-task-pilot-v1",
    phase: options.mode,
    measurementKind: options.mode === "fixture" ? "deterministic-task-chain" : "task-plan",
    sourceGroup: SOURCE_GROUP,
    scope: options.taskId
      ? "Independent single-task acceptance; excluded from the paired 130-attempt workload."
      : "Single-source six-task pipeline pilot. No comparison, ranking, or generalization claim.",
    realModel: { status: "not_run" },
    ...(options.mode === "fixture"
      ? {
          fixtureFlow: {
            revision: "browser-task-script-v2",
            information:
              "Directory snapshot, exact accessible-name link locator click, then detail snapshot. Replaces the fixture-only direct detail navigation; real-task prompts and grading are unchanged.",
          },
        }
      : {}),
    model: {
      name: "gpt-6.1-terra",
      protocol: "responses",
      reasoningEffort: "medium",
      serviceTier: "default",
      temperature: "omitted",
    },
    budgets: {
      ...BUDGET,
      aggregateOutputTokenUpperBoundPerAttempt:
        BUDGET.maxHttpRequests * BUDGET.maxOutputTokensPerRequest,
      upperBoundConditions:
        "Every forwarded HTTP request carries max_output_tokens <= 4096; at most 24 forwarded HTTP requests, including retries and auxiliary requests. Provider must honor its output limit.",
      dollarBound: "unknown; no pricing assertion",
      fixtureHasProviderRequestGate: false,
    },
    approvalPolicy:
      "Ask preset, automatic allow-once in isolated synthetic task scope. No model-based permission reviewer.",
    browserStart:
      "cold-start: no manual page, navigation, or claim; the model's Core-approved describe lazily creates the initial blank page",
    auxiliaryModelRequests:
      "Public create keeps automatic session naming at its default. Naming and prompt-prediction requests use the same HTTP cap and Core audit; fixture replies do not advance browser task steps.",
    tasks,
    repeats: 1,
    seed: "fixed-catalog-v1",
    taskOrder: taskIds,
    provenanceBefore: before,
    environment: {
      node: process.version,
      os: `${platform()} ${release()}`,
      arch: arch(),
      cpuCount: cpus().length,
      loadAverage: loadavg(),
    },
    attempts: taskIds.map((taskId) => ({
      taskId,
      repeat: 1,
      sourceGroup: SOURCE_GROUP,
      status: "planned",
      grading: null,
    })),
  };
  const manifestPath = join(output, "manifest.json");
  const save = () => atomicJSON(manifestPath, manifest);
  await save();
  if (options.mode === "plan") {
    console.log(
      JSON.stringify({ manifest: manifestPath, realModel: "not_run", attempts: taskIds.length }),
    );
    return manifest;
  }
  const blockers = [];
  if (options.mode === "real") {
    if (!options.authorized)
      blockers.push(
        "Explicit authorization flag is required after the user authorizes provider use",
      );
    if (options.protocol !== "responses")
      blockers.push("Explicit --protocol responses is required");
    if (options.model !== "gpt-6.1-terra")
      blockers.push("Explicit --model gpt-6.1-terra is required");
    if (!options.upstream) blockers.push("Explicit --upstream full Responses endpoint is required");
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.credentialEnv ?? "") ||
      !process.env[options.credentialEnv]
    )
      blockers.push("Explicit credential environment reference is required and must be populated");
    if (options.upstream) {
      try {
        const target = new URL(options.upstream);
        assert.ok(
          ["https:", "http:"].includes(target.protocol) &&
            !target.username &&
            !target.password &&
            !target.search &&
            !target.hash,
        );
        manifest.upstream = {
          origin: target.origin,
          route: ["/v1/responses", "/responses"].includes(target.pathname)
            ? target.pathname
            : "[redacted]",
        };
      } catch {
        blockers.push("Upstream must be an HTTP(S) URL without credentials or query data");
      }
    }
    manifest.credentialSource = "explicit-environment-reference";
  }
  if (blockers.length) {
    for (const attempt of manifest.attempts)
      Object.assign(attempt, { status: "blocked", reasons: blockers });
    manifest.runStatus = "blocked";
    await save();
    console.log(
      JSON.stringify({ manifest: manifestPath, runStatus: "blocked", reasons: blockers }),
    );
    process.exitCode = 2;
    return manifest;
  }
  const started = performance.now();
  for (const attempt of manifest.attempts) {
    attempt.status = "running";
    const directory = join(output, attempt.taskId);
    await mkdir(directory, { recursive: true });
    const resultPath = join(directory, "result.json");
    let gate;
    try {
      if (options.mode === "real")
        gate = await createProviderGate({
          upstream: options.upstream,
          secret: process.env[options.credentialEnv],
          ...(options.taskId ? { recordPath: join(directory, "http-requests.json") } : {}),
        });
      await save();
      const outcome = await runChild(
        {
          mode: options.mode,
          taskId: attempt.taskId,
          protocol: options.protocol,
          model: options.model,
          modelEndpoint: gate?.endpoint,
          statusEndpoint: gate?.statusEndpoint,
          resultPath,
          normalControlsOnly: Boolean(options.taskId),
        },
        directory,
        options,
      );
      attempt.child = outcome;
      const result = await readFile(resultPath, "utf8")
        .then(JSON.parse)
        .catch(() => null);
      if (!result) {
        attempt.status = outcome.signal ? "timeout" : "blocked";
        attempt.reason = "Child produced no authoritative task receipt";
        continue;
      }
      if (gate) {
        await gate.flush();
        result.httpRequests = gate.attempts;
        result.providerInFlightAtCleanup = gate.inFlight;
        result.grading = gradeTask(attempt.taskId, result);
        await writeFile(resultPath, JSON.stringify(result, null, 2));
      }
      if (options.taskId) {
        applyChildExit(result, outcome);
        await atomicJSON(resultPath, result);
      }
      Object.assign(attempt, {
        status: result.status,
        grading: result.grading,
        evidence: result.evidence,
        result: resultPath,
        elapsedMs: result.elapsedMs,
        cleanup: result.cleanup,
        usage: options.taskId
          ? reconcileUsage(result.audits ?? [], gate?.attempts ?? [], result.auditErrors ?? [])
          : usageSummary(result.audits ?? []),
        ...(options.taskId ? { exit: result.exit, timings: result.timings } : {}),
        httpRequests: gate?.attempts.length ?? null,
        forwardedRequests:
          gate?.attempts.filter((item) => item.status !== "blocked").length ?? null,
      });
      if (
        outcome.code !== 0 ||
        !result.cleanup?.electronStopped ||
        !result.cleanup?.applicationStopped ||
        (options.taskId && gate && gate.inFlight !== 0)
      )
        attempt.cleanupValid = false;
      else attempt.cleanupValid = true;
    } catch (error) {
      attempt.status = "blocked";
      attempt.reason = error.message;
    } finally {
      if (gate) {
        attempt.httpRequests = gate.attempts.length;
        attempt.forwardedRequests = gate.attempts.filter((item) =>
          ["forwarded", "completed", "cancelled", "transport_error", "response_error"].includes(
            item.status,
          ),
        ).length;
        await gate.close();
        await writeFile(
          join(directory, "http-requests.json"),
          JSON.stringify(gate.attempts, null, 2),
        );
      }
      await save();
    }
  }
  const after = await provenance();
  manifest.provenanceAfter = after;
  manifest.integrity = {
    sourceStable: JSON.stringify(before) === JSON.stringify(after),
    artifactsAvailable: Object.values(before.hashes).every(Boolean),
  };
  manifest.elapsedMs = performance.now() - started;
  const sent = manifest.attempts.some((attempt) => (attempt.forwardedRequests ?? 0) > 0);
  manifest.realModel = { status: options.mode === "real" && sent ? "run" : "not_run" };
  if (options.mode === "real" && sent) manifest.measurementKind = "real-model-task";
  manifest.runStatus =
    manifest.attempts.every((attempt) => attempt.grading?.qualityPassed && attempt.cleanupValid) &&
    manifest.integrity.sourceStable &&
    (!options.taskId || manifest.integrity.artifactsAvailable)
      ? "completed"
      : "failed";
  manifest.summary = {
    ordinaryTasksPlanned: taskIds.filter((id) => id !== "stop").length,
    ordinaryTasksCompleted: manifest.attempts.filter(
      (attempt) => attempt.taskId !== "stop" && attempt.grading?.taskCompleted,
    ).length,
    stopSafetyOutcome:
      manifest.attempts.find((attempt) => attempt.taskId === "stop")?.grading?.safetyOutcome ??
      "not_covered",
  };
  if (options.taskId === GENERATED_TASK.id)
    manifest.generatedLocalHtmlAcceptance = {
      realProviderRun: options.mode === "real" && sent,
      accepted: options.mode === "real" && sent && manifest.runStatus === "completed",
      fixtureEvidenceOnly: options.mode === "fixture",
      includedInPairedWorkload: false,
    };
  await save();
  console.log(
    JSON.stringify({
      manifest: manifestPath,
      runStatus: manifest.runStatus,
      realModel: manifest.realModel.status,
      summary: manifest.summary,
    }),
  );
  if (manifest.runStatus !== "completed") process.exitCode = 1;
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
