const { app, BrowserWindow, WebContentsView, session } = require('electron');
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { CorePreview } = require('../../../app/src/core/preview.cjs');
const { sharedBrowserProfile } = require('../../../app/src/core/shared-browser-profile.cjs');
const [phase, profile, origin, controlOrigin, scratch] = process.argv.slice(2);
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
const hosts = [], windows = [], evidence = [];
const newHost = id => {
  const win = new BrowserWindow({ show:false, webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false} });
  windows.push(win);
  const preview = new CorePreview(win,WebContentsView,()=>true,()=>({}),()=>`core-${id}`,()=>[controlOrigin]);
  hosts.push(preview); return preview;
};
const newPage = async (host, project, path='/') => {
  const id = crypto.randomUUID(), core = host.coreIdentity(project);
  const page = host.create(JSON.stringify([core,project,'thread',id]),project,'thread',{id,origin:'agent'});
  page.view.setBounds({x:0,y:0,width:640,height:480});
  await page.view.webContents.loadURL(origin+path); return page;
};
const request = (host,page,command) => ({coreInstanceId:page.coreInstanceId,coreGeneration:1,projectId:page.projectId,threadId:'thread',turnId:'turn',callId:crypto.randomUUID(),requestId:crypto.randomUUID(),operation:'command',pageId:page.id,browserHostId:host.browserHostId,hostGeneration:host.hostGeneration,pageGeneration:page.pageGeneration,controlEpoch:page.controlEpoch,parameters:{pageId:page.id,command}});
const call = async(host,page,command) => {
  const req=request(host,page,command), prepared=await host.prepare({...req,phase:'prepare'});
  const result=await host.execute({...req,phase:'execute',browserApproval:{plan:prepared.plan}});
  assert.equal(result.commandResult.ok,true,JSON.stringify(result.commandResult));return result.commandResult;
};
const stored = page => page.view.webContents.executeJavaScript(`(async()=>({ cookie:await fetch('/cookie').then(r=>r.text()), local:localStorage.getItem('profile-fixture'), imported:localStorage.getItem('imported-fixture'), cache:await caches.has('profile-cache'), db:await new Promise((resolve,reject)=>{const open=indexedDB.open('profile-db',1);open.onupgradeneeded=()=>open.result.createObjectStore('facts');open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result, request=db.transaction('facts').objectStore('facts').get('fact');request.onsuccess=()=>{db.close();resolve(request.result??null)};request.onerror=()=>reject(request.error)}}) }))()`);
const setStored = page => page.view.webContents.executeJavaScript(`(async()=>{localStorage.setItem('profile-fixture','synthetic');await (await caches.open('profile-cache')).put('/cache-truth',new Response('cache'));await new Promise((resolve,reject)=>{const open=indexedDB.open('profile-db',1);open.onupgradeneeded=()=>open.result.createObjectStore('facts');open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result,tx=db.transaction('facts','readwrite');tx.objectStore('facts').put('synthetic','fact');tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error)}});return true})()`);
const assertStored = facts => {assert.match(facts.cookie,/profile-fixture=synthetic/);assert.equal(facts.local,'synthetic');assert.equal(facts.db,'synthetic');};
app.whenReady().then(async()=>{
  const deadline=setTimeout(()=>{console.error('shared profile deadline');app.exit(1)},120000);deadline.unref();
  const a=newHost('a');
  assert.deepEqual(await a.browserData('status'),{persistent:true,shared:true,busy:false});
  assert.equal(sharedBrowserProfile.targetSession,null,'status does not initialize Chromium storage');
  if(phase==='seed'){
    const pa=await newPage(a,'project-a','/set');await setStored(pa);
    const b=newHost('b'),pb=await newPage(b,'project-b');
    assert.equal(pa.session,pb.session);assert.ok(pa.session.storagePath);assert.equal(pa.session.listenerCount('will-download'),1);
    assertStored(await stored(pb));assert.equal(await pb.view.webContents.executeJavaScript('document.cookie'),'');
    assert.equal((await session.defaultSession.cookies.get({url:origin})).length,0);
    assert.equal((await session.fromPartition('persist:other-fixture').cookies.get({url:origin})).length,0);
    for(const [host,page] of [[a,pa],[b,pb]]){
      await host.claim(page.projectId,'thread',page.id);
      await call(host,page,{method:'playwright',action:{name:'locator',selector:'#download',operation:'click'}});
      const download=await call(host,page,{method:'playwright',action:{name:'waitForEvent',event:'download',timeoutMs:5000}});
      const result=await call(host,page,{method:'playwright',action:{name:'downloadPath',downloadId:download.value.id,timeoutMs:5000}});
      assert.equal(readFileSync(result.value,'utf8'),'shared profile download');
    }
    await a.dispose();assertStored(await stored(pb));
    const reopened=await newPage(a,'reopened-project');assertStored(await stored(reopened));
    await a.browserData('clearCache');assert.equal(a.pages.size,0);assert.equal(b.pages.size,0);
    const resumed=await newPage(b,'project-b');assertStored(await stored(resumed));await setStored(resumed);
    await resumed.view.webContents.loadURL(origin);
    assert.equal(await resumed.view.webContents.executeJavaScript(`fetch(${JSON.stringify(controlOrigin)}).then(()=>true).catch(()=>false)`),false);
    const unknown=new BrowserWindow({show:false,webPreferences:{session:resumed.session,sandbox:true}});windows.push(unknown);
    await assert.rejects(()=>unknown.loadURL(origin+'/unknown'));unknown.destroy();
    assert.equal(resumed.session.listenerCount('will-download'),1);
    evidence.push('two hosts share HTTPOnly Cookie, LS, IDB','download routing once per source','host closure retains site data and reopened host joins global data quiescence','unknown WebContents and product endpoints denied');
  }else if(phase==='isolated'){
    const p=await newPage(a,'isolated-project');const facts=await stored(p);
    assert.equal(facts.cookie,'');assert.equal(facts.local,null);assert.equal(facts.db,null);
    evidence.push('different userData has no shared profile state');
  }else{
    const p=await newPage(a,'restored-project');assertStored(await stored(p));assert.equal((await stored(p)).cache,true);
    await a.claim(p.projectId,'thread',p.id);
    const req=request(a,p,{method:'getState'}),prepared=await a.prepare({...req,phase:'prepare'});
    let finishImport,entered;const entering=new Promise(resolve=>entered=resolve);
    const mutation=a.browserData('importChrome',{importChrome:async({targetSession,registerWebContents})=>{
      entered();await new Promise(resolve=>finishImport=resolve);
      const helper=new BrowserWindow({show:false,webPreferences:{session:targetSession,sandbox:true,contextIsolation:true,nodeIntegration:false}});windows.push(helper);
      const unregister=registerWebContents(helper.webContents);
      try{await helper.loadURL(origin+'/import');await helper.webContents.executeJavaScript('localStorage.setItem("imported-fixture","synthetic")');await targetSession.cookies.set({url:origin,name:'imported-fixture',value:'synthetic',expirationDate:Math.floor(Date.now()/1000)+3600});return {success:true,imported:2};}
      finally{helper.destroy();unregister();}
    }});
    assert.equal((await a.browserData('status')).busy,true);
    await assert.rejects(()=>a.browserData('clearAll'),/browser_profile_busy/);
    assert.throws(()=>a.create('late','restored-project','thread'),/browser_profile_busy/);
    await assert.rejects(()=>a.claim(p.projectId,'thread',p.id),/browser_profile_busy/);
    await assert.rejects(()=>a.execute({...req,phase:'execute',browserApproval:{plan:prepared.plan}}),/browser_profile_busy/);
    await entering;assert.equal(a.pages.size,0);finishImport();assert.deepEqual(await mutation,{success:true,imported:2});
    await assert.rejects(()=>a.execute({...req,phase:'execute',browserApproval:{plan:prepared.plan}}),/plan_stale/);
    let abandoned,abandonedContents;
    await assert.rejects(()=>a.browserData('importChrome',{importChrome:async({targetSession,registerWebContents})=>{
      abandoned=new BrowserWindow({show:false,webPreferences:{session:targetSession,sandbox:true,contextIsolation:true,nodeIntegration:false}});windows.push(abandoned);
      abandonedContents=abandoned.webContents;registerWebContents(abandonedContents);await abandoned.loadURL(origin+'/abandoned-import');throw new Error('fixture_import_failed');
    }}),/fixture_import_failed/);
    assert.equal(abandonedContents.isDestroyed(),true,'failed importer must be destroyed before releasing the data gate');
    const imported=await newPage(a,'imported-project');assertStored(await stored(imported));assert.equal((await stored(imported)).imported,'synthetic');
    await a.browserData('clearCache');assert.equal(a.pages.size,0);
    const cached=await newPage(a,'cached-project');assertStored(await stored(cached));assert.equal((await stored(cached)).cache,false);
    await a.browserData('clearAll');assert.equal(a.pages.size,0);
    const empty=await newPage(a,'empty-project');const facts=await stored(empty);
    assert.equal(facts.cookie,'');assert.equal(facts.local,null);assert.equal(facts.imported,null);assert.equal(facts.db,null);
    evidence.push('independent process restores Cookie, LS, IDB and cache','data gate rejects concurrent and late work','trusted synthetic importer shares target Session','cache clearing preserves login data','all clearing removes Cookie, LS and IDB');
  }
  for(const host of hosts)await host.dispose();
  for(const win of windows)if(!win.isDestroyed())win.destroy();
  writeFileSync(join(scratch,`${phase}.json`),JSON.stringify({phase,electron:process.versions.electron,evidence},null,2));
  console.log('PASS shared profile '+phase);app.quit();
}).catch(error=>{console.error(error);app.exit(1)});
