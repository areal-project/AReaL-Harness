import { makeTempDir } from "./support/temp.mjs";
import { until } from "./support/desktop-fixture.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { appendFile, chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { trackedMkdtemp } from "./support/host-cleanup.cjs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  captureSmokeFailure,
  createProjectConversation,
  selectConversation,
  selectCreatedConversation,
} from "./smoke-navigation.mjs";
import { assertApplicationStopped } from "./application-cleanup.mjs";
import { pageToolsEditorHtml } from "./fixtures/mcp-page-tools-bundle.mjs";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const baselineOnly = process.argv.includes("--inventory-baseline");
const contracts = [
  [
    "entrypoints",
    "Apps stay out of the sidebar and Composer surface; grouped + and slash entries open the original Thread page.",
  ],
  [
    "inventory",
    "Ordinary inference receives both fixed kinds after initialized registration, with finite schemas and distinct instance names.",
  ],
  [
    "isolation",
    "A named tool edits its original live A page while B and another Thread remain unchanged, including when A is hidden.",
  ],
  [
    "permission",
    "Ordinary denied applyPatch creates no iframe request, no edit, and a durable failed or cancelled no-effect item.",
  ],
  [
    "revision",
    "Typing changes revision, selection does not, competing expected revisions admit one transaction, and real undo restores its text while advancing revision.",
  ],
  [
    "bounds",
    "Unknown arguments and oversized replacement fail before page dispatch; CR and surrogate-splitting patches leave document and revision unchanged; oversized replies cannot enter the saved result.",
  ],
  [
    "retention",
    "Settings and pane hiding retain boot ID, document, selection, history, and the original tool publication.",
  ],
  [
    "close-revoke",
    "Explicit close removes publication and invalidates the token, reopen creates a new identity, and source revoke removes publication.",
  ],
  [
    "cancel-no-effect",
    "Cancellation confirmed before editor dispatch records cancelledNoEffect and leaves text unchanged.",
  ],
  [
    "cancel-unknown",
    "An editor transaction followed by a lost result records UNKNOWN, retains the one edit, and never replays.",
  ],
  [
    "terminal-receipt",
    "Identical terminal resubmission is accepted without execution and conflicting terminal data is rejected.",
  ],
  [
    "cancel-claimed",
    "Cancellation after durable claim but before iframe delivery confirms no effect.",
  ],
  [
    "durable-ack",
    "Accepted terminal survives lost resolve acknowledgement without repeating the editor transaction.",
  ],
  [
    "stale-binding",
    "Changed schemas and generation are rejected through the original authenticated transport.",
  ],
  [
    "source-epoch",
    "Package replacement and Core restart invalidate previously frozen page bindings.",
  ],
  [
    "capacity",
    "Eight live registered pages survive the ninth page rejection without eviction or mutation.",
  ],
  ["post-hooks", "Failing and cancelled real post hooks preserve the accepted Page terminal."],
  [
    "restart",
    "Accepted terminal and UNKNOWN records remain identical after application/Core restart without replay.",
  ],
  [
    "socket-owner",
    "Sibling Desktop and Core sockets cannot register, claim, or settle the opening owner’s instance.",
  ],
];
const checkpoint = {
  blockingFirstSteps:
    "Build pinned real CodeMirror fixture, then observe missing ordinary inventory using an immutable compatible original-main binary.",
  independentWorkstreams:
    "This runner and its editor fixture are owned separately from Core and host implementation.",
  sharedMutableState:
    "One isolated home/workspace per run; source GUI focus and fixed binary slots are serialized.",
  smallestSafeDecomposition:
    "One runner owns the deterministic model plan, editor observation, and ordinary journal assertions.",
};
const bundle = await pageToolsEditorHtml();
if (process.argv.includes("--bundle-only")) {
  console.log(
    JSON.stringify(
      { bytes: bundle.bytes, versions: bundle.versions, contracts, checkpoint },
      null,
      2,
    ),
  );
  process.exit(0);
}
const evidenceRoot = join(sourceRoot, ".scratch/phase-four");
await mkdir(evidenceRoot, { recursive: true });
const scratch = await trackedMkdtemp(
  join(evidenceRoot, baselineOnly ? "red-inventory-" : "page-tools-"),
);
const isolated = await makeTempDir("areal-page-tools-");
const workspace = join(isolated, "workspace"),
  userHome = join(isolated, "user");
await mkdir(join(workspace, ".agents/plugins"), { recursive: true });
await mkdir(join(userHome, ".areal"), { recursive: true });
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
const source = join(workspace, "packages/editor"),
  transportLog = join(scratch, "mcp.jsonl");
await mkdir(source, { recursive: true });
await writeFile(
  join(scratch, "contract.json"),
  JSON.stringify(
    {
      contracts,
      checkpoint,
      inputBoundary:
        "Local deterministic model HTTP and native directory chooser are fixtures. Core, permission, journal, Desktop, Main, source-bound iframe, and CodeMirror are real.",
      faultBoundary:
        "Original Main requests are held before claim, after the real durable claim, and after Core accepts resolve. The real guest pauses before or after its synchronous editor transaction. Only ordering and response loss are injected; Core authority and persistence are real.",
    },
    null,
    2,
  ),
);
await writeFile(
  join(source, "plugin.json"),
  JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "editor",
    version: "1.0.0",
    description: "Real editor Page tool acceptance.",
    extensions: { "com.openai": { interface: { displayName: "Page tools fixture" } } },
  }),
);
await writeFile(join(source, "app.html"), bundle.html);
await writeFile(
  join(source, "server.mjs"),
  String.raw`import {createInterface} from 'node:readline';
import {appendFileSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const tools=['A','B','C','D','E','F','G','H','I'].map(label=>({name:'fixture.page'+label,title:'Editor '+label,description:'Open static editor '+label,inputSchema:{type:'object',additionalProperties:false},annotations:{readOnlyHint:true},_meta:{ui:{resourceUri:'ui://fixture/editor',visibility:['model']},'openai/ui':{entrypoints:[{type:'global'},{type:'thread'}]}}}));
for await(const line of createInterface({input:process.stdin})){let q;try{q=JSON.parse(line);appendFileSync(process.env.FIXTURE_LOG,JSON.stringify(q)+'\n');if(q.id===undefined)continue;let result;
switch(q.method){
case'initialize':result={protocolVersion:q.params.protocolVersion,serverInfo:{name:'static-editor-fixture',version:'1'},capabilities:{tools:{},resources:{},extensions:{'io.modelcontextprotocol/ui':{}}}};break;
case'ping':result={};break;
case'tools/list':result={tools};break;
case'resources/list':result={resources:[{uri:'ui://fixture/editor',name:'Static real editor',mimeType:'text/html;profile=mcp-app'}]};break;
case'resources/templates/list':result={resourceTemplates:[]};break;
case'resources/read':result={contents:[{uri:q.params.uri,mimeType:'text/html;profile=mcp-app',text:readFileSync(fileURLToPath(new URL('./app.html',import.meta.url)),'utf8'),_meta:{ui:{csp:{connectDomains:[],resourceDomains:[]}}}}]};break;
case'tools/call':if(!tools.some(tool=>tool.name===q.params.name))throw Error('static fixture cannot execute editor operations');result={content:[{type:'text',text:'STATIC_EDITOR_OPEN_'+q.params.name}]};break;
default:throw Error('unsupported static fixture method '+q.method);}
send({jsonrpc:'2.0',id:q.id,result});}catch(error){if(q?.id!==undefined)send({jsonrpc:'2.0',id:q.id,error:{code:-32602,message:error.message}});}}
`,
);
await writeFile(
  join(source, "mcp.json"),
  JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: {
      fixture: {
        type: "stdio",
        command: "node",
        args: ["${PLUGIN_ROOT}/server.mjs"],
        env: { FIXTURE_LOG: transportLog },
      },
    },
  }),
);
await writeFile(
  join(workspace, ".agents/plugins/marketplace.json"),
  JSON.stringify({
    name: "page-tools-market",
    plugins: [
      {
        name: "editor",
        source: { source: "local", path: "./packages/editor" },
        policy: { installation: "AVAILABLE", authentication: "ON_USE" },
        category: "Productivity",
      },
    ],
  }),
);
const sourceFiles = {};
for (const path of new Set(
  execFileSync("git", ["ls-files", "--modified", "--others", "--exclude-standard", "-z"], {
    cwd: sourceRoot,
  })
    .toString()
    .split("\0")
    .filter(Boolean),
)) {
  if (/^(core\/|clients\/|scripts\/|schemas\/|Cargo\.)/.test(path))
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
  errors = [],
  plans = new Map();
let modelFailure;
const contentText = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((value) => value.text ?? "").join("\n")
      : "";
const model = createServer(async (req, res) => {
  try {
    let body = "";
    for await (const part of req) body += part;
    const request = JSON.parse(body);
    requests.push(request);
    await appendFile(join(scratch, "model-requests.jsonl"), JSON.stringify(request) + "\n");
    const marker = [...(request.messages ?? [])]
      .reverse()
      .map((message) => (message.role === "user" ? contentText(message.content) : ""))
      .map((text) => text.match(/PAGE_CASE ([0-9a-f-]{36})/))
      .find(Boolean);
    const plan = marker ? plans.get(marker[1]) : undefined;
    let delta = { content: "PAGE_CASE_DONE" };
    let finish = "stop";
    if (plan && !plan.sent) {
      plan.inventory = request.tools ?? [];
      plan.sent = true;
      plan.validate?.(plan.inventory);
      if (plan.calls?.length) {
        delta = {
          tool_calls: plan.calls.map((call, index) => ({
            index,
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          })),
        };
        finish = "tool_calls";
      }
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      "data: " +
        JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) +
        "\n\n" +
        "data: " +
        JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] }) +
        "\n\ndata: [DONE]\n\n",
    );
  } catch (error) {
    modelFailure = error;
    await appendFile(
      join(scratch, "model-errors.jsonl"),
      JSON.stringify({ message: error.message, stack: error.stack }) + "\n",
    );
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: error.message } }));
  }
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const hookMode = join(workspace, "hook-mode"),
  hookEvents = join(workspace, "hook-events.jsonl");
