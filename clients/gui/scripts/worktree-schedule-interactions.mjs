import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { CoreBackend } = require("../app/src/core/backend.cjs");
const scratch = await mkdtemp("/tmp/aw-schedule-");
const userHome = join(scratch, "user"),
  workspaceBase = join(scratch, "workspaces");
await mkdir(join(userHome, ".areal"), { recursive: true });
await mkdir(workspaceBase);
const checks = [],
  requests = [],
  errors = [],
  cases = [],
  stages = [],
  payloads = [];
const phases = new Map();
const text = (message) =>
  typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? []);
const model = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw),
      messages = body.messages ?? [];
    const send = (delta, finish_reason = null) =>
      response.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    const end = () => {
      response.write(
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    };
    const finish = (content) => {
      send({ content });
      send({}, "stop");
      end();
    };
    const tool = (name, args) => {
      assert.ok(
        body.tools?.some((item) => item.function?.name === name),
        "real Core exposes " + name,
      );
      send({
        tool_calls: [
          {
            index: 0,
            id: randomUUID(),
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      });
      send({}, "tool_calls");
      end();
    };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (
      messages.some((message) =>
        text(message).startsWith("Generate a concise semantic session title"),
      ) ||
      !body.tools?.length
    ) {
      finish("Scheduled interaction fixture");
      return;
    }
    const context = messages
      .map(text)
      .findLast((value) => value.includes("Current authoritative goal: "));
    if (!context) throw new Error("scheduled Run must supply authoritative goal context");
    const view = JSON.parse(context.split("Current authoritative goal: ").at(-1)),
      goal = view.goal;
    const kind = goal.objective.match(
      /WT_SCHEDULE_(QUESTION|DENY|ALLOW|RESUME|RESTART|CANCEL)/,
    )?.[1];
    assert.ok(kind, "fixture goal is one of its explicit temporary test cases");
    requests.push({
      kind,
      threadId: view.threadId,
      goalId: goal.id,
      revision: view.revision,
      hasAnswer: messages.some(
        (message) => message.role === "tool" && text(message).includes("verified answer"),
      ),
    });
    if (goal.limitsPending) {
      tool("goal_set_limits", { expectedRevision: view.revision, sources: {} });
      return;
    }
    if (goal.report?.status === "complete") {
      finish(`WT_SCHEDULE_${kind}_DONE`);
      return;
    }
    if (kind === "RESUME") {
      if (!phases.has(goal.id)) {
        phases.set(goal.id, kind);
        tool("goal_update", {
          expectedRevision: view.revision,
          status: "blocked",
          summary: "Fixture awaits explicit same-Run resume.",
          evidence: ["Reached decision boundary."],
          remaining: ["Resume explicitly"],
          blocker: "Explicit user decision",
        });
        return;
      }
      if (goal.report?.status === "blocked" && goal.reportTurnId === goal.activeTurnId) {
        finish("Fixture waits for explicit same-Run resume.");
        return;
      }
      tool("goal_update", {
        expectedRevision: view.revision,
        status: "complete",
        summary: "WT_SCHEDULE_RESUME_DONE",
        evidence: ["Same Run resumed through supported taskResumeRun."],
        remaining: [],
      });
      return;
    }
    const phaseKey = kind === "RESTART" ? `${goal.id}:${goal.activeTurnId}` : goal.id;
    if (!phases.has(phaseKey)) {
      phases.set(phaseKey, kind);
      if (["QUESTION", "RESTART", "CANCEL"].includes(kind))
        tool("ask_user_question", {
          questions: [
            {
              id: "choice",
              title: "Confirm scheduled Run identity",
              options: ["verified answer", "stop"],
              allowFreeText: false,
            },
          ],
        });
      else
        tool("fs_create", {
          path: `${kind.toLowerCase()}-payload.txt`,
          text: "temporary fixture only",
        });
      return;
    }
    assert.notEqual(kind, "CANCEL", "cancelled Run must never resume its model loop");
    if (["QUESTION", "RESTART"].includes(kind))
      assert.ok(
        messages.some(
          (message) => message.role === "tool" && text(message).includes("verified answer"),
        ),
        "model receives original answered interaction",
      );
    tool("goal_update", {
      expectedRevision: view.revision,
      status: "complete",
      summary: `WT_SCHEDULE_${kind}_DONE`,
      evidence: [
        kind === "QUESTION"
          ? "Core delivered the original scheduled question answer."
          : "Core returned the original permission-controlled file-tool result.",
      ],
      remaining: [],
    });
  } catch (error) {
    errors.push({ name: error.name, message: error.message });
    response.destroy(error);
  }
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const config = join(userHome, ".areal/config.toml");
await writeFile(
  config,
  `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n[permissions]\nmode="ASK_PERMISSIONS"\nask=["fs_create"]\n`,
);
const deployment = join(scratch, "desktop.json");
await writeFile(
  deployment,
  JSON.stringify({
    profiles: [
      {
        id: "schedule-fixture",
        revision: "v1",
        displayName: "Schedule fixture",
        instructions:
          "Run only the exact deterministic fixture request and report observed results.",
        approvalTools: ["fs_create"],
      },
    ],
  }),
);
const options = {
  binary: process.env.AREAL_CORE_BIN || join(root, "target/debug/areal"),
  home: join(scratch, "desktop"),
  harnessHome: join(scratch, "registry"),
  userHome,
  config,
  desktopConfig: deployment,
  desktopProcesses: true,
  defaultProfile: { id: "schedule-fixture", revision: "v1" },
};
let backend = new CoreBackend(options),
  passed = false,
  failure;
const until = async (predicate, label, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timeout " + label);
};
const task = (projectId, taskId) =>
  backend.command("manage", { projectId, operation: "task", taskId });
const rejectedSchedule = (error) =>
  error.code === "SCHEDULE_WORKSPACE_REQUIRED" ||
  (error.code === "WORKTREE_REQUIRED" &&
    error.cause?.code === "SCHEDULE_WORKSPACE_REQUIRED" &&
    error.outcome?.kind === "noMutation");
const readThread = async (projectId, threadId) => {
  await backend.command("open", { projectId, threadId });
  return backend.snapshot().projects.find((project) => project.id === projectId)?.state?.threads?.[
    threadId
  ];
};
const interaction = async (projectId, threadId, kind) => {
  await backend.command("open", { projectId, threadId });
  return backend
    .snapshot()
    .projects.find((project) => project.id === projectId)
    ?.state?.interactions?.[threadId]?.data?.find(
      (value) => value.status === "pending" && value.kind === kind,
    );
};
async function prepare(kind) {
  const prepared = await backend.command("projectless", {
    operation: "prepare",
    requestId: randomUUID(),
  });
  const created = await backend.command("manage", {
    projectId: prepared.projectId,
    operation: "taskCreate",
    requestId: randomUUID(),
    mode: "scheduled",
    objective: `WT_SCHEDULE_${kind}`,
    interactionMode: "interactive",
    schedule: { at: Math.floor(Date.now() / 1000) + 86400 },
  });
  const entry = {
    kind,
    projectId: prepared.projectId,
    cwd: prepared.cwd,
    taskId: created.id,
    anchorThreadId: created.threadId,
  };
  cases.push(entry);
  await backend.command("manage", {
    projectId: entry.projectId,
    operation: "taskRunNow",
    taskId: entry.taskId,
    requestId: randomUUID(),
    expectedRevision: created.revision,
  });
  const run = await until(async () => {
    const value = await task(entry.projectId, entry.taskId);
    return value.runs?.find((run) => run.threadId) && value.runs.find((run) => run.threadId);
  }, kind + " execution Thread");
  entry.runId = run.id;
  entry.threadId = run.threadId;
  assert.notEqual(entry.threadId, entry.anchorThreadId, "scheduled Run owns a fresh Thread");
  const thread = await readThread(entry.projectId, entry.threadId);
  entry.sessionId = thread.sessionId;
  assert.equal(thread.cwd, entry.cwd);
  const reservation = await backend.scheduleAdmission.read(backend.projects.get(entry.projectId));
  assert.ok(reservation.token.startsWith("schedule:"));
  assert.notEqual(
    reservation.token,
    thread.sessionId,
    "reservation token and actual Run Session differ",
  );
  stages.push({
    kind,
    stage: "realRunCreated",
    threadId: entry.threadId,
    sessionId: entry.sessionId,
    reservationToken: reservation.token,
  });
  return entry;
}
async function settle(entry) {
  const value = await until(async () => {
    const value = await task(entry.projectId, entry.taskId);
    return value.runs?.find((run) => run.id === entry.runId)?.status === "completed" && value;
  }, entry.kind + " Run completion");
  const thread = await readThread(entry.projectId, entry.threadId);
  assert.ok(
    thread.turns.some((turn) =>
      turn.items?.some(
        (item) =>
          item.type === "agentMessage" && item.text?.includes(`WT_SCHEDULE_${entry.kind}_DONE`),
      ),
    ),
    "real model final answer appears in original Run Thread",
  );
  stages.push({
    kind: entry.kind,
    stage: "completed",
    runId: entry.runId,
    threadId: entry.threadId,
    turnId: thread.turns.at(-1).id,
  });
  return { task: value, thread };
}
try {
  await backend.init();
  await backend.command("projectless", { operation: "directory", path: workspaceBase });
  const question = await prepare("QUESTION");
  const pending = await until(
    () => interaction(question.projectId, question.threadId, "question"),
    "scheduled question",
  );
  stages.push({
    kind: "QUESTION",
    stage: "pendingQuestion",
    requestId: pending.requestId,
    turnId: pending.turnId,
  });
  for (const [label, threadId, requestId] of [
    ["wrongSession", question.anchorThreadId, pending.requestId],
    ["wrongRequest", question.threadId, randomUUID()],
  ]) {
    await assert.rejects(
      backend.command("respond", {
        projectId: question.projectId,
        threadId,
        requestId,
        answers: { choice: "verified answer" },
      }),
      rejectedSchedule,
    );
    assert.equal(
      (await interaction(question.projectId, question.threadId, "question")).requestId,
      pending.requestId,
      "rejected spoof leaves original Core request pending",
    );
    stages.push({ kind: "QUESTION", stage: "rejectedBeforeDispatch", case: label });
  }
  await backend.command("respond", {
    projectId: question.projectId,
    threadId: question.threadId,
    requestId: pending.requestId,
    answers: { choice: "verified answer" },
  });
  const completed = await settle(question);
  const answered = backend
    .snapshot()
    .projects.find((project) => project.id === question.projectId)
    .state.interactions[question.threadId].data.find(
      (value) => value.requestId === pending.requestId,
    );
  assert.equal(answered.response.answers.choice, "verified answer");
  checks.push(
    "desktop respond reaches the original live Core scheduled question and original model loop completes",
  );
  let continueError;
  try {
    await backend.command("continue", {
      projectId: question.projectId,
      threadId: question.threadId,
      expectedTurnId: completed.thread.turns.at(-1).id,
      expectedConfigRevision: completed.thread.desktop.configuration.revision,
      requestId: randomUUID(),
    });
  } catch (error) {
    continueError = error;
  }
  assert.ok(
    continueError,
    "ordinary Continue is not a supported operation on Goal-owned scheduled Runs",
  );
  assert.ok(rejectedSchedule(continueError), "completed Run cannot use a stale schedule author");
  await assert.rejects(
    backend.command("respond", {
      projectId: question.projectId,
      threadId: question.threadId,
      requestId: pending.requestId,
      answers: { choice: "verified answer" },
    }),
    rejectedSchedule,
  );
  stages.push({ kind: "QUESTION", stage: "completedRunRejectsStaleInteractionAndContinue" });
  checks.push(
    "wrong Session, wrong request, and completed Run stale interaction/ordinary Continue are rejected before dispatch; original pending request survives spoof attempts",
  );
  const denied = await prepare("DENY");
  const approval = await until(
    () => interaction(denied.projectId, denied.threadId, "approval"),
    "scheduled approval",
  );
  await backend.command("respond", {
    projectId: denied.projectId,
    threadId: denied.threadId,
    requestId: approval.requestId,
    decision: "deny",
  });
  const deniedResult = await settle(denied);
  const deniedTool = deniedResult.thread.turns
    .flatMap((turn) => turn.items ?? [])
    .find((item) => item.type === "dynamicToolCall" && item.tool === "fs_create");
  assert.equal(deniedTool.success, false);
  assert.equal(deniedTool.execution.outcome, "failed");
  const denial = JSON.parse(deniedTool.contentItems.map((item) => item.text ?? "").join("\n"));
  assert.equal(denial.error.code, "PERMISSION_DENIED");
  assert.equal(denial.error.message, "tool approval denied");
  await assert.rejects(access(join(denied.cwd, "deny-payload.txt")), { code: "ENOENT" });
  stages.push({
    kind: "DENY",
    stage: "deniedBeforePayload",
    outcome: deniedTool.execution.outcome,
  });
  checks.push(
    "real scheduled approval denial resumes original Run and returns PERMISSION_DENIED/tool approval denied before its file payload",
  );
  const allowed = await prepare("ALLOW");
  const allowApproval = await until(
    () => interaction(allowed.projectId, allowed.threadId, "approval"),
    "scheduled allowOnce approval",
  );
  await backend.command("respond", {
    projectId: allowed.projectId,
    threadId: allowed.threadId,
    requestId: allowApproval.requestId,
    decision: "allowOnce",
  });
  const allowResult = await settle(allowed);
  const allowTool = allowResult.thread.turns
    .flatMap((turn) => turn.items ?? [])
    .find((item) => item.type === "dynamicToolCall" && item.tool === "fs_create");
  const nativeError = (allowTool.contentItems ?? []).map((item) => item.text ?? "").join("\n");
  const nativeSucceeded = allowTool.success === true;
  if (nativeSucceeded)
    assert.equal(
      await readFile(join(allowed.cwd, "allow-payload.txt"), "utf8"),
      "temporary fixture only",
    );
  else {
    assert.match(nativeError, /cannot start sandboxed process.*No such file or directory/);
    await assert.rejects(access(join(allowed.cwd, "allow-payload.txt")), { code: "ENOENT" });
  }
  payloads.push({
    kind: "ALLOW",
    nativeSucceeded,
    toolOutcome: allowTool.execution.outcome,
    ...(!nativeSucceeded
      ? { environmentBlocker: "Runtime reaper requires unavailable /proc/self/task/<pid>/children" }
      : {}),
  });
  checks.push(
    nativeSucceeded
      ? "real allowOnce admits and executes its temporary file payload"
      : "real allowOnce passes scheduled author admission and reaches unchanged Runtime; payload is blocked by the independently confirmed missing /proc children interface",
  );
  const resumed = await prepare("RESUME");
  await until(async () => {
    const value = await task(resumed.projectId, resumed.taskId);
    return value.runs.find((run) => run.id === resumed.runId)?.status === "blocked";
  }, "Run reaches explicit decision boundary");
  const beforeResume = await readThread(resumed.projectId, resumed.threadId);
  await backend.disconnect();
  backend = new CoreBackend(options);
  await backend.init();
  await backend.command("connect", { projectId: resumed.projectId });
  const current = await task(resumed.projectId, resumed.taskId);
  await backend.command("manage", {
    projectId: resumed.projectId,
    operation: "taskResumeRun",
    taskId: resumed.taskId,
    expectedRevision: current.revision,
    expectedRunId: resumed.runId,
    requestId: randomUUID(),
  });
  const afterResume = await settle(resumed);
  assert.equal(afterResume.task.runs.at(-1).id, resumed.runId);
  assert.equal(afterResume.task.runs.at(-1).threadId, resumed.threadId);
  assert.ok(
    afterResume.thread.turns.length > beforeResume.turns.length,
    "same Run has a fresh resumed Turn",
  );
  checks.push(
    "after desktop-manager reconnect, supported taskResumeRun resumes blocked real scheduled Run in the same Thread, creates a fresh Turn, and completes its model loop",
  );
  const restart = await prepare("RESTART");
  const stale = await until(
    () => interaction(restart.projectId, restart.threadId, "question"),
    "question before host disconnect",
  );
  await backend.disconnect();
  backend = new CoreBackend(options);
  await backend.init();
  await backend.command("connect", { projectId: restart.projectId });
  await assert.rejects(
    backend.command("respond", {
      projectId: restart.projectId,
      threadId: restart.threadId,
      requestId: stale.requestId,
      answers: { choice: "verified answer" },
    }),
    rejectedSchedule,
  );
  const paused = await task(restart.projectId, restart.taskId);
  stages.push({
    kind: "RESTART",
    stage: "staleQuestionRejectedAfterDisconnect",
    runStatus: paused.runs.at(-1).status,
    runReason: paused.runs.at(-1).reason,
  });
  await backend.command("manage", {
    projectId: restart.projectId,
    operation: "taskResumeRun",
    taskId: restart.taskId,
    expectedRevision: paused.revision,
    expectedRunId: restart.runId,
    requestId: randomUUID(),
  });
  const fresh = await until(async () => {
    const value = await interaction(restart.projectId, restart.threadId, "question");
    return value && value.requestId !== stale.requestId && value;
  }, "fresh question after same-Run resume");
  assert.notEqual(fresh.turnId, stale.turnId);
  await assert.rejects(
    backend.command("respond", {
      projectId: restart.projectId,
      threadId: restart.threadId,
      requestId: stale.requestId,
      answers: { choice: "verified answer" },
    }),
    rejectedSchedule,
  );
  assert.equal(
    (await interaction(restart.projectId, restart.threadId, "question")).requestId,
    fresh.requestId,
  );
  await backend.command("respond", {
    projectId: restart.projectId,
    threadId: restart.threadId,
    requestId: fresh.requestId,
    answers: { choice: "verified answer" },
  });
  const recovered = await settle(restart);
  assert.equal(recovered.task.runs.at(-1).id, restart.runId);
  checks.push(
    "host disconnect pauses pending Run; old request is rejected, taskResumeRun issues a fresh question in the same Run, stale replay stays rejected, and fresh answer completes",
  );
  const cancelled = await prepare("CANCEL");
  const cancelledQuestion = await until(
    () => interaction(cancelled.projectId, cancelled.threadId, "question"),
    "live question before explicit task cancellation",
  );
  const beforeCancel = await task(cancelled.projectId, cancelled.taskId);
  await backend.command("manage", {
    projectId: cancelled.projectId,
    operation: "taskCancel",
    taskId: cancelled.taskId,
    expectedRevision: beforeCancel.revision,
    requestId: randomUUID(),
  });
  const terminal = await until(async () => {
    const value = await task(cancelled.projectId, cancelled.taskId);
    return (
      value.cancelled === true &&
      value.runs.find((run) => run.id === cancelled.runId)?.status === "cancelled" &&
      value
    );
  }, "explicit cancellation settles original Run as cancelled");
  const cancelledThread = await readThread(cancelled.projectId, cancelled.threadId);
  const cancelledInteractions = backend
    .snapshot()
    .projects.find((project) => project.id === cancelled.projectId).state.interactions[
    cancelled.threadId
  ].data;
  const originalCancelledQuestion = cancelledInteractions.find(
    (value) => value.requestId === cancelledQuestion.requestId,
  );
  assert.ok(originalCancelledQuestion, "original question remains available for inspection");
  assert.notEqual(
    originalCancelledQuestion.status,
    "pending",
    "explicit task cancellation makes original question nonactionable",
  );
  assert.equal(cancelledThread.status.type, "idle", "cancelled execution resources have settled");
  await assert.rejects(
    backend.command("respond", {
      projectId: cancelled.projectId,
      threadId: cancelled.threadId,
      requestId: cancelledQuestion.requestId,
      answers: { choice: "verified answer" },
    }),
    rejectedSchedule,
  );
  let cancelResumeError;
  try {
    await backend.command("manage", {
      projectId: cancelled.projectId,
      operation: "taskResumeRun",
      taskId: cancelled.taskId,
      expectedRevision: terminal.revision,
      expectedRunId: cancelled.runId,
      requestId: randomUUID(),
    });
  } catch (error) {
    cancelResumeError = error;
  }
  assert.ok(cancelResumeError, "taskResumeRun cannot reactivate a cancelled Task");
  assert.equal(
    cancelResumeError.submissionUnknown,
    false,
    "cancelled-task resume rejection has a known outcome",
  );
  const afterCancelResume = await task(cancelled.projectId, cancelled.taskId);
  assert.equal(afterCancelResume.cancelled, true);
  assert.equal(afterCancelResume.runs.length, terminal.runs.length);
  assert.equal(
    afterCancelResume.runs.find((run) => run.id === cancelled.runId).status,
    "cancelled",
  );
  assert.equal(
    (await readThread(cancelled.projectId, cancelled.threadId)).turns.length,
    cancelledThread.turns.length,
    "rejected resume starts no new Turn",
  );
  stages.push({
    kind: "CANCEL",
    stage: "explicitCancellationIsTerminal",
    taskCancelled: afterCancelResume.cancelled,
    runStatus: afterCancelResume.runs.at(-1).status,
    interactionStatus: originalCancelledQuestion.status,
    resumeErrorCode: cancelResumeError.code,
  });
  checks.push(
    "explicit taskCancel while question is pending settles the Run and interaction; stale answer and taskResumeRun are rejected, Task stays cancelled, no new Turn or Run starts",
  );
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  failure = { name: error.name, code: error.code, message: error.message };
  throw error;
} finally {
  for (const entry of cases) {
    try {
      const current = await task(entry.projectId, entry.taskId);
      await backend.command("manage", {
        projectId: entry.projectId,
        operation: "taskCancel",
        taskId: entry.taskId,
        expectedRevision: current.revision,
        requestId: randomUUID(),
      });
    } catch {}
  }
  for (const project of backend.projects.values())
    await project.client?.request("areal/server/drain", { strategy: "cancel" }).catch(() => {});
  await backend.shutdown({ cancel: true }).catch(() => backend.disconnect());
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  const manifest = {
    passed,
    scope:
      "real desktop CoreBackend and real Core native interaction/Goal protocol; deterministic local model boundary; no Electron",
    platform: process.platform,
    node: process.version,
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    binary: options.binary,
    binarySha256: createHash("sha256")
      .update(await readFile(options.binary))
      .digest("hex"),
    scratch,
    checks,
    stages,
    cases,
    requests,
    errors,
    payloads,
    failure,
    limitations: [
      "No macOS Electron or real provider validation",
      "Ordinary Continue remains unsupported on Goal-owned scheduled Run Threads",
      "A Runtime-reaper payload failure is not successful native file execution",
    ],
  };
  await writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ passed, evidence: scratch, checks, payloads, failure }, null, 2));
}
