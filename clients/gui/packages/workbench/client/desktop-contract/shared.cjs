// @ts-check
"use strict";
const {
  modelRecord,
  isCoreQueue,
  isCoreThread,
  isCoreTurn,
  isCoreInteractions,
} = require("../core-model-contract.js");
/** The consumed part of protocol::desktop::EffectiveConfig; extensions stay unknown. */
/** @typedef {Record<string,unknown> & {revision?:number,model?:({providerId:string,modelId:string,[key:string]:unknown})|null,options?:ClientOptions & {automaticSessionName?:boolean|null},defaultModelRevision?:string|null,modelName?:string|null,provider?:(Record<string,unknown>&{endpoint?:string})|null,parameters?:import('./provider.cjs').ModelParameters}} Configuration */
/** @typedef {Record<string,unknown> & {configuration:Configuration & {revision:number},activeTurnId?:string|null,modelName?:string|null,resolvedParameters?:import('./provider.cjs').ModelParameters|null}} Inspection */
/** @param {unknown} value @returns {value is Configuration} */
function isConfiguration(value) {
  return (
    modelRecord(value) &&
    (value.revision === undefined ||
      (typeof value.revision === "number" && Number.isSafeInteger(value.revision))) &&
    (value.model == null ||
      (modelRecord(value.model) &&
        typeof value.model.providerId === "string" &&
        typeof value.model.modelId === "string")) &&
    (value.options === undefined || configurationOptions(value.options)) &&
    (value.modelName == null || typeof value.modelName === "string") &&
    (value.defaultModelRevision == null || typeof value.defaultModelRevision === "string") &&
    (value.provider == null ||
      (modelRecord(value.provider) &&
        (value.provider.endpoint === undefined || typeof value.provider.endpoint === "string"))) &&
    (value.parameters === undefined || require("./provider.cjs").parameters(value.parameters))
  );
}
/** @param {unknown} value @returns {value is ClientOptions & {automaticSessionName?:boolean|null}} */
function configurationOptions(value) {
  if (!modelRecord(value)) return false;
  const { automaticSessionName, ...options } = value;
  return (
    (automaticSessionName == null || typeof automaticSessionName === "boolean") &&
    clientOptions(options)
  );
}
/** @param {unknown} value @returns {Inspection} */
function readInspection(value) {
  if (!isInspection(value))
    throw Object.assign(new Error("Core 未返回有效的会话配置，请重新打开任务"), {
      code: "THREAD_CONFIGURATION_INVALID",
    });
  return value;
}
/** @param {unknown} value @returns {value is Inspection} */
function isInspection(value) {
  return (
    modelRecord(value) &&
    isConfiguration(value.configuration) &&
    typeof value.configuration.revision === "number" &&
    (value.activeTurnId == null || typeof value.activeTurnId === "string") &&
    (value.modelName == null || typeof value.modelName === "string") &&
    (value.resolvedParameters == null ||
      require("./provider.cjs").parameters(value.resolvedParameters))
  );
}
/** @param {unknown} value @returns {Configuration & {revision:number}} */
function readConfigured(value) {
  if (!isConfiguration(value) || typeof value.revision !== "number")
    throw Object.assign(new Error("会话配置受理结果无效，请查询原请求"), {
      code: "THREAD_CONFIGURATION_INVALID",
      submissionUnknown: true,
      outcome: { kind: "unconfirmed" },
      recovery: { kind: "queryOriginal" },
    });
  return { ...value, revision: value.revision };
}

/** Consumed identities from Core thread/turn admission receipts; payload extensions stay opaque. */
/** @typedef {Record<string,unknown> & {thread?:import("../core-model-contract.js").CoreThread,turn?:import("../core-model-contract.js").CoreTurn|null,threadId?:string,turnId?:string,requestId?:string,queueItemId?:string|null,queueRevision?:number,configRevision?:number,accepted?:boolean,cleanupConfirmed?:boolean}} Admission */
/** @param {unknown} value @returns {Admission} */
function readAdmission(value) {
  if (!admission(value))
    throw Object.assign(new Error("Core 受理结果不完整，请查询原请求"), {
      code: "ADMISSION_RESULT_INVALID",
      submissionUnknown: true,
      outcome: { kind: "unconfirmed" },
      recovery: { kind: "queryOriginal" },
    });
  return value;
}
/** @param {unknown} value @returns {Admission & {thread:Record<string,unknown>&{id:string}}} */
function readThreadAdmission(value) {
  const result = readAdmission(value);
  if (!result.thread)
    throw Object.assign(new Error("Core 未返回已创建的会话，请查询原请求"), {
      code: "ADMISSION_RESULT_INVALID",
      submissionUnknown: true,
      outcome: { kind: "unconfirmed" },
      recovery: { kind: "queryOriginal" },
    });
  return { ...result, thread: result.thread };
}
/** @param {unknown} value @returns {value is Admission} */
function admission(value) {
  return (
    modelRecord(value) &&
    ["threadId", "turnId", "requestId"].every(
      (key) => value[key] === undefined || typeof value[key] === "string",
    ) &&
    (value.queueItemId == null || typeof value.queueItemId === "string") &&
    (value.thread === undefined || isCoreThread(value.thread)) &&
    (value.turn == null || isCoreTurn(value.turn)) &&
    ["queueRevision", "configRevision"].every(
      (key) => value[key] === undefined || count(value[key]),
    ) &&
    ["accepted", "cleanupConfirmed"].every(
      (key) => value[key] === undefined || typeof value[key] === "boolean",
    )
  );
}

