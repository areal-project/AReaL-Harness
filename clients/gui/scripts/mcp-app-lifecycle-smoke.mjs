import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  captureSmokeFailure,
  createProjectConversation,
  selectConversation,
} from "./smoke-navigation.mjs";
import { assertApplicationStopped } from "./application-cleanup.mjs";
const gui = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const scratch = await makeTempDir("areal-mcp-lifecycle-"),
  workspace = join(scratch, "workspace"),
  userHome = join(scratch, "user");
await mkdir(join(workspace, ".agents", "plugins"), { recursive: true });
await mkdir(join(userHome, ".areal"), { recursive: true });
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
const resultMode = process.env.AREAL_MCP_RESULT_MODE === "1";
const source = join(workspace, "packages", "hello"),
  transportLog = join(scratch, "mcp.jsonl");
await mkdir(source, { recursive: true });
await writeFile(
  join(source, "plugin.json"),
  JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "hello",
    version: "1.0.0",
    description: "Desktop extension acceptance fixture.",
    extensions: { "com.openai": { interface: { displayName: "Extensions Fixture" } } },
  }),
);
const appHtml = `<!doctype html><html><body><h1>Lifecycle fixture</h1><output id="ready">waiting</output><textarea id="draft" aria-label="Unsaved document"></textarea><div id="scroll" style="height:100px;overflow:auto"><div style="height:1500px">Scroll document</div></div><output id="result"></output><button id="slow">Slow call</button><button id="full">Fullscreen</button><script>
window.fixture={bootId:crypto.randomUUID(),initialInputs:0,initialResults:0,subscriptions:0,notifications:0};let seq=0;const pending=new Map();
window.call=(method,params)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});parent.postMessage({jsonrpc:'2.0',id,method,params},'*');});
addEventListener('message',event=>{if(event.source!==parent)return;const value=event.data;if(value.jsonrpc!=='2.0')return;if(value.method==='ui/notifications/tool-input')fixture.initialInputs++;if(value.method==='ui/notifications/tool-result'){fixture.initialResults++;fixture.savedResult=value.params;}if(value.method==='ui/notifications/tool-input')fixture.savedArguments=value.params;if(value.method==='notifications/resources/updated')fixture.notifications++;if(pending.has(value.id)){const p=pending.get(value.id);pending.delete(value.id);value.error?p.reject(Object.assign(Error(value.error.message),{code:value.error.code,data:value.error.data})):p.resolve(value.result);}});
document.getElementById('slow').onclick=()=>{document.getElementById('result').textContent='pending';call('tools/call',{name:'fixture.delay',arguments:{bootId:fixture.bootId}}).then(value=>document.getElementById('result').textContent=JSON.stringify(value)).catch(error=>document.getElementById('result').textContent=error.message);};
document.getElementById('full').onclick=()=>call('ui/request-display-mode',{mode:'fullscreen'});
call('ui/initialize',{appInfo:{name:'lifecycle-fixture',version:'1'},protocolVersion:'2026-01-26',appCapabilities:{availableDisplayModes:['inline','fullscreen']}}).then(async()=>{parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized'},'*');await call('resources/subscribe',{uri:'fixture://live'});fixture.subscriptions++;document.getElementById('ready').textContent='initialized';});
</script></body></html>`;
await writeFile(join(source, "app.html"), appHtml);
const fixtureServer = String.raw`import {createInterface} from 'node:readline';
import {appendFileSync,readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const log=value=>appendFileSync(process.env.FIXTURE_LOG,JSON.stringify(value)+'\n');
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const tools=Array.from({length:9},(_,i)=>({name:'fixture.page'+(i+1),title:'Lifecycle Page '+(i+1),inputSchema:{type:'object'},annotations:{readOnlyHint:true},_meta:{ui:{resourceUri:'ui://fixture/lifecycle',visibility:['model']},'openai/ui':{entrypoints:[{type:'global'},{type:'thread'}]}}}));
tools.push({name:'fixture.business',title:'Saved business result',description:'Create the saved-result acceptance record.',inputSchema:{type:'object',properties:{value:{type:'number'}}},annotations:{readOnlyHint:true},_meta:{ui:{resourceUri:'ui://fixture/lifecycle',visibility:['model']}}});
tools.push({name:'fixture.delay',inputSchema:{type:'object'},annotations:{readOnlyHint:true},_meta:{ui:{visibility:['app']}}});
for await(const line of createInterface({input:process.stdin})){let q;try{q=JSON.parse(line);log(q);if(q.id===undefined)continue;let result;switch(q.method){
case'initialize':result={protocolVersion:q.params.protocolVersion,serverInfo:{name:'lifecycle-fixture',version:'1'},capabilities:{tools:{},resources:{subscribe:true},extensions:{'io.modelcontextprotocol/ui':{}}}};break;
case'ping':result={};break;case'tools/list':result={tools};break;
case'resources/list':result={resources:[{uri:'ui://fixture/lifecycle',name:'Lifecycle app',mimeType:'text/html;profile=mcp-app'},{uri:'fixture://live',name:'Live fixture',mimeType:'text/plain'}]};break;
case'resources/templates/list':result={resourceTemplates:[]};break;
case'resources/read':result={contents:[{uri:q.params.uri,mimeType:'text/html;profile=mcp-app',text:readFileSync(fileURLToPath(new URL('./app.html',import.meta.url)),'utf8'),_meta:{ui:{csp:{connectDomains:[],resourceDomains:[]}}}}]};break;
case'resources/subscribe':result={};break;case'resources/unsubscribe':result={};break;
case'tools/call':if(q.params.name==='fixture.business'){result={content:[{type:'text',text:'BUSINESS_RESULT_READABLE'}],structuredContent:{value:q.params.arguments.value,_meta:{private:'NESTED_RESULT_PRIVATE'}},_meta:{private:'RESULT_APP_ONLY'}};break;}if(q.params.name==='fixture.delay'){const id=q.id,bootId=q.params.arguments.bootId;const timer=setInterval(()=>{if(!existsSync(process.env.FIXTURE_RELEASE))return;clearInterval(timer);log({settled:id,bootId});send({jsonrpc:'2.0',id,result:{content:[{type:'text',text:'DELAY_DONE_'+bootId}]}});send({jsonrpc:'2.0',method:'notifications/resources/updated',params:{uri:'fixture://live'}});},50);continue;}result={content:[{type:'text',text:'APP_OPENED_'+q.params.name}]};break;
default:throw Error('unsupported method '+q.method);}send({jsonrpc:'2.0',id:q.id,result});}catch(error){if(q?.id!==undefined)send({jsonrpc:'2.0',id:q.id,error:{code:-32602,message:error.message}});}}
`;
await writeFile(join(source, "server.mjs"), fixtureServer);
await writeFile(
  join(source, "mcp.json"),
  JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: {
      fixture: {
        type: "stdio",
        command: "node",
        args: ["${PLUGIN_ROOT}/server.mjs"],
        env: { FIXTURE_LOG: transportLog, FIXTURE_RELEASE: join(scratch, "release") },
      },
    },
  }),
);
await writeFile(join(workspace, "sample.txt"), "OPAQUE_FILE_READ_MARKER\n");
await writeFile(
  join(workspace, ".agents", "plugins", "marketplace.json"),
  JSON.stringify({
    name: "gui-p0",
    plugins: [
      {
        name: "hello",
        source: { source: "local", path: "./packages/hello" },
        policy: { installation: "AVAILABLE", authentication: "ON_USE" },
        category: "Productivity",
      },
    ],
  }),
);
async function transportEvents() {
  try {
    return (await readFile(transportLog, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
const sourceRoot = resolve(gui, "../..");
const sourceFiles = {};
for (const path of new Set(
  execFileSync("git", ["ls-files", "--modified", "--others", "--exclude-standard", "-z"], {
    cwd: sourceRoot,
  })
    .toString()
    .split("\0")
    .filter(Boolean),
)) {
  if (/^(core\/|clients\/|scripts\/|schemas\/|Cargo\.|upstream\/)/.test(path))
    sourceFiles[path] = createHash("sha256")
      .update(await readFile(join(sourceRoot, path)))
      .digest("hex");
}
const sourceDiffSha256 = createHash("sha256")
  .update(
    execFileSync("git", ["diff", "--binary", "HEAD"], {
      cwd: sourceRoot,
      maxBuffer: 64 * 1024 * 1024,
    }),
  )
  .digest("hex");
const requests = [],
  checks = [],
  errors = [];
let modelBusinessSent = false,
  modelFailure;
const model = createServer(async (req, res) => {
  try {
    let body = "";
    for await (const part of req) body += part;
    const request = JSON.parse(body);
    requests.push(request);
    await appendFile(join(scratch, "model-requests.jsonl"), JSON.stringify(request) + "\n");
    if (resultMode && !modelBusinessSent && body.includes("CREATE_SAVED_RESULT")) {
      const tools = request.tools.filter(
        (tool) => tool.function?.description === "Create the saved-result acceptance record.",
      );
      assert.equal(
        tools.length,
        1,
        "normal inference inventory must contain exactly one real MCP business tool",
      );
      const tool = tools[0];
      assert.match(tool.function.name, /^mcp__/);
      modelBusinessSent = true;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        "data: " +
          JSON.stringify({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "saved-business-call",
                      type: "function",
                      function: { name: tool.function.name, arguments: '{"value":42}' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }) +
          "\n\n" +
          "data: " +
          JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
          "\n\ndata: [DONE]\n\n",
      );
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      "data: " +
        JSON.stringify({
          choices: [{ index: 0, delta: { content: "GUI_PLUGIN_SETUP_OK" }, finish_reason: null }],
        }) +
        "\n\n" +
        "data: " +
        JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
        "\n\ndata: [DONE]\n\n",
    );
  } catch (error) {
    modelFailure = error;
    errors.push("fixture model: " + error.message);
    await appendFile(
      join(scratch, "model-errors.jsonl"),
      JSON.stringify({ message: error.message, stack: error.stack }) + "\n",
    ).catch((writeError) => errors.push("fixture model evidence: " + writeError.message));
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: error.message } }));
  }
});
await new Promise((r) => model.listen(0, "127.0.0.1", r));
await writeFile(
  join(userHome, ".areal", "config.toml"),
  'schema_version=1\n[model]\nname="fixture"\n[model.providers.default]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:' +
    model.address().port +
    '"\n',
);
const env = {
  ...process.env,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: userHome,
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_CORE_BIN: process.env.AREAL_CORE_BIN ?? resolve(gui, "../../target/debug/areal"),
};
for (const k of [
  "AREAL_CORE_WORKSPACE",
  "AREAL_CORE_CONFIG",
  "AREAL_HARNESS_HOME",
  "AREAL_HARNESS_CONFIG",
  "AREAL_CORE_DESKTOP_CONFIG",
])
  delete env[k];
