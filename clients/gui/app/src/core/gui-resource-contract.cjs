// @ts-check
"use strict";
/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** @param {unknown} requestId @param {boolean} mutation @returns {never} */
function invalidResponse(requestId, mutation) {
  throw Object.assign(new Error("GUI 资源响应身份不完整，请核对原请求"), {
    code: "GUI_RESOURCE_RESPONSE_INVALID",
    requestId,
    submissionUnknown: mutation,
    outcome: { kind: mutation ? "unconfirmed" : "noMutation" },
    recovery: { kind: mutation ? "queryOriginal" : "retryRead" },
  });
}
/** @param {Record<string,unknown>} value */
function readGuiThreadIdentity(value) {
  if (typeof value.projectId !== "string" || typeof value.threadId !== "string")
    throw Object.assign(new Error("无效桌面任务身份"), { code: "INVALID_DESKTOP_REQUEST" });
  return { projectId: value.projectId, threadId: value.threadId };
}
/** @param {unknown} value @param {unknown} requestId @param {boolean} recovery @returns {{confirmed:true,id:string}|{confirmed:false}} */
function readGuiProcessResponse(value, requestId, recovery) {
  if (!record(value)) invalidResponse(requestId, !recovery);
  if (recovery && !value.confirmed) return { confirmed: false };
  const process = recovery ? value.result : value;
  if (!record(process) || typeof process.id !== "string") invalidResponse(requestId, !recovery);
  return { confirmed: true, id: process.id };
}
/** @param {unknown} value @returns {Array<{id:string,cleanupConfirmed:boolean}>} */
function readGuiProcesses(value) {
  if (!record(value) || !Array.isArray(value.data) || !value.data.every(guiProcess))
    invalidResponse(undefined, false);
  return value.data;
}
/** @param {unknown} value @returns {value is {id:string,cleanupConfirmed:boolean}} */
function guiProcess(value) {
  return (
    record(value) && typeof value.id === "string" && typeof value.cleanupConfirmed === "boolean"
  );
}
module.exports = {
  readGuiProcesses,
  readGuiThreadIdentity,
  readGuiProcessResponse,
};
