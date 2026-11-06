// @ts-check
"use strict";
const { isAwaitingResponse, sameSubmission } = require("./project-state.cjs");
const { createHash, randomUUID } = require("node:crypto");
const { mkdir } = require("node:fs/promises");
const { basename, dirname } = require("node:path");
const { SCRATCH_ID } = require("./projectless.cjs");
const { manageTaskDraft, taskDraftOperations } = require("./task-draft.cjs");

const {
  readTask,
  readTaskAdmission,
  readTaskRequest,
} = require("@areal/workbench/desktop-contract/management-tasks");
const { readReceipts } = require("./receipt-contract.cjs");
const { readThreadAdmission } = require("./submission-results.cjs");
const { modelRecord } = require("@areal/workbench/core-model-contract");
/** @typedef {import('./project-state.cjs').CoreProject} Project */
/** @typedef {InstanceType<typeof import('./backend.cjs').CoreBackend>} Backend */
/** @typedef {import('@areal/workbench/desktop-contract/management-tasks').TaskRequest} Request */
/** @type {Record<string,[string,string[]]>} */
const reads = {
  taskSchedulePreview: ["areal/task/schedule/preview", ["schedule", "from", "count"]],
  taskScheduleContext: ["areal/task/schedule/context", ["timeZone"]],
  tasks: ["areal/task/list", ["after", "limit"]],
  task: ["areal/task/read", ["taskId"]],
  taskInbox: ["areal/inbox/list", ["after", "limit"]],
  taskChannel: ["areal/channel/read", ["taskId", "afterSequence", "limit"]],
  taskRuns: ["areal/task/runs/list", ["taskId", "cursor", "limit"]],
  taskRun: ["areal/task/run/read", ["taskId", "runId"]],
};
/** @type {Record<string,[string,string[]]>} */
const writes = {
  taskCreate: [
    "areal/task/create",
    [
      "mode",
      "objective",
      "threadId",
      "sourceThreadId",
      "interactionMode",
      "schedule",
      "scheduleV2",
      "tokenBudget",
      "maxTurns",
      "maxActiveSeconds",
      "delivery",
      "model",
      "parameters",
    ],
  ],
  taskUpdate: [
    "areal/task/update",
    [
      "taskId",
      "expectedRevision",
      "objective",
      "schedule",
      "scheduleV2",
      "delivery",
      "model",
      "parameters",
    ],
  ],
  taskRunNow: ["areal/task/runNow", ["taskId", "expectedRevision"]],
  taskPause: ["areal/task/pause", ["taskId", "expectedRevision"]],
  taskResume: ["areal/task/resume", ["taskId", "expectedRevision"]],
  taskStopRun: ["areal/task/stopRun", ["taskId", "expectedRevision", "expectedRunId"]],
  taskResumeRun: ["areal/task/resumeRun", ["taskId", "expectedRevision", "expectedRunId"]],
  taskCancel: ["areal/task/cancel", ["taskId", "expectedRevision"]],
  taskDelete: ["areal/task/delete", ["taskId", "expectedRevision"]],
  taskReply: ["areal/channel/reply", ["taskId", "runId", "questionId", "answers"]],
};
const taskMutationMethods = new Set(Object.values(writes).map(([method]) => method));
const taskOperations = new Set([
  ...Object.keys(reads),
  ...Object.keys(writes),
  ...taskDraftOperations,
  "taskHistoryCapabilities",
  "taskWatch",
  "taskUnwatch",
]);
/** @param {Request} request @param {string[]} keys @returns {import("./project-state.cjs").SubmissionParams} */
const pick = (request, keys) =>
  Object.fromEntries(
    keys.filter((key) => request[key] !== undefined).map((key) => [key, request[key]]),
  );
const unknown = () =>
  Object.assign(new Error("原任务提交结果尚未确认，请先核对任务列表；不会重复创建。"), {
    submissionUnknown: true,
  });
