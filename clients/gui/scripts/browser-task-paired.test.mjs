import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  buildPairedSchedule,
  attemptIdentity,
  validateCompletedReceipt,
  reconcileUsage,
  parseOptions,
  atomicJSON,
  createProviderGate,
  validateFrozenProvider,
  runPairedExperiment,
  applyChildExit,
  validatePairedInputPlan,
} from "./browser-task-benchmark.mjs";
import {
  PAIRED_TASK_CATALOG,
  TASK_IDS,
  SOURCE_GROUP,
  createTaskFixture,
  taskApprovalDecision,
  NORMAL_CONTROLS_INSTRUCTION,
  gradeTask,
  GENERATED_TASK,
} from "./browser-task-benchmark-catalog.mjs";
import {
  prepareTaskBenchmark,
  readNativeTaskSnapshots,
  clickTodoVerificationFilter,
  takeOverTodoVerification,
  captureGeneratedNativePage,
  taskCreateRequest,
} from "./browser-task-benchmark-driver.mjs";

const golden = JSON.parse(
  await readFile(new URL("./fixtures/browser-task-usage-receipt.json", import.meta.url), "utf8"),
);

test("paired admission binds the preregistered plan and rejects drift before creating an experiment", async (t) => {
  const original = await readFile(
    new URL("../../../docs/benchmarks/browser-local-link-plan.json", import.meta.url),
  );
  const upstream = "https://arena.example.invalid/v1/responses";
  for (const [name, mutate, expected] of [
    ["valid", () => {}, null],
    [
      "missing plan",
      (_plan, config) => {
        delete config.inputPlanPath;
      },
      /require inputPlanPath/,
    ],
    [
      "digest",
      (_plan, config) => {
        config.inputPlanSHA256 = "0".repeat(64);
      },
      /SHA256 differs/,
    ],
    [
      "experiment",
      (plan) => {
        plan.experimentId = "other";
      },
      /experiment differs/,
    ],
    [
      "comparison",
      (plan) => {
        plan.comparisonKind = "historical-guide-ablation";
      },
      /comparison kind differs/,
    ],
    [
      "arms",
      (plan) => {
        plan.arms[1].id = "C";
      },
      /comparison arms differ/,
    ],
    [
      "model",
      (plan) => {
        plan.model.model = "another-model";
      },
      /model differs/,
    ],
    [
      "budget",
      (plan) => {
        plan.budgetPerAttempt.maxToolCalls++;
      },
      /budget differs/,
    ],
    [
      "catalog",
      (plan) => {
        plan.tasks[0].sourceGroup = "other";
      },
      /task catalog differs/,
    ],
    [
      "seed",
      (plan) => {
        plan.scheduleSeed = "other";
      },
      /seed differs/,
    ],
    [
      "schedule",
      (plan) => {
        [plan.schedule[0], plan.schedule[1]] = [plan.schedule[1], plan.schedule[0]];
      },
      /schedule differs/,
    ],
    [
      "denominator",
      (plan) => {
        plan.ordinaryAttemptsPerArm = 59;
      },
      /ordinary denominator differs/,
    ],
  ])
    await t.test(name, async () => {
      const directory = await mkdtemp(join(tmpdir(), "browser-input-plan-"));
      try {
        const plan = JSON.parse(original);
        const configPath = join(directory, "config.json");
        const config = {
          experimentId: plan.experimentId,
          comparisonKind: plan.comparisonKind,
          seed: plan.scheduleSeed,
          inputPlanPath: "plan.json",
          arms: { A: {}, B: {} },
          provider: {
            name: "Arena",
            protocol: "responses",
            endpointSHA256: createHash("sha256").update(upstream).digest("hex"),
          },
        };
        mutate(plan, config);
        const bytes = Buffer.from(JSON.stringify(plan));
        config.inputPlanSHA256 ??= createHash("sha256").update(bytes).digest("hex");
        await writeFile(join(directory, "plan.json"), bytes);
        await atomicJSON(configPath, config);
        if (!expected) {
          const result = await validatePairedInputPlan(config, configPath);
          assert.equal(result.inputPlan.sha256, config.inputPlanSHA256);
          assert.equal(result.schedule.length, 130);
          assert.deepEqual(result.schedule, plan.schedule);
          return;
        }
        const output = join(directory, "not-created");
        await assert.rejects(
          runPairedExperiment({ mode: "real", pairedConfig: configPath, output, upstream }),
          expected,
        );
        await assert.rejects(readFile(join(output, "manifest.json")), { code: "ENOENT" });
        await assert.rejects(readFile(join(output, "runner.lock")), { code: "ENOENT" });
      } finally {
        await rm(directory, { recursive: true });
      }
    });
});

