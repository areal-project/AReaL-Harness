// @ts-check
"use strict";
const { nativeText } = require("./native-i18n.cjs");
const { isDeepStrictEqual } = require("node:util");
const { readReceipts } = require("@areal/workbench/desktop-contract/shared");
const { modelRecord } = require("@areal/workbench/core-model-contract");
/** @typedef {import('./project-state.cjs').PendingSubmission} Pending */
/** @typedef {import('@areal/workbench/desktop-contract/shared').ReceiptError} ReceiptError */
/** @typedef {import('@areal/workbench/desktop-contract/shared').ReceiptResponse} ReceiptResponse */
/** @typedef {import('@areal/workbench/desktop-contract/shared').Receipt} Receipt */
const creationTargets = new Map([
  ["areal/thread/start", "thread"],
  ["areal/thread/fork", "thread"],
  ["areal/side/start", "thread"],
  ["areal/side/create", "thread"],
  ["areal/task/create", "task"],
]);
const processControls = new Set([
  "areal/process/write",
  "areal/process/closeStdin",
  "areal/process/resize",
  "areal/process/terminate",
]);
/** @param {string} method @param {import('./project-state.cjs').SubmissionParams} params @returns {import('@areal/runtime-client/core').OperationRef} */
const operationOf = (method, params) => ({
  method,
  requestId: params.requestId,
  target: creationTargets.has(method)
    ? { kind: "project" }
    : params.taskId
      ? { kind: "task", taskId: params.taskId }
      : params.threadId
        ? { kind: "thread", threadId: params.threadId }
        : { kind: "project" },
});
/** @param {unknown} error */
const explicitRejection = (error) =>
  modelRecord(error) &&
  modelRecord(error.outcome) &&
  ["rejected", "noMutation"].includes(String(error.outcome.kind));
/** @param {Pending} entry @param {Receipt[]} records @param {string} [scopedThreadId] */
function matchingReceipt(entry, records, scopedThreadId) {
  const operation = entry.operation ?? operationOf(entry.method, entry.params);
  const receiptMethod = processControls.has(entry.method) ? "areal/process/control" : entry.method;
  return records.find((receipt) => {
    const actual = receipt.operation;
    if (
      (actual?.requestId ?? receipt.requestId) !== operation.requestId ||
      (actual?.method ?? receipt.method) !== receiptMethod ||
      (entry.digest && receipt.digest !== entry.digest)
    )
      return false;
    const createdKind = creationTargets.get(entry.method);
    if (createdKind) {
      const result = modelRecord(receipt.result) ? receipt.result : undefined;
      const thread = modelRecord(result?.thread) ? result.thread : undefined;
      const id =
        createdKind === "task"
          ? (receipt.taskId ?? result?.id)
          : (receipt.threadId ?? result?.threadId ?? thread?.id);
      return (
        typeof id === "string" &&
        (!actual ||
          (actual.target.kind === "task" &&
            createdKind === "task" &&
            actual.target.taskId === id) ||
          (actual.target.kind === "thread" &&
            createdKind === "thread" &&
            actual.target.threadId === id))
      );
    }
    if (actual) return isDeepStrictEqual(actual.target, operation.target);
    if (operation.target.kind === "thread")
      return (receipt.threadId ?? scopedThreadId) === operation.target.threadId;
    if (operation.target.kind === "task") return receipt.taskId === operation.target.taskId;
    return !receipt.threadId && !receipt.taskId;
  });
}
/** @param {Pending} entry @param {ReturnType<typeof readReceipts>} result @param {import('@areal/runtime-client/core').CoreClient['capabilities']} capabilities @param {string} [scopedThreadId] @returns {Receipt|undefined} */
function reconcileReceipt(entry, result, capabilities, scopedThreadId) {
  const receipt = matchingReceipt(entry, result.data, scopedThreadId);
  // 普通回执只证明已受理；只有下面核验过的独立证明能生成 accepted:false。
  if (receipt) return { ...receipt, accepted: true };
  const proof = result.creationAdmission;
  const original = entry.params.creationAdmission;
  const coverage = capabilities?.features?.threadCreationJournal?.binding;
  if (
    entry.method === "areal/thread/start" &&
    capabilities?.features?.threadCreationJournal &&
    original &&
    proof?.status === "notAdmitted" &&
    coverage?.identity === original.identity &&
    proof.identity === original.identity &&
    coverage.journalEpoch === original.journalEpoch &&
    coverage.coreInstanceId !== original.coreInstanceId &&
    proof.requestId === entry.params.requestId &&
    proof.journalEpoch === original.journalEpoch &&
    proof.coreInstanceId === original.coreInstanceId &&
    result.data.length === 0
  ) {
    return {
      method: entry.method,
      requestId: entry.params.requestId,
      status: "failed",
      accepted: false,
      operation: entry.operation ?? operationOf(entry.method, entry.params),
      error: {
        message: nativeText("recovery.creationNotAdmitted"),
        data: { reason: "NOT_ADMITTED" },
      },
    };
  }
  return undefined;
}
/** @param {Receipt} receipt */
const receiptStatus = (receipt) =>
  receipt.status ??
  (receipt.response?.error
    ? "failed"
    : receipt.result !== undefined || receipt.response?.result !== undefined
      ? "completed"
      : "admitted");
