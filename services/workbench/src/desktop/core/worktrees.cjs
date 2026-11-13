// @ts-check
"use strict";
const { mkdir, readFile, readdir } = require("node:fs/promises");
const { join } = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const {
  environmentDefinition,
  worktreeSettings,
  readWorktreeRequest,
  readOperation,
} = require("@areal/workbench/desktop-contract/workspace-worktrees");
const { modelRecord } = require("@areal/workbench/core-model-contract");
/** @typedef {import('./project-index.cjs').SavedProject} SavedProject */
/** @typedef {import('./project-state.cjs').CoreProject} Project */
/** @typedef {import("@areal/workbench/desktop-contract/workspace-worktrees").EnvironmentScript} EnvironmentScript */
/** @typedef {import("@areal/workbench/desktop-contract/workspace-worktrees").EnvironmentDefinition} EnvironmentDefinition */
/** @typedef {import("@areal/workbench/desktop-contract/workspace-worktrees").WorktreeSettings} WorktreeSettings */
/** @typedef {import("@areal/workbench/desktop-contract/workspace-worktrees").WorktreeRequest} WorktreeRequest */
/** @typedef {import("@areal/workbench/desktop-contract/workspace-worktrees").WorktreeRecord} WorktreeRecord */
/** @typedef {import("@areal/workbench/desktop-contract/workspace-worktrees").EnvironmentAttempt} EnvironmentAttempt */
/** @typedef {import("@areal/workbench/desktop-contract/workspace-worktrees").DeletionAttempt} DeletionAttempt */
/** @typedef {import("@areal/workbench/desktop-contract/workspace-worktrees").WorktreeOperation} WorktreeOperation */
/** @typedef {SavedProject & {state?:import('@areal/workbench/core-model-contract').CoreModelState|null,error?:string|null,core?:unknown,summaries?:import('@areal/workbench/core-model-contract').CoreThread[],configurations?:Record<string,unknown>,outcomes?:Project['outcomes'],observationErrors?:Project['observationErrors'],refreshErrors?:Project['refreshErrors'],pending?:Project['pending']}} ProjectSnapshot */
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** @param {string} message */
const unavailable = (message) =>
  Object.assign(new Error(message), {
    code: "WORKTREE_BINDING_UNAVAILABLE",
    submissionUnknown: true,
  });
/** @param {WorktreeRequest} request @returns {WorktreeRequest} */
const signature = (request) =>
  readWorktreeRequest(
    JSON.parse(
      JSON.stringify(
        Object.fromEntries(
          ["worktree", "model", "parameters", "options", "profile", "browserEnabled"]
            .filter((key) => request[key] !== undefined)
            .map((key) => [key, request[key]]),
        ),
      ),
    ),
  );

