import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const { WebSocketServer } = require("ws");
const {
  PROTOCOL,
  COMMAND_CONTRACT,
} = require("@areal/workbench-service/desktop/core/service-protocol.cjs");
const scratch = await makeTempDir("areal-legacy-startup-window-");
const source = {
  head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: gui, encoding: "utf8" }).trim(),
  diffSha256: createHash("sha256")
    .update(
      execFileSync("git", ["diff", "HEAD", "--", "clients/gui"], { cwd: resolve(gui, "../..") }),
    )
    .digest("hex"),
  scriptSha256: createHash("sha256")
    .update(await readFile(fileURLToPath(import.meta.url)))
    .digest("hex"),
};
const home = join(scratch, "core"),
  userData = join(scratch, "electron");
await mkdir(home);
await mkdir(userData);
await mkdir(join(scratch, "user"));
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await once(server, "listening");
const metadata = {
  protocol: PROTOCOL,
  endpoint: `ws://127.0.0.1:${server.address().port}`,
  token: "a".repeat(64),
  identity: "legacy-window-fixture",
  pid: process.pid,
};
await writeFile(join(home, "service.json"), JSON.stringify(metadata));
const threadId = "saved-thread",
  projectId = "saved-project",
  draft = "UNSENT_LEGACY_STARTUP_DRAFT";
const thread = {
  id: threadId,
  preview: "Saved history",
  status: { type: "idle" },
  turns: [
    {
      id: "saved-turn",
      status: "completed",
      items: [{ id: "saved-message", type: "agentMessage", text: "SAVED_HISTORY_PRESERVED" }],
    },
  ],
};
const project = {
  id: projectId,
  root: home,
  state: {
    connected: true,
    threads: { [threadId]: thread },
    interactions: {},
    queues: {},
    error: null,
  },
  models: [{ modelId: "default", isDefault: true }],
  profiles: [],
  pending: [],
  configurations: {},
  outcomes: {},
  core: {},
  summaries: [{ id: threadId, preview: "Saved history", status: { type: "idle" } }],
  summariesLoaded: true,
  error: null,
};
const calls = [],
  errors = [],
  observations = [],
  windows = [];
let sequence = 0,
  phase = "seed",
  app,
  page,
  passed = false,
  failure = null;
const packet = () => ({
  sequence: ++sequence,
  snapshot: {
    projects: [project],
    library: {
      projects: {},
      threads: {},
      projectOrder: [projectId],
      settings: { showInMenuBar: false },
    },
  },
  service: {
    pid: process.pid,
    connected: true,
    busy: false,
    clients: 1,
    providerUpdating: false,
    activeCommands: 0,
    starting: 0,
    commandContract: COMMAND_CONTRACT,
  },
});
server.on("connection", (socket, request) => {
  assert.equal(request.headers.authorization, `Bearer ${metadata.token}`);
  socket.on("message", (bytes) => {
    const message = JSON.parse(String(bytes));
    calls.push({ phase, method: message.method, name: message.params?.name });
    if (message.method === "hello" || message.method === "snapshot") {
      socket.send(JSON.stringify({ id: message.id, result: packet() }));
      return;
    }
    if (message.method !== "command" && message.method !== "activity") {
      socket.send(
        JSON.stringify({
          id: message.id,
          error: { code: "FIXTURE_UNSUPPORTED", message: "Unsupported fixture read" },
        }),
      );
      return;
    }
    const name = message.params?.name;
    let result = {};
    if (name === "trajectory")
      result = { enabled: false, state: "disabled", queue: {}, records: [] };
    if (name === "workspace") result = { git: false, branch: null };
    socket.send(JSON.stringify({ id: message.id, result }));
    if (name === "connect" || name === "open")
      socket.send(JSON.stringify({ method: "state", params: packet() }));
  });
});
const env = {
  ...process.env,
  AREAL_CORE_HOME: home,
  AREAL_GUI_USER_DATA: userData,
  AREAL_CORE_USER_HOME: join(scratch, "user"),
  AREAL_HARNESS_HOME: join(scratch, "config"),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_CORE_BIN: process.env.AREAL_CORE_BIN || resolve(gui, "../../target/debug/areal"),
};
for (const key of [
  "ELECTRON_RUN_AS_NODE",
  "AREAL_CORE_WORKSPACE",
  "AREAL_CORE_CONFIG",
  "AREAL_HARNESS_CONFIG",
  "AREAL_CORE_DESKTOP_CONFIG",
])
  delete env[key];
async function launch() {
  app = await electron.launch({
    executablePath: require("electron"),
    args: [join(gui, "app")],
    env,
    timeout: 30000,
  });
  page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByTestId("areal-workbench").waitFor();
  const preferences = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
  );
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  windows.push({
    phase,
    sandbox: preferences.sandbox,
    contextIsolation: preferences.contextIsolation,
    nodeIntegration: preferences.nodeIntegration,
  });
}
console.log(`Legacy startup window evidence: ${scratch}`);
try {
  await launch();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="areal-workbench"]')
        ?.getAttribute("data-startup-ready") === "true",
  );
  await page.evaluate(
    ({ projectId, threadId, draft }) => {
      localStorage.setItem("areal-gui:project", projectId);
      localStorage.setItem(`areal-gui:thread:${projectId}`, threadId);
      localStorage.setItem(`areal-gui:draft:${projectId}:${threadId}`, draft);
    },
    { projectId, threadId, draft },
  );
  await app.close();
  app = null;
  const control = JSON.stringify({ home, state: "unconfirmed", pid: metadata.pid });
  await writeFile(join(userData, "service-control.json"), control);
  phase = "legacy-reopen";
  await launch();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const observed = await app.evaluate(({ BrowserWindow }) => ({
      visible: BrowserWindow.getAllWindows()[0]?.isVisible(),
    }));
    observed.startupReady = await page
      .getByTestId("areal-workbench")
      .getAttribute("data-startup-ready");
    observed.calls = calls.filter((call) => call.phase === phase).length;
    observations.push(observed);
    if (observed.visible && observed.startupReady === "true") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await page.screenshot({ path: join(scratch, "legacy-reopened.png") });
  assert.equal(
    observations.at(-1).visible,
    true,
    "connected legacy recovery must present the real native window",
  );
  assert.equal(observations.at(-1).startupReady, "true");
  await page.getByText("SAVED_HISTORY_PRESERVED", { exact: true }).waitFor();
  assert.equal(await page.getByTestId("chat-input").innerText(), draft);
  assert.equal(await readFile(join(userData, "service-control.json"), "utf8"), control);
  assert.equal(calls.filter((call) => call.phase === phase && call.method === "hello").length, 1);
  assert.equal(calls.filter((call) => call.phase === phase && call.name === "connect").length, 1);
  assert.equal(calls.filter((call) => call.phase === phase && call.name === "open").length, 1);
  assert.equal(
    calls.some(
      (call) =>
        ["stopService", "lifecycleRequest"].includes(call.method) ||
        ["send", "continue", "stop"].includes(call.name),
    ),
    false,
  );
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  failure = { message: error.message, stack: error.stack };
  throw error;
} finally {
  if (app) await app.close();
  for (const socket of server.clients) socket.terminate();
  await new Promise((resolve) => server.close(resolve));
  await writeFile(
    join(scratch, "verification.json"),
    JSON.stringify(
      {
        passed,
        source,
        failure,
        windows,
        calls,
        errors,
        observations,
        boundary:
          "real Electron Main/preload/renderer; controlled authenticated legacy Desktop; no Core/model execution",
      },
      null,
      2,
    ),
  );
}
