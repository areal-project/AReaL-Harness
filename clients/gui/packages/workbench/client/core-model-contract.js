// @ts-check
/** Types for the fields the rebuildable model reads; opaque Core extensions remain unknown. */
/** @typedef {import('./state-projection.cjs').ProjectionNode & {type?:string,text?:unknown,summary?:unknown[],content?:unknown[]}} CoreItem */
/** @typedef {import('./state-projection.cjs').ProjectionNode & {trace?:{activities?:Record<string,unknown>[],[key:string]:unknown},status?:string,items?:CoreItem[]|null,modelRetry?:{purpose:string,retry:number,delayMs?:number}}} CoreTurn */
/** @typedef {{revision:number,eventSequence?:number,goal?:unknown,[key:string]:unknown}} CoreGoals */
/** @typedef {{revision:number,steps:unknown[],[key:string]:unknown}} CorePlan */
/** @typedef {Record<string,unknown> & {id?:string,status?:string,input?:unknown[]}} CoreQueueItem */
/** @typedef {{revision:number,items:CoreQueueItem[],[key:string]:unknown}} CoreQueue */
/** @typedef {{threadId:string,requestId:string,[key:string]:unknown}} CoreInteraction */
/** @typedef {{revision:number,data:CoreInteraction[],[key:string]:unknown}} CoreInteractions */
/** @typedef {import('./state-projection.cjs').ProjectionNode & {revision:number,channelSequence?:number}} CoreTask */
/** @typedef {import('./state-projection.cjs').ProjectionNode & {turns?:CoreTurn[]|null,toolsetRevision?:number,dynamicTools?:unknown[],goals?:CoreGoals,desktop?:({plan?:CorePlan|null,[key:string]:unknown})|null,conversation?:({kind?:string,[key:string]:unknown})|null}} CoreThread */
/** @typedef {{connected:boolean,error:string|null,threads:Record<string,CoreThread>,interactions:Record<string,CoreInteractions>,queues:Record<string,CoreQueue>,tasks?:Record<string,CoreTask>}} CoreModelState */

/** @param {unknown} value @returns {value is Record<string,unknown>} */
export function modelRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
/** @param {unknown} value @returns {value is number} */
function revision(value) {
  return typeof value === "number" && Number.isSafeInteger(value);
}
/** @param {unknown} value @returns {value is CoreItem} */
export function isCoreItem(value) {
  return (
    modelRecord(value) &&
    typeof value.id === "string" &&
    (value.type === undefined || typeof value.type === "string") &&
    (value.createdAt == null || revision(value.createdAt)) &&
    (value.summary === undefined || Array.isArray(value.summary)) &&
    (value.content === undefined || Array.isArray(value.content))
  );
}
/** @param {unknown} value @returns {value is CoreTurn} */
export function isCoreTurn(value) {
  return (
    modelRecord(value) &&
    typeof value.id === "string" &&
    (value.status === undefined || typeof value.status === "string") &&
    (value.items == null || (Array.isArray(value.items) && value.items.every(isCoreItem))) &&
    (value.modelRetry === undefined ||
      (modelRecord(value.modelRetry) &&
        typeof value.modelRetry.purpose === "string" &&
        revision(value.modelRetry.retry)))
  );
}
/** @param {unknown} value @returns {value is CoreGoals} */
export function isCoreGoals(value) {
  return (
    modelRecord(value) &&
    revision(value.revision) &&
    (value.eventSequence === undefined || revision(value.eventSequence))
  );
}
/** @param {unknown} value @returns {value is CorePlan} */
export function isCorePlan(value) {
  return modelRecord(value) && revision(value.revision) && Array.isArray(value.steps);
}
/** @param {unknown} value @returns {value is CoreQueue} */
export function isCoreQueue(value) {
  return (
    modelRecord(value) &&
    revision(value.revision) &&
    Array.isArray(value.items) &&
    value.items.every(isCoreQueueItem)
  );
}
/** @param {unknown} value @returns {value is CoreQueueItem} */
function isCoreQueueItem(value) {
  return (
    modelRecord(value) &&
    (value.id === undefined || typeof value.id === "string") &&
    (value.status === undefined || typeof value.status === "string") &&
    (value.input === undefined || Array.isArray(value.input))
  );
}
/** @param {unknown} value @returns {value is CoreInteraction} */
export function isCoreInteraction(value) {
  return (
    modelRecord(value) && typeof value.threadId === "string" && typeof value.requestId === "string"
  );
}
/** @param {unknown} value @returns {value is CoreInteractions} */
export function isCoreInteractions(value) {
  return (
    modelRecord(value) &&
    revision(value.revision) &&
    Array.isArray(value.data) &&
    value.data.every(isCoreInteraction)
  );
}
/** @param {unknown} value @returns {value is CoreTask} */
export function isCoreTask(value) {
  return (
    modelRecord(value) &&
    typeof value.id === "string" &&
    revision(value.revision) &&
    (value.channelSequence === undefined || revision(value.channelSequence))
  );
}
/** @param {unknown} value @returns {boolean} */
export function isCoreModelChange(value) {
  if (
    !modelRecord(value) ||
    !revision(value.revision) ||
    !revision(value.occurredAt) ||
    (value.afterTurnId != null && typeof value.afterTurnId !== "string")
  )
    return false;
  return [value.from, value.to].every(
    (identity) =>
      modelRecord(identity) &&
      (identity.providerId === null || typeof identity.providerId === "string") &&
      typeof identity.modelId === "string",
  );
}
/** @param {unknown} value @returns {value is CoreThread} */
export function isCoreThread(value) {
  return (
    modelRecord(value) &&
    typeof value.id === "string" &&
    (value.turns == null || (Array.isArray(value.turns) && value.turns.every(isCoreTurn))) &&
    (value.toolsetRevision === undefined || revision(value.toolsetRevision)) &&
    (value.dynamicTools === undefined || Array.isArray(value.dynamicTools)) &&
    (value.goals === undefined || isCoreGoals(value.goals)) &&
    (value.desktop == null ||
      (modelRecord(value.desktop) &&
        (value.desktop.plan == null || isCorePlan(value.desktop.plan)) &&
        (value.desktop.modelChanges === undefined ||
          (Array.isArray(value.desktop.modelChanges) &&
            value.desktop.modelChanges.every(isCoreModelChange))))) &&
    (value.conversation == null ||
      (modelRecord(value.conversation) &&
        (value.conversation.kind === undefined || typeof value.conversation.kind === "string")))
  );
}
/** @param {unknown} value @returns {CoreQueue} */
export function readCoreQueue(value) {
  if (!isCoreQueue(value)) throw new Error("Invalid Core queue");
  return value;
}
/** @param {unknown} value @returns {CoreTask} */
export function readCoreTask(value) {
  if (!isCoreTask(value)) throw new Error("Invalid Core task");
  return value;
}
