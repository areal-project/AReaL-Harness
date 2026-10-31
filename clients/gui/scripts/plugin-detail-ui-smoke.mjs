// Production renderer acceptance. Management is a deterministic external fixture;
// real install/receipt behavior is covered by plugin-p0-smoke.mjs.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
const gui = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const rendererRequire = createRequire(join(gui, "renderer/package.json"));
const { chromium } = require("playwright-core");
const { createServer } = await import(pathToFileURL(rendererRequire.resolve("vite")).href);
const evidence = resolve(
  process.env.AREAL_PLUGIN_DETAIL_EVIDENCE ??
    join(root, ".scratch/plugin-detail-implementation/ui-" + Date.now()),
);
await mkdir(evidence, { recursive: true });
const fixture = join(evidence, "fixture.tsx");
await writeFile(
  fixture,
  `import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {PluginCenter} from '${join(gui, "renderer/src/settings/PluginCenter.tsx")}';
import {ToastHost} from '${join(gui, "renderer/src/ToastHost.tsx")}';
import {ApplicationIntlProvider} from '${join(gui, "renderer/src/i18n/IntlProvider.tsx")}';
import {UnsavedChangesProvider} from '${join(gui, "renderer/src/settings/UnsavedChanges.tsx")}';
import {setApplicationPreferences} from '${join(gui, "renderer/src/settings/applicationPreferences.ts")}';
import '${join(gui, "renderer/src/styles.css")}';
let mode='uninstalled',digest='a'.repeat(64),installed=false,auth='notStarted',state='disconnected',revision=1,lose=false,disabledSkills=[],disabledMcpServers=[],configRevision=1,tokenConfigured=false,titleValue='';
const skill={id:'github@official/review',revision:'skill-r1',name:'Review changes',description:'Review a proposed change.',onboarding:false,allowImplicitInvocation:true};
const skillsOnly=()=>['skills-only','project-unknown','project-config-unknown'].includes(mode);
const calls=[]; let receipt;
const installedMetadata=()=>({name:'github',displayName:'GitHub',description:'Installed GitHub description.',version:'1.0.0',interface:{developerName:'Fixture developer',longDescription:'Read issues and review proposed changes.',defaultPrompt:['Review the current changes.'],category:'Development',websiteUrl:'https://example.com/plugin',privacyPolicyUrl:'https://example.com/privacy'},components:skillsOnly()?['skills']:['mcp']});
const support=()=>({digest,manifestFormat:'portable1',compatibility:{state:'allowed',reasonCodes:[]},validation:{provider:'unverified',platform:'unverified',distribution:'unverified'},components:[{kind:'mcp',sourceField:'mcp.json',status:'supported',reasonCodes:[],supportedSchema:'areal-mcp-document-envelope-v1',activationRequirements:['explicitMcpTrust','mcpConnection']},{kind:'uiSurfaces',sourceField:'plugin.json#/ui/surfaces/panel',status:'unsupported',reasonCodes:['componentNotImplemented'],supportedSchema:null,activationRequirements:[]}]});
const detail=()=>({userConfiguration:{revision:configRevision,missingRequired:mode==='config'&&!tokenConfigured?['TOKEN']:[],fields:mode==='config'?{TITLE:{definition:{type:'string',title:'Title',description:'Public title',required:false,sensitive:false,default:null},configured:!!titleValue,value:titleValue||null},TOKEN:{definition:{type:'string',title:'Token',description:'Private credential',required:true,sensitive:true,default:null},configured:tokenConfigured,value:null}}:{}},developmentLink:null,sourceKind:'local',installedMetadata:installed?installedMetadata():null,componentChoices:{disabledSkills,disabledMcpServers},interface:mode==='catalog-changed'?{developerName:'Candidate developer',longDescription:'Candidate-only description.'}:installedMetadata().interface,revision,id:'github@official',name:'github',displayName:mode==='catalog-changed'?'GitHub Next':'GitHub',description:mode==='catalog-changed'?'Candidate-only description.':'在对话中使用 GitHub。',version:mode==='catalog-changed'?'2.0.0':null,installed,installedVersion:installed?'1.0.0':null,installedDigest:installed?digest:null,installedSkills:installed&&skillsOnly()?[skill]:[],installedOnboardingSkill:null,enabled:installed,source:'/fixture/github',sourceDigest:mode==='catalog-changed'?'c'.repeat(64):digest,catalogSource:{type:'local',path:'/fixture/github'},componentSupport:skillsOnly()?{...support(),components:[]}:support(),installedComponentSupport:installed?(skillsOnly()?{...support(),components:[]}:support()):null,components:skillsOnly()?['skills']:['mcp'],diagnostics:['MCP declarations require explicit digest trust and connection'],skills:skillsOnly()?[skill]:[],onboardingSkill:null});
const connection=()=>({pluginId:'github@official',installedDigest:digest,state:state==='connected'?'connected':auth==='ready'?'disconnected':'authRequired',trusted:state==='connected',authenticationTiming:'ON_INSTALL',servers:skillsOnly()?[]:[{serverId:'github-mcp',projectEnabled:!disabledMcpServers.includes('github-mcp'),enabled:!disabledMcpServers.includes('github-mcp'),state:disabledMcpServers.includes('github-mcp')?'disabled':state==='connected'?'connected':auth==='ready'?'disconnected':'authRequired',authentication:'required',config:{title:'GitHub MCP',authentication:{},authenticationRequirements:{}}}],connectors:[],diagnostics:[]});
const action=async(_name,p)=>{calls.push({name:_name,...p});if(_name==='reconcile')return {outcomes:{}};if(_name==='connect'){mode='uninstalled';window.pluginFixture.connected();return {};}switch(p.operation){
case'pluginStoreSnapshot':{const list={revision,data:[detail(),{...detail(),id:'other@official',name:'other',displayName:'Other Plugin',installedMetadata:{...installedMetadata(),displayName:'Other Plugin'}}],marketplaces:[{name:'official',root:'/fixture',sourceUrl:'https://github.com/openai/plugins'}],errors:[]};return {revision,scope:p.projectId?{kind:'project',workspace:'/fixture'}:{kind:'user'},observedAt:Date.now(),runtimeObserved:false,list,detail:p.id?list.data.find(item=>item.id===p.id)||null:null};}
case'pluginStoreDoctor':return {revision,scope:{kind:'user'},observedAt:Date.now(),runtimeObserved:false,data:[],errors:[]};
case'pluginComponents':return {pluginId:p.id,installedDigest:digest,commands:mode==='templates'?[{componentId:'commands/review.md',name:'github:review',description:'Review a file',argumentHint:'file',installedDigest:digest}]:[],agents:mode==='templates'?[{componentId:'agents/reviewer.md',name:'github:reviewer',description:'Review profile',profile:{id:'plugin-profile',revision:'profile-v1'}}]:[],agentDiagnostics:[],developmentError:null,mcpServers:[],apps:[],appsNeedingAuth:[]};
case'pluginUserConfigSave':if(p.values.TITLE)titleValue=p.values.TITLE.value;if(p.secrets.TOKEN)tokenConfigured=true;if(p.clearKeys?.includes('TOKEN'))tokenConfigured=false;configRevision++;revision++;return {revision,data:[detail()],marketplaces:[],errors:[]};
case'pluginCredentialsReload':return {reloaded:true};
case'pluginDevelopmentLink':case'pluginDevelopmentUnlink':return {revision,data:[detail()],marketplaces:[],errors:[]};
case'pluginReadiness':if(!installed||p.expectedDigest!==digest||!['github@official','other@official'].includes(p.id))throw Error('STALE_READINESS_SNAPSHOT');return {pluginId:p.id,installedDigest:digest,requiredTools:[],missingTools:[],available:true};
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
case'pluginConnection':state=p.connect&&mode!=='failed'?'connected':'disconnected';if(!p.connect)auth='ready';receipt=mode==='failed'?{confirmed:true,accepted:true,status:'failed',operation:{requestId:p.requestId,method:'areal/plugin/connection',target:{kind:'project'}},error:{message:'PLUGIN_EXECUTION_FAILED_SENTINEL'},message:'PLUGIN_EXECUTION_FAILED_SENTINEL'}:{confirmed:true,accepted:true,status:'completed',result:{}};if(mode==='unresolved')receipt={confirmed:false};if(lose){lose=false;throw Object.assign(new Error('连接回执丢失'),{submissionUnknown:true,requestId:p.requestId});}return {data:[connection()]};
case'pluginSubmission':return receipt;default:throw Error('Unexpected fixture operation '+p.operation);}};
function assertComponent(p){if(p.expectedRevision!==revision||p.expectedDigest!==digest)throw Error('STALE_COMPONENT_GUARD');}
function App(){const [epoch,setEpoch]=useState(0),[,setConnectionEpoch]=useState(0),[surface,setSurface]=useState('workspace');window.pluginFixture={calls,get digest(){return digest;},connected(){setConnectionEpoch(value=>value+1);},reset(next){mode=next;disabledSkills=[];disabledMcpServers=[];setSurface('workspace');installed=!['uninstalled','disconnected-uninstalled','offline-uninstalled'].includes(next);auth=next==='pending'?'pending':next==='ready'||next==='connected'||next==='unknown'||next==='failed'||next==='unresolved'?'ready':'notStarted';state=next==='connected'?'connected':'disconnected';lose=next==='unknown'||next==='failed'||next==='unresolved';tokenConfigured=false;titleValue='';configRevision++;revision++;setEpoch(x=>x+1);},swapDigest(){digest='b'.repeat(64);revision++;window.dispatchEvent(new Event('areal-plugins-changed'));},setReady(){auth='ready';mode='ready';},changeCatalog(){mode='catalog-changed';revision++;window.dispatchEvent(new Event('areal-plugins-changed'));},language(locale){setApplicationPreferences({locale});},};
const project={id:'fixture',name:'workspace',root:'/fixture',state:{connected:!mode.startsWith('disconnected')},profiles:[{id:'standard',revision:1}],pending:mode==='project-unknown'?[{method:'areal/thread/start',params:{requestId:'00000000-0000-4000-a000-000000000111'},awaitingResponse:false}]:mode==='project-config-unknown'?[{method:'areal/mcp/configure',params:{requestId:'00000000-0000-4000-a000-000000000222'},awaitingResponse:false}]:[]};window.pluginFixture.pending=project.pending;return <UnsavedChangesProvider><div style={{height:'100vh',display:'flex',background:'var(--color-background)'}}><PluginCenter key={epoch} project={mode.startsWith('offline')?undefined:project} projects={mode.startsWith('offline')?[]:[project]} action={action} active surface={surface} marketRequest={0} onSettings={()=>setSurface("settings")} onMarket={()=>setSurface("workspace")} onChooseProject={()=>{calls.push({name:'chooseProject'});}} onSelectProject={()=>{}} onRunCommand={async(command)=>{calls.push({name:'send',command});}} onStartDraft={async(seed)=>{calls.push({operation:'startDraft',seed});}} /></div></UnsavedChangesProvider>;}
createRoot(document.getElementById('root')).render(<ApplicationIntlProvider><ToastHost/><App/></ApplicationIntlProvider>);`,
);
const workbench = JSON.parse(await readFile(join(gui, "packages/workbench/package.json"), "utf8"));
const server = await createServer({
  root: join(gui, "renderer"),
  configFile: join(gui, "renderer/vite.config.ts"),
  mode: "design-system",
  appType: "custom",
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      react: dirname(rendererRequire.resolve("react/package.json")),
      "react-dom": dirname(rendererRequire.resolve("react-dom/package.json")),
    },
  },
  optimizeDeps: {
    entries: [fixture],
    include: Object.entries(workbench.exports)
      .filter(([, entry]) => entry.default?.endsWith(".cjs"))
      .map(([name]) => `@areal/workbench${name.slice(1)}`),
  },
  server: { host: "127.0.0.1", port: 0, fs: { allow: [root] } },
});
server.middlewares.use(async (req, res, next) => {
  if (req.url !== "/plugin-detail-acceptance.html") return next();
  res.setHeader("Content-Type", "text/html");
  res.end(
    await server.transformIndexHtml(
      req.url,
      `<html><body><div id="root"></div><script type="module" src="/@fs${fixture}"></script></body></html>`,
    ),
  );
});
await server.listen();
const origin = server.resolvedUrls.local[0];
let browser,
  page,
  passed = false,
  failure;
