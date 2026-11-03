// @ts-check
"use strict";
const protocol = require("./generated/management-tasks-protocol.cjs");
const ownerProtocol = require("./generated/management-owner-directory-protocol.cjs");
const { isCoreThread, modelRecord } = require("../core-model-contract.js");

/** @typedef {Schedule['rule']} ScheduleRule */
/** @typedef {NonNullable<Task['scheduleV2']>} Schedule */
/** @typedef {NonNullable<Task['schedule']>} LegacySchedule */
/** @typedef {NonNullable<TaskRun['workers']>[number]} TaskWorker */
/** @typedef {import('./generated/management-tasks-protocol.cjs').ResponseMap['taskRun']} TaskRun */
/** @typedef {import('./generated/management-tasks-protocol.cjs').ResponseMap['task']} Task */
/** @typedef {import('./generated/management-tasks-protocol.cjs').ResponseMap['taskInbox']['data'][number]} InboxEntry */
/** @param {unknown} value @returns {value is number} */
const integer = (value) => typeof value === "number" && Number.isSafeInteger(value);
/** @param {unknown} value @returns {value is Schedule} */
function schedule(value) {
  return protocol.responses.taskSchedulePreview({
    coreNow: 0,
    from: 0,
    schedule: value,
    timeZone: "UTC",
    occurrences: [],
    warnings: [],
  });
}

/** @param {unknown} value @returns {value is TaskRun} */
function taskRun(value) {
  return protocol.responses.taskRun(value);
}

/** @param {unknown} value @returns {value is Task} */
function task(value) {
  return protocol.responses.task(value);
}

/** @param {unknown} value @returns {Task} */
function readTask(value) {
  if (!task(value)) throw new Error("Core 任务结构无效");
  return value;
}
/** @param {unknown} value @returns {Task} */
function readTaskAdmission(value) {
  if (!task(value))
    throw Object.assign(new Error("Core 任务受理结果不完整，请查询原请求"), {
      code: "ADMISSION_RESULT_INVALID",
      submissionUnknown: true,
      outcome: { kind: "unconfirmed" },
      recovery: { kind: "queryOriginal" },
    });
  return value;
}
/** @param {unknown} value @returns {TaskRun} */
function readTaskRun(value) {
  if (!taskRun(value)) throw new Error("Core 任务运行结构无效");
  return value;
}
/** @param {unknown} value @returns {{data:Task[],nextCursor?:string|null,hasMore?:boolean}} */
function readTaskPage(value) {
  if (
    !modelRecord(value) ||
    !Array.isArray(value.data) ||
    !value.data.every(task) ||
    (value.nextCursor != null && typeof value.nextCursor !== "string") ||
    (value.hasMore !== undefined && typeof value.hasMore !== "boolean")
  )
    throw new Error("Core 任务目录结构无效");
  return { ...value, data: value.data, nextCursor: value.nextCursor, hasMore: value.hasMore };
}
/** @param {unknown} value @returns {value is InboxEntry} */
function inboxEntry(value) {
  return protocol.responses.taskInbox({ data: [value], nextCursor: null });
}

/** @param {unknown} value @returns {{data:InboxEntry[],nextCursor?:string|null}} */
function readInboxPage(value) {
  if (
    !modelRecord(value) ||
    !Array.isArray(value.data) ||
    !value.data.every(inboxEntry) ||
    (value.nextCursor != null && typeof value.nextCursor !== "string")
  )
    throw new Error("Core 任务收件箱结构无效");
  return { ...value, data: value.data, nextCursor: value.nextCursor };
}
module.exports = {
  taskDirectoryRow,
  readTaskDirectoryRow,
  readDirectoryPage,
  readDirectoryRows,
  readAttentionPage,
  readOwnerBarrier,
  readOwnerInvalidation,
  readTask,
  readTaskAdmission,
  readTaskRun,
  readTaskPage,
  readInboxPage,
  readTaskRequest,
  task,
  inboxEntry,
  taskRun,
  schedule,
  isTaskDraftSend,
  readTaskDraftSend,
  localTaskRequest,
  localTaskResponse,
  draftRead,
};

