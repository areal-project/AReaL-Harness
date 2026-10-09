'use strict';
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { mkdir, readFile, realpath, open, writeFile, rename, rm } = require('node:fs/promises');
const { join } = require('node:path');
const WebSocket = require('ws');
const { PROTOCOL, encodeMedia, decodeMedia } = require('./service-protocol.cjs');
const { serviceIdentity } = require('./service-config.cjs');
const { inspectCoreCapabilities } = require('./core-capabilities.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForServiceExit(home, metadata) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const current = JSON.parse(await readFile(join(home, 'service.json'), 'utf8'));
      if (current.token !== metadata.token) return;
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
  constructor(onState = () => {}, onClose = () => {}, onNotification = () => {}, onNotificationOpen = () => {}) {
    this.onNotification = onNotification;
    this.onNotificationOpen = onNotificationOpen;
    this.onState = onState; this.onClose = onClose; this.pending = new Map(); this.nextId = 0;
  }
  async connect(metadata) {
    const url = new URL(metadata.endpoint);
    if (metadata.protocol !== PROTOCOL || url.protocol !== 'ws:' || url.hostname !== '127.0.0.1'
      || url.username || url.password || !/^[a-f0-9]{64}$/.test(metadata.token)) throw new Error('本地后台服务连接元数据无效');
    const socket = this.socket = new WebSocket(url, { headers: { Authorization: `Bearer ${metadata.token}` }, followRedirects: false, maxPayload: 256 * 1024 * 1024 });
    socket.on('error', () => {});
    socket.on('message', bytes => {
      let message;
      try { message = JSON.parse(bytes.toString()); } catch { socket.terminate(); return; }
      if (message.method === 'notification') { this.onNotification(message.params); return; }
      if (message.method === 'notificationOpen') { this.onNotificationOpen(message.params); return; }
      if (message.method === 'state') { this.onState(message.params); return; }
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(Object.assign(new Error(message.error.message), message.error));
      else entry.resolve(message.result);
    });
    socket.on('close', () => {
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(Object.assign(new Error(entry.mutation ? '后台连接中断，操作结果未确认；请重连后核对任务，不会自动重发。' : '后台服务连接已断开'), { submissionUnknown: entry.mutation, code: 'DISCONNECTED' }));
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
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(Object.assign(new Error('后台服务已断开，请重新连接'), { code: 'DISCONNECTED' }));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error('后台请求超时，请核对结果后继续；不会自动重发。'), { submissionUnknown: mutation }));
      }, 150000);
      this.pending.set(id, { resolve, reject, timer, mutation });
      this.socket.send(JSON.stringify({ id, method, params }), error => { if (error) this.socket.terminate(); });
    });
  }
  close() { this.socket?.close(); }
}

