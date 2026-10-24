'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { CoreBackend } = require('../app/src/core/backend.cjs');
const { manageTask } = require('../app/src/core/tasks.cjs');
const contract = require('../packages/workbench/client/desktop-contract.cjs');

async function fixture(t, entries, read) {
  const home = await mkdtemp(join(tmpdir(), 'areal-desktop-receipts-'));
  const backend = Object.assign(Object.create(CoreBackend.prototype), { home, saves: new Map(), awaitingResponses: new WeakSet(),
    onChange() {}, providers: { redact: value => value, acceptModelSelection: async () => {} },
    lifecycleOperations: { activeTargets: new Set(), blocking: () => false },
    listThreads: async () => {}, openThread: async () => {} });
  const calls = [];
  const project = { id: 'project', pending: entries, outcomes: {}, configurations: {}, connectionGeneration: 1,
    model: { state: { connected: true, threads: {} }, setTask() {} },
    client: { ready: true, closed: false, capabilities: { features: { operationOutcomes: true, taskRequestReceipts: true } },
      request: async (method, params) => { calls.push({ method, params }); return read(method, params); } } };
  t.after(async () => { backend.closing = true; clearTimeout(project.reconciliation?.timer); await rm(home, { recursive: true, force: true }); });
  return { backend, project, calls };
}
const entry = (method, params) => ({ method, params: { ...params, requestId: randomUUID() } });
const receipt = item => ({ requestId: item.params.requestId, method: item.method, status: 'completed',
  operation: { requestId: item.params.requestId, method: item.method, target: { kind: 'task', taskId: item.params.taskId } },
  result: { id: item.params.taskId, revision: 2 } });

test('accepted manual run survives a failed Task refresh without a second submission', async t => {
  const item = entry('areal/task/runNow', { taskId: 'manual', expectedRevision: 1 });
  const accepted = { taskId: 'manual', runId: 'original-run', accepted: true, revision: 2 };
  let reads = 0;
  const f = await fixture(t, [], async method => {
    assert.equal(method, 'areal/task/read');
    if (reads++ === 0) return { id: 'manual', mode: 'manual' };
    throw new Error('Task view temporarily unavailable');
  });
  f.project.client.capabilities.methods = ['areal/task/runNow'];
  let submissions = 0;
  f.backend.submit = async (_project, method, params, options) => {
    submissions++;
    assert.equal(method, item.method);
    assert.equal(options.requestId, item.params.requestId);
    return accepted;
  };
  const result = await manageTask(f.backend, f.project, { operation: 'taskRunNow', ...item.params });
  assert.deepEqual(result, accepted);
  assert.equal(submissions, 1);
  assert.ok(reads >= 2, 'preflight read succeeds; only the post-admission refresh fails');
  assert.ok(f.project.refreshErrors[item.params.requestId]);
  assert.equal(f.project.refreshErrors[item.params.requestId].operation.target.taskId, 'manual');
});

test('manual-run receipt reconciles its original request and refreshes a Task rather than its admission reply', async t => {
  const item = entry('areal/task/runNow', { taskId: 'manual', expectedRevision: 1 });
  const accepted = { taskId: 'manual', runId: 'original-run', accepted: true, revision: 2 };
  let reads = 0;
  const task = { id: 'manual', revision: 2, runs: [{ id: 'original-run', status: 'running' }] };
  const installed = [];
  const f = await fixture(t, [item], async method => {
    if (method === 'areal/request/read') return { data: [{ ...receipt(item), result: accepted }] };
    assert.equal(method, 'areal/task/read');
    return task;
  });
  f.project.model.setTask = value => installed.push(value);
  await f.backend.reconcile(f.project);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.project.outcomes[item.params.requestId].accepted, true);
  assert.deepEqual(f.project.pending, []);
  assert.deepEqual(installed, [task]);
  assert.deepEqual(f.calls.map(call => call.method), ['areal/request/read', 'areal/task/read']);
});

test('command declarations distinguish mixed reads, subscriptions and recoverable writes', () => {
  for (const name of Object.keys(contract.commandDefinitions)) assert.ok(contract.commandDefinitions[name][2], name);
  for (const [name, operation, effect] of [['manage','task','read'], ['manage','taskWatch','subscription'], ['manage','taskPause','mutation'],
    ['manage','pluginSubmission','read'], ['side','context','read'], ['resources','skillRead','read'], ['providers','revealKey','read'], ['library','readThread','mutation']])
    assert.equal(contract.commandSemantics(name, { operation }).effect, effect, `${name}/${operation}`);
  assert.equal(contract.commandSemantics('create', {}).requestId, 'requestId');
  assert.equal(contract.commandSemantics('manage', { operation: 'taskDraftStart' }).requestId, 'draftId');
  assert.throws(() => contract.commandSemantics('manage', { operation: 'futureRead' }));
});
test('task reconciliation ignores crossed targets and settles independent receipt after a failed lookup', async t => {
  const a = entry('areal/task/pause', { taskId: 'a' }), b = entry('areal/task/update', { taskId: 'b' });
  let phase = 0;
  const f = await fixture(t, [a,b], async (method, params) => {
    assert.equal(method, 'areal/request/read');
    if (params.requestId === a.params.requestId) { if (phase === 0) throw new Error('lookup unavailable'); return { data: [{ ...receipt(a), operation: { ...receipt(a).operation, target: { kind: 'task', taskId: 'other' } } }] }; }
    return { data: [receipt(b)] };
  });
  await f.backend.reconcile(f.project); phase++;
  assert.equal(f.project.outcomes[b.params.requestId]?.accepted, true);
  assert.deepEqual(f.project.pending, [a]);
  await f.backend.reconcile(f.project);
  assert.deepEqual(f.project.pending, [a]);
});
test('completed error receipt preserves admitted execution failure', async t => {
  const item = entry('areal/provider/upsert', {});
  const f = await fixture(t, [item], async () => ({ data: [{ method: item.method, requestId: item.params.requestId,
    operation: { method: item.method, requestId: item.params.requestId, target: { kind: 'project' } }, status: 'failed',
    error: { message: 'effect failed after admission', code: -32603 } }] }));
  await f.backend.reconcile(f.project);
  assert.equal(f.project.outcomes[item.params.requestId]?.accepted, true);
  assert.equal(f.project.outcomes[item.params.requestId]?.status, 'failed');
  assert.equal(f.project.pending.length, 0);
});
test('legacy configuration recovery only observes and retains unknown original identity', async t => {
  const item = { method: 'areal/thread/configure', localOnly: true, params: { threadId: 'thread', expectedRevision: 1 } };
  const f = await fixture(t, [item], async method => { assert.equal(method, 'areal/thread/inspect'); return { configuration: { revision: 1 } }; });
  await f.backend.reconcile(f.project);
  assert.deepEqual(f.project.pending, [item]);
  assert.equal(item.params.requestId, undefined);
  assert.equal(f.calls.some(call => call.method === 'areal/thread/configure'), false);
});
