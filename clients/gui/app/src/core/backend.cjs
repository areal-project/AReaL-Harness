// @ts-check
"use strict";
const { parseProjectIndex } = require("./project-index.cjs");
const {
  commandSemantics,
  desktopError,
  readCommandInvocation,
} = require("@areal/workbench/desktop-contract");
const { startupTrace } = require("./startup-timing.cjs");

const { connectService } = require("./local-service.cjs");
const { LifecycleOperations } = require("./lifecycle-operations.cjs");
const { ScheduledOwnerActivation } = require("./schedule-owner-activation.cjs");
const { randomUUID, createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { mkdir, readFile, writeFile, rename, realpath } = require("node:fs/promises");
const { join, isAbsolute } = require("node:path");
const { ScopedResources } = require("./scoped-resources.cjs");
const { AppHooks } = require("./hooks.cjs");
const { TrajectoryExport } = require("./trajectory.cjs");
const { UserFeedback } = require("./feedback.cjs");
const { AppProviders } = require("./providers.cjs");
const { snapshotProject } = require("./project-snapshot.cjs");
const { CloudSettings } = require("./cloud-settings.cjs");
const { CloudConversations } = require("./cloud-conversations.cjs");
const { UsageAnalytics } = require("./analytics.cjs");
const { CoreLibrary } = require("./library.cjs");
const { CoreNotifications } = require("./notifications.cjs");
const { manage } = require("./management.cjs");
const { taskCatalog, OwnerTasks } = require("./task-catalog.cjs");
const { isTaskDraftConfiguration, manageTaskDraft } = require("./task-draft.cjs");
const { mediaCommand, messageInput } = require("./media.cjs");
const { workspaceCommand } = require("./workspace.cjs");
const { CoreWorktrees } = require("./worktrees.cjs");
const { WorktreeAdmission } = require("./worktree-admission.cjs");
const { TaskWorkspaceOwners } = require("./task-workspace-owners.cjs");
const { ScheduleAdmission } = require("./schedule-admission.cjs");
const { ProjectlessWorkspaces } = require("./projectless.cjs");
const { inspectCoreCapabilities, projectCoreCapabilities } = require("./core-capabilities.cjs");
const { definition: browserTool } = require("./browser-tool.cjs");
const { definition: computerTool } = require("./computer-tool.cjs");
const { buildGenUiModelContext, stripGenUiModelContext } = require("@areal/gen-ui/node");
const { genUiScope, createGenUiState } = require("./gen-ui-state.cjs");

const {
  readAdmission,
  readThreadAdmission,
  readQueueAdmission,
} = require("./submission-results.cjs");
const { readInspection, readConfigured } = require("./thread-configuration.cjs");
const {
  modelRecord,
  readCoreTask,
  readCoreQueue,
} = require("@areal/workbench/core-model-contract");
const { ProjectConnections } = require("./project-connections.cjs");
const { HistoryObservation } = require("./history-observation.cjs");
const { SubmissionRecovery, operationOf, isRemoteControl } = require("./submission-recovery.cjs");

/** @typedef {import('./project-state.cjs').CoreProject} Project */
/** @typedef {import('@areal/runtime-client/core').CoreClient} Client */
/** @typedef {Record<string,unknown>} Fields */
/** @typedef {{binary:string,home:string,applicationOwner?:import('./application-owner.cjs').ApplicationOwner,harnessHome?:string,config?:string,desktopConfig?:string,userHome?:string,toolExtensions?:string,workgroupPolicy?:string,workgroupToolchain?:string,sandboxProfile?:string,desktopProcesses?:boolean,defaultProfile?:import('@areal/workbench/desktop-contract').ResourceRef,encryption?:import('electron').SafeStorage,proxyEnvironment?:NodeJS.ProcessEnv,onChange?:()=>void}} CoreBackendOptions */
/** 每个项目连接公开的共享 Core 服务；这里只保留可重建投影与客户端受理回执。 */
class CoreBackend {
  /** @param {CoreBackendOptions} options */
  constructor({
    binary,
    home,
    applicationOwner,
    harnessHome = join(home, "harness"),
    config,
    desktopConfig,
    userHome,
    toolExtensions,
    workgroupPolicy,
    workgroupToolchain,
    sandboxProfile,
    desktopProcesses = false,
    defaultProfile,
    encryption,
    proxyEnvironment = {},
    onChange = () => {},
  }) {
    if (!binary || !isAbsolute(binary))
      throw new Error("请设置 AREAL_CORE_BIN 为 areal 可执行文件的绝对路径");
    this.binary = binary;
    this.applicationOwner = applicationOwner;
    /** @type {Map<string,Omit<import('./local-service.cjs').OwnedEngine,'project'|'service'> & {project:Project,service?:import('./local-service.cjs').RecoveryTarget,dataDir:string,pending?:boolean}>} */
    this.ownedEngines = new Map();
    this.home = home;
    this.genUiState = createGenUiState(home);
    this.harnessHome = harnessHome;
    this.config = config;
    this.proxyEnvironment = proxyEnvironment;
    /** @type {Awaited<ReturnType<typeof import("./proxy-relay.cjs").proxyRelay>>|undefined} */
    this.proxyRelay = undefined;
    this.toolExtensions = toolExtensions;
    this.workgroupPolicy = workgroupPolicy;
    this.workgroupToolchain = workgroupToolchain;
    this.desktopProcesses = desktopProcesses;
    this.sandboxProfile = sandboxProfile;
    this.defaultProfile = defaultProfile;
    this.userHome = userHome;
    this.desktopConfig = desktopConfig;
    this.onChange = onChange;
    /** @type {((notice:Record<string,unknown>)=>void)|undefined} */
    this.onNotification = undefined;
    /** @type {((input:import('./service-transport-contract.cjs').ToolHostInput)=>Promise<unknown>)|undefined} */
    this.browserRead = undefined;
    /** @type {((input:import('./service-transport-contract.cjs').ToolHostInput)=>Promise<unknown>)|undefined} */
    this.computerRead = undefined;
    /** @type {((input:import('./service-transport-contract.cjs').ToolHostInput)=>Promise<unknown>)|undefined} */
    this.cuaRead = undefined;
    /** @type {((event:unknown)=>void)|undefined} */
    this.onMcpAppNotification = undefined;
    /** @type {((event:{projectId:string,client:import('@areal/runtime-client/core').CoreClient,method:string,params:unknown})=>void)|undefined} */
    this.onMcpPageToolNotice = undefined;
    /** @type {((client:import('@areal/runtime-client/core').CoreClient)=>void)|undefined} */
    this.onMcpPageToolsDisconnected = undefined;

    /** @type {Map<string,import('./project-state.cjs').CoreProject>} */
    this.projects = new Map();
    /** @type {Map<string,Promise<import('./project-state.cjs').CoreProject>>} */
    this.starting = new Map();
    /** @type {Map<string,Promise<void>>} */
    this.saves = new Map();
    /** @type {Promise<void>|undefined} */
    this.projectWrites = undefined;
    /** @type {{enabled:boolean,active:boolean,error:string|null}|undefined} */
    this.power = undefined;
    /** @type {InstanceType<typeof ProjectConnections>|undefined} */
    this._connections = undefined;
    /** @type {InstanceType<typeof HistoryObservation>|undefined} */
    this._observations = undefined;
    /** @type {InstanceType<typeof SubmissionRecovery>|undefined} */
    this._submissions = undefined;
    this.closing = false;
    this.ownerTasks = new OwnerTasks(this);
    this.scheduleOwners = new ScheduledOwnerActivation(this);
    this.library = new CoreLibrary(this);
    this.worktrees = new CoreWorktrees(this);
    this.worktreeAdmission = new WorktreeAdmission(this);
    this.scheduleAdmission = new ScheduleAdmission(this);
    this.taskWorkspaceOwners = new TaskWorkspaceOwners(this);
    this.projectless = new ProjectlessWorkspaces(this);
    this.notifications = new CoreNotifications((notice) => this.onNotification?.(notice));
    this.analytics = new UsageAnalytics(this);
    this.resources = new ScopedResources(this);
    this.hooks = new AppHooks(this);
    this.trajectory = new TrajectoryExport(this);
    this.feedback = new UserFeedback(this);
    this.providers = new AppProviders(this, encryption);
    this.cloud = new CloudSettings(this, encryption);
    this.cloudConversations = new CloudConversations(this);
    this.activeCommands = 0;
    /** @type {boolean|undefined} */
    this.providerUpdating = undefined;
    /** @type {boolean|undefined} */
    this.resourcesUpdating = undefined;
    /** @type {WeakSet<object>} */
    this.awaitingResponses = new WeakSet();
    this.lifecycleOperations = new LifecycleOperations(this);
  }

  /** @param {Project} project @param {string} threadId */
  genUiScope(project, threadId) {
    return genUiScope(this.home, project, threadId);
  }

  /** @param {Project} project @param {string} threadId @param {unknown} text */
  async genUiText(project, threadId, text) {
    text = typeof text === "string" ? stripGenUiModelContext(text) : text;
    const context = buildGenUiModelContext(
      await this.genUiState.list(this.genUiScope(project, threadId)),
    );
    return context ? `${text || ""}\n\n${context}` : text;
  }

  get connections() {
    if (!this._connections) {
      const backend = this;
      this._connections = new ProjectConnections({
        get analytics() {
          return backend.analytics;
        },
        get applicationOwner() {
          return backend.applicationOwner;
        },
        browserRead: (...args) => backend.browserRead?.(...args),
        computerRead: (...args) => backend.computerRead?.(...args),
        cuaRead: (...args) => backend.cuaRead?.(...args),
        desktopTools: (...args) => backend.desktopTools(...args),
        get closing() {
          return backend.closing;
        },
        get defaultProfile() {
          return backend.defaultProfile;
        },
        get hooks() {
          return backend.hooks;
        },
        get lifecycleOperations() {
          return backend.lifecycleOperations;
        },
        get worktrees() {
          return backend.worktrees;
        },
        listThreads: (...args) => backend.listThreads(...args),
        onChange: () => backend.onChange(),
        observeNotification: (...args) => backend.observations.notification(...args),
        startTaskMonitor: (...args) => backend.observations.startTaskMonitor(...args),
        onMcpPageToolsDisconnected: (...args) => backend.onMcpPageToolsDisconnected?.(...args),
        openThread: (...args) => backend.openThread(...args),
        get ownedEngines() {
          return backend.ownedEngines;
        },
        prepareServiceLaunch: (...args) => backend.prepareServiceLaunch(...args),
        get projects() {
          return backend.projects;
        },
        get providerUpdating() {
          return backend.providerUpdating;
        },
        get providers() {
          return backend.providers;
        },
        reconcile: (...args) => backend.reconcile(...args),
        get resources() {
          return backend.resources;
        },
        get scheduleAdmission() {
          return backend.scheduleAdmission;
        },
        get resourcesUpdating() {
          return backend.resourcesUpdating;
        },
        get saved() {
          return backend.saved;
        },
        scheduleReconciliation: (...args) => backend.scheduleReconciliation(...args),
        startProject: (...args) => backend.startProject(...args),
        get starting() {
          return backend.starting;
        },
        stopReconciliation: (...args) => backend.stopReconciliation(...args),
        supportsBrowser: backend.supportsBrowser.bind(backend),
        supportsComputer: (...args) => backend.supportsComputer(...args),
        connectExisting: (project, previous) =>
          connectService(
            backend,
            "status",
            ["--instance", previous.serviceId],
            backend.hooks.environment(),
            project,
            previous.dataDir,
          ),
        recoveryStatus: (...args) =>
          require("./local-service.cjs").recoveryStatus(backend, ...args),
        recoverService: (...args) =>
          require("./local-service.cjs").recoverService(backend, ...args),
      });
    }
    return this._connections;
  }

  get observations() {
    if (!this._observations) {
      const backend = this;
      this._observations = new HistoryObservation({
        ownerTasks: backend.ownerTasks,
        get analytics() {
          return backend.analytics;
        },
        get notifications() {
          return backend.notifications;
        },
        get worktrees() {
          return backend.worktrees;
        },
        get taskWorkspaceOwners() {
          return backend.taskWorkspaceOwners;
        },
        onMcpAppNotification: (...args) => backend.onMcpAppNotification?.(...args),
        onMcpPageToolNotice: (...args) => backend.onMcpPageToolNotice?.(...args),
        scheduleReconciliation: (...args) => backend.scheduleReconciliation(...args),
        currentConnection: backend.currentConnection.bind(backend),
        get library() {
          return backend.library;
        },
        get lifecycleOperations() {
          return backend.lifecycleOperations;
        },
        onChange: () => backend.onChange(),
        get projects() {
          return backend.projects;
        },
        get providers() {
          return backend.providers;
        },
        refreshConfiguration: (...args) => backend.refreshConfiguration(...args),
        refreshQueue: (...args) => backend.refreshQueue(...args),
        requireConnection: backend.requireConnection.bind(backend),
      });
    }
    return this._observations;
  }

  get submissions() {
    if (!this._submissions) {
      const backend = this;
      this._submissions = new SubmissionRecovery({
        get awaitingResponses() {
          return backend.awaitingResponses;
        },
        get closing() {
          return backend.closing;
        },
        currentConnection: backend.currentConnection.bind(backend),
        get home() {
          return backend.home;
        },
        get worktrees() {
          return backend.worktrees;
        },
        get lifecycleOperations() {
          return backend.lifecycleOperations;
        },
        onChange: () => backend.onChange(),
        openThread: (...args) => backend.openThread(...args),
        get projects() {
          return backend.projects;
        },
        get providers() {
          return backend.providers;
        },
        readObservation: (...args) => backend.readObservation(...args),
        refreshAfterAdmission: (...args) => backend.refreshAfterAdmission(...args),
        refreshConfiguration: (...args) => backend.refreshConfiguration(...args),
        requireConnection: backend.requireConnection.bind(backend),
        save: (...args) => backend.save(...args),
        get saved() {
          return backend.saved;
        },
        supportsBoundedHistory: (...args) => backend.supportsBoundedHistory(...args),
      });
    }
    return this._submissions;
  }

  get historyWindows() {
    return this.observations.historyWindows;
  }

  async init() {
    const trace = startupTrace("core.init");
    trace.advance("project_index");
    try {
      await mkdir(this.home, { recursive: true, mode: 0o700 });
      await this.lifecycleOperations.init();
      try {
        /** @type {import('./project-index.cjs').SavedProject[]} */
        this.saved = parseProjectIndex(
          JSON.parse(await readFile(join(this.home, "projects.json"), "utf8")),
        );
      } catch (error) {
        if (desktopError(error).code !== "ENOENT") throw error;
        this.saved = [];
      }
      trace.advance("library");
      await this.library.init();
      await this.cloudConversations.init();
      await this.worktrees.init();
      await this.taskWorkspaceOwners.init();
      trace.advance("projectless");
      await this.projectless.init();
      trace.advance("analytics");
      await this.analytics.init();
      trace.advance("capabilities");
      await inspectCoreCapabilities(this.binary);
      trace.advance("providers");
      await this.providers.init();
      trace.advance("feedback");
      await this.feedback.init();
      trace.advance("resources");
      await this.resources.init();
      await this.lifecycleOperations.reconcileLoaded();
      void this.worktrees.autoCleanup().catch(() => {});
      trace.finish("ok");
    } catch (error) {
      trace.finish("error", error);
      throw error;
    }
  }

  /** @param {string} name @param {unknown} value */
  save(name, value) {
    const contents = JSON.stringify(value);
    const task = (this.saves.get(name) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const path = join(this.home, name);
        const temporary = `${path}.${randomUUID()}.tmp`;
        await writeFile(temporary, contents, { mode: 0o600 });
        await rename(temporary, path);
      });
    this.saves.set(name, task);
    return task;
  }

  /** @param {string} path */
  async addProject(path) {
    this.lifecycleOperations.assertRegistration();
    if (this.providerUpdating || this.resourcesUpdating)
      throw new Error("配置正在更新，请稍后打开项目");
    this.activeCommands++;
    try {
      return await this.addProjectPath(path);
    } finally {
      this.activeCommands--;
    }
  }

  /** @param {string} path @param {string} [worktreeResources] @param {string} [projectlessRequestId] */
  async addProjectPath(path, worktreeResources, projectlessRequestId) {
    this.lifecycleOperations.assertRegistration();
    if (this.providerUpdating || this.resourcesUpdating)
      throw new Error("配置正在更新，请稍后打开项目");
    const root = await realpath(path);
    const id = createHash("sha256").update(root).digest("hex").slice(0, 24);
    const registration = (this.projectWrites ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if (this.saved.some((project) => project.id === id)) return;
        const saved = [
          ...this.saved,
          {
            id,
            root,
            ...(worktreeResources ? { worktreeResources } : {}),
            ...(projectlessRequestId ? { projectless: true, projectlessRequestId } : {}),
          },
        ];
        await this.save("projects.json", saved);
        this.saved = saved;
      });
    this.projectWrites = registration.catch(() => {});
    await registration;
    if (this.library.value.projects[id]?.hidden)
      await this.library.command({ projectId: id, operation: "hideProject", hidden: false });
    await this.start(id);
    return id;
  }

  snapshot() {
    const taskHistoryOwners = new Set(
      this.saved
        .filter((project) => this.taskWorkspaceOwners.hosts.get(project.id)?.size)
        .map((project) => project.logicalProjectId ?? project.id),
    );
    return {
      library: this.library.value,
      subscription: this.providers.subscription,
      projectless: this.projectless.snapshot(),
      power: this.power ?? null,
      projects: this.worktrees.aggregate(
        this.saved.map((project) => snapshotProject(this, project, taskHistoryOwners)),
      ),
    };
  }

  /** @param {Parameters<InstanceType<typeof ProjectConnections>['start']>} args */
  start(...args) {
    return this.connections.start(...args);
  }

  /** @param {Parameters<InstanceType<typeof ProjectConnections>['readConnection']>} args */
  readConnection(...args) {
    return this.connections.readConnection(...args);
  }

  /** @param {Parameters<InstanceType<typeof ProjectConnections>['settleReadWaiters']>} args */
  settleReadWaiters(...args) {
    return this.connections.settleReadWaiters(...args);
  }

  // 本地日志加载与连接启动共用同一项目对象；只读收据不启动 Core。
  /** @param {Parameters<InstanceType<typeof SubmissionRecovery>['loadProjectJournal']>} args */
  loadProjectJournal(...args) {
    return this.submissions.loadProjectJournal(...args);
  }

  /** @param {string} id */
  async startProject(id) {
    const current = this.projects.get(id);
    const trace =
      current?.client?.ready && !current.resourceInitializing
        ? null
        : startupTrace("core.start_project", { projectId: id });
    trace?.advance("journal");
    try {
      const project = await this.loadProjectJournal(id);
      if (project.client?.ready && !project.resourceInitializing) {
        trace?.finish("skipped");
        return project;
      }
      try {
        project.resourceInitializing = !!project.worktreeResources;
        trace?.advance("worktree_prepare");
        await this.resources.worktrees.prepare(project);
        trace?.advance("launch");
        if (!project.client?.ready) await this.launch(project);
        trace?.advance("connect");
        if (!project.client?.ready) await this.connect(project);
        trace?.advance("reconcile");
        await this.reconcile(project);
        trace?.advance("worktree_apply");
        await this.resources.worktrees.apply(project);
        project.resourceInitializing = false;
        project.error = null;
        project.model.connection(true);
        this.onChange();
        trace?.finish("ok");
        return project;
      } catch (error) {
        // A failed resource import must still allow authenticated status/drain on
        // its running Core. Keep the management connection, while start() retries
        // initialization before admitting any task or project command.
        if (
          desktopError(error).code === "RESPONSE_TOO_LARGE" ||
          desktopError(error).reason === "RESPONSE_TOO_LARGE"
        )
          project.reconnectBlocked = true;
        if (!project.resourceInitializing || !project.client?.ready) project.client?.close();
        project.error = desktopError(error).message;
        project.model.connection(false, desktopError(error).message);
        throw error;
      }
    } catch (error) {
      trace?.finish("error", error);
      throw error;
    }
  }

  /** @param {import('./project-state.cjs').CoreProject} project @param {ReturnType<typeof startupTrace>} trace */
  async prepareServiceLaunch(project, trace) {
    const directory = join(this.home, project.id);
    const dataDir = join(directory, "state");
    const scratch = join(directory, "scratch");
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    const args = [
      "--workspace",
      project.root,
      "--data-dir",
      dataDir,
      "--scratch",
      scratch,
      "--allow-write",
    ];
    if (this.desktopProcesses)
      args.push("--allow-concurrent-writes", "--desktop-process-timeout-ms", "86400000");
    if (this.config) args.push("--config", this.config);
    if (this.sandboxProfile) args.push("--sandbox-profile", this.sandboxProfile);
    if (this.workgroupPolicy) args.push("--workgroup-policy", this.workgroupPolicy);
    if (this.workgroupToolchain) args.push("--workgroup-toolchain", this.workgroupToolchain);
    trace.advance("resources");
    const resourceDeployment = await this.resources.deployment(project);
    if (resourceDeployment.path) args.push("--desktop-config", resourceDeployment.path);
    project.resourceProfile = resourceDeployment.profile;
    project.resourceFingerprint = resourceDeployment.fingerprint;
    trace.advance("provider_prepare");
    await this.providers.prepare();
    trace.advance("provider_config");
    await this.providers.config.current();
    project.providerRevision = null;
    delete project.providerSnapshot;
    trace.advance("hooks");
    const hookDeployment = await this.hooks.launch();
    project.hookRevision = null;
    const genUiExtensions = join(directory, "desktop-tool-extensions.json");
    await writeFile(genUiExtensions, JSON.stringify({ ...hookDeployment.value, genUi: true }), {
      mode: 0o600,
    });
    const environment = {
      ...this.hooks.environment(),
      AREAL_HARNESS_TOOL_EXTENSIONS: genUiExtensions,
      ...this.providers.environment(),
    };
    return { args, environment, dataDir, hookDeployment };
  }

  /** @param {Project} project */
  async launch(project) {
    const trace = startupTrace("core.launch", { projectId: project.id });
    trace.advance("directories");
    try {
      const { args, environment, dataDir, hookDeployment } = await this.prepareServiceLaunch(
        project,
        trace,
      );
      trace.advance("service_ensure");
      const owned = this.ownedEngines.get(project.id) ?? { project, dataDir, pending: true };
      owned.project = project;
      owned.pending = true;
      this.ownedEngines.set(project.id, owned);
      const { descriptor, token } = await connectService(
        this,
        "ensure",
        args,
        environment,
        project,
        dataDir,
      );
      project.service = descriptor;
      owned.service = descriptor;
      owned.pending = false;
      project.endpoint = descriptor.endpoint;
      project.token = token;
      trace.advance("configuration_recheck");
      if ((await this.hooks.current()).revision === hookDeployment.revision)
        project.hookRevision = hookDeployment.revision;
      trace.finish("ok");
      const attached = startupTrace("core.service_ready", {
        projectId: project.id,
        coreGeneration: descriptor.generation,
      });
      attached.finish("ok");
    } catch (error) {
      trace.finish("error", error);
      throw error;
    }
  }

  async refreshOwnedEngines() {
    if (!this.applicationOwner) return;
    const { serviceRequest } = require("./local-service.cjs");
    const { sameOwner } = require("./application-owner.cjs");
    const descriptors = require("./local-service.cjs").readOwnedServices(
      await serviceRequest(this, ["list"]),
      this.applicationOwner,
    );
    for (const descriptor of descriptors) {
      // 历史索引沿用原项目 ID；路径散列只用于尚未登记的启动恢复，不能替换已登记身份。
      const registered = this.saved.find(
        (project) =>
          /^[a-f0-9]{24}$/.test(project.id) &&
          project.root === descriptor.workspace &&
          descriptor.dataDir === join(this.home, project.id, "state"),
      );
      const projectId =
        registered?.id ??
        createHash("sha256").update(descriptor.workspace).digest("hex").slice(0, 24);
      if (descriptor.dataDir !== join(this.home, projectId, "state"))
        throw new Error("所属 Core 的数据目录与登记不匹配");
      if (descriptor.state === "stopped") {
        const target = {
          projectId,
          serviceId: descriptor.serviceId,
          generation: descriptor.generation,
          root: descriptor.workspace,
        };
        const original = await require("./local-service.cjs").inspectOriginalService(this, target);
        if (!original.cleanupConfirmed) throw new Error("所属 Core 已失联，但原代际清理尚未确认");
        const owned = this.ownedEngines.get(projectId);
        if (owned && (!owned.service || owned.service.generation === descriptor.generation)) {
          owned.service ??= descriptor;
          require("./local-service.cjs").detachStoppedProject(this, target);
        }
        continue;
      }
      let owned = this.ownedEngines.get(projectId);
      if (
        owned?.service &&
        (owned.service.serviceId !== descriptor.serviceId ||
          owned.service.generation !== descriptor.generation)
      )
        throw Object.assign(new Error("所属 Core 代际发生变化，请检查原请求"), {
          code: "CONFIRMATION_STALE",
        });
      if (!owned) {
        const { CoreTaskModel } = await import("@areal/workbench/core-model");
        const project =
          this.projects.get(projectId) ??
          require("./project-state.cjs").createProjectState(
            { id: projectId, root: descriptor.workspace },
            new CoreTaskModel(),
          );
        owned = { project, dataDir: descriptor.dataDir };
        this.ownedEngines.set(projectId, owned);
      }
      owned.service ??= descriptor;
      owned.pending = false;
      owned.project.service ??= owned.service;
    }
    for (const [projectId, owned] of this.ownedEngines) {
      if (!owned.pending || this.starting.has(projectId)) continue;
      if (
        !descriptors.some(
          (descriptor) =>
            sameOwner(descriptor.owner, this.applicationOwner) &&
            descriptor.dataDir === owned.dataDir &&
            descriptor.state !== "stopped",
        )
      ) {
        throw Object.assign(
          new Error(
            `项目 ${owned.project.root} 的启动结果尚未确认。请检查原服务启动日志并重新连接核对，不能将缺少登记视为已清理。`,
          ),
          { code: "LIFECYCLE_INCOMPLETE" },
        );
      }
    }
  }

  /** @param {Project} project @param {{expectedRevision?:string}} [options] */
  async restartProject(project, { expectedRevision } = {}) {
    this.lifecycleOperations.assertProject(project.id);
    if (project.service) {
      const receipt = await this.lifecycleOperations.request({
        requestId: randomUUID(),
        kind: "updateProject",
        mode: "ifIdle",
        expectedDesktopGeneration: this.lifecycleOperations.generation,
        expectedTargets: [
          {
            projectId: project.id,
            serviceId: project.service.serviceId,
            generation: project.service.generation,
          },
        ],
      });
      if (receipt.phase !== "completed")
        throw Object.assign(new Error("原 Core 尚未停止，不能更新配置"), {
          code: "LIFECYCLE_INCOMPLETE",
          requestId: receipt.requestId,
          lifecycle: receipt,
        });
    }
    if (
      expectedRevision !== undefined &&
      (await this.providers.config.current()).revision !== expectedRevision
    )
      throw new Error("配置已有其它变化，请在后台服务中安全应用当前配置。");
    await this.launch(project);
    await this.connect(project);
    await this.reconcile(project);
    await this.resources.worktrees.apply(project);
  }

  /** @param {Project} project @param {Client|null|undefined} client @returns {client is Client} */
  currentConnection(project, client) {
    return this.connections.currentConnection(project, client);
  }

  /** @param {Project} project @param {Client|null|undefined} client @returns {asserts client is Client} */
  requireConnection(project, client) {
    return this.connections.requireConnection(project, client);
  }

  /** @param {Parameters<InstanceType<typeof ProjectConnections>['scheduleReconnect']>} args */
  scheduleReconnect(...args) {
    return this.connections.scheduleReconnect(...args);
  }

  /** @param {Parameters<InstanceType<typeof ProjectConnections>['reconnectProject']>} args */
  reconnectProject(...args) {
    return this.connections.reconnectProject(...args);
  }

  /** @param {Parameters<InstanceType<typeof ProjectConnections>['recoverCrashedProject']>} args */
  recoverCrashedProject(...args) {
    return this.connections.recoverCrashedProject(...args);
  }

  /** @param {Parameters<InstanceType<typeof ProjectConnections>['connect']>} args */
  connect(...args) {
    return this.connections.connect(...args);
  }

  /** @param {Parameters<InstanceType<typeof HistoryObservation>['listThreads']>} args */
  listThreads(...args) {
    return this.observations.listThreads(...args);
  }

  /** @param {Parameters<InstanceType<typeof HistoryObservation>['observationFailure']>} args */
  observationFailure(...args) {
    return this.observations.observationFailure(...args);
  }

  /** @param {Project} project @param {string} [threadId] @param {import("@areal/runtime-client/core").OperationRef} [operation] @param {{backgroundList?:boolean}} [options] */
  async refreshAfterAdmission(project, threadId, operation, { backgroundList = false } = {}) {
    const client = project.client,
      generation = project.connectionGeneration;
    const current = () =>
      this.currentConnection(project, client) && project.connectionGeneration === generation;
    const key = operation?.requestId ?? "project";
    if (operation?.method === "areal/task/runNow" && operation.target?.kind === "task") {
      try {
        this.requireConnection(project, client);
        const task = await client.request(
          "areal/task/read",
          { taskId: operation.target.taskId },
          { decode: readCoreTask },
        );
        if (!current()) return;
        project.model.setTask(task);
        if (project.refreshErrors?.[key]?.scope === "task") delete project.refreshErrors[key];
        this.onChange();
      } catch (error) {
        if (!current()) return;
        project.refreshErrors ??= {};
        project.refreshErrors[key] = {
          id: randomUUID(),
          projectId: project.id,
          scope: "task",
          connectionGeneration: generation,
          operation,
          message: this.providers.redact(desktopError(error).message),
          refreshPending: true,
        };
        this.onChange();
      }
    }
    if (threadId) {
      try {
        await this.openThread(project, threadId);
      } catch (error) {
        if (current()) this.observationFailure(project, threadId, error);
      }
    }
    if (!current()) return;
    const refreshList = async () => {
      try {
        await this.listThreads(project);
        if (current() && project.refreshErrors?.[key]?.scope === "threadList")
          delete project.refreshErrors[key];
      } catch (error) {
        if (!current()) return;
        project.refreshErrors ??= {};
        project.refreshErrors[key] ??= {
          id: randomUUID(),
          projectId: project.id,
          scope: "threadList",
          connectionGeneration: generation,
          operation,
          message: this.providers.redact(desktopError(error).message),
          refreshPending: true,
        };
        this.onChange();
      }
    };
    if (backgroundList) void refreshList();
    else await refreshList();
  }

  /** @param {Parameters<InstanceType<typeof HistoryObservation>['openThread']>} args */
  openThread(...args) {
    return this.observations.openThread(...args);
  }

  /** @param {Parameters<InstanceType<typeof HistoryObservation>['supportsBoundedHistory']>} args */
  supportsBoundedHistory(...args) {
    return this.observations.supportsBoundedHistory(...args);
  }

  /** @param {Parameters<InstanceType<typeof HistoryObservation>['historyWindow']>} args */
  historyWindow(...args) {
    return this.observations.historyWindow(...args);
  }

  /** @param {Parameters<InstanceType<typeof HistoryObservation>['publishHistory']>} args */
  publishHistory(...args) {
    return this.observations.publishHistory(...args);
  }

  /** @param {Parameters<InstanceType<typeof HistoryObservation>['installObservation']>} args */
  installObservation(...args) {
    return this.observations.installObservation(...args);
  }

  /** @param {Parameters<InstanceType<typeof HistoryObservation>['readObservation']>} args */
  readObservation(...args) {
    return this.observations.readObservation(...args);
  }

  /** @param {Parameters<InstanceType<typeof HistoryObservation>['hydrateLatest']>} args */
  hydrateLatest(...args) {
    return this.observations.hydrateLatest(...args);
  }

  /** @param {Parameters<InstanceType<typeof HistoryObservation>['refreshHistory']>} args */
  refreshHistory(...args) {
    return this.observations.refreshHistory(...args);
  }

  /** @param {Parameters<InstanceType<typeof HistoryObservation>['validateHistoryPage']>} args */
  validateHistoryPage(...args) {
    return this.observations.validateHistoryPage(...args);
  }

  /** @param {Parameters<InstanceType<typeof HistoryObservation>['historyCommand']>} args */
  historyCommand(...args) {
    return this.observations.historyCommand(...args);
  }

  /** @param {Parameters<InstanceType<typeof HistoryObservation>['observeThread']>} args */
  observeThread(...args) {
    return this.observations.observeThread(...args);
  }

  /** @param {Project} project */
  supportsBrowser(project) {
    const capabilities = project.client?.capabilities;
    return (
      capabilities?.methods?.includes("areal/thread/observe") &&
      capabilities?.methods?.includes("areal/thread/tools/attach") &&
      capabilities?.features?.browserToolAttachment === true &&
      capabilities?.browserToolBundles?.some((bundle) => bundle.bundleId === "areal.browser.v1")
    );
  }

  /** @param {Project} project */
  supportsComputer(project) {
    const capabilities = project.client?.capabilities;
    return (
      capabilities?.features?.computerToolAttachment === true &&
      capabilities?.features?.computerToolPreparation === true &&
      capabilities?.desktopToolBundles?.some((bundle) => bundle.bundleId === "areal.computer.v1")
    );
  }

  /** @param {Project} project */
  desktopTools(project) {
    return [
      ...(this.supportsBrowser(project) ? [browserTool] : []),
      ...(this.supportsComputer(project) &&
      this.library.value.settings.computerControlEnabled === true &&
      this.library.value.settings.computerControlProvider !== "lcu"
        ? [computerTool]
        : []),
    ];
  }

  /** @param {Project} project @param {string} threadId */
  async ensureBrowserTools(project, threadId) {
    const bundles = this.desktopTools(project).map((tool) =>
      tool.name === "browser_v1" ? "areal.browser.v1" : "areal.computer.v1",
    );
    if (!bundles.length) return;
    const client = project.client;
    for (const bundleId of bundles) {
      const { thread } = await this.readObservation(project, threadId, { client });
      this.requireConnection(project, client);
      if (
        thread.desktop?.archived ||
        thread.parentThreadId ||
        thread.conversation?.policy?.kind === "sideReadOnlyV1" ||
        !modelRecord(thread.status) ||
        thread.status.type !== "idle"
      )
        return;
      await this.submit(project, "areal/thread/tools/attach", {
        threadId,
        expectedToolsetRevision: thread.toolsetRevision ?? 0,
        bundleId,
      });
    }
    await this.readObservation(project, threadId, { client });
    this.requireConnection(project, client);
  }

  /** @param {Project} project @param {string} threadId */
  async bindBrowserHostForClaim(project, threadId) {
    const client = project.client;
    if (!client?.capabilities?.methods?.includes("areal/thread/observe")) {
      throw new Error("当前 Core 不支持安全观察已有聊天；请更新 Core 后重新连接");
    }
    // A local, explicit page claim may rebind an idle host. Read Core's
    // current state first; the Core checks idle state and host ownership again.
    const observed = await this.readObservation(project, threadId, { client });
    this.requireConnection(project, client);
    const thread = observed.thread;
    if (
      !(
        Array.isArray(thread.dynamicTools) &&
        thread.dynamicTools.some((tool) => modelRecord(tool) && tool.name === "browser_v1")
      ) ||
      thread.desktop?.archived ||
      !modelRecord(thread.status) ||
      thread.status.type !== "idle"
    ) {
      throw new Error("聊天正在执行或浏览器未启用，请刷新后再认领页面");
    }
    await this.readObservation(project, threadId, { client, resume: true });
    this.requireConnection(project, client);
  }

  /** @param {Project} project @param {string} threadId @param {{client?:Client|null,timeoutMs?:number,current?:()=>boolean}} [options] */
  async refreshQueue(
    project,
    threadId,
    {
      client = project.client,
      timeoutMs,
      current = () => this.currentConnection(project, client),
    } = {},
  ) {
    this.requireConnection(project, client);
    return client.request(
      "areal/queue/list",
      { threadId },
      {
        timeoutMs,
        decode: readCoreQueue,
        onResult: (queue) => {
          if (current()) project.model.setQueue(threadId, queue);
        },
      },
    );
  }

  /** @param {Project} project @param {Fields} request */
  async editQueue(project, request) {
    const { threadId, operation, expectedRevision } = request;
    if (
      typeof threadId !== "string" ||
      typeof operation !== "string" ||
      typeof expectedRevision !== "number" ||
      !["update", "remove", "reorder", "pause", "resume", "steer"].includes(operation) ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0
    )
      throw new Error("无效队列操作");
    /** @type {import("./project-state.cjs").SubmissionParams & {input?:unknown[]}} */
    const params = { threadId, expectedRevision };
    if (operation === "update" || operation === "remove" || operation === "steer") {
      if (typeof request.queueItemId !== "string" || !request.queueItemId)
        throw new Error("缺少排队消息");
      params.queueItemId = request.queueItemId;
    }
    if (operation === "update") {
      const retained = request.retainedInput ?? [];
      const original = project.model.state.queues[threadId]?.items.find(
        (item) => item.id === request.queueItemId,
      );
      if (
        !Array.isArray(retained) ||
        retained.length > 16 ||
        retained.some(
          (part) =>
            !modelRecord(part) ||
            part.type === "text" ||
            !original?.input?.some((input) => isDeepStrictEqual(input, part)),
        )
      )
        throw new Error("排队附件引用已变化，请核对原消息");
      const changed =
        (typeof request.text === "string" && request.text.trim()) ||
        (Array.isArray(request.attachments) && request.attachments.length) ||
        (Array.isArray(request.mcpContent) && request.mcpContent.length)
          ? messageInput(this, request)
          : [];
      params.input = [
        ...changed.filter((part) => part.type === "text"),
        ...retained,
        ...changed.filter((part) => part.type !== "text"),
      ];
      if (
        !params.input.length ||
        params.input.filter((part) => !modelRecord(part) || part.type !== "text").length > 16
      )
        throw new Error("排队消息不能为空，且最多 16 个附件");
    }
    if (operation === "steer") {
      if (typeof request.expectedTurnId !== "string" || !request.expectedTurnId)
        throw new Error("缺少目标活动轮次");
      params.expectedTurnId = request.expectedTurnId;
    }
    if (operation === "reorder") {
      if (
        !Array.isArray(request.queueItemIds) ||
        request.queueItemIds.length > 128 ||
        request.queueItemIds.some((id) => typeof id !== "string") ||
        new Set(request.queueItemIds).size !== request.queueItemIds.length
      )
        throw new Error("无效队列顺序");
      params.queueItemIds = request.queueItemIds;
    }
    try {
      if (request.requestId !== undefined && typeof request.requestId !== "string")
        throw new Error("无效队列请求标识");
      const result = await this.submit(project, `areal/queue/${operation}`, params, {
        requestId: request.requestId,
      });
      if (operation === "steer") {
        // 转移收据只保存绑定 ID 和版本，不把完整队列复制到每张收据。
        await this.refreshQueue(project, threadId).catch(() => {});
      } else project.model.setQueue(threadId, readQueueAdmission(result));
      this.onChange();
      return result;
    } catch (error) {
      // 冲突只刷新展示，不用新 revision 重放用户的旧操作。
      await this.refreshQueue(project, threadId).catch(() => {});
      throw error;
    }
  }

  /** @param {unknown} text */
  textInput(text) {
    if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > 64 * 1024)
      throw new Error("请输入有效任务内容（最多 64 KiB）");
    return [{ type: "text", text }];
  }

  /** @param {Project} project @param {string} threadId @param {{client?:Client|null,timeoutMs?:number,current?:()=>boolean}} [options] */
  async refreshConfiguration(
    project,
    threadId,
    {
      client = project.client,
      timeoutMs,
      current = () => this.currentConnection(project, client),
    } = {},
  ) {
    this.requireConnection(project, client);
    let observed;
    const conversation = project.model.state.threads[threadId]?.conversation;
    if (modelRecord(conversation?.policy) && conversation.policy.kind === "sideReadOnlyV1") {
      // Side cannot call the ordinary execution inspection route. Its read snapshot
      // supplies the same authoritative configuration and active-turn precondition.
      const { thread } = this.supportsBoundedHistory(client)
        ? await this.readObservation(project, threadId, {
            client,
            timeoutMs,
            current,
            install: false,
          })
        : await client.request(
            "thread/read",
            { threadId, includeTurns: true },
            {
              timeoutMs,
              decode: require("./history-contract.cjs").readObservationResult,
            },
          );
      if (thread?.id !== threadId || thread.conversation?.kind !== "side")
        throw new Error("Side 配置快照与目标会话不匹配");
      observed = {
        configuration: thread.desktop?.configuration,
        activeTurnId: thread.turns?.find((turn) => turn.status === "inProgress")?.id,
      };
    } else observed = await client.request("areal/thread/inspect", { threadId }, { timeoutMs });
    this.requireConnection(project, client);
    const result = readInspection(observed);
    if (!current()) throw Object.assign(new Error("观察归属已变化"), { code: "STALE_CONNECTION" });
    project.configurations ??= {};
    project.configurations[threadId] = {
      ...result.configuration,
      modelName: result.modelName,
      resolvedParameters: result.resolvedParameters,
    };
    this.onChange();
    return result;
  }

  /** @param {Project} project @param {string} threadId @param {Omit<import("@areal/workbench/desktop-contract").ConfigureRequest,"projectId"|"threadId">} request */
  async configureThread(project, threadId, request) {
    if (
      request.options?.permissionPreset !== undefined &&
      project.client?.capabilities?.features?.permissionPresets !== true
    ) {
      throw new Error("当前 Core 不支持权限模式，请更新后台后重试");
    }
    const token = randomUUID();
    project.configurationChanges ??= new Map();
    if (project.configurationChanges.has(threadId)) throw new Error("会话配置正在更新，请稍后重试");
    project.configurationChanges.set(threadId, token);
    try {
      await this.changePending(project, (pending) => {
        if (
          pending.some((value) => !isRemoteControl(value) && value.params.threadId === threadId)
        ) {
          throw new Error("该会话有未结算的请求结果，请先处理后再修改配置");
        }
        return pending;
      });
      if (
        request.model === undefined &&
        request.profile === undefined &&
        request.options === undefined &&
        request.parameters === undefined &&
        request.selectedSkills === undefined
      ) {
        throw new Error("请选择需要修改的配置");
      }
      if (request.profile === null) {
        throw new Error("当前 Core 不支持清除已选择的 Profile");
      }
      if (
        request.selectedSkills !== undefined &&
        (!Array.isArray(request.selectedSkills) ||
          request.selectedSkills.some(
            (skill) =>
              typeof skill?.id !== "string" ||
              !skill.id ||
              typeof skill?.revision !== "string" ||
              !skill.revision,
          ))
      ) {
        throw new Error("所选技能无效");
      }
      const inspection = await this.refreshConfiguration(project, threadId);
      if (inspection.activeTurnId) throw new Error("任务正在执行，完成或停止后才能修改配置");
      if (
        request.expectedRevision !== undefined &&
        request.expectedRevision !== inspection.configuration.revision
      )
        throw new Error("会话配置已变化，请刷新后重新保存");
      const params = {
        threadId,
        expectedRevision: inspection.configuration.revision,
        ...(request.profile ? { agentProfile: request.profile } : {}),
        ...(request.model === null
          ? { resetModel: true }
          : request.model
            ? { model: request.model }
            : {}),
        ...(request.options !== undefined
          ? { options: { ...inspection.configuration.options, ...request.options } }
          : {}),
        ...(request.parameters !== undefined
          ? { parameters: request.parameters }
          : request.model !== undefined
            ? { parameters: {} }
            : {}),
        // 空数组是公开契约：清除会话覆盖并恢复 Profile，不是“不用任何技能”。
        ...(request.selectedSkills !== undefined
          ? {
              selectedSkills: request.selectedSkills.map((skill) => ({
                id: skill.id,
                revision: skill.revision,
              })),
            }
          : {}),
      };
      const client = project.client;
      const configuration = readConfigured(
        await this.submit(project, "areal/thread/configure", params, {
          requestId: request.requestId,
        }),
      );
      if (this.currentConnection(project, client))
        project.configurations[threadId] = {
          ...configuration,
          modelName:
            configuration.defaultModelRevision &&
            configuration.defaultModelRevision === inspection.configuration.defaultModelRevision
              ? project.configurations[threadId]?.modelName
              : undefined,
        };
      this.onChange();
    } catch (error) {
      try {
        await this.refreshConfiguration(project, threadId);
      } catch (refreshError) {
        this.observationFailure(project, threadId, refreshError);
      }
      throw error;
    } finally {
      if (project.configurationChanges.get(threadId) === token) {
        project.configurationChanges.delete(threadId);
      }
    }
  }

  /** @param {Parameters<InstanceType<typeof SubmissionRecovery>['changePending']>} args */
  changePending(...args) {
    return this.submissions.changePending(...args);
  }

  /** @param {Parameters<InstanceType<typeof SubmissionRecovery>['changeOutcomes']>} args */
  changeOutcomes(...args) {
    return this.submissions.changeOutcomes(...args);
  }

  /** @param {Parameters<InstanceType<typeof SubmissionRecovery>['rememberWorkgroupOutcome']>} args */
  rememberWorkgroupOutcome(...args) {
    return this.submissions.rememberWorkgroupOutcome(...args);
  }

  /** @param {Parameters<InstanceType<typeof SubmissionRecovery>['recoverWorkgroupSubmission']>} args */
  recoverWorkgroupSubmission(...args) {
    return this.submissions.recoverWorkgroupSubmission(...args);
  }

  /** @param {Parameters<InstanceType<typeof SubmissionRecovery>['recoverProcessSubmission']>} args */
  recoverProcessSubmission(...args) {
    return this.submissions.recoverProcessSubmission(...args);
  }

  /** @param {Parameters<InstanceType<typeof SubmissionRecovery>['recoverAgentSubmission']>} args */
  recoverAgentSubmission(...args) {
    return this.submissions.recoverAgentSubmission(...args);
  }

  /** @param {Parameters<InstanceType<typeof SubmissionRecovery>['remoteRecord']>} args */
  remoteRecord(...args) {
    return this.submissions.remoteRecord(...args);
  }

  /** @param {Parameters<InstanceType<typeof SubmissionRecovery>['readRemoteRecord']>} args */
  readRemoteRecord(...args) {
    return this.submissions.readRemoteRecord(...args);
  }

  /** @param {Parameters<InstanceType<typeof SubmissionRecovery>['rememberRemoteOutcome']>} args */
  rememberRemoteOutcome(...args) {
    return this.submissions.rememberRemoteOutcome(...args);
  }

  /** @param {Parameters<InstanceType<typeof SubmissionRecovery>['recoverRemoteSubmission']>} args */
  recoverRemoteSubmission(...args) {
    return this.submissions.recoverRemoteSubmission(...args);
  }

  /** @param {Parameters<InstanceType<typeof SubmissionRecovery>['submitRemote']>} args */
  submitRemote(...args) {
    return this.submissions.submitRemote(...args);
  }

  /** @param {Parameters<InstanceType<typeof SubmissionRecovery>['submit']>} args */
  async submit(...args) {
    try {
      return await this.submissions.submit(...args);
    } catch (error) {
      const [project, , parameters] = args;
      const model =
        modelRecord(parameters.model) &&
        typeof parameters.model.providerId === "string" &&
        typeof parameters.model.modelId === "string"
          ? { providerId: parameters.model.providerId, modelId: parameters.model.modelId }
          : typeof parameters.threadId === "string"
            ? project.configurations?.[parameters.threadId]?.model
            : undefined;
      this.providers.rejectModel(project, model, error);
      throw error;
    }
  }

  /** @param {Parameters<InstanceType<typeof SubmissionRecovery>['processControlOutcome']>} args */
  processControlOutcome(...args) {
    return this.submissions.processControlOutcome(...args);
  }

  /** @param {Parameters<InstanceType<typeof SubmissionRecovery>['requestSubmission']>} args */
  requestSubmission(...args) {
    return this.submissions.requestSubmission(...args);
  }

  /** @param {Parameters<InstanceType<typeof SubmissionRecovery>['readReceipt']>} args */
  readReceipt(...args) {
    return this.submissions.readReceipt(...args);
  }

  /** @param {Parameters<InstanceType<typeof SubmissionRecovery>['readSubmission']>} args */
  readSubmission(...args) {
    return this.submissions.readSubmission(...args);
  }

  /** @param {Parameters<InstanceType<typeof SubmissionRecovery>['rememberOutcome']>} args */
  rememberOutcome(...args) {
    return this.submissions.rememberOutcome(...args);
  }

  /** @param {Parameters<InstanceType<typeof SubmissionRecovery>['reconciliationCurrent']>} args */
  reconciliationCurrent(...args) {
    return this.submissions.reconciliationCurrent(...args);
  }

  /** @param {Parameters<InstanceType<typeof SubmissionRecovery>['stopReconciliation']>} args */
  stopReconciliation(...args) {
    return this.submissions.stopReconciliation(...args);
  }

  /** @param {Parameters<InstanceType<typeof SubmissionRecovery>['scheduleReconciliation']>} args */
  scheduleReconciliation(...args) {
    return this.submissions.scheduleReconciliation(...args);
  }

  /** @param {Parameters<InstanceType<typeof SubmissionRecovery>['reconcile']>} args */
  reconcile(...args) {
    return this.submissions.reconcile(...args);
  }

  /** @param {Parameters<InstanceType<typeof SubmissionRecovery>['reconcileEntries']>} args */
  reconcileEntries(...args) {
    return this.submissions.reconcileEntries(...args);
  }

  /** @param {string} commandName @param {Record<string,unknown>} rawRequest
   * @param {{onMcpAppOpened?:(project:import('./project-state.cjs').CoreProject,client:import('@areal/runtime-client/core').CoreClient,request:Record<string,unknown>,result:unknown)=>void,onBrowserTurnStarted?:(turnId:string)=>void,onBrowserTurnQueued?:(queueItemId:string)=>void}} [context] */
  async command(commandName, rawRequest, context = {}) {
    const semantics = commandSemantics(commandName, rawRequest);
    if (semantics.requestId && !rawRequest[semantics.requestId])
      rawRequest = { ...rawRequest, [semantics.requestId]: randomUUID() };
    const invocation = readCommandInvocation(commandName, { ...rawRequest });
    if (this.worktrees && !this.cloudConversations?.routes(commandName, rawRequest))
      Object.assign(
        invocation.request,
        await this.worktrees.resolveRequest(commandName, invocation.request),
      );
    const { name, request } = invocation;
    const projectId =
      "projectId" in request && typeof request.projectId === "string"
        ? request.projectId
        : undefined;
    const threadId =
      "threadId" in request && typeof request.threadId === "string" ? request.threadId : undefined;
    if (name === "history" && request.operation === "release") {
      const project = projectId === undefined ? undefined : this.projects.get(projectId);
      return project ? this.historyCommand(project, request) : { released: true };
    }
    if (name === "stop") {
      const project = projectId === undefined ? undefined : this.projects.get(projectId);
      if (!project?.service || !project.client?.ready)
        throw Object.assign(new Error("原 Core 连接不可用，不能中断轮次"), {
          code: "LIFECYCLE_INCOMPLETE",
        });
      return this.lifecycleOperations.request({
        requestId: request.requestId,
        kind: "interruptTurn",
        mode: "cancel",
        expectedDesktopGeneration: this.lifecycleOperations.generation,
        expectedTargets: [
          {
            projectId: request.projectId,
            serviceId: project.service.serviceId,
            generation: project.service.generation,
          },
        ],
        threadId: request.threadId,
        turnId: request.turnId,
      });
    }
    const lifecycleBlock = this.lifecycleOperations.blocking(projectId, threadId);
    if (
      (lifecycleBlock ||
        this.lifecycleOperations.activeRequestId ||
        (projectId !== undefined && this.lifecycleOperations.activeTargets.has(projectId))) &&
      (["open", "list", "connect"].includes(name) ||
        require("./lifecycle.cjs").isRecoveryCommand(name, request))
    ) {
      const project = projectId === undefined ? undefined : this.projects.get(projectId);
      if (!project?.service || !project.client?.ready)
        throw Object.assign(new Error("原 Core 已断开，不能确认核查目标"), {
          code: "LIFECYCLE_INCOMPLETE",
        });
      const original = lifecycleBlock?.targets.find((target) => target.projectId === projectId);
      if (
        original &&
        (project.service.serviceId !== original.serviceId ||
          project.service.generation !== original.generation)
      )
        throw Object.assign(new Error("原 Core 代际已变化，不能用新实例代替核查"), {
          code: "CONFIRMATION_STALE",
        });
      if (name === "history") return this.historyCommand(project, request);
      if (name === "manage") return manage(this, project, request, context);
      if (name === "open") await this.openThread(project, request.threadId);
      if (name === "list") await this.listThreads(project);
      return this.snapshot();
    }
    this.lifecycleOperations.assertProject(projectId, threadId);
    if (this.closing && require("./lifecycle.cjs").isRecoveryCommand(name, request)) {
      const project = projectId === undefined ? undefined : this.projects.get(projectId);
      if (!project?.service || !project.client?.ready)
        throw new Error("原 Core 已断开，不能确认核查目标");
      if (name === "history") return this.historyCommand(project, request);
      return manage(this, project, request, context);
    }
    if (this.closing) throw new Error("应用正在退出");
    if (name === "analytics") return this.analytics.command(request);
    // 后台只读状态不占任务或配置准入；参数仍由轨迹能力校验。
    if (name === "trajectory" && request?.operation === "status")
      return this.trajectory.command(request);
    if (name === "trajectory" && request?.operation === "setEnabled")
      return this.trajectory.setEnabled(request);
    if (name === "feedback" && request?.operation === "status")
      return this.feedback.command(request);
    if (name === "chatgpt") return this.providers.chatgpt(request);
    if (name === "providers") return this.providers.command(request);
    if (name === "cloud") return this.cloud.command(request);
    if (name === "cloudSession") return this.cloudConversations.command(request);
    if (this.cloudConversations?.owns(projectId, threadId))
      return this.cloudConversations.route(name, request);
    if (name === "resources") return this.resources.command(request);
    if (this.providerUpdating || this.resourcesUpdating)
      throw new Error("配置正在应用，请稍后重试");
    this.activeCommands++;
    try {
      return await this.dispatchCommand(invocation, context);
    } finally {
      this.activeCommands--;
    }
  }

  /** @param {Project} project @param {Fields} request */
  assertThreadCreationAvailable(project, request) {
    if (project.client?.capabilities?.features?.permissionPresets !== true) {
      throw Object.assign(new Error("当前 Core 不支持权限模式，请更新后台后创建聊天"), {
        submissionUnknown: false,
        outcome: { kind: "noMutation" },
      });
    }
    if (
      request.browserEnabled === true &&
      projectCoreCapabilities(this.binary, project.client?.capabilities).features
        ?.browserToolAttachment !== true
    ) {
      throw Object.assign(new Error("当前 Core 不支持新聊天启用浏览器"), {
        submissionUnknown: false,
        outcome: { kind: "noMutation" },
      });
    }
  }

  /** @param {Project} project @param {Fields} request */
  async createThreadInProject(project, request) {
    this.assertThreadCreationAvailable(project, request);
    try {
      await this.resources.beforeCreate(project);
      const configured = request.model;
      if (modelRecord(configured) && configured.providerId === "areal_openai") {
        await this.providers.ensureSubscription(project);
      }
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        submissionUnknown: false,
        outcome: { kind: "noMutation" },
      });
    }
    if (request.options !== undefined && !modelRecord(request.options))
      throw new Error("无效会话配置");
    if (request.requestId !== undefined && typeof request.requestId !== "string")
      throw new Error("无效创建请求标识");
    /** @type {Fields} */
    let options = { permissionPreset: "ask", ...request.options };
    /** @type {unknown[]} */
    let tools = this.desktopTools(project);
    if (
      this.library.value.settings.computerControlEnabled === true &&
      this.library.value.settings.computerControlProvider === "lcu"
    ) {
      if (project.client?.capabilities?.features?.externalCua !== true)
        throw new Error(
          "This Core does not support external CUA; update Core before creating this chat",
        );
      if (!this.cuaRead) throw new Error("External CUA desktop host is unavailable");
      const catalog = await this.cuaRead({
        phase: "catalog",
        projectId: project.id,
        cwd: project.root,
        coreInstanceId: project.service?.serviceId,
        coreGeneration: project.service?.generation,
      });
      if (
        !modelRecord(catalog) ||
        typeof catalog.instructions !== "string" ||
        !Array.isArray(catalog.tools)
      )
        throw new Error("Invalid external CUA catalog");
      const appendInstructions = [options.appendInstructions, catalog.instructions]
        .filter(Boolean)
        .join("\n\n");
      options = { ...options, externalCua: true, appendInstructions };
      if (Buffer.byteLength(appendInstructions) > 32768)
        throw new Error("Complete LCU and client instructions exceed the 32768-byte budget");
      tools = [...tools, ...catalog.tools];
    }
    const { thread } = readThreadAdmission(
      await this.submit(
        project,
        "areal/thread/start",
        {
          cwd: project.root,
          ...(tools.length ? { dynamicTools: tools } : {}),
          ...(request.parameters ? { parameters: request.parameters } : {}),
          options,
          ...(request.model ? { model: request.model } : {}),
          ...((request.profile ?? project.resourceProfile ?? this.defaultProfile)
            ? {
                agentProfile: request.profile ?? project.resourceProfile ?? this.defaultProfile,
              }
            : {}),
        },
        { requestId: request.requestId },
      ),
    );
    await this.refreshAfterAdmission(
      project,
      thread.id,
      operationOf("areal/thread/start", request),
      { backgroundList: true },
    );
    return { threadId: thread.id, requestId: request.requestId };
  }

  /** @param {string} commandName @param {Fields} rawRequest @param {NonNullable<Parameters<CoreBackend["command"]>[2]>} [context] */
  executeCommand(commandName, rawRequest, context = {}) {
    return this.dispatchCommand(readCommandInvocation(commandName, rawRequest), context);
  }

  /** @param {import("@areal/workbench/desktop-contract").CommandInvocation} invocation @param {NonNullable<Parameters<CoreBackend["command"]>[2]>} context */
  async dispatchCommand(invocation, context) {
    const { name, request } = invocation;
    const projectId = "projectId" in request ? request.projectId : undefined;
    if (this.closing) throw new Error("应用正在退出");
    if (name === "trajectory") return this.trajectory.command(request);
    if (name === "feedback") return this.feedback.command(request);
    if (name === "tasks") return taskCatalog(this, request);
    if (name === "projectless") return this.projectless.command(request);
    if (name === "library") return this.library.command(request);
    if (!(name === "workspace" && request.operation.startsWith("worktree")) && name !== "create") {
      if (projectId !== undefined && typeof projectId !== "string") throw new Error("无效项目标识");
      this.worktrees.assertAvailable(projectId);
      if (commandSemantics(name, request).effect === "mutation") {
        const operation = [...this.worktrees.records.values()].find(
          (value) =>
            value.executionProjectId === projectId && value.threadId && value.state !== "ready",
        );
        if (operation) throw new Error("工作树环境尚未就绪，不能执行会话写操作");
      }
    }
    if (name === "workspace") {
      if (this.worktreeAdmission.needsAdmission(name, request)) {
        if (typeof request.projectId !== "string") throw new Error("缺少工作区项目标识");
        await this.worktreeAdmission.admit(await this.start(request.projectId), name, request);
      }
      return workspaceCommand(this, request);
    }
    if (typeof projectId !== "string") throw new Error("缺少项目标识");
    if (name === "connect" && request.resumeScheduling === true)
      for (const owner of this.worktrees.owners(
        "logicalProjectId" in request && typeof request.logicalProjectId === "string"
          ? request.logicalProjectId
          : projectId,
      ))
        await this.lifecycleOperations.resumeScheduling(owner.id);
    const project = await this.start(
      projectId,
      name === "connect" || name === "open" ? { threadId: request.threadId } : undefined,
    );
    if (this.closing) throw new Error("应用正在退出");
    await this.worktreeAdmission.admit(project, name, request);
    if (
      ["send", "editMessage", "continue", "steer"].includes(name) ||
      (name === "side" &&
        (["start", "send"].includes(request.operation) ||
          (request.operation === "create" && request.firstInput)))
    ) {
      const configured =
        name === "side" && request.operation === "create"
          ? project.configurations?.[request.sourceThreadId]?.model
          : name === "side" && request.operation === "start"
            ? request.model
            : "threadId" in request && typeof request.threadId === "string"
              ? project.configurations[request.threadId]?.model
              : undefined;
      if (configured?.providerId === "areal_openai")
        await this.providers.ensureSubscription(project);
    }
    switch (name) {
      case "connect":
        await this.worktrees.connectExecutions(
          "logicalProjectId" in request && typeof request.logicalProjectId === "string"
            ? request.logicalProjectId
            : project.id,
        );
        return this.snapshot();
      case "prediction": {
        if (!project.client?.capabilities?.methods?.includes("areal/thread/prediction"))
          return null;
        return project.client.request("areal/thread/prediction", {
          threadId: request.threadId,
          sourceTurnId: request.sourceTurnId,
          operation: request.operation,
        });
      }
      case "prepareCreator":
        return this.resources.prepareCreator(project, request.profile);
      case "dismissRecovery": {
        const requestId = request.requestId;
        if (typeof requestId !== "string") throw new Error("缺少原请求标识");
        await this.changeOutcomes(project, (previous) => {
          const outcomes = { ...previous };
          if (!outcomes[requestId]?.remote) delete outcomes[requestId];
          return outcomes;
        });
        break;
      }
      case "media":
        return mediaCommand(project, request, this);
      case "manage":
        if (
          "threadId" in request &&
          typeof request.threadId === "string" &&
          isTaskDraftConfiguration(project.configurations[request.threadId]) &&
          typeof request.operation === "string" &&
          request.operation.startsWith("goal")
        ) {
          throw new Error("任务管理会话不执行目标；请在会话中描述要调整的定时任务。");
        }
        return manage(this, project, request, context);
      case "list":
        await this.listThreads(project);
        await this.worktrees.connectExecutions(
          "logicalProjectId" in request && typeof request.logicalProjectId === "string"
            ? request.logicalProjectId
            : project.id,
        );
        break;
      case "open":
        await this.openThread(project, request.threadId);
        break;
      case "history":
        return this.historyCommand(project, request);
      case "attachBrowser": {
        this.requireConnection(project, project.client);
        if (
          !project.client.capabilities?.methods?.includes("areal/thread/tools/attach") ||
          project.client.capabilities?.features?.browserToolAttachment !== true ||
          !project.client.capabilities?.browserToolBundles?.some(
            (bundle) => bundle.bundleId === "areal.browser.v1",
          )
        ) {
          throw new Error("当前 Core 不支持在已有聊天启用浏览器");
        }
        const existing = project.model.state.threads[request.threadId];
        if (
          !existing ||
          existing.desktop?.archived ||
          !modelRecord(existing.status) ||
          existing.status.type !== "idle" ||
          (existing.toolsetRevision !== request.expectedToolsetRevision &&
            (existing.toolsetRevision ?? 0) !== request.expectedToolsetRevision)
        ) {
          throw new Error("聊天状态或工具版本已变化，请刷新后重试");
        }
        const result = await this.submit(
          project,
          "areal/thread/tools/attach",
          {
            threadId: request.threadId,
            expectedToolsetRevision: request.expectedToolsetRevision,
            bundleId: "areal.browser.v1",
          },
          { requestId: request.requestId },
        );
        await this.refreshAfterAdmission(
          project,
          request.threadId,
          operationOf("areal/thread/tools/attach", request),
        );
        return result;
      }
      case "configure": {
        if (
          isTaskDraftConfiguration(project.configurations?.[request.threadId]) &&
          (request.options !== undefined || request.profile !== undefined)
        ) {
          throw new Error("任务管理会话的执行限制不能修改；请在会话中描述要调整的任务。");
        }
        await this.configureThread(project, request.threadId, request);
        break;
      }
      case "queue": {
        if (!request.requestId) return this.refreshQueue(project, request.threadId);
        if (
          typeof request.requestId !== "string" ||
          !/^[0-9a-f-]{36}$/.test(request.requestId) ||
          typeof request.operation !== "string" ||
          !["update", "remove", "reorder", "pause", "resume", "steer"].includes(request.operation)
        )
          throw new Error("无效队列收据查询");
        const method = `areal/queue/${request.operation}`;
        return this.readSubmission(project, method, {
          requestId: request.requestId,
          threadId: request.threadId,
        });
      }
      case "queueEdit":
        return this.editQueue(project, request);
      case "create":
        return this.worktrees.createThread(project, request);
      case "fork": {
        this.requireConnection(project, project.client);
        if (!project.client.capabilities?.methods?.includes("areal/thread/fork"))
          throw new Error("当前 Core 不支持从此轮次创建分支");
        const result = readThreadAdmission(
          await this.submit(
            project,
            "areal/thread/fork",
            {
              sourceThreadId: request.sourceThreadId,
              anchor: request.anchor,
              workspaceMode: "sharedCurrent",
              ...(request.target ? { target: request.target } : {}),
            },
            { requestId: request.requestId },
          ),
        );
        // 创建收据已确认受理；后续投影失败不能把已提交的创建显示成可重试错误。
        await this.refreshAfterAdmission(
          project,
          result.thread.id,
          operationOf("areal/thread/fork", request),
        );
        return { threadId: result.thread.id, requestId: result.requestId };
      }
      case "side": {
        this.requireConnection(project, project.client);
        const requestId = "requestId" in request ? request.requestId : undefined;
        if (requestId !== undefined && typeof requestId !== "string")
          throw new Error("无效 Side 请求标识");
        if (!project.client.capabilities?.methods?.includes("areal/side/start"))
          throw new Error("当前 Core 不支持旁路讨论");
        if (request.operation === "list") {
          if (!project.client.capabilities?.methods?.includes("areal/conversation/list"))
            throw new Error("当前 Core 不支持相关讨论列表");
          const page = await project.client.request(
            "areal/conversation/list",
            {
              view: "side",
              sourceThreadId: request.sourceThreadId,
              includeArchived: request.includeArchived === true,
              limit: 30,
              ...(request.cursor ? { cursor: request.cursor } : {}),
            },
            { decode: require("./history-contract.cjs").readThreadList },
          );
          return {
            ...page,
            data: page.data.filter(
              (thread) => thread.conversation?.policy?.kind === "sideReadOnlyV1",
            ),
          };
        }
        if (request.operation === "context")
          return project.client.request("areal/side/context/read", {
            threadId: request.threadId,
            ...(request.cursor ? { cursor: request.cursor } : {}),
            ...(request.evidenceRef ? { evidenceRef: request.evidenceRef } : {}),
            ...(request.maxBytes ? { maxBytes: request.maxBytes } : {}),
          });
        if (request.operation === "create" || request.operation === "close") {
          if (
            !projectCoreCapabilities(this.binary, project.client.capabilities).features
              ?.sideExecutableV2
          )
            throw new Error("当前 Core 不支持可执行 Side Chat");
          const method = `areal/side/${request.operation}`;
          const result = readAdmission(
            await this.submit(
              project,
              method,
              request.operation === "create"
                ? {
                    sourceThreadId: request.sourceThreadId,
                    ...(request.firstInput
                      ? { firstInput: messageInput(this, request.firstInput) }
                      : {}),
                  }
                : { threadId: request.threadId },
              { requestId },
            ),
          );
          const childId = result.thread?.id ?? result.threadId;
          await this.refreshAfterAdmission(project, childId, operationOf(method, request));
          return request.operation === "create"
            ? {
                requestId: result.requestId,
                threadId: childId,
                ...(result.turn?.id ? { turnId: result.turn.id } : {}),
              }
            : result;
        }
        if (request.operation === "recover") {
          const sourceThreadId = request.sourceThreadId,
            threadId = request.threadId;
          if (
            (sourceThreadId !== undefined && typeof sourceThreadId !== "string") ||
            (threadId !== undefined && typeof threadId !== "string")
          )
            throw new Error("无效 Side 恢复身份");
          const method = request.method ?? "areal/side/start";
          const receipts = await project.client.request(
            "areal/request/read",
            {
              requestId: request.requestId,
              ...(request.threadId ? { threadId: request.threadId } : {}),
            },
            { decode: require("./receipt-contract.cjs").readReceipts },
          );
          const receipt = receipts.data?.find((item) => item.method === method);
          if (!receipt?.result) return { confirmed: false };
          const result = readAdmission(receipt.result);
          const id = result.threadId;
          if (!id) return { confirmed: false };
          await this.changeOutcomes(project, (outcomes) => ({
            ...outcomes,
            [request.requestId]: {
              accepted: true,
              method,
              sourceThreadId,
              threadId: id,
              ...(result.turnId ? { turnId: result.turnId } : {}),
              ...(method === "areal/side/close"
                ? { cleanupConfirmed: result.cleanupConfirmed === true }
                : {}),
            },
          }));
          await this.changePending(project, (pending) =>
            pending.filter((item) => item.params.requestId !== request.requestId),
          );
          await this.refreshAfterAdmission(
            project,
            id,
            operationOf(method, { requestId, sourceThreadId, threadId }),
          );
          return {
            confirmed: true,
            requestId: request.requestId,
            threadId: id,
            ...(result.turnId ? { turnId: result.turnId } : {}),
            ...(method === "areal/side/close"
              ? { accepted: true, cleanupConfirmed: result.cleanupConfirmed === true }
              : {}),
          };
        }
        if (request.operation === "send") {
          const current = project.model.state.threads[request.threadId];
          if (current?.conversation?.kind !== "side") throw new Error("目标不是旁路讨论");
          const result = await this.submit(
            project,
            "areal/turn/start",
            {
              threadId: request.threadId,
              input: [
                {
                  type: "text",
                  text: await this.genUiText(project, request.threadId, request.text),
                },
              ],
            },
            { requestId },
          );
          // 追问已受理；快照读取失败只能通过重新打开恢复，不能重发输入。
          try {
            await this.openThread(project, request.threadId);
          } catch {
            /* 保留明确受理结果。 */
          }
          return result;
        }
        const result = readThreadAdmission(
          await this.submit(
            project,
            "areal/side/start",
            {
              sourceThreadId: request.sourceThreadId,
              workspaceAccess: request.workspaceAccess === "readOnly" ? "readOnly" : "none",
              ...(request.selection ? { selection: request.selection } : {}),
              ...(request.anchor ? { anchor: request.anchor } : {}),
              input: [{ type: "text", text: request.text }],
              ...(request.resetModel === true ? { resetModel: true } : {}),
              ...(request.model ? { model: request.model } : {}),
              ...(request.parameters ? { parameters: request.parameters } : {}),
            },
            { requestId },
          ),
        );
        // 与 Fork 一样，投影刷新不改变 Core 已确认的创建结果。
        await this.refreshAfterAdmission(
          project,
          result.thread.id,
          operationOf("areal/side/start", {
            requestId,
            sourceThreadId: request.sourceThreadId,
          }),
        );
        return {
          threadId: result.thread.id,
          turnId: result.turn?.id,
          requestId: result.requestId,
        };
      }
      case "send": {
        this.requireConnection(project, project.client);
        const configuration = project.configurations[request.threadId];
        if (isTaskDraftConfiguration(configuration)) {
          const zone = configuration.options.appendInstructions
            .split("\n")[1]
            .slice("Time zone: ".length);
          return manageTaskDraft(this, project, {
            operation: "taskDraftSend",
            threadId: request.threadId,
            timeZone: zone,
            text: request.text,
            attachments: request.attachments,
            requestId: request.requestId,
          });
        }
        await this.ensureBrowserTools(project, request.threadId);
        const input = messageInput(this, {
          ...request,
          text: await this.genUiText(project, request.threadId, request.text),
        });
        const current = project.model.state.threads[request.threadId];
        let submitted;
        if (
          current?.goals?.goal ||
          current?.goalOwner ||
          current?.parentThreadId ||
          current?.source === "nativeTaskAgent" ||
          (modelRecord(current?.conversation?.policy) &&
            current.conversation.policy.kind === "sideReadOnlyV1")
        ) {
          const enqueue = current.turns?.some((turn) => turn.status === "inProgress");
          submitted = readAdmission(
            await this.submit(
              project,
              enqueue ? "areal/turn/enqueue" : "areal/turn/start",
              { threadId: request.threadId, input },
              { requestId: request.requestId },
            ),
          );
        } else {
          if (
            !projectCoreCapabilities(this.binary, project.client.capabilities).features
              ?.ordinaryTurnSubmit
          )
            throw new Error("当前 Core 不支持普通会话提交，请更新 Core。");
          submitted = readAdmission(
            await this.submit(
              project,
              "areal/turn/submit",
              {
                threadId: request.threadId,
                expectedConfigRevision: readInspection({
                  configuration: project.configurations[request.threadId],
                }).configuration.revision,
                intent: { type: "message", input },
              },
              { requestId: request.requestId },
            ),
          );
        }
        if (submitted.queueItemId) context.onBrowserTurnQueued?.(submitted.queueItemId);
        else if (submitted.turn?.id) context.onBrowserTurnStarted?.(submitted.turn.id);
        return submitted;
      }
      case "editMessage": {
        this.requireConnection(project, project.client);
        if (
          !projectCoreCapabilities(this.binary, project.client.capabilities).features
            ?.editLastMessage
        )
          throw new Error("当前 Core 不支持编辑消息，请更新 Core。");
        await this.ensureBrowserTools(project, request.threadId);
        const submitted = readAdmission(
          await this.submit(
            project,
            "areal/turn/submit",
            {
              threadId: request.threadId,
              expectedConfigRevision: request.expectedConfigRevision,
              intent: {
                type: "edit",
                expectedTurnId: request.expectedTurnId,
                itemId: request.itemId,
                input: messageInput(this, {
                  ...request,
                  text: await this.genUiText(project, request.threadId, request.text),
                }),
              },
            },
            { requestId: request.requestId },
          ),
        );
        if (submitted.turn?.id) context.onBrowserTurnStarted?.(submitted.turn.id);
        return submitted;
      }
      case "continue": {
        this.requireConnection(project, project.client);
        if (
          !projectCoreCapabilities(this.binary, project.client.capabilities).features
            ?.ordinaryTurnSubmit
        )
          throw new Error("当前 Core 不支持继续执行，请更新 Core。");
        await this.ensureBrowserTools(project, request.threadId);
        const submitted = readAdmission(
          await this.submit(
            project,
            "areal/turn/submit",
            {
              threadId: request.threadId,
              expectedConfigRevision:
                request.expectedConfigRevision ??
                readInspection({
                  configuration: project.configurations[request.threadId],
                }).configuration.revision,
              intent: { type: "continue", expectedTurnId: request.expectedTurnId },
            },
            { requestId: request.requestId },
          ),
        );
        if (submitted.turn?.id) context.onBrowserTurnStarted?.(submitted.turn.id);
        return submitted;
      }
      case "steer": {
        const requestId = request.requestId;
        if (requestId !== undefined && typeof requestId !== "string")
          throw new Error("无效转向请求标识");
        if (isTaskDraftConfiguration(project.configurations?.[request.threadId]))
          throw new Error("请等待当前安排完成后再补充修改要求。");
        const active = project.model.state.threads[request.threadId]?.turns?.find(
          (turn) => turn.status === "inProgress",
        );
        if (!active || active.id !== request.expectedTurnId)
          throw new Error("原轮次已结束，请作为新消息发送");
        await this.submit(
          project,
          "turn/steer",
          {
            threadId: request.threadId,
            expectedTurnId: active.id,
            input: messageInput(this, {
              ...request,
              text: await this.genUiText(project, request.threadId, request.text),
            }),
            previousItems: (active.items ?? []).map((item) => item.id),
          },
          { requestId },
        );
        break;
      }
      case "respond": {
        this.requireConnection(project, project.client);
        const interaction = project.model.state.interactions[request.threadId]?.data.find(
          (item) => item.requestId === request.requestId && item.status === "pending",
        );
        if (!interaction) throw new Error("交互已过期，请刷新任务状态");
        try {
          await project.client.request("areal/interaction/respond", {
            threadId: request.threadId,
            turnId: interaction.turnId,
            requestId: interaction.requestId,
            ...(interaction.kind === "approval"
              ? {
                  decision: request.decision,
                  argumentsDigest: interaction.argumentsDigest,
                }
              : { answers: request.answers }),
          });
        } catch (error) {
          const current = await project.client
            .request(
              "areal/interaction/list",
              { threadId: request.threadId },
              { decode: require("./history-contract.cjs").readHistoryInteractions },
            )
            .catch(() => null);
          if (current) project.model.setInteractions(request.threadId, current);
          throw error;
        }
        break;
      }
      case "reconcile":
        await this.reconcile(project);
        await this.refreshAfterAdmission(project);
        return { outcomes: project.outcomes };
      default:
        throw new Error("不支持的操作");
    }
    return this.snapshot();
  }

  hasWork({ includePausedQueues = true } = {}) {
    return [...this.projects.values()].some(
      (project) =>
        project.pending.some((entry) => !isRemoteControl(entry)) ||
        Object.values(project.model.state.threads).some((thread) =>
          thread.turns?.some((turn) => turn.status === "inProgress"),
        ) ||
        // Paused pending messages are persisted input, not live execution. Lifecycle
        // checks can preserve them through shutdown; provider changes still guard them.
        Object.values(project.model.state.queues).some((queue) =>
          queue.items.some(
            (item) =>
              item.status === "running" ||
              (item.status === "pending" && (includePausedQueues || queue.paused !== true)),
          ),
        ),
    );
  }

  async shutdown({ requireSafe = true, cancel = false } = {}) {
    if (!requireSafe) return this.disconnect();
    const receipt = await this.lifecycleOperations.request({
      requestId: randomUUID(),
      kind: "stopDesktop",
      mode: cancel ? "cancel" : "ifIdle",
      expectedDesktopGeneration: this.lifecycleOperations.generation,
      expectedTargets: this.lifecycleOperations.targets(),
    });
    if (receipt.desktopExit !== "requested")
      throw Object.assign(new Error("后台停止尚未完成，请检查原请求"), {
        code: "LIFECYCLE_INCOMPLETE",
        requestId: receipt.requestId,
        lifecycle: receipt,
      });
    return receipt;
  }

  async disconnect() {
    this.closing = true;
    this.cloudConversations.close();
    this.ownerTasks.stop();
    this.scheduleOwners?.stop();
    for (const project of new Set([
      ...this.projects.values(),
      ...[...this.ownedEngines.values()].map((entry) => entry.project),
    ])) {
      if (project.reconnectTimer) clearTimeout(project.reconnectTimer);
      project.reconnectTimer = null;
      project.taskNotificationMonitor?.stop();
      this.stopReconciliation(project);
      project.client?.close();
    }
    await Promise.allSettled(this.starting.values());
    await Promise.allSettled([...this.projects.values()].map((project) => project.summaryReads));
    await this.providers.close();
    await this.proxyRelay?.close();
    await this.analytics.flush();
  }
}

module.exports = { CoreBackend };