// GUI-local connection/projection only. Control intent lives in GUI userData;
// shared Core history and execution state remain owned by the service.
class SharedCoreBackend {
  constructor({ app, onChange = () => {}, onNotification, onNotificationOpen, recoverIncompatible, ...options }) {
    this.onNotification = onNotification;
    this.onNotificationOpen = onNotificationOpen;
    this.recoverIncompatible = recoverIncompatible; this.app = app; this.options = options; this.home = options.home; this.onChange = onChange;
    this.value = { library: { projects: {}, threads: {}, projectOrder: [], settings: {} }, projects: [] };
    this.status = { connected: false }; this.sequence = -1;
    this.connectionState = { state: 'connecting' }; this.revision = 0;
    this.guiTerminals = new Map(); this.guiTerminalStarts = new Set();
    this.analytics = { sample: sample => { this.lastActivity = sample; if (this.status.connected) void this.connection.request('activity', sample).catch(() => {}); }, flush: async () => {} };
  }
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
  snapshot() { return { ...this.value, revision: ++this.revision, connection: this.connectionState }; }
  accept(packet) {
    if (!packet || packet.sequence <= this.sequence) return;
    this.sequence = packet.sequence; this.value = packet.snapshot; this.status = packet.service; this.connectionState = { state: 'ready' }; this.onChange();
  }
  disconnected() {
    const stopped = !!this.connection && this.stoppedConnection === this.connection;
    const message = stopped ? '后台服务已停止，可按需重新连接' : this.controlState === 'unconfirmed' ? '停止结果未确认，请显式连接后核查后台状态；不会自动重发。' : '后台服务已断开，请重新连接';
    this.connectionState = { state: 'unavailable', message };
    this.status = { ...this.status, connected: false };
    this.value = { ...this.value, projects: this.value.projects.map(p => ({ ...p, error: stopped ? null : message, state: p.state ? { ...p.state, connected: false, error: stopped ? null : message } : null })) };
    this.onChange();
  }
  async attach() {
    let metadata;
    try { metadata = JSON.parse(await readFile(join(this.home, 'service.json'), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return false; throw e; }
    const connection = new ServiceConnection(packet => { if (this.connection === connection) this.accept(packet); }, () => { if (this.connection === connection) this.disconnected(); }, notice => { if (this.connection === connection) this.onNotification?.(notice); }, target => { if (this.connection === connection) this.onNotificationOpen?.(target); });
    try { await connection.connect(metadata); }
    catch (e) { connection.close(); if (e.code === 'DISCONNECTED') return false; throw e; }
    if (this.disposed) { connection.close(); throw new Error('GUI 连接已关闭'); }
    this.connection?.close(); this.connection = connection; this.sequence = -1;
    try {
      const deadline = Date.now() + 60000;
      for (;;) {
        try { this.accept(await connection.request('hello', { protocol: PROTOCOL, identity: this.identity, notifications: !!this.onNotification })); break; }
        catch (error) {
          if (error.code !== 'SERVICE_STOPPING') throw error;
          // Safety inspection can cancel retirement. Retry only the read-only
          // handshake: attach if retained, rediscover when the old socket closes.
          if (this.disposed || Date.now() >= deadline) throw new Error('后台尚未完成退出检查，请稍后重新连接');
          await sleep(100);
        }
      }
    }
    catch (e) {
      this.connection = null;
      connection.close();
      if (e.code === 'DISCONNECTED') return false; // Only a read-only handshake was attempted.
      // 旧 v1 服务没有错误码，只兼容其明确的身份不匹配消息。
      const incompatible = e.code === 'SERVICE_INCOMPATIBLE' || e.message.startsWith('后台服务版本或启动配置不兼容。');
      if (!incompatible || !this.recoverIncompatible) throw e;
      await this.recoverIncompatible(metadata, this.home);
      return false;
    }
    if (this.lastActivity) void connection.request('activity', this.lastActivity).catch(() => {});
    this.metadata = metadata;
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
    if (this.status.connected) return;
    if (automatic) {
      try {
        const control = await this.readControl();
        if (control) {
          this.controlState = control.state;
          this.connectionState = { state: 'unavailable', message: control.state === 'stopped' ? '后台服务已停止，可按需重新连接' : '停止结果未确认，请显式连接后核查后台状态；不会自动重发。' };
          this.onChange();
          return;
        }
      } catch (error) {
        this.connectionState = { state: 'unavailable', message: `后台启动状态读取失败，请显式连接后核查。${error.message}` };
        this.onChange(); throw error;
      }
    }
    if (this.connecting) return this.connecting;
    this.connectionState = { state: 'connecting' };
    this.connecting = this.initialize().then(async () => { await rm(this.controlPath, { force: true }); this.controlState = null; }).catch(error => {
      this.connectionState = { state: 'unavailable', message: error.message };
      this.onChange(); throw error;
    }).finally(() => { this.connecting = null; });
    this.onChange();
    return this.connecting;
  }
  async initialize() {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    this.home = await realpath(this.home); this.identity = await serviceIdentity(this.options);
    if (this.disposed) throw new Error('GUI 连接已关闭');
    if (await this.attach()) return;
    if (this.disposed) throw new Error('GUI 连接已关闭');
    // Explain a known binary incompatibility through this connection attempt's
    // error channel; never expose shared or stale service log contents to GUI.
    inspectCoreCapabilities(this.options.binary);
    const log = await open(join(this.home, 'service.log'), 'a', 0o600);
    const env = { ...process.env, AREAL_BACKEND: 'areal', AREAL_CORE_HOME: this.home };
    delete env.ELECTRON_RUN_AS_NODE;
    const args = this.app.isPackaged ? ['--areal-core-service'] : [this.app.getAppPath(), '--areal-core-service'];
    try {
      let launchError, retryLaunch = false;
      const launch = () => {
        if (this.disposed) throw new Error('GUI 连接已关闭');
        retryLaunch = false;
        const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log.fd, log.fd], env, windowsHide: true });
        child.once('error', e => { launchError = e; });
        child.once('exit', code => { retryLaunch = code === 0; }); child.unref();
      };
      launch();
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        if (this.disposed) throw new Error('GUI 连接已关闭');
        if (launchError) throw launchError;
        if (await this.attach()) return;
        if (retryLaunch) launch();
        await sleep(100);
      }
      throw new Error(`后台服务未就绪；请检查 ${join(this.home, 'service.log')}`);
    } finally { await log.close(); }
  }
  async addProject(path) { await this.init(); return this.connection.request('addProject', { path }, true); }
  async command(name, request) {
    if (this.disposed) throw new Error('GUI 连接已关闭');
    // Only explicit reconnect opens a stopped service. Periodic panel reads must
    // not undo the user's stop action; in-flight commands are never replayed.
    if (name === 'connect') await this.init();
    if (!this.status.connected) throw new Error('后台尚未连接，请先处理后台连接提示');
    // Only explicitly GUI-owned shells are tied to this GUI's lifetime. Model
    // tools and manually managed thread processes keep their Core lifetime.
    const ownedStart = name === 'manage' && request.operation === 'processStart' && request.guiOwned === true;
    const ownedRecovery = name === 'manage' && request.operation === 'processSubmission' && request.guiOwned === true;
    const { guiOwned, ...params } = request;
    // 队列业务键跨 GUI/共享服务连接保留，外层丢失响应后也能只读核对。
    if (name === 'queueEdit') params.requestId ??= randomUUID();
    const pending = this.connection.request('command', { name, request: name === 'media' ? encodeMedia(params) : params }, true).then(value => {
      if (ownedRecovery && value.confirmed) {
        this.guiTerminals.set(value.result.id, { projectId: request.projectId, threadId: request.threadId, id: value.result.id });
      }
      if (ownedStart) this.guiTerminals.set(value.id, { projectId: request.projectId, threadId: request.threadId, id: value.id });
      if (name === 'manage' && request.operation === 'processTerminate') this.guiTerminals.delete(request.id);
      return name === 'media' ? decodeMedia(value) : value;
    });
    if (ownedStart || ownedRecovery) this.guiTerminalStarts.add(pending);
    try { return await pending; }
    catch (error) { if (name === 'queueEdit' && error.submissionUnknown) error.requestId = params.requestId; throw error; }
    finally { this.guiTerminalStarts.delete(pending); }
  }
  async resources(request) {
    if (!this.status.connected) throw new Error('后台尚未连接，请点击“重新连接后台”检查并恢复旧服务');
    return this.connection.request('resources', request, request.operation !== 'inspect');
  }
  async remoteControl(request) {
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
    return { connected: service.connected, clients: service.clients, busy: service.busy,
      activeCommands: service.activeCommands, starting: service.starting, providerUpdating: service.providerUpdating,
      projects: snapshot.projects.map(project => ({ projectId: project.id, root: project.root,
        started: projects.some(item => item.projectId === project.id),
        ...projects.find(item => item.projectId === project.id),
      })),
    };
  }
  async stopService(forUpdate = false) {
    if (!this.status.connected) throw new Error('后台尚未连接，请先重新连接后台');
    const metadata = this.metadata, connection = this.connection;
    // Persist intent before the write: a missing response or GUI restart must
    // never turn this user control into an implicit start or repeated stop.
    if (!forUpdate) await this.saveControl('unconfirmed');
    let accepted = false;
    try {
      const result = await connection.request('stopService', { protocol: PROTOCOL, forUpdate }, true);
      if (result?.stopped !== true) throw Object.assign(new Error('停止结果未确认，请核查后台状态；不会自动重发。'), { submissionUnknown: true });
      accepted = true;
      this.guiTerminals.clear(); // Safe service shutdown has already settled all resources.
      if (metadata) await waitForServiceProcessExit(this.home, metadata);
      if (!forUpdate) await this.saveControl('stopped');
      if (this.connection === connection) { this.stoppedConnection = connection; this.disconnected(); }
      return result;
    } catch (error) {
      if (!forUpdate && !accepted && !error.submissionUnknown) {
        await rm(this.controlPath, { force: true }); this.controlState = null;
      }
      throw error;
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
  async prepareQuit() {
    await this.settleGuiTerminals();
  }
  async shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.disposed = true;
    return this.shutdownPromise = (async () => {
      try {
        await this.settleGuiTerminals();
        if (this.status.connected) await this.connection.request('activity', { focused: false, idleSeconds: 0 }).catch(() => {});
      } finally { this.connection?.close(); }
    })();
  }
}
module.exports = { SharedCoreBackend, ServiceConnection, waitForServiceExit };
