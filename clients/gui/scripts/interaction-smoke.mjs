import { captureSmokeFailure, resizeConversation } from "./smoke-navigation.mjs";
import assert from "node:assert/strict";
import { appearanceReply, verifyAppearanceSlice } from "./appearance-smoke.mjs";
import { resourceMarkdown, resourcePath, resourceReply, verifyResourceSlice } from "./resource-smoke.mjs";

import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(gui, "app");
const require = createRequire(join(desktop, "package.json"));
const { _electron: electron } = require("playwright-core");
const requestedModes = ["focus-only", "task-slice", "appearance-slice", "resource-slice", "manual"].filter(mode => process.argv.includes(`--${mode}`));
assert.ok(requestedModes.length <= 1, "Choose one interaction mode");
const runMode = requestedModes[0] ?? "verify";
const focusOnly = runMode === "focus-only";
const taskSlice = runMode === "task-slice";
const manual = runMode === "manual";
const appearanceSlice = runMode === "appearance-slice";
const resourceSlice = runMode === "resource-slice";
const readingSample = process.argv.includes("--reading-sample");
assert.ok(!readingSample || manual, "--reading-sample requires --manual");
const forcedProfile = runMode !== "verify";
let manualExitReason;
let finishManual;
const manualExit = manual ? new Promise(resolve => { finishManual = resolve; }) : null;
const stopManual = reason => { manualExitReason ??= reason; finishManual?.(); };
const onInterrupt = () => stopManual("SIGINT");
const onTerminate = () => stopManual("SIGTERM");
if (manual) {
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
}
const root = resolve(gui, "../..");
const binary = process.env.AREAL_GUI_EXECUTABLE
  ? resolve(dirname(process.env.AREAL_GUI_EXECUTABLE), "../Resources/areal-core/bin/areal")
  : process.env.AREAL_CORE_BIN || join(root, "target/debug/areal");
assert.ok(binary, "AREAL_CORE_BIN must point to the actual built Core");
const scratch = await mkdtemp("/private/tmp/areal-gui-");
const workspace = join(scratch, "workspace");
await mkdir(workspace);
await mkdir(join(scratch, "user-home"));
execFileSync("git", ["init", "-b", "main"], {
  cwd: workspace,
  stdio: "ignore",
});
await writeFile(join(workspace, "hello.ts"), 'export const hello = "world";\n');
execFileSync("git", ["add", "."], { cwd: workspace });
execFileSync(
  "git",
  ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-m", "fixture"],
  { cwd: workspace, stdio: "ignore" },
);
await writeFile(join(workspace, "hello.ts"), 'export const hello = "AReaL";\n');
const skill = join(scratch, "skill");
await mkdir(skill);
await writeFile(
  join(skill, "SKILL.md"),
  "---\nname: fixture-skill\ndescription: Deterministic test skill\n---\nExplain the fixture project.\n",
);
const secondSkill = join(scratch, "skill-two");
await mkdir(secondSkill);
await writeFile(
  join(secondSkill, "SKILL.md"),
  "---\nname: fixture-skill\ndescription: Second source\n---\nSECOND_SKILL_CONTENT\n",
);
const pagedContent = "分页正文".repeat(2400) + "\nPAGED_SKILL_END";
await writeFile(
  join(skill, "SKILL.md"),
  "---\nname: fixture-skill\ndescription: Deterministic test skill\n---\n" + pagedContent,
);
const deployment = join(scratch, "desktop.json");
await writeFile(
  deployment,
  JSON.stringify({
    skills: [
      { id: "fixture-skill", revision: "v1", root: skill },
      { id: "fixture-two", revision: "v2", root: secondSkill },
    ],
    profiles: [
      {
        id: "standard",
        revision: "v1",
        displayName: "标准",
        instructions: "Complete the task",
        allowThreadProcesses: true,
        approvalTools: forcedProfile ? ["fs_create"] : [],

        skills: [
          { id: "fixture-skill", revision: "v1" },
          { id: "fixture-two", revision: "v2" },
        ],
      },
    ],
  }),
);
const received = [];
let releaseWrite, releaseSliceWrite;
const manualWrites = new Map();
let manualSequence = 0;
const messageText = message => typeof message?.content === "string" ? message.content
  : (message?.content ?? []).map(part => part.text ?? "").join("\n");
