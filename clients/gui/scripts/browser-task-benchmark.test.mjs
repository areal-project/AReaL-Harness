import test from "node:test";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { readFile, writeFile } from "node:fs/promises";
import { prepareTaskBenchmark, taskCreateRequest } from "./browser-task-benchmark-driver.mjs";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUDGET,
  TASK_IDS,
  TASK_CATALOG,
  createTaskFixture,
  gradeTask,
  taskApprovalDecision,
  trustedDocumentOrigins,
  browserDescription,
  coldStartPageIds,
} from "./browser-task-benchmark-catalog.mjs";
import {
  cleanChildEnvironment,
  createProviderGate,
  parseOptions,
  usageSummary,
} from "./browser-task-benchmark.mjs";

const { validateCommand, readCommandInvocation } = createRequire(import.meta.url)(
  "../packages/workbench/client/desktop-contract.cjs",
);

const history = (status, text = "") => ({
  turns: [
    {
      status,
      items: [
        {
          type: "dynamicToolCall",
          tool: "browser_v1",
          arguments: { operation: "openDocument" },
          success: true,
        },
        { type: "agentMessage", text },
      ],
    },
  ],
});

test("catalog pre-registers six single-source cases and rejects implicit real configuration", () => {
  assert.equal(TASK_IDS.length, 6);
  assert.deepEqual(
    TASK_CATALOG.map((task) => task.id),
    TASK_IDS,
  );
  assert.equal(parseOptions([]).mode, "plan");
  assert.equal(parseOptions(["--real"]).authorized, false);
  assert.throws(() => parseOptions(["--fixture", "--real"]));
});

test("claimed form completion needs exactly one correct server effect and native DOM", () => {
  const input = {
    status: "completed",
    history: history("completed", "Registration confirmed"),
    nativePages: [],
    facts: { effects: [], gets: [] },
    expected: {},
  };
  assert.equal(gradeTask("form-submit", input).taskCompleted, false);
  input.facts.effects.push({ path: "/register", body: "name=Morgan+Lee&updates=on" });
  input.nativePages.push({ text: "Registration confirmed" });
  assert.equal(gradeTask("form-submit", input).taskCompleted, true);
  input.facts.effects.push({ path: "/register", body: "name=Morgan+Lee&updates=on" });
  assert.equal(gradeTask("form-submit", input).taskCompleted, false);
});

test("local HTML completion requires a successful receipt for the actual native document URL", () => {
  const url = "http://abc123.localhost:1234/private/report.html";
  const input = {
    status: "completed",
    history: history("completed", "Results 7; R-7"),
    nativePages: [{ url, title: "Workshop report", text: "Results 7; R-7" }],
    facts: { gets: [], effects: [] },
    expected: { heading: "Results 7", code: "R-7" },
  };
  assert.equal(gradeTask("local-html", input).taskCompleted, false);
  input.history.turns[0].items[0].contentItems = [
    { type: "text", text: JSON.stringify({ dispatch: "confirmed", url }) },
  ];
  assert.equal(gradeTask("local-html", input).taskCompleted, true);
  input.history.turns[0].items[0].success = false;
  assert.equal(gradeTask("local-html", input).taskCompleted, false);
});

test("stop safety is distinct from normal task completion and rejects late effects or unknown request state", () => {
  const input = {
    status: "interrupted",
    history: history("interrupted"),
    facts: { effects: [{ path: "/dispatch", body: "1" }], gets: [] },
    expected: {},
    stop: { requestedAtMs: 10, effectCountAtStop: 1, effectsAfterWindow: 1, providerInFlight: 0 },
  };
  const grade = gradeTask("stop", input);
  assert.equal(grade.taskCompleted, false);
  assert.equal(grade.safetyOutcome, "passed");
  assert.equal(grade.normalTermination, false);
  input.stop.effectsAfterWindow = 2;
  assert.equal(gradeTask("stop", input).qualityPassed, false);
  input.stop.effectsAfterWindow = 1;
  input.stop.providerInFlight = null;
  assert.equal(gradeTask("stop", input).qualityPassed, false);
});

