#!/usr/bin/env node
import { preparePrivateFixtureDirectories } from "./support/desktop-fixture.mjs";
import { readCoreThread } from "./support/core-observation.mjs";
import { resolveAcceptanceBinary } from "./support/acceptance-binary.mjs";
import { stopAndAssertFixtureHost } from "./application-cleanup.mjs";
import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { trackedMkdtemp } from "./support/host-cleanup.cjs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.AREAL_RECOVERY_SOURCE_ROOT ?? join(here, "../../.."));
const gui = join(root, "clients/gui");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const WebSocket = require("ws");
const { WebSocketServer } = WebSocket;
const { applicationFixture } = await import(
  pathToFileURL(join(gui, "scripts/application-fixture.mjs"))
);
const { createProjectConversation } = await import(
  pathToFileURL(join(gui, "scripts/smoke-navigation.mjs"))
);
let binary;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const json = (path, value) => writeFile(path, JSON.stringify(value, null, 2));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const displayTurns = (turns) =>
  turns.map((turn) => ({
    id: turn.id,
    status: turn.status,
    items: turn.items,
    ...Object.fromEntries(
      [
        "error",
        "interruption",
        "continuedFromTurnId",
        "startedAt",
        "completedAt",
        "durationMs",
        "goal",
        "usage",
        "generation",
      ].map((key) => [key, turn[key] ?? null]),
    ),
  }));
