// 连接恢复旅程：真实 Rust Host/Core、生产 Renderer 和用户操作；仅模型及传输故障受控。
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  coreBin,
  createScene,
  gui,
  playwright,
  sendReady,
  startModel,
} from "./support/journey-fixture.mjs";
import { installHostTransportBarrier } from "./support/host-transport-barrier.mjs";
import { readCoreThread } from "./support/core-observation.mjs";
import { validatePlan } from "./support/recovery-exploration.mjs";
import {
  assertApplicationStopped,
  cleanupSyntheticHostKeychain,
  closeRecordedSmokeApplication,
  makeFixtureDirectoriesWritable,
  readFixtureHost,
  settleFixtureHostAfterQuit,
  stopFixtureHost,
} from "./application-cleanup.mjs";

const execute = promisify(execFile);
const require = createRequire(join(gui, "app/package.json"));
const { HostClient } = require("@areal/client/node");
const reportPath = resolve(
  process.env.AREAL_JOURNEY_REPORT ?? "target/connection-recovery/report.json",
);
const out = dirname(reportPath);
const explorationMode = Boolean(process.env.AREAL_RECOVERY_PLAN);
const factIds = explorationMode
  ? ["loadingWithoutFalseFailure", "boundedRecoveryExploration"]
  : [
      "loadingWithoutFalseFailure",
      "automaticRecovery",
      "draftAndSelectionPreserved",
      "continuedSubmission",
      "explicitStopRespected",
      "unknownNotReplayed",
    ];
const report = {
  schemaVersion: 1,
  journeyId: explorationMode ? "connection-recovery-exploration" : "connection-recovery",
  identity: {},
  status: "pending",
  facts: factIds.map((id) => ({ id, status: "pending", evidence: [] })),
  firstFailure: null,
  reached: [],
  unreached: [...factIds],
  faults: {
    loadingWithoutFalseFailure: { injectionReached: false, evidence: [] },
    automaticRecovery: { injectionReached: false, evidence: [] },
  },
  cleanup: { status: "pending" },
  scope:
    "Source Electron owner, real Host/Core and Chromium Renderer; local model; no installed-package or physical-device claim",
};
let scene, model, desktop, env, browser, page, host, originalHost;
let originalHostCapturedDuringCleanup = false;
let stage = "prerequisites";
let explorationPlan;
let explorationStep;
const events = [];
const wire = [];
const pairs = [];
const unknown = { armed: false, dropped: false, requestId: null };
const persist = (name, value) =>
  writeFile(join(out, name), JSON.stringify(value, null, 2), { mode: 0o600 });
