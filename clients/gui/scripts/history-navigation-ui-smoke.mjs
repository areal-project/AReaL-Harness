import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(gui, 'app/package.json'));
const { chromium } = require('playwright-core');
const dist = process.env.AREAL_RENDERER_DIST || join(gui, 'renderer/dist');
const scratch = await mkdtemp('/private/tmp/areal-history-navigation-');
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
const check = (condition, message) => { try { assert.ok(condition, message); checks.push(message); } catch (error) { failures.push(error.message); } };try {
  browser = await chromium.launch({headless:true,channel:'chrome'});
  const page = await browser.newPage({viewport:{width:1280,height:960}});
  page.on('pageerror',error=>errors.push(error.message));
  const origin=`http://127.0.0.1:${server.address().port}`;
  await page.addInitScript(() => {
    const threadId='synthetic-history';
    const project={id:'restore-fixture',root:'/isolated/workspace',state:{connected:false,threads:{},queues:{},interactions:{}},models:[],profiles:[],pending:[],summaries:[{id:threadId,name:'Synthetic history restoration',status:'idle'}],configurations:{},outcomes:{},core:{}};
    const second={...structuredClone(project),id:'second-fixture',root:'/isolated/second',summariesLoaded:false,summaries:[]};
    const snapshot={revision:1,projects:[project,second],connection:{state:'ready'},library:{projects:{'second-fixture':{navigationSummaries:[{id:'second-history',preview:'Second cached history',status:'idle'}]}},threads:{},settings:{},projectOrder:[]}};
    let listener, projectionListener, sequence=0;
    const publish=()=>{snapshot.revision++;listener(structuredClone(snapshot));};
    const history=id=>({id,status:'idle',turns:[{id:id+'-turn',status:'completed',items:[{id:id+'-reply',type:'agentMessage',phase:'final_answer',text:id===threadId?'RESTORED_HISTORY_SENTINEL':'SECOND_HISTORY_SENTINEL'}]}]});
    window.calls=[];window.fixture=()=>structuredClone(snapshot);
    localStorage.setItem('areal-gui:project',project.id);
    localStorage.removeItem('areal-gui:thread:'+project.id);
    window.creationPending=(method,requestId)=>{project.pending.push({method,operation:{requestId,method,target:{kind:'project'}},params:{requestId,sourceThreadId:threadId}});publish();};
    window.arealDesktop={snapshot:async()=>structuredClone(snapshot),onProjection:callback=>{projectionListener=callback;listener=value=>callback({frame:{projection:1,stream:'navigation-fixture',sequence:++sequence,kind:'full',snapshot:value}});return()=>{};},requestProjection:requestId=>projectionListener({requestId,frame:{projection:1,stream:'navigation-fixture',sequence:++sequence,kind:'full',snapshot:structuredClone(snapshot)}}),
      setInterfaceLocale:()=>{},theme:async()=>({platform:'darwin',dark:false,id:'light'}),onTheme:()=>()=>{},onMcpAppEvent:()=>()=>{},presentReady:async()=>{},preview:async()=>({}),
      command:async(name,params)=>{
        window.calls.push({name,params});const owner=snapshot.projects.find(item=>item.id===params?.projectId);
        if(name==='connect'){owner.state.connected=true;owner.core={connectionGeneration:1};publish();}
        if(name==='open'){owner.state.threads[params.threadId]=history(params.threadId);publish();}
        if(name==='reconcile')return {ok:true,value:{outcomes:structuredClone(owner.outcomes)}};
        if(name==='queue')return {ok:true,value:owner.state.queues[params.threadId]};
        if(name==='workspace')return {ok:true,value:{git:true,branch:'main'}};
        if(name==='trajectory')return {ok:true,value:{enabled:false,state:'disabled',queue:{},records:[]}};
        return {ok:true,value:{data:[]}};
      }};
  });
  await page.goto(origin);
  await page.getByTestId('chat-input').waitFor();
  const history=page.getByTestId('task-item-synthetic-history').first();
  await history.click();await page.getByText('RESTORED_HISTORY_SENTINEL',{exact:true}).waitFor();
  check(true,'Cold startup from a draft opens an existing history by mouse.');
  await page.screenshot({path:join(scratch,'01-click-history.png')});
  await page.getByRole('button',{name:'新聊天',exact:true}).click();await page.getByTestId('chat-input').waitFor();
  await page.evaluate(()=>window.creationPending('areal/thread/start','unrelated-create'));
  await history.focus();await page.keyboard.press('Enter');
  await page.getByText('RESTORED_HISTORY_SENTINEL',{exact:true}).waitFor({timeout:5000});
  check(true,'Existing history remains keyboard-accessible while an unrelated creation outcome is unknown.');
  check((await page.evaluate(()=>window.calls)).filter(call=>['send','create','steer','enqueue'].includes(call.name)).length===0,'History navigation never submits or replays work.');
  check((await page.evaluate(()=>window.fixture())).projects[0].pending.some(item=>item.params.requestId==='unrelated-create'),'Read navigation preserves the original unresolved creation.');
  await page.screenshot({path:join(scratch,'02-pending-history.png')});
  await page.getByTestId('task-item-second-history').first().click();
  await page.getByText('SECOND_HISTORY_SENTINEL',{exact:true}).waitFor({timeout:5000});
  check(await page.getByTestId('areal-workbench').getAttribute('data-project-id')==='second-fixture','A cached history in another cold project connects its own owner and stays selected.');
  check((await page.evaluate(()=>window.calls)).filter(call=>['send','create','steer','enqueue'].includes(call.name)).length===0,'Cross-project reads do not replay unknown writes.');
  assert.deepEqual(errors,[]);assert.deepEqual(failures,[]);passed=true;
} finally {
 await writeFile(join(scratch,'result.json'),JSON.stringify({passed,checks,errors,failures},null,2));
 await browser?.close();await new Promise(resolve=>server.close(resolve));console.log(JSON.stringify({passed,scratch,checks,errors,failures}));
}
