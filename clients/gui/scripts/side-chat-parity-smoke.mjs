import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, writeFile, readdir, stat, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applicationFixture } from "./application-fixture.mjs";
import { closeSmokeApplication, assertApplicationStopped } from "./application-cleanup.mjs";
import { respondToSessionName } from "./model-fixture.mjs";
import {
  captureSmokeFailure,
  createProjectConversation,
  selectConversation,
} from "./smoke-navigation.mjs";
import { withSmokeDeadline } from "./smoke-deadline.mjs";

const runnerGui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(runnerGui, "../..");
const gui = process.env.AREAL_GUI_SOURCE_ROOT
  ? join(resolve(process.env.AREAL_GUI_SOURCE_ROOT), "clients/gui")
  : runnerGui;
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const WebSocket = require("ws");
const { CoreClient } = await import(pathToFileURL(join(gui, "packages/runtime-client/core.js")));
const { ServiceConnection, waitForServiceExit } = require(
  join(gui, "app/src/core/service-client.cjs"),
);
const binary =
  process.env.AREAL_CORE_BIN || join(root, ".local/dev-bin/side-chat-zcode-parity/areal");
assert.ok(isAbsolute(binary), "AREAL_CORE_BIN must be an absolute frozen executable path");
assert.equal(process.env.AREAL_GUI_EXECUTABLE, undefined, "Side parity requires source Electron");
const requested = process.argv.indexOf("--scenario");
const scenario = requested < 0 ? null : process.argv[requested + 1];
assert.ok(scenario === null || /^P[1-6]$/.test(scenario), "--scenario accepts P1 through P6");
const baseline = process.argv.includes("--baseline");
const sha = (value) => createHash("sha256").update(value).digest("hex");
async function artifactHashes() {
  const files = ["app/src/main.cjs", "renderer/dist/index.html"];
  for (const name of await readdir(join(gui, "renderer/dist/assets")))
    if (/\.(?:js|css)$/.test(name)) files.push(`renderer/dist/assets/${name}`);
  for (const name of await readdir(join(gui, "app/src/core"), { recursive: true }))
    if (name.endsWith(".cjs")) files.push(`app/src/core/${name}`);
  return Object.fromEntries(
    await Promise.all(
      files.sort().map(async (file) => [file, sha(await readFile(join(gui, file)))]),
    ),
  );
}
const artifactHashesAtStart = await artifactHashes();
const bundleFiles = [
  "areal",
  "areal-runtime",
  "areal-runtime-fs",
  "shells/bash",
  "shells/sh",
  "shells/build.json",
];
const bundleHashes = async () =>
  Object.fromEntries(
    await Promise.all(
      bundleFiles.map(async (name) => [name, sha(await readFile(join(dirname(binary), name)))]),
    ),
  );
const bundleHashesAtStart = await bundleHashes();
const evidenceRoot = join(root, ".scratch/side-chat-parity");
await mkdir(evidenceRoot, { recursive: true });
const evidence = await mkdtemp(join(evidenceRoot, baseline ? "baseline-" : "run-"));
const stateRoot = await makeTempDir("scp-");
const workspace = join(stateRoot, "w");
const userHome = join(stateRoot, "u");
await mkdir(workspace);
await mkdir(userHome);
await writeFile(join(workspace, "seed.txt"), "SIDE_PARITY_REAL_FILE\n");
await writeFile(join(workspace, "attachment.txt"), "SIDE_PARITY_ATTACHMENT_BYTES\n");
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
execFileSync("git", ["add", "."], { cwd: workspace });
execFileSync(
  "git",
  ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-m", "fixture"],
  { cwd: workspace, stdio: "ignore" },
);
const checks = [],
  requests = [],
  rows = [],
  errors = [],
  coreReads = [];
const streams = new Map();
const streamSteps = new Map();
let marker = join(workspace, "parent-tool.txt");
let release = join(workspace, "release-parent-tool");
const sourceText = "PARITY_SELECTION_🌊_汉字";
const longA = "A".repeat(8000),
  longB = "B".repeat(8000),
  longC = "C".repeat(8001);
const sourceReply = `${sourceText}\n\nSHARED_REFERENCE_TEXT\n\n\`\`\`text\nCODE_REFERENCE_TEXT\n\`\`\`\n\n${longA}\n\n${longB}\n\n${longC}\n\n${Array.from({ length: 9 }, (_, i) => `REFERENCE_${i}`).join("\n\n")}`;
const textOf = (content) =>
  typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("\n");
const chunk = (delta, finish_reason = null) =>
  `data: ${JSON.stringify({ id: "side-parity", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
const finish = (response, text) =>
  response.end(chunk({ content: text }) + chunk({}, "stop") + "data: [DONE]\n\n");
const tool = (response, name, args, prefix = "") =>
  response.end(
    (prefix ? chunk({ content: prefix }) : "") +
      chunk({
        tool_calls: [
          {
            index: 0,
            id: randomUUID(),
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      }) +
      chunk({}, "tool_calls") +
      "data: [DONE]\n\n",
  );
const model = createServer((request, response) => {
  void (async () => {
    let raw = "";
    for await (const part of request) raw += part;
    const body = JSON.parse(raw);
    if (respondToSessionName(body, response)) return;
    const userIndex = (body.messages ?? []).findLastIndex(
      (message) =>
        message.role === "user" &&
        !textOf(message.content).startsWith("AReaL runtime context (not a user request):"),
    );
    const user = textOf(body.messages?.[userIndex]?.content);
    const prompt = user.match(/PARITY:[A-Z0-9_]+/)?.[0] ?? user;
    const results = (body.messages ?? [])
      .slice(userIndex + 1)
      .filter((message) => message.role === "tool");
    requests.push({ sequence: requests.length + 1, prompt, body });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (/PARITY:STREAM_/.test(prompt)) {
      let sequence = 0;
      const emit = () =>
        response.write(chunk({ content: ` ${prompt.replace("PARITY:", "")}_${++sequence}` }));
      emit();
      // 引用题明确控制“先选取，再追加”；不要求键盘动作赶在下一次定时输出之前完成。
      const timer = prompt === "PARITY:STREAM_SELECTION" ? undefined : setInterval(emit, 120);
      streamSteps.set(prompt, emit);
      const settle = () => {
        clearInterval(timer);
        if (!response.destroyed) finish(response, " STREAM_SETTLED");
      };
      streams.set(prompt, settle);
      response.once("close", () => {
        clearInterval(timer);
        streams.delete(prompt);
        streamSteps.delete(prompt);
      });
      return;
    }
    if (["PARITY:P1_READ", "PARITY:P2_SEED"].includes(prompt) && !results.length)
      return tool(response, "fs_read", { path: "workspace://repo/seed.txt" });
    if (prompt === "PARITY:P1_WRITE" && !results.length)
      return tool(response, "fs_create", {
        path: "workspace://repo/approved.txt",
        text: "CHILD_APPROVED_BYTES\n",
      });
    if (prompt === "PARITY:P1_DENY" && !results.length)
      return tool(response, "fs_create", {
        path: "workspace://repo/denied.txt",
        text: "MUST_NOT_EXIST\n",
      });
    if (prompt === "PARITY:P2_ACTIVE" && !results.length)
      return tool(
        response,
        "run_command",
        {
          argv: [
            "/bin/sh",
            "-c",
            `printf 'executed\\n' >> '${marker}'; while [ ! -f '${release}' ]; do sleep 0.1; done; printf 'P2_TOOL_FINISHED'`,
          ],
          cwd: "workspace://repo",
          timeoutMs: 120000,
        },
        "P2_UNFINISHED_ASSISTANT",
      );
    if (prompt === "PARITY:P2_ACTIVE") return finish(response, "P2_LATE_SENTINEL");
    if (prompt === "PARITY:P2_SEED") return finish(response, "P2_STABLE_ASSISTANT_HISTORY");
    if (prompt === "PARITY:P4_SOURCE") return finish(response, sourceReply);
    if (prompt === "PARITY:P4_OTHER") return finish(response, "SHARED_REFERENCE_TEXT");
    const reply = prompt.startsWith("PARITY:") ? `DONE ${prompt}` : "DONE";
    if (body.stream === false)
      return response.end(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: reply } }] }),
      );
    finish(response, reply);
  })().catch((error) => {
    errors.push(`model fixture: ${error.stack}`);
    response.destroy(error);
  });
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const config = join(stateRoot, "config.toml");
await writeFile(
  config,
  `schema_version=1\n[model]\ncatalog_version=1\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\nmodels=[{id="fixture",enabled=true},{id="fixture-alternate",enabled=true}]\n[limits]\nmodel_concurrency=4\n`,
);
const deployment = join(stateRoot, "desktop.json");
await writeFile(
  deployment,
  JSON.stringify({
    profiles: [
      {
        id: "standard",
        revision: "v1",
        displayName: "标准",
        instructions: "Complete the fixture request.",
        allowThreadProcesses: true,
        approvalTools: ["fs_create"],
        skills: [],
      },
    ],
  }),
);
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
Object.assign(env, {
  AREAL_CORE_BIN: binary,
  AREAL_CORE_CONFIG: config,
  AREAL_CORE_DESKTOP_CONFIG: deployment,
  AREAL_CORE_HOME: join(stateRoot, "c"),
  AREAL_CORE_USER_HOME: userHome,
  AREAL_HARNESS_HOME: join(stateRoot, "r"),
  AREAL_HARNESS_SERVICE_HOME: join(stateRoot, "s"),
  AREAL_GUI_USER_DATA: join(stateRoot, "e"),
  NO_PROXY: "127.0.0.1,localhost,::1",
  no_proxy: "127.0.0.1,localhost,::1",
  LANG: "zh_CN.UTF-8",
});
const commandLog = join(evidence, "commands.jsonl");
const fixture = await applicationFixture(
  gui,
  join(stateRoot, "app"),
  `
