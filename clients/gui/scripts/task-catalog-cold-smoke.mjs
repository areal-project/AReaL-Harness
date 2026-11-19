import { createFixtureThread, fixtureWorkbench } from "./support/desktop-fixture.mjs";
import { openProjectInDesktop } from "./support/journey-fixture.mjs";
import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { trackedMkdtemp } from "./support/host-cleanup.cjs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { applicationFixture } from "./application-fixture.mjs";
import {
  assertApplicationStopped,
  closeSmokeApplication,
  readFixtureHost,
  stopFixtureHost,
} from "./application-cleanup.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
  gui = process.env.AREAL_COLD_GUI_ROOT
    ? resolve(process.env.AREAL_COLD_GUI_ROOT)
    : process.env.AREAL_VERIFY_ROOT
      ? join(resolve(process.env.AREAL_VERIFY_ROOT), "clients/gui")
      : join(root, "clients/gui");
const require = createRequire(join(root, "clients/gui/app/package.json"));
const { _electron: electron } = require("playwright-core");
const binary = resolve(process.env.AREAL_CORE_BIN || join(root, "target/debug/areal"));
const scratch = await makeTempDir("areal-cold-");
const evidence = process.env.AREAL_COLD_EVIDENCE
  ? resolve(process.env.AREAL_COLD_EVIDENCE)
  : await trackedMkdtemp(join(root, ".scratch/task-catalog-cold-"));
await mkdir(evidence, { recursive: true });
const primary = join(scratch, "demo"),
  user = join(scratch, "user");
await mkdir(primary, { recursive: true });
await mkdir(user, { recursive: true });
const config = join(scratch, "config.toml");
await writeFile(
  config,
  'schema_version=1\n[model]\ncatalog_version=1\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:9/v1/chat/completions"\nmodels=[{id="fixture",enabled=true}]\n',
);
const inherited = { ...process.env };
for (const key of Object.keys(inherited))
  if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE")
    delete inherited[key];
const env = {
  ...inherited,
  HOME: user,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: user,
  AREAL_HARNESS_HOME: join(scratch, "config-home"),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_CORE_CONFIG: config,
  AREAL_CORE_BIN: binary,
};
const fixture = await applicationFixture(gui, join(scratch, "app"));
const irrelevantOwners = [],
  scheduledOwners = [];
const identity = {
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  sourceStatus: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }),
  node: process.version,
  electron: require("electron/package.json").version,
  binary,
  sha256: createHash("sha256")
    .update(await readFile(binary))
    .digest("hex"),
  gui,
};
async function sourceHashes() {
  const result = {};
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile())
        result[path] = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
    }
  }
  for (const directory of [
    join(gui, "app/src"),
    join(gui, "app/assets"),
    join(gui, "renderer/dist"),
    join(gui, "packages"),
  ])
    await walk(directory);
  for (const file of [join(gui, "app/package.json")])
    result[file] = createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  return result;
}
const sourceBefore = await sourceHashes();
const errors = [],
  cleanup = [];
let app, page, taskOwner, task, primaryId, observation, previewDetail, failure;
const startup = process.argv.includes("--startup");
const objective = startup ? "STARTUP_CATALOG_SAVED_TASK" : "COLD_PERSISTED_TASK";
let pendingActivation;
function holdOriginalActivation(socket) {
  const remote = socket.connectToServer();
  socket.onMessage((message) => {
    const frame = JSON.parse(message.toString());
    const { command, request } = frame.params ?? {};
    if (
      frame.method !== "desktop.command" ||
      command !== "connect" ||
      request?.projectId !== taskOwner ||
      request.resumeScheduling !== true
    ) {
      remote.send(message);
      return;
    }
    assert.equal(pendingActivation, undefined, "the original explicit activation is issued once");
    pendingActivation = {
      id: frame.id,
      receivedAt: Date.now(),
      release: () => remote.send(message),
    };
  });
  remote.onMessage((message) => {
    const frame = JSON.parse(message.toString());
    if (pendingActivation && frame.id === pendingActivation.id) {
      pendingActivation.result = frame.result;
      pendingActivation.error = frame.error;
    }
    socket.send(message);
  });
}
const workspaces = new Map();
const services = () =>
  JSON.parse(
    execFileSync(binary, ["service", "list", "--json"], { env, encoding: "utf8", timeout: 20000 }),
  );