const coreBuildInfo = JSON.parse(
  execFileSync(env.AREAL_CORE_BIN, ["build-info"], { encoding: "utf8" }),
);
const coreBinary = env.AREAL_CORE_BIN,
  coreSha256 = createHash("sha256")
    .update(await readFile(coreBinary))
    .digest("hex");
const fixtureApp = join(scratch, "app"),
  mainErrorsPath = join(scratch, "main-errors.jsonl");
await mkdir(fixtureApp);
await writeFile(mainErrorsPath, "");
await writeFile(
  join(fixtureApp, "package.json"),
  JSON.stringify({ name: "mcp-lifecycle-fixture", main: "bootstrap.cjs" }),
);
await writeFile(
  join(fixtureApp, "bootstrap.cjs"),
  `
process.on('uncaughtExceptionMonitor',(error,origin)=>require('node:fs').appendFileSync(${JSON.stringify(mainErrorsPath)},JSON.stringify({pid:process.pid,origin,name:error.name,message:error.message,stack:error.stack})+'\\n'));
require(${JSON.stringify(join(gui, "app/src/main.cjs"))});
`,
);
let app,
  page,
  appPid,
  appProcess,
  failure,
  passed = false;
const button = (n) => page.getByRole("button", { name: n, exact: true });
const state = () => page.evaluate(() => window.arealDesktop.snapshot());
async function until(fn, label) {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    if (modelFailure) throw modelFailure;
    const s = await state();
    if (fn(s)) return s;
    await new Promise((r) => setTimeout(r, 75));
  }
  throw Error("timeout: " + label);
}
async function waitEvents(predicate, label) {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    const events = await transportEvents();
    if (predicate(events)) return events;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error("timeout: " + label);
}
async function appFrame(token) {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    const frame = page
      .frames()
      .find((frame) =>
        token
          ? frame.url() === `areal-mcp://${token}/view`
          : /^areal-mcp:\/\/[^/]+\/view$/.test(frame.url()),
      );
    if (frame) {
      await frame
        .locator("#ready")
        .filter({ hasText: "initialized" })
        .waitFor({ state: "attached" });
      return frame;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error(
    "sandbox app frame missing " +
      JSON.stringify({ token, frames: page.frames().map((frame) => frame.url()) }),
  );
}
async function call(name, params) {
  const r = await page.evaluate(({ name, params }) => window.arealDesktop.command(name, params), {
    name,
    params,
  });
  assert(r.ok, JSON.stringify(r));
  return r.value;
}
async function settings() {
  await page
    .getByRole("navigation", { name: "应用导航", exact: true })
    .getByRole("button", { name: "插件", exact: true })
    .click();
  const installed = page
    .getByRole("complementary", { name: "插件导航", exact: true })
    .getByRole("button", { name: "Extensions Fixture", exact: true });
  if (await installed.isVisible()) {
    await installed.click();
    return;
  }
  if (await button("返回插件列表").isVisible()) await button("返回插件列表").click();
  await page
    .getByRole("tablist", { name: "市场范围", exact: true })
    .getByRole("tab", { name: "个人", exact: true })
    .click();
  await button("查看插件 hello@gui-p0").click();
}
async function choosePage(number) {
  await page
    .getByTestId("chat-view")
    .getByRole("button", { name: "添加功能与 Skills", exact: true })
    .click();
  await page
    .getByTestId("composer-catalog")
    .getByRole("group", { name: "应用", exact: true })
    .getByRole("option")
    .filter({ hasText: "Lifecycle Page " + number })
    .click();
}
async function openPage(number) {
  const owner = await selected(),
    created = await call("create", {
      projectId: owner.projectId,
      options: { permissionPreset: "fullAccess" },
    });
  await selectOwner(created.threadId);
  await choosePage(number);
  const frame = page
    .getByRole("region", { name: "MCP 应用", exact: true })
    .locator('iframe[title="Lifecycle Page ' + number + '"]');
  await frame.waitFor();
  assert.equal(
    (await selected()).threadId,
    created.threadId,
    "Thread entrypoint preserves its persisted owner",
  );
  const src = await frame.getAttribute("src");
  return appFrame(new URL(src).hostname);
}
async function selectOwner(threadId) {
  if (await button("返回应用").isVisible()) await button("返回应用").click();
  await page
    .getByRole("navigation", { name: "应用导航", exact: true })
    .getByRole("button", { name: "首页", exact: true })
    .click();
  if (await button("展开侧栏").isVisible()) await button("展开侧栏").click();
  await selectConversation(page, threadId);
}
async function fixture(frame) {
  return frame.evaluate(() => ({
    ...window.fixture,
    draft: document.querySelector("#draft").value,
    start: document.querySelector("#draft").selectionStart,
    end: document.querySelector("#draft").selectionEnd,
    scroll: document.querySelector("#scroll").scrollTop,
  }));
}
async function selected() {
  return page
    .getByTestId("areal-workbench")
    .evaluate((el) => ({ projectId: el.dataset.projectId, threadId: el.dataset.threadId }));
}
const {
  builtinSkill,
  BUILTIN_SKILL_ID,
} = require("@areal/workbench-service/desktop/core/builtin-skills.cjs");
await builtinSkill(join(scratch, "core"), BUILTIN_SKILL_ID);
try {
  app = await electron.launch({
    executablePath: require("electron"),
    args: [fixtureApp],
    env,
    timeout: 120_000,
  });
  page = await app.firstWindow();
  appProcess = app.process();
  appPid = appProcess.pid;
  console.log("Electron " + appPid + " " + scratch);
  await writeFile(
    join(scratch, "run.json"),
    JSON.stringify({
      pid: app.process().pid,
      scratch,
      env: { AREAL_CORE_HOME: env.AREAL_CORE_HOME, AREAL_GUI_USER_DATA: env.AREAL_GUI_USER_DATA },
      coreBinary,
    }),
  );
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120_000 });
  await until((s) => s.connection?.state === "ready", "desktop ready");
  await app.evaluate(({ dialog, BrowserWindow }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    dialog.showMessageBox = async () => ({ response: 1 });
    BrowserWindow.getAllWindows()[0].setSize(1440, 960);
  }, workspace);
  await page.evaluate(() => window.arealDesktop.chooseProject());
  await createProjectConversation(page, "workspace");
  const ready = await until(
      (s) => s.projects.find((p) => p.root === workspace)?.state?.connected,
      "chosen project connected",
    ),
    projectId = ready.projects.find((p) => p.root === workspace).id;
  await page.getByTestId("chat-input").fill("LIFECYCLE_OWNER_ANCHOR");
  await page.getByTestId("chat-send-button").click();
  await until(
    (s) =>
      Object.values(s.projects.find((p) => p.id === projectId)?.state?.threads ?? {}).some(
        (thread) => thread.turns?.some((turn) => turn.status === "completed"),
      ),
    "ordinary owner conversation persisted",
  );
  const persistedOwner = await selected();
  assert.equal(persistedOwner.projectId, projectId);
  assert(
    (await state()).projects
      .find((p) => p.id === projectId)
      .state.threads[persistedOwner.threadId]?.turns?.some((turn) => turn.status === "completed"),
    "static app owner is a persisted Thread",
  );
  await button("更改权限").click();
  await page.getByRole("menuitemradio", { name: /^完全访问 / }).click();
  await until(
    (s) =>
      s.projects.find((p) => p.id === projectId)?.configurations?.[persistedOwner.threadId]?.options
        ?.permissionPreset === "fullAccess",
    "owner fullAccess permission persisted",
  );
  await settings();
  await button("核对来源并安装").click();
  await page
    .getByRole("checkbox", { name: "我已核对以上来源、版本和内容摘要", exact: true })
    .check();
  await button("安装到用户").click();
  await button("审阅并连接").waitFor();
  await button("审阅并连接").click();
  await page
    .getByRole("checkbox", { name: "我信任当前安装快照，并允许启动其 MCP 服务。", exact: true })
    .check();
  await button("信任并连接").click();
  await waitEvents(
    (events) => events.some((event) => event.method === "tools/list"),
    "real MCP transport started",
  );
  console.log("MCP connected");
  if (resultMode) {
    await app.evaluate(({ ipcMain }) => {
      global.resultOpenReceipts = [];
      global.resultCloseReceipts = [];
      const channel = "areal-core:mcp-app",
        original = ipcMain._invokeHandlers.get(channel);
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, request) => {
        const reply = await original(event, request);
        if (request.operation === "openFromResult")
          global.resultOpenReceipts.push({ request, reply });
        if (request.operation === "close") global.resultCloseReceipts.push({ request, reply });
        return reply;
      });
    });
    await page
      .getByRole("navigation", { name: "应用导航", exact: true })
      .getByRole("button", { name: "首页", exact: true })
      .click();
    await page.getByTestId("chat-input").fill("CREATE_SAVED_RESULT");
    await page.getByTestId("chat-send-button").click();
    const settled = await until(
      (s) =>
        Object.values(s.projects.find((p) => p.id === projectId)?.state?.threads ?? {}).some(
          (thread) =>
            thread.turns?.some(
              (turn) =>
                turn.status === "completed" &&
                turn.items?.some(
                  (item) =>
                    item.type === "dynamicToolCall" && item.callId === "saved-business-call",
                ),
            ),
        ),
      "normal model MCP business call persisted",
    );
    const resultOwner = await selected(),
      ownerThread = settled.projects.find((p) => p.id === projectId).state.threads[
        resultOwner.threadId
      ];
    const turn = ownerThread.turns.find((turn) =>
        turn.items?.some((item) => item.callId === "saved-business-call"),
      ),
      item = turn.items.find((item) => item.callId === "saved-business-call");
    assert.equal(item.execution.interactiveResult, true);
    assert.equal(item.success, true);
    assert.equal(item.execution.outcome, "succeeded");
    assert.equal(
      page.frames().filter((frame) => frame.url().startsWith("areal-mcp:")).length,
      0,
      "history does not mount result pages",
    );
    async function openSavedResult() {
      await page.locator(`[data-tool-id="${item.id}"]`).waitFor({ state: "attached" });
      const collapsed = page
        .locator(`[data-turn-id="${turn.id}"] .turn-progress-summary[aria-expanded="false"]`)
        .first();
      if (!(await button("打开交互结果").isVisible()) && (await collapsed.isVisible()))
        await collapsed.click();
      await button("打开交互结果").click();
    }
    await openSavedResult();
    let inner = await appFrame();
    const token = new URL(inner.url()).hostname;
    await inner.waitForFunction(() => fixture.initialInputs === 1 && fixture.initialResults === 1);
    assert.equal((await fixture(inner)).savedResult.structuredContent.value, 42);
    assert.equal((await fixture(inner)).savedResult._meta.private, "RESULT_APP_ONLY");
    await inner.locator("#draft").fill("SAVED_UNSAVED_DOCUMENT");
    await inner.locator("#draft").evaluate((el) => el.setSelectionRange(2, 9));
    await inner.locator("#scroll").evaluate((el) => (el.scrollTop = 480));
    const original = await fixture(inner),
      receipt = (await app.evaluate(() => global.resultOpenReceipts))[0];
    assert.deepEqual(
      {
        threadId: receipt.request.threadId,
        turnId: receipt.request.turnId,
        itemId: receipt.request.itemId,
      },
      { threadId: resultOwner.threadId, turnId: turn.id, itemId: item.id },
    );
    assert.match(receipt.request.requestId, /^result-v1\.[0-9a-f-]{36}\.[0-9a-f-]{36}$/);
    await openSavedResult();
    assert.deepEqual(await fixture(await appFrame(token)), original);
    await app.evaluate(({ ipcMain }) => {
      const channel = "areal-core:command",
        original = ipcMain._invokeHandlers.get(channel);
      let rejectCatalog = true;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, name, params) => {
        const reply = await original(event, name, params);
        if (rejectCatalog && name === "manage" && params.operation === "mcpApps") {
          rejectCatalog = false;
          return {
            ok: false,
            error: { message: "Injected saved-result catalog read unavailable" },
          };
        }
        return reply;
      });
    });
    await openSavedResult();
    await page.getByRole("status").filter({ hasText: "打开结果待确认" }).waitFor();
    assert.deepEqual(await fixture(await appFrame(token)), original);
    await button("关闭面板").click();
    assert.equal(await page.locator(`iframe[src="areal-mcp://${token}/"]`).isVisible(), false);
    await openSavedResult();
    await page
      .locator(`iframe[src="areal-mcp://${token}/"]`)
      .waitFor({ state: "visible", timeout: 5000 });
    await button("打开交互结果").waitFor({ timeout: 5000 });
    assert.equal(await page.getByRole("status").filter({ hasText: "打开结果待确认" }).count(), 0);
    assert.deepEqual(await fixture(await appFrame(token)), original);
    checks.push(
      "one injected catalog response failure preserves the open intent and same iframe, and the next same-epoch click recovers",
    );
    const repeated = await page.evaluate(
      async (request) =>
        Promise.all([window.arealDesktop.mcpApp(request), window.arealDesktop.mcpApp(request)]),
      receipt.request,
    );
    assert(
      repeated.every(
        (reply) =>
          reply.status === "open" &&
          reply.app.token === token &&
          reply.app.instanceId === receipt.reply.app.instanceId,
      ),
    );
    await button("关闭面板").click();
    assert.equal(await page.locator(`iframe[src="areal-mcp://${token}/"]`).isVisible(), false);
    await button("展开侧边面板").click();
    assert.deepEqual(await fixture(await appFrame(token)), original);
    await button("设置").click();
    await selectOwner(resultOwner.threadId);
    assert.deepEqual(await fixture(await appFrame(token)), original);
    await page.screenshot({ path: join(scratch, "result-retained.png"), animations: "disabled" });
    checks.push(
      "normal model invokes business once; raw private result hydrates once; exact result repeat/concurrency/hide/navigation retains token, boot, edits, selection and scroll",
    );
    await page
      .getByRole("region", { name: "MCP 应用", exact: true })
      .getByRole("button", { name: "关闭应用", exact: true })
      .click();
    await page.waitForFunction(
      (token) => !document.querySelector(`iframe[src="areal-mcp://${token}/"]`),
      token,
    );
    const closeDeadline = Date.now() + 10000;
    while (
      !(await app.evaluate(() => global.resultCloseReceipts)).some(
        (entry) => entry.request.token === token,
      )
    ) {
      assert(
        Date.now() < closeDeadline,
        "original close IPC must finish before terminal receipt assertion",
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(
      await page.evaluate((request) => window.arealDesktop.mcpApp(request), receipt.request),
      { status: "closed" },
    );
    await openSavedResult();
    const reopened = await appFrame();
    assert.notEqual(new URL(reopened.url()).hostname, token);
    assert.notEqual((await fixture(reopened)).bootId, original.bootId);
    assert.equal(
      (await transportEvents()).filter(
        (event) => event.method === "tools/call" && event.params.name === "fixture.business",
      ).length,
      1,
    );
    assert(!JSON.stringify(requests).includes("RESULT_APP_ONLY"));
    assert(!JSON.stringify(requests).includes("NESTED_RESULT_PRIVATE"));
    assert.equal(
      (await state()).projects.find((p) => p.id === projectId).state.threads[resultOwner.threadId]
        .turns.length,
      ownerThread.turns.length,
    );
    const sandbox = await reopened.evaluate(() => ({
      node: typeof process,
      require: typeof require,
      bridge: typeof window.arealDesktop,
    }));
    assert.deepEqual(sandbox, { node: "undefined", require: "undefined", bridge: "undefined" });
    const epochToken = new URL(reopened.url()).hostname;
    const epochCatalog = await call("manage", {
      operation: "mcpApps",
      projectId,
      threadId: resultOwner.threadId,
    });
    const changedEpoch = crypto.randomUUID();
    assert.notEqual(changedEpoch, epochCatalog.requestEpoch);
    await app.evaluate(
      ({ ipcMain }, { projectId, threadId, changedEpoch }) => {
        global.resultCatalogEpochInjection = true;
        global.resultCatalogEpochReads = [];
        const channel = "areal-core:command",
          original = ipcMain._invokeHandlers.get(channel);
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async (event, name, params) => {
          const reply = await original(event, name, params);
          if (
            global.resultCatalogEpochInjection &&
            name === "manage" &&
            params.operation === "mcpApps" &&
            params.projectId === projectId &&
            params.threadId === threadId &&
            reply.ok
          ) {
            global.resultCatalogEpochReads.push({
              requestEpoch: reply.value.requestEpoch,
              data: reply.value.data,
            });
            return { ...reply, value: { ...reply.value, requestEpoch: changedEpoch } };
          }
          return reply;
        });
      },
      { projectId, threadId: resultOwner.threadId, changedEpoch },
    );
    await page.evaluate(() => window.dispatchEvent(new Event("areal-plugins-changed")));
    await page.waitForFunction(
      (token) => !document.querySelector(`iframe[src="areal-mcp://${token}/"]`),
      epochToken,
      { timeout: 5000 },
    );
    const epochReads = await app.evaluate(() => global.resultCatalogEpochReads);
    assert(epochReads.length > 0);
    for (const read of epochReads) {
      assert.equal(read.requestEpoch, epochCatalog.requestEpoch);
      assert.deepEqual(read.data, epochCatalog.data);
    }
    await page.getByRole("status").filter({ hasText: "交互结果暂不可用" }).waitFor();
    const epochRevoked = await page.evaluate(async (token) => {
      try {
        return await window.arealDesktop.mcpApp({
          operation: "request",
          token,
          request: { jsonrpc: "2.0", id: "after-epoch-change", method: "tools/list" },
        });
      } catch (error) {
        return { error: error.message };
      }
    }, epochToken);
    assert.match(epochRevoked.error, /rejected|closed|stale/i);
    await openSavedResult();
    await page.getByRole("status").filter({ hasText: "交互结果暂不可用" }).waitFor();
    assert.equal(page.frames().filter((frame) => frame.url().startsWith("areal-mcp:")).length, 0);
    assert((await page.locator("body").innerText()).includes("BUSINESS_RESULT_READABLE"));
    assert.equal(
      (await transportEvents()).filter(
        (event) => event.method === "tools/call" && event.params.name === "fixture.business",
      ).length,
      1,
    );
    await page.screenshot({
      path: join(scratch, "result-epoch-unavailable.png"),
      animations: "disabled",
    });
    await writeFile(
      join(scratch, "result-epoch-boundary.json"),
      JSON.stringify(
        {
          injection:
            "Only requestEpoch is changed after the real mcpApps catalog read. Core is not restarted.",
          oldRequestEpoch: epochCatalog.requestEpoch,
          changedEpoch,
          token: epochToken,
          reads: epochReads,
          revoked: epochRevoked,
        },
        null,
        2,
      ),
    );
    checks.push(
      "catalog requestEpoch boundary injection with unchanged server generations removes the saved iframe and token, keeps readable history and does not replay the business tool",
    );
    await app.evaluate(() => {
      global.resultCatalogEpochInjection = false;
    });
    await app.evaluate(({ ipcMain }) => {
      const channel = "areal-core:mcp-app",
        original = ipcMain._invokeHandlers.get(channel);
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, request) => {
        const reply = await original(event, request);
        if (request.operation === "openFromResult" && reply.status === "open")
          reply.app.frameUrl += "unavailable";
        return reply;
      });
    });
    await openSavedResult();
    await page
      .getByRole("status")
      .filter({ hasText: "交互结果无法打开" })
      .waitFor({ timeout: 15_000 });
    assert.equal(page.frames().filter((frame) => frame.url().startsWith("areal-mcp:")).length, 0);
    assert.equal(
      (await transportEvents()).filter(
        (event) => event.method === "tools/call" && event.params.name === "fixture.business",
      ).length,
      1,
    );
    assert((await page.locator("body").innerText()).includes("BUSINESS_RESULT_READABLE"));
    await page.screenshot({
      path: join(scratch, "result-unavailable.png"),
      animations: "disabled",
    });
    checks.push(
      "explicit close is terminal for old request; fresh reopen has new page without business replay; model privacy/sandbox preserved; broken frame fails within10s and leaves readable history",
    );
    await writeFile(
      join(scratch, "result-identities.json"),
      JSON.stringify(
        {
          source: {
            projectId,
            threadId: resultOwner.threadId,
            turnId: turn.id,
            itemId: item.id,
            callId: item.callId,
          },
          receipts: await app.evaluate(() => global.resultOpenReceipts),
          original,
          sandbox,
        },
        null,
        2,
      ),
    );
    assert.deepEqual(errors, []);
    passed = true;
  } else {
    await selectOwner(persistedOwner.threadId);
    await choosePage(1);
    console.log("First page requested");
    let inner = await appFrame();
    const token = new URL(inner.url()).hostname,
      owner = await selected();
    await inner.locator("#draft").fill("UNSAVED_DOCUMENT");
    await inner.locator("#draft").evaluate((el) => el.setSelectionRange(3, 11));
    await inner.locator("#scroll").evaluate((el) => (el.scrollTop = 540));
    await inner.waitForFunction(
      () =>
        fixture.initialInputs === 1 && fixture.initialResults === 1 && fixture.subscriptions === 1,
    );
    const original = await fixture(inner);
    assert.equal(original.initialInputs, 1);
    assert.equal(original.initialResults, 1);
    assert.equal(original.subscriptions, 1);
    await inner.locator("#slow").click();
    await waitEvents(
      (events) =>
        events.some(
          (event) => event.method === "tools/call" && event.params.name === "fixture.delay",
        ),
      "slow call accepted",
    );
    await page.screenshot({ path: join(scratch, "01-unsaved.png"), animations: "disabled" });
    console.log("Unsaved snapshot captured");
    await button("设置").click();
    await page.getByRole("navigation", { name: "设置导航", exact: true }).waitFor();
    await selectOwner(owner.threadId);
    inner = await appFrame(token);
    assert.deepEqual(
      await fixture(inner),
      original,
      "ordinary settings navigation must retain the same live page and document",
    );
    checks.push(
      "settings navigation retains bootId, unsaved text, selection, scroll, initial input/result and subscription",
    );
    await page.keyboard.press("Control+Shift+G");
    await page.getByRole("tab", { name: "Lifecycle Page 1", exact: true }).click();
    assert.deepEqual(await fixture(inner), original);
    await button("进入完整视图").click();
    await page.getByRole("button", { name: "退出完整视图", exact: true }).waitFor();
    assert.equal((await fixture(inner)).bootId, original.bootId);
    await button("退出完整视图").click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 860));
    await inner.locator("#draft").click();
    assert((await inner.locator("#draft").boundingBox()).width > 0);
    await inner.locator("#draft").evaluate((el) => el.setSelectionRange(3, 11));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
    await inner.locator("#full").click();
    await button("退出全屏").waitFor();
    await page.screenshot({ path: join(scratch, "fullscreen.png"), animations: "disabled" });
    await button("退出全屏").click();
    await page.waitForFunction((token) => {
      const host = document.querySelector(`[data-app-token="${token}"]`).getBoundingClientRect(),
        slot = document.querySelector("[data-mcp-app-slot]").getBoundingClientRect();
      return ["left", "top", "width", "height"].every((key) => Math.abs(host[key] - slot[key]) < 1);
    }, token);
    assert.deepEqual(await fixture(inner), original);
    checks.push(
      "peer tab switch, split/full view and window resize keep one live owner with clickable frame content",
    );
    await button("关闭面板").click();
    assert.equal(await page.locator(`iframe[src="areal-mcp://${token}/"]`).isVisible(), false);
    await button("展开侧边面板").click();
    inner = await appFrame(token);
    assert.deepEqual(await fixture(inner), original);
    await createProjectConversation(page, "workspace");
    await page.getByTestId("chat-input").fill("OTHER_THREAD_ANCHOR");
    await page.getByTestId("chat-send-button").click();
    await until(
      (s) =>
        s.projects.find((p) => p.id === projectId)?.state?.threads &&
        Object.values(s.projects.find((p) => p.id === projectId).state.threads).some(
          (thread) =>
            thread.id !== owner.threadId &&
            thread.turns?.some((turn) => turn.status === "completed"),
        ),
      "second real conversation completed",
    );
    const other = await selected();
    assert(other.threadId);
    assert.notEqual(other.threadId, owner.threadId);
    assert.equal(await page.locator(`iframe[src="areal-mcp://${token}/"]`).isVisible(), false);
    await writeFile(join(scratch, "release"), "release");
    await inner
      .locator("#result")
      .filter({ hasText: "DELAY_DONE_" + original.bootId })
      .waitFor({ state: "attached" });
    assert.equal(
      (await transportEvents()).filter(
        (event) => event.method === "tools/call" && event.params.name === "fixture.delay",
      ).length,
      1,
    );
    await page.getByTestId("chat-input").focus();
    const focusBefore = await page.evaluate(() =>
      document.activeElement?.getAttribute("data-testid"),
    );
    assert.equal(focusBefore, "chat-input");
    const hidden = await inner.evaluate(async () => {
      const result = {};
      for (const [name, options] of [
        ["new", { target: "new", send: true }],
        ["draft", { target: "active", send: false }],
        ["send", { target: "active", send: true }],
      ]) {
        try {
          result[name] = await window.call("ui/message", {
            role: "user",
            content: [{ type: "text", text: "HIDDEN_OWNER_MESSAGE" }],
            _meta: { "openai/message": options },
          });
        } catch (error) {
          result[name] = { error: error.message, code: error.code, reason: error.data?.reason };
        }
      }
      return result;
    });
    assert.equal(hidden.new.reason, "app_hidden");
    assert.equal(hidden.draft.reason, "app_hidden");
    assert.equal(hidden.new.code, -32000);
    assert.equal(hidden.draft.code, -32000);
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute("data-testid")),
      focusBefore,
    );
    assert.deepEqual(hidden.send, {});
    assert.deepEqual(await selected(), other, "hidden requests cannot change visible owner");
    await until(
      (s) =>
        s.projects
          .find((p) => p.id === projectId)
          ?.state?.threads[owner.threadId]?.turns?.some(
            (t) => t.status === "completed" && JSON.stringify(t).includes("HIDDEN_OWNER_MESSAGE"),
          ),
      "hidden send settles original thread",
    );
    assert(
      !JSON.stringify(
        (await state()).projects.find((p) => p.id === projectId).state.threads[other.threadId],
      ).includes("HIDDEN_OWNER_MESSAGE"),
    );
    await selectOwner(owner.threadId);
    assert.deepEqual(await fixture(inner), { ...original, notifications: 1 });
    checks.push(
      "hidden slow tool completes once; subscription event and send:true stay with original owner; navigation and draft requests are refused",
    );
    await button("定时任务").click();
    await page.getByRole("heading", { name: "定时任务", exact: true }).waitFor();
    await selectOwner(owner.threadId);
    assert.equal((await fixture(inner)).bootId, original.bootId);
    const pages = [{ token, bootId: original.bootId, owner }];
    for (let number = 2; number <= 8; number++) {
      const frame = await openPage(number);
      pages.push({
        token: new URL(frame.url()).hostname,
        bootId: (await fixture(frame)).bootId,
        owner: await selected(),
      });
    }
    await settings();
    await button("Lifecycle Page 9").first().click();
    await page.getByRole("status").filter({ hasText: "8" }).waitFor();
    assert.equal(
      page.frames().filter((frame) => /^areal-mcp:\/\/[^/]+\/view$/.test(frame.url())).length,
      8,
    );
    for (const retained of pages)
      assert.equal((await fixture(await appFrame(retained.token))).bootId, retained.bootId);
    checks.push(
      "eight live pages survive ordinary navigation; ninth is explicitly refused without evicting drafts",
    );
    await selectOwner(pages[7].owner.threadId);
    await page
      .getByRole("region", { name: "MCP 应用", exact: true })
      .getByRole("button", { name: "关闭应用", exact: true })
      .click();
    await page.waitForFunction(
      (token) => !document.querySelector(`iframe[src="areal-mcp://${token}/"]`),
      pages[7].token,
    );
    const stale = await page.evaluate(async (token) => {
      try {
        return await window.arealDesktop.mcpApp({
          operation: "request",
          token,
          request: { jsonrpc: "2.0", id: "after-close", method: "tools/list" },
        });
      } catch (error) {
        return { error: error.message };
      }
    }, pages[7].token);
    assert(stale.error);
    const reopened = await openPage(8);
    assert.notEqual((await fixture(reopened)).bootId, pages[7].bootId);
    await page
      .getByRole("region", { name: "MCP 应用", exact: true })
      .getByRole("button", { name: "关闭应用", exact: true })
      .click();
    const replacement = await openPage(9);
    assert.notEqual((await fixture(replacement)).bootId, pages[7].bootId);
    checks.push("explicit close tears down one owner, denies the stale token and returns capacity");
    await selectOwner(pages[6].owner.threadId);
    await page
      .getByRole("region", { name: "MCP 应用", exact: true })
      .getByRole("button", { name: "关闭应用", exact: true })
      .click();
    const workspaceB = join(scratch, "workspace-b");
    await mkdir(workspaceB, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: workspaceB, stdio: "ignore" });
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, workspaceB);
    await page.evaluate(() => window.arealDesktop.chooseProject());
    await createProjectConversation(page, "workspace-b");
    await until(
      (s) => s.projects.find((p) => p.root === workspaceB)?.state?.connected,
      "second project connected",
    );
    await settings();
    await button("审阅并连接").waitFor();
    await button("审阅并连接").click();
    await page
      .getByRole("checkbox", { name: "我信任当前安装快照，并允许启动其 MCP 服务。", exact: true })
      .check();
    await button("信任并连接").click();
    await button("Lifecycle Page 1").first().waitFor();
    const projectBFrame = await openPage(1);
    const projectBToken = new URL(projectBFrame.url()).hostname;
    assert.notEqual(projectBToken, token);
    assert.notEqual((await fixture(projectBFrame)).bootId, original.bootId);
    assert.equal((await fixture(projectBFrame)).draft, "");
    const projectBOwner = await selected();
    assert.notEqual(projectBOwner.projectId, projectId);
    assert.equal((await fixture(await appFrame(token))).draft, "UNSAVED_DOCUMENT");
    checks.push("A/B projects with identical resource URI keep distinct live pages and documents");
    await call("manage", { projectId, threadId: pages[1].owner.threadId, operation: "archive" });
    await page.waitForFunction(
      (token) => !document.querySelector(`iframe[src="areal-mcp://${token}/"]`),
      pages[1].token,
    );
    assert.deepEqual(await selected(), projectBOwner);
    checks.push(
      "archiving a background thread removes its retained page without moving foreground ownership",
    );
    await settings();
    await app.evaluate(({ ipcMain }) => {
      const channel = "areal-core:command",
        original = ipcMain._invokeHandlers.get(channel);
      let failed = false;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, name, params) => {
        if (!failed && name === "manage" && params.operation === "mcpApps") {
          failed = true;
          return { ok: false, error: { message: "Injected transient directory read" } };
        }
        return original(event, name, params);
      });
    });
    await page.evaluate(() => window.dispatchEvent(new Event("areal-plugins-changed")));
    await page.waitForFunction(() =>
      document.body.innerText.includes("Injected transient directory read"),
    );
    assert.equal((await fixture(await appFrame(token))).bootId, original.bootId);
    assert.equal(
      (await fixture(await appFrame(projectBToken))).bootId,
      (await fixture(projectBFrame)).bootId,
    );
    checks.push("a transient mcpApps directory read failure preserves retained pages");
    if (process.env.AREAL_MCP_EXTERNAL_REVOCATION === "1") {
      await page.evaluate(() => {
        window.fixturePluginChanges = 0;
        window.addEventListener("areal-plugins-changed", () => window.fixturePluginChanges++);
      });
      const catalog = await call("manage", {
        projectId: projectBOwner.projectId,
        operation: "plugins",
      });
      await call("manage", {
        projectId: projectBOwner.projectId,
        operation: "pluginConfigure",
        id: "hello@gui-p0",
        scope: "user",
        enabled: false,
        expectedRevision: catalog.revision,
        requestId: crypto.randomUUID(),
      });
      await page.waitForFunction(
        () => document.querySelectorAll('iframe[src^="areal-mcp:"]').length === 0,
      );
      assert.equal(await page.evaluate(() => window.fixturePluginChanges), 0);
      checks.push(
        "independent public management API disables source without window plugin event; Core revocation closes every retained project owner",
      );
    } else {
      await settings();
      await button("管理启用范围").click();
      await button("在用户范围停用").click();
      await page.waitForFunction(
        () => document.querySelectorAll('iframe[src^="areal-mcp:"]').length === 0,
      );
      checks.push(
        "same-window source disable removes retained pages including background projects",
      );
    }
    const revoked = await page.evaluate(async (token) => {
      try {
        return await window.arealDesktop.mcpApp({
          operation: "request",
          token,
          request: { jsonrpc: "2.0", id: "after-revoke", method: "tools/list" },
        });
      } catch (error) {
        return { error: error.message };
      }
    }, token);
    assert(revoked.error);
    assert.equal(
      (await transportEvents()).filter(
        (event) => event.method === "tools/call" && event.params.name === "fixture.page1",
      ).length,
      2,
      "navigation cannot replay the initial tool",
    );
    await page.screenshot({ path: join(scratch, "02-revoked.png"), animations: "disabled" });
    assert.deepEqual(errors, []);
    passed = true;
  }
} catch (e) {
  console.error(e);
  failure = { message: e.message, stack: e.stack };
  process.exitCode = 1;
  if (page) await captureSmokeFailure(page, scratch, e);
} finally {
  await writeFile(join(scratch, "release"), "cleanup");
  const cleanup = {};
  let metadata;
  try {
    metadata = JSON.parse(await readFile(join(scratch, "core/service.json"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") errors.push("read cleanup identity: " + error.message);
  }
  if (app) {
    let quitTimer;
    try {
      await Promise.race([
        app.close(),
        new Promise((_resolve, reject) => {
          quitTimer = setTimeout(() => reject(Error("owned Electron quit timed out")), 15000);
        }),
      ]);
      if (appProcess.exitCode === null && appProcess.signalCode === null)
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(Error("owned Electron did not exit")), 15000);
          appProcess.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      assert.equal(appProcess.exitCode, 0, "owned Electron quit exit code");
      assert.equal(appProcess.signalCode, null, "owned Electron quit signal");
      cleanup.electronExited = true;
    } catch (error) {
      errors.push("close GUI: " + error.message);
    } finally {
      clearTimeout(quitTimer);
    }
  }
  if (metadata) {
    try {
      await assertApplicationStopped(coreBinary, env, metadata);
      cleanup.desktopExited = true;
      cleanup.applicationStopped = true;
    } catch (error) {
      errors.push("verify application cleanup: " + error.message);
    }
  }
  if (errors.length && metadata && !cleanup.applicationStopped) {
    cleanup.assistedServiceStop = true;
    const {
      ServiceConnection,
      waitForServiceProcessExit,
    } = require("../app/src/core/service-client.cjs");
    const connection = new ServiceConnection();
    try {
      await connection.connect(metadata);
      const packet = await connection.request("hello", {
        protocol: metadata.protocol,
        identity: metadata.identity,
      });
      await connection
        .request(
          "stopService",
          {
            protocol: metadata.protocol,
            cancel: true,
            expectedDesktopGeneration: metadata.desktopGeneration,
            expectedTargets: packet.service.targets,
          },
          true,
        )
        .catch((error) => {
          if (!error.message.includes("已请求退出")) throw error;
        });
      await waitForServiceProcessExit(join(scratch, "core"), metadata);
      cleanup.desktopExited = true;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ECONNREFUSED" && error.code !== "ESRCH")
        errors.push("fallback stop service: " + error.message);
    } finally {
      connection.close();
    }
  }
  if (appProcess && appProcess.exitCode === null && appProcess.signalCode === null) {
    errors.push("forced Electron cleanup");
    appProcess.kill("SIGKILL");
    await new Promise((resolve) => appProcess.once("exit", resolve));
    cleanup.forcedElectronExit = true;
  }
  const mainErrors = (await readFile(mainErrorsPath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  for (const error of mainErrors)
    errors.push("uncaught Main " + error.origin + ": " + error.message);
  try {
    const instances = JSON.parse(
      execFileSync(coreBinary, ["service", "list", "--json"], { env, encoding: "utf8" }),
    );
    cleanup.instances = instances.map((instance) => ({
      serviceId: instance.serviceId,
      workspace: instance.workspace,
      state: instance.state,
    }));
    assert(
      instances.every((instance) => instance.state === "stopped"),
      "owned Core instance remains live",
    );
    cleanup.coreStopped = true;
  } catch (error) {
    errors.push("verify owned Core cleanup: " + error.message);
  }
  model.closeAllConnections();
  await new Promise((r) => model.close(r));
  if (errors.length) {
    passed = false;
    process.exitCode = 1;
  }
  const manifest = {
    passed,
    checks,
    errors,
    mainErrors,
    failure,
    scratch,
    cleanup,
    source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: gui, encoding: "utf8" }).trim(),
    sourceFiles,
    sourceDiffSha256,
    core: {
      buildInfo: coreBuildInfo,
      binary: coreBinary,
      sha256: coreSha256,
      unchanged:
        createHash("sha256")
          .update(await readFile(coreBinary))
          .digest("hex") === coreSha256,
    },
    modelRequests: requests.length,
    transportEvents: await transportEvents(),
    gaps: [
      ...(resultMode
        ? [
            "Core process epoch change is injected only in the real catalog response; no GUI Core restart",
            "source disable/uninstall/restart negatives are covered by separate Core integration, not this GUI scenario",
          ]
        : process.env.AREAL_MCP_EXTERNAL_REVOCATION === "1"
          ? []
          : [
              "external source revocation event requires integrated current Core; this run exercises same-window source disable",
            ]),
      "no real provider/GitHub/OAuth or packaged acceptance",
    ],
    scope: resultMode
      ? "actual source Electron/Core saved MCP result lifecycle; self-owned stdio MCP server; deterministic local inference; native directory picker stub; catalog epoch/read-failure and broken frame URL are response-boundary injections"
      : "actual source Electron/Core live MCP page lifecycle; self-owned stdio MCP server; deterministic local inference endpoint; archive fixture uses real management API; transient directory failure injected only at IPC response",
  };
  console.log("Evidence: " + scratch);
  await writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}
