import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../app/package.json', import.meta.url));
const { DesktopService, PROTOCOL } = require('@areal/workbench-service/desktop/core/service-protocol.cjs');
const { ServiceConnection } = require('../app/src/core/service-client.cjs');
const WebSocket = require('ws');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (read()) return; await sleep(10); }
  throw new Error(`Timeout: ${label}`);
}
const wireValue = value => JSON.parse(JSON.stringify(value));
const marker = 'RETAINED_HISTORY_BODY_';
const oldItems = Array.from({ length: 1000 }, (_, n) => ({ id: `old-${n}`, type: 'agentMessage', text: marker + 'x'.repeat(4195) }));
const oldTurn = { id: 'old-turn', status: 'completed', items: oldItems };
const active = { id: 'active', turns: [oldTurn, { id: 'live-turn', status: 'inProgress', items: [oldItems[0], { id: 'live', type: 'agentMessage', text: 'start' }], modelRetry: { attempt: 1 } }] };
let state = { library: { projects: {}, threads: {}, settings: {}, projectOrder: [] }, obsolete: 'clear-me', projects: [
  { id: 'p', root: '/projection-fixture', state: { connected: true, obsolete: 'clear-me', threads: { active, archived: { id: 'archived', turns: [{ ...oldTurn, items: oldItems.map(item => ({ ...item, id: `archived-${item.id}` })) }] } } } },
  { id: 'remove-project', root: '/remove', state: null },
] };
const backend = { snapshot: () => state, projects: new Map(), starting: new Map(), hasWork: () => false,
  providers: { redact: value => value }, analytics: { sample() {}, flush() {} } };
