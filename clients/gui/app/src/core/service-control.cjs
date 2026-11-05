// @ts-check
"use strict";
const { hostReference } = require("./host-lifecycle.cjs");
const { isDeepStrictEqual } = require("node:util");
const { KINDS, isLifecycleReceipt } = require("@areal/workbench/desktop-contract/shared");
/** @typedef {import('@areal/workbench-service/desktop/core/lifecycle-operations.cjs').LifecycleKind} Kind */
/** @typedef {import('@areal/workbench-service/desktop/core/lifecycle-operations.cjs').LifecycleMode} Mode */
/** @typedef {import('@areal/workbench-service/desktop/core/lifecycle-operations.cjs').TargetPhase} TargetPhase */
/** @typedef {{projectId:string,serviceId:string|null,generation:string|null,phase?:import('@areal/workbench/desktop-contract/shared').TargetPhase,error?:unknown}} ReferenceTarget */
/** @typedef {{pid:number,identity:string}} DesktopIdentity */
/** @typedef {{requestId:string,desktopGeneration:string,kind:Kind,mode:Mode,targets:ReferenceTarget[],desktop:DesktopIdentity,threadId?:string,turnId?:string,logicalProjectId?:string}} LifecycleReference */
/** @typedef {{projectId:string,serviceId:string,generation:string,phase:TargetPhase,error?:unknown,[key:string]:unknown}} ResponseTarget */
/** @typedef {import('@areal/workbench/desktop-contract/shared').LifecycleReceipt} LifecycleResponse */

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** @param {unknown} value @returns {value is string} */
function uuid(value) {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
  );
}
/** @param {unknown} value @returns {value is Kind} */
function kind(value) {
  return KINDS.some((kind) => kind === value);
}
/** @param {unknown} value @returns {value is ReferenceTarget} */
function referenceTarget(value) {
  return (
    record(value) &&
    typeof value.projectId === "string" &&
    (value.serviceId === null || typeof value.serviceId === "string") &&
    (value.generation === null || typeof value.generation === "string") &&
    (value.phase === undefined ||
      [
        "notAttempted",
        "acceptedPending",
        "blocked",
        "admissionUnconfirmed",
        "settlementIncomplete",
        "completed",
      ].some((phase) => value.phase === phase))
  );
}
/** @param {unknown} value @returns {value is LifecycleReference} */
function reference(value) {
  return (
    record(value) &&
    uuid(value.requestId) &&
    uuid(value.desktopGeneration) &&
    kind(value.kind) &&
    (value.mode === "ifIdle" || value.mode === "cancel") &&
    Array.isArray(value.targets) &&
    value.targets.every(referenceTarget) &&
    record(value.desktop) &&
    typeof value.desktop.pid === "number" &&
    Number.isSafeInteger(value.desktop.pid) &&
    value.desktop.pid > 1 &&
    typeof value.desktop.identity === "string" &&
    ["threadId", "turnId", "logicalProjectId"].every(
      (key) => value[key] === undefined || typeof value[key] === "string",
    ) &&
    (value.kind !== "interruptTurn" ||
      (typeof value.threadId === "string" && typeof value.turnId === "string"))
  );
}
/** @param {unknown} value @returns {(LifecycleReference|import("./host-lifecycle.cjs").HostReference)[]} */
function readReferences(value) {
  if (!Array.isArray(value) || !value.every((item) => reference(item) || hostReference(item)))
    throw Object.assign(new Error("后台操作引用损坏，请保留记录并检查原后台"), {
      code: "LIFECYCLE_REFERENCE_INVALID",
    });
  return value;
}
/** @param {LifecycleReference} reference @param {unknown} value @returns {value is LifecycleResponse} */
function lifecycleResponse(reference, value) {
  return (
    isLifecycleReceipt(value) &&
    value.requestId === reference.requestId &&
    value.desktopGeneration === reference.desktopGeneration &&
    value.kind === reference.kind &&
    value.mode === reference.mode &&
    isDeepStrictEqual(require("./lifecycle.cjs").targets(value.targets), reference.targets) &&
    (reference.kind !== "interruptTurn" ||
      (value.threadId === reference.threadId && value.turnId === reference.turnId))
  );
}
/** @param {LifecycleReference} reference @param {unknown} value @returns {LifecycleResponse} */
function readLifecycleResponse(reference, value) {
  if (!lifecycleResponse(reference, value))
    throw Object.assign(new Error("后台回执与原操作身份不一致"), {
      code: "LIFECYCLE_RECEIPT_INVALID",
      submissionUnknown: true,
    });
  return value;
}
module.exports = { readReferences, readLifecycleResponse };
