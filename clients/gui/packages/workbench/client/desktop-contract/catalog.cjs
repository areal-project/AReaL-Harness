// @ts-check
"use strict";
const {
  record,
  integer,
  strings,
  parameters,
  capabilities,
  isAcceptedModel,
} = require("./provider.cjs");
const tasks = require("./management-tasks.cjs");
/** @typedef {import('./provider.cjs').ModelParameters} ModelParameters */
/** @typedef {import('./provider.cjs').ModelCapabilities} ModelCapabilities */
/** @typedef {import('./provider.cjs').AcceptedModel} AcceptedModel */
/** @typedef {{providerId:string|null,providerName?:string,modelId:string,displayName:string,available:boolean,credentialState?:string,isDefault:boolean,parameters:ModelParameters,capabilities?:ModelCapabilities,reasoningEffortOptions:string[]}} ProjectlessModel */
/** @typedef {{models:ProjectlessModel[],lastAcceptedModel:AcceptedModel|null}} ProjectlessCatalog */
/** @typedef {{operation:'catalog'}|{operation:'directory',path:string}|{operation:'prepare',requestId:string,directory?:string}} ProjectlessRequest */
/** @typedef {{limit?:number,requestId?:string,viewEpoch?:number} & ({operation:'inbox',projectId?:string,sourceThreadId?:never}|({operation:'list'|'preview'|'observe'} & ({projectId?:string,sourceThreadId?:never}|{projectId:string,sourceThreadId:string})))} TasksRequest */
/** @typedef {{kind:'empty'|'snapshot'|'complete'|'partial'}|{kind:'requiresCore',reason:'unbound'|'legacyFormat'|'readBudgetExceeded'}} Coverage */
/** @typedef {{projectId:string,executionProjectId?:string} & ({status:'ready',connectionGeneration:number,source?:'live',coverage?:Coverage,readAt?:number}|{status:'unobserved',source:'published',coverage:Coverage,readAt:number,connectionGeneration?:never}|{status:'error',source?:'live'|'published',coverage?:Coverage,readAt?:number,connectionGeneration?:number})} CatalogOwner */
/** @typedef {{projectId:string,executionProjectId?:string} & ({status:'ready',connectionGeneration:number,source:'live',coverage:{kind:'complete'},readAt:number}|{status:'unobserved',source:'published',coverage:Coverage,readAt:number,connectionGeneration?:never}|Extract<CatalogOwner,{status:'error'}>)} ObservedCatalogOwner */
/** @typedef {{projectId:string,executionProjectId?:string,projectName?:string,code:string,message:string,stage?:string}} CatalogError */
/** @typedef {{projectId:string,executionProjectId?:string,projectName?:string,scope:'independent'|'project'}} CatalogScope */
/** @typedef {import('./management-tasks.cjs').TaskDirectoryRow & CatalogScope} CatalogTask */
/** @typedef {import('./management-tasks.cjs').InboxEntry & CatalogScope} CatalogInbox */
/** @typedef {{data:(CatalogTask|CatalogInbox)[],errors:CatalogError[],hasMore:boolean,owners:CatalogOwner[],projectId?:string,requestId?:string,viewEpoch?:number,source?:'published',executionState?:'unobserved'}} TasksResponse */
/** @typedef {{since:number,today:string,yesterday:string,days:Record<string,{activeMs:number,tokens:number,skillCalls:number}>,activeMs:number,activeDays:number,streak:number,longestStreak:number,tokens:number,undatedTokens:number,reportedTurns:number,skillCalls:number,undatedSkills:number,skills:Array<{name:string,calls:number}>,syncing:boolean,error:string|null}} AnalyticsSummary */
/** @template {string} N @typedef {N extends 'projectless' ? ProjectlessRequest : N extends 'tasks' ? TasksRequest : N extends 'analytics' ? {operation:'read'|'sync'} : never} Request */
/** @template {string} N @template P @typedef {N extends 'projectless' ? P extends {operation:'catalog'} ? ProjectlessCatalog : P extends {operation:'directory'} ? {directory:string} : P extends {operation:'prepare'} ? {projectId:string,cwd:string} : never : N extends 'tasks' ? P extends {operation:'list'|'inbox'|'preview'|'observe'} ? Omit<TasksResponse,'data'|'owners'> & {data:(P extends {operation:'inbox'} ? CatalogInbox : CatalogTask)[],owners:(P extends {operation:'observe'} ? ObservedCatalogOwner : P extends {operation:'preview'} ? Exclude<CatalogOwner,{status:'ready'}> : CatalogOwner)[]} & (P extends {operation:'preview'} ? {source:'published',executionState:'unobserved'} : {}) : never : N extends 'analytics' ? P extends {operation:'read'|'sync'} ? AnalyticsSummary : never : never} Response */
/** @param {unknown} value @returns {value is string} */
function text(value) {
  return typeof value === "string";
}
/** @param {unknown} value @returns {value is string} */
function identifier(value) {
  return text(value) && value.trim().length > 0 && value.length <= 256 && !value.includes("\0");
}
/** @template {string} N @param {N} name @param {unknown} value @returns {value is Request<N>} */
function isRequest(name, value) {
  if (!record(value)) return false;
  if (name === "analytics") return value.operation === "read" || value.operation === "sync";
  if (name === "projectless") {
    if (value.operation === "catalog") return true;
    if (value.operation === "directory") return text(value.path);
    return (
      value.operation === "prepare" &&
      text(value.requestId) &&
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value.requestId) &&
      (value.directory === undefined || text(value.directory))
    );
  }
  return (
    name === "tasks" &&
    ["list", "inbox", "preview", "observe"].some((entry) => entry === value.operation) &&
    Object.keys(value).every((key) =>
      ["operation", "projectId", "sourceThreadId", "limit", "requestId", "viewEpoch"].includes(key),
    ) &&
    (value.projectId === undefined || identifier(value.projectId)) &&
    (value.sourceThreadId === undefined ||
      (value.operation !== "inbox" &&
        identifier(value.sourceThreadId) &&
        identifier(value.projectId))) &&
    (value.limit === undefined ||
      (integer(value.limit) && value.limit >= 1 && value.limit <= 1024)) &&
    (value.requestId === undefined ||
      (text(value.requestId) &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.requestId))) &&
    (value.viewEpoch === undefined || integer(value.viewEpoch))
  );
}
/** @param {unknown} value @returns {value is ProjectlessModel} */
function projectlessModel(value) {
  return (
    record(value) &&
    (value.providerId === null || text(value.providerId)) &&
    identifier(value.modelId) &&
    text(value.displayName) &&
    (value.providerName === undefined || typeof value.providerName === "string") &&
    typeof value.available === "boolean" &&
    typeof value.isDefault === "boolean" &&
    (value.credentialState === undefined || text(value.credentialState)) &&
    parameters(value.parameters) &&
    (value.capabilities === undefined || capabilities(value.capabilities)) &&
    strings(value.reasoningEffortOptions)
  );
}
/** @param {unknown} value @returns {value is Coverage} */
function coverage(value) {
  return (
    record(value) &&
    (["empty", "snapshot", "complete", "partial"].some((entry) => entry === value.kind) ||
      (value.kind === "requiresCore" &&
        ["unbound", "legacyFormat", "readBudgetExceeded"].some((entry) => entry === value.reason)))
  );
}
/** @param {unknown} value @returns {value is CatalogOwner} */
function owner(value) {
  return (
    record(value) &&
    identifier(value.projectId) &&
    (value.executionProjectId === undefined || identifier(value.executionProjectId)) &&
    ["ready", "unobserved", "error"].some((entry) => entry === value.status) &&
    (value.source === undefined || value.source === "live" || value.source === "published") &&
    (value.coverage === undefined || coverage(value.coverage)) &&
    (value.readAt === undefined || integer(value.readAt)) &&
    (value.connectionGeneration === undefined || integer(value.connectionGeneration)) &&
    (value.status !== "ready" ||
      (integer(value.connectionGeneration) &&
        (value.source === undefined || value.source === "live"))) &&
    (value.status !== "unobserved" ||
      (value.source === "published" &&
        integer(value.readAt) &&
        coverage(value.coverage) &&
        value.connectionGeneration === undefined))
  );
}
/** @param {unknown} value @returns {value is CatalogError} */
function catalogError(value) {
  return (
    record(value) &&
    identifier(value.projectId) &&
    (value.executionProjectId === undefined || identifier(value.executionProjectId)) &&
    (value.projectName === undefined || text(value.projectName)) &&
    text(value.code) &&
    text(value.message) &&
    (value.stage === undefined || text(value.stage))
  );
}
/** @param {unknown} value @returns {value is CatalogScope} */
function rowScope(value) {
  return (
    record(value) &&
    identifier(value.projectId) &&
    (value.executionProjectId === undefined || identifier(value.executionProjectId)) &&
    (value.projectName === undefined || text(value.projectName)) &&
    (value.scope === "project" || value.scope === "independent")
  );
}
/** @param {unknown} value @returns {value is CatalogTask} */
function catalogTask(value) {
  if (!rowScope(value)) return false;
  const row = Object.fromEntries(
    Object.entries(value).filter(
      ([key]) => !["projectId", "executionProjectId", "projectName", "scope"].includes(key),
    ),
  );
  return tasks.taskDirectoryRow(row);
}
/** @param {Record<string,unknown>} request @param {unknown} value @returns {value is TasksResponse} */
function taskCatalog(request, value) {
  if (
    !record(value) ||
    (value.source !== undefined && value.source !== "published") ||
    (value.executionState !== undefined && value.executionState !== "unobserved") ||
    !Array.isArray(value.data) ||
    !value.data.every(rowScope) ||
    !Array.isArray(value.errors) ||
    !value.errors.every(catalogError) ||
    typeof value.hasMore !== "boolean" ||
    !Array.isArray(value.owners) ||
    !value.owners.every(owner) ||
    (value.projectId !== undefined && !identifier(value.projectId)) ||
    (value.requestId !== undefined && !text(value.requestId)) ||
    (value.viewEpoch !== undefined && !integer(value.viewEpoch))
  )
    return false;
  if (!value.data.every(request.operation === "inbox" ? tasks.inboxEntry : catalogTask))
    return false;
  const preview = request.operation === "preview";
  if (request.projectId !== undefined) {
    const selected = value.owners[0];
    if (
      value.projectId !== request.projectId ||
      value.requestId !== request.requestId ||
      value.viewEpoch !== request.viewEpoch ||
      value.owners.length !== 1 ||
      selected.projectId !== request.projectId ||
      value.data.some((row) => row.projectId !== request.projectId) ||
      value.errors.some((error) => error.projectId !== request.projectId) ||
      !["ready", "unobserved", "error"].includes(selected.status) ||
      (selected.status === "ready" && !integer(selected.connectionGeneration))
    )
      return false;
  }
  if (
    preview &&
    (value.source !== "published" ||
      value.executionState !== "unobserved" ||
      value.owners.some(
        (item) => !["unobserved", "error"].includes(item.status) || "connectionGeneration" in item,
      ))
  )
    return false;
  if (
    request.operation === "observe" &&
    value.owners.some(
      (item) =>
        item.status !== "error" &&
        (!integer(item.readAt) ||
          !item.coverage ||
          (item.status === "ready"
            ? item.source !== "live" || item.coverage.kind !== "complete"
            : item.source !== "published" ||
              !["empty", "snapshot", "requiresCore"].includes(item.coverage.kind))),
    )
  )
    return false;
  return true;
}
/** @param {unknown} value @returns {value is AnalyticsSummary} */
function analytics(value) {
  return (
    record(value) &&
    [
      "since",
      "activeMs",
      "activeDays",
      "streak",
      "longestStreak",
      "tokens",
      "undatedTokens",
      "reportedTurns",
      "skillCalls",
      "undatedSkills",
    ].every(
      (key) => typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0,
    ) &&
    text(value.today) &&
    text(value.yesterday) &&
    record(value.days) &&
    Object.values(value.days).every(
      (day) =>
        record(day) &&
        ["activeMs", "tokens", "skillCalls"].every(
          (key) => typeof day[key] === "number" && Number.isFinite(day[key]) && day[key] >= 0,
        ),
    ) &&
    Array.isArray(value.skills) &&
    value.skills.every((skill) => record(skill) && text(skill.name) && integer(skill.calls)) &&
    typeof value.syncing === "boolean" &&
    (value.error === null || text(value.error))
  );
}
/** @template {string} N @template P @param {N} name @param {P} request @param {unknown} value @returns {value is Response<N,P>} */
function isResponse(name, request, value) {
  if (!record(request) || !record(value)) return false;
  if (name === "analytics")
    return ["read", "sync"].some((entry) => entry === request.operation) && analytics(value);
  if (name === "tasks")
    return (
      ["list", "inbox", "preview", "observe"].some((entry) => entry === request.operation) &&
      taskCatalog(request, value)
    );
  if (name !== "projectless") return false;
  if (request.operation === "catalog")
    return (
      Array.isArray(value.models) &&
      value.models.every(projectlessModel) &&
      (value.lastAcceptedModel === null || isAcceptedModel(value.lastAcceptedModel))
    );
  if (request.operation === "directory") return text(value.directory);
  return request.operation === "prepare" && identifier(value.projectId) && text(value.cwd);
}
module.exports = { isRequest, isResponse, projectlessModel, taskCatalog, analytics };
