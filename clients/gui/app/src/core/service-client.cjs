'use strict';
const diagnostics = require('./diagnostics.cjs');
const { commandSemantics } = require('@areal/workbench/desktop-contract');
const { startupTrace } = require('./startup-timing.cjs');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { mkdir, readFile, realpath, open, writeFile, rename, rm } = require('node:fs/promises');
const { join } = require('node:path');
const WebSocket = require('ws');
const { ProjectionReader } = require('@areal/workbench/state-projection');
const { PROTOCOL, COMMAND_CONTRACT, encodeMedia, decodeMedia } = require('./service-protocol.cjs');
const { serviceIdentity } = require('./service-config.cjs');
const { genUiScope, createGenUiState } = require('./gen-ui-state.cjs');
const { inspectCoreCapabilities } = require('./core-capabilities.cjs');
const { desktopExecutables } = require('./desktop-executables.cjs');
const { sameOwner, scrubOwnerEnvironment } = require('./application-owner.cjs');
let diagnosticsConnectionGeneration = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const currentCommands = new Set(['send', 'editMessage', 'continue', 'prepareCreator', 'feedback', 'create', 'configure']);
const currentManagePrefixes = ['plugin', 'marketplace', 'mcpApp', 'mcpForm'];
const currentManageOperations = new Set(['mcpExtensionCall', 'mcpToolResult', 'connectorConfigure', 'connectorCredential', 'hookAcknowledge',
  'taskCreate', 'taskUpdate', 'taskPause', 'taskResume', 'taskStopRun', 'taskResumeRun', 'taskCancel', 'taskDelete', 'taskReply']);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const desktopKind = kind => ['stopDesktop', 'updateDesktop'].includes(kind);
const needsOriginalCheck = operation => operation.phase === 'admissionUnconfirmed'
  || operation.phase === 'acceptedPending' && operation.desktopExit === 'requested'
  || operation.targets.some(target => ['notAttempted', 'acceptedPending', 'admissionUnconfirmed'].includes(target.phase));
const notAdmittedCodes = new Set(['LIFECYCLE_ADMISSION_FAILED', 'LIFECYCLE_UNSUPPORTED', 'LIFECYCLE_INVALID_REQUEST', 'LIFECYCLE_REQUEST_CONFLICT',
  'CONFIRMATION_STALE', 'LIFECYCLE_BLOCKED', 'LIFECYCLE_INCOMPLETE']);
const lifecycleMessage = phase => ({ acceptedPending: '请求已受理，后台仍在完成退出和清理。', blocked: '后台明确拒绝了此次操作，原任务仍可继续使用。',
  admissionUnconfirmed: '原请求是否受理尚未确认，请检查原请求；不会自动重发。', settlementIncomplete: '请求已受理，部分资源尚未完成清理。',
  partial: '部分后台已完成，仍有目标需要检查。', completed: '后台操作已完成。' })[phase];

function requiresCurrentCommands(name, request) {
  return currentCommands.has(name)
    || name === 'side' && ['create', 'close'].includes(request.operation)
    || ['steer', 'queueEdit'].includes(name) && request.mcpContent?.length > 0
    || name === 'trajectory' && request.operation === 'setEnabled'
    || name === 'providers' && request.operation === 'defaultAndApply'
    || name === 'manage' && (currentManageOperations.has(request.operation)
      || currentManagePrefixes.some(prefix => request.operation?.startsWith(prefix)));
}

function validateServicePacket(packet, metadata) {
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const count = value => Number.isSafeInteger(value) && value >= 0;
  const snapshot = packet?.snapshot, service = packet?.service, library = snapshot?.library;
  if (!count(packet?.sequence) || !record(snapshot) || !record(library)
    || !record(library.projects) || !record(library.threads) || !record(library.settings)
    || !Array.isArray(library.projectOrder) || !library.projectOrder.every(id => typeof id === 'string')
    || !Array.isArray(snapshot.projects) || snapshot.projects.some(project => !record(project)
      || typeof project.id !== 'string' || typeof project.root !== 'string'
      || project.state !== null && (!record(project.state) || !record(project.state.threads)))
    || !record(service) || service.connected !== true || typeof service.busy !== 'boolean'
    || typeof service.providerUpdating !== 'boolean' || !count(service.clients)
    || !count(service.activeCommands) || !count(service.starting)
    || !Number.isSafeInteger(service.pid) || service.pid <= 1 || service.pid !== metadata.pid
    || (metadata.applicationOwner !== undefined || service.applicationOwner !== undefined)
      && !sameOwner(metadata.applicationOwner, service.applicationOwner)) {
    throw Object.assign(new Error('后台服务快照不受支持，原后台保持运行。请安全重启后使用本次配置。'), { code: 'SERVICE_SNAPSHOT_INVALID' });
  }
}

async function waitForServiceExit(home, metadata) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const current = JSON.parse(await readFile(join(home, 'service.json'), 'utf8'));
      if (metadata.desktopGeneration ? current.desktopGeneration !== metadata.desktopGeneration : current.token !== metadata.token) return;
    } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await sleep(100);
  }
  throw new Error('旧后台尚未完成退出，请稍后重新连接。未删除任何任务数据。');
}
async function waitForServiceProcessExit(home, metadata) {
  await waitForServiceExit(home, metadata);
  await waitForProcessExit(metadata.pid);
}
async function waitForProcessExit(pid) {
  const deadline = Date.now() + 15000;
  for (;;) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    if (Date.now() >= deadline) throw new Error('后台进程尚未退出，请稍后重试');
    await sleep(50);
  }
}

