// @ts-check
"use strict";
const { createHash } = require("node:crypto");
const { mkdir, readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const { HostClient } = require("@areal/client/node");
const { canonicalSource, GuiSourceAdapter } = require("./gui-source.cjs");
const { startupTrace } = require("./startup-timing.cjs");
const diagnostics = require("./diagnostics.cjs");
/** @typedef {import('./project-index.cjs').SavedProject} SavedProject */
/** @typedef {{alias:{profile:string,legacyProjectId:string},projectId:string,workspace:string,dataDir:string,scratchDir:string,sourceId?:string,usesSharedModelConfig?:boolean,logicalAlias?:{profile:string,legacyProjectId:string},worktreeRequestId?:string,projectlessRequestId?:string}} Binding */
/** @typedef {{suppressed:boolean,activationError:string|null}} Scheduling */
/** @typedef {{registration:{projectId:string},scheduleActivationSuppressed:boolean,scheduleActivationError?:string}} SchedulingStatus */
/** @typedef {{state:'pending'|'completed',requestId?:string,error:string|null,code?:string}} RetirementState */
/** @param {string} value */
const digest = (value) => createHash("sha256").update(value).digest("hex");
/** @param {string} value */
const requestIdFor = (value) => {
  const hash = digest(value);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};

class GuiHostProjects {
  /** @param {{binary:string,home:string,source:import('./gui-source.cjs').GuiSource,encryption?:import('electron').SafeStorage,singletonHeld:boolean}} options */
  constructor(options) {
    this.options = options;
    this.client = new HostClient();
    this.home = options.home;
    this.source = options.source;
    this.sourceId = "";
    this.migrationId = "";
    /** @type {RetirementState} */
    this.retirement = { state: "pending", error: "旧凭据清理尚未确认，ChatGPT 订阅暂不可用。" };
    /** @type {Promise<RetirementState>|undefined} */
    this.retiring = undefined;
    /** @type {Record<string,any>} */
    this.state = {};
    /** @type {Map<string,Binding>} */
    this.bindings = new Map();
    /** @type {SavedProject[]} */
    this.metadata = [];
    /** @type {Map<string,Scheduling>} */
    this.schedules = new Map();
    /** @type {Promise<boolean>|undefined} */
    this.scheduleRefresh = undefined;
  }
  async init() {
    for (const path of Object.values(this.source))
      await mkdir(path, { recursive: true, mode: 0o700 });
    this.source = await canonicalSource(this.source);
    await this.client.connectOrStart(this.home, this.options.binary);
    this.client.requireCapability("scheduledActivation");
    this.client.requireCapability("scheduledPreparation");
    let state = await this.client.sourceState(this.source);
    if (!state) {
      if (!this.options.singletonHeld)
        throw new Error("GUI source import requires the original singleton");
      const adapter = new GuiSourceAdapter({
        source: this.source,
        hostHome: this.home,
        encryption: this.options.encryption,
        singletonHeld: true,
      });
      const result = await adapter.import(requestIdFor(JSON.stringify(this.source)));
      if (result.kind !== "ready") {
        const reasons = new Set();
        for (const blocker of Array.isArray(result.blockers) ? result.blockers : []) {
          switch (blocker?.code) {
            case "sourceGuardRequired":
              reasons.add("请从持有原桌面单实例的应用恢复迁移。");
              break;
            case "credentialsRequired":
              reasons.add("原凭据尚未完成导入，请检查凭据可用状态后重试。");
              break;
            case "legacyPending":
              reasons.add("无法确认旧后台已完成清理，请先检查原任务和停止回执。");
              break;
            default:
              reasons.add("无法确认迁移阻塞原因，请检查原后台状态。");
          }
        }
        if (!reasons.size) reasons.add("无法确认迁移阻塞原因，请检查原后台状态。");
        throw Object.assign(new Error(`GUI 数据迁移尚未完成。${[...reasons].join(" ")}`), {
          code: "GUI_SOURCE_PENDING",
          migration: result,
        });
      }
      state = await this.client.sourceState(this.source);
    }
    if (!state) throw new Error("Host source publication is unavailable");
    this.state = state;
    this.sourceId = state.sourceId;
    this.migrationId = state.migrationId;
    await this.list();
    for (const project of this.metadata) {
      if (!this.bindings.has(project.id))
        await this.register(requestIdFor(`${this.sourceId}:register:${project.id}`), project);
    }
    await this.retire();
  }
  retire() {
    if (this.retirement.state === "completed") return Promise.resolve(this.retirement);
    if (this.retiring) return this.retiring;
    const attempt = this.retireOnce();
    this.retiring = attempt;
    void attempt.then(
      () => {
        this.retiring = undefined;
      },
      () => {
        this.retiring = undefined;
      },
    );
    return attempt;
  }
  async retireOnce() {
    const trace = startupTrace("gui.source.retirement");
    try {
      const progress = this.options.singletonHeld
        ? await new GuiSourceAdapter({
            source: this.source,
            hostHome: this.home,
            encryption: this.options.encryption,
            singletonHeld: true,
          }).retire(this.migrationId, this.retirement.requestId)
        : await this.client.retirementStatus(this.migrationId);
      if (progress && progress.migrationId !== this.migrationId)
        throw new Error("Host retirement source changed");
      if (!progress || progress.state !== "completed") {
        this.retirement = {
          ...this.retirement,
          state: "pending",
          requestId: progress?.requestId ?? this.retirement.requestId,
        };
        trace.finish("degraded");
        return this.retirement;
      }
      this.retirement = { state: "completed", requestId: progress.requestId, error: null };
      trace.finish("ok");
    } catch (error) {
      const requestId =
        error instanceof Error && "requestId" in error && typeof error.requestId === "string"
          ? error.requestId
          : this.retirement.requestId;
      this.retirement = {
        state: "pending",
        requestId,
        code:
          error instanceof Error && "code" in error && typeof error.code === "string"
            ? error.code
            : undefined,
        error: "旧凭据清理尚未确认，ChatGPT 订阅暂不可用。",
      };
      diagnostics.record({
        type: "operation",
        name: "startup",
        outcome: "unknown",
        requestId,
        code: error instanceof Error && "code" in error ? error.code : undefined,
      });
      trace.finish("degraded", error);
    }
    return this.retirement;
  }
  async reconnect() {
    if (!this.sourceId) throw new Error("Host GUI source has not been initialized");
    this.client.close();
    await this.client.connectOrStart(this.home, this.options.binary);
    this.client.requireCapability("scheduledActivation");
    this.client.requireCapability("scheduledPreparation");
    const state = await this.client.sourceState(this.source);
    if (!state || state.sourceId !== this.sourceId) throw new Error("Host GUI source changed");
    await this.retire();
    return this.list();
  }
  /** @returns {Promise<SavedProject[]>} */
  async list() {
    const state = await this.client.sourceState(this.source);
    if (!state || state.sourceId !== this.sourceId) throw new Error("Host GUI source changed");
    this.state = state;
    /** @type {SavedProject[]} */
    let metadata = [];
    try {
      metadata = require("./project-index.cjs").parseProjectIndex(
        JSON.parse(await readFile(join(this.source.coreHome, "projects.json"), "utf8")),
      );
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    this.metadata = metadata;
    const projects = await this.client.listProjects();
    const status =
      /** @type {{projects: (SchedulingStatus & {usesSharedModelConfig?: boolean})[]}} */ (
        /** @type {unknown} */ (await this.client.status())
      );
    this.rememberStatus(status);
    this.bindings.clear();
    for (const binding of state.bindings)
      this.bindings.set(binding.alias.legacyProjectId, {
        ...binding,
        ...(binding.registration.source.kind === "gui" ? { sourceId: state.sourceId } : {}),
      });
    for (const registration of projects.projects) {
      if (
        [...this.bindings.values()].some((binding) => binding.projectId === registration.projectId)
      )
        continue;
      const id = digest(`host:${registration.projectId}`).slice(0, 24);
      if (this.bindings.has(id)) throw new Error("Host project alias collision");
      this.bindings.set(id, {
        alias: { profile: this.source.profile, legacyProjectId: id },
        projectId: registration.projectId,
        workspace: registration.workspace,
        dataDir: registration.dataDir,
        scratchDir: join(this.source.coreHome, id, "scratch"),
      });
    }
    for (const binding of this.bindings.values()) {
      const hostProject = status.projects.find(
        (project) => project.registration.projectId === binding.projectId,
      );
      binding.usesSharedModelConfig =
        binding.sourceId === state.sourceId || hostProject?.usesSharedModelConfig === true;
    }
    return [...this.bindings].map(([id, binding]) => ({
      ...metadata.find((project) => project.id === id),
      id,
      root: binding.workspace,
      ...(binding.logicalAlias ? { logicalProjectId: binding.logicalAlias.legacyProjectId } : {}),
      ...(binding.worktreeRequestId ? { worktreeRequestId: binding.worktreeRequestId } : {}),
      ...(binding.projectlessRequestId
        ? { projectless: true, projectlessRequestId: binding.projectlessRequestId }
        : {}),
    }));
  }
  /** @param {string} id */
  resolve(id) {
    const binding = this.bindings.get(id);
    if (!binding) throw new Error(`Host project alias is unavailable: ${id}`);
    return binding;
  }
  /** @param {SchedulingStatus} project */
  rememberScheduling(project) {
    this.schedules.set(project.registration.projectId, {
      suppressed: project.scheduleActivationSuppressed === true,
      activationError: project.scheduleActivationError ?? null,
    });
  }
  /** @param {{projects:SchedulingStatus[]}} status */
  rememberStatus(status) {
    this.schedules.clear();
    for (const project of status.projects) this.rememberScheduling(project);
  }
  /** @param {string} id @returns {Scheduling} */
  scheduling(id) {
    const projectId = this.bindings.get(id)?.projectId;
    return (
      (projectId && this.schedules.get(projectId)) || {
        suppressed: false,
        activationError: null,
      }
    );
  }
  refreshScheduling() {
    if (this.scheduleRefresh) return this.scheduleRefresh;
    const before = new Map(this.schedules);
    this.scheduleRefresh = this.client
      .status()
      .then((status) => {
        this.rememberStatus(status);
        return !isDeepStrictEqual(this.schedules, before);
      })
      .finally(() => {
        this.scheduleRefresh = undefined;
      });
    return this.scheduleRefresh;
  }
  /** @param {string} requestId @param {SavedProject} project */
  async register(requestId, project) {
    await this.list();
    const existing = this.bindings.get(project.id);
    if (existing) {
      if (existing.workspace !== project.root)
        throw new Error("Host project alias cannot be rebound");
      return existing;
    }
    const { projects } = await this.client.listProjects();
    const registration = {
      projectId: requestIdFor(`${this.sourceId}:${project.id}`),
      workspace: project.root,
      dataDir: join(this.source.coreHome, project.id, "state"),
      source: {
        kind: /** @type {const} */ ("gui"),
        profile: this.source.profile,
        legacyProjectId: project.id,
      },
      defaultBinding: !projects.some(
        /** @param {{workspace:string,defaultBinding:boolean}} item */ (item) =>
          item.workspace === project.root && item.defaultBinding,
      ),
    };
    await this.client.registerProject(requestId, registration);
    await this.list();
    return this.resolve(project.id);
  }
  /** @param {string} id */
  journal(id) {
    return this.client.journal(this.resolve(id).projectId);
  }
  /** @param {string} requestId @param {string} id @param {unknown} launchInputs @param {Record<string,string>} [credentials] @param {boolean} [resumeScheduling] */
  async ensure(requestId, id, launchInputs, credentials, resumeScheduling = false) {
    const binding = this.resolve(id);
    const result = await this.client.ensureProject(
      requestId,
      binding.projectId,
      binding.sourceId === this.sourceId ? launchInputs : undefined,
      binding.sourceId === this.sourceId ? credentials : undefined,
      resumeScheduling,
    );
    this.rememberScheduling(result.project);
    if (result.project.state !== "ready" || !result.service)
      throw Object.assign(new Error(`Host project is ${result.project.state}`), {
        code: "CORE_STOPPED",
        requestId,
      });
    return require("./local-service.cjs").authenticateService(this, id, result.service);
  }
  /** @param {string} id */
  async observe(id) {
    const state = await this.status(id);
    if (state.state !== "ready" || !state.service)
      throw Object.assign(new Error("Core 服务已停止或正在停止，请显式重新连接"), {
        code: "CORE_STOPPED",
      });
    return require("./local-service.cjs").authenticateService(this, id, state.service);
  }
  /** @param {string} id */
  async status(id) {
    const projectId = this.resolve(id).projectId;
    const status = await this.client.status();
    this.rememberStatus(status);
    const project = status.projects.find(
      /** @param {{registration:{projectId:string}}} item */ (item) =>
        item.registration.projectId === projectId,
    );
    if (!project) throw new Error("Host project registration disappeared");
    return project;
  }
  /** @param {string} requestId @param {string} id @param {string} serviceGeneration @param {'ifIdle'|'cancel'} strategy @param {boolean} [suppressScheduling] */
  async stop(requestId, id, serviceGeneration, strategy, suppressScheduling = true) {
    const result = await this.client.stopProject(
      requestId,
      this.resolve(id).projectId,
      serviceGeneration,
      strategy,
      suppressScheduling,
    );
    await this.refreshScheduling().catch(() => {});
    return result;
  }
  /** @param {string} requestId */
  async operation(requestId) {
    return (await this.client.operation(requestId)).operation;
  }
  close() {
    this.client.close();
  }
}
const LAUNCH_ENVIRONMENT = new Set([
  "AREAL_HARNESS_API_KEY_ENV",
  "AREAL_HARNESS_COMMAND_STDIN_CLOSED",
  "AREAL_HARNESS_CONTEXT_COMPACTION_ENABLED",
  "AREAL_HARNESS_CONTEXT_MODE",
  "AREAL_HARNESS_CONTEXT_OBSERVATION_TOKENS",
  "AREAL_HARNESS_CONTEXT_OUTPUT_RESERVE_TOKENS",
  "AREAL_HARNESS_CONTEXT_RECENT_BYTES",
  "AREAL_HARNESS_CONTEXT_RECENT_TOKENS",
  "AREAL_HARNESS_CONTEXT_REFERENCE_TOKENS",
  "AREAL_HARNESS_CONTEXT_TARGET_TOKENS",
  "AREAL_HARNESS_CONTEXT_WINDOW_BYTES",
  "AREAL_HARNESS_CONTEXT_WINDOW_TOKENS",
  "AREAL_HARNESS_DATA_DIR",
  "AREAL_HARNESS_INSPECTION_PERMISSIONS",
  "AREAL_HARNESS_LISTEN",
  "AREAL_HARNESS_LOG_FILTER",
  "AREAL_HARNESS_MAX_ACTIVE_TURNS",
  "AREAL_HARNESS_MAX_AGENT_DEPTH",
  "AREAL_HARNESS_MAX_CHILDREN_PER_TURN",
  "AREAL_HARNESS_MAX_EMPTY_COMPLETION_RETRIES",
  "AREAL_HARNESS_MAX_GOAL_REPORT_ROUNDS",
  "AREAL_HARNESS_MAX_HISTORY_BYTES",
  "AREAL_HARNESS_MAX_OUTPUT_BYTES",
  "AREAL_HARNESS_MAX_OUTPUT_TOKENS",
  "AREAL_HARNESS_MAX_REPEATED_TOOL_FAILURES",
  "AREAL_HARNESS_MAX_RESPONSE_BYTES",
  "AREAL_HARNESS_MAX_RESPONSE_TOOL_CALLS",
  "AREAL_HARNESS_MAX_THREADS",
  "AREAL_HARNESS_MAX_TOOL_BUFFER_BYTES",
  "AREAL_HARNESS_MAX_TOOL_CALLS",
  "AREAL_HARNESS_MIN_P",
  "AREAL_HARNESS_MODEL",
  "AREAL_HARNESS_MODEL_CONCURRENCY",
  "AREAL_HARNESS_MODEL_CONTEXT_WINDOW_TOKENS",
  "AREAL_HARNESS_MODEL_ENDPOINT",
  "AREAL_HARNESS_MODEL_MAX_REQUEST_BYTES",
  "AREAL_HARNESS_MODEL_MAX_RETRIES",
  "AREAL_HARNESS_MODEL_PROTOCOL",
  "AREAL_HARNESS_MODEL_PROVIDER",
  "AREAL_HARNESS_MODEL_REQUEST_TIMEOUT_SECONDS",
  "AREAL_HARNESS_NETWORK_RETRY_MODE",
  "AREAL_HARNESS_PERMISSION_MODE",
  "AREAL_HARNESS_PRESENCE_PENALTY",
  "AREAL_HARNESS_REASONING_EFFORT",
  "AREAL_HARNESS_REASONING_SUMMARY",
  "AREAL_HARNESS_REPETITION_PENALTY",
  "AREAL_HARNESS_RESPONSES_PROMPT_CACHE",
  "AREAL_HARNESS_RESPONSES_WEBSOCKET",
  "AREAL_HARNESS_SESSION_CATALOG",
  "AREAL_HARNESS_STREAM_IDLE_TIMEOUT_SECONDS",
  "AREAL_HARNESS_SUMMARY_MAX_OUTPUT_TOKENS",
  "AREAL_HARNESS_SUMMARY_REASONING_EFFORT",
  "AREAL_HARNESS_TEMPERATURE",
  "AREAL_HARNESS_TOOL_EXTENSIONS",
  "AREAL_HARNESS_TOP_K",
  "AREAL_HARNESS_TOP_P",
  "AREAL_HARNESS_WATCHDOG_DISABLE",
  "AREAL_MODEL",
  "AREAL_MODEL_ENDPOINT",
  "AREAL_MODEL_PROTOCOL",
  "RUST_LOG",
  "ASK_PERMISSIONS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "SSH_AUTH_SOCK",
  "PATH",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "SHELL",
  "USER",
  "LOGNAME",
]);
/** @param {string} name */
const allowedEnvironment = (name) => LAUNCH_ENVIRONMENT.has(name);
module.exports = { GuiHostProjects, requestIdFor, allowedEnvironment };