/** @param {unknown} value @returns {Queue} */
function readQueueAdmission(value) {
  if (!isQueue(value))
    throw Object.assign(new Error("队列受理结果不完整，请查询原请求"), {
      code: "ADMISSION_RESULT_INVALID",
      submissionUnknown: true,
      outcome: { kind: "unconfirmed" },
      recovery: { kind: "queryOriginal" },
    });
  return value;
}

/** @typedef {Record<string,unknown> & {method?:string,status?:string,operationId?:string,operation?:import('../../../runtime-client/core.js').OperationRef,remote?:RemoteAssociation,accepted?:boolean,threadId?:string,turnId?:string,taskId?:string,parentThreadId?:string,sourceThreadId?:string,workgroupId?:string,draftThreadId?:string,taskDraftMessage?:string,taskDraftError?:string,message?:string,cleanupConfirmed?:boolean,admissionState?:string}} SubmissionOutcome */

/** @param {unknown} value @returns {value is Record<string,SubmissionOutcome>} */
function isSubmissionOutcomes(value) {
  return modelRecord(value) && Object.values(value).every(isSubmissionOutcome);
}

/** @param {unknown} value @returns {value is SubmissionOutcome} */
function isSubmissionOutcome(value) {
  return (
    modelRecord(value) &&
    [
      "method",
      "status",
      "operationId",
      "threadId",
      "turnId",
      "taskId",
      "parentThreadId",
      "sourceThreadId",
      "workgroupId",
      "draftThreadId",
      "taskDraftMessage",
      "taskDraftError",
      "message",
      "admissionState",
    ].every((key) => value[key] === undefined || typeof value[key] === "string") &&
    (value.accepted === undefined || typeof value.accepted === "boolean") &&
    (value.cleanupConfirmed === undefined || typeof value.cleanupConfirmed === "boolean") &&
    (value.operation === undefined || isOperationRef(value.operation)) &&
    (value.remote === undefined ||
      (isRemoteAssociation(value.remote) &&
        typeof value.operationId === "string" &&
        typeof value.method === "string"))
  );
}

/** @param {unknown} value @returns {value is import('../../../runtime-client/core.js').OperationRef} */
function isOperationRef(value) {
  if (
    !modelRecord(value) ||
    typeof value.method !== "string" ||
    (value.requestId !== undefined && typeof value.requestId !== "string") ||
    !modelRecord(value.target)
  )
    return false;
  return (
    value.target.kind === "project" ||
    (value.target.kind === "thread" && typeof value.target.threadId === "string") ||
    (value.target.kind === "task" && typeof value.target.taskId === "string")
  );
}

/** @param {unknown} value @returns {value is RemoteAssociation} */
function isRemoteAssociation(value) {
  return (
    modelRecord(value) &&
    typeof value.method === "string" &&
    typeof value.capability === "string" &&
    typeof value.semanticDigest === "string" &&
    modelRecord(value.target)
  );
}

/** @typedef {Record<string,unknown> & {method:string,capability:string,semanticDigest:string,target:Record<string,unknown>}} RemoteAssociation */

/** @typedef {Record<string,unknown> & {message?:string,data?:unknown}} ReceiptError */

/** @typedef {Record<string,unknown> & {result?:unknown,error?:ReceiptError|null}} ReceiptResponse */

/** @typedef {Record<string,unknown> & {requestId?:string,method?:string,threadId?:string|null,taskId?:string|null,status?:string|null,state?:string|null,operation?:import('../../../runtime-client/core.js').OperationRef,response?:ReceiptResponse|null,error?:ReceiptError|null}} Receipt */

