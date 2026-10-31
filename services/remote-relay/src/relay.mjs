import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { hash } from './store.mjs';
import { isPushRequest } from './push.mjs';

export function bucket(count, bytes = Infinity) {
  let start = Date.now(); let n = 0; let size = 0;
  return amount => { if (Date.now() - start >= 1000) { start = Date.now(); n = 0; size = 0; } return ++n <= count && (size += amount) <= bytes; };
}
const fields = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => names.includes(k));
const roomShape = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function attachRelay(server, config, store, log, push) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxFrameBytes, perMessageDeflate: false, maxFragments: 128, maxBufferedChunks: 128, clientTracking: false });
  const peers = new Set(); const hosts = new Map(); let pending = 0;
  const upgrades = bucket(config.upgradePerSecond);
  function emit(peer, message) {
    if (!peer?.alive || peer.ws.readyState !== WebSocket.OPEN) return false;
    const text = JSON.stringify(message); const size = Buffer.byteLength(text);
    if (size > config.maxFrameBytes || peer.ws.bufferedAmount + size > config.maxBufferedBytesPerChannel) { drop(peer, 'LIMIT_EXCEEDED'); return false; }
    peer.ws.send(text, error => { if (error) drop(peer, 'UNAVAILABLE'); });
    return true;
  }
  function detach(peer) {
    if (!peer.alive) return;
    peer.alive = false; peers.delete(peer); clearTimeout(peer.timer);
    if (!peer.role) pending--;
    if (peer.role === 'host') {
      if (hosts.get(peer.room) === peer) hosts.delete(peer.room);
      for (const client of [...peer.channels.values()]) drop(client, 'UNAVAILABLE', true);
      peer.channels.clear();
    } else if (peer.role === 'client') {
      peer.host.channels.delete(peer.channel);
      emit(peer.host, { type: 'close', channel: peer.channel });
    }
  }
  function drop(peer, code = 'UNAVAILABLE', channelClose = false) {
    if (!peer?.alive) return;
    // 先撤掉所有权，避免关闭握手期间继续转发旧连接的数据。
    detach(peer);
    if (peer.ws.readyState === WebSocket.OPEN && peer.ws.bufferedAmount < config.maxBufferedBytesPerChannel) {
      peer.ws.send(JSON.stringify(channelClose ? { type: 'close', channel: peer.channel } : { type: 'error', code }));
      peer.ws.close(1008);
      const timer = setTimeout(() => peer.ws.terminate(), 100); timer.unref();
    } else peer.ws.terminate();
    log({ event: 'closed', route: peer.id, code });
  }
  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    if (req.url !== '/remote/socket' || req.headers.host !== config.publicHost ||
        (origin !== undefined && !config.allowedClientOrigins.includes(origin) && !config.allowedAppOrigins.includes(origin)) ||
        peers.size >= config.maxConnections || pending >= config.maxPending || !upgrades(0)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', () => socket.destroy()); return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      const peer = { id: randomUUID(), ws, origin, pushCapable: req.headers['x-areal-relay-capabilities'] === 'push', alive: true, lastPong: Date.now(), lastPing: Date.now(), channels: new Map(), budget: bucket(config.framesPerSecond, config.bytesPerSecond) };
      peers.add(peer); pending++;
      peer.timer = setTimeout(() => drop(peer, 'TIMEOUT'), config.handshakeTimeoutMs); peer.timer.unref();
      ws.on('error', () => drop(peer, 'INVALID_FRAME'));
      ws.on('close', () => detach(peer));
      ws.on('pong', data => { if (!peer.budget(data.length)) return drop(peer, 'LIMIT_EXCEEDED'); peer.lastPong = Date.now(); });
      ws.on('ping', data => { if (!peer.budget(data.length)) drop(peer, 'LIMIT_EXCEEDED'); });
      ws.on('message', (raw, binary) => {
        if (!peer.alive) return;
        if (binary || raw.length > config.maxFrameBytes || !peer.budget(raw.length)) return drop(peer, 'LIMIT_EXCEEDED');
        let message;
        try { message = JSON.parse(raw.toString('utf8')); } catch { return drop(peer, 'INVALID_FRAME'); }
        if (!peer.role) {
          if (!fields(message, ['protocol', 'role', 'room', 'capability']) || message.protocol !== 'areal.relay.v1' || !roomShape(message.room)) return drop(peer, 'UNAVAILABLE');
          if (message.role === 'host') {
            if (config.local && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return drop(peer, 'UNAVAILABLE');
            if (peer.origin !== undefined || typeof message.capability !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(message.capability) || hash(message.capability) !== message.room || !store.room(message.room)) return drop(peer, 'UNAVAILABLE');
            const previous = hosts.get(message.room);
            if (!previous && hosts.size >= config.maxHosts) return drop(peer, 'CAPACITY_EXCEEDED');
            if (previous) drop(previous, 'REPLACED');
            peer.role = 'host'; peer.room = message.room; hosts.set(peer.room, peer);
            pending--; clearTimeout(peer.timer); emit(peer, { type: 'ready', ...(peer.pushCapable ? { push: Boolean(push) } : {}), limits: { framesPerSecond: config.framesPerSecond, bytesPerSecond: config.bytesPerSecond, maxFrameBytes: config.maxFrameBytes, heartbeatIntervalMs: Math.min(15000, config.idleTimeoutMs / 3) } });
          } else if (message.role === 'client') {
            const host = hosts.get(message.room); const registration = store.room(message.room);
            if (message.capability !== undefined || (!config.allowedClientOrigins.includes(peer.origin) && !config.allowedAppOrigins.includes(peer.origin)) || !host?.alive || !registration) return drop(peer, 'UNAVAILABLE');
            if (host.channels.size >= Math.min(registration.max_channels, config.maxChannelsPerHost)) return drop(peer, 'CAPACITY_EXCEEDED');
            peer.role = 'client'; peer.host = host; peer.room = message.room; peer.channel = randomUUID();
            host.channels.set(peer.channel, peer); pending--; clearTimeout(peer.timer);
            if (!emit(peer, { type: 'ready', channel: peer.channel })) return;
            emit(host, { type: 'open', channel: peer.channel });
          } else drop(peer, 'UNAVAILABLE');
          return;
        }
        if (!store.room(peer.room)) return drop(peer.role === 'host' ? peer : peer.host, 'UNAVAILABLE');
        if (message?.type === 'push') {
          if (peer.role !== 'host' || hosts.get(peer.room) !== peer || !isPushRequest(message)) return drop(peer, 'INVALID_FRAME');
          if (!push) { emit(peer, { type: 'error', code: 'UNAVAILABLE' }); return; }
          void push.send(peer.room, message).then(result => {
            if (result.code) { emit(peer, { type: 'error', code: result.code }); return; }
            log({ route: peer.id, kind: message.kind, status: result.status });
            const current = hosts.get(peer.room);
            if (result.unregistered && current?.pushCapable && store.room(peer.room)) emit(current, { type: 'pushResult', token: message.token, status: 'unregistered' });
          });
          return;
        }
        if (!fields(message, ['type', 'channel', 'data']) || typeof message.channel !== 'string') return drop(peer, 'INVALID_FRAME');
        const target = peer.role === 'host' ? peer.channels.get(message.channel) : message.channel === peer.channel ? peer.host : undefined;
        if ((peer.role === 'host' && hosts.get(peer.room) !== peer) || (peer.role === 'client' && hosts.get(peer.room) !== peer.host)) return drop(peer, 'UNAVAILABLE');
        if (!target?.alive) {
          // Host 可能尚未收到 close，或回送 wire.close()；只拒绝该帧，不能拖掉其他设备。
          if (peer.role === 'host') emit(peer, { type: 'error', code: 'UNAVAILABLE' });
          else drop(peer, 'UNAVAILABLE');
          return;
        }
        if (message.type === 'close' && message.data === undefined) { drop(peer.role === 'host' ? target : peer, 'UNAVAILABLE', true); return; }
        // 无需解码 opaque Noise 数据；在任何解码分配前限制 base64 长度并校验编码。
        if (message.type !== 'data' || typeof message.data !== 'string' || message.data.length === 0 || message.data.length > config.maxFrameBytes - 128 || message.data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.data)) return drop(peer, 'INVALID_FRAME');
        emit(target, { type: 'data', channel: message.channel, data: message.data });
      });
    });
  });
  const heartbeat = setInterval(() => {
    for (const peer of peers) {
      if (Date.now() - peer.lastPong > config.idleTimeoutMs) drop(peer, 'TIMEOUT');
      else if (peer.role === 'host' && !store.room(peer.room)) drop(peer, 'UNAVAILABLE');
      else if (peer.ws.readyState === WebSocket.OPEN && Date.now() - peer.lastPing >= Math.min(15000, config.idleTimeoutMs / 3)) { peer.lastPing = Date.now(); peer.ws.ping(); }
    }
  }, Math.min(15000, config.idleTimeoutMs / 3, 1000));
  heartbeat.unref();
  return () => { clearInterval(heartbeat); for (const peer of [...peers]) { detach(peer); peer.ws.terminate(); } wss.close(); };
}