const binarySha256AtStart = createHash("sha256").update(await readFile(binary)).digest("hex");
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  received.push(body);
  const messages = body.messages ?? [];
  const index = messages.findLastIndex(m => m.role === "user" && (manual
    ? !messageText(m).startsWith("AReaL runtime context (not a user request):")
    : /(?:write:|question:|browser:|appearance:|resource:)/.test(messageText(m))));
  const text = messageText(messages[index]);
  const responded = messages.slice(index + 1).some(m => m.role === "tool");
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id:"fixture", choices:[{ index:0, delta, finish_reason }] })}\n\n`);
  if (resourceSlice && !messages.some(message => message.role === "user" && messageText(message).startsWith("resource:"))) {
    send({ content: "项目资源简报" });
    send({}, "stop");
  } else if (manual) {
    const tool = messages.slice(index + 1).findLast(message => message.role === "tool" && manualWrites.has(message.tool_call_id));
    if (tool) {
      const write = manualWrites.get(tool.tool_call_id);
      const resultText = messageText(tool);
      let result;
      try { result = JSON.parse(resultText); } catch {}
      const confirmed = result?.sha256 === write.sha256 && result?.size === write.size && !result?.error;
      const denied = /tool approval denied|permission.*denied/i.test(resultText);
      const reply = confirmed
        ? `已根据你的批准写入 \`${write.path}\`。可从下方文件结果查看内容。`
        : denied ? "你已拒绝本次写入。没有创建本轮需求文件。"
        : "本次写入未获成功确认。请查看真实工具结果，不能将它视为已完成。";
      send({ content: reply + (confirmed && readingSample ? "\n\n# 阅读样例\n\n以下为对话阅读样例，不是已写入文件的全文。\n\n" + appearanceReply : "") });
      send({}, "stop");
    } else if (!responded && text.trim()) {
      const id = `manual-write-${++manualSequence}-${randomUUID()}`;
      const path = `任务简报-${String(manualSequence).padStart(2, "0")}.md`;
      const markdown = `# 项目需求\n\n## 本轮请求\n\n${text.replaceAll("\0", "").slice(0, 16000)}\n\n## 交付\n\n将本轮请求保存在当前隔离项目，供后续阅读。\n`;
      manualWrites.set(id, { path, sha256: createHash("sha256").update(markdown).digest("hex"), size: Buffer.byteLength(markdown) });
      send({ content: "我会将本轮需求整理成 Markdown，等待你审批后写入隔离项目。" });
      await new Promise(resolve => setTimeout(resolve, 900));
      send({ tool_calls: [{ index: 0, id, type: "function", function: { name: "fs_create", arguments: JSON.stringify({ path, text: markdown }) } }] });
      send({}, "tool_calls");
    } else {
      send({ content: "本轮没有可确认的写入结果。" });
      send({}, "stop");
    }
  } else if (resourceSlice && text.includes("resource:")) {
    if (!responded) {
      send({ tool_calls: [{ index: 0, id: "resource-write", type: "function", function: { name: "fs_create", arguments: JSON.stringify({ path: resourcePath, text: resourceMarkdown }) } }] });
      send({}, "tool_calls");
    } else {
      const receipt = messages.slice(index + 1).findLast(message => message.role === "tool");
      const result = JSON.parse(messageText(receipt));
      assert.equal(result.sha256, createHash("sha256").update(resourceMarkdown).digest("hex"), "fixture reply requires genuine Core file receipt");
      send({ content: resourceReply(workspace) });
      send({}, "stop");
    }
  } else if (appearanceSlice && text.includes("appearance:")) {
    send({ content: appearanceReply });
    send({}, "stop");
  } else if (!responded && text.includes("write:")) {
    const path = text.match(/write:([a-z.-]+)/)[1];
    if (path === "draft.txt") await new Promise(resolve => { releaseWrite = resolve; });
    if (taskSlice) await new Promise(resolve => { releaseSliceWrite = resolve; });
    send({tool_calls:[{index:0,id:"write",type:"function",function:{name:"fs_create",arguments:JSON.stringify({path,text:"approved by user"})}}]});
    send({},"tool_calls");
  } else if (!responded && text.includes("question:")) {
    const mode = text.match(/question:([a-z]+)/)[1];
    const questions = mode === "multi" ? [
      {id:"choice",title:"选择实现方式",options:["最小修改","重构"],allowFreeText:false},
      {id:"note",title:"补充设计要求",allowFreeText:true},
    ] : [{id:"choice",title:mode === "text" ? "补充设计要求" : "选择实现方式",options:mode === "text" ? [] : ["最小修改","重构"],allowFreeText:mode !== "option"}];
    send({tool_calls:[{index:0,id:"question",type:"function",function:{name:"ask_user_question",arguments:JSON.stringify({questions})}}]});
    send({},"tool_calls");
  } else if (!responded && text.includes("browser:describe")) {
    send({tool_calls:[{index:0,id:"browser",type:"function",function:{name:"browser_v1",arguments:JSON.stringify({operation:"describe",parameters:{}})}}]});
    send({},"tool_calls");
  } else {send({content:"INTERACTION_OK"});send({},"stop");}
  res.end("data: [DONE]\n\n");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
const config = join(scratch, "config.toml");
await writeFile(
  config,
  `schema_version=1\n[model]\nprovider="fixture"\nname=${JSON.stringify(manual ? "本地设计体验" : "fixture")}\n[permissions]\nmode="ASK_PERMISSIONS"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint=${JSON.stringify(endpoint)}\n`,
);
const env = {
  ...process.env,
  AREAL_GUI: "workbench",
  AREAL_BACKEND: "areal",
  AREAL_CORE_BIN: binary,
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: join(scratch, "user-home"),
  AREAL_HARNESS_HOME: join(scratch, "runtime"),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_CORE_CONFIG: config,
  AREAL_CORE_DESKTOP_CONFIG: deployment,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
};
delete env.AREAL_CORE_WORKSPACE;
if (process.env.AREAL_GUI_EXECUTABLE) delete env.AREAL_CORE_BIN;
let app,
  page,
  passed = false;
const errors = [],
  frames = [],
  checks = [],
  focusEvidence = [],
  identities = [],
  visualEvidence = [];
