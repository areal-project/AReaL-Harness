// @ts-check
"use strict";
const { commandSemantics, desktopError } = require("@areal/workbench/desktop-contract");
const { startupTrace } = require("@areal/workbench/node/startup-timing");
const { createHash, randomUUID } = require("node:crypto");
const { mkdir, open, readFile, realpath, rm } = require("node:fs/promises");
const { constants: fsConstants } = require("node:fs");
const { join } = require("node:path");
const { HostClient, executeHost } = require("@areal/client/node");
const { hostUpdateReceipt } = require("@areal/workbench/desktop-contract/desktop-control");
const {
  readHostReceipt,
  projectHostReceipt,
  readOfflineHostReceipt,
} = require("./host-lifecycle.cjs");
/** @type {typeof import("./native-host-transport")} */
const {
  NativeTerminalOwners,
  createNativeHostTransport,
  createNativeShellTransport,
} = require("./generated/native-host-transport.cjs");
const {
  readGuiProcesses,
  readGuiThreadIdentity,
  readGuiProcessResponse,
} = require("./gui-resource-contract.cjs");
const lifecycleControl = require("./service-control.cjs");
const { desktopKind, needsOriginalCheck } = lifecycleControl;
const { checkHostPrerequisites } = require("./host-prerequisites.cjs");
/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** @param {unknown} error */
function canRetryConnection(error) {
  const failure = desktopError(error);
  return (
    failure.submissionUnknown !== true &&
    (["SERVICE_NOT_READY", "DISCONNECTED", "CAPABILITY_UNAVAILABLE"].some(
      (code) => code === failure.code,
    ) ||
      (failure.code === "TIMEOUT" && failure.recovery?.kind === "retryRead"))
  );
}
/** @param {unknown} value @returns {value is string} */
const uuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
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