test("paired schedule freezes 12 ordinary and one safety task across three source groups", () => {
  const schedule = buildPairedSchedule();
  assert.equal(TASK_IDS.length, 6);
  assert.equal(PAIRED_TASK_CATALOG.filter((task) => !task.safety).length, 12);
  assert.equal(new Set(PAIRED_TASK_CATALOG.map((task) => task.sourceId)).size, 3);
  assert.equal(schedule.length, 130);
  assert.deepEqual(buildPairedSchedule(), schedule);
  assert.notDeepEqual(buildPairedSchedule(PAIRED_TASK_CATALOG, "another-experiment"), schedule);
  assert.equal(
    new Set(schedule.map((attempt) => JSON.stringify(attemptIdentity(attempt)))).size,
    130,
  );
  for (let index = 0; index < schedule.length; index += 2) {
    const a = schedule[index],
      b = schedule[index + 1];
    assert.equal(a.taskId, b.taskId);
    assert.equal(a.repeat, b.repeat);
    assert.equal(a.instanceSeed, b.instanceSeed);
    assert.notEqual(a.arm, b.arm);
    assert.equal(a.sequence, index + 1);
    assert.equal(b.sequence, index + 2);
  }
  for (const arm of ["A", "B"]) {
    assert.equal(schedule.filter((attempt) => attempt.arm === arm && !attempt.safety).length, 60);
    assert.equal(schedule.filter((attempt) => attempt.arm === arm && attempt.safety).length, 5);
  }
  assert.equal(schedule.filter((attempt) => attempt.sourceGroup === SOURCE_GROUP).length, 60);
  assert.deepEqual(
    schedule
      .filter((attempt) => attempt.taskId === "miniwob/enter-text" && attempt.arm === "A")
      .sort((a, b) => a.repeat - b.repeat)
      .map((attempt) => attempt.instanceSeed),
    [104729, 130363, 155921, 181081, 206369],
  );
});

test("qualified synthetic aliases preserve the pilot prompt and its independent fixture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-qualified-task-"));
  const fixture = await createTaskFixture("synthetic/local-html", directory);
  try {
    assert.equal(fixture.id, "local-html");
    assert.equal(
      fixture.prompt,
      "Open the local file workshop-report.html in the browser and keep the report open. Tell me the Results section heading and reference code.",
    );
    assert.equal(
      PAIRED_TASK_CATALOG.find((task) => task.id === "synthetic/local-html").promptTemplate,
      `${fixture.prompt} ${NORMAL_CONTROLS_INSTRUCTION}`,
    );
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true });
  }
});

test("usage reconciliation matches the actual 15-request Core/gate golden by body hash", () => {
  const result = reconcileUsage(golden.audits, golden.httpRequests);
  assert.equal(result.coverage.forwardedHttp, 15);
  assert.equal(result.coverage.matchedForwardedHttp, 15);
  assert.equal(result.coverage.unmatchedForwardedHttp, 0);
  assert.equal(result.solveLogicalRequests, 13);
  assert.equal(result.solveHttpAttempts, 13);
  assert.equal(result.solveCountComplete, true);
  assert.equal(result.purposes.Summary.forwardedHttp, 1);
  assert.equal(result.purposes.PromptPrediction.forwardedHttp, 1);
  assert.equal(result.status, "partial");
  assert.equal(result.coverage.usageComplete, false);
  assert.ok(result.knownUsageLowerBound.outputTokens > 0);
});

test("missing, duplicated, and unparseable audits retain unknown coverage and cost", () => {
  const empty = reconcileUsage([], golden.httpRequests);
  assert.equal(empty.solveHttpAttempts, null);
  assert.equal(empty.solveCountComplete, false);
  assert.equal(empty.status, "unknown");
  assert.equal(empty.coverage.unmatchedForwardedHttp, 15);
  assert.deepEqual(empty.knownUsageLowerBound, {});
  const duplicate = reconcileUsage([...golden.audits, golden.audits[0]], golden.httpRequests);
  assert.equal(duplicate.solveCountComplete, false);
  const damaged = reconcileUsage(
    golden.audits,
    [...golden.httpRequests, { status: "completed" }],
    [{ path: "errors/malformed.json" }],
  );
  assert.equal(damaged.coverage.unmatchedForwardedHttp, 1);
  assert.equal(damaged.coverage.auditErrors, 1);
  assert.equal(damaged.solveCountComplete, false);
});

test("retry and blocked HTTP counts are separated from terminal usage receipts", () => {
  const audit = {
    bodySha256: "same",
    purpose: "Solve",
    httpAttempts: 3,
    usageObserved: true,
    usage: { inputTokens: 10, outputTokens: 2 },
  };
  const requests = [
    { bodySHA256: "same", status: "transport_error" },
    { bodySHA256: "same", status: "completed" },
    { bodySHA256: "same", status: "blocked" },
  ];
  const result = reconcileUsage([audit], requests);
  assert.equal(result.solveLogicalRequests, 1);
  assert.equal(result.solveHttpAttempts, 2);
  assert.equal(result.purposes.Solve.httpAttempts, 3);
  assert.equal(result.coverage.blockedHttp, 1);
  assert.equal(result.solveCountComplete, true);
  assert.equal(result.status, "partial");
  assert.equal(result.coverage.usageComplete, false);
  assert.deepEqual(result.knownUsageLowerBound, { inputTokens: 10, outputTokens: 2 });
});

test("resume requires exact frozen identity and a completed cleanup receipt", () => {
  const attempt = buildPairedSchedule()[0];
  const receipt = {
    schemaVersion: 1,
    freezeDigest: "frozen",
    identity: attemptIdentity(attempt),
    complete: true,
    attempt: { ...attempt, status: "failed", cleanupValid: true, sourceStable: true },
  };
  assert.doesNotThrow(() => validateCompletedReceipt(attempt, receipt, "frozen"));
  assert.throws(() => validateCompletedReceipt(attempt, receipt, "different"));
  assert.throws(() => validateCompletedReceipt({ ...attempt, repeat: 4 }, receipt, "frozen"));
  assert.throws(() => validateCompletedReceipt(attempt, { ...receipt, complete: false }, "frozen"));
  assert.throws(() =>
    validateCompletedReceipt(
      attempt,
      {
        ...receipt,
        attempt: { ...attempt, status: "unknown", cleanupValid: true, sourceStable: true },
      },
      "frozen",
    ),
  );
  assert.throws(() =>
    validateCompletedReceipt(
      attempt,
      {
        ...receipt,
        attempt: { ...attempt, status: "completed", cleanupValid: false, sourceStable: true },
      },
      "frozen",
    ),
  );
});