/** @param {string} requestId */
const executionRequestId = (requestId) => {
  const hex = createHash("sha256").update(`AREAL_TASK_EXECUTION_V1:${requestId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
/**
 * 无项目工作区里每个任务有自己的子目录；普通项目的任务仍在项目根目录运行。
 * @param {Project} project @param {string|undefined} cwd
 */
async function taskFolder(project, cwd) {
  if (cwd === undefined) return project.root;
  if (
    project.projectlessRequestId !== SCRATCH_ID ||
    dirname(cwd) !== project.root ||
    !/^[^./\\][^/\\]{0,127}$/.test(basename(cwd))
  )
    throw new Error("任务目录必须是无项目工作区下的子目录");
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  return cwd;
}
/** @param {Backend} backend @param {Project} project @param {Request} request */
async function taskCreate(backend, project, request) {
  const requestId = request.requestId ?? randomUUID();
  if (typeof requestId !== "string" || !/^[0-9a-f-]{36}$/.test(requestId))
    throw new Error("无效请求标识");
  project.taskCreateWrites ??= new Map();
  const previous = project.taskCreateWrites.get(requestId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      const client = project.client;
      if (!client) throw new Error("Core 未连接");
      if (
        project.pending.some((entry) => entry.params.requestId === requestId) ||
        project.outcomes?.[requestId]
      )
        throw unknown();
      const params = pick(request, writes.taskCreate[1]);
      if (params.mode === "scheduled")
        await backend.scheduleAdmission.reserveCreate(project, requestId, params.threadId, {
          executionRequestId: params.threadId ? undefined : executionRequestId(requestId),
        });
      if (!params.threadId && params.mode === "scheduled") {
        const preludeId = executionRequestId(requestId);
        let receipt;
        try {
          const found = await client.request(
            "areal/request/read",
            { requestId: preludeId },
            { decode: readReceipts },
          );
          receipt = found.data.find(
            (item) => item.method === "areal/thread/start" && typeof item.threadId === "string",
          );
        } catch {
          throw Object.assign(new Error("无法核对执行会话；不会重复创建。"), {
            submissionUnknown: true,
          });
        }
        const pending = project.pending.find((entry) => entry.params.requestId === preludeId);
        if (receipt) {
          if (pending) {
            if (isAwaitingResponse(backend.awaitingResponses, project.id, pending)) throw unknown();
            if (backend.rustDomains.includes("execution-rust")) {
              await backend.readSubmission(project, pending.method, { ...pending.params, requestId: preludeId });
            } else {
              await backend.changePending(project, (entries) =>
                entries.filter((entry) => !sameSubmission(project.id, entry, pending)),
              );
            }
          }
          params.threadId = receipt.threadId ?? undefined;
        } else {
          if (pending || project.outcomes?.[preludeId]) throw unknown();
          await backend.resources.beforeCreate(project);
          const cwd = await taskFolder(project, request.cwd);
          const { thread } = readThreadAdmission(
            await backend.submit(project, "areal/thread/start", { cwd }, { requestId: preludeId }),
          );
          params.threadId = thread.id;
        }
      }
      if (params.mode === "scheduled")
        await backend.scheduleAdmission.setAnchor(project, params.threadId);
      const value = readTaskAdmission(
        await backend.submit(project, "areal/task/create", params, { requestId }),
      );
      project.model.setTask(value);
      try {
        if (value.mode === "scheduled") await backend.scheduleAdmission.bind(project, value);
        await backend.taskWorkspaceOwners?.observe(project, value);
      } catch (error) {
        throw Object.assign(
          new Error("任务已受理，执行目录归属确认尚未完成；请核对原任务。", { cause: error }),
          { submissionUnknown: true },
        );
      }
      return value;
    });
  project.taskCreateWrites.set(requestId, next);
  try {
    return await next;
  } finally {
    if (project.taskCreateWrites.get(requestId) === next)
      project.taskCreateWrites.delete(requestId);
  }
}

/** @param {Backend} backend @param {Project} project @param {Record<string,unknown>} rawRequest */
async function manageTask(backend, project, rawRequest) {
  const request = readTaskRequest(rawRequest);
  if (backend.rustDomains.includes("tasks-rust") && backend.hostCall) {
    if (taskDraftOperations.has(request.operation)) return manageTaskDraft(backend, project, request);
    /** @type {Record<string,unknown>} */
    const payload = { ...request, executionProjectId: project.id };
    if (request.operation === "taskDraftSend") {
      payload.input = require("./media.cjs").messageInput(backend, request);
      for (const key of ["text", "attachments", "mcpContent", "conversationQuotes"])
        delete payload[key];
    }
    const reading = reads[request.operation] || ["taskDraftRead", "taskDraftHistory", "taskHistoryCapabilities", "taskWatch", "taskUnwatch"].includes(request.operation);
    const value = await backend.hostCall(reading ? "tasks.read" : "tasks.command", payload);
    if (["task", "taskWatch", "taskCreate", "taskUpdate", "taskPause", "taskResume", "taskCancel", "taskDelete", "taskStopRun", "taskResumeRun", "taskDraftConfirm"].includes(request.operation))
      project.model.setTask(readTask(value));
    return value;
  }
  const current = project.client;
  if (!current) throw new Error("Core 未连接");
  const operation = request.operation;
  const historyEnabled = () =>
    ["areal/task/runs/list", "areal/task/run/read"].every((method) =>
      current.capabilities?.methods?.includes(method),
    );
  if (operation === "taskHistoryCapabilities")
    return {
      enabled: historyEnabled(),
      runNow: current.capabilities?.methods?.includes("areal/task/runNow") === true,
    };
  if (operation === "taskRunNow" && !current.capabilities?.methods?.includes("areal/task/runNow"))
    throw new Error("当前 Core 尚不支持立即运行，请更新 Core 后重试。");
  if (operation === "taskRuns" || operation === "taskRun") {
    /** @param {unknown} value */
    const identifier = (value) =>
      typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("\0");
    if (
      !identifier(request.taskId) ||
      (operation === "taskRun" && !identifier(request.runId)) ||
      (operation === "taskRuns" &&
        ((request.cursor !== undefined &&
          (typeof request.cursor !== "string" ||
            !request.cursor ||
            request.cursor.length > 2048)) ||
          (request.limit !== undefined &&
            (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100))))
    )
      throw new Error("无效运行记录读取参数");
    if (!historyEnabled()) throw new Error("当前 Core 尚不支持完整运行记录，请更新 Core 后重试。");
  }
  if (taskDraftOperations.has(operation)) return manageTaskDraft(backend, project, request);
  if (operation === "taskWatch" || operation === "taskUnwatch") {
    if (typeof request.viewId !== "string" || !request.viewId || request.viewId.length > 128)
      throw new Error("缺少任务视图标识");
    // Shared desktop clients can display the same task. Serialize acquisition
    // and release so leaving one view never drops another view's subscription.
    const viewId = request.viewId;
    const next = (project.taskViewWrite ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const client = project.client;
        backend.requireConnection(project, client);
        project.taskViews ??= new Map();
        const previous = project.taskViews.get(viewId);
        let result;
        if (operation === "taskWatch") {
          if (typeof request.taskId !== "string" || !request.taskId) throw new Error("缺少任务 ID");
          result = await client.request(
            "areal/task/subscribe",
            { taskId: request.taskId },
            {
              decode: readTask,
              onResult: (task) => {
                if (backend.currentConnection(project, client)) project.model.setTask(task);
              },
            },
          );
          backend.requireConnection(project, client);
          project.taskViews.set(viewId, request.taskId);
        } else project.taskViews.delete(viewId);
        if (
          previous &&
          previous !== (operation === "taskWatch" ? request.taskId : null) &&
          ![...project.taskViews.values()].includes(previous)
        ) {
          await client.request("areal/task/unsubscribe", { taskId: previous });
          backend.requireConnection(project, client);
        }
        return result ?? { removed: true };
      });
    project.taskViewWrite = next;
    return next;
  }
  const definition = reads[operation] ?? writes[operation];
  const [method, fields] = definition;
  const params = pick(request, fields);
  if (reads[operation]) {
    const client = current;
    const value = await client.request(method, params);
    backend.requireConnection(project, client);
    if (operation === "task") {
      const task = readTask(value);
      project.model.setTask(task);
      await backend.taskWorkspaceOwners?.observe(project, task);
    }
    return value;
  }
  if (operation === "taskCreate") return taskCreate(backend, project, request);
  if (
    ["taskRunNow", "taskResume", "taskResumeRun", "taskReply", "taskUpdate"].includes(operation)
  ) {
    const task = await current.request(
      "areal/task/read",
      { taskId: params.taskId },
      { decode: readTask },
    );
    if (task.mode === "scheduled")
      await backend.scheduleAdmission.admitTask(project, task.id, operation);
  }
  const value = await backend.submit(project, method, params, { requestId: request.requestId });
  if (operation === "taskRunNow") {
    if (typeof params.taskId !== "string") throw new Error("任务身份无效");
    await backend.refreshAfterAdmission(project, undefined, {
      method,
      requestId: request.requestId,
      target: { kind: "task", taskId: params.taskId },
    });
    return value;
  }
  // Core receipts identify the Run and reply message. Preserve the originating
  // question too, so a delayed Desktop response cannot settle its sibling.
  if (operation === "taskReply") {
    if (!modelRecord(value))
      throw Object.assign(new Error("回复回执结构无效"), { submissionUnknown: true });
    return { ...value, questionId: params.questionId };
  }
  const task = readTaskAdmission(value);
  project.model.setTask(task);
  await backend.taskWorkspaceOwners?.observe(project, task);
  return value;
}
module.exports = { manageTask, taskOperations, taskMutationMethods };
