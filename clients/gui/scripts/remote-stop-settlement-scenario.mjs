import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

async function waitFor(read, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`Timed out: ${label}`);
}

export async function taskOwnedPreflight({
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

export function assertUnknownSettlement(original, settledTurn) {
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

export async function stopSettlement({
  a,
  native,
  workspace,
  settled,
  startTurn,
  waitForModel,
  control,
  offline,
  journal,
  settlementEvidence,
  taskOwnershipEvidence,
}) {
  const readTurn = async (threadId, turnId) =>
    (await native("thread/read", { threadId, includeTurns: true })).thread.turns.find(
      (turn) => turn.id === turnId,
    );
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
  if (journal) settlementEvidence.hostJournalBeforeQueries = await journal(accepted);
  else settlementEvidence.dispatchesBeforeQueries = await control("dispatches");
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
  if (journal) {
    settlementEvidence.hostJournalAfterQueries = await journal(accepted);
    assert.deepEqual(
      settlementEvidence.hostJournalAfterQueries,
      settlementEvidence.hostJournalBeforeQueries,
    );
    settlementEvidence.replayObservation =
      "original Host journal association and Runtime single effect; physical dispatch count unmeasured";
  } else {
    settlementEvidence.dispatchesAfterQueries = await control("dispatches");
    assert.equal(
      settlementEvidence.dispatchesAfterQueries,
      settlementEvidence.dispatchesBeforeQueries,
    );
  }
  settlementEvidence.afterQueries = await readTurn(threadId, turnId);
  assertUnknownSettlement(settlementEvidence.original, settlementEvidence.afterQueries);
  settlementEvidence.markerContents = await readFile(join(workspace, "effects", marker), "utf8");
  assert.equal(
    settlementEvidence.markerContents,
    "ready",
    "original Runtime invocation must append exactly once",
  );
  await taskOwnedPreflight({
    rpc: (...args) => a.rpc(...args),
    native,
    operation: "turn.stop",
    waitForModel,
    evidence: taskOwnershipEvidence,
  });
  await offline(settlementEvidence);
  assert.equal(
    (await a.rpc("command.read", { commandId: accepted.commandId })).result.admissionState,
    "accepted",
  );
  settlementEvidence.businessAssertionsPassed = true;
}
