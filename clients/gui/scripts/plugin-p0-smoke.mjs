import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pluginResourceReply,verifyPluginResourceSlice} from './plugin-resource-smoke.mjs';
import {assertApplicationStopped} from './application-cleanup.mjs';
import {captureSmokeFailure,createProjectConversation,selectConversation} from './smoke-navigation.mjs';
const gui=resolve(dirname(fileURLToPath(import.meta.url)),'..'),require=createRequire(join(gui,'app/package.json'));
const {_electron:electron}=require('playwright-core');
const scratch=await mkdtemp('/private/tmp/areal-plugin-gui-'),workspace=join(scratch,'workspace'),userHome=join(scratch,'user');
await mkdir(join(workspace,'.agents','plugins'),{recursive:true});await mkdir(join(userHome,'.areal'),{recursive:true});
execFileSync('git',['init','-b','main'],{cwd:workspace,stdio:'ignore'});
const source=join(workspace,'packages','hello');await mkdir(join(source,'skills','setup'),{recursive:true});
await writeFile(join(source,'plugin.json'),JSON.stringify({$schema:'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
name:'hello',version:'1.0.0',description:'A local package fixture.',extensions:{'com.openai':{commands:{review:{command:'DO_NOT_RUN'}},agents:{reviewer:{prompt:'DO_NOT_RUN'}},ui:{surfaces:{panel:{entry:'DO_NOT_RENDER'}}},interface:{displayName:'Hello Plugin'},onboardingSkill:'./skills/setup/SKILL.md'}}}));
await writeFile(join(source,'skills','setup','SKILL.md'),'---\nname: setup\ndescription: Configure the hello fixture.\n---\nGUI_PLUGIN_SETUP_BODY_MARKER\n');
await writeFile(join(workspace,'.agents','plugins','marketplace.json'),JSON.stringify({name:'gui-p0',plugins:[{name:'hello',source:{source:'local',path:'./packages/hello'},policy:{installation:'AVAILABLE',authentication:'ON_USE'},category:'Productivity'}]}));
const sourceRoot=resolve(gui,'../..');
const sourceFiles={};
for(const path of new Set(execFileSync('git',['ls-files','--modified','--others','--exclude-standard','-z'],{cwd:sourceRoot}).toString().split('\0').filter(Boolean))){
if(/^(core\/|clients\/|scripts\/|schemas\/|Cargo\.|upstream\/)/.test(path)){try{sourceFiles[path]=createHash('sha256').update(await readFile(join(sourceRoot,path))).digest('hex');}catch(error){if(error.code!=='ENOENT')throw error;sourceFiles[path]=null;}}}
const sourceDiffSha256=createHash('sha256').update(execFileSync('git',['diff','--binary','HEAD'],{cwd:sourceRoot,maxBuffer:32*1024*1024})).digest('hex');
const resourceSlice=process.argv.includes('--resource-slice'),manual=resourceSlice&&process.argv.includes('--manual');
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:gui,encoding:'utf8'}).trim();
const requests=[],checks=[],errors=[];
const namingRequest=body=>body.messages?.some(message=>message.role==='system'&&String(message.content).startsWith('Generate a concise semantic session title'));
const setupRequests=()=>requests.filter(body=>!namingRequest(body));
const model=createServer(async(req,res)=>{let body='';for await(const p of req)body+=p;const parsed=JSON.parse(body);requests.push(parsed);res.writeHead(200,{'Content-Type':'text/event-stream'});
res.end('data: '+JSON.stringify({choices:[{index:0,delta:{content:namingRequest(parsed)?'Plugin setup':resourceSlice?pluginResourceReply:'GUI_PLUGIN_SETUP_OK'},finish_reason:null}]})+'\n\n'+'data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');});
await new Promise(r=>model.listen(0,'127.0.0.1',r));
await writeFile(join(userHome,'.areal','config.toml'),'schema_version=1\n[model]\nname="fixture"\n[model.providers.default]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:'+model.address().port+'"\n');
const env={...process.env,AREAL_GUI_USER_DATA:join(scratch,'electron'),AREAL_CORE_HOME:join(scratch,'core'),AREAL_CORE_USER_HOME:userHome,
AREAL_HARNESS_SERVICE_HOME:join(scratch,'registry'),AREAL_CORE_BIN:process.env.AREAL_CORE_BIN??resolve(gui,'../../target/debug/areal')};
for(const k of ['AREAL_CORE_WORKSPACE','AREAL_CORE_CONFIG','AREAL_HARNESS_HOME','AREAL_HARNESS_CONFIG','AREAL_CORE_DESKTOP_CONFIG'])delete env[k];
const coreBinary=env.AREAL_CORE_BIN,coreSha256=createHash('sha256').update(await readFile(coreBinary)).digest('hex');
const fixtureApp=join(scratch,'app'),mainErrorsPath=join(scratch,'main-errors.jsonl');
await mkdir(fixtureApp);await writeFile(mainErrorsPath,'');
await writeFile(join(fixtureApp,'package.json'),JSON.stringify({name:'plugin-support-fixture',main:'bootstrap.cjs'}));
await writeFile(join(fixtureApp,'bootstrap.cjs'),`process.on('uncaughtExceptionMonitor',(error,origin)=>require('node:fs').appendFileSync(${JSON.stringify(mainErrorsPath)},JSON.stringify({pid:process.pid,origin,name:error.name,message:error.message,stack:error.stack})+'\\n'));require(${JSON.stringify(join(gui,'app/src/main.cjs'))});`);
let app,page,appProcess,failure,passed=false,electronStderr="",runtimeIdentity=null,automaticAcceptancePassed=false,manualCloseListeners=null;
const manualHandoff={requested:manual,state:manual?"pending-acceptance":"not-requested"};
const buildFiles={};
const button=n=>page.getByRole('button',{name:n,exact:true});
const state=()=>page.evaluate(()=>window.arealDesktop.snapshot());
async function until(fn,label){const end=Date.now()+30_000;while(Date.now()<end){const s=await state();if(fn(s))return s;await new Promise(r=>setTimeout(r,75));}throw Error('timeout: '+label);}
async function call(name,params){const r=await page.evaluate(({name,params})=>window.arealDesktop.command(name,params),{name,params});assert(r.ok,JSON.stringify(r));return r.value;}
async function pluginState(predicate,label){const end=Date.now()+30_000;while(Date.now()<end){
const row=(await call('manage',{projectId:await page.getByTestId('areal-workbench').getAttribute('data-project-id'),operation:'plugins'})).data.find(x=>x.id==='hello@gui-p0');
if(predicate(row))return row;await new Promise(r=>setTimeout(r,75));}throw Error('timeout: '+label);}
async function settings(){await page.getByRole('navigation',{name:'应用导航',exact:true}).getByRole('button',{name:'插件',exact:true}).click();await page.getByRole('tablist',{name:'市场范围',exact:true}).getByRole('tab',{name:'个人',exact:true}).click();await page.getByRole('button',{name:'查看插件 hello@gui-p0',exact:true}).click();}
const { builtinSkill, BUILTIN_SKILL_ID } = require('../app/src/core/builtin-skills.cjs');
await builtinSkill(join(scratch, 'core'), BUILTIN_SKILL_ID);
try{
app=await electron.launch({executablePath:require('electron'),args:[fixtureApp],env,timeout:120_000});
page=await app.firstWindow();appProcess=app.process();appProcess.stderr?.on('data',chunk=>{electronStderr+=chunk.toString();});page.setDefaultTimeout(20_000);page.on('pageerror',e=>errors.push(e.message));
await page.getByTestId('areal-workbench').waitFor({timeout:120_000});await until(s=>s.connection?.state==='ready','desktop ready');
await app.evaluate(({dialog,BrowserWindow},path)=>{globalThis.pluginFixtureDialogs={showOpenDialog:dialog.showOpenDialog,showMessageBox:dialog.showMessageBox};dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]});dialog.showMessageBox=async()=>({response:1});BrowserWindow.getAllWindows()[0].setSize(1440,960);},workspace);
await page.evaluate(()=>window.arealDesktop.chooseProject());await createProjectConversation(page,'workspace');
const ready=await until(s=>s.projects.find(p=>p.root===workspace)?.state?.connected,'project connected'),projectId=ready.projects.find(p=>p.root===workspace).id;
await settings();
await button('安装').waitFor();
assert.equal(await page.getByText('已安装 Skills（0）',{exact:true}).count(),0);
await button('查看详情').focus();await page.keyboard.press('Enter');await button('收起详情').waitFor();await page.keyboard.press('Enter');assert.equal(await button('查看详情').evaluate(el=>el===document.activeElement),true);
await page.screenshot({path:join(scratch,'uninstalled-plugin.png'),animations:'disabled'});
await button('安装').click();
await page.getByRole('checkbox',{name:'我已核对以上来源、版本和内容摘要',exact:true}).check();
await button('安装到用户').click();
await button('管理').waitFor();assert.equal(requests.length,0,'installation cannot run setup/model');
  const supportDetail = await call("manage", {
    projectId,
    operation: "plugin",
    id: "hello@gui-p0",
  });
  assert.equal(supportDetail.componentSupport.digest, supportDetail.sourceDigest);
  assert.equal(supportDetail.installedComponentSupport.digest, supportDetail.installedDigest);
  assert.deepEqual(
    supportDetail.installedComponentSupport.components.map((row) => [row.kind, row.status]),
    [
      ["skills", "supported"],
      ["commands", "unsupported"],
      ["agents", "unsupported"],
      ["uiSurfaces", "unsupported"],
    ],
  );
  const cliDetail = JSON.parse(
    execFileSync(
      env.AREAL_CORE_BIN,
      ["plugin", "--workspace", workspace, "read", "hello@gui-p0"],
      { env, encoding: "utf8" },
    ),
  );
  assert.deepEqual(cliDetail.componentSupport, supportDetail.componentSupport);
  assert.deepEqual(cliDetail.installedComponentSupport, supportDetail.installedComponentSupport);
  await page
    .getByRole("region", { name: "已安装组件支持", exact: true })
    .getByText("部分组件不受支持", { exact: true })
    .waitFor();
  checks.push(
    "real Electron and CLI read identical exact-digest reports; optional unsupported declarations keep installed Skill visible",
  );
