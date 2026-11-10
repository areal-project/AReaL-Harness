// @ts-check
"use strict";
const diagnostics = require("./diagnostics.cjs");
const { startupTrace } = require("./startup-timing.cjs");
const { failure: browserFailure } = require("./browser-tool.cjs");
const { modelRecord, isCoreTask } = require("@areal/workbench/core-model-contract");

/** @typedef {import('./project-state.cjs').CoreProject} Project */
/** @typedef {import('@areal/runtime-client/core').CoreClient} Client */
/** @typedef {{project:Project,client:Client|null|undefined,generation:number}} ReadConnection */
/** @typedef {(error:unknown,connection?:ReadConnection)=>void} ReadWaiter */
/** @typedef {import('./local-service.cjs').RecoveryTarget} Service */
/** @typedef {Awaited<ReturnType<typeof import('./local-service.cjs').connectService>>} ServiceConnection */
/** @typedef {Awaited<ReturnType<InstanceType<typeof import('./backend.cjs').CoreBackend>['prepareServiceLaunch']>>} Launch */
/** @typedef {Pick<InstanceType<typeof import('./backend.cjs').CoreBackend>,'applicationOwner'|'worktrees'|'lifecycleOperations'|'providers'|'resources'|'scheduleAdmission'|'hooks'|'defaultProfile'|'analytics'|'saved'|'hostCall'|'hostCoreClients'|'host'> & {
 * closing:boolean,providerUpdating:boolean|undefined,resourcesUpdating:boolean|undefined,
 * starting:Map<string,Promise<Project>>,projects:Map<string,Project>,
 * startProject:(id:string,options?:{resumeScheduling?:boolean})=>Promise<Project>,stopReconciliation:(project:Project)=>void,
 * scheduleReconciliation:(project:Project)=>void,onChange:()=>void,
 * connectExisting:(project:Project,service:Service)=>Promise<ServiceConnection>,
 * prepareServiceLaunch:(project:Project,trace:ReturnType<typeof startupTrace>)=>Promise<Launch>,
 * reconcile:(project:Project,options:{observeOnly:boolean})=>Promise<unknown>,
 * desktopToolOwner:()=>object|null,desktopTools:(project:Project)=>unknown[],supportsBrowser:(project:Project)=>boolean|undefined,supportsComputer:(project:Project)=>boolean|undefined,
 * cuaRead:(request:Record<string,unknown>)=>Promise<unknown>|undefined,computerRead:(request:Record<string,unknown>)=>Promise<unknown>|undefined,browserRead?:(request:Record<string,unknown>)=>Promise<unknown>|undefined,
 * observeNotification:(project:Project,client:Client,method:string,params:unknown)=>void,onMcpPageToolsDisconnected?:(client:Client)=>void,
 * listThreads:(project:Project)=>Promise<unknown>,openThread:(project:Project,threadId:string)=>Promise<unknown>,startTaskMonitor:(project:Project,client:Client)=>Promise<void>
 * }} ConnectionHost */

// Owns observer connection identity, read waiters and reconnect scheduling.
// Deployment and feature initialization use explicit host ports; no mutation replay.
class ProjectConnections {
  /** @param {ConnectionHost} host */
  constructor(host) {
    this.host = host;
    /** @type {WeakMap<Promise<Project>,Set<ReadWaiter>>} */
    this.readWaiters = new WeakMap();
    /** @type {Map<string,string>} */
    this.selectedThreads = new Map();
    /** @type {WeakMap<Client,object>} */
    this.desktopOwners = new WeakMap();
  }

  /** @param {Project} project @param {Client|null|undefined} client */
  claimDesktopToolHost(project, client) {
    this.requireConnection(project, client);
    const owner = this.host.desktopToolOwner?.();
    if (!owner) throw new Error("Desktop tool host is unavailable");
    this.desktopOwners.set(client, owner);
    return owner;
  }