test("paired CLI keeps real authorization explicit and recognizes resume configuration", () => {
  const options = parseOptions(["--paired-config", "/frozen/config.json", "--resume", "--real"]);
  assert.equal(options.pairedConfig, "/frozen/config.json");
  assert.equal(options.resume, true);
  assert.equal(options.authorized, false);
  assert.throws(() => parseOptions(["--paired-config"]));
});

test("ordinary-control policy denies evaluation inside single and nested batch commands", () => {
  const plan = {
    threadId: "t",
    turnId: "r",
    callId: "c",
    operation: "command",
    origin: "http://127.0.0.1:123",
    url: "http://127.0.0.1:123/task",
    parameters: {},
  };
  const interaction = {
    kind: "approval",
    status: "pending",
    tool: "browser_v1",
    threadId: "t",
    turnId: "r",
    callId: "c",
    effectiveArguments: { plan },
  };
  const scope = { threadId: "t", turnId: "r", origins: [plan.origin], normalControlsOnly: true };
  for (const command of [
    { method: "evaluate", expression: "1" },
    { method: "playwright", action: { name: "evaluate", expression: "1" } },
    {
      method: "playwright",
      action: { name: "locator", selector: "input", operation: "evaluate", expression: "1" },
    },
  ]) {
    plan.parameters = { command };
    assert.equal(taskApprovalDecision(interaction, scope).decision, "deny");
    plan.parameters = { commands: [{ commands: [command] }] };
    assert.equal(taskApprovalDecision(interaction, scope).decision, "deny");
  }
  plan.parameters = {
    command: {
      method: "playwright",
      action: { name: "locator", selector: "input", operation: "fill", value: "Alice" },
    },
  };
  assert.equal(taskApprovalDecision(interaction, scope).decision, "allowOnce");
});

test("external deterministic driver preserves cold describe and strict production schemas", async () => {
  const { validToolInput } = createRequire(import.meta.url)("../app/src/core/browser-tool.cjs");
  const { validateBrowserCommand } = createRequire(new URL("../app/package.json", import.meta.url))(
    "@areal/browser-automation",
  );
  const directory = await mkdtemp(join(tmpdir(), "browser-external-driver-"));
  const config = join(directory, "config.json");
  await atomicJSON(config, {
    mode: "fixture",
    taskId: "miniwob/enter-text",
    instanceSeed: 130363,
    normalControlsOnly: true,
  });
  const driver = await prepareTaskBenchmark(config, directory);
  let wire = "";
  try {
    await driver.fixtureModel(
      Readable.from([JSON.stringify({ messages: [{ role: "user", content: "Run task" }] })]),
      {
        writeHead() {},
        write(chunk) {
          wire += chunk;
        },
        end(chunk) {
          wire += chunk;
        },
      },
    );
    const event = wire.split("\n").find((line) => line.startsWith("data: {"));
    const input = JSON.parse(
      JSON.parse(event.slice(6)).choices[0].delta.tool_calls[0].function.arguments,
    );
    assert.equal(input.operation, "describe");
    assert.equal(validToolInput(input), true);
    assert.doesNotThrow(() =>
      validateBrowserCommand({
        method: "playwright",
        action: { name: "locator", selector: "#sync-task-cover", operation: "click" },
      }),
    );
    assert.equal(driver.fixture.seed, 130363);
    assert.ok(driver.fixture.prompt.endsWith(NORMAL_CONTROLS_INSTRUCTION));
  } finally {
    await driver.fixture.close();
    await rm(directory, { recursive: true });
  }
});

test("gate persists forwarded admission before upstream receives it and saves terminal status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-gate-receipt-"));
  const recordPath = join(directory, "http-requests.json");
  let admission;
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    admission = JSON.parse(await readFile(recordPath, "utf8"));
    response.end("deterministic local transport receipt");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const gate = await createProviderGate({
    upstream: `http://127.0.0.1:${server.address().port}/responses`,
    secret: "unit-secret",
    recordPath,
  });
  try {
    const response = await fetch(gate.endpoint, {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-6.1-terra",
        reasoning: { effort: "medium" },
        service_tier: "default",
        max_output_tokens: 4096,
      }),
    });
    await response.text();
    await gate.flush();
    assert.equal(admission[0].status, "forwarded");
    assert.equal(admission[0].forwarded, true);
    const persisted = JSON.parse(await readFile(recordPath, "utf8"));
    assert.equal(persisted[0].status, "completed");
    assert.ok(persisted[0].bodySHA256);
    assert.ok(!JSON.stringify(persisted).includes("unit-secret"));
  } finally {
    await gate.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true });
  }
});

