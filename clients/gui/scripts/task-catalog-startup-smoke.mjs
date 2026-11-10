import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { assertApplicationStopped, closeSmokeApplication } from "./application-cleanup.mjs";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const binary = process.env.AREAL_CORE_BIN || resolve(gui, "../../target/debug/areal");
const binarySha256 = createHash("sha256")
  .update(await readFile(binary))
  .digest("hex");
const scratch = await makeTempDir("areal-task-catalog-startup-");
const primaryWorkspace = join(scratch, "primary-workspace"),
  userHome = join(scratch, "user");
const gate = join(scratch, "hold-provider-sync"),
  traceFile = join(scratch, "startup-trace.jsonl");
const handshakeGate = join(scratch, "hold-handshake");
const targetFile = join(scratch, "target-project");
const slowHandshake = process.env.AREAL_TASK_CATALOG_SLOW_HANDSHAKE === "1";
const launchApp = join(scratch, "app");
const objective = "STARTUP_CATALOG_SAVED_TASK";
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: gui,
  encoding: "utf8",
}).trim();
const sourceDiff = execFileSync("git", ["diff", "--stat"], { cwd: gui, encoding: "utf8" });
const sourceDiffSha256 = createHash("sha256")
  .update(execFileSync("git", ["diff"], { cwd: gui }))
  .digest("hex");
const baselineSource = process.env.AREAL_TASK_CATALOG_BASELINE
  ? resolve(process.env.AREAL_TASK_CATALOG_BASELINE)
  : undefined;
const baselineSha256 = baselineSource
  ? createHash("sha256")
      .update(await readFile(baselineSource))
      .digest("hex")
  : undefined;
const testSha256 = createHash("sha256")
  .update(await readFile(fileURLToPath(import.meta.url)))
  .digest("hex");
const command = [process.execPath, ...process.argv.slice(1)];
const startedAt = new Date().toISOString();
const errors = [],
  checks = [],
  catalogEvents = [],
  cleanup = [],
  navigationObservations = [];
let app,
  page,
  projectId,
  primaryProjectId,
  savedTask,
  workspaceTask,
  startupObservation,
  heldObservation,
  eventualObservation,
  failure,
  passed = false;
await Promise.all([
  mkdir(primaryWorkspace),
  mkdir(join(userHome, ".areal"), { recursive: true }),
  mkdir(launchApp),
]);
await writeFile(traceFile, "");
await writeFile(
  join(userHome, ".areal/config.toml"),
  'schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:9/v1/chat/completions"\n[permissions]\nmode="YOLO"\n',
);
const deployment = join(scratch, "desktop.json");
await writeFile(
  deployment,
  JSON.stringify({
    profiles: [
      {
        id: "standard",
        revision: "v1",
        displayName: "Fixture",
        instructions: "Do not run this future task.",
      },
    ],
  }),
);
const env = {
  ...process.env,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: userHome,
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_CORE_DESKTOP_CONFIG: deployment,
  AREAL_CORE_BIN: binary,
};
for (const key of [
  "AREAL_CORE_WORKSPACE",
  "AREAL_CORE_CONFIG",
  "AREAL_HARNESS_HOME",
  "AREAL_HARNESS_CONFIG",
])
  delete env[key];
