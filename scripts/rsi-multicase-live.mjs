// 多场景真实 RSI：模型产物与浏览器评测隔离；请求先记账再发送。
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile,rename,copyFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {connect} from '../examples/desktop-api/client.mjs';
import {scenarios,mustPass} from './rsi-scenarios.mjs';
const require=createRequire(new URL('../clients/gui/app/package.json',import.meta.url));
const {chromium}=require('playwright-core');
const [configArg,outputArg]=process.argv.slice(2);
assert(configArg&&outputArg,'usage: node scripts/rsi-multicase-live.mjs CONFIG OUTPUT');
const output=resolve(outputArg),privateDir=join(output,'.private'),workspace=join(privateDir,'workspace'),data=join(privateDir,'data');
const digest=x=>createHash('sha256').update(x).digest('hex');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function json(path,value){await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path+'.tmp',JSON.stringify(value,null,2));await rename(path+'.tmp',path);}
async function readJson(path,fallback){try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
await mkdir(workspace,{recursive:true,mode:0o700});await mkdir(join(privateDir,'user'),{recursive:true,mode:0o700});
await writeFile(join(workspace,'brief.txt'),'Independent offline UI experiments. Each query and rubric are fixed before candidate generation. Do not access other candidates or evaluator files.\n');
const binarySha256=digest(await readFile('target/debug/areal'));
let child,rpc,browser,server,log='',summary=await readJson(join(output,'summary.json'),{startedAt:new Date().toISOString(),model:'gpt-6.1-sol / real provider, native Core + Runtime',binarySha256,cases:[]});
assert.equal(summary.binarySha256,binarySha256,'Do not resume a live experiment using a different Core binary.');
const pages=new Map();
let summaryWrites=Promise.resolve();
function saveSummary(){summaryWrites=summaryWrites.then(()=>json(join(output,'summary.json'),summary));return summaryWrites;}
async function start(){
 child=spawn('/usr/bin/python3',['scripts/launch.py','--bin-dir',resolve('target/debug'),'--config',resolve(configArg),'--listen','127.0.0.1:0','--data-dir',data,'--workspace',workspace,'--allow-write','--permissions','yolo','--model-concurrency',process.env.RSI_MULTI_CONCURRENCY||'3'],{env:{...process.env,HOME:join(privateDir,'user'),AREAL_HARNESS_HOME:join(privateDir,'harness'),NO_PROXY:'127.0.0.1,localhost',no_proxy:'127.0.0.1,localhost'},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
 const deadline=Date.now()+60000;while(!/ws:\/\/127\.0\.0\.1:\d+/.test(log)){assert(child.exitCode===null&&Date.now()<deadline,'Core did not become ready; see private log');await delay(100);}
 rpc=await connect(log.match(/ws:\/\/127\.0\.0\.1:\d+/)[0],join(data,'security/auth.json'));
 await rpc.call('areal/capabilities');
 server=createServer((req,res)=>{const html=pages.get(req.url.split('?')[0]);if(!html){res.writeHead(404);res.end();return;}res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
}
async function settle(threadId,id){
 let previous='';const end=Date.now()+2520000;
 while(Date.now()<end){const view=await rpc.call('areal/goal/get',{threadId});const cs=view.goal.rsi.candidates;const status=cs.map(c=>c.status).join(',');if(status!==previous){console.log(JSON.stringify({case:id,stage:'settling',status,usage:view.goal.usage}));previous=status;}
 if(view.goal.rsi.phase!=='running')return view;await delay(1200);}
 throw Error(id+': exceeded 25 minute round deadline');
}
async function waitAccounting(threadId,id){
 for(let i=0;i<90;i++){const v=await rpc.call('areal/goal/get',{threadId});if(v.goal.usage.accountingComplete)return v;console.log(JSON.stringify({case:id,stage:'waiting-accounting',unknownRequests:v.goal.usage.unknownRequests}));await delay(2000);}throw Error(id+': accounting did not settle after 180 seconds');
}
async function artifact(threadId,goalId,candidateId){let offset=0,sha;const chunks=[];for(;;){const p=await rpc.call('areal/goal/candidateArtifact',{threadId,goalId,candidateId,offset});chunks.push(Buffer.from(p.dataBase64,'base64'));sha=p.sha256;if(p.complete)break;assert(p.nextOffset>offset);offset=p.nextOffset;}const bytes=Buffer.concat(chunks);assert.equal(digest(bytes),sha);return{bytes,sha};}
async function browserEval(s,c,bytes,dir){
 const candidateUrl=`http://127.0.0.1:${server.address().port}/${s.id}/${c.id}`;pages.set(`/${s.id}/${c.id}`,bytes);
 const errors=[],blocked=[];const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce',serviceWorkers:'block',acceptDownloads:false});
 // 仅本候选文档同源；其它 localhost 端口也阻断。WebSocket 单独阻断。
 await context.route('**/*',route=>{const url=route.request().url();if(url===candidateUrl||url.startsWith('data:')||url.startsWith('blob:'))return route.continue();blocked.push(url);return route.abort();});
 if(context.routeWebSocket)await context.routeWebSocket('**/*',ws=>{blocked.push(ws.url());ws.close();});
 const page=await context.newPage();page.setDefaultTimeout(1800);page.on('pageerror',e=>errors.push(e.message));
 let evaluated;
 try{await page.goto(candidateUrl,{waitUntil:'networkidle',timeout:12000});evaluated=await s.evaluate(page,{baseUrl:candidateUrl,desktopPath:join(dir,`${c.id}-desktop.png`),mobilePath:join(dir,`${c.id}-mobile.png`)});}catch(e){evaluated={checks:[{id:'evaluationCompleted',passed:false,detail:e.message}],details:{}};}
 const checks=Object.fromEntries((evaluated.checks||[]).map(x=>[x.id,!!x.passed]));const details={...(evaluated.details||{}),...Object.fromEntries((evaluated.checks||[]).filter(x=>x.detail).map(x=>[x.id,x.detail]))};
 checks.noRuntimeErrors=errors.length===0;checks.offlineAssets=blocked.length===0;checks.semanticMain=await page.locator('main').count()===1;
 await context.close();const count=Object.values(checks).filter(Boolean).length,score=Math.round(count/Object.keys(checks).length*100);
 const required=mustPass[s.id]||Object.keys(checks);const eligible=required.every(k=>checks[k]===true)&&checks.noRuntimeErrors&&checks.offlineAssets;
 const failures=Object.entries(checks).filter(([,v])=>!v).map(([k])=>`${k}: ${String(details[k]||'expected behavior not observed').slice(0,220)}`);
 return{artifactSha256:digest(bytes),rubricId:s.rubricId,evaluator:'Independent Playwright Chromium; frozen case contract',taskId:s.id,checks,score,eligible,feedback:`Functional checks ${count}/${Object.keys(checks).length}. ${failures.length?'Failures: '+failures.join('; '):'All fixed checks passed; do not infer visual superiority or generalization.'}`,evidence:[`${c.id}-browser.json`,`${c.id}-desktop.png`,`${c.id}-mobile.png`],details,errors,blocked,required};
}
async function record(s,run,view,dir){
 for(const c of view.goal.rsi.candidates.filter(c=>['completed','selected'].includes(c.status)&&!c.evaluations.length)){
 const {bytes,sha}=await artifact(run.threadId,view.goal.id,c.id);await writeFile(join(dir,`${c.id}.html`),bytes);const evaluation=await browserEval(s,c,bytes,dir);assert.equal(sha,evaluation.artifactSha256);await json(join(dir,`${c.id}-browser.json`),evaluation);
 const {eligible,details,errors,blocked,required,...receipt}=evaluation;
 view=await mutate(run,`evaluate-${c.id}`,'areal/goal/evaluateCandidate',{threadId:run.threadId,goalId:view.goal.id,expectedRevision:view.revision,candidateId:c.id,evaluation:receipt});
 console.log(JSON.stringify({case:s.id,stage:'evaluated',candidate:c.id,score:evaluation.score,eligible,failures:Object.keys(evaluation.checks).filter(k=>!evaluation.checks[k])}));
 }
 await json(join(dir,'exploration.json'),view);return view;
}
// 同操作始终重试同一请求；响应丢失后不得随机换ID或静默重复分叉。
async function mutate(run,key,method,params){
 const file=join(privateDir,`${run.caseId}-journal.json`),journal=await readJson(file,{});let entry=journal[key];
 if(!entry){entry={method,params:{requestId:digest(run.threadId+':'+key).slice(0,32),...params}};journal[key]=entry;await json(file,journal);}
 assert.equal(entry.method,method);const result=await rpc.call(entry.method,entry.params);entry.accepted=true;await json(file,journal);return result;
}
const baseHarness='Use a bounded contract-first UI workflow. The assigned output path and its provisioned parent are authoritative. Read the fs_create schema and write one complete self-contained UTF-8 HTML document directly using fs_create, then finish. Do not probe directories, run shell commands, or claim browser testing. Independently evaluated interaction hooks must correspond to visible usable controls. Preserve accessible keyboard behavior, responsive layout, and a distinctive deliberate visual composition.';
function variant(parent,branch,depth){
 const observed=parent.evaluations.at(-1);
 const failures=observed?Object.keys(observed.checks).filter(k=>!observed.checks[k]):['artifactDelivery'];
 const targeted=failures.length?'Measured parent failures to specifically prevent: '+failures.join(', ')+'. For each, trace the actual user action, required state, visible DOM and resulting persisted state before writing.':'Parent already passed the fixed functional rubric. This is a robustness/visual alternative, not evidence of higher quality; preserve all accepted behavior.';
 const shared=`${baseHarness}\n\nIteration ${depth}; branch ${branch}. Apply the observed parent failures to the generation procedure; regenerate from the same original brief (parent HTML is not provided). Preserve all fixed query requirements. ${depth>=2?'Before writing, trace negative and positive state transitions, reset/reload behavior and native event semantics.':''} ${depth>=3?'Final regression pass in reasoning: enumerate every visible selector and interaction, including 390px reachability and focus return. Do not add arbitrary code or manufacture test receipts.':''}`;
 const emphasis=branch==='behavior'?'Use an explicit state model and named render/update functions. Validate user input before mutating state; handle rapid/repeated actions and reset. Use semantic native controls and deterministic completion conditions.':'Art-direct an intentional editorial interface with a distinctive hero/board, balanced type scale and spacing. Use min-width:0 in grids, bounded inline SVG viewports, fluid columns and >=44px tap targets. Never mask content clipping with document-level overflow:hidden. Ensure overlays close and restore keyboard focus.';
 return{label:`${branch}-d${depth}`,hypothesis:branch==='behavior'?'Explicit state and negative-path checks may address measured interaction failures.':'Responsive containment and native accessible controls may address measured layout and interaction failures.',harness:shared+'\n\n'+emphasis+'\n\n'+targeted};
}
async function runCase(s){
 const dir=join(output,s.id);await mkdir(dir,{recursive:true});const runFile=join(dir,'run.json');let run=await readJson(runFile,null),view;
 await json(join(dir,'rubric.json'),{id:s.rubricId,query:s.query,mustPass:mustPass[s.id],note:'Fixed browser behavior checks; no automatic aesthetic score. External skills disabled. Actual generated HTML is never patched by evaluator.'});
 if(!run){const t=await rpc.call('areal/thread/start',{requestId:digest(s.id+Date.now()).slice(0,32),cwd:workspace});run={caseId:s.id,threadId:t.thread.id,objective:s.query,startedAt:new Date().toISOString()};await json(runFile,run);}
 const existing=await rpc.call('areal/goal/get',{threadId:run.threadId});
 if(!existing.goal){
 const t=await rpc.call('thread/read',{threadId:run.threadId,includeTurns:true});
 await rpc.call('areal/thread/configure',{threadId:run.threadId,expectedRevision:t.thread.desktop.configuration.revision,selectedSkills:[],parameters:{reasoningEffort:'low',maxOutputTokens:18000},options:{readOnly:false,toolAllowlist:['fs_create'],maxModelRounds:4,systemPrompt:'You are a skilled product UI engineer. Produce the assigned standalone HTML file through the permitted filesystem tool. Its parent exists. Follow the fixed UI interaction contract. Do not access other files. Think concisely and deliver a complete polished page, not a report.',appendInstructions:''}});
 view=await mutate(run,'create','areal/goal/create',{threadId:run.threadId,expectedRevision:0,objective:s.query,workflow:'rsiArtifact',outputFormat:'html',maxActiveSeconds:2400,tokenBudget:Number(process.env.RSI_MULTI_BUDGET||1600000)});
 }else view=existing;
 view=await record(s,run,await settle(run.threadId,s.id),dir);await waitAccounting(run.threadId,s.id);view=await rpc.call('areal/goal/get',{threadId:run.threadId});
 let roots=view.goal.rsi.candidates.filter(c=>c.round===0).sort((a,b)=>(b.evaluations.at(-1)?.score??-1)-(a.evaluations.at(-1)?.score??-1));
 for(let branchIndex=0;branchIndex<2;branchIndex++){
 const branch=branchIndex===0?'behavior':'responsive';let parent=roots[branchIndex];
 for(let depth=1;depth<=3;depth++){
 let child=view.goal.rsi.candidates.find(c=>c.parentCandidateId===parent.id&&c.label===`${branch}-d${depth}`);
 if(!child){const feedback=parent.evaluations.at(-1)?.feedback||`Execution failed: ${parent.error}. Deliver the artifact with a bounded direct write.`;const report=await readJson(join(dir,`${parent.id}-browser.json`),null);
 const plan={parentCandidateId:parent.id,feedback:feedback+(report?' Independent measured details: '+JSON.stringify(report.details).slice(0,1800):''),variants:[variant(parent,branch,depth)]};await json(join(dir,`${branch}-d${depth}-plan.json`),plan);
 view=await mutate(run,`${branch}-d${depth}`,'areal/goal/evolve',{threadId:run.threadId,goalId:view.goal.id,expectedRevision:view.revision,...plan});
 }
 view=await record(s,run,await settle(run.threadId,s.id),dir);await waitAccounting(run.threadId,s.id);view=await rpc.call('areal/goal/get',{threadId:run.threadId});child=view.goal.rsi.candidates.find(c=>c.parentCandidateId===parent.id&&c.label===`${branch}-d${depth}`);assert(child);parent=child;
 }
 }
 // 严格只比较同一固定 rubric，同分保留旧节点；必过检查缺失不晋升。
 const reports={};for(const c of view.goal.rsi.candidates){const r=await readJson(join(dir,`${c.id}-browser.json`),null);if(r)reports[c.id]=r;}
 const valid=view.goal.rsi.candidates.filter(c=>reports[c.id]?.rubricId===s.rubricId&&reports[c.id].eligible).sort((a,b)=>reports[b.id].score-reports[a.id].score||Number(a.id.split('-')[1])-Number(b.id.split('-')[1]));
 let selection={candidateId:null,reason:'No candidate passed required checks; no promotion.',policy:'same rubric + must-pass gates; ties retain earliest candidate'};
 if(valid.length){const best=valid[0];selection={...selection,candidateId:best.id,reason:`${best.id} passes all mandatory checks. Highest comparable functional score; ties retain earlier candidate. No aesthetic superiority claimed.`};if(view.goal.rsi.phase==='awaitingSelection')view=await mutate(run,'select','areal/goal/selectCandidate',{threadId:run.threadId,goalId:view.goal.id,expectedRevision:view.revision,candidateId:best.id});await copyFile(join(dir,`${best.id}.html`),join(dir,'winner.html'));}
 const requestProof=[];for(const c of view.goal.rsi.candidates){const req=await readJson(join(data,'rsi',view.goal.id,c.id,'request.json'),null);if(req)requestProof.push({candidateId:c.id,inputDigest:req.inputDigest,configurationDigest:digest(JSON.stringify(req.configuration)),harnessDigest:digest(c.harness),runId:c.runId});}
 assert(requestProof.length===9,'Each case must contain nine actual dispatches');assert.equal(new Set(requestProof.map(r=>r.inputDigest)).size,1);assert.equal(new Set(requestProof.map(r=>r.configurationDigest)).size,1);
 const proof={inputDigest:requestProof[0].inputDigest,configurationDigest:requestProof[0].configurationDigest,binarySha256,dispatches:requestProof,externalSkills:'disabled',generation:'real provider via owned native Core/Runtime',breadth:3,depth:3,branchTips:2};
 await json(join(dir,'exploration.json'),view);await json(join(dir,'proof.json'),proof);await json(join(dir,'selection.json'),selection);
 const result={id:s.id,title:s.title,query:s.query,rubricId:s.rubricId,exploration:view,selection,proof,browserReports:reports};const index=summary.cases.findIndex(c=>c.id===s.id);if(index<0)summary.cases.push(result);else summary.cases[index]=result;
 await saveSummary();console.log(JSON.stringify({case:s.id,stage:'complete',selection,usage:view.goal.usage}));return result;
}
try{await start();const active=scenarios.filter(s=>!process.env.RSI_MULTI_CASES||process.env.RSI_MULTI_CASES.split(',').includes(s.id));const results=await Promise.allSettled(active.map(runCase));for(let i=0;i<results.length;i++)if(results[i].status==='rejected')console.error(JSON.stringify({case:active[i].id,error:results[i].reason.stack}));summary.finishedAt=new Date().toISOString();await json(join(output,'summary.json'),summary);assert(results.every(r=>r.status==='fulfilled'),'One or more case runs incomplete; durable journals allow resuming without duplicate branches.');}
finally{await writeFile(join(privateDir,'core.log'),log,{mode:0o600});rpc?.close();await browser?.close();if(server)await new Promise(r=>server.close(r));if(child&&child.exitCode===null){child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),10000);await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));clearTimeout(timer);}}
