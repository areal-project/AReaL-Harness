import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { respondToSessionName } from "./model-fixture.mjs";
import { captureSmokeFailure, createProjectConversation, selectConversation } from "./smoke-navigation.mjs";
import { assertApplicationStopped, closeSmokeApplication } from "./application-cleanup.mjs";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), ".."), root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const scratch = await mkdtemp("/private/tmp/areal-gen-ui-"), workspace = join(scratch, "workspace"), user = join(scratch, "user");
await mkdir(workspace); await mkdir(join(user, ".areal"), { recursive: true });
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
const requests = [], checks = [], errors = [], evidence = {};
const lastUser = request => request.messages.findLast(item => item.role === "user" && !(typeof item.content === "string" && item.content.startsWith("AReaL runtime context (not a user request):")));
const promptText = request => { const content = lastUser(request)?.content; return typeof content === "string" ? content : content?.filter(item => item.type === "text").map(item => item.text).join("\n") ?? ""; };
const privateSentinel = `PRIVATE_${randomUUID()}`;
const html = `<script src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"></script><main><h2>Growth explorer</h2><svg id="chart" width="180" height="32" aria-label="Growth mark"></svg><output id="literal">$&amp; $\` $'</output><label for="rate">Rate</label><input id="rate" type="range" min="1" max="20"><output id="value"></output><input id="private" aria-label="Private note"><button id="save">Save parameters</button><button id="ask">Explain selection</button><output id="status"></output></main><script>
d3.select('#chart').append('circle').attr('cx',20).attr('cy',16).attr('r',8).attr('fill','currentColor');
const rate=document.querySelector('#rate'),value=document.querySelector('#value'),status=document.querySelector('#status'),privateNote=document.querySelector('#private');
rate.value=window.zcode.widgetState?.modelContent?.rate??5;value.value=rate.value;privateNote.value=window.zcode.widgetState?.privateContent?.note??'';rate.oninput=()=>value.value=rate.value;
document.querySelector('#save').onclick=async()=>{try{await window.zcode.setWidgetState({modelContent:{rate:Number(rate.value)},privateContent:{note:privateNote.value}});status.textContent='saved';}catch{status.textContent='failed';}};
document.querySelector('#ask').onclick=async()=>{try{await window.zcode.sendFollowUpMessage({prompt:'EXPLAIN_GEN_UI_SELECTION'});status.textContent='requested';}catch{status.textContent='not-sent';}};
</script>`;
const nativeAnswer = '```areal-ui\n' + JSON.stringify({ version: 1, type: "metric", title: "Growth baseline", value: "5", unit: "%" }) + '\n```\n';
const sse = (delta, finish = "stop") => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`;
let modelFailure;
const server = createServer(async (req, res) => {
  try {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); if (respondToSessionName(body, res)) return;
    if (body.messages.some(message => message.role === "system" && typeof message.content === "string" && message.content.startsWith("Predict the next user prompt from the conversation data."))) {
      assert(!body.tools?.length, "prompt prediction does not receive tools");
      evidence.predictions = (evidence.predictions ?? 0) + 1;
      res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(sse({ content: "" })); return;
    }
    if (body.messages.some(message => message.role === "system" && typeof message.content === "string" && message.content.startsWith("AReaL permission review."))) {
      assert(!body.tools?.length, "permission review does not receive tools");
      const packet = JSON.parse(promptText(body));
      assert.equal(packet.tool, "gen_ui_publish");
      assert.deepEqual(packet.arguments, { name: "growth-explorer", html });
      assert.match(packet.digest, /^[a-f0-9]{64}$/);
      (evidence.reviews ??= []).push({ tool: packet.tool, digest: packet.digest, threadId: packet.threadId });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(sse({ content: JSON.stringify({ decision: "allow", reason: "The exact fixture publishes the requested bounded interactive answer.", digest: packet.digest }) }));
      return;
    }
    requests.push(body);
    const userIndex = body.messages.indexOf(lastUser(body));
    const prompt = promptText(body);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (prompt.includes("CREATE_GEN_UI")) {
      assert.equal(body.tools.filter(tool => tool.function?.name === "gen_ui_publish").length, 1, "native publish tool is available");
      const result = body.messages.slice(userIndex + 1).findLast(item => item.role === "tool");
      if (!result) {
        res.end(sse({ tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: { name: "gen_ui_publish", arguments: JSON.stringify({ name: "growth-explorer", html }) } }] }, "tool_calls")); return;
      }
      const artifact = JSON.parse(result.content);
      assert(artifact.path, "publication returns a managed HTML path");
      res.end(sse({ content: `Select a rate. $x^2$\n${nativeAnswer}::visualize${JSON.stringify({ path: artifact.path, title: "Growth explorer" })}` })); return;
    }
    res.end(sse({ content: `GEN_UI_FOLLOWUP_OK ${prompt.split("\n")[0]}` }));
  } catch (error) { modelFailure = error; res.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
await writeFile(join(user, ".areal/config.toml"), `schema_version=1\n[model]\nname="fixture"\n[model.providers.default]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${server.address().port}"\n`);
const binary = process.env.AREAL_CORE_BIN ?? join(root, "target/debug/areal");
const env = { ...process.env, AREAL_GUI_USER_DATA: join(scratch, "electron"), AREAL_CORE_HOME: join(scratch, "core"), AREAL_CORE_USER_HOME: user, AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"), AREAL_CORE_BIN: binary };
for (const key of ["AREAL_CORE_WORKSPACE", "AREAL_CORE_CONFIG", "AREAL_HARNESS_HOME", "AREAL_HARNESS_CONFIG", "AREAL_CORE_DESKTOP_CONFIG"]) delete env[key];
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const source = { head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), diff: sha(execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: root, maxBuffer: 32 * 1024 * 1024 })), binary: sha(await readFile(binary)), buildInfo: JSON.parse(execFileSync(binary, ["build-info"], { encoding: "utf8" })) };
source.files = {};
for (const file of execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean)) {
  if (!file.startsWith("clients/gui/") && !file.startsWith("core/")) continue;
  source.files[file] = sha(await readFile(join(root, file)));
}
let app, page, failure, owner, cleanup;
const { builtinSkill, BUILTIN_SKILL_ID } = require("../app/src/core/builtin-skills.cjs");
await builtinSkill(env.AREAL_CORE_HOME, BUILTIN_SKILL_ID);
async function launch() {
  app = await electron.launch({ executablePath: require("electron"), args: [join(gui, "app")], env, timeout: 120000 });
  page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on("pageerror", error => errors.push(error.message));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await page.waitForFunction(async () => (await window.arealDesktop.snapshot()).connection?.state === "ready");
  await app.evaluate(({ BrowserWindow, dialog }) => { BrowserWindow.getAllWindows()[0].setSize(1440, 960); dialog.showMessageBox = async () => ({ response: 1 }); });
  (evidence.launches ??= []).push({ pid: app.process().pid });
}
async function command(name, request) { const reply = await page.evaluate(({ name, request }) => window.arealDesktop.command(name, request), { name, request }); assert(reply.ok, JSON.stringify(reply)); return reply.value; }
async function until(predicate, label) {
  const end = Date.now() + 30000;
  while (Date.now() < end) { if (modelFailure) throw modelFailure; if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 75)); }
  throw Error(`timeout: ${label}`);
}
const state = () => page.evaluate(() => window.arealDesktop.snapshot());
const project = snapshot => snapshot.projects.find(project => project.root === workspace);
const pane = side => side ? page.getByTestId("side-chat-pane").filter({ visible: true }) : page.getByTestId("chat-view");
async function frame(threadId, side = false) {
  await pane(side).getByTestId("gen-ui-card").first().scrollIntoViewIfNeeded();
  let guest;
  await until(async () => {
    const host = page.locator(`[data-gen-ui-thread="${threadId}"][aria-hidden="false"]`);
    if (!await host.count()) return false;
    const token = await host.first().getAttribute("data-gen-ui-token");
    guest = page.frames().find(frame => frame.url() === `areal-mcp://${token}/view`);
    return guest && await guest.locator("#rate").count();
  }, "generated guest renders");
  return guest;
}
async function completed(threadId, text) {
  await until(async () => {
    const thread = project(await state())?.state?.threads[threadId];
    return requests.some(request => promptText(request).startsWith(text)) && thread?.turns?.at(-1)?.status === "completed";
  }, `completed ${text}`);
}
async function send(text, side = false, threadId = owner.threadId) {
  const input = page.getByTestId(side ? "side-chat-input" : "chat-input"); await input.fill(text);
  await page.getByTestId(side ? "side-chat-send" : "chat-send-button").click();
  if (threadId) await completed(threadId, text);
}
async function save(guest, rate) {
  const before = requests.length;
  await guest.locator("#rate").focus(); await guest.locator("#rate").press("Home");
  for (let step = 1; step < rate; step++) await guest.locator("#rate").press("ArrowRight");
  await guest.locator("#private").fill(privateSentinel);
  await guest.locator("#save").click(); await guest.locator("#status").filter({ hasText: "saved" }).waitFor();
  assert.equal(requests.length, before, "state-only save does not request the model");
}
function assertContext(text, rate) {
  const matches = requests.filter(request => promptText(request).startsWith(text));
  assert.equal(matches.length, 1, `${text} submits once`);
  const prompt = promptText(matches[0]);
  assert.equal(prompt.match(/<untrusted_gen_ui_state>/g)?.length, 1, "current state is appended once");
  const states = JSON.parse(prompt.match(/<untrusted_gen_ui_state>\n(.*?)\n<\/untrusted_gen_ui_state>/s)[1]);
  assert.equal(states.length, 1, "only this viewing conversation's saved artifact enters current parameters");
  assert.deepEqual(states[0].state, { rate });
  assert(!JSON.stringify(matches[0]).includes(privateSentinel), "private guest state never reaches the model");
}
async function confirmFollowup(guest, text, threadId, side = false) {
  const draft = `UNSENT_${side ? "SIDE" : "MAIN"}_DRAFT`;
  const composer = page.getByTestId(side ? "side-chat-input" : "chat-input"); await composer.fill(draft);
  const before = requests.length;
  await guest.locator("#ask").click();
  const confirmation = pane(side).getByTestId("gen-ui-confirm-input"); await confirmation.waitFor(); await confirmation.fill(text);
  assert.equal(requests.length, before, "guest follow-up waits for host confirmation");
  await pane(side).getByTestId("gen-ui-confirm-send").click(); await confirmation.waitFor({ state: "hidden" });
  await completed(threadId, text);
  assert.equal(await composer.innerText(), draft, "guest follow-up preserves unrelated composer draft");
  await composer.fill("");
}
async function rejected(request) {
  const result = await page.evaluate(async request => { try { await window.arealDesktop.mcpApp(request); return false; } catch { return true; } }, request);
  assert.equal(result, true, "unauthorized generated request is rejected by Main");
}
async function closeApplication() {
  const application = app, pid = application.process().pid;
  const cleanupErrors = [];
  try { await closeSmokeApplication(application); } catch (error) { cleanupErrors.push(error.stack); }
  app = undefined;
  try { await assertApplicationStopped(binary, env, { pid }); cleanup = { stopped: true, errors: cleanupErrors }; }
  catch (error) { cleanupErrors.push(error.stack); cleanup = { stopped: false, errors: cleanupErrors }; }
  if (cleanupErrors.length) throw Error(`Cleanup failed: ${cleanupErrors.join("\n")}`);
}