class ServiceConnection {
  constructor(onState = () => {}, onClose = () => {}, onNotification = () => {}, onNotificationOpen = () => {}, onBrowserRequest = null, onBrowserCancel = null, onMcpAppNotification = () => {}, onMcpPageToolNotice = () => {}, onMcpPageToolsRevoked = () => {}) {
    this.onNotification = onNotification;
    this.onNotificationOpen = onNotificationOpen;
    this.onBrowserRequest = onBrowserRequest;
    this.onBrowserCancel = onBrowserCancel;
    this.onMcpAppNotification = onMcpAppNotification;
    this.onMcpPageToolNotice = onMcpPageToolNotice;
    this.onMcpPageToolsRevoked = onMcpPageToolsRevoked;
    this.onState = onState; this.onClose = onClose; this.pending = new Map(); this.nextId = 0;
  }
  async connect(metadata) {
    const url = new URL(metadata.endpoint);
    if (metadata.protocol !== PROTOCOL || url.protocol !== 'ws:' || url.hostname !== '127.0.0.1'
      || url.username || url.password || !/^[a-f0-9]{64}$/.test(metadata.token)
      || typeof metadata.identity !== 'string' || !metadata.identity
      || !Number.isSafeInteger(metadata.pid) || metadata.pid <= 1) throw new Error('本地后台服务连接元数据无效');
    const socket = this.socket = new WebSocket(url, { headers: { Authorization: `Bearer ${metadata.token}` }, followRedirects: false, maxPayload: 256 * 1024 * 1024 });
    const projection = new ProjectionReader();
    const target = Object.freeze({ boundary: 'main-desktop', hostPid: metadata.pid, coreGeneration: metadata.desktopGeneration, connectionGeneration: ++diagnosticsConnectionGeneration });
    socket.on('open', () => diagnostics.record({ type: 'socket-open', ...target }));
    socket.on('error', error => diagnostics.record({ type: 'socket-error', ...target, code: error.code }));
    socket.on('close', closeCode => diagnostics.record({ type: 'socket-close', ...target, closeCode }));
    socket.on('message', bytes => {
      if (this.socket !== socket) return;
      let message;
      try {
        message = JSON.parse(bytes.toString());
        const key = message.method === 'state' ? 'params' : 'result';
        const packet = message[key];
        if (packet?.snapshot && Object.hasOwn(packet.snapshot, 'projection'))
          message[key] = { ...packet, snapshot: projection.read(packet.snapshot) };
      } catch { socket.terminate(); return; }
      if (message.method === 'mcpPageToolNotice') { this.onMcpPageToolNotice(message.params); return; }
      if (message.method === 'mcpPageToolsRevoked') { this.onMcpPageToolsRevoked(message.params); return; }
      if (message.method === 'mcpAppNotification') { if (this.socket === socket) this.onMcpAppNotification?.(message.params); return; }
      if (message.method === 'notification') { this.onNotification(message.params); return; }
      if (message.method === 'notificationOpen') { this.onNotificationOpen(message.params); return; }
      if (message.method === 'state') { this.onState(message.params); return; }
      if (message.method === 'browserCancel') { this.onBrowserCancel?.(message.params); return; }
      if (message.method === 'browserRequest') {
        if (!this.onBrowserRequest || !Number.isSafeInteger(message.params?.requestId)) { socket.terminate(); return; }
        void Promise.resolve().then(() => this.onBrowserRequest(message.params)).then(
          result => { if (this.socket === socket && socket.readyState === WebSocket.OPEN) void this.request('browserResult', { requestId: message.params.requestId, result }, true).catch(() => {}); },
          () => { if (this.socket === socket && socket.readyState === WebSocket.OPEN) void this.request('browserResult', { requestId: message.params.requestId, error: 'host_failed' }, true).catch(() => {}); },
        );
        return;
      }
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(Object.assign(new Error(message.error.message), message.error));
      else entry.resolve(message.result);
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(Object.assign(new Error(entry.mutation ? '后台连接中断，操作结果未确认；请重连后核对任务，不会自动重发。' : '后台服务连接已断开'), { submissionUnknown: entry.mutation, code: 'DISCONNECTED', requestId: entry.requestId, recovery: { kind: entry.mutation ? 'queryOriginal' : 'retryRead' } }));
      }
      this.pending.clear(); this.onClose();
    });
    await new Promise((resolve, reject) => {
      const fail = () => { clearTimeout(timer); reject(Object.assign(new Error('无法连接本地后台服务'), { code: 'DISCONNECTED' })); };
      const timer = setTimeout(() => { fail(); socket.terminate(); }, 2000);
      socket.once('open', () => { clearTimeout(timer); resolve(); }); socket.once('error', fail); socket.once('close', fail);
    });
  }
  request(method, params, mutation = false) {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(Object.assign(new Error('后台服务已断开，请重新连接'), { code: 'DISCONNECTED', submissionUnknown: false, outcome: { kind: mutation ? 'rejected' : 'noMutation' }, recovery: { kind: mutation ? 'none' : 'retryRead' } }));
    if (method === 'hello') params = { ...params, capabilities: { ...params?.capabilities, projection: 1 } };
    const id = ++this.nextId;
    const requestId = method === 'command' ? params.request?.requestId ?? params.request?.draftId : undefined;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(mutation ? '后台请求超时，请核对结果后继续；不会自动重发。' : '读取状态超时，请重试。'), { submissionUnknown: mutation, code: 'TIMEOUT', requestId, recovery: { kind: mutation ? 'queryOriginal' : 'retryRead' } }));
      }, 150000);
      this.pending.set(id, { resolve, reject, timer, mutation, requestId });
      this.socket.send(JSON.stringify({ id, method, params }), error => { if (error) this.socket.terminate(); });
    });
  }
  close() { this.socket?.close(); }
}

