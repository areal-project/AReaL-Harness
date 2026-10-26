// @ts-check
"use strict";
const { desktopError } = require("@areal/workbench/desktop-contract");
const { modelRecord } = require("@areal/workbench/core-model-contract");
const { validToolInput } = require("./browser-tool.cjs");
/** @typedef {import('./preview-native/model.js').HostRequest|import('./preview-native/model.js').DiscoveryRequest} BrowserHostRequest */
/** The Desktop service adds authenticated identity to the already validated Core browser tool input. */
/** @param {unknown} value @returns {BrowserHostRequest} */
function readBrowserHostRequest(value) {
  if (!browserHostRequest(value)) throw new Error("Invalid browser host request");
  return value;
}
/** @param {unknown} value @returns {value is BrowserHostRequest} */
function browserHostRequest(value) {
  if (
    !modelRecord(value) ||
    !["coreInstanceId", "coreGeneration", "projectId", "threadId", "turnId", "callId"].every(
      (key) => typeof value[key] === "string",
    ) ||
    typeof value.requestId !== "number" ||
    !Number.isSafeInteger(value.requestId) ||
    (value.phase !== "prepare" && value.phase !== "execute") ||
    (value.browserApproval !== undefined && !modelRecord(value.browserApproval))
  )
    return false;
  if (value.operation === "describe") return true;
  return (
    ["pageId", "browserHostId"].every((key) => typeof value[key] === "string") &&
    ["hostGeneration", "pageGeneration", "controlEpoch"].every(
      (key) => typeof value[key] === "number" && Number.isSafeInteger(value[key]),
    ) &&
    (value.batchDeadline === undefined || typeof value.batchDeadline === "number") &&
    value.batchGuard === undefined &&
    (value.workspacePath === undefined || typeof value.workspacePath === "string") &&
    validToolInput({ operation: value.operation, parameters: value.parameters })
  );
}
/** 原请求身份与白名单原因沿宿主回执保留，派发后未知不能退化成未发送。
 * @param {Record<string,unknown>} request @param {unknown} error
 */
function browserHostFailure(request, error) {
  const message = desktopError(error).message;
  const reason = modelRecord(error) ? error.reason : undefined;
  return {
    coreInstanceId: request.coreInstanceId,
    coreGeneration: request.coreGeneration,
    projectId: request.projectId,
    threadId: request.threadId,
    turnId: request.turnId,
    callId: request.callId,
    pageId: request.pageId,
    browserHostId: request.browserHostId,
    hostGeneration: request.hostGeneration,
    pageGeneration: request.pageGeneration,
    controlEpoch: request.controlEpoch,
    ...(message === "outcome_unknown"
      ? {
          dispatch: "unknown",
          reason:
            reason === "navigation_timeout" || reason === "navigation_interrupted"
              ? reason
              : "action_unconfirmed",
        }
      : {}),
    error:
      message === "outcome_unknown"
        ? "outcome_unknown"
        : message === "human_control" || /Human controls|revoked/.test(message)
          ? "human_control"
          : message === "stale_ref"
            ? "stale_ref"
            : /plan_stale/.test(message)
              ? "plan_stale"
              : message === "human_takeover_required"
                ? "human_takeover_required"
                : message === "condition_timeout"
                  ? "condition_timeout"
                  : /not_sent|target_unavailable/.test(message)
                    ? "not_sent"
                    : /budget exceeded|Sensitive field|viewport changed|content changed during capture|capture guard unavailable/.test(
                          message,
                        )
                      ? "evidence_unavailable"
                      : "page_unavailable",
  };
}
module.exports = { readBrowserHostRequest, browserHostFailure };
