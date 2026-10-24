// 执行原生 harness 的原始回调，不启动 HTTP/Core/Runtime/Electron 或子进程。
import assert from "node:assert/strict";
import { readFile, mkdtemp } from "node:fs/promises";
import { createHash, randomUUID, webcrypto } from "node:crypto";
import { join } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
const require = createRequire(import.meta.url);
const { CoreBackend } = require("../app/src/core/backend.cjs");
const { sessionCommand } = require("../app/src/core/remote-session-commands.cjs");
const source = await readFile(
  new URL("./remote-session-commands-e2e.mjs", import.meta.url),
  "utf8",
);
function between(start, end) {
  const offset = source.indexOf(start);
  assert.ok(offset >= 0, `missing callback boundary ${start}`);
  const last = source.indexOf(end, offset);
  assert.ok(last > offset, `missing callback end ${end}`);
  return source.slice(offset, last);
}
const modelCallback = runInNewContext(
  `${between("  const model = createServer(async (req, res) => {", "  await new Promise((resolve) => model.listen")}\nmodel;`,
  {
    createServer: (callback) => callback,
    Buffer,
    assert,
    join,
    randomUUID,
    workspace: "/fixture",
    modelRequests: 0,
    held: new Set(),
    taskModels: new Map(),
    taskQuestionEvidence: { model: [] },
  },
);
async function model(messages, request = {}) {
  let output,
    status,
    held = false;
  await modelCallback(
    {
      url: request.url,
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify({ messages, ...request.body }));
      },
    },
    {
      writeHead(value) {
        status = value;
      },
      end(value) {
        output = value;
      },
      on() {
        held = true;
      },
    },
  );
  const events = output
    ?.split("\n\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)));
  const tool = events?.flatMap((event) => event.choices?.[0].delta.tool_calls ?? [])[0];
  return { tool, held, status, output, events };
}
const a = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  b = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const user = (text) => ({ role: "user", content: text });
const approvalA = user(`RC07_APPROVAL:${a}`),
  approvalB = user(`RC07_APPROVAL:${b}`);
const first = await model([approvalA]);
assert.equal(first.tool.function.name, "run_command");
assert.match(JSON.parse(first.tool.function.arguments).command, new RegExp(a));
for (const history of [[approvalA, { role: "tool", content: "denied" }], [approvalA]]) {
  const replacement = await model([...history, approvalB]);
  assert.ok(replacement.tool, "same Thread's new user Turn must request its own approval");
  assert.match(JSON.parse(replacement.tool.function.arguments).command, new RegExp(b));
  assert.doesNotMatch(JSON.parse(replacement.tool.function.arguments).command, new RegExp(a));
}
assert.equal((await model([approvalA, { role: "tool", content: "done" }])).tool, undefined);
const question = await model([
  approvalA,
  { role: "tool", content: "done" },
  user(`RC07_QUESTION:${b}`),
]);
assert.equal(question.tool.function.name, "ask_user_question");
const expiredHistory = await model([
  user(`RC07_QUESTION:${a} RC07_EXPIRE`),
  { role: "tool", content: "expired" },
  user(`RC07_QUESTION:${b}`),
]);
assert.equal(JSON.parse(expiredHistory.tool.function.arguments).timeoutSeconds, 600);
const largeHistory = await model([
  user(`RC07_APPROVAL:${a} RC07_LARGE`),
  { role: "tool", content: "done" },
  approvalB,
]);
assert.ok(Buffer.byteLength(largeHistory.tool.function.arguments) < 1024);
const largest = await model([
  approvalA,
  { role: "tool", content: "done" },
  user(`RC07_APPROVAL:${b} RC07_LARGE`),
]);
assert.equal(Buffer.byteLength(largest.tool.function.arguments), 64 * 1024);
const executable = await model([user(`RC07_APPROVAL:${b} RC07_EXECUTABLE_LARGE`)]);
assert.equal(Buffer.byteLength(executable.tool.function.arguments), 48 * 1024);
assert.match(JSON.parse(executable.tool.function.arguments).command, /printf x >> /);
assert.equal(
  (
    await model([
      user("RC05_HOLD"),
      { role: "assistant", content: "done" },
      user(`RC05_EFFECT:${b}`),
    ])
  ).held,
  false,
);
console.log(
  "Native model callback scopes replacement approval/question/effect to the current user Turn",
);
const home = await mkdtemp("/private/tmp/rc-native-harness-contract-");
const backend = new CoreBackend({ home, binary: "/unused", onChange() {} });
backend.saved = [{ id: "p", root: home }];
backend.defaultProfile = { id: "fixture", revision: "v1" };
const project = await backend.loadProjectJournal("p");
project.resourceProfile = { id: "fixture", revision: "v1" };
project.service = { generation: "g" };
project.model.connection(true);
const calls = [];
project.client = {
  ready: true,
  capabilities: { features: { threadStartAdmissionGuard: true, permissionPresets: true }, methods: ["areal/thread/start"] },
  async request(method, params) {
    calls.push({ method, params });
    if (params.agentProfile.id === "flow")
      throw Object.assign(new Error("UNSUPPORTED_PROFILE: workflow"), { code: -32602 });
    return { thread: { id: "thread" } };
  },
};
let handler, response;
runInNewContext(between("  let fault = null,", '  process.send({\n    event: "ready",'), {
  backend,
  project,
  structuredClone,
  process: {
    on(_event, callback) {
      handler = callback;
    },
    send(value) {
      response = value;
    },
    exit() {
      throw new Error("unexpected process exit");
    },
  },
});
const control = async (method, params) => {
  await handler({ id: 1, method, params });
  assert.ok(!response.error, JSON.stringify(response));
  return response.result;
};
const flow = { id: "flow", revision: "v1" };
assert.deepEqual(JSON.parse(JSON.stringify(await control("profile", flow))), flow);
const remote = {
  backend,
  gatewayGeneration: "gw",
  config: {
    identity: {},
    deviceGrants: [
      {
        devicePeerId: "peer",
        status: "active",
        revision: 1,
        projectIds: ["p"],
        capabilities: ["observe", "submit"],
      },
    ],
  },
  crypto: { identityId: () => "host" },
};
const result = await sessionCommand(
  remote,
  { peer: "peer", grantRevision: 1, gatewayGeneration: "gw", alive: () => true },
  {
    id: "create",
    method: "session.create",
    commandId: randomUUID(),
    context: { projectId: "p", gatewayGeneration: "gw", grantRevision: 1, serviceGeneration: "g" },
    params: {},
  },
  (value) => value,
);
assert.deepEqual(calls[0].params.agentProfile, flow);
assert.deepEqual(JSON.parse(JSON.stringify(await control("last-create-profile"))), flow);
assert.equal(result.admissionState, "rejected");
assert.equal(result.error.code, "UNSUPPORTED_PROFILE");
console.log("Trusted profile control reaches actual production Gateway native create parameters");
const modes = between(
  '  const taskPauseOnly = process.env.RC09_TASK_PAUSE_ONLY === "1";',
  "  const scratch = await mkdtemp(",
);
const reportSource = between(
  "    const report = {",
  '    await writeFile(join(scratch, "manifest.json")',
);
for (const [flag, selectedSuite, testCase] of [
  ["RC10_REVIEW_ONLY", "RC10_T32_T33_T34", "T32/T33/T34"],
  ["RC05_PREFLIGHT_ONLY", "RC05_T21", "T21"],
  ["RC06_SETTLEMENT_ONLY", "RC06_T24", "T24"],
  ["RC07_SETTLEMENT_ONLY", "RC07_T26_T27", "T26/T27"],
  ["RC08_TASK_QUESTIONS_ONLY", "RC08_T28_T29", "T28/T29"],
]) {
  const mode = runInNewContext(
    `${modes}\n({reviewOnly,preflightOnly,settlementOnly,interactionSettlementOnly,taskQuestionsOnly,taskPauseOnly,repetitions});`,
    {
      process: { env: { [flag]: "1" } },
      assert,
    },
  );
  assert.equal(mode.repetitions, 0);
  const reportContext = {
    passed: true,
    transport: "direct",
    transportFixture: undefined,
    transportFailureEvidence: undefined,
    requiredUnrun: [],
    phaseErrors: [],
    recentRpcOutcomes: [],
    remoteConfigSha256: "fixture",
    hostWorkers: [],
    ownedProcesses: new Map(),
    taskOwnershipEvidence: { response: { error: { code: "TASK_CONTROL_REQUIRED" } } },
    settlementEvidence: { runtimeResourcesConfirmedReleased: false },
    interactionEvidence: {},
    taskQuestionEvidence: {},
    taskPauseEvidence: {},
    reviewEvidence: {},
    reviewOnly: mode.reviewOnly,
    taskPauseOnly: mode.taskPauseOnly,
    taskQuestionsOnly: mode.taskQuestionsOnly,
    checks: [{ case: testCase }],
    repetitions: mode.repetitions,
    completedRaceIterations: 0,
    interactionOnly: false,
    stopOnly: false,
    preflightOnly: mode.preflightOnly,
    settlementOnly: mode.settlementOnly,
    interactionSettlementOnly: mode.interactionSettlementOnly,
    modelRequests: 0,
    cleanup: [],
    drainStatus: undefined,
    execFileSync: () => "fixture-source",
    root: "/unused",
    binary: "/unused",
    createHash,
    readFile: async () => Buffer.from("fixture"),
  };
  const evaluateReport = (overrides) =>
    runInNewContext(`(async () => {${reportSource}\nreturn report;})()`, {
      ...reportContext,
      ...overrides,
    });
  const report = await evaluateReport({});
  assert.equal(report.selectedSuite, selectedSuite);
  assert.deepEqual(JSON.parse(JSON.stringify(report.coveredCases)), testCase.split("/"));
  assert.equal(report.requestedRepetitions, 0);
  assert.equal(report.completedRaceIterations, 0);
  assert.equal(report.acceptanceRepetitionsMet, false);
  assert.equal(report.raceAcceptanceRequired, false);
  assert.equal(report.passed, true);
  assert.equal(report.recentRpcOutcomes, undefined);
  const diagnostic = [{ method: "session.create", id: "1", errorCode: "LIMIT_EXCEEDED" }];
  const failed = await evaluateReport({ passed: false, recentRpcOutcomes: diagnostic });
  assert.equal(failed.passed, false);
  assert.equal(failed.acceptance, false);
  assert.equal(failed.recentRpcOutcomes, diagnostic);
  assert.equal(report.taskOwnershipEvidence.response.error.code, "TASK_CONTROL_REQUIRED");
  assert.equal(report.settlementEvidence.runtimeResourcesConfirmedReleased, false);
  assert.equal(report.fullConformance, false);
  if (mode.reviewOnly) {
    const limited = await evaluateReport({
      passed: false,
      transport: "relay",
      checks: [{ case: "T32" }, { case: "T33" }, { case: "T34" }],
      requiredUnrun: [
        {
          code: "RELAY_BROWSER_TLS_UNRUN",
          layer: "production-pwa-tls",
          status: "UNRUN",
          required: true,
        },
      ],
    });
    assert.equal(limited.recentRpcOutcomes.length, 0);
    assert.equal(limited.passed, false);
    assert.equal(limited.acceptance, false);
    assert.equal(limited.fullConformance, false);
    assert.ok(limited.checks.every((check) => check.layer === "native-node-business"));
    assert.equal(limited.requiredUnrun[0].status, "UNRUN");
    for (const transport of ["direct", "relay"]) {
      for (const [selection, cases] of [
        [{}, ["T18", "T19", "T20", "T22"]],
        [{ stopOnly: true }, ["T23"]],
        [{ interactionOnly: true }, ["T25"]],
        [{ taskPauseOnly: true }, ["T30"]],
      ]) {
        const race = await evaluateReport({
          transport,
          reviewOnly: false,
          repetitions: 100,
          completedRaceIterations: 100,
          ...selection,
        });
        assert.deepEqual(
          JSON.parse(JSON.stringify(race.raceCounts)),
          Object.fromEntries(cases.map((id) => [id, { requested: 100, completed: 100 }])),
        );
        assert.equal(race.acceptanceRepetitionsMet, true);
        const incomplete = await evaluateReport({
          transport,
          reviewOnly: false,
          repetitions: 100,
          completedRaceIterations: 99,
          ...selection,
        });
        assert.equal(incomplete.acceptanceRepetitionsMet, false);
        assert.equal(incomplete.acceptance, false);
      }
    }
  }
}
const suiteFlags = [
  "RC10_REVIEW_ONLY",
  "RC09_TASK_PAUSE_ONLY",
  "RC08_TASK_QUESTIONS_ONLY",
  "RC06_STOP_ONLY",
  "RC07_INTERACTIONS_ONLY",
  "RC05_PREFLIGHT_ONLY",
  "RC06_SETTLEMENT_ONLY",
  "RC07_SETTLEMENT_ONLY",
];
for (let left = 0; left < suiteFlags.length; left++) {
  for (let right = left + 1; right < suiteFlags.length; right++) {
    assert.throws(
      () =>
        runInNewContext(modes, {
          process: { env: { [suiteFlags[left]]: "1", [suiteFlags[right]]: "1" } },
          assert,
        }),
      /Select one frozen native milestone/,
    );
  }
}
for (const env of [{}, { RC06_STOP_ONLY: "1" }, { RC07_INTERACTIONS_ONLY: "1" }]) {
  assert.equal(runInNewContext(`${modes}\nrepetitions;`, { process: { env }, assert }), 100);
}
console.log(
  "T21/T24/T26-T27-only modes report zero race iterations and preserve resource uncertainty",
);

