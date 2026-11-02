// @ts-check
"use strict";

const { readResourceInspections, readRecoveryService } = require("./resource-observation.cjs");
/** @typedef {import('./resource-observation.cjs').LifecycleDecision} Decision */
/** @typedef {import('./resource-observation.cjs').CoreLifecycle} CoreLifecycle */
/** @typedef {import('./resource-observation.cjs').ResourceInspection} Inspection */
/** @typedef {import('./resource-observation.cjs').RecoveryService} Service */
/** @typedef {ReturnType<typeof recoveryView> & {targets:ReturnType<typeof targets>,purpose:string,confirmedImpact?:boolean}} RecoveryObservation */
/** @type {Record<string,string>} */
const labels = {
  activeTurn: "活动轮次",
  resource: "未清理终端",
  uninspectedUnknown: "未核查结果",
  compaction: "上下文压缩",
  workgroup: "未结算工作组",
  activeGoal: "活动目标",
  queuedMessage: "待发消息",
  activeTask: "活动任务",
};
/** @returns {Decision} */
const unknown = () => ({ allowed: false, reasons: [{ code: "unknown", count: 1 }] });
const recoveryReads = new Set([
  "server",
  "inspect",
  "context",
  "plan",
  "processes",
  "process",
  "processOutput",
  "goal",
  "task",
  "tasks",
  "interactions",
  "executions",
  "execution",
  "inheritedHistory",
]);
const recoveryHistoryReads = new Set(["acquire", "loadOlder", "loadItem", "release"]);
/** @param {string} name @param {Record<string,unknown>|undefined} request */
const isRecoveryCommand = (name, request) =>
  (name === "manage" &&
    ((typeof request?.operation === "string" && recoveryReads.has(request.operation)) ||
      request?.operation === "toolAcknowledge")) ||
  (name === "history" &&
    typeof request?.operation === "string" &&
    recoveryHistoryReads.has(request.operation));
/** @param {unknown} value @returns {Decision} */
function decision(value) {
  if (
    !record(value) ||
    typeof value.allowed !== "boolean" ||
    !Array.isArray(value.reasons) ||
    !value.reasons.every(reason) ||
    value.allowed !== (value.reasons.length === 0)
  )
    return unknown();
  return { allowed: value.allowed, reasons: value.reasons };
}
/** @param {unknown} status @returns {CoreLifecycle} */
function coreLifecycle(status) {
  if (!record(status)) return { ifIdle: unknown(), settled: unknown(), admission: "unknown" };
  if (status.lifecycle !== undefined) {
    if (
      !record(status.lifecycle) ||
      status.lifecycle.version !== 1 ||
      typeof status.lifecycle.admission !== "string" ||
      !["open", "draining", "closed"].includes(status.lifecycle.admission)
    )
      return { ifIdle: unknown(), settled: unknown(), admission: "unknown" };
    return {
      ...status.lifecycle,
      admission: status.lifecycle.admission,
      ifIdle: decision(status.lifecycle.ifIdle),
      settled: decision(status.lifecycle.settled),
    };
  }
  // 已知 v1 Core 的旧字段；缺字段不能被当成空闲。
  const settled = status.restartSafe === true ? { allowed: true, reasons: [] } : unknown();
  if (
    typeof status.restartSafe !== "boolean" ||
    !Array.isArray(status.activeGoals) ||
    typeof status.pendingQueueItems !== "number" ||
    !Number.isSafeInteger(status.pendingQueueItems) ||
    status.pendingQueueItems < 0 ||
    typeof status.activeTasks !== "number" ||
    !Number.isSafeInteger(status.activeTasks) ||
    status.activeTasks < 0
  )
    return { ifIdle: unknown(), settled, admission: "unknown" };
  const reasons = [...settled.reasons];
  /** @type {Array<[string,number]>} */
  const counts = [
    ["activeGoal", status.activeGoals.length],
    ["queuedMessage", status.pendingQueueItems],
    ["activeTask", status.activeTasks],
  ];
  for (const [code, count] of counts) if (count > 0) reasons.push({ code, count });
  return {
    ifIdle: { allowed: reasons.length === 0, reasons },
    settled,
    admission: status.draining === true ? "draining" : status.closed === true ? "closed" : "open",
  };
}
/** @param {Pick<Service,'clients'|'activeCommands'|'starting'> & {providerUpdating?:boolean}} service @param {boolean} [forUpdate] */
function desktopBlockers(service, forUpdate = true) {
  return [
    forUpdate && service.clients > 1 && "peerGui",
    service.activeCommands > 0 && "inflight",
    service.providerUpdating && "providerUpdating",
    service.starting > 0 && "starting",
  ].filter(/** @returns {blocker is string} */ (blocker) => typeof blocker === "string");
}
/** @param {string[]} blockers */
const blockerMessage = (blockers) =>
  blockers
    .map(
      (code) =>
        /** @type {Record<string,string>} */ ({
          peerGui: "请先退出其他 GUI",
          inflight: "请等待已提交操作完成",
          providerUpdating: "请等待模型配置更新完成",
          starting: "请等待项目启动完成",
        })[code] ?? "请等待后台状态核对",
    )
    .join("；");
