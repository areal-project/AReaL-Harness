import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile, mkdtemp, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  createServer,
  transformWithEsbuild,
} from "../renderer/node_modules/vite/dist/node/index.js";
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { chromium } = require("playwright-core");
const evidence = process.env.AREAL_WORKTREE_UI_EVIDENCE || (await mkdtemp("/tmp/aw-ui-"));
await mkdir(evidence, { recursive: true });
const entry = String.raw`
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ToastHost} from '/src/ToastHost.tsx';
import {FeedbackNotice} from '/src/FeedbackNotice.tsx';
import {ApplicationIntlProvider} from '/src/i18n/IntlProvider.tsx';
import {useAppearance,setApplicationPreferences} from '/src/settings/applicationPreferences.ts';
import {WorktreeStarter} from '/src/WorktreeStarter.tsx';
import {WorktreeStatus,WorktreeActions} from '/src/WorktreeStatus.tsx';
import {Messages} from '/src/Messages.tsx';
import {DraftComposer} from '/src/DraftComposer.tsx';
import {MemoTaskItem} from '/src/TaskListItem.tsx';
import {WorktreesSettings} from '/src/settings/WorktreesSettings.tsx';
import {SettingsPage} from '/src/settings/SettingsWorkspace.tsx';
import {UnsavedChangesProvider} from '/src/settings/UnsavedChanges.tsx';
import '/src/styles.css';
const params=new URLSearchParams(location.search);
const project={id:'logical',name:'AReaL Harness long project title with production components',root:'/fixture/source',models:[],profiles:[],pending:[],outcomes:{},state:{connected:true},mcpServers:[]};
const scripts={default:'echo default setup',macos:'echo mac setup',linux:'echo linux setup'};
const actions=['Build','Test','Preview'].map((name,index)=>({id:'action-'+index,name,script:{default:'echo '+name,linux:'echo linux '+name}}));
const environments=[{id:'dev',name:'Development',setup:scripts,cleanup:{default:'echo cleanup'},actions:[]},{id:'quality',name:'Quality',setup:scripts,cleanup:{default:'echo cleanup'},actions}];
let listing={settings:{worktreeRoot:'',branchPrefix:'areal',fetchBeforeCreate:false,autoCleanup:false,keepCount:10},defaultRoot:'~/.areal/worktrees',revision:1,projects:[{...project,environments,environmentRevision:1},{id:'docs',name:'Documentation',root:'/fixture/documentation',environments:[],environmentRevision:1},{id:'empty',name:'Empty project',root:'/fixture/empty',environments:[],environmentRevision:1}],worktrees:[{requestId:'worktree-request-1',projectId:'logical',threadId:'bound',threadTitle:'Review the long workspace identity',state:'ready',directory:'/fixture/new-trees/long-directory-name-that-must-wrap/task-proof',branch:'areal/gui-proof',environment:environments[0]},{requestId:'worktree-request-2',projectId:'docs',threadId:'docs-bound',state:'ready',directory:'/fixture/new-trees/documentation',branch:'areal/docs'}]};
if(params.get('actions')==='full')listing.worktrees[0].environment=environments[1];
window.fixtureCalls=[];
window.fixtureRecovery=params.has('recovery');
if(params.has('unrelated-pending')){
 project.models=[{providerId:'fixture',modelId:'fixture-model',name:'Fixture model',available:true,isDefault:true,parameters:{}}];
 project.pending=[{method:'areal/thread/start',params:{requestId:params.get('unrelated-pending')==='invalid'?'invalid-request':'00000000-0000-4000-a000-000000000111'},awaitingResponse:false}];
 window.fixturePending=project.pending;
 if(params.get('unrelated-pending')==='own')localStorage.setItem('fixture-draft:pending-create',project.pending[0].params.requestId);
 localStorage.setItem('fixture-draft','[111](#sess_existing-source) 这个会话记录是什么');
}

if(window.fixtureRecovery){localStorage.setItem('fixture-draft','retain this input');localStorage.setItem('fixture-draft:pending-create','00000000-0000-4000-a000-000000000001');localStorage.setItem('fixture-draft:pending-create-request',JSON.stringify({projectId:'logical',requestId:'00000000-0000-4000-a000-000000000001',worktree:{ref:'main'}}));}
if(params.get('recovery')==='accepted'){project.pending=[{params:{requestId:'unrelated-request'}}];project.outcomes['00000000-0000-4000-a000-000000000001']={accepted:true,status:'completed',operation:{requestId:'00000000-0000-4000-a000-000000000001',method:'areal/thread/start',target:{kind:'thread',threadId:'known-created'}},threadId:'known-created'};}
const fixtureTurn=(id,text)=>({id,status:'completed',items:[{id:id+'-user',type:'userMessage',content:[{type:'text',text}]},{id:id+'-assistant',type:'agentMessage',phase:'final_answer',text:'Fixture response '+id}]});
const action=async(name,params={})=>{
 window.fixtureCalls.push({name,params});
 if(name==='manage'&&params.operation==='inheritedHistory')return {snapshotId:'fixture-snapshot',complete:true,data:fixtureTurn('ancestor','Inherited ancestor prompt').items.map(item=>({sourceTurnId:'ancestor',sourceTurnStatus:'completed',sourceItemId:item.id,item}))};
 if(name==='create'&&params.requestId&&window.fixturePending)return {threadId:'fresh-created'};
 if(window.fixtureRecovery)throw Object.assign(new Error('Original request still uncertain'),{submissionUnknown:true,requestId:params.requestId});
 if(window.fixtureFail)throw new Error('Fixture directory unavailable');
 if(params.operation==='worktreeOptions')return {worktrees:[{root:'/fixture/source',branch:'main',head:'a'.repeat(40),dirty:true},{root:'/fixture/existing',branch:'feature/source',head:'b'.repeat(40)}],branches:['main','release','feature/a-very-long-branch-name-that-must-remain-readable-when-focused',...Array.from({length:30},(_,index)=>'feature/local-'+index),'origin/main','origin/release'],settings:listing.settings,environments,environmentRevision:1};
 if(params.operation==='worktreeList')return structuredClone(listing);
 if(params.operation==='worktreeDelete')return {deleted:false,deletion:{blockers:['Fixture blocker: uncommitted changes remain in this directory']}};
 if(params.operation==='worktreeSettings'){listing={...listing,revision:listing.revision+1,settings:{worktreeRoot:params.worktreeRoot,branchPrefix:params.branchPrefix,fetchBeforeCreate:params.fetchBeforeCreate,autoCleanup:params.autoCleanup,keepCount:params.keepCount}};return listing.settings;}
 if(params.operation==='worktreeEnvironmentSave'){const owner=listing.projects.find(item=>item.id===params.projectId);owner.environments=[...owner.environments.filter(item=>item.id!==params.environment.id),structuredClone(params.environment)];owner.environmentRevision++;return {environments:structuredClone(owner.environments),environmentRevision:owner.environmentRevision};}
 if(params.operation==='worktreeAction')return new Promise(resolve=>{window.resolveFixtureAction=()=>resolve({status:window.fixtureActionState||'succeeded',output:'Fixture action output',message:window.fixtureActionState==='unknown'?'Fixture action result needs checking':window.fixtureActionState==='failed'?'Fixture action failed':undefined});});
 return {};
};
function Fixture(){
 const [dark,setDark]=useState(false);useAppearance(dark);
 const [selection,setSelection]=useState();const [events,setEvents]=useState([]);const [current,setCurrent]=useState();
 window.updateEvents=(value,record)=>{setEvents(value);setCurrent(record);};
 window.setFixtureAppearance=({dark,size,reducedMotion})=>{setDark(dark);document.documentElement.classList.toggle('dark',dark);document.documentElement.style.setProperty('--ui-font-size',size+'px');document.documentElement.style.fontSize=size+'px';setApplicationPreferences({contentSize:size,reducedMotion:reducedMotion?'on':'off'});};
 if(params.has('messages')){const kind=params.get('messages');const thread={id:'worktree-thread',conversation:kind==='inherited'?{kind:'fork',historySeed:{snapshotId:'fixture-snapshot'}}:undefined,turns:[fixtureTurn('local-own',kind==='partial'?'Later paginated local prompt':'First own local prompt')],displayHistory:{supported:kind==='partial',complete:kind!=='partial',latestTurnComplete:true},worktree:{state:'ready',directory:'/fixture/new-trees/task-proof',branch:'areal/gui-proof'}};return <main className='h-full bg-background p-6 text-foreground'><Messages project={project} thread={thread} action={action} dark={dark} embedded readOnly onLink={()=>{}} onFile={()=>{}} onReview={()=>{}} readTurnReview={async()=>({})}/></main>;}
 if(params.has('toast'))return <main className='p-6'><button onClick={()=>setEvents(events=>[...events,{}])}>更新快照</button><FeedbackNotice requestId='same-request' tone={events.length>2?'error':'warning'} message='正在核对操作' actions={<button onClick={()=>window.fixtureCalls.push({name:'check'})}>核对通知</button>}/><FeedbackNotice requestId='same-request' tone={events.length>2?'error':'warning'} message='正在核对操作' actions={<button onClick={()=>window.fixtureCalls.push({name:'check'})}>核对通知</button>}/></main>;
 if(params.has('unrelated-pending'))return <main className='p-6'><DraftComposer project={project} backendReady draftKey='fixture-draft' action={action} onOpen={async()=>{}} onPanel={()=>{}} /></main>;
 if(window.fixtureRecovery)return <main className='p-6'><DraftComposer project={{...project,state:{connected:false}}} draftKey='fixture-draft' action={action} onOpen={async(pid,tid)=>window.fixtureCalls.push({name:'opened',params:{projectId:pid,threadId:tid}})} onPanel={()=>{}} /></main>;
 if(params.has('settings'))return <main className='h-full bg-background text-foreground'><UnsavedChangesProvider><SettingsPage title='Worktrees'><WorktreesSettings action={action} projects={listing.projects} onAddProject={async()=>{window.fixtureCalls.push({name:'addProject',params:{}});return undefined;}}/></SettingsPage></UnsavedChangesProvider></main>;
 if(params.has('sidebar'))return <main className='w-80 max-w-full p-3'><ul><MemoTaskItem id='ordinary' title='Ordinary conversation' active={false} pinned={false} running={false} attention={false} archived={false} disabled={false} onSelect={()=>{}} onRename={()=>{}} onPin={()=>{}} onArchive={()=>{}}/><MemoTaskItem id='bound' title='A long conversation title remains the primary sidebar content' worktree={{branch:'areal/a-very-long-branch-name',directory:'/fixture/new-trees/task-proof',state:'ready'}} active={true} pinned={false} unread={true} running={false} attention={false} archived={false} disabled={false} onSelect={()=>{}} onRename={()=>{}} onPin={()=>{}} onArchive={()=>{}}/><MemoTaskItem id='running' title='Running worktree conversation' worktree={{branch:'areal/gui-proof',directory:'/fixture/new-trees/task-proof',state:'settingUp'}} active={false} pinned={false} running={true} attention={false} archived={false} disabled={false} onSelect={()=>{}} onRename={()=>{}} onPin={()=>{}} onArchive={()=>{}}/></ul></main>;
 if(params.has('actions'))return <main className='p-6'><WorktreeActions projectId='logical' threadId='bound' worktree={{branch:'areal/gui-proof',directory:'/fixture/new-trees/task-proof'}} action={action}/></main>;
 return <main className='mx-auto flex h-full w-full max-w-2xl flex-col bg-background p-6 text-foreground'><div style={{marginTop:events.length?undefined:'auto'}} className='flex min-w-0 items-center justify-between gap-2'><span className='min-w-0 truncate text-ui-sm'>{project.name} · 此电脑</span><WorktreeStarter project={project} action={action} value={selection} onChange={value=>{window.fixtureSelection=value;setSelection(value);}} onConfigureEnvironments={()=>window.fixtureCalls.push({name:'configureEnvironments',params:{projectId:project.id}})}/></div><WorktreeStatus events={events} current={current}/></main>;
}
createRoot(document.getElementById('root')).render(<ApplicationIntlProvider><ToastHost/><Fixture/></ApplicationIntlProvider>);
`;
const virtual = "\0worktree-fixture.tsx";
const vite = await createServer({
  root: join(gui, "renderer"),
  configFile: join(gui, "renderer/vite.config.ts"),
  mode: "design-system",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "worktree-production-fixture",
      resolveId(id) {
        if (id === "/worktree-fixture.tsx") return virtual;
      },
      async load(id) {
        if (id === virtual)
          return transformWithEsbuild(entry, "worktree-fixture.tsx", {
            loader: "tsx",
            jsx: "automatic",
          });
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url?.split("?")[0] !== "/__worktree_fixture.html") return next();
          try {
            const html = await server.transformIndexHtml(
              "/__worktree_fixture.html",
              '<!doctype html><html lang="zh-CN" data-worktree-fixture><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html[data-worktree-fixture],html[data-worktree-fixture] body,html[data-worktree-fixture] #root{background:var(--color-background)!important;color:var(--color-foreground)}body{margin:0}</style></head><body><div id="root"></div><script type="module" src="/worktree-fixture.tsx"></script></body></html>',
            );
            res.setHeader("Content-Type", "text/html");
            res.end(html);
          } catch (error) {
            next(error);
          }
        });
      },
    },
  ],
});
let browser, page,
  passed = false;
