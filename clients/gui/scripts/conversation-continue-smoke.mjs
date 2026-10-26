import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
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
const { ServiceConnection, waitForServiceProcessExit } = require(
  join(sourceDesktop, "src/core/service-client.cjs"),
);
const { DesktopLifecycle } = require(join(sourceDesktop, "src/core/lifecycle.cjs"));
const binary = process.env.AREAL_CORE_BIN || join(root, "target/debug/areal");
await mkdir(join(root, ".scratch/gui-evidence"), { recursive: true });
const scratch = await mkdtemp(join(root, ".scratch/gui-evidence/conversation-continue-"));
const desktop = join(scratch, "application/app");
const renderer = join(scratch, "application/renderer/dist");
const registry = await makeTempDir("continue-svc-");
const workspace = join(scratch, "workspace");
const projectId = createHash("sha256").update(workspace).digest("hex").slice(0, 24);
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
const env = {
  ...process.env,
  AREAL_GUI: "workbench",
  AREAL_BACKEND: "areal",
  AREAL_CORE_BIN: binary,
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: join(scratch, "user-home"),
  AREAL_HARNESS_SERVICE_HOME: registry,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_CORE_WORKSPACE: workspace,
};
delete env.AREAL_HARNESS_HOME;
const run = {
  evidence: scratch,
  workspace,
  registry,
  desktopHome: env.AREAL_CORE_HOME,
  binary,
  coreServices: [],
  desktopServices: [],
};
const saveRun = () => writeFile(join(scratch, "run.json"), JSON.stringify(run, null, 2));
await saveRun();
const requests = [],
  checks = [],
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
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    const value = await snapshot();
    if (await predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error(`Timed out waiting for ${label}`);
}
const thread = (s) => s.projects.find((p) => p.id === projectId)?.state?.threads?.[threadId];
const turns = async () => thread(await snapshot()).turns;
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
  await desktopMetadata();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
  await app.evaluate(
    ({ app, dialog }, path) => {
      // 本夹具验证暂停与重启后的会话，退出确认由独立场景覆盖。
      dialog.showMessageBox = async () => ({ response: 1 });
      const read = process
        .getBuiltinModule("module")
        .createRequire(app.getAppPath() + "/package.json");
      const { ServiceConnection } = read(path);
      const original = ServiceConnection.prototype.request;
      globalThis.__continueCommands = [];
      ServiceConnection.prototype.request = async function (method, parameters, mutation) {
        globalThis.__continueConnection = this;
        if (method === "command") globalThis.__continueCommands.push(structuredClone(parameters));
        const result = await original.call(this, method, parameters, mutation);
        if (
          method === "command" &&
          parameters.name === "editMessage" &&
          globalThis.__continueLoseNext
        ) {
          globalThis.__continueLoseNext = false;
          throw Object.assign(new Error("fixture: committed GUI response lost"), {
            submissionUnknown: true,
          });
        }
        return result;
      };
    },
    join(desktop, "src/core/service-client.cjs"),
  );
}
async function command(name, request) {
  commands.push({ name, request });
  return app.evaluate(
    async (_, { name, request }) => {
      try {
        return {
          result: await globalThis.__continueConnection.request("command", { name, request }, true),
        };
      } catch (error) {
        return {
          error: error.message,
          code: error.code,
          submissionUnknown: error.submissionUnknown,
        };
      }
    },
    { name, request: { projectId, threadId, ...request } },
  );
}
async function reconnectCore() {
  // stopService is an explicit stop; reopening alone need not restart it.
  const result = await page.evaluate(
    (projectId) => window.arealDesktop.command("connect", { projectId }),
    projectId,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
}
async function rpc(method, params) {
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
  commands.push({ method, params });
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
      thread(s)?.turns?.length > before &&
      requests.length > beforeRequests &&
      thread(s).turns.at(-1).status === (text.startsWith("HOLD_") ? "inProgress" : "completed"),
    `send ${text}`,
  );
}
async function pause() {
  await page.getByRole("button", { name: "暂停执行", exact: true }).click();
  await until((s) => thread(s)?.turns?.at(-1)?.status === "interrupted", "pause settled");
  await page.getByRole("button", { name: "继续执行", exact: true }).waitFor();
}
async function stopService() {
  rpcClient?.close();
  rpcClient = null;
  const instances = await coreInstances();
  for (const item of instances) {
    if (item.state !== "stopped")
      execFileSync(
        binary,
        [
          "service",
          "stop",
          "--instance",
          item.serviceId,
          "--expected-generation",
          item.generation,
          "--cancel",
          "--json",
        ],
        { env, timeout: 60000, stdio: "pipe" },
      );
    for (const pid of new Set([item.hostPid, item.corePid])) {
      assert.ok(Number.isSafeInteger(pid) && pid > 1, "owned Core process identity is complete");
      const deadline = Date.now() + 15000;
      for (;;) {
        try {
          process.kill(pid, 0);
        } catch (error) {
          if (error.code === "ESRCH") break;
          throw error;
        }
        assert.ok(Date.now() < deadline, `owned Core process ${pid} exited`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
  const remaining = await coreInstances();
  assert.ok(
    remaining.every((item) => item.state === "stopped"),
    "all owned Core services stopped",
  );
  return remaining;
}
async function coreInstances() {
  const instances = JSON.parse(
    execFileSync(binary, ["service", "list", "--json"], { env, encoding: "utf8", timeout: 30000 }),
  );
  for (const item of instances) {
    assert.equal(item.workspace, workspace, "private registry contains only this workspace");
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
async function desktopMetadata() {
  const metadataPath = join(run.desktopHome, "service.json");
  let metadata;
  try {
    metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const { protocol, identity, endpoint, pid } = metadata;
  if (
    !run.desktopServices.some((service) => service.identity === identity && service.pid === pid)
  ) {
    run.desktopServices.push({ metadataPath, protocol, identity, endpoint, pid });
    await saveRun();
  }
  return metadata;
}
async function cleanup() {
  const result = { passed: false, coreStopped: false, desktopExited: false, errors: [] };
  const metadata = await desktopMetadata();
  await coreInstances();
  if (metadata) {
    const connection = new ServiceConnection();
    try {
      await connection.connect(metadata);
      await connection.request("hello", {
        protocol: metadata.protocol,
        identity: metadata.identity,
      });
      const lifecycle = new DesktopLifecycle({
        connection,
        metadata,
        home: run.desktopHome,
        notify: async () => ({ response: 1 }),
      });
      const observed = await lifecycle.observe();
      assert.ok(
        observed.projects.every((project) => project.root === workspace),
        "desktop backend owns only this workspace",
      );
      await lifecycle.stop({ mode: "cancel", observed });
      await waitForServiceProcessExit(run.desktopHome, metadata);
      result.desktopExited = true;
    } catch (error) {
      result.errors.push(`Desktop: ${error.message}`);
    } finally {
      connection.close();
    }
  } else result.desktopExited = true;
  try {
    result.coreServices = await stopService();
    result.coreStopped = true;
  } catch (error) {
    result.errors.push(`Core: ${error.message}`);
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
  await mkdir(env.AREAL_CORE_HOME, { recursive: true });
  await writeFile(
    join(env.AREAL_CORE_HOME, "projects.json"),
    JSON.stringify([{ id: projectId, root: workspace }]),
  );
  await checkpoint("isolated existing project fixture ready");
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
  await until(
    (s) => s.projects.find((project) => project.id === projectId)?.state?.connected,
    "project connected",
  );
  assert.deepEqual(
    (await snapshot()).projects.map((project) => project.root),
    [workspace],
    "only the isolated fixture workspace is registered",
  );
  const modelReady = await until(
    (s) => s.projects.find((p) => p.id === projectId)?.models?.some((model) => model.isDefault),
    "configured default model",
  );
  const defaultModel = modelReady.projects
    .find((p) => p.id === projectId)
    .models.find((model) => model.isDefault);
  assert.deepEqual(
    {
      providerId: defaultModel.providerId,
      modelId: defaultModel.modelId,
      available: defaultModel.available,
    },
    { providerId: "fixture", modelId: "fixture", available: true },
    "configured fixture is the available default model",
  );
  await checkpoint("pause a running Runtime command");
  await input().fill(`RUNTIME_PAUSE_${marker}`);
  await page.getByTestId("chat-send-button").click();
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid="areal-workbench"]')?.dataset.threadId,
  );
  threadId = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
  await until(async () => {
    try {
      return (await readFile(join(workspace, "pause-started.txt"), "utf8")) === "started";
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }, "Runtime command actually started");
  await page.getByRole("button", { name: "暂停执行", exact: true }).click();
  await until((s) => thread(s)?.turns?.at(-1)?.status !== "inProgress", "Runtime pause settled");
  const runtimePaused = (await turns()).at(-1);
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
    (s) => thread(s)?.turns?.at(-1)?.status === "completed",
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
    (s) =>
      thread(s)
        ?.turns?.at(-1)
        ?.items?.some((i) => i.type === "agentMessage"),
    "recorded progress",
  );
  await pause();
  const original = (await turns()).at(-1);
  assert.equal(original.interruption, "userPause");
  await shot("01-paused.png");
  const beforeRestart = requests.length;
  commands.push(...(await app.evaluate(() => globalThis.__continueCommands)));
  await app.close();
  app = null;
  await stopService();
  await launch();
  await until(
    (s) => s.projects.find((p) => p.id === projectId)?.state?.connected,
    "restart connected",
  );
  await selectConversation(page, threadId);
  await page.getByRole("button", { name: "继续执行", exact: true }).waitFor();
  assert.equal(requests.length, beforeRestart, "restart must not submit to model");
  await page.getByRole("button", { name: "继续执行", exact: true }).click();
  await until((s) => thread(s)?.turns?.at(-1)?.status === "completed", "continue complete");
  const continued = (await turns()).at(-1);
  assert.equal(continued.continuedFromTurnId, original.id);
  assert.notEqual(continued.id, original.id);
  assert.ok(JSON.stringify(requests.at(-1).body).includes(pausePrompt));
  assert.ok(JSON.stringify(requests.at(-1).body).includes("CONFIRMED_PROGRESS_"));
  assert.equal(thread(await snapshot()).goals?.goal ?? null, null);
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
  await until((s) => thread(s)?.turns?.at(-1)?.status === "completed", "plain message complete");
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
  const uploaded = await command("media", { operation: "upload", mime: "image/png", bytes: png });
  assert.ok(uploaded.result?.uri, JSON.stringify(uploaded));
  const resource = {
    type: "resource_link",
    uri: "https://example.invalid/source",
    name: `SOURCE_REF_${marker}`,
  };
  const resourceSend = await command("send", {
    text: `RESOURCE_PROMPT_${marker}`,
    attachments: [{ type: "image", url: uploaded.result.uri }],
    mcpContent: [resource],
  });
  assert.ok(!resourceSend.error, JSON.stringify(resourceSend));
  await until(
    (s) =>
      thread(s)?.turns?.at(-1)?.status === "completed" &&
      thread(s)
        .turns.at(-1)
        .items.some((i) => i.content?.some((c) => c.mcpContent)),
    "resource prompt complete",
  );
  await input().fill(mainDraft);
  const draftKey = `areal-gui:draft:${projectId}:${threadId}`;
  const retainedMcp = JSON.stringify([
    {
      id: randomUUID(),
      block: { type: "resource_link", uri: "https://example.invalid/unsent", name: mainDraft },
    },
  ]);
  await page.evaluate(
    ({ draftKey, retainedMcp }) => {
      localStorage.setItem(`${draftKey}:mcpContent`, retainedMcp);
      window.dispatchEvent(new CustomEvent("areal-draft-change", { detail: draftKey }));
    },
    { draftKey, retainedMcp },
  );
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
  await page.getByTitle(`Composer reference acceptance ${marker}`, { exact: true }).waitFor();
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
    assert.ok(
      layout.image.x < layout.comments.x && layout.comments.x < layout.text.x,
      "image, comments and text share the reference order",
    );
    assert.ok(
      Math.abs(layout.image.bottom - layout.comments.bottom) <= 1 &&
        Math.abs(layout.image.bottom - layout.text.bottom) <= 1,
      "wide attachment row aligns card bottoms",
    );
    await shot(`02-editing-${colorScheme}-wide.png`);
    layoutEvidence.push({ colorScheme, viewport: "wide", ...layout });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(860, 960));
    const narrow = await page.locator(".composer-attachment-row").evaluate((row) => {
      const { width, height } = row.getBoundingClientRect();
      return {
        width,
        height,
        scrollWidth: row.scrollWidth,
        clientWidth: row.clientWidth,
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
    assert.ok(
      narrow.scrollWidth <= narrow.clientWidth + 1,
      "narrow attachment row has no horizontal overflow",
    );
    assert.ok(
      narrow.children.some((child) => child.y > narrow.children[0].bottom),
      "narrow attachment row wraps",
    );
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
  await app.evaluate(() => {
    globalThis.__continueLoseNext = true;
  });
  await edit.getByRole("button", { name: "发送", exact: true }).click();
  await until(
    (s) =>
      thread(s)?.turns?.at(-1)?.status === "completed" && thread(s).turns.at(-1).id !== replaced.id,
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
  assert.deepEqual(
    authoritative.result.thread.turns.map((t) => t.id),
    (await turns()).map((t) => t.id),
    "Core and live GUI agree on replaced history",
  );
  assert.equal(await input().innerText(), mainDraft);
  assert.equal(
    (await turns())
      .at(-1)
      .items.find((i) => i.type === "userMessage")
      .content.find((c) => c.type === "text").text,
    `REVISED_${marker}`,
  );
  const revisedContent = (await turns()).at(-1).items.find((i) => i.type === "userMessage").content;
  assert.equal(revisedContent.find((c) => c.type === "image").url, uploaded.result.uri);
  assert.deepEqual(revisedContent.find((c) => c.mcpContent).mcpContent, resource);
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(`${key}:mcpContent`), draftKey),
    retainedMcp,
  );
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), reviewKey),
    retainedReview,
    "editing leaves all attached review drafts unchanged",
  );
  assert.equal(await page.locator(".composer-image-card").count(), 1);
  await shot("03-edited-message.png");
  const editCommand = (await app.evaluate(() => globalThis.__continueCommands)).findLast(
    (c) => c.name === "editMessage",
  );
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
    await page.getByTitle(`Composer reference acceptance ${marker}`, { exact: true }).count(),
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
  await page.getByRole("button", { name: "移除应用附件", exact: true }).click();
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(`${key}:mcpContent`), draftKey),
    null,
  );
  await page.getByRole("button", { name: "移除评论附件", exact: true }).click();
  assert.deepEqual(
    await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), reviewKey),
    { comments, attachedIds: [] },
    "detach keeps the saved review drafts",
  );
  await page.evaluate((key) => {
    localStorage.removeItem(`${key}:mcpContent`);
    window.dispatchEvent(new CustomEvent("areal-draft-change", { detail: key }));
  }, draftKey);
  checks.push(
    "edit Cancel preserves history; Send atomically replaces the last prompt/reply in GUI, Core and model context; attachments/drafts survive lost replies; receipts deduplicate and stale edits reject; reload preserves replacement",
  );
  checks.push(
    "inline edit has text actions and keyboard focus; actual screenshot, seeded review comments and pasted text align, wrap and render in both themes; expansion and removal preserve exact draft content",
  );
  await checkpoint(checks.at(-1));
  await page.reload();
  await until(
    (s) => thread(s)?.turns?.at(-1)?.status === "completed",
    "edited history after reload",
  );
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
    (await command("steer", { expectedTurnId: steerBase.id, text: steerText })).result !==
      undefined,
  );
  await until(
    (s) =>
      thread(s)
        .turns.at(-1)
        .items.some((i) => i.type === "userMessage" && i.content.some((c) => c.text === steerText)),
    "steer accepted",
  );
  await pause();
  await page.getByRole("button", { name: "继续执行", exact: true }).click();
  await until(
    (s) =>
      thread(s).turns.at(-1).status === "completed" &&
      thread(s).turns.at(-1).continuedFromTurnId === steerBase.id,
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
    (s) =>
      thread(s).turns.at(-1).status === "completed" &&
      thread(s).turns.at(-1).id !== beforeSteerEdit.at(-1).id,
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
    await until(
      (s) =>
        s.projects[0].state.queues?.[threadId]?.items?.some(
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
    expectedConfigRevision: (await snapshot()).projects[0].configurations[threadId].revision,
    intent: { type: "continue", expectedTurnId: anchor },
  };
  const first = await rpc("areal/turn/submit", submit);
  assert.ok(!first.error, JSON.stringify(first));
  const duplicate = await rpc("areal/turn/submit", submit);
  assert.deepEqual(duplicate, first);
  await until(
    (s) => thread(s)?.turns?.at(-1)?.status === "completed" && requests.length >= queueStart + 2,
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
  await app.close();
  app = null;
  await stopService();
  const recordPath = join(scratch, "core", projectId, "state", `${threadId}.json`);
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  const recovery = record.thread.turns.find((t) => t.id === interruptedId);
  recovery.status = "inProgress";
  delete recovery.interruption;
  await writeFile(recordPath, JSON.stringify(record));
  await checkpoint("stopped-Core recovery fixture written");
  await launch();
  await reconnectCore();
  await until((s) => s.projects[0]?.state?.connected, "recovery connected");
  await selectConversation(page, threadId);
  await until(
    (s) => thread(s)?.turns?.at(-1)?.interruption === "coreRecovery",
    "Core recovery fact",
  );
  const recoveryRequests = requests.length;
  await page.getByRole("button", { name: "继续执行", exact: true }).waitFor();
  assert.equal(requests.length, recoveryRequests);
  await app.close();
  app = null;
  await stopService();
  const unknownRecord = JSON.parse(await readFile(recordPath, "utf8"));
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
  await until((s) => s.projects[0]?.state?.connected, "unknown fixture connected");
  await selectConversation(page, threadId);
  const blocked = await command("continue", {
    requestId: randomUUID(),
    expectedTurnId: interruptedId,
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
      thread(s)?.turns?.at(-1)?.continuedFromTurnId === interruptedId &&
      thread(s).turns.at(-1).status === "completed",
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
  passed = true;
} catch (error) {
  failure = error.stack || String(error);
  console.error(error);
  process.exitCode = 1;
  if (page) await captureSmokeFailure(page, scratch, error);
} finally {
  await checkpoint("capture final evidence and clean up owned services");
  if (app) {
    commands.push(
      ...(await withSmokeDeadline("final command capture", () =>
        app.evaluate(() => globalThis.__continueCommands || []),
      ).catch(() => [])),
    );
    await writeFile(
      join(scratch, "final-snapshot.json"),
      JSON.stringify(await snapshot().catch(() => null), null, 2),
    );
    await app.close().catch((error) => {
      passed = false;
      failure ||= error.stack || String(error);
    });
  }
  try {
    cleanupResult = await cleanup();
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
