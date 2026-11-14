// @ts-check
"use strict";
const {
  isPendingSubmission,
  isSubmissionParams,
  isSubmissionOutcomes,
  isOperationRef,
  isRemoteAssociation,
} = require("@areal/workbench/desktop-contract/shared");

/** @typedef {{id?:string,projectId?:string,threadId?:string,connectionGeneration?:number,code:unknown,reason?:unknown,message:string,retryable:boolean,refreshPending?:boolean,recovery?:import('@areal/runtime-client/core').Recovery}} ObservationError */
/** @typedef {{id:string,projectId:string,connectionGeneration?:number,operation?:import('@areal/runtime-client/core').OperationRef,scope?:string,message:string,refreshPending:boolean}} RefreshError */
/** @typedef {{client:import('@areal/runtime-client/core').CoreClient|null|undefined,generation?:number,id:string,promise:Promise<void>}} ObservationRead */
/** @typedef {{full:boolean,ids:Set<string>,promise:Promise<import('@areal/workbench/core-model-contract').CoreThread[]>,resolve:(rows:import('@areal/workbench/core-model-contract').CoreThread[])=>void,reject:(error:unknown)=>void}} SummaryBatch */
/** @typedef {{client:import('@areal/runtime-client/core').CoreClient,generation?:number,pending:SummaryBatch|null,finished:boolean,promise?:SummaryBatch['promise']}} SummaryRead */
/** @typedef {PendingSubmission & {operationId:string,remote:RemoteAssociation}} RemotePending */
/** @typedef {(PendingSubmission|SubmissionOutcome) & {method:string,operationId:string,remote:RemoteAssociation}} RemoteRecord */
/** @typedef {{client:import('@areal/runtime-client/core').CoreClient,generation?:number,deadline:number,attempt:number,running:boolean,timer?:NodeJS.Timeout|null}} Reconciliation */
/** The mutable Desktop projection; durable execution facts stay in Core. */
/** @typedef {import("@areal/workbench/desktop-contract/shared").SubmissionParams} SubmissionParams */
/** @typedef {import("@areal/workbench/desktop-contract/shared").RemoteAssociation} RemoteAssociation */
/** @typedef {import("@areal/workbench/desktop-contract/shared").PendingSubmission} PendingSubmission */
/** @typedef {import("@areal/workbench/desktop-contract/shared").SubmissionOutcome} SubmissionOutcome */
/** @typedef {import('./project-index.cjs').SavedProject & {
 * model:import('@areal/workbench/core-model').CoreTaskModel,
 * pending:PendingSubmission[],unconfirmedReads?:Map<string,number>,journalWrite?:Promise<unknown>,reconciliation?:Reconciliation|null,reconciliationRead?:{client:import('@areal/runtime-client/core').CoreClient|null|undefined,generation?:number,promise:Promise<void>}|null,outcomes:Record<string,SubmissionOutcome>,
 * configurations:Record<string,import("./thread-configuration.cjs").Configuration|undefined>,configurationChanges:Map<string,string>,taskDraftWrites?:Map<string,Promise<unknown>>,taskCreateWrites?:Map<string,Promise<unknown>>,taskViewWrite?:Promise<unknown>,
 * models?:import('./provider-contract.cjs').ModelCatalogEntry[],profiles?:unknown,resourceProfile?:import('@areal/workbench/desktop-contract').ResourceRef,resourceFingerprint?:string,providerRevision?:string|null,providerSnapshot?:import('./provider-contract.cjs').ModelSnapshot,summariesLoaded?:boolean,
 * providerProof?:import('./provider-contract.cjs').ConfigurationProof,providerError?:string|null,providerFailure?:{revision:string,serviceId?:string,generation?:string,message:string,catalogRefreshPending?:boolean},
 * observationErrors?:Record<string,ObservationError>,refreshErrors?:Record<string,RefreshError>,
 * observationReads?:Map<string,ObservationRead>,summaryRead?:SummaryRead,summaryReads?:Promise<void|import('@areal/workbench/core-model-contract').CoreThread[]>,
 * taskNotificationMonitor?:InstanceType<typeof import('./notifications.cjs').TaskNotificationMonitor>,taskViews?:Map<string,string>,
 * error:string|null,summaries:import('@areal/workbench/core-model-contract').CoreThread[],
 * service?:(import('./local-service.cjs').RecoveryTarget & {endpoint?:string,owner?:unknown,hostPid?:unknown,corePid?:unknown})|null,resourceInitializing?:boolean,endpoint?:string|null,token?:string,connectionGeneration?:number,
 * reconnectTimer?:NodeJS.Timeout|null,reconnectBlocked?:boolean,reconnectAttempt?:number,binaryUpdatePending?:boolean,
 * crashCheck?:{generation:string,started:number},crashAttempts?:number[],crashRecovery?:{original:import('./local-service.cjs').RecoveryTarget,calls:number},journalLoaded?:boolean,client?:import('@areal/runtime-client/core').CoreClient|null,hookRevision?:string|null
 * }} CoreProject */