/** 每个执行目录保留独立服务和日志，逻辑项目只聚合可重建的展示。 */
class CoreWorktrees {
  /** @param {InstanceType<typeof import('./backend.cjs').CoreBackend>} backend */
  constructor(backend) {
    this.backend = backend;
    /** @type {Map<string,WorktreeOperation>} */
    this.records = new Map();
    /** @type {Map<string,string>} */
    this.threadOwners = new Map();
    /** @type {Promise<void>|undefined} */
    this.nativeReload = undefined;
    this.nativeReloadNeeded = false;
  }
  /** @returns {Promise<void>} */
  reloadNative() {
    this.nativeReloadNeeded = true;
    this.nativeReload ??= (async () => {
      while (this.nativeReloadNeeded) {
        this.nativeReloadNeeded = false;
        await this.reloadNativeRecords();
      }
    })().finally(() => {
      this.nativeReload = undefined;
      if (this.nativeReloadNeeded) return this.reloadNative();
    });
    return this.nativeReload;
  }
  async reloadNativeRecords() {
    const directory = join(this.backend.home, "worktree-requests");
    const names = await readdir(directory).catch((error) => {
      if (!modelRecord(error) || error.code !== "ENOENT") throw error;
      return [];
    });
    for (const name of names) {
      if (!uuid.test(name.replace(/\.json$/, "")) || !name.endsWith(".json")) continue;
      const value = readOperation(JSON.parse(await readFile(join(directory, name), "utf8")));
      if (value.requestId !== name.slice(0, -5)) throw new Error("工作树创建日志无效");
      this.records.set(value.requestId, value);
    }
  }
  /** @param {unknown} id */
  key(id) {
    if (typeof id !== "string" || !uuid.test(id)) throw new Error("无效工作树请求标识");
    return join("worktree-requests", id + ".json");
  }
  async init() {
    /** @type {string[]} */
    let names;
    try {
      names = await readdir(join(this.backend.home, "worktree-requests"));
    } catch (error) {
      if (!modelRecord(error) || error.code !== "ENOENT") throw error;
      names = [];
    }
    for (const name of names) {
      if (!uuid.test(name.replace(/\.json$/, "")) || !name.endsWith(".json")) continue;
      const value = readOperation(
        JSON.parse(await readFile(join(this.backend.home, "worktree-requests", name), "utf8")),
      );
      if (value.requestId !== name.slice(0, -5) || typeof value.projectId !== "string")
        throw new Error("工作树创建日志无效");
      this.records.set(value.requestId, value);
    }
    const directory = join(this.backend.home, "thread-owners");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const name of await readdir(directory)) {
      if (!/^[a-f0-9]{24}\.json$/.test(name)) continue;
      const owner = this.backend.saved.find((project) => project.id === name.slice(0, -5));
      if (!owner) continue;
      /** @type {unknown} */
      const ids = JSON.parse(await readFile(join(directory, name), "utf8"));
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && !!id))
        throw new Error("线程归属索引无效");
      for (const id of ids) {
        if (this.threadOwners.has(id) && this.threadOwners.get(id) !== owner.id)
          throw new Error("线程归属索引冲突");
        this.threadOwners.set(id, owner.id);
      }
    }
  }
  /** @param {Project} project */
  async observeProject(project) {
    for (const id of [
      ...Object.keys(project.model.state.threads),
      ...(project.summaries ?? []).map((thread) => thread.id),
    ]) {
      const owner = this.threadOwners.get(id);
      if (owner && owner !== project.id) throw unavailable("线程执行归属冲突");
      if (!owner) this.threadOwners.set(id, project.id);
    }
  }
  /** @param {SavedProject} project */
  logicalId(project) {
    return project.logicalProjectId ?? project.id;
  }
  /** @param {string} logicalId */
  owners(logicalId) {
    return this.backend.saved.filter((p) => p.id === logicalId || p.logicalProjectId === logicalId);
  }
  /** @param {string} logicalId @param {string} threadId */
  executionProjectId(logicalId, threadId) {
    const b = this.backend,
      requested = b.saved.find((p) => p.id === logicalId);
    if (!requested) throw new Error("未知工作区");
    const logical = requested.logicalProjectId ?? logicalId,
      matches = new Set();
    const indexed = this.threadOwners.get(threadId);
    if (indexed) {
      const owner = b.saved.find((project) => project.id === indexed);
      if (!owner || this.logicalId(owner) !== logical) throw new Error("会话不属于此逻辑项目");
      matches.add(indexed);
    }
    for (const value of this.records.values())
      if (value.projectId === logical && value.threadId === threadId && value.executionProjectId)
        matches.add(value.executionProjectId);
    for (const owner of b.saved) {
      const live = b.projects.get(owner.id),
        cached = b.library.value.projects[owner.id]?.navigationSummaries ?? [];
      if (
        live?.model.state.threads?.[threadId] ||
        live?.summaries?.some((t) => t.id === threadId) ||
        cached.some((t) => t.id === threadId)
      ) {
        if (this.logicalId(owner) !== logical) throw new Error("会话不属于此逻辑项目");
        matches.add(owner.id);
      }
    }
    if (matches.size > 1) throw unavailable("会话执行归属不唯一，请核对原工作树");
    if (matches.size === 1) return [...matches][0];
    if (this.owners(logical).length === 1) return logical;
    throw unavailable("会话执行归属尚未确认，请先重新连接原项目");
  }
  /** @param {string} name @param {unknown} input */
  async resolveRequest(name, input) {
    let request = readRouteRequest(input);
    // Catalogs aggregate execution owners themselves; sourceThreadId is a filter, not a route.
    if (name === "tasks") return request;
    if (!request?.projectId || name === "library" || name === "create") {
      if (
        name === "create" &&
        this.backend.saved.find((p) => p.id === request.projectId)?.logicalProjectId
      )
        throw new Error("请从逻辑项目创建会话，不能绕过工作树准入");
      return request;
    }
    const original = this.backend.saved.find((p) => p.id === request.projectId);
    if (!original) return request;
    const logicalId = this.logicalId(original);
    if (request.logicalProjectId !== undefined && request.logicalProjectId !== logicalId)
      throw new Error("逻辑项目归属不匹配");
    const targets = [
      request.threadId,
      request.sourceThreadId,
      request.parentThreadId,
      ...(Array.isArray(request.threadIds) ? request.threadIds : []),
    ].filter(/** @returns {id is string} */ (id) => typeof id === "string" && !!id);
    const owners = new Set(targets.map((id) => this.executionProjectId(logicalId, id)));
    if (request.taskId) {
      const executionStarting =
        name === "manage" &&
        ["taskRunNow", "taskResumeRun", "taskReply", "taskResume", "taskUpdate"].includes(
          request.operation ?? "",
        );
      const target = await this.backend.taskWorkspaceOwners.target(logicalId, request.taskId, {
        execution: executionStarting,
      });
      owners.add(target.projectId);
      if (request.threadId && request.threadId !== target.threadId)
        throw unavailable("任务执行会话归属不匹配");
      if (target.threadId) request = { ...request, threadId: target.threadId };
      else if (executionStarting)
        throw unavailable("任务没有可核对的执行会话，请先选择独立工作树会话");
      if (
        executionStarting &&
        (typeof target.mode !== "string" ||
          !["foreground", "background", "scheduled"].includes(target.mode))
      )
        throw unavailable("此任务的独立执行工作区尚未确认，未启动或恢复安排");
    }
    const operation = request.requestId ? this.records.get(request.requestId) : undefined;
    if (operation && operation.projectId !== logicalId) throw new Error("原请求不属于此逻辑项目");
    if (request.requestId && !(name === "workspace" && request.operation?.startsWith("worktree"))) {
      for (const owner of this.owners(logicalId)) {
        const live =
          (await this.backend.loadProjectJournal?.(owner.id)) ??
          this.backend.projects.get(owner.id);
        if (
          live?.pending?.some((entry) => entry.params?.requestId === request.requestId) ||
          live?.outcomes?.[request.requestId]
        )
          owners.add(owner.id);
      }
    }
    if (
      !targets.length &&
      operation?.projectId === logicalId &&
      operation.executionProjectId &&
      !(name === "workspace" && request.operation?.startsWith("worktree"))
    )
      owners.add(operation.executionProjectId);
    if (request.executionProjectId !== undefined) {
      if (!this.owners(logicalId).some((p) => p.id === request.executionProjectId))
        throw new Error("执行工作区不属于此逻辑项目");
      owners.add(request.executionProjectId);
    }
    if (owners.size > 1) throw new Error("一次操作不能跨越不同执行工作区");
    return {
      ...request,
      projectId: [...owners][0] ?? original.id,
      logicalProjectId: logicalId,
    };
  }
  /** @param {string|undefined} projectId */
  assertAvailable(projectId) {
    const value = [...this.records.values()].find(
      (value) =>
        value.executionProjectId === projectId &&
        (value.deleted ||
          value.deletion?.status === "running" ||
          value.deletion?.status === "unknown"),
    );
    if (value)
      throw Object.assign(
        new Error(value.deleted ? "工作树目录已删除，历史仍保留" : "工作树正在删除或结果尚未确认"),
        { code: "WORKTREE_REMOVED" },
      );
  }
  settings() {
    return {
      worktreeRoot: "",
      branchPrefix: "areal",
      fetchBeforeCreate: false,
      autoCleanup: false,
      keepCount: 10,
      ...this.backend.library.value.settings.worktrees,
    };
  }
  /** 只读原始创建记录；未知状态不能触发创建或环境脚本重放。
   * @param {string} projectId @param {WorktreeRequest} request */
  readThreadCreation(projectId, request) {
    const requestId = requireId(request.requestId);
    try {
      const value = readOperation(
        JSON.parse(
          require("node:fs").readFileSync(join(this.backend.home, this.key(requestId)), "utf8"),
        ),
      );
      this.records.set(value.requestId, value);
    } catch (error) {
      if (!modelRecord(error) || error.code !== "ENOENT") throw error;
    }
    const value = this.records.get(requestId);
    if (
      !value ||
      value.kind !== "thread" ||
      value.projectId !== projectId ||
      !isDeepStrictEqual(value.parameters, signature(request))
    )
      return { state: "unknown" };
    if (value.state === "ready" && value.threadId && value.executionProjectId)
      return {
        state: "ready",
        requestId,
        threadId: value.threadId,
        executionProjectId: value.executionProjectId,
      };
    if (["failed", "cancelled"].includes(value.state))
      return { state: "rejected", requestId, message: value.message ?? "Creation rejected" };
    return { state: "unknown" };
  }
  /** @param {SavedProject} project @param {WorktreeRequest} request */
  async createThread(project, request) {
    const target = await this.backend.hostCall("worktree.thread.prepare", {
      projectId: project.id,
      request,
    });
    if (
      !modelRecord(target) ||
      typeof target.alias !== "string" ||
      typeof target.projectId !== "string"
    )
      throw unavailable("Host 工作树执行归属尚未确认");
    if (typeof target.threadId === "string")
      return { threadId: target.threadId, requestId: request.requestId };
    // Host 已冻结执行 Core；这里只观察并认证原服务，不能重算部署再 ensure。
    await this.backend.refreshHostProjects();
    await this.reloadNative();
    const binding = this.backend.host.resolve(target.alias);
    const execution = await this.backend.loadProjectJournal(target.alias);
    if (
      binding.projectId !== target.projectId ||
      execution.root !== target.root ||
      !execution.service
    )
      throw unavailable("Host 工作树执行归属已变化");
    if (!execution.client?.ready)
      await this.backend.connections.reconnectProjectObserved(execution);
    if (typeof target.resourceFingerprint !== "string")
      throw unavailable("Host 工作树资源准备证明缺失");
    execution.resourceFingerprint = target.resourceFingerprint;
    execution.resourceProfile =
      /** @type {import('@areal/workbench/desktop-contract').ResourceRef|undefined} */ (
        target.resourceProfile
      );
    const prepared = await this.backend.prepareThreadInProject(execution, request, {
      preparedCore: true,
    });
    if (!prepared.current()) throw unavailable("原 Core 执行归属已变化");
    const result = await this.backend.hostCall("worktree.thread.bind", {
      projectId: project.id,
      requestId: request.requestId,
      executionProjectId: target.projectId,
      coreInstanceId: execution.service?.serviceId,
      coreGeneration: execution.service?.generation,
      params: { ...prepared.params, requestId: request.requestId },
    });
    if (!modelRecord(result) || result.requestId !== request.requestId)
      throw unavailable("Host 工作树会话回执尚未确认");
    if (result.state === "failed" || result.state === "cancelled") {
      const message = result.message ?? (modelRecord(result.error) && result.error.message);
      throw Object.assign(
        new Error(typeof message === "string" ? message : "原工作树创建失败，请使用新请求"),
        { requestId: request.requestId, submissionUnknown: false },
      );
    }
    if (
      typeof result.threadId !== "string" ||
      (result.state !== undefined && result.state !== "ready")
    )
      throw Object.assign(unavailable("Host 工作树创建结果尚未确认"), {
        requestId: request.requestId,
      });
    await this.reloadNative();
    await this.backend.openThread(execution, result.threadId);
    return { threadId: result.threadId, requestId: request.requestId };
  }
  /** @param {string} logicalId */
  async connectExecutions(logicalId) {
    return Promise.allSettled(
      this.owners(logicalId)
        .filter(
          (p) =>
            p.id !== logicalId &&
            ![...this.records.values()].some(
              (value) =>
                value.executionProjectId === p.id &&
                (value.deleted ||
                  value.deletion?.status === "running" ||
                  value.deletion?.status === "unknown"),
            ),
        )
        .map((p) => this.backend.start(p.id)),
    );
  }
  /** @param {ProjectSnapshot} project @param {import("@areal/workbench/core-model-contract").CoreThread} thread */
  decorate(project, thread) {
    const b = this.backend,
      live = b.projects.get(project.id);
    const operation = [...this.records.values()].find(
      (value) => value.executionProjectId === project.id && value.record,
    );
    const worktree = operation?.record
      ? {
          state: operation.state,
          directory: project.root,
          checkoutRoot: operation.record.directory,
          branch: operation.record.branch,
          base: operation.record.base,
          sourceRoot: operation.sourceRoot ?? operation.record.target,
          requestId: operation.requestId,
          automatic: operation.automatic === true,
        }
      : undefined;
    return {
      ...thread,
      executionProjectId: project.id,
      executionCore: project.core ?? {
        instanceId: live?.service?.serviceId ?? null,
        connectionGeneration: live?.connectionGeneration ?? 0,
      },
      executionConnected: project.state?.connected === true,
      executionError: project.error ?? project.state?.error ?? null,
      ...(worktree ? { worktree, worktreeEvents: operation?.events } : {}),
    };
  }
  /** @param {ProjectSnapshot[]} rows */
  aggregate(rows) {
    return rows
      .filter((row) => !row.logicalProjectId)
      .map((logical) => {
        const owners = rows.filter(
            (row) => row.id === logical.id || row.logicalProjectId === logical.id,
          ),
          state = {
            ...logical.state,
            /** @type {Record<string,ReturnType<CoreWorktrees["decorate"]>>} */ threads: {},
            /** @type {Record<string,unknown>} */ interactions: {},
            /** @type {Record<string,unknown>} */ queues: {},
            tasks: { ...logical.state?.tasks },
          };
        const configurations = {},
          outcomes = {},
          observationErrors = {},
          refreshErrors = {},
          /** @type {Record<string,string>} */
          executionErrors = {},
          summaries = [],
          pending = [];
        for (const owner of owners) {
          for (const [id, thread] of Object.entries(owner.state?.threads ?? {}))
            state.threads[id] = this.decorate(owner, thread);
          Object.assign(state.interactions, owner.state?.interactions);
          Object.assign(state.queues, owner.state?.queues);
          if (owner.state?.tasks) state.tasks = { ...state.tasks, ...owner.state.tasks };
          Object.assign(configurations, owner.configurations);
          Object.assign(outcomes, owner.outcomes);
          Object.assign(observationErrors, owner.observationErrors);
          Object.assign(refreshErrors, owner.refreshErrors);
          summaries.push(...(owner.summaries ?? []).map((thread) => this.decorate(owner, thread)));
          pending.push(...(owner.pending ?? []));
          if (owner.error || owner.state?.connected === false)
            executionErrors[owner.id] = owner.error ?? owner.state?.error ?? "执行工作区未连接";
        }
        const operations = [...this.records.values()].filter(
          (record) => record.projectId === logical.id,
        );
        return {
          ...logical,
          state: owners.some((owner) => owner.state) ? state : null,
          configurations,
          outcomes,
          observationErrors,
          refreshErrors,
          summaries,
          pending,
          executionErrors,
          worktreeOperations: operations,
          worktreeSettings: this.settings(),
        };
      });
  }
}
/** @param {unknown} value */
function requireId(value) {
  if (typeof value !== "string") throw new Error("无效工作树请求标识");
  return value;
}
module.exports = { CoreWorktrees, environmentDefinition, worktreeSettings, readWorktreeRequest };

/** Only routing identities are consumed here; command-specific revisions and payloads belong to their command owner.
 * @typedef {Record<string,unknown> & Pick<WorktreeRequest,'requestId'|'projectId'|'threadId'|'sourceThreadId'|'parentThreadId'|'threadIds'|'logicalProjectId'|'taskId'|'executionProjectId'|'operation'>} RouteRequest */
/** @param {unknown} value @returns {RouteRequest} */
function readRouteRequest(value) {
  if (!routeRequest(value)) throw new Error("工作区路由身份无效");
  return value;
}
/** @param {unknown} value @returns {value is RouteRequest} */
function routeRequest(value) {
  return (
    modelRecord(value) &&
    [
      "requestId",
      "projectId",
      "threadId",
      "sourceThreadId",
      "parentThreadId",
      "logicalProjectId",
      "taskId",
      "executionProjectId",
      "operation",
    ].every((key) => value[key] === undefined || typeof value[key] === "string") &&
    (value.threadIds === undefined ||
      (Array.isArray(value.threadIds) && value.threadIds.every((id) => typeof id === "string")))
  );
}
