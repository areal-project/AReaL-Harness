import {
  closeSmokeApplication,
  readFixtureHost,
  settleFixtureHostAfterQuit,
} from "./application-cleanup.mjs";
import { openProjectInDesktop } from "./support/journey-fixture.mjs";
import { fixtureWorkbench, until as waitFor } from "./support/desktop-fixture.mjs";
import { readTurnToolDetails } from "./support/tool-history.mjs";
import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { cp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { trackedMkdtemp } from "./support/host-cleanup.cjs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureSmokeFailure, selectConversation } from "./smoke-navigation.mjs";
import { withSmokeDeadline } from "./smoke-deadline.mjs";
import { respondToSessionName } from "./model-fixture.mjs";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const sourceDesktop = join(gui, "app");
const sourceRenderer = resolve(
  process.env.AREAL_COMPOSER_RENDERER_DIR || join(gui, "renderer/dist"),
);
const require = createRequire(join(sourceDesktop, "package.json"));
const { _electron: electron } = require("playwright-core");
const binary = process.env.AREAL_CORE_BIN || join(root, "target/debug/areal");
await mkdir(join(root, ".scratch/gui-evidence"), { recursive: true });
const scratch = await trackedMkdtemp(join(root, ".scratch/gui-evidence/conversation-continue-"));
const desktop = join(scratch, "application/app");
const renderer = join(scratch, "application/renderer/dist");
const registry = await makeTempDir("continue-svc-");
const workspace = join(scratch, "demo");
let projectId;
await mkdir(workspace);
await mkdir(join(scratch, "user-home"));
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
await writeFile(join(workspace, "evidence.txt"), "continue acceptance workspace\n");
execFileSync("git", ["add", "."], { cwd: workspace });
execFileSync(
  "git",
  ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-m", "fixture"],
  { cwd: workspace, stdio: "ignore" },
);
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
}
Object.assign(env, {
  HOME: join(scratch, "user-home"),
  AREAL_GUI: "workbench",
  AREAL_BACKEND: "areal",
  AREAL_CORE_BIN: binary,
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: join(scratch, "user-home"),
  AREAL_HARNESS_SERVICE_HOME: registry,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_HARNESS_HOME: registry,
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
});
const run = {
  evidence: scratch,
  workspace,
  registry,
  desktopHome: env.AREAL_CORE_HOME,
  binary,
  coreServices: [],
  hostGenerations: [],
};
const saveRun = () => writeFile(join(scratch, "run.json"), JSON.stringify(run, null, 2));
await saveRun();
const requests = [],
  checks = [],
  layoutFailures = [],
  pageErrors = [],
  stderr = [],
  commands = [];
const held = new Set();
let rpcClient;
const { CoreClient } = await import("../packages/runtime-client/core.js");
const WebSocket = require("ws");
const marker = randomUUID();
const pausePrompt = `HOLD_${marker} finish the original work`;
const mainDraft = `UNSENT_${marker}`;
let app,
  page,
  server,
  threadId,
  passed = false,
  failure,
  cleanupResult;
const snapshot = () =>
  withSmokeDeadline("desktop snapshot", () => page.evaluate(() => window.arealDesktop.snapshot()));