/** @typedef {Record<string,unknown> & {operation:string,projectId?:string,requestId?:string,draftId?:string,viewId?:string,threadId?:string,taskId?:string,sourceThreadId?:string,turnId?:string,digest?:string,timeZone?:string,cwd?:string,effort?:string,limit?:number,expectedRevision?:number,model?:{providerId:string,modelId:string}|null,delivery?:'thread'|'newThread',parameters?:Record<string,unknown>}} TaskRequest */
/** @param {Record<string,unknown>} value @returns {TaskRequest} */
function readTaskRequest(value) {
  if (!taskRequest(value)) throw new Error("任务请求结构无效");
  return value;
}
/** @param {Record<string,unknown>} value @returns {value is TaskRequest} */
function taskRequest(value) {
  return (
    typeof value.operation === "string" &&
    [
      "projectId",
      "requestId",
      "draftId",
      "viewId",
      "threadId",
      "taskId",
      "sourceThreadId",
      "turnId",
      "digest",
      "timeZone",
      "cwd",
      "effort",
    ].every((key) => value[key] === undefined || typeof value[key] === "string") &&
    (value.limit === undefined || typeof value.limit === "number") &&
    (value.expectedRevision === undefined || typeof value.expectedRevision === "number") &&
    (value.delivery === undefined ||
      value.delivery === "thread" ||
      value.delivery === "newThread") &&
    (value.parameters === undefined || modelRecord(value.parameters)) &&
    (value.model == null ||
      (modelRecord(value.model) &&
        typeof value.model.providerId === "string" &&
        typeof value.model.modelId === "string"))
  );
}

/** @typedef {{threadId:string,turnId?:string}} TaskDraftSend */
/** @param {unknown} value @returns {value is TaskDraftSend} */
function isTaskDraftSend(value) {
  return (
    modelRecord(value) &&
    typeof value.threadId === "string" &&
    (value.turnId === undefined || typeof value.turnId === "string")
  );
}
/** @param {unknown} value @returns {TaskDraftSend} */
function readTaskDraftSend(value) {
  if (!isTaskDraftSend(value)) throw new Error("任务草稿受理结构无效");
  return value;
}

/** @typedef {import('./generated/management-tasks-protocol.cjs').RequestMap['taskSchedulePreview']['schedule']} ScheduleIntent */
/** @typedef {{id:string,role:'user'|'assistant',text:string}} DraftMessage */
/** @typedef {{action?:'pause'|'resume'|'cancel',taskId?:string,expectedRevision?:number,objective?:string,mode?:'scheduled',threadId?:string,sourceThreadId?:string,scheduleV2?:ScheduleIntent,interactionMode?:'interactive',tokenBudget?:number,maxTurns?:number,maxActiveSeconds?:number}} DraftProposal */
/** @typedef {{threadId:string,turnId:string|null,running:boolean,messages:DraftMessage[],proposal:DraftProposal|null,digest:string|null,error:string,timeZone:string,thread:import('../core-model-contract.js').CoreThread&{cwd:string},preview?:import('./generated/management-tasks-protocol.cjs').ResponseMap['taskSchedulePreview'],task?:Task}} DraftRead */
/** @typedef {{
 * taskDraftStart:{projectId:string,operation:'taskDraftStart',draftId:string,timeZone?:string,cwd?:string,taskId?:string},
 * taskDraftSend:{projectId:string,operation:'taskDraftSend',threadId:string,requestId?:string,timeZone?:string,model?:{providerId:string,modelId:string}|null,effort?:string}&import('./conversation.cjs').Message,
 * taskDraftConfirm:{projectId:string,operation:'taskDraftConfirm',threadId:string,turnId:string,digest:string},
 * taskDraftRead:{projectId:string,operation:'taskDraftRead',threadId:string},taskDraftHistory:{projectId:string,operation:'taskDraftHistory',taskId:string},
 * taskHistoryCapabilities:{projectId:string,operation:'taskHistoryCapabilities'},taskWatch:{projectId:string,operation:'taskWatch',taskId:string,viewId:string},taskUnwatch:{projectId:string,operation:'taskUnwatch',viewId:string}
 * }} LocalTaskRequestMap */
