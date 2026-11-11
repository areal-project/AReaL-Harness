import { artifactHashes } from "./support/performance-profile.mjs";
import { startupResources, startupEnvironment, summarizeStartup } from "./startup-resources.mjs";
import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm, readdir, chmod } from "node:fs/promises";
import { trackedMkdtemp } from "./support/host-cleanup.cjs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { assertApplicationStopped } from "./application-cleanup.mjs";
import { applicationFixture } from "./application-fixture.mjs";
import { CoreClient } from "../packages/runtime-client/core.js";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const evidenceRoot = join(root, ".scratch/startup-connection-investigation");
await mkdir(evidenceRoot, { recursive: true });
const evidence = await trackedMkdtemp(join(evidenceRoot, "cold-"));
const launchLog = join(evidence, "playwright.log");
process.env.DEBUG = "pw:browser";
process.env.DEBUG_COLORS = "0";
process.env.DEBUG_FILE = launchLog;
const { _electron: electron } = require("playwright-core");
const scratch = await makeTempDir("ast-");
const rounds = Number(process.env.AREAL_STARTUP_ROUNDS ?? 5);
assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 10);
const modelCount = Number(process.env.AREAL_STARTUP_MODEL_COUNT ?? 9);
const catalogReads = Number(process.env.AREAL_STARTUP_CATALOG_READS ?? 0);
assert.ok(Number.isInteger(modelCount) && modelCount >= 1 && modelCount <= 128);
assert.ok(Number.isInteger(catalogReads) && catalogReads >= 0 && catalogReads <= 20);
const binary = process.env.AREAL_CORE_BIN || join(root, ".local/dev-bin/areal");
const variants = [
  ...(process.env.AREAL_STARTUP_BASELINE_BIN || process.env.AREAL_STARTUP_BASELINE_GUI
    ? [
        {
          label: "baseline",
          binary: process.env.AREAL_STARTUP_BASELINE_BIN || binary,
          gui: resolve(process.env.AREAL_STARTUP_BASELINE_GUI || gui),
        },
      ]
    : []),
  { label: process.env.AREAL_STARTUP_LABEL ?? "current", binary, gui },
];
const modelRequests = [],
  samples = [],
  errors = [],
  cleanups = [],
  lifecycleChecks = [];
const recordFields = new Set([
  "event",
  "pid",
  "runId",
  "attempt",
  "scope",
  "kind",
  "stage",
  "previous",
  "elapsedMs",
  "outcome",
  "at",
  "projectId",
  "connectionGeneration",
  "coreGeneration",
  "servicePid",
  "errorCode",
]);
const upstream = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  modelRequests.push({
    model: body.model,
    authorization: request.headers.authorization !== undefined,
  });
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "STARTUP_HISTORY_OK" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
  );
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
let app,
  activeApplication,
  activeFixture,
  seedModelRequestCount = 0,
  passed = false,
  failure = null;

