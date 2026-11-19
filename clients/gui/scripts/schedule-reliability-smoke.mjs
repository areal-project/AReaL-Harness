import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { trackedMkdtemp } from "./support/host-cleanup.cjs";
import { dirname, join, resolve } from "node:path";
import { cpus, loadavg } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { makeTempDir } from "./support/temp.mjs";
import { applicationFixture } from "./application-fixture.mjs";
import {
  assertApplicationStopped,
  closeSmokeApplication,
  readFixtureHost,
  stopFixtureHost,
} from "./application-cleanup.mjs";
import {
  createFixtureThread,
  fixtureWorkbench,
  libraryCommand,
} from "./support/desktop-fixture.mjs";
import { withCore } from "./support/core-observation.mjs";
import {
  digest,
  expandScheduleFixture,
  sampleSummary,
  saveScheduleEvidence,
  scheduleScale,
} from "./support/schedule-reliability-fixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const gui = resolve(process.env.AREAL_SCHEDULE_GUI_ROOT || join(root, "clients/gui"));
const require = createRequire(join(root, "clients/gui/app/package.json"));
const { _electron: electron } = require("playwright-core");
const { HostClient } = require("@areal/client/node");
const binary = resolve(process.env.AREAL_CORE_BIN || join(root, "target/debug/areal"));
const mode = process.env.AREAL_SCHEDULE_MODE || "accept";
assert.ok(["seed", "baseline", "accept", "fault"].includes(mode));
const transportFaults = mode === "fault";
const quickAcceptance =
  scheduleScale.projects === 5 && scheduleScale.tasks === 10 && scheduleScale.scheduled === 10;
const sampleCount = Number(process.env.AREAL_SCHEDULE_SAMPLES || 5);
assert.ok(
  Number.isSafeInteger(sampleCount) && sampleCount >= 5,
  "at least five real samples are required",
);
const previous = process.env.AREAL_SCHEDULE_FIXTURE
  ? JSON.parse(await readFile(process.env.AREAL_SCHEDULE_FIXTURE, "utf8"))
  : undefined;
if (previous) {
  assert.equal(
    previous.cleanup.every((entry) => entry.stopped),
    true,
    "only an owned stopped fixture may be reused",
  );
  assert.match(previous.scratch, /^\/private\/.*\/areal-schedule-(?:reliability-)?[A-Za-z0-9]+$/);
}
const scratch = previous?.scratch || (await makeTempDir("areal-schedule-"));
const evidence = process.env.AREAL_SCHEDULE_EVIDENCE
  ? resolve(process.env.AREAL_SCHEDULE_EVIDENCE)
  : await trackedMkdtemp(join(root, ".scratch/schedule-reliability-"));
await mkdir(evidence, { recursive: true });
const user = join(scratch, "user");
await mkdir(user, { recursive: true });
const modelRequests = [];
const modelPhases = new Set();
const model = transportFaults
  ? createServer((request, response) => {
      void (async () => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        modelRequests.push({ at: Date.now(), body });
        if (body.stream === false) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }),
          );
          return;
        }
        const text = (message) =>
          typeof message.content === "string"
            ? message.content
            : (message.content ?? []).map((part) => part.text ?? "").join("\n");
        const contexts = (body.messages ?? [])
          .map(text)
          .filter((value) => value.includes("Current authoritative goal: "));
        const view = contexts.length
          ? JSON.parse(contexts.at(-1).split("Current authoritative goal: ").at(-1))
          : null;
        const goal = view?.goal;
        const phase = goal && modelPhases.has(goal.id);
        const tool = goal?.limitsPending
          ? { name: "goal_set_limits", args: { expectedRevision: view.revision, sources: {} } }
          : goal?.objective.includes("NOTIFY_QUESTION") && !phase
            ? {
                name: "ask_user_question",
                args: {
                  mode: "async",
                  required: true,
                  timeoutSeconds: 5,
                  questions: [{ id: "choice", title: "Confirm fixture", options: ["yes", "no"] }],
                },
              }
            : goal?.objective.includes("NOTIFY_APPROVAL") && !phase
              ? {
                  name: "fs_create",
                  args: {
                    path: `workspace://repo/notification-${randomUUID()}.txt`,
                    text: "fixture",
                  },
                }
              : goal?.report?.status !== "complete"
                ? {
                    name: "goal_update",
                    args: {
                      expectedRevision: view.revision,
                      status: "complete",
                      summary: "NOTIFY_DONE",
                      evidence: ["Local deterministic model completed."],
                      remaining: [],
                    },
                  }
                : null;
        if (tool && ["ask_user_question", "fs_create"].includes(tool.name))
          modelPhases.add(goal.id);
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: tool ? { tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : { content: "NOTIFY_DONE" }, finish_reason: null }] })}\n\n`,
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
    })
  : null;
if (model) await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const config = join(scratch, "config.toml");
await writeFile(
  config,
  `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model?.address().port ?? 9}/v1/chat/completions"\n[permissions]\nmode="YOLO"\n${transportFaults ? 'ask=["fs_create"]\n' : ""}`,
);
const inherited = { ...process.env };
for (const key of Object.keys(inherited))
  if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE")
    delete inherited[key];