/** @typedef {{taskDraftStart:{threadId:string,requestId:string,modelNotice?:'effort-unsupported'|'model-unavailable'},taskDraftSend:TaskDraftSend,taskDraftConfirm:Task,taskDraftRead:DraftRead,taskDraftHistory:{messages:DraftMessage[],threadId?:string,timeZone?:string},taskHistoryCapabilities:{enabled:boolean,runNow:boolean},taskWatch:Task,taskUnwatch:{removed:true}}} LocalTaskResponseMap */
/** @param {unknown} value @returns {value is DraftMessage} */
function draftMessage(value) {
  return (
    modelRecord(value) &&
    typeof value.id === "string" &&
    (value.role === "user" || value.role === "assistant") &&
    typeof value.text === "string"
  );
}
/** @param {unknown} value @returns {value is DraftProposal} */
function draftProposal(value) {
  return (
    modelRecord(value) &&
    ["taskId", "objective", "threadId", "sourceThreadId"].every(
      (key) => value[key] === undefined || typeof value[key] === "string",
    ) &&
    ["expectedRevision", "tokenBudget", "maxTurns", "maxActiveSeconds"].every(
      (key) => value[key] === undefined || integer(value[key]),
    ) &&
    (value.action === undefined ||
      (typeof value.action === "string" && ["pause", "resume", "cancel"].includes(value.action))) &&
    (value.mode === undefined || value.mode === "scheduled") &&
    (value.interactionMode === undefined || value.interactionMode === "interactive") &&
    (value.scheduleV2 === undefined ||
      protocol.requests.taskSchedulePreview({
        operation: "taskSchedulePreview",
        projectId: "",
        schedule: value.scheduleV2,
        count: 5,
      }))
  );
}
/** @param {unknown} value @returns {value is DraftRead} */
function draftRead(value) {
  return (
    modelRecord(value) &&
    typeof value.threadId === "string" &&
    (value.turnId === null || typeof value.turnId === "string") &&
    typeof value.running === "boolean" &&
    Array.isArray(value.messages) &&
    value.messages.every(draftMessage) &&
    (value.proposal === null || draftProposal(value.proposal)) &&
    (value.digest === null || typeof value.digest === "string") &&
    typeof value.error === "string" &&
    typeof value.timeZone === "string" &&
    isCoreThread(value.thread) &&
    modelRecord(value.thread) &&
    typeof value.thread.cwd === "string" &&
    (value.preview === undefined || protocol.responses.taskSchedulePreview(value.preview)) &&
    (value.task === undefined || task(value.task))
  );
}
/** @param {unknown} value @returns {value is LocalTaskRequestMap[keyof LocalTaskRequestMap]} */
function localTaskRequest(value) {
  if (!modelRecord(value) || typeof value.projectId !== "string") return false;
  switch (value.operation) {
    case "taskDraftStart":
      return (
        typeof value.draftId === "string" &&
        ["timeZone", "cwd", "taskId"].every(
          (key) => value[key] === undefined || typeof value[key] === "string",
        )
      );
    case "taskDraftSend":
      return (
        typeof value.threadId === "string" &&
        ["requestId", "timeZone", "effort"].every(
          (key) => value[key] === undefined || typeof value[key] === "string",
        ) &&
        (value.model == null ||
          (modelRecord(value.model) &&
            typeof value.model.providerId === "string" &&
            typeof value.model.modelId === "string")) &&
        require("./conversation.cjs").message(value)
      );
    case "taskDraftConfirm":
      return ["threadId", "turnId", "digest"].every((key) => typeof value[key] === "string");
    case "taskDraftRead":
      return typeof value.threadId === "string";
    case "taskDraftHistory":
      return typeof value.taskId === "string";
    case "taskHistoryCapabilities":
      return true;
    case "taskWatch":
      return typeof value.taskId === "string" && typeof value.viewId === "string";
    case "taskUnwatch":
      return typeof value.viewId === "string";
    default:
      return false;
  }
}
/** @param {string} operation @param {unknown} value */
function localTaskResponse(operation, value) {
  if (operation === "taskDraftSend") return isTaskDraftSend(value);
  if (operation === "taskDraftConfirm" || operation === "taskWatch") return task(value);
  if (operation === "taskDraftRead") return draftRead(value);
  if (!modelRecord(value)) return false;
  if (operation === "taskUnwatch") return value.removed === true;
  if (operation === "taskHistoryCapabilities")
    return typeof value.enabled === "boolean" && typeof value.runNow === "boolean";
  if (operation === "taskDraftStart")
    return (
      typeof value.threadId === "string" &&
      typeof value.requestId === "string" &&
      (value.modelNotice === undefined ||
        value.modelNotice === "effort-unsupported" ||
        value.modelNotice === "model-unavailable")
    );
  if (operation === "taskDraftHistory")
    return (
      Array.isArray(value.messages) &&
      value.messages.every(draftMessage) &&
      ["threadId", "timeZone"].every(
        (key) => value[key] === undefined || typeof value[key] === "string",
      )
    );
  return false;
}