await writeFile(hookMode, "normal");
await writeFile(
  join(workspace, "page-post-hook.sh"),
  `IFS= read -r payload
mode=$(/bin/cat ./hook-mode)
if [ "$mode" = normal ]; then printf '{}'; exit 0; fi
printf '%s' "$payload" > ./hook-input.json
printf '{"mode":"%s"}\\n' "$mode" >> ./hook-events.jsonl
if [ "$mode" = failure ]; then printf PAGE_POST_FAILURE >&2; exit 1; fi
while [ "$mode" = hold ] && [ ! -e ./hook-release ]; do /bin/sleep 0.1; done
printf '{}'
`,
);
await writeFile(
  join(userHome, ".areal/page-tools.json"),
  JSON.stringify({
    hooks: [
      {
        name: "page-terminal-acceptance",
        event: "PostToolUse",
        matcher: "*",
        argv: ["/bin/sh", "./page-post-hook.sh"],
        timeoutMs: 60000,
      },
    ],
  }),
);
await writeFile(
  join(userHome, ".areal/config.toml"),
  `schema_version=1\n[tools]\nextensions_file="${join(userHome, ".areal/page-tools.json")}"\n[model]\nname="fixture"\n[model.providers.default]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}"\n`,
);
const env = {
  ...process.env,
  AREAL_GUI_USER_DATA: join(isolated, "electron"),
  AREAL_CORE_HOME: join(isolated, "core"),
  AREAL_CORE_USER_HOME: userHome,
  AREAL_HARNESS_SERVICE_HOME: join(isolated, "registry"),
  AREAL_CORE_BIN: process.env.AREAL_CORE_BIN ?? resolve(gui, "../../target/debug/areal"),
};
for (const key of [
  "AREAL_CORE_WORKSPACE",
  "AREAL_CORE_CONFIG",
  "AREAL_HARNESS_HOME",
  "AREAL_HARNESS_CONFIG",
  "AREAL_CORE_DESKTOP_CONFIG",
])
  delete env[key];
const coreBinary = env.AREAL_CORE_BIN;
const coreBuildInfo = JSON.parse(execFileSync(coreBinary, ["build-info"], { encoding: "utf8" }));
const coreSha256 = createHash("sha256")
  .update(await readFile(coreBinary))
  .digest("hex");
const fixtureApp = join(isolated, "app"),
  mainErrorsPath = join(scratch, "main-errors.jsonl");
await mkdir(fixtureApp);
await writeFile(mainErrorsPath, "");
await writeFile(
  join(fixtureApp, "package.json"),
  JSON.stringify({ name: "mcp-page-tools-fixture", main: "bootstrap.cjs" }),
);
await writeFile(
  join(fixtureApp, "bootstrap.cjs"),
  `global.pageToolServiceModule=require(${JSON.stringify(join(gui, "app/src/core/service-client.cjs"))});process.on('uncaughtExceptionMonitor',(error,origin)=>require('node:fs').appendFileSync(${JSON.stringify(mainErrorsPath)},JSON.stringify({pid:process.pid,origin,message:error.message,stack:error.stack})+'\\n'));require(${JSON.stringify(join(gui, "app/src/main.cjs"))});`,
);
const {
  builtinSkill,
  BUILTIN_SKILL_ID,
} = require("@areal/workbench-service/desktop/core/builtin-skills.cjs");
await builtinSkill(join(isolated, "core"), BUILTIN_SKILL_ID);
let app,
  page,
  appProcess,
  failure,
  passed = false;
const button = (name) => page.getByRole("button", { name, exact: true });
const state = () => page.evaluate(() => window.arealDesktop.snapshot());
const eventually = (read, predicate, label, timeout = 30000) =>
  until(read, label, {
    accept: predicate,
    timeout,
    interval: 75,
    abort: () => {
      if (modelFailure) throw modelFailure;
    },
  });
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
const selected = () =>
  page
    .getByTestId("areal-workbench")
    .evaluate((el) => ({ projectId: el.dataset.projectId, threadId: el.dataset.threadId }));
