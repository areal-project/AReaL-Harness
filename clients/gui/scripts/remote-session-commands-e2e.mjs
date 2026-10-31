import { makeTempDir } from "./support/temp.mjs";
// 原生 T18–T34：真实 DesktopService/Core/Runtime/Noise；本机安全存储用显式 fixture。
import assert from "node:assert/strict";
import { CoreClient } from "../packages/runtime-client/core.js";
import { createRequire } from "node:module";
import { fork, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createIdentity, identityId, secureChannel } from "../packages/remote/src/channel.mjs";
import { createRemoteWire } from "../packages/remote/src/wire.mjs";
import {
  selectRemoteTransport,
  startConformanceTransport,
  initializeConformanceHost,
  browserTransportLimitation,
} from "./remote-conformance-transport.mjs";
const transport = selectRemoteTransport();
const filename = fileURLToPath(import.meta.url),
  gui = resolve(dirname(filename), ".."),
  root = resolve(gui, "../..");
const require = createRequire(import.meta.url);
const { CoreBackend } = require("../app/src/core/backend.cjs");
const { DesktopService } = require("../app/src/core/service-protocol.cjs");
const { RemoteControl } = require("../app/src/core/remote.cjs");
const WebSocket = require("../app/node_modules/ws");
const encryptionFixture = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "fixture",
  encryptString: (value) => Buffer.from(value),
  decryptString: (value) => value.toString("utf8"),
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// 仅保留最近 16 个响应的协议元数据；任意错误文案、正文和不透明标识不得进入诊断。
function recordRpcOutcome(outcomes, method, id, commandId, response) {
  const error = response?.error ?? response?.result?.error;
  const methods = [
    "session.create",
    "session.send",
    "turn.stop",
    "interaction.respond",
    "task.question.reply",
    "task.pause",
    "command.read",
    "attention.read",
    "task.question.read",
    "task.read",
    "work.list",
    "review.read",
    "artifact.read",
  ];
  const codes = [
    "INVALID_PARAMS",
    "REVIEW_INCOMPLETE",
    "FORBIDDEN",
    "GRANT_CHANGED",
    "RESYNC_REQUIRED",
    "CORE_UNAVAILABLE",
    "CORE_INCOMPATIBLE",
    "RESOURCE_UNAVAILABLE",
    "TURN_BUSY",
    "TASK_CONTROL_REQUIRED",
    "TARGET_CHANGED",
    "COMMAND_CONFLICT",
    "SUBMISSION_UNKNOWN",
    "LIMIT_EXCEEDED",
    "CAPACITY_EXCEEDED",
    "UNSUPPORTED_PROFILE",
  ];
  const messages = [
    "请求过于频繁",
    "命令超过允许的预算",
    "此命令未获授权",
    "会话条件已变化，草稿已保留",
    "此会话由 Task 管理",
    "命令未受理，请刷新状态后检查草稿",
  ];
  outcomes.push({
    method: methods.includes(method) ? method : "UNRECOGNIZED_METHOD",
    id,
    commandId:
      typeof commandId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(commandId)
        ? commandId
        : null,
    responseKind: response?.error ? "error" : response?.result ? "result" : "malformed",
    errorCode: error ? (codes.includes(error.code) ? error.code : "UNRECOGNIZED_ERROR") : null,
    errorMessage: error
      ? messages.includes(error.message)
        ? error.message
        : "message omitted"
      : null,
    admissionState: ["accepted", "rejected", "unknown", "pending", "notFound"].includes(
      response?.result?.admissionState,
    )
      ? response.result.admissionState
      : null,
  });
  if (outcomes.length > 16) outcomes.shift();
}
async function waitFor(fn, label, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const result = await fn();
    if (result) return result;
    await pause(50);
  }
  throw new Error(`Timed out: ${label}`);
}

// 用已排队的实际 Run 建立所有权；未来排程本身不会把普通 Thread 变为 Task 所有。
async function taskOwnedPreflight({
  rpc,
  native,
  waitForModel,
  evidence,
  operation = "session.send",
}) {
  let threadId, turnId, task;
  let taskCreationAttempted = false;
  evidence.cleanup = [];
  try {
    const created = await rpc("session.create");
    assert.equal(created.result.admissionState, "accepted");
    threadId = created.result.threadId;
    evidence.initial = await native("areal/thread/observe", { threadId });
    assert.equal(evidence.initial.ownership.kind, "ordinary");
    const expectedConfigRevision = evidence.initial.thread.desktop.configuration.revision;
    const running = await rpc("session.send", {
      threadId,
      expectedConfigRevision,
      text: "RC05_HOLD",
    });
    evidence.running = running;
    assert.equal(running.result.admissionState, "accepted");
    turnId = running.result.turnId;
    await waitForModel();
    taskCreationAttempted = true;
    task = await native("areal/task/create", {
      requestId: randomUUID(),
      threadId,
      mode: "background",
      objective: "RC05 queued ownership",
    });
    evidence.createdTask = task;
    const queuedTask = await waitFor(async () => {
      const value = await native("areal/task/read", { taskId: task.id });
      evidence.taskBeforeSend = value;
      return value.runs.some((run) => run.status === "queued" && run.threadId === threadId)
        ? value
        : null;
    }, "same Thread queued Task Run behind held ordinary Turn");
    const run = queuedTask.runs.find((run) => run.status === "queued" && run.threadId === threadId);
    evidence.observationBeforeSend = await native("areal/thread/observe", { threadId });
    assert.equal(evidence.observationBeforeSend.ownership.kind, "task");
    assert.equal(evidence.observationBeforeSend.ownership.taskId, task.id);
    assert.equal(evidence.observationBeforeSend.ownership.runId, run.id);
    assert.equal(
      evidence.observationBeforeSend.thread.turns.find((turn) => turn.id === turnId)?.status,
      "inProgress",
    );
    assert.equal(evidence.observationBeforeSend.thread.desktop.queue.paused, false);
    assert.equal(
      evidence.observationBeforeSend.thread.desktop.configuration.revision,
      expectedConfigRevision,
    );
    evidence.request =
      operation === "turn.stop"
        ? { threadId, expectedTurnId: turnId }
        : { threadId, expectedConfigRevision, text: "task owned" };
    evidence.response = await rpc(operation, evidence.request);
    assert.equal(
      evidence.response.error?.code,
      "TASK_CONTROL_REQUIRED",
      JSON.stringify(evidence.response),
    );
  } catch (error) {
    evidence.failure = { message: error.message, code: error.code };
    throw error;
  } finally {
    // 先取消排队 Run，再中断普通 Turn，避免清理时把 Task 放行成另一轮工作。
    let cleanupError;
    let mayInterrupt = !taskCreationAttempted;
    if (task) {
      try {
        const current = await native("areal/task/read", { taskId: task.id });
        await native("areal/task/cancel", {
          requestId: randomUUID(),
          taskId: task.id,
          expectedRevision: current.revision,
        });
        const settledTask = await waitFor(async () => {
          const value = await native("areal/task/read", { taskId: task.id });
          return value.runs.every(
            (run) =>
              ["completed", "failed", "cancelled"].includes(run.status) &&
              run.workers.every((worker) => worker.settled),
          )
            ? value
            : null;
        }, "cancelled queued Task Run settled");
        evidence.cleanup.push({ task: settledTask });
        mayInterrupt = true;
      } catch (error) {
        cleanupError = error;
        evidence.cleanup.push({ taskError: error.message });
      }
    }
    if (turnId && mayInterrupt) {
      try {
        await native("turn/interrupt", { threadId, turnId });
        await waitFor(
          async () => (await native("thread/read", { threadId })).thread.status.type === "idle",
          "ownership held Turn idle",
        );
        evidence.cleanup.push({ threadId, turnId, settled: true });
      } catch (error) {
        cleanupError ??= error;
        evidence.cleanup.push({ turnError: error.message });
      }
    }
    if (turnId && !mayInterrupt)
      evidence.cleanup.push({
        threadId,
        turnId,
        heldForOuterCleanup: true,
        resourcesUncertain: true,
        reason: "Task cancellation and Run/worker settlement were not confirmed",
      });
    if (!evidence.failure) assert.ifError(cleanupError);
  }
}

// 原工具取消后保留 UNKNOWN；Turn 终态并不证明 Runtime 资源已经清理。
function assertUnknownSettlement(original, settledTurn) {
  assert.equal(settledTurn.id, original.id);
  assert.equal(settledTurn.status, "failed");
  assert.match(settledTurn.error.message, /UNKNOWN tool outcome/);
  const before = original.items.filter(
    (item) => item.type === "dynamicToolCall" && item.tool === "run_command",
  );
  const after = settledTurn.items.filter(
    (item) => item.type === "dynamicToolCall" && item.tool === "run_command",
  );
  assert.equal(before.length, 1);
  assert.equal(after.length, 1);
  assert.equal(after[0].id, before[0].id);
  for (const key of ["runtimeEpoch", "scopeId", "operationId"]) {
    assert.ok(before[0].execution[key]);
    assert.equal(after[0].execution[key], before[0].execution[key]);
  }
  assert.equal(after[0].status, "failed");
  assert.equal(after[0].success, false);
  assert.equal(after[0].execution.outcome, "unknown");
  assert.equal(after[0].execution.inspection, undefined);
  const result = JSON.parse(after[0].contentItems.find((item) => item.type === "inputText").text);
  assert.equal(result.error.code, "UNAVAILABLE");
  assert.equal(result.error.message, "interrupted tool invocation; outcome is UNKNOWN");
}

// 相同参数的新 Turn 仍须绑定自身交互；forced approval 的 pending 状态不证明没有记忆授权。
async function repeatPendingApproval(original, startInteraction, deny) {
  const repeated = await startInteraction(
    "approval",
    "RC07_LARGE",
    original.threadId,
    original.effect,
  );
  assert.equal(repeated.threadId, original.threadId);
  assert.notEqual(repeated.turnId, original.turnId);
  assert.equal(repeated.item.status, "pending");
  assert.deepEqual(repeated.item.effectiveArguments, original.item.effectiveArguments);
  assert.deepEqual(repeated.item.effectivePermissions, original.item.effectivePermissions);
  assert.equal(repeated.item.threadId, repeated.threadId);
  assert.equal(repeated.item.turnId, repeated.turnId);
  assert.notEqual(repeated.item.requestId, original.item.requestId);
  assert.match(repeated.item.argumentsDigest, /^[a-f0-9]{64}$/);
  assert.notEqual(repeated.item.argumentsDigest, original.item.argumentsDigest);
  await deny(repeated);
  return {
    threadId: repeated.threadId,
    turnId: repeated.turnId,
    interactionId: repeated.item.requestId,
    argumentsDigest: repeated.item.argumentsDigest,
    pending: true,
    deniedWithoutEffect: true,
  };
}

// forced approval 即使存在记忆授权也会提示；必须直接比较 Core 的 session/project 授权集合。
async function rejectRememberedDecision({ native, rpc, threadId, params, decision, evidence }) {
  const readGrants = async () => {
    const value = await native("areal/permissions/read", { threadId });
    assert.ok(value.session === null || Array.isArray(value.session));
    assert.ok(Array.isArray(value.project));
    const ordered = (grants) =>
      (grants ?? []).slice().sort((left, right) => left.key.localeCompare(right.key));
    return { session: ordered(value.session), project: ordered(value.project) };
  };
  evidence.decision = decision;
  evidence.threadId = threadId;
  evidence.before = await readGrants();
  evidence.response = await rpc("interaction.respond", { ...params, decision });
  evidence.after = await readGrants();
  assert.equal(evidence.response.error?.code, "INVALID_PARAMS");
  assert.deepEqual(
    evidence.after,
    evidence.before,
    "forbidden decision changed authoritative grants",
  );
}

