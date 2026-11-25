import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { makeTempDir } from "./support/temp.mjs";
import { until } from "./support/desktop-fixture.mjs";
import { readCoreThread } from "./support/core-observation.mjs";
import { respondToSessionName } from "./model-fixture.mjs";
import { captureSmokeFailure } from "./smoke-navigation.mjs";
import {
  closeSmokeApplication,
  cleanupSyntheticHostKeychain,
  settleFixtureHostAfterQuit,
} from "./application-cleanup.mjs";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const { HostClient } = require("@areal/client/node");
const WebSocket = require("ws");
const run = promisify(execFile);
const oldInstalled = process.env.AREAL_UPGRADE_OLD_APP || "/Applications/AReaL Harness GUI.app";
const newApp = process.env.AREAL_UPGRADE_NEW_APP;
const scratch = await makeTempDir("agu-");
const oldCopy = join(scratch, "Old.app");
const workspace = join(scratch, "workspace");
const user = join(scratch, "user");
const home = join(scratch, "host");
const core = join(scratch, "core");
const profile = join(scratch, "profile");
const config = join(scratch, "config.toml");
const marker = "UPGRADE_OLD_MESSAGE";
const draft = "UPGRADE_DRAFT_AFTER_RESTART";
const held = "UPGRADE_HELD_REQUEST";
const reply = "UPGRADE_FIXTURE_REPLY";
const phases = [
  "old-ready",
  "old-sent",
  "old-gui-exited-background-live",
  "new-ready-handoff",
  "history-model-restored",
  "new-sent",
  "cleanup",
];
const result = {
  scratch,
  reached: [],
  unreached: [...phases],
  firstFailure: null,
  cleanup: {},
  requests: [],
  diagnostics: { mainStderr: [], renderer: [] },
};
const save = () => writeFile(join(scratch, "result.json"), JSON.stringify(result, null, 2));
const reached = async (phase) => {
  result.reached.push(phase);
  result.unreached = phases.filter((item) => !result.reached.includes(item));
  await save();
  console.log(`[desktop-upgrade] ${phase}`);
};
const sha = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const executable = (app) => join(app, "Contents/MacOS/AReaL Harness GUI");
const packagedCore = (app) => join(app, "Contents/Resources/areal-core/bin/areal");
const oldCore = packagedCore(oldCopy);
const newCore = newApp ? packagedCore(newApp) : join(root, "target/debug/areal");
const alive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};
let app,
  page,
  server,
  activeCore = oldCore,
  oldHost,
  oldAdapter,
  oldServices = [],
  heldResponse;
