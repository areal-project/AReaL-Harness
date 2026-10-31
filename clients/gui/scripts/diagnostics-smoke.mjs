import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applicationFixture } from "./application-fixture.mjs";

const gui = resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const binary = process.env.AREAL_CORE_BIN;
const repository = resolve(
  execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: gui,
    encoding: "utf8",
  }).trim(),
  "..",
);
assert.ok(
  binary?.startsWith(join(repository, ".local/dev-bin") + "/"),
  "Use a fixed Core test binary",
);
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: gui,
  encoding: "utf8",
}).trim();
const binarySha256 = createHash("sha256")
  .update(await readFile(binary))
  .digest("hex");
const scratch = await makeTempDir("areal-diagnostics-");
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
Object.assign(env, {
  AREAL_CORE_BIN: binary,
  AREAL_GUI_USER_DATA: join(scratch, "profile"),
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: join(scratch, "user"),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_CORE_CONFIG: join(scratch, "config.toml"),
});
await mkdir(env.AREAL_CORE_HOME, { recursive: true });
await mkdir(env.AREAL_CORE_USER_HOME, { recursive: true });
await writeFile(env.AREAL_CORE_CONFIG, "schema_version=1\n");
const sentinel = "PRIVATE_DIAGNOSTICS_SENTINEL_71e8f7";
await writeFile(join(env.AREAL_CORE_HOME, "service.log"), sentinel);
await writeFile(
  join(env.AREAL_CORE_HOME, "private-error.json"),
  JSON.stringify({ apiKey: sentinel }),
);
const fixture = await applicationFixture(gui, join(scratch, "app"));
const productVersion = JSON.parse(await readFile(join(gui, "app/package.json"), "utf8")).version;
await writeFile(
  join(fixture.path, "package.json"),
  JSON.stringify({
    name: "areal-application-fixture",
    version: productVersion,
    main: "bootstrap.cjs",
  }),
);
const checks = [],
  errors = [],
  cleanupErrors = [],
  handles = [];
let app,
  page,
  passed = false,
  desktopPid,
  offlineConnection;
