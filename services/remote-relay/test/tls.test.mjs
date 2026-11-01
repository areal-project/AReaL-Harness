import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { request } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { startTlsProxy } from '../src/tls.mjs';
import { CertificateManager, startChallengeServer } from '../src/certificates.mjs';
import { AcmeClient, createAccountKey } from '../src/acme.mjs';
import { buildCsr, identifierFor } from '../src/csr.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'areal-relay-tls-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = join(dir, 'key.pem'); const cert = join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
    '-out', cert, '-days', '3', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
  return { dir, key: await readFile(key, 'utf8'), cert: await readFile(cert, 'utf8') };
}
async function listen(server) { await new Promise(r => server.listen(0, '127.0.0.1', r)); return server.address().port; }
function https(proxy, ca, host = 'localhost') {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: proxy.port, path: '/healthz', servername: 'localhost', ca,
      headers: { host, origin: 'https://localhost' }, agent: false }, res => {
      let body = ''; res.on('data', b => { body += b; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    }); req.on('error', reject); req.end();
  });
}

test('HTTPS and WebSocket preserve Host/Origin and shutdown closes open tunnels', async t => {
  const f = await fixture(t);
  const backend = createServer((req, res) => res.end(JSON.stringify({ host: req.headers.host, origin: req.headers.origin })));
  const wsServer = new WebSocketServer({ server: backend });
  wsServer.on('connection', (ws, req) => { ws.send(JSON.stringify(req.headers)); ws.on('message', data => ws.send(data)); });
  const upstreamPort = await listen(backend);
  t.after(() => new Promise(r => { wsServer.close(); backend.close(r); backend.closeAllConnections(); }));
  const proxy = await startTlsProxy({ publicOrigin: 'https://localhost', upstreamPort, host: '127.0.0.1', port: 0, cert: f.cert, key: f.key });
  t.after(() => proxy.close());
  assert.deepEqual(await https(proxy, f.cert), { status: 200, body: JSON.stringify({ host: 'localhost', origin: 'https://localhost' }) });
  assert.equal((await https(proxy, f.cert, 'evil.invalid')).status, 421);
  await assert.rejects(https(proxy), /self-signed|self signed/i);
  const ws = new WebSocket(`wss://127.0.0.1:${proxy.port}/socket`, { ca: f.cert, servername: 'localhost', headers: { host: 'localhost' }, origin: 'https://localhost' });
  const received = new Promise((resolve, reject) => { ws.once('message', data => resolve(JSON.parse(data.toString()))); ws.once('error', reject); });
  const headers = await received;
  assert.equal(headers.host, 'localhost'); assert.equal(headers.origin, 'https://localhost');
  const echoed = new Promise(resolve => ws.once('message', data => resolve(data.toString())));
  ws.send('opaque'); assert.equal(await echoed, 'opaque');
  const closed = new Promise(resolve => ws.once('close', resolve));
  await proxy.close(); await closed;
  await proxy.close();
});

