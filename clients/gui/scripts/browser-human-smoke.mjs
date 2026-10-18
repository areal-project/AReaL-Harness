import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { selectConversation, captureSmokeFailure } from './smoke-navigation.mjs';

// B-14–B-16: a local takeover fence and a lost native input receipt on one real Core turn.
const faultMode = process.argv[2] ?? 'full';
assert.ok(['full', 'nonconverging', 'longwait', 'lateObserve', 'staleOnly', 'offline', 'condition'].includes(faultMode), 'known M1 takeover mode');
const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(gui, '../..');
const require = createRequire(join(gui, 'app/package.json'));
const { _electron: electron } = require('playwright-core');
const scratch = await mkdtemp('/private/tmp/areal-browser-human-');
const workspace = join(scratch, 'workspace'), userHome = join(scratch, 'user');
await mkdir(workspace); await mkdir(join(userHome, '.areal'), { recursive: true });
execFileSync('git', ['init', '-b', 'main'], { cwd: workspace, stdio: 'ignore' });
const siteFacts = { posts: 0, documentGets: 0, cookieOnGets: [], getRequests: [], redirects: 0,
  forbiddenRequests: 0 };
const forbidden = createServer((_request, response) => { siteFacts.forbiddenRequests++; response.end('forbidden target reached'); });
await new Promise(resolve => forbidden.listen(0, '127.0.0.1', resolve));
const forbiddenUrl = `http://127.0.0.1:${forbidden.address().port}/target`;
const site = createServer(async (request, response) => {
  if (request.url === '/redirect') {
    siteFacts.redirects++;
    response.writeHead(302, { Location: forbiddenUrl }); response.end(); return;
  }
  if (request.method === 'POST') {
    siteFacts.posts++;
    for await (const _chunk of request) { /* never retain the synthetic body */ }
    response.end('ok');
    return;
  }
  if (request.url.startsWith('/?')) {
    siteFacts.documentGets++;
    siteFacts.cookieOnGets.push(request.headers.cookie?.includes('m1_session=synthetic_05') ?? false);
    siteFacts.getRequests.push({ url: request.url, cookie: siteFacts.cookieOnGets.at(-1) });
  }
  response.setHeader('Set-Cookie', 'm1_session=synthetic_05; HttpOnly; SameSite=Lax');
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><title>Human boundary fixture</title>
    <h1>HUMAN_BOUNDARY_05</h1>
    <button id="effect" onclick="fetch('/effect',{method:'POST'})">Submit once</button>
    <label>Password <input id="password" type="password"></label>
    <label>Hold key <input id="key-target"></label>
    <script>window.keyFacts={downs:[],ups:[]};
    document.addEventListener('keydown',event=>window.keyFacts.downs.push(event.key));
    document.addEventListener('keyup',event=>window.keyFacts.ups.push(event.key));</script>`);
});
await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
const siteUrl = `http://127.0.0.1:${site.address().port}/?token=SYNTHETIC_URL_05`;
const secondUrl = `http://127.0.0.1:${site.address().port}/?token=SECOND_WORKSPACE_05`;
const secret = 'SYNTHETIC_LOGIN_SECRET_05';
let pageId, snapshotId, targetRef, phase = 'initial', issued = false, waitParameters;
const modelCalls = [];
async function until(predicate, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error(`Timeout: ${label}`);
}
const model = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw), last = body.messages.at(-1);
  modelCalls.push({ phase, lastRole: last?.role, browserToolAvailable: (body.tools ?? []).some(tool => tool.function?.name === 'browser_v1') });
  await until(() => pageId, 'claimed page');
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (!issued) {
    issued = true;
    const args = ['click', 'keyPress', 'staleAfterCrash'].includes(phase)
      ? { operation: 'act', parameters: { pageId, snapshotId,
        action: phase === 'keyPress' ? { kind: 'press', ref: targetRef, key: 'Enter' } : { kind: 'click', ref: targetRef } } }
      : phase === 'humanCapture'
        ? { operation: 'capture', parameters: { pageId, scope: 'viewport' } }
        : phase === 'humanDiagnostics'
          ? { operation: 'diagnostics', parameters: { pageId, kind: 'console', limit: 20 } }
          : phase === 'boundedDiagnostics'
            ? { operation: 'diagnostics', parameters: { pageId, kind: 'console', cursor: 0, limit: 20 } }
          : phase.startsWith('condition') ? { operation: 'wait', parameters: { pageId, ...waitParameters } }
          : phase === 'longWait' ? { operation: 'wait', parameters: { pageId, timeoutMs: 20000 } }
          : { operation: 'observe', parameters: { pageId } };
    send({ tool_calls: [{ index: 0, id: `human-${phase}`, type: 'function',
      function: { name: 'browser_v1', arguments: JSON.stringify(args) } }] });
    send({}, 'tool_calls');
  } else { send({ content: `Fixture completed ${phase}` }); send({}, 'stop'); }
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
const startedAt = new Date().toISOString(), events = {}, checks = [], errors = [];
let app, page, passed = false, projectId, threadId, nativeId, pausedHostPid = null;
async function snapshot() { return page.evaluate(() => window.arealDesktop.snapshot()); }
async function command(name, params) {
  const result = await page.evaluate(({ name, params }) => window.arealDesktop.command(name, params), { name, params });
  assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
}
async function thread() { return (await snapshot()).projects.find(item => item.id === projectId)?.state?.threads?.[threadId]; }
async function terminalTurn(previous) {
  return until(async () => {
    const turns = (await thread())?.turns ?? [], last = turns.at(-1);
    return turns.length > previous && ['completed', 'failed', 'interrupted'].includes(last?.status) ? last : null;
  }, `terminal ${phase} turn`);
}
function browserItem(turn) {
  const item = turn.items.find(item => item.type === 'dynamicToolCall' && item.tool === 'browser_v1');
  assert.ok(item, `Core history includes browser_v1 for ${phase}`);
  return item;
}
async function controlState() {
  return page.evaluate(({ projectId, threadId }) => window.arealDesktop.preview({ operation: 'state', projectId, threadId }),
    { projectId, threadId });
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
  await page.keyboard.press('Meta+t'); await page.locator('.preview-panel').waitFor();
  await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0].focus(); });
  await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()), 'focused Main Origin prompt');
  await page.evaluate(({ projectId, threadId, url }) => window.arealDesktop.preview({ operation: 'navigate', projectId, threadId, url }),
    { projectId, threadId, url: siteUrl });
  events.developmentOriginPrompt = await app.evaluate(() => globalThis.__m1OriginPrompt);
  assert.equal(events.developmentOriginPrompt?.count, 1, 'exact-Origin Main prompt occurred once');
  events.developmentOriginPrompt.response = 'fixture-stub-allow-exact-origin';
  nativeId = await until(() => app.evaluate(({ webContents }, url) =>
    webContents.getAllWebContents().find(item => item.getURL() === url)?.id, siteUrl), 'native page');
  await page.getByRole('button', { name: '让 Agent 检查当前页' }).click();
  pageId = (await until(async () => {
    const value = await controlState(); return value.browser?.control === 'agent' ? value : null;
  }, 'initial claim')).browser.pageId;
  const initial = browserItem(await terminalTurn(0));
  const observed = JSON.parse(initial.contentItems[0].text);
  snapshotId = observed.observationId;
  targetRef = observed.nodes.find(node => node.name === 'Submit once' && node.ref)?.ref;
  assert.match(targetRef, /^r\d+$/);
  events.initial = { pageId, nativeId, snapshotId, targetRef, controlEpoch: observed.controlEpoch, postCount: siteFacts.posts };

  if (faultMode === 'offline') {
    const serviceDirs=await readdir(join(scratch,'registry','services'));
    assert.equal(serviceDirs.length,1,'one isolated Core service for this fixture');
    const service=JSON.parse(await readFile(join(scratch,'registry','services',serviceDirs[0],'service.json'),'utf8'));
    assert.equal(service.workspace,workspace);
    const hostPid=service.hostPid;
    assert.ok(Number.isSafeInteger(hostPid) && hostPid>0);
    const hostCommand=execFileSync('/bin/ps',['-p',String(hostPid),'-o','command='],{encoding:'utf8'}).trim();
    assert.equal(hostCommand,`${env.AREAL_CORE_BIN} service-host`);
    const coreRow=execFileSync('/bin/ps',['-p',String(service.corePid),'-o','ppid=,command='],{encoding:'utf8'}).trim();
    const coreMatch=coreRow.match(/^(\d+)\s+(.+)$/);
    assert.ok(coreMatch && coreMatch[2].startsWith(`${env.AREAL_CORE_BIN} app-server `)
      && coreMatch[2].includes(`--workspace ${workspace}`));
    const launcherRow=execFileSync('/bin/ps',['-p',coreMatch[1],'-o','ppid=,command='],{encoding:'utf8'}).trim();
    const launcherMatch=launcherRow.match(/^(\d+)\s+(.+)$/);
    assert.ok(launcherMatch && Number(launcherMatch[1])===hostPid
      && launcherMatch[2].startsWith(`${env.AREAL_CORE_BIN} launcher `)
      && launcherMatch[2].includes(join(scratch,'core')),
    'Core launcher belongs to this exact fixture scratch and service host');
    const before={control:(await controlState()).browser?.control,
      nativeExists:await app.evaluate(({webContents},id)=>!!webContents.fromId(id),nativeId),posts:siteFacts.posts};
    assert.equal(before.control,'agent');
    process.kill(hostPid,'SIGSTOP'); pausedHostPid=hostPid;
    await new Promise(resolve=>setTimeout(resolve,250));
    const started=Date.now();
    const takeover=await page.evaluate(({projectId,threadId,pageId})=>
      window.arealDesktop.preview({operation:'takeover',projectId,threadId,pageId}),
      {projectId,threadId,pageId});
    const elapsedMs=Date.now()-started;
    const during={control:takeover.browser?.control,
      nativeExists:await app.evaluate(({webContents},id)=>!!webContents.fromId(id),nativeId),
      posts:siteFacts.posts};
    const converged=await until(async()=>{
      const value=await controlState();
      return value.browser?.control==='human'
        ? value.workspace.pages.find(item=>item.pageId===pageId) : null;
    },'local human convergence while task Core is stopped',5000);
    const nativeInput=await app.evaluate(({webContents},id)=>
      webContents.fromId(id).executeJavaScript('window.keyFacts'),nativeId);
    events.coreUnavailable={hostPidVerified:true,before,during,elapsedMs,
      converged:{control:converged.control,controlEpoch:converged.controlEpoch},nativeInput,
      fault:'SIGSTOP exact task-owned Core service-host; adapter/Electron remain live'};
    assert.ok(elapsedMs<2000,'local takeover must not wait for suspended Core RPC');
    assert.ok(['transferring','human'].includes(during.control));
    assert.equal(converged.control,'human');
    assert.ok(converged.controlEpoch>observed.controlEpoch);
    assert.equal(during.nativeExists,true);
    assert.equal(during.posts,0);
    assert.deepEqual(nativeInput,{downs:[],ups:[]});
    checks.push('B-14: exact task Core service unavailable does not block local Native takeover or dispatch input');
    process.kill(hostPid,'SIGCONT'); pausedHostPid=null;
  } else if (faultMode === 'staleOnly') {
    const oldSnapshotId = snapshotId, oldTargetRef = targetRef;
    const original = (await controlState()).workspace.pages.find(item => item.pageId === pageId);
    await app.evaluate(({ webContents }, id) => webContents.fromId(id).forcefullyCrashRenderer(), nativeId);
    await until(async () => (await controlState()).workspace.pages.find(item =>
      item.pageId === pageId && item.resource === 'crashed'), 'stale-only Native crash');
    await page.evaluate(({ projectId, threadId, pageId }) =>
      window.arealDesktop.preview({ operation: 'reload', projectId, threadId, pageId }),
      { projectId, threadId, pageId });
    const replacement = await until(async () => (await controlState()).workspace.pages.find(item =>
      item.pageId === pageId && item.resource === 'ready' && item.pageGeneration > original.pageGeneration),
    'stale-only replacement Native generation');
    await until(async () => (await controlState()).browser?.pageId === pageId,
      'stale-only selected replacement Page');
    phase = 'postCrashObserve'; issued = false;
    await page.getByRole('button', { name: '让 Agent 检查当前页' }).click();
    await until(async () => (await controlState()).browser?.control === 'agent', 'stale-only replacement claim');
    const fresh = browserItem(await terminalTurn(1));
    assert.equal(fresh.success, true);
    assert.equal(JSON.parse(fresh.contentItems[0].text).pageGeneration, replacement.pageGeneration);
    snapshotId = oldSnapshotId; targetRef = oldTargetRef;
    phase = 'staleAfterCrash'; issued = false;
    await command('send', { projectId, threadId, text: 'Try the pre-crash Ref on the replacement page' });
    const stale = browserItem(await terminalTurn(2));
    events.staleAfterCrash = { item: stale, beforeGeneration: original.pageGeneration,
      afterGeneration: replacement.pageGeneration, posts: siteFacts.posts };
    assert.equal(stale.success, false);
    assert.match(JSON.stringify(stale), /stale_ref|plan_stale/);
    assert.equal(siteFacts.posts, 0);
    checks.push('B-25: old Ref fails with stale identity on a replacement Native generation before input');
  } else if (faultMode === 'nonconverging') {
    phase = 'click'; issued = false;
    await command('send', { projectId, threadId, text: 'Click Submit once' });
    const approval = page.locator('[data-interaction="approval"]');
    await approval.waitFor({ timeout: 60000 });
    await app.evaluate(({ webContents }, id) => {
      const c = webContents.fromId(id), original = c.debugger.sendCommand.bind(c.debugger);
      c.debugger.sendCommand = (method, params) => {
        const sent = original(method, params);
        if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased' && !c.__m1HeldReceipt) {
          c.__m1HeldReceipt = true;
          return sent.then(() => new Promise(() => {}));
        }
        return sent;
      };
    }, nativeId);
    await approval.getByRole('button', { name: '允许一次' }).click();
    await until(() => siteFacts.posts === 1, 'one synthetic server effect');
    const beforeTakeover = Date.now();
    const takeover = await page.evaluate(({ projectId, threadId, pageId }) =>
      window.arealDesktop.preview({ operation: 'takeover', projectId, threadId, pageId }), { projectId, threadId, pageId });
    events.takeover = { elapsedMs: Date.now() - beforeTakeover, control: takeover.browser.control, posts: siteFacts.posts };
    assert.ok(events.takeover.elapsedMs < 2000);
    assert.equal(takeover.browser.control, 'transferring');
    await new Promise(resolve => setTimeout(resolve, 2800));
    const still = await controlState();
    events.stalled = { control: still.browser.control, transferError: still.browser.transferError, posts: siteFacts.posts };
    assert.equal(still.browser.control, 'transferring');
    assert.equal(siteFacts.posts, 1);
    events.stalled.guiHasSafetyAction = /停止|关闭/.test(await page.locator('.preview-panel').innerText());
    assert.ok(events.stalled.guiHasSafetyAction);
    checks.push('B-14: lost native receipt fences locally and stays transferring; GUI offers Stop/Close');
    await page.evaluate(({ projectId, threadId, pageId }) =>
      window.arealDesktop.preview({ operation: 'release', projectId, threadId, pageId, userIntent: true }),
      { projectId, threadId, pageId });
    await until(() => app.evaluate(({ webContents }, id) => !webContents.fromId(id), nativeId), 'closed native page');
    assert.equal(siteFacts.posts, 1);
    events.closed = { nativeGone: true, posts: siteFacts.posts };
    checks.push('B-14: explicit Close releases nonconverging Native view without a second effect');
  } else if (faultMode === 'condition') {
    await app.evaluate(({ webContents }, id) => {
      const c = webContents.fromId(id), forward = c.debugger.sendCommand.bind(c.debugger);
      globalThis.__m1WaitReads = []; globalThis.__m1WaitStimulus = null;
      c.debugger.sendCommand = async (method, params) => {
        if (method === 'Accessibility.getPartialAXTree' && params.fetchRelatives === false) {
          globalThis.__m1WaitReads.push({ at: Date.now(), backendNodeId: params.backendNodeId });
          const stimulus = globalThis.__m1WaitStimulus; globalThis.__m1WaitStimulus = null;
          if (stimulus) await c.executeJavaScript(stimulus);
        }
        return forward(method, params);
      };
    }, nativeId);
    events.waitCases = [];
    async function waitCase(name, condition, timeoutMs, stimulus, expectedError = null) {
      phase = name; issued = false; waitParameters = { condition, timeoutMs };
      const previous = (await thread()).turns.length;
      await app.evaluate((_electron, stimulus) => { globalThis.__m1WaitStimulus = stimulus; }, stimulus);
      await command('send', { projectId, threadId, text: `Wait for ${JSON.stringify(condition)}` });
      const approval = page.locator('[data-interaction="approval"]');
      await approval.waitFor(); assert.ok((await approval.innerText()).includes(condition.kind), 'GUI exposes the exact condition');
      await approval.getByRole('button', { name: '允许一次' }).click();
      const item = browserItem(await terminalTurn(previous));
      const proof = { name, callId: item.callId, success: item.success,
        condition, timeoutMs, contentItems: item.contentItems, structuredContent: item.structuredContent };
      events.waitCases.push(proof);
      if (expectedError) { assert.equal(item.success, false); assert.match(JSON.stringify(item), expectedError); }
      else { assert.equal(item.success, true); const result=JSON.parse(item.contentItems[0].text);
        assert.equal(result.wait.satisfied, true); assert.deepEqual(result.wait.condition, condition);
        assert.equal(result.inputConfirmed, false); assert.equal(result.dispatch, 'not_sent');
        if(name==='conditionName') assert.ok(result.wait.elapsedMs>=500 && result.wait.elapsedMs<4000, 'known state ends before the maximum delay'); }
      assert.equal(siteFacts.posts, 0, 'waiting never sends page input or business effects');
    }
    await waitCase('conditionReady', {kind:'documentReady',state:'complete'}, 4000, null);
    checks.push('B-10 wait: exact Core-approved document readiness returns a matched receipt without input');
    await waitCase('conditionName', {kind:'accessibleName',ref:targetRef,name:'Ready after native state change'}, 4000,
      `setTimeout(()=>document.getElementById('effect').textContent='Ready after native state change',700)`);
    checks.push('B-10 wait: real Native AX polling observes a delayed exact name on the original Ref');
    await waitCase('conditionTimeout', {kind:'accessibleName',ref:targetRef,name:'Never reached'}, 400, null, /condition_timeout/);
    checks.push('B-10 wait: unmet condition returns an explicit bounded timeout and no false readiness');
    await waitCase('conditionStale', {kind:'accessibleName',ref:targetRef,name:'Ready after native state change'}, 4000,
      `document.getElementById('effect').replaceWith(document.getElementById('effect').cloneNode(true))`, /stale_ref|plan_stale/);
    checks.push('B-10 wait: same-name replacement cannot satisfy the old Ref or receive input');
    phase='freshAfterReplacement';issued=false;
    const beforeFresh=(await thread()).turns.length;
    await command('send',{projectId,threadId,text:'Observe the current replacement before a new condition wait'});
    const fresh=JSON.parse(browserItem(await terminalTurn(beforeFresh)).contentItems[0].text);
    targetRef=fresh.nodes.find(node=>node.name==='Ready after native state change' && node.ref)?.ref;
    assert.match(targetRef,/^r[1-9]\d*$/);
    phase='conditionTakeover';issued=false;
    waitParameters={condition:{kind:'accessibleName',ref:targetRef,name:'Never reached during takeover'},timeoutMs:20000};
    const previous=(await thread()).turns.length;
    const readCount=await app.evaluate(()=>globalThis.__m1WaitReads.length);
    await command('send',{projectId,threadId,text:'Wait for the exact condition, then interrupt it by local Human takeover'});
    const approval=page.locator('[data-interaction="approval"]');await approval.waitFor();
    await approval.getByRole('button',{name:'允许一次'}).click();
    await until(()=>app.evaluate((_electron,n)=>globalThis.__m1WaitReads.length>n,readCount),'real active Native condition polling');
    const started=Date.now();
    const taken=await page.evaluate(({projectId,threadId,pageId})=>window.arealDesktop.preview({operation:'takeover',projectId,threadId,pageId}),{projectId,threadId,pageId});
    assert.ok(Date.now()-started<2000,'local takeover does not wait for condition timeout');
    await until(async()=>(await controlState()).browser?.control==='human','Human control after condition wait');
    const fencedReads=await app.evaluate(()=>globalThis.__m1WaitReads.length);
    await new Promise(resolve=>setTimeout(resolve,600));
    assert.equal(await app.evaluate(()=>globalThis.__m1WaitReads.length),fencedReads,'no AX condition poll is sent after the local fence');
    const stopped=browserItem(await terminalTurn(previous));assert.equal(stopped.execution.outcome,'unknown');
    assert.equal(siteFacts.posts,0);
    const inspection='Inspected the actual Core conditional wait, its Native AX call counts and local Human fence. Polling stopped; no input or site POST occurred. Historical wait remains UNKNOWN and is not replayed.';
    await command('manage',{projectId,threadId,operation:'toolAcknowledge',itemId:stopped.id,inspection});
    assert.equal((await thread()).turns.flatMap(turn=>turn.items).find(item=>item.id===stopped.id).execution.outcome,'unknown');
    phase='conditionOldEpoch';issued=false;
    const previousDenied=(await thread()).turns.length;
    await command('send',{projectId,threadId,text:'Attempt the old condition Ref while Human still owns the Page'});
    const denied=browserItem(await terminalTurn(previousDenied));assert.equal(denied.success,false);
    assert.match(JSON.stringify(denied),/human_control|host_unavailable/);
    assert.equal(await app.evaluate(()=>globalThis.__m1WaitReads.length),fencedReads,'old epoch cannot restart polling');
    assert.equal(siteFacts.posts,0);
    events.conditionTakeover={elapsedMs:Date.now()-started,immediateControl:taken.browser.control,
      fencedReads,waitItemId:stopped.id,unknownPreserved:true,inspection,deniedCallId:denied.callId,posts:0};
    checks.push('B-14 condition wait: actual Native AX polling stops on local Human takeover; old epoch cannot read or replay; historical UNKNOWN preserved');
    events.nativeWaitReads=await app.evaluate(()=>globalThis.__m1WaitReads);
    assert.ok(events.nativeWaitReads.length>=4, 'condition matching uses actual native backend identities');
  } else if (faultMode === 'longwait') {
    phase = 'longWait'; issued = false;
    const beforeSend = Date.now();
    await command('send', { projectId, threadId, text: 'Wait for a synthetic condition for twenty seconds' });
    const approval = page.locator('[data-interaction="approval"]');
    await approval.waitFor({ timeout: 60000 });
    assert.match(await approval.innerText(), /wait/);
    await approval.getByRole('button', { name: '允许一次' }).click();
    await approval.waitFor({ state: 'hidden', timeout: 15000 });
    await new Promise(resolve => setTimeout(resolve, 500));
    const inProgress = (await thread())?.turns?.at(-1);
    assert.equal(inProgress?.status, 'inProgress', 'approved Core wait is active');
    events.beforeTakeover = { status: inProgress.status, elapsedMs: Date.now() - beforeSend,
      approvalVisible: await approval.isVisible(), posts: siteFacts.posts };
    const beforeTakeover = Date.now();
    const takeover = await page.evaluate(({ projectId, threadId, pageId }) =>
      window.arealDesktop.preview({ operation: 'takeover', projectId, threadId, pageId }), { projectId, threadId, pageId });
    events.takeover = { elapsedMs: Date.now() - beforeTakeover, immediateControl: takeover.browser.control };
    assert.ok(events.takeover.elapsedMs < 2000, 'takeover must not wait for long Core turn');
    await until(async () => (await controlState()).browser?.control === 'human', 'local convergence');
    const turn = await terminalTurn(1);
    const item = turn.items.find(item => item.type === 'dynamicToolCall' && item.tool === 'browser_v1');
    events.afterTakeover = { turnStatus: turn.status, item: item ?? null, posts: siteFacts.posts,
      totalElapsedMs: Date.now() - beforeSend };
    assert.equal(siteFacts.posts, 0);
    assert.ok(events.afterTakeover.totalElapsedMs < 18000, 'Core wait cancelled before its 20 second deadline');
    checks.push('B-14: local takeover during Core long wait converges without waiting for its deadline or dispatching page input');
  } else if (faultMode === 'lateObserve') {
    phase = 'lateObserve'; issued = false;
    await app.evaluate(({ webContents }, id) => {
      const c = webContents.fromId(id), original = c.debugger.sendCommand.bind(c.debugger);
      c.__m1OriginalAXSend = original;
      c.__m1AXState = { release: null };
      c.debugger.sendCommand = (method, params) => {
        if (method !== 'Accessibility.getFullAXTree') return original(method, params);
        return original(method, params).then(value =>
          new Promise(resolve => { c.__m1AXState.release = () => resolve(value); }));
      };
    }, nativeId);
    await command('send', { projectId, threadId, text: 'Observe this page while Native AX reply is delayed' });
    await until(() => app.evaluate(({ webContents }, id) =>
      !!webContents.fromId(id)?.__m1AXState?.release, nativeId), 'held Native AX reply');
    const beforeTakeover = Date.now();
    const takeover = await page.evaluate(({ projectId, threadId, pageId }) =>
      window.arealDesktop.preview({ operation: 'takeover', projectId, threadId, pageId }),
      { projectId, threadId, pageId });
    events.takeover = { elapsedMs: Date.now() - beforeTakeover, immediateControl: takeover.browser.control };
    assert.ok(events.takeover.elapsedMs < 2000);
    assert.equal(takeover.browser.control, 'transferring');
    await app.evaluate(({ webContents }, id) => {
      const c = webContents.fromId(id);
      c.debugger.sendCommand = c.__m1OriginalAXSend;
      c.__m1AXState.release();
    }, nativeId);
    await until(async () => (await controlState()).browser?.control === 'human', 'late AX takeover convergence', 10000);
    const lateTurn = await terminalTurn(1), lateItem = browserItem(lateTurn);
    assert.equal(lateItem.success, false, 'pre-takeover observation is revoked');
    assert.ok(!lateItem.contentItems?.some(item => item.type === 'image'));
    events.lateRead = { turnId: lateTurn.id, item: lateItem, control: (await controlState()).browser.control };
    checks.push('B-15: pre-takeover Native AX reply delivered after fence cannot become a Core observation');

    await app.evaluate(({ webContents }, { id, value }) => webContents.fromId(id).executeJavaScript(
      `document.querySelector('#password').value=${JSON.stringify(value)}; console.log(${JSON.stringify(value)})`),
      { id: nativeId, value: secret });
    phase = 'humanDiagnostics'; issued = false;
    await command('send', { projectId, threadId, text: 'Try diagnostics during human control' });
    const humanTurn = await terminalTurn(2), humanItem = browserItem(humanTurn);
    assert.equal(humanItem.success, false);
    assert.ok(!JSON.stringify(humanTurn).includes(secret));
    events.humanDiagnostics = { turnId: humanTurn.id, item: humanItem };

    phase = 'after'; issued = false;
    await page.getByRole('button', { name: '交还并让 Agent 检查当前页' }).click();
    await until(async () => (await controlState()).browser?.control === 'agent', 'fresh giveback after delayed read');
    const freshTurn = await terminalTurn(3), freshItem = browserItem(freshTurn);
    assert.equal(freshItem.success, true);
    assert.ok(!JSON.stringify(freshTurn).includes(secret));
    phase = 'boundedDiagnostics'; issued = false;
    await command('send', { projectId, threadId, text: 'Read console after fresh giveback' });
    const diagnosticTurn = await terminalTurn(4), diagnosticItem = browserItem(diagnosticTurn);
    assert.equal(diagnosticItem.success, true);
    assert.ok(!JSON.stringify(diagnosticTurn).includes(secret));
    assert.ok(!JSON.stringify(modelCalls).includes(secret));
    events.postGiveback = { control: (await controlState()).browser.control,
      freshTurnId: freshTurn.id, diagnosticTurnId: diagnosticTurn.id,
      humanSecretInCore: false, humanSecretInDiagnostics: false, posts: siteFacts.posts };
    checks.push('B-15: human-only secret and diagnostics stay absent from fresh Core observation and diagnostic buffer');
    assert.equal(siteFacts.posts, 0);
  } else {
  const preCrashSnapshotId = snapshotId, preCrashTargetRef = targetRef;
  // The actual CDP release reaches the page/server, but its receipt is withheld.
  phase = 'click'; issued = false;
  await command('send', { projectId, threadId, text: 'Click Submit once' });
  const approval = page.locator('[data-interaction="approval"]');
  await approval.waitFor({ timeout: 60000 });
  assert.match(await approval.innerText(), /Submit once/);
  await app.evaluate(({ webContents }, id) => {
    const c = webContents.fromId(id), original = c.debugger.sendCommand.bind(c.debugger);
    c.__m1OriginalSend = original;
    c.debugger.sendCommand = (method, params) => {
      const sent = original(method, params);
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased' && !c.__m1HeldReceipt) {
        c.__m1HeldReceipt = true;
        return sent.then(value => new Promise(resolve => { c.__m1ReleaseReceipt = () => resolve(value); }));
      }
      return sent;
    };
  }, nativeId);
  await approval.getByRole('button', { name: '允许一次' }).click();
  await until(() => siteFacts.posts === 1, 'one server effect before lost receipt');
  const beforeTakeover = Date.now();
  const takeover = await page.evaluate(({ projectId, threadId, pageId }) =>
    window.arealDesktop.preview({ operation: 'takeover', projectId, threadId, pageId }), { projectId, threadId, pageId });
  const takeoverMs = Date.now() - beforeTakeover;
  assert.ok(takeoverMs < 2000, `local takeover blocked for ${takeoverMs} ms`);
  assert.equal(takeover.browser.control, 'transferring');
  events.takeover = { elapsedMs: takeoverMs, immediateControl: takeover.browser.control, postCount: siteFacts.posts };
  await app.evaluate(({ webContents }, id) => {
    const c = webContents.fromId(id);
    if (!c.__m1HeldReceipt || !c.__m1ReleaseReceipt) throw Error('native release receipt was not held');
    c.debugger.sendCommand = c.__m1OriginalSend;
    c.__m1ReleaseReceipt();
  }, nativeId);
  await until(async () => (await controlState()).browser?.control === 'human', 'native input convergence');
  const clickTurn = await terminalTurn(1), clickItem = browserItem(clickTurn);
  events.lostReceipt = { turnStatus: clickTurn.status, item: clickItem, postCount: siteFacts.posts,
    control: (await controlState()).browser.control };
  assert.equal(siteFacts.posts, 1);
  assert.match(JSON.stringify(clickItem), /outcome_unknown|unknown/i);
  checks.push('B-14/B-16: local takeover fences a pending input receipt; one server effect remains UNKNOWN until convergence');

  // A human-only secret must not enter Core's next observation or model context.
  await app.evaluate(({ webContents }, { id, value }) => webContents.fromId(id).executeJavaScript(
    `document.querySelector('#password').value=${JSON.stringify(value)}`), { id: nativeId, value: secret });
  await command('manage', { projectId, threadId, operation: 'toolAcknowledge', itemId: clickItem.id,
    inspection: 'Synthetic server recorded exactly one POST; receipt was withheld, so the original action remains unknown and will not be retried.' });
  phase = 'humanObserve'; issued = false;
  await command('send', { projectId, threadId, text: 'Try to observe while the human controls this page' });
  const blocked = browserItem(await terminalTurn(2));
  assert.equal(blocked.success, false);
  assert.ok(!JSON.stringify(blocked).includes(secret));
  assert.equal(siteFacts.posts, 1);
  events.humanOnly = { item: blocked, control: (await controlState()).browser.control, postCount: siteFacts.posts };
  checks.push('B-15: Core browser read is refused while human controls the page');

  for (const [nextPhase, previousTurns] of [['humanCapture', 3], ['humanDiagnostics', 4]]) {
    phase = nextPhase; issued = false;
    await command('send', { projectId, threadId, text: `Try ${nextPhase} while the human controls this page` });
    const refusedTurn = await terminalTurn(previousTurns);
    const refused = browserItem(refusedTurn);
    assert.equal(refused.success, false, `${nextPhase} must be refused under human control`);
    assert.ok(!JSON.stringify(refusedTurn).includes(secret), `${nextPhase} must not persist the human secret`);
    assert.ok(!refused.contentItems.some(item => item.type === 'image'), `${nextPhase} must not emit pixels`);
    assert.equal(siteFacts.posts, 1);
    events[nextPhase] = { turnId: refusedTurn.id, item: refused, control: (await controlState()).browser.control };
  }
  checks.push('B-15: Core capture and diagnostics are refused during human control without media or secret-bearing Items');

  phase = 'after'; issued = false;
  await page.getByRole('button', { name: '交还并让 Agent 检查当前页' }).click();
  await until(async () => (await controlState()).browser?.control === 'agent', 'explicit giveback');
  const after = browserItem(await terminalTurn(5));
  const fresh = JSON.parse(after.contentItems[0].text);
  assert.notEqual(fresh.controlEpoch, observed.controlEpoch);
  assert.ok(!JSON.stringify(after).includes(secret));
  assert.equal(siteFacts.posts, 1, 'giveback does not replay ambiguous submit');
  events.giveback = { pageId, nativeId, beforeEpoch: observed.controlEpoch, afterEpoch: fresh.controlEpoch,
    postCount: siteFacts.posts, itemId: after.id };
  checks.push('B-15/B-16: explicit giveback creates a fresh observation epoch and never replays the UNKNOWN submit');

  // Hold the receipt for a real Native keyUp after an approved Core press.
  // The local takeover must fence the key before Core's tool reply settles.
  snapshotId = fresh.observationId;
  targetRef = fresh.nodes.find(node => node.name?.trim() === 'Hold key' && node.ref)?.ref;
  assert.match(targetRef, /^r\d+$/);
  phase = 'keyPress'; issued = false;
  await command('send', { projectId, threadId, text: 'Press Enter on the harmless Hold key field' });
  const keyApproval = page.locator('[data-interaction="approval"]');
  await keyApproval.waitFor({ timeout: 60000 });
  assert.match(await keyApproval.innerText(), /Hold key/);
  await app.evaluate(({ webContents }, id) => {
    const c = webContents.fromId(id), original = c.debugger.sendCommand.bind(c.debugger);
    c.__m1OriginalKeySend = original;
    c.debugger.sendCommand = (method, params) => {
      const sent = original(method, params);
      if (method === 'Input.dispatchKeyEvent' && params?.type === 'keyUp' && !c.__m1HeldKeyReceipt) {
        c.__m1HeldKeyReceipt = true;
        return sent.then(value => new Promise(resolve => { c.__m1ReleaseKeyReceipt = () => resolve(value); }));
      }
      return sent;
    };
  }, nativeId);
  await keyApproval.getByRole('button', { name: '允许一次' }).click();
  await until(() => app.evaluate(({ webContents }, id) => webContents.fromId(id)?.executeJavaScript(
    'window.keyFacts.ups.includes("Enter")'), nativeId), 'Native Enter keyUp before receipt');
  const beforeKeyTakeover = Date.now();
  const keyTakeover = await page.evaluate(({ projectId, threadId, pageId }) =>
    window.arealDesktop.preview({ operation: 'takeover', projectId, threadId, pageId }), { projectId, threadId, pageId });
  assert.ok(Date.now() - beforeKeyTakeover < 2000);
  assert.equal(keyTakeover.browser.control, 'transferring');
  await app.evaluate(({ webContents }, id) => {
    const c = webContents.fromId(id);
    if (!c.__m1HeldKeyReceipt || !c.__m1ReleaseKeyReceipt) throw Error('Native keyUp receipt was not held');
    c.debugger.sendCommand = c.__m1OriginalKeySend;
    c.__m1ReleaseKeyReceipt();
  }, nativeId);
  await until(async () => (await controlState()).browser?.control === 'human', 'key input convergence');
  const keyTurn = await terminalTurn(6), keyItem = browserItem(keyTurn);
  const keyFacts = await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript(
    'window.keyFacts'), nativeId);
  assert.ok(keyFacts.downs.includes('Enter') && keyFacts.ups.includes('Enter'));
  assert.equal(siteFacts.posts, 1, 'harmless key input does not replay submit');
  assert.equal(keyItem.execution?.outcome, 'unknown');
  events.heldKey = { turnId: keyTurn.id, item: keyItem, control: (await controlState()).browser.control,
    keyFacts, postCount: siteFacts.posts };
  checks.push('B-14: local takeover fences an approved Native key and converges after its held keyUp receipt');
  const keyInspection = 'Synthetic keyDown/keyUp both reached the harmless field; no new POST; receipt was withheld, so outcome remains unknown.';
  const keyAcknowledgment = await command('manage', { projectId, threadId, operation: 'toolAcknowledge',
    itemId: keyItem.id, inspection: keyInspection });
  const inspectedKey = await until(async () => (await thread())?.turns
    .flatMap(turn => turn.items).find(item => item.id === keyItem.id && item.execution?.inspection),
  'persisted held-key UNKNOWN inspection');
  assert.equal(inspectedKey.execution.outcome, 'unknown');
  assert.equal(inspectedKey.execution.inspection, keyInspection);
  events.heldKeyAcknowledgment = { itemId: keyItem.id, inspection: keyInspection,
    persistedOutcome: inspectedKey.execution.outcome, persistedInspection: inspectedKey.execution.inspection,
    result: keyAcknowledgment };

  // A second native page in the same browser workspace must retain the
  // session, while the four-page admission limit is enforced before create.
  const siblings = [];
  for (let index = 0; index < 3; index++) {
    const next = await page.evaluate(({ projectId, threadId, pageId }) =>
      window.arealDesktop.preview({ operation: 'newPage', projectId, threadId, pageId }),
      { projectId, threadId, pageId });
    siblings.push(next.browser.pageId);
  }
  const full = await controlState();
  assert.equal(full.workspace.pages.length, 4);
  assert.equal(new Set(full.workspace.pages.map(item => item.pageId)).size, 4);
  assert.ok(siblings.every(id => full.workspace.pages.find(item => item.pageId === id)?.openerId === pageId));
  const beforeQuota = await app.evaluate(({ webContents }) => webContents.getAllWebContents().length);
  const quota = await page.evaluate(({ projectId, threadId, pageId }) =>
    window.arealDesktop.preview({ operation: 'newPage', projectId, threadId, pageId })
      .then(() => ({ accepted: true }), error => ({ accepted: false, message: error.message })),
    { projectId, threadId, pageId });
  assert.equal(quota.accepted, false);
  assert.match(quota.message, /4页/);
  assert.equal((await controlState()).workspace.pages.length, 4);
  assert.equal(await app.evaluate(({ webContents }) => webContents.getAllWebContents().length), beforeQuota);
  events.pages = { parent: pageId, siblings, quota, nativeBeforeRejectedCreate: beforeQuota,
    workspace: (await controlState()).workspace };
  checks.push('B-19/B-24: public workspace metadata preserves page identity and opener; fifth page is rejected before native create');

  const sibling = siblings[0];
  const cookieBefore = siteFacts.cookieOnGets.length;
  await page.evaluate(({ projectId, threadId, pageId, url }) =>
    window.arealDesktop.preview({ operation: 'navigate', projectId, threadId, pageId, url }),
    { projectId, threadId, pageId: sibling, url: siteUrl });
  await until(() => siteFacts.cookieOnGets.length > cookieBefore, 'sibling native request');
  assert.equal(siteFacts.cookieOnGets.at(-1), true, 'HTTPOnly cookie follows same-workspace sibling');
  const siblingNative = await until(() => app.evaluate(({ webContents }, url) =>
    webContents.getAllWebContents().filter(item => item.getURL() === url).length >= 2, siteUrl), 'sibling native page');
  await page.evaluate(({ projectId, threadId, pageId }) =>
    window.arealDesktop.preview({ operation: 'release', projectId, threadId, pageId, userIntent: true }),
    { projectId, threadId, pageId: sibling });
  assert.equal((await controlState()).workspace.pages.length, 3);
  assert.equal(siteFacts.posts, 1);
  events.session = { sameWorkspaceCookieReceived: true, siblingNative, remainingPages: 3,
    postCount: siteFacts.posts };
  checks.push('B-21: same-workspace sibling sends the synthetic HTTPOnly cookie; closing it preserves the original page');

  const second = await command('create', { projectId, browserEnabled: true, profile: { id: 'fixture', revision: 'v1' } });
  await selectConversation(page, second.threadId);
  await page.keyboard.press('Meta+t');
  const beforeSecondNativeIds = await app.evaluate(({ webContents }) => webContents.getAllWebContents().map(item => item.id));
  const secondPage = await page.evaluate(({ projectId, threadId }) =>
    window.arealDesktop.preview({ operation: 'newPage', projectId, threadId }),
    { projectId, threadId: second.threadId });
  const secondId = secondPage.browser.pageId;
  const secondNativeId = await until(() => app.evaluate(({ webContents }, ids) =>
    webContents.getAllWebContents().find(item => !ids.includes(item.id))?.id,
    beforeSecondNativeIds), 'new second workspace native page');
  const beforeSecondCookies = await app.evaluate(({ webContents }, { id, url }) =>
    webContents.fromId(id).session.cookies.get({ url }), { id: secondNativeId, url: siteUrl });
  await page.evaluate(({ projectId, threadId, pageId }) =>
    window.arealDesktop.preview({ operation: 'show', projectId, threadId, pageId, visible: true }),
    { projectId, threadId: second.threadId, pageId: secondId });
  await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0].focus(); });
  await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()), 'second workspace focused');
  const isolatedBefore = siteFacts.getRequests.length;
  await page.evaluate(({ projectId, threadId, pageId, url }) =>
    window.arealDesktop.preview({ operation: 'navigate', projectId, threadId, pageId, url }),
    { projectId, threadId: second.threadId, pageId: secondId, url: secondUrl });
  const secondRequest = await until(() => siteFacts.getRequests.slice(isolatedBefore)
    .find(item => item.url === new URL(secondUrl).pathname + new URL(secondUrl).search), 'second workspace native request');
  const sessionIsolated = await app.evaluate(({ webContents }, { first, second }) =>
    webContents.fromId(first).session !== webContents.fromId(second).session,
    { first: nativeId, second: secondNativeId });
  events.isolation = { secondThreadId: second.threadId, secondPageId: secondId,
    secondNativeId, separateNativeSession: sessionIsolated,
    cookiesBeforeSecondNavigation: beforeSecondCookies.map(item => item.name),
    secondRequestSentFirstCookie: secondRequest.cookie,
    concurrentRequests: siteFacts.getRequests.slice(isolatedBefore),
    developmentOriginPrompt: await app.evaluate(() => globalThis.__m1OriginPrompt) };
  assert.equal(sessionIsolated, true);
  assert.deepEqual(beforeSecondCookies, [], 'second session must have no first-workspace cookies');
  assert.equal(secondRequest.cookie, false, 'new browser workspace cannot send first workspace cookie');
  assert.equal((await controlState()).workspace.pages.length, 3, 'original workspace remains intact');
  checks.push('B-22: separate Thread workspace uses separate Native Session and sends no first-workspace HTTPOnly cookie');

  const redirected = new URL('/redirect', siteUrl).href;
  await page.evaluate(({ projectId, threadId, pageId, url }) =>
    window.arealDesktop.preview({ operation: 'navigate', projectId, threadId, pageId, url }),
    { projectId, threadId: second.threadId, pageId: secondId, url: redirected });
  await until(() => siteFacts.redirects >= 1, 'allowed origin redirect response');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(siteFacts.forbiddenRequests, 0, 'unapproved redirect target receives no request');
  const afterRedirectUrl = await app.evaluate(({ webContents }, id) => webContents.fromId(id).getURL(), secondNativeId);
  assert.notEqual(afterRedirectUrl, forbiddenUrl);
  events.redirectPolicy = { allowedOriginRedirects: siteFacts.redirects,
    forbiddenTargetRequests: siteFacts.forbiddenRequests, afterRedirectUrl };
  checks.push('B-23: approved synthetic Origin cannot redirect Native page into another unapproved loopback Origin');

  const beforeCrash = (await controlState()).workspace.pages.find(item => item.pageId === pageId);
  await app.evaluate(({ webContents }, id) => webContents.fromId(id).forcefullyCrashRenderer(), nativeId);
  const crashed = await until(async () => (await controlState()).workspace.pages.find(item =>
    item.pageId === pageId && item.resource === 'crashed'), 'original Native renderer crash');
  assert.equal(crashed.pageGeneration, beforeCrash.pageGeneration);
  await page.evaluate(({ projectId, threadId, pageId }) =>
    window.arealDesktop.preview({ operation: 'reload', projectId, threadId, pageId }),
    { projectId, threadId, pageId });
  const replacement = await until(async () => (await controlState()).workspace.pages.find(item =>
    item.pageId === pageId && item.resource === 'ready' && item.pageGeneration > beforeCrash.pageGeneration),
  'replacement Native page generation');
  assert.equal(replacement.pageGeneration, beforeCrash.pageGeneration + 1);
  const replacementNativeId = await until(() => app.evaluate(({ webContents }, { url, oldId }) =>
    webContents.getAllWebContents().find(item => item.id !== oldId && item.getURL() === url)?.id,
    { url: siteUrl, oldId: nativeId }), 'replacement Native document');
  assert.notEqual(replacementNativeId, nativeId);
  assert.equal(siteFacts.posts, 1, 'crash restoration does not replay the UNKNOWN submit');
  events.crash = { pageId, oldNativeId: nativeId, newNativeId: replacementNativeId,
    beforeGeneration: beforeCrash.pageGeneration, afterGeneration: replacement.pageGeneration,
    postCount: siteFacts.posts, stateLoss: replacement.stateLoss };
  checks.push('B-25: Native renderer crash replaces the same logical Page with a new generation and no action replay');

  await selectConversation(page, threadId);
  await page.locator('.preview-panel').waitFor();
  const tablist = page.getByRole('tablist', { name: '浏览页面' });
  const selectionEvidence = async () => ({
    publicState: await controlState(),
    renderer: await page.evaluate(() => ({
      threadId: document.querySelector('[data-testid="areal-workbench"]')?.getAttribute('data-thread-id'),
      tabs: [...document.querySelectorAll('[role="tablist"][aria-label="浏览页面"] [role="tab"]')]
        .map(item => ({ label: item.textContent, selected: item.getAttribute('aria-selected') })),
    })),
  });
  await until(async () => {
    const value = await selectionEvidence();
    return value.renderer.threadId === threadId
      && value.renderer.tabs.length === value.publicState.workspace?.pages?.length
      && value.publicState.workspace.pages.some(item => item.pageId === pageId && item.title === 'Human boundary fixture');
  }, 'current Thread Preview and original Page tab ready');
  events.postCrashSelectionBefore = await selectionEvidence();
  await tablist.getByRole('tab', { name: 'Human boundary fixture', exact: true }).click();
  events.postCrashSelectionAfterClick = await selectionEvidence();
  await until(async () => { const value = await controlState();
    return value.workspace?.selectedPageId === pageId && value.browser?.pageId === pageId;
  }, 'public selection of replacement Page');
  await until(async () => {
    const selected = await tablist.getByRole('tab', { name: 'Human boundary fixture', exact: true })
      .getAttribute('aria-selected');
    const address = await page.getByTestId('browser-address-input').inputValue();
    return selected === 'true' && (address === new URL(siteUrl).host || address === siteUrl);
  }, 'Renderer selected tab and address match replacement Page');
  events.postCrashSelectionReady = await selectionEvidence();
  phase = 'postCrashObserve'; issued = false;
  await page.getByRole('button', { name: '让 Agent 检查当前页' }).click();
  await until(async () => (await controlState()).browser?.control === 'agent', 'claim replacement Native page');
  const postCrashTurn = await terminalTurn(7), postCrashItem = browserItem(postCrashTurn);
  assert.equal(postCrashItem.success, true);
  const postCrashObservation = JSON.parse(postCrashItem.contentItems[0].text);
  assert.equal(postCrashObservation.pageGeneration, replacement.pageGeneration);
  events.postCrashObserve = { turnId: postCrashTurn.id, itemId: postCrashItem.id,
    pageGeneration: postCrashObservation.pageGeneration };
  snapshotId = preCrashSnapshotId; targetRef = preCrashTargetRef;
  phase = 'staleAfterCrash'; issued = false;
  await command('send', { projectId, threadId, text: 'Try the pre-crash Ref on the replacement page' });
  const staleTurn = await terminalTurn(8), staleItem = browserItem(staleTurn);
  assert.equal(staleItem.success, false);
  assert.match(JSON.stringify(staleItem), /stale_ref|plan_stale/);
  assert.equal(siteFacts.posts, 1);
  events.staleAfterCrash = { turnId: staleTurn.id, item: staleItem, postCount: siteFacts.posts };
  checks.push('B-25: pre-crash Ref and observation cannot dispatch on the replacement Native generation');

  // Synthetic diagnostic fault injection only: generate more page console
  // events than the bounded Native ring can retain, then read through Core.
  await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript(
    'for (let index = 0; index < 300; index++) console.info(`M1_DIAGNOSTIC_${index}`)'), replacementNativeId);
  phase = 'boundedDiagnostics'; issued = false;
  await command('send', { projectId, threadId, text: 'Read a bounded page diagnostic window' });
  const diagnosticTurn = await terminalTurn(9), diagnosticItem = browserItem(diagnosticTurn);
  assert.equal(diagnosticItem.success, true);
  const diagnosticWindow = JSON.parse(diagnosticItem.contentItems[0].text);
  assert.equal(diagnosticWindow.bounded.entries, 200);
  assert.ok(diagnosticWindow.events.length <= 20);
  assert.ok(diagnosticWindow.loss, 'old console events report an explicit loss interval');
  assert.ok(!JSON.stringify(diagnosticTurn).includes(secret));
  events.boundedDiagnostics = { turnId: diagnosticTurn.id, count: diagnosticWindow.events.length,
    bounded: diagnosticWindow.bounded, loss: diagnosticWindow.loss, cursor: diagnosticWindow.cursor };
  checks.push('B-26: Core diagnostic read remains bounded and reports evicted-event loss after Native console flood');

  }
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  errors.push(error.stack ?? String(error));
  if (page) await captureSmokeFailure(page, scratch, error);
  throw error;
} finally {
  if (pausedHostPid) { try { process.kill(pausedHostPid,'SIGCONT'); } catch { /* exact task host already exited */ } }
  if (app) await app.close();
  site.closeAllConnections(); model.closeAllConnections(); forbidden.closeAllConnections();
  await Promise.all([new Promise(resolve => site.close(resolve)), new Promise(resolve => model.close(resolve)),
    new Promise(resolve => forbidden.close(resolve))]);
  const files = ['app/src/core/preview.cjs', 'app/src/core/main.cjs', 'app/src/core/service-protocol.cjs',
    'renderer/src/Preview.tsx', 'renderer/src/UnknownToolInspection.tsx', 'scripts/browser-human-smoke.mjs'];
  const hashes = Object.fromEntries(await Promise.all(files.map(async file =>
    [file, createHash('sha256').update(await readFile(join(gui, file))).digest('hex')])));
  await writeFile(join(scratch, 'run-manifest.json'), JSON.stringify({ passed, checks, errors, events, modelCalls,
    startedAt, endedAt: new Date().toISOString(), faultMode, sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    diffSHA256: createHash('sha256').update(execFileSync('git', ['diff', 'HEAD'], { cwd: root })).digest('hex'),
    hashes, coreBinary: env.AREAL_CORE_BIN,
    coreBinarySHA256: createHash('sha256').update(await readFile(env.AREAL_CORE_BIN)).digest('hex'),
    runtimeBinary: join(dirname(env.AREAL_CORE_BIN), 'areal-runtime'),
    runtimeBinarySHA256: createHash('sha256').update(await readFile(join(dirname(env.AREAL_CORE_BIN), 'areal-runtime'))).digest('hex'),
    reaperBinary: join(dirname(env.AREAL_CORE_BIN), 'areal-runtime-reaper'),
    reaperBinarySHA256: createHash('sha256').update(await readFile(join(dirname(env.AREAL_CORE_BIN), 'areal-runtime-reaper'))).digest('hex'),
    runtimeFsBinary: join(dirname(env.AREAL_CORE_BIN), 'areal-runtime-fs'),
    runtimeFsBinarySHA256: createHash('sha256').update(await readFile(join(dirname(env.AREAL_CORE_BIN), 'areal-runtime-fs'))).digest('hex'),
    scope: 'source Electron + independent adapter + Core/Runtime + deterministic local model + synthetic site; OS chooser and exact-Origin bootstrap stubbed',
    entrypoint: `node clients/gui/scripts/browser-human-smoke.mjs${faultMode === 'full' ? '' : ` ${faultMode}`}` }, null, 2));
  console.log(JSON.stringify({ passed, evidence: scratch, checks, errors }));
}
