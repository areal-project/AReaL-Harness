// @ts-check
"use strict";
const { modelRecord } = require("../core-model-contract.js");
const { protocolFor } = require("./generated/management-protocol.cjs");
/** @typedef {'pluginArchiveImport'|'marketplaceAdd'|'marketplaceAddGit'|'marketplaceRemove'|'marketplaceUpdate'|'pluginResolve'|'pluginConnection'|'pluginHooksConfigure'|'hookAcknowledge'|'pluginAuthConfigure'|'connectorConfigure'|'pluginInstall'|'pluginConfigure'|'pluginComponentConfigure'|'pluginUninstall'|'pluginSetup'|'pluginUserConfigSave'|'pluginDevelopmentLink'|'pluginDevelopmentUnlink'} PluginMutation */
/** @typedef {import('./generated/management-protocol.cjs').RequestMap} ProtocolRequestMap */
/** @typedef {import('./generated/management-protocol.cjs').ResponseMap} ProtocolResponseMap */
/** @typedef {{projectId:string,operation:'workgroupArtifactStatus'|'workgroupApplyArtifact',id:string,path:string,head:string}} ArtifactRequest */
/** @typedef {{kind:'string',value:string}|{kind:'boolean',value:boolean}|{kind:'number',value:number}} PublicPluginConfigValue */
/** @typedef {{
 * pluginCredentialsReload:{operation:'pluginCredentialsReload',projectId:string},
 * pluginUserConfigSave:{operation:'pluginUserConfigSave',projectId:string,requestId?:string,id:string,expectedRevision:number,expectedDigest:string,values:Record<string,PublicPluginConfigValue>,secrets:Record<string,string>,clearKeys?:string[]},
 * workgroupArtifactStatus:ArtifactRequest&{operation:'workgroupArtifactStatus'},workgroupApplyArtifact:ArtifactRequest&{operation:'workgroupApplyArtifact'},
 * workgroupCapabilities:{projectId:string,operation:'workgroupCapabilities'},pluginCapabilities:{projectId:string,operation:'pluginCapabilities'},
 * workgroupSubmission:{projectId:string,operation:'workgroupSubmission',requestId:string},
 * pluginReadiness:{projectId:string,operation:'pluginReadiness',id:string,expectedDigest:string},
 * pluginSubmission:{projectId:string,operation:'pluginSubmission',requestId:string,mutation:PluginMutation,threadId?:string},
 * processSubmission:{projectId:string,operation:'processSubmission',threadId:string,requestId:string,guiOwned?:boolean},
 * agentSubmission:{projectId:string,operation:'agentSubmission',parentThreadId:string,requestId:string},
 * mcpFormResourceSubmission:{projectId:string,operation:'mcpFormResourceSubmission',requestId:string},
 * pluginStoreSnapshot:{operation:'pluginStoreSnapshot',projectId?:string,id?:string},pluginStoreDoctor:{operation:'pluginStoreDoctor',projectId?:string},
 * pluginArchivePick:{projectId:string,operation:'pluginArchivePick'}
 * }} LocalRequestMap */
/** @typedef {{kind:'user'}|{kind:'project',workspace:string}} PluginReadScope */
/** @typedef {{revision:number,scope:PluginReadScope,observedAt:number,runtimeObserved:false,list:ProtocolResponseMap['plugins'],detail:ProtocolResponseMap['plugin']|null}} PluginStoreSnapshot */
/** @typedef {{revision:number,scope:PluginReadScope,observedAt:number,runtimeObserved:false,data:{id:string,installed:boolean,enabled:boolean,installedDigest:string|null,candidateDigest:string,compatibility:unknown,nextAction:string,state:string,availableComponents:string[],candidateAvailable:boolean,developmentStatus:string|null}[],errors:string[]}} PluginDoctorReport */
/** @template T @typedef {{confirmed:false,state?:string}|{confirmed:true,accepted:true,status:'completed'|'failed',operation?:import('../../../runtime-client/core.js').OperationRef,warning?:string}&({result:T,error?:never,message?:never}|{error:import('../desktop-contract.cjs').DesktopError,message:string,result?:never})} SubmissionRead */
/** @typedef {{shell:string,fontFamily:string,fontFamilySource:'custom'|'system'|'fallback',fontSize?:number,theme?:Record<string,string>}} TerminalPresentation */
/** @typedef {{path:string,head:string,state:'matches'|'ready'|'conflict'}} ArtifactState */
/** @typedef {{pluginId:string,installedDigest:string|null|undefined,requiredTools:string[],missingTools:string[],available:boolean}} PluginReadiness */
/** @typedef {{
 * workgroupArtifactStatus:ArtifactState,workgroupApplyArtifact:ArtifactState,workgroupCapabilities:{enabled:boolean},pluginCapabilities:{enabled:boolean},
 * workgroupSubmission:{confirmed:false}|({confirmed:true,accepted:true,method:string,workgroupId:string,planRevision:number}&import('./shared.cjs').SubmissionOutcome),
 * pluginReadiness:PluginReadiness,pluginSubmission:SubmissionRead<ProtocolResponseMap[PluginMutation]>,
 * processSubmission:{confirmed:false}|{confirmed:true,result:ProtocolResponseMap['processStart']&TerminalPresentation&{argv:string[],closed:boolean,controls:number}},
 * agentSubmission:{confirmed:false}|({confirmed:true,accepted:true,method:'areal/agent/spawn',parentThreadId:string,threadId:string,turnId:string}&import('./shared.cjs').SubmissionOutcome),
 * mcpFormResourceSubmission:SubmissionRead<ProtocolResponseMap['mcpFormResourceStage']>,
 * pluginCredentialsReload:{reloaded:true},
 * pluginUserConfigSave:ProtocolResponseMap['pluginUserConfigSave'],
 * pluginStoreSnapshot:PluginStoreSnapshot,pluginStoreDoctor:PluginDoctorReport,
 * pluginArchivePick:{canceled:true}|{selectionToken:string,fileName:string}
 * }} LocalResponseMap */