test("frozen provider rejects endpoint changes before a real resume can inspect artifacts or forward", async () => {
  const upstream = "https://arena.example.invalid/v1/responses";
  const provider = {
    name: "Arena",
    protocol: "responses",
    endpointSHA256: createHash("sha256").update(upstream).digest("hex"),
  };
  assert.doesNotThrow(() => validateFrozenProvider(provider));
  assert.doesNotThrow(() => validateFrozenProvider(provider, upstream, true));
  for (const wrong of [
    "https://other.example.invalid/v1/responses",
    "https://arena.example.invalid/responses",
  ]) {
    assert.throws(() => validateFrozenProvider(provider, wrong, true), /Upstream differs/);
  }
  for (const invalid of [
    "https://name:password@arena.example.invalid/v1/responses",
    `${upstream}?route=other`,
    `${upstream}#fragment`,
  ]) {
    assert.throws(
      () => validateFrozenProvider(provider, invalid, true),
      /without credentials, query, or fragment/,
    );
  }
  assert.throws(
    () => validateFrozenProvider(provider, undefined, true),
    /Explicit frozen upstream/,
  );
  assert.throws(() => validateFrozenProvider(undefined), /frozen Arena provider/);
  const directory = await mkdtemp(join(tmpdir(), "browser-frozen-provider-"));
  const pairedConfig = join(directory, "config.json");
  try {
    await atomicJSON(pairedConfig, {
      experimentId: "frozen-provider-test",
      provider,
      arms: { A: {}, B: {} },
    });
    await assert.rejects(
      runPairedExperiment({
        mode: "real",
        resume: true,
        pairedConfig,
        output: join(directory, "not-created"),
        upstream: "https://other.example.invalid/v1/responses",
      }),
      /Upstream differs from the frozen provider endpoint/,
    );
    await assert.rejects(readFile(join(directory, "not-created", "runner.lock")), {
      code: "ENOENT",
    });
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("late history, interaction, and native sampling cannot grant success or a new approval", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  for (const crossing of ["history", "interactions", "nativeApproval"]) {
    const directory = await mkdtemp(join(tmpdir(), "browser-deadline-boundary-"));
    const config = join(directory, "config.json");
    await atomicJSON(config, {
      mode: "fixture",
      taskId: crossing === "nativeApproval" ? "miniwob/enter-text" : "local-html",
      normalControlsOnly: true,
    });
    const driver = await prepareTaskBenchmark(config, directory);
    now = 0;
    let reads = 0,
      samples = 0,
      stopClicks = 0,
      approvals = 0;
    const page = {
      getByTestId: () => ({ click: async () => {}, waitFor: async () => {} }),
      waitForFunction: async () => {},
      screenshot: async () => {},
      getByRole: () => ({
        click: async () => {
          stopClicks++;
        },
      }),
    };
    const command = async (name, params) => {
      if (name === "create") return { threadId: "t" };
      if (name === "send") {
        now = 179900;
        return;
      }
      if (name === "respond") {
        approvals++;
        return;
      }
      if (params.operation === "inspect")
        return {
          configuration: {
            options: taskCreateRequest("p").options,
            permissions: { reviewer: "human" },
            toolAllowlist: ["browser_v1"],
          },
        };
      if (crossing === "interactions") now = 180200;
      return {
        data: [
          {
            kind: "approval",
            status: "pending",
            tool: "browser_v1",
            requestId: "a",
            threadId: "t",
            turnId: "turn",
            callId: "c",
            effectiveArguments: {
              plan: {
                operation: "command",
                threadId: "t",
                turnId: "turn",
                callId: "c",
                url: `${driver.fixture.origin}/task`,
                origin: driver.fixture.origin,
                parameters: { command: { method: "snapshot" } },
              },
            },
          },
        ],
      };
    };
    try {
      const result = await driver.run({
        app: {
          evaluate: async (_callback, args) => {
            if (args?.taskURL && ++samples === 2) now = 180200;
            return [];
          },
        },
        page,
        command,
        projectId: "p",
        setThread() {},
        scratch: directory,
        readCoreThread: async () => {
          reads++;
          if (crossing === "history") now = 180200;
          return {
            id: "t",
            turns: [
              {
                id: "turn",
                status: crossing === "history" || reads > 1 ? "completed" : "inProgress",
                items: [],
              },
            ],
          };
        },
      });
      assert.equal(result.status, "timeout", crossing);
      assert.equal(result.deadlineExceeded, true);
      assert.equal(result.lateTerminal.status, "completed");
      assert.equal(approvals, 0);
      assert.equal(stopClicks, 0, "A known late terminal outcome has no active pause control");
    } finally {
      await driver.fixture.close();
      await rm(directory, { recursive: true });
    }
  }
});

test("a nonzero child exit rejects claimed success while preserving known failures and cleanup", () => {
  const completed = {
    status: "completed",
    cleanup: { electronStopped: true, applicationStopped: true },
    history: { turns: [{ status: "completed" }] },
    grading: { valid: true, taskCompleted: true, qualityPassed: true, checks: {} },
  };
  const result = applyChildExit(structuredClone(completed), { code: 1, signal: null });
  assert.equal(result.grading.qualityPassed, false);
  assert.equal(result.grading.taskCompleted, false);
  assert.equal(result.exit.validityBlocker, true);
  assert.equal(result.exit.claimedSuccess, true);
  assert.equal(result.history.turns[0].status, "completed");
  assert.deepEqual(result.cleanup, completed.cleanup);
  const failed = applyChildExit(
    { status: "timeout", grading: { valid: true, taskCompleted: false, qualityPassed: false } },
    { code: 1, signal: null },
  );
  assert.equal(failed.exit.validityBlocker, false);
  assert.equal(failed.grading.valid, true);
  assert.equal(failed.status, "timeout");
  assert.equal(applyChildExit(structuredClone(completed), { code: 0 }).grading.qualityPassed, true);
});

test("Main native snapshot identity overrides page fields and distinguishes reloads and new pages", async () => {
  let pageId = 17,
    timeOrigin = 1000;
  const contents = {
    get id() {
      return pageId;
    },
    isDestroyed: () => false,
    getURL: () => "http://127.0.0.1:123/task",
    mainFrame: { processId: 9, routingId: 4 },
    executeJavaScript: async () => ({
      snapshot: { kind: "miniwob", nativePageId: "forged", documentId: "forged" },
      timeOrigin,
    }),
  };
  const app = {
    evaluate: async (callback, args) =>
      callback({ webContents: { getAllWebContents: () => [contents] } }, args),
  };
  const [initial] = await readNativeTaskSnapshots(app, contents.getURL(), "({})");
  assert.equal(initial.nativePageId, 17);
  assert.equal(initial.documentId, "9:4:1000");
  timeOrigin = 2000;
  const [reload] = await readNativeTaskSnapshots(app, contents.getURL(), "({})");
  assert.notEqual(reload.documentId, initial.documentId);
  pageId = 18;
  const [newPage] = await readNativeTaskSnapshots(app, contents.getURL(), "({})");
  assert.notEqual(newPage.nativePageId, initial.nativePageId);
});

test("MiniWoB restart evidence remains failed after sampling the original identity again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-native-restart-"));
  const config = join(directory, "config.json");
  await atomicJSON(config, { mode: "fixture", taskId: "miniwob/enter-text" });
  const driver = await prepareTaskBenchmark(config, directory);
  const initial = {
    kind: "miniwob",
    url: driver.fixture.url,
    nativePageId: 7,
    documentId: "original",
    episodeActive: true,
    episodeId: 0,
    done: false,
    rawReward: 0,
    query: 'Enter "Dora" into the text field and press Submit.',
    controls: [{ id: "tt", type: "text", value: "" }],
    episodeMaxTime: 180000,
  };
  let reads = 0,
    samples = 0;
  try {
    const result = await driver.run({
      app: {
        evaluate: async (_callback, args) => {
          if (!args?.taskURL) return [];
          samples++;
          if (samples === 1) return [structuredClone(initial)];
          return [
            {
              ...structuredClone(initial),
              documentId: samples === 2 ? "reloaded" : "original",
              episodeId: 1,
              done: true,
              rawReward: 1,
              controls: [{ id: "tt", type: "text", value: "Dora" }],
            },
          ];
        },
      },
      page: {
        getByTestId: () => ({ click: async () => {}, waitFor: async () => {} }),
        waitForFunction: async () => {},
        screenshot: async () => {},
      },
      command: async (name, params) =>
        name === "create"
          ? { threadId: "t" }
          : name !== "manage"
            ? undefined
            : params.operation === "inspect"
              ? {
                  configuration: {
                    options: taskCreateRequest("p").options,
                    permissions: { reviewer: "human" },
                    toolAllowlist: ["browser_v1"],
                  },
                }
              : { data: [] },
      readCoreThread: async () => ({
        id: "t",
        turns: [
          {
            id: "turn",
            status: ++reads === 1 ? "inProgress" : "completed",
            items: [{ type: "dynamicToolCall", tool: "browser_v1" }],
          },
        ],
      }),
      projectId: "p",
      setThread() {},
      scratch: directory,
    });
    assert.equal(result.initialSnapshot.documentId, "original");
    assert.equal(result.nativeSnapshot.documentId, "original");
    assert.equal(result.nativeSnapshot.runnerEvidence.observedRestart, true);
    assert.equal(gradeTask("miniwob/enter-text", result).qualityPassed, false);
  } finally {
    await driver.fixture.close();
    await rm(directory, { recursive: true });
  }
});

