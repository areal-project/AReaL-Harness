// @ts-check
"use strict";
// The Remote reader owns these extra Core fields; unconsumed extensions stay unknown.
/** @typedef {Record<string,unknown>} Fields */
/** @typedef {Fields & {type:string,text?:string,media?:Media|null}} Part */
/** @typedef {Fields & {uri:string,mimeType:string,sizeBytes:number}} Media */
/** @typedef {Fields & {outcome?:string,hooks?:Fields[]|null}} Execution */
/** @typedef {Fields & {id:string,type:string,text?:string|null,tool?:string,summary?:unknown[]|null,content?:(Part|string)[]|null,contentItems?:Part[]|null,execution?:Execution|null,media?:Media|null}} Item */
/** @typedef {Fields & {id:string,status?:string,items?:Item[]|null,goal?:Fields|null}} Turn */
/** @typedef {Fields & {id:string,title?:string,options:string[],allowFreeText?:boolean}} Question */
/** @typedef {Fields & {threadId:string,turnId:string,requestId:string,kind:string,status:string,expiresAt:number,questions?:Question[]|null}} Interaction */
/** @typedef {Fields & {items?:Array<Fields & {input?:Part[]|null}>|null,revision?:number}} Queue */
/** @typedef {Fields & {revision?:number,model?:Fields|null,parameters?:Fields|null,profile?:Fields|null,options?:Fields|null,permissions?:Fields|null}} Configuration */
/** @typedef {Fields & {revision:number,eventSequence?:number,goal?:Fields|null}} Goals */
/** @typedef {Fields & {id:string,turns?:Turn[]|null,status?:Fields|null,goals?:Goals|null,desktop?:(Fields & {receipts?:Fields[]|null,interactions?:Interaction[]|null,queue?:Queue|null,configuration?:Configuration|null})|null}} Thread */
/** @typedef {Fields & {id:string,status:string,workers?:Fields[]|null,reason?:string|null}} TaskRun */
/** @typedef {Fields & {id:string,revision:number,runs:TaskRun[]}} Task */
/** @typedef {Fields & {id:string,runId:string,kind:string,status:string,expiresAt?:number|null,questions?:Question[]|null}} ChannelItem */
/** @typedef {{thread:Thread,ownership:Fields & {kind:'ordinary'|'task'}}} Observation */
/** @typedef {{thread:Thread}} ThreadRead */
/** @typedef {{data:Interaction[]}} InteractionList */
/** @typedef {{taskId:string,data:ChannelItem[],hasMore:boolean,nextSequence:number}} ChannelRead */
/** @typedef {Fields & {attentionRefs:Fields[],attentionComplete:boolean,execution?:Fields|null,queue?:Fields|null,workers?:Fields[]|null}} WorkRow */
/** @typedef {{data:WorkRow[],nextCursor:string|null,complete:boolean}} WorkOverview */
/** @param {unknown} value @returns {value is Fields} */
function record(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
/** @param {unknown} value @returns {value is number} */
function integer(value) {
  return typeof value === "number" && Number.isSafeInteger(value);
}
/** @param {unknown} value @returns {value is Media} */
function media(value) {
  return (
    record(value) &&
    typeof value.uri === "string" &&
    typeof value.mimeType === "string" &&
    integer(value.sizeBytes)
  );
}
/** @param {unknown} value @returns {value is Part} */
function part(value) {
  return (
    record(value) &&
    typeof value.type === "string" &&
    (value.text === undefined || typeof value.text === "string") &&
    (value.media == null || media(value.media))
  );
}
/** @param {unknown} value @returns {value is Execution} */
function execution(value) {
  return (
    record(value) &&
    (value.outcome === undefined || typeof value.outcome === "string") &&
    (value.hooks == null || (Array.isArray(value.hooks) && value.hooks.every(record)))
  );
}
/** @param {unknown} value @returns {value is Item} */
function item(value) {
  return (
    record(value) &&
    typeof value.id === "string" &&
    typeof value.type === "string" &&
    (value.text == null || typeof value.text === "string") &&
    (value.tool === undefined || typeof value.tool === "string") &&
    (value.summary == null || Array.isArray(value.summary)) &&
    (value.content == null ||
      (Array.isArray(value.content) &&
        value.content.every((v) => typeof v === "string" || part(v)))) &&
    (value.contentItems == null ||
      (Array.isArray(value.contentItems) && value.contentItems.every(part))) &&
    (value.execution == null || execution(value.execution)) &&
    (value.media == null || media(value.media))
  );
}
/** @param {unknown} value @returns {value is Turn} */
function turn(value) {
  return (
    record(value) &&
    typeof value.id === "string" &&
    (value.status === undefined || typeof value.status === "string") &&
    (value.items == null || (Array.isArray(value.items) && value.items.every(item))) &&
    (value.goal == null || record(value.goal))
  );
}
/** @param {unknown} value @returns {value is Question} */
function question(value) {
  return (
    record(value) &&
    typeof value.id === "string" &&
    (value.title === undefined || typeof value.title === "string") &&
    Array.isArray(value.options) &&
    value.options.every((v) => typeof v === "string") &&
    (value.allowFreeText === undefined || typeof value.allowFreeText === "boolean")
  );
}
/** @param {unknown} value @returns {value is Interaction} */
function interaction(value) {
  return (
    record(value) &&
    typeof value.threadId === "string" &&
    typeof value.turnId === "string" &&
    typeof value.requestId === "string" &&
    typeof value.kind === "string" &&
    typeof value.status === "string" &&
    typeof value.expiresAt === "number" &&
    (value.questions == null || (Array.isArray(value.questions) && value.questions.every(question)))
  );
}
/** @param {unknown} value @returns {value is Queue} */
function queue(value) {
  return (
    record(value) &&
    (value.revision === undefined || integer(value.revision)) &&
    (value.items == null ||
      (Array.isArray(value.items) &&
        value.items.every(
          (v) => record(v) && (v.input == null || (Array.isArray(v.input) && v.input.every(part))),
        )))
  );
}
/** @param {unknown} value @returns {value is Configuration} */
function configuration(value) {
  return (
    record(value) &&
    (value.revision === undefined || integer(value.revision)) &&
    ["model", "parameters", "profile", "options", "permissions"].every(
      (key) => value[key] == null || record(value[key]),
    )
  );
}
/** @param {unknown} value @returns {value is Goals} */
function goals(value) {
  return (
    record(value) &&
    integer(value.revision) &&
    (value.eventSequence === undefined || integer(value.eventSequence)) &&
    (value.goal == null || record(value.goal))
  );
}
/** @param {unknown} value @returns {value is Thread} */
function thread(value) {
  return (
    record(value) &&
    typeof value.id === "string" &&
    (value.turns == null || (Array.isArray(value.turns) && value.turns.every(turn))) &&
    (value.status == null || record(value.status)) &&
    (value.goals == null || goals(value.goals)) &&
    (value.desktop == null ||
      (record(value.desktop) &&
        (value.desktop.receipts == null ||
          (Array.isArray(value.desktop.receipts) && value.desktop.receipts.every(record))) &&
        (value.desktop.interactions == null ||
          (Array.isArray(value.desktop.interactions) &&
            value.desktop.interactions.every(interaction))) &&
        (value.desktop.queue == null || queue(value.desktop.queue)) &&
        (value.desktop.configuration == null || configuration(value.desktop.configuration))))
  );
}
/** @param {unknown} value @returns {value is Task} */
function task(value) {
  return (
    record(value) &&
    typeof value.id === "string" &&
    integer(value.revision) &&
    Array.isArray(value.runs) &&
    value.runs.every(
      (v) =>
        record(v) &&
        typeof v.id === "string" &&
        typeof v.status === "string" &&
        (v.reason == null || typeof v.reason === "string") &&
        (v.workers == null || (Array.isArray(v.workers) && v.workers.every(record))),
    )
  );
}
/** @param {unknown} value @returns {value is ChannelItem} */
function channelItem(value) {
  return (
    record(value) &&
    typeof value.id === "string" &&
    typeof value.runId === "string" &&
    typeof value.kind === "string" &&
    typeof value.status === "string" &&
    (value.expiresAt == null || typeof value.expiresAt === "number") &&
    (value.questions == null || (Array.isArray(value.questions) && value.questions.every(question)))
  );
}
function invalid() {
  return Object.assign(new Error("Core 返回了无效的读取结果"), { code: "CORE_INCOMPATIBLE" });
}
/** @param {unknown} value @returns {ThreadRead} */
function threadRead(value) {
  if (!record(value) || !thread(value.thread)) throw invalid();
  return { thread: value.thread };
}
/** @param {unknown} value @returns {Observation} */
function observation(value) {
  if (
    !record(value) ||
    !thread(value.thread) ||
    !record(value.ownership) ||
    (value.ownership.kind !== "ordinary" && value.ownership.kind !== "task")
  )
    throw invalid();
  return { thread: value.thread, ownership: { ...value.ownership, kind: value.ownership.kind } };
}
/** @param {unknown} value @returns {InteractionList} */
function interactions(value) {
  if (!record(value) || !Array.isArray(value.data) || !value.data.every(interaction))
    throw invalid();
  return { data: value.data };
}
/** @param {unknown} value @returns {Task} */
function taskRead(value) {
  if (!task(value)) throw invalid();
  return value;
}
/** @param {unknown} value @returns {ChannelRead} */
function channelRead(value) {
  if (
    !record(value) ||
    typeof value.taskId !== "string" ||
    !Array.isArray(value.data) ||
    !value.data.every(channelItem) ||
    typeof value.hasMore !== "boolean" ||
    !integer(value.nextSequence)
  )
    throw invalid();
  return {
    taskId: value.taskId,
    data: value.data,
    hasMore: value.hasMore,
    nextSequence: value.nextSequence,
  };
}
/** @param {unknown} value @returns {value is WorkRow} */
function workRow(value) {
  return (
    record(value) &&
    Array.isArray(value.attentionRefs) &&
    value.attentionRefs.every(record) &&
    typeof value.attentionComplete === "boolean" &&
    (value.execution == null || record(value.execution)) &&
    (value.queue == null || record(value.queue)) &&
    (value.workers == null || (Array.isArray(value.workers) && value.workers.every(record)))
  );
}
/** @param {unknown} value @returns {WorkOverview} */
function workOverview(value) {
  if (
    !record(value) ||
    !Array.isArray(value.data) ||
    !value.data.every(workRow) ||
    (value.nextCursor !== null && typeof value.nextCursor !== "string") ||
    typeof value.complete !== "boolean"
  )
    throw invalid();
  return { data: value.data, nextCursor: value.nextCursor, complete: value.complete };
}
/** @typedef {Fields & {threadId?:string,turnId?:string,itemId?:string,delta?:string,itemIds?:string[],interaction?:Interaction,turn?:Turn,item?:Item,configuration?:Configuration,queue?:Queue}} Notification */
/** @param {unknown} value @returns {value is Notification} */
function notification(value) {
  return (
    record(value) &&
    ["threadId", "turnId", "itemId", "delta"].every(
      (key) => value[key] === undefined || typeof value[key] === "string",
    ) &&
    (value.itemIds === undefined ||
      (Array.isArray(value.itemIds) && value.itemIds.every((v) => typeof v === "string"))) &&
    (value.interaction === undefined || interaction(value.interaction)) &&
    (value.turn === undefined || turn(value.turn)) &&
    (value.item === undefined || item(value.item)) &&
    (value.configuration === undefined || configuration(value.configuration)) &&
    (value.queue === undefined || queue(value.queue))
  );
}
/** @param {unknown} value @returns {Fields[]} */
function modelCatalog(value) {
  if (!Array.isArray(value) || !value.every(record)) throw invalid();
  return value;
}
/** @param {import('./project-state.cjs').CoreProject|undefined} project @returns {project is import('./remote-session-observer.cjs').ReadyProject} */
function readyProject(project) {
  return (
    !!project?.client?.ready &&
    !project.client.closed &&
    !!project.model.state.connected &&
    !project.resourceInitializing
  );
}

/** @param {unknown} error */
function errorCode(error) {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

/** @param {string} code @param {string} message */
const failure = (code, message) => Object.assign(new Error(message), { code });

module.exports = {
  failure,
  errorCode,
  readyProject,
  modelCatalog,
  record,
  part,
  threadRead,
  observation,
  interactions,
  taskRead,
  channelRead,
  workOverview,
  notification,
};