const corePids = new Set();
const until = async (read, label, milliseconds = 30000) => {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timeout: ${label}`);
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};
const launch = async () => {
  app = await electron.launch({
    executablePath: require("electron"),
    args: [fixture.path],
    env,
    timeout: 120000,
  });
  handles.push(app.process());
  app.process().stderr?.on("data", (bytes) => errors.push(String(bytes)));
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await until(
    async () =>
      (await page.evaluate(() => window.arealDesktop.snapshot())).connection?.state === "ready",
    "Desktop ready",
  );
  desktopPid = JSON.parse(await readFile(join(env.AREAL_CORE_HOME, "service.json"), "utf8")).pid;
  await app.evaluate(
    ({ dialog }, destination) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination });
    },
    join(scratch, "diagnostics.json"),
  );
};
const exported = async (path = join(scratch, "diagnostics.json")) => {
  const raw = await until(
    () =>
      readFile(path, "utf8").catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      }),
    "export written",
  );
  const report = JSON.parse(raw);
  assert.equal(report.format, "areal-harness-diagnostics-v1");
  assert.equal(report.instance.mode, "source");
  assert.equal(report.instance.configSource, "explicit");
  assert.equal(
    report.instance.coreBinaryPathSha256,
    createHash("sha256").update(binary).digest("hex"),
  );
  assert.equal(
    report.instance.configPathSha256,
    createHash("sha256").update(env.AREAL_CORE_CONFIG).digest("hex"),
  );
  assert.ok(Array.isArray(report.modelRequests));
  assert.ok(report.runs.every((run) => run.header.appVersion === productVersion));
  assert.ok(!raw.includes(sentinel), "Raw logs and credentials must be excluded");
  const metadata = await readFile(join(env.AREAL_CORE_HOME, "service.json"), "utf8")
    .then(JSON.parse)
    .catch(() => null);
  if (metadata) assert.ok(!raw.includes(metadata.token), "Desktop auth token must be excluded");
  assert.ok(!raw.includes(scratch), "Absolute local paths must be excluded");
  return { report, raw };
};
const menuExport = async (path) => {
  await app.evaluate(async ({ Menu, dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    const find = (menu) => {
      for (const item of menu.items) {
        if (/导出诊断包/.test(item.label)) return item;
        if (item.submenu) {
          const match = find(item.submenu);
          if (match) return match;
        }
      }
    };
    const item = find(Menu.getApplicationMenu());
    if (!item) throw new Error("Diagnostic menu missing");
    await item.click();
  }, path);
  return exported(path);
};
try {
  await launch();
  assert.equal(await app.evaluate(({ crashReporter }) => crashReporter.getUploadToServer()), false);
  const workspace = join(scratch, "workspace");
  await mkdir(workspace);
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, workspace);
  const projectId = await page.evaluate(() => window.arealDesktop.chooseProject());
  const connection = await page.evaluate(
    (projectId) => window.arealDesktop.command("connect", { projectId }),
    projectId,
  );
  assert.equal(connection.ok, true);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "后台服务", exact: true }).click();
  await page.getByRole("button", { name: /导出诊断包/ }).click();
  const initial = await exported();
  const coreOpen = initial.report.runs
    .flatMap((run) => run.events)
    .find((event) => event.type === "socket-open" && event.boundary === "desktop-core");
  assert.ok(coreOpen && coreOpen.corePid > 1 && coreOpen.hostPid > 1);
  assert.equal(coreOpen.connectionGeneration, 1);
  corePids.add(coreOpen.corePid);
  corePids.add(coreOpen.hostPid);
  await page.screenshot({ path: join(scratch, "settings.png") });
  checks.push(
    "A real isolated Core connection records its boundary, observed PIDs, and exact generation",
  );
  checks.push(
    "Settings export uses real Electron IPC and excludes raw log and credential sentinels",
  );
  const invalid = await page.evaluate(() =>
    window.arealDesktop.command("exportDiagnostics", { path: "/forbidden" }),
  );
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "INVALID_DESKTOP_REQUEST");
  checks.push("Renderer cannot choose an export path through command parameters");

  process.kill(desktopPid, "SIGKILL");
  await until(() => !alive(desktopPid), "Owned Desktop exited");
  await until(async () => {
    offlineConnection = (await page.evaluate(() => window.arealDesktop.snapshot())).connection;
    return ["connecting", "unavailable"].includes(offlineConnection?.state);
  }, "Offline projection");
  const offlinePath = join(scratch, "offline.json");
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, offlinePath);
  await page.getByRole("button", { name: /导出诊断包/ }).click();
  const offline = await exported(offlinePath);
  const offlineEvents = offline.report.runs.flatMap((run) => run.events);
  assert.ok(
    offlineEvents.some(
      (event) =>
        event.type === "socket-close" &&
        event.boundary === "main-desktop" &&
        event.closeCode === 1006,
    ),
  );
  assert.ok(
    offlineEvents.some((event) => event.type === "desktop-exit" && event.signal === "SIGKILL"),
  );
  checks.push("Export remains available after the actual Desktop process is killed");

  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(),
  );
  const crashed = await menuExport(join(scratch, "renderer-crash.json"));
  assert.ok(
    crashed.report.runs
      .flatMap((run) => run.events)
      .some(
        (event) => event.type === "renderer-gone" && ["crashed", "killed"].includes(event.reason),
      ),
  );
  checks.push("Native menu exports renderer crash reason after the real renderer is crashed");
  const oldPid = app.process().pid;
  app.process().kill("SIGKILL");
  await until(() => !alive(oldPid), "Main exited");
  app = null;
  await launch();
  const reopened = await menuExport(join(scratch, "reopened.json"));
  assert.ok(
    reopened.report.runs.some(
      (run) => run.header.pid === oldPid && run.status === "termination-unconfirmed",
    ),
    "Previous Main run survives a forced exit and restart",
  );
  checks.push("A new Main can export prior crash evidence and labels an unconfirmed termination");
  await page.screenshot({ path: join(scratch, "reopened.png") });
  passed = true;
} finally {
  if (app && alive(app.process().pid)) await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await fixture.close();
  for (const handle of handles)
    await until(() => !alive(handle.pid), "Test Main cleanup").catch((error) =>
      cleanupErrors.push(error.message),
    );
  if (desktopPid)
    await until(() => !alive(desktopPid), "Test Desktop owner cleanup").catch((error) =>
      cleanupErrors.push(error.message),
    );
  for (const pid of corePids)
    await until(() => !alive(pid), "Test Core owner cleanup").catch((error) =>
      cleanupErrors.push(error.message),
    );
  assert.equal(
    createHash("sha256")
      .update(await readFile(binary))
      .digest("hex"),
    binarySha256,
    "Core binary stays fixed during acceptance",
  );
  await writeFile(join(scratch, "electron.log"), errors.join(""));
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed: passed && !cleanupErrors.length,
        checks,
        scope:
          "macOS source Electron, real IPC and filesystem, injected native save picker; isolated data and no provider requests",
        sourceCommit,
        binarySha256,
        scratch,
        cleanupErrors,
        mainPids: handles.map((handle) => handle.pid),
        desktopPid,
        offlineConnection,
        corePids: [...corePids],
      },
      null,
      2,
    ),
  );
  console.log("Diagnostics evidence:", scratch);
}
assert.ok(passed);
assert.deepEqual(cleanupErrors, []);
console.log("PASS", checks);
