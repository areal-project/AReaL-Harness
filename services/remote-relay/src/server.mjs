import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { attachRelay, bucket } from './relay.mjs';
import { createPush } from './push.mjs';

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
export async function serve(config, store, pushOptions, logger) {
  const push = config.apns ? createPush(config.apns, pushOptions) : undefined;
  const enrollBudget = bucket(config.enrollPerSecond); const requestBudget = bucket(200);
  const log = entry => { const record = { time: new Date().toISOString(), ...entry }; if (logger) logger(record); else console.log(JSON.stringify(record)); };
  const assets = config.assetsDir ? await realpath(config.assetsDir) : undefined;
  const headerTimers = new Map();
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 15000, headersTimeout: 10000, keepAliveTimeout: 5000 }, async (req, res) => {
    clearTimeout(headerTimers.get(req.socket)); headerTimers.delete(req.socket);
    const deadline = setTimeout(() => req.destroy(), 15000); deadline.unref();
    res.once('close', () => clearTimeout(deadline));
    const reply = (status, value) => { if (res.destroyed) return; res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    if (!config.development && !config.local) res.setHeader('strict-transport-security', 'max-age=31536000');
    if (req.headers.host !== config.publicHost) return reply(421, { error: 'UNAVAILABLE' });
    if (!requestBudget(0)) return reply(429, { error: 'LIMIT_EXCEEDED' });
    if (req.method === 'GET' && req.url === '/healthz') return reply(200, { ok: true });
    if (req.method === 'POST' && req.url === '/enroll') {
      if (config.local) return reply(403, { error: 'UNAVAILABLE' });
      if (!enrollBudget(0)) return reply(429, { error: 'LIMIT_EXCEEDED' });
      if (req.headers.origin !== undefined || req.headers['content-type'] !== 'application/json') return reply(403, { error: 'UNAVAILABLE' });
      if (+req.headers['content-length'] > 1024) { reply(413, { error: 'LIMIT_EXCEEDED' }); req.resume(); return; }
      try {
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > 1024) { reply(413, { error: 'LIMIT_EXCEEDED' }); req.destroy(); return; } chunks.push(chunk); }
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const registration = body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 1 ? store.enroll(body.code) : null;
        return reply(registration ? 201 : 403, registration ?? { error: 'UNAVAILABLE' });
      } catch { return reply(400, { error: 'INVALID_REQUEST' }); }
    }
    if (req.method === 'GET' && assets) {
      try {
        const path = decodeURIComponent(req.url);
        if (path.includes('?') || path.includes('#') || path.includes('\\') || path.split('/').some(p => p.startsWith('.'))) throw new Error();
        const file = await realpath(resolve(assets, path === '/' ? 'remote.html' : `.${path}`));
        const info = await stat(file);
        if (!file.startsWith(assets + sep) || !info.isFile() || !types[extname(file)] || info.size > 16 * 1024 * 1024) throw new Error();
        res.writeHead(200, { 'content-type': types[extname(file)], 'content-length': info.size });
        const stream = createReadStream(file); stream.on('error', () => res.destroy()); res.once('close', () => stream.destroy()); stream.pipe(res); return;
      } catch {}
    }
    reply(404, { error: 'UNAVAILABLE' });
  });
  const sockets = new Set();
  server.on('connection', socket => {
    if (sockets.size >= config.maxConnections) { socket.destroy(); return; }
    sockets.add(socket); socket.setTimeout(15000, () => socket.destroy());
    const timer = setTimeout(() => socket.destroy(), 10000); timer.unref(); headerTimers.set(socket, timer);
    socket.once('close', () => { sockets.delete(socket); clearTimeout(headerTimers.get(socket)); headerTimers.delete(socket); });
  });
  server.on('upgrade', (_req, socket) => { clearTimeout(headerTimers.get(socket)); headerTimers.delete(socket); socket.setTimeout(0); });
  server.maxRequestsPerSocket = 100;
  server.on('clientError', (_error, socket) => socket.destroy());
  const stopRelay = attachRelay(server, config, store, log, push);
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.listenPort, config.listenHost, resolve); }); }
  catch (error) { stopRelay(); push?.close(); throw error; }
  return { close: () => new Promise(r => { stopRelay(); push?.close(); server.close(r); for (const socket of sockets) socket.destroy(); }) };
}
