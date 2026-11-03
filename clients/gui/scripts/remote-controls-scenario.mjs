import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export async function sessionControls({
  rpc: request,
  otherRpc: otherRequest,
  native,
  waitForModel,
  until,
  writeRequestsPerSecond,
}) {
  assert.equal(writeRequestsPerSecond, 5);
  let nextRequestAt = 0;
  const paced =
    (call) =>
    async (...args) => {
      const remaining = nextRequestAt - performance.now();
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
      nextRequestAt = performance.now() + Math.ceil(1000 / writeRequestsPerSecond) + 10;
      return call(...args);
    };
  const rpc = paced(request),
    otherRpc = paced(otherRequest);
  const commands = [];
  const create = async () => {
    const response = await rpc("session.create");
    assert.equal(response.result?.admissionState, "accepted", JSON.stringify(response));
    return response.result.threadId;
  };
  const control = async (threadId, operation, values = {}) => {
    const current = operation.startsWith("goal")
      ? await native("areal/goal/get", { threadId })
      : operation === "steer"
        ? { revision: 0 }
        : await native("areal/queue/list", { threadId });
    const params = { threadId, operation, expectedRevision: current.revision, values };
    const response = await rpc("session.control", params);
    assert.equal(response.result?.admissionState, "accepted", JSON.stringify(response));
    assert.equal(response.result.target.operation, operation);
    commands.push({ params, result: response.result });
    return response.result;
  };
  const threadId = await create();
  const configuration = (await native("areal/thread/inspect", { threadId })).configuration;
  const holdText = `REMOTE_CONTROL_HOLD_${randomUUID()}`;
  const started = await rpc("session.send", {
    threadId,
    text: holdText,
    expectedConfigRevision: configuration.revision,
  });
  assert.equal(started.result?.admissionState, "accepted", JSON.stringify(started));
  await waitForModel(holdText);
  const turnId = started.result.turnId;
  await control(threadId, "queuePause");
  assert.equal((await native("areal/queue/list", { threadId })).paused, true);
  const queueIds = [];
  for (let index = 0; index < 3; index++) {
    const queued = await rpc("session.send", {
      threadId,
      expectedConfigRevision: configuration.revision,
      text: `QUEUE_${index}_${randomUUID()}`,
      enqueue: true,
      expectedTurnId: turnId,
    });
    assert.equal(queued.result?.admissionState, "accepted", JSON.stringify(queued));
    queueIds.push(queued.result.receipt.queueItemId);
  }
  const editedText = `REMOTE_QUEUE_EDIT_${randomUUID()}`;
  await control(threadId, "queueUpdate", { queueItemId: queueIds[0], text: editedText });
  assert.equal(
    (await native("areal/queue/list", { threadId })).items.find((item) => item.id === queueIds[0])
      .input[0].text,
    editedText,
  );
  await control(threadId, "queueReorder", {
    queueItemIds: [queueIds[2], queueIds[0], queueIds[1]],
  });
  assert.deepEqual(
    (await native("areal/queue/list", { threadId })).items
      .filter((item) => item.status === "pending")
      .map((item) => item.id),
    [queueIds[2], queueIds[0], queueIds[1]],
  );
  await control(threadId, "queueRemove", { queueItemId: queueIds[1] });
  assert.equal(
    (await native("areal/queue/list", { threadId })).items.find((item) => item.id === queueIds[1])
      .status,
    "removed",
  );
  await control(threadId, "queueResume");
  assert.equal((await native("areal/queue/list", { threadId })).paused, false);
  await control(threadId, "queueSteer", { queueItemId: queueIds[0], expectedTurnId: turnId });
  const steeredQueue = (await native("areal/queue/list", { threadId })).items.find(
    (item) => item.id === queueIds[0],
  );
  assert.equal(steeredQueue.status, "steered");
  assert.equal(steeredQueue.turnId, turnId);
  const steerText = `REMOTE_STEER_${randomUUID()}`;
  const steer = await control(threadId, "steer", { text: steerText, expectedTurnId: turnId });
  assert.equal(steer.nativeRequestId, undefined);
  await control(threadId, "queueRemove", { queueItemId: queueIds[2] });
  await native("turn/interrupt", { threadId, turnId });
  await until(
    async () =>
      (await native("thread/read", { threadId, includeTurns: true })).thread.turns.find(
        (turn) => turn.id === turnId,
      )?.status !== "inProgress",
    "the exact controlled Turn settles",
  );
  const history = (await native("thread/read", { threadId, includeTurns: true })).thread;
  for (const text of [editedText, steerText])
    assert.equal(
      history.turns
        .flatMap((turn) => turn.items)
        .filter(
          (item) => item.type === "userMessage" && item.content.some((part) => part.text === text),
        ).length,
      1,
    );
  const goalThreadId = await create();
  const objective = `REMOTE_GOAL_${randomUUID()}`;
  const created = await control(goalThreadId, "goalCreate", { objective });
  const goalId = created.receipt.goalId;
  await waitForModel(objective);
  const ownerView = await rpc("session.open", { threadId: goalThreadId });
  assert.equal(ownerView.result.snapshot.goalControlAllowed, true);
  const foreignView = await otherRpc("session.open", { threadId: goalThreadId });
  assert.equal(foreignView.result.snapshot.goalControlAllowed, false);
  const foreign = await otherRpc("session.control", {
    threadId: goalThreadId,
    operation: "goalPause",
    expectedRevision: (await native("areal/goal/get", { threadId: goalThreadId })).revision,
    values: { goalId },
  });
  assert.equal(foreign.error?.code, "TASK_CONTROL_REQUIRED");
  await control(goalThreadId, "goalPause", { goalId });
  await until(async () => {
    const { goal } = await native("areal/goal/get", { threadId: goalThreadId });
    return goal.status === "paused" && !goal.settling;
  }, "the original Goal pause settles");
  await control(goalThreadId, "goalResume", { goalId });
  assert.equal((await native("areal/goal/get", { threadId: goalThreadId })).goal.status, "active");
  await control(goalThreadId, "goalPause", { goalId });
  await until(
    async () => !(await native("areal/goal/get", { threadId: goalThreadId })).goal.settling,
    "the resumed Goal settles before clear",
  );
  await control(goalThreadId, "goalClear", { goalId });
  assert.equal((await native("areal/goal/get", { threadId: goalThreadId })).goal, null);
  for (const command of commands) {
    const duplicate = await rpc("session.control", command.params, command.result.commandId);
    assert.equal(duplicate.result.operationId, command.result.operationId);
    assert.equal(duplicate.result.admissionState, "accepted");
    const read = await rpc("command.read", { commandId: command.result.commandId });
    assert.equal(read.result.operationId, command.result.operationId);
  }
  return { threadId, turnId, goalThreadId, goalId, commands, foreign, history };
}