  /** @param {Project} project @param {Client|null|undefined} client @param {object|null|undefined} [owner] */
  currentDesktopToolHost(project, client, owner = client && this.desktopOwners.get(client)) {
    return (
      !!owner &&
      this.host.desktopToolOwner?.() === owner &&
      this.currentConnection(project, client) &&
      this.desktopOwners.get(client) === owner
    );
  }

  /** @param {Project} project @param {Client|null|undefined} client @param {object|null} owner */
  async publishScheduleTools(project, client, owner) {
    if (
      !client ||
      !this.currentDesktopToolHost(project, client, owner) ||
      !client.capabilities?.methods?.includes("areal/task/tools/ready")
    )
      return;
    const bundles = this.host.providers.manages(project)
      ? this.host
          .desktopTools(project)
          .flatMap((tool) =>
            !modelRecord(tool)
              ? []
              : tool.name === "browser_v1"
                ? ["areal.browser.v1"]
                : tool.name === "computer_v1"
                  ? ["areal.computer.v1"]
                  : [],
          )
      : [];
    await client.request("areal/task/tools/ready", { bundles });
    this.requireConnection(project, client);
  }

  /** @param {object|null} owner */
  revokeDesktopToolHost(owner) {
    for (const project of this.host.projects.values()) {
      const client = project.client;
      if (client && (this.desktopOwners.get(client) ?? null) === owner) client.close();
    }
  }

  /** @param {string} id @param {{threadId?:string,resumeScheduling?:boolean}} [options] @returns {Promise<Project>} */
  start(id, { threadId, resumeScheduling = false } = {}) {
    if (threadId) this.selectedThreads.set(id, threadId);
    try {
      this.host.worktrees?.assertAvailable(id);
      this.host.lifecycleOperations.assertProject(id);
      if (!resumeScheduling && this.host.lifecycleOperations.schedulingSuppressed(id))
        throw Object.assign(new Error("后台已由用户停止，请明确启动后继续"), {
          code: "CORE_STOPPED",
        });
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.host.closing) return Promise.reject(new Error("应用正在退出"));
    const starting = this.host.starting.get(id);
    if (starting)
      return resumeScheduling
        ? starting.then(() => this.host.startProject(id, { resumeScheduling: true }))
        : starting;
    const project = this.host.projects.get(id);
    if (project) {
      clearTimeout(project.reconnectTimer ?? undefined);
      project.reconnectTimer = null;
      project.reconnectBlocked = false;
    }
    const task = this.host
      .startProject(id, { resumeScheduling })
      .finally(() => this.host.starting.delete(id));
    this.host.starting.set(id, task);
    return task;
  }