const save = () => writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
function targetAssertion(id, condition, message) {
  if (condition) return;
  const error = new assert.AssertionError({
    message,
    actual: condition,
    expected: true,
    operator: "===",
  });
  error.journeyAssertion = id;
  throw error;
}
async function until(read, label, timeout = 60000, assertionId, infrastructure = false) {
  const deadline = Date.now() + timeout;
  do {
    let value;
    try {
      value = await read();
    } catch (error) {
      if (assertionId || infrastructure) error.journeyFailureKind = "infrastructure";
      throw error;
    }
    if (value) return value;
    await new Promise((done) => setTimeout(done, 100));
  } while (Date.now() < deadline);
  if (assertionId) targetAssertion(assertionId, false, label);
  const error = new assert.AssertionError({ message: label });
  if (infrastructure) error.journeyFailureKind = "infrastructure";
  throw error;
}
async function pass(id, observations, screenshots = []) {
  const name = `${id}.json`;
  await persist(name, observations);
  Object.assign(
    report.facts.find((fact) => fact.id === id),
    {
      status: "passed",
      evidence: [name, ...screenshots, "wire.json", "host-identity.json", "build-identity.json"],
      observations,
    },
  );
  report.reached.push(id);
  report.unreached = factIds.filter((id) => !report.reached.includes(id));
  await save();
}
const snapshotProject = (project) => ({
  projectId: project.registration.projectId,
  state: project.state,
  scheduleActivationSuppressed: project.scheduleActivationSuppressed,
  serviceGeneration: project.service?.generation ?? project.service?.identity?.generation ?? null,
});
async function projectStatus(projectId) {
  const status = await host.status();
  const project = status.projects.find((item) => item.registration.projectId === projectId);
  assert.ok(project, "Original project remains registered");
  return snapshotProject(project);
}
function traceSocket(socket) {
  const server = socket.connectToServer();
  const pair = { socket, server, identity: null, closed: false };
  pairs.push(pair);
  const requests = new Map();
  socket.onMessage((bytes) => {
    const frame = JSON.parse(bytes.toString());
    const entry = {
      method: frame.method,
      id: frame.id,
      commandId: frame.commandId ?? null,
      queriedCommandId: frame.method === "command.read" ? frame.params?.commandId : undefined,
      projectId: frame.context?.projectId ?? frame.params?.projectId ?? null,
      serviceGeneration: frame.context?.serviceGeneration ?? null,
      connectionId: pair.identity?.connectionId ?? null,
    };
    // 不保存请求正文、票据、认证和任意响应，只留归属及终态字段。
    if (
      [
        "hello",
        "shell.subscribe",
        "project.activate",
        "session.create",
        "session.send",
        "command.read",
        "desktop.command",
      ].includes(frame.method)
    ) {
      requests.set(frame.id, entry);
      wire.push(entry);
      if (explorationMode) events.push({ sequence: events.length, event: "request", ...entry });
    }
    if (unknown.armed && frame.method === "session.send") {
      unknown.armed = false;
      unknown.requestId = frame.commandId;
      unknown.frameId = frame.id;
      unknown.connectionId = pair.identity?.connectionId;
    }
    server.send(bytes);
  });
  server.onMessage((bytes) => {
    const frame = JSON.parse(bytes.toString());
    if (frame.params?.event === "shell.updated") {
      const event = frame.params;
      wire.push({
        method: "shell.updated",
        connectionId: event.connectionId,
        gatewayGeneration: event.gatewayGeneration,
        sequence: event.sequence,
        projects: (event.delta?.projects?.upsert ?? []).map(
          ({ projectId, state, serviceGeneration, scheduleActivationSuppressed }) => ({
            projectId,
            state,
            serviceGeneration,
            scheduleActivationSuppressed,
          }),
        ),
      });
      if (explorationMode) events.push({ sequence: events.length, event: "shell", ...wire.at(-1) });
    }
    const entry = requests.get(frame.id);
    if (entry) {
      entry.admissionState = frame.result?.admissionState ?? null;
      entry.errorCode = frame.error?.code ?? frame.result?.error?.code ?? null;
      if (entry.method === "project.activate" && !frame.error) {
        entry.activation = {
          projectId: frame.result?.projectId,
          state: frame.result?.state,
          serviceGeneration: frame.result?.serviceGeneration,
          activationId: frame.result?.activationId,
          reason: frame.result?.reason,
        };
      }
      if (entry.method === "command.read" && !frame.error) {
        const result = frame.result;
        entry.receipt = {
          commandId: result.commandId,
          method: result.method,
          admissionState: result.admissionState,
          submissionUnknown: result.submissionUnknown,
          operationId: result.operationId,
          nativeRequestId: result.nativeRequestId,
          threadId: result.threadId,
          turnId: result.turnId,
        };
      }
      if (entry.method === "hello" && !frame.error) {
        const { hostId, generation, connectionId, gatewayGeneration } = frame.result;
        pair.identity = { hostId, generation, connectionId, gatewayGeneration };
        entry.identity = pair.identity;
      }
      if (entry.method === "shell.subscribe" && !frame.error) {
        entry.connectionId = frame.result.connectionId;
        entry.gatewayGeneration = frame.result.gatewayGeneration;
        entry.projects = frame.result.snapshot.projects.map(
          ({ projectId, state, serviceGeneration, scheduleActivationSuppressed }) => ({
            projectId,
            state,
            serviceGeneration,
            scheduleActivationSuppressed,
          }),
        );
      }
      requests.delete(frame.id);
      if (explorationMode) events.push({ sequence: events.length, event: "response", ...entry });
    }
    if (
      frame.id === unknown.frameId &&
      frame.result?.admissionState === "accepted" &&
      !frame.error
    ) {
      unknown.dropped = true;
      unknown.admissionState = "accepted";
      pair.closed = true;
      socket.close();
      server.close();
      return;
    }
    socket.send(bytes);
  });
}
function currentPair() {
  const pair = pairs.findLast((item) => item.identity && !item.closed);
  assert.ok(pair, "An owned authenticated browser connection exists");
  return pair;
}
async function disconnectBrowser() {
  const pair = currentPair();
  pair.closed = true;
  pair.socket.close();
  pair.server.close();
  const replacement = await until(
    () =>
      pairs.findLast(
        (item) =>
          item.identity &&
          !item.closed &&
          item.identity.connectionId !== pair.identity.connectionId,
      ),
    "Browser establishes a successor socket without a click",
  );
  assert.equal(replacement.identity.hostId, pair.identity.hostId);
  assert.equal(replacement.identity.generation, pair.identity.generation);
  await until(
    () =>
      wire.findLast(
        (entry) =>
          entry.method === "shell.subscribe" &&
          entry.connectionId === replacement.identity.connectionId &&
          entry.projects,
      ),
    "Successor socket receives a real shell baseline",
  );
  return { before: pair.identity, after: replacement.identity };
}
async function ready(projectId) {
  await page
    .locator(
      `[data-testid="areal-workbench"][data-project-id="${projectId}"][data-startup-ready="true"]`,
    )
    .waitFor({ timeout: 30000 });
  await page.getByTestId("chat-input").first().waitFor({ timeout: 30000 });
}
async function usable(projectId, allowEmptyDraft = false) {
  await page.locator(`[data-testid="areal-workbench"][data-project-id="${projectId}"]`).waitFor();
  await page.getByTestId("chat-input").first().waitFor();
  if (allowEmptyDraft && (await readInput()) === "") {
    targetAssertion(
      "exploration-composer-editable",
      await page.getByTestId("chat-input").first().isEditable(),
      "an empty recovered draft must remain editable",
    );
  } else await sendReady(page);
  const ui = await visibleState();
  assert.equal(
    ui.startupFailure,
    false,
    "The selected project remains usable without a failure prompt",
  );
  assert.deepEqual(
    ui.observedFailures,
    [],
    "The project never displays a startup failure during automatic recovery",
  );
  return ui;
}
async function readInput() {
  return page
    .getByTestId("chat-input")
    .first()
    .evaluate((element) => ("value" in element ? element.value : element.textContent));
}
async function visibleState() {
  return page.evaluate(() => {
    const workbench = document.querySelector('[data-testid="areal-workbench"]');
    const startup = document.querySelector('[data-testid="startup-loading"]');
    return {
      projectId: workbench?.getAttribute("data-project-id"),
      threadId: workbench?.getAttribute("data-thread-id"),
      startupReady: workbench?.getAttribute("data-startup-ready"),
      startupFailure: !!startup?.querySelector('[role="alert"]'),
      observedFailures: globalThis.connectionJourneyFailures ?? [],
    };
  });
}
async function settleTurn(threadId, text, priorTurnIds = []) {
  const options = { binary: coreBin, env, gui, threadId, workspace: scene.project };
  const result = await until(
    async () => {
      const thread = await readCoreThread(options);
      const turns = thread.turns.filter(
        (turn) =>
          !priorTurnIds.includes(turn.id) &&
          turn.items.some(
            (item) =>
              item.type === "userMessage" && item.content.some((part) => part.text === text),
          ),
      );
      targetAssertion(
        explorationMode ? "exploration-no-replay" : "submission-no-replay",
        turns.length <= 1,
        "A user submission must not produce duplicate Core turns",
      );
      const turn = turns[0];
      if (turn && ["failed", "cancelled"].includes(turn.status))
        assert.fail(`Original turn ended ${turn.status}`);
      // 原审批提交后会保持可见但锁定，直到权威事件移除；不能再次点击等待中的按钮。
      if (turn?.status !== "completed") {
        const deny = page
          .locator('.decision-card[data-interaction="approval"]')
          .first()
          .getByRole("button", { name: /拒绝/ })
          .first();
        if ((await deny.isVisible()) && (await deny.isEnabled())) await deny.click();
      }
      return (
        turn?.status === "completed" && {
          threadId: thread.id,
          turnId: turn.id,
          status: turn.status,
          matchingTurns: turns.length,
          agentReply: turn.items.some((item) => item.type === "agentMessage" && item.text?.trim()),
        }
      );
    },
    "Original user submission completes in authoritative Core",
    60000,
    explorationMode ? "exploration-submission-progress" : undefined,
  );
  assert.ok(result.agentReply, "Core has a nonempty model reply");
  await page
    .locator('[data-turn-status="completed"]')
    .filter({ hasText: text })
    .waitFor({ timeout: 30000 });
  return result;
}

