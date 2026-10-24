const { app, BrowserWindow, WebContentsView, nativeImage } = require('electron');
const { createServer } = require('node:http');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');
const { CorePreview } = require('../../../app/src/core/preview.cjs');
const scratch = mkdtempSync(join(tmpdir(), 'areal-browser-integration-'));
const workspace = join(scratch, 'workspace'); mkdirSync(workspace);
app.setPath('userData', join(scratch, 'user'));
const facts = [];
const server = createServer((req, res) => {
  if (req.url === '/download') { res.setHeader('content-disposition', 'attachment; filename="fixture.txt"'); res.end('browser download truth'); return; }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (req.url === '/frame') { res.end('<label>Frame draft<input id="frame-draft"></label><button id="frame-button" onclick="this.textContent=\'Frame clicked\'">Frame action</button>'); return; }
  res.end(`<!doctype html><title>Browser command fixture</title><style>body{margin:16px;background:rgb(30,180,80)}button,input,select{margin:8px;padding:5px}a{display:block;width:max-content;padding:8px}</style>
  <label>Draft<input id="draft"></label><button id="action" onclick="window.clicks=(window.clicks||0)+1;this.textContent='Clicked '+window.clicks">Run action</button>
  <label>Choice<select id="choice"><option value="a">Alpha</option><option value="b">Beta</option></select></label>
  <label>Enable<input id="check" type="checkbox"></label><a id="download" href="/download" download>Download fixture</a>
  <iframe style="display:block" src="http://localhost:${server.address().port}/frame"></iframe><div style="height:1600px"></div><p id="bottom">Full page capture truth</p>`);
});
let window, preview;
const until = async (predicate, label, budget = 15000) => { const end=Date.now()+budget; for (;;) { if(await predicate()) return; if(Date.now()>end) throw new Error(label); await new Promise(r=>setTimeout(r,50)); } };
app.whenReady().then(async () => {
  const watchdog=setTimeout(()=>{console.error('integration deadline');app.exit(1)},150000);watchdog.unref();
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  window = new BrowserWindow({show:false,width:900,height:700,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await window.loadURL('data:text/html,<title>Isolated owner</title>');
  preview = new CorePreview(window,WebContentsView,()=>true,()=>({}),()=> 'core-test');
  const revocations = [];
  preview.onRevoke = event => revocations.push(event.pageId);
  const page=preview.create(JSON.stringify(['core-test','project','thread','page']),'project','thread',{id:'page',origin:'agent'});
  page.view.webContents.on('console-message',details=>console.log('fixture-console',details.message));
  page.view.setBounds({x:0,y:0,width:640,height:480});
  await page.view.webContents.loadURL(`http://browser-fixture.localhost:${server.address().port}/`);
  await preview.claim('project','thread','page');
  const req = command => ({coreInstanceId:'core-test',coreGeneration:1,projectId:'project',threadId:'thread',turnId:'turn',callId:crypto.randomUUID(),requestId:crypto.randomUUID(),operation:'command',pageId:'page',browserHostId:preview.browserHostId,hostGeneration:preview.hostGeneration,pageGeneration:page.pageGeneration,controlEpoch:page.controlEpoch,workspacePath:workspace,parameters:{pageId:'page',command}});
  const call = async (command, check=true) => {
    if(command.method!=='recordingStatus')console.log('run',command.method,command.action?.name,command.action?.operation);
    const request=req(command), prepared=await preview.prepare({...request,phase:'prepare'});
    const result=await preview.execute({...request,phase:'execute',browserApproval:{plan:prepared.plan}});
    if(check)assert.equal(result.commandResult.ok,true,JSON.stringify(result.commandResult));
    facts.push({method:command.method,action:command.action?.name,operation:command.action?.operation,ok:result.commandResult.ok});
    return result.commandResult;
  };
  const locator=(selector,operation,extra={})=>call({method:'playwright',action:{name:'locator',selector,operation,...extra}});
  assert.match((await call({method:'playwright',action:{name:'domSnapshot'}})).value,/Draft/);
  await locator('#draft','fill',{value:'你好 browser'}); assert.equal(await page.view.webContents.executeJavaScript('document.querySelector("#draft").value'),'你好 browser');
  await locator('internal:role=button[name="Run action"s]','click'); assert.equal(await page.view.webContents.executeJavaScript('window.clicks'),1);
  await locator('#check','setChecked',{checked:true}); assert.equal(await page.view.webContents.executeJavaScript('document.querySelector("#check").checked'),true);
  await locator('#choice','selectOption',{selections:[{value:'b'}]}); assert.equal(await page.view.webContents.executeJavaScript('document.querySelector("#choice").value'),'b');
  await locator('iframe >> internal:control=enter-frame >> #frame-draft','fill',{value:'Frame truth'});
  assert.equal((await locator('iframe >> internal:control=enter-frame >> #frame-draft','evaluate',{expressionKind:'function',expression:'element=>element.value'})).value,'Frame truth');
  const bounds=await page.view.webContents.executeJavaScript('(()=>{const r=document.querySelector("#action").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
  await call({method:'click',...bounds}); assert.equal(await page.view.webContents.executeJavaScript('window.clicks'),2);
  const focus=BrowserWindow.getFocusedWindow();
  for(const command of [{method:'screenshot'},{method:'screenshot',fullPage:true},{method:'screenshot',clip:{x:0,y:0,width:240,height:140}},{method:'playwright',action:{name:'elementScreenshot',...bounds}}]){
    const result=await call(command);const img=nativeImage.createFromBuffer(Buffer.from(result.image.base64,'base64'));assert.ok(img.getSize().width>0); if(command.clip)assert.deepEqual(img.getSize(),{width:240,height:140}); if(command.fullPage)assert.ok(img.getSize().height>480); assert.equal(BrowserWindow.getFocusedWindow(),focus);assert.equal(window.isVisible(),false);
    writeFileSync(join(scratch,`capture-${facts.length}.png`),img.toPNG());
  }
  await call({method:'browserViewportSet',width:700,height:500});
  assert.equal(await page.view.webContents.executeJavaScript('innerWidth'),700); await call({method:'browserViewportReset'});
  await call({method:'evaluate',expression:'(()=>{setTimeout(()=>{window.answer=confirm("Fixture dialog")},50); return "scheduled"})()'});
  await until(()=>page.commandDialog,'dialog appeared');assert.equal((await call({method:'getDialog'})).dialog.message,'Fixture dialog');
  await call({method:'handleDialog',accept:true,promptText:'accepted'});assert.equal(await page.view.webContents.executeJavaScript('window.answer'),true);
  await call({method:'evaluate',expression:'(()=>{setTimeout(()=>{alert("Fixture alert");window.alertHandled=true},50);return "scheduled"})()'});
  await until(()=>page.commandDialog,'alert appeared');assert.equal((await call({method:'getDialog'})).dialog.type,'alert');
  await call({method:'handleDialog',accept:true});assert.equal(await page.view.webContents.executeJavaScript('window.alertHandled'),true);
  await locator('#download','click');
  const download=await call({method:'playwright',action:{name:'waitForEvent',event:'download',timeoutMs:5000}});
  const path=await call({method:'playwright',action:{name:'downloadPath',downloadId:download.value.id,timeoutMs:5000}});assert.equal(readFileSync(path.value,'utf8'),'browser download truth');
  await locator('#download','downloadMedia');
  const mediaDownload=await call({method:'playwright',action:{name:'waitForEvent',event:'download',timeoutMs:5000}});
  const mediaPath=await call({method:'playwright',action:{name:'downloadPath',downloadId:mediaDownload.value.id,timeoutMs:5000}});
  assert.equal(readFileSync(mediaPath.value,'utf8'),'browser download truth');
  const unsupported=await call({method:'playwright',action:{name:'waitForEvent',event:'filechooser'}},false);assert.equal(unsupported.error.code,'capability_unsupported');
  const recording=await call({method:'recordingStart',options:{maxDurationMs:10000,actions:[{type:'click',selector:'#action'},{type:'wait',durationMs:1200}]}});
  let status;
  await until(async()=>{status=await call({method:'recordingStatus',recordingId:recording.recording.id});return status.recording.status!=='running'},'recording completed',30000);
  assert.equal(status.recording.status,'completed',JSON.stringify(status));
  status=await call({method:'recordingStatus',recordingId:recording.recording.id,outputPath:'artifacts/acceptance.webm'});
  const repeated=await call({method:'recordingStatus',recordingId:recording.recording.id,outputPath:'artifacts/acceptance.webm'});assert.equal(repeated.recording.artifact.path,status.recording.artifact.path);
  const videoData=readFileSync(status.recording.artifact.path);assert.ok(videoData.length>1000);assert.equal(videoData.subarray(0,4).toString('hex'),'1a45dfa3');
  const player=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await player.loadURL('data:text/html,<video muted></video>');
  const playback=await player.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const video=document.querySelector('video');video.onloadeddata=()=>resolve({width:video.videoWidth,height:video.videoHeight,ready:video.readyState});video.onerror=()=>reject(new Error('WebM playback failed'));video.src='data:video/webm;base64,${videoData.toString('base64')}';video.load()})`);
  assert.ok(playback.width>0 && playback.height>0);player.destroy();
  const second=await call({method:'recordingStart',options:{maxDurationMs:10000,actions:[{type:'wait',durationMs:8000}]}});
  const cancelled=await call({method:'recordingCancel',recordingId:second.recording.id});assert.equal(cancelled.recording.status,'cancelled');
  const request=req({method:'click',...bounds}), prepared=await preview.prepare({...request,phase:'prepare'});
  await assert.rejects(()=>preview.execute({...request,phase:'execute',parameters:{pageId:'page',command:{method:'click',x:1,y:1}},browserApproval:{plan:prepared.plan}}),/plan_stale/);
  const child=await call({method:'newTab'});assert.ok(child.tab.tabId);await call({method:'markDeliverable',tabId:child.tab.tabId});
  await call({method:'finalizeTabs',keep:[{tabId:'page',status:'deliverable'}]});assert.equal(preview.workspacePages('project','thread').length,1);
  assert.ok(!revocations.includes(child.tab.tabId),'approved closure defers Core claim removal to its receipt');
  const beforePrivate=await page.view.webContents.executeJavaScript('window.clicks');
  await page.view.webContents.executeJavaScript('document.body.insertAdjacentHTML("beforeend","<input id=private-field type=password value=fixture-secret>")');
  await assert.rejects(()=>call({method:'click',...bounds}),/human_takeover_required/);assert.equal(await page.view.webContents.executeJavaScript('window.clicks'),beforePrivate);
  await page.view.webContents.executeJavaScript('document.querySelector("#private-field").remove()');
  const replay=req({method:'getState'}),replayPlan=await preview.prepare({...replay,phase:'prepare'});
  await preview.execute({...replay,phase:'execute',browserApproval:{plan:replayPlan.plan}});await assert.rejects(()=>preview.execute({...replay,phase:'execute',browserApproval:{plan:replayPlan.plan}}),/plan_stale/);
  const waiting=req({method:'playwright',action:{name:'locator',selector:'#never',operation:'click',timeoutMs:10000}}), waitPlan=await preview.prepare({...waiting,phase:'prepare'});
  const running=preview.execute({...waiting,phase:'execute',browserApproval:{plan:waitPlan.plan}});
  setTimeout(()=>preview.revoke(page),100);await assert.rejects(()=>running,/outcome_unknown|not_sent/);await until(()=>page.control==='human','takeover converged');
  assert.equal(page.heldKeys.size,0);assert.equal(page.heldButtons.size,0);
  writeFileSync(join(scratch,'RESULT.json'),JSON.stringify({electron:process.versions.electron,facts,playback,recording:status.recording.artifact,scratch},null,2));
  console.log('PASS '+join(scratch,'RESULT.json'));
}).then(()=>{for(const key of [...preview.pages.keys()])preview.release(key);window.destroy();server.close();app.quit()}).catch(error=>{console.error(error);server.close();app.exit(1)});
