import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { captureSmokeFailure, createProjectConversation, selectConversation } from "./smoke-navigation.mjs";
import { assertApplicationStopped, closeSmokeApplication } from "./application-cleanup.mjs";
import { respondToSessionName } from "./model-fixture.mjs";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const { ServiceConnection, waitForServiceExit } = require("../app/src/core/service-client.cjs");
const scratch = await mkdtemp("/private/tmp/areal-plugin-concepts-");
const workspace = join(scratch, "workspace");
const userHome = join(scratch, "user");
const source = join(workspace, "packages/concepts");
const transportLog = join(scratch, "mcp.jsonl");
const fixture = {
  pluginId: "concepts@concept-market",
  pluginName: "Concept Plugin",
  skillId: "shared-concept",
  skillName: "Shared Concept",
  packageServer: "concept-package",
  standaloneServer: "concept-standalone",
  archiveName: "archive-concepts",
  archiveDisplayName: "Archive Concept Plugin",
  creatorId: "openai-skill-creator",
};
const validArchive = join(scratch, "concepts.zip");
const invalidArchive = join(scratch, "traversal.zip");
const archiveRejections = [
  { name: "duplicate", message: /duplicate ZIP entries/ },
  { name: "symlink", message: /ZIP links and special files are prohibited/ },
  { name: "manifest", message: /name missing|manifest/i },
];
const standaloneSkill = "---\nname: Shared Concept\ndescription: Standalone project instructions.\n---\nSTANDALONE_CONCEPT_BODY\n";
const checks = [];
const errors = [];
const requests = [];
const instances = [];
const auxiliaryRequests = [];
const creatorOnly = process.argv.includes("--creator-only");
assert.ok(process.argv.slice(2).every(arg => arg === "--creator-only"), "Usage: plugin-concepts-smoke.mjs [--creator-only]");
const creatorWorkspace = creatorOnly ? workspace : join(scratch, "creator-workspace");
const archiveEvidence = {};
let appEvidence;
let creatorEvidence;
const sha = value => createHash("sha256").update(value).digest("hex");
const json = (path, value) => writeFile(path, JSON.stringify(value, null, 2));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
console.log(`Evidence: ${scratch}`);

for (const path of [join(workspace, ".agents/plugins"), join(workspace, ".agents/skills", fixture.skillId),
  join(source, "skills", fixture.skillId), join(userHome, ".areal")]) await mkdir(path, { recursive: true });
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
await writeFile(join(workspace, ".agents/skills", fixture.skillId, "SKILL.md"), standaloneSkill);
for (const [base, prefix, label] of [[userHome, "personal", "Personal"], [workspace, "project", "Project"]]) {
  for (let index = 1; index <= 8; index++) {
    const number = String(index).padStart(2, "0");
    const directory = join(base, ".agents/skills", `${prefix}-preview-${number}`);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), `---\nname: ${label} Preview ${number}\ndescription: ${label} scoped preview fixture ${number}.\n---\n${prefix.toUpperCase()}_PREVIEW_BODY_${number}\n`);
  }
}
await json(join(source, "plugin.json"), {
  $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  name: "concepts", version: "1.0.0", description: "Owner-aware resource acceptance fixture.",
  extensions: { "com.openai": { interface: { displayName: fixture.pluginName } } },
});
await writeFile(join(source, "skills", fixture.skillId, "SKILL.md"),
  "---\nname: Shared Concept\ndescription: Package-owned instructions.\n---\nPACKAGE_CONCEPT_BODY\n");
await json(join(workspace, ".agents/plugins/marketplace.json"), {
  name: "concept-market",
  plugins: [{ name: "concepts", source: { source: "local", path: "./packages/concepts" },
    policy: { installation: "AVAILABLE", authentication: "ON_USE" }, category: "Productivity" }],
});
await writeFile(join(source, "app.html"), `<!doctype html><html><body>
<h1>Concept App</h1><output id="ready">waiting</output><button id="echo">Echo literal</button><output id="result"></output>
<script>
let sequence=0;const pending=new Map();
function call(method,params){return new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});parent.postMessage({jsonrpc:'2.0',id,method,params},'*');});}
addEventListener('message',event=>{if(event.source!==parent)return;const message=event.data;if(message.jsonrpc!=='2.0')return;const request=pending.get(message.id);if(request){pending.delete(message.id);message.error?request.reject(Error(message.error.message)):request.resolve(message.result);}});
call('ui/initialize',{appInfo:{name:'concept-app',version:'1'},protocolVersion:'2026-01-26',appCapabilities:{availableDisplayModes:['inline']}}).then(()=>{parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized'},'*');document.getElementById('ready').textContent='initialized';});
document.getElementById('echo').onclick=async()=>{try{const result=await call('tools/call',{name:'concept.echo',arguments:{value:'CONCEPT_LITERAL'}});document.getElementById('result').textContent=JSON.stringify(result);}catch(error){document.getElementById('result').textContent='ERROR: '+error.message;}};
</script></body></html>`);
await writeFile(join(source, "server.mjs"), String.raw`import {createInterface} from 'node:readline';
import {appendFileSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const owner=process.argv[2],path=process.argv[3];
const log=value=>appendFileSync(path,JSON.stringify({owner,...value})+'\n');
log({event:'started',pid:process.pid});
const tools=[{name:'concept.echo',description:'Echo the supplied literal.',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']},annotations:{readOnlyHint:true},...(owner==='package'?{_meta:{ui:{visibility:['app','model']}}}:{})}];
if(owner==='package')tools.unshift({name:'concept.open',title:'Concept App',description:'Open the local acceptance app.',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true},_meta:{ui:{resourceUri:'ui://concept/app',visibility:['model']},'openai/ui':{entrypoints:[{type:'global'},{type:'thread'}]}}});
for await(const line of createInterface({input:process.stdin})){let request;try{request=JSON.parse(line);log({event:'request',method:request.method,params:request.params});if(request.id===undefined)continue;let result;
switch(request.method){case'initialize':result={protocolVersion:request.params.protocolVersion,serverInfo:{name:'concept-'+owner,version:'1'},capabilities:{tools:{},...(owner==='package'?{resources:{},extensions:{'io.modelcontextprotocol/ui':{}}}:{})}};break;
case'ping':result={};break;case'tools/list':result={tools};break;
case'resources/list':result={resources:owner==='package'?[{uri:'ui://concept/app',name:'Concept App',mimeType:'text/html;profile=mcp-app'}]:[]};break;
case'resources/templates/list':result={resourceTemplates:[]};break;
case'resources/read':if(request.params.uri!=='ui://concept/app')throw Error('unknown resource');result={contents:[{uri:'ui://concept/app',mimeType:'text/html;profile=mcp-app',text:readFileSync(fileURLToPath(new URL('./app.html',import.meta.url)),'utf8'),_meta:{ui:{csp:{connectDomains:[],resourceDomains:[]}},'openai/ui':{availableDisplayModes:['inline']}}}]};break;
case'tools/call':if(request.params.name==='concept.open')result={content:[{type:'text',text:'CONCEPT_APP_OPENED'}]};else if(request.params.name==='concept.echo')result={content:[{type:'text',text:'ECHO_'+request.params.arguments.value}]};else throw Error('unknown tool');break;
default:throw Error('unsupported method');}
log({event:'response',method:request.method,result});process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
}catch(error){if(request?.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:error.message}})+'\n');}}
`);
await json(join(source, "mcp.json"), {
  $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  mcpServers: { [fixture.packageServer]: { type: "stdio", command: "node",
    args: ["${PLUGIN_ROOT}/server.mjs", "package", transportLog] } },
});
execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
execFileSync("git", ["-c", "user.name=Plugin Fixture", "-c", "user.email=plugin-fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Add plugin acceptance fixture"], { cwd: workspace, stdio: "ignore" });
execFileSync("python3", ["-c", String.raw`import json,os,stat,sys,warnings,zipfile
warnings.filterwarnings("ignore",category=UserWarning)
manifest={"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":sys.argv[3],"version":"1.0.0","description":"Archive source review acceptance.","extensions":{"com.openai":{"interface":{"displayName":sys.argv[4]}}}}
with zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED) as archive:
 archive.writestr("package/plugin.json",json.dumps(manifest))
with zipfile.ZipFile(sys.argv[2],"w",zipfile.ZIP_DEFLATED) as archive:
 archive.writestr("../plugin-traversal-escape.txt","ARCHIVE_ESCAPE_REJECTED")
 archive.writestr("plugin.json",json.dumps(manifest))
with zipfile.ZipFile(os.path.join(sys.argv[5],"duplicate.zip"),"w") as archive:
 archive.writestr("plugin.json",json.dumps(manifest))
 archive.writestr("plugin.json",json.dumps(manifest))
with zipfile.ZipFile(os.path.join(sys.argv[5],"symlink.zip"),"w") as archive:
 archive.writestr("plugin.json",json.dumps(manifest))
 entry=zipfile.ZipInfo("linked-file");entry.create_system=3;entry.external_attr=(stat.S_IFLNK|0o777)<<16
 archive.writestr(entry,"../plugin-symlink-target")
with zipfile.ZipFile(os.path.join(sys.argv[5],"manifest.zip"),"w") as archive:
 archive.writestr("plugin.json","{}")
`, validArchive, invalidArchive, fixture.archiveName, fixture.archiveDisplayName, scratch]);
const archivePluginId = `${fixture.archiveName}@archive-${sha(await readFile(validArchive))}`;
const creatorPython = execFileSync(process.env.AREAL_TEST_PYTHON ?? "python3", ["-c", "import sys, yaml; print(sys.executable)"], { encoding: "utf8", env: { ...process.env, HOME: userHome, PYTHONNOUSERSITE: "1" } }).trim();
const createdSkillId = "creator-project-proof";
const createdSkillBody = "---\nname: creator-project-proof\ndescription: Produce project-local acceptance proof when asked.\n---\n\n# Project proof\n\nRead the requested project task and report a concise result.\n";
const creatorBody = await readFile(join(gui, "app/assets/builtin-skills", fixture.creatorId, "SKILL.md"), "utf8");
const creatorSource = JSON.parse(await readFile(join(gui, "app/assets/builtin-skills", `${fixture.creatorId}.source.json`), "utf8"));

