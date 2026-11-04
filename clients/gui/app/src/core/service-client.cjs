// @ts-check
"use strict";
const { requiresCurrentCommands } = require("./service-command-compatibility.cjs");
const { operationCore, observedOperation } = require("./receipt-contract.cjs");
const { commandSemantics, desktopError } = require("@areal/workbench/desktop-contract");
const { startupTrace } = require("./startup-timing.cjs");
const { randomUUID } = require("node:crypto");
const { mkdir, readFile, realpath, open, writeFile, rename, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { HostClient } = require("@areal/client/node");
const { executeCore } = require("./core-process.cjs");
const { hostUpdateReceipt } = require("@areal/workbench/desktop-contract/desktop-control");
const {
  hostReference,
  readHostReceipt,
  projectHostReceipt,
  readOfflineHostReceipt,
} = require("./host-lifecycle.cjs");
const { GuiTerminalConnections } = require("./gui-terminal-connections.cjs");
const { ServiceConnection } = require("./service-connection.cjs");
const { readServicePacket } = require("./service-state.cjs");
const {
  readGuiProcesses,
  readGuiThreadIdentity,
  readSideResponse,
  readGuiProcessResponse,
} = require("./gui-resource-contract.cjs");
const { readReferences, readLifecycleResponse } = require("./service-control.cjs");
const { PROTOCOL, COMMAND_CONTRACT, encodeMedia, decodeMedia } = require("./service-protocol.cjs");
const { genUiScope, createGenUiState } = require("./gen-ui-state.cjs");
const { inspectCoreCapabilities } = require("./core-capabilities.cjs");
const { checkHostPrerequisites } = require("./host-prerequisites.cjs");
/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** @param {unknown} value @returns {value is string} */
const uuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
/** @param {unknown} kind */
const desktopKind = (kind) => kind === "stopDesktop" || kind === "updateDesktop";
/** @param {Pick<import("./service-control.cjs").LifecycleResponse,"phase"|"targets"> & {desktopExit?:unknown}} operation */
const needsOriginalCheck = (operation) =>
  operation.phase === "admissionUnconfirmed" ||
  (operation.phase === "acceptedPending" && operation.desktopExit === "requested") ||
  operation.targets.some((target) =>
    ["notAttempted", "acceptedPending", "admissionUnconfirmed"].includes(target.phase),
  );
const notAdmittedCodes = new Set([
  "LIFECYCLE_ADMISSION_FAILED",
  "LIFECYCLE_UNSUPPORTED",
  "LIFECYCLE_INVALID_REQUEST",
  "LIFECYCLE_REQUEST_CONFLICT",
  "CONFIRMATION_STALE",
  "LIFECYCLE_BLOCKED",
  "LIFECYCLE_INCOMPLETE",
]);
/** @param {string} phase */
const lifecycleMessage = (phase) =>
  /** @type {Record<string,string>} */ ({
    acceptedPending: "请求已受理，后台仍在完成退出和清理。",
    blocked: "后台明确拒绝了此次操作，原任务仍可继续使用。",
    admissionUnconfirmed: "原请求是否受理尚未确认，请检查原请求；不会自动重发。",
    settlementIncomplete: "请求已受理，部分资源尚未完成清理。",
    partial: "部分后台已完成，仍有目标需要检查。",
    completed: "后台操作已完成。",
  })[phase];

/** @param {string} home @param {{desktopGeneration?:unknown,token?:unknown}} metadata */
async function waitForServiceExit(home, metadata) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      /** @type {unknown} */
      const current = JSON.parse(await readFile(join(home, "service.json"), "utf8"));
      if (!record(current)) throw new Error("后台连接元数据无效");
      if (
        metadata.desktopGeneration
          ? current.desktopGeneration !== metadata.desktopGeneration
          : current.token !== metadata.token
      )
        return;
    } catch (error) {
      if (desktopError(error).code === "ENOENT") return;
      throw error;
    }
    await sleep(100);
  }
  throw new Error("旧后台尚未完成退出，请稍后重新连接。未删除任何任务数据。");
}
/** @param {string} home @param {{pid:number,desktopGeneration?:unknown,token?:unknown}} metadata */
async function waitForServiceProcessExit(home, metadata) {
  await waitForServiceExit(home, metadata);
  await waitForProcessExit(metadata.pid);
}
/** @param {number} pid */
async function waitForProcessExit(pid) {
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (desktopError(error).code === "ESRCH") return;
      throw error;
    }
    if (Date.now() >= deadline) throw new Error("后台进程尚未退出，请稍后重试");
    await sleep(50);
  }
}

