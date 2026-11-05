// @ts-check
"use strict";
const shared = require("@areal/workbench-service/desktop/core/lifecycle.cjs");
const { recoveryView, targets, assertLifecycleSupport, blockerMessage } = shared;
const { readResourceInspections, readRecoveryService } = require("@areal/workbench-service/desktop/core/resource-observation.cjs");
const { modelRecord: record } = require("@areal/workbench/core-model-contract");
/** @typedef {import('@areal/workbench-service/desktop/core/lifecycle.cjs').RecoveryObservation} RecoveryObservation */
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
  /** @param {{kind?:import('@areal/workbench-service/desktop/core/lifecycle-operations.cjs').LifecycleKind,mode?:string,observed?:RecoveryObservation,projectId?:string,threadId?:string,turnId?:string}} [options] */
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
module.exports = { ...shared, DesktopLifecycle };