// GUI-local connection/projection only. Control intent lives in GUI userData;
// shared Core history and execution state remain owned by the service.
class SharedCoreBackend {
  constructor({ app, onChange = () => {}, onNotification, onNotificationOpen, onRecoveryAttention, ...options }) {
    this.onNotification = onNotification;
    this.onNotificationOpen = onNotificationOpen;
    this.onRecoveryAttention = onRecoveryAttention; this.app = app; this.options = options; this.applicationOwner = options.applicationOwner; this.desktopLifetimes = new Set(); this.home = options.home; this.onChange = onChange;
    this.genUiState = createGenUiState(this.home);
    this.value = { library: { projects: {}, threads: {}, projectOrder: [], settings: {} }, projects: [] };
    this.status = { connected: false }; this.sequence = -1;
    this.connectionState = { state: 'connecting' }; this.revision = 0; this.initializing = false;
    this.guiTerminals = new Map(); this.guiTerminalStarts = new Set();
    this.guiSideChats = new Map(); this.guiSideStarts = new Set(); this.guiWindowClosed = false;
    this.lifecycleReferences = new Map(); this.lifecycleReceipts = new Map();
    this.analytics = { sample: sample => { this.lastActivity = sample; if (this.status.connected) void this.connection.request('activity', sample).catch(() => {}); }, flush: async () => {} };
  }
  genUiScope(project, threadId) { return genUiScope(this.home, project, threadId); }
  get saved() { return this.value.projects; }
  get activeCommands() { return this.status.activeCommands ?? 0; }
  get providerUpdating() { return this.status.providerUpdating; }
  get starting() { return { size: this.status.starting ?? 0 }; }
  hasWork() { return !this.status.connected || this.status.busy === true; }
  ownsThread(projectId, threadId) {
    if (this.value.library.projects[projectId]?.hidden) return false;
    const thread = this.saved.find(p => p.id === projectId)?.state?.threads?.[threadId];
    return !!thread && !thread.desktop?.archived;
  }
  retainsThreadResources(projectId, threadId) {
    const project = this.saved.find(project => project.id === projectId);
    const thread = project?.state?.threads?.[threadId];
    if (thread?.conversation?.policy?.kind !== 'sideExecutableV2' || thread.desktop?.archived !== true) return false;
    return !Object.values(project.outcomes ?? {}).some(outcome => outcome.method === 'areal/side/close'
      && outcome.threadId === threadId && outcome.accepted === true && outcome.cleanupConfirmed === true);
  }
  snapshot() {
    const desktopCapabilities = { currentCommands: this.status.commandContract === COMMAND_CONTRACT };
    const connection = this.initializing && this.connectionState.state === 'ready' ? { state: 'connecting' } : this.connectionState;
    return { ...this.value, desktopCapabilities,
      serviceSummary: { state: this.status.connected ? 'running' : this.serviceExited ? 'stopped' : 'unknown',
        busy: this.status.busy === true },
      projects: this.value.projects.map(project => ({ ...project, desktopCapabilities })),
      backendUpdate: this.backendUpdate, lifecycle: this.lifecycleProjection(),
      revision: ++this.revision, connection };
  }
  accept(packet, metadata = this.metadata) {
    if (this.disposed) return;
    validateServicePacket(packet, metadata);
    if (packet.sequence <= this.sequence) return;
    this.clearReconnect(); this.reconnectAttempts = 0;
    this.sequence = packet.sequence; this.value = packet.snapshot; this.status = packet.service;
    this.connectionState = this.foreignOwner
      ? { state: 'unavailable', recovery: 'check', message: '原后台属于旧应用会话，仅供检查。请安全迁移后继续。' }
      : { state: 'ready' };
    this.onChange();
  }
  disconnected() {
    this.computerHostOwned = false;
    this.onBrowserDisconnected?.();
    this.onMcpPageToolsDisconnected?.();
    const stopped = !!this.connection && this.stoppedConnection === this.connection;
    const message = stopped ? '后台服务已停止，可按需重新连接' : '后台服务已断开，请重新连接';
    this.connectionState = { state: 'unavailable', message };
    this.status = { ...this.status, connected: false };
    this.value = { ...this.value, projects: this.value.projects.map(p => ({ ...p, error: stopped ? null : message, state: p.state ? { ...p.state, connected: false, error: stopped ? null : message } : null })) };
    this.scheduleReconnect();
    this.onChange();
  }
  clearReconnect() { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  canReconnect() {
    return !this.disposed && !this.reconnectBlocked && !this.status.connected && !this.serviceExited
      && !['stopped', 'unconfirmed'].includes(this.controlState) && !this.status.stopReport;
  }
  scheduleReconnect() {
    if (!(this.metadata?.identity ?? this.identity) || !this.canReconnect() || this.reconnectTimer) return;
    this.connectionState = { state: 'connecting' };
    const delay = Math.min(30000, 500 * 2 ** Math.min(this.reconnectAttempts ?? 0, 6));
    this.reconnectAttempts = (this.reconnectAttempts ?? 0) + 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.canReconnect()) return;
      if (this.connecting) { this.scheduleReconnect(); return; }
      // 只恢复观察连接：不调用 initialize，不启动 Core、不重放任何未知提交。
      this.connecting = (async () => {
        const control = await this.readControl();
        if (control?.state) {
          this.controlState = control.state; this.reconnectBlocked = true;
          this.connectionState = { state: 'unavailable', recovery: 'check', message: '后台操作已保留，请检查原请求后继续。' };
          this.onChange(); return;
        }
        this.loadReferences(control);
        if (await this.attach({ passive: true })) {
          for (const reference of this.lifecycleReferences.values()) await this.readLifecycle(reference);
        }
      })().catch(error => {
        if (error.submissionUnknown !== true && (error.code === 'DISCONNECTED'
          || error.code === 'TIMEOUT' && error.recovery?.kind === 'retryRead')) return;
        this.reconnectBlocked = true;
        this.connectionState = { state: 'unavailable', message: error.message };
        this.onChange();
      }).finally(() => { this.connecting = null; this.scheduleReconnect(); });
    }, delay);
    this.reconnectTimer.unref?.();
  }
  async attach({ expectedIdentity, passive = false } = {}) {
    let metadata;
    try { metadata = JSON.parse(await readFile(join(this.home, 'service.json'), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return false; throw e; }
    this.foreignOwner = this.applicationOwner && !sameOwner(metadata.applicationOwner, this.applicationOwner)
      ? metadata : null;
    const identity = expectedIdentity ?? (passive ? this.metadata?.identity ?? this.identity : metadata.identity);
    const connection = new ServiceConnection(packet => {
      if (this.connection !== connection) return;
      try { this.accept(packet, metadata); }
      catch { this.connection = null; connection.close(); this.disconnected(); }
    }, () => { if (this.connection === connection) this.disconnected(); }, notice => { if (this.connection === connection) this.onNotification?.(notice); }, target => { if (this.connection === connection) this.onNotificationOpen?.(target); }, request => {
      if (this.connection !== connection || this.disposed) throw new Error('Browser host is disconnected');
      return this.onBrowserRequest?.(request) ?? Promise.reject(new Error('Browser host unavailable'));
    }, request => { if (this.connection === connection) this.onBrowserCancel?.(request); }, event => {
      if (this.connection === connection && !this.disposed) this.onMcpAppNotification?.(event);
    }, event => {
      if (this.connection === connection && !this.disposed) this.onMcpPageToolNotice?.(event);
    }, event => {
      if (this.connection === connection && !this.disposed) this.onMcpPageToolsDisconnected?.(event);
    });
    try { await connection.connect(metadata); }
    catch (e) { connection.close(); if (e.code === 'DISCONNECTED') return false; throw e; }
    if (this.disposed) { connection.close(); throw new Error('GUI 连接已关闭'); }
    if (passive && !this.canReconnect()) { connection.close(); return false; }
    if (this.connection) this.onMcpPageToolsDisconnected?.();
    this.connection?.close(); this.connection = connection; this.sequence = -1;
    const helloTrace = startupTrace('service.hello', { servicePid: metadata.pid });
    helloTrace.advance('hello');
    try {
      const deadline = Date.now() + 60000;
      for (;;) {
        try {
          const packet = await connection.request('hello', { protocol: PROTOCOL, identity, notifications: !!this.onNotification, capabilities: { computerHost: 1 } });
          if (this.connection !== connection) throw Object.assign(new Error('后台服务连接已变化，请重新连接'), { code: 'DISCONNECTED' });
          this.computerHostOwned = packet.computerHostOwned === true;
          this.accept(packet, metadata); break;
        }
        catch (error) {
          if (passive) throw error;
          if (error.code !== 'SERVICE_STOPPING') throw error;
          // Safety inspection can cancel retirement. Retry only the read-only
          // handshake: attach if retained, rediscover when the old socket closes.
          if (this.disposed || Date.now() >= deadline) throw new Error('后台尚未完成退出检查，请稍后重新连接');
          await sleep(100);
        }
      }
    }
    catch (e) {
      helloTrace.finish('error', e);
      this.connection = null;
      connection.close();
      if (e.code === 'DISCONNECTED') return false; // Only a read-only handshake was attempted.
      if (expectedIdentity !== undefined && (e.code === 'SERVICE_INCOMPATIBLE' || e.message.startsWith('后台服务版本或启动配置不兼容。'))) {
        throw Object.assign(new Error('当前后台使用了不同的启动配置，本次启动配置尚未生效。请重新连接，或安全停止后台后重试。'), { code: 'SERVICE_INCOMPATIBLE' });
      }
      throw e;
    }
    helloTrace.finish('ok');
    if (this.lastActivity) void connection.request('activity', this.lastActivity).catch(() => {});
    this.metadata = metadata; this.exitConfirmation = null;
    if (this.foreignOwner) {
      this.backendUpdate = { state: 'pending', message: '原后台属于旧应用会话，请检查并安全停止后迁移。' };
      this.connectionState = { state: 'unavailable', recovery: 'check', message: '原后台仅供检查。请使用“检查后台资源”安全停止旧应用会话，再重新连接。' };
      this.onChange();
    }
    return true;
  }
  get controlPath() { return join(this.app.getPath('userData'), 'service-control.json'); }
  async readControl() {
    try {
      const control = JSON.parse(await readFile(this.controlPath, 'utf8'));
      return control.home === await realpath(this.home) ? control : null;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async saveControl(state) {
    await mkdir(this.app.getPath('userData'), { recursive: true, mode: 0o700 });
    await writeFile(`${this.controlPath}.tmp`, JSON.stringify({ home: this.home, state, pid: this.metadata?.pid }), { mode: 0o600 });
    await rename(`${this.controlPath}.tmp`, this.controlPath);
    this.controlState = state;
  }
  async init({ automatic = false } = {}) {
    if (this.disposed) throw new Error('GUI 连接已关闭');
    if (this.connecting) return this.connecting;
    // 控制文件读取也属于同一次连接尝试；首次 await 前建立共享门闩，避免并发调用互相关闭连接或重复启动后台。
    this.connecting = (async () => {
      const control = await this.readControl();
      if (this.disposed) throw new Error('GUI 连接已关闭');
      this.loadReferences(control);
      if (automatic && this.controlState === 'stopped') {
        this.connectionState = { state: 'unavailable', message: '后台服务已停止，可按需重新连接' }; this.onChange(); return;
      }
      if (this.status.connected && !this.lifecycleReferences.size && !this.legacyControl) return;
      this.clearReconnect(); this.initializing = true;
      this.connectionState = { state: 'connecting' }; this.onChange();
      if (this.lifecycleReferences.size || this.legacyControl) {
        await this.checkLifecycle();
        const completedStop = this.lifecycleReferences.size > 0 && [...this.lifecycleReferences.values()].every(reference =>
          reference.kind === 'stopDesktop' && this.lifecycleReceipts.get(reference.requestId)?.phase === 'completed');
        if (!automatic && completedStop) {
          this.lifecycleReferences.clear(); this.lifecycleReceipts.clear(); await this.persistReferences();
        } else {
          if (!this.status.connected) this.connectionState = { state: 'unavailable', recovery: 'check',
            message: '原后台暂不可连接，操作引用已保留。请检查原请求，不会自动启动或重发。' };
          return;
        }
      }
      this.reconnectBlocked = false;
      await this.initialize(automatic);
      if (!this.lifecycleReferences.size) { await rm(this.controlPath, { force: true }); this.controlState = null; }
    })().catch(error => {
      this.connectionState = { state: 'unavailable', message: error.message };
      if (['SERVICE_NOT_READY', 'DISCONNECTED'].includes(error.code)) this.scheduleReconnect();
      this.onChange(); throw error;
    }).finally(() => { this.initializing = false; this.connecting = null; this.onChange(); });
    return this.connecting;
  }
  async initialize(automatic = false) {
    const trace = startupTrace('service.initialize');
    trace.advance('home');
    try {
      await mkdir(this.home, { recursive: true, mode: 0o700 });
      this.home = await realpath(this.home);
      if (this.disposed) throw new Error('GUI 连接已关闭');
      trace.advance('attach');
      const retained = await this.attach();
      if (this.disposed) throw new Error('GUI 连接已关闭');
      trace.advance('identity');
      try { this.identity = await serviceIdentity(this.options); }
      catch (error) {
        if (!retained || !this.status.connected) throw error;
        this.backendUpdate = { state: 'failed', message: error.message }; this.onChange(); return;
      }
      if (this.disposed) throw new Error('GUI 连接已关闭');
      if (retained) {
        if (!this.foreignOwner) this.backendUpdate = this.identity === this.metadata.identity ? undefined : { state: 'pending' };
        this.onChange();
        return;
      }
      // Explain a known binary incompatibility through this connection attempt's
      // error channel; never expose shared or stale service log contents to GUI.
      trace.advance('capabilities');
      if (!retained) await inspectCoreCapabilities(this.options.binary);
      trace.advance('spawn_wait');
      const env = { ...scrubOwnerEnvironment(), AREAL_BACKEND: 'areal', AREAL_CORE_HOME: this.home,
        ...(this.applicationOwner ? { AREAL_GUI_OWNER: JSON.stringify(this.applicationOwner), AREAL_GUI_DESKTOP_LIFETIME_FD: '3' } : {}) };
      delete env.ELECTRON_RUN_AS_NODE;
      const args = this.app.isPackaged ? ['--areal-core-service'] : [this.app.getAppPath(), '--areal-core-service'];
      const executable = desktopExecutables({ packaged: this.app.isPackaged }).service;
      const log = await open(join(this.home, 'service.log'), 'a', 0o600);
      try {
        let launchError, retryLaunch = false;
        const launch = () => {
          if (this.disposed) throw new Error('GUI 连接已关闭');
          retryLaunch = false;
          const child = spawn(executable, args, { detached: true,
            stdio: ['ignore', log.fd, log.fd, ...(this.applicationOwner ? ['pipe'] : [])], env, windowsHide: true });
          child.once('spawn', () => diagnostics.record({ type: 'desktop-spawn', pid: child.pid }));
          child.once('exit', (exitCode, signal) => diagnostics.record({ type: 'desktop-exit', pid: child.pid, exitCode, signal }));
          if (this.applicationOwner) {
            const lifetime = child.stdio[3];
            this.desktopLifetimes.add(lifetime);
            lifetime.on('error', () => {});
            child.once('exit', () => { lifetime.destroy(); this.desktopLifetimes.delete(lifetime); });
          }
          child.once('error', e => { diagnostics.record({ type: 'desktop-spawn-error', code: e.code }); launchError = e; });
          child.once('exit', code => { retryLaunch = code === 0; }); child.unref();
        };
        launch();
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          if (this.disposed) throw new Error('GUI 连接已关闭');
          if (launchError) throw launchError;
          if (await this.attach({ expectedIdentity: this.identity })) { this.backendUpdate = undefined; return; }
          if (retryLaunch) launch();
          await sleep(100);
        }
        throw Object.assign(new Error(`后台服务未就绪；请检查 ${join(this.home, 'service.log')}`), { code: 'SERVICE_NOT_READY' });
      } finally { await log.close(); }
    } catch (error) { trace.finish('error', error); throw error; }
    finally { trace.finish('ok'); }
  }
  async addProject(path) {
    await this.init();
    this.assertLifecycleScope('addProject');
    const connection = this.connection;
    try { return await connection.request('addProject', { path }, true); }
    catch (error) {
      if (error.submissionUnknown || ['admitted', 'unconfirmed'].includes(error.outcome?.kind)) throw error;
      const packet = await connection.request('snapshot').catch(() => null);
      if (!packet || connection !== this.connection || !this.status.connected) throw error;
      this.accept(packet);
      const project = this.value.projects.find(project => project.root === path
        && !project.state?.connected && project.error && project.error === error.message);
      if (!project) throw error;
      return project.id;
    }
  }
  async mcpPageTools(request) {
    if (!this.status.connected || !this.connection) throw new Error('Page tool owner lease is disconnected');
    return this.connection.request('mcpPageTools', request, true);
  }
  async browserClaim(identity) {
    this.assertLifecycleScope('browserClaim');
    if (!this.status.connected || !this.connection) throw new Error('后台尚未连接');
    return this.connection.request('browserClaim', identity, true);
  }
  async browserRevoke(identity) {
    if (this.foreignOwner) return;
    if (!this.status.connected || !this.connection) return;
    return this.connection.request('browserRevoke', identity, true);
  }
  async command(name, request) {
    if (this.disposed) throw new Error('GUI 连接已关闭');
    if (this.connecting) await this.connecting.catch(() => {});
    // Only explicit reconnect opens a stopped service. Periodic panel reads must
    // not undo the user's stop action; in-flight commands are never replayed.
    if (name === 'connect' && !this.status.connected) await this.init();
    if (this.disposed) throw new Error('GUI 连接已关闭');
    if (!this.status.connected) throw new Error('后台尚未连接，请先处理后台连接提示');
    if (this.foreignOwner) this.assertLifecycleScope(name, request);
    if (name === 'stop') {
      if (!uuid(request.requestId) || typeof request.turnId !== 'string' || !request.turnId)
        throw Object.assign(new Error('暂停需要原轮次和操作身份，请刷新任务后重试'), { code: 'LIFECYCLE_INVALID_REQUEST' });
      return this.requestLifecycle({ kind: 'interruptTurn', mode: 'cancel', projectId: request.projectId,
        threadId: request.threadId, turnId: request.turnId, requestId: request.requestId });
    }
    this.assertLifecycleScope(name, request);
    if (this.status.commandContract !== COMMAND_CONTRACT && requiresCurrentCommands(name, request)) {
      throw Object.assign(new Error('当前运行中的后台不支持此操作。现有任务继续运行，输入已保留；请在任务完成后安全停止后台并重新连接。'), { code: 'SERVICE_COMMAND_UNSUPPORTED' });
    }
    // Only explicitly GUI-owned shells are tied to this GUI's lifetime. Model
    // tools and manually managed thread processes keep their Core lifetime.
    const ownedStart = name === 'manage' && request.operation === 'processStart' && request.guiOwned === true;
    const ownedRecovery = name === 'manage' && request.operation === 'processSubmission' && request.guiOwned === true;
    const { guiOwned, ...params } = request;
    // 队列业务键跨 GUI/共享服务连接保留，外层丢失响应后也能只读核对。
    const semantics = commandSemantics(name, params);
    if (semantics.requestId) params[semantics.requestId] ??= randomUUID();
    const sideCreate = name === 'side' && params.operation === 'create';
    if (sideCreate && this.guiWindowClosed) throw Object.assign(new Error('窗口正在关闭，请重新打开后创建 Side Chat'), { code: 'WINDOW_CLOSED' });
    if (sideCreate && !this.guiSideChats.has(params.requestId)) this.guiSideChats.set(params.requestId, {
      projectId: params.projectId, sourceThreadId: params.sourceThreadId, requestId: params.requestId,
    });
    const sideOwner = name === 'side' ? this.guiSideChats.get(params.requestId)
      ?? [...this.guiSideChats.values()].find(entry => entry.projectId === params.projectId && entry.threadId === params.threadId) : undefined;
    if (sideOwner && params.operation === 'close') sideOwner.closeRequestId ??= params.requestId;
    if (['send', 'steer', 'editMessage'].includes(name) || name === 'side' && request.operation === 'send') {
      const project = this.saved.find(project => project.id === request.projectId);
      if (project) await this.genUiState.list(this.genUiScope(project, request.threadId));
    }
    const pending = this.connection.request('command', { name, request: name === 'media' ? encodeMedia(params) : params }, semantics.effect === 'mutation').then(value => {
      if (sideOwner && (sideCreate || params.operation === 'recover' && value.confirmed)) sideOwner.threadId = value.threadId;
      if (sideOwner && params.operation === 'close' && value.requestId) sideOwner.closeRequestId = value.requestId;
      if (sideOwner && (params.operation === 'close' || params.method === 'areal/side/close') && value.cleanupConfirmed === true)
        this.guiSideChats.delete(sideOwner.requestId);
      if (ownedRecovery && value.confirmed) {
        this.guiTerminals.set(value.result.id, { projectId: request.projectId, threadId: request.threadId, id: value.result.id });
      }
      if (ownedStart) this.guiTerminals.set(value.id, { projectId: request.projectId, threadId: request.threadId, id: value.id });
      if (name === 'manage' && request.operation === 'processTerminate') this.guiTerminals.delete(request.id);
      return name === 'media' ? decodeMedia(value) : value;
    });
    if (ownedStart || ownedRecovery) this.guiTerminalStarts.add(pending);
    if (sideCreate || sideOwner && params.operation === 'recover') this.guiSideStarts.add(pending);
    try { return await pending; }
    catch (error) {
      const rejected = error.outcome ? ['noMutation', 'rejected'].includes(error.outcome.kind)
        : typeof error.code === 'number' && error.code !== -32603;
      if (sideCreate && rejected) this.guiSideChats.delete(params.requestId);
      if (sideOwner && params.operation === 'close' && rejected && sideOwner.closeRequestId === params.requestId) delete sideOwner.closeRequestId;
      if (semantics.requestId) error.requestId ??= params[semantics.requestId]; throw error;
    }
    finally { this.guiTerminalStarts.delete(pending); this.guiSideStarts.delete(pending); }
  }
  async closeWindowSideChats() {
    this.guiWindowClosed = true;
    if (this.guiSideClosing) return this.guiSideClosing;
    this.guiSideClosing = (async () => {
      await Promise.allSettled([...this.guiSideStarts]);
      const failures = [];
      for (const entry of [...this.guiSideChats.values()]) {
        try {
          if (!entry.threadId) {
            const original = await this.command('side', { operation: 'recover', method: 'areal/side/create',
              projectId: entry.projectId, sourceThreadId: entry.sourceThreadId, requestId: entry.requestId });
            if (!original.confirmed) throw new Error('Side Chat 创建结果待核对；原请求不会重发');
            entry.threadId = original.threadId;
          }
          const result = entry.closeRequestId
            ? await this.command('side', { operation: 'recover', method: 'areal/side/close',
              projectId: entry.projectId, threadId: entry.threadId, requestId: entry.closeRequestId })
            : await this.command('side', { operation: 'close', projectId: entry.projectId,
              threadId: entry.threadId, requestId: randomUUID() });
          if (result.cleanupConfirmed !== true) throw new Error('Side Chat 已停止受理，资源清理仍待核对；原请求不会重发');
          this.guiSideChats.delete(entry.requestId);
        } catch (error) { failures.push(error); }
      }
      if (failures.length) throw failures[0];
    })();
    try { await this.guiSideClosing; } finally { this.guiSideClosing = null; }
  }
  async resources(request) {
    if (request.operation !== 'inspect') this.assertApplicationWrite();
    if (!this.status.connected) throw new Error('后台尚未连接，请点击“重新连接后台”检查并恢复旧服务');
    return this.connection.request('resources', request, request.operation !== 'inspect');
  }
  async remoteControl(request) {
    if (request.operation !== 'status') this.assertApplicationWrite();
    if (!this.status.connected) throw new Error('后台尚未连接');
    return this.connection.request('remoteControl', request, request.operation !== 'status');
  }
  async serviceStatus() {
    if (!this.status.connected) throw new Error('后台尚未连接');
    const connection = this.connection;
    const projects = await this.resources({ operation: 'inspect', includeTasks: true });
    const { service, snapshot } = await connection.request('snapshot');
    if (connection !== this.connection || !this.status.connected) throw new Error('后台连接已变化，请刷新状态');
    // Only public lifecycle observations cross the renderer boundary, never the
    // service descriptor, authentication token or resource command arguments.
    const { recoveryView } = require('./lifecycle.cjs');
    const visibleProjects = projects.map(({ serviceId, generation, lifecycle, ...project }) => project);
    return { canStop: recoveryView(service, projects).ifIdle, connected: service.connected, clients: service.clients, busy: service.busy,
      activeCommands: service.activeCommands, starting: service.starting, providerUpdating: service.providerUpdating,
      projects: snapshot.projects.map(project => ({ projectId: project.id, root: project.root,
        started: projects.some(item => item.projectId === project.id),
        ...visibleProjects.find(item => item.projectId === project.id),
      })),
    };
  }
  get serviceExited() { return !!this.exitConfirmation && this.exitConfirmation === this.metadata; }
  async observeLifecycle(forUpdate = true, { purpose = 'manage' } = {}) {
    if (this.serviceExited) return { ifIdle: true, exited: true, blockers: [] };
    if (!this.status.connected) return { ifIdle: false, blockers: ['disconnected'] };
    const { DesktopLifecycle } = require('./lifecycle.cjs');
    return new DesktopLifecycle({ connection: this.connection, metadata: this.metadata, home: this.home, forUpdate, purpose }).observe();
  }
  lifecycleProjection() {
    const visible = new Map(this.lifecycleReceipts);
    for (const [requestId, reference] of this.lifecycleReferences) visible.set(requestId, reference);
    const operations = [...visible.values()].map(reference => {
      const receipt = this.lifecycleReceipts.get(reference.requestId);
      return { requestId: reference.requestId, kind: reference.kind,
        phase: receipt?.phase ?? 'admissionUnconfirmed',
        targets: (receipt?.targets ?? reference.targets).map(target => ({ projectId: reference.logicalProjectId ?? target.projectId,
          phase: target.phase ?? 'admissionUnconfirmed', ...(target.error ? { message: typeof target.error === 'string' ? target.error : target.error.message } : {}) })),
        ...(reference.threadId ? { threadId: reference.threadId, turnId: reference.turnId } : {}),
        ...(receipt?.desktopExit ? { desktopExit: receipt.desktopExit } : {}),
        message: receipt?.message ?? receipt?.desktopError?.message ?? lifecycleMessage(receipt?.phase ?? 'admissionUnconfirmed') };
    });
    const latest = operations.at(-1);
    const legacy = this.legacyControl || this.status.stopReport && this.status.lifecycle?.version !== 2;
    return { supported: this.status.lifecycle?.version === 2, operations,
      ...(this.foreignOwner ? { recovery: { canRecover: true, projects: [], message: '原后台属于旧应用会话。请检查并安全迁移。' } } : {}),
      ...(legacy ? { recovery: this.legacyRecoveryView ?? { canRecover: false, projects: [], message: '请检查原后台状态，再恢复工作。' } } : {}),
      ...(latest ?? legacy ? latest ?? { phase: 'admissionUnconfirmed', targets: [],
        message: '旧停止记录缺少操作身份，已恢复观察连接。请检查原后台状态；不会重发旧操作。' } : {}),
      ...(this.lifecycleError ? { error: this.lifecycleError, message: this.lifecycleError } : {}) };
  }
  reportLifecycleError(error) {
    this.lifecycleError = error.message;
    this.onChange();
  }
  async persistReferences() {
    const write = async () => {
      await mkdir(this.app.getPath('userData'), { recursive: true, mode: 0o700 });
      if (!this.lifecycleReferences.size) { await rm(this.controlPath, { force: true }); return; }
      const temporary = `${this.controlPath}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify({ version: 2, home: this.home,
          references: [...this.lifecycleReferences.values()] })); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, this.controlPath);
        if (process.platform !== 'win32') {
          const directory = await open(this.app.getPath('userData'), 'r');
          try { await directory.sync(); } finally { await directory.close(); }
        }
      } finally { await rm(temporary, { force: true }); }
    };
    const pending = (this.referenceWrite ?? Promise.resolve()).catch(() => {}).then(write);
    this.referenceWrite = pending;
    return pending;
  }
  loadReferences(control) {
    if (control?.version === 2) {
      if (!Array.isArray(control.references) || control.references.some(reference =>
        !uuid(reference?.requestId) || !uuid(reference.desktopGeneration) || !Array.isArray(reference.targets)
        || !['stopDesktop', 'updateDesktop', 'stopProject', 'updateProject', 'interruptTurn'].includes(reference.kind)
        || !Number.isSafeInteger(reference.desktop?.pid) || reference.desktop.pid <= 1))
        throw Object.assign(new Error('后台操作引用损坏，请保留记录并检查原后台'), { code: 'LIFECYCLE_REFERENCE_INVALID' });
      for (const reference of control.references) this.lifecycleReferences.set(reference.requestId, reference);
      this.controlState = null;
    } else if (control?.state === 'unconfirmed') {
      this.legacyControl = control; this.controlState = null;
    } else this.controlState = control?.state ?? null;
  }
  async readLifecycle(reference, reconcile = true) {
    let receipt;
    if (this.status.connected && this.status.lifecycle?.version === 2) {
      try {
        receipt = await this.connection.request(reconcile ? 'lifecycleReconcile' : 'lifecycleRead',
          { protocol: PROTOCOL, requestId: reference.requestId });
      } catch (error) {
        if (error.code !== 'DISCONNECTED' && error.code !== 'LIFECYCLE_UNSUPPORTED') throw error;
      }
    }
    if (!receipt) {
      const { readLifecycleReceipt, reconcileLifecycleReceipt } = require('./lifecycle-operations.cjs');
      const identity = { requestId: reference.requestId, desktopGeneration: reference.desktopGeneration };
      receipt = this.options.binary && this.options.harnessHome
        ? await reconcileLifecycleReceipt(this.home, { ...identity, binary: this.options.binary, harnessHome: this.options.harnessHome })
        : await readLifecycleReceipt(this.home, identity);
    }
    if (!receipt) receipt = { version: 1, requestId: reference.requestId, kind: reference.kind, mode: reference.mode,
      desktopGeneration: reference.desktopGeneration, desktopExit: 'notRequested',
      ...(reference.threadId ? { threadId: reference.threadId, turnId: reference.turnId } : {}),
      phase: 'admissionUnconfirmed', targets: reference.targets.map(target => ({ ...target, phase: 'admissionUnconfirmed' })) };
    return this.acceptLifecycleReceipt(reference, receipt);
  }
  async acceptLifecycleReceipt(reference, receipt) {
    if (receipt?.version !== 1 || receipt.requestId !== reference.requestId || receipt.desktopGeneration !== reference.desktopGeneration
      || receipt.kind !== reference.kind || receipt.mode !== reference.mode || !Array.isArray(receipt.targets)
      || !['acceptedPending', 'blocked', 'partial', 'admissionUnconfirmed', 'settlementIncomplete', 'completed'].includes(receipt.phase)
      || !['notRequested', 'requested'].includes(receipt.desktopExit)
      || receipt.phase === 'completed' && receipt.targets.some(target => target.phase !== 'completed')
      || receipt.targets.some(target => !target || typeof target.projectId !== 'string' || typeof target.serviceId !== 'string'
        || typeof target.generation !== 'string' || !['notAttempted', 'acceptedPending', 'blocked', 'admissionUnconfirmed', 'settlementIncomplete', 'completed'].includes(target.phase))
      || !require('node:util').isDeepStrictEqual(require('./lifecycle.cjs').targets(receipt.targets), reference.targets)
      || reference.kind === 'interruptTurn' && (receipt.threadId !== reference.threadId || receipt.turnId !== reference.turnId))
      throw Object.assign(new Error('后台回执与原操作身份不一致'), { code: 'LIFECYCLE_RECEIPT_INVALID', submissionUnknown: true });
    let operation = desktopKind(reference.kind) && receipt.phase === 'completed' ? { ...receipt, phase: 'acceptedPending' } : receipt;
    if (desktopKind(reference.kind) && ['acceptedPending', 'settlementIncomplete', 'completed'].includes(receipt.phase)
      && receipt.targets.every(target => target.phase === 'completed')) {
      let exited = false;
      try { process.kill(reference.desktop.pid, 0); }
      catch (error) { if (error.code === 'ESRCH') exited = true; else throw error; }
      if (!exited && receipt.desktopExit === 'requested') {
        try { await waitForProcessExit(reference.desktop.pid); exited = true; }
        catch (error) { operation = { ...receipt, phase: 'acceptedPending', message: error.message }; }
      }
      if (exited) {
        operation = { ...receipt, phase: 'completed' };
        this.exitConfirmation = this.metadata?.desktopGeneration === reference.desktopGeneration ? this.metadata : reference.desktop;
        if (this.metadata?.desktopGeneration === reference.desktopGeneration || !this.status.connected) {
          this.reconnectBlocked = true; this.clearReconnect();
        }
        // 完整停止回执和进程退出共同证明旧终端已清理，不能依赖连接是否先断开。
        if (this.metadata?.desktopGeneration === reference.desktopGeneration) {
          this.guiTerminals.clear();
          if (this.status.connected) {
            const connection = this.connection;
            this.stoppedConnection = connection; this.disconnected(); this.connection = null; connection.close();
          }
        }
      }
    }
    if (reference.logicalProjectId) operation = { ...operation, logicalProjectId: reference.logicalProjectId };
    this.lifecycleReceipts.set(reference.requestId, operation);
    if (operation.phase === 'blocked' || operation.phase === 'completed' && !desktopKind(reference.kind)) {
      this.lifecycleReferences.delete(reference.requestId); await this.persistReferences();
    }
    this.lifecycleError = null; this.onChange();
    return operation;
  }
  assertMigrationProfile(source = this.foreignOwner) {
    if (source?.applicationOwner?.profile && source.applicationOwner.profile !== this.applicationOwner.profile)
      throw Object.assign(new Error(`原后台属于另一配置目录，请从 ${source.applicationOwner.profile} 退出原应用。`), { code: 'APPLICATION_OWNER_MISMATCH' });
  }
  assertApplicationWrite(migration) {
    if (!this.foreignOwner) return;
    this.assertMigrationProfile();
    if (migration !== this.foreignOwner || migration !== this.metadata)
      throw Object.assign(new Error('原后台仅供观察，请通过安全迁移入口处理原应用会话'), { code: 'APPLICATION_OWNER_MISMATCH' });
  }
  async recoverForeignOwner(notify) {
    const source = this.foreignOwner;
    this.assertMigrationProfile(source);
    const answer = await notify({ type: 'warning', message: '安全停止旧应用会话并迁移？',
      detail: '原后台没有被本次应用接管。将核对原代际、任务和清理回执，停止成功后才启动本次应用的后台。未知操作不会重发。',
      buttons: ['返回应用', '检查并迁移'], defaultId: 0, cancelId: 0, noLink: true });
    if (answer.response !== 1) return { canceled: true };
    const result = await require('./startup-recovery.cjs').recoverConnectedService({ backend: this, notify, purpose: 'stop', migration: source });
    if (!result.stopped) return result;
    this.foreignOwner = null;
    this.lifecycleReferences.clear(); this.lifecycleReceipts.clear(); await this.persistReferences();
    this.connection?.close(); this.connection = null;
    await this.initialize(false);
    this.controlState = null; this.reconnectBlocked = false;
    return { recovered: true };
  }
  async recoverBackend({ notify }) {
    this.assertMigrationProfile();
    if (this.recoveryInFlight) return this.recoveryInFlight;
    this.recoveryInFlight = (async () => {
      await this.checkLifecycle();
      if (this.foreignOwner && this.status.lifecycle?.version === 2) return this.recoverForeignOwner(notify);
      if (this.legacyControl || this.status.stopReport && this.status.lifecycle?.version !== 2)
        return require('./legacy-desktop-recovery.cjs').recover(this, notify);
      const pending = [...this.lifecycleReferences.values()];
      if (!pending.length) return { recovered: false };
      if (pending.some(reference => needsOriginalCheck(this.lifecycleReceipts.get(reference.requestId) ?? { phase: 'admissionUnconfirmed', targets: [] })))
        throw new Error('原后台操作仍待确认，请继续检查原请求；不会重发');
      const completedStop = pending.length && pending.every(reference => reference.kind === 'stopDesktop' && this.lifecycleReceipts.get(reference.requestId)?.phase === 'completed');
      if (completedStop) { await this.init(); return { recovered: true }; }
      // Other current-protocol operations retain their explicit stop/update
      // actions. A resource inspection must not introduce a new update intent.
      return { recovered: false, lifecycle: this.lifecycleProjection() };
    })().finally(() => { this.recoveryInFlight = null; });
    return this.recoveryInFlight;
  }
  async checkLifecycle() {
    this.loadReferences(await this.readControl());
    this.clearReconnect();
    if (!this.status.connected) await this.attach();
    for (const reference of [...this.lifecycleReferences.values()]) await this.readLifecycle(reference);
    if (this.legacyControl || this.status.stopReport && this.status.lifecycle?.version !== 2) {
      try { await require('./legacy-desktop-recovery.cjs').inspect(this); }
      catch (error) { this.legacyRecoveryView = { canRecover: false, projects: [], message: error.message }; }
    }
    this.lifecycleError = null; this.onChange();
    return this.lifecycleProjection();
  }
  assertLifecycleScope(name, request) {
    if (this.foreignOwner)
      throw Object.assign(new Error('原后台属于旧应用会话，请先检查并安全迁移'), { code: 'APPLICATION_OWNER_MISMATCH' });
    if (['list', 'open', 'reconcile', 'queue'].includes(name) || require('./lifecycle.cjs').isRecoveryCommand(name, request)) return;
    if ((this.legacyControl?.legacyRecovery || this.status.stopReport) && this.status.lifecycle?.version !== 2)
      throw Object.assign(new Error('请先检查并恢复原后台，再继续工作。输入和历史已保留。'), { code: 'LIFECYCLE_INCOMPLETE' });
    for (const reference of this.lifecycleReferences.values()) {
      const operation = this.lifecycleReceipts.get(reference.requestId);
      if (['blocked', 'completed'].includes(operation?.phase)) continue;
      if (reference.kind === 'interruptTurn' && reference.threadId !== request.threadId) continue;
      const target = (operation?.targets ?? reference.targets).find(target => target.projectId === request.projectId || reference.logicalProjectId === request.projectId);
      if (target && !['blocked', 'completed'].includes(target.phase)) throw Object.assign(
        new Error('此任务的原后台操作尚未结算，请检查原请求'), { code: 'LIFECYCLE_INCOMPLETE', requestId: reference.requestId });
    }
  }
  async requestLifecycle({ kind, mode = 'ifIdle', observed, projectId, threadId, turnId, requestId = randomUUID(), migration }) {
    this.assertApplicationWrite(migration);
    if (!this.status.connected) throw new Error('后台尚未连接，请先重新连接后台');
    const previous = this.lifecycleReferences.get(requestId) ?? this.lifecycleReceipts.get(requestId);
    if (previous) {
      if (previous.kind !== kind || previous.mode !== mode || previous.threadId !== threadId || previous.turnId !== turnId
        || projectId && (previous.logicalProjectId ? previous.logicalProjectId !== projectId : !previous.targets.some(target => target.projectId === projectId)))
        throw Object.assign(new Error('原请求身份不能绑定其他操作或轮次'), { code: 'LIFECYCLE_REQUEST_CONFLICT' });
      const operation = this.lifecycleReferences.has(requestId) ? await this.readLifecycle(previous) : previous;
      return { stopped: operation.phase === 'completed', operation };
    }
    if (desktopKind(kind)) {
      for (const reference of this.lifecycleReferences.values()) {
        if (!desktopKind(reference.kind)) continue;
        const operation = await this.readLifecycle(reference);
        if (needsOriginalCheck(operation))
          return { stopped: false, operation };
      }
    }
    const { DesktopLifecycle } = require('./lifecycle.cjs');
    const intent = await new DesktopLifecycle({ connection: this.connection, metadata: this.metadata,
      forUpdate: desktopKind(kind), purpose: kind === 'stopDesktop' && observed?.purpose === 'quit' ? 'quit' : 'manage',
    }).prepare({ kind, mode, observed, projectId, threadId, turnId });
    const reference = { requestId, kind, mode, desktopGeneration: intent.expectedDesktopGeneration,
      targets: intent.expectedTargets, desktop: { pid: this.metadata.pid, identity: this.metadata.identity },
      ...(kind === 'interruptTurn' ? { threadId, turnId, logicalProjectId: projectId } : {}) };
    this.lifecycleReferences.set(requestId, reference);
    try { await this.persistReferences(); }
    catch (error) { this.lifecycleReferences.delete(requestId); throw error; }
    this.lifecycleError = null; this.onChange();
    let operation;
    try {
      const receipt = await this.connection.request('lifecycleRequest', { protocol: PROTOCOL, requestId, ...intent }, true);
      if (!receipt) throw Object.assign(new Error('后台操作回执缺失'), { submissionUnknown: true });
      operation = await this.acceptLifecycleReceipt(reference, receipt);
    } catch (error) {
      if (!error.submissionUnknown && notAdmittedCodes.has(error.code)) {
        this.lifecycleReferences.delete(requestId); await this.persistReferences(); throw error;
      }
      operation = await this.readLifecycle(reference);
    }
    return { stopped: operation.phase === 'completed', operation,
      ...(desktopKind(kind) && operation.phase === 'completed' ? { kind: 'exited' } : {}) };
  }
  async stopService(forUpdate = false, options = {}) {
    return this.requestLifecycle({ kind: options.kind ?? (forUpdate ? 'updateDesktop' : 'stopDesktop'),
      mode: options.cancel ? 'cancel' : 'ifIdle', observed: options.observed, migration: options.migration });
  }
  async applyUpdate({ notify } = {}) {
    if (this.foreignOwner) return this.recoverForeignOwner(notify);
    try {
      const pending = [...this.lifecycleReferences.values()].find(reference => reference.kind === 'updateDesktop'
        && this.lifecycleReceipts.get(reference.requestId)?.phase !== 'blocked');
      let result;
      if (pending) {
        await this.checkLifecycle();
        const operation = this.lifecycleReceipts.get(pending.requestId);
        if (operation?.phase === 'completed' || operation && needsOriginalCheck(operation))
          result = { stopped: operation?.phase === 'completed', operation };
      }
      if (!result) {
        require('./lifecycle.cjs').assertLifecycleSupport(this.status, 'updateDesktop');
        await inspectCoreCapabilities(this.options.binary);
        this.backendUpdate = { state: 'applying' }; this.onChange();
        result = await require('./startup-recovery.cjs').recoverConnectedService({ backend: this, notify, purpose: 'update', forUpdate: true });
      }
      if (!result.stopped) { this.backendUpdate = { state: 'pending' }; this.onChange(); return result; }
      this.connection?.close(); this.connection = null; this.reconnectBlocked = true;
      this.connectionState = { state: 'connecting' }; this.onChange();
      await this.initialize(false);
      for (const [requestId, reference] of this.lifecycleReferences) {
        if (desktopKind(reference.kind) && reference.desktopGeneration === result.operation.desktopGeneration) {
          this.lifecycleReferences.delete(requestId); this.lifecycleReceipts.delete(requestId);
        }
      }
      await this.persistReferences(); this.controlState = null; this.reconnectBlocked = false;
      this.backendUpdate = undefined; this.onChange();
      return result;
    } catch (error) {
      this.backendUpdate = { state: 'failed', message: error.message }; this.reportLifecycleError(error); throw error;
    }
  }
  async settleGuiTerminals() {
    // Main has closed GUI admission, but a create or receipt lookup accepted
    // before quit can still acquire a handle. Wait for both before cleanup.
    // Keep unknown outcomes visible; never replay a create.
    const starts = await Promise.allSettled([...this.guiTerminalStarts]);
    const results = [];
    // Terminals in one Thread share its mutation journal. Parallel terminate
    // calls can reject each other as unresolved submissions during normal quit.
    // Continue checking every owned handle even when one cleanup fails.
    for (const terminal of [...this.guiTerminals.values()]) {
      try {
        if (!this.status.connected) throw new Error('后台已断开，GUI 终端清理未确认，请从后台资源入口检查');
        const call = (operation, mutation = false) => this.connection.request('command', { name: 'manage', request: { ...terminal, operation } }, mutation);
        const before = (await call('processes')).data?.find(p => p.id === terminal.id);
        if (!before) throw new Error('找不到 GUI 终端，无法确认资源清理');
        if (!before.cleanupConfirmed) {
          await call('processTerminate', true);
          if (!(await call('processes')).data?.find(p => p.id === terminal.id)?.cleanupConfirmed) throw new Error('GUI 终端资源清理尚未确认');
        }
        this.guiTerminals.delete(terminal.id);
        results.push({ status: 'fulfilled' });
      } catch (reason) { results.push({ status: 'rejected', reason }); }
    }
    const failed = [...starts, ...results].find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  async completeApplicationQuit() {
    for (const reference of this.lifecycleReferences.values()) {
      if (this.lifecycleReceipts.get(reference.requestId)?.phase !== 'completed')
        throw Object.assign(new Error('原生命周期请求尚未完成，不能结束应用会话'), { code: 'LIFECYCLE_INCOMPLETE' });
    }
    this.lifecycleReferences.clear();
    await this.persistReferences();
    this.controlState = null;
  }
  async waitForApplicationReady() {
    if (this.connecting) await this.connecting.catch(() => {});
    const deadline = Date.now() + 20000;
    while (this.status.connected) {
      const { service } = await this.connection.request('snapshot');
      if (!service.starting && !service.activeCommands) return;
      if (Date.now() >= deadline) throw Object.assign(new Error('项目启动或已受理操作仍在完成，请稍后退出'), { code: 'LIFECYCLE_BLOCKED' });
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
    return this.shutdownPromise = (async () => {
      try {
        await this.settleGuiTerminals();
        if (this.status.connected) await this.connection.request('activity', { focused: false, idleSeconds: 0 }).catch(() => {});
      } finally { this.connection?.close(); }
    })();
  }
}
module.exports = { SharedCoreBackend, ServiceConnection, waitForServiceExit, waitForServiceProcessExit, waitForProcessExit };