/** @typedef {import('./service-connection.cjs').ServiceMetadata|ReturnType<InstanceType<typeof import('./service-protocol.cjs').DesktopService>['connectMain']>['metadata']} Metadata */
/** @typedef {import('./service-control.cjs').LifecycleReference} Reference */
/** @typedef {import('./service-control.cjs').LifecycleResponse} Receipt */
/** @typedef {import('./lifecycle.cjs').RecoveryObservation} Observation */
/** @typedef {import('./resource-recovery.cjs').Notify} Notify */
/** @typedef {{projectId:string,threadId:string,id:string}} GuiTerminal */
/** @typedef {{projectId:string,sourceThreadId:string,requestId:string,threadId?:string,closeRequestId?:string}} GuiSideChat */
/** @typedef {{focused:boolean,idleSeconds:number,suspended?:boolean}} Activity */
/** @typedef {{kind:import('./lifecycle-operations.cjs').LifecycleKind,mode?:import('./lifecycle-operations.cjs').LifecycleMode,observed?:Observation,projectId?:string,threadId?:string,turnId?:string,requestId?:string,migration?:unknown}} LifecycleOptions */
/** @typedef {{stopped:boolean,operation:Receipt,kind?:string}} LifecycleResult */
/** @typedef {{stopped:boolean,operation:import('@areal/workbench/desktop-contract/shared').LifecycleViewOperation,receipt?:import('./host-lifecycle.cjs').HostReceipt}} HostLifecycleResult */
// GUI-local connection/projection only. Control intent lives in GUI userData;
// shared Core history and execution state remain owned by the service.
/** @typedef {Omit<Partial<import('./backend.cjs').CoreBackendOptions>,'home'|'onChange'> & {home:string,configHome?:string,app:Pick<Electron.App,'getPath'> & Partial<Pick<Electron.App,'isPackaged'|'getAppPath'>>,onChange?:()=>void,onNotification?:(value:unknown)=>void,onNotificationOpen?:(value:unknown)=>void,onRecoveryAttention?:(value:unknown)=>void,prerequisiteCheck?:typeof checkHostPrerequisites}} SharedBackendOptions */
class SharedCoreBackend {
  /** @param {SharedBackendOptions} options */
  constructor({
    app,
    onChange = () => {},
    onNotification,
    onNotificationOpen,
    onRecoveryAttention,
    prerequisiteCheck = checkHostPrerequisites,
    ...options
  }) {
    /** @type {InstanceType<typeof ServiceConnection>|null|undefined} */
    this.connection = undefined;
    /** @type {Awaited<ReturnType<typeof import('./service-main.cjs').createMainDesktop>>|undefined} */
    this.mainDesktop = undefined;
    /** @type {Metadata|undefined} */
    this.metadata = undefined;
    /** @type {Metadata|null|undefined} */
    this.foreignOwner = undefined;
    /** @type {InstanceType<typeof ServiceConnection>|null|undefined} */
    this.stoppedConnection = undefined;
    /** @type {Metadata|import("./service-control.cjs").DesktopIdentity|null|undefined} */
    this.exitConfirmation = undefined;
    /** @type {Promise<void>|null|undefined} */
    this.connecting = undefined;
    /** @type {NodeJS.Timeout|null|undefined} */
    this.reconnectTimer = undefined;
    /** @type {number|undefined} */
    this.reconnectAttempts = undefined;
    /** @type {boolean|undefined} */
    this.reconnectBlocked = undefined;
    /** @type {boolean|undefined} */
    this.disposed = undefined;
    /** @type {string|undefined} */
    this.identity = undefined;
    /** @type {unknown} */
    this.controlState = undefined;
    /** @type {Record<string,unknown>|null|undefined} */
    this.legacyControl = undefined;
    /** @type {{canRecover:boolean,projects:unknown[],message:string}|null|undefined} */
    this.legacyRecoveryView = undefined;
    /** @type {string|null|undefined} */
    this.lifecycleError = undefined;
    /** @type {{state:string,message?:string}|undefined} */
    this.backendUpdate = undefined;
    /** @type {Promise<void>|undefined} */
    this.referenceWrite = undefined;
    /** @type {Promise<void>|null|undefined} */
    this.guiSideClosing = undefined;
    /** @type {Promise<void>|undefined} */
    this.shutdownPromise = undefined;
    /** @type {Promise<unknown>|null|undefined} */
    this.recoveryInFlight = undefined;
    /** @type {Activity|undefined} */
    this.lastActivity = undefined;
    /** @type {boolean|undefined} */
    this.computerHostOwned = undefined;
    /** @type {(()=>void)|undefined} */
    this.onBrowserDisconnected = undefined;
    /** @type {((event?:unknown)=>void)|undefined} */
    this.onMcpPageToolsDisconnected = undefined;
    /** @type {((request:Record<string,unknown>&{requestId:number})=>unknown)|undefined} */
    this.onBrowserRequest = undefined;
    /** @type {((request:unknown)=>void)|undefined} */
    this.onBrowserCancel = undefined;
    /** @type {((event:unknown)=>void)|undefined} */
    this.onMcpAppNotification = undefined;
    /** @type {((event:unknown)=>void)|undefined} */
    this.onMcpPageToolNotice = undefined;
    this.prerequisiteCheck = prerequisiteCheck;
    this.onNotification = onNotification;
    this.onNotificationOpen = onNotificationOpen;
    this.onRecoveryAttention = onRecoveryAttention;
    this.app = app;
    this.options = options;
    this.applicationOwner = options.applicationOwner;
    this.home = options.home;
    this.onChange = onChange;
    this.genUiState = createGenUiState(this.home);
    /** @type {import("./service-state.cjs").ServiceSnapshot} */
    this.value = {
      library: {
        projects: {},
        threads: {},
        projectOrder: [],
        settings: {},
        sections: [],
        sidebarThreadOrder: [],
        sidebarRevision: 0,
      },
      projects: [],
    };
    /** @type {Partial<import('./resource-observation.cjs').RecoveryService>} */
    this.status = { connected: false };
    this.sequence = -1;
    /** @type {{state:string,message?:string,recovery?:string,prerequisite?:unknown}} */
    this.connectionState = { state: "connecting" };
    this.revision = 0;
    this.initializing = false;
    /** @type {Map<string,GuiTerminal>} */
    this.guiTerminals = new Map();
    this.terminalConnections = new GuiTerminalConnections();
    /** @type {Set<Promise<unknown>>} */
    this.guiTerminalStarts = new Set();
    /** @type {Map<string,GuiSideChat>} */
    this.guiSideChats = new Map();
    /** @type {Set<Promise<unknown>>} */
    this.guiSideStarts = new Set();
    this.guiWindowClosed = false;
    /** @type {Map<string,Reference>} */
    this.lifecycleReferences = new Map();
    /** @type {Map<string,import('./host-lifecycle.cjs').HostReference>} */
    this.hostReferences = new Map();
    /** @type {{requestId:string,hostId:string,generation:string,action:'prepare'|'apply',targetVersion:string}|null} */
    this.hostUpdateReference = null;
    this.hostUpdateInFlight = false;
    /** @type {Map<string,import('./host-lifecycle.cjs').HostReceipt>} */
    this.hostReceipts = new Map();
    /** @type {Map<string,InstanceType<typeof GuiTerminalConnections>>} */
    this.hostStopResources = new Map();
    /** @type {Promise<HostLifecycleResult>|undefined} */
    this.hostStopInFlight = undefined;
    /** @type {Map<string,Receipt>} */
    this.lifecycleReceipts = new Map();
    this.analytics = {
      /** @param {Activity} sample */
      sample: (sample) => {
        this.lastActivity = sample;
        if (this.status.connected)
          void this.connection?.request("activity", sample).catch(() => {});
      },
      flush: async () => {},
    };
  }
  /** @param {import("./gen-ui-state.cjs").GenUiProject} project @param {string} threadId */
  genUiScope(project, threadId) {
    return genUiScope(this.home, project, threadId);
  }
  requireConnection() {
    if (!this.status.connected || !this.connection)
      throw new Error("后台尚未连接，请先处理后台连接提示");
    return this.connection;
  }
  get saved() {
    return this.value.projects;
  }
  get activeCommands() {
    return this.status.activeCommands ?? 0;
  }
  get providerUpdating() {
    return this.status.providerUpdating;
  }
  get starting() {
    return { size: this.status.starting ?? 0 };
  }
  hasWork() {
    return !this.status.connected || this.status.busy === true;
  }
  /** @param {string} projectId @param {string} threadId */
  ownsThread(projectId, threadId) {
    const project = this.value.library.projects[projectId];
    if (record(project) && project.hidden) return false;
    const thread = this.saved.find((p) => p.id === projectId)?.state?.threads?.[threadId];
    return record(thread) && !(record(thread.desktop) && thread.desktop.archived);
  }
  /** @param {string} projectId @param {string} threadId */
  retainsThreadResources(projectId, threadId) {
    const project = this.saved.find((project) => project.id === projectId);
    const thread = project?.state?.threads?.[threadId];
    if (
      !record(thread) ||
      !record(thread.conversation) ||
      !record(thread.conversation.policy) ||
      thread.conversation.policy.kind !== "sideExecutableV2" ||
      !record(thread.desktop) ||
      thread.desktop.archived !== true
    )
      return false;
    return !Object.values(record(project?.outcomes) ? project.outcomes : {}).some(
      (outcome) =>
        record(outcome) &&
        outcome.method === "areal/side/close" &&
        outcome.threadId === threadId &&
        outcome.accepted === true &&
        outcome.cleanupConfirmed === true,
    );
  }
  snapshot() {
    const desktopCapabilities = {
      currentCommands: this.status.commandContract === COMMAND_CONTRACT,
    };
    const connection =
      this.initializing && this.connectionState.state === "ready"
        ? { state: "connecting" }
        : this.connectionState;
    return {
      ...this.value,
      desktopCapabilities,
      serviceSummary: {
        state: this.status.connected ? "running" : this.serviceExited ? "stopped" : "unknown",
        busy: this.status.busy === true,
      },
      projects: this.value.projects.map((project) => ({ ...project, desktopCapabilities })),
      backendUpdate: this.backendUpdate,
      lifecycle: this.lifecycleProjection(),
      revision: ++this.revision,
      connection,
    };
  }
  /** @param {unknown} packet @param {unknown} [metadata] */
  accept(packet, metadata = this.metadata) {
    if (this.disposed) return;
    const checked = readServicePacket(packet, metadata);
    if (checked.sequence <= this.sequence) return;
    this.clearReconnect();
    this.reconnectAttempts = 0;
    this.sequence = checked.sequence;
    this.value = checked.snapshot;
    this.status = {
      ...require("./resource-observation.cjs").readRecoveryService(checked.service),
      ...checked.service,
    };
    this.connectionState = this.foreignOwner
      ? {
          state: "unavailable",
          recovery: "check",
          message: "原后台属于旧应用会话，仅供检查。请安全迁移后继续。",
        }
      : { state: "ready" };
    this.onChange();
  }
  disconnected() {
    this.terminalConnections.close();
    this.computerHostOwned = false;
    this.onBrowserDisconnected?.();
    this.onMcpPageToolsDisconnected?.();
    const stopped = !!this.connection && this.stoppedConnection === this.connection;
    const message = stopped ? "后台服务已停止，可按需重新连接" : "后台服务已断开，请重新连接";
    this.connectionState = { state: "unavailable", message };
    this.status = { ...this.status, connected: false };
    this.value = {
      ...this.value,
      projects: this.value.projects.map((p) => ({
        ...p,
        error: stopped ? null : message,
        state: p.state ? { ...p.state, connected: false, error: stopped ? null : message } : null,
      })),
    };
    this.scheduleReconnect();
    this.onChange();
  }
  clearReconnect() {
    clearTimeout(this.reconnectTimer ?? undefined);
    this.reconnectTimer = null;
  }
  canReconnect() {
    return (
      !this.disposed &&
      !this.reconnectBlocked &&
      !this.hostReferences.size &&
      !this.status.connected &&
      !this.serviceExited &&
      !["stopped", "unconfirmed"].some((state) => state === this.controlState) &&
      !this.status.stopReport
    );
  }
  scheduleReconnect() {
    if (
      this.metadata?.local === true ||
      !(this.metadata?.identity ?? this.identity) ||
      !this.canReconnect() ||
      this.reconnectTimer
    )
      return;
    this.connectionState = { state: "connecting" };
    const delay = Math.min(30000, 500 * 2 ** Math.min(this.reconnectAttempts ?? 0, 6));
    this.reconnectAttempts = (this.reconnectAttempts ?? 0) + 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.canReconnect()) return;
      if (this.connecting) {
        this.scheduleReconnect();
        return;
      }
      // 只恢复观察连接：不调用 initialize，不启动 Core、不重放任何未知提交。
      this.connecting = (async () => {
        const control = await this.readControl();
        if (control?.state) {
          this.controlState = control.state;
          this.reconnectBlocked = true;
          this.connectionState = {
            state: "unavailable",
            recovery: "check",
            message: "后台操作已保留，请检查原请求后继续。",
          };
          this.onChange();
          return;
        }
        this.loadReferences(control);
        if (await this.attach({ passive: true })) {
          for (const reference of this.lifecycleReferences.values())
            await this.readLifecycle(reference);
        }
      })()
        .catch(
          /** @param {unknown} error */ (error) => {
            if (
              desktopError(error).submissionUnknown !== true &&
              (desktopError(error).code === "DISCONNECTED" ||
                (desktopError(error).code === "TIMEOUT" &&
                  desktopError(error).recovery?.kind === "retryRead"))
            )
              return;
            this.reconnectBlocked = true;
            this.connectionState = { state: "unavailable", message: desktopError(error).message };
            this.onChange();
          },
        )
        .finally(() => {
          this.connecting = null;
          this.scheduleReconnect();
        });
    }, delay);
    this.reconnectTimer.unref?.();
  }
  /** @param {unknown} [candidate] */
  createConnection(candidate) {
    this.terminalConnections.close();
    this.terminalConnections = new GuiTerminalConnections();
    const connection = new ServiceConnection(
      (packet) => {
        if (this.connection !== connection) return;
        try {
          this.accept(packet, candidate ?? this.metadata);
        } catch {
          this.connection = null;
          connection.close();
          this.disconnected();
        }
      },
      () => {
        if (this.connection === connection) this.disconnected();
      },
      (notice) => {
        if (this.connection === connection) this.onNotification?.(notice);
      },
      (target) => {
        if (this.connection === connection) this.onNotificationOpen?.(target);
      },
      (request) => {
        if (this.connection !== connection || this.disposed)
          throw new Error("Browser host is disconnected");
        return (
          this.onBrowserRequest?.(request) ?? Promise.reject(new Error("Browser host unavailable"))
        );
      },
      (request) => {
        if (this.connection === connection) this.onBrowserCancel?.(request);
      },
      (event) => {
        if (this.connection === connection && !this.disposed) this.onMcpAppNotification?.(event);
      },
      (event) => {
        if (this.connection === connection && !this.disposed) this.onMcpPageToolNotice?.(event);
      },
      (event) => {
        if (this.connection === connection && !this.disposed)
          this.onMcpPageToolsDisconnected?.(event);
      },
      (request) => {
        if (this.connection !== connection || this.disposed)
          throw new Error("GUI terminal owner disconnected");
        return this.terminalConnections.request(request);
      },
    );
    return connection;
  }
  /** @param {{expectedIdentity?:string,passive?:boolean}} [options] */
  async attach({ expectedIdentity, passive = false } = {}) {
    /** @type {unknown} */
    let candidate;
    try {
      candidate = JSON.parse(await readFile(join(this.home, "service.json"), "utf8"));
    } catch (e) {
      if (desktopError(e).code === "ENOENT") return false;
      throw e;
    }
    const connection = this.createConnection(candidate);
    /** @type {import("./service-connection.cjs").ServiceMetadata} */
    let metadata;
    try {
      metadata = await connection.connect(candidate);
    } catch (e) {
      connection.close();
      if (desktopError(e).code === "DISCONNECTED") return false;
      throw e;
    }
    this.foreignOwner = metadata;
    const identity =
      expectedIdentity ??
      (passive ? (this.metadata?.identity ?? this.identity) : metadata.identity);
    if (this.disposed) {
      connection.close();
      throw new Error("GUI 连接已关闭");
    }
    if (passive && !this.canReconnect()) {
      connection.close();
      return false;
    }
    if (this.connection) this.onMcpPageToolsDisconnected?.();
    this.connection?.close();
    this.connection = connection;
    this.sequence = -1;
    const helloTrace = startupTrace("service.hello", { servicePid: metadata.pid });
    helloTrace.advance("hello");
    try {
      const deadline = Date.now() + 60000;
      for (;;) {
        try {
          const packet = await connection.request("hello", {
            protocol: PROTOCOL,
            identity,
            notifications: false,
            capabilities: {},
          });
          if (this.connection !== connection)
            throw Object.assign(new Error("后台服务连接已变化，请重新连接"), {
              code: "DISCONNECTED",
            });
          this.computerHostOwned = record(packet) && packet.computerHostOwned === true;
          this.accept(packet, metadata);
          break;
        } catch (error) {
          if (passive) throw error;
          if (desktopError(error).code !== "SERVICE_STOPPING") throw error;
          // Safety inspection can cancel retirement. Retry only the read-only
          // handshake: attach if retained, rediscover when the old socket closes.
          if (this.disposed || Date.now() >= deadline)
            throw new Error("后台尚未完成退出检查，请稍后重新连接");
          await sleep(100);
        }
      }
    } catch (e) {
      helloTrace.finish("error", e);
      this.connection = null;
      connection.close();
      if (desktopError(e).code === "DISCONNECTED") return false; // Only a read-only handshake was attempted.
      if (
        expectedIdentity !== undefined &&
        (desktopError(e).code === "SERVICE_INCOMPATIBLE" ||
          desktopError(e).message.startsWith("后台服务版本或启动配置不兼容。"))
      ) {
        throw Object.assign(
          new Error(
            "当前后台使用了不同的启动配置，本次启动配置尚未生效。请重新连接，或安全停止后台后重试。",
          ),
          { code: "SERVICE_INCOMPATIBLE" },
        );
      }
      throw e;
    }
    helloTrace.finish("ok");
    if (this.lastActivity) void connection.request("activity", this.lastActivity).catch(() => {});
    this.metadata = metadata;
    this.exitConfirmation = null;
    if (this.foreignOwner) {
      this.backendUpdate = {
        state: "pending",
        message: "原后台属于旧应用会话，请检查并安全停止后迁移。",
      };
      this.connectionState = {
        state: "unavailable",
        recovery: "check",
        message: "原后台仅供检查。请使用“检查后台资源”安全停止旧应用会话，再重新连接。",
      };
      this.onChange();
    }
    return true;
  }
  get controlPath() {
    return join(this.app.getPath("userData"), "service-control.json");
  }
  async readControl() {
    try {
      /** @type {unknown} */
      const control = JSON.parse(await readFile(this.controlPath, "utf8"));
      if (control == null) throw new Error("后台操作引用损坏，请保留记录并检查原后台");
      return record(control) && control.home === (await realpath(this.home)) ? control : null;
    } catch (error) {
      if (desktopError(error).code === "ENOENT") return null;
      throw error;
    }
  }
  /** @param {string} state */
  async saveControl(state) {
    await mkdir(this.app.getPath("userData"), { recursive: true, mode: 0o700 });
    await writeFile(
      `${this.controlPath}.tmp`,
      JSON.stringify({ home: this.home, state, pid: this.metadata?.pid }),
      { mode: 0o600 },
    );
    await rename(`${this.controlPath}.tmp`, this.controlPath);
    this.controlState = state;
  }
  /** @param {{automatic?:boolean}} [options] @returns {Promise<void>} */
  async init({ automatic = false } = {}) {
    if (this.disposed) throw new Error("GUI 连接已关闭");
    if (this.hostStopInFlight)
      throw Object.assign(new Error("Host 停止操作仍在处理中，请完成后重新连接"), {
        code: "LIFECYCLE_BLOCKED",
      });
    if (this.connecting) return this.connecting;
    // 控制文件读取也属于同一次连接尝试；首次 await 前建立共享门闩，避免并发调用互相关闭连接或重复启动后台。
    this.connecting = (async () => {
      const control = await this.readControl();
      if (this.disposed) throw new Error("GUI 连接已关闭");
      this.loadReferences(control);
      if (automatic && this.controlState === "stopped") {
        this.connectionState = { state: "unavailable", message: "后台服务已停止，可按需重新连接" };
        this.onChange();
        return;
      }
      if (
        this.status.connected &&
        !this.lifecycleReferences.size &&
        !this.hostReferences.size &&
        !this.legacyControl
      )
        return;
      this.clearReconnect();
      this.initializing = true;
      this.connectionState = { state: "connecting" };
      this.onChange();
      let reconnectHost = false;
      if (this.hostReferences.size) {
        for (const reference of this.hostReferences.values()) await this.readHostStop(reference);
        if (
          automatic ||
          [...this.hostReferences.values()].some(
            (reference) =>
              !["completed", "blocked"].includes(
                this.hostReceipts.get(reference.requestId)?.state ?? "admissionUnknown",
              ),
          )
        ) {
          this.connectionState = this.hostRecoveryState();
          return;
        }
        reconnectHost = true;
      }
      if (this.lifecycleReferences.size || this.legacyControl) {
        await this.checkLifecycle();
        const completedStop =
          this.lifecycleReferences.size > 0 &&
          [...this.lifecycleReferences.values()].every(
            (reference) =>
              reference.kind === "stopDesktop" &&
              this.lifecycleReceipts.get(reference.requestId)?.phase === "completed",
          );
        const completedUpdate =
          this.lifecycleReferences.size > 0 &&
          [...this.lifecycleReferences.values()].every(
            (reference) =>
              reference.kind === "updateDesktop" &&
              this.lifecycleReceipts.get(reference.requestId)?.phase === "completed",
          );
        // 更新意图包含新界面重开；本次启动失败和明确停止仍须用户主动重试。
        if (
          (completedUpdate && (!automatic || this.backendUpdate?.state !== "failed")) ||
          (!automatic && completedStop)
        ) {
          this.lifecycleReferences.clear();
          this.lifecycleReceipts.clear();
          await this.persistReferences();
        } else {
          if (!this.status.connected)
            this.connectionState = {
              state: "unavailable",
              recovery: "check",
              message: "原后台暂不可连接，操作引用已保留。请检查原请求，不会自动启动或重发。",
            };
          return;
        }
      }
      this.reconnectBlocked = false;
      await this.initialize(automatic, { reconnectHost });
      if (reconnectHost) {
        this.hostReferences.clear();
        this.hostReceipts.clear();
        this.hostStopResources.clear();
        await this.persistReferences();
      }
      if (!this.lifecycleReferences.size && !this.hostUpdateReference) {
        await rm(this.controlPath, { force: true });
        this.controlState = null;
      }
    })()
      .catch(
        /** @param {unknown} error */ (error) => {
          this.connectionState = {
            state: "unavailable",
            message: desktopError(error).message,
            ...(record(error) && error.prerequisite ? { prerequisite: error.prerequisite } : {}),
          };
          if (
            ["SERVICE_NOT_READY", "DISCONNECTED"].some((code) => code === desktopError(error).code)
          )
            this.scheduleReconnect();
          this.onChange();
          throw error;
        },
      )
      .finally(() => {
        this.initializing = false;
        this.connecting = null;
        this.onChange();
      });
    return this.connecting;
  }
  /** @param {boolean} [_automatic] @param {{reconnectHost?:boolean}} [options] @returns {Promise<void>} */
  async initialize(_automatic = false, { reconnectHost = false } = {}) {
    const trace = startupTrace("service.initialize");
    try {
      await mkdir(this.home, { recursive: true, mode: 0o700 });
      this.home = await realpath(this.home);
      if (this.disposed) throw new Error("GUI 连接已关闭");
      if (!this.mainDesktop || this.mainDesktop.closed) {
        const legacy = await readFile(join(this.home, "service.json"), "utf8").catch((error) => {
          if (desktopError(error).code === "ENOENT") return null;
          throw error;
        });
        if (legacy !== null) {
          if (await this.attach()) return;
          throw Object.assign(
            new Error("原 Desktop 连接不可用，请先检查原后台及清理回执，不能直接接管。"),
            { code: "SERVICE_NOT_READY" },
          );
        }
        await this.prerequisiteCheck({ app: { isPackaged: this.app.isPackaged === true } });
        const binary = this.options.binary;
        if (!binary) throw new Error("Core 程序路径不可用");
        const desktop = await require("./service-main.cjs").createMainDesktop({
          ...this.options,
          binary,
          home: this.home,
        });
        if (this.disposed) {
          await desktop.close();
          throw new Error("GUI 连接已关闭");
        }
        this.mainDesktop = desktop;
      }
      if (reconnectHost) await this.mainDesktop.adapter.reconnectHost();
      const connection = this.createConnection();
      const metadata = connection.connectMain(this.mainDesktop.adapter);
      this.connection?.close();
      this.connection = connection;
      this.metadata = metadata;
      this.identity = metadata.identity;
      this.foreignOwner = null;
      this.sequence = -1;
      this.exitConfirmation = null;
      try {
        const packet = await connection.request("hello", {
          protocol: PROTOCOL,
          identity: metadata.identity,
          notifications: !!this.onNotification,
          capabilities: { computerHost: 1 },
        });
        this.computerHostOwned = record(packet) && packet.computerHostOwned === true;
        this.accept(packet, metadata);
        if (this.lastActivity) await connection.request("activity", this.lastActivity);
        this.backendUpdate = undefined;
      } catch (error) {
        this.connection = null;
        connection.close();
        throw error;
      }
      trace.finish("ok");
    } catch (error) {
      trace.finish("error", error);
      throw error;
    }
  }
  /** @param {string} path @returns {Promise<unknown>} */
  async addProject(path) {
    await this.init();
    this.assertLifecycleScope("addProject");
    const connection = this.requireConnection();
    try {
      return await connection.request("addProject", { path }, true);
    } catch (error) {
      if (
        desktopError(error).submissionUnknown ||
        ["admitted", "unconfirmed"].some((kind) => kind === desktopError(error).outcome?.kind)
      )
        throw error;
      const packet = await connection.request("snapshot").catch(() => null);
      if (!packet || connection !== this.connection || !this.status.connected) throw error;
      this.accept(packet);
      const project = this.value.projects.find(
        (project) =>
          project.root === path &&
          !project.state?.connected &&
          project.error &&
          project.error === desktopError(error).message,
      );
      if (!project) throw error;
      return project.id;
    }
  }
  /** @param {Record<string,unknown>} request */
  async mcpPageTools(request) {
    if (!this.status.connected || !this.connection)
      throw new Error("Page tool owner lease is disconnected");
    return this.requireConnection().request("mcpPageTools", request, true);
  }
  /** @param {Record<string,unknown>} identity */
  async browserClaim(identity) {
    this.assertLifecycleScope("browserClaim");
    if (!this.status.connected || !this.connection) throw new Error("后台尚未连接");
    return this.requireConnection().request("browserClaim", identity, true);
  }
  /** @param {Record<string,unknown>} identity */
  async browserRevoke(identity) {
    if (this.foreignOwner) return;
    if (!this.status.connected || !this.connection) return;
    return this.requireConnection().request("browserRevoke", identity, true);
  }
  /** @param {string} name @param {Record<string,unknown>} request @returns {Promise<unknown>} */
  async command(name, request) {
    if (this.disposed) throw new Error("GUI 连接已关闭");
    if (this.connecting) await this.connecting.catch(() => {});
    // Only explicit reconnect opens a stopped service. Periodic panel reads must
    // not undo the user's stop action; in-flight commands are never replayed.
    if (name === "connect" && !this.status.connected) await this.init();
    if (this.disposed) throw new Error("GUI 连接已关闭");
    if (!this.status.connected) throw new Error("后台尚未连接，请先处理后台连接提示");
    if (this.foreignOwner) this.assertLifecycleScope(name, request);
    if (name === "stop") {
      if (
        !uuid(request.requestId) ||
        typeof request.turnId !== "string" ||
        !request.turnId ||
        typeof request.projectId !== "string" ||
        typeof request.threadId !== "string"
      )
        throw Object.assign(new Error("暂停需要原轮次和操作身份，请刷新任务后重试"), {
          code: "LIFECYCLE_INVALID_REQUEST",
        });
      return this.requestLifecycle({
        kind: "interruptTurn",
        mode: "cancel",
        projectId: request.projectId,
        threadId: request.threadId,
        turnId: request.turnId,
        requestId: request.requestId,
      });
    }
    this.assertLifecycleScope(name, request);
    if (
      this.status.commandContract !== COMMAND_CONTRACT &&
      requiresCurrentCommands(name, request)
    ) {
      throw Object.assign(
        new Error(
          "当前运行中的后台不支持此操作。现有任务继续运行，输入已保留；请在任务完成后安全停止后台并重新连接。",
        ),
        { code: "SERVICE_COMMAND_UNSUPPORTED" },
      );
    }
    // Only explicitly GUI-owned shells are tied to this GUI's lifetime. Model
    // tools and manually managed thread processes keep their Core lifetime.
    const ownedStart =
      name === "manage" && request.operation === "processStart" && request.guiOwned === true;
    const ownedRecovery =
      name === "manage" && request.operation === "processSubmission" && request.guiOwned === true;
    const ownedScope = ownedStart || ownedRecovery ? readGuiThreadIdentity(request) : undefined;
    const { guiOwned: _guiOwned, ...params } = request;
    if (name === "connect" && this.status.selectedThreadObservation !== true)
      delete params.threadId;
    // 队列业务键跨 GUI/共享服务连接保留，外层丢失响应后也能只读核对。
    const semantics = commandSemantics(name, params);
    if (semantics.requestId) params[semantics.requestId] ??= randomUUID();
    const sideCreate = name === "side" && params.operation === "create";
    if (sideCreate && this.guiWindowClosed)
      throw Object.assign(new Error("窗口正在关闭，请重新打开后创建 Side Chat"), {
        code: "WINDOW_CLOSED",
      });
    if (sideCreate) {
      if (
        typeof params.requestId !== "string" ||
        typeof params.projectId !== "string" ||
        typeof params.sourceThreadId !== "string"
      )
        throw Object.assign(new Error("无效 Side Chat 创建身份"), {
          code: "INVALID_DESKTOP_REQUEST",
        });
      if (!this.guiSideChats.has(params.requestId))
        this.guiSideChats.set(params.requestId, {
          projectId: params.projectId,
          sourceThreadId: params.sourceThreadId,
          requestId: params.requestId,
        });
    }
    const sideKey = typeof params.requestId === "string" ? params.requestId : undefined;
    const sideOwner =
      name === "side"
        ? ((sideKey ? this.guiSideChats.get(sideKey) : undefined) ??
          [...this.guiSideChats.values()].find(
            (entry) => entry.projectId === params.projectId && entry.threadId === params.threadId,
          ))
        : undefined;
    if (sideOwner && params.operation === "close") {
      if (!sideKey)
        throw Object.assign(new Error("无效 Side Chat 关闭身份"), {
          code: "INVALID_DESKTOP_REQUEST",
        });
      sideOwner.closeRequestId ??= sideKey;
    }
    if (
      ["send", "steer", "editMessage"].includes(name) ||
      (name === "side" && request.operation === "send")
    ) {
      const project = this.saved.find((project) => project.id === request.projectId);
      if (project) {
        if (typeof request.threadId !== "string")
          throw Object.assign(new Error("无效桌面任务身份"), { code: "INVALID_DESKTOP_REQUEST" });
        await this.genUiState.list(this.genUiScope(project, request.threadId));
      }
    }
    const originalCore = operationCore(
      this.value.projects.find((project) => project.id === params.projectId),
      params,
    );
    const connection = this.requireConnection();
    const ownedTerminal =
      ownedStart ||
      ownedRecovery ||
      (name === "manage" &&
        typeof params.operation === "string" &&
        params.operation.startsWith("process") &&
        typeof params.id === "string" &&
        this.guiTerminals.has(params.id));
    const pending = connection
      .request(
        ownedTerminal ? "guiTerminalCommand" : "command",
        { name, request: name === "media" ? encodeMedia(params) : params },
        semantics.effect === "mutation",
      )
      .then((value) => {
        if (
          sideOwner &&
          (sideCreate ||
            params.operation === "recover" ||
            params.operation === "close" ||
            params.method === "areal/side/close")
        ) {
          const response = readSideResponse(
            value,
            params.requestId,
            semantics.effect === "mutation",
            sideCreate || (params.operation === "recover" && record(value) && !!value.confirmed),
          );
          if (sideCreate || (params.operation === "recover" && response.confirmed))
            sideOwner.threadId = response.threadId;
          if (params.operation === "close" && response.requestId)
            sideOwner.closeRequestId = response.requestId;
          if (
            (params.operation === "close" || params.method === "areal/side/close") &&
            response.cleanupConfirmed === true
          )
            this.guiSideChats.delete(sideOwner.requestId);
        }
        if (ownedScope) {
          const response = readGuiProcessResponse(value, params.requestId, ownedRecovery);
          if (response.confirmed)
            this.guiTerminals.set(response.id, { ...ownedScope, id: response.id });
        }
        return name === "media" ? decodeMedia(value) : value;
      });
    if (ownedStart || ownedRecovery) this.guiTerminalStarts.add(pending);
    if (sideCreate || (sideOwner && params.operation === "recover"))
      this.guiSideStarts.add(pending);
    try {
      return await pending;
    } catch (error) {
      const details = desktopError(error);
      const rejected = details.outcome
        ? ["noMutation", "rejected"].includes(details.outcome.kind)
        : typeof details.code === "number" && details.code !== -32603;
      if (sideCreate && rejected && sideKey) this.guiSideChats.delete(sideKey);
      if (
        sideOwner &&
        params.operation === "close" &&
        rejected &&
        sideOwner.closeRequestId === params.requestId
      )
        delete sideOwner.closeRequestId;
      if (semantics.requestId && record(error)) {
        error.requestId ??= params[semantics.requestId];
        if (
          details.submissionUnknown &&
          !details.outcome &&
          typeof error.requestId === "string" &&
          error.requestId === params[semantics.requestId]
        ) {
          if (connection === this.connection && this.status.connected) {
            await connection
              .request("snapshot")
              .then((packet) => {
                if (connection === this.connection && this.status.connected) this.accept(packet);
              })
              .catch(() => {});
          }
          const operation = observedOperation(
            this.value.projects.find((project) => project.id === params.projectId),
            originalCore,
            params,
            error.requestId,
          );
          if (operation) error.outcome = { kind: "unconfirmed", operation };
        }
      }
      throw error;
    } finally {
      this.guiTerminalStarts.delete(pending);
      this.guiSideStarts.delete(pending);
    }
  }
  /** @returns {Promise<void>} */
  async closeWindowSideChats() {
    this.guiWindowClosed = true;
    if (this.guiSideClosing) return this.guiSideClosing;
    this.guiSideClosing = (async () => {
      await Promise.allSettled(this.guiSideStarts);
      const failures = [];
      for (const entry of Array.from(this.guiSideChats.values())) {
        try {
          if (!entry.threadId) {
            const original = readSideResponse(
              await this.command("side", {
                operation: "recover",
                method: "areal/side/create",
                projectId: entry.projectId,
                sourceThreadId: entry.sourceThreadId,
                requestId: entry.requestId,
              }),
              entry.requestId,
              false,
            );
            if (!original.confirmed) throw new Error("Side Chat 创建结果待核对；原请求不会重发");
            entry.threadId = original.threadId;
          }
          const result = entry.closeRequestId
            ? await this.command("side", {
                operation: "recover",
                method: "areal/side/close",
                projectId: entry.projectId,
                threadId: entry.threadId,
                requestId: entry.closeRequestId,
              })
            : await this.command("side", {
                operation: "close",
                projectId: entry.projectId,
                threadId: entry.threadId,
                requestId: randomUUID(),
              });
          if (readSideResponse(result, entry.closeRequestId, false).cleanupConfirmed !== true)
            throw new Error("Side Chat 已停止受理，资源清理仍待核对；原请求不会重发");
          this.guiSideChats.delete(entry.requestId);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) throw failures[0];
    })();
    try {
      await this.guiSideClosing;
    } finally {
      this.guiSideClosing = null;
    }
  }
  /** @param {Record<string,unknown>} request @returns {Promise<unknown>} */
  async resources(request) {
    if (request.operation !== "inspect") this.assertApplicationWrite();
    if (!this.status.connected)
      throw new Error("后台尚未连接，请点击“重新连接后台”检查并恢复旧服务");
    return this.requireConnection().request("resources", request, request.operation !== "inspect");
  }
  /** @param {Record<string,unknown>} request */
  async remoteControl(request) {
    if (request.operation !== "status") this.assertApplicationWrite();
    if (!this.status.connected) throw new Error("后台尚未连接");
    return this.requireConnection().request(
      "remoteControl",
      request,
      request.operation !== "status",
    );
  }
  async serviceStatus() {
    if (!this.status.connected) throw new Error("后台尚未连接");
    const connection = this.requireConnection();
    const projects = require("./resource-observation.cjs").readResourceInspections(
      await this.resources({ operation: "inspect", includeTasks: true }),
    );
    const { service, snapshot } = readServicePacket(
      await connection.request("snapshot"),
      this.metadata,
    );
    if (connection !== this.connection || !this.status.connected)
      throw new Error("后台连接已变化，请刷新状态");
    // Only public lifecycle observations cross the renderer boundary, never the
    // service descriptor, authentication token or resource command arguments.
    const { recoveryView } = require("./lifecycle.cjs");
    const visibleProjects = projects.map(
      ({ serviceId: _serviceId, generation: _generation, lifecycle: _lifecycle, ...project }) =>
        project,
    );
    return {
      canStop: recoveryView(
        require("./resource-observation.cjs").readRecoveryService(service),
        projects,
      ).ifIdle,
      connected: service.connected,
      clients: service.clients,
      busy: service.busy,
      activeCommands: service.activeCommands,
      starting: service.starting,
      providerUpdating: service.providerUpdating,
      projects: snapshot.projects.map((project) => ({
        projectId: project.id,
        root: project.root,
        started: projects.some((item) => item.projectId === project.id),
        ...visibleProjects.find((item) => item.projectId === project.id),
      })),
    };
  }
  /** @param {'status'|'install'|'uninstall'} operation @param {()=>Promise<unknown>} [stop] @returns {Promise<import('@areal/workbench/desktop-contract/desktop-control').HostInstallation>} */
  async hostInstallation(operation, stop) {
    if (!this.options.binary || !this.options.hostHome) throw new Error("Host 程序尚未配置");
    if (operation !== "status") {
      this.assertApplicationWrite();
      if (!this.hostUpdateReference) this.loadReferences(await this.readControl());
      if (this.hostUpdateInFlight || this.hostUpdateReference)
        throw new Error("请先核查原升级请求，再更改登录自启");
      for (const reference of this.hostReferences.values()) {
        await this.readHostStop(reference);
        if (
          !["completed", "blocked"].includes(
            this.hostReceipts.get(reference.requestId)?.state ?? "",
          )
        )
          throw new Error("请先核查并完成原后台停止请求，再更改登录自启");
      }
      if (operation === "uninstall" && this.status.connected) {
        const result = await stop?.();
        if (!record(result) || result.stopped !== true)
          throw new Error("请先完成后台停止，再关闭登录自启");
      }
    }
    const { stdout } = await executeCore(
      this.options.binary,
      operation === "status"
        ? ["host", "service-status", "--json"]
        : operation === "uninstall"
          ? ["host", "uninstall", "--stopped-only"]
          : ["host", "install"],
      { env: { ...process.env, AREAL_HARNESS_HOME: this.options.hostHome }, timeout: 60000 },
    );
    if (operation !== "status") return this.hostInstallation("status");
    return JSON.parse(stdout);
  }
  /** @param {import('@areal/workbench/desktop-contract/desktop-control').HostUpdateRequest} request */
  async hostUpdate(request) {
    if (this.hostUpdateInFlight) throw new Error("正在核查原升级请求，请稍后刷新");
    this.hostUpdateInFlight = true;
    const client = new HostClient();
    try {
      if (!this.options.hostHome) throw new Error("Host home 尚未配置");
      await client.connect(this.options.hostHome);
      const empty = {
        supported: false,
        restartPending: false,
        targetVersion: null,
        prepareRequestId: null,
        operation: null,
      };
      if (!client.capabilities.includes("updates")) {
        if (request.operation !== "status") throw new Error("当前 Host 不支持受控升级");
        return empty;
      }
      if (!this.hostUpdateReference) this.loadReferences(await this.readControl());
      const original = this.hostUpdateReference;
      if (original) {
        if (original.hostId !== client.hostId)
          throw new Error("Host 身份已变化，原升级请求仍需核查");
        const { operation: receipt } = await client.operation(original.requestId);
        if (
          receipt !== null &&
          (!hostUpdateReceipt(receipt) ||
            receipt.requestId !== original.requestId ||
            receipt.hostId !== original.hostId ||
            receipt.generation !== original.generation ||
            receipt.action !== original.action ||
            receipt.targetVersion !== original.targetVersion)
        )
          throw new Error("原升级请求回执与保存的身份不一致");
        if (receipt && ["prepared", "completed", "blocked"].includes(receipt.state)) {
          this.hostUpdateReference = null;
          await this.persistReferences();
        } else {
          if (request.operation !== "status" && request.operation !== "check")
            throw new Error("原升级请求结果待核查，请检查原请求");
          return {
            supported: true,
            restartPending: true,
            targetVersion: original.targetVersion,
            prepareRequestId: original.action === "prepare" ? original.requestId : null,
            operation: this.publicHostUpdate(
              receipt ?? {
                version: 1,
                ...original,
                state: "admissionUnknown",
                message: "原请求结果未知；只核查原编号，不自动重新提交。",
              },
            ),
          };
        }
      }
      if (request.operation === "prepare" || request.operation === "apply") {
        this.assertApplicationWrite();
        this.hostUpdateReference = {
          requestId: request.requestId,
          hostId: client.hostId,
          generation: client.generation,
          action: request.operation,
          targetVersion: request.targetVersion,
        };
        await this.persistReferences();
        try {
          const receipt = await client.request("host.update", {
            requestId: request.requestId,
            expectedGeneration: client.generation,
            action: request.operation,
            targetVersion: request.targetVersion,
            ...(request.operation === "apply" ? { strategy: "ifIdle" } : {}),
          });
          this.publicHostUpdate(receipt);
          if (
            receipt.requestId !== request.requestId ||
            receipt.hostId !== client.hostId ||
            receipt.generation !== client.generation ||
            receipt.action !== request.operation ||
            receipt.targetVersion !== request.targetVersion
          )
            throw new Error("升级回执与原请求不一致，请核查原编号");
          if (["prepared", "completed", "blocked"].includes(receipt.state)) {
            this.hostUpdateReference = null;
            await this.persistReferences();
          }
        } catch (error) {
          if (
            [
              "invalidUpdateTarget",
              "updateUnavailable",
              "invalidRequest",
              "generationMismatch",
              "stopInProgress",
            ].includes(String(desktopError(error).code))
          ) {
            this.hostUpdateReference = null;
            await this.persistReferences();
          }
          throw error;
        }
      }
      const status = await client.request("host.updateStatus", {});
      return {
        supported: true,
        restartPending: status.restartPending,
        targetVersion: status.targetVersion,
        prepareRequestId: status.prepareRequestId,
        operation: status.operation === null ? null : this.publicHostUpdate(status.operation),
      };
    } finally {
      client.close();
      this.hostUpdateInFlight = false;
    }
  }
  /** @param {unknown} value */
  publicHostUpdate(value) {
    if (!hostUpdateReceipt(value)) throw new Error("Host 升级回执无效");
    const { version, requestId, hostId, generation, action, targetVersion, state, message } = value;
    return {
      version,
      requestId,
      hostId,
      generation,
      action,
      targetVersion,
      state,
      ...(message ? { message } : {}),
    };
  }
  get serviceExited() {
    return !!this.exitConfirmation && this.exitConfirmation === this.metadata;
  }
  /** @param {boolean} [forUpdate] @param {{purpose?:string}} [options] */
  async observeLifecycle(forUpdate = true, { purpose = "manage" } = {}) {
    if (this.serviceExited) return { ifIdle: true, exited: true, blockers: [] };
    if (!this.status.connected) return { ifIdle: false, blockers: ["disconnected"] };
    const { DesktopLifecycle } = require("./lifecycle.cjs");
    return new DesktopLifecycle({
      connection: this.requireConnection(),
      metadata: this.metadata,
      home: this.home,
      forUpdate,
      purpose,
    }).observe();
  }
  lifecycleProjection() {
    /** @type {Map<string,Receipt|Reference>} */
    const visible = new Map(this.lifecycleReceipts);
    for (const [requestId, reference] of this.lifecycleReferences)
      visible.set(requestId, reference);
    /** @type {import('@areal/workbench/desktop-contract/shared').LifecycleViewOperation[]} */
    const operations = [...visible.values()].map((reference) => {
      const receipt = this.lifecycleReceipts.get(reference.requestId);
      return {
        requestId: reference.requestId,
        kind: reference.kind,
        phase: receipt?.phase ?? "admissionUnconfirmed",
        targets: (receipt?.targets ?? reference.targets).map((target) => ({
          projectId: reference.logicalProjectId ?? target.projectId,
          phase: target.phase ?? "admissionUnconfirmed",
          ...(target.error
            ? {
                message:
                  typeof target.error === "string"
                    ? target.error
                    : desktopError(target.error).message,
              }
            : {}),
        })),
        ...(reference.threadId ? { threadId: reference.threadId, turnId: reference.turnId } : {}),
        ...(receipt?.desktopExit ? { desktopExit: receipt.desktopExit } : {}),
        message:
          receipt?.message ??
          (receipt?.desktopError ? desktopError(receipt.desktopError).message : undefined) ??
          lifecycleMessage(receipt?.phase ?? "admissionUnconfirmed"),
      };
    });
    for (const reference of this.hostReferences.values())
      operations.push(projectHostReceipt(reference, this.hostReceipts.get(reference.requestId)));
    const latest = operations.at(-1);
    const legacy =
      this.legacyControl || (this.status.stopReport && this.status.lifecycle?.version !== 2);
    return {
      supported: this.status.lifecycle?.version === 2,
      operations,
      ...(this.foreignOwner
        ? {
            recovery: {
              canRecover: true,
              projects: [],
              message: "原后台属于旧应用会话。请检查并安全迁移。",
            },
          }
        : {}),
      ...(legacy
        ? {
            recovery: this.legacyRecoveryView ?? {
              canRecover: false,
              projects: [],
              message: "请检查原后台状态，再恢复工作。",
            },
          }
        : {}),
      ...((latest ?? legacy)
        ? (latest ?? {
            phase: "admissionUnconfirmed",
            targets: [],
            message: "旧停止记录缺少操作身份，已恢复观察连接。请检查原后台状态；不会重发旧操作。",
          })
        : {}),
      ...(this.lifecycleError ? { error: this.lifecycleError, message: this.lifecycleError } : {}),
    };
  }
  /** @param {unknown} error */
  reportLifecycleError(error) {
    this.lifecycleError = desktopError(error).message;
    this.onChange();
  }
  hostRecoveryState() {
    const settled = [...this.hostReferences.values()].every((reference) =>
      ["completed", "blocked"].includes(
        this.hostReceipts.get(reference.requestId)?.state ?? "admissionUnknown",
      ),
    );
    return {
      state: "unavailable",
      recovery: settled ? "reconnect" : "check",
      message: settled
        ? "原 Host 停止操作已核查，可明确重新连接后台。"
        : "原 Host 停止操作尚未结算，请检查原请求；不会自动启动或重发。",
    };
  }
  /** @returns {Promise<import('@areal/client/node').HostActivity>} */
  async readHostActivity() {
    const client = new HostClient();
    try {
      if (!this.options.hostHome) throw new Error("Host home 尚未配置");
      await client.connect(this.options.hostHome);
      return await client.activity();
    } finally {
      client.close();
    }
  }
  /** @param {import('./host-lifecycle.cjs').HostReference} reference @param {unknown} value @returns {Promise<HostLifecycleResult>} */
  async acceptHostStop(reference, value) {
    const receipt = readHostReceipt(reference, value);
    this.hostReceipts.set(reference.requestId, receipt);
    if (
      receipt.state === "completed" &&
      this.hostStopResources.get(reference.requestId) === this.terminalConnections
    ) {
      const connections = this.terminalConnections;
      await Promise.allSettled(this.guiTerminalStarts);
      connections.close();
      if (this.terminalConnections === connections) {
        this.guiTerminals.clear();
        const connection = this.connection;
        this.stoppedConnection = connection;
        this.disconnected();
        this.connection = null;
        connection?.close();
        this.connectionState = this.hostRecoveryState();
      }
    }
    if (receipt.state === "completed" || receipt.state === "blocked")
      this.hostStopResources.delete(reference.requestId);
    this.lifecycleError = null;
    this.onChange();
    return {
      stopped: receipt.state === "completed",
      operation: projectHostReceipt(reference, receipt),
      receipt,
    };
  }
  /** @param {import('./host-lifecycle.cjs').HostReference} reference @returns {Promise<HostLifecycleResult>} */
  async readHostStop(reference) {
    const client = new HostClient();
    let value;
    try {
      await client.connect(reference.home);
      if (client.hostId !== reference.hostId) throw new Error("Host identity changed");
      value = (await client.operation(reference.requestId)).operation;
    } catch {
      if (this.options.binary) value = await readOfflineHostReceipt(this.options.binary, reference);
    } finally {
      client.close();
    }
    if (value != null) return this.acceptHostStop(reference, value);
    const known = this.hostReceipts.get(reference.requestId);
    if (known)
      return {
        stopped: known.state === "completed",
        operation: projectHostReceipt(reference, known),
        receipt: known,
      };
    this.onChange();
    return { stopped: false, operation: projectHostReceipt(reference) };
  }
  /** @param {{strategy:'ifIdle'|'cancel',requestId?:string}} options @returns {Promise<HostLifecycleResult>} */
  async requestHostStop({ strategy, requestId }) {
    if (this.initializing || this.connecting)
      throw Object.assign(new Error("后台连接仍在处理中，请完成后停止 Host"), {
        code: "LIFECYCLE_BLOCKED",
      });
    if (strategy !== "ifIdle" && strategy !== "cancel") throw new Error("Host 停止策略无效");
    if (this.hostStopInFlight) return this.hostStopInFlight;
    return (this.hostStopInFlight = this.submitHostStop(strategy, requestId).finally(() => {
      this.hostStopInFlight = undefined;
    }));
  }
  /** @param {'ifIdle'|'cancel'} strategy @param {string} [requestId] @returns {Promise<HostLifecycleResult>} */
  async submitHostStop(strategy, requestId) {
    this.loadReferences(await this.readControl());
    if (requestId && !uuid(requestId)) throw new Error("Host 请求身份无效");
    const latest = [...this.hostReferences.values()].at(-1);
    const original = requestId
      ? this.hostReferences.get(requestId)
      : latest && this.hostReceipts.get(latest.requestId)?.state !== "blocked"
        ? latest
        : undefined;
    if (original) {
      if (requestId && original.strategy !== strategy)
        throw Object.assign(new Error("原 Host 请求不能更换策略"), {
          code: "LIFECYCLE_REQUEST_CONFLICT",
        });
      const result = await this.readHostStop(original);
      if (requestId || !result.stopped) return result;
      const current = new HostClient();
      try {
        await current.connect(this.options.hostHome ?? original.home);
        if (current.hostId === original.hostId && current.generation === original.generation)
          return result;
      } catch (error) {
        if (["ENOENT", "ECONNREFUSED"].includes(String(desktopError(error).code))) return result;
        throw error;
      } finally {
        current.close();
      }
    }
    if (
      requestId &&
      (this.lifecycleReferences.has(requestId) || this.lifecycleReceipts.has(requestId))
    )
      throw Object.assign(new Error("原请求身份属于其他生命周期操作"), {
        code: "LIFECYCLE_REQUEST_CONFLICT",
      });
    const client = new HostClient();
    try {
      if (!this.options.hostHome) throw new Error("Host home 尚未配置");
      await client.connect(this.options.hostHome);
      client.requireCapability("stopOperations");
      const reference = {
        kind: /** @type {const} */ ("stopHost"),
        requestId: requestId ?? randomUUID(),
        home: client.home,
        hostId: client.hostId,
        generation: client.generation,
        strategy,
      };
      this.hostReferences.set(reference.requestId, reference);
      try {
        await this.persistReferences();
      } catch (error) {
        this.hostReferences.delete(reference.requestId);
        throw error;
      }
      this.hostStopResources.set(reference.requestId, this.terminalConnections);
      this.clearReconnect();
      this.onChange();
      try {
        return this.acceptHostStop(
          reference,
          await client.stop(reference.requestId, reference.generation, strategy),
        );
      } catch {
        return this.readHostStop(reference);
      }
    } finally {
      client.close();
    }
  }
  async persistReferences() {
    const write = async () => {
      await mkdir(this.app.getPath("userData"), { recursive: true, mode: 0o700 });
      if (
        !this.lifecycleReferences.size &&
        !this.hostReferences.size &&
        !this.hostUpdateReference
      ) {
        await rm(this.controlPath, { force: true });
        return;
      }
      const temporary = `${this.controlPath}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(
            JSON.stringify({
              version: 3,
              home: this.home,
              references: [...this.lifecycleReferences.values(), ...this.hostReferences.values()],
              hostUpdate: this.hostUpdateReference,
            }),
          );
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, this.controlPath);
        if (process.platform !== "win32") {
          const directory = await open(this.app.getPath("userData"), "r");
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
        }
      } finally {
        await rm(temporary, { force: true });
      }
    };
    const pending = (this.referenceWrite ?? Promise.resolve()).catch(() => {}).then(write);
    this.referenceWrite = pending;
    return pending;
  }
  /** @param {Record<string,unknown>|null} control */
  loadReferences(control) {
    if (control?.version === 2 || control?.version === 3) {
      if (control.hostUpdate != null) {
        const update = control.hostUpdate;
        if (
          !record(update) ||
          !["requestId", "hostId", "generation", "targetVersion"].every(
            (key) => typeof update[key] === "string",
          ) ||
          !["prepare", "apply"].includes(String(update.action))
        )
          throw new Error("保存的升级请求引用无效，请保留原记录并检查");
        this.hostUpdateReference =
          /** @type {NonNullable<SharedCoreBackend['hostUpdateReference']>} */ (update);
      }
      for (const reference of readReferences(control.references)) {
        if (hostReference(reference)) this.hostReferences.set(reference.requestId, reference);
        else this.lifecycleReferences.set(reference.requestId, reference);
      }
      this.controlState = null;
    } else if (control?.state === "unconfirmed") {
      this.legacyControl = control;
      this.controlState = null;
    } else this.controlState = control?.state ?? null;
  }
  /** @param {Reference} reference @param {boolean} [reconcile] @returns {Promise<Receipt>} */
  async readLifecycle(reference, reconcile = true) {
    let receipt;
    if (this.status.connected && this.status.lifecycle?.version === 2) {
      try {
        receipt = await this.requireConnection().request(
          reconcile ? "lifecycleReconcile" : "lifecycleRead",
          { protocol: PROTOCOL, requestId: reference.requestId },
        );
      } catch (error) {
        if (
          desktopError(error).code !== "DISCONNECTED" &&
          desktopError(error).code !== "LIFECYCLE_UNSUPPORTED"
        )
          throw error;
      }
    }
    if (!receipt) {
      const {
        readLifecycleReceipt,
        reconcileLifecycleReceipt,
      } = require("./lifecycle-operations.cjs");
      const identity = {
        requestId: reference.requestId,
        desktopGeneration: reference.desktopGeneration,
      };
      receipt =
        this.options.binary && this.options.harnessHome
          ? await reconcileLifecycleReceipt(this.home, {
              ...identity,
              binary: this.options.binary,
              harnessHome: this.options.harnessHome,
            })
          : await readLifecycleReceipt(this.home, identity);
    }
    if (!receipt)
      receipt = {
        version: 1,
        requestId: reference.requestId,
        kind: reference.kind,
        mode: reference.mode,
        desktopGeneration: reference.desktopGeneration,
        desktopExit: "notRequested",
        ...(reference.threadId ? { threadId: reference.threadId, turnId: reference.turnId } : {}),
        phase: "admissionUnconfirmed",
        targets: reference.targets.map((target) => ({ ...target, phase: "admissionUnconfirmed" })),
      };
    return this.acceptLifecycleReceipt(reference, receipt);
  }
  /** @param {import('./service-control.cjs').LifecycleReference} reference @param {unknown} value @returns {Promise<Receipt>} */
  async acceptLifecycleReceipt(reference, value) {
    const receipt = readLifecycleResponse(reference, value);
    /** @type {Receipt} */
    let operation =
      desktopKind(reference.kind) && receipt.phase === "completed"
        ? { ...receipt, phase: "acceptedPending" }
        : receipt;
    if (
      desktopKind(reference.kind) &&
      ["acceptedPending", "settlementIncomplete", "completed"].includes(receipt.phase) &&
      receipt.targets.every((target) => target.phase === "completed")
    ) {
      let exited = false;
      const local =
        this.metadata?.local === true &&
        reference.desktop.pid === process.pid &&
        this.mainDesktop?.adapter.lifecycle?.generation === reference.desktopGeneration;
      if (local && receipt.desktopExit === "requested") {
        await this.mainDesktop?.close();
        exited = this.mainDesktop?.closed === true;
      } else {
        try {
          process.kill(reference.desktop.pid, 0);
        } catch (error) {
          if (desktopError(error).code === "ESRCH") exited = true;
          else throw error;
        }
        if (!exited && receipt.desktopExit === "requested") {
          try {
            await waitForProcessExit(reference.desktop.pid);
            exited = true;
          } catch (error) {
            operation = {
              ...receipt,
              phase: "acceptedPending",
              message: desktopError(error).message,
            };
          }
        }
      }
      if (exited) {
        operation = { ...receipt, phase: "completed" };
        this.exitConfirmation =
          this.metadata?.desktopGeneration === reference.desktopGeneration
            ? this.metadata
            : reference.desktop;
        if (
          this.metadata?.desktopGeneration === reference.desktopGeneration ||
          !this.status.connected
        ) {
          this.reconnectBlocked = true;
          this.clearReconnect();
        }
        // 完整停止回执和进程退出共同证明旧终端已清理，不能依赖连接是否先断开。
        if (this.metadata?.desktopGeneration === reference.desktopGeneration) {
          this.guiTerminals.clear();
          if (this.status.connected) {
            const connection = this.connection;
            this.stoppedConnection = connection;
            this.disconnected();
            this.connection = null;
            connection?.close();
          }
        }
      }
    }
    if (reference.logicalProjectId)
      operation = { ...operation, logicalProjectId: reference.logicalProjectId };
    this.lifecycleReceipts.set(reference.requestId, operation);
    if (
      operation.phase === "blocked" ||
      (operation.phase === "completed" && !desktopKind(reference.kind))
    ) {
      this.lifecycleReferences.delete(reference.requestId);
      await this.persistReferences();
    }
    this.lifecycleError = null;
    this.onChange();
    return operation;
  }
  /** @param {Metadata|null} [source] */
  assertMigrationProfile(source = this.foreignOwner) {
    const owner = record(source?.applicationOwner) ? source.applicationOwner : undefined;
    if (owner?.profile && owner.profile !== this.applicationOwner?.profile)
      throw Object.assign(new Error(`原后台属于另一配置目录，请从 ${owner.profile} 退出原应用。`), {
        code: "APPLICATION_OWNER_MISMATCH",
      });
  }
  /** @param {unknown} [migration] */
  assertApplicationWrite(migration) {
    if (!this.foreignOwner) return;
    this.assertMigrationProfile();
    if (migration !== this.foreignOwner || migration !== this.metadata)
      throw Object.assign(new Error("原后台仅供观察，请通过安全迁移入口处理原应用会话"), {
        code: "APPLICATION_OWNER_MISMATCH",
      });
  }
  /** @param {Notify} notify */
  async recoverForeignOwner(notify) {
    const source = this.foreignOwner;
    this.assertMigrationProfile(source);
    const answer = await notify({
      type: "warning",
      message: "安全停止旧应用会话并迁移？",
      detail:
        "原后台没有被本次应用接管。将核对原代际、任务和清理回执，停止成功后才启动本次应用的后台。未知操作不会重发。",
      buttons: ["返回应用", "检查并迁移"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (answer.response !== 1) return { canceled: true };
    const result = await require("./startup-recovery.cjs").recoverConnectedService({
      backend: this,
      notify,
      purpose: "stop",
      migration: source,
    });
    if (!("stopped" in result) || !result.stopped) return result;
    this.foreignOwner = null;
    this.lifecycleReferences.clear();
    this.lifecycleReceipts.clear();
    await this.persistReferences();
    this.connection?.close();
    this.connection = null;
    await this.initialize(false);
    this.controlState = null;
    this.reconnectBlocked = false;
    return { recovered: true };
  }
  /** @param {{notify:Notify}} options @returns {Promise<unknown>} */
  async recoverBackend({ notify }) {
    this.assertMigrationProfile();
    if (this.recoveryInFlight) return this.recoveryInFlight;
    this.recoveryInFlight = (async () => {
      await this.checkLifecycle();
      if (this.foreignOwner && this.status.lifecycle?.version === 2)
        return this.recoverForeignOwner(notify);
      if (this.legacyControl || (this.status.stopReport && this.status.lifecycle?.version !== 2))
        return require("./legacy-desktop-recovery.cjs").recover(this, notify);
      const pending = [...this.lifecycleReferences.values()];
      if (!pending.length && this.hostReferences.size) {
        if (this.hostRecoveryState().recovery === "check")
          throw new Error("原 Host 操作仍待确认，请继续检查原请求；不会重发");
        await this.init();
        return { recovered: true };
      }
      if (!pending.length) return { recovered: false };
      if (
        pending.some((reference) =>
          needsOriginalCheck(
            this.lifecycleReceipts.get(reference.requestId) ?? {
              phase: "admissionUnconfirmed",
              targets: [],
            },
          ),
        )
      )
        throw new Error("原后台操作仍待确认，请继续检查原请求；不会重发");
      const completedStop =
        pending.length &&
        pending.every(
          (reference) =>
            reference.kind === "stopDesktop" &&
            this.lifecycleReceipts.get(reference.requestId)?.phase === "completed",
        );
      if (completedStop) {
        await this.init();
        return { recovered: true };
      }
      // Other current-protocol operations retain their explicit stop/update
      // actions. A resource inspection must not introduce a new update intent.
      return { recovered: false, lifecycle: this.lifecycleProjection() };
    })().finally(() => {
      this.recoveryInFlight = null;
    });
    return this.recoveryInFlight;
  }
  async checkLifecycle() {
    this.loadReferences(await this.readControl());
    this.clearReconnect();
    if (!this.status.connected && (this.lifecycleReferences.size || !this.hostReferences.size))
      await this.attach();
    for (const reference of Array.from(this.hostReferences.values()))
      await this.readHostStop(reference);
    if (
      this.hostReferences.size &&
      !this.lifecycleReferences.size &&
      (!this.status.connected || this.connectionState.recovery)
    )
      this.connectionState = this.hostRecoveryState();
    for (const reference of Array.from(this.lifecycleReferences.values()))
      await this.readLifecycle(reference);
    if (this.legacyControl || (this.status.stopReport && this.status.lifecycle?.version !== 2)) {
      try {
        await require("./legacy-desktop-recovery.cjs").inspect(this);
      } catch (error) {
        this.legacyRecoveryView = {
          canRecover: false,
          projects: [],
          message: desktopError(error).message,
        };
      }
    }
    this.lifecycleError = null;
    this.onChange();
    return this.lifecycleProjection();
  }
  /** @param {string} name @param {Record<string,unknown>} [request] */
  assertLifecycleScope(name, request = {}) {
    if (this.foreignOwner)
      throw Object.assign(new Error("原后台属于旧应用会话，请先检查并安全迁移"), {
        code: "APPLICATION_OWNER_MISMATCH",
      });
    if (
      ["list", "open", "reconcile", "queue"].includes(name) ||
      require("./lifecycle.cjs").isRecoveryCommand(name, request)
    )
      return;
    if (
      (this.legacyControl?.legacyRecovery || this.status.stopReport) &&
      this.status.lifecycle?.version !== 2
    )
      throw Object.assign(new Error("请先检查并恢复原后台，再继续工作。输入和历史已保留。"), {
        code: "LIFECYCLE_INCOMPLETE",
      });
    for (const reference of this.hostReferences.values()) {
      if (this.hostReceipts.get(reference.requestId)?.state === "blocked") continue;
      throw Object.assign(new Error("原 Host 停止操作尚未恢复，请检查原请求或明确重新连接"), {
        code: "LIFECYCLE_INCOMPLETE",
        requestId: reference.requestId,
      });
    }
    for (const reference of this.lifecycleReferences.values()) {
      const operation = this.lifecycleReceipts.get(reference.requestId);
      if (["blocked", "completed"].some((phase) => phase === operation?.phase)) continue;
      if (reference.kind === "interruptTurn" && reference.threadId !== request.threadId) continue;
      const target = (operation?.targets ?? reference.targets).find(
        (target) =>
          target.projectId === request.projectId ||
          reference.logicalProjectId === request.projectId,
      );
      if (target && !["blocked", "completed"].some((phase) => phase === target.phase))
        throw Object.assign(new Error("此任务的原后台操作尚未结算，请检查原请求"), {
          code: "LIFECYCLE_INCOMPLETE",
          requestId: reference.requestId,
        });
    }
  }
  /** @param {LifecycleOptions} options @returns {Promise<LifecycleResult>} */
  async requestLifecycle({
    kind,
    mode = "ifIdle",
    observed,
    projectId,
    threadId,
    turnId,
    requestId = randomUUID(),
    migration,
  }) {
    this.assertApplicationWrite(migration);
    if (!this.status.connected) throw new Error("后台尚未连接，请先重新连接后台");
    const originalReference = this.lifecycleReferences.get(requestId);
    const previous = originalReference ?? this.lifecycleReceipts.get(requestId);
    if (previous) {
      if (
        previous.kind !== kind ||
        previous.mode !== mode ||
        previous.threadId !== threadId ||
        previous.turnId !== turnId ||
        (projectId &&
          (previous.logicalProjectId
            ? previous.logicalProjectId !== projectId
            : !previous.targets.some((target) => target.projectId === projectId)))
      )
        throw Object.assign(new Error("原请求身份不能绑定其他操作或轮次"), {
          code: "LIFECYCLE_REQUEST_CONFLICT",
        });
      const operation = originalReference
        ? await this.readLifecycle(originalReference)
        : this.lifecycleReceipts.get(requestId);
      if (!operation) throw new Error("原生命周期回执已移除，请重新核查");
      return { stopped: operation.phase === "completed", operation };
    }
    if (desktopKind(kind)) {
      for (const reference of this.lifecycleReferences.values()) {
        if (!desktopKind(reference.kind)) continue;
        const operation = await this.readLifecycle(reference);
        if (needsOriginalCheck(operation)) return { stopped: false, operation };
      }
    }
    const { DesktopLifecycle } = require("./lifecycle.cjs");
    const intent = await new DesktopLifecycle({
      connection: this.requireConnection(),
      metadata: this.metadata,
      home: this.home,
      forUpdate: desktopKind(kind),
      purpose: kind === "stopDesktop" && observed?.purpose === "quit" ? "quit" : "manage",
    }).prepare({ kind, mode, observed, projectId, threadId, turnId });
    if (!this.metadata) throw new Error("后台连接元数据不可用");
    /** @type {Reference} */
    const reference = {
      requestId,
      kind,
      mode,
      desktopGeneration: intent.expectedDesktopGeneration,
      targets: intent.expectedTargets,
      desktop: { pid: this.metadata.pid, identity: this.metadata.identity },
      ...(kind === "interruptTurn" ? { threadId, turnId, logicalProjectId: projectId } : {}),
    };
    this.lifecycleReferences.set(requestId, reference);
    try {
      await this.persistReferences();
    } catch (error) {
      this.lifecycleReferences.delete(requestId);
      throw error;
    }
    this.lifecycleError = null;
    this.onChange();
    let operation;
    try {
      const receipt = await this.requireConnection().request(
        "lifecycleRequest",
        { protocol: PROTOCOL, requestId, ...intent },
        true,
      );
      if (!receipt) throw Object.assign(new Error("后台操作回执缺失"), { submissionUnknown: true });
      operation = await this.acceptLifecycleReceipt(reference, receipt);
    } catch (error) {
      if (
        !desktopError(error).submissionUnknown &&
        [...notAdmittedCodes].some((code) => code === desktopError(error).code)
      ) {
        this.lifecycleReferences.delete(requestId);
        await this.persistReferences();
        throw error;
      }
      operation = await this.readLifecycle(reference);
    }
    return {
      stopped: operation.phase === "completed",
      operation,
      ...(desktopKind(kind) && operation.phase === "completed" ? { kind: "exited" } : {}),
    };
  }
  /** @param {boolean} [forUpdate] @param {{kind?:import("./lifecycle-operations.cjs").LifecycleKind,cancel?:boolean,observed?:Observation,migration?:unknown}} [options] */
  async stopService(forUpdate = false, options = {}) {
    return this.requestLifecycle({
      kind: options.kind ?? (forUpdate ? "updateDesktop" : "stopDesktop"),
      mode: options.cancel ? "cancel" : "ifIdle",
      observed: options.observed,
      migration: options.migration,
    });
  }
  /** @param {{notify?:Notify}} [options] */
  async applyUpdate({ notify } = {}) {
    if (this.foreignOwner) {
      if (!notify) throw new Error("后台迁移需要原生确认");
      return this.recoverForeignOwner(notify);
    }
    try {
      const pending = [...this.lifecycleReferences.values()].find(
        (reference) =>
          reference.kind === "updateDesktop" &&
          this.lifecycleReceipts.get(reference.requestId)?.phase !== "blocked",
      );
      let result;
      if (pending) {
        await this.checkLifecycle();
        const operation = this.lifecycleReceipts.get(pending.requestId);
        if (operation?.phase === "completed" || (operation && needsOriginalCheck(operation)))
          result = { stopped: operation?.phase === "completed", operation };
      }
      if (!result) {
        require("./lifecycle.cjs").assertLifecycleSupport(this.status, "updateDesktop");
        if (!this.options.binary) throw new Error("Core 程序路径不可用");
        await inspectCoreCapabilities(this.options.binary);
        this.backendUpdate = { state: "applying" };
        this.onChange();
        result = await require("./startup-recovery.cjs").recoverConnectedService({
          backend: this,
          notify,
          purpose: "update",
          forUpdate: true,
        });
      }
      if (!("stopped" in result) || !result.stopped) {
        this.backendUpdate = { state: "pending" };
        this.onChange();
        return result;
      }
      this.connection?.close();
      this.connection = null;
      this.reconnectBlocked = true;
      this.connectionState = { state: "connecting" };
      this.onChange();
      await this.initialize(false);
      for (const [requestId, reference] of this.lifecycleReferences) {
        if (
          desktopKind(reference.kind) &&
          reference.desktopGeneration === result.operation.desktopGeneration
        ) {
          this.lifecycleReferences.delete(requestId);
          this.lifecycleReceipts.delete(requestId);
        }
      }
      await this.persistReferences();
      this.controlState = null;
      this.reconnectBlocked = false;
      this.backendUpdate = undefined;
      this.onChange();
      return result;
    } catch (error) {
      this.backendUpdate = { state: "failed", message: desktopError(error).message };
      this.reportLifecycleError(error);
      throw error;
    }
  }
  async settleGuiTerminals() {
    // Main has closed GUI admission, but a create or receipt lookup accepted
    // before quit can still acquire a handle. Wait for both before cleanup.
    // Keep unknown outcomes visible; never replay a create.
    const starts = await Promise.allSettled(this.guiTerminalStarts);
    /** @type {PromiseSettledResult<void>[]} */
    const results = [];
    // Terminals in one Thread share its mutation journal. Parallel terminate
    // calls can reject each other as unresolved submissions during normal quit.
    // Continue checking every owned handle even when one cleanup fails.
    for (const terminal of Array.from(this.guiTerminals.values())) {
      try {
        if (!this.status.connected)
          throw new Error("后台已断开，GUI 终端清理未确认，请从后台资源入口检查");
        /** @param {string} operation @param {boolean} [mutation] */
        const call = (operation, mutation = false) =>
          this.requireConnection().request(
            "guiTerminalCommand",
            { name: "manage", request: { ...terminal, operation } },
            mutation,
          );
        const before = readGuiProcesses(await call("processes")).find((p) => p.id === terminal.id);
        if (!before) throw new Error("找不到 GUI 终端，无法确认资源清理");
        if (!before.cleanupConfirmed) {
          await call("processTerminate", true);
          if (
            !readGuiProcesses(await call("processes")).find((p) => p.id === terminal.id)
              ?.cleanupConfirmed
          )
            throw new Error("GUI 终端资源清理尚未确认");
        }
        this.guiTerminals.delete(terminal.id);
        results.push({ status: "fulfilled", value: undefined });
      } catch (reason) {
        results.push({ status: "rejected", reason });
      }
    }
    const failed = [...starts, ...results].find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  }
  /** @param {{keepBackground?:boolean}} [options] */
  async completeApplicationQuit({ keepBackground = false } = {}) {
    if (keepBackground) return;
    for (const reference of this.hostReferences.values()) {
      if (this.hostReceipts.get(reference.requestId)?.state !== "completed")
        throw Object.assign(new Error("原 Host 停止请求尚未完成"), {
          code: "LIFECYCLE_INCOMPLETE",
        });
    }
    for (const reference of this.lifecycleReferences.values()) {
      if (this.lifecycleReceipts.get(reference.requestId)?.phase !== "completed")
        throw Object.assign(new Error("原生命周期请求尚未完成，不能结束应用会话"), {
          code: "LIFECYCLE_INCOMPLETE",
        });
    }
    this.lifecycleReferences.clear();
    await this.persistReferences();
    this.controlState = null;
  }
  async waitForApplicationReady() {
    if (this.connecting) await this.connecting.catch(() => {});
    const deadline = Date.now() + 20000;
    while (this.status.connected) {
      const { service } = readServicePacket(
        await this.requireConnection().request("snapshot"),
        this.metadata,
      );
      if (!service.starting && !service.activeCommands) return;
      if (Date.now() >= deadline)
        throw Object.assign(new Error("项目启动或已受理操作仍在完成，请稍后退出"), {
          code: "LIFECYCLE_BLOCKED",
        });
      await sleep(100);
    }
  }
  async prepareQuit() {
    await this.settleGuiTerminals();
  }
  async shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.disposed = true;
    this.genUiState.dispose();
    this.clearReconnect();
    return (this.shutdownPromise = (async () => {
      try {
        await this.settleGuiTerminals();
        if (this.status.connected)
          await this.requireConnection()
            .request("activity", { focused: false, idleSeconds: 0 })
            .catch(() => {});
      } finally {
        this.terminalConnections.close();
        this.connection?.close();
        await this.mainDesktop?.close();
      }
    })());
  }
}
/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  SharedCoreBackend,
  ServiceConnection,
  waitForServiceExit,
  waitForServiceProcessExit,
  waitForProcessExit,
};
