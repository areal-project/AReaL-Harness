// Production renderer acceptance. Management is a deterministic external fixture;
// real install/receipt behavior is covered by plugin-p0-smoke.mjs.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..'), root = resolve(gui, '../..');
const require = createRequire(join(gui, 'app/package.json'));
const rendererRequire = createRequire(join(gui, 'renderer/package.json'));
const { chromium } = require('playwright-core');
const { createServer } = await import(pathToFileURL(rendererRequire.resolve('vite')).href);
const evidence = resolve(process.env.AREAL_PLUGIN_DETAIL_EVIDENCE ?? join(root, '.scratch/plugin-detail-implementation/ui-' + Date.now()));
await mkdir(evidence, { recursive: true });
const fixture = join(evidence, 'fixture.tsx');
await writeFile(fixture, `import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {PluginCenter} from '${join(gui, 'renderer/src/settings/PluginCenter.tsx')}';
import {ToastHost} from '${join(gui, 'renderer/src/ToastHost.tsx')}';
import {ApplicationIntlProvider} from '${join(gui, 'renderer/src/i18n/IntlProvider.tsx')}';
import {UnsavedChangesProvider} from '${join(gui, 'renderer/src/settings/UnsavedChanges.tsx')}';
import {setApplicationPreferences} from '${join(gui, 'renderer/src/settings/applicationPreferences.ts')}';
import '${join(gui, 'renderer/src/styles.css')}';
let mode='uninstalled',digest='a'.repeat(64),installed=false,auth='notStarted',state='disconnected',revision=1,lose=false,disabledSkills=[],disabledMcpServers=[];
const skill={id:'github@official/review',revision:'skill-r1',name:'Review changes',description:'Review a proposed change.',onboarding:false,allowImplicitInvocation:true};
const skillsOnly=()=>['skills-only','project-unknown'].includes(mode);
const calls=[]; let receipt;
const installedMetadata=()=>({name:'github',displayName:'GitHub',description:'Installed GitHub description.',version:'1.0.0',interface:{developerName:'Fixture developer',longDescription:'Read issues and review proposed changes.',defaultPrompt:['Review the current changes.'],category:'Development',websiteUrl:'https://example.com/plugin',privacyPolicyUrl:'https://example.com/privacy'},components:skillsOnly()?['skills']:['mcp']});
const support=()=>({digest,manifestFormat:'portable1',compatibility:{state:'allowed',reasonCodes:[]},validation:{provider:'unverified',platform:'unverified',distribution:'unverified'},components:[{kind:'mcp',sourceField:'mcp.json',status:'supported',reasonCodes:[],supportedSchema:'areal-mcp-document-envelope-v1',activationRequirements:['explicitMcpTrust','mcpConnection']},{kind:'uiSurfaces',sourceField:'plugin.json#/ui/surfaces/panel',status:'unsupported',reasonCodes:['componentNotImplemented'],supportedSchema:null,activationRequirements:[]}]});
const detail=()=>({installedMetadata:installed?installedMetadata():null,componentChoices:{disabledSkills,disabledMcpServers},interface:mode==='catalog-changed'?{developerName:'Candidate developer',longDescription:'Candidate-only description.'}:installedMetadata().interface,revision,id:'github@official',name:'github',displayName:mode==='catalog-changed'?'GitHub Next':'GitHub',description:mode==='catalog-changed'?'Candidate-only description.':'在对话中使用 GitHub。',version:mode==='catalog-changed'?'2.0.0':null,installed,installedVersion:installed?'1.0.0':null,installedDigest:installed?digest:null,installedSkills:installed&&skillsOnly()?[skill]:[],installedOnboardingSkill:null,enabled:installed,source:'/fixture/github',sourceDigest:mode==='catalog-changed'?'c'.repeat(64):digest,catalogSource:{type:'local',path:'/fixture/github'},componentSupport:skillsOnly()?{...support(),components:[]}:support(),installedComponentSupport:installed?(skillsOnly()?{...support(),components:[]}:support()):null,components:skillsOnly()?['skills']:['mcp'],diagnostics:['MCP declarations require explicit digest trust and connection'],skills:skillsOnly()?[skill]:[],onboardingSkill:null});
const connection=()=>({pluginId:'github@official',installedDigest:digest,state:state==='connected'?'connected':auth==='ready'?'disconnected':'authRequired',trusted:state==='connected',authenticationTiming:'ON_INSTALL',servers:skillsOnly()?[]:[{serverId:'github-mcp',projectEnabled:!disabledMcpServers.includes('github-mcp'),enabled:!disabledMcpServers.includes('github-mcp'),state:disabledMcpServers.includes('github-mcp')?'disabled':state==='connected'?'connected':auth==='ready'?'disconnected':'authRequired',authentication:'required',config:{title:'GitHub MCP',authentication:{},authenticationRequirements:{}}}],connectors:[],diagnostics:[]});
const action=async(_name,p)=>{calls.push({name:_name,...p});if(_name==='reconcile')return {outcomes:{}};switch(p.operation){
case'pluginCapabilities':return {enabled:true};
case'plugins':return {revision,data:[detail()],marketplaces:[{name:'official',root:'/fixture',sourceUrl:'https://github.com/openai/plugins'}],errors:[]};
case'plugin':return detail();case'pluginResolve':case'pluginArchiveImport':return detail();case'pluginArchivePick':return {canceled:false,fileName:'github.zip',selectionToken:'fixture-archive'};
case'pluginHooks':return {data:installed?[{pluginId:'github@official',installedDigest:digest,definitionDigest:'hooks',definitions:[],diagnostics:[]}]:[]};
case'pluginMcp':return {data:installed?[connection()]:[]};
case'pluginInstall':installed=true;return detail();
case'pluginComponentConfigure':assertComponent(p);if(p.component.kind==='skill')disabledSkills=p.enabled?[]:[p.component.id];else {disabledMcpServers=p.enabled?[]:[p.component.id];state='disconnected';}revision++;return detail();
case'pluginConfigure':return detail();case'pluginUninstall':installed=false;revision++;return detail();
case'skills':return {data:installed&&skillsOnly()&&!disabledSkills.length?[{...skill,available:true,pluginId:'github@official'}]:[]};
case'pluginAuth':if(mode==='auth-unknown'&&p.authOperation==='status')throw Error('Injected auth read failure');if(p.authOperation==='start')auth='pending';if(p.authOperation==='cancel')auth='cancelled';return auth==='notStarted'?null:{status:auth};
case'pluginConnection':state=p.connect&&mode!=='failed'?'connected':'disconnected';if(!p.connect)auth='ready';receipt=mode==='failed'?{confirmed:true,accepted:true,status:'failed',operation:{requestId:p.requestId,method:'areal/plugin/connection',target:{kind:'project'}},error:{message:'PLUGIN_EXECUTION_FAILED_SENTINEL'},message:'PLUGIN_EXECUTION_FAILED_SENTINEL'}:{confirmed:true,accepted:true,status:'completed',result:{}};if(lose){lose=false;throw Object.assign(new Error('连接回执丢失'),{submissionUnknown:true,requestId:p.requestId});}return {data:[connection()]};
case'pluginSubmission':return receipt;default:throw Error('Unexpected fixture operation '+p.operation);}};
function assertComponent(p){if(p.expectedRevision!==revision||p.expectedDigest!==digest)throw Error('STALE_COMPONENT_GUARD');}
function App(){const [epoch,setEpoch]=useState(0),[surface,setSurface]=useState('workspace');window.pluginFixture={calls,reset(next){mode=next;disabledSkills=[];disabledMcpServers=[];setSurface('workspace');installed=next!=='uninstalled';auth=next==='pending'?'pending':next==='ready'||next==='connected'||next==='unknown'||next==='failed'?'ready':'notStarted';state=next==='connected'?'connected':'disconnected';lose=next==='unknown'||next==='failed';revision++;setEpoch(x=>x+1);},swapDigest(){digest='b'.repeat(64);revision++;window.dispatchEvent(new Event('areal-plugins-changed'));},setReady(){auth='ready';mode='ready';},changeCatalog(){mode='catalog-changed';revision++;window.dispatchEvent(new Event('areal-plugins-changed'));},language(locale){setApplicationPreferences({locale});},};
const project={id:'fixture',name:'workspace',root:'/fixture',state:{connected:true},profiles:[{id:'standard',revision:1}],pending:mode==='project-unknown'?[{method:'areal/thread/start',params:{requestId:'00000000-0000-4000-a000-000000000111'},awaitingResponse:false}]:[]};window.pluginFixture.pending=project.pending;return <UnsavedChangesProvider><div style={{height:'100vh',display:'flex',background:'var(--color-background)'}}><PluginCenter key={epoch} project={project} projects={[project]} action={action} active surface={surface} marketRequest={0} onSettings={()=>setSurface("settings")} onMarket={()=>setSurface("workspace")} onChooseProject={()=>{}} onSelectProject={()=>{}} onStartDraft={async()=>{calls.push({operation:'startDraft'});}} /></div></UnsavedChangesProvider>;}
createRoot(document.getElementById('root')).render(<ApplicationIntlProvider><ToastHost/><App/></ApplicationIntlProvider>);`);
const server = await createServer({ root: join(gui, 'renderer'), configFile: join(gui, 'renderer/vite.config.ts'), mode: 'design-system', appType: 'custom', server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } } });
server.middlewares.use(async (req, res, next) => {
  if (req.url !== '/plugin-detail-acceptance.html') return next();
  res.setHeader('Content-Type', 'text/html');
  res.end(await server.transformIndexHtml(req.url, `<html><body><div id="root"></div><script type="module" src="/@fs${fixture}"></script></body></html>`));
});
await server.listen();
const origin = server.resolvedUrls.local[0];
let browser, page, passed = false, failure;
const errors = [], checks = [];
const button = name => page.getByRole('button', { name, exact: true });
async function open(mode, manage = true) {
  await page.evaluate(mode => window.pluginFixture.reset(mode), mode);
  await page.getByRole('tablist', { name: '市场范围', exact: true }).waitFor();
  await button('查看插件 github@official').click();
  await page.getByTestId('plugin-detail-page').waitFor();
  if (manage && mode !== 'uninstalled') { await button('管理').click(); await button('查看插件详情').waitFor(); }
}
async function waitChecked(name, value) {
  await page.waitForFunction(({name,value}) => [...document.querySelectorAll('[role=switch]')].some(el => el.getAttribute('aria-label') === name && el.getAttribute('aria-checked') === String(value)), {name,value});
}
async function capture(name) {
  await page.screenshot({ path: join(evidence, name + '.png'), animations: 'disabled' });
  await writeFile(join(evidence, name + '.aria.txt'), await page.locator('body').ariaSnapshot());
}
async function checkProjectRecovery() {
  await open('project-unknown');
  const skillSwitch=page.getByRole('switch',{name:'在当前项目启用 Skill Review changes',exact:true});
  assert.equal(await skillSwitch.isEnabled(),true,'unrelated creation must retain normal Skills management');
  const originalPending=await page.evaluate(()=>structuredClone(window.pluginFixture.pending));
  const beforeConfiguration=await page.evaluate(()=>window.pluginFixture.calls.length);
  await skillSwitch.click();
  await waitChecked('在当前项目启用 Skill Review changes',false);
  const configured=await page.evaluate(offset=>window.pluginFixture.calls.slice(offset).filter(call=>call.operation==='pluginComponentConfigure'),beforeConfiguration);
  assert.equal(configured.length,1);
  assert.equal(configured[0].enabled,false);
  assert.notEqual(configured[0].requestId,originalPending[0].params.requestId);
  assert.deepEqual(await page.evaluate(()=>window.pluginFixture.pending),originalPending);
  await page.getByText(/areal\/thread\/start/).waitFor();
  await page.getByText(/00000000-0000-4000-a000-000000000111/).waitFor();
  const previousCalls=await page.evaluate(()=>window.pluginFixture.calls.length);
  await button('核对项目操作').click();
  await page.waitForFunction(()=>window.pluginFixture.calls.some(call=>call.name==='reconcile'));
  await button('核对项目操作').waitFor({state:'visible'});
  const checkedCalls=await page.evaluate(offset=>window.pluginFixture.calls.slice(offset),previousCalls);
  assert.deepEqual(checkedCalls.filter(call=>call.name==='reconcile').map(call=>({projectId:call.projectId,requestId:call.requestId})),[{projectId:'fixture',requestId:originalPending[0].params.requestId}]);
  await page.getByText('已核对，原操作仍未确认。未重新提交。',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.pluginFixture.pending),originalPending);
  assert.equal(await skillSwitch.isEnabled(),true);
  assert.equal(checkedCalls.filter(call=>['create','send'].includes(call.name)||['pluginInstall','pluginConfigure','pluginConnection'].includes(call.operation)).length,0);
  await capture('13-project-operation-recovery');
  checks.push('unrelated creation retains normal Skills management; checking names original UUID and reports unresolved without replay or plugin writes');
}
try {
  browser = await chromium.launch({ headless: true, ...(process.env.AREAL_GUI_TEST_BROWSER ? { executablePath: process.env.AREAL_GUI_TEST_BROWSER } : { channel: 'chrome' }) });
  page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(15000);page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + 'plugin-detail-acceptance.html');
  await page.waitForFunction(() => !!window.pluginFixture);
  if (process.env.AREAL_PLUGIN_PROJECT_RECOVERY_ONLY === '1') {
    await checkProjectRecovery();assert.deepEqual(errors,[]);passed=true;
  } else {
  await page.getByRole('tablist', { name: '市场范围', exact: true }).waitFor();await button('添加资源').click();
  await page.getByRole('menuitem', { name: '上传插件包', exact: true }).click();await button('导入并预览').click();
  await page.getByRole('checkbox', { name: '我已核对以上来源、版本和摘要', exact: true }).waitFor();
  assert.equal(await button('安装到用户').isEnabled(), false);await button('取消安装').click();await button('安装').waitFor();
  checks.push('archive preview survives detail navigation and still requires explicit review');
  await open('uninstalled');await button('安装').waitFor();
  assert.equal(await page.getByRole('heading',{name:'MCP 连接',exact:true}).count(),1);
  assert.equal(await page.getByText('Fixture developer',{exact:true}).count()>0,true);
  assert.equal(await page.getByText('Read issues and review proposed changes.',{exact:true}).count(),1);
  assert.equal(await page.getByText('已安装 Skills（0）').count(), 0);
  await button('查看详情').focus();await page.keyboard.press('Enter');await button('收起详情').waitFor();await page.keyboard.press('Enter');
  assert.equal(await button('查看详情').evaluate(el => el === document.activeElement), true);
  await capture('01-uninstalled');await button('安装').click();
  await page.getByRole('checkbox', { name: '我已核对以上来源、版本和摘要', exact: true }).waitFor();
  const reviewPanel = page.getByRole('region', { name: '来源解析与预览', exact: true });
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '来源解析与预览');
  assert.equal(await reviewPanel.evaluate(el => { const box = el.getBoundingClientRect(); return box.top >= 0 && box.top < innerHeight - 80; }), true);
  await capture('01-install-review');
  assert.equal(await button('安装到用户').isEnabled(), false);
  await page.getByRole('checkbox', { name: '我已核对以上来源、版本和摘要', exact: true }).check();
  await button('安装到用户').click();await button('管理').click();await page.getByRole('heading', { name: '需要认证', exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: '插件钩子', exact: true }).count(), 0);
  checks.push('source review gates install; empty hooks/skills hidden; details keyboard/focus');
  await button('在浏览器中认证').click();await button('核对认证状态').waitFor();
  assert.equal(await button('在浏览器中认证').count(), 0);await capture('02-auth-pending');
  await page.evaluate(() => window.pluginFixture.setReady());await button('核对认证状态').click();await button('审阅并连接').waitFor();
  assert.equal(await page.evaluate(() => window.pluginFixture.calls.filter(c => c.operation === 'pluginConnection').length), 0);
  await button('审阅并连接').click();const consent = page.getByRole('checkbox', { name: '我信任当前安装快照，并允许启动其 MCP 服务。', exact: true });
  assert.equal(await consent.isChecked(), false);assert.equal(await button('信任并连接').isEnabled(), false);
  await consent.check();await capture('03-trust-review');
  const alignment = await consent.evaluate(el => {const a=el.getBoundingClientRect(),b=el.parentElement.querySelector('span').getBoundingClientRect();return {width:a.width,gap:b.left-a.right,top:Math.abs(a.top-b.top)};});
  assert(alignment.width>=18 && alignment.gap>=8 && alignment.gap<=16 && alignment.top<8);
  await page.evaluate(() => window.pluginFixture.swapDigest());await button('审阅并连接').waitFor();await button('审阅并连接').click();assert.equal(await consent.isChecked(), false);
  checks.push('auth start/status are separate; auth ready never connects; consent is readable and resets on digest change');
  await consent.check();await button('信任并连接').click();await page.getByRole('heading', { name: '已连接', exact: true }).waitFor();
    await page
    .getByRole("region", { name: "已安装组件支持", exact: true })
    .getByText("部分组件不受支持", { exact: true })
    .waitFor();
  await page
    .getByRole("region", { name: "已安装组件支持", exact: true })
    .getByText("当前会话的 Profile 决定实际准入。", { exact: true })
    .waitFor();
  assert.equal(await page.getByText("插件服务已可在对话中使用。", { exact: true }).count(), 0);
  checks.push(
    "digest-bound installed support displays optional unsupported UI and Thread-dependent admission",
  );
