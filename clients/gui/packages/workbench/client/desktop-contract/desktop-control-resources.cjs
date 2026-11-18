// @ts-check
"use strict";

/** @typedef {{allowed:boolean,reasons:Array<{code:string,count:number}>}} LifecycleDecision */
/** @typedef {{ifIdle:LifecycleDecision,settled:LifecycleDecision,admission:string,[key:string]:unknown}} CoreLifecycle */
/** @typedef {{projectId:string,threadId:string,id:string,epoch:string,state:string,executable:string,stale:boolean}} RecoveryResource */
/** @typedef {{id:string,threadId:string,mode:string,objective?:string|null,paused:boolean,nextRunAt?:number|null,running:boolean}} RecoveryTask */
/** @typedef {{threadId:string,status:string,objective?:string|null}} RecoveryGoal */
/** @typedef {{projectId:string,root?:string,serviceId?:string|null,generation?:string|null,observation?:'known'|'unavailable',lifecycle?:CoreLifecycle,restartSafe?:boolean,resources?:RecoveryResource[],activeTurns?:number,unresolvedTools?:number,compactions?:number,workgroups?:number,activeThreads?:Array<{threadId:string,turnId:string}>,goalThreads?:string[],activeTasks?:number,tasks?:RecoveryTask[],goals?:RecoveryGoal[],waitingMessages?:number,queues?:Array<{threadId:string,paused:boolean,pending:number,running:number}>,pendingRequests?:Array<{threadId?:string,creationRequestId?:string,awaitingResponse:boolean}>}} ResourceInspection */
/** @typedef {{clients:number,activeCommands:number,starting:number,providerUpdating:boolean,connected?:boolean,busy?:boolean,stopReport?:unknown,browserCore?:Record<string,string|null>,browserControlEndpoints?:string[],remote?:{enabled?:boolean,connections?:number},lifecycle?:Record<string,unknown>,targets?:Array<{projectId:string,serviceId?:string|null,generation?:string|null}>,[key:string]:unknown}} RecoveryService */
/** @typedef {Record<string,unknown> & {resources?:Array<Record<string,unknown>&{threadId?:unknown}>|null,activeTurns?:Array<{threadId:string,turnId:string}>|null,activeGoals?:string[]|null,activeTasks?:number|null,pendingQueueItems?:number|null,unresolvedTools?:unknown[]|null,compactions?:unknown[]|null,workgroups?:Array<{status?:unknown,cleanupConfirmed?:unknown}>|null,runtime?:{runtimeEpoch?:unknown,epoch?:unknown}|null}} ResourceStatus */
/** @typedef {{id:string,runtimeEpoch:string,state:string,argv:string[],cleanupConfirmed:boolean,[key:string]:unknown}} ResourceProcess */
/** @typedef {{id:string,threadId:string,mode:string,objective?:string|null,paused:boolean,cancelled?:boolean,nextRunAt?:number|null,runs:Array<{status:string}>,[key:string]:unknown}} ResourceTask */

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** @param {unknown} value @returns {value is number} */
function count(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
/** @param {unknown} value @returns {value is string[]} */
function strings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function invalid() {
  return Object.assign(new Error("后台资源观察不完整，请重新核查原后台"), {
    code: "RESOURCE_OBSERVATION_INVALID",
  });
}

/** @param {unknown} value @returns {ResourceStatus} */
function readResourceStatus(value) {
  if (!resourceStatus(value)) throw invalid();
  return value;
}
/** @param {unknown} value @returns {value is ResourceStatus} */
function resourceStatus(value) {
  return (
    record(value) &&
    (value.resources == null ||
      (Array.isArray(value.resources) && value.resources.every(record))) &&
    (value.activeTurns == null ||
      (Array.isArray(value.activeTurns) &&
        value.activeTurns.every(
          (turn) =>
            record(turn) && typeof turn.threadId === "string" && typeof turn.turnId === "string",
        ))) &&
    (value.activeGoals == null || strings(value.activeGoals)) &&
    (value.activeTasks == null || count(value.activeTasks)) &&
    (value.pendingQueueItems == null || count(value.pendingQueueItems)) &&
    (value.unresolvedTools == null || Array.isArray(value.unresolvedTools)) &&
    (value.compactions == null || Array.isArray(value.compactions)) &&
    (value.workgroups == null ||
      (Array.isArray(value.workgroups) && value.workgroups.every(record))) &&
    (value.runtime == null || record(value.runtime))
  );
}
/** @param {unknown} value @returns {{data:ResourceProcess[]}} */
function readResourceProcesses(value) {
  if (!record(value) || !Array.isArray(value.data) || !value.data.every(resourceProcess))
    throw invalid();
  return { ...value, data: value.data };
}
/** @param {unknown} value @returns {value is ResourceProcess} */
function resourceProcess(value) {
  return (
    record(value) &&
    typeof value.id === "string" &&
    typeof value.runtimeEpoch === "string" &&
    typeof value.state === "string" &&
    strings(value.argv) &&
    typeof value.cleanupConfirmed === "boolean"
  );
}
/** @param {unknown} value @returns {{data:ResourceTask[],nextCursor?:string|null}} */
function readResourceTasks(value) {
  if (
    !record(value) ||
    !Array.isArray(value.data) ||
    !value.data.every(resourceTask) ||
    (value.nextCursor != null && typeof value.nextCursor !== "string")
  )
    throw invalid();
  return {
    ...value,
    data: value.data,
    ...(value.nextCursor === undefined ? {} : { nextCursor: value.nextCursor }),
  };
}
/** @param {unknown} value @returns {value is ResourceTask} */
function resourceTask(value) {
  return (
    record(value) &&
    typeof value.id === "string" &&
    typeof value.threadId === "string" &&
    typeof value.mode === "string" &&
    typeof value.paused === "boolean" &&
    (value.cancelled === undefined || typeof value.cancelled === "boolean") &&
    (value.objective == null || typeof value.objective === "string") &&
    Array.isArray(value.runs) &&
    value.runs.every((run) => record(run) && typeof run.status === "string")
  );
}
/** @param {unknown} value @returns {{goal:null|{status:string,objective?:string|null}}} */
function readResourceGoal(value) {
  if (!record(value)) throw invalid();
  const goal = value.goal;
  if (goal === null) return { goal };
  if (
    !record(goal) ||
    typeof goal.status !== "string" ||
    (goal.objective != null && typeof goal.objective !== "string")
  )
    throw invalid();
  return {
    goal: {
      status: goal.status,
      ...(goal.objective === undefined ? {} : { objective: goal.objective }),
    },
  };
}

/** Service transport response for the existing resources inspection operation. */
/** @param {unknown} value @returns {ResourceInspection[]} */
function readResourceInspections(value) {
  if (!Array.isArray(value) || !value.every(resourceInspection)) throw invalid();
  return value;
}
/** @param {unknown} value @returns {value is ResourceInspection} */
function resourceInspection(value) {
  if (
    !record(value) ||
    typeof value.projectId !== "string" ||
    (value.root !== undefined && typeof value.root !== "string") ||
    (value.serviceId != null && typeof value.serviceId !== "string") ||
    (value.generation != null && typeof value.generation !== "string") ||
    (value.observation !== undefined &&
      value.observation !== "known" &&
      value.observation !== "unavailable") ||
    (value.restartSafe !== undefined && typeof value.restartSafe !== "boolean") ||
    [
      "activeTurns",
      "unresolvedTools",
      "compactions",
      "workgroups",
      "activeTasks",
      "waitingMessages",
    ].some((key) => value[key] !== undefined && !count(value[key])) ||
    (value.goalThreads !== undefined && !strings(value.goalThreads))
  )
    return false;
  if (
    value.lifecycle !== undefined &&
    (!record(value.lifecycle) ||
      !lifecycleDecision(value.lifecycle.ifIdle) ||
      !lifecycleDecision(value.lifecycle.settled) ||
      typeof value.lifecycle.admission !== "string")
  )
    return false;
  if (
    value.resources !== undefined &&
    (!Array.isArray(value.resources) ||
      !value.resources.every(
        (resource) =>
          record(resource) &&
          ["projectId", "threadId", "id", "epoch", "state", "executable"].every(
            (key) => typeof resource[key] === "string",
          ) &&
          typeof resource.stale === "boolean",
      ))
  )
    return false;
  if (
    value.tasks !== undefined &&
    (!Array.isArray(value.tasks) ||
      !value.tasks.every(
        (task) =>
          record(task) &&
          ["id", "threadId", "mode"].every((key) => typeof task[key] === "string") &&
          (task.objective == null || typeof task.objective === "string") &&
          (task.nextRunAt == null || typeof task.nextRunAt === "number") &&
          typeof task.paused === "boolean" &&
          typeof task.running === "boolean",
      ))
  )
    return false;
  if (
    value.goals !== undefined &&
    (!Array.isArray(value.goals) ||
      !value.goals.every(
        (goal) =>
          record(goal) &&
          typeof goal.threadId === "string" &&
          typeof goal.status === "string" &&
          (goal.objective == null || typeof goal.objective === "string"),
      ))
  )
    return false;
  if (
    value.activeThreads !== undefined &&
    (!Array.isArray(value.activeThreads) ||
      !value.activeThreads.every(
        (turn) =>
          record(turn) && typeof turn.threadId === "string" && typeof turn.turnId === "string",
      ))
  )
    return false;
  if (
    value.queues !== undefined &&
    (!Array.isArray(value.queues) ||
      !value.queues.every(
        (queue) =>
          record(queue) &&
          typeof queue.threadId === "string" &&
          typeof queue.paused === "boolean" &&
          count(queue.pending) &&
          count(queue.running),
      ))
  )
    return false;
  return (
    value.pendingRequests === undefined ||
    (Array.isArray(value.pendingRequests) &&
      value.pendingRequests.every(
        (request) =>
          record(request) &&
          (request.threadId === undefined || typeof request.threadId === "string") &&
          (request.creationRequestId === undefined ||
            (request.threadId === undefined &&
              typeof request.creationRequestId === "string" &&
              /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
                request.creationRequestId,
              ))) &&
          typeof request.awaitingResponse === "boolean",
      ))
  );
}
/** @param {unknown} value @returns {value is LifecycleDecision} */
function lifecycleDecision(value) {
  return (
    record(value) &&
    typeof value.allowed === "boolean" &&
    Array.isArray(value.reasons) &&
    value.reasons.every(
      (reason) => record(reason) && typeof reason.code === "string" && count(reason.count),
    )
  );
}
/** @param {unknown} value @returns {RecoveryService} */
function readRecoveryService(value) {
  if (!recoveryService(value)) throw invalid();
  return value;
}
/** @param {unknown} value @returns {value is RecoveryService} */
function recoveryService(value) {
  return (
    record(value) &&
    count(value.clients) &&
    count(value.activeCommands) &&
    count(value.starting) &&
    typeof value.providerUpdating === "boolean" &&
    (value.browserCore === undefined ||
      (record(value.browserCore) &&
        Object.values(value.browserCore).every(
          (item) => item === null || typeof item === "string",
        ))) &&
    (value.browserControlEndpoints === undefined || strings(value.browserControlEndpoints)) &&
    (value.connected === undefined || typeof value.connected === "boolean") &&
    (value.busy === undefined || typeof value.busy === "boolean") &&
    (value.lifecycle === undefined || record(value.lifecycle)) &&
    (value.remote === undefined ||
      (record(value.remote) &&
        (value.remote.enabled === undefined || typeof value.remote.enabled === "boolean") &&
        (value.remote.connections === undefined || count(value.remote.connections)))) &&
    (value.targets === undefined ||
      (Array.isArray(value.targets) &&
        value.targets.every(
          (target) =>
            record(target) &&
            typeof target.projectId === "string" &&
            (target.serviceId == null || typeof target.serviceId === "string") &&
            (target.generation == null || typeof target.generation === "string"),
        )))
  );
}

/** The model intentionally leaves queue payload extensions opaque. Count only its observed status field. */
/** @param {unknown[]} values */
function readQueueCounts(values) {
  const items = values.map((value) => {
    if (!record(value)) throw invalid();
    return value;
  });
  return {
    pending: items.filter((item) => item.status === "pending").length,
    running: items.filter((item) => item.status === "running").length,
  };
}

module.exports = {
  resourceInspection,
  lifecycleDecision,
  readQueueCounts,
  readResourceStatus,
  readResourceProcesses,
  readResourceTasks,
  readResourceGoal,
  readResourceInspections,
  readRecoveryService,
};