const creatorToolRoot = ".scratch/creator-tools";
const creatorResources = await Promise.all(["init_skill.py", "generate_openai_yaml.py", "quick_validate.py"].map(async name => {
  const resource = `scripts/${name}`;
  const expected = creatorSource.files.find(file => file.path === resource);
  assert.ok(expected);
  return { name, resource, sha256: expected.sha256, size: (await readFile(join(gui, "app/assets/builtin-skills", fixture.creatorId, resource))).length };
}));
const creatorReadSteps = creatorResources.flatMap(file => Array.from({ length: Math.ceil(file.size / 8192) }, (_, index) =>
  ["skill_read", { skill: { id: fixture.creatorId, revision: `builtin-${creatorSource.contentDigest}` }, resource: file.resource, offset: index * 8192, maxBytes: 8192 }]));
const creatorToolCount = creatorReadSteps.length + 8;
function creatorResourceText(payload, file) {
  const calls = new Map((payload.messages ?? []).flatMap(message => message.tool_calls ?? []).map(call => [call.id, call]));
  const pages = (payload.messages ?? []).filter(message => message.role === "tool" && calls.get(message.tool_call_id)?.function.name === "skill_read")
    .map(message => ({ args: JSON.parse(calls.get(message.tool_call_id).function.arguments), result: JSON.parse(message.content) }))
    .filter(page => page.args.resource === file.resource).sort((a, b) => a.args.offset - b.args.offset);
  let offset = 0;
  const chunks = pages.map(({ args, result }) => {
    assert.equal(args.offset, offset); assert.equal(result.resource, file.resource);
    assert.equal(result.revision, `builtin-${creatorSource.contentDigest}`);
    const bytes = typeof result.text === "string" ? Buffer.from(result.text, "utf8") : Buffer.from(result.dataBase64, "base64"); offset += bytes.length;
    assert.equal(result.nextOffset, offset); return bytes;
  });
  assert.equal(pages.at(-1)?.result.eof, true);
  const bytes = Buffer.concat(chunks);
  assert.equal(bytes.length, file.size); assert.equal(sha(bytes), file.sha256, "Core resource bytes match the pinned official file");
  return bytes.toString("utf8");
}

const model = createServer(async (request, response) => {
  try {
  let body = "";
  for await (const part of request) body += part;
  const payload = JSON.parse(body);
  if (respondToSessionName(payload, response)) { auxiliaryRequests.push({ purpose: "sessionName" }); return; }
  const system = payload.messages?.filter(message => message.role === "system").map(message => message.content).filter(content => typeof content === "string") ?? [];
  if (system.some(content => content.startsWith("Predict the next user prompt from the conversation data."))) {
    assert.ok(!payload.tools?.length, "prompt predictions have no tools");
    auxiliaryRequests.push({ purpose: "promptPrediction" });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    return;
  }
  if (system.some(content => content.startsWith("AReaL permission review."))) {
    assert.ok(!payload.tools?.length, "permission review has no tools");
    const packet = JSON.parse(payload.messages.findLast(message => message.role === "user").content);
    assert.match(packet.digest, /^[a-f0-9]{64}$/);
    auxiliaryRequests.push({ purpose: "permissionReview", tool: packet.tool, digest: packet.digest });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: JSON.stringify({ decision: "ask", reason: "The fixture requires explicit user approval.", digest: packet.digest }) }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    return;
  }
  requests.push(payload);
  const calls = (payload.messages ?? []).flatMap(message => message.tool_calls ?? []);
  const completed = calls.length;
  const steps = [
    ...creatorReadSteps,
    ["run_command", { argv: [creatorPython, "-c", `from pathlib import Path; Path('${creatorToolRoot}').mkdir(parents=True, exist_ok=False)`], yieldMs: 10000 }],
    ...creatorResources.map(file => ["fs_create", () => ({ path: `${creatorToolRoot}/${file.name}`, text: creatorResourceText(payload, file) })]),
    ["run_command", { argv: [creatorPython, `${creatorToolRoot}/init_skill.py`, createdSkillId, "--path", ".agents/skills", "--interface", "short_description=Create a concise project-local acceptance proof"], yieldMs: 10000 }],
    ["fs_read", { path: `.agents/skills/${createdSkillId}/SKILL.md` }],
    ["fs_write", { path: `.agents/skills/${createdSkillId}/SKILL.md`, text: createdSkillBody }],
    ["run_command", { argv: [creatorPython, `${creatorToolRoot}/quick_validate.py`, `.agents/skills/${createdSkillId}`], yieldMs: 10000 }],
  ];
  const planned = steps[completed];
  const step = planned && [planned[0], typeof planned[1] === "function" ? planned[1]() : planned[1]];
  const delta = step ? { tool_calls: [{ index: 0, id: `creator-tool-${completed}`, type: "function", function: { name: step[0], arguments: JSON.stringify(step[1]) } }] } : { content: "CONCEPT_MODEL_REPLY" };
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: step ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  } catch (error) {
    errors.push(`Creator model fixture: ${error.stack ?? error}`);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
});
await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
await writeFile(join(userHome, ".areal/config.toml"),
  `schema_version=1\n[model]\nname="fixture"\n[model.providers.default]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}"\n`);
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
Object.assign(env, {
  AREAL_GUI_USER_DATA: join(scratch, "electron"), AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: userHome,
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_CORE_BIN: resolve(process.env.AREAL_CORE_BIN ?? join(root, "target/debug/areal")),
});
const coreSha256 = sha(await readFile(env.AREAL_CORE_BIN));
const sourceFiles = {};
for (const path of new Set(execFileSync("git", ["ls-files", "--modified", "--others", "--exclude-standard", "-z"], { cwd: root })
  .toString().split("\0").filter(Boolean))) {
  if (/^(core\/|clients\/|scripts\/|schemas\/|Cargo\.|upstream\/)/.test(path)) {
    try { sourceFiles[path] = sha(await readFile(join(root, path))); }
    catch (error) { if (error.code !== "ENOENT") throw error; sourceFiles[path] = null; }
  }
}
const sourceDiffSha256 = sha(execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: root, maxBuffer: 32 * 1024 * 1024 }));
let app, page, projectId, pluginProjectId, threadId, failure;
let passed = false;
let cleanup = {};
const button = name => page.getByRole("button", { name, exact: true });
const primaryTabs = () => page.getByRole("tablist", { name: "已安装资源类型", exact: true });
const state = () => page.evaluate(() => window.arealDesktop.snapshot());
async function until(read, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await sleep(100);
  }
  throw Error(`Timeout: ${label}`);
}
async function call(name, params) {
  const result = await page.evaluate(({ name, params }) => window.arealDesktop.command(name, params), { name, params });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}