const inherited = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith("AREAL_") && key !== "ELECTRON_RUN_AS_NODE",
  ),
);
const env = {
  ...inherited,
  AREAL_GUI_USER_DATA: profile,
  AREAL_CORE_HOME: core,
  AREAL_CORE_USER_HOME: user,
  AREAL_HARNESS_HOME: home,
  AREAL_HARNESS_SERVICE_HOME: home,
  AREAL_CORE_CONFIG: config,
  OTEL_SDK_DISABLED: "true",
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
};
async function shellSnapshot() {
  const bootstrap = await page.evaluate(() => window.arealDesktop.getHostTicket());
  const socket = new WebSocket(bootstrap.websocketUrl, { origin: "areal-ui://app" });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 15000);
      const receive = (bytes) => {
        const frame = JSON.parse(bytes.toString());
        if (frame.id !== id) return;
        clearTimeout(timer);
        socket.off("message", receive);
        if (frame.error)
          reject(Object.assign(new Error(frame.error.message), { code: frame.error.code, method }));
        else resolve(frame.result);
      };
      socket.on("message", receive);
      socket.send(JSON.stringify({ version: 1, id, method, params }));
    });
  try {
    const hello = await request("hello", {
      protocolVersions: [1],
      capabilities: ["gui-read-v1", "gui-write-v1"],
      ticket: bootstrap.ticket,
      expectedGeneration: bootstrap.generation,
    });
    const shell = await request("shell.subscribe", {});
    return {
      sourceId: bootstrap.preferredSourceId,
      writeMethods: hello.writeMethods,
      snapshot: shell.snapshot,
    };
  } finally {
    socket.close();
  }
}
const readJson = (path) =>
  readFile(path, "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
const hostDescriptor = () => readJson(join(home, "host/host.json"));
const adapterDescriptor = () => readJson(join(core, "service.json"));
const inventory = async (binary) =>
  JSON.parse((await run(binary, ["service", "list", "--json"], { env, timeout: 20000 })).stdout);
const button = (name) => page.getByRole("button", { name, exact: true });
async function launch(isOld) {
  activeCore = isOld ? oldCore : newCore;
  const args = isOld || newApp ? [] : [join(gui, "app")];
  const runEnv = { ...env, ...(isOld || newApp ? {} : { AREAL_CORE_BIN: newCore }) };
  app = await electron.launch({
    executablePath: isOld ? executable(oldCopy) : newApp ? executable(newApp) : require("electron"),
    args,
    env: runEnv,
    timeout: 120000,
  });
  if (!isOld) {
    app.process().stderr?.on("data", (bytes) => {
      result.diagnostics.mainStderr.push(bytes.toString());
    });
  }
  page = await app.firstWindow();
  if (!isOld) {
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning")
        result.diagnostics.renderer.push(`${message.type()}: ${message.text()}`);
    });
    page.on("pageerror", (error) =>
      result.diagnostics.renderer.push(`pageerror: ${error.message}`),
    );
  }
  page.setDefaultTimeout(20000);
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  const shellResult = await until(
    async () => {
      try {
        return { value: await shellSnapshot() };
      } catch (error) {
        return { error: { method: error.method, code: error.code, message: error.message } };
      }
    },
    "Host shell ready",
    { timeout: 120000, accept: (value) => !!value.value },
  );
  const shell = shellResult.value;
  if (isOld) result.oldHostWriteMethods = shell.writeMethods;
  await app.evaluate(({ dialog, BrowserWindow }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    dialog.showMessageBox = async () => ({ response: 0 });
    BrowserWindow.getAllWindows()[0].setSize(1440, 960);
  }, workspace);
}
async function quit() {
  if (!app) return;
  const current = app;
  await closeSmokeApplication(
    {
      process: () => current.process(),
      close: () =>
        current.evaluate(({ Menu }) => {
          const item = Menu.getApplicationMenu().items[0].submenu.items.find(
            (entry) => entry.label === "退出 AReaL Harness",
          );
          if (!item) throw new Error("GUI quit menu unavailable");
          item.click();
        }),
    },
    40000,
  );
  app = undefined;
  page = undefined;
}
async function thread(id) {
  return readCoreThread({
    binary: activeCore,
    env,
    gui,
    threadId: id,
    workspace,
  });
}
async function send(text, expectedCount) {
  await page.getByTestId("chat-input").fill(text);
  await button("发送").click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="areal-workbench"]')?.dataset.threadId,
  );
  const id = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
  const turn = await until(
    async () => (await thread(id)).turns.at(-1),
    "authoritative completed turn",
    {
      timeout: 120000,
      accept: (value) =>
        value?.status === "completed" &&
        value.items.some(
          (item) => item.type === "userMessage" && JSON.stringify(item.content).includes(text),
        ),
    },
  );
  await page.locator(`[data-turn-id="${turn.id}"][data-turn-status="completed"]`).waitFor();
  assert.equal(result.requests.filter((item) => item.conversation).length, expectedCount);
  return id;
}
try {
  for (const dir of [workspace, user, home, core, profile])
    await mkdir(dir, { recursive: true, mode: 0o700 });
  execFileSync("ditto", [oldInstalled, oldCopy]);
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
  result.identity = {
    oldInstalled,
    oldCopy,
    oldCoreSha256: await sha(oldCore),
    newApp: newApp || "source Electron",
    newCoreSha256: await sha(newCore),
    revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  };
  server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    if (respondToSessionName(payload, response)) return;
    if (
      payload.messages?.some(
        (message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.startsWith("Predict the next user prompt from the conversation data."),
      )
    ) {
      assert.ok(!payload.tools?.length, "prompt prediction must not receive tools");
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    const text = JSON.stringify(payload.messages || []);
    const isHeld = JSON.stringify(payload.messages?.at(-1)).includes(held);
    result.requests.push({
      model: payload.model,
      conversation: text.includes(marker) || text.includes(draft) || isHeld,
      held: isHeld,
    });
    if (isHeld) {
      heldResponse = response;
      response.on("close", () => {
        result.heldDisconnected = true;
      });
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "HELD" }, finish_reason: null }] })}\n\n`,
      );
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: reply }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  await writeFile(
    config,
    `schema_version=1\n[model]\ncatalog_version=1\nprovider="fixture"\nname="fixture-model"\n[model.providers.fixture]\nname="fixture"\nendpoint="http://127.0.0.1:${server.address().port}/v1/chat/completions"\nprotocol="chat-completions"\nmodels=[{id="fixture-model",enabled=true}]\n`,
    { mode: 0o600 },
  );
  const legacyId = createHash("sha256").update(workspace).digest("hex").slice(0, 24);
  await writeFile(
    join(core, "projects.json"),
    JSON.stringify([{ id: legacyId, root: workspace }]),
    { mode: 0o600 },
  );
  await writeFile(
    join(core, "library.json"),
    JSON.stringify({
      projects: {},
      threads: {},
      projectOrder: [],
      sections: [],
      sidebarThreadOrder: [],
      sidebarRevision: 0,
      settings: {},
    }),
    { mode: 0o600 },
  );
  await save();
  await launch(true);
  await until(async () => {
    const host = new HostClient();
    try {
      await host.connect(home);
      return (await host.listProjects()).projects.some((entry) => entry.workspace === workspace);
    } finally {
      host.close();
    }
  }, "Host project registration");
  await until(async () => {
    const host = new HostClient();
    try {
      await host.connect(home);
      const registration = (await host.listProjects()).projects.find(
        (entry) => entry.workspace === workspace,
      );
      if (!registration) return false;
      const shell = await shellSnapshot();
      return shell.snapshot.navigation.some(
        (source) =>
          source.sourceId === shell.sourceId &&
          source.bindings.some((binding) => binding.projectId === registration.projectId),
      );
    } finally {
      host.close();
    }
  }, "registered project projected in Host shell");
  const host = new HostClient();
  await host.connect(home);
  const original = (await host.listProjects()).projects.find(
    (entry) => entry.workspace === workspace,
  );
  assert.ok(original?.dataDir.startsWith(core + "/"));
  await page
    .locator(".project-row")
    .filter({ has: button("workspace") })
    .hover();
  const create = button("在项目 workspace 中新建对话");
  await create.focus();
  await create.press("Enter");
  const service = await until(
    async () =>
      (await inventory(oldCore)).find(
        (record) => record.state === "ready" && record.workspace === workspace,
      ),
    "old project Core ready",
    { timeout: 120000 },
  );
  assert.equal(service.dataDir, original.dataDir, "Core owns the GUI-imported data directory");
  if (await button("重试加载对话").isVisible()) await button("重试加载对话").click();
  await button("选择模型").waitFor();
  await button("选择模型").click();
  await page.getByRole("radio", { name: "fixture-model", exact: true }).click();
  await page.keyboard.press("Escape");
  const id = await send(marker, 1);
  await page.getByTestId("chat-view").getByText(reply, { exact: false }).waitFor();
  const oldModel = (await thread(id)).desktop.configuration.model;
  result.binding = { projectId: original.projectId, dataDir: original.dataDir, threadId: id };
  result.oldGuiHistory = "visible";
  host.close();
  await reached("old-ready");
  await reached("old-sent");
  await page.getByTestId("chat-input").fill(held);
  await button("发送").click();
  await until(() => result.requests.some((item) => item.held), "held request reached fixture", {
    timeout: 120000,
  });
  assert.equal(result.requests.filter((item) => item.conversation).length, 2);
  await page.getByTestId("chat-input").fill(draft);
  await page.waitForFunction(
    (text) => Object.values(localStorage).some((value) => value.includes(text)),
    draft,
  );
  result.oldGuiDraft = "saved";
  oldHost = await hostDescriptor();
  oldAdapter = await adapterDescriptor();
  oldServices = [service];
  assert.ok(oldAdapter?.pid && alive(oldAdapter.pid), "old workbench identity is live");
  assert.ok(alive(service.corePid), "old Core is alive");
  await quit();
  assert.ok(alive(oldHost.pid), "old Host remains after GUI exit");
  assert.ok(alive(service.corePid), "old Core remains after GUI exit");
  result.originalProcesses = {
    host: oldHost.pid,
    workbench: oldAdapter.pid,
    core: service.corePid,
    serviceHost: service.hostPid,
  };
  await reached("old-gui-exited-background-live");
  await launch(false);
  const newHost = await until(hostDescriptor, "new Host identity", {
    timeout: 120000,
    accept: (value) => value?.generation && value.generation !== oldHost.generation,
  });
  assert.ok(!alive(oldHost.pid), "old Host exited during handoff");
  assert.ok(!alive(oldServices[0].corePid), "old Core exited during handoff");
  assert.ok(!alive(oldAdapter.pid), "old workbench exited during handoff");
  await until(() => result.heldDisconnected, "held model request disconnected during handoff");
  assert.ok(alive(newHost.pid), "new Host is alive");
  await button("稍后处理")
    .waitFor({ timeout: 3000 })
    .catch(() => {});
  if (await button("稍后处理").isVisible()) await button("稍后处理").click();
  await page.waitForFunction(
    (target) =>
      document.querySelector('[data-testid="areal-workbench"]')?.dataset.threadId === target &&
      document
        .querySelector('[data-testid="chat-view"]')
        ?.textContent?.includes("UPGRADE_OLD_MESSAGE"),
    id,
    { timeout: 120000 },
  );
  await until(() => inventory(newCore), "new project Core ready", {
    timeout: 120000,
    accept: (records) =>
      records.some((record) => record.state === "ready" && record.workspace === workspace),
  });
  const newServices = (await inventory(newCore)).filter(
    (record) => record.state === "ready" && record.workspace === workspace,
  );
  assert.equal(newServices.length, 1, "one new Core owns the workspace");
  const automatic = await shellSnapshot();
  const automaticProject = automatic.snapshot.projects.find(
    (entry) => entry.workspace === workspace,
  );
  result.automaticRecovery = {
    projectState: automaticProject?.state ?? "missing",
    historyVisible: await page
      .getByTestId("chat-view")
      .getByText(marker, { exact: false })
      .isVisible(),
  };
  assert.equal(result.automaticRecovery.projectState, "ready");
  assert.equal(result.automaticRecovery.historyVisible, true);
  assert.notEqual(newServices[0].generation, oldServices[0].generation, "Core generation changed");
  const identity = (record) => ({ pid: record.corePid, generation: record.generation });
  result.handoff = {
    oldHost: { pid: oldHost.pid, generation: oldHost.generation },
    newHost: { pid: newHost.pid, generation: newHost.generation },
    oldCore: identity(oldServices[0]),
    oldWorkbench: { pid: oldAdapter.pid },
    newCore: identity(newServices[0]),
  };
  await reached("new-ready-handoff");
  const selectedId = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
  assert.equal(selectedId, id, "original conversation is selected automatically");
  await page.getByTestId("chat-view").getByText(marker, { exact: false }).waitFor();
  await page.getByTestId("chat-view").getByText(reply, { exact: false }).waitFor();
  assert.ok(oldModel, "old GUI selected a concrete model");
  assert.deepEqual((await thread(id)).desktop.configuration.model, oldModel);
  assert.match(await button("选择模型").innerText(), /fixture-model/);
  assert.equal(
    result.requests.filter((item) => item.conversation).length,
    2,
    "upgrade must not replay the old message",
  );
  assert.equal(result.oldGuiDraft, "saved");
  await page.waitForFunction(
    (text) => document.querySelector('[data-testid="chat-input"]')?.textContent?.includes(text),
    draft,
  );
  result.draftCoverage = "old GUI draft restored";
  await reached("history-model-restored");
  assert.equal(await send(draft, 3), id);
  assert.equal(result.requests.filter((item) => item.conversation).at(-1).model, "fixture-model");
  await reached("new-sent");
} catch (error) {
  result.firstFailure = error.stack || String(error);
  if (page) {
    await page
      .locator("summary")
      .filter({ hasText: "查看详情" })
      .click({ timeout: 1000 })
      .catch(() => {});
    result.failureView = await page
      .locator("body")
      .innerText()
      .catch(() => "unavailable");
    try {
      result.failureShell = await shellSnapshot();
    } catch (failure) {
      result.failureShellError = {
        method: failure.method,
        code: failure.code,
        message: failure.message,
      };
    }
    result.desktopConnection = await page
      .evaluate(async () => {
        const snapshot = await window.arealDesktop.snapshot();
        return {
          connection: snapshot.connection,
          projects: (snapshot.projects ?? []).map((project) => ({
            id: project.id,
            error: project.error,
            connected: project.state?.connected,
          })),
        };
      })
      .catch((error) => ({ error: error.message }));
    await captureSmokeFailure(page, scratch, error).catch(() => {});
  }
} finally {
  let cleanupFailed = false;
  let cleanupHost;
  const cleanupGuiPid = app?.process()?.pid;
  try {
    cleanupHost = await hostDescriptor();
    await quit();
    result.cleanup.gui = "exited";
  } catch (error) {
    cleanupFailed = true;
    result.cleanup.gui = error.message;
  }
  try {
    const descriptor = cleanupHost ?? (await hostDescriptor());
    const adapter = await adapterDescriptor();
    const receipt = await settleFixtureHostAfterQuit(activeCore, env, scratch, {
      host: descriptor,
      pid: cleanupGuiPid,
    });
    if (descriptor) assert.equal(receipt?.state, "completed", "original Host stop confirmed");
    assert.ok(!alive(adapter?.pid), "isolated adapter is stopped");
    assert.ok(!alive(oldHost?.pid), "original Host is stopped");
    assert.ok(
      oldServices.every((record) => !alive(record.corePid)),
      "original Core is stopped",
    );
    result.cleanup.host = receipt
      ? "original stop receipt completed; Host and Core stopped"
      : "not started";
  } catch (error) {
    cleanupFailed = true;
    result.cleanup.host = error.stack || String(error);
  }
  try {
    result.cleanup.keychain = await cleanupSyntheticHostKeychain(home, scratch);
  } catch (error) {
    cleanupFailed = true;
    result.cleanup.keychain = error.message;
  }
  heldResponse?.destroy();
  if (server) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  if (!cleanupFailed) await reached("cleanup");
  result.passed = !result.firstFailure && result.unreached.length === 0;
  await save();
  console.log(JSON.stringify(result));
  if (!result.passed) process.exitCode = 1;
}