/** @typedef {import('../../../runtime-client/capabilities.js').CreationAdmission & {status:'admitted'|'unconfirmed'|'notAdmitted',requestId:string,method:'areal/thread/start'}} CreationAdmissionResult */
/** @param {unknown} value @returns {{data:Receipt[],creationAdmission?:CreationAdmissionResult}} */
function readReceipts(value) {
  if (!modelRecord(value) || !Array.isArray(value.data) || !value.data.every(isReceipt))
    throw Object.assign(new Error("Core 原始回执结构无效，受理结果仍未确认"), {
      code: "RECEIPT_INVALID",
    });
  const admission = value.creationAdmission;
  if (admission !== undefined && !isCreationAdmissionResult(admission))
    throw Object.assign(new Error("Invalid creation admission result"), {
      code: "RECEIPT_INVALID",
    });
  return {
    data: value.data,
    ...(admission !== undefined ? { creationAdmission: admission } : {}),
  };
}

/** @param {unknown} value @returns {value is CreationAdmissionResult} */
function isCreationAdmissionResult(value) {
  return (
    modelRecord(value) &&
    ["admitted", "unconfirmed", "notAdmitted"].includes(String(value.status)) &&
    value.method === "areal/thread/start" &&
    typeof value.requestId === "string" &&
    require("../../../runtime-client/capabilities.js").isCreationAdmission(value)
  );
}

/** @param {unknown} value @returns {value is Receipt} */
function isReceipt(value) {
  return (
    modelRecord(value) &&
    ["requestId", "method"].every(
      (key) => value[key] === undefined || typeof value[key] === "string",
    ) &&
    ["threadId", "taskId", "status", "state"].every(
      (key) => value[key] == null || typeof value[key] === "string",
    ) &&
    (value.operation === undefined || isOperationRef(value.operation)) &&
    (value.error == null || receiptError(value.error)) &&
    (value.response == null ||
      (modelRecord(value.response) &&
        (value.response.error == null || receiptError(value.response.error))))
  );
}

/** @param {unknown} value @returns {value is ReceiptError} */
function receiptError(value) {
  return modelRecord(value) && (value.message === undefined || typeof value.message === "string");
}

