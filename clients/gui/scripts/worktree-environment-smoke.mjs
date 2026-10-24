import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertApplicationStopped, closeSmokeApplication } from "./application-cleanup.mjs";
import { captureSmokeFailure, createProjectConversation } from "./smoke-navigation.mjs";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const scratch = await mkdtemp("/private/tmp/areal-worktree-environment-");
const evidenceRoot = process.env.AREAL_WORKTREE_ENV_EVIDENCE || join(root, ".scratch/worktrees-20261024/electron");
await mkdir(evidenceRoot, { recursive: true });
const evidence = await mkdtemp(join(evidenceRoot, "run-"));
const workspace = join(scratch, "repo");
const userHome = join(scratch, "user/home");
await mkdir(workspace, { recursive: true });
await mkdir(join(userHome, ".areal"), { recursive: true });
const git = (...args) => execFileSync("git", args, { cwd: workspace, encoding: "utf8", timeout: 20000 }).trim();
git("init", "-b", "main");
await writeFile(join(workspace, "branch.txt"), "MAIN_BRANCH\n");
git("add", ".");
git("-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-m", "fixture main");
git("checkout", "-b", "release/acceptance");
await writeFile(join(workspace, "branch.txt"), "RELEASE_BRANCH\n");
git("add", ".");
git("-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-m", "fixture release");
git("checkout", "main");
let preparedWorktree;
const happyScript = 'printf started > "$AREAL_WORKTREE_PATH/setup-started.txt"\nwhile [ ! -f "$AREAL_WORKTREE_PATH/.acceptance-release" ]; do sleep 0.1; done\nprintf WORKTREE_SETUP_OK > "$AREAL_WORKTREE_PATH/setup.txt"';
const platformSetups = Object.fromEntries([["默认", "DEFAULT"], ["macOS", "MACOS"], ["Linux", "LINUX"]]
  .map(([platform, marker]) => [platform, `${happyScript}\nprintf ${marker} > "$AREAL_WORKTREE_PATH/platform.txt"`]));
const slowScript = 'printf "%s" "$$" > "$AREAL_WORKTREE_PATH/setup.pid"\nprintf started > "$AREAL_WORKTREE_PATH/slow-started.txt"\nwhile :; do sleep 1; done';
const checks = [], events = [], screenshots = [], requests = [], errors = [], stoppedServices = [], logWrites = [];
let app, page, failure, passed = false;
const record = (kind, details = {}) => events.push({ at: new Date().toISOString(), kind, ...details });
const worktrees = () => git("worktree", "list", "--porcelain").split("\n\n")
  .map(block => block.match(/^worktree (.+)$/m)?.[1]).filter(path => path && path !== workspace);