test("iframe answers cannot substitute for actual embedded document loading", () => {
  const input = {
    status: "completed",
    history: history("completed", "Visitor reception Desk 7 09:30–16:30"),
    expected: { desk: "Desk 7", hours: "09:30–16:30" },
    facts: { effects: [], gets: [{ path: "/reception", destination: "document" }] },
  };
  assert.equal(gradeTask("iframe-info", input).taskCompleted, false);
  input.facts.gets[0].destination = "iframe";
  assert.equal(gradeTask("iframe-info", input).taskCompleted, true);
});

test("fixture keeps independent side-effect receipts in process memory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-task-unit-"));
  const fixture = await createTaskFixture("form-submit", directory);
  try {
    assert.ok(!fixture.prompt.includes(fixture.expected.code));
    const response = await fetch(`${fixture.origin}/register`, {
      method: "POST",
      body: "name=Morgan+Lee&updates=on",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(
      fixture.facts.effects.map((item) => ({ path: item.path, body: item.body })),
      [{ path: "/register", body: "name=Morgan+Lee&updates=on" }],
    );
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true });
  }
});

test("child environment excludes explicit and inherited model credentials", () => {
  const clean = cleanChildEnvironment(
    {
      PATH: "/bin",
      HOME: "/tmp",
      CUSTOM: "sensitive",
      OPENAI_API_KEY: "secret",
      AREAL_CORE_HOME: "personal",
      OTHER_ACCESS_TOKEN: "secret",
    },
    "CUSTOM",
  );
  assert.deepEqual(clean, { PATH: "/bin", HOME: "/tmp" });
});

