// @ts-check
"use strict";
const { mkdir, readFile, readdir, writeFile, realpath, lstat } = require("node:fs/promises");
const { join, isAbsolute, resolve, parse, relative, basename } = require("node:path");
const { homedir } = require("node:os");
const { WorktreeEnvironment, platformScript } = require("./worktree-environment.cjs");
const { createHash, randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const git = require("@areal/workspace-git");
const {
  environmentDefinition,
  worktreeSettings,
  isWorktreeRecord,
  readWorktreeRequest,
  readOperation,
  readWorktreeRemoval,
} = require("@areal/workbench/desktop-contract/workspace-worktrees");
const { modelRecord } = require("@areal/workbench/core-model-contract");
const { readResourceStatus } = require("./resource-observation.cjs");
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
    /** @type {Map<string,Promise<unknown>>} */
    this.queues = new Map();
    /** @type {Map<string,string>} */
    this.threadOwners = new Map();
    /** @type {Map<string,Promise<WorktreeOperation>>} */
    this.writes = new Map();
    /** @type {Map<string,Promise<unknown> & {requestId?:string,worktreeRequestId?:string}>} */
    this.active = new Map();
    this.environment = new WorktreeEnvironment(this);
  }
  get native() { return this.backend.rustDomains.includes("worktree-rust") && !!this.backend.hostCall; }
  async reloadNative() {
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
    if (!this.native)
      for (const value of this.records.values()) await this.reconcileDeletion(value).catch(() => {});
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
    let changed = false;
    for (const id of [
      ...Object.keys(project.model.state.threads),
      ...(project.summaries ?? []).map((thread) => thread.id),
    ]) {
      const owner = this.threadOwners.get(id);
      if (owner && owner !== project.id) throw unavailable("线程执行归属冲突");
      if (!owner) {
        this.threadOwners.set(id, project.id);
        changed = true;
      }
    }
    if (!changed || this.native) return;
    await this.backend.save(
      join("thread-owners", project.id + ".json"),
      [...this.threadOwners].filter(([, owner]) => owner === project.id).map(([id]) => id),
    );
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
  /** @param {string} id */
  current(id) {
    const value = this.records.get(id);
    if (!value) throw unavailable("工作树创建记录尚未加载");
    return value;
  }
  /** @param {string} id */
  saved(id) {
    const project = this.backend.saved.find((project) => project.id === id);
    if (!project) throw new Error("未知工作区");
    return project;
  }
  /** @param {string} id @param {(value:WorktreeOperation)=>WorktreeOperation} change */
  async update(id, change) {
    const task = (this.writes.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const value = change(this.current(id));
        await mkdir(join(this.backend.home, "worktree-requests"), {
          recursive: true,
          mode: 0o700,
        });
        await this.backend.save(this.key(id), value);
        this.records.set(id, value);
        this.backend.onChange();
        return value;
      });
    this.writes.set(id, task);
    try {
      return await task;
    } finally {
      if (this.writes.get(id) === task) this.writes.delete(id);
    }
  }
  /** @param {WorktreeOperation} value */
  persist(value) {
    return this.update(value.requestId, (latest) => ({
      ...latest,
      ...value,
      ...(latest?.intent === "cancel" ? { intent: "cancel" } : {}),
    }));
  }
  /** @param {WorktreeOperation} value @param {import("@areal/workbench/desktop-contract/workspace-worktrees").WorktreeState} state @param {Partial<WorktreeOperation>} [patch] */
  transition(value, state, patch = {}) {
    return this.update(value.requestId, (latest) => {
      const nextState = state === "ready" && latest.intent === "cancel" ? "cancelled" : state;
      return {
        ...latest,
        ...patch,
        state: nextState,
        events: [
          ...(latest.events ?? []),
          {
            id: `${value.requestId}:${(latest.events ?? []).length}`,
            state: nextState,
            time: new Date().toISOString(),
            ...(patch.message ? { message: patch.message } : {}),
          },
        ],
      };
    });
  }
  defaultRoot() {
    return join(this.backend.userHome ?? homedir(), ".areal", "worktrees");
  }
  /** @param {SavedProject} project @param {string} [configured] */
  projectRoot(project, configured) {
    const name =
      basename(project.root)
        .replace(/[^a-zA-Z0-9_-]/g, "-")
        .slice(0, 60) || "project";
    return join(
      configured || this.defaultRoot(),
      `${name}-${createHash("sha256").update(project.root).digest("hex").slice(0, 12)}`,
    );
  }
  /** @param {SavedProject} project */
  environmentStore(project) {
    const meta = this.backend.library.value.projects[this.logicalId(project)] ?? {};
    return {
      environments: meta.worktreeEnvironments ?? [],
      environmentRevision: meta.worktreeEnvironmentRevision ?? 0,
    };
  }
  /** @param {SavedProject} project @param {WorktreeRequest} request @param {boolean} [remove] */
  async saveEnvironment(project, request, remove = false) {
    await this.backend.library.change((state) => {
      const meta = (state.projects[this.logicalId(project)] ??= {});
      if (request.expectedRevision !== (meta.worktreeEnvironmentRevision ?? 0))
        throw new Error("环境版本已变化，请刷新后保存");
      const environment = request.environment;
      if (!remove && !environment) throw new Error("工作树环境配置无效");
      const id = remove ? request.environmentId : environment?.id;
      const environments = (meta.worktreeEnvironments ?? []).filter((value) => value.id !== id);
      if (!remove && environment) environments.push(structuredClone(environment));
      meta.worktreeEnvironments = environments;
      meta.worktreeEnvironmentRevision = (meta.worktreeEnvironmentRevision ?? 0) + 1;
    });
    return this.environmentStore(project);
  }
  list() {
    return {
      settings: this.settings(),
      defaultRoot: this.defaultRoot(),
      revision: this.backend.library.value.settings.worktreeRevision ?? 0,
      projects: this.backend.saved
        .filter((p) => !p.logicalProjectId)
        .map((project) => ({
          id: project.id,
          root: project.root,
          name: this.backend.library.value.projects[project.id]?.name ?? basename(project.root),
          ...this.environmentStore(project),
        })),
      worktrees: [...this.records.values()].flatMap((value) =>
        value.record
          ? [
              {
                ...value,
                directory: value.record.directory,
                branch: value.record.branch,
                deleted: value.deleted === true,
              },
            ]
          : [],
      ),
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
  /** @param {WorktreeRequest} request */
  async configure(request) {
    const { worktreeRoot, branchPrefix } = request;
    if (
      typeof worktreeRoot !== "string" ||
      worktreeRoot.length > 4096 ||
      /[\0\r\n]/.test(worktreeRoot) ||
      (worktreeRoot && (!isAbsolute(worktreeRoot) || worktreeRoot.split(/[\\/]/).includes("..")))
    )
      throw new Error("工作树根目录必须是绝对目录");
    if (
      typeof branchPrefix !== "string" ||
      !branchPrefix ||
      branchPrefix.length > 120 ||
      !/^[-\w/.]+$/.test(branchPrefix) ||
      branchPrefix.startsWith("-") ||
      branchPrefix.includes("..") ||
      branchPrefix.endsWith("/") ||
      branchPrefix.includes("//")
    )
      throw new Error("分支前缀无效");
    if (worktreeRoot) {
      let cursor = parse(resolve(worktreeRoot)).root;
      for (const part of relative(cursor, resolve(worktreeRoot)).split("/").filter(Boolean)) {
        cursor = join(cursor, part);
        try {
          const stat = await lstat(cursor);
          if (stat.isSymbolicLink() || !stat.isDirectory())
            throw new Error("工作树根目录不能经过符号链接或文件");
        } catch (error) {
          if (!modelRecord(error) || error.code !== "ENOENT") throw error;
        }
      }
    }
    await this.backend.library.change((state) => {
      const revision = state.settings.worktreeRevision ?? 0;
      if (request.expectedRevision !== undefined && request.expectedRevision !== revision)
        throw new Error("设置版本已变化，请刷新后保存");
      state.settings.worktrees = {
        ...this.settings(),
        worktreeRoot,
        branchPrefix,
        ...Object.fromEntries(
          ["fetchBeforeCreate", "autoCleanup", "keepCount"]
            .filter((key) => request[key] !== undefined)
            .map((key) => [key, request[key]]),
        ),
      };
      state.settings.worktreeRevision = revision + 1;
    });
    return this.settings();
  }
  /** @param {SavedProject} project @param {unknown} sourceRoot */
  async options(project, sourceRoot) {
    const logical = this.saved(this.logicalId(project));
    const worktrees = await git.listWorktrees(logical.root);
    if (sourceRoot !== undefined && typeof sourceRoot !== "string")
      throw new Error("来源工作树目录无效");
    const selected = sourceRoot ? await realpath(sourceRoot) : await realpath(logical.root);
    if (
      !worktrees.some((value) => value.root === selected || selected.startsWith(value.root + "/"))
    )
      throw new Error("来源工作树不属于此仓库");
    const branches = (await git.reviewBranches(selected)).branches
      .filter((value) => value !== null)
      .map((value) => value.name);
    return {
      worktrees,
      branches,
      settings: this.settings(),
      defaultRoot: this.defaultRoot(),
      ...this.environmentStore(logical),
    };
  }
  /** @param {SavedProject} logicalProject @param {WorktreeRecord} record @param {string} requestId */
  async register(logicalProject, record, requestId) {
    const b = this.backend,
      root = await realpath(record.cwd ?? record.directory),
      id = createHash("sha256").update(root).digest("hex").slice(0, 24);
    const registration = (b.projectWrites ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const existing = b.saved.find((p) => p.id === id);
        if (existing) {
          if (existing.root !== root || existing.logicalProjectId !== logicalProject.id)
            throw new Error("目标目录已经登记为其它项目");
          return;
        }
        const saved = [
          ...b.saved,
          { id, root, logicalProjectId: logicalProject.id, worktreeRequestId: requestId },
        ];
        await b.save("projects.json", saved);
        await b.host.register(
          require("./gui-host-projects.cjs").requestIdFor(`${b.host.sourceId}:register:${id}`),
          saved[saved.length - 1],
        );
        b.saved = saved;
      });
    b.projectWrites = registration.catch(() => {});
    await registration;
    return id;
  }
  /** 只读原始创建记录；未知状态不能触发创建或环境脚本重放。
   * @param {string} projectId @param {WorktreeRequest} request */
  readThreadCreation(projectId, request) {
    const requestId = requireId(request.requestId);
    if (this.native) {
      try {
        const value = readOperation(JSON.parse(require("node:fs").readFileSync(join(this.backend.home, this.key(requestId)), "utf8")));
        this.records.set(value.requestId, value);
      } catch (error) {
        if (!modelRecord(error) || error.code !== "ENOENT") throw error;
      }
    }
    const value = this.records.get(requestId);
    if (!value || value.kind !== "thread" || value.projectId !== projectId ||
        !isDeepStrictEqual(value.parameters, signature(request))) return {state:"unknown"};
    if (value.state === "ready" && value.threadId && value.executionProjectId)
      return {state:"ready", requestId, threadId:value.threadId, executionProjectId:value.executionProjectId};
    if (["failed", "cancelled"].includes(value.state))
      return {state:"rejected", requestId, message:value.message ?? "Creation rejected"};
    return {state:"unknown"};
  }
  /** @param {SavedProject} project @param {WorktreeRequest} request */
  async createThread(project, request) {
    if (this.native && this.backend.hostCall) {
      const target = await this.backend.hostCall("worktree.thread.prepare", { projectId: project.id, request });
      if (!modelRecord(target) || typeof target.alias !== "string" || typeof target.projectId !== "string")
        throw unavailable("Host 工作树执行归属尚未确认");
      if (typeof target.threadId === "string") return { threadId: target.threadId, requestId: request.requestId };
      // Host 已冻结执行 Core；这里只观察并认证原服务，不能重算部署再 ensure。
      await this.backend.refreshHostProjects();
      await this.reloadNative();
      const binding = this.backend.host.resolve(target.alias);
      const execution = await this.backend.loadProjectJournal(target.alias);
      if (binding.projectId !== target.projectId || execution.root !== target.root || !execution.service)
        throw unavailable("Host 工作树执行归属已变化");
      if (!execution.client?.ready)
        await this.backend.connections.reconnectProjectObserved(execution);
      const prepared = await this.backend.prepareThreadInProject(execution, request);
      if (!prepared.current()) throw unavailable("原 Core 执行归属已变化");
      const result = await this.backend.hostCall("worktree.thread.bind", {
        projectId: project.id, requestId: request.requestId,
        executionProjectId: target.projectId,
        coreInstanceId: execution.service?.serviceId,
        coreGeneration: execution.service?.generation,
        params: { ...prepared.params, requestId: request.requestId },
      });
      if (!modelRecord(result) || typeof result.threadId !== "string")
        throw unavailable("Host 工作树会话回执尚未确认");
      await this.reloadNative();
      await this.backend.openThread(execution, result.threadId);
      return { threadId: result.threadId, requestId: request.requestId };
    }
    if (project.logicalProjectId) throw new Error("请从逻辑项目创建会话");
    const queueId = await realpath(project.root);
    const requestId = requireId(request.requestId);
    const key = this.key(requestId),
      previous = this.queues.get(queueId) ?? Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(() => this.createThreadInner(project, { ...request, requestId }, key));
    this.queues.set(queueId, task);
    this.active.set(requestId, task);
    try {
      return await task;
    } catch (error) {
      const record = this.records.get(requestId);
      if (
        record?.projectId === project.id &&
        isDeepStrictEqual(record.parameters, signature(request)) &&
        !["ready", "failed", "cancelled"].includes(record.state)
      ) {
        if (modelRecord(error))
          Object.assign(error, { requestId: request.requestId, submissionUnknown: true });
      }
      throw error;
    } finally {
      if (this.queues.get(queueId) === task) this.queues.delete(queueId);
      if (this.active.get(requestId) === task) this.active.delete(requestId);
    }
  }
  /** @param {SavedProject} project @param {WorktreeRequest & {requestId:string}} request @param {string} key */
  async createThreadInner(project, request, key) {
    const b = this.backend,
      requestId = request.requestId,
      parameters = signature(request);
    let value = this.records.get(requestId);
    if (value) {
      if (
        value.projectId !== project.id ||
        value.kind !== "thread" ||
        !isDeepStrictEqual(value.parameters, parameters)
      )
        throw new Error("原创建请求的参数不可修改");
      if (value.state === "ready") return { threadId: value.threadId, requestId };
      if (["failed", "cancelled"].includes(value.state))
        throw Object.assign(new Error(value.message ?? "原工作树创建失败，请使用新请求"), {
          requestId,
          submissionUnknown: false,
        });
      return this.resumeThread(project, value, request);
    }
    const sourceRoot = request.worktree?.sourceRoot
      ? await realpath(request.worktree.sourceRoot)
      : await realpath(project.root);
    const live = await b.start(project.id);
    b.assertThreadCreationAvailable(live, request);
    const isolate = request.worktree?.mode === "worktree";
    if (!isolate && request.worktree?.environmentId) throw new Error("环境脚本只能用于独立工作树");
    const store = this.environmentStore(project);
    if (
      request.worktree?.environmentRevision !== undefined &&
      request.worktree.environmentRevision !== store.environmentRevision
    )
      throw new Error("环境版本已变化，请重新选择");
    const environment = request.worktree?.environmentId
      ? store.environments.find((e) => e.id === request.worktree?.environmentId)
      : undefined;
    if (request.worktree?.environmentId && !environment) throw new Error("所选环境不存在");
    if (environment) {
      platformScript(environment.setup);
      platformScript(environment.cleanup);
      for (const action of environment.actions) platformScript(action.script);
    }
    const settings = this.settings();
    value = {
      kind: "thread",
      requestId,
      projectId: project.id,
      parameters,
      sourceRoot,
      ...(environment
        ? {
            environment: structuredClone(environment),
            environmentRevision: store.environmentRevision,
          }
        : {}),
      settings: {
        ...settings,
        worktreeRoot: this.projectRoot(
          project,
          request.worktree?.worktreeRoot ?? settings.worktreeRoot,
        ),
      },
      intent: "continue",
      createdAt: new Date().toISOString(),
      automatic: false,
      usesSource: !isolate,
      state: "creating",
      events: [],
    };
    await mkdir(join(b.home, "worktree-requests"), { recursive: true, mode: 0o700 });
    try {
      await writeFile(join(b.home, key), JSON.stringify(value), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!modelRecord(error) || error.code !== "EEXIST") throw error;
      throw unavailable("创建标识已有未加载记录，请重新连接后核对");
    }
    this.records.set(requestId, value);
    value = await this.transition(value, "creating");
    try {
      if (isolate) {
        if (!value.settings) throw unavailable("工作树创建设置尚未确认");
        const spec = {
          ...value.settings,
          ...request.worktree,
          worktreeRoot: value.settings.worktreeRoot,
        };
        const record = readWorktreeRecord(
          await git.createTask(project.root, b.home, {
            taskId: requestId,
            sourceRoot,
            source: spec.ref ? "branch" : "head",
            ref: spec.ref || undefined,
            worktreeRoot: spec.worktreeRoot || undefined,
            branch: spec.branch || undefined,
            branchPrefix: spec.branchPrefix,
            fetchBeforeCreate: spec.fetchBeforeCreate,
          }),
        );
        value = await this.transition(value, "created", {
          record,
          message: "新线程从固定提交创建。来源暂存、未暂存、未跟踪和忽略文件均未复制。",
        });
        const executionProjectId = await this.register(project, record, requestId);
        value = await this.persist({ ...value, executionProjectId });
      } else value = await this.persist({ ...value, executionProjectId: project.id });
    } catch (error) {
      if (value.record)
        await this.persist({
          ...value,
          state: "created",
          message: error instanceof Error ? error.message : String(error),
        });
      else
        await this.transition(
          value,
          modelRecord(error) && error.worktreeUncertain ? "unknown" : "failed",
          {
            message: error instanceof Error ? error.message : String(error),
          },
        );
      throw error;
    }
    return this.resumeThread(project, value, request);
  }
  /** @param {SavedProject} project @param {WorktreeOperation} value @param {WorktreeRequest} request @param {{observeOnly?:boolean}} [options] */
  async resumeThread(project, value, request, { observeOnly = false } = {}) {
    const b = this.backend;
    value = this.records.get(value.requestId) ?? value;
    if (value.state === "cancelled") throw new Error("工作树创建已取消");
    if (value.setup) {
      const attempt = await this.environment.execute(value, "setup", value.setup.script, {
        requestId: value.setup.requestId,
        recover: true,
        observeOnly,
      });
      return this.finishSetup(value, attempt);
    }
    if (value.state === "unknown" || value.state === "creating") {
      if (value.usesSource && value.executionProjectId)
        value = await this.persist({ ...value, state: "created" });
      else {
        const observed = await git.readTaskCreation(b.home, value.requestId);
        if (!observed) throw unavailable("原创建结果尚未确认，不会重新创建目录或在来源目录执行");
        const record = readWorktreeRecord(observed);
        const executionProjectId = await this.register(project, record, value.requestId);
        value = await this.transition(value, "created", { record, executionProjectId });
      }
    }
    if (!value.executionProjectId && value.record) {
      const executionProjectId = await this.register(project, value.record, value.requestId);
      value = await this.persist({ ...value, executionProjectId });
    }
    if (!value.executionProjectId) throw unavailable("执行目录登记尚未确认");
    if (value.state !== "binding" && this.records.get(value.requestId)?.intent === "cancel") {
      await this.transition(value, "cancelled", { message: "创建已取消，已创建目录保留" });
      throw new Error("工作树创建已取消");
    }
    let execution;
    try {
      execution = await b.start(value.executionProjectId);
    } catch (error) {
      await this.persist({
        ...value,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    if (value.state === "binding") {
      const receipt = await b.readSubmission(execution, "areal/thread/start", {
        requestId: value.requestId,
      });
      const result =
        "result" in receipt && modelRecord(receipt.result) ? receipt.result : undefined;
      const threadId =
        result?.threadId ?? (modelRecord(result?.thread) ? result.thread.id : undefined);
      if (!receipt.confirmed || typeof threadId !== "string" || !threadId)
        throw unavailable("原线程创建回执尚未确认，不会重发或回退来源目录");
      value = await this.persist({ ...value, threadId });
      await b.openThread(execution, threadId);
      return this.prepareEnvironment(value, true);
    }
    value = await this.transition(value, "binding");
    if (value.intent === "cancel") {
      await this.transition(value, "cancelled");
      throw new Error("工作树创建已取消");
    }
    try {
      const result = await b.createThreadInProject(execution, {
        ...request,
        requestId: value.requestId,
      });
      value = await this.persist({
        ...this.current(value.requestId),
        threadId: result.threadId,
      });
      return await this.prepareEnvironment(value);
    } catch (error) {
      value = this.current(value.requestId);
      if (value.state !== "binding") throw error;
      if (
        (modelRecord(error) && error.submissionUnknown === false) ||
        (modelRecord(error) &&
          modelRecord(error.outcome) &&
          ["noMutation", "rejected"].includes(String(error.outcome.kind)))
      )
        await this.transition(value, "failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      else
        await this.persist({
          ...value,
          message: error instanceof Error ? error.message : String(error),
        });
      throw error;
    }
  }
  /** @param {WorktreeOperation} value @param {boolean} [recovering] */
  async prepareEnvironment(value, recovering = false) {
    value = this.current(value.requestId);
    if (value.intent === "cancel") {
      await this.transition(value, "cancelled", { message: "创建已取消，目录与空会话保留" });
      throw new Error("工作树创建已取消");
    }
    const script = platformScript(value.environment?.setup);
    if (!script) {
      const ready = await this.transition(value, "ready");
      if (ready.state === "cancelled")
        throw Object.assign(new Error("工作树创建已取消"), { submissionUnknown: false });
      void this.autoCleanup().catch(() => {});
      return { threadId: value.threadId, requestId: value.requestId };
    }
    if (recovering && !value.setup) {
      await this.transition(value, "unknown", {
        message: "绑定已确认但环境脚本尚未派发，请核对原创建请求",
      });
      throw unavailable("环境脚本尚未派发，读取不会启动脚本");
    }
    value = await this.transition(value, "settingUp");
    const attempt = await this.environment.execute(value, "setup", script);
    return this.finishSetup(value, attempt);
  }
  /** @param {WorktreeOperation} value @param {EnvironmentAttempt|null} attempt */
  async finishSetup(value, attempt) {
    value = this.current(value.requestId);
    if (attempt?.status === "succeeded" && value.intent !== "cancel") {
      const ready = await this.transition(value, "ready");
      if (ready.state === "cancelled")
        throw Object.assign(new Error("工作树创建已取消"), { submissionUnknown: false });
      void this.autoCleanup().catch(() => {});
      return { threadId: value.threadId, requestId: value.requestId };
    }
    if (
      attempt &&
      ["cancelled", "succeeded", "failed"].includes(attempt.status) &&
      value.intent === "cancel"
    ) {
      await this.transition(value, "cancelled", { message: "环境进程已终止，工作树保留" });
      throw Object.assign(new Error("工作树创建已取消"), { submissionUnknown: false });
    }
    const state = attempt?.status === "failed" ? "failed" : "unknown";
    await this.transition(value, state, {
      message: attempt?.message ?? "环境脚本结果尚未确认",
    });
    throw Object.assign(new Error(attempt?.message ?? "环境脚本结果尚未确认"), {
      submissionUnknown: state === "unknown",
    });
  }
  /** @param {SavedProject} project @param {unknown} inputId */
  async cancel(project, inputId) {
    const requestId = requireId(inputId);
    this.key(requestId);
    let value = this.records.get(requestId);
    if (!value || value.projectId !== this.logicalId(project))
      throw new Error("工作树请求不存在或不属于此项目");
    if (value.state === "ready") return { ...value, cancelResult: "tooLate" };
    if (value.state === "cancelled") return value;
    value = await this.update(requestId, (latest) =>
      latest.state === "ready" ? latest : { ...latest, intent: "cancel" },
    );
    if (value.state === "ready") return { ...value, cancelResult: "tooLate" };
    const active = this.active.get(requestId);
    if (active) await active.catch(() => {});
    else {
      if (value.setup && ["running", "unknown"].includes(value.setup.status)) {
        const attempt = await this.environment.execute(value, "setup", value.setup.script, {
          requestId: value.setup.requestId,
        });
        await this.finishSetup(value, attempt).catch(() => {});
      } else if (value.state === "binding")
        await this.resumeThread(project, value, value.parameters).catch(() => {});
      else if (["created", "failed"].includes(value.state))
        await this.transition(value, "cancelled", { message: "创建已取消，目录保留" });
    }
    return this.records.get(requestId);
  }
  /** @param {SavedProject} project @param {unknown} inputId */
  creation(project, inputId) {
    const requestId = requireId(inputId);
    this.key(requestId);
    const value = this.records.get(requestId);
    if (!value || value.projectId !== this.logicalId(project) || !value.record)
      throw new Error("工作树不属于此逻辑项目或创建尚未确认");
    return value;
  }
  /** @param {WorktreeRequest & {requestId:string}} request @param {string} kind */
  assertOperationId(request, kind) {
    const requestId = request.requestId;
    for (const value of this.records.values()) {
      const action = value.actions?.[requestId];
      const deletion = value.deletion?.requestId === request.requestId;
      if (
        (action || deletion) &&
        (value.requestId !== request.worktreeRequestId ||
          (kind === "action" && (!action || action.actionId !== request.actionId)) ||
          (kind === "delete" && !deletion))
      )
        throw new Error("请求标识已绑定其它工作树操作");
    }
  }
  /** @param {SavedProject} project @param {WorktreeRequest} request */
  async action(project, request) {
    const requestId = requireId(request.requestId);
    this.assertOperationId({ ...request, requestId }, "action");
    const value = this.creation(project, request.worktreeRequestId);
    this.key(request.requestId);
    this.assertAvailable(value.executionProjectId);
    if (value.state !== "ready") throw new Error("工作树环境尚未就绪");
    if (this.active.has(`delete:${value.requestId}`)) throw new Error("工作树正在删除");
    const action = value.environment?.actions.find((action) => action.id === request.actionId);
    if (!action) throw new Error("此工作树快照中没有该动作");
    const existing = value.actions?.[requestId];
    if (existing && existing.actionId !== request.actionId)
      throw new Error("动作请求标识已绑定其他动作");
    const key = `action:${request.requestId}`;
    if (this.active.has(key)) return this.active.get(key);
    const script = platformScript(action.script);
    if (!script) throw new Error("此平台没有配置动作脚本");
    const task = Object.assign(
      this.environment.execute(value, "actions", script, {
        requestId: request.requestId,
        actionId: request.actionId,
        recover: !!existing,
      }),
      { worktreeRequestId: value.requestId },
    );
    this.active.set(key, task);
    try {
      return await task;
    } finally {
      this.active.delete(key);
    }
  }
  /** @param {WorktreeOperation} value @param {Project|null} execution */
  async deletionBlockers(value, execution) {
    if (execution) await this.backend.loadProjectJournal(execution.id);
    const blockers = [];
    if (
      this.active.has(value.requestId) ||
      ["creating", "binding", "settingUp", "unknown"].includes(value.state)
    )
      blockers.push("创建或环境结果尚未确认");
    if (
      [value.setup, value.cleanup, ...Object.values(value.actions ?? {})].some(
        (attempt) => attempt && ["running", "unknown"].includes(attempt.status),
      )
    )
      blockers.push("环境脚本或动作尚未结算");
    if (
      [...this.active.entries()].some(
        ([key, task]) => key.startsWith("action:") && task.worktreeRequestId === value.requestId,
      )
    )
      blockers.push("仍有动作正在执行");
    if (execution?.pending?.length) blockers.push("仍有待核对的提交");
    if (!execution?.client?.ready) {
      blockers.push("原 Core 未连接，无法确认执行状态");
      return blockers;
    }
    const status = await execution.client.request(
      "areal/server/status",
      {},
      { decode: readResourceStatus },
    );
    const arrays = [
      "activeTurns",
      "resources",
      "unresolvedTools",
      "activeGoals",
      "compactions",
      "workgroups",
    ];
    if (
      !arrays.every((key) => Array.isArray(status[key])) ||
      !Number.isSafeInteger(status.activeTasks) ||
      !Number.isSafeInteger(status.pendingQueueItems)
    )
      blockers.push("Core 未提供完整的空闲证明");
    else if (
      arrays.some((key) => Array.isArray(status[key]) && status[key].length) ||
      status.activeTasks ||
      status.pendingQueueItems
    )
      blockers.push("Core 仍有活动轮次、进程、预览、任务或待结算资源");
    /** @type {string|null|undefined} */
    let after;
    for (let page = 0; page < 1000; page++) {
      const tasks = await execution.client.request(
        "areal/task/list",
        {
          limit: 100,
          ...(after ? { after } : {}),
        },
        { decode: readTaskRemovalPage },
      );
      if (!Array.isArray(tasks.data)) {
        blockers.push("任务清单不可核对");
        break;
      }
      if (
        tasks.data.some(
          (task) =>
            !["completed", "cancelled", "failed"].includes(String(task.status ?? task.state)),
        )
      ) {
        blockers.push("工作树仍有关联的未结束任务");
        break;
      }
      if (!tasks.nextCursor) break;
      if (tasks.nextCursor === after || page === 999) {
        blockers.push("任务清单不完整");
        break;
      }
      after = tasks.nextCursor;
    }
    return blockers;
  }
  /** @param {SavedProject} project @param {WorktreeRequest} request */
  async remove(project, request) {
    const requestId = requireId(request.requestId);
    this.assertOperationId({ ...request, requestId }, "delete");
    const key = `delete:${request.worktreeRequestId}`;
    const active = this.active.get(key);
    if (active) {
      const task = active;
      if (task.requestId !== request.requestId) throw new Error("工作树已有删除请求正在执行");
      return task;
    }
    const task = Object.assign(this.removeInner(project, { ...request, requestId }), { requestId });
    this.active.set(key, task);
    try {
      return await task;
    } finally {
      this.active.delete(key);
    }
  }
  /** @param {WorktreeOperation} value */
  async reconcileDeletion(value) {
    if (
      !value.deleted &&
      value.deletion &&
      ["running", "unknown"].includes(value.deletion.status) &&
      !this.active.has(`delete:${value.requestId}`)
    ) {
      /** @type {unknown} */
      const result = await git.readManagedTaskRemoval(this.backend.home, value.deletion.requestId);
      if (modelRecord(result) && result.removed && result.creationId === value.requestId)
        return this.update(value.requestId, (latest) => ({
          ...latest,
          deleted: true,
          deletedAt: new Date().toISOString(),
          deletion: {
            ...requireDeletion(latest),
            status: "succeeded",
            result: readWorktreeRemoval(result),
          },
        }));
    }
    return value;
  }
  /** @param {SavedProject} project @param {WorktreeRequest & {requestId:string}} request */
  async removeInner(project, request) {
    this.key(request.requestId);
    let value = await this.reconcileDeletion(this.creation(project, request.worktreeRequestId));
    if (value.deletion?.requestId === request.requestId) return value;
    if (value.deleted) return value;
    if (value.deletion && ["running", "unknown"].includes(value.deletion.status)) return value;
    if (value.usesSource || value.executionProjectId === value.projectId)
      throw new Error("不能删除来源工作区");
    try {
      await git.inspectManagedTask(this.backend.home, value.requestId, { allowDirty: true });
    } catch (error) {
      return this.update(value.requestId, (latest) => ({
        ...latest,
        deletion: {
          requestId: request.requestId,
          status: "blocked",
          blockers: [error instanceof Error ? error.message : String(error)],
        },
      }));
    }
    const execution = value.executionProjectId
      ? await this.backend.start(value.executionProjectId)
      : null;
    if (request.automatic && value.threadId && execution) {
      await this.backend.listThreads(execution);
      if (!this.autoEligible(value))
        return this.update(value.requestId, (latest) => ({
          ...latest,
          deletion: {
            requestId: request.requestId,
            status: "blocked",
            blockers: ["会话仍可见或已固定，不自动清理"],
          },
        }));
    }
    const blockers = execution
      ? await this.deletionBlockers(value, execution)
      : ["工作树没有可核对的执行 owner"];
    if (blockers.length)
      return this.update(value.requestId, (latest) => ({
        ...latest,
        deletion: { requestId: request.requestId, status: "blocked", blockers },
      }));
    value = await this.update(value.requestId, (latest) => ({
      ...latest,
      deletion: {
        requestId: request.requestId,
        status: "running",
        blockers: [],
        stopRequestId: randomUUID(),
      },
    }));
    try {
      if (!execution?.service) throw new Error("原 Core 执行身份尚未确认");
      const service = execution.service;
      const beforeCleanup = await this.deletionBlockers(value, execution);
      if (beforeCleanup.length) throw new Error(beforeCleanup.join("；"));
      const cleanup = platformScript(value.environment?.cleanup);
      if (cleanup) {
        const attempt = await this.environment.execute(value, "cleanup", cleanup, {
          recover: !!value.cleanup,
        });
        if (attempt?.status !== "succeeded")
          throw new Error(attempt?.message ?? "清理脚本尚未确认成功");
        value = this.current(value.requestId);
      }
      const afterCleanup = await this.deletionBlockers(value, execution);
      if (afterCleanup.length) throw new Error(afterCleanup.join("；"));
      await git.inspectManagedTask(this.backend.home, value.requestId);
      const receipt = await this.backend.lifecycleOperations.request({
        requestId: requireDeletion(value).stopRequestId,
        kind: "stopProject",
        mode: "ifIdle",
        expectedDesktopGeneration: this.backend.lifecycleOperations.generation,
        expectedTargets: [
          {
            projectId: execution.id,
            serviceId: service.serviceId,
            generation: service.generation,
          },
        ],
      });
      if (!receipt) throw Object.assign(new Error("原 Core 停止回执尚未确认"), { code: "WORKTREE_REMOVE_UNKNOWN" });
      value = await this.update(value.requestId, (latest) => ({
        ...latest,
        deletion: { ...requireDeletion(latest), stopReceipt: receipt },
      }));
      if (receipt.phase !== "completed") throw new Error("原 Core 停止或资源释放尚未确认");
      const removed = await git.removeManagedTask(this.backend.home, {
        requestId: request.requestId,
        creationId: value.requestId,
      });
      return this.update(value.requestId, (latest) => ({
        ...latest,
        deleted: true,
        deletedAt: new Date().toISOString(),
        deletion: {
          ...requireDeletion(latest),
          status: "succeeded",
          result: readWorktreeRemoval(removed),
        },
      }));
    } catch (error) {
      return this.update(value.requestId, (latest) => ({
        ...latest,
        deletion: {
          ...requireDeletion(latest),
          status:
            latest.cleanup?.status === "unknown" ||
            (latest.deletion?.stopReceipt && latest.deletion?.stopReceipt.phase !== "completed") ||
            (modelRecord(error) && error.code === "WORKTREE_REMOVE_UNKNOWN")
              ? "unknown"
              : "blocked",
          blockers: [error instanceof Error ? error.message : String(error)],
        },
      }));
    }
  }
  /** @param {WorktreeOperation} value */
  autoEligible(value) {
    if (this.backend.library.value.projects[value.projectId]?.pinned) return false;
    if (!value.threadId) return true;
    if (!value.executionProjectId) return false;
    const live = this.backend.projects.get(value.executionProjectId);
    const summaries = live?.summariesLoaded
      ? live.summaries
      : this.backend.library.value.projects[value.executionProjectId]?.navigationSummaries;
    return (
      Array.isArray(summaries) &&
      summaries.length > 0 &&
      summaries.every(
        (thread) =>
          thread.desktop?.archived === true &&
          !this.backend.library.value.threads[`${value.projectId}:${thread.id}`]?.pinned,
      )
    );
  }
  async autoCleanup() {
    // Host 在后台 ready 后和会话绑定完成后调度；启动期间不能反向调用尚未就绪的 Host 管道。
    if (this.native) return;
    if (this.cleaning || !this.settings().autoCleanup) return;
    this.cleaning = true;
    try {
      const retained = [...this.records.values()].filter((value) => value.record && !value.deleted);
      let excess = retained.length - this.settings().keepCount;
      for (const value of retained.sort((a, b) =>
        (a.createdAt ?? "").localeCompare(b.createdAt ?? ""),
      )) {
        if (excess <= 0) break;
        if (
          !this.autoEligible(value) ||
          value.deletion ||
          !["ready", "created", "cancelled", "failed"].includes(value.state)
        )
          continue;
        const project = this.saved(value.projectId);
        const removed = await this.remove(project, {
          requestId: randomUUID(),
          worktreeRequestId: value.requestId,
          automatic: true,
        });
        if (modelRecord(removed) && removed.deleted) excess--;
      }
    } finally {
      this.cleaning = false;
    }
  }
  /** @param {SavedProject} project @param {unknown} inputId */
  async read(project, inputId) {
    const requestId = requireId(inputId);
    this.key(requestId);
    let value = this.records.get(requestId);
    if (!value) return { state: "missing" };
    value = await this.reconcileDeletion(value);
    if (value.projectId !== this.logicalId(project)) throw new Error("工作树创建请求不属于此项目");
    if (value.kind === "checkout" && ["creating", "unknown"].includes(value.state)) {
      const record = await git.readTaskCreation(this.backend.home, requestId);
      if (record)
        value = await this.transition(value, "created", { record: readWorktreeRecord(record) });
    }
    if (
      !this.active.has(requestId) &&
      value.kind === "thread" &&
      (value.state === "binding" ||
        (value.setup && ["running", "unknown"].includes(value.setup.status)))
    ) {
      try {
        await this.resumeThread(
          this.saved(value.projectId),
          value,
          { ...value.parameters, requestId },
          { observeOnly: true },
        );
        value = this.current(requestId);
      } catch {}
      value = this.current(requestId);
    }
    return value;
  }
  /** @param {SavedProject} project @param {WorktreeRequest} request */
  async create(project, request) {
    if (request.source === "working-tree")
      throw new Error("不再自动提交或复制未提交改动，请选择固定分支或提交");
    const requestId = requireId(request.requestId),
      key = this.key(requestId);
    const parameters = readWorktreeRequest(
      JSON.parse(
        JSON.stringify({
          source: request.source ?? "head",
          sourceRoot: request.sourceRoot,
          ref: request.source === "branch" ? request.ref : undefined,
          worktreeRoot: request.worktreeRoot,
          branch: request.branch,
          branchPrefix: request.branchPrefix,
        }),
      ),
    );
    const existing = this.records.get(requestId);
    if (existing) {
      if (!isDeepStrictEqual(existing.parameters, parameters))
        throw new Error("原创建请求的参数不可修改");
      return this.read(project, requestId);
    }
    /** @type {WorktreeOperation} */
    let value = {
      kind: "checkout",
      requestId,
      projectId: this.logicalId(project),
      parameters,
      state: "creating",
      events: [],
    };
    await mkdir(join(this.backend.home, "worktree-requests"), { recursive: true, mode: 0o700 });
    await writeFile(join(this.backend.home, key), JSON.stringify(value), {
      flag: "wx",
      mode: 0o600,
    });
    this.records.set(requestId, value);
    try {
      const record = readWorktreeRecord(
        await git.createTask(project.root, this.backend.home, {
          ...parameters,
          taskId: requestId,
        }),
      );
      return this.transition(value, "created", { record });
    } catch (error) {
      return this.transition(
        value,
        modelRecord(error) && error.worktreeUncertain ? "unknown" : "failed",
        {
          message: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }
  /** @param {SavedProject} project @param {unknown} requestId */
  async open(project, requestId) {
    const value = await this.read(project, requestId);
    if (!("kind" in value)) throw unavailable("工作树创建尚未确认");
    if (value.kind === "thread" && value.state === "ready")
      return {
        projectId: value.projectId,
        threadId: value.threadId,
        root: value.record?.directory ?? project.root,
      };
    if (value.kind !== "checkout" || value.state !== "created")
      throw unavailable("工作树创建尚未确认");
    const observed = await git.readTaskCreation(this.backend.home, requestId);
    if (!observed) throw unavailable("原工作树已不可用");
    const actual = readWorktreeRecord(observed);
    const logical = this.saved(value.projectId),
      executionProjectId = await this.register(logical, actual, requireId(requestId));
    const next = await this.persist({
      ...value,
      kind: "thread",
      executionProjectId,
      parameters: {},
      sourceRoot: actual.target,
    });
    const result = await this.resumeThread(logical, next, { requestId: requireId(requestId) });
    return { projectId: logical.id, root: actual.directory, ...result };
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
/** @param {unknown} value @returns {WorktreeRecord} */
function readWorktreeRecord(value) {
  if (!isWorktreeRecord(value))
    throw Object.assign(unavailable("工作树创建结果结构无效"), { worktreeUncertain: true });
  return value;
}
/** @param {WorktreeOperation} value */
function requireDeletion(value) {
  if (!value.deletion) throw unavailable("工作树删除记录尚未建立");
  return value.deletion;
}
/** @param {unknown} value */
function readTaskRemovalPage(value) {
  if (
    !modelRecord(value) ||
    !Array.isArray(value.data) ||
    (value.nextCursor != null && typeof value.nextCursor !== "string")
  )
    throw new Error("任务清单不可核对");
  const data = value.data.map((/** @type {unknown} */ task) => {
    if (!modelRecord(task)) throw new Error("任务清单不可核对");
    return task;
  });
  return { ...value, data, nextCursor: value.nextCursor };
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