test('ACME fixture issues, persists, reloads and renews a matching certificate', async t => {
  const f = await fixture(t);
  let authority; let origin; let issued; let serial = 0; let authorized = false;
  const challenges = new Map();
  const challenge = await startChallengeServer({ host: '127.0.0.1', port: 0, challenges });
  t.after(() => challenge.close());
  let challengePort = challenge.port;
  authority = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const payload = raw ? JSON.parse(raw).payload : '';
    const body = payload ? JSON.parse(Buffer.from(payload, 'base64url')) : {};
    res.setHeader('replay-nonce', `nonce-${++serial}`);
    res.setHeader('content-type', 'application/json');
    const json = (value, status = 200) => { res.statusCode = status; res.end(JSON.stringify(value)); };
    if (req.url === '/directory') return json({ newNonce: `${origin}/nonce`, newAccount: `${origin}/account`, newOrder: `${origin}/order-new` });
    if (req.url === '/nonce') return res.end();
    if (req.url === '/account') { res.setHeader('location', `${origin}/account/1`); return json({}, 201); }
    if (req.url === '/order-new') { issued = undefined; authorized = false; res.setHeader('location', `${origin}/order`); return json({ authorizations: [`${origin}/auth`], finalize: `${origin}/finalize` }, 201); }
    if (req.url === '/auth') return json(authorized ? { status: 'valid' } : { challenges: [{ type: 'http-01', token: 'test-token', url: `${origin}/challenge` }] });
    if (req.url === '/challenge') {
      const response = await fetch(`http://127.0.0.1:${challengePort}/.well-known/acme-challenge/test-token`);
      assert.equal(response.status, 200); assert.match(await response.text(), /^test-token\./); authorized = true; return json({});
    }
    if (req.url === '/order') return json(issued ? { status: 'valid', certificate: `${origin}/certificate` } : { status: 'ready' });
    if (req.url === '/finalize') {
      const csr = join(f.dir, 'request.der'); const cert = join(f.dir, 'issued.pem');
      await writeFile(csr, Buffer.from(body.csr, 'base64url'));
      execFileSync('openssl', ['x509', '-req', '-inform', 'DER', '-in', csr, '-CA', join(f.dir, 'cert.pem'), '-CAkey', join(f.dir, 'key.pem'),
        '-set_serial', String(serial), '-days', '3', '-copy_extensions', 'copy', '-out', cert], { stdio: 'ignore' });
      issued = await readFile(cert, 'utf8'); return json({});
    }
    if (req.url === '/certificate') return res.end(issued);
    res.statusCode = 404; res.end();
  });
  origin = `http://127.0.0.1:${await listen(authority)}`;
  t.after(() => new Promise(r => { authority.close(r); authority.closeAllConnections(); }));
  const originalNow = Date.now;
  let offset = 0;
  const now = () => originalNow() + offset;
  const options = { dataDir: join(f.dir, 'data'), identifier: { type: 'dns', value: 'localhost' }, directoryUrl: `${origin}/directory`,
    logger: { info() {}, error() {} }, now };
  const manager = new CertificateManager(options);
  manager.challenges = challenges;
  const first = await manager.obtain();
  assert.ok(first.cert.includes('BEGIN CERTIFICATE'));
  assert.equal((await stat(join(options.dataDir, 'tls/material.json'))).mode & 0o777, 0o600);
  assert.equal((await new CertificateManager(options).load()).cert, first.cert);
  assert.equal(manager.needsRenewal(first), false);
  offset = first.notAfter - 60_000 - originalNow();
  assert.equal(manager.needsRenewal(first), true);
  offset = 0;
  const second = await manager.obtain();
  assert.notEqual(second.key, first.key);
  assert.equal((await new CertificateManager(options).load()).cert, second.cert);
  const backend = createServer((_req, res) => res.end('healthy'));
  const upstreamPort = await listen(backend);
  t.after(() => new Promise(r => { backend.close(r); backend.closeAllConnections(); }));
  Date.now = now;
  let proxy;
  try {
    proxy = await startTlsProxy({ publicOrigin: 'https://localhost', upstreamPort, dataDir: options.dataDir,
      host: '127.0.0.1', port: 0, acmeHttpPort: 0, directoryUrl: options.directoryUrl });
    t.after(() => proxy.close());
    const status = await readFile(join(options.dataDir, 'status.json'), 'utf8');
    assert.equal(JSON.parse(status).certificate.state, 'ready');
    challengePort = proxy.challengePort;
    const peerSerial = () => new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: proxy.port, servername: 'localhost', ca: f.cert,
        headers: { host: 'localhost' }, agent: false }, res => {
        const serial = res.socket.getPeerCertificate().serialNumber;
        res.resume(); res.on('end', () => resolve(serial));
      }); req.on('error', reject); req.end();
    });
    const initialSerial = await peerSerial();
    offset = second.notAfter - 60_000 - originalNow();
    assert.equal(await proxy.renew(), true);
    assert.notEqual(await peerSerial(), initialSerial);
    assert.notEqual((await new CertificateManager(options).load()).key, second.key);
  } finally {
    Date.now = originalNow;
    await proxy?.close();
  }
  assert.equal(await new CertificateManager({ ...options, identifier: { type: 'dns', value: 'other.invalid' } }).load(), null);
  const stored = JSON.parse(await readFile(join(options.dataDir, 'tls/material.json'), 'utf8'));
  stored.identifier.value = 'other.invalid';
  await writeFile(join(options.dataDir, 'tls/material.json'), JSON.stringify(stored));
  assert.equal(await new CertificateManager({ ...options, identifier: stored.identifier }).load(), null);
});

test('failed startup releases challenge listener and ACME polling is cancellable', async t => {
  const f = await fixture(t);
  const probe = createServer(); const port = await listen(probe); await new Promise(r => probe.close(r));
  const authority = createServer((req, res) => { res.writeHead(400); res.end('{}'); });
  const directoryUrl = `http://127.0.0.1:${await listen(authority)}/directory`;
  t.after(() => new Promise(r => { authority.close(r); authority.closeAllConnections(); }));
  await assert.rejects(startTlsProxy({ publicOrigin: 'https://localhost', upstreamPort: 1234, host: '127.0.0.1', port: 0,
    dataDir: f.dir, acmeHttpPort: port, directoryUrl }), /directory unavailable/);
  const replacement = createServer(); await new Promise((resolve, reject) => { replacement.once('error', reject); replacement.listen(port, '127.0.0.1', resolve); });
  await new Promise(r => replacement.close(r));
  const abort = new AbortController();
  const client = new AcmeClient({ directoryUrl, accountKey: createAccountKey(), signal: abort.signal,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })) });
  const pending = client.obtainCertificate({ type: 'dns', value: 'localhost' }, new Map());
  abort.abort(); await assert.rejects(pending, /abort/i);
});

test('CSR encodes DNS, IPv4, IPv6 and IPv4-mapped IPv6 subject alternatives', () => {
  for (const [address, expected] of [['relay.example', 'DNS:relay.example'], ['192.0.2.1', 'IP Address:192.0.2.1'],
    ['2001:db8::1', 'IP Address:2001:DB8:0:0:0:0:0:1'], ['::ffff:192.0.2.1', 'IP Address:0:0:0:0:0:FFFF:C000:201']]) {
    const csr = buildCsr(createAccountKey(), identifierFor(address));
    const text = execFileSync('openssl', ['req', '-inform', 'DER', '-noout', '-text', '-verify'], { input: csr, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    assert.ok(text.includes(expected), `SAN for ${address}`);
  }
});