const env = {
  ...inherited,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: user,
  AREAL_HARNESS_HOME: join(scratch, "config-home"),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_CORE_CONFIG: config,
  AREAL_CORE_BIN: binary,
};
const traceFile = join(evidence, "trace.jsonl");
await writeFile(traceFile, "");
const fixture = await applicationFixture(
  gui,
  join(scratch, `app-${randomUUID().slice(0, 8)}`),
  `
const fs = require("node:fs");
const record = (kind, value={}) => fs.appendFileSync(${JSON.stringify(traceFile)}, JSON.stringify({kind,at:Date.now(),pid:process.pid,...value})+"\\n");
${
  transportFaults
    ? `const {Notification}=require("electron");
const nativeShow=Notification.prototype.show;
Notification.prototype.show=function(){record("native_show",{title:this.title,body:this.body});return nativeShow.call(this);};
const transportPath=require.resolve(${JSON.stringify(join(gui, "app/src/core/generated/native-host-transport.cjs"))});
const transport=require(transportPath);
require.cache[transportPath].exports={...transport,createNativeHostTransport(options){
 return transport.createNativeHostTransport({...options,onNotice(notice){
  record("notice_publish",{notice});
  return options.onNotice?.(notice);
 }});
}};`
    : ""
}
`,
);
async function guiFingerprint() {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      if (entry.isFile()) files.push([path.slice(gui.length), digest(await readFile(path))]);
    }
  }
  for (const directory of ["app/src", "app/assets", "renderer/dist", "packages"])
    await walk(join(gui, directory));
  return {
    sha256: digest(JSON.stringify(files.sort((a, b) => a[0].localeCompare(b[0])))),
    files: files.length,
  };
}
const guiBefore = await guiFingerprint();
const sourceDiff = execFileSync("git", ["diff"], { cwd: root });
const identity = {
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  diffSha256: digest(sourceDiff),
  diffStat: execFileSync("git", ["diff", "--stat"], { cwd: root, encoding: "utf8" }),
  harnessSha256: digest(await readFile(fileURLToPath(import.meta.url))),
  binary,
  binarySha256: digest(await readFile(binary)),
  gui,
  guiFingerprint: guiBefore,
  sourceStatus: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }),
  node: process.version,
  electron: require("electron/package.json").version,
  platform: process.platform,
  cpu: cpus()[0]?.model,
  cores: cpus().length,
  loadBefore: loadavg(),
  command: [process.execPath, ...process.argv.slice(1)],
};
const samples = {
  legacyFirstRow: [],
  legacySourceRefresh: [],
  coldFirstRow: [],
  coldSourceRefresh: [],
  warmFirstRow: [],
  allSourceRefresh: [],
  allSourceRpc: [],
  liveMutation: [],
};
const checks = [],
  errors = [],
  cleanup = [],
  catalogEvents = [];
let app,
  page,
  primaryId = previous?.primaryId,
  owners = previous?.owners || [],
  failure;