const service = new DesktopService(backend, 'projection-integration');
const clients = [];
let legacySocket, legacyServer;
const checks = [];
try {
  const metadata = await service.listen();
  const connect = async () => {
    const frames = [], updates = [];
    let closed = false;
    const connection = new ServiceConnection(packet => updates.push(packet), () => { closed = true; });
    clients.push(connection);
    await connection.connect(metadata);
    connection.socket.on('message', bytes => frames.push(JSON.parse(bytes.toString())));
    const hello = await connection.request('hello', { protocol: PROTOCOL, identity: metadata.identity, capabilities: { projection: 1 } });
    assert.deepEqual(hello.snapshot, wireValue(state));
    await until(() => updates.length > 0, 'post-hello state');
    return { connection, frames, updates, hello, closed: () => closed };
  };
  const first = await connect();
  const initialBytes = Buffer.byteLength(JSON.stringify(first.frames[0]));
  assert.ok(initialBytes >= 8 * 1024 * 1024, 'fixture crosses 8 MiB with old items inside and outside the active thread');
  const update = async (next, observers = [first]) => {
    state = next;
    const counts = observers.map(observer => observer.updates.length);
    const starts = observers.map(observer => observer.frames.length);
    service.publish();
    await until(() => observers.every((observer, n) => observer.updates.length > counts[n]), 'state delivery');
    for (const [n, observer] of observers.entries()) {
      assert.deepEqual(observer.updates.at(-1).snapshot, wireValue(state));
      const updates = observer.frames.slice(starts[n]).filter(frame => frame.method === 'state');
      assert.ok(updates.length > 0);
      for (const frame of updates) {
        const encoded = JSON.stringify(frame);
        assert.equal(encoded.includes(marker), false, 'post-baseline transport must omit retained bodies in inactive threads AND old turns/items of the active thread');
        assert.ok(Buffer.byteLength(encoded) < 64 * 1024, 'bounded live update excludes 8 MiB retained history');
      }
    }
  };
  const changeLive = text => {
    const project = state.projects[0], thread = project.state.threads.active, turn = thread.turns.at(-1);
    return { ...state, projects: [{ ...project, state: { ...project.state, threads: { ...project.state.threads,
      active: { ...thread, turns: [thread.turns[0], { ...turn, items: [turn.items[0], { ...turn.items[1], text }] }] } } } }, ...state.projects.slice(1)] };
  };
  const before = first.updates.at(-1).snapshot;
  await update(changeLive('streamed text'));
  const after = first.updates.at(-1).snapshot;
  assert.equal(after.projects[0].state.threads.archived, before.projects[0].state.threads.archived);
  assert.equal(after.projects[0].state.threads.active.turns[0], before.projects[0].state.threads.active.turns[0]);
  assert.equal(after.projects[0].state.threads.active.turns[1].items[0], before.projects[0].state.threads.active.turns[1].items[0]);
  checks.push('8 MiB immutable history omitted after baseline, including old items in the active turn; complete client values retain unchanged references');
  const second = await connect();
  await update(changeLive('short'), [first, second]);
  const p = state.projects[0], thread = p.state.threads.active, turn = thread.turns[1];
  await update({ library: state.library, projects: [{ ...p, state: { connected: true, threads: { active: { id: thread.id,
    turns: [{ id: turn.id, status: 'completed', items: [turn.items[1]] }, thread.turns[0]] } } } }] }, [first, second]);
  assert.equal('obsolete' in first.updates.at(-1).snapshot, false);
  assert.equal('modelRetry' in first.updates.at(-1).snapshot.projects[0].state.threads.active.turns[0], false);
  checks.push('two independent clients preserve shortening, metadata removal, item/turn order and project/thread/item deletion');
  const snapshot = await first.connection.request('snapshot');
  assert.deepEqual(snapshot.snapshot, wireValue(state));
  await update({ ...state, projects: [{ ...state.projects[0], state: null }] }, [first, second]);
  const restored = { library: state.library, projects: [{ id: 'p', root: '/projection-fixture', state: { connected: true, threads: { t: { id: 't', turns: [{ id: 'turn', items: [{ id: 'item', text: 'restored' }] }] } } } }] };
  await update(restored, [first, second]);
  checks.push('explicit full snapshot and state null/restore stay on each connection cursor');
  const firstSocket = [...service.clients][0];
  const repeated = first.frames.filter(frame => frame.method === 'state').at(-1);
  const repeatedState = first.updates.at(-1).snapshot;
  firstSocket.send(JSON.stringify(repeated));
  firstSocket.send(JSON.stringify(first.frames.find(frame => frame.id === 1)));
  await sleep(35);
  assert.equal(first.updates.at(-1).snapshot, repeatedState, 'old full or duplicate delta cannot roll back the reader');
  const damaged = structuredClone(repeated);
  damaged.params.snapshot.sequence += 1;
  damaged.params.snapshot.base = 0;
  firstSocket.send(JSON.stringify(damaged));
  await until(first.closed, 'missing base closes only the affected observer');
  const reconnected = await connect();
  assert.equal(reconnected.frames[0].result.snapshot.kind, 'full');
  await update({ ...state, revision: 2 }, [second, reconnected]);
  checks.push('duplicates/old frames do not regress, a missing base closes the observer, reconnect starts full and other observers continue');
  for (const [label, corrupt] of [
    ['unknown stream', frame => { frame.stream = 'other-stream'; }],
    ['unsupported version', frame => { frame.projection = 2; }],
    ['duplicate order identity', frame => { frame.projects.order.push(frame.projects.order[0]); }],
    ['missing entity', frame => { frame.projects.order.push('missing'); }],
    ['mismatched entity identity', frame => { frame.projects.changes = [{ id: 'p', head: { id: 'wrong' }, state: null }]; }],
  ]) {
    const observer = await connect();
    const socket = [...service.clients].at(-1);
    const frame = structuredClone(observer.frames.filter(frame => frame.method === 'state').at(-1));
    frame.params.snapshot.base = frame.params.snapshot.sequence;
    frame.params.snapshot.sequence += 1;
    corrupt(frame.params.snapshot);
    const count = observer.updates.length;
    socket.send(JSON.stringify(frame));
    await until(observer.closed, label);
    assert.equal(observer.updates.length, count, `${label} does not publish partial state`);
  }
  checks.push('malformed version, stream, identity, duplicate order and missing entity fail closed at the actual socket boundary');
  const legacyFrames = [];
  legacySocket = new WebSocket(metadata.endpoint, { headers: { Authorization: `Bearer ${metadata.token}` } });
  legacySocket.on('message', bytes => legacyFrames.push(JSON.parse(bytes.toString())));
  await new Promise(resolve => legacySocket.once('open', resolve));
  legacySocket.send(JSON.stringify({ id: 1, method: 'hello', params: { protocol: PROTOCOL, identity: metadata.identity } }));
  await until(() => legacyFrames.length > 0, 'legacy hello');
  assert.deepEqual(legacyFrames[0].result.snapshot, wireValue(state));
  service.publish();
  await until(() => legacyFrames.some(frame => frame.method === 'state'), 'legacy update');
  assert.deepEqual(legacyFrames.find(frame => frame.method === 'state').params.snapshot, wireValue(state));
  legacyServer = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => legacyServer.once('listening', resolve));
  legacyServer.on('connection', socket => socket.on('message', bytes => {
    const request = JSON.parse(bytes.toString());
    socket.send(JSON.stringify({ id: request.id, result: { sequence: 1, snapshot: state, service: {} } }));
  }));
  const newToOld = new ServiceConnection(); clients.push(newToOld);
  await newToOld.connect({ ...metadata, endpoint: `ws://127.0.0.1:${legacyServer.address().port}` });
  assert.deepEqual((await newToOld.request('hello', { protocol: PROTOCOL, identity: metadata.identity })).snapshot, wireValue(state));
  checks.push('old clients retain full packets; new clients accept legacy full servers');
  console.log(JSON.stringify({ passed: true, initialBytes, checks }, null, 2));
} finally {
  clients.forEach(client => client.close());
  legacySocket?.terminate();
  for (const socket of legacyServer?.clients ?? []) socket.terminate();
  legacyServer?.close();
  service.close();
}
