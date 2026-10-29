// @ts-check
"use strict";
const { turnAdmission } = require("./conversation.cjs");
const { record, identifier, invalid } = require("./transport.cjs");
/** @typedef {import('./conversation.cjs').Attachment} Attachment */
/** @typedef {{operation:'status'}|{operation:'save',baseURL:string,token?:string}} SettingsRequest */
/** @typedef {{baseURL:string,tokenConfigured:boolean}} SettingsResponse */
/** @typedef {{projectId:string}&({operation:'create',requestId:string}|{operation:'open'|'reconnect',threadId:string}|{operation:'send',threadId:string,text:string,attachments?:Attachment[]}|{operation:'stop',threadId:string,turnId:string})} SessionRequest */
/** @template {SessionRequest} P @typedef {P extends {operation:'create'} ? {threadId:string,sessionId:string} : P extends {operation:'open'|'reconnect'} ? {projects:unknown[]} : P extends {operation:'send'} ? import("./conversation.cjs").TurnAdmission : Record<string,unknown>} SessionResponse */
/** @param {unknown} value */
function attachment(value) {
  return (
    record(value) &&
    ["image", "audio", "file"].includes(String(value.type)) &&
    typeof value.url === "string" &&
    /^areal:\/\/blob\/[A-Za-z0-9_-]+$/.test(value.url) &&
    (value.name === undefined || typeof value.name === "string") &&
    (value.mimeType === undefined || typeof value.mimeType === "string") &&
    Object.keys(value).every((key) => ["type", "url", "name", "mimeType"].includes(key))
  );
}
/** @param {'cloud'|'cloudSession'} name @param {unknown} params */
function validateRequest(name, params) {
  if (!record(params)) return invalid();
  if (name === "cloud") {
    if (
      !["status", "save"].includes(String(params.operation)) ||
      Object.keys(params).some((key) => !["operation", "baseURL", "token"].includes(key)) ||
      (params.operation === "status" && Object.keys(params).length !== 1) ||
      (params.operation === "save" &&
        (typeof params.baseURL !== "string" ||
          (params.token !== undefined && typeof params.token !== "string")))
    )
      invalid();
    return;
  }
  if (!identifier(params.projectId)) invalid();
  const fields =
    params.operation === "create"
      ? ["requestId"]
      : params.operation === "send"
        ? ["threadId", "text", "attachments"]
        : params.operation === "stop"
          ? ["threadId", "turnId"]
          : ["threadId"];
  if (
    !["create", "open", "reconnect", "send", "stop"].includes(String(params.operation)) ||
    Object.keys(params).some((key) => !["operation", "projectId", ...fields].includes(key)) ||
    (params.operation !== "create" && !identifier(params.threadId)) ||
    (params.operation === "create" &&
      (typeof params.requestId !== "string" || !/^[0-9a-f-]{36}$/.test(params.requestId))) ||
    (params.operation === "stop" && !identifier(params.turnId)) ||
    (params.operation === "send" &&
      (typeof params.text !== "string" ||
        (!params.text.trim() &&
          (!Array.isArray(params.attachments) || !params.attachments.length)) ||
        (params.attachments !== undefined &&
          (!Array.isArray(params.attachments) ||
            params.attachments.length > 16 ||
            !params.attachments.every(attachment)))))
  )
    invalid();
}
/** @param {'cloud'|'cloudSession'} name @param {SettingsRequest|SessionRequest} params @param {unknown} value */
function isResponse(name, params, value) {
  if (!record(value)) return false;
  if (name === "cloud")
    return typeof value.baseURL === "string" && typeof value.tokenConfigured === "boolean";
  if (params.operation === "create")
    return identifier(value.threadId) && identifier(value.sessionId);
  if (params.operation === "open" || params.operation === "reconnect")
    return Array.isArray(value.projects);
  return params.operation === "send" ? turnAdmission(value) : true;
}
module.exports = { validateRequest, isResponse };
