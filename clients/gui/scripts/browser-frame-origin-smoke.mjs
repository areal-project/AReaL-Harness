import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { selectConversation, captureSmokeFailure } from './smoke-navigation.mjs';

// 经真实 Core、独立适配器和同一 Native 页面验证人工 Frame 授权；站点与模型均为合成夹具。
const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(gui, '../..');
const startedAt = new Date().toISOString();
const require = createRequire(join(gui, 'app/package.json'));
const { _electron: electron } = require('playwright-core');
const scratch = await mkdtemp('/private/tmp/areal-browser-evidence-');
const workspace = join(scratch, 'workspace'), userHome = join(scratch, 'user');
await mkdir(workspace); await mkdir(join(userHome, '.areal'), { recursive: true });
execFileSync('git', ['init', '-b', 'main'], { cwd: workspace, stdio: 'ignore' });
const sentinel = 'FRAME_ORIGIN_PARENT';
const frameKind = process.argv[2] === 'same-process' ? 'same-process' : 'oopif';
const siteFacts = { gets: 0, posts: 0, childGets: 0, childRequests: [] };
const sibling = createServer((request, response) => {
  siteFacts.childGets++;
  siteFacts.childRequests.push({ url: request.url, destination: request.headers['sec-fetch-dest'] ?? null });
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><h2>FRAME_ORIGIN_CHILD</h2><button style="background:blue;color:white">Child target</button>');
});
await new Promise(resolve => sibling.listen(0, '127.0.0.1', resolve));
const childUrl = `http://${frameKind === 'oopif' ? 'localhost' : '127.0.0.1'}:${sibling.address().port}/`;
let sitePolicy = null;
const site = createServer((request, response) => {
  siteFacts.gets++;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (sitePolicy === 'csp') response.setHeader('Content-Security-Policy', "frame-src 'self'");
  if (sitePolicy === 'connection') response.setHeader('Connection-Allowlist', '(response-origin)');
  response.end(`<!doctype html><h1>${sentinel}</h1><button>Parent target</button><iframe src="${childUrl}" style="width:420px;height:200px"></iframe>`);
});
await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
const siteUrl = `http://127.0.0.1:${site.address().port}/`;
let pageId, scenario = 'observe';
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
  if (scenario !== 'annotation' && last?.role !== 'tool' && !hadImage && !issuedToolForScenario) {
    issuedToolForScenario = true;
    const parameters = { pageId };
    if (scenario === 'capture') parameters.scope = 'viewport';
    send({ tool_calls: [{ index: 0, id: `${scenario}-${++nextToolCall}-03`, type: 'function', function: {
      name: 'browser_v1', arguments: JSON.stringify({ operation: scenario === 'capture' ? 'capture' : 'observe', parameters }),
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
  AREAL_CORE_USER_HOME: userHome, AREAL_CORE_CONFIG: join(userHome, '.areal/config.toml'), AREAL_HARNESS_SERVICE_HOME: join(scratch, 'registry'),
  AREAL_CORE_DESKTOP_CONFIG: deployment, AREAL_CORE_BIN: process.env.AREAL_CORE_BIN || resolve(root, 'target/debug/areal') };
for (const key of ['AREAL_CORE_WORKSPACE', 'AREAL_HARNESS_HOME', 'AREAL_HARNESS_CONFIG']) delete env[key];
let app, page, passed = false;
const checks = [], errors = [], events = {};
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
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  events.runtime = await app.evaluate(() => ({ versions: process.versions, platform: process.platform, arch: process.arch }));
  page.on('pageerror', error => errors.push(error.message));
  await page.getByTestId('areal-workbench').waitFor({ timeout: 120000 });
  await until(async () => (await state()).connection?.state === 'ready', 'desktop ready');
  await app.evaluate(({dialog,BrowserWindow}, {workspace, parent, child}) => {
    dialog.showOpenDialog = async () => ({canceled:false,filePaths:[workspace]});
    const original = dialog.showMessageBox;
    dialog.showMessageBox = async (...args) => {
      const options=args.at(-1);
      if ((options?.title==='允许本地开发站点' && options.message===`允许此浏览工作区访问 ${parent}？`)
        || (options?.title==='授权当前页面的嵌入站点' && options.message===`允许当前页面嵌入 ${child} 并在人工标注时检查其隐私？`)) {
        globalThis.__framePrompts??=[];globalThis.__framePrompts.push(options);
        if (options.title === '授权当前页面的嵌入站点' && globalThis.__framePromptMode === 'cancel') return {response:0};
        if (options.title === '授权当前页面的嵌入站点' && globalThis.__framePromptMode === 'hold')
          return new Promise(resolve=>globalThis.__framePromptRelease=()=>resolve({response:1}));
        return {response:1,checkboxChecked:false};
      }
      return original(...args);
    };
    BrowserWindow.getAllWindows()[0].setSize(1440,1100);
  }, {workspace,parent:new URL(siteUrl).origin,child:new URL(childUrl).origin});
  await page.evaluate(() => window.arealDesktop.chooseProject());
  const project=await until(async()=>(await state()).projects.find(p=>p.root===workspace),'project');
  const first=await command('create',{projectId:project.id,browserEnabled:true,profile:{id:'fixture',revision:'v1'}});
  const identity={projectId:project.id,threadId:first.threadId};
  await selectConversation(page,first.threadId);await page.keyboard.press('Meta+t');await page.locator('.preview-panel').waitFor();
  const focus=async()=>{await app.evaluate(({app,BrowserWindow})=>{app.focus({steal:true});BrowserWindow.getAllWindows()[0].focus();});await until(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isFocused()),'Main focus');};
  const preview=(operation,extra={})=>page.evaluate(request=>window.arealDesktop.preview(request),{...identity,pageId,operation,...extra});
  await focus();await preview('navigate',{url:siteUrl});
  const nativeId=await until(()=>app.evaluate(({webContents},url)=>webContents.getAllWebContents().find(c=>c.getURL()===url)?.id,siteUrl),'native parent');
  pageId=(await preview('state')).browser.pageId;
  await until(()=>app.evaluate(({webContents},id)=>webContents.fromId(id).executeJavaScript("document.readyState==='complete'"),nativeId),'settled');
  assert.equal(siteFacts.childGets,0,'initial child denied');
  await page.getByRole('button',{name:'交还并让 Agent 检查当前页'}).click();
  const baseline=toolResult(await nextTurn(first.threadId));
  events.baselineCore={callId:baseline.callId,result:baseline.contentItems};
  await page.getByRole('button',{name:'接管页面',exact:true}).click();
  await until(async()=>(await preview('state')).browser.control==='human','Human takeover');await focus();
  await assert.rejects(()=>preview('authorizeFrameOrigin',{userIntent:true,url:childUrl}),/无效/);
  await page.getByRole('button',{name:'授权当前页面的嵌入站点',exact:true}).click();
  await until(async()=>(await preview('state')).browser.frameOriginGrant?.status==='pending','pending grant');
  assert.equal(siteFacts.childGets,0,'confirmation alone does not load child');
  await page.getByRole('button',{name:'重载并应用嵌入授权',exact:true}).click();
  await until(async()=>(await preview('state')).browser.frameOriginGrant?.status==='active','active grant');
  await until(()=>app.evaluate(({webContents}, {id,url})=>webContents.fromId(id)?.mainFrame.frames[0]?.url===url,{id:nativeId,url:childUrl}),'loaded child');
  events.nativeFrames=await app.evaluate(({webContents},id)=>{const c=webContents.fromId(id);return c.mainFrame.framesInSubtree.map(f=>({url:f.url,processId:f.processId,frameTreeNodeId:f.frameTreeNodeId,parent:f.parent?.frameTreeNodeId}));},nativeId);
  assert.equal(events.nativeFrames.length,2);assert.equal(events.nativeFrames[0].processId===events.nativeFrames[1].processId,frameKind==='same-process');
  assert.equal(siteFacts.childRequests[0].destination,'iframe');
  await assert.rejects(()=>preview('claim'),/嵌入站点/);
  await assert.rejects(()=>preview('navigate',{url:childUrl}),/撤销/);
  events.loaded={...identity,pageId,nativeId,frameKind,siteFacts:structuredClone(siteFacts)};
  checks.push('Loaded authorized child on the same Native page; grant alone does not reload; Agent claim stays refused');
  scenario='capture';issuedToolForScenario=false;
  const beforeAgent=(await thread(first.threadId)).turns.length;
  await command('send',{...identity,text:'Try browser capture while this page is under Human frame authorization'});
  const deniedAgent=toolResult(await nextTurn(first.threadId,beforeAgent));
  assert.ok(!deniedAgent.contentItems.some(item=>item.type==='arealMedia'));
  assert.match(JSON.stringify(deniedAgent),/human_control|host_unavailable|not_sent|尚未|接管/);
  assert.ok(!modelCalls.some(call=>call.scenario==='capture'&&call.hadImage));
  events.agentCaptureRefusal={callId:deniedAgent.callId,contentItems:deniedAgent.contentItems};
  checks.push('Real Core Agent capture receives a refusal and no image while Frame authorization is Human-only');
  const beforeUnauthorized=siteFacts.childGets;
  await app.evaluate(({webContents},{id,url})=>webContents.fromId(id).executeJavaScript(`(()=>{fetch(${JSON.stringify(url+'parent-fetch')}).catch(()=>{});const image=new Image();image.src=${JSON.stringify(url+'parent-image')};window.__probeImage=image;})()`),{id:nativeId,url:childUrl});
  await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal(siteFacts.childGets,beforeUnauthorized,'parent does not gain child fetch/image permission');
  checks.push('Parent fetch and image cannot reuse a child-frame Origin grant');
  const childScript=code=>app.evaluate(({webContents},{id,code})=>webContents.fromId(id).mainFrame.frames[0].executeJavaScript(code),{id:nativeId,code});
  await childScript("document.body.insertAdjacentHTML('beforeend','<input type=password value=synthetic>')");
  const beforeImages=modelCalls.filter(c=>c.hadImage).length;
  await assert.rejects(()=>preview('captureRegion'),/敏感|保护/);
  assert.equal(await page.locator('[data-testid="composer-attachment"], [data-testid="browser-annotation-attachments"]').count(),0);
  await childScript("document.querySelector('input').remove()");
  await app.evaluate(({webContents},id)=>{const c=webContents.fromId(id),orig=c.capturePage.bind(c);c.__frameCaptureOriginal=orig;c.capturePage=async(...args)=>{const f=c.mainFrame.frames[0];await f.executeJavaScript("document.body.insertAdjacentHTML('beforeend','<input type=password id=during value=synthetic>')");const image=await orig(...args);await f.executeJavaScript("document.querySelector('#during').remove()");c.__frameCaptureFact={capturedBytes:image.toPNG().length,sensitiveDuringCapture:true};return image;};},nativeId);
  await assert.rejects(()=>preview('captureRegion'),/变化|敏感/);
  events.duringCapture=await app.evaluate(({webContents},id)=>{const c=webContents.fromId(id);c.capturePage=c.__frameCaptureOriginal;return c.__frameCaptureFact;},nativeId);
  assert.ok(events.duringCapture.capturedBytes>0);assert.equal(modelCalls.filter(c=>c.hadImage).length,beforeImages);
  assert.equal(await page.locator('[data-testid="composer-attachment"], [data-testid="browser-annotation-attachments"]').count(),0);
  checks.push('Sensitive child and transient secret during actual capture refuse all Renderer images and Composer attachments');
  await app.evaluate(({webContents},id)=>{const c=webContents.fromId(id),send=c.debugger.sendCommand.bind(c.debugger);c.__frameSend=send;c.debugger.sendCommand=(method,...args)=>method==='Page.createIsolatedWorld'?Promise.reject(new Error('fixture isolated Frame context unavailable')):send(method,...args);},nativeId);
  await assert.rejects(()=>preview('captureRegion'),/isolated Frame context unavailable/);
  await app.evaluate(({webContents},id)=>{const c=webContents.fromId(id);c.debugger.sendCommand=c.__frameSend;},nativeId);
  assert.equal(await page.locator('[data-testid="composer-attachment"], [data-testid="browser-annotation-attachments"]').count(),0);
  events.isolatedContextFailure={injected:true,returnedImage:false,attachments:0};
  await page.evaluate(()=>{const original=URL.createObjectURL.bind(URL);globalThis.__frameBlobs=new Map();URL.createObjectURL=blob=>{const url=original(blob);globalThis.__frameBlobs.set(url,blob);return url;};});
  await page.getByRole('button',{name:'批注',exact:true}).click();
  const region=page.getByRole('region',{name:'冻结截图区域标注'});await region.waitFor();
  assert.equal(await app.evaluate(({webContents},id)=>!!webContents.fromId(id),nativeId),true,'annotation hide retains same Native');
  events.annotationHide={nativeId,retained:true};
  await region.getByText('iframe 内容无法可靠识别，请使用区域标注；未生成选择器').waitFor();
  const frozen=await region.locator('img').evaluate(img=>({src:img.src,width:img.naturalWidth,height:img.naturalHeight}));
  await writeFile(join(scratch,'native-guarded.png'),Buffer.from(frozen.src.split(',')[1],'base64'));
  const frameRect=await app.evaluate(({webContents},id)=>webContents.fromId(id).executeJavaScriptInIsolatedWorld(1001,[{code:`(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight};})()`}]),nativeId);
  const crop=[Math.round((frameRect.x+8)*frozen.width/frameRect.viewportWidth),Math.round((frameRect.y+8)*frozen.height/frameRect.viewportHeight),Math.round(200*frozen.width/frameRect.viewportWidth),Math.round(90*frozen.height/frameRect.viewportHeight)];
  assert.ok(crop[0]+crop[2]<=frozen.width&&crop[1]+crop[3]<=frozen.height,'visible child crop inside captured pixels');
  await region.getByRole('button',{name:'坐标',exact:true}).click();
  const fields=region.locator('input[type=number]');for(const [i,v] of crop.entries())await fields.nth(i).fill(String(v));
  await region.getByRole('textbox',{name:'标注意见'}).fill('FRAME_ORIGIN_REGION_REVIEW');
  await page.screenshot({path:join(scratch,'gui-region.png')});
  await region.getByRole('button',{name:'加入聊天草稿'}).click();
  await region.getByRole('button',{name:'完成',exact:true}).click();await region.waitFor({state:'detached'});
  await page.getByRole('button',{name:'1 条标注',exact:true}).click();
  const attachment=page.locator('.browser-annotation-attachment-card [data-message-attachment="image"]');await attachment.waitFor();
  const blob=await attachment.locator('img').evaluate(async img=>{await img.decode();const file=globalThis.__frameBlobs.get(img.src);if(!(file instanceof Blob))throw Error('actual crop blob absent');const hash=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());return {sha256:[...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,'0')).join(''),width:img.naturalWidth,height:img.naturalHeight};});
  assert.deepEqual([blob.width,blob.height],crop.slice(2));
  scenario='annotation';issuedToolForScenario=false;const previous=(await thread(first.threadId)).turns.length;
  await page.getByTestId('chat-send-button').click();const sent=await nextTurn(first.threadId,previous);
  const image=modelCalls.find(c=>c.scenario==='annotation'&&c.hadImage);assert.ok(image,'explicit send carried crop');assert.equal(image.imageSHA256,blob.sha256);
  events.annotation={...identity,pageId,nativeId,blob,crop,frameRect,turnId:sent.id,modelImage:image};
  events.retainedThread=await thread(first.threadId);
  checks.push('Actual Native region crop reaches existing Composer and explicit Core/model send with identical Blob SHA');
  await focus();await page.getByRole('button',{name:'撤销嵌入授权并关闭页面'}).click();
  await until(()=>app.evaluate(({webContents},id)=>!webContents.fromId(id),nativeId),'Native destroyed on revoke');
  events.revoked={nativeId,destroyed:true};checks.push('Explicit revoke destroys the granted Native WebContents');

  if (process.argv.includes('boundaries')) {
    async function restore() {
      pageId=undefined; await preview('newPage'); pageId=(await preview('state')).browser.pageId;
      await preview('selectPage');await preview('show',{visible:true,bounds:{x:700,y:330,width:600,height:500}});
      await focus();
      if(sitePolicy==='connection'){await preview('navigate',{url:siteUrl});return null;}
      await preview('navigate',{url:siteUrl});
      return until(()=>app.evaluate(({webContents},url)=>webContents.getAllWebContents().find(c=>c.getURL()===url)?.id,siteUrl),'restored parent');
    }
    async function waitIdle(id){await until(()=>app.evaluate(({webContents},id)=>{const c=webContents.fromId(id);return c&&!c.isLoading()&&c.mainFrame.frames.length>0;},id),'idle document');await focus();}
    for (const policy of ['csp','connection']) {
      sitePolicy=null;
      const id=await restore();await waitIdle(id);await preview('authorizeFrameOrigin',{userIntent:true});sitePolicy=policy;
      const before=siteFacts.childGets;await preview('reloadFrameOrigin',{userIntent:true});
      await until(async()=>{const st=await preview('state');return !st.loading;},'strict site policy settled');
      await new Promise(resolve=>setTimeout(resolve,150));assert.equal(siteFacts.childGets,before,'strict site policy not replaced');
      events['sitePolicy-'+policy]={before,after:siteFacts.childGets,state:await preview('state')};
      await preview('revokeFrameOrigin',{userIntent:true});await until(()=>app.evaluate(({webContents},id)=>!webContents.fromId(id),id),'strict site Native closed');
    }
    sitePolicy='connection';
    const initialStrict=await restore();
    await until(async()=>!!(await preview('state')).error,'initial site Connection-Allowlist refusal');
    events.initialStrictConnection=await preview('state');assert.ok(events.initialStrictConnection.error);
    await preview('release',{userIntent:true});
    sitePolicy=null;
    let boundaryId=await restore();await waitIdle(boundaryId);
    await app.evaluate(()=>globalThis.__framePromptMode='cancel');
    await assert.rejects(()=>preview('authorizeFrameOrigin',{userIntent:true}),/取消|失效/);
    assert.equal((await preview('state')).browser.frameOriginGrant,null);
    await app.evaluate(()=>globalThis.__framePromptMode='hold');
    const held=preview('authorizeFrameOrigin',{userIntent:true}).then(()=>({accepted:true}),e=>({error:e.message}));
    await until(()=>app.evaluate(()=>!!globalThis.__framePromptRelease),'held actual Main prompt');
    await app.evaluate(({webContents},id)=>webContents.fromId(id).executeJavaScript("history.pushState({},'', '/changed')"),boundaryId);
    await app.evaluate(()=>{globalThis.__framePromptMode=null;globalThis.__framePromptRelease();globalThis.__framePromptRelease=null;});
    const stale=await held;assert.match(stale.error??'',/失效/);assert.equal((await preview('state')).browser.frameOriginGrant,null);
    events.stalePrompt=stale;checks.push('Actual Main prompt cancellation and parent document change reject late approval');
    await preview('navigate',{url:siteUrl});await waitIdle(boundaryId);await preview('authorizeFrameOrigin',{userIntent:true});
    const pendingState=await preview('state');assert.equal(pendingState.browser.frameOriginGrant.status,'pending');
    await app.evaluate(({webContents},id)=>webContents.fromId(id).executeJavaScript("history.pushState({},'', '/pending-changed')"),boundaryId);
    await until(()=>app.evaluate(({webContents},id)=>!webContents.fromId(id),boundaryId),'pending grant document closed');
    await assert.rejects(()=>preview('reloadFrameOrigin',{userIntent:true}),/授权|页面/);
    await preview('release',{userIntent:true});
    boundaryId=await restore();await waitIdle(boundaryId);await preview('authorizeFrameOrigin',{userIntent:true});await preview('reloadFrameOrigin',{userIntent:true});
    await until(async()=>(await preview('state')).browser.frameOriginGrant?.status==='active','boundary active');
    const tokenCapture=await preview('captureRegion');
    await preview('hide',{captureId:tokenCapture.captureId});
    assert.equal(await app.evaluate(({webContents},id)=>!!webContents.fromId(id),boundaryId),true);
    await preview('hide',{captureId:'stale-capture-id'});
    await until(()=>app.evaluate(({webContents},id)=>!webContents.fromId(id),boundaryId),'invalid capture token closes granted Native');
    events.invalidAnnotationHide={nativeId:boundaryId,destroyed:true};
    await preview('release',{userIntent:true});
    boundaryId=await restore();await waitIdle(boundaryId);await preview('authorizeFrameOrigin',{userIntent:true});await preview('reloadFrameOrigin',{userIntent:true});
    await until(async()=>(await preview('state')).browser.frameOriginGrant?.status==='active','close preview active');
    const originalPageId=pageId, originalThread=identity.threadId;
    const other=await command('create',{projectId:project.id,browserEnabled:true,profile:{id:'fixture',revision:'v1'}});
    await assert.rejects(()=>page.evaluate(q=>window.arealDesktop.preview(q),{operation:'captureRegion',projectId:project.id,threadId:other.threadId,pageId:originalPageId}),/页面/);
    await page.getByRole('button',{name:'批注',exact:true}).click();
    await page.getByRole('region',{name:'冻结截图区域标注'}).waitFor();
    assert.equal(await app.evaluate(({webContents},id)=>!!webContents.fromId(id),boundaryId),true);
    if(await page.getByRole('button',{name:'进入分屏视图',exact:true}).count()) await page.getByRole('button',{name:'进入分屏视图',exact:true}).click();
    await page.getByRole('button',{name:'关闭面板',exact:true}).click();await page.locator('.preview-panel').waitFor({state:'detached'});
    await until(()=>app.evaluate(({webContents},id)=>!webContents.fromId(id),boundaryId),'ordinary unmount destroys grant despite frozen capture');
    await selectConversation(page,other.threadId);
    assert.equal(await page.locator('.preview-panel').count(),0,'Thread switch without opening a preview');
    assert.equal(await app.evaluate(({webContents},id)=>!!webContents.fromId(id),boundaryId),false);
    events.closedPreviewThreadSwitch={nativeId:boundaryId,destroyed:true,otherPreviewOpen:false};
    await page.keyboard.press('Meta+t');await page.locator('.preview-panel').waitFor();
    const prevB=siteFacts.childGets;const otherIdentity={projectId:project.id,threadId:other.threadId};
    await focus();await page.evaluate(q=>window.arealDesktop.preview(q),{...otherIdentity,operation:'navigate',url:siteUrl});
    const otherNative=await until(()=>app.evaluate(({webContents},url)=>webContents.getAllWebContents().find(c=>c.getURL()===url)?.id,siteUrl),'other Native');
    await waitIdle(otherNative);assert.equal(siteFacts.childGets,prevB,'other Thread cannot reuse child grant');
    const otherState=await page.evaluate(q=>window.arealDesktop.preview(q),{...otherIdentity,operation:'state'});
    assert.equal(otherState.browser.frameOriginGrant,null);
    events.otherThread={threadId:other.threadId,nativeId:otherNative,childGetsBefore:prevB,childGetsAfter:siteFacts.childGets};
    await page.evaluate(q=>window.arealDesktop.preview(q),{...otherIdentity,operation:'release',pageId:otherState.browser.pageId,userIntent:true});
    await selectConversation(page,originalThread);
    checks.push('Pending document generation revokes; annotation hide retains Native but invalid capture token or unmount destroys it; Thread switch without new preview retains no grant; other Thread cannot inherit permission');
  }
  events.prompts=await app.evaluate(()=>globalThis.__framePrompts);events.promptSubstitution='fixture exact Main dialog allow; not human acceptance';
  assert.deepEqual(errors,[]);passed=true;
} catch (error) {
  errors.push(error.stack ?? String(error));
  if (page) await captureSmokeFailure(page, scratch, error);
  throw error;
} finally {
  if (app) await app.close();
  site.closeAllConnections(); sibling.closeAllConnections(); model.closeAllConnections();
  await Promise.all([new Promise(resolve => site.close(resolve)), new Promise(resolve => sibling.close(resolve)), new Promise(resolve => model.close(resolve))]);
  const files = ['app/src/core/browser-tool.cjs', 'app/src/core/backend.cjs', 'app/src/core/service-protocol.cjs',
    'app/src/core/preview.cjs', 'app/src/core/main.cjs', 'renderer/src/Messages.tsx', 'renderer/src/ToolEvent.tsx',
    'app/src/core/browser-network.cjs', 'packages/workbench/client/desktop-contract.cjs', 'renderer/src/Preview.tsx', 'scripts/browser-frame-origin-smoke.mjs'];
  const hashes = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(join(gui, file))).digest('hex')])));
  await writeFile(join(scratch, 'manifest.json'), JSON.stringify({ passed, checks, errors, events, modelCalls,
    startedAt, finishedAt: new Date().toISOString(), command: `node clients/gui/scripts/browser-frame-origin-smoke.mjs ${frameKind}`,
    fixture: 'synthetic site and deterministic local chat-completions model in this script',
    source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    diffSHA256: createHash('sha256').update(execFileSync('git', ['diff', 'HEAD'], { cwd: root })).digest('hex'),
    hashes, coreBinary: env.AREAL_CORE_BIN,
    coreBinarySHA256: createHash('sha256').update(await readFile(env.AREAL_CORE_BIN)).digest('hex'),
    scope: 'source Electron + Core/Runtime + independent adapter + deterministic model + synthetic sites' }, null, 2));
  console.log(JSON.stringify({ passed, evidence: scratch, checks, errors }));
}
