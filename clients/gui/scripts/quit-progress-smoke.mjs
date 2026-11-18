import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applicationFixture } from "./application-fixture.mjs";
import { assertApplicationStopped } from "./application-cleanup.mjs";
import { respondToSessionName } from "./model-fixture.mjs";
import { captureSmokeFailure } from "./smoke-navigation.mjs";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const binary = process.env.AREAL_CORE_BIN;
assert.ok(
  binary?.startsWith(join(root, ".local/dev-bin/")),
  "Use an existing private fixed Core build",
);
const scratch = await makeTempDir("areal-quit-progress-");
const workspace = join(scratch, "workspace");
await mkdir(workspace);
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
Object.assign(env, {
  AREAL_CORE_BIN: binary,
  AREAL_CORE_CONFIG: join(scratch, "config.toml"),
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: join(scratch, "user"),
  AREAL_HARNESS_HOME: join(scratch, "harness"),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  NO_PROXY: [env.NO_PROXY, "127.0.0.1,localhost,::1"].filter(Boolean).join(","),
  no_proxy: [env.no_proxy, "127.0.0.1,localhost,::1"].filter(Boolean).join(","),
});
const requests = [],
  held = new Set(),
  errors = [],
  checks = [];
const server = createServer(async (request, response) => {
  try {
    if (request.url === "/quit-preview") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<h1>QUIT_PREVIEW_PAGE</h1>");
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    if (respondToSessionName(body, response)) return;
    requests.push(body);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "QUIT_PROGRESS_STREAMING" }, finish_reason: null }] })}\n\n`,
    );
    held.add(response);
    response.on("close", () => held.delete(response));
  } catch (error) {
    errors.push(error.stack);
    response.destroy();
  }
});
const eventsPath = join(scratch, "events.jsonl");
const stopGate = join(scratch, "stop.gate");
const finishGate = join(scratch, "finish.gate");
const failStop = join(scratch, "fail-stop");
const bootstrap = `
const { SharedCoreBackend } = require(${JSON.stringify(join(gui, "app/src/core/service-client.cjs"))});
const { appendFileSync, existsSync } = require('node:fs');
const record = value => appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({ time: Date.now(), ...value }) + '\\n');
globalThis.quitFixtureResponse = 0;
globalThis.quitFixtureHold = true;
require('electron').dialog.showMessageBox = async (...args) => {
  if (args.at(-1).title === '允许本地开发站点') return { response: 1 };
  record({ event: 'native-confirmation', message: args.at(-1).message, response: globalThis.quitFixtureResponse });
  while (globalThis.quitFixtureHold) await new Promise(resolve => setTimeout(resolve, 20));
  record({ event: 'native-decision', response: globalThis.quitFixtureResponse });
  return { response: globalThis.quitFixtureResponse };
};
const stop = SharedCoreBackend.prototype.requestHostStop;
SharedCoreBackend.prototype.requestHostStop = async function(...args) {
  record({ event: 'stop-held' });
  const deadline = Date.now() + 120000;
  while (existsSync(${JSON.stringify(stopGate)})) {
    if (Date.now() > deadline) throw new Error('Fixture stop gate was not released');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (existsSync(${JSON.stringify(failStop)})) {
    record({ event: 'stop-failed' });
    throw new Error('QUIT_PROGRESS_KNOWN_FAILURE');
  }
  record({ event: 'stop-original' });
  return stop.apply(this, args);
};
const prepare = SharedCoreBackend.prototype.prepareQuit;
SharedCoreBackend.prototype.prepareQuit = async function(...args) {
  record({ event: 'finish-held' });
  const deadline = Date.now() + 120000;
  while (existsSync(${JSON.stringify(finishGate)})) {
    if (Date.now() > deadline) throw new Error('Fixture finishing gate was not released');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return prepare.apply(this, args);
};
`;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const sourceFiles = [
  "app/src/core/main.cjs",
  "app/src/core/startup-recovery.cjs",
  "app/src/core/preload.cjs",
  "renderer/src/App.tsx",
  "renderer/src/services.ts",
  "scripts/quit-progress-smoke.mjs",
  "renderer/dist/index.html",
];
const sourceHashes = Object.fromEntries(
  await Promise.all(sourceFiles.map(async (file) => [file, sha(await readFile(join(gui, file)))])),
);
const coreHashes = Object.fromEntries(
  await Promise.all(
    ["areal", "areal-runtime", "areal-runtime-fs"].map(async (name) => [
      name,
      sha(await readFile(join(dirname(binary), name))),
    ]),
  ),
);
const source = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const diffSha256 = sha(execFileSync("git", ["diff", "HEAD"], { cwd: root }));
let nativeId;
const nativeViews = () =>
  app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].contentView.children.map((view) => ({
      id: view.webContents?.id,
      visible: view.getVisible(),
      focused: view.webContents?.isFocused(),
    })),
  );
let application,
  app,
  page,
  child,
  metadata,
  passed = false,
  failure,
  cleanup;
const until = async (read, label, timeout = 60000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timeout: ${label}`);
};
const events = async () =>
  (
    await readFile(eventsPath, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    })
  )
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
const count = async (event) => (await events()).filter((item) => item.event === event).length;
const snapshot = () => page.evaluate(() => window.arealDesktop.snapshot());
const project = (value) => value.projects.find((item) => item.root === workspace);
const thread = (value) =>
  project(value)?.state?.threads[
    value.activeThreadId ?? Object.keys(project(value)?.state?.threads ?? {})[0]
  ];
