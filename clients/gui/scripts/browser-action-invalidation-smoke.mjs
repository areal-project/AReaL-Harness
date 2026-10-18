import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { selectConversation, captureSmokeFailure } from './smoke-navigation.mjs';

// B-11：公开审批前改变真实视口、文档或精确 Origin，验证旧计划拒绝派发。
const actionMode = process.argv[2] ?? 'ref';
if (!['ref', 'coordinates', 'origin', 'external', 'externalFixture'].includes(actionMode)) throw Error('Unknown invalidation mode');
const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(gui, '../..');
const require = createRequire(join(gui, 'app/package.json'));
const { _electron: electron } = require('playwright-core');
const scratch = await mkdtemp('/private/tmp/areal-browser-actions-');
const workspace = join(scratch, 'workspace'), userHome = join(scratch, 'user');
await mkdir(workspace); await mkdir(join(userHome, '.areal'), { recursive: true });
execFileSync('git', ['init', '-b', 'main'], { cwd: workspace, stdio: 'ignore' });
const siteFacts = { gets: 0, posts: 0 };
const siteHandler = async (request, response) => {
  if (request.method === 'POST') {
    siteFacts.posts++;
    for await (const _chunk of request) { /* consume fixture request without logging values */ }
    response.end('ok');
    return;
  }
  siteFacts.gets++;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><title>Action fixture</title>
    <button id="submit" onclick="fetch('/effect',{method:'POST'})">Submit action</button>
    <button id="disabled" disabled>Disabled action</button>
    <form id="form"><label>Draft <input id="draft"></label><button type="submit">Send draft</button></form>
    <script>window.keyFacts={downs:[],ups:[],submits:0};
    document.addEventListener('keydown',event=>window.keyFacts.downs.push({key:event.key,target:event.target.id}));
    document.addEventListener('keyup',event=>window.keyFacts.ups.push({key:event.key,target:event.target.id}));
    document.querySelector('#form').addEventListener('submit',event=>{
      window.keyFacts.submits++;
      event.preventDefault();fetch('/effect',{method:'POST',body:document.querySelector('#draft').value});
    });</script>`);
};
const site = createServer(siteHandler), otherSite = actionMode === 'origin' ? createServer(siteHandler) : null;
await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
const siteUrl = `http://127.0.0.1:${site.address().port}/`;
if (otherSite) await new Promise(resolve => otherSite.listen(0, '127.0.0.1', resolve));
const otherUrl = otherSite ? `http://127.0.0.1:${otherSite.address().port}/` : null;
const externalAction = ['external', 'externalFixture'].includes(actionMode);
const initialUrl = actionMode === 'external' ? 'https://example.com/'
  : actionMode === 'externalFixture' ? siteUrl.replace('127.0.0.1', 'browser-synthetic.localhost') : siteUrl;
let pageId, mode = 'viewport';
let modelStage = 0;
const modelCalls = [];
const observationFrom = (value, depth = 0) => {
  if (depth > 8 || value == null) return null;
  if (typeof value === 'string') {
    try { return observationFrom(JSON.parse(value), depth + 1); } catch { return null; }
  }
  if (Array.isArray(value)) return value.map(item => observationFrom(item, depth + 1)).find(Boolean) ?? null;
  if (typeof value !== 'object') return null;
  if (value.observationId && (Array.isArray(value.nodes) || value.viewport?.bitmapWidth)) return value;
  return Object.values(value).map(item => observationFrom(item, depth + 1)).find(Boolean) ?? null;
};
const model = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw), last = body.messages.at(-1);
  modelCalls.push({ mode, lastRole: last?.role, browserToolAvailable: (body.tools ?? []).some(t => t.function?.name === 'browser_v1') });
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  const tool = (id, args) => {
    send({ tool_calls: [{ index: 0, id, type: 'function', function: { name: 'browser_v1', arguments: JSON.stringify(args) } }] });
    send({}, 'tool_calls');
  };
  await until(() => pageId, 'claimed native page');
  if (modelStage === 0) {
    modelStage = 1;
    tool(`observe-${mode}`, { operation: actionMode === 'coordinates' ? 'capture' : 'observe', parameters: { pageId, ...(actionMode === 'coordinates' ? { scope: 'viewport' } : {}) } });
  } else if (modelStage === 1) {
    const observation = observationFrom(body.messages.findLast(message => message.role === 'tool' && message.tool_call_id === `observe-${mode}`)?.content);
    if (!observation) { send({ content: `Action ${mode} reviewed` }); send({}, 'stop'); }
    else {
      const name = mode === 'disabled' ? 'Disabled action' : ['fill', 'press'].includes(mode) ? 'Draft' : 'Submit action';
      const ref = observation.nodes?.find(node => node.ref && (externalAction ? ['link', 'button'].includes(node.role) : node.name?.trim() === name))?.ref;
      if (!ref && actionMode !== 'coordinates') { send({ content: `No target ${name}` }); send({}, 'stop'); }
      else {
        const action = actionMode === 'coordinates' ? { kind: 'clickAt', x: Math.floor(20 * observation.viewport.bitmapWidth / observation.viewport.width), y: Math.floor(18 * observation.viewport.bitmapHeight / observation.viewport.height) }
          : mode === 'fill' ? { kind: 'fill', ref, value: 'DRAFT_INPUT_04' }
          : mode === 'press' ? { kind: 'press', ref, key: 'Enter' } : { kind: 'click', ref };
        const input = { operation: 'act', parameters: { pageId, snapshotId: observation.observationId, action } };
        if (mode === 'forged') input.browserApproval = { decision: 'allowOnce' };
        modelCalls.push({ mode, actionMode, observationId: observation.observationId, viewport: observation.viewport, action });
        modelStage = 2;
        tool(`act-${mode}`, input);
      }
    }
  } else { send({ content: `Action ${mode} reviewed` }); send({}, 'stop'); }
  response.end('data: [DONE]\n\n');
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
await writeFile(join(userHome, '.areal', 'config.toml'), `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`);
const deployment = join(scratch, 'desktop.json');
await writeFile(deployment, JSON.stringify({ profiles: [{ id: 'fixture', revision: 'v1', displayName: 'Fixture', instructions: 'Use the requested browser tool.' }] }));
const env = { ...process.env, AREAL_GUI_USER_DATA: join(scratch, 'electron'), AREAL_CORE_HOME: join(scratch, 'core'),
  AREAL_CORE_USER_HOME: userHome, AREAL_HARNESS_SERVICE_HOME: join(scratch, 'registry'),
  AREAL_CORE_DESKTOP_CONFIG: deployment, AREAL_CORE_BIN: process.env.AREAL_CORE_BIN || resolve(root, 'target/debug/areal') };
