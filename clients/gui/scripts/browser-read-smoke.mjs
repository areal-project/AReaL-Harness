import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { selectConversation, captureSmokeFailure } from './smoke-navigation.mjs';
import { createBrowserEvidence } from './browser-evidence.mjs';
import { checkBrowserStartup } from './browser-startup.mjs';

// Real Electron, independent desktop service, Core and Runtime. Only model/site are local fixtures.
const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(gui, '../..');
const require = createRequire(join(gui, 'app/package.json'));
const { _electron: electron } = require('playwright-core');
const scratch = await mkdtemp('/private/tmp/areal-browser-read-');
const workspace = join(scratch, 'workspace'), userHome = join(scratch, 'user');
await mkdir(workspace); await mkdir(join(userHome, '.areal'), { recursive: true });
execFileSync('git', ['init', '-b', 'main'], { cwd: workspace, stdio: 'ignore' });
const sentinel = 'SAME_NATIVE_PAGE_SENTINEL_02';
const siteFacts = { gets: 0, getRequests: [], posts: [] };
const site = createServer(async (request, response) => {
  if (request.method === 'POST') {
    let body = ''; for await (const chunk of request) body += chunk;
    siteFacts.posts.push({ url: request.url, body }); response.end('ok'); return;
  }
  siteFacts.gets++;
  siteFacts.getRequests.push({ url: request.url, destination: request.headers['sec-fetch-dest'] ?? null, at: Date.now() });
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><title>Shared Browser Read Fixture</title>
    <main><h1>Same page read</h1><p id="sentinel" style="position:fixed;top:80px;left:30px;background:#fff">${sentinel}</p>
    <label>Unsaved form <input id="draft" aria-label="Unsaved form"></label>
    <div style="height:1800px">Scroll preserves native state</div></main>
    <script>window.nativeSentinel=crypto.randomUUID();window.liveCounter=41;
    document.querySelector('#sentinel').dataset.heap=window.nativeSentinel;</script>`);
});
await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
const siteUrl = `http://127.0.0.1:${site.address().port}/?token=SYNTHETIC_SECRET_QUERY`;
let pageId, secondPageId, scenario = 'normal', modelCalls = [];
const model = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  modelCalls.push({ scenario, toolNames: (body.tools ?? []).map(tool => tool.function?.name), messages: body.messages?.length });
  await until(() => pageId, 'claimed page identity available to deterministic model');
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  const last = body.messages.at(-1);
  const tool = (id, args) => {
    send({ tool_calls: [{ index: 0, id, type: 'function', function: { name: 'browser_v1', arguments: JSON.stringify(args) } }] });
    send({}, 'tool_calls');
  };
  if (scenario === 'normal') {
    if (last?.role !== 'tool') tool('describe-02', { operation: 'describe', parameters: {} });
    else if (!body.messages.some(message => message.role === 'tool' && JSON.stringify(message).includes(sentinel)))
      tool('observe-02', { operation: 'observe', parameters: { pageId } });
    else { send({ content: `Observed ${sentinel}` }); send({}, 'stop'); }
  } else if (scenario === 'cross') {
    if (last?.role !== 'tool') tool('cross-02', { operation: 'observe', parameters: { pageId } });
    else { send({ content: 'Cross-thread read rejected' }); send({}, 'stop'); }
  } else if (scenario === 'missing') {
    if (last?.role !== 'tool') tool('missing-02', { operation: 'observe', parameters: { pageId: secondPageId } });
    else { send({ content: 'Host unavailable' }); send({}, 'stop'); }
  } else if (scenario === 'human') {
    if (last?.role !== 'tool') tool('human-02', { operation: 'observe', parameters: { pageId: secondPageId } });
    else { send({ content: 'Human controls page' }); send({}, 'stop'); }
  } else if (scenario === 'forge') {
    if (last?.role !== 'tool') tool('forge-02', { operation: 'observe', parameters: { pageId: secondPageId } });
    else { send({ content: 'Legitimate host result' }); send({}, 'stop'); }
  }
  response.end('data: [DONE]\n\n');
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
await writeFile(join(userHome, '.areal', 'config.toml'), `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`);
const deployment = join(scratch, 'desktop.json');
await writeFile(deployment, JSON.stringify({ profiles: [{ id: 'fixture', revision: 'v1', displayName: 'Fixture', instructions: 'Use requested tools, then report their result.' }] }));
const traceFile = join(scratch, 'browser-trace.jsonl');
await writeFile(traceFile, '');
const env = { ...process.env, AREAL_GUI_USER_DATA: join(scratch, 'electron'), AREAL_CORE_HOME: join(scratch, 'core'),
  AREAL_CORE_USER_HOME: userHome, AREAL_HARNESS_SERVICE_HOME: join(scratch, 'registry'),
  AREAL_BROWSER_READ_TEST_TRACE: traceFile,
  AREAL_CORE_DESKTOP_CONFIG: deployment, AREAL_CORE_BIN: process.env.AREAL_CORE_BIN || resolve(root, 'target/debug/areal') };
for (const key of ['AREAL_CORE_WORKSPACE', 'AREAL_CORE_CONFIG', 'AREAL_HARNESS_HOME', 'AREAL_HARNESS_CONFIG']) delete env[key];
let app, page, executionStatus = 'failed';
const checks = [], errors = [], events = {};
const evidence = createBrowserEvidence({ runKind: 'acceptance', cases: [
  { id: 'B-04.same-page', requirement: 'B-04' },
  { id: 'B-05.cross-thread', requirement: 'B-05' },
  { id: 'B-05.forged-receipt', requirement: 'B-05' },
  { id: 'B-05.human-control', requirement: 'B-05' },
  { id: 'B-06.host-exit', requirement: 'B-06' },
] });
function record(id, assertion, observations) {
  evidence.recordPass(id, { assertions: [assertion], observations });
  checks.push(assertion);
}
async function until(predicate, label, timeout = 40000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout: ${label}`);
}
async function state() { return page.evaluate(() => window.arealDesktop.snapshot()); }
async function command(name, params) {
  const result = await page.evaluate(({ name, params }) => window.arealDesktop.command(name, params), { name, params });
  assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
}
async function nativeState() {
  return app.evaluate(async ({ webContents }, url) => {
    const c = webContents.getAllWebContents().find(item => item.getURL() === url);
    if (!c) return null;
    return { id: c.id, url: c.getURL(), state: await c.executeJavaScript(`({sentinel:window.nativeSentinel,counter:window.liveCounter,draft:document.querySelector('#draft').value,scrollY})`) };
  }, siteUrl);
}
async function coreThread(id) {
  const snapshot = await state();
  return Object.values(snapshot.projects[0]?.state?.threads ?? {}).find(thread => thread.id === id);
}
try {
  app = await electron.launch({ executablePath: require('electron'), args: [join(gui, 'app')], env, timeout: 120000 });
  events.startup = await checkBrowserStartup(app, { binary: env.AREAL_CORE_BIN, userHome, scratch });
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByTestId('areal-workbench').waitFor({ timeout: 120000 });
  await until(async () => (await state()).connection?.state === 'ready', 'desktop ready');
  await app.evaluate(({ app, dialog, BrowserWindow }, { path, origin }) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    globalThis.__readLoadTrace = [];
    app.on('web-contents-created', (_event, contents) => {
      const load = contents.loadURL.bind(contents);
      contents.loadURL = (url, ...args) => {
        const entry = { id: contents.id, url, currentUrl: contents.getURL(), loading: contents.isLoadingMainFrame(), caller: new Error().stack.split('\n').slice(2, 5), at: Date.now() };
        globalThis.__readLoadTrace.push(entry);
        return load(url, ...args).then(value => { entry.settled = 'loaded'; return value; }, error => {
          entry.settled = 'rejected'; entry.error = { errno: error.errno, code: error.code, url: error.url }; throw error;
        });
      };
    });
    const original = dialog.showMessageBox;
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      if (options?.title === '允许本地开发站点' && options.message === `允许此浏览工作区访问 ${origin}？`) {
        globalThis.__m1OriginPrompt = { origin, title: options.title, count: (globalThis.__m1OriginPrompt?.count ?? 0) + 1 };
        return { response: 1, checkboxChecked: false };
      }
      return original(...args);
    };
    BrowserWindow.getAllWindows()[0].setSize(1440, 960);
  }, { path: workspace, origin: new URL(siteUrl).origin });
  await page.evaluate(() => window.arealDesktop.chooseProject());
  await page.getByTestId('chat-input').waitFor();
  const project = await until(async () => (await state()).projects.find(item => item.root === workspace), 'project ready');
  const projectId = project.id;
  const first = await command('create', { projectId, browserEnabled: true, profile: { id: 'fixture', revision: 'v1' } });
  const threadId = first.threadId;
  await selectConversation(page, threadId);
  await page.keyboard.press('Meta+t');
  await page.locator('.preview-panel').waitFor();
  await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0].focus(); });
  await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()), 'focused Main Origin prompt');
  await page.evaluate(({ projectId, threadId, siteUrl }) => window.arealDesktop.preview({ operation: 'navigate', projectId, threadId, url: siteUrl }), { projectId, threadId, siteUrl });
  events.developmentOriginPrompt = await app.evaluate(() => globalThis.__m1OriginPrompt);
  assert.equal(events.developmentOriginPrompt?.count, 1, 'exact-Origin Main prompt occurred once');
  events.developmentOriginPrompt.response = 'fixture-stub-allow-exact-origin';
  await until(nativeState, 'native page loaded');
  await app.evaluate(({ webContents }, url) => {
    const c = webContents.getAllWebContents().find(item => item.getURL() === url);
    return c.executeJavaScript(`document.querySelector('#draft').value='UNSAVED_FORM_02';window.scrollTo(0,660);`);
  }, siteUrl);
  const before = await nativeState();
  assert.ok(before?.id && before.state.sentinel && before.state.scrollY > 0);
  events.normalBeforeClaim = { before, siteFacts: structuredClone(siteFacts) };
  await page.getByRole('button', { name: '让 Agent 检查当前页' }).click();
  const claimed = await until(async () => {
    const value = await page.evaluate(({ projectId, threadId }) => window.arealDesktop.preview({ operation: 'state', projectId, threadId }), { projectId, threadId });
    return value.browser?.control === 'agent' ? value : null;
  }, 'claim accepted');
  pageId = claimed.browser.pageId;
  const completed = await until(async () => {
    const thread = await coreThread(threadId);
    return thread?.turns?.at(-1)?.status === 'completed' ? thread : null;
  }, 'Core tool turn completed', 60000);
  const history = JSON.stringify(completed);
  assert.match(history, /browser_v1/);
  assert.match(history, new RegExp(sentinel));
  assert.match(history, /describe-02|observe-02/);
  assert.ok(!history.includes('SYNTHETIC_SECRET_QUERY'), 'Core history must not contain URL query values');
  const after = await nativeState();
  events.normalAfterObservation = { after, siteFacts: structuredClone(siteFacts) };
  events.nativeLoadTrace = await app.evaluate(() => globalThis.__readLoadTrace);
  assert.equal(after.id, before.id);
  assert.deepEqual(after.state, before.state);
  assert.equal(siteFacts.gets, 1, 'claim and read must not navigate a second page');
  events.normal = { threadId, pageId, nativeWebContentsId: after.id, nativeSentinel: after.state.sentinel,
    before, after, siteFacts: structuredClone(siteFacts), history: completed };
  await page.screenshot({ path: join(scratch, 'gui-read.png'), animations: 'disabled' });
  const nativePng = await app.evaluate(async ({ webContents }, id) => (await webContents.fromId(id).capturePage()).toPNG().toString('base64'), after.id);
  await writeFile(join(scratch, 'native-read.png'), Buffer.from(nativePng, 'base64'));
  if (process.platform === 'darwin') {
    await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0].focus(); });
    await new Promise(resolve => setTimeout(resolve, 500));
    const ownerPid = app.process().pid;
    const swift = `import CoreGraphics\nlet pid = Int32(${ownerPid})\nlet windows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] ?? []\nfor window in windows { if (window[kCGWindowOwnerPID as String] as? Int32) == pid, (window[kCGWindowLayer as String] as? Int32) == 0, let id = window[kCGWindowNumber as String] as? Int { print(id); break } }`;
    const windowId = execFileSync('/usr/bin/swift', ['-e', swift], { encoding: 'utf8' }).trim();
    assert.match(windowId, /^\d+$/, 'Electron window must have a CGWindow ID for native capture');
    execFileSync('/usr/sbin/screencapture', ['-x', '-l', windowId, join(scratch, 'desktop-window.png')]);
    events.normal.desktopWindowId = Number(windowId);
  }
  record('B-04.same-page', 'B-04: one native WebContents and JS/form/scroll sentinel survive Core tool observation; GUI and Core history correlate', events.normal);

  // A different Browser-enabled Thread cannot read the first page by guessing its pageId.
  scenario = 'cross';
  const second = await command('create', { projectId, browserEnabled: true, profile: { id: 'fixture', revision: 'v1' } });
  await selectConversation(page, second.threadId);
  await page.keyboard.press('Meta+t');
  await page.locator('.preview-panel').waitFor();
  await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0].focus(); });
  await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()), 'second Thread Origin prompt focus');
  await page.evaluate(({ projectId, threadId, siteUrl }) => window.arealDesktop.preview({ operation: 'navigate', projectId, threadId, url: siteUrl }), { projectId, threadId: second.threadId, siteUrl });
  await until(async () => app.evaluate(({ webContents }, expected) => webContents.getAllWebContents().some(c => c.id !== expected.firstId && c.getURL() === expected.url), { firstId: after.id, url: siteUrl }), 'second native page');
  const secondClaim = await page.evaluate(({ projectId, threadId }) => window.arealDesktop.preview({ operation: 'claim', projectId, threadId }), { projectId, threadId: second.threadId });
  secondPageId = secondClaim.browser.pageId;
  await command('send', { projectId, threadId: second.threadId, text: 'Inspect the other thread page' });
  const cross = await until(async () => {
    const thread = await coreThread(second.threadId);
    return thread?.turns?.at(-1)?.status === 'completed' ? thread : null;
  }, 'cross-thread rejection');
  assert.match(JSON.stringify(cross), /wrong_page/);
  events.cross = { threadId: second.threadId, history: cross };
  record('B-05.cross-thread', 'B-05: guessed pageId from a second claimed Thread is rejected in Core history', events.cross);

  const { ServiceConnection } = require('../app/src/core/service-client.cjs');
  const metadata = JSON.parse(await readFile(join(scratch, 'core', 'service.json'), 'utf8'));
  const rogue = new ServiceConnection();
  await rogue.connect(metadata);
  try {
    await rogue.request('hello', { protocol: metadata.protocol, identity: metadata.identity });
    await assert.rejects(() => rogue.request('browserClaim', { projectId, threadId: second.threadId,
      protocol: 'areal.browser.host.v1', operations: ['describe', 'observe', 'capture', 'act', 'wait', 'navigate', 'newPage', 'diagnostics', 'runBatch'], available: true,
      coreInstanceId: secondClaim.workspace.pages.find(item => item.pageId === secondPageId).coreInstanceId,
      pageId: secondPageId, browserHostId: 'forged-host', hostGeneration: 999,
      pageGeneration: 1, controlEpoch: 1 }, true), /已由其他桌面窗口认领/);
    scenario = 'forge';
    const blockMain = app.evaluate(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000));
    await rogue.request('command', { name: 'send', request: { projectId, threadId: second.threadId,
      text: 'Read from the authorized host while another socket forges a result' } }, true);
    await until(() => modelCalls.some(call => call.scenario === 'forge'), 'forged socket fixture model request');
    const trace = async () => (await readFile(traceFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const dispatched = await until(async () => (await trace())
      .find(entry => entry.callId === 'forge-02' && entry.phase === 'pending'), 'actual forged-call pending request');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal((await trace()).some(entry => entry.callId === 'forge-02' && entry.phase === 'finished'), false,
      'the authorized browser request must still be pending when the other socket injects a result');
    await assert.rejects(() => rogue.request('browserResult', { requestId: dispatched.requestId, result: {
      callId: 'forge-02', pageId: secondPageId, text: 'FORGED_SOCKET_RESULT' } }, true), /无效浏览器回执/);
    await blockMain;
    const forged = await until(async () => {
      const thread = await coreThread(second.threadId);
      return thread?.turns?.length > cross.turns.length && thread.turns.at(-1)?.status === 'completed' ? thread : null;
    }, 'legitimate host response after forged socket');
    const forgedTurn = JSON.stringify(forged.turns.at(-1));
    assert.match(forgedTurn, /forge-02/);
    assert.match(forgedTurn, new RegExp(sentinel));
    assert.ok(!forgedTurn.includes('FORGED_SOCKET_RESULT'));
    events.forge = { threadId: second.threadId, attemptedRequestId: dispatched.requestId,
      dispatch: dispatched, history: forged.turns.at(-1) };
    record('B-05.forged-receipt', 'B-05: second authenticated socket cannot replace an in-flight result or claim with fake host generation', events.forge);
  } finally { rogue.close(); }

  // Local takeover immediately blocks further observation, even if service routing lags.
  await page.evaluate(({ projectId, threadId }) => window.arealDesktop.preview({ operation: 'takeover', projectId, threadId }), { projectId, threadId: second.threadId });
  const control = await page.evaluate(({ projectId, threadId }) => window.arealDesktop.preview({ operation: 'state', projectId, threadId }), { projectId, threadId: second.threadId });
  assert.equal(control.browser.control, 'human');
  scenario = 'human';
  await command('send', { projectId, threadId: second.threadId, text: 'Inspect after human takeover' });
  const human = await until(async () => {
    const thread = await coreThread(second.threadId);
    return thread?.turns?.length > cross.turns.length && thread.turns.at(-1)?.status === 'completed' ? thread : null;
  }, 'human-control rejection');
  assert.match(JSON.stringify(human.turns.at(-1)), /host_unavailable|human_control/);
  assert.ok(!JSON.stringify(human.turns.at(-1)).includes(sentinel));
  events.human = { threadId: second.threadId, history: human.turns.at(-1) };
  record('B-05.human-control', 'human takeover locally revokes Agent observation, confirmed through a subsequent Core callback', events.human);

  // The adapter stays alive after the GUI exits, but must not manufacture another browser.
  await page.evaluate(({ projectId, threadId }) => window.arealDesktop.preview({ operation: 'claim', projectId, threadId }), { projectId, threadId: second.threadId });
  await app.close(); app = null; page = null;
  const connection = new ServiceConnection();
  await connection.connect(metadata);
  try {
    await connection.request('hello', { protocol: metadata.protocol, identity: metadata.identity });
    scenario = 'missing';
    const previousTurns = human.turns.length;
    await connection.request('command', { name: 'send', request: { projectId, threadId: second.threadId, text: 'Inspect with GUI closed' } }, true);
    const missing = await until(async () => {
      const packet = await connection.request('snapshot', {});
      const thread = packet.snapshot.projects.find(item => item.id === projectId)?.state?.threads?.[second.threadId];
      return thread?.turns?.length > previousTurns && thread.turns.at(-1)?.status === 'completed' ? thread : null;
    }, 'missing Main rejection');
    assert.match(JSON.stringify(missing.turns.at(-1)), /host_unavailable/);
    assert.equal(siteFacts.gets, 2, 'missing host must not open another page');
    events.missing = { threadId: second.threadId, history: missing.turns.at(-1) };
    record('B-06.host-exit', 'B-06: independent adapter reports host_unavailable after GUI exit without opening a replacement browser', events.missing);
  } finally { connection.close(); }
  assert.deepEqual(errors, []);
  executionStatus = 'completed';
} catch (error) {
  if (error.code === 'BROWSER_STARTUP_BLOCKED') executionStatus = 'blocked';
  errors.push(error.stack ?? String(error));
  if (page) await captureSmokeFailure(page, scratch, error);
  throw error;
} finally {
  if (app) await app.close();
  site.closeAllConnections(); model.closeAllConnections();
  await Promise.all([new Promise(resolve => site.close(resolve)), new Promise(resolve => model.close(resolve))]);
  const files = ['app/src/core/browser-tool.cjs', 'app/src/core/backend.cjs', 'app/src/core/service-client.cjs',
    'app/src/core/service-protocol.cjs', 'app/src/core/preview.cjs', 'app/src/core/main.cjs',
    'packages/runtime-client/core.js', 'renderer/src/Preview.tsx', 'scripts/browser-read-smoke.mjs',
    'scripts/browser-evidence.mjs', 'scripts/browser-startup.mjs'];
  const hashes = Object.fromEntries(await Promise.all(files.map(async file => [file,
    createHash('sha256').update(await readFile(join(gui, file))).digest('hex')])));
  const result = evidence.finish({ executionStatus, provenance: {
    sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    diffSHA256: createHash('sha256').update(execFileSync('git', ['diff', 'HEAD'], { cwd: root })).digest('hex'),
    scriptSHA256: hashes['scripts/browser-read-smoke.mjs'],
    coreBinarySHA256: createHash('sha256').update(await readFile(env.AREAL_CORE_BIN)).digest('hex'),
  } });
  await writeFile(join(scratch, 'manifest.json'), JSON.stringify({ ...result, checks, errors, events, modelCalls,
    source: result.provenance.sourceHead, diffSHA256: result.provenance.diffSHA256,
    hashes, coreBinary: env.AREAL_CORE_BIN, siteUrl: siteUrl.replace(/\?.*/, ''),
    scope: 'source Electron + independent desktop service + Core/Runtime + deterministic local model + synthetic site' }, null, 2));
  console.log(JSON.stringify({ executionStatus, acceptanceStatus: result.acceptanceStatus, evidence: scratch, checks, errors }));
}
