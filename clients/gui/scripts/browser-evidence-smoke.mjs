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

// Public Core tool calls, independent desktop adapter, real Electron and a synthetic site.
const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(gui, '../..');
const startedAt = new Date().toISOString();
const require = createRequire(join(gui, 'app/package.json'));
const { _electron: electron } = require('playwright-core');
const scratch = await mkdtemp('/private/tmp/areal-browser-evidence-');
const workspace = join(scratch, 'workspace'), userHome = join(scratch, 'user');
await mkdir(workspace); await mkdir(join(userHome, '.areal'), { recursive: true });
execFileSync('git', ['init', '-b', 'main'], { cwd: workspace, stdio: 'ignore' });
const sentinel = 'EVIDENCE_PAGE_03';
const siteFacts = { gets: 0, posts: 0, childGets: 0, childRequests: [] };
const sibling = createServer((request, response) => {
  siteFacts.childGets++;
  siteFacts.childRequests.push({ url: request.url, destination: request.headers['sec-fetch-dest'] ?? null });
  response.setHeader('Content-Type', 'text/html'); response.end('<button>Cross origin child</button>');
});
await new Promise(resolve => sibling.listen(0, '127.0.0.1', resolve));
const childUrl = `http://127.0.0.1:${sibling.address().port}/`;
const site = createServer((request, response) => {
  if (request.method === 'POST') { siteFacts.posts++; response.end('ok'); return; }
  siteFacts.gets++;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (request.url.startsWith('/frame')) { response.end('<button>Same origin child</button><input name="token" value="738291">'); return; }
  response.end(`<!doctype html><title>Evidence fixture</title><h1>${sentinel}</h1>
    <button id="replace">Duplicate target</button><button>Duplicate target</button><button disabled>Disabled action</button>
    <div role="tablist" aria-label="Sections"><button role="tab">Overview</button></div>
    <label>Search query <input id="query" value="ordinary query"></label>
    <label>Password <input id="password" type="password" value="482913"></label>
    <input id="session" name="token" aria-label="Session credential" value="573824">
    <input id="otpinput" autocomplete="one-time-code" value="654321">
    <div id="otp">One-time code: 246813</div>
    <iframe id="same" src="/frame"></iframe><iframe id="cross" src="${childUrl}"></iframe>
    <div id="shadow"></div><script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button>Shadow target</button><input name="secret" value="864209">';</script>
    <div style="height:2000px"></div>`);
});
await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
const siteUrl = `http://127.0.0.1:${site.address().port}/?token=SYNTHETIC_SECRET_03`;
let pageId, rootRef, scenario = 'observe';
let nextToolCall = 0;
let issuedToolForScenario = false;
const modelCalls = [];
const model = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  const last = body.messages.at(-1);
  const imageData = JSON.stringify(last?.content ?? '').match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/)?.[1];
  const hadImage = !!imageData;
  modelCalls.push({ scenario, toolCallId: last?.tool_call_id,
    lastRole: last?.role, hadImage, ...(hadImage ? { imageSHA256: createHash('sha256').update(Buffer.from(imageData, 'base64')).digest('hex') } : {}),
    assistantToolCallIds: body.messages.flatMap(message => (message.tool_calls ?? []).map(call => call.id)),
    tools: (body.tools ?? []).map(t => t.function?.name) });
  await until(() => pageId, 'page identity');
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (last?.role !== 'tool' && !hadImage && !issuedToolForScenario) {
    issuedToolForScenario = true;
    const parameters = { pageId };
    if (scenario === 'stale') parameters.rootRef = rootRef;
    if (scenario === 'budget') parameters.budget = { nodes: 1, textBytes: 256 };
    if (scenario === 'quota') parameters.budget = { nodes: 60, textBytes: 4 * 1024 };
    if (scenario === 'capture' || scenario === 'captureInserted') parameters.scope = 'viewport';
    send({ tool_calls: [{ index: 0, id: `${scenario}-${++nextToolCall}-03`, type: 'function', function: {
      name: 'browser_v1', arguments: JSON.stringify({ operation: ['capture', 'captureInserted'].includes(scenario) ? 'capture' : 'observe', parameters }),
    } }] });
    send({}, 'tool_calls');
  } else { send({ content: `Fixture checked ${scenario}` }); send({}, 'stop'); }
  response.end('data: [DONE]\n\n');
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
await writeFile(join(userHome, '.areal', 'config.toml'), `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`);
const deployment = join(scratch, 'desktop.json');
await writeFile(deployment, JSON.stringify({ profiles: [{ id: 'fixture', revision: 'v1', displayName: 'Fixture', instructions: 'Use requested tools.' }] }));
const env = { ...process.env, AREAL_GUI_USER_DATA: join(scratch, 'electron'), AREAL_CORE_HOME: join(scratch, 'core'),
  AREAL_CORE_USER_HOME: userHome, AREAL_HARNESS_SERVICE_HOME: join(scratch, 'registry'),
  AREAL_CORE_DESKTOP_CONFIG: deployment, AREAL_CORE_BIN: process.env.AREAL_CORE_BIN || resolve(root, 'target/debug/areal') };