const fixture = (frame) => frame.evaluate(() => window.fixture.snapshot());
async function appFrame(token) {
  const frame = await eventually(
    async () =>
      page
        .frames()
        .find((frame) =>
          token
            ? frame.url() === `areal-mcp://${token}/view`
            : /^areal-mcp:\/\/[^/]+\/view$/.test(frame.url()),
        ),
    Boolean,
    "source-bound editor iframe",
  );
  await frame.locator("#ready").filter({ hasText: "initialized" }).waitFor({ state: "attached" });
  return frame;
}
async function settings() {
  await page
    .getByRole("navigation", { name: "应用导航", exact: true })
    .getByRole("button", { name: "插件", exact: true })
    .click();
  const installed = page
    .getByRole("complementary", { name: "插件导航", exact: true })
    .getByRole("button", { name: "Page tools fixture", exact: true });
  if (await installed.isVisible()) {
    await installed.click();
    return;
  }
  if (await button("返回插件列表").isVisible()) await button("返回插件列表").click();
  await page
    .getByRole("tablist", { name: "市场范围", exact: true })
    .getByRole("tab", { name: "个人", exact: true })
    .click();
  await button("查看插件 editor@page-tools-market").click();
}
async function _openPage(label) {
  await settings();
  await button(`Editor ${label}`).first().click();
  const iframe = page
    .getByRole("region", { name: "MCP 应用", exact: true })
    .locator(`iframe[title="Editor ${label}"]`);
  await iframe.waitFor();
  return appFrame(new URL(await iframe.getAttribute("src")).hostname);
}
async function chooseThreadApp(label, owner) {
  await selectOwner(owner.threadId);
  assert.equal(
    await page
      .locator(".sidebar-tools")
      .getByRole("navigation", { name: "应用入口", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page
      .getByTestId("chat-view")
      .getByRole("navigation", { name: "应用入口", exact: true })
      .count(),
    0,
  );
  const input = page.getByTestId("chat-input");
  if (label === "B") await input.fill("保留正文 /pageB");
  else
    await page
      .getByTestId("chat-view")
      .getByRole("button", { name: "添加功能与 Skills", exact: true })
      .click();
  const catalog = page.getByTestId("composer-catalog");
  const option = catalog
    .getByRole("group", { name: "应用", exact: true })
    .getByRole("option")
    .filter({ hasText: `Editor ${label}` });
  await option.waitFor();
  if (label === "A" || label === "B")
    await page.screenshot({
      path: join(scratch, label === "A" ? "apps-plus-menu.png" : "apps-slash-menu.png"),
      animations: "disabled",
    });
  if (label === "B") await input.press("Enter");
  else await option.click();
}
async function openThreadPage(label, owner) {
  await chooseThreadApp(label, owner);
  const iframe = page
    .getByRole("region", { name: "MCP 应用", exact: true })
    .locator(`iframe[title="Editor ${label}"]`);
  await iframe.waitFor();
  assert.deepEqual(await selected(), owner, "Thread entrypoint preserves the selected owner");
  return appFrame(new URL(await iframe.getAttribute("src")).hostname);
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
const thread = (snapshot, owner) =>
  snapshot.projects.find((project) => project.id === owner.projectId)?.state?.threads?.[
    owner.threadId
  ];
async function beginCase(name, calls = [], validate) {
  const id = randomUUID(),
    owner = await selected();
  console.log("Case " + name + " " + owner.threadId);
  const plan = {
    id,
    name,
    owner,
    calls: calls.map((call, index) => ({ ...call, id: `page-${id}-${index}` })),
    validate,
    sent: false,
  };
  plans.set(id, plan);
  await page.getByTestId("chat-input").fill(`PAGE_CASE ${id} ${name}`);
  await page.getByTestId("chat-send-button").click();
  await eventually(
    async () => plan.sent,
    (value) => value,
    `ordinary model received ${name}`,
  );
  return plan;
}
async function finishCase(plan, statuses = ["completed"]) {
  const snapshot = await eventually(
    state,
    (snapshot) =>
      thread(snapshot, plan.owner)?.turns?.some(
        (turn) =>
          statuses.includes(turn.status) &&
          (plan.calls.length
            ? plan.calls.every((call) => turn.items?.some((item) => item.callId === call.id))
            : JSON.stringify(turn).includes(plan.id)),
      ),
    `ordinary turn ${plan.name} settled`,
  );
  const ownerThread = thread(snapshot, plan.owner);
  const turn = ownerThread.turns.find((turn) =>
    plan.calls.length
      ? plan.calls.every((call) => turn.items?.some((item) => item.callId === call.id))
      : JSON.stringify(turn).includes(plan.id),
  );
  assert(turn, `persisted ordinary Turn for ${plan.name}`);
  plan.turnId = turn.id;
  plan.items = plan.calls.map((call) => {
    const item = turn.items.find((item) => item.callId === call.id);
    assert.equal(item.type, "dynamicToolCall");
    return item;
  });
  await writeFile(
    join(scratch, `${plan.name}.json`),
    JSON.stringify({ owner: plan.owner, turn, inventory: plan.inventory }, null, 2),
  );
  return plan.items;
}
async function registration(token) {
  return eventually(
    async () =>
      app.evaluate(
        (_electron, token) =>
          global.pageToolsReceipts.find(
            (receipt) =>
              receipt.request.operation === "pageToolsReady" &&
              receipt.request.token === token &&
              receipt.reply?.registrationId,
          ),
        token,
      ),
    Boolean,
    "trusted initialized registration",
  );
}
const toolName = (receipt, kind) => {
  const tool = receipt.reply.tools.find((tool) => tool.kind === kind);
  assert(tool, `registered ${kind}`);
  return tool.name;
};
const pageEvidence = (item) => {
  const evidence = item.execution?.page;
  assert(evidence, "ordinary ToolExecution contains frozen Page evidence");
  assert.equal(evidence.dispatch.state, "terminal");
  assert.match(evidence.binding.schemaDigest, /^[0-9a-f]{64}$/);
  assert.match(evidence.dispatch.replyDigest, /^[0-9a-f]{64}$/);
  return evidence;
};
async function setPermission(label) {
  const owner = await selected();
  await button("更改权限").click();
  await page.getByRole("menuitemradio", { name: new RegExp("^" + label + " ") }).click();
  await eventually(
    state,
    (snapshot) => {
      const options = snapshot.projects.find((project) => project.id === owner?.projectId)
        ?.configurations?.[owner.threadId]?.options;
      return options?.permissionPreset === (label === "请求审批" ? "ask" : "fullAccess");
    },
    `permission ${label} persisted`,
  );
}
async function setFault(mode) {
  await app.evaluate((_electron, mode) => {
    global.pageToolFault = { mode, reached: false };
  }, mode);
}
async function waitFault() {
  return eventually(
    async () =>
      app.evaluate(() => ({
        mode: global.pageToolFault?.mode,
        reached: global.pageToolFault?.reached,
        request: global.pageToolFault?.request,
        reply: global.pageToolFault?.reply,
      })),
    (value) => value.reached,
    "declared transport fault boundary",
  );
}
async function releaseFault() {
  await app.evaluate(() => {
    global.pageToolFault?.release?.();
    global.pageToolFault = null;
  });
}
async function stopTurn() {
  await button("暂停执行").click();
}
const terminalStatuses = ["completed", "interrupted", "failed"];
const transportRequests = () => app.evaluate(() => global.pageToolRequests);
const originalRequest = (request) =>
  app.evaluate(async (_electron, request) => {
    try {
      return {
        value: await global.pageToolOriginalRequest.call(
          global.pageToolConnection,
          "mcpPageTools",
          request,
          true,
        ),
      };
    } catch (error) {
      return { error: error.message, code: error.code };
    }
  }, request);
const editorState = ({ text, documentRevision, undoDepth, redoDepth }) => ({
  text,
  documentRevision,
  undoDepth,
  redoDepth,
});
async function recordedResolve(callId) {
  return eventually(
    transportRequests,
    (values) =>
      values.some(
        (value) =>
          value.params.operation === "resolve" && value.params.callId === callId && value.reply,
      ),
    "real accepted resolve",
  ).then((values) =>
    values.find(
      (value) =>
        value.params.operation === "resolve" && value.params.callId === callId && value.reply,
    ),
  );
}
async function showEditor(label, owner) {
  await selectOwner(owner.threadId);
  if ((await button("展开侧边面板").getAttribute("aria-pressed")) === "false")
    await button("展开侧边面板").click();
  await page.getByRole("tab", { name: `Editor ${label}`, exact: true }).click();
  await page.waitForFunction((label) => {
    const iframe = [...document.querySelectorAll("iframe")].find(
      (frame) => frame.title === "Editor " + label,
    );
    const host = iframe?.closest("[data-app-token]")?.getBoundingClientRect(),
      slot = document.querySelector("[data-mcp-app-slot]")?.getBoundingClientRect();
    return (
      host &&
      slot &&
      ["left", "top", "width", "height"].every((key) => Math.abs(host[key] - slot[key]) < 1)
    );
  }, label);
}
async function inspectUnknown(item, facts) {
  await button("核查 UNKNOWN").click();
  const dialog = page.getByRole("dialog", { name: "核查工具结果 UNKNOWN", exact: true });
  await dialog.getByRole("textbox", { name: "核查说明", exact: true }).fill(facts);
  await dialog.getByRole("checkbox", { name: "已核查实际文件或进程", exact: true }).check();
  await dialog.getByRole("button", { name: "确认已核查", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const snapshot = await eventually(
    state,
    (value) =>
      value.projects.some((project) =>
        Object.values(project.state?.threads ?? {}).some((thread) =>
          thread.turns?.some((turn) =>
            turn.items?.some((value) => value.id === item.id && value.execution?.inspection),
          ),
        ),
      ),
    "operator inspection persisted",
  );
  const recorded = snapshot.projects
    .flatMap((project) => Object.values(project.state?.threads ?? {}))
    .flatMap((thread) => thread.turns ?? [])
    .flatMap((turn) => turn.items ?? [])
    .find((value) => value.id === item.id);
  assert.equal(
    recorded.execution.outcome,
    item.execution.outcome,
    "inspection preserves original outcome",
  );
  return recorded;
}
async function focusOwnedWindow() {
  await app.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window.isFocused()) {
      app.focus({ steal: true });
      window.focus();
    }
  });
  await eventually(
    () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()),
    Boolean,
    "owned window has OS focus",
  );
}
async function inputEvidence(frame, name) {
  const surfaces = await Promise.all(
    [page.mainFrame(), frame.parentFrame()].map((surface) =>
      surface.evaluate(() => {
        if (!window.pageInputEvents) {
          window.pageInputEvents = [];
          for (const type of ["pointerdown", "mousedown", "click"])
            document.addEventListener(
              type,
              (event) =>
                window.pageInputEvents.push({
                  type,
                  x: event.clientX,
                  y: event.clientY,
                  tag: event.target.tagName,
                  id: event.target.id,
                }),
              true,
            );
        }
        return { url: location.href, focus: document.hasFocus(), events: window.pageInputEvents };
      }),
    ),
  );
  const guest = await frame.evaluate(() => window.fixture.diagnostics());
  const host = await page.evaluate((url) => {
    const token = new URL(url).hostname;
    const iframe = document.querySelector(`[data-app-token="${token}"] iframe`);
    if (!iframe)
      return {
        missing: true,
        iframes: [...document.querySelectorAll("iframe")].map((value) => ({
          title: value.title,
          src: value.src,
        })),
      };
    const entries = [];
    for (let element = iframe; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      entries.push({
        tag: element.tagName,
        id: element.id,
        token: element.getAttribute("data-app-token"),
        inert: element.inert,
        ariaHidden: element.getAttribute("aria-hidden"),
        visibility: style.visibility,
        display: style.display,
        pointerEvents: style.pointerEvents,
        rect: element.getBoundingClientRect().toJSON(),
      });
    }
    const rect = iframe.getBoundingClientRect(),
      hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return { entries, hit: hit ? { tag: hit.tagName, title: hit.title } : null };
  }, frame.url());
  const windows = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => ({
      id: window.id,
      focused: window.isFocused(),
      webContentsFocused: window.webContents.isFocused(),
      visible: window.isVisible(),
    })),
  );
  await writeEvidence(name, { guest, host, windows, surfaces });
}
async function manage(owner, operation, params = {}) {
  const result = await page.evaluate((params) => window.arealDesktop.command("manage", params), {
    ...owner,
    operation,
    ...params,
  });
  assert(result.ok, JSON.stringify(result));
  return result.value;
}
async function writableDirectories(path) {
  await chmod(path, 0o700);
  for (const entry of await readdir(path, { withFileTypes: true }))
    if (entry.isDirectory()) await writableDirectories(join(path, entry.name));
}
async function writeEvidence(name, value) {
  await writeFile(join(scratch, name + ".json"), JSON.stringify(value, null, 2));
}