/** @param {unknown} value @returns {value is number} */
function count(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
/** @param {unknown} value @returns {Record<string,SubmissionOutcome>} */
function parseSubmissionOutcomes(value) {
  if (!isSubmissionOutcomes(value)) throw new Error("Invalid submission outcome journal");
  return value;
}
/** @typedef {'stopDesktop'|'updateDesktop'|'stopProject'|'updateProject'|'interruptTurn'} LifecycleKind */
/** @typedef {'ifIdle'|'cancel'} LifecycleMode */
/** @typedef {'notAttempted'|'acceptedPending'|'blocked'|'admissionUnconfirmed'|'settlementIncomplete'|'completed'} TargetPhase */
/** @typedef {{projectId:string,serviceId:string,generation:string}} LifecycleIdentity */
/** @typedef {LifecycleIdentity & {requestId?:string,phase:TargetPhase,hostReceipt?:unknown,error?:unknown,scheduleActivationSuppressed?:boolean}} LifecycleTarget */
/** @typedef {{version:1,requestId:string,desktopGeneration:string,kind:LifecycleKind,mode:LifecycleMode,targets:LifecycleTarget[],phase:Exclude<TargetPhase,'notAttempted'>|'partial',desktopExit:'notRequested'|'requested',threadId?:string,turnId?:string,message?:string,logicalProjectId?:string,harnessHome?:string,desktopError?:unknown}} LifecycleReceipt */
/** @type {readonly LifecycleKind[]} */
const KINDS = Object.freeze([
  "stopDesktop",
  "updateDesktop",
  "stopProject",
  "updateProject",
  "interruptTurn",
]);
/** @param {unknown} value @returns {value is LifecycleReceipt} */
function isLifecycleReceipt(value) {
  return (
    modelRecord(value) &&
    value.version === 1 &&
    typeof value.requestId === "string" &&
    typeof value.desktopGeneration === "string" &&
    KINDS.some((kind) => value.kind === kind) &&
    (value.mode === "ifIdle" || value.mode === "cancel") &&
    [
      "acceptedPending",
      "blocked",
      "admissionUnconfirmed",
      "settlementIncomplete",
      "completed",
      "partial",
    ].some((phase) => value.phase === phase) &&
    (value.desktopExit === "notRequested" || value.desktopExit === "requested") &&
    ["threadId", "turnId", "message", "logicalProjectId", "harnessHome"].every(
      (key) => value[key] === undefined || typeof value[key] === "string",
    ) &&
    Array.isArray(value.targets) &&
    value.targets.every(
      (target) =>
        modelRecord(target) &&
        ["projectId", "serviceId", "generation"].every((key) => typeof target[key] === "string") &&
        (target.requestId === undefined || typeof target.requestId === "string") &&
        (target.scheduleActivationSuppressed === undefined ||
          typeof target.scheduleActivationSuppressed === "boolean") &&
        [
          "notAttempted",
          "acceptedPending",
          "blocked",
          "admissionUnconfirmed",
          "settlementIncomplete",
          "completed",
        ].some((phase) => target.phase === phase),
    ) &&
    (value.phase !== "completed" ||
      value.targets.every((target) => target.phase === "completed")) &&
    (value.kind !== "interruptTurn" ||
      (typeof value.threadId === "string" && typeof value.turnId === "string"))
  );
}
/** @param {unknown} value @returns {LifecycleReceipt} */
function readLifecycleReceipt(value) {
  if (!isLifecycleReceipt(value))
    throw Object.assign(new Error("后台回执结构无效，请核对原请求"), {
      code: "LIFECYCLE_RECEIPT_INVALID",
      submissionUnknown: true,
      outcome: { kind: "unconfirmed" },
      recovery: { kind: "queryOriginal" },
    });
  return value;
}
/** @typedef {{projectId:string,phase:string,message?:string}} LifecycleViewTarget */
/** @typedef {{requestId:string,kind:LifecycleKind|'stopHost',phase:string,targets:LifecycleViewTarget[],threadId?:string,turnId?:string,desktopExit?:'notRequested'|'requested',message?:string}} LifecycleViewOperation */
/** @typedef {{canRecover:boolean,message:string,projects:Array<{projectId:string,root:string,state:string,message:string}>}} RecoveryView */
/** @typedef {{supported:boolean,operations:LifecycleViewOperation[],phase?:string,message?:string,error?:string,requestId?:string,kind?:LifecycleKind|'stopHost',desktopExit?:'notRequested'|'requested',targets?:LifecycleViewTarget[],recovery?:RecoveryView}} LifecycleProjection */
/** @param {unknown} value @returns {value is LifecycleViewTarget} */
function lifecycleViewTarget(value) {
  return (
    modelRecord(value) &&
    typeof value.projectId === "string" &&
    typeof value.phase === "string" &&
    (value.message === undefined || typeof value.message === "string")
  );
}
/** @param {unknown} value @returns {value is LifecycleViewOperation} */
function lifecycleViewOperation(value) {
  return (
    modelRecord(value) &&
    typeof value.requestId === "string" &&
    (value.kind === "stopHost" || KINDS.some((kind) => value.kind === kind)) &&
    typeof value.phase === "string" &&
    ["threadId", "turnId", "message"].every(
      (key) => value[key] === undefined || typeof value[key] === "string",
    ) &&
    (value.desktopExit === undefined ||
      value.desktopExit === "requested" ||
      value.desktopExit === "notRequested") &&
    Array.isArray(value.targets) &&
    value.targets.every(lifecycleViewTarget)
  );
}
/** @param {unknown} value @returns {value is RecoveryView} */
function isRecoveryView(value) {
  return (
    modelRecord(value) &&
    typeof value.canRecover === "boolean" &&
    typeof value.message === "string" &&
    Array.isArray(value.projects) &&
    value.projects.every(
      (project) =>
        modelRecord(project) &&
        ["projectId", "root", "state", "message"].every((key) => typeof project[key] === "string"),
    )
  );
}
/** @param {unknown} value @returns {value is LifecycleProjection} */
function isLifecycleProjection(value) {
  return (
    modelRecord(value) &&
    typeof value.supported === "boolean" &&
    Array.isArray(value.operations) &&
    value.operations.every(lifecycleViewOperation) &&
    ["phase", "message", "error", "requestId"].every(
      (key) => value[key] === undefined || typeof value[key] === "string",
    ) &&
    (value.kind === undefined ||
      value.kind === "stopHost" ||
      KINDS.some((kind) => value.kind === kind)) &&
    (value.desktopExit === undefined ||
      value.desktopExit === "requested" ||
      value.desktopExit === "notRequested") &&
    (value.targets === undefined ||
      (Array.isArray(value.targets) && value.targets.every(lifecycleViewTarget))) &&
    (value.recovery === undefined || isRecoveryView(value.recovery))
  );
}
/** @typedef {{id:string,revision:string,displayName:string,instructions:string,skills: Array<{id:string,revision:string}>,toolAllowlist:string[]|null,model:import('./provider.cjs').ModelRef|null,requiredModalities:string[],readOnly:boolean,approvalTools:string[],allowThreadProcesses:boolean,allowConnectionProcesses?:boolean,workflow:{id:string,revision:string}|null,allowPluginSkills?:boolean}} AgentProfile */
/** @param {unknown} value @returns {value is AgentProfile} */
function agentProfile(value) {
  const provider = require("./provider.cjs");
  return (
    modelRecord(value) &&
    resourceRef(value) &&
    typeof value.displayName === "string" &&
    typeof value.instructions === "string" &&
    Array.isArray(value.skills) &&
    value.skills.every(resourceRef) &&
    (value.toolAllowlist === null || provider.strings(value.toolAllowlist)) &&
    (value.model === null || provider.modelRef(value.model)) &&
    provider.strings(value.requiredModalities) &&
    typeof value.readOnly === "boolean" &&
    provider.strings(value.approvalTools) &&
    typeof value.allowThreadProcesses === "boolean" &&
    (value.allowConnectionProcesses === undefined ||
      typeof value.allowConnectionProcesses === "boolean") &&
    (value.workflow === null || resourceRef(value.workflow)) &&
    (value.allowPluginSkills === undefined || typeof value.allowPluginSkills === "boolean")
  );
}
/** @typedef {import('../core-model-contract.js').CoreThread & {executionCore?:{instanceId:string|null,[key:string]:unknown}|null}} ServiceThread */
/** @typedef {{binary:string,apiVersion:string|null,runtimeEpoch:string|null,runtimeAvailable:boolean|null,features:Record<string,boolean>|null,instanceId:string|null,serviceGeneration?:string|null,connectionGeneration:number}} ProjectCapabilities */
/** @typedef {{state:'connecting'|'ready'|'unavailable',message?:string,recovery?:'check'|'reconnect',prerequisite?:{kind:'macos-command-line-tools',reason:'developer-tools-unavailable'|'python-unavailable',title:string,detail:string,installLabel:string,retryLabel:string,requestedMessage:string}}} DesktopConnection */
/** @typedef {{id:string,root:string,state:null|{threads:Record<string,ServiceThread>,connected?:boolean,error?:string|null,queues?:Record<string,Queue>,interactions?:Record<string,import('../core-model-contract.js').CoreInteractions>,[key:string]:unknown},logicalProjectId?:string,worktreeRequestId?:string,worktreeResources?:string,projectless?:boolean,projectlessRequestId?:string,hasTaskHistory?:boolean,backend?:'areal',core?:ProjectCapabilities,pending?:Array<PendingSubmission & {awaitingResponse:boolean}>,outcomes?:Record<string,SubmissionOutcome>,models?:import('./provider.cjs').ModelCatalogEntry[],profiles?:AgentProfile[],lastAcceptedModel?:import('./provider.cjs').AcceptedModel|null,defaultProfile?:{id:string,revision:string}|null,configurations?:Record<string,Configuration|undefined>,summaries?:import('../core-model-contract.js').CoreThread[],summariesLoaded?:boolean,observationErrors?:Record<string,{message:string,retryable:boolean,code:unknown,threadId?:string,projectId?:string,connectionGeneration?:number,[key:string]:unknown}>,refreshErrors?:Record<string,{id:string,projectId:string,message:string,refreshPending:boolean,threadId?:string,[key:string]:unknown}>,error?:string|null,desktopCapabilities?:{currentCommands:boolean},[key:string]:unknown}} ServiceProject */
/** @typedef {{projects:ServiceProject[],subscription?:import('./provider.cjs').ChatGPTStatus,library:import('./library-media.cjs').LibraryState,projectless?:{directory:string},power?:{enabled:boolean,active:boolean,error:string|null}|null,menuBar?:{supported:boolean,active:boolean,error:string|null}|null,revision?:number,desktopCapabilities?:{currentCommands:boolean},serviceSummary?:{state:'running'|'stopped'|'unknown',busy:boolean},connection?:DesktopConnection,backendUpdate?:{state:'applying'|'pending'|'failed',message?:string},lifecycle?:LifecycleProjection,computerControl?:import('./desktop-control.cjs').ComputerStatus|null,[key:string]:unknown}} DesktopSnapshot */
/** @param {unknown} value @returns {value is ServiceThread} */
function serviceThread(value) {
  return (
    isCoreThread(value) &&
    (value.executionCore == null ||
      (modelRecord(value.executionCore) &&
        (value.executionCore.instanceId === null ||
          typeof value.executionCore.instanceId === "string")))
  );
}
/** @param {unknown} value @returns {value is ProjectCapabilities} */
function projectCapabilities(value) {
  return (
    modelRecord(value) &&
    typeof value.binary === "string" &&
    ["apiVersion", "runtimeEpoch", "instanceId"].every(
      (key) => value[key] === null || typeof value[key] === "string",
    ) &&
    (value.runtimeAvailable === null || typeof value.runtimeAvailable === "boolean") &&
    count(value.connectionGeneration) &&
    (value.serviceGeneration === undefined ||
      value.serviceGeneration === null ||
      typeof value.serviceGeneration === "string") &&
    (value.features === null ||
      (modelRecord(value.features) &&
        Object.values(value.features).every((flag) => typeof flag === "boolean")))
  );
}
/** @param {unknown} value @returns {value is ServiceProject} */
function isServiceProject(value) {
  if (!modelRecord(value) || typeof value.id !== "string" || typeof value.root !== "string")
    return false;
  const state = value.state;
  if (
    state !== null &&
    (!modelRecord(state) ||
      !modelRecord(state.threads) ||
      !Object.values(state.threads).every(serviceThread) ||
      (state.connected !== undefined && typeof state.connected !== "boolean") ||
      (state.error != null && typeof state.error !== "string") ||
      (state.queues !== undefined &&
        (!modelRecord(state.queues) || !Object.values(state.queues).every(isQueue))) ||
      (state.interactions !== undefined &&
        (!modelRecord(state.interactions) ||
          !Object.values(state.interactions).every(isCoreInteractions))))
  )
    return false;
  const provider = require("./provider.cjs");
  return (
    ["logicalProjectId", "worktreeRequestId", "worktreeResources", "projectlessRequestId"].every(
      (key) => value[key] === undefined || typeof value[key] === "string",
    ) &&
    ["projectless", "hasTaskHistory", "summariesLoaded"].every(
      (key) => value[key] === undefined || typeof value[key] === "boolean",
    ) &&
    (value.backend === undefined || value.backend === "areal") &&
    (value.core === undefined || projectCapabilities(value.core)) &&
    (value.pending === undefined ||
      (Array.isArray(value.pending) &&
        value.pending.every(
          (entry) => isPendingSubmission(entry) && typeof entry.awaitingResponse === "boolean",
        ))) &&
    (value.outcomes === undefined || isSubmissionOutcomes(value.outcomes)) &&
    (value.models === undefined ||
      (Array.isArray(value.models) && value.models.every(provider.modelEntry))) &&
    (value.profiles === undefined ||
      (Array.isArray(value.profiles) && value.profiles.every(agentProfile))) &&
    (value.lastAcceptedModel == null || provider.isAcceptedModel(value.lastAcceptedModel)) &&
    (value.defaultProfile == null || resourceRef(value.defaultProfile)) &&
    (value.configurations === undefined ||
      (modelRecord(value.configurations) &&
        Object.values(value.configurations).every(
          (config) => config === undefined || isConfiguration(config),
        ))) &&
    (value.summaries === undefined ||
      (Array.isArray(value.summaries) && value.summaries.every(isCoreThread))) &&
    (value.observationErrors === undefined ||
      (modelRecord(value.observationErrors) &&
        Object.values(value.observationErrors).every(
          (error) =>
            modelRecord(error) &&
            typeof error.message === "string" &&
            typeof error.retryable === "boolean" &&
            ["threadId", "projectId"].every(
              (key) => error[key] === undefined || typeof error[key] === "string",
            ) &&
            (error.connectionGeneration === undefined || count(error.connectionGeneration)) &&
            "code" in error,
        ))) &&
    (value.refreshErrors === undefined ||
      (modelRecord(value.refreshErrors) &&
        Object.values(value.refreshErrors).every(
          (error) =>
            modelRecord(error) &&
            typeof error.id === "string" &&
            typeof error.projectId === "string" &&
            typeof error.message === "string" &&
            typeof error.refreshPending === "boolean" &&
            (error.threadId === undefined || typeof error.threadId === "string"),
        ))) &&
    (value.error == null || typeof value.error === "string") &&
    (value.desktopCapabilities === undefined ||
      (modelRecord(value.desktopCapabilities) &&
        typeof value.desktopCapabilities.currentCommands === "boolean"))
  );
}
/** @param {unknown} value @returns {value is {id:string,revision:string,[key:string]:unknown}} */
function resourceRef(value) {
  return modelRecord(value) && typeof value.id === "string" && typeof value.revision === "string";
}
/** @param {unknown} value @returns {value is DesktopConnection} */
function desktopConnection(value) {
  return (
    modelRecord(value) &&
    ["connecting", "ready", "unavailable"].some((state) => value.state === state) &&
    (value.message === undefined || typeof value.message === "string") &&
    (value.recovery === undefined ||
      value.recovery === "check" ||
      value.recovery === "reconnect") &&
    (value.prerequisite === undefined ||
      (modelRecord(value.prerequisite) &&
        value.prerequisite.kind === "macos-command-line-tools" &&
        ["developer-tools-unavailable", "python-unavailable"].some(
          (reason) => modelRecord(value.prerequisite) && value.prerequisite.reason === reason,
        ) &&
        ["title", "detail", "installLabel", "retryLabel", "requestedMessage"].every(
          (key) => modelRecord(value.prerequisite) && typeof value.prerequisite[key] === "string",
        )))
  );
}
/** @param {unknown} value @returns {value is DesktopSnapshot} */
function isDesktopSnapshot(value) {
  if (
    !modelRecord(value) ||
    !Array.isArray(value.projects) ||
    !value.projects.every(isServiceProject) ||
    !require("./library-media.cjs").isLibraryState(value.library)
  )
    return false;
  return (
    (value.subscription === undefined ||
      require("./provider.cjs").isResponse(
        "chatgpt",
        { operation: "status" },
        value.subscription,
      )) &&
    (value.projectless === undefined ||
      (modelRecord(value.projectless) && typeof value.projectless.directory === "string")) &&
    (value.power == null ||
      (modelRecord(value.power) &&
        typeof value.power.enabled === "boolean" &&
        typeof value.power.active === "boolean" &&
        (value.power.error === null || typeof value.power.error === "string"))) &&
    (value.menuBar == null ||
      (modelRecord(value.menuBar) &&
        typeof value.menuBar.supported === "boolean" &&
        typeof value.menuBar.active === "boolean" &&
        (value.menuBar.error === null || typeof value.menuBar.error === "string"))) &&
    (value.revision === undefined || count(value.revision)) &&
    (value.desktopCapabilities === undefined ||
      (modelRecord(value.desktopCapabilities) &&
        typeof value.desktopCapabilities.currentCommands === "boolean")) &&
    (value.serviceSummary === undefined ||
      (modelRecord(value.serviceSummary) &&
        typeof value.serviceSummary.busy === "boolean" &&
        ["running", "stopped", "unknown"].some(
          (state) => modelRecord(value.serviceSummary) && value.serviceSummary.state === state,
        ))) &&
    (value.connection === undefined || desktopConnection(value.connection)) &&
    (value.backendUpdate === undefined ||
      (modelRecord(value.backendUpdate) &&
        ["applying", "pending", "failed"].some(
          (state) => modelRecord(value.backendUpdate) && value.backendUpdate.state === state,
        ) &&
        (value.backendUpdate.message === undefined ||
          typeof value.backendUpdate.message === "string"))) &&
    (value.lifecycle === undefined || isLifecycleProjection(value.lifecycle)) &&
    (value.computerControl == null ||
      require("./desktop-control.cjs").isComputerStatus(value.computerControl))
  );
}
/** @param {unknown} value @returns {DesktopSnapshot} */
function readDesktopSnapshot(value) {
  if (!isDesktopSnapshot(value)) throw new Error("Invalid Desktop snapshot envelope");
  return value;
}
/** @typedef {{externalCua?:boolean,permissionPreset?:'ask'|'autoReview'|'fullAccess'|null,interactionMode?:'interactive'|'asynchronous'|'headless',readOnly?:boolean,systemPrompt?:string|null,appendInstructions?:string,toolAllowlist?:string[]|null,approvalTools?:string[],preapprovedTools?:string[],maxModelRounds?:number|null}} ClientOptions */
/** @param {unknown} value @returns {value is ClientOptions} */
function clientOptions(value) {
  return (
    modelRecord(value) &&
    Object.keys(value).every((key) =>
      [
        "externalCua",
        "permissionPreset",
        "interactionMode",
        "readOnly",
        "systemPrompt",
        "appendInstructions",
        "toolAllowlist",
        "approvalTools",
        "preapprovedTools",
        "maxModelRounds",
      ].includes(key),
    ) &&
    ["externalCua", "readOnly"].every(
      (key) => value[key] === undefined || typeof value[key] === "boolean",
    ) &&
    (value.permissionPreset == null ||
      ["ask", "autoReview", "fullAccess"].some((entry) => value.permissionPreset === entry)) &&
    (value.interactionMode === undefined ||
      ["interactive", "asynchronous", "headless"].some(
        (entry) => value.interactionMode === entry,
      )) &&
    (value.systemPrompt == null || typeof value.systemPrompt === "string") &&
    (value.appendInstructions === undefined || typeof value.appendInstructions === "string") &&
    (value.toolAllowlist == null || require("./provider.cjs").strings(value.toolAllowlist)) &&
    ["approvalTools", "preapprovedTools"].every(
      (key) => value[key] === undefined || require("./provider.cjs").strings(value[key]),
    ) &&
    (value.maxModelRounds == null || count(value.maxModelRounds))
  );
}

/** @typedef {Omit<import('../core-model-contract.js').CoreQueue,'items'|'revision'> & {revision:number,paused:boolean,pauseReason:string|null,items:Array<{id:string,status:string,input:unknown[],configuration:Configuration,submittedBy:string,turnId:string|null}>}} Queue */
/** @param {unknown} value @returns {value is Queue} */
function isQueue(value) {
  return (
    isCoreQueue(value) &&
    typeof value.paused === "boolean" &&
    (value.pauseReason === null || typeof value.pauseReason === "string") &&
    value.items.every(
      (item) =>
        typeof item.id === "string" &&
        typeof item.status === "string" &&
        Array.isArray(item.input) &&
        isConfiguration(item.configuration) &&
        typeof item.submittedBy === "string" &&
        (item.turnId === null || typeof item.turnId === "string"),
    )
  );
}
/** @typedef {Record<string,unknown> & {creationAdmission?:import('../../../runtime-client/capabilities.js').CreationAdmission,requestId?:string,threadId?:string,taskId?:string,sourceThreadId?:string,parentThreadId?:string,turnId?:string,expectedTurnId?:string,expectedRevision?:number,previousItems?:unknown[],input?:unknown[]}} SubmissionParams */
/** @typedef {Record<string,unknown> & {method:string,params:SubmissionParams,operation?:import('../../../runtime-client/core.js').OperationRef,operationId?:string,remote?:RemoteAssociation}} PendingSubmission */
/** @param {unknown} value @returns {value is PendingSubmission} */
function isPendingSubmission(value) {
  return (
    modelRecord(value) &&
    typeof value.method === "string" &&
    isSubmissionParams(value.params) &&
    (value.createdAt === undefined || typeof value.createdAt === "string") &&
    (value.operation === undefined || isOperationRef(value.operation)) &&
    (value.operationId === undefined || typeof value.operationId === "string") &&
    (value.remote === undefined ||
      (isRemoteAssociation(value.remote) &&
        typeof value.operationId === "string" &&
        typeof value.method === "string"))
  );
}
/** @param {unknown} value @returns {value is SubmissionParams} */
function isSubmissionParams(value) {
  return (
    modelRecord(value) &&
    (value.creationAdmission === undefined ||
      require("../../../runtime-client/capabilities.js").isCreationAdmission(
        value.creationAdmission,
      )) &&
    [
      "requestId",
      "threadId",
      "taskId",
      "sourceThreadId",
      "parentThreadId",
      "turnId",
      "expectedTurnId",
    ].every((key) => value[key] === undefined || typeof value[key] === "string") &&
    (value.expectedRevision === undefined || typeof value.expectedRevision === "number") &&
    (value.previousItems === undefined || Array.isArray(value.previousItems)) &&
    (value.input === undefined || Array.isArray(value.input))
  );
}

module.exports = {
  isQueue,
  isPendingSubmission,
  isSubmissionParams,
  clientOptions,
  modelRecord,
  count,
  resourceRef,
  isConfiguration,
  readInspection,
  readConfigured,
  readAdmission,
  readThreadAdmission,
  readQueueAdmission,
  admission,
  isSubmissionOutcomes,
  isOperationRef,
  isRemoteAssociation,
  parseSubmissionOutcomes,
  readReceipts,
  isReceipt,
  KINDS,
  isLifecycleReceipt,
  lifecycleViewOperation,
  readLifecycleReceipt,
  isLifecycleProjection,
  isRecoveryView,
  isServiceProject,
  isDesktopSnapshot,
  readDesktopSnapshot,
};
