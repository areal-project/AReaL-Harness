'use strict';
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { WebSocketServer } = require('ws');
const { validateCommand: validateDesktopCommand, desktopError } = require('@areal/workbench/desktop-contract');
const { inspectResources, recoverResource, summary, blocked } = require('./resource-recovery.cjs');
const PROTOCOL = 'areal.desktop-service.v1';
function validateCommand(name, params) {
  validateDesktopCommand(name, params, { serviceOnly: true });
}

// Media is the only binary value in the desktop contract. Keep the existing
// Uint8Array IPC API; use bounded base64 only across the service JSON transport.
function encodeMedia(value) {
  if (value?.bytes === undefined) return value;
  if (!(value.bytes instanceof Uint8Array) || value.bytes.length > 16 * 1024 * 1024) throw new Error('附件必须为 1 B–16 MiB');
  return { ...value, bytes: Buffer.from(value.bytes).toString('base64') };
}
function decodeMedia(value) {
  if (value?.bytes === undefined) return value;
  if (typeof value.bytes !== 'string' || value.bytes.length > 22369624) throw new Error('无效附件编码');
  const bytes = Buffer.from(value.bytes, 'base64');
  if (bytes.length > 16 * 1024 * 1024 || bytes.toString('base64') !== value.bytes) throw new Error('无效附件编码');
  return { ...value, bytes: new Uint8Array(bytes) };
}