checks.push('GUI discovers unmodified package and installs through Core without model execution');
await page.screenshot({path:join(scratch,'installed-plugin.png'),animations:'disabled'});
if(resourceSlice){
runtimeIdentity=await app.evaluate(({app,BrowserWindow})=>{const preferences=BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();return {pid:process.pid,electron:process.versions.electron,appPath:app.getAppPath(),userData:app.getPath('userData'),sandbox:preferences.sandbox,contextIsolation:preferences.contextIsolation,nodeIntegration:preferences.nodeIntegration};});
assert.equal(runtimeIdentity.userData,env.AREAL_GUI_USER_DATA);assert.equal(runtimeIdentity.sandbox,true);assert.equal(runtimeIdentity.contextIsolation,true);assert.equal(runtimeIdentity.nodeIntegration,false);
const resources=await page.evaluate(()=>performance.getEntriesByType('resource').map(entry=>entry.name).filter(name=>name.startsWith('areal-ui://app/assets/')).map(name=>new URL(name).pathname.slice(1)));
const builtEntry=await readFile(join(gui,'renderer/dist/index.html'),'utf8');
const entryAssets=[...builtEntry.matchAll(/(?:src|href)="\.\/(assets\/[^"]+\.(?:js|css))"/g)].map(match=>match[1]);
for(const path of new Set(['index.html',...entryAssets,...resources]))buildFiles['renderer/dist/'+path]=createHash('sha256').update(await readFile(join(gui,'renderer/dist',path))).digest('hex');
buildFiles['app/src/main.cjs']=createHash('sha256').update(await readFile(join(gui,'app/src/main.cjs'))).digest('hex');
await verifyPluginResourceSlice({app,page,state,until,call,pluginState,projectId,scratch,requests,checks});
assert.deepEqual(errors,[]);automaticAcceptancePassed=true;
if(manual){
const task={projectId:await page.getByTestId('areal-workbench').getAttribute('data-project-id'),threadId:await page.getByTestId('areal-workbench').getAttribute('data-thread-id'),draft:await page.getByTestId('chat-input').innerText()};
await page.getByRole('navigation',{name:'应用导航',exact:true}).getByRole('button',{name:'插件',exact:true}).click();
const back=button('返回插件列表');if(await back.isVisible())await back.click();
await page.getByRole('tablist',{name:'市场范围',exact:true}).getByRole('tab',{name:'个人',exact:true}).click();
await button('查看插件 hello@gui-p0').click();await page.getByTestId('plugin-detail-page').waitFor();
await button('返回原任务').waitFor();
const closed=new Promise(resolve=>{const onConsole=message=>{if(message.text()==='AREAL_PLUGIN_RESOURCE_MANUAL_WINDOW_CLOSED')resolve('window-close');};const onClose=()=>resolve('application-close');manualCloseListeners={onConsole,onClose};app.on('console',onConsole);app.once('close',onClose);});
await app.evaluate(({dialog,BrowserWindow})=>{Object.assign(dialog,globalThis.pluginFixtureDialogs);delete globalThis.pluginFixtureDialogs;BrowserWindow.getAllWindows()[0].once('close',()=>console.info('AREAL_PLUGIN_RESOURCE_MANUAL_WINDOW_CLOSED'));});
Object.assign(manualHandoff,{state:'ready',readyAt:new Date().toISOString(),readyPath:join(scratch,'manual-ready.json'),task,pluginId:'hello@gui-p0',mainHandlerRestored:true});
await page.screenshot({path:join(scratch,'manual-ready.png'),animations:'disabled'});
await writeFile(manualHandoff.readyPath,JSON.stringify({manualHandoff,automaticAcceptancePassed,checks,scratch,source:sourceCommit,sourceFiles,sourceDiffSha256,buildFiles,runtimeIdentity,core:{binary:coreBinary,sha256:coreSha256}},null,2));
console.log('Manual ready: '+manualHandoff.readyPath);
const closedBy=await closed;Object.assign(manualHandoff,{state:'closed',closedBy,closedAt:new Date().toISOString()});
app.removeListener('console',manualCloseListeners.onConsole);app.removeListener('close',manualCloseListeners.onClose);manualCloseListeners=null;
}

}else{
await button('管理').click();
// Lose a completed response only at the Main-to-renderer boundary. Core executes unchanged.
await app.evaluate(({ipcMain})=>{const channel='areal-core:command',original=ipcMain._invokeHandlers.get(channel);let lose=true;
ipcMain.removeHandler(channel);ipcMain.handle(channel,async(event,name,params)=>{const result=await original(event,name,params);
if(lose&&name==='manage'&&params.operation==='pluginSetup'&&result.ok){lose=false;return {ok:false,error:{message:'Injected response loss',submissionUnknown:true,requestId:params.requestId}};}return result;});});
await button('运行设置').click();
await page.getByTestId('plugin-detail-page').getByRole('button',{name:'核对插件提交',exact:true}).click();
await button('打开设置对话').waitFor();await button('打开设置对话').click();
await page.getByTestId('chat-input').waitFor();await page.getByTestId('chat-view').getByText('GUI_PLUGIN_SETUP_OK',{exact:true}).waitFor();
const setupThread=await page.getByTestId('areal-workbench').getAttribute('data-thread-id');
assert(setupThread);await page.getByTestId('task-item-'+setupThread).waitFor();
assert(requests.some(r=>JSON.stringify(r.messages).includes('GUI_PLUGIN_SETUP_BODY_MARKER')));
await selectConversation(page,setupThread);assert.equal(setupRequests().length,1,'receipt recovery must not replay setup');
checks.push('explicit setup enters ordinary accessible chat with packaged skill body and sidebar navigation');
checks.push('GUI recovers completed setup after injected Main-to-renderer response loss using real Core receipt without replay');
await page.screenshot({path:join(scratch,'setup-chat.png'),animations:'disabled'});
await settings();
await button('管理').click();
const setupSkill=supportDetail.installedSkills.find(skill=>skill.name==='setup');assert(setupSkill);
const skillSwitch=()=>page.getByRole('switch',{name:'在当前项目启用 Skill setup',exact:true});
await skillSwitch().click();
const componentOff=await pluginState(row=>row?.componentChoices?.disabledSkills.includes(setupSkill.id),'component disabled');
const blockedSkill=await page.evaluate(({projectId,threadId,skill})=>window.arealDesktop.command('manage',{projectId,operation:'skill',threadId,skill}),{projectId,threadId:setupThread,skill:{id:setupSkill.id,revision:setupSkill.revision}});
assert.equal(blockedSkill.ok,false,'disabled retained Skill read must fail in Core');
const available=await call('manage',{projectId,operation:'skills',threadId:setupThread});assert(!available.data.some(skill=>skill.id===setupSkill.id));
await button('查看插件详情').click();await button('管理').click();assert.equal(await skillSwitch().getAttribute('aria-checked'),'false');
const stale=await page.evaluate(({projectId,id,skill,revision,digest})=>window.arealDesktop.command('manage',{projectId,operation:'pluginComponentConfigure',id,component:{kind:'skill',id:skill},enabled:true,expectedRevision:revision,expectedDigest:digest,requestId:crypto.randomUUID()}),{projectId,id:componentOff.id,skill:setupSkill.id,revision:componentOff.revision-1,digest:componentOff.installedDigest});
assert.equal(stale.ok,false,'stale component revision must be rejected');
await skillSwitch().click();await pluginState(row=>!row?.componentChoices?.disabledSkills.includes(setupSkill.id),'component enabled');
checks.push('project Skill switch persists across detail/settings navigation; Core denies retained reads and discovery while off and rejects stale CAS');
await button('管理启用范围').click();await button('在用户范围停用').click();await pluginState(r=>r?.enabled===false,'disable committed');
const current=await call('manage',{projectId,operation:'plugins'});
assert.equal(current.data.find(x=>x.id==='hello@gui-p0').enabled,false);
checks.push('GUI disable reaches same Core state');
await button('在用户范围启用').click();await pluginState(r=>r?.enabled===true,'enable committed');
await button('卸载插件').click();await pluginState(r=>!r?.installed,'uninstall committed');
const removed=await call('manage',{projectId,operation:'plugins'});assert.equal(removed.data.some(x=>x.id==='hello@gui-p0'&&x.installed),false);
checks.push('GUI enable/uninstall completes through management receipts');
}
assert.deepEqual(errors,[]);automaticAcceptancePassed=true;passed=true;
}catch(e){failure={message:e.message,stack:e.stack};process.exitCode=1;if(page)await captureSmokeFailure(page,scratch,e);}
finally{
const cleanup={};let metadata;
if(manualCloseListeners){app.removeListener('console',manualCloseListeners.onConsole);app.removeListener('close',manualCloseListeners.onClose);}
if(manual&&appProcess?.exitCode===null&&appProcess.signalCode===null){try{await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1});});}catch(error){if(appProcess.exitCode===null&&appProcess.signalCode===null)errors.push('restore owned quit fixture: '+error.message);}}
try{metadata=JSON.parse(await readFile(join(scratch,'core/service.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')errors.push('read cleanup identity: '+error.message);}
if(app){let timer;
try{
if(appProcess.exitCode===null&&appProcess.signalCode===null)await Promise.race([app.close(),new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('owned Electron quit timed out')),15000);})]);
if(appProcess.exitCode===null&&appProcess.signalCode===null)await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('owned Electron did not exit')),15000);appProcess.once('exit',()=>{clearTimeout(timeout);resolve();});});
assert.equal(appProcess.exitCode,0,'owned Electron quit exit code');assert.equal(appProcess.signalCode,null,'owned Electron quit signal');cleanup.electronExited=true;
}catch(error){errors.push('natural GUI quit: '+error.message);}finally{clearTimeout(timer);}
}
if(metadata){try{await assertApplicationStopped(coreBinary,env,metadata);cleanup.applicationStopped=true;}catch(error){errors.push('verify natural application cleanup: '+error.message);}}
if(metadata&&!cleanup.applicationStopped){cleanup.assistedServiceStop=true;
const {ServiceConnection,waitForServiceProcessExit}=require('../app/src/core/service-client.cjs');const connection=new ServiceConnection();
try{await connection.connect(metadata);const packet=await connection.request('hello',{protocol:metadata.protocol,identity:metadata.identity});
try{await connection.request('stopService',{protocol:metadata.protocol,cancel:true,expectedDesktopGeneration:metadata.desktopGeneration,expectedTargets:packet.service.targets},true);}catch(error){if(!error.message.includes('已请求退出'))throw error;}
await waitForServiceProcessExit(join(scratch,'core'),metadata);
}catch(error){if(!['ENOENT','ECONNREFUSED','ESRCH'].includes(error.code))errors.push('fallback service cleanup: '+error.message);}finally{connection.close();}}
if(appProcess&&appProcess.exitCode===null&&appProcess.signalCode===null){errors.push('forced Electron cleanup');appProcess.kill('SIGKILL');await new Promise(resolve=>appProcess.once('exit',resolve));cleanup.forcedElectronExit=true;}
const mainErrors=(await readFile(mainErrorsPath,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
for(const error of mainErrors)errors.push('uncaught Main '+error.origin+': '+error.message);
try{const instances=JSON.parse(execFileSync(coreBinary,['service','list','--json'],{env,encoding:'utf8'}));cleanup.instances=instances.map(instance=>({serviceId:instance.serviceId,hostPid:instance.hostPid,corePid:instance.corePid,state:instance.state}));assert(instances.every(instance=>instance.state==='stopped'),'owned Core instance remains live');}catch(error){errors.push('verify final service cleanup: '+error.message);}
model.closeAllConnections();
await new Promise(r=>model.close(r));
if(errors.length){passed=false;process.exitCode=1;}
const manifest={passed,checks,errors,mainErrors,cleanup,failure,scratch,source:sourceCommit,automaticAcceptancePassed,manualHandoff,
sourceFiles,sourceDiffSha256,buildFiles,runtimeIdentity,runner:{node:process.versions.node,playwright:require('playwright-core/package.json').version},core:{binary:coreBinary,sha256:coreSha256,unchanged:createHash('sha256').update(await readFile(coreBinary)).digest('hex')===coreSha256},
modelRequests:requests.length,setupModelRequests:setupRequests().length,mode:resourceSlice?'resource-slice':'p0',scope:'source Electron/Core P0 plugins; deterministic external model; no packaged/provider acceptance'};
await writeFile(join(scratch,'electron.stderr.log'),electronStderr);
await writeFile(join(scratch,'model-requests.json'),JSON.stringify(requests,null,2));
await writeFile(join(scratch,'manifest.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify(manifest,null,2));
}