function generations(ids) {
  const records = services();
  return ids.map((id) => ({
    projectId: id,
    services: records
      .filter((row) => row.workspace === workspaces.get(id))
      .map(({ serviceId, generation, state }) => ({ serviceId, generation, state })),
  }));
}
async function rememberWorkspace(projectId) {
  const owner = await until(
    async () => (await snapshot()).projects.find((item) => item.id === projectId),
    "original native project alias",
  );
  assert.ok(owner.root.startsWith(scratch + "/"));
  workspaces.set(projectId, owner.root);
}
const ready = (projectId) =>
  services().some((row) => row.workspace === workspaces.get(projectId) && row.state === "ready");
const readTasks = (projectId) =>
  fixtureWorkbench(page, "tasks.read", { operation: "list", projectId });
async function until(fn, label) {
  const end = Date.now() + 120000;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw Error("Timeout " + label);
}
const snapshot = () => page.evaluate(() => window.arealDesktop.snapshot());
async function call(name, request) {
  const result = await page.evaluate(
    ({ name, request }) => window.arealDesktop.command(name, request),
    { name, request },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}
async function launch() {
  app = await electron.launch({
    executablePath: require("electron"),
    args: [fixture.path],
    env,
    timeout: 120000,
  });
  app.process().stderr.on("data", (data) => {
    void writeFile(join(evidence, "electron-last-stderr.txt"), data);
  });
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await page
    .locator('[data-testid="areal-workbench"][data-startup-ready="true"]')
    .waitFor({ timeout: 120000 });
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1488, 1056);
    w.show();
    w.focus();
  });
}
async function close() {
  if (!app) return;
  const host = await readFixtureHost(env);
  const pid = app.process().pid;
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0 });
  });
  const directory = join(evidence, `quit-${pid}`);
  await mkdir(directory);
  let receipt;
  try {
    if (host) {
      receipt = await stopFixtureHost(binary, env.AREAL_HARNESS_SERVICE_HOME, directory);
      assert.equal(receipt?.state, "completed");
    }
  } finally {
    const closing = app;
    app = null;
    await closeSmokeApplication(closing);
    await assertApplicationStopped(binary, env, { pid, hostPid: host?.pid });
  }
  cleanup.push({ pid, hostPid: host?.pid, stopRequestId: receipt?.requestId, stopped: true });
}
try {
  await launch();
  await openProjectInDesktop(app, page, primary);
  await page.getByTestId("chat-input").waitFor();
  primaryId = await page.getByTestId("areal-workbench").getAttribute("data-project-id");
  assert.ok(primaryId);
  await rememberWorkspace(primaryId);
  for (let index = 0; index < 30; index++) {
    const owner = await call("projectless", { operation: "prepare", requestId: randomUUID() });
    await rememberWorkspace(owner.projectId);
    irrelevantOwners.push(owner.projectId);
  }
  for (let index = 0; index < 3; index++) {
    const prepared = await call("projectless", { operation: "prepare", requestId: randomUUID() });
    taskOwner = prepared.projectId;
    await rememberWorkspace(taskOwner);
    await call("connect", { projectId: taskOwner });
    await until(() => ready(taskOwner), "task owner ready");
    const source = await createFixtureThread(page, taskOwner, {
      model: { providerId: "fixture", modelId: "fixture" },
    });
    await until(async () => {
      // Core 进程 ready 之后，仍须证明 Host 已安装该 owner 的调度连接。
      const result = await fixtureWorkbench(page, "manage.read", {
        operation: "taskScheduleContext",
        projectId: taskOwner,
        timeZone: "UTC",
      }).catch((error) => {
        if (!String(error.message).includes("scheduleHostUnavailable")) throw error;
        return null;
      });
      return Number.isFinite(result?.coreNow);
    }, "original scheduled owner reachable through Host");
    task = await call("manage", {
      operation: "taskCreate",
      projectId: taskOwner,
      requestId: randomUUID(),
      mode: "scheduled",
      objective: index === 2 ? objective : `${objective}_${index}`,
      sourceThreadId: source.threadId,
      interactionMode: "interactive",
      schedule: { at: Math.floor(Date.now() / 1000) + 86400 },
    });
    scheduledOwners.push(taskOwner);
  }
  await writeFile(join(evidence, "saved-task.json"), JSON.stringify(task, null, 2));
  await page.evaluate((id) => localStorage.setItem("areal-gui:project", id), primaryId);
  await close();
  await launch();
  if (startup) {
    await page.routeWebSocket(/\/host\/socket$/, holdOriginalActivation);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator('[data-testid="areal-workbench"][data-startup-ready="true"]').waitFor();
  }
  await call("connect", { projectId: primaryId });
  await until(() => ready(primaryId), "primary ready");
  const allColdOwners = [...irrelevantOwners, ...scheduledOwners];
  assert.ok(
    allColdOwners.every((id) => !ready(id)),
    "all unrelated owners are initially cold",
  );
  const beforeSelection = generations(allColdOwners);
  await page
    .getByRole("button", { name: "定时任务", exact: true })
    .evaluate((button, objective) => {
      const timing = (window.__coldTaskTiming = { clickedAt: null, visibleAt: null });
      let frame = 0;
      const check = () => {
        if (timing.clickedAt === null || timing.visibleAt !== null) return;
        const row = [...document.querySelectorAll("button[aria-label]")].find(
          (el) => el.getAttribute("aria-label") === "打开定时任务 " + objective,
        );
        if (!row || frame) return;
        frame = requestAnimationFrame(async () => {
          frame = 0;
          const box = row.getBoundingClientRect(),
            style = getComputedStyle(row);
          if (
            row.isConnected &&
            box.width > 0 &&
            box.height > 0 &&
            style.visibility !== "hidden" &&
            style.display !== "none"
          ) {
            timing.visibleAt = performance.now();
            timing.visibleWallAt = Date.now();
            timing.disabled = row.disabled;
            timing.statuses = [...document.querySelectorAll('[role="status"]')].map(
              (el) => el.getAttribute("aria-label") ?? el.textContent,
            );
            timing.rowText = row.textContent;
            observer.disconnect();
          }
        });
      };
      const observer = new MutationObserver(check);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      button.addEventListener(
        "click",
        () => {
          timing.clickedAt = performance.now();
          check();
        },
        { once: true, capture: true },
      );
    }, objective);
  await page.getByRole("button", { name: "定时任务", exact: true }).click();
  const row = page.getByRole("button", { name: `打开定时任务 ${objective}`, exact: true });
  await row.waitFor({ timeout: 60000 });
  await page.waitForFunction(() => window.__coldTaskTiming.visibleAt !== null);
  observation = await page.evaluate(() => window.__coldTaskTiming);
  await writeFile(
    join(evidence, "observation.json"),
    JSON.stringify(
      { ...observation, visibleMs: observation.visibleAt - observation.clickedAt },
      null,
      2,
    ),
  );
  observation.executionReady = ready(taskOwner);
  assert.equal(observation.executionReady, false, "published row appears while owner stays cold");
  assert.equal(observation.disabled, false, "Published task row remains selectable");
  await row.click();
  await page.locator(".task-conversation").waitFor();
  previewDetail = await page.evaluate(() => ({
    text: document.querySelector(".task-conversation")?.textContent,
    statuses: [...document.querySelectorAll('.task-conversation [role="status"]')].map(
      (el) => el.getAttribute("aria-label") ?? el.textContent,
    ),
    mutations: [...document.querySelectorAll(".task-conversation button")]
      .filter((button) =>
        ["暂停", "开启", "立即运行", "停止本次运行", "删除"].includes(button.textContent?.trim()),
      )
      .map((button) => ({ label: button.textContent, disabled: button.disabled })),
  }));
  assert.equal(ready(taskOwner), false, "opening preview does not start the owner");
  assert.ok(
    /连接|更新任务状态|尚未确认/.test([previewDetail.text, ...previewDetail.statuses].join(" ")),
    "Published task opens a connecting placeholder",
  );
  assert.ok(
    !/尚未运行|等待计划时间|已暂停|运行中/.test(previewDetail.text),
    "Connecting placeholder must not invent a live run status",
  );
  assert.ok(
    previewDetail.mutations.every((control) => control.disabled),
    "Unobserved task has no enabled mutation controls",
  );
  await page.screenshot({ path: join(evidence, "preview-connecting.png") });
  await writeFile(
    join(evidence, "preview-connecting.aria.txt"),
    await page.locator("body").ariaSnapshot(),
  );
  const passive = generations(allColdOwners);
  assert.deepEqual(passive, beforeSelection, "catalog and selection never start any cold owner");
  await writeFile(join(evidence, "passive-generations.json"), JSON.stringify(passive, null, 2));
  await page
    .locator(`main[data-task-id="${task.id}"]`)
    .getByRole("button", { name: "打开项目以更新", exact: true })
    .click();
  if (startup) {
    const held = await until(() => pendingActivation, "original native activation intercepted");
    if (process.env.AREAL_TASK_CATALOG_SLOW_HANDSHAKE === "1")
      await new Promise((resolve) => setTimeout(resolve, 6500));
    assert.equal(ready(taskOwner), false, "the held request has not started Core");
    assert.equal(
      await row.isVisible(),
      true,
      "persisted row remains visible during pending activation",
    );
    assert.equal(
      await page.getByRole("alert").count(),
      0,
      "the pending operation does not surface an error",
    );
    const published = await readTasks(taskOwner);
    assert.ok(
      published.owners.some(
        (owner) =>
          owner.projectId === taskOwner &&
          owner.status === "unobserved" &&
          owner.source === "published" &&
          owner.coverage?.kind === "snapshot",
      ),
    );
    assert.equal(published.data.filter((row) => row.id === task.id).length, 1);
    await writeFile(
      join(evidence, "pending-activation.json"),
      JSON.stringify(
        {
          id: held.id,
          receivedAt: held.receivedAt,
          published,
        },
        null,
        2,
      ),
    );
    held.release();
    await until(() => held.result || held.error, "original activation reply observed");
    assert.equal(held.error, undefined);
    assert.equal(held.result.state, "ready");
  }
  await until(() => ready(taskOwner), "explicitly refreshed owner ready");
  assert.deepEqual(
    generations(allColdOwners.filter((id) => id !== taskOwner)),
    beforeSelection.filter((item) => item.projectId !== taskOwner),
    "explicit refresh leaves unrelated owners cold",
  );
  await until(() => row.isEnabled(), "management row enabled");
  if (startup) {
    const live = await readTasks(taskOwner);
    assert.ok(
      live.owners.some(
        (owner) =>
          owner.projectId === taskOwner && owner.status === "ready" && owner.source === "live",
      ),
    );
    assert.equal(live.data.filter((row) => row.id === task.id).length, 1);
    await writeFile(join(evidence, "ready-directory.json"), JSON.stringify(live, null, 2));
    if (process.env.AREAL_TASK_CATALOG_WEB_HANDOFF === "1") {
      await writeFile(
        join(scratch, "web-handoff.json"),
        JSON.stringify({
          home: env.AREAL_HARNESS_SERVICE_HOME,
          projectId: taskOwner,
          taskId: task.id,
        }),
      );
      console.log(JSON.stringify({ webHandoff: scratch }));
      await until(
        () =>
          readFile(join(scratch, "web-done"), "utf8").then(
            () => true,
            () => false,
          ),
        "Web handoff completion",
      );
    }
  }
  if ((await row.getAttribute("aria-pressed")) !== "true") await row.click();
  const currentTask = (await readTasks(taskOwner)).data.find((value) => value.id === task.id);
  const taskMenu = page.locator(`[data-scheduled-task-menu="${task.id}"]`);
  const manageTask = async (label) => {
    if (!(await taskMenu.isVisible())) {
      await page
        .locator(`main[data-task-id="${task.id}"]`)
        .getByRole("button", { name: "任务资源", exact: true })
        .click();
    }
    await taskMenu.click();
    await page.getByRole("menuitem", { name: label, exact: true }).click();
  };
  if (currentTask.paused) {
    await manageTask("开启");
    await until(
      async () => !(await readTasks(taskOwner)).data.find((value) => value.id === task.id).paused,
      "reused task enabled before pause acceptance",
    );
  }
  await manageTask("暂停");
  const readback = await until(async () => {
    const r = await readTasks(taskOwner);
    assert.equal(r.errors.length, 0);
    const found = r.data.filter((t) => t.id === task.id);
    assert.equal(found.length, 1);
    return found[0].paused && found[0];
  }, "real pause readback");
  await writeFile(join(evidence, "paused-readback.json"), JSON.stringify(readback, null, 2));
  assert.equal(
    observation.executionReady,
    false,
    "Persisted task must be visible before owner execution ready",
  );
  assert.ok(
    [...observation.statuses, observation.rowText].some((text) =>
      /状态.*刷新|刷新.*状态|正在更新任务状态|尚未确认最新状态|上次记录|本次读取/.test(text),
    ),
    "Persisted preview explicitly identifies status refresh",
  );
  assert.deepEqual(errors, [], "No renderer errors");
} catch (e) {
  failure = e.stack;
  console.error(failure);
  if (page) {
    await page.screenshot({ path: join(evidence, "failure.png") }).catch(() => {});
    await page
      .locator("body")
      .ariaSnapshot()
      .then((tree) => writeFile(join(evidence, "failure.aria.txt"), tree))
      .catch(() => {});
  }
} finally {
  try {
    await close();
  } catch (e) {
    failure ??= e.stack;
  }
  await fixture.close();
  const sourceAfter = await sourceHashes();
  const drift = [...new Set([...Object.keys(sourceBefore), ...Object.keys(sourceAfter)])].filter(
    (path) => sourceBefore[path] !== sourceAfter[path],
  );
  if (drift.length) failure ??= "Tested source changed during run: " + drift.join(", ");
  if (
    createHash("sha256")
      .update(await readFile(binary))
      .digest("hex") !== identity.sha256
  )
    failure ??= "Core binary changed during acceptance";
  await writeFile(
    join(evidence, "manifest.json"),
    JSON.stringify(
      {
        passed: !failure,
        startup,
        identity,
        sourceBefore,
        sourceAfter,
        scratch,
        taskOwner,
        irrelevantOwners,
        scheduledOwners,
        taskId: task?.id,
        observation,
        previewDetail,
        visibleMs: observation && observation.visibleAt - observation.clickedAt,
        cleanup,
        errors,
        drift,
        failure,
        boundary:
          "Real persisted future Task via production bridge/Core setup, real source Electron/renderer, no startup delay, actual browser click through visible rAF. Read-only owner status is observed through the isolated Rust service inventory. Primary connected; scheduled owner cold. Physical input, real provider, installed package and OS cache eviction are not covered.",
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      evidence,
      scratch,
      visibleMs: observation && observation.visibleAt - observation.clickedAt,
      cleanup,
      errors,
      drift,
      failure,
    }),
  );
  if (failure) process.exitCode = 1;
}