/** @param {import('./project-index.cjs').SavedProject} saved @param {import('@areal/workbench/core-model').CoreTaskModel} model @returns {CoreProject} */
function createProjectState(saved, model) {
  return {
    ...saved,
    model,
    pending: [],
    outcomes: {},
    configurations: {},
    configurationChanges: new Map(),
    error: null,
    summaries: [],
  };
}

/** @param {unknown} value @returns {PendingSubmission[]} */
function parsePendingSubmissions(value) {
  if (!Array.isArray(value) || !value.every(isPendingSubmission))
    throw new Error("Invalid pending submission journal");
  return value;
}
/** @param {unknown} value @returns {Record<string,SubmissionOutcome>} */
function parseSubmissionOutcomes(value) {
  if (!isSubmissionOutcomes(value)) throw new Error("Invalid submission outcome journal");
  return value;
}
/** @param {PendingSubmission|SubmissionOutcome} value @returns {value is RemoteRecord} */
function isRemoteRecord(value) {
  return (
    typeof value.method === "string" &&
    typeof value.operationId === "string" &&
    value.remote !== undefined
  );
}

/** @param {string} projectId @param {PendingSubmission} entry @returns {string|null} */
function submissionKey(projectId, entry) {
  const requestId = entry.params.requestId ?? entry.operation?.requestId;
  if (!requestId && !entry.operationId) return null;
  return JSON.stringify([projectId, requestId ?? null, entry.operationId ?? null]);
}

/** @param {string} projectId @param {PendingSubmission} left @param {PendingSubmission} right */
function sameSubmission(projectId, left, right) {
  const key = submissionKey(projectId, left);
  return key !== null && key === submissionKey(projectId, right);
}

/** @param {Set<string>} responses @param {string} projectId @param {PendingSubmission} entry */
function isAwaitingResponse(responses, projectId, entry) {
  const key = submissionKey(projectId, entry);
  return key !== null && responses.has(key);
}

// Core 可达且连续两次答复“没有这条回执”后，这条提交不再锁住对话；
// 记录仍留在日志里，之后回执出现照常结算。只存在内存里，重启后重新核对。
const unresolvedAfterReads = 2;

/** @param {{unconfirmedReads?:Map<string,number>}} project @param {PendingSubmission} entry @param {{confirmed?:unknown,state?:unknown}} result */
function noteReconcileRead(project, entry, result) {
  const id = entry.params?.requestId;
  if (typeof id !== "string") return;
  project.unconfirmedReads ??= new Map();
  if (result.confirmed === false && result.state === "unconfirmed")
    project.unconfirmedReads.set(id, (project.unconfirmedReads.get(id) ?? 0) + 1);
  else project.unconfirmedReads.delete(id);
}

/** @param {{unconfirmedReads?:Map<string,number>}|undefined|null} project @param {PendingSubmission} entry */
function isUnresolved(project, entry) {
  const id = entry.params?.requestId;
  return (
    typeof id === "string" && (project?.unconfirmedReads?.get(id) ?? 0) >= unresolvedAfterReads
  );
}

module.exports = {
  createProjectState,
  isUnresolved,
  noteReconcileRead,
  submissionKey,
  sameSubmission,
  isAwaitingResponse,
  parsePendingSubmissions,
  parseSubmissionOutcomes,
  isSubmissionParams,
  isOperationRef,
  isRemoteAssociation,
  isPendingSubmission,
  isRemoteRecord,
};
