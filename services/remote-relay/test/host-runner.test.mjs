import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, access, open } from 'node:fs/promises';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { parseConfig } from '../src/config.mjs';
import { openStore } from '../src/store.mjs';

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

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
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