const resources = operation => call("resources", { operation, projectId, scope: "project" });
const manage = operation => call("manage", { operation, projectId });
async function events() {
  try { return (await readFile(transportLog, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
async function capture(name) {
  await page.screenshot({ path: join(scratch, `${name}.png`), animations: "disabled" });
  await writeFile(join(scratch, `${name}.aria.txt`), await page.locator("body").ariaSnapshot());
}
async function launch() {
  app = await electron.launch({ executablePath: require("electron"), args: [join(gui, "app")], env, timeout: 120_000 });
  page = await app.firstWindow();
  await app.evaluate(({}, modulePath) => {
    const { McpAppsHost } = process.getBuiltinModule("node:module").createRequire(modulePath)(modulePath);
    globalThis.__conceptAppTrace = [];
    for (const method of ["open", "adopt"]) {
      const original = McpAppsHost.prototype[method];
      McpAppsHost.prototype[method] = async function (...args) {
        try { return await original.apply(this, args); }
        catch (error) { globalThis.__conceptAppTrace.push({ method, at: Date.now(), message: error.message, stack: error.stack }); throw error; }
      };
    }
  }, join(gui, "app/src/core/mcp-apps.cjs"));
  await app.evaluate(({ dialog }) => {
    const original = dialog.showMessageBox;
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      return options?.type === "question" && /退出|关闭/.test(options.message ?? "")
        ? { response: 1, checkboxChecked: false } : original(...args);
    };
  });
  page.setDefaultTimeout(20_000);
  page.on("pageerror", error => errors.push(error.message));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120_000 });
  await until(async () => (await state()).connection?.state === "ready", "desktop ready");
  const identity = await app.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const preferences = window.webContents.getLastWebPreferences();
    window.setSize(1440, 960);
    return { pid: process.pid, version: process.versions.electron, userData: app.getPath("userData"),
      sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration };
  });
  assert.equal(identity.userData, env.AREAL_GUI_USER_DATA);
  assert.equal(identity.sandbox, true);
  assert.equal(identity.contextIsolation, true);
  assert.equal(identity.nodeIntegration, false);
  const metadata = JSON.parse(await readFile(join(scratch, "core/service.json"), "utf8"));
  process.kill(metadata.pid, 0);
  const connection = new ServiceConnection();
  try {
    await connection.connect(metadata);
    await connection.request("hello", { protocol: metadata.protocol, identity: metadata.identity });
  } finally { connection.close(); }
  instances.push({ ...identity, servicePid: metadata.pid, serviceProtocol: metadata.protocol, desktopGeneration: metadata.desktopGeneration });
}
async function settings() {
  await button("设置").click();
  await page.getByLabel("集成", { exact: true }).getByRole("button", { name: "插件", exact: true }).click();
  if (await button("返回插件列表").isVisible()) await button("返回插件列表").click();
  await page.getByRole("heading", { name: "插件", exact: true }).first().waitFor();
  await primaryTabs().waitFor();
  assert.deepEqual(await primaryTabs().getByRole("tab").allTextContents(), ["插件", "MCP", "Skills", "市场"]);
}
async function selectNative(path) {
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    dialog.showMessageBox = async () => ({ response: 1 });
  }, path);
}
async function pluginWorkspace() {
  await page.getByRole("navigation", { name: "应用导航", exact: true }).getByRole("button", { name: "插件", exact: true }).click();
  await button("插件市场").waitFor();
}
async function marketAudience(name) {
  await page.getByRole("tablist", { name: "市场范围", exact: true }).getByRole("tab", { name, exact: true }).click();
}
async function addMenu() {
  await button("添加资源").click();
  await page.getByRole("menuitem", { name: "添加市场", exact: true }).waitFor();
  assert.deepEqual(await page.getByRole("menuitem").allTextContents(), ["添加市场", "添加 MCP", "上传插件包"]);
}
async function scopeProject() {
  await button("资源范围").click();
  await page.getByRole("menuitemradio", { name: "当前项目", exact: true }).click();
}
async function tab(name) {
  await primaryTabs().getByRole("tab", { name, exact: true }).click();
}
function skillRow(owner) {
  return page.getByRole("article").filter({ has: page.getByText(fixture.skillName, { exact: true }) })
    .filter({ hasText: owner === "plugin" ? fixture.pluginName : "workspace" });
}
function mcpRow(owner) {
  return page.getByRole("article").filter({ hasText: owner === "plugin" ? fixture.pluginName : fixture.standaloneServer });
}
async function detailFromResource(row) {
  await row.getByRole("button", { name: "管理插件", exact: true }).click();
  const detail = page.getByTestId("plugin-detail-page");
  await detail.getByRole("heading", { name: fixture.pluginName, exact: true }).waitFor();
  await reconcilePluginSubmission(detail);
  const sourceDetails = detail.locator("#plugin-source-details");
  const revealDetails = detail.getByRole("button", { name: "查看详情", exact: true });
  if (await revealDetails.isVisible()) await revealDetails.click();
  const pluginIdentity = sourceDetails.getByText(fixture.pluginId, { exact: true });
  if (!await pluginIdentity.isVisible()) await detail.getByText("技术详情", { exact: true }).click();
  await pluginIdentity.waitFor();
  await detail.getByRole("button", { name: "卸载插件", exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0, "plugin details are a content page");
  return detail;
}
async function reconcilePluginSubmission(container) {
  const recovery = container.getByRole("button", { name: "核对插件提交", exact: true });
  const before = await manage("plugins");
  if (!await recovery.isVisible()) return;
  try { await recovery.click({ timeout: 2000 }); }
  catch (error) {
    // A completed receipt read may remove this control while the locator is resolving.
    // Never replay the failed import; accept disappearance only with unchanged catalog below.
    if (await recovery.isVisible()) throw error;
  }
  await until(async () => !(await recovery.isVisible()), "original failed archive receipt is confirmed");
  assert.deepEqual(await manage("plugins"), before, "receipt recovery does not replay or mutate the catalog");
  checks.push("failed archive submission is reconciled by reading its original receipt without replay");
}
async function selectOwner(ownerThreadId) {
  await page.getByRole("navigation", { name: "应用导航", exact: true }).getByRole("button", { name: "首页", exact: true }).click();
  if (await button("展开侧栏").isVisible()) await button("展开侧栏").click();
  await selectConversation(page, ownerThreadId);
  assert.equal(await page.getByTestId("areal-workbench").getAttribute("data-project-id"), projectId);
  const queue = (await state()).projects.find(project => project.id === projectId).state.queues?.[ownerThreadId];
  assert.ok(queue, "persisted App owner exposes its authoritative queue");
  assert.equal(queue.items.some(item => ["pending", "running"].includes(item.status)), false, "fixture resume cannot execute queued work");
  if (queue.paused) {
    assert.equal(queue.pauseReason, "serverDraining", "only the fixture's known shutdown pause is resumed");
    await button("任务操作").click();
    await page.getByRole("menuitem", { name: "队列", exact: true }).click();
    await button("继续队列").click();
    await until(async () => (await state()).projects.find(project => project.id === projectId).state.queues?.[ownerThreadId]?.paused === false,
      "explicit UI resumes the empty queue after cold service shutdown");
  }
}
async function connectPackage(detail) {
  await detail.getByRole("button", { name: "审阅并连接", exact: true }).click();
  assert.equal(await detail.getByRole("button", { name: "信任并连接", exact: true }).isEnabled(), false);
  await detail.getByRole("checkbox", { name: "我信任当前安装快照，并允许启动其 MCP 服务。", exact: true }).check();
  await detail.getByRole("button", { name: "信任并连接", exact: true }).click();
  return until(async () => {
    const plugin = (await manage("pluginMcp")).data.find(item => item.pluginId === fixture.pluginId);
    return plugin?.servers.length === 1 && plugin.servers[0].state === "connected" ? plugin : null;
  }, "explicit digest trust connects package MCP");
}
const echoRequests = entries => entries.filter(event => event.owner === "package" && event.event === "request"
  && event.method === "tools/call" && event.params.name === "concept.echo");
async function settleAppApproval(read, label) {
  let approvals = 0;
  const value = await until(async () => {
    const result = await read();
    if (result) return result;
    const approval = page.locator('[data-interaction="approval"]');
    const allow = approval.getByRole("button", { name: "允许一次", exact: true });
    if (!approvals && await allow.count() && await allow.isVisible()) {
      let enabled = false;
      try { enabled = await allow.isEnabled({ timeout: 250 }); }
      catch (error) { if (await allow.count()) throw error; }
      if (enabled) { await allow.click(); approvals++; }
    }
    return null;
  }, label);
  assert.equal(approvals, 1, "the App action uses its ordinary visible Core approval");
  return value;
}
async function openAndEchoApp(detail, ownerThreadId, expectedCalls) {
  const before = (await state()).projects.find(project => project.id === projectId);
  const beforeThreads = Object.keys(before.state.threads).sort();
  assert.equal(before.root, workspace);
  assert.ok(before.state.threads[ownerThreadId], "App owner is a persisted source conversation");
  assert.equal(await page.getByTestId("areal-workbench").getAttribute("data-thread-id"), ownerThreadId);
  await detail.getByRole("button", { name: "Concept App", exact: true }).click();
  await page.getByTestId("chat-input").waitFor();
  const frame = await settleAppApproval(async () => page.frames().find(frame => /^areal-mcp:\/\/[^/]+\/view$/.test(frame.url())), "actual MCP App frame after ordinary approval");
  await frame.locator("#ready").filter({ hasText: "initialized" }).waitFor();
  assert.equal(await page.getByTestId("areal-workbench").getAttribute("data-thread-id"), ownerThreadId, "global App preserves its selected persisted owner");
  assert.deepEqual(Object.keys((await state()).projects.find(project => project.id === projectId).state.threads).sort(), beforeThreads, "opening App cannot create another execution thread");
  assert.equal(requests.length, 0, "opening App cannot invoke inference");
  await frame.getByRole("button", { name: "Echo literal", exact: true }).click();
  await settleAppApproval(async () => await frame.locator("#result").filter({ hasText: "ECHO_CONCEPT_LITERAL" }).isVisible(), "App Echo after ordinary approval");
  assert.deepEqual(JSON.parse(await frame.locator("#result").innerText()).content, [{ type: "text", text: "ECHO_CONCEPT_LITERAL" }]);
  const echoes = echoRequests(await events());
  assert.equal(echoes.length, expectedCalls, "one explicit Echo produces one transport call without replay");
  assert.ok(echoes.every(event => event.params.arguments.value === "CONCEPT_LITERAL"));
  assert.equal(requests.length, 0, "interactive App echo cannot invoke model inference");
  return { frameUrl: frame.url(), threadId: ownerThreadId };
}
async function ownedCoreGeneration(ownerRoot) {
  return until(async () => {
    const entries = JSON.parse(execFileSync(env.AREAL_CORE_BIN, ["service", "list", "--json"], { env, encoding: "utf8", timeout: 30_000 }));
    const owner = entries.find(entry => entry.workspace === ownerRoot && entry.owner?.profile === env.AREAL_GUI_USER_DATA && entry.state !== "stopped");
    return owner?.corePid && owner?.generation ? owner : null;
  }, "owned Core generation is running");
}
async function closeDetail() {
  await button("返回插件列表").click();
  await page.getByTestId("plugin-detail-page").waitFor({ state: "hidden" });
  await page.getByTestId("skill-detail-page").waitFor({ state: "hidden" });
}
async function skillWorkspace() {
  await pluginWorkspace();
  await page.getByRole("complementary", { name: "插件导航", exact: true }).getByRole("button", { name: "Skills", exact: true }).click();
  await button("创建 Skill").waitFor();
  assert.equal(await button("资源范围").count(), 0, "Skills workspace has no current-project filter");
}
async function importArchive(path) {
  await selectNative(path);
  await addMenu();
  await page.getByRole("menuitem", { name: "上传插件包", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("heading", { name: "上传插件包", exact: true }).waitFor();
  await dialog.getByRole("button", { name: "导入并预览", exact: true }).click();
}
async function assertSkillOwners() {
  const packaged = skillRow("plugin"), standalone = skillRow("standalone");
  await packaged.waitFor();
  await standalone.waitFor();
  assert.equal(await packaged.count(), 1, "package Skill has one source-aware row");
  assert.equal(await standalone.count(), 1, "same-named standalone Skill has a distinct row");
  assert.match(await packaged.innerText(), /插件/);
  assert.match(await standalone.innerText(), /workspace/);
  assert.equal(await packaged.getByRole("switch").count(), 0, "package Skill cannot use the standalone toggle");
  await packaged.getByRole("button", { name: "管理插件", exact: true }).waitFor();
  return { packaged, standalone };
}
async function stopService() {
  let metadata;
  try { metadata = JSON.parse(await readFile(join(scratch, "core/service.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (metadata) {
    const connection = new ServiceConnection();
    try {
      await connection.connect(metadata);
      await connection.request("hello", { protocol: metadata.protocol, identity: metadata.identity });
      await connection.request("stopService", { protocol: metadata.protocol }, true);
    } finally { connection.close(); }
    await waitForServiceExit(join(scratch, "core"), metadata);
    await until(async () => {
      try { process.kill(metadata.pid, 0); return false; }
      catch (error) { if (error.code === "ESRCH") return true; throw error; }
    }, "owned desktop service exits");
  }
  await assertApplicationStopped(env.AREAL_CORE_BIN, env, metadata);
  const remaining = JSON.parse(execFileSync(env.AREAL_CORE_BIN, ["service", "list", "--json"], { env, encoding: "utf8", timeout: 30_000 }));
  const owners = JSON.parse(await readFile(join(scratch, "core/projects.json"), "utf8"));
  const projectless = JSON.parse(await readFile(join(scratch, "core/projectless-drafts.json"), "utf8"));
  for (const service of remaining) {
    const owner = owners.find(owner => owner.root === service.workspace);
    assert.ok(owner && ([workspace, creatorWorkspace].includes(owner.root) || owner.projectless === true
      && projectless[owner.projectlessRequestId]?.root === owner.root && owner.root.startsWith(`${userHome}/`)), "registry contains only persisted fixture owners");
    assert.equal(service.owner?.kind, "gui");
    assert.equal(service.owner?.profile, env.AREAL_GUI_USER_DATA);
    assert.equal(service.dataDir, join(scratch, "core", owner.id, "state"));
  }
  assert.equal(remaining.every(service => service.state === "stopped"), true, "owned Core services stopped");
  return { desktopStopped: true, coreStopped: true, remaining };
}

try {
  if (creatorOnly) {
    await launch();
    await selectNative(workspace);
    await page.evaluate(() => window.arealDesktop.chooseProject());
    await page.getByRole("navigation", { name: "应用导航", exact: true }).getByRole("button", { name: "首页", exact: true }).click();
    await createProjectConversation(page, "workspace");
    const owner = await until(async () => (await state()).projects.find(project => project.root === workspace && project.state?.connected), "Creator fixture project connected");
    projectId = owner.id;
    assert.equal(Object.keys(owner.state.threads).length, 0, "Creator scenario starts before any task occupies the source workspace");
    await page.getByTestId("chat-input").fill("CREATOR_EXISTING_DRAFT");
    await skillWorkspace();
  } else {
  const legacyDeployment = join(scratch, "legacy-desktop.json");
  await json(legacyDeployment, { profiles: [{ id: "areal-standard", revision: "resources-00000000", displayName: "标准", instructions: "Legacy deployment", allowPluginSkills: true, skills: [] }] });
  env.AREAL_CORE_DESKTOP_CONFIG = legacyDeployment;
  await launch();
  const initialProjects = (await state()).projects;
  assert.equal(initialProjects.filter(project => !project.projectless).length, 0, "no workspace project exists before opening Plugins");
  await pluginWorkspace();
  assert.deepEqual((await state()).projects.map(project => project.id).sort(), initialProjects.map(project => project.id).sort(), "opening Plugins cannot create a hidden project");
  assert.equal(await page.getByTestId("areal-workbench").getAttribute("data-thread-id"), "",
    "opening Plugins cannot create an execution thread");
  assert.equal(requests.length, 0, "opening Plugins cannot invoke inference");
  assert.equal((await events()).length, 0, "opening Plugins cannot start MCP");
  checks.push("the global Plugins workspace opens before any workspace project without creating project, task or execution");
  await capture("00-projectless-plugins");
  await selectNative(workspace);
  await page.evaluate(() => window.arealDesktop.chooseProject());
  await page.getByRole("navigation", { name: "应用导航", exact: true }).getByRole("button", { name: "首页", exact: true }).click();
  await createProjectConversation(page, "workspace");
  const ready = await until(async () => {
    const value = await state();
    return value.projects.find(project => project.root === workspace && project.state?.connected);
  }, "fixture project connected");
  projectId = ready.id;
  pluginProjectId = projectId;
  threadId = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
  assert.equal(threadId, "", "new project conversation is an unsubmitted draft");
  const legacyThread = await call("create", { projectId, profile: { id: "areal-standard", revision: "resources-00000000" } });
  assert.ok(legacyThread.threadId, "legacy profile fixture has a persisted conversation owner");
  await page.getByTestId("chat-input").fill("RESTRICTED_CREATOR_DRAFT");
  await settings();
  await tab("Skills");
  await button("创建 Skill").click();
  await until(async () => {
    const value = await page.locator("body").innerText();
    return /配置|Skill/.test(value) && !(await button("创建 Skill").isDisabled());
  }, "restricted Creator preparation finishes");
  assert.equal(await primaryTabs().isVisible(), true, "external deployment without Creator cannot gain new grants");
  assert.equal(await page.evaluate(id => localStorage.getItem(`areal-gui:draft:${id}:new`), projectId), "RESTRICTED_CREATOR_DRAFT");
  assert.equal(requests.length, 0);
  checks.push("custom deployment without Creator keeps its permissions and preserves the existing chat draft");
  await closeSmokeApplication(app); app = null;
  await stopService();
  delete env.AREAL_CORE_DESKTOP_CONFIG;
  await launch();
  const upgraded = await until(async () => (await state()).projects.find(project => project.id === projectId && project.root === workspace && project.state?.connected), "upgraded project connected");
  assert.equal(upgraded.profiles.find(profile => profile.id === "areal-standard").revision, "resources-00000000", "fixture retains a historical first profile without Creator");
  await json(join(scratch, "creator-upgraded-project.json"), upgraded);
  await settings();
  await tab("Skills");
  const creatorDraftKey = `areal-gui:draft:${projectId}:new`;
  const restrictedSelection = JSON.stringify({ id: "areal-standard", revision: "resources-00000000" });
  await page.evaluate(({ key, value }) => localStorage.setItem(`${key}:profile`, value), { key: creatorDraftKey, value: restrictedSelection });
  await button("创建 Skill").click();
  await page.getByText("当前任务配置未提供官方 Skill Creator 的确切版本，现有草稿已保留。", { exact: true }).waitFor();
  assert.equal(await primaryTabs().isVisible(), true);
  assert.equal(await page.evaluate(key => localStorage.getItem(`${key}:profile`), creatorDraftKey), restrictedSelection);
  assert.equal(await page.evaluate(key => localStorage.getItem(key), creatorDraftKey), "RESTRICTED_CREATOR_DRAFT");
  await page.evaluate(key => localStorage.setItem(`${key}:profile`, "{"), creatorDraftKey);
  await button("创建 Skill").click();
  await page.getByText("保存的任务配置无效，现有草稿已保留。", { exact: true }).waitFor();
  assert.equal(await primaryTabs().isVisible(), true);
  assert.equal(await page.evaluate(key => localStorage.getItem(key), creatorDraftKey), "RESTRICTED_CREATOR_DRAFT");
  await page.evaluate(key => localStorage.removeItem(`${key}:profile`), creatorDraftKey);
  assert.equal(requests.length, 0);
  checks.push("managed deployment preserves an explicit restricted historical profile and rejects malformed saved profile without draft mutation or inference");
  await button("创建 Skill").click();
  await page.getByTestId("chat-input").filter({ hasText: ".agents/skills" }).waitFor();
  await button("查看技能 skill-creator 官方 · OpenAI").waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(await page.getByTestId("areal-workbench").getAttribute("data-project-id"), projectId);
  assert.equal(requests.length, 0);
  const retained = await call("manage", { projectId, threadId: legacyThread.threadId, operation: "inspect" });
  assert.deepEqual({ id: retained.configuration.profile.id, revision: retained.configuration.profile.revision }, { id: "areal-standard", revision: "resources-00000000" }, "preparation preserves historical task bindings");
  checks.push("Settings Create Skill uses the current deployment after upgrade, preserves historical task bindings and enters the selected project chat without a form or inference");
  await capture("00b-upgraded-settings-create-skill");
  await button("移除技能 skill-creator 官方 · OpenAI").click();
  await page.getByTestId("chat-input").fill("");
  await settings();
  assert.equal(await button(`查看插件 ${fixture.pluginId}`).count(), 0, "Settings lists installed plugins only");
  checks.push("Settings has exactly four primary tabs in order: 插件, MCP, Skills, 市场, and excludes uninstalled packages");
  await pluginWorkspace();
  const catalog = await manage("plugins");
  assert.deepEqual(catalog.marketplaces.map(item => item.name), ["concept-market"]);
  assert.equal(catalog.marketplaces[0].root, workspace);
  assert.equal(catalog.marketplaces[0].sourceUrl ?? null, null);
  await marketAudience("公共");
  await page.getByText("尚未添加官方插件市场", { exact: true }).waitFor();
  assert.equal(await button(`查看插件 ${fixture.pluginId}`).count(), 0, "local marketplace is not presented as official public source");
  await marketAudience("个人");
  await button(`查看插件 ${fixture.pluginId}`).waitFor();
  await addMenu();
  await page.keyboard.press("Escape");
  checks.push("Public and Personal market views reflect the actual Core source; Add contains exactly market, MCP and ZIP");
  await page.getByLabel("搜索插件包", { exact: true }).fill("Concept");
  await button(`查看插件 ${fixture.pluginId}`).click();
  await page.getByTestId("plugin-detail-page").waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0, "market plugin detail is a content page");
  await button("安装").click();
  await page.getByRole("checkbox", { name: "我已核对以上来源、版本和摘要", exact: true }).waitFor();
  await scopeProject();
  assert.equal(await button("安装到当前项目").isEnabled(), false, "package install needs source review");
  await page.getByRole("checkbox", { name: "我已核对以上来源、版本和摘要", exact: true }).check();
  await button("安装到当前项目").click();
  await button("管理").waitFor();
  const installed = (await manage("plugins")).data.find(plugin => plugin.id === fixture.pluginId);
  assert.equal(installed.installed, true);
  assert.equal(installed.enabled, true);
  assert.equal(installed.installedVersion, "1.0.0");
  assert.equal((await events()).length, 0, "review and install cannot start MCP");
  assert.equal(requests.length, 0, "install cannot start model inference");
  checks.push("real GUI source preview and digest confirmation install the portable project package without MCP/model startup");
  await capture("01-installed-package");
  await closeDetail();
  assert.equal(await page.getByLabel("搜索插件包", { exact: true }).inputValue(), "Concept",
    "plugin detail back preserves market search");
  assert.equal(await page.getByRole("tablist", { name: "市场范围", exact: true }).getByRole("tab", { name: "个人", exact: true }).getAttribute("aria-selected"), "true");
  await skillWorkspace();
  const installedPreview = page.getByRole("region", { name: "已安装 Skills", exact: true });
  const personalPreview = page.getByRole("region", { name: "个人的 Skills", exact: true });
  const sourceTabs = page.getByRole("tablist", { name: "Skill 来源", exact: true });
  await until(async () => await installedPreview.getByRole("article").count() === 6, "installed preview has six Skills");
  assert.equal(await personalPreview.getByRole("article").count(), 6);
  await installedPreview.getByRole("button", { name: "查看更多，另有 12 个 Skill", exact: true }).click();
  assert.equal(await installedPreview.getByRole("article").count(), 18);
  await installedPreview.getByRole("button", { name: "收起", exact: true }).click();
  assert.equal(await installedPreview.getByRole("article").count(), 6);
  await sourceTabs.getByRole("tab", { name: "workspace", exact: true }).click();
  const projectPreview = page.getByRole("region", { name: "workspace的 Skills", exact: true });
  assert.equal(await projectPreview.getByRole("article").count(), 6);
  assert.equal(await projectPreview.getByRole("button", { name: "查看技能 project-preview-08", exact: true }).count(), 0);
  await projectPreview.getByRole("button", { name: "查看更多，另有 4 个 Skill", exact: true }).click();
  assert.equal(await projectPreview.getByRole("article").count(), 10);
  await projectPreview.getByRole("button", { name: "查看技能 project-preview-08", exact: true }).click();
  await page.getByTestId("skill-detail-page").getByText("PROJECT_PREVIEW_BODY_08", { exact: true }).waitFor();
  await closeDetail();
  assert.equal(await sourceTabs.getByRole("tab", { name: "workspace", exact: true }).getAttribute("aria-selected"), "true");
  await page.getByLabel("搜索 Skills", { exact: true }).fill("personal-preview-08");
  assert.equal(await installedPreview.getByRole("article").count(), 1, "search includes items beyond collapsed previews and other scopes");
  assert.equal(await projectPreview.getByRole("article").count(), 0, "project source does not include personal Skills");
  await button("清除 Skill 搜索").click();
  await sourceTabs.getByRole("tab", { name: "个人", exact: true }).click();
  await personalPreview.getByRole("button", { name: "查看更多，另有 2 个 Skill", exact: true }).click();
  assert.equal(await personalPreview.getByRole("article").count(), 8);
  await personalPreview.getByRole("button", { name: "收起", exact: true }).click();
  await capture("01a-skills-personal-preview-light");
  await button("设置").click();
  await page.getByRole("button", { name: "外观", exact: true }).click();
  await page.getByRole("combobox", { name: "界面主题", exact: true }).click();
  await page.getByRole("option", { name: "深色", exact: true }).click();
  await skillWorkspace();
  await capture("01a-skills-personal-preview-dark");
  await sourceTabs.getByRole("tab", { name: "workspace", exact: true }).click();
  assert.equal(await projectPreview.getByRole("article").count(), 6, "returning from appearance settings starts with the compact source preview");
  await capture("01a-skills-project-preview-dark");
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(640, 480); window.setSize(820, 960); });
  assert.equal(await page.evaluate(() => innerWidth), 820);
  await capture("01a-skills-preview-narrow");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "narrow Skills view has no document overflow");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
  await sourceTabs.getByRole("tab", { name: "个人", exact: true }).click();
  await installedPreview.getByRole("button", { name: "查看更多，另有 12 个 Skill", exact: true }).click();
  checks.push("Skills previews show six items, expand and collapse independently, retain project source after detail return and search all installed results; light/dark/narrow views captured");
  let standaloneDetails = skillRow("standalone");
  await standaloneDetails.getByRole("button", { name: `查看技能 ${fixture.skillId}`, exact: true }).click();
  let skillDetail = page.getByTestId("skill-detail-page");
  await skillDetail.getByText("STANDALONE_CONCEPT_BODY", { exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0, "standalone Skill body is a content page");
  assert.equal((await skillDetail.innerText()).includes("PACKAGE_CONCEPT_BODY"), false);
  await closeDetail();
  await skillRow("plugin").getByRole("button", { name: /^查看技能 / }).click();
  skillDetail = page.getByTestId("skill-detail-page");
  await skillDetail.getByText("PACKAGE_CONCEPT_BODY", { exact: true }).waitFor();
  assert.equal((await skillDetail.innerText()).includes("STANDALONE_CONCEPT_BODY"), false,
    "packaged Skill content comes from its Core reference, not standalone skillRead");
  await closeDetail();
  await button("创建 Skill").waitFor();
  checks.push("Skills workspace exposes personal and project sources without a current-project-only filter; same-named standalone and package content pages read their distinct actual bodies and return to Skills");
  await capture("01a-skill-content-list");
  await button("插件市场").click();
  await marketAudience("个人");
  await importArchive(validArchive);
  await page.getByTestId("plugin-detail-page").getByRole("heading", { name: fixture.archiveDisplayName, exact: true }).waitFor();
  const imported = (await manage("plugins")).data.find(plugin => plugin.id === archivePluginId);
  assert.equal(imported.installed, false, "archive import publishes a candidate without installation");
  assert.equal(imported.enabled, false);
  await page.getByRole("checkbox", { name: "我已核对以上来源、版本和摘要", exact: true }).waitFor();
  await scopeProject();
  assert.equal(await button("安装到当前项目").isEnabled(), false, "archive candidate needs explicit source review");
  assert.equal((await events()).length, 0, "archive import cannot start MCP");
  assert.equal(requests.length, 0, "archive import cannot start inference");
  await page.getByRole("checkbox", { name: "我已核对以上来源、版本和摘要", exact: true }).check();
  await button("安装到当前项目").click();
  await button("管理").waitFor();
  const archiveInstalled = (await manage("plugins")).data.find(plugin => plugin.id === archivePluginId);
  assert.equal(archiveInstalled.installed, true);
  assert.equal(archiveInstalled.enabled, true);
  assert.equal(archiveInstalled.installedDigest, imported.sourceDigest);
  assert.equal((await events()).length, 0, "reviewed archive installation cannot start MCP");
  assert.equal(requests.length, 0, "reviewed archive installation cannot start inference");
  Object.assign(archiveEvidence, { pluginId: archivePluginId, archiveSha256: sha(await readFile(validArchive)), installedDigest: archiveInstalled.installedDigest });
  await capture("01b-reviewed-archive-install");
  await closeDetail();
  const beforeRejected = await manage("plugins");
  await importArchive(invalidArchive);
  await page.getByRole("dialog").getByText(/package path escape rejected/).waitFor();
  assert.deepEqual(await manage("plugins"), beforeRejected, "traversal rejection leaves catalog and installed state unchanged");
  assert.equal((await readdir(scratch, { recursive: true })).some(path => path.split("/").at(-1) === "plugin-traversal-escape.txt"), false,
    "traversal entry cannot escape archive staging");
  await reconcilePluginSubmission(page.getByRole("dialog"));
  await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  checks.push("native-selected ZIP imports to an uninstalled candidate, installs only after digest review, and rejects traversal without publication or filesystem escape");
  archiveEvidence.rejections = ["traversal"];
  for (const rejection of archiveRejections) {
    const before = await manage("plugins");
    await selectNative(join(scratch, `${rejection.name}.zip`));
    const selection = await call("manage", { operation: "pluginArchivePick", projectId });
    const result = await page.evaluate(params => window.arealDesktop.command("manage", params), {
      operation: "pluginArchiveImport", projectId, selectionToken: selection.selectionToken,
      expectedRevision: before.revision, requestId: randomUUID(),
    });
    assert.equal(result.ok, false, `${rejection.name} archive is rejected through the public command`);
    assert.match(result.error.message, rejection.message);
    assert.deepEqual(await manage("plugins"), before, `${rejection.name} archive cannot publish a candidate`);
    archiveEvidence.rejections.push(rejection.name);
  }
  assert.equal((await events()).length, 0, "rejected archives cannot start MCP");
  assert.equal(requests.length, 0, "rejected archives cannot invoke inference");
  checks.push("public native-selection and Core import boundaries reject duplicate ZIP paths, symlinks and invalid manifests without catalog mutation");
  await settings();
  await tab("Skills");
  let skills = await assertSkillOwners();
  const before = await resources("skills");
  assert.equal(before.data.find(skill => skill.id === fixture.skillId && skill.scope === "project").enabled, true);
  await detailFromResource(skills.packaged);
  assert.equal(await readFile(join(workspace, ".agents/skills", fixture.skillId, "SKILL.md"), "utf8"), standaloneSkill);
  assert.equal((await resources("skills")).data.find(skill => skill.id === fixture.skillId && skill.scope === "project").enabled, true);
  checks.push("same-named Skills remain source-distinct and package management opens its owning plugin without standalone mutation");
  await closeDetail();
  assert.equal(await primaryTabs().getByRole("tab", { name: "Skills", exact: true }).getAttribute("aria-selected"), "true",
    "returning from a packaged Skill preserves the Skills tab");
  await tab("Skills");
  skills = await assertSkillOwners();
  await skills.standalone.getByRole("switch", { name: `停用技能 ${fixture.skillId}`, exact: true }).click();
  await skills.standalone.getByRole("switch", { name: `启用技能 ${fixture.skillId}`, exact: true }).waitFor();
  await until(async () => (await resources("skills")).data.find(skill => skill.id === fixture.skillId && skill.scope === "project")?.enabled === false,
    "standalone project Skill toggle persisted");
  assert.equal(await skills.standalone.getByRole("switch", { name: `启用技能 ${fixture.skillId}`, exact: true }).getAttribute("aria-checked"), "false");
  assert.equal((await manage("plugins")).data.find(plugin => plugin.id === fixture.pluginId).enabled, true);
  checks.push("standalone Skill toggle persists through the public read while its same-named plugin stays enabled");
  await capture("02-source-aware-skills");
  await tab("MCP");
  await scopeProject();
  let packagedMcp = mcpRow("plugin");
  await packagedMcp.waitFor();
  assert.match(await packagedMcp.innerText(), /插件/);
  assert.match(await packagedMcp.innerText(), /未连接/);
  assert.equal(await packagedMcp.getByRole("switch").count(), 0, "package MCP cannot use the standalone connection switch");
  assert.equal(await packagedMcp.getByRole("button", { name: /^编辑 MCP/ }).count(), 0, "package MCP cannot use the standalone editor");
  const disconnected = (await manage("pluginMcp")).data.find(plugin => plugin.pluginId === fixture.pluginId);
  assert.equal(disconnected.servers.length, 1);
  assert.equal(disconnected.servers[0].state, "disconnected");
  assert.equal(disconnected.trusted, false);
  await button("新增 MCP").click();
  await page.getByLabel("服务 ID", { exact: true }).fill(fixture.standaloneServer);
  await page.getByLabel("命令", { exact: true }).fill(process.execPath);
  await page.getByLabel("参数（每行一个）", { exact: true }).fill([join(source, "server.mjs"), "standalone", transportLog].join("\n"));
  await button("保存 MCP 配置").click();
  await mcpRow("standalone").getByRole("button", { name: `编辑 MCP ${fixture.standaloneServer}`, exact: true }).waitFor();
  const saved = await until(async () => (await resources("mcp")).data.find(server => server.id === fixture.standaloneServer), "standalone MCP configuration saved");
  assert.equal(saved.config.transport.type, "stdio");
  assert.equal(saved.config.transport.command, process.execPath);
  assert.deepEqual(saved.config.transport.args, [join(source, "server.mjs"), "standalone", transportLog]);
  assert.equal(saved.state, "disconnected");
  assert.equal((await events()).length, 0, "saving standalone configuration cannot start a server");
  await mcpRow("standalone").getByRole("button", { name: `编辑 MCP ${fixture.standaloneServer}`, exact: true }).click();
  assert.equal(await page.getByLabel("命令", { exact: true }).inputValue(), process.execPath);
  await page.getByText("高级设置", { exact: true }).click();
  await page.getByLabel("调用超时（毫秒）", { exact: true }).fill("20000");
  await button("保存 MCP 配置").click();
  await mcpRow("standalone").getByRole("button", { name: `编辑 MCP ${fixture.standaloneServer}`, exact: true }).waitFor();
  await until(async () => (await resources("mcp")).data.find(server => server.id === fixture.standaloneServer)?.config.callTimeoutMs === 20000,
    "standalone MCP edit persisted");
  await mcpRow("standalone").getByRole("switch", { name: `连接 ${fixture.standaloneServer}`, exact: true }).click();
  await mcpRow("standalone").getByText("已连接", { exact: true }).waitFor();
  const connected = await until(async () => {
    const server = (await resources("mcp")).data.find(item => item.id === fixture.standaloneServer);
    return server?.state === "connected" ? server : null;
  }, "standalone MCP connected through GUI");
  assert.equal(connected.tools.some(tool => tool.description === "Echo the supplied literal."), true);
  assert.equal((await events()).some(event => event.owner === "standalone" && event.event === "response" && event.method === "tools/list" &&
    event.result.tools.some(tool => tool.name === "concept.echo")), true);
  assert.equal((await events()).some(event => event.owner === "package"), false, "standalone connect cannot start the package server");
  await mcpRow("standalone").getByText("已连接", { exact: true }).waitFor();
  checks.push("standalone project MCP creation, readback, editing and connection use the real UI and preserve the package connection boundary");
  packagedMcp = mcpRow("plugin");
  const dialog = await detailFromResource(packagedMcp);
  const packageConnection = await connectPackage(dialog);
  assert.equal(packageConnection.trusted, true);
  assert.equal(packageConnection.installedDigest, installed.installedDigest);
  await capture("03-plugin-detail-connected");
  await closeDetail();
  assert.equal(await primaryTabs().getByRole("tab", { name: "MCP", exact: true }).getAttribute("aria-selected"), "true",
    "returning from packaged MCP preserves the MCP tab");
  await tab("MCP");
  await mcpRow("plugin").getByText("已连接", { exact: true }).waitFor();
  await mcpRow("standalone").getByText("已连接", { exact: true }).waitFor();
  await capture("04-source-aware-mcp");
  checks.push("package MCP is listed before connection, delegates management to the package, and shows the real connected state after explicit digest trust");
  const unboundThreads = Object.keys((await state()).projects.find(project => project.id === projectId).state.threads).sort();
  assert.equal(await page.getByTestId("areal-workbench").getAttribute("data-thread-id"), "");
  const unboundDetail = await detailFromResource(mcpRow("plugin"));
  await unboundDetail.getByRole("button", { name: "Concept App", exact: true }).click();
  await page.getByText("请先在侧栏选择已有会话，再打开应用。", { exact: true }).waitFor();
  assert.deepEqual(Object.keys((await state()).projects.find(project => project.id === projectId).state.threads).sort(), unboundThreads,
    "unbound global App refuses without implicitly creating or choosing a conversation");
  assert.equal(echoRequests(await events()).length, 0);
  assert.equal(requests.length, 0);
  checks.push("unbound global App requests an explicit conversation without creating a worktree, dispatching a tool or submitting a draft");
  await selectOwner(legacyThread.threadId);
  threadId = legacyThread.threadId;
  await settings();
  await tab("MCP");
  await scopeProject();
  const appDialog = await detailFromResource(mcpRow("plugin"));
  const directoryBeforeRestart = await call("manage", { operation: "mcpApps", projectId, threadId });
  const initialApp = await openAndEchoApp(appDialog, threadId, 1);
  const appOwner = await call("manage", { projectId, threadId, operation: "inspect" });
  assert.deepEqual({ id: appOwner.configuration.profile.id, revision: appOwner.configuration.profile.revision },
    { id: "areal-standard", revision: "resources-00000000" }, "App preserves the selected historical profile binding");
  appEvidence = { initial: initialApp, epochBefore: directoryBeforeRestart.requestEpoch,
    serverBefore: directoryBeforeRestart.data.find(server => server.pluginId === fixture.pluginId) };
  checks.push("interactive App remains reachable from plugin detail and returns the literal echo through an actual sandbox frame and MCP transport");
  await capture("05-plugin-interactive-app");
  const oldDesktop = JSON.parse(await readFile(join(scratch, "core/service.json"), "utf8"));
  const oldCore = await ownedCoreGeneration(workspace);
  const oldElectronPid = app.process().pid;
  await closeSmokeApplication(app);
  app = null;
  await assertApplicationStopped(env.AREAL_CORE_BIN, env, oldDesktop);
  appEvidence.applicationStopped = true;
  await launch();
  await until(async () => (await state()).projects.find(project => project.id === projectId && project.root === workspace)?.state?.connected, "reopened project connected");
  const newDesktop = JSON.parse(await readFile(join(scratch, "core/service.json"), "utf8"));
  const newCore = await ownedCoreGeneration(workspace);
  assert.notEqual(app.process().pid, oldElectronPid, "cold reopen starts a new Electron process");
  assert.notEqual(newDesktop.pid, oldDesktop.pid, "cold reopen starts a new Desktop service process");
  assert.notEqual(newDesktop.desktopGeneration, oldDesktop.desktopGeneration, "cold reopen starts a new Desktop service generation");
  assert.notEqual(newCore.corePid, oldCore.corePid, "cold reopen starts a new Core process");
  assert.notEqual(newCore.generation, oldCore.generation, "cold reopen starts a new Core generation");
  await selectOwner(threadId);
  await settings();
  await tab("Skills");
  skills = await assertSkillOwners();
  await skills.standalone.getByRole("switch", { name: `启用技能 ${fixture.skillId}`, exact: true }).waitFor();
  assert.equal((await resources("skills")).data.find(skill => skill.id === fixture.skillId && skill.scope === "project").enabled, false);
  await detailFromResource(skills.packaged);
  assert.equal((await manage("plugins")).data.find(plugin => plugin.id === fixture.pluginId).installedDigest, installed.installedDigest);
  await closeDetail();
  await tab("MCP");
  await scopeProject();
  await mcpRow("plugin").getByRole("button", { name: "管理插件", exact: true }).waitFor();
  await mcpRow("standalone").getByRole("button", { name: `编辑 MCP ${fixture.standaloneServer}`, exact: true }).waitFor();
  assert.equal(await mcpRow("plugin").getByRole("switch").count(), 0);
  const restoredMcp = (await resources("mcp")).data.find(server => server.id === fixture.standaloneServer);
  assert.equal(restoredMcp.config.transport.command, process.execPath);
  assert.equal(restoredMcp.config.callTimeoutMs, 20000);
  assert.equal(requests.length, 0);
  const restoredPackage = (await manage("pluginMcp")).data.find(plugin => plugin.pluginId === fixture.pluginId);
  assert.equal(restoredPackage.trusted, true, "installed digest trust survives cold restart");
  assert.equal(restoredPackage.installedDigest, installed.installedDigest);
  assert.equal(echoRequests(await events()).length, 1, "cold restart cannot replay the previous Echo");
  const reopenedDetail = await detailFromResource(mcpRow("plugin"));
  const reconnectedPackage = await connectPackage(reopenedDetail);
  assert.equal(reconnectedPackage.trusted, true);
  assert.equal(reconnectedPackage.installedDigest, installed.installedDigest);
  const directoryAfterRestart = await call("manage", { operation: "mcpApps", projectId, threadId });
  assert.equal(typeof directoryBeforeRestart.requestEpoch, "string");
  assert.equal(typeof directoryAfterRestart.requestEpoch, "string");
  assert.notEqual(directoryAfterRestart.requestEpoch, directoryBeforeRestart.requestEpoch, "cold Core restart invalidates the previous App epoch");
  const reopenedApp = await openAndEchoApp(reopenedDetail, threadId, 2);
  assert.notEqual(reopenedApp.frameUrl, initialApp.frameUrl, "explicit reopen uses a new sandbox App token");
  Object.assign(appEvidence, { reopened: reopenedApp, oldElectronPid, newElectronPid: app.process().pid,
    desktopBefore: { pid: oldDesktop.pid, generation: oldDesktop.desktopGeneration },
    desktopAfter: { pid: newDesktop.pid, generation: newDesktop.desktopGeneration }, coreBefore: oldCore, coreAfter: newCore,
    epochBefore: directoryBeforeRestart.requestEpoch, epochAfter: directoryAfterRestart.requestEpoch,
    serverBefore: directoryBeforeRestart.data.find(server => server.pluginId === fixture.pluginId),
    serverAfter: directoryAfterRestart.data.find(server => server.pluginId === fixture.pluginId) });
  checks.push("cold GUI restart stops old Desktop and Core generations, retains resource identity and trust, and explicitly reconnects and reopens App for one new literal Echo without inference or replay");
  await capture("06-reopened-resources");
  const beforeTry = Object.keys((await state()).projects.find(project => project.id === projectId).state.threads).sort();
  await pluginWorkspace();
  await marketAudience("个人");
  await button(`查看插件 ${archivePluginId}`).click();
  await page.getByTestId("plugin-detail-page").getByRole("button", { name: "试用", exact: true }).click();
  await page.getByTestId("chat-input").filter({ hasText: fixture.archiveDisplayName }).waitFor();
  assert.equal((await page.getByTestId("chat-input").innerText()).includes(fixture.archiveDisplayName), true);
  assert.equal(await page.getByRole("button", { name: /^查看技能 / }).count(), 0, "a plugin without Skills cannot attach a fabricated Skill");
  assert.deepEqual(Object.keys((await state()).projects.find(project => project.id === projectId).state.threads).sort(), beforeTry);
  assert.equal(requests.length, 0, "trying a plugin stages a draft without inference");
  checks.push("a plugin without Skills can open an ordinary draft without a fabricated Skill or premature execution");
  await capture("06b-plugin-without-skills-draft");
  // The resource fixture already owns a persisted source conversation. Give the
  // Creator its own empty project so its first ordinary Send owns this path.
  await mkdir(creatorWorkspace);
  execFileSync("git", ["init", "-b", "main"], { cwd: creatorWorkspace, stdio: "ignore" });
  await selectNative(creatorWorkspace);
  await page.evaluate(() => window.arealDesktop.chooseProject());
  await page.getByRole("navigation", { name: "应用导航", exact: true }).getByRole("button", { name: "首页", exact: true }).click();
  await createProjectConversation(page, "creator-workspace");
  const creatorOwner = await until(async () => (await state()).projects.find(project => project.root === creatorWorkspace && project.state?.connected), "isolated Creator project connected");
  projectId = creatorOwner.id;
  assert.equal(Object.keys(creatorOwner.state.threads).length, 0, "Creator first Send starts in an unoccupied project workspace");
  assert.equal(await page.getByTestId("areal-workbench").getAttribute("data-thread-id"), "");
  await page.getByTestId("chat-input").fill("CREATOR_EXISTING_DRAFT");
  await page.evaluate(id => localStorage.setItem(`areal-gui:draft:${id}:new:profile`, JSON.stringify({ id: "areal-standard", revision: "v1" })), projectId);
  await skillWorkspace();
  }
  const creator = await call("resources", { operation: "builtinSkill", id: fixture.creatorId });
  assert.equal(creator.skill.id, fixture.creatorId);
  assert.equal(creator.skill.revision, `builtin-${creatorSource.contentDigest}`);
  assert.deepEqual(creator.provenance, {
    upstream: creatorSource.upstream, revision: creatorSource.revision, contentDigest: creatorSource.contentDigest,
  });
  const beforeCreator = await state();
  const threadIds = value => Object.keys(value.projects.find(project => project.id === projectId).state.threads).sort();
  await button("创建 Skill").click();
  const draft = page.getByTestId("chat-input");
  await draft.filter({ hasText: "CREATOR_EXISTING_DRAFT" }).waitFor();
  await button(`查看技能 ${creator.skill.name} 官方 · OpenAI`).waitFor();
  const draftText = await draft.innerText();
  assert.equal(draftText.includes("CREATOR_EXISTING_DRAFT"), true, "Create Skill preserves the existing ordinary chat draft");
  assert.equal(draftText.includes("Skill Creator"), true);
  assert.equal(draftText.includes(join(creatorWorkspace, ".agents/skills")), true, "creation prompt binds the selected project installation directory");
  assert.equal(await page.getByRole("dialog").count(), 0, "Create Skill enters an ordinary chat draft without a creation form");
  assert.deepEqual(threadIds(await state()), threadIds(beforeCreator), "Create Skill cannot create an execution thread before Send");
  assert.equal(requests.length, 0, "Create Skill cannot invoke the model before Send");
  const boundProfile = JSON.parse(await page.evaluate(id => localStorage.getItem(`areal-gui:draft:${id}:new:profile`), projectId));
  assert.equal(boundProfile.id, "areal-standard");
  assert.notEqual(boundProfile.revision, "v1");
  assert.notEqual(boundProfile.revision, "resources-00000000");
  await capture("07-official-creator-chat-draft");
  await button("发送").click();
  let creatorApprovals = 0;
  await until(async () => {
    if (await page.getByText("CONCEPT_MODEL_REPLY", { exact: true }).isVisible()) return true;
    const approval = page.locator('[data-interaction="approval"]');
    const allow = approval.getByRole("button", { name: "允许一次", exact: true });
    if (await allow.count() && await allow.isVisible()) {
      let enabled = false;
      try { enabled = await allow.isEnabled({ timeout: 250 }); }
      catch (error) { if (await allow.count()) throw error; }
      if (enabled) {
        assert.match(await approval.innerText(), /run_command|fs_create|fs_write|fs_read|skill_read/);
        await allow.click();
        assert.ok(++creatorApprovals <= creatorToolCount, "Creator cannot request more approvals than its bounded tool calls");
      }
    }
    return false;
  }, "official Creator tool chain finishes");
  assert.equal(requests.length, creatorToolCount + 1, "one ordinary turn reads official resources, materializes them through Runtime, initializes and validates the project Skill");
  for (const file of creatorResources)
    assert.equal(sha(await readFile(join(creatorWorkspace, creatorToolRoot, file.name))), file.sha256, "Runtime script copy retains the pinned official bytes");
  checks.push("official Creator resources are paginated through skill_read and copied by Runtime with pinned SHA-256 equality");
  assert.equal(await readFile(join(creatorWorkspace, ".agents/skills", createdSkillId, "SKILL.md"), "utf8"), createdSkillBody);
  await readFile(join(creatorWorkspace, ".agents/skills", createdSkillId, "agents/openai.yaml"), "utf8");
  if (!creatorOnly) assert.equal((await readdir(join(workspace, ".agents/skills"))).includes(createdSkillId), false,
    "Creator cannot install into the earlier resource project's source workspace");
  assert.equal((await readdir(join(userHome, ".agents/skills")).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error))).includes(createdSkillId), false);
  const projectSkills = await resources("skills");
  assert.equal(projectSkills.data.some(skill => skill.id === createdSkillId && skill.scope === "project" && skill.enabled), true, "Agent-created Skill is discovered in the selected project");
  const toolResults = requests.at(-1).messages.filter(message => message.role === "tool").map(message => JSON.stringify(message.content)).join("\n");
  assert.match(toolResults, /Skill is valid!/);
  checks.push("Agent executes official Creator init and validation through Runtime, installs only into selected project .agents/skills, and project discovery lists the new Skill");
  const userText = requests[0].messages.filter(message => message.role === "user").map(message =>
    typeof message.content === "string" ? message.content : (message.content ?? []).map(part => part.text ?? "").join("\n")).join("\n");
  assert.equal(userText.includes("CREATOR_EXISTING_DRAFT"), true);
  assert.equal(userText.includes(creatorBody), true, "the first turn includes the exact verified bundled Creator body");
  assert.equal(userText.includes(`id="${creator.skill.id}" revision="${creator.skill.revision}"`), true,
    "the first turn carries the actual Core builtin reference");
  assert.equal(threadIds(await state()).length, threadIds(beforeCreator).length + 1, "Send creates the ordinary conversation thread");
  const authoringThreadId = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
  const authoring = await call("manage", { projectId, threadId: authoringThreadId, operation: "inspect" });
  assert.deepEqual({ id: authoring.configuration.profile.id, revision: authoring.configuration.profile.revision }, boundProfile, "ordinary created thread uses the exact prepared profile");
  await json(join(scratch, "creator-thread.json"), authoring);
  const authoringCore = await ownedCoreGeneration(creatorWorkspace);
  assert.equal(authoringCore.workspace, creatorWorkspace, "Creator Runtime writes use the selected project's actual source root");
  creatorEvidence = { approvals: creatorApprovals, profile: boundProfile, workspace: creatorWorkspace, core: authoringCore,
    installedSkillRoot: join(creatorWorkspace, ".agents/skills", createdSkillId), skill: creator.skill, provenance: creator.provenance, bodySha256: sha(creatorBody), modelUserTextSha256: sha(userText) };
  checks.push("Create Skill preserves draft input, binds the verified official Creator, starts no execution before Send, and sends its exact body in an ordinary first chat turn");
  await capture("08-official-creator-first-turn");
  assert.deepEqual(errors, []);
  assert.equal(sha(await readFile(env.AREAL_CORE_BIN)), coreSha256, "Core artifact cannot change during acceptance");
  passed = true;
} catch (error) {
  failure = { message: error.message, stack: error.stack };
  process.exitCode = 1;
  if (app) await json(join(scratch, "app-failure-trace.json"), await app.evaluate(() => globalThis.__conceptAppTrace).catch(e => ({ unavailable: e.message })));
  if (page) await captureSmokeFailure(page, scratch, error);
} finally {
  if (app) await closeSmokeApplication(app).catch(error => errors.push(`close GUI: ${error.message}`));
  try { cleanup = await stopService(); }
  catch (error) { cleanup = { error: error.message }; errors.push(`stop owned service: ${error.message}`); }
  await new Promise(resolve => model.close(resolve));
  if (errors.length) { passed = false; process.exitCode = 1; }
  const manifest = {
    passed, checks, errors, failure, scratch, workspace, creatorWorkspace, projectId, pluginProjectId, threadId, fixture, instances, cleanup,
    archive: archiveEvidence, app: appEvidence, creator: creatorEvidence,
    source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    sourceFiles, sourceDiffSha256,
    core: { binary: env.AREAL_CORE_BIN, sha256: coreSha256, unchanged: sha(await readFile(env.AREAL_CORE_BIN)) === coreSha256 },
    mode: creatorOnly ? "creator-only" : "comprehensive", modelRequests: requests.length, auxiliaryRequests,
    scope: creatorOnly ? "source Electron/Main/Core official Creator first ordinary turn in an otherwise unoccupied project workspace; deterministic model; actual Runtime writes and validation; no MCP App, worktree inheritance, package or real-provider acceptance" : "source Electron/Main/Core plugin workspace, reviewed portable local and ZIP plugins, standalone resources, stdio MCP, native App iframe before and after cold Desktop/Core restart, official bundled Creator ordinary chat turn in a separate unoccupied project; deterministic loopback model; no packaged or remote-provider acceptance",
    creatorPython,
    injectedBoundary: "native directory and ZIP selection return isolated fixture paths; explicit Python with PyYAML; auxiliary model requests are fixtures; deterministic loopback model reads official resources with skill_read, materializes those returned bytes through Runtime into authorized workspace scratch, then emits official Creator init, project read/write and validation tool calls, then the literal response",
  };
  await json(join(scratch, "manifest.json"), manifest);
  await json(join(scratch, "model-requests.json"), requests);
  console.log(JSON.stringify(manifest, null, 2));
}
