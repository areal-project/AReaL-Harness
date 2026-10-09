'use strict';

const { connectService, stopService } = require('./local-service.cjs');
const { randomUUID, createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { mkdir, readFile, writeFile, rename, realpath, rm } = require('node:fs/promises');
const { join, isAbsolute } = require('node:path');
const WebSocket = require('ws');
const { ScopedResources } = require('./scoped-resources.cjs');
const { AppHooks } = require('./hooks.cjs');
const { AppProviders } = require('./providers.cjs');
const { UsageAnalytics } = require('./analytics.cjs');
const { CoreLibrary } = require('./library.cjs');
const { CoreNotifications, TaskNotificationMonitor } = require('./notifications.cjs');
const { manage, managementMethods, threadMutationMethods } = require('./management.cjs');
const { taskMutationMethods } = require('./tasks.cjs');
const { taskCatalog } = require('./task-catalog.cjs');
const { isTaskDraftConfiguration } = require('./task-draft.cjs');
const { mediaCommand, messageInput } = require('./media.cjs');
const { workspaceCommand } = require('./workspace.cjs');
const { CoreWorktrees } = require('./worktrees.cjs');
const { ProjectlessWorkspaces } = require('./projectless.cjs');
const { inspectCoreCapabilities, projectCoreCapabilities } = require('./core-capabilities.cjs');

const workgroupMutationMethods = new Set(['areal/workgroup/start', 'areal/workgroup/revise', 'areal/workflow/start']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 每个项目连接公开的共享 Core 服务；这里只保留可重建投影与客户端受理回执。 */
class CoreBackend {
  constructor({ binary, home, harnessHome = join(home, 'harness'), config, desktopConfig, userHome, toolExtensions, workgroupPolicy, workgroupToolchain, desktopProcesses = false, defaultProfile, encryption, onChange = () => {} }) {
    if (!binary || !isAbsolute(binary)) throw new Error('请设置 AREAL_CORE_BIN 为 areal 可执行文件的绝对路径');
    this.binary = binary;
    this.home = home;
    this.harnessHome = harnessHome;
    this.config = config;
    this.toolExtensions = toolExtensions;
    this.workgroupPolicy = workgroupPolicy;
    this.workgroupToolchain = workgroupToolchain;
    this.desktopProcesses = desktopProcesses;
    this.defaultProfile = defaultProfile;
    this.userHome = userHome;
    this.desktopConfig = desktopConfig;
    this.onChange = onChange;
    this.projects = new Map();
    this.starting = new Map();
    this.saves = new Map();
    this.closing = false;
    this.library = new CoreLibrary(this);
    this.worktrees = new CoreWorktrees(this);
    this.projectless = new ProjectlessWorkspaces(this);
    this.notifications = new CoreNotifications(notice => this.onNotification?.(notice));
    this.analytics = new UsageAnalytics(this);
    this.resources = new ScopedResources(this);
    this.hooks = new AppHooks(this);
    this.providers = new AppProviders(this, encryption);
    this.activeCommands = 0;
    this.awaitingResponses = new WeakSet();
  }

  async init() {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    try {
      this.saved = JSON.parse(await readFile(join(this.home, 'projects.json'), 'utf8'));
      if (!Array.isArray(this.saved)) throw new Error('Invalid project index');
    } catch (error) { if (error.code !== 'ENOENT') throw error; this.saved = []; }
    await this.library.init();
    await this.projectless.init();
    await this.analytics.init();
    inspectCoreCapabilities(this.binary);
    await this.providers.init();
    await this.resources.init();
  }

  save(name, value) {
    const contents = JSON.stringify(value);
    const task = (this.saves.get(name) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const path = join(this.home, name);
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, contents, { mode: 0o600 });
      await rename(temporary, path);
    });
    this.saves.set(name, task);
    return task;
  }

  async addProject(path) {
    if (this.providerUpdating || this.resourcesUpdating) throw new Error('配置正在更新，请稍后打开项目');
    this.activeCommands++;
    try { return await this.addProjectPath(path); }
    finally { this.activeCommands--; }
  }

  async addProjectPath(path, worktreeResources, projectlessRequestId) {
    if (this.providerUpdating || this.resourcesUpdating) throw new Error('配置正在更新，请稍后打开项目');
    const root = await realpath(path);
    const id = createHash('sha256').update(root).digest('hex').slice(0, 24);
    const registration = (this.projectWrites ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (this.saved.some(project => project.id === id)) return;
      const saved = [...this.saved, { id, root, ...(worktreeResources ? {worktreeResources} : {}), ...(projectlessRequestId ? { projectless: true, projectlessRequestId } : {}) }];
      await this.save('projects.json', saved);
      this.saved = saved;
    });
    this.projectWrites = registration.catch(() => {});
    await registration;
    if (this.library.value.projects[id]?.hidden) await this.library.command({ projectId: id, operation: 'hideProject', hidden: false });
    await this.start(id);
    return id;
  }

  snapshot() {
    return { library: this.library.value, projectless: this.projectless.snapshot(), power: this.power ?? null, projects: this.saved.map(project => {
      const live = this.projects.get(project.id);
      const snapshot = live?.model.getSnapshot() ?? null;
      // 配置会话的协议回复只在任务创建区展示，不混入普通聊天导航。
      const state = snapshot?.threads ? {...snapshot, threads: Object.fromEntries(Object.entries(snapshot.threads).filter(([id, thread]) =>
        !isTaskDraftConfiguration(live.configurations?.[id] ?? thread.desktop?.configuration)))} : snapshot;
      return { ...project, backend: 'areal', core: projectCoreCapabilities(this.binary, live?.client?.capabilities), state: state && live.resourceInitializing ? {...state, connected:false} : state,
        pending: (live?.pending ?? []).map(entry => ({ ...entry, awaitingResponse: this.awaitingResponses.has(entry) })), outcomes: live?.outcomes ?? {}, models: this.providers.catalog(live?.models ?? [], live), profiles: live?.profiles ?? [],
        configurations: live?.configurations ?? {},
        summaries: live?.summaries ?? [], summariesLoaded: live?.summariesLoaded === true, error: live?.error ?? null };
    }) };
  }

  start(id) {
    if (this.closing) return Promise.reject(new Error('应用正在退出'));
    if (this.starting.has(id)) return this.starting.get(id);
    const project = this.projects.get(id);
    if (project) { clearTimeout(project.reconnectTimer); project.reconnectTimer = null; project.reconnectBlocked = false; }
    const task = this.startProject(id).finally(() => this.starting.delete(id));
    this.starting.set(id, task);
    return task;
  }

  async startProject(id) {
    const saved = this.saved.find(project => project.id === id);
    if (!saved) throw new Error('未知项目');
    let project = this.projects.get(id);
    if (project?.client?.ready && !project.resourceInitializing) return project;
    const { CoreTaskModel } = await import('@areal/workbench/core-model');
    if (!project) {
      project = { ...saved, model: new CoreTaskModel(), pending: [], configurations: {},
        configurationChanges: new Map(), error: null, summaries: [] };
      this.projects.set(id, project);
      project.model.subscribe(() => this.onChange());
      try { project.pending = JSON.parse(await readFile(join(this.home, `${id}-pending.json`), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { project.outcomes = JSON.parse(await readFile(join(this.home, `${id}-outcomes.json`), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    try {
      project.resourceInitializing = !!project.worktreeResources;
      await this.resources.worktrees.prepare(project);
      if (!project.client?.ready) await this.launch(project);
      if (!project.client?.ready) await this.connect(project);
      await this.listThreads(project);
      await this.reconcile(project);
      await this.resources.worktrees.apply(project);
      project.resourceInitializing = false;
      project.error = null;
      project.model.connection(true);
      this.onChange();
      return project;
    } catch (error) {
      // A failed resource import must still allow authenticated status/drain on
      // its running Core. Keep the management connection, while start() retries
      // initialization before admitting any task or project command.
      if (!project.resourceInitializing || !project.client?.ready) project.client?.close();
      project.error = error.message;
      project.model.connection(false, error.message);
      throw error;
    }
  }

  async launch(project, operation = 'ensure') {
    const directory = join(this.home, project.id);
    const dataDir = join(directory, 'state');
    const scratch = join(directory, 'scratch');
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    const args = ['--workspace', project.root, '--data-dir', dataDir, '--scratch', scratch, '--allow-write'];
    if (this.desktopProcesses) args.push('--allow-concurrent-writes', '--desktop-process-timeout-ms', '86400000');
    if (this.config) args.push('--config', this.config);
    if (this.workgroupPolicy) args.push('--workgroup-policy', this.workgroupPolicy);
    if (this.workgroupToolchain) args.push('--workgroup-toolchain', this.workgroupToolchain);
    const resourceDeployment = await this.resources.deployment(project);
    if (resourceDeployment.path) args.push('--desktop-config', resourceDeployment.path);
    project.resourceProfile = resourceDeployment.profile;
    project.resourceFingerprint = resourceDeployment.fingerprint;
    await this.providers.prepare();
    const providerSnapshot = await this.providers.config.current();
    project.providerSnapshot = providerSnapshot;
    project.providerRevision = null;
    const hookDeployment = await this.hooks.launch();
    project.hookRevision = null;
    const environment = { ...this.hooks.environment(), AREAL_HARNESS_TOOL_EXTENSIONS: hookDeployment.path, ...this.providers.environment() };
    const { descriptor, token } = await connectService(this, operation, args, environment, project, dataDir);
    project.service = descriptor;
    project.endpoint = descriptor.endpoint;
    project.token = token;
    if ((await this.providers.config.current()).revision === providerSnapshot.revision) project.providerRevision = providerSnapshot.revision;
    if ((await this.hooks.current()).revision === hookDeployment.revision) project.hookRevision = hookDeployment.revision;
  }

  async restartProject(project) {
    await this.launch(project, 'restart');
    await this.connect(project);
    await this.reconcile(project);
    await this.resources.worktrees.apply(project);
  }

  currentConnection(project, client) {
    return !this.closing && !!client && project.client === client && !client.closed;
  }

  requireConnection(project, client) {
    if (!this.currentConnection(project, client)) throw Object.assign(new Error('连接已换代，请等待状态恢复后重试'), { code: 'STALE_CONNECTION' });
  }

  scheduleReconnect(project) {
    if (this.closing || project.resourceInitializing || !project.service || project.reconnectBlocked || project.reconnectTimer || project.client?.ready) return;
    const delay = Math.min(500 * 2 ** Math.min(project.reconnectAttempt ?? 0, 6), 30000);
    project.reconnectTimer = setTimeout(() => {
      project.reconnectTimer = null;
      if (this.closing || !project.service || project.reconnectBlocked || project.client?.ready) return;
      if (this.providerUpdating || this.resourcesUpdating || this.starting.has(project.id)) { this.scheduleReconnect(project); return; }
      const task = this.reconnectProject(project).catch(error => {
        if (!this.closing) {
          project.reconnectBlocked = ['CORE_STOPPED', 'CORE_INCOMPATIBLE'].includes(error.code);
          project.reconnectAttempt = (project.reconnectAttempt ?? 0) + 1;
          project.client?.close();
          project.error = this.providers.redact(error.message);
          project.model.connection(false, project.error);
        }
        throw error;
      }).finally(() => {
        if (this.starting.get(project.id) === task) this.starting.delete(project.id);
        this.scheduleReconnect(project);
      });
      this.starting.set(project.id, task);
      // 用户操作可以加入同一恢复任务；无订阅者的被动失败也必须被接收。
      void task.catch(() => {});
    }, delay);
    project.reconnectTimer.unref();
  }

  async reconnectProject(project) {
    const previous = project.service;
    // 被动恢复只发现已运行实例；不能用 ensure 启动、升级或复活已停止的 Core。
    const { descriptor, token } = await connectService(this, 'status', ['--instance', previous.serviceId],
      this.hooks.environment(), project, previous.dataDir);
    if (this.closing || project.service !== previous) throw Object.assign(new Error('服务归属已变化'), { code: 'STALE_CONNECTION' });
    if (descriptor.serviceId !== previous.serviceId || descriptor.configFingerprint !== previous.configFingerprint) {
      throw Object.assign(new Error('Core 部署配置已变化，请显式重新连接'), { code: 'CORE_INCOMPATIBLE' });
    }
    project.service = descriptor; project.endpoint = descriptor.endpoint; project.token = token;
    await this.connect(project, { observeOnly: true });
    await this.reconcile(project, { observeOnly: true });
    project.reconnectAttempt = 0;
    return project;
  }

  async connect(project, { observeOnly = false } = {}) {
    const { CoreClient } = await import('@areal/runtime-client/core');
    if (this.closing) throw new Error('应用正在退出');
    project.taskNotificationMonitor?.stop();
    const previous = project.client;
    project.client = null;
    previous?.close();
    project.summariesLoaded = false;
    const client = new CoreClient({ createSocket: () => new WebSocket(project.endpoint, {
      headers: { Authorization: `Bearer ${project.token}` }, followRedirects: false, maxPayload: 4 * 1024 * 1024,
    }) });
    project.client = client;
    client.onNotification((method, params) => {
      if (!this.currentConnection(project, client)) return;
      if (method === 'areal/thread/configured' && params?.threadId && params.configuration) {
        project.configurations ??= {};
        project.configurations[params.threadId] = params.configuration;
        this.onChange();
      }
      this.analytics.observe(project.id, method, params);
      project.model.event(method, params);
      if (!isTaskDraftConfiguration(project.configurations?.[params.threadId])) this.notifications.observe(project, method, params, this.library.value);
      if (method === 'thread/started' || method === 'turn/started' || method === 'turn/completed') {
        void this.library.recordThreadActivity(project.id, params.threadId ?? params.thread?.id,
          method === 'turn/completed' ? params.turn?.id ?? params.turnId : undefined).catch(() => {});
      }
      // Lifecycle notifications omit thread timestamps; refresh the authoritative
      // summaries so continued and automatically dequeued tasks sort correctly.
      if (method === 'turn/started' || method === 'turn/completed') {
        void this.listThreads(project).catch(() => {});
      }
    });
    client.onClose(() => { if (project.client === client) {
      project.taskNotificationMonitor?.stop();
      project.model.connection(false, '连接中断，正在恢复任务状态');
      this.scheduleReconnect(project);
    } });
    await client.connect();
    this.requireConnection(project, client);
    project.error = null;
    project.configurations ??= {};
    project.configurationChanges ??= new Map();
    if (!observeOnly) {
      await this.providers.sync(project);
      this.requireConnection(project, client);
      await this.resources.syncMcp(project);
      this.requireConnection(project, client);
    }
    const [models, profiles] = await Promise.all([
      client.request('areal/model/list'), client.request('areal/profile/list'),
    ]);
    this.requireConnection(project, client);
    project.models = models.data ?? models.models ?? [];
    project.profiles = profiles.data ?? profiles.profiles ?? [];
    await this.listThreads(project);
    if (!observeOnly) void this.analytics.syncProject(project);
    // 重连恢复所有已打开的任务，快照在 socket 消息分派栈内替换。
    for (const threadId of Object.keys(project.model.state.threads)) await this.openThread(project, threadId);
    for (const taskId of new Set(project.taskViews?.values() ?? [])) {
      await client.request('areal/task/subscribe', { taskId }, { onResult: task => {
        if (this.currentConnection(project, client)) project.model.setTask(task);
      } });
      this.requireConnection(project, client);
    }
    project.taskNotificationMonitor = new TaskNotificationMonitor(client, project.id,
      notice => { if (this.currentConnection(project, client)) this.onNotification?.(notice); }, error => console.warn(this.providers.redact(`任务通知读取失败：${error.message}`)),
      tasks => { if (this.currentConnection(project, client)) for (const task of tasks) project.model.setTask(task); });
    await project.taskNotificationMonitor.start();
    this.requireConnection(project, client);
    project.model.connection(true);
    this.onChange();
  }

  listThreads(project) {
    const client = project.client;
    // Lifecycle refreshes and explicit reads can overlap. Serialize complete
    // reads so an earlier snapshot cannot overwrite a later navigation cache.
    const task = (project.summaryReads ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (!this.currentConnection(project, client)) return project.summaries;
      const data = [];
      let cursor;
      do {
        const page = await client.request('thread/list', { limit: 100, ...(cursor ? { cursor } : {}) });
        data.push(...page.data.filter(thread => !isTaskDraftConfiguration(thread.desktop?.configuration)));
        cursor = page.nextCursor;
      } while (cursor);
      if (!this.currentConnection(project, client)) return project.summaries;
      await this.library.recordThreadSummaries(project.id, data);
      if (!this.currentConnection(project, client)) return project.summaries;
      project.summaries = data;
      project.summariesLoaded = true;
      this.onChange();
      return data;
    });
    project.summaryReads = task.catch(() => {});
    return task;
  }

  async openThread(project, threadId) {
    const client = project.client;
    if ((project.summaries ?? []).find(item => item.id === threadId)?.desktop?.archived || project.model.state?.threads?.[threadId]?.desktop?.archived) {
      const result = await client.request('thread/read', { threadId, includeTurns: true });
      this.requireConnection(project, client);
      project.model.replace(result.thread);
      project.configurations[threadId] = result.thread.desktop.configuration;
      this.onChange();
      return;
    }
    const resumed = await client.request('thread/resume', { threadId }, {
      onResult: result => { if (this.currentConnection(project, client)) project.model.replace(result.thread); },
    });
    this.requireConnection(project, client);
    if (resumed.thread?.desktop?.archived) {
      project.configurations[threadId] = resumed.thread.desktop.configuration;
      project.model.setQueue(threadId, resumed.thread.desktop.queue);
      project.model.setInteractions(threadId, { revision: resumed.thread.desktop.interactionRevision, data: resumed.thread.desktop.interactions });
      this.onChange();
      return;
    }
    await Promise.all([
      client.request('areal/interaction/list', { threadId }, {
        onResult: result => { if (this.currentConnection(project, client)) project.model.setInteractions(threadId, result); },
      }),
      this.refreshConfiguration(project, threadId),
      this.refreshQueue(project, threadId),
    ]);
  }

  async refreshQueue(project, threadId) {
    const client = project.client;
    return client.request('areal/queue/list', { threadId }, {
      onResult: queue => { if (this.currentConnection(project, client)) project.model.setQueue(threadId, queue); },
    });
  }

  async editQueue(project, request) {
    const { threadId, operation, expectedRevision } = request;
    if (!['update', 'remove', 'reorder', 'pause', 'resume', 'steer'].includes(operation)
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('无效队列操作');
    const params = { threadId, expectedRevision };
    if (operation === 'update' || operation === 'remove' || operation === 'steer') {
      if (typeof request.queueItemId !== 'string' || !request.queueItemId) throw new Error('缺少排队消息');
      params.queueItemId = request.queueItemId;
    }
    if (operation === 'update') {
      const retained = request.retainedInput ?? [];
      const original = project.model.state.queues[threadId]?.items.find(item => item.id === request.queueItemId);
      if (!Array.isArray(retained) || retained.length > 16 || retained.some(part => part.type === 'text'
        || !original?.input.some(input => isDeepStrictEqual(input, part)))) throw new Error('排队附件引用已变化，请核对原消息');
      const changed = request.text?.trim() || request.attachments?.length ? messageInput(this, request) : [];
      params.input = [...changed.filter(part => part.type === 'text'), ...retained, ...changed.filter(part => part.type !== 'text')];
      if (!params.input.length || params.input.filter(part => part.type !== 'text').length > 16) throw new Error('排队消息不能为空，且最多 16 个附件');
    }
    if (operation === 'steer') {
      if (typeof request.expectedTurnId !== 'string' || !request.expectedTurnId) throw new Error('缺少目标活动轮次');
      params.expectedTurnId = request.expectedTurnId;
    }
    if (operation === 'reorder') {
      if (!Array.isArray(request.queueItemIds) || request.queueItemIds.length > 128
        || request.queueItemIds.some(id => typeof id !== 'string')
        || new Set(request.queueItemIds).size !== request.queueItemIds.length) throw new Error('无效队列顺序');
      params.queueItemIds = request.queueItemIds;
    }
    try {
      const result = await this.submit(project, `areal/queue/${operation}`, params, { requestId: request.requestId });
      if (operation === 'steer') {
        // 转移收据只保存绑定 ID 和版本，不把完整队列复制到每张收据。
        await this.refreshQueue(project, threadId).catch(() => {});
      } else project.model.setQueue(threadId, result);
      this.onChange();
      return result;
    } catch (error) {
      // 冲突只刷新展示，不用新 revision 重放用户的旧操作。
      await this.refreshQueue(project, threadId).catch(() => {});
      throw error;
    }
  }

  textInput(text) {
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 64 * 1024) throw new Error('请输入有效任务内容（最多 64 KiB）');
    return [{ type: 'text', text }];
  }

  async refreshConfiguration(project, threadId) {
    const client = project.client;
    const result = await client.request('areal/thread/inspect', { threadId });
    this.requireConnection(project, client);
    if (!result?.configuration || !Number.isSafeInteger(result.configuration.revision)) {
      throw new Error('Core 未返回有效的会话配置，请重新打开任务');
    }
    project.configurations ??= {};
    project.configurations[threadId] = result.configuration;
    this.onChange();
    return result;
  }

  async configureThread(project, threadId, request) {
    const token = randomUUID();
    project.configurationChanges ??= new Map();
    if (project.configurationChanges.has(threadId)) throw new Error('会话配置正在更新，请稍后重试');
    project.configurationChanges.set(threadId, token);
    let entry;
    try {
      await this.changePending(project, pending => {
        if (pending.some(value => value.params.threadId === threadId)) {
          throw new Error('该会话有未结算的请求结果，请先处理后再修改配置');
        }
        return pending;
      });
      if (request.model === undefined && request.profile === undefined && request.options === undefined && request.parameters === undefined && request.selectedSkills === undefined) {
        throw new Error('请选择需要修改的配置');
      }
      if (request.profile === null) {
        throw new Error('当前 Core 不支持清除已选择的 Profile');
      }
      if (request.selectedSkills !== undefined && (!Array.isArray(request.selectedSkills) || request.selectedSkills.some(skill => typeof skill?.id !== 'string' || !skill.id || typeof skill?.revision !== 'string' || !skill.revision))) {
        throw new Error('所选技能无效');
      }
      const inspection = await this.refreshConfiguration(project, threadId);
      if (inspection.activeTurnId) throw new Error('任务正在执行，完成或停止后才能修改配置');
      if (request.expectedRevision !== undefined && request.expectedRevision !== inspection.configuration.revision) throw new Error('会话配置已变化，请刷新后重新保存');
      const params = {
        threadId,
        expectedRevision: inspection.configuration.revision,
        ...(request.profile ? { agentProfile: request.profile } : {}),
        ...(request.model === null ? { resetModel: true } : request.model ? { model: request.model } : {}),
        ...(request.options !== undefined ? { options: { ...inspection.configuration.options, ...request.options } } : {}),
        ...(request.parameters !== undefined ? { parameters: request.parameters } : request.model !== undefined ? { parameters: {} } : {}),
        // 空数组是公开契约：清除会话覆盖并恢复 Profile，不是“不用任何技能”。
        ...(request.selectedSkills !== undefined ? { selectedSkills: request.selectedSkills.map(skill => ({ id: skill.id, revision: skill.revision })) } : {}),
      };
      entry = { method: 'areal/thread/configure', localOnly: true, params };
      this.awaitingResponses.add(entry);
      await this.changePending(project, pending => [...pending, entry]);
      if (this.closing) throw new Error('应用正在退出');
      const client = project.client;
      const configuration = await client.request('areal/thread/configure', params);
      try {
        await this.changePending(project, pending => pending.filter(value => value !== entry));
      } catch {
        throw Object.assign(new Error('Core 已保存配置，但本机恢复日志更新失败；请核对当前配置'), { submissionUnknown: true });
      }
      if (this.currentConnection(project, client)) project.configurations[threadId] = configuration;
      this.onChange();
    } catch (error) {
      if (entry && !error.submissionUnknown) {
        try { await this.changePending(project, pending => pending.filter(value => value !== entry)); }
        catch {
          error = Object.assign(new Error('配置请求失败，且本机恢复日志更新失败；请检查当前配置'), { submissionUnknown: true });
        }
      }
      try { await this.refreshConfiguration(project, threadId); }
      catch (refreshError) { error.message += `；刷新权威配置失败：${refreshError.message}`; }
      throw error;
    } finally {
      if (entry) { this.awaitingResponses.delete(entry); this.onChange(); }
      if (project.configurationChanges.get(threadId) === token) {
        project.configurationChanges.delete(threadId);
      }
    }
  }

  changePending(project, change) {
    const task = (project.pendingWrite ?? Promise.resolve()).catch(() => {}).then(async () => {
      const before = project.pending;
      project.pending = change(before);
      this.onChange();
      try { await this.save(`${project.id}-pending.json`, project.pending); }
      catch (error) { project.pending = before; this.onChange(); throw error; }
      this.onChange();
    });
    project.pendingWrite = task;
    return task;
  }

  changeOutcomes(project, change) {
    const task = (project.outcomeWrite ?? Promise.resolve()).catch(() => {}).then(async () => {
      const next = change(project.outcomes ?? {});
      await this.save(`${project.id}-outcomes.json`, next);
      project.outcomes = next; this.onChange();
    });
    project.outcomeWrite = task;
    return task;
  }

  async rememberWorkgroupOutcome(project, entry, value, planRevision = value.record.planRevision) {
    await this.changeOutcomes(project, outcomes => ({ ...outcomes, [entry.params.requestId]: {
      accepted: true, method: entry.method, workgroupId: value.id, planRevision,
    } }));
  }

  async recoverWorkgroupSubmission(project, requestId) {
    const entry = project.pending.find(item => item.params.requestId === requestId && workgroupMutationMethods.has(item.method));
    if (entry && this.awaitingResponses.has(entry)) return null;
    let receipt = project.outcomes?.[requestId];
    if (!receipt?.workgroupId && entry?.method === 'areal/workgroup/revise') {
      const value = await project.client.request('areal/workgroup/read', { id: entry.params.id });
      const revision = value.record.revisions?.[requestId];
      if (revision && revision.planRevision === entry.params.expectedRevision + 1) {
        await this.rememberWorkgroupOutcome(project, entry, value, revision.planRevision);
        receipt = project.outcomes[requestId];
      }
    }
    // Creation has no public Core receipt lookup. An absent record is unknown,
    // never a reason to retry a mutation or identify a similar-looking group.
    if (!receipt?.workgroupId || !workgroupMutationMethods.has(receipt.method)) return null;
    if (entry) await this.changePending(project, pending => pending.filter(item => item !== entry));
    return receipt;
  }

  async recoverProcessSubmission(project, threadId, requestId) {
    const entry = project.pending.find(item => item.params.requestId === requestId);
    if (entry && (entry.method !== 'areal/process/start' || entry.params.threadId !== threadId || this.awaitingResponses.has(entry))) return null;
    const value = await project.client.request('areal/request/read', { threadId, requestId });
    const receipt = value.data.find(item => item.method === 'areal/process/start');
    if (typeof receipt?.result?.id !== 'string') return null;
    const processes = await project.client.request('areal/process/list', { threadId });
    const process = processes.data.find(item => item.id === receipt.result.id);
    // A durable acceptance can precede actual process startup. Only attach once
    // it has a Runtime process, or confirmed cleanup proves it has ended.
    if (!process || (!process.processId && !process.cleanupConfirmed)) return null;
    // process/list includes historical epochs. Core's get validates the live
    // Runtime handle; an old/unavailable handle must not become an attached PTY.
    if (!process.cleanupConfirmed) await project.client.request('areal/process/get', { threadId, id: process.id });
    if (entry) await this.changePending(project, pending => pending.filter(item => item !== entry));
    return { ...receipt.result, closed: process.cleanupConfirmed === true, controls: process.inputs.length };
  }

  async recoverAgentSubmission(project, parentThreadId, requestId) {
    const entry = project.pending.find(item => item.params.requestId === requestId && item.method === 'areal/agent/spawn');
    if (entry && (this.awaitingResponses.has(entry) || entry.params.parentThreadId !== parentThreadId)) return null;
    const receipt = project.outcomes?.[requestId];
    if (receipt?.method !== 'areal/agent/spawn' || receipt.accepted !== true || receipt.parentThreadId !== parentThreadId
      || typeof receipt.threadId !== 'string' || typeof receipt.turnId !== 'string') return null;
    if (entry) await this.changePending(project, pending => pending.filter(item => item !== entry));
    return receipt;
  }

  async submit(project, method, parameters, { requestId } = {}) {
    if (requestId !== undefined && (!(workgroupMutationMethods.has(method) || taskMutationMethods.has(method) || ['areal/agent/spawn', 'areal/process/start', 'areal/thread/start', ...['update','remove','reorder','pause','resume','steer'].map(name => `areal/queue/${name}`)].includes(method)) || typeof requestId !== 'string' || !/^[0-9a-f-]{36}$/.test(requestId))) throw new Error('无效请求标识');
    const params = { ...parameters, requestId: requestId ?? randomUUID() };
    const entry = { method, params };
    // 活跃请求仅保存在内存；重启后仍在恢复日志中的请求应显示为结果未知。
    this.awaitingResponses.add(entry);
    try {
      // 检查与持久化在同一队列中，两个同时到达的发送不能穿透阻塞。
      await this.changePending(project, pending => {
        if (project.outcomes?.[params.requestId] || pending.some(value => value.params.requestId === params.requestId)) throw new Error('请求标识已使用，请核对原提交；不会重复执行。');
        if (project.configurationChanges?.has(parameters.threadId)) {
          throw new Error('会话配置正在更新，请稍后再发送任务');
        }
        const conflicting = pending.find(value => value.params.threadId === parameters.threadId);
        if (conflicting) {
          throw new Error(this.awaitingResponses.has(conflicting)
            ? '当前操作正在等待响应，请稍后再试'
            : '上一次提交结果未知，请先查询受理结果');
        }
        return [...pending, entry];
      });
      let result;
      try {
        if (this.closing) throw new Error('应用正在退出');
        result = await this.requestSubmission(project, method, params);
      }
      catch (error) {
        if (!error.submissionUnknown) {
          try { await this.changePending(project, pending => pending.filter(value => value !== entry)); }
          catch { throw Object.assign(new Error('提交被拒绝，但恢复日志更新失败；请检查本机存储'), { submissionUnknown: true }); }
        }
        if (error.submissionUnknown) error.requestId = params.requestId;
        throw error;
      }
      try {
        if (workgroupMutationMethods.has(method)) await this.rememberWorkgroupOutcome(project, entry, result);
        if (method === 'areal/agent/spawn') {
          // Core 无 spawn 请求查询；只保存已经收到的明确受理结果，再清除 pending。
          if (typeof result.threadId !== 'string' || typeof result.turnId !== 'string') throw new Error('子任务受理结果不完整');
          await this.changeOutcomes(project, outcomes => ({ ...outcomes, [params.requestId]: {
            accepted: true, method, parentThreadId: params.parentThreadId, threadId: result.threadId, turnId: result.turnId,
          } }));
        }
        await this.changePending(project, pending => pending.filter(value => value !== entry));
      }
      catch {
        // Core 已经受理，日志清理失败绝不能作为普通发送失败恢复草稿。
        throw Object.assign(new Error('Core 已受理，恢复日志更新失败；请查询受理结果'), { submissionUnknown: true, requestId: params.requestId });
      }
      return result;
    } finally {
      this.awaitingResponses.delete(entry);
      this.onChange();
    }
  }

  async processControlOutcome(project, params, result, cause) {
    let value;
    try { value = await project.client.request('areal/process/list', { threadId: params.threadId }); }
    catch { throw Object.assign(new Error('无法核对终端执行结果；不会重发输入'), { submissionUnknown: true }); }
    const operation = value.data.find(p => p.id === params.id)?.inputs?.find(op => op.operationId === result.operationId);
    if (operation?.outcome === 'succeeded') return result;
    // A recorded failed control is known rejection; preserve its concrete Core
    // reason (for example unsupported PTY EOF) when the original reply exists.
    if (operation?.outcome === 'failed') throw cause ?? new Error('终端操作执行失败；请检查进程状态');
    throw Object.assign(new Error('终端操作执行结果未确认；不会重发输入'), { submissionUnknown: true });
  }

  async requestSubmission(project, method, params) {
    if (method === 'areal/blob/release') {
      // Hold the existing per-thread admission slot while reading this guard.
      // Shared Desktop clients cannot archive between this read and release.
      // Archived Core history may be cold, so never release its upload owner.
      let current;
      try { current = await project.client.request('thread/read', { threadId: params.threadId, includeTurns: true }); }
      catch (error) { throw new Error(`无法核对附件所属会话，未发送释放请求：${error.message}`); }
      if (current.thread.desktop?.archived) throw new Error('归档会话只读，不能释放附件');
    }
    try {
      const { requestId, previousItems, ...steer } = params;
      const { threadId, ...spawn } = steer;
      return await project.client.request(method, method === 'areal/agent/spawn' ? spawn : method === 'turn/steer' ? steer : params);
    }
    catch (error) {
      // Task receipts and Agent spawn receipts are not publicly queryable. An
      // internal error may follow a durable write; retain the journal entry.
      if (taskMutationMethods.has(method) || method === 'areal/agent/spawn' || method.startsWith('areal/workgroup/') || method === 'areal/workflow/start') {
        if (error.code === -32603) error.submissionUnknown = true;
        throw error;
      }
      if (method === 'turn/steer' && error.code === -32603) throw Object.assign(error, { submissionUnknown: true });
      const management = managementMethods.has(method);
      const processMutation = method.startsWith('areal/process/');
      const receiptMethod = processMutation && method !== 'areal/process/start' ? 'areal/process/control' : method;
      if ((!management && !threadMutationMethods.has(method) && method !== 'areal/turn/enqueue' && !processMutation) || error.submissionUnknown || typeof error.code !== 'number') throw error;
      // 入队后的推进或管理日志落盘仍可能返回 RPC 错误；先核对原业务键，不能恢复草稿造成重复入队。
      let receipt;
      try {
        const value = await project.client.request('areal/request/read', {
          requestId: params.requestId, ...(!management ? { threadId: params.threadId } : {}),
        });
        receipt = value.data.find(item => item.method === receiptMethod);
      } catch {
        throw Object.assign(new Error(`操作受理结果未确认，请查询受理结果：${error.message}`), { submissionUnknown: true });
      }
      if (processMutation && method !== 'areal/process/start' && receipt?.result) return this.processControlOutcome(project, params, receipt.result, error);
      if (!management && receipt?.result) return receipt.result;
      if (management && receipt?.state === 'completed' && receipt.response) {
        if (receipt.response.error) throw Object.assign(new Error(receipt.response.error.message), { code: receipt.response.error.code });
        if (receipt.response.result !== undefined) return receipt.response.result;
      }
      if (receipt || error.code === -32603) {
        throw Object.assign(new Error(`操作受理结果未确认，请查询受理结果：${error.message}`), { submissionUnknown: true });
      }
      throw error;
    }
  }

  async reconcile(project, { observeOnly = false } = {}) {
    const client = project.client;
    for (const entry of [...project.pending]) {
      this.requireConnection(project, client);
      if (this.awaitingResponses.has(entry)) continue;
      if (workgroupMutationMethods.has(entry.method)) { await this.recoverWorkgroupSubmission(project, entry.params.requestId); continue; }
      if (entry.method === 'areal/agent/spawn') { await this.recoverAgentSubmission(project, entry.params.parentThreadId, entry.params.requestId); continue; }
      if (taskMutationMethods.has(entry.method)) continue; // No public receipt lookup; never infer or replay.
      if (entry.method === 'turn/steer') {
        await this.openThread(project, entry.params.threadId);
        const turn = project.model.state.threads[entry.params.threadId]?.turns.find(item => item.id === entry.params.expectedTurnId);
        const normalize = input => input.map(part => part.type === 'text' ? { type: 'text', text: part.text } : { type: part.type, url: part.url });
        const accepted = turn?.items.some(item => item.type === 'userMessage' && !entry.params.previousItems.includes(item.id) && JSON.stringify(normalize(item.content)) === JSON.stringify(normalize(entry.params.input)));
        if (accepted || (turn && turn.status !== 'inProgress')) {
          await this.changeOutcomes(project, outcomes => ({ ...outcomes, [entry.params.requestId]: { accepted: !!accepted, threadId: entry.params.threadId, input: entry.params.input, message: accepted ? '追加指令已确认' : '原轮次已结束，历史中没有这条追加指令。内容已保留，请检查后发送。' } }));
          await this.changePending(project, pending => pending.filter(value => value !== entry));
        }
        continue; // 没有收据的追加只核对原轮次，不重放。
      }
      if (entry.localOnly) {
        if (!observeOnly) await this.reconcileConfiguration(project, entry);
        continue;
      }
      const result = await client.request('areal/request/read', {
        requestId: entry.params.requestId,
        // 管理命令的收据属于部署日志；带 threadId 只会查询 Turn 收据。
        ...(entry.params.threadId && !managementMethods.has(entry.method) ? { threadId: entry.params.threadId } : {}),
      });
      this.requireConnection(project, client);
      const management = managementMethods.has(entry.method);
      const receiptMethod = entry.method.startsWith('areal/process/') && entry.method !== 'areal/process/start' ? 'areal/process/control' : entry.method;
      const receipt = result.data.find(item => item.method === receiptMethod && (management
        ? item.state === 'completed' && item.response : item.result));
      if (!receipt) continue; // 空收据不能证明在途请求未执行，不自动重放或解除阻塞。
      if (receiptMethod === 'areal/process/control') {
        try { await this.processControlOutcome(project, entry.params, receipt.result); }
        catch (error) { if (error.submissionUnknown) continue; await this.changePending(project, pending => pending.filter(value => value !== entry)); throw error; }
      }
      if (['areal/thread/start', 'areal/turn/start', 'turn/start', 'areal/turn/enqueue'].includes(entry.method)) {
        await this.changeOutcomes(project, outcomes => ({ ...outcomes, [entry.params.requestId]: { accepted: true, threadId: entry.params.threadId ?? receipt.threadId ?? receipt.result?.thread?.id } }));
      }
      if (entry.method.startsWith('areal/queue/')) {
        await this.changeOutcomes(project, outcomes => ({ ...outcomes, [entry.params.requestId]: {
          accepted: !receipt.response?.error, threadId: entry.params.threadId, method: entry.method,
          result: management ? receipt.response.result : receipt.result,
          message: receipt.response?.error?.message,
        } }));
      }
      const threadId = entry.params.threadId ?? receipt.threadId ?? receipt.result?.thread?.id;
      if (entry.method === 'areal/thread/archive') await this.listThreads(project);
      if (threadId) await this.openThread(project, threadId);
      await this.changePending(project, pending => pending.filter(value => value !== entry));
      if (entry.method.startsWith('areal/provider/')) {
        const models = await client.request('areal/model/list');
        this.requireConnection(project, client);
        project.models = models.data ?? [];
      }
      if (management && receipt.response.error) throw new Error(`操作未成功：${receipt.response.error.message}`);
    }
    await this.listThreads(project);
  }

  async reconcileConfiguration(project, entry) {
    const { threadId, expectedRevision } = entry.params;
    if (!Number.isSafeInteger(expectedRevision)) throw new Error('未知配置结果缺少有效 revision，仍需人工处理');
    const token = randomUUID();
    project.configurationChanges ??= new Map();
    if (project.configurationChanges.has(threadId)) throw new Error('会话配置正在更新，请稍后恢复');
    project.configurationChanges.set(threadId, token);
    try {
      const inspection = await this.refreshConfiguration(project, threadId);
      const revision = inspection.configuration.revision;
      if (revision > expectedRevision) {
        await this.changePending(project, pending => pending.filter(value => value !== entry));
        return;
      }
      if (revision < expectedRevision || inspection.activeTurnId) {
        throw new Error('配置 revision 尚未推进或任务正在执行，未知结果仍被阻止；稍后可再次恢复');
      }

      // Omitted model/profile preserve their current references. Supplying current options
      // and parameters preserves the rest of EffectiveConfig while the CAS advances revision.
      const barrier = {
        threadId,
        expectedRevision,
        parameters: inspection.configuration.parameters,
        options: inspection.configuration.options,
      };
      try {
        const configuration = await project.client.request('areal/thread/configure', barrier);
        project.configurations[threadId] = configuration;
        await this.changePending(project, pending => pending.filter(value => value !== entry));
        this.onChange();
      } catch (error) {
        if (error.submissionUnknown) {
          throw new Error('恢复屏障结果仍未知；原配置请求未重放，任务继续被阻止，请再次恢复以核对 revision');
        }
        const refreshed = await this.refreshConfiguration(project, threadId);
        if (refreshed.configuration.revision > expectedRevision) {
          await this.changePending(project, pending => pending.filter(value => value !== entry));
          return;
        }
        throw new Error(`恢复屏障未推进配置 revision；任务继续被阻止：${error.message}`);
      }
    } finally {
      if (project.configurationChanges.get(threadId) === token) {
        project.configurationChanges.delete(threadId);
      }
    }
  }

  async command(name, request) {
    if (this.closing) throw new Error('应用正在退出');
    if (name === 'analytics') return this.analytics.command(request);
    if (name === 'chatgpt') return this.providers.chatgpt(request);
    if (name === 'providers') return this.providers.command(request);
    if (name === 'resources') return this.resources.command(request);
    if (this.providerUpdating || this.resourcesUpdating) throw new Error('配置正在应用，请稍后重试');
    this.activeCommands++;
    try { return await this.executeCommand(name, request); }
    finally { this.activeCommands--; }
  }

  async executeCommand(name, request) {
    if (this.closing) throw new Error('应用正在退出');
    if (name === 'tasks') return taskCatalog(this, request);
    if (name === 'projectless') return this.projectless.command(request);
    if (name === 'library') return this.library.command(request);
    if (name === 'workspace') return workspaceCommand(this, request);
    const { projectId, threadId } = request;
    const project = await this.start(projectId);
    if (this.closing) throw new Error('应用正在退出');
    switch (name) {
      case 'connect': return this.snapshot();
      case 'dismissRecovery': {
        await this.changeOutcomes(project, previous => { const outcomes = { ...previous }; delete outcomes[request.requestId]; return outcomes; }); break;
      }
      case 'media': return mediaCommand(project, request, this);
      case 'manage': return manage(this, project, request);
      case 'list': await this.listThreads(project); break;
      case 'open': await this.openThread(project, threadId); break;
      case 'configure': await this.configureThread(project, threadId, request); break;
      case 'queue': {
        if (!request.requestId) return this.refreshQueue(project, threadId);
        if (typeof request.requestId !== 'string' || !/^[0-9a-f-]{36}$/.test(request.requestId)
          || !['update','remove','reorder','pause','resume','steer'].includes(request.operation)) throw new Error('无效队列收据查询');
        const method = `areal/queue/${request.operation}`;
        const records = await project.client.request('areal/request/read', { requestId: request.requestId, ...(request.operation === 'steer' ? { threadId } : {}) });
        const receipt = records.data.find(record => record.method === method);
        if (receipt?.result) return { confirmed: true, accepted: true, result: receipt.result };
        if (receipt?.state === 'completed' && receipt.response) return { confirmed: true, accepted: !receipt.response.error, result: receipt.response.result, message: receipt.response.error?.message };
        return { confirmed: false };
      }
      case 'queueEdit': return this.editQueue(project, request);
      case 'create': {
        await this.resources.beforeCreate(project);
        const { thread } = await this.submit(project, 'areal/thread/start', { cwd: project.root,
          ...(request.parameters ? { parameters: request.parameters } : {}),
          ...(request.model ? { model: request.model } : {}),
          ...((request.profile ?? project.resourceProfile ?? this.defaultProfile) ? { agentProfile: request.profile ?? project.resourceProfile ?? this.defaultProfile } : {}),
        });
        await this.openThread(project, thread.id);
        await this.listThreads(project);
        return { threadId: thread.id };
      }
      case 'send': {
        const input = messageInput(this, request);
        // Queue state survives completed/interrupted turns. Only current execution
        // determines admission; the renderer's enqueue hint may already be stale.
        const enqueue = project.model.state.threads[threadId]?.turns?.some(turn => turn.status === 'inProgress');
        await this.submit(project, enqueue ? 'areal/turn/enqueue' : 'areal/turn/start', { threadId, input });
        break;
      }
      case 'steer': {
        const active = project.model.state.threads[threadId]?.turns.find(turn => turn.status === 'inProgress');
        if (!active || active.id !== request.expectedTurnId) throw new Error('原轮次已结束，请作为新消息发送');
        await this.submit(project, 'turn/steer', { threadId, expectedTurnId: active.id, input: messageInput(this, request), previousItems: active.items.map(item => item.id) });
        break;
      }
      case 'stop': {
        const active = [...project.model.state.threads[threadId]?.turns ?? []].reverse().find(turn => turn.status === 'inProgress');
        if (!active) throw new Error('没有正在运行的轮次，请刷新任务状态');
        await project.client.request('turn/interrupt', { threadId, turnId: active.id });
        break;
      }
      case 'respond': {
        const interaction = project.model.state.interactions[threadId]?.data.find(item => item.requestId === request.requestId && item.status === 'pending');
        if (!interaction) throw new Error('交互已过期，请刷新任务状态');
        try {
          await project.client.request('areal/interaction/respond', { threadId, turnId: interaction.turnId, requestId: interaction.requestId,
            ...(interaction.kind === 'approval' ? { decision: request.decision, argumentsDigest: interaction.argumentsDigest } : { answers: request.answers }),
          });
        } catch (error) {
          const current = await project.client.request('areal/interaction/list', { threadId }).catch(() => null);
          if (current) project.model.setInteractions(threadId, current);
          throw error;
        }
        break;
      }
      case 'reconcile': await this.reconcile(project); return { outcomes: project.outcomes };
      default: throw new Error('不支持的操作');
    }
    return this.snapshot();
  }

  hasWork({ includePausedQueues = true } = {}) {
    return [...this.projects.values()].some(project => project.pending.length || Object.values(project.model.state.threads)
      .some(thread => thread.turns?.some(turn => turn.status === 'inProgress'))
      // Paused pending messages are persisted input, not live execution. Lifecycle
      // checks can preserve them through shutdown; provider changes still guard them.
      || Object.values(project.model.state.queues).some(queue => queue.items.some(item => item.status === 'running'
        || (item.status === 'pending' && (includePausedQueues || queue.paused !== true)))));
  }

  async shutdown({ requireSafe = true } = {}) {
    if (!requireSafe) return this.disconnect();
    // 先检查全部已连接实例；真正停机仍由 Core 的公共服务接口关准入并结算。
    for (const project of this.projects.values()) {
      if (project.service && !project.client?.ready) throw new Error('Core 连接未恢复，不能安全停止');
      if (project.client?.ready && !(await project.client.request('areal/server/status')).restartSafe) {
        throw Object.assign(new Error('Core 仍有活动任务或终端，请先处理后台资源'), { code: 'CORE_RESOURCES' });
      }
    }
    this.closing = true;
    try {
      await Promise.allSettled([...this.starting.values()]);
      for (const project of this.projects.values()) {
        await stopService(this, project);
        project.taskNotificationMonitor?.stop();
      }
      await this.disconnect();
    } catch (error) { this.closing = false; throw error; }
  }

  async disconnect() {
    this.closing = true;
    for (const project of this.projects.values()) {
      clearTimeout(project.reconnectTimer); project.reconnectTimer = null;
      project.taskNotificationMonitor?.stop();
      project.client?.close();
    }
    await Promise.allSettled([...this.starting.values()]);
    await Promise.allSettled([...this.projects.values()].map(project => project.summaryReads));
    await this.providers.close();
    await this.analytics.flush();
  }

}

module.exports = { CoreBackend };
