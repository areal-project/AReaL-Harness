import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applicationFixture } from "./application-fixture.mjs";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const binary = process.env.AREAL_CORE_BIN;
assert.ok(
  binary?.startsWith(join(root, ".local/dev-bin/")),
  "Use a private fixed Core slot in this checkout",
);
assert.ok(
  !process.env.AREAL_GUI_EXECUTABLE,
  "This injected cleanup regression uses the source Electron entry",
);
const executable = require("electron");
const mode = process.argv.includes("--offline")
  ? "offline"
  : process.argv.includes("--menu")
    ? "menu"
    : "SIGTERM";
const scratch = await makeTempDir("aex-");
const marker = join(scratch, "provider-close-entered.json");
const workspace = join(scratch, "workspace");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};
const until = async (read, label, timeout = 90000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await sleep(100);
  }
  throw new Error(`Timeout: ${label}`);
};
const descendants = (seeds) => {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  const pids = new Set(seeds.filter(Boolean));
  for (let changed = true; changed;) {
    changed = false;
    for (const [pid, parent] of rows)
      if (pids.has(parent) && !pids.has(pid)) {
        pids.add(pid);
        changed = true;
      }
  }
  return [...pids];
};
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const sourceFiles = [
  "app/src/main.cjs",
  "app/src/core/main.cjs",
  "../../services/workbench/src/desktop/core/service-main.cjs",
  "../../services/workbench/src/desktop/core/backend.cjs",
  "app/src/core/service-client.cjs",
  "../../services/workbench/src/desktop/core/service-protocol.cjs",
  "../../services/workbench/src/desktop/core/diagnostics.cjs",
  "app/src/core/lifecycle.cjs",
  "../../services/workbench/src/desktop/core/lifecycle-operations.cjs",
  "../../services/workbench/src/desktop/core/resource-recovery.cjs",
  "app/src/core/startup-recovery.cjs",
  "scripts/desktop-exit-pending-smoke.mjs",
  "renderer/dist/index.html",
];
const sourceHashes = Object.fromEntries(
  await Promise.all(sourceFiles.map(async (path) => [path, sha(await readFile(join(gui, path)))])),
);
const binaryHashes = Object.fromEntries(
  await Promise.all(
    ["areal", "areal-runtime", "areal-runtime-fs"].map(async (name) => [
      name,
      sha(await readFile(join(dirname(binary), name))),
    ]),
  ),
);
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
Object.assign(env, {
  AREAL_CORE_USER_HOME: join(scratch, "user"),
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_HARNESS_HOME: join(scratch, "user/.areal"),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_CORE_CONFIG: join(scratch, "config.toml"),
  AREAL_CORE_BIN: binary,
});
await mkdir(join(scratch, "user/.areal"), { recursive: true });
await mkdir(workspace);
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
await writeFile(
  env.AREAL_CORE_CONFIG,
  'schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:1/v1/chat/completions"\n',
);
const application = await applicationFixture(
  gui,
  join(scratch, "app"),
  `
globalThis.__recordQuitDialog = options => require('node:fs').writeFileSync(${JSON.stringify(join(scratch, "quit-dialog.json"))}, JSON.stringify(options));
if (process.argv.includes('--areal-core-service')) {
  require('electron').app.on('before-quit', () => {
    require('node:fs').writeFileSync(${JSON.stringify(join(scratch, "before-quit-entered.json"))}, JSON.stringify({ pid: process.pid, boundary: 'app.before-quit' }));
  });
  const { CoreBackend } = require(${JSON.stringify(join(gui, "../../services/workbench/src/desktop/core/backend.cjs"))});
  const initialize = CoreBackend.prototype.init;
  const disconnect = CoreBackend.prototype.disconnect;
  CoreBackend.prototype.disconnect = function (...args) {
    require('node:fs').writeFileSync(${JSON.stringify(join(scratch, "disconnect-entered.json"))}, JSON.stringify({ pid: process.pid, boundary: 'backend.disconnect', starting: this.starting.size, projects: [...this.projects.keys()] }));
    return disconnect.apply(this, args);
  };
  CoreBackend.prototype.init = async function (...args) {
    await initialize.apply(this, args);
    require('node:fs').writeFileSync(${JSON.stringify(join(scratch, "fault-injection-armed.json"))}, JSON.stringify({ pid: process.pid }));
    if (${JSON.stringify(mode)} === 'offline') {
      let disconnected = false;
      const reconnect = this.reconnectProject.bind(this);
      this.reconnectProject = async (...args) => {
        if (disconnected) throw new Error('injected GUI Core observation transport unavailable');
        return reconnect(...args);
      };
      const timer = setInterval(() => {
        if (!require('node:fs').existsSync(${JSON.stringify(join(scratch, "disconnect-gui-core"))})) return;
        clearInterval(timer);
        disconnected = true;
        for (const project of this.projects.values()) { project.reconnectBlocked = true; project.client?.close(); }
        require('node:fs').writeFileSync(${JSON.stringify(join(scratch, "gui-core-disconnected.json"))}, JSON.stringify({ pid: process.pid, boundary: 'GUI Core observation transport' }));
      }, 20);
      timer.unref();
    } else {
      this.providers.close = async () => {
        require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, boundary: 'providers.close', pending: true }));
        await new Promise(() => {});
      };
    }
  };
}
`,
);
const isolation = Object.fromEntries(
  Object.entries(env).filter(([key]) => key === "HOME" || key.startsWith("AREAL_")),
);
const injection =
  (mode === "offline"
    ? "Only GUI-to-Core observation connections are closed and reconnect remains unavailable. Original Host/Core and CLI lifecycle channel stay real."
    : "Only provider cleanup is held pending. Main, Desktop shutdown handlers, disconnect, finish, ownership and Core/Runtime are real.") +
  " Native quit confirmation is recorded and accepted by the fixture.";
