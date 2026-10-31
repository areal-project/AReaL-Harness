import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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
  SOURCE_GROUP,
  gradeTask,
} from "./browser-task-benchmark-catalog.mjs";
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
    else if (
      ["--output", "--protocol", "--upstream", "--model", "--credential-env"].includes(flag)
    ) {
      assert.ok(argv[index + 1] && !argv[index + 1].startsWith("--"), `${flag} requires a value`);
      options[
        {
          "--output": "output",
          "--protocol": "protocol",
          "--upstream": "upstream",
          "--model": "model",
          "--credential-env": "credentialEnv",
        }[flag]
      ] = argv[++index];
    } else throw Error(`Unknown flag ${flag}`);
  }
  assert.ok(modes <= 1, "Choose one of --plan, --fixture, --real");
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
export async function createProviderGate({ upstream, secret }) {
  const target = new URL(upstream);
  assert.ok(["https:", "http:"].includes(target.protocol));
  assert.ok(
    !target.username && !target.password && !target.search && !target.hash,
    "Upstream URL must not carry credentials or query data",
  );
  const attempts = [];
  const active = new Set();
  let closed = false;
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
      assert.ok(!closed && attempts.length <= BUDGET.maxHttpRequests, "All-request cap reached");
      assert.equal(value.model, "gpt-6.1-terra");
      assert.ok(
        Number.isInteger(value.max_output_tokens) &&
          value.max_output_tokens > 0 &&
          value.max_output_tokens <= BUDGET.maxOutputTokensPerRequest,
        "Unbounded model output request rejected",
      );
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
      };
      record.status = "forwarded";
      pending.once("response", (incoming) => {
        record.httpStatus = incoming.statusCode;
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
      pending.end(body);
    } catch (error) {
      record.status = "blocked";
      record.reason = error.message;
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
    get inFlight() {
      return active.size;
    },
    async close() {
      closed = true;
      for (const pending of active) pending.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
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

async function runChild(configuration, directory, options) {
  const configPath = join(directory, "child-config.json");
  await writeFile(configPath, JSON.stringify(configuration, null, 2));
  const env = cleanChildEnvironment(process.env, options.credentialEnv);
  env.AREAL_CORE_BIN = process.env.AREAL_CORE_BIN ?? join(root, ".local/dev-bin/areal");
  if (process.env.AREAL_ELECTRON_EXECUTABLE)
    env.AREAL_ELECTRON_EXECUTABLE = process.env.AREAL_ELECTRON_EXECUTABLE;
  const child = spawn(
    process.execPath,
    [
      join(gui, "scripts/automation-core-smoke.mjs"),
      "--suite",
      "browser",
      "--task-benchmark-config",
      configPath,
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
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
  return outcome;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  const output = options.output
    ? resolve(options.output)
    : await makeTempDir("areal-browser-task-pilot-");
  await mkdir(output, { recursive: true });
  const before = await provenance();
  const manifest = {
    schemaVersion: 1,
    benchmarkVersion: "browser-real-task-pilot-v1",
    phase: options.mode,
    measurementKind: options.mode === "fixture" ? "deterministic-task-chain" : "task-plan",
    sourceGroup: SOURCE_GROUP,
    scope:
      "Single-source six-task pipeline pilot. No comparison, ranking, or generalization claim.",
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
    tasks: TASK_CATALOG,
    repeats: 1,
    seed: "fixed-catalog-v1",
    taskOrder: TASK_IDS,
    provenanceBefore: before,
    environment: {
      node: process.version,
      os: `${platform()} ${release()}`,
      arch: arch(),
      cpuCount: cpus().length,
      loadAverage: loadavg(),
    },
    attempts: TASK_IDS.map((taskId) => ({
      taskId,
      repeat: 1,
      sourceGroup: SOURCE_GROUP,
      status: "planned",
      grading: null,
    })),
  };
  const manifestPath = join(output, "manifest.json");
  const save = () => writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await save();
  if (options.mode === "plan") {
    console.log(JSON.stringify({ manifest: manifestPath, realModel: "not_run", attempts: 6 }));
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
        result.httpRequests = gate.attempts;
        result.providerInFlightAtCleanup = gate.inFlight;
        result.grading = gradeTask(attempt.taskId, result);
        await writeFile(resultPath, JSON.stringify(result, null, 2));
      }
      Object.assign(attempt, {
        status: result.status,
        grading: result.grading,
        evidence: result.evidence,
        result: resultPath,
        elapsedMs: result.elapsedMs,
        cleanup: result.cleanup,
        usage: usageSummary(result.audits ?? []),
        httpRequests: gate?.attempts.length ?? null,
        forwardedRequests:
          gate?.attempts.filter((item) => item.status !== "blocked").length ?? null,
      });
      if (
        outcome.code !== 0 ||
        !result.cleanup?.electronStopped ||
        !result.cleanup?.applicationStopped
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
    manifest.integrity.sourceStable
      ? "completed"
      : "failed";
  manifest.summary = {
    ordinaryTasksPlanned: 5,
    ordinaryTasksCompleted: manifest.attempts.filter(
      (attempt) => attempt.taskId !== "stop" && attempt.grading?.taskCompleted,
    ).length,
    stopSafetyOutcome:
      manifest.attempts.find((attempt) => attempt.taskId === "stop").grading?.safetyOutcome ??
      "not_covered",
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
