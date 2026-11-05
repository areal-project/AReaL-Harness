import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { applicationFixture } from "./application-fixture.mjs";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const scratch = await makeTempDir("areal-architecture-");
const workspace = join(scratch, "workspace");
await mkdir(workspace);
await mkdir(join(scratch, "user", ".areal"), { recursive: true });
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end("<html><body><h1>ARCHITECTURE_PREVIEW</h1></body></html>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/preview`;
const config = join(scratch, "user", ".areal", "config.toml");
await writeFile(
  config,
  `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${server.address().port}/v1/chat/completions"\n`,
);
const deployment = join(scratch, "desktop.json");
await writeFile(
  deployment,
  JSON.stringify({
    profiles: [
      { id: "fixture", revision: "v1", displayName: "Fixture", instructions: "Complete the task" },
    ],
  }),
);
const env = {
  ...process.env,
  AREAL_CORE_BIN: process.env.AREAL_CORE_BIN || resolve(gui, "../../target/debug/areal"),
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_CORE_USER_HOME: join(scratch, "user"),
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_CORE_DESKTOP_CONFIG: deployment,
};
delete env.AREAL_CORE_WORKSPACE;
delete env.AREAL_CORE_CONFIG;
delete env.AREAL_HARNESS_CONFIG;
delete env.AREAL_HARNESS_HOME;
delete env.ELECTRON_RUN_AS_NODE;
const application = await applicationFixture(gui, join(scratch, "app"));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const sourcePaths = [
  "app/src/core/preview.cjs",
  "app/src/core/main.cjs",
  "../../services/workbench/src/desktop/core/service-main.cjs",
  "app/src/core/service-client.cjs",
  "../../services/workbench/src/desktop/core/backend.cjs",
  "scripts/architecture-smoke.mjs",
  "scripts/application-fixture.mjs",
  "renderer/dist/index.html",
];
if ((await readdir(join(gui, "app/src/core"))).includes("preview-residency.cjs"))
  sourcePaths.push("app/src/core/preview-residency.cjs");
for (const name of await readdir(join(gui, "renderer/dist/assets")))
  if (/\.(js|css)$/.test(name)) sourcePaths.push(`renderer/dist/assets/${name}`);
const sourceHashes = Object.fromEntries(
  await Promise.all(sourcePaths.map(async (path) => [path, hash(await readFile(join(gui, path)))])),
);
const source = {
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  diffHash: hash(execFileSync("git", ["diff", "HEAD"], { cwd: root, maxBuffer: 16 * 1024 * 1024 })),
  sourceHashes,
  binary: env.AREAL_CORE_BIN,
  binaryHash: hash(await readFile(env.AREAL_CORE_BIN)),
  node: process.version,
  electron: require("electron/package.json").version,
  cwd: root,
};
let app,
  page,
  processHandle,
  passed = false;
const checks = [],
  errors = [],
  ownedPids = new Set(),
  cleanup = [],
  residency = [];
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};
const recordProcesses = async () => {
  const desktop = JSON.parse(await readFile(join(scratch, "core/service.json"), "utf8"));
  const services = await Promise.all(
    (await readdir(join(scratch, "registry/services"))).map(async (name) =>
      JSON.parse(await readFile(join(scratch, "registry/services", name, "service.json"), "utf8")),
    ),
  );
  for (const pid of [
    processHandle.pid,
    desktop.pid,
    ...services.flatMap((service) => [service.hostPid, service.corePid]),
  ]) {
    assert.ok(Number.isSafeInteger(pid) && alive(pid), `owned process ${pid} is alive`);
    ownedPids.add(pid);
  }
  return { mainPid: processHandle.pid, desktop, services };
};
let processIdentity;
async function until(predicate, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timeout: ${label}`);
}
const raw = (name, params) =>
  page.evaluate(({ name, params }) => window.arealDesktop.command(name, params), { name, params });
async function call(name, params) {
  const result = await raw(name, params);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}
const preview = (request) =>
  page.evaluate((request) => window.arealDesktop.preview(request), request);
const natives = () =>
  app.evaluate(
    ({ webContents }, prefix) =>
      webContents
        .getAllWebContents()
        .filter((content) => content.getURL().startsWith(prefix))
        .map((content) => ({ id: content.id, url: content.getURL() })),
    url,
  );
try {
  console.log("Architecture evidence:", scratch);
  app = await electron.launch({
    executablePath: require("electron"),
    args: [application.path],
    env,
  });
  processHandle = app.process();
  ownedPids.add(processHandle.pid);
  page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("[data-testid=areal-workbench]").waitFor({ timeout: 120000 });
  await until(
    async () =>
      (await page.evaluate(() => window.arealDesktop.snapshot())).connection?.state === "ready",
    "background Core ready",
  );
  const providers = await call("providers", { operation: "list" });
  assert.equal(
    providers.path,
    config,
    "real desktop IPC reads the default user Core configuration",
  );
  assert.equal(providers.data[0].id, "fixture");
  await assert.rejects(() => readFile(join(scratch, "registry", "config.toml")), {
    code: "ENOENT",
  });
  checks.push("real Electron IPC reads the global Core provider catalog without a config override");
  await app.evaluate(
    ({ dialog }, { path, origin }) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      const showMessageBox = dialog.showMessageBox.bind(dialog);
      dialog.showMessageBox = async (...args) => {
        const options = args.at(-1);
        const buttons = JSON.stringify(options.buttons);
        const development =
          options.title === "允许本地开发站点" &&
          options.message === `允许此浏览工作区访问 ${origin}？` &&
          buttons === JSON.stringify(["取消", "仅此工作区允许"]);
        const archive =
          options.message === "归档此会话？" && buttons === JSON.stringify(["取消", "归档会话"]);
        const stop =
          options.message === "停止共享后台服务？" &&
          buttons === JSON.stringify(["取消", "停止后台服务"]);
        return development || archive || stop ? { response: 1 } : showMessageBox(...args);
      };
    },
    { path: workspace, origin: new URL(url).origin },
  );
  const projectId = await page.evaluate(() => window.arealDesktop.chooseProject());
  const create = () => call("create", { projectId, profile: { id: "fixture", revision: "v1" } });
  const { threadId } = await create();
  for (const [name, params] of [
    ["not-a-command", {}],
    ["open", []],
    ["configure", { projectId, threadId, model: { providerId: "fixture" } }],
  ]) {
    const result = await raw(name, params);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INVALID_DESKTOP_REQUEST");
  }
  const coreError = await raw("open", { projectId, threadId: "missing-thread" });
  assert.equal(coreError.ok, false);
  assert.equal(typeof coreError.error.code, "number");
  await call("configure", { projectId, threadId, parameters: {} });
  processIdentity = await recordProcesses();
  checks.push(
    "real IPC rejects malformed capability requests and preserves numeric Core error codes",
  );
  const showOwner = async (ownerId, pageId) => {
    const state = await preview({
      operation: "show",
      projectId,
      threadId: ownerId,
      ...(pageId ? { pageId } : {}),
      visible: true,
      bounds: { x: 0, y: 80, width: 400, height: 300 },
    });
    await preview({
      operation: "selectPage",
      projectId,
      threadId: ownerId,
      pageId: state.browser.pageId,
    });
    await app.evaluate(({ app, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window.isMinimized()) window.restore();
      window.show();
      app.focus({ steal: true });
      window.focus();
    });
    await until(
      () =>
        app.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0];
          return window.isVisible() && !window.isMinimized() && window.isFocused();
        }),
      "visible focused window for development-site consent",
    );
    return state;
  };
  const initial = await showOwner(threadId);
  const originalPageId = initial.browser.pageId;
  await preview({ operation: "navigate", projectId, threadId, url });
  await until(
    async () => (await natives()).some((content) => content.url === url),
    "first native page",
  );
  const original = (await natives()).find((content) => content.url === url).id;
  const owners = [threadId, (await create()).threadId, (await create()).threadId],
    pages = [];
  for (let index = 0; index < 10; index++) {
    const ownerId = owners[index < 3 ? 0 : index < 7 ? 1 : 2];
    const created =
      index === 3 || index === 7
        ? await showOwner(ownerId)
        : await preview({ operation: "newPage", projectId, threadId: ownerId });
    const pageId = created.browser.pageId,
      target = `${url}?page=${index}`;
    await showOwner(ownerId, pageId);
    await preview({ operation: "navigate", projectId, threadId: ownerId, pageId, url: target });
    await until(async () => {
      const state = await preview({ operation: "state", projectId, threadId: ownerId, pageId });
      return (
        state.url === target &&
        !state.loading &&
        (await natives()).some((content) => content.url === target)
      );
    }, `native page ${index} loaded`);
    const state = await preview({ operation: "state", projectId, threadId: ownerId, pageId });
    pages.push({
      threadId: ownerId,
      pageId,
      url: target,
      nativeId: (await natives()).find((content) => content.url === target).id,
      pageGeneration: state.workspace.pages.find((page) => page.pageId === pageId).pageGeneration,
    });
    await showOwner(threadId, originalPageId);
    if (index === 2) {
      const before = (
        await preview({ operation: "state", projectId, threadId, pageId: originalPageId })
      ).workspace;
      const nativeBefore = await natives();
      assert.equal(before.pages.length, 4, "one workspace has four logical pages");
      await assert.rejects(() => preview({ operation: "newPage", projectId, threadId }), /4页/);
      assert.deepEqual(
        (await preview({ operation: "state", projectId, threadId, pageId: originalPageId }))
          .workspace,
        before,
        "rejected fifth page leaves the complete workspace snapshot unchanged",
      );
      assert.deepEqual(
        await natives(),
        nativeBefore,
        "rejected fifth page leaves native resources unchanged",
      );
      residency.push({ stage: "workspace-capacity", workspace: before, natives: nativeBefore });
      checks.push(
        "a workspace accepts four pages and rejects its fifth without changing its snapshot or native resources",
      );
    }
  }
  await until(async () => (await natives()).length === 8, "bounded native page cache");
  residency.push({
    stage: "global-capacity",
    owners,
    pages,
    original: { pageId: originalPageId, nativeId: original },
    natives: await natives(),
  });
  const pagesToPromoteBeforePinProbe = (await natives())
    .filter((content) => content.id !== original)
    .map((content) => {
      const record = pages.find((page) => page.nativeId === content.id && page.url === content.url);
      assert.ok(record, "cached native page maps to an existing logical page");
      return record;
    });
  assert.equal(
    new Set(pagesToPromoteBeforePinProbe.map((page) => page.pageId)).size,
    7,
    "seven cached other pages are available for the pin probe",
  );
  for (const cached of pagesToPromoteBeforePinProbe) {
    const state = await preview({
      operation: "state",
      projectId,
      threadId: cached.threadId,
      pageId: cached.pageId,
    });
    assert.equal(state.browser?.resource, "ready");
    assert.equal(state.browser.pageId, cached.pageId);
    await preview({
      operation: "selectPage",
      projectId,
      threadId: cached.threadId,
      pageId: cached.pageId,
    });
  }
  const pinProbe = await preview({ operation: "newPage", projectId, threadId: owners[2] });
  assert.ok(
    (await natives()).some((content) => content.id === original),
    "visible oldest native page is protected during reservation",
  );
  residency.push({ stage: "visible-pin-reservation", pinProbe, natives: await natives() });
  await showOwner(owners[2], pinProbe.browser.pageId);
  await preview({
    operation: "navigate",
    projectId,
    threadId: owners[2],
    pageId: pinProbe.browser.pageId,
    url: `${url}?pin-probe=1`,
  });
  await until(
    async () =>
      (await natives()).length === 8 &&
      (await natives()).some((content) => content.url === `${url}?pin-probe=1`),
    "bounded cache after visible LRU pin probe",
  );
  assert.ok(
    (await natives()).some((content) => content.id === original),
    "current native page is protected from eviction",
  );
  await showOwner(threadId, originalPageId);
  const evicted = pages[0];
  const suspended = await preview({
    operation: "state",
    projectId,
    threadId: evicted.threadId,
    pageId: evicted.pageId,
  });
  assert.equal(suspended.browser.resource, "suspended", "oldest idle logical page was evicted");
  assert.equal(suspended.url, evicted.url);
  assert.ok(
    !(await natives()).some((content) => content.id === evicted.nativeId),
    "eviction destroys the old native view",
  );
  const restoredState = await preview({
    operation: "show",
    projectId,
    threadId: evicted.threadId,
    pageId: evicted.pageId,
    visible: false,
  });
  assert.equal(
    restoredState.browser.pageId,
    evicted.pageId,
    "restore keeps the logical page identity",
  );
  assert.equal(
    restoredState.workspace.pages.find((page) => page.pageId === evicted.pageId).pageGeneration,
    evicted.pageGeneration + 1,
    "restore advances the native page generation",
  );
  assert.equal(
    restoredState.workspace.pages.length,
    4,
    "restoring at workspace capacity replaces the existing logical page",
  );
  residency.push({ stage: "restore", suspended, restoredState });
  await until(
    async () => (await natives()).some((content) => content.url === evicted.url),
    "evicted page restores its saved URL",
  );
  assert.equal((await natives()).length, 8, "restore preserves the global native cache bound");
  const restored = (await natives()).find((content) => content.url === evicted.url).id;
  assert.notEqual(restored, evicted.nativeId, "restore creates a new native view");
  await app.evaluate(
    ({ webContents }, id) => webContents.fromId(id).forcefullyCrashRenderer(),
    restored,
  );
  await until(
    async () =>
      (
        await preview({
          operation: "state",
          projectId,
          threadId: evicted.threadId,
          pageId: evicted.pageId,
        })
      ).browser.resource === "crashed",
    "renderer crash observed",
  );
  const reloaded = await preview({
    operation: "reload",
    projectId,
    threadId: evicted.threadId,
    pageId: evicted.pageId,
  });
  assert.equal(
    reloaded.browser.pageId,
    evicted.pageId,
    "crash recovery keeps the logical page identity",
  );
  assert.equal(
    reloaded.workspace.pages.find((page) => page.pageId === evicted.pageId).pageGeneration,
    evicted.pageGeneration + 2,
    "explicit crash reload advances the native page generation",
  );
  residency.push({ stage: "explicit-crash-reload", reloaded });
  await until(
    async () =>
      (await natives()).some((content) => content.url === evicted.url && content.id !== restored),
    "crashed preview rebuilt",
  );
  assert.equal(
    (await natives()).length,
    8,
    "explicit crash reload preserves the global native cache bound",
  );
  const content = await app.evaluate(async ({ webContents }, target) => {
    const page = webContents.getAllWebContents().find((content) => content.getURL() === target);
    return {
      text: await page.executeJavaScript("document.body.innerText"),
      bridge: await page.executeJavaScript("typeof window.arealDesktop"),
      image: (await page.capturePage()).toPNG().toString("base64"),
    };
  }, evicted.url);
  assert.match(content.text, /ARCHITECTURE_PREVIEW/);
  assert.equal(content.bridge, "undefined");
  await writeFile(join(scratch, "native-preview.png"), Buffer.from(content.image, "base64"));
  checks.push(
    "native pages stay bounded, protect the current owner, and restore evicted/crashed pages without a product bridge",
  );
  await call("manage", { operation: "archive", projectId, threadId: evicted.threadId });
  const archivedUrls = new Set([
    url,
    ...pages.filter((page) => page.threadId === evicted.threadId).map((page) => page.url),
  ]);
  await until(
    async () => !(await natives()).some((content) => archivedUrls.has(content.url)),
    "archived owner releases all its native pages",
  );
  await until(
    async () =>
      (await page.evaluate(() => window.arealDesktop.snapshot())).projects.find(
        (project) => project.id === projectId,
      )?.state?.threads[evicted.threadId]?.desktop?.archived,
    "archive snapshot",
  );
  const beforeInvalidOwner = await natives();
  await assert.rejects(() =>
    preview({ operation: "show", projectId, threadId: evicted.threadId, url: evicted.url }),
  );
  assert.deepEqual(
    await natives(),
    beforeInvalidOwner,
    "archived owner cannot recreate a native page",
  );
  await call("library", { operation: "hideProject", projectId, hidden: true });
  await until(
    async () => (await natives()).length === 0,
    "hidden project releases all native pages",
  );
  await until(
    async () =>
      (await page.evaluate(() => window.arealDesktop.snapshot())).library.projects[projectId]
        ?.hidden,
    "hidden project snapshot",
  );
  await assert.rejects(() => preview({ operation: "show", projectId, threadId: owners[1], url }));
  assert.deepEqual(await natives(), [], "hidden project cannot recreate a native page");
  checks.push(
    "archive and project hiding release native resources through the product command path",
  );
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  errors.push(error.stack);
  throw error;
} finally {
  if (app) {
    await recordProcesses().catch((error) =>
      errors.push(`cleanup process discovery: ${error.stack}`),
    );
    await call("stopService", {}).catch((error) =>
      errors.push(`cleanup stopService: ${error.stack}`),
    );
    await app.close().catch((error) => errors.push(`cleanup Main close: ${error.stack}`));
  }
  await application
    .close()
    .catch((error) => errors.push(`cleanup application owner: ${error.stack}`));
  await until(
    () => [...ownedPids].every((pid) => !alive(pid)),
    "owned Main/Desktop/host/Core exit",
  ).catch((error) => errors.push(`cleanup process exit: ${error.stack}`));
  for (const pid of ownedPids) cleanup.push({ pid, exited: !alive(pid) });
  await new Promise((resolve) => server.close(resolve));
  for (const [path, value] of Object.entries(sourceHashes))
    if (hash(await readFile(join(gui, path))) !== value)
      errors.push(`source changed during test: ${path}`);
  if (hash(await readFile(env.AREAL_CORE_BIN)) !== source.binaryHash)
    errors.push("Core binary changed during test");
  passed = passed && errors.length === 0;
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed,
        checks,
        errors,
        source,
        processIdentity,
        cleanup,
        residency,
        scope:
          "isolated source Electron/Main/Desktop/Core capability and native resource integration; deterministic local page; native consent responses injected; no provider, Runtime tool, or installed-package acceptance",
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed, evidence: scratch, checks, errors }));
  if (!passed) process.exitCode = 1;
}