const errors = [],
  checks = [];
const button = (name) => page.getByRole("button", { name, exact: true });
async function open(mode) {
  await page.evaluate((mode) => window.pluginFixture.reset(mode), mode);
  await page.getByRole("tablist", { name: "市场范围", exact: true }).waitFor();
  await button("查看插件 github@official").click();
  await page.getByTestId("plugin-detail-page").waitFor();
}
async function waitChecked(name, value) {
  await page.waitForFunction(
    ({ name, value }) =>
      [...document.querySelectorAll("[role=switch]")].some(
        (el) =>
          el.getAttribute("aria-label") === name &&
          el.getAttribute("aria-checked") === String(value),
      ),
    { name, value },
  );
}
async function capture(name) {
  await page.screenshot({ path: join(evidence, name + ".png"), animations: "disabled" });
  await writeFile(join(evidence, name + ".aria.txt"), await page.locator("body").ariaSnapshot());
}
async function checkProjectRecovery() {
  await open("project-unknown");
  const skillSwitch = page.getByRole("switch", {
    name: "在当前项目启用 Skill Review changes",
    exact: true,
  });
  assert.equal(
    await skillSwitch.isEnabled(),
    true,
    "unrelated creation must retain normal Skills management",
  );
  const originalPending = await page.evaluate(() => structuredClone(window.pluginFixture.pending));
  const beforeConfiguration = await page.evaluate(() => window.pluginFixture.calls.length);
  await skillSwitch.click();
  await waitChecked("在当前项目启用 Skill Review changes", false);
  const configured = await page.evaluate(
    (offset) =>
      window.pluginFixture.calls
        .slice(offset)
        .filter((call) => call.operation === "pluginComponentConfigure"),
    beforeConfiguration,
  );
  assert.equal(configured.length, 1);
  assert.equal(configured[0].enabled, false);
  assert.notEqual(configured[0].requestId, originalPending[0].params.requestId);
  assert.deepEqual(await page.evaluate(() => window.pluginFixture.pending), originalPending);
  assert.equal(await page.getByText(/areal\/thread\/start/).count(), 0);
  await capture("13-independent-creation-preserved");
  checks.push(
    "unrelated creation preserves its original record and does not block Skills management; centralized creation recovery stays outside the plugin page",
  );
  await open("project-config-unknown");
  const originalOperation = await page.evaluate(() =>
    structuredClone(window.pluginFixture.pending),
  );
  assert.equal(await skillSwitch.isEnabled(), false);
  await page.getByText(/areal\/mcp\/configure/).waitFor();
  await page.getByText(/00000000-0000-4000-a000-000000000222/).waitFor();
  const previousCalls = await page.evaluate(() => window.pluginFixture.calls.length);
  await button("核对项目操作").click();
  await page.waitForFunction(() =>
    window.pluginFixture.calls.some((call) => call.name === "reconcile"),
  );
  await button("核对项目操作").waitFor({ state: "visible" });
  const checkedCalls = await page.evaluate(
    (offset) => window.pluginFixture.calls.slice(offset),
    previousCalls,
  );
  assert.deepEqual(
    checkedCalls
      .filter((call) => call.name === "reconcile")
      .map((call) => ({ projectId: call.projectId, requestId: call.requestId })),
    [{ projectId: "fixture", requestId: originalOperation[0].params.requestId }],
  );
  await page.getByText("已核对，原操作仍未确认。未重新提交。", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.pluginFixture.pending), originalOperation);
  assert.equal(await skillSwitch.isEnabled(), false);
  assert.equal(
    checkedCalls.filter(
      (call) =>
        ["create", "send"].includes(call.name) ||
        ["pluginInstall", "pluginConfigure", "pluginConnection"].includes(call.operation),
    ).length,
    0,
  );
  await capture("14-project-operation-recovery");
  checks.push(
    "a project configuration UNKNOWN blocks conflicting writes; one explicit check names the original request and retains unresolved state without replay",
  );
}
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.AREAL_GUI_TEST_BROWSER
      ? { executablePath: process.env.AREAL_GUI_TEST_BROWSER }
      : { channel: "chrome" }),
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + "plugin-detail-acceptance.html");
  await page.waitForFunction(() => !!window.pluginFixture);
  if (process.env.AREAL_PLUGIN_PROJECT_RECOVERY_ONLY === "1") {
    await checkProjectRecovery();
  } else {
    for (const mode of ["offline", "disconnected"]) {
      const before = await page.evaluate(() => window.pluginFixture.calls.length);
      await open(mode);
      await page
        .getByText("尚未观察当前项目的运行状态。目录与支持信息来自本地 Store 快照。", {
          exact: true,
        })
        .first()
        .waitFor();
      const calls = await page.evaluate(
        (offset) => window.pluginFixture.calls.slice(offset),
        before,
      );
      assert(calls.some((call) => call.operation === "pluginStoreSnapshot"));
      assert.equal(
        calls.some(
          (call) =>
            ["connect", "create", "send"].includes(call.name) ||
            ["pluginMcp", "pluginHooks", "pluginReadiness", "pluginComponents"].includes(
              call.operation,
            ),
        ),
        false,
      );
      await capture("offline-" + mode);
    }
    checks.push("projectless and disconnected browsing reads Store snapshots without runtime RPCs");
    await open("offline-uninstalled");
    await button("选择项目以继续安装").click();
    assert.equal(
      await page.evaluate(() =>
        window.pluginFixture.calls.some((call) => call.name === "chooseProject"),
      ),
      true,
    );
    const coldStart = await page.evaluate(() => window.pluginFixture.calls.length);
    await open("disconnected-uninstalled");
    assert.equal(
      await page.evaluate(
        (offset) =>
          window.pluginFixture.calls
            .slice(offset)
            .some((call) => call.name === "connect" || call.operation === "pluginResolve"),
        coldStart,
      ),
      false,
    );
    await button("连接项目后台").click();
    await button("检查安装内容").waitFor();
    await page.waitForFunction(() =>
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "检查安装内容" && !button.disabled,
      ),
    );
    await button("检查安装内容").click();
    await button("安装到用户").waitFor();
    assert.equal(await button("安装到用户").isEnabled(), true);
    const continuation = await page.evaluate(
      (offset) => window.pluginFixture.calls.slice(offset),
      coldStart,
    );
    assert.equal(continuation.filter((call) => call.name === "connect").length, 1);
    assert.equal(continuation.filter((call) => call.operation === "pluginResolve").length, 1);
    await capture("offline-install-continuation");
    checks.push(
      "offline install continues through an explicit project selection or connection action before source resolution",
    );
    await open("uninstalled");
    await button("安装").click();
    const review = page.getByRole("region", { name: "来源解析与预览", exact: true });
    await review.waitFor();
    assert.equal(await review.getByRole("checkbox").count(), 0);
    await button("安装到用户").waitFor();
    assert.equal(await button("安装到用户").isEnabled(), true);
    await capture("install-review");
    await button("安装到用户").click();
    await button("卸载插件").waitFor();
    assert.equal(
      await page.evaluate(
        () =>
          window.pluginFixture.calls.filter((call) => call.operation === "pluginConnection").length,
      ),
      0,
    );
    await button("在浏览器中认证").click();
    await button("核对认证状态").waitFor();
    await capture("auth-pending");
    await page.evaluate(() => window.pluginFixture.setReady());
    await button("核对认证状态").click();
    await button("审阅并连接").waitFor();
    const beforeConnect = await page.evaluate(
      () =>
        window.pluginFixture.calls.filter((call) => call.operation === "pluginConnection").length,
    );
    await button("审阅并连接").click();
    await page.getByText("本次授权", { exact: true }).waitFor();
    assert.equal(await page.locator(".plugin-trust-review").getByRole("checkbox").count(), 0);
    assert.equal(await button("信任并连接").isEnabled(), true);
    await capture("mcp-execution-authorization");
    assert.equal(
      await page.evaluate(
        () =>
          window.pluginFixture.calls.filter((call) => call.operation === "pluginConnection").length,
      ),
      beforeConnect,
    );
    await button("信任并连接").click();
    await button("断开并撤销信任").waitFor();
    await capture("connected");
    checks.push(
      "installation needs one explicit confirmation; authentication never connects; MCP execution is authorized separately",
    );
    await button("断开并撤销信任").click();
    await button("审阅并连接").click();
    await page.evaluate(() => window.pluginFixture.swapDigest());
    await button("审阅并连接").waitFor();
    assert.equal(await button("信任并连接").count(), 0);
    checks.push("a changed installed digest invalidates the prior MCP authorization review");
    for (const mode of ["unknown", "unresolved", "failed"]) {
      await open(mode);
      await button("审阅并连接").click();
      await button("信任并连接").click();
      await page.getByRole("heading", { name: "连接结果待核对", exact: true }).waitFor();
      const before = await page.evaluate(
        () =>
          window.pluginFixture.calls.filter((call) => call.operation === "pluginConnection").length,
      );
      await button("Other Plugin").click();
      await page
        .getByTestId("plugin-detail-page")
        .getByRole("heading", { name: "Other Plugin", exact: true })
        .waitFor();
      await button("GitHub").click();
      await page.getByRole("heading", { name: "连接结果待核对", exact: true }).waitFor();
      await button("核对连接结果").click();
      if (mode === "unknown") await button("断开并撤销信任").waitFor();
      if (mode === "unresolved")
        await page.getByRole("heading", { name: "连接结果待核对", exact: true }).waitFor();
      if (mode === "failed")
        await page
          .getByText(/PLUGIN_EXECUTION_FAILED_SENTINEL/)
          .first()
          .waitFor();
      assert.equal(
        await page.evaluate(
          () =>
            window.pluginFixture.calls.filter((call) => call.operation === "pluginConnection")
              .length,
        ),
        before,
      );
      await capture("receipt-" + mode);
    }
    checks.push(
      "UNKNOWN retains its original owner across reading; completed, failed, and unresolved receipt reads do not replay writes",
    );
    await open("config");
    await page.locator("#plugin-config-TITLE").fill("Public title");
    await page.locator("#plugin-config-TOKEN").fill("TRANSIENT_FIXTURE_SECRET");
    await button("保存插件配置").click();
    await page.locator("#plugin-config-TOKEN").waitFor();
    await page.waitForFunction(() => document.querySelector("#plugin-config-TOKEN")?.value === "");
    assert.equal(await page.locator("#plugin-config-TITLE").inputValue(), "Public title");
    await button("重新载入当前项目凭据").waitFor();
    await capture("configuration-saved");
    checks.push("configuration masks saved secrets and clears transient password input after save");
    await open("templates");
    await page.getByLabel("命令参数", { exact: true }).fill("file with spaces.ts --strict");
    await button("提交到当前任务").click();
    const sent = await page.evaluate(() =>
      window.pluginFixture.calls.findLast((call) => call.name === "send"),
    );
    assert.deepEqual(sent.command, {
      pluginId: "github@official",
      componentId: "commands/review.md",
      installedDigest: await page.evaluate(() => window.pluginFixture.digest),
      arguments: "file with spaces.ts --strict",
    });
    await button("使用此配置创建草稿").click();
    const drafted = await page.evaluate(() =>
      window.pluginFixture.calls.findLast((call) => call.operation === "startDraft"),
    );
    assert.deepEqual(drafted.seed.profile, { id: "plugin-profile", revision: "profile-v1" });
    await capture("commands-and-agents");
    checks.push(
      "namespaced command submits an exact reference with raw arguments; Agent selects an imported Profile",
    );
    await checkProjectRecovery();
    await page.evaluate(() => window.pluginFixture.language("en"));
    await button("Uninstall plugin").waitFor();
    await capture("english");
    await page.setViewportSize({ width: 900, height: 850 });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    const overflow = await page
      .getByTestId("plugin-detail-page")
      .evaluate((element) => element.scrollWidth > element.clientWidth + 1);
    assert.equal(overflow, false);
    await capture("narrow-dark");
    checks.push("English and narrow dark detail remain readable without horizontal overflow");
  }
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  failure = { message: error.message, stack: error.stack };
  process.exitCode = 1;
  if (page) await capture("failure");
} finally {
  await browser?.close();
  await server.close();
  const hashes = {};
  for (const file of [
    "settings/PluginCenter.tsx",
    "settings/PluginConnectionPanel.tsx",
    "settings/PluginCenter.css",
  ])
    hashes[file] = createHash("sha256")
      .update(await readFile(join(gui, "renderer/src", file)))
      .digest("hex");
  await writeFile(
    join(evidence, "manifest.json"),
    JSON.stringify(
      {
        passed,
        failure,
        checks,
        errors,
        hashes,
        scope:
          "production renderer, deterministic management fixture; no Core/provider/native acceptance",
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed, evidence, failure, checks, errors }, null, 2));
}
