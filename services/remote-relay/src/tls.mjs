import { createServer } from 'node:https';
import { request } from 'node:http';
import { CertificateManager, startChallengeServer } from './certificates.mjs';
import { identifierFor } from './csr.mjs';

const quietLogger = { info() {}, error() {} };

export async function startTlsProxy({ publicOrigin, upstreamHost = '127.0.0.1', upstreamPort,
  host = '0.0.0.0', port = 443, dataDir, acmeHttpPort = 80, directoryUrl, cert, key,
  logger = quietLogger }) {
  const origin = new URL(publicOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== publicOrigin) throw new Error('TLS requires an HTTPS public origin');
  if (!['127.0.0.1', '::1', 'localhost'].includes(upstreamHost)) throw new Error('TLS upstream must be loopback');
  if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535) throw new Error('Invalid TLS upstream port');
  if (Boolean(cert) !== Boolean(key)) throw new Error('TLS certificate and key must be supplied together');
  if (!cert && !dataDir) throw new Error('Automatic TLS requires a data directory');
  const abort = new AbortController();
  const sockets = new Set();
  const requests = new Set();
  const identifier = identifierFor(origin.hostname.replace(/^\[|\]$/g, ''));
  const manager = cert ? null : new CertificateManager({ dataDir, identifier, directoryUrl, logger, signal: abort.signal });
  let challenge;
  let server;
  let timer;
  let material;
  let renewal;
  let closing;
  const track = socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  const close = () => closing ??= (async () => {
    abort.abort();
    clearInterval(timer);
    for (const req of requests) req.destroy();
    const closed = server ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
    for (const socket of sockets) socket.destroy();
    await Promise.all([closed, challenge?.close(), renewal?.catch(() => {})]);
  })();
  const renew = () => {
    if (!manager || abort.signal.aborted) return Promise.resolve(false);
    return renewal ??= (async () => {
      if (!manager.needsRenewal(material)) return false;
      const next = await manager.obtain();
      abort.signal.throwIfAborted();
      server.setSecureContext({ cert: next.cert, key: next.key });
      material = next;
      return true;
    })().finally(() => { renewal = undefined; });
  };
  const upstream = req => {
    const outgoing = request({ hostname: upstreamHost, port: upstreamPort, method: req.method,
      path: req.url, headers: req.headers, agent: false });
    requests.add(outgoing);
    outgoing.once('close', () => requests.delete(outgoing));
    outgoing.on('socket', track);
    return outgoing;
  };
  try {
    if (manager) {
      challenge = await startChallengeServer({ host, port: acmeHttpPort, challenges: manager.challenges });
      material = await manager.load() ?? await manager.obtain();
    } else {
      material = { cert, key };
    }
    server = createServer({ cert: material.cert, key: material.key }, (req, res) => {
      if (req.headers.host !== origin.host) {
        res.writeHead(421, { connection: 'close' }); res.end(); return;
      }
      const outgoing = upstream(req);
      outgoing.on('response', incoming => {
        res.writeHead(incoming.statusCode, incoming.headers);
        incoming.on('error', () => res.destroy());
        incoming.pipe(res);
      });
      outgoing.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      res.on('close', () => outgoing.destroy());
      req.on('aborted', () => outgoing.destroy());
      req.pipe(outgoing);
    });
    server.on('connection', track);
    server.on('upgrade', (req, socket, head) => {
      if (req.headers.host !== origin.host) {
        socket.end('HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\n\r\n'); return;
      }
      const outgoing = upstream(req);
      socket.on('error', () => outgoing.destroy());
      socket.on('close', () => outgoing.destroy());
      outgoing.on('error', () => socket.destroy());
      outgoing.on('response', response => {
        response.resume();
        socket.end(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\nConnection: close\r\n\r\n`);
      });
      outgoing.on('upgrade', (response, peer, peerHead) => {
        track(peer);
        peer.on('error', () => socket.destroy());
        peer.on('close', () => socket.destroy());
        socket.on('close', () => peer.destroy());
        socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`);
        for (let i = 0; i < response.rawHeaders.length; i += 2) socket.write(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`);
        socket.write('\r\n');
        if (peerHead.length) socket.write(peerHead);
        if (head.length) peer.write(head);
        socket.pipe(peer).pipe(socket);
      });
      outgoing.end();
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolve(); });
    });
    if (manager) {
      timer = setInterval(() => { renew().catch(error => logger.error('TLS renewal failed', { reason: error.message })); }, 3600_000);
      timer.unref();
      renew().catch(error => logger.error('TLS renewal failed', { reason: error.message }));
    }
    return { server, port: server.address().port, challengePort: challenge?.port, close, renew };
  } catch (error) {
    await close();
    throw error;
  }
}