/** @typedef {Omit<ProtocolRequestMap,'pluginUserConfigSave'>&LocalRequestMap&import('./management-tasks.cjs').LocalTaskRequestMap} ManagementRequestMap */
/** @typedef {ProtocolResponseMap&LocalResponseMap&import('./management-tasks.cjs').LocalTaskResponseMap} ManagementResponseMap */
/** @typedef {ManagementRequestMap[keyof ManagementRequestMap]} ManagementRequest */
/** @template {ManagementRequest} P @typedef {P extends {operation:'processStart',terminal:true} ? ProtocolResponseMap['processStart']&TerminalPresentation : P extends {operation:'pluginSubmission',mutation:infer M extends PluginMutation} ? SubmissionRead<ProtocolResponseMap[M]> : ManagementResponseMap[P['operation']]} ManagementResponse */
/** @param {unknown} value @returns {value is string[]} */
const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
/** @type {Readonly<Record<PluginMutation,true>>} */
const pluginMutations = Object.freeze({
  pluginArchiveImport: true,
  marketplaceAdd: true,
  marketplaceAddGit: true,
  marketplaceRemove: true,
  marketplaceUpdate: true,
  pluginResolve: true,
  pluginConnection: true,
  pluginHooksConfigure: true,
  hookAcknowledge: true,
  pluginAuthConfigure: true,
  connectorConfigure: true,
  pluginInstall: true,
  pluginConfigure: true,
  pluginComponentConfigure: true,
  pluginUninstall: true,
  pluginSetup: true,
  pluginUserConfigSave: true,
  pluginDevelopmentLink: true,
  pluginDevelopmentUnlink: true,
});
/** @param {unknown} value @returns {value is PluginMutation} */
function pluginMutation(value) {
  return typeof value === "string" && Object.hasOwn(pluginMutations, value);
}
/** @param {unknown} value @returns {value is ManagementRequest} */
function isManagementRequest(value) {
  if (!modelRecord(value) || typeof value.operation !== "string") return false;
  if (["pluginStoreSnapshot", "pluginStoreDoctor"].includes(value.operation))
    return (
      (value.projectId === undefined ||
        (typeof value.projectId === "string" &&
          value.projectId.trim().length > 0 &&
          value.projectId.length <= 256)) &&
      (value.id === undefined || (typeof value.id === "string" && value.id.length > 0)) &&
      Object.keys(value).every((key) =>
        [
          "operation",
          "projectId",
          ...(value.operation === "pluginStoreSnapshot" ? ["id"] : []),
        ].includes(key),
      )
    );
  if (typeof value.projectId !== "string") return false;
  if (value.operation === "pluginCredentialsReload")
    return Object.keys(value).every((key) => ["operation", "projectId"].includes(key));
  if (value.operation === "pluginUserConfigSave")
    return (
      typeof value.id === "string" &&
      value.id.length > 0 &&
      typeof value.expectedDigest === "string" &&
      value.expectedDigest.length > 0 &&
      Number.isSafeInteger(value.expectedRevision) &&
      Number(value.expectedRevision) >= 0 &&
      (value.requestId === undefined || typeof value.requestId === "string") &&
      modelRecord(value.values) &&
      Object.values(value.values).every(
        (entry) =>
          modelRecord(entry) &&
          ((entry.kind === "string" && typeof entry.value === "string") ||
            (entry.kind === "boolean" && typeof entry.value === "boolean") ||
            (entry.kind === "number" &&
              typeof entry.value === "number" &&
              Number.isFinite(entry.value))),
      ) &&
      modelRecord(value.secrets) &&
      Object.values(value.secrets).every((entry) => typeof entry === "string") &&
      (value.clearKeys === undefined || strings(value.clearKeys)) &&
      Object.keys(value).every((key) =>
        [
          "operation",
          "projectId",
          "requestId",
          "id",
          "expectedRevision",
          "expectedDigest",
          "values",
          "secrets",
          "clearKeys",
        ].includes(key),
      )
    );
  const protocol = protocolFor(value.operation);
  if (protocol)
    return (
      Object.entries(protocol.requests).find(([operation]) => operation === value.operation)?.[1](
        value,
      ) === true
    );
  if (value.operation.startsWith("task"))
    return require("./management-tasks.cjs").localTaskRequest(value);
  switch (value.operation) {
    case "workgroupArtifactStatus":
    case "workgroupApplyArtifact":
      return ["id", "path", "head"].every((key) => typeof value[key] === "string");
    case "workgroupCapabilities":
    case "pluginCapabilities":
    case "pluginArchivePick":
      return true;
    case "workgroupSubmission":
    case "mcpFormResourceSubmission":
      return typeof value.requestId === "string";
    case "pluginReadiness":
      return (
        typeof value.id === "string" &&
        value.id.trim().length > 0 &&
        typeof value.expectedDigest === "string" &&
        value.expectedDigest.trim().length > 0
      );
    case "pluginSubmission":
      return (
        typeof value.requestId === "string" &&
        pluginMutation(value.mutation) &&
        (value.threadId === undefined || typeof value.threadId === "string")
      );
    case "processSubmission":
      return (
        typeof value.requestId === "string" &&
        typeof value.threadId === "string" &&
        (value.guiOwned === undefined || typeof value.guiOwned === "boolean")
      );
    case "agentSubmission":
      return typeof value.requestId === "string" && typeof value.parentThreadId === "string";
    default:
      return false;
  }
}
/** @param {unknown} value @returns {ManagementRequest} */
function readManagementRequest(value) {
  if (!isManagementRequest(value))
    throw new Error(
      modelRecord(value) && value.operation === "pluginReadiness"
        ? "Missing installed plugin snapshot"
        : "管理请求结构无效",
    );
  return value;
}
/** @param {string} operation @param {unknown} value */
function protocolResponse(operation, value) {
  const protocol = protocolFor(operation);
  return (
    !!protocol &&
    Object.entries(protocol.responses).find(([name]) => name === operation)?.[1](value) === true
  );
}
/** @param {unknown} value @param {string} operation */
function submissionRead(value, operation) {
  if (
    !modelRecord(value) ||
    typeof value.confirmed !== "boolean" ||
    (value.warning !== undefined && typeof value.warning !== "string")
  )
    return false;
  if (!value.confirmed) return value.state === undefined || typeof value.state === "string";
  if (
    value.accepted !== true ||
    !(typeof value.status === "string" && ["completed", "failed"].includes(value.status)) ||
    (value.operation !== undefined && !require("./shared.cjs").isOperationRef(value.operation))
  )
    return false;
  if (value.error !== undefined)
    return (
      modelRecord(value.error) &&
      typeof value.error.message === "string" &&
      typeof value.message === "string" &&
      (value.error.code === undefined ||
        typeof value.error.code === "string" ||
        typeof value.error.code === "number")
    );
  return protocolResponse(operation, value.result);
}
/** @param {ManagementRequest} request @param {unknown} value */
function validateManagementResponse(request, value) {
  const operation = request.operation;
  if (protocolFor(operation)) {
    if (
      !protocolResponse(operation, value) ||
      (request.operation === "processStart" &&
        request.terminal === true &&
        !terminalPresentation(value))
    )
      throw new Error("Core 管理响应结构无效");
    return;
  }
  if (operation.startsWith("task")) {
    if (!require("./management-tasks.cjs").localTaskResponse(operation, value))
      throw new Error("任务管理响应结构无效");
    return;
  }
  if (!modelRecord(value)) throw new Error("管理响应结构无效");
  const valid = (() => {
    switch (operation) {
      case "workgroupArtifactStatus":
      case "workgroupApplyArtifact":
        return (
          typeof value.path === "string" &&
          typeof value.head === "string" &&
          typeof value.state === "string" &&
          ["matches", "ready", "conflict"].includes(value.state)
        );
      case "workgroupCapabilities":
      case "pluginCapabilities":
        return typeof value.enabled === "boolean";
      case "pluginArchivePick":
        return (
          value.canceled === true ||
          (typeof value.selectionToken === "string" && typeof value.fileName === "string")
        );
      case "pluginCredentialsReload":
        return value.reloaded === true;
      case "pluginUserConfigSave":
        return protocolResponse("pluginUserConfigSave", value);
      case "pluginStoreSnapshot":
        return (
          pluginStoreMetadata(value) &&
          protocolResponse("plugins", value.list) &&
          modelRecord(value.list) &&
          value.list.revision === value.revision &&
          (value.detail === null ||
            (protocolResponse("plugin", value.detail) &&
              modelRecord(value.detail) &&
              value.detail.revision === value.revision &&
              (request.operation !== "pluginStoreSnapshot" ||
                !request.id ||
                value.detail.id === request.id)))
        );
      case "pluginStoreDoctor":
        return (
          pluginStoreMetadata(value) &&
          strings(value.errors) &&
          Array.isArray(value.data) &&
          value.data.every(
            (row) =>
              modelRecord(row) &&
              typeof row.id === "string" &&
              typeof row.installed === "boolean" &&
              typeof row.enabled === "boolean" &&
              (row.installedDigest === null || typeof row.installedDigest === "string") &&
              typeof row.candidateDigest === "string" &&
              typeof row.nextAction === "string" &&
              typeof row.state === "string" &&
              strings(row.availableComponents) &&
              typeof row.candidateAvailable === "boolean" &&
              (row.developmentStatus === null || typeof row.developmentStatus === "string"),
          )
        );
      case "pluginReadiness":
        return (
          typeof value.pluginId === "string" &&
          (value.installedDigest == null || typeof value.installedDigest === "string") &&
          strings(value.requiredTools) &&
          strings(value.missingTools) &&
          typeof value.available === "boolean"
        );
      case "pluginSubmission":
        return "mutation" in request && submissionRead(value, request.mutation);
      case "mcpFormResourceSubmission":
        return submissionRead(value, "mcpFormResourceStage");
      case "processSubmission":
        return (
          value.confirmed === false ||
          (value.confirmed === true &&
            protocolResponse("processStart", value.result) &&
            terminalPresentation(value.result) &&
            modelRecord(value.result) &&
            strings(value.result.argv) &&
            typeof value.result.closed === "boolean" &&
            typeof value.result.controls === "number" &&
            Number.isSafeInteger(value.result.controls))
        );
      case "agentSubmission":
        return (
          value.confirmed === false ||
          (value.confirmed === true &&
            value.accepted === true &&
            value.method === "areal/agent/spawn" &&
            ["parentThreadId", "threadId", "turnId"].every(
              (key) => typeof value[key] === "string",
            ) &&
            require("./shared.cjs").isSubmissionOutcomes({ receipt: value }))
        );
      case "workgroupSubmission":
        return (
          value.confirmed === false ||
          (value.confirmed === true &&
            value.accepted === true &&
            typeof value.method === "string" &&
            typeof value.workgroupId === "string" &&
            typeof value.planRevision === "number" &&
            Number.isSafeInteger(value.planRevision) &&
            require("./shared.cjs").isSubmissionOutcomes({ receipt: value }))
        );
      default:
        return false;
    }
  })();
  if (!valid) throw new Error("管理响应结构无效");
}
/** @param {unknown} value @returns {import('./generated/management-plugins-protocol.cjs').ResponseMap['plugin']} */
function readPluginReadiness(value) {
  if (!require("./generated/management-plugins-protocol.cjs").responses.plugin(value))
    throw new Error("插件就绪记录结构无效");
  return value;
}
module.exports = {
  pluginMutations,
  pluginMutation,
  isManagementRequest,
  readManagementRequest,
  validateManagementResponse,
  readPluginReadiness,
  protocolResponse,
};

/** @param {unknown} value @returns {value is TerminalPresentation & Record<string,unknown>} */
function terminalPresentation(value) {
  return (
    modelRecord(value) &&
    typeof value.shell === "string" &&
    typeof value.fontFamily === "string" &&
    typeof value.fontFamilySource === "string" &&
    ["custom", "system", "fallback"].includes(value.fontFamilySource) &&
    (value.fontSize === undefined ||
      (typeof value.fontSize === "number" && Number.isFinite(value.fontSize))) &&
    (value.theme === undefined ||
      (modelRecord(value.theme) &&
        Object.values(value.theme).every((item) => typeof item === "string")))
  );
}

/** @param {Record<string,unknown>} value */
function pluginStoreMetadata(value) {
  return (
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) >= 0 &&
    Number.isSafeInteger(value.observedAt) &&
    Number(value.observedAt) >= 0 &&
    value.runtimeObserved === false &&
    modelRecord(value.scope) &&
    (value.scope.kind === "user" ||
      (value.scope.kind === "project" && typeof value.scope.workspace === "string"))
  );
}