for (const key of ['AREAL_CORE_WORKSPACE', 'AREAL_CORE_CONFIG', 'AREAL_HARNESS_HOME', 'AREAL_HARNESS_CONFIG']) delete env[key];
let app, page, executionStatus = 'failed';
const checks = [], errors = [], events = {};
const evidence = createBrowserEvidence({ runKind: 'acceptance', cases: [
  { id: 'B-07.ref-lifecycle', requirement: 'B-07' },
  { id: 'B-08.coverage-budget', requirement: 'B-08' },
  { id: 'B-09.media-privacy', requirement: 'B-09' },
] });
function record(id, assertion, observations) {
  evidence.recordPass(id, { assertions: [assertion], observations });
  checks.push(assertion);
}
async function until(predicate, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error(`Timeout: ${label}`);
}
async function state() { return page.evaluate(() => window.arealDesktop.snapshot()); }
async function command(name, params) {
  const result = await page.evaluate(({ name, params }) => window.arealDesktop.command(name, params), { name, params });
  assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
}
async function thread(id) { return Object.values((await state()).projects[0]?.state?.threads ?? {}).find(item => item.id === id); }
async function nextTurn(id, previous = 0) {
  return until(async () => { const value = await thread(id); return value?.turns?.length > previous && value.turns.at(-1)?.status === 'completed' ? value.turns.at(-1) : null; }, 'Core browser turn');
}
function toolResult(turn) {
  const item = turn.items.find(item => item.type === 'dynamicToolCall' && item.tool === 'browser_v1');
  assert.ok(item, 'Core history contains browser tool');
  return item;
}
try {
  app = await electron.launch({ executablePath: require('electron'), args: [join(gui, 'app')], env, timeout: 120000 });
  events.startup = await checkBrowserStartup(app, { binary: env.AREAL_CORE_BIN, userHome, scratch });
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  events.runtime = await app.evaluate(() => ({ versions: process.versions, platform: process.platform, arch: process.arch }));
  page.on('pageerror', error => errors.push(error.message));
  await page.getByTestId('areal-workbench').waitFor({ timeout: 120000 });
  await until(async () => (await state()).connection?.state === 'ready', 'desktop ready');
  events.coreChildProbe = await app.evaluate(({ app }, binary) => {
    const { spawnSync } = process.getBuiltinModule('node:child_process');
    const output = spawnSync(binary, ['--version'], { env: { ...process.env, HOME: process.env.AREAL_CORE_USER_HOME }, encoding: 'utf8' });
    const plain = spawnSync(binary, ['--version'], { encoding: 'utf8' });
    const clean = spawnSync(binary, ['--version'], { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.AREAL_CORE_USER_HOME, TMPDIR: process.env.TMPDIR }, encoding: 'utf8' });
    const system = spawnSync('/usr/bin/true', [], { encoding: 'utf8' });
    return { exit: output.status, signal: output.signal, stdout: output.stdout, stderr: output.stderr,
      plain: { exit: plain.status, signal: plain.signal }, clean: { exit: clean.status, signal: clean.signal, stderr: clean.stderr },
      inheritedVariableNames: Object.keys(process.env).filter(key => /^(DYLD_|ELECTRON_|NODE_|CODEX_|APP_SANDBOX)/.test(key)),
      system: { exit: system.status, signal: system.signal },
      electronSandbox: app.isPackaged, homeExists: process.getBuiltinModule('node:fs').existsSync(process.env.AREAL_CORE_USER_HOME) };
  }, env.AREAL_CORE_BIN);
  await app.evaluate(({ dialog, BrowserWindow }, { path, origins }) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    const original = dialog.showMessageBox;
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      const origin = origins.find(value => options?.message === `允许此浏览工作区访问 ${value}？`);
      if (options?.title === '允许本地开发站点' && origin) {
        globalThis.__m1OriginPrompts = [...(globalThis.__m1OriginPrompts ?? []), { origin, title: options.title }];
        return { response: 1, checkboxChecked: false };
      }
      return original(...args);
    };
    BrowserWindow.getAllWindows()[0].setSize(1440, 960);
  }, { path: workspace, origins: [new URL(siteUrl).origin, new URL(childUrl).origin] });
  await page.evaluate(() => window.arealDesktop.chooseProject());
  const project = await until(async () => (await state()).projects.find(item => item.root === workspace), 'project ready');
  const first = await command('create', { projectId: project.id, browserEnabled: true, profile: { id: 'fixture', revision: 'v1' } });
  await selectConversation(page, first.threadId);
  await page.keyboard.press('Meta+t');
  await page.locator('.preview-panel').waitFor();
  await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0].focus(); });
  await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()), 'focused Main Origin prompt');
  await page.evaluate(({ projectId, threadId, url }) => window.arealDesktop.preview({ operation: 'navigate', projectId, threadId, url }),
    { projectId: project.id, threadId: first.threadId, url: childUrl });
  await until(() => app.evaluate(({ webContents }, url) => webContents.getAllWebContents().some(c => c.getURL() === url), childUrl), 'child Origin granted');
  const childGrantGets = siteFacts.childGets;
  events.childOriginGrant = { childGrantGets, requests: structuredClone(siteFacts.childRequests) };
  assert.equal(childGrantGets, 1, 'one explicit child-Origin document navigation');
  const childPageId = (await page.evaluate(({ projectId, threadId }) =>
    window.arealDesktop.preview({ operation: 'state', projectId, threadId }),
    { projectId: project.id, threadId: first.threadId })).browser.pageId;
  await page.evaluate(({ projectId, threadId, pageId }) =>
    window.arealDesktop.preview({ operation: 'show', projectId, threadId, pageId, visible: true }),
    { projectId: project.id, threadId: first.threadId, pageId: childPageId });
  await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0].focus(); });
  await page.evaluate(({ projectId, threadId, url }) => window.arealDesktop.preview({ operation: 'navigate', projectId, threadId, url }),
    { projectId: project.id, threadId: first.threadId, url: siteUrl });
  events.developmentOriginPrompts = await app.evaluate(() => globalThis.__m1OriginPrompts);
  assert.deepEqual(events.developmentOriginPrompts.map(item => item.origin),
    [new URL(childUrl).origin, new URL(siteUrl).origin], 'two exact synthetic-Origin Main prompts occurred');
  events.developmentOriginPromptResponse = 'fixture-stub-allow-two-exact-origins';
  const nativeId = await until(() => app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(c => c.getURL() === url)?.id, siteUrl), 'native page');
  await until(() => app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript(
    `document.readyState === 'complete'`), nativeId), 'main document and iframe loads settled');
  await app.evaluate(({ webContents }, id) => {
    const contents = webContents.fromId(id), trace = { capturePage: 0, fullAXTree: 0 };
    const capture = contents.capturePage.bind(contents), send = contents.debugger.sendCommand.bind(contents.debugger);
    contents.capturePage = (...args) => { trace.capturePage++; return capture(...args); };
    contents.debugger.sendCommand = (method, ...args) => {
      if (method === 'Accessibility.getFullAXTree') trace.fullAXTree++;
      return send(method, ...args);
    };
    contents.__browserEvidenceTrace = trace;
  }, nativeId);
  const nativeTrace = () => app.evaluate(({ webContents }, id) => ({ ...webContents.fromId(id).__browserEvidenceTrace }), nativeId);
  const traceBeforeObserve = await nativeTrace();
  await page.getByRole('button', { name: '让 Agent 检查当前页' }).click();
  pageId = (await until(async () => { const value = await page.evaluate(({ projectId, threadId }) => window.arealDesktop.preview({ operation: 'state', projectId, threadId }), { projectId: project.id, threadId: first.threadId }); return value.browser?.control === 'agent' ? value : null; }, 'claim')).browser.pageId;
  const initial = toolResult(await nextTurn(first.threadId));
  console.error('browser-evidence: initial observation completed');
  let completedTurns = 1;
  async function runScenario(nextScenario, prompt) {
    scenario = nextScenario;
    issuedToolForScenario = false;
    console.error(`browser-evidence: ${nextScenario} starting`);
    await command('send', { projectId: project.id, threadId: first.threadId, text: prompt });
    const result = toolResult(await nextTurn(first.threadId, completedTurns++));
    console.error(`browser-evidence: ${nextScenario} completed`);
    return result;
  }
  const observation = JSON.parse(initial.contentItems[0].text);
  rootRef = observation.nodes.find(node => node.name === 'Duplicate target')?.ref;
  assert.match(rootRef, /^r\d+$/);
  assert.equal(observation.nativeWebContentsId, nativeId);
  assert.equal(observation.frameCoverage.childFrames.length, 2);
  assert.ok(observation.frameCoverage.childFrames.every(frame => ['covered', 'unavailable'].includes(frame.coverage)));
  events.crossFrameDiagnostic = { childFrames: observation.frameCoverage.childFrames, childGets: siteFacts.childGets };
  const crossOriginFrame = observation.frameCoverage.childFrames.find(frame => frame.url === childUrl);
  const blockedCrossOriginFrame = observation.frameCoverage.childFrames.find(frame => frame.url === 'chrome-error://chromewebdata/');
  assert.ok(crossOriginFrame || blockedCrossOriginFrame,
    `cross-Origin child has explicit coverage or policy failure: ${JSON.stringify(events.crossFrameDiagnostic)}`);
  if (crossOriginFrame) {
    assert.equal(siteFacts.childGets, childGrantGets + 1, 'child served its grant and one embedded navigation');
    assert.equal(siteFacts.childRequests.at(-1).destination, 'iframe');
  } else {
    assert.equal(blockedCrossOriginFrame.coverage, 'unavailable', 'blocked Frame is explicitly unavailable');
    assert.equal(siteFacts.childGets, childGrantGets, 'CSP-blocked Frame sends no embedded request');
  }
  assert.equal(await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript(
    `document.querySelector('#cross').contentDocument === null`), nativeId), true,
  'embedded child is actually cross-Origin');
  events.crossOriginFrame = { frame: crossOriginFrame ?? blockedCrossOriginFrame,
    loaded: !!crossOriginFrame, childGets: siteFacts.childGets, childRequests: structuredClone(siteFacts.childRequests),
    limitation: crossOriginFrame ? null : "Native Session injects frame-src 'self' CSP" };
  assert.equal(observation.shadowCoverage, 'not-distinguished-by-accessibility-tree');
  assert.ok(observation.text.includes(sentinel));
  assert.ok(!JSON.stringify(observation).includes('SYNTHETIC_SECRET_03'));
  for (const secret of ['482913', '573824', '654321', '246813', '738291', '864209'])
    assert.ok(!JSON.stringify(observation).includes(secret), `AX observation exposed ${secret}`);
  events.initial = { threadId: first.threadId, callId: initial.callId, observation };
  assert.ok(observation.nodes.every(node => node.id && node.role && typeof node.state === 'object'));
  assert.ok(observation.nodes.some(node => node.parent), 'AX observation preserves association hierarchy');
  assert.ok(observation.nodes.some(node => node.role === 'button' && node.name === 'Duplicate target'));
  assert.equal(observation.nodes.find(node => node.name === 'Disabled action')?.state.disabled, 'true');
  assert.match(observation.nodes.find(node => node.role === 'textbox' && node.name.trim() === 'Search query')?.ref, /^r\d+$/);
  assert.ok(!observation.nodes.some(node => node.role === 'tablist' && node.ref), 'container roles do not receive Refs');
  const initialTrace = await nativeTrace();
  assert.ok(initialTrace.fullAXTree > 0);
  assert.equal(initialTrace.capturePage, traceBeforeObserve.capturePage, 'observe must not generate a screenshot');
  const originalRef = rootRef;
  const partial = JSON.parse((await runScenario('budget', 'Observe one node only')).contentItems[0].text);
  assert.equal(partial.nodes.length, 1);
  assert.ok(!partial.nodes.some(node => node.ref === originalRef), 'budget omits the original target');
  const retained = JSON.parse((await runScenario('stale', 'Observe the unchanged target after a partial snapshot')).contentItems[0].text);
  assert.equal(retained.nodes.find(node => node.name === 'Duplicate target')?.ref, originalRef);
  events.partialIdentity = { partial, retainedRef: originalRef };
  await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript(`document.querySelector('#replace').outerHTML='<button id="replace">Duplicate target</button>'`), nativeId);
  const stale = await runScenario('stale', 'Observe old Ref after replacement');
  assert.match(JSON.stringify(stale), /stale_ref/);
  events.stale = { callId: stale.callId, contentItems: stale.contentItems };
  const refreshed = JSON.parse((await runScenario('refresh', 'Refresh semantic Ref')).contentItems[0].text);
  rootRef = refreshed.nodes.find(node => node.name === 'Duplicate target')?.ref;
  assert.match(rootRef, /^r\d+$/);
  await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript(`document.querySelector('#same').src='/frame?revision=2'`), nativeId);
  await until(async () => app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript(`document.querySelector('#same').contentWindow.location.search === '?revision=2'`), nativeId), 'frame document replaced');
  const frameStale = await runScenario('stale', 'Observe old Ref after frame document navigation');
  assert.match(JSON.stringify(frameStale), /stale_ref/);
  events.frameStale = { callId: frameStale.callId, contentItems: frameStale.contentItems };
  record('B-07.ref-lifecycle', 'B-07: duplicate-name replacement and Frame document navigation invalidate old Refs through Core without fallback', {
    initial: events.initial, partialIdentity: events.partialIdentity, stale: events.stale, frameStale: events.frameStale });
  const bounded = JSON.parse((await runScenario('budget', 'Observe bounded page')).contentItems[0].text);
  assert.equal(bounded.nodes.length, 1); assert.equal(bounded.truncated, true);
  assert.equal(bounded.truncationReason, 'budget');
  events.budget = bounded;
  const beforeCaptureTrace = await nativeTrace();
  assert.equal(beforeCaptureTrace.capturePage, traceBeforeObserve.capturePage, 'all observe calls remain semantic-only');
  events.surfaceTraceBeforeCapture = beforeCaptureTrace;
  record('B-08.coverage-budget', 'B-08: real iframe and Shadow fixture has explicit coverage, bounded observation reports truncation', {
    initial: events.initial, budget: events.budget, surfaceTraceBeforeCapture: events.surfaceTraceBeforeCapture });
  async function pageScript(script) {
    return app.evaluate(({ webContents }, { id, script }) => webContents.fromId(id).executeJavaScript(script), { id: nativeId, script });
  }
  const locations = () => pageScript(`({
    root: !!document.querySelector('#password, #session'),
    frame: !!document.querySelector('#same').contentDocument.querySelector('input'),
    shadow: !!document.querySelector('#shadow').shadowRoot.querySelector('input'),
    otp: !!document.querySelector('#otp'), otpInput: !!document.querySelector('#otpinput'),
    autocomplete: !!document.querySelector('#autofill-case'),
    cross: !!document.querySelector('#cross')
  })`);
  await pageScript(`document.querySelector('#password').closest('label').remove();document.querySelector('#session').remove();
    document.querySelector('#same').contentDocument.querySelector('input').remove();
    document.querySelector('#shadow').shadowRoot.querySelector('input').remove();
    document.querySelector('#otp').remove();document.querySelector('#otpinput').remove();document.querySelector('#cross').remove()`);
  assert.deepEqual(await locations(), { root: false, frame: false, shadow: false, otp: false, otpInput: false, autocomplete: false, cross: false });
  await pageScript(`(() => {
    document.body.insertAdjacentHTML('beforeend', '<input id="spoof-secret" type="password" value="SPOOFED_SECRET_03">');
    const originals = {
      documentQuery: Document.prototype.querySelector, documentAll: Document.prototype.querySelectorAll,
      elementQuery: Element.prototype.querySelector, elementAll: Element.prototype.querySelectorAll,
      width: Object.getOwnPropertyDescriptor(window, 'innerWidth')
    };
    Document.prototype.querySelector = Element.prototype.querySelector = () => null;
    Document.prototype.querySelectorAll = Element.prototype.querySelectorAll = () => [];
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1 });
    window.__restoreBrowserEvidence = () => {
      Document.prototype.querySelector = originals.documentQuery;
      Document.prototype.querySelectorAll = originals.documentAll;
      Element.prototype.querySelector = originals.elementQuery;
      Element.prototype.querySelectorAll = originals.elementAll;
      if (originals.width) Object.defineProperty(window, 'innerWidth', originals.width);
      else delete window.innerWidth;
    };
  })()`);
  const spoofedCapture = await runScenario('capture', 'Capture while page scripts hide a password field');
  assert.match(JSON.stringify(spoofedCapture), /evidence_unavailable/);
  const spoofedObservation = JSON.parse((await runScenario('refresh', 'Observe while page scripts spoof viewport width')).contentItems[0].text);
  assert.ok(spoofedObservation.viewport.width > 100, 'trusted viewport ignores main-world width spoof');
  await pageScript(`window.__restoreBrowserEvidence();document.querySelector('#spoof-secret').remove();delete window.__restoreBrowserEvidence`);
  events.mainWorldSpoof = { capture: spoofedCapture.contentItems, trustedWidth: spoofedObservation.viewport.width };
  const captureOnlyTrace = await nativeTrace();
  events.beforeSafeCapture = await app.evaluate(({ webContents }, id) =>
    webContents.fromId(id).executeJavaScriptInIsolatedWorld(1001, [{ code: `(() => ({
      frames: [...document.querySelectorAll('iframe,frame')].map(frame => ({
        url: frame.src.split('?')[0], readable: !!frame.contentDocument,
        ready: frame.contentDocument?.readyState ?? null })),
      sensitiveInputs: document.querySelectorAll('input[type="password"],input[name*="token" i],input[name*="secret" i],input[name*="key" i],input[autocomplete*="password" i],input[autocomplete*="one-time-code" i],input[autocomplete*="cc-csc" i]').length,
      visibleSensitiveText: [...document.querySelectorAll('body *')].some(node =>
        !['SCRIPT','STYLE','TEMPLATE','NOSCRIPT'].includes(node.tagName) &&
        [...node.childNodes].some(child => child.nodeType === Node.TEXT_NODE &&
          /password|passcode|secret|token|api.?key|credit.?card|cvv|authorization|one.?time.?code|\\botp\\b|credential/i.test(child.textContent)))
    }))()` }]), nativeId);
  const safeBaseline = await runScenario('capture', 'Capture the safe baseline before isolated refusals');
  events.safeBaseline = { callId: safeBaseline.callId, contentItems: safeBaseline.contentItems,
    nativeTrace: await nativeTrace() };
  assert.ok(safeBaseline.contentItems.some(part => part.type === 'arealMedia'), 'baseline page must be capturable');
  const cases = [
    ['root', `document.body.insertAdjacentHTML('beforeend','<input id="password" type="password" value="ROOT_SECRET_03">')`, `document.querySelector('#password').remove()`],
    ['frame', `document.querySelector('#same').contentDocument.body.insertAdjacentHTML('beforeend','<input name="token" value="FRAME_SECRET_03">')`, `document.querySelector('#same').contentDocument.querySelector('input').remove()`],
    ['shadow', `document.querySelector('#shadow').shadowRoot.innerHTML += '<input name="secret" value="SHADOW_SECRET_03">'`, `document.querySelector('#shadow').shadowRoot.querySelector('input').remove()`],
    ['otp', `document.body.insertAdjacentHTML('beforeend','<div id="otp">One-time code: 246813</div>')`, `document.querySelector('#otp').remove()`],
    ['otpInput', `document.body.insertAdjacentHTML('beforeend','<input id="otpinput" autocomplete="one-time-code" value="654321">')`, `document.querySelector('#otpinput').remove()`],
    ['currentPasswordAutocomplete', `document.body.insertAdjacentHTML('beforeend','<input id="autofill-case" type="text" autocomplete="current-password" value="642819">')`, `document.querySelector('#autofill-case').remove()`, 'autocomplete'],
    ['cardSecurityCodeAutocomplete', `document.body.insertAdjacentHTML('beforeend','<input id="autofill-case" type="text" autocomplete="cc-csc" value="642819">')`, `document.querySelector('#autofill-case').remove()`, 'autocomplete'],
    ['sectionOtpAutocomplete', `document.body.insertAdjacentHTML('beforeend','<input id="autofill-case" type="text" autocomplete="section-login one-time-code" value="642819">')`, `document.querySelector('#autofill-case').remove()`, 'autocomplete'],
    ['cross', `document.body.insertAdjacentHTML('beforeend','<iframe id="cross" src="${childUrl}"></iframe>')`, `document.querySelector('#cross').remove()`],
  ];
  events.sensitiveCapture = {};
  for (const [kind, add, remove, location = kind] of cases) {
    await pageScript(add);
    if (kind === 'cross') await until(() => pageScript(`document.querySelector('#cross').contentDocument === null`), 'cross origin iframe loaded');
    assert.deepEqual(Object.entries(await locations()).filter(([, present]) => present).map(([name]) => name), [location], `${kind} is the only denying condition`);
    const traceBefore = await nativeTrace();
    const denied = await runScenario('capture', `Capture with only ${kind} sensitive condition`);
    assert.match(JSON.stringify(denied), /evidence_unavailable/);
    assert.equal((await nativeTrace()).capturePage, traceBefore.capturePage, `${kind} must refuse before native capture`);
    events.sensitiveCapture[kind] = denied.contentItems;
    await pageScript(remove);
    assert.deepEqual(Object.values(await locations()), [false, false, false, false, false, false, false]);
  }
  await pageScript(`document.body.insertAdjacentHTML('beforeend','<input id="autofill-case" type="text" autocomplete="name" value="642819">')`);
  const ordinaryAutofill = await runScenario('capture', 'Capture with ordinary autocomplete name');
  assert.ok(ordinaryAutofill.contentItems.some(part => part.type === 'arealMedia'), 'ordinary autocomplete name remains capturable');
  await pageScript(`document.querySelector('#autofill-case').remove()`);
  events.ordinaryAutofill = { callId: ordinaryAutofill.callId };
  await app.evaluate(({ webContents }, id) => {
    const contents = webContents.fromId(id), original = contents.capturePage;
    contents.capturePage = async (...args) => {
      await new Promise(resolve => setTimeout(resolve, 100));
      await contents.executeJavaScript('scrollTo(0, 500)');
      return original(...args);
    };
    contents.__captureBeforeViewport = original;
  }, nativeId);
  const movedViewportCapture = await runScenario('capture', 'Capture while the viewport changes');
  assert.match(JSON.stringify(movedViewportCapture), /evidence_unavailable/);
  await app.evaluate(({ webContents }, id) => {
    const contents = webContents.fromId(id);
    contents.capturePage = contents.__captureBeforeViewport;
    delete contents.__captureBeforeViewport;
    return contents.executeJavaScript('scrollTo(0, 0)');
  }, nativeId);
  events.movedViewportCapture = movedViewportCapture.contentItems;
  await app.evaluate(({ webContents }, id) => {
    const contents = webContents.fromId(id), original = contents.capturePage;
    contents.capturePage = async (...args) => {
      await contents.executeJavaScript(`(async () => {
        document.body.insertAdjacentHTML('beforeend', '<input id="during-capture" type="password" value="619428">');
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      })()`);
      const image = await original(...args);
      await contents.executeJavaScript(`document.querySelector('#during-capture').remove()`);
      contents.__duringCaptureFacts = { visibleDuringImage: true, removedBeforePostScan: true, pngBytes: image.toPNG().length };
      return image;
    };
    contents.__captureBeforeSensitive = original;
  }, nativeId);
  const insertedCapture = await runScenario('captureInserted', 'Capture while a password appears during native capture');
  assert.match(JSON.stringify(insertedCapture), /evidence_unavailable/);
  assert.ok(!insertedCapture.contentItems.some(part => part.type === 'arealMedia'));
  assert.ok(!modelCalls.some(call => call.scenario === 'captureInserted' && call.hadImage));
  const insertedFacts = await app.evaluate(({ webContents }, id) => webContents.fromId(id).__duringCaptureFacts, nativeId);
  assert.ok(insertedFacts.visibleDuringImage && insertedFacts.removedBeforePostScan && insertedFacts.pngBytes > 0);
  await app.evaluate(({ webContents }, id) => {
    const contents = webContents.fromId(id);
    contents.capturePage = contents.__captureBeforeSensitive;
    delete contents.__captureBeforeSensitive;
    delete contents.__duringCaptureFacts;
  }, nativeId);
  events.insertedCapture = { contentItems: insertedCapture.contentItems, native: insertedFacts };
  await pageScript(`(async () => {
    const canvas = document.createElement('canvas'); canvas.id = 'noise';
    canvas.width = Math.ceil(innerWidth * devicePixelRatio);
    canvas.height = Math.ceil(innerHeight * devicePixelRatio);
    Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', zIndex: '9999' });
    const context = canvas.getContext('2d'), pixels = context.createImageData(canvas.width, canvas.height);
    let seed = 0x12345678;
    for (let index = 0; index < pixels.data.length; index += 4) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      pixels.data[index] = seed & 255; pixels.data[index + 1] = (seed >>> 8) & 255;
      pixels.data[index + 2] = (seed >>> 16) & 255; pixels.data[index + 3] = 255;
    }
    context.putImageData(pixels, 0, 0); document.body.append(canvas);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
  const largeImageBytes = await app.evaluate(async ({ webContents }, id) =>
    (await webContents.fromId(id).capturePage()).toPNG().length, nativeId);
  assert.ok(largeImageBytes > 2 * 1024 * 1024, `fixture must produce an oversized native PNG; got ${largeImageBytes} bytes`);
  const oversizedCapture = await runScenario('capture', 'Capture an image above the encoded byte budget');
  assert.match(JSON.stringify(oversizedCapture), /evidence_unavailable/);
  events.oversizedCapture = { nativePngBytes: largeImageBytes, contentItems: oversizedCapture.contentItems };
  await pageScript(`(async () => {
    document.querySelector('#noise').remove();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
  const modelCheckpoint = modelCalls.length;
  const captured = await runScenario('capture', 'Capture after sensitive conditions are removed');
  const afterCaptureTrace = await nativeTrace();
  assert.ok(afterCaptureTrace.capturePage > beforeCaptureTrace.capturePage);
  assert.equal(afterCaptureTrace.fullAXTree, captureOnlyTrace.fullAXTree, 'capture must not request the accessibility tree');
  events.surfaceTraceAfterCapture = afterCaptureTrace;
  const image = captured.contentItems.find(part => part.type === 'arealMedia');
  assert.ok(image?.media?.uri?.startsWith('areal://blob/'));
  const modelImage = modelCalls.slice(modelCheckpoint).find(call => call.hadImage && call.assistantToolCallIds.includes(captured.callId));
  assert.ok(modelImage, 'this captured tool call must send image bytes to the model');
  const verification = page.locator('details[aria-label="浏览器验证结果"]');
  await verification.locator('summary').click();
  const renderedImage = verification.locator('img');
  await renderedImage.waitFor();
  const guiImage = await renderedImage.evaluate(async img => {
    await img.decode();
    return { complete: img.complete, width: img.naturalWidth, height: img.naturalHeight, sourceScheme: new URL(img.currentSrc).protocol };
  });
  assert.ok(guiImage.complete && guiImage.width > 0 && guiImage.height > 0);
  assert.equal(guiImage.sourceScheme, 'blob:');
  const guiReadSHA256 = await page.evaluate(async ({ projectId, threadId, uri }) => {
    const response = await window.arealDesktop.command('media', { projectId, threadId, operation: 'read', uri });
    if (!response.ok) throw Error(JSON.stringify(response));
    const hash = await crypto.subtle.digest('SHA-256', response.value.bytes);
    return Array.from(new Uint8Array(hash)).map(byte => byte.toString(16).padStart(2, '0')).join('');
  }, { projectId: project.id, threadId: first.threadId, uri: image.media.uri });
  assert.equal(modelImage.imageSHA256, guiReadSHA256, 'model and GUI receive the same Core image Blob');
  await page.screenshot({ path: join(scratch, 'gui-image.png'), animations: 'disabled' });
  const nativePng = await app.evaluate(async ({ webContents }, id) => (await webContents.fromId(id).capturePage()).toPNG().toString('base64'), nativeId);
  await writeFile(join(scratch, 'native-page.png'), Buffer.from(nativePng, 'base64'));
  const second = await command('create', { projectId: project.id, browserEnabled: true, profile: { id: 'fixture', revision: 'v1' } });
  const denied = await page.evaluate(({ projectId, threadId, uri }) =>
    window.arealDesktop.command('media', { projectId, threadId, operation: 'read', uri }),
  { projectId: project.id, threadId: second.threadId, uri: image.media.uri });
  assert.equal(denied.ok, false, 'different Thread must not read screenshot Blob');
  assert.match(denied.error?.message ?? '', /404/);
  events.image = { threadId: first.threadId, callId: captured.callId, nativeId, media: image.media,
    guiImage, guiReadSHA256, modelImageSHA256: modelImage.imageSHA256,
    crossThreadError: denied.error?.message, siteFacts: structuredClone(siteFacts) };
  checks.push('B-09: Core tool image reaches deterministic model and GUI, Blob rejects another Thread');
  const beforeQuota = JSON.parse((await runScenario('refresh', 'Refresh a live Ref before bounded cache churn')).contentItems[0].text);
  rootRef = beforeQuota.nodes.find(node => node.name === 'Duplicate target')?.ref;
  assert.match(rootRef, /^r\d+$/);
  const anchorRef = rootRef, quotaObservations = [];
  for (let batch = 0; batch < 80; batch++) {
    await pageScript(`(() => {
      const group = document.createDocumentFragment();
      for (let index = 0; index < 120; index++) {
        const button = document.createElement('button'); button.textContent = 'quota-${batch}-' + index;
        button.dataset.quotaBatch = '${batch}';
        group.append(button);
      }
      document.body.prepend(group);
    })()`);
    const result = await runScenario('quota', `Observe new live targets in bounded batch ${batch}`);
    assert.ok(Buffer.byteLength(result.contentItems[0].text) < 16 * 1024, 'inline observation fits Core projection limit');
    const observed = JSON.parse(result.contentItems[0].text);
    assert.ok(!observed.rawResult, `batch ${batch} exceeded Core's 16 KiB inline projection`);
    assert.equal(observed.refCache.capacity, 1000);
    assert.ok(observed.nodes.length <= 60 && observed.budget.textBytes === 4 * 1024);
    const newestRef = observed.nodes.find(node => node.name.startsWith(`quota-${batch}-`) && node.ref)?.ref;
    assert.match(newestRef, /^r\d+$/, 'bounded observation must include a new actionable target');
    quotaObservations.push({ batch, emitted: observed.nodes.length, issuedRefs: observed.nodes.filter(node => node.ref).length,
      evicted: observed.refCache.evicted, newestRef });
    if (observed.refCache.evicted > 0) break;
  }
  assert.ok(quotaObservations.at(-1)?.evicted > 0, 'live old Refs are evicted at capacity');
  const evictedRef = await runScenario('stale', 'Observe the old Ref after cache eviction');
  assert.match(JSON.stringify(evictedRef), /stale_ref/);
  events.refCapacity = { anchorRef, observations: quotaObservations, evictedContent: evictedRef.contentItems };
  checks.push('B-07: bounded inline snapshots eventually evict a still-live old Ref');
  assert.equal(siteFacts.posts, 0);
  assert.deepEqual(errors, []);
  record('B-09.media-privacy', 'B-09: Core tool image reaches deterministic model and GUI, Blob rejects another Thread', events);
  executionStatus = 'completed';
} catch (error) {
  if (error.code === 'BROWSER_STARTUP_BLOCKED') executionStatus = 'blocked';
  errors.push(error.stack ?? String(error));
  if (page) await captureSmokeFailure(page, scratch, error);
  throw error;
} finally {
  if (app) await app.close();
  site.closeAllConnections(); sibling.closeAllConnections(); model.closeAllConnections();
  await Promise.all([new Promise(resolve => site.close(resolve)), new Promise(resolve => sibling.close(resolve)), new Promise(resolve => model.close(resolve))]);
  const files = ['app/src/core/browser-tool.cjs', 'app/src/core/backend.cjs', 'app/src/core/service-protocol.cjs',
    'app/src/core/preview.cjs', 'app/src/core/main.cjs', 'renderer/src/Messages.tsx', 'renderer/src/ToolEvent.tsx',
    'scripts/browser-evidence-smoke.mjs', 'scripts/browser-evidence.mjs', 'scripts/browser-startup.mjs'];
  const hashes = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(join(gui, file))).digest('hex')])));
  const result = evidence.finish({ executionStatus, provenance: {
    sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    diffSHA256: createHash('sha256').update(execFileSync('git', ['diff', 'HEAD'], { cwd: root })).digest('hex'),
    scriptSHA256: hashes['scripts/browser-evidence-smoke.mjs'],
    coreBinarySHA256: createHash('sha256').update(await readFile(env.AREAL_CORE_BIN)).digest('hex'),
  } });
  await writeFile(join(scratch, 'manifest.json'), JSON.stringify({ ...result, checks, errors, events, modelCalls,
    startedAt, finishedAt: new Date().toISOString(), command: 'node clients/gui/scripts/browser-evidence-smoke.mjs',
    fixture: 'synthetic site and deterministic local chat-completions model in this script',
    source: result.provenance.sourceHead, diffSHA256: result.provenance.diffSHA256,
    hashes, coreBinary: env.AREAL_CORE_BIN,
    coreBinarySHA256: result.provenance.coreBinarySHA256,
    scope: 'source Electron + Core/Runtime + independent adapter + deterministic model + synthetic sites' }, null, 2));
  console.log(JSON.stringify({ executionStatus, acceptanceStatus: result.acceptanceStatus, evidence: scratch, checks, errors }));
}