/** @typedef {import('./service-control.cjs').LifecycleReference} Reference */
/** @typedef {import('./service-control.cjs').LifecycleResponse} Receipt */
/** @typedef {import('./host-quit.cjs').Notify} Notify */
/** @typedef {{projectId:string,threadId:string,id:string}} GuiTerminal */
/** @typedef {{stopped:boolean,operation:import('@areal/workbench/desktop-contract/shared').LifecycleViewOperation,receipt?:import('./host-lifecycle.cjs').HostReceipt}} HostLifecycleResult */
// GUI-local connection/projection only. Control intent lives in GUI userData;
// shared Core history and execution state remain owned by the service.
/** @typedef {Omit<Partial<ReturnType<typeof import('./service-config.cjs').serviceOptions>>,'home'> & {home:string,configHome?:string,app:Pick<Electron.App,'getPath'> & Partial<Pick<Electron.App,'isPackaged'|'getAppPath'>>,onChange?:()=>void,onNotification?:(value:unknown)=>void,prerequisiteCheck?:typeof checkHostPrerequisites}} SharedBackendOptions */
class SharedCoreBackend {
  /** @param {SharedBackendOptions} options */
  constructor({
    app,
    onChange = () => {},
    onNotification,
    prerequisiteCheck = checkHostPrerequisites,
    ...options
  }) {
    /** @type {Promise<void>|null|undefined} */
    this.connecting = undefined;
    /** @type {NodeJS.Timeout|null|undefined} */
    this.reconnectTimer = undefined;
    /** @type {number|undefined} */
    this.reconnectAttempts = undefined;
    /** @type {boolean|undefined} */
    this.reconnectBlocked = undefined;
    /** @type {{hostId:string,generation:string}|undefined} */
    this.verifiedDesktopHost = undefined;
    /** @type {boolean|undefined} */
    this.disposed = undefined;
    /** @type {string|undefined} */
    this.identity = undefined;
    /** @type {unknown} */
    this.controlState = undefined;
    this.unidentifiedStop = false;
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
    /** @type {(()=>void)|undefined} */
    this.onBrowserDisconnected = undefined;
    /** @type {Awaited<ReturnType<typeof createNativeHostTransport>>|undefined} */
    this.nativeBrowser = undefined;
    /** @type {Awaited<ReturnType<typeof createNativeShellTransport>>|undefined} */
    this.nativeShell = undefined;
    /** @type {ReturnType<typeof createNativeHostTransport>|undefined} */
    this.nativeBrowserConnecting = undefined;
    /** @type {object|undefined} */
    this.nativeBrowserEpoch = undefined;
    /** @type {string|undefined} */
    this.nativeBrowserSource = undefined;
    /** @type {Record<string,unknown>} */
    this.nativeNetworkSettings = {};
    /** @type {Map<string,import('./native-host-transport').DesktopThreadScope>} */
    this.nativeBrowserScopes = new Map();
    /** @type {((frame:import('./native-host-transport').DesktopCallback,signal:AbortSignal)=>Promise<unknown>)|undefined} */
    this.onNativeBrowserRequest = undefined;
    /** @type {((projectId:string,threadId:string)=>void)|undefined} */
    this.onNativeBrowserRevoked = undefined;
    this.prerequisiteCheck = prerequisiteCheck;
    this.onNotification = onNotification;
    this.app = app;
    this.options = options;
    this.home = options.home;
    this.onChange = onChange;
    /** @type {import("@areal/workbench/desktop-contract/shared").DesktopSnapshot} */
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
    /** @type {Partial<import('@areal/workbench/desktop-contract/desktop-control-resources').RecoveryService>} */
    this.status = { connected: false };
    /** @type {{state:string,stage?:string,message?:string,recovery?:string,prerequisite?:unknown}} */
    this.connectionState = { state: "connecting" };
    /** @type {string|undefined} */
    this.startupStage = undefined;
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
  }
  get saved() {
    return this.value.projects;
  }
  /** @param {string} projectId @param {string} threadId */
  nativeBrowserScope(projectId, threadId) {
    const scope = this.nativeBrowserScopes.get(JSON.stringify([projectId, threadId]));
    return scope && this.nativeBrowserEpoch && !this.disposed ? scope : undefined;
  }
  /** @param {import('./native-host-transport').DesktopCallback} frame */
  nativeBrowserCurrent(frame) {
    if (!this.nativeBrowserEpoch || this.disposed || !record(frame.params)) return false;
    const scope = this.nativeBrowserScopes.get(
      JSON.stringify([frame.guiProjectId, frame.params.threadId]),
    );
    return (
      !!scope &&
      scope.lease === frame.lease &&
      scope.coreInstanceId === frame.coreInstanceId &&
      scope.coreGeneration === frame.coreGeneration &&
      scope.connectionId === frame.connectionId
    );
  }
  /** @param {string} projectId @param {string} threadId */
  browserCoreIdentity(projectId, threadId) {
    return this.nativeBrowserScope(projectId, threadId)?.coreInstanceId ?? null;
  }
  /** @param {Record<string,unknown>} request */
  nativeBrowserWorkspace(request) {
    if (typeof request.projectId !== "string" || typeof request.threadId !== "string")
      return undefined;
    const scope = this.nativeBrowserScope(request.projectId, request.threadId);
    if (!scope || !this.ownsThread(request.projectId, request.threadId)) return undefined;
    const project = this.value.projects.find((project) => project.id === request.projectId);
    return {
      ...project,
      id: request.projectId,
      state: project?.state ?? null,
      root: scope.workspacePath,
      executionProjectId: scope.projectId,
    };
  }
  /** @param {string} method @param {Record<string,unknown>} params */
  async nativeBrowserCall(method, params) {
    const epoch = this.nativeBrowserEpoch;
    const transport = this.nativeBrowser ?? (await this.nativeBrowserConnecting);
    if (!epoch || this.nativeBrowserEpoch !== epoch || !transport || transport.closed)
      throw new Error("Native browser attachment unavailable");
    return transport.call(method, params);
  }

