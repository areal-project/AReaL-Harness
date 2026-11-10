// @ts-check
"use strict";
const { modelRecord } = require("@areal/workbench/core-model-contract");
/** @typedef {{id:string,threadId?:string,ambiguous?:boolean}} OwnerRecord */
/** @param {string} message */
const unavailable = (message) =>
  Object.assign(new Error(message), {
    code: "TASK_WORKSPACE_UNAVAILABLE",
    submissionUnknown: false,
    outcome: { kind: "noMutation" },
  });
/** @param {unknown} value @returns {value is string} */
const identifier = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("\0");

/** 任务执行归属由 Host 持有；这里只读取并校验回执。 */
class TaskWorkspaceOwners {
  /** @param {InstanceType<typeof import('./backend.cjs').CoreBackend>} backend */
  constructor(backend) {
    this.backend = backend;
  }
  /** @param {string} logicalId @param {string} taskId @param {{execution?:boolean}} [options] */
  async target(logicalId, taskId, options = {}) {
    if (!this.backend.hostCall) throw unavailable("Host 任务归属不可用");
    const value = await this.backend.hostCall("tasks.owner.read", { projectId: logicalId, taskId, execution: options.execution === true });
    if (!modelRecord(value) || !identifier(value.projectId) ||
        (value.threadId !== undefined && !identifier(value.threadId)) ||
        (value.mode !== undefined && !["foreground","background","scheduled"].includes(String(value.mode))))
      throw unavailable("Host 任务执行归属无效");
    return { projectId: value.projectId, ...(typeof value.threadId === "string" ? { threadId: value.threadId } : {}),
      ...(typeof value.mode === "string" ? { mode: value.mode } : {}) };
  }
  /** @param {string} logicalId @param {string} taskId */
  async resolve(logicalId, taskId) {
    return (await this.target(logicalId, taskId)).projectId;
  }
}
module.exports = { TaskWorkspaceOwners };
