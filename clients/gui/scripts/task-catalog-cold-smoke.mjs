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
import { withSmokeDeadline } from "./smoke-deadline.mjs";
import { assertApplicationStopped, closeSmokeApplication } from "./application-cleanup.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
  gui = process.env.AREAL_COLD_GUI_ROOT
    ? resolve(process.env.AREAL_COLD_GUI_ROOT)
    : process.env.AREAL_VERIFY_ROOT
      ? join(resolve(process.env.AREAL_VERIFY_ROOT), "clients/gui")
      : join(root, "clients/gui");
const require = createRequire(join(root, "clients/gui/app/package.json"));
const { _electron: electron } = require("playwright-core");
const { ServiceConnection, waitForServiceExit } = require(
  join(gui, "app/src/core/service-client.cjs"),
);
const binary = resolve(process.env.AREAL_CORE_BIN || join(root, "target/debug/areal"));
const seed = process.env.AREAL_COLD_FIXTURE_MANIFEST
  ? JSON.parse(await readFile(process.env.AREAL_COLD_FIXTURE_MANIFEST, "utf8"))
  : undefined;
if (seed) {
  assert.match(seed.scratch, /^\/private\/tmp\/areal-cold-red-[A-Za-z0-9]+$/);
  assert.ok(
    seed.cleanup.length && seed.cleanup.every((entry) => entry.stopped),
    "only a stopped owned cold fixture may be reused",
  );
}
const scratch = seed?.scratch ?? (await makeTempDir("areal-cold-red-"));
const evidence = process.env.AREAL_COLD_EVIDENCE
  ? resolve(process.env.AREAL_COLD_EVIDENCE)
  : await trackedMkdtemp(join(root, ".scratch/task-catalog-cold-"));
await mkdir(evidence, { recursive: true });
const primary = join(scratch, "primary"),
  user = join(scratch, "user");
