// @ts-check
"use strict";
const decoder = require("./remote-core-decoder.cjs");
const { record } = decoder;
const nativeHistoryBytes = 4 * 1024 * 1024;
/** @typedef {import('./remote-session-observer.cjs').RemoteConnection} Connection */
/** @typedef {import('./remote-session-observer.cjs').TaskQuestionRead} QuestionRead */
/** @typedef {{taskId:string,runId:string,questionId:string,[key:string]:unknown}} Target */
/** @typedef {Target & {answers:Record<string,string>}} ReplyParams */
/** @typedef {{taskId:string,expectedRunId:string,expectedRevision:number}} PauseParams */
/** @typedef {ReturnType<typeof pauseState> & {projectId:string,serviceGeneration:string,available:boolean}} PauseRead */
const LIMITS = Object.freeze({
  taskQuestionPages: 8,
  taskQuestionBytes: 32 * 1024,
  taskQuestions: 8,
  taskAnswerBytes: 4096,
});
/** @param {string} code @param {string} message */
const failure = (code, message) => Object.assign(new Error(message), { code });
/** @param {unknown} value @param {string[]} keys @returns {value is Record<string,unknown>} */
const exact = (value, keys) =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));
/** @param {unknown} value @returns {value is string} */
function identity(value) {
  return typeof value === "string" && !!value && Buffer.byteLength(value) <= 128;
}
/** @param {unknown} params @returns {asserts params is Target} */
function assertTarget(params) {
  if (
    !record(params) ||
    !identity(params.taskId) ||
    !identity(params.runId) ||
    !identity(params.questionId)
  )
    throw failure("INVALID_PARAMS", "缺少原 Task、Run 和问题身份");
}
/** @param {unknown} params */
function target(params) {
  assertTarget(params);
  return { taskId: params.taskId, runId: params.runId, questionId: params.questionId };
}
/** @param {unknown} params @returns {asserts params is ReplyParams} */
function validateReply(params) {
  assertTarget(params);
  if (
    !record(params.answers) ||
    !Object.keys(params.answers).length ||
    Object.keys(params.answers).length > LIMITS.taskQuestions ||
    Object.entries(params.answers).some(
      ([key, value]) =>
        !key ||
        Buffer.byteLength(key) > 128 ||
        typeof value !== "string" ||
        !value.trim() ||
        Buffer.byteLength(value) > LIMITS.taskAnswerBytes,
    )
  )
    throw failure("INVALID_PARAMS", "答案必须非空且符合 UTF-8 字节预算");
}
/** @param {unknown} params @returns {asserts params is PauseParams} */
function validatePause(params) {
  if (
    !exact(params, ["taskId", "expectedRunId", "expectedRevision"]) ||
    !identity(params.taskId) ||
    !identity(params.expectedRunId) ||
    typeof params.expectedRevision !== "number" ||
    !Number.isSafeInteger(params.expectedRevision) ||
    params.expectedRevision < 0
  )
    throw failure("INVALID_PARAMS", "缺少原 Task、当前 Run 和版本");
}
/** @param {import("./remote-core-decoder.cjs").Task} task @param {string} [runId] */
function pauseState(task, runId) {
  const run = task.runs?.find((value) => value.id === runId);
  const workersComplete =
    Array.isArray(run?.workers) && run.workers.every((worker) => worker.settled === true);
  const settled =
    task.paused === true &&
    !!run &&
    ["paused", "completed", "failed", "cancelled"].includes(run.status) &&
    workersComplete;
  return {
    taskId: task.id,
    runId,
    revision: task.revision,
    taskPaused: task.paused === true,
    taskCancelled: task.cancelled === true,
    currentRunId: task.runs?.at(-1)?.id ?? null,
    runStatus: run?.status ?? "unavailable",
    reason: typeof run?.reason === "string" ? run.reason.slice(0, 128) : null,
    workersSettled: workersComplete,
    settled,
    provesCommandAdmission: false,
  };
}
class TaskQuestions {
  /** @param {InstanceType<typeof import("./remote-session-observer.cjs").SessionObservers>} observers */
  constructor(observers) {
    this.observers = observers;
  }
  /** @template T @param {Connection} connection @param {string} projectId @param {unknown} params @param {(value:PauseRead)=>T} publish */
  async pauseRead(connection, projectId, params, publish) {
    params = structuredClone(params);
    if (
      !exact(params, ["taskId", "runId"]) ||
      typeof params.taskId !== "string" ||
      !params.taskId ||
      Buffer.byteLength(params.taskId) > 128 ||
      (params.runId !== undefined &&
        (typeof params.runId !== "string" ||
          !params.runId ||
          Buffer.byteLength(params.runId) > 128))
    )
      throw failure("INVALID_PARAMS", "无效的 Task 读取参数");
    const request = { taskId: params.taskId, runId: params.runId };
    return this.observers.taskQuestion(connection, projectId, request, ({ task }, entry) => {
      const state = pauseState(task, request.runId);
      return publish({
        ...state,
        projectId,
        serviceGeneration: entry.generation,
        available:
          !!request.runId &&
          state.currentRunId === request.runId &&
          !task.paused &&
          !task.cancelled &&
          Number.isSafeInteger(task.revision) &&
          task.revision >= 0 &&
          entry.project.client.capabilities?.features?.taskPauseRunGuard === true &&
          entry.project.client.capabilities?.methods?.includes("areal/task/pause") === true,
      });
    });
  }
  /** @param {Connection} connection @param {string} projectId @param {unknown} params */
  async preparePause(connection, projectId, params) {
    validatePause(params);
    return this.pauseRead(
      connection,
      projectId,
      { taskId: params.taskId, runId: params.expectedRunId },
      (state) => {
        if (
          state.currentRunId !== params.expectedRunId ||
          state.revision !== params.expectedRevision ||
          state.taskCancelled
        )
          throw failure("TARGET_CHANGED", "原 Task Run 或版本已变化");
        return { ...params };
      },
    );
  }
  /** @param {Connection} connection @param {string} projectId @param {unknown} params */
  async observePause(connection, projectId, params) {
    validatePause(params);
    return this.pauseRead(
      connection,
      projectId,
      { taskId: params.taskId, runId: params.expectedRunId },
      (state) => ({
        ...state,
        source: "task.read",
        provesCommandAdmission: false,
      }),
    );
  }
  /** @param {QuestionRead} value @param {Target} params */
  lookup(value, params) {
    const run = value.task.runs.find((run) => run.id === params.runId);
    if (
      value.task?.id !== params.taskId ||
      !run ||
      (value.item &&
        (value.item.id !== params.questionId ||
          value.item.runId !== params.runId ||
          value.item.kind !== "question"))
    )
      throw failure("TARGET_CHANGED", "原 Task、Run 或问题已不存在");
    if (!value.item && value.complete) throw failure("TARGET_CHANGED", "原问题已不存在");
    return { item: value.item, run };
  }
  /** @template T @param {Connection} connection @param {string} projectId @param {unknown} params @param {(value:unknown)=>T} publish */
  async read(connection, projectId, params, publish) {
    params = structuredClone(params);
    if (!exact(params, ["taskId", "runId", "questionId"]))
      throw failure("INVALID_PARAMS", "无效的问题读取参数");
    assertTarget(params);
    return this.observers.taskQuestion(connection, projectId, params, (value, entry) => {
      const { item, run } = this.lookup(value, params);
      const complete =
        value.complete &&
        !!item &&
        Array.isArray(item.questions) &&
        item.questions.length > 0 &&
        item.questions.length <= LIMITS.taskQuestions &&
        Buffer.byteLength(JSON.stringify(item.questions)) <= LIMITS.taskQuestionBytes;
      const content = { questions: complete ? item.questions : [] };
      return publish({
        projectId,
        serviceGeneration: entry.generation,
        ...target(params),
        kind: "asyncQuestion",
        taskPaused: value.task.paused === true,
        taskCancelled: value.task.cancelled === true,
        runStatus: run.status,
        status: item?.status ?? "unavailable",
        expiresAt: item?.expiresAt ?? null,
        complete,
        ...content,
      });
    });
  }
  /** @param {Connection} connection @param {string} projectId @param {unknown} params */
  async prepare(connection, projectId, params) {
    params = structuredClone(params);
    validateReply(params);
    return this.observers.taskQuestion(connection, projectId, params, (value) => {
      const { item, run } = this.lookup(value, params);
      if (
        !value.complete ||
        !item ||
        !Array.isArray(item.questions) ||
        !item.questions.length ||
        item.questions.length > LIMITS.taskQuestions ||
        Buffer.byteLength(JSON.stringify(item.questions)) > LIMITS.taskQuestionBytes
      )
        throw failure("REVIEW_INCOMPLETE", "请完整读取原问题后回复");
      if (
        value.task.cancelled ||
        item.status !== "pending" ||
        (item.expiresAt !== null &&
          item.expiresAt !== undefined &&
          item.expiresAt <= Date.now() / 1000) ||
        ["completed", "failed", "cancelled"].includes(run.status)
      )
        throw failure("TARGET_CHANGED", "原问题已结束或过期");
      if (
        Object.keys(params.answers).length !== item.questions.length ||
        item.questions.some(
          (q) =>
            !Object.hasOwn(params.answers, q.id) ||
            (!q.allowFreeText && !q.options.includes(params.answers[q.id])),
        )
      )
        throw failure("INVALID_PARAMS", "答案必须匹配 Core 的原题目和选项");
      return { ...target(params), answers: params.answers };
    });
  }
  /** @param {Connection} connection @param {string} projectId @param {unknown} params */
  async observe(connection, projectId, params) {
    params = structuredClone(params);
    assertTarget(params);
    return this.observers.taskQuestion(connection, projectId, params, (value) => {
      const { item } = this.lookup(value, params);
      return {
        source: "task.question.read",
        ...target(params),
        status: item?.status ?? "unavailable",
        expiresAt: item?.expiresAt ?? null,
        taskPaused: value.task.paused === true,
        complete: value.complete,
        provesCommandAdmission: false,
      };
    });
  }
}
/** @template T @param {InstanceType<typeof import('./remote-session-observer.cjs').SessionObservers>} observers @param {Connection} connection @param {string} projectId @param {{taskId:string,runId?:string,questionId?:string}} params @param {(result:QuestionRead,entry:import('./remote-session-observer.cjs').ObserverEntry)=>T} publish */
async function readTaskQuestion(observers, connection, projectId, params, publish) {
  const project = observers.authorize(connection, projectId);
  if (
    !["areal/task/read", ...(params.questionId ? ["areal/channel/read"] : [])].every((method) =>
      project.client.capabilities?.methods?.includes(method),
    )
  )
    throw failure("CORE_INCOMPATIBLE", "Core 不支持 Task 问题读取");
  const entry = observers.entry(connection, projectId);
  entry.readers++;
  try {
    return await observers.enqueue(entry, async () => {
      const check = () => {
        observers.check(entry);
        if (observers.authorize(connection, projectId) !== entry.project)
          throw failure("RESYNC_REQUIRED", "项目已变化");
      };
      check();
      const task = decoder.taskRead(
        await observers.rpc(entry, "areal/task/read", { taskId: params.taskId }),
      );
      check();
      if (Buffer.byteLength(JSON.stringify(task)) > nativeHistoryBytes)
        throw failure("RESOURCE_UNAVAILABLE", "Task 超过读取上限");
      if (
        task.id !== params.taskId ||
        (params.runId && !task.runs?.some((run) => run.id === params.runId))
      )
        throw failure("TARGET_CHANGED", "原 Task Run 已不存在");
      if (!params.questionId) return publish({ task, complete: true }, entry);
      let afterSequence = 0,
        item,
        complete = false,
        bytes = 0;
      // 有界读取独立 Channel；不打开、订阅或恢复协调 Session。
      for (let page = 0; page < LIMITS.taskQuestionPages; page++) {
        const result = decoder.channelRead(
          await observers.rpc(entry, "areal/channel/read", {
            taskId: params.taskId,
            afterSequence,
            limit: 100,
          }),
        );
        check();
        bytes += Buffer.byteLength(JSON.stringify(result));
        if (bytes > nativeHistoryBytes) break;
        if (
          result.taskId !== params.taskId ||
          !Array.isArray(result.data) ||
          result.data.length > 100
        )
          throw failure("TARGET_CHANGED", "Channel 身份或分页无效");
        item = result.data.find(
          (value) =>
            value.id === params.questionId &&
            value.runId === params.runId &&
            value.kind === "question",
        );
        if (item) {
          complete = true;
          break;
        }
        if (!result.hasMore) {
          complete = true;
          break;
        }
        if (!Number.isSafeInteger(result.nextSequence) || result.nextSequence <= afterSequence)
          break;
        afterSequence = result.nextSequence;
      }
      check();
      return publish({ task, item, complete }, entry);
    });
  } finally {
    entry.readers--;
    if (
      !entry.readers &&
      ![...entry.threads.values()].some((value) => value.viewers.size || value.pushWatches?.size)
    )
      observers.invalidate(entry);
  }
}

module.exports = { readTaskQuestion, TaskQuestions, LIMITS, validateReply, validatePause, target };
