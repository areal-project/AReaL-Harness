// @ts-check
"use strict";
const { modelRecord } = require("@areal/workbench/core-model-contract");
const {
  readAdmission,
  readThreadAdmission,
  readQueueAdmission,
} = require("@areal/workbench/desktop-contract/shared");
// Consumed fields of protocol::ManagedProcess and workgroup::service::read; other payload fields remain unknown.
/** @typedef {Record<string,unknown> & {planRevision:number,revisions?:Record<string,{planRevision:number}>}} WorkgroupRecord */
/** @typedef {Record<string,unknown> & {id:string,record:WorkgroupRecord}} Workgroup */
/** @typedef {Record<string,unknown> & {operationId:string,outcome:string}} ProcessOperation */
/** @typedef {Record<string,unknown> & {id:string,inputs:ProcessOperation[]}} Process */
/** @param {unknown} value @returns {Workgroup} */
function readWorkgroup(value) {
  if (!workgroup(value))
    throw Object.assign(new Error("工作组受理结果不完整，原请求仍待核对"), {
      code: "ADMISSION_RESULT_INVALID",
      submissionUnknown: true,
      outcome: { kind: "unconfirmed" },
      recovery: { kind: "queryOriginal" },
    });
  return value;
}
/** @param {unknown} value @returns {{data:Process[]}} */
function readProcesses(value) {
  if (!modelRecord(value) || !Array.isArray(value.data) || !value.data.every(processRecord))
    throw new Error("终端记录结构无效，原请求仍待核对");
  return { data: value.data };
}
/** @param {unknown} value @returns {value is Process} */
function processRecord(value) {
  return (
    modelRecord(value) &&
    typeof value.id === "string" &&
    Array.isArray(value.inputs) &&
    value.inputs.every(processOperation)
  );
}
/** @param {unknown} value @returns {value is ProcessOperation} */
function processOperation(value) {
  return (
    modelRecord(value) && typeof value.operationId === "string" && typeof value.outcome === "string"
  );
}
/** @param {unknown} value @returns {value is Workgroup} */
function workgroup(value) {
  return (
    modelRecord(value) &&
    typeof value.id === "string" &&
    modelRecord(value.record) &&
    revision(value.record) &&
    (value.record.revisions === undefined ||
      (modelRecord(value.record.revisions) &&
        Object.values(value.record.revisions).every(revision)))
  );
}
/** @param {unknown} value @returns {value is Record<string,unknown> & {planRevision:number}} */
function revision(value) {
  return (
    modelRecord(value) &&
    typeof value.planRevision === "number" &&
    Number.isSafeInteger(value.planRevision)
  );
}
/** @param {unknown} value @returns {Record<string,unknown>} */
function submissionError(value) {
  if (!modelRecord(value)) throw value;
  return value;
}
module.exports = {
  readQueueAdmission,
  readAdmission,
  readThreadAdmission,
  readWorkgroup,
  readProcesses,
  submissionError,
};

/** @typedef {import("@areal/workbench/desktop-contract/shared").Admission} Admission */
