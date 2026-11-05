// @ts-check
"use strict";
const { modelRecord } = require("@areal/workbench/core-model-contract");
const { schedule } = require("@areal/workbench/desktop-contract/management-tasks");
/** @typedef {ReturnType<typeof taskDraftTarget>} Target */

// Saved editing context is a projection, not a complete runtime Task snapshot.
/** @param {unknown} value @returns {Target} */
function readTaskDraftTarget(value) {
  if (
    !modelRecord(value) ||
    typeof value.taskId !== "string" ||
    typeof value.expectedRevision !== "number" ||
    !Number.isSafeInteger(value.expectedRevision) ||
    value.expectedRevision < 0 ||
    typeof value.objective !== "string" ||
    typeof value.paused !== "boolean" ||
    (value.interactionMode !== "interactive" &&
      value.interactionMode !== "asynchronous" &&
      value.interactionMode !== "headless") ||
    (value.nextRunAt != null &&
      (typeof value.nextRunAt !== "number" || !Number.isSafeInteger(value.nextRunAt))) ||
    (value.schedule != null && !isLegacySchedule(value.schedule)) ||
    (value.scheduleV2 != null && !schedule(value.scheduleV2))
  )
    throw new Error("原安排身份无效");
  return {
    taskId: value.taskId,
    expectedRevision: value.expectedRevision,
    objective: value.objective,
    schedule: value.schedule,
    scheduleV2: value.scheduleV2,
    nextRunAt: value.nextRunAt,
    interactionMode: value.interactionMode,
    paused: value.paused,
  };
}

/** @param {import('@areal/workbench/desktop-contract/management-tasks').Task} task */
const taskDraftTarget = (task) => ({
  taskId: task.id,
  expectedRevision: task.revision,
  objective: task.objective,
  schedule: task.schedule,
  scheduleV2: task.scheduleV2,
  nextRunAt: task.nextRunAt,
  interactionMode: task.interactionMode,
  paused: task.paused,
});

/** @param {unknown} value @returns {value is NonNullable<Target['schedule']>} */
function isLegacySchedule(value) {
  return (
    modelRecord(value) &&
    typeof value.at === "number" &&
    Number.isSafeInteger(value.at) &&
    (value.intervalSeconds == null ||
      (typeof value.intervalSeconds === "number" &&
        Number.isSafeInteger(value.intervalSeconds) &&
        value.intervalSeconds >= 0)) &&
    (value.timeZone == null || typeof value.timeZone === "string") &&
    Object.keys(value).every((key) => ["at", "intervalSeconds", "timeZone"].includes(key))
  );
}

module.exports = { readTaskDraftTarget, taskDraftTarget };