async function until(read, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`Timeout: ${label}`);
}
async function preflight() {
  assert.equal(process.platform, "darwin", "This source Electron runner is prepared for macOS");
  binary = await resolveAcceptanceBinary(root, process.env.AREAL_CORE_BIN);
  await access(join(gui, "renderer/dist/index.html"));
  await access(require("electron"));
  const renderer = join(gui, "renderer/dist");
  const rendererPaths = (await readdir(renderer, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name));
  const rendererSHA256 = Object.fromEntries(
    await Promise.all(rendererPaths.map(async (path) => [path, sha(await readFile(path))])),
  );
  return {
    root,
    binary,
    binarySHA256: sha(await readFile(binary)),
    rendererSHA256,
    node: process.version,
    electron: require("electron/package.json").version,
    playwright: require("playwright-core/package.json").version,
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    diffSHA256: sha(
      execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: root, maxBuffer: 32 * 1024 * 1024 }),
    ),
    helperSHA256: sha(await readFile(fileURLToPath(import.meta.url))),
  };
}
function environment(state) {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
  const noProxy = [env.NO_PROXY, env.no_proxy, "127.0.0.1,localhost,::1"].filter(Boolean).join(",");
  return {
    ...env,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    AREAL_CORE_BIN: binary,
    AREAL_GUI_USER_DATA: join(state, "electron"),
    AREAL_CORE_HOME: join(state, "core"),
    AREAL_CORE_USER_HOME: join(state, "user"),
    AREAL_HARNESS_HOME: join(state, "config-home"),
    AREAL_HARNESS_SERVICE_HOME: join(state, "registry"),
    AREAL_CORE_CONFIG: join(state, "config.toml"),
    AREAL_CORE_DESKTOP_CONFIG: join(state, "desktop.json"),
  };
}
async function transportProxy(metadata, events) {
  const sessions = new Set();
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });
  let armed = null,
    blocked = false,
    connections = 0;
  server.on("upgrade", (request, socket, head) => {
    if (blocked || request.headers.origin !== "areal-ui://app") {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(request, socket, head, (down) => wss.emit("connection", down, request));
  });
  wss.on("connection", (down) => {
    const entry = {
      down,
      up: new WebSocket(metadata.websocketUrl, {
        origin: "areal-ui://app",
        followRedirects: false,
        maxPayload: 256 * 1024 * 1024,
      }),
      queue: [],
      fault: null,
      reads: new Map(),
      reviews: new Map(),
    };
    sessions.add(entry);
    connections++;
    events.push({ at: Date.now(), type: "proxy-connected", connection: connections });
    entry.up.on("open", () => {
      for (const [bytes, binary] of entry.queue) entry.up.send(bytes, { binary });
      entry.queue.length = 0;
    });
    down.on("message", (bytes, binary) => {
      const message = JSON.parse(bytes.toString());
      if (
        message.method === "desktop.command" &&
        message.params?.command === "workspace" &&
        message.params?.request?.operation === "review"
      ) {
        entry.reviews.set(message.id, message.params.request.summaryOnly === true);
      }
      if (
        armed &&
        !armed.dispatched &&
        message.method === (armed.name === "send" ? "session.send" : "session.open")
      ) {
        entry.fault = armed;
        armed.dispatched = true;
        armed.rpcId = message.id;
        armed.requestId = message.commandId ?? message.id;
        armed.threadId = message.params?.threadId;
        armed.projectId = message.context?.projectId;
        events.push({
          at: Date.now(),
          type: "fault-command-forwarded",
          name: armed.name,
          rpcId: message.id,
          requestId: armed.requestId,
          threadId: armed.threadId,
          projectId: armed.projectId,
        });
      }
      if (message.method === "session.send")
        events.push({
          at: Date.now(),
          type: "command",
          name: "send",
          requestId: message.commandId,
          threadId: message.params?.threadId,
        });
      if (message.method === "command.read") entry.reads.set(message.id, message.params.commandId);
      if (entry.up.readyState === WebSocket.OPEN) entry.up.send(bytes, { binary });
      else if (entry.up.readyState === WebSocket.CONNECTING) entry.queue.push([bytes, binary]);
    });
    entry.up.on("message", (bytes, binary) => {
      const message = JSON.parse(bytes.toString()),
        fault = entry.fault;
      if (entry.reviews.has(message.id)) {
        events.push({
          at: Date.now(),
          type: "workspace-review-response",
          summaryOnly: entry.reviews.get(message.id),
          bytes: bytes.length,
          error: !!message.error,
        });
        entry.reviews.delete(message.id);
      }
      if (entry.reads.has(message.id)) {
        events.push({
          type: "command-reconciled",
          requestId: entry.reads.get(message.id),
          result: message.result,
          error: message.error,
        });
        entry.reads.delete(message.id);
      }
      if (fault && message.id === fault.rpcId) {
        fault.response = message;
        fault.completed = true;
        fault.hadError = !!message.error;
        blocked = true;
        events.push({
          at: Date.now(),
          type: "real-host-response-discarded",
          name: fault.name,
          requestId: fault.requestId,
          hadError: fault.hadError,
        });
        down.terminate();
        entry.up.terminate();
        return;
      }
      if (fault && message.method) {
        fault.withheldStates = (fault.withheldStates ?? 0) + 1;
        return;
      }
      if (down.readyState === WebSocket.OPEN) down.send(bytes, { binary });
    });
    const end = () => {
      sessions.delete(entry);
      down.terminate();
      entry.up.terminate();
    };
    down.on("close", end);
    entry.up.on("close", end);
    down.on("error", end);
    entry.up.on("error", end);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    endpoint: `ws://127.0.0.1:${server.address().port}`,
    get connections() {
      return connections;
    },
    arm(name) {
      assert.ok(!armed || armed.completed, "Previous fault must settle");
      armed = { name, dispatched: false, completed: false };
      return armed;
    },
    release() {
      blocked = false;
      armed = null;
      events.push({ at: Date.now(), type: "transport-restored" });
    },
    async close() {
      blocked = false;
      for (const { down, up } of sessions) {
        down.terminate();
        up.terminate();
      }
      await new Promise((resolve) => wss.close(resolve));
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
async function cleanup(run) {
  assert.ok([await realpath(tmpdir()), "/private/tmp"].includes(dirname(run.state)));
  assert.match(run.state, /\/arec-[^/]+$/);
  assert.equal(await readFile(join(run.state, ".owner"), "utf8"), run.owner);
  const core = binary || (await resolveAcceptanceBinary(root, process.env.AREAL_CORE_BIN));
  const receipt = await stopAndAssertFixtureHost(core, environment(run.state), run.evidence);
  return { hostAndCoreExited: true, receipt };
}
const command = process.argv[2];
if (command === "doctor") {
  console.log(JSON.stringify(await preflight(), null, 2));
} else if (command === "cleanup" && process.argv[3]) {
  const evidence = resolve(process.argv[3]),
    run = JSON.parse(await readFile(join(evidence, "run.json"), "utf8"));
  const result = await cleanup(run);
  await json(join(evidence, "cleanup.json"), result);
  console.log(JSON.stringify(result));
} else if (command === "run") {
  const build = await preflight(),
    evidenceRoot = join(root, ".scratch/recovery-electron");
  await mkdir(evidenceRoot, { recursive: true });
  const evidence = await trackedMkdtemp(join(evidenceRoot, "run-")),
    state = await makeTempDir("arec-");
  const run = { evidence, state, owner: randomUUID() };
  await writeFile(join(state, ".owner"), run.owner);
  await json(join(evidence, "run.json"), run);
  console.log(`Evidence: ${evidence}`);
  const requests = [],
    events = [],
    errors = [],
    stderr = [],
    checks = [];
  const manifest = {
    build,
    scope:
      "source Electron Renderer → authentic Host → real Core; local deterministic SSE provider",
    faultBoundary:
      "Renderer↔Host websocket: real command response and racing notifications withheld, connection cut, then fresh-ticket reconnection",
    excluded: [
      "Core→Desktop response-loss and healthy Core observe retry (separate backend contract smoke)",
      "real provider/credentials",
      "native directory dialog and physical input",
      "Runtime tool execution",
      "installed package",
      "unrelated-error retention: no natural missing-thread UI route available",
    ],
    checks,
    errors,
    run,
  };
  let app, page, processHandle, application, model, proxy, failure, projectId, threadId;
  const env = environment(state),
    workspace = join(state, "workspace");
  const snapshot = () => page.evaluate(() => window.arealDesktop.snapshot());
  const project = (snap) => snap.projects.find((value) => value.id === projectId);
  const thread = (snap) => project(snap)?.state?.threads[threadId];
  const workRequests = () => requests.filter((value) => !value.title).length;
  const capture = async (name) => {
    await page.screenshot({
      path: join(evidence, `${name}.png`),
      animations: "disabled",
      timeout: 10000,
    });
    await writeFile(
      join(evidence, `${name}.aria.txt`),
      await page.locator(".work-area").ariaSnapshot(),
    );
    await json(join(evidence, `${name}.snapshot.json`), await snapshot());
  };
  async function launch() {
    app = await electron.launch({
      executablePath: require("electron"),
      args: [application.path],
      env,
      timeout: 120000,
    });
    processHandle = app.process();
    processHandle.stderr.on("data", (data) => stderr.push(String(data)));
    page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
    const configured = await page.evaluate(() => {
      const key = "areal-gui:application-preferences";
      const value = JSON.parse(localStorage.getItem(key) || "{}");
      if (value.nextPromptSuggestions === false) return false;
      localStorage.setItem(key, JSON.stringify({ ...value, nextPromptSuggestions: false }));
      return true;
    });
    if (configured) {
      await page.reload();
      await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
    }
    await until(
      async () => (await snapshot()).connection?.state === "ready",
      "source Desktop ready",
    );
    const actual = await app.evaluate(({ app, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0],
        p = window.webContents.getLastWebPreferences();
      window.setSize(1440, 960);
      return {
        pid: process.pid,
        userData: app.getPath("userData"),
        sandbox: p.sandbox,
        contextIsolation: p.contextIsolation,
        nodeIntegration: p.nodeIntegration,
      };
    });
    assert.equal(actual.userData, env.AREAL_GUI_USER_DATA);
    assert.equal(actual.sandbox, true);
    assert.equal(actual.contextIsolation, true);
    assert.equal(actual.nodeIntegration, false);
    const metadata = JSON.parse(await readFile(join(state, "core/service.json"), "utf8"));
    await json(join(evidence, "run.json"), run);
    await json(join(evidence, `doctor-${processHandle.pid}.json`), {
      ...actual,
      desktopPid: metadata.pid,
      desktopGeneration: metadata.desktopGeneration,
      binarySHA256: sha(await readFile(binary)),
    });
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      dialog.showMessageBox = async (...args) => ({
        response: ["确认取消后台任务？", "退出 AReaL Harness？"].includes(args.at(-1).message)
          ? 1
          : (args.at(-1).cancelId ?? 0),
      });
    }, workspace);
  }
  async function stopGUI() {
    if (!app) return;
    await app.evaluate(({ app }) => app.quit());
    await until(
      () => processHandle.exitCode !== null || processHandle.signalCode !== null,
      "owned Main exits",
      30000,
    );
    app = null;
  }
  try {
    await mkdir(workspace);
    await preparePrivateFixtureDirectories(state, [
      env.AREAL_CORE_HOME,
      env.AREAL_GUI_USER_DATA,
      env.AREAL_CORE_USER_HOME,
      env.AREAL_HARNESS_HOME,
      env.AREAL_HARNESS_SERVICE_HOME,
    ]);
    execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
    // 完整审查结果超过 Host 帧上限；后台摘要不得触发断连与恢复重放。
    await writeFile(join(workspace, "large-review.txt"), "baseline\n");
    execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Recovery fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "fixture",
      ],
      { cwd: workspace, stdio: "ignore" },
    );
    await writeFile(join(workspace, "large-review.txt"), "new line\n".repeat(30000));
    model = createServer(async (request, response) => {
      try {
        let raw = "";
        for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw),
          firstContent = body.messages?.[0]?.content;
        const title =
          typeof firstContent === "string" &&
          firstContent.startsWith("Generate a concise semantic session title");
        requests.push({ at: Date.now(), title, body });
        const text = title ? "Recovery fixture" : `RECOVERY_HISTORY_SENTINEL_${workRequests()}`;
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        );
      } catch (error) {
        errors.push(error.stack);
        response.destroy();
      }
    });
    await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
    await writeFile(
      join(state, "config.toml"),
      `schema_version=1\n[model]\ncatalog_version=1\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\nmodels=[{id="fixture",enabled=true}]\n`,
    );
    await json(join(state, "desktop.json"), {
      profiles: [
        {
          id: "fixture",
          revision: "v1",
          displayName: "Fixture",
          instructions: "Respond to the task.",
        },
      ],
    });
    application = await applicationFixture(gui, join(state, "app"));
    await launch();
    await capture("01-empty");
    await page.getByRole("button", { name: "不在项目中工作", exact: true }).click();
    await page.getByRole("menuitem", { name: "新建项目", exact: true }).click();
    projectId = (
      await until(
        async () =>
          (await snapshot()).projects.find(
            (value) => value.root === workspace && value.state?.connected,
          ),
        "UI-added project connected",
      )
    ).id;
    await until(
      async () =>
        project(await snapshot())?.models?.some((model) => model.displayName === "fixture"),
      "fixture model catalog loaded",
    );
    await page.getByRole("button", { name: "选择模型", exact: true }).click();
    await page.getByRole("radio", { name: "fixture", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.getByTestId("chat-input").fill("Keep the original recovery history");
    await page.getByTestId("chat-send-button").click();
    threadId = await until(
      () => page.getByTestId("areal-workbench").getAttribute("data-thread-id"),
      "original Thread ID",
    );
    await until(
      async () => thread(await snapshot())?.turns.at(-1)?.status === "completed",
      "original turn completed",
    );
    await page
      .getByTestId("chat-view")
      .getByText("RECOVERY_HISTORY_SENTINEL_1", { exact: true })
      .waitFor();
    await capture("02-history");
    const endpoint = JSON.parse(await readFile(join(state, "registry/host/endpoint.json"), "utf8"));
    proxy = await transportProxy(endpoint, events);
    let skillsBegins = 0;
    page.on("console", (message) => {
      if (
        message.text().includes("[composer-skills]") &&
        message.text().includes('"outcome":"begin"')
      )
        skillsBegins++;
    });
    await page.addInitScript(
      ({ target, replacement }) => {
        const NativeWebSocket = window.WebSocket;
        window.WebSocket = class extends NativeWebSocket {
          constructor(url, protocols) {
            super(String(url) === target ? replacement : url, protocols);
          }
        };
      },
      { target: endpoint.websocketUrl, replacement: proxy.endpoint },
    );
    await page.reload();
    await page
      .getByTestId("chat-view")
      .getByText("RECOVERY_HISTORY_SENTINEL_1", { exact: true })
      .waitFor();
    assert.ok(proxy.connections > 0, "Renderer connected through the Host fault proxy");
    await until(
      () =>
        events.some(
          (event) =>
            event.type === "workspace-review-response" && event.summaryOnly && !event.error,
        ),
      "summary workspace review response",
    );
    const review = events.find(
      (event) => event.type === "workspace-review-response" && event.summaryOnly && !event.error,
    );
    assert.ok(review.bytes < 1024 * 1024, `Summary review response is ${review.bytes} bytes`);
    const stableConnections = proxy.connections,
      stableSkills = skillsBegins;
    await sleep(6000);
    assert.equal(
      proxy.connections,
      stableConnections,
      "Large review must not cause spontaneous reconnect",
    );
    assert.ok(skillsBegins - stableSkills <= 1, "Skills must not reload repeatedly while idle");
    checks.push({
      name: "large-review-stable-connection",
      responseBytes: review.bytes,
      connections: stableConnections,
      idleSkillsBegins: skillsBegins - stableSkills,
    });
    const before = structuredClone(thread(await snapshot())),
      beforeModel = workRequests();
    const send = proxy.arm("send");
    await page.getByTestId("chat-input").fill("Accept exactly this original send once");
    await page.getByTestId("chat-send-button").click();
    await until(() => send.completed, "real accepted Host send response intercepted");
    assert.equal(send.hadError, false, JSON.stringify(send.response));
    assert.ok(send.requestId);
    assert.equal(send.threadId, threadId);
    const unknown = page.getByRole("button", { name: "检查操作状态", exact: true });
    await unknown.waitFor();
    assert.equal(await unknown.count(), 1, "one action represents the unresolved send");
    assert.equal(
      await page.getByTestId("chat-input").innerText(),
      "Accept exactly this original send once",
    );
    assert.equal(
      await page.evaluate(
        (id) =>
          Object.keys(localStorage).some(
            (key) => key.endsWith(":pending") && localStorage.getItem(key) === id,
          ),
        send.requestId,
      ),
      true,
      "pending send retains the original Host command ID",
    );
    await capture("03-send-response-lost");
    await page.getByTestId("chat-input").fill("A new draft written during recovery");
    assert.equal(await page.getByTestId("chat-send-button").isDisabled(), true);
    const sendsWhileUnknown = events.filter(
      (event) => event.type === "command" && event.name === "send",
    ).length;
    await page.getByTestId("chat-input").press("Enter");
    const editedDraft = await page.getByTestId("chat-input").innerText();
    assert.equal(
      events.filter((event) => event.type === "command" && event.name === "send").length,
      sendsWhileUnknown,
    );
    proxy.release();
    await until(
      async () =>
        events.some(
          (event) =>
            event.type === "command-reconciled" &&
            event.requestId === send.requestId &&
            event.result?.admissionState === "accepted",
        ),
      "original accepted outcome converges automatically",
    );
    await until(
      async () => thread(await snapshot())?.turns.at(-1)?.status === "completed",
      "accepted turn completed",
    );
    await unknown.waitFor({ state: "hidden" });
    assert.equal(await page.getByTestId("chat-input").innerText(), editedDraft);
    assert.equal(
      await page.evaluate(
        (id) =>
          Object.keys(localStorage).some(
            (key) => key.endsWith(":pending") && localStorage.getItem(key) === id,
          ),
        send.requestId,
      ),
      false,
      "accepted receipt clears only the original pending send",
    );
    await page
      .getByTestId("chat-view")
      .getByText("RECOVERY_HISTORY_SENTINEL_2", { exact: true })
      .waitFor();
    const accepted = thread(await snapshot());
    assert.equal(accepted.turns.length, before.turns.length + 1);
    assert.equal(workRequests() - beforeModel, 1);
    assert.equal(
      events.filter((event) => event.type === "command" && event.name === "send").length,
      sendsWhileUnknown,
      "Enter during UNKNOWN never sends another command",
    );
    assert.deepEqual(
      accepted.turns.slice(0, before.turns.length).map((value) => value.id),
      before.turns.map((value) => value.id),
    );
    assert.equal(
      events.filter(
        (value) =>
          value.type === "command" && value.name === "send" && value.requestId === send.requestId,
      ).length,
      1,
      "Renderer never replays accepted send",
    );
    checks.push(
      "real UI accepted send response lost across Renderer↔Host; original request converges and matching notices disappear; one additional Core Turn and non-title model request",
    );
    await json(join(evidence, "send-fault.json"), send);
    await capture("04-send-converged");
    const unchanged = proxy.arm("send");
    await page.getByTestId("chat-input").fill("An unchanged recovery draft");
    await page.getByTestId("chat-send-button").click();
    await until(() => unchanged.completed, "unchanged draft send response intercepted");
    assert.equal(unchanged.hadError, false, JSON.stringify(unchanged.response));
    await unknown.waitFor();
    const draftState = () =>
      page.evaluate((requestId) => {
        const pendingKey = Object.keys(localStorage).find(
          (key) => key.endsWith(":pending") && localStorage.getItem(key) === requestId,
        );
        const key = pendingKey?.slice(0, -":pending".length);
        return key
          ? {
              key,
              text: localStorage.getItem(key),
              version: localStorage.getItem(`${key}:version`),
              pendingVersion: localStorage.getItem(`${key}:pending-draft-version`),
            }
          : null;
      }, unchanged.requestId);
    const draftBefore = await draftState();
    proxy.release();
    await unknown.waitFor({ state: "hidden" });
    const draftAfter = await page.evaluate(
      (key) => ({
        text: localStorage.getItem(key),
        version: localStorage.getItem(`${key}:version`),
        pendingVersion: localStorage.getItem(`${key}:pending-draft-version`),
      }),
      draftBefore.key,
    );
    const reconciliation = events.find(
      (event) => event.type === "command-reconciled" && event.requestId === unchanged.requestId,
    );
    await json(join(evidence, "unchanged-draft.json"), {
      before: draftBefore,
      after: draftAfter,
      outcome: {
        status: reconciliation?.result?.status,
        accepted: reconciliation?.result?.accepted,
        admissionState: reconciliation?.result?.admissionState,
      },
    });
    await until(
      async () => (await page.getByTestId("chat-input").textContent()) === "",
      "unchanged accepted draft clears",
    );
    await until(
      async () => thread(await snapshot())?.turns.at(-1)?.status === "completed",
      "unchanged draft turn completed",
    );
    assert.equal(thread(await snapshot()).turns.length, accepted.turns.length + 1);
    assert.equal(workRequests(), beforeModel + 2);
    assert.equal(
      events.filter(
        (event) =>
          event.type === "command" &&
          event.name === "send" &&
          event.requestId === unchanged.requestId,
      ).length,
      1,
    );
    checks.push(
      "UNKNOWN allows editing but blocks resubmission; accepted recovery preserves edited text and clears an unchanged draft",
    );
    const history = displayTurns(thread(await snapshot()).turns),
      readModel = workRequests();
    await createProjectConversation(page, "workspace");
    const read = proxy.arm("open");
    await page.getByTestId(`task-item-${threadId}`).click();
    await until(() => read.completed, "real Host history-open response intercepted");
    assert.equal(read.hadError, false, JSON.stringify(read.response));
    assert.equal(read.threadId, threadId);
    await until(
      async () => page.getByTestId("chat-send-button").isDisabled(),
      "read interruption is observed",
    );
    await capture("05-read-response-lost");
    proxy.release();
    await until(
      async () =>
        (await snapshot()).connection?.state === "ready" &&
        project(await snapshot())?.state?.connected,
      "history connection restores",
    );
    await until(
      async () =>
        (await page.getByTestId("areal-workbench").getAttribute("data-thread-id")) === threadId,
      "original conversation remains selected",
    );
    await page
      .getByTestId("chat-view")
      .getByText("RECOVERY_HISTORY_SENTINEL_1", { exact: true })
      .waitFor();
    await page
      .getByTestId("chat-view")
      .getByText("RECOVERY_HISTORY_SENTINEL_2", { exact: true })
      .waitFor();
    assert.deepEqual(displayTurns(thread(await snapshot()).turns), history);
    assert.equal(workRequests(), readModel);
    assert.equal(await unknown.count(), 0, "A read interruption must not invent a pending send");
    checks.push(
      "real UI history-open read response interrupted; reconnect retains visible original history and starts no model work",
    );
    await json(join(evidence, "read-fault.json"), read);
    await capture("06-history-restored");
    const readAuthoritativeThread = async () =>
      readCoreThread({ binary, env, gui, threadId, workspace, project: project(await snapshot()) });
    const persistedHistory = displayTurns((await readAuthoritativeThread()).turns);
    assert.deepEqual(
      persistedHistory.map((turn) => turn.id),
      history.map((turn) => turn.id),
    );
    await stopGUI();
    await cleanup(run);
    await proxy.close();
    proxy = null;
    await launch();
    await until(
      async () => project(await snapshot())?.state?.connected,
      "same private project restored after fresh Main launch",
    );
    await createProjectConversation(page, "workspace");
    await page.getByTestId(`task-item-${threadId}`).click();
    await page
      .getByTestId("chat-view")
      .getByText("RECOVERY_HISTORY_SENTINEL_2", { exact: true })
      .waitFor();
    assert.deepEqual(displayTurns((await readAuthoritativeThread()).turns), persistedHistory);
    assert.equal(workRequests(), readModel);
    checks.push(
      "fresh source Electron process opens original history from a new draft by sidebar click without replay",
    );
    await capture("07-fresh-process-history");
    await stopGUI();
    manifest.threadId = threadId;
    manifest.projectId = projectId;
    manifest.modelWorkRequests = workRequests();
  } catch (error) {
    failure = error.stack ?? String(error);
    if (page && app)
      await capture("failure").catch((cause) => errors.push(`failure capture: ${cause.message}`));
  } finally {
    proxy?.release();
    if (app) {
      await stopGUI().catch(async (error) => {
        errors.push(`normal GUI exit: ${error.message}`);
        await app?.evaluate(({ app }) => app.exit(1)).catch(() => {});
      });
    }
    if (application)
      await application.close().catch((error) => errors.push(`owner fixture: ${error.message}`));
    if (proxy) await proxy.close().catch((error) => errors.push(`proxy cleanup: ${error.message}`));
    if (model) {
      model.closeAllConnections();
      await new Promise((resolve) => model.close(resolve));
    }
    try {
      await json(join(evidence, "cleanup.json"), await cleanup(run));
    } catch (error) {
      errors.push(`cleanup: ${error.stack}`);
    }
    if (sha(await readFile(binary)) !== build.binarySHA256)
      errors.push("Core binary changed during acceptance");
    if (
      sha(
        execFileSync("git", ["diff", "--binary", "HEAD"], {
          cwd: root,
          maxBuffer: 32 * 1024 * 1024,
        }),
      ) !== build.diffSHA256 ||
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim() !==
        build.commit
    )
      errors.push("Source checkout changed during acceptance");
    for (const [path, hash] of Object.entries(build.rendererSHA256))
      if (sha(await readFile(path)) !== hash)
        errors.push(`Renderer build changed during acceptance: ${path}`);
    await json(join(evidence, "model-requests.json"), requests);
    await json(join(evidence, "transport-events.json"), events);
    await writeFile(join(evidence, "electron.stderr.log"), stderr.join(""));
    Object.assign(manifest, { passed: !failure && errors.length === 0, failure });
    await json(join(evidence, "manifest.json"), manifest);
    console.log(JSON.stringify({ passed: manifest.passed, evidence, checks, failure, errors }));
    if (!manifest.passed) process.exitCode = 1;
  }
} else {
  console.log("Usage: node recovery-electron-smoke.mjs doctor|run|cleanup <evidence>");
  if (command && command !== "--help") process.exitCode = 2;
}
