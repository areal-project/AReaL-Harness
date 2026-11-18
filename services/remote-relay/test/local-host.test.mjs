import assert from 'node:assert/strict';
import { test } from 'node:test';
import { networkInterfaces, tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { WebSocket } from 'ws';
import { attachRelay } from '../src/relay.mjs';
import { openStore, secret, hash } from '../src/store.mjs';
import { ceilings, parseConfig } from '../src/config.mjs';
import { serve } from '../src/server.mjs';

test('locally assigned non-RFC1918 IPv4 is reachable with the desktop authority, and rejects other sources', async t => {
  const interfaces = Object.values(networkInterfaces()).flat();
  const iface = interfaces.find(({ address, cidr, family, internal }) =>
    !internal && family === 'IPv4' && !/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(address) &&
    Number(cidr?.split('/')[1]) >= 1 && Number(cidr?.split('/')[1]) <= 30);
  if (!iface) return t.skip('Requires a non-RFC1918 local IPv4 interface with a LAN prefix');
  const home = await mkdtemp(join(tmpdir(), 'areal-local-interface-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '0.0.0.0', resolve));
  const { port } = reservation.address();
  await new Promise(resolve => reservation.close(resolve));
  const origin = 'http://' + iface.address + ':' + port;
  const config = parseConfig({ local: true, publicOrigin: origin, listen: '0.0.0.0:' + port,
    allowedClientOrigins: [origin], dataDir: home });
  const server = await serve(config, null, undefined, () => {});
  t.after(() => server.close());
  const probe = (hostname, localAddress) => new Promise((resolve, reject) => {
    const req = request({ hostname, localAddress, port, path: '/healthz',
      headers: { Host: config.publicHost } }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.once('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('health probe timeout')));
    req.end();
  });
  assert.equal(await probe(iface.address, iface.address), 200);
  assert.equal(await probe('127.0.0.1', '127.0.0.1'), 200);
  await assert.rejects(probe(iface.address, '127.0.0.1'), { code: 'ECONNRESET' });
});

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