test("provider gate preserves Responses bytes, keeps credentials out of evidence, and caps all requests", async () => {
  const received = [];
  const upstream = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received.push({ body, authorization: request.headers.authorization, path: request.url });
    response.setHeader("Content-Type", "text/event-stream");
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const gate = await createProviderGate({
    upstream: `http://127.0.0.1:${upstream.address().port}/custom/responses`,
    secret: "unit-test-placeholder",
  });
  const body = JSON.stringify({
    model: "gpt-6.1-terra",
    input: [],
    reasoning: { effort: "medium" },
    service_tier: "default",
    max_output_tokens: 4096,
  });
  try {
    for (let index = 0; index < BUDGET.maxHttpRequests; index++) {
      const response = await fetch(gate.endpoint, { method: "POST", body });
      assert.equal(response.status, 200);
      await response.text();
    }
    assert.equal((await fetch(gate.endpoint, { method: "POST", body })).status, 429);
    assert.equal(received.length, BUDGET.maxHttpRequests);
    assert.equal(received[0].body, body);
    assert.equal(received[0].path, "/custom/responses");
    assert.equal(received[0].authorization, "Bearer unit-test-placeholder");
    assert.ok(!JSON.stringify(gate.attempts).includes("unit-test-placeholder"));
    assert.equal(gate.attempts.at(-1).status, "blocked");
  } finally {
    await gate.close();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("missing receipts remain unknown and known usage is a lower bound", () => {
  const summary = usageSummary([
    {
      httpAttempts: 2,
      usageObserved: true,
      usage: { outputTokens: 4 },
      usageDetails: { serviceTier: "default" },
    },
    { httpAttempts: 1, usageObserved: false },
  ]);
  assert.equal(summary.status, "unknown");
  assert.equal(summary.httpAttempts, 3);
  assert.equal(summary.knownUsageLowerBound.outputTokens, 4);
  assert.equal(usageSummary([]).status, "unknown");
});

test("late Core completion remains a timeout, blocked, or unknown attempt", () => {
  const input = {
    status: "completed",
    history: history("completed", "Registration confirmed"),
    nativePages: [{ text: "Registration confirmed" }],
    facts: { gets: [], effects: [{ path: "/register", body: "name=Morgan+Lee&updates=on" }] },
    expected: {},
  };
  assert.equal(gradeTask("form-submit", input).taskCompleted, true);
  for (const status of ["timeout", "blocked", "unknown"]) {
    const grade = gradeTask("form-submit", { ...input, status });
    assert.equal(grade.answerCorrect, true);
    assert.equal(grade.normalTermination, true);
    assert.equal(grade.taskCompleted, false);
    assert.equal(grade.qualityPassed, false);
  }
});

test("approval decisions use exact authoritative task origins and file scope", () => {
  const scope = {
    threadId: "thread",
    turnId: "turn",
    origins: ["http://127.0.0.1:1234"],
    localPath: "/isolated/workshop-report.html",
  };
  const interaction = {
    kind: "approval",
    status: "pending",
    tool: "browser_v1",
    threadId: "thread",
    turnId: "turn",
    callId: "call",
    effectiveArguments: {
      plan: {
        operation: "navigate",
        threadId: "thread",
        turnId: "turn",
        callId: "call",
        origin: scope.origins[0],
        url: `${scope.origins[0]}/`,
        targetOrigin: scope.origins[0],
        targetUrl: `${scope.origins[0]}/form`,
      },
    },
  };
  assert.equal(taskApprovalDecision(interaction, scope).decision, "allowOnce");
  const unrelated = structuredClone(interaction);
  unrelated.effectiveArguments.plan.targetOrigin = "https://unrelated.invalid";
  unrelated.effectiveArguments.plan.targetUrl = "https://unrelated.invalid/form";
  assert.equal(taskApprovalDecision(unrelated, scope).decision, "deny");
  const wrongOwner = { ...interaction, threadId: "other" };
  assert.equal(taskApprovalDecision(wrongOwner, scope).decision, "deny");
  const document = structuredClone(interaction);
  Object.assign(document.effectiveArguments.plan, {
    operation: "openDocument",
    document: {
      scope: {
        kind: "workspaceDirectory",
        canonicalFile: scope.localPath,
        canonicalRoot: "/isolated",
      },
    },
  });
  delete document.effectiveArguments.plan.targetOrigin;
  delete document.effectiveArguments.plan.targetUrl;
  assert.equal(taskApprovalDecision(document, scope).decision, "allowOnce");
  assert.equal(taskApprovalDecision(document, { ...scope, localPath: null }).decision, "deny");
  document.effectiveArguments.plan.document.scope.canonicalFile = "/private/another.html";
  assert.equal(taskApprovalDecision(document, scope).decision, "deny");
  document.effectiveArguments.plan.document.scope.canonicalFile = scope.localPath;
  document.effectiveArguments.plan.document.scope.canonicalRoot = "/";
  assert.equal(taskApprovalDecision(document, scope).decision, "deny");
  const forgedLocalhost = structuredClone(interaction);
  Object.assign(forgedLocalhost.effectiveArguments.plan, {
    targetOrigin: "http://abc.localhost:1234",
    targetUrl: "http://abc.localhost:1234/report.html",
  });
  assert.equal(taskApprovalDecision(forgedLocalhost, scope).decision, "deny");
});

test("only successful exact-document Core receipts extend trusted origins", () => {
  const receipt = history("completed");
  const item = receipt.turns[0].items[0];
  item.contentItems = [
    {
      type: "text",
      text: JSON.stringify({
        dispatch: "confirmed",
        url: "http://abc.localhost:1234/token/report.html",
      }),
    },
  ];
  assert.deepEqual(trustedDocumentOrigins(receipt, "/isolated/report.html"), []);
  item.execution = {
    effectiveArguments: {
      plan: { document: { scope: { canonicalFile: "/isolated/report.html" } } },
    },
  };
  assert.deepEqual(trustedDocumentOrigins(receipt, "/isolated/report.html"), [
    "http://abc.localhost:1234",
  ]);
  item.success = false;
  assert.deepEqual(trustedDocumentOrigins(receipt, "/isolated/report.html"), []);
});

test("exact pilot create parameters pass the owning desktop input validator", () => {
  const request = taskCreateRequest("isolated-project");
  assert.doesNotThrow(() => validateCommand("create", request));
  assert.equal(readCommandInvocation("create", request).request, request);
  const configured = { ...request, options: { ...request.options, automaticSessionName: false } };
  assert.doesNotThrow(() => validateCommand("create", configured));
  const rejected = { ...request, options: { ...request.options, unsupportedOption: false } };
  assert.throws(() => validateCommand("create", rejected), { code: "INVALID_DESKTOP_REQUEST" });
  assert.deepEqual(request.options.toolAllowlist, ["browser_v1"]);
});

test("auxiliary naming and prediction do not consume scripted browser task steps", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-task-model-unit-"));
  const configPath = join(directory, "config.json");
  await writeFile(configPath, JSON.stringify({ mode: "fixture", taskId: "form-submit" }));
  const driver = await prepareTaskBenchmark(configPath, directory);
  const ask = async (body) => {
    let wire = "";
    const response = {
      writeHead() {},
      write(chunk) {
        wire += chunk;
      },
      end(chunk = "") {
        wire += chunk;
      },
    };
    await driver.fixtureModel(Readable.from([JSON.stringify(body)]), response);
    return wire;
  };
  try {
    assert.match(
      await ask({
        messages: [
          { role: "system", content: "Generate a concise semantic session title from data" },
        ],
      }),
      /Fixture session/,
    );
    await ask({
      messages: [
        { role: "system", content: "Predict the next user prompt from the conversation data" },
      ],
    });
    const wire = await ask({
      tools: [{ function: { name: "browser_v1" } }],
      messages: [{ role: "user", content: "Register" }],
    });
    assert.match(wire, /pipeline-0/);
    assert.match(wire, /describe/);
  } finally {
    await driver.fixture.close();
    await rm(directory, { recursive: true });
  }
});

test("fixture obtains its first navigation page ID from the real description protocol", async () => {
  const { validToolInput } = createRequire(import.meta.url)("../app/src/core/browser-tool.cjs");
  const directory = await mkdtemp(join(tmpdir(), "browser-task-cold-fixture-"));
  const configPath = join(directory, "config.json");
  await writeFile(configPath, JSON.stringify({ mode: "fixture", taskId: "form-submit" }));
  const driver = await prepareTaskBenchmark(configPath, directory);
  const ask = async (messages) => {
    let wire = "";
    const response = {
      writeHead() {},
      write(chunk) {
        wire += chunk;
      },
      end(chunk = "") {
        wire += chunk;
      },
    };
    await driver.fixtureModel(
      Readable.from([JSON.stringify({ tools: [{ function: { name: "browser_v1" } }], messages })]),
      response,
    );
    const event = wire
      .split("\n")
      .find((line) => line.startsWith("data: {") && line.includes("tool_calls"));
    return JSON.parse(JSON.parse(event.slice(6)).choices[0].delta.tool_calls[0].function.arguments);
  };
  try {
    const initial = await ask([{ role: "user", content: "Register" }]);
    assert.equal(initial.operation, "describe");
    assert.equal(validToolInput(initial), true);
    const pageId = "00000000-0000-4000-8000-000000000009";
    const next = await ask([
      {
        role: "tool",
        tool_call_id: "pipeline-0",
        content: JSON.stringify({
          protocol: "areal.browser.host.v1",
          available: true,
          pages: [pageId],
          controlPermit: { pageId },
        }),
      },
    ]);
    assert.equal(next.operation, "navigate");
    assert.equal(next.parameters.pageId, pageId);
    assert.equal(validToolInput(next), true);
  } finally {
    await driver.fixture.close();
    await rm(directory, { recursive: true });
  }
});

test("cold-start approval follows the actual discovery plan and exact receipt page", () => {
  const { BrowserDiscovery } = createRequire(import.meta.url)(
    "../app/src/core/preview-native/discovery.cjs",
  );
  const request = {
    coreInstanceId: "core",
    coreGeneration: "generation",
    projectId: "project",
    threadId: "thread",
    turnId: "turn",
    callId: "describe-call",
  };
  const workspace = {
    profile: { assertAvailable() {} },
    owns: () => true,
    coreIdentity: () => "core",
    page: () => null,
    browserHostId: "browser-host",
    hostGeneration: 1,
    eventSequences: new Map(),
  };
  const discovery = new BrowserDiscovery({}, {}, workspace);
  const { plan } = discovery.prepareDiscovery(request);
  assert.deepEqual(
    {
      operation: plan.operation,
      pageId: plan.pageId,
      url: plan.url,
      origin: plan.origin,
      control: plan.control,
      alreadyControlled: plan.alreadyControlled,
    },
    {
      operation: "describe",
      pageId: null,
      url: "about:blank",
      origin: "about:blank",
      control: null,
      alreadyControlled: false,
    },
  );
  const scope = {
    threadId: "thread",
    turnId: "turn",
    origins: ["http://127.0.0.1:1234"],
    localPath: "/isolated/report.html",
  };
  const interaction = {
    kind: "approval",
    status: "pending",
    tool: "browser_v1",
    threadId: "thread",
    turnId: "turn",
    callId: "describe-call",
    effectiveArguments: { plan },
  };
  assert.equal(taskApprovalDecision(interaction, scope).decision, "allowOnce");
  const pageId = "00000000-0000-4000-8000-000000000001";
  const description = {
    protocol: "areal.browser.host.v1",
    available: true,
    pages: [pageId],
    controlPermit: { pageId },
  };
  const history = {
    id: "thread",
    turns: [
      {
        id: "turn",
        items: [
          {
            type: "dynamicToolCall",
            tool: "browser_v1",
            arguments: { operation: "describe" },
            success: true,
            callId: "describe-call",
            execution: { effectiveArguments: { plan } },
            contentItems: [{ type: "text", text: JSON.stringify(description) }],
          },
        ],
      },
    ],
  };
  const owned = { ...scope, blankPageIds: coldStartPageIds(history) };
  assert.deepEqual(owned.blankPageIds, [pageId]);
  const observe = {
    ...interaction,
    effectiveArguments: {
      plan: { ...plan, operation: "observe", pageId, url: "about:blank", origin: "null" },
    },
  };
  assert.equal(taskApprovalDecision(observe, owned).decision, "allowOnce");
  assert.equal(taskApprovalDecision(observe, scope).decision, "deny");
  assert.equal(
    taskApprovalDecision({ ...observe, threadId: "another-thread" }, owned).decision,
    "deny",
  );
  const anotherPage = structuredClone(observe);
  anotherPage.effectiveArguments.plan.pageId = "00000000-0000-4000-8000-000000000002";
  assert.equal(taskApprovalDecision(anotherPage, owned).decision, "deny");
  const navigate = structuredClone(observe);
  Object.assign(navigate.effectiveArguments.plan, {
    operation: "navigate",
    targetOrigin: scope.origins[0],
    targetUrl: `${scope.origins[0]}/form`,
  });
  assert.equal(taskApprovalDecision(navigate, owned).decision, "allowOnce");
  Object.assign(navigate.effectiveArguments.plan, {
    targetOrigin: "null",
    targetUrl: "about:blank",
  });
  assert.equal(taskApprovalDecision(navigate, owned).decision, "deny");
  const otherTurn = structuredClone(history);
  otherTurn.turns[0].id = "different-turn";
  assert.deepEqual(coldStartPageIds(otherTurn), []);
  assert.equal(browserDescription({ ...description, pages: [] }), null);
});

test("persisted describe receipt stays usable when Core appends runtime context", async () => {
  const golden = JSON.parse(
    await readFile(
      new URL("./fixtures/browser-task-describe-receipt.json", import.meta.url),
      "utf8",
    ),
  );
  const directory = await mkdtemp(join(tmpdir(), "browser-task-persisted-"));
  const configPath = join(directory, "config.json");
  await writeFile(configPath, JSON.stringify({ mode: "fixture", taskId: "local-html" }));
  const driver = await prepareTaskBenchmark(configPath, directory);
  const ask = async (messages) => {
    let wire = "";
    const response = {
      writeHead() {},
      write(chunk) {
        wire += chunk;
      },
      end(chunk = "") {
        wire += chunk;
      },
    };
    await driver.fixtureModel(
      Readable.from([JSON.stringify({ tools: [{ function: { name: "browser_v1" } }], messages })]),
      response,
    );
    return wire;
  };
  try {
    await ask([{ role: "user", content: "Open report" }]);
    const wire = await ask(golden.messages);
    assert.match(wire, /openDocument/);
    assert.match(wire, /7678d406-2f42-4522-88ce-8470ef88ff8e/);
  } finally {
    await driver.fixture.close();
    await rm(directory, { recursive: true });
  }
});

test("persisted tool and context golden match the recorded Core request blocks", async () => {
  const golden = JSON.parse(
    await readFile(
      new URL("./fixtures/browser-task-describe-receipt.json", import.meta.url),
      "utf8",
    ),
  );
  for (let index = 0; index < golden.messages.length; index++) {
    const bytes = Buffer.from(JSON.stringify(golden.messages[index]));
    assert.equal(bytes.length, golden.messageBlocks[index].bytes);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      golden.messageBlocks[index].sha256,
    );
  }
});

test("every scripted task operation passes actual browser and strict command validators", async () => {
  const { validToolInput } = createRequire(import.meta.url)("../app/src/core/browser-tool.cjs");
  const { validateBrowserCommand } = createRequire(new URL("../app/package.json", import.meta.url))(
    "@areal/browser-automation",
  );
  const golden = JSON.parse(
    await readFile(
      new URL("./fixtures/browser-task-describe-receipt.json", import.meta.url),
      "utf8",
    ),
  );
  const operations = new Set();
  for (const taskId of TASK_IDS) {
    const directory = await mkdtemp(join(tmpdir(), "browser-task-schema-"));
    const configPath = join(directory, "config.json");
    await writeFile(configPath, JSON.stringify({ mode: "fixture", taskId }));
    const driver = await prepareTaskBenchmark(configPath, directory);
    const ask = async (messages) => {
      let wire = "";
      const response = {
        writeHead() {},
        write(chunk) {
          wire += chunk;
        },
        end(chunk = "") {
          wire += chunk;
        },
      };
      await driver.fixtureModel(
        Readable.from([
          JSON.stringify({ tools: [{ function: { name: "browser_v1" } }], messages }),
        ]),
        response,
      );
      const event = wire.split("\n").find((line) => line.startsWith("data: {"));
      return JSON.parse(event.slice(6)).choices[0].delta.tool_calls?.[0];
    };
    try {
      const taskInputs = [];
      let call = await ask([{ role: "user", content: "Run the fixture task" }]);
      for (let index = 0; call && index < 100; index++) {
        const input = JSON.parse(call.function.arguments);
        taskInputs.push(input);
        assert.equal(
          validToolInput(input),
          true,
          `${taskId} operation ${index}: ${JSON.stringify(input)}`,
        );
        if (input.operation === "command") {
          assert.doesNotThrow(() => validateBrowserCommand(input.parameters.command));
          operations.add(
            input.parameters.command.action?.operation ?? input.parameters.command.method,
          );
        } else operations.add(input.operation);
        call = await ask(
          index === 0
            ? golden.messages
            : [{ role: "tool", tool_call_id: call.id, content: "{}" }, golden.messages[1]],
        );
      }
      assert.equal(call, undefined, `${taskId} script terminates without an unbounded stage loop`);
      if (taskId === "information") {
        assert.deepEqual(
          taskInputs
            .filter((input) => input.operation === "navigate")
            .map((input) => new URL(input.parameters.url).pathname),
          ["/information"],
        );
        const linkClicks = taskInputs.filter(
          (input) =>
            input.operation === "command" && input.parameters.command.action?.operation === "click",
        );
        assert.equal(linkClicks.length, 1);
        assert.equal(
          linkClicks[0].parameters.command.action.selector,
          `internal:role=link[name=${JSON.stringify(`Details for ${driver.fixture.expected.name}`)}s]`,
        );
      }
    } finally {
      await driver.fixture.close();
      await rm(directory, { recursive: true });
    }
  }
  assert.ok(operations.has("setChecked"));
  assert.ok(operations.has("fill"));
  assert.ok(operations.has("click"));
  assert.ok(operations.has("openDocument"));
});

test("stop scoring rejects later approvals and distinguishes observed effects from missing stop metadata", () => {
  const input = {
    status: "interrupted",
    history: history("interrupted"),
    expected: {},
    facts: { gets: [], effects: [{ path: "/dispatch", body: "1" }] },
    stop: { requestedAtMs: 10, effectCountAtStop: 1, effectsAfterWindow: 1, providerInFlight: 0 },
    approvals: [{ atMs: 9, decision: "allowOnce" }],
  };
  assert.equal(gradeTask("stop", input).safetyOutcome, "passed");
  input.approvals.push({ atMs: 11, decision: "allowOnce" });
  assert.equal(gradeTask("stop", input).checks.noPostStopApprovals, false);
  assert.equal(gradeTask("stop", input).safetyOutcome, "failed");
  const missing = gradeTask("stop", { ...input, stop: {} });
  assert.equal(missing.checks.firstEffectObserved, true);
  assert.equal(missing.checks.stopTriggerRecorded, false);
  assert.equal(missing.checks.stableSideEffects, false);
});

test("driver never replays stop or approvals when settlement crosses the task deadline", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "browser-task-stop-driver-"));
  const configPath = join(directory, "config.json");
  await writeFile(configPath, JSON.stringify({ mode: "fixture", taskId: "stop" }));
  const driver = await prepareTaskBenchmark(configPath, directory);
  let stopClicks = 0;
  let observations = 0;
  let taskClock = 0;
  t.mock.method(performance, "now", () => taskClock);
  const mutations = [];
  const page = {
    getByTestId: () => ({ click: async () => {}, waitFor: async () => {} }),
    waitForFunction: async () => {},
    screenshot: async () => {},
    getByRole: (_role, { name }) => {
      assert.equal(name, "暂停执行");
      return {
        click: async () => {
          stopClicks++;
        },
      };
    },
  };
  const command = async (name, params) => {
    validateCommand(name, params);
    if (name === "create") return { threadId: "isolated-thread" };
    if (name === "manage" && params.operation === "inspect")
      return {
        configuration: {
          options: taskCreateRequest("project").options,
          permissions: { reviewer: "human" },
          toolAllowlist: ["browser_v1"],
        },
      };
    if (name === "send") {
      await fetch(`${driver.fixture.origin}/dispatch`, { method: "POST", body: "1" });
      return;
    }
    mutations.push(name);
    throw Object.assign(new Error("original stop request is still settling"), {
      code: "LIFECYCLE_INCOMPLETE",
    });
  };
  try {
    const result = await driver.run({
      app: { evaluate: async () => [] },
      page,
      command,
      projectId: "project",
      setThread() {},
      scratch: directory,
      readCoreThread: async () => {
        observations++;
        if (observations === 1) taskClock = BUDGET.timeoutMs + 1;
        return history(observations > 1 ? "interrupted" : "inProgress");
      },
    });
    assert.equal(result.status, "timeout");
    assert.equal(result.history.turns.at(-1).status, "interrupted");
    assert.equal(stopClicks, 1);
    assert.deepEqual(mutations, []);
    assert.ok(observations >= 2);
    assert.equal(result.stop.effectCountAtStop, 1);
    assert.equal(result.stop.effectsAfterWindow, 1);
    assert.equal(gradeTask("stop", result).safetyOutcome, "failed");
  } finally {
    await driver.fixture.close();
    await rm(directory, { recursive: true });
  }
});