const command = async (name, params) => {
  const result = await page.evaluate(
    ({ name, params }) => window.arealDesktop.command(name, params),
    { name, params },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};
const quit = () =>
  app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu().items[0].submenu.items.find(
      (item) => item.accelerator === "CmdOrCtrl+Q",
    );
    if (!item) throw new Error("Missing application quit menu");
    item.click();
  });
const progress = (locale) =>
  page.getByRole("dialog", {
    name: locale === "en" ? "Quitting AReaL Harness" : "正在退出 AReaL Harness",
    exact: true,
  });
const assertProgress = async (locale, capture) => {
  const dialog = progress(locale);
  await until(() => dialog.isVisible(), "Approved quit displays a visible progress dialog", 10000);
  assert.equal(child.exitCode, null, "Progress is observed while the application remains alive");
  if (nativeId) {
    const view = (await nativeViews()).find((view) => view.id === nativeId);
    if (view || !capture.includes("finishing"))
      assert.equal(view?.visible, false, "Existing native preview cannot cover quit progress");
    if (view)
      assert.equal(view.focused, false, "Hidden native preview does not retain keyboard focus");
  }
  const animation = await dialog.evaluate((element) => {
    const animations = element
      .getAnimations({ subtree: true })
      .filter((animation) => animation.playState === "running");
    return animations.map((animation) => ({
      name: animation.animationName,
      duration: animation.effect?.getTiming().duration,
    }));
  });
  assert.ok(
    animation.some((item) => Number(item.duration) > 0),
    "Quit progress has a running spinner animation",
  );
  await page.keyboard.press("Escape");
  assert.equal(await dialog.isVisible(), true, "Escape cannot dismiss approved quit progress");
  await page.mouse.click(4, 4);
  assert.equal(await dialog.isVisible(), true, "Backdrop cannot dismiss approved quit progress");
  await page.screenshot({ path: join(scratch, capture) });
  await writeFile(
    join(scratch, capture.replace(".png", ".json")),
    JSON.stringify(
      { animation, nativeViews: await nativeViews(), body: await page.locator("body").innerText() },
      null,
      2,
    ),
  );
};
console.log("Quit progress evidence:", scratch);
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await writeFile(
    env.AREAL_CORE_CONFIG,
    `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${server.address().port}/v1/chat/completions"\n`,
  );
  application = await applicationFixture(gui, join(scratch, "app"), bootstrap);
  app = await electron.launch({
    executablePath: require("electron"),
    args: [application.path],
    env,
    timeout: 120000,
  });
  child = app.process();
  child.stderr.on("data", (chunk) => {
    void writeFile(join(scratch, "electron.log"), chunk, { flag: "a" });
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => errors.push(error.stack));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await until(async () => (await snapshot()).connection?.state === "ready", "Desktop ready");
  metadata = JSON.parse(await readFile(join(env.AREAL_CORE_HOME, "service.json"), "utf8"));
  await quit();
  await until(
    async () => (await count("native-confirmation")) === 1,
    "Idle quit asks for confirmation",
  );
  assert.equal(
    await progress("zh-CN").isVisible(),
    false,
    "Idle quit progress waits for confirmation",
  );
  assert.equal(await count("stop-held"), 0, "Idle quit does not stop before confirmation");
  await quit();
  assert.equal(
    await count("native-confirmation"),
    1,
    "Repeated idle quit shares the pending confirmation",
  );
  await app.evaluate(() => {
    globalThis.quitFixtureHold = false;
  });
  await until(
    async () => (await count("native-decision")) === 1,
    "Idle cancellation decision returns",
  );
  await until(
    async () => (await command("providers", { operation: "list" })).data,
    "Idle quit cancellation keeps IPC usable",
  );
  assert.equal(child.exitCode, null, "Canceling idle quit keeps the application alive");
  checks.push(
    "Idle quit asks once before progress or shutdown; cancellation keeps the application usable",
  );
  await app.evaluate(({ dialog }, workspace) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
  }, workspace);
  await page.getByRole("button", { name: "不在项目中工作", exact: true }).click();
  await page.getByRole("menuitem", { name: "新建项目", exact: true }).click();
  await until(async () => project(await snapshot())?.state?.connected, "Project ready");
  await page.getByTestId("chat-input").fill("Keep streaming until I pause.");
  await page.getByTestId("chat-send-button").click();
  await until(
    async () =>
      thread(await snapshot())
        ?.turns.at(-1)
        ?.items.some(
          (item) => item.type === "agentMessage" && item.text?.includes("QUIT_PROGRESS_STREAMING"),
        ),
    "Streaming reply",
  );
  await page.bringToFront();
  await page.getByRole("button", { name: "暂停执行", exact: true }).click();
  await until(
    async () => thread(await snapshot())?.turns.at(-1)?.status === "interrupted",
    "Core turn interrupted",
  );
  await until(() => held.size === 0, "Provider stream closes after pause");
  await page.getByText("执行已暂停", { exact: true }).waitFor();
  const projectId = project(await snapshot()).id;
  await command("manage", {
    projectId,
    operation: "taskCreate",
    mode: "scheduled",
    objective: "QUIT_PROGRESS_FUTURE_TASK",
    schedule: { at: Math.floor(Date.now() / 1000) + 86400, timeZone: "Asia/Shanghai" },
  });
  await writeFile(join(scratch, "after-pause.json"), JSON.stringify(await snapshot(), null, 2));
  const threadId = thread(await snapshot()).id;
  const previewUrl = `http://127.0.0.1:${server.address().port}/quit-preview`;
  await page.evaluate((request) => window.arealDesktop.preview(request), {
    operation: "show",
    projectId,
    threadId,
    url: previewUrl,
    visible: true,
    bounds: { x: 700, y: 400, width: 300, height: 200 },
  });
  nativeId = await until(
    async () =>
      app.evaluate(
        ({ BrowserWindow }, url) =>
          BrowserWindow.getAllWindows()[0].contentView.children.find(
            (view) => view.webContents?.getURL() === url && view.getVisible(),
          )?.webContents.id,
        previewUrl,
      ),
    "Native preview visible before quit",
  );

  await app.evaluate(() => {
    globalThis.quitFixtureHold = true;
  });
  await quit();
  await until(
    async () => (await count("native-confirmation")) === 2,
    "Native quit confirmation is awaiting a decision",
  );
  await page.screenshot({ path: join(scratch, "quit-awaiting-confirmation.png") });
  assert.equal(
    await progress("zh-CN").isVisible(),
    false,
    "Quit progress stays hidden while confirmation is pending",
  );
  assert.equal(await count("stop-held"), 0, "Backend stop waits for confirmation");
  await app.evaluate(() => {
    globalThis.quitFixtureHold = false;
  });
  await until(
    async () => (await count("native-decision")) === 2,
    "Native quit confirmation canceled",
  );
  await until(
    async () => (await command("providers", { operation: "list" })).data,
    "IPC usable after native cancellation",
  );
  assert.equal(child.exitCode, null);
  await progress("zh-CN").waitFor({ state: "hidden" });
  assert.equal(
    (await nativeViews()).find((view) => view.id === nativeId)?.visible,
    true,
    "Canceled quit restores the same native page",
  );
  await page.getByTestId("chat-input").fill("Editing still works after cancel");
  assert.match(
    await page.getByTestId("chat-input").innerText(),
    /Editing still works after cancel/,
  );
  await page.getByTestId("chat-input").fill("");
  checks.push(
    "UI send and pause close the real model stream; native cancellation leaves editing and Core IPC usable",
  );

  await app.evaluate(({ webContents }, id) => webContents.fromId(id).focus(), nativeId);
  await writeFile(stopGate, "held");
  await writeFile(failStop, "known failure before original stop");
  await app.evaluate(() => {
    globalThis.quitFixtureResponse = 1;
    globalThis.quitFixtureHold = true;
  });
  await quit();
  await until(
    async () => (await count("native-confirmation")) === 3,
    "Quit confirmation awaits approval",
  );
  assert.equal(
    await progress("zh-CN").isVisible(),
    false,
    "Quit progress remains hidden before approval",
  );
  assert.equal(await count("stop-held"), 0, "Shutdown remains pending before approval");
  await app.evaluate(() => {
    globalThis.quitFixtureHold = false;
  });
  await until(
    async () => (await count("stop-held")) === 1,
    "Confirmed quit reaches controlled stop boundary",
  );
  await assertProgress("zh-CN", "quit-progress-zh.png");
  await rm(stopGate);
  await until(async () => (await count("stop-failed")) === 1, "Known failure released");
  await progress("zh-CN").waitFor({ state: "hidden" });
  await until(
    async () => (await command("providers", { operation: "list" })).data,
    "IPC usable after known quit failure",
  );
  assert.equal(child.exitCode, null, "Known pre-stop failure leaves the application alive");
  assert.equal(
    (await nativeViews()).find((view) => view.id === nativeId)?.visible,
    true,
    "Failed quit restores the same native page",
  );
  checks.push(
    "Approved Chinese progress animates and cannot dismiss; known stop failure clears it and restores Core IPC",
  );

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "常规", exact: true }).click();
  await page
    .getByRole("tablist", { name: "语言", exact: true })
    .getByRole("tab", { name: "English", exact: true })
    .click();
  await page.getByRole("tablist", { name: "Language", exact: true }).waitFor();
  await rm(failStop);
  await writeFile(stopGate, "held");
  await writeFile(finishGate, "held");
  await quit();
  await until(
    async () => (await count("stop-held")) === 2,
    "Retry reaches controlled stop boundary",
  );
  await assertProgress("en", "quit-progress-en.png");
  const confirmations = await count("native-confirmation");
  await quit();
  await quit();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert.equal(
    await count("native-confirmation"),
    confirmations,
    "Repeated quit shares its original confirmation",
  );
  assert.equal(await count("stop-held"), 2, "Repeated quit shares the original stop attempt");
  assert.equal(
    page.isClosed(),
    false,
    "Closing the main window during approved quit preserves visible progress",
  );
  await assertProgress("en", "quit-progress-repeated.png");
  await rm(stopGate);
  await until(
    async () => (await count("finish-held")) === 1,
    "Real backend stop reaches final application cleanup",
  );
  await assertProgress("en", "quit-progress-finishing.png");
  await rm(finishGate);
  await until(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    if (!page.isClosed()) {
      try {
        assert.equal(
          await progress("en").isVisible(),
          true,
          "Progress remains visible until the application window closes",
        );
      } catch (error) {
        if (!page.isClosed()) throw error;
      }
    }
    return false;
  }, "GUI exits after the real stop boundary is released");
  assert.equal(child.exitCode, 0, "Approved quit exits successfully");
  assert.equal(child.signalCode, null, "Approved quit is not terminated by a signal");
  app = null;
  assert.equal(
    await count("stop-original"),
    1,
    "Successful retry performs real Core shutdown once",
  );
  assert.equal(requests.length, 1, "Quit never replays the paused model request");
  assert.deepEqual(errors, [], "No renderer or model fixture errors");
  checks.push(
    "English progress survives repeated quit until process exit; the released original stop cleans up real Core",
  );
  passed = true;
} catch (error) {
  failure = error.stack;
  console.error(error.message);
  if (page && !page.isClosed()) await captureSmokeFailure(page, scratch, error);
} finally {
  await rm(stopGate, { force: true });
  await rm(finishGate, { force: true });
  await rm(failStop, { force: true });
  if (app) {
    await app
      .evaluate(() => {
        globalThis.quitFixtureResponse = 1;
        globalThis.quitFixtureHold = false;
      })
      .catch(() => {});
    await app.evaluate(({ app }) => app.quit()).catch(() => {});
    await until(
      () => child.exitCode !== null || child.signalCode !== null,
      "Owned GUI exits during cleanup",
    ).catch((error) => {
      errors.push(error.message);
    });
  }
  await application?.close();
  try {
    await assertApplicationStopped(binary, env, metadata);
    cleanup = "passed";
  } catch (error) {
    cleanup = error.stack;
    passed = false;
  }
  for (const response of held) response.destroy();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  for (const [name, hash] of Object.entries(coreHashes))
    assert.equal(
      sha(await readFile(join(dirname(binary), name))),
      hash,
      `Core stays unchanged: ${name}`,
    );
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed,
        source,
        diffSha256,
        sourceHashes,
        coreHashes,
        binary,
        checks,
        failure,
        cleanup,
        errors,
        gui: { pid: child?.pid, exitCode: child?.exitCode, signalCode: child?.signalCode },
        boundaries:
          "Isolated source Electron with real fixed Core and deterministic loopback SSE model. UI send and pause; real bridge creates a future scheduled task and visible native preview. Native WebContentsView identity/visibility observed through Main. Native folder picker and quit confirmation responses injected; confirmation is held to inspect the pre-approval UI. Stop gate delays before the original Host stop request, with one known pre-stop failure. Final gate delays real prepareQuit after backend stop. Application-menu quit callback and native window close callback, no physical Command+Q. No packaged app or real provider.",
      },
      null,
      2,
    ),
  );
  console.log("Quit progress result:", passed ? "PASS" : "FAIL", checks);
  if (!passed) process.exitCode = 1;
}
