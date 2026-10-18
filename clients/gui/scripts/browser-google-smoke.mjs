import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectConversation, captureSmokeFailure } from './smoke-navigation.mjs';
import { checkBrowserStartup } from './browser-startup.mjs';

// Real GUI/Main/desktop adapter/Core/native Google; only inference is deterministic.
const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(gui, '../..');
const require = createRequire(join(gui, 'app/package.json'));
const { _electron: electron } = require('playwright-core');
const scratch = await mkdtemp('/private/tmp/areal-google-');
const workspace = join(scratch, 'workspace'), userHome = join(scratch, 'user');
await mkdir(workspace); await mkdir(join(userHome, '.areal'), { recursive: true });
execFileSync('git', ['init', '-b', 'main'], { cwd: workspace, stdio: 'ignore' });
const localSearch = process.env.AREAL_BROWSER_LOCAL_SEARCH === '1';
const site = localSearch ? createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  const results = url.pathname === '/search';
  const html = `<!doctype html><title>${results ? 'AI Agent results fixture' : 'Search fixture'}</title><main>
    <form action="/search" method="GET"><label>Search <input name="q" aria-label="Search" value="${results ? 'AI Agent' : ''}"></label><button>Search</button></form>
    ${results ? '<h1>AI Agent results fixture</h1><a href="/one">AI Agent result one</a><a href="/two">AI Agent result two</a><iframe src="/frame"></iframe>' : ''}</main>`;
  setTimeout(() => response.end(url.pathname === '/frame' ? '<p>late frame</p>' : html), results ? 250 : 0);
}) : null;
if (site) await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
const searchUrl = site ? `http://browser-synthetic.localhost:${site.address().port}/` : 'https://www.google.com/';
const evidence = { scope: `source Electron + Core + ${site ? 'synthetic local search (not Google)' : 'live Google'} + deterministic local inference`, turns: [], requests: [] };
let scenario = 'open', stage = 0, pageId, observation, oldObservation, app, page, projectId, threadId;
function find(value, predicate, depth = 0) {
  if (depth > 12 || value == null) return null;
  if (typeof value === 'string') { try { return find(JSON.parse(value), predicate, depth + 1); } catch { return null; } }
  if (typeof value !== 'object') return null;
  if (predicate(value)) return value;
  return Object.values(value).map(v => find(v, predicate, depth + 1)).find(Boolean) ?? null;
}
function searchRef(obs) {
  const node = obs.nodes.find(n => /combobox|searchbox|textbox/i.test(n.role) && /search|搜索/i.test(n.name));
  assert.ok(node?.ref, 'Google search field must be in actual AX observation'); return node.ref;
}
const model = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw), last = body.messages.at(-1);
    const result = last?.role === 'tool' ? last.content : null;
    evidence.requests.push({ scenario, stage, guidance: JSON.stringify(body.messages).includes('Every new user request') });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (delta, finish_reason) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish_reason ?? null }] })}\n\n`);
    const tool = args => { send({ tool_calls: [{ index: 0, id: `google-${scenario}-${stage}`, type: 'function', function: { name: 'browser_v1', arguments: JSON.stringify(args) } }] }); send({}, 'tool_calls'); };
    const finish = text => { send({ content: text }); send({}, 'stop'); };
    const obs = find(result, v => v.observationId && Array.isArray(v.nodes));
    const description = find(result, v => v.protocol === 'areal.browser.host.v1');
    if (description) pageId = description.pages[0];
    if (obs) observation = obs;
    if (scenario === 'old') {
      if (stage++ === 0) tool({ operation: 'act', parameters: { pageId, snapshotId: oldObservation.observationId, action: { kind: 'fill', ref: searchRef(oldObservation), value: 'MUST_NOT_DISPATCH' } } });
      else finish('Old turn refs refused.');
    } else if (scenario === 'human') {
      if (stage++ === 0) tool({ operation: 'observe', parameters: { pageId } });
      else finish('Human control respected.');
    } else if (scenario === 'change' || scenario === 'takeover') {
      if (stage++ === 0) tool({ operation: 'observe', parameters: { pageId } });
      else finish('Navigation invalidation classified.');
    } else if (scenario === 'read') {
      if (stage === 0) tool({ operation: 'describe', parameters: {} });
      else if (stage === 1) tool({ operation: 'observe', parameters: { pageId } });
      else finish(`Read Google results: ${observation.text.slice(0, 1800)}`);
      stage++;
    } else if (scenario === 'open') {
      if (stage === 0) tool({ operation: 'describe', parameters: {} });
      else if (stage === 1) tool({ operation: 'navigate', parameters: { pageId, url: searchUrl } });
      else if (stage === 2) tool({ operation: 'wait', parameters: { pageId, condition: { kind: 'documentReady', state: 'complete' }, timeoutMs: 15000 } });
      else if (stage === 3) tool({ operation: 'observe', parameters: { pageId } });
      else finish('Google opened and search field read.');
      stage++;
    } else {
      if (stage === 0) tool({ operation: 'describe', parameters: {} });
      else if (stage === 1 || stage === 4 || stage === 7) tool({ operation: 'observe', parameters: { pageId } });
      else if (stage === 2) tool({ operation: 'act', parameters: { pageId, snapshotId: observation.observationId, action: { kind: 'fill', ref: searchRef(observation), value: 'AI Agent' } } });
      else if (stage === 3) tool({ operation: 'wait', parameters: { pageId, timeoutMs: 1000 } });
      else if (stage === 5) tool({ operation: 'act', parameters: { pageId, snapshotId: observation.observationId, action: { kind: 'press', ref: searchRef(observation), key: 'Enter' } } });
      else if (stage === 6) tool({ operation: 'wait', parameters: { pageId, condition: { kind: 'documentReady', state: 'complete' }, timeoutMs: 15000 } });
      else finish(`Read Google results: ${observation.text.slice(0, 1800)}`);
      stage++;
    }
    response.end('data: [DONE]\n\n');
  } catch (error) { evidence.modelError = error.stack; response.end(); }
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
await writeFile(join(userHome, '.areal/config.toml'), `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`);
const deployment = join(scratch, 'desktop.json');
await writeFile(deployment, JSON.stringify({ profiles: [{ id: 'fixture', revision: 'v1', displayName: 'Fixture', instructions: 'Use the browser tools and report actual observations.' }] }));
const env = { ...process.env, AREAL_GUI_USER_DATA: join(scratch, 'electron'), AREAL_CORE_HOME: join(scratch, 'core'), AREAL_CORE_USER_HOME: userHome,
  AREAL_HARNESS_SERVICE_HOME: join(scratch, 'registry'), AREAL_CORE_DESKTOP_CONFIG: deployment, AREAL_CORE_BIN: process.env.AREAL_CORE_BIN || join(root, 'target/debug/areal') };
for (const key of ['AREAL_CORE_WORKSPACE', 'AREAL_CORE_CONFIG', 'AREAL_HARNESS_HOME', 'AREAL_HARNESS_CONFIG', 'ELECTRON_RUN_AS_NODE']) delete env[key];
async function until(fn, label, timeout = 90000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 100)); } throw new Error(`Timeout: ${label}`); }
async function state() { return page.evaluate(() => window.arealDesktop.snapshot()); }
async function command(name, params) { const result = await page.evaluate(({name,params}) => window.arealDesktop.command(name,params), {name,params}); assert.equal(result.ok,true,JSON.stringify(result)); return result.value; }
async function run(kind, text) {
  scenario = kind; stage = 0;
  const count = (await state()).projects.find(p=>p.id===projectId).state.threads[threadId]?.turns?.length ?? 0;
  await page.getByTestId('chat-input').fill(text); await page.getByTestId('chat-input').press('Enter');
  const turn = await until(async () => { const allow=page.getByRole('button',{name:'允许一次',exact:true});if(await allow.isVisible()){await allow.click();evidence.guiApprovals=(evidence.guiApprovals??0)+1;} const t = (await state()).projects.find(p=>p.id===projectId).state.threads[threadId]; const v=t?.turns?.at(-1); return t.turns.length>count && ['completed','failed'].includes(v.status) ? v : null; },kind);
  evidence.turns.push({scenario:kind,turn}); assert.equal(turn.status,'completed',JSON.stringify(turn.error)); return turn;
}
function calls(turn) { return turn.items.filter(i=>i.type==='dynamicToolCall'); }
function success(turn) { for (const call of calls(turn)) assert.equal(call.success,true,`${call.arguments.operation}: ${JSON.stringify(call.contentItems)}`); }
async function native() { return app.evaluate(({webContents},origin) => { const c=webContents.getAllWebContents().find(c=>c.getURL().startsWith(origin)); return c ? {id:c.id,url:c.getURL(),title:c.getTitle()} : null; },new URL(searchUrl).origin); }
try {
  app = await electron.launch({executablePath:require('electron'),args:[join(gui,'app')],env,timeout:120000});
  await checkBrowserStartup(app,{binary:env.AREAL_CORE_BIN,userHome,scratch});
  await app.evaluate(({app})=>{globalThis.__googleNativeEvents=[];app.on('web-contents-created',(_event,c)=>{for(const name of ['did-start-navigation','did-fail-load','render-process-gone']) c.on(name,(_event,...args)=>globalThis.__googleNativeEvents.push({name,id:c.id,args:args.slice(0,5),at:Date.now()}));c.debugger.on('detach',(_event,reason)=>globalThis.__googleNativeEvents.push({name:'debugger-detach',id:c.id,reason,at:Date.now()}));});});
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  await page.getByTestId('areal-workbench').waitFor({timeout:120000}); await until(async ()=>(await state()).connection?.state==='ready','desktop ready');
  await app.evaluate(({dialog,BrowserWindow},workspace)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[workspace]});const original=dialog.showMessageBox;dialog.showMessageBox=async(...args)=>args.at(-1)?.title==='允许本地开发站点'?{response:1}:original(...args);BrowserWindow.getAllWindows()[0].setSize(1440,960);},workspace);
  await page.evaluate(()=>window.arealDesktop.chooseProject());
  const project=await until(async ()=>(await state()).projects.find(p=>p.root===workspace),'project ready'); projectId=project.id;
  const created=await command('create',{projectId,browserEnabled:true,profile:{id:'fixture',revision:'v1'}});threadId=created.threadId;
  await selectConversation(page,threadId);
  success(await run('open','打开 Google，并确认搜索框可读取。')); oldObservation=observation;
  assert.equal(new URL(observation.url).origin,new URL(searchUrl).origin); searchRef(observation);
  const old=await run('old','检查上一轮旧 refs 是否会被拒绝。'); assert.equal(calls(old)[0].success,false);assert.match(JSON.stringify(calls(old)),/stale_ref/);
  success(await run('search','使用内置浏览器的 Google 搜索 AI Agent，并读取结果。'));
  if (observation.url.includes('/sorry/') && process.env.AREAL_GOOGLE_MANUAL_CAPTCHA === '1') {
    evidence.captcha={url:observation.url,status:'requires_human'};
    await page.evaluate(({projectId,threadId,pageId})=>window.arealDesktop.preview({operation:'takeover',projectId,threadId,pageId}),{projectId,threadId,pageId});
    await app.evaluate(({app,BrowserWindow})=>{app.focus({steal:true});const w=BrowserWindow.getAllWindows()[0];w.setTitle('AReaL Harness · Google 验收');w.focus();});
    console.log(JSON.stringify({status:'captcha_requires_human',evidence:scratch}));
    await until(async()=>{const n=await native();return n && new URL(n.url).pathname==='/search';},'manual Google verification',300000);
    evidence.captcha.status='manually_completed';
    success(await run('read','人工验证已完成，请重新授权并读取 Google 的 AI Agent 搜索结果。'));
  }
  assert.equal(new URL(observation.url).pathname,'/search');assert.match(observation.text,/AI Agent|AI agent/i);
  const resultLinks=observation.nodes.filter(n=>n.role==='link' && n.name && /agent/i.test(n.name));assert.ok(resultLinks.length>=2,'at least two actual search result links are readable');
  evidence.resultLinks=resultLinks; evidence.native=await native(); assert.equal(new URL(evidence.native.url).searchParams.get('q'),'AI Agent');
  await page.screenshot({path:join(scratch,'gui-results.png')});
  const png=await app.evaluate(async ({webContents},id)=>(await webContents.fromId(id).capturePage()).toPNG().toString('base64'),evidence.native.id);await writeFile(join(scratch,'native-results.png'),Buffer.from(png,'base64'));
  // Force a real same-document update while the native AX read is pending.
  await app.evaluate(({webContents},id)=>{const c=webContents.fromId(id), original=c.debugger.sendCommand.bind(c.debugger);c.debugger.sendCommand=async(method,...args)=>{if(method==='Accessibility.getFullAXTree'){c.debugger.sendCommand=original; await c.executeJavaScript('history.replaceState(history.state,"",location.href)');await new Promise(r=>setTimeout(r,100));}return original(method,...args);};},evidence.native.id);
  const changed=await run('change','读取正在更新的页面。');assert.equal(calls(changed)[0].success,false);assert.match(JSON.stringify(calls(changed)),/plan_stale/);assert.doesNotMatch(JSON.stringify(calls(changed)),/human_control/);
  const control=await page.evaluate(({projectId,threadId,pageId})=>window.arealDesktop.preview({operation:'state',projectId,threadId,pageId}),{projectId,threadId,pageId});assert.equal(control.browser.control,'agent','same-document invalidation preserves Agent authority');
  await app.evaluate(({webContents},id)=>{const c=webContents.fromId(id),original=c.debugger.sendCommand.bind(c.debugger);globalThis.__googleReadPending=false;c.debugger.sendCommand=async(method,...args)=>{if(method==='Accessibility.getFullAXTree'){c.debugger.sendCommand=original;globalThis.__googleReadPending=true;await new Promise(r=>setTimeout(r,500));}return original(method,...args);};},evidence.native.id);
  const taking=run('takeover','读取时人工接管。');
  await until(()=>app.evaluate(()=>globalThis.__googleReadPending),'in-flight native read');
  await page.evaluate(({projectId,threadId,pageId})=>window.arealDesktop.preview({operation:'takeover',projectId,threadId,pageId}),{projectId,threadId,pageId});
  const taken=await taking;assert.equal(calls(taken)[0].success,false);assert.match(JSON.stringify(calls(taken)),/human_control/);
  const human=await run('human','检查人工接管后的拒绝。');assert.equal(calls(human)[0].success,false);assert.match(JSON.stringify(calls(human)),/host_unavailable|human_control/);
  assert.ok(evidence.requests.every(r=>r.guidance),'fresh-request guidance reaches each model request');
  evidence.status='passed';
} catch(error) {evidence.status='failed';evidence.error=error.stack;if(page)await captureSmokeFailure(page,scratch,error);process.exitCode=1;}
finally {
  if(site){site.closeAllConnections();await new Promise(r=>site.close(r));}
  if(app){evidence.nativeEvents=await app.evaluate(()=>globalThis.__googleNativeEvents).catch(()=>[]);await app.close();}model.closeAllConnections();await new Promise(r=>model.close(r));
  evidence.sourceHead=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  evidence.diffSHA256=createHash('sha256').update(execFileSync('git',['diff','HEAD'],{cwd:root})).digest('hex');
  evidence.coreBinarySHA256=createHash('sha256').update(await readFile(env.AREAL_CORE_BIN)).digest('hex');
  await writeFile(join(scratch,'manifest.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({status:evidence.status,evidence:scratch,error:evidence.error}));
}
