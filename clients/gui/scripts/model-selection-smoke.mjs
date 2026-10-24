import { assertApplicationStopped } from "./application-cleanup.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { captureSmokeFailure, createProjectConversation, selectConversation } from "./smoke-navigation.mjs";

// 模型可用性来自真实 Core；仅上游推理使用本地确定性服务。
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const scratch = await mkdtemp("/private/tmp/ams-");
const workspace = join(scratch, "workspace"), userHome = join(scratch, "user");
await mkdir(workspace); await mkdir(join(userHome, ".areal"), { recursive: true });
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
const requests = [];
const modelRequests = [];
const probeRequests = [];
let releaseHeldReply;
const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url.endsWith("/models")) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [] }));
    return;
  }
  let body = ""; for await (const chunk of request) body += chunk;
  const payload = JSON.parse(body);
  if (payload.messages?.length === 1 && payload.messages[0].content === "Reply with OK.") {
    const probe = { terminalSent: true, closed: false };
    probeRequests.push(probe);
    response.on("close", () => { probe.closed = true; });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write('data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
    return;
  }
  const naming = payload.messages?.some(message => message.role === "system" && JSON.stringify(message.content).includes("Generate a concise semantic session title"));
  if (!naming) {
    requests.push({ model: payload.model, authenticated: request.headers.authorization === "Bearer fixture-key", authorizationPresent: request.headers.authorization !== undefined });
    modelRequests.push({ model: payload.model, effort: payload.reasoning_effort ?? null, hasEffort: Object.hasOwn(payload, "reasoning_effort") });
    const lastMessage = JSON.stringify(payload.messages?.at(-1));
    if (lastMessage?.includes("LAST_MODEL_ACCEPTED_FAILURE")) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Deterministic failure after admission" } }));
      return;
    }
    if (lastMessage?.includes("LAST_MODEL_HOLD_REPLY")) await new Promise(resolve => { releaseHeldReply = resolve; });
  }
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "MODEL_SELECTION_OK" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const config = join(userHome, ".areal", "config.toml");
await writeFile(config, `schema_version=1\n[model]\ncatalog_version=1\nprovider="theta"\nname="theta-model"\n` + ["theta", "arena"].map(id => `\n[model.providers.${id}]\nname="${id}"\nendpoint="http://127.0.0.1:${server.address().port}/v1/chat/completions"\nprotocol="chat-completions"\napi_key_env="AREAL_CREDENTIAL_MISSING_${id}"\nmodels=[{id="${id}-model",enabled=true${id === "theta" ? ",parameters={temperature=0.3}" : ""}}]\n`).join(""));
await writeFile(config, (await readFile(config, "utf8")) + `\n[model.providers.env]\nname="env"\nenabled=false\nendpoint="http://127.0.0.1:${server.address().port}/v1/chat/completions"\nprotocol="chat-completions"\napi_key_env="AREAL_CREDENTIAL_fixture_env"\nmodels=[{id="env-model",enabled=true}]\n`);
const env = { ...process.env, AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_CORE_HOME: join(scratch, "core"), AREAL_CORE_USER_HOME: userHome,
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_CORE_BIN: process.env.AREAL_CORE_BIN || resolve(gui, "../../target/debug/areal") };
for (const key of ["AREAL_CORE_WORKSPACE", "AREAL_CORE_CONFIG", "AREAL_HARNESS_HOME", "AREAL_HARNESS_CONFIG", "AREAL_CORE_DESKTOP_CONFIG", "AREAL_CREDENTIAL_MISSING_theta", "AREAL_CREDENTIAL_MISSING_arena"]) delete env[key];
for (const key of Object.keys(env)) if (key.startsWith("AREAL_HARNESS_") && key !== "AREAL_HARNESS_SERVICE_HOME") delete env[key];
const noProxy = [env.NO_PROXY, env.no_proxy, "127.0.0.1", "localhost"].filter(Boolean).join(",");
env.NO_PROXY = noProxy; env.no_proxy = noProxy;
// 非法凭据也不能被 Core 启动时的引用注入误标为可用。
env.AREAL_CREDENTIAL_MISSING_arena = "   ";
env.AREAL_CREDENTIAL_fixture_env = "fixture-key";
if (process.env.AREAL_GUI_EXECUTABLE) delete env.AREAL_CORE_BIN;
const coreBinary = process.env.AREAL_GUI_EXECUTABLE
  ? join(process.env.AREAL_GUI_EXECUTABLE, "../../Resources/areal-core/bin/areal")
  : env.AREAL_CORE_BIN;
const coreSha256 = createHash("sha256").update(await readFile(coreBinary)).digest("hex");
let app, page, stoppingAdapter, failure = null, passed = false;
const checks = [], errors = [];
const stoppedServices = [];
const button = name => page.getByRole("button", { name, exact: true });
async function openModelSettings() {
  await page.keyboard.press("Escape");
  await button("设置").click();
  await button("模型设置").click();
  await page.getByRole("heading", { name: "模型设置", exact: true }).waitFor();
}
async function captureModelThemes(name, menu = false) {
  for (const theme of ["dark", "light"]) {
    if (menu) await openModelSettings();
    await button("外观").click();
    await page.getByRole("combobox", { name: "界面主题", exact: true }).click();
    await page.getByRole("option", { name: theme === "dark" ? "深色" : "浅色", exact: true }).click();
    await page.waitForFunction(theme => document.documentElement.classList.contains(`theme-areal-${theme}`) && document.documentElement.classList.contains("dark") === (theme === "dark"), theme);
    if (menu) {
      await button("返回应用").click();
      await button("模型").click();
      await assertComposerActions();
      await assertCompactEffort();
      await page.waitForFunction(() => {
        const menu = document.querySelector('[aria-label="模型与思考强度"]');
        return menu && getComputedStyle(menu).opacity === "1";
      });
      await page.screenshot({ path: join(scratch, `${name}-effort-${theme}.png`), animations: "disabled" });
      const slider = page.getByRole("slider", { name: "思考强度", exact: true });
      const selected = await slider.getAttribute("aria-valuetext");
      await slider.hover({ position: { x: 14, y: 14 } });
      await page.getByRole("tooltip").filter({ hasText: /^低$/ }).waitFor();
      await page.waitForFunction(() => {
        const tooltip = document.querySelector('[role="tooltip"]');
        return tooltip && getComputedStyle(tooltip).opacity === "1";
      });
      assert.equal(await page.locator(".composer-effort-center strong").innerText(), selected, "hover feedback never changes the selected strength");
      await page.screenshot({ path: join(scratch, `${name}-hover-${theme}.png`), animations: "disabled" });
      await page.mouse.move(0, 0);
      await slider.focus();
      await page.getByRole("tooltip").filter({ hasText: selected }).waitFor();
      await page.waitForFunction(() => {
        const tooltip = document.querySelector('[role="tooltip"]');
        return tooltip && getComputedStyle(tooltip).opacity === "1";
      });
      await page.screenshot({ path: join(scratch, `${name}-focus-${theme}.png`), animations: "disabled" });
      await button("选择模型").focus();
      await page.getByRole("tooltip").waitFor({ state: "hidden" });
      await button("选择模型").click();
      await assertComposerActions();
      await page.screenshot({ path: join(scratch, `${name}-models-${theme}.png`), animations: "disabled" });
      await page.keyboard.press("Escape");
    } else {
      await button("模型设置").click();
      await page.locator(".provider-catalog-row").filter({ hasText: "theta" }).click();
      const status = page.getByRole("status", { name: "供应商状态", exact: true });
      await status.waitFor();
      assert.match(await status.innerText(), /缺少凭据/);
      assert.deepEqual((await page.locator(".provider-catalog-label").allTextContents()).map(label => label.trim()), ["已启用", "未启用"]);
      await page.screenshot({ path: join(scratch, `${name}-${theme}.png`), animations: "disabled" });
    }
  }
}
async function assertComposerActions() {
  assert.equal(await button("使用模型默认").count(), 0);
  assert.equal(await button("配置模型").count(), 0);
}
async function assertEmptyModelIndicator() {
  const indicator = page.getByText("暂无可用模型", { exact: true });
  await indicator.waitFor();
  assert.match(await indicator.getAttribute("title"), /暂无可用模型，请前往设置 > 模型设置/);
  const bounds = await indicator.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const toolbar = element.closest(".composer-toolbar")?.getBoundingClientRect() ?? element.parentElement.getBoundingClientRect();
    const style = getComputedStyle(element);
    const text = document.createRange(); text.selectNodeContents(element);
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, textHeight: text.getBoundingClientRect().height, lineHeight: parseFloat(style.lineHeight), toolbarTop: toolbar.top, toolbarBottom: toolbar.bottom };
  });
  assert.ok(bounds.textHeight <= bounds.lineHeight + 1, "the empty model indicator stays on one line");
  assert.ok(bounds.top >= bounds.toolbarTop - 1 && bounds.bottom <= bounds.toolbarBottom + 1, "empty model text stays within the composer toolbar");
  assert.ok(bounds.left >= 0 && bounds.right <= await page.evaluate(() => innerWidth), "empty model text stays inside the window");
}
async function assertCompactEffort() {
  const menu = page.getByRole("dialog", { name: "模型与思考强度", exact: true });
  assert.equal(await menu.getByRole("button", { name: /^(无|最少|低|中|高|极高|最高)$/ }).filter({ hasText: /./ }).count(), 0, "strength choices have no permanently visible text row");
  assert.equal(await page.getByRole("tooltip").count(), 0, "strength feedback stays hidden before interaction");
}
async function chooseEffort(name, key) {
  const slider = page.getByRole("slider", { name: "思考强度", exact: true });
  const hasSlider = await slider.count();
  if (hasSlider) {
    await page.evaluate(() => {
      const input = document.querySelector('[aria-label="思考强度"]');
      const editor = document.querySelector('[data-testid="chat-input"]');
      const violations = [];
      const observer = new MutationObserver(records => {
        for (const record of records) {
          if (record.target === input && record.attributeName === "disabled") violations.push("slider disabled");
          if (record.target === editor && record.attributeName === "contenteditable") violations.push("editor editability changed");
        }
      });
      observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ["disabled", "contenteditable"] });
      window.effortContinuity = { observer, violations, input };
    });
    await slider.press(key);
  } else {
    const choice = page.getByRole("group", { name: "选择思考强度", exact: true }).getByRole("button", { name, exact: true });
    await button("选择模型").focus();
    await page.keyboard.press("Tab");
    assert.equal(await choice.evaluate(element => element === document.activeElement), true, "the first unselected strength is keyboard reachable");
    await page.getByRole("tooltip").filter({ hasText: name }).waitFor();
    await choice.press("Enter");
  }
  await waitForSavedEffort(name);
  assert.equal(await page.locator(".composer-effort-center strong").innerText(), name, "top label follows the saved selection");
  if (hasSlider) {
    const continuity = await page.evaluate(() => {
      const { observer, violations, input } = window.effortContinuity;
      observer.disconnect();
      delete window.effortContinuity;
      return { violations, focused: document.activeElement === input };
    });
    assert.deepEqual(continuity.violations, [], "saving effort never disables the editor or blurs the slider");
    assert.equal(continuity.focused, true, "keyboard effort changes retain slider focus");
  }
}
async function waitForSavedEffort(name) {
  // The range previews pointerIndex while Core saves; the label reflects confirmed configuration.
  await page.waitForFunction(name => document.querySelector('[aria-label="思考强度"]')?.getAttribute("aria-valuetext") === name
    && document.querySelector(".composer-effort-center strong")?.textContent === name
    && !document.querySelector(".composer-model-trigger")?.hasAttribute("aria-busy"), name);
}
async function saveProvider() {
  await button("保存").click();
  await button("返回应用").click({ trial: true, timeout: 180_000 });
  assert.equal(await button("保存").isDisabled(), true, "One Save persists the draft without a busy retry");
  await until(async () => (await call("providers", { operation: "list" })).pendingApply === false, "saved configuration is applied");
  assert.equal(await button("应用模型配置").count(), 0);
}