async function checkpoint(step) {
  run.step = step;
  console.log(JSON.stringify({ step }));
  await saveRun();
}
async function artifactFiles(directory) {
  const files = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      for (const [name, sha256] of Object.entries(await artifactFiles(path)))
        files[`${entry.name}/${name}`] = sha256;
    else {
      assert.ok(entry.isFile(), `artifact is a regular file: ${path}`);
      files[entry.name] = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
    }
  }
  return files;
}
async function until(predicate, label) {
  return waitFor(
    async () => {
      const value = await readThread();
      return (await predicate(value)) ? value : null;
    },
    label,
    { timeout: 45000 },
  );
}
async function readThread() {
  const response = await rpc("thread/read", { threadId, includeTurns: true }, false);
  assert.ok(response.result?.thread, JSON.stringify(response));
  assert.equal(response.result.thread.id, threadId);
  return response.result.thread;
}
const turns = async () => (await readThread()).turns;
let editLoss;
function observeEditSocket(socket) {
  const remote = socket.connectToServer();
  let replyId;
  const continuations = new Map();
  socket.onMessage((message) => {
    const { id, method, params } = JSON.parse(message.toString());
    if (method === "desktop.command" && params.command === "continue") {
      const { projectId, threadId, expectedTurnId, expectedConfigRevision, requestId } =
        params.request;
      const command = {
        name: "continue",
        request: { projectId, threadId, expectedTurnId, expectedConfigRevision, requestId },
      };
      continuations.set(id, command);
      commands.push(command);
    }
    if (method === "desktop.command" && params.command === "editMessage") {
      commands.push({ name: params.command, request: params.request });
      if (editLoss && !editLoss.requestId && params.request.threadId === threadId) {
        editLoss.requestId = params.request.requestId;
        replyId = id;
      }
    }
    remote.send(message);
  });
  remote.onMessage((message) => {
    const { id, result, error } = JSON.parse(message.toString());
    const continuation = continuations.get(id);
    if (continuation) {
      continuation.reply = {
        code: error?.code,
        message: error?.message,
        turnId: result?.turn?.id,
      };
      continuations.delete(id);
    }
    if (replyId !== undefined && id === replyId) {
      replyId = undefined;
      if (result?.turn?.id && !error) {
        editLoss.turnId = result.turn.id;
        void Promise.allSettled([socket.close(), remote.close()]);
        return;
      }
      editLoss.failure = error?.code ?? "INVALID_RESPONSE";
    }
    socket.send(message);
  });
}
const input = () => page.getByTestId("chat-input");
const shot = (name) => page.screenshot({ path: join(scratch, name), animations: "disabled" });
async function launch() {
  await checkpoint("launch Electron");
  app = await electron.launch({
    executablePath: require("electron"),
    args: [desktop],
    env,
    timeout: 120000,
  });
  app.process().stderr.on("data", (chunk) => stderr.push(String(chunk)));
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="areal-workbench"]') ||
      document.body.innerText.includes("GUI 未构建"),
    null,
    { timeout: 60000 },
  );
  assert.equal(
    await page.getByTestId("areal-workbench").count(),
    1,
    `workbench loaded from frozen renderer: ${await page.locator("body").innerText()}`,
  );
  await app.evaluate(({ BrowserWindow, dialog }) => {
    BrowserWindow.getAllWindows()[0].setSize(1440, 960);
    // 本夹具验证暂停与重启后的会话，退出确认由独立场景覆盖。
    dialog.showMessageBox = async () => ({ response: 1 });
  });
  const ready = page.locator('[data-testid="areal-workbench"][data-startup-ready="true"]');
  await ready.waitFor({ timeout: 120000 });
  await page.routeWebSocket(/\/host\/socket$/, observeEditSocket);
  await page.evaluate(() =>
    localStorage.setItem(
      "areal-gui:application-preferences",
      JSON.stringify({ locale: "zh-CN", nextPromptSuggestions: false }),
    ),
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await ready.waitFor({ timeout: 120000 });
  const host = await waitFor(() => readFixtureHost(env), "isolated Host published");
  run.hostGenerations.push({ hostId: host.hostId, generation: host.generation, pid: host.pid });
  await saveRun();
}
async function command(name, request) {
  const params = { projectId, threadId, ...request };
  commands.push({ name, request: params });
  const response = await page.evaluate(
    ({ name, params }) => window.arealDesktop.command(name, params),
    { name, params },
  );
  return response.ok
    ? { result: response.value }
    : { error: response.error?.message, code: response.error?.code };
}
async function reconnectCore() {
  const result = await page.evaluate(
    (projectId) => window.arealDesktop.command("connect", { projectId }),
    projectId,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  await waitFor(
    async () =>
      (await coreInstances()).find((row) => row.workspace === workspace && row.state === "ready"),
    "original workspace has a ready Core generation",
  );
}
async function rpc(method, params, capture = true) {
  if (!rpcClient) {
    const instances = JSON.parse(
      execFileSync(binary, ["service", "list", "--json"], {
        env,
        encoding: "utf8",
        timeout: 30000,
      }),
    );
    const instance = instances.find(
      (item) => item.workspace === workspace && item.state === "ready",
    );
    assert.ok(instance, "isolated Core service is registered");
    const descriptor = JSON.parse(
      execFileSync(binary, ["service", "status", "--instance", instance.serviceId, "--json"], {
        env,
        encoding: "utf8",
        timeout: 30000,
      }),
    );
    const auth = JSON.parse(await readFile(descriptor.authFile, "utf8"));
    const principal = auth.principals.find((p) => p.id === "desktop-owner");
    assert.ok(principal, "isolated desktop owner exists");
    rpcClient = new CoreClient({
      createSocket: () =>
        new WebSocket(descriptor.endpoint, {
          headers: { Authorization: `Bearer ${principal.token}` },
        }),
    });
    await rpcClient.connect();
  }
  if (capture) commands.push({ method, params });
  try {
    return { result: await rpcClient.request(method, params) };
  } catch (error) {
    return { error: error.message, code: error.code };
  }
}
async function send(text) {
  const before = threadId ? (await turns()).length : 0;
  const beforeRequests = requests.length;
  await input().fill(text);
  await page.getByTestId("chat-send-button").click();
  if (!threadId) {
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="areal-workbench"]')?.dataset.threadId,
    );
    threadId = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
  }
  await until(
    (s) =>
      s?.turns?.length > before &&
      requests.length > beforeRequests &&
      s.turns.at(-1).status === (text.startsWith("HOLD_") ? "inProgress" : "completed"),
    `send ${text}`,
  );
}
async function pause() {
  await page.getByRole("button", { name: "暂停执行", exact: true }).click();
  await until((s) => s?.turns?.at(-1)?.status === "interrupted", "pause settled");
  await page.getByRole("button", { name: "继续执行", exact: true }).waitFor();
}
async function closeGeneration(label) {
  const host = await readFixtureHost(env);
  const pid = app.process().pid;
  const evidence = join(scratch, label);
  await mkdir(evidence);
  const inventory = await coreInstances();
  rpcClient?.close();
  rpcClient = null;
  await closeSmokeApplication(app);
  app = null;
  const receipt = await settleFixtureHostAfterQuit(binary, env, evidence, { host, pid });
  assert.equal(receipt?.state, "completed");
  return inventory.find(({ workspace: root }) => root === workspace)?.dataDir;
}
async function coreInstances() {
  const instances = JSON.parse(
    execFileSync(binary, ["service", "list", "--json"], { env, encoding: "utf8", timeout: 30000 }),
  );
  for (const item of instances) {
    assert.ok(
      item.workspace.startsWith(scratch + "/"),
      "private registry contains only isolated fixture workspaces",
    );
    const {
      serviceId,
      generation,
      workspace: ownedWorkspace,
      dataDir,
      endpoint,
      hostPid,
      corePid,
      state,
    } = item;
    const identity = {
      serviceId,
      generation,
      workspace: ownedWorkspace,
      dataDir,
      endpoint,
      hostPid,
      corePid,
      state,
    };
    const index = run.coreServices.findIndex(
      (service) => service.serviceId === serviceId && service.generation === generation,
    );
    if (index === -1) run.coreServices.push(identity);
    else run.coreServices[index] = identity;
  }
  await saveRun();
  return instances;
}
async function cleanup(host, pid) {
  const result = { passed: false, coreStopped: false, desktopExited: false, errors: [] };
  try {
    rpcClient?.close();
    rpcClient = null;
    result.hostStop = await settleFixtureHostAfterQuit(binary, env, scratch, { host, pid });
    result.desktopExited = true;
    result.coreServices = await coreInstances();
    result.coreStopped = true;
  } catch (error) {
    result.errors.push(error.message);
  }
  result.passed = result.coreStopped && result.desktopExited && result.errors.length === 0;
  return result;
}
const chunk = (content) =>
  `data: ${JSON.stringify({ id: "continue-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
console.log("GUI evidence:", scratch);
try {
  await checkpoint("freeze source app and built renderer");
  const sourceArtifacts = {
    app: await artifactFiles(sourceDesktop),
    renderer: await artifactFiles(sourceRenderer),
  };
  assert.ok(sourceArtifacts.renderer["index.html"], "built renderer index exists");
  await mkdir(dirname(desktop), { recursive: true });
  await cp(sourceDesktop, desktop, {
    recursive: true,
    filter: (path) => path !== join(sourceDesktop, "node_modules"),
  });
  await symlink(join(sourceDesktop, "node_modules"), join(desktop, "node_modules"), "dir");
  // 源码 Electron 的桌面契约同时使用 workspace 相对路径，保留其原有目录关系。
  await symlink(join(gui, "packages"), join(scratch, "application/packages"), "dir");
  await cp(sourceRenderer, renderer, { recursive: true });
  assert.deepEqual(
    await artifactFiles(sourceDesktop),
    sourceArtifacts.app,
    "source app remained stable while copied",
  );
  assert.deepEqual(
    await artifactFiles(sourceRenderer),
    sourceArtifacts.renderer,
    "built renderer remained stable while copied",
  );
  assert.deepEqual(await artifactFiles(desktop), sourceArtifacts.app, "frozen app matches source");
  assert.deepEqual(
    await artifactFiles(renderer),
    sourceArtifacts.renderer,
    "frozen renderer matches build",
  );
  run.artifacts = {
    desktop,
    renderer,
    sourceRenderer,
    files: sourceArtifacts,
    acceptanceScriptSha256: createHash("sha256")
      .update(await readFile(fileURLToPath(import.meta.url)))
      .digest("hex"),
  };
  await checkpoint("isolated workspace fixture ready");
  server = createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const piece of req) raw += piece;
      const body = JSON.parse(raw);
      if (respondToSessionName(body, res)) return;
      // 输入建议不属于继续执行请求，且不能获得会话工具。
      if (
        body.messages?.some(
          (message) =>
            message.role === "system" &&
            typeof message.content === "string" &&
            message.content.startsWith("Predict the next user prompt from the conversation data."),
        )
      ) {
        assert.ok(!body.tools?.length, "prompt prediction must not receive conversation tools");
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        );
        return;
      }
      requests.push({ sequence: requests.length + 1, body });
      const last = body.messages?.findLast(
        (m) =>
          m.role === "user" &&
          !String(m.content).startsWith("AReaL runtime context (not a user request):"),
      );
      const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (text.startsWith("RUNTIME_PAUSE_") && !body.messages?.some((m) => m.role === "tool")) {
        const tool = {
          index: 0,
          id: "pause-runtime-command",
          type: "function",
          function: {
            name: "run_command",
            arguments: JSON.stringify({
              command:
                "printf started > pause-started.txt; sleep 120; printf unexpected > pause-finished.txt",
              yieldMs: 120000,
            }),
          },
        };
        res.end(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [tool] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
        );
        return;
      }
      res.write(chunk(`CONFIRMED_PROGRESS_${requests.length}`));
      if (text.startsWith("HOLD_")) {
        held.add(res);
        res.on("close", () => held.delete(res));
        return;
      }
      res.end(
        `data: ${JSON.stringify({ id: "continue-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\ndata: [DONE]\n\n`,
      );
    } catch (error) {
      res.destroy(error);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const config = join(scratch, "config.toml");
  await writeFile(
    config,
    `schema_version=1\n[model]\ncatalog_version=1\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${server.address().port}/v1/chat/completions"\nmodels=[{id="fixture",enabled=true}]\n`,
  );
  env.AREAL_CORE_CONFIG = config;
  await launch();
  await openProjectInDesktop(app, page, workspace);
  projectId = await page.getByTestId("areal-workbench").getAttribute("data-project-id");
  assert.ok(projectId, "project picker selected the isolated project");
  await page.getByTestId("composer-model-trigger").click();
  await page.getByRole("tab", { name: "fixture", exact: true }).click();
  await page.getByRole("radio", { name: "fixture", exact: true }).click();
  await page.keyboard.press("Escape");
  await checkpoint("pause a running Runtime command");
  await input().fill(`RUNTIME_PAUSE_${marker}`);
  await page.getByTestId("chat-send-button").click();
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid="areal-workbench"]')?.dataset.threadId,
  );
  threadId = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
  await waitFor(async () => {
    try {
      return (await readFile(join(workspace, "pause-started.txt"), "utf8")) === "started";
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }, "Runtime command actually started");
  await page.getByRole("button", { name: "暂停执行", exact: true }).click();
  await until((s) => s?.turns?.at(-1)?.status !== "inProgress", "Runtime pause settled");
  const runtimePaused = await readTurnToolDetails({
    command: async (name, params) => {
      const result = await page.evaluate(
        ({ name, params }) => window.arealDesktop.command(name, params),
        { name, params },
      );
      assert.equal(result.ok, true, JSON.stringify(result));
      return result.value;
    },
    readThread,
    projectId,
    threadId,
    turnId: (await turns()).at(-1).id,
  });
  await writeFile(join(scratch, "runtime-pause-turn.json"), JSON.stringify(runtimePaused, null, 2));
  await shot("00-runtime-paused.png");
  assert.equal(
    runtimePaused.status,
    "interrupted",
    "pausing a managed command with confirmed cleanup permits manual continuation",
  );
  const runtimeItem = runtimePaused.items.find(
    (item) => item.type === "dynamicToolCall" && item.tool === "run_command",
  );
  assert.ok(runtimeItem, "the real Runtime command is retained");
  assert.notEqual(
    runtimeItem.execution.outcome,
    "unknown",
    "confirmed Runtime command terminal receipt must be retained",
  );
  const commandReceipt = JSON.parse(
    runtimeItem.contentItems.find((item) => item.type === "inputText").text,
  );
  assert.equal(commandReceipt.state, "exited");
  assert.equal(commandReceipt.commandStatus, "terminated");
  assert.ok(commandReceipt.processId, "the original command identity is retained");
  assert.equal(
    await readFile(join(workspace, "pause-finished.txt"), "utf8").then(
      () => true,
      () => false,
    ),
    false,
    "cancelled command never reaches its final write",
  );
  const beforeContinue = requests.length;
  await page.getByRole("button", { name: "继续执行", exact: true }).click();
  await until(
    (s) => s?.turns?.at(-1)?.status === "completed",
    "Runtime pause continuation completed",
  );
  const runtimeContinued = (await turns()).at(-1);
  assert.equal(runtimeContinued.continuedFromTurnId, runtimePaused.id);
  assert.equal(
    runtimeContinued.items.some((item) => item.type === "dynamicToolCall"),
    false,
    "continuation does not dispatch the original command again",
  );
  assert.equal(
    requests.length,
    beforeContinue + 1,
    "continuation submits once and does not replay the tool",
  );
  assert.ok(
    requests
      .at(-1)
      .body.messages.some(
        (message) => message.role === "tool" && message.content.includes(commandReceipt.processId),
      ),
    "continuation receives the original command receipt",
  );
  await shot("00-runtime-continued.png");
  checks.push(
    "running Runtime command pause retains its confirmed terminal receipt and manually continues without UNKNOWN or command replay",
  );
  await checkpoint(checks.at(-1));

  await send(pausePrompt);
  await until(
    (s) => s?.turns?.at(-1)?.items?.some((i) => i.type === "agentMessage"),
    "recorded progress",
  );
  await pause();
  const original = (await turns()).at(-1);
  assert.equal(original.interruption, "userPause");
  await shot("01-paused.png");
  const beforeRestart = requests.length;
  await closeGeneration("paused-generation");
  await launch();
  await reconnectCore();
  await selectConversation(page, threadId);
  await page.getByRole("button", { name: "继续执行", exact: true }).waitFor();
  assert.equal(requests.length, beforeRestart, "restart must not submit to model");
  await page.getByRole("button", { name: "继续执行", exact: true }).click();
  const resumeReply = await waitFor(
    () =>
      commands.find(
        (command) =>
          command.name === "continue" &&
          command.request.expectedTurnId === original.id &&
          command.reply,
      )?.reply,
    "Host replies to the original resumed Turn",
  );
  assert.ok(resumeReply.turnId, JSON.stringify(resumeReply));
  await until(
    (s) => s?.turns?.at(-1)?.id === resumeReply.turnId && s.turns.at(-1).status === "completed",
    "continue complete",
  );
  const continued = (await turns()).at(-1);
  assert.equal(continued.continuedFromTurnId, original.id);
  assert.notEqual(continued.id, original.id);
  assert.ok(JSON.stringify(requests.at(-1).body).includes(pausePrompt));
  assert.ok(JSON.stringify(requests.at(-1).body).includes("CONFIRMED_PROGRESS_"));
  assert.equal((await readThread()).goals?.goal ?? null, null);
  await shot("02-continued.png");
  checks.push(
    "pause/play creates one new Turn in the same Thread after restart, preserving history and confirmed progress without an automatic Goal",
  );
  await checkpoint(checks.at(-1));
  assert.equal(
    await page.getByRole("button", { name: "继续执行", exact: true }).count(),
    0,
    "completed ordinary turn has no continue",
  );

  await send(`HOLD_${marker} changed requirements next`);
  await pause();
  await input().fill(`PLAIN_${marker}`);
  assert.equal(await page.getByRole("button", { name: "继续执行", exact: true }).count(), 0);
  await page.getByTestId("chat-send-button").click();
  await until((s) => s?.turns?.at(-1)?.status === "completed", "plain message complete");
  const plain = requests
    .at(-1)
    .body.messages.findLast(
      (m) =>
        m.role === "user" &&
        !String(m.content).startsWith("AReaL runtime context (not a user request):"),
    );
  assert.equal(plain.content, `PLAIN_${marker}`);
  checks.push("nonempty paused composer sends the literal new user message");
  await checkpoint(checks.at(-1));

  const screenshot = await page.screenshot({
    path: join(scratch, "02-attachment-source.png"),
    animations: "disabled",
  });
  const png = screenshot.toString("base64");
  const resource = {
    name: `SOURCE_REF_${marker}`,
    type: "resource_link",
    uri: "https://example.invalid/source",
  };
  await page.locator('input[type="file"]').last().setInputFiles({
    name: "original-resource.png",
    mimeType: "image/png",
    buffer: screenshot,
  });
  await page.locator(".composer-image-card").waitFor();
  await send(`ATTACHMENT_UPLOAD_${marker}`);
  const uploadedMessage = (await turns()).at(-1).items.find((item) => item.type === "userMessage");
  const originalImage = uploadedMessage.content.find((part) => part.type === "image")?.url;
  assert.match(originalImage, /^areal:\/\/blob\//);

  // 旧消息仍可能包含 MCP 附件。用 Core 构造该历史记录，再通过界面编辑。
  const thread = await readThread();
  const seed = await rpc("areal/turn/start", {
    threadId,
    requestId: randomUUID(),
    expectedConfigRevision: thread.desktop.configuration.revision,
    input: [
      { type: "text", text: `RESOURCE_PROMPT_${marker}` },
      { type: "image", url: originalImage },
      { type: "text", text: JSON.stringify(resource), mcpContent: resource },
    ],
  });
  assert.ok(seed.result?.turn?.id, JSON.stringify(seed));
  await until(
    (current) =>
      current.turns.at(-1)?.id === seed.result.turn.id &&
      current.turns.at(-1)?.status === "completed",
    "legacy resource message completed",
  );
  const originalUserMessage = (await turns())
    .at(-1)
    .items.find((item) => item.type === "userMessage");
  assert.deepEqual(
    originalUserMessage.content.find((part) => part.mcpContent)?.mcpContent,
    resource,
  );
  await input().fill(mainDraft);
  await page
    .locator('input[type="file"]')
    .last()
    .setInputFiles({
      name: "main-unsent.png",
      mimeType: "image/png",
      buffer: Buffer.from(png, "base64"),
    });
  const pastedText = `\n\nComposer reference acceptance ${marker}\n${"Complete pasted text is retained. ".repeat(16)}\nPASTED_END_${marker}`;
  await input().evaluate((element, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
    );
  }, pastedText);
  await page.locator(`[aria-description="Composer reference acceptance ${marker}"]`).waitFor();
  const reviewLines = [1, 2, 3].map((line) => `attached review evidence ${line} ${marker}`);
  await writeFile(
    join(workspace, "evidence.txt"),
    `continue acceptance workspace\n${reviewLines.join("\n")}\n`,
  );
  const review = await command("workspace", { operation: "review", scope: "unstaged" });
  assert.ok(
    review.result?.token &&
      review.result.root === workspace &&
      review.result.head &&
      typeof review.result.base === "string",
    JSON.stringify(review),
  );
  assert.ok(
    review.result.diff.includes(reviewLines[2]),
    "review version includes the exact added fixture lines",
  );
  const reviewKey = `areal-gui:review-comments:${projectId}:${threadId}`;
  const comments = reviewLines.map((snippet, index) => ({
    id: randomUUID(),
    path: "evidence.txt",
    root: review.result.root,
    scope: "unstaged",
    ref: "",
    token: review.result.token,
    head: review.result.head,
    base: review.result.base,
    side: "additions",
    start: index + 2,
    end: index + 2,
    snippet,
    body: `Seeded local review draft ${index + 1} ${marker}`,
  }));
  const retainedReview = JSON.stringify({
    comments,
    attachedIds: comments.map((comment) => comment.id),
  });
  run.reviewCommentFixture = {
    boundary:
      "seeded local review draft using the authoritative unstaged review version; does not prove comment collection",
    comments,
  };
  await saveRun();
  await page.evaluate(
    ({ reviewKey, retainedReview }) => {
      localStorage.setItem(reviewKey, retainedReview);
      window.dispatchEvent(new CustomEvent("areal-review-comments-change", { detail: reviewKey }));
    },
    { reviewKey, retainedReview },
  );
  await page.getByRole("button", { name: "3 个评论", exact: true }).waitFor();
  const compacted = await rpc("areal/context/compact", { threadId });
  assert.ok(
    compacted.result?.checkpoint,
    `real compaction precedes editing: ${JSON.stringify(compacted)}`,
  );
  await page.getByRole("button", { name: "编辑消息", exact: true }).click();
  const edit = page.getByRole("region", { name: "编辑用户消息", exact: true });
  await edit.getByRole("textbox").fill(`CANCELLED_${marker}`);
  await edit.getByRole("textbox").press("Escape");
  await edit.waitFor({ state: "hidden" });
  assert.equal(await input().innerText(), mainDraft, "Escape preserves the main draft");
  await page.getByRole("button", { name: "编辑消息", exact: true }).click();
  await edit.getByRole("textbox").fill(`CANCELLED_${marker}`);
  assert.equal(await edit.getByRole("button", { name: "取消", exact: true }).innerText(), "取消");
  assert.equal(await edit.getByRole("button", { name: "发送", exact: true }).innerText(), "发送");
  await edit.getByRole("button", { name: "取消", exact: true }).click();
  const beforeEdit = (await turns()).map((t) => t.id);
  const replaced = (await turns()).at(-1);
  const editRequests = requests.length;
  assert.equal(await input().innerText(), mainDraft);
  assert.equal(requests.length, editRequests);
  await page.getByRole("button", { name: "编辑消息", exact: true }).click();
  await edit.getByRole("textbox").fill(`REVISED_${marker}`);
  const focusEvidence = await edit.getByRole("textbox").evaluate((element) => {
    const style = getComputedStyle(element);
    const rect = (node) => {
      const { x, y, width, height, bottom, right } = node.getBoundingClientRect();
      return { x, y, width, height, bottom, right };
    };
    const region = element.closest(".user-prompt-edit");
    return {
      focused: document.activeElement === element,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineColor: style.outlineColor,
      panel: rect(region.querySelector(".composer-surface")),
      messageColumn: rect(region.closest(".message-column")),
      userBubbleVisible:
        getComputedStyle(region.closest(".user-message-content").querySelector(".user-bubble"))
          .display !== "none",
    };
  });
  await writeFile(join(scratch, "focused-editor.json"), JSON.stringify(focusEvidence, null, 2));
  assert.equal(focusEvidence.focused, true);
  assert.equal(focusEvidence.outlineStyle, "none", "the editor has no clipped inner focus outline");
  assert.ok(
    focusEvidence.panel.width >= focusEvidence.messageColumn.width - 36,
    "inline edit spans the message column",
  );
  assert.equal(
    focusEvidence.userBubbleVisible,
    false,
    "the original bubble does not duplicate the open editor",
  );
  await edit.getByRole("textbox").press("Tab");
  assert.equal(
    await edit
      .getByRole("button", { name: "取消", exact: true })
      .evaluate((element) => document.activeElement === element),
    true,
    "keyboard reaches visible Cancel",
  );
  await page.emulateMedia({ forcedColors: "active" });
  await edit.getByRole("textbox").focus();
  const forcedFocus = await edit.getByRole("textbox").evaluate((element) => {
    const shell = getComputedStyle(element.closest(".composer-surface"));
    return {
      style: shell.outlineStyle,
      width: shell.outlineWidth,
      innerStyle: getComputedStyle(element).outlineStyle,
    };
  });
  assert.equal(
    forcedFocus.innerStyle,
    "none",
    "forced colors keeps the editor free of clipped inner outlines",
  );
  assert.equal(forcedFocus.style, "solid", "forced colors retains a visible shell focus indicator");
  assert.notEqual(forcedFocus.width, "0px");
  await page.emulateMedia({ forcedColors: "none" });
  const originalTheme = await page.evaluate(() => window.arealDesktop.theme());
  const layoutEvidence = [];
  for (const colorScheme of ["light", "dark"]) {
    await page.evaluate(
      (theme) => window.arealDesktop.theme(theme),
      colorScheme === "dark" ? "data-dense" : "soft-glass",
    );
    await app.evaluate(({ nativeTheme }) => nativeTheme.emit("updated"));
    await page.waitForFunction(
      (dark) => document.documentElement.classList.contains("dark") === dark,
      colorScheme === "dark",
    );
    const layout = await page.locator(".composer-dock").evaluate((dock) => {
      const rect = (selector) => {
        const { x, y, width, height, bottom, right } = dock
          .querySelector(selector)
          .getBoundingClientRect();
        return { x, y, width, height, bottom, right };
      };
      const image = dock.querySelector(".composer-image-card img");
      return {
        image: rect(".composer-image-card"),
        comments: rect(".review-comment-attachment"),
        text: rect(".composer-text-card:has(.composer-text-copy > button)"),
        imageLoaded: image.complete && image.naturalWidth > 100,
        textPreview: dock.querySelector(".composer-text-copy > span").textContent,
        row: rect(".composer-attachment-row"),
      };
    });
    assert.equal(layout.imageLoaded, true, "the attached screenshot renders actual GUI pixels");
    assert.equal(
      layout.textPreview,
      `Composer reference acceptance ${marker}`,
      "pasted text shows the first nonempty line",
    );
    // Keep layout failures visible while exercising the original edit and its receipt.
    if (!(layout.image.x < layout.comments.x && layout.comments.x < layout.text.x))
      layoutFailures.push(`${colorScheme}: expected image, comments and text in that order`);
    if (
      Math.abs(layout.image.y - layout.comments.y) > 1 ||
      Math.abs(layout.image.y - layout.text.y) > 1
    )
      layoutFailures.push(`${colorScheme}: wide attachment row should align card tops`);
    await shot(`02-editing-${colorScheme}-wide.png`);
    layoutEvidence.push({ colorScheme, viewport: "wide", ...layout });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(860, 960));
    const narrow = await page.locator(".composer-attachment-row").evaluate((row) => {
      const { width, height } = row.getBoundingClientRect();
      const style = getComputedStyle(row);
      return {
        width,
        height,
        scrollWidth: row.scrollWidth,
        clientWidth: row.clientWidth,
        flexWrap: style.flexWrap,
        padding: parseFloat(style.paddingLeft) + parseFloat(style.paddingRight),
        gap: parseFloat(style.columnGap),
        children: [
          ...row.querySelectorAll(
            ".composer-image-card, .review-comment-attachment, .composer-text-card",
          ),
        ].map((element) => {
          const { x, y, width, bottom, right } = element.getBoundingClientRect();
          return { x, y, width, bottom, right };
        }),
      };
    });
    if (narrow.scrollWidth > narrow.clientWidth + 1)
      layoutFailures.push(`${colorScheme}: narrow attachment row overflows horizontally`);
    const inlineWidth =
      narrow.children.reduce((sum, child) => sum + child.width, 0) +
      narrow.padding +
      (narrow.children.length - 1) * narrow.gap;
    if (
      narrow.flexWrap !== "wrap" ||
      (inlineWidth > narrow.clientWidth &&
        !narrow.children.some((child) => child.y > narrow.children[0].bottom))
    )
      layoutFailures.push(`${colorScheme}: attachment row should wrap when cards exceed its width`);
    await shot(`02-editing-${colorScheme}-narrow.png`);
    layoutEvidence.push({ colorScheme, viewport: "narrow", ...narrow });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
  }
  await page.evaluate((theme) => window.arealDesktop.theme(theme), originalTheme.id);
  await app.evaluate(({ nativeTheme }) => nativeTheme.emit("updated"));
  await page.waitForFunction(
    (dark) => document.documentElement.classList.contains("dark") === dark,
    originalTheme.dark,
  );
  await writeFile(join(scratch, "composer-layout.json"), JSON.stringify(layoutEvidence, null, 2));
  await shot("02-editing-prompt.png");
  editLoss = {};
  await edit.getByRole("button", { name: "发送", exact: true }).click();
  await until(
    (s) => s?.turns?.at(-1)?.status === "completed" && s.turns.at(-1).id !== replaced.id,
    "revised prompt complete",
  );
  assert.equal((await turns()).length, beforeEdit.length, "edit replaces the last turn");
  assert.deepEqual(
    (await turns()).slice(0, -1).map((t) => t.id),
    beforeEdit.slice(0, -1),
  );
  const afterEditContext = await rpc("areal/context/read", { threadId, offset: 0, limit: 32 });
  assert.equal(
    afterEditContext.result.checkpoint,
    null,
    "edit clears the summary of replaced history",
  );
  const revisedRequest = requests.at(-1).body;
  assert.ok(
    !JSON.stringify(revisedRequest.messages).includes(`RESOURCE_PROMPT_${marker}`),
    "model context excludes the replaced prompt",
  );
  for (const item of replaced.items.filter((i) => i.type === "agentMessage")) {
    assert.ok(
      !JSON.stringify(revisedRequest.messages).includes(item.text),
      "model context excludes the replaced response",
    );
  }
  const authoritative = await rpc("thread/read", { threadId, includeTurns: true });
  await page.getByText(`REVISED_${marker}`, { exact: true }).waitFor();
  assert.equal(await page.getByText(`RESOURCE_PROMPT_${marker}`, { exact: true }).count(), 0);
  await page
    .locator(
      `[data-turn-id="${authoritative.result.thread.turns.at(-1).id}"][data-turn-status="completed"]`,
    )
    .waitFor();
  assert.equal(await input().innerText(), mainDraft);
  assert.equal(
    (await turns())
      .at(-1)
      .items.find((i) => i.type === "userMessage")
      .content.find((c) => c.type === "text").text,
    `REVISED_${marker}`,
  );
  const revisedContent = (await turns()).at(-1).items.find((i) => i.type === "userMessage").content;
  assert.equal(revisedContent.find((c) => c.type === "image").url, originalImage);
  assert.deepEqual(revisedContent.find((c) => c.mcpContent).mcpContent, resource);
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), reviewKey),
    retainedReview,
    "editing leaves all attached review drafts unchanged",
  );
  assert.equal(await page.locator(".composer-image-card").count(), 1);
  await shot("03-edited-message.png");
  assert.equal(editLoss.failure, undefined);
  assert.equal(editLoss.turnId, authoritative.result.thread.turns.at(-1).id);
  assert.ok(editLoss.requestId, "the accepted response for the original edit was lost");
  const editCommand = commands.find((c) => c.request?.requestId === editLoss.requestId);
  const reconciliation = await fixtureWorkbench(page, "desktop.command", {
    command: "reconcile",
    request: { projectId, requestId: editLoss.requestId },
  });
  assert.equal(reconciliation.outcomes[editLoss.requestId]?.status, "completed");
  const editSubmission = {
    requestId: editCommand.request.requestId,
    threadId,
    expectedConfigRevision: editCommand.request.expectedConfigRevision,
    intent: {
      type: "edit",
      expectedTurnId: editCommand.request.expectedTurnId,
      itemId: editCommand.request.itemId,
      input: authoritative.result.thread.turns.at(-1).items.find((i) => i.type === "userMessage")
        .content,
    },
  };
  const replay = await rpc("areal/turn/submit", editSubmission);
  assert.equal(
    replay.result?.turn.id,
    authoritative.result.thread.turns.at(-1).id,
    "same receipt returns the accepted replacement",
  );
  assert.ok(
    (await rpc("areal/turn/submit", { ...editSubmission, requestId: randomUUID() })).error,
    "stale edit cannot remove a newer turn",
  );
  assert.equal(
    requests.length,
    editRequests + 1,
    "lost reply, receipt read and stale edit cause no repeated model call",
  );
  await page.getByRole("button", { name: "3 个评论", exact: true }).click();
  for (const comment of comments) await page.getByText(comment.body, { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  const screenshotPixels = async (image, base64) => {
    const source = await createImageBitmap(
      new Blob([Uint8Array.from(atob(base64), (value) => value.charCodeAt(0))], {
        type: "image/png",
      }),
    );
    const pixels = async (drawable, width, height) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      context.drawImage(drawable, 0, 0);
      const rgba = context.getImageData(0, 0, width, height).data;
      return [...new Uint8Array(await crypto.subtle.digest("SHA-256", rgba))]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
    };
    try {
      return {
        actual: {
          name: image.alt,
          complete: image.complete,
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight,
          sha256: await pixels(image, image.naturalWidth, image.naturalHeight),
        },
        expected: {
          name: "main-unsent.png",
          complete: true,
          naturalWidth: source.width,
          naturalHeight: source.height,
          sha256: await pixels(source, source.width, source.height),
        },
      };
    } finally {
      source.close();
    }
  };
  const beforeExpansion = await page
    .locator(".composer-image-card img")
    .evaluate(screenshotPixels, png);
  assert.deepEqual(
    beforeExpansion.actual,
    beforeExpansion.expected,
    "the attachment retains the full-resolution screenshot pixels before expansion",
  );
  await page.getByRole("button", { name: "在文本框中显示", exact: false }).click();
  const expandedText = await input().innerText();
  assert.equal(
    expandedText.split(pastedText).length,
    2,
    "expand inserts complete pasted text exactly once",
  );
  assert.equal(
    expandedText.slice(0, -pastedText.length).trimEnd(),
    mainDraft,
    "expand retains the main draft before the text separator",
  );
  assert.ok(
    expandedText.endsWith(pastedText),
    "expand retains every pasted character through its final marker",
  );
  assert.equal(
    await page.locator(`[aria-description="Composer reference acceptance ${marker}"]`).count(),
    0,
    "expanded text card is removed",
  );
  const afterExpansion = await page
    .locator(".composer-image-card img")
    .evaluate(screenshotPixels, png);
  assert.deepEqual(
    afterExpansion.actual,
    afterExpansion.expected,
    "expansion retains the full-resolution screenshot pixels",
  );
  assert.deepEqual(
    afterExpansion.actual,
    beforeExpansion.actual,
    "expansion preserves the loaded screenshot attachment",
  );
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), reviewKey),
    retainedReview,
    "text expansion leaves comments unchanged",
  );
  await page.getByRole("button", { name: "移除附件 main-unsent.png", exact: true }).click();
  assert.equal(await page.locator(".composer-image-card").count(), 0);
  await page.getByRole("button", { name: "移除评论附件", exact: true }).click();
  assert.deepEqual(
    await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), reviewKey),
    { comments, attachedIds: [] },
    "detach keeps the saved review drafts",
  );
  checks.push(
    "edit Cancel preserves history; Send atomically replaces the last prompt/reply in GUI, Core and model context; attachments/drafts survive lost replies; receipts deduplicate and stale edits reject; reload preserves replacement",
  );
  checks.push(
    "inline edit has text actions and keyboard focus; screenshot and pasted text render, expand and detach without disturbing the other draft items",
  );
  if (layoutFailures.length === 0) checks.push("attachment row aligns and wraps in both themes");
  await checkpoint(checks.at(-1));
  await page.reload();
  await until((s) => s?.turns?.at(-1)?.status === "completed", "edited history after reload");
  assert.deepEqual(
    (await turns()).map((t) => t.id),
    authoritative.result.thread.turns.map((t) => t.id),
  );
  assert.equal(
    await page.getByText(`RESOURCE_PROMPT_${marker}`, { exact: true }).count(),
    0,
    "replaced prompt stays absent after reload",
  );
  await input().fill("");

  await send(`HOLD_${marker} steer base`);
  const steerBase = (await turns()).at(-1);
  const steerText = `HOLD_STEER_${marker}`;
  assert.ok(
    (
      await rpc("turn/steer", {
        requestId: randomUUID(),
        threadId,
        expectedTurnId: steerBase.id,
        input: [{ type: "text", text: steerText }],
      })
    ).result !== undefined,
  );
  await until(
    (s) =>
      s.turns
        .at(-1)
        .items.some((i) => i.type === "userMessage" && i.content.some((c) => c.text === steerText)),
    "steer accepted",
  );
  await pause();
  await page.getByRole("button", { name: "继续执行", exact: true }).click();
  await until(
    (s) =>
      s.turns.at(-1).status === "completed" && s.turns.at(-1).continuedFromTurnId === steerBase.id,
    "steer continuation",
  );
  const beforeSteerEdit = await turns();
  // 拒绝提交前后比较同一 Core 权威记录；GUI 投影会省略较早轮次的配置与指令字段。
  const authoritativeBeforeSteerEdit = (await rpc("thread/read", { threadId, includeTurns: true }))
    .result.thread.turns;
  const steeredTurn = beforeSteerEdit.find((t) => t.id === steerBase.id);
  const steeredIndex = steeredTurn.items.findIndex(
    (i) => i.type === "userMessage" && i.content.some((c) => c.text === steerText),
  );
  const steeredItem = steeredTurn.items[steeredIndex];
  const invalidEdit = {
    requestId: randomUUID(),
    threadId,
    expectedConfigRevision: editSubmission.expectedConfigRevision,
    intent: {
      type: "edit",
      expectedTurnId: beforeSteerEdit.at(-1).id,
      itemId: steeredItem.id,
      input: [],
    },
  };
  assert.ok(
    (await rpc("areal/turn/submit", invalidEdit)).error,
    "empty revision rejects after validating the target",
  );
  assert.deepEqual(
    (await rpc("thread/read", { threadId, includeTurns: true })).result.thread.turns,
    authoritativeBeforeSteerEdit,
    "rejected edit leaves all history intact",
  );
  await page.getByRole("button", { name: "编辑消息", exact: true }).click();
  await edit.getByRole("textbox").fill(`REVISED_STEER_${marker}`);
  await edit.getByRole("button", { name: "发送", exact: true }).click();
  await until(
    (s) => s.turns.at(-1).status === "completed" && s.turns.at(-1).id !== beforeSteerEdit.at(-1).id,
    "steered edit complete",
  );
  const afterSteerEdit = await turns();
  assert.deepEqual(
    afterSteerEdit.find((t) => t.id === steerBase.id).items,
    steeredTurn.items.slice(0, steeredIndex),
    "items preceding the edited steer remain",
  );
  assert.ok(
    !afterSteerEdit.some((t) => t.id === beforeSteerEdit.at(-1).id),
    "continuation after the edited input is removed",
  );
  assert.ok(
    JSON.stringify(requests.at(-1).body.messages).includes(`HOLD_${marker} steer base`),
    "earlier user requirement stays in model context",
  );
  assert.ok(
    !JSON.stringify(requests.at(-1).body.messages).includes(steerText),
    "old steer is absent from model context",
  );
  checks.push(
    "editing a steered input preserves earlier same-turn items, removes later continuation, and rejects invalid revisions without changing history",
  );
  await checkpoint(checks.at(-1));

  await send(`HOLD_${marker} queue base`);
  const editAttempt = () => ({
    requestId: randomUUID(),
    threadId,
    expectedConfigRevision: editSubmission.expectedConfigRevision,
    intent: {
      type: "edit",
      expectedTurnId: threadId,
      itemId: "stale",
      input: [{ type: "text", text: "must reject" }],
    },
  });
  const activeEdit = editAttempt();
  activeEdit.intent.expectedTurnId = (await turns()).at(-1).id;
  activeEdit.intent.itemId = (await turns()).at(-1).items.find((i) => i.type === "userMessage").id;
  assert.ok((await rpc("areal/turn/submit", activeEdit)).error, "active turn cannot be edited");
  for (const text of [`QUEUE_FIRST_${marker}`, `QUEUE_SECOND_${marker}`]) {
    await input().fill(text);
    await page.getByTestId("chat-send-button").click();
    await waitFor(
      async () =>
        (await rpc("areal/queue/list", { threadId }, false)).result?.items?.some(
          (i) => i.input?.some((c) => c.text === text) && i.status === "pending",
        ),
      "pending input",
    );
  }
  await pause();
  const anchor = (await turns()).at(-1).id;
  assert.ok(
    (await rpc("areal/turn/submit", { ...activeEdit, requestId: randomUUID() })).error,
    "retained pending queue blocks editing",
  );
  const queueStart = requests.length;
  const requestId = randomUUID();
  const submit = {
    requestId,
    threadId,
    expectedConfigRevision: (await readThread()).desktop.configuration.revision,
    intent: { type: "continue", expectedTurnId: anchor },
  };
  const first = await rpc("areal/turn/submit", submit);
  assert.ok(!first.error, JSON.stringify(first));
  const duplicate = await rpc("areal/turn/submit", submit);
  assert.deepEqual(duplicate, first);
  await until(
    (s) => s?.turns?.at(-1)?.status === "completed" && requests.length >= queueStart + 2,
    "FIFO queue complete",
  );
  const delivered = requests
    .slice(queueStart)
    .map(
      (r) =>
        r.body.messages.findLast(
          (m) =>
            m.role === "user" &&
            !String(m.content).startsWith("AReaL runtime context (not a user request):"),
        ).content,
    );
  assert.deepEqual(delivered, [`QUEUE_FIRST_${marker}`, `QUEUE_SECOND_${marker}`]);
  assert.ok(
    (await rpc("areal/turn/submit", { ...submit, requestId: randomUUID() })).error,
    "stale anchor rejected",
  );
  assert.ok(
    (
      await rpc("areal/turn/submit", {
        ...submit,
        intent: { type: "continue", expectedTurnId: "different-anchor" },
      })
    ).error,
    "same key changed params rejected",
  );
  checks.push(
    "pending FIFO precedes continuation; duplicate receipt is stable and stale/same-key-changed requests are rejected",
  );
  await checkpoint(checks.at(-1));

  await send(`HOLD_${marker} recovery`);
  const interruptedId = (await turns()).at(-1).id;
  const coreData = await closeGeneration("interrupted-generation");
  assert.ok(coreData?.startsWith(`${env.AREAL_CORE_HOME}/`), "the original Core data is isolated");
  const recordPath = join(coreData, `${threadId}.json`);
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  const recovery = record.thread.turns.find((t) => t.id === interruptedId);
  recovery.status = "inProgress";
  delete recovery.interruption;
  await writeFile(recordPath, JSON.stringify(record));
  await checkpoint("stopped-Core recovery fixture written");
  await launch();
  await reconnectCore();
  await selectConversation(page, threadId);
  await until((s) => s?.turns?.at(-1)?.interruption === "coreRecovery", "Core recovery fact");
  const recoveryRequests = requests.length;
  await page.getByRole("button", { name: "继续执行", exact: true }).waitFor();
  assert.equal(requests.length, recoveryRequests);
  await closeGeneration("recovered-generation");
  const unknownRecord = JSON.parse(await readFile(recordPath, "utf8"));
  // 此处注入 Runtime 调用的旧 UNKNOWN。直连 Core 的断言使用不需要浏览器工具主人的会话。
  assert.deepEqual(
    unknownRecord.thread.dynamicTools.map((tool) => tool.name),
    ["browser_v1"],
  );
  unknownRecord.thread.dynamicTools = [];
  const unknownTurn = unknownRecord.thread.turns.at(-1);
  unknownTurn.status = "failed";
  delete unknownTurn.interruption;
  unknownTurn.error = {
    message: "recovered an UNKNOWN tool outcome; inspection is required",
    outcome: {
      code: "HARNESS_INTERNAL_ERROR",
      class: "infrastructure",
      source: "core_recovery",
      details: { reason: "unknown_tool_outcome" },
    },
  };
  const unknownItem = {
    type: "dynamicToolCall",
    id: randomUUID(),
    tool: "run_command",
    callId: randomUUID(),
    arguments: {},
    status: "failed",
    success: false,
    contentItems: [],
    execution: {
      runtimeEpoch: "fixture",
      scopeId: "fixture",
      operationId: "fixture",
      outcome: "unknown",
      hooks: [],
    },
  };
  unknownTurn.items.push(unknownItem);
  run.unknownFixture = {
    threadId,
    turnId: unknownTurn.id,
    itemId: unknownItem.id,
    callId: unknownItem.callId,
  };
  await saveRun();
  await writeFile(recordPath, JSON.stringify(unknownRecord));
  await checkpoint("stopped-Core legacy UNKNOWN fixture written");
  await launch();
  await reconnectCore();
  await selectConversation(page, threadId);
  const blocked = await rpc("areal/turn/submit", {
    requestId: randomUUID(),
    threadId,
    expectedConfigRevision: (await readThread()).desktop.configuration.revision,
    intent: { type: "continue", expectedTurnId: interruptedId },
  });
  assert.ok(blocked.error?.includes("UNKNOWN"), JSON.stringify(blocked));
  const unknownEdit = editAttempt();
  unknownEdit.intent.expectedTurnId = interruptedId;
  unknownEdit.intent.itemId = unknownTurn.items.find((i) => i.type === "userMessage").id;
  assert.ok(
    (await rpc("areal/turn/submit", unknownEdit)).error?.includes("UNKNOWN"),
    "editing cannot erase an uninspected UNKNOWN",
  );
  assert.equal(requests.length, recoveryRequests);
  checks.push(
    "Core recovery is manual; legacy Failed recovery without interruption refuses uninspected UNKNOWN continuation without a model request",
  );
  await checkpoint(checks.at(-1));
  const beforeInspection = await rpc("thread/read", { threadId, includeTurns: true });
  assert.ok(beforeInspection.result, JSON.stringify(beforeInspection));
  const legacyRecovery = beforeInspection.result.thread.turns.at(-1);
  assert.equal(legacyRecovery.id, interruptedId);
  assert.equal(legacyRecovery.status, "failed");
  assert.equal(
    Object.hasOwn(legacyRecovery, "interruption"),
    false,
    "legacy recovery has no interruption field",
  );
  assert.deepEqual(
    legacyRecovery.error,
    unknownTurn.error,
    "legacy recovery retains the authoritative error shape",
  );
  const uninspected = beforeInspection.result.thread.turns
    .flatMap((turn) => turn.items)
    .filter(
      (item) =>
        item.type === "dynamicToolCall" &&
        !item.execution.inspection &&
        (item.execution.outcome === "unknown" ||
          item.execution.hooks?.some((hook) => hook.outcome === "unknown") ||
          item.execution.plugin?.operations?.some((operation) => operation.outcome === "unknown")),
    );
  assert.equal(uninspected.length, 1, "only the injected fixture is uninspected");
  assert.deepEqual(
    {
      ...uninspected[0],
      execution: { ...uninspected[0].execution, hooks: uninspected[0].execution.hooks ?? [] },
    },
    unknownItem,
    "UNKNOWN matches the exact undispatched fixture",
  );
  const inspection =
    "Inspected synthetic acceptance fixture. This record was injected after the isolated Core stopped. No Runtime or external operation was dispatched. Preserve UNKNOWN history; cleanup may proceed.";
  // 使用用户实际入口记录核对，并让 Desktop 同步 Core 的权威结果。
  await page.getByRole("button", { name: "核对后继续", exact: true }).click();
  const inspectionDialog = page.getByRole("dialog", { name: "核查工具结果 UNKNOWN", exact: true });
  await inspectionDialog.getByLabel("核查说明", { exact: true }).fill(inspection);
  await inspectionDialog
    .getByRole("checkbox", { name: "已核查实际文件或进程", exact: true })
    .check();
  await inspectionDialog.getByRole("button", { name: "确认已核查", exact: true }).click();
  await inspectionDialog.waitFor({ state: "hidden" });
  const inspected = await rpc("thread/read", { threadId, includeTurns: true });
  const inspectedItem = inspected.result?.thread.turns
    .flatMap((turn) => turn.items)
    .find((item) => item.id === unknownItem.id);
  assert.equal(inspectedItem?.execution.outcome, "unknown");
  assert.equal(inspectedItem.execution.inspection, inspection);
  run.unknownFixture.inspection = inspection;
  await saveRun();
  assert.equal(requests.length, recoveryRequests, "inspection does not submit to the model");
  await page.getByRole("button", { name: "继续执行", exact: true }).waitFor();
  await shot("04-legacy-recovery-inspected.png");
  await page.getByRole("button", { name: "继续执行", exact: true }).click();
  await until(
    (s) =>
      s?.turns?.at(-1)?.continuedFromTurnId === interruptedId &&
      s.turns.at(-1).status === "completed",
    "inspected legacy recovery continuation",
  );
  assert.equal(await page.getByTestId("areal-workbench").getAttribute("data-thread-id"), threadId);
  assert.equal(
    requests.length,
    recoveryRequests + 1,
    "manual legacy continuation submits exactly once",
  );
  const afterLegacyContinuation = await rpc("thread/read", { threadId, includeTurns: true });
  const finalTurns = afterLegacyContinuation.result?.thread.turns;
  assert.equal(finalTurns?.length, beforeInspection.result.thread.turns.length + 1);
  assert.notEqual(finalTurns.at(-1).id, interruptedId);
  assert.equal(finalTurns.at(-1).continuedFromTurnId, interruptedId);
  const preservedRecovery = finalTurns.find((turn) => turn.id === interruptedId);
  assert.equal(preservedRecovery.status, "failed");
  assert.equal(Object.hasOwn(preservedRecovery, "interruption"), false);
  assert.deepEqual(preservedRecovery.error, unknownTurn.error);
  assert.deepEqual(
    preservedRecovery.items.find((item) => item.id === unknownItem.id),
    inspectedItem,
    "continued legacy recovery preserves the inspected UNKNOWN history",
  );
  await shot("05-legacy-recovery-continued.png");
  checks.push(
    "after exact synthetic UNKNOWN inspection and public acknowledgement, UI play continues legacy Failed recovery in the same Thread and preserves UNKNOWN history",
  );
  await checkpoint(checks.at(-1));
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(layoutFailures, [], "attachment row layout");
  passed = true;
} catch (error) {
  failure = error.stack || String(error);
  console.error(error);
  process.exitCode = 1;
  if (page) await captureSmokeFailure(page, scratch, error);
} finally {
  const guiPid = app?.process().pid;
  let originalHost;
  try {
    originalHost = await readFixtureHost(env);
  } catch (error) {
    passed = false;
    failure ||= error.stack || String(error);
  }
  await checkpoint("capture final evidence and clean up owned services");
  if (app) {
    await writeFile(
      join(scratch, "final-snapshot.json"),
      JSON.stringify(await snapshot().catch(() => null), null, 2),
    );
    await closeSmokeApplication(app).catch((error) => {
      passed = false;
      failure ||= error.stack || String(error);
    });
  }
  try {
    cleanupResult = await cleanup(originalHost, guiPid);
  } catch (error) {
    cleanupResult = { passed: false, errors: [error.stack || String(error)] };
  }
  if (!cleanupResult.passed) {
    passed = false;
    failure ||= `Cleanup failed: ${cleanupResult.errors.join("; ")}`;
    process.exitCode = 1;
  }
  await writeFile(join(scratch, "cleanup.json"), JSON.stringify(cleanupResult, null, 2));
  for (const response of held) response.destroy();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (!passed) process.exitCode = 1;
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed,
        failure,
        checks,
        layoutFailures,
        requests,
        commands,
        pageErrors,
        stderr,
        run,
        cleanup: cleanupResult,
        sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: root,
          encoding: "utf8",
        }).trim(),
        binary,
        binarySha256: createHash("sha256")
          .update(await readFile(binary))
          .digest("hex"),
        sourceDiffSha256: createHash("sha256")
          .update(execFileSync("git", ["diff", "HEAD"], { cwd: root }))
          .digest("hex"),
        evidenceBoundary:
          "real source Electron/Core and local SSE model; recovery/UNKNOWN records injected after isolated service stop; no physical reboot, provider or installed-package claim",
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed, scratch, checks, failure }));
}