await mkdir(primary, { recursive: true });
await mkdir(user, { recursive: true });
const config = join(scratch, "config.toml");
await writeFile(
  config,
  'schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:9/v1/chat/completions"\n',
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
const startTrace = join(evidence, "owner-starts.jsonl");
await writeFile(startTrace, "");
const fixture = await applicationFixture(
  gui,
  join(scratch, "app"),
  `
const { CoreBackend } = require(${JSON.stringify(join(gui, "../../services/workbench/src/desktop/core/backend.cjs"))});
const originalStart = CoreBackend.prototype.startProject;
CoreBackend.prototype.startProject = function(id) {
  require("node:fs").appendFileSync(${JSON.stringify(startTrace)}, JSON.stringify({projectId:id,at:Date.now()})+"\\n");
  return originalStart.call(this, id);
};
`,
);
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
    join(gui, "app/bridge"),
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
const objective = "COLD_PERSISTED_TASK";
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
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await until(async () => (await snapshot()).connection?.state === "ready", "Desktop ready");
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1488, 1056);
    w.show();
    w.focus();
  });
}
async function close() {
  if (!app) return;
  const metadata = await readFile(join(scratch, "core/service.json"), "utf8").then(JSON.parse);
  await page.getByRole("button", { name: "首页", exact: true }).click();
  const connection = new ServiceConnection();
  try {
    await connection.connect(metadata);
    const hello = await until(async () => {
      const value = await connection.request("hello", {
        protocol: metadata.protocol,
        identity: metadata.identity,
      });
      return !value.service.activeCommands && !value.service.starting && value;
    }, "all submitted catalog and control commands settle before fixture shutdown");
    await connection.request(
      "stopService",
      {
        protocol: metadata.protocol,
        cancel: true,
        expectedDesktopGeneration: metadata.desktopGeneration,
        expectedTargets: hello.service.targets,
      },
      true,
    );
    await waitForServiceExit(join(scratch, "core"), metadata);
  } finally {
    connection.close();
  }
  await withSmokeDeadline(
    "catalog fixture exit",
    () => app.evaluate(({ app }) => app.exit(0)),
    5000,
  ).catch(() => {});
  await closeSmokeApplication(app);
  app = null;
  await assertApplicationStopped(binary, env, metadata);
  cleanup.push({
    pid: metadata.pid,
    stopped: true,
    method:
      "identity-checked service stop and fixture exit; product quit is outside this catalog check",
  });
}
try {
  if (!seed) {
    await launch();
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    }, primary);
    await page.evaluate(() => window.arealDesktop.chooseProject());
    primaryId = (
      await until(
        async () =>
          (await snapshot()).projects.find((p) => p.root === primary && p.state?.connected),
        "primary ready",
      )
    ).id;
    for (let index = 0; index < 30; index++) {
      const owner = await call("projectless", { operation: "prepare", requestId: randomUUID() });
      irrelevantOwners.push(owner.projectId);
    }
    for (let index = 0; index < 3; index++) {
      const prepared = await call("projectless", { operation: "prepare", requestId: randomUUID() });
      taskOwner = prepared.projectId;
      await call("connect", { projectId: taskOwner });
      await until(
        async () => (await snapshot()).projects.find((p) => p.id === taskOwner)?.state?.connected,
        "task owner ready",
      );
      const source = await call("create", { projectId: taskOwner, requestId: randomUUID() });
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
  } else {
    taskOwner = seed.taskOwner;
    task = { id: seed.taskId };
    irrelevantOwners.push(...seed.irrelevantOwners);
    scheduledOwners.push(...seed.scheduledOwners);
    const owners = JSON.parse(await readFile(join(scratch, "core/projects.json"), "utf8"));
    primaryId = owners.find((owner) => owner.root === primary).id;
    assert.equal(
      seed.identity.sha256,
      identity.sha256,
      "reused fixture keeps the same Core binary",
    );
  }
  await launch();
  await call("connect", { projectId: primaryId });
  await until(
    async () => (await snapshot()).projects.find((p) => p.id === primaryId)?.state?.connected,
    "primary ready",
  );
  assert.equal(
    !!(await snapshot()).projects.find((p) => p.id === taskOwner)?.state?.connected,
    false,
    "scheduled owner cold before click",
  );
  await writeFile(startTrace, "");
  const projectionSource = await readFile(
    join(gui, "packages/workbench/client/state-projection.cjs"),
    "utf8",
  );
  await page.evaluate((source) => {
    const module = { exports: {} };
    Function("module", source)(module);
    const reader = new module.exports.ProjectionReader();
    window.__coldProjectionErrors = [];
    window.arealDesktop.onProjection((message) => {
      try {
        window.__coldSnapshot = reader.read(message.frame);
      } catch (error) {
        window.__coldProjectionErrors.push(error.message);
      }
    });
    window.arealDesktop.requestProjection(999999);
  }, projectionSource);
  await page.waitForFunction(() => window.__coldSnapshot);
  await page.getByRole("button", { name: "定时任务", exact: true }).evaluate(
    (button, { objective, taskOwner }) => {
      const timing = (window.__coldTaskTiming = { clickedAt: null, visibleAt: null });
      let frame = 0;
      const check = () => {
        if (timing.clickedAt === null || timing.visibleAt !== null) return;
        const row = [...document.querySelectorAll("button[aria-label]")].find(
          (el) => el.getAttribute("aria-label") === "打开定时任务 " + objective,
        );
        if (!row || frame) return;
        frame = requestAnimationFrame(() => {
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
            timing.executionReady = !!window.__coldSnapshot.projects.find((p) => p.id === taskOwner)
              ?.state?.connected;
            timing.owner = window.__coldSnapshot.projects.find((p) => p.id === taskOwner);
            timing.disabled = row.disabled;
            timing.statuses = [...document.querySelectorAll('[role="status"]')].map(
              (el) => el.textContent,
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
    },
    { objective, taskOwner },
  );
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
  assert.ok(
    !observation.owner?.core?.runtimeEpoch,
    "Persisted task must be visible before execution Core authenticates",
  );
  assert.equal(observation.disabled, false, "Published task row remains selectable");
  await row.click();
  previewDetail = await page.evaluate(
    ({ taskOwner }) => ({
      owner: window.__coldSnapshot.projects.find((owner) => owner.id === taskOwner),
      text: document.querySelector(".task-conversation")?.textContent,
      mutations: [...document.querySelectorAll(".task-conversation button")]
        .filter((button) =>
          ["暂停", "开启", "立即运行", "停止本次运行", "删除"].includes(button.textContent?.trim()),
        )
        .map((button) => ({ label: button.textContent, disabled: button.disabled })),
    }),
    { taskOwner },
  );
  assert.equal(
    !!previewDetail.owner?.state?.connected,
    false,
    "Opening the preview must exercise the unobserved connecting state",
  );
  assert.ok(
    /连接|更新任务状态|尚未确认/.test(previewDetail.text),
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
  const coldStarts = (await readFile(startTrace, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  assert.deepEqual(
    coldStarts.filter((entry) =>
      [...irrelevantOwners, ...scheduledOwners].includes(entry.projectId),
    ),
    [],
    "catalog and selection never start any cold owner",
  );
  await writeFile(join(evidence, "passive-starts.json"), JSON.stringify(coldStarts, null, 2));
  await page.getByRole("button", { name: "刷新这个项目", exact: true }).last().click();
  await until(
    async () => (await snapshot()).projects.find((p) => p.id === taskOwner)?.state?.connected,
    "explicitly refreshed owner ready",
  );
  const explicitStarts = (await readFile(startTrace, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  assert.equal(
    explicitStarts.filter((entry) => irrelevantOwners.includes(entry.projectId)).length,
    0,
    "explicit refresh leaves unrelated owners cold",
  );
  await until(() => row.isEnabled(), "management row enabled");
  if ((await row.getAttribute("aria-pressed")) !== "true") await row.click();
  const currentTask = (await call("tasks", { operation: "list", projectId: taskOwner })).data.find(
    (value) => value.id === task.id,
  );
  if (currentTask.paused) {
    await page.getByRole("button", { name: "开启", exact: true }).click();
    await until(
      async () =>
        !(await call("tasks", { operation: "list", projectId: taskOwner })).data.find(
          (value) => value.id === task.id,
        ).paused,
      "reused task enabled before pause acceptance",
    );
  }
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  const readback = await until(async () => {
    const r = await call("tasks", { operation: "list", projectId: taskOwner });
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
    observation.statuses.some((text) =>
      /状态.*刷新|刷新.*状态|正在更新任务状态|尚未确认最新状态|上次记录|本次读取/.test(text),
    ),
    "Persisted preview explicitly identifies status refresh",
  );
  assert.deepEqual(errors, [], "No renderer errors");
  assert.deepEqual(
    await page.evaluate(() => window.__coldProjectionErrors),
    [],
    "Read-only projection observer decoded every frame",
  );
} catch (e) {
  failure = e.stack;
  console.error(failure);
  if (page) await page.screenshot({ path: join(evidence, "failure.png") }).catch(() => {});
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
          "Real persisted future Task via production bridge/Core setup, real source Electron/renderer, no startup delay, actual browser click through visible rAF. Read-only projection observer uses production ProjectionReader. Primary connected; scheduled owner cold. Physical input, real provider, installed package and OS cache eviction are not covered.",
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
