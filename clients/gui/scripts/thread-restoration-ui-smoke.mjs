import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(gui, 'app/package.json'));
const { chromium } = require('playwright-core');
const dist = process.env.AREAL_RENDERER_DIST || join(gui, 'renderer/dist');
const scratch = await mkdtemp('/private/tmp/areal-restoration-ui-');
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://local').pathname);
    const path = resolve(dist, pathname === '/' ? 'index.html' : `.${pathname}`);
    if (!path.startsWith(dist + sep)) throw new Error('Invalid asset path');
    response.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }[extname(path)] || 'application/octet-stream');
    response.end(await readFile(path));
  } catch {
    response.statusCode = 404;
    response.end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser, passed = false;
const checks = [], errors = [], failures = [];
const check = (condition, message) => { try { assert.ok(condition, message); checks.push(message); } catch (error) { failures.push(error.message); } };
try {
  browser = await chromium.launch({ headless: true, ...(process.env.AREAL_GUI_TEST_BROWSER ? { executablePath: process.env.AREAL_GUI_TEST_BROWSER } : { channel: 'chrome' }) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 }, serviceWorkers: 'block' });
  page.on('pageerror', error => errors.push(error.message));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.addInitScript(() => {
    const threadId='synthetic-history';
    const project={id:'restore-fixture',root:'/isolated/workspace',state:{connected:false,threads:{},queues:{},interactions:{}},error:null,
      models:[],profiles:[],pending:[],summaries:[{id:threadId,name:'Synthetic history restoration',preview:'Synthetic history restoration',status:'idle'}],configurations:{},outcomes:{},core:{}};
    const snapshot={revision:1,projects:[project],connection:{state:'ready'},library:{projects:{},threads:{},settings:{},projectOrder:[]}};
    let listener, projectionListener, sequence=0; let fail=true, sendSequence=0, delayedOpen;
    const publish=()=>{snapshot.revision++;listener(structuredClone(snapshot));};
    const history=id=>({id,cwd:project.root,status:"idle",turns:[{id:`${id}-turn`,status:"completed",items:[{id:`${id}-reply`,type:"agentMessage",phase:"final_answer",text:id===threadId?"RESTORED_HISTORY_SENTINEL":"OTHER_HISTORY_SENTINEL"}]}]});
    window.calls=[];
    localStorage.setItem('areal-gui:project',project.id);
    localStorage.setItem(`areal-gui:thread:${project.id}`,threadId);
    window.recoverProject=()=>{fail=false;project.state.connected=true;project.error=null;snapshot.revision++;listener(structuredClone(snapshot));};
    window.disconnectDesktop=()=>{delete project.state.threads[threadId];project.state.connected=false;snapshot.connection.state='unavailable';snapshot.revision++;listener(structuredClone(snapshot));};
    window.recoverDesktop=()=>{project.state.connected=true;snapshot.connection.state='ready';snapshot.revision++;listener(structuredClone(snapshot));};
    window.setCoreGeneration=generation=>{project.core.connectionGeneration=generation;publish();};
    window.resetAdapterProjection=()=>{project.core={connectionGeneration:0};project.state.connected=false;project.state.threads={};publish();};
    window.fixture=()=>structuredClone(snapshot);
    window.settleSend=(requestId, target=threadId, method='areal/turn/submit')=>{project.pending=project.pending.filter(item=>item.params.requestId!==requestId);project.outcomes[requestId]={accepted:true,status:'completed',threadId:target,method,operation:{requestId,method,target:{kind:'thread',threadId:target}}};publish();};
    window.failObservation=(id='read-failure-1')=>{project.observationErrors={[threadId]:{id,projectId:project.id,threadId,connectionGeneration:0,message:'HISTORY_FAILURE_SENTINEL',code:'READ_FAILED',recovery:{kind:'none'}}};publish();};
    window.setViewRecovery=(code='DISCONNECTED',kind='retryRead',state='connecting')=>{snapshot.connection={state};project.state.connected=false;project.error='后台服务已断开，请重新连接';project.observationErrors={[threadId]:{id:`recovery-${code}-${state}`,projectId:project.id,threadId,connectionGeneration:0,message:'TRANSPORT_DISCONNECTED_SENTINEL',code,recovery:{kind}}};publish();};
    window.finishViewRecovery=()=>{snapshot.connection={state:'ready'};project.state.connected=true;project.error=null;project.observationErrors={};publish();};
    window.clearObservation=()=>{project.observationErrors={};publish();};
    window.creationPending=(method,requestId)=>{const operation={requestId,method,target:{kind:'project'}};project.pending.push({method,operation,params:{requestId,sourceThreadId:threadId}});publish();};
    window.creationOutcome=(method,requestId,sourceThreadId)=>{project.pending=project.pending.filter(entry=>entry.params.requestId!==requestId);project.outcomes[requestId]={accepted:true,status:'completed',threadId:'created-thread',sourceThreadId,method,operation:{requestId,method,target:{kind:'thread',threadId:'created-thread'}}};publish();};
    window.failedQueue=(editing=false)=>{
      const requestId=editing?'00000000-0000-4000-8000-000000000004':'00000000-0000-4000-8000-000000000003';
      const operation=editing?'update':'pause';
      const key=`areal-gui:draft:${project.id}:${threadId}`;
      project.observationErrors={};project.state.queues[threadId]={revision:7,paused:true,pauseReason:'user',items:[{id:'queue-item',status:'pending',input:[{type:'text',text:'QUEUED_TEXT_SENTINEL'}]}]};
      project.outcomes[requestId]={accepted:true,status:'failed',threadId,method:`areal/queue/${operation}`,operation:{requestId,method:`areal/queue/${operation}`,target:{kind:'thread',threadId}},message:editing?'QUEUE_EDIT_FAILED_SENTINEL':'QUEUE_FAILED_SENTINEL'};
      if(editing){localStorage.setItem(key,'QUEUE_EDIT_DRAFT_SENTINEL');localStorage.setItem(`${key}:queue-edit`,JSON.stringify({id:'queue-item',revision:7,wasPaused:true,phase:'editing',attachments:[],original:{text:'ORIGINAL_DRAFT_SENTINEL',skills:null,goal:null},unknown:{requestId,operation}}));}
      else localStorage.setItem(`${key}:queue-operation`,JSON.stringify({requestId,operation}));
      publish();window.dispatchEvent(new CustomEvent('areal-draft-change',{detail:key}));
    };
    window.permissionFailure=()=>{project.observationErrors={[threadId]:{id:'permission-failure',projectId:project.id,threadId,connectionGeneration:0,message:'Permission denied',code:-32003,reason:'REQUEST_REJECTED',recovery:{kind:'needsUser'}}};publish();};
    window.prepareRace=()=>{project.summaries.push({id:'other-history',name:'Other fixture history',preview:'Other fixture history',status:'idle'});publish();};
    window.finishOldOpen=()=>delayedOpen?.({ok:false,error:{code:'READ_FAILED',message:'OLD_SELECTION_FAILURE_SENTINEL',outcome:{kind:'noMutation'},recovery:{kind:'none'}}});
    window.unrelatedError=()=>document.dispatchEvent(new CustomEvent('areal:toast',{detail:'UNRELATED_ERROR_SENTINEL'}));
    window.arealDesktop={
      snapshot:async()=>structuredClone(snapshot),onProjection:callback=>{projectionListener=callback;listener=value=>callback({frame:{projection:1,stream:'diagnosis-fixture',sequence:++sequence,kind:'full',snapshot:value}});return()=>{};},requestProjection:requestId=>projectionListener({requestId,frame:{projection:1,stream:'diagnosis-fixture',sequence:++sequence,kind:'full',snapshot:structuredClone(snapshot)}}),
      setInterfaceLocale:()=>{},theme:async()=>({platform:'darwin',dark:false,id:'light'}),onTheme:()=>()=>{},onMcpAppEvent:()=>()=>{},presentReady:async()=>{},preview:async()=>({}),
      command:async(name,params)=>{
        window.calls.push({name,params});
        if(name==='connect'&&fail)return {ok:false,error:{code:'RESPONSE_UNKNOWN',message:'Core disconnected; request outcome may be unknown',submissionUnknown:true}};
        if(name==='connect'){project.state.connected=true;publish();}
        if(name==='reconcile')return {ok:true,value:{outcomes:structuredClone(project.outcomes)}};
        if(name==='queue')return {ok:true,value:structuredClone(project.state.queues[params.threadId])};
        if(name==='workspace')return {ok:true,value:{git:true,branch:'main'}};
        if(name==='trajectory')return {ok:true,value:{enabled:false,state:'disabled',queue:{},records:[]}};
        if(name==='send') {
          const requestId=`00000000-0000-4000-8000-${String(++sendSequence).padStart(12,'0')}`;
          if(sendSequence===3)return {ok:false,error:{code:'TRANSPORT_FAILURE',message:'transport closed without outcome facts'}};
          const operation={requestId,method:'areal/turn/submit',target:{kind:'thread',threadId:params.threadId}};
          project.pending.push({method:operation.method,operation,params:{...params,requestId}});publish();
          return {ok:false,error:{code:'RESPONSE_UNKNOWN',message:'Core disconnected; request outcome may be unknown',submissionUnknown:true,requestId,outcome:{kind:'unconfirmed',operation},recovery:{kind:'queryOriginal'}}};
        }
        if(name==='open'&&params.threadId==='other-history')return new Promise(resolve=>{delayedOpen=resolve;});
        if(name==='open') {
          project.state.threads[params.threadId]=history(params.threadId);
          snapshot.revision++;listener(structuredClone(snapshot));
        }
        return {ok:true,value:{data:[]}};
      },
    };
  });  await page.goto(origin);
  const failure=page.getByText('暂时无法完成加载，请重试或检查后台。',{exact:true});
  const banner=page.locator('[data-testid="feedback-notice"][data-tone="error"]');
  await failure.waitFor();
  check(!await page.getByText('Core disconnected; request outcome may be unknown',{exact:true}).isVisible(),'Read restoration uses product recovery copy instead of an unknown-mutation transport message.');
  await page.screenshot({path:join(scratch,'01-initial-failure.png'),animations:'disabled'});
  await page.evaluate(()=>window.recoverProject());
  await page.getByText('RESTORED_HISTORY_SENTINEL',{exact:true}).waitFor({timeout:5000});
  assert.equal(await failure.count(),0,'the restored transcript replaces the failure screen');
  assert.equal(await banner.count(),0,'successful restoration clears its own disconnect error');
  const calls=await page.evaluate(()=>window.calls);
  assert.equal(calls.filter(call=>call.name==='open'&&call.params.threadId==='synthetic-history').length,1,'one selected history observation is sufficient');
  assert.deepEqual(calls.filter(call=>['send','create','steer','enqueue'].includes(call.name)),[],'recovery must never replay a submission');
  await page.screenshot({path:join(scratch,'02-project-recovered-history.png'),animations:'disabled'});
  checks.push('Project-only Core recovery restores the selected transcript and clears the matching error.');
  checks.push('Restoration observes history once and never replays a submission.');
  await page.evaluate(()=>window.disconnectDesktop());
  await page.getByText('RESTORED_HISTORY_SENTINEL',{exact:true}).waitFor({state:'hidden'});
  await page.evaluate(()=>window.recoverDesktop());
  await page.getByText('RESTORED_HISTORY_SENTINEL',{exact:true}).waitFor({timeout:5000});
  assert.equal((await page.evaluate(()=>window.calls)).filter(call=>call.name==='open').length,2,'outer service recovery re-observes without a Core generation change');
  assert.equal(await banner.count(),0);
  checks.push('Desktop reconnect restores the selected history even when the Core connection generation is unchanged.');
  await page.screenshot({path:join(scratch,'03-desktop-recovered-history.png'),animations:'disabled'});
  await page.evaluate(()=>window.setCoreGeneration(1));
  await page.waitForFunction(()=>window.calls.filter(call=>call.name==='open').length===3);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const beforeAdapterReset=await page.evaluate(()=>window.calls.filter(call=>call.name==='connect').length);
  await page.evaluate(()=>window.resetAdapterProjection());
  await page.getByText('RESTORED_HISTORY_SENTINEL',{exact:true}).waitFor({timeout:5000});
  check((await page.evaluate(()=>window.calls.filter(call=>call.name==='connect').length))===beforeAdapterReset+1,'A fresh adapter generation reconnects the selected Core instead of reusing the previous restoration attempt.');
  check((await page.evaluate(()=>window.calls.filter(call=>['send','create','steer','enqueue'].includes(call.name)).length))===0,'Adapter generation recovery observes history without replaying mutations.');
  const input=page.getByTestId('chat-input');
  const send=async text=>{await input.fill(text);await page.getByTestId('chat-send-button').click();await writeFile(join(scratch,'send-debug.json'),JSON.stringify(await page.evaluate(()=>({calls:window.calls,body:document.body.innerText})),null,2));await page.locator('.composer-dock [data-composer-recovery-request-id]').waitFor({timeout:5000});};
  const requestId='00000000-0000-4000-8000-000000000001';
  await send('KEEP_DRAFT_SENTINEL');
  check(await input.innerText()==='KEEP_DRAFT_SENTINEL','An unconfirmed send retains its original draft.');
  check(await page.locator(`.work-area [data-recovery-request-id="${requestId}"]`).count()===1,'The operation notice exposes its original request identity.');
  check((await page.locator('.composer-dock [data-composer-recovery-request-id]').innerText()).includes('发送结果尚未确认，草稿已保留，正在核对原请求。'),'The retained draft explains verification without Core or reconciliation jargon.');
  check(!(await page.locator('body').innerText()).includes(requestId),'Request identity stays out of the default visible recovery notices.');
  const operationNotice=page.locator(`.work-area [data-recovery-request-id="${requestId}"]`);
  const details=operationNotice.locator('summary');
  if(await details.count()) {
    await details.click();
    check((await operationNotice.innerText()).includes(requestId),'Original request identity remains available in on-demand details.');
    await details.click();
  } else check(false,'Original request identity remains available in on-demand details.');
  await page.evaluate(()=>window.setViewRecovery());
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  check(await banner.count()===0,'A typed transport failure stays quiet while the Main owner is retrying.');
  await page.waitForTimeout(1300);
  check(await page.getByText('正在重新加载对话，历史和草稿已保留…',{exact:true}).isVisible(),'A continuing automatic retry becomes a progress status after the quiet interval.');
  check(await page.getByRole('button',{name:'重试加载对话',exact:true}).count()===0,'Automatic retry does not ask the user to retry the same view.');
  check(await page.getByText('RESTORED_HISTORY_SENTINEL',{exact:true}).isVisible(),'Automatic retry preserves the visible history.');
  await page.screenshot({path:join(scratch,'03a-automatic-recovery.png'),animations:'disabled'});
  await page.evaluate(()=>window.setViewRecovery(-32003,'needsUser'));
  await page.locator('[data-testid="feedback-notice"][data-tone="error"]').filter({hasText:'当前权限不允许'}).waitFor();
  check(true,'Permission failures remain actionable while another automatic connection retry is active.');
  await page.evaluate(()=>window.setViewRecovery('HISTORY_BUDGET_TOO_SMALL','none'));
  await page.locator('[data-testid="feedback-notice"][data-tone="error"]').filter({hasText:'对话内容超过当前加载范围'}).waitFor();
  check(true,'A history budget error remains actionable during connection recovery.');
  await page.evaluate(()=>window.setViewRecovery('DISCONNECTED','retryRead','unavailable'));
  await page.locator('[data-testid="feedback-notice"][data-tone="error"]').filter({hasText:'暂时无法加载对话'}).waitFor();
  check(await page.getByRole('button',{name:'重试加载对话',exact:true}).isVisible(),'When automatic recovery ends, a transport failure offers an explicit retry.');
  await page.evaluate(()=>window.finishViewRecovery());
  await page.evaluate(()=>window.settleSend('00000000-0000-4000-8000-000000000099'));
  check(await page.locator('.composer-dock [data-composer-recovery-request-id]').count()===1,'An unrelated outcome cannot settle the pending submission.');
  await page.evaluate(id=>window.settleSend(id),requestId);
  await page.locator('.composer-dock [data-composer-recovery-request-id]').waitFor({state:'hidden'});
  check(await banner.filter({hasText:'Core disconnected; request outcome may be unknown'}).count()===0,'The confirmed send removes its matching global transport failure.');
  await send('SECOND_DRAFT_SENTINEL');
  await page.evaluate(()=>window.unrelatedError());
  await page.evaluate(()=>window.settleSend('00000000-0000-4000-8000-000000000002'));
  await page.locator('.composer-dock [data-composer-recovery-request-id]').waitFor({state:'hidden'});
  check(await page.getByTestId('toast').filter({hasText:'UNRELATED_ERROR_SENTINEL'}).count()===1,'Settling a send preserves an unrelated transient notification.');
  await input.fill('UNCLASSIFIED_FAILURE_DRAFT_SENTINEL');await page.getByTestId('chat-send-button').click();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  check(await page.getByText('暂时无法完成操作，请检查原操作结果后继续。',{exact:true}).count()>0,'A transport failure without typed facts never claims that the operation was not admitted.');
  check(await page.getByText('操作尚未受理，输入已保留，请在连接恢复后重试。',{exact:true}).count()===0,'Only explicit rejection can describe an operation as not admitted.');
  for(const close of await page.locator('[data-testid="feedback-notice"][data-tone="error"]').getByRole('button',{name:'关闭提示',exact:true}).all())await close.click();
  await page.evaluate(()=>window.failObservation());
  await page.getByText('暂时无法加载这段对话，请查看详情。',{exact:true}).waitFor();
  await page.getByTestId('feedback-notice').filter({hasText:'暂时无法加载这段对话，请查看详情。'}).getByRole('button',{name:'关闭提示',exact:true}).click();
  check(await page.getByText('暂时无法加载这段对话，请查看详情。',{exact:true}).count()===0,'Dismissing a restoration notice hides that exact failure occurrence.');
  await page.evaluate(()=>window.failObservation('read-failure-2'));
  await page.getByText('暂时无法加载这段对话，请查看详情。',{exact:true}).waitFor();
  check(await page.getByText('暂时无法加载这段对话，请查看详情。',{exact:true}).count()===1,'A new restoration failure occurrence can appear after dismissal.');
  await page.evaluate(()=>{window.clearObservation();window.prepareRace();});
  await page.getByText('Other fixture history',{exact:true}).first().click();
  await page.getByText('Synthetic history restoration',{exact:true}).first().click();
  await page.getByText('RESTORED_HISTORY_SENTINEL',{exact:true}).waitFor();
  await page.evaluate(()=>window.finishOldOpen());
  await page.waitForTimeout(100);
  check(await page.getByText('OLD_SELECTION_FAILURE_SENTINEL',{exact:true}).count()===0,'A late response from an old selection cannot attach to the current conversation.');
  await page.evaluate(()=>window.permissionFailure());
  await page.locator('[data-testid="feedback-notice"][data-tone="error"]').filter({hasText:'请检查'}).waitFor();
  check(await page.getByText('当前权限不允许此操作，请检查权限设置后重试。',{exact:true}).count()===1,'A needsUser permission failure directs the user to permission settings.');
  check(await page.getByText('无法完成操作，请检查模型服务的登录或凭据设置后重试。',{exact:true}).count()===0,'A permission failure does not ask for unrelated model credentials.');
  await page.screenshot({path:join(scratch,'04-scoped-notices.png'),animations:'disabled'});
  for(const [method,requestId] of [['areal/thread/fork','00000000-0000-4000-8000-000000000005'],['areal/side/start','00000000-0000-4000-8000-000000000006']]){
    await page.evaluate(({method,requestId})=>window.creationPending(method,requestId),{method,requestId});
    const creationNotice=page.locator(`.work-area [data-recovery-request-id="${requestId}"]`);
    await creationNotice.waitFor();
    await page.evaluate(({method,requestId})=>window.creationOutcome(method,requestId,'wrong-source'),{method,requestId});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    check(await creationNotice.count()===1,`${method} cannot settle from an outcome with the wrong source thread.`);
    await page.evaluate(({method,requestId})=>window.creationOutcome(method,requestId,'synthetic-history'),{method,requestId});
    await creationNotice.waitFor({state:'hidden'});
    checks.push(`${method} binds its created target only after original ID, method and source agree.`);
  }
  await page.evaluate(()=>window.failedQueue());
  await page.getByText('Other fixture history',{exact:true}).first().click();
  await page.getByText('Synthetic history restoration',{exact:true}).first().click();
  await page.getByRole('button',{name:'核对队列操作',exact:true}).click();
  check(await page.getByText('QUEUE_FAILED_SENTINEL',{exact:true}).count()===1,'An admitted failed queue operation remains a failure after receipt reconciliation.');
  check(await page.getByText('队列操作已确认。',{exact:true}).count()===0,'A failed queue receipt is never reported as a successful queue operation.');
  await page.evaluate(()=>window.failedQueue(true));
  await page.getByRole('button',{name:'核对编辑操作',exact:true}).click();
  check(await input.innerText()==='QUEUE_EDIT_DRAFT_SENTINEL','A failed admitted queue edit preserves the edited draft.');
  check(await page.evaluate(()=>!JSON.parse(localStorage.getItem('areal-gui:draft:restore-fixture:synthetic-history:queue-edit')).unknown),'A confirmed failed edit clears only its unresolved operation marker.');
  check(await page.getByText('QUEUE_EDIT_FAILED_SENTINEL',{exact:true}).count()===1,'A failed queue edit shows its execution failure without reading a missing result revision.');
  await page.screenshot({path:join(scratch,'05-failed-queue-receipts.png'),animations:'disabled'});
  assert.deepEqual(errors,[]);assert.deepEqual(failures,[]);passed=true;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  const hashes=Object.fromEntries(await Promise.all(['App.tsx','BackendStatusNotice.tsx','Composer.tsx','DraftComposer.tsx','ComposerQueue.tsx','useComposerQueueEdit.ts','recoveryPresentation.ts'].map(async file=>[file,createHash('sha256').update(await readFile(join(gui,'renderer/src',file))).digest('hex')])));
  const source={commit:execFileSync('git',['rev-parse','HEAD'],{cwd:gui,encoding:'utf8'}).trim(),hashes,rendererEntrySHA256:createHash('sha256').update(await readFile(join(dist,'index.html'))).digest('hex'),node:process.version,browser:browser?.version()};
  await writeFile(join(scratch, 'manifest.json'), JSON.stringify({ passed, checks, errors, failures, source, scope: 'built renderer in Chrome with controlled Desktop contract snapshots' }, null, 2));
  console.log(JSON.stringify({ passed, evidence: scratch, checks, errors, failures }));
}
