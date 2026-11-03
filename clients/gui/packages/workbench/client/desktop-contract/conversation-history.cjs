// @ts-check
"use strict";
const { isConfiguration } = require("./shared.cjs");
const {
  isCoreThread,
  isCoreTurn,
  isCoreItem,
  isCoreQueue,
  isCoreInteraction,
  isCoreTask,
  modelRecord,
} = require("../core-model-contract.js");

/** @typedef {import('../core-model-contract.js').CoreItem} HistoryItem */
/** @typedef {HistoryItem & {type:'historyDeferred',cursor:string,version:string,totalBytes:number}} DeferredItem */
/** @typedef {import('./shared.cjs').Configuration} Configuration */
/** @typedef {Record<string,unknown> & {configuration?:Configuration,queue?:import('../core-model-contract.js').CoreQueue,interactions?:import('../core-model-contract.js').CoreInteraction[],interactionRevision?:number,archived?:boolean}} HistoryDesktop */
/** @typedef {import('../core-model-contract.js').CoreThread & {desktop?:HistoryDesktop|null,conversation?:({kind?:string,policy?:{kind?:string},[key:string]:unknown})|null}} HistorySummary */
/** @typedef {import('../core-model-contract.js').CoreTurn & {items:HistoryItem[]}} HistoryTurn */
/** @typedef {{id:string,turns:HistoryTurn[],desktop?:HistoryDesktop|null,conversation?:HistorySummary['conversation'],[key:string]:unknown}} HistoryThread */
/** @typedef {{snapshotId:string,nextCursor:string|null,complete:boolean,[key:string]:unknown}} HistoryCursor */
/** @typedef {{thread:HistoryThread,history?:HistoryCursor,[key:string]:unknown}} ObservationResult */
/** @typedef {{sourceThreadId:string,sourceTurnId:string,sourceItemId:string,sourceTurnStatus:string,turn:import('../core-model-contract.js').CoreTurn,item:HistoryItem,fragment?:never,[key:string]:unknown}} HistoryEntry */
/** @typedef {HistoryCursor & {data:HistoryEntry[]}} HistoryPage */
/** @typedef {{text:string,offsetUtf8:number,nextOffsetUtf8:number,totalBytes:number,version:string}} HistoryFragment */
/** @typedef {{sourceThreadId:string,sourceTurnId:string,sourceItemId:string,sourceTurnStatus:string,fragment:HistoryFragment,[key:string]:unknown}} HistoryFragmentEntry */
/** @typedef {HistoryCursor & {data:HistoryFragmentEntry[]}} HistoryFragmentPage */

