import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { selectConversation, captureSmokeFailure } from './smoke-navigation.mjs';

// B-10–B-13: public GUI/Core approval and actual native input against a synthetic site.
const capacityMode = process.argv[2] ?? 'act';
assert.ok(['act', 'batch'].includes(capacityMode));
const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(gui, '../..');
const require = createRequire(join(gui, 'app/package.json'));
const { _electron: electron } = require('playwright-core');
const scratch = await mkdtemp('/private/tmp/areal-browser-actions-');
const workspace = join(scratch, 'workspace'), userHome = join(scratch, 'user');
await mkdir(workspace); await mkdir(join(userHome, '.areal'), { recursive: true });
execFileSync('git', ['init', '-b', 'main'], { cwd: workspace, stdio: 'ignore' });
const siteFacts = { gets: 0, posts: 0 };
const site = createServer(async (request, response) => {
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
});
await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
const siteUrl = `http://127.0.0.1:${site.address().port}/`;
let pageId, mode = 'deny';
let modelStage = 0;
const modelCalls = [];
const observationFrom = (value, depth = 0) => {
  if (depth > 8 || value == null) return null;
  if (typeof value === 'string') {
    try { return observationFrom(JSON.parse(value), depth + 1); } catch { return null; }
  }
  if (Array.isArray(value)) return value.map(item => observationFrom(item, depth + 1)).find(Boolean) ?? null;
  if (typeof value !== 'object') return null;
  if (value.observationId && Array.isArray(value.nodes)) return value;
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
    tool(`observe-${mode}`, { operation: 'observe', parameters: { pageId } });
  } else if (modelStage === 1) {
    const observation = observationFrom(last.content);
    if (!observation) { send({ content: `Action ${mode} reviewed` }); send({}, 'stop'); }
    else {
      const name = mode === 'disabled' ? 'Disabled action' : ['fill', 'press'].includes(mode) ? 'Draft' : 'Submit action';
      const ref = observation.nodes.find(node => node.name?.trim() === name && node.ref)?.ref;
      if (!ref) { send({ content: `No target ${name}` }); send({}, 'stop'); }
      else {
        const action = mode === 'fill' ? { kind: 'fill', ref, value: 'DRAFT_INPUT_04' }
          : ['press', 'pressButton', 'pressTab'].includes(mode) ? { kind: 'press', ref, key: mode === 'pressTab' ? 'Tab' : 'Enter' } : { kind: 'click', ref };
        const input = { operation: 'act', parameters: { pageId, snapshotId: observation.observationId, action } };
        if (mode === 'forged') input.browserApproval = { decision: 'allowOnce' };
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
  page.on('pageerror', error => errors.push(error.message));
  events.runtime = await app.evaluate(({ app }) => ({ product: app.getVersion(), electron: process.versions.electron,
    chromium: process.versions.chrome, node: process.versions.node }));
  await page.getByTestId('areal-workbench').waitFor({ timeout: 120000 });
  await until(async () => (await snapshot()).connection?.state === 'ready', 'desktop ready');
  await app.evaluate(({ dialog, BrowserWindow }, { path, origin }) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
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
  const project = await until(async () => (await snapshot()).projects.find(item => item.root === workspace && item.state?.connected), 'project ready');
  projectId = project.id;
  const first = await command('create', { projectId, browserEnabled: true, profile: { id: 'fixture', revision: 'v1' } });
  threadId = first.threadId;
  await selectConversation(page, threadId);
  await page.keyboard.press('Meta+t');
  await page.locator('.preview-panel').waitFor();
  await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0].focus(); });
  await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()), 'focused Main Origin prompt');
  await page.evaluate(({ projectId, threadId, url }) => window.arealDesktop.preview({ operation: 'navigate', projectId, threadId, url }),
    { projectId, threadId, url: siteUrl });
  events.developmentOriginPrompt = await app.evaluate(() => globalThis.__m1OriginPrompt);
  assert.equal(events.developmentOriginPrompt?.count, 1, 'exact-Origin Main prompt occurred once');
  events.developmentOriginPrompt.response = 'fixture-stub-allow-exact-origin';
  nativeId = await until(() => app.evaluate(({ webContents }, url) =>
    webContents.getAllWebContents().find(c => c.getURL() === url)?.id, siteUrl), 'native page');
  await page.getByRole('button', { name: '让 Agent 检查当前页' }).click();
  pageId = (await until(async () => {
    const value = await page.evaluate(({ projectId, threadId }) =>
      window.arealDesktop.preview({ operation: 'state', projectId, threadId }), { projectId, threadId });
    return value.browser?.control === 'agent' ? value : null;
  }, 'claim')).browser.pageId;
  await app.evaluate(({ webContents }, id) => {
    const debuggerApi = webContents.fromId(id).debugger;
    const send = debuggerApi.sendCommand.bind(debuggerApi);
    globalThis.__actionInputs = [];
    debuggerApi.sendCommand = (method, params) => {
      if (['DOM.focus', 'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent'].includes(method))
        globalThis.__actionInputs.push({ method, type: params?.type, key: params?.key });
      return send(method, params);
    };
  }, nativeId);
  await app.evaluate((_electron, { modulePath, capacityMode }) => {
    const { CorePreview } = process.getBuiltinModule('module').createRequire(modulePath)(modulePath);
    const execute = CorePreview.prototype.execute, target = CorePreview.prototype.actionTarget;
    const prepare = CorePreview.prototype.prepare;
    CorePreview.prototype.prepare = async function(request) {
      const original = await prepare.call(this, request);
      if (!globalThis.__planBudgetOnce) return original;
      globalThis.__planBudgetOnce = false;
      const page = this.page(request.projectId, request.threadId, request.pageId);
      const facts = () => ({ plans: page.plans.size, outstanding: this.workspaceOutstanding(request.projectId, request.threadId),
        activeRead: !!page.activeRead, activePrepare: !!page.activePrepare, activeAction: !!page.activeAction,
        pageGeneration: page.pageGeneration, documentEpoch: page.documentGeneration, controlEpoch: page.controlEpoch });
      const first = facts(), samples = [first];
      const limit = capacityMode === 'batch' ? 15 : 16;
      for (let index = 1; index < limit; index++) {
        const result = await prepare.call(this, { ...request, requestId: request.requestId + 100000 + index,
          callId: request.callId + '-main-budget-' + index });
        samples.push({ ...facts(), preparedActionId: result.plan.preparedActionId });
      }
      const beforeExtra = facts(), started = Date.now();
      const extra = await prepare.call(this, { ...request, requestId: request.requestId + 200000,
        callId: request.callId + '-main-budget-extra', ...(capacityMode === 'batch' ? { operation: 'runBatch',
          parameters: { pageId: request.pageId, snapshotId: request.parameters.snapshotId, steps: [{ operation: 'act', snapshotId: request.parameters.snapshotId, action: request.parameters.action }], timeoutMs: 2000 } } : {}) }).then(() => ({ accepted: true }),
        error => ({ accepted: false, error: error.message }));
      globalThis.__planBudgetManager = this;
      globalThis.__planBudgetRequest = request;
      globalThis.__planBudgetFacts = { capacityMode, first, samples, beforeExtra, extra, afterExtra: facts(), elapsedMs: Date.now() - started,
        boundary: 'Original Core plan unchanged; fifteen additional real Main prepares are admission probes and do not fabricate Core approval/history.' };
      return original;
    };
    CorePreview.prototype.execute = async function(request) {
      const moving = globalThis.__unstableActionOnce === true && request.operation === 'act';
      if (!moving) return execute.call(this, request);
      globalThis.__unstableActionOnce = false; globalThis.__unstableActionActive = true;
      try { return await execute.call(this, request); }
      finally { globalThis.__unstableActionActive = false; }
    };
    CorePreview.prototype.actionTarget = async function(...args) {
      const result = await target.apply(this, args);
      if (globalThis.__unstableActionActive) {
        globalThis.__actionTargetReadPositions.push({ x: result.x, y: result.y, backendNodeId: result.backendNodeId });
        // 两次真实目标采样之间移动页面元素；保留原始读取结果。
        if (globalThis.__actionTargetReadPositions.length === 1)
          await args[1].executeJavaScript(`document.querySelector('#submit').style.transform='translateX(24px)'`);
      }
      return result;
    };
  }, { modulePath: join(gui, 'app/src/core/preview.cjs'), capacityMode });
  let completedTurns = 0;
  async function scenario(next, choice = null) {
    mode = next;
    modelStage = 0;
    console.error(`browser-actions: ${next} starting`);
    if (completedTurns > 0) await command('send', { projectId, threadId, text: `Check ${next} action` });
    if (choice) {
      const panel = page.locator('[data-interaction="approval"]');
      await panel.waitFor({ timeout: 60000 });
      assert.match(await panel.innerText(), /Submit action|Draft/);
      if (next === 'stale') await app.evaluate(({ webContents }, id) =>
        webContents.fromId(id).executeJavaScript(`{const old=document.querySelector('#submit');old.replaceWith(old.cloneNode(true))}`), nativeId);
      if (next === 'hidden' || next === 'covered') await app.evaluate(({ webContents }, { id, next }) =>
        webContents.fromId(id).executeJavaScript(next === 'hidden'
          ? `document.querySelector('#submit').style.display='none'`
          : `(()=>{const r=document.querySelector('#submit').getBoundingClientRect(), cover=document.createElement('div');
            cover.id='fixture-cover';cover.style.cssText='position:fixed;z-index:999999;background:#ccc';
            Object.assign(cover.style,{left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px'});
            document.body.append(cover)})()`), { id: nativeId, next });
      if (next === 'unstable') await app.evaluate(() => { globalThis.__unstableActionOnce = true; globalThis.__actionTargetReadPositions = []; });
      await panel.getByRole('button', { name: choice }).click();
    }
    const turn = await terminalTurn(completedTurns);
    completedTurns++;
    const item = toolResult(turn);
    events[next] = { turnId: turn.id, status: turn.status, item, posts: siteFacts.posts, native: await nativeFacts() };
    console.error(`browser-actions: ${next} completed`);
    return item;
  }
  const denied = await scenario('deny', '拒绝');
  assert.equal(siteFacts.posts, 0);
  assert.equal(denied.success, false);
  checks.push('B-10: denied real Core approval sends zero native site effects');
  const allowed = await scenario('allow', '允许一次');
  assert.equal(allowed.success, true);
  await until(() => siteFacts.posts === 1, 'one native click site effect');
  assert.equal((await nativeFacts()).submitPresent, true);
  checks.push('B-10: approved Core plan executes one actual native click');
  const stale = await scenario('stale', '允许一次');
  assert.equal(stale.success, false);
  assert.match(JSON.stringify(stale.contentItems), /plan_stale|stale_ref|not_sent/);
  assert.equal(siteFacts.posts, 1);
  checks.push('B-11: replaced same-label target after plan preparation sends zero additional effects');
  const disabled = await scenario('disabled');
  assert.equal(disabled.success, false);
  assert.match(JSON.stringify(disabled.contentItems), /not_sent|target_unavailable/);
  assert.equal(siteFacts.posts, 1);
  checks.push('B-13: disabled target fails before dispatch');
  const forged = await scenario('forged');
  assert.equal(forged.success, false);
  assert.equal(siteFacts.posts, 1);
  checks.push('B-12: model-supplied approval field cannot authorize action');
  for (const next of ['hidden', 'covered', 'unstable']) {
    await app.evaluate(() => { globalThis.__actionInputs = []; });
    const refused = await scenario(next, '允许一次');
    assert.equal(refused.success, false);
    assert.match(JSON.stringify(refused.contentItems), /not_sent|target_unavailable|plan_stale/);
    assert.equal(siteFacts.posts, 1);
    const inputs = await app.evaluate(() => globalThis.__actionInputs);
    assert.equal(inputs.length, 0, `${next} fails before input dispatch`);
    if (next === 'unstable') {
      const samples = await app.evaluate(() => globalThis.__actionTargetReadPositions);
      assert.equal(samples.length, 2);
      assert.equal(samples[0].backendNodeId, samples[1].backendNodeId);
      assert.equal(samples[1].x - samples[0].x, 24);
      events[next].samples = samples;
    }
    events[next].inputTrace = inputs;
    await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript(
      `document.querySelector('#submit').style.cssText='';document.querySelector('#fixture-cover')?.remove()`), nativeId);
    checks.push(`B-13: approved ${next} target is refused by actual Native actionability checks with zero input or additional POST`);
  }
  const filled = await scenario('fill', '允许一次');
  assert.equal(filled.success, true);
  assert.equal((await nativeFacts()).draft, 'DRAFT_INPUT_04');
  assert.equal(siteFacts.posts, 1);
  const pressed = await scenario('press', '允许一次');
  assert.equal(pressed.success, true);
  await until(() => siteFacts.posts === 2, 'Enter submits the synthetic form once', 3000);
  checks.push('B-13: approved fill and key input change native form state and produce one independent submit');
  for (const [next, key, expectedPosts] of [['pressButton', 'Enter', 3], ['pressTab', 'Tab', 3]]) {
    const before = await nativeFacts();
    await app.evaluate(() => { globalThis.__actionInputs = []; });
    const result = await scenario(next, '允许一次');
    assert.equal(result.success, true);
    if (next === 'pressButton') await until(() => siteFacts.posts === expectedPosts, 'button Enter submits once', 3000);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(siteFacts.posts, expectedPosts, `${key} introduces no implicit button click`);
    const after = await nativeFacts();
    const trace = await app.evaluate(() => globalThis.__actionInputs);
    assert.equal(trace.filter(item => item.method === 'DOM.focus').length, 1);
    assert.equal(trace.filter(item => item.method === 'Input.dispatchMouseEvent').length, 0);
    assert.deepEqual(trace.filter(item => item.method === 'Input.dispatchKeyEvent').map(item => [item.type, item.key]),
      [['keyDown', key], ['keyUp', key]]);
    assert.deepEqual(after.keyFacts.downs.slice(before.keyFacts.downs.length), [{ key, target: 'submit' }]);
    if (next === 'pressTab') assert.equal(after.activeElement, 'draft');
    events[next].inputTrace = trace;
    checks.push(`B-13: Ref ${key} focuses the actual button and dispatches only the approved key; site effects=${expectedPosts}`);
  }
  await page.evaluate(({ projectId, threadId, pageId }) => window.arealDesktop.preview({ operation: 'takeover', projectId, threadId, pageId }), { projectId, threadId, pageId });
  await until(async () => (await page.evaluate(({ projectId, threadId }) => window.arealDesktop.preview({ operation: 'state', projectId, threadId }), { projectId, threadId })).browser.control === 'human', 'plan-budget Human convergence');
  await page.evaluate(({ projectId, threadId, pageId }) => window.arealDesktop.preview({ operation: 'claim', projectId, threadId, pageId }), { projectId, threadId, pageId });
  await app.evaluate(() => { globalThis.__planBudgetOnce = true; globalThis.__actionInputs = []; });
  const capacity = await scenario('capacity', '拒绝');
  assert.equal(capacity.success, false);
  const budget = await app.evaluate(() => globalThis.__planBudgetFacts);
  events.capacity.budget = budget;
  assert.equal(budget.first.plans, 1);
  const limit = capacityMode === 'batch' ? 15 : 16;
  assert.deepEqual(budget.samples.map(row => row.plans), Array.from({ length: limit }, (_, index) => index + 1));
  assert.equal(budget.beforeExtra.outstanding, limit);
  assert.equal(budget.beforeExtra.activeRead || budget.beforeExtra.activePrepare || budget.beforeExtra.activeAction, false);
  assert.equal(budget.extra.accepted, false); assert.match(budget.extra.error, /not_sent/);
  assert.equal(budget.afterExtra.plans, limit); assert.equal(budget.afterExtra.outstanding, limit);
  for (const field of ['pageGeneration', 'documentEpoch', 'controlEpoch'])
    assert.equal(budget.first[field], budget.afterExtra[field]);
  assert.ok(budget.elapsedMs < 1000);
  assert.equal(siteFacts.posts, 3); assert.equal((await app.evaluate(() => globalThis.__actionInputs)).length, 0);
  await page.evaluate(({ projectId, threadId, pageId }) => window.arealDesktop.preview({ operation: 'takeover', projectId, threadId, pageId }), { projectId, threadId, pageId });
  await until(async () => (await page.evaluate(({ projectId, threadId }) => window.arealDesktop.preview({ operation: 'state', projectId, threadId }), { projectId, threadId })).browser.control === 'human', 'budget plans cleared by takeover');
  const cleared = await app.evaluate(() => {
    const request = globalThis.__planBudgetRequest, manager = globalThis.__planBudgetManager;
    return { plans: manager.page(request.projectId, request.threadId, request.pageId).plans.size,
      outstanding: manager.workspaceOutstanding(request.projectId, request.threadId) };
  });
  assert.equal(cleared.plans, 0); assert.equal(cleared.outstanding, 0);
  events.capacity.budget = budget; events.capacity.cleared = cleared;
  checks.push(`09c5 Main ${capacityMode}: actual prepared plans exhaust the workspace budget including the outer batch plan; extra original Main prepare is promptly refused without input, epoch drift or Core history fabrication; takeover clears all plans`);
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  errors.push(error.stack ?? String(error));
  if (page) await captureSmokeFailure(page, scratch, error);
  throw error;
} finally {
  if (app) await app.close();
  site.closeAllConnections(); model.closeAllConnections();
  await Promise.all([new Promise(resolve => site.close(resolve)), new Promise(resolve => model.close(resolve))]);
  const files = ['app/src/core/browser-tool.cjs', 'app/src/core/preview.cjs', 'app/src/core/service-protocol.cjs',
    'renderer/src/ApprovalRequest.tsx', 'scripts/browser-actions-smoke.mjs'];
  const hashes = Object.fromEntries(await Promise.all(files.map(async file =>
    [file, createHash('sha256').update(await readFile(join(gui, file))).digest('hex')])));
  await writeFile(join(scratch, 'run-manifest.json'), JSON.stringify({ passed, checks, errors, events, modelCalls,
    startedAt, endedAt: new Date().toISOString(), sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    diffSHA256: createHash('sha256').update(execFileSync('git', ['diff', 'HEAD'], { cwd: root })).digest('hex'),
    hashes, coreBinary: env.AREAL_CORE_BIN,
    coreBinarySHA256: createHash('sha256').update(await readFile(env.AREAL_CORE_BIN)).digest('hex'),
    runtime: events.runtime, entrypoint: 'node clients/gui/scripts/browser-actions-smoke.mjs',
    scope: 'source Electron + independent adapter + Core/Runtime + deterministic loopback model + synthetic site; OS chooser stubbed' }, null, 2));
  console.log(JSON.stringify({ passed, evidence: scratch, checks, errors }));
}