test("TodoMVC verification preserves the agent Active outcome and samples All before restoring Active", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-todo-verification-"));
  const config = join(directory, "config.json");
  await atomicJSON(config, { mode: "fixture", taskId: "todomvc/active" });
  const driver = await prepareTaskBenchmark(config, directory);
  const labels = ["buy some cheese", "feed the cat", "book a doctors appointment"];
  const identity = {
    kind: "todomvc",
    url: driver.fixture.url,
    nativePageId: 7,
    documentId: "same-document",
  };
  const active = {
    ...identity,
    items: [0, 2].map((index) => ({ label: labels[index], checked: false, editing: false })),
    hash: "#/active",
    selectedFilter: "Active",
    remaining: "2 items left",
    clearCompletedVisible: true,
  };
  let filter = "Active";
  const clicks = [];
  try {
    const result = await driver.run({
      app: {
        evaluate: async (_callback, args) => {
          if (args?.filter) {
            filter = args.filter;
            clicks.push(filter);
            return { ok: true };
          }
          if (!args?.taskURL) return [];
          return [
            structuredClone(
              filter === "Active"
                ? active
                : {
                    ...identity,
                    hash: "#/",
                    selectedFilter: "All",
                    items: labels.map((label, index) => ({
                      label,
                      checked: index === 1,
                      editing: false,
                    })),
                  },
            ),
          ];
        },
      },
      page: {
        evaluate: async (_callback, request) => ({
          url: `${driver.fixture.url}#/active`,
          browser: { pageId: request.pageId ?? "owned-todo", control: "human" },
          workspace: { pages: [{ pageId: "owned-todo", url: `${driver.fixture.url}#/active` }] },
        }),
        getByTestId: () => ({ click: async () => {}, waitFor: async () => {} }),
        waitForFunction: async () => {},
        screenshot: async () => {},
      },
      command: async (name) =>
        name === "create"
          ? { threadId: "t" }
          : name !== "manage"
            ? undefined
            : {
                configuration: {
                  options: taskCreateRequest("p").options,
                  permissions: { reviewer: "human" },
                  toolAllowlist: ["browser_v1"],
                },
              },
      readCoreThread: async () => ({
        id: "t",
        turns: [
          {
            id: "turn",
            status: "completed",
            items: [{ type: "dynamicToolCall", tool: "browser_v1" }],
          },
        ],
      }),
      projectId: "p",
      setThread() {},
      scratch: directory,
    });
    assert.deepEqual(clicks, ["All", "Active"]);
    assert.equal(result.nativeSnapshot.selectedFilter, "Active");
    assert.equal(result.nativeSnapshot.runnerEvidence.allSnapshot.items.length, 3);
    assert.equal(result.nativeSnapshot.runnerEvidence.allSnapshot.items[1].label, "feed the cat");
    assert.equal(result.nativeSnapshot.runnerEvidence.allSnapshot.items[1].checked, true);
    assert.equal(result.nativeSnapshot.runnerEvidence.restoredSnapshot.selectedFilter, "Active");
    assert.equal(gradeTask("todomvc/active", result).qualityPassed, true);
    assert.ok(result.timings.verificationMs > 0);
  } finally {
    await driver.fixture.close();
    await rm(directory, { recursive: true });
  }
});

