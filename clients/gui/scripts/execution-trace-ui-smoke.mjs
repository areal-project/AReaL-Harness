import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite-plus";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const evidence = join(root, ".scratch/execution-trace", `ui-${Date.now()}`);
await mkdir(evidence, { recursive: true });
const require = createRequire(join(gui, "app/package.json"));
const { chromium } = require("playwright-core");
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ModelTrajectoryPane } from '/src/ModelTrajectoryPane.tsx';
import { ApplicationIntlProvider } from '/src/i18n/IntlProvider.tsx';
import { TooltipProvider } from '/src/components/ui/tooltip.tsx';
import '/src/styles.css'; import '/src/workbench.css';
const now=Date.now();
const item=(id,text)=>({id,type:'agentMessage',text});
const tool=(id,callId,tool,args={})=>({id,type:'dynamicToolCall',callId,tool,arguments:args,status:'completed',success:true,contentItems:[{type:'text',text:'summary'}]});
const turn=(id,status,items,extra={})=>({id,status,items,...extra});
const rootTurn=turn('recent','completed',[tool('spawn','call-spawn','agent_spawn'),{...tool('raw','call-raw','exec_command'),execution:{resultSnapshot:{uri:'fixture://raw'}}}],{durationMs:42000,trace:{startedAtMs:now-50000,queueDurationMs:1200,activities:[{id:'failure',kind:'model',label:'failed attempt',status:'failed',durationMs:12000,startedAtMs:now-50000,error:'retry error'},{id:'retry',kind:'retryWait',label:'retry',status:'completed',durationMs:1000,startedAtMs:now-38000}]}});
const old=turn('old','interrupted',[item('old-message','ancient-needle')],{trace:{startedAtMs:now-86400000,activities:[{id:'stale',kind:'model',label:'stale model',status:'running',startedAtMs:now-86400000}]}});
const child=turn('child-turn','completed',[tool('nested-spawn','nested-call','agent_spawn')],{durationMs:22000});
const nested=turn('nested-turn','completed',[item('nested-message','nested evidence')],{durationMs:3000});
const worker=turn('worker-turn','completed',[item('worker-message','isolated worker evidence')],{durationMs:5000});
const rec=(turn)=>turn.items.map(item=>({sourceTurnId:turn.id,sourceItemId:item.id,turn:{...turn,items:undefined},item}));
const execution=(executionId,title,turnId,requestId)=>({executionId,title,status:'completed',settled:true,owner:{turnId},requestId});
const calls=[];
function response(threadId,turns,executions=[],sources=[]){return {threadId,title:threadId,page:{data:turns.flatMap(rec),nextCursor:null,complete:true},activeTurn:null,sources,executions:{data:executions,nextOffset:null},queue:null,readAtMs:Date.now()};}
const action=async(name,p)=>{calls.push({name,...p}); if(name==='media') return {bytes:Array.from(new TextEncoder().encode('first line\\nraw unique needle\\nlast line'))}; if(name!=='manage') return {}; if(p.executionId==='child') return response('child-thread',[child],[execution('nested','Nested agent','child-turn','nested-call')]); if(p.executionId==='nested') return response('nested-thread',[nested]); if(p.executionId==='worker') return response('worker-thread',[worker],[],[{threadId:'worker-thread',title:'Worker'}]); if(p.cursor==='older') return response('root',[old]); const value=response('root',[rootTurn],[execution('child','Child agent','recent','call-spawn'),execution('worker','Isolated worker','recent','missing-call')]); value.page.nextCursor='older'; value.page.complete=false; return value;};
window.traceFixture={calls};
createRoot(document.getElementById('root')).render(React.createElement(ApplicationIntlProvider,null,React.createElement(TooltipProvider,null,React.createElement(ModelTrajectoryPane,{thread:{id:'root',turns:[]},title:'Trace fixture',projectId:'project',action,refresh:async()=>{},onClose:()=>{}}))));
`;
const vite = await createServer({
  root: join(gui, "renderer"),
  configFile: join(gui, "renderer/vite.config.ts"),
  mode: "design-system",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "trace-fixture",
      resolveId(id) {
        if (id === "/__trace-fixture.js") return "\0trace-fixture";
      },
      load(id) {
        if (id === "\0trace-fixture") return fixture;
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url === "/__trace.html") {
            res.setHeader("Content-Type", "text/html");
            res.end(
              await server.transformIndexHtml(
                "/__trace.html",
                '<html><body style="margin:0"><div id="root"></div><script type="module" src="/__trace-fixture.js"></script></body></html>',
              ),
            );
            return;
          }
          next();
        });
      },
    },
  ],
});
let browser;
const report = {
  passed: false,
  boundary:
    "React pane in isolated headless Chrome with synthetic action responses; no Core, Electron, persistence, package, or physical input",
  revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  checks: [],
  errors: [],
};
try {
  await vite.listen();
  browser = await chromium.launch({
    executablePath:
      process.env.AREAL_CHROMIUM_BIN ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 420, height: 800 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(e.message));
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__trace.html`);
  await page.locator('[data-trajectory-turn="recent"]').waitFor();
  await page.locator('[data-trajectory-turn="old"]').waitFor();
  assert.ok(
    (await page.evaluate(() => window.traceFixture.calls)).some((c) => c.cursor === "older"),
  );
  report.checks.push("pagination");
  await page.locator('[data-execution-id="child"] button').first().click();
  await page.locator('[data-execution-id="nested"] button').first().click();
  await page.getByText("nested evidence").first().waitFor({ state: "attached" });
  await page.locator('[data-execution-id="worker"] button').first().click();
  await page.getByText("isolated worker evidence").first().waitFor({ state: "attached" });
  report.checks.push("nested and isolated worker");
  const search = page.getByRole("searchbox", { name: "搜索轨迹内容" });
  await search.fill("ancient-needle");
  await page
    .getByRole("button", { name: /old.*助手消息/ })
    .first()
    .click();
  await page.locator('[data-entry-id*="old-message"]').waitFor();
  report.checks.push("search and locate older history");
  await search.fill("");
  await page.getByRole("combobox", { name: "轨迹状态筛选" }).click();
  await page.getByRole("option", { name: "发生过异常", exact: true }).click();
  await page
    .getByRole("button", { name: /failed attempt/ })
    .first()
    .waitFor();
  await page.getByRole("combobox", { name: "轨迹状态筛选" }).click();
  await page.getByRole("option", { name: "耗时较长", exact: true }).click();
  await page.getByRole("combobox", { name: "耗时阈值" }).click();
  await page.getByRole("option", { name: "10 秒", exact: true }).click();
  await page
    .getByRole("button", { name: /failed attempt/ })
    .first()
    .waitFor();
  report.checks.push("exception and threshold filters");
  await page.getByRole("combobox", { name: "轨迹状态筛选" }).click();
  await page.getByRole("option", { name: "全部", exact: true }).click();
  const raw = page.locator('[data-entry-id$="raw:result"]');
  await raw.getByRole("button").first().click();
  await raw.getByRole("button", { name: "查看原始结果" }).click();
  await raw.getByLabel("搜索原始结果").fill("unique needle");
  await raw.getByText("raw unique needle").waitFor();
  report.checks.push("raw result read and search");
  for (const [name, scope] of [
    ["复制本轮轨迹（含子代理）", "turnIncludingSubagents"],
    ["复制当前会话全部轨迹", "conversationIncludingSubagents"],
    ["复制筛选结果", "filtered"],
  ]) {
    const button =
      scope === "turnIncludingSubagents"
        ? page
            .locator('[data-trajectory-turn="recent"]')
            .getByRole("button", { name, exact: true })
            .first()
        : page.getByRole("button", { name, exact: true }).first();
    await button.click();
    const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
    assert.equal(copied.scope, scope);
    if (scope === "turnIncludingSubagents")
      assert.ok(copied.children.some((child) => child.execution.executionId === "child"));
    if (scope === "conversationIncludingSubagents")
      assert.ok(copied.turns.some((turn) => turn.id === "old"));
    if (scope === "filtered") assert.ok(Array.isArray(copied.records) && copied.coverage);
  }
  report.checks.push("three clipboard scopes");
  const childButton = page.locator('[data-execution-id="child"] button').first();
  assert.equal(await childButton.getAttribute("aria-expanded"), "true");
  const scroll = page.locator(".trajectory-scroll");
  await scroll.evaluate((e) => (e.scrollTop = 100));
  const before = await scroll.evaluate((e) => e.scrollTop);
  await page.getByRole("button", { name: "刷新轨迹" }).click();
  await page.waitForTimeout(500);
  assert.equal(await childButton.getAttribute("aria-expanded"), "true");
  assert.ok(Math.abs((await scroll.evaluate((e) => e.scrollTop)) - before) < 5);
  const stale = page.locator('[data-trajectory-turn="old"]');
  const beforeText = await stale.innerText();
  await page.waitForTimeout(1200);
  assert.equal(await stale.innerText(), beforeText);
  report.checks.push("refresh preserves expansion and scroll; interrupted timing remains stable");
  await search.focus();
  await page.keyboard.press("Control+f");
  assert.equal(await search.evaluate((e) => document.activeElement === e), true);
  report.checks.push("narrow viewport keyboard focus");
  await page.screenshot({ path: join(evidence, "narrow.png"), fullPage: true });
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.errors.push(String(error));
  throw error;
} finally {
  await browser?.close();
  await vite.close();
  await writeFile(join(evidence, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ evidence, ...report }));
}
