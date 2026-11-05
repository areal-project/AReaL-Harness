// @ts-check
"use strict";
const { pluginMutation } = require("@areal/workbench/desktop-contract/management");
const { modelRecord } = require("@areal/workbench/core-model-contract");
/** @typedef {import('./project-state.cjs').SubmissionParams & {operation:string,mutation?:string}} Request */
/** @typedef {import('./project-state.cjs').CoreProject} Project */

/** @param {InstanceType<typeof import("./backend.cjs").CoreBackend>} backend @param {Project} project @param {Request} request
 * @param {string | undefined} method */
async function readPluginSubmission(backend, project, request, method) {
  if (
    !pluginMutation(request.mutation) ||
    !method ||
    typeof request.requestId !== "string" ||
    !request.requestId.trim()
  )
    throw new Error("缺少原插件提交标识");
  const receipt = await backend.readSubmission(project, method, {
    requestId: request.requestId,
    ...(request.threadId ? { threadId: request.threadId } : {}),
  });
  if (!receipt.confirmed) return receipt;
  const result = "result" in receipt ? receipt.result : undefined;
  const error = "error" in receipt ? receipt.error : undefined;
  let warning;
  if (
    !error &&
    request.mutation === "pluginSetup" &&
    modelRecord(result) &&
    modelRecord(result.thread) &&
    typeof result.thread.id === "string"
  ) {
    try {
      await backend.openThread(project, result.thread.id);
      await backend.listThreads(project);
    } catch (cause) {
      warning = `设置已受理，刷新对话失败：${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }
  backend.onChange();
  return { ...receipt, ...(warning ? { warning } : {}) };
}

module.exports = { readPluginSubmission };