test("serialized Main verifier resolves the actual arm adapter without a global require", async () => {
  const taskURL = "http://127.0.0.1:123/task";
  let adapterCommands = 0;
  const contents = {
    id: 17,
    isDestroyed: () => false,
    getURL: () => taskURL,
    mainFrame: { processId: 9, routingId: 4 },
    executeJavaScript: async () => 1000,
    debugger: {
      isAttached: () => true,
      sendCommand: async () => {
        adapterCommands++;
        throw Error("controlled adapter boundary reached");
      },
    },
  };
  const appRoot = fileURLToPath(new URL("../app/", import.meta.url));
  const app = {
    evaluate: async (callback, args) =>
      vm.runInNewContext(`(${callback.toString()})(electron, args)`, {
        process,
        electron: {
          app: { getAppPath: () => appRoot },
          webContents: { fromId: (id) => (id === 17 ? contents : null) },
        },
        args,
      }),
  };
  await assert.rejects(
    clickTodoVerificationFilter(app, taskURL, { nativePageId: 17, documentId: "9:4:1000" }, "All"),
    /controlled adapter boundary reached/,
  );
  assert.ok(adapterCommands > 0, "The real resolved adapter receives a CDP command in Main");
});

test("TodoMVC verification uses the real preview contract and waits for human takeover", async () => {
  const { validatePreview } = createRequire(import.meta.url)(
    "../packages/workbench/client/desktop-contract.cjs",
  );
  const taskURL = "http://127.0.0.1:123/task";
  const operations = [];
  let takenOver = false;
  const page = {
    evaluate: async (_callback, request) => {
      validatePreview(request);
      operations.push(request.operation);
      if (request.operation === "takeover") takenOver = true;
      return {
        url: `${taskURL}#/active`,
        browser: { pageId: "todo", control: takenOver ? "human" : "agent" },
        workspace: { pages: [{ pageId: "todo", url: `${taskURL}#/active` }] },
      };
    },
  };
  const receipt = await takeOverTodoVerification(page, { projectId: "p", threadId: "t", taskURL });
  assert.deepEqual(operations, ["state", "state", "takeover", "state"]);
  assert.equal(receipt.before.browser.control, "agent");
  assert.equal(receipt.after.browser.control, "human");
  assert.equal(receipt.source, "post-terminal-public-human-takeover");
  await assert.rejects(
    takeOverTodoVerification(page, {
      projectId: "p",
      threadId: "t",
      taskURL: "http://127.0.0.1:999/other",
    }),
    /one owned TodoMVC/,
  );
});

test("native sampling survives a temporary surface destroyed during the awaited task read", async () => {
  const taskURL = "http://127.0.0.1:123/task";
  let destroyed = false;
  const temporary = {
    id: 88,
    isDestroyed: () => false,
    getURL: () => {
      if (destroyed) throw TypeError("Object has been destroyed");
      return "about:blank";
    },
  };
  const target = {
    id: 17,
    isDestroyed: () => false,
    getURL: () => taskURL,
    mainFrame: { processId: 9, routingId: 4 },
    executeJavaScript: async () => {
      destroyed = true;
      return { snapshot: { kind: "miniwob", url: taskURL }, timeOrigin: 1000 };
    },
  };
  const app = {
    evaluate: async (callback, args) =>
      callback({ webContents: { getAllWebContents: () => [target, temporary] } }, args),
  };
  const snapshots = await readNativeTaskSnapshots(app, taskURL, "({})", 17);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].nativePageId, 17);
  assert.equal(snapshots[0].documentId, "9:4:1000");
  assert.equal(snapshots[0].nativeReadDiagnostics[0].nativePageId, 88);
  assert.equal(snapshots[0].nativeReadDiagnostics[0].error, "Object has been destroyed");
  target.isDestroyed = () => true;
  const unavailable = await readNativeTaskSnapshots(app, taskURL, "({})", 17);
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0].nativePageId, 17);
  assert.equal(unavailable[0].documentId, null);
  assert.ok(unavailable[0].unavailable);
  assert.equal(unavailable[0].kind, undefined);
});