try {
  await launch();
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, workspace);
  await page.evaluate(() => window.arealDesktop.chooseProject());
  await createProjectConversation(page, "workspace");
  owner = await page.getByTestId("areal-workbench").evaluate(el => ({ projectId: el.dataset.projectId, threadId: el.dataset.threadId }));
  await send("CREATE_GEN_UI_MAIN", false, null);
  await until(async () => { owner = await page.getByTestId("areal-workbench").evaluate(el => ({ projectId: el.dataset.projectId, threadId: el.dataset.threadId })); return !!owner.threadId; }, "first conversation admitted");
  await completed(owner.threadId, "CREATE_GEN_UI_MAIN");
  const native = page.locator('[data-content-type="metric"]').first();
  await native.waitFor();
  assert.match(await native.innerText(), /Growth baseline/);
  assert.equal(await native.locator("iframe").count(), 0, "read-only metric stays in trusted native React");
  await page.locator('.katex-mathml math').first().waitFor();
  await native.getByRole("button", { name: "复制内容", exact: true }).click();
  await native.getByText("已复制", { exact: true }).first().waitFor();
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), "Growth baseline：5 %");
  await page.locator('.katex').first().evaluate(el => { const selection = window.getSelection(), range = document.createRange(); range.selectNodeContents(el); selection.removeAllRanges(); selection.addRange(range); });
  await page.keyboard.press("Meta+C");
  assert.match(await app.evaluate(({ clipboard }) => clipboard.readText()), /\$x\^2\$/);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  checks.push("Core assistant message mixes Markdown math, validated native content with semantic copy and an isolated Gen UI reference");
  let guest = await frame(owner.threadId);
  assert.deepEqual(await guest.evaluate(() => ({ node: typeof process, require: typeof require, bridge: typeof window.arealDesktop })), { node: "undefined", require: "undefined", bridge: "undefined" });
  assert.equal(await guest.locator("#chart circle").count(), 1, "copied D3 loads through the offline asset mapping");
  assert.equal(await guest.locator("#literal").innerText(), "$& $` $'", "author dollar strings retain their literal meaning");
  await save(guest, 11); await page.screenshot({ path: join(scratch, "main-saved.png"), animations: "disabled" });
  const oldToken = new URL(guest.url()).hostname;
  await page.reload(); guest = await frame(owner.threadId); assert.equal(await guest.locator("#rate").inputValue(), "11", "reload restores acknowledged state before author scripts");
  await rejected({ operation: "request", token: oldToken, request: { jsonrpc: "2.0", id: 1, method: "zcode/gen-ui/follow-up", params: { prompt: "STALE" } } });
  await closeApplication(); await launch(); await selectConversation(page, owner.threadId); guest = await frame(owner.threadId);
  assert.equal(await guest.locator("#rate").inputValue(), "11", "restart restores state");
  assert.equal(await guest.locator("#private").inputValue(), privateSentinel, "private state restores only in the guest");
  const token = new URL(guest.url()).hostname;
  await rejected({ operation: "request", token, request: { jsonrpc: "2.0", id: 9000, method: "tools/call", params: { name: "fs_read", arguments: {} } } });
  await send("NORMAL_GEN_UI_MAIN"); assertContext("NORMAL_GEN_UI_MAIN", 11);
  guest = await frame(owner.threadId);
  await confirmFollowup(guest, "CONFIRMED_GEN_UI_MAIN", owner.threadId); assertContext("CONFIRMED_GEN_UI_MAIN", 11);
  checks.push("native publication, copied offline D3, literal HTML, sandbox, state-only save, reload/restart, typed and confirmed main context, preserved draft, stale and tool rejection");
  await page.getByRole("button", { name: "任务操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "旁路讨论", exact: true }).click();
  await page.getByTestId("side-chat-input").waitFor();
  await send("CREATE_GEN_UI_SIDE", true, null);
  let sideId;
  await until(async () => { sideId = Object.values(project(await state()).state.threads).find(thread => thread.conversation?.kind === "side")?.id; return !!sideId; }, "Side created");
  await completed(sideId, "CREATE_GEN_UI_SIDE");
  guest = await frame(sideId, true); await save(guest, 7);
  await send("NORMAL_GEN_UI_SIDE", true, sideId); assertContext("NORMAL_GEN_UI_SIDE", 7);
  guest = await frame(sideId, true); await confirmFollowup(guest, "CONFIRMED_GEN_UI_SIDE", sideId, true); assertContext("CONFIRMED_GEN_UI_SIDE", 7);
  const sideRequest = requests.find(request => promptText(request).startsWith("CREATE_GEN_UI_SIDE"));
  const toolNames = sideRequest.tools.map(tool => tool.function.name);
  assert(toolNames.includes("gen_ui_publish")); assert(toolNames.includes("fs_write")); assert(toolNames.includes("run_command"));
  assert.equal(project(await state()).state.threads[sideId].conversation.policy.kind, "sideExecutableV2", "current Side inherits its ordinary execution policy");
  guest = await frame(sideId, true); await page.screenshot({ path: join(scratch, "side-saved.png"), animations: "disabled" });
  const sideToken = new URL(guest.url()).hostname;
  await page.getByRole("button", { name: "关闭面板", exact: true }).click();
  await until(async () => await page.locator(`[data-gen-ui-token="${sideToken}"]`).getAttribute("aria-hidden") === "true", "Side page hidden");
  assert.equal(await guest.evaluate(async () => { try { await window.zcode.sendFollowUpMessage({ prompt: "HIDDEN_SHOULD_NOT_SEND" }); return false; } catch { return true; } }), true, "hidden retained guest cannot send");
  await rejected({ operation: "request", token: sideToken, request: { jsonrpc: "2.0", id: 9001, method: "zcode/gen-ui/follow-up", params: { prompt: "HIDDEN_HOST_DENIAL" } } });
  assert(!requests.some(request => promptText(request).includes("HIDDEN_")));
  checks.push("Side publication with inherited executable tool policy, independent parameters, ordinary and host-confirmed Side follow-ups, hidden guest and Main rejection");
  guest = await frame(owner.threadId);
  await app.evaluate(({ app }, connectionPath) => {
    const read = process.getBuiltinModule("module").createRequire(app.getAppPath() + "/package.json");
    const { ServiceConnection } = read(connectionPath), original = ServiceConnection.prototype.request;
    ServiceConnection.prototype.request = async function(method, params, mutation) {
      const result = await original.call(this, method, params, mutation);
      if (method === "command" && params.name === "send" && params.request.text === "UNKNOWN_GEN_UI_MAIN" && !globalThis.__genUiLost) {
        globalThis.__genUiLost = { requestId: params.request.requestId, threadId: params.request.threadId, accepted: true };
        throw Object.assign(Error("Fixture lost a committed GUI response"), { submissionUnknown: true, requestId: params.request.requestId });
      }
      return result;
    };
  }, join(gui, "app/src/core/service-client.cjs"));
  await guest.locator("#ask").click(); await page.getByTestId("gen-ui-confirm-input").fill("UNKNOWN_GEN_UI_MAIN");
  await page.getByTestId("gen-ui-confirm-send").click();
  await pane(false).getByText("追问未确认完成，请查看会话提交状态。不会自动重发。", { exact: true }).waitFor();
  await completed(owner.threadId, "UNKNOWN_GEN_UI_MAIN"); assertContext("UNKNOWN_GEN_UI_MAIN", 11);
  evidence.lostResponse = await app.evaluate(() => globalThis.__genUiLost);
  assert(evidence.lostResponse?.requestId && evidence.lostResponse.accepted, "original accepted request identity is retained");
  const beforeReload = requests.length;
  await page.reload(); await frame(owner.threadId);
  assert.equal(requests.length, beforeReload, "reload does not replay an unknown guest send");
  await closeApplication(); await launch(); await selectConversation(page, owner.threadId); await frame(owner.threadId);
  assert.equal(requests.length, beforeReload, "restart does not replay an unknown guest send");
  const outcomes = JSON.parse(await readFile(join(env.AREAL_CORE_HOME, `${owner.projectId}-outcomes.json`), "utf8"));
  assert(outcomes[evidence.lostResponse.requestId], "the original shared Desktop receipt survives restart");
  checks.push("lost committed GUI response retains original receipt and has no reload or restart replay");
  assert(!JSON.stringify(requests).includes(privateSentinel));
  assert.equal(errors.length, 0, errors.join("\n"));
} catch (error) { failure = error; if (page) await captureSmokeFailure(page, scratch, error); }
finally {
  if (app) { try { await closeApplication(); } catch (error) { evidence.cleanupError = error.stack; failure ??= error; } }
  await new Promise(resolve => server.close(resolve));
  await writeFile(join(scratch, "requests.json"), JSON.stringify(requests, null, 2));
  await writeFile(join(scratch, "result.json"), JSON.stringify({ source, checks, errors, evidence, cleanup, passed: !failure, failure: failure?.stack }, null, 2));
  console.log(scratch);
}
if (failure) throw failure;
