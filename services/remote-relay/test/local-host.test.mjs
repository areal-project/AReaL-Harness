import assert from 'node:assert/strict';
import { test } from 'node:test';
import { networkInterfaces, tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { attachRelay } from '../src/relay.mjs';
import { openStore, secret, hash } from '../src/store.mjs';
import { ceilings } from '../src/config.mjs';

test('local Relay accepts Host credentials only on loopback while LAN devices remain clients', async t => {
  const address = Object.values(networkInterfaces()).flat().find(a => a && !a.internal && a.family === 'IPv4')?.address;
  if (!address) return t.skip('No external IPv4 interface is available for the LAN boundary test');
  const home = await mkdtemp(join(tmpdir(), 'areal-local-host-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const config = { ...ceilings, local: true, dataDir: home, publicHost: 'relay.local', allowedClientOrigins: [], allowedAppOrigins: ['capacitor://localhost'] };
  const store = openStore(config);
  const capability = secret(); const room = hash(capability);
  store.provision(room);
  const server = createServer();
  const stop = attachRelay(server, config, store, () => {});
  await new Promise(r => server.listen(0, '0.0.0.0', r));
  const port = server.address().port;
  const sockets = [];
  t.after(async () => {
    sockets.forEach(ws => ws.terminate()); stop();
    await new Promise(r => server.close(r)); store.close();
  });
  const connect = (host, role, options = {}) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${host}:${port}/remote/socket`, { headers: { host: 'relay.local' }, ...options });
    sockets.push(ws);
    ws.once('error', reject);
    ws.once('message', data => resolve({ ws, message: JSON.parse(data.toString()) }));
    ws.once('open', () => ws.send(JSON.stringify({ protocol: 'areal.relay.v1', role, room, ...(role === 'host' ? { capability } : {}) })));
  });
  const rejected = await connect(address, 'host');
  assert.deepEqual(rejected.message, { type: 'error', code: 'UNAVAILABLE' });
  const host = await connect('127.0.0.1', 'host');
  assert.equal(host.message.type, 'ready');
  const client = await connect(address, 'client', { origin: 'capacitor://localhost' });
  assert.equal(client.message.type, 'ready');
  assert.match(client.message.channel, /^[a-f0-9-]{36}$/);
});
