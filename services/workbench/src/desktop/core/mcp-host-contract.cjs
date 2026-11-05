// @ts-check
"use strict";
const { record, pageCoordinates } = require("./service-transport-contract.cjs");
/** @typedef {Record<string,unknown>} Fields */
/** @typedef {{projectId:string,threadId:string,serverId?:string,expectedGeneration?:string|number,toolName?:string,arguments?:unknown,filePath?:unknown,deepLink?:unknown,turnId?:string,itemId?:string}} OpenCoordinates */
/** @typedef {OpenCoordinates & {serverId:string,toolName:string,expectedGeneration:string|number}} OpenInput */
/** @typedef {OpenCoordinates & {turnId:string,itemId:string,requestId:string}} ResultInput */
/** @typedef {{jsonrpc:'2.0',method:string,id:string|number,params?:Fields}} AppRequest */
/** @typedef {{html:string,mimeType:string,_meta?:Fields & {ui?:Fields & {csp?:unknown},'openai/ui'?:Fields & {availableDisplayModes?:unknown}}}} AppResource */
/** @typedef {{instanceId:string,serverId:string,generation:string|number,resource:AppResource,hostContext?:Fields,toolMetadata?:unknown,initialArguments?:unknown,initialResult?:unknown}} OpenResult */
/** @typedef {{projectId:string,instanceId:string,generation:string|number,method:string,params:import('./service-transport-contract.cjs').PageCoordinates}} PageNotice */
/** @typedef {{registrationId:string,documentId:string,tools:{kind:string,schemaDigest:string}[]}} PageRegistration */
/** @param {unknown} value @returns {value is string} */
function text(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096;
}
/** @param {unknown} value @returns {value is OpenInput} */
function openInput(value) {
  return (
    record(value) &&
    ["projectId", "threadId", "serverId", "toolName"].every((key) => text(value[key])) &&
    (typeof value.expectedGeneration === "string" || typeof value.expectedGeneration === "number")
  );
}
/** @param {unknown} value @returns {value is ResultInput} */
function resultInput(value) {
  const keys = ["operation", "projectId", "threadId", "turnId", "itemId", "requestId"];
  return (
    record(value) &&
    Object.keys(value).every((key) => keys.includes(key)) &&
    ["projectId", "threadId", "turnId", "itemId", "requestId"].every(
      (key) => typeof value[key] === "string" && text(value[key]) && value[key].length <= 128,
    )
  );
}
/** @param {unknown} value @returns {value is AppRequest} */
function appRequest(value) {
  return (
    record(value) &&
    value.jsonrpc === "2.0" &&
    typeof value.method === "string" &&
    (typeof value.id === "string" || typeof value.id === "number") &&
    (value.params === undefined || record(value.params))
  );
}
/** @param {unknown} value @returns {value is AppResource} */
function resource(value) {
  if (!record(value) || typeof value.html !== "string" || typeof value.mimeType !== "string")
    return false;
  if (value._meta === undefined) return true;
  return (
    record(value._meta) &&
    (value._meta.ui === undefined || record(value._meta.ui)) &&
    (value._meta["openai/ui"] === undefined || record(value._meta["openai/ui"]))
  );
}
/** @param {unknown} value @returns {value is OpenResult} */
function openResult(value) {
  return (
    record(value) &&
    text(value.instanceId) &&
    text(value.serverId) &&
    (typeof value.generation === "string" || typeof value.generation === "number") &&
    resource(value.resource) &&
    (value.hostContext === undefined || record(value.hostContext))
  );
}
/** @param {unknown} value @returns {value is PageNotice} */
function pageNotice(value) {
  return (
    record(value) &&
    typeof value.projectId === "string" &&
    typeof value.instanceId === "string" &&
    (typeof value.generation === "string" || typeof value.generation === "number") &&
    typeof value.method === "string" &&
    pageCoordinates(value.params)
  );
}
/** @param {unknown} value @returns {PageRegistration} */
function registration(value) {
  if (
    !record(value) ||
    typeof value.registrationId !== "string" ||
    typeof value.documentId !== "string" ||
    !Array.isArray(value.tools)
  )
    throw Error("Invalid page tool registration");
  return {
    ...value,
    registrationId: value.registrationId,
    documentId: value.documentId,
    tools: value.tools.map((tool) => {
      if (!record(tool) || typeof tool.kind !== "string" || typeof tool.schemaDigest !== "string")
        throw Error("Invalid page tool registration");
      return { ...tool, kind: tool.kind, schemaDigest: tool.schemaDigest };
    }),
  };
}
/** @typedef {{artifactId:string,path:string,digest:string,html?:string}} GenUiArtifact */
/** @param {unknown} value */
function genUiSource(value) {
  if (
    !record(value) ||
    typeof value.text !== "string" ||
    typeof value.readOnly !== "boolean" ||
    !Array.isArray(value.artifacts)
  )
    throw Error("Generated answer is unavailable");
  return {
    text: value.text,
    readOnly: value.readOnly,
    artifacts: value.artifacts.map(genUiArtifact),
  };
}
/** @param {unknown} value @returns {GenUiArtifact} */
function genUiArtifact(value) {
  if (
    !record(value) ||
    typeof value.artifactId !== "string" ||
    typeof value.path !== "string" ||
    typeof value.digest !== "string" ||
    (value.html !== undefined && typeof value.html !== "string")
  )
    throw Error("Generated answer is unavailable");
  return {
    artifactId: value.artifactId,
    path: value.path,
    digest: value.digest,
    ...(typeof value.html === "string" ? { html: value.html } : {}),
  };
}
module.exports = {
  record,
  text,
  openInput,
  resultInput,
  appRequest,
  openResult,
  pageNotice,
  registration,
  genUiSource,
};