const checks = [],
  frames = [],
  errors = [];
try {
  await vite.listen();
  browser = await chromium.launch({
    executablePath: process.env.AREAL_CHROMIUM_BIN || "/usr/bin/chromium",
    headless: true,
  });
  page = await browser.newPage({ viewport: { width: 1100, height: 850 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  const base = `http://127.0.0.1:${vite.httpServer.address().port}/__worktree_fixture.html`;
  const capture = async (name) => {
    const path = join(evidence, name + ".png");
    await page.screenshot({ path, fullPage: true, animations: "disabled" });
    await writeFile(join(evidence, name + ".aria.txt"), await page.locator("body").ariaSnapshot());
    frames.push({ name, path, sha256: createHash("sha256").update(await readFile(path)).digest("hex") });
  };
  const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "page must not overflow horizontally");
  const trigger = () => page.getByRole("button", { name: "新会话工作区", exact: true });
  const branch = () => page.getByRole("button", { name: "起始分支", exact: true });
  const environment = () => page.getByRole("button", { name: "项目环境", exact: true });
  const messagesAcceptance = async () => {
    await page.goto(base + "?messages=inherited");
    const inherited = page.locator('[data-turn-id="ancestor"]');
    const local = page.locator('[data-turn-id="local-own"]');
    await inherited.getByText("Inherited ancestor prompt", { exact: true }).waitFor();
    await local.getByText("First own local prompt", { exact: true }).waitFor();
    await capture("messages-inherited-first-own");
    assert.equal(await inherited.getByTestId("worktree-status").count(), 0, "worktree preparation must not attach to an inherited ancestor prompt");
    assert.equal(await local.getByTestId("worktree-status").count(), 1, "worktree preparation belongs to first own local prompt");
    assert.equal(await local.evaluate(element => !!(element.querySelector('.user-message').compareDocumentPosition(element.querySelector('[data-testid="worktree-status"]')) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
    await page.goto(base + "?messages=partial");
    await page.getByText("Later paginated local prompt", { exact: true }).waitFor();
    await capture("messages-partial-history");
    assert.equal(await page.getByTestId("worktree-status").count(), 0, "partial history must not identify a later visible user as the first local prompt");
    await page.goto(base + "?messages=complete");
    await page.getByText("First own local prompt", { exact: true }).waitFor();
    assert.equal(await page.locator('[data-turn-id="local-own"]').getByTestId("worktree-status").count(), 1);
    await capture("messages-complete-first-own");
    checks.push("production Messages anchors preparation after the first own local user and never under inherited or partially loaded later prompts");
  };
  await page.goto(base + "?unrelated-pending");
  await page.getByTestId("chat-input").waitFor();
  await page.getByTestId("chat-input").locator('[data-mention-category="sessions"]').waitFor();
  await capture("draft-with-unrelated-pending");
  assert.equal(await page.getByTestId("chat-input").getAttribute("contenteditable"), "true", "unrelated project submission must not lock a restored draft");
  await page.getByTestId("chat-input").press("End");
  await page.keyboard.type(" 编辑草稿");
  assert.match(await page.getByTestId("chat-input").textContent(), /编辑草稿$/);
  assert.deepEqual(await page.evaluate(() => window.fixtureCalls.filter(call => ["create", "send"].includes(call.name))), [], "editing never replays the original request");
  const originalPending = await page.evaluate(() => structuredClone(window.fixturePending));
  assert.equal(await page.getByTestId("chat-send-button").isEnabled(), true, "an unrelated valid creation must allow a fresh draft send with a model");
  await page.getByTestId("chat-send-button").click();
  await page.waitForFunction(() => window.fixtureCalls.some(call => call.name === "send"));
  const submitted = await page.evaluate(() => window.fixtureCalls.filter(call => ["create", "send"].includes(call.name)));
  assert.equal(submitted.filter(call => call.name === "create").length, 1);
  assert.equal(submitted.filter(call => call.name === "send").length, 1);
  assert.notEqual(submitted.find(call => call.name === "create").params.requestId, originalPending[0].params.requestId);
  assert.deepEqual(await page.evaluate(() => window.fixturePending), originalPending, "new send retains original unconfirmed creation");
  await page.goto(base + "?unrelated-pending=invalid");
  await page.getByTestId("chat-input").waitFor();
  assert.equal(await page.getByTestId("chat-send-button").isEnabled(), false, "unrecognized original request remains blocking");
  await page.goto(base + "?unrelated-pending=own");
  await page.getByTestId("chat-input").waitFor();
  assert.equal(await page.getByTestId("chat-input").getAttribute("contenteditable"), "false", "the draft's own UNKNOWN remains locked with a connected model");
  assert.equal(await page.getByTestId("chat-send-button").isEnabled(), false);
  assert.deepEqual(await page.evaluate(() => window.fixtureCalls.filter(call => ["create", "send"].includes(call.name))), []);
  checks.push("a fresh modeled draft creates and sends once despite unrelated valid creation, retains original pending, and blocks malformed or own identity");
  await messagesAcceptance();
  if (process.env.AREAL_WORKTREE_UI_MESSAGES_ONLY === "1") {
    assert.deepEqual(errors, []); passed = true;
  } else {
  await page.goto(base);
  await trigger().waitFor();
  await capture("picker-closed");
  await trigger().click();
  await branch().waitFor();
  await environment().waitFor();
  assert.equal(await environment().isDisabled(), true, "environment is disabled while worktree is off");
  await capture("picker-off");
  await page.getByRole("switch", { name: "在新 Worktree 中工作", exact: true }).click();
  await capture("picker-on");
  const anchor = await page.getByRole("dialog").boundingBox();
  await branch().click();
  assert.equal(await page.getByRole("dialog").count(), 1, "subpage replaces the anchored popover");
  const subpage = await page.getByRole("dialog").boundingBox();
  assert.ok(Math.abs(anchor.x + anchor.width - subpage.x - subpage.width) < 2, "submenu keeps the same anchor edge");
  await capture("picker-branches");
  assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1), true, "picker composition preserves the overlay viewport without adding page scroll");
  await page.getByRole("searchbox", { name: "搜索分支", exact: true }).fill("no-branch-matches");
  await page.getByText("没有匹配的分支", { exact: true }).waitFor();
  await capture("picker-branch-search-empty");
  await page.getByRole("searchbox", { name: "搜索分支", exact: true }).fill("release");
  await page.getByRole("option", { name: "release", exact: true }).click();
  await branch().waitFor();
  await capture("picker-branch-selected");
  await branch().click();
  assert.equal(await page.getByRole("option", { name: "release", exact: true }).getAttribute("aria-selected"), "true");
  await page.keyboard.press("Escape");
  await branch().waitFor();
  await environment().click();
  await capture("picker-environments");
  await page.getByRole("option", { name: "Development", exact: true }).click();
  await environment().waitFor();
  await capture("picker-configured");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(await trigger().evaluate(element => element === document.activeElement), true, "closing returns focus to gear");
  const selection = await page.evaluate(() => window.fixtureSelection);
  assert.equal(selection.ref, "release");
  assert.equal(selection.mode, "worktree");
  assert.equal(selection.environmentId, "dev");
  assert.equal(selection.environmentRevision, 1);
  assert.equal((await page.evaluate(() => window.fixtureCalls)).some(call => ["create", "send"].includes(call.name) || ["worktreeCreate", "worktreeOpen"].includes(call.params.operation)), false);
  checks.push("production picker preserves three rows, replaces anchored subpages, searches and selects, restores focus, and never creates or sends during configuration");
  for (const state of ["creating", "created", "binding", "settingUp", "cancelling", "cancelled", "ready", "failed", "unknown"]) {
    await page.evaluate(state => window.updateEvents([{ id: state, state, message: state === "failed" ? "Fixture creation failed" : undefined, setup: { output: "Fixture setup output\n" + "long-command-output ".repeat(60) } }], { state, directory: "/fixture/new-trees/task-proof", branch: "areal/gui-proof", automatic: true }), state);
    const status = page.locator(`[data-worktree-state="${state}"]`);
    await status.waitFor();
    if (state === "creating") {
      assert.equal(await page.getByLabel("操作输出", { exact: true }).isVisible(), false, "logs start collapsed");
      await capture("state-creating");
      await page.getByRole("button", { name: "查看创建详情", exact: true }).click();
      await page.getByLabel("操作输出", { exact: true }).waitFor();
      await capture("state-creating-log-details");
      await page.evaluate(() => window.updateEvents([{ id: "creating", state: "creating", setup: { output: "Fixture setup output\nAppended output remains expanded" } }], { state: "creating" }));
      await page.getByText("Appended output remains expanded", { exact: false }).waitFor();
      assert.equal(await page.getByRole("button", { name: "收起创建详情", exact: true }).getAttribute("aria-expanded"), "true");
      await page.getByRole("button", { name: "收起创建详情", exact: true }).click();
    }
    if (state === "ready") {
      await page.getByText("Worktree 已创建", { exact: true }).waitFor();
      assert.equal(await page.getByText("/fixture/new-trees/task-proof", { exact: true }).isVisible(), false);
    }
    if (state === "failed") await page.getByText("Fixture creation failed", { exact: true }).waitFor();
    if (state !== "creating") await capture("state-" + state);
  }
  checks.push("production status keeps logs collapsed, preserves manual expansion across incremental output, distinguishes all preparation and terminal facts, and converges ready to a light summary");
  await page.evaluate(() => { window.fixtureFail = true; });
  await trigger().click();
  await page.getByRole("alert").getByText("Fixture directory unavailable").waitFor();
  await capture("picker-read-failed");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.evaluate(() => { window.fixtureFail = false; });
  checks.push("source-query failure remains distinct from an empty collection and Escape returns accessibly");
  await page.goto(base + "?sidebar=1");
  const badge = page.getByTestId("task-worktree-badge").first();
  await badge.waitFor();
  assert.match(await badge.getAttribute("aria-label"), /Worktree.*areal\/a-very-long-branch-name/);
  assert.equal((await badge.innerText()).trim(), "", "sidebar identity is an icon instead of a persistent branch text line");
  await capture("sidebar-identity");
  checks.push("production sidebar keeps the title primary with an accessible compact worktree identity alongside running and unread states");
  await page.goto(base + "?settings=1");
  const settings = page.getByTestId("worktrees-settings");
  await settings.locator('input[aria-label="Worktree 根目录"]').waitFor();
  await settings.getByRole("button", { name: /^删除 / }).first().waitFor();
  await capture("settings-general");
  await settings.getByRole("button", { name: /^查看详情 / }).first().click();
  await capture("settings-directory-details");
  const deleteButton = settings.getByRole("button", { name: /^删除 / }).first();
  page.once("dialog", dialog => dialog.accept());
  await deleteButton.click();
  await settings.getByText("Fixture blocker: uncommitted changes remain in this directory", { exact: true }).waitFor();
  await deleteButton.waitFor();
  await capture("settings-delete-blocked");
  assert.equal(await settings.getByRole("button", { name: /^删除 / }).count(), 2);
  await settings.getByRole("tab", { name: "环境", exact: true }).click();
  await settings.getByRole("button", { name: "配置环境 AReaL Harness long project title with production components", exact: true }).waitFor();
  await capture("settings-environment-projects");
  await settings.getByRole("button", { name: "配置环境 AReaL Harness long project title with production components", exact: true }).click();
  await settings.getByRole("button", { name: "编辑环境 Development", exact: true }).waitFor();
  await capture("settings-environment-list");
  await settings.getByRole("button", { name: "编辑环境 Development", exact: true }).click();
  await settings.getByRole("textbox", { name: "环境名称", exact: true }).waitFor();
  await capture("settings-editor-actions-empty");
  await settings.getByRole("button", { name: "添加操作", exact: true }).scrollIntoViewIfNeeded();
  await capture("settings-actions-empty");
  const setupTabs = settings.getByRole("tablist", { name: "设置脚本平台", exact: true });
  const cleanupTabs = settings.getByRole("tablist", { name: "清理脚本平台", exact: true });
  await setupTabs.getByRole("tab", { name: "macOS", exact: true }).click();
  await settings.getByRole("tabpanel", { name: "macOS", exact: true }).getByRole("textbox", { name: "设置脚本", exact: true }).fill("echo unsaved mac setup");
  await cleanupTabs.getByRole("tab", { name: "Linux", exact: true }).click();
  await settings.getByRole("tabpanel", { name: "Linux", exact: true }).getByRole("textbox", { name: "清理脚本", exact: true }).fill("echo unsaved linux cleanup");
  assert.equal(await setupTabs.getByRole("tab", { name: "macOS", exact: true }).getAttribute("aria-selected"), "true");
  assert.equal(await settings.getByRole("textbox", { name: "设置脚本", exact: true }).inputValue(), "echo unsaved mac setup");
  await settings.getByRole("button", { name: "变量", exact: true }).click();
  await page.getByText("AREAL_WORKTREE_PATH", { exact: true }).waitFor();
  await capture("settings-editor-variables");
  await page.keyboard.press("Escape");
  await capture("settings-platform-independent");
  await settings.getByRole("navigation", { name: "环境导航", exact: true }).getByRole("button", { name: "环境", exact: true }).click();
  const dirtyDialog = page.getByRole("dialog");
  await dirtyDialog.getByRole("button", { name: "继续编辑", exact: true }).waitFor();
  await capture("settings-navigation-dirty");
  await dirtyDialog.getByRole("button", { name: "继续编辑", exact: true }).click();
  assert.equal(await settings.getByRole("textbox", { name: "设置脚本", exact: true }).inputValue(), "echo unsaved mac setup");
  await settings.getByRole("button", { name: "保存", exact: true }).click();
  await settings.getByRole("button", { name: "编辑环境 Quality", exact: true }).waitFor();
  const saved = await page.evaluate(() => window.fixtureCalls.findLast(call => call.params.operation === "worktreeEnvironmentSave"));
  assert.equal(saved.params.environment.setup.macos, "echo unsaved mac setup");
  assert.equal(saved.params.environment.cleanup.linux, "echo unsaved linux cleanup");
  assert.equal(saved.params.environment.setup.default, "echo default setup");
  await settings.getByRole("button", { name: "编辑环境 Quality", exact: true }).click();
  await settings.getByRole("button", { name: "编辑操作 Build", exact: true }).scrollIntoViewIfNeeded();
  await capture("settings-actions-full");
  await settings.getByRole("tablist", { name: "设置脚本平台", exact: true }).getByRole("tab", { name: "macOS", exact: true }).click();
  await settings.getByRole("tabpanel", { name: "macOS", exact: true }).getByRole("textbox", { name: "设置脚本", exact: true }).fill("echo quality mac setup");
  await settings.getByRole("tablist", { name: "清理脚本平台", exact: true }).getByRole("tab", { name: "Linux", exact: true }).click();
  await settings.getByRole("tabpanel", { name: "Linux", exact: true }).getByRole("textbox", { name: "清理脚本", exact: true }).fill("echo quality linux cleanup");
  await settings.getByRole("button", { name: "编辑操作 Build", exact: true }).click();
  await settings.getByRole("tabpanel", { name: "默认", exact: true }).getByRole("textbox", { name: "操作脚本 Build", exact: true }).fill("echo unsaved action default");
  assert.equal(await settings.getByRole("tablist", { name: "设置脚本平台", exact: true }).getByRole("tab", { name: "macOS", exact: true }).getAttribute("aria-selected"), "true");
  assert.equal(await settings.getByRole("tablist", { name: "清理脚本平台", exact: true }).getByRole("tab", { name: "Linux", exact: true }).getAttribute("aria-selected"), "true");
  assert.equal(await settings.getByRole("textbox", { name: "设置脚本", exact: true }).inputValue(), "echo quality mac setup");
  assert.equal(await settings.getByRole("textbox", { name: "清理脚本", exact: true }).inputValue(), "echo quality linux cleanup");
  await capture("settings-action-editor");
  assert.equal((await page.evaluate(() => window.fixtureCalls)).some(call => call.params.operation === "worktreeAction" || ["send", "create"].includes(call.name)), false, "settings only configures scripts");
  checks.push("production settings separates project/list/editor pages, preserves rejected-delete identity, protects dirty navigation, keeps script platform choices independent, and saves configuration without execution");
  await settings.getByRole("navigation", { name: "环境导航", exact: true }).getByRole("button", { name: "AReaL Harness long project title with production components", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "放弃修改并继续", exact: true }).click();
  await settings.getByRole("button", { name: "编辑环境 Quality", exact: true }).click();
  for (const variant of [{ name: "light-14-wide", dark: false, size: 14, width: 1100, reducedMotion: false }, { name: "dark-18-wide", dark: true, size: 18, width: 1100, reducedMotion: true }, { name: "light-18-narrow", dark: false, size: 18, width: 390, reducedMotion: true }, { name: "dark-14-narrow", dark: true, size: 14, width: 390, reducedMotion: false }]) {
    await page.setViewportSize({ width: variant.width, height: 844 });
    await page.evaluate(variant => window.setFixtureAppearance(variant), variant);
    await noOverflow();
    assert.ok(await page.locator(".settings-workspace").evaluate(element => element.scrollWidth <= element.clientWidth + 1), "settings scroll owner must not overflow horizontally");
    await capture("settings-" + variant.name);
    await settings.getByRole("button", { name: "保存", exact: true }).scrollIntoViewIfNeeded();
    await capture("settings-" + variant.name + "-footer");
    await page.goto(base);
    await trigger().waitFor();
    await page.evaluate(variant => window.setFixtureAppearance(variant), variant);
    await trigger().click();
    await branch().waitFor();
    await noOverflow();
    const box = await page.getByRole("dialog").boundingBox();
    assert.ok(box.x >= -1 && box.x + box.width <= variant.width + 1, "picker stays within viewport");
    assert.equal(await page.evaluate(() => document.documentElement.dataset.reducedMotion), String(variant.reducedMotion));
    await capture("picker-" + variant.name);
    await page.keyboard.press("Escape");
    await page.goto(base + "?settings=1");
    await settings.getByRole("tab", { name: "环境", exact: true }).click();
    await settings.getByRole("button", { name: "配置环境 AReaL Harness long project title with production components", exact: true }).click();
    await settings.getByRole("button", { name: "编辑环境 Quality", exact: true }).click();
  }
  checks.push("light/dark, 14/18 UI font, wide/narrow and reduced-motion representative combinations retain readable controls and no horizontal page overflow");
  await page.goto(base + "?actions=empty");
  await page.getByRole("button", { name: "Worktree 分支 areal/gui-proof", exact: true }).click();
  await page.getByText("/fixture/new-trees/task-proof", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Build", exact: true }).count(), 0);
  await capture("workspace-actions-empty");
  await page.goto(base + "?actions=full");
  await page.getByRole("button", { name: "Worktree 分支 areal/gui-proof", exact: true }).click();
  await page.getByRole("button", { name: "Build", exact: true }).waitFor();
  await capture("workspace-actions-full");
  for (const result of ["succeeded", "failed", "unknown"]) {
    await page.evaluate(result => { window.fixtureActionState = result; }, result);
    await page.getByRole("button", { name: "Build", exact: true }).click();
    await page.getByRole("status").getByText("正在运行操作…", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Build", exact: true }).isDisabled(), true);
    await capture("workspace-action-running-" + result);
    await page.evaluate(() => window.resolveFixtureAction());
    await page.getByLabel("操作输出", { exact: true }).waitFor();
    if (result !== "succeeded") {
      const notice = page.getByTestId("toast");
      await notice.getByRole(result === "unknown" ? "status" : "alert").waitFor();
      assert.equal(await notice.getAttribute("data-tone"), result === "unknown" ? "warning" : "error");
    }
    await capture("workspace-action-" + result);
  }
  checks.push("production workspace details expose only saved actions and distinguish running, succeeded, failed and unknown service results without duplicate submission");
  await page.goto(base + "?recovery=accepted");
  await page.waitForFunction(() => window.fixtureCalls.some(call => call.name === 'opened'));
  assert.equal(await page.evaluate(() => localStorage.getItem('fixture-draft:pending-create')), null);
  assert.equal(await page.evaluate(() => window.fixtureCalls.filter(call => call.name === 'opened').length), 1);
  assert.equal(await page.evaluate(() => window.fixtureCalls.some(call => ['create','send'].includes(call.name))), false);
  checks.push('a known creation receipt converges despite an unrelated pending project request, without create/send replay');
  await page.goto(base + "?toast=1");
  await page.getByTestId('toast').waitFor();
  assert.equal(await page.locator('[data-recovery-request-id="same-request"]').count(), 1);
  assert.equal(await page.getByTestId('feedback-notice').count(), 0);
  await page.getByRole('button', { name: '核对通知', exact: true }).click();
  assert.equal(await page.evaluate(() => window.fixtureCalls.filter(call => call.name === 'check').length), 1);
  await page.getByRole('button', { name: '更新快照', exact: true }).click();
  await page.mouse.move(0, 0);
  await page.getByTestId('toast').waitFor({ state: 'hidden', timeout: 8000 });
  await page.getByRole('button', { name: '更新快照', exact: true }).click();
  assert.equal(await page.getByTestId('toast').count(), 0, 'same receipt is not announced again on snapshot updates');
  await page.getByRole('button', { name: '更新快照', exact: true }).click();
  await page.locator('[data-testid="toast"][data-tone="error"]').waitFor();
  checks.push('same-request notices deduplicate into one actionable toast, expire and do not reappear on unrelated snapshots');
  await page.goto(base + "?recovery=1");
  await page.getByRole("button", { name: "检查操作状态", exact: true }).click();
  await page.getByRole("button", { name: "操作待确认", exact: true }).click();
  const recover = page.getByRole("menuitem", { name: "保留原结果，返回草稿", exact: true });
  await recover.waitFor();
  page.once("dialog", dialog => dialog.dismiss());
  await recover.click();
  assert.notEqual(await page.evaluate(() => localStorage.getItem("fixture-draft:pending-create")), null);
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "操作待确认", exact: true }).click();
  await recover.click();
  assert.equal(await page.evaluate(() => localStorage.getItem("fixture-draft:pending-create")), null);
  assert.equal(await page.evaluate(() => localStorage.getItem("fixture-draft")), "retain this input");
  assert.ok(await page.evaluate(() => localStorage.getItem("fixture-draft:retained-create:00000000-0000-4000-a000-000000000001")));
  const recoveryCalls = await page.evaluate(() => window.fixtureCalls);
  assert.equal(recoveryCalls.filter(call => call.name === "create").length, 0);
  assert.deepEqual(recoveryCalls.find(call => call.params.operation === "worktreeRead").params, { projectId: "logical", operation: "worktreeRead", requestId: "00000000-0000-4000-a000-000000000001" });
  assert.equal(recoveryCalls.some(call => call.name === "send"), false);
  await capture("unknown-explicit-recovery-draft-preserved");
  checks.push("production DraftComposer inspects original UUID before explicit recovery, retains draft and archived request, and never replays create or sends uncertain input");
  assert.deepEqual(errors, []);
  passed = true;
  }
} catch (cause) {
  errors.push(cause.stack || String(cause));
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(evidence, "failure.png"), fullPage: true }).catch(() => {});
    await writeFile(join(evidence, "failure.aria.txt"), await page.locator("body").ariaSnapshot().catch(() => "snapshot unavailable"));
  }
  throw cause;
} finally {
  await browser?.close();
  await vite.close();
  const manifest = {
    passed,
    checks,
    errors,
    frames,
    platform: process.platform,
    browser: browser?.version(),
    fixtureBoundary: "workspace action responses, event/current projection props, initial localStorage recovery record",
    sourceHashes: Object.fromEntries(await Promise.all([
      "renderer/src/WorktreeStarter.tsx", "renderer/src/WorktreeStatus.tsx", "renderer/src/Worktree.css",
      "renderer/src/TaskListItem.tsx", "renderer/src/DraftComposer.tsx", "renderer/src/Messages.tsx",
      "renderer/src/settings/WorktreesSettings.tsx", "renderer/src/settings/WorktreesSettings.css",
      "scripts/worktree-ui-smoke.mjs",
    ].map(async path => [path, createHash("sha256").update(await readFile(join(gui, path))).digest("hex")]))),
    sourceDiff: execFileSync("git", ["diff", "--stat"], { cwd: resolve(gui, "../.."), encoding: "utf8" }).trim(),
    scope:
      "headless Chromium production React components with deterministic desktop action fixture",
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: resolve(gui, "../.."),
      encoding: "utf8",
    }).trim(),
    unverified: [
      "full App and Electron native integration",
      "macOS Electron",
      "Codex pixel comparison",
      "live create/send/cancellation handoff and Messages prompt ordering require separate real Electron/Core acceptance",
    ],
  };
  await writeFile(join(evidence, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ passed, evidence, checks, errors }, null, 2));
}
