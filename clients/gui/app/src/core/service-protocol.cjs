'use strict';
const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { appendFileSync } = require('node:fs');
const { WebSocketServer } = require('ws');
const { validateCommand: validateDesktopCommand, desktopError, validateMcpPageDeclaration, validateMcpPageReply } = require('@areal/workbench/desktop-contract');
const { inspectResources, recoverResource, blocked } = require('./resource-recovery.cjs');
const { validToolInput, describeCommands, failure: browserFailure, success: browserSuccess } = require('./browser-tool.cjs');
const { validComputerInput } = require('./computer-tool.cjs');
const { ProjectionEncoder } = require('@areal/workbench/state-projection');
const PROTOCOL = 'areal.desktop-service.v1';
const COMMAND_CONTRACT = 'areal.desktop-commands.v2';
const browserKey = (projectId, threadId) => JSON.stringify([projectId, threadId]);
const computerSetting = (name, request) => name === 'library' && request?.operation === 'settings'
  && ['computerControlEnabled', 'computerControlProvider', 'computerControlExecutable'].includes(request.key);

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
// authoritative for execution. No generic RPC passthrough; credential reveal is an explicit local request.
class DesktopService {
  constructor(backend, identity, onStop = () => {}, backgroundNotifications, power) {
    this.backend = backend; this.identity = identity; this.onStop = onStop;
    this.lifecycle = backend.lifecycleOperations?.attach(this);
    this.backgroundNotifications = backgroundNotifications; this.power = power;
    this.pendingNotificationTarget = null;
    this.token = randomBytes(32).toString('hex'); this.clients = new Set();
    this.mcpPageOwners = new Map();
    backend.onMcpPageToolNotice = event => this.mcpPageToolNotice(event);
    backend.onMcpPageToolsDisconnected = client => this.revokeMcpPageTools(lease => lease.client === client);
    this.browserClaims = new Map(); this.browserClaimAttempts = new Map();
    this.browserEntrypoints = new Map();
    this.browserDiscoveryPlans = new Map();
    this.browserPending = new Map(); this.nextBrowserId = 0;
    this.browserTestTrace = process.env.AREAL_BROWSER_READ_TEST_TRACE;
    backend.browserRead = request => this.browserRead(request);
    backend.computerRead = request => this.computerRead(request);
    backend.cuaRead = request => this.cuaRead(request);
    this.sequence = 0; this.inflight = 0;
    this.idleSince = Date.now(); this.closed = false;
    backend.onChange = () => this.schedule();
    backend.onNotification = notice => this.notify(notice);
    backend.onMcpAppNotification = event => {
      const notification = event?.notification;
      if (this.closed || !['projectId', 'threadId', 'instanceId'].every(key => typeof event?.[key] === 'string')
        || !['string', 'number'].includes(typeof event.generation)
        || notification?.jsonrpc !== '2.0' || notification.id !== undefined
        || !['notifications/resources/updated', 'notifications/resources/list_changed',
          'notifications/tools/list_changed', 'ui/notifications/host-context-changed', 'ui/notifications/closed'].includes(notification.method)) return;
      // Only authenticated clients that completed hello are present in this set.
      // Main owns the final app-instance/window match; background events never reveal a pane.
      const params = { projectId: event.projectId, threadId: event.threadId,
        instanceId: event.instanceId, generation: event.generation,
        notification: { jsonrpc: '2.0', method: notification.method,
          ...(notification.params === undefined ? {} : { params: notification.params }) } };
      if (notification.method === 'ui/notifications/closed') {
        const lease = this.mcpPageOwners.get(JSON.stringify([event.projectId, event.instanceId]));
        if (lease?.threadId === event.threadId && lease.generation === event.generation) this.retireMcpPageOwner(lease, true);
      }
      for (const socket of this.clients) this.send(socket, { method: 'mcpAppNotification', params });
    };
  }
  projectForThread(projectId, threadId) {
    const owner = this.backend.worktrees?.executionProjectId(projectId, threadId) ?? projectId;
    return this.backend.projects.get(owner);
  }
  bindMcpPageOwner(socket, project, client, request, response) {
    const instance = request.operation === 'mcpAppOpenFromResult' ? response?.status === 'open' && response.instance : response;
    if (!instance?.instanceId) return;
    const projectId = request.logicalProjectId ?? project.logicalProjectId ?? request.projectId;
    const key = JSON.stringify([projectId, instance.instanceId]);
    const previous = this.mcpPageOwners.get(key);
    if (this.closed || !this.clients.has(socket) || socket.readyState !== 1 || project.client !== client || !client.ready
      || previous && (previous.socket !== socket || previous.client !== client || previous.revoked)) throw new Error('Page tool opening owner lease is stale');
    if (previous) return;
    if (this.mcpPageOwners.size >= 128) throw new Error('Page tool owner capacity reached');
    this.mcpPageOwners.set(key, { project, client, socket, ownerId: socket.mcpPageOwnerId ??= randomUUID(), projectId,
      threadId: request.threadId, instanceId: instance.instanceId, generation: instance.generation, revoked: false });
  }
  async mcpPageTools(socket, params) {
    if (!params || !['register', 'revoke', 'claim', 'resolve'].includes(params.operation)) throw new Error('Invalid page tool operation');
    const fields = ['operation', 'projectId', 'threadId', 'instanceId', 'generation'];
    const extra = params.operation === 'register' ? ['declaration'] : params.operation === 'revoke' ? ['registrationId']
      : ['turnId', 'callId', 'registrationId', 'ownerId', 'schemaDigest', ...(params.operation === 'resolve' ? ['claimId', 'reply'] : [])];
    if (Object.keys(params).some(key => ![...fields, ...extra].includes(key))) throw new Error('Invalid page tool fields');
    const lease = this.mcpPageOwners.get(JSON.stringify([params.projectId, params.instanceId]));
    const current = () => lease && this.mcpPageOwners.get(JSON.stringify([params.projectId, params.instanceId])) === lease && lease.socket === socket && lease.client === lease.project.client
      && lease.client.ready && this.clients.has(socket) && socket.readyState === 1 && !this.closed;
    if (!current() || lease.threadId !== params.threadId || lease.generation !== params.generation
      || lease.revoked && !['resolve', 'revoke'].includes(params.operation)) throw new Error('Page tool owner lease is stale');
    const binding = { threadId: lease.threadId, instanceId: lease.instanceId, generation: lease.generation, ownerId: lease.ownerId };
    if (params.operation === 'register') {
      validateMcpPageDeclaration(params.declaration);
      const fingerprint = JSON.stringify(params.declaration);
      if (lease.registrationPromise) {
        if (lease.declaration !== fingerprint) throw new Error('Page tool declaration changed');
        return lease.registrationPromise;
      }
      lease.declaration = fingerprint;
      lease.pendingNotices = [];
      lease.registrationPromise = (async () => {
        const registration = await lease.client.request('areal/mcp/app/tools/register', { ...binding, declaration: params.declaration });
        lease.registration = registration;
        if (!current() || lease.revoked) {
          this.retireMcpPageOwner(lease);
          if (lease.client.ready) void lease.client.request('areal/mcp/app/tools/revoke', { ...binding, registrationId: registration.registrationId })
            .then(result => { if (result?.revoked === true) this.retireMcpPageOwner(lease, true); }).catch(() => {});
          throw new Error('Page tool owner lease is stale');
        }
        const notices = lease.pendingNotices;
        lease.pendingNotices = undefined;
        for (const notice of notices ?? []) if (notice.params.registrationId === registration.registrationId) this.mcpPageToolNotice(notice);
        return registration;
      })().catch(error => { this.retireMcpPageOwner(lease); throw error; });
      return lease.registrationPromise;
    }
    if (!lease.registration || params.registrationId !== lease.registration.registrationId) throw new Error('Invalid page tool registration');
    if (params.operation === 'revoke') {
      this.retireMcpPageOwner(lease);
      const result = await lease.client.request('areal/mcp/app/tools/revoke', { ...binding, registrationId: lease.registration.registrationId });
      if (result?.revoked === true) this.retireMcpPageOwner(lease, true);
      return result;
    }
    if (params.ownerId !== lease.ownerId || !lease.registration.tools.some(tool => tool.schemaDigest === params.schemaDigest)
      || !['turnId', 'callId'].every(key => typeof params[key] === 'string' && params[key].length > 0 && params[key].length <= 256)) throw new Error('Invalid page tool owner or call');
    const coordinates = { threadId: lease.threadId, turnId: params.turnId, callId: params.callId,
      registrationId: lease.registration.registrationId, ownerId: lease.ownerId, schemaDigest: params.schemaDigest };
    if (params.operation === 'resolve') validateMcpPageReply(params.reply);
    return lease.client.request(`areal/mcp/app/tools/${params.operation}`, { ...coordinates,
      ...(params.operation === 'resolve' ? { ...(params.claimId === undefined ? {} : { claimId: params.claimId }), reply: params.reply } : {}) });
  }
  mcpPageToolNotice(event) {
    if (this.closed || !['areal/mcp/app/tools/pending', 'areal/mcp/app/tools/cancelled'].includes(event?.method)) return;
    const params = event.params;
    const coordinates = ['threadId', 'turnId', 'callId', 'registrationId', 'ownerId', 'schemaDigest'];
    if (!params || !coordinates.every(key => typeof params[key] === 'string' && params[key].length > 0 && params[key].length <= 256)
      || Object.keys(params).some(key => !coordinates.includes(key) && key !== 'claimId')
      || params.claimId !== undefined && (typeof params.claimId !== 'string' || params.claimId.length === 0 || params.claimId.length > 256)) return;
    const candidates = [...this.mcpPageOwners.values()].filter(lease => lease.projectId === event.projectId
      && lease.client === event.client && lease.project?.client === event.client && lease.client?.ready
      && lease.socket?.readyState === 1 && this.clients.has(lease.socket)
      && lease.threadId === params.threadId && lease.ownerId === params.ownerId
      && !(lease.revoked && event.method.endsWith('/pending')));
    const owner = candidates.find(lease => lease.registration?.registrationId === params.registrationId);
    if (owner) {
      if (owner.registration.tools.some(tool => tool.schemaDigest === params.schemaDigest))
        this.send(owner.socket, { method: 'mcpPageToolNotice', params: { projectId: owner.projectId,
          instanceId: owner.instanceId, generation: owner.generation, method: event.method, params } });
      return;
    }
    for (const lease of candidates) {
      if (lease.registration || !lease.pendingNotices) continue;
      if (lease.pendingNotices.length < 32 && !lease.pendingNotices.some(notice => notice.method === event.method
        && coordinates.every(key => notice.params[key] === params[key]) && notice.params.claimId === params.claimId))
        lease.pendingNotices.push({ projectId: event.projectId, client: event.client, method: event.method, params: { ...params } });
    }
  }

