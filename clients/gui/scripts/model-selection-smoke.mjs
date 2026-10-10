import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { captureSmokeFailure, createProjectConversation } from "./smoke-navigation.mjs";

// 模型可用性来自真实 Core；仅上游推理使用本地确定性服务。
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const scratch = await mkdtemp("/private/tmp/ams-");
const workspace = join(scratch, "workspace"), userHome = join(scratch, "user");
await mkdir(workspace); await mkdir(join(userHome, ".areal"), { recursive: true });
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
const requests = [];
const server = createServer(async (request, response) => {
  let body = ""; for await (const chunk of request) body += chunk;
  requests.push({ model: JSON.parse(body).model, authenticated: request.headers.authorization === "Bearer fixture-key", authorizationPresent: request.headers.authorization !== undefined });
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "MODEL_SELECTION_OK" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const config = join(userHome, ".areal", "config.toml");
await writeFile(config, `schema_version=1\n[model]\ncatalog_version=1\nprovider="areal_openai"\nname="unavailable-account-model"\n` + ["theta", "arena"].map(id => `\n[model.providers.${id}]\nname="${id}"\nendpoint="http://127.0.0.1:${server.address().port}/v1/chat/completions"\nprotocol="chat-completions"\napi_key_env="AREAL_CREDENTIAL_MISSING_${id}"\nmodels=[{id="${id}-model",enabled=true}]\n`).join(""));
await writeFile(config, (await readFile(config, "utf8")) + `\n[model.providers.env]\nname="env"\nenabled=false\nendpoint="http://127.0.0.1:${server.address().port}/v1/chat/completions"\nprotocol="chat-completions"\napi_key_env="AREAL_CREDENTIAL_fixture_env"\nmodels=[{id="env-model",enabled=true}]\n`);
const env = { ...process.env, AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_CORE_HOME: join(scratch, "core"), AREAL_CORE_USER_HOME: userHome,
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_CORE_BIN: process.env.AREAL_CORE_BIN || resolve(gui, "../../target/debug/areal") };
for (const key of ["AREAL_CORE_WORKSPACE", "AREAL_CORE_CONFIG", "AREAL_HARNESS_HOME", "AREAL_HARNESS_CONFIG", "AREAL_CORE_DESKTOP_CONFIG", "AREAL_CREDENTIAL_MISSING_theta", "AREAL_CREDENTIAL_MISSING_arena"]) delete env[key];
// 非法凭据也不能被 Core 启动时的引用注入误标为可用。
env.AREAL_CREDENTIAL_MISSING_arena = "   ";
env.AREAL_CREDENTIAL_fixture_env = "fixture-key";
if (process.env.AREAL_GUI_EXECUTABLE) delete env.AREAL_CORE_BIN;
const coreBinary = process.env.AREAL_GUI_EXECUTABLE
  ? join(process.env.AREAL_GUI_EXECUTABLE, "../../Resources/areal-core/bin/areal")
  : env.AREAL_CORE_BIN;
const coreSha256 = createHash("sha256").update(await readFile(coreBinary)).digest("hex");
let app, page, passed = false;
const checks = [], errors = [];
const button = name => page.getByRole("button", { name, exact: true });
async function saveProvider() {
  await button("保存供应商").click();
  // 等待已保存目录刷新和按钮恢复，避免读取“保存中…”的旧状态。
  await button("应用模型配置").click({ trial: true });
}
const state = () => page.evaluate(() => window.arealDesktop.snapshot());
async function call(name, params) {
  const result = await page.evaluate(({ name, params }) => window.arealDesktop.command(name, params), { name, params });
  assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
}
async function until(predicate, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { const snapshot = await state(); if (predicate(snapshot)) return snapshot; await new Promise(resolve => setTimeout(resolve, 80)); }
  throw new Error(`Timeout: ${label}`);
}
try {
  app = await electron.launch({ executablePath: process.env.AREAL_GUI_EXECUTABLE || require("electron"), args: process.env.AREAL_GUI_EXECUTABLE ? [] : [join(gui, "app")], env, timeout: 120000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on("pageerror", error => errors.push(error.message));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await until(s => s.connection?.state === "ready", "desktop ready");
  await app.evaluate(({ dialog, BrowserWindow }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    dialog.showMessageBox = async () => ({ response: 1 });
    BrowserWindow.getAllWindows()[0].setSize(1440, 960);
  }, workspace);
  await page.evaluate(() => window.arealDesktop.chooseProject());
  await createProjectConversation(page, "workspace");
  const ready = await until(s => s.projects[0]?.state?.connected && s.projects[0].models.length === 2, "unavailable Core catalog");
  const projectId = ready.projects[0].id;
  assert.ok(ready.projects[0].models.every(m => m.available === false && m.credentialState === "unavailable"));
  assert.equal(await button("模型").isEnabled(), true, "missing credentials must not disable the model configuration entry");
  await button("模型").click();
  for (const id of ["theta", "arena"]) {
    const option = page.getByRole("radio", { name: new RegExp(`${id}-model`) });
    await option.waitFor(); assert.equal(await option.isDisabled(), true);
    assert.match(await option.innerText(), /缺少 API Key/);
  }
  assert.equal(requests.length, 0, "unavailable entries cannot send a model request");
  await page.screenshot({ path: join(scratch, "unavailable-models.png"), animations: "disabled" });
  await button("配置模型").click();
  await page.getByRole("heading", { name: "模型设置", exact: true }).waitFor();
  checks.push("Core unavailable models remain visible with credential reasons and an active settings entry");
  await page.locator(".provider-catalog-row").filter({ hasText: "theta" }).click();
  const providerStatus = page.getByRole("status", { name: "供应商状态", exact: true });
  const applyStatus = page.getByRole("status", { name: "配置应用状态", exact: true });
  await providerStatus.waitFor();
  assert.match(await providerStatus.innerText(), /已启用.*缺少凭据/);
  assert.match(await providerStatus.innerText(), /环境变量凭据/);
  assert.match(await applyStatus.innerText(), /已应用/);
  assert.match(await page.getByRole("status", { name: "模型 theta-model 状态", exact: true }).innerText(), /已启用.*缺少凭据/);
  await page.getByRole("textbox", { name: "API Key", exact: true }).fill("fixture-key");
  assert.match(await providerStatus.innerText(), /缺少凭据/, "unsaved credentials cannot claim readiness");
  await saveProvider();
  await page.waitForFunction(() => document.querySelector('[aria-label="配置应用状态"]')?.textContent.includes("待应用"));
  const saved = await call("providers", { operation: "list" });
  assert.equal(saved.credentialStates.theta, "available", "credential state is supplied by Core config read");
  assert.equal(saved.credentialSources.theta, "stored", "Core classifies the adapter's secure-storage input");
  assert.equal(saved.pendingApply, true);
  assert.match(await providerStatus.innerText(), /凭据就绪/);
  assert.match(await providerStatus.innerText(), /已保存凭据/);
  assert.match(await applyStatus.innerText(), /待应用/);
  assert.match(await page.getByRole("status", { name: "模型 theta-model 状态", exact: true }).innerText(), /待应用/);
  assert.equal((await state()).projects[0].models.find(m => m.providerId === "theta").available, false, "saving does not silently apply credentials to a live project");
  await page.screenshot({ path: join(scratch, "pending-model-configuration.png"), animations: "disabled" });
  await button("应用模型配置").click();
  await until(s => s.projects[0].models.some(m => m.available === true), "credential applies to Core");
  await page.waitForFunction(() => document.querySelector('[aria-label="配置应用状态"]')?.textContent.includes("已应用"));
  assert.equal((await call("providers", { operation: "list" })).pendingApply, false);
  await button("返回应用").click();
  assert.match(await button("模型").innerText(), /theta-model/);
  await page.getByTestId("chat-input").fill("Use the configured model");
  await button("发送").click();
  await until(s => Object.values(s.projects[0].state.threads).some(t => t.turns?.at(-1)?.status === "completed"), "model turn completes");
  assert.deepEqual(requests, [{ model: "theta-model", authenticated: true, authorizationPresent: true }]);
  await button("模型").click(); await button("选择模型").click();
  assert.equal(await page.getByRole("radio", { name: /arena-model/ }).isDisabled(), true);
  await button("配置模型").click();
  await page.getByRole("heading", { name: "模型设置", exact: true }).waitFor();
  checks.push("settings credential save and safe apply restore draft and existing Composer selection; Core executes the selected model");
  // 启用开关、凭据与配置应用分别验收；两个可用模型之间必须能实际切换。
  await page.locator(".provider-catalog-row").filter({ hasText: "arena" }).click();
  await page.getByRole("textbox", { name: "API Key", exact: true }).fill("fixture-key");
  await saveProvider(); await button("应用模型配置").click();
  await until(s => s.projects[0].models.every(m => m.available === true), "both models available");
  await button("返回应用").click();
  await button("模型").click(); await button("选择模型").click();
  const arena = page.getByRole("radio", { name: "arena-model", exact: true });
  assert.equal(await arena.isEnabled(), true); await arena.click();
  await page.keyboard.press("Escape");
  await until(s => s.projects[0].configurations[Object.keys(s.projects[0].state.threads)[0]]?.model?.providerId === "arena", "Core accepts Composer model selection");
  await page.getByTestId("chat-input").fill("Use the other configured model"); await button("发送").click();
  await until(s => Object.values(s.projects[0].state.threads).some(t => t.turns?.length === 2 && t.turns.at(-1).status === "completed"), "selected model turn completes");
  assert.deepEqual(requests.at(-1), { model: "arena-model", authenticated: true, authorizationPresent: true });
  await button("模型").click(); await button("配置模型").click();
  await page.locator(".provider-catalog-row").filter({ hasText: "arena" }).click();
  // 无需认证是同一 Core 文件的编辑；不能继续发送已退役的保存凭据。
  await page.getByRole("combobox", { name: "认证方式", exact: true }).click();
  await page.getByRole("option", { name: "无需认证", exact: true }).click();
  assert.match(await providerStatus.innerText(), /已保存凭据/);
  await saveProvider();
  const noAuth = await call("providers", { operation: "list" });
  assert.equal(noAuth.credentialStates.arena, "notRequired");
  assert.equal(noAuth.credentialSources.arena, "none");
  assert.equal(noAuth.data.find(p => p.id === "arena").apiKeyEnv, undefined);
  assert.match(await providerStatus.innerText(), /无需认证/);
  assert.match(await applyStatus.innerText(), /待应用/);
  const shared = JSON.parse(execFileSync(coreBinary, ["config", "models", "read"], { env: { ...env, HOME: userHome }, encoding: "utf8" }));
  assert.equal(shared.path, config);
  assert.equal(shared.credentialSources.arena, "none");
  assert.equal(shared.data.find(p => p.id === "arena").apiKeyEnv, undefined);
  assert.equal((await readFile(config, "utf8")).includes("fixture-key"), false);
  await page.getByRole("combobox", { name: "认证方式", exact: true }).click();
  await page.getByRole("option", { name: "API Key", exact: true }).click();
  await button("保存供应商").click();
  await page.getByText("请填写 API Key，或保留已配置的凭据环境变量。", { exact: true }).waitFor();
  assert.equal((await call("providers", { operation: "list" })).revision, noAuth.revision, "an empty API Key mode must fail without modifying shared no-auth configuration");
  await page.getByRole("combobox", { name: "认证方式", exact: true }).click();
  await page.getByRole("option", { name: "无需认证", exact: true }).click();
  await page.screenshot({ path: join(scratch, "no-auth-pending.png"), animations: "disabled" });
  await button("应用模型配置").click();
  await page.waitForFunction(() => document.querySelector('[aria-label="配置应用状态"]')?.textContent.includes("已应用"));
  await button("返回应用").click();
  await button("模型").click(); await button("选择模型").click();
  await page.getByRole("radio", { name: "theta-model", exact: true }).click();
  await page.keyboard.press("Escape");
  await until(s => s.projects[0].configurations[Object.keys(s.projects[0].state.threads)[0]]?.model?.providerId === "theta", "Core accepts temporary model reselection");
  await button("模型").click(); await button("选择模型").click();
  await page.getByRole("radio", { name: "arena-model", exact: true }).click();
  await page.keyboard.press("Escape");
  await until(s => s.projects[0].configurations[Object.keys(s.projects[0].state.threads)[0]]?.model?.providerId === "arena", "Core accepts no-auth model selection");
  await page.getByTestId("chat-input").fill("Use the provider without authentication"); await button("发送").click();
  await until(s => Object.values(s.projects[0].state.threads).some(t => t.turns?.length === 3 && t.turns.at(-1).status === "completed"), "no-auth turn completes");
  assert.deepEqual(requests.at(-1), { model: "arena-model", authenticated: false, authorizationPresent: false });
  await page.screenshot({ path: join(scratch, "no-auth-composer.png"), animations: "disabled" });
  checks.push("GUI no-auth save removes the shared Core credential reference; application and Composer reselection execute without an Authorization header");
  await button("模型").click(); await button("配置模型").click();
  await page.locator(".provider-catalog-row").filter({ hasText: /^env/ }).click();
  assert.match(await providerStatus.innerText(), /环境变量凭据.*凭据就绪/);
  await page.getByRole("textbox", { name: "API Key", exact: true }).fill("");
  await page.getByRole("switch", { name: "启用供应商", exact: true }).click();
  await saveProvider(); await button("应用模型配置").click();
  await until(s => s.projects[0].models.length === 3, "environment model available after apply");
  assert.equal((await call("providers", { operation: "list" })).credentialSources.env, "environment", "an empty API Key input preserves the configured environment reference");
  await page.screenshot({ path: join(scratch, "environment-credential.png"), animations: "disabled" });
  await button("返回应用").click();
  await button("模型").click(); await button("选择模型").click();
  await page.getByRole("radio", { name: "env-model", exact: true }).click();
  await page.keyboard.press("Escape");
  await until(s => s.projects[0].configurations[Object.keys(s.projects[0].state.threads)[0]]?.model?.providerId === "env", "Core accepts environment model selection");
  await page.getByTestId("chat-input").fill("Use an environment credential"); await button("发送").click();
  await until(s => Object.values(s.projects[0].state.threads).some(t => t.turns?.length === 4 && t.turns.at(-1).status === "completed"), "environment turn completes");
  assert.deepEqual(requests.at(-1), { model: "env-model", authenticated: true, authorizationPresent: true });
  checks.push("Core distinguishes environment credentials, securely stored credentials, and no authentication; Composer executes each applied mode");
  await button("模型").click(); await button("配置模型").click();
  await page.locator(".provider-catalog-row").filter({ hasText: /^env/ }).click();
  await page.getByRole("switch", { name: "启用供应商", exact: true }).click();
  await saveProvider(); await button("应用模型配置").click();
  await until(s => s.projects[0].models.length === 2, "environment provider disabled again");
  await page.locator(".provider-catalog-row").filter({ hasText: "arena" }).click();
  await page.getByRole("switch", { name: "启用供应商", exact: true }).click();
  assert.match(await providerStatus.innerText(), /已启用/, "unsaved toggles cannot change saved status");
  await saveProvider();
  assert.match(await providerStatus.innerText(), /未启用/);
  assert.match(await applyStatus.innerText(), /待应用/);
  await button("应用模型配置").click();
  await until(s => s.projects[0].models.length === 1, "disabled provider absent from executable Core catalog");
  await page.screenshot({ path: join(scratch, "disabled-provider.png"), animations: "disabled" });
  await page.locator(".provider-catalog-row").filter({ hasText: "theta" }).click();
  await page.getByRole("switch", { name: "启用模型 theta-model", exact: true }).click();
  await saveProvider();
  assert.match(await page.getByRole("status", { name: "模型 theta-model 状态", exact: true }).innerText(), /未启用/);
  await button("应用模型配置").click();
  await until(s => s.projects[0].models.length === 0, "disabled model absent from executable Core catalog");
  checks.push("Core credential states and saved enablement remain separate from drafts and pending apply; Composer explicitly selects and executes another available model");
  // 空目录也必须提供可操作入口，不制造一个不可选的占位模型。
  let providers = await call("providers", { operation: "list" });
  for (const provider of [...providers.data]) providers = await call("providers", { operation: "remove", id: provider.id, expectedRevision: providers.revision });
  await call("providers", { operation: "apply", expectedRevision: providers.revision });
  await button("返回应用").click();
  await createProjectConversation(page, "workspace");
  await until(s => s.projects[0].models.length === 0, "empty Core catalog");
  assert.equal(await button("模型").isEnabled(), true);
  await button("模型").click();
  await page.getByRole("heading", { name: "模型设置", exact: true }).waitFor();
  checks.push("an empty model catalog opens model settings directly");
  assert.deepEqual(errors, []); passed = true;
} catch (error) {
  if (page) await captureSmokeFailure(page, scratch, error);
  throw error;
} finally {
  if (app) {
    // 先断开 GUI，避免设置页的刷新请求与安全停止竞争。
    await app.close();
    try {
      const { ServiceConnection } = require("../app/src/core/service-client.cjs");
      const connection = new ServiceConnection();
      try { const metadata = JSON.parse(await readFile(join(scratch, "core/service.json"), "utf8")); await connection.connect(metadata); await connection.request("stopService", { protocol: metadata.protocol }, true); }
      finally { connection.close(); }
    } catch (error) { errors.push(`cleanup: ${error.message}`); passed = false; process.exitCode = 1; }
  }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  const files = ["scripts/model-selection-smoke.mjs", "renderer/src/settings/ModelSettings.tsx", "renderer/src/i18n/IntlProvider.tsx", "app/src/core/model-config.cjs", "app/src/core/providers.cjs", "../../core/config/src/models.rs", "../../core/config/src/lib.rs", "../../core/server/src/lib.rs", "renderer/src/ComposerModelMenu.tsx", "renderer/src/Composer.tsx", "renderer/src/DraftComposer.tsx", "renderer/src/workbench.css"];
  const hashes = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash("sha256").update(await readFile(join(gui, file))).digest("hex")])));
  const coreUnchanged = createHash("sha256").update(await readFile(coreBinary)).digest("hex") === coreSha256;
  if (!coreUnchanged) { errors.push("Core binary changed during acceptance"); passed = false; process.exitCode = 1; }
  await writeFile(join(scratch, "manifest.json"), JSON.stringify({ passed, checks, errors, source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: gui, encoding: "utf8" }).trim(), hashes, core: { binary: coreBinary, sha256: coreSha256, unchanged: coreUnchanged }, executable: process.env.AREAL_GUI_EXECUTABLE || "source Electron", scope: "isolated Electron/Core model selection; deterministic local authenticated fixture" }, null, 2));
  console.log(JSON.stringify({ passed, evidence: scratch, checks, errors }));
}