/** @param {unknown} value @returns {ObservationResult} */
function readObservationResult(value) {
  if (!observationResult(value)) throw historyFailure("历史响应结构无效，请重新打开聊天。");
  return value;
}
/** @param {unknown} value @returns {{thread:HistorySummary}} */
function readThreadMetadata(value) {
  if (!modelRecord(value) || !historySummary(value.thread))
    throw historyFailure("会话元数据结构无效。");
  return { thread: value.thread };
}
/** @param {unknown} value @returns {HistoryPage} */
function readHistoryPage(value) {
  if (!historyPage(value)) throw historyFailure("历史页结构无效，请重新打开聊天。");
  return value;
}
/** @param {unknown} value @returns {HistoryFragmentPage} */
function readHistoryFragmentPage(value) {
  if (!historyFragmentPage(value)) throw historyFailure("历史内容分片结构无效，请重新打开聊天。");
  return value;
}
/** @param {unknown} value @returns {HistoryEntry} */
function readHistoryEntry(value) {
  if (!historyEntry(value)) throw historyFailure("完整历史内容结构无效，请重新打开聊天。");
  return value;
}
/** @param {string} message */
function historyFailure(message) {
  return Object.assign(new Error(message), {
    code: "HISTORY_VIEW_UNAVAILABLE",
    outcome: { kind: "noMutation" },
    recovery: { kind: "none" },
  });
}
/** @param {unknown} value @returns {value is ObservationResult} */
function observationResult(value) {
  return (
    modelRecord(value) &&
    historyThread(value.thread) &&
    (value.history === undefined || historyCursor(value.history))
  );
}
/** @param {unknown} value @returns {value is HistoryThread} */
function historyThread(value) {
  return (
    historySummary(value) &&
    Array.isArray(value.turns) &&
    value.turns.every((turn) => Array.isArray(turn.items) && turn.items.every(historyItem))
  );
}
/** @param {unknown} value @returns {value is HistoryCursor} */
function historyCursor(value) {
  return (
    modelRecord(value) &&
    typeof value.snapshotId === "string" &&
    typeof value.complete === "boolean" &&
    (value.nextCursor === null || typeof value.nextCursor === "string")
  );
}
/** @param {unknown} value @returns {value is HistoryEntry} */
function historyEntry(value) {
  return (
    modelRecord(value) &&
    typeof value.sourceThreadId === "string" &&
    typeof value.sourceTurnId === "string" &&
    typeof value.sourceItemId === "string" &&
    typeof value.sourceTurnStatus === "string" &&
    isCoreTurn(value.turn) &&
    historyItem(value.item) &&
    value.fragment === undefined
  );
}
/** @param {unknown} value @returns {value is HistoryPage} */
function historyPage(value) {
  return (
    modelRecord(value) &&
    historyCursor(value) &&
    Array.isArray(value.data) &&
    value.data.every(historyEntry)
  );
}
/** @param {unknown} value @returns {value is HistoryFragmentEntry} */
function historyFragmentEntry(value) {
  if (
    !modelRecord(value) ||
    typeof value.sourceThreadId !== "string" ||
    typeof value.sourceTurnId !== "string" ||
    typeof value.sourceItemId !== "string" ||
    typeof value.sourceTurnStatus !== "string" ||
    !modelRecord(value.fragment)
  )
    return false;
  const fragment = value.fragment;
  return (
    typeof fragment.text === "string" &&
    typeof fragment.version === "string" &&
    integer(fragment.offsetUtf8) &&
    integer(fragment.nextOffsetUtf8) &&
    integer(fragment.totalBytes)
  );
}
/** @param {unknown} value @returns {value is HistoryFragmentPage} */
function historyFragmentPage(value) {
  return (
    modelRecord(value) &&
    historyCursor(value) &&
    Array.isArray(value.data) &&
    value.data.every(historyFragmentEntry)
  );
}
/** @param {unknown} value @returns {value is number} */
function integer(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** @param {unknown} value @returns {value is HistorySummary} */
function historySummary(value) {
  return (
    isCoreThread(value) &&
    (value.desktop == null ||
      ((value.desktop.configuration === undefined ||
        isConfiguration(value.desktop.configuration)) &&
        (value.desktop.queue === undefined || isCoreQueue(value.desktop.queue)) &&
        (value.desktop.interactions === undefined ||
          (Array.isArray(value.desktop.interactions) &&
            value.desktop.interactions.every(isCoreInteraction))) &&
        (value.desktop.interactionRevision === undefined ||
          integer(value.desktop.interactionRevision)) &&
        (value.desktop.archived === undefined || typeof value.desktop.archived === "boolean"))) &&
    (value.conversation == null ||
      value.conversation.policy === undefined ||
      (modelRecord(value.conversation.policy) &&
        (value.conversation.policy.kind === undefined ||
          typeof value.conversation.policy.kind === "string")))
  );
}
/** @param {unknown} value @returns {value is HistoryItem} */
function historyItem(value) {
  return isCoreItem(value) && (value.type !== "historyDeferred" || isDeferredItem(value));
}
/** @param {unknown} value @returns {value is DeferredItem} */
function isDeferredItem(value) {
  return (
    isCoreItem(value) &&
    value.type === "historyDeferred" &&
    typeof value.cursor === "string" &&
    typeof value.version === "string" &&
    integer(value.totalBytes) &&
    (value.preview === undefined ||
      (isCoreItem(value.preview) &&
        value.preview.id === value.id &&
        value.preview.type === value.originalType))
  );
}
/** @param {unknown} value @returns {{data:HistorySummary[],nextCursor?:string|null}} */
function readThreadList(value) {
  if (
    !modelRecord(value) ||
    !Array.isArray(value.data) ||
    !value.data.every(historySummary) ||
    (value.nextCursor != null && typeof value.nextCursor !== "string")
  )
    throw historyFailure("会话列表结构无效。");
  return { ...value, data: value.data, nextCursor: value.nextCursor };
}
/** @typedef {Record<string,unknown> & {threadId?:string,thread?:HistorySummary,turn?:import('../core-model-contract.js').CoreTurn,turnId?:string,interaction?:import('../core-model-contract.js').CoreInteraction,configuration?:Configuration,task?:import('../core-model-contract.js').CoreTask}} HistoryNotification */
/** @param {unknown} value @returns {value is HistoryNotification} */
function isHistoryNotification(value) {
  return (
    modelRecord(value) &&
    (value.threadId === undefined || typeof value.threadId === "string") &&
    (value.turnId === undefined || typeof value.turnId === "string") &&
    (value.thread === undefined || historySummary(value.thread)) &&
    (value.turn === undefined || isCoreTurn(value.turn)) &&
    (value.interaction === undefined || isCoreInteraction(value.interaction)) &&
    (value.configuration === undefined || isConfiguration(value.configuration)) &&
    (value.task === undefined || isCoreTask(value.task))
  );
}

/** @typedef {import('../core-model-contract.js').CoreTask & {mode?:string,runs:Array<{id:string,status:string,threadId?:string|null,[key:string]:unknown}>}} ObservedTask */
/** @param {unknown} value @returns {ObservedTask[]} */
function readObservedTasks(value) {
  if (!Array.isArray(value) || !value.every(isObservedTask))
    throw historyFailure("任务通知列表结构无效。");
  return value;
}
/** @param {unknown} value @returns {value is ObservedTask} */
function isObservedTask(value) {
  return (
    isCoreTask(value) &&
    (value.mode === undefined || typeof value.mode === "string") &&
    Array.isArray(value.runs) &&
    value.runs.every(
      (run) =>
        modelRecord(run) &&
        typeof run.id === "string" &&
        typeof run.status === "string" &&
        (run.threadId == null || typeof run.threadId === "string"),
    )
  );
}
/** @param {unknown} value @returns {import('../core-model-contract.js').CoreInteractions} */
function readHistoryInteractions(value) {
  const { isCoreInteractions } = require("../core-model-contract.js");
  if (!isCoreInteractions(value)) throw historyFailure("会话交互结构无效。");
  return value;
}

/** @param {unknown} value @returns {HistoryCursor & {data:(HistoryEntry|HistoryFragmentEntry)[]}} */
function readInheritedHistoryPage(value) {
  if (
    !modelRecord(value) ||
    !historyCursor(value) ||
    !Array.isArray(value.data) ||
    !value.data.every((entry) => historyEntry(entry) || historyFragmentEntry(entry))
  )
    throw historyFailure("继承历史页结构无效。");
  return { ...value, data: value.data };
}
module.exports = {
  readInheritedHistoryPage,
  readObservationResult,
  readHistoryPage,
  readHistoryFragmentPage,
  readHistoryEntry,
  historyFailure,
  readThreadList,
  isDeferredItem,
  isHistoryNotification,
  readObservedTasks,
  readHistoryInteractions,
  readThreadMetadata,
  historyPage,
  historySummary,
};