await writeFile(
  join(launchApp, "package.json"),
  JSON.stringify({ name: "task-catalog-startup-fixture", main: "bootstrap.cjs" }),
);
await writeFile(
  join(launchApp, "bootstrap.cjs"),
  `
const fs = require('node:fs');
if (${JSON.stringify(baselineSource || null)}) {
 const Module = require('node:module');
 const compile = Module._extensions['.cjs'] ?? Module._extensions['.js'];
 Module._extensions['.cjs'] = function(module, file) {
  if (file === ${JSON.stringify(join(gui, "../../services/workbench/src/desktop/core/task-catalog.cjs"))}) return module._compile(fs.readFileSync(${JSON.stringify(baselineSource || "")}, 'utf8'), file);
  return compile(module, file);
 };
}
const {CoreBackend} = require(${JSON.stringify(join(gui, "../../services/workbench/src/desktop/core/backend.cjs"))});
const {AppProviders} = require(${JSON.stringify(join(gui, "../../services/workbench/src/desktop/core/providers.cjs"))});
const {ProjectConnections} = require(${JSON.stringify(join(gui, "../../services/workbench/src/desktop/core/project-connections.cjs"))});
const record = (kind, fields = {}) => fs.appendFileSync(${JSON.stringify(traceFile)}, JSON.stringify({kind, at:Date.now(), pid:process.pid, ...fields})+'\\n');
process.on('uncaughtExceptionMonitor', (error, origin) => record('uncaught', {origin, message:error.message}));
const connectProject = ProjectConnections.prototype.connect;
ProjectConnections.prototype.connect = async function(project, ...args) {
 if (fs.existsSync(${JSON.stringify(targetFile)}) && project.id === fs.readFileSync(${JSON.stringify(targetFile)}, "utf8") && fs.existsSync(${JSON.stringify(handshakeGate)})) {
  record('handshake_held', {projectId:project.id});
  const deadline = Date.now()+20000;
  while (fs.existsSync(${JSON.stringify(handshakeGate)}) && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,25));
 }
 return connectProject.call(this, project, ...args);
};
const sync = AppProviders.prototype.reconcileProject;
if (typeof sync !== 'function') throw new Error('Provider reconciliation startup boundary is unavailable');
AppProviders.prototype.reconcileProject = async function(project, ...args) {
 if (fs.existsSync(${JSON.stringify(targetFile)}) && project.id === fs.readFileSync(${JSON.stringify(targetFile)}, "utf8") && fs.existsSync(${JSON.stringify(gate)})) {
  record('provider_sync_held', {projectId:project.id, clientReady:project.client?.ready, generation:project.connectionGeneration});
  const deadline = Date.now()+20000;
  while (fs.existsSync(${JSON.stringify(gate)}) && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,25));
  record('provider_sync_released', {projectId:project.id});
 }
 return sync.call(this, project, ...args);
};
const startProject = CoreBackend.prototype.startProject;
CoreBackend.prototype.startProject = async function(id) {
 record('startup_begin', {projectId:id});
 try { const result=await startProject.call(this,id); record('startup_end',{projectId:id,connected:result.model.state.connected}); return result; }
 catch(error) { record('startup_error',{projectId:id,message:error.message}); throw error; }
};
const execute = CoreBackend.prototype.executeCommand;
CoreBackend.prototype.executeCommand = async function(name, request, context) {
 if (name!=='tasks') return execute.call(this,name,request,context);
 record('catalog_command_begin',{requestId:request.requestId,projectId:request.projectId});
 try { const result=await execute.call(this,name,request,context); record('catalog_command_end',{requestId:request.requestId,projectId:request.projectId,rows:result.data.map(task=>task.id),errors:result.errors}); return result; }
 catch(error) { record('catalog_command_error',{message:error.message}); throw error; }
};
(async()=>{
 const {CoreClient}=await import(${JSON.stringify(join(gui, "packages/runtime-client/core.js"))});
 const connect=CoreClient.prototype.connect, request=CoreClient.prototype.request;
 CoreClient.prototype.connect=async function(...args) {const result=await connect.apply(this,args);record('client_authenticated',{ready:this.ready});return result;};
 CoreClient.prototype.request=async function(method,params,...args) {
  if (method!=='areal/task/directory/list') return request.call(this,method,params,...args);
  record('task_list_begin',{params});
  const result=await request.call(this,method,params,...args);
  record('task_list_end',{rows:result.data.map(task=>task.id)});
  return result;
 };
 require(${JSON.stringify(join(gui, "app/src/main.cjs"))});
})().catch(error=>{record('bootstrap_error',{message:error.message});process.exitCode=1;});
`,
);