test("an unsettled timed-out TodoMVC task cannot start verification or take human control", async (t) => {
  let now = 0,
    reads = 0,
    stopClicks = 0,
    previewCalls = 0;
  t.mock.method(performance, "now", () => now);
  const directory = await mkdtemp(join(tmpdir(), "browser-unsettled-todo-"));
  const config = join(directory, "config.json");
  await atomicJSON(config, { mode: "fixture", taskId: "todomvc/active" });
  const driver = await prepareTaskBenchmark(config, directory);
  try {
    const result = await driver.run({
      app: {
        evaluate: async (_callback, args) =>
          args?.taskURL
            ? [
                {
                  kind: "todomvc",
                  url: driver.fixture.url,
                  nativePageId: 7,
                  documentId: "same",
                  selectedFilter: "Active",
                  hash: "#/active",
                },
              ]
            : [],
      },
      page: {
        evaluate: async () => {
          previewCalls++;
          throw Error("Unsettled task cannot be taken over");
        },
        getByTestId: () => ({ click: async () => {}, waitFor: async () => {} }),
        waitForFunction: async () => {},
        screenshot: async () => {},
        getByRole: () => ({
          click: async () => {
            stopClicks++;
          },
        }),
      },
      command: async (name) => {
        if (name === "create") return { threadId: "t" };
        if (name === "send") {
          now = 179900;
          return;
        }
        return {
          configuration: {
            options: taskCreateRequest("p").options,
            permissions: { reviewer: "human" },
            toolAllowlist: ["browser_v1"],
          },
        };
      },
      readCoreThread: async () => {
        reads++;
        now = reads >= 3 ? 190201 : 180200;
        return { id: "t", turns: [{ id: "turn", status: "inProgress", items: [] }] };
      },
      projectId: "p",
      setThread() {},
      scratch: directory,
    });
    assert.equal(result.status, "timeout");
    assert.equal(result.lateTerminal, null);
    assert.equal(stopClicks, 1);
    assert.equal(previewCalls, 0);
    assert.equal(result.nativeSnapshot.runnerEvidence.control, undefined);
    assert.equal(result.timings.sendToTerminalMs, null);
  } finally {
    await driver.fixture.close();
    await rm(directory, { recursive: true });
  }
});

test("generated HTML is standalone, initially absent, and exposes only its public goal", async () => {
  assert.equal(parseOptions(["--task", GENERATED_TASK.id]).taskId, GENERATED_TASK.id);
  assert.throws(() => parseOptions(["--task", GENERATED_TASK.id, "--paired-config", "/plan.json"]));
  assert.throws(() => parseOptions(["--task", GENERATED_TASK.id, "--resume"]));
  assert.equal(
    PAIRED_TASK_CATALOG.some((task) => task.id === GENERATED_TASK.id),
    false,
  );
  assert.equal(buildPairedSchedule().length, 130);
  const directory = await mkdtemp(join(tmpdir(), "browser-generated-html-"));
  const config = join(directory, "config.json");
  await atomicJSON(config, { mode: "fixture", taskId: GENERATED_TASK.id });
  const driver = await prepareTaskBenchmark(config, directory);
  const { validateCommand } = createRequire(import.meta.url)(
    "../packages/workbench/client/desktop-contract.cjs",
  );
  const { validToolInput } = createRequire(import.meta.url)("../app/src/core/browser-tool.cjs");
  const ask = async (messages) => {
    let wire = "";
    await driver.fixtureModel(Readable.from([JSON.stringify({ messages })]), {
      writeHead() {},
      write(chunk) {
        wire += chunk;
      },
      end(chunk) {
        wire += chunk;
      },
    });
    const event = wire.split("\n").find((line) => line.startsWith("data: {"));
    return JSON.parse(event.slice(6)).choices[0].delta.tool_calls[0];
  };
  try {
    await assert.rejects(readFile(driver.fixture.localPath), { code: "ENOENT" });
    assert.ok(driver.fixture.prompt.includes(driver.fixture.expected.nonce));
    assert.ok(!/fs_create|openDocument|<!doctype|<html/i.test(driver.fixture.prompt));
    const request = taskCreateRequest("p", GENERATED_TASK.id);
    assert.doesNotThrow(() => validateCommand("create", request));
    assert.deepEqual(request.options.toolAllowlist, ["fs_create", "browser_v1"]);
    assert.deepEqual(taskCreateRequest("p").options.toolAllowlist, ["browser_v1"]);
    const create = await ask([{ role: "user", content: driver.fixture.prompt }]);
    assert.equal(create.function.name, "fs_create");
    assert.equal(JSON.parse(create.function.arguments).path, "acceptance-report.html");
    const describe = await ask([{ role: "tool", tool_call_id: create.id, content: "{}" }]);
    assert.equal(JSON.parse(describe.function.arguments).operation, "describe");
    assert.equal(validToolInput(JSON.parse(describe.function.arguments)), true);
    const pageId = "00000000-0000-4000-8000-000000000009";
    const open = await ask([
      {
        role: "tool",
        tool_call_id: describe.id,
        content: JSON.stringify({
          protocol: "areal.browser.host.v1",
          available: true,
          pages: [pageId],
          controlPermit: { pageId },
        }),
      },
    ]);
    assert.equal(JSON.parse(open.function.arguments).operation, "openDocument");
    assert.equal(JSON.parse(open.function.arguments).parameters.path, driver.fixture.localPath);
    assert.equal(validToolInput(JSON.parse(open.function.arguments)), true);
    await assert.rejects(readFile(driver.fixture.localPath), { code: "ENOENT" });
  } finally {
    await driver.fixture.close();
    await rm(directory, { recursive: true });
  }
});