await button('试用').waitFor();await button('断开并撤销信任').waitFor();await capture('04-connected');
  await button('查看详情').click();await button('收起详情').waitFor();await capture('06-details-expanded');
  await button('断开并撤销信任').click();await button('审阅并连接').waitFor();
  checks.push('connected actions and disconnect/revoke transition');
  await open('unknown');await button('审阅并连接').click();await consent.check();await button('信任并连接').click();
  await page.getByRole('heading', { name: '连接结果待核对', exact: true }).waitFor();await capture('05-submission-unknown');
  assert.equal(await button('信任并连接').count(), 0);assert.equal(await button('管理启用范围').isEnabled(), false);
  const before = await page.evaluate(() => window.pluginFixture.calls.filter(c => c.operation === 'pluginConnection').length);
  await button('核对连接结果').click();await page.getByRole('heading', { name: '已连接', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.pluginFixture.calls.filter(c => c.operation === 'pluginConnection').length), before);
  checks.push('UNKNOWN blocks writes and recovers original receipt without replay');
  await open('failed');await button('审阅并连接').click();await consent.check();await button('信任并连接').click();
  await page.getByRole('heading', { name: '连接结果待核对', exact: true }).waitFor();
  const failedBefore=await page.evaluate(()=>window.pluginFixture.calls.filter(c=>c.operation==='pluginConnection').length);
  await button('核对连接结果').click();await button('审阅并连接').waitFor();
  assert.match(await page.locator('body').innerText(),/PLUGIN_EXECUTION_FAILED_SENTINEL/,'an admitted failed plugin receipt must show its execution error');
  assert.equal(await page.evaluate(()=>window.pluginFixture.calls.filter(c=>c.operation==='pluginConnection').length),failedBefore,'a failed receipt query never replays the original operation');
  checks.push('admitted failed plugin receipt remains an execution failure and is not replayed');
  await capture('08-failed-receipt');
  await open('auth-unknown');await page.getByRole('heading', { name: '认证结果待核对', exact: true }).waitFor();
  assert.equal(await button('在浏览器中认证').count(), 0);assert.equal(await button('取消本次认证').count(), 0);
  await page.evaluate(() => window.pluginFixture.setReady());await button('核对认证状态').click();await button('审阅并连接').waitFor();
  checks.push('auth read failure is UNKNOWN, not an active attempt; only status query recovers it');
  await open('connected',false);await page.evaluate(()=>window.pluginFixture.changeCatalog());
  await button('管理').click();await button('核对新快照').waitFor();await button('查看插件详情').click();
  await page.getByRole('heading',{name:'GitHub',exact:true}).waitFor();
  assert.equal(await page.getByText('Read issues and review proposed changes.',{exact:true}).count(),1);
  assert.equal(await page.getByText('Candidate-only description.',{exact:true}).count(),0);
  assert.equal(await page.getByText('1.0.0',{exact:true}).count(),1);
  await button('管理').click();await button('核对新快照').click();await page.getByText('2.0.0',{exact:true}).waitFor();await button('取消安装').click();
  checks.push('installed presentation stays bound to installed metadata while source review uses candidate version');
  await open('skills-only',false);
  await page.getByRole('heading',{name:'Skills',exact:true}).waitFor();
  assert.equal(await page.getByRole('heading',{name:'MCP 连接',exact:true}).count(),0);
  assert.equal(await button('在浏览器中认证').count(),0);
  await button('管理').click();const skillSwitch=page.getByRole('switch',{name:'在当前项目启用 Skill Review changes',exact:true});
  assert.equal(await skillSwitch.isChecked(),true);await skillSwitch.click();await page.waitForFunction(()=>window.pluginFixture.calls.some(c=>c.operation==='pluginComponentConfigure'&&c.component.kind==='skill'&&!c.enabled));
  await waitChecked('在当前项目启用 Skill Review changes',false);assert.equal(await skillSwitch.isChecked(),false);await button('查看插件详情').click();await button('管理').click();assert.equal(await skillSwitch.isChecked(),false);
  const changed=await page.evaluate(()=>window.pluginFixture.calls.filter(c=>c.operation==='pluginComponentConfigure').at(-1));assert.equal(changed.expectedDigest.length,64);assert.equal(typeof changed.expectedRevision,'number');
  await capture('09-skills-management');checks.push('skills-only detail hides MCP and authentication; component choice persists across settings navigation with revision and digest');
  await checkProjectRecovery();
  await open('connected');const serverSwitch=page.getByRole('switch',{name:'在当前项目启用 MCP GitHub MCP',exact:true});await serverSwitch.click();await waitChecked('在当前项目启用 MCP GitHub MCP',false);assert.equal(await serverSwitch.isChecked(),false);assert.equal(await button('在浏览器中认证').count(),0);await serverSwitch.click();await button('审阅并连接').waitFor();checks.push('MCP choices persist and enabling requires explicit reconnect');
  await button('查看插件详情').click();await capture('10-content-detail');
  await page.evaluate(()=>window.pluginFixture.language('en'));await button('Manage').waitFor();await capture('11-content-detail-english');await button('Manage').click();await button('View plugin details').waitFor();await capture('12-management-english');checks.push('content detail and management render in English');
  await button('View plugin details').click();
  await page.setViewportSize({ width: 900, height: 850 });await page.evaluate(() => document.documentElement.classList.add('dark'));await capture('07-narrow-dark');
  const overflow = await page.getByTestId('plugin-detail-page').evaluate(el => el.scrollWidth > el.clientWidth + 1);assert.equal(overflow, false);
  assert.deepEqual(errors, []);checks.push('narrow/dark has no detail overflow or renderer errors');passed=true;
  }
} catch (error) {failure={message:error.message,stack:error.stack};process.exitCode=1;if(page)await capture('failure');}
finally {
  await browser?.close();await server.close();
  const hashes={};for(const file of ['settings/PluginCenter.tsx','settings/PluginConnectionPanel.tsx','settings/PluginCenter.css'])hashes[file]=createHash('sha256').update(await readFile(join(gui,'renderer/src',file))).digest('hex');
  await writeFile(join(evidence,'manifest.json'),JSON.stringify({passed,failure,checks,errors,hashes,scope:'production renderer, deterministic management fixture; no Core/provider/native acceptance'},null,2));
  console.log(JSON.stringify({passed,evidence,failure,checks,errors},null,2));
}
