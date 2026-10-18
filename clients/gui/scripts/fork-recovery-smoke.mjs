import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { CoreRpcError } from '../packages/runtime-client/core.js';

const require = createRequire(import.meta.url);
const { CoreBackend } = require('../app/src/core/backend.cjs');
const { desktopError, validateCommand } = require('../packages/workbench/client/desktop-contract.cjs');
// 前后边界都必须穿过同一个公开桌面契约。
for (const boundary of ['before', 'after']) validateCommand('fork', { projectId: 'project', sourceThreadId: 'source',
  anchor: { turnId: 'turn', boundary }, workspaceMode: 'sharedCurrent' });
assert.throws(() => validateCommand('fork', { projectId: 'project', sourceThreadId: 'source',
  anchor: { turnId: 'turn', boundary: 'unknown' }, workspaceMode: 'sharedCurrent' }), /无效桌面操作/);
const home = await mkdtemp(join(tmpdir(), 'areal-fork-recovery-'));
try {
  const backend = Object.create(CoreBackend.prototype);
  backend.home = home;
  backend.saves = new Map();
  backend.awaitingResponses = new WeakSet();
  backend.onChange = () => {};
  backend.closing = false;
  const entry = { method: 'areal/thread/fork', params: {
    requestId: 'fork-key', sourceThreadId: 'source', anchor: { turnId: 'turn', boundary: 'after' }, workspaceMode: 'sharedCurrent',
  } };
  let receipt;
  const requests = [];
  const client = { closed: false, request: async (method, params) => {
    requests.push([method, params]);
    assert.equal(method, 'areal/request/read');
    return { data: receipt ? [{ method: entry.method, result: { threadId: 'created-fork' } }] : [] };
  } };
  const project = { id: 'project', pending: [entry], outcomes: {}, client };
  const opened = [];
  backend.openThread = async (_project, id) => { opened.push(id); };
  backend.listThreads = async () => {};

  // 查不到账不代表创建未发生；本地日志和原业务键必须保留。
  await backend.reconcile(project);
  assert.equal(project.pending.length, 1);
  assert.equal(project.outcomes['fork-key'], undefined);
  assert.deepEqual(opened, []);
  await assert.rejects(() => backend.submit(project, 'areal/thread/fork', {
    sourceThreadId: 'source', anchor: { turnId: 'turn', boundary: 'after' }, workspaceMode: 'sharedCurrent',
  }, { requestId: '12345678-1234-1234-1234-123456789abc' }), /查询受理结果/);
  assert.equal(project.pending.length, 1);
  assert.equal(requests.length, 1, '未知时没有重发创建请求');

  receipt = true;
  await backend.reconcile(project);
  assert.equal(project.pending.length, 0);
  assert.equal(project.outcomes['fork-key'].threadId, 'created-fork');
  assert.equal(project.outcomes['fork-key'].sourceThreadId, 'source');
  assert.deepEqual(opened, ['created-fork']);
  assert.deepEqual(JSON.parse(await readFile(join(home, 'project-pending.json'), 'utf8')), []);
  assert.equal(requests.length, 2);
} finally {
  await rm(home, { recursive: true, force: true });
}

// Core 已受理后，即使本机投影失败，桌面命令也不能变成可重试提交。
const sideHome = await mkdtemp(join(tmpdir(), 'areal-side-projection-'));
try {
  const backend = Object.create(CoreBackend.prototype);
  Object.assign(backend, { home: sideHome, saves: new Map(), awaitingResponses: new WeakSet(),
    onChange() {}, closing: false });
  const mutations = [];
  const accepted = { thread: { id: 'accepted-side' }, turn: { id: 'accepted-turn' }, requestId: '12345678-1234-1234-1234-123456789abc' };
  const project = { id: 'side-project', pending: [], outcomes: {},
    model: { state: { threads: { 'accepted-side': { conversation: { kind: 'side' } } } } },
    client: { closed: false, capabilities: { methods: ['areal/side/start'] }, request: async (method, params) => {
      if (method === 'areal/request/read') return { data: [{ method: 'areal/side/start', result: { threadId: accepted.thread.id } }] };
      mutations.push([method, params]);
      return accepted;
    } } };
  backend.start = async () => project;
  for (const failure of ['open', 'list']) {
    backend.openThread = async () => { if (failure === 'open') throw Error('projection unavailable'); };
    backend.listThreads = async () => { if (failure === 'list') throw Error('list unavailable'); };
    const created = await backend.executeCommand('side', { projectId: project.id, operation: 'start',
      sourceThreadId: 'source', text: 'first question', requestId: accepted.requestId });
    assert.equal(created.threadId, accepted.thread.id);
    assert.equal(created.turnId, accepted.turn.id);
    assert.equal(project.pending.length, 0);
  }
  backend.openThread = async () => { throw Error('projection unavailable'); };
  assert.deepEqual(await backend.executeCommand('side', { projectId: project.id, operation: 'send',
    threadId: accepted.thread.id, text: 'follow up' }), accepted);
  assert.equal(project.pending.length, 0);
  project.pending.push({ method: 'areal/side/start', params: { requestId: accepted.requestId, sourceThreadId: 'source' } });
  const recovered = await backend.executeCommand('side', { projectId: project.id, operation: 'recover',
    sourceThreadId: 'source', requestId: accepted.requestId });
  assert.deepEqual(recovered, { confirmed: true, threadId: accepted.thread.id });
  assert.equal(project.pending.length, 0);
  assert.equal(project.outcomes[accepted.requestId].accepted, true);
  assert.deepEqual(mutations.map(([method]) => method), ['areal/side/start', 'areal/side/start', 'areal/turn/start'],
    '投影失败及收据核对都不得重放已受理的创建或追问');
} finally {
  await rm(sideHome, { recursive: true, force: true });
}

// Core → service IPC → main IPC 保留作用域拒绝原因，不转发私有数据。
const coreError = new CoreRpcError('Side action denied', {
  code: -32010,
  method: 'areal/side/start',
  data: { reason: 'SIDE_POLICY_VIOLATION', requestId: 'side-key', private: 'secret' },
});
const serviceWireError = JSON.parse(JSON.stringify(desktopError(coreError)));
const mainError = Object.assign(new Error(serviceWireError.message), serviceWireError);
const rendererWireError = desktopError(mainError);
assert.equal(rendererWireError.code, -32010);
assert.equal(rendererWireError.reason, 'SIDE_POLICY_VIOLATION');
assert.equal(rendererWireError.requestId, 'side-key');
assert.equal('data' in rendererWireError, false);
assert.equal(JSON.stringify(rendererWireError).includes('secret'), false);
