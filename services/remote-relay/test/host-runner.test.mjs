import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, access, open } from 'node:fs/promises';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { parseConfig } from '../src/config.mjs';
import { openStore } from '../src/store.mjs';
import { hash } from '../src/store.mjs';
import { WebSocket } from 'ws';

const owned = new Map();
async function cleanup(root) {
  const entry = owned.get(root);
  if (entry) {
    const { child, lease } = entry;
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    await lease.close();
  }
  await rm(root, { recursive: true, force: true });
}

async function freePort(host = '127.0.0.1') {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, host, resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function runner(root) {
  const lease = await open(join(root, 'host.lock'), 'w', 0o600);
  const child = spawn(
    process.execPath,
    [new URL('../src/host-runner.mjs', import.meta.url).pathname],
    {
      env: { ...process.env, AREAL_LOCAL_RELAY_LEASE_FD: '3' },
      stdio: ['pipe', 'pipe', 'pipe', lease.fd],
    },
  );
  child.stderr.resume();
  owned.set(root, { child, lease });
  return child;
}
function frame(root, port) {
  const origin = `http://192.168.1.8:${port}`;
  return {
    version: 1,
    room: 'a'.repeat(64),
    config: {
      local: true,
      publicOrigin: origin,
      listen: `127.0.0.1:${port}`,
      allowedClientOrigins: [origin],
      allowedAppOrigins: ['capacitor://localhost'],
      dataDir: root,
    },
  };
}
function health(port) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/healthz', headers: { host: `192.168.1.8:${port}` } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
    req.end();
  });
}
test(
  'Host runner serves local Relay until parent EOF and releases its lock',
  { timeout: 10000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'relay-host-'));
    t.after(() => cleanup(root));
    const port = await freePort(),
      child = await runner(root);
    const exit = once(child, 'exit');
    child.stdin.write(JSON.stringify(frame(root, port)) + '\n');
    const [chunk] = await once(child.stdout, 'data');
    assert.equal(chunk.toString(), '{"version":1,"event":"ready"}\n');
    assert.equal(await health(port), 200);
    assert.match(await readFile(join(root, 'server.lock'), 'utf8'), /"pid":/);
    child.stdin.end();
    assert.deepEqual(await exit, [0, null]);
    await assert.rejects(access(join(root, 'server.lock')), { code: 'ENOENT' });
    await assert.rejects(health(port));
  },
);
test(
  'pinned local Relay separates TLS client access from loopback Host registration',
  { timeout: 12000 },
  async (t) => {
    const address = Object.values(networkInterfaces()).flat()
      .find((iface) => iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('169.254.'))?.address;
    if (!address) return t.skip('Requires a non-loopback IPv4 interface');
    const root = await mkdtemp(join(tmpdir(), 'relay-host-tls-'));
    t.after(() => cleanup(root));
    const certFile = join(root, 'cert.pem'), keyFile = join(root, 'key.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
      '-nodes', '-days', '1', '-subj', '/CN=areal-test', '-addext', 'subjectAltName=IP:' + address,
      '-keyout', keyFile, '-out', certFile], { stdio: 'ignore' });
    const cert = await readFile(certFile), key = createPrivateKey(await readFile(keyFile));
    const leaf = new X509Certificate(cert);
    const port = await freePort(address), child = await runner(root);
    const exit = once(child, 'exit');
    const input = frame(root, port);
    const capability = 'c'.repeat(43);
    input.room = hash(capability);
    const authority = address + ':' + port;
    input.config.publicOrigin = 'https://' + authority;
    input.config.listen = authority;
    input.config.allowedClientOrigins = [input.config.publicOrigin];
    input.tls = { certificate: leaf.raw.toString('base64'),
      private_key: key.export({ format: 'der', type: 'pkcs8' }).toString('base64') };
    child.stdin.write(JSON.stringify(input) + '\n');
    const [chunk] = await once(child.stdout, 'data');
    const { loopbackPort, ...ready } = JSON.parse(chunk);
    assert.deepEqual(ready, { version: 1, event: 'ready' });
    assert.ok(loopbackPort > 0 && loopbackPort !== port);
    const publicUrl = 'wss://' + authority + '/remote/socket';
    const localUrl = 'ws://127.0.0.1:' + loopbackPort + '/remote/socket';
    const connect = async (url, options, role) => {
      const socket = new WebSocket(url, { headers: { Host: authority }, ...options });
      t.after(() => socket.terminate());
      await once(socket, 'open');
      const response = once(socket, 'message');
      socket.send(JSON.stringify({ protocol: 'areal.relay.v1', role, room: input.room,
        ...(role === 'host' ? { capability } : {}) }));
      const [raw] = await response;
      return JSON.parse(raw);
    };
    assert.equal((await connect(localUrl, {}, 'host')).type, 'ready');
    assert.equal((await connect(publicUrl, { ca: cert }, 'host')).code, 'UNAVAILABLE');
    const app = { origin: 'capacitor://localhost' };
    assert.equal((await connect(localUrl, app, 'client')).code, 'UNAVAILABLE');
    assert.equal((await connect(publicUrl, { ...app, ca: cert }, 'client')).type, 'ready');
    await assert.rejects(connect(publicUrl, app, 'client'));
    await assert.rejects(connect(publicUrl.replace('wss:', 'ws:'), app, 'client'));
    child.stdin.end();
    assert.deepEqual(await exit, [0, null]);
  },
);