const textFile = path => readFile(path, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
const messageText = message => typeof message.content === "string" ? message.content : JSON.stringify(message.content);
const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "fixture" }] }));
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const messages = body.messages ?? [];
    const auxiliary = messages.some(message => message.role === "system" && /Generate a concise semantic session title|predict.*next.*prompt/i.test(messageText(message)));
    const prompt = messages.filter(message => message.role === "user").map(messageText).find(text => /WORKTREE_ACCEPTANCE_/.test(text));
    const toolResult = messages.findLast(message => message.role === "tool" && message.tool_call_id === "read-setup");
    if (prompt && !auxiliary) {
      const markers = await Promise.all(worktrees().map(async path => ({ path, setup: await textFile(join(path, "setup.txt")) })));
      requests.push({ at: new Date().toISOString(), prompt, model: body.model, markers, toolResult: toolResult ? messageText(toolResult) : null });
      record("model-request", { prompt, markers, toolResult: !!toolResult });
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (prompt?.includes("WORKTREE_ACCEPTANCE_HAPPY") && !auxiliary && !toolResult) {
      send({ tool_calls: [{ index: 0, id: "read-setup", type: "function", function: { name: "fs_read", arguments: JSON.stringify({ path: "setup.txt" }) } }] });
      send({}, "tool_calls");
    } else {
      send({ content: prompt && !auxiliary ? "WORKTREE_ACCEPTANCE_COMPLETE" : "Fixture" });
      send({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  } catch (error) {
    errors.push(`model fixture: ${error.stack ?? error}`);
    response.writeHead(500); response.end("fixture failed");
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
await writeFile(join(userHome, ".areal/config.toml"), `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[permissions]\nmode="ASK_PERMISSIONS"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${server.address().port}/v1/chat/completions"\n`);
const binary = process.env.AREAL_GUI_EXECUTABLE
  ? resolve(dirname(process.env.AREAL_GUI_EXECUTABLE), "../Resources/areal-core/bin/areal")
  : process.env.AREAL_CORE_BIN || join(root, "target/debug/areal");
const sha256 = data => createHash("sha256").update(data).digest("hex");
const binaryHash = sha256(await readFile(binary));
const sourceFiles = ["scripts/worktree-environment-smoke.mjs", "app/src/core/worktrees.cjs", "app/src/core/worktree-environment.cjs", "packages/workspace-git/worktrees.js", "renderer/src/WorktreeStarter.tsx", "renderer/src/WorktreeStatus.tsx", "renderer/src/DraftComposer.tsx", "renderer/src/TaskListItem.tsx", "renderer/src/settings/WorktreesSettings.tsx", "renderer/src/App.tsx", "renderer/src/i18n/messages/worktrees.ts", "renderer/src/Worktree.css", "renderer/src/settings/WorktreesSettings.css", "renderer/src/Messages.tsx"];
const hashSources = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, sha256(await readFile(join(gui, file)))])));
const source = {
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  status: execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" }),
  diffSha256: sha256(execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: root })),
  hashes: await hashSources(),
};
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
Object.assign(env, {
  AREAL_CORE_USER_HOME: userHome, AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_CORE_HOME: join(scratch, "core"), AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_CORE_BIN: binary,
});
if (process.env.AREAL_GUI_EXECUTABLE) delete env.AREAL_CORE_BIN;
env.NO_PROXY = env.no_proxy = [env.NO_PROXY, env.no_proxy, "127.0.0.1", "localhost"].filter(Boolean).join(",");
const button = name => page.getByRole("button", { name, exact: true });
const state = () => page.evaluate(() => window.arealDesktop.snapshot());
const project = snapshot => snapshot.projects.find(item => item.root === workspace);
async function until(predicate, label, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout waiting for ${label}`);
}
async function shot(name) {
  const path = join(evidence, `${name}.png`);
  await page.screenshot({ path, animations: "disabled", scale: "css" });
  screenshots.push({ name, path, sha256: sha256(await readFile(path)) });
}
async function openWorktreeSettings(tab = "环境") {
  await page.keyboard.press("Escape");
  await button("设置").click();
  await button("Worktrees").click();
  await page.getByRole("tab", { name: tab, exact: true }).click();
}
async function platform(name, script = "设置脚本") {
  await page.getByRole("tablist", { name: `${script}平台`, exact: true }).getByRole("tab", { name, exact: true }).click();
}
async function projectEnvironments() {
  const entry = button("配置环境 repo");
  if (await entry.isVisible()) await entry.click();
  await button("添加环境").waitFor();
}
const scriptInput = (label, platformName) => page.getByRole("tabpanel", { name: platformName, exact: true }).getByRole("textbox", { name: label, exact: true });
async function addEnvironment({ name, setup, cleanup = "", action, overrides }) {
  await projectEnvironments();
  await button("添加环境").click();
  await page.getByRole("textbox", { name: "环境名称", exact: true }).fill(name);
  await platform("默认");
  await scriptInput("设置脚本", "默认").fill(setup);
  await page.getByRole("textbox", { name: "清理脚本", exact: true }).fill(cleanup);
  if (action) {
    await button("添加操作").click();
    await page.getByRole("textbox", { name: "操作名称", exact: true }).fill(action.name);
    await page.getByRole("textbox", { name: `操作脚本 ${action.name}`, exact: true }).fill(action.script);
  }
  for (const [name, script] of Object.entries(overrides ?? {})) {
    await platform(name);
    await scriptInput("设置脚本", name).fill(script);
  }
  await platform("默认");
  await button("保存").click();
  await page.getByText("已保存", { exact: true }).waitFor();
  record("environment-saved", { name });
}
async function selectEnvironment(name) {
  await button("新会话工作区").click();
  const toggle = page.getByRole("switch", { name: "在新 Worktree 中工作", exact: true });
  await toggle.waitFor();
  await until(async () => !await toggle.isDisabled(), "worktree options loaded");
  if (await toggle.getAttribute("aria-checked") !== "true") await toggle.click();
  await button("起始分支").click();
  await page.getByRole("searchbox", { name: "搜索分支", exact: true }).fill("release/acceptance");
  await page.getByRole("option", { name: "release/acceptance", exact: true }).click();
  await page.getByLabel("项目环境", { exact: true }).click();
  await page.getByRole("option", { name, exact: true }).click();
  await shot(`picker-${name.toLowerCase()}`);
  await page.keyboard.press("Escape");
}
async function markerPath(filename) {
  return until(async () => {
    for (const directory of worktrees()) if (await textFile(join(directory, filename)) !== null) return directory;
    return null;
  }, filename);
}
async function draftText() {
  return page.getByTestId("chat-input").innerText();
}
async function sendDraft(text) {
  await page.getByTestId("chat-input").fill(text);
  await button("发送").click();
  record("send-clicked", { text });
}

console.log(`Worktree environment evidence ${evidence}`);
try {
  app = await electron.launch({ executablePath: process.env.AREAL_GUI_EXECUTABLE || require("electron"), args: process.env.AREAL_GUI_EXECUTABLE ? [] : [join(gui, "app")], env, timeout: 120000 });
  app.process().stdout?.on("data", data => { logWrites.push(writeFile(join(evidence, "electron.stdout.log"), data, { flag: "a" })); });
  app.process().stderr?.on("data", data => { logWrites.push(writeFile(join(evidence, "electron.stderr.log"), data, { flag: "a" })); });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on("pageerror", error => errors.push(error.stack ?? error.message));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await app.evaluate(({ dialog, BrowserWindow }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    BrowserWindow.getAllWindows()[0].setSize(1440, 960);
  }, workspace);
  await button("不在项目中工作").click();
  await page.getByRole("menuitem", { name: "新建项目", exact: true }).click();
  await until(async () => project(await state())?.state?.connected, "real Core project connection", 120000);
  await button("设置").click();
  await button("常规").click();
  const predictions = page.getByRole("switch", { name: "预测下一条提示词", exact: true });
  if (await predictions.getAttribute("aria-checked") === "true") await predictions.click();
  await button("Worktrees").click();
  await page.getByRole("tab", { name: "常规", exact: true }).click();
  await shot("general-light");
  await button("外观").click();
  await page.getByRole("combobox", { name: "界面主题", exact: true }).click();
  await page.getByRole("option", { name: "深色", exact: true }).click();
  await button("Worktrees").click();
  await page.getByRole("tab", { name: "环境", exact: true }).click();
  await addEnvironment({ name: "Acceptance", setup: platformSetups["默认"], overrides: { macOS: platformSetups.macOS, Linux: platformSetups.Linux }, cleanup: 'printf cleanup > "$AREAL_WORKTREE_PATH/cleanup.txt"', action: { name: "Write acceptance marker", script: 'printf ACTION_OK > "$AREAL_WORKTREE_PATH/action.txt"' } });
  await shot("environment-saved");
  await page.reload();
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await openWorktreeSettings();
  await projectEnvironments();
  await button("编辑环境 Acceptance").click();
  assert.equal(await page.getByRole("textbox", { name: "环境名称", exact: true }).inputValue(), "Acceptance");
  await platform("默认");
  assert.equal(await scriptInput("设置脚本", "默认").inputValue(), platformSetups["默认"]);
  assert.match(await page.getByRole("textbox", { name: "清理脚本", exact: true }).inputValue(), /cleanup.txt/);
  await button("编辑操作 Write acceptance marker").click();
  assert.equal(await page.getByRole("textbox", { name: "操作名称", exact: true }).inputValue(), "Write acceptance marker");
  for (const name of ["macOS", "Linux"]) {
    await platform(name);
    assert.equal(await scriptInput("设置脚本", name).inputValue(), platformSetups[name]);
    assert.match(await scriptInput("清理脚本", "默认").inputValue(), /cleanup.txt/, "cleanup platform remains independent");
  }
  await platform("默认");
  await shot("environment-platforms-restored");
  await button("放弃").click();
  checks.push("Environment name, Default/macOS/Linux setup scripts, cleanup and custom action persist through a renderer reload using real settings IPC and disk persistence");
  await addEnvironment({ name: "Failure", setup: 'printf SETUP_FAILED >&2\nexit 17' });
  await addEnvironment({ name: "Slow", setup: slowScript });
  await addEnvironment({ name: "Original", setup: slowScript.replace("slow-started.txt", "original-started.txt") });
  await button("返回应用").click();
  await createProjectConversation(page, "repo");
  await selectEnvironment("Acceptance");
  assert.equal(worktrees().length, 0, "configuration creates no worktree before Send");
  await sendDraft("WORKTREE_ACCEPTANCE_HAPPY Read setup.txt and report its marker.");
  const happyPath = await markerPath("setup-started.txt");
  preparedWorktree = happyPath;
  await page.locator('[data-worktree-state="settingUp"]').waitFor();
  assert.equal(requests.length, 0, "first prompt is held while the real setup subprocess waits");
  assert.equal(await textFile(join(happyPath, "branch.txt")), "RELEASE_BRANCH\n", "selected branch provides the worktree contents");
  const preview = page.getByTestId("worktree-creation-progress");
  assert.equal(await preview.locator(".user-bubble").count(), 1);
  assert.equal((await page.getByTestId("chat-input").innerText()).trim(), "", "waiting composer does not duplicate submitted intent");
  await shot("setup-progress");
  await button("查看创建详情").click();
  await shot("setup-progress-details");
  await writeFile(join(happyPath, ".acceptance-release"), "release\n");
  record("setup-released", { happyPath });
  await page.getByText("WORKTREE_ACCEPTANCE_COMPLETE", { exact: true }).waitFor({ timeout: 120000 });
  assert.equal(await textFile(join(happyPath, "setup.txt")), "WORKTREE_SETUP_OK");
  assert.equal(await textFile(join(happyPath, "platform.txt")), process.platform === "darwin" ? "MACOS" : process.platform === "linux" ? "LINUX" : "DEFAULT", "runtime selects the host platform override");
  const happyRequests = requests.filter(request => request.prompt.includes("WORKTREE_ACCEPTANCE_HAPPY"));
  assert.ok(happyRequests.length >= 2, "real Core executes fs_read and returns its receipt to the local model");
  assert.ok(happyRequests.every(request => request.markers.some(marker => marker.path === happyPath && marker.setup === "WORKTREE_SETUP_OK")), "every model request occurs after setup writes the marker");
  assert.match(happyRequests.at(-1).toolResult, /WORKTREE_SETUP_OK/, "the model receives the actual setup file through Core's fs_read");
  await page.locator('[data-worktree-state="ready"]').waitFor();
  const threadId = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
  assert.ok(threadId);
  await page.getByTestId(`task-item-${threadId}`).getByTestId("task-worktree-badge").waitFor();
  const readyStatus = page.locator('[data-worktree-state="ready"]');
  const firstUser = page.locator(".messages .user-message").first();
  assert.ok(await firstUser.evaluate((element, status) => !!(element.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING), await readyStatus.elementHandle()), "creation fact follows the submitted user message");
  assert.equal(await readyStatus.locator("pre:visible").count(), 0, "ready logs stay collapsed");
  assert.equal(await page.getByTestId(`task-item-${threadId}`).getByTestId("task-worktree-badge").innerText(), "", "sidebar badge has no UUID branch line");
  await shot("ready-with-sidebar-badge");
  checks.push("Selected branch creates on first Send, real shell setup gates submission, Core reads the resulting marker and the ready conversation shows a GitFork sidebar badge");
  await page.getByRole("button", { name: /^Worktree 分支 / }).click();
  await button("Write acceptance marker").click();
  await until(async () => await textFile(join(happyPath, "action.txt")) === "ACTION_OK", "custom action subprocess file");
  await shot("ready-custom-action");
  checks.push("A ready-state custom action runs in the actual worktree and writes action.txt");
  await page.keyboard.press("Escape");
  const submittedBeforeFailure = requests.length;
  await createProjectConversation(page, "repo");
  await selectEnvironment("Failure");
  const failedDraft = "WORKTREE_ACCEPTANCE_FAILURE Keep this exact draft.";
  await sendDraft(failedDraft);
  await until(async () => project(await state())?.worktreeOperations?.some(operation => operation.state === "failed"), "failed setup receipt", 90000);
  await page.getByTestId("chat-view").getByTestId("feedback-notice").filter({ has: page.getByRole("alert") }).waitFor();
  assert.equal(await draftText(), failedDraft);
  assert.equal(requests.length, submittedBeforeFailure, "failed setup sends no prompt to the model");
  await shot("setup-failed-draft-preserved");
  checks.push("A real setup exit 17 exposes failure, preserves the typed draft and sends no model request");
  await createProjectConversation(page, "repo");
  await selectEnvironment("Slow");
  const cancelledDraft = "WORKTREE_ACCEPTANCE_CANCEL Keep this cancelled draft.";
  await sendDraft(cancelledDraft);
  const cancelledPath = await markerPath("slow-started.txt");
  await page.locator('[data-worktree-state="settingUp"]').waitFor();
  await button("取消创建").click();
  await page.locator('[data-worktree-state="cancelled"]').getByText("已取消创建，输入已保留", { exact: true }).waitFor({ timeout: 60000 });
  const setupPid = Number(await textFile(join(cancelledPath, "setup.pid")));
  assert.ok(Number.isSafeInteger(setupPid) && setupPid > 1, "the real setup shell recorded its PID");
  await until(() => {
    try { process.kill(setupPid, 0); return false; }
    catch (error) { if (error.code === "ESRCH") return true; throw error; }
  }, "cancelled setup subprocess exit");
  record("cancelled-setup-exited", { setupPid, cancelledPath });
  assert.equal(await draftText(), cancelledDraft);
  assert.equal(requests.length, submittedBeforeFailure, "cancellation of a running setup sends no prompt to the model");
  assert.equal(await textFile(join(cancelledPath, "setup.txt")), null);
  await shot("setup-cancelled-draft-preserved");
  checks.push("Cancel terminates a real waiting setup operation, exposes cancelled state, preserves the draft and sends no model request");
  await createProjectConversation(page, "repo");
  await selectEnvironment("Original");
  const sourceDraft = "WORKTREE_ACCEPTANCE_SOURCE Continue in the original checkout.";
  await sendDraft(sourceDraft);
  const retainedPath = await markerPath("original-started.txt");
  await page.locator('[data-worktree-state="settingUp"]').waitFor();
  await button("不使用 Worktree").click();
  await until(() => requests.some(request => request.prompt.includes("WORKTREE_ACCEPTANCE_SOURCE")), "explicit source prompt after cancellation", 90000);
  const sourceState = await until(async () => {
    const current = project(await state());
    return Object.values(current.state.threads).some(thread => thread.turns?.some(turn => JSON.stringify(turn).includes("WORKTREE_ACCEPTANCE_SOURCE"))) && current;
  }, "source thread projection");
  const sourceThread = Object.values(sourceState.state.threads).find(thread => thread.turns?.some(turn => JSON.stringify(turn).includes("WORKTREE_ACCEPTANCE_SOURCE")));
  assert.ok(sourceThread && !sourceThread.worktree, "explicit fallback binds the source checkout without a worktree badge");
  assert.equal(sourceThread.executionProjectId, sourceState.id);
  assert.ok(worktrees().includes(retainedPath), "the cancelled worktree remains available for inspection");
  assert.equal(requests.filter(request => request.prompt.includes("WORKTREE_ACCEPTANCE_SOURCE")).length, 1, "source fallback submits the prompt once");
  await shot("explicit-original-checkout");
  checks.push("Use original directory confirms cancellation before a fresh source request, sends the draft once, and retains the cancelled worktree");
  await openWorktreeSettings("常规");
  const cancelledBranch = git("-C", cancelledPath, "branch", "--show-current");
  const dirtyWorktree = page.locator(".worktrees-directory-item").filter({ has: button(`查看详情 ${cancelledBranch}`) });
  await dirtyWorktree.waitFor();
  page.once("dialog", dialog => dialog.accept());
  await dirtyWorktree.getByRole("button", { name: /^删除 / }).click();
  await dirtyWorktree.getByRole("alert").waitFor();
  assert.ok(worktrees().includes(cancelledPath), "deleting a dirty cancelled worktree is rejected and retains the Git worktree");
  assert.equal(await textFile(join(cancelledPath, "slow-started.txt")), "started");
  await shot("dirty-worktree-delete-rejected");
  checks.push("Deleting a dirty worktree through General settings is rejected and retains its directory and contents");
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  failure = error.stack ?? String(error);
  process.exitCode = 1;
  if (page) await captureSmokeFailure(page, evidence, error);
  console.error(failure);
} finally {
  if (preparedWorktree) await writeFile(join(preparedWorktree, ".acceptance-release"), "release for cleanup\n");
  const metadata = await readFile(join(scratch, "core/service.json"), "utf8").then(JSON.parse).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  try {
    if (app) {
      await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
      await closeSmokeApplication(app);
    }
    await assertApplicationStopped(binary, env, metadata);
    stoppedServices.push({ pid: metadata?.pid, stopped: true });
  } catch (error) {
    errors.push(`cleanup: ${error.stack ?? error}`); passed = false; process.exitCode = 1;
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  for (const result of await Promise.allSettled(logWrites)) {
    if (result.status === "rejected") { errors.push(`log capture: ${result.reason}`); passed = false; process.exitCode = 1; }
  }
  const binaryUnchanged = sha256(await readFile(binary)) === binaryHash;
  if (!binaryUnchanged) { errors.push("Core binary changed during acceptance"); passed = false; process.exitCode = 1; }
  await writeFile(join(evidence, "events.json"), JSON.stringify(events, null, 2));
  await writeFile(join(evidence, "model-requests.json"), JSON.stringify(requests, null, 2));
  await writeFile(join(evidence, "errors.json"), JSON.stringify({ failure, errors }, null, 2));
  const hashes = await hashSources();
  const sourceUnchanged = JSON.stringify(hashes) === JSON.stringify(source.hashes);
  if (!sourceUnchanged) { errors.push("Product source changed during acceptance"); passed = false; process.exitCode = 1; }
  await writeFile(join(evidence, "manifest.json"), JSON.stringify({
    passed, checks, failure, errors, scratch, workspace, userHome, evidence, source, hashes, sourceUnchanged,
    core: { binary, sha256: binaryHash, unchanged: binaryUnchanged },
    electron: process.env.AREAL_GUI_EXECUTABLE || require("electron"), screenshots, stoppedServices,
    scope: "Real isolated Electron, product settings IPC and persistence, Core, Git worktrees and shell subprocesses. The model endpoint, native directory picker and quit confirmation are fixtures.",
    unverified: ["Physical input", "Installed package", "Real model providers", "Windows and Linux execution", "Cleanup before successful deletion", "Automatic retention cleanup"],
  }, null, 2));
  const artifactNames = ["manifest.json", "events.json", "model-requests.json", "errors.json", "electron.stdout.log", "electron.stderr.log", "failure-state.json", "failure-window.png", ...screenshots.map(item => `${item.name}.png`)];
  const artifacts = Object.fromEntries((await Promise.all(artifactNames.map(async name => {
    try { return [name, sha256(await readFile(join(evidence, name)))]; }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }))).filter(Boolean));
  await writeFile(join(evidence, "artifacts.sha256.json"), JSON.stringify(artifacts, null, 2));
  console.log(JSON.stringify({ passed, evidence, checks, errors }));
}