/** @param {Service} service @param {Inspection[]} projects @param {boolean} [forUpdate] */
function recoveryView(service, projects, forUpdate = true) {
  const blockers = desktopBlockers(service, forUpdate);
  const unsafe =
    projects.some(
      (p) =>
        p.observation === "unavailable" ||
        (p.lifecycle
          ? !p.lifecycle.ifIdle.allowed
          : !p.restartSafe || p.activeTasks || p.goalThreads?.length || p.waitingMessages),
    ) ||
    projects.some((p) => p.tasks?.some((task) => !task.paused)) ||
    service.remote?.enabled === true ||
    (service.remote?.connections ?? 0) > 0;
  const legacyBusy = service.lifecycle?.version !== 2 && (service.busy || !!service.stopReport);
  return {
    blockers,
    ifIdle: !blockers.length && !unsafe && !legacyBusy,
    cancel: !blockers.length && (unsafe || legacyBusy),
    projects,
    service,
  };
}
/** @param {Array<{projectId:string,serviceId?:string|null,generation?:string|null}>} projects */
function targets(projects) {
  return projects
    .map((p) => ({
      projectId: p.projectId,
      serviceId: p.serviceId ?? null,
      generation: p.generation ?? null,
    }))
    .sort((a, b) => a.projectId.localeCompare(b.projectId));
}
/** @param {Array<Pick<Inspection,'lifecycle'|'root'> & {projectId?:string}>} projects */
function describe(projects) {
  return projects
    .flatMap((p) =>
      (p.lifecycle?.ifIdle.reasons ?? []).map(
        (r) => `${p.root ?? p.projectId}：${labels[r.code] ?? "状态待核查"} ${r.count}`,
      ),
    )
    .join("\n");
}
/** @overload @param {undefined} service @param {unknown} kind @returns {never} */
/** @overload @param {unknown} service @param {unknown} kind @returns {Record<string,unknown> & {desktopGeneration:string}} */
/** @param {unknown} service @param {unknown} kind */
function assertLifecycleSupport(service, kind) {
  const lifecycle = record(service) ? service.lifecycle : undefined;
  if (!supportedLifecycle(lifecycle, kind)) {
    throw Object.assign(
      new Error("当前后台不支持可核查的生命周期操作。已有任务继续运行，请保留后台并检查原任务。"),
      { code: "LIFECYCLE_UNSUPPORTED" },
    );
  }
  return lifecycle;
}
/** @param {unknown} lifecycle @param {unknown} kind @returns {lifecycle is Record<string,unknown> & {desktopGeneration:string}} */
function supportedLifecycle(lifecycle, kind) {
  if (
    !record(lifecycle) ||
    lifecycle.version !== 2 ||
    typeof lifecycle.desktopGeneration !== "string"
  )
    return false;
  const capabilities = lifecycle.capabilities;
  return (
    record(capabilities) &&
    capabilities.request === true &&
    capabilities.read === true &&
    capabilities.reconcile === true &&
    (!Array.isArray(capabilities.kinds) || capabilities.kinds.includes(kind))
  );
}
class DesktopLifecycle {
  /** @param {{connection:InstanceType<typeof import('./service-connection.cjs').ServiceConnection>,metadata?:InstanceType<typeof import('./service-client.cjs').SharedCoreBackend>['metadata'],home:string,forUpdate?:boolean,purpose?:string}} options */
  constructor({ connection, metadata, home, forUpdate = true, purpose = "manage" }) {
    this.connection = connection;
    this.metadata = metadata;
    this.home = home;
    this.forUpdate = forUpdate;
    this.purpose = purpose;
  }
  /** @returns {Promise<RecoveryObservation>} */
  async observe() {
    const projects = readResourceInspections(
      await this.connection.request("resources", {
        operation: "inspect",
        includeTasks: true,
        ...(this.purpose === "quit" ? { purpose: "quit" } : {}),
      }),
    );
    const packet = await this.connection.request("snapshot");
    if (!record(packet)) throw new Error("后台服务观察无效");
    const service = readRecoveryService(packet.service);
    return {
      ...recoveryView(service, projects, this.forUpdate),
      targets: targets(service.targets ?? projects),
      purpose: this.purpose,
    };
  }
  /** @param {{mode?:string,observed?:RecoveryObservation}} [options] */
  async stop({ mode = "ifIdle", observed } = {}) {
    const { SharedCoreBackend } = require("./service-client.cjs");
    const backend = new SharedCoreBackend({ app: { getPath: () => this.home }, home: this.home });
    backend.connection = this.connection;
    backend.metadata = this.metadata;
    backend.status = (observed ?? (await this.observe())).service;
    backend.loadReferences(await backend.readControl());
    return backend.stopService(this.forUpdate, { cancel: mode === "cancel", observed });
  }
  /** @param {{kind?:import('./lifecycle-operations.cjs').LifecycleKind,mode?:string,observed?:RecoveryObservation,projectId?:string,threadId?:string,turnId?:string}} [options] */
  async prepare({ kind, mode = "ifIdle", observed, projectId, threadId, turnId } = {}) {
    if (!["ifIdle", "cancel"].includes(mode)) throw new Error("无效的停止意图");
    if (kind === "interruptTurn") {
      const packet = await this.connection.request("snapshot");
      if (!record(packet)) throw new Error("后台服务观察无效");
      const service = readRecoveryService(packet.service);
      const snapshot = packet.snapshot;
      const capability = assertLifecycleSupport(service, kind);
      const project =
        record(snapshot) && Array.isArray(snapshot.projects)
          ? snapshot.projects.find((value) => record(value) && value.id === projectId)
          : undefined;
      const threads =
        record(project) && record(project.state) && record(project.state.threads)
          ? project.state.threads
          : undefined;
      const candidate = threads && threadId ? threads[threadId] : undefined;
      const thread = record(candidate) ? candidate : undefined;
      const executionProjectId = thread?.executionProjectId ?? projectId;
      const executionCore = record(thread?.executionCore) ? thread.executionCore : undefined;
      const expectedTargets = targets(service.targets ?? []).filter(
        (target) => target.projectId === executionProjectId,
      );
      if (
        expectedTargets.length !== 1 ||
        (executionCore?.instanceId && executionCore.instanceId !== expectedTargets[0].serviceId)
      )
        throw Object.assign(new Error("原项目后台身份不完整，请重新核查"), {
          code: "CONFIRMATION_STALE",
        });
      return {
        kind,
        mode,
        expectedDesktopGeneration: capability.desktopGeneration,
        expectedTargets,
        threadId,
        turnId,
      };
    }
    const before = observed ?? (await this.observe());
    const capability = assertLifecycleSupport(before.service, kind);
    if (before.blockers.length)
      throw Object.assign(new Error(blockerMessage(before.blockers)), {
        code: "LIFECYCLE_BLOCKED",
      });
    const current = await this.observe();
    const latest = assertLifecycleSupport(current.service, kind);
    if (
      capability.desktopGeneration !== latest.desktopGeneration ||
      !require("node:util").isDeepStrictEqual(before.targets, current.targets)
    )
      throw Object.assign(new Error("后台实例或项目范围已变化，请重新确认"), {
        code: "CONFIRMATION_STALE",
      });
    if (current.blockers.length)
      throw Object.assign(new Error(blockerMessage(current.blockers)), {
        code: "LIFECYCLE_BLOCKED",
      });
    if (mode === "cancel" || before.confirmedImpact || this.purpose === "quit") {
      /** @param {RecoveryObservation} value */
      const impact = (value) => ({
        remote: value.service.remote,
        projects: value.projects
          .map((project) =>
            project.observation === "unavailable"
              ? {
                  projectId: project.projectId,
                  serviceId: project.serviceId,
                  generation: project.generation,
                  observation: "unavailable",
                }
              : {
                  observation: "known",
                  projectId: project.projectId,
                  lifecycle: project.lifecycle,
                  activeThreads: project.activeThreads,
                  goals: project.goals,
                  tasks: project.tasks,
                  resources: project.resources,
                  queues: project.queues,
                  pendingRequests: project.pendingRequests,
                },
          )
          .sort((left, right) => left.projectId.localeCompare(right.projectId)),
      });
      if (!require("node:util").isDeepStrictEqual(impact(before), impact(current)))
        throw Object.assign(new Error("退出影响已变化，请重新确认当前任务"), {
          code: "CONFIRMATION_STALE",
        });
    }
    const expectedTargets = projectId
      ? current.targets.filter((target) => target.projectId === projectId)
      : current.targets;
    if (projectId && expectedTargets.length !== 1)
      throw Object.assign(new Error("原项目后台身份不完整，请重新核查"), {
        code: "CONFIRMATION_STALE",
      });
    return { kind, mode, expectedDesktopGeneration: latest.desktopGeneration, expectedTargets };
  }
}
/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** @param {unknown} value @returns {value is {code:string,count:number}} */
function reason(value) {
  return (
    record(value) &&
    typeof value.code === "string" &&
    Object.hasOwn(labels, value.code) &&
    typeof value.count === "number" &&
    Number.isSafeInteger(value.count) &&
    value.count > 0
  );
}

module.exports = {
  coreLifecycle,
  desktopBlockers,
  blockerMessage,
  recoveryView,
  targets,
  describe,
  DesktopLifecycle,
  isRecoveryCommand,
  assertLifecycleSupport,
};