test(
  'Host runner refuses an existing lock and leaves it unchanged',
  { timeout: 10000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'relay-host-'));
    t.after(() => cleanup(root));
    const path = join(root, 'server.lock');
    await writeFile(path, 'existing');
    const child = await runner(root),
      exit = once(child, 'exit');
    let stdout = '';
    child.stdout.on('data', (x) => (stdout += x));
    child.stdin.write(JSON.stringify(frame(root, await freePort())) + '\n');
    assert.deepEqual(await exit, [1, null]);
    assert.equal(stdout, '');
    assert.equal(await readFile(path, 'utf8'), 'existing');
  },
);
test('EOF during initialization never publishes ready', { timeout: 10000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'relay-host-'));
  t.after(() => cleanup(root));
  const child = await runner(root),
    exit = once(child, 'exit');
  let stdout = '';
  child.stdout.on('data', (x) => (stdout += x));
  child.stdin.end(JSON.stringify(frame(root, await freePort())) + '\n');
  assert.deepEqual(await exit, [0, null]);
  assert.equal(stdout, '');
  await assert.rejects(access(join(root, 'server.lock')), { code: 'ENOENT' });
});
test(
  'Host runner preserves a replaced lock and reports cleanup failure',
  { timeout: 10000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'relay-host-'));
    t.after(() => cleanup(root));
    const child = await runner(root),
      exit = once(child, 'exit');
    child.stdin.write(JSON.stringify(frame(root, await freePort())) + '\n');
    await once(child.stdout, 'data');
    const path = join(root, 'server.lock');
    await rm(path);
    await writeFile(path, 'replacement');
    child.stdin.end();
    assert.deepEqual(await exit, [1, null]);
    assert.equal(await readFile(path, 'utf8'), 'replacement');
  },
);
test(
  'malformed first frame fails without waiting for parent EOF',
  { timeout: 10000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'relay-host-'));
    t.after(() => cleanup(root));
    const child = await runner(root),
      exit = once(child, 'exit');
    let stdout = '';
    child.stdout.on('data', (x) => (stdout += x));
    child.stdin.write('{invalid\n');
    assert.deepEqual(await exit, [1, null]);
    assert.equal(stdout, '');
    await assert.rejects(access(join(root, 'server.lock')), { code: 'ENOENT' });
  },
);

test('revoked room is not reactivated during Host startup', { timeout: 10000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'relay-host-'));
  t.after(() => cleanup(root));
  const input = frame(root, await freePort());
  const store = openStore(parseConfig(input.config));
  store.provision(input.room);
  store.revoke(input.room);
  store.close();
  const child = await runner(root),
    exit = once(child, 'exit');
  let stdout = '';
  child.stdout.on('data', (x) => (stdout += x));
  child.stdin.write(JSON.stringify(input) + '\n');
  assert.deepEqual(await exit, [1, null]);
  assert.equal(stdout, '');
  const reopened = openStore(parseConfig(input.config));
  try {
    assert.equal(reopened.room(input.room), undefined);
    assert.equal(
      reopened.db.prepare('SELECT active FROM rooms WHERE room=?').get(input.room).active,
      0,
    );
  } finally {
    reopened.close();
  }
  await assert.rejects(access(join(root, 'server.lock')), { code: 'ENOENT' });
});