  retireMcpPageOwner(lease, confirmed = false) {
    const key = JSON.stringify([lease.projectId, lease.instanceId]);
    const current = this.mcpPageOwners.get(key);
    if (!current || current.ownerId !== lease.ownerId) return;
    if (!current.socket && confirmed) { this.mcpPageOwners.delete(key); return; }
    current.revoked = true;
    current.pendingNotices = undefined;
    current.retired ||= confirmed;
    current.retireAt ??= lease.retireAt ?? Date.now() + 32_000;
    this.sweepMcpPageOwners();
  }
  sweepMcpPageOwners() {
    clearTimeout(this.mcpPageExpiryTimer);
    this.mcpPageExpiryTimer = undefined;
    let next = Infinity;
    for (const [key, lease] of this.mcpPageOwners) {
      if (lease.retireAt === undefined) continue;
      if (lease.retireAt > Date.now()) { next = Math.min(next, lease.retireAt); continue; }
      if (lease.retired) this.mcpPageOwners.delete(key);
      else this.mcpPageOwners.set(key, { projectId: lease.projectId, threadId: lease.threadId,
        instanceId: lease.instanceId, generation: lease.generation, ownerId: lease.ownerId, revoked: true });
    }
    if (next !== Infinity && !this.closed) {
      this.mcpPageExpiryTimer = setTimeout(() => this.sweepMcpPageOwners(), Math.max(0, next - Date.now()));
      this.mcpPageExpiryTimer.unref?.();
    }
  }
  revokeMcpPageTools(predicate) {
    for (const lease of this.mcpPageOwners.values()) {
      if (!lease.socket || !predicate(lease)) continue;
      this.retireMcpPageOwner(lease);
      this.send(lease.socket, { method: 'mcpPageToolsRevoked', params: { projectId: lease.projectId,
        instanceId: lease.instanceId, generation: lease.generation } });
      if (lease.registration && lease.client.ready) void lease.client.request('areal/mcp/app/tools/revoke', {
        threadId: lease.threadId, instanceId: lease.instanceId, generation: lease.generation,
        registrationId: lease.registration.registrationId, ownerId: lease.ownerId,
      }).then(result => { if (result?.revoked === true) this.retireMcpPageOwner(lease, true); }).catch(() => {});
    }
  }
  packet() {
    return { sequence: ++this.sequence, snapshot: this.backend.snapshot(), service: {
      ...(this.backend.applicationOwner ? { applicationOwner: this.backend.applicationOwner } : {}),
      connected: true, commandContract: COMMAND_CONTRACT, clients: this.clients.size, busy: this.backend.hasWork({ includePausedQueues: false }),
      activeCommands: this.inflight, providerUpdating: !!this.backend.providerUpdating,
      starting: this.backend.starting.size, pid: process.pid, ...(this.lifecycle ? { lifecycle: this.lifecycle.snapshot() } : {}),
      targets: this.lifecycle?.targets() ?? [],
      remote: { enabled: this.remote?.config?.enabled === true || this.remote?.config?.directEnabled === true, connections: this.remote?.channels?.size ?? 0 },
      browserCore: Object.fromEntries([...this.backend.projects].map(([id, project]) =>
        [id, project.service?.serviceId ?? null])),
      // Authenticated desktop Main uses actual active Core listeners to deny
      // Browser Session requests to control ports. This is not a UI grant.
      browserControlEndpoints: [...this.backend.projects.values()].map(project => project.endpoint).filter(Boolean),
    } };
  }
  send(socket, value, full = false) {
    if (socket.readyState !== 1) return;
    const outbound = socket.outbound ??= { queue: [], bytes: 0, active: false, state: null, closed: false };
    if (outbound.closed) return;
    const entry = { value, full, bytes: 0 };
    if (outbound.active) {
      if (value.method === 'state') {
        if (outbound.state) {
          const previous = outbound.state;
          previous.value = value; previous.full = full;
          outbound.queue.splice(outbound.queue.indexOf(previous), 1); outbound.queue.push(previous);
          return;
        }
        outbound.state = entry;
      } else {
        entry.bytes = Buffer.byteLength(JSON.stringify(value));
        if (outbound.bytes + entry.bytes > 32 * 1024 * 1024) { this.stopSending(socket); socket.terminate(); return; }
        outbound.bytes += entry.bytes;
      }
      outbound.queue.push(entry); return;
    }
    this.sendFrame(socket, entry);
  }
  stopSending(socket) {
    const outbound = socket.outbound;
    if (!outbound) return;
    clearTimeout(outbound.timer);
    outbound.closed = true; outbound.queue = []; outbound.state = null; outbound.bytes = 0;
  }
  sendFrame(socket, { value, full }) {
    const outbound = socket.outbound;
    if (outbound.closed || socket.readyState !== 1) { this.stopSending(socket); return; }
    if (socket.bufferedAmount > 32 * 1024 * 1024) { this.stopSending(socket); socket.terminate(); return; }
    outbound.active = true;
    const fail = () => { this.stopSending(socket); socket.terminate(); };
    outbound.timer = setTimeout(fail, 150000); outbound.timer.unref?.();
    try {
      if (socket.projection) {
        const key = value.method === 'state' ? 'params' : 'result', packet = value[key];
        if (packet?.snapshot && packet.service && Number.isSafeInteger(packet.sequence))
          value = { ...value, [key]: { ...packet, snapshot: socket.projection.encode(packet.snapshot, full) } };
      }
      const text = JSON.stringify(value);
      if (Buffer.byteLength(text) > 256 * 1024 * 1024) { fail(); return; }
      socket.send(text, error => {
        clearTimeout(outbound.timer);
        if (error) { fail(); return; }
        if (outbound.closed) return;
        outbound.active = false;
        const next = outbound.queue.shift();
        if (next) {
          outbound.bytes -= next.bytes;
          if (outbound.state === next) outbound.state = null;
          this.sendFrame(socket, next);
        }
      });
    } catch { fail(); }
  }
  async historyCommand(socket, request) {
    const views = socket.historyViews ??= new Map();
    const key = JSON.stringify([request.projectId, request.threadId, request.viewId]);
    let view = views.get(key);
    if (request.operation === 'release') {
      views.delete(key);
      return view ? this.backend.command('history', { ...view, operation: 'release' }) : { released: true };
    }
    if (request.operation === 'acquire') {
      if (!view) { view = { ...request, viewId: randomUUID() }; views.set(key, view); }
      try { return await this.backend.command('history', { ...view, operation: 'acquire' }); }
      catch (error) { if (views.get(key) === view) views.delete(key); throw error; }
      finally {
        if (socket.readyState !== 1 || views.get(key) !== view)
          await this.backend.command('history', { ...view, operation: 'release' }).catch(() => {});
      }
    }
    if (!view || socket.readyState !== 1) throw new Error('历史视图已关闭，请重新打开聊天。');
    return this.backend.command('history', { ...request, viewId: view.viewId });
  }
  releaseHistoryViews(socket) {
    for (const view of socket.historyViews?.values() ?? [])
      void this.backend.command('history', { ...view, operation: 'release' }).catch(() => {});
    socket.historyViews?.clear();
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
    if (settings.taskNotifications === false) return;
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
    await this.lifecycle?.init();
    await this.lifecycle?.reconcileLoaded();
    this.server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 256 * 1024 * 1024,
      verifyClient: ({ req }) => {
        const actual = Buffer.from(req.headers.authorization ?? '');
        const expected = Buffer.from(`Bearer ${this.token}`);
        return !req.headers.origin && actual.length === expected.length && timingSafeEqual(actual, expected);
      } });
    this.server.on('connection', socket => {
      socket.on('error', () => { this.stopSending(socket); socket.terminate(); });
      socket.on('message', bytes => { void this.receive(socket, bytes); });
      socket.on('close', () => {
        this.revokeMcpPageTools(lease => lease.socket === socket);
        this.stopSending(socket); this.releaseHistoryViews(socket);
        if (this.computerSocket === socket) this.computerSocket = null;
        for (const [key, claim] of this.browserClaims) if (claim.socket === socket) this.browserClaims.delete(key);
        for (const [id, record] of this.browserDiscoveryPlans)
          if (record.socket === socket) this.browserDiscoveryPlans.delete(id);
        for (const [key, entries] of this.browserEntrypoints) for (const entry of entries)
          if (entry.socket === socket) this.forgetBrowserEntrypoint(key, entry);
        for (const [key, attempt] of this.browserClaimAttempts) if (attempt.socket === socket) {
          attempt.cancelled = true; this.browserClaimAttempts.delete(key);
        }
        for (const [id, pending] of this.browserPending) if (pending.socket === socket) {
          this.browserPending.delete(id); clearTimeout(pending.timer);
          pending.reject(new Error('Browser host disconnected after dispatch'));
        }
        this.sampleActivity();
        if (this.clients.delete(socket) && !this.clients.size) this.idleSince = Date.now();
        this.sampleActivity(); this.schedule();
      });
    });
    await new Promise((resolve, reject) => { this.server.once('listening', resolve); this.server.once('error', reject); });
    this.activityTimer = setInterval(() => { this.sampleActivity(); }, 5000);
    this.flushTimer = setInterval(() => { void this.backend.analytics.flush(); }, 30000);
    return { ...(this.backend.applicationOwner ? { applicationOwner: this.backend.applicationOwner } : {}), protocol: PROTOCOL, endpoint: `ws://127.0.0.1:${this.server.address().port}`, token: this.token, identity: this.identity,
      ...(this.lifecycle ? { desktopGeneration: this.lifecycle.generation } : {}), pid: process.pid };
  }
  sampleActivity() {
    const now = Date.now();
    const active = [...this.clients].some(s => s.activity && now - s.activity.time <= 15000 && s.activity.focused);
    // Count the union of active GUI intervals, never one duration per client.
    this.backend.analytics.sample({ time: now, focused: active });
  }
  async stop({ cancel = false } = {}) {
    if (!this.lifecycle) throw Object.assign(new Error('后台未声明持久生命周期能力'), { code: 'LIFECYCLE_UNSUPPORTED' });
    return this.lifecycle.request({ requestId: randomUUID(), kind: 'stopDesktop', mode: cancel ? 'cancel' : 'ifIdle',
      expectedDesktopGeneration: this.lifecycle.generation, expectedTargets: this.lifecycle.targets() });
  }
  requestExit(receipt) {
    if (this.exitRequested || receipt?.desktopExit !== 'requested' || receipt.desktopGeneration !== this.lifecycle?.generation) return;
    this.exitRequested = true;
    setImmediate(() => this.onStop());
  }
  async receive(socket, bytes) {
    let message;
    try { message = JSON.parse(bytes.toString()); } catch { socket.close(1008); return; }
    const { id, method, params } = message ?? {};
    if (!Number.isSafeInteger(id) || typeof method !== 'string') { socket.close(1008); return; }
    try {
      if (method === 'hello') {
        if (params?.protocol !== PROTOCOL || params?.identity !== this.identity) throw Object.assign(new Error('后台服务版本或启动配置不兼容。请先安全停止旧后台服务。'), { code: 'SERVICE_INCOMPATIBLE' });
        socket.projection = params.capabilities?.projection === 1 ? socket.projection ?? new ProjectionEncoder(randomUUID()) : null;
        socket.notifications = params.notifications === true;
        if (params.capabilities?.computerHost === 1
          && (!this.computerSocket || this.computerSocket === socket || this.computerSocket.readyState !== 1))
          this.computerSocket = socket;
        this.clients.add(socket);
        this.idleSince = null;
        this.send(socket, { id, result: { ...this.packet(), computerHostOwned: this.computerSocket === socket } }, true);
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
        if (!this.lifecycle) throw Object.assign(new Error('后台未声明持久生命周期能力'), { code: 'LIFECYCLE_UNSUPPORTED' });
        if (params.cancel === true && !Array.isArray(params.expectedTargets))
          throw Object.assign(new Error('取消缺少已确认的后台目标'), { code: 'CONFIRMATION_STALE' });
        const result = await this.lifecycle.request({ requestId: params.requestId ?? randomUUID(), kind: params.forUpdate ? 'updateDesktop' : 'stopDesktop',
          mode: params.cancel === true ? 'cancel' : 'ifIdle', expectedDesktopGeneration: params.expectedDesktopGeneration ?? this.lifecycle.generation,
          expectedTargets: params.expectedTargets ?? this.lifecycle.targets() });
        this.send(socket, { id, result }); this.requestExit(result); return;
      }
      if (!this.clients.has(socket)) throw new Error('请先完成后台服务握手');
      if (['lifecycleRequest', 'lifecycleRead', 'lifecycleReconcile'].includes(method)) {
        if (!this.lifecycle) throw Object.assign(new Error('后台未声明持久生命周期能力'), { code: 'LIFECYCLE_UNSUPPORTED' });
        if (params?.protocol !== PROTOCOL) throw Object.assign(new Error('后台服务协议不兼容'), { code: 'LIFECYCLE_UNSUPPORTED' });
        const result = method === 'lifecycleRequest' ? await this.lifecycle.request(params)
          : method === 'lifecycleRead' ? await this.lifecycle.read(params.requestId) : await this.lifecycle.reconcile(params.requestId);
        this.send(socket, { id, result });
        if (method === 'lifecycleRequest') this.requestExit(result);
        this.schedule(); return;
      }
      if (this.recovering && !['snapshot', 'activity'].includes(method)) throw blocked('正在处理后台资源，请稍后重试');
      if (method === 'browserClaim') {
        const { coreInstanceId: claimedCoreId, projectId, threadId, pageId,
          browserHostId, hostGeneration, pageGeneration, controlEpoch } = params ?? {};
        if (params?.protocol !== 'areal.browser.host.v1' || params?.available !== true
          || JSON.stringify(params?.operations) !== JSON.stringify(['describe', 'observe', 'capture', 'act', 'wait', 'navigate', 'newPage', 'diagnostics', 'runBatch', 'command'])) throw new Error('浏览器宿主能力不兼容');
        if (![projectId, threadId, pageId, browserHostId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 256)
          || ![hostGeneration, pageGeneration, controlEpoch].every(Number.isSafeInteger)) throw new Error('无效浏览页面身份');
        const project = this.projectForThread(projectId, threadId);
        const thread = project?.model.state.threads[threadId];
        if (!thread?.dynamicTools?.some(tool => tool.name === 'browser_v1')) throw new Error('当前聊天未启用浏览器');
        const coreInstanceId = project.service?.serviceId, coreGeneration = project.service?.generation;
        if (typeof coreInstanceId !== 'string' || typeof coreGeneration !== 'string') throw new Error('Core 部署身份不可用');
        if (claimedCoreId !== coreInstanceId) throw new Error('浏览页面属于旧 Core 部署');
        const key = browserKey(projectId, threadId);
        const previous = this.browserClaims.get(key);
        if (previous && previous.socket !== socket && previous.socket.readyState === 1) throw new Error('浏览页面已由其他桌面窗口认领');
        if (this.browserClaimAttempts.has(key)) throw new Error('浏览页面正在认领，请稍后重试');
        const attempt = { socket, pageId, cancelled: false };
        this.browserClaimAttempts.set(key, attempt);
        const coreClient = project.client;
        try {
          const bootstrap = params.bootstrapRequestId === undefined ? null : this.browserPending.get(params.bootstrapRequestId);
          if (params.bootstrapRequestId !== undefined) {
            if (!bootstrap?.bootstrap || bootstrap.socket !== socket || bootstrap.key !== key
              || bootstrap.coreInstanceId !== coreInstanceId || bootstrap.coreGeneration !== coreGeneration)
              throw new Error('Browser entry authorization expired');
          } else await this.backend.bindBrowserHostForClaim(project, threadId);
          if (attempt.cancelled || this.browserClaimAttempts.get(key) !== attempt
            || this.browserClaims.get(key) !== previous || !this.clients.has(socket) || this.closed
            || this.projectForThread(projectId, threadId) !== project || !this.backend.currentConnection(project, coreClient)
            || project.service?.serviceId !== coreInstanceId
            || project.service?.generation !== coreGeneration || socket.readyState !== 1) {
            throw new Error('认领期间页面、Core 或桌面连接已换代，请重新操作');
          }
          const claim = previous && previous.socket === socket && previous.coreInstanceId === coreInstanceId
            && previous.coreGeneration === coreGeneration && previous.browserHostId === browserHostId
            && previous.hostGeneration === hostGeneration ? previous
            : { socket, coreInstanceId, coreGeneration, browserHostId, hostGeneration,
              pages: new Map(), revokedPages: new Set() };
          claim.revokedPages.delete(pageId);
          claim.pages.set(pageId, { pageId, pageGeneration, controlEpoch });
          this.browserClaims.set(key, claim);
          this.send(socket, { id, result: { claimed: true } }); return;
        } finally {
          if (this.browserClaimAttempts.get(key) === attempt) this.browserClaimAttempts.delete(key);
        }
      }
      if (method === 'browserRevoke') {
        const key = browserKey(params?.projectId, params?.threadId);
        for (const [planId, record] of this.browserDiscoveryPlans)
          if (record.key === key && record.socket === socket) this.browserDiscoveryPlans.delete(planId);
        for (const entry of this.browserEntrypoints.get(key) ?? []) this.forgetBrowserEntrypoint(key, entry);
        for (const pending of this.browserPending.values()) if ((pending.bootstrap || pending.discovery) && pending.key === key && pending.socket === socket)
          pending.reject(new Error('Browser entry revoked by human input'));
        const attempt = this.browserClaimAttempts.get(key);
        if (attempt?.socket === socket && (typeof params?.pageId !== 'string' || attempt.pageId === params.pageId)) {
          attempt.cancelled = true; this.browserClaimAttempts.delete(key);
        }
        const claim = this.browserClaims.get(key);
        if (claim?.socket === socket) {
          if (typeof params?.pageId === 'string') {
            claim.pages.delete(params.pageId);
            claim.revokedPages.add(params.pageId);
          }
          else claim.pages.clear();
          if (claim.pages.size === 0) this.browserClaims.delete(key);
        }
        this.send(socket, { id, result: { revoked: true } }); return;
      }
      if (method === 'browserResult') {
        const pending = this.browserPending.get(params?.requestId);
        if (!pending || pending.socket !== socket) throw new Error('无效浏览器回执');
        this.browserPending.delete(params.requestId); clearTimeout(pending.timer);
        if (params?.error) pending.reject(new Error('Browser host failed after dispatch'));
        else pending.resolve(params?.result);
        this.send(socket, { id, result: null }); return;
      }
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
          try { this.send(socket, { id, result: await inspectResources(this.backend, {
            includeTasks: params.includeTasks === true, purpose: params.purpose === 'quit' ? 'quit' : undefined,
          }) }); }
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
      if (method === 'mcpPageTools') {
        this.send(socket, { id, result: await this.mcpPageTools(socket, params) }); return;
      }
      if (method === 'snapshot') { this.send(socket, { id, result: this.packet() }, true); return; }
      if (method === 'activity') {
        this.sampleActivity();
        const windowFocused = params?.focused === true && params?.suspended !== true;
        if (windowFocused && !socket.activity?.windowFocused) socket.lastFocused = Date.now();
        socket.activity = { time: Date.now(), windowFocused, focused: params?.focused === true && params?.suspended !== true && Number.isFinite(params?.idleSeconds) && params.idleSeconds <= 300 };
        this.sampleActivity(); this.send(socket, { id, result: null }); return;
      }
      if (method !== 'addProject' && method !== 'command') throw new Error('不支持的后台服务操作');
      if (method === 'command') {
        validateCommand(params?.name, params?.request);
        if (computerSetting(params.name, params.request) && this.computerSocket !== socket)
          throw new Error('Computer provider settings belong to the local computer control host');
      } else if (typeof params?.path !== 'string') throw new Error('无效工作区路径');
      this.inflight++; this.schedule();
      try {
        const entryKey = method === 'command' && ['send', 'editMessage', 'continue'].includes(params.name)
          ? browserKey(params.request.projectId, params.request.threadId) : null;
        const entryProject = entryKey && this.projectForThread(params.request.projectId, params.request.threadId);
        const entry = entryProject?.model.state.threads[params.request.threadId]
          ? { socket, project: entryProject, client: entryProject.client } : null;
        if (entry) {
          const entries = this.browserEntrypoints.get(entryKey) ?? new Set();
          const activeTurns = new Set(entryProject.model.state.threads[params.request.threadId].turns
            ?.filter(turn => turn.status === 'inProgress').map(turn => turn.id) ?? []);
          for (const previous of entries) if (previous.accepted?.turnId && !activeTurns.has(previous.accepted.turnId))
            this.forgetBrowserEntrypoint(entryKey, previous);
          // Core 最多受理 128 个排队项，另保留本聊天的活动轮次。
          if (entries.size >= 129) throw new Error('Browser entry capacity reached');
          entry.ready = new Promise(resolve => { entry.resolve = value => { entry.accepted ??= value; resolve(value); }; });
          entries.add(entry); this.browserEntrypoints.set(entryKey, entries);
        }
        let result;
        try { result = method === 'command' && params.name === 'history' ? await this.historyCommand(socket, params.request)
          : method === 'command' ? await this.backend.command(params.name, params.name === 'media' ? decodeMedia(params.request) : params.request,
          { onMcpAppOpened: (project, client, request, result) => this.bindMcpPageOwner(socket, project, client, request, result),
            onBrowserTurnStarted: turnId => entry?.resolve({ turnId }),
            onBrowserTurnQueued: queueItemId => entry?.resolve({ queueItemId }) }) : await this.backend.addProject(params.path); }
        catch (error) { if (entry) this.forgetBrowserEntrypoint(entryKey, entry); throw error; }
        finally { entry?.resolve(null); }
        if (method === 'command' && params.name === 'manage' && params.request.operation === 'mcpAppClose' && result?.closed === true) {
          const request = params.request;
          const lease = this.mcpPageOwners.get(JSON.stringify([request.projectId, request.instanceId]));
          if (lease?.threadId === request.threadId && lease.generation === request.generation) this.retireMcpPageOwner(lease, true);
        }
        if (method === 'command' && params.name === 'media') result = encodeMedia(result);
        this.publish(); this.send(socket, { id, result });
      } finally { this.inflight--; this.schedule(); }
    } catch (error) {
      const message = error.code === 'SIDEBAR_SAVE_FAILED'
        ? '侧栏整理未能保存，原有布局已保留。请检查存储位置和写入权限后重试。'
        : error.message;
      this.send(socket, { id, error: { ...desktopError(error), ...(error.lifecycle ? { lifecycle: error.lifecycle } : {}), message: method === 'command' && params?.name === 'providers' && params?.request?.operation === 'revealKey'
        ? '无法显示 API Key，请刷新配置或解锁系统安全存储后重试。' : this.backend.providers.redact(message) } });
    }
  }
  close() {
    this.closed = true;
    this.revokeMcpPageTools(() => true);
    clearTimeout(this.mcpPageExpiryTimer); this.mcpPageOwners.clear();
    for (const attempt of this.browserClaimAttempts.values()) attempt.cancelled = true;
    this.browserClaimAttempts.clear();
    for (const pending of this.browserPending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Browser service closed after dispatch')); }
    for (const entries of this.browserEntrypoints.values()) for (const entry of entries) entry.resolve(null);
    this.browserPending.clear(); this.browserClaims.clear(); this.browserEntrypoints.clear(); this.browserDiscoveryPlans.clear();
    this.remote?.close();
    this.power?.close();
    this.backgroundNotifications?.close(); this.pendingNotificationTarget = null;
    clearTimeout(this.timer); clearInterval(this.activityTimer); clearInterval(this.flushTimer);
    for (const socket of this.server?.clients ?? []) { this.stopSending(socket); this.releaseHistoryViews(socket); socket.terminate(); }
    this.server?.close();
  }
  async executeRemote(name, request) {
    if (computerSetting(name, request)) throw new Error('Computer provider settings must be changed on the local control host');
    if (name === 'providers' && request?.operation === 'revealKey') throw new Error('API Key 仅可在本机模型设置中查看');
    if (this.closed || this.recovering) throw new Error('后台正在停止或恢复，请稍后重试');
    this.inflight++; this.schedule();
    try { return await this.backend.command(name, request); }
    finally { this.inflight--; this.schedule(); }
  }
  forgetBrowserEntrypoint(key, entry) {
    entry.resolve(null);
    const entries = this.browserEntrypoints.get(key);
    entries?.delete(entry);
    if (entries?.size === 0) this.browserEntrypoints.delete(key);
  }
  async browserEntrypoint(request, key) {
    // 每条已受理消息独立持有入口；队列查询只读，
    // 事件顺序或对下一轮次的猜测均不能授权回调。
    let queue;
    for (const entry of [...this.browserEntrypoints.get(key) ?? []]) {
      const accepted = await entry.ready;
      const current = () => this.browserEntrypoints.get(key)?.has(entry) && entry.socket.readyState === 1
        && this.projectForThread(request.projectId, request.threadId) === entry.project
        && this.backend.currentConnection(entry.project, entry.client)
        && entry.project.service?.serviceId === request.coreInstanceId
        && entry.project.service?.generation === request.coreGeneration;
      const forget = () => this.forgetBrowserEntrypoint(key, entry);
      if (!accepted || !current()) { forget(); continue; }
      let turnId = accepted.turnId;
      if (typeof accepted.queueItemId === 'string') {
        try { queue ??= await entry.client.request('areal/queue/list', { threadId: request.threadId }); }
        catch { forget(); continue; }
        if (!current()) { forget(); continue; }
        const item = queue.items?.find(item => item.id === accepted.queueItemId);
        if (!item || !['pending', 'running'].includes(item.status)) { forget(); continue; }
        if (item.status === 'pending') continue;
        turnId = item.turnId;
      }
      if (turnId === request.turnId) return entry;
    }
    return null;
  }
  async dispatchBrowserDiscovery(request, key, socket, phase, browserApproval) {
    if (request.signal?.aborted || socket.readyState !== 1 || this.browserPending.size >= 8)
      throw new Error('Browser entry unavailable');
    const requestId = ++this.nextBrowserId;
    return new Promise((resolve, reject) => {
      const finish = (fn, value) => {
        clearTimeout(timer); request.signal?.removeEventListener('abort', abort);
        this.browserPending.delete(requestId); fn(value);
      };
      const abort = () => finish(reject, new Error('Browser entry cancelled'));
      const timer = setTimeout(() => finish(reject, new Error('Browser entry outcome unknown')), 15000);
      this.browserPending.set(requestId, { socket, key, bootstrap: phase === 'execute', discovery: true,
        coreInstanceId: request.coreInstanceId, coreGeneration: request.coreGeneration,
        resolve: value => finish(resolve, value), reject: error => finish(reject, error), timer });
      request.signal?.addEventListener('abort', abort, { once: true });
      this.send(socket, { method: 'browserRequest', params: {
        requestId, operation: 'describe', phase, projectId: request.projectId,
        threadId: request.threadId, turnId: request.turnId, callId: request.callId,
        coreInstanceId: request.coreInstanceId, coreGeneration: request.coreGeneration,
        ...(browserApproval ? { browserApproval } : {}),
      } });
    });
  }
  async bootstrapBrowser(request, key) {
    const entry = await this.browserEntrypoint(request, key);
    if (!entry || !this.browserEntrypoints.get(key)?.has(entry)) return;
    this.forgetBrowserEntrypoint(key, entry);
    await this.dispatchBrowserDiscovery(request, key, entry.socket, 'execute');
  }

  async prepareBrowserDiscovery(request, key, claim) {
    for (const [id, record] of this.browserDiscoveryPlans)
      if (record.plan.expiresAt <= Date.now() || record.socket.readyState !== 1) this.browserDiscoveryPlans.delete(id);
    if (this.browserDiscoveryPlans.size >= 128) return { error: 'host_busy', dispatch: 'not_sent' };
    const entry = await this.browserEntrypoint(request, key);
    const socket = claim?.socket ?? entry?.socket;
    const current = () => socket?.readyState === 1 && !request.signal?.aborted
      && claim === this.browserClaims.get(key)
      && (!entry || this.browserEntrypoints.get(key)?.has(entry))
      && (!claim || (claim.coreInstanceId === request.coreInstanceId && claim.coreGeneration === request.coreGeneration))
      && this.projectForThread(request.projectId, request.threadId)?.service?.serviceId === request.coreInstanceId
      && this.projectForThread(request.projectId, request.threadId)?.service?.generation === request.coreGeneration;
    if (!current()) return { error: 'human_control', dispatch: 'not_sent' };
    const result = await this.dispatchBrowserDiscovery(request, key, socket, 'prepare');
    if (!current()) return { error: 'human_control', dispatch: 'not_sent' };
    if (result?.error) return { error: result.error, dispatch: 'not_sent' };
    const plan = result?.plan;
    if (!plan || plan.operation !== 'describe' || typeof plan.preparedActionId !== 'string'
      || typeof plan.fingerprint !== 'string' || typeof plan.origin !== 'string'
      || !(plan.pageId === null || typeof plan.pageId === 'string')
      || typeof plan.browserHostId !== 'string' || typeof plan.alreadyControlled !== 'boolean'
      || ![plan.hostGeneration, plan.pageGeneration, plan.controlEpoch, plan.humanRevision, plan.documentEpoch, plan.expiresAt].every(Number.isSafeInteger)
      || plan.expiresAt <= Date.now() || plan.expiresAt > Date.now() + 300000
      || plan.coreInstanceId !== request.coreInstanceId || plan.coreGeneration !== request.coreGeneration
      || plan.projectId !== request.projectId || plan.threadId !== request.threadId
      || plan.turnId !== request.turnId || plan.callId !== request.callId)
      throw new Error('Invalid browser discovery plan');
    const pageClaim = claim?.pages.get(plan.pageId);
    if (plan.alreadyControlled ? !pageClaim || plan.browserHostId !== claim.browserHostId
      || plan.hostGeneration !== claim.hostGeneration || plan.pageGeneration !== pageClaim.pageGeneration
      || plan.controlEpoch !== pageClaim.controlEpoch : !entry || entry.socket !== socket)
      return { error: 'human_control', dispatch: 'not_sent' };
    this.browserDiscoveryPlans.set(plan.preparedActionId, { key, plan, claim, entry, socket,
      pages: claim ? [...claim.pages.values()].map(page => ({ ...page })) : [] });
    return plan;
  }

  consumeBrowserDiscovery(request, key, claim) {
    const plan = request.browserApproval?.plan;
    const record = plan && this.browserDiscoveryPlans.get(plan.preparedActionId);
    if (record) this.browserDiscoveryPlans.delete(plan.preparedActionId);
    if (!record || record.key !== key || !isDeepStrictEqual(record.plan, plan)
      || record.plan.expiresAt <= Date.now() || record.socket.readyState !== 1
      || record.claim !== claim || request.signal?.aborted
      || this.projectForThread(request.projectId, request.threadId)?.service?.serviceId !== request.coreInstanceId
      || this.projectForThread(request.projectId, request.threadId)?.service?.generation !== request.coreGeneration
      || plan.coreInstanceId !== request.coreInstanceId || plan.coreGeneration !== request.coreGeneration
      || plan.projectId !== request.projectId || plan.threadId !== request.threadId
      || plan.turnId !== request.turnId || plan.callId !== request.callId
      || (record.entry && (!this.browserEntrypoints.get(key)?.has(record.entry)
        || this.projectForThread(request.projectId, request.threadId) !== record.entry.project
        || !this.backend.currentConnection(record.entry.project, record.entry.client)))
      || (claim && !isDeepStrictEqual(record.pages, [...claim.pages.values()]))) return null;
    return record;
  }

  async uploadToolImage(request, image, current) {
    if (typeof image.data !== 'string' || !['image/png', 'image/jpeg'].includes(image.mimeType)
      || image.data.length > 12 * 1024 * 1024) throw new Error('Invalid desktop image');
    const bytes = Buffer.from(image.data, 'base64');
    if (!bytes.length || bytes.length > 8 * 1024 * 1024 || bytes.toString('base64') !== image.data)
      throw new Error('Invalid desktop image encoding');
    const project = this.projectForThread(request.projectId, request.threadId);
    if (!current() || request.signal?.aborted || project?.service?.serviceId !== request.coreInstanceId
      || project.service.generation !== request.coreGeneration) throw new Error('Desktop image owner changed');
    const url = new URL(project.endpoint);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'; url.pathname = '/areal/blobs'; url.search = '';
    for (const [key, value] of Object.entries({ threadId: request.threadId, callId: request.callId, hostGeneration: request.toolHostGeneration }))
      url.searchParams.set(key, value);
    const signal = request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000);
    const uploaded = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${project.token}`, 'Content-Type': image.mimeType },
      body: bytes, redirect: 'error', signal });
    if (!uploaded.ok) throw new Error(`Desktop image upload failed (${uploaded.status})`);
    const media = await uploaded.json();
    if (!current() || request.signal?.aborted || project !== this.projectForThread(request.projectId, request.threadId)
      || project.service?.serviceId !== request.coreInstanceId || project.service?.generation !== request.coreGeneration)
      throw new Error('Desktop image owner changed');
    return { type: 'arealMedia', modality: 'image', media };
  }

  async toolResult(request, envelope, current) {
    const dispatch = envelope.structuredContent?.dispatch_status ?? envelope.dispatch_status;
    if (dispatch === 'possibly_sent' || dispatch === 'unknown') return { success: false,
      contentItems: [{ type: 'inputText', text: 'Desktop action outcome is UNKNOWN. Inspect before another action.' }],
      structuredContent: { ...envelope.structuredContent, code: 'outcome_unknown', dispatch: 'unknown' } };
    const contentItems = [];
    if (!Array.isArray(envelope.content) || envelope.content.length > 32) throw new Error('Invalid desktop tool content');
    for (const content of envelope.content) {
      if (content?.type === 'text' && typeof content.text === 'string') contentItems.push({ type: 'inputText', text: content.text });
      else if (content?.type === 'image') contentItems.push(await this.uploadToolImage(request, content, current));
      else throw new Error('Unsupported desktop tool content');
    }
    if (!current() || request.signal?.aborted) throw new Error('Desktop tool owner changed after dispatch');
    return { success: envelope.isError !== true, contentItems, ...(envelope.structuredContent ? { structuredContent: envelope.structuredContent } : {}) };
  }

  async cuaRead(request) {
    const { projectId, signal, phase } = request;
    const project = this.backend.projects.get(projectId), client = project?.client, socket = this.computerSocket;
    const current = () => !this.closed && this.computerSocket === socket && this.clients.has(socket) && socket.readyState === 1
      && (phase === 'revokeProject' || this.backend.projects.get(projectId) === project && this.backend.currentConnection(project, client)
        && project.service?.serviceId === request.coreInstanceId && project.service?.generation === request.coreGeneration);
    if (!socket || !current()) throw new Error('External CUA desktop host is unavailable');
    if (['catalog', 'call'].includes(phase) && (this.backend.library.value.settings.computerControlEnabled !== true
      || this.backend.library.value.settings.computerControlProvider !== 'lcu')) throw new Error('External CUA is not the selected computer provider');
    if (signal?.aborted || this.browserPending.size >= 16) throw new Error('External CUA request cancelled or host busy before dispatch');
    const requestId = ++this.nextBrowserId;
    const result = await new Promise((resolve, reject) => {
      let timer;
      const finish = (next, value) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); this.browserPending.delete(requestId); next(value); };
      const cancel = () => this.send(socket, { method: 'browserCancel', params: { tool: 'external_cua', requestId } });
      const onAbort = () => { cancel(); finish(reject, new Error('External CUA cancelled; outcome is UNKNOWN')); };
      if (phase !== 'call') timer = setTimeout(() => { cancel(); finish(reject, new Error('External CUA host did not finish')); }, 130000);
      this.browserPending.set(requestId, { socket, tool: 'external_cua', timer,
        resolve: value => finish(resolve, value), reject: error => finish(reject, error) });
      signal?.addEventListener('abort', onAbort, { once: true });
      const { signal: ignoredSignal, ...params } = request;
      this.send(socket, { method: 'browserRequest', params: { ...params, tool: 'external_cua', cuaTool: request.tool, requestId } });
    });
    if (!current() || signal?.aborted) throw new Error('External CUA owner changed; outcome is UNKNOWN');
    if (result?.error) throw new Error(result.error);
    if (!result || Buffer.byteLength(JSON.stringify(result)) > 32 * 1024 * 1024) throw new Error('Invalid external CUA response');
    return result;
  }

  async computerRead(request) {
    const { projectId, threadId, turnId, callId, coreInstanceId, coreGeneration, signal, phase } = request;
    if (![projectId, threadId, turnId, callId, coreInstanceId].every(value => typeof value === 'string' && value)
      || !validComputerInput(request.arguments)) return phase === 'prepare' ? { error: 'invalid_arguments', dispatch: 'not_sent' }
        : browserFailure('invalid_arguments', 'Unsupported computer operation or parameters');
    const project = this.backend.projects.get(projectId), client = project?.client, socket = this.computerSocket;
    const current = () => !this.closed && this.computerSocket === socket && this.clients.has(socket) && socket.readyState === 1
      && this.backend.projects.get(projectId) === project && this.backend.currentConnection(project, client)
      && project.service?.serviceId === coreInstanceId && project.service?.generation === coreGeneration;
    if (request.discardPreparedPlan !== true && (this.backend.library.value.settings.computerControlEnabled !== true || this.backend.library.value.settings.computerControlProvider === 'lcu')) {
      const refusal = { code: 'not_authorized', message: 'Computer control is disabled', action_sent: false,
        dispatch_status: 'not_sent', dispatch: 'not_sent' };
      return phase === 'prepare' ? { ...refusal, error: refusal.code }
        : { success: false, contentItems: [{ type: 'inputText', text: JSON.stringify(refusal) }], structuredContent: refusal };
    }
    if (!socket || !current()) return phase === 'prepare' ? { error: 'computer_unavailable', dispatch: 'not_sent' }
      : browserFailure('computer_unavailable', 'The local computer control host is unavailable');
    if (signal?.aborted) throw new Error('Computer request cancelled before dispatch');
    if (this.browserPending.size >= 16) return phase === 'prepare'
      ? { error: 'host_busy', dispatch: 'not_sent' }
      : browserFailure('host_busy', 'Desktop host is busy; no action was sent');
    const requestId = ++this.nextBrowserId;
    const result = await new Promise((resolve, reject) => {
      const finish = (next, value) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); this.browserPending.delete(requestId); next(value); };
      const cancel = () => this.send(socket, { method: 'browserCancel', params: { tool: 'computer_v1', requestId, projectId, threadId, turnId, callId } });
      const onAbort = () => { cancel(); finish(reject, new Error('Computer request cancelled; dispatch may be unknown')); };
      const timer = setTimeout(() => { cancel(); finish(reject, new Error('Computer host response unknown')); }, phase === 'prepare' ? 10000 : 125000);
      this.browserPending.set(requestId, { socket, tool: 'computer_v1', timer,
        resolve: value => finish(resolve, value), reject: error => finish(reject, error) });
      signal?.addEventListener('abort', onAbort, { once: true });
      const { signal: ignoredSignal, ...params } = request;
      this.send(socket, { method: 'browserRequest', params: { ...params, tool: 'computer_v1', requestId } });
    });
    if (!current() || signal?.aborted) throw new Error('Computer owner changed during dispatch');
    if (!result || JSON.stringify(result).length > 32 * 1024 * 1024) throw new Error('Invalid computer host response');
    if (phase === 'prepare') {
      if (request.discardPreparedPlan === true) return result;
      if (result.error && result.dispatch === 'not_sent') return result;
      if (result.operation !== request.arguments.operation || result.parameters === undefined
        || !isDeepStrictEqual(result.parameters, request.arguments.parameters)
        || result.coreInstanceId !== coreInstanceId || result.coreGeneration !== coreGeneration
        || result.projectId !== projectId || result.threadId !== threadId || result.turnId !== turnId || result.callId !== callId
        || result.toolHostGeneration !== request.toolHostGeneration) throw new Error('Invalid prepared computer identity');
      return result;
    }
    return this.toolResult(request, result, current);
  }

  async browserRead(request) {
    const { projectId, threadId, turnId, callId, toolHostGeneration, coreInstanceId, coreGeneration, signal, arguments: input,
      phase = 'execute', browserApproval } = request ?? {};
    if (typeof projectId !== 'string' || typeof threadId !== 'string' || typeof turnId !== 'string'
      || typeof callId !== 'string' || typeof coreInstanceId !== 'string' || !validToolInput(input))
      return browserFailure('invalid_arguments', 'Unsupported browser operation or parameters');
    const action = ['act', 'wait', 'navigate', 'newPage', 'runBatch', 'command'].includes(input.operation);
    const scoped = input.operation !== 'describe';
    const key = browserKey(projectId, threadId);
    let claim = this.browserClaims.get(key);
    if (input.operation === 'describe' && phase === 'prepare') return this.prepareBrowserDiscovery(request, key, claim);
    let discoveryResult;
    if (input.operation === 'describe' && browserApproval?.plan) {
      const prepared = this.consumeBrowserDiscovery(request, key, claim);
      if (!prepared) return browserFailure('plan_stale', 'Browser entry authorization changed; send a new explicit request');
      if (prepared.entry) this.forgetBrowserEntrypoint(key, prepared.entry);
      discoveryResult = await this.dispatchBrowserDiscovery(request, key, prepared.socket, 'execute', browserApproval);
      if (discoveryResult?.error) return browserFailure(discoveryResult.error, 'Browser entry changed; send a new explicit request');
      claim = this.browserClaims.get(key);
      const permit = discoveryResult?.controlPermit;
      const pageClaim = claim?.pages.get(permit?.pageId);
      if (!permit || discoveryResult.coreInstanceId !== coreInstanceId || discoveryResult.coreGeneration !== coreGeneration
        || discoveryResult.projectId !== projectId || discoveryResult.threadId !== threadId
        || discoveryResult.turnId !== turnId || discoveryResult.callId !== callId
        || claim?.socket !== prepared.socket || permit.browserHostId !== claim?.browserHostId
        || permit.hostGeneration !== claim?.hostGeneration || !pageClaim
        || permit.pageGeneration !== pageClaim.pageGeneration || permit.controlEpoch !== pageClaim.controlEpoch)
        return browserFailure('plan_stale', 'Browser entry changed during authorization');
    } else if (input.operation === 'describe' && phase === 'execute' && !claim) {
      await this.bootstrapBrowser(request, key);
      claim = this.browserClaims.get(key);
    }
    // 已批准计划在派发前失去授权时，必须重新授权和观察；普通读取仍报告宿主不可用。
    if (!claim || claim.socket.readyState !== 1) return action && phase === 'execute'
      ? browserFailure('plan_stale', 'Approved page authorization changed; authorize the page and observe again before a new action')
      : browserFailure('host_unavailable', 'No authorized live desktop page');
    if (claim.coreInstanceId !== coreInstanceId || claim.coreGeneration !== coreGeneration) {
      this.browserClaims.delete(key);
      return browserFailure('host_unavailable', 'Core deployment changed; authorize the page again');
    }
    if (scoped && phase === 'execute' && (!browserApproval?.plan || typeof browserApproval.plan.preparedActionId !== 'string'))
      return browserFailure('approval_required', 'Core approval metadata is required');
    if (input.operation === 'describe') return browserSuccess({ protocol: 'areal.browser.host.v1',
      browserHostId: claim.browserHostId, hostGeneration: claim.hostGeneration, available: true,
      operations: ['describe', 'observe', 'capture', 'act', 'wait', 'navigate', 'newPage', 'diagnostics', 'runBatch', 'command'],
      command: describeCommands(input.parameters.topic),
      instructions: 'Use navigate with a listed pageId and a URL to open a site, then observe to obtain current refs. Fill the search field and press Enter to submit an approved public search. describe creates or reuses the visible page after Core approval; no development service is needed. Human input revokes access; only a new explicit chat request can authorize re-entry.',
      parameterGuide: 'Invoke browser_v1 only when the current user task requires browser interaction. For ordinary chat and tasks that do not need a browser, do not call browser_v1 merely because it is available. Every new browser task starts with describe and empty parameters, then a fresh observe for an existing page; never reuse earlier-turn snapshotId or refs. Replace pageId with an ID from pages, snapshotId with the latest observe.observationId, and ref with a ref from that observation. act takes one nested action object. Observe again after fill before submitting with press Enter.',
      examples: [
        { operation: 'observe', parameters: { pageId: '<pageId>' } },
        { operation: 'act', parameters: { pageId: '<pageId>', snapshotId: '<observe.observationId>',
          action: { kind: 'fill', ref: '<ref>', value: '<search query>' } } },
        { operation: 'act', parameters: { pageId: '<pageId>', snapshotId: '<observe.observationId>',
          action: { kind: 'press', ref: '<ref>', key: 'Enter' } } },
        { operation: 'act', parameters: { pageId: '<pageId>', snapshotId: '<observe.observationId>',
          action: { kind: 'scroll', target: 'viewport', deltaX: 0, deltaY: 512 } } },
        { operation: 'act', parameters: { pageId: '<pageId>', snapshotId: '<observe.observationId>',
          action: { kind: 'selectOption', ref: '<native SELECT ref>', value: '<observed exact option value>' } } },
        { operation: 'diagnostics', parameters: { pageId: '<pageId>', kind: 'network', limit: 20 } },
      ],
      actions: { ref: ['click', 'fill', 'press', 'hover', 'selectOption', 'setChecked'],
        viewport: ['scroll'], scroll: '{kind:scroll,target:viewport,deltaX,deltaY}; nonzero safe integers in [-4096,4096]',
        selectOption: 'native single SELECT, exact observed unique enabled option value; semantic input/change events are not trusted physical input',
        setChecked: 'native checkbox boolean state; already equal is a confirmed no-op without input', screenshot: ['clickAt', 'drag', 'pressAt'],
        screenshotCoordinates: 'bitmap pixels from the latest viewport capture; capture observationId is snapshotId',
        keyboard: ['Enter', 'Tab', 'Escape', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] },
      waits: { timeoutMs: [1, 30000], conditions: ['documentReady', 'accessibleName', 'checked', 'enabled'],
        checked: '{kind:checked,ref,value:boolean}; original native checkbox, including disabled controls; zero input',
        enabled: '{kind:enabled,ref,value:boolean}; original native form control; zero input',
        documentReady: '{kind:documentReady,state:interactive|complete}',
        accessibleName: '{kind:accessibleName,ref,name}; exact current AX name; stale Ref refused',
        withoutCondition: 'bounded delay only; not page readiness' },
      ...(discoveryResult?.controlPermit ? { controlPermit: discoveryResult.controlPermit } : {}),
      pages: [...claim.pages.keys()] });
    const pageClaim = claim.pages.get(input.parameters.pageId);
    if (!pageClaim) return browserFailure('wrong_page', 'Page does not belong to this thread');
    const imagePageId = input.operation === 'command' ? input.parameters.command.tabId ?? pageClaim.pageId : pageClaim.pageId;
    const imagePageClaim = claim.pages.get(imagePageId);
    if (this.browserPending.size >= 8) return browserFailure('host_busy', 'Too many pending browser observations');
    if (signal?.aborted) throw new Error('Browser request was cancelled');
    const requestId = ++this.nextBrowserId;
    const trace = phase => { if (this.browserTestTrace) appendFileSync(this.browserTestTrace,
      JSON.stringify({ phase, requestId, threadId, callId }) + '\n'); };
    const result = await new Promise((resolve, reject) => {
      const finish = (kind, value) => { trace('finished'); clearTimeout(timer); signal?.removeEventListener('abort', onAbort); this.browserPending.delete(requestId); kind(value); };
      const cancelNative = () => this.send(claim.socket, { method: 'browserCancel', params: {
        requestId, projectId, threadId, pageId: pageClaim.pageId, hostGeneration: claim.hostGeneration } });
      const onAbort = () => { cancelNative(); finish(reject, new Error('Browser request was cancelled')); };
      const timeoutMs = phase === 'prepare' ? 10000 : input.operation === 'command' ? 125000 : input.operation === 'runBatch' ? 32000 : input.operation === 'wait'
        ? Math.min(35000, input.parameters.timeoutMs + 3000) : 15000;
      const timer = setTimeout(() => { cancelNative(); finish(reject, new Error('Browser host response unknown')); }, timeoutMs);
      this.browserPending.set(requestId, { socket: claim.socket, resolve: value => finish(resolve, value), reject: error => finish(reject, error), timer });
      trace('pending');
      signal?.addEventListener('abort', onAbort, { once: true });
      this.send(claim.socket, { method: 'browserRequest', params: { requestId, coreInstanceId, coreGeneration,
        projectId, threadId, turnId, callId, workspacePath: this.projectForThread(projectId, threadId)?.root,
        pageId: pageClaim.pageId, browserHostId: claim.browserHostId,
        hostGeneration: claim.hostGeneration, pageGeneration: pageClaim.pageGeneration,
        controlEpoch: pageClaim.controlEpoch, operation: input.operation, parameters: input.parameters,
        phase, ...(scoped && phase === 'execute' ? { browserApproval } : {}) } });
    });
    if (!result || typeof result !== 'object' || result.pageId !== pageClaim.pageId || result.callId !== callId
      || result.turnId !== turnId || result.threadId !== threadId || result.projectId !== projectId
      || result.coreInstanceId !== coreInstanceId || result.coreGeneration !== coreGeneration
      || result.browserHostId !== claim.browserHostId || result.hostGeneration !== claim.hostGeneration
      || result.pageGeneration !== pageClaim.pageGeneration || result.controlEpoch !== pageClaim.controlEpoch
      || JSON.stringify(result).length > (input.operation === 'command' ? 16 * 1024 * 1024 : input.operation === 'capture' ? 3 * 1024 * 1024 : 512 * 1024)) throw new Error('Invalid browser host response');
    const unknownBatch = () => ({ success: false,
      contentItems: [{ type: 'inputText', text: 'outcome_unknown: inspect the confirmed prefix before any new action' }],
      structuredContent: { code: 'outcome_unknown', dispatch: 'unknown', receipts: result.receipts ?? [],
        failedStep: result.failedStep, remaining: 'not_sent', remainingSteps: result.remainingSteps } });
    if ((this.browserClaims.get(key) !== claim || claim.pages.get(pageClaim.pageId) !== pageClaim)) {
      // Execute may already have reached native input. Revocation cannot turn
      // its receipt into a factual claim that nothing was sent.
      if (input.operation === 'runBatch' && phase === 'execute') return unknownBatch();
      if (action && phase === 'execute') throw new Error('Browser action outcome unknown after takeover');
      return browserFailure('human_control', 'Browser authorization was revoked');
    }
    const currentProject = this.projectForThread(projectId, threadId);
    if (currentProject?.service?.serviceId !== coreInstanceId || currentProject.service.generation !== coreGeneration) {
      if (input.operation === 'runBatch' && phase === 'execute') return unknownBatch();
      if (action && phase === 'execute') throw new Error('Browser action outcome unknown after deployment change');
      return browserFailure('host_unavailable', 'Core deployment changed during observation');
    }
    if (result.error) {
      if (input.operation === 'runBatch' && phase === 'execute' && result.error === 'outcome_unknown')
        return unknownBatch();
      if (action && phase === 'execute' && result.error === 'outcome_unknown')
        throw new Error('Browser action outcome unknown');
      if (phase === 'prepare') return { error: result.error, dispatch: 'not_sent' };
      const hint = { human_control: 'Human controls this page', plan_stale: 'Page or target changed; observe again before a new action',
        stale_ref: 'Target changed; observe again', human_takeover_required: 'Use human takeover for this page',
        not_sent: 'Target unavailable before input; observe again',
        condition_timeout: 'The requested page condition was not observed before timeout' }[result.error] ?? 'Page unavailable';
      if (input.operation === 'runBatch') return { ...browserFailure(result.error, hint),
        structuredContent: { code: result.error, dispatch: 'not_sent', receipts: result.receipts ?? [],
          failedStep: result.failedStep, remaining: 'not_sent', remainingSteps: result.remainingSteps } };
      return browserFailure(result.error, hint);
    }
    if (phase === 'prepare') {
      if (!result.plan || result.plan.pageId !== pageClaim.pageId || result.plan.operation !== input.operation)
        throw new Error('Invalid browser plan');
      return result.plan;
    }
    if (input.operation === 'command') {
      for (const pageId of [...(result.closedPageIds ?? []), ...(result.revokedPageIds ?? [])]) {
        if (typeof pageId !== 'string') throw new Error('Invalid closed browser page');
        claim.pages.delete(pageId);
        claim.revokedPages.add(pageId);
      }
      if (Array.isArray(result.controlPermits)) for (const permit of result.controlPermits) {
        if (permit?.browserHostId !== claim.browserHostId || permit.hostGeneration !== claim.hostGeneration
          || typeof permit.pageId !== 'string' || !Number.isSafeInteger(permit.pageGeneration)
          || !Number.isSafeInteger(permit.controlEpoch)) throw new Error('Invalid command page permit');
        if (!claim.revokedPages.has(permit.pageId)) claim.pages.set(permit.pageId,
          { pageId: permit.pageId, pageGeneration: permit.pageGeneration, controlEpoch: permit.controlEpoch });
      }
      const value = result.commandResult;
      if (!value || typeof value.ok !== 'boolean') throw new Error('Invalid browser command result');
      if (value.error?.sideEffect === 'uncertain') return {
        success: false, contentItems: [{ type: 'inputText', text: 'Browser command dispatch is unknown. Inspect before another action.' }],
        structuredContent: { code: 'outcome_unknown', dispatch: 'unknown', result: value } };
      const { image, ...metadata } = value;
      if (image) metadata.imageSource = imagePageClaim ? { ...imagePageClaim } : null;
      return this.toolResult(request, { isError: !value.ok, structuredContent: metadata,
        content: [{ type: 'text', text: JSON.stringify(metadata) },
          ...(image ? [{ type: 'image', data: image.base64, mimeType: image.mimeType }] : [])] },
        () => {
          const source = claim.pages.get(image ? imagePageId : pageClaim.pageId);
          const project = this.projectForThread(projectId, threadId);
          return this.browserClaims.get(key) === claim && claim.socket.readyState === 1
            && (!image && (result.closedPageIds?.includes(pageClaim.pageId) || result.revokedPageIds?.includes(pageClaim.pageId))
              || !claim.revokedPages.has(image ? imagePageId : pageClaim.pageId)
                && source?.pageGeneration === (image ? imagePageClaim?.pageGeneration : pageClaim.pageGeneration)
                && source?.controlEpoch === (image ? imagePageClaim?.controlEpoch : pageClaim.controlEpoch)
                && !!source)
            && project?.service?.serviceId === coreInstanceId
            && project.service.generation === coreGeneration;
        });
    }
    if (action) {
      if (input.operation === 'newPage' && result.createdPage) {
        const child = result.createdPage;
        if (typeof child.pageId !== 'string' || !Number.isSafeInteger(child.pageGeneration)
          || !Number.isSafeInteger(child.controlEpoch) || claim.pages.has(child.pageId))
          throw new Error('Invalid created browser page');
        if (!claim.revokedPages.has(child.pageId)) claim.pages.set(child.pageId, {
          pageId: child.pageId, pageGeneration: child.pageGeneration, controlEpoch: child.controlEpoch });
      }
      return { ...browserSuccess(result), structuredContent: result };
    }
    if (input.operation === 'capture') {
      if (signal?.aborted || (this.browserClaims.get(key) !== claim || claim.pages.get(pageClaim.pageId) !== pageClaim) || claim.socket.readyState !== 1)
        return browserFailure('human_control', 'Browser authorization was revoked during capture');
      if (result.mimeType !== 'image/png' || typeof result.imageBase64 !== 'string'
        || result.imageBase64.length > 2_800_000 || typeof toolHostGeneration !== 'string')
        throw new Error('Invalid browser image');
      const bytes = Buffer.from(result.imageBase64, 'base64');
      if (!bytes.length || bytes.length > 2 * 1024 * 1024 || bytes.toString('base64') !== result.imageBase64)
        throw new Error('Invalid browser image');
      const project = this.projectForThread(projectId, threadId);
      const url = new URL(project.endpoint);
      url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
      url.pathname = '/areal/blobs'; url.search = '';
      url.searchParams.set('threadId', threadId);
      url.searchParams.set('callId', callId);
      url.searchParams.set('hostGeneration', toolHostGeneration);
      const uploaded = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${project.token}`, 'Content-Type': 'image/png' },
        body: bytes, redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!uploaded.ok) throw new Error(`Browser evidence upload failed (${uploaded.status})`);
      const media = await uploaded.json();
      if (signal?.aborted || (this.browserClaims.get(key) !== claim || claim.pages.get(pageClaim.pageId) !== pageClaim) || claim.socket.readyState !== 1)
        return browserFailure('human_control', 'Browser authorization was revoked during capture');
      const current = this.projectForThread(projectId, threadId);
      if (current?.service?.serviceId !== coreInstanceId || current.service.generation !== coreGeneration)
        return browserFailure('host_unavailable', 'Core deployment changed during capture');
      const { imageBase64, ...metadata } = result;
      return { success: true, contentItems: [
        { type: 'inputText', text: JSON.stringify({ ...metadata, media }) },
        { type: 'arealMedia', modality: 'image', media },
      ] };
    }
    return browserSuccess(result);
  }
}
module.exports = { PROTOCOL, COMMAND_CONTRACT, DesktopService, validateCommand, encodeMedia, decodeMedia };
