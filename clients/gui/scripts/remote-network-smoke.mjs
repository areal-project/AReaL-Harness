import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// Failure modes at the approved public adapter/CLI protocol seam:
// missing/old CLI; malformed/unknown JSON; login/HTTPS unknown; collision/drift;
// unsafe origin/target; failed pending persistence; timeout/output bounds; own cleanup.
const require = createRequire(import.meta.url);
const { createRemoteNetworkAdapter, validateHttpsOrigin } = require('@areal/workbench-service/desktop/core/remote-network.cjs');
const root = await mkdtemp(path.join(tmpdir(), 'remote-network-smoke-'));
const binary = path.join(root, 'tailscale fixture; no-shell');
const statePath = path.join(root, 'state.json');
const logPath = path.join(root, 'argv.jsonl');
const status = { BackendState: 'Running', Self: { DNSName: 'host.example.ts.net.' }, CertDomains: ['host.example.ts.net'] };
async function state(extra = {}) {
  await writeFile(statePath, JSON.stringify({ version: '1.52.0', status, config: {}, ...extra }));
  await writeFile(logPath, '');
}
await writeFile(binary, `#!${process.execPath}
const fs = require('node:fs');
const statePath = ${JSON.stringify(statePath)}, logPath = ${JSON.stringify(logPath)};
const s = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(logPath, JSON.stringify(args) + '\\n');
if (s.hang) { setTimeout(() => {}, 60000); }
else if (s.overflow) process.stdout.write('x'.repeat(100000));
else if (s.malformed) console.log('{');
else if (args[0] === 'version') console.log(JSON.stringify({ short: s.version }));
else if (args[0] === 'status') console.log(JSON.stringify(s.status));
else if (args.join(' ') === 'serve status --json') console.log(JSON.stringify(s.config));
else if (args[0] === 'serve' || args[0] === 'funnel') {
  if (s.noApply) process.exit(0);
  const port = args.find(a => a.startsWith('--https=')).split('=')[1];
  const hp = 'host.example.ts.net:' + port;
  if (args.at(-1) === 'off') {
    delete s.config.TCP[port]; delete s.config.Web[hp];
    if (!Object.keys(s.config.TCP).length) delete s.config.TCP;
    if (!Object.keys(s.config.Web).length) delete s.config.Web;
  } else {
    s.config.TCP ||= {}; s.config.Web ||= {};
    s.config.TCP[port] = { HTTPS: true };
    s.config.Web[hp] = { Handlers: { '/': { Proxy: args.at(-1) } } };
  }
  if (args[0] === 'funnel') {
    s.config.AllowFunnel ||= {}; s.config.AllowFunnel[hp] = true;
  } else if (s.config.AllowFunnel) {
    delete s.config.AllowFunnel[hp];
    if (!Object.keys(s.config.AllowFunnel).length) delete s.config.AllowFunnel;
  }
  if (s.driftAfterApply) s.config.Web[hp].Handlers['/'].Proxy = 'http://127.0.0.1:9999';
  fs.writeFileSync(statePath, JSON.stringify(s));
  if (s.hangAfterApply) setTimeout(() => {}, 60000);
  if (s.failAfterApply) { console.error('secret CLI diagnostic'); process.exit(7); }
} else process.exit(4);
`, { mode: 0o700 });
try {
  await state();
  const adapter = createRemoteNetworkAdapter({ executable: binary });
  assert.deepEqual(await adapter.inspect(), {
    available: true, version: '1.52.0', persistentServe: true,
    login: 'logged-in', https: 'enabled', policy: 'unknown', funnelPorts: null,
    publicOrigin: 'https://host.example.ts.net', config: {},
  });
  console.log('PASS installed supported CLI and explicit unknown policy');
  assert.deepEqual(await createRemoteNetworkAdapter({ executable: path.join(root, 'missing') }).inspect(), { available: false, diagnostic: 'unavailable' });
  await state({ version: '1.50.1' });
  assert.equal((await adapter.inspect()).diagnostic, 'unsupported-version');
  await state({ version: '1.54.0-dev' });
  assert.equal((await adapter.inspect()).diagnostic, 'unsupported-version');
  await state({ status: { BackendState: 'NeedsLogin' } });
  assert.equal((await adapter.inspect()).login, 'not-logged-in');
  await state({ status: { BackendState: 'NeedsMachineAuth' } });
  assert.equal((await adapter.inspect()).login, 'approval-required');
  await state({ status: { ...status, CertDomains: [] } });
  assert.equal((await adapter.inspect()).https, 'disabled');
  await state({ status: { BackendState: 'Running', Self: status.Self } });
  assert.equal((await adapter.inspect()).https, 'unknown');
  await state({ status: { BackendState: 'Unexpected' } });
  assert.equal((await adapter.inspect()).login, 'unknown');
  await state({ config: { FutureSchema: {} } });
  await assert.rejects(adapter.inspect(), { code: 'unknown-config' });
  await state({ malformed: true });
  await assert.rejects(adapter.inspect(), { code: 'malformed-json' });
  await state({ hang: true });
  await assert.rejects(createRemoteNetworkAdapter({ executable: binary, timeoutMs: 100 }).inspect(), { code: 'timeout' });
  await state({ overflow: true });
  await assert.rejects(createRemoteNetworkAdapter({ executable: binary, maxBuffer: 1024 }).inspect(), { code: 'output-limit' });
  console.log('PASS bounded diagnostics and unknown schema refusal');
  for (const origin of ['http://host.test', 'https://user@host.test', 'https://host.test/', 'https://host.test/path', 'https://host.test?x', 'https://host.test#x', 'https://HOST.test', ' https://host.test', 'https://host.test:443', 'https://host.test\\evil']) {
    assert.throws(() => validateHttpsOrigin(origin), { code: 'invalid-origin' });
  }
  assert.equal(validateHttpsOrigin('https://host.example:8443'), 'https://host.example:8443');
  const listener = { host: '127.0.0.1', port: 43123 };
  const verified = createRemoteNetworkAdapter({ executable: binary, verifyRemoteListener: async (value) => value.host === listener.host && value.port === listener.port });
  await state();
  await assert.rejects(adapter.propose({ remoteListener: listener }), { code: 'unverified-listener' });
  await assert.rejects(verified.propose({ remoteListener: { host: '0.0.0.0', port: 43123 } }), { code: 'invalid-listener' });
  await assert.rejects(verified.propose({ remoteListener: { host: '127.0.0.1', port: 1234 } }), { code: 'unverified-listener' });
  const proposal = await verified.propose({ remoteListener: listener });
  assert.equal(proposal.publicOrigin, 'https://host.example.ts.net');
  assert.equal(proposal.target, 'http://127.0.0.1:43123');
  await assert.rejects(verified.apply(proposal), { code: 'pending-persistence-required' });
  let pending;
  const owned = await verified.apply(proposal, { persistPending: async (record) => {
    pending = record;
    assert.equal(record.state, 'pending');
    assert.equal(record.operation, 'apply');
    assert.deepEqual((await verified.inspect()).config, {});
  } });
  assert.equal(owned.state, 'owned');
  assert.equal(pending.id, owned.id);
  assert.equal((await verified.inspectOwnership(pending)).state, 'owned');
  const argv = (await readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(argv.filter(a => a[0] === 'serve' && a[1] !== 'status'), [['serve', '--bg', '--https=443', '--set-path=/', 'http://127.0.0.1:43123']]);
  await assert.rejects(verified.propose({ remoteListener: listener }), { code: 'mapping-collision' });
  const removed = await verified.remove(owned, { persistPending: async (record) => {
    assert.equal(record.operation, 'remove');
    assert.equal((await verified.inspectOwnership(record)).state, 'owned');
  } });
  assert.equal(removed.state, 'removed');
  assert.deepEqual((await verified.inspect()).config, {});
  assert.equal((await verified.inspectOwnership(pending)).state, 'absent');
  console.log('PASS exact origin, verified listener, durable pending and own lifecycle');
  await state({ config: null });
  assert.deepEqual((await verified.inspect()).config, {});
  const foreign = { TCP: { '8443': { HTTPS: true } }, Web: { 'other.example.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7654' } } } } };
  await state({ config: foreign });
  const withForeign = await verified.propose({ remoteListener: listener });
  const foreignOwned = await verified.apply(withForeign, { persistPending: async () => {} });
  assert.deepEqual((await verified.inspect()).config.Web['other.example.ts.net:8443'], foreign.Web['other.example.ts.net:8443']);
  await verified.remove(foreignOwned, { persistPending: async () => {} });
  assert.deepEqual((await verified.inspect()).config, foreign);
  for (const config of [
    { TCP: { '443': { TCPForward: 'localhost:9000' } } },
    { Web: { 'other.example.ts.net:443': { Handlers: { '/': { Text: 'organization' } } } } },
    { Foreground: { session: { TCP: { '443': { HTTPS: true } } } } },
    { AllowFunnel: { 'host.example.ts.net:443': true } },
  ]) {
    await state({ config });
    await assert.rejects(verified.propose({ remoteListener: listener }), { code: 'mapping-collision' });
  }
  await state();
  const changing = await verified.propose({ remoteListener: listener });
  await assert.rejects(verified.apply(changing, { persistPending: async () => { throw new Error('disk failed'); } }), /disk failed/);
  assert.deepEqual((await verified.inspect()).config, {});
  await assert.rejects(verified.apply(changing, { persistPending: async () => {
    await state({ config: { TCP: { '443': { HTTP: true } } } });
  } }), { code: 'mapping-collision' });
  await state();
  const driftOwned = await verified.apply(changing, { persistPending: async () => {} });
  const driftState = JSON.parse(await readFile(statePath, 'utf8'));
  driftState.config.Web['host.example.ts.net:443'].Handlers['/'].Proxy = 'http://127.0.0.1:9999';
  await writeFile(statePath, JSON.stringify(driftState));
  assert.equal((await verified.inspectOwnership(driftOwned)).state, 'changed');
  await assert.rejects(verified.remove(driftOwned, { persistPending: async () => {} }), { code: 'mapping-changed' });
  await state({ driftAfterApply: true });
  let driftPending;
  await assert.rejects(verified.apply(changing, { persistPending: async record => { driftPending = record; } }), { code: 'mapping-verification-failed' });
  assert.equal((await verified.inspectOwnership(driftPending)).state, 'changed');
  await state({ failAfterApply: true });
  let crashPending;
  await assert.rejects(verified.apply(changing, { persistPending: async record => { crashPending = record; } }), error => error.code === 'cli-failed' && !error.message.includes('secret'));
  assert.equal((await verified.inspectOwnership(crashPending)).state, 'owned');
  const recoveredState = JSON.parse(await readFile(statePath, 'utf8'));
  delete recoveredState.failAfterApply;
  await writeFile(statePath, JSON.stringify(recoveredState));
  const restarted = createRemoteNetworkAdapter({ executable: binary });
  await restarted.remove(crashPending, { persistPending: async () => {} });
  assert.equal((await restarted.inspectOwnership(crashPending)).state, 'absent');
  await state();
  const concurrent = await Promise.allSettled([
    verified.apply(changing, { persistPending: async () => {} }),
    verified.apply(changing, { persistPending: async () => {} }),
  ]);
  assert.equal(concurrent[0].status, 'fulfilled');
  assert.equal(concurrent[1].reason.code, 'mapping-collision');
  await verified.remove(concurrent[0].value, { persistPending: async () => {} });
  const commands = (await readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(commands.filter(a => a[0] === 'serve' && a[1] !== 'status'), [
    ['serve', '--bg', '--https=443', '--set-path=/', 'http://127.0.0.1:43123'],
    ['serve', '--bg', '--https=443', '--set-path=/', 'off'],
  ]);
  console.log('PASS foreign config preservation, drift refusal, crash reconciliation and serialization');
  await state();
  let listenerLive = true;
  const lifecycle = createRemoteNetworkAdapter({ executable: binary, verifyRemoteListener: async () => listenerLive });
  const liveProposal = await lifecycle.propose({ remoteListener: listener, httpsPort: 8443 });
  assert.equal(liveProposal.publicOrigin, 'https://host.example.ts.net:8443');
  await assert.rejects(lifecycle.apply(liveProposal, { persistPending: async () => { listenerLive = false; } }), { code: 'unverified-listener' });
  assert.deepEqual((await lifecycle.inspect()).config, {});
  listenerLive = true;
  const liveOwned = await lifecycle.apply(liveProposal, { persistPending: async () => {} });
  const renamed = JSON.parse(await readFile(statePath, 'utf8'));
  renamed.status.Self.DNSName = 'renamed.example.ts.net.';
  renamed.status.CertDomains = ['renamed.example.ts.net'];
  await writeFile(statePath, JSON.stringify(renamed));
  await assert.rejects(lifecycle.remove(liveOwned, { persistPending: async () => {} }), { code: 'network-changed' });
  console.log('PASS listener and node identity recheck immediately before mutations');

  const caps = { https: null, funnel: [], 'https://tailscale.com/cap/funnel-ports?ports=443,8443,10000': [] };
  const permittedStatus = { ...status, Self: { ...status.Self, CapMap: caps } };
  const persist = { persistPending: async () => {} };
  const mutations = async () => (await readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse).filter(a => ['serve', 'funnel'].includes(a[0]) && a[1] !== 'status');
  const patchState = async (extra) => {
    const current = JSON.parse(await readFile(statePath, 'utf8'));
    await writeFile(statePath, JSON.stringify({ ...current, ...extra }));
  };
  const allForeign = {
    ...foreign,
    AllowFunnel: { 'other.example.ts.net:8443': true },
    Foreground: { foreignSession: { TCP: { '9998': { TCPForward: '127.0.0.1:9999' } } } },
  };
  await state({ status: permittedStatus, config: allForeign });
  const oldPrivate = await verified.apply(await verified.propose({ remoteListener: listener }), persist);
  delete oldPrivate.scope; // 旧 schema1 的缺省范围仍然是私网。
  const publicProposal = await verified.proposeScope(oldPrivate, 'public');
  assert.equal(publicProposal.sourceScope, 'private');
  assert.equal(publicProposal.scope, 'public');
  assert.equal(publicProposal.id, oldPrivate.id);
  await assert.rejects(verified.changeScope(publicProposal, { persistPending: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await mutations()).length, 1);
  let scopePending;
  const publicOwned = await verified.changeScope(publicProposal, { persistPending: async record => {
    scopePending = record;
    assert.equal((await mutations()).length, 1);
    assert.equal((await verified.reconcileScope(record)).state, 'source');
  } });
  assert.equal((await verified.reconcileScope(scopePending)).state, 'destination');
  assert.equal((await verified.inspectOwnership(publicOwned)).state, 'owned');
  assert.deepEqual((await mutations()).at(-1), ['funnel', '--bg', '--https=443', '--set-path=/', oldPrivate.target]);
  await patchState({ status }); // Funnel 权限撤销后仍能恢复私网和删除自有公网映射。
  const restore = await verified.proposeScope(publicOwned, 'private');
  const privateAgain = await verified.changeScope(restore, persist);
  assert.deepEqual((await mutations()).at(-1), ['serve', '--bg', '--https=443', '--set-path=/', oldPrivate.target]);
  assert.deepEqual((await verified.inspect()).config.AllowFunnel, allForeign.AllowFunnel);
  await verified.remove(privateAgain, persist);
  assert.deepEqual((await verified.inspect()).config, allForeign);
  await state({ status: permittedStatus, config: allForeign });
  const toRemove = await verified.apply(await verified.propose({ remoteListener: listener }), persist);
  const publicToRemove = await verified.changeScope(await verified.proposeScope(toRemove, 'public'), persist);
  await patchState({ status });
  await verified.remove(publicToRemove, persist);
  assert.deepEqual((await verified.inspect()).config, allForeign);
  assert.deepEqual((await mutations()).at(-1), ['serve', '--bg', '--https=443', '--set-path=/', 'off']);
  console.log('PASS explicit scope, legacy private record, pending-before-Funnel, private restoration and owned public cleanup');

  for (const port of [443, 8443, 10000, 4443]) {
    await state({ status: permittedStatus });
    const privatePort = await verified.apply(await verified.propose({ remoteListener: listener, httpsPort: port }), persist);
    if (port === 4443) {
      await assert.rejects(verified.proposeScope(privatePort, 'public'), { code: 'unsupported-funnel-port' });
    } else {
      const pub = await verified.changeScope(await verified.proposeScope(privatePort, 'public'), persist);
      assert.equal(pub.scope, 'public');
      assert.deepEqual((await mutations()).at(-1), ['funnel', '--bg', `--https=${port}`, '--set-path=/', privatePort.target]);
    }
  }
  await state({ status: permittedStatus });
  const private8443 = await verified.apply(await verified.propose({ remoteListener: listener, httpsPort: 8443 }), persist);
  const portProposal = await verified.proposeScope(private8443, 'public');
  const beforeDenials = (await mutations()).length;
  const ambiguousStatus = { ...status, Self: { ...status.Self, CapMap: {
    https: [], funnel: [],
    'https://tailscale.com/cap/funnel-ports?ports=443': [],
    'https://tailscale.com/cap/funnel-ports?ports=443,8443': [],
  } } };
  await patchState({ status: ambiguousStatus });
  const [ambiguousChange] = await Promise.allSettled([verified.changeScope(portProposal, persist)]);
  assert.equal((await mutations()).length, beforeDenials, 'ambiguous port capabilities must not invoke Funnel');
  assert.equal(ambiguousChange.status, 'rejected');
  assert.equal(ambiguousChange.reason.code, 'funnel-capability-unknown');
  await assert.rejects(verified.proposeScope(private8443, 'public'), { code: 'funnel-capability-unknown' });
  for (const [badStatus, code] of [
    [status, 'funnel-capability-unknown'],
    [{ ...permittedStatus, Self: { ...status.Self, Capabilities: Object.keys(caps) } }, 'funnel-capability-unknown'],
    [{ ...permittedStatus, Self: { ...status.Self, CapMap: {} } }, 'funnel-port-denied'],
    ...[
      { https: [], funnel: true },
      { https: [], funnel: [] },
      { https: [], funnel: [], 'https://tailscale.com/cap/funnel-ports?ports=8443-443': [] },
      { https: [], funnel: [], 'https://tailscale.com/cap/funnel-ports?ports=8443&other=1': [] },
    ].map(CapMap => [{ ...status, Self: { ...status.Self, CapMap } }, 'funnel-capability-unknown']),
    [{ ...status, Self: { ...status.Self, CapMap: { https: [], funnel: [], 'https://tailscale.com/cap/funnel-ports?ports=443': [] } } }, 'funnel-port-denied'],
    [{ ...permittedStatus, BackendState: 'NeedsLogin' }, 'not-logged-in'],
    [{ ...permittedStatus, CertDomains: [] }, 'https-disabled'],
  ]) {
    await patchState({ status: badStatus });
    await assert.rejects(verified.proposeScope(private8443, 'public'), { code });
    await assert.rejects(verified.changeScope(portProposal, persist), { code });
    assert.equal((await mutations()).length, beforeDenials);
  }
  await patchState({ status: permittedStatus, version: '1.50.0' });
  await assert.rejects(verified.changeScope(portProposal, persist), { code: 'unsupported-version' });
  await patchState({ version: '1.52.0', status: { ...status, Self: { ...status.Self, CapMap: { https: [], funnel: [], 'https://tailscale.com/cap/funnel-ports?ports=443,8400-8500': [] } } } });
  assert.deepEqual((await verified.inspect()).funnelPorts, [443, 8443]);
  await assert.rejects(verified.changeScope(portProposal, { persistPending: async () => {
    await patchState({ status });
  } }), { code: 'funnel-capability-unknown' });
  assert.equal((await mutations()).length, beforeDenials);
  console.log('PASS supported public ports, requested-port range permission and fail-closed capability/version/login/HTTPS checks');

  for (const mode of ['noApply', 'failAfterApply', 'hangAfterApply', 'driftAfterApply']) {
    await state({ status: permittedStatus });
    const base = await verified.apply(await verified.propose({ remoteListener: listener }), persist);
    const proposal = await verified.proposeScope(base, 'public');
    await patchState({ [mode]: true });
    let uncertain;
    const bounded = createRemoteNetworkAdapter({ executable: binary, timeoutMs: 500, verifyRemoteListener: async () => true });
    await assert.rejects(bounded.changeScope(proposal, { persistPending: async record => { uncertain = record; } }),
      { code: mode === 'failAfterApply' ? 'cli-failed' : mode === 'hangAfterApply' ? 'timeout' : 'mapping-verification-failed' });
    assert.equal(uncertain.state, 'pending');
    const mutationCount = (await mutations()).length;
    const reader = createRemoteNetworkAdapter({ executable: binary });
    assert.equal((await reader.reconcileScope(uncertain)).state, mode === 'noApply' ? 'source' : mode === 'driftAfterApply' ? 'changed' : 'destination');
    await patchState({ config: {} });
    assert.equal((await reader.reconcileScope(uncertain)).state, 'absent');
    assert.equal((await mutations()).length, mutationCount);
  }
  await state({ status: permittedStatus });
  const scopeBase = await verified.apply(await verified.propose({ remoteListener: listener }), persist);
  const scopeChange = await verified.proposeScope(scopeBase, 'public');
  await assert.rejects(verified.changeScope(scopeChange, { persistPending: async () => {
    const current = JSON.parse(await readFile(statePath, 'utf8'));
    current.config.Web['host.example.ts.net:443'].Handlers['/'].Proxy = 'http://127.0.0.1:9999';
    await patchState({ config: current.config });
  } }), { code: 'mapping-changed' });
  assert.equal((await mutations()).length, 1);
  await state({ status: permittedStatus });
  const serialBase = await verified.apply(await verified.propose({ remoteListener: listener }), persist);
  const serialProposal = await verified.proposeScope(serialBase, 'public');
  const scopeResults = await Promise.allSettled([verified.changeScope(serialProposal, persist), verified.changeScope(serialProposal, persist)]);
  assert.equal(scopeResults[0].status, 'fulfilled');
  assert.equal(scopeResults[1].reason.code, 'mapping-changed');
  assert.equal((await mutations()).filter(a => a[0] === 'funnel').length, 1);
  const scopePublic = scopeResults[0].value;
  const exactPublicConfig = (await verified.inspect()).config;
  for (const modify of [
    config => { config.Web['host.example.ts.net:443'].Handlers['/extra'] = { Text: 'foreign' }; },
    config => { config.Web['alias.example.ts.net:443'] = { Handlers: { '/': { Text: 'foreign' } } }; },
    config => { config.AllowFunnel['alias.example.ts.net:443'] = true; },
    config => { config.Foreground = { foreign: { TCP: { '443': { HTTPS: true } } } }; },
  ]) {
    const changedConfig = structuredClone(exactPublicConfig);
    modify(changedConfig);
    await patchState({ config: changedConfig });
    await assert.rejects(verified.proposeScope(scopePublic, 'private'), { code: 'mapping-changed' });
    await assert.rejects(verified.remove(scopePublic, persist), { code: 'mapping-changed' });
  }
  assert.equal((await mutations()).length, 2);
  await state({ status: permittedStatus });
  const listenerBase = await verified.apply(await verified.propose({ remoteListener: listener }), persist);
  listenerLive = true;
  const listenerScope = await lifecycle.proposeScope(listenerBase, 'public');
  await assert.rejects(lifecycle.changeScope(listenerScope, { persistPending: async () => { listenerLive = false; } }), { code: 'unverified-listener' });
  assert.equal((await mutations()).length, 1);
  assert.throws(() => verified.apply({ ...listenerScope, operation: 'apply' }, persist), { code: 'invalid-record' });
  await assert.rejects(verified.proposeScope(listenerBase, 'private'), { code: 'invalid-record' });
  await state({ status: permittedStatus });
  const cleanupBase = await verified.apply(await verified.propose({ remoteListener: listener }), persist);
  const cleanupPublic = await verified.changeScope(await verified.proposeScope(cleanupBase, 'public'), persist);
  await patchState({ status: ambiguousStatus });
  const restoredAmbiguous = await verified.changeScope(await verified.proposeScope(cleanupPublic, 'private'), persist);
  assert.equal(restoredAmbiguous.scope, 'private');
  await patchState({ status: permittedStatus });
  const removeAmbiguous = await verified.changeScope(await verified.proposeScope(restoredAmbiguous, 'public'), persist);
  await patchState({ status: ambiguousStatus });
  await verified.remove(removeAmbiguous, persist);
  assert.deepEqual((await verified.inspect()).config, {});
  console.log('PASS scope drift, zero-exit-noapply, applied-then-failure/timeout, readonly reconciliation and serialization');

} finally {
  await rm(root, { recursive: true, force: true });
}