/** @param {Receipt} receipt */
const receiptResult = (receipt) => receipt.result ?? receipt.response?.result;
/** @param {unknown} value @returns {string|undefined} */
function readReceiptIdentity(value) {
  if (value == null) return undefined;
  if (typeof value !== "string")
    throw Object.assign(new Error("Core 受理关联无效，原请求仍待核对"), {
      code: "RECEIPT_INVALID",
    });
  return value;
}
// 精确 Remote 停止/交互不会重放；保留日志用于核对，不阻塞后续桌面操作。
/** @param {Pending} entry */
const isRemoteControl = (entry) =>
  (entry.method === "turn/interrupt" &&
    entry.remote?.method === "turn.stop" &&
    entry.remote.capability === "interrupt" &&
    typeof entry.operationId === "string" &&
    typeof entry.params?.turnId === "string" &&
    entry.remote.target?.expectedTurnId === entry.params.turnId &&
    typeof entry.params.threadId === "string" &&
    entry.remote.target.threadId === entry.params.threadId) ||
  (entry.method === "areal/interaction/respond" &&
    entry.remote?.method === "interaction.respond" &&
    entry.remote.capability === "answer" &&
    typeof entry.operationId === "string" &&
    typeof entry.params?.requestId === "string" &&
    entry.remote.target?.interactionId === entry.params.requestId &&
    typeof entry.params.turnId === "string" &&
    entry.remote.target.turnId === entry.params.turnId &&
    typeof entry.params.threadId === "string" &&
    entry.remote.target.threadId === entry.params.threadId) ||
  (entry.method === "areal/channel/reply" &&
    entry.remote?.method === "task.question.reply" &&
    entry.remote.capability === "answer" &&
    typeof entry.operationId === "string" &&
    entry.params?.requestId === entry.operationId &&
    ["taskId", "runId", "questionId"].every(
      (key) =>
        typeof entry.params[key] === "string" && entry.remote?.target?.[key] === entry.params[key],
    )) ||
  (entry.method === "areal/task/pause" &&
    entry.remote?.method === "task.pause" &&
    entry.remote.capability === "pauseTask" &&
    typeof entry.operationId === "string" &&
    entry.params?.requestId === entry.operationId &&
    ["taskId", "expectedRunId"].every(
      (key) =>
        typeof entry.params[key] === "string" && entry.remote?.target?.[key] === entry.params[key],
    ) &&
    Number.isSafeInteger(entry.params.expectedRevision) &&
    entry.remote.target.expectedRevision === entry.params.expectedRevision);

/** 从已校验服务快照保留原操作身份；缺失或跨 Core 代次时继续保持 UNKNOWN。
 * @param {import('@areal/workbench/desktop-contract/shared').ServiceProject|undefined} project
 * @param {import('@areal/workbench/desktop-contract/shared').ProjectCapabilities|undefined} core
 * @param {{threadId?:unknown,taskId?:unknown}} expected @param {string} requestId
 */
function observedOperation(project, core, expected, requestId) {
  if (
    !core?.instanceId ||
    project?.core?.instanceId !== core.instanceId ||
    project.core.connectionGeneration !== core.connectionGeneration
  )
    return;
  const operation =
    project.pending?.find((entry) => entry.params.requestId === requestId)?.operation ??
    project.outcomes?.[requestId]?.operation;
  if (!operation || operation.requestId !== requestId) return;
  if (
    (operation.target.kind === "thread" && operation.target.threadId === expected.threadId) ||
    (operation.target.kind === "task" && operation.target.taskId === expected.taskId)
  )
    return operation;
}

module.exports = {
  observedOperation,
  isRemoteControl,
  creationTargets,
  processControls,
  operationOf,
  explicitRejection,
  readReceipts,
  matchingReceipt,
  reconcileReceipt,
  receiptStatus,
  receiptResult,
  readReceiptIdentity,
};