let manualReady = false;
const button = (name) => page.getByRole("button", { name, exact: true });
const state = () => page.evaluate(() => window.arealDesktop.snapshot());
async function call(name, params) {
  const result = await page.evaluate(
    async ({ name, params }) => window.arealDesktop.command(name, params),
    { name, params },
  );
  if (!result.ok) throw Error(result.error.message);
  return result.value;
}
async function until(predicate, label) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const s = await state();
    if (predicate(s)) return s;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw Error("Timeout: " + label);
}
async function shot(name) {
  const clip = await page.evaluate(() => {
    const boxes = [
      ...document.querySelectorAll(
        '.composer-dock, [data-slot="popover-content"], [data-testid="composer-catalog"]',
      ),
    ]
      .map((element) => element.getBoundingClientRect())
      .filter((box) => box.width > 0 && box.height > 0);
    if (!boxes.length) return undefined;
    const x = Math.max(0, Math.min(...boxes.map((box) => box.left)) - 8);
    const y = Math.max(0, Math.min(...boxes.map((box) => box.top)) - 8);
    return {
      x,
      y,
      width: Math.min(innerWidth, Math.max(...boxes.map((box) => box.right)) + 8) - x,
      height: Math.min(innerHeight, Math.max(...boxes.map((box) => box.bottom)) + 8) - y,
    };
  });
  await page.screenshot({
    clip,
    path: join(scratch, name + ".png"),
    scale: "css",
    animations: "disabled",
  });
  frames.push(name + ".png");
}
async function fullShot(name) {
  await page.screenshot({ path: join(scratch, name + ".png"), scale: "css", animations: "disabled" });
  frames.push(name + ".png");
}
async function recordCoreIdentity() {
  const instanceId = project(await state()).core.instanceId;
  const descriptor = JSON.parse(execFileSync(binary, ["service", "status", "--instance", instanceId, "--json"], { env, encoding: "utf8", timeout: 20000 }));
  assert.equal(descriptor.serviceId, instanceId);
  assert.equal(descriptor.workspace, workspace);
  assert.ok(descriptor.dataDir.startsWith(scratch + "/"), "Core data belongs to the isolated run");
  identities.push({ surface: "Desktop GUI", serviceId: instanceId, generation: descriptor.generation, pid: descriptor.pid, workspace: descriptor.workspace, dataDir: descriptor.dataDir, registry: env.AREAL_HARNESS_SERVICE_HOME, binary, binarySha256: binarySha256AtStart });
}
async function verifySliceConditions(request, filename, stage) {
  for (const condition of [
    { name: "light-wide-14-14", theme: "soft-glass", dark: false, width: 1440, ui: 14, content: 14, caption: 13 },
    { name: "dark-wide-14-14", theme: "data-dense", dark: true, width: 1440, ui: 14, content: 14, caption: 13 },
    { name: "light-narrow-18-14", theme: "soft-glass", dark: false, width: 980, ui: 18, content: 14, caption: 13 },
    { name: "dark-narrow-14-18", theme: "data-dense", dark: true, width: 980, ui: 14, content: 18, caption: 17 },
  ]) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 960), condition.width);
    await page.evaluate(condition => {
      const key = "areal-gui:application-preferences";
      const saved = JSON.parse(localStorage.getItem(key) ?? "{}");
      localStorage.setItem(key, JSON.stringify({ ...saved, contentSize: condition.content }));
      localStorage.setItem("areal-gui:font-size", String(condition.ui));
      localStorage.setItem("areal-gui:theme", condition.theme);
    }, condition);
    await page.reload();
    await page.getByRole("region", { name: "工具审批", exact: true }).waitFor();
    await until(s => interaction(s, "approval")?.requestId === request.requestId, "original approval restored after preference injection");
    await assert.rejects(readFile(join(workspace, filename)), { code: "ENOENT" });
    await page.waitForFunction(condition => document.documentElement.classList.contains("dark") === condition.dark
      && getComputedStyle(document.documentElement).getPropertyValue("--ui-font-size").trim() === `${condition.ui}px`
      && getComputedStyle(document.documentElement).getPropertyValue("--content-font-size").trim() === `${condition.content}px`, condition);
    const observation = await page.evaluate(() => {
      const measure = element => {
        const bounds = element.getBoundingClientRect(), style = getComputedStyle(element);
        return { name: element.getAttribute("aria-label") ?? element.className, processMetadata: element.matches(".turn-progress-summary"), x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
          visible: bounds.width > 0 && bounds.height > 0, overflow: element.scrollWidth > element.clientWidth + 1,
          fontSize: style.fontSize, color: style.color, background: style.backgroundColor };
      };
      const probe = document.createElement("span");
      probe.style.cssText = "position:fixed;visibility:hidden;font-size:var(--text-content-caption)";
      document.body.append(probe);
      const caption = getComputedStyle(probe).fontSize;
      probe.remove();
      const card = document.querySelector('.decision-card[data-interaction="approval"]');
      return { viewport: { width: innerWidth, height: innerHeight }, caption, documentOverflow: document.documentElement.scrollWidth > innerWidth + 1,
        elements: [...document.querySelectorAll('.composer-dock, .decision-card, .decision-card-body, .messages, .turn-progress-summary, .execution-label')].filter(element => element.getBoundingClientRect().width > 0).map(measure),
        actions: [...card.querySelectorAll("button")].filter(element => element.getBoundingClientRect().width > 0).map(measure) };
    });
    assert.equal(observation.viewport.width, condition.width, "capture uses the requested supported window width");
    assert.equal(observation.caption, `${condition.caption}px`, "content metadata follows content size independently of UI size");
    assert.equal(observation.documentOverflow, false, "window has no horizontal overflow");
    const processMetadata = observation.elements.filter(element => element.processMetadata);
    assert.ok(processMetadata.length, "real pending turn exposes process metadata");
    for (const element of processMetadata) assert.equal(element.fontSize, `${condition.caption}px`, "visible process metadata uses the content caption size");
    for (const element of observation.elements) {
      assert.equal(element.overflow, false, `${element.name} has no horizontal overflow`);
      assert.ok(element.x >= -1 && element.x + element.width <= observation.viewport.width + 1, `${element.name} stays inside the window`);
    }
    for (const action of observation.actions) {
      assert.ok(action.visible && action.x >= 0 && action.x + action.width <= observation.viewport.width + 1
        && action.y >= 0 && action.y + action.height <= observation.viewport.height + 1, "approval action is visible and reachable");
    }
    await focusGeometry(page, button("拒绝"), `${stage} ${condition.name} deny action`);
    await focusGeometry(page, button("允许一次"), `${stage} ${condition.name} allow action`);
    assert.equal(interaction(await state(), "approval").requestId, request.requestId, "visual checks never decide the request");
    await fullShot(`slice-${stage}-${condition.name}-pending`);
    visualEvidence.push({ stage, condition, observation, preferences: "existing localStorage preferences injected before reload; settings UI is not tested" });
  }
}
async function tabTo(targetPage, target) {
  for (let index = 0; index < 100; index++) {
    await targetPage.keyboard.press("Tab");
    if (await target.evaluate(element => element === document.activeElement)) return;
  }
  throw Error("Keyboard Tab did not reach " + await target.getAttribute("aria-label"));
}
async function focusGeometry(targetPage, target, label) {
  await tabTo(targetPage, target);
  const computed = await target.evaluate(element => {
    const style = getComputedStyle(element);
    return { visible: element.matches(":focus-visible"), width: style.outlineWidth, offset: style.outlineOffset, style: style.outlineStyle };
  });
  assert.deepEqual(computed, { visible: true, width: "2px", offset: "2px", style: "solid" }, label);
  focusEvidence.push({ label, ...computed });
}
async function assertDecision(request, decision, filename) {
  await until(s => current(s)?.turns.find(turn => turn.id === request.turnId)?.status === "completed", "original approval turn completed");
  const snapshot = await state();
  const responses = project(snapshot).state.interactions[tid].data.filter(item => item.requestId === request.requestId);
  assert.equal(responses.length, 1, "original request has one authoritative interaction");
  assert.equal(responses[0].response.decision, decision);
  const turn = current(snapshot).turns.find(item => item.id === request.turnId);
  const calls = turn.items.filter(item => item.type === "dynamicToolCall" && item.tool === "fs_create");
  assert.equal(calls.length, 1, "one tool call belongs to the original turn");
  assert.equal(calls[0].success, decision === "allowOnce", "Core tool result agrees with the decision");
  if (decision === "allowOnce") assert.equal(await readFile(join(workspace, filename), "utf8"), "approved by user");
  else await assert.rejects(readFile(join(workspace, filename)), { code: "ENOENT" });
  focusEvidence.push({ requestId: request.requestId, turnId: request.turnId, decision, toolCalls: calls.length, toolSuccess: calls[0].success, filename });
}
async function verifyWebFocus() {
  const instanceId = project(await state()).core.instanceId;
  const descriptor = JSON.parse(execFileSync(binary, ["service", "status", "--instance", instanceId, "--json"], { env, encoding: "utf8", timeout: 20000 }));
  assert.equal(descriptor.serviceId, instanceId);
  assert.equal(descriptor.workspace, workspace);
  assert.equal(descriptor.dataDir, join(env.AREAL_CORE_HOME, pid, "state"));
  assert.ok(descriptor.authFile.startsWith(scratch + "/"), "Web authentication belongs to this fixture");
  const auth = JSON.parse(await readFile(descriptor.authFile, "utf8"));
  const principal = auth.principals.find(item => ["observe", "interact", "manage", "tools"].every(permission => item.permissions.includes(permission)));
  assert.ok(principal, "real fixture principal can perform approvals");
  const url = new URL(descriptor.endpoint);
  url.protocol = "http:";
  url.pathname = "/ui";
  const windowReady = app.waitForEvent("window");
  const security = await app.evaluate(async ({ BrowserWindow }, url) => {
    const window = new BrowserWindow({ width: 1100, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await window.loadURL(url);
    const preferences = window.webContents.getLastWebPreferences();
    return { sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration, preload: preferences.preload ?? null };
  }, url.href);
  const web = await windowReady;
  try {
    const webWindow = await app.browserWindow(web);
    assert.deepEqual(security, { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: null });
    web.setDefaultTimeout(15000);
    web.on("pageerror", error => errors.push(error.message));
    assert.equal(await web.evaluate(() => typeof window.arealDesktop), "undefined", "local Web has no Desktop bridge");
    const css = await web.request.get(new URL("/ui/style.css", url).href);
    assert.equal(css.status(), 200);
    assert.match(css.headers()["content-type"], /^text\/css/);
    assert.equal(css.headers()["x-content-type-options"], "nosniff");
    const stylesheet = await css.text();
    const shared = await readFile(join(root, "design/tokens/focus.css"), "utf8");
    assert.equal(stylesheet, shared + "\n" + await readFile(join(root, "clients/web/style.css"), "utf8"), "real HTTP CSS combines the current shared and Web sources");
    await web.getByLabel("本地访问令牌", { exact: true }).fill(principal.token);
    await web.getByRole("button", { name: "连接", exact: true }).click();
    await web.locator('#connection[data-state="connected"]').waitFor();
    await web.locator(`.thread-row[data-id="${tid}"] .thread-select`).click();
    identities.push({ surface: "local Web", browser: "Electron Chromium", transport: "real HTTP and authenticated WebSocket", bridge: false, security, url: url.href, registry: env.AREAL_HARNESS_SERVICE_HOME, serviceId: descriptor.serviceId, generation: descriptor.generation, pid: descriptor.pid, workspace: descriptor.workspace, dataDir: descriptor.dataDir });
    for (const [filename, label, decision, theme, width] of [["web-denied.txt", "拒绝", "deny", "light", 1100], ["web-allowed.txt", "允许一次", "allowOnce", "dark", 420]]) {
      await web.getByRole("button", { name: "设置", exact: true }).click();
      await web.getByLabel("外观", { exact: true }).selectOption(theme);
      await web.getByRole("button", { name: "关闭设置", exact: true }).click();
      await webWindow.evaluate((window, width) => window.setSize(width, 800), width);
      await web.waitForFunction(({ theme, width }) => document.documentElement.dataset.theme === theme && innerWidth === width, { theme, width });
      await web.locator("#prompt").fill("write:" + filename);
      await web.locator("#prompt").press("Enter");
      await until(s => interaction(s, "approval"), "Web approval request");
      const request = interaction(await state(), "approval");
      const action = web.locator("#permission-request").getByRole("button", { name: label, exact: true });
      await action.waitFor();
      await focusGeometry(web, action, "Web " + decision);
      focusEvidence.push({ surface: "local Web", decision, theme, viewport: await web.evaluate(() => ({ width: innerWidth, height: innerHeight })) });
      const frame = "focus-" + filename + ".png";
      await web.screenshot({ path: join(scratch, frame), scale: "css", animations: "disabled" });
      frames.push(frame);
      await web.keyboard.press("Enter");
      await assertDecision(request, decision, filename);
      await web.locator("#permission-request").waitFor({ state: "hidden" });
    }
    checks.push("local Web serves the merged CSS and keyboard approve/deny settle the original real Core requests");
  } finally {
    await web.close();
  }
}
async function launch() {
  const signalListeners = manual ? new Map(["SIGINT", "SIGTERM"].map(signal => [signal, new Set(process.listeners(signal))])) : new Map();
  app = await electron.launch({
    executablePath: process.env.AREAL_GUI_EXECUTABLE || require("electron"),
    args: process.env.AREAL_GUI_EXECUTABLE ? [] : [desktop],
    env,
    timeout: 120000,
  });
  for (const [signal, before] of signalListeners) {
    for (const listener of process.listeners(signal)) if (!before.has(listener)) process.off(signal, listener);
  }
  if (manual) app.once("close", () => stopManual("window closed"));
  app.process().stderr.on("data", (d) => {
    if (String(d).includes("Error")) process.stderr.write(d);
  });
  page = await app.firstWindow();
  if (manual) {
    page.once("close", () => stopManual("window closed"));
    void app.evaluate(({ BrowserWindow }) => new Promise(resolve => {
      BrowserWindow.getAllWindows()[0].once("hide", () => resolve());
    })).then(() => stopManual("window hidden"), () => stopManual("window closed"));
  }
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.locator("[data-testid=areal-workbench]").waitFor({ timeout: 120000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
}
async function quit() {
  if (!app) return;
  const owned = app;
  app = null;
  if (owned.process().exitCode !== null) return;
  try {
    await owned.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 });
    });
    await owned.close();
  } catch (error) {
    if (owned.process().exitCode === null) throw error;
  }
}
console.log("Interaction evidence:", scratch);
let pid, tid;
const project = snapshot => snapshot.projects.find(item => item.root === workspace);
const interaction = (snapshot, kind) => project(snapshot).state.interactions[tid]?.data.findLast(i => i.status === "pending" && i.kind === kind);
const current = snapshot => project(snapshot).state.threads[tid];
try {
  await launch();
  if (!appearanceSlice) {
    await page.evaluate(() => localStorage.setItem("areal-gui:theme", "data-dense"));
    await page.reload();
  }
  await page.getByTestId("areal-workbench").waitFor();
  await app.evaluate(({ dialog }, workspace) => { dialog.showOpenDialog = async () => ({canceled:false,filePaths:[workspace]}); }, workspace);
  await button("不在项目中工作").click();
  await page.getByRole("menuitem",{name:"新建项目",exact:true}).click();
  await until(s => project(s)?.state?.connected,"project ready");
  pid=project(await state()).id;
  if (forcedProfile) {
    await page.waitForFunction(id => document.querySelector('[data-testid="areal-workbench"]')?.dataset.projectId === id, pid);
    assert.ok(project(await state()).profiles.some(item => item.id === "standard" && item.revision === "v1"));
    await page.evaluate(id => {
      const key = `areal-gui:draft:${id}:new`;
      localStorage.setItem(`${key}:profile`, JSON.stringify({ id: "standard", revision: "v1" }));
      window.dispatchEvent(new CustomEvent("areal-draft-change", { detail: key }));
    }, pid);
  }
  if (manual || taskSlice || appearanceSlice || resourceSlice) await recordCoreIdentity();
  if (manual) {
    await page.getByTestId("chat-input").waitFor();
    assert.equal(received.length, 0, "manual startup sends no model request");
    manualReady = true;
    await fullShot("manual-ready");
    await writeFile(join(scratch, "manual-ready.json"), JSON.stringify({
      passed: false, mode: runMode, manualReady, verification: "manual operation available; automated acceptance not run",
      scratch, workspace, identities, electronPid: app.process().pid, binarySha256: binarySha256AtStart,
      commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim(),
      diffSha256: createHash("sha256").update(execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: root })).digest("hex"),
    }, null, 2));
    console.log(`MANUAL READY. 输入普通中文要求，例如“请为项目写一份快速开始说明”。每轮生成独立 Markdown，只有你批准才写入。\n隔离项目 ${workspace}\n关闭窗口或 Ctrl+C 退出并清理本实例。`);
    await manualExit;
  } else if (appearanceSlice || resourceSlice) {
    const verify = resourceSlice ? verifyResourceSlice : verifyAppearanceSlice;
    await verify({ app, page, state, project, until, received, visualEvidence, checks, fullShot, workspace, setThread: id => { tid = id; } });
    assert.equal(errors.length, 0, "renderer has no page errors");
    await writeFile(join(scratch, "final-state.json"), JSON.stringify(await state(), null, 2));
    assert.equal(createHash("sha256").update(await readFile(binary)).digest("hex"), binarySha256AtStart, "Core binary stayed frozen during acceptance");
    passed = true;
    console.log("PASS:", checks);
  } else {
  let sliceRequest = 0;
  const input=()=>page.getByTestId("chat-input");
  const send=async text=>{
    if (taskSlice) await assert.rejects(readFile(join(workspace, text.slice("write:".length))), { code: "ENOENT" });
    await input().fill(text);
    if (taskSlice) await fullShot(`slice-${++sliceRequest}-input`);
    await page.getByTestId("chat-send-button").click();
    await until(s=>Object.values(project(s).state.threads).some(t=>t.turns?.at(-1)?.status==="inProgress"),"admitted turn");
    tid=Object.values(project(await state()).state.threads).find(t=>t.turns?.length)?.id;
    assert.ok(tid,"Core thread created");
    if (taskSlice) {
      await until(() => !!releaseSliceWrite, "model holds tool submission for process evidence");
      await assert.rejects(readFile(join(workspace, text.slice("write:".length))), { code: "ENOENT" });
      await page.getByTestId("turn-activity").last().waitFor();
      await fullShot(`slice-${sliceRequest}-processing`);
      releaseSliceWrite();
      releaseSliceWrite = undefined;
    }
  };
  const done=()=>until(s=>current(s)?.turns.at(-1)?.status==="completed","same turn completed");
  const approval=()=>page.getByRole("region",{name:"工具审批",exact:true});
  const question=()=>page.getByRole("region",{name:"需要你的回答",exact:true});
  if (!focusOnly && !taskSlice) {
    // 本专项覆盖 ASK_PERMISSIONS 的单次/任务/项目授权；新草稿的 autoReview 预设不会要求普通工作区写入审批。
    await send("initialize approval fixture");
    await done();
    const configuration = project(await state()).configurations[tid];
    await call("configure", { projectId: pid, threadId: tid, options: { ...configuration.options, permissionPreset: null } });
    assert.equal(project(await state()).configurations[tid].options.permissionPreset, undefined);
  }
  await send("write:denied.txt");
  if (forcedProfile) assert.deepEqual(project(await state()).configurations[tid].profile.approvalTools, ["fs_create"], "real Core requires fixture tool approval");
  await until(s=>interaction(s,"approval"),"approval request");
  const denial=interaction(await state(),"approval");
  await approval().waitFor();
  await focusGeometry(page, approval(), "GUI approval DecisionCard");
  await shot("01-approval-pending");
  if (taskSlice) await verifySliceConditions(denial, "denied.txt", "denied");
  assert.equal(await input().isVisible(),false,"approval replaces ordinary input");
  assert.equal(await approval().locator(".decision-card-label").innerText(),"工具");
  await tabTo(page, button("拒绝"));
  await page.keyboard.press("Enter");
  await done();
  await assertDecision(denial, "deny", "denied.txt");
  checks.push("deny resumes the original turn without writing the file");
  if (taskSlice) await fullShot("slice-denied-result");

  await send("write:allowed.txt");
  await until(s=>interaction(s,"approval"),"once request");
  const allowance = interaction(await state(), "approval");
  await focusGeometry(page, approval(), "GUI allowOnce DecisionCard");
  // The hidden Lexical editor is mounted, preserving draft ownership.
  await page.evaluate(()=>{const el=document.querySelector('[data-testid="chat-input"]');if(!el)throw Error("missing retained editor")});
  if (!focusOnly && !taskSlice) {
    await button("更多授权范围").click();
    await page.getByRole("menuitem",{name:/本任务允许此操作/}).waitFor();
    await shot("02-approval-scope-menu");
    await page.keyboard.press("Escape");
  }
  if (taskSlice) await verifySliceConditions(allowance, "allowed.txt", "allowed");
  await tabTo(page, button("允许一次"));
  await page.keyboard.press("Enter");
  await done();
  await assertDecision(allowance, "allowOnce", "allowed.txt");
  await approval().waitFor({state:"hidden"});
  checks.push("allowOnce writes the requested file and restores the normal composer");
  if (taskSlice) {
    await page.getByTestId("turn-file-summary").last().waitFor();
    await fullShot("slice-allowed-result");
    checks.push("task slice captures full-window input, real in-progress turn, pending approvals, results and preference conditions without premature writes");
  }

  if (!focusOnly && !taskSlice) {
  await send("write:session.txt");
  await until(s=>interaction(s,"approval"),"session request");
  await button("更多授权范围").click();
  await page.getByRole("menuitem",{name:/本任务允许此操作/}).click();
  await done();
  assert.equal(await readFile(join(workspace,"session.txt"),"utf8"),"approved by user");
  assert.equal(project(await state()).state.interactions[tid].data.at(-1).response.decision,"allowSession");
  checks.push("task scope reaches the original Core approval response");

  await send("write:project.txt");
  await until(s=>interaction(s,"approval"),"project request");
  await button("更多授权范围").click();
  await page.getByRole("menuitem",{name:/本项目允许此操作/}).click();
  await done();
  assert.equal(await readFile(join(workspace,"project.txt"),"utf8"),"approved by user");
  assert.equal(project(await state()).state.interactions[tid].data.at(-1).response.decision,"allowProject");
  checks.push("project scope reaches the original Core approval response");

  const configBefore = project(await state()).configurations[tid];
  await call("configure", {projectId:pid,threadId:tid,options:{...configBefore.options,approvalTools:["fs_create"]}});
  await send("write:forced.txt");
  await until(s=>interaction(s,"approval"),"forced approval");
  assert.equal(interaction(await state(),"approval").effectivePermissions.rememberAllowed,false);
  assert.equal(await button("更多授权范围").count(),0,"Core forced approval offers no remembered scope");
  await button("允许一次").click();
  await done();
  assert.equal(await readFile(join(workspace,"forced.txt"),"utf8"),"approved by user");
  await call("configure",{projectId:pid,threadId:tid,options:configBefore.options});
  checks.push("Core forced approval retains allowOnce and hides remembered scopes");

  await send("write:draft.txt");
  await input().fill("保留的后续草稿");
  await until(()=>!!releaseWrite,"model holds approval for the user draft");
  releaseWrite();
  await until(s=>interaction(s,"approval"),"draft approval");
  assert.equal(await input().isVisible(),false);
  await button("允许一次").click();
  await done();
  assert.equal(await input().innerText(),"保留的后续草稿");
  await input().fill("");
  checks.push("ordinary composer draft survives approval replacement without remounting");

  await send("question:option");
  await until(s=>interaction(s,"question"),"option request");
  const optionRequest=interaction(await state(),"question");
  await question().waitFor();
  assert.equal(interaction(await state(),"question").requestId,optionRequest.requestId,"initial screen never submits");
  assert.equal(await page.locator('.interaction-composer-compact').isVisible(),true);
  assert.equal(await question().locator(".decision-card-body").evaluate(el=>el.scrollWidth<=el.clientWidth),true,"question options have no horizontal overflow");
  assert.equal(await question().getByRole("button",{name:"发送",exact:true}).isEnabled(),false,"unanswered question cannot submit a default");
  await shot("03-question-pending");
  await page.getByRole("radio",{name:/重构/}).click();
  assert.equal(interaction(await state(),"question").requestId, optionRequest.requestId, "selection edits the draft without submitting");
  await question().getByRole("button",{name:"发送",exact:true}).click();
  await done();
  assert.equal(project(await state()).state.interactions[tid].data.find(i=>i.requestId===optionRequest.requestId).response.answers.choice,"重构");
  await page.locator('[data-question-answer]').last().getByText("重构",{exact:true}).waitFor();
  await page.screenshot({path:join(scratch,"04-question-answer-full.png"),scale:"css",animations:"disabled"});
  frames.push("04-question-answer-full.png");
  await shot("04-question-answer");
  checks.push("explicit option responds to the same Core request and replays its authoritative answer");

  await send("question:text");
  await until(s=>interaction(s,"question"),"free text request");
  const reply=page.getByLabel("自定义回答：补充设计要求",{exact:true});
  await reply.fill("保留原有审批逻辑");
  await button("收起问题").click();
  assert.ok(interaction(await state(),"question"),"close never completes Core request");
  await button("展开待回答问题").click();
  assert.equal(await reply.inputValue(),"保留原有审批逻辑");
  await button("稍后回答").click();
  await button("展开待回答问题").click();
  assert.equal(await reply.inputValue(),"保留原有审批逻辑");
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(800,700));
  await shot("05-question-narrow");
  const bounds=await question().boundingBox();
  const viewportWidth = await page.evaluate(()=>innerWidth);
  assert.ok(bounds.x>=0&&bounds.x+bounds.width<=viewportWidth,"card remains within the actual native minimum window");
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,960));
  await reply.press("Meta+Enter");
  await done();
  await page.locator('[data-question-answer]').last().getByText("保留原有审批逻辑",{exact:true}).waitFor();
  checks.push("close/skip retain custom draft and pending Core question; explicit submit resumes");

  await send("question:multi");
  await until(s=>interaction(s,"question"),"multi request");
  await page.getByRole("radio",{name:/最小修改/}).click();
  assert.ok(interaction(await state(),"question"),"multi option does not submit early");
  await question().getByRole("button",{name:"下一题",exact:true}).click();
  await page.getByLabel("自定义回答：补充设计要求",{exact:true}).fill("统一卡片样式");
  await question().getByRole("button",{name:"上一题",exact:true}).click();
  assert.equal(await page.getByRole("radio",{name:/最小修改/}).isChecked(),true);
  await question().getByRole("button",{name:"下一题",exact:true}).click();
  await question().getByRole("button",{name:"发送",exact:true}).click();
  await done();
  assert.deepEqual(project(await state()).state.interactions[tid].data.at(-1).response.answers,{choice:"最小修改",note:"统一卡片样式"});
  await shot("06-multi-answer");
  checks.push("multiple answers preserve per-question drafts and submit atomically to Core");

  await page.reload();
  await page.getByTestId("areal-workbench").waitFor();
  await page.locator('[data-question-answer]').last().getByText("统一卡片样式",{exact:true}).waitFor();
  checks.push("answer bubbles restore from authoritative tool history after renderer reload");
  await send("browser:describe");
  await until(s=>interaction(s,"approval"),"native browser approval");
  assert.equal(interaction(await state(),"approval").tool,"browser_v1");
  assert.equal(await approval().locator(".decision-card-label").innerText(),"浏览器");
  await shot("07-browser-approval");
  await button("允许一次").click();
  await done();
  const browserCall = current(await state()).turns.at(-1).items.find(i=>i.type==="dynamicToolCall"&&i.tool==="browser_v1");
  assert.equal(browserCall.success,true,"Core/browser host completes the approved description");
  checks.push("real Browser approval uses the shared card and retains the existing host/Core execution path");
  }
  if (focusOnly) await verifyWebFocus();

  assert.equal(errors.length,0,"renderer has no page errors");
  await writeFile(join(scratch,"final-state.json"),JSON.stringify(await state(),null,2));
  assert.equal(createHash("sha256").update(await readFile(binary)).digest("hex"),binarySha256AtStart,"Core binary stayed frozen during acceptance");
  passed=true;
  console.log("PASS:",checks);
  }
} catch(error){
  errors.push(error.stack||String(error));
  await writeFile(join(scratch,"received.json"),JSON.stringify(received,null,2));
  if(page) await writeFile(join(scratch,"failure-state.json"),JSON.stringify(await state(),null,2)).catch(()=>{});
  console.error(error);
  process.exitCode=1;
  if(page) await page.screenshot({path:join(scratch,"failure.png")}).catch(()=>{});
} finally {
  releaseWrite?.();
  releaseSliceWrite?.();
  if (manual) {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
  const serviceMetadata = await readFile(join(scratch, "core/service.json"), "utf8").then(JSON.parse).catch(error => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  await quit().catch(error => {
    process.exitCode = 1;
    passed = false;
    errors.push(`Electron cleanup failed: ${error.message}`);
  });
  try {
    const alive = () => {
      if (!serviceMetadata) return false;
      try { process.kill(serviceMetadata.pid, 0); return true; }
      catch (error) { if (error.code === "ESRCH") return false; throw error; }
    };
    if (alive()) {
      const { ServiceConnection } = require(join(desktop, "src/core/service-client.cjs"));
      const connection = new ServiceConnection();
      try {
        await connection.connect(serviceMetadata);
        await connection.request("stopService", { protocol: "areal.desktop-service.v1" }, true);
      } finally {
        connection.close();
      }
    }
    for (let index = 0; alive() && index < 100; index++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(alive(), false, "owned Desktop service exits");
    const instances = JSON.parse(execFileSync(binary, ["service", "list", "--json"], { env, encoding: "utf8", timeout: 20000 }));
    assert.ok(instances.every(instance => instance.workspace.startsWith(scratch + "/") && instance.state === "stopped"), "all private fixture Core instances stopped");
    checks.push("owned Desktop service exits and private Core registry contains no running instances");
  } catch (error) {
    console.error("Adapter fixture cleanup:", error.message);
    if (passed || manualReady) {
      passed = false;
      process.exitCode = 1;
      errors.push(`Explicit safe stop failed: ${error.message}`);
    }
    // 仅清理本次隔离 home 中的服务；失败不遗留模型任务或后台进程。
    try {
      const instances = JSON.parse(
        execFileSync(binary, ["service", "list", "--json"], { env, encoding: "utf8" }),
      );
      for (const instance of instances)
        if (instance.workspace === workspace && instance.state !== "stopped") {
          execFileSync(
            binary,
            ["service", "stop", "--instance", instance.serviceId, "--cancel", "--json"],
            { env, timeout: 120000, stdio: "pipe" },
          );
        }
    } catch (failure) {
      console.error("Core fixture cleanup:", failure.message);
    }
    try {
      const metadata = JSON.parse(await readFile(join(scratch, "core/service.json"), "utf8"));
      process.kill(metadata.pid, "SIGTERM");
    } catch {}
  }
  await writeFile(join(scratch, "received.json"), JSON.stringify(received, null, 2));
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  const sourceFiles = {};
  for (const path of execFileSync(
    "git",
    ["ls-files", "--modified", "--others", "--exclude-standard", "-z"],
    { cwd: root },
  )
    .toString()
    .split("\0")
    .filter(Boolean)) {
    sourceFiles[path] = createHash("sha256")
      .update(await readFile(join(root, path)))
      .digest("hex");
  }
  const diff = execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: root });
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed,
        mode: runMode,
        manualReady,
        manualExitReason,
        verification: manual ? "manual operation available; automated acceptance not run" : "automated interaction assertions",
        commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim(),
        sourceFiles,
        binarySha256: createHash("sha256")
          .update(await readFile(binary))
          .digest("hex"),
        diffSha256: createHash("sha256").update(diff).digest("hex"),
        binary,
        platform: process.platform,
        arch: process.arch,
        runtime: "real Electron + real Rust Core/Runtime + deterministic local HTTP/SSE model",
        nativeDialogs: "project picker and archive/quit confirmations injected",
        fixtureProfile: forcedProfile ? "Core profile standard@v1 requires fs_create approval; Composer draft selection injected" : null,
        scratch,
        frames,
        checks,
        focusEvidence,
        identities,
        focusOnly,
        visualEvidence,
        errors,
      },
      null,
      2,
    ),
  );
}