if (process.argv[2] === "--host-worker") {
  // 仅父测试进程提供隔离目录；真实远程请求不拥有这些测试控制能力。
  const options = JSON.parse(process.env.RC05_HOST_OPTIONS);
  const backend = new CoreBackend(options);
  // This Node fixture has no native Browser adapter. Keep client-owned Browser
  // tools out of its real Core Threads; Electron Browser compatibility has a
  // separate production-adapter E2E.
  backend.supportsBrowser = () => false;
  await backend.init();
  const projectId = backend.saved[0]?.id ?? (await backend.addProject(options.workspace));
  const project = await backend.start(projectId);
  // Core 服务独立于 worker 存活；先移交清理所有权，再执行可能失败的远程初始化。
  await new Promise((resolve, reject) => {
    process.send({ event: "service-started", projectId, service: project.service }, (error) =>
      error ? reject(error) : resolve(),
    );
  });
  const service = new DesktopService(backend, "rc05-native-fixture");
  const remote = (service.remote = new RemoteControl(service, encryptionFixture));
  await remote.init();
  const endpoint = await initializeConformanceHost(remote, transport, options.remoteTransport);
  let fault = null,
    dispatches = 0,
    lastCreateProfile = null,
    releaseStop,
    stopHeld = false,
    releaseInteraction,
    interactionHeld = false,
    releaseTaskReply,
    taskReplyHeld = false,
    releaseTaskPause,
    taskPauseHeld = false;
  const save = backend.save.bind(backend);
  backend.save = async (name, value) => {
    if (fault === "pending-write" && name.endsWith("-pending.json") && value.length) {
      fault = null;
      throw new Error("fixture pending failure");
    }
    if (fault === "outcome-write" && name.endsWith("-outcomes.json")) {
      fault = null;
      throw new Error("fixture outcome failure");
    }
    return save(name, value);
  };
  const native = project.client.request.bind(project.client);
  project.client.request = async (method, params) => {
    if (method === "turn/interrupt" && fault === "hold-stop-before-native") {
      fault = null;
      stopHeld = true;
      await new Promise((resolve) => {
        releaseStop = resolve;
      });
      stopHeld = false;
    }
    if (method === "areal/interaction/respond" && fault === "hold-interaction-before-native") {
      fault = null;
      interactionHeld = true;
      await new Promise((resolve) => {
        releaseInteraction = resolve;
      });
      interactionHeld = false;
    }
    if (method === "areal/task/pause" && fault === "hold-task-pause-before-native") {
      fault = null;
      taskPauseHeld = true;
      await new Promise((resolve) => {
        releaseTaskPause = resolve;
      });
      taskPauseHeld = false;
    }
    if (method === "areal/channel/reply" && fault === "hold-task-reply-before-native") {
      fault = null;
      taskReplyHeld = true;
      await new Promise((resolve) => {
        releaseTaskReply = resolve;
      });
      taskReplyHeld = false;
    }
    if (
      [
        "areal/thread/start",
        "areal/turn/start",
        "turn/interrupt",
        "areal/interaction/respond",
        "areal/channel/reply",
        "areal/task/pause",
      ].includes(method)
    )
      dispatches++;
    if (method === "areal/thread/start")
      lastCreateProfile = structuredClone(params.agentProfile ?? null);
    const result = await native(method, params);
    if (
      [
        "areal/thread/start",
        "areal/turn/start",
        "turn/interrupt",
        "areal/interaction/respond",
        "areal/channel/reply",
        "areal/task/pause",
      ].includes(method)
    ) {
      if (fault === "crash-after-accept") {
        process.send({ event: "crash-after-accept", requestId: params.requestId });
        process.exit(88);
      }
      if (fault === "lost-native-response") {
        fault = null;
        throw Object.assign(new Error("fixture lost response"), { submissionUnknown: true });
      }
    }
    return result;
  };
  process.on("message", async (message) => {
    try {
      let result;
      if (message.method === "fault") {
        fault = message.params;
        result = true;
      } else if (message.method === "interaction-held") result = interactionHeld;
      else if (message.method === "release-interaction") {
        releaseInteraction();
        result = true;
      } else if (message.method === "stop-held") result = stopHeld;
      else if (message.method === "release-stop") {
        releaseStop();
        result = true;
      } else if (message.method === "task-reply-held") result = taskReplyHeld;
      else if (message.method === "release-task-reply") {
        releaseTaskReply();
        result = true;
      } else if (message.method === "task-pause-held") result = taskPauseHeld;
      else if (message.method === "release-task-pause") {
        releaseTaskPause();
        result = true;
      } else if (message.method === "dispatches") result = dispatches;
      else if (message.method === "profile") {
        backend.defaultProfile = structuredClone(message.params);
        project.resourceProfile = structuredClone(message.params);
        result = structuredClone(project.resourceProfile);
      } else if (message.method === "last-create-profile") result = lastCreateProfile;
      else if (message.method === "control") result = await remote.control(message.params);
      else if (message.method === "foreign-project") {
        const id = await backend.addProject(join(options.workspace, "foreign"));
        const foreign = await backend.start(id);
        result = { projectId: id, service: foreign.service };
      } else if (message.method === "native")
        result = await native(message.params.method, message.params.params);
      else if (message.method === "offline") {
        project.client.close();
        project.model.connection(false);
        project.reconnectBlocked = true;
        clearTimeout(project.reconnectTimer);
        result = true;
      } else if (message.method === "stop") {
        service.close();
        await backend.disconnect();
        process.send({ id: message.id, result: true });
        process.exit(0);
      } else throw new Error("Unknown fixture control");
      process.send({ id: message.id, result });
    } catch (error) {
      process.send({ id: message.id, error: { message: error.message, code: error.code } });
    }
  });
  process.send({
    event: "ready",
    projectId,
    ...endpoint,
    transport,
    generation: project.service.generation,
    service: project.service,
  });
} else {
  if (process.env.AREAL_REMOTE_NATIVE_ALLOWED !== "1")
    throw new Error(
      "Native tests require AREAL_REMOTE_NATIVE_ALLOWED=1 after the native launch blocker is cleared",
    );
  const binary = process.env.AREAL_CORE_BIN;
  if (!binary) throw new Error("AREAL_CORE_BIN must identify the reviewed immutable native bundle");
  const taskPauseOnly = process.env.RC09_TASK_PAUSE_ONLY === "1";
  const reviewOnly = process.env.RC10_REVIEW_ONLY === "1";
  const taskQuestionsOnly = process.env.RC08_TASK_QUESTIONS_ONLY === "1";
  const stopOnly = process.env.RC06_STOP_ONLY === "1";
  const interactionOnly = process.env.RC07_INTERACTIONS_ONLY === "1";
  const preflightOnly = process.env.RC05_PREFLIGHT_ONLY === "1";
  const settlementOnly = process.env.RC06_SETTLEMENT_ONLY === "1";
  const interactionSettlementOnly = process.env.RC07_SETTLEMENT_ONLY === "1";
  assert.ok(
    [
      reviewOnly,
      taskQuestionsOnly,
      taskPauseOnly,
      stopOnly,
      interactionOnly,
      preflightOnly,
      settlementOnly,
      interactionSettlementOnly,
    ].filter(Boolean).length <= 1,
    "Select one frozen native milestone",
  );
  let completedRaceIterations = 0;
  const repetitions =
    reviewOnly || taskQuestionsOnly || preflightOnly || settlementOnly || interactionSettlementOnly
      ? 0
      : Number(
          (taskPauseOnly
            ? process.env.RC09_RACE_REPETITIONS
            : interactionOnly
              ? process.env.RC07_RACE_REPETITIONS
              : process.env.RC05_RACE_REPETITIONS) ?? 100,
        );
  assert.ok(
    Number.isInteger(repetitions) &&
      repetitions >=
        (reviewOnly ||
        taskQuestionsOnly ||
        preflightOnly ||
        settlementOnly ||
        interactionSettlementOnly
          ? 0
          : 1) &&
      repetitions <= 100,
  );
  const scratch = await makeTempDir("rc05-native-");
  const workspace = join(scratch, "workspace"),
    home = join(scratch, "desktop"),
    userHome = join(scratch, "user"),
    registry = join(scratch, "registry");
  await mkdir(join(workspace, "effects"), { recursive: true });
  if (taskQuestionsOnly) await mkdir(join(workspace, "foreign"));
  await mkdir(home);
  await mkdir(join(userHome, ".areal"), { recursive: true });
  let modelRequests = 0;
  const held = new Set();
  const taskModels = new Map();
  const reviewEvidence = { cases: [] };
  const taskPauseEvidence = { races: [] };
  const taskQuestionEvidence = { cases: [], model: [] };
  const model = createServer(async (req, res) => {
    const chunks = [];
    for await (const part of req) chunks.push(part);
    const body = JSON.parse(Buffer.concat(chunks));
    modelRequests++;
    if (req.url === "/v1/responses") {
      const input = Array.isArray(body.input)
        ? body.input.findLast((item) => item.role === "user")?.content
        : body.input;
      const marker = JSON.stringify(input).match(/RC10_MEDIA:(PNG|HTML|HUGE)/);
      assert.ok(marker, "isolated RC10 Responses fixture");
      let bytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      );
      if (marker[1] === "HTML") bytes = Buffer.from("<html><script>external()</script></html>");
      if (marker[1] === "HUGE") {
        bytes = Buffer.from(bytes);
        bytes.writeUInt32BE(20000, 16);
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        [
          { type: "response.output_text.delta", delta: "RC10_MEDIA_RESULT" },
          {
            type: "response.output_item.done",
            item: { type: "image_generation_call", result: bytes.toString("base64") },
          },
          ...(marker[1] === "PNG"
            ? [
                {
                  type: "response.output_item.done",
                  item: { type: "image_generation_call", result: bytes.toString("base64") },
                },
              ]
            : []),
          {
            type: "response.completed",
            response: { status: "completed", usage: { input_tokens: 3, output_tokens: 2 } },
          },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
      );
      return;
    }
    // 历史包含已结束 Turn；标记和工具结算只属于最后一个用户输入之后的当前 Turn。
    const userIndex = body.messages.findLastIndex((message) => message.role === "user");
    const currentMessages = userIndex < 0 ? [] : body.messages.slice(userIndex);
    const prompt = JSON.stringify(currentMessages[0]?.content ?? "");
    const textMessages = body.messages.map((message) =>
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content.map((part) => part.text ?? "").join("\n")
          : "",
    );
    const extractTaskContext = (prefix) =>
      textMessages
        .toReversed()
        .map((value) => {
          try {
            return JSON.parse(value.split(prefix)[1]);
          } catch {
            return null;
          }
        })
        .find(Boolean);
    const taskGoal = extractTaskContext("Current authoritative goal: ");
    const rc09Worker =
      textMessages.some((text) => text.includes("You are a TaskRun worker.")) &&
      textMessages.join("\n").match(/RC09_WORKER:([a-f0-9-]{36})/);
    const rc09Goal = String(taskGoal?.goal?.objective ?? "").match(
      /RC09_(RACE|WORK):([a-f0-9-]{36})/,
    );
    if (rc09Worker || rc09Goal) {
      const channel = extractTaskContext("Current task channel: ");
      const key = rc09Worker ? `worker:${rc09Worker[1]}` : `rc09:${channel?.runId ?? rc09Goal[2]}`;
      const stage = taskModels.get(key) ?? 0;
      taskModels.set(key, stage + 1);
      let name, args;
      if (rc09Worker && stage === 0) {
        name = "run_command";
        args = {
          command: `trap 'sleep 2; exit 0' TERM; printf ready >> '${join(workspace, "effects", rc09Worker[1])}'; while :; do sleep 1; done`,
          timeoutMs: 120000,
        };
      } else if (!rc09Worker && rc09Goal[1] === "WORK" && stage === 0) {
        name = "task_spawn";
        args = { prompt: `RC09_WORKER:${rc09Goal[2]} Execute assigned tool and return` };
      } else if (!rc09Worker && rc09Goal[1] === "WORK" && stage === 1) {
        name = "task_wait";
        args = {};
      } else if (!rc09Worker && rc09Goal[1] === "RACE" && stage === 0) {
        name = "goal_update";
        args = {
          expectedRevision: taskGoal.revision,
          status: "complete",
          summary: "completed original Run",
          evidence: ["native model fixture"],
          remaining: [],
        };
      }
      const delta = name
        ? {
            tool_calls: [
              {
                index: 0,
                id: randomUUID(),
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          }
        : { content: "RC09_DONE" };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: name ? "tool_calls" : "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    const taskMarker = String(taskGoal?.goal?.objective ?? "").match(/RC08_TASK:([a-f0-9-]{36})/);
    if (taskMarker) {
      const effect = taskMarker[1],
        text = taskGoal.goal.objective;
      const state = taskModels.get(effect) ?? { stage: 0, answered: false, reported: false };
      taskModels.set(effect, state);
      const goal = taskGoal;
      const channel = extractTaskContext("Current task channel: ");
      const answer = channel?.messages?.find((message) => message.kind === "reply")?.answers;
      let name, args;
      if (state.stage === 0) {
        name = "ask_user_question";
        args = {
          questions: [
            {
              id: "choice",
              title: "Native Task choice",
              options: ["A", "B"],
              allowFreeText: false,
            },
            { id: "free", title: "Native Task free text", options: [], allowFreeText: true },
          ],
          mode: "async",
          required: !text.includes("RC08_TERMINAL"),
          timeoutSeconds: text.includes("RC08_EXPIRE") ? 1 : 600,
        };
        state.stage++;
      } else if (state.stage === 1) {
        name = "run_command";
        args = {
          command: `printf x >> '${join(workspace, "effects", effect + "-pending")}'; while [ ! -f '${join(workspace, "effects", effect + "-release")}' ]; do sleep 0.05; done; printf y >> '${join(workspace, "effects", effect + "-work")}'`,
          timeoutMs: 120000,
        };
        state.stage++;
      } else if (answer && !state.answered) {
        assert.ok(["A", "B"].includes(answer.choice));
        state.answered = true;
        taskQuestionEvidence.model.push({
          effect,
          taskId: channel.taskId,
          runId: channel.runId,
          answers: answer,
        });
        name = "run_command";
        args = {
          command: `printf '${answer.choice}' >> '${join(workspace, "effects", effect + "-reply")}'`,
        };
      } else if (!answer && !text.includes("RC08_TERMINAL") && state.stage === 2) {
        name = "task_wait";
        args = {};
        state.stage++;
      } else if (!state.reported) {
        assert.ok(Number.isSafeInteger(goal?.revision), "native Task authoritative goal context");
        name = "goal_update";
        args = {
          expectedRevision: goal.revision,
          status: "complete",
          summary: "Task fixture complete",
          evidence: ["native Runtime useful work and original Channel checked"],
          remaining: [],
        };
        state.reported = true;
      }
      const delta = name
        ? {
            tool_calls: [
              {
                index: 0,
                id: randomUUID(),
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          }
        : { content: "RC08_DONE" };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: name ? "tool_calls" : "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    const reviewMarker = prompt.match(/RC10_(REVIEW|FAILED):([a-f0-9-]{36})/);
    if (reviewMarker) {
      const count = currentMessages.filter((message) => message.role === "tool").length;
      if (reviewMarker[1] === "FAILED" && count) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: "RC10 deterministic original Turn failure",
              type: "invalid_request_error",
            },
          }),
        );
        return;
      }
      const tool =
        reviewMarker[1] === "FAILED"
          ? count === 0
            ? "fs_read"
            : null
          : count < 2
            ? "fs_create"
            : null;
      const args =
        tool === "fs_read"
          ? { path: `workspace://repo/effects/rc10-z-${reviewMarker[2]}.txt` }
          : {
              path: `workspace://repo/effects/rc10-${count === 0 ? "z" : "a"}-${reviewMarker[2]}.txt`,
              text: count === 0 ? "Z original\n" : "A original\n",
            };
      const delta = tool
        ? {
            content: "RC10 partial output",
            tool_calls: [
              {
                index: 0,
                id: randomUUID(),
                type: "function",
                function: { name: tool, arguments: JSON.stringify(args) },
              },
            ],
          }
        : {
            content:
              '<img src="https://invalid.example/x" onerror="external()">' +
              "历史输出".repeat(6000),
          };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    const marker = prompt.match(/RC05_EFFECT:([a-f0-9-]{36})/);
    const cleanupMarker = prompt.match(/RC06_CLEANUP:([a-f0-9-]{36})/);
    const approvalMarker = prompt.match(/RC07_APPROVAL:([a-f0-9-]{36})/);
    const questionMarker = prompt.match(/RC07_QUESTION:([a-f0-9-]{36})/);
    const hasTool = currentMessages.some((message) => message.role === "tool");
    if ((approvalMarker || questionMarker) && !hasTool) {
      const name = questionMarker ? "ask_user_question" : "run_command";
      const args = questionMarker
        ? {
            questions: [
              {
                id: "choice",
                title: "Native Core choice",
                options: ["A", "B"],
                allowFreeText: false,
              },
              { id: "free", title: "Native Core free text", options: [], allowFreeText: true },
            ],
            timeoutSeconds: prompt.includes("RC07_EXPIRE") ? 5 : 600,
          }
        : {
            command: `printf x >> '${join(workspace, "effects", approvalMarker[1])}'`,
          };
      if (
        approvalMarker &&
        (prompt.includes("RC07_LARGE") || prompt.includes("RC07_EXECUTABLE_LARGE"))
      ) {
        const argumentBytes = prompt.includes("RC07_LARGE") ? 64 * 1024 : 48 * 1024;
        args.command += " # ";
        args.command += "x".repeat(argumentBytes - Buffer.byteLength(JSON.stringify(args)));
        assert.equal(
          Buffer.byteLength(JSON.stringify(args)),
          argumentBytes,
          "bounded native model argument fixture",
        );
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    if (prompt.includes("RC05_HOLD")) {
      held.add(res);
      res.on("close", () => held.delete(res));
      return;
    }
    const delta =
      (marker || cleanupMarker) && !hasTool
        ? {
            tool_calls: [
              {
                index: 0,
                id: "rc05-tool",
                type: "function",
                function: {
                  name: "run_command",
                  arguments: JSON.stringify({
                    command: cleanupMarker
                      ? `trap 'sleep 1; exit 0' TERM; printf ready >> '${join(workspace, "effects", cleanupMarker[1])}'; while :; do sleep 1; done`
                      : `printf x >> '${join(workspace, "effects", marker[1])}'`,
                  }),
                },
              },
            ],
          }
        : { content: "RC05_DONE" };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: (marker || cleanupMarker) && !hasTool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  await writeFile(
    join(userHome, ".areal", "config.toml"),
    `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`,
  );
  if (reviewOnly)
    await writeFile(
      join(userHome, ".areal", "config.toml"),
      (await readFile(join(userHome, ".areal", "config.toml"), "utf8")) +
        `[model.providers.fixture-media]\nprotocol="responses"\nendpoint="http://127.0.0.1:${model.address().port}/v1/responses"\nmodels=[{id="fixture"}]\n`,
    );
  const deployment = join(scratch, "desktop.json");
  await writeFile(
    deployment,
    JSON.stringify({
      profiles: [
        {
          id: "fixture",
          revision: "v1",
          displayName: "Fixture",
          instructions: "Execute requested tool, then complete.",
        },
        {
          id: "approval",
          revision: "v1",
          displayName: "Native approval fixture",
          instructions: "Execute requested tool, then complete.",
          approvalTools: ["run_command"],
        },
        {
          id: "flow",
          revision: "v1",
          displayName: "Flow",
          instructions: "",
          workflow: { id: "flow", revision: "v1" },
        },
      ],
      workflows: [
        {
          id: "flow",
          revision: "v1",
          displayName: "Flow",
          plan: { objective: "fixture", tasks: [{ id: "one", instruction: "run", writes: [] }] },
        },
      ],
    }),
  );
  const hostIdentity = await createIdentity(),
    deviceA = await createIdentity(),
    deviceB = await createIdentity();
  await writeFile(
    join(home, "remote.json"),
    JSON.stringify({
      encrypted: Buffer.from(
        JSON.stringify({
          identity: hostIdentity,
          enabled: false,
          directEnabled: transport === "direct",
          deviceGrants: [],
        }),
      ).toString("base64"),
    }),
  );
  const options = {
    binary,
    home,
    userHome,
    harnessHome: registry,
    desktopConfig: deployment,
    defaultProfile: { id: "fixture", revision: "v1" },
    workspace,
  };
  let transportFixture,
    transportFailureEvidence,
    phase = "transport-start",
    worker,
    browser,
    browserPage,
    browserLayoutSafe = false,
    host,
    workerSequence = 0,
    passed = false;
  const waiting = new Map(),
    connections = new Set(),
    instances = new Map(),
    hostWorkers = [],
    ownedProcesses = new Map(),
    checks = [],
    phaseErrors = [],
    recentRpcOutcomes = [],
    requiredUnrun = [],
    taskOwnershipEvidence = {},
    settlementEvidence = {},
    interactionEvidence = { maximumReview: {}, executableReview: {} };
  const control = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++workerSequence;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`Host control timeout: ${method}`));
      }, 30000);
      waiting.set(id, { resolve, reject, timer });
      worker.send({ id, method, params });
    });
  // 只记录本次父进程和实际 service descriptor 的后代；不按名称寻找或终止用户进程。
  function recordOwnedProcesses() {
    const roots = new Map([[process.pid, "harness"]]);
    for (const child of hostWorkers) roots.set(child.pid, "node-host");
    for (const instance of instances.values()) {
      roots.set(instance.hostPid, "service-host");
      roots.set(instance.corePid, "core");
    }
    const rows = execFileSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" })
      .split("\n")
      .flatMap((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
        return match
          ? [{ pid: Number(match[1]), parentPid: Number(match[2]), executable: basename(match[3]) }]
          : [];
      });
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (roots.has(row.pid) || !roots.has(row.parentPid)) continue;
        if (row.executable === "ps") continue;
        roots.set(
          row.pid,
          /runtime/i.test(row.executable)
            ? "runtime"
            : /Chrome|Chromium/i.test(row.executable)
              ? "browser"
              : "owned-child",
        );
        changed = true;
      }
    }
    for (const row of rows)
      if (roots.has(row.pid) && row.pid !== process.pid)
        ownedProcesses.set(row.pid, { ...row, role: roots.get(row.pid) });
  }
  async function startHost() {
    worker = fork(filename, ["--host-worker"], {
      env: {
        ...process.env,
        ...transportFixture.childEnv,
        RC05_HOST_OPTIONS: JSON.stringify(options),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const hostWorker = { pid: worker.pid, exited: false };
    hostWorkers.push(hostWorker);
    worker.once("exit", (code, signal) =>
      Object.assign(hostWorker, { exited: true, code, signal }),
    );
    let logs = "";
    worker.stdout.on("data", (data) => (logs += data));
    worker.stderr.on("data", (data) => (logs += data));
    worker.on("exit", () => {
      for (const entry of waiting.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("Host exited"));
      }
      waiting.clear();
    });
    host = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Host startup timed out: ${logs}`)), 30000);
      worker.on("message", (message) => {
        if (message.event === "service-started") {
          instances.set(message.service.serviceId, message.service);
          return;
        }
        if (message.event === "ready") {
          clearTimeout(timer);
          resolve(message);
          return;
        }
        const entry = waiting.get(message.id);
        if (!entry) return;
        waiting.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) {
          entry.reject(Object.assign(new Error(message.error.message), message.error));
          return;
        }
        entry.resolve(message.result);
      });
      worker.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Host startup exited ${code}: ${logs}`));
      });
    });
    delete options.remoteTransport?.code;
    recordOwnedProcesses();
  }
  async function connectDevice(identity, pair = false) {
    const invite = pair ? await control("control", { operation: "pair", transport }) : null;
    const socket = new WebSocket(host.ws, {
      origin: host.origin,
      ...transportFixture.socketOptions,
    });
    const { wire, ready: wireReady } = createRemoteWire(socket, { room: host.room });
    await wireReady;
    const secure = await secureChannel(wire, identity, identityId(hostIdentity));
    connections.add(secure);
    const messages = secure.messages();
    secure.send({
      method: "hello",
      apiVersion: "areal.remote.v2",
      clientVersion: "rc05-native",
      displayName: "RC05 fixture",
      ...(invite
        ? { inviteSecret: new URLSearchParams(new URL(invite.payload).hash.slice(1)).get("invite") }
        : {}),
    });
    if (pair) {
      assert.equal((await messages.next()).value.event, "pairing");
      await control("control", {
        operation: "approve",
        id: identityId(identity),
        projects: [host.projectId],
        preset: "Operator",
      });
    }
    const ready = (await messages.next()).value;
    assert.equal(ready.event, "ready");
    let sequence = 0,
      lastRequestAt = 0;
    return {
      secure,
      async rpc(method, params = {}, commandId = randomUUID(), context = {}) {
        if (
          reviewOnly ||
          taskPauseOnly ||
          taskQuestionsOnly ||
          interactionOnly ||
          interactionSettlementOnly
        ) {
          await pause(Math.max(0, 60 - (Date.now() - lastRequestAt)));
          lastRequestAt = Date.now();
        }
        const id = String(++sequence),
          read = [
            "command.read",
            "attention.read",
            "task.question.read",
            "task.read",
            "work.list",
            "review.read",
            "artifact.read",
          ].includes(method);
        secure.send({
          id,
          method,
          ...(!read ? { commandId } : {}),
          context: {
            projectId: host.projectId,
            ...(!read
              ? {
                  gatewayGeneration: ready.gatewayGeneration,
                  grantRevision: ready.grantRevision,
                  serviceGeneration: host.generation,
                }
              : {}),
            ...context,
          },
          params,
        });
        const next = await messages.next();
        recordRpcOutcome(
          recentRpcOutcomes,
          method,
          id,
          method === "command.read" ? params.commandId : read ? null : commandId,
          next.value,
        );
        if (next.done) throw new Error("Host disconnected");
        assert.equal(next.value.id, id);
        return next.value;
      },
    };
  }
  const native = (method, params = {}) => control("native", { method, params });
  const settled = (threadId) =>
    waitFor(
      async () =>
        (await native("thread/read", { threadId, includeTurns: true })).thread.status.type ===
        "idle",
      "native idle",
    );
  try {
    transportFixture = await startConformanceTransport(transport);
    options.remoteTransport = transportFixture.hostOptions;
    phase = "host-start";
    await startHost();
    phase = "device-ready";
    let a = await connectDevice(deviceA, true),
      b = await connectDevice(deviceB, true);
    phase = "business";
    if (
      !reviewOnly &&
      !taskPauseOnly &&
      !taskQuestionsOnly &&
      !stopOnly &&
      !interactionOnly &&
      !settlementOnly &&
      !interactionSettlementOnly
    ) {
      if (!preflightOnly) {
        for (let index = 0; index < repetitions; index++) {
          const commandId = randomUUID();
          await control("fault", "crash-after-accept");
          const exited = once(worker, "exit");
          await assert.rejects(a.rpc("session.create", {}, commandId));
          await exited;
          await startHost();
          a = await connectDevice(deviceA);
          b = await connectDevice(deviceB);
          const recovered = (await a.rpc("command.read", { commandId })).result;
          assert.equal(recovered.admissionState, "accepted");
          const duplicate = (await a.rpc("session.create", {}, commandId)).result;
          assert.equal(duplicate.threadId, recovered.threadId);
          assert.equal(duplicate.operationId, recovered.operationId);
          const threadId = recovered.threadId;
          const effect = randomUUID(),
            sendId = randomUUID(),
            params = { threadId, expectedConfigRevision: 1, text: `RC05_EFFECT:${effect}` };
          await control("fault", "lost-native-response");
          assert.equal(
            (await a.rpc("session.send", params, sendId)).result.admissionState,
            "unknown",
          );
          const receipt = (await a.rpc("command.read", { commandId: sendId })).result;
          assert.equal(receipt.admissionState, "accepted");
          assert.equal((await a.rpc("session.send", params, sendId)).result.turnId, receipt.turnId);
          await settled(threadId);
          assert.equal(await readFile(join(workspace, "effects", effect), "utf8"), "x");
          assert.equal(
            (await a.rpc("session.send", { ...params, text: "changed" }, sendId)).error.code,
            "COMMAND_CONFLICT",
          );
          const independent = (
            await b.rpc("session.send", { ...params, text: "independent" }, sendId)
          ).result;
          assert.equal(independent.admissionState, "accepted");
          assert.notEqual(independent.operationId, receipt.operationId);
          await settled(threadId);
          await control("fault", "pending-write");
          const before = await control("dispatches");
          assert.ok((await a.rpc("session.create")).error);
          assert.equal(await control("dispatches"), before);
          const failedId = randomUUID();
          await control("fault", "outcome-write");
          assert.equal(
            (await a.rpc("session.create", {}, failedId)).result.admissionState,
            "unknown",
          );
          assert.equal(
            (await a.rpc("command.read", { commandId: failedId })).result.admissionState,
            "accepted",
          );
          completedRaceIterations++;
        }
        checks.push({
          case: "T18/T19/T20/T22",
          repetitions,
          detail:
            "actual Host process crash after native create acceptance, original receipt association, exact native send recovery, one Runtime file append, changed semantics, second device scope, pending/outcome write failures",
        });
      }
      await pause(1050);
      const fastThread = (await a.rpc("session.create")).result.threadId;
      const fastBaseline = await native("areal/thread/observe", { threadId: fastThread });
      await native("areal/thread/configure", {
        threadId: fastThread,
        expectedRevision: fastBaseline.thread.desktop.configuration.revision,
        parameters: { serviceTier: "fast", reasoningEffort: "low" },
      });
      const fastConfigured = await native("areal/thread/observe", { threadId: fastThread });
      const effortSaved = await a.rpc("session.control", {
        threadId: fastThread,
        operation: "configure",
        expectedRevision: fastConfigured.thread.desktop.configuration.revision,
        values: { parameters: { reasoningEffort: "high" } },
      });
      assert.equal(effortSaved.result?.admissionState, "accepted", JSON.stringify(effortSaved));
      const fastRetained = await native("areal/thread/observe", { threadId: fastThread });
      assert.equal(fastRetained.thread.desktop.configuration.parameters.serviceTier, "fast");
      assert.equal(fastRetained.thread.desktop.configuration.parameters.reasoningEffort, "high");
      checks.push({
        case: "Fast preservation",
        detail:
          "remote effort changes preserve the desktop Fast setting in authoritative Core configuration",
      });
      // 最后一轮恢复仍复用当前连接；先补足尾段预算，再创建 T21 的目标。
      await pause(1050);
      const created = (await a.rpc("session.create")).result;
      const stale = await a.rpc("session.send", {
        threadId: created.threadId,
        expectedConfigRevision: 0,
        text: "stale",
      });
      assert.equal(stale.error.code, "TARGET_CHANGED");
      assert.deepEqual(await control("profile", { id: "flow", revision: "v1" }), {
        id: "flow",
        revision: "v1",
      });
      const workflow = await a.rpc("session.create");
      const workflowDispatchProfile = await control("last-create-profile");
      assert.deepEqual(workflowDispatchProfile, { id: "flow", revision: "v1" });
      assert.equal(workflow.result.admissionState, "rejected");
      assert.equal(workflow.result.error.code, "UNSUPPORTED_PROFILE");
      await control("profile", { id: "fixture", revision: "v1" });
      const running = (
        await a.rpc("session.send", {
          threadId: created.threadId,
          expectedConfigRevision: 1,
          text: "RC05_HOLD",
        })
      ).result;
      assert.equal(running.admissionState, "accepted");
      const busy = await a.rpc("session.send", {
        threadId: created.threadId,
        expectedConfigRevision: 1,
        text: "must not enqueue",
      });
      assert.equal(busy.error.code, "TURN_BUSY");
      await native("turn/interrupt", { threadId: created.threadId, turnId: running.turnId });
      for (const response of held) response.destroy();
      held.clear();
      await settled(created.threadId);
      await taskOwnedPreflight({
        rpc: (...args) => a.rpc(...args),
        native,
        waitForModel: () => waitFor(() => held.size > 0, "ownership model held"),
        evidence: taskOwnershipEvidence,
      });
      await control("offline");
      assert.ok((await a.rpc("session.create")).error);
      assert.equal(
        (await a.rpc("command.read", { commandId: created.commandId })).result.admissionState,
        "accepted",
      );
      checks.push({
        case: "T21",
        detail:
          "busy, stale config, Task-owned root, Workflow default, offline create and saved-outcome read",
        taskId: taskOwnershipEvidence.createdTask.id,
        workflowDispatchProfile,
      });
    }
    if (stopOnly || settlementOnly) {
      const readTurn = async (threadId, turnId) =>
        (await native("thread/read", { threadId, includeTurns: true })).thread.turns.find(
          (turn) => turn.id === turnId,
        );
      const startTurn = async (threadId, text) =>
        (
          await native("areal/turn/start", {
            requestId: randomUUID(),
            threadId,
            input: [{ type: "text", text }],
            expectedConfigRevision: 1,
          })
        ).turn.id;
      const releaseModel = () => {
        for (const res of held) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.end(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
          );
        }
        held.clear();
      };
      if (!settlementOnly) {
        for (let index = 0; index < repetitions; index++) {
          // 在建目标前留出完整限流窗口；轮内两设备 Stop 必须仍在同一 Promise.all 中竞争。
          await pause(1050);
          const threadId = (await a.rpc("session.create")).result.threadId;
          const turnA = await startTurn(threadId, "RC05_HOLD");
          await waitFor(() => held.size > 0, "A model barrier");
          await control("fault", "hold-stop-before-native");
          const commandId = randomUUID();
          const delayed = a.rpc("turn.stop", { threadId, expectedTurnId: turnA }, commandId);
          await waitFor(() => control("stop-held"), "interrupt dispatch barrier");
          releaseModel();
          await settled(threadId);
          const turnB = await startTurn(threadId, "RC05_HOLD");
          await waitFor(() => held.size > 0, "B model barrier");
          await control("release-stop");
          const refusal = await delayed;
          assert.equal(refusal.result.admissionState, "rejected");
          assert.equal(refusal.result.error.code, "TARGET_CHANGED");
          assert.equal((await readTurn(threadId, turnB)).status, "inProgress");
          const before = await control("dispatches");
          assert.equal(
            (await a.rpc("command.read", { commandId })).result.admissionState,
            "rejected",
          );
          assert.equal(await control("dispatches"), before);
          const params = { threadId, expectedTurnId: turnB };
          const idA = randomUUID(),
            idB = randomUUID();
          await control("fault", "lost-native-response");
          const [lost, second] = await Promise.all([
            a.rpc("turn.stop", params, idA),
            b.rpc("turn.stop", params, idB),
          ]);
          assert.ok([lost, second].some((value) => value.result?.admissionState === "unknown"));
          releaseModel();
          await settled(threadId);
          const unknownDevice = lost.result?.admissionState === "unknown" ? a : b;
          const unknownId = unknownDevice === a ? idA : idB;
          const receipt = (await unknownDevice.rpc("command.read", { commandId: unknownId }))
            .result;
          assert.equal(receipt.admissionState, "unknown");
          assert.equal(receipt.nativeRequestId, undefined);
          const finished = await a.rpc("turn.stop", params);
          assert.equal(finished.error.code, "TARGET_CHANGED");
          completedRaceIterations++;
        }
        checks.push({
          case: "T23",
          repetitions,
          detail:
            "A settles and B starts behind deterministic pre-native interrupt barrier; original A rejected, B remains in progress; no replay",
        });
      }
      const threadId = (await a.rpc("session.create")).result.threadId;
      const marker = randomUUID();
      const turnId = await startTurn(threadId, `RC06_CLEANUP:${marker}`);
      settlementEvidence.runtimeResourcesConfirmedReleased = false;
      settlementEvidence.markerPath = join(workspace, "effects", marker);
      await waitFor(async () => {
        try {
          return (await readFile(join(workspace, "effects", marker), "utf8")) === "ready";
        } catch {
          return false;
        }
      }, "actual Runtime tool started");
      settlementEvidence.original = await readTurn(threadId, turnId);
      assert.equal(settlementEvidence.original.id, turnId);
      assert.equal(settlementEvidence.original.status, "inProgress");
      const originalTools = settlementEvidence.original.items.filter(
        (item) => item.type === "dynamicToolCall" && item.tool === "run_command",
      );
      assert.equal(originalTools.length, 1);
      assert.ok(originalTools[0].id);
      assert.equal(originalTools[0].status, "inProgress");
      assert.equal(originalTools[0].execution.outcome, "running");
      for (const key of ["runtimeEpoch", "scopeId", "operationId"])
        assert.ok(originalTools[0].execution[key]);
      settlementEvidence.target = { threadId, expectedTurnId: turnId };
      const stopResponse = await a.rpc("turn.stop", settlementEvidence.target);
      settlementEvidence.stopResponse = stopResponse;
      const accepted = stopResponse.result;
      assert.equal(accepted.admissionState, "accepted");
      assert.equal(accepted.method, "turn.stop");
      assert.deepEqual(accepted.target, settlementEvidence.target);
      assert.equal(accepted.threadId, threadId);
      assert.equal(accepted.turnId, turnId);
      assert.equal(accepted.nativeRequestId, undefined);
      // Core 原子 guard 确认原活动目标；网络回执后的读取可能已经看到结算。
      settlementEvidence.afterAdmission = await readTurn(threadId, turnId);
      assert.equal(settlementEvidence.afterAdmission.id, turnId);
      if (settlementEvidence.afterAdmission.status !== "inProgress")
        assertUnknownSettlement(settlementEvidence.original, settlementEvidence.afterAdmission);
      settlementEvidence.admissionWitness = "original active read and accepted atomic Core guard";
      settlementEvidence.observationBoundary =
        "separate read after network receipt; cleanup order unproven";
      await settled(threadId);
      settlementEvidence.terminal = await readTurn(threadId, turnId);
      assertUnknownSettlement(settlementEvidence.original, settlementEvidence.terminal);
      settlementEvidence.dispatchesBeforeQueries = await control("dispatches");
      settlementEvidence.savedReceipt = await a.rpc("command.read", {
        commandId: accepted.commandId,
      });
      settlementEvidence.duplicate = await a.rpc(
        "turn.stop",
        settlementEvidence.target,
        accepted.commandId,
      );
      assert.equal(settlementEvidence.savedReceipt.result.admissionState, "accepted");
      assert.equal(settlementEvidence.duplicate.result.admissionState, "accepted");
      settlementEvidence.dispatchesAfterQueries = await control("dispatches");
      assert.equal(
        settlementEvidence.dispatchesAfterQueries,
        settlementEvidence.dispatchesBeforeQueries,
      );
      settlementEvidence.afterQueries = await readTurn(threadId, turnId);
      assertUnknownSettlement(settlementEvidence.original, settlementEvidence.afterQueries);
      settlementEvidence.markerContents = await readFile(
        join(workspace, "effects", marker),
        "utf8",
      );
      assert.equal(
        settlementEvidence.markerContents,
        "ready",
        "original Runtime invocation must append exactly once",
      );
      await taskOwnedPreflight({
        rpc: (...args) => a.rpc(...args),
        native,
        operation: "turn.stop",
        waitForModel: () => waitFor(() => held.size > 0, "ownership model held"),
        evidence: taskOwnershipEvidence,
      });
      await control("offline");
      assert.equal(
        (await a.rpc("command.read", { commandId: accepted.commandId })).result.admissionState,
        "accepted",
      );
      checks.push({
        case: "T24",
        detail:
          "real Runtime Stop admission precedes failed Turn with original tool UNKNOWN; exact single append, saved receipt and duplicate without replay or acknowledgement; actual queued Task-owned refusal and offline receipt",
      });
    }
    if (interactionOnly || interactionSettlementOnly) {
      const target = (item) => ({
        threadId: item.threadId,
        turnId: item.turnId,
        interactionId: item.requestId,
      });
      const readInteraction = async (threadId, turnId) =>
        waitFor(
          async () =>
            (await native("areal/interaction/list", { threadId })).data.find(
              (item) => item.turnId === turnId && item.status === "pending",
            ),
          "native pending interaction",
        );
      const startInteraction = async (kind, extra = "", existingThread, existingEffect) => {
        await control("profile", {
          id: kind === "approval" ? "approval" : "fixture",
          revision: "v1",
        });
        const threadId = existingThread ?? (await a.rpc("session.create")).result.threadId;
        const effect = existingEffect ?? randomUUID();
        const { turn } = await native("areal/turn/start", {
          requestId: randomUUID(),
          threadId,
          input: [
            {
              type: "text",
              text: `RC07_${kind === "approval" ? "APPROVAL" : "QUESTION"}:${effect} ${extra}`,
            },
          ],
          expectedConfigRevision: 1,
        });
        return {
          threadId,
          turnId: turn.id,
          effect,
          item: await readInteraction(threadId, turn.id),
        };
      };
      const review = async (device, item, evidence) => {
        let page = (await device.rpc("attention.read", target(item))).result;
        assert.ok(page, "authoritative detail response");
        let body = page.review.chunk;
        const first = page;
        let pages = 1;
        while (page.nextCursor) {
          const next = await device.rpc("attention.read", {
            ...target(item),
            cursor: page.nextCursor,
          });
          assert.ok(next.result, JSON.stringify(next.error));
          page = next.result;
          assert.equal(page.argumentsDigest, first.argumentsDigest);
          assert.equal(page.review.offset, Buffer.byteLength(body));
          body += page.review.chunk;
          pages++;
        }
        assert.equal(Buffer.byteLength(body), page.review.totalBytes);
        assert.equal(page.complete, true);
        assert.ok(page.reviewToken);
        const content = JSON.parse(body);
        assert.deepEqual(content.effectiveArguments, item.effectiveArguments ?? null);
        assert.deepEqual(content.effectivePermissions, item.effectivePermissions ?? null);
        assert.equal(page.argumentsDigest, item.argumentsDigest ?? null);
        if (evidence)
          Object.assign(evidence, {
            ...target(item),
            argumentsDigest: page.argumentsDigest,
            pages,
            totalBytes: page.review.totalBytes,
            complete: page.complete,
            effectiveArgumentBytes: Buffer.byteLength(JSON.stringify(content.effectiveArguments)),
          });
        return {
          ...target(item),
          ...(item.kind === "approval" ? { argumentsDigest: page.argumentsDigest } : {}),
          reviewToken: page.reviewToken,
        };
      };
      const noEffect = async (effect) =>
        assert.rejects(readFile(join(workspace, "effects", effect)), { code: "ENOENT" });
      const deny = async (value) => {
        const result = await b.rpc("interaction.respond", {
          ...target(value.item),
          argumentsDigest: value.item.argumentsDigest,
          decision: "deny",
        });
        assert.equal(result.result.admissionState, "accepted");
        await settled(value.threadId);
        await noEffect(value.effect);
      };
      if (!interactionSettlementOnly) {
        // 每轮将原 A 的审阅决定卡在真实 Core 调用前，再使 A 失效并创建 B；绝不重定向允许。
        for (let index = 0; index < repetitions; index++) {
          // 在原目标建立前补充写预算，不延迟已持有的决定或替代 Turn。
          await pause(1050);
          const original = await startInteraction("approval");
          const params = { ...(await review(a, original.item)), decision: "allowOnce" };
          await control("fault", "hold-interaction-before-native");
          const commandId = randomUUID(),
            delayed = a.rpc("interaction.respond", params, commandId);
          await waitFor(() => control("interaction-held"), "original respond dispatch barrier");
          if (index % 2 === 0) await deny(original);
          else {
            await native("turn/interrupt", {
              threadId: original.threadId,
              turnId: original.turnId,
            });
            await settled(original.threadId);
            await noEffect(original.effect);
          }
          const replacement = await startInteraction("approval", "", original.threadId);
          await control("release-interaction");
          const refusal = await delayed;
          assert.equal(refusal.result.admissionState, "rejected");
          assert.equal(refusal.result.error.code, "TARGET_CHANGED");
          const pending = await readInteraction(replacement.threadId, replacement.turnId);
          assert.equal(pending.requestId, replacement.item.requestId);
          await noEffect(original.effect);
          await noEffect(replacement.effect);
          const before = await control("dispatches");
          assert.equal(
            (await a.rpc("command.read", { commandId })).result.admissionState,
            "rejected",
          );
          assert.equal(
            (await a.rpc("interaction.respond", params, commandId)).result.admissionState,
            "rejected",
          );
          assert.equal(await control("dispatches"), before);
          await deny(replacement);
          completedRaceIterations++;
        }
        checks.push({
          case: "T25",
          repetitions: completedRaceIterations,
          detail:
            "actual Core original-target arbitration over deterministic competing-deny/Stop then new-Turn races; no original or replacement Runtime file effect, no replay",
        });
      }
      // 新业务块先恢复完整突发预算；块内目标与双设备竞争不额外排队。
      await pause(2100);
      const maximum = await startInteraction("approval", "RC07_LARGE");
      const firstPage = (await a.rpc("attention.read", target(maximum.item))).result;
      assert.equal(firstPage.complete, false);
      const incomplete = {
        ...target(maximum.item),
        argumentsDigest: firstPage.argumentsDigest,
        decision: "allowOnce",
      };
      assert.equal(
        (await a.rpc("interaction.respond", incomplete)).error.code,
        "REVIEW_INCOMPLETE",
      );
      const reviewedMaximum = await review(a, maximum.item, interactionEvidence.maximumReview);
      for (const patch of [
        { argumentsDigest: "f".repeat(64) },
        { turnId: randomUUID() },
        { interactionId: randomUUID() },
      ]) {
        const bad = await a.rpc("interaction.respond", {
          ...reviewedMaximum,
          decision: "allowOnce",
          ...patch,
        });
        assert.equal(bad.error.code, "TARGET_CHANGED");
        await noEffect(maximum.effect);
      }
      interactionEvidence.maximumReview.forbiddenDecisions = [];
      for (const decision of ["allowSession", "allowProject"]) {
        const evidence = {};
        interactionEvidence.maximumReview.forbiddenDecisions.push(evidence);
        await rejectRememberedDecision({
          native,
          rpc: (...args) => a.rpc(...args),
          threadId: maximum.threadId,
          params: reviewedMaximum,
          decision,
          evidence,
        });
        await noEffect(maximum.effect);
      }
      assert.equal(interactionEvidence.maximumReview.effectiveArgumentBytes, 64 * 1024);
      assert.ok(interactionEvidence.maximumReview.pages > 1);
      await deny(maximum);
      const maximumTurn = (
        await native("thread/read", { threadId: maximum.threadId, includeTurns: true })
      ).thread.turns.find((turn) => turn.id === maximum.turnId);
      const maximumTools = maximumTurn.items.filter(
        (item) => item.type === "dynamicToolCall" && item.tool === "run_command",
      );
      assert.equal(maximumTools.length, 1);
      interactionEvidence.maximumReview.originalArgumentBytes = Buffer.byteLength(
        maximumTools[0].execution.originalArguments,
      );
      assert.equal(interactionEvidence.maximumReview.originalArgumentBytes, 64 * 1024);
      interactionEvidence.maximumReview.decision = "deny";
      interactionEvidence.maximumReview.noEffect = true;
      interactionEvidence.maximumReview.repeatedBinding = await repeatPendingApproval(
        maximum,
        startInteraction,
        deny,
      );
      const approved = await startInteraction("approval", "RC07_EXECUTABLE_LARGE");
      const reviewed = await review(a, approved.item, interactionEvidence.executableReview);
      assert.equal(interactionEvidence.executableReview.effectiveArgumentBytes, 48 * 1024);
      assert.ok(interactionEvidence.executableReview.pages > 1);
      const unknownId = randomUUID();
      await control("fault", "lost-native-response");
      const lost = await a.rpc(
        "interaction.respond",
        { ...reviewed, decision: "allowOnce" },
        unknownId,
      );
      interactionEvidence.executableReview.response = lost;
      assert.equal(lost.result.admissionState, "unknown");
      await settled(approved.threadId);
      interactionEvidence.executableReview.markerContents = await readFile(
        join(workspace, "effects", approved.effect),
        "utf8",
      );
      assert.equal(interactionEvidence.executableReview.markerContents, "x");
      const before = await control("dispatches");
      const recovered = (await a.rpc("command.read", { commandId: unknownId })).result;
      interactionEvidence.executableReview.savedReceipt = recovered;
      assert.equal(recovered.admissionState, "unknown");
      assert.equal(recovered.observedState.status, "answered");
      assert.equal(recovered.observedState.provesCommandAdmission, false);
      assert.equal(
        (await a.rpc("interaction.respond", { ...reviewed, decision: "allowOnce" }, unknownId))
          .result.admissionState,
        "unknown",
      );
      assert.equal(await control("dispatches"), before);
      // allowOnce/被拒绝的记忆决定都不能授权下一次同类工具。
      const again = await startInteraction("approval", "", approved.threadId);
      await deny(again);
      checks.push({
        case: "T26",
        detail:
          "exact 64 KiB original/effective arguments fully reviewed then denied without effect; 48 KiB multipage allowOnce appends exactly one byte via Runtime; subsequent approval still pending; lost response stays unknown without replay",
      });
      await pause(2100);
      const question = await startInteraction("question");
      const questionA = await review(a, question.item),
        questionB = await review(b, question.item);
      for (const answers of [
        { choice: "A" },
        { choice: "A", free: "x", extra: "x" },
        { choice: "unknown", free: "x" },
        { choice: "A", free: "界".repeat(1365) + "ab" },
      ])
        assert.equal(
          (await a.rpc("interaction.respond", { ...questionA, answers })).error.code,
          "INVALID_PARAMS",
        );
      const valid = { choice: "A", free: "界".repeat(1365) + "a" };
      assert.equal(Buffer.byteLength(valid.free), 4096);
      const [one, two] = await Promise.all([
        a.rpc("interaction.respond", { ...questionA, answers: valid }),
        b.rpc("interaction.respond", {
          ...questionB,
          answers: { choice: "B", free: "other device" },
        }),
      ]);
      assert.equal(
        [one, two].filter((value) => value.result?.admissionState === "accepted").length,
        1,
      );
      assert.equal(
        [one, two].filter(
          (value) =>
            value.result?.admissionState === "rejected" || value.error?.code === "TARGET_CHANGED",
        ).length,
        1,
      );
      await settled(question.threadId);
      const finalQuestion = (
        await native("areal/interaction/list", { threadId: question.threadId })
      ).data.find((item) => item.requestId === question.item.requestId);
      assert.equal(finalQuestion.status, "answered");
      assert.deepEqual(Object.keys(finalQuestion.response.answers).sort(), ["choice", "free"]);
      const expired = await startInteraction("question", "RC07_EXPIRE");
      const expiring = await review(a, expired.item);
      await settled(expired.threadId);
      assert.equal(
        (
          await a.rpc("interaction.respond", {
            ...expiring,
            answers: { choice: "A", free: "late" },
          })
        ).error.code,
        "TARGET_CHANGED",
      );
      checks.push({
        case: "T27",
        detail:
          "actual Core questions/options, exact keys, 4096/4097 multibyte boundaries, two-device single native answer, expired original question",
      });
    }
    if (taskQuestionsOnly) {
      const channel = (taskId) => native("areal/channel/read", { taskId, limit: 100 });
      const file = (effect, suffix) => join(workspace, "effects", `${effect}-${suffix}`);
      const contents = async (path) => {
        try {
          return await readFile(path, "utf8");
        } catch (error) {
          if (error.code === "ENOENT") return null;
          throw error;
        }
      };
      const target = (item) => ({
        taskId: item.taskId,
        runId: item.runId,
        questionId: item.questionId,
      });
      const answers = { choice: "B", free: "exact native answer" };
      const startTask = async (extra = "") => {
        const effect = randomUUID();
        const created = await native("areal/task/create", {
          requestId: randomUUID(),
          mode: "background",
          objective: `RC08_TASK:${effect} ${extra}`,
          interactionMode: "asynchronous",
          maxTurns: 8,
        });
        const question = await waitFor(async () => {
          const page = await channel(created.id);
          return page.data.find((item) => item.kind === "question" && item.status === "pending");
        }, "native Task question");
        await waitFor(
          async () => (await contents(file(effect, "pending"))) === "x",
          "Runtime useful work while question pending",
        );
        const task = await native("areal/task/read", { taskId: created.id });
        const run = task.runs.find((run) => run.id === question.runId);
        assert.equal(run.status, "running");
        const questionNow = (await channel(created.id)).data.find(
          (item) => item.id === question.id,
        );
        assert.equal(questionNow.status, "pending");
        assert.equal(
          await contents(file(effect, "work")),
          null,
          "independent work remains active behind Runtime barrier",
        );
        const item = {
          effect,
          taskId: created.id,
          runId: run.id,
          questionId: question.id,
          threadId: run.threadId,
        };
        taskQuestionEvidence.cases.push({
          kind: "pending-with-useful-work",
          ...item,
          question: questionNow,
          run,
        });
        return item;
      };
      const releaseWork = (item) => writeFile(file(item.effect, "release"), "release");
      const waitingTask = async (item) => {
        await releaseWork(item);
        return waitFor(async () => {
          const task = await native("areal/task/read", { taskId: item.taskId });
          return task.runs.find((run) => run.id === item.runId)?.status === "waitingForInput"
            ? task
            : null;
        }, "native Task waits after useful work");
      };
      const completedTask = async (item) => {
        await releaseWork(item);
        const task = await waitFor(
          async () => {
            const task = await native("areal/task/read", { taskId: item.taskId });
            return task.runs.find((run) => run.id === item.runId)?.status === "completed"
              ? task
              : null;
          },
          "original native Task Run completes",
          30000,
        );
        assert.equal(task.runs.length, 1);
        assert.equal(task.runs[0].id, item.runId);
        assert.equal(await contents(file(item.effect, "pending")), "x");
        assert.equal(await contents(file(item.effect, "work")), "y");
        assert.equal(await contents(file(item.effect, "reply")), "B");
        const replies = (await channel(item.taskId)).data.filter(
          (message) => message.kind === "reply" && message.inReplyTo === item.questionId,
        );
        assert.equal(replies.length, 1);
        assert.deepEqual(replies[0].answers, answers);
        return { task, replies };
      };
      const cancelTask = async (item) => {
        await releaseWork(item);
        await waitFor(
          async () => {
            const task = await native("areal/task/read", { taskId: item.taskId });
            const state = task.runs.find((run) => run.id === item.runId)?.status;
            const thread = (await native("thread/read", { threadId: item.threadId })).thread;
            return (
              ["paused", "waitingForInput", "completed", "failed", "cancelled"].includes(state) &&
              thread.status.type === "idle"
            );
          },
          "Task useful work settles before cancellation",
          30000,
        );
        const task = await native("areal/task/read", { taskId: item.taskId });
        await native("areal/task/cancel", {
          requestId: randomUUID(),
          taskId: item.taskId,
          expectedRevision: task.revision,
        });
        await releaseWork(item);
        await waitFor(
          async () => {
            const task = await native("areal/task/read", { taskId: item.taskId });
            return task.runs.every(
              (run) =>
                ["completed", "failed", "cancelled"].includes(run.status) &&
                run.workers.every((worker) => worker.settled),
            );
          },
          "Task cancellation cleanup",
          30000,
        );
      };
      const refused = (response) =>
        assert.ok(
          response.error || response.result?.admissionState === "rejected",
          JSON.stringify(response),
        );
      const restartHost = async () => {
        const exited = once(worker, "exit");
        await control("stop");
        await exited;
        await startHost();
        a = await connectDevice(deviceA);
        b = await connectDevice(deviceB);
      };

      const live = await startTask();
      const detail = (await a.rpc("task.question.read", target(live))).result;
      assert.equal(detail.complete, true);
      assert.equal(detail.kind, "asyncQuestion");
      assert.equal(detail.runStatus, "running");
      assert.equal(detail.questions[0].title, "Native Task choice");
      assert.deepEqual(detail.questions[0].options, ["A", "B"]);
      const overview = (await a.rpc("work.list", { filter: "attention" })).result;
      assert.ok(
        overview.data.some(
          (row) =>
            row.taskId === live.taskId &&
            row.runId === live.runId &&
            row.attentionRefs.some((ref) => ref.questionId === live.questionId),
        ),
      );
      const beforeThreads = (await native("thread/list", { limit: 100 })).data
        .map((thread) => thread.id)
        .sort();
      for (const mismatch of [
        { taskId: randomUUID() },
        { runId: randomUUID() },
        { questionId: randomUUID() },
      ])
        refused(await a.rpc("task.question.reply", { ...target(live), ...mismatch, answers }));
      for (const invalid of [
        { choice: "C", free: "ok" },
        { choice: "B" },
        { choice: "B", free: " " },
        { choice: "B", free: "界".repeat(1366) },
      ])
        assert.equal(
          (await a.rpc("task.question.reply", { ...target(live), answers: invalid })).error.code,
          "INVALID_PARAMS",
        );
      assert.deepEqual(
        (await native("thread/list", { limit: 100 })).data.map((thread) => thread.id).sort(),
        beforeThreads,
        "rejected Task replies create no ordinary chat",
      );
      const foreign = await control("foreign-project");
      instances.set(foreign.service.serviceId, foreign.service);
      for (const identity of [deviceA, deviceB])
        await control("control", {
          operation: "updateGrant",
          id: identityId(identity),
          projects: [host.projectId, foreign.projectId],
          preset: "Operator",
        });
      a = await connectDevice(deviceA);
      b = await connectDevice(deviceB);
      refused(
        await a.rpc("task.question.reply", { ...target(live), answers }, randomUUID(), {
          projectId: foreign.projectId,
          serviceGeneration: foreign.service.generation,
        }),
      );
      const commandId = randomUUID(),
        accepted = (await a.rpc("task.question.reply", { ...target(live), answers }, commandId))
          .result;
      assert.equal(accepted.admissionState, "accepted");
      assert.equal(accepted.receipt.taskId, live.taskId);
      assert.equal(accepted.receipt.runId, live.runId);
      assert.ok(accepted.receipt.messageId);
      const continuation = await completedTask(live);
      taskQuestionEvidence.cases.push({
        kind: "exact-original-reply-and-continuation",
        ...live,
        accepted,
        continuation,
      });
      refused(await a.rpc("task.question.reply", { ...target(live), answers }));
      assert.equal(
        (
          await a.rpc(
            "task.question.reply",
            { ...target(live), answers: { ...answers, choice: "A" } },
            commandId,
          )
        ).error.code,
        "COMMAND_CONFLICT",
      );
      await restartHost();
      const saved = (await a.rpc("command.read", { commandId })).result;
      assert.equal(saved.admissionState, "accepted");
      assert.deepEqual(saved.receipt, accepted.receipt);
      assert.equal(
        (await a.rpc("task.question.reply", { ...target(live), answers }, commandId)).result
          .operationId,
        accepted.operationId,
      );
      assert.equal(await control("dispatches"), 0, "known Task receipt recovery cannot dispatch");

      const paused = await startTask();
      await waitingTask(paused);
      const beforePause = await native("areal/task/read", { taskId: paused.taskId });
      await native("areal/task/pause", {
        requestId: randomUUID(),
        taskId: paused.taskId,
        expectedRunId: paused.runId,
        expectedRevision: beforePause.revision,
      });
      await waitFor(async () => {
        const task = await native("areal/task/read", { taskId: paused.taskId });
        return task.paused && task.runs.find((run) => run.id === paused.runId)?.status === "paused";
      }, "native Task paused");
      const beforeModels = modelRequests;
      const pausedReply = (await a.rpc("task.question.reply", { ...target(paused), answers }))
        .result;
      assert.equal(pausedReply.admissionState, "accepted");
      await pause(200);
      const afterPause = await native("areal/task/read", { taskId: paused.taskId });
      assert.equal(afterPause.paused, true);
      assert.equal(afterPause.runs.find((run) => run.id === paused.runId).status, "paused");
      assert.equal(modelRequests, beforeModels);
      assert.equal(await contents(file(paused.effect, "reply")), null);
      taskQuestionEvidence.cases.push({
        kind: "reply-does-not-resume-paused-task",
        ...paused,
        receipt: pausedReply,
        after: afterPause,
      });
      await cancelTask(paused);

      const replaced = await startTask();
      await waitingTask(replaced);
      const oldTask = await native("areal/task/read", { taskId: replaced.taskId });
      await native("areal/task/pause", {
        requestId: randomUUID(),
        taskId: replaced.taskId,
        expectedRunId: replaced.runId,
        expectedRevision: oldTask.revision,
      });
      const oldGoal = await waitFor(async () => {
        const value = await native("areal/goal/get", { threadId: replaced.threadId });
        return value.goal?.status === "paused" ? value : null;
      }, "old Goal paused before replacement");
      await control("fault", "hold-task-reply-before-native");
      const delayed = a.rpc("task.question.reply", { ...target(replaced), answers });
      await waitFor(
        () => control("task-reply-held"),
        "exact old Task reply held before native call",
      );
      await native("areal/goal/clear", {
        requestId: randomUUID(),
        threadId: replaced.threadId,
        goalId: oldGoal.goal.id,
        expectedRevision: oldGoal.revision,
      });
      const cleared = await native("areal/goal/get", { threadId: replaced.threadId });
      const replacement = await native("areal/goal/create", {
        requestId: randomUUID(),
        threadId: replaced.threadId,
        expectedRevision: cleared.revision,
        objective: "RC05_HOLD replacement Goal",
        inferLimits: false,
        maxTurns: 2,
      });
      const newGoal = await native("areal/goal/get", { threadId: replaced.threadId });
      assert.notEqual(newGoal.goal.id, oldGoal.goal.id);
      await control("release-task-reply");
      const replacedReply = await delayed;
      assert.equal(replacedReply.result.admissionState, "rejected");
      assert.equal(replacedReply.result.error.coreCode, -32009);
      const unchanged = await native("areal/goal/get", { threadId: replaced.threadId });
      assert.equal(unchanged.goal.id, newGoal.goal.id);
      assert.equal(unchanged.goal.status, "active");
      assert.equal(
        (await channel(replaced.taskId)).data.filter((message) => message.kind === "reply").length,
        0,
      );
      await native("areal/goal/pause", {
        requestId: randomUUID(),
        threadId: replaced.threadId,
        goalId: unchanged.goal.id,
        expectedRevision: unchanged.revision,
      });
      for (const response of held) response.destroy();
      held.clear();
      await settled(replaced.threadId);
      taskQuestionEvidence.cases.push({
        kind: "native-old-reply-rejects-replaced-goal",
        ...replaced,
        oldGoal: oldGoal.goal.id,
        newGoal: newGoal.goal.id,
        replacedReply,
        replacement,
      });

      const competing = await startTask();
      await waitingTask(competing);
      const competingIds = [randomUUID(), randomUUID()];
      const contested = await Promise.all([
        a.rpc("task.question.reply", { ...target(competing), answers }, competingIds[0]),
        b.rpc("task.question.reply", { ...target(competing), answers }, competingIds[1]),
      ]);
      assert.equal(
        contested.filter((value) => value.result?.admissionState === "accepted").length,
        1,
      );
      assert.equal(
        contested.filter((value) => value.error || value.result?.admissionState === "rejected")
          .length,
        1,
      );
      const competed = await completedTask(competing);
      taskQuestionEvidence.cases.push({
        kind: "two-device-one-original-answer",
        ...competing,
        contested,
        competed,
      });

      const expired = await startTask("RC08_EXPIRE");
      await pause(1200);
      refused(await a.rpc("task.question.reply", { ...target(expired), answers }));
      await cancelTask(expired);
      const cancelled = await startTask();
      await cancelTask(cancelled);
      refused(await a.rpc("task.question.reply", { ...target(cancelled), answers }));
      const terminal = await startTask("RC08_TERMINAL");
      await releaseWork(terminal);
      await waitFor(
        async () =>
          (await native("areal/task/read", { taskId: terminal.taskId })).runs.some(
            (run) => run.id === terminal.runId && run.status === "completed",
          ),
        "terminal Task with unanswered optional question",
      );
      refused(await a.rpc("task.question.reply", { ...target(terminal), answers }));
      checks.push({
        case: "T28",
        detail:
          "actual Task question while Runtime work continues, original same-Run continuation, paused reply without resume, cross-project/Run/question splices, expired/cancelled/terminal/answered conflicts, two-device single answer, no chat conversion",
      });

      const pendingFailure = await startTask();
      await waitingTask(pendingFailure);
      await control("fault", "pending-write");
      const beforeDispatch = await control("dispatches");
      const unsent = await a.rpc("task.question.reply", { ...target(pendingFailure), answers });
      assert.ok(unsent.error);
      assert.equal(await control("dispatches"), beforeDispatch);
      assert.equal(
        (await channel(pendingFailure.taskId)).data.filter((message) => message.kind === "reply")
          .length,
        0,
      );
      await cancelTask(pendingFailure);
      for (const fault of ["lost-native-response", "outcome-write", "crash-after-accept"]) {
        const item = await startTask();
        await waitingTask(item);
        const id = randomUUID(),
          params = { ...target(item), answers };
        await control("fault", fault);
        let original;
        if (fault === "crash-after-accept") {
          const exited = once(worker, "exit");
          await assert.rejects(a.rpc("task.question.reply", params, id));
          await exited;
          await startHost();
          a = await connectDevice(deviceA);
          b = await connectDevice(deviceB);
        } else {
          original = (await a.rpc("task.question.reply", params, id)).result;
          assert.equal(original.admissionState, "unknown");
          assert.equal(original.receipt, undefined);
          await restartHost();
        }
        const before = await control("dispatches");
        const unknown = (await a.rpc("command.read", { commandId: id })).result;
        assert.equal(unknown.admissionState, "unknown");
        assert.equal(unknown.receipt, undefined);
        assert.equal(unknown.observedState.status, "answered");
        assert.equal(unknown.observedState.provesCommandAdmission, false);
        assert.equal(
          (await a.rpc("task.question.reply", params, id)).result.admissionState,
          "unknown",
        );
        assert.equal(await control("dispatches"), before);
        const continued = await completedTask(item);
        taskQuestionEvidence.cases.push({ kind: fault, ...item, original, unknown, continued });
      }
      checks.push({
        case: "T29",
        detail:
          "saved known Task receipt survives Host restart; lost native response, durable outcome failure and real Host crash after Core acceptance remain UNKNOWN with separate answered observation; no native replay and exactly one Runtime continuation effect",
      });
    }
    if (taskPauseOnly) {
      const scheduledThreads = new Set();
      const taskRead = (taskId) => native("areal/task/read", { taskId });
      const originalTarget = (task) => ({
        taskId: task.id,
        expectedRunId: task.runs.at(-1).id,
        expectedRevision: task.revision,
      });
      const cancel = async (taskId) => {
        for (let attempt = 0; attempt < 20; attempt++) {
          const task = await taskRead(taskId);
          try {
            await native("areal/task/cancel", {
              requestId: randomUUID(),
              taskId,
              expectedRevision: task.revision,
            });
            return;
          } catch (error) {
            if (error.code !== -32009 || attempt === 19) throw error;
          }
        }
      };
      for (let index = 0; index < repetitions; index++) {
        const thread = (await a.rpc("session.create")).result;
        assert.equal(thread?.admissionState, "accepted");
        assert.match(
          thread.threadId,
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );
        assert.equal(scheduledThreads.has(thread.threadId), false);
        scheduledThreads.add(thread.threadId);
        const created = await native("areal/task/create", {
          requestId: randomUUID(),
          mode: "scheduled",
          threadId: thread.threadId,
          objective: `RC09_RACE:${randomUUID()}`,
          schedule: { at: Math.floor(Date.now() / 1000) + 1, intervalSeconds: 3 },
          interactionMode: "headless",
          maxTurns: 4,
        });
        assert.equal(created.threadId, thread.threadId);
        try {
          const original = await waitFor(async () => {
            const t = await taskRead(created.id);
            return t.runs.at(-1)?.status === "completed" ? t : null;
          }, "original scheduled Run actually completed");
          const params = originalTarget(original);
          await control("fault", "hold-task-pause-before-native");
          const pending = a.rpc("task.pause", params);
          await waitFor(
            () => control("task-pause-held"),
            "original guarded pause held before native dispatch",
          );
          const replacement = await waitFor(async () => {
            const t = await taskRead(created.id);
            return t.runs.at(-1)?.id !== params.expectedRunId ? t : null;
          }, "actual next scheduled Run");
          await control("release-task-pause");
          const response = await pending;
          assert.equal(response.result?.admissionState, "rejected", JSON.stringify(response));
          assert.equal(response.result.error.code, "TARGET_CHANGED");
          assert.deepEqual(response.result.target, params);
          assert.equal((await taskRead(created.id)).paused, false);
          taskPauseEvidence.races.push({
            index,
            original: params,
            replacementRunId: replacement.runs.at(-1).id,
            response,
          });
          completedRaceIterations++;
        } finally {
          await cancel(created.id);
        }
      }
      checks.push({
        case: "T30",
        detail:
          "100 completed original-Run races through actual Gateway/Core; held immutable Run/revision rejects after next native scheduled Run",
      });
      const effect = randomUUID();
      const thread = (await a.rpc("session.create")).result;
      assert.equal(thread?.admissionState, "accepted");
      assert.match(
        thread.threadId,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      assert.equal(scheduledThreads.has(thread.threadId), false);
      scheduledThreads.add(thread.threadId);
      const created = await native("areal/task/create", {
        requestId: randomUUID(),
        mode: "background",
        threadId: thread.threadId,
        objective: `RC09_WORK:${effect}`,
        interactionMode: "headless",
        maxTurns: 8,
      });
      assert.equal(created.threadId, thread.threadId);
      const original = await waitFor(async () => {
        const t = await taskRead(created.id),
          r = t.runs.at(-1);
        if (r?.status !== "waitingForAgents" || r.workers.length !== 1 || r.workers[0].settled)
          return null;
        try {
          if ((await readFile(join(workspace, "effects", effect), "utf8")) !== "ready") return null;
        } catch {
          return null;
        }
        const thread = (await native("thread/read", { threadId: r.threadId, includeTurns: true }))
          .thread;
        if (!thread.turns.some((turn) => turn.status === "completed")) return null;
        return { task: t, coordinator: thread };
      }, "completed coordinator with real held Runtime worker");
      taskPauseEvidence.before = original;
      const params = originalTarget(original.task),
        commandId = randomUUID();
      await control("fault", "lost-native-response");
      const response = await a.rpc("task.pause", params, commandId);
      assert.equal(response.result.admissionState, "unknown");
      assert.equal(response.result.observedState.taskPaused, true);
      assert.equal(
        response.result.observedState.settled,
        false,
        "accepted pause intent must wait for delayed worker cleanup",
      );
      taskPauseEvidence.response = response;
      const final = await waitFor(
        async () => {
          const value = await a.rpc("command.read", { commandId });
          assert.equal(value.result.admissionState, "unknown");
          assert.equal(value.result.observedState.provesCommandAdmission, false);
          return value.result.observedState.settled ? value : null;
        },
        "original Run paused and all workers settled",
        30000,
      );
      const settledTask = await taskRead(created.id),
        runCount = settledTask.runs.length;
      assert.equal(settledTask.runs.at(-1).status, "paused");
      const beforeDispatches = await control("dispatches");
      await pause(4500);
      const after = await taskRead(created.id);
      assert.equal(
        after.runs.length,
        runCount,
        "paused background Task never creates a replacement Run",
      );
      assert.equal(after.paused, true);
      assert.equal(await control("dispatches"), beforeDispatches);
      assert.equal(await readFile(join(workspace, "effects", effect), "utf8"), "ready");
      taskPauseEvidence.settled = { final, settledTask, after, beforeDispatches };
      checks.push({
        case: "T31",
        detail:
          "real coordinator completes while Runtime worker held; lost pause response UNKNOWN, separate observed pause waits for worker cleanup; paused background Task and worker do not resume without replay",
      });
    }
    if (reviewOnly) {
      const readReview = async (threadId, turnId) => {
        let cursor,
          text = "",
          artifacts = [],
          pages = 0;
        do {
          const response = await a.rpc("review.read", {
            threadId,
            turnId,
            ...(cursor ? { cursor } : {}),
          });
          assert.ok(response.result, JSON.stringify(response.error));
          const page = response.result;
          assert.equal(page.review.offset, Buffer.byteLength(text));
          text += page.review.chunk;
          artifacts.push(...page.artifacts);
          cursor = page.nextCursor;
          pages++;
          assert.ok(pages < 300);
          if (!cursor) assert.equal(Buffer.byteLength(text), page.review.totalBytes);
        } while (cursor);
        return { body: JSON.parse(text), artifacts, pages };
      };
      const create = async () => {
        const response = await a.rpc("session.create");
        assert.equal(response.result.admissionState, "accepted");
        return response.result.threadId;
      };
      const send = async (threadId, text, expectedConfigRevision = 1) => {
        const response = await a.rpc("session.send", { threadId, text, expectedConfigRevision });
        assert.equal(response.result.admissionState, "accepted");
        await settled(threadId);
        return response.result.turnId;
      };
      const threadId = await create(),
        key = randomUUID();
      const turnId = await send(threadId, `RC10_REVIEW:${key}`);
      const original = await readReview(threadId, turnId);
      assert.equal(original.body.turnStatus, "completed");
      assert.ok(original.pages > 1);
      assert.equal(original.body.diff.state, "available");
      for (const [name, expected] of [
        ["z", "Z"],
        ["a", "A"],
      ]) {
        const path = `effects/rc10-${name}-${key}.txt`;
        assert.equal(await readFile(join(workspace, path), "utf8"), `${expected} original\n`);
        const file = original.body.diff.files.find((file) => file.path === path);
        assert.ok(file, path);
        assert.match(JSON.stringify(file.hunks), new RegExp(`${expected} original`));
        await writeFile(join(workspace, path), "current workspace replacement\n");
      }
      assert.deepEqual((await readReview(threadId, turnId)).body.diff, original.body.diff);
      const failedId = await send(threadId, `RC10_FAILED:${key}`);
      const failed = await readReview(threadId, failedId);
      assert.equal(failed.body.turnStatus, "failed");
      assert.equal(failed.body.partial, true);
      assert.ok(failed.body.error);
      assert.ok(failed.body.result.some((item) => item.text.includes("RC10 partial output")));
      assert.equal(failed.body.diff.state, "unavailable");
      assert.equal(failed.body.taskRunStatus, null);
      reviewEvidence.cases.push({
        case: "T32",
        threadId,
        turnId,
        failedId,
        pages: original.pages,
        diff: original.body.diff,
        failed: failed.body,
      });
      checks.push({
        case: "T32",
        detail:
          "actual Runtime historical writes remain path-bound after workspace edits; paged original result and provider-failed partial Turn",
      });
      const mediaThread = await create();
      await native("areal/thread/configure", {
        threadId: mediaThread,
        expectedRevision: 1,
        model: { providerId: "fixture-media", modelId: "fixture" },
      });
      const mediaTurn = await send(mediaThread, "RC10_MEDIA:PNG", 2);
      const media = await readReview(mediaThread, mediaTurn);
      assert.equal(media.artifacts.length, 2);
      const artifactRef = media.artifacts[0].artifactRef;
      const chunk = await a.rpc("artifact.read", { artifactRef, offset: 0, length: 48 * 1024 });
      assert.ok(chunk.result, JSON.stringify(chunk.error));
      assert.equal(chunk.result.turnId, mediaTurn);
      assert.equal(chunk.result.raster.width, 1);
      assert.equal(chunk.result.nextOffset, null);
      assert.equal(Buffer.from(chunk.result.base64, "base64").length, media.artifacts[0].size);
      assert.ok((await b.rpc("artifact.read", { artifactRef, offset: 0, length: 1 })).error);
      assert.ok(
        (
          await a.rpc("artifact.read", { artifactRef, offset: 0, length: 1 }, undefined, {
            projectId: "wrong",
          })
        ).error,
      );
      for (const params of [
        { artifactRef: "unknown", offset: 0, length: 1 },
        { artifactRef, offset: 0, length: 1, uri: "file:///etc/passwd" },
      ])
        assert.ok((await a.rpc("artifact.read", params)).error);
      const duplicateTurn = await send(mediaThread, "RC10_MEDIA:PNG", 2);
      const duplicate = await readReview(mediaThread, duplicateTurn);
      const duplicateChunk = await a.rpc("artifact.read", {
        artifactRef: duplicate.artifacts[0].artifactRef,
        offset: 0,
        length: 48 * 1024,
      });
      assert.equal(duplicateChunk.result.base64, chunk.result.base64);
      assert.equal(duplicateChunk.result.turnId, duplicateTurn);
      assert.ok(
        (await a.rpc("artifact.read", { artifactRef, offset: 0, length: 1, turnId: duplicateTurn }))
          .error,
      );
      reviewEvidence.cases.push({
        case: "T33",
        mediaThread,
        mediaTurn,
        duplicateTurn,
        size: media.artifacts[0].size,
      });
      checks.push({
        case: "T33",
        detail:
          "native persisted AgentMedia through trusted blob HTTP; same bytes in distinct Turns, device/project/ref/path/splice rejection",
      });
      for (const kind of ["HTML", "HUGE"]) {
        const badTurn = await send(mediaThread, `RC10_MEDIA:${kind}`, 2);
        const bad = await readReview(mediaThread, badTurn);
        assert.equal(bad.artifacts.length, 1);
        const rejected = await a.rpc("artifact.read", {
          artifactRef: bad.artifacts[0].artifactRef,
          offset: 0,
          length: 48 * 1024,
        });
        assert.ok(rejected.error, kind);
        reviewEvidence.cases.push({ case: "T34", kind, turnId: badTurn, error: rejected.error });
      }
      checks.push({
        case: "T34",
        detail:
          "actual native media records with HTML bytes or excessive PNG dimensions rejected before publication; cancellation, vanished membership and oversized metadata remain separate source fixtures",
      });
      phase = "production-pwa";
      const limitation = browserTransportLimitation(transport);
      if (limitation) {
        reviewEvidence.browser = limitation;
        requiredUnrun.push(limitation);
        throw Object.assign(new Error(limitation.reason), { code: limitation.code });
      }
      // 真实浏览器只经邀请、Noise 和生产页面取得其自己的引用；桌面确认与安全存储仍为显式 fixture。
      const { chromium } = require("../app/node_modules/playwright-core");
      browser = await chromium.launch({
        executablePath:
          process.env.AREAL_CHROME_BIN ??
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        headless: true,
      });
      recordOwnedProcesses();
      const browserEvidence = (reviewEvidence.browser = {
        version: browser.version(),
        projectId: host.projectId,
        serviceGeneration: host.generation,
        approval: "trusted RemoteControl approval fixture; not production Electron UI",
        safeStorage: "encryption fixture; not system keychain",
        errors: [],
        externalRequests: [],
        screenshots: [],
        staticManifestSha256: createHash("sha256")
          .update(await readFile(join(gui, "renderer/dist/remote-assets.json")))
          .digest("hex"),
        failedLoadRetry: "source DOM fixture only",
      });
      browserPage = await browser.newPage();
      browserPage.setDefaultTimeout(20000);
      browserPage.on("pageerror", (error) => browserEvidence.errors.push(error.message));
      browserPage.on("request", (request) => {
        if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== host.origin)
          browserEvidence.externalRequests.push(request.url());
      });
      const invite = await control("control", { operation: "pair" });
      await browserPage.goto(invite.payload);
      await browserPage.getByRole("button", { name: "连接电脑", exact: true }).click();
      await browserPage
        .getByRole("status")
        .getByText(/等待桌面确认/)
        .waitFor();
      const pending = await waitFor(
        async () => (await control("control", { operation: "status" })).pending[0],
        "browser Noise pairing",
      );
      await control("control", {
        operation: "approve",
        id: pending.id,
        projects: [host.projectId],
        preset: "Observer",
      });
      browserEvidence.devicePeerId = pending.id;
      await browserPage
        .getByRole("status")
        .getByText(/已连接/)
        .waitFor();
      const openReview = async (threadId, turnId) => {
        browserLayoutSafe = false;
        await browserPage.getByRole("button", { name: "刷新概览", exact: true }).click();
        await browserPage
          .locator(`[data-work-id="${threadId}"]`)
          .getByRole("button", { name: "打开会话", exact: true })
          .click();
        await waitFor(
          async () =>
            (await browserPage.locator("#session-state").textContent()).includes(threadId) &&
            !(await browserPage.locator("#session-error").textContent()),
          "browser original Thread baseline",
        );
        await browserPage
          .locator(`[data-turn-id="${turnId}"]`)
          .getByRole("button", { name: "查看原轮次结果与变更", exact: true })
          .click();
        await browserPage.getByRole("button", { name: "关闭结果审查", exact: true }).waitFor();
        for (let page = 0; page < 300; page++) {
          if (
            await browserPage
              .getByRole("heading", { name: new RegExp(`原 Turn ${turnId}`) })
              .count()
          )
            return;
          const more = browserPage.getByRole("button", { name: "继续读取原结果", exact: true });
          await more.waitFor();
          await more.click();
          await waitFor(
            async () =>
              !!(await browserPage
                .getByRole("heading", { name: new RegExp(`原 Turn ${turnId}`) })
                .count()) ||
              (!!(await more.count()) && (await more.isEnabled())),
            "browser review page",
          );
        }
        throw new Error("Browser review pagination exceeded bound");
      };
      // 先核对公开 DOM 的布局和原文字节，避免截图为失控页面分配巨型位图。
      const measureReviewLayout = async () => {
        const root = document.documentElement;
        const panel = document.querySelector("#session > .result-review");
        const pres = [];
        for (const pre of panel?.querySelectorAll("pre") ?? []) {
          const style = getComputedStyle(pre);
          const bytes = new TextEncoder().encode(pre.textContent);
          const digest = await crypto.subtle.digest("SHA-256", bytes);
          pres.push({
            chars: pre.textContent.length,
            bytes: bytes.length,
            sha256: Array.from(new Uint8Array(digest), (byte) =>
              byte.toString(16).padStart(2, "0"),
            ).join(""),
            clientWidth: pre.clientWidth,
            scrollWidth: pre.scrollWidth,
            clientHeight: pre.clientHeight,
            scrollHeight: pre.scrollHeight,
            whiteSpace: style.whiteSpace,
            overflowWrap: style.overflowWrap,
            overflowX: style.overflowX,
            overflowY: style.overflowY,
            maxHeight: style.maxHeight,
          });
        }
        return {
          viewportWidth: innerWidth,
          clientWidth: root.clientWidth,
          scrollWidth: root.scrollWidth,
          panel: !!panel,
          pres,
        };
      };
      const assertReviewLayout = (layout, body) => {
        assert.ok(layout.panel, "result review layout container missing");
        assert.ok(layout.clientWidth > 0 && layout.clientWidth <= layout.viewportWidth);
        assert.ok(layout.scrollWidth <= layout.viewportWidth + 2, "review expands document width");
        const expected = [
          ...(body.error ? [JSON.stringify(body.error, null, 2)] : []),
          ...body.result.map((item) => item.text),
          ...(body.diff.state === "available"
            ? body.diff.files.flatMap((file) =>
                file.hunks.map(
                  (hunk) =>
                    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n` +
                    hunk.lines
                      .map(
                        (line) =>
                          `${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.text}`,
                      )
                      .join("\n"),
                ),
              )
            : []),
        ];
        assert.equal(
          layout.pres.length,
          expected.length,
          "all original review blocks remain accessible",
        );
        for (const [index, pre] of layout.pres.entries()) {
          const value = expected[index];
          assert.equal(pre.chars, value.length);
          assert.equal(pre.bytes, Buffer.byteLength(value));
          assert.equal(
            pre.sha256,
            createHash("sha256").update(value).digest("hex"),
            "original review text changed",
          );
          assert.equal(pre.whiteSpace, "pre-wrap");
          assert.equal(pre.overflowWrap, "anywhere");
          assert.equal(pre.overflowX, "auto");
          assert.equal(pre.overflowY, "auto");
          const maximum = Number.parseFloat(pre.maxHeight);
          assert.ok(Number.isFinite(maximum) && maximum > 0, "review text height must be bounded");
          assert.ok(pre.clientHeight <= maximum + 2);
          assert.ok(
            pre.scrollHeight >= pre.clientHeight,
            "full text remains in the scrollable block",
          );
          assert.ok(pre.scrollWidth <= layout.clientWidth + 2);
        }
      };
      const screenshot = async (name, body) => {
        browserLayoutSafe = false;
        const layout = await browserPage.evaluate(measureReviewLayout);
        (browserEvidence.layouts ??= []).push({ name, ...layout });
        assertReviewLayout(layout, body);
        browserLayoutSafe = true;
        const path = join(scratch, name);
        await browserPage.screenshot({ path, fullPage: true });
        browserEvidence.screenshots.push(path);
      };
      await openReview(threadId, turnId);
      await browserPage.getByText("历史输出", { exact: false }).first().waitFor();
      for (const name of ["z", "a"])
        await browserPage
          .getByRole("heading", { name: `effects/rc10-${name}-${key}.txt`, exact: true })
          .waitFor();
      await screenshot("rc10-browser-original-diff.png", original.body);
      await openReview(threadId, failedId);
      assert.match(
        await browserPage
          .getByRole("heading", { name: new RegExp(`原 Turn ${failedId}`) })
          .textContent(),
        /failed.*部分输出/,
      );
      await browserPage.getByText("RC10 partial output", { exact: true }).first().waitFor();
      await screenshot("rc10-browser-failed-partial.png", failed.body);
      await openReview(mediaThread, mediaTurn);
      const selectors = browserPage.getByRole("button", { name: /^查看图片/ });
      assert.equal(await selectors.count(), 2);
      const imageFacts = [];
      for (const [step, index] of [
        ["a", 0],
        ["b", 1],
        ["a-again", 0],
      ]) {
        browserLayoutSafe = false;
        await selectors.nth(index).click();
        const images = browserPage.locator("#session img");
        await waitFor(
          async () =>
            (await images.count()) === 1 &&
            (await images.evaluate((image) => image.complete && image.naturalWidth > 0)),
          "real browser raster decode",
        );
        const fact = await images.evaluate((image) => ({
          alt: image.alt,
          src: image.src,
          width: image.naturalWidth,
          height: image.naturalHeight,
        }));
        assert.equal(fact.width, 1);
        assert.equal(fact.height, 1);
        assert.ok(fact.src.startsWith("blob:"));
        assert.ok(fact.alt.includes(mediaTurn));
        imageFacts.push({ step, ...fact });
        assert.equal(await selectors.count(), 2);
        await screenshot(`rc10-browser-image-${step}.png`, media.body);
      }
      assert.equal(imageFacts[0].alt, imageFacts[2].alt);
      assert.notEqual(imageFacts[0].alt, imageFacts[1].alt);
      assert.notEqual(imageFacts[0].src, imageFacts[2].src);
      browserEvidence.images = imageFacts;
      browserLayoutSafe = false;
      await browserPage.getByRole("button", { name: "关闭结果审查", exact: true }).click();
      assert.equal(await browserPage.locator("#session img").count(), 0);
      assert.deepEqual(browserEvidence.errors, []);
      assert.deepEqual(browserEvidence.externalRequests, []);
      checks.push({
        case: "T32/T33/T34",
        detail:
          "actual production Chromium page pairs with its own Noise identity, reviews original diff/failed partial Turn, decodes native raster and selects A to B to A; close removes preview; trusted approval and safeStorage fixtures explicitly retained",
      });
    }
    passed = true;
  } catch (error) {
    if (error.transportEvidence) transportFailureEvidence = error.transportEvidence;
    if (error.code !== "RELAY_BROWSER_TLS_UNRUN") {
      phaseErrors.push({
        phase,
        name: error.name,
        code: error.code ?? null,
        message: error.message,
      });
      throw error;
    }
  } finally {
    if (browserPage && !passed && !browserLayoutSafe)
      (reviewEvidence.browser ??= {}).failureScreenshotWithheld =
        "layout not verified safe; see recorded layout facts and failure";
    if (browserPage && !passed && browserLayoutSafe) {
      try {
        await browserPage.screenshot({
          path: join(scratch, "rc10-browser-failure.png"),
          fullPage: true,
        });
      } catch {}
    }
    if (browser) {
      try {
        await browser.close();
        (reviewEvidence.browser ??= {}).closed = true;
      } catch (error) {
        (reviewEvidence.browser ??= {}).cleanupError = error.message;
        phaseErrors.push({ phase: "browser-stop", message: error.message });
        passed = false;
      }
    }
    for (const secure of connections) secure.close();
    // Read through an independent owner connection: T24 intentionally disconnects the Host.
    const drainStatus = [];
    for (const instance of instances.values()) {
      let client;
      try {
        const auth = JSON.parse(await readFile(instance.authFile, "utf8"));
        const token = auth.principals.find((principal) => principal.id === "desktop-owner").token;
        client = new CoreClient({
          createSocket: () =>
            new WebSocket(instance.endpoint, {
              headers: { Authorization: `Bearer ${token}` },
            }),
        });
        await client.connect();
        drainStatus.push({
          serviceId: instance.serviceId,
          status: await client.request("areal/server/status"),
        });
      } catch (error) {
        phaseErrors.push({
          phase: "drain-diagnosis",
          serviceId: instance.serviceId,
          message: error.message,
        });
        passed = false;
      } finally {
        client?.close();
      }
    }
    if (worker?.exitCode === null && worker.signalCode === null) {
      try {
        const exited = once(worker, "exit");
        await control("stop");
        await Promise.race([
          exited,
          pause(5000).then(() => {
            throw new Error("Host exit timed out");
          }),
        ]);
      } catch (error) {
        passed = false;
        phaseErrors.push({ phase: "host-stop", message: error.message, forcedCleanup: true });
        worker.kill("SIGTERM");
      }
    }
    const cleanup = [];
    for (const instance of instances.values()) {
      try {
        cleanup.push(
          JSON.parse(
            execFileSync(
              binary,
              ["service", "stop", "--instance", instance.serviceId, "--cancel", "--json"],
              {
                env: { ...process.env, AREAL_HARNESS_SERVICE_HOME: registry },
                encoding: "utf8",
                timeout: 60000,
              },
            ),
          ),
        );
      } catch (error) {
        const status = drainStatus.find((entry) => entry.serviceId === instance.serviceId)?.status;
        const unknownOnly =
          status &&
          status.restartSafe === false &&
          status.unresolvedTools?.length === 1 &&
          status.runtime?.activeProcesses === 0 &&
          status.activeTurns.length === 0 &&
          status.activeTasks === 0 &&
          status.activeGoals.length === 0 &&
          status.resources.length === 0 &&
          status.compactions.length === 0 &&
          status.workgroups.length === 0;
        const expectedGuard =
          (settlementOnly || taskPauseOnly) &&
          passed &&
          unknownOnly &&
          error.stderr?.toString().includes("service drain is incomplete");
        cleanup.push({
          serviceId: instance.serviceId,
          gracefulDrain: false,
          unknownDrainGuardVerified: expectedGuard,
          error: error.message,
        });
        if (!expectedGuard) {
          phaseErrors.push({
            phase: "service-stop",
            serviceId: instance.serviceId,
            message: error.message,
          });
          passed = false;
        }
        // Isolated fixture termination is separate from successful safe drain.
        // Preserve the original UNKNOWN record; never acknowledge or replay it for cleanup.
        try {
          const current = JSON.parse(
            await readFile(join(registry, "services", instance.serviceId, "service.json"), "utf8"),
          );
          assert.equal(current.hostPid, instance.hostPid);
          assert.equal(current.generation, instance.generation);
          const command = execFileSync("ps", ["-p", String(instance.hostPid), "-o", "command="], {
            encoding: "utf8",
          }).trim();
          assert.ok(command.startsWith(`${binary} service-host`));
          process.kill(instance.hostPid, "SIGTERM");
          await waitFor(
            async () => {
              try {
                const result = JSON.parse(
                  execFileSync(
                    binary,
                    ["service", "status", "--instance", instance.serviceId, "--json"],
                    {
                      env: { ...process.env, AREAL_HARNESS_SERVICE_HOME: registry },
                      encoding: "utf8",
                      stdio: ["ignore", "pipe", "pipe"],
                    },
                  ),
                );
                return result.state === "stopped";
              } catch {
                return false;
              } // Host shutdown can briefly refuse its control socket.
            },
            "isolated service Host terminated",
            15000,
          );
          await waitFor(
            () => {
              try {
                process.kill(instance.hostPid, 0);
                return false;
              } catch (error) {
                if (error.code === "ESRCH") return true;
                throw error;
              }
            },
            "isolated Host process exit",
            15000,
          );
          cleanup.push({
            serviceId: instance.serviceId,
            isolatedHarnessTermination: true,
            acknowledgedUnknown: false,
          });
        } catch (cleanupError) {
          passed = false;
          phaseErrors.push({
            phase: "isolated-host-termination",
            serviceId: instance.serviceId,
            message: cleanupError.message,
          });
        }
      }
    }
    let remoteConfigSha256 = null;
    try {
      remoteConfigSha256 = createHash("sha256")
        .update(await readFile(join(home, "remote.json")))
        .digest("hex");
    } catch (error) {
      passed = false;
      phaseErrors.push({ phase: "config-evidence", code: error.code });
    }
    try {
      await transportFixture?.close();
    } catch (error) {
      passed = false;
      phaseErrors.push({ phase: "relay-cleanup", message: error.message });
    }
    model.closeAllConnections();
    await new Promise((resolve) => model.close(resolve));
    const report = {
      passed,
      acceptance:
        passed &&
        requiredUnrun.length === 0 &&
        (repetitions === 0 || completedRaceIterations >= 100),
      fullConformance: false,
      requiredUnrun,
      phaseErrors,
      ...(!passed ? { recentRpcOutcomes } : {}),
      remoteConfigSha256,
      checkLayer: "native-node-business; browser subchecks only when explicitly recorded",
      kind: transport === "direct" ? "native-direct-loopback" : "native-relay-node-tls",
      transport: transportFixture?.evidence ??
        transportFailureEvidence ?? { transport, startup: "failed" },
      checks: checks.map((check) => ({
        ...check,
        layer: check.case === "T32/T33/T34" ? "production-pwa" : "native-node-business",
      })),
      taskOwnershipEvidence,
      settlementEvidence,
      interactionEvidence,
      taskQuestionEvidence,
      taskPauseEvidence,
      reviewEvidence,
      repetitions,
      requestedRepetitions: repetitions,
      completedRaceIterations,
      raceCounts: Object.fromEntries(
        (repetitions === 0
          ? []
          : taskPauseOnly
            ? ["T30"]
            : interactionOnly
              ? ["T25"]
              : stopOnly
                ? ["T23"]
                : ["T18", "T19", "T20", "T22"]
        ).map((testCase) => [
          testCase,
          { requested: repetitions, completed: completedRaceIterations },
        ]),
      ),
      hostWorkers,
      ownedProcesses: [...ownedProcesses.values()].map((value) => {
        let alive = true;
        try {
          process.kill(value.pid, 0);
        } catch (error) {
          if (error.code === "ESRCH") alive = false;
        }
        return { ...value, aliveAfterCleanup: alive };
      }),
      runtimePidEvidence: [...ownedProcesses.values()].some((value) => value.role === "runtime")
        ? "observed owned descendant"
        : "UNOBSERVED; cleanup is not proven for Runtime",
      selectedSuite: reviewOnly
        ? "RC10_T32_T33_T34"
        : taskPauseOnly
          ? "RC09_T30_T31"
          : taskQuestionsOnly
            ? "RC08_T28_T29"
            : interactionOnly
              ? "RC07"
              : stopOnly
                ? "RC06"
                : preflightOnly
                  ? "RC05_T21"
                  : settlementOnly
                    ? "RC06_T24"
                    : interactionSettlementOnly
                      ? "RC07_T26_T27"
                      : "RC05",
      coveredCases: checks.flatMap((check) => check.case.split("/")),
      raceAcceptanceRequired:
        !reviewOnly &&
        !taskQuestionsOnly &&
        !preflightOnly &&
        !settlementOnly &&
        !interactionSettlementOnly,
      acceptanceRepetitionsMet: passed && completedRaceIterations >= 100,
      modelRequests,
      cleanup,
      drainStatus,
      source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      binary,
      sha256: createHash("sha256")
        .update(await readFile(binary))
        .digest("hex"),
      notCovered: [
        ...(transport === "direct" ? ["Relay"] : ["production PWA strict TLS"]),
        "public network",
        "physical phone",
        "system keychain",
        "native Browser adapter (Node fixture)",
        "packaged Electron",
      ],
    };
    await writeFile(join(scratch, "manifest.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ evidence: scratch, ...report }));
    if (!passed) process.exitCode = phaseErrors.length || !requiredUnrun.length ? 1 : 2;
  }
}