test("generated file approval is bound to the exact Core call, task, and file", () => {
  const localPath = "/isolated/workspace/acceptance-report.html";
  const scope = {
    threadId: "t",
    turnId: "turn",
    localPath,
    allowFileCreate: true,
    fsCreateCalls: [{ callId: "create-1", path: "acceptance-report.html" }],
  };
  const interaction = {
    kind: "approval",
    status: "pending",
    tool: "fs_create",
    threadId: "t",
    turnId: "turn",
    callId: "create-1",
    effectiveArguments: {
      path: "workspace://repo/acceptance-report.html",
      text: "<html>report</html>",
    },
  };
  assert.equal(taskApprovalDecision(interaction, scope).decision, "allowOnce");
  for (const changed of [
    { threadId: "other" },
    { turnId: "other" },
    { callId: "other" },
    { effectiveArguments: { path: "other.html" } },
    { effectiveArguments: { path: "../acceptance-report.html" } },
  ])
    assert.equal(taskApprovalDecision({ ...interaction, ...changed }, scope).decision, "deny");
  assert.equal(
    taskApprovalDecision(interaction, { ...scope, allowFileCreate: false }).decision,
    "deny",
  );
});

test("generated report grading requires matching create hash, ordered open receipt, disk and live DOM", () => {
  const localPath = "/isolated/workspace/acceptance-report.html",
    url = "http://abc.localhost:1234/private/report.html";
  const expected = { localPath, title: "AReaL browser acceptance", nonce: "public-nonce" };
  const sha256 = "1".repeat(64);
  const created = {
    type: "dynamicToolCall",
    tool: "fs_create",
    success: true,
    arguments: { path: "acceptance-report.html" },
    contentItems: [
      {
        type: "text",
        text: JSON.stringify({ path: "workspace://repo/acceptance-report.html", sha256 }),
      },
    ],
  };
  const opened = {
    type: "dynamicToolCall",
    tool: "browser_v1",
    success: true,
    arguments: { operation: "openDocument" },
    execution: {
      effectiveArguments: { plan: { document: { scope: { canonicalFile: localPath } } } },
    },
    contentItems: [{ type: "text", text: JSON.stringify({ dispatch: "confirmed", url }) }],
  };
  const input = {
    status: "completed",
    expected,
    facts: { initiallyAbsent: true },
    history: { turns: [{ status: "completed", items: [created, opened] }] },
    diskArtifact: {
      path: localPath,
      exists: true,
      title: expected.title,
      headings: [expected.title, "Results"],
      noncePresent: true,
      sha256,
    },
    nativePages: [
      { url, title: expected.title, headings: [expected.title, "Results"], text: expected.nonce },
    ],
  };
  assert.equal(gradeTask(GENERATED_TASK.id, input).qualityPassed, true);
  assert.equal(
    gradeTask(GENERATED_TASK.id, { ...input, facts: { initiallyAbsent: false } }).qualityPassed,
    false,
  );
  assert.equal(
    gradeTask(GENERATED_TASK.id, {
      ...input,
      diskArtifact: { ...input.diskArtifact, sha256: "2".repeat(64) },
    }).qualityPassed,
    false,
  );
  assert.equal(gradeTask(GENERATED_TASK.id, { ...input, nativePages: [] }).qualityPassed, false);
  assert.equal(
    gradeTask(GENERATED_TASK.id, {
      ...input,
      history: { turns: [{ status: "completed", items: [opened, created] }] },
    }).qualityPassed,
    false,
  );
});

test("generated native capture binds exact receipt URL and records page, dimensions, and PNG hash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-generated-capture-"));
  const path = join(directory, "native.png");
  const url = "http://abc.localhost:1234/private/report.html";
  const bytes = Buffer.from("deterministic-native-image");
  let captures = 0;
  const target = {
    id: 17,
    isDestroyed: () => false,
    getURL: () => url,
    capturePage: async () => {
      captures++;
      return {
        isEmpty: () => false,
        getSize: () => ({ width: 800, height: 600 }),
        toPNG: () => bytes,
      };
    },
  };
  const other = {
    id: 18,
    isDestroyed: () => false,
    getURL: () => "http://abc.localhost:1234/private/other.html",
    capturePage: async () => {
      throw Error("Unowned page must not be captured");
    },
  };
  const app = {
    evaluate: async (callback, args) =>
      vm.runInNewContext(`(${callback.toString()})(electron, args)`, {
        electron: { webContents: { getAllWebContents: () => [other, target] } },
        args,
      }),
  };
  try {
    const result = await captureGeneratedNativePage(app, [url], path);
    assert.equal(result.status, "captured");
    assert.equal(result.nativePageId, 17);
    assert.equal(result.url, url);
    assert.equal(result.width, 800);
    assert.equal(result.height, 600);
    assert.equal(
      result.sha256,
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    );
    assert.equal(result.visualReview, "not_run");
    const failed = await captureGeneratedNativePage(
      app,
      ["http://outside.invalid/report.html"],
      join(directory, "missing.png"),
    );
    assert.equal(failed.status, "failed");
    assert.equal(failed.visualReview, "not_run");
    assert.equal(captures, 1);
    await assert.rejects(readFile(join(directory, "missing.png")), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true });
  }
});
