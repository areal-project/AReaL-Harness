// @ts-check
"use strict";
const { createHash } = require("node:crypto");
const { mkdir, readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { HostClient } = require("./host-client.cjs");
const { canonicalSource, GuiSourceAdapter } = require("./gui-source.cjs");
/** @typedef {import('./project-index.cjs').SavedProject} SavedProject */
/** @typedef {{alias:{profile:string,legacyProjectId:string},projectId:string,workspace:string,dataDir:string,scratchDir:string,sourceId?:string,logicalAlias?:{profile:string,legacyProjectId:string},worktreeRequestId?:string,projectlessRequestId?:string}} Binding */
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
    /** @type {Record<string,any>} */
    this.state = {};
    /** @type {Map<string,Binding>} */
    this.bindings = new Map();
    /** @type {SavedProject[]} */
    this.metadata = [];
  }
  async init() {
    for (const path of Object.values(this.source))
      await mkdir(path, { recursive: true, mode: 0o700 });
    this.source = await canonicalSource(this.source);
    await this.client.connectOrStart(this.home, this.options.binary);
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
      if (result.kind !== "ready")
        throw Object.assign(new Error("GUI source migration is not complete"), {
          code: "GUI_SOURCE_PENDING",
          migration: result,
        });
      state = await this.client.sourceState(this.source);
    }
    if (!state) throw new Error("Host source publication is unavailable");
    if (this.options.singletonHeld) {
      await new GuiSourceAdapter({
        source: this.source,
        hostHome: this.home,
        encryption: this.options.encryption,
        singletonHeld: true,
      }).retire(state.migrationId);
    }
    this.state = state;
    this.sourceId = state.sourceId;
    this.migrationId = state.migrationId;
    await this.list();
    for (const project of this.metadata) {
      if (!this.bindings.has(project.id))
        await this.register(requestIdFor(`${this.sourceId}:register:${project.id}`), project);
    }
  }
  async reconnect() {
    if (!this.sourceId) throw new Error("Host GUI source has not been initialized");
    this.client.close();
    await this.client.connectOrStart(this.home, this.options.binary);
    const state = await this.client.sourceState(this.source);
    if (!state || state.sourceId !== this.sourceId) throw new Error("Host GUI source changed");
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
  /** @param {string} requestId @param {string} id @param {unknown} launchInputs @param {Record<string,string>} [credentials] */
  async ensure(requestId, id, launchInputs, credentials) {
    const binding = this.resolve(id);
    const result = await this.client.ensureProject(
      requestId,
      binding.projectId,
      binding.sourceId === this.sourceId ? launchInputs : undefined,
      binding.sourceId === this.sourceId ? credentials : undefined,
    );
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
    const project = status.projects.find(
      /** @param {{registration:{projectId:string}}} item */ (item) =>
        item.registration.projectId === projectId,
    );
    if (!project) throw new Error("Host project registration disappeared");
    return project;
  }
  /** @param {string} requestId @param {string} id @param {string} serviceGeneration @param {'ifIdle'|'cancel'} strategy */
  stop(requestId, id, serviceGeneration, strategy) {
    return this.client.stopProject(
      requestId,
      this.resolve(id).projectId,
      serviceGeneration,
      strategy,
    );
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
