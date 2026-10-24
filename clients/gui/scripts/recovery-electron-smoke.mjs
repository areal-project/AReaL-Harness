#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.AREAL_RECOVERY_SOURCE_ROOT ?? join(here, '../../..'));
const gui = join(root, 'clients/gui');
const require = createRequire(join(gui, 'app/package.json'));
const { _electron: electron } = require('playwright-core');
const WebSocket = require('ws');
const { WebSocketServer } = WebSocket;
const { ServiceConnection } = require(join(gui, 'app/src/core/service-client.cjs'));
const { applicationFixture } = await import(pathToFileURL(join(gui, 'scripts/application-fixture.mjs')));
const { createProjectConversation } = await import(pathToFileURL(join(gui, 'scripts/smoke-navigation.mjs')));
const binary = process.env.AREAL_CORE_BIN;
const sha = value => createHash('sha256').update(value).digest('hex');
const json = (path, value) => writeFile(path, JSON.stringify(value, null, 2));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const displayTurns = turns => turns.map(turn => ({ id: turn.id, status: turn.status, items: turn.items,
  ...Object.fromEntries(['error', 'interruption', 'continuedFromTurnId', 'startedAt', 'completedAt',
    'durationMs', 'goal', 'usage', 'generation'].map(key => [key, turn[key] ?? null])),
}));
async function until(read, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await sleep(50); }
  throw new Error(`Timeout: ${label}`);
}
async function preflight() {
  assert.equal(process.platform, 'darwin', 'This source Electron runner is prepared for macOS');
  assert.ok(binary && isAbsolute(binary) && binary.includes('/.local/dev-bin/'), 'Set AREAL_CORE_BIN to the deployed private fixed Core path');
  const stat = await lstat(binary);
  assert.ok(stat.isFile() && stat.nlink === 1 && await realpath(binary) === binary, 'Core must be a regular independent copy');
  await access(join(gui, 'renderer/dist/index.html'));
  await access(require('electron'));
  const renderer = join(gui, 'renderer/dist');
  const rendererPaths = (await readdir(renderer, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile()).map(entry => join(entry.parentPath ?? entry.path, entry.name));
  const rendererSHA256 = Object.fromEntries(await Promise.all(rendererPaths.map(async path => [path, sha(await readFile(path))])));
  return { root, binary, binarySHA256: sha(await readFile(binary)), rendererSHA256, node: process.version,
    electron: require('electron/package.json').version, playwright: require('playwright-core/package.json').version,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    diffSHA256: sha(execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: root, maxBuffer: 32 * 1024 * 1024 })),
    helperSHA256: sha(await readFile(fileURLToPath(import.meta.url))) };
}
function environment(state) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
  const noProxy = [env.NO_PROXY, env.no_proxy, '127.0.0.1,localhost,::1'].filter(Boolean).join(',');
  return { ...env, NO_PROXY: noProxy, no_proxy: noProxy, AREAL_CORE_BIN: binary,
    AREAL_GUI_USER_DATA: join(state, 'electron'), AREAL_CORE_HOME: join(state, 'core'),
    AREAL_CORE_USER_HOME: join(state, 'user'), AREAL_HARNESS_HOME: join(state, 'config-home'),
    AREAL_HARNESS_SERVICE_HOME: join(state, 'registry'), AREAL_CORE_CONFIG: join(state, 'config.toml'),
    AREAL_CORE_DESKTOP_CONFIG: join(state, 'desktop.json') };
}
async function records(state) {
  const base = join(state, 'registry/services');
  let names; try { names = await readdir(base); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return (await Promise.all(names.map(name => readFile(join(base, name, 'service.json'), 'utf8').then(JSON.parse)
    .catch(error => { if (error.code === 'ENOENT') return null; throw error; })))).filter(Boolean);
}
async function restoreDescriptor(run, original) {
  const path = join(run.state, 'core/service.json');
  let current; try { current = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (current.pid !== original.pid || current.token !== original.token || current.identity !== original.identity) return;
  const temporary = `${path}.recovery-${run.owner}`;
  await writeFile(temporary, JSON.stringify({ ...current, endpoint: original.endpoint }), { mode: 0o600 });
  await rename(temporary, path);
}
async function transportProxy(metadata, events) {
  const sessions = new Set();
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });
  let armed = null, blocked = false, connections = 0;
  server.on('upgrade', (request, socket, head) => {
    if (blocked || request.headers.authorization !== `Bearer ${metadata.token}`) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(request, socket, head, down => wss.emit('connection', down, request));
  });
  wss.on('connection', down => {
    const entry = { down, up: new WebSocket(metadata.endpoint, { headers: { Authorization: `Bearer ${metadata.token}` },
      followRedirects: false, maxPayload: 256 * 1024 * 1024 }), queue: [], fault: null };
    sessions.add(entry); connections++;
    events.push({ at: Date.now(), type: 'proxy-connected', connection: connections });
    entry.up.on('open', () => { for (const [bytes, binary] of entry.queue) entry.up.send(bytes, { binary }); entry.queue.length = 0; });
    down.on('message', (bytes, binary) => {
      const message = JSON.parse(bytes.toString());
      if (armed && !armed.dispatched && message.method === 'command' && message.params?.name === armed.name) {
        entry.fault = armed; armed.dispatched = true; armed.rpcId = message.id;
        armed.requestId = message.params.request?.requestId; armed.threadId = message.params.request?.threadId;
        armed.projectId = message.params.request?.projectId;
        events.push({ at: Date.now(), type: 'fault-command-forwarded', name: armed.name, rpcId: message.id,
          requestId: armed.requestId, threadId: armed.threadId, projectId: armed.projectId });
      }
      if (message.method === 'command') events.push({ at: Date.now(), type: 'command', name: message.params?.name,
        requestId: message.params?.request?.requestId, threadId: message.params?.request?.threadId });
      if (entry.up.readyState === WebSocket.OPEN) entry.up.send(bytes, { binary });
      else if (entry.up.readyState === WebSocket.CONNECTING) entry.queue.push([bytes, binary]);
    });
    entry.up.on('message', (bytes, binary) => {
      const message = JSON.parse(bytes.toString()), fault = entry.fault;
      if (fault && message.id === fault.rpcId) {
        fault.response = message; fault.completed = true; fault.hadError = !!message.error;
        blocked = true;
        events.push({ at: Date.now(), type: 'real-desktop-response-discarded', name: fault.name,
          requestId: fault.requestId, hadError: fault.hadError });
        down.terminate(); entry.up.terminate(); return;
      }
      if (fault && message.method === 'state') { fault.withheldStates = (fault.withheldStates ?? 0) + 1; return; }
      if (down.readyState === WebSocket.OPEN) down.send(bytes, { binary });
    });
    const end = () => { sessions.delete(entry); down.terminate(); entry.up.terminate(); };
    down.on('close', end); entry.up.on('close', end);
    down.on('error', end); entry.up.on('error', end);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { endpoint: `ws://127.0.0.1:${server.address().port}`, get connections() { return connections; },
    arm(name) { assert.ok(!armed || armed.completed, 'Previous fault must settle'); armed = { name, dispatched: false, completed: false }; return armed; },
    release() { blocked = false; armed = null; events.push({ at: Date.now(), type: 'transport-restored' }); },
    async close() { blocked = false; for (const { down, up } of sessions) { down.terminate(); up.terminate(); }
      await new Promise(resolve => wss.close(resolve)); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
async function cleanup(run) {
  assert.match(run.state, /^\/private\/tmp\/arec-[^/]+$/);
  assert.equal(await readFile(join(run.state, '.owner'), 'utf8'), run.owner);
  let metadata;
  try { metadata = JSON.parse(await readFile(join(run.state, 'core/service.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (metadata && alive(metadata.pid)) {
    assert.equal(metadata.applicationOwner?.appRunId, run.appRunId, 'Refuse a different application owner');
    if (run.route && metadata.pid === run.route.pid && metadata.identity === run.route.identity
      && metadata.desktopGeneration === run.route.desktopGeneration && metadata.endpoint === run.route.proxyEndpoint) {
      const path = join(run.state, 'core/service.json'), temporary = `${path}.cleanup-${run.owner}`;
      metadata = { ...metadata, endpoint: run.route.originalEndpoint };
      await writeFile(temporary, JSON.stringify(metadata), { mode: 0o600 }); await rename(temporary, path);
    }
    const connection = new ServiceConnection();
    try {
      await connection.connect(metadata);
      const hello = await connection.request('hello', { protocol: metadata.protocol, identity: metadata.identity });
      assert.equal(hello.service.pid, metadata.pid);
      const result = await connection.request('stopService', { protocol: metadata.protocol,
        expectedDesktopGeneration: metadata.desktopGeneration, expectedTargets: hello.service.targets });
      assert.equal(result.desktopExit, 'requested', 'Owned Desktop did not confirm exit');
    } finally { connection.close(); }
    await until(() => !alive(metadata.pid), 'owned Desktop exits', 20000);
  }
  const instances = await records(run.state);
  const projects = JSON.parse(await readFile(join(run.state, 'core/projects.json'), 'utf8'));
  assert.ok(Array.isArray(projects), 'Invalid private project index');
  for (const record of instances) {
    const project = projects.find(project => project.root === record.workspace && /^[a-f0-9]{24}$/.test(project.id)
      && record.dataDir === join(run.state, 'core', project.id, 'state'));
    assert.ok(project && (project.root === join(run.state, 'workspace') || project.projectless === true && typeof project.projectlessRequestId === 'string'
      && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(project.projectlessRequestId)
      && project.root === join(run.state, 'user/Documents/AReaL', project.projectlessRequestId)), 'Unexpected workspace in private registry');
    assert.equal(record.owner?.profile, join(run.state, 'electron'), 'Unexpected service profile in private registry');
    assert.ok((run.appRunIds ?? [run.appRunId]).includes(record.owner?.appRunId), 'Unexpected service application owner');
  }
  await until(async () => (await records(run.state)).every(record => !alive(record.hostPid) && !alive(record.corePid)), 'owned Core/Host processes exit', 20000);
  return { desktopExited: !metadata || !alive(metadata.pid), hostAndCoreExited: true,
    statePreserved: true, state: run.state, registry: (await records(run.state)).map(({ serviceId, generation, state, hostPid, corePid }) => ({ serviceId, generation, state, hostPid, corePid })) };
}
const command = process.argv[2];
if (command === 'doctor') { console.log(JSON.stringify(await preflight(), null, 2)); }
else if (command === 'cleanup' && process.argv[3]) {
  const evidence = resolve(process.argv[3]), run = JSON.parse(await readFile(join(evidence, 'run.json'), 'utf8'));
  const result = await cleanup(run); await json(join(evidence, 'cleanup.json'), result); console.log(JSON.stringify(result));
} else if (command === 'run') {
  const build = await preflight(), evidenceRoot = join(root, '.scratch/recovery-electron');
  await mkdir(evidenceRoot, { recursive: true });
  const evidence = await mkdtemp(join(evidenceRoot, 'run-')), state = await mkdtemp('/private/tmp/arec-');
  const run = { evidence, state, owner: randomUUID() };
  await writeFile(join(state, '.owner'), run.owner); await json(join(evidence, 'run.json'), run);
  console.log(`Evidence: ${evidence}`);
  const requests = [], events = [], errors = [], stderr = [], checks = [];
  const manifest = { build, scope: 'source Electron Renderer/preload/Main → authentic Desktop → real Core; local deterministic SSE provider',
    faultBoundary: 'Main↔Desktop websocket: real command completion response and racing state publications withheld, owned connection cut, then normal hello reconnection',
    excluded: ['Core→Desktop response-loss and healthy Core observe retry (separate backend contract smoke)', 'real provider/credentials',
      'native directory dialog and physical input', 'Runtime tool execution', 'installed package', 'unrelated-error retention: no natural missing-thread UI route available'],
    checks, errors, run };
  let app, page, processHandle, application, model, proxy, original, failure, projectId, threadId;
  const env = environment(state), workspace = join(state, 'workspace');
  const snapshot = () => page.evaluate(() => window.arealDesktop.snapshot());
  const project = snap => snap.projects.find(value => value.id === projectId);
  const thread = snap => project(snap)?.state?.threads[threadId];
  const workRequests = () => requests.filter(value => !value.title).length;
  const capture = async name => {
    await page.screenshot({ path: join(evidence, `${name}.png`), animations: 'disabled', timeout: 10000 });
    await writeFile(join(evidence, `${name}.aria.txt`), await page.locator('.work-area').ariaSnapshot());
    await json(join(evidence, `${name}.snapshot.json`), await snapshot());
  };
  async function launch() {
    app = await electron.launch({ executablePath: require('electron'), args: [application.path], env, timeout: 120000 });
    processHandle = app.process(); processHandle.stderr.on('data', data => stderr.push(String(data)));
    page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
    await page.getByTestId('areal-workbench').waitFor({ timeout: 120000 });
    const configured = await page.evaluate(() => { const key = 'areal-gui:application-preferences'; const value = JSON.parse(localStorage.getItem(key) || '{}'); if (value.nextPromptSuggestions === false) return false; localStorage.setItem(key, JSON.stringify({ ...value, nextPromptSuggestions: false })); return true; });
    if (configured) { await page.reload(); await page.getByTestId('areal-workbench').waitFor({ timeout: 120000 }); }
    await until(async () => (await snapshot()).connection?.state === 'ready', 'source Desktop ready');
    const actual = await app.evaluate(({ app, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0], p = window.webContents.getLastWebPreferences(); window.setSize(1440, 960);
      return { pid: process.pid, userData: app.getPath('userData'), sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration };
    });
    assert.equal(actual.userData, env.AREAL_GUI_USER_DATA); assert.equal(actual.sandbox, true);
    assert.equal(actual.contextIsolation, true); assert.equal(actual.nodeIntegration, false);
    const metadata = JSON.parse(await readFile(join(state, 'core/service.json'), 'utf8'));
    run.appRunId = metadata.applicationOwner.appRunId;
    run.appRunIds = [...new Set([...(run.appRunIds ?? []), run.appRunId])];
    await json(join(evidence, 'run.json'), run);
    await json(join(evidence, `doctor-${processHandle.pid}.json`), { ...actual, desktopPid: metadata.pid,
      desktopGeneration: metadata.desktopGeneration, appRunId: run.appRunId, binarySHA256: sha(await readFile(binary)) });
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      dialog.showMessageBox = async (...args) => ({ response: ['确认取消后台任务？', '退出 AReaL Harness？'].includes(args.at(-1).message) ? 1 : args.at(-1).cancelId ?? 0 });
    }, workspace);
  }
  async function stopGUI() {
    if (!app) return;
    await app.evaluate(({ app }) => app.quit());
    await until(() => processHandle.exitCode !== null || processHandle.signalCode !== null, 'owned Main exits', 30000); app = null;
  }
  try {
    await mkdir(workspace); await mkdir(join(state, 'user'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: workspace, stdio: 'ignore' });
    model = createServer(async (request, response) => {
      try {
        let raw = ''; for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw), firstContent = body.messages?.[0]?.content;
        const title = typeof firstContent === 'string' && firstContent.startsWith('Generate a concise semantic session title');
        requests.push({ at: Date.now(), title, body });
        const text = title ? 'Recovery fixture' : `RECOVERY_HISTORY_SENTINEL_${workRequests()}`;
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      } catch (error) { errors.push(error.stack); response.destroy(); }
    });
    await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
    await writeFile(join(state, 'config.toml'), `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`);
    await json(join(state, 'desktop.json'), { profiles: [{ id: 'fixture', revision: 'v1', displayName: 'Fixture', instructions: 'Respond to the task.' }] });
    application = await applicationFixture(gui, join(state, 'app'));
    await launch(); await capture('01-empty');
    await page.getByRole('button', { name: '不在项目中工作', exact: true }).click();
    await page.getByRole('menuitem', { name: '新建项目', exact: true }).click();
    projectId = (await until(async () => (await snapshot()).projects.find(value => value.root === workspace && value.state?.connected), 'UI-added project connected')).id;
    await page.getByTestId('chat-input').fill('Keep the original recovery history'); await page.getByTestId('chat-send-button').click();
    threadId = await until(() => page.getByTestId('areal-workbench').getAttribute('data-thread-id'), 'original Thread ID');
    await until(async () => thread(await snapshot())?.turns.at(-1)?.status === 'completed', 'original turn completed');
    await page.getByTestId('chat-view').getByText('RECOVERY_HISTORY_SENTINEL_1', { exact: true }).waitFor();
    await capture('02-history');
    original = JSON.parse(await readFile(join(state, 'core/service.json'), 'utf8'));
    proxy = await transportProxy(original, events);
    run.route = { pid: original.pid, identity: original.identity, desktopGeneration: original.desktopGeneration,
      originalEndpoint: original.endpoint, proxyEndpoint: proxy.endpoint };
    await json(join(evidence, 'run.json'), run);
    const metadataPath = join(state, 'core/service.json'), temporary = `${metadataPath}.recovery-${run.owner}`;
    await writeFile(temporary, JSON.stringify({ ...original, endpoint: proxy.endpoint }), { mode: 0o600 }); await rename(temporary, metadataPath);
    const endpoint = new URL(original.endpoint);
    const detached = await app.evaluate((_electron, remote) => {
      const sockets = process._getActiveHandles().filter(handle => handle.constructor?.name === 'Socket'
        && handle.remoteAddress === remote.host && handle.remotePort === remote.port && !handle.destroyed);
      if (sockets.length !== 1) throw new Error(`Expected one owned Desktop socket; found ${sockets.length}`);
      const details = { pid: process.pid, count: sockets.length, remoteAddress: remote.host, remotePort: remote.port, localPort: sockets[0].localPort };
      sockets[0].destroy(); return details;
    }, { host: endpoint.hostname, port: Number(endpoint.port) });
    await json(join(evidence, 'owned-socket-cut.json'), detached);
    await until(async () => proxy.connections > 0 && (await snapshot()).connection?.state === 'ready', 'automatic Main reconnect through proxy');
    const before = structuredClone(thread(await snapshot())), beforeModel = workRequests();
    const send = proxy.arm('send');
    await page.getByTestId('chat-input').fill('Accept exactly this original send once'); await page.getByTestId('chat-send-button').click();
    await until(() => send.completed, 'real accepted Desktop send response intercepted');
    assert.equal(send.hadError, false, JSON.stringify(send.response)); assert.ok(send.requestId); assert.equal(send.threadId, threadId);
    const unknown = page.getByTestId('toast').filter({ has: page.locator('[data-recovery-request-id]') });
    await unknown.waitFor();
    await capture('03-send-response-lost');
    const matchingSelector = process.env.AREAL_RECOVERY_NOTICE_SELECTOR ?? '[data-testid="toast"] [data-recovery-request-id="{requestId}"]';
    const matching = page.locator(matchingSelector.replaceAll('{requestId}', send.requestId));
    assert.equal(await matching.count(), 1, 'A single unified toast exposes the original request identity');
    await matching.waitFor();
    proxy.release();
    await until(async () => (await snapshot()).connection?.state === 'ready' && project(await snapshot())?.outcomes?.[send.requestId]?.accepted === true, 'original accepted outcome converges automatically');
    await until(async () => thread(await snapshot())?.turns.at(-1)?.status === 'completed', 'accepted turn completed');
    await unknown.waitFor({ state: 'hidden' }); await matching.waitFor({ state: 'hidden' });
    await page.getByTestId('chat-view').getByText('RECOVERY_HISTORY_SENTINEL_2', { exact: true }).waitFor();
    const accepted = thread(await snapshot());
    assert.equal(accepted.turns.length, before.turns.length + 1); assert.equal(workRequests() - beforeModel, 1);
    assert.deepEqual(accepted.turns.slice(0, before.turns.length).map(value => value.id), before.turns.map(value => value.id));
    assert.equal(events.filter(value => value.type === 'command' && value.name === 'send' && value.requestId === send.requestId).length, 1, 'Main never replays accepted send');
    checks.push('real UI accepted send response lost across Main↔Desktop; original request converges and matching notices disappear; one additional Core Turn and non-title model request');
    await json(join(evidence, 'send-fault.json'), send); await capture('04-send-converged');
    const history = displayTurns(accepted.turns), readModel = workRequests();
    await createProjectConversation(page, 'workspace');
    const read = proxy.arm('open'); await page.getByTestId(`task-item-${threadId}`).click();
    await until(() => read.completed, 'real Desktop history-open response intercepted');
    assert.equal(read.hadError, false, JSON.stringify(read.response)); assert.equal(read.threadId, threadId);
    await until(async () => (await snapshot()).connection?.state !== 'ready', 'read interruption is observed');
    await capture('05-read-response-lost'); proxy.release();
    await until(async () => (await snapshot()).connection?.state === 'ready' && project(await snapshot())?.state?.connected, 'history connection restores');
    await until(async () => await page.getByTestId('areal-workbench').getAttribute('data-thread-id') === threadId, 'original conversation remains selected');
    await page.getByTestId('chat-view').getByText('RECOVERY_HISTORY_SENTINEL_1', { exact: true }).waitFor();
    await page.getByTestId('chat-view').getByText('RECOVERY_HISTORY_SENTINEL_2', { exact: true }).waitFor();
    assert.deepEqual(displayTurns(thread(await snapshot()).turns), history); assert.equal(workRequests(), readModel);
    assert.equal(await unknown.count(), 0, 'A read interruption must not invent a pending send');
    checks.push('real UI history-open read response interrupted; reconnect retains visible original history and starts no model work');
    await json(join(evidence, 'read-fault.json'), read); await capture('06-history-restored');
    await restoreDescriptor(run, original); await stopGUI(); await cleanup(run);
    await proxy.close(); proxy = null; original = null;
    await launch(); await until(async () => project(await snapshot())?.state?.connected, 'same private project restored after fresh Main launch');
    await createProjectConversation(page, 'workspace');
    await page.getByTestId(`task-item-${threadId}`).click();
    await page.getByTestId('chat-view').getByText('RECOVERY_HISTORY_SENTINEL_2', { exact: true }).waitFor();
    assert.deepEqual(displayTurns(thread(await snapshot()).turns), history); assert.equal(workRequests(), readModel);
    checks.push('fresh source Electron process opens original history from a new draft by sidebar click without replay');
    await capture('07-fresh-process-history'); await stopGUI();
    manifest.threadId = threadId; manifest.projectId = projectId; manifest.modelWorkRequests = workRequests();
  } catch (error) {
    failure = error.stack ?? String(error);
    if (page && app) await capture('failure').catch(cause => errors.push(`failure capture: ${cause.message}`));
  } finally {
    proxy?.release();
    if (original) await restoreDescriptor(run, original).catch(error => errors.push(`descriptor restore: ${error.message}`));
    if (app) {
      await stopGUI().catch(async error => { errors.push(`normal GUI exit: ${error.message}`); await app?.evaluate(({ app }) => app.exit(1)).catch(() => {}); });
    }
    if (application) await application.close().catch(error => errors.push(`owner fixture: ${error.message}`));
    if (proxy) await proxy.close().catch(error => errors.push(`proxy cleanup: ${error.message}`));
    if (model) { model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); }
    try { await json(join(evidence, 'cleanup.json'), await cleanup(run)); }
    catch (error) { errors.push(`cleanup: ${error.stack}`); }
    if (sha(await readFile(binary)) !== build.binarySHA256) errors.push('Core binary changed during acceptance');
    if (sha(execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: root, maxBuffer: 32 * 1024 * 1024 })) !== build.diffSHA256
      || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() !== build.commit)
      errors.push('Source checkout changed during acceptance');
    for (const [path, hash] of Object.entries(build.rendererSHA256))
      if (sha(await readFile(path)) !== hash) errors.push(`Renderer build changed during acceptance: ${path}`);
    await json(join(evidence, 'model-requests.json'), requests); await json(join(evidence, 'transport-events.json'), events);
    await writeFile(join(evidence, 'electron.stderr.log'), stderr.join(''));
    Object.assign(manifest, { passed: !failure && errors.length === 0, failure }); await json(join(evidence, 'manifest.json'), manifest);
    console.log(JSON.stringify({ passed: manifest.passed, evidence, checks, failure, errors }));
    if (!manifest.passed) process.exitCode = 1;
  }
} else {
  console.log('Usage: AREAL_CORE_BIN=/absolute/.local/dev-bin/areal node recovery-electron-smoke.mjs doctor|run|cleanup <evidence>');
  if (command && command !== '--help') process.exitCode = 2;
}
