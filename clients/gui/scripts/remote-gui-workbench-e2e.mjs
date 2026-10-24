// Isolated real Core + production Direct/Noise + GUI components. Provider and safeStorage are explicit fixtures.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {chromium} from '../app/node_modules/playwright-core/index.mjs';
import {createIdentity} from '../packages/remote/src/channel.mjs';
const gui=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
const {CoreBackend}=require('../app/src/core/backend.cjs');
const {DesktopService}=require('../app/src/core/service-protocol.cjs');
const {RemoteControl}=require('../app/src/core/remote.cjs');
const {executeCore}=require('../app/src/core/core-process.cjs');
const scratch=await mkdtemp('/private/tmp/remote-gui-workbench-');
const home=join(scratch,'desktop');await mkdir(home);await mkdir(join(scratch,'user','.areal'),{recursive:true});
const longReply='完整正文 😀 界\n'.repeat(6000)+'REMOTE_LONG_END';
const held=new Set();let requests=0;
const model=createServer(async(req,res)=>{
  const parts=[];for await(const part of req)parts.push(part);
  const body=JSON.parse(Buffer.concat(parts));requests++;
  if(JSON.stringify(body.messages).includes('HOLD_REMOTE')||JSON.stringify(body.messages).includes('REMOTE_GOAL')){held.add(res);res.on('close',()=>held.delete(res));return;}
  const goal=body.messages.toReversed().map(message=>{try{return JSON.parse(String(message.content).split('Current authoritative goal: ')[1]);}catch{return null;}}).find(Boolean);
  if(goal?.goal?.objective==='Remote Task entry'&&!goal.goal.report){
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const delta={tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name:'goal_update',arguments:JSON.stringify({expectedRevision:goal.revision,status:'complete',summary:'completed original Task Run',evidence:['isolated native model fixture'],remaining:[]})}}]};
    res.end(`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason:null}]})}\n\ndata: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})}\n\ndata: [DONE]\n\n`);return;
  }
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  res.end(`data: ${JSON.stringify({choices:[{index:0,delta:{content:JSON.stringify(body.messages.at(-1)).includes('LONG_REMOTE')?longReply:'REAL_CORE_RESULT'},finish_reason:null}]})}\n\ndata: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})}\n\ndata: [DONE]\n\n`);
});
await new Promise(r=>model.listen(0,'127.0.0.1',r));
await writeFile(join(scratch,'user','.areal','config.toml'),`schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`);
const deployment=join(scratch,'deployment.json');await writeFile(deployment,JSON.stringify({profiles:[{id:'fixture',revision:'v1',displayName:'Fixture',instructions:'Respond plainly'}]}));
const backend=new CoreBackend({binary:process.env.AREAL_CORE_BIN||resolve(gui,'../../target/debug/areal'),home,harnessHome:join(scratch,'registry'),userHome:join(scratch,'user'),desktopConfig:deployment,defaultProfile:{id:'fixture',revision:'v1'}});
const encryption={isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'fixture',encryptString:x=>Buffer.from(x),decryptString:x=>x.toString('utf8')};
let service,browser,passed=false;const checks=[],errors=[],cleanup=[];
async function waitFor(fn,label,timeout=20000){const until=Date.now()+timeout;while(Date.now()<until){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,100));}throw new Error(`Timed out: ${label}`);}
try{
 await backend.init();const entries=[];
 for(const name of ['Project-A','Project-B']){
  const workspace=join(scratch,name);await mkdir(workspace);const id=await backend.addProject(workspace);const project=await backend.start(id);
  const {thread}=await project.client.request('areal/thread/start',{requestId:randomUUID(),cwd:workspace,agentProfile:{id:'fixture',revision:'v1'}});
  await project.client.request('areal/turn/start',{requestId:randomUUID(),threadId:thread.id,expectedConfigRevision:1,input:[{type:'text',text:`${name} seeded Session`}]});
  await waitFor(async()=> (await project.client.request('thread/read',{threadId:thread.id,includeTurns:true})).thread.status.type==='idle',name+' seed');
  entries.push({id,project,threadId:thread.id});
 }
 service=new DesktopService(backend,join(scratch,'service.sock'),()=>{},null);
 const hostIdentity=await createIdentity();await writeFile(join(home,'remote.json'),JSON.stringify({encrypted:Buffer.from(JSON.stringify({enabled:false,directEnabled:true,identity:hostIdentity,deviceGrants:[]})).toString('base64')}));
 const remote=service.remote=new RemoteControl(service,encryption);await remote.init();
 if(process.env.AREAL_REMOTE_GUI_MANUAL==='1') {
  const invitation=await remote.control({operation:'pair'});
  await writeFile(resolve(gui,'../../.scratch/remote-gui-integration/live.json'),JSON.stringify({url:invitation.payload,scratch,origin:remote.direct.origin}));
  console.log('Isolated production Remote ready at '+remote.direct.origin);
  let approved=false;
  while(true){
   const pending=(await remote.control({operation:'status'})).pending[0];
   if(pending&&!approved){await remote.control({operation:'approve',id:pending.id,projects:entries.map(e=>e.id),preset:'Operator'});approved=true;}
   const states=[];
   for(const entry of entries){const current=await entry.project.client.request('thread/read',{threadId:entry.threadId,includeTurns:true});states.push({projectId:entry.id,thread:current.thread});}
   await writeFile(join(scratch,'native-states.json'),JSON.stringify(states));
   try{await readFile(join(scratch,'stop'));break;}catch{}
   await new Promise(r=>setTimeout(r,500));
  }
  checks.push('manual fixture lifecycle only; browser verification recorded separately');throw Object.assign(new Error('Manual fixture complete'),{manualComplete:true});
 }
 browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const page=await browser.newPage({viewport:{width:393,height:852}});page.on('pageerror',error=>errors.push(error.message));
 const invitation=await remote.control({operation:'pair'});await page.goto(invitation.payload);
 await page.locator('#connect').click();
 const pending=await waitFor(async()=> (await remote.control({operation:'status'})).pending[0],'browser pairing');
 await remote.control({operation:'approve',id:pending.id,projects:entries.map(e=>e.id),preset:'Operator'});
 await page.getByRole('button',{name:'Project-A',exact:true}).waitFor();
 await page.getByRole('button',{name:'Project-A seeded Session',exact:true}).waitFor();
 await page.getByRole('button',{name:'Project-B',exact:true}).click();
 await page.getByRole('button',{name:'Project-B seeded Session',exact:true}).click();
 await page.getByRole('heading',{name:'Project-B seeded Session',exact:true}).waitFor();
 assert.match(await page.locator('#remote-session-ui .messages').innerText(),/REAL_CORE_RESULT/);
 checks.push('two authorized projects, never-opened real Session, GUI Messages and project identity');
 await page.getByRole('button',{name:'更改权限',exact:true}).click();
 await page.getByRole('menuitemradio',{name:/^请求审批/}).click();
 await waitFor(async()=> (await entries[1].project.client.request('thread/read',{threadId:entries[1].threadId,includeTurns:true})).thread.desktop.configuration.options.permissionPreset==='ask','native permission change');
 checks.push('GUI permission change reaches actual Core configuration');
 await page.getByRole('button',{name:'模型',exact:true}).click();
 await page.getByRole('dialog',{name:/模型/}).waitFor();
 await page.keyboard.press('Escape');
 // Drive the real Lexical editor, rather than mutating contenteditable DOM.
 async function type(text){const input=page.getByTestId('remote-chat-input');await input.fill(text);await waitFor(()=>page.getByRole('button',{name:'发送',exact:true}).isEnabled(),'enabled send');}
 await type('HOLD_REMOTE current work');await page.getByRole('button',{name:'发送',exact:true}).click();
 await page.getByRole('button',{name:'停止',exact:true}).waitFor();
 await type('after this turn');await page.getByRole('button',{name:'发送',exact:true}).click();
 await page.getByRole('region',{name:'待发送消息'}).waitFor();
 assert.equal((await entries[1].project.client.request('areal/queue/list',{threadId:entries[1].threadId})).items.filter(i=>i.status==='pending').length,1);
 checks.push('running follow-up uses ordinary guarded durable Core enqueue and GUI ComposerQueue');
 await page.getByRole('button',{name:'引导 after this turn',exact:true}).click();
 await waitFor(async()=> !(await entries[1].project.client.request('areal/queue/list',{threadId:entries[1].threadId})).items.some(i=>i.status==='pending'),'atomic queue steer');
 checks.push('GUI queue steer transfers exact pending item into original running Turn');
 await type('queued before stop');await page.getByRole('button',{name:'发送',exact:true}).click();
 await page.getByRole('region',{name:'待发送消息'}).waitFor();
 await page.screenshot({path:join(scratch,'remote-running-queue.png')});
 await page.getByRole('button',{name:'停止',exact:true}).click();
 await waitFor(async()=> (await entries[1].project.client.request('thread/read',{threadId:entries[1].threadId,includeTurns:true})).thread.status.type==='idle','native stop');
 const q=await entries[1].project.client.request('areal/queue/list',{threadId:entries[1].threadId});assert.equal(q.paused,true);assert.equal(q.items.filter(i=>i.status==='pending').length,1);
 checks.push('stop settles actual Turn and retains paused pending follow-up');
 await page.getByRole('button',{name:'返回项目列表',exact:true}).click();
 await page.getByRole('button',{name:'Project-A seeded Session',exact:true}).click();
 await page.getByRole('heading',{name:'Project-A seeded Session',exact:true}).waitFor();
 await type('LONG_REMOTE');await page.getByRole('button',{name:'发送',exact:true}).click();
 await page.getByText(/REMOTE_LONG_END/).waitFor();
 const longTurn=(await entries[0].project.client.request('thread/read',{threadId:entries[0].threadId,includeTurns:true})).thread.turns.at(-1);
 assert.equal(longTurn.items.findLast(item=>item.type==='agentMessage').text,longReply);
 assert.match(await page.locator('#remote-session-ui .messages').innerText(),/REMOTE_LONG_END/);
 checks.push('full session.body beyond preview budget matches original Core Unicode text');
 await page.getByRole('button',{name:'添加功能与 Skills',exact:true}).click();
 await page.getByRole('option',{name:/设置目标/}).click();
 await page.getByTestId('remote-chat-input').fill('REMOTE_GOAL complete one task');
 await page.getByRole('button',{name:'开始目标',exact:true}).click();
 await page.getByRole('region',{name:'当前目标'}).waitFor();
 const goal=(await entries[0].project.client.request('areal/goal/get',{threadId:entries[0].threadId})).goal;assert.equal(goal.objective,'REMOTE_GOAL complete one task');
 checks.push('GUI goal catalog and GoalCard use actual Core goal state');
 assert.deepEqual(errors,[]);
 await page.screenshot({path:join(scratch,'remote-goal.png')});
 await page.getByRole('button',{name:'暂停目标',exact:true}).click();
 await waitFor(async()=>{const value=await entries[0].project.client.request('areal/goal/get',{threadId:entries[0].threadId});return value.goal.status==='paused'&&!value.goal.settling;},'goal pause settlement');
 checks.push('self-created Goal pause settles original real Turn');
 await page.getByRole('button',{name:'返回项目列表',exact:true}).click();
 const taskThread=(await entries[0].project.client.request('areal/thread/start',{requestId:randomUUID(),cwd:entries[0].project.root,agentProfile:{id:'fixture',revision:'v1'}})).thread;
 const task=await entries[0].project.client.request('areal/task/create',{requestId:randomUUID(),mode:'scheduled',threadId:taskThread.id,objective:'Remote Task entry',schedule:{at:Math.floor(Date.now()/1000)+1},interactionMode:'headless',maxTurns:4});
 await waitFor(async()=>{const value=await entries[0].project.client.request('areal/task/read',{taskId:task.id});return value.runs.at(-1)?.completedAt;},'actual Task Run completion');
 await page.locator('section[aria-label="Remote Task entry"]').getByRole('button',{name:'审阅暂停 Task',exact:true}).click();
 await expectTaskTarget();
 async function expectTaskTarget(){await waitFor(async()=> (await page.locator('#task-pause-target').innerText()).includes(task.id),'original Task review target');assert.equal(await page.locator('#task-pause-confirm').isDisabled(),true);}
 checks.push('new Workbench exposes real Task pause review and rejects a terminal Run');
 assert.deepEqual(errors,[]);
 passed=true;
 console.log(JSON.stringify({passed,checks,scratch,requests,browserErrors:errors,provider:'deterministic local fixture',transport:'production Direct/Noise',credentials:'isolated safeStorage fixture'},null,2));
}catch(error){if(!error.manualComplete){errors.push(error.message);console.error(error);throw error;}}finally{
 await browser?.close();await service?.close();
 try {
  for(const project of backend.projects.values())if(project.service){
   const result=await executeCore(backend.binary,['service','stop','--instance',project.service.serviceId,'--cancel','--json'],{env:backend.hooks.environment(),timeout:60000});
   const stopped=JSON.parse(result.stdout);assert.equal(stopped.state,'stopped');cleanup.push({serviceId:project.service.serviceId,state:stopped.state});
  }
 }catch(error){passed=false;cleanup.push({error:error.message});process.exitCode=1;}
 await backend.disconnect();
 for(const response of held)response.destroy();await new Promise(r=>model.close(r));
 await writeFile(join(scratch,'result.json'),JSON.stringify({passed,checks,errors,cleanup},null,2));
 console.log(JSON.stringify({evidence:scratch,passed,cleanup}));
}