try {
  app = await electron.launch({
    executablePath: require("electron"),
    args: [fixtureApp],
    env,
    timeout: 120000,
  });
  page = await app.firstWindow();
  appProcess = app.process();
  page.setDefaultTimeout(20000);
  console.log(`Electron ${appProcess.pid}. Evidence ${scratch}`);
  await writeFile(
    join(scratch, "run.json"),
    JSON.stringify(
      {
        pid: appProcess.pid,
        isolated,
        scratch,
        coreBinary,
        env: { AREAL_CORE_HOME: env.AREAL_CORE_HOME, AREAL_GUI_USER_DATA: env.AREAL_GUI_USER_DATA },
      },
      null,
      2,
    ),
  );
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await eventually(state, (snapshot) => snapshot.connection?.state === "ready", "Desktop ready");
  await app.evaluate(({ dialog, BrowserWindow }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    dialog.showMessageBox = async () => ({ response: 1 });
    BrowserWindow.getAllWindows()[0].setSize(1440, 960);
  }, workspace);
  const identity = await app.evaluate(({ app, BrowserWindow }) => ({
    pid: process.pid,
    electron: process.versions.electron,
    userData: app.getPath("userData"),
    windows: BrowserWindow.getAllWindows().map((window) =>
      window.webContents.getLastWebPreferences(),
    ),
  }));
  assert.equal(identity.userData, env.AREAL_GUI_USER_DATA);
  for (const preferences of identity.windows) {
    assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.nodeIntegration, false);
  }
  await writeFile(join(scratch, "doctor.json"), JSON.stringify(identity, null, 2));
  await app.evaluate(
    ({ ipcMain }) => {
      global.pageToolsReceipts = [];
      global.pageToolRequests = [];
      global.pageToolNotices = [];
      const { ServiceConnection } = global.pageToolServiceModule,
        originalRequest = ServiceConnection.prototype.request;
      ServiceConnection.prototype.request = async function (method, params, mutation) {
        if (method !== "mcpPageTools") return originalRequest.call(this, method, params, mutation);
        global.pageToolConnection = this;
        if (!this.pageToolNoticeObserved) {
          this.pageToolNoticeObserved = true;
          const notify = this.onMcpPageToolNotice;
          this.onMcpPageToolNotice = (event) => {
            global.pageToolNotices.push(structuredClone(event));
            return notify(event);
          };
        }
        global.pageToolOriginalRequest = originalRequest;
        const record = { params: structuredClone(params), startedAt: Date.now() };
        global.pageToolRequests.push(record);
        const fault = global.pageToolFault;
        const hold = async (reply) => {
          fault.reached = true;
          fault.request = structuredClone(params);
          fault.reply = reply;
          await new Promise((resolve) => {
            fault.release = resolve;
          });
        };
        if (fault?.mode === "beforeClaim" && params.operation === "claim") await hold(null);
        let reply;
        try {
          reply = await originalRequest.call(this, method, params, mutation);
        } catch (error) {
          record.error = error.message;
          record.finishedAt = Date.now();
          throw error;
        }
        record.reply = structuredClone(reply);
        record.finishedAt = Date.now();
        if (
          fault?.mode === "afterClaim" &&
          params.operation === "claim" &&
          reply.status === "granted"
        )
          await hold(reply);
        if (fault?.mode === "afterResolve" && params.operation === "resolve") {
          await hold(reply);
          throw Object.assign(Error("Injected lost response after real durable resolve"), {
            submissionUnknown: true,
          });
        }
        return reply;
      };
      const channel = "areal-core:mcp-app",
        original = ipcMain._invokeHandlers.get(channel);
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, request) => {
        const reply = await original(event, request);
        global.pageToolsReceipts.push({ request, reply });
        return reply;
      });
    },
    join(gui, "app/src/core/service-client.cjs"),
  );
  await page.evaluate(() => window.arealDesktop.chooseProject());
  await createProjectConversation(page, "workspace");
  await eventually(
    state,
    (snapshot) => snapshot.projects.find((project) => project.root === workspace)?.state?.connected,
    "project connected",
  );
  let initialOwner = await selected();
  if (!thread(await state(), initialOwner)) {
    const created = await page.evaluate((params) => window.arealDesktop.command("create", params), {
      projectId: initialOwner.projectId,
    });
    assert(created.ok, JSON.stringify(created));
    await selectCreatedConversation(page, initialOwner.projectId, created.value.threadId);
    initialOwner = await selected();
  }
  await setPermission("完全访问");
  await settings();
  await button("检查安装内容").click();
  await button("安装到用户").click();
  await button("审阅并连接").click();
  await page
    .getByRole("checkbox", { name: "我信任当前安装快照，并允许启动其 MCP 服务。", exact: true })
    .check();
  await button("信任并连接").click();
  await eventually(
    transportEvents,
    (events) => events.some((event) => event.method === "tools/list"),
    "static MCP transport",
  );
  await selectOwner(initialOwner.threadId);
  const beforeDraft = Object.keys(
    (await state()).projects.find((project) => project.id === initialOwner.projectId).state.threads,
  ).length;
  await button("新聊天").click();
  await page.getByTestId("chat-input").fill("/pageA");
  await page
    .getByTestId("composer-catalog")
    .getByRole("group", { name: "应用", exact: true })
    .getByRole("option")
    .filter({ hasText: "Editor A" })
    .waitFor();
  assert.equal(
    Object.keys(
      (await state()).projects.find((project) => project.id === initialOwner.projectId).state
        .threads,
    ).length,
    beforeDraft,
    "browsing draft apps does not create a conversation",
  );
  await page.screenshot({
    path: join(scratch, "draft-apps-slash-menu.png"),
    animations: "disabled",
  });
  await page.getByTestId("chat-input").press("Escape");
  await page.getByTestId("chat-input").fill("");
  await page.getByRole("button", { name: "添加功能与 Skills", exact: true }).click();
  await page
    .getByTestId("composer-catalog")
    .getByRole("group", { name: "应用", exact: true })
    .getByRole("option")
    .filter({ hasText: "Editor A" })
    .click();
  await button("允许一次").waitFor();
  assert(
    !(await transportEvents()).some((event) => event.method === "tools/call"),
    "new conversation app waits for its normal approval",
  );
  let openingApprovals = 0;
  await eventually(
    async () => {
      if (page.frames().some((frame) => /^areal-mcp:\/\/[^/]+\/view$/.test(frame.url())))
        return true;
      if (await button("允许一次").isVisible()) {
        assert(
          ++openingApprovals <= 2,
          "only the opening tool and fixture post hook require approval",
        );
        await button("允许一次").click();
      }
      return false;
    },
    Boolean,
    "new draft app and its post hook approved through the UI",
  );
  await appFrame();
  initialOwner = await selected();
  await setPermission("完全访问");
  const a = await openThreadPage("A", initialOwner),
    tokenA = new URL(a.url()).hostname,
    ownerA = await selected();
  const initialA = await fixture(a);
  assert.deepEqual(
    {
      text: initialA.text,
      documentRevision: initialA.documentRevision,
      undoDepth: initialA.undoDepth,
      dirty: initialA.dirty,
    },
    { text: "alpha beta\nsecond line\n", documentRevision: 0, undoDepth: 0, dirty: false },
  );
  let readyA;
  if (!baselineOnly) readyA = await registration(tokenA);
  await selectOwner(ownerA.threadId);
  const inventory = await beginCase("inventory", [], (tools) => {
    const pageTools = tools.filter((tool) => (tool.function?.name ?? "").startsWith("app_"));
    assert.equal(
      pageTools.length,
      2,
      "ordinary model inventory must contain both live Page tools; the original-main baseline has no page-tool capability",
    );
    for (const tool of pageTools) {
      assert.equal(tool.function.parameters.type, "object");
      assert.equal(tool.function.parameters.additionalProperties, false);
    }
  });
  await finishCase(inventory);
  checks.push("inventory");
  if (baselineOnly)
    assert.fail("Baseline unexpectedly has Page tools; it no longer represents missing capability");
  await setPermission("完全访问");
  const b = await openThreadPage("B", ownerA),
    tokenB = new URL(b.url()).hostname;
  assert.equal(
    await page.getByTestId("chat-input").textContent(),
    "保留正文 ",
    "slash activation consumes only its command and preserves the draft",
  );
  await page.getByTestId("chat-input").fill("");
  checks.push("entrypoints");
  const readyB = await registration(tokenB),
    initialB = await fixture(b);
  assert.notEqual(initialA.documentId, initialB.documentId);
  assert.notEqual(toolName(readyA, "applyPatch"), toolName(readyB, "applyPatch"));
  await page.getByRole("tab", { name: "Editor A", exact: true }).click();
  await inputEvidence(a, "caret-before-focus-" + (await fixture(a)).documentRevision);
  await focusOwnedWindow();
  await a.getByRole("textbox", { name: "Unsaved CodeMirror document", exact: true }).focus();
  await inputEvidence(a, "caret-before-click-" + (await fixture(a)).documentRevision);
  await a.getByRole("button", { name: "Move caret to end", exact: true }).click();
  await inputEvidence(a, "caret-before-thread-switch");
  assert.equal((await fixture(a)).head, initialA.text.length);
  await a.getByRole("button", { name: "Select first word", exact: true }).click();
  assert.equal(
    (await fixture(a)).documentRevision,
    0,
    "selection-only real transaction keeps revision",
  );
  await selectOwner(ownerA.threadId);
  await page.getByRole("tab", { name: "Editor B", exact: true }).click();
  const selection = await beginCase("selection", [
    { name: toolName(readyA, "getSelection"), arguments: {} },
  ]);
  const [selectionItem] = await finishCase(selection);
  assert.equal(selectionItem.success, true);
  assert.equal(selectionItem.execution.outcome, "succeeded");
  assert.deepEqual((await fixture(a)).calls.at(-1).reply, {
    status: "completed",
    result: {
      kind: "selection",
      documentId: initialA.documentId,
      documentRevision: 0,
      anchor: 0,
      head: 5,
      selectedText: "alpha",
      truncated: false,
      dirty: false,
    },
  });
  pageEvidence(selectionItem);
  const patch = await beginCase("target-a", [
    {
      name: toolName(readyA, "applyPatch"),
      arguments: { expectedDocumentRevision: 0, patch: { from: 0, to: 5, insert: "ALPHA" } },
    },
  ]);
  const [patched] = await finishCase(patch);
  assert.equal(patched.success, true);
  assert.equal(patched.execution.outcome, "succeeded");
  pageEvidence(patched);
  assert.equal((await fixture(a)).text, "ALPHA beta\nsecond line\n");
  assert.equal((await fixture(a)).documentRevision, 1);
  assert.deepEqual(
    await fixture(b),
    initialB,
    "named page A call leaves identical page B untouched",
  );
  checks.push("isolation");
  const beforeHidden = await fixture(a);
  await button("设置").click();
  await page.getByRole("navigation", { name: "设置导航", exact: true }).waitFor();
  assert.deepEqual(await fixture(a), beforeHidden);
  await selectOwner(ownerA.threadId);
  const hidden = await beginCase("hidden-read", [
    { name: toolName(readyA, "getSelection"), arguments: {} },
  ]);
  await finishCase(hidden);
  assert.equal((await fixture(a)).bootId, initialA.bootId);
  assert.equal((await fixture(a)).text, beforeHidden.text);
  assert.equal((await fixture(a)).undoDepth, beforeHidden.undoDepth);
  checks.push("retention");
  await createProjectConversation(page, "workspace");
  let otherOwner = await selected();
  if (!thread(await state(), otherOwner)) {
    const created = await page.evaluate((params) => window.arealDesktop.command("create", params), {
      projectId: ownerA.projectId,
    });
    assert(created.ok, JSON.stringify(created));
    await selectCreatedConversation(page, ownerA.projectId, created.value.threadId);
    otherOwner = await selected();
  }
  const other = await beginCase("other-thread", [], (tools) =>
    assert(
      !tools.some((tool) =>
        [toolName(readyA, "applyPatch"), toolName(readyB, "getSelection")].includes(
          tool.function?.name,
        ),
      ),
      "other Thread must not see A/B publication",
    ),
  );
  await finishCase(other);
  assert.notEqual(otherOwner.threadId, ownerA.threadId);
  assert.equal((await fixture(a)).text, beforeHidden.text);
  await selectOwner(ownerA.threadId);
  await showEditor("A", ownerA);
  const editor = a.getByRole("textbox", { name: "Unsaved CodeMirror document", exact: true });
  await inputEvidence(a, "caret-before-focus-" + (await fixture(a)).documentRevision);
  await focusOwnedWindow();
  await editor.focus();
  await inputEvidence(a, "caret-before-click-" + (await fixture(a)).documentRevision);
  await a.getByRole("button", { name: "Move caret to end", exact: true }).click();
  await inputEvidence(a, "caret-after-thread-restore");
  try {
    await eventually(
      () => fixture(a),
      (value) => value.head === value.text.length && value.anchor === value.head,
      "real caret moved to document end",
    );
  } catch (error) {
    const buttonRect = await a
      .locator("#end")
      .evaluate((node) => node.getBoundingClientRect().toJSON());
    const proxyRect = await a
      .parentFrame()
      .locator("#view")
      .evaluate((node) => node.getBoundingClientRect().toJSON());
    const rootRect = await page
      .locator(`[data-app-token="${tokenA}"] iframe`)
      .evaluate((node) => node.getBoundingClientRect().toJSON());
    const point = {
      x: rootRect.x + proxyRect.x + buttonRect.x + buttonRect.width / 2,
      y: rootRect.y + proxyRect.y + buttonRect.y + buttonRect.height / 2,
    };
    await writeEvidence("failed-caret-coordinates", {
      buttonRect,
      proxyRect,
      rootRect,
      point,
      locator: await a.locator("#end").boundingBox(),
    });
    await inputEvidence(a, "failed-caret-before-root-mouse");
    await page.mouse.click(point.x, point.y);
    await inputEvidence(a, "failed-caret-after-root-mouse");
    await Promise.all(
      [page.mainFrame(), a.parentFrame(), a].map((frame) =>
        frame.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        ),
      ),
    );
    await page.screenshot({
      path: join(scratch, "failed-caret-render.png"),
      animations: "disabled",
    });
    await page.mouse.click(point.x, point.y);
    await inputEvidence(a, "failed-caret-after-render-probe");
    throw error;
  }
  await editor.type("typed");
  const typed = await fixture(a);
  assert.equal(typed.text, "ALPHA beta\nsecond line\ntyped");
  assert(typed.documentRevision > 1);
  await a.getByRole("button", { name: "Select first word", exact: true }).click();
  assert.equal((await fixture(a)).documentRevision, typed.documentRevision);
  await selectOwner(ownerA.threadId);
  const competing = await beginCase("revision-competition", [
    {
      name: toolName(readyA, "applyPatch"),
      arguments: {
        expectedDocumentRevision: typed.documentRevision,
        patch: { from: 0, to: 5, insert: "winner" },
      },
    },
    {
      name: toolName(readyA, "applyPatch"),
      arguments: {
        expectedDocumentRevision: typed.documentRevision,
        patch: { from: 0, to: 5, insert: "loser" },
      },
    },
  ]);
  const competingItems = await finishCase(competing);
  assert.deepEqual(competingItems.map((item) => item.success).sort(), [false, true]);
  const competed = await fixture(a);
  assert.equal(competed.documentRevision, typed.documentRevision + 1);
  assert.match(competed.text, /^(winner|loser) beta\nsecond line\ntyped$/);
  const lastReplies = competed.calls
    .slice(-2)
    .map((call) => call.reply.result.kind)
    .sort();
  assert.deepEqual(lastReplies, ["applied", "conflict"]);
  await a.getByRole("button", { name: "Undo", exact: true }).click();
  const undone = await fixture(a);
  assert.equal(undone.text, typed.text);
  assert.equal(undone.documentRevision, competed.documentRevision + 1);
  await a.getByRole("button", { name: "Redo", exact: true }).click();
  assert.equal((await fixture(a)).text, competed.text);
  assert.equal((await fixture(a)).documentRevision, undone.documentRevision + 1);
  checks.push("revision");
  await page.screenshot({ path: join(scratch, "real-editor.png"), animations: "disabled" });

  const patchCall = (revision, insert, from = 0, to = 0) => ({
    name: toolName(readyA, "applyPatch"),
    arguments: { expectedDocumentRevision: revision, patch: { from, to, insert } },
  });
  const beforeDenied = await fixture(a);
  await setPermission("请求审批");
  const denied = await beginCase("permission-denied", [
    patchCall(beforeDenied.documentRevision, "DENIED"),
  ]);
  await button("拒绝").click();
  const [deniedItem] = await finishCase(denied, terminalStatuses);
  assert.equal(deniedItem.success, false);
  assert(["failed", "cancelled"].includes(deniedItem.execution.outcome));
  assert.deepEqual(await fixture(a), beforeDenied, "denied write never reaches iframe");
  await setPermission("完全访问");
  checks.push("permission");

  const beforeBounds = await fixture(a);
  const invalidCalls = [
    {
      ...patchCall(beforeBounds.documentRevision, "x"),
      arguments: { ...patchCall(beforeBounds.documentRevision, "x").arguments, extra: true },
    },
    patchCall(beforeBounds.documentRevision, "x".repeat(4097)),
    patchCall(beforeBounds.documentRevision, "\r"),
  ];
  for (const [index, call] of invalidCalls.entries()) {
    const invalid = await beginCase("invalid-input-" + index, [call]);
    const [item] = await finishCase(invalid, terminalStatuses);
    assert.equal(item.success, false);
    assert.deepEqual(await fixture(a), beforeBounds, "invalid bounded schema never reaches iframe");
  }
  const unicode = await beginCase("unicode-setup", [
    patchCall(beforeBounds.documentRevision, "😀"),
  ]);
  await finishCase(unicode);
  const beforeSplit = await fixture(a);
  const split = await beginCase("surrogate-split", [
    patchCall(beforeSplit.documentRevision, "x", 1, 1),
  ]);
  const [splitItem] = await finishCase(split);
  assert.equal(splitItem.success, false);
  const afterSplit = await fixture(a);
  assert.deepEqual(editorState(afterSplit), editorState(beforeSplit));
  assert.equal(afterSplit.calls.at(-1).reply.result.reason, "invalidRange");
  await showEditor("A", ownerA);
  await a.locator("#fault").selectOption("oversizedReply");
  await selectOwner(ownerA.threadId);
  const beforeOversizedReply = await fixture(a);
  const oversizedReply = await beginCase("oversized-guest-reply", [
    { name: toolName(readyA, "getSelection"), arguments: {} },
  ]);
  const [oversizedItem] = await finishCase(oversizedReply, terminalStatuses);
  assert.equal(oversizedItem.success, false);
  assert.equal(oversizedItem.execution.outcome, "unknown");
  assert.deepEqual(editorState(await fixture(a)), editorState(beforeOversizedReply));
  assert(
    !JSON.stringify(oversizedItem).includes("x".repeat(4097)),
    "oversized guest data never enters saved model result",
  );
  await showEditor("A", ownerA);
  await a.locator("#fault").selectOption("normal");
  await selectOwner(ownerA.threadId);
  await inspectUnknown(
    oversizedItem,
    "Inspected live CodeMirror text, revision and history: oversized selection reply made no editor change. Original result remains UNKNOWN.",
  );
  checks.push("bounds");

  for (const [mode, check] of [
    ["beforeClaim", "cancel-no-effect"],
    ["afterClaim", "cancel-claimed"],
  ]) {
    const before = await fixture(a);
    await setFault(mode);
    const plan = await beginCase("cancel-" + mode, [
      patchCall(before.documentRevision, "MUST_NOT_APPLY"),
    ]);
    const fault = await waitFault();
    if (mode === "afterClaim") assert.equal(fault.reply.status, "granted");
    await stopTurn();
    if (mode === "afterClaim")
      await eventually(
        () => app.evaluate(() => global.pageToolNotices),
        (values) =>
          values.some(
            (value) =>
              value.method?.endsWith("/cancelled") && value.params?.callId === plan.calls[0].id,
          ),
        "real Core cancellation reached original Main",
      );
    else await finishCase(plan, terminalStatuses);
    await releaseFault();
    if (mode === "beforeClaim")
      await eventually(
        transportRequests,
        (values) =>
          values.some(
            (value) =>
              value.params.operation === "claim" &&
              value.params.callId === plan.calls[0].id &&
              value.reply?.status === "notGranted",
          ),
        "held claim receives authoritative notGranted after cancellation",
      );
    const [item] = await finishCase(plan, terminalStatuses);
    assert.equal(item.execution.outcome, "cancelled");
    assert.equal(item.success, false);
    assert.deepEqual(await fixture(a), before, "cancelled before iframe delivery cannot mutate");
    pageEvidence(item);
    await writeEvidence("fault-" + mode, { fault, item, before, after: await fixture(a) });
    checks.push(check);
  }

  await showEditor("A", ownerA);
  await a.locator("#fault").selectOption("beforeEdit");
  await selectOwner(ownerA.threadId);
  const beforeGuestCancel = await fixture(a);
  const guestCancel = await beginCase("cancel-before-editor", [
    patchCall(beforeGuestCancel.documentRevision, "NO_EFFECT"),
  ]);
  await eventually(
    () => fixture(a),
    (value) => value.calls.at(-1)?.waiting === "beforeEdit",
    "real guest paused before transaction",
  );
  await stopTurn();
  const [guestCancelled] = await finishCase(guestCancel, terminalStatuses);
  assert.equal(
    guestCancelled.execution.outcome,
    "unknown",
    "SDK abort is not authoritative proof of no effect after claim",
  );
  assert.equal((await recordedResolve(guestCancel.calls[0].id)).params.reply.status, "unknown");
  assert.deepEqual(editorState(await fixture(a)), editorState(beforeGuestCancel));
  assert.equal((await fixture(a)).calls.at(-1).reply.status, "noEffect");
  await inspectUnknown(
    guestCancelled,
    "Inspected live editor text, revision and history unchanged. Guest reports noEffect after SDK abort; original Core result remains UNKNOWN.",
  );

  await showEditor("A", ownerA);
  await a.locator("#fault").selectOption("afterEdit");
  await selectOwner(ownerA.threadId);
  const beforeUnknown = await fixture(a);
  const unknown = await beginCase("edit-result-unknown", [
    patchCall(beforeUnknown.documentRevision, "ONCE_"),
  ]);
  await eventually(
    () => fixture(a),
    (value) => value.calls.at(-1)?.waiting === "afterEdit",
    "real transaction happened before response",
  );
  const editedBeforeCancel = await fixture(a);
  assert.equal(editedBeforeCancel.documentRevision, beforeUnknown.documentRevision + 1);
  assert.equal(editedBeforeCancel.text, "ONCE_" + beforeUnknown.text);
  await stopTurn();
  const [unknownItem] = await finishCase(unknown, terminalStatuses);
  assert.equal(unknownItem.execution.outcome, "unknown");
  pageEvidence(unknownItem);
  assert.deepEqual(editorState(await fixture(a)), editorState(editedBeforeCancel));
  const appliedCount = (await fixture(a)).calls.filter((call) => call.applied).length;
  await showEditor("A", ownerA);
  await a.locator("#fault").selectOption("normal");
  await selectOwner(ownerA.threadId);
  await inspectUnknown(
    unknownItem,
    "Inspected live editor: exactly one ONCE_ insertion and one revision increment retained after cancellation. Original result remains UNKNOWN; do not replay.",
  );
  await finishCase(await beginCase("unknown-no-replay"));
  assert.equal((await fixture(a)).calls.filter((call) => call.applied).length, appliedCount);
  checks.push("cancel-unknown");

  await setFault("afterResolve");
  const beforeAck = await fixture(a);
  const lostAck = await beginCase("durable-result-lost-ack", [
    patchCall(beforeAck.documentRevision, "ACK_"),
  ]);
  const ackFault = await waitFault();
  assert(ackFault.reply, "Core returned a durable receipt before fault");
  const [ackItem] = await finishCase(lostAck);
  assert.equal(ackItem.execution.outcome, "succeeded");
  pageEvidence(ackItem);
  const afterAck = await fixture(a);
  assert.equal(afterAck.text, "ACK_" + beforeAck.text);
  assert.equal(afterAck.documentRevision, beforeAck.documentRevision + 1);
  await releaseFault();
  const terminal = await recordedResolve(lostAck.calls[0].id);
  const retry = await originalRequest(terminal.params);
  assert.deepEqual(retry, { value: terminal.reply });
  const conflict = await originalRequest({ ...terminal.params, reply: { status: "unknown" } });
  assert(conflict.error, "conflicting terminal receipt must fail");
  assert.deepEqual(await fixture(a), afterAck, "terminal retries never execute editor again");
  assert.deepEqual(
    (await finishCase(lostAck))[0],
    ackItem,
    "ordinary finalization preserves terminal",
  );
  checks.push("durable-ack", "terminal-receipt");

  const registerRequest = (await transportRequests()).find(
    (record) =>
      record.params.operation === "register" &&
      record.reply?.registrationId === readyA.reply.registrationId,
  ).params;
  const stale = [];
  for (const request of [
    {
      ...terminal.params,
      operation: "claim",
      claimId: undefined,
      reply: undefined,
      schemaDigest: "0".repeat(64),
    },
    { ...registerRequest, generation: Number(registerRequest.generation) + 1 },
    {
      ...registerRequest,
      declaration: { ...registerRequest.declaration, documentId: "another-document" },
    },
    {
      ...registerRequest,
      declaration: { ...registerRequest.declaration, schema: { type: "object" } },
    },
    {
      ...registerRequest,
      declaration: { ...registerRequest.declaration, documentId: "x".repeat(2048) },
    },
  ]) {
    for (const key of Object.keys(request)) if (request[key] === undefined) delete request[key];
    const result = await originalRequest(request);
    assert(result.error);
    stale.push({ request, result });
  }
  assert.deepEqual(await fixture(a), afterAck);
  await writeEvidence("stale-binding", stale);
  checks.push("stale-binding");

  const { ServiceConnection } = require("../app/src/core/service-client.cjs");
  const metadata = JSON.parse(await readFile(join(isolated, "core/service.json"), "utf8"));
  const sibling = new ServiceConnection();
  const socketProof = [];
  try {
    await sibling.connect(metadata);
    await sibling.request("hello", { protocol: metadata.protocol, identity: metadata.identity });
    for (const request of [
      registerRequest,
      { ...terminal.params, operation: "claim" },
      terminal.params,
    ]) {
      const params = { ...request };
      if (params.operation === "claim") {
        delete params.claimId;
        delete params.reply;
      }
      await assert.rejects(sibling.request("mcpPageTools", params, true), /owner lease is stale/);
      socketProof.push({
        boundary: "real sibling Desktop socket",
        operation: params.operation,
        rejected: true,
      });
    }
  } finally {
    sibling.close();
  }
  const descriptors = JSON.parse(
    execFileSync(coreBinary, ["service", "list", "--json"], { env, encoding: "utf8" }),
  );
  const descriptor = descriptors.find(
    (value) => value.workspace === workspace && value.state === "ready",
  );
  assert(
    descriptor?.authFile && descriptor.endpoint,
    "owned Core descriptor supplies authenticated sibling socket",
  );
  const auth = JSON.parse(await readFile(descriptor.authFile, "utf8")).principals[0].token;
  const { CoreClient } = await import("../packages/runtime-client/core.js");
  const WebSocket = require("ws");
  const coreSibling = new CoreClient({
    createSocket: () =>
      new WebSocket(descriptor.endpoint, { headers: { Authorization: `Bearer ${auth}` } }),
  });
  try {
    await coreSibling.connect();
    const { projectId: _projectId, operation: _operation, ...registrationParams } = registerRequest;
    registrationParams.ownerId = terminal.params.ownerId;
    const coordinates = Object.fromEntries(
      ["threadId", "turnId", "callId", "registrationId", "ownerId", "schemaDigest"].map((key) => [
        key,
        terminal.params[key],
      ]),
    );
    for (const [operation, params] of [
      ["register", registrationParams],
      ["claim", coordinates],
      [
        "resolve",
        { ...coordinates, claimId: terminal.params.claimId, reply: terminal.params.reply },
      ],
    ]) {
      let result;
      try {
        result = { reply: await coreSibling.request("areal/mcp/app/tools/" + operation, params) };
      } catch (error) {
        result = { error: error.message, code: error.code };
      }
      socketProof.push({
        boundary: "real authenticated sibling Core socket",
        operation,
        phase: "terminal",
        result,
      });
      if (operation === "claim") assert.equal(result.reply?.status, "notGranted");
      else assert(result.error, JSON.stringify(result));
    }
    await setFault("beforeClaim");
    const live = await beginCase("sibling-live-claim", [
      { name: toolName(readyA, "getSelection"), arguments: {} },
    ]);
    const liveFault = await waitFault();
    const liveCoordinates = Object.fromEntries(
      ["threadId", "turnId", "callId", "registrationId", "ownerId", "schemaDigest"].map((key) => [
        key,
        liveFault.request[key],
      ]),
    );
    await assert.rejects(
      coreSibling.request("areal/mcp/app/tools/claim", liveCoordinates),
      /owner or coordinates mismatch/,
    );
    socketProof.push({
      boundary: "real authenticated sibling Core socket",
      operation: "claim",
      phase: "live",
      coordinates: liveCoordinates,
      rejected: true,
    });
    await releaseFault();
    const [liveItem] = await finishCase(live);
    assert.equal(liveItem.success, true);
  } finally {
    coreSibling.close();
  }
  assert.deepEqual(editorState(await fixture(a)), editorState(afterAck));
  await writeEvidence("socket-owner", socketProof);
  checks.push("socket-owner");

  for (const mode of ["failure", "hold"]) {
    await writeFile(hookMode, mode);
    const before = await fixture(a);
    const plan = await beginCase("post-hook-" + mode, [
      patchCall(before.documentRevision, "HOOK_" + mode + "_"),
    ]);
    const resolve = await recordedResolve(plan.calls[0].id);
    await eventually(
      async () => {
        try {
          return (await readFile(hookEvents, "utf8")).trim().split("\n").map(JSON.parse);
        } catch (error) {
          if (error.code === "ENOENT") return [];
          throw error;
        }
      },
      (values) => values.some((value) => value.mode === mode),
      "real post hook entered",
    );
    if (mode === "hold") await stopTurn();
    const [item] = await finishCase(plan, terminalStatuses);
    assert.equal(item.success, true);
    assert.equal(item.execution.outcome, "succeeded");
    pageEvidence(item);
    assert.equal((await fixture(a)).text, "HOOK_" + mode + "_" + before.text);
    assert.deepEqual(await originalRequest(resolve.params), { value: resolve.reply });
    if (item.execution.hooks?.some((hook) => hook.outcome === "unknown"))
      await inspectUnknown(
        item,
        "Inspected live editor: accepted page transaction exists once; post-hook cancellation did not replay it. Hook result remains UNKNOWN.",
      );
  }
  await writeFile(hookMode, "normal");
  const afterHooks = await fixture(a);
  await finishCase(await beginCase("post-hook-inspected-continuation"));
  assert.deepEqual(
    await fixture(a),
    afterHooks,
    "explicit ordinary continuation does not replay accepted transaction or hook",
  );
  await button("任务操作").click();
  await page.getByRole("menuitem", { name: "队列", exact: true }).click();
  if (await button("继续队列").isVisible()) await button("继续队列").click();
  await button("暂停队列").waitFor();
  await eventually(
    state,
    (value) =>
      value.projects.find((project) => project.id === ownerA.projectId)?.state?.queues?.[
        ownerA.threadId
      ]?.paused === false,
    "live queue projection confirms resumed before opening another App",
  );
  checks.push("post-hooks");

  const retained = [
    { label: "A", token: tokenA, frame: a, state: await fixture(a) },
    { label: "B", token: tokenB, frame: b, state: await fixture(b) },
  ];
  for (const label of ["C", "D", "E", "F", "G", "H"]) {
    const frame = await openThreadPage(label, ownerA),
      token = new URL(frame.url()).hostname;
    await registration(token);
    retained.push({ label, token, frame, state: await fixture(frame) });
  }
  await chooseThreadApp("I", ownerA);
  await page
    .getByText("最多可同时打开 8 个应用页面，请先关闭一个页面。", { exact: true })
    .waitFor();
  assert(
    !(await transportEvents()).some(
      (event) => event.method === "tools/call" && event.params.name === "fixture.pageI",
    ),
    "ninth rejected page never reaches static opening tool",
  );
  assert.equal(
    page.frames().filter((frame) => /^areal-mcp:\/\/[^/]+\/view$/.test(frame.url())).length,
    8,
  );
  for (const entry of retained) assert.deepEqual(await fixture(entry.frame), entry.state);
  checks.push("capacity");

  await showEditor("A", ownerA);
  await page
    .getByRole("region", { name: "MCP 应用", exact: true })
    .getByRole("button", { name: "关闭应用", exact: true })
    .click();
  await page.waitForFunction(
    (token) => !document.querySelector(`[data-app-token="${token}"]`),
    tokenA,
  );
  const oldToken = await page.evaluate(async (token) => {
    try {
      await window.arealDesktop.mcpApp({
        operation: "request",
        token,
        request: { jsonrpc: "2.0", id: "closed-token", method: "tools/list" },
      });
      return { accepted: true };
    } catch (error) {
      return { error: error.message };
    }
  }, tokenA);
  assert(oldToken.error);
  await selectOwner(ownerA.threadId);
  await finishCase(
    await beginCase("closed-inventory", [], (tools) =>
      assert(
        !tools.some((tool) => readyA.reply.tools.some((old) => old.name === tool.function?.name)),
      ),
    ),
  );
  const reopened = await openThreadPage("A", ownerA),
    reopenedToken = new URL(reopened.url()).hostname;
  const reopenedReady = await registration(reopenedToken);
  assert.notEqual(reopenedToken, tokenA);
  assert.notEqual((await fixture(reopened)).bootId, initialA.bootId);
  assert.notEqual(reopenedReady.reply.registrationId, readyA.reply.registrationId);
  const catalogBeforeRestart = await manage(ownerA, "mcpApps");
  const beforePackage = await fixture(reopened);
  await selectOwner(ownerA.threadId);
  await setFault("beforeClaim");
  const stalePackage = await beginCase("frozen-package-replaced", [
    {
      name: toolName(reopenedReady, "applyPatch"),
      arguments: {
        expectedDocumentRevision: beforePackage.documentRevision,
        patch: { from: 0, to: 0, insert: "STALE_PACKAGE" },
      },
    },
  ]);
  const packageFault = await waitFault();
  const originalPlugin = await manage(ownerA, "plugin", { id: "editor@page-tools-market" });
  await appendFile(join(source, "app.html"), "\n<!-- replacement package -->");
  const replacementPlugin = await manage(ownerA, "plugin", { id: "editor@page-tools-market" });
  assert.notEqual(replacementPlugin.sourceDigest, originalPlugin.installedDigest);
  const installedReplacement = await manage(ownerA, "pluginInstall", {
    id: replacementPlugin.id,
    scope: "user",
    expectedRevision: replacementPlugin.revision,
    source: replacementPlugin.source,
    expectedDigest: replacementPlugin.sourceDigest,
    requestId: randomUUID(),
  });
  const pluginAfterInstall = await manage(ownerA, "plugin", { id: replacementPlugin.id });
  const appsAfterInstall = await manage(ownerA, "mcpApps");
  await writeEvidence("package-before-claim-release", {
    originalPlugin,
    replacementPlugin,
    installedReplacement,
    pluginAfterInstall,
    appsAfterInstall,
    packageFault,
    editor: await fixture(reopened),
  });
  assert.equal(
    pluginAfterInstall.installedDigest,
    replacementPlugin.sourceDigest,
    "package replacement was durably installed before held claim release",
  );
  await releaseFault();
  const [packageItem] = await finishCase(stalePackage, terminalStatuses);
  assert.equal(packageItem.success, false);
  assert.equal(packageItem.execution.outcome, "cancelled");
  pageEvidence(packageItem);
  assert.equal(
    packageItem.execution.page.dispatch.claimId,
    null,
    "revoked package has no execution grant",
  );
  assert.equal(packageItem.execution.page.binding.pluginDigest, originalPlugin.installedDigest);
  const packageEditorAfter = reopened.isDetached() ? null : await fixture(reopened);
  if (packageEditorAfter)
    assert.deepEqual(
      packageEditorAfter,
      beforePackage,
      "replacement retires execution without editing the retained unsaved page",
    );
  const reopenedRegistration = (await transportRequests()).find(
    (record) =>
      record.params.operation === "register" &&
      record.reply?.registrationId === reopenedReady.reply.registrationId,
  );
  const reopenedRegister = reopenedRegistration.params;
  const retiredReplay = await originalRequest(reopenedRegister);
  if (!retiredReplay.error)
    assert.deepEqual(
      retiredReplay.value,
      reopenedRegistration.reply,
      "same-declaration retry may return only its cached registration receipt",
    );
  const retiredClaim = await originalRequest(packageFault.request);
  assert(
    retiredClaim.error || retiredClaim.value?.status === "notGranted",
    "cached registration receipt cannot restore first-claim authority",
  );
  await finishCase(
    await beginCase("replaced-package-inventory", [], (tools) =>
      assert(
        !tools.some((tool) => (tool.function?.name ?? "").startsWith("app_")),
        "replacement withdraws every old Page publication",
      ),
    ),
  );
  await writeEvidence("package-replacement", {
    oldDigest: originalPlugin.installedDigest,
    newDigest: replacementPlugin.sourceDigest,
    packageFault,
    item: packageItem,
    retiredReplay,
    retiredClaim,
    editor: packageEditorAfter,
  });
  const retiredPageCleanup = [];
  for (const entry of [
    { label: "A", token: reopenedToken, frame: reopened, state: beforePackage },
    ...retained.slice(1),
  ]) {
    if (entry.frame.isDetached()) {
      retiredPageCleanup.push({ token: entry.token, alreadyClosed: true });
      continue;
    }
    let retainedState;
    try {
      retainedState = await fixture(entry.frame);
    } catch (error) {
      if (!entry.frame.isDetached()) throw error;
      retiredPageCleanup.push({ token: entry.token, alreadyClosed: true });
      continue;
    }
    assert.deepEqual(retainedState, entry.state, "retained old package page keeps unsaved state");
    const closed = await page.evaluate(async (token) => {
      try {
        return { reply: await window.arealDesktop.mcpApp({ operation: "close", token }) };
      } catch (error) {
        return { error: error.message };
      }
    }, entry.token);
    if (closed.error)
      assert(
        entry.frame.isDetached() ||
          !(await page.locator(`[data-app-token="${entry.token}"]`).count()),
        "only an already closed page may reject fixture cleanup",
      );
    await page.waitForFunction(
      (token) => !document.querySelector(`[data-app-token="${token}"]`),
      entry.token,
    );
    retiredPageCleanup.push({ token: entry.token, ...closed });
  }
  await writeEvidence("retired-page-cleanup", retiredPageCleanup);
  await settings();
  await button("返回插件列表").click();
  await button("刷新市场").click();
  await eventually(
    () => button("刷新市场").isEnabled(),
    Boolean,
    "normal marketplace refresh completed",
  );
  const capacityError = page
    .getByText("workgroup execution/wait capacity reached; control slots are reserved", {
      exact: true,
    })
    .filter({ visible: true });
  if (await capacityError.count()) {
    const before = {
      body: await page.locator("body").innerText(),
      requests: await transportRequests(),
    };
    await eventually(
      transportRequests,
      (requests) =>
        requests
          .filter((record) => record.params.operation === "revoke")
          .every((record) => record.finishedAt),
      "owned page revocation requests settled before explicit refresh",
    );
    await button("刷新市场").click();
    await eventually(
      () => button("刷新市场").isEnabled(),
      Boolean,
      "one explicit marketplace recovery completed",
    );
    await eventually(
      () => capacityError.count(),
      (count) => count === 0,
      "visible catalog capacity error cleared after one refresh",
    );
    await writeEvidence("catalog-refresh-recovery", {
      before,
      after: { body: await page.locator("body").innerText(), requests: await transportRequests() },
    });
  }
  await settings();
  await writeEvidence("replacement-connection-after-refresh", await manage(ownerA, "pluginMcp"));
  if (await button("断开并撤销信任").isVisible()) await button("断开并撤销信任").click();
  await button("审阅并连接").click();
  await page
    .getByRole("checkbox", { name: "我信任当前安装快照，并允许启动其 MCP 服务。", exact: true })
    .check();
  await button("信任并连接").click();
  const freshPackagePage = await openThreadPage("A", ownerA);
  await registration(new URL(freshPackagePage.url()).hostname);
  await settings();
  await button("管理启用范围").click();
  await button("在用户范围停用").click();
  await page.waitForFunction(
    () => document.querySelectorAll('iframe[src^="areal-mcp:"]').length === 0,
  );
  await selectOwner(ownerA.threadId);
  await finishCase(
    await beginCase("revoked-inventory", [], (tools) =>
      assert(!tools.some((tool) => (tool.function?.name ?? "").startsWith("app_"))),
    ),
  );
  checks.push("close-revoke");

  const historyBeforeRestart = thread(await state(), ownerA);
  const stableIds = [unknown.calls[0].id, lostAck.calls[0].id];
  const stable = (value) =>
    value.turns.flatMap((turn) => turn.items).filter((item) => stableIds.includes(item.callId));
  const stableBefore = stable(historyBeforeRestart),
    requestsBeforeRestart = requests.length;
  await writeEvidence("history-before-restart", historyBeforeRestart);
  await writeEvidence("transport-boundaries-before-restart", {
    requests: await transportRequests(),
    notices: await app.evaluate(() => global.pageToolNotices),
    receipts: await app.evaluate(() => global.pageToolsReceipts),
  });
  const initialPid = appProcess.pid;
  await app.close();
  await assertApplicationStopped(coreBinary, env, metadata);
  app = await electron.launch({
    executablePath: require("electron"),
    args: [fixtureApp],
    env,
    timeout: 120000,
  });
  appProcess = app.process();
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await eventually(
    state,
    (snapshot) => snapshot.connection?.state === "ready",
    "restarted Desktop ready",
  );
  await writeEvidence("restart-identities", {
    initialPid,
    restartedPid: appProcess.pid,
    desktopBefore: metadata,
    desktopAfter: JSON.parse(await readFile(join(isolated, "core/service.json"), "utf8")),
  });
  await selectOwner(ownerA.threadId);
  const historyAfterRestart = await eventually(
    state,
    (snapshot) => thread(snapshot, ownerA)?.turns?.length >= historyBeforeRestart.turns.length,
    "authoritative history restored",
  );
  assert.deepEqual(stable(thread(historyAfterRestart, ownerA)), stableBefore);
  assert.equal(
    requests.length,
    requestsBeforeRestart,
    "restart performs no model or page tool replay",
  );
  await writeEvidence("history-after-restart", thread(historyAfterRestart, ownerA));
  const catalogAfterRestart = await manage(ownerA, "mcpApps");
  assert.notEqual(
    catalogAfterRestart.requestEpoch,
    catalogBeforeRestart.requestEpoch,
    "real Core restart changes apps epoch",
  );
  await finishCase(
    await beginCase("restarted-inventory", [], (tools) =>
      assert(!tools.some((tool) => (tool.function?.name ?? "").startsWith("app_"))),
    ),
  );
  await writeEvidence("real-apps-epoch", {
    before: catalogBeforeRestart.requestEpoch,
    after: catalogAfterRestart.requestEpoch,
  });
  checks.push("restart", "source-epoch");

  await writeFile(
    join(scratch, "editor-identities.json"),
    JSON.stringify(
      { ownerA, tokenA, tokenB, readyA, readyB, initialA, initialB, typed, competed, undone },
      null,
      2,
    ),
  );
  await page.screenshot({ path: join(scratch, "restarted-history.png"), animations: "disabled" });
  const staticEvents = await transportEvents();
  assert(
    staticEvents
      .filter((event) => event.method === "tools/call")
      .every((event) => /^fixture\.page[A-I]$/.test(event.params.name)),
    "static MCP fixture never reads or mutates live editor",
  );
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  failure = { message: error.message, stack: error.stack };
  process.exitCode = 1;
  console.error(error);
  if (page) {
    await captureSmokeFailure(page, scratch, error);
    await writeFile(
      join(scratch, "failure-snapshot.json"),
      JSON.stringify(await state().catch(() => null), null, 2),
    );
  }
} finally {
  const cleanup = {};
  let metadata;
  try {
    metadata = JSON.parse(await readFile(join(isolated, "core/service.json"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") errors.push("cleanup identity " + error.message);
  }
  if (app) {
    try {
      await writeEvidence("transport-boundaries", {
        requests: await transportRequests(),
        notices: await app.evaluate(() => global.pageToolNotices),
        receipts: await app.evaluate(() => global.pageToolsReceipts),
      });
    } catch {}
    try {
      if (await button("拒绝").isVisible()) await button("拒绝").click();
      if (await button("暂停执行").isVisible()) await stopTurn();
    } catch {}
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
      assert.equal(appProcess.exitCode, 0);
      assert.equal(appProcess.signalCode, null);
      cleanup.electronExited = true;
    } catch (error) {
      errors.push("close GUI " + error.message);
    } finally {
      clearTimeout(quitTimer);
    }
  }
  if (metadata) {
    try {
      await assertApplicationStopped(coreBinary, env, metadata);
      cleanup.applicationStopped = true;
    } catch (error) {
      errors.push("verify application cleanup " + error.message);
    }
  }
  if (metadata && !cleanup.applicationStopped) {
    cleanup.assistedServiceStop = true;
    const {
        ServiceConnection,
        waitForServiceProcessExit,
      } = require("../app/src/core/service-client.cjs"),
      connection = new ServiceConnection();
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
      await waitForServiceProcessExit(join(isolated, "core"), metadata);
      cleanup.desktopExited = true;
    } catch (error) {
      if (!["ENOENT", "ECONNREFUSED", "ESRCH"].includes(error.code))
        errors.push("fallback stop service " + error.message);
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
    errors.push("uncaught Main " + error.origin + " " + error.message);
  try {
    cleanup.instances = JSON.parse(
      execFileSync(coreBinary, ["service", "list", "--json"], { env, encoding: "utf8" }),
    );
    assert(
      cleanup.instances.every((instance) => instance.state === "stopped"),
      "owned Core instance remains live",
    );
    cleanup.coreStopped = true;
  } catch (error) {
    errors.push("verify owned Core cleanup " + error.message);
  }
  try {
    await writeFile(join(scratch, "hook-events.jsonl"), await readFile(hookEvents));
  } catch (error) {
    if (error.code !== "ENOENT") errors.push("hook evidence " + error.message);
  }
  if (
    cleanup.coreStopped &&
    cleanup.applicationStopped &&
    cleanup.electronExited &&
    !cleanup.forcedElectronExit
  ) {
    try {
      await writableDirectories(isolated);
      await rm(isolated, { recursive: true, force: true });
      cleanup.isolatedRemoved = true;
    } catch (error) {
      errors.push("remove owned isolation " + error.message);
    }
  }
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  if (errors.length) {
    passed = false;
    process.exitCode = 1;
  }
  const remaining = contracts.filter(([name]) => !checks.includes(name)).map(([name]) => name);
  if (passed && remaining.length) {
    passed = false;
    process.exitCode = 1;
    failure = { message: "Required contract scenarios have not run: " + remaining.join(", ") };
  }
  const manifest = {
    passed,
    baselineOnly,
    checks,
    remaining,
    failure,
    errors,
    mainErrors,
    scratch,
    isolated,
    cleanup,
    source: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: sourceRoot,
      encoding: "utf8",
    }).trim(),
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
    editor: { versions: bundle.versions, inlineResourceBytes: bundle.bytes },
    modelRequests: requests.length,
    transportEvents: await transportEvents(),
    scope:
      "Real source Electron, Desktop, Core, ordinary local model tool inventory and calls, source-bound iframe and pinned CodeMirror. Native chooser and deterministic local model are fixture boundaries.",
    gaps: [
      "No real provider or packaged acceptance",
      "Ordinary generation awaits each tool serially (generation.rs); active-call concurrency limits require separate Core admission tests",
      ...remaining.map((name) => "Not yet executed " + name),
    ],
  };
  await writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log("Evidence: " + scratch);
  console.log(
    JSON.stringify(
      { passed, baselineOnly, checks, remaining, failure, errors, cleanup, core: manifest.core },
      null,
      2,
    ),
  );
}