const state = () => page.evaluate(() => window.arealDesktop.snapshot());
const fixtureProject = snapshot => snapshot.projects.find(project => project.root === workspace);
async function call(name, params) {
  const result = await page.evaluate(({ name, params }) => window.arealDesktop.command(name, params), { name, params });
  assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
}
async function until(predicate, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { const snapshot = await state(); if (await predicate(snapshot)) return snapshot; await new Promise(resolve => setTimeout(resolve, 80)); }
  throw new Error(`Timeout: ${label}`);
}
async function stopService() {
  if (stoppingAdapter?.applicationOwner) {
    await assertApplicationStopped(coreBinary, env, stoppingAdapter);
    stoppedServices.push({ pid: stoppingAdapter.pid, exited: true });
    stoppingAdapter = undefined;
    return;
  }
  const { ServiceConnection } = require("../app/src/core/service-client.cjs");
  const connection = new ServiceConnection();
  const metadata = JSON.parse(await readFile(join(scratch, "core/service.json"), "utf8"));
  try {
    await connection.connect(metadata);
    const drainDeadline = Date.now() + 15000;
    for (;;) {
      try { await connection.request("stopService", { protocol: metadata.protocol }, true); break; }
      catch (error) {
        // A known busy rejection has not submitted a stop; let this fixture's requests drain.
        if (!/请等待已提交操作完成/.test(error.message) || Date.now() >= drainDeadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  } finally { connection.close(); }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { process.kill(metadata.pid, 0); }
    catch (error) {
      if (error.code !== "ESRCH") throw error;
      stoppedServices.push({ pid: metadata.pid, exited: true });
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Isolated backend ${metadata.pid} did not exit`);
}
async function launch() {
  app = await electron.launch({ executablePath: process.env.AREAL_GUI_EXECUTABLE || require("electron"), args: process.env.AREAL_GUI_EXECUTABLE ? [] : [join(gui, "app")], env, timeout: 120000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on("pageerror", error => errors.push(error.message));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  // 本专项统计执行请求；提示预测由独立专项验收，避免辅助请求混入不重放断言。
  const preferencesChanged = await page.evaluate(() => {
    const key = "areal-gui:application-preferences";
    const preferences = JSON.parse(localStorage.getItem(key) ?? "{}");
    if (preferences.nextPromptSuggestions === false) return false;
    localStorage.setItem(key, JSON.stringify({ ...preferences, nextPromptSuggestions: false }));
    return true;
  });
  if (preferencesChanged) {
    await page.reload();
    await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  }
  await until(s => s.connection?.state === "ready", "desktop ready");
  await app.evaluate(({ dialog, BrowserWindow }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    dialog.showMessageBox = async () => ({ response: 1 });
    BrowserWindow.getAllWindows()[0].setSize(1440, 960);
  }, workspace);
}
async function closeGui() {
  const current = app;
  if (!current) return;
  const child = current.process();
  stoppingAdapter = await readFile(join(scratch, "core/service.json"), "utf8").then(JSON.parse).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (failure) {
    await current.evaluate(({ app }) => app.exit(1)).catch(error => { if (child.exitCode === null) throw error; });
  } else {
    await current.evaluate(({ Menu }) => {
      const quit = Menu.getApplicationMenu().items[0].submenu.items.find(item => item.label === "退出 AReaL Harness");
      if (!quit) throw new Error("Safe application quit menu is missing");
      quit.click();
    }).catch(error => { if (child.exitCode === null) throw error; });
  }
  const deadline = Date.now() + 15000;
  while (child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.notEqual(child.exitCode, null, "owned Electron process exits");
  app = undefined;
}
async function verifyModelCapabilities() {
  await page.waitForFunction(async () => {
    const reply = await window.arealDesktop.command("serviceStatus", {});
    return reply.ok && !reply.value.busy && !reply.value.activeCommands && !reply.value.starting && !reply.value.providerUpdating;
  });
  const previous = await call("providers", { operation: "list" });
  const seeded = await call("providers", { operation: "saveAndApply", expectedRevision: previous.revision, authentication: "none", provider: {
    name: "Capabilities", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, protocol: "chatCompletions", enabled: true, parameters: {},
    models: [{ id: "legacy-capabilities", enabled: true, parameters: {} }],
  } });
  const provider = seeded.data.find(item => item.name === "Capabilities");
  await button("刷新供应商").click();
  await page.locator(".provider-catalog-row").filter({ hasText: "Capabilities" }).click();
  await button("添加模型").click();
  let editor = page.getByRole("dialog", { name: "添加模型", exact: true });
  await editor.waitFor();
  assert.equal(await editor.getByRole("switch", { name: "工具调用", exact: true }).getAttribute("aria-checked"), "true");
  assert.equal(await editor.getByRole("switch", { name: "视觉输入", exact: true }).getAttribute("aria-checked"), "false");
  assert.equal(await editor.getByRole("switch", { name: "推理能力", exact: true }).getAttribute("aria-checked"), "true");
  assert.equal(await editor.getByRole("spinbutton", { name: "模型温度", exact: true }).count(), 0);
  for (const name of ["低", "中", "高", "极高"]) assert.equal(await editor.getByRole("checkbox", { name, exact: true }).isChecked(), true);
  for (const name of ["无", "最少", "最高"]) assert.equal(await editor.getByRole("checkbox", { name, exact: true }).isChecked(), false);
  const fields = {
    id: editor.getByRole("textbox", { name: "模型 ID", exact: true }),
    name: editor.getByRole("textbox", { name: "显示名称", exact: true }),
    context: editor.getByRole("spinbutton", { name: "模型上下文 Token", exact: true }),
    output: editor.getByRole("spinbutton", { name: "模型最大输出 Token", exact: true }),
  };
  await fields.id.fill("capability-model"); await fields.name.fill("Capability model");
  await fields.context.fill("500000"); await fields.output.fill("12000");
  const boxes = Object.fromEntries(await Promise.all(Object.entries(fields).map(async ([key, locator]) => [key, await locator.boundingBox()])));
  assert.ok(Math.abs(boxes.id.y - boxes.name.y) <= 2 && boxes.id.x + boxes.id.width <= boxes.name.x, "model ID and name share a two-column row");
  assert.ok(Math.abs(boxes.context.y - boxes.output.y) <= 2 && boxes.context.x + boxes.context.width <= boxes.output.x, "context and output budgets share a two-column row");
  await page.screenshot({ path: join(scratch, "custom-model-defaults.png"), animations: "disabled" });
  await editor.getByRole("button", { name: "保存模型", exact: true }).click(); await saveProvider();
  const configuredModel = async () => (await call("providers", { operation: "list" })).data.find(item => item.id === provider.id).models.find(item => item.id === "capability-model");
  const saved = await configuredModel();
  assert.deepEqual(saved.capabilities, { tools: true, vision: false, reasoning: true, reasoningEffortOptions: ["low", "medium", "high", "xhigh"] });
  assert.equal(saved.parameters.contextWindowTokens, 500000); assert.equal(saved.parameters.maxOutputTokens, 12000);
  await until(snapshot => fixtureProject(snapshot)?.models.some(model => model.modelId === "capability-model"), "custom capabilities reach Core catalog");
  const catalogModel = snapshot => fixtureProject(snapshot).models.find(model => model.modelId === "capability-model");
  assert.deepEqual(catalogModel(await state()).reasoningEffortOptions, ["low", "medium", "high", "xhigh"]);
  await button("返回应用").click(); await createProjectConversation(page, "workspace");
  await button("模型").click();
  await page.getByRole("radio", { name: "Capability model", exact: true }).click(); await page.keyboard.press("Escape");
  await captureModelThemes("composer-selection", true);
  const send = async (text, expected) => {
    const before = modelRequests.length;
    const currentId = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
    const beforeTurns = fixtureProject(await state())?.state?.threads?.[currentId]?.turns?.length ?? 0;
    await page.getByTestId("chat-input").fill(text); await button("发送").click();
    await page.waitForFunction(() => document.querySelector('[data-testid="areal-workbench"]')?.dataset.threadId);
    const threadId = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
    await until(snapshot => fixtureProject(snapshot)?.state?.threads?.[threadId]?.turns?.length === beforeTurns + 1 && fixtureProject(snapshot).state.threads[threadId].turns.at(-1).status === "completed" && modelRequests.length === before + 1, text);
    assert.deepEqual(modelRequests.at(-1), expected);
  };
  await button("模型").click();
  assert.equal(await page.getByRole("slider", { name: "思考强度", exact: true }).getAttribute("max"), "3");
  await assertComposerActions();
  assert.equal(await page.getByRole("slider", { name: "思考强度", exact: true }).getAttribute("aria-valuetext"), "中");
  await page.keyboard.press("Escape");
  await send("New reasoning model displays and sends concrete medium", { model: "capability-model", effort: "medium", hasEffort: true });
  await button("模型").click();
  await chooseEffort("极高", "End");
  await button("选择模型").focus();
  await page.getByRole("tooltip").waitFor({ state: "hidden" });
  const dragSlider = page.getByRole("slider", { name: "思考强度", exact: true });
  await page.waitForFunction(() => document.querySelector('[aria-label="思考强度"]')?.disabled === false);
  const dragBounds = await dragSlider.boundingBox();
  assert.ok(dragBounds);
  await page.mouse.move(dragBounds.x + dragBounds.width - 14, dragBounds.y + 14);
  await page.mouse.down();
  await page.mouse.move(dragBounds.x + 14, dragBounds.y + 14, { steps: 8 });
  await page.mouse.up();
  await waitForSavedEffort("低");
  await page.waitForFunction(() => document.querySelector('[aria-label="思考强度"]')?.disabled === false);
  await page.mouse.move(dragBounds.x + 14, dragBounds.y + 14);
  await page.mouse.down();
  await page.mouse.move(dragBounds.x + dragBounds.width - 14, dragBounds.y + 14, { steps: 8 });
  await page.mouse.up();
  await waitForSavedEffort("极高");
  await page.keyboard.press("Escape");
  await send("Recommended extra-high effort reaches provider", { model: "capability-model", effort: "xhigh", hasEffort: true });
  const editCapabilities = async () => {
    await openModelSettings();
    await page.locator(".provider-catalog-row").filter({ hasText: "Capabilities" }).click();
    await button("模型 Capability model 更多操作").click();
    await page.getByRole("menuitem", { name: "编辑模型 capability-model", exact: true }).click();
    editor = page.getByRole("dialog", { name: "编辑模型", exact: true }); await editor.waitFor();
  };
  await editCapabilities();
  await editor.getByRole("switch", { name: "推理能力", exact: true }).click();
  await editor.getByRole("button", { name: "保存模型", exact: true }).click(); await saveProvider();
  assert.equal((await configuredModel()).capabilities.reasoning, false);
  await button("返回应用").click();
  await send("Explicitly disabled reasoning omits the selected effort", { model: "capability-model", effort: null, hasEffort: false });
  await editCapabilities();
  await editor.getByRole("switch", { name: "推理能力", exact: true }).click();
  const effortGroup = editor.getByRole("group", { name: "允许的推理强度", exact: true });
  for (const checkbox of await effortGroup.getByRole("checkbox").all()) if (await checkbox.isChecked()) await checkbox.click();
  await effortGroup.getByRole("checkbox", { name: "低", exact: true }).click();
  await effortGroup.getByRole("checkbox", { name: "高", exact: true }).click();
  await page.screenshot({ path: join(scratch, "custom-model-reasoning-options.png"), animations: "disabled" });
  await editor.getByRole("button", { name: "保存模型", exact: true }).click(); await saveProvider();
  assert.deepEqual((await configuredModel()).capabilities, { tools: true, vision: false, reasoning: true, reasoningEffortOptions: ["low", "high"] });
  await until(snapshot => JSON.stringify(catalogModel(snapshot)?.reasoningEffortOptions) === JSON.stringify(["low", "high"]), "configured effort subset reaches Composer catalog");
  await button("返回应用").click();
  const unsupportedHistory = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
  await createProjectConversation(page, "workspace");
  assert.match(await button("模型").innerText(), /Capability model 低/);
  await send("Unsupported remembered strength falls back to first offered option", { model: "capability-model", effort: "low", hasEffort: true });
  await selectConversation(page, unsupportedHistory);
  assert.match(await button("模型").innerText(), /未指定/);
  await button("模型").click();
  let slider = page.getByRole("slider", { name: "思考强度", exact: true });
  assert.equal(await slider.count(), 0, "unsupported historical strength has no selected slider");
  await chooseEffort("低", "Home");
  await slider.waitFor();
  assert.equal(await slider.getAttribute("max"), "1");
  await slider.press("End");
  await waitForSavedEffort("高");
  await slider.press("Home");
  await waitForSavedEffort("低");
  await page.keyboard.press("Escape");
  await send("Configured lower effort reaches provider", { model: "capability-model", effort: "low", hasEffort: true });
  await button("模型").click(); await slider.press("End");
  await waitForSavedEffort("高");
  await page.keyboard.press("Escape");
  await send("Configured upper effort reaches provider", { model: "capability-model", effort: "high", hasEffort: true });
  await editCapabilities(); await editor.getByRole("switch", { name: "推理能力", exact: true }).click();
  await editor.getByRole("button", { name: "保存模型", exact: true }).click(); await saveProvider();
  assert.deepEqual((await configuredModel()).capabilities, { tools: true, vision: false, reasoning: false });
  await button("返回应用").click();
  await send("Disabling reasoning with a saved subset clears its options", { model: "capability-model", effort: null, hasEffort: false });
  await editCapabilities(); await editor.getByRole("switch", { name: "推理能力", exact: true }).click();
  for (const checkbox of await effortGroup.getByRole("checkbox").all()) if (await checkbox.isChecked()) await checkbox.click();
  await editor.getByRole("button", { name: "保存模型", exact: true }).click(); await saveProvider();
  assert.deepEqual((await configuredModel()).capabilities.reasoningEffortOptions ?? [], []);
  await until(snapshot => JSON.stringify(catalogModel(snapshot)?.reasoningEffortOptions) === JSON.stringify(["none", "minimal", "low", "medium", "high", "xhigh"]), "empty configured subset uses the standard effort options");
  await button("返回应用").click(); await button("模型").click();
  slider = page.getByRole("slider", { name: "思考强度", exact: true });
  assert.equal(await slider.getAttribute("max"), "5"); await slider.press("End");
  await waitForSavedEffort("极高");
  await page.screenshot({ path: join(scratch, "custom-model-effort-fallback.png"), animations: "disabled" }); await page.keyboard.press("Escape");
  await send("Empty effort subset uses the standard maximum", { model: "capability-model", effort: "xhigh", hasEffort: true });
  await editCapabilities(); await editor.getByRole("switch", { name: "推理能力", exact: true }).click();
  await editor.getByRole("button", { name: "保存模型", exact: true }).click(); await saveProvider();
  await button("返回应用").click(); await button("模型").click();
  assert.equal(await page.getByRole("slider", { name: "思考强度", exact: true }).count(), 0); await page.keyboard.press("Escape");
  await send("Disabling reasoning removes a prior selected effort", { model: "capability-model", effort: null, hasEffort: false });
  checks.push("custom model defaults, paired budget fields, persisted capabilities, configured effort subset, empty-list fallback, and reasoning disablement govern actual Core requests");
  await openModelSettings();
  await page.locator(".provider-catalog-row").filter({ hasText: "Capabilities" }).waitFor();
  await page.waitForFunction(async () => {
    const reply = await window.arealDesktop.command("serviceStatus", {});
    return reply.ok && !reply.value.busy && !reply.value.activeCommands && !reply.value.starting && !reply.value.providerUpdating;
  });
  const current = await call("providers", { operation: "list" });
  await call("providers", { operation: "removeAndApply", id: provider.id, expectedRevision: current.revision });
  await button("刷新供应商").click();
}
async function verifyModelDefaults(projectId) {
  await page.waitForFunction(async () => {
    const reply = await window.arealDesktop.command("serviceStatus", {});
    return reply.ok && !reply.value.busy && !reply.value.activeCommands && !reply.value.starting && !reply.value.providerUpdating;
  });
  const previous = await call("providers", { operation: "list" });
  const seeded = await call("providers", { operation: "saveAndApply", expectedRevision: previous.revision, authentication: "none", provider: {
    name: "Defaults", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, protocol: "chatCompletions", enabled: true, parameters: {},
    models: [{ id: "alpha-default", displayName: "Alpha", enabled: true, parameters: { reasoningEffort: "high", temperature: 0.4, maxOutputTokens: 4096 } }, { id: "beta-default", displayName: "Beta", enabled: true, parameters: {} }],
  } });
  const provider = seeded.data.find(item => item.name === "Defaults");
  assert.ok(provider);
  const snapshotProject = snapshot => snapshot.projects.find(item => item.id === projectId);
  const expectModel = async (name, effort) => {
    await page.waitForFunction(({ name, effort }) => {
      const label = document.querySelector('button[aria-label="模型"]')?.textContent ?? "";
      return label.includes(name) && label.includes(effort);
    }, { name, effort });
  };
  const settings = async () => {
    await openModelSettings();
  };
  const setDefault = async (name, reference = { providerId: provider.id, modelId: name === "Alpha" ? "alpha-default" : "beta-default" }) => {
    await button("会话配置").click();
    await page.waitForFunction(() => {
      const menu = document.querySelector('[role="combobox"][aria-label="备用默认模型"]');
      const tabs = document.querySelector('[role="tablist"][aria-label="备用默认模型"]');
      return (menu && !menu.disabled) || (tabs && [...tabs.querySelectorAll('[role="tab"]')].some(tab => !tab.disabled));
    });
    const defaultMenu = page.getByRole("combobox", { name: "备用默认模型", exact: true });
    if (await defaultMenu.count()) {
      await defaultMenu.click();
      await page.getByRole("option", { name, exact: true }).click();
    } else await page.getByRole("tablist", { name: "备用默认模型", exact: true }).getByRole("tab", { name, exact: true }).click();
    await button("返回应用").click({ trial: true, timeout: 180000 });
    const configured = await call("providers", { operation: "list" });
    assert.deepEqual(configured.defaultModel, reference);
    assert.equal(configured.pendingApply, false);
    if (await defaultMenu.count()) assert.equal((await defaultMenu.innerText()).trim(), name, "default picker shows the model name rather than its internal reference");
    else assert.equal(await page.getByRole("tablist", { name: "备用默认模型", exact: true }).getByRole("tab", { name, exact: true }).getAttribute("aria-selected"), "true");
  };
  const chooseModel = async name => {
    await button("模型").click(); await button("选择模型").click();
    await page.getByRole("radio", { name, exact: true }).click();
    await page.keyboard.press("Escape");
  };
  const chooseNone = async () => {
    await button("模型").click();
    const threadId = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
    await assertComposerActions();
    await chooseEffort("无", "Home");
    await until(snapshot => snapshotProject(snapshot)?.configurations?.[threadId]?.parameters?.reasoningEffort === "none", "keyboard selects the first explicit none option");
    await page.waitForFunction(() => !document.querySelector('button[aria-label="模型"]')?.disabled);
    await page.keyboard.press("Escape");
  };
  const send = async (text, expected) => {
    const before = modelRequests.length;
    await page.getByTestId("chat-input").fill(text); await button("发送").click();
    await page.waitForFunction(() => document.querySelector('[data-testid="areal-workbench"]')?.dataset.threadId);
    const threadId = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
    await until(snapshot => snapshotProject(snapshot)?.state?.threads?.[threadId]?.turns?.at(-1)?.status === "completed" && modelRequests.length === before + 1, text);
    assert.deepEqual(modelRequests.at(-1), expected);
    return threadId;
  };
  await page.getByRole("button", { name: "刷新供应商", exact: true }).click();
  await setDefault("Alpha");
  await page.screenshot({ path: join(scratch, "default-model-settings.png"), animations: "disabled" });
  await button("返回应用").click();
  await createProjectConversation(page, "workspace");
  await chooseModel("Alpha");
  await expectModel("Alpha", "高");
  const switched = await send("Default Alpha uses configured high", { model: "alpha-default", effort: "high", hasEffort: true });
  const alphaConfiguration = snapshotProject(await state()).configurations[switched];
  assert.equal(alphaConfiguration.parameters.temperature, 0.4);
  assert.equal(alphaConfiguration.parameters.maxOutputTokens, 4096);
  await chooseModel("Alpha");
  assert.deepEqual(snapshotProject(await state()).configurations[switched], alphaConfiguration, "clicking selected model retains its configuration");
  await chooseModel("Beta");
  await expectModel("Beta", "中");
  const switchedParameters = snapshotProject(await state()).configurations[switched].parameters;
  assert.ok(switchedParameters.temperature == null, "model switch clears the previous model temperature");
  assert.ok(switchedParameters.maxOutputTokens == null, "model switch clears the previous model output budget");
  await chooseNone();
  await expectModel("Beta", "无");
  await until(snapshot => snapshotProject(snapshot)?.configurations?.[switched]?.parameters?.reasoningEffort === "none", "unsent model and effort changes persist");
  await createProjectConversation(page, "workspace");
  await expectModel("Alpha", "高");
  const alpha = await send("Unsent Beta selection does not change last accepted Alpha", { model: "alpha-default", effort: "high", hasEffort: true });
  await settings(); await setDefault("Beta"); await button("返回应用").click();
  await expectModel("Alpha", "高");
  await createProjectConversation(page, "workspace"); await expectModel("Alpha", "高");
  await chooseModel("Beta"); await expectModel("Beta", "中");
  const beta = await send("Explicit draft Beta displays and sends medium", { model: "beta-default", effort: "medium", hasEffort: true });
  await chooseNone(); await expectModel("Beta", "无");
  await send("Explicit none remains distinct", { model: "beta-default", effort: "none", hasEffort: true });
  await createProjectConversation(page, "workspace"); await expectModel("Beta", "无");
  await send("New conversation inherits accepted explicit none", { model: "beta-default", effort: "none", hasEffort: true });
  await selectConversation(page, beta); await expectModel("Beta", "无");
  await call("configure", { projectId, threadId: beta, parameters: { reasoningEffort: null } });
  await expectModel("Beta", "未指定");
  const historicalConfig = snapshotProject(await state()).configurations[beta];
  await button("模型").click();
  await assertComposerActions();
  assert.equal(await page.getByRole("slider", { name: "思考强度", exact: true }).count(), 0);
  await page.keyboard.press("Escape");
  assert.deepEqual(snapshotProject(await state()).configurations[beta], historicalConfig, "opening historical unspecified strength does not write configuration");
  await button("模型").click(); await chooseEffort("无", "Home");
  await expectModel("Beta", "无");
  await page.keyboard.press("Escape");
  await until(snapshot => snapshotProject(snapshot)?.configurations?.[beta]?.parameters?.reasoningEffort === "none", "keyboard selects explicit none from unspecified history");
  await call("configure", { projectId, threadId: beta, parameters: { reasoningEffort: null } });
  await expectModel("Beta", "未指定");
  await send("Historical unspecified effort stays omitted until explicitly selected", { model: "beta-default", effort: null, hasEffort: false });
  const failedRequestId = randomUUID();
  const failedSubmission = { projectId, threadId: switched, requestId: failedRequestId, text: "LAST_MODEL_ACCEPTED_FAILURE" };
  const failed = await call("send", failedSubmission);
  assert.equal(failed.lastAcceptedModel.modelId, "beta-default", "admission records selection before model success");
  assert.equal(failed.lastAcceptedModel.reasoningEffort, "none");
  await until(snapshot => snapshotProject(snapshot)?.state?.threads?.[switched]?.turns?.at(-1)?.status === "failed", "model failure after admission");
  await createProjectConversation(page, "workspace"); await expectModel("Beta", "无");
  const held = await call("send", { projectId, threadId: alpha, text: "LAST_MODEL_HOLD_REPLY" });
  await until(() => !!releaseHeldReply, "held model request");
  assert.equal(held.lastAcceptedModel.modelId, "alpha-default");
  const queued = await call("send", { projectId, threadId: alpha, text: "Queued preference admission" });
  assert.ok(queued.queueItemId, "active main submission is queued");
  assert.ok(queued.lastAcceptedModel.acceptedAt > held.lastAcceptedModel.acceptedAt, "queue admission updates preference without waiting for execution");
  await selectConversation(page, switched); await expectModel("Beta", "无");
  await send("Newer Beta admission while Alpha is queued", { model: "beta-default", effort: "none", hasEffort: true });
  const beforeQueueExecution = snapshotProject(await state()).lastAcceptedModel;
  releaseHeldReply(); releaseHeldReply = undefined;
  await until(snapshot => snapshotProject(snapshot)?.state?.threads?.[alpha]?.turns?.at(-1)?.status === "completed" && snapshotProject(snapshot).state.threads[alpha].turns.at(-1).items.some(item => item.type === "userMessage" && JSON.stringify(item.content).includes("Queued preference admission")), "queued Alpha executes");
  assert.deepEqual(snapshotProject(await state()).lastAcceptedModel, beforeQueueExecution, "background queue execution cannot replace a newer admission");
  await createProjectConversation(page, "workspace"); await expectModel("Beta", "无");
  await selectConversation(page, alpha); await expectModel("Alpha", "高");
  await send("Historical Alpha ignores changed global default", { model: "alpha-default", effort: "high", hasEffort: true });
  const beforeReceiptReplay = snapshotProject(await state()).lastAcceptedModel, requestsBeforeReplay = modelRequests.length;
  const replayed = await page.evaluate(parameters => window.arealDesktop.command("send", parameters), failedSubmission);
  assert.equal(replayed.ok, false, "Desktop rejects reusing a known submitted request ID");
  assert.match(replayed.error.message, /请求标识已使用/);
  assert.equal(modelRequests.length, requestsBeforeReplay, "duplicate submission does not execute the model again");
  assert.deepEqual(snapshotProject(await state()).lastAcceptedModel, beforeReceiptReplay, "duplicate submission cannot overwrite newer preference");
  checks.push("main and queued admission update preference before completion; model failure retains it; queued execution and rejected duplicate submission cannot overwrite newer admission");
  await selectConversation(page, switched); await expectModel("Beta", "无");
  const beforeRestart = modelRequests.length;
  await writeFile(join(scratch, "model-defaults-before.json"), JSON.stringify(await state(), null, 2));
  await closeGui(); app = undefined; await stopService(); await launch();
  await until(snapshot => snapshotProject(snapshot)?.state?.connected, "model-defaults cold reopen");
  await selectConversation(page, alpha); await expectModel("Alpha", "高");
  await selectConversation(page, switched); await expectModel("Beta", "无");
  await selectConversation(page, beta); await expectModel("Beta", "未指定");
  assert.equal(modelRequests.length, beforeRestart, "cold reopen and history navigation cannot replay requests");
  await page.screenshot({ path: join(scratch, "model-defaults-reopened.png"), animations: "disabled" });
  await createProjectConversation(page, "workspace"); await expectModel("Alpha", "高");
  await send("Cold new conversation inherits last accepted Alpha despite history navigation", { model: "alpha-default", effort: "high", hasEffort: true });
  const preference = snapshotProject(await state()).lastAcceptedModel;
  assert.equal(preference.modelId, "alpha-default");
  assert.equal(preference.reasoningEffort, "high");
  // A side turn is an explicit user submission, but cannot update the main preference.
  const side = await call("side", { projectId, sourceThreadId: alpha, operation: "start", text: "Side preference isolation", model: { providerId: provider.id, modelId: "beta-default" }, parameters: { reasoningEffort: "none" } });
  await until(snapshot => snapshotProject(snapshot)?.state?.threads?.[side.threadId]?.turns?.at(-1)?.status === "completed", "side first reply");
  await call("side", { projectId, threadId: side.threadId, operation: "send", text: "Side follow-up cannot update main preference" });
  await until(snapshot => snapshotProject(snapshot)?.state?.threads?.[side.threadId]?.turns?.length === 2 && snapshotProject(snapshot).state.threads[side.threadId].turns.at(-1).status === "completed", "side follow-up reply");
  assert.deepEqual(snapshotProject(await state()).lastAcceptedModel, preference, "side admission does not replace main preference");
  const secondWorkspace = join(scratch, "second-workspace");
  await mkdir(secondWorkspace); execFileSync("git", ["init", "-b", "main"], { cwd: secondWorkspace, stdio: "ignore" });
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, secondWorkspace);
  await button("打开项目").click();
  await until(snapshot => snapshot.projects.find(item => item.root === secondWorkspace)?.state?.connected, "second project ready");
  await createProjectConversation(page, "second-workspace"); await expectModel("Alpha", "高");
  await page.screenshot({ path: join(scratch, "last-model-cross-project.png"), animations: "disabled" });
  await createProjectConversation(page, "workspace");
  // A rejected request cannot advance the preference.
  const rejected = await page.evaluate(({ projectId, threadId }) => window.arealDesktop.command("send", { projectId, threadId, text: "" }), { projectId, threadId: alpha });
  assert.equal(rejected.ok, false);
  assert.deepEqual(snapshotProject(await state()).lastAcceptedModel, preference, "rejected submission preserves preference");
  checks.push("Side first/follow-up turns and rejected messages preserve the main preference; a new project inherits the same accepted model/effort");
  await writeFile(join(scratch, "model-defaults-after.json"), JSON.stringify(await state(), null, 2));
  checks.push("New conversations inherit last admitted main model/effort; fallback settings, unsent changes and history navigation cannot override it; existing configurations and preference survive cold GUI/Core restart without replay");
  checks.push("configured high, concrete medium, explicit none, and historical unspecified labels match actual model requests; first strength is selectable");
  await closeGui(); app = undefined; await stopService();
  await writeFile(config, `schema_version=1\n[model]\nprovider="legacy"\nname="legacy-alpha"\nreasoning_effort="high"\n[model.providers.legacy]\nname="Legacy"\nendpoint="http://127.0.0.1:${server.address().port}/v1/chat/completions"\nprotocol="chat-completions"\nmodels=[{id="legacy-alpha",display_name="Legacy Alpha"},{id="legacy-beta",display_name="Legacy Beta"}]\n`);
  await launch();
  await until(snapshot => snapshotProject(snapshot)?.state?.connected && snapshotProject(snapshot)?.models.some(model => model.modelId === "legacy-alpha"), "legacy service default ready");
  await selectConversation(page, alpha); await expectModel("alpha-default", "高");
  const missingHistoricalConfig = snapshotProject(await state()).configurations[alpha];
  await button("模型").click();
  assert.equal(await page.getByRole("radio", { name: "alpha-default", exact: true }).count(), 0, "historical missing identity is retained only in the trigger");
  await page.keyboard.press("Escape");
  assert.deepEqual(snapshotProject(await state()).configurations[alpha], missingHistoricalConfig, "opening the catalog never switches a historical model");
  const beforeLegacy = modelRequests.length;
  await createProjectConversation(page, "workspace"); await expectModel("legacy-alpha", "高");
  const implicit = await send("Implicit service default records effective high", { model: "legacy-alpha", effort: "high", hasEffort: true });
  const implicitConfig = snapshotProject(await state()).configurations[implicit];
  assert.ok(implicitConfig.defaultModelRevision, "desktop implicit model is pinned before global changes");
  assert.equal(implicitConfig.model, null);
  await settings(); await setDefault("Legacy Beta", { providerId: "legacy", modelId: "legacy-beta" }); await button("返回应用").click();
  await expectModel("legacy-alpha", "高");
  await chooseNone(); await expectModel("legacy-alpha", "无");
  await send("Implicit history keeps old identity while configuring effort", { model: "legacy-alpha", effort: "none", hasEffort: true });
  await button("模型").click(); await assertComposerActions(); await chooseEffort("极高", "End"); await page.waitForFunction(() => !document.querySelector('button[aria-label="模型"]')?.disabled); await chooseEffort("高", "ArrowLeft"); await page.keyboard.press("Escape");
  await expectModel("legacy-alpha", "高");
  await send("Implicit explicit high preserves archived model identity", { model: "legacy-alpha", effort: "high", hasEffort: true });
  await closeGui(); app = undefined; await stopService(); await launch();
  await until(snapshot => snapshotProject(snapshot)?.state?.connected, "implicit history cold reopen");
  await selectConversation(page, implicit); await expectModel("legacy-alpha", "高");
  assert.equal(snapshotProject(await state()).configurations[implicit].defaultModelRevision, implicitConfig.defaultModelRevision);
  assert.equal(modelRequests.length, beforeLegacy + 3, "implicit history cold reopen cannot replay requests");
  await createProjectConversation(page, "workspace"); await expectModel("Legacy Beta", "高");
  await send("New conversation uses changed concrete default", { model: "legacy-beta", effort: "high", hasEffort: true });
  await page.screenshot({ path: join(scratch, "implicit-default-reopened.png"), animations: "disabled" });
  checks.push("implicit desktop defaults pin model revision and effective effort across global default changes, effort reconfiguration and cold reopen; missing catalog entries retain historical identity");
}
try {
  await launch();
  await button("打开项目").click();
  await createProjectConversation(page, "workspace");
  const ready = await until(s => fixtureProject(s)?.state?.connected && fixtureProject(s).models.length === 3, "unavailable Core catalog");
  const projectId = fixtureProject(ready).id;
  assert.ok(fixtureProject(ready).models.every(m => m.available === false), "the default alias and named entries must all reject unavailable models");
  assert.ok(fixtureProject(ready).models.filter(m => m.providerId).every(m => m.credentialState === "unavailable"));
  assert.equal(await button("发送").isDisabled(), true, "a missing default credential cannot enable sending");
  assert.equal(await button("模型").count(), 0, "an unavailable catalog has no meaningless picker");
  await assertEmptyModelIndicator();
  assert.equal(await page.getByRole("radio").count(), 0, "missing-credential and disabled models stay out of the picker");
  assert.equal(requests.length, 0, "unavailable entries cannot send a model request");
  await page.screenshot({ path: join(scratch, "unavailable-models.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await button("定时任务").click();
  const taskDraftKey = "areal-gui:ordinary-schedule-creation";
  const taskDescription = "保留凭据修复前的任务描述";
  await page.evaluate(({ key, text }) => localStorage.setItem(key, JSON.stringify({ prepareId: crypto.randomUUID(), requestId: crypto.randomUUID(), text })), { key: taskDraftKey, text: taskDescription });
  await button("新建自动化").click();
  await page.getByRole("alert").filter({ hasText: /凭据/ }).waitFor();
  assert.equal(requests.length, 0, "a rejected task configuration cannot issue a model request");
  const rejectedDraft = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), taskDraftKey);
  assert.ok(rejectedDraft.projectId);
  assert.equal(rejectedDraft.pending, false);
  assert.equal(rejectedDraft.text, taskDescription, "credential rejection retains the complete local scheduling draft");
  assert.equal(rejectedDraft.threadId, undefined);
  await page.screenshot({ path: join(scratch, "scheduled-model-recovery.png"), animations: "disabled" });
  await openModelSettings();
  await page.getByRole("heading", { name: "模型设置", exact: true }).waitFor();
  checks.push("a missing default-provider credential permits Core connection and model settings without an upstream request");
  await page.locator(".provider-catalog-row").filter({ hasText: "theta" }).click();
  let providerStatus = page.getByRole("status", { name: "供应商状态", exact: true });
  await providerStatus.waitFor();
  assert.match(await providerStatus.innerText(), /缺少凭据/);
  const navigation = page.locator(".provider-navigation");
  assert.equal(await navigation.locator(".provider-catalog-row small").count(), 0, "provider navigation contains names without credential details");
  assert.deepEqual((await navigation.locator(".provider-catalog-row").allTextContents()).map(name => name.trim()).sort(), ["ChatGPT", "arena", "env", "theta"].sort());
  assert.deepEqual((await navigation.locator(".provider-catalog-label").allTextContents()).map(name => name.trim()), ["已启用", "未启用"]);
  const separation = await navigation.locator(".provider-catalog > section + section").evaluate(element => {
    const style = getComputedStyle(element);
    return { margin: parseFloat(style.marginTop), padding: parseFloat(style.paddingTop), border: parseFloat(style.borderTopWidth) };
  });
  assert.ok(separation.margin > 0 && separation.padding > 0 && separation.border >= 1, "enabled and disabled provider groups have spacing and a divider");
  await captureModelThemes("provider-navigation");
  await page.locator(".provider-catalog-row").filter({ hasText: "theta" }).click();
  assert.match(await providerStatus.innerText(), /缺少凭据/, "credential diagnostics remain in the detail pane");
  checks.push("provider navigation shows names only in separated enabled and disabled groups; credential diagnostics remain in the detail pane in both themes");

  assert.equal(await page.getByRole("status", { name: "模型 theta-model 状态", exact: true }).count(), 0, "compact model rows show the name only");
  assert.equal(await page.getByText("帮助", { exact: true }).count(), 0);
  assert.equal(await page.getByText("凭据来源", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("tab", { name: "模型", exact: true }).count(), 0, "Connection fields and models share one page");
  assert.equal(await page.getByRole("combobox", { name: "备用默认模型", exact: true }).count(), 0, "global default belongs to session settings");
  const search = page.getByRole("searchbox", { name: "搜索模型名称或 ID", exact: true });
  const modelRow = page.locator(".provider-model-row").filter({ hasText: "theta-model" });
  assert.ok((await search.boundingBox()).y < (await modelRow.boundingBox()).y, "search precedes results");
  await search.fill("absent-model");
  await page.getByText("没有匹配的模型", { exact: true }).waitFor();
  await search.fill("");
  await page.getByRole("button", { name: "模型 theta-model 更多操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "编辑模型 theta-model", exact: true }).click();
  let editor = page.getByRole("dialog", { name: "编辑模型", exact: true });
  await editor.waitFor();
  const box = await editor.boundingBox();
  assert.ok(Math.abs(box.x + box.width / 2 - (await page.evaluate(() => innerWidth)) / 2) < 3, "model editor is a centered dialog");
  await editor.getByRole("textbox", { name: "显示名称", exact: true }).fill("Discarded name");
  await editor.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  assert.equal(await page.getByText("Discarded name", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "模型 theta-model 更多操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "编辑模型 theta-model", exact: true }).click();
  editor = page.getByRole("dialog", { name: "编辑模型", exact: true });
  assert.equal(await editor.getByRole("spinbutton", { name: "模型温度", exact: true }).count(), 0);
  await editor.getByRole("spinbutton", { name: "模型上下文 Token", exact: true }).fill("500000");
  await editor.getByRole("spinbutton", { name: "模型最大输出 Token", exact: true }).fill("12000");
  await page.screenshot({ path: join(scratch, "model-editor-dialog.png"), animations: "disabled" });
  await editor.getByRole("button", { name: "保存模型", exact: true }).click();
  assert.equal(await page.getByTestId("provider-base-url").isVisible(), true, "The same page exposes the connection endpoint");
  assert.equal(await button("保存").isEnabled(), true, "Model edits remain an unsaved provider draft");
  await page.screenshot({ path: join(scratch, "model-settings-models.png"), animations: "disabled" });
  checks.push("provider model search precedes results, centered editor discards edits, and the same page retains the unsaved provider draft");
  await page.getByRole("textbox", { name: "API Key", exact: true }).fill("fixture-key");
  assert.match(await providerStatus.innerText(), /缺少凭据/, "unsaved credentials cannot claim readiness");
  await saveProvider();
  const saved = await call("providers", { operation: "list" });
  assert.equal(saved.credentialStates.theta, "available");
  assert.deepEqual(saved.data.find(p => p.id === "theta").models[0].parameters, { temperature: 0.3, contextWindowTokens: 500000, maxOutputTokens: 12000 }, "model budget edits persist and preserve API-configured temperature");
  assert.equal(saved.credentialSources.theta, "stored");
  assert.equal(saved.pendingApply, false, "save confirms persistence and Core synchronization");
  await until(s => fixtureProject(s).models.some(m => m.available === true), "single save makes model available in Core");
  await page.screenshot({ path: join(scratch, "saved-model-configuration.png"), animations: "disabled" });
  await button("测试连接").click();
  await page.getByText("模型 theta-model 连接成功", { exact: true }).waitFor({ timeout: 5000 });
  assert.equal(await button("测试连接").isEnabled(), true);
  await until(() => probeRequests.length === 1 && probeRequests[0].closed, "successful probe releases the held HTTP stream");
  await page.screenshot({ path: join(scratch, "connection-probe-terminal.png"), animations: "disabled" });
  checks.push("The settings Test connection action succeeds and releases a gateway stream that sends a valid terminal event without closing");
  await button("返回应用").click();
  await createProjectConversation(page, "workspace");
  await page.getByTestId("chat-input").fill("OPEN_PROJECT_CANCEL_DRAFT");
  const projectBeforeCancel = await page.getByTestId("areal-workbench").getAttribute("data-project-id");
  await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  await button("打开项目").click();
  assert.equal((await page.getByTestId("chat-input").textContent()).trim(), "OPEN_PROJECT_CANCEL_DRAFT");
  assert.equal(await page.getByTestId("areal-workbench").getAttribute("data-project-id"), projectBeforeCancel);
  assert.equal((await state()).projects.filter(item => item.root === workspace).length, 1);
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, workspace);
  await button("打开项目").click();
  assert.equal((await state()).projects.filter(item => item.root === workspace).length, 1, "opening an existing project does not duplicate it");
  await page.getByTestId("chat-input").fill("");
  await page.screenshot({ path: join(scratch, "open-project-entry.png"), animations: "disabled" });
  checks.push("Projects + opens the existing picker directly; cancel preserves the project and draft; reopening a directory keeps one registration");
  await button("定时任务").click();
  await button("新建自动化").click();
  await page.getByTestId("chat-input").waitFor();
  await page.waitForFunction(key => localStorage.getItem(key) === null, taskDraftKey);
  await page.waitForFunction(text => document.querySelector('[data-testid="chat-input"]')?.textContent?.trim() === text, taskDescription);
  const recoveredProjectId = await page.getByTestId("areal-workbench").getAttribute("data-project-id");
  assert.equal(recoveredProjectId, rejectedDraft.projectId, "credential repair reuses the originally allocated independent workspace");
  const recoveredThreadId = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
  assert.ok(recoveredThreadId);
  assert.equal((await state()).projects.find(item => item.id === recoveredProjectId)?.state?.threads[recoveredThreadId]?.turns?.length, 0);
  assert.equal((await page.getByTestId("chat-input").textContent()).trim(), taskDescription);
  assert.equal(requests.length, 0, "repairing credentials and reopening the same task draft cannot replay or send input");
  await page.screenshot({ path: join(scratch, "scheduled-model-recovered.png"), animations: "disabled" });
  checks.push("scheduled creation explains unavailable credentials, opens model settings, and restores the same independent draft after a saved-key repair without sending input");
  await button("首页").click();
  await createProjectConversation(page, "workspace");
  await button("模型").click(); await button("选择模型").click();
  await page.getByRole("radio", { name: "theta-model", exact: true }).click();
  await page.keyboard.press("Escape");
  assert.match(await button("模型").innerText(), /theta-model/);
  assert.equal(requests.length, 0, "model selection does not create or send a task");
  await page.getByTestId("chat-input").fill("Use the configured model");
  await button("发送").click();
  await until(s => Object.values(fixtureProject(s).state.threads).some(t => t.turns?.at(-1)?.status === "completed"), "model turn completes");
  assert.deepEqual(requests, [{ model: "theta-model", authenticated: true, authorizationPresent: true }]);
  assert.equal(fixtureProject(await state()).configurations[Object.keys(fixtureProject(await state()).state.threads)[0]]?.model?.providerId, "theta", "the newly created Core task uses the chosen model");
  // 重启本次隔离后台，证明凭据从安全存储恢复，而非沿用旧进程的内存。
  await closeGui(); app = undefined;
  await stopService();
  await launch();
  providerStatus = page.getByRole("status", { name: "供应商状态", exact: true });
  await until(s => fixtureProject(s)?.state?.connected && fixtureProject(s).models.some(m => m.providerId === "theta" && m.available === true), "saved default credential survives a cold reopen");
  const reopened = await call("providers", { operation: "list" });
  assert.equal(reopened.defaultModel.providerId, "theta");
  assert.equal(reopened.credentialSources.theta, "stored");
  assert.equal(reopened.credentialStates.theta, "available");
  assert.equal(requests.length, 1, "reopening does not replay the completed request");
  await page.screenshot({ path: join(scratch, "reopened-default-credential.png"), animations: "disabled" });
  checks.push("the default provider's saved credential survives a cold GUI/backend reopen without replaying a request");
  // 默认凭据恢复已验收；后续启停用例沿用无全局默认项的独立目录前置条件。
  const withoutDefault = await call("providers", { operation: "default", model: null, expectedRevision: reopened.revision });
  await call("providers", { operation: "apply", expectedRevision: withoutDefault.revision });
  await until(s => fixtureProject(s).models.length === 2, "explicit default cleared for catalog enablement checks");
  await button("模型").click(); await button("选择模型").click();
  assert.equal(await page.getByRole("radio", { name: /arena-model/ }).count(), 0, "missing credentials stay hidden in a mixed catalog");
  assert.equal(await page.getByRole("radio", { name: "theta-model", exact: true }).isEnabled(), true);
  await openModelSettings();
  await page.getByRole("heading", { name: "模型设置", exact: true }).waitFor();
  checks.push("single save confirms persistence/Core readiness; user chooses a model in the existing Composer and Core executes it");
  // 启用开关、凭据与配置应用分别验收；两个可用模型之间必须能实际切换。
  await page.locator(".provider-catalog-row").filter({ hasText: "arena" }).click();
  await page.getByRole("textbox", { name: "API Key", exact: true }).fill("fixture-key");
  // 真实 Core 完成保存/同步后暂留回执，稳定覆盖目录已刷新但设置操作尚未结算的窗口。
  await app.evaluate(({ app }) => {
    const { ServiceConnection } = process.mainModule.require(`${app.getAppPath()}/src/core/service-client.cjs`);
    const original = ServiceConnection.prototype.request;
    let reached, release;
    const ready = new Promise(resolve => { reached = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    globalThis.modelApplyReceipt = { ready, release, restore: () => { ServiceConnection.prototype.request = original; } };
    ServiceConnection.prototype.request = async function (method, params, mutation) {
      const result = await original.call(this, method, params, mutation);
      if (method === "command" && params.name === "providers" && params.request.operation === "save") {
        reached(); await held;
      }
      return result;
    };
  });
  await button("保存").click();
  await until(s => fixtureProject(s).models.every(m => m.available === true), "both models available");
  await app.evaluate(() => globalThis.modelApplyReceipt.ready);
  assert.equal(await button("返回应用").isDisabled(), true, "back navigation must reflect the pending apply receipt");
  assert.equal(await button("常规").isDisabled(), true, "settings categories share the same navigation admission");
  await page.screenshot({ path: join(scratch, "apply-pending-navigation.png"), animations: "disabled" });
  await app.evaluate(() => {
    globalThis.modelApplyReceipt.release(); globalThis.modelApplyReceipt.restore(); delete globalThis.modelApplyReceipt;
  });
  await button("返回应用").click();
  await page.locator('[data-testid="areal-workbench"][data-view="workspace"]').waitFor();
  checks.push("settings navigation stays disabled while a real save receipt is pending and returns to the conversation after settlement");
  await button("模型").click(); await button("选择模型").click();
  const arena = page.getByRole("radio", { name: "arena-model", exact: true });
  assert.equal(await arena.isEnabled(), true); await arena.click();
  await page.keyboard.press("Escape");
  await until(s => fixtureProject(s).configurations[Object.keys(fixtureProject(s).state.threads)[0]]?.model?.providerId === "arena", "Core accepts Composer model selection");
  await page.getByTestId("chat-input").fill("Use the other configured model"); await button("发送").click();
  await until(s => Object.values(fixtureProject(s).state.threads).some(t => t.turns?.length === 2 && t.turns.at(-1).status === "completed"), "selected model turn completes");
  assert.deepEqual(requests.at(-1), { model: "arena-model", authenticated: true, authorizationPresent: true });
  await openModelSettings();
  await page.locator(".provider-catalog-row").filter({ hasText: "arena" }).click();
  // 无需认证是同一 Core 文件的编辑；不能继续发送已退役的保存凭据。
  await page.getByRole("tablist", { name: "认证方式", exact: true }).getByRole("tab", { name: "无需认证", exact: true }).click();
  assert.match(await providerStatus.innerText(), /可用/);
  await saveProvider();
  const noAuth = await call("providers", { operation: "list" });
  assert.equal(noAuth.credentialStates.arena, "notRequired");
  assert.equal(noAuth.credentialSources.arena, "none");
  assert.equal(noAuth.data.find(p => p.id === "arena").apiKeyEnv, undefined);
  assert.match(await providerStatus.innerText(), /可用/);

  const shared = JSON.parse(execFileSync(coreBinary, ["config", "models", "read"], { env: { ...env, HOME: userHome }, encoding: "utf8" }));
  assert.equal(shared.path, config);
  assert.equal(shared.credentialSources.arena, "none");
  assert.equal(shared.data.find(p => p.id === "arena").apiKeyEnv, undefined);
  assert.equal((await readFile(config, "utf8")).includes("fixture-key"), false);
  await page.getByRole("tablist", { name: "认证方式", exact: true }).getByRole("tab", { name: "API Key", exact: true }).click();
  await button("保存").click();
  await page.getByText("请填写 API Key，或保留已配置的凭据环境变量。", { exact: true }).waitFor();
  assert.equal((await call("providers", { operation: "list" })).revision, noAuth.revision, "an empty API Key mode must fail without modifying shared no-auth configuration");
  await page.getByRole("tablist", { name: "认证方式", exact: true }).getByRole("tab", { name: "无需认证", exact: true }).click();
  await page.screenshot({ path: join(scratch, "no-auth-pending.png"), animations: "disabled" });


  await button("返回应用").click();
  await button("模型").click(); await button("选择模型").click();
  await page.getByRole("radio", { name: "theta-model", exact: true }).click();
  await page.keyboard.press("Escape");
  await until(s => fixtureProject(s).configurations[Object.keys(fixtureProject(s).state.threads)[0]]?.model?.providerId === "theta", "Core accepts temporary model reselection");
  await button("模型").click(); await button("选择模型").click();
  await page.getByRole("radio", { name: "arena-model", exact: true }).click();
  await page.keyboard.press("Escape");
  await until(s => fixtureProject(s).configurations[Object.keys(fixtureProject(s).state.threads)[0]]?.model?.providerId === "arena", "Core accepts no-auth model selection");
  await page.getByTestId("chat-input").fill("Use the provider without authentication"); await button("发送").click();
  await until(s => Object.values(fixtureProject(s).state.threads).some(t => t.turns?.length === 3 && t.turns.at(-1).status === "completed"), "no-auth turn completes");
  assert.deepEqual(requests.at(-1), { model: "arena-model", authenticated: false, authorizationPresent: false });
  await page.screenshot({ path: join(scratch, "no-auth-composer.png"), animations: "disabled" });
  checks.push("one no-auth save removes the Core credential reference; explicit Composer reselection executes without Authorization");
  await openModelSettings();
  await page.locator(".provider-catalog-row").filter({ hasText: /^env/ }).click();
  assert.match(await providerStatus.innerText(), /已停用/);
  await page.getByRole("textbox", { name: "API Key", exact: true }).fill("");
  await page.getByRole("switch", { name: "启用供应商", exact: true }).click();
  await saveProvider();
  await until(s => fixtureProject(s).models.length === 3, "environment model available after apply");
  assert.equal((await call("providers", { operation: "list" })).credentialSources.env, "environment", "an empty API Key input preserves the configured environment reference");
  await page.screenshot({ path: join(scratch, "environment-credential.png"), animations: "disabled" });
  await button("返回应用").click();
  await button("模型").click(); await button("选择模型").click();
  await page.getByRole("radio", { name: "env-model", exact: true }).click();
  await page.keyboard.press("Escape");
  await until(s => fixtureProject(s).configurations[Object.keys(fixtureProject(s).state.threads)[0]]?.model?.providerId === "env", "Core accepts environment model selection");
  await page.getByTestId("chat-input").fill("Use an environment credential"); await button("发送").click();
  await until(s => Object.values(fixtureProject(s).state.threads).some(t => t.turns?.length === 4 && t.turns.at(-1).status === "completed"), "environment turn completes");
  assert.deepEqual(requests.at(-1), { model: "env-model", authenticated: true, authorizationPresent: true });
  checks.push("Core distinguishes environment credentials, securely stored credentials, and no authentication; Composer executes each applied mode");
  await openModelSettings();
  await page.locator(".provider-catalog-row").filter({ hasText: /^env/ }).click();
  await page.getByRole("switch", { name: "启用供应商", exact: true }).click();
  await saveProvider();
  await until(s => fixtureProject(s).models.length === 2, "environment provider disabled again");
  await page.locator(".provider-catalog-row").filter({ hasText: "arena" }).click();
  await page.getByRole("switch", { name: "启用供应商", exact: true }).click();
  assert.match(await providerStatus.innerText(), /可用/, "unsaved toggles cannot change saved status");
  await saveProvider();
  assert.match(await providerStatus.innerText(), /已停用/);


  await until(s => fixtureProject(s).models.length === 1, "disabled provider absent from executable Core catalog");
  await page.screenshot({ path: join(scratch, "disabled-provider.png"), animations: "disabled" });
  await button("返回应用").click();
  const disabledHistory = fixtureProject(await state()).configurations;
  await button("模型").click();
  assert.equal(await page.getByRole("radio", { name: /arena-model|env-model/ }).count(), 0, "disabled providers and historical placeholders stay hidden");
  assert.equal(await page.getByRole("radio", { name: "theta-model", exact: true }).isEnabled(), true);
  await page.keyboard.press("Escape");
  assert.deepEqual(fixtureProject(await state()).configurations, disabledHistory, "browsing available models preserves the disabled historical selection");
  assert.match(await button("模型").innerText(), /env-model/);
  await openModelSettings();
  await page.locator(".provider-catalog-row").filter({ hasText: "theta" }).click();
  await page.getByRole("switch", { name: "启用模型 theta-model", exact: true }).click();
  await saveProvider();
  assert.equal(await page.getByRole("switch", { name: "启用模型 theta-model", exact: true }).isChecked(), false);

  await until(s => fixtureProject(s).models.length === 0, "disabled model absent from executable Core catalog");
  await button("返回应用").click();
  assert.equal(await button("模型").count(), 0, "disabled models and historical entries do not open an empty picker");
  await assertEmptyModelIndicator();
  assert.match(await page.getByText("暂无可用模型", { exact: true }).getAttribute("title"), /env-model/, "disabled historical identity remains available");
  await openModelSettings();
  checks.push("Core credential states and saved enablement remain separate from drafts and pending apply; Composer explicitly selects and executes another available model");
  let providers = await call("providers", { operation: "list" });
  for (const provider of [...providers.data]) {
    await page.waitForFunction(async () => {
      const reply = await window.arealDesktop.command("serviceStatus", {});
      return reply.ok && !reply.value.busy && !reply.value.activeCommands && !reply.value.starting && !reply.value.providerUpdating;
    });
    providers = await call("providers", { operation: "removeAndApply", id: provider.id, expectedRevision: providers.revision });
  }
  await button("返回应用").click();
  await createProjectConversation(page, "workspace");
  await until(s => fixtureProject(s).models.length === 0, "empty Core catalog");
  const fallbackNotice = page.getByRole("status").filter({ hasText: "上次使用的模型" });
  await fallbackNotice.waitFor();
  assert.doesNotMatch(await fallbackNotice.innerText(), /已显示备用默认模型/);
  assert.equal(await button("发送").isDisabled(), true);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setMinimumSize(640, 620));
  for (const theme of ["dark", "light"]) {
    await openModelSettings();
    await button("外观").click();
    await page.getByRole("combobox", { name: "界面主题", exact: true }).click();
    await page.getByRole("option", { name: theme === "dark" ? "深色" : "浅色", exact: true }).click();
    await page.waitForFunction(theme => document.documentElement.classList.contains(`theme-areal-${theme}`), theme);
    await button("返回应用").click();
    for (const width of [1440, 980, 640]) {
      if (width === 640 && await button("收起侧栏").count()) await button("收起侧栏").click();
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 960), width);
      await page.waitForFunction(width => innerWidth === width, width);
      await page.waitForFunction(() => {
        const bar = document.querySelector(".composer-project-bar")?.getBoundingClientRect();
        const surface = document.querySelector(".draft-composer .composer-surface")?.getBoundingClientRect();
        return bar && surface && surface.top <= bar.bottom + 1;
      });
      const rect = await fallbackNotice.boundingBox();
      assert.ok(rect && rect.x >= 0 && rect.width > 0 && rect.x + rect.width <= width);
      await assertEmptyModelIndicator();
      await page.screenshot({ path: join(scratch, `fallback-notice-${theme}-${width}.png`), animations: "disabled" });
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
    if (await button("展开侧栏").count()) await button("展开侧栏").click();
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setMinimumSize(980, 620));
  checks.push("Empty model guidance stays on one line within the toolbar in dark/light themes at 1440, 980 and 640 pixels; the project bar stays attached to the composer");
  assert.equal(await button("模型").count(), 0, "empty catalog has no clickable model configuration control");
  await assertEmptyModelIndicator();
  await assertComposerActions();
  await openModelSettings();
  checks.push("empty catalog provides neutral guidance and Settings > Models remains accessible");
  await verifyModelCapabilities();
  await verifyModelDefaults(projectId);
  assert.deepEqual(errors, []); passed = true;
} catch (error) {
  failure = error.stack ?? String(error);
  if (page) await captureSmokeFailure(page, scratch, error);
  throw error;
} finally {
  releaseHeldReply?.();
  const cleanupFailure = (operation, error) => {
    errors.push(`cleanup ${operation}: ${error.message}`); passed = false; process.exitCode = 1;
  };
  if (app) {
    await app.evaluate(() => {
      globalThis.modelApplyReceipt?.release(); globalThis.modelApplyReceipt?.restore();
    }).catch(error => cleanupFailure("release receipt", error));
    // 失败时保留原始断言；销毁本次测试窗口避免未保存设置的 beforeunload 阻塞清理。
    if (!passed) await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.destroy();
    }).catch(error => cleanupFailure("destroy failed window", error));
    // 先断开 GUI，避免设置页的刷新请求与安全停止竞争。
    await closeGui().catch(error => cleanupFailure("close GUI", error));
    try {
      await stopService();
    } catch (error) { cleanupFailure("stop service", error); }
  }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  const files = ["scripts/model-selection-smoke.mjs", "renderer/src/settings/ModelSettings.tsx", "renderer/src/settings/UnsavedChanges.tsx", "renderer/src/settings/SettingsWorkspace.tsx", "renderer/src/i18n/IntlProvider.tsx", "app/src/core/model-config.cjs", "app/src/core/providers.cjs", "app/src/core/backend.cjs", "../../core/config/src/models.rs", "../../core/config/src/lib.rs", "../../core/local-service/src/spec.rs", "../../core/engine/src/desktop/server.rs", "../../core/engine/src/desktop/catalog.rs", "../../core/engine/src/desktop/state.rs", "../../core/engine/src/default_model.rs", "../../core/server/src/lib.rs", "../../core/server/src/reload.rs", "renderer/src/ComposerModelMenu.tsx", "renderer/src/Composer.tsx", "renderer/src/ConversationComposer.tsx", "renderer/src/DraftComposer.tsx", "renderer/src/ProjectlessDraft.tsx", "renderer/src/WorktreeStarter.tsx", "renderer/src/workbench.css"];
  files.push("../../core/engine/src/desktop/model_selection.rs", "../../core/engine/src/desktop/queue.rs", "../../core/protocol/src/desktop.rs", "renderer/src/settings/NewSessionModelSetting.tsx", "renderer/src/settings/ModelSettings.css", "renderer/src/settings/ModelEditor.tsx", "renderer/src/TaskDraft.tsx", "renderer/src/TaskCenter.tsx", "renderer/src/App.tsx");
  files.push("packages/workbench/client/model-selection.cjs", "packages/workbench/client/model-selection.js", "renderer/src/i18n/messages/common.ts");
  const hashes = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash("sha256").update(await readFile(join(gui, file))).digest("hex")])));
  const coreUnchanged = createHash("sha256").update(await readFile(coreBinary)).digest("hex") === coreSha256;
  await writeFile(join(scratch, "model-requests.json"), JSON.stringify(modelRequests, null, 2));
  await writeFile(join(scratch, "probe-requests.json"), JSON.stringify(probeRequests, null, 2));
  if (!coreUnchanged) { errors.push("Core binary changed during acceptance"); passed = false; process.exitCode = 1; }
  await writeFile(join(scratch, "manifest.json"), JSON.stringify({ passed, checks, errors, failure, stoppedServices, source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: gui, encoding: "utf8" }).trim(), hashes, core: { binary: coreBinary, sha256: coreSha256, unchanged: coreUnchanged }, executable: process.env.AREAL_GUI_EXECUTABLE || "source Electron", scope: "isolated Electron/Core model selection, defaults, and cold recovery; deterministic local authenticated fixture" }, null, 2));
  console.log(JSON.stringify({ passed, evidence: scratch, checks, errors }));
}
