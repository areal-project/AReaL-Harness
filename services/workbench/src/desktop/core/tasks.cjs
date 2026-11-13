// @ts-check
"use strict";
const { manageTaskDraft, taskDraftOperations } = require("./task-draft.cjs");

const { readTask, readTaskRequest } = require("@areal/workbench/desktop-contract/management-tasks");
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

/** @param {Backend} backend @param {Project} project @param {Record<string,unknown>} rawRequest */
async function manageTask(backend, project, rawRequest) {
  const request = readTaskRequest(rawRequest);
  if (taskDraftOperations.has(request.operation)) return manageTaskDraft(backend, project, request);
  /** @type {Record<string,unknown>} */
  const payload = { ...request, executionProjectId: project.id };
  delete payload.logicalProjectId;
  if (request.operation === "taskDraftSend") {
    payload.input = require("./media.cjs").messageInput(backend, request);
    for (const key of ["text", "attachments", "mcpContent", "conversationQuotes"])
      delete payload[key];
  }
  const reading =
    reads[request.operation] ||
    [
      "taskDraftRead",
      "taskDraftHistory",
      "taskHistoryCapabilities",
      "taskWatch",
      "taskUnwatch",
    ].includes(request.operation);
  const value = await backend.hostCall(reading ? "tasks.read" : "tasks.command", payload);
  if (
    [
      "task",
      "taskWatch",
      "taskCreate",
      "taskUpdate",
      "taskPause",
      "taskResume",
      "taskCancel",
      "taskDelete",
      "taskStopRun",
      "taskResumeRun",
      "taskDraftConfirm",
    ].includes(request.operation)
  )
    project.model.setTask(readTask(value));
  return value;
}
module.exports = { manageTask, taskOperations, taskMutationMethods };