  closeNativeBrowser() {
    this.verifiedDesktopHost = undefined;
    this.nativeBrowserEpoch = undefined;
    this.nativeBrowserSource = undefined;
    this.nativeNetworkSettings = {};
    const original = this.nativeBrowser;
    this.nativeBrowser = undefined;
    this.nativeBrowserConnecting = undefined;
    this.nativeBrowserScopes.clear();
    this.nativeShell?.close();
    this.nativeShell = undefined;
    original?.close();
    if (original) this.onBrowserDisconnected?.();
  }
  /** @param {InstanceType<typeof import('@areal/client/gui-source').GuiSourceSession>} source
   * @param {Record<string,unknown>} options */
  async connectNativeBrowser(source, options) {
    this.closeNativeBrowser();
    const epoch = {};
    this.nativeBrowserEpoch = epoch;
    this.nativeBrowserSource = source.sourceId;
    this.nativeBrowserConnecting = createNativeHostTransport({
      home: source.home,
      sourceId: source.sourceId,
      launch: { ...options, applicationOwner: undefined },
      environmentCredentials: source.environmentCredentials,
      onCallback: async (frame, signal) => {
        if (
          this.disposed ||
          this.nativeBrowserEpoch !== epoch ||
          !record(frame.params) ||
          typeof frame.params.threadId !== "string"
        )
          throw new Error("Original native browser attachment unavailable");
        this.nativeBrowserScopes.set(JSON.stringify([frame.guiProjectId, frame.params.threadId]), {
          ...frame,
          threadId: frame.params.threadId,
        });
        this.onChange();
        if (!this.onNativeBrowserRequest) throw new Error("Native browser host unavailable");
        return this.onNativeBrowserRequest(frame, signal);
      },
      onEvent: (frame) => {
        if (this.nativeBrowserEpoch !== epoch) return;
        for (const [key, scope] of this.nativeBrowserScopes) {
          if (scope.lease !== frame.lease) continue;
          if (
            frame.method !== "host/connectionClosed" &&
            !(
              frame.method === "areal/thread/archived" &&
              record(frame.params) &&
              frame.params.threadId === scope.threadId
            )
          )
            continue;
          this.nativeBrowserScopes.delete(key);
          this.onNativeBrowserRevoked?.(scope.guiProjectId, scope.threadId);
        }
      },
      onNotice: (notice) => {
        if (this.nativeBrowserEpoch === epoch && this.status.connected)
          this.onNotification?.(notice);
      },
      onNetworkSettings: (settings) => {
        if (this.nativeBrowserEpoch !== epoch || this.disposed) return;
        this.nativeNetworkSettings = settings;
        this.onChange();
      },
      onClosed: () => {
        if (this.nativeBrowserEpoch !== epoch || this.disposed) return;
        this.disconnected();
      },
    });
    const transport = await this.nativeBrowserConnecting;
    if (this.disposed || this.nativeBrowserEpoch !== epoch) {
      transport.close();
      throw new Error("Native browser attachment changed");
    }
    this.nativeBrowser = transport;
    this.nativeBrowserConnecting = undefined;
  }
  /** @param {{home:string,sourceId:string}} source */
  async connectNativeShell(source) {
    const epoch = this.nativeBrowserEpoch;
    const transport = this.nativeBrowser;
    if (!epoch || !transport || !this.options.guiProfile)
      throw new Error("Native source attachment unavailable");
    const shell = await createNativeShellTransport({
      home: source.home,
      profile: this.options.guiProfile,
      hostId: transport.hostId,
      generation: transport.generation,
      onShell: (value) => this.acceptNativeShell(value, source.sourceId, epoch),
      onClosed: () => {
        if (this.nativeBrowserEpoch === epoch && !this.disposed) this.disconnected();
      },
    });
    if (this.nativeBrowserEpoch !== epoch || this.disposed) {
      shell.close();
      throw new Error("Original native source changed");
    }
    this.nativeShell = shell;
    this.verifiedDesktopHost = { hostId: transport.hostId, generation: transport.generation };
    this.identity = `${transport.hostId}:${transport.generation}`;
  }
  /** @param {string} projectId @param {string} threadId */
  ownsThread(projectId, threadId) {
    return (
      !this.value.library.projects[projectId]?.hidden &&
      !!this.nativeBrowserScope(projectId, threadId)
    );
  }
  /** @param {string} projectId @param {string} threadId */
  async ensureBrowserThread(projectId, threadId) {
    if (!this.nativeBrowserEpoch) await this.init();
    const epoch = this.nativeBrowserEpoch;
    const scope = await this.nativeBrowserCall("browser.scope", { projectId, threadId });
    if (!epoch || this.nativeBrowserEpoch !== epoch || this.disposed)
      throw new Error("Original native browser attachment changed");
    if (
      !record(scope) ||
      scope.sourceId !== this.nativeBrowserSource ||
      scope.guiProjectId !== projectId ||
      scope.threadId !== threadId ||
      ![
        "projectId",
        "workspacePath",
        "lease",
        "coreInstanceId",
        "coreGeneration",
        "connectionId",
      ].every((key) => typeof scope[key] === "string" && scope[key])
    )
      throw new Error("Invalid native browser Thread scope");
    this.nativeBrowserScopes.set(
      JSON.stringify([projectId, threadId]),
      /** @type {import('./native-host-transport').DesktopThreadScope} */ (scope),
    );
    this.onChange();
  }
  /** @param {import('@areal/client').ShellView} shell @param {string} sourceId @param {object} epoch */
  acceptNativeShell(shell, sourceId, epoch) {
    if (this.disposed || this.nativeBrowserEpoch !== epoch || this.nativeBrowserSource !== sourceId)
      return;
    const navigation = shell.navigation.find((source) => source.sourceId === sourceId);
    if (!navigation) throw new Error("Original native GUI navigation unavailable");
    this.value = {
      library:
        navigation.state === "available"
          ? {
              projects: navigation.projects,
              threads: navigation.threads,
              projectOrder: navigation.projectOrder,
              settings: navigation.settings,
              sections: navigation.sections,
              sidebarThreadOrder: navigation.sidebarThreadOrder,
              sidebarRevision: navigation.sidebarRevision,
            }
          : this.value.library,
      projects: shell.projects.flatMap((project) => {
        const binding = navigation.bindings.find(
          (binding) => binding.projectId === project.projectId,
        );
        if (!binding) return [];
        return [
          {
            id: binding.alias,
            root: project.workspace,
            state: null,
            summaries: project.summaries.items,
            projectless: binding.projectless,
            ...(binding.logicalProjectId ? { logicalProjectId: binding.logicalProjectId } : {}),
          },
        ];
      }),
    };
    this.onChange();
  }
  /** @param {string|undefined} stage */
  setStartupStage(stage) {
    if (this.startupStage === stage) return;
    this.startupStage = stage;
    this.onChange();
  }
  snapshot() {
    const desktopCapabilities = {
      currentCommands: this.status.connected === true && this.nativeBrowser?.closed === false,
    };
    const baseConnection =
      this.initializing && this.connectionState.state === "ready"
        ? { state: "connecting" }
        : this.connectionState;
    const connection =
      baseConnection.state === "connecting" && this.startupStage
        ? { ...baseConnection, stage: this.startupStage }
        : baseConnection;
    return {
      ...this.value,
      verifiedDesktopHost: this.verifiedDesktopHost,
      library: {
        ...this.value.library,
        settings: { ...this.value.library.settings, ...this.nativeNetworkSettings },
      },
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
  disconnected() {
    this.verifiedDesktopHost = undefined;
    this.closeNativeBrowser();
    this.terminalConnections.close();
    this.onBrowserDisconnected?.();
    const message = "后台服务已断开，请重新连接";
    this.connectionState = { state: "unavailable", message };
    this.status = { ...this.status, connected: false };
    this.value = {
      ...this.value,
      projects: this.value.projects.map((p) => ({
        ...p,
        error: message,
        state: p.state ? { ...p.state, connected: false, error: message } : null,
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
    if (!this.identity || !this.canReconnect()) return;
    // 已排队的恢复仍是等待；重复断线通知不能把它重新投影成故障。
    this.connectionState = { state: "connecting" };
    if (this.reconnectTimer) return;
    const delay = Math.min(30000, 500 * 2 ** Math.min(this.reconnectAttempts ?? 0, 6));
    this.reconnectAttempts = (this.reconnectAttempts ?? 0) + 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.canReconnect()) return;
      if (this.connecting) {
        this.scheduleReconnect();
        return;
      }
      // 自动重连与显式启动共用回执核查入口，不能先启动替代后台再检查原操作。
      void this.init({ automatic: true })
        .catch(
          /** @param {unknown} error */ (error) => {
            if (canRetryConnection(error)) return;
            this.reconnectBlocked = true;
            this.connectionState = {
              state: "unavailable",
              message: desktopError(error).message,
            };
            this.onChange();
          },
        )
        .finally(() => this.scheduleReconnect());
    }, delay);
    this.reconnectTimer.unref?.();
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
        !this.unidentifiedStop
      )
        return;
      this.clearReconnect();
      this.initializing = true;
      this.verifiedDesktopHost = undefined;
      this.connectionState = { state: "connecting" };
      this.onChange();
      if (this.unidentifiedStop) {
        this.connectionState = {
          state: "unavailable",
          recovery: "check",
          message: lifecycleControl.originalDesktopMessage,
        };
        return;
      }
      let reconnectHost = false;
      if (this.hostReferences.size) {
        for (const reference of this.hostReferences.values()) await this.readHostStop(reference);
        if (
          (automatic &&
            [...this.hostReferences.values()].some(
              (reference) =>
                this.hostReceipts.get(reference.requestId)?.preparationInterrupted !== true,
            )) ||
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
      if (this.lifecycleReferences.size) {
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
      await this.initialize({ recover: automatic });
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
            canRetryConnection(error) &&
            (automatic ||
              ["SERVICE_NOT_READY", "DISCONNECTED"].some(
                (code) => code === desktopError(error).code,
              ))
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
  /** @param {{recover?:boolean}} [options] @returns {Promise<void>} */
  async initialize({ recover = false } = {}) {
    const trace = startupTrace("service.initialize");
    try {
      trace.advance("prepare_dir");
      await mkdir(this.home, { recursive: true, mode: 0o700 });
      this.home = await realpath(this.home);
      if (this.disposed) throw new Error("GUI 连接已关闭");
      await this.initializeHostBackend({ recover, trace });
      trace.finish("ok");
    } catch (error) {
      trace.finish("error", error);
      throw error;
    }
  }
  /** @param {{recover?:boolean,trace?:ReturnType<typeof startupTrace>}} [input] */
  async initializeHostBackend({ recover = false, trace = undefined } = {}) {
    const options = {
      ...this.options,
      home: this.home,
      userHome: this.options.userHome ?? this.app.getPath("home"),
    };
    if (!options.binary || !options.hostHome || !options.guiProfile || !options.harnessHome)
      throw new Error("Host 后台启动配置不完整");
    const { ensureDesktopHost, desktopBuildIdentity } = require("@areal/client/desktop-upgrade");
    // 依赖检查和指纹计算并行。依赖失败可以立即报出，启动 Host 必须等两者成功。
    this.setStartupStage(recover ? "identity" : "prerequisites");
    trace?.advance("startup_checks");
    const prereqPromise = !recover
      ? (async () => {
          const checkTrace = startupTrace("service.prerequisites");
          try {
            await this.prerequisiteCheck({ app: { isPackaged: this.app.isPackaged === true } });
            checkTrace.finish("ok");
          } catch (error) {
            checkTrace.finish("error", error);
            throw error;
          }
        })()
      : Promise.resolve();
    const binary = options.binary;
    const identityPromise = (async () => {
      const identityTrace = startupTrace("service.build_identity");
      try {
        const buildIdentity = await desktopBuildIdentity(
          binary,
          [
            join(__dirname, ".."),
            join(__dirname, "../../../renderer/dist"),
            join(__dirname, "../../../packages/client/node"),
            join(__dirname, "../../../packages/workbench/node"),
          ],
          this.app.isPackaged ? join(process.resourcesPath, "desktop-build.json") : undefined,
        );
        identityTrace.finish("ok");
        return { buildIdentity };
      } catch (error) {
        identityTrace.finish("error", error);
        throw error;
      }
    })();
    // 两个检查都可能失败。先处理依赖错误，同时接住指纹的提前或迟到失败。
    void identityPromise.catch(() => {});
    let identity;
    try {
      await prereqPromise;
      this.setStartupStage("identity");
      identity = await identityPromise;
      if (!identity) throw new Error("Host 后台启动配置不完整");
    } catch (error) {
      this.setStartupStage(undefined);
      throw error;
    }
    const { buildIdentity } = identity;
    // 初次旧凭据导入仍由持有原单实例和 safeStorage 的 Main 完成。
    const { GuiSourceSession } = require("@areal/client/gui-source");
    const source = new GuiSourceSession({
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
      this.setStartupStage("host");
      trace?.advance("ensure_host");
      const completeUpgrade = await ensureDesktopHost(source.client, {
        home: options.hostHome,
        binary: options.binary,
        buildIdentity,
        closed: () => this.disposed === true,
      });
      source.client.close();
      await source.init({ deferCredentials: true });
      this.setStartupStage("workbench");
      const prepared = await source.prepareNative(options, process.env);
      if (this.disposed) throw new Error("GUI 连接已关闭");
      this.setStartupStage("attach");
      await this.connectNativeBrowser(source, prepared.options);
      await this.connectNativeShell(source);
      this.status = { connected: true };
      this.connectionState = { state: "ready" };
      this.clearReconnect();
      this.reconnectAttempts = 0;
      // Cloud 导入未完成由该设置页显示，不能阻塞无关历史与已确认项目。
      await this.importNativeCloud(source.sourceId).catch(() => {});
      this.lifecycleError = null;
      trace?.advance("complete_upgrade");
      await completeUpgrade();
      this.backendUpdate = undefined;
    } catch (error) {
      this.closeNativeBrowser();
      this.status.connected = false;
      throw error;
    } finally {
      this.setStartupStage(undefined);
      source.close();
    }
  }
  /** @param {string} sourceId @param {{isEncryptionAvailable:()=>boolean,decryptString:(value:Buffer)=>string,getSelectedStorageBackend?:()=>string}} [encryption] */
  // 过渡：到 0.2.0 删（Cloud 旧密文一次导入完成后移除）。
  async importNativeCloud(sourceId, encryption = require("electron").safeStorage) {
    const epoch = this.nativeBrowserEpoch;
    const current = () =>
      epoch &&
      this.nativeBrowserEpoch === epoch &&
      this.nativeBrowserSource === sourceId &&
      !this.disposed;
    if (!current()) throw new Error("Cloud import source changed");
    let file;
    try {
      file = await open(
        join(this.home, "cloud.json"),
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
      );
    } catch (error) {
      if (record(error) && error.code === "ENOENT") return;
      throw error;
    }
    let raw;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("Invalid Cloud import source");
      const bytes = Buffer.alloc(1024 * 1024 + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 1024 * 1024) throw new Error("Cloud import source exceeds limit");
      raw = bytes.subarray(0, bytesRead);
    } finally {
      await file.close();
    }
    const value = JSON.parse(raw.toString("utf8"));
    if (!record(value) || typeof value.secret !== "string" || !value.secret) return;
    try {
      await this.nativeBrowserCall("cloud.settings", { operation: "status" });
      return;
    } catch (error) {
      if (!record(error) || error.code !== "CLOUD_IMPORT_REQUIRED") throw error;
    }
    if (!current()) throw new Error("Cloud import source changed");
    if (
      !encryption?.isEncryptionAvailable() ||
      encryption.getSelectedStorageBackend?.() === "basic_text"
    )
      throw new Error("Cloud credential import requires unlocked system storage");
    const token = encryption.decryptString(Buffer.from(value.secret, "base64"));
    const sourceDigest = createHash("sha256").update(raw).digest("hex");
    const identity = createHash("sha256")
      .update(sourceId)
      .update("\0")
      .update(sourceDigest)
      .digest("hex");
    const requestId = `${identity.slice(0, 8)}-${identity.slice(8, 12)}-4${identity.slice(13, 16)}-a${identity.slice(17, 20)}-${identity.slice(20, 32)}`;
    if (!current()) throw new Error("Cloud import source changed");
    await this.nativeBrowserCall("cloud.import", { requestId, sourceDigest, token });
  }
  /** @param {string} path @returns {Promise<unknown>} */
  async addProject(path) {
    if (!this.nativeBrowserEpoch) await this.init();
    const epoch = this.nativeBrowserEpoch;
    const result = await this.nativeBrowserCall("worktree.project.add", { root: path });
    if (!epoch || this.nativeBrowserEpoch !== epoch || this.disposed)
      throw Object.assign(new Error("Project source changed; read the original registration"), {
        code: "RESYNC_REQUIRED",
        submissionUnknown: false,
      });
    if (
      !record(result) ||
      typeof result.projectId !== "string" ||
      !/^[a-f0-9]{24}$/.test(result.projectId)
    )
      throw new Error("Invalid native project registration");
    return result.projectId;
  }
  /** @param {Record<string,unknown>} identity */
  async browserClaim(identity) {
    this.assertLifecycleScope("browserClaim");
    if (typeof identity.projectId === "string" && typeof identity.threadId === "string") {
      const scope = this.nativeBrowserScope(identity.projectId, identity.threadId);
      if (scope) {
        if (identity.coreInstanceId !== scope.coreInstanceId)
          throw new Error("Browser Core changed");
        return { claimed: true };
      }
    }
    throw new Error("后台尚未连接");
  }
  /** @param {Record<string,unknown>} request */
  async nativeGuiTerminalCommand(request) {
    const epoch = this.nativeBrowserEpoch;
    try {
      const value = await this.nativeBrowserCall("terminal.command", {
        ...request,
        guiOwned: true,
      });
      if (!epoch || this.nativeBrowserEpoch !== epoch)
        throw Object.assign(new Error("Original terminal attachment changed"), {
          code: "RESYNC_REQUIRED",
        });
      return value;
    } catch (error) {
      const semantics = commandSemantics("manage", request);
      if (semantics.effect === "mutation" && record(error)) {
        error.requestId ??= request.requestId;
        const code = String(error.code ?? "");
        if (
          !error.outcome &&
          !["COMMAND_FAILED", "INVALID_PARAMS", "FORBIDDEN", "CORE_INCOMPATIBLE"].includes(code)
        )
          error.submissionUnknown = true;
      }
      throw error;
    }
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
    if (name === "stop")
      throw Object.assign(new Error("请通过 Host 暂停当前轮次"), {
        code: "CAPABILITY_UNAVAILABLE",
        outcome: { kind: "noMutation" },
      });
    this.assertLifecycleScope(name, request);
    if (["projectless", "resources", "prepareCreator", "cloud", "cloudSession"].includes(name)) {
      const epoch = this.nativeBrowserEpoch;
      const value = await this.nativeBrowserCall(
        name === "cloud"
          ? "cloud.settings"
          : name === "cloudSession"
            ? "cloud.session"
            : name === "resources"
              ? "resources.command"
              : name === "prepareCreator"
                ? "resources.prepareCreator"
                : "projectless.command",
        request,
      );
      if (!epoch || this.nativeBrowserEpoch !== epoch || this.disposed)
        throw Object.assign(new Error("Original native source changed"), {
          code: "RESYNC_REQUIRED",
        });
      return value;
    }
    if (
      name === "manage" &&
      (request.guiOwned === true ||
        (typeof request.id === "string" && this.guiTerminals.has(request.id)))
    ) {
      const params = { ...request };
      const semantics = commandSemantics(name, params);
      if (semantics.requestId) params[semantics.requestId] ??= randomUUID();
      const recovery = request.operation === "processSubmission";
      const starting = request.operation === "processStart" || recovery;
      const scope = starting ? readGuiThreadIdentity(request) : undefined;
      const pending = this.nativeGuiTerminalCommand(params).then((value) => {
        if (scope) {
          const response = readGuiProcessResponse(value, params.requestId, recovery);
          if (response.confirmed) this.guiTerminals.set(response.id, { ...scope, id: response.id });
        }
        return value;
      });
      if (starting) this.guiTerminalStarts.add(pending);
      try {
        return await pending;
      } finally {
        this.guiTerminalStarts.delete(pending);
      }
    }
    const { guiOwned: _guiOwned, ...params } = request;
    const semantics = commandSemantics(name, params);
    const epoch = this.nativeBrowserEpoch;
    const source = this.nativeBrowserSource;
    const transport = this.nativeBrowser;
    if (!epoch || !transport || transport.closed)
      throw Object.assign(new Error("Host 操作入口尚未就绪，请重新连接"), {
        code: "CAPABILITY_UNAVAILABLE",
        outcome: { kind: "noMutation" },
      });
    if (semantics.requestId) params[semantics.requestId] ??= randomUUID();
    try {
      const value = await transport.command(name, params);
      if (this.disposed || this.nativeBrowserEpoch !== epoch || this.nativeBrowserSource !== source)
        throw Object.assign(new Error("Original native source changed"), {
          code: "RESYNC_REQUIRED",
          submissionUnknown: semantics.effect === "mutation",
        });
      return value;
    } catch (error) {
      if (semantics.effect === "mutation" && record(error)) {
        if (semantics.requestId) error.requestId ??= params[semantics.requestId];
        // 无Host拒绝证据的传输错误保留原提交，不能重新发送。
        if (error.code === "TASK_REJECTED") {
          error.submissionUnknown = false;
          error.outcome = { kind: "rejected" };
        } else if (
          !error.outcome &&
          !["COMMAND_FAILED", "INVALID_PARAMS", "FORBIDDEN", "CORE_INCOMPATIBLE"].includes(
            String(error.code ?? ""),
          )
        )
          error.submissionUnknown = true;
      }
      throw error;
    }
  }
  /** @param {Record<string,unknown>} request @returns {Promise<unknown>} */
  async nativeResourceRead(request) {
    const epoch = this.nativeBrowserEpoch;
    const value = await this.nativeBrowserCall("resources.command", request);
    if (!epoch || this.nativeBrowserEpoch !== epoch || this.disposed)
      throw Object.assign(new Error("Original native source changed"), { code: "RESYNC_REQUIRED" });
    return value;
  }
  /** @param {Record<string,unknown>} request @returns {Promise<unknown>} */
  async resources(request) {
    return require("@areal/workbench/desktop-contract/desktop-control-resources").readResourceInspections(
      await this.nativeResourceRead(request),
    );
  }
  async serviceStatus() {
    if (!this.status.connected) throw new Error("后台尚未连接");
    const value = await this.nativeResourceRead({ operation: "status" });
    /** @type {typeof import('@areal/workbench/desktop-contract/desktop-control').validateResponse} */
    const validate = require("@areal/workbench/desktop-contract/desktop-control").validateResponse;
    validate("serviceStatus", {}, value);
    return value;
  }
  /** @param {'status'|'install'|'uninstall'} operation @param {()=>Promise<unknown>} [stop] @returns {Promise<import('@areal/workbench/desktop-contract/desktop-control').HostInstallation>} */
  async hostInstallation(operation, stop) {
    if (!this.options.binary || !this.options.hostHome) throw new Error("Host 程序尚未配置");
    if (operation !== "status") {
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
    const original = [...this.hostReferences.values()].at(-1);
    if (
      this.status.connected ||
      !original?.pid ||
      this.hostReceipts.get(original.requestId)?.state !== "completed"
    )
      return false;
    try {
      process.kill(original.pid, 0);
    } catch (error) {
      return desktopError(error).code === "ESRCH";
    }
    return false;
  }
  async hasUpdateWork() {
    if (this.serviceExited) return false;
    const original = [...this.hostReferences.values()].at(-1);
    if (
      !this.status.connected &&
      original?.pid &&
      this.hostReceipts.get(original.requestId)?.state === "completed"
    ) {
      try {
        await waitForProcessExit(original.pid);
        return this.status.connected || !this.serviceExited;
      } catch {
        return true;
      }
    }
    try {
      return (await this.serviceStatus()).canStop !== true;
    } catch {
      return true;
    }
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
        this.disconnected();
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
      if (this.options.binary) {
        value = await readOfflineHostReceipt(this.options.binary, reference);
        if (
          value?.preparationPending === true &&
          value.projects.every((target) => target.dispatch === "notStarted")
        ) {
          // 已确认未派发的停止准备交给轻量 Host 结算；不唤醒 Core，也不另发停止。
          client.close();
          await client.connectOrStart(reference.home, this.options.binary);
          if (client.hostId !== reference.hostId) throw new Error("Host identity changed");
          value = (await client.operation(reference.requestId)).operation;
        }
      }
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
        ...(this.nativeBrowserEpoch && client.identity ? { pid: client.identity.pid } : {}),
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
  /** @returns {Promise<unknown>} */
  async recoverBackend() {
    if (this.recoveryInFlight) return this.recoveryInFlight;
    this.recoveryInFlight = (async () => {
      await this.checkLifecycle();
      if (this.unidentifiedStop || (this.status.stopReport && this.status.lifecycle?.version !== 2))
        throw Object.assign(new Error(lifecycleControl.originalDesktopMessage), {
          code: "LIFECYCLE_INCOMPLETE",
        });
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
    this.lifecycleError = null;
    this.onChange();
    return this.lifecycleProjection();
  }
  /** @param {string} name @param {Record<string,unknown>} [request] */

  assertLifecycleScope(name, request = {}) {
    return lifecycleControl.assertLifecycleScope.call(this, name, request);
  }
  /** @param {{notify?:Notify}} [options] */
  async applyUpdate({ notify } = {}) {
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
        if (!this.options.binary) throw new Error("Core 程序路径不可用");
        if (!notify)
          throw Object.assign(
            new Error(
              require("@areal/workbench/node/native-i18n").nativeText(
                "lifecycle.confirmationRequired",
              ),
            ),
            { code: "LIFECYCLE_CONFIRMATION_REQUIRED" },
          );
        this.backendUpdate = { state: "applying" };
        this.onChange();
        result = await require("./host-quit.cjs").confirmHostStop(this, notify);
      }
      if (!("stopped" in result) || !result.stopped) {
        this.backendUpdate = { state: "pending" };
        this.onChange();
        return result;
      }
      this.reconnectBlocked = true;
      this.connectionState = { state: "connecting" };
      this.onChange();
      await this.initialize();
      if (result.operation.kind === "stopHost") {
        // 后继连接已就绪。原回执由 Host 保留，Main 结束这一次停止的写入限制。
        this.hostReferences.delete(result.operation.requestId);
        this.hostReceipts.delete(result.operation.requestId);
      }
      for (const [requestId, reference] of this.lifecycleReferences) {
        if (
          desktopKind(reference.kind) &&
          "desktopGeneration" in result.operation &&
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
          this.nativeGuiTerminalCommand({
            ...terminal,
            operation,
            ...(mutation ? { requestId: randomUUID() } : {}),
          });
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
    if (keepBackground) {
      if (!this.options.hostHome) return;
      if (
        [...this.hostReferences.values()].some(
          (reference) => this.hostReceipts.get(reference.requestId)?.state !== "completed",
        ) ||
        [...this.lifecycleReferences.values()].some(
          (reference) => this.lifecycleReceipts.get(reference.requestId)?.phase !== "completed",
        )
      )
        return;
      const client = new HostClient();
      try {
        try {
          // 退出只释放既有 Host；不能为了退出启动另一代后台。
          await client.connect(this.options.hostHome);
        } catch (error) {
          if (["ENOENT", "ECONNREFUSED"].includes(String(desktopError(error).code))) return;
          throw error;
        }
        // 同一 Host 代际和 GUI 来源跨重开复用原请求；响应丢失不能换 ID。
        const digest = createHash("sha256")
          .update(
            JSON.stringify(["release", client.hostId, client.generation, this.options.guiProfile]),
          )
          .digest("hex");
        const requestId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
        const released = await client.releaseWhenUnused(requestId);
        if (
          released.state !== "armed" ||
          released.requestId !== requestId ||
          released.generation !== client.generation
        )
          throw new Error("后台退出策略尚未确认，请核查原请求后重试。");
        return;
      } finally {
        client.close();
      }
    }
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
  }
  async prepareQuit() {
    await this.settleGuiTerminals();
  }
  async shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.disposed = true;
    this.clearReconnect();
    return (this.shutdownPromise = (async () => {
      try {
        await this.settleGuiTerminals();
      } finally {
        this.closeNativeBrowser();
        this.terminalConnections.close();
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
  waitForProcessExit,
};