await writeFile(
  join(scratch, "prerequisites.json"),
  JSON.stringify(
    { mode, executable, binary, binaryHashes, isolation, workspace, injection },
    null,
    2,
  ),
);
console.log("Desktop pending-exit evidence:", scratch);
let app,
  child,
  metadata,
  pids = [],
  output = "",
  failure,
  observed,
  cleanup;
const records = async () => {
  let names;
  try {
    names = await readdir(join(env.AREAL_HARNESS_SERVICE_HOME, "services"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return (
    await Promise.all(
      names.map((name) =>
        readFile(join(env.AREAL_HARNESS_SERVICE_HOME, "services", name, "service.json"), "utf8")
          .then(JSON.parse)
          .catch((error) => {
            if (error.code === "ENOENT") return null;
            throw error;
          }),
      ),
    )
  ).filter(Boolean);
};
try {
  app = await electron.launch({
    executablePath: executable,
    args: [application.path],
    env,
    timeout: 120000,
  });
  child = app.process();
  pids = [child.pid];
  child.stderr?.on("data", (bytes) => {
    output += bytes;
  });
  const page = await app.firstWindow();
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await until(
    async () =>
      (await page.evaluate(() => window.arealDesktop.snapshot())).connection?.state === "ready",
    "Desktop connected",
  );
  await app.evaluate(({ dialog }, workspace) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
  }, workspace);
  await page.evaluate(() => window.arealDesktop.chooseProject());
  const project = await until(
    async () =>
      (await page.evaluate(() => window.arealDesktop.snapshot())).projects.find(
        (project) => project.root === workspace && project.state?.connected,
      ),
    "project Core ready",
  );
  assert.equal(await realpath(project.core.binary), await realpath(binary));
  await until(async () => {
    const status = await page.evaluate(() => window.arealDesktop.command("serviceStatus", {}));
    return status.ok && status.value.starting === 0 && status.value.activeCommands === 0;
  }, "all project startup and summary reads settled");
  metadata = JSON.parse(await readFile(join(env.AREAL_CORE_HOME, "service.json"), "utf8"));
  const services = await records();
  pids = descendants([
    child.pid,
    metadata.pid,
    ...services.flatMap((service) => [service.hostPid, service.corePid]),
  ]);
  assert.ok(
    services.some((service) => service.workspace === workspace),
    "The requested workspace has a real owned Core",
  );
  assert.ok(
    services.every((service) => service.owner.appRunId === metadata.applicationOwner.appRunId),
    "All private service records belong to this application",
  );
  await writeFile(
    join(scratch, "owned.json"),
    JSON.stringify(
      {
        mainPid: child.pid,
        desktopPid: metadata.pid,
        desktopGeneration: metadata.desktopGeneration,
        services,
        pids,
      },
      null,
      2,
    ),
  );
  assert.equal(
    JSON.parse(await readFile(join(scratch, "fault-injection-armed.json"), "utf8")).pid,
    metadata.pid,
  );
  await page.screenshot({ path: join(scratch, "before-quit.png") });
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      if (options.message !== "退出 AReaL Harness？")
        throw new Error("Unexpected native quit dialog");
      globalThis.__recordQuitDialog(options);
      return { response: 1 };
    };
  });
  if (mode === "offline") {
    await writeFile(
      join(scratch, "disconnect-gui-core"),
      "disconnect only this fixture observation transport",
    );
    await until(async () => {
      const snapshot = await page.evaluate(() => window.arealDesktop.snapshot());
      return (
        snapshot.projects.find((candidate) => candidate.id === project.id)?.state?.connected ===
        false
      );
    }, "GUI observes its original Core connection disconnected");
  }
  if (mode === "SIGTERM") process.kill(metadata.pid, "SIGTERM");
  else
    await app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu().items[0].submenu.items.find(
        (item) => item.label === "退出 AReaL Harness",
      );
      if (!item) throw new Error("Safe application quit menu is missing");
      item.click();
    });
  const entered =
    mode === "offline"
      ? JSON.parse(await readFile(join(scratch, "gui-core-disconnected.json"), "utf8"))
      : await until(
          async () => {
            for (const name of ["before-quit-entered.json", "disconnect-entered.json"]) {
              try {
                return JSON.parse(await readFile(join(scratch, name), "utf8"));
              } catch (error) {
                if (error.code !== "ENOENT") throw error;
              }
            }
          },
          `${mode} reaches an Electron or backend shutdown handler`,
          30000,
        );
  assert.equal(entered.pid, metadata.pid);
  const deadline = Date.now() + 12000;
  while (alive(metadata.pid) && Date.now() < deadline) await sleep(100);
  const providerCleanup = await readFile(marker, "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  const lifecycleRequests = await readdir(join(env.AREAL_CORE_HOME, "lifecycle-operations"));
  const lifecycleReceipts = await Promise.all(
    lifecycleRequests.map((name) =>
      readFile(join(env.AREAL_CORE_HOME, "lifecycle-operations", name), "utf8").then(JSON.parse),
    ),
  );
  const snapshot = await page.evaluate(() => window.arealDesktop.snapshot()).catch(() => null);
  const quitDialog = await readFile(join(scratch, "quit-dialog.json"), "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  observed = {
    mode,
    shutdownEntry: entered,
    providerCleanup,
    desktopExited: !alive(metadata.pid),
    mainAlive: alive(child.pid),
    lifecycleRequests,
    lifecycleReceipts,
    quitDialog,
    snapshot,
    services: await records(),
  };
  await writeFile(join(scratch, "observed.json"), JSON.stringify(observed, null, 2));
  assert.equal(
    observed.desktopExited,
    true,
    mode === "offline"
      ? "Idle application quit must complete within 12 seconds with only GUI Core observation disconnected"
      : `Desktop ${mode} must exit within 12 seconds after its shutdown handler runs`,
  );
  if (mode !== "offline")
    assert.equal(
      providerCleanup?.pid,
      metadata.pid,
      "Real shutdown attempts provider cleanup before its bounded exit",
    );
  else {
    assert.match(
      quitDialog?.detail ?? "",
      /部分工作区的任务状态暂时无法读取/,
      "Unavailable observations require explicit native quit confirmation",
    );
    assert.ok(
      lifecycleRequests.length > 0,
      "Confirmed quit submits the original durable lifecycle operation",
    );
  }
  if (mode === "SIGTERM")
    assert.equal(
      lifecycleReceipts.length,
      0,
      "An external signal never fabricates a completed stop receipt",
    );
  else {
    assert.equal(lifecycleReceipts.length, 1, "Quit uses one original durable request");
    const receipt = lifecycleReceipts[0];
    assert.equal(receipt.desktopGeneration, metadata.desktopGeneration);
    assert.equal(receipt.kind, "stopDesktop");
    assert.equal(receipt.desktopExit, "requested");
    assert.equal(
      receipt.phase,
      "acceptedPending",
      "Only Main can confirm the original Desktop actually exited",
    );
    const identities = (values) =>
      values
        .map(({ projectId, serviceId, generation }) => ({ projectId, serviceId, generation }))
        .sort((a, b) => a.projectId.localeCompare(b.projectId));
    assert.deepEqual(
      identities(receipt.targets),
      identities(
        services.map((service) => ({ ...service, projectId: basename(dirname(service.dataDir)) })),
      ),
    );
    for (const target of receipt.targets) {
      assert.equal(target.phase, "completed");
      assert.equal(target.hostReceipt.requestId, target.requestId);
      assert.equal(target.hostReceipt.serviceId, target.serviceId);
      assert.equal(target.hostReceipt.generation, target.generation);
      assert.equal(target.hostReceipt.cancel, receipt.mode === "cancel");
      assert.equal(target.hostReceipt.state, "completed");
    }
  }
  const diagnosticRoot = join(env.AREAL_CORE_HOME, "diagnostics/desktop");
  const diagnosticRuns = await readdir(diagnosticRoot);
  let diagnostic;
  for (const name of diagnosticRuns) {
    const path = join(diagnosticRoot, name);
    const header = JSON.parse(await readFile(join(path, "run.json"), "utf8"));
    if (header.pid !== metadata.pid) continue;
    const files = (await readdir(path)).filter((file) => /^events-\d+\.ndjson$/.test(file));
    const events = (
      await Promise.all(files.map((file) => readFile(join(path, file), "utf8")))
    ).flatMap((text) => text.trim().split("\n").filter(Boolean).map(JSON.parse));
    diagnostic = {
      timeout: events.find((event) => event.type === "desktop-exit-timeout"),
      exit: JSON.parse(await readFile(join(path, "exit.json"), "utf8")),
    };
  }
  assert.ok(diagnostic, "The original Desktop records its actual terminal exit");
  if (mode === "offline") {
    assert.equal(diagnostic.timeout, undefined);
    assert.equal(diagnostic.exit.exitCode, 0);
  } else {
    assert.equal(diagnostic.timeout?.stage, "disconnect");
    assert.equal(
      mode === "menu"
        ? diagnostic.timeout.cause === "completed-lifecycle"
        : ["external-quit", "signal"].includes(diagnostic.timeout.cause),
      true,
    );
    assert.equal(
      diagnostic.exit.exitCode,
      1,
      "Optional cleanup timeout is not recorded as a clean shutdown",
    );
  }
  observed.diagnostic = diagnostic;
  await writeFile(join(scratch, "observed.json"), JSON.stringify(observed, null, 2));
  const engines = services.flatMap((service) => [service.hostPid, service.corePid]);
  await until(
    () => engines.every((pid) => !alive(pid)),
    "original owned engines exit after Desktop lifetime closes",
  );
  if (mode !== "SIGTERM")
    await until(() => !alive(child.pid), "Main exits after its original Desktop stops", 15000);
  console.log(`PASS Desktop ${mode} exits and reclaims its original owned engines`);
} catch (error) {
  failure = error;
  console.error(error.stack);
} finally {
  try {
    pids = [
      ...new Set([
        ...pids,
        ...(await records()).flatMap((service) => [service.hostPid, service.corePid]),
      ]),
    ];
    if (child && alive(child.pid)) pids = descendants([...pids, child.pid]);
    if (child && alive(child.pid))
      await app.evaluate(({ app }) => app.exit(1)).catch(() => child.kill("SIGKILL"));
    await application.close();
    await until(
      () => pids.every((pid) => !alive(pid)),
      "all recorded owned processes exit after fixture owner closes",
    );
    cleanup = { passed: true, pids, alive: pids.filter(alive) };
  } catch (error) {
    cleanup = { passed: false, pids, alive: pids.filter(alive), error: error.stack };
    failure ??= error;
  }
  await writeFile(join(scratch, "electron.stderr.log"), output);
  const changedSources = [],
    changedBinaries = [];
  for (const [path, hash] of Object.entries(sourceHashes))
    if (sha(await readFile(join(gui, path))) !== hash) changedSources.push(path);
  for (const [name, hash] of Object.entries(binaryHashes))
    if (sha(await readFile(join(dirname(binary), name))) !== hash) changedBinaries.push(name);
  if (changedSources.length || changedBinaries.length)
    failure ??= new Error(
      `Test inputs changed during run: ${[...changedSources, ...changedBinaries].join(", ")}`,
    );
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed: !failure,
        mode,
        error: failure?.stack,
        observed,
        cleanup,
        sourceHashes,
        binaryHashes,
        changedSources,
        changedBinaries,
        binary,
        executable,
        commit,
        injection,
        scope:
          "Source Electron Main/Desktop/Core/Runtime with declared fault injection and read-only shutdown-entry markers. SIGTERM or application menu callback is real. No model request, credentials, physical shortcut or packaged app acceptance.",
      },
      null,
      2,
    ),
  );
}
if (failure) process.exitCode = 1;