const taskOwnedPreflight = runInNewContext(
  `${between("async function taskOwnedPreflight(", 'if (process.argv[2] === "--host-worker")')}\ntaskOwnedPreflight;`,
  {
    assert,
    randomUUID,
    async waitFor(fn, label) {
      for (let i = 0; i < 4; i++) {
        const value = await fn();
        if (value) return value;
      }
      throw new Error(`Timed out: ${label}`);
    },
  },
);
async function ownershipCase({
  code = "TASK_CONTROL_REQUIRED",
  futureOnly = false,
  ordinary = false,
  operation = "session.send",
  cleanupFailure,
} = {}) {
  const evidence = {},
    calls = [];
  let observations = 0,
    reads = 0,
    cancelled = false;
  const run = { id: "run", threadId: "fresh", status: "queued", workers: [] };
  const thread = {
    id: "fresh",
    turns: [{ id: "held", status: "inProgress" }],
    desktop: { configuration: { revision: 7 }, queue: { paused: false, items: [] } },
  };
  const promise = taskOwnedPreflight({
    evidence,
    operation,
    waitForModel: async () => calls.push("model-held"),
    rpc: async (method, params) => {
      calls.push(method);
      if (method === "session.create")
        return { result: { admissionState: "accepted", threadId: "fresh" } };
      assert.equal(params.threadId, "fresh");
      if (method === "turn.stop") assert.equal(params.expectedTurnId, "held");
      else assert.equal(params.expectedConfigRevision, 7);
      if (params.text === "RC05_HOLD")
        return { result: { admissionState: "accepted", turnId: "held" } };
      assert.ok(reads >= 3, "future-only and other-Thread Runs must not admit this check");
      return { error: { code, message: "complete refusal", data: { causal: "retained" } } };
    },
    native: async (method, params) => {
      calls.push(method);
      if (method === "areal/thread/observe")
        return {
          thread,
          ownership:
            ++observations === 1 || ordinary
              ? { kind: "ordinary" }
              : { kind: "task", taskId: "task", runId: "run" },
        };
      if (method === "areal/task/create") {
        assert.equal(params.threadId, "fresh");
        assert.equal(params.mode,"background");
        assert.equal(params.schedule,undefined);
        return { id: "task" };
      }
      if (method === "areal/task/read") {
        reads++;
        return {
          id: "task",
          revision: 3,
          runs: cancelled
            ? [
                {
                  ...run,
                  status: "cancelled",
                  workers: cleanupFailure === "settlement" ? [{ settled: false }] : [],
                },
              ]
            : futureOnly || reads === 1
              ? []
              : reads === 2
                ? [{ ...run, threadId: "other" }]
                : [run],
        };
      }
      if (method === "areal/task/cancel") {
        if (cleanupFailure === "cancel") throw new Error("fixture cancel failed");
        cancelled = true;
        return {};
      }
      if (method === "turn/interrupt") {
        assert.equal(cancelled, true);
        return {};
      }
      if (method === "thread/read") return { thread: { status: { type: "idle" } } };
      throw new Error(method);
    },
  });
  if (futureOnly || ordinary || code !== "TASK_CONTROL_REQUIRED" || cleanupFailure)
    await assert.rejects(
      promise,
      code !== "TASK_CONTROL_REQUIRED" ? /complete refusal/ : undefined,
    );
  else await promise;
  if (cleanupFailure) {
    assert.equal(calls.includes("turn/interrupt"), false);
    assert.equal(evidence.cleanup.at(-1).heldForOuterCleanup, true);
    assert.equal(evidence.cleanup.at(-1).resourcesUncertain, true);
  } else {
    assert.ok(calls.indexOf("areal/task/cancel") < calls.indexOf("turn/interrupt"));
    assert.equal(evidence.cleanup.at(-1).settled, true);
  }
  return { evidence, calls };
}
for (const cleanupFailure of ["cancel", "settlement"]) await ownershipCase({ cleanupFailure });
const originalFailure = await ownershipCase({ code: "TARGET_CHANGED", cleanupFailure: "cancel" });
assert.match(originalFailure.evidence.failure.message, /complete refusal/);
const ownership = await ownershipCase();
assert.equal(ownership.evidence.response.error.code, "TASK_CONTROL_REQUIRED");
const stopOwnership = await ownershipCase({ operation: "turn.stop" });
assert.equal(stopOwnership.evidence.request.expectedTurnId, "held");
const refused = await ownershipCase({ code: "TARGET_CHANGED" });
assert.equal(refused.evidence.response.error.data.causal, "retained");
assert.equal(refused.evidence.observationBeforeSend.ownership.runId, "run");
assert.equal(refused.evidence.taskBeforeSend.runs[0].threadId, "fresh");
for (const scenario of [{ futureOnly: true }, { ordinary: true }]) {
  const invalid = await ownershipCase(scenario);
  assert.equal(invalid.evidence.response, undefined);
  assert.ok(invalid.evidence.failure);
}
console.log(
  "Task-owned preflight requires matching queued Run and atomic ownership; failed response facts survive cleanup",
);

const assertUnknownSettlement = runInNewContext(
  `${between("function assertUnknownSettlement(", 'if (process.argv[2] === "--host-worker")')}\nassertUnknownSettlement;`,
  { assert },
);
const originalToolTurn = {
  id: "original-turn",
  status: "inProgress",
  items: [
    {
      type: "dynamicToolCall",
      tool: "run_command",
      id: "original-item",
      status: "inProgress",
      success: null,
      execution: {
        runtimeEpoch: "epoch",
        scopeId: "scope",
        operationId: "operation",
        outcome: "running",
      },
    },
  ],
};
const unknownToolTurn = structuredClone(originalToolTurn);
unknownToolTurn.status = "failed";
unknownToolTurn.items[0].status = "failed";
unknownToolTurn.items[0].success = false;
unknownToolTurn.error = {
  message: "turn stopped with an UNKNOWN tool outcome; inspect the workspace before continuing",
};
unknownToolTurn.items[0].execution.outcome = "unknown";
unknownToolTurn.items[0].contentItems = [
  {
    type: "inputText",
    text: JSON.stringify({
      error: {
        code: "UNAVAILABLE",
        message: "interrupted tool invocation; outcome is UNKNOWN",
      },
    }),
  },
];
assertUnknownSettlement(originalToolTurn, unknownToolTurn);
for (const mutate of [
  (turn) => {
    turn.status = "interrupted";
  },
  (turn) => {
    turn.items[0].execution.operationId = "replacement";
  },
  (turn) => {
    turn.items[0].execution.outcome = "cancelled";
  },
  (turn) => {
    turn.items[0].execution.inspection = "acknowledged";
  },
]) {
  const changed = structuredClone(unknownToolTurn);
  mutate(changed);
  assert.throws(() => assertUnknownSettlement(originalToolTurn, changed));
}
// 真实 Direct/Relay manifest 的最小见证；仅重放断言，不模拟 Core 或宣称资源清理顺序。
const settlementWitnesses = {
  direct: {
    manifestSha256: "a268e1363729c386f23803c6ef62ae52081f57a945324d137cf77f2db75cff85",
    target: {
      threadId: "f38c9abb-d5ec-4615-90fc-b9829d74bbca",
      expectedTurnId: "64e3d0e3-9f23-4198-9f27-0e0c30bc12f5",
    },
    stopResponse: {
      id: "596",
      result: {
        commandId: "0e1248c9-63e3-4bff-98c0-dc841ee37f75",
        method: "turn.stop",
        target: {
          threadId: "f38c9abb-d5ec-4615-90fc-b9829d74bbca",
          expectedTurnId: "64e3d0e3-9f23-4198-9f27-0e0c30bc12f5",
        },
        operationId: "c1d86534-cf79-4743-a082-82dd5be8c84b",
        admissionState: "accepted",
        submissionUnknown: false,
        threadId: "f38c9abb-d5ec-4615-90fc-b9829d74bbca",
        turnId: "64e3d0e3-9f23-4198-9f27-0e0c30bc12f5",
      },
    },
    original: {
      id: "64e3d0e3-9f23-4198-9f27-0e0c30bc12f5",
      status: "inProgress",
      error: null,
      items: [
        {
          id: "3cf7bf93-144c-455a-8672-5841b19cb594",
          type: "dynamicToolCall",
          tool: "run_command",
          status: "inProgress",
          success: null,
          execution: {
            runtimeEpoch: "295877ab-25be-40ac-a1f4-568c40ecfa38",
            scopeId:
              "295877ab-25be-40ac-a1f4-568c40ecfa38:scope:807b17b8-36a9-475d-98a4-4a66ee0d4fcc",
            operationId:
              "295877ab-25be-40ac-a1f4-568c40ecfa38:op:079a8cb8-0516-431b-9aca-34c894bf61fd",
            outcome: "running",
          },
          contentItems: [],
        },
      ],
    },
    afterAdmission: {
      id: "64e3d0e3-9f23-4198-9f27-0e0c30bc12f5",
      status: "inProgress",
      error: null,
      items: [
        {
          id: "3cf7bf93-144c-455a-8672-5841b19cb594",
          type: "dynamicToolCall",
          tool: "run_command",
          status: "failed",
          success: false,
          execution: {
            runtimeEpoch: "295877ab-25be-40ac-a1f4-568c40ecfa38",
            scopeId:
              "295877ab-25be-40ac-a1f4-568c40ecfa38:scope:807b17b8-36a9-475d-98a4-4a66ee0d4fcc",
            operationId:
              "295877ab-25be-40ac-a1f4-568c40ecfa38:op:079a8cb8-0516-431b-9aca-34c894bf61fd",
            outcome: "unknown",
          },
          contentItems: [
            {
              type: "inputText",
              text: '{"error":{"code":"UNAVAILABLE","message":"interrupted tool invocation; outcome is UNKNOWN"},"remainingToolCalls":null}',
            },
          ],
        },
      ],
    },
  },
  relay: {
    manifestSha256: "55d57f0580e17fce3d36a625fc6deff465db2c504ad4e05100b5fd4a359ce2b1",
    target: {
      threadId: "3d0f047e-18c1-4032-8a24-9875e8ddb966",
      expectedTurnId: "ffc3072a-0960-4c7b-92d2-1e829e990705",
    },
    stopResponse: {
      id: "596",
      result: {
        commandId: "d52c8e18-f704-4a43-81d0-2b7720f6eeed",
        method: "turn.stop",
        target: {
          threadId: "3d0f047e-18c1-4032-8a24-9875e8ddb966",
          expectedTurnId: "ffc3072a-0960-4c7b-92d2-1e829e990705",
        },
        operationId: "74267ead-1a9a-4f2b-a684-862399073d85",
        admissionState: "accepted",
        submissionUnknown: false,
        threadId: "3d0f047e-18c1-4032-8a24-9875e8ddb966",
        turnId: "ffc3072a-0960-4c7b-92d2-1e829e990705",
      },
    },
    original: {
      id: "ffc3072a-0960-4c7b-92d2-1e829e990705",
      status: "inProgress",
      error: null,
      items: [
        {
          id: "47e4e8ee-f03d-4cd0-add7-88ec169fb4c1",
          type: "dynamicToolCall",
          tool: "run_command",
          status: "inProgress",
          success: null,
          execution: {
            runtimeEpoch: "8f3a9390-53a0-4164-9ac3-83572266ef94",
            scopeId:
              "8f3a9390-53a0-4164-9ac3-83572266ef94:scope:7ef682f0-3121-44f2-9325-c86c8d9aa8e7",
            operationId:
              "8f3a9390-53a0-4164-9ac3-83572266ef94:op:a867f8c3-87cb-4914-bff2-df1602b968f0",
            outcome: "running",
          },
          contentItems: [],
        },
      ],
    },
    afterAdmission: {
      id: "ffc3072a-0960-4c7b-92d2-1e829e990705",
      status: "failed",
      error: {
        message:
          "turn stopped with an UNKNOWN tool outcome; inspect the workspace before continuing",
        outcome: {
          class: "infrastructure",
          code: "HARNESS_INTERNAL_ERROR",
          details: {
            reason: "unclassified",
          },
          source: "core",
        },
      },
      items: [
        {
          id: "47e4e8ee-f03d-4cd0-add7-88ec169fb4c1",
          type: "dynamicToolCall",
          tool: "run_command",
          status: "failed",
          success: false,
          execution: {
            runtimeEpoch: "8f3a9390-53a0-4164-9ac3-83572266ef94",
            scopeId:
              "8f3a9390-53a0-4164-9ac3-83572266ef94:scope:7ef682f0-3121-44f2-9325-c86c8d9aa8e7",
            operationId:
              "8f3a9390-53a0-4164-9ac3-83572266ef94:op:a867f8c3-87cb-4914-bff2-df1602b968f0",
            outcome: "unknown",
          },
          contentItems: [
            {
              type: "inputText",
              text: '{"error":{"code":"UNAVAILABLE","message":"interrupted tool invocation; outcome is UNKNOWN"},"remainingToolCalls":null}',
            },
          ],
        },
      ],
    },
  },
};
const admissionPath = between(
  "      settlementEvidence.original = await readTurn(threadId, turnId);",
  "      await settled(threadId);",
);
async function assertAdmissionWitness(witness) {
  return runInNewContext(
    `(async () => {
      const witness = JSON.parse(serializedWitness);
      const { threadId, expectedTurnId: turnId } = witness.target;
      const settlementEvidence = {};
      let reads = 0;
      const readTurn = async () => reads++ ? witness.afterAdmission : witness.original;
      const a = { rpc: async () => witness.stopResponse };
      ${admissionPath}
      return settlementEvidence;
    })()`,
    { assert, assertUnknownSettlement, serializedWitness: JSON.stringify(witness) },
  );
}
for (const [transport, witness] of Object.entries(settlementWitnesses)) {
  await assertAdmissionWitness(witness);
  console.log(
    `T24 actual assertion path accepts reduced real ${transport} witness (${witness.manifestSha256})`,
  );
}
for (const [name, mutate] of Object.entries({
  wrongTurn: (w) => {
    w.afterAdmission.id = "replacement";
  },
  wrongItem: (w) => {
    w.afterAdmission.items[0].id = "replacement";
  },
  wrongEpoch: (w) => {
    w.afterAdmission.items[0].execution.runtimeEpoch = "replacement";
  },
  wrongScope: (w) => {
    w.afterAdmission.items[0].execution.scopeId = "replacement";
  },
  wrongOperation: (w) => {
    w.afterAdmission.items[0].execution.operationId = "replacement";
  },
  wrongToolStatus: (w) => {
    w.afterAdmission.items[0].status = "completed";
  },
  wrongSuccess: (w) => {
    w.afterAdmission.items[0].success = true;
  },
  succeededTerminal: (w) => {
    w.afterAdmission.status = "completed";
  },
  wrongOutcome: (w) => {
    w.afterAdmission.items[0].execution.outcome = "succeeded";
  },
  inspection: (w) => {
    w.afterAdmission.items[0].execution.inspection = "acknowledged";
  },
  wrongTurnError: (w) => {
    w.afterAdmission.error.message = "other failure";
  },
  wrongToolError: (w) => {
    w.afterAdmission.items[0].contentItems[0].text =
      '{"error":{"code":"OTHER","message":"other failure"}}';
  },
  inactiveOriginal: (w) => {
    w.original.status = "failed";
  },
  inactiveOriginalTool: (w) => {
    w.original.items[0].status = "failed";
  },
  missingOriginalEpoch: (w) => {
    delete w.original.items[0].execution.runtimeEpoch;
  },
  wrongReceiptTarget: (w) => {
    w.stopResponse.result.target.expectedTurnId = "replacement";
  },
})) {
  const changed = structuredClone(settlementWitnesses.relay);
  mutate(changed);
  await assert.rejects(() => assertAdmissionWitness(changed), { code: "ERR_ASSERTION" }, name);
}
console.log(
  "T24 actual assertion path rejects identity, status, success, outcome, inspection, error and admission counterexamples; no Native execution or cleanup-order proof",
);
const cleanupCall = await model([user(`RC06_CLEANUP:${b}`)]);
assert.match(JSON.parse(cleanupCall.tool.function.arguments).command, /printf ready >> /);
console.log(
  "T24 binds failed+UNKNOWN to the original native tool execution and uses an append-only replay marker",
);