async function exploreRecovery({ projectId, uiProjectId, modelSelection }) {
  stage = "boundedRecoveryExploration";
  const workbench = page.getByTestId("areal-workbench");
  let expectedDraft = "";
  let expectedThread = "";
  const submissions = [];
  const snapshot = async () => ({
    ui: await visibleState(),
    host: await projectStatus(projectId),
    connection: currentPair().identity,
    draft: await readInput(),
  });
  report.exploration.initial = {
    projectId,
    uiProjectId,
    threadId: null,
    ...currentPair().identity,
  };
  const deadline = Date.now() + 10 * 60 * 1000;
  const evidence = ["exploration-plan.json", "exploration-events.json"];
  for (const [index, action] of explorationPlan.actions.entries()) {
    assert(Date.now() < deadline, "exploration exceeded its ten-minute action budget");
    const name = `exploration-step-${index}.json`;
    const screenshot = `exploration-step-${index}.png`;
    explorationStep = {
      index,
      op: action.op,
      status: "running",
      evidence: [name],
      eventsStart: events.length,
    };
    report.exploration.steps.push(explorationStep);
    const observation = { index, action, before: await snapshot(), trigger: null };
    try {
      if (action.op === "edit") {
        await page.getByTestId("chat-input").first().fill(action.text);
        expectedDraft = action.text;
      } else if (["reconnect", "idle-reconnect", "stop-reconnect"].includes(action.op)) {
        if (action.op !== "reconnect") {
          const before = await until(async () => {
            const state = await projectStatus(projectId);
            return ["ready", "stopped"].includes(state.state) && state;
          }, "reclamation waits for a settled project state");
          if (
            action.op === "idle-reconnect" &&
            before.state === "stopped" &&
            !before.scheduleActivationSuppressed
          ) {
            // 已有历史的休眠项目不应为测试先唤醒；重连仍要保留历史和后续按需发送能力。
            observation.trigger = { alreadyIdle: true, terminal: before };
          } else {
            assert(before.serviceGeneration, "reclamation needs the original Core generation");
            const requestId = randomUUID();
            const stopped = await host.stopProject(
              requestId,
              projectId,
              before.serviceGeneration,
              "ifIdle",
              action.op === "stop-reconnect",
            );
            assert.equal(
              stopped.state,
              "completed",
              "the original reclamation request must complete",
            );
            const terminal = await until(async () => {
              const state = await projectStatus(projectId);
              return (
                state.state === "stopped" &&
                state.scheduleActivationSuppressed === (action.op === "stop-reconnect") &&
                state
              );
            }, "reclamation must be visible at the authority");
            observation.trigger = { requestId, state: stopped.state, before, terminal };
          }
        }
        observation.replacement = await disconnectBrowser();
        if (action.op === "stop-reconnect") {
          const end = Date.now() + 3000;
          do {
            const state = await projectStatus(projectId);
            targetAssertion(
              "exploration-explicit-stop",
              state.state === "stopped" && state.scheduleActivationSuppressed,
              "reconnection must respect explicit stop",
            );
            await new Promise((done) => setTimeout(done, 100));
          } while (Date.now() < end);
          observation.stopObservationMs = 3000;
        } else {
          await until(
            async () => {
              const ui = await visibleState();
              // 历史可读的休眠 Thread 可以不具备执行代际；空项目则必须完成当前 owner 的恢复。
              return (
                ui.projectId === uiProjectId &&
                ui.threadId === expectedThread &&
                (expectedThread
                  ? (await page.locator('[data-turn-status="completed"]').count()) >=
                    submissions.length
                  : ui.startupReady === "true")
              );
            },
            "the successor connection must restore the current project without a click",
            30000,
            "exploration-recovery-progress",
          );
          await usable(uiProjectId, true);
        }
      } else if (["submit", "unknown-submit"].includes(action.op)) {
        // 每次发送使用合成且唯一的文字，既能核对持久 Turn，也不会记录用户数据。
        const text = expectedDraft || `recovery-draft-${explorationPlan.seed}-${index}-send`;
        await page.getByTestId("chat-input").first().fill(text);
        await sendReady(page);
        const wireStart = wire.length;
        if (action.op === "unknown-submit") {
          Object.assign(unknown, {
            armed: true,
            dropped: false,
            requestId: null,
            frameId: null,
            connectionId: null,
          });
        }
        await page.getByTestId("chat-input").first().press("Enter");
        if (action.op === "unknown-submit") {
          await until(() => unknown.dropped, "the exact accepted send response must be dropped");
          observation.trigger = { ...unknown };
        }
        const publishedThread = await until(
          () => workbench.getAttribute("data-thread-id"),
          "submission publishes a Thread",
        );
        targetAssertion(
          "exploration-selection",
          !expectedThread || publishedThread === expectedThread,
          "continued submission must stay in the selected Thread",
        );
        expectedThread = publishedThread;
        const result = await settleTurn(
          expectedThread,
          text,
          submissions.map((item) => item.turnId),
        );
        if (action.op === "unknown-submit") {
          const receipt = await until(
            () =>
              wire.findLast(
                (entry) =>
                  entry.method === "command.read" &&
                  entry.queriedCommandId === unknown.requestId &&
                  entry.receipt?.commandId === unknown.requestId &&
                  entry.receipt.admissionState === "accepted" &&
                  entry.receipt.submissionUnknown === false,
              ),
            "original UNKNOWN receipt must be reconciled",
            30000,
            "exploration-original-receipt",
          );
          targetAssertion(
            "exploration-original-receipt",
            receipt.receipt.turnId === result.turnId && receipt.receipt.threadId === expectedThread,
            "receipt must identify this original Core execution",
          );
          observation.receipt = receipt;
        }
        await until(
          async () => (await readInput()) === "",
          "settled send clears only its own draft",
          30000,
          "exploration-draft-settlement",
        );
        expectedDraft = "";
        const sends = wire.slice(wireStart).filter((entry) => entry.method === "session.send");
        targetAssertion(
          "exploration-no-replay",
          sends.length === 1 && sends[0].admissionState === "accepted",
          "one user action must cause exactly one accepted send",
        );
        if (action.op === "unknown-submit")
          targetAssertion(
            "exploration-no-replay",
            sends[0].commandId === unknown.requestId,
            "UNKNOWN cannot use a replacement command ID",
          );
        submissions.push({ text, ...result, requestId: sends[0].commandId });
        observation.submission = {
          ...result,
          requestId: sends[0].commandId,
          sendCount: sends.length,
        };
      }
      observation.after = await snapshot();
      targetAssertion(
        "exploration-selection",
        observation.after.ui.projectId === uiProjectId &&
          observation.after.ui.threadId === expectedThread,
        "recovery must preserve the selected project and Thread",
      );
      targetAssertion(
        "exploration-draft",
        observation.after.draft === expectedDraft,
        "recovery must preserve the current unsent draft",
      );
      targetAssertion(
        "exploration-no-false-failure",
        !observation.after.ui.startupFailure && observation.after.ui.observedFailures.length === 0,
        "ordinary recovery must not display a startup failure",
      );
      targetAssertion(
        "exploration-model-selection",
        (await page.getByRole("button", { name: "选择模型", exact: true }).innerText()) ===
          modelSelection,
        "recovery must preserve model selection",
      );
      // 每个后续事件后复核已完成的提交，防止迟到重放发生在原发送断言之后。
      if (expectedThread) {
        const thread = await readCoreThread({
          binary: coreBin,
          env,
          gui,
          threadId: expectedThread,
          workspace: scene.project,
        });
        targetAssertion(
          "exploration-no-replay",
          thread.turns.length === submissions.length,
          "the isolated Thread must contain exactly the admitted user submissions",
        );
        for (const submission of submissions) {
          const matching = thread.turns.filter(
            (turn) =>
              turn.id === submission.turnId &&
              turn.items.some(
                (item) =>
                  item.type === "userMessage" &&
                  item.content.some((part) => part.text === submission.text),
              ),
          );
          targetAssertion(
            "exploration-no-replay",
            matching.length === 1 && matching[0].id === submission.turnId,
            "later recovery cannot duplicate or replace an earlier Core turn",
          );
        }
      }
      await page.screenshot({ path: join(out, screenshot) });
      explorationStep.evidence.push(screenshot);
      explorationStep.status = "passed";
    } catch (error) {
      explorationStep.status = "failed";
      // 非命名断言/运行工具失败保持基础设施类别，不可作为缩减命中的业务缺陷。
      if (!error.journeyAssertion) error.journeyFailureKind ??= "infrastructure";
      observation.failure = { assertionId: error.journeyAssertion ?? null, message: error.message };
      throw error;
    } finally {
      explorationStep.eventsEnd = events.length;
      await persist(name, observation);
      evidence.push(...explorationStep.evidence);
      await persist("exploration-events.json", events);
      report.facts.find((fact) => fact.id === stage).evidence = [...new Set(evidence)];
      await save();
    }
  }
  await pass(stage, { steps: report.exploration.steps.length, submissions: submissions.length }, [
    ...new Set(evidence),
  ]);
}

