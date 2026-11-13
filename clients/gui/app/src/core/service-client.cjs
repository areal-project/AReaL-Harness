// @ts-check
"use strict";
const { requiresCurrentCommands } = require("./service-command-compatibility.cjs");
const {
  operationCore,
  observedOperation,
} = require("@areal/workbench-service/desktop/core/receipt-contract.cjs");
const { commandSemantics, desktopError } = require("@areal/workbench/desktop-contract");
const { startupTrace } = require("@areal/workbench-service/desktop/core/startup-timing.cjs");
const { randomUUID } = require("node:crypto");
const { mkdir, readFile, realpath, writeFile, rename, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { HostClient, executeHost } = require("@areal/client/node");
const { hostUpdateReceipt } = require("@areal/workbench/desktop-contract/desktop-control");
const {
  readHostReceipt,
  projectHostReceipt,
  readOfflineHostReceipt,
} = require("./host-lifecycle.cjs");
const { NativeTerminalOwners } = require("@areal/workbench-service/native-host-transport");
const { ServiceConnection } = require("./service-connection.cjs");
const {
  readServicePacket,
  ownsThread,
  retainsThreadResources,
} = require("@areal/workbench-service/desktop/core/service-state.cjs");
const {
  readGuiProcesses,
  readGuiThreadIdentity,
  readGuiProcessResponse,
} = require("./gui-resource-contract.cjs");
const lifecycleControl = require("./service-control.cjs");
const { desktopKind, needsOriginalCheck } = lifecycleControl;
const {
  PROTOCOL,
  COMMAND_CONTRACT,
  encodeMedia,
  decodeMedia,
} = require("@areal/workbench-service/desktop/core/service-protocol.cjs");
const {
  genUiScope,
  createGenUiState,
} = require("@areal/workbench-service/desktop/core/gen-ui-state.cjs");
const { checkHostPrerequisites } = require("./host-prerequisites.cjs");
/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** @param {unknown} value @returns {value is string} */
const uuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
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

/** @typedef {import('./service-connection.cjs').ServiceMetadata|ReturnType<InstanceType<typeof import('@areal/workbench-service/desktop/core/service-protocol.cjs').DesktopService>['connectMain']>['metadata']} Metadata */
/** @typedef {import('./service-control.cjs').LifecycleReference} Reference */
/** @typedef {import('./service-control.cjs').LifecycleResponse} Receipt */
/** @typedef {import('./lifecycle.cjs').RecoveryObservation} Observation */
/** @typedef {import('@areal/workbench-service/desktop/core/resource-recovery.cjs').Notify} Notify */
/** @typedef {{projectId:string,threadId:string,id:string}} GuiTerminal */
/** @typedef {{focused:boolean,idleSeconds:number,suspended?:boolean}} Activity */
/** @typedef {{kind:import('@areal/workbench-service/desktop/core/lifecycle-operations.cjs').LifecycleKind,mode?:import('@areal/workbench-service/desktop/core/lifecycle-operations.cjs').LifecycleMode,observed?:Observation,projectId?:string,threadId?:string,turnId?:string,requestId?:string,migration?:unknown}} LifecycleOptions */
/** @typedef {{stopped:boolean,operation:Receipt,kind?:string}} LifecycleResult */
/** @typedef {{stopped:boolean,operation:import('@areal/workbench/desktop-contract/shared').LifecycleViewOperation,receipt?:import('./host-lifecycle.cjs').HostReceipt}} HostLifecycleResult */
// GUI-local connection/projection only. Control intent lives in GUI userData;
// shared Core history and execution state remain owned by the service.
/** @typedef {Omit<Partial<import('@areal/workbench-service/desktop/core/backend.cjs').CoreBackendOptions>,'home'|'onChange'> & {home:string,configHome?:string,app:Pick<Electron.App,'getPath'> & Partial<Pick<Electron.App,'isPackaged'|'getAppPath'>>,onChange?:()=>void,onNotification?:(value:unknown)=>void,onNotificationOpen?:(value:unknown)=>void,onRecoveryAttention?:(value:unknown)=>void,prerequisiteCheck?:typeof checkHostPrerequisites}} SharedBackendOptions */
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
    /** @type {import("@areal/workbench-service/desktop/core/service-state.cjs").ServiceSnapshot} */
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
    /** @type {Partial<import('@areal/workbench-service/desktop/core/resource-observation.cjs').RecoveryService>} */
    this.status = { connected: false };
    this.sequence = -1;
    /** @type {{state:string,message?:string,recovery?:string,prerequisite?:unknown}} */
    this.connectionState = { state: "connecting" };
    this.revision = 0;
    this.initializing = false;
    /** @type {Map<string,GuiTerminal>} */
    this.guiTerminals = new Map();
    this.terminalConnections = NativeTerminalOwners.forOwner(this);
    /** @type {Set<Promise<unknown>>} */
    this.guiTerminalStarts = new Set();
    /** @type {Map<string,Reference>} */
    this.lifecycleReferences = new Map();
    /** @type {Map<string,import('./host-lifecycle.cjs').HostReference>} */
    this.hostReferences = new Map();
    /** @type {{requestId:string,hostId:string,generation:string,action:'prepare'|'apply',targetVersion:string}|null} */
    this.hostUpdateReference = null;
    this.hostUpdateInFlight = false;
    /** @type {Map<string,import('./host-lifecycle.cjs').HostReceipt>} */
    this.hostReceipts = new Map();
    /** @type {Map<string,InstanceType<typeof NativeTerminalOwners>>} */
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
  /** @param {import("@areal/workbench-service/desktop/core/gen-ui-state.cjs").GenUiProject} project @param {string} threadId */
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
    return ownsThread(this.value, projectId, threadId);
  }
  async ensureBrowserThread(projectId, threadId) {
    if (!this.status.connected) await this.init(); if (this.ownsThread(projectId, threadId)) return; const connection = this.requireConnection(); await this.command("open", { projectId, threadId }); const packet = await connection.request("snapshot"); if (connection !== this.connection || !this.status.connected) throw new Error("后台连接已变化，请重试"); this.accept(packet); if (!this.ownsThread(projectId, threadId)) throw new Error("请选择已连接 Core 的有效任务");
  }
  /** @param {string} projectId @param {string} threadId */
  retainsThreadResources(projectId, threadId) {
    return retainsThreadResources(this.value, projectId, threadId);
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
      ...require("@areal/workbench-service/desktop/core/resource-observation.cjs").readRecoveryService(
        checked.service,
      ),
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
        await this.initializeHostBackend({ recover: true });
        for (const reference of this.lifecycleReferences.values())
          await this.readLifecycle(reference);
      })()
        .catch(
          /** @param {unknown} error */ (error) => {
            if (
              desktopError(error).submissionUnknown !== true &&
              (desktopError(error).code === "DISCONNECTED" ||
                desktopError(error).code === "CAPABILITY_UNAVAILABLE" ||
                (desktopError(error).code === "TIMEOUT" &&
                  desktopError(error).recovery?.kind === "retryRead"))
            )
              return;
            this.reconnectBlocked = true;
            this.connectionState = {
              state: "unavailable",
              message: desktopError(error).message,
            };
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
    this.terminalConnections = NativeTerminalOwners.forOwner(this);
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
    let hostOwned = false;
    {
      const host = new HostClient();
      try {
        if (!this.options.hostHome) throw new Error("Host 目录不可用");
        await host.connect(this.options.hostHome);
        const status = await host.request("backend.status", {});
        hostOwned =
          status.owned === true &&
          status.hostId === host.hostId &&
          status.generation === host.generation &&
          status.service?.pid === metadata.pid &&
          status.service?.identity === metadata.identity &&
          status.service?.desktopGeneration === metadata.desktopGeneration;
        if (!hostOwned) throw new Error("Host 未确认此后台的所有权，请检查原后台");
      } catch (error) {
        connection.close();
        throw error;
      } finally {
        host.close();
      }
    }
    this.foreignOwner = hostOwned ? null : metadata;
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
            notifications: hostOwned && !!this.onNotification,
            capabilities: hostOwned ? { computerHost: 1, projection: 1 } : {},
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
    if (hostOwned) this.identity = metadata.identity;
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
        this.connectionState = {
          state: "unavailable",
          message: "后台服务已停止，可按需重新连接",
        };
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
      await this.initialize();
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
  /** @returns {Promise<void>} */
  async initialize() {
    const trace = startupTrace("service.initialize");
    try {
      await mkdir(this.home, { recursive: true, mode: 0o700 });
      this.home = await realpath(this.home);
      if (this.disposed) throw new Error("GUI 连接已关闭");
      await this.initializeHostBackend();
      trace.finish("ok");
    } catch (error) {
      trace.finish("error", error);
      throw error;
    }
  }
  async initializeHostBackend({ recover = false } = {}) {
    if (!recover)
      await this.prerequisiteCheck({ app: { isPackaged: this.app.isPackaged === true } });
    const options = {
      ...this.options,
      home: this.home,
      userHome: this.options.userHome ?? this.app.getPath("home"),
    };
    if (!options.binary || !options.hostHome || !options.guiProfile || !options.harnessHome)
      throw new Error("Host 后台启动配置不完整");
    // 初次旧凭据导入仍由持有原单实例和 safeStorage 的 Main 完成。
    const {
      GuiHostProjects,
    } = require("@areal/workbench-service/desktop/core/gui-host-projects.cjs");
    const source = new GuiHostProjects({
      binary: options.binary,
      home: options.hostHome,
      source: {
        profile: options.guiProfile,
        coreHome: this.home,
        legacyServiceHome: options.harnessHome,
      },
      encryption: require("electron").safeStorage,
      singletonHeld: true,
    });
    try {
      if (recover) await source.client.connect(options.hostHome);
      else await source.init({ deferCredentials: true });
      const owner = await source.ensureBackend(options, process.env);
      if (this.disposed) throw new Error("GUI 连接已关闭");
      if (!(await this.attach({ expectedIdentity: owner.identity })))
        throw new Error("Host 后台尚未就绪");
      this.backendUpdate = undefined;
    } finally {
      source.close();
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
    if (
      ["send", "steer", "editMessage"].includes(name) ||
      (name === "side" && request.operation === "send")
    ) {
      const project = this.saved.find((project) => project.id === request.projectId);
      if (project) {
        if (typeof request.threadId !== "string")
          throw Object.assign(new Error("无效桌面任务身份"), {
            code: "INVALID_DESKTOP_REQUEST",
          });
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
        if (ownedScope) {
          const response = readGuiProcessResponse(value, params.requestId, ownedRecovery);
          if (response.confirmed)
            this.guiTerminals.set(response.id, { ...ownedScope, id: response.id });
        }
        return name === "media" ? decodeMedia(value) : value;
      });
    if (ownedStart || ownedRecovery) this.guiTerminalStarts.add(pending);
    try {
      return await pending;
    } catch (error) {
      const details = desktopError(error);
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
    const projects =
      require("@areal/workbench-service/desktop/core/resource-observation.cjs").readResourceInspections(
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
        require("@areal/workbench-service/desktop/core/resource-observation.cjs").readRecoveryService(
          service,
        ),
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
    const { stdout } = await executeHost(
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

  hostUpdate(request) {
    return lifecycleControl.hostUpdate.call(this, request);
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
    return lifecycleControl.lifecycleProjection.call(this);
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

  persistReferences() {
    return lifecycleControl.persistReferences.call(this);
  }
  /** @param {Record<string,unknown>|null} control */

  loadReferences(control) {
    return lifecycleControl.loadReferences.call(this, control);
  }
  /** @param {Reference} reference @param {boolean} [reconcile] @returns {Promise<Receipt>} */

  readLifecycle(reference, reconcile = true) {
    return lifecycleControl.readLifecycle.call(this, reference, reconcile);
  }
  /** @param {import('./service-control.cjs').LifecycleReference} reference @param {unknown} value @returns {Promise<Receipt>} */

  acceptLifecycleReceipt(reference, value) {
    return lifecycleControl.acceptLifecycleReceipt.call(this, reference, value);
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
    await this.initialize();
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
    return lifecycleControl.assertLifecycleScope.call(this, name, request);
  }
  /** @param {LifecycleOptions} options @returns {Promise<LifecycleResult>} */

  requestLifecycle(options) {
    return lifecycleControl.requestLifecycle.call(this, options);
  }
  /** @param {boolean} [forUpdate] @param {{kind?:import("@areal/workbench-service/desktop/core/lifecycle-operations.cjs").LifecycleKind,cancel?:boolean,observed?:Observation,migration?:unknown}} [options] */
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
      await this.initialize();
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
