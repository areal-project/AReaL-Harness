import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../src/config.mjs';

test('App Origins default to empty and accept exact custom scheme hosts in production', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'areal-relay-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'config.json');
  const base = { publicOrigin: 'https://relay.example', listen: '127.0.0.1:8080', trustedLocalTlsProxy: true,
    allowedClientOrigins: ['https://relay.example'], dataDir: join(dir, 'data') };
  await writeFile(file, JSON.stringify(base));
  assert.deepEqual(readConfig(file).allowedAppOrigins, []);
  for (const allowedAppOrigins of [[], ['capacitor://localhost'], ['capacitor://localhost', 'areal-app://device']]) {
    await writeFile(file, JSON.stringify({ ...base, allowedAppOrigins }));
    assert.deepEqual(readConfig(file).allowedAppOrigins, allowedAppOrigins);
  }
  for (const allowedAppOrigins of [null, 'capacitor://localhost', {}, [null], [42],
    ...['http://localhost', 'https://localhost', 'ws://localhost', 'wss://localhost', 'HTTPS://localhost',
      'capacitor://', 'capacitor://user@localhost', 'capacitor://user:pass@localhost', 'capacitor://localhost:80',
      'capacitor://localhost:', 'capacitor://localhost/', 'capacitor://localhost/path', 'capacitor://localhost?query',
      'capacitor://localhost#fragment', 'capacitor://localhost?', 'capacitor://localhost#', ' capacitor://localhost',
      'capacitor://localhost ', 'capacitor://local\thost', 'capacitor://%6cocalhost', 'capacitor://local%68ost',
      'capacitor://localhost\\alias', 'capacitor:localhost', 'Capacitor://localhost'].map(value => [value])]) {
    await writeFile(file, JSON.stringify({ ...base, allowedAppOrigins }));
    assert.throws(() => readConfig(file), { message: 'CONFIG_APP_ORIGIN' }, JSON.stringify(allowedAppOrigins));
  }
});

test('APNs config is optional, exact, bounded and does not read the configured key during administration', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'areal-relay-apns-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'config.json');
  const base = { publicOrigin: 'https://relay.example', listen: '127.0.0.1:8080', trustedLocalTlsProxy: true,
    allowedClientOrigins: ['https://relay.example'], dataDir: join(dir, 'data') };
  const valid = { teamId: 'ABCDEFGHIJ', keyId: 'KLMNOPQRST', keyFile: join(dir, 'does-not-exist.p8'), bundleId: 'org.example.areal' };
  await writeFile(file, JSON.stringify(base)); assert.equal(readConfig(file).apns, undefined);
  await writeFile(file, JSON.stringify({ ...base, apns: valid })); assert.deepEqual(readConfig(file).apns, { ...valid, maxPerHostPerMinute: 60 });
  for (const maxPerHostPerMinute of [1, 600]) {
    await writeFile(file, JSON.stringify({ ...base, apns: { ...valid, maxPerHostPerMinute } }));
    assert.equal(readConfig(file).apns.maxPerHostPerMinute, maxPerHostPerMinute);
  }
  const invalid = [null, [], true, 'apns', {}, ...[
    { teamId: 1234567890 }, { teamId: 'short' }, { teamId: 'abcdefghij' }, { keyId: 'bad\nkey' }, { keyId: null },
    { keyFile: '' }, { keyFile: 42 }, { keyFile: 'contains\0nul' }, { keyFile: 'a'.repeat(4097) },
    { bundleId: '' }, { bundleId: 'single' }, { bundleId: 'org.example\nheader' }, { bundleId: 'a.'.repeat(128) },
    { maxPerHostPerMinute: null }, { maxPerHostPerMinute: 0 }, { maxPerHostPerMinute: 601 }, { maxPerHostPerMinute: 1.5 }, { maxPerHostPerMinute: '60' },
    { endpoint: 'https://attacker.example' },
  ].map(change => ({ ...valid, ...change }))];
  for (const apns of invalid) {
    await writeFile(file, JSON.stringify({ ...base, apns }));
    assert.throws(() => readConfig(file), { message: 'CONFIG_APNS' });
  }
});

test('local mode only accepts private numeric HTTP origins with exact client origin and explicit wildcard binding', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'areal-local-relay-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'config.json');
  const base = { local: true, publicOrigin: 'http://192.168.2.3:47820', listen: '0.0.0.0:47820',
    allowedClientOrigins: ['http://192.168.2.3:47820'], allowedAppOrigins: ['capacitor://localhost'], dataDir: join(dir, 'data') };
  await writeFile(file, JSON.stringify(base));
  const local = readConfig(file);
  assert.equal(local.local, true);
  assert.equal(local.listenHost, '0.0.0.0');
  assert.equal(local.publicHost, '192.168.2.3:47820');
  for (const host of ['10.8.0.2', '172.31.3.4', '[fd00::1]']) {
    const origin = `http://${host}:47820`;
    await writeFile(file, JSON.stringify({ ...base, publicOrigin: origin, allowedClientOrigins: [origin] }));
    assert.equal(readConfig(file).publicOrigin, origin);
  }
  for (const change of [
    { publicOrigin: 'http://8.8.8.8:47820' }, { publicOrigin: 'http://127.0.0.1:47820' },
    { publicOrigin: 'http://relay.example:47820' }, { publicOrigin: 'http://[fe80::1]:47820' },
    { publicOrigin: 'http://[ff00::1]:47820' }, { publicOrigin: 'https://192.168.2.3:47820' },
    { development: true }, { local: false }, { listen: '192.168.2.3:47820' },
    { allowedClientOrigins: ['http://192.168.2.4:47820'] },
  ]) {
    await writeFile(file, JSON.stringify({ ...base, ...change }));
    assert.throws(() => readConfig(file));
  }
  await writeFile(file, JSON.stringify({ ...base, local: false, publicOrigin: 'https://relay.example', allowedClientOrigins: ['https://relay.example'], trustedLocalTlsProxy: true }));
  assert.throws(() => readConfig(file), { message: 'CONFIG_LISTEN' });
});