// One writer for provider secrets, recovery journals and projections. Core remains
// authoritative for execution. No generic RPC passthrough or renderer credentials.
class DesktopService {
  constructor(backend, identity, onStop = () => {}, backgroundNotifications, power) {
    this.backend = backend; this.identity = identity; this.onStop = onStop;
    this.backgroundNotifications = backgroundNotifications; this.power = power;
    this.pendingNotificationTarget = null;
    this.token = randomBytes(32).toString('hex'); this.clients = new Set();
    this.sequence = 0; this.inflight = 0; this.stopping = false;
    this.idleSince = Date.now(); this.closed = false;
    backend.onChange = () => this.schedule();
    backend.onNotification = notice => this.notify(notice);
  }
  packet() {
    return { sequence: ++this.sequence, snapshot: this.backend.snapshot(), service: {
      connected: true, clients: this.clients.size, busy: this.backend.hasWork({ includePausedQueues: false }),
      activeCommands: this.inflight, providerUpdating: !!this.backend.providerUpdating,
      starting: this.backend.starting.size, pid: process.pid,
    } };
  }
  send(socket, value) {
    if (socket.readyState !== 1) return;
    if (socket.bufferedAmount > 32 * 1024 * 1024) { socket.terminate(); return; }
    socket.send(JSON.stringify(value));
  }
  schedule() {
    void this.power?.refresh();
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.publish(); }, 20);
  }
  publish() {
    const state = this.packet();
    for (const socket of this.clients) this.send(socket, { method: 'state', params: state });
    this.remote?.publish();
  }
  notify(notice) {
    const settings = this.backend.library.value.settings;
    const clients = [...this.clients].filter(s => s.notifications && s.readyState === 1);
    if (notice.kind === 'completion') {
      const policy = settings.turnNotifications ?? 'unfocused';
      if (policy === 'never') return;
      if (policy === 'unfocused' && clients.some(s => !s.activity || Date.now() - s.activity.time > 15000 || s.activity.windowFocused)) return;
    } else if (notice.kind === 'approval' && settings.permissionNotifications === false) return;
    else if (notice.kind === 'question' && settings.questionNotifications === false) return;
    // Most recently focused GUI owns delivery. Do not broadcast or replay if a
    // recipient disconnects: delivery is best-effort, never an execution receipt.
    clients.sort((a, b) => (b.lastFocused ?? 0) - (a.lastFocused ?? 0));
    const delivery = { ...notice, silent: settings.notificationSound === 'silent' };
    if (clients.length) this.send(clients[0], { method: 'notification', params: delivery });
    else this.backgroundNotifications?.show(delivery, target => this.openNotification(target));
  }
  openNotification(target) {
    const clients = [...this.clients].filter(s => s.notifications && s.readyState === 1)
      .sort((a, b) => (b.lastFocused ?? 0) - (a.lastFocused ?? 0));
    if (clients.length) { this.send(clients[0], { method: 'notificationOpen', params: target }); return; }
    // This is a user click, not a new execution request. Pass only navigation
    // identity over the authenticated connection when the GUI attaches.
    this.pendingNotificationTarget = target;
    try { this.backgroundNotifications?.launch(); }
    catch (error) { console.warn(this.backend.providers.redact(`通知打开界面失败：${error.message}`)); }
  }
  async listen() {
    this.server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 256 * 1024 * 1024,
      verifyClient: ({ req }) => {
        const actual = Buffer.from(req.headers.authorization ?? '');
        const expected = Buffer.from(`Bearer ${this.token}`);
        return !req.headers.origin && actual.length === expected.length && timingSafeEqual(actual, expected);
      } });
    this.server.on('connection', socket => {
      socket.on('error', () => {});
      socket.on('message', bytes => { void this.receive(socket, bytes); });
      socket.on('close', () => {
        this.sampleActivity();
        if (this.clients.delete(socket) && !this.clients.size) this.idleSince = Date.now();
        this.sampleActivity(); this.schedule();
      });
    });
    await new Promise((resolve, reject) => { this.server.once('listening', resolve); this.server.once('error', reject); });
    this.activityTimer = setInterval(() => { this.sampleActivity(); }, 5000);
    this.flushTimer = setInterval(() => { void this.backend.analytics.flush(); }, 30000);
    return { protocol: PROTOCOL, endpoint: `ws://127.0.0.1:${this.server.address().port}`, token: this.token, identity: this.identity, pid: process.pid };
  }
  sampleActivity() {
    const now = Date.now();
    const active = [...this.clients].some(s => s.activity && now - s.activity.time <= 15000 && s.activity.focused);
    // Count the union of active GUI intervals, never one duration per client.
    this.backend.analytics.sample({ time: now, focused: active });
  }
  async stop() {
    if (this.stopping || this.inflight || this.backend.hasWork({ includePausedQueues: false }) || this.backend.providerUpdating || this.backend.starting.size) throw new Error('后台仍有任务、可执行的排队消息或操作，完成或暂停队列后重试');
    this.stopping = true; // Block new admissions before asynchronous status checks.
    try {
      const projects = await inspectResources(this.backend);
      if (projects.some(p => !p.restartSafe)) throw blocked('Core 仍有活动任务或终端。请打开“检查后台资源…”处理。\n' + summary(projects));
      await this.backend.shutdown({ requireSafe: true });
      await this.backend.library?.writes;
      await Promise.all(this.backend.saves?.values() ?? []);
    } catch (error) { this.stopping = false; throw error; }
  }
  async receive(socket, bytes) {
    let message;
    try { message = JSON.parse(bytes.toString()); } catch { socket.close(1008); return; }
    const { id, method, params } = message ?? {};
    if (!Number.isSafeInteger(id) || typeof method !== 'string') { socket.close(1008); return; }
    try {
      if (this.stopping) throw Object.assign(new Error('后台服务正在停止'), { code: 'SERVICE_STOPPING' });
      if (this.recovering) throw blocked('正在处理后台资源，请稍后重试');
      if (method === 'hello') {
        if (params?.protocol !== PROTOCOL || params?.identity !== this.identity) throw Object.assign(new Error('后台服务版本或启动配置不兼容。请先安全停止旧后台服务。'), { code: 'SERVICE_INCOMPATIBLE' });
        socket.notifications = params.notifications === true;
        this.clients.add(socket);
        this.idleSince = null;
        this.send(socket, { id, result: this.packet() });
        if (socket.notifications && this.pendingNotificationTarget) {
          this.send(socket, { method: 'notificationOpen', params: this.pendingNotificationTarget });
          this.pendingNotificationTarget = null;
        }
        this.schedule(); return;
      }
      // Explicit local stop also works after a source upgrade, without attaching
      // an incompatible GUI. Possession of the private token is still mandatory.
      if (method === 'stopService') {
        if (params?.protocol !== PROTOCOL) throw new Error('后台服务协议不兼容');
        if (params?.forUpdate && this.clients.size > 1) throw new Error('请先退出其他连接此后台服务的 GUI，再停止后台或安装更新');
        await this.stop(); this.send(socket, { id, result: { stopped: true } });
        setImmediate(() => this.onStop()); return;
      }
      if (!this.clients.has(socket)) throw new Error('请先完成后台服务握手');
      if (method === 'remoteControl') {
        if (!this.remote) throw new Error('手机连接未初始化');
        this.inflight++;
        try { this.send(socket, { id, result: await this.remote.control(params) }); }
        finally { this.inflight--; this.schedule(); }
        return;
      }
      if (method === 'resources') {
        if (params?.operation === 'inspect') {
          this.inflight++;
          try { this.send(socket, { id, result: await inspectResources(this.backend, { includeTasks: params.includeTasks === true }) }); }
          finally { this.inflight--; }
          return;
        }
        if (!['terminate', 'acknowledge'].includes(params?.operation)) throw new Error('无效资源操作');
        if (this.inflight || this.backend.hasWork({ includePausedQueues: false }) || this.backend.starting.size || this.backend.providerUpdating) throw new Error('请先完成任务和其他操作，再处理资源');
        this.inflight++; this.recovering = true;
        try { this.send(socket, { id, result: await recoverResource(this.backend, params) }); }
        finally { this.inflight--; this.recovering = false; this.schedule(); }
        return;
      }
      if (method === 'snapshot') { this.send(socket, { id, result: this.packet() }); return; }
      if (method === 'activity') {
        this.sampleActivity();
        const windowFocused = params?.focused === true && params?.suspended !== true;
        if (windowFocused && !socket.activity?.windowFocused) socket.lastFocused = Date.now();
        socket.activity = { time: Date.now(), windowFocused, focused: params?.focused === true && params?.suspended !== true && Number.isFinite(params?.idleSeconds) && params.idleSeconds <= 300 };
        this.sampleActivity(); this.send(socket, { id, result: null }); return;
      }
      if (method !== 'addProject' && method !== 'command') throw new Error('不支持的后台服务操作');
      if (method === 'command') validateCommand(params?.name, params?.request);
      else if (typeof params?.path !== 'string') throw new Error('无效工作区路径');
      this.inflight++; this.schedule();
      try {
        let result = method === 'command' ? await this.backend.command(params.name, params.name === 'media' ? decodeMedia(params.request) : params.request) : await this.backend.addProject(params.path);
        if (method === 'command' && params.name === 'media') result = encodeMedia(result);
        this.publish(); this.send(socket, { id, result });
      } finally { this.inflight--; this.schedule(); }
    } catch (error) {
      const message = error.code === 'SIDEBAR_SAVE_FAILED'
        ? '侧栏整理未能保存，原有布局已保留。请检查存储位置和写入权限后重试。'
        : error.message;
      this.send(socket, { id, error: { ...desktopError(error), message: this.backend.providers.redact(message) } });
    }
  }
  close() {
    this.closed = true;
    this.remote?.close();
    this.power?.close();
    this.backgroundNotifications?.close(); this.pendingNotificationTarget = null;
    clearTimeout(this.timer); clearInterval(this.activityTimer); clearInterval(this.flushTimer);
    for (const socket of this.server?.clients ?? []) socket.terminate();
    this.server?.close();
  }
  async executeRemote(name, request) {
    if (this.closed || this.stopping || this.recovering) throw new Error('后台正在停止或恢复，请稍后重试');
    this.inflight++; this.schedule();
    try { return await this.backend.command(name, request); }
    finally { this.inflight--; this.schedule(); }
  }
}
module.exports = { PROTOCOL, DesktopService, validateCommand, encodeMedia, decodeMedia };