const repeatPendingApproval = runInNewContext(
  `${between("async function repeatPendingApproval(", 'if (process.argv[2] === "--host-worker")')}\nrepeatPendingApproval;`,
  { assert },
);
const originalArguments = JSON.parse(largest.tool.function.arguments);
const restrictions = { networkAccess: true };
const originalPermission = {
  threadId: "maximum-thread",
  turnId: "original-turn",
  effect: b,
  item: {
    requestId: "original-request",
    effectiveArguments: originalArguments,
    effectivePermissions: { grant: { arguments: originalArguments }, restrictions },
    argumentsDigest: "0".repeat(64),
  },
};
let pending,
  denied = 0;
const repeatStart = runInNewContext(
  `${between("      const startInteraction =", "      const review =")}\nstartInteraction;`,
  {
    randomUUID,
    control: async () => true,
    native: async (_method, params) => {
      const call = await model([user(params.input[0].text)]);
      const args = JSON.parse(call.tool.function.arguments);
      pending = {
        threadId: params.threadId,
        turnId: "fresh-turn",
        requestId: "fresh-request",
        status: "pending",
        effectiveArguments: args,
        effectivePermissions: { grant: { arguments: args }, restrictions },
        argumentsDigest: createHash("sha256")
          .update(JSON.stringify({ turnId: "fresh-turn", callId: "fresh-call", arguments: args }))
          .digest("hex"),
      };
      return { turn: { id: pending.turnId } };
    },
    readInteraction: async () => pending,
  },
);
const repeatedBinding = await repeatPendingApproval(
  originalPermission,
  repeatStart,
  async (value) => {
    assert.equal(value.item.argumentsDigest, pending.argumentsDigest);
    assert.notEqual(value.item.argumentsDigest, originalPermission.item.argumentsDigest);
    denied++;
  },
);
assert.equal(denied, 1);
assert.equal(repeatedBinding.interactionId, "fresh-request");
const rejectRememberedDecision = runInNewContext(
  `${between("async function rejectRememberedDecision(", 'if (process.argv[2] === "--host-worker")')}\nrejectRememberedDecision;`,
  { assert },
);
for (const decision of ["allowSession", "allowProject"]) {
  for (const leakScope of [null, "session", "project"]) {
    const evidence = {};
    let reads = 0;
    const result = rejectRememberedDecision({
      threadId: originalPermission.threadId,
      decision,
      params: { reviewToken: "current-review" },
      evidence,
      native: async (method, params) => {
        assert.equal(method, "areal/permissions/read");
        assert.equal(params.threadId, originalPermission.threadId);
        const value = { session: [], project: [] };
        if (++reads === 2 && leakScope)
          value[leakScope].push({
            key: "exact-grant",
            tool: "run_command",
            arguments: originalArguments,
          });
        return value;
      },
      rpc: async (_method, params) => {
        assert.equal(params.decision, decision);
        // Core forced approval 在泄漏授权后仍可 pending；不能把提示存在当作授权未泄漏。
        assert.equal(pending.status, "pending");
        return { error: { code: "INVALID_PARAMS" } };
      },
    });
    if (leakScope) {
      await assert.rejects(result, /forbidden decision changed authoritative grants/);
      assert.equal(evidence.after[leakScope][0].key, "exact-grant");
    } else await result;
    assert.equal(reads, 2);
    assert.equal(pending.status, "pending");
  }
}
console.log(
  "Fresh Turn uses its own digest; authoritative grant snapshots detect leaks despite forced pending approval",
);

const taskObjective = user(`RC08_TASK:${a}`);
const taskContext = (messages = []) => ({
  role: "system",
  content: `Current task channel: ${JSON.stringify({ taskId: "task", runId: "run", messages })}`,
});
const taskGoal = {
  role: "system",
  content: `Current authoritative goal: ${JSON.stringify({ revision: 7, goal: { objective: `RC08_TASK:${a}` } })}`,
};
const pendingQuestion = { id: "question", kind: "question", status: "pending" };
const taskAsk = await model([taskGoal, taskContext(), taskObjective]);
assert.equal(taskAsk.tool.function.name, "ask_user_question");
assert.equal(JSON.parse(taskAsk.tool.function.arguments).mode, "async");
assert.equal(JSON.parse(taskAsk.tool.function.arguments).required, true);
const independent = await model([taskGoal, taskContext([pendingQuestion]), taskObjective]);
assert.equal(independent.tool.function.name, "run_command");
assert.match(
  JSON.parse(independent.tool.function.arguments).command,
  /pending.*while.*release.*work/,
);
const waitTask = await model([taskGoal, taskContext([pendingQuestion]), taskObjective]);
assert.equal(waitTask.tool.function.name, "task_wait");
const originalAnswer = {
  id: "reply",
  kind: "reply",
  inReplyTo: "question",
  answers: { choice: "B", free: "exact" },
};
const afterAnswer = await model([
  taskGoal,
  taskContext([pendingQuestion, originalAnswer]),
  taskObjective,
]);
assert.equal(afterAnswer.tool.function.name, "run_command");
assert.match(JSON.parse(afterAnswer.tool.function.arguments).command, /printf 'B'.*reply/);
const doneTask = await model([
  taskGoal,
  taskContext([pendingQuestion, originalAnswer]),
  taskObjective,
]);
assert.equal(doneTask.tool.function.name, "goal_update");
assert.equal(JSON.parse(doneTask.tool.function.arguments).expectedRevision, 7);
assert.equal(
  (await model([taskGoal, taskContext([pendingQuestion, originalAnswer]), taskObjective])).tool,
  undefined,
);
console.log(
  "RC08 native model fixture asks asynchronously, performs independent Runtime work, waits, consumes exact Channel answer, and reports original Goal",
);

const replacedModel = await model([
  taskObjective,
  {
    role: "system",
    content:
      'Current authoritative goal: {"revision":9,"goal":{"objective":"RC05_HOLD replacement Goal"}}',
  },
  user("RC05_HOLD replacement Goal"),
]);
assert.equal(
  replacedModel.held,
  true,
  "replaced native Goal must not replay or complete the historical Task fixture",
);

const rc09Goal = (kind, run) => [
  {
    role: "system",
    content: `Current authoritative goal: ${JSON.stringify({ revision: 7, goal: { objective: `RC09_${kind}:${b}` } })}`,
  },
  {
    role: "system",
    content: `Current task channel: ${JSON.stringify({ runId: run, messages: [] })}`,
  },
  user("execute"),
];
assert.equal((await model(rc09Goal("RACE", "one"))).tool.function.name, "goal_update");
assert.equal((await model(rc09Goal("RACE", "one"))).tool, undefined);
assert.equal((await model(rc09Goal("RACE", "two"))).tool.function.name, "goal_update");
assert.equal((await model(rc09Goal("WORK", "work"))).tool.function.name, "task_spawn");
assert.equal((await model(rc09Goal("WORK", "work"))).tool.function.name, "task_wait");
const heldWorker = await model([user(`You are a TaskRun worker. RC09_WORKER:${b}`)]);
assert.equal(heldWorker.tool.function.name, "run_command");
assert.match(
  JSON.parse(heldWorker.tool.function.arguments).command,
  /trap.*sleep 2.*printf ready.*while/,
);
const rc09Mode = runInNewContext(`${modes}\n({taskPauseOnly,repetitions});`, {
  process: { env: { RC09_TASK_PAUSE_ONLY: "1" } },
  assert,
});
assert.equal(rc09Mode.taskPauseOnly, true);
assert.equal(rc09Mode.repetitions, 100);
console.log(
  "RC09 selector requires 100 races; model completes each distinct Run and holds a real worker tool after coordinator wait",
);