async function until(predicate, label) {
  const end = Date.now() + 120000;
  while (Date.now() < end) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timeout: ${label}`);
}

async function launch(fixture, label, hideDuringRestore = false, preShowClose) {
  const started = performance.now();
  let entry = join(fixture.gui, "app");
  if (preShowClose) {
    activeApplication = await applicationFixture(
      fixture.gui,
      join(dirname(fixture.home), `app-${preShowClose}`),
      `
if (!process.argv.includes('--areal-core-service')) {
  const { app, ipcMain } = require('electron');
  let release; const gate = new Promise(resolve => { release = resolve; });
  app.startupFixture = { closed: false, release };
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => handle(channel, channel === 'areal-core:theme'
    ? async (...args) => { await gate; return listener(...args); } : listener);
  app.once('browser-window-created', (_event, window) => window.once('ready-to-show', () => {
    window.close(); app.startupFixture.closed = true;
  }));
}
`,
    );
    entry = activeApplication.path;
  }
  app = await electron.launch({
    executablePath: require("electron"),
    args: [entry],
    env: fixture.env,
    timeout: 120000,
  });
  const pid = app.process().pid;
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push({ label, message: error.message }));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  if (preShowClose) {
    await until(
      () => app.evaluate(({ app }) => app.startupFixture.closed),
      "native close before themed shell",
    );
    assert.equal(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
      false,
    );
    if (preShowClose === "early-activate") {
      await app.evaluate(({ app }) => app.emit("activate"));
      assert.equal(
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
        false,
        "explicit activation before theme readiness still obeys the paint barrier",
      );
    }
    await app.evaluate(({ app }) => app.startupFixture.release());
    if (preShowClose === "late-activate") {
      await until(async () => {
        const state = await page.evaluate(() => window.arealDesktop.snapshot());
        return state.projects[0]?.state?.connected && state.projects[0].summariesLoaded;
      }, "hidden startup finishes real Core restoration");
      await page
        .getByTestId("chat-view")
        .getByText("STARTUP_HISTORY_OK", { exact: true })
        .waitFor();
      assert.equal(
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
        false,
        "late theme and history readiness cannot resurrect a pre-show closed window",
      );
      assert.equal(
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()),
        false,
      );
      await app.evaluate(({ app }) => app.emit("activate"));
    }
    lifecycleChecks.push(
      `pre-show close with ${preShowClose} preserves native shell barrier and explicit activation`,
    );
  }
  await until(
    () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
    `${label} visible`,
  );
  const visibleMs = Math.round(performance.now() - started);
  const firstView = await page.evaluate(() => ({
    theme: document.documentElement.classList.contains("theme-areal-light") ? "light" : "dark",
    threadId: document
      .querySelector('[data-testid="areal-workbench"]')
      ?.getAttribute("data-thread-id"),
    greeting: !!document.querySelector(".draft-greeting"),
    title: document.querySelector(".header-task")?.textContent,
    input: !!document.querySelector('[data-testid="chat-input"]'),
    loading: !!document.querySelector('[data-testid="startup-loading"]'),
    logoLoaded: !!document.querySelector('[data-testid="startup-loading"] img')?.naturalWidth,
    sidebar: !!document.querySelector('[data-testid="areal-sidebar"]'),
    header: !!document.querySelector(".workspace-header"),
  }));
  if (firstView.loading) {
    assert.equal(firstView.logoLoaded, true, "the initial loading icon has loaded");
    assert.equal(firstView.sidebar, false, "loading never mounts a partial sidebar");
    assert.equal(firstView.header, false, "loading never mounts a partial workbench header");
    assert.equal(firstView.input, false, "loading never mounts a composer");
  }
  if (fixture.threadId) {
    assert.equal(
      firstView.threadId,
      fixture.threadId,
      "the first visible shell retains the selected conversation",
    );
    assert.equal(
      firstView.greeting,
      false,
      "a saved conversation never flashes the new-chat greeting",
    );
    assert.notEqual(
      firstView.title,
      "新对话",
      "the saved conversation header never flashes a new-chat title",
    );
    assert.equal(firstView.theme, "light", "the first visible frame uses the saved theme");
    if (label.endsWith("-0"))
      await page.screenshot({
        path: join(evidence, `${label}-first-visible.png`),
        animations: "disabled",
      });
  }
  if (hideDuringRestore) {
    const state = await page.evaluate(() => window.arealDesktop.snapshot());
    assert.equal(
      state.projects[0]?.state?.connected ?? false,
      false,
      "the native shell is visible while the real project is still restoring",
    );
    assert.equal(firstView.input, false, "restoring a selected conversation exposes no composer");
    assert.equal(
      firstView.loading,
      true,
      "the visible initial window shows only the loading screen",
    );
    if (hideDuringRestore === "quit") {
      await stop(fixture, label);
      lifecycleChecks.push(
        "safe application quit during visible initial restoration stops owned processes",
      );
      return;
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    assert.equal(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
      false,
    );
  }
  const snapshot = await until(async () => {
    const value = await page.evaluate(() => window.arealDesktop.snapshot());
    return (
      value.connection?.state === "ready" &&
      value.projects[0]?.state?.connected &&
      value.projects[0].summariesLoaded &&
      value
    );
  }, `${label} project connected`);
  if (fixture.threadId)
    await page.getByTestId("chat-view").getByText("STARTUP_HISTORY_OK", { exact: true }).waitFor();
  if (hideDuringRestore) {
    assert.equal(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
      false,
      "late backend/history restoration never reopens the closed window",
    );
    assert.equal(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()),
      false,
    );
    await app.evaluate(({ app }) => app.emit("activate"));
    await until(
      () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
      "explicit activation reopens the restored window",
    );
    lifecycleChecks.push(
      "native shell visible before Core is ready; close stays hidden through history restoration; explicit activation reopens",
    );
  }
  const durationMs = Math.round(performance.now() - started);
  const project = snapshot.projects[0];
  assert.equal(
    project.models.length,
    modelCount + 3,
    "configured models, default alias, and missing-credential models are retained",
  );
  assert.equal(project.models.filter((model) => model.available).length, modelCount + 1);
  assert.deepEqual(
    project.models
      .filter((model) => !model.available)
      .map((model) => model.modelId)
      .sort(),
    ["missing-a", "missing-b"],
  );
  assert.equal(project.error, null);
  const mainLog = (await readFile(launchLog, "utf8"))
    .split("\n")
    .filter((line) => line.includes(`[pid=${pid}]`))
    .join("\n");
  assert.ok(
    timingRecords(mainLog).some(
      (record) => record.scope === "gui.present_ready" && record.kind === "finish",
    ),
    "the visible window has completed its renderer presentation barrier",
  );
  await writeFile(join(evidence, `${label}-main.log`), mainLog);
  return { page, project, durationMs, visibleMs, firstView, mainRecords: timingRecords(mainLog) };
}

async function stop(fixture, label) {
  let metadata;
  try {
    metadata = JSON.parse(await readFile(join(fixture.home, "service.json"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const mainPid = app?.process().pid;
  if (app) {
    let timer;
    try {
      await Promise.race([
        app.close(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Isolated Electron did not quit within 30 seconds")),
            30000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (activeApplication) {
        await activeApplication.close();
        activeApplication = null;
      }
      app = null;
    }
  }
  if (activeApplication) {
    await activeApplication.close();
    activeApplication = null;
  }
  await assertApplicationStopped(fixture.binary, fixture.env, metadata);
  if (mainPid)
    await until(() => {
      try {
        process.kill(mainPid, 0);
        return false;
      } catch (error) {
        if (error.code === "ESRCH") return true;
        throw error;
      }
    }, `${label} Main exits`);
  let servicePids = [];
  try {
    servicePids = [
      ...new Set(
        timingRecords(await readFile(join(fixture.home, "service.log"), "utf8")).map(
          (record) => record.pid,
        ),
      ),
    ];
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const pid of servicePids)
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        if (error.code === "ESRCH") return true;
        throw error;
      }
    }, `${label} logged service ${pid} exits`);
  cleanups.push({ label, mainPid, desktopPid: metadata?.pid, servicePids, stopped: true });
}

function timingRecords(text) {
  return text
    .split("\n")
    .filter((line) => line.includes("[startup] "))
    .map((line) => {
      const record = JSON.parse(line.slice(line.indexOf("[startup] ") + "[startup] ".length));
      assert.equal(record.event, "startup");
      assert.deepEqual(
        Object.keys(record).filter((key) => !recordFields.has(key)),
        [],
        "startup log fields exclude arbitrary payloads",
      );
      assert.match(record.scope, /^[a-z_.]+$/);
      assert.ok(Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0);
      if (record.previous) {
        assert.deepEqual(Object.keys(record.previous).sort(), ["durationMs", "outcome", "stage"]);
        assert.ok(Number.isFinite(record.previous.durationMs) && record.previous.durationMs >= 0);
        assert.match(record.previous.stage, /^[a-z_]+$/);
      }
      return record;
    });
}

async function measureCatalog(descriptor) {
  if (!catalogReads) return [];
  const auth = JSON.parse(await readFile(descriptor.authFile, "utf8"));
  const principal = auth.principals.find((item) =>
    ["observe", "interact", "manage"].every((permission) => item.permissions?.includes(permission)),
  );
  assert.ok(principal?.token);
  const WebSocket = require("ws");
  let socket;
  const client = new CoreClient({
    createSocket: () =>
      (socket = new WebSocket(descriptor.endpoint, {
        headers: { Authorization: `Bearer ${principal.token}` },
        followRedirects: false,
      })),
  });
  try {
    await client.connect();
    const proof = await client.request("areal/server/modelConfiguration/read", {
      expectedGeneration: descriptor.generation,
    });
    assert.equal(proof.serviceId, descriptor.serviceId);
    assert.equal(proof.generation, descriptor.generation);
    const durations = [];
    for (let index = 0; index < catalogReads; index++) {
      const started = performance.now();
      const result = await client.request("areal/model/list");
      durations.push(performance.now() - started);
      assert.equal(result.data.length, modelCount + 3);
      assert.equal(result.data.filter((model) => model.available).length, modelCount + 1);
      assert.deepEqual(
        result.data
          .filter((model) => !model.available)
          .map((model) => model.modelId)
          .sort(),
        ["missing-a", "missing-b"],
      );
    }
    return durations;
  } finally {
    let timer;
    const closed =
      !socket || socket.readyState === WebSocket.CLOSED
        ? Promise.resolve()
        : new Promise((resolve, reject) => {
            socket.once("close", resolve);
            timer = setTimeout(() => {
              socket.terminate();
              reject(new Error("Catalog observation socket did not close"));
            }, 10000);
          });
    client.close();
    try {
      await closed;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function removeFixture(directory) {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await removeFixture(join(directory, entry.name));
  }
}

console.log(`Evidence: ${evidence}`);
try {
  for (const variant of variants) {
    const base = join(scratch, variant.label),
      home = join(base, "core"),
      registry = join(base, "registry");
    const workspace = join(base, "workspace"),
      user = join(base, "user");
    await mkdir(workspace, { recursive: true });
    await mkdir(home);
    await mkdir(user);
    execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
    const config = join(base, "config.toml");
    await writeFile(
      config,
      `schema_version=1\n[model]\ncatalog_version=1\nprovider="fixture"\nname="fixture-0"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${upstream.address().port}/v1/chat/completions"\nmodels=[${Array.from({ length: modelCount }, (_, i) => `{id="fixture-${i}",enabled=true}`).join(",")}]\n[model.providers.missing]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${upstream.address().port}/v1/chat/completions"\napi_key_env="AREAL_STARTUP_MISSING_CREDENTIAL"\nmodels=[{id="missing-a",enabled=true},{id="missing-b",enabled=true}]\n`,
    );
    const projectId = createHash("sha256").update(workspace).digest("hex").slice(0, 24);
    await writeFile(
      join(home, "projects.json"),
      JSON.stringify([{ id: projectId, root: workspace }]),
    );
    const env = {
      ...process.env,
      AREAL_CORE_BIN: variant.binary,
      AREAL_GUI_USER_DATA: join(base, "electron"),
      AREAL_CORE_HOME: home,
      AREAL_CORE_USER_HOME: user,
      AREAL_HARNESS_HOME: join(base, "config-home"),
      AREAL_HARNESS_SERVICE_HOME: registry,
      AREAL_CORE_CONFIG: config,
    };
    for (const key of [
      "AREAL_CORE_WORKSPACE",
      "AREAL_HARNESS_CONFIG",
      "AREAL_CORE_DESKTOP_CONFIG",
      "AREAL_HARNESS_TOOL_EXTENSIONS",
      "AREAL_STARTUP_MISSING_CREDENTIAL",
    ])
      delete env[key];
    const fixture = {
      ...variant,
      home,
      registry,
      env,
      generation: null,
      source: {
        head: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: variant.gui,
          encoding: "utf8",
        }).trim(),
        diffSha256: createHash("sha256")
          .update(
            execFileSync("git", ["diff", "--binary", "HEAD"], {
              cwd: variant.gui,
              maxBuffer: 64 * 1024 * 1024,
            }),
          )
          .digest("hex"),
        rendererArtifacts: await artifactHashes(join(variant.gui, "renderer/dist")),
        appSources: await artifactHashes(join(variant.gui, "app/src")),
      },
    };
    const binaryDigests = {};
    for (const name of ["areal", "areal-runtime", "areal-runtime-fs"]) {
      binaryDigests[name] = createHash("sha256")
        .update(await readFile(join(dirname(variant.binary), name)))
        .digest("hex");
    }
    fixture.binaryDigests = binaryDigests;
    fixture.binaryFingerprint = createHash("sha256")
      .update(JSON.stringify(binaryDigests))
      .digest("hex");
    variants[variants.indexOf(variant)] = fixture;
    activeFixture = fixture;
    const { page } = await launch(fixture, `${variant.label}-seed`);
    await page.getByRole("button", { name: "新聊天", exact: true }).click();
    await page.getByTestId("chat-input").fill("Confirm startup and persist this conversation");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await until(async () => {
      const snapshot = await page.evaluate(() => window.arealDesktop.snapshot());
      return Object.values(snapshot.projects[0].state.threads).some(
        (thread) => thread.turns?.at(-1)?.status === "completed",
      );
    }, "seed completed");
    assert.deepEqual(modelRequests.at(-1), { model: "fixture-0", authorization: false });
    fixture.threadId = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
    assert.ok(fixture.threadId, "seed remembers the completed conversation");
    await page.evaluate(() => localStorage.setItem("areal-gui:theme", "soft-glass"));
    await stop(fixture, `${variant.label}-seed`);
  }
  const initialRequests = modelRequests.length;
  seedModelRequestCount = initialRequests;
  for (let round = 0; round < rounds; round++)
    for (const fixture of variants) {
      activeFixture = fixture;
      const label = `${fixture.label}-${round}`;
      const { page, project, durationMs, visibleMs, firstView, mainRecords } = await launch(
        fixture,
        label,
      );
      assert.notEqual(project.core.connectionGeneration, undefined);
      const descriptor = JSON.parse(
        await readFile(
          join(fixture.registry, "services", project.core.instanceId, "service.json"),
          "utf8",
        ),
      );
      const components = JSON.parse(
        await readFile(
          join(fixture.registry, "services", project.core.instanceId, "components.json"),
          "utf8",
        ),
      );
      assert.equal(
        components.binaries,
        fixture.binaryFingerprint,
        "service identity still hashes the complete Core and Runtime contents",
      );
      assert.notEqual(
        descriptor.generation,
        fixture.generation,
        "each sample uses a new Core generation",
      );
      fixture.generation = descriptor.generation;
      await page
        .getByTestId("chat-view")
        .getByText("STARTUP_HISTORY_OK", { exact: true })
        .waitFor();
      if (round > 0)
        assert.equal(
          await page.getByTestId("chat-input").innerText(),
          `Unsent draft ${round - 1}`,
          "the previous unsent draft survives process-cold restart",
        );
      await page.getByTestId("chat-input").fill(`Unsent draft ${round}`);
      assert.equal(await page.getByRole("button", { name: "发送", exact: true }).isEnabled(), true);
      assert.equal(
        modelRequests.length,
        initialRequests,
        "cold restart does not replay saved messages",
      );
      const serviceLog = await readFile(join(fixture.home, "service.log"), "utf8");
      await writeFile(join(evidence, `${label}-service.log`), serviceLog);
      const metadata = JSON.parse(await readFile(join(fixture.home, "service.json"), "utf8"));
      const records = timingRecords(serviceLog).filter((record) => record.pid === metadata.pid);
      assert.ok(
        records.some(
          (record) =>
            record.scope === "core.connect" && record.kind === "finish" && record.outcome === "ok",
        ),
        "project connection records its completed timing",
      );
      assert.ok(
        mainRecords.some(
          (record) =>
            record.scope === "service.initialize" &&
            record.kind === "finish" &&
            record.outcome === "ok",
        ),
        "GUI connection records its completed timing",
      );
      assert.ok(
        mainRecords.some(
          (record) =>
            record.scope === "gui.startup" && record.kind === "finish" && record.outcome === "ok",
        ),
        "Main startup is captured before Electron launch completes",
      );
      const stages = [...records, ...mainRecords]
        .filter((record) => record.previous)
        .map((record) => ({ scope: record.scope, ...record.previous }));
      const catalogReadMs = await measureCatalog(descriptor);
      assert.equal(
        modelRequests.length,
        initialRequests,
        "catalog inspection sends no provider requests",
      );
      if (round === 0 || round === rounds - 1)
        await page.screenshot({ path: join(evidence, `${label}.png`), animations: "disabled" });
      samples.push({
        label: fixture.label,
        round,
        durationMs,
        visibleMs,
        firstView,
        catalogReadMs,
        resources: await startupResources(app, page),
        windowTiming: Object.fromEntries(
          mainRecords
            .filter(
              (record) =>
                ["gui.ready_to_show", "gui.present_ready", "gui.first_show"].includes(
                  record.scope,
                ) && record.kind === "finish",
            )
            .map((record) => [record.scope, record.elapsedMs]),
        ),
        generation: descriptor.generation,
        models: project.models.length,
        restoredHistory: true,
        stages,
      });
      console.log(
        JSON.stringify({
          label: fixture.label,
          round,
          durationMs,
          visibleMs,
          stages: stages.filter((stage) => stage.durationMs >= 500),
        }),
      );
      await stop(fixture, label);
    }
  if (process.env.AREAL_STARTUP_CHECK_HIDE === "1") {
    activeFixture = variants.at(-1);
    await launch(activeFixture, "current-hidden-restoration", true);
    assert.equal(
      modelRequests.length,
      initialRequests,
      "hidden restoration does not replay saved messages",
    );
    await stop(activeFixture, "current-hidden-restoration");
    await launch(activeFixture, "current-quit-during-restoration", "quit");
    assert.equal(modelRequests.length, initialRequests, "safe early quit does not replay messages");
    for (const activation of ["late-activate", "early-activate"]) {
      await launch(activeFixture, `current-pre-show-${activation}`, false, activation);
      assert.equal(
        modelRequests.length,
        initialRequests,
        "pre-show close and activation do not replay messages",
      );
      await stop(activeFixture, `current-pre-show-${activation}`);
    }
  }
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  failure = { name: error.name, message: error.message };
  throw error;
} finally {
  let cleanupFailure = null;
  try {
    if (activeFixture) await stop(activeFixture, "finally");
  } catch (error) {
    passed = false;
    process.exitCode = 1;
    cleanupFailure = { name: error.name, message: error.message };
  }
  {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    const binaries = await Promise.all(
      variants.map(async (variant) => ({
        label: variant.label,
        binary: variant.binary,
        sha256: createHash("sha256")
          .update(await readFile(variant.binary))
          .digest("hex"),
      })),
    );
    if (passed) {
      try {
        await removeFixture(scratch);
        await rm(scratch, { recursive: true });
      } catch (error) {
        passed = false;
        process.exitCode = 1;
        cleanupFailure = { name: error.name, message: error.message };
      }
    }
    await writeFile(
      join(evidence, "manifest.json"),
      JSON.stringify(
        {
          passed,
          rounds,
          modelCount,
          catalogReads,
          environment: startupEnvironment(),
          summary: summarizeStartup(samples),
          samples,
          modelRequests,
          seedModelRequestCount,
          errors,
          cleanups,
          lifecycleChecks,
          cleanupFailure,
          failure,
          binaries,
          scratch,
          variants: variants.map(({ label, gui, source, binaryDigests }) => ({
            label,
            gui,
            source,
            binaryDigests,
          })),
          sameCoreRuntimeAcrossVariants:
            new Set(variants.map((variant) => variant.binaryFingerprint)).size === 1,
          scriptSha256: createHash("sha256")
            .update(await readFile(fileURLToPath(import.meta.url)))
            .digest("hex"),
          revision: execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: root,
            encoding: "utf8",
          }).trim(),
          scope:
            "Real source Electron/Core/Runtime, process-cold restart with retained synthetic history. OS and filesystem caches are not cleared. Local deterministic model; no user config or subscription credentials.",
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({
        passed,
        evidence,
        samples: samples.map(({ stages: _stages, ...sample }) => sample),
      }),
    );
  }
}
