// M1/M2 公开路径：集成且 GUI、Core 构建完成后运行一次。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, cp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureSmokeFailure, selectConversation } from "./smoke-navigation.mjs";
import { withSmokeDeadline } from "./smoke-deadline.mjs";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const desktop = join(gui, "app");
const require = createRequire(join(desktop, "package.json"));
const { _electron: electron } = require("playwright-core");
const binary = process.env.AREAL_CORE_BIN || join(root, "target/debug/areal");
const evidenceRoot = join(root, ".scratch", "gui-evidence");
await mkdir(evidenceRoot, { recursive: true });
const scratch = await mkdtemp(join(evidenceRoot, "conversation-derivation-"));
// Unix socket 注册路径使用短的隔离目录；录屏和日志仍留在持久证据目录。
const serviceRegistry = await mkdtemp("/private/tmp/scf-svc-");
const workspace = join(scratch, "workspace");
const userHome = join(scratch, "user-home");
await mkdir(workspace);
await mkdir(userHome);
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
const fixturePath = join(workspace, "shared.txt");
await writeFile(fixturePath, "current shared workspace\n");
await writeFile(join(workspace, "raw-result-evidence.txt"), Array.from({ length: 150 }, (_, row) => `finished raw evidence row ${row}\n`).join(""));
execFileSync("git", ["add", "."], { cwd: workspace });
execFileSync("git", ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-m", "fixture"], { cwd: workspace, stdio: "ignore" });
const hash = async path => createHash("sha256").update(await readFile(path)).digest("hex");
const workspaceBefore = await hash(fixturePath);
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const head = `SCF_HEAD_${randomUUID()}`;
const future = `SCF_FUTURE_${randomUUID()}`;
const forkQuestion = `SCF_BRANCH_${randomUUID()}`;
const activeQuestion = `SCF_ACTIVE_${randomUUID()}`;
const unicodeExcerpt = `旁路选区🌊汉字_${randomUUID()}`;
const sideQuestion = `SCF_SIDE_${randomUUID()}`;
const sideFollowUp = `SCF_SIDE_FOLLOW_${randomUUID()}`;
const sideFileQuestion = `SCF_SIDE_FILE_${randomUUID()}`;
const lateSentinel = `SCF_LATE_${randomUUID()}`;
const mainDraftSentinel = `SCF_MAIN_DRAFT_${randomUUID()}`;
const capacitySourceQuestion = `SCF_CAPACITY_SOURCE_${randomUUID()}`;
const capacitySideQuestion = `SCF_CAPACITY_SIDE_${randomUUID()}`;
const streamExcerpt = `SCF_STREAM_${randomUUID()}`;
const heldResponses = new Map();
const toolStarted = join(workspace, "source-tool-started.txt");
const toolRelease = join(workspace, "source-tool-release.txt");
const requests = [];
const events = [];
const checks = [];
const frames = [];
const pageErrors = [];
const electronStderr = [];
let app, page, server, passed = false, failure;
let sourceThreadId, targetThreadId, anchorTurnId, projectId, sandbox, sideThreadId, windowBounds, videoPath, restartVideoPath, firstMutations = [];
let beforeThreadId, activeTurnId, nestedThreadId, rawThreadId, userQuoteSideId;

const sse = answer => [
  { id: "scf-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: answer }, finish_reason: null }] },
  { id: "scf-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
].map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n";
const toolSse = (name, args) => [
  { id: "scf-tool", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `scf-call-${randomUUID()}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
  { id: "scf-tool", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
].map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n";

async function state() { return page.evaluate(() => window.arealDesktop.snapshot()); }
async function showMainConversation() {
  const input = page.getByTestId("chat-input");
  if (!await input.isVisible()) {
    await page.getByRole("region", { name: "旁路讨论" }).getByRole("button", { name: "返回主会话", exact: true }).click();
    await input.waitFor();
  }
}
async function showSideConversation() {
  const input = page.getByRole("region", { name: "旁路讨论" }).getByRole("textbox", { name: "随心输入" });
  if (!await input.isVisible()) {
    await page.getByRole("button", { name: "展开侧边面板", exact: true }).click();
    await input.waitFor();
  }
}
async function until(predicate, label) {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    const snapshot = await state();
    if (await predicate(snapshot)) return snapshot;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error(`Timed out waiting for ${label}`);
}
async function untilFile(path, label) {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    if (await stat(path).then(() => true, () => false)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error(`Timed out waiting for ${label}`);
}
async function shot(name) {
  if (name === "08b-archived-copyable-preview.png") {
    const samples = await page.evaluate(async () => {
      const side = document.querySelector(".side-chat-pane");
      const panel = side?.closest(".panel-content");
      const measure = element => element && ({ height: element.clientHeight, scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop, top: element.getBoundingClientRect().top, inlineHeight: element.style.height });
      const rows = [];
      for (let i = 0; i < 3; i++) {
        await new Promise(requestAnimationFrame);
        const bounds = panel?.getBoundingClientRect();
        rows.push({ panel: measure(panel), messages: measure(side?.querySelector(".messages")),
          space: measure(side?.querySelector(".message-response-space")),
          latest: measure(side?.querySelector('[data-latest-turn="true"]')),
          preview: measure(side?.querySelector('[aria-label="带回预览"]')),
          center: bounds && document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)?.className });
      }
      return rows;
    });
    events.push({ sideVisualGeometry: samples });
    await writeFile(join(scratch, "side-visual-geometry.json"), JSON.stringify(samples, null, 2));
    assert.ok(Math.abs(samples[2].space.height - samples[0].space.height) <= 1,
      "Side response spacer must remain stable across animation frames");
    await page.getByRole("region", { name: "带回预览" }).scrollIntoViewIfNeeded();
  }
  await page.screenshot({ path: join(scratch, name), scale: "css", animations: "disabled" });
  frames.push(name);
}
async function showRelated(pane) {
  const trigger = pane.getByRole("button", { name: "相关侧边讨论", exact: true });
  if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
  await page.getByRole("region", { name: "相关讨论" }).waitFor();
}
async function openSideContext(pane) {
  if (!await pane.locator("details.side-chat-context").getAttribute("open").then(value => value !== null)) await pane.getByText("会话上下文与文件访问", { exact: true }).click();
}
async function composeText(input, text, label, append = false) {
  const prefix = append ? await input.evaluate(element => element.isContentEditable ? element.innerText : element.value) : "";
  if (!append) await input.fill("");
  await input.focus();
  if (append) await input.evaluate(element => {
    const selection = window.getSelection();
    selection.selectAllChildren(element);
    selection.collapseToEnd();
  });
  const before = requests.length;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.debugger.attach("1.3"));
  const command = (method, params) => app.evaluate(async ({ BrowserWindow }, { method, params }) =>
    BrowserWindow.getAllWindows()[0].webContents.debugger.sendCommand(method, params), { method, params });
  try {
    // Chromium 生成真实 composition 事件；候选确认键不应触发提交。
    await command("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
    await input.evaluate(element => element.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", code: "Enter", keyCode: 229, isComposing: true, bubbles: true, cancelable: true,
    })));
    assert.equal(requests.length, before, `${label}: candidate Enter must not submit`);
    await command("Input.insertText", { text });
    assert.equal(await input.evaluate(element => element.isContentEditable ? element.innerText : element.value), prefix + text);
    assert.ok(await input.evaluate(element => document.activeElement === element), `${label}: focus stays in editor`);
  } finally {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.debugger.detach());
  }
}
async function send(text, threadId) {
  const previousCount = threadId ? (await state()).projects[0]?.state?.threads?.[threadId]?.turns?.length ?? 0 : 0;
  const previousRequests = requests.length;
  await page.getByTestId("chat-input").fill(text);
  await page.locator(".composer-dock:not(.side-chat-composer)").getByRole("button", { name: "发送", exact: true }).click();
  await page.waitForFunction(id => {
    const active = document.querySelector('[data-testid="areal-workbench"]')?.dataset.threadId;
    return active && (!id || active === id);
  }, threadId);
  const activeId = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
  assert.ok(activeId);
  if (threadId) assert.equal(activeId, threadId);
  const snapshot = await until(s => {
    const turns = s.projects[0]?.state?.threads?.[activeId]?.turns;
    return turns?.length > previousCount && turns.at(-1)?.status === "completed" && requests.length > previousRequests;
  }, `completed send ${text}`);
  const turns = snapshot.projects[0].state.threads[activeId].turns;
  assert.ok(turns.at(-1)?.id);
  return { threadId: activeId, turnId: turns.at(-1).id };
}
async function stopService(env) {
  // 优先显式停止 Core；失败时只终止此隔离目录注册的服务。
  try {
    const metadata = JSON.parse(await readFile(join(scratch, "core/service.json"), "utf8"));
    const { ServiceConnection } = require(join(desktop, "src/core/service-client.cjs"));
    const connection = new ServiceConnection();
    try {
      await connection.connect(metadata);
      await connection.request("stopService", { protocol: "areal.desktop-service.v1" }, true);
      checks.push("isolated Core service stopped");
      return;
    } finally { connection.close(); }
  } catch (error) { events.push({ cleanupStopError: error.message }); }
  try {
    const instances = JSON.parse(execFileSync(binary, ["service", "list", "--json"], { env, encoding: "utf8", timeout: 30000 }));
    for (const instance of instances) if (instance.workspace === workspace && instance.state !== "stopped") {
      execFileSync(binary, ["service", "stop", "--instance", instance.serviceId, "--cancel", "--json"], { env, timeout: 30000, stdio: "pipe" });
    }
  } catch (error) { events.push({ cleanupCliError: error.message }); }
  try {
    const metadata = JSON.parse(await readFile(join(scratch, "core/service.json"), "utf8"));
    if (Number.isInteger(metadata.pid)) process.kill(metadata.pid, "SIGTERM");
  } catch {}
}

console.log("GUI evidence:", scratch);
const env = {
  ...process.env,
  AREAL_GUI: "workbench", AREAL_BACKEND: "areal", AREAL_CORE_BIN: binary,
  AREAL_CORE_HOME: join(scratch, "core"), AREAL_CORE_USER_HOME: userHome,
  AREAL_HARNESS_SERVICE_HOME: serviceRegistry,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
};
delete env.AREAL_CORE_WORKSPACE;
delete env.AREAL_HARNESS_HOME;
delete env.AREAL_DEV_CONVERSATION_DERIVATION;
try {
  server = createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests.push({ sequence: requests.length + 1, method: req.method, path: req.url, body });
      const lastUser = body.messages?.findLast(message => message.role === "user"
        && !(typeof message.content === "string" && message.content.startsWith("AReaL runtime context (not a user request):")));
      const answer = `FIXTURE_OK_${requests.length}: ${typeof lastUser?.content === "string" ? lastUser.content : "received"}`;
      if ([capacitySourceQuestion, capacitySideQuestion].includes(lastUser?.content)) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        if (lastUser.content === capacitySourceQuestion) {
          res.write(`data: ${JSON.stringify({ id: "scf-held", object: "chat.completion.chunk", choices: [{ index: 0,
            delta: { content: streamExcerpt }, finish_reason: null }] })}\n\n`);
        }
        heldResponses.set(lastUser.content, () => res.end(sse(answer)));
        return;
      }
      if (lastUser?.content === sideFileQuestion && !body.messages.some(message => message.role === "tool")) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(toolSse("fs_read", { path: "workspace://repo/shared.txt" }));
        return;
      }
      // 来源长工具必须由 Core/Runtime 真正执行，文件标记确认其已启动。
      if (lastUser?.content === activeQuestion && !body.messages.some(message => message.role === "tool")) {
        const command = `printf started > '${toolStarted}'; while [ ! -f '${toolRelease}' ]; do sleep 0.1; done; printf finished`;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(toolSse("run_command", { argv: ["/bin/sh", "-c", command], cwd: "workspace://repo", timeoutMs: 120000 }));
        return;
      }
      if (lastUser?.content === activeQuestion && !body.messages.some(message =>
        message.role === "assistant" && message.tool_calls?.some(call => call.function?.name === "read_file"))) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(toolSse("read_file", { path: "workspace://repo/raw-result-evidence.txt", limit: 120 }));
        return;
      }
      if (body.stream === false) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: answer } }] }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(sse(answer));
    } catch (error) {
      events.push({ fixtureError: error.message });
      res.writeHead(400); res.end();
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  const config = join(scratch, "config.toml");
  await writeFile(config, `schema_version=1\n[model]\ncatalog_version=1\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint=${JSON.stringify(endpoint)}\nmodels=[{id="fixture",enabled=true},{id="fixture-alternate",enabled=true}]\n[limits]\nmodel_concurrency=1\n`);
  env.AREAL_CORE_CONFIG = config;
  const deployment = join(scratch, "desktop.json");
  await writeFile(deployment, JSON.stringify({ profiles: [
    { id: "standard", revision: "v1", displayName: "标准", instructions: "Reply with plain text", allowThreadProcesses: true, approvalTools: [], skills: [] },
    { id: "zz-scf-automatic", revision: "v1", displayName: "SCF Automatic", instructions: "", workflow: { id: "scf-flow", revision: "v1" } },
  ], workflows: [{ id: "scf-flow", revision: "v1", displayName: "SCF Flow", plan: {
    objective: "must not start", tasks: [{ id: "one", instruction: "must not execute", writes: [] }],
  } }] }));
  env.AREAL_CORE_DESKTOP_CONFIG = deployment;
  const videoDir = join(scratch, "video");
  await mkdir(videoDir);
  const launchOptions = { executablePath: require("electron"), args: [desktop], env, timeout: 120000,
    recordVideo: { dir: videoDir, size: { width: 1440, height: 960 } } };
  app = await electron.launch(launchOptions);
  app.process().stderr.on("data", chunk => {
    electronStderr.push(String(chunk));
    if (String(chunk).includes("Error")) process.stderr.write(chunk);
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error") events.push({ rendererConsoleError: message.text() }); });
  page.on("crash", () => events.push({ rendererCrashed: true }));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
  windowBounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  sandbox = await app.evaluate(({ BrowserWindow }) => {
    const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration };
  });
  assert.deepEqual(sandbox, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, workspace);
  await page.getByRole("button", { name: "不在项目中工作", exact: true }).click();
  await page.getByRole("menuitem", { name: "新建项目", exact: true }).click();
  await until(s => s.projects[0]?.state?.connected, "project connection");
  projectId = (await state()).projects[0].id;
  // 共享后台独立运行；在真实连接的返回边界记录 Core 已确认的创建键。
  await app.evaluate(({ app }, connectionPath) => {
    const read = process.getBuiltinModule("module").createRequire(app.getAppPath() + "/package.json");
    const { ServiceConnection } = read(connectionPath);
    const original = ServiceConnection.prototype.request;
    globalThis.__scfMutations = [];
    ServiceConnection.prototype.request = async function (method, parameters, mutation) {
      globalThis.__scfConnection = this;
      if (method !== "command") {
        return original.call(this, method, parameters, mutation);
      }
      // 一次性修改出站参数，拒绝结果仍由真实 Core 产生。
      const fixture = globalThis.__scfRejectNext;
      if (fixture === "workflow" && parameters.name === "fork") {
        parameters = { ...parameters, request: { ...parameters.request, target: { agentProfile: { id: "zz-scf-automatic", revision: "v1" } } } };
        globalThis.__scfRejectNext = null;
      } else if (fixture === "selection" && parameters.name === "side" && parameters.request.operation === "start") {
        parameters = { ...parameters, request: { ...parameters.request, selection: { ...parameters.request.selection, textSha256: "0".repeat(64) } } };
        globalThis.__scfRejectNext = null;
      } else if (fixture === "workspace-read" && parameters.name === "side" && parameters.request.operation === "start") {
        parameters = { ...parameters, request: { ...parameters.request, workspaceAccess: "readOnly" } };
        globalThis.__scfRejectNext = null;
      }
      const entry = { command: parameters.name, parameters: parameters.request, accepted: false };
      if (fixture && !globalThis.__scfRejectNext) entry.fixture = fixture;
      globalThis.__scfMutations.push(entry);
      try {
        const result = await original.call(this, method, parameters, mutation);
        entry.accepted = true;
        entry.requestId = result?.requestId ?? parameters.request?.requestId ?? null;
        entry.resultThreadId = result?.threadId ?? result?.thread?.id ?? null;
        if (parameters.name === "media" && result?.bytes) {
          const bytes = Buffer.from(result.bytes, "base64");
          entry.resultSha256 = process.getBuiltinModule("crypto").createHash("sha256").update(bytes).digest("hex");
          entry.resultLength = bytes.length;
        }
        if (parameters.name === "fork" && globalThis.__scfLoseNextForkResponse) {
          globalThis.__scfLoseNextForkResponse = false;
          entry.fixture = "committed GUI response lost";
          throw Object.assign(new Error("SCF fixture: committed GUI response lost"), {
            submissionUnknown: true, requestId: entry.requestId,
          });
        }
        return result;
      } catch (error) { entry.error = error.message; throw error; }
    };
  }, join(desktop, "src/core/service-client.cjs"));
  const first = await send(`${head} ${unicodeExcerpt}`);
  sourceThreadId = first.threadId;
  anchorTurnId = first.turnId;
  const second = await send(future, sourceThreadId);
  assert.notEqual(second.turnId, anchorTurnId);
  assert.equal(requests.length, 2, "plain-text source should require exactly two fixture requests");
  await shot("01-source.png");
  const sourceTurns = (await state()).projects[0].state.threads[sourceThreadId].turns.map(turn => turn.id);
  const beforeCreation = { modelRequests: requests.length, workspaceSha256: await hash(fixturePath) };
  assert.equal(beforeCreation.workspaceSha256, workspaceBefore);
  const anchor = page.locator(`[data-turn-id="${anchorTurnId}"]`);
  await anchor.getByRole("button", { name: "从此轮创建聊天分支", exact: true }).click();
  let forkDialog = page.getByRole("dialog", { name: "从这里创建聊天分支", exact: true });
  await forkDialog.waitFor();
  assert.equal(await forkDialog.getByText("在当前工作树中创建", { exact: true }).count(), 1);
  assert.equal(await forkDialog.getByText("在新工作树中创建", { exact: true }).count(), 0);
  const selectedTarget = await forkDialog.getByLabel("分支目标配置").inputValue();
  await app.evaluate(() => { globalThis.__scfRejectNext = "workflow"; });
  await forkDialog.getByRole("button", { name: "创建分支", exact: true }).click();
  await forkDialog.getByRole("alert").filter({ hasText: "PROFILE_NOT_SUPPORTED" }).waitFor();
  assert.equal(await forkDialog.getByLabel("分支目标配置").inputValue(), selectedTarget);
  assert.equal(requests.length, beforeCreation.modelRequests);
  assert.equal(Object.keys((await state()).projects[0].state.threads).length, 1);
  await shot("01a-fork-config-refusal.png");
  checks.push("AC15/61: actual Core rejects an outbound automatic Workflow target; Fork dialog preserves chosen config without a target or model request");
  const confirmation = await forkDialog.innerText();
  assert.match(confirmation, /共享当前工作区/);
  assert.match(confirmation, /文件不会回滚/);
  events.push({ confirmation });
  assert.equal(await forkDialog.getByLabel("分支目标配置").inputValue(), "inherit");
  await app.evaluate(() => { globalThis.__scfLoseNextForkResponse = true; });
  await forkDialog.getByRole("button", { name: "创建分支", exact: true }).click();
  await forkDialog.getByRole("button", { name: "核对受理结果", exact: true }).waitFor();
  await forkDialog.getByRole("alert").filter({ hasText: "请先核对原提交" }).waitFor();
  assert.equal(await forkDialog.getByRole("button", { name: "创建分支", exact: true }).count(), 0);
  const lostResult = (await app.evaluate(() => globalThis.__scfMutations)).find(entry => entry.fixture === "committed GUI response lost");
  assert.ok(lostResult?.accepted && lostResult.resultThreadId && lostResult.requestId);
  assert.equal(requests.length, beforeCreation.modelRequests);
  assert.equal(Object.keys((await state()).projects[0].state.threads).length, 2);
  await shot("01b-fork-response-unknown.png");
  await forkDialog.getByRole("button", { name: "取消", exact: true }).click();
  await selectConversation(page, lostResult.resultThreadId);
  checks.push("AC27: discarded GUI response after a real committed Fork shows reconciliation instead of resend; exactly one idle target exists and manual navigation opens it");
  await page.locator(".messages .message-column").waitFor();
  targetThreadId = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
  assert.ok(targetThreadId && targetThreadId !== sourceThreadId);
  assert.equal(requests.length, beforeCreation.modelRequests, "fork creation must not call the model");
  assert.equal(await hash(fixturePath), beforeCreation.workspaceSha256, "fork creation must not change files");
  const target = (await state()).projects[0].state.threads[targetThreadId];
  assert.equal(target.conversation?.kind, "fork");
  assert.equal(target.conversation?.origin?.sourceThreadId, sourceThreadId);
  assert.equal(target.conversation?.origin?.sourceTurnId, anchorTurnId);
  assert.equal(target.turns?.length, 0, "target starts with empty local turns");
  const inherited = page.locator(".messages .message-column");
  await inherited.locator(".user-bubble").getByText(`${head} ${unicodeExcerpt}`, { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: /继承历史/ }).count(), 0, "Fork history must be directly visible without a disclosure");
  assert.equal(await inherited.getByText(future, { exact: false }).count(), 0, "future source Turn must not appear in inherited history");
  assert.ok(await inherited.locator(`[data-turn-id="${anchorTurnId}"] .assistant-message-final .conversation-markdown`).count(), "inherited answers reuse the main Markdown component");
  assert.equal((await page.getByTestId("chat-input").innerText()).trim(), "");
  await shot("02-fork-empty.png");
  checks.push("AC01/02/06: older Turn GUI fork is idle, empty, source-owned, current shared workspace and bounded inherited history");
  const requestsBeforeNested = requests.length;
  await inherited.locator(`[data-turn-id="${anchorTurnId}"]`).getByRole("button", { name: /^轮次操作 / }).click();
  await page.getByRole("menuitem", { name: "在此轮之后分支", exact: true }).click();
  await forkDialog.getByRole("button", { name: "创建分支", exact: true }).click();
  await page.waitForFunction(id => {
    const current = document.querySelector('[data-testid="areal-workbench"]')?.dataset.threadId;
    return current && current !== id;
  }, targetThreadId);
  nestedThreadId = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
  const nestedFork = (await state()).projects[0].state.threads[nestedThreadId];
  assert.equal(nestedFork.conversation.origin.sourceThreadId, targetThreadId);
  assert.equal(nestedFork.conversation.historySeed.turnCount, 1);
  assert.equal(nestedFork.turns.length, 0);
  assert.equal(requests.length, requestsBeforeNested);
  await selectConversation(page, targetThreadId);
  checks.push("AC09: inherited Turn menu creates one flattened logical prefix and an empty independent Fork without execution");
  await send(forkQuestion, targetThreadId);
  const branchRequest = requests.at(-1)?.body;
  const branchInput = JSON.stringify(branchRequest?.messages ?? []);
  assert.ok(branchInput.includes(head) && branchInput.includes(forkQuestion), "model input must include selected source prefix and explicit new input");
  assert.ok(!branchInput.includes(future), "model input must exclude future source Turn");
  assert.deepEqual((await state()).projects[0].state.threads[sourceThreadId].turns.map(turn => turn.id), sourceTurns);
  assert.equal(await hash(fixturePath), workspaceBefore);
  await shot("03-fork-sent.png");
  checks.push("AC06: actual model input excludes the future sentinel; explicit send leaves source Turn IDs and workspace bytes unchanged");
  await selectConversation(page, sourceThreadId);
  await page.getByTestId("chat-input").fill(activeQuestion);
  await page.locator(".composer-dock:not(.side-chat-composer)").getByRole("button", { name: "发送", exact: true }).click();
  const running = await until(s => {
    const turn = s.projects[0]?.state?.threads?.[sourceThreadId]?.turns?.at(-1);
    return turn && !sourceTurns.includes(turn.id) && turn.status === "inProgress"
      && JSON.stringify(requests.at(-1)?.body?.messages ?? []).includes(activeQuestion);
  }, "source active Turn at model barrier");
  activeTurnId = running.projects[0].state.threads[sourceThreadId].turns.at(-1).id;
  await untilFile(toolStarted, "Core/Runtime source command marker");
  const sourceProject = (await state()).projects[0];
  const sourceConfig = sourceProject.configurations?.[sourceThreadId];
  assert.ok(Number.isInteger(sourceConfig?.revision) && sourceConfig.revision > 0,
    "source must have an actual Core configuration before retention check");
  assert.equal(requests.at(-1)?.body?.model, "fixture", "the running source request must use the configured fixture model");
  await page.getByTestId("chat-input").fill(mainDraftSentinel);
  await page.locator('.composer-dock input[type="file"]').setInputFiles({ name: "main-attachment.txt", mimeType: "text/plain", buffer: Buffer.from("keep this main attachment") });
  await page.getByTestId("composer-attachments").getByText("main-attachment.txt").waitFor();
  assert.equal(running.projects[0].state.threads[sourceThreadId].turns.at(-1).status, "inProgress");
  checks.push("AC30: source run_command entered the real Core/Runtime process and remains held while Side begins");
  await shot("04-source-tool-running.png");
  // 通过真实消息选区界面选择首个持久轮次中的 Unicode 子串。
  const selectSideExcerpt = async () => page.evaluate(({ turnId, excerpt }) => {
    const turn = document.querySelector(`[data-turn-id="${CSS.escape(turnId)}"]`);
    const body = turn?.querySelector("[data-side-item-id] .conversation-markdown");
    if (!body) throw Error("source message body missing");
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const index = node.textContent.indexOf(excerpt);
      if (index < 0) continue;
      const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + excerpt.length);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return;
    }
    throw Error("Unicode selection was not in one persisted text node");
  }, { turnId: anchorTurnId, excerpt: unicodeExcerpt });
  await selectSideExcerpt();
  const sideTrigger = page.getByRole("button", { name: "在旁路中询问所选内容" });
  await sideTrigger.waitFor();
  await selectConversation(page, targetThreadId);
  assert.equal(await sideTrigger.count(), 0, "来源 A 的选区不能在切换后的 B 会话显示或提交");
  await selectConversation(page, sourceThreadId);
  // 导航会补全默认模型的权威版本；在打开 Side 前固定完整配置基线。
  const refreshedSource = await until(s => {
    const configuration = s.projects[0]?.configurations?.[sourceThreadId];
    return configuration?.model?.providerId === "fixture" && configuration.model.modelId === "fixture"
      || configuration?.model === null && typeof configuration.defaultModelRevision === "string" && configuration.defaultModelRevision.length > 0;
  }, "source configured fixture model restored after navigation");
  const mainConfigBefore = JSON.stringify(refreshedSource.projects[0].configurations[sourceThreadId]);
  await selectSideExcerpt();
  checks.push("AC55: switching the source Thread invalidates the prior Side selection owner");
  await sideTrigger.focus();
  await sideTrigger.evaluate(element => { window.__scfSideTrigger = element; });
  await sideTrigger.press("Enter");
  const sidePane = page.getByRole("region", { name: "旁路讨论" });
  await sidePane.getByText("会话上下文与文件访问", { exact: true }).click();
  await sidePane.locator("blockquote.notice").filter({ hasText: unicodeExcerpt }).waitFor();
  assert.match(await sidePane.innerText(), /已持久化选区/);
  await openSideContext(sidePane);
  await sidePane.getByLabel("文件访问范围").selectOption("none");
  assert.equal(await sidePane.getByLabel("文件访问范围").inputValue(), "none");
  const sideInput = sidePane.getByRole("textbox", { name: "随心输入" });
  assert.equal(await sideInput.getAttribute("contenteditable"), "true", "Side must use the shared Lexical editor");
  assert.ok(await sidePane.locator(".composer-surface").isVisible());
  const sourceConfigBeforeSideModel = JSON.stringify((await state()).projects[0].configurations[sourceThreadId]);
  await sidePane.getByRole("button", { name: "模型", exact: true }).click();
  const modelPage = page.getByRole("button", { name: "选择模型", exact: true });
  if (await modelPage.isVisible()) await modelPage.click();
  await page.locator('[role="radio"][data-model-value="fixture/fixture-alternate"]').click();
  await page.keyboard.press("Escape");
  await sideInput.click();
  await composeText(sideInput, sideQuestion, "Side IME");
  const narrowBounds = await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setSize(980, 800); return win.getBounds(); });
  events.push({ narrowBounds });
  assert.equal(narrowBounds.width, 980, "native window should reach its configured minimum width");
  assert.ok(await sidePane.getByRole("textbox", { name: "随心输入" }).isVisible());
  await page.waitForFunction(() => document.querySelector('[data-workspace-view]')?.dataset.workspaceView === "panel");
  const narrowSideDraft = await sidePane.getByRole("textbox", { name: "随心输入" }).innerText();
  await sidePane.getByRole("button", { name: "返回主会话", exact: true }).click();
  assert.ok(await page.getByTestId("chat-input").isVisible());
  await page.waitForFunction(() => document.activeElement === (window.__scfSideTrigger?.isConnected
    ? window.__scfSideTrigger : document.querySelector('[data-testid="chat-input"]')));
  await page.getByRole("button", { name: "展开侧边面板", exact: true }).click();
  assert.equal(await sidePane.getByRole("textbox", { name: "随心输入" }).innerText(), narrowSideDraft);
  await page.waitForFunction(() => document.querySelector('[data-workspace-view]')?.dataset.workspaceView === "panel");

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
  const sideStartRequests = requests.length;
  await app.evaluate(() => { globalThis.__scfRejectNext = "selection"; });
  await sidePane.getByRole("button", { name: "发送", exact: true }).click();
  await sidePane.getByRole("alert").filter({ hasText: "STALE_SELECTION" }).waitFor();
  assert.equal(await sidePane.getByRole("textbox", { name: "随心输入" }).innerText(), sideQuestion);
  assert.equal(requests.length, sideStartRequests);
  assert.ok(!Object.values((await state()).projects[0].state.threads).some(thread => thread.conversation?.kind === "side"));
  await shot("04a-stale-selection.png");
  checks.push("AC36/61: actual Core rejects a changed selection digest; Side keeps its question and creates no target or model request");
  await sidePane.getByRole("button", { name: "发送", exact: true }).click();
  const sideStarted = await until(s => Object.values(s.projects[0]?.state?.threads ?? {}).some(t =>
    t.conversation?.kind === "side" && t.conversation.origin?.sourceThreadId === sourceThreadId &&
    t.turns?.at(-1)?.status === "completed"), "Side first answer during source Runtime tool");
  const side = Object.values(sideStarted.projects[0].state.threads).find(t => t.conversation?.kind === "side" && t.conversation.origin?.sourceThreadId === sourceThreadId);
  sideThreadId = side.id;
  assert.equal(await page.locator(`#areal-sidebar [data-thread-id="${sideThreadId}"]`).count(), 0,
    "main navigation must exclude Side conversations");
  assert.ok(await page.locator(`#areal-sidebar [data-thread-id="${targetThreadId}"]`).count(),
    "main navigation must retain independent Fork conversations");
  assert.equal(sideStarted.projects[0].configurations[sideThreadId].model.modelId, "fixture-alternate");
  assert.equal(JSON.stringify(sideStarted.projects[0].configurations[sourceThreadId]), sourceConfigBeforeSideModel);
  assert.ok(requests.slice(sideStartRequests).some(request => request.body.model === "fixture-alternate"), "first Side question uses the selected real Core model");
  checks.push("shared Lexical composer and Core model menu: alternate model applies to Side first question without configuring the source");
  assert.equal(side.conversation.policy?.workspaceAccess, "none", "frozen evidence journey uses session-only Side policy");
  assert.equal(side.conversation.selection?.text, unicodeExcerpt);
  assert.equal(side.conversation.selection?.verified, true);
  assert.equal(sideStarted.projects[0].state.threads[sourceThreadId].turns.at(-1).status, "inProgress");
  assert.ok((await readFile(toolStarted, "utf8")).includes("started"));
  const sideModelInput = JSON.stringify(requests.slice(sideStartRequests).flatMap(r => r.body.messages ?? []));
  assert.ok(sideModelInput.includes(sideQuestion) && sideModelInput.includes(unicodeExcerpt));
  assert.ok(!sideModelInput.includes(lateSentinel));
  const firstSideRevision = sideStarted.projects[0].configurations[sideThreadId].revision;
  await sidePane.getByRole("button", { name: "模型", exact: true }).click();
  const sideModelPage = page.getByRole("button", { name: "选择模型", exact: true });
  if (await sideModelPage.isVisible()) await sideModelPage.click();
  await page.locator('[role="radio"][data-model-value="fixture/fixture"]').click();
  await page.keyboard.press("Escape");
  await sidePane.getByRole("textbox", { name: "随心输入" }).click();
  await until(s => s.projects[0].configurations[sideThreadId]?.revision > firstSideRevision && s.projects[0].configurations[sideThreadId]?.model?.modelId === "fixture", "Side model update through Core configure");
  assert.equal(JSON.stringify((await state()).projects[0].configurations[sourceThreadId]), sourceConfigBeforeSideModel);
  assert.equal((await state()).projects[0].state.threads[sideThreadId].conversation.policy.workspaceAccess, "none");
  checks.push("shared model menu configures only an idle Side and preserves its Core read-only policy");
  await openSideContext(sidePane);
  await sidePane.getByRole("button", { name: "查看冻结证据" }).click();
  await sidePane.getByRole("region", { name: "冻结证据" }).locator("pre").filter({ hasText: unicodeExcerpt }).first().waitFor();
  await shot("05-side-answered-frozen.png");
  checks.push("AC30/39: Side answers during a live source Runtime command; Unicode source selection is verified and frozen evidence is visible");
  const beforeBring = { requests: requests.length, commands: (await app.evaluate(() => globalThis.__scfMutations)).length,
    sourceTurns: sideStarted.projects[0].state.threads[sourceThreadId].turns.length,
    sideTurns: side.turns.length, workspaceSha256: await hash(fixturePath) };
  await sidePane.getByRole("button", { name: "带回整条回复" }).first().click();
  const preview = sidePane.getByRole("region", { name: "带回预览" });
  await preview.waitFor();
  const brought = await preview.getByRole("textbox", { name: "编辑带回文字" }).inputValue();
  assert.ok(brought.includes(sideQuestion));
  await preview.getByRole("textbox", { name: "编辑带回文字" }).fill(`${brought}\n保留的编辑`);
  const previewIdentity = await page.evaluate(() => Object.entries(localStorage).find(([key]) => key.endsWith(':bring-back'))?.[1]);
  await sidePane.getByRole("button", { name: "新讨论", exact: true }).click();
  assert.equal(await sidePane.getByRole("region", { name: "带回预览" }).count(), 0);
  await showRelated(sidePane);
  await page.getByRole("region", { name: "相关讨论" }).getByRole("button", { name: new RegExp(sideQuestion) }).click();
  await preview.waitFor();
  assert.equal(await preview.getByRole("textbox", { name: "编辑带回文字" }).inputValue(), `${brought}\n保留的编辑`);
  assert.equal(await page.evaluate(() => Object.entries(localStorage).find(([key]) => key.endsWith(':bring-back'))?.[1]), previewIdentity,
    "switching Side must retain edited text, owner and insertionId");
  const concurrentDraft = `${mainDraftSentinel}\n确认前的并发草稿修改`;
  await showMainConversation();
  await page.getByTestId("chat-input").fill(concurrentDraft);
  await showSideConversation();
  await preview.waitFor();
  const commandsBeforeInsert = (await app.evaluate(() => globalThis.__scfMutations)).length;
  await preview.getByRole("button", { name: "确认插入主草稿" }).click();
  await sidePane.getByText("已追加到更新后的主会话草稿；请检查再发送。", { exact: true }).waitFor();
  const mainDraft = await page.evaluate(key => localStorage.getItem(key), `areal-gui:draft:${projectId}:${sourceThreadId}`);
  assert.ok(mainDraft?.includes(concurrentDraft) && mainDraft.includes(brought),
    "actual main Composer draft must retain its previous text and append the confirmed Side answer");
  assert.equal(requests.length, beforeBring.requests, "bring-back must not send or steer");
  const bringCommands = await app.evaluate(() => globalThis.__scfMutations);
  assert.equal(bringCommands.length, commandsBeforeInsert,
    "confirming bring-back must not issue any Core command, including queue or steer");
  assert.ok(bringCommands.slice(beforeBring.commands).every(entry =>
    entry.command === "side" && entry.parameters.operation === "list"),
  "switching related discussions may only refresh the read-only list before insertion");
  assert.equal((await state()).projects[0].state.threads[sourceThreadId].turns.length, beforeBring.sourceTurns);
  assert.equal((await state()).projects[0].state.threads[sideThreadId].turns.length, beforeBring.sideTurns);
  assert.equal(await hash(fixturePath), beforeBring.workspaceSha256);
  await shot("06-bring-back-draft.png");
  await page.getByRole("button", { name: "关闭面板", exact: true }).click();
  await page.getByTestId("composer-attachments").getByText("main-attachment.txt").waitFor();
  await composeText(page.getByTestId("chat-input"), " 输入法确认🌊汉字", "main IME", true);
  assert.ok((await page.getByTestId("chat-input").innerText()).includes(brought));
  assert.equal(JSON.stringify((await state()).projects[0].configurations?.[sourceThreadId] ?? null), mainConfigBefore,
    "main model configuration must survive Side and bring-back");
  // 关闭面板会记住当前任务的 lastPanel；主窗口的展开按钮恢复同一 Side 标签。
  await page.getByRole("button", { name: "展开侧边面板", exact: true }).click();
  await showRelated(sidePane);
  await page.getByRole("region", { name: "相关讨论" }).getByRole("button", { name: new RegExp(sideQuestion) }).waitFor();
  assert.equal((await state()).projects[0].state.threads[sideThreadId].id, sideThreadId);
  checks.push("AC47/52/53/54/55/74: bring-back appends to the concurrent main draft with its attachment and model; edited preview survives Side switching; Chromium composition Enter submits neither editor; narrow return restores the original trigger or main editor fallback");
  const activeAnchor = page.locator(`[data-turn-id="${activeTurnId}"]`);
  assert.equal(await activeAnchor.getByRole("button", { name: /^轮次操作 / }).count(), 0, "streaming turns have no menu");
  assert.equal(await activeAnchor.getByRole("button", { name: "从此轮创建聊天分支", exact: true }).count(), 0, "streaming turns have no Fork action");
  const requestsBeforeActiveFork = requests.length;
  // Core still supports the safe before boundary; the streaming GUI exposes no action row.
  const beforeResult = await page.evaluate(async ({ projectId, sourceThreadId, activeTurnId }) => window.arealDesktop.command("fork", {
    projectId, sourceThreadId, anchor: { turnId: activeTurnId, boundary: "before" }, workspaceMode: "sharedCurrent"
  }), { projectId, sourceThreadId, activeTurnId });
  assert.ok(beforeResult.ok, JSON.stringify(beforeResult));
  beforeThreadId = beforeResult.value.threadId;
  await selectConversation(page, beforeThreadId);
  const beforeSnapshot = await state();
  const beforeThread = beforeSnapshot.projects[0].state.threads[beforeThreadId];
  assert.equal(beforeThread.conversation?.origin?.sourceTurnId, activeTurnId);
  assert.equal(beforeThread.conversation?.origin?.boundary, "before");
  assert.equal(beforeThread.turns?.length, 0);
  assert.equal(beforeSnapshot.projects[0].state.threads[sourceThreadId].turns.at(-1).status, "inProgress");
  assert.equal(requests.length, requestsBeforeActiveFork);
  const beforeHistory = page.locator(".messages .message-column");
  await beforeHistory.getByText(future, { exact: true }).waitFor();
  assert.equal(await beforeHistory.getByText(activeQuestion, { exact: false }).count(), 0);
  await shot("07-before-active.png");
  await writeFile(toolRelease, "release\n");
  await until(s => s.projects[0]?.state?.threads?.[sourceThreadId]?.turns?.at(-1)?.status === "completed", "source completes independently");
  assert.ok(JSON.stringify((await state()).projects[0].state.threads[sourceThreadId].turns.at(-1)).includes("finished"));
  assert.equal(await hash(fixturePath), workspaceBefore);
  checks.push("AC18/19: active Turn actions are hidden, Core before creates an idle exact prefix, and the source completes independently");
  await selectConversation(page, sourceThreadId);
  const completedTool = (await state()).projects[0].state.threads[sourceThreadId].turns
    .find(turn => turn.id === activeTurnId).items.find(item => item.type === "dynamicToolCall" && item.execution?.resultSnapshot);
  assert.match(completedTool.execution?.resultSnapshot?.uri ?? "", /^areal:\/\/blob\//);
  const requestsBeforeRawFork = requests.length;
  const completedActions = activeAnchor.locator(".message-actions").filter({ has: page.getByRole("button", { name: "从此轮创建聊天分支", exact: true }) });
  assert.equal(await completedActions.getByRole("button", { name: "复制消息", exact: true }).count(), 1, "completed Fork and copy share one action row");
  await activeAnchor.getByRole("button", { name: /^轮次操作 / }).click();
  await page.getByRole("menuitem", { name: "在此轮之后分支", exact: true }).click();
  await forkDialog.getByRole("button", { name: "创建分支", exact: true }).click();
  await page.waitForFunction(id => document.querySelector('[data-testid="areal-workbench"]')?.dataset.threadId !== id, sourceThreadId);
  rawThreadId = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
  const rawHistory = page.locator(".messages .message-column");
  await rawHistory.getByRole("button", { name: /^用时 / }).last().click();
  await rawHistory.locator(`[data-turn-id="${activeTurnId}"]`).getByRole("button", { name: "执行过程", exact: true }).click();
  await rawHistory.locator(`[data-tool-id="${completedTool.id}"]`).getByRole("button").first().click();
  const rawDownload = rawHistory.getByRole("button", { name: "下载附件 原始结果", exact: true });
  await rawDownload.waitFor();
  assert.equal(await rawHistory.getByRole("button", { name: /^(批准|拒绝|停止|终止|重试)/ }).count(), 0);
  const rawRead = (await app.evaluate(() => globalThis.__scfMutations)).find(entry => entry.command === "media"
    && entry.parameters.threadId === rawThreadId && entry.parameters.uri === completedTool.execution.resultSnapshot.uri && entry.accepted);
  assert.ok(rawRead?.resultSha256 && rawRead.resultLength > 0);
  const rawPath = join(scratch, "inherited-raw-result.json");
  await app.evaluate(({ BrowserWindow }, path) => {
    globalThis.__scfDownload = null;
    BrowserWindow.getAllWindows()[0].webContents.session.once("will-download", (_event, item) => {
      item.setSavePath(path);
      item.once("done", (_event, state) => { globalThis.__scfDownload = { state, path: item.getSavePath() }; });
    });
  }, rawPath);
  await rawDownload.click();
  await until(async () => (await app.evaluate(() => globalThis.__scfDownload))?.state === "completed", "native raw-result download");
  assert.equal(await hash(rawPath), rawRead.resultSha256);
  assert.ok(Object.keys(JSON.parse(await readFile(rawPath, "utf8"))).length);
  assert.equal((await state()).projects[0].state.threads[rawThreadId].turns.length, 0);
  assert.equal(requests.length, requestsBeforeRawFork);
  await shot("07b-inherited-raw-result.png");
  checks.push("AC13/16: inherited raw Runtime result is read under the target identity and downloaded byte-for-byte; history has no source controls and the Fork has no local execution");
  await selectConversation(page, sourceThreadId);
  const beforeFileRefusal = { requests: requests.length,
    turns: (await state()).projects[0].state.threads[sourceThreadId].turns.length };
  await page.getByTestId("chat-input").fill(lateSentinel);
  await page.locator(".composer-dock:not(.side-chat-composer)").getByRole("button", { name: "发送", exact: true }).click();
  await page.getByText("model does not support File input", { exact: true }).first().waitFor();
  assert.equal(requests.length, beforeFileRefusal.requests);
  assert.equal((await state()).projects[0].state.threads[sourceThreadId].turns.length, beforeFileRefusal.turns);
  assert.equal(await page.getByTestId("chat-input").innerText(), lateSentinel);
  assert.ok(!(await sidePane.innerText()).includes("model does not support File input"));
  await page.getByTestId("composer-attachments").getByText("main-attachment.txt").waitFor();
  await shot("07a-main-error-isolated.png");
  await page.getByRole("button", { name: "移除附件 main-attachment.txt", exact: true }).click();
  checks.push("AC74: real Core modality refusal preserves the main draft and attachment without a Turn/request; Side history and error state remain independent");
  const late = await send(lateSentinel, sourceThreadId);
  assert.ok(late.turnId);
  assert.match(await sidePane.innerText(), /来源已推进/);
  const previousSideTurns = (await state()).projects[0].state.threads[sideThreadId].turns.length;
  const followStart = requests.length;
  await sidePane.getByRole("textbox", { name: "随心输入" }).fill(sideFollowUp);
  await sidePane.getByRole("button", { name: "发送", exact: true }).click();
  await until(s => s.projects[0]?.state?.threads?.[sideThreadId]?.turns?.length > previousSideTurns &&
    s.projects[0].state.threads[sideThreadId].turns.at(-1).status === "completed", "Side follow-up from frozen history");
  const followInput = JSON.stringify(requests.slice(followStart).flatMap(request => request.body.messages ?? []));
  assert.ok(followInput.includes(sideFollowUp) && followInput.includes(sideQuestion));
  assert.ok(!followInput.includes(lateSentinel), "later source Turn must never enter old Side model context");
  await openSideContext(sidePane);
  await sidePane.getByRole("button", { name: "查看冻结证据" }).click();
  const frozen = await sidePane.getByRole("region", { name: "冻结证据" }).innerText();
  assert.ok(frozen.includes(unicodeExcerpt) && !frozen.includes(lateSentinel));
  await shot("08-side-after-source-progress.png");
  checks.push("AC39: later source sentinel is excluded from old Side follow-up model request and paged frozen evidence");
  await showRelated(sidePane);
  const related = page.getByRole("region", { name: "相关讨论" });
  await showRelated(sidePane);
  await related.getByRole("button", { name: "刷新" }).click();
  await sidePane.getByRole("button", { name: "带回整条回复" }).first().click();
  await preview.getByRole("status").filter({ hasText: "来源在旁路创建后已推进" }).waitFor();
  const editedOldReference = `${await preview.getByRole("textbox", { name: "编辑带回文字" }).inputValue()}\n有用的结论仍保留 [旧引用](areal://missing-reference)`;
  await preview.getByRole("textbox", { name: "编辑带回文字" }).fill(editedOldReference);
  const draftBeforeArchivedInsert = await page.getByTestId("chat-input").innerText();
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  await showRelated(sidePane);
  await related.getByRole("button", { name: "归档", exact: true }).click();
  await until(s => s.projects[0]?.state?.threads?.[sideThreadId]?.desktop?.archived === true, "Side archived");
  assert.equal(await sidePane.getByRole("textbox", { name: "随心输入" }).getAttribute("contenteditable"), "false");
  await preview.getByRole("button", { name: "确认插入主草稿" }).click();
  await sidePane.getByText("来源或目标已变化，未写入草稿。可复制预览文字。", { exact: true }).waitFor();
  assert.equal(await page.getByTestId("chat-input").innerText(), draftBeforeArchivedInsert);
  assert.equal(await preview.getByRole("textbox", { name: "编辑带回文字" }).inputValue(), editedOldReference);
  const priorClipboard = await app.evaluate(({ clipboard }) => clipboard.readText());
  await app.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.show(); app.focus({ steal: true }); window.focus();
  });
  await preview.getByRole("button", { name: "复制文字", exact: true }).click();
  await sidePane.getByText("已复制带回文字。", { exact: true }).waitFor();
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), editedOldReference);
  await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), priorClipboard);
  await shot("08b-archived-copyable-preview.png");
  checks.push("AC40/55/56: old snapshot warning survives source progress; archived Side cannot insert, edited useful text and invalid link remain copyable through the real clipboard");
  await showRelated(sidePane);
  await related.getByRole("checkbox", { name: "包含已归档" }).check();
  await showRelated(sidePane);
  await related.getByRole("button", { name: /已归档/ }).waitFor();
  await showRelated(sidePane);
  await related.getByRole("button", { name: "恢复", exact: true }).click();
  await until(s => s.projects[0]?.state?.threads?.[sideThreadId]?.desktop?.archived === false, "Side unarchived");
  assert.equal((await state()).projects[0].state.threads[sideThreadId].turns.length, previousSideTurns + 1);
  checks.push("AC48/51: archived Side is listed under related discussions and explicitly restored without a new Turn");
  await sidePane.getByRole("button", { name: "新讨论", exact: true }).click();
  if (env.AREAL_CORE_SANDBOX_PROFILE === "native") {
    assert.equal((await state()).projects[0].core?.features?.sideWorkspaceRead, true,
      "explicit native deployment must expose verified Side workspace read");
  }
  if ((await state()).projects[0].core?.features?.sideWorkspaceRead === true) {
  await openSideContext(sidePane);
  await sidePane.getByLabel("文件访问范围").selectOption("readOnly");
  await sidePane.getByRole("textbox", { name: "随心输入" }).fill(sideFileQuestion);
  await sidePane.getByRole("button", { name: "发送", exact: true }).click();
  const fileSideState = await until(s => Object.values(s.projects[0].state.threads).some(thread =>
    thread.conversation?.kind === "side" && thread.conversation.policy?.workspaceAccess === "readOnly"
    && thread.turns?.at(-1)?.status === "completed"), "native read-only Side completion");
  const fileSide = Object.values(fileSideState.projects[0].state.threads).find(thread => thread.conversation?.kind === "side"
    && thread.conversation.policy?.workspaceAccess === "readOnly");
  const fileResult = fileSide.turns.at(-1).items.find(item => item.type === "dynamicToolCall" && item.tool === "fs_read");
  assert.equal(JSON.parse(fileResult.contentItems.find(item => item.type === "inputText").text).source, "currentWorkspace");
  await openSideContext(sidePane);
  await sidePane.getByText(/可只读查询当前工作区；文件内容可能与历史锚点不同/).waitFor();
  assert.equal(await hash(fixturePath), workspaceBefore);
  await shot("08c-side-current-workspace.png");
  checks.push("AC41/46: explicit readOnly Side performs real native fs_read with currentWorkspace provenance and current-file UI notice; explicit none journey remains separate and file bytes are unchanged");
  } else {
    const question = "工作区只读不可用时，只讨论冻结会话证据";
    const before = { count: Object.keys((await state()).projects[0].state.threads).length, requests: requests.length };
    await openSideContext(sidePane);
    await sidePane.getByText(/当前 Core 未提供经过验证的工作区只读能力/).waitFor();
    await sidePane.getByRole("textbox", { name: "随心输入" }).fill(question);
    await app.evaluate(() => { globalThis.__scfRejectNext = "workspace-read"; });
    await sidePane.getByRole("button", { name: "发送", exact: true }).click();
    await sidePane.getByRole("alert").filter({ hasText: "WORKSPACE_READ_UNAVAILABLE" }).waitFor();
    assert.equal(await sidePane.getByRole("textbox", { name: "随心输入" }).innerText(), question);
    assert.equal(Object.keys((await state()).projects[0].state.threads).length, before.count);
    assert.equal(requests.length, before.requests);
    await openSideContext(sidePane);
  await sidePane.getByLabel("文件访问范围").selectOption("none");
    await sidePane.getByRole("button", { name: "发送", exact: true }).click();
    await until(s => Object.values(s.projects[0].state.threads).some(thread => thread.conversation?.kind === "side"
      && thread.preview === question && thread.turns?.at(-1)?.status === "completed"), "explicit evidence-only Side after read-only refusal");
    await shot("08d-side-workspace-unavailable.png");
    checks.push("AC46: unavailable native workspace read is explicitly refused by Core, GUI retains question, explicit none creates an evidence-only Side with no silent fallback");
  }
  await showRelated(sidePane);
  await related.getByRole("button", { name: new RegExp(sideQuestion) }).click();
  // 单模型名额由真实 HTTP 流占用；验证两边的停止都不取消另一会话。
  await showMainConversation();
  await page.getByTestId("chat-input").fill(capacitySourceQuestion);
  await page.locator(".composer-dock:not(.side-chat-composer)").getByRole("button", { name: "发送", exact: true }).click();
  await until(s => heldResponses.has(capacitySourceQuestion)
    && s.projects[0]?.state?.threads?.[sourceThreadId]?.turns?.at(-1)?.status === "inProgress", "source owns the single model slot");
  const streamingTurnId = (await state()).projects[0].state.threads[sourceThreadId].turns.at(-1).id;
  await page.locator(`[data-turn-id="${streamingTurnId}"] .assistant-message .conversation-markdown`).getByText(streamExcerpt, { exact: true }).waitFor();
  await page.evaluate(({ turnId, excerpt }) => {
    const body = document.querySelector(`[data-turn-id="${CSS.escape(turnId)}"] .assistant-message .conversation-markdown`);
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const start = node.textContent.indexOf(excerpt);
      if (start < 0) continue;
      const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + excerpt.length);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return;
    }
    throw Error("streamed source text missing");
  }, { turnId: streamingTurnId, excerpt: streamExcerpt });
  await page.getByRole("button", { name: "在旁路中询问所选内容" }).click();
  await openSideContext(sidePane);
  await sidePane.locator("blockquote.notice").filter({ hasText: "用户引文，来源未确认" }).waitFor();
  await openSideContext(sidePane);
  await sidePane.getByLabel("文件访问范围").selectOption("none");
  await sidePane.getByRole("textbox", { name: "随心输入" }).fill("等待模型名额的旁路问题");
  await sidePane.getByRole("button", { name: "发送", exact: true }).click();
  const quoteState = await until(s => Object.values(s.projects[0].state.threads).some(thread =>
    thread.conversation?.selection?.text === streamExcerpt && thread.desktop?.sideCapacityStatus === "waiting"), "Side waits for model capacity");
  const quotedSide = Object.values(quoteState.projects[0].state.threads).find(thread => thread.conversation?.selection?.text === streamExcerpt);
  userQuoteSideId = quotedSide.id;
  assert.equal(quotedSide.conversation.selection.verified, false);
  assert.equal(quotedSide.conversation.selection.selection.kind, "userQuote");
  const persistedQuote = JSON.parse(await readFile(join(scratch, "core", projectId, "state", `${userQuoteSideId}.json`), "utf8"));
  assert.deepEqual(persistedQuote.thread.conversation.selection, quotedSide.conversation.selection);
  await openSideContext(sidePane);
  await sidePane.getByRole("button", { name: "查看冻结证据", exact: true }).click();
  const quoteEvidence = sidePane.getByRole("region", { name: "冻结证据", exact: true });
  await quoteEvidence.waitFor();
  while (await quoteEvidence.getByRole("button", { name: "继续加载证据", exact: true }).count()) {
    await quoteEvidence.getByRole("button", { name: "继续加载证据", exact: true }).click();
    await until(async () => !await quoteEvidence.getByRole("button", { name: "继续加载证据", exact: true }).isDisabled().catch(() => false), "frozen evidence page");
  }
  const quotedEvidenceText = await quoteEvidence.innerText();
  assert.ok(quotedEvidenceText.includes(capacitySourceQuestion) && quotedEvidenceText.includes("inProgress"));
  assert.ok(!quotedEvidenceText.includes(streamExcerpt), "unpersisted streamed text is only a user quote, not frozen source evidence");
  await shot("08e-streaming-user-quote.png");
  checks.push("AC37: actual streamed plain text is an unverified userQuote; durable Side selection preserves the text while frozen inProgress evidence excludes the unpersisted delta");
  await sidePane.getByRole("status").filter({ hasText: "等待模型容量" }).waitFor();
  await shot("08a-side-waiting-capacity.png");
  await sidePane.getByRole("button", { name: "停止旁路", exact: true }).click();
  await until(s => s.projects[0]?.state?.threads?.[userQuoteSideId]?.turns?.at(-1)?.status === "interrupted", "waiting Side stops independently");
  assert.equal((await state()).projects[0].state.threads[sourceThreadId].turns.at(-1).status, "inProgress");
  heldResponses.get(capacitySourceQuestion)(); heldResponses.delete(capacitySourceQuestion);
  await until(s => s.projects[0]?.state?.threads?.[sourceThreadId]?.turns?.at(-1)?.status === "completed", "source retains and releases its model slot");
  await showRelated(sidePane);
  await related.getByRole("button", { name: new RegExp(sideQuestion) }).click();
  await sidePane.getByRole("textbox", { name: "随心输入" }).fill(capacitySideQuestion);
  await sidePane.getByRole("button", { name: "发送", exact: true }).click();
  await until(s => heldResponses.has(capacitySideQuestion)
    && s.projects[0]?.state?.threads?.[sideThreadId]?.desktop?.sideCapacityStatus === "available", "Side owns the single model slot");
  await showMainConversation();
  await page.getByTestId("chat-input").fill("等待模型名额的来源问题");
  await page.locator(".composer-dock:not(.side-chat-composer)").getByRole("button", { name: "发送", exact: true }).click();
  await until(s => s.projects[0]?.state?.threads?.[sourceThreadId]?.turns?.at(-1)?.status === "inProgress", "source waits while Side runs");
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await until(s => s.projects[0]?.state?.threads?.[sourceThreadId]?.turns?.at(-1)?.status === "interrupted", "source stops independently");
  assert.equal((await state()).projects[0].state.threads[sideThreadId].turns.at(-1).status, "inProgress");
  heldResponses.get(capacitySideQuestion)(); heldResponses.delete(capacitySideQuestion);
  await until(s => s.projects[0]?.state?.threads?.[sideThreadId]?.turns?.at(-1)?.status === "completed", "Side completes after source Stop");
  checks.push("AC34/50/72: visible single-slot waiting, independent Side Stop and source Stop, no deadlock or cancellation cascade");
  await showSideConversation();
  const beforeDisconnect = (await state()).projects[0];
  await app.evaluate(() => globalThis.__scfConnection.socket.terminate());
  await until(s => s.connection?.state === "unavailable", "GUI-to-Core transport disconnect");
  await openSideContext(sidePane);
  await sidePane.getByText(/^来源：.*来源当前状态未知/).waitFor();
  await page.getByRole("button", { name: "重新连接后台" }).click();
  const reconnected = await until(s => s.connection?.state === "ready" && s.projects[0]?.state?.connected &&
    s.projects[0]?.state?.threads?.[sourceThreadId]?.turns?.length === beforeDisconnect.state.threads[sourceThreadId].turns.length &&
    s.projects[0]?.state?.threads?.[sideThreadId]?.turns?.length === beforeDisconnect.state.threads[sideThreadId].turns.length,
  "GUI-to-Core reconnection and authoritative source/Side snapshot");
  assert.equal(reconnected.projects[0].state.threads[sideThreadId].conversation.origin.sourceThreadId, sourceThreadId);
  assert.equal(reconnected.projects[0].state.threads[sourceThreadId].conversation?.kind ?? "main", "main");
  checks.push("AC49: real GUI transport disconnect/reconnect restored distinct source and Side identities without duplicate Turns");
  // 重启使用同一隔离状态目录，并另行标记第二段连续录屏。
  const preRestart = { sourceTurns: (await state()).projects[0].state.threads[sourceThreadId].turns.length,
    sideTurns: (await state()).projects[0].state.threads[sideThreadId].turns.length, requests: requests.length };
  firstMutations = await app.evaluate(() => globalThis.__scfMutations);
  const forkResults = firstMutations.filter(entry => entry.command === "fork" && entry.accepted);
  assert.deepEqual(forkResults.map(entry => entry.resultThreadId), [targetThreadId, nestedThreadId, beforeThreadId, rawThreadId]);
  assert.ok(forkResults.every(entry => typeof entry.requestId === "string" && entry.requestId.length > 0));
  assert.equal(new Set(forkResults.map(entry => entry.requestId)).size, 4);
  videoPath = await page.video()?.path();
  await app.close();
  await stopService(env);
  // 复用持久状态故障接缝：只在隔离 Core 安全停止后标记既有来源工具为 UNKNOWN。
  const sourceRecordPath = join(scratch, "core", projectId, "state", `${sourceThreadId}.json`);
  const sourceRecord = JSON.parse(await readFile(sourceRecordPath, "utf8"));
  const unknownItem = sourceRecord.thread.turns.find(turn => turn.id === activeTurnId).items
    .find(item => item.type === "dynamicToolCall" && item.tool === "run_command");
  assert.equal(unknownItem.execution.outcome, "succeeded");
  unknownItem.execution.outcome = "unknown";
  delete unknownItem.execution.inspection;
  await writeFile(sourceRecordPath, JSON.stringify(sourceRecord));
  events.push({ persistedUnknownFixture: { sourceThreadId, turnId: activeTurnId, itemId: unknownItem.id,
    seam: "existing completed tool record altered only after safe Core stop; no real crash claim" } });
  app = await electron.launch(launchOptions);
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", error => pageErrors.push(error.message));
  forkDialog = page.getByRole("dialog", { name: "从这里创建聊天分支", exact: true });
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await until(s => s.projects.some(project => project.id === projectId && project.state?.connected), "restarted Core connection");
  await selectConversation(page, sourceThreadId);
  await page.getByRole("button", { name: "任务操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "旁路讨论", exact: true }).click();
  await showRelated(page.getByRole("region", { name: "旁路讨论" }));
  await page.getByRole("region", { name: "相关讨论" }).getByRole("button", { name: new RegExp(sideQuestion) }).click();
  const restored = await until(s => s.projects[0]?.state?.threads?.[sourceThreadId]?.turns?.length === preRestart.sourceTurns &&
    s.projects[0]?.state?.threads?.[sideThreadId]?.turns?.length === preRestart.sideTurns, "restarted source and Side identity");
  assert.equal(restored.projects[0].state.threads[sideThreadId].conversation.origin.sourceThreadId, sourceThreadId);
  assert.equal(requests.length, preRestart.requests, "restart must not repeat unknown Side submission");
  restartVideoPath = await page.video()?.path();
  await shot("09-restarted-identities.png");
  checks.push("AC47: Electron restart restored the same sent Side and source Turn IDs without another model request");
  const unknownDraft = "保持草稿，先检查来源未知结果";
  await showMainConversation();
  await page.getByTestId("chat-input").fill(unknownDraft);
  await page.locator(`[data-turn-id="${activeTurnId}"]`).getByRole("button", { name: /^轮次操作 / }).click();
  assert.ok(await page.getByRole("menuitem", { name: "在此轮之后分支", exact: true }).isDisabled());
  await page.getByText("历史包含未结算或未核查的操作；请在来源核查或选择更早边界", { exact: true }).waitFor();
  await page.getByRole("menuitem", { name: "查看来源轮次的核查入口", exact: true }).waitFor();
  assert.equal(await page.getByTestId("chat-input").innerText(), unknownDraft);
  await shot("10-unknown-source-refusal.png");
  await page.getByRole("menuitem", { name: "在此轮之前分支", exact: true }).click();
  await forkDialog.getByText(/此轮之前冻结历史/).waitFor();
  await forkDialog.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(requests.length, preRestart.requests);
  checks.push("AC21: real restarted Core restores persisted UNKNOWN; GUI disables the unsafe boundary, offers source inspection, retains the draft and leaves the earlier boundary available without execution");
  await selectConversation(page, rawThreadId);
  await page.getByTestId("chat-input").fill("冷历史损坏时保留这份草稿");
  const corruptHistory = page.locator(".messages .message-column");
  await corruptHistory.locator(`[data-turn-id="${activeTurnId}"]`).getByRole("button", { name: /^轮次操作 / }).click();
  await page.getByRole("menuitem", { name: "在此轮之后分支", exact: true }).click();
  const rawSnapshot = (await state()).projects[0].state.threads[rawThreadId].conversation.historySeed.snapshotId;
  const snapshotPath = join(scratch, "core", projectId, "state", "history", rawSnapshot);
  const validSnapshotBytes = await readFile(snapshotPath);
  const countBeforeCorruptFork = Object.keys((await state()).projects[0].state.threads).length;
  try {
    await writeFile(snapshotPath, "SCF isolated corrupt snapshot fixture\n");
    await forkDialog.getByRole("button", { name: "创建分支", exact: true }).click();
    await forkDialog.getByRole("alert").waitFor();
    assert.equal(await page.getByTestId("chat-input").innerText(), "冷历史损坏时保留这份草稿");
    assert.equal(Object.keys((await state()).projects[0].state.threads).length, countBeforeCorruptFork);
    assert.equal(requests.length, preRestart.requests);
    await shot("11-corrupt-history-refusal.png");
    events.push({ corruptSnapshotFixture: { path: snapshotPath, error: await forkDialog.getByRole("alert").innerText(), restored: true } });
  } finally { await writeFile(snapshotPath, validSnapshotBytes); }
  await forkDialog.getByRole("button", { name: "取消", exact: true }).click();
  checks.push("AC11: actual frozen-history corruption is refused in the Fork dialog without a target or execution; source draft survives and original snapshot bytes are restored");
  assert.deepEqual(pageErrors, []);
  passed = true;
} catch (error) {
  failure = error.stack ?? String(error);
  console.error(error);
  await writeFile(join(scratch, "failure.log"), [failure, ...electronStderr, ...pageErrors].join("\n"));
  if (app) try {
    events.push({ failureWindows: await withSmokeDeadline("native window diagnostics", () => app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map(window => ({ url: window.webContents.getURL(), visible: window.isVisible(),
        loading: window.webContents.isLoading(), crashed: window.webContents.isCrashed() })))) });
  } catch (diagnosticError) { events.push({ windowDiagnosticError: diagnosticError.message }); }
  if (page) frames.push(...(await captureSmokeFailure(page, scratch, error)).filter(name => name.endsWith(".png")));
  process.exitCode = 1;
} finally {
  await writeFile(toolRelease, "cleanup\n");
  for (const release of heldResponses.values()) release();
  heldResponses.clear();
  if (app) {
    if (!firstMutations.length) try { firstMutations = await withSmokeDeadline("mutation evidence", () => app.evaluate(() => globalThis.__scfMutations ?? [])); } catch (error) { events.push({ requestCaptureError: error.message }); }
    try {
      await withSmokeDeadline("Electron cleanup", async () => {
        await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
        if (videoPath) restartVideoPath = await page?.video()?.path();
        else videoPath = await page?.video()?.path();
        await app.close();
      }, 20000);
    } catch (error) {
      events.push({ electronCloseError: error.message }); process.exitCode = 1;
      try { app.process()?.kill("SIGTERM"); } catch {}
    }
  }
  await stopService(env);
  await cp(serviceRegistry, join(scratch, "service-registry"), { recursive: true }).catch(error => events.push({ registryEvidenceCopyError: error.message }));
  await rm(serviceRegistry, { recursive: true, force: true });
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  const videos = await readdir(join(scratch, "video")).catch(() => []);
  if (!videoPath && videos.length === 1) videoPath = join(scratch, "video", videos[0]);
  const sourceDiff = execFileSync("git", ["diff", "--binary"], { cwd: root });
  const sourceStatus = execFileSync("git", ["status", "--porcelain=v1"], { cwd: root, encoding: "utf8" });
  const manifest = {
    passed, failure, checks, events, pageErrors, electronStderr, frames, sourceCommit,
    command: "pnpm --dir clients/gui run test:conversation-derivation",
    runtime: "source Electron renderer + Rust Core + actual Runtime run_command + deterministic local HTTP/SSE model",
    limitations: ["local fixture model, not a real provider", "source build, not a copied installed package", "native project chooser, archive confirmation and download save location are fixtures and have no native-dialog acceptance claim", "Browser preview is outside this journey", "IME uses Chromium CDP composition and a candidate Enter event, not a physical input method", "UNKNOWN uses a persisted test record after safe Core stop, not an induced process crash"],
    operatingSystem: { platform: process.platform, release: (await import("node:os")).release(), architecture: process.arch },
    windowBounds, videoPath, videoSegments: [{ path: videoPath, process: "initial Electron run", continuous: true },
      { path: restartVideoPath, process: "restarted Electron run", continuous: true }],
    framePredicates: {
      "01-source.png": "two completed source Turns with persisted head and future",
      "01a-fork-config-refusal.png": "real Core Workflow rejection stays in the Fork dialog without a target or model request",
      "01b-fork-response-unknown.png": "one real committed Fork survives lost GUI response; dialog offers receipt reconciliation and no resend",
      "02-fork-empty.png": "idle Fork with inherited prefix and no future Turn",
      "03-fork-sent.png": "Fork explicit answer; model input excludes future",
      "04-source-tool-running.png": "Core/Runtime command marker exists and source Turn remains inProgress",
      "04a-stale-selection.png": "real Core stale-selection rejection retains the Side question without creating a Side",
      "05-side-answered-frozen.png": "Side first answer completed while source tool remains active; Unicode selection verified",
      "06-bring-back-draft.png": "preview confirmed; local main draft includes Side text and no Core command was issued",
      "07-before-active.png": "before-active Fork has idle bounded inherited history",
      "07a-main-error-isolated.png": "Core refuses unsupported main attachment without sending or losing its draft; Side has no main Composer error",
      "07b-inherited-raw-result.png": "target-owned inherited raw result is displayed and downloaded with no source controls or local execution",
      "08-side-after-source-progress.png": "old Side model request and frozen evidence exclude later source sentinel",
      "08a-side-waiting-capacity.png": "Side visibly waits behind the source's single model slot and its Stop remains available",
      "08b-archived-copyable-preview.png": "archived Side refuses insertion while preserving edited old-snapshot text and a copy action",
      "08c-side-current-workspace.png": "a distinct readOnly Side reads current workspace bytes through native Runtime with explicit provenance",
      "08d-side-workspace-unavailable.png": "Core read-only refusal preserves the question before an explicit evidence-only Side succeeds",
      "08e-streaming-user-quote.png": "a real streamed plain-text selection remains an unverified user quote outside the frozen inProgress evidence",
      "09-restarted-identities.png": "second Electron process restored source and Side identities without a new model request",
      "10-unknown-source-refusal.png": "persisted UNKNOWN restores from real Core; GUI blocks its boundary and offers source inspection without losing the main draft",
      "11-corrupt-history-refusal.png": "real Core rejects corrupt frozen history with no new target, no model request and intact main draft",
    },
    sourceDirtyStatus: sourceStatus, sourceDiffSha256: createHash("sha256").update(sourceDiff).digest("hex"),
    sandbox, requestedRuntimeSandboxProfile: env.AREAL_CORE_SANDBOX_PROFILE || "full-access",
    developmentCapabilityFlag: env.AREAL_DEV_CONVERSATION_DERIVATION ?? null,
    binary, binarySha256: await hash(binary).catch(() => null),
    smokeScriptSha256: await hash(fileURLToPath(import.meta.url)),
    sourceThreadId, targetThreadId, nestedThreadId, beforeThreadId, rawThreadId, sideThreadId, userQuoteSideId, anchorTurnId, activeTurnId, projectId, serviceRegistry,
    fixture: { head, future, forkQuestion, activeQuestion, unicodeExcerpt, sideQuestion, sideFollowUp, lateSentinel, mainDraftSentinel,
      workspace, workspaceSha256Before: workspaceBefore, workspaceSha256After: await hash(fixturePath), toolStarted, toolRelease },
    requests, mutations: firstMutations,
  };
  await writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ passed, scratch, checks, failure }));
}
