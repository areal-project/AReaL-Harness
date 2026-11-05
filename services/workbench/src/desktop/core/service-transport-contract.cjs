// @ts-check
"use strict";
/** @typedef {Record<string,unknown>} Fields */
/** @typedef {Fields & {signal?:AbortSignal}} ToolHostInput */
/** @typedef {Pick<import('../../../../../clients/gui/app/src/core/preview-native/model.js').HostIdentity,'projectId'|'threadId'|'turnId'|'callId'|'coreInstanceId'|'coreGeneration'> & {signal?:AbortSignal,arguments?:unknown,toolHostGeneration?:string,phase?:'prepare'|'execute',discardPreparedPlan?:boolean,browserApproval?:Fields & {plan?:Fields & {preparedActionId:string}},computerApproval?:unknown}} ToolRequest */
/** @typedef {Pick<import('../../../../../clients/gui/app/src/core/preview-native/model.js').DiscoveryPlan,'operation'|'preparedActionId'|'fingerprint'|'origin'|'pageId'|'browserHostId'|'alreadyControlled'|'hostGeneration'|'pageGeneration'|'controlEpoch'|'humanRevision'|'documentEpoch'|'expiresAt'|'coreInstanceId'|'coreGeneration'|'projectId'|'threadId'|'turnId'|'callId'> & Fields} DiscoveryPlan */
/** @typedef {{registrationId:string,tools:Array<Fields & {schemaDigest:string}>,[key:string]:unknown}} PageRegistration */
/** @typedef {{projectId:string,threadId:string,instanceId:string,generation:string|number,operation:'register'|'revoke'|'claim'|'resolve',registrationId?:string,turnId?:string,callId?:string,ownerId?:string,schemaDigest?:string,claimId?:string,declaration?:unknown,reply?:unknown}} PageToolRequest */
/** @typedef {Fields & {threadId:string,turnId:string,callId:string,registrationId:string,ownerId:string,schemaDigest:string,claimId?:string}} PageCoordinates */
/** @param {unknown} value @returns {value is Fields} */
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** @param {unknown} value @returns {value is string} */
function text(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}
/** @param {unknown} value @returns {value is number} */
function integer(value) {
  return typeof value === "number" && Number.isSafeInteger(value);
}
/** @param {unknown} value @returns {value is string[]} */
function strings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
/** @param {ToolHostInput} value @returns {value is ToolHostInput & ToolRequest} */
function toolRequest(value) {
  return (
    record(value) &&
    ["projectId", "threadId", "turnId", "callId", "coreInstanceId", "coreGeneration"].every(
      (key) => typeof value[key] === "string",
    ) &&
    (value.phase === undefined || value.phase === "prepare" || value.phase === "execute") &&
    (value.toolHostGeneration === undefined || typeof value.toolHostGeneration === "string") &&
    (value.discardPreparedPlan === undefined || typeof value.discardPreparedPlan === "boolean") &&
    (value.browserApproval === undefined ||
      (record(value.browserApproval) &&
        (value.browserApproval.plan === undefined ||
          (record(value.browserApproval.plan) &&
            typeof value.browserApproval.plan.preparedActionId === "string"))))
  );
}
/** @param {unknown} value @returns {value is DiscoveryPlan} */
function discoveryPlan(value) {
  return (
    record(value) &&
    value.operation === "describe" &&
    typeof value.preparedActionId === "string" &&
    typeof value.fingerprint === "string" &&
    typeof value.origin === "string" &&
    (value.pageId === null || typeof value.pageId === "string") &&
    typeof value.browserHostId === "string" &&
    typeof value.alreadyControlled === "boolean" &&
    [
      "hostGeneration",
      "pageGeneration",
      "controlEpoch",
      "humanRevision",
      "documentEpoch",
      "expiresAt",
    ].every((key) => integer(value[key])) &&
    ["coreInstanceId", "coreGeneration", "projectId", "threadId", "turnId", "callId"].every(
      (key) => typeof value[key] === "string",
    )
  );
}
/** @param {unknown} value @returns {PageRegistration} */
function pageRegistration(value) {
  if (!record(value) || typeof value.registrationId !== "string" || !Array.isArray(value.tools))
    throw new Error("Invalid page tool registration");
  const tools = value.tools.map((tool) => {
    if (!record(tool) || typeof tool.schemaDigest !== "string")
      throw new Error("Invalid page tool schema digest");
    return { ...tool, schemaDigest: tool.schemaDigest };
  });
  return { ...value, registrationId: value.registrationId, tools };
}
/** @param {unknown} value @returns {value is PageToolRequest} */
function pageToolRequest(value) {
  return (
    record(value) &&
    ["register", "revoke", "claim", "resolve"].some((operation) => operation === value.operation) &&
    ["projectId", "threadId", "instanceId"].every((key) => text(value[key])) &&
    (typeof value.generation === "string" || typeof value.generation === "number") &&
    ["registrationId", "turnId", "callId", "ownerId", "schemaDigest", "claimId"].every(
      (key) => value[key] === undefined || typeof value[key] === "string",
    )
  );
}
/** @param {unknown} value @returns {value is PageCoordinates} */
function pageCoordinates(value) {
  const coordinates = ["threadId", "turnId", "callId", "registrationId", "ownerId", "schemaDigest"];
  return (
    record(value) &&
    coordinates.every((key) => text(value[key])) &&
    Object.keys(value).every((key) => coordinates.includes(key) || key === "claimId") &&
    (value.claimId === undefined || text(value.claimId))
  );
}
/** @param {unknown} value */
function queueList(value) {
  if (!record(value) || !Array.isArray(value.items)) throw new Error("Invalid browser entry queue");
  const items = value.items.map((item) => {
    if (
      !record(item) ||
      typeof item.id !== "string" ||
      typeof item.status !== "string" ||
      (item.turnId != null && typeof item.turnId !== "string")
    )
      throw new Error("Invalid browser entry queue item");
    return { id: item.id, status: item.status, turnId: item.turnId };
  });
  return { ...value, items };
}
module.exports = {
  record,
  text,
  integer,
  strings,
  toolRequest,
  discoveryPlan,
  pageRegistration,
  pageToolRequest,
  pageCoordinates,
  queueList,
};
