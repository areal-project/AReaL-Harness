import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { request } from 'node:https';
import { openStore } from '../src/store.mjs';
import { acquireManagedLock, startManagedRelay } from '../src/managed.mjs';

async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-managed-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
test('provision persists exactly the public room and refuses to revive revocation', async t => {
  const dataDir = await directory(t);
  const config = { dataDir, maxRooms: 1, maxChannelsPerHost: 2 };
  const room = 'a'.repeat(64);
  let store = openStore(config);
  assert.deepEqual(store.provision(room), { room, active: true });
  assert.deepEqual(store.provision(room), { room, active: true });
  assert.ok(store.room(room));
  assert.throws(() => store.provision('b'.repeat(64)), /CAPACITY_EXCEEDED/);
  assert.throws(() => store.provision('not a hash'), /INVALID_ROOM/);
  store.revoke(room); store.close();
  store = openStore(config);
  t.after(() => store.close());
  assert.throws(() => store.provision(room), /ROOM_REVOKED/);
  assert.equal(store.room(room), undefined);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM rooms').get().n, 1);
});

test('managed lock excludes live processes and recovers only a demonstrably dead PID', async t => {
  const dir = await directory(t);
  const release = acquireManagedLock(dir);
  assert.throws(() => acquireManagedLock(dir), /SERVER_ALREADY_RUNNING/);
  release();
  const pid = execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).trim();
  await writeFile(join(dir, 'server.lock'), `${pid}\n`);
  const recovered = acquireManagedLock(dir);
  assert.equal((await readFile(join(dir, 'server.lock'), 'utf8')).trim(), String(process.pid));
  recovered();
  await writeFile(join(dir, 'server.lock'), 'corrupt\n');
  assert.throws(() => acquireManagedLock(dir), /SERVER_LOCK_INVALID/);
  await mkdir(join(dir, 'server.lock.guard'));
  assert.throws(() => acquireManagedLock(dir), /SERVER_LOCK_CHECK_REQUIRED/);
});

test('managed service starts real SQLite backend with HTTPS and releases all listeners for restart', async t => {
  const dir = await directory(t);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key'), '-out', join(dir, 'cert'), '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
  const probe = createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise(r => probe.close(r));
  const configPath = join(dir, 'config.json');
  const dataDir = join(dir, 'data');
  await writeFile(configPath, JSON.stringify({ publicOrigin: 'https://localhost', listen: `127.0.0.1:${port}`, trustedLocalTlsProxy: true, allowedClientOrigins: ['https://localhost'], dataDir }));
  const tls = { host: '127.0.0.1', port: 0, cert: await readFile(join(dir, 'cert'), 'utf8'), key: await readFile(join(dir, 'key'), 'utf8') };
  const service = await startManagedRelay({ configPath, tls });
  t.after(() => service.close());
  const health = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: service.proxy.port, servername: 'localhost', ca: tls.cert, headers: { host: 'localhost' }, path: '/healthz' }, res => { let body = ''; res.on('data', b => body += b); res.on('end', () => resolve([res.statusCode, JSON.parse(body)])); });
    req.on('error', reject); req.end();
  });
  assert.deepEqual(health, [200, { ok: true }]);
  await assert.rejects(startManagedRelay({ configPath, tls }), /SERVER_ALREADY_RUNNING/);
  const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
  assert.throws(() => execFileSync(process.execPath, [cli, 'serve', '--config', configPath], { stdio: 'pipe' }));
  assert.throws(() => execFileSync(process.execPath, [cli, 'restore', '--config', configPath, join(dir, 'missing-backup')], { stdio: 'pipe' }));
  await service.close();
  await assert.rejects(access(join(dataDir, 'server.lock')));
  const restarted = await startManagedRelay({ configPath, tls });
  await restarted.close();
});


test('provision CLI accepts only an explicit hash, is repeatable and never emits a capability', async t => {
  const dir = await directory(t);
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ publicOrigin: 'https://localhost', listen: '127.0.0.1:18443', trustedLocalTlsProxy: true, allowedClientOrigins: ['https://localhost'], dataDir: join(dir, 'data') }));
  const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
  const args = [cli, 'provision', '--config', configPath, '--room', 'd'.repeat(64)];
  const first = execFileSync(process.execPath, args, { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(first), { room: 'd'.repeat(64), active: true });
  assert.equal(execFileSync(process.execPath, args, { encoding: 'utf8' }), first);
  assert.throws(() => execFileSync(process.execPath, [...args, 'extra'], { stdio: 'pipe' }));
});