async function until(fn, label, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timeout ${label}`);
}
const readTrace = async () =>
  (await readFile(traceFile, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
const snapshot = () => page.evaluate(() => window.arealDesktop.snapshot());
function ownerGenerations(selected) {
  const services = JSON.parse(
    execFileSync(binary, ["service", "list", "--json"], { env, encoding: "utf8", timeout: 20000 }),
  );
  return selected.flatMap(({ root }) =>
    services
      .filter((service) => service.workspace === root)
      .map(({ serviceId, generation, state }) => ({ serviceId, generation, state })),
  );
}
async function observeHostWire() {
  const requests = [];
  const faults = [];
  const subscriptions = new Map();
  let rendererSocket;
  let target;
  let phase;
  await page.routeWebSocket(/\/host\/socket$/, (socket) => {
    const remote = socket.connectToServer();
    const pending = new Map();
    socket.onMessage((message) => {
      const frame = JSON.parse(message.toString());
      if (frame.method === "shell.subscribe") {
        rendererSocket ??= socket;
        if (socket === rendererSocket) pending.set(frame.id, frame.method);
      }
      if (socket === rendererSocket) {
        const input = frame.params?.request ?? frame.params;
        requests.push({ method: frame.method, operation: input?.operation });
        if (input?.operation === "taskWatch") {
          pending.set(frame.id, {
            operation: input.operation,
            projectId: input.projectId,
            executionProjectId: input.executionProjectId,
            taskId: input.taskId,
          });
        }
      }
      remote.send(message);
    });
    remote.onMessage((message) => {
      const frame = JSON.parse(message.toString());
      const original = pending.get(frame.id);
      pending.delete(frame.id);
      if (original === "shell.subscribe" && frame.result?.subscriptionId) {
        const shell = frame.result;
        subscriptions.set(
          shell.subscriptionId,
          new Map(shell.snapshot.projects.map((row) => [row.projectId, row.taskRevision])),
        );
      }
      if (original?.operation === "taskWatch") {
        requests.push({
          ...original,
          observedTaskId: frame.result?.id ?? frame.result?.task?.id,
          errorCode: frame.error?.code,
        });
      }
      const event = frame.params;
      const seen = event && subscriptions.get(event.subscriptionId);
      if (socket === rendererSocket && event?.event === "shell.updated" && seen) {
        for (const row of event.delta.projects.upsert) {
          const prior = seen.get(row.projectId);
          seen.set(row.projectId, row.taskRevision);
          if (
            phase &&
            row.projectId === target &&
            typeof prior === "string" &&
            typeof row.taskRevision === "string" &&
            row.taskRevision !== prior
          ) {
            faults.push({
              phase,
              projectId: target,
              sequence: event.sequence,
              subscriptionId: event.subscriptionId,
              taskRevision: row.taskRevision,
            });
            const drop = phase === "drop";
            phase = undefined;
            if (!drop) {
              socket.send(message);
              socket.send(message);
            }
            return;
          }
        }
        for (const id of event.delta.projects.remove) seen.delete(id);
      }
      socket.send(message);
    });
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="areal-workbench"][data-startup-ready="true"]').waitFor();
  await until(() => subscriptions.size, "native shell subscription observed");
  return {
    requests,
    faults,
    arm(projectId, action) {
      assert.equal(phase, undefined, "previous injection reached the original subscription");
      assert.ok(
        [...subscriptions.values()].some((rows) => typeof rows.get(projectId) === "string"),
      );
      target = projectId;
      phase = action;
    },
  };
}
async function call(name, request) {
  if (name === "tasks") return fixtureWorkbench(page, "tasks.read", request);
  if (name === "create") {
    const { projectId, ...input } = request;
    return createFixtureThread(page, projectId, input);
  }
  const reply = await page.evaluate(
    ({ name, request }) => window.arealDesktop.command(name, request),
    { name, request },
  );
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.value;
}
async function launch() {
  app = await electron.launch({
    executablePath: process.env.AREAL_ELECTRON_EXECUTABLE || require("electron"),
    args: [fixture.path],
    env,
    timeout: 120000,
  });
  app.process().stderr.on("data", (chunk) => {
    void appendFile(join(evidence, "electron.stderr.log"), chunk);
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  catalogEvents.length = 0;
  page.on("console", (message) => {
    if (message.text().startsWith("[task-catalog] "))
      catalogEvents.push(JSON.parse(message.text().slice(15)));
  });
  await page
    .locator('[data-testid="areal-workbench"][data-startup-ready="true"]')
    .waitFor({ timeout: 120000 });
  await until(async () => (await snapshot()).connection?.state === "ready", "desktop ready");
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1488, 1056);
    w.show();
    w.focus();
  });
}
async function close() {
  if (!app) return;
  const application = app;
  app = null;
  const pid = application.process().pid;
  const host = await readFixtureHost(env);
  const stopDirectory = join(evidence, `stop-${pid}`);
  await mkdir(stopDirectory);
  let receipt;
  try {
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0 });
    });
    if (host)
      receipt = await stopFixtureHost(binary, env.AREAL_HARNESS_SERVICE_HOME, stopDirectory);
  } catch (error) {
    cleanup.push({ pid, hostPid: host?.pid, stopped: false, error: error.message });
    throw error;
  } finally {
    await closeSmokeApplication(application);
    await assertApplicationStopped(binary, env, { pid, hostPid: host?.pid });
  }
  cleanup.push({ pid, hostPid: host?.pid, stopRequestId: receipt?.requestId, stopped: true });
}
async function addProject(directory) {
  await mkdir(directory, { recursive: true });
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
  }, directory);
  await page.evaluate(() => window.arealDesktop.chooseProject());
  return until(
    async () => (await snapshot()).projects.find((entry) => entry.root === directory),
    "original native project alias",
  );
}
async function measureOpen() {
  await page.getByRole("button", { name: "首页", exact: true }).click();
  const navigation = page.getByRole("button", { name: "定时任务", exact: true });
  await navigation.evaluate((button) => {
    window.__scheduleTiming = { clickedAt: null, visibleAt: null };
    const timing = window.__scheduleTiming;
    const observer = new MutationObserver(() => {
      const row = document.querySelector('button[aria-label^="打开定时任务 SCHEDULE_"]');
      if (!row || timing.clickedAt === null || timing.visibleAt !== null) return;
      requestAnimationFrame(() => {
        const box = row.getBoundingClientRect();
        if (
          row.isConnected &&
          box.width > 0 &&
          box.height > 0 &&
          box.top < innerHeight &&
          box.bottom > 0 &&
          getComputedStyle(row).visibility !== "hidden"
        ) {
          timing.visibleAt = performance.now();
          observer.disconnect();
        }
      });
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    button.addEventListener(
      "click",
      () => {
        timing.clickedAt = performance.now();
      },
      { capture: true, once: true },
    );
  });
  await navigation.click();
  await page.waitForFunction(() => window.__scheduleTiming?.visibleAt !== null, undefined, {
    timeout: 60000,
  });
  const timing = await page.evaluate(() => window.__scheduleTiming);
  const completed = await until(
    () => catalogEvents.find((event) => event.kind === "end" && event.at >= timing.clickedAt),
    "full owner refresh completed",
  );
  await until(
    () =>
      page
        .getByRole("button", { name: /^打开定时任务 SCHEDULE_/ })
        .count()
        .then((count) => count === scheduleScale.projects * scheduleScale.scheduled),
    "all schedule rows rendered",
  );
  const full = await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() =>
          resolve({
            at: performance.now(),
            rows: document.querySelectorAll('button[aria-label^="打开定时任务 SCHEDULE_"]').length,
            errors: [...document.querySelectorAll(".task-catalog-error")]
              .filter((node) => /读取失败|加载失败/.test(node.textContent))
              .map((node) => node.textContent),
          }),
        ),
      ),
  );
  assert.deepEqual(full.errors, [], "full UI refresh source errors");
  assert.equal(full.rows, scheduleScale.projects * scheduleScale.scheduled);
  const visible = await page
    .locator('button[aria-label^="打开定时任务 SCHEDULE_"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
  const expected = owners.flatMap((_, index) =>
    Array.from(
      { length: scheduleScale.scheduled },
      (_, taskIndex) =>
        `打开定时任务 SCHEDULE_${String(index).padStart(2, "0")}_${String(taskIndex).padStart(3, "0")}`,
    ),
  );
  assert.deepEqual(
    [...visible].sort(),
    expected.sort(),
    "all seeded schedule identities render after reopening",
  );
  const responses = catalogEvents.filter(
    (event) => event.kind === "response_received" && event.requestId === completed.requestId,
  );
  for (const owner of owners)
    assert.ok(
      responses.some(
        (event) => event.projectId === owner.logicalProjectId && event.rows === owner.scheduled,
      ),
      `owner ${owner.logicalProjectId} contributed its scheduled rows`,
    );
  return {
    ms: timing.visibleAt - timing.clickedAt,
    ...timing,
    fullMs: full.at - timing.clickedAt,
    fullRows: full.rows,
    catalogEnd: completed,
    ownerResponses: responses
      .filter((event) => owners.some((owner) => owner.logicalProjectId === event.projectId))
      .map((event) => ({ projectId: event.projectId, rows: event.rows })),
  };
}
async function check(name, fn) {
  try {
    const detail = await fn();
    checks.push({ name, passed: true, detail });
  } catch (error) {
    checks.push({ name, passed: false, error: error.stack });
  }
}
try {
  if (!previous) {
    await launch();
    primaryId = (await addProject(join(scratch, "primary"))).id;
    const projectless = join(scratch, "projectless");
    await mkdir(projectless, { recursive: true });
    await call("projectless", { operation: "directory", path: projectless });
    for (let index = 0; index < scheduleScale.projects; index++) {
      const project = await addProject(join(scratch, `logical-${String(index).padStart(2, "0")}`));
      const allocated = await call("projectless", {
        operation: "prepare",
        requestId: randomUUID(),
      });
      await call("connect", { projectId: allocated.projectId });
      const source = await call("create", {
        projectId: allocated.projectId,
        requestId: randomUUID(),
      });
      const task = await call("manage", {
        operation: "taskCreate",
        projectId: allocated.projectId,
        requestId: randomUUID(),
        mode: "scheduled",
        objective: `TEMPLATE_${index}`,
        sourceThreadId: source.threadId,
        interactionMode: "interactive",
        schedule: { at: 1893456000, intervalSeconds: 86400 },
      });
      const paused = await call("manage", {
        operation: "taskPause",
        projectId: allocated.projectId,
        taskId: task.id,
        expectedRevision: task.revision,
      });
      assert.equal(paused.paused, true);
      owners.push({
        projectId: allocated.projectId,
        logicalProjectId: project.id,
        root: allocated.cwd,
        sourceThreadId: source.threadId,
        taskId: task.id,
      });
      console.log(`Seed owner ${index + 1}/${scheduleScale.projects}`);
    }
    // 目录将逻辑项目和执行项目合并。空的逻辑项目也要先绑定，冷读才有可信的空目录。
    const host = new HostClient();
    try {
      await host.connect(env.AREAL_HARNESS_SERVICE_HOME);
      for (const { registration, service } of (await host.status()).projects) {
        if (service?.state === "ready" || registration.source.kind !== "gui") continue;
        assert.ok(registration.workspace.startsWith(scratch + "/"), "seed owner is isolated");
        await call("connect", { projectId: registration.source.legacyProjectId });
      }
      const catalog = await call("tasks", { operation: "observe", limit: 1024 });
      assert.deepEqual(catalog.errors, [], "seed has a readable catalog for every owner");
    } finally {
      host.close();
    }
    await page.evaluate((id) => {
      localStorage.setItem("areal-gui:project", id);
      localStorage.setItem(
        "areal-gui:preferences",
        JSON.stringify({ nextPromptSuggestions: false }),
      );
    }, primaryId);
    await close();
    const saved = JSON.parse(await readFile(join(scratch, "core/projects.json"), "utf8"));
    await writeFile(
      join(scratch, "core/projects.json"),
      JSON.stringify(
        saved.map((project) => {
          const owner = owners.find((owner) => owner.projectId === project.id);
          return owner ? { ...project, logicalProjectId: owner.logicalProjectId } : project;
        }),
      ),
    );
    owners = await expandScheduleFixture(join(scratch, "core"), owners);
  }
  await saveScheduleEvidence(evidence, "fixture", {
    scratch,
    primaryId,
    owners,
    cleanup,
    scale: scheduleScale,
    identity,
    boundary:
      "Project/thread/task templates use public Desktop commands. Stopped v5 immutable leaves are synthetic scale/history preconditions.",
  });
  if (mode === "fault") {
    await launch();
    for (const owner of owners) await call("connect", { projectId: owner.projectId });
    const versions = await Promise.all(
      owners.map(
        async (owner) =>
          JSON.parse(
            await readFile(
              join(scratch, "core", owner.projectId, "state/desktop/task-mode.json"),
              "utf8",
            ),
          ).version,
      ),
    );
    assert.deepEqual([...new Set(versions)], [6], "fault run uses publicly migrated v6 owners");
    const wire = await observeHostWire();
    const nativeCatalog = await call("tasks", { operation: "observe", limit: 1024 });
    await saveScheduleEvidence(evidence, "native-catalog-before-fault", {
      owners: nativeCatalog.owners,
      errors: nativeCatalog.errors,
      rows: nativeCatalog.data.map(({ id, projectId, executionProjectId, objectivePreview }) => ({
        id,
        projectId,
        executionProjectId,
        objectivePreview,
      })),
    });
    try {
      await measureOpen();
    } finally {
      await saveScheduleEvidence(evidence, "catalog-events-before-fault", catalogEvents);
    }
    const historicalNotices = (await readTrace()).filter((event) => event.kind === "native_show");
    assert.deepEqual(historicalNotices, [], "initial owner snapshot does not replay old notices");
    if (transportFaults)
      await check("transport-gap-duplicate-over-128-tasks", async () => {
        const owner = owners[0];
        assert.ok(owner.tasks >= 200, "fault target owner contains more than128 Tasks");
        const source = await createFixtureThread(page, owner.projectId, {});
        let task = await call("manage", {
          operation: "taskCreate",
          projectId: owner.projectId,
          requestId: randomUUID(),
          mode: "scheduled",
          objective: "SCHEDULE_FAULT_INITIAL",
          sourceThreadId: source.threadId,
          interactionMode: "interactive",
          schedule: { at: 1893456000, intervalSeconds: 86400 },
        });
        await page
          .getByRole("button", { name: "打开定时任务 SCHEDULE_FAULT_INITIAL", exact: true })
          .waitFor({ timeout: 15000 });
        const host = new HostClient();
        let projectId;
        try {
          await host.connect(env.AREAL_HARNESS_SERVICE_HOME);
          const owners = (await host.status()).projects.filter(
            ({ registration }) => registration.workspace === owner.root,
          );
          assert.equal(owners.length, 1);
          projectId = owners[0].registration.projectId;
        } finally {
          host.close();
        }
        const before = wire.requests.length;
        wire.arm(projectId, "drop");
        task = await call("manage", {
          operation: "taskUpdate",
          projectId: owner.projectId,
          taskId: task.id,
          expectedRevision: task.revision,
          objective: "SCHEDULE_FAULT_DROPPED",
        });
        const dropped = await until(
          () => wire.faults.find((event) => event.phase === "drop"),
          "first target shell update dropped",
          15000,
        );
        wire.arm(projectId, "duplicate");
        task = await call("manage", {
          operation: "taskUpdate",
          projectId: owner.projectId,
          taskId: task.id,
          expectedRevision: task.revision,
          objective: "SCHEDULE_FAULT_LATEST",
        });
        const duplicated = await until(
          () => wire.faults.find((event) => event.phase === "duplicate"),
          "second target shell update duplicated",
          15000,
        );
        assert.equal(duplicated.subscriptionId, dropped.subscriptionId);
        assert.equal(duplicated.sequence, dropped.sequence + 1);
        assert.notEqual(duplicated.taskRevision, dropped.taskRevision);
        await page
          .getByRole("button", { name: "打开定时任务 SCHEDULE_FAULT_LATEST", exact: true })
          .waitFor({ timeout: 15000 });
        await page
          .getByRole("button", { name: "打开定时任务 SCHEDULE_FAULT_DROPPED", exact: true })
          .waitFor({ state: "hidden", timeout: 15000 });
        assert.equal(wire.faults.length, 2);
        const recovery = wire.requests.slice(before);
        assert.ok(
          recovery.some(({ method }) => method === "shell.subscribe"),
          "sequence gap opens a fresh shell snapshot",
        );
        assert.ok(
          recovery.some(({ method }) => method === "tasks.read"),
          "fresh shell triggers an authoritative directory read",
        );
        await call("manage", {
          operation: "taskDelete",
          projectId: owner.projectId,
          taskId: task.id,
          expectedRevision: task.revision,
        });
        await page
          .getByRole("button", { name: "打开定时任务 SCHEDULE_FAULT_LATEST", exact: true })
          .waitFor({ state: "hidden", timeout: 15000 });
        const afterDelete = await call("tasks", {
          operation: "observe",
          projectId: owner.logicalProjectId,
          limit: 1024,
        });
        assert.ok(
          !afterDelete.data.some((row) => row.id === task.id),
          "deleted row does not reappear after duplicate delivery",
        );
        return {
          ownerProjectId: owner.projectId,
          taskId: task.id,
          drop: dropped,
          duplicate: duplicated,
          recovery,
        };
      });
    await check("unicode-directory-detail-edit", async () => {
      const owner = owners[0];
      const objective = "计划核对😀".repeat(150);
      const source = await createFixtureThread(page, owner.projectId, {});
      let task = await call("manage", {
        operation: "taskCreate",
        projectId: owner.projectId,
        requestId: randomUUID(),
        mode: "scheduled",
        objective,
        sourceThreadId: source.threadId,
        interactionMode: "interactive",
        schedule: { at: 1893456000, intervalSeconds: 86400 },
      });
      const listed = await until(async () => {
        const result = await call("tasks", {
          operation: "observe",
          projectId: owner.logicalProjectId,
          limit: 1024,
        });
        assert.deepEqual(result.errors, []);
        return result.data.find((row) => row.id === task.id);
      }, "long Unicode directory row");
      assert.equal(listed.objectiveTruncated, true);
      assert.ok(Buffer.byteLength(listed.objectivePreview) <= 512);
      assert.notEqual(listed.objectivePreview, objective);
      await page
        .getByRole("button", { name: `打开定时任务 ${listed.objectivePreview}`, exact: true })
        .click();
      try {
        await page.waitForFunction(
          ({ taskId, objective }) =>
            document
              .querySelector(`main[data-task-id="${taskId}"] h2`)
              ?.getAttribute("aria-description") === objective,
          { taskId: task.id, objective },
          { timeout: 15000 },
        );
      } finally {
        await saveScheduleEvidence(
          evidence,
          "unicode-task-observation",
          wire.requests.filter(({ taskId }) => taskId === task.id),
        );
      }
      task = await call("manage", {
        operation: "taskUpdate",
        projectId: owner.projectId,
        taskId: task.id,
        expectedRevision: task.revision,
        schedule: { at: 1893542400, intervalSeconds: 86400 },
      });
      assert.equal(task.objective, objective, "editing the schedule retains the full objective");
      const edited = "编辑后😀".repeat(150);
      task = await call("manage", {
        operation: "taskUpdate",
        projectId: owner.projectId,
        taskId: task.id,
        expectedRevision: task.revision,
        objective: edited,
      });
      const detail = await call("manage", {
        operation: "task",
        projectId: owner.projectId,
        taskId: task.id,
      });
      assert.equal(
        detail.objective,
        edited,
        "editing the objective stores the complete Unicode text",
      );
      const changed = await call("tasks", {
        operation: "observe",
        projectId: owner.logicalProjectId,
        limit: 1024,
      });
      const row = changed.data.find((item) => item.id === task.id);
      assert.equal(row.objectiveTruncated, true);
      assert.ok(Buffer.byteLength(row.objectivePreview) <= 512);
      return {
        taskId: task.id,
        fullBytes: Buffer.byteLength(edited),
        previewBytes: Buffer.byteLength(row.objectivePreview),
        revision: detail.revision,
      };
    });
    await check("over-128-task-question-approval-completion-notices", async () => {
      const owner = owners[0];
      assert.ok(owner.tasks >= 200);
      await libraryCommand(page, {
        operation: "settings",
        key: "turnNotifications",
        value: "always",
      });
      const questionThread = await call("create", {
        projectId: owner.projectId,
        requestId: randomUUID(),
      });
      const question = await call("manage", {
        operation: "taskCreate",
        projectId: owner.projectId,
        requestId: randomUUID(),
        mode: "foreground",
        objective: "NOTIFY_QUESTION_FOREGROUND",
        threadId: questionThread.threadId,
        interactionMode: "interactive",
      });
      const pendingQuestion = await until(
        async () => {
          const channel = await call("manage", {
            operation: "taskChannel",
            projectId: owner.projectId,
            taskId: question.id,
          });
          return channel.data.find((item) => item.kind === "question" && item.status === "pending");
        },
        "foreground Task question persisted",
        30000,
      );
      assert.ok(pendingQuestion.expiresAt > Date.now() / 1000);
      await until(
        async () =>
          (await readTrace()).some(
            (event) =>
              event.kind === "native_show" &&
              event.title === "任务需要你的回答" &&
              event.body === question.objective,
          ),
        "foreground question reaches native publish",
        15000,
      );
      const approvalThread = await call("create", {
        projectId: owner.projectId,
        requestId: randomUUID(),
      });
      const approval = await call("manage", {
        operation: "taskCreate",
        projectId: owner.projectId,
        requestId: randomUUID(),
        mode: "foreground",
        objective: "NOTIFY_APPROVAL_FOREGROUND",
        threadId: approvalThread.threadId,
        interactionMode: "interactive",
      });
      const pendingApproval = await withCore(
        { binary, env, gui, workspace: owner.root, threadId: approvalThread.threadId },
        (client) =>
          until(
            async () => {
              const { data } = await client.request("areal/interaction/list", {
                threadId: approvalThread.threadId,
              });
              return data.find((item) => item.kind === "approval" && item.status === "pending");
            },
            "foreground Task approval pending",
            30000,
          ),
      );
      await until(
        async () =>
          (await readTrace()).some(
            (event) =>
              event.kind === "native_show" &&
              event.title === "任务需要授权" &&
              event.body === approval.objective,
          ),
        "foreground approval reaches native publish",
        15000,
      );
      await call("respond", {
        projectId: owner.projectId,
        threadId: approvalThread.threadId,
        requestId: pendingApproval.requestId,
        decision: "allowOnce",
      });
      await until(
        async () => {
          const task = await call("manage", {
            operation: "task",
            projectId: owner.projectId,
            taskId: approval.id,
          });
          return task.runs.at(-1)?.status === "completed" && task;
        },
        "approved foreground Task completes",
        30000,
      );
      const source = await createFixtureThread(page, owner.projectId, {});
      const scheduled = await call("manage", {
        operation: "taskCreate",
        projectId: owner.projectId,
        requestId: randomUUID(),
        mode: "scheduled",
        objective: "NOTIFY_SCHEDULED_COMPLETION",
        sourceThreadId: source.threadId,
        interactionMode: "interactive",
        schedule: { at: 1893456000, intervalSeconds: 86400 },
      });
      await call("manage", {
        operation: "taskRunNow",
        projectId: owner.projectId,
        taskId: scheduled.id,
        requestId: randomUUID(),
        expectedRevision: scheduled.revision,
      });
      await until(
        async () => {
          const task = await call("manage", {
            operation: "task",
            projectId: owner.projectId,
            taskId: scheduled.id,
          });
          return task.runs.at(-1)?.status === "completed" && task;
        },
        "manual scheduled Task completes",
        30000,
      );
      await until(
        async () => {
          const shown = (await readTrace()).filter((event) => event.kind === "native_show");
          return [approval.objective, scheduled.objective].every((objective) =>
            shown.some((event) => event.title === "任务已完成" && event.body === objective),
          );
        },
        "both Task completions reach native publish",
        15000,
      );
      await until(
        async () => {
          const channel = await call("manage", {
            operation: "taskChannel",
            projectId: owner.projectId,
            taskId: question.id,
          });
          return channel.data.find((item) => item.id === pendingQuestion.id)?.status === "expired";
        },
        "question expires through its five-second timer",
        15000,
      );
      const notices = (await readTrace()).filter(
        (event) =>
          event.kind === "notice_publish" && event.notice?.projectId === owner.logicalProjectId,
      );
      const shown = (await readTrace()).filter((event) => event.kind === "native_show");
      for (const [kind, task, target] of [
        ["question", question, { taskId: question.id, questionId: pendingQuestion.id }],
        ["approval", approval, { threadId: approvalThread.threadId }],
        ["completion", approval, { taskId: approval.id }],
        ["completion", scheduled, { taskId: scheduled.id }],
      ]) {
        const projected = notices.filter(
          (event) =>
            event.notice.kind === kind &&
            Object.entries(target).every(([key, value]) => event.notice[key] === value),
        );
        assert.equal(projected.length, 1, `${kind} for ${task.id} has one Desktop projection`);
        const title = {
          question: "任务需要你的回答",
          approval: "任务需要授权",
          completion: "任务已完成",
        }[kind];
        assert.equal(
          shown.filter((event) => event.title === title && event.body === task.objective).length,
          1,
          `${task.objective} has one native publish per distinct notice kind`,
        );
      }
      assert.ok(
        notices.filter(
          (event) => event.notice.kind === "completion" && event.notice.taskId === question.id,
        ).length <= 1,
        "expired question has no duplicate completion projection",
      );
      assert.ok(modelRequests.some((entry) => entry.body.stream !== false));
      return {
        taskIds: [question.id, approval.id, scheduled.id],
        questionId: pendingQuestion.id,
        projected: notices.map((event) => event.notice),
        nativeShown: shown.filter((event) =>
          [question.objective, approval.objective, scheduled.objective].includes(event.body),
        ),
        modelRequests: modelRequests.length,
      };
    });
    await check("corrupt-published-pack-retains-visible-source", async () => {
      const owner = owners[0];
      const before = await call("tasks", {
        operation: "list",
        projectId: owner.logicalProjectId,
        limit: 1024,
      });
      assert.deepEqual(before.errors, []);
      const retained = before.data.find((row) => row.id === owner.taskId);
      assert.ok(retained);
      const host = new HostClient();
      let dataDir;
      try {
        await host.connect(env.AREAL_HARNESS_SERVICE_HOME);
        const { projects } = await host.status();
        const targets = projects.filter(
          ({ registration }) => registration.workspace === owner.root,
        );
        assert.equal(targets.length, 1, "the original execution workspace is unique");
        const { registration, service } = targets[0];
        assert.equal(service?.state, "ready");
        assert.equal(service.dataDir, registration.dataDir);
        dataDir = registration.dataDir;
        assert.ok(dataDir.startsWith(scratch + "/"), "Core data directory remains isolated");
        const requestId = randomUUID();
        let receipt;
        try {
          receipt = await host.stopProject(
            requestId,
            registration.projectId,
            service.generation,
            "cancel",
          );
        } catch {
          host.close();
          await host.connect(env.AREAL_HARNESS_SERVICE_HOME);
          receipt = (await host.operation(requestId)).operation;
        }
        assert.equal(receipt?.requestId, requestId);
        assert.equal(receipt.state, "completed");
        assert.deepEqual((await host.operation(requestId)).operation, receipt);
        await writeFile(join(evidence, "corrupt-pack-project-stop.json"), JSON.stringify(receipt));
        await until(() => {
          return [service.hostPid, service.corePid].every((pid) => {
            assert.ok(Number.isSafeInteger(pid) && pid > 1);
            try {
              process.kill(pid, 0);
              return false;
            } catch (error) {
              if (error.code !== "ESRCH") throw error;
              return true;
            }
          });
        }, "original execution owner's Core and project host exited");
      } finally {
        host.close();
      }
      const rootPath = join(dataDir, "desktop/task-mode.json");
      const rootBytes = await readFile(rootPath);
      const packPath = join(dataDir, "desktop/task-ledger", JSON.parse(rootBytes).schedules.digest);
      const packBytes = await readFile(packPath);
      const generations = ownerGenerations([owner]);
      assert.equal(generations.length, 1);
      assert.equal(generations[0].state, "stopped");
      try {
        await writeFile(packPath, Buffer.from("broken published summary"));
        const damaged = await call("tasks", {
          operation: "list",
          projectId: owner.logicalProjectId,
          limit: 1024,
        });
        assert.ok(
          damaged.errors.some((error) => error.projectId === owner.logicalProjectId),
          "damaged source reports a read error",
        );
        assert.ok(
          damaged.data.some((row) => row.id === owner.taskId),
          "damaged source retains its previously trusted row",
        );
        await page.getByRole("button", { name: "首页", exact: true }).click();
        await page.getByRole("button", { name: "定时任务", exact: true }).click();
        await page
          .getByRole("button", { name: `打开定时任务 ${retained.objectivePreview}`, exact: true })
          .waitFor();
        await page.locator(".task-catalog-error").first().waitFor();
        assert.deepEqual(
          ownerGenerations([owner]),
          generations,
          "damaged passive read does not start stopped Core",
        );
        return {
          ownerProjectId: owner.projectId,
          retainedTaskId: owner.taskId,
          errors: damaged.errors,
          rootDigest: digest(rootBytes),
          packDigest: digest(packBytes),
        };
      } finally {
        await writeFile(packPath, packBytes);
        assert.equal(digest(await readFile(rootPath)), digest(rootBytes));
        assert.equal(digest(await readFile(packPath)), digest(packBytes));
        const repaired = await call("tasks", {
          operation: "list",
          projectId: owner.logicalProjectId,
          limit: 1024,
        });
        assert.deepEqual(repaired.errors, [], "restored pack reads normally");
      }
    });
  } else if (mode !== "seed") {
    if (mode === "accept") {
      const versions = await Promise.all(
        owners.map(
          async (owner) =>
            JSON.parse(
              await readFile(
                join(scratch, "core", owner.projectId, "state/desktop/task-mode.json"),
                "utf8",
              ),
            ).version,
        ),
      );
      assert.deepEqual(
        [...new Set(versions)],
        [5],
        "candidate starts from the frozen trusted v5 fixture",
      );
      for (let index = 0; index < sampleCount; index++) {
        await launch();
        const measured = await measureOpen();
        samples.legacyFirstRow.push(measured);
        samples.legacySourceRefresh.push({ ms: measured.fullMs, rows: measured.fullRows });
        await close();
      }
      if (!quickAcceptance)
        for (const [name, limit] of [
          ["legacyFirstRow", 1000],
          ["legacySourceRefresh", 3000],
        ])
          await check(name, () => {
            const summary = sampleSummary(samples[name]);
            assert.ok(summary.count >= 5);
            assert.ok(
              summary.p95 <= limit,
              `v5 ${name} ${summary.p95.toFixed(1)}ms exceeds ${limit}ms`,
            );
            return { ...summary, limit };
          });
      await launch();
      for (const owner of owners) {
        await call("connect", { projectId: owner.projectId });
        const task = await call("manage", {
          operation: "task",
          projectId: owner.projectId,
          taskId: owner.taskId,
        });
        assert.equal(task.id, owner.taskId);
      }
      const migrated = await Promise.all(
        owners.map(
          async (owner) =>
            JSON.parse(
              await readFile(
                join(scratch, "core", owner.projectId, "state/desktop/task-mode.json"),
                "utf8",
              ),
            ).version,
        ),
      );
      assert.deepEqual(
        [...new Set(migrated)],
        [6],
        "public owner connections migrate all roots to v6",
      );
      await close();
    }
    const coldHostGenerations = new Set();
    for (let index = 0; index < sampleCount; index++) {
      await launch();
      const host = await readFixtureHost(env);
      assert.ok(host?.generation, "cold run attaches to an isolated Host");
      assert.ok(!coldHostGenerations.has(host.generation), "each cold run uses a fresh Host");
      coldHostGenerations.add(host.generation);
      const generations = ownerGenerations(owners);
      assert.ok(generations.every((service) => service.state === "stopped"));
      const measured = { ...(await measureOpen()), hostGeneration: host.generation };
      samples.coldFirstRow.push(measured);
      samples.coldSourceRefresh.push({ ms: measured.fullMs, rows: measured.fullRows });
      await check(`cold-${index}-all-schedules`, async () => {
        const catalog = await call("tasks", {
          operation: "observe",
          limit: 1024,
          requestId: randomUUID(),
          viewEpoch: 100 + index,
        });
        assert.deepEqual(catalog.errors, []);
        assert.equal(catalog.data.length, scheduleScale.projects * scheduleScale.scheduled);
        assert.ok(catalog.owners.length >= scheduleScale.projects);
        return { rows: catalog.data.length, bytes: Buffer.byteLength(JSON.stringify(catalog)) };
      });
      await check(`cold-${index}-passive`, () => {
        assert.deepEqual(
          ownerGenerations(owners),
          generations,
          "display reads must not start paused execution owners",
        );
      });
      await close();
    }
    await launch();
    for (const owner of owners) await call("connect", { projectId: owner.projectId });
    await measureOpen();
    for (let index = 0; index < sampleCount; index++) {
      const measured = await measureOpen();
      samples.warmFirstRow.push(measured);
      samples.allSourceRefresh.push({
        ms: measured.fullMs,
        rows: measured.fullRows,
        catalogEnd: measured.catalogEnd,
      });
    }
    for (let index = 0; index < sampleCount; index++) {
      const started = performance.now();
      const result = await call("tasks", {
        operation: "observe",
        limit: 1024,
        requestId: randomUUID(),
        viewEpoch: 1000 + index,
      });
      assert.deepEqual(result.errors, []);
      assert.equal(result.data.length, scheduleScale.projects * scheduleScale.scheduled);
      samples.allSourceRpc.push({
        ms: performance.now() - started,
        rows: result.data.length,
        owners: result.owners.length,
        bytes: Buffer.byteLength(JSON.stringify(result)),
      });
    }
    await check("bounded-summary-history", async () => {
      const result = await call("tasks", { operation: "observe", limit: 1024 });
      for (const task of result.data) {
        assert.equal(task.mode, "scheduled");
        assert.equal(typeof task.id, "string");
        assert.equal(typeof task.objectivePreview, "string");
        assert.equal(typeof task.objectiveTruncated, "boolean");
        assert.ok(Number.isSafeInteger(task.revision));
        const owner = owners.find(
          (owner) =>
            owner.projectId === (task.executionProjectId ?? task.projectId) ||
            owner.logicalProjectId === task.projectId,
        );
        assert.ok(owner, "every directory row retains its seeded logical/execution owner");
        assert.equal(task.runCount, owner.history, "directory keeps exact durable run count");
        assert.ok(
          Buffer.byteLength(JSON.stringify(task)) <= 4096,
          "fixed objective directory row stays under4KiB despite128hot runs",
        );
        assert.ok(!("messages" in task), "directory omits full channel messages field");
        assert.ok(
          !("runs" in task),
          "directory carries bounded latestRun instead of hot run history",
        );
        assert.equal(task.latestRun?.status ?? null, owner.history ? "completed" : null);
        assert.ok(!("workers" in (task.latestRun ?? {})), "latest run omits worker details");
        const visit = (value) => {
          if (!value || typeof value !== "object") return;
          for (const [key, child] of Object.entries(value)) {
            assert.ok(
              !["messages", "workers", "toolResults"].includes(key),
              `directory omits nested ${key}`,
            );
            visit(child);
          }
        };
        visit(task);
      }
      return result.data.map((task) => ({
        id: task.id,
        bytes: Buffer.byteLength(JSON.stringify(task)),
        runCount: task.runCount,
        latestRunId: task.latestRun?.id,
      }));
    });
    await check("no-periodic-full-list", async () => {
      const wire = await observeHostWire();
      await measureOpen();
      assert.ok(wire.requests.some(({ method }) => method === "tasks.read"));
      const start = wire.requests.length;
      await new Promise((resolve) => setTimeout(resolve, 9000));
      const periodic = wire.requests.slice(start).filter(({ method }) => method === "tasks.read");
      await saveScheduleEvidence(evidence, "idle-requests", periodic);
      assert.deepEqual(
        periodic,
        [],
        "quiescent schedule UI issues no recurring task directory reads",
      );
    });
    const liveOwner = await call("projectless", { operation: "prepare", requestId: randomUUID() });
    await call("connect", { projectId: liveOwner.projectId });
    const liveSource = await call("create", {
      projectId: liveOwner.projectId,
      requestId: randomUUID(),
    });
    let current = await call("manage", {
      operation: "taskCreate",
      projectId: liveOwner.projectId,
      requestId: randomUUID(),
      mode: "scheduled",
      objective: "SCHEDULE_LIVE_INITIAL",
      sourceThreadId: liveSource.threadId,
      interactionMode: "interactive",
      schedule: { at: 1893456000, intervalSeconds: 86400 },
    });
    await check("live-create", async () => {
      await page
        .getByRole("button", { name: "打开定时任务 SCHEDULE_LIVE_INITIAL", exact: true })
        .waitFor({ timeout: 15000 });
      return { taskId: current.id, executionProjectId: liveOwner.projectId };
    });
    current = await call("manage", {
      operation: "taskPause",
      projectId: liveOwner.projectId,
      taskId: current.id,
      expectedRevision: current.revision,
    });
    for (let index = 0; index < sampleCount; index++) {
      const objective = `SCHEDULE_LIVE_${index}`;
      const started = performance.now();
      current = await call("manage", {
        operation: "taskUpdate",
        projectId: liveOwner.projectId,
        taskId: current.id,
        expectedRevision: current.revision,
        objective,
      });
      const commandReturned = performance.now();
      await page
        .getByRole("button", { name: `打开定时任务 ${objective}`, exact: true })
        .waitFor({ timeout: 15000 });
      const visible = performance.now();
      samples.liveMutation.push({
        ms: visible - started,
        commandMs: commandReturned - started,
        projectionMs: visible - commandReturned,
        revision: current.revision,
        objective,
      });
    }
    await check("live-delete", async () => {
      await call("manage", {
        operation: "taskDelete",
        projectId: liveOwner.projectId,
        taskId: current.id,
        expectedRevision: current.revision,
      });
      await page
        .getByRole("button", { name: `打开定时任务 ${current.objective}`, exact: true })
        .waitFor({ state: "hidden", timeout: 15000 });
    });
    await page.screenshot({ path: join(evidence, "schedules.png") });
    await writeFile(
      join(evidence, "schedules.aria.txt"),
      await page.locator("body").ariaSnapshot(),
    );
    const limits = quickAcceptance
      ? {
          coldFirstRow: 1000,
          coldSourceRefresh: 1000,
          warmFirstRow: 300,
          allSourceRefresh: 300,
        }
      : { coldFirstRow: 1000, warmFirstRow: 300, allSourceRefresh: 3000, liveMutation: 1000 };
    for (const [name, limit] of Object.entries(limits))
      await check(name, () => {
        const summary = sampleSummary(samples[name]);
        assert.ok(summary.count >= 5);
        assert.ok(
          summary.p95 <= limit,
          `${name} p95 ${summary.p95.toFixed(1)}ms exceeds ${limit}ms`,
        );
        return { ...summary, limit };
      });
    assert.deepEqual(errors, [], "renderer errors");
  }
} catch (error) {
  failure = error.stack;
  if (page) await page.screenshot({ path: join(evidence, "failure.png") }).catch(() => {});
} finally {
  await close().catch((error) => {
    failure ??= error.stack;
  });
  await fixture.close();
  if (model) {
    model.closeAllConnections();
    await new Promise((resolve) => model.close(resolve));
    await saveScheduleEvidence(evidence, "model-requests", modelRequests);
  }
  if (digest(await readFile(binary)) !== identity.binarySha256)
    failure ??= "Core binary changed during run";
  const guiAfter = await guiFingerprint();
  if (guiAfter.sha256 !== guiBefore.sha256)
    failure ??= "Tested GUI source/artifact changed during run";
  const result = {
    mode,
    passed: !failure && checks.every((check) => check.passed),
    failure,
    identity,
    scratch,
    primaryId,
    owners,
    cleanup,
    scale: scheduleScale,
    acceptanceProfile: quickAcceptance
      ? {
          source: "Five-project catalog acceptance with ten scheduled Tasks per project.",
          gates: [
            "coldFirstRow.p95<=1000ms",
            "coldSourceRefresh.p95<=1000ms",
            "warmFirstRow.p95<=300ms",
            "allSourceRefresh.p95<=300ms",
          ],
          diagnostics: [
            "legacyFirstRow",
            "legacySourceRefresh",
            "liveMutation including command and UI projection time",
          ],
        }
      : {
          source: "Twenty-project stress acceptance with 200 Tasks per project.",
          gates: [
            "legacyFirstRow.p95<=1000ms",
            "legacySourceRefresh.p95<=3000ms",
            "coldFirstRow.p95<=1000ms",
            "warmFirstRow.p95<=300ms",
            "allSourceRefresh.p95<=3000ms",
            "liveMutation.p95<=1000ms",
          ],
        },
    samples,
    summaries: Object.fromEntries(
      Object.entries(samples).map(([name, values]) => [name, sampleSummary(values)]),
    ),
    checks,
    errors,
    guiAfter,
    loadAfter: loadavg(),
    limitations: [
      "Source Electron on this macOS host, not a signed package or real provider.",
      "All performance schedules paused to separate passive reads from enabled-owner startup activation.",
      "Full-source UI refresh measures reopening the schedule center through catalog end and complete rendered schedule rows. allSourceRpc separately measures public Desktop observe.",
      transportFaults
        ? "Fault mode injects a gap and duplicate on the Host shell stream over a 200-Task owner, and checks foreground question/approval, scheduled and foreground completion notices, and a damaged published source. Core-side stream fault coverage is separate."
        : "Lifecycle, due admission, transport faults, unknown-write and cleanup safety require separate real regression runs and are not claimed by this scale mode.",
    ],
  };
  await saveScheduleEvidence(evidence, "manifest", result);
  console.log(`Evidence: ${evidence}`);
  console.log(
    JSON.stringify(
      {
        passed: result.passed,
        summaries: result.summaries,
        failed: checks.filter((check) => !check.passed).map((check) => check.name),
        failure,
      },
      null,
      2,
    ),
  );
  if (failure || (["accept", "fault"].includes(mode) && !result.passed)) process.exitCode = 1;
}