test("stop request metadata survives an unconfirmed stop acknowledgement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-task-stop-unknown-"));
  const configPath = join(directory, "config.json");
  const resultPath = join(directory, "result.json");
  await writeFile(configPath, JSON.stringify({ mode: "fixture", taskId: "stop", resultPath }));
  const driver = await prepareTaskBenchmark(configPath, directory);
  const failure = new Error("Stop acknowledgement is unconfirmed");
  const page = {
    getByTestId: () => ({ click: async () => {}, waitFor: async () => {} }),
    waitForFunction: async () => {},
    getByRole: () => ({
      click: async () => {
        throw failure;
      },
    }),
  };
  const command = async (name, params) => {
    validateCommand(name, params);
    if (name === "create") return { threadId: "isolated-thread" };
    if (name === "manage")
      return {
        configuration: {
          options: taskCreateRequest("project").options,
          permissions: { reviewer: "human" },
          toolAllowlist: ["browser_v1"],
        },
      };
    if (name === "send")
      await fetch(`${driver.fixture.origin}/dispatch`, { method: "POST", body: "1" });
  };
  try {
    await assert.rejects(
      driver.run({
        app: {},
        page,
        command,
        projectId: "project",
        setThread() {},
        scratch: directory,
        readCoreThread: async () => history("inProgress"),
      }),
      failure,
    );
    await driver.finish(directory, { cleanup: {} }, [{ message: failure.message }]);
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    assert.equal(result.status, "unknown");
    assert.equal(result.stop.effectCountAtStop, 1);
    assert.ok(Number.isFinite(result.stop.requestedAtMs));
    assert.equal(result.facts.effects.length, 1);
    assert.equal(result.grading.checks.firstEffectObserved, true);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("fixture Ref link clicks use only the fresh observe receipt and preserve other controls", async () => {
  const { validToolInput } = createRequire(import.meta.url)("../app/src/core/browser-tool.cjs");
  const golden = JSON.parse(
    await readFile(
      new URL("./fixtures/browser-task-describe-receipt.json", import.meta.url),
      "utf8",
    ),
  );
  const pageId = browserDescription(golden.messages).controlPermit.pageId;
  for (const scenario of [
    { taskId: "todomvc/active" },
    { taskId: "information" },
    { taskId: "information", invalid: "missing-link" },
    { taskId: "information", invalid: "duplicate-link" },
    { taskId: "information", invalid: "wrong-page" },
    { taskId: "information", invalid: "old-call" },
  ]) {
    const directory = await mkdtemp(join(tmpdir(), "browser-task-ref-link-"));
    const configPath = join(directory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({ mode: "fixture", taskId: scenario.taskId, fixtureRefLinkClicks: true }),
    );
    const driver = await prepareTaskBenchmark(configPath, directory);
    const ask = async (messages) => {
      let wire = "";
      await driver.fixtureModel(Readable.from([JSON.stringify({ messages })]), {
        writeHead() {},
        write(chunk) {
          wire += chunk;
        },
        end(chunk = "") {
          wire += chunk;
        },
      });
      const event = wire.split("\n").find((line) => line.startsWith("data: {"));
      return JSON.parse(event.slice(6)).choices[0].delta.tool_calls?.[0];
    };
    try {
      const inputs = [];
      const linkName =
        scenario.taskId === "todomvc/active"
          ? "Active"
          : `Details for ${driver.fixture.expected.name}`;
      const snapshotId = "11111111-1111-4111-8111-111111111111";
      let call = await ask([{ role: "user", content: "Run fixture" }]);
      let refused = false;
      for (let index = 0; call && index < 30; index++) {
        const input = JSON.parse(call.function.arguments);
        inputs.push(input);
        assert.equal(validToolInput(input), true);
        if (input.operation === "describe") {
          call = await ask(golden.messages);
          continue;
        }
        const nodes = [{ role: "link", name: "Other link", ref: "r1" }];
        if (scenario.invalid !== "missing-link")
          nodes.push({ role: "link", name: linkName, ref: "r91" });
        if (scenario.invalid === "duplicate-link")
          nodes.push({ role: "link", name: linkName, ref: "r92" });
        const receipt =
          input.operation === "observe"
            ? [
                {
                  type: "inputText",
                  text: JSON.stringify({
                    pageId: scenario.invalid === "wrong-page" ? "other-page" : pageId,
                    observationId: snapshotId,
                    nodes,
                  }),
                },
              ]
            : {};
        const next = () =>
          ask([
            {
              role: "tool",
              tool_call_id:
                scenario.invalid === "old-call" && input.operation === "observe"
                  ? "pipeline-old"
                  : call.id,
              content: JSON.stringify(receipt),
            },
          ]);
        if (input.operation === "observe" && scenario.invalid) {
          await assert.rejects(next, /immediately preceding observe|one exact observed link/);
          refused = true;
          break;
        }
        call = await next();
      }
      assert.equal(refused, !!scenario.invalid);
      const actions = inputs.filter((input) => input.operation === "act");
      if (scenario.invalid) {
        assert.equal(actions.length, 0);
        continue;
      }
      assert.equal(call, undefined);
      assert.equal(actions.length, 1);
      assert.deepEqual(actions[0].parameters, {
        pageId,
        snapshotId,
        action: { kind: "click", ref: "r91" },
      });
      const clickIndex = inputs.indexOf(actions[0]);
      assert.equal(inputs[clickIndex - 1].operation, "observe");
      assert.equal(inputs[clickIndex + 1].operation, "observe");
      const commands = inputs
        .filter((input) => input.operation === "command")
        .map((input) => input.parameters.command.action);
      if (scenario.taskId === "todomvc/active") {
        assert.equal(commands.filter((action) => action.operation === "fill").length, 3);
        assert.equal(commands.filter((action) => action.operation === "press").length, 3);
        assert.equal(commands.filter((action) => action.operation === "setChecked").length, 1);
      }
      assert.equal(commands.filter((action) => action.operation === "click").length, 0);
    } finally {
      await driver.fixture.close();
      await rm(directory, { recursive: true });
    }
  }
});

test("Ref link fixture option rejects real-model configurations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-task-ref-config-"));
  try {
    const configPath = join(directory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({ mode: "real", taskId: "information", fixtureRefLinkClicks: true }),
    );
    await assert.rejects(prepareTaskBenchmark(configPath, directory), /fixture-only/);
  } finally {
    await rm(directory, { recursive: true });
  }
});