async function until(fn, label, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timeout: ${label}`);
}
const snapshot = () => page.evaluate(() => window.arealDesktop.snapshot());
const trace = async () =>
  (await readFile(traceFile, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
async function call(name, params) {
  const reply = await page.evaluate(
    ({ name, params }) => window.arealDesktop.command(name, params),
    { name, params },
  );
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.value;
}
async function launch() {
  app = await electron.launch({
    executablePath: process.env.AREAL_ELECTRON_EXECUTABLE || require("electron"),
    args: [launchApp],
    env,
    timeout: 120000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.text().startsWith("[task-catalog] ")) {
      try {
        catalogEvents.push(JSON.parse(message.text().slice("[task-catalog] ".length)));
      } catch {}
    }
  });
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(1488, 1056);
    window.show();
    window.focus();
  });
  await page.bringToFront();
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await until(
    async () => (await snapshot()).connection?.state === "ready",
    "desktop adapter ready",
  );
}
async function closeApplication() {
  if (!app) return;
  const metadata = await readFile(join(scratch, "core/service.json"), "utf8")
    .then(JSON.parse)
    .catch(() => null);
  await app
    .evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0 });
    })
    .catch(() => {});
  const stop = JSON.parse(
    execFileSync(binary, ["host", "stop", "--cancel", "--json"], {
      env: { ...env, AREAL_HARNESS_HOME: env.AREAL_HARNESS_SERVICE_HOME },
      encoding: "utf8",
    }),
  );
  assert.equal(stop.state, "completed");
  assert.ok(stop.projects.every((project) => project.receipt?.state === "completed"));
  await writeFile(join(scratch, `host-stop-${cleanup.length}.json`), JSON.stringify(stop, null, 2));
  await closeSmokeApplication(app);
  app = undefined;
  page = undefined;
  await assertApplicationStopped(binary, env, metadata);
  cleanup.push({
    at: new Date().toISOString(),
    stopped: true,
    adapterPid: metadata?.pid,
    receipt: stop,
  });
}
async function capture(name) {
  await writeFile(join(scratch, `${name}-state.json`), JSON.stringify(await snapshot(), null, 2));
  await writeFile(join(scratch, `${name}.aria.txt`), await page.locator("body").ariaSnapshot());
  await page.screenshot({ path: join(scratch, `${name}.png`) });
}
try {
  await launch();
  const prepared = await call("projectless", {
    operation: "prepare",
    requestId: randomUUID(),
  });
  await call("connect", { projectId: prepared.projectId });
  const project = await until(
    async () =>
      (await snapshot()).projects.find(
        (owner) => owner.id === prepared.projectId && owner.state?.connected,
      ),
    "fixture project fully ready",
  );
  projectId = project.id;
  await writeFile(targetFile, projectId);
  savedTask = await call("manage", {
    projectId,
    operation: "taskCreate",
    requestId: randomUUID(),
    mode: "scheduled",
    objective,
    interactionMode: "interactive",
    schedule: { at: Math.floor(Date.now() / 1000) + 86400 },
  });
  assert.equal(
    (await call("tasks", { operation: "list", projectId })).data.find(
      (task) => task.id === savedTask.id,
    )?.objectivePreview,
    objective,
  );
  checks.push("Scheduled fixture persists through the production bridge and real Core");
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, primaryWorkspace);
  await page.evaluate(() => window.arealDesktop.chooseProject());
  primaryProjectId = (
    await until(
      async () =>
        (await snapshot()).projects.find(
          (owner) => owner.root === primaryWorkspace && owner.state?.connected,
        ),
      "primary owner fully ready",
    )
  ).id;
  const second = await call("projectless", { operation: "prepare", requestId: randomUUID() });
  workspaceTask = await call("manage", {
    projectId: second.projectId,
    operation: "taskCreate",
    requestId: randomUUID(),
    mode: "scheduled",
    objective: "WORKSPACE_TASK_OUTSIDE_GLOBAL_CATALOG",
    interactionMode: "interactive",
    schedule: { at: Math.floor(Date.now() / 1000) + 86400 },
  });
  await page.evaluate((id) => localStorage.setItem("areal-gui:project", id), primaryProjectId);
  await closeApplication();
  await writeFile(traceFile, "");
  catalogEvents.length = 0;
  await writeFile(gate, "hold unrelated provider configuration after authenticated handshake");
  await writeFile(handshakeGate, "start catalog read before handshake completes");
  await launch();
  await call("connect", { projectId: primaryProjectId });
  await until(
    async () =>
      (await snapshot()).projects.find((owner) => owner.id === primaryProjectId)?.state?.connected,
    "primary owner ready independently of cold task owner",
  );
  await page.evaluate((projectId) => {
    void window.arealDesktop.command("connect", { projectId });
  }, projectId);
  await until(
    async () =>
      (await trace()).find(
        (event) => event.kind === "handshake_held" && event.projectId === projectId,
      ),
    "task owner launch completes before catalog measurement",
  );
  const openedAt = Date.now();
  await page.getByRole("button", { name: "定时任务", exact: true }).click();
  const row = page.getByRole("button", { name: `打开定时任务 ${objective}`, exact: true });
  const batch = await until(
    () => catalogEvents.find((event) => event.kind === "begin"),
    "catalog request begins while handshake held",
  );
  await until(
    () =>
      catalogEvents.some(
        (event) =>
          event.kind === "response_received" &&
          event.requestId === batch.requestId &&
          event.projectId === projectId,
      ),
    "target catalog response while handshake held",
  );
  await row.waitFor();
  assert.equal(
    (await trace()).some(
      (event) => event.kind === "provider_sync_held" && event.projectId === projectId,
    ),
    false,
    "target response precedes authentication",
  );
  assert.equal(
    (await snapshot()).projects.find((owner) => owner.id === projectId)?.state?.connected,
    false,
  );
  await capture("catalog-awaiting-authentication");
  await row.click();
  const spinner = page.getByLabel("正在更新任务状态…", { exact: true });
  await spinner.waitFor();
  assert.equal(await page.getByRole("alert").count(), 0, "pending detail does not hide an error");
  await capture("task-detail-loading");
  if (slowHandshake) {
    const heldAt = (await trace()).find(
      (event) => event.kind === "handshake_held" && event.projectId === projectId,
    ).at;
    const remaining = 6500 - (Date.now() - heldAt);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    startupObservation = {
      alerts: await page.getByRole("alert").allTextContents(),
      events: await trace(),
      catalogEvents: [...catalogEvents],
    };
    assert.equal(
      startupObservation.events.some(
        (event) => event.kind === "provider_sync_held" && event.projectId === projectId,
      ),
      false,
      "target handshake remains held through observation",
    );
    assert.equal(await spinner.isVisible(), true);
    await capture("startup-awaiting-authentication");
  }
  await rm(handshakeGate);
  const held = await until(
    async () =>
      (await trace()).find(
        (event) => event.kind === "provider_sync_held" && event.projectId === projectId,
      ),
    "provider configuration held after handshake",
  );
  assert.equal(held.clientReady, true, "Barrier follows an authenticated Core client");
  let visibleAt;
  await until(
    async () => {
      if (await row.isVisible()) {
        visibleAt = Date.now();
        return true;
      }
      return catalogEvents.some(
        (event) => event.kind === "abandoned" && event.requestId === batch.requestId,
      );
    },
    "saved task row or catalog failure while provider startup is held",
    6000,
  );
  heldObservation = {
    openedAt,
    barrierAt: held.at,
    observedAt: Date.now(),
    visibleAt,
    visible: await row.isVisible(),
    disabled: (await row.count()) ? await row.isDisabled() : null,
    projectConnected: !!(await snapshot()).projects.find((owner) => owner.id === projectId)?.state
      ?.connected,
    alerts: await page.getByRole("alert").allTextContents(),
    events: await trace(),
    catalogEvents: [...catalogEvents],
  };
  await capture("startup-held");
  const liveDirectoryStartedAt = Date.now();
  const liveDirectory = await call("tasks", {
    operation: "list",
    projectId,
    requestId: randomUUID(),
    viewEpoch: 1,
  });
  const liveDirectoryFinishedAt = Date.now();
  const providerReleasedAtRead = (await trace()).some(
    (event) => event.kind === "provider_sync_released" && event.projectId === projectId,
  );
  assert.equal(
    providerReleasedAtRead,
    false,
    "Provider barrier remains held during directory read",
  );
  await writeFile(
    join(scratch, "live-directory.json"),
    JSON.stringify(
      {
        startedAt: liveDirectoryStartedAt,
        finishedAt: liveDirectoryFinishedAt,
        providerReleasedAtRead,
        result: liveDirectory,
      },
      null,
      2,
    ),
  );
  heldObservation.liveDirectory = liveDirectory;
  const holdRemaining = 6500 - (Date.now() - held.at);
  if (holdRemaining > 0) await new Promise((resolve) => setTimeout(resolve, holdRemaining));
  assert.equal(
    (await trace()).some((event) => event.kind === "provider_sync_released"),
    false,
    "Provider barrier remains held throughout observation",
  );
  const releasedAt = Date.now();
  await rm(gate);
  await until(() => row.isVisible(), "saved task eventually visible after provider release");
  const eventuallyVisibleAt = Date.now();
  await until(
    async () =>
      (await snapshot()).projects.find((owner) => owner.id === projectId)?.state?.connected,
    "full owner readiness after unrelated provider work releases",
  );
  await until(() => row.isEnabled(), "task management enabled after full owner readiness");
  eventualObservation = {
    releasedAt,
    eventuallyVisibleAt,
    enabledAt: Date.now(),
    visibleLatencyMs: (visibleAt ?? eventuallyVisibleAt) - openedAt,
    earlyVisibleLatencyMs: visibleAt ? visibleAt - openedAt : null,
    alertCountWhileHeld: heldObservation.alerts.length,
    catalogEventsWhileHeld: heldObservation.catalogEvents,
    events: await trace(),
  };
  await capture("startup-ready");
  await spinner.waitFor({ state: "hidden" });
  await page.getByLabel("定时任务会话").waitFor();
  assert.equal(await page.getByRole("alert").count(), 0);
  await capture("task-detail");
  checks.push("Scheduled task detail opens after owner readiness");
  if (process.env.AREAL_TASK_CATALOG_WEB_HANDOFF === "1") {
    await writeFile(
      join(scratch, "web-handoff.json"),
      JSON.stringify({ home: env.AREAL_HARNESS_SERVICE_HOME, projectId, taskId: savedTask.id }),
    );
    console.log(JSON.stringify({ webHandoff: scratch }));
    await until(
      async () =>
        readFile(join(scratch, "web-done"), "utf8")
          .then(() => true)
          .catch(() => false),
      "Web handoff completion",
      180000,
    );
  }
  assert.ok(
    liveDirectory.owners.some(
      (owner) =>
        owner.projectId === projectId &&
        owner.status === "unobserved" &&
        owner.source === "published" &&
        owner.coverage?.kind === "snapshot",
    ),
    "Held owner reports a published snapshot, not a live read",
  );
  assert.ok(
    liveDirectory.data.some((task) => task.id === savedTask.id),
    "Published snapshot contains the saved task",
  );
  const readyDirectory = await call("tasks", {
    operation: "list",
    projectId,
    requestId: randomUUID(),
    viewEpoch: 2,
  });
  await writeFile(join(scratch, "ready-directory.json"), JSON.stringify(readyDirectory, null, 2));
  assert.ok(
    readyDirectory.owners.some(
      (owner) =>
        owner.projectId === projectId && owner.status === "ready" && owner.source === "live",
    ),
    "Ready owner reports a live directory read",
  );
  assert.ok(
    readyDirectory.data.some((task) => task.id === savedTask.id),
    "Live directory contains the saved task",
  );
  assert.equal(
    (await call("tasks", { operation: "list", projectId })).data.filter(
      (task) => task.id === savedTask.id,
    ).length,
    1,
    "Restart preserves one authoritative saved task",
  );
  checks.push("Provider release completes startup and enables the saved task management row");
  if (slowHandshake) {
    assert.equal(
      startupObservation.alerts.length,
      0,
      "Startup exceeding five seconds must stay pending without catalog timeout",
    );
    assert.ok(
      startupObservation.catalogEvents.some(
        (event) =>
          event.kind === "response_received" &&
          event.requestId === batch.requestId &&
          event.projectId === projectId,
      ),
      "catalog snapshot arrives while authentication is held",
    );
    checks.push(
      "Snapshot and loading detail remain usable during a handshake exceeding five seconds",
    );
  }
  const registeredOwners = (await snapshot()).projects.map((owner) => owner.id).sort();
  assert.ok(registeredOwners.includes(projectId));
  assert.ok(registeredOwners.includes(primaryProjectId));
  const queriedOwners = [
    ...new Set(
      heldObservation.catalogEvents
        .filter(
          (event) => event.kind === "response_received" && event.requestId === batch.requestId,
        )
        .map((event) => event.projectId),
    ),
  ].sort();
  assert.deepEqual(
    queriedOwners,
    registeredOwners,
    "Global catalog responds for all registered owners",
  );
  await page
    .getByRole("button", { name: `打开定时任务 ${workspaceTask.objective}`, exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: `打开定时任务 ${workspaceTask.objective}`, exact: true })
      .count(),
    1,
    "Global scheduled-task navigation includes ready workspace-owned rows",
  );
  checks.push(
    "Global catalog includes registered workspace and independent owners in requests and projected rows",
  );
  assert.equal(
    heldObservation.visible,
    true,
    "Saved task row must appear before unrelated startup warmup releases",
  );
  assert.equal(
    heldObservation.disabled,
    false,
    "Cached task remains openable before full owner readiness",
  );
  assert.equal(
    heldObservation.projectConnected,
    false,
    "Catalog reads must not mark execution ready",
  );
  assert.ok(
    heldObservation.liveDirectory.owners.some(
      (owner) => owner.projectId === projectId && owner.source === "published",
    ) && heldObservation.liveDirectory.data.some((task) => task.id === savedTask.id),
    "Published directory snapshot includes the saved task before warmup release",
  );
  assert.ok(
    heldObservation.catalogEvents.some(
      (event) =>
        event.kind === "owner_committed" &&
        event.requestId === batch.requestId &&
        event.projectId === projectId &&
        event.rows > 0,
    ),
    "Target owner catalog response is committed before warmup release",
  );
  assert.equal(
    heldObservation.alerts.length,
    0,
    "No false owner timeout while authenticated Core is readable",
  );
  assert.deepEqual(errors, [], "No renderer errors");
  assert.equal(
    (await trace()).some((event) => event.kind === "uncaught" || event.kind === "bootstrap_error"),
    false,
    "No fixture or Main process errors",
  );
  checks.push("Catalog response and visible row precede unrelated startup completion");
  for (let index = 0; index < 5; index++) {
    await page.getByRole("button", { name: "首页", exact: true }).click();
    const offset = catalogEvents.length;
    const openedAt = Date.now();
    await page.getByRole("button", { name: "定时任务", exact: true }).click();
    await until(async () => {
      const events = catalogEvents.slice(offset);
      return registeredOwners.every((id) =>
        events.some((event) => event.kind === "response_received" && event.projectId === id),
      );
    }, "registered owner catalog responses after reopening");
    await row.waitFor();
    await page
      .getByRole("button", { name: `打开定时任务 ${workspaceTask.objective}`, exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: `打开定时任务 ${workspaceTask.objective}`, exact: true })
        .count(),
      1,
      "Ready workspace task remains included in the global catalog",
    );
    const events = catalogEvents.slice(offset);
    assert.deepEqual(
      [
        ...new Set(
          events
            .filter((event) => event.kind === "response_received")
            .map((event) => event.projectId),
        ),
      ].sort(),
      registeredOwners,
    );
    navigationObservations.push({
      index,
      openedAt,
      visibleAt: Date.now(),
      visibleLatencyMs: Date.now() - openedAt,
      queryCount: events.filter((event) => event.kind === "response_received").length,
    });
  }
  checks.push(
    "Five global catalog reopens query all registered owners and include ready workspace rows",
  );
  await capture("scoped-navigation");
  assert.deepEqual(errors, [], "No renderer errors after repeated navigation");
  assert.equal(
    (await trace()).some((event) => event.kind === "uncaught" || event.kind === "bootstrap_error"),
    false,
    "No Main errors after repeated navigation",
  );
  passed = true;
} catch (error) {
  failure = error.stack;
  console.error(error.message);
  if (page) await capture("failure").catch(() => {});
} finally {
  await rm(handshakeGate, { force: true });
  await rm(gate, { force: true });
  try {
    await closeApplication();
  } catch (error) {
    cleanup.push({ stopped: false, error: error.stack });
    passed = false;
  }
  await writeFile(join(scratch, "catalog-events.json"), JSON.stringify(catalogEvents, null, 2));
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed,
        startedAt,
        finishedAt: new Date().toISOString(),
        command,
        cwd: process.cwd(),
        testSha256,
        sourceCommit,
        sourceDiff,
        sourceDiffSha256,
        binary,
        binarySha256,
        baselineSource,
        baselineSha256,
        primaryProjectId,
        projectId,
        savedTask,
        workspaceTask,
        checks,
        navigationObservations,
        slowHandshake,
        startupObservation,
        heldObservation,
        eventualObservation,
        failure,
        cleanup,
        errors,
        boundaries: [
          "Real isolated source Electron, preload, Desktop adapter and Core",
          "Production bridge creates independent future tasks; no model response or task list is mocked",
          "Native folder picker selects only the isolated workspace",
          "Filesystem barrier holds AppProviders.reconcileProject after authenticated Core handshake for at least 6.5 seconds",
          "Controlled startup delay verifies catalog responsiveness and does not predict real-account latency",
          "Not an installed app or real provider acceptance",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed,
      scratch,
      checks,
      eventualObservation: eventualObservation && {
        visibleLatencyMs: eventualObservation.visibleLatencyMs,
        earlyVisibleLatencyMs: eventualObservation.earlyVisibleLatencyMs,
        alertCountWhileHeld: eventualObservation.alertCountWhileHeld,
      },
      failure,
      cleanup,
    }),
  );
  if (!passed) process.exitCode = 1;
}
