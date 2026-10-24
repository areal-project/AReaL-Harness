'use strict';
const diagnostics = require('./diagnostics.cjs');
const { startupTrace } = require('./startup-timing.cjs');
const WebSocket = require('ws');
const { failure: browserFailure } = require('./browser-tool.cjs');
const { isObservationSizeFailure } = require('./history-observation.cjs');

// Owns observer connection identity, read waiters and reconnect scheduling.
// Deployment and feature initialization use explicit host ports; no mutation replay.
class ProjectConnections {
  constructor(host) {
    this.host = host;
    this.readWaiters = new WeakMap();
  }

  start(id) {
    try { this.host.worktrees?.assertAvailable(id); this.host.lifecycleOperations.assertProject(id); }
    catch (error) { return Promise.reject(error); }
    if (this.host.closing) return Promise.reject(new Error('应用正在退出'));
    if (this.host.starting.has(id)) return this.host.starting.get(id);
    const project = this.host.projects.get(id);
    if (project) { clearTimeout(project.reconnectTimer); project.reconnectTimer = null; project.reconnectBlocked = false; }
    const task = this.host.startProject(id).finally(() => this.host.starting.delete(id));
    this.host.starting.set(id, task);
    return task;
  }

  readConnection(id, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const startup = this.start(id);
    let waiters = this.readWaiters.get(startup);
    if (!waiters) {
      waiters = new Set();
      this.readWaiters.set(startup, waiters);
      startup.then(project => this.settleReadWaiters(startup, null, {
        project, client: project.client, generation: project.connectionGeneration ?? 0,
      }), error => this.settleReadWaiters(startup, error));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (error, connection) => {
        if (settled) return;
        settled = true;
        waiters.delete(settle);
        signal?.removeEventListener('abort', abort);
        try {
          if (error) throw error;
          this.host.lifecycleOperations.assertProject(id);
          const { project, client, generation } = connection;
          if (!this.host.saved.some(saved => saved.id === id) || this.host.projects.get(id) !== project)
            throw new Error('任务所有者已移除');
          this.requireConnection(project, client);
          if (!client.ready || (project.connectionGeneration ?? 0) !== generation)
            throw Object.assign(new Error('连接已换代，请重试'), { code: 'STALE_CONNECTION' });
          resolve(connection);
        } catch (failure) { reject(failure); }
      };
      const abort = () => settle(signal.reason);
      waiters.add(settle);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      const project = this.host.projects.get(id);
      if (project?.client?.ready) settle(null, {
        project, client: project.client, generation: project.connectionGeneration ?? 0,
      });
    });
  }

  settleReadWaiters(startup, error, connection) {
    for (const settle of this.readWaiters.get(startup) ?? []) settle(error, connection);
  }

  currentConnection(project, client) {
    return !this.host.closing && !!client && project.client === client && !client.closed;
  }

  requireConnection(project, client) {
    if (!this.currentConnection(project, client)) throw Object.assign(new Error('连接已换代，请等待状态恢复后重试'), { code: 'STALE_CONNECTION' });
  }

  scheduleReconnect(project) {
    try { this.host.worktrees?.assertAvailable(project.id); } catch { return; }
    if (this.host.closing || project.resourceInitializing || !project.service || project.reconnectBlocked || project.reconnectTimer || project.client?.ready) return;
    const delay = Math.min(500 * 2 ** Math.min(project.reconnectAttempt ?? 0, 6), 30000);
    project.reconnectTimer = setTimeout(() => {
      project.reconnectTimer = null;
      if (this.host.closing || !project.service || project.reconnectBlocked || project.client?.ready) return;
      if (this.host.providerUpdating || this.host.resourcesUpdating || this.host.starting.has(project.id)) { this.scheduleReconnect(project); return; }
      const task = this.reconnectProject(project).catch(error => {
        if (!this.host.closing) {
          project.reconnectBlocked = ['CORE_STOPPED', 'CORE_INCOMPATIBLE', 'CORE_RECOVERY_EXHAUSTED', 'LIFECYCLE_INCOMPLETE', 'LIFECYCLE_EXIT_REQUESTED', 'RESPONSE_TOO_LARGE'].includes(error.code)
            || error.reason === 'RESPONSE_TOO_LARGE' || project.client?.closeFailure?.code === 'RESPONSE_TOO_LARGE';
          project.reconnectAttempt = (project.reconnectAttempt ?? 0) + 1;
          this.host.stopReconciliation(project);
          project.client?.close();
          project.error = this.host.providers.redact(error.message);
          project.model.connection(false, project.error);
        }
        throw error;
      }).finally(() => {
        if (this.host.starting.get(project.id) === task) this.host.starting.delete(project.id);
        this.scheduleReconnect(project);
      });
      this.host.starting.set(project.id, task);
      // 用户操作可以加入同一恢复任务；无订阅者的被动失败也必须被接收。
      void task.catch(() => {});
    }, delay);
    project.reconnectTimer.unref();
  }

  async reconnectProject(project) {
    const previous = project.service, previousClient = project.client;
    const current = () => {
      this.host.worktrees?.assertAvailable(project.id);
      this.host.lifecycleOperations.assertProject(project.id);
      if (this.host.closing || this.host.projects.get(project.id) !== project || project.service !== previous || project.client !== previousClient)
        throw Object.assign(new Error('服务归属已变化'), { code: 'STALE_CONNECTION' });
    };
    current();
    let connection;
    try {
      connection = await this.host.connectExisting(project, previous);
      current();
      if (connection.descriptor.generation !== previous.generation) {
        if (project.crashRecovery?.original !== previous) throw Object.assign(new Error('Core 代际已变化，请检查原服务'), { code: 'CORE_INCOMPATIBLE' });
        connection = await this.recoverCrashedProject(project, previous, current);
      }
    } catch (error) {
      if (error.code !== 'CORE_STOPPED' || !this.host.applicationOwner) throw error;
      current();
      connection = await this.recoverCrashedProject(project, previous, current);
    }
    current();
    const { descriptor, token } = connection;
    if (descriptor.serviceId !== previous.serviceId || descriptor.configFingerprint !== previous.configFingerprint)
      throw Object.assign(new Error('Core 部署配置已变化，请显式重新连接'), { code: 'CORE_INCOMPATIBLE' });
    project.service = descriptor; project.endpoint = descriptor.endpoint; project.token = token;
    const owned = this.host.ownedEngines.get(project.id);
    if (owned) { owned.service = descriptor; owned.pending = false; }
    await this.connect(project, { observeOnly: true });
    await this.host.reconcile(project, { observeOnly: true });
    project.reconnectAttempt = 0;
    return project;
  }

  async recoverCrashedProject(project, original, current) {
    current();
    let attempt = project.crashRecovery;
    if (attempt?.original !== original) {
      project.crashCheck ??= { generation: original.generation, started: Date.now() };
      if (project.crashCheck.generation !== original.generation) project.crashCheck = { generation: original.generation, started: Date.now() };
      const { service, recovery } = await this.host.recoveryStatus(project, original);
      current();
      if (!recovery.eligible) {
        const waiting = service.state !== 'stopping' && recovery.reason === 'cleanupUnconfirmed'
          && Date.now() - project.crashCheck.started < 30000;
        throw Object.assign(new Error(waiting ? '正在确认原执行资源已清理' : '当前服务无法自动恢复，请检查原服务状态后重新连接'),
          { code: waiting ? 'CORE_RECOVERY_PENDING' : 'CORE_STOPPED' });
      }
      const now = Date.now();
      project.crashAttempts = (project.crashAttempts ?? []).filter(time => now - time < 300000);
      if (project.crashAttempts.length >= 2) throw Object.assign(new Error('服务连续中断，自动恢复已暂停，请检查服务详情后重新连接'), { code: 'CORE_RECOVERY_EXHAUSTED' });
      project.crashAttempts.push(now);
      attempt = project.crashRecovery = { original, calls: 0 };
    }
    if (attempt.calls >= 2) throw Object.assign(new Error('原服务的自动恢复结果仍未确认，请检查服务详情后重新连接'), { code: 'CORE_RECOVERY_EXHAUSTED' });
    const trace = startupTrace('core.crash_recovery', { projectId: project.id, coreGeneration: original.generation });
    try {
      const launch = await this.host.prepareServiceLaunch(project, trace);
      current();
      attempt.calls++;
      const connection = await this.host.recoverService(project, original, launch);
      current();
      if (connection.descriptor.generation === original.generation) throw Object.assign(new Error('恢复未返回原服务的后继代际'), { code: 'CORE_INCOMPATIBLE' });
      if ((await this.host.hooks.current()).revision === launch.hookDeployment.revision) project.hookRevision = launch.hookDeployment.revision;
      current();
      trace.finish('ok');
      return connection;
    } catch (error) { trace.finish('error', error); throw error; }
  }

  async connect(project, { observeOnly = false } = {}) {
    const startup = this.host.starting.get(project.id);
    const { CoreClient, MAX_RESPONSE_BYTES } = await import('@areal/runtime-client/core');
    if (this.host.closing) throw new Error('应用正在退出');
    project.taskNotificationMonitor?.stop();
    const previous = project.client;
    this.host.stopReconciliation(project);
    project.client = null;
    previous?.close();
    project.summariesLoaded = false;
    const cuaOwner = { projectId: project.id, coreInstanceId: project.service?.serviceId, coreGeneration: project.service?.generation };
    let cuaHostGeneration;
    const client = new CoreClient({ createSocket: () => {
      const target = Object.freeze({ boundary: 'desktop-core', projectId: project.id, coreGeneration: project.service?.generation,
        connectionGeneration: project.connectionGeneration, hostPid: project.service?.hostPid, corePid: project.service?.corePid, serviceId: project.service?.serviceId });
      const socket = new WebSocket(project.endpoint, { headers: { Authorization: `Bearer ${project.token}` }, followRedirects: false, maxPayload: MAX_RESPONSE_BYTES });
      socket.on('open', () => diagnostics.record({ type: 'socket-open', ...target }));
      socket.on('error', error => diagnostics.record({ type: 'socket-error', ...target, code: error.code }));
      socket.on('close', closeCode => diagnostics.record({ type: 'socket-close', ...target, closeCode }));
      return socket;
    }, onServerRequest: async (method, params, context) => {
      if (method === 'areal/task/prepare') {
        this.requireConnection(project, client);
        await this.host.scheduleAdmission.prepare(project, params);
        this.requireConnection(project, client);
        if (params.intent === 'resume') return {};
        await this.host.resources.beforeCreate(project);
        this.requireConnection(project, client);
        const model = this.host.providers.value.defaultModel;
        const profile = project.resourceProfile ?? this.host.defaultProfile;
        return { ...(model ? { model } : {}), ...(profile ? { agentProfile: profile } : {}),
          ...(this.host.desktopTools(project).length ? { dynamicTools: this.host.desktopTools(project) } : {}) };
      }
      if (method === 'areal/cua/turnEnded' || method === 'item/tool/call' && ['js', 'js_reset'].includes(params?.tool)) {
        this.requireConnection(project, client);
        cuaHostGeneration = params.hostGeneration;
        const result = await this.host.cuaRead({ ...params, projectId: project.id, cwd: project.root,
          toolHostGeneration: params.hostGeneration, coreInstanceId: project.service?.serviceId,
          coreGeneration: project.service?.generation, signal: context.signal,
          phase: method === 'areal/cua/turnEnded' ? 'endTurn' : 'call' });
        return method === 'areal/cua/turnEnded' ? result : { success: result.isError !== true, contentItems: [], rawMcpResult: result };
      }
      if (params?.tool === 'computer_v1' && ['item/tool/call', 'areal/computer/prepare'].includes(method)) {
        this.requireConnection(project, client);
        if (!this.host.supportsComputer(project)) throw new Error('Computer tool capability unavailable');
        return this.host.computerRead({ projectId: project.id, threadId: params.threadId,
          turnId: params.turnId, callId: params.callId, toolHostGeneration: params.hostGeneration,
          arguments: params.arguments, computerApproval: params.computerApproval,
          discardPreparedPlan: method === 'areal/computer/prepare' && params.discardPreparedPlan === true,
          phase: method === 'areal/computer/prepare' ? 'prepare' : 'execute',
          coreInstanceId: project.service?.serviceId, coreGeneration: project.service?.generation, signal: context.signal });
      }
      if (!['item/tool/call', 'areal/browser/prepare'].includes(method) || params?.tool !== 'browser_v1') throw new Error('Unsupported client tool');
      const connected = this.currentConnection(project, client);
      // Core invokes only tools bound to this connection. The local Thread
      // projection can lag the committed attachment until its event arrives.
      const result = connected ? (await this.host.browserRead?.({ projectId: project.logicalProjectId ?? project.id, threadId: params.threadId,
        turnId: params.turnId, callId: params.callId, toolHostGeneration: params.hostGeneration, arguments: params.arguments,
        phase: method === 'areal/browser/prepare' ? 'prepare' : 'execute', browserApproval: params.browserApproval,
        coreInstanceId: project.service?.serviceId, coreGeneration: project.service?.generation,
        signal: context.signal })) ?? browserFailure('host_unavailable', 'Desktop browser is unavailable')
        : browserFailure('host_unavailable', 'Desktop connection changed');
      if (method === 'areal/browser/prepare' && result?.success === false
        && typeof result.structuredContent?.code === 'string' && result.structuredContent.dispatch === 'not_sent')
        return { error: result.structuredContent.code, dispatch: 'not_sent' };
      return result;
    } });
    project.client = client;
    project.connectionGeneration = (project.connectionGeneration ?? 0) + 1;
    const correlation = { projectId: project.id, connectionGeneration: project.connectionGeneration, coreGeneration: project.service?.generation };
    const trace = startupTrace('core.connect', correlation);
    trace.advance('socket');
    try {
      client.onNotification((method, params) => {
        if (this.currentConnection(project, client)) this.host.observeNotification(project, client, method, params);
      });
      client.onClose(failure => {
        if (cuaHostGeneration) void Promise.resolve(this.host.cuaRead?.({ phase: 'revokeProject', ...cuaOwner, toolHostGeneration: cuaHostGeneration })).catch(() => {});
        this.host.onMcpPageToolsDisconnected?.(client);
        if (project.client === client) {
        project.taskNotificationMonitor?.stop();
        this.host.stopReconciliation(project);
        if (failure.code === 'RESPONSE_TOO_LARGE') {
          project.reconnectBlocked = true;
          clearTimeout(project.reconnectTimer);
          project.reconnectTimer = null;
          project.error = 'Core 返回内容超过当前支持的 64 MiB，无法完整加载。';
        }
        project.model.connection(false, project.reconnectBlocked ? project.error : '连接中断，正在恢复任务状态');
        this.scheduleReconnect(project);
      } });
      await client.connect();
      this.requireConnection(project, client);
      if (startup && this.host.starting.get(project.id) === startup) this.settleReadWaiters(startup, null, {
        project, client, generation: correlation.connectionGeneration,
      });
      project.error = null;
      project.configurations ??= {};
      project.configurationChanges ??= new Map();
      trace.advance('provider_configuration');
      await this.host.providers.reconcileProject(project, { refreshModels: false });
      this.requireConnection(project, client);
      if (!observeOnly) {
        trace.advance('providers');
        await this.host.providers.syncLocal(project);
        this.requireConnection(project, client);
        trace.advance('mcp');
        await this.host.resources.syncMcp(project);
        this.requireConnection(project, client);
      }
      trace.advance('catalogs');
      const modelsTrace = startupTrace('core.model_list', correlation);
      modelsTrace.advance('request');
      const profilesTrace = startupTrace('core.profile_list', correlation);
      profilesTrace.advance('request');
      const [models, profiles] = await Promise.all([
        client.request('areal/model/list').then(value => { modelsTrace.finish('ok'); return value; }, error => { modelsTrace.finish('error', error); throw error; }),
        client.request('areal/profile/list').then(value => { profilesTrace.finish('ok'); return value; }, error => { profilesTrace.finish('error', error); throw error; }),
      ]);
      this.requireConnection(project, client);
      await this.host.providers.acceptModelSelection(models.lastAcceptedModel);
      project.models = models.data ?? models.models ?? [];
      project.profiles = profiles.data ?? profiles.profiles ?? [];
      trace.advance('history');
      await this.host.listThreads(project);
      if (!observeOnly) void this.host.analytics.syncProject(project);
      // 重连恢复所有已打开的任务，快照在 socket 消息分派栈内替换。
      trace.advance('restore_views');
      for (const threadId of Object.keys(project.model.state.threads)) {
        try { await this.host.openThread(project, threadId); }
        catch (error) {
          if (!isObservationSizeFailure(error) || !this.currentConnection(project, client) || !client.ready) throw error;
        }
      }
      trace.advance('task_subscriptions');
      for (const taskId of new Set(project.taskViews?.values() ?? [])) {
        await client.request('areal/task/subscribe', { taskId }, { onResult: task => {
          if (this.currentConnection(project, client)) project.model.setTask(task);
        } });
        this.requireConnection(project, client);
      }
      trace.advance('task_monitor');
      await this.host.startTaskMonitor(project, client);
      this.requireConnection(project, client);
      trace.advance('host_ready');
      if (client.capabilities?.methods?.includes('areal/task/host/ready')) {
        await client.request('areal/task/host/ready', {});
        this.requireConnection(project, client);
      }
      trace.advance('connected');
      project.model.connection(true);
      this.host.scheduleReconciliation(project);
      this.host.onChange();
      trace.finish('ok');
      void this.host.providers.refreshSubscription(project, correlation, { observeOnly });
    } catch (error) { trace.finish('error', error); throw error; }
  }
}

module.exports = { ProjectConnections };