const { appendFileSync } = require('node:fs');
const { SharedCoreBackend } = require(${JSON.stringify(join(gui, "app/src/core/service-client.cjs"))});
const closeWindow = SharedCoreBackend.prototype.closeWindowSideChats;
SharedCoreBackend.prototype.closeWindowSideChats = async function(...args) {
  appendFileSync(${JSON.stringify(commandLog)}, JSON.stringify({ observed: 'windowSideClose', stack: new Error().stack }) + '\\n');
  return closeWindow.apply(this, args);
};
require('electron').app.on('browser-window-created', (_event, window) => {
  for (const event of ['show', 'hide', 'close']) window.on(event, () => {
    appendFileSync(${JSON.stringify(commandLog)}, JSON.stringify({ observed: event, at: Date.now() }) + '\\n');
  });
});
const original = SharedCoreBackend.prototype.command;
SharedCoreBackend.prototype.command = async function(name, request) {
  try {
    if (name === 'side' && request.operation === 'create') appendFileSync(${JSON.stringify(commandLog)}, JSON.stringify({ observed: 'sideCreateGate', closed: this.guiWindowClosed, at: Date.now() }) + '\\n');
    const value = await original.call(this, name, request);
    appendFileSync(${JSON.stringify(commandLog)}, JSON.stringify({ name, request, ok: true }) + '\\n');
    return value;
  } catch (error) {
    appendFileSync(${JSON.stringify(commandLog)}, JSON.stringify({ name, request, error: error.message }) + '\\n');
    throw error;
  }
};
`,
);
const facts = {
  startedAt: new Date().toISOString(),
  baseline,
  stateRoot,
  workspace,
  evidence,
  runnerCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  sourceRoot: resolve(gui, "../.."),
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: resolve(gui, "../.."),
    encoding: "utf8",
  }).trim(),
  sourceDiffSha256: sha(execFileSync("git", ["diff", "HEAD"], { cwd: resolve(gui, "../..") })),
  runnerSha256: sha(await readFile(fileURLToPath(import.meta.url))),
  binary,
  binarySha256: sha(await readFile(binary)),
  boundaries: {
    real: [
      "source renderer",
      "preload",
      "Electron Main",
      "shared Core",
      "Rust Core",
      "Runtime",
      "filesystem",
      "approval",
    ],
    fixtures: [
      "deterministic loopback model",
      "public parent configure selects the approvalTools profile before child creation",
      "native project chooser returns isolated workspace",
      "HTML file input returns attachment fixture",
      "quit confirmation returns cancel-and-quit",
      "native browser Range with one real Shift extension",
      "pass-through command observation",
    ],
    excluded: [
      "real provider",
      "packaged application",
      "physical IME",
      "native OS file picker",
      "cross-platform visual parity",
    ],
  },
  artifactHashesAtStart,
  bundleHashesAtStart,
  launches: [],
  cleanup: [],
};
let app,
  page,
  projectId,
  passed = false;
const ctx = { app, page, env, binary, workspace, projectId, requests, checks, evidence };
const state = () => page.evaluate(() => window.arealDesktop.snapshot());
const project = (snapshot) =>
  snapshot.projects.find((item) => item.id === projectId || item.root === workspace);
const threads = (snapshot) => project(snapshot)?.state?.threads ?? {};
const currentId = () => page.getByTestId("areal-workbench").getAttribute("data-thread-id");
const mainComposer = () =>
  page
    .locator(".composer-dock:not(.side-chat-composer)")
    .filter({ has: page.getByTestId("chat-input") })
    .first();
const sidePane = () =>
  baseline
    ? page.getByRole("region", { name: "旁路讨论", exact: true })
    : page.getByTestId("side-chat-pane").filter({ visible: true });
const sideInput = () => sidePane().getByRole("textbox", { name: "随心输入", exact: true });
const sideTabs = () => page.locator('[data-side-pane-tab-id^="side:"]');
const mainMessages = () => page.getByTestId("chat-view").locator(".messages").first();
const referenceTrigger = (pane) => pane.locator("[data-conversation-selection-reference-count]");
async function referenceCount(pane) {
  const trigger = referenceTrigger(pane);
  if (!(await trigger.count())) return 0;
  assert.equal(await trigger.count(), 1, "one visible count pill owns the reference collection");
  return Number(await trigger.getAttribute("data-conversation-selection-reference-count"));
}
async function showReferences(pane) {
  const details = page.getByTestId("conversation-selection-details").filter({ visible: true });
  if (!(await details.count())) await referenceTrigger(pane).click();
  await details.waitFor();
  await until(
    () =>
      details.evaluate(
        (element) =>
          getComputedStyle(element).opacity === "1" && !element.hasAttribute("data-starting-style"),
      ),
    "reference details finished their open transition",
  );
  return details.getByTestId("conversation-selection-reference");
}
async function dismissReferences() {
  const details = page.getByTestId("conversation-selection-details");
  if (await details.filter({ visible: true }).count()) await page.keyboard.press("Escape");
  await details.waitFor({ state: "hidden" });
}
const exists = (path) =>
  stat(path).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
async function until(predicate, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error(`Timeout waiting for ${label}`);
}
async function shot(name) {
  await withSmokeDeadline("side parity screenshot", () =>
    page.screenshot({ path: join(evidence, `${name}.png`), animations: "disabled", scale: "css" }),
  );
  await writeFile(join(evidence, `${name}.aria.txt`), await page.locator("body").ariaSnapshot());
}
async function readCoreThread(threadId) {
  const owner = project(await state());
  const execution = owner.state?.threads?.[threadId];
  const instance = execution?.executionCore?.instanceId ?? owner.core.instanceId;
  const descriptor = JSON.parse(
    execFileSync(binary, ["service", "status", "--instance", instance, "--json"], {
      env,
      encoding: "utf8",
      timeout: 20000,
    }),
  );
  assert.equal(descriptor.state, "ready");
  assert.equal(descriptor.workspace, execution?.worktree?.directory ?? workspace);
  const auth = JSON.parse(await readFile(descriptor.authFile, "utf8"));
  const principal = auth.principals.find((item) => item.permissions.includes("observe"));
  assert.ok(principal?.token);
  const client = new CoreClient({
    createSocket: () =>
      new WebSocket(descriptor.endpoint, {
        headers: { Authorization: `Bearer ${principal.token}` },
        followRedirects: false,
      }),
  });
  try {
    await client.connect();
    const thread = (await client.request("thread/read", { threadId, includeTurns: true })).thread;
    coreReads.push({ at: new Date().toISOString(), threadId, thread });
    return thread;
  } finally {
    client.close();
  }
}
async function launch() {
  app = await electron.launch({
    executablePath: require("electron"),
    args: [fixture.path],
    env,
    timeout: 120000,
  });
  ctx.app = app;
  app
    .process()
    .stderr.on(
      "data",
      (chunk) => void writeFile(join(evidence, "electron.stderr.log"), chunk, { flag: "a" }),
    );
  page = await app.firstWindow();
  ctx.page = page;
  page.setDefaultTimeout(12000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await until(async () => (await state()).connection?.state === "ready", "desktop ready", 90000);
  facts.launches.push(
    await app.evaluate(({ app, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setSize(1440, 960);
      window.focus();
      const preferences = window.webContents.getLastWebPreferences();
      return {
        pid: process.pid,
        userData: app.getPath("userData"),
        electron: process.versions.electron,
        platform: process.platform,
        sandbox: preferences.sandbox,
        contextIsolation: preferences.contextIsolation,
        nodeIntegration: preferences.nodeIntegration,
        bounds: window.getBounds(),
        contentBounds: window.getContentBounds(),
      };
    }),
  );
  const runtime = facts.launches.at(-1);
  runtime.viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    devicePixelRatio,
  }));
  assert.equal(runtime.userData, env.AREAL_GUI_USER_DATA);
  assert.deepEqual(
    [runtime.sandbox, runtime.contextIsolation, runtime.nodeIntegration],
    [true, true, false],
  );
}
async function closeOwned() {
  const metadata = await readFile(join(env.AREAL_CORE_HOME, "service.json"), "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  if (app) {
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 });
      })
      .catch(() => {});
    await closeSmokeApplication(app);
    app = null;
    ctx.app = null;
  }
  try {
    await assertApplicationStopped(binary, env, metadata);
  } catch {
    assert.ok(metadata, "cleanup targets only this run's metadata");
    const connection = new ServiceConnection();
    try {
      await connection.connect(metadata);
      await connection.request("hello", {
        protocol: metadata.protocol,
        identity: metadata.identity,
      });
      await connection.request("stopService", { protocol: metadata.protocol }, true);
    } finally {
      connection.close();
    }
    await waitForServiceExit(env.AREAL_CORE_HOME, metadata);
    await assertApplicationStopped(binary, env, metadata);
  }
  facts.cleanup.push({ pid: metadata?.pid ?? null, serviceExited: true });
}
async function sendMain(text, complete = true) {
  const previous = await currentId();
  const before = previous ? (threads(await state())[previous]?.turns?.length ?? 0) : 0;
  await mainComposer().getByTestId("chat-input").fill(text);
  await mainComposer().getByRole("button", { name: "发送", exact: true }).click();
  const id = await until(async () => (await currentId()) || null, "main thread identity");
  await until(async () => {
    const thread = threads(await state())[id];
    return (
      thread?.turns?.length > before &&
      (!complete || thread.turns.at(-1).status === "completed") &&
      thread
    );
  }, `main ${text}`);
  return id;
}
async function newParent(prompt) {
  if (await currentId()) await createProjectConversation(page, "w");
  return sendMain(prompt);
}
async function openSide() {
  const before = new Set(Object.keys(threads(await state())));
  const launcher = page.locator(
    baseline
      ? '[data-side-pane-open-tab-item="旁路讨论"]'
      : '[data-side-pane-open-tab-item="side"]',
  );
  if (await page.getByRole("button", { name: "打开侧边面板标签页", exact: true }).isVisible()) {
    await page.getByRole("button", { name: "打开侧边面板标签页", exact: true }).click();
    const entry = page.getByRole("menuitem", { name: /侧边聊天/ });
    if (!(await entry.count()) && baseline) {
      await page.keyboard.press("Escape");
      await mainComposer().getByTestId("chat-input").fill("/side");
      await mainComposer().getByRole("button", { name: "发送", exact: true }).click();
    } else {
      await entry.waitFor();
      assert.equal(await entry.count(), 1, "plus menu offers Side Chat");
      await entry.click();
    }
  } else {
    if (!(await launcher.isVisible()))
      await page.getByRole("button", { name: "展开侧边面板", exact: true }).click();
    if (!(await launcher.isVisible()) && baseline) {
      await mainComposer().getByTestId("chat-input").fill("/side");
      await mainComposer().getByRole("button", { name: "发送", exact: true }).click();
    } else {
      assert.equal(await launcher.count(), 1, "fixed panel launcher offers Side Chat");
      await launcher.click();
    }
  }
  if (!baseline)
    await until(async () => {
      const id = await sidePane().getAttribute("data-thread-id");
      return id && !before.has(id);
    }, "new empty child becomes the active pane");
  await sideInput().waitFor();
  return { before, id: await sidePane().getAttribute("data-thread-id") };
}
async function closeTab(id) {
  await page
    .locator(`[data-side-pane-tab-id="side:${id}"]`)
    .getByRole("tab")
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "关闭标签页", exact: true }).click();
  await until(
    async () => (await page.locator(`[data-side-pane-tab-id="side:${id}"]`).count()) === 0,
    "closed child tab removed after authoritative cleanup",
  );
}
async function sendSide(text, complete = true) {
  const before = new Map(
    Object.values(threads(await state()))
      .filter((thread) => thread.conversation?.kind === "side")
      .map((thread) => [thread.id, thread.turns?.length ?? 0]),
  );
  await sideInput().fill(text);
  await sidePane().getByRole("button", { name: "发送", exact: true }).click();
  return until(async () => {
    const found = Object.values(threads(await state())).find(
      (thread) =>
        thread.conversation?.kind === "side" &&
        (thread.turns?.length ?? 0) > (before.get(thread.id) ?? 0),
    );
    if (found && complete && found.turns.at(-1).status !== "inProgress")
      assert.equal(
        found.turns.at(-1).status,
        "completed",
        `child ${text} must complete successfully: ${JSON.stringify(found.turns.at(-1).error)}`,
      );
    return found && (!complete || found.turns.at(-1).status === "completed") ? found.id : null;
  }, `child ${text}`);
}
async function selectText(body, text, keyboard = false) {
  await body.scrollIntoViewIfNeeded();
  if (keyboard) {
    await page.bringToFront();
    await body.evaluate((element) => {
      element.tabIndex = -1;
      element.focus({ preventScroll: true });
    });
  }
  const selected = await body.evaluate(
    async (element, { text, keyboard }) => {
      const buildRange = () => {
        const nodes = [];
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) nodes.push(node);
        const start = nodes
          .map((node) => node.textContent)
          .join("")
          .indexOf(text);
        if (start < 0) throw Error("Selection text is absent from the rendered message");
        const end = start + (keyboard ? [...text][0].length : text.length);
        const range = document.createRange();
        let offset = 0,
          started = false;
        for (const node of nodes) {
          const next = offset + node.textContent.length;
          if (!started && start < next) {
            range.setStart(node, start - offset);
            started = true;
          }
          if (started && end <= next) {
            range.setEnd(node, end - offset);
            break;
          }
          offset = next;
        }
        return range;
      };
      buildRange().startContainer.parentElement?.scrollIntoView({
        block: "center",
        behavior: "instant",
      });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const range = buildRange();
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      if (!keyboard) element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return selection.toString();
    },
    { text, keyboard },
  );
  assert.equal(selected, keyboard ? [...text][0] : text);
  if (keyboard) {
    await page.keyboard.down("Shift");
    try {
      for (const _character of [...text].slice(1)) await page.keyboard.press("ArrowRight");
    } finally {
      await page.keyboard.up("Shift");
    }
    assert.equal(await page.evaluate(() => window.getSelection().toString()), text);
  }
}
async function addReference(body, text, target = "main", keyboard = false) {
  await selectText(body, text, keyboard);
  const actions = page.getByTestId("transcript-selection-actions");
  await actions.waitFor();
  const action = actions.getByRole("button", {
    name: target === "main" ? "添加到聊天" : "在旁路中询问所选内容",
    exact: true,
  });
  await action.focus();
  await action.press("Enter");
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
}
async function toolAndPermission() {
  const parent = await newParent("PARITY:P1_PARENT");
  const configured = await page.evaluate(
    ({ projectId, threadId }) =>
      window.arealDesktop.command("configure", {
        projectId,
        threadId,
        profile: { id: "standard", revision: "v1" },
        options: { permissionPreset: "ask" },
      }),
    { projectId, threadId: parent },
  );
  assert.ok(
    configured && !configured.error,
    "real parent configuration enables the approvalTools fixture",
  );
  await until(
    async () => project(await state()).configurations[parent]?.profile?.id === "standard",
    "fixture profile configured",
  );
  const before = await readCoreThread(parent);
  // GUI 刷新会补充显示字段；父配置隔离应前后比较同一 Core 权威记录。
  const configBefore = before.desktop?.configuration;
  assert.ok(configBefore, "authoritative parent configuration is present");
  await openSide();
  const child = await sendSide("PARITY:P1_READ");
  const read = await readCoreThread(child);
  assert.ok(
    JSON.stringify(read).includes("SIDE_PARITY_REAL_FILE"),
    "child-owned real fs_read returns seeded bytes",
  );
  await sendSide("PARITY:P1_WRITE", false);
  const pending = await until(
    async () =>
      (project(await state()).state.interactions?.[child]?.data ?? []).find(
        (item) => item.kind === "approval" && item.status === "pending",
      ),
    "child fs_create approval",
  );
  assert.equal(pending.tool, "fs_create");
  assert.equal(
    await exists(join(workspace, "approved.txt")),
    false,
    "no write occurs before approval",
  );
  await shot("P1-approval");
  await sidePane().getByRole("button", { name: "允许一次", exact: true }).click();
  await until(
    async () => threads(await state())[child]?.turns.at(-1).status === "completed",
    "approved Runtime completion",
  );
  assert.equal(await readFile(join(workspace, "approved.txt"), "utf8"), "CHILD_APPROVED_BYTES\n");
  const written = await readCoreThread(child);
  assert.ok(
    written.turns
      .at(-1)
      .items.some(
        (item) =>
          item.type === "dynamicToolCall" &&
          item.tool === "fs_create" &&
          item.status === "completed",
      ),
    "authoritative child history records successful fs_create",
  );
  await sendSide("PARITY:P1_DENY", false);
  await sidePane().getByRole("button", { name: "拒绝 Esc", exact: true }).click();
  await until(
    async () => threads(await state())[child]?.turns.at(-1).status === "completed",
    "denied operation settled",
  );
  assert.equal(await exists(join(workspace, "denied.txt")), false);
  const modelButton = sidePane().getByRole("button", { name: "模型", exact: true });
  await modelButton.click();
  await page.getByRole("button", { name: "选择模型", exact: true }).click();
  await page.getByRole("radio", { name: /fixture-alternate/ }).click();
  await page.keyboard.press("Escape");
  await until(
    async () =>
      project(await state()).configurations[child]?.model?.modelId === "fixture-alternate",
    "independent child model",
  );
  const parentAfter = await readCoreThread(parent);
  assert.deepEqual(
    parentAfter.desktop?.configuration,
    configBefore,
    "child configuration leaves parent unchanged",
  );
  assert.deepEqual(parentAfter.turns, before.turns, "child tools leave parent turns unchanged");
  checks.push(
    "P1 real child fs_read, approved and denied fs_create, exact bytes, independent configuration, unchanged parent",
  );
}
async function hiddenStableHistory() {
  await rm(release, { force: true });
  const parent = await newParent("PARITY:P2_SEED");
  const executionRoot = threads(await state())[parent]?.worktree?.directory ?? workspace;
  marker = join(executionRoot, "parent-tool.txt");
  release = join(executionRoot, "release-parent-tool");
  await sendMain("PARITY:P2_ACTIVE", false);
  await until(() => exists(marker), "held Runtime parent tool started");
  const before = requests.length;
  await openSide();
  assert.equal(requests.length, before, "empty Side makes no model request");
  const child = await sendSide("PARITY:P2_CHILD_ONE");
  const first = requests.findLast((item) => item.prompt === "PARITY:P2_CHILD_ONE").body;
  const context = JSON.stringify(first.messages);
  assert.ok(
    context.includes("PARITY:P2_SEED") &&
      context.includes("P2_STABLE_ASSISTANT_HISTORY") &&
      context.includes("SIDE_PARITY_REAL_FILE"),
    "first child request inherits complete stable parent user, assistant and real tool history",
  );
  assert.ok(
    context.includes("PARITY:P2_ACTIVE"),
    "committed active parent user input is inherited",
  );
  assert.ok(
    !context.includes("P2_UNFINISHED_ASSISTANT") && !context.includes("P2_TOOL_FINISHED"),
    "unfinished parent assistant and tool deltas are excluded",
  );
  const firstQuestion = first.messages.filter(
    (message) => message.role === "user" && textOf(message.content).includes("PARITY:P2_CHILD_ONE"),
  );
  assert.equal(firstQuestion.length, 1, "inherited context has one distinct child question");
  assert.ok(
    textOf(first.messages.findLast((message) => message.role === "user").content).includes(
      "PARITY:P2_CHILD_ONE",
    ),
    "child question follows inherited parent input",
  );
  assert.equal(
    await sidePane().locator("[data-turn-id]").count(),
    1,
    "child timeline displays child turns only",
  );
  assert.ok(
    !(await sidePane().innerText()).includes("P2_STABLE_ASSISTANT_HISTORY"),
    "inherited parent content is hidden from the child timeline",
  );
  await writeFile(release, "release");
  await until(
    async () => threads(await state())[parent]?.turns.at(-1).status === "completed",
    "parent tool completes",
  );
  const childTurns = (await readCoreThread(child)).turns.length;
  await sendMain("PARITY:P2_LATER_PARENT");
  assert.equal(
    (await readCoreThread(child)).turns.length,
    childTurns,
    "parent progress submits no child turn",
  );
  await sendSide("PARITY:P2_CHILD_TWO");
  const second = JSON.stringify(
    requests.findLast((item) => item.prompt === "PARITY:P2_CHILD_TWO").body.messages,
  );
  assert.ok(
    !second.includes("P2_LATE_SENTINEL") && !second.includes("PARITY:P2_LATER_PARENT"),
    "child remains bound to original stable context",
  );
  assert.equal(
    await readFile(marker, "utf8"),
    "executed\n",
    "inherited context never replays parent Runtime command",
  );
  checks.push(
    "P2 stable hidden parent context, active user only, frozen child context, no parent tool replay",
  );
}
async function multipleTabs() {
  const parent = await newParent("PARITY:P3_PARENT");
  const countBefore = requests.length;
  const opened = await openSide();
  const first = await sidePane().getAttribute("data-thread-id");
  assert.ok(first && !opened.before.has(first), "panel entry creates a distinct empty Core child");
  assert.equal(threads(await state())[first].turns.length, 0);
  await sideInput().fill("FIRST_CHILD_DRAFT");
  await openSide();
  const second = await sidePane().getAttribute("data-thread-id");
  assert.notEqual(second, first, "plus entry creates a second distinct child");
  assert.equal(await sideTabs().count(), 2, "two numbered child tabs remain open");
  await sideInput().fill("SECOND_CHILD_DRAFT");
  await page.locator(`[data-side-pane-tab-id="side:${first}"]`).getByRole("tab").click();
  assert.equal(await sideInput().innerText(), "FIRST_CHILD_DRAFT");
  const body = mainMessages()
    .locator("[data-side-item-id] .conversation-markdown")
    .filter({ hasText: "DONE PARITY:P3_PARENT" })
    .first();
  await addReference(body, "DONE PARITY:P3_PARENT", "side");
  await until(
    async () => (await referenceCount(sidePane())) === 1,
    "selection attaches to active child after public read",
  );
  assert.equal(
    await sideTabs().count(),
    2,
    "active child receives selection without another child",
  );
  assert.equal(await referenceCount(sidePane()), 1);
  await page.locator(`[data-side-pane-tab-id="side:${second}"]`).getByRole("tab").click();
  assert.equal(await sideInput().innerText(), "SECOND_CHILD_DRAFT");
  assert.equal(await referenceCount(sidePane()), 0, "sibling reference state is independent");
  await page.getByRole("button", { name: "打开侧边面板标签页", exact: true }).click();
  await page.getByRole("menuitem", { name: /^文件/ }).click();
  await addReference(body, "DONE PARITY:P3_PARENT", "side");
  await until(
    async () => (await sideTabs().count()) === 3 && (await referenceCount(sidePane())) === 1,
    "resource-tab selection creates and reveals child",
  );
  assert.equal(
    await sideTabs().count(),
    3,
    "selection while a non-Side tab is active creates a new child",
  );
  await shot("P3-multiple-tabs-references");
  const routed = await sidePane().getAttribute("data-thread-id");
  assert.ok(routed !== first && routed !== second);
  assert.equal(await referenceCount(sidePane()), 1);
  await closeTab(routed);
  await closeTab(first);
  assert.equal(await sideTabs().count(), 1);
  await page.locator(`[data-side-pane-tab-id="side:${second}"]`).getByRole("tab").click();
  assert.equal(
    await sideInput().innerText(),
    "SECOND_CHILD_DRAFT",
    "closing sibling preserves its draft",
  );
  const another = await newParent("PARITY:P3_OTHER_PARENT");
  assert.notEqual(another, parent);
  assert.equal(await sideTabs().count(), 0, "another parent has no borrowed tabs");
  await selectConversation(page, parent);
  assert.equal(await sideTabs().count(), 1, "returning to parent restores its open child tab");
  assert.equal(await sideInput().innerText(), "SECOND_CHILD_DRAFT");
  assert.equal(
    await page.getByTestId(`task-item-${second}`).count(),
    0,
    "child never appears as a normal sidebar conversation",
  );
  assert.equal(requests.length, countBefore + 1, "tab entries and drafts make no model requests");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await until(
    () => app.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].isVisible()),
    "window closes to background",
  );
  const closed = await readCoreThread(second);
  assert.equal(closed.desktop.archived, true, "window close fences owned child");
  assert.ok(
    closed.desktop.receipts.some(
      (receipt) =>
        receipt.method === "areal/side/close" && receipt.result.cleanupConfirmed === true,
    ),
    "window close confirms owned child cleanup",
  );
  await app.evaluate(({ app }) => app.emit("activate"));
  await until(
    () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
    "same window reopens",
  );
  await until(
    async () => (await sideTabs().count()) === 0,
    "reopening drops authoritatively closed child tabs",
  );
  await openSide();
  const beforeRestart = await sidePane().getAttribute("data-thread-id");
  await sideInput().fill("COLD_RESTART_DRAFT");
  await closeOwned();
  await launch();
  await until(
    async () => project(await state())?.state?.connected,
    "project restored after restart",
  );
  await selectConversation(page, parent);
  assert.equal(await sideTabs().count(), 0, "restart restores no ephemeral child tabs");
  await openSide();
  assert.equal(await sideInput().textContent(), "", "restart restores no child draft");
  assert.notEqual(
    await sidePane().getAttribute("data-thread-id"),
    beforeRestart,
    "new entry does not restore old parent-child binding",
  );
  checks.push(
    "P3 distinct ephemeral tabs, independent drafts/references, close, parent switching, owning-window close/reopen and cold restart",
  );
}
async function selectionReferences() {
  await newParent("PARITY:P4_SOURCE");
  await sendMain("PARITY:P4_OTHER");
  const body = mainMessages()
    .locator("[data-side-item-id] .conversation-markdown")
    .filter({ hasText: sourceText })
    .first();
  const other = mainMessages()
    .locator("[data-side-item-id] .conversation-markdown")
    .filter({ hasText: "SHARED_REFERENCE_TEXT" })
    .last();
  const main = mainComposer();
  await main.getByTestId("chat-input").fill("P4_DRAFT_SURVIVES");
  await main.locator('input[type="file"]').setInputFiles(join(workspace, "attachment.txt"));
  const before = requests.length;
  await addReference(body, sourceText, "main", true);
  await addReference(body, "SHARED_REFERENCE_TEXT");
  assert.equal(
    await referenceCount(main),
    2,
    "different selections accumulate as separate references",
  );
  await addReference(body, sourceText);
  assert.equal(await referenceCount(main), 2, "same row, type and text deduplicate");
  await addReference(other, "SHARED_REFERENCE_TEXT");
  assert.equal(
    await referenceCount(main),
    3,
    "identical text from another source row remains distinct",
  );
  await (
    await showReferences(main)
  )
    .filter({ hasText: sourceText })
    .getByRole("button", { name: /移除|删除/ })
    .click();
  await dismissReferences();
  assert.equal(
    await referenceCount(main),
    2,
    "removing one reference preserves both other source references",
  );
  assert.equal(await main.getByTestId("chat-input").innerText(), "P4_DRAFT_SURVIVES");
  assert.ok(
    (await main.getByTestId("composer-attachments").innerText()).includes("attachment.txt"),
  );
  assert.equal(requests.length, before, "selection actions never submit model calls");
  await shot("P4-reference-collection");
  await main.getByRole("button", { name: "发送", exact: true }).click();
  await until(() => requests.length > before, "reference-bearing provider request");
  const payload = textOf(
    requests
      .at(-1)
      .body.messages.findLast(
        (message) =>
          message.role === "user" && textOf(message.content).includes("P4_DRAFT_SURVIVES"),
      )?.content,
  );
  const block = payload.match(/# userselect:\s*(?:```(?:userselect|json)?\s*)?(\[[\s\S]*?\])/);
  assert.ok(block, "provider input carries the structured userselect array");
  assert.deepEqual(
    JSON.parse(block[1]),
    [{ text: "SHARED_REFERENCE_TEXT" }, { text: "SHARED_REFERENCE_TEXT" }],
    "model receives text only without source identifiers",
  );
  await until(
    async () => threads(await state())[await currentId()]?.turns.at(-1).status === "completed",
    "reference turn completed",
  );
  assert.equal(
    await referenceCount(mainMessages()),
    2,
    "persisted user input renders the timeline reference collection",
  );
  assert.equal(
    await (await showReferences(mainMessages())).count(),
    2,
    "both persisted references remain independently inspectable",
  );
  await shot("P4-reference-details");
  await dismissReferences();
  const clear = async () => {
    if (await referenceCount(main))
      await main.getByRole("button", { name: "移除全部引用", exact: true }).click();
    await until(
      async () => (await referenceCount(main)) === 0,
      "all captured reference rows removed",
    );
  };
  await sendMain("PARITY:STREAM_SELECTION", false);
  const streamed = mainMessages()
    .locator("[data-side-item-id] .conversation-markdown")
    .filter({ hasText: "STREAM_SELECTION_1" })
    .last();
  await streamed.waitFor();
  const streamRequests = requests.length;
  await addReference(streamed, "STREAM_SELECTION_1");
  assert.equal(
    threads(await state())[await currentId()]?.turns.at(-1).status,
    "inProgress",
    "the quote is staged while the response stream remains open",
  );
  assert.ok(streamSteps.has("PARITY:STREAM_SELECTION"));
  streamSteps.get("PARITY:STREAM_SELECTION")();
  await until(
    async () => (await streamed.innerText()).includes("STREAM_SELECTION_2"),
    "stream advances after selection",
  );
  assert.equal(await referenceCount(main), 1);
  assert.ok(
    !(await (await showReferences(main)).innerText()).includes("STREAM_SELECTION_2"),
    "streamed quote freezes at selection action time",
  );
  await dismissReferences();
  assert.equal(requests.length, streamRequests, "stream selection stages a draft without sending");
  streams.get("PARITY:STREAM_SELECTION")?.();
  await until(
    async () => threads(await state())[await currentId()]?.turns.at(-1).status === "completed",
    "selection stream settled",
  );
  await clear();
  await main.getByTestId("chat-input").fill("LIMIT_DRAFT_SURVIVES");
  await addReference(body, longC);
  assert.equal(await referenceCount(main), 0, "8001 characters are refused atomically");
  await addReference(body, longA);
  await addReference(body, longB);
  assert.equal(
    await referenceCount(main),
    2,
    "two 8000-character references reach the 16000 total limit",
  );
  const fullReferences = await (
    await showReferences(main)
  ).evaluateAll((elements) =>
    elements.map((element) => ({ id: element.dataset.referenceId, text: element.textContent })),
  );
  await dismissReferences();
  await addReference(body, "REFERENCE_0");
  assert.equal(
    await referenceCount(main),
    2,
    "16000 total limit refuses an addition without truncation",
  );
  assert.deepEqual(
    await (
      await showReferences(main)
    ).evaluateAll((elements) =>
      elements.map((element) => ({ id: element.dataset.referenceId, text: element.textContent })),
    ),
    fullReferences,
    "total-limit refusal preserves every existing reference",
  );
  assert.equal(
    (await (await showReferences(main)).first().getAttribute("data-reference-id")) !== null,
    true,
  );
  assert.equal(await main.getByTestId("chat-input").innerText(), "LIMIT_DRAFT_SURVIVES");
  await dismissReferences();
  await sendMain("LIMIT_DRAFT_SURVIVES");
  const limitPayload = textOf(
    requests
      .at(-1)
      .body.messages.findLast(
        (message) =>
          message.role === "user" && textOf(message.content).includes("LIMIT_DRAFT_SURVIVES"),
      )?.content,
  );
  const limitBlock = limitPayload.match(
    /# userselect:\s*(?:```(?:userselect|json)?\s*)?(\[[\s\S]*?\])/,
  );
  assert.ok(limitBlock);
  assert.deepEqual(
    JSON.parse(limitBlock[1]),
    [{ text: longA }, { text: longB }],
    "accepted references reach the model without truncation",
  );
  await main.getByTestId("chat-input").fill("LIMIT_DRAFT_SURVIVES");
  for (let index = 0; index < 8; index++) await addReference(body, `REFERENCE_${index}`);
  assert.equal(await referenceCount(main), 8);
  await addReference(body, "REFERENCE_8");
  assert.equal(await referenceCount(main), 8, "ninth reference is refused atomically");
  assert.equal(await main.getByTestId("chat-input").innerText(), "LIMIT_DRAFT_SURVIVES");
  await clear();
  await shot("P4-limits");
  checks.push(
    "P4 real Shift selection, accumulation/dedup/removal, text-only structured payload, persisted chips, atomic 8000/8/16000 limits",
  );
}
async function normalComposerAndSideCommands() {
  const parent = await newParent("PARITY:P5_PARENT");
  await openSide();
  assert.equal(
    await sidePane().locator('input[type="file"]').count(),
    1,
    "Side exposes the normal composer attachment input",
  );
  await sidePane().locator('input[type="file"]').setInputFiles(join(workspace, "attachment.txt"));
  await sidePane()
    .getByTestId("composer-attachments")
    .getByText("attachment.txt", { exact: true })
    .waitFor();
  const child = await sendSide("PARITY:P5_ATTACHMENT");
  const authoritative = await readCoreThread(child);
  const childInput = authoritative.turns.at(-1).items.find((item) => item.type === "userMessage");
  assert.ok(
    JSON.stringify(childInput).includes("attachment.txt"),
    "real Core child input owns the uploaded attachment",
  );
  assert.ok(
    JSON.stringify(
      requests.findLast((item) => item.prompt === "PARITY:P5_ATTACHMENT").body.messages,
    ).includes("SIDE_PARITY_ATTACHMENT_BYTES"),
    "model receives real attachment context",
  );
  await sideInput().fill("/files");
  const ordinary = page.getByRole("option", { name: /工作区文件/ });
  await ordinary.waitFor();
  await ordinary.click();
  await page.getByRole("tab", { name: "文件", exact: true }).waitFor();
  await page.locator(`[data-side-pane-tab-id="side:${child}"]`).getByRole("tab").click();
  await sideInput().fill("/");
  assert.equal(
    await page.getByRole("option", { name: /侧边聊天|\/(?:side|btw)\b/ }).count(),
    0,
    "app Side commands are absent from child catalog",
  );
  await sideInput().fill("");
  for (const command of ["side", "btw"]) {
    if (command === "btw") {
      await sendMain("PARITY:STREAM_P5_PARENT", false);
      await until(
        () => requests.some((item) => item.prompt === "PARITY:STREAM_P5_PARENT"),
        "busy parent reached the model before command request counting",
      );
    }
    const parentBefore = await readCoreThread(parent);
    const queueBefore = structuredClone(project(await state()).state.queues[parent]);
    const count = requests.length,
      tabs = await sideTabs().count();
    if (command === "side") {
      await mainComposer().getByTestId("chat-input").fill("/");
      await page.getByRole("option").filter({ hasText: "/side" }).waitFor();
      await page.getByRole("option").filter({ hasText: "/btw" }).waitFor();
      await shot("P5-main-slash-menu");
    }
    await mainComposer().getByTestId("chat-input").fill(`/${command}`);
    await mainComposer().getByRole("button", { name: "发送", exact: true }).click();
    await until(
      async () => (await sideTabs().count()) === tabs + 1,
      `bare /${command} creates empty child`,
    );
    assert.equal(await mainComposer().getByTestId("chat-input").textContent(), "");
    assert.equal(requests.length, count, "bare app command does not send");
    await mainComposer()
      .getByTestId("chat-input")
      .fill(`/${command} PARITY:P5_${command.toUpperCase()}`);
    await mainComposer().getByRole("button", { name: "发送", exact: true }).click();
    await until(
      () => requests.length === count + 1,
      `/${command} text sends exactly one child request`,
    );
    const sent = requests.at(-1);
    assert.equal(sent.prompt, `PARITY:P5_${command.toUpperCase()}`);
    assert.equal(await mainComposer().getByTestId("chat-input").textContent(), "");
    const parentAfter = await readCoreThread(parent);
    assert.deepEqual(
      parentAfter.turns.map((turn) => turn.id),
      parentBefore.turns.map((turn) => turn.id),
      "app command creates no parent turn",
    );
    assert.deepEqual(
      project(await state()).state.queues[parent],
      queueBefore,
      "app command never queues or steers the running parent",
    );
  }
  streams.get("PARITY:STREAM_P5_PARENT")?.();
  await until(
    async () => threads(await state())[parent]?.turns.at(-1).status === "completed",
    "busy parent settled after app command",
  );
  await mainComposer()
    .locator('input[type="file"]')
    .setInputFiles(join(workspace, "attachment.txt"));
  const count = requests.length,
    tabs = await sideTabs().count();
  await sendMain("/side PARITY:P5_MAIN_FALLBACK");
  assert.equal(requests.length, count + 1);
  assert.equal(
    await sideTabs().count(),
    tabs,
    "attachment-bearing /side input follows normal main send",
  );
  assert.ok(
    JSON.stringify((await readCoreThread(parent)).turns.at(-1)).includes("PARITY:P5_MAIN_FALLBACK"),
  );
  checks.push(
    "P5 normal Side attachment and slash composer, bare /side and /btw, immediate text first-send, attachment fallback",
  );
}
async function escapeOwnership() {
  // 拉长关闭动画，稳定覆盖内部 Activity 已隐藏、外层弹层仍持有 Esc 的时段。
  const closeMotion = await page.addStyleTag({
    content:
      ".task-resources-popup { transition: opacity 1500ms linear, scale 1500ms linear !important; }",
  });
  const parent = await newParent("PARITY:P6_PARENT");
  await openSide();
  const commandRecords = async () =>
    (await readFile(commandLog, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  const turnText = (turn) =>
    (turn?.items ?? [])
      .filter((item) => item.type === "agentMessage")
      .map((item) => item.text ?? "")
      .join("");
  const grows = async (threadId, label) => {
    const before = turnText(threads(await state())[threadId].turns.at(-1));
    await until(async () => {
      const turn = threads(await state())[threadId]?.turns.at(-1);
      return turn?.status === "inProgress" && turnText(turn).length > before.length;
    }, label);
  };
  for (const order of ["MAIN_FIRST", "SIDE_FIRST"]) {
    let child;
    if (order === "MAIN_FIRST") {
      await sendMain(`PARITY:STREAM_MAIN_${order}`, false);
      child = await sendSide(`PARITY:STREAM_SIDE_${order}`, false);
    } else {
      child = await sendSide(`PARITY:STREAM_SIDE_${order}`, false);
      await sendMain(`PARITY:STREAM_MAIN_${order}`, false);
    }
    const both = await until(async () => {
      const snapshot = await state();
      return (
        threads(snapshot)[parent]?.turns.at(-1)?.status === "inProgress" &&
        threads(snapshot)[child]?.turns.at(-1)?.status === "inProgress" &&
        snapshot
      );
    }, "both independent streams active");
    await shot(`P6-concurrent-${order}`);
    const parentTurn = threads(both)[parent].turns.at(-1).id,
      childTurn = threads(both)[child].turns.at(-1).id;
    const beforeStops = (await commandRecords()).filter((item) => item.name === "stop").length;
    await sideInput().focus();
    await page.keyboard.press("Escape");
    await until(
      async () => threads(await state())[child]?.turns.at(-1).status !== "inProgress",
      "focused child stopped",
    );
    await sideInput().focus();
    await page.keyboard.press("Escape");
    const growth = turnText(threads(await state())[parent].turns.at(-1));
    await until(async () => {
      const turn = threads(await state())[parent]?.turns.at(-1);
      return turn?.status === "inProgress" && turnText(turn).length > growth.length;
    }, "main survivor keeps growing after repeated idle Side Esc");
    let stops = (await commandRecords()).filter((item) => item.name === "stop").slice(beforeStops);
    assert.equal(stops.length, 1, "repeated idle child Esc never stops main or replays stop");
    assert.equal(stops[0].request.turnId, childTurn);
    await page.getByRole("button", { name: "收起侧栏", exact: true }).focus();
    await page.keyboard.press("Escape");
    await grows(parent, "outside focus with panel open preserves growing main stream");
    assert.equal(
      (await readCoreThread(parent)).turns.at(-1).status,
      "inProgress",
      "outside focus with panel open stops neither pane",
    );
    await mainComposer().getByTestId("chat-input").focus();
    await page.keyboard.press("Escape");
    await until(
      async () => threads(await state())[parent]?.turns.at(-1).status !== "inProgress",
      "focused main stopped",
    );
    await until(
      async () =>
        (await commandRecords()).filter((item) => item.name === "stop").length === beforeStops + 2,
      "both original stop receipts observed",
    );
    stops = (await commandRecords()).filter((item) => item.name === "stop").slice(beforeStops);
    assert.equal(stops.length, 2);
    assert.equal(stops[1].request.turnId, parentTurn);
    const finalChild = await readCoreThread(child),
      finalParent = await readCoreThread(parent);
    assert.notEqual(finalChild.turns.at(-1).status, "inProgress");
    assert.notEqual(finalParent.turns.at(-1).status, "inProgress");
    await sendMain(`PARITY:STREAM_MAIN_SECOND_${order}`, false);
    await sendSide(`PARITY:STREAM_SIDE_SECOND_${order}`, false);
    const beforeMainStop = (await commandRecords()).filter((item) => item.name === "stop").length;
    const mainSecond = (await readCoreThread(parent)).turns.at(-1).id;
    const sideSecond = (await readCoreThread(child)).turns.at(-1).id;
    await mainComposer().getByTestId("chat-input").focus();
    await page.keyboard.press("Escape");
    await until(
      async () => threads(await state())[parent]?.turns.at(-1).status !== "inProgress",
      "main-focused Esc stops main alone",
    );
    await grows(child, "Side survivor keeps growing after main-focused Esc");
    await page.getByRole("button", { name: "关闭面板", exact: true }).click();
    await grows(child, "closing panel leaves Side execution running");
    await sendMain(`PARITY:STREAM_MAIN_CLOSED_${order}`, false);
    const closedMainTurn = (await readCoreThread(parent)).turns.at(-1).id;
    await page.getByRole("button", { name: "任务资源", exact: true }).click();
    const resources = page.getByRole("complementary", { name: "任务上下文", exact: true });
    await resources.waitFor();
    await until(
      () =>
        page
          .locator(".task-resources-popup")
          .evaluate((element) => getComputedStyle(element).opacity === "1"),
      "resources open transition completed",
    );
    await page.keyboard.press("Escape");
    await resources.waitFor({ state: "hidden" });
    (facts.resourceInnerHiddenProbes ??= []).push(
      await page.locator(".task-resources-popup").evaluate((element) => ({
        rects: element.getClientRects().length,
        ending: element.hasAttribute("data-ending-style"),
        transition: getComputedStyle(element).transition,
        opacity: getComputedStyle(element).opacity,
      })),
    );
    await grows(parent, "dismissing visible resources preserves the main stream");
    // Activity 隐藏不代表 keepMounted 弹层已退出；外层仍有布局时应继续保护主任务。
    await until(
      () =>
        page
          .locator(".task-resources-popup")
          .evaluate((element) => element.getClientRects().length === 0),
      "resources popup released Escape ownership",
    );
    (facts.resourceCloseProbes ??= []).push(
      await page.locator(".task-resources-popup").evaluate((element) => ({
        rects: element.getClientRects().length,
        ending: element.hasAttribute("data-ending-style"),
        display: getComputedStyle(element).display,
        opacity: getComputedStyle(element).opacity,
      })),
    );
    await page.getByRole("button", { name: "收起侧栏", exact: true }).focus();
    await page.keyboard.press("Escape");
    await until(
      async () => threads(await state())[parent]?.turns.at(-1).status !== "inProgress",
      "panel-closed outside Esc falls back to main",
    );
    await grows(child, "hidden Side survivor grows after main fallback stop");
    await page.getByRole("button", { name: "展开侧边面板", exact: true }).click();
    await sideInput().waitFor();
    await grows(child, "reopened Side is still streaming");
    await sideInput().focus();
    await page.keyboard.press("Escape");
    await until(
      async () => threads(await state())[child]?.turns.at(-1).status !== "inProgress",
      "Side survivor explicitly stopped",
    );
    await until(
      async () =>
        (await commandRecords()).filter((item) => item.name === "stop").length ===
        beforeMainStop + 3,
      "focused and fallback stop receipts observed",
    );
    const secondStops = (await commandRecords())
      .filter((item) => item.name === "stop")
      .slice(beforeMainStop);
    assert.deepEqual(
      secondStops.map((item) => item.request.turnId),
      [mainSecond, closedMainTurn, sideSecond],
      "focused and fallback stops keep exact original turn ownership without replay",
    );
  }
  await shot("P6-focus-scoped-stop");
  await closeMotion.evaluate((element) => element.remove());
  checks.push(
    "P6 both start orders, focus-scoped and repeated idle Esc, main and Side survivor growth, panel-closed main fallback, exact stop ownership",
  );
}
const scenarios = [
  ["P1", toolAndPermission],
  ["P2", hiddenStableHistory],
  ["P3", multipleTabs],
  ["P4", selectionReferences],
  ["P5", normalComposerAndSideCommands],
  ["P6", escapeOwnership],
];
console.log("Side Chat parity evidence:", evidence);
try {
  await launch();
  await page.evaluate(() => {
    const key = "areal-gui:application-preferences";
    localStorage.setItem(
      key,
      JSON.stringify({
        ...JSON.parse(localStorage.getItem(key) ?? "{}"),
        nextPromptSuggestions: false,
      }),
    );
  });
  await page.reload();
  await page.getByTestId("areal-workbench").waitFor();
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, workspace);
  await page.getByRole("button", { name: "不在项目中工作", exact: true }).click();
  await page.getByRole("menuitem", { name: "新建项目", exact: true }).click();
  await until(
    async () => project(await state())?.state?.connected,
    "isolated project connected",
    90000,
  );
  projectId = project(await state()).id;
  ctx.projectId = projectId;
  for (const [id, run] of scenarios) {
    if (scenario && scenario !== id) continue;
    const row = { id, startedAt: new Date().toISOString(), requestsBefore: requests.length };
    rows.push(row);
    try {
      await run(ctx);
      row.passed = true;
      await shot(`${id}-passed`);
    } catch (error) {
      row.passed = false;
      row.error = error.stack ?? String(error);
      await captureSmokeFailure(page, evidence, error);
      await shot(`${id}-failed`).catch(() => {});
      console.error(`${id} FAIL`, error.message);
      if (!baseline) throw error;
    } finally {
      row.requestsAfter = requests.length;
      await writeFile(release, "release");
      for (const settle of Array.from(streams.values())) settle();
      await until(
        async () =>
          !Object.values(threads(await state())).some(
            (thread) => thread.turns?.at(-1)?.status === "inProgress",
          ),
        "scenario streams and tools settled",
        20000,
      ).catch((error) => {
        row.settlementError = error.message;
      });
      await page.evaluate(() => window.getSelection()?.removeAllRanges()).catch(() => {});
      await writeFile(
        join(evidence, `${id}-snapshot.json`),
        JSON.stringify(await state(), null, 2),
      );
      const childIds = await sideTabs().evaluateAll((tabs) =>
        tabs.map((tab) => tab.getAttribute("data-side-pane-tab-id")?.slice(5)).filter(Boolean),
      );
      for (const id of childIds) await closeTab(id).catch(() => {});
      const oldReturn = sidePane().getByRole("button", { name: "返回主会话", exact: true });
      if (await oldReturn.isVisible()) await oldReturn.click();
    }
  }
  passed = rows.every((row) => row.passed === true && !row.settlementError) && errors.length === 0;
} catch (error) {
  facts.error = error.stack ?? String(error);
  if (page) await captureSmokeFailure(page, evidence, error);
} finally {
  await writeFile(release, "release");
  for (const settle of Array.from(streams.values())) settle();
  await closeOwned().catch((error) => {
    facts.cleanupError = error.stack ?? String(error);
    passed = false;
  });
  await fixture.close();
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  facts.binaryUnchanged = sha(await readFile(binary)) === facts.binarySha256;
  facts.bundleHashesAtEnd = await bundleHashes();
  facts.bundleUnchanged =
    JSON.stringify(facts.bundleHashesAtEnd) === JSON.stringify(facts.bundleHashesAtStart);
  if (!facts.bundleUnchanged) passed = false;
  facts.artifactHashesAtEnd = await artifactHashes().catch((error) => {
    facts.artifactHashError = error.message;
    return null;
  });
  facts.artifactsUnchanged =
    JSON.stringify(facts.artifactHashesAtEnd) === JSON.stringify(facts.artifactHashesAtStart);
  if (!facts.artifactsUnchanged) passed = false;
  if (!facts.binaryUnchanged) passed = false;
  await writeFile(join(evidence, "model-requests.json"), JSON.stringify(requests, null, 2));
  await writeFile(join(evidence, "core-reads.json"), JSON.stringify(coreReads, null, 2));
  const files = {};
  for (const name of [
    "seed.txt",
    "attachment.txt",
    "approved.txt",
    "denied.txt",
    "parent-tool.txt",
  ]) {
    const bytes = await readFile(join(workspace, name)).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    files[name] =
      bytes === null
        ? { exists: false }
        : { exists: true, sha256: sha(bytes), text: bytes.toString("utf8") };
  }
  await writeFile(join(evidence, "files.json"), JSON.stringify(files, null, 2));
  await writeFile(
    join(evidence, "manifest.json"),
    JSON.stringify(
      { ...facts, finishedAt: new Date().toISOString(), passed, checks, rows, errors },
      null,
      2,
    ),
  );
  if (!facts.cleanupError) await rm(stateRoot, { recursive: true, force: true });
}
console.log(
  JSON.stringify(
    {
      passed,
      evidence,
      rows: rows.map(({ id, passed, error }) => ({ id, passed, error: error?.split("\n")[0] })),
    },
    null,
    2,
  ),
);
if (!passed) process.exitCode = 1;