// 执行真实 harness 的 Task 创建片段；Core 契约要求 scheduled 绑定已创建的 root Thread。
const pauseSuite = source.slice(source.indexOf("    if (taskPauseOnly) {"));
const raceOpening = pauseSuite.indexOf("      for (let index = 0; index < repetitions; index++) {");
const raceCreate = pauseSuite.slice(
  pauseSuite.indexOf("\n", raceOpening) + 1,
  pauseSuite.indexOf("        try {", raceOpening),
);
const workerOpening = pauseSuite.indexOf("      const effect = randomUUID();");
const workerCreate = pauseSuite.slice(
  workerOpening,
  pauseSuite.indexOf("      const original = await waitFor", workerOpening),
);
const createdThreads = new Set();
const scheduledThreads = new Set();
async function checkScheduledThreadBinding(fragment, kind) {
  let originalThread,
    nativeCalls = 0;
  const result = await runInNewContext(`(async () => {${fragment}\nreturn created;})()`, {
    assert,
    randomUUID,
    Date,
    Math,
    scheduledThreads,
    a: {
      rpc: async (method) => {
        assert.equal(method, "session.create");
        originalThread = randomUUID();
        assert.equal(createdThreads.has(originalThread), false);
        createdThreads.add(originalThread);
        return { result: { admissionState: "accepted", threadId: originalThread } };
      },
    },
    native: async (method, params) => {
      assert.equal(method, "areal/task/create");
      assert.equal(params.mode, kind === "RACE" ? "scheduled" : "background");
      if (!params.threadId)
        throw Object.assign(new Error("foreground and scheduled tasks require threadId"), {
          code: -32602,
        });
      assert.equal(
        params.threadId,
        originalThread,
        "Task must bind this fixture's newly created Thread",
      );
      assert.equal(params.interactionMode, "headless");
      assert.match(params.objective, new RegExp(`^RC09_${kind}:`));
      if (kind === "RACE")assert.equal(params.schedule.intervalSeconds,3);
      else assert.equal(params.schedule,undefined);
      assert.equal(params.maxTurns, kind === "RACE" ? 4 : 8);
      nativeCalls++;
      return { id: randomUUID(), threadId: params.threadId, runs: [] };
    },
  });
  assert.equal(nativeCalls, 1);
  assert.equal(result.threadId, originalThread);
}
for (let index = 0; index < 100; index++) await checkScheduledThreadBinding(raceCreate, "RACE");
await checkScheduledThreadBinding(workerCreate, "WORK");
assert.equal(createdThreads.size, 101);
assert.equal(scheduledThreads.size, 101);
for (const [fragment, kind] of [
  [raceCreate, "RACE"],
  [workerCreate, "WORK"],
]) {
  const missing = fragment.replace("threadId: thread.threadId", "threadId: undefined");
  assert.notEqual(missing, fragment);
  await assert.rejects(checkScheduledThreadBinding(missing, kind), { code: -32602 });
  const alias = fragment.replace("threadId: thread.threadId", 'threadId: "foreign-thread"');
  await assert.rejects(checkScheduledThreadBinding(alias, kind), /must bind this fixture/);
}
console.log(
  "RC09 scheduled races and background worker bind 101 distinct session.create-result Thread IDs; source oracle only, zero native races executed",
);

// RC10 模型回调只根据当前 Turn 选择原生文件写入、失败和媒体事件。
const reviewPrompt = user(`RC10_REVIEW:${a}`);
const writeZ = await model([reviewPrompt]);
assert.equal(writeZ.tool.function.name, "fs_create");
assert.equal(
  JSON.parse(writeZ.tool.function.arguments).path,
  `workspace://repo/effects/rc10-z-${a}.txt`,
);
const writeA = await model([reviewPrompt, { role: "tool", content: "created" }]);
assert.equal(JSON.parse(writeA.tool.function.arguments).text, "A original\n");
const longResult = await model([
  reviewPrompt,
  { role: "tool", content: "created z" },
  { role: "tool", content: "created a" },
]);
assert.equal(longResult.tool, undefined);
assert.ok(Buffer.byteLength(longResult.events[0].choices[0].delta.content) > 16 * 1024);
const failedPrompt = user(`RC10_FAILED:${a}`);
assert.equal((await model([failedPrompt])).tool.function.name, "fs_read");
assert.equal((await model([failedPrompt, { role: "tool", content: "read" }])).status, 400);
for (const kind of ["PNG", "HTML", "HUGE"]) {
  const response = await model([], {
    url: "/v1/responses",
    body: {
      input: [
        { role: "user", content: "RC10_MEDIA:PNG" },
        { role: "user", content: `RC10_MEDIA:${kind}` },
      ],
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.events.at(-1).type, "response.completed");
  const image = Buffer.from(response.events[1].item.result, "base64");
  if (kind === "PNG") {
    assert.equal(image.readUInt32BE(16), 1);
    assert.equal(
      response.events.filter((event) => event.type === "response.output_item.done").length,
      2,
    );
  }
  if (kind === "HUGE") assert.equal(image.readUInt32BE(16), 20000);
  if (kind === "HTML") assert.match(image.toString(), /<html>/);
}
console.log(
  "RC10 selector is isolated; native model fixture emits original path writes, failed partial Turn, Responses PNG and hostile raster records",
);

// 执行同一公开 DOM 布局回调与断言；这里只验证 oracle 敏感度，不声称浏览器几何验收。
const layoutBody = {
  error: { message: "failed" },
  result: [{ text: "长行".repeat(6000) }, { text: "line one\nline two" }],
  diff: {
    state: "available",
    files: [
      {
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: [
              { kind: "del", text: "old" },
              { kind: "add", text: "new" },
            ],
          },
        ],
      },
    ],
  },
};
const layoutTexts = [
  JSON.stringify(layoutBody.error, null, 2),
  layoutBody.result[0].text,
  layoutBody.result[1].text,
  "@@ -1,1 +1,1 @@\n-old\n+new",
];
const layoutNodes = layoutTexts.map((textContent) => ({
  textContent,
  clientWidth: 350,
  scrollWidth: 350,
  clientHeight: 320,
  scrollHeight: 800,
}));
let layoutPanel = { querySelectorAll: () => layoutNodes };
const layoutDocument = {
  documentElement: { clientWidth: 390, scrollWidth: 390 },
  querySelector: (selector) => {
    assert.equal(selector, "#session > .result-review");
    return layoutPanel;
  },
};
const layoutStyle = {
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  overflowX: "auto",
  overflowY: "auto",
  maxHeight: "320px",
};
const layoutOracle = runInNewContext(
  `${between("      const measureReviewLayout =", "      const screenshot =")}\n({measureReviewLayout, assertReviewLayout});`,
  {
    document: layoutDocument,
    innerWidth: 390,
    getComputedStyle: () => layoutStyle,
    TextEncoder,
    crypto: webcrypto,
    Uint8Array,
    assert,
    Buffer,
    createHash,
  },
);
const validLayout = await layoutOracle.measureReviewLayout();
layoutOracle.assertReviewLayout(validLayout, layoutBody);
assert.equal(validLayout.pres[1].chars, 12000);
assert.equal(validLayout.pres[1].bytes, 36000);
assert.ok(
  !JSON.stringify(validLayout).includes("line one"),
  "layout facts must not retain body text",
);
for (const mutation of [
  (fact) => {
    fact.panel = false;
  },
  (fact) => {
    fact.scrollWidth = 384817;
  },
  (fact) => {
    fact.pres[1].whiteSpace = "pre";
  },
  (fact) => {
    fact.pres[1].overflowWrap = "normal";
  },
  (fact) => {
    fact.pres[1].overflowY = "visible";
  },
  (fact) => {
    fact.pres[1].maxHeight = "none";
  },
  (fact) => {
    fact.pres[1].clientHeight = 800;
  },
  (fact) => {
    fact.pres[1].scrollWidth = 384557;
  },
  (fact) => {
    fact.pres[1].sha256 = "changed";
  },
  (fact) => {
    fact.pres[1].chars--;
  },
  (fact) => {
    fact.pres.pop();
  },
]) {
  const invalid = structuredClone(validLayout);
  mutation(invalid);
  assert.throws(() => layoutOracle.assertReviewLayout(invalid, layoutBody));
}
layoutPanel = null;
const missingLayout = await layoutOracle.measureReviewLayout();
assert.throws(() => layoutOracle.assertReviewLayout(missingLayout, layoutBody));
console.log(
  "RC10 public DOM layout oracle rejects missing bounds/wrapping and changed original text; source-only sensitivity, no browser launched",
);

let screenshotCalls = 0,
  screenshotLayout = validLayout;
const captureOracle = runInNewContext(
  `${between("      const screenshot =", "      await openReview(threadId, turnId);")}\n({screenshot, safe: () => browserLayoutSafe});`,
  {
    browserLayoutSafe: false,
    measureReviewLayout: layoutOracle.measureReviewLayout,
    assertReviewLayout: layoutOracle.assertReviewLayout,
    browserEvidence: { screenshots: [] },
    browserPage: {
      evaluate: async () => screenshotLayout,
      screenshot: async (options) => {
        assert.equal(options.fullPage, true, "successful capture retains full-page acceptance");
        screenshotCalls++;
      },
    },
    scratch: "/source-only",
    join,
  },
);
await captureOracle.screenshot("valid.png", layoutBody);
assert.equal(screenshotCalls, 1);
assert.equal(captureOracle.safe(), true);
screenshotLayout = { ...validLayout, scrollWidth: 384817 };
await assert.rejects(captureOracle.screenshot("unsafe.png", layoutBody), /expands document width/);
assert.equal(screenshotCalls, 1, "unsafe layout must fail before the full-page capture");
assert.equal(captureOracle.safe(), false);
console.log(
  "RC10 unchanged full-page capture runs only after layout/text verification; unsafe geometry blocks screenshot allocation",
);

// 传输选择在任何进程或监听器创建之前失败；此处只调用纯入口。
const { selectRemoteTransport } = await import("./remote-conformance-transport.mjs");
assert.equal(selectRemoteTransport(undefined), "direct");
assert.equal(selectRemoteTransport("direct"), "direct");
assert.equal(selectRemoteTransport("relay"), "relay");
for (const invalid of ["", "Relay", "https://relay.invalid", "direct,relay"])
  assert.throws(() => selectRemoteTransport(invalid), /AREAL_REMOTE_TRANSPORT/);
console.log("RC16 transport selector rejects unsupported values before fixture startup");

const { browserTransportLimitation } = await import("./remote-conformance-transport.mjs");
assert.equal(browserTransportLimitation("direct"), null);
assert.deepEqual(browserTransportLimitation("relay"), {
  code: "RELAY_BROWSER_TLS_UNRUN",
  layer: "production-pwa-tls",
  status: "UNRUN",
  required: true,
  reason:
    "No supported isolated production browser CA fixture; Node TLS is not browser or phone acceptance",
});
const browserBoundary = between(
  "      const limitation = browserTransportLimitation(transport);",
  "      // 真实浏览器只经邀请",
);
const requiredUnrun = [],
  reviewEvidence = {};
assert.throws(
  () =>
    runInNewContext(browserBoundary, {
      transport: "relay",
      browserTransportLimitation,
      requiredUnrun,
      reviewEvidence,
    }),
  { code: "RELAY_BROWSER_TLS_UNRUN" },
);
assert.equal(requiredUnrun.length, 1);
assert.equal(reviewEvidence.browser.status, "UNRUN");
assert.ok(
  source.indexOf('case: "T34"') < source.indexOf(browserBoundary),
  "native artifact rejection precedes unavailable browser phase",
);
for (const name of ["session-observation", "observation", "pairing", "work-overview", "gui-quit"]) {
  const entry = await readFile(new URL(`./remote-${name}-e2e.mjs`, import.meta.url), "utf8");
  assert.ok(
    entry.startsWith("import { selectRemoteTransport, requireBrowserTransport }"),
    "transport preflight is the first evaluated harness statement",
  );
}
console.log(
  "RC16 Relay browser limitation is typed UNRUN after native RC10 assertions; browser-only suites preflight before spawning",
);