await mkdir(out, { recursive: true });
try {
  report.identity = JSON.parse(process.env.AREAL_VERIFICATION_IDENTITY ?? "{}");
  assert.ok(
    report.identity && typeof report.identity === "object" && !Array.isArray(report.identity),
    "Verification identity must be an object",
  );
  await save();
  if (explorationMode) {
    explorationPlan = validatePlan(
      JSON.parse(await readFile(process.env.AREAL_RECOVERY_PLAN, "utf8")),
    );
    report.exploration = {
      planSha256: createHash("sha256").update(JSON.stringify(explorationPlan)).digest("hex"),
      steps: [],
      initial: null,
    };
    await persist("exploration-plan.json", explorationPlan);
    await save();
  }
  // 既有 doctor 核对当前源码输入与实际 Core/Runtime/Renderer 字节，不能用调用方给的身份代替。
  await execute(
    "python3",
    [
      join(gui, "../../scripts/verification.py"),
      "--root",
      resolve(gui, "../.."),
      "doctor",
      "--core",
      coreBin,
      "--report",
      join(out, "build-identity.json"),
    ],
    { timeout: 60000 },
  );
  const buildIdentity = JSON.parse(await readFile(join(out, "build-identity.json"), "utf8"));
  assert.equal(buildIdentity.passed, true, "Source and actual build artifacts match");
  model = await startModel();
  scene = await createScene("areal-connection-recovery-");
  env = await scene.environment("web", model.port);
  await persist("fixture-ownership.json", {
    scratch: scene.scratch,
    workspace: scene.project,
    serviceHome: env.AREAL_HARNESS_SERVICE_HOME,
    runnerPid: process.pid,
  });
  desktop = await playwright._electron.launch({
    executablePath: require("electron"),
    args: [...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), join(gui, "app")],
    env,
    timeout: 120000,
  });
  const desktopPage = await desktop.firstWindow();
  await desktopPage.getByTestId("chat-input").first().waitFor({ timeout: 90000 });
  host = new HostClient();
  await host.connect(env.AREAL_HARNESS_SERVICE_HOME);
  originalHost = await readFixtureHost(env);
  assert.equal(host.hostId, originalHost.hostId);
  assert.equal(host.generation, originalHost.generation);
  await persist("host-identity.json", {
    hostId: host.hostId,
    generation: host.generation,
    pid: originalHost.pid,
    electronPid: desktop.process().pid,
  });
  const { port } = JSON.parse(
    await readFile(join(env.AREAL_HARNESS_SERVICE_HOME, "host/web-bind.json"), "utf8"),
  );
  browser = await playwright.chromium.launch({
    executablePath: process.env.AREAL_CHROMIUM || undefined,
    args: process.getuid?.() === 0 ? ["--no-sandbox"] : [],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
  });
  await context.routeWebSocket(/\/host\/socket$/, traceSocket);
  await context.addInitScript(installHostTransportBarrier);
  await context.addInitScript(() => {
    globalThis.connectionJourneyFailures = [];
    const observe = () => {
      const startup = document.querySelector('[data-testid="startup-loading"]');
      if (startup?.querySelector('[role="alert"]')) {
        const text = startup.querySelector('[role="alert"]').textContent;
        if (!globalThis.connectionJourneyFailures.includes(text))
          globalThis.connectionJourneyFailures.push(text);
      }
    };
    new MutationObserver(observe).observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    const gate = { response: "hold" };
    globalThis.connectionJourneyGate = gate;
    let selected = false;
    globalThis.connectionJourneyBarrier = globalThis.createHostTransportBarrier((frame) => {
      if (selected || frame.method !== "shell.subscribe") return null;
      selected = true;
      gate.onResponse = (reply) => {
        gate.identity = {
          connectionId: reply.result?.connectionId,
          gatewayGeneration: reply.result?.gatewayGeneration,
        };
        gate.errorCode = reply.error?.code ?? null;
      };
      return gate;
    });
  });
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(`http://127.0.0.1:${port}/`);
  const pending = page.getByText(/areal host web approve [0-9a-f-]{36}/);
  await pending.waitFor({ timeout: 60000 });
  const device = (await pending.innerText()).match(/approve ([0-9a-f-]{36})/)[1];
  await execute(
    coreBin,
    ["host", "web", "approve", device, "--scope", "observe,submit,approve,manage"],
    { env, timeout: 20000 },
  );
  stage = "loadingWithoutFalseFailure";
  await page.getByText("检查批准状态").click();
  await page.waitForFunction(() => !!globalThis.connectionJourneyGate?.responseHit);
  await page.getByTestId("startup-loading").waitFor();
  const held = await page.evaluate(() => {
    const gate = globalThis.connectionJourneyGate;
    return {
      requestId: gate.requestId,
      responseHit: gate.responseHit,
      identity: gate.identity,
      errorCode: gate.errorCode,
    };
  });
  assert.equal(held.requestId, held.responseHit);
  assert.equal(held.errorCode, null);
  assert.equal(held.identity.connectionId, currentPair().identity.connectionId);
  assert.equal(held.identity.gatewayGeneration, host.generation);
  const loading = await visibleState();
  await page.screenshot({ path: join(out, "loading.png") });
  await persist("loading-observation.json", { held, loading });
  report.faults.loadingWithoutFalseFailure = {
    injectionReached: true,
    evidence: ["loading-observation.json"],
    requestId: held.requestId,
    connectionId: held.identity.connectionId,
  };
  await save();
  targetAssertion(
    "loading-no-false-failure",
    loading.startupFailure === false && loading.observedFailures.length === 0,
    "A held successful shell baseline must remain loading without any failure alert",
  );
  await page.evaluate(() => globalThis.connectionJourneyBarrier.restore());
  await page.getByTestId("chat-input").first().waitFor({ timeout: 60000 });
  await pass(stage, { held, loading }, ["loading.png", "loading-observation.json"]);

  stage = explorationMode ? "prerequisites" : "automaticRecovery";
  page.once("dialog", (dialog) => dialog.accept(scene.project));
  const categories = page.locator('button[aria-label="项目分类"]');
  if ((await categories.getAttribute("aria-expanded")) === "false") await categories.click();
  await page.locator('button[aria-label="打开项目"]').click();
  const choice = page.getByRole("menuitem").first();
  if (await choice.isVisible().catch(() => false)) await choice.click();
  // 打开项目本身会选中项目并清空 Thread；直接使用该空草稿，不再点击悬停工具栏的新建按钮。
  const workbench = page.getByTestId("areal-workbench");
  const { projectId, uiProjectId } = await until(async () => {
    const alias = await workbench.getAttribute("data-project-id");
    const status = await host.status();
    const matches = status.projects.filter(
      ({ registration }) =>
        registration.workspace === scene.project &&
        registration.source.kind === "gui" &&
        registration.source.legacyProjectId === alias,
    );
    if (!matches.length) return false;
    assert.equal(matches.length, 1, "The selected GUI alias has exactly one Host registration");
    const registration = matches[0].registration;
    assert.equal(
      registration.source.profile,
      env.AREAL_GUI_USER_DATA,
      "GUI alias belongs to this isolated profile",
    );
    return { projectId: registration.projectId, uiProjectId: alias };
  }, "Selected project belongs to this fixture workspace");
  await ready(uiProjectId);
  assert.equal(
    await workbench.getAttribute("data-thread-id"),
    "",
    "The regression requires an empty project without a Thread",
  );
  await page.getByRole("button", { name: "选择模型", exact: true }).click();
  await page.getByRole("radio", { name: "fixture", exact: true }).click();
  const modelSelection = await page
    .getByRole("button", { name: "选择模型", exact: true })
    .innerText();
  if (explorationMode) {
    await exploreRecovery({ projectId, uiProjectId, modelSelection });
  } else {
    const draft = "连接恢复后继续这条草稿";
    await page.getByTestId("chat-input").first().fill(draft);
    await sendReady(page);
    const beforeIdle = await until(async () => {
      const state = await projectStatus(projectId);
      return state.state === "ready" && state.serviceGeneration && state;
    }, "Idle-recovery prerequisite: the UI-triggered activation must reach authoritative Host ready with a Core generation before reclamation");
    const idleRequestId = randomUUID();
    const idle = await host.stopProject(
      idleRequestId,
      projectId,
      beforeIdle.serviceGeneration,
      "ifIdle",
      false,
    );
    assert.equal(idle.state, "completed", "The exact idle reclamation request settles");
    const stopped = await until(async () => {
      const state = await projectStatus(projectId);
      return state.state === "stopped" && !state.scheduleActivationSuppressed && state;
    }, "Host confirms idle reclamation without explicit-stop intent");
    const idleUi = await usable(uiProjectId);
    assert.equal(await readInput(), draft, "Idle reclamation preserves the editable unsent draft");
    const replacement = await disconnectBrowser();
    const successorBaseline = wire.find(
      (entry) =>
        entry.method === "shell.subscribe" &&
        entry.connectionId === replacement.after.connectionId &&
        entry.projects,
    );
    const successorProject = successorBaseline.projects.find(
      (item) => item.projectId === projectId,
    );
    assert.equal(
      successorProject?.state,
      "stopped",
      "The successor baseline must actually encounter the idle project",
    );
    assert.equal(successorProject.scheduleActivationSuppressed, false);
    const successorShell = {
      requestId: successorBaseline.id,
      connectionId: successorBaseline.connectionId,
      gatewayGeneration: successorBaseline.gatewayGeneration,
      project: successorProject,
    };
    await persist("idle-socket-transition.json", {
      projectId,
      uiProjectId,
      idleRequestId,
      idleState: idle.state,
      beforeIdle,
      stopped,
      idleUi,
      replacement,
      successorShell,
    });
    report.faults.automaticRecovery = {
      injectionReached: true,
      evidence: ["idle-socket-transition.json"],
      idleRequestId,
      connectionId: replacement.after.connectionId,
    };
    await save();
    const recoveryProgress = { projectId, connectionId: replacement.after.connectionId };
    const { successorActivation, recovered, successorReadyShell } = await (async () => {
      try {
        const activation = await until(
          () =>
            wire.find(
              (entry) =>
                entry.method === "project.activate" &&
                entry.connectionId === replacement.after.connectionId &&
                entry.projectId === projectId,
            ),
          "The successor Renderer automatically activates this idle project without a click",
          30000,
          "idle-automatic-recovery",
        );
        recoveryProgress.activation = activation;
        await until(
          () => {
            if (activation.errorCode)
              throw Object.assign(
                new Error("Successor activation request failed at the Host boundary"),
                { code: activation.errorCode },
              );
            if (!activation.activation) return false;
            assert.equal(
              activation.activation.projectId,
              projectId,
              "Activation response belongs to the requested project",
            );
            assert.ok(
              ["pending", "ready"].includes(activation.activation.state),
              "Successor activation has a valid nonblocked response",
            );
            return true;
          },
          "The original successor activation receives its Host response",
          30000,
          undefined,
          true,
        );
        const terminal = await until(
          async () => {
            const state = await projectStatus(projectId);
            const shell = wire.findLast(
              (entry) =>
                entry.connectionId === replacement.after.connectionId &&
                entry.projects?.some((item) => item.projectId === projectId),
            );
            const projected = shell?.projects.find((item) => item.projectId === projectId);
            Object.assign(recoveryProgress, {
              host: state,
              shell: projected,
              shellGatewayGeneration: shell?.gatewayGeneration,
            });
            return (
              state.state === "ready" &&
              state.serviceGeneration &&
              projected?.state === "ready" &&
              projected.serviceGeneration === state.serviceGeneration &&
              shell.gatewayGeneration === replacement.after.generation && {
                recovered: state,
                successorReadyShell: shell,
              }
            );
          },
          "Successor activation must settle to matching authoritative Host and same-socket shell Core generations",
          60000,
          "idle-automatic-recovery",
        );
        await usable(uiProjectId);
        return { successorActivation: activation, ...terminal };
      } finally {
        await persist("successor-recovery-progress.json", recoveryProgress);
        report.faults.automaticRecovery.evidence.push("successor-recovery-progress.json");
      }
    })();
    const afterRecovery = await visibleState();
    assert.equal(afterRecovery.startupFailure, false);
    assert.deepEqual(afterRecovery.observedFailures, []);
    await page.screenshot({ path: join(out, "automatic-recovery.png") });
    await pass(
      stage,
      {
        projectId,
        uiProjectId,
        idleRequestId,
        recovered,
        replacement,
        successorActivation,
        successorReadyShell,
        afterRecovery,
      },
      ["idle-socket-transition.json", "successor-recovery-progress.json", "automatic-recovery.png"],
    );

    stage = "draftAndSelectionPreserved";
    assert.equal(await readInput(), draft);
    assert.equal(await workbench.getAttribute("data-project-id"), uiProjectId);
    assert.equal(await workbench.getAttribute("data-thread-id"), "");
    assert.equal(
      await page.getByRole("button", { name: "选择模型", exact: true }).innerText(),
      modelSelection,
    );
    await pass(
      stage,
      {
        projectId,
        uiProjectId,
        threadId: null,
        draftPreserved: true,
        modelSelectionPreserved: true,
      },
      ["automatic-recovery.png"],
    );

    stage = "continuedSubmission";
    await sendReady(page);
    await page.getByTestId("chat-input").first().press("Enter");
    const threadId = await until(
      () => workbench.getAttribute("data-thread-id"),
      "First send publishes the authoritative Thread identity",
    );
    const continued = await settleTurn(threadId, draft);
    const firstSubmission = wire.findLast(
      (entry) =>
        entry.method === "session.send" &&
        entry.projectId === projectId &&
        entry.admissionState === "accepted",
    );
    const creation = wire.findLast(
      (entry) =>
        entry.method === "session.create" &&
        entry.projectId === projectId &&
        entry.admissionState === "accepted",
    );
    assert.ok(firstSubmission?.commandId, "The original first-message send command was accepted");
    assert.ok(creation?.commandId, "The Thread creation command was accepted separately");
    await page.screenshot({ path: join(out, "continued-submission.png") });
    await pass(
      stage,
      {
        projectId,
        ...continued,
        requestId: firstSubmission.commandId,
        createCommandId: creation.commandId,
        connectionId: firstSubmission.connectionId,
      },
      ["continued-submission.png"],
    );

    stage = "unknownNotReplayed";
    const unknownText = "触发 UNKNOWN 核对";
    const beforeUnknown = wire.length;
    unknown.armed = true;
    await page.getByTestId("chat-input").first().fill(unknownText);
    await sendReady(page);
    await page.getByTestId("chat-input").first().press("Enter");
    await until(() => unknown.dropped, "Fault injection drops this exact accepted send response");
    assert.ok(unknown.requestId && unknown.connectionId);
    await ready(uiProjectId);
    const settledUnknown = await settleTurn(threadId, unknownText);
    const reconciliation = await until(
      () =>
        wire.findLast(
          (entry) =>
            entry.method === "command.read" &&
            entry.queriedCommandId === unknown.requestId &&
            entry.receipt?.commandId === unknown.requestId &&
            entry.receipt.admissionState === "accepted" &&
            entry.receipt.submissionUnknown === false,
        ),
      "Renderer reconciles the original UNKNOWN command through the persistent Host receipt",
    );
    assert.equal(reconciliation.receipt.method, "session.send");
    assert.equal(reconciliation.receipt.threadId, threadId);
    assert.equal(reconciliation.receipt.turnId, settledUnknown.turnId);
    assert.notEqual(reconciliation.connectionId, unknown.connectionId);
    await until(
      async () => (await readInput()) === "",
      "Reconciled original submission clears its input draft",
    );
    const nextDraft = "UNKNOWN 核对后继续编辑但不发送";
    await page.getByTestId("chat-input").first().fill(nextDraft);
    await sendReady(page);
    assert.equal(
      await readInput(),
      nextDraft,
      "Reconciliation leaves the composer editable with the new draft intact",
    );
    const sendAttempts = wire
      .slice(beforeUnknown)
      .filter((entry) => entry.method === "session.send");
    assert.equal(
      sendAttempts.length,
      1,
      "No new ID or original-ID session.send replay after UNKNOWN",
    );
    assert.equal(sendAttempts[0].commandId, unknown.requestId);
    assert.equal(await workbench.getAttribute("data-thread-id"), threadId);
    await page.screenshot({ path: join(out, "unknown-reconciled.png") });
    await pass(
      stage,
      {
        ...unknown,
        ...settledUnknown,
        sendAttempts,
        reconciliation,
        originalDraftCleared: true,
        nextDraftEditable: true,
        nextDraftSendReady: true,
      },
      ["unknown-reconciled.png"],
    );

    stage = "explicitStopRespected";
    const beforeStop = await projectStatus(projectId);
    const stopRequestId = randomUUID();
    const stop = await host.stopProject(
      stopRequestId,
      projectId,
      beforeStop.serviceGeneration,
      "ifIdle",
      true,
    );
    assert.equal(stop.state, "completed");
    await until(async () => {
      const state = await projectStatus(projectId);
      return state.state === "stopped" && state.scheduleActivationSuppressed;
    }, "Explicit project stop is authoritative");
    const stopReplacement = await disconnectBrowser();
    const stopBaseline = wire.findLast(
      (entry) =>
        entry.method === "shell.subscribe" &&
        entry.connectionId === stopReplacement.after.connectionId,
    );
    const stopProjection = stopBaseline.projects.find((item) => item.projectId === projectId);
    assert.equal(stopProjection.state, "stopped");
    assert.equal(stopProjection.scheduleActivationSuppressed, true);
    // 给自动恢复完成一次处理周期；观察期间不断读取原项目，任何重新启动都立即失败。
    const observationEnd = Date.now() + 3000;
    do {
      const state = await projectStatus(projectId);
      assert.equal(
        state.state,
        "stopped",
        "Socket replacement cannot resume an explicitly stopped project",
      );
      assert.equal(state.scheduleActivationSuppressed, true);
      await new Promise((done) => setTimeout(done, 100));
    } while (Date.now() < observationEnd);
    await page.screenshot({ path: join(out, "explicit-stop.png") });
    await pass(
      stage,
      {
        projectId,
        stopRequestId,
        stopState: stop.state,
        stopReplacement,
        stopProjection,
        observationMs: 3000,
      },
      ["explicit-stop.png"],
    );
  }
} catch (error) {
  const fact = report.facts.find((item) => item.id === stage);
  if (fact) {
    fact.status = "failed";
    report.reached.push(stage);
  }
  report.firstFailure = {
    stage,
    assertionId: error.journeyAssertion ?? null,
    kind:
      error.journeyFailureKind ??
      (stage === "prerequisites" || (report.faults[stage] && !report.faults[stage].injectionReached)
        ? "prerequisite"
        : "business"),
    message: error.message,
    code: error.code ?? null,
    ...(explorationMode
      ? { action: explorationStep?.op ?? null, stepIndex: explorationStep?.index ?? null }
      : {}),
  };
  await persist("failure.json", report.firstFailure);
  if (fact)
    fact.evidence.push("failure.json", "wire.json", "host-identity.json", "build-identity.json");
  if (fact) fact.evidence.push(...(report.faults[stage]?.evidence ?? []));
  if (page && !page.isClosed()) {
    await page
      .screenshot({ path: join(out, "failure.png") })
      .then(() => fact?.evidence.push("failure.png"))
      .catch(() => {});
    await visibleState()
      .then((value) => persist("failure-ui.json", value))
      .then(() => fact?.evidence.push("failure-ui.json"))
      .catch(() => {});
  }
} finally {
  await persist("wire.json", wire);
  const cleanupErrors = [];
  const cleanup = async (name, action) => {
    try {
      await action();
    } catch (error) {
      cleanupErrors.push({ step: name, message: error.message, code: error.code ?? null });
    }
  };
  await cleanup("transport-barrier", async () => {
    if (page && !page.isClosed())
      await page.evaluate(() => globalThis.connectionJourneyBarrier?.restore());
  });
  await cleanup("browser", async () => {
    await browser?.close();
  });
  host?.close();
  let sameHost = false;
  if (env)
    await cleanup("host-identity", async () => {
      const current = await readFixtureHost(env);
      if (!current) return;
      if (!originalHost) {
        // 启动前置失败尚未捕获身份时，仅认领本脚本创建的隔离目录；正常路径绝不替换原身份。
        assert.equal(stage, "prerequisites");
        assert.equal(env.AREAL_HARNESS_SERVICE_HOME, join(scene.scratch, "web", "registry"));
        originalHost = current;
        originalHostCapturedDuringCleanup = true;
      }
      assert.equal(current.hostId, originalHost.hostId, "Cleanup cannot target a replacement Host");
      assert.equal(
        current.generation,
        originalHost.generation,
        "Cleanup cannot target a replacement generation",
      );
      assert.equal(current.pid, originalHost.pid, "Cleanup cannot target a replacement process");
      sameHost = true;
    });
  // GUI 尚活时完成原停止回执，避免退出中的 idle release 与新 cancel 相互覆盖。
  if (sameHost)
    await cleanup("host-stop", () => stopFixtureHost(coreBin, env.AREAL_HARNESS_SERVICE_HOME, out));
  const pid = desktop?.process()?.pid;
  const cleanupDialog = { prompted: false, fixtureAnswersNativeConfirmation: true };
  const { nativeMessages } = require("@areal/workbench/node/native-i18n");
  const quitPrompts = ["zh-CN", "en"].map((locale) => ({
    message: nativeMessages["quit.question"][locale],
    buttons: ["host.keepAndQuit", "host.stopAndQuit", "common.cancel"].map(
      (id) => nativeMessages[id][locale],
    ),
  }));
  desktop?.on("console", (message) => {
    if (message.text() === "connection-journey:cleanup-keep-and-quit")
      Object.assign(cleanupDialog, {
        prompted: true,
        choice: "keepBackgroundAndQuit",
        response: 0,
      });
  });
  if (desktop)
    await cleanup("electron", () =>
      closeRecordedSmokeApplication(desktop, 20000, async () => {
        // Host 已按原回执停止，退出检查会进入“后台状态未知”的原生三选项；只代替此系统确认，不修改应用状态。
        await desktop.evaluate(({ dialog }, prompts) => {
          dialog.showMessageBox = async (...args) => {
            const options = args.at(-1);
            if (
              !prompts.some(
                (expected) =>
                  options.message === expected.message &&
                  options.buttons?.length === expected.buttons.length &&
                  expected.buttons.every((button, index) => options.buttons[index] === button),
              )
            )
              throw new Error("Unexpected native confirmation during fixture cleanup");
            console.info("connection-journey:cleanup-keep-and-quit");
            return { response: 0 };
          };
        }, quitPrompts);
      }),
    );
  await persist("cleanup-dialog.json", cleanupDialog);
  if (originalHost)
    await cleanup("host-settlement", () =>
      settleFixtureHostAfterQuit(coreBin, env, out, { host: originalHost, pid }),
    );
  if (env)
    await cleanup("process-exit", () =>
      assertApplicationStopped(coreBin, env, { pid, hostPid: originalHost?.pid }),
    );
  if (scene && env)
    await cleanup("synthetic-keychain", () =>
      cleanupSyntheticHostKeychain(env.AREAL_HARNESS_SERVICE_HOME, scene.scratch),
    );
  model?.close();
  // 清理失败保留隔离现场；报告产物始终保留且不含凭据。
  if (scene && !cleanupErrors.length)
    await cleanup("fixture-files", async () => {
      await makeFixtureDirectoriesWritable(scene.scratch);
      await rm(scene.scratch, { recursive: true, force: true, maxRetries: 5 });
    });
  report.cleanup = {
    status: cleanupErrors.length ? "failed" : "passed",
    evidence: ["cleanup.json", "cleanup-dialog.json"],
    errors: cleanupErrors,
    originalHostCapturedDuringCleanup,
    ...(cleanupErrors.length && scene ? { retainedFixture: scene.scratch } : {}),
  };
  await persist("cleanup.json", report.cleanup);
  if (cleanupErrors.length && !report.firstFailure)
    report.firstFailure = { stage: "cleanup", kind: "cleanup", message: cleanupErrors[0].message };
  report.unreached = factIds.filter((id) => !report.reached.includes(id));
  report.status =
    !report.firstFailure &&
    report.facts.every((fact) => fact.status === "passed") &&
    report.cleanup.status === "passed"
      ? "passed"
      : "failed";
  await save();
}
console.log(
  JSON.stringify({
    journeyId: report.journeyId,
    status: report.status,
    firstFailure: report.firstFailure,
    report: reportPath,
  }),
);
process.exitCode = report.status === "passed" ? 0 : 1;
