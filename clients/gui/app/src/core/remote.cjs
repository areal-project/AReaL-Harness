'use strict';
const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const WebSocket = require('ws');
const QRCode = require('qrcode');
const { projectSnapshot, remoteCommand } = require('./remote-projection.cjs');

class RemoteControl {
  constructor(service, encryption) {
    this.service = service; this.backend = service.backend; this.encryption = encryption;
    this.channels = new Map(); this.pending = new Map(); this.connected = false;
  }
  async init() {
    this.crypto = await import('@areal/remote');
    try {
      const data = JSON.parse(await readFile(join(this.backend.home, 'remote.json'), 'utf8'));
      this.config = JSON.parse(this.encryption.decryptString(Buffer.from(data.encrypted, 'base64')));
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取手机配对；请检查系统钥匙串'); }
    this.config ??= { enabled: false, devices: [] };
    if (this.config.enabled) this.connect();
  }
  async save(config) {
    if (!this.encryption.isEncryptionAvailable() || this.encryption.getSelectedStorageBackend?.() === 'basic_text') throw new Error('系统安全存储不可用');
    await this.backend.save('remote.json', { encrypted: this.encryption.encryptString(JSON.stringify(config)).toString('base64') });
    this.config = config;
  }
  state() { return { enabled: this.config?.enabled === true, connected: this.connected, relay: this.config?.relay ?? '',
    devices: this.config?.devices ?? [], pending: [...this.pending].map(([id, entry]) => ({ id, name: entry.name, fingerprint: id.slice(-16) })) }; }
  control(request) {
    // Pairing and revocation are serialized with durable configuration writes.
    const task = (this.writes ?? Promise.resolve()).catch(() => {}).then(() => this.controlOnce(request));
    this.writes = task; return task;
  }
  async controlOnce(request) {
    switch (request.operation) {
      case 'status': return this.state();
      case 'enable': {
        const relay = this.crypto.relayUrl(request.relay);
        const identity = this.config.identity ?? await this.crypto.createIdentity();
        const capability = this.config.capability ?? randomBytes(32).toString('hex');
        await this.save({ ...this.config, enabled: true, relay, identity, capability, room: createHash('sha256').update(capability).digest('hex') });
        this.disconnect(); this.connect(); break;
      }
      case 'disable': await this.save({ ...this.config, enabled: false }); this.disconnect(); break;
      case 'pair': {
        if (!this.connected) throw new Error('请先连接中继');
        this.invite = { secret: randomBytes(32).toString('hex'), expiresAt: Date.now() + 120000 };
        const payload = JSON.stringify({ version: 1, relay: this.config.relay, room: this.config.room,
          host: this.crypto.identityId(this.config.identity), ...this.invite });
        return { payload, qr: await QRCode.toDataURL(payload), expiresAt: this.invite.expiresAt };
      }
      case 'approve': {
        const entry = this.pending.get(request.id);
        if (!entry || entry.expiresAt < Date.now() || !this.channels.has(entry.channel)) throw new Error('配对请求已过期');
        if (!Array.isArray(request.projects) || !request.projects.length || request.projects.some(id => !this.backend.saved.some(project => project.id === id))) throw new Error('请至少选择一个已有项目');
        const device = { id: request.id, name: entry.name, projects: [...new Set(request.projects)] };
        await this.save({ ...this.config, devices: [...this.config.devices.filter(value => value.id !== device.id), device] });
        this.pending.delete(device.id); clearTimeout(entry.timer); entry.accept(device); break;
      }
      case 'revoke': {
        await this.save({ ...this.config, devices: this.config.devices.filter(device => device.id !== request.id) });
        for (const entry of this.channels.values()) if (entry.peer === request.id) entry.wire.close();
        break;
      }
      default: throw new Error('无效手机设置操作');
    }
    this.service.schedule(); return this.state();
  }
  connect() {
    if (!this.config.enabled || this.closed) return;
    const socket = this.socket = new WebSocket(this.config.relay, { maxPayload: 512 * 1024, perMessageDeflate: false });
    socket.on('error', () => {});
    const send = value => {
      if (socket.readyState !== 1 || socket.bufferedAmount > 8 * 1024 * 1024) throw new Error('中继连接不可用');
      socket.send(JSON.stringify(value));
    };
    socket.on('open', () => send({ protocol: 'areal.relay.v1', role: 'host', room: this.config.room, capability: this.config.capability }));
    socket.on('message', bytes => {
      try {
        const message = JSON.parse(bytes.toString());
        if (message.type === 'ready') { this.connected = true; this.service.schedule(); return; }
        if (message.type === 'open') {
          if (this.channels.size >= 16 || this.channels.has(message.channel)) throw new Error('Too many channels');
          const channel = message.channel;
          const wire = this.crypto.byteChannel(bytes => send({ type: 'data', channel, data: Buffer.from(bytes).toString('base64') }), () => {
            this.channels.delete(channel);
            try { send({ type: 'close', channel }); } catch {}
          });
          const entry = { wire, channel }; this.channels.set(channel, entry);
          void this.session(entry).catch(() => wire.close());
        } else if (message.type === 'data') this.channels.get(message.channel)?.wire.receive(Buffer.from(message.data, 'base64'));
        else if (message.type === 'close') this.channels.get(message.channel)?.wire.close();
      } catch { socket.close(1008); }
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.connected = false; this.clearChannels(); this.service.schedule();
      if (this.config.enabled && !this.closed) this.retry = setTimeout(() => this.connect(), 3000);
    });
  }
  async session(entry) {
    const secure = await this.crypto.secureChannel(entry.wire, this.config.identity);
    entry.peer = secure.peer;
    const messages = secure.messages();
    const helloTimer = setTimeout(() => entry.wire.close(), 15000);
    let greeting;
    try { greeting = await messages.next(); } finally { clearTimeout(helloTimer); }
    if (greeting.done || greeting.value.method !== 'hello') throw new Error('Missing hello');
    let device = this.config.devices.find(value => value.id === secure.peer);
    if (!device) {
      const secret = greeting.value.secret;
      if (!this.invite || this.invite.expiresAt < Date.now() || typeof secret !== 'string' || secret.length !== 64 || !timingSafeEqual(Buffer.from(secret), Buffer.from(this.invite.secret))) throw new Error('Invalid invitation');
      const expiresAt = this.invite.expiresAt; this.invite = null;
      const name = String(greeting.value.name ?? '手机').slice(0, 80);
      secure.send({ event: 'pairing', fingerprint: secure.peer.slice(-16) });
      device = await new Promise((accept, reject) => {
        const timer = setTimeout(() => { this.pending.delete(secure.peer); reject(new Error('配对过期')); }, Math.max(1, expiresAt - Date.now()));
        this.pending.set(secure.peer, { name, expiresAt, channel: entry.channel, accept, reject, timer });
      });
    }
    secure.send({ event: 'ready', snapshot: projectSnapshot(this.backend, device) });
    entry.publish = () => secure.send({ event: 'state', snapshot: projectSnapshot(this.backend, device) });
    for await (const message of messages) {
      // Re-check revocation at every admission. Core owns already accepted work.
      if (!this.config.devices.some(value => value.id === device.id)) break;
      if (typeof message.id !== 'string' || message.id.length > 64 || typeof message.method !== 'string') break;
      try { secure.send({ id: message.id, result: await remoteCommand(this.service, device, message) }); }
      catch (error) { secure.send({ id: message.id, error: { message: this.backend.providers.redact(error.message), submissionUnknown: error.submissionUnknown === true } }); }
    }
    secure.close();
  }
  publish() {
    if (this.publishTimer) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      for (const entry of this.channels.values()) try { entry.publish?.(); } catch { entry.wire.close(); }
    }, 200);
  }
  clearChannels() {
    for (const entry of this.channels.values()) entry.wire.close();
    this.channels.clear();
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('连接断开')); }
    this.pending.clear();
  }
  disconnect() {
    clearTimeout(this.retry); clearTimeout(this.publishTimer); this.publishTimer = null; const socket = this.socket; this.socket = null;
    this.connected = false; this.invite = null; this.clearChannels(); socket?.terminate();
  }
  close() { this.closed = true; this.disconnect(); }
}
module.exports = { RemoteControl };