/** @typedef {import('./generated/management-owner-directory-protocol.cjs').RunDirectoryRow} RunDirectoryRow */
/** @typedef {import('./generated/management-owner-directory-protocol.cjs').TaskDirectoryRow} TaskDirectoryRow */
/** @typedef {import('./generated/management-owner-directory-protocol.cjs').OwnerAttention} OwnerAttention */
/** @typedef {import('./generated/management-owner-directory-protocol.cjs').OwnerNoticeFact} OwnerNoticeFact */
/** @typedef {import('./generated/management-owner-directory-protocol.cjs').OwnerWatch} OwnerBarrier */
/** @typedef {import('./generated/management-owner-directory-protocol.cjs').OwnerInvalidation} OwnerInvalidation */
/** @param {string|null|undefined} value @param {number} bytes */
const boundedPreview = (value, bytes) =>
  value == null || new TextEncoder().encode(value).length <= bytes;
/** @param {unknown} value @returns {value is TaskDirectoryRow} */
function taskDirectoryRow(value) {
  return (
    ownerProtocol.isTaskDirectoryRow(value) &&
    boundedPreview(value.objectivePreview, 512) &&
    boundedPreview(value.latestRun?.reasonPreview, 256) &&
    boundedPreview(value.activeRun?.reasonPreview, 256)
  );
}
/** @param {unknown} value @returns {TaskDirectoryRow} */
function readTaskDirectoryRow(value) {
  if (!taskDirectoryRow(value)) throw new Error("Core 任务摘要结构无效");
  return value;
}
/** @param {unknown} value */
function readOwnerBarrier(value) {
  if (!ownerProtocol.isOwnerWatch(value)) throw new Error("Core owner watch 屏障结构无效");
  return value;
}
/** @param {unknown} value */
function readOwnerInvalidation(value) {
  if (
    !ownerProtocol.isOwnerInvalidation(value) ||
    !value.facts.every((fact) => boundedPreview(fact.objectivePreview, 512))
  )
    throw new Error("Core owner 失效通知结构无效");
  return value;
}
/** @param {unknown} value */
function readDirectoryPage(value) {
  if (!ownerProtocol.isTaskDirectoryPage(value) || !value.data.every(taskDirectoryRow))
    throw new Error("Core 任务摘要分页结构无效");
  return { ...value, nextCursor: value.nextCursor ?? null };
}
/** @param {unknown} value */
function readDirectoryRows(value) {
  if (!ownerProtocol.isTaskDirectoryRows(value) || !value.data.every(taskDirectoryRow))
    throw new Error("Core 任务摘要定向读取结构无效");
  return value;
}
/** @param {unknown} value */
function readAttentionPage(value) {
  if (
    !ownerProtocol.isOwnerAttentionPage(value) ||
    !value.data.every(
      (row) => boundedPreview(row.objectivePreview, 512) && boundedPreview(row.summary, 256),
    )
  )
    throw new Error("Core 任务关注分页结构无效");
  return { ...value, nextCursor: value.nextCursor ?? null };
}