  /** @param {string} id @param {AbortSignal} [signal] @returns {Promise<ReadConnection & {client:Client}>} */
  readConnection(id, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const startup = this.start(id);
    /** @type {Set<ReadWaiter>} */
    const waiters = this.readWaiters.get(startup) ?? new Set();
    if (!this.readWaiters.has(startup)) {
      this.readWaiters.set(startup, waiters);
      startup.then(
        (project) =>
          this.settleReadWaiters(startup, null, {
            project,
            client: project.client,
            generation: project.connectionGeneration ?? 0,
          }),
        (error) => this.settleReadWaiters(startup, error),
      );
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      /** @type {ReadWaiter} */
      const settle = (error, connection) => {
        if (settled) return;
        settled = true;
        waiters.delete(settle);
        signal?.removeEventListener("abort", abort);
        try {
          if (error) throw error;
          if (!connection) throw new Error("连接尚未就绪");
          this.host.lifecycleOperations.assertProject(id);
          const { project, client, generation } = connection;
          if (
            !this.host.saved.some((saved) => saved.id === id) ||
            this.host.projects.get(id) !== project
          )
            throw new Error("任务所有者已移除");
          this.requireConnection(project, client);
          if (!client.ready || (project.connectionGeneration ?? 0) !== generation)
            throw Object.assign(new Error("连接已换代，请重试"), { code: "STALE_CONNECTION" });
          resolve({ ...connection, client });
        } catch (failure) {
          reject(failure);
        }
      };
      const abort = () => settle(signal?.reason);
      waiters.add(settle);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      const project = this.host.projects.get(id);
      if (project?.client?.ready)
        settle(null, {
          project,
          client: project.client,
          generation: project.connectionGeneration ?? 0,
        });
    });
  }

  /** @param {Promise<Project>} startup @param {unknown} error @param {ReadConnection} [connection] */
  settleReadWaiters(startup, error, connection) {
    for (const settle of this.readWaiters.get(startup) ?? []) settle(error, connection);
  }

  /** @param {import('./project-state.cjs').CoreProject} project @param {import('@areal/runtime-client/core').CoreClient|null|undefined} client @returns {client is import('@areal/runtime-client/core').CoreClient} */
  currentConnection(project, client) {
    return !this.host.closing && !!client && project.client === client && !client.closed;
  }

  /** @param {Project} project @param {Client|null|undefined} client @returns {asserts client is Client} */
  requireConnection(project, client) {
    if (!this.currentConnection(project, client))
      throw Object.assign(new Error("连接已换代，请等待状态恢复后重试"), {
        code: "STALE_CONNECTION",
      });
  }

  /** @param {Project} project */
  scheduleReconnect(project) {
    try {
      this.host.worktrees?.assertAvailable(project.id);
    } catch {
      return;
    }
    if (
      this.host.closing ||
      project.resourceInitializing ||
      !project.service ||
      project.reconnectBlocked ||
      project.reconnectTimer ||
      project.client?.ready
    )
      return;
    const delay = project.reconnectAttempt
      ? Math.min(500 * 2 ** Math.min(project.reconnectAttempt, 6), 30000)
      : 0;
    project.reconnectTimer = setTimeout(() => {
      project.reconnectTimer = null;
      if (
        this.host.closing ||
        !project.service ||
        project.reconnectBlocked ||
        project.client?.ready
      )
        return;
      if (
        this.host.providerUpdating ||
        this.host.resourcesUpdating ||
        this.host.starting.has(project.id)
      ) {
        this.scheduleReconnect(project);
        return;
      }
      const task = this.reconnectProject(project)
        .catch(
          /** @param {unknown} error */ (error) => {
            if (!this.host.closing) {
              project.reconnectBlocked =
                [
                  "CORE_STOPPED",
                  "CORE_INCOMPATIBLE",
                  "CORE_RECOVERY_EXHAUSTED",
                  "LIFECYCLE_INCOMPLETE",
                  "LIFECYCLE_EXIT_REQUESTED",
                  "RESPONSE_TOO_LARGE",
                ].includes(modelRecord(error) ? String(error.code) : "") ||
                (modelRecord(error) && error.reason === "RESPONSE_TOO_LARGE") ||
                project.client?.closeFailure?.code === "RESPONSE_TOO_LARGE";
              project.reconnectAttempt = (project.reconnectAttempt ?? 0) + 1;
              this.host.stopReconciliation(project);
              project.client?.close();
              project.error = this.host.providers.redact(
                error instanceof Error ? error.message : String(error),
              );
              project.model.connection(false, project.error);
            }
            throw error;
          },
        )
        .finally(() => {
          if (this.host.starting.get(project.id) === task) this.host.starting.delete(project.id);
          this.scheduleReconnect(project);
        });
      this.host.starting.set(project.id, task);
      // 用户操作可以加入同一恢复任务；无订阅者的被动失败也必须被接收。
      void task.catch(() => {});
    }, delay);
    project.reconnectTimer.unref();
  }

  /** @param {Project} project */
  async reconnectProject(project) {
    return diagnostics.withOperation(
      "reconnect",
      { projectId: project.id, coreGeneration: project.service?.generation },
      () => this.reconnectProjectObserved(project),
      () => "unknown",
    );
  }

  /** @param {Project} project */
  async reconnectProjectObserved(project) {
    const previous = project.service,
      previousClient = project.client;
    if (!previous) throw Object.assign(new Error("Core 服务尚未就绪"), { code: "CORE_STOPPED" });
    const current = () => {
      this.host.worktrees?.assertAvailable(project.id);
      this.host.lifecycleOperations.assertProject(project.id);
      if (
        this.host.closing ||
        this.host.projects.get(project.id) !== project ||
        project.service !== previous ||
        project.client !== previousClient
      )
        throw Object.assign(new Error("服务归属已变化"), { code: "STALE_CONNECTION" });
    };
    current();
    const connection = await this.host.connectExisting(project, previous);
    current();
    const { descriptor, token } = connection;
    if (
      descriptor.serviceId !== previous.serviceId ||
      descriptor.configFingerprint !== previous.configFingerprint
    )
      throw Object.assign(new Error("Core 部署配置已变化，请显式重新连接"), {
        code: "CORE_INCOMPATIBLE",
      });
    project.service = descriptor;
    project.endpoint = descriptor.endpoint;
    project.token = token;
    await this.connect(project, { observeOnly: true });
    await this.host.reconcile(project, { observeOnly: true });
    project.reconnectAttempt = 0;
    return project;
  }

  /** @param {Project} project @param {{observeOnly?:boolean}} [options] */
  async connect(project, { observeOnly = false } = {}) {
    const startup = this.host.starting.get(project.id);
    const owner = this.host.desktopToolOwner?.() ?? null;
    if (this.host.closing) throw new Error("应用正在退出");
    if ((this.host.desktopToolOwner?.() ?? null) !== owner)
      throw new Error("Desktop tool owner changed during connection startup");
    project.taskNotificationMonitor?.stop();
    const previous = project.client;
    this.host.stopReconciliation(project);
    project.client = null;
    previous?.close();
    project.summariesLoaded = false;
    const cuaOwner = {
      projectId: project.id,
      coreInstanceId: project.service?.serviceId,
      coreGeneration: project.service?.generation,
    };
    /** @type {unknown} */
    let cuaHostGeneration;
    if (!this.host.hostCall) throw new Error("Host Core transport unavailable");
    /** @type {Pick<ConstructorParameters<typeof import('@areal/runtime-client/core').CoreClient>[0],'onServerRequest'>} */
    const connectionOptions = {
      onServerRequest: async (method, params, context) => {
        if (!modelRecord(params)) throw new Error("Invalid Core tool host request");
        if (
          method === "areal/cua/turnEnded" ||
          (method === "item/tool/call" && ["js", "js_reset"].includes(String(params.tool)))
        ) {
          this.requireConnection(project, client);
          if (!this.currentDesktopToolHost(project, client))
            throw new Error("Desktop tool host is unavailable");
          cuaHostGeneration = params.hostGeneration;
          const result = await this.host.cuaRead({
            ...params,
            projectId: project.id,
            cwd: project.root,
            toolHostGeneration: params.hostGeneration,
            coreInstanceId: project.service?.serviceId,
            coreGeneration: project.service?.generation,
            signal: context.signal,
            phase: method === "areal/cua/turnEnded" ? "endTurn" : "call",
          });
          return method === "areal/cua/turnEnded"
            ? result
            : {
                success: !modelRecord(result) || result.isError !== true,
                contentItems: [],
                rawMcpResult: result,
              };
        }
        if (
          params?.tool === "computer_v1" &&
          ["item/tool/call", "areal/computer/prepare"].includes(method)
        ) {
          this.requireConnection(project, client);
          if (!this.currentDesktopToolHost(project, client))
            throw new Error("Desktop tool host is unavailable");
          if (!this.host.supportsComputer(project))
            throw new Error("Computer tool capability unavailable");
          return this.host.computerRead({
            projectId: project.id,
            threadId: params.threadId,
            turnId: params.turnId,
            callId: params.callId,
            toolHostGeneration: params.hostGeneration,
            arguments: params.arguments,
            computerApproval: params.computerApproval,
            discardPreparedPlan:
              method === "areal/computer/prepare" && params.discardPreparedPlan === true,
            phase: method === "areal/computer/prepare" ? "prepare" : "execute",
            coreInstanceId: project.service?.serviceId,
            coreGeneration: project.service?.generation,
            signal: context.signal,
          });
        }
        if (
          !["item/tool/call", "areal/browser/prepare"].includes(method) ||
          params?.tool !== "browser_v1"
        )
          throw new Error("Unsupported client tool");
        const connected = this.currentDesktopToolHost(project, client);
        // Core invokes only tools bound to this connection. The local Thread
        // projection can lag the committed attachment until its event arrives.
        const result = connected
          ? ((await this.host.browserRead?.({
              projectId: project.logicalProjectId ?? project.id,
              threadId: params.threadId,
              turnId: params.turnId,
              callId: params.callId,
              toolHostGeneration: params.hostGeneration,
              arguments: params.arguments,
              phase: method === "areal/browser/prepare" ? "prepare" : "execute",
              browserApproval: params.browserApproval,
              coreInstanceId: project.service?.serviceId,
              coreGeneration: project.service?.generation,
              signal: context.signal,
            })) ?? browserFailure("host_unavailable", "Desktop browser is unavailable"))
          : browserFailure("host_unavailable", "Desktop connection changed");
        if (
          method === "areal/browser/prepare" &&
          modelRecord(result) &&
          result.success === false &&
          modelRecord(result.structuredContent) &&
          typeof result.structuredContent.code === "string" &&
          result.structuredContent.dispatch === "not_sent"
        )
          return { error: result.structuredContent.code, dispatch: "not_sent" };
        return result;
      },
    };
    const canonical = this.host.host.resolve(project.id).projectId;
    const client = new (require("@areal/workbench-service/host-core-client").HostCoreClient)({
      host: this.host.hostCall,
      sourceId: this.host.host.sourceId,
      projectId: canonical,
      onServerRequest: connectionOptions.onServerRequest,
    });
    this.host.hostCoreClients.set(canonical, client);
    if (owner) this.desktopOwners.set(client, owner);
    project.client = client;
    project.connectionGeneration = (project.connectionGeneration ?? 0) + 1;
    const correlation = {
      projectId: project.id,
      connectionGeneration: project.connectionGeneration,
      coreGeneration: project.service?.generation,
    };
    const trace = startupTrace("core.connect", correlation);
    trace.advance("socket");
    try {
      client.onNotification((method, params) => {
        if (this.currentConnection(project, client))
          this.host.observeNotification(project, client, method, params);
      });
      client.onClose((failure) => {
        if (this.host.hostCoreClients.get(canonical) === client)
          this.host.hostCoreClients.delete(canonical);
        if (cuaHostGeneration)
          void Promise.resolve(
            this.host.cuaRead?.({
              phase: "revokeProject",
              ...cuaOwner,
              toolHostGeneration: cuaHostGeneration,
            }),
          ).catch(() => {});
        this.host.onMcpPageToolsDisconnected?.(client);
        if (project.client === client) {
          project.taskNotificationMonitor?.stop();
          this.host.stopReconciliation(project);
          if (failure.code === "RESPONSE_TOO_LARGE") {
            project.reconnectBlocked = true;
            clearTimeout(project.reconnectTimer ?? undefined);
            project.reconnectTimer = null;
            project.error = "Core 返回内容超过当前支持的 64 MiB，无法完整加载。";
          }
          project.model.connection(
            false,
            project.reconnectBlocked ? project.error : "连接中断，正在恢复任务状态",
          );
          this.scheduleReconnect(project);
        }
      });
      await client.connect();
      this.requireConnection(project, client);
      if (startup && this.host.starting.get(project.id) === startup)
        this.settleReadWaiters(startup, null, {
          project,
          client,
          generation: correlation.connectionGeneration,
        });
      project.error = null;
      project.configurations ??= {};
      project.configurationChanges ??= new Map();
      const selectedThread = this.selectedThreads.get(project.id);
      if (selectedThread) {
        trace.advance("selected_view");
        await this.host.openThread(project, selectedThread).catch((error) => {
          if (!this.currentConnection(project, client) || !client.ready) throw error;
        });
        this.requireConnection(project, client);
      }
      trace.advance("provider_configuration");
      await this.host.providers.reconcileProject(project, { refreshModels: false });
      this.requireConnection(project, client);
      if (!observeOnly) {
        trace.advance("providers");
        await this.host.providers.syncLocal(project);
        this.requireConnection(project, client);
        trace.advance("mcp");
        if (this.host.providers.manages(project)) await this.host.resources.syncMcp(project);
        this.requireConnection(project, client);
      }
      trace.advance("catalogs");
      const modelsTrace = startupTrace("core.model_list", correlation);
      modelsTrace.advance("request");
      const profilesTrace = startupTrace("core.profile_list", correlation);
      profilesTrace.advance("request");
      const [models, profiles] = await Promise.all([
        client
          .request("areal/model/list", undefined, {
            decode: require("./provider-contract.cjs").models,
          })
          .then(
            (value) => {
              modelsTrace.finish("ok");
              return value;
            },
            (error) => {
              modelsTrace.finish("error", error);
              throw error;
            },
          ),
        client.request("areal/profile/list").then(
          (value) => {
            profilesTrace.finish("ok");
            return value;
          },
          (error) => {
            profilesTrace.finish("error", error);
            throw error;
          },
        ),
      ]);
      this.requireConnection(project, client);
      if (!modelRecord(profiles)) throw new Error("Core 资源目录响应无效");
      await this.host.providers.acceptModelSelection(models.lastAcceptedModel);
      project.models = models.data;
      project.profiles = profiles.data ?? profiles.profiles ?? [];
      if (!observeOnly) void this.host.analytics.syncProject(project);
      trace.advance("task_subscriptions");
      for (const taskId of new Set(project.taskViews?.values() ?? [])) {
        await client.request(
          "areal/task/subscribe",
          { taskId },
          {
            onResult: (task) => {
              if (!isCoreTask(task)) throw new Error("Core 任务订阅响应无效");
              if (this.currentConnection(project, client)) project.model.setTask(task);
            },
          },
        );
        this.requireConnection(project, client);
      }
      trace.advance("task_monitor");
      await this.host.startTaskMonitor(project, client);
      this.requireConnection(project, client);
      this.host.lifecycleOperations.assertProject(project.id);
      if (this.host.lifecycleOperations.schedulingSuppressed(project.id))
        throw Object.assign(new Error("后台已由用户停止，请明确启动后继续"), {
          code: "CORE_STOPPED",
        });
      trace.advance("desktop_tools_ready");
      if (this.host.providers.manages(project))
        await this.publishScheduleTools(project, client, owner);
      project.taskNotificationMonitor?.ready();
      this.requireConnection(project, client);
      trace.advance("connected");
      project.model.connection(true);
      this.host.scheduleReconciliation(project);
      this.host.onChange();
      trace.finish("ok");
      void this.host.listThreads(project).catch((error) => {
        if (!this.currentConnection(project, client)) return;
        project.error = error instanceof Error ? error.message : String(error);
        this.host.onChange();
      });
      for (const threadId of Object.keys(project.model.state.threads)) {
        if (threadId !== selectedThread)
          void this.host.openThread(project, threadId).catch(() => {});
      }
      void this.host.providers.refreshSubscription(project, correlation, { observeOnly });
    } catch (error) {
      trace.finish("error", error);
      throw error;
    }
  }
}

module.exports = { ProjectConnections };