for (const key of ['AREAL_CORE_WORKSPACE', 'AREAL_CORE_CONFIG', 'AREAL_HARNESS_HOME', 'AREAL_HARNESS_CONFIG']) delete env[key];
const startedAt = new Date().toISOString(), checks = [], events = {}, errors = [];
let app, page, passed = false, projectId, threadId, nativeId;
async function until(predicate, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timeout: ${label}`);
}
async function snapshot() { return page.evaluate(() => window.arealDesktop.snapshot()); }
async function command(name, params) {
  const result = await page.evaluate(({ name, params }) => window.arealDesktop.command(name, params), { name, params });
  assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
}
async function currentThread() {
  return (await snapshot()).projects.find(item => item.id === projectId)?.state?.threads?.[threadId];
}
async function terminalTurn(previous) {
  return until(async () => {
    const turns = (await currentThread())?.turns ?? [];
    const last = turns.at(-1);
    return turns.length > previous && ['completed', 'failed', 'interrupted'].includes(last?.status) ? last : null;
  }, `terminal turn after ${mode}`);
}
function toolResult(turn) {
  const item = turn.items.find(item => item.type === 'dynamicToolCall' && item.tool === 'browser_v1' && item.callId === `act-${mode}`);
  assert.ok(item, `Core history contains act-${mode}`);
  return item;
}
async function nativeFacts() {
  return app.evaluate(({ webContents }, id) => webContents.fromId(id)?.executeJavaScript(
    `({draft:document.querySelector('#draft')?.value,submitPresent:!!document.querySelector('#submit'),
      activeElement:document.activeElement?.id,keyFacts:window.keyFacts})`), nativeId);
}
try {
  app = await electron.launch({ executablePath: require('electron'), args: [join(gui, 'app')], env, timeout: 120000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  console.log(JSON.stringify({ diagnostic:'launched', scratch, appPid:app.process()?.pid, appPath:join(gui,'app') }));
  page.on('pageerror', error => errors.push(error.message));
  events.runtime = await app.evaluate(({ app }) => ({ product: app.getVersion(), electron: process.versions.electron,
    chromium: process.versions.chrome, node: process.versions.node }));
  await page.getByTestId('areal-workbench').waitFor({ timeout: 120000 });
  await until(async () => (await snapshot()).connection?.state === 'ready', 'desktop ready');
  await app.evaluate(({ dialog, BrowserWindow }, { path, origins }) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    const original = dialog.showMessageBox;
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      if (options?.title === '允许本地开发站点' && origins.some(origin => options.message === `允许此浏览工作区访问 ${origin}？`)) {
        globalThis.__m1OriginPrompt = { origin: options.message, title: options.title, count: (globalThis.__m1OriginPrompt?.count ?? 0) + 1 };
        return { response: 1, checkboxChecked: false };
      }
      return original(...args);
    };
    BrowserWindow.getAllWindows()[0].setSize(1440, 960);
  }, { path: workspace, origins: [new URL(initialUrl).origin, ...(otherUrl ? [new URL(otherUrl).origin] : [])] });
  await page.evaluate(() => window.arealDesktop.chooseProject());
  const project = await until(async () => (await snapshot()).projects.find(item => item.root === workspace && item.state?.connected), 'project ready');
  projectId = project.id;
  const first = await command('create', { projectId, browserEnabled: true, profile: { id: 'fixture', revision: 'v1' } });
  threadId = first.threadId;
  await selectConversation(page, threadId);
  await page.keyboard.press('Meta+t');
  await page.locator('.preview-panel').waitFor();
  await page.bringToFront();
  await app.evaluate(({ app, BrowserWindow }) => { const win=BrowserWindow.getAllWindows()[0]; win.show(); win.restore(); app.focus({ steal: true }); win.focus(); });
  console.log(JSON.stringify({ diagnostic:'awaiting-focus', appPid:app.process()?.pid }));
  await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()), 'focused Main Origin prompt', 120000);
  await page.evaluate(({ projectId, threadId, url }) => window.arealDesktop.preview({ operation: 'navigate', projectId, threadId, url }),
    { projectId, threadId, url: initialUrl });
  events.developmentOriginPrompt = await app.evaluate(() => globalThis.__m1OriginPrompt);
  if (actionMode !== 'external') {
    assert.equal(events.developmentOriginPrompt?.count, 1, 'exact-Origin Main prompt occurred once');
    events.developmentOriginPrompt.response = 'fixture-stub-allow-exact-origin';
  }
  nativeId = await until(() => app.evaluate(({ webContents }, url) =>
    webContents.getAllWebContents().find(c => c.getURL() === url)?.id, initialUrl), 'native page');
  if (otherUrl) {
    for (const url of [otherUrl, siteUrl]) {
      await page.evaluate(({ projectId, threadId, url }) => window.arealDesktop.preview({ operation: 'navigate', projectId, threadId, url }), { projectId, threadId, url });
      await until(() => app.evaluate(({ webContents }, { id, url }) => webContents.fromId(id).getURL() === url && !webContents.fromId(id).isLoading(), { id: nativeId, url }), 'exact Origin authorized through public user navigation');
    }
    events.authorizedOrigins = [new URL(siteUrl).origin, new URL(otherUrl).origin];
  }
  await page.getByRole('button', { name: '让 Agent 检查当前页' }).click();
  pageId = (await until(async () => {
    const value = await page.evaluate(({ projectId, threadId }) =>
      window.arealDesktop.preview({ operation: 'state', projectId, threadId }), { projectId, threadId });
    return value.browser?.control === 'agent' ? value : null;
  }, 'claim')).browser.pageId;
  if (externalAction) await app.evaluate(({ webContents }, id) => {
    const c = webContents.fromId(id), original = c.sendInputEvent.bind(c);
    globalThis.__externalNativeInputs = [];
    c.sendInputEvent = event => { globalThis.__externalNativeInputs.push({ type: event.type }); return original(event); };
    const send = c.debugger.sendCommand.bind(c.debugger);
    c.debugger.sendCommand = (method, params) => {
      if (method.startsWith('Input.')) globalThis.__externalNativeInputs.push({ method });
      return send(method, params);
    };
  }, nativeId);
  let completedTurns = 0;
  async function scenario(next, choice = null) {
    mode = next;
    modelStage = 0;
    console.error(`browser-actions: ${next} starting`);
    if (completedTurns > 0) await command('send', { projectId, threadId, text: `Check ${next} action` });
    if (choice) {
      const panel = page.locator('[data-interaction="approval"]');
      await panel.waitFor({ timeout: 60000 });
      assert.match(await panel.innerText(), actionMode === 'coordinates' ? /clickAt|坐标|点击/ : /Submit action|Draft/);
      if (next === 'viewport') {
        const before = await page.evaluate(({ projectId, threadId, pageId }) =>
          window.arealDesktop.preview({ operation: 'state', projectId, threadId })
            .then(value => value.workspace.pages.find(item => item.pageId === pageId).viewportRevision),
        { projectId, threadId, pageId });
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 960));
        await until(() => page.evaluate(({ projectId, threadId, pageId, before }) =>
          window.arealDesktop.preview({ operation: 'state', projectId, threadId })
            .then(value => value.workspace.pages.find(item => item.pageId === pageId).viewportRevision > before),
        { projectId, threadId, pageId, before }), 'native viewport revision advanced');
        events.viewport = { beforeRevision: before, nativeBounds: await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].contentView.children[0].getBounds()) };
      }
      if (next === 'document') {
        const before = siteFacts.gets;
        await page.getByTestId('browser-refresh-button').click();
        await until(() => siteFacts.gets > before, 'user reload document GET');
        events.document = { getsBefore: before, getsAfter: siteFacts.gets };
      }
      if (next === 'origin') {
        const before = await app.evaluate(({ webContents }, id) => webContents.fromId(id).getURL(), nativeId);
        await page.evaluate(({ projectId, threadId, url }) => window.arealDesktop.preview({ operation: 'navigate', projectId, threadId, url }), { projectId, threadId, url: otherUrl });
        await until(() => app.evaluate(({ webContents }, { id, url }) => webContents.fromId(id).getURL() === url && !webContents.fromId(id).isLoading(), { id: nativeId, url: otherUrl }), 'actual approved target Origin changed');
        events.origin = { before, after: await app.evaluate(({ webContents }, id) => webContents.fromId(id).getURL(), nativeId), authorizedOrigins: events.authorizedOrigins };
        assert.notEqual(new URL(events.origin.before).origin, new URL(events.origin.after).origin);
      }
      await panel.getByRole('button', { name: choice }).click();
    }
    const turn = await terminalTurn(completedTurns);
    completedTurns++;
    const item = toolResult(turn);
    events[next] = { ...events[next], turnId: turn.id, status: turn.status, item, posts: siteFacts.posts, native: await nativeFacts() };
    console.error(`browser-actions: ${next} completed`);
    return item;
  }
  if (externalAction) {
    const denied = await scenario('external');
    assert.equal(denied.success, false); assert.match(JSON.stringify(denied.contentItems), /human_takeover_required/);
    assert.equal(denied.execution?.outcome, 'failed');
    const inputs = await app.evaluate(() => globalThis.__externalNativeInputs); assert.deepEqual(inputs, []);
    assert.equal(await page.locator('[data-interaction="approval"]').count(), 0);
    await page.getByRole('button', { name: '接管页面', exact: true }).click();
    const state = await until(() => page.evaluate(({ projectId, threadId }) => window.arealDesktop.preview({ operation: 'state', projectId, threadId }).then(value => value.browser?.control === 'human' ? value : null), { projectId, threadId }), 'explicit external Human handoff');
    for (const toggle of await page.locator('.turn-progress-summary[aria-expanded="false"]').all()) await toggle.click();
    for (const toggle of await page.locator('.execution-summary[aria-expanded="false"]').all()) await toggle.click();
    const row = page.locator(`[data-tool-id="${denied.id}"]`);
    const toggle = row.locator('button.tool-summary-row');
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    assert.match(await row.innerText(), /human_takeover_required/);
    await page.screenshot({ path: join(scratch, 'external-action-human-handoff.png') });
    assert.equal(await app.evaluate(({ webContents }, id) => webContents.fromId(id).getURL(), nativeId), initialUrl);
    assert.equal(siteFacts.posts, 0);
    events.external = { ...events.external, refusal: denied, inputsBeforeHandoff: inputs, state, readonlyExternalUrl: initialUrl, targetKind: actionMode === 'externalFixture' ? 'synthetic HTTP .localhost outside action allowlist; not public HTTPS acceptance' : 'public HTTPS', noExternalActionDispatched: true };
    checks.push('04c6 bounded: actual page outside narrow local-action allowlist reaches Core; its action is refused with human_takeover_required before approval or Native input, and existing GUI takeover returns the same page to Human');
  } else if (actionMode === 'origin') {
    const changed = await scenario('origin', '允许一次');
    assert.equal(changed.success, false);
    assert.match(JSON.stringify(changed.contentItems), /plan_stale/);
    assert.match(JSON.stringify(changed.contentItems), /observe again/);
    assert.equal(siteFacts.posts, 0);
    checks.push('04c3: public user navigation changes actual authorized Origin while Core approval waits; old plan is refused without site input, replay or replacement target');
  } else {
    const viewport = await scenario('viewport', '允许一次');
  assert.equal(viewport.success, false);
  assert.match(JSON.stringify(viewport.contentItems), /plan_stale|not_sent|viewport/);
  assert.equal(siteFacts.posts, 0);
  checks.push(`B-11: public GUI resize invalidates prepared ${actionMode} viewport plan before any site POST`);
  const document = await scenario('document', '允许一次');
  assert.equal(document.success, false);
  assert.match(JSON.stringify(document.contentItems), /plan_stale|not_sent|stale_ref|host_unavailable/);
  assert.equal(siteFacts.posts, 0);
  checks.push('B-11: user document reload invalidates prepared action without site POST');
  }
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  errors.push(error.stack ?? String(error));
  if (page) await captureSmokeFailure(page, scratch, error);
  throw error;
} finally {
  if (app) await app.close();
  site.closeAllConnections(); otherSite?.closeAllConnections(); model.closeAllConnections();
  await Promise.all([new Promise(resolve => site.close(resolve)), new Promise(resolve => model.close(resolve)), ...(otherSite ? [new Promise(resolve => otherSite.close(resolve))] : [])]);
  const files = ['app/src/core/browser-tool.cjs', 'app/src/core/preview.cjs', 'app/src/core/service-protocol.cjs',
    'renderer/src/ApprovalRequest.tsx', 'scripts/browser-action-invalidation-smoke.mjs'];
  const hashes = Object.fromEntries(await Promise.all(files.map(async file =>
    [file, createHash('sha256').update(await readFile(join(gui, file))).digest('hex')])));
  await writeFile(join(scratch, 'run-manifest.json'), JSON.stringify({ passed, checks, errors, events, modelCalls,
    startedAt, endedAt: new Date().toISOString(), sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    diffSHA256: createHash('sha256').update(execFileSync('git', ['diff', 'HEAD'], { cwd: root })).digest('hex'),
    hashes, coreBinary: env.AREAL_CORE_BIN,
    coreBinarySHA256: createHash('sha256').update(await readFile(env.AREAL_CORE_BIN)).digest('hex'),
    runtimeBinary: join(dirname(env.AREAL_CORE_BIN), 'areal-runtime'),
    runtimeBinarySHA256: createHash('sha256').update(await readFile(join(dirname(env.AREAL_CORE_BIN), 'areal-runtime'))).digest('hex'),
    reaperBinary: join(dirname(env.AREAL_CORE_BIN), 'areal-runtime-reaper'),
    reaperBinarySHA256: createHash('sha256').update(await readFile(join(dirname(env.AREAL_CORE_BIN), 'areal-runtime-reaper'))).digest('hex'),
    runtimeFsBinary: join(dirname(env.AREAL_CORE_BIN), 'areal-runtime-fs'),
    runtimeFsBinarySHA256: createHash('sha256').update(await readFile(join(dirname(env.AREAL_CORE_BIN), 'areal-runtime-fs'))).digest('hex'),
    runtime: events.runtime, entrypoint: 'node clients/gui/scripts/browser-action-invalidation-smoke.mjs',
    scope: 'source Electron + independent adapter + Core/Runtime + deterministic loopback model + synthetic site; OS chooser stubbed' }, null, 2));
  console.log(JSON.stringify({ passed, evidence: scratch, checks, errors }));
}
