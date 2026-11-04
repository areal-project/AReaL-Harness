import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { appendFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { makeTempDir } from "./support/temp.mjs";
import { applicationFixture } from "./application-fixture.mjs";
import { assertApplicationStopped, closeSmokeApplication } from "./application-cleanup.mjs";
import {
  digest,
  sampleSummary,
  saveScheduleEvidence,
} from "./support/schedule-reliability-fixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const gui = resolve(process.env.AREAL_SCHEDULE_GUI_ROOT || join(root, "clients/gui"));
const require = createRequire(join(root, "clients/gui/app/package.json"));
const { _electron: electron } = require("playwright-core");
const { HostClient } = createRequire(join(gui, "app/package.json"))("@areal/client/node");
const { readHostReceipt, readOfflineHostReceipt } = require(
  join(gui, "app/src/core/host-lifecycle.cjs"),
);
assert.ok(
  process.platform !== "darwin" || process.env.AREAL_TEST_HOST_KEYCHAIN === "1",
  "GUI startup writes an isolated subscription transport token to macOS Keychain; set AREAL_TEST_HOST_KEYCHAIN=1 when authorized.",
);
const binary = resolve(process.env.AREAL_CORE_BIN || join(root, "target/debug/areal"));
const mode = process.env.AREAL_SCHEDULE_MODE || "accept";
assert.ok(["baseline", "accept"].includes(mode));
const scratch = await makeTempDir("areal-sl-");
const evidence = await mkdtemp(join(root, ".scratch/schedule-reliability-lifecycle-"));
const requests = [],
  checks = [],
  errors = [],
  cleanup = [],
  samples = [],
  owners = [];
const traceFile = join(evidence, "trace.jsonl");
await writeFile(traceFile, "");
const text = (message) =>
  typeof message.content === "string"
    ? message.content
    : (message.content ?? []).map((part) => part.text ?? "").join("\n");
const isoSeconds = (seconds) => new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
const model = createServer((request, response) => {
  void (async () => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ at: Date.now(), body });
    if (body.stream === false) {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "Fixture" } }] }),
      );
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const contexts = (body.messages ?? [])
      .map(text)
      .filter((value) => value.includes("Current authoritative goal: "));
    const goal = contexts.length
      ? JSON.parse(contexts.at(-1).split("Current authoritative goal: ").at(-1))
      : null;
    const tool = goal?.goal?.limitsPending
      ? { name: "goal_set_limits", args: { expectedRevision: goal.revision, sources: {} } }
      : goal && goal.goal.report?.status !== "complete"
        ? {
            name: "goal_update",
            args: {
              expectedRevision: goal.revision,
              status: "complete",
              summary: "SCHEDULE_LIFECYCLE_DONE",
              evidence: ["Deterministic local fixture completed."],
              remaining: [],
            },
          }
        : null;
    const delta = tool
      ? {
          tool_calls: [
            {
              index: 0,
              id: randomUUID(),
              type: "function",
              function: { name: tool.name, arguments: JSON.stringify(tool.args) },
            },
          ],
        }
      : { content: "SCHEDULE_LIFECYCLE_DONE" };
    response.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  })().catch((error) => {
    errors.push(error.stack);
    response.destroy(error);
  });
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const config = join(scratch, "config.toml");
await mkdir(join(scratch, "user"));
await writeFile(
  config,
  `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n[permissions]\nmode="YOLO"\n`,
);
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
Object.assign(env, {
  AREAL_CORE_BIN: binary,
  AREAL_CORE_CONFIG: config,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: join(scratch, "user"),
  AREAL_HARNESS_HOME: join(scratch, "config-home"),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
});
const fixture = await applicationFixture(
  gui,
  join(scratch, "app"),
  `
const fs=require("node:fs");
const record=value=>fs.appendFileSync(${JSON.stringify(traceFile)},JSON.stringify(value)+"\\n");
globalThis.responses=[];
require("electron").dialog.showMessageBox=async (...args)=>{
 const options=args.at(-1);
 if(options.title==="允许本地开发站点") return {response:1};
 const response=globalThis.responses.shift();
 record({kind:"dialog",options,response});
 if(response===undefined) throw new Error("Unexpected native dialog");
 return {response};
};
const {SharedCoreBackend}=require(${JSON.stringify(join(gui, "app/src/core/service-client.cjs"))});
const stop=SharedCoreBackend.prototype.requestHostStop;
SharedCoreBackend.prototype.requestHostStop=async function(...args){const result=await stop.apply(this,args);record({kind:"stop-receipt",result});return result;};
const {CoreBackend}=require(${JSON.stringify(join(gui, "app/src/core/backend.cjs"))});
const start=CoreBackend.prototype.startProject;
CoreBackend.prototype.startProject=function(projectId,...args){fs.appendFileSync(${JSON.stringify(traceFile)},JSON.stringify({kind:"owner_start",projectId,at:Date.now(),pid:process.pid})+"\\n");return start.call(this,projectId,...args);};
`,
);
const runId = randomUUID();
const appName = `AReaL Schedule SafeStorage Test ${runId}`;
const keychainService = `${appName} Safe Storage`;
const hostService = `org.areal.host.v1.${digest(env.AREAL_HARNESS_SERVICE_HOME)}`;
const electronBundle = join(scratch, "Electron.app");
const electronBinary = join(electronBundle, "Contents/MacOS/Electron");
const plist = join(electronBundle, "Contents/Info.plist");
const installedElectron = process.env.AREAL_ELECTRON_EXECUTABLE || require("electron");
execFileSync("/usr/bin/ditto", [resolve(installedElectron, "../../.."), electronBundle]);
const appDirectory = join(electronBundle, "Contents/Resources/app");
await mkdir(appDirectory, { recursive: true });
execFileSync("/usr/bin/ditto", [
  join(gui, "renderer/dist"),
  join(electronBundle, "Contents/Resources/areal-gui"),
]);
await writeFile(
  join(appDirectory, "package.json"),
  JSON.stringify({ name: "areal-schedule-isolated-test", productName: appName, main: "main.cjs" }),
);
await writeFile(
  join(appDirectory, "main.cjs"),
  `const assert=require("node:assert/strict");
const {app,safeStorage}=require("electron");
assert.equal(app.isReady(),false);
assert.equal(app.getName(),${JSON.stringify(appName)});
assert.equal(process.defaultApp ?? false,false);
const original={object:safeStorage,encrypt:safeStorage.encryptString,decrypt:safeStorage.decryptString};
const setName=app.setName.bind(app);
app.setName=name=>{assert(["AReaL Harness GUI",${JSON.stringify(appName)}].includes(name));setName(${JSON.stringify(appName)});};
Object.defineProperty(app,"isPackaged",{value:false});
app.setAppPath(${JSON.stringify(fixture.path)});
app.once("ready",()=>{assert.equal(app.getName(),${JSON.stringify(appName)});assert.equal(require("electron").safeStorage,original.object);assert.equal(safeStorage.encryptString,original.encrypt);assert.equal(safeStorage.decryptString,original.decrypt);});
require(${JSON.stringify(join(scratch, "app/bootstrap.cjs"))});\n`,
);
for (const [key, value] of [
  ["CFBundleName", appName],
  ["CFBundleDisplayName", appName],
  ["CFBundleIdentifier", `org.areal.schedule.${runId}`],
])
  execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plist]);
execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", electronBundle]);
execFileSync("/usr/bin/codesign", ["--verify", "--strict", electronBundle]);
function security(args) {
  return spawnSync("/usr/bin/security", args, { encoding: "utf8", env });
}
function missing(result) {
  return result.status === 44 && result.stderr.includes("could not be found");
}
async function cleanEntry(service, account) {
  const found = security(["find-generic-password", "-s", service, "-a", account]);
  if (missing(found)) {
    cleanup.push({ service, account, state: "absent" });
    return;
  }
  assert.equal(found.status, 0, `Keychain lookup failed for ${service}/${account}`);
  const keychain = /^keychain: "([^"\n]+)"/m.exec(found.stdout)?.[1];
  assert.ok(keychain?.startsWith("/"));
  const deleted = security(["delete-generic-password", "-s", service, "-a", account, keychain]);
  assert.equal(deleted.status, 0);
  assert.ok(missing(security(["find-generic-password", "-s", service, "-a", account, keychain])));
  cleanup.push({ service, account, keychain, state: "removed" });
}
for (const account of [appName, `${appName} Key`])
  assert.ok(missing(security(["find-generic-password", "-s", keychainService, "-a", account])));
const identity = {
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  sourceStatus: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }),
  diffSha256: digest(execFileSync("git", ["diff"], { cwd: root })),
  harnessSha256: digest(await readFile(fileURLToPath(import.meta.url))),
  binary,
  binarySha256: digest(await readFile(binary)),
  gui,
  electronBinary,
  electronBinarySha256: digest(await readFile(electronBinary)),
  electronPlistSha256: digest(await readFile(plist)),
  safeStorageService: keychainService,
  hostVaultService: hostService,
  node: process.version,
  electron: require("electron/package.json").version,
};
let app, page, child, failure, primaryId;
let stoppedMetadata,
  hostStopped = false;