// 执行实际连接片段，ready 未解决之前不得启动 Noise，也不得用另一个传输配对。
const connectionOpening = between("    const invite = pair ?", "    connections.add(secure);");
for (const transport of ["direct", "relay"]) {
  let releaseReady,
    noiseStarted = false;
  const ready = new Promise((resolve) => {
    releaseReady = resolve;
  });
  const pending = runInNewContext(`(async () => {${connectionOpening}})()`, {
    pair: true,
    transport,
    identity: {},
    hostIdentity: {},
    host: {
      ws: "wss://fixture.invalid/remote/socket",
      origin: "https://fixture.invalid",
      room: transport === "relay" ? "a".repeat(64) : null,
    },
    transportFixture: { socketOptions: {} },
    control: async (method, request) => {
      assert.equal(method, "control");
      assert.equal(request.transport, transport);
      return {};
    },
    WebSocket: class {},
    createRemoteWire: () => ({ wire: {}, ready }),
    identityId: () => "original-pin",
    secureChannel: async (_wire, _identity, pin) => {
      assert.equal(pin, "original-pin");
      noiseStarted = true;
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(noiseStarted, false);
  releaseReady();
  await pending;
  assert.equal(noiseStarted, true);
}
console.log(
  "RC16 both transports await production wire readiness before unchanged pinned Noise; per-case races distinguish 99 from 100",
);

// 在真实启动与清理片段中注入故障，持久服务必须在远程就绪前交给父进程。
const startupSource = between("  async function startHost() {", "  async function connectDevice(");
const bootstrapSource = between(
  "  const options = JSON.parse(process.env.RC05_HOST_OPTIONS);",
  "  let fault = null,",
);
const cleanupSource = between("    const cleanup = [];", "    let remoteConfigSha256 = null;");
const { EventEmitter } = await import("node:events");
for (const fault of ["enrollment-reject", "ready-timeout", "early-worker-exit"]) {
  const instances = new Map();
  const descriptor = { serviceId: `actual-${fault}`, generation: 7, hostPid: 111, corePid: 222 };
  const worker = new EventEmitter();
  worker.stdout = new EventEmitter();
  worker.stderr = new EventEmitter();
  worker.pid = 333;
  const timers = new Set();
  let reachFault;
  const reachedFault = new Promise((resolve) => {
    reachFault = resolve;
  });
  const context = {
    worker: null,
    host: null,
    hostWorkers: [],
    instances,
    waiting: new Map(),
    filename: "fixture",
    process: { env: {} },
    options: {},
    transportFixture: { childEnv: {} },
    recordOwnedProcesses() {},
    setTimeout(callback) {
      timers.add(callback);
      return callback;
    },
    clearTimeout(callback) {
      timers.delete(callback);
    },
    fork() {
      return worker;
    },
  };
  const startHost = runInNewContext(`${startupSource}\nstartHost;`, context);
  const startup = startHost().then(
    () => null,
    (error) => error,
  );
  let ownedAtFault = false;
  const fail = () => {
    ownedAtFault = instances.get(descriptor.serviceId) === descriptor;
    reachFault();
    if (fault === "ready-timeout") return new Promise(() => {});
    throw new Error(fault);
  };
  const bootstrap = runInNewContext(`(async () => {${bootstrapSource}})()`, {
    process: {
      env: { RC05_HOST_OPTIONS: JSON.stringify({ workspace: "/fixture" }) },
      send(message, callback) {
        worker.emit("message", message);
        callback?.(null);
      },
    },
    CoreBackend: class {
      saved = [{ id: "actual-project" }];
      async init() {}
      async start() {
        return { service: descriptor };
      }
    },
    DesktopService: class {},
    RemoteControl: class {
      async init() {
        if (fault === "early-worker-exit") await fail();
      }
    },
    encryptionFixture: {},
    transport: "relay",
    initializeConformanceHost: fail,
  }).catch((error) => {
    worker.stderr.emit("data", error.message);
    worker.emit("exit", 1);
  });
  await reachedFault;
  assert.equal(ownedAtFault, true, `${fault}: started service has no parent cleanup owner`);
  if (fault === "ready-timeout") for (const callback of [...timers]) callback();
  else await bootstrap;
  const startupError = await startup;
  assert.ok(startupError);
  assert.match(
    startupError.message,
    fault === "ready-timeout" ? /Host startup timed out/ : new RegExp(fault),
  );
  assert.equal(context.host, null, "failure must not publish ready");
  const stops = [];
  const cleanup = await runInNewContext(`(async () => {${cleanupSource}\nreturn cleanup;})()`, {
    instances,
    binary: "actual-core",
    registry: "/fixture/registry",
    process: { env: {} },
    passed: false,
    phaseErrors: [],
    execFileSync(binary, args, options) {
      assert.equal(binary, "actual-core");
      assert.deepEqual(Array.from(args), [
        "service",
        "stop",
        "--instance",
        descriptor.serviceId,
        "--cancel",
        "--json",
      ]);
      assert.equal(options.env.AREAL_HARNESS_SERVICE_HOME, "/fixture/registry");
      stops.push(descriptor.serviceId);
      return JSON.stringify({ serviceId: descriptor.serviceId, stopped: true });
    },
  });
  assert.deepEqual(stops, [descriptor.serviceId]);
  assert.equal(cleanup[0].stopped, true);
}
console.log(
  "RC16 startup fault source oracle: enrollment reject, ready timeout, early worker exit retain exact service ownership and normal service-stop observation",
);

{
  // 执行原 RPC 接收路径，错误 envelope 必须原样返回；诊断只允许有界的白名单元数据。
  const outcomeRecorder = runInNewContext(
    `${between("const pause =", "async function waitFor(")}\ntypeof recordRpcOutcome === "function" ? recordRpcOutcome : undefined;`,
  );
  const recentRpcOutcomes = [],
    sentRequests = [];
  let response;
  const rpc = runInNewContext(
    `({${between("      async rpc(method", "    };\n  }\n  const native =")}}).rpc`,
    {
      assert,
      randomUUID,
      sequence: 0,
      lastRequestAt: 0,
      reviewOnly: false,
      taskPauseOnly: false,
      taskQuestionsOnly: false,
      interactionOnly: false,
      interactionSettlementOnly: false,
      host: { projectId: "fixture-project", generation: "fixture-service" },
      ready: { gatewayGeneration: "fixture-gateway", grantRevision: 1 },
      secure: {
        send(request) {
          sentRequests.push(request);
        },
      },
      messages: {
        async next() {
          response.id = sentRequests.at(-1).id;
          return { value: response };
        },
      },
      recentRpcOutcomes,
      recordRpcOutcome: outcomeRecorder,
    },
  );
  const diagnosticId = randomUUID();
  for (const code of ["LIMIT_EXCEEDED", "FORBIDDEN", "TARGET_CHANGED", "TASK_CONTROL_REQUIRED"]) {
    response = {
      error: {
        code,
        message: code === "LIMIT_EXCEEDED" ? "请求过于频繁" : "opaque-secret-url-and-body",
      },
      body: "response-secret",
    };
    const returned = await rpc("session.create", { text: "request-secret" }, diagnosticId);
    assert.equal(returned, response, "negative envelopes must reach original business assertions");
    assert.throws(() => returned.result.threadId, TypeError);
    assert.equal(recentRpcOutcomes.at(-1)?.errorCode, code);
    assert.equal(recentRpcOutcomes.at(-1).method, "session.create");
    assert.equal(recentRpcOutcomes.at(-1).id, sentRequests.at(-1).id);
    assert.equal(recentRpcOutcomes.at(-1).commandId, diagnosticId);
    assert.equal(recentRpcOutcomes.at(-1).responseKind, "error");
    assert.equal(
      recentRpcOutcomes.at(-1).errorMessage,
      code === "LIMIT_EXCEEDED" ? "请求过于频繁" : "message omitted",
    );
  }
  response = {
    result: {
      admissionState: "rejected",
      error: { code: "TARGET_CHANGED", message: "命令未受理，请刷新状态后检查草稿" },
      body: "result-secret",
    },
  };
  assert.equal(await rpc("command.read", { commandId: diagnosticId }), response);
  assert.equal(recentRpcOutcomes.at(-1).commandId, diagnosticId);
  assert.equal(recentRpcOutcomes.at(-1).admissionState, "rejected");
  assert.equal(recentRpcOutcomes.at(-1).errorCode, "TARGET_CHANGED");
  assert.equal(recentRpcOutcomes.at(-1).responseKind, "result");
  for (let index = 0; index < 20; index++) {
    response = { error: { code: "opaque-secret-code", message: "opaque-secret-message" } };
    await rpc("opaque-secret-method", {}, "opaque-secret-command");
  }
  assert.equal(recentRpcOutcomes.length, 16);
  assert.equal(sentRequests.length, 25, "diagnostics must not retry any negative response");
  assert.equal(recentRpcOutcomes[0].id, "10");
  assert.equal(recentRpcOutcomes.at(-1).errorCode, "UNRECOGNIZED_ERROR");
  assert.equal(recentRpcOutcomes.at(-1).method, "UNRECOGNIZED_METHOD");
  assert.equal(recentRpcOutcomes.at(-1).commandId, null);
  assert.ok(!JSON.stringify(recentRpcOutcomes).includes("secret"));
  assert.ok(JSON.stringify(recentRpcOutcomes).length < 4096);
  console.log(
    "RC16 RPC outcomes: bounded safe metadata preserves typed negative responses and original failure without retry or payload logging",
  );
}

// 执行原 T23 全循环；虚拟时钟只消除偶然的 Native 延迟，不替代原目标断言。
const stopBranch = source.indexOf("    if (stopOnly || settlementOnly) {");
const stopLoopStart = source.indexOf(
  "        for (let index = 0; index < repetitions; index++) {",
  stopBranch,
);
const stopLoop = source.slice(
  stopLoopStart,
  source.indexOf("        checks.push({", stopLoopStart),
);
for (const unknownDevice of ["a", "b"]) {
  const writeLimits = require("../app/src/core/remote-session-acceptor.cjs").LIMITS;
  let now = 0,
    serial = 0,
    heldStop,
    delayedResolve,
    stopReady = false,
    fault,
    dispatches = 0;
  const turns = new Map(),
    receipts = new Map(),
    trace = [],
    gaps = [],
    held = new Set();
  let pairedStops = [];
  const counters = {
    a: { start: 0, count: 0, at: 0, tokens: writeLimits.writeBurst },
    b: { start: 0, count: 0, at: 0, tokens: writeLimits.writeBurst },
  };
  const context = {
    assert,
    randomUUID,
    repetitions: 100,
    completedRaceIterations: 0,
    held,
    async pause(ms) {
      gaps.push(ms);
      now += ms;
    },
    async startTurn(thread) {
      const id = `turn-${++serial}`;
      turns.set(thread, { id, status: "inProgress" });
      held.add(id);
      return id;
    },
    async waitFor(check) {
      assert.ok(await check());
    },
    releaseModel() {
      held.clear();
    },
    async settled(thread) {
      turns.get(thread).status = "completed";
    },
    async readTurn(thread, id) {
      const turn = turns.get(thread);
      assert.equal(turn.id, id);
      return turn;
    },
    async control(operation, value) {
      if (operation === "fault") {
        fault = value;
        if (value === "lost-native-response") pairedStops = [];
        return;
      }
      if (operation === "stop-held") return stopReady;
      if (operation === "release-stop") {
        stopReady = false;
        receipts.set(heldStop, {
          result: { admissionState: "rejected", error: { code: "TARGET_CHANGED" } },
        });
        delayedResolve(receipts.get(heldStop));
        return;
      }
      if (operation === "dispatches") return dispatches;
      throw new Error(operation);
    },
  };
  function device(name) {
    return {
      async rpc(method, params = {}, id = randomUUID()) {
        const counter = counters[name];
        counter.tokens = Math.min(
          writeLimits.writeBurst,
          counter.tokens + ((now - counter.at) * writeLimits.writeRequestsPerSecond) / 1000,
        );
        counter.at = now;
        if (method !== "command.read") {
          assert.ok(counter.tokens >= 1, "T23 must also honor the production write budget");
          counter.tokens--;
        }
        if (now - counter.start >= 1000) {
          counter.start = now;
          counter.count = 0;
        }
        trace.push({ device: name, method, at: now, index: context.completedRaceIterations });
        if (++counter.count > 20) return { error: { code: "LIMIT_EXCEEDED" } };
        if (method === "session.create") {
          dispatches++;
          return { result: { threadId: `thread-${++serial}` } };
        }
        if (method === "command.read") return receipts.get(params.commandId);
        assert.equal(method, "turn.stop");
        if (fault === "hold-stop-before-native") {
          fault = null;
          heldStop = id;
          stopReady = true;
          return new Promise((resolve) => {
            delayedResolve = resolve;
          });
        }
        if (turns.get(params.threadId).status === "completed")
          return { error: { code: "TARGET_CHANGED" } };
        dispatches++;
        const result = {
          result: { admissionState: name === unknownDevice ? "unknown" : "accepted" },
        };
        receipts.set(id, result);
        return new Promise((resolve) => {
          pairedStops.push({ resolve, result });
          if (pairedStops.length === 2)
            for (const entry of pairedStops) entry.resolve(entry.result);
        });
      },
    };
  }
  context.a = device("a");
  context.b = device("b");
  await runInNewContext(`(async () => {${stopLoop}})()`, context);
  assert.equal(context.completedRaceIterations, 100);
  assert.equal(trace.length, 700);
  assert.equal(gaps.length, 100);
  assert.ok(gaps.every((ms) => ms === 1050));
  for (let index = 0; index < 100; index++) {
    const row = trace.filter((value) => value.index === index);
    assert.equal(row[0].method, "session.create");
    assert.equal(row[0].at, 1050 * (index + 1));
    const stops = row.filter((value) => value.method === "turn.stop");
    assert.equal(stops[1].device, "a");
    assert.equal(stops[2].device, "b");
    assert.equal(stops[1].at, stops[2].at, "paired stops must dispatch without asymmetric pacing");
  }
}
console.log(
  "RC16 T23 actual-loop scheduling: UNKNOWN on either device completes 100 unchanged races / 700 RPCs / same-time stop pairs",
);

// 使用生产公布的写预算执行实际业务块；虚拟时间不借用偶然的 Native 延迟。
{
  const { LIMITS } = require("../app/src/core/remote-session-acceptor.cjs");
  assert.equal(LIMITS.writeRequestsPerSecond, 5);
  assert.equal(LIMITS.writeBurst, 10);
  function budget(a = LIMITS.writeBurst, b = LIMITS.writeBurst) {
    let now = 0;
    const peers = { a: { at: 0, tokens: a }, b: { at: 0, tokens: b } };
    const trace = [];
    return {
      trace,
      async pause(ms) {
        now += ms;
      },
      charge(peer, method) {
        trace.push({ peer, method, at: now });
        if (method.endsWith(".read") || method === "work.list") return;
        const value = peers[peer];
        value.tokens = Math.min(
          LIMITS.writeBurst,
          value.tokens + ((now - value.at) * LIMITS.writeRequestsPerSecond) / 1000,
        );
        value.at = now;
        assert.ok(value.tokens >= 1, `write quota exceeded: ${peer} ${method}`);
        value.tokens--;
      },
      writes(peer) {
        return trace.filter(
          (value) =>
            value.peer === peer && !value.method.endsWith(".read") && value.method !== "work.list",
        );
      },
    };
  }
  const t21Start = source.indexOf('      const created = (await a.rpc("session.create")).result;');
  const t21 = source.slice(
    source.lastIndexOf("      await pause(", t21Start),
    source.indexOf('      checks.push({\n        case: "T21"', t21Start),
  );
  async function preflightTraffic(body) {
    const quota = budget(4),
      held = new Set();
    let writes = 0,
      observations = 0,
      cancelled = false,
      profile;
    const taskThread = {
      id: "owned-thread",
      turns: [{ id: "held", status: "inProgress" }],
      desktop: { configuration: { revision: 1 }, queue: { paused: false, items: [] } },
    };
    const context = {
      assert,
      pause: quota.pause,
      held,
      taskOwnershipEvidence: {},
      taskOwnedPreflight,
      async waitFor(check) {
        assert.ok(await check());
      },
      async settled() {},
      async control(method, params) {
        if (method === "profile") return (profile = params);
        if (method === "last-create-profile") return profile;
        assert.equal(method, "offline");
      },
      a: {
        async rpc(method, params) {
          quota.charge("a", method);
          if (method === "command.read") return { result: { admissionState: "accepted" } };
          writes++;
          if (writes === 1) return { result: { threadId: "ordinary", commandId: randomUUID() } };
          if (writes === 2) return { error: { code: "TARGET_CHANGED" } };
          if (writes === 3)
            return {
              result: { admissionState: "rejected", error: { code: "UNSUPPORTED_PROFILE" } },
            };
          if (writes === 4 || writes === 7) {
            held.add({ destroy() {} });
            return { result: { admissionState: "accepted", turnId: "held" } };
          }
          if (writes === 5) return { error: { code: "TURN_BUSY" } };
          if (writes === 6)
            return { result: { admissionState: "accepted", threadId: taskThread.id } };
          if (writes === 8) {
            assert.equal(params.threadId, taskThread.id);
            return { error: { code: "TASK_CONTROL_REQUIRED" } };
          }
          assert.equal(writes, 9);
          return { error: { code: "CORE_UNAVAILABLE" } };
        },
      },
      async native(method) {
        if (method === "areal/thread/observe")
          return {
            thread: taskThread,
            ownership:
              ++observations === 1
                ? { kind: "ordinary" }
                : { kind: "task", taskId: "task", runId: "run" },
          };
        if (method === "areal/task/create") return { id: "task" };
        if (method === "areal/task/read")
          return {
            id: "task",
            revision: 1,
            runs: [
              {
                id: "run",
                threadId: taskThread.id,
                status: cancelled ? "cancelled" : "queued",
                workers: [],
              },
            ],
          };
        if (method === "areal/task/cancel") {
          cancelled = true;
          return;
        }
        if (method === "turn/interrupt") return;
        if (method === "thread/read") return { thread: { status: { type: "idle" } } };
        throw new Error(method);
      },
    };
    await runInNewContext(`(async () => {${body}})()`, context);
    assert.equal(quota.writes("a").length, 9);
    assert.equal(quota.trace[0].at, 1050);
    return quota;
  }
  await preflightTraffic(t21);
  await assert.rejects(
    preflightTraffic(t21.replace("await pause(1050);", "")),
    /write quota exceeded/,
  );

  const interactionsStart = source.indexOf(
    "      const target = (item) => ({",
    source.indexOf("    if (interactionOnly || interactionSettlementOnly) {"),
  );
  const interactionsHelpers = source.slice(
    interactionsStart,
    source.indexOf("      if (!interactionSettlementOnly) {", interactionsStart),
  );
  const t25Start = source.indexOf(
    "        for (let index = 0; index < repetitions; index++) {",
    interactionsStart,
  );
  const t25 = source.slice(t25Start, source.indexOf("        checks.push({", t25Start));
  const t26Start = source.indexOf("      const maximum = await startInteraction(", t25Start);
  const t26 = source.slice(
    source.lastIndexOf("      await pause(", t26Start),
    source.indexOf('      checks.push({\n        case: "T26"', t26Start),
  );
  const t27Start = source.indexOf(
    '      const question = await startInteraction("question");',
    t26Start,
  );
  const t27 = source.slice(
    source.lastIndexOf("      await pause(", t27Start),
    source.indexOf('      checks.push({\n        case: "T27"', t27Start),
  );
  async function interactionTraffic(body, initialTokens) {
    const quota = budget(initialTokens),
      items = new Map(),
      latest = new Map(),
      receipts = new Map(),
      effects = new Set();
    let fault,
      heldCommand,
      heldResolve,
      dispatches = 0,
      pair = [],
      pairCount = 0;
    const context = {
      assert,
      randomUUID,
      Buffer,
      JSON,
      join,
      workspace: "/fixture",
      repetitions: 100,
      completedRaceIterations: 0,
      pause: quota.pause,
      repeatPendingApproval,
      rejectRememberedDecision,
      interactionEvidence: { maximumReview: {}, executableReview: {} },
      async waitFor(check) {
        const value = await check();
        assert.ok(value);
        return value;
      },
      async settled(threadId) {
        const item = latest.get(threadId);
        if (item?.expired) item.status = "expired";
      },
      async readFile(path) {
        if (effects.has(path.split("/").at(-1))) return "x";
        throw Object.assign(new Error("absent"), { code: "ENOENT" });
      },
      async control(operation, value) {
        if (operation === "profile") return value;
        if (operation === "fault") {
          fault = value;
          return;
        }
        if (operation === "interaction-held") return !!heldResolve;
        if (operation === "release-interaction") {
          const response = {
            result: { admissionState: "rejected", error: { code: "TARGET_CHANGED" } },
          };
          receipts.set(heldCommand, response);
          heldResolve(response);
          heldResolve = null;
          return;
        }
        if (operation === "dispatches") return dispatches;
        throw new Error(operation);
      },
      async native(method, params) {
        if (method === "areal/turn/start") {
          const text = params.input[0].text;
          const [, kind, effect] = text.match(/^RC07_(APPROVAL|QUESTION):([^ ]+)/);
          const turnId = randomUUID(),
            requestId = randomUUID();
          const args =
            kind === "APPROVAL"
              ? JSON.parse((await model([user(text)])).tool.function.arguments)
              : null;
          const item = {
            threadId: params.threadId,
            turnId,
            requestId,
            kind: kind === "APPROVAL" ? "approval" : "question",
            status: "pending",
            effect,
            expired: text.includes("RC07_EXPIRE"),
            effectiveArguments: args,
            effectivePermissions: args ? { restrictions: {} } : null,
            argumentsDigest: args ? createHash("sha256").update(turnId).digest("hex") : null,
          };
          items.set(requestId, item);
          latest.set(params.threadId, item);
          return { turn: { id: turnId } };
        }
        if (method === "areal/interaction/list")
          return { data: [...items.values()].filter((item) => item.threadId === params.threadId) };
        if (method === "turn/interrupt") {
          latest.get(params.threadId).status = "answered";
          return;
        }
        if (method === "areal/permissions/read") return { session: [], project: [] };
        if (method === "thread/read")
          return {
            thread: {
              turns: [...items.values()]
                .filter((item) => item.threadId === params.threadId)
                .map((item) => ({
                  id: item.turnId,
                  items: [
                    {
                      type: "dynamicToolCall",
                      tool: "run_command",
                      execution: { originalArguments: JSON.stringify(item.effectiveArguments) },
                    },
                  ],
                })),
            },
          };
        throw new Error(method);
      },
    };
    function device(peer) {
      return {
        rpc(method, params = {}, commandId = randomUUID()) {
          quota.charge(peer, method);
          if (method === "session.create")
            return { result: { threadId: randomUUID(), admissionState: "accepted" } };
          if (method === "command.read") return receipts.get(params.commandId);
          const item = items.get(params.interactionId);
          if (method === "attention.read") {
            const body = JSON.stringify({
              effectiveArguments: item.effectiveArguments,
              effectivePermissions: item.effectivePermissions,
            });
            const boundary = body.length > 40000 ? Math.ceil(body.length / 2) : body.length;
            const offset = params.cursor ? boundary : 0,
              chunk = body.slice(offset, params.cursor ? undefined : boundary);
            const more = !params.cursor && boundary < body.length;
            return {
              result: {
                argumentsDigest: item.argumentsDigest,
                complete: !more,
                reviewToken: "fixture-review",
                nextCursor: more ? "next" : null,
                review: {
                  chunk,
                  offset: Buffer.byteLength(body.slice(0, offset)),
                  totalBytes: Buffer.byteLength(body),
                },
              },
            };
          }
          assert.equal(method, "interaction.respond");
          if (receipts.has(commandId)) return receipts.get(commandId);
          if (
            !item ||
            item.turnId !== params.turnId ||
            (item.kind === "approval" && item.argumentsDigest !== params.argumentsDigest) ||
            item.status !== "pending"
          )
            return { error: { code: "TARGET_CHANGED" } };
          if (["allowSession", "allowProject"].includes(params.decision))
            return { error: { code: "INVALID_PARAMS" } };
          if (params.decision === "allowOnce" && !params.reviewToken)
            return { error: { code: "REVIEW_INCOMPLETE" } };
          if (item.kind === "question") {
            const answers = params.answers;
            if (
              !answers ||
              Object.keys(answers).sort().join() !== "choice,free" ||
              !["A", "B"].includes(answers.choice) ||
              typeof answers.free !== "string" ||
              Buffer.byteLength(answers.free) > 4096
            )
              return { error: { code: "INVALID_PARAMS" } };
            return new Promise((resolve) => {
              pair.push({ peer, answers, resolve });
              if (pair.length === 2) {
                assert.equal(pair[0].peer, "a");
                assert.equal(pair[1].peer, "b");
                item.status = "answered";
                item.response = { answers: pair[0].answers };
                pairCount++;
                pair[0].resolve({ result: { admissionState: "accepted" } });
                pair[1].resolve({ error: { code: "TARGET_CHANGED" } });
                pair = [];
              }
            });
          }
          dispatches++;
          if (fault === "hold-interaction-before-native") {
            fault = null;
            heldCommand = commandId;
            return new Promise((resolve) => {
              heldResolve = resolve;
            });
          }
          item.status = "answered";
          if (params.decision === "deny") return { result: { admissionState: "accepted" } };
          assert.equal(fault, "lost-native-response");
          fault = null;
          effects.add(item.effect);
          const response = {
            result: {
              admissionState: "unknown",
              observedState: { status: "answered", provesCommandAdmission: false },
            },
          };
          receipts.set(commandId, response);
          return response;
        },
      };
    }
    context.a = device("a");
    context.b = device("b");
    await runInNewContext(`(async () => {${interactionsHelpers}\n${body}})()`, context);
    return { quota, completed: context.completedRaceIterations, pairCount };
  }
  const races = await interactionTraffic(t25, 10);
  assert.equal(races.completed, 100);
  assert.equal(races.quota.writes("a").length, 300);
  assert.equal(races.quota.writes("b").length, 150);
  assert.deepEqual(
    races.quota.trace.filter((entry) => entry.method === "session.create").map((entry) => entry.at),
    Array.from({ length: 100 }, (_, index) => 1050 * (index + 1)),
  );
  await assert.rejects(
    interactionTraffic(t25.replace("await pause(1050);", ""), 10),
    /write quota exceeded/,
  );
  const approval = await interactionTraffic(t26, 7);
  assert.equal(approval.quota.writes("a").length, 10);
  assert.equal(approval.quota.trace[0].at, 2100);
  await assert.rejects(
    interactionTraffic(t26.replace("await pause(2100);", ""), 7),
    /write quota exceeded/,
  );
  const questions = await interactionTraffic(t27, 0);
  assert.equal(questions.quota.writes("a").length, 8);
  assert.equal(questions.quota.trace[0].at, 2100);
  assert.equal(questions.pairCount, 1);
  const pairTraffic = questions.quota.trace
    .filter((entry) => entry.method === "interaction.respond")
    .slice(4, 6);
  assert.equal(pairTraffic[0].peer, "a");
  assert.equal(pairTraffic[1].peer, "b");
  assert.equal(pairTraffic[0].at, pairTraffic[1].at);
  await assert.rejects(
    interactionTraffic(t27.replace("await pause(2100);", ""), 0),
    /write quota exceeded/,
  );
  console.log(
    "RC16 actual consumer blocks honor production 5/s burst10: T21 9 writes, T25 100 races A300/B150, T26 10, T27 8 with unchanged paired dispatch; removing each entry guard fails",
  );
}

// 仅验证源码消费者的就绪边界；这些替身不构成 Chrome/Core/Native 验收。
{
  const { RemoteControl } = require("../app/src/core/remote.cjs");
  const source = await readFile(new URL("./remote-pairing-e2e.mjs", import.meta.url), "utf8");
  const start = source.indexOf("  await enableLocal.click();");
  const end = source.indexOf("  checks.push('one-use invitation uses URL fragment');", start);
  assert.ok(start > 0 && end > start);
  const moved = source.slice(start, end);
  const consumer = moved
    .replace("  address = remote.direct;\n", "")
    .replace(
      "  const invitationStarted = Date.now();",
      "  address = remote.direct;\n  const invitationStarted = Date.now();",
    );
  assert.notEqual(consumer, moved);
  async function exercise(body, fails = false, mismatch = false) {
    let release, entered, enable, payload;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const entering = new Promise((resolve) => {
      entered = resolve;
    });
    const remote = Object.create(RemoteControl.prototype);
    Object.assign(remote, {
      config: {
        identity: {},
        enabled: false,
        directEnabled: false,
        network: { kind: "tailscale", mapping: { state: "removed", operation: "remove" } },
      },
      direct: null,
      pending: new Map(),
      channels: new Map(),
      encryption: {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(value),
      },
      backend: { save: async () => {} },
      service: { schedule() {} },
      crypto: { identityId: () => "fixture-host" },
      async startDirect() {
        entered();
        await pending;
        if (fails)
          throw Object.assign(new Error("fixture typed startup failure"), {
            code: "FIXTURE_START_FAILURE",
          });
        this.direct = {
          origin: "http://127.0.0.1:43123",
          server: { listening: true, address: () => ({ address: "127.0.0.1", port: 43123 }) },
          sockets: new Set(),
          close() {},
        };
      },
    });
    const enableLocal = {
      async click() {
        enable = remote.control({ operation: "enableDirect" });
        enable.catch(() => {});
        await entering;
        assert.equal(remote.state().directEnabled, true);
        assert.equal(remote.direct, null);
      },
    };
    const desktop = {
      getByRole(role, { name }) {
        if (role === "button" && name === "生成配对链接")
          return {
            async click() {
              release();
              await enable;
              payload = (await remote.control({ operation: "pair" })).payload;
              if (mismatch) payload = payload.replace("43123", "43124");
            },
          };
        if (role === "textbox" && name === "配对链接")
          return {
            async inputValue() {
              return payload;
            },
          };
        throw new Error("unexpected locator");
      },
    };
    const context = {
      remote,
      enableLocal,
      desktop,
      assert,
      URL,
      URLSearchParams,
      Date,
      setTimeout() {
        throw new Error("unexpected timer: source-only oracle has no sleeps");
      },
    };
    let error;
    try {
      await runInNewContext(`(async () => { let address; ${body}; return true; })()`, context);
    } catch (value) {
      error = value;
    }
    return {
      error,
      readyAfterward: !!remote.direct,
      enabledAfterward: remote.state().directEnabled,
    };
  }
  const red = await exercise(consumer);
  assert.equal(red.error?.name, "TypeError");
  assert.equal(red.error?.message, "Cannot read properties of null (reading 'origin')");
  assert.equal(red.readyAfterward, true);
  const green = await exercise(moved);
  assert.equal(green.error, undefined);
  const failure = await exercise(moved, true);
  assert.match(failure.error.message, /本机只读入口启用失败/);
  assert.equal(failure.readyAfterward, false);
  assert.equal(failure.enabledAfterward, false);
  const wrongOrigin = await exercise(moved, false, true);
  assert.equal(wrongOrigin.error?.code, "ERR_ASSERTION");
  console.log(
    "Pairing actual consumer: old address capture RED; completed startup GREEN; failed startup and wrong origin rejected",
  );
}
{
  const { createContext, runInContext } = await import("node:vm");
  const source = await readFile(new URL("./remote-work-overview-e2e.mjs", import.meta.url), "utf8");
  const main = await readFile(new URL("../renderer/remote-web/main.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../renderer/remote.html", import.meta.url), "utf8");
  const lifecycle = await readFile(
    new URL("./remote-browser-lifecycle-contract.mjs", import.meta.url),
    "utf8",
  );
  const { BrowserState } = await import(
    new URL("../renderer/remote-web/browser-state.mjs", import.meta.url)
  );
  function slice(text, first, last) {
    const a = text.indexOf(first),
      b = text.indexOf(last, a);
    assert.ok(a >= 0 && b > a);
    return text.slice(a, b);
  }
  const init = slice(main, "async function initializeBrowser() {", "async function connectHost(");
  const fixed = slice(
    source,
    "    const evaluate = async expression =>",
    "    await remote.control({ operation: 'approve'",
  );
  const waitSource = slice(source, "async function waitFor(", "async function fileSha256(");
  const domFixture = slice(lifecycle, "function events() {", "function inbox() {");
  const handler = 'connect.addEventListener("click", () => connectHost());';
  assert.ok(main.includes(handler));
  assert.match(html, /<button\b(?=[^>]*\bid="connect")(?=[^>]*\btype="button")(?=[^>]*\bdisabled)[^>]*>/);
  const consumer = fixed
    .replace(' && !document.getElementById("connect").disabled', "")
    .replace("production Remote connect ready", "production Remote page loaded")
    .replace(
      slice(fixed, "    const evaluate =", "    await waitFor("),
      "    const evaluate = async expression => (await cdp('Runtime.evaluate', { expression, returnByValue: true }, sessionId)).result.value;\n",
    );
  assert.notEqual(consumer, fixed);
  async function exercise(body, mode = "delayed") {
    let release,
      clicks = 0,
      now = 0,
      polls = 0;
    const restored = new Promise((resolve) => {
      release = resolve;
    });
    const browserState = new BrowserState({
      createIdentity: async () => "unused",
      identityId: () => "unused",
      indexedDB: null,
      channel: null,
      sessionStorage: null,
    });
    // 保留真实 restore，仅延迟存储事务边界。
    browserState.transaction = async () => {
      await restored;
      return { credential: null };
    };
    const page = createContext({
      browserState,
      connectionAttempt: 0,
      browserLoaded: false,
      pinConflict: false,
      rememberChoice: {},
      status: {},
      storageError: {},
      commandState: { commands: new Map() },
      renderDeviceStorage() {},
      renderCommandControls() {},
      connectHost() {
        clicks++;
      },
    });
    runInContext(domFixture + "\nglobalThis.connect = new Element(); connect.disabled=true;", page);
    runInContext(init + "\n" + handler + "\nglobalThis.initialization=initializeBrowser();", page);
    page.document = {
      getElementById(id) {
        assert.equal(id, "connect");
        return page.connect;
      },
    };
    let evalCalls = 0;
    const cdp = async (method, { expression }) => {
      assert.equal(method, "Runtime.evaluate");
      evalCalls++;
      if (mode === "exception" && expression.includes(".click()"))
        return {
          result: { type: "object", subtype: "error" },
          exceptionDetails: {
            text: "Uncaught",
            lineNumber: 0,
            columnNumber: 0,
            exception: {
              className: "TypeError",
              description: "fixture private URL and invitation must never enter the thrown error",
            },
          },
        };
      return { result: { value: runInContext(expression, page) } };
    };
    const context = createContext({
      cdp,
      sessionId: "fixture-session",
      remote: {
        async control() {
          return { pending: clicks ? [{ id: "fixture-pending" }] : [] };
        },
      },
      Date: { now: () => now },
      setTimeout(callback, ms) {
        now += ms;
        polls++;
        if (mode !== "blocked") release();
        Promise.resolve(page.initialization).then(callback);
      },
    });
    // 永久阻塞初始化时，只推进虚拟轮询时钟。
    if (mode === "blocked")
      context.setTimeout = (callback, ms) => {
        now += ms;
        polls++;
        callback();
      };
    if (mode === "exception") {
      release();
      await page.initialization;
    }
    let error;
    try {
      await runInContext(waitSource + "\n(async()=>{" + body + "})()", context);
    } catch (e) {
      error = e;
    }
    return {
      name: error?.name,
      message: error?.message,
      clicks,
      polls,
      elapsedVirtualMs: now,
      buttonDisabled: page.connect.disabled,
      evalCalls,
    };
  }
  const red = await exercise(consumer);
  assert.equal(red.message, "Timed out: raw browser pairing");
  assert.equal(red.clicks, 0);
  assert.equal(red.buttonDisabled, false);
  const green = await exercise(fixed);
  assert.equal(green.message, undefined);
  assert.equal(green.clicks, 1);
  assert.equal(green.polls, 1);
  const blocked = await exercise(fixed, "blocked");
  assert.equal(blocked.message, "Timed out: production Remote connect ready");
  assert.equal(blocked.clicks, 0);
  const exception = await exercise(consumer, "exception");
  assert.equal(exception.message, "Timed out: raw browser pairing");
  assert.equal(exception.clicks, 0);
  const surfaced = await exercise(fixed, "exception");
  assert.equal(surfaced.message, "CDP Runtime.evaluate failed");
  assert.equal(surfaced.name, "Error");
  assert.equal(surfaced.polls, 0);
  console.log(
    "Raw CDP actual consumer: disabled lost-click RED; enabled readiness GREEN with one click; blocked readiness rejected; evaluation exception fails immediately",
  );
}

// 执行页面归一化和两个真实消费者；公开 pin 不是握手验证或 Native 验收证据。
{
  const harness = await readFile(new URL("./remote-pairing-e2e.mjs", import.meta.url), "utf8");
  const main = await readFile(new URL("../renderer/remote-web/main.js", import.meta.url), "utf8");
  const wire = await readFile(new URL("../packages/remote/src/wire.mjs", import.meta.url), "utf8");
  function slice(text, first, last) {
    const start = text.indexOf(first),
      end = text.indexOf(last, start);
    assert.ok(start >= 0 && end > start);
    return text.slice(start, end);
  }
  const helper = slice(harness, "function assertPublicDirectUrl(", "async function fileSha256(");
  const assertPublicDirectUrl = runInNewContext(helper + "\nassertPublicDirectUrl;", {
    assert,
    URL,
    URLSearchParams,
  });
  const locator = slice(wire, "export function remoteLocator(", "// socket").replaceAll(
    "export function",
    "function",
  );
  const normalization = slice(
    main,
    "const fragment = new URLSearchParams(",
    "const rememberChoice",
  );
  const initial = slice(
    harness,
    "  assertPublicDirectUrl(page.url()",
    "  await page.getByRole('button', { name: '连接电脑' }).click();",
  );
  const open = slice(harness, "  const openInvite = async link =>", "  const pinInvite =");
  const wrongPin = slice(harness, "  const pinInvite =", "  await wrong.locator('#status')");
  const host = "12D3KooW" + "a".repeat(44),
    other = "12D3KooW" + "b".repeat(44),
    secret = "c".repeat(64);
  const input = new URL("http://127.0.0.1:43123/");
  input.hash = new URLSearchParams({ host, invite: secret }).toString();
  function normalize(value) {
    const location = new URL(value);
    runInNewContext(locator + "\n" + normalization, {
      URLSearchParams,
      location,
      history: {
        replaceState(_state, _title, next) {
          location.href = new URL(next, location).href;
        },
      },
    });
    return location.href;
  }
  const actual = normalize(input.href);
  const initialContext = {
    assert,
    URL,
    assertPublicDirectUrl,
    invite: { payload: input.href },
    page: { url: () => actual },
  };
  const oldInitial = initial.replace(
    "assertPublicDirectUrl(page.url(), invite.payload);",
    "assert.equal(new URL(page.url()).hash, '');",
  );
  assert.notEqual(oldInitial, initial);
  assert.throws(() => runInNewContext(oldInitial, initialContext), { code: "ERR_ASSERTION" });
  runInNewContext(initial, initialContext);

  let clicks = 0;
  const browser = {
    async newPage() {
      let value;
      return {
        async goto(link) {
          value = normalize(link);
        },
        url() {
          return value;
        },
        getByRole(role, { name }) {
          assert.equal(role, "button");
          assert.equal(name, "连接电脑");
          return {
            async click() {
              clicks++;
            },
          };
        },
      };
    },
  };
  const context = { assert, URL, URLSearchParams, assertPublicDirectUrl, browser };
  const openInvite = runInNewContext(open + "\nopenInvite;", context);
  const oldOpen = open.replace(
    "assertPublicDirectUrl(target.url(), link);",
    "assert.equal(new URL(target.url()).hash, '');",
  );
  assert.notEqual(oldOpen, open);
  await assert.rejects(runInNewContext(oldOpen + "\nopenInvite;", { ...context })(input.href), {
    code: "ERR_ASSERTION",
  });
  assert.equal(clicks, 0);
  await openInvite(input.href);
  assert.equal(clicks, 1);
  const wrong = await runInNewContext(`(async () => { ${wrongPin}\nreturn wrong; })()`, {
    ...context,
    openInvite,
    remote: {
      async control({ operation }) {
        assert.equal(operation, "pair");
        return { payload: input.href };
      },
    },
    createIdentity: async () => other,
    identityId: (value) => value,
  });
  assert.equal(clicks, 2);
  assert.ok(new URL(wrong.url()).hash === "#host=" + other);
  assert.throws(() => assertPublicDirectUrl(wrong.url(), input.href), { code: "ERR_ASSERTION" });

  const changes = [
    [
      "retained invitation",
      (u) => {
        u.hash += "&invite=" + secret;
      },
    ],
    [
      "sensitive capability",
      (u) => {
        u.hash += "&capability=" + secret;
      },
    ],
    [
      "unknown fragment field",
      (u) => {
        u.hash += "&unexpected=value";
      },
    ],
    [
      "endpoint override",
      (u) => {
        u.hash += "&relay=https%3A%2F%2Fforeign.invalid";
      },
    ],
    [
      "unexpected room in Direct",
      (u) => {
        u.hash += "&room=" + "d".repeat(64);
      },
    ],
    [
      "duplicate Host",
      (u) => {
        u.hash += "&host=" + host;
      },
    ],
    [
      "changed Host",
      (u) => {
        u.hash = "#host=" + other;
      },
    ],
    [
      "removed Host",
      (u) => {
        u.hash = "";
      },
    ],
    [
      "query",
      (u) => {
        u.search = "?invite=" + secret;
      },
    ],
    [
      "changed origin",
      (u) => {
        u.hostname = "localhost";
      },
    ],
    [
      "changed path",
      (u) => {
        u.pathname = "/other";
      },
    ],
    [
      "URL credentials",
      (u) => {
        u.username = "fixture";
        u.password = secret;
      },
    ],
  ];
  for (const [name, mutate] of changes) {
    const changed = new URL(actual);
    mutate(changed);
    const checkError = (error) => {
      assert.equal(error.code, "ERR_ASSERTION", name);
      assert.equal(error.actual, false, name);
      assert.equal(error.expected, true, name);
      assert.equal(
        error.message,
        "Remote URL must retain only the exact expected public Host pin",
        name,
      );
      assert.ok(!String(error.stack).includes(secret), name);
      assert.ok(!String(error.stack).includes(changed.href), name);
      return true;
    };
    assert.throws(
      () => runInNewContext(initial, { ...initialContext, page: { url: () => changed.href } }),
      checkError,
    );
    const rejectedOpen = runInNewContext(open + "\nopenInvite;", {
      ...context,
      browser: {
        async newPage() {
          return {
            async goto() {},
            url: () => changed.href,
            getByRole() {
              throw new Error("invalid URL reached connect");
            },
          };
        },
      },
    });
    await assert.rejects(rejectedOpen(input.href), checkError);
  }
  const noisy = new URL(input);
  noisy.search = "?private=" + secret;
  noisy.hash += "&capability=" + secret + "&relay=https%3A%2F%2Fforeign.invalid&other=x";
  runInNewContext(initial, { ...initialContext, page: { url: () => normalize(noisy.href) } });
  for (const [observed, invitation] of [
    ["not a URL " + secret, input.href],
    [actual, "not a url " + secret],
  ]) {
    assert.throws(
      () => assertPublicDirectUrl(observed, invitation),
      (error) => {
        assert.equal(error.code, "ERR_ASSERTION");
        assert.equal(error.actual, false);
        assert.equal(error.expected, true);
        assert.ok(!String(error.stack).includes(secret));
        return true;
      },
    );
  }
  console.log(
    "Pairing public locator: both original empty-hash consumers RED; actual helper/normalization GREEN; wrong-pin input reaches its own consumer; 12 mutations rejected at both consumers with private errors",
  );
}

// 只建模当前 HTML 的连接状态消费者；不替代 Playwright/DOM 或真实握手验收。
{
  const harness = await readFile(new URL("./remote-pairing-e2e.mjs", import.meta.url), "utf8");
  const html = await readFile(new URL("../renderer/remote.html", import.meta.url), "utf8");
  const hostSource = await readFile(new URL("../app/src/core/remote.cjs", import.meta.url), "utf8");
  const acceptor = await readFile(
    new URL("../app/src/core/remote-session-acceptor.cjs", import.meta.url),
    "utf8",
  );
  const main = await readFile(new URL("../renderer/remote-web/main.js", import.meta.url), "utf8");
  function slice(text, first, last) {
    const start = text.indexOf(first),
      end = text.indexOf(last, start);
    assert.ok(start >= 0 && end > start);
    return text.slice(start, end);
  }
  // 当前页面隐藏区均为不嵌套的 section；只从这些实际源码范围判断初始可见性。
  const hiddenSections = [...html.matchAll(/<section\b[^>]*\bhidden[^>]*>([\s\S]*?)<\/section>/g)];
  assert.equal(hiddenSections.length, 6);
  for (const section of hiddenSections) assert.ok(!section[1].includes("<section"));
  const elements = [...html.matchAll(/<p id="([^"]+)" role="status">/g)].map((match) => ({
    id: match[1],
    hidden: hiddenSections.some(
      (section) => match.index > section.index && match.index < section.index + section[0].length,
    ),
  }));
  assert.equal(elements.length, 11);
  assert.deepEqual(
    elements.filter((element) => !element.hidden).map((element) => element.id),
    ["status", "device-storage", "update-status"],
  );
  assert.ok(main.includes('const status = document.getElementById("status");'));
  assert.ok(harness.includes("getByRole('radio', { name: '可操作', exact: true }).check()"));

  const presetSource = slice(hostSource, "const PRESETS =", "const pairingError");
  const control = slice(hostSource, "    async controlOnce(request) {", "    async enableRelay(");
  const save = slice(hostSource, "    async save(config) {", "    state() {");
  const methods = runInNewContext(presetSource + "\n({" + control + "," + save + "})", {
    clearTimeout() {},
  });
  let accepts = 0,
    persisted,
    fail = true,
    rearmed = 0;
  const diskError = new Error("fixture disk failure");
  const remote = {
    ...methods,
    config: { deviceGrants: [] },
    pending: new Map([
      [
        "fixture-peer",
        {
          expiresAt: Date.now() + 120000,
          connected: () => true,
          name: "fixture",
          arm() {
            rearmed++;
          },
          accept() {
            assert.ok(persisted);
            accepts++;
          },
        },
      ],
    ]),
    backend: {
      saved: [{ id: "p" }, { id: "q" }],
      async save(name, value) {
        assert.equal(name, "remote.json");
        if (fail) throw diskError;
        persisted = value;
      },
    },
    storageAvailable: () => true,
    encryption: { encryptString: (value) => Buffer.from(value) },
    closePeer() {},
    service: { schedule() {} },
    state() {
      return this.config;
    },
  };
  const request = {
    operation: "approve",
    id: "fixture-peer",
    projects: ["p", "q"],
    preset: "Operator",
  };
  await assert.rejects(remote.controlOnce(request), (error) => error === diskError);
  assert.equal(accepts, 0);
  assert.equal(remote.config.deviceGrants.length, 0);
  assert.equal(rearmed, 1);
  fail = false;
  await remote.controlOnce(request);
  assert.equal(accepts, 1);
  assert.equal(remote.config.deviceGrants.length, 1);
  const grant = remote.config.deviceGrants[0];
  assert.deepEqual(Array.from(grant.projectIds), ["p", "q"]);
  assert.deepEqual(
    JSON.parse(Buffer.from(persisted.encrypted, "base64").toString()),
    JSON.parse(JSON.stringify(remote.config)),
  );
  const supported = runInNewContext(
    acceptor.match(/^const CAPABILITIES = .*;$/m)[0] + "\nCAPABILITIES;",
  );
  const limits = runInNewContext(
    slice(acceptor, "const LIMITS =", "const CAPABILITIES =") + "\nLIMITS;",
    {
      SESSION_LIMITS: {},
      REVIEW_LIMITS: {},
      INTERACTION_LIMITS: {},
      TASK_QUESTION_LIMITS: {},
      COMMAND_LIMITS: {},
    },
  );
  let ready;
  runInNewContext(
    slice(acceptor, '    secure.send({\n        event: "ready",', "    let windowStart ="),
    {
      secure: {
        send(value) {
          ready = value;
        },
      },
      grant,
      CAPABILITIES: supported,
      METHODS: [],
      LIMITS: limits,
      remote: {
        crypto: { identityId: () => "fixture-host" },
        config: { identity: {} },
        gatewayGeneration: "fixture-generation",
      },
      connectionId: "fixture-connection",
    },
  );
  const expected = ["observe", "review", "submit", "interrupt", "answer", "pauseTask"];
  assert.deepEqual(Array.from(ready.capabilities), expected);
  assert.equal(ready.limits.applicationMessageBytes, 262144);
  const render = slice(main, '    document.getElementById("connection-protocol").textContent =', '    connectionPhase("connected");');
  assert.ok(render);
  function renderStatus(
    capabilities,
    applicationMessageBytes = ready.limits.applicationMessageBytes,
  ) {
    const status = {};
    runInNewContext(render, {
      document: { getElementById(id) { assert.equal(id, "connection-protocol"); return status; } },
      connected: { ...ready, capabilities, limits: { applicationMessageBytes } },
    });
    return status.textContent;
  }
  const expectedConnected =
    "能力：observe、review、submit、interrupt、answer、pauseTask；消息上限：262144 字节";
  assert.equal(renderStatus(ready.capabilities), expectedConnected);

  class Locator {
    constructor(values) {
      this.values = values;
    }
    getByText(pattern) {
      return new Locator(this.values.filter((value) => pattern.test(value.text)));
    }
    async waitFor() {
      assert.equal(this.values.length, 1, "strict matching connection status");
    }
    async textContent() {
      if (this.values.length !== 1)
        throw new Error(
          "strict mode violation: status resolved to " + this.values.length + " elements",
        );
      return this.values[0].text;
    }
  }
  function page(connectionText, otherText) {
    const all = elements.map((element) => ({
      ...element,
      text: element.id === "status" ? connectionText : otherText,
    }));
    return {
      getByRole(role) {
        assert.equal(role, "status");
        return new Locator(all.filter((element) => !element.hidden));
      },
      locator(selector) {
        assert.equal(selector, "#status");
        return new Locator(all.filter((element) => element.id === "status"));
      },
      async close() {},
    };
  }
  const consumers = harness.split("\n").filter((line) => line.includes("locator('#status')"));
  assert.equal(consumers.length, 15);
  assert.ok(!harness.includes("getByRole('status')"));
  const capabilityCheck = harness.split("\n").find((line) => line.includes("locator('#connection-protocol')") && line.includes("消息上限：262144 字节"));
  const protocolPage = (value) => ({ locator(selector) { assert.equal(selector, "#connection-protocol"); return new Locator([{ text: value }]); } });
  assert.ok(capabilityCheck);
  const states = [
    "等待桌面确认",
    "等待桌面确认",
    "已连接",
    "已连接电脑 · 可操作",
    "已断开",
    "已连接",
    "已断开",
    "未获授权",
    "Host 不匹配",
    "等待桌面确认",
    "等待桌面确认",
    "邀请已使用或取消",
    "邀请已过期",
    "等待桌面确认",
    "配对已取消",
  ];
  const run = (line, context) =>
    runInNewContext("(async()=>{" + line + "})()", { assert, Promise, ...context });
  const oldWaiting = consumers
    .find((line) => line.includes("assert.match") && line.includes("等待桌面确认"))
    .replaceAll("locator('#status')", "getByRole('status')");
  await assert.rejects(
    run(oldWaiting, { page: page("等待桌面确认", "unrelated status") }),
    /strict mode violation: status resolved to 3 elements/,
  );
  const oldCapability =
    "  assert.match(await page.locator('#status').textContent(), /只读能力：observe/);";
  await assert.rejects(
    run(oldCapability, { page: page(expectedConnected, "unrelated status") }),
    (error) => error.code === "ERR_ASSERTION",
  );
  for (let index = 0; index < consumers.length; index++) {
    function context(good) {
      const p = page(good ? states[index] : "wrong connection state", states[index]);
      const racers = [
        page(good ? "等待桌面确认" : "wrong connection state", "等待桌面确认"),
        page(good ? "邀请已使用" : "wrong connection state", "邀请已使用"),
      ];
      return { page: p, wrong: p, cancelledPage: p, expiredPage: p, pastedPage: p, racers };
    }
    await run(consumers[index], context(true));
    await assert.rejects(run(consumers[index], context(false)));
  }
  for (const capabilities of [
    expected.filter((value) => value !== "submit"),
    ["observe"],
    [...expected, "admin"],
    expected.map((value) => (value === "answer" ? "answerOther" : value)),
  ]) {
    await assert.rejects(
      run(capabilityCheck, { page: protocolPage(renderStatus(capabilities)) }),
      (error) => error.code === "ERR_ASSERTION",
    );
  }
  await assert.rejects(
    run(capabilityCheck, { page: protocolPage(renderStatus(expected, 131072)) }),
    (error) => error.code === "ERR_ASSERTION",
  );
  console.log(
    "Pairing connection status: three visible roles make original consumer RED; all 15 actual #status consumers GREEN and reject unrelated status text; actual save/approve/ready/render preserves exact Operator capabilities and budget, rejecting missing/extra/wrong capabilities",
  );
}
