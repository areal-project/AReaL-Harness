import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile, copyFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { applicationFixture } from './application-fixture.mjs';
import { assertApplicationStopped } from './application-cleanup.mjs';
import { respondToSessionName } from './model-fixture.mjs';
import { captureSmokeFailure, selectConversation } from './smoke-navigation.mjs';

const gui = resolve(import.meta.dirname, '..'), root = resolve(gui, '../..');
const require = createRequire(join(gui, 'app/package.json'));
const { _electron: electron } = require('playwright-core');
const { CoreClient } = await import('../packages/runtime-client/core.js');
const WebSocket = require('ws');
const binary = process.env.AREAL_CORE_BIN;
assert.ok(binary && isAbsolute(binary), 'AREAL_CORE_BIN must select the changed, fixed Core executable');
const scratch = await mkdtemp('/private/tmp/areal-cua-core-');
const evidence = resolve('.scratch/lcu-integration', `electron-${Date.now()}`);
await mkdir(evidence, { recursive: true });
const workspace = join(scratch, 'workspace'); await mkdir(workspace);
execFileSync('git', ['init', '-b', 'main'], { cwd: workspace, stdio: 'ignore' });
execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'], { cwd: workspace, stdio: 'ignore' });
const log = join(scratch, 'lcu-events.jsonl'), executable = join(scratch, 'lcu');
await writeFile(executable, `#!/bin/sh\nexec '${process.execPath}' '${join(gui, 'scripts/fixtures/external-cua/runtime.mjs')}' '${log}'\n`, { mode: 0o700 });
const env = { ...process.env, TMPDIR: '/private/tmp' };
for (const key of Object.keys(env)) if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
Object.assign(env, { AREAL_CORE_BIN: binary, AREAL_CORE_CONFIG: join(scratch, 'config.toml'),
  AREAL_CORE_HOME: join(scratch, 'core'), AREAL_CORE_USER_HOME: join(scratch, 'user'),
  AREAL_HARNESS_HOME: join(scratch, 'harness'), AREAL_HARNESS_SERVICE_HOME: join(scratch, 'registry'),
  AREAL_GUI_USER_DATA: join(scratch, 'electron'), AREAL_CORE_DESKTOP_CONFIG: join(scratch, 'desktop.json'),
  NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1' });
const requests = [], errors = [], checks = [], histories = {}, dialogs = [];
const answeredApprovals = new Set();
let scenario, app, application, page, metadata, projectId, threadId, passed = false, failure, cleanup;
const sha = value => createHash('sha256').update(value).digest('hex');
const coreHash = sha(await readFile(binary));
const server = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    if (respondToSessionName(body, response)) return;
    if (body.messages?.some(message => typeof message.content === 'string' && message.content.startsWith('Predict the next user prompt'))) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end('data: {"choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); return;
    }
    assert.ok(scenario, 'model request has an active fixture scenario');
    requests.push({ scenario: scenario.id, body });
    const names = (body.tools ?? []).map(tool => tool.function?.name);
    if (scenario.tool !== 'computer_v1') {
      assert.ok(names.includes('js') && names.includes('js_reset') && names.includes('browser_v1'));
      assert.ok(!names.includes('computer_v1') && !names.includes('turn_ended') && !names.includes('set_turn_context'));
      const systemText = body.messages.filter(message => ['system', 'developer'].includes(message.role)).map(message => typeof message.content === 'string' ? message.content : message.content.map(part => part.text ?? '').join('')).join('\n');
      assert.ok(systemText.includes('ORIGINAL CUA INSTRUCTIONS\n' + 'Complete runtime instruction. '.repeat(400) + '\nORIGINAL INSTRUCTIONS END'));
      assert.ok(systemText.includes('USER_RULE_PRESERVED'));
      assert.equal(body.tools.find(tool => tool.function?.name === 'js').function.parameters.additionalProperties, false);
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (!scenario.sent) {
      scenario.sent = true;
      send({ tool_calls: [{ index: 0, id: scenario.id, type: 'function', function: { name: scenario.tool ?? 'js', arguments: JSON.stringify(scenario.arguments ?? { code: scenario.code }) } }] });
      send({}, 'tool_calls');
    } else { send({ content: `CUA_COMPLETE_${scenario.id}` }); send({}, 'stop'); }
    response.end('data: [DONE]\n\n');
  } catch (error) { errors.push(error.stack); response.destroy(); }
});
const snapshot = () => page.evaluate(() => window.arealDesktop.snapshot());
const project = value => value.projects.find(item => item.id === projectId || item.root === workspace);
async function until(predicate, label, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(`Timeout: ${label}`);
}
async function command(name, params) {
  const result = await page.evaluate(({ name, params }) => window.arealDesktop.command(name, params), { name, params });
  assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
}
async function history(id = threadId) {
  const owner = project(await snapshot());
  const instanceId = owner.state?.threads?.[id]?.executionCore?.instanceId ?? owner.core.instanceId;
  const descriptor = JSON.parse(execFileSync(binary, ['service', 'status', '--instance', instanceId, '--json'], { env, encoding: 'utf8', timeout: 20000 }));
  const auth = JSON.parse(await readFile(descriptor.authFile, 'utf8'));
  const principal = auth.principals.find(item => item.permissions.includes('observe'));
  const client = new CoreClient({ createSocket: () => new WebSocket(descriptor.endpoint, { headers: { Authorization: `Bearer ${principal.token}` }, followRedirects: false }) });
  try { await client.connect(); return (await client.request('thread/read', { threadId: id, includeTurns: true })).thread; }
  finally { client.close(); }
}
async function newThread(worktree = false) {
  threadId = (await command('create', { projectId, ...(worktree ? { worktree: { mode: 'worktree' } } : {}), browserEnabled: true, profile: { id: 'fixture', revision: 'v1' }, options: { permissionPreset: 'ask', appendInstructions: 'USER_RULE_PRESERVED' } })).threadId;
  await selectConversation(page, threadId);
  return threadId;
}
async function outerApproval() {
  const pending = project(await snapshot())?.state?.interactions?.[threadId]?.data?.find(item => item.kind === 'approval' && item.status === 'pending');
  if (!pending || answeredApprovals.has(pending.requestId)) return;
  const panel = page.locator('[data-interaction="approval"]');
  if (await panel.count() && await panel.isVisible()) {
    answeredApprovals.add(pending.requestId);
    await panel.getByRole('button', { name: '允许一次', exact: true }).click();
  }
}
async function run(value) {
  scenario = { ...value, sent: false }; console.log('CUA scenario:', value.id);
  const before = (await history()).turns.length;
  await command('send', { projectId, threadId, text: `External CUA acceptance ${value.id}` });
  await until(async () => {
    await outerApproval();
    const current = project(await snapshot())?.state?.threads?.[threadId];
    return current?.turns.length > before && ['completed', 'failed', 'interrupted'].includes(current.turns.at(-1)?.status);
  }, `settled ${value.id}`, 90000);
  const current = await history(); histories[value.id] = current;
  const turn = current.turns.at(-1);
  assert.equal(turn.status, 'completed', JSON.stringify(turn));
  return { turn, item: turn.items.find(item => item.type === 'dynamicToolCall' && item.callId === value.id) };
}
console.log('External CUA Core evidence:', evidence, 'isolated state:', scratch);
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await writeFile(env.AREAL_CORE_CONFIG, `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${server.address().port}/v1/chat/completions"\n`);
  await writeFile(env.AREAL_CORE_DESKTOP_CONFIG, JSON.stringify({ profiles: [{ id: 'fixture', revision: 'v1', displayName: 'Fixture', instructions: 'Use the requested tool.' }] }));
  application = await applicationFixture(gui, join(scratch, 'app'));
  app = await electron.launch({ executablePath: require('electron'), args: [application.path], env, timeout: 120000 });
  app.process().stderr.on('data', chunk => { void writeFile(join(evidence, 'electron.log'), chunk, { flag: 'a' }); });
  page = await app.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.stack));
  await page.getByTestId('areal-workbench').waitFor({ timeout: 120000 });
  await until(async () => (await snapshot()).connection?.state === 'ready', 'Desktop ready');
  metadata = JSON.parse(await readFile(join(env.AREAL_CORE_HOME, 'service.json'), 'utf8'));
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, workspace);
  await page.getByRole('button', { name: '不在项目中工作', exact: true }).click();
  await page.getByRole('menuitem', { name: '新建项目', exact: true }).click();
  await until(async () => project(await snapshot())?.state?.connected, 'Project ready');
  projectId = project(await snapshot()).id;
  await command('library', { operation: 'settings', key: 'computerControlEnabled', value: true });
  const secondary = new WebSocket(metadata.endpoint, { headers: { Authorization: `Bearer ${metadata.token}` }, followRedirects: false });
  await new Promise((resolve, reject) => { secondary.once('open', resolve); secondary.once('error', reject); });
  let secondaryId = 0;
  const secondaryRequest = (method, params) => new Promise((resolve, reject) => {
    const id = ++secondaryId;
    const timer = setTimeout(() => { secondary.off('message', receive); reject(new Error('Secondary host request timed out')); }, 10000);
    const receive = bytes => { const packet = JSON.parse(String(bytes)); if (packet.id !== id) return;
      clearTimeout(timer); secondary.off('message', receive); resolve(packet); };
    secondary.on('message', receive); secondary.send(JSON.stringify({ id, method, params }));
  });
  try {
    const hello = await secondaryRequest('hello', { protocol: metadata.protocol, identity: metadata.identity, capabilities: { computerHost: 1 } });
    assert.equal(hello.result.computerHostOwned, false);
    const before = (await secondaryRequest('snapshot', {})).result.snapshot.library;
    const denied = await secondaryRequest('command', { name: 'library', request: { operation: 'settings', key: 'computerControlProvider', value: 'lcu' } });
    assert.match(denied.error.message, /local computer control host/);
    const after = (await secondaryRequest('snapshot', {})).result.snapshot.library;
    assert.deepEqual(after.settings, before.settings); assert.equal(after.sidebarRevision, before.sidebarRevision);
    checks.push('Non-owner host cannot change provider settings or their revision');
  } finally { secondary.close(); }
  const nativeThread = await newThread();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '电脑控制', exact: true }).click();
  await page.getByRole('tab', { name: '外部 CUA（LCU）', exact: true }).click();
  await until(async () => (await snapshot()).library.settings.computerControlProvider === 'lcu', 'saved provider');
  await page.getByRole('textbox', { name: 'LCU 程序路径', exact: true }).fill(executable);
  await page.getByRole('button', { name: '保存路径', exact: true }).click();
  await until(async () => (await snapshot()).library.settings.computerControlExecutable === executable, 'saved executable');
  await page.getByRole('button', { name: '检查连接', exact: true }).click();
  await until(async () => (await command('computerControl', { operation: 'status' })).ready, 'LCU connection checked');
  await page.screenshot({ path: join(evidence, 'settings.png') });
  await page.getByRole('button', { name: '返回应用', exact: true }).click();
  await selectConversation(page, nativeThread); threadId = nativeThread;
  const old = await run({ id: 'native-refused', tool: 'computer_v1', arguments: { operation: 'describe', parameters: {} } });
  assert.equal(old.item.success, false);
  assert.match(JSON.stringify(old.item), /not_authorized|disabled/);
  checks.push('LCU settings persist through Main and stale native calls are refused');
  await app.evaluate(({ dialog }) => {
    globalThis.cuaDialogs = []; globalThis.cuaChoice = 'Allow once';
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      if (options.title !== 'External computer control') return { response: options.cancelId ?? 0 };
      globalThis.cuaDialogs.push({ message: options.message, detail: options.detail, buttons: options.buttons, defaultId: options.defaultId, signal: Boolean(options.signal) });
      return { response: options.buttons.indexOf(globalThis.cuaChoice) };
    };
  });
  await newThread();
  for (const [id, choice, expected] of [['allow', 'Allow once', 'accept'], ['decline', 'Decline', 'decline'], ['cancel', 'Cancel', 'cancel']]) {
    await app.evaluate((_electron, value) => { globalThis.cuaChoice = value; }, choice);
    const result = await run({ id, code: 'approval' });
    assert.equal(result.item.success, true);
    assert.ok(JSON.stringify(result.item).includes(expected));
  }
  await app.evaluate(() => { process.env.LCU_ALLOW_AGENT_HOST_APPROVAL = '1'; });
  const hostGuard = await run({ id: 'host-refused', code: 'approval-host' });
  assert.ok(JSON.stringify(hostGuard.item).includes('decline'));
  const electronExecutable = await app.evaluate(() => process.execPath);
  const bundle = electronExecutable.slice(0, electronExecutable.indexOf('.app/') + 4);
  const selfBundle = execFileSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', bundle + '/Contents/Info.plist'], { encoding: 'utf8' }).trim();
  const selfGuard = await run({ id: 'self-refused', code: `approval-app:${selfBundle}` });
  assert.ok(JSON.stringify(selfGuard.item).includes('decline'));
  await app.evaluate(() => { delete process.env.LCU_ALLOW_AGENT_HOST_APPROVAL; });
  dialogs.push(...await app.evaluate(() => globalThis.cuaDialogs));
  assert.equal(dialogs.length, 3);
  assert.ok(dialogs.every(dialog => dialog.signal && dialog.buttons[dialog.defaultId] === 'Cancel'));
  checks.push('Main forwards native consent options and exact accept/decline/cancel answers; dialog answers are fixture-driven');
  const image = await run({ id: 'image', code: 'image' });
  assert.equal(image.item.success, true);
  const media = image.item.contentItems.find(part => part.type === 'arealMedia' && part.modality === 'image');
  assert.ok(media?.media?.uri);
  const bytes = Buffer.from(await page.evaluate(async params => {
    const result = await window.arealDesktop.command('media', params);
    if (!result.ok) throw new Error(JSON.stringify(result));
    return Array.from(new Uint8Array(result.value.bytes));
  }, { projectId, threadId, operation: 'read', uri: media.media.uri }));
  const imageHash = sha(bytes);
  assert.ok(requests.filter(entry => entry.scenario === 'image').some(entry => JSON.stringify(entry.body).includes('MIXED_RESULT_END')));
  assert.ok(requests.filter(entry => entry.scenario === 'image').some(entry => JSON.stringify(entry.body).includes(bytes.toString('base64'))));
  const rawRef = image.item.execution.resultSnapshot;
  assert.ok(rawRef?.uri, 'raw MCP result is durably inspectable');
  const rawBytes = await page.evaluate(async params => {
    const result = await window.arealDesktop.command('media', params);
    if (!result.ok) throw new Error(JSON.stringify(result));
    return Array.from(new Uint8Array(result.value.bytes));
  }, { projectId, threadId, operation: 'read', uri: rawRef.uri });
  const rawResult = JSON.parse(Buffer.from(rawBytes).toString());
  assert.equal(rawResult.mcpResult.structuredContent.original, true);
  assert.ok(rawResult.mcpResult.content[0].text.endsWith('MIXED_RESULT_END'));
  assert.equal(sha(Buffer.from(rawResult.mcpResult.content[1].data, 'base64')), imageHash);
  await writeFile(join(evidence, 'raw-result.json'), JSON.stringify(rawResult));
  const events = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  const executed = events.filter(event => event.method === 'tools/call' && event.params.name === 'js');
  for (const event of executed) {
    const owner = event.params._meta['x-codex-turn-metadata'];
    const turn = histories[owner.call_id]?.turns.at(-1);
    assert.ok(turn); assert.equal(owner.thread_id, threadId); assert.equal(owner.session_id, threadId); assert.equal(owner.turn_id, turn.id);
  }
  for (const id of ['allow', 'decline', 'cancel', 'host-refused', 'self-refused', 'image']) {
    const normalTurn = histories[id].turns.at(-1).id;
    const cleanup = events.filter(event => event.params?.name === 'turn_ended' && event.params.arguments.turn_id === normalTurn);
    assert.deepEqual(cleanup.map(event => event.params.arguments.hook_event_name), ['Stop']);
  }
  assert.equal((await command('computerControl', { operation: 'status' })).active, false);
  checks.push('Core-issued identities, original instructions and schemas, consent choices, mixed media and raw history, normal cleanup');
  await newThread(true);
  scenario = { id: 'interrupt', code: 'wait', sent: false };
  await command('send', { projectId, threadId, text: 'External CUA interrupt acceptance' });
  await until(async () => { await outerApproval(); return (await command('computerControl', { operation: 'status' })).active; }, 'active CUA call');
  assert.equal((await snapshot()).computerControl.active, true);
  const running = (await history()).turns.at(-1);
  const executionProjectId = project(await snapshot()).state.threads[threadId].executionProjectId;
  assert.ok(executionProjectId);
  assert.notEqual(executionProjectId, projectId, 'Fixture explicitly selects a worktree for cross-host interruption');
  const stopRequestId = randomUUID();
  const stopReceipt = await command('stop', { projectId, threadId, turnId: running.id, requestId: stopRequestId });
  await writeFile(join(evidence, 'interrupt-receipt.json'), JSON.stringify(stopReceipt, null, 2));
  assert.notEqual(stopReceipt.operation.phase, 'blocked', JSON.stringify(stopReceipt));
  await until(async () => ['interrupted', 'failed'].includes((await history()).turns.at(-1)?.status), 'interrupt settlement');
  histories.interrupt = await history();
  const repeatedStop = await command('stop', { projectId, threadId, turnId: running.id, requestId: stopRequestId });
  assert.equal(repeatedStop.operation.requestId, stopRequestId);
  assert.equal(repeatedStop.operation.phase, 'completed');
  const changedOwner = await page.evaluate(params => window.arealDesktop.command('stop', params),
    { projectId: executionProjectId, threadId, turnId: running.id, requestId: stopRequestId });
  assert.equal(changedOwner.ok, false);
  assert.equal(changedOwner.error.code, 'LIFECYCLE_REQUEST_CONFLICT');
  assert.equal(histories.interrupt.turns.at(-1).items.find(item => item.callId === 'interrupt').execution.outcome, 'unknown');
  const interrupted = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(interrupted.some(event => event.params?.arguments?.hook_event_name === 'Interrupt' && event.params.arguments.turn_id === running.id));
  assert.equal(interrupted.filter(event => event.params?.arguments?.code === 'wait').length, 1);
  checks.push('Active call projection, cancellation cleanup and UNKNOWN without replay');
  await page.screenshot({ path: join(evidence, 'interrupted.png') });
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) { failure = error.stack; console.error(error.stack); if (page) await captureSmokeFailure(page, evidence, error).catch(() => {}); }
finally {
  if (app) {
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async (...args) => ({ response: ['确认取消后台任务？', '退出 AReaL Harness？'].includes(args.at(-1).message) ? 1 : args.at(-1).cancelId ?? 0 }); }).catch(() => {});
    await app.evaluate(({ app }) => app.quit()).catch(() => {});
  }
  await application?.close();
  try { await assertApplicationStopped(binary, env, metadata); cleanup = 'passed'; } catch (error) { cleanup = error.stack; passed = false; }
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await copyFile(log, join(evidence, 'lcu-events.jsonl')).catch(() => {});
  await writeFile(join(evidence, 'model-requests.json'), JSON.stringify(requests));
  await writeFile(join(evidence, 'histories.json'), JSON.stringify(histories));
  assert.equal(sha(await readFile(binary)), coreHash);
  await writeFile(join(evidence, 'manifest.json'), JSON.stringify({ passed, binary, coreHash, source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    ownedDiffHash: sha(execFileSync('git', ['diff', 'HEAD'], { cwd: root })), scratch, checks, dialogs, failure, cleanup, errors,
    boundaries: 'Source Electron, real Core, original vendored client, MCP subprocess fixture and local deterministic model. Native folder picker and consent answers are stubbed. No real LCU, physical input, OS grants, real provider or installed package acceptance.' }, null, 2));
  console.log('External CUA Core result:', passed ? 'PASS' : 'FAIL');
  if (!passed) process.exitCode = 1;
}