const descriptorPath = join(env.AREAL_HARNESS_SERVICE_HOME, "host/host.json");
async function until(read, label, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw Error(`Timeout ${label}`);
}
const snapshot = () => page.evaluate(() => window.arealDesktop.snapshot());
async function call(name, request) {
  const reply = await page.evaluate(
    ({ name, request }) => window.arealDesktop.command(name, request),
    { name, request },
  );
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.value;
}
async function check(name, run) {
  try {
    checks.push({ name, passed: true, detail: await run() });
  } catch (error) {
    checks.push({ name, passed: false, error: error.stack });
  }
}
async function launch({ reconnectStopped = false } = {}) {
  stoppedMetadata = undefined;
  hostStopped = false;
  app = await electron.launch({
    executablePath: electronBinary,
    args: [],
    env,
    timeout: 120000,
  });
  app.process().stderr.on("data", (chunk) => {
    void appendFile(join(evidence, "electron.stderr.log"), chunk);
    if (chunk.toString().includes("Waiting for the debugger to disconnect"))
      cleanup.push({
        kind: "debugger disconnect requested",
        at: Date.now(),
        pid: app?.process().pid,
      });
  });
  child = app.process();
  page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  if (reconnectStopped) {
    await until(async () => {
      const connection = (await snapshot()).connection;
      return connection?.state === "unavailable" && connection.recovery === "reconnect";
    }, "completed Host stop offers explicit reconnect");
    await page.getByRole("button", { name: "重新连接后台", exact: true }).click();
    cleanup.push({ kind: "explicit UI reconnect", at: Date.now(), pid: child.pid });
  }
  await until(async () => (await snapshot()).connection?.state === "ready", "Main/Host ready");
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1488, 1056);
    w.show();
    w.focus();
  });
}
async function stopFixture() {
  const metadata = await readFile(descriptorPath, "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code !== "ENOENT" || !stoppedMetadata) throw error;
      return null;
    });
  if (!metadata) {
    await assertApplicationStopped(binary, env, stoppedMetadata);
    hostStopped = true;
    cleanup.push({ kind: "already confirmed Host stop", metadata: stoppedMetadata });
    return;
  }
  if (app) await quit();
  const host = new HostClient();
  try {
    await host.connect(env.AREAL_HARNESS_SERVICE_HOME);
    assert.equal(host.hostId, metadata.hostId);
    assert.equal(host.generation, metadata.generation);
    const directory = join(env.AREAL_HARNESS_SERVICE_HOME, "host/operations");
    const unresolved = (receipt) =>
      ["acceptedPending", "admissionUnknown", "settlementIncomplete"].includes(receipt.state) ||
      receipt.migration?.phase === "draining" ||
      receipt.projects?.some((target) => !["completed", "blocked"].includes(target.receipt?.state));
    for (const name of await readdir(directory)) {
      const { receipt: original } = JSON.parse(await readFile(join(directory, name), "utf8"));
      if (!unresolved(original)) continue;
      const observation = { kind: "prior lifecycle reconciliation", original };
      cleanup.push(observation);
      await until(async () => {
        const { operation } = await host.operation(original.requestId);
        observation.operation = operation;
        assert.ok(operation, `UNKNOWN original lifecycle operation ${original.requestId}`);
        assert.equal(operation.requestId, original.requestId);
        assert.equal(operation.hostId, original.hostId);
        assert.equal(operation.generation, original.generation);
        return !unresolved(operation);
      }, `settle original lifecycle operation ${original.requestId}`);
    }
    const reference = {
      kind: "stopHost",
      requestId: randomUUID(),
      home: env.AREAL_HARNESS_SERVICE_HOME,
      hostId: host.hostId,
      generation: host.generation,
      strategy: "cancel",
    };
    const observation = { kind: "fixture stop", reference };
    cleanup.push(observation);
    let receipt;
    try {
      receipt = readHostReceipt(
        reference,
        await host.stop(reference.requestId, reference.generation, reference.strategy),
      );
    } catch (error) {
      observation.error = { code: error.code, message: error.message };
      host.close();
      receipt = await readOfflineHostReceipt(binary, reference);
    }
    observation.receipt = receipt ?? null;
    assert.ok(
      receipt,
      `UNKNOWN fixture stop ${reference.requestId}; original request not replayed`,
    );
    assert.equal(receipt.state, "completed");
  } finally {
    host.close();
  }
  await assertApplicationStopped(binary, env, metadata);
  stoppedMetadata = metadata;
  hostStopped = true;
  cleanup.push({
    pid: metadata.pid,
    hostId: metadata.hostId,
    generation: metadata.generation,
    stopped: true,
    kind: "fixture teardown",
  });
}
async function quit(stopHost = false) {
  const metadata = JSON.parse(await readFile(descriptorPath, "utf8"));
  if (stopHost) {
    await app.evaluate(({ Menu }) => {
      globalThis.responses = [1];
      const menu = Menu.getApplicationMenu().items[0].submenu;
      const index = menu.items.findIndex((item) => item.id === "shared-host-activity");
      if (index < 0) throw new Error("Missing Host menu");
      menu.items[index + 1].click();
    });
    await until(async () => {
      const events = (await readFile(traceFile, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse);
      return events.some(
        (event) => event.kind === "stop-receipt" && event.result?.operation?.phase === "completed",
      );
    }, "menu Host stop completed");
  }
  const closed = page.waitForEvent("close", { timeout: 60000 });
  cleanup.push({ kind: "application quit requested", at: Date.now(), pid: child.pid });
  await app
    .evaluate(({ app }) => {
      globalThis.responses = [0];
      app.quit();
    })
    .catch((error) => {
      if (!/closed|destroyed|Target/.test(error.message)) throw error;
    });
  await closed;
  cleanup.push({ kind: "GUI window closed", at: Date.now(), pid: child.pid });
  const driverClose = await Promise.race([
    app.close().then(() => "completed"),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 5000)),
  ]);
  cleanup.push({ kind: "Playwright close", state: driverClose, at: Date.now(), pid: child.pid });
  await until(() => child.exitCode !== null || child.signalCode !== null, "GUI process exit");
  assert.equal(child.exitCode, 0, "GUI process completely exited");
  cleanup.push({
    kind: "GUI process exited",
    exitCode: child.exitCode,
    at: Date.now(),
    pid: child.pid,
  });
  app = null;
  if (stopHost) {
    await assertApplicationStopped(binary, env, metadata);
    stoppedMetadata = metadata;
    hostStopped = true;
    cleanup.push({
      pid: metadata.pid,
      hostId: metadata.hostId,
      generation: metadata.generation,
      stopped: true,
      kind: "menu Host stop and product app.quit",
    });
  }
}
async function persisted(owner) {
  const directory = join(scratch, "core", owner.projectId, "state/desktop");
  const bytes = await readFile(join(directory, "task-mode.json"));
  const catalog = JSON.parse(bytes);
  const head = catalog.tasks[digest(owner.taskId)];
  assert.ok(head, "committed catalog retains task identity");
  const body = await readFile(join(directory, "task-ledger", head.body));
  assert.equal(digest(body), head.body, "immutable task body checksum");
  assert.equal(body.length, head.hot_bytes, "immutable task body bounds");
  const task = JSON.parse(body);
  assert.equal(task.id, owner.taskId);
  return { task, rootDigest: digest(bytes), readAt: Date.now() };
}
async function newOwner(objective, at, misfire = { kind: "coalesce" }) {
  const owner = await call("projectless", { operation: "prepare", requestId: randomUUID() });
  await call("connect", { projectId: owner.projectId });
  const source = await call("create", { projectId: owner.projectId, requestId: randomUUID() });
  const task = await call("manage", {
    operation: "taskCreate",
    projectId: owner.projectId,
    requestId: randomUUID(),
    mode: "scheduled",
    objective,
    sourceThreadId: source.threadId,
    interactionMode: "interactive",
    scheduleV2: {
      version: 1,
      rule: { kind: "onceIso", atIso: isoSeconds(at) },
      misfire,
      overlap: "skip",
    },
  });
  return { projectId: owner.projectId, root: owner.cwd, taskId: task.id, at };
}
try {
  await launch();
  const primary = join(scratch, "primary");
  await mkdir(primary);
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, primary);
  await page.evaluate(() => window.arealDesktop.chooseProject());
  primaryId = (
    await until(
      async () =>
        (await snapshot()).projects.find(
          (project) => project.root === primary && project.state?.connected,
        ),
      "primary ready",
    )
  ).id;
  const firstDue = Math.floor(Date.now() / 1000) + 60;
  for (let index = 0; index < 5; index++)
    owners.push(await newOwner(`SCHEDULE_UNOPENED_${index}`, firstDue + index * 8));
  await page.evaluate((id) => localStorage.setItem("areal-gui:project", id), primaryId);
  await stopFixture();
  await launch();
  await page.getByRole("button", { name: "首页", exact: true }).click();
  await check("unopened-due-admission", async () => {
    for (const owner of owners) {
      const committed = await until(
        async () => {
          const read = await persisted(owner);
          return read.task.runs.length && read;
        },
        `unopened owner ${owner.projectId} admitted`,
        Math.max(1000, owner.at * 1000 + 8000 - Date.now()),
      );
      const run = committed.task.runs[0];
      samples.push({
        ms: committed.readAt - owner.at * 1000,
        scheduledAt: owner.at,
        observedAt: committed.readAt,
        taskId: owner.taskId,
        runId: run.id,
        rootDigest: committed.rootDigest,
      });
      assert.equal(
        committed.task.runCount,
        1,
        "one scheduled occurrence admits exactly one durable Run",
      );
      assert.equal(run.scheduledAt, owner.at);
      assert.ok(
        samples.at(-1).ms <= 5000,
        "ready owner due-to-observed durable admission must be within5s",
      );
    }
    return sampleSummary(samples);
  });
  await check("all-five-exactly-once", async () => {
    const rows = await Promise.all(owners.map(persisted));
    assert.equal(rows.length, 5);
    assert.ok(rows.every((row) => row.task.runCount === 1));
    assert.ok(requests.length > 0, "deterministic model actually received admitted work");
    return rows.map((row) => ({
      id: row.task.id,
      runCount: row.task.runCount,
      rootDigest: row.rootDigest,
    }));
  });
  const owner = owners[0];
  await call("connect", { projectId: owner.projectId });
  await until(
    async () =>
      (await persisted(owner)).task.runs.every((run) =>
        ["completed", "failed", "cancelled"].includes(run.status),
      ),
    "first owner settled",
  );
  await check("explicit-stop-is-respected", async () => {
    let task = await call("manage", {
      operation: "task",
      projectId: owner.projectId,
      taskId: owner.taskId,
    });
    task = await call("manage", {
      operation: "taskPause",
      projectId: owner.projectId,
      taskId: task.id,
      expectedRevision: task.revision,
    });
    task = await call("manage", {
      operation: "taskUpdate",
      projectId: owner.projectId,
      taskId: task.id,
      expectedRevision: task.revision,
      scheduleV2: {
        version: 1,
        rule: {
          kind: "intervalIso",
          atIso: isoSeconds(Math.ceil(Date.now() / 1000) + 15),
          intervalSeconds: 2,
        },
        misfire: { kind: "coalesce" },
        overlap: "skip",
      },
    });
    task = await call("manage", {
      operation: "taskResume",
      projectId: owner.projectId,
      taskId: task.id,
      expectedRevision: task.revision,
    });
    assert.equal(task.paused, false);
    assert.ok(
      task.nextRunAt !== null,
      "stopped owner would otherwise remain eligible for startup activation",
    );
    const beforeCount = task.runCount;
    const host = new HostClient();
    try {
      await host.connect(env.AREAL_HARNESS_SERVICE_HOME);
      const target = (await host.status()).projects.find(
        (item) => item.registration?.workspace === owner.root,
      );
      assert.ok(target?.service);
      const requestId = randomUUID();
      let receipt;
      try {
        receipt = await host.stopProject(
          requestId,
          target.registration.projectId,
          target.service.generation,
          "cancel",
        );
      } catch {
        host.close();
        await host.connect(env.AREAL_HARNESS_SERVICE_HOME);
        receipt = (await host.operation(requestId)).operation;
      }
      assert.equal(receipt.state, "completed");
      const stoppedAt = Date.now();
      assert.ok(
        stoppedAt < task.nextRunAt * 1000,
        "stop must finish before the scheduled occurrence",
      );
      await call("tasks", { operation: "observe", limit: 1024 });
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, task.nextRunAt * 1000 + 3000 - Date.now())),
      );
      const trace = (await readFile(traceFile, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse);
      assert.deepEqual(
        trace.filter((event) => event.projectId === owner.projectId && event.at > stoppedAt),
        [],
        "passive directory and coordinator do not undo explicitstop",
      );
      assert.equal(
        (await persisted(owner)).task.runCount,
        beforeCount,
        "stopped generation admits no further due Run",
      );
      return { receipt, stoppedAt, beforeCount };
    } finally {
      host.close();
    }
  });
  const backgroundAt = Math.floor(Date.now() / 1000) + 20;
  const background = await newOwner("SCHEDULE_GUI_CLOSED", backgroundAt);
  const backgroundHost = new HostClient();
  await backgroundHost.connect(env.AREAL_HARNESS_SERVICE_HOME);
  const backgroundGeneration = backgroundHost.generation;
  backgroundHost.close();
  await page.evaluate((id) => localStorage.setItem("areal-gui:project", id), primaryId);
  await quit();
  await check("host-admits-after-gui-exit", async () => {
    const host = new HostClient();
    try {
      await host.connect(env.AREAL_HARNESS_SERVICE_HOME);
      assert.equal(host.generation, backgroundGeneration);
    } finally {
      host.close();
    }
    const read = await until(
      async () => {
        const value = await persisted(background);
        return value.task.runCount === 1 && value;
      },
      "Host admits scheduled occurrence after GUI exit",
      Math.max(1000, backgroundAt * 1000 + 10000 - Date.now()),
    );
    assert.equal(read.task.runs[0].scheduledAt, backgroundAt);
    return {
      guiExitCode: child.exitCode,
      hostGeneration: backgroundGeneration,
      taskId: background.taskId,
      rootDigest: read.rootDigest,
    };
  });
  await launch();
  const quitAt = Math.floor(Date.now() / 1000) + 30;
  const offline = await newOwner("SCHEDULE_QUIT_COALESCE", quitAt);
  const skipped = await newOwner("SCHEDULE_QUIT_SKIP", quitAt, {
    kind: "skip",
    maxLatenessSeconds: 0,
  });
  await page.evaluate((id) => localStorage.setItem("areal-gui:project", id), primaryId);
  await quit(true);
  assert.ok(Date.now() < quitAt * 1000, "app quit before the scheduled occurrence");
  await until(
    () => Date.now() > quitAt * 1000 + 2500,
    "offline occurrence elapsed",
    Math.max(1000, quitAt * 1000 + 5000 - Date.now()),
  );
  await check("quit-has-no-new-admission", async () => {
    const read = await Promise.all([persisted(offline), persisted(skipped)]);
    assert.ok(read.every((value) => value.task.runCount === 0));
    return read.map((value) => ({
      id: value.task.id,
      runCount: value.task.runCount,
      rootDigest: value.rootDigest,
    }));
  });
  await launch({ reconnectStopped: true });
  await check("reopen-applies-saved-misfire", async () => {
    const coalesced = await until(
      async () => {
        const read = await persisted(offline);
        return read.task.runCount === 1 && read;
      },
      "coalesced unopened owner after reopen",
      10000,
    );
    const missed = await until(
      async () => {
        const read = await persisted(skipped);
        return read.task.nextRunAt === null && read;
      },
      "saved skip policy after reopen",
      10000,
    );
    assert.equal(missed.task.runCount, 0);
    assert.equal(missed.task.lastTriggerDecision?.outcome?.kind, "missedWindow");
    assert.equal(coalesced.task.runCount, 1);
    return { coalesced: coalesced.task, skipped: missed.task };
  });
  await page.screenshot({ path: join(evidence, "final.png") });
  await writeFile(join(evidence, "final.aria.txt"), await page.locator("body").ariaSnapshot());
} catch (error) {
  failure = error.stack;
  if (page) await page.screenshot({ path: join(evidence, "failure.png") }).catch(() => {});
} finally {
  await stopFixture().catch((error) => {
    failure ??= error.stack;
  });
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await closeSmokeApplication(app).catch((error) => {
      failure ??= error.stack;
    });
    app = null;
  }
  await fixture.close();
  try {
    if (!hostStopped)
      cleanup.push({
        kind: "credentials retained",
        reason: "Host stop is not confirmed; inspect original lifecycle requests before cleanup",
      });
    else {
      for (const account of [appName, `${appName} Key`]) await cleanEntry(keychainService, account);
      const directory = join(env.AREAL_HARNESS_SERVICE_HOME, "host/vault-operations");
      for (const name of await readdir(directory).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      })) {
        const receipt = JSON.parse(await readFile(join(directory, name), "utf8"));
        assert.equal(name, `${receipt.requestId}.json`);
        assert.equal(receipt.method, "vault.replace");
        assert.match(
          receipt.entryId,
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        await cleanEntry(hostService, receipt.entryId);
      }
    }
  } catch (error) {
    failure ??= error.stack;
  }
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  if (digest(await readFile(binary)) !== identity.binarySha256)
    failure ??= "Core binary changed during run";
  const result = {
    passed: !failure && errors.length === 0 && checks.every((check) => check.passed),
    mode,
    failure,
    identity,
    scratch,
    evidence,
    owners,
    samples,
    summary: sampleSummary(samples),
    checks,
    errors,
    cleanup,
    boundaries: [
      "Real source Electron/Main/Host/Core with local deterministic model and public bridge project/task/lifecycle commands; task dialog creation is not exercised.",
      "Isolated Electron clone uses a distinct native safeStorage identity; HOME remains native and Core, GUI and Host homes are isolated.",
      "Host stop uses the application menu; native confirmation and folder picker responses are injected.",
      "No task read command is issued while observing unopened-owner admission. Immutable body/root hashes are read without starting Core.",
      "Due latency is an upper bound from scheduled wall time to observer seeing a Run in committed root, including25ms observation polling.",
      "First5future owners have staggered due times8s apart to avoid concurrent model work.",
      "UNKNOWN/no-replay and unsettled tool cleanup are covered only by separately executed recovery regressions, not this script.",
    ],
  };
  await saveScheduleEvidence(evidence, "manifest", result);
  await saveScheduleEvidence(evidence, "model-requests", requests);
  console.log(`Evidence: ${evidence}`);
  console.log(
    JSON.stringify({ passed: result.passed, summary: result.summary, checks, failure }, null, 2),
  );
  if (failure || (mode === "accept" && !result.passed)) process.exitCode = 1;
}
