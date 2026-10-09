import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);

// 真实 Core/Runtime 和桌面连接；只在外部模型边界使用确定性 fixture。
const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(gui, 'app/package.json'));
const { CoreBackend } = require('../app/src/core/backend.cjs');
const scratch = await mkdtemp('/private/tmp/areal-connection-');
const workspace = join(scratch, 'workspace');
const home = join(scratch, 'desktop');
await mkdir(workspace);
await mkdir(join(scratch, 'user'));
let finish, requests = 0;
const model = createServer(async (request, response) => {
  for await (const _ of request) { /* 消费请求后保留流，供断线恢复期间继续执行。 */ }
  requests++;
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  chunk({ content: 'BEFORE_DISCONNECT' });
  finish = () => { chunk({ content: 'AFTER_RECONNECT' }); chunk({}, 'stop'); response.end('data: [DONE]\n\n'); };
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const config = join(scratch, 'config.toml');
await writeFile(config, `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`);
const deployment = join(scratch, 'desktop.json');
await writeFile(deployment, JSON.stringify({ profiles: [{ id: 'fixture', revision: 'v1', displayName: 'Fixture', instructions: 'Complete the task' }] }));
const backend = new CoreBackend({ binary: process.env.AREAL_CORE_BIN || resolve(gui, '../../target/debug/areal'),
  home, harnessHome: join(scratch, 'registry'), userHome: join(scratch, 'user'), config,
  desktopConfig: deployment, defaultProfile: { id: 'fixture', revision: 'v1' } });
const checks = [];
async function until(predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error(`Timeout: ${label}`);
}
let passed = false;
try {
  await backend.init();
  const projectId = await backend.addProject(workspace);
  const project = backend.projects.get(projectId);
  const { threadId } = await backend.command('create', { projectId });
  await backend.command('send', { projectId, threadId, text: 'Continue while the observer reconnects' });
  await until(() => finish && project.model.state.threads[threadId]?.turns.at(-1)?.status === 'inProgress', 'active turn');
  const generation = project.service.generation;
  const old = project.client;
  old.socket.terminate();
  await until(() => backend.starting.has(projectId), 'recovery admission');
  assert.equal(await backend.start(projectId), project, 'concurrent user operations join the recovered project');
  await until(() => project.client !== old && project.model.state.connected && !project.taskNotificationMonitor?.stopped, 'automatic observer recovery');
  assert.equal(project.service.generation, generation, 'observer recovery must not restart Core');
  assert.equal(requests, 1, 'observer recovery must not resubmit the turn');
  checks.push('real Core observation reconnects without restart or duplicate model submission');
  checks.push('concurrent user operations receive the project from the shared recovery task');
  const before = JSON.stringify(project.model.state);
  old.receive(JSON.stringify({ method: 'areal/thread/configured', params: { threadId, configuration: { revision: 999999 } } }));
  assert.equal(JSON.stringify(project.model.state), before, 'closed connection cannot publish late notifications');
  assert.notEqual(project.configurations[threadId]?.revision, 999999);
  checks.push('late packets from the retired connection do not mutate the current projection');
  finish();
  await until(() => project.model.state.threads[threadId]?.turns.at(-1)?.status === 'completed', 'turn completes through restored subscription');
  assert.match(JSON.stringify(project.model.state.threads[threadId]), /AFTER_RECONNECT/);
  assert.equal(requests, 1);
  await execute(backend.binary, ['service', 'stop', '--instance', project.service.serviceId, '--json'], { env: backend.hooks.environment(), timeout: 15000 });
  await until(() => project.reconnectBlocked && !backend.starting.has(projectId), 'stopped Core blocks passive recovery');
  assert.equal(project.model.state.connected, false);
  assert.equal(project.reconnectTimer, null);
  const { stdout } = await execute(backend.binary, ['service', 'status', '--instance', project.service.serviceId, '--json'], { env: backend.hooks.environment() });
  assert.equal(JSON.parse(stdout).state, 'stopped', 'passive recovery must not launch a stopped Core');
  checks.push('an externally stopped Core blocks passive recovery without being relaunched');
  assert.equal(await backend.start(projectId), project, 'an explicit user action can connect again');
  await backend.shutdown();
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(project.client, null, 'explicit shutdown must not resurrect an observation connection');
  checks.push('explicit shutdown cancels reconnect work and leaves Core stopped');
  passed = true;
} finally {
  if (!passed) {
    finish?.();
    for (const project of backend.projects.values()) {
      try { await project.client?.request('areal/server/drain', { strategy: 'cancel' }); } catch { /* 失败证据保留。 */ }
    }
    await backend.shutdown().catch(() => backend.disconnect());
  }
  model.closeAllConnections();
  await new Promise(resolve => model.close(resolve));
  await writeFile(join(scratch, 'manifest.json'), JSON.stringify({ passed, checks, scope: 'real Core/Runtime desktop observer; deterministic local model' }, null, 2));
  console.log(JSON.stringify({ passed, evidence: scratch, checks }));
}
