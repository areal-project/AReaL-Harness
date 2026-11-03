import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function taskQuestion(native, workspace, until, extra = "") {
  const effect = randomUUID();
  const created = await native("areal/task/create", {
    requestId: randomUUID(),
    mode: "background",
    objective: `RC08_TASK:${effect} ${extra}`,
    interactionMode: "asynchronous",
    maxTurns: 8,
  });
  let question;
  await until(async () => {
    question = (await native("areal/channel/read", { taskId: created.id, limit: 100 })).data.find(
      (item) => item.kind === "question" && item.status === "pending",
    );
    return question;
  }, "the original Task question is pending");
  const path = (suffix) => join(workspace, "effects", `${effect}-${suffix}`);
  await until(async () => {
    try {
      return (await readFile(path("pending"), "utf8")) === "x";
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }, "Runtime performs useful work while the original question is pending");
  const task = await native("areal/task/read", { taskId: created.id });
  const run = task.runs.find((run) => run.id === question.runId);
  assert.equal(run.status, "running");
  await assert.rejects(readFile(path("work")), { code: "ENOENT" });
  return {
    taskId: created.id,
    runId: run.id,
    questionId: question.id,
    threadId: run.threadId,
    effect,
    path,
    target: { taskId: created.id, runId: run.id, questionId: question.id },
    release: () => writeFile(path("release"), "release"),
  };
}
export async function taskScenario({ rpc: call, otherRpc: otherCall, native, workspace, until }) {
  let nextWrite = 0;
  const paced =
    (send) =>
    async (method, ...args) => {
      if (["session.create", "task.pause", "task.question.reply"].includes(method)) {
        const left = nextWrite - performance.now();
        if (left > 0) await new Promise((done) => setTimeout(done, left));
        nextWrite = performance.now() + 210;
      }
      return send(method, ...args);
    };
  const rpc = paced(call),
    otherRpc = paced(otherCall);
  const refused = (response) =>
    assert.ok(
      response.error || response.result?.admissionState === "rejected",
      JSON.stringify(response),
    );
  const created = await rpc("session.create");
  assert.equal(created.result?.admissionState, "accepted", JSON.stringify(created));
  const foreground = await rpc("session.open", { threadId: created.result.threadId });
  const original = await taskQuestion(native, workspace, until);
  const before = (await native("thread/list", { limit: 100 })).data
    .map((thread) => thread.id)
    .sort();
  const detail = await rpc("task.question.read", original.target);
  assert.equal(detail.result.complete, true, JSON.stringify(detail));
  assert.equal(detail.result.kind, "asyncQuestion");
  assert.equal(detail.result.runStatus, "running");
  assert.equal(detail.result.questions[0].title, "Native Task choice");
  assert.deepEqual(detail.result.questions[0].options, ["A", "B"]);
  assert.deepEqual(
    (await native("thread/list", { limit: 100 })).data.map((thread) => thread.id).sort(),
    before,
  );
  const answers = { choice: "B", free: "界".repeat(1365) + "a" };
  assert.equal(Buffer.byteLength(answers.free), 4096);
  for (const invalid of [
    { choice: "B" },
    { ...answers, extra: "x" },
    { ...answers, choice: "C" },
    { ...answers, free: answers.free + "a" },
  ]) {
    const response = await rpc("task.question.reply", { ...original.target, answers: invalid });
    assert.equal(response.error?.code, "INVALID_PARAMS", JSON.stringify(response));
  }
  for (const field of ["taskId", "runId", "questionId"]) {
    refused(await rpc("task.question.read", { ...original.target, [field]: randomUUID() }));
    refused(
      await rpc("task.question.reply", { ...original.target, [field]: randomUUID(), answers }),
    );
  }
  const commandId = randomUUID();
  const accepted = await rpc("task.question.reply", { ...original.target, answers }, commandId);
  assert.equal(accepted.result?.admissionState, "accepted", JSON.stringify(accepted));
  assert.equal(accepted.result.receipt.taskId, original.taskId);
  assert.equal(accepted.result.receipt.runId, original.runId);
  assert.equal(accepted.result.nativeRequestId, accepted.result.operationId);
  assert.equal(accepted.result.observedState.status, "answered");
  assert.equal(accepted.result.observedState.provesCommandAdmission, false);
  await original.release();
  await until(
    async () =>
      (await native("areal/task/read", { taskId: original.taskId })).runs[0].status === "completed",
    "the original answered Task completes",
  );
  for (const [suffix, expected] of [
    ["pending", "x"],
    ["work", "y"],
    ["reply", "B"],
  ])
    assert.equal(await readFile(original.path(suffix), "utf8"), expected);
  const channel = await native("areal/channel/read", { taskId: original.taskId, limit: 100 });
  const replies = channel.data.filter(
    (item) => item.kind === "reply" && item.inReplyTo === original.questionId,
  );
  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0].answers, answers);
  assert.equal(
    (await rpc("task.question.reply", { ...original.target, answers }, commandId)).result
      .operationId,
    accepted.result.operationId,
  );
  assert.equal(
    (await rpc("command.read", { commandId })).result.operationId,
    accepted.result.operationId,
  );
  refused(await rpc("task.question.reply", { ...original.target, answers }));
  const paused = await taskQuestion(native, workspace, until);
  const task = await native("areal/task/read", { taskId: paused.taskId });
  const target = { taskId: task.id, expectedRunId: paused.runId, expectedRevision: task.revision };
  const ready = await rpc("task.read", { taskId: paused.taskId, runId: paused.runId });
  assert.equal(ready.result.available, true);
  refused(await rpc("task.pause", { ...target, expectedRunId: randomUUID() }));
  refused(await rpc("task.pause", { ...target, expectedRevision: task.revision - 1 }));
  const current = await native("areal/task/read", { taskId: paused.taskId });
  assert.equal(current.runs.at(-1).id, paused.runId);
  const pauseParams = { ...target, expectedRevision: current.revision };
  const pauseId = randomUUID();
  const pause = await rpc("task.pause", pauseParams, pauseId);
  assert.equal(pause.result?.admissionState, "accepted", JSON.stringify(pause));
  assert.equal(pause.result.receipt.runId, paused.runId);
  assert.equal(pause.result.receipt.revision, current.revision + 1);
  assert.equal(pause.result.observedState.taskPaused, true);
  assert.equal(pause.result.observedState.provesCommandAdmission, false);
  await until(
    async () =>
      (await rpc("task.read", { taskId: paused.taskId, runId: paused.runId })).result.settled,
    "pause intent waits for all original workers to settle",
  );
  const answerWhilePaused = await rpc("task.question.reply", { ...paused.target, answers });
  assert.equal(
    answerWhilePaused.result?.admissionState,
    "accepted",
    JSON.stringify(answerWhilePaused),
  );
  const afterPaused = await native("areal/task/read", { taskId: paused.taskId });
  assert.equal(afterPaused.paused, true);
  assert.equal(afterPaused.runs.length, 1);
  assert.equal(afterPaused.runs[0].id, paused.runId);
  assert.equal(
    (await rpc("task.pause", pauseParams, pauseId)).result.operationId,
    pause.result.operationId,
  );
  assert.equal(
    (await rpc("command.read", { commandId: pauseId })).result.operationId,
    pause.result.operationId,
  );
  const competing = await taskQuestion(native, workspace, until);
  const [one, two] = await Promise.all([
    rpc("task.question.reply", { ...competing.target, answers }),
    otherRpc("task.question.reply", {
      ...competing.target,
      answers: { choice: "A", free: "other device" },
    }),
  ]);
  assert.equal(
    [one, two].filter((result) => result.result?.admissionState === "accepted").length,
    1,
  );
  assert.equal(
    [one, two].filter((result) => result.error || result.result?.admissionState === "rejected")
      .length,
    1,
  );
  const competingReplies = (
    await native("areal/channel/read", { taskId: competing.taskId, limit: 100 })
  ).data.filter((item) => item.kind === "reply" && item.inReplyTo === competing.questionId);
  assert.equal(competingReplies.length, 1);
  await competing.release();
  await until(
    async () =>
      (await native("areal/task/read", { taskId: competing.taskId })).runs[0].status ===
      "completed",
    "competing original Task settles",
  );
  const expired = await taskQuestion(native, workspace, until, "RC08_EXPIRE");
  await until(
    async () =>
      (await rpc("task.question.read", expired.target)).result.expiresAt <= Date.now() / 1000,
    "the exact question expires",
  );
  refused(await rpc("task.question.reply", { ...expired.target, answers }));
  await expired.release();
  const terminal = await taskQuestion(native, workspace, until, "RC08_TERMINAL");
  await terminal.release();
  await until(
    async () =>
      (await native("areal/task/read", { taskId: terminal.taskId })).runs[0].status === "completed",
    "the exact Task reaches terminal state",
  );
  refused(await rpc("task.question.reply", { ...terminal.target, answers }));
  assert.equal(
    (await rpc("subscription.close", { subscriptionId: foreground.result.subscriptionId })).result
      .closed,
    true,
    "Task reads retain the original foreground viewer",
  );
  return {
    original: original.target,
    detail,
    accepted,
    pause,
    answerWhilePaused,
    competing: [one, two],
    expired: expired.target,
    terminal: terminal.target,
    replies,
  };
}
