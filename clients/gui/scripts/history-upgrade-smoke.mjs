import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { trackedMkdtemp } from "./support/host-cleanup.cjs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  assertApplicationStopped,
  closeSmokeApplication,
  cleanupSyntheticHostKeychain,
} from "./application-cleanup.mjs";
import {
  cleanIsolatedKeychainEntry,
  isolatedElectronBootstrapPrefix,
  isolatedElectronIdentity,
  prepareIsolatedElectron,
} from "./isolated-electron-identity.mjs";

const gui = resolve("clients/gui");
const req = createRequire(join(gui, "app/package.json"));
const { _electron: playwright } = req("playwright-core");
const { chromium } = req("playwright-core");
const { HostClient } = req("@areal/client/node");
const legacy = "/private/tmp/areal-v18-source-inspect";
const oldCore = "/Applications/AReaL Harness GUI.app/Contents/Resources/areal-core/bin/areal";
const newCore = resolve("target/debug/areal");
const source = "/private/tmp/areal-v18-upgrade/source";
const manifestPath = "/private/tmp/areal-v18-upgrade/sample-manifest-locked.json";
const extractedManifestPath = "/private/tmp/areal-v18-upgrade/legacy-extracted-manifest.json";
const oldAsar = "/Applications/AReaL Harness GUI.app/Contents/Resources/app.asar";
assert.equal(await realpath(oldCore), oldCore, "old Core path must not contain symlinks");
assert.equal(await realpath(oldAsar), oldAsar, "old package path must not contain symlinks");
assert.equal(await realpath(source), source, "sample path must not contain symlinks");
const sha = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
async function filesWithoutSymlinks(dir, prefix = "") {
  const result = [];
  assert((await lstat(dir)).isDirectory(), "expected a real directory");
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = prefix + entry.name;
    assert(!entry.isSymbolicLink(), `symlink in isolated input: ${name}`);
    if (entry.isDirectory())
      result.push(...(await filesWithoutSymlinks(join(dir, entry.name), name + "/")));
    else {
      assert(entry.isFile(), `non-file isolated input: ${name}`);
      result.push(name);
    }
  }
  return result;
}
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
assert.equal(await sha(oldAsar), manifest.appAsarSha256, "old package changed");
assert.equal(await sha(oldCore), manifest.oldCoreSha256, "old Core changed");
const expectedNewCore = process.env.AREAL_UPGRADE_NEW_CORE_SHA256;
assert.match(
  expectedNewCore || "",
  /^[a-f0-9]{64}$/,
  "set AREAL_UPGRADE_NEW_CORE_SHA256 to the frozen new Core hash",
);
assert.equal(await sha(newCore), expectedNewCore, "new Core changed");
const extractedManifest = JSON.parse(await readFile(extractedManifestPath, "utf8"));
assert.equal(
  await sha(extractedManifestPath),
  manifest.extractedManifestSha256,
  "old extracted source manifest changed",
);
const extractedFiles = await filesWithoutSymlinks(legacy);
assert.deepEqual(
  extractedFiles.sort(),
  Object.keys(extractedManifest).sort(),
  "old extracted source file set changed",
);
for (const name of extractedFiles)
  assert.equal(
    await sha(join(legacy, name)),
    extractedManifest[name],
    `old extracted source changed: ${name}`,
  );
const sourceFiles = await filesWithoutSymlinks(source);
assert.deepEqual(
  sourceFiles.sort().map((name) => `source/${name}`),
  Object.keys(manifest.sourceFileHashes).sort(),
  "sample file set changed",
);
for (const name of sourceFiles)
  assert.equal(
    await sha(join(source, name)),
    manifest.sourceFileHashes[`source/${name}`],
    `sample changed: ${name}`,
  );
const root = await realpath(await trackedMkdtemp("/tmp/areal-v18-path-"));
const profile = join(root, "profile"),
  core = join(root, "core"),
  registry = join(root, "registry"),
  user = join(root, "user"),
  config = join(root, "config.toml");
for (const p of [profile, core, registry, user]) await mkdir(p, { mode: 0o700 });
await mkdir(join(root, "config-home"), { mode: 0o700 });
await cp(source, core, { recursive: true });
await writeFile(
  config,
  'schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:1"\n',
  { mode: 0o600 },
);
const projects = JSON.parse(await readFile(join(core, "projects.json"), "utf8"));
assert(projects.every((p) => p.root.startsWith("/private/tmp/areal-v18-upgrade/workspaces/")));
for (const project of projects) {
  assert.equal(
    await realpath(project.root),
    project.root,
    "workspace path must not contain symlinks",
  );
  const workspaceFiles = await filesWithoutSymlinks(project.root);
  assert.deepEqual(
    workspaceFiles.sort(),
    Object.keys(manifest.workspaceFileHashes).sort(),
    "workspace file set changed",
  );
  for (const name of workspaceFiles)
    assert.equal(
      await sha(join(project.root, name)),
      manifest.workspaceFileHashes[name],
      `workspace changed: ${name}`,
    );
}
const installed = req("electron");
const identity = isolatedElectronIdentity(
  registry,
  process.env.HOME,
  user,
  req("electron/package.json").version,
);
const identityPath = join(root, "identity.json"),
  bootstrap = join(root, "bootstrap.cjs");
await writeFile(identityPath, JSON.stringify(identity), { mode: 0o600 });
await writeFile(
  bootstrap,
  isolatedElectronBootstrapPrefix(identityPath) +
    '\nif (target.appPath) app.setAppPath(target.appPath);\nrequire(target.entry);\ncheck("after-load");\n',
  { mode: 0o600 },
);
const run = promisify(execFile);
const prepared = await prepareIsolatedElectron({
  root,
  installedElectron: installed,
  identity,
  run: async (_name, cmd, args) => {
    try {
      await run(cmd, args);
      return { code: 0 };
    } catch (e) {
      return { code: e.code, stderr: e.stderr };
    }
  },
  afterCopy: async (bundle) => {
    const d = join(bundle, "Contents/Resources/app");
    await mkdir(d, { recursive: true });
    await writeFile(
      join(d, "package.json"),
      JSON.stringify({
        name: "areal-isolated-upgrade",
        productName: identity.appName,
        main: "main.cjs",
      }),
    );
    await writeFile(join(d, "main.cjs"), `require(${JSON.stringify(bootstrap)});\n`);
  },
});
const base = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  LANG: "C.UTF-8",
  AREAL_GUI_USER_DATA: profile,
  AREAL_CORE_HOME: core,
  AREAL_CORE_USER_HOME: user,
  AREAL_HARNESS_HOME: join(root, "config-home"),
  AREAL_HARNESS_SERVICE_HOME: registry,
  AREAL_CORE_CONFIG: config,
  OTEL_SDK_DISABLED: "true",
  NO_PROXY: "127.0.0.1,localhost",
  AREAL_GUI_OWNER: JSON.stringify({ kind: "gui", appRunId: randomUUID(), profile }),
};
const target = (appPath, name) =>
  JSON.stringify({
    appPath,
    entry: join(appPath, "src/main.cjs"),
    evidence: join(root, name + ".identity.jsonl"),
  });
const evidence = {
  root,
  oldCore,
  newCore,
  hashes: {
    oldAsar: manifest.appAsarSha256,
    oldCore: manifest.oldCoreSha256,
    newCore: expectedNewCore,
    extractedManifest: await sha(extractedManifestPath),
  },
  checks: [],
  pids: {},
  cleanup: {},
  error: null,
};
let old,
  app,
  host,
  oldMeta,
  newMeta,
  browser,
  oldStopAttempted = false;
const save = () =>
  writeFile(join(root, "result.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
async function until(f, label) {
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    const x = await f();
    if (x) return x;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error(`Timeout: ${label}`);
}
try {
  old = spawn(prepared.executable, ["--areal-core-service"], {
    env: {
      ...base,
      AREAL_CORE_BIN: oldCore,
      AREAL_GUI_DESKTOP_LIFETIME_FD: "3",
      AREAL_H2_TEST_ENTRY: target(legacy, "old"),
    },
    stdio: ["ignore", "ignore", "pipe", "pipe"],
  });
  evidence.pids.oldElectron = old.pid;
  old.stderr.on("data", (c) => {
    void writeFile(join(root, "old.stderr"), c, { flag: "a" });
  });
  const meta = (oldMeta = await until(async () => {
    try {
      return JSON.parse(await readFile(join(core, "service.json"), "utf8"));
    } catch (e) {
      if (e.code === "ENOENT" && old.exitCode === null) return false;
      throw e;
    }
  }, "old Desktop"));
  evidence.pids.oldDesktop = meta.pid;
  const legacyRequire = createRequire(join(legacy, "package.json"));
  const { ServiceConnection, SharedCoreBackend } = legacyRequire(
    join(legacy, "src/core/service-client.cjs"),
  );
  const c = new ServiceConnection();
  await c.connect(meta);
  await c.request("hello", { protocol: meta.protocol, identity: meta.identity });
  const before = performance.now();
  await c.request("command", { name: "connect", request: { projectId: projects[0].id } }, true);
  const connectedSnapshot = await c.request("snapshot");
  assert.equal(
    connectedSnapshot.snapshot.projects.find((p) => p.id === projects[0].id)?.state.connected,
    true,
  );
  evidence.checks.push({ stage: "old-connect", elapsedMs: performance.now() - before });
  const snapshot = await c.request("snapshot");
  oldStopAttempted = true;
  const targets = snapshot.service.targets.sort((a, b) => a.projectId.localeCompare(b.projectId));
  const stop = await c.request(
    "stopService",
    { protocol: meta.protocol, expectedTargets: targets },
    true,
  );
  evidence.oldStop = stop;
  c.close();
  await until(() => old.exitCode !== null || old.signalCode !== null, "old exit");
  assert.equal(old.exitCode, 0);
  const resolver = new SharedCoreBackend({ home: core, app: { getPath: () => profile } });
  const reference = {
    requestId: stop.requestId,
    kind: stop.kind,
    mode: stop.mode,
    desktopGeneration: stop.desktopGeneration,
    targets,
    desktop: { pid: meta.pid, identity: meta.identity },
  };
  const confirmed = await resolver.acceptLifecycleReceipt(reference, stop);
  evidence.oldStopConfirmed = confirmed;
  assert.equal(
    confirmed.phase,
    "completed",
    "old Desktop stop receipt remains unsettled; preserve original request",
  );
  evidence.checks.push({ stage: "old-stopped" });
  app = await playwright.launch({
    executablePath: prepared.executable,
    args: [],
    env: { ...base, AREAL_CORE_BIN: newCore, AREAL_H2_TEST_ENTRY: target(join(gui, "app"), "new") },
    timeout: 120000,
  });
  evidence.pids.newElectron = app.process().pid;
  const page = await app.firstWindow();
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  newMeta = await until(async () => {
    try {
      return JSON.parse(await readFile(join(core, "service.json"), "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return false;
      throw e;
    }
  }, "new Desktop metadata");
  assert(Number.isSafeInteger(newMeta.pid) && newMeta.pid > 1, "new Desktop PID missing");
  evidence.pids.newDesktop = newMeta.pid;
  const start = performance.now();
  const result = await page.evaluate(
    async (id) => window.arealDesktop.command("connect", { projectId: id }),
    projects[0].id,
  );
  assert.equal(result.ok, true, JSON.stringify(result.error));
  const projectState = await page.evaluate(
    async (id) =>
      (await window.arealDesktop.snapshot()).projects.find((p) => p.id === id)?.state.connected,
    projects[0].id,
  );
  assert.equal(projectState, true, "new project is not connected");
  evidence.checks.push({ stage: "new-connect", elapsedMs: performance.now() - start });
  const files = (await import("node:fs/promises")).readdir;
  const ids = (await files(join(core, projects[0].id, "state")))
    .filter((x) => /^[a-f0-9-]{36}\.json$/.test(x))
    .map((x) => x.slice(0, -5));
  const rootThread = (
    await Promise.all(
      ids.map(async (id) => ({
        id,
        record: JSON.parse(
          await readFile(join(core, projects[0].id, "state", id + ".json"), "utf8"),
        ),
      })),
    )
  ).find((x) => !x.record.thread.parentThreadId)?.id;
  assert(rootThread);
  const displayStart = performance.now();
  const opened = await page.evaluate(
    async ({ id, threadId }) => window.arealDesktop.command("open", { projectId: id, threadId }),
    { id: projects[0].id, threadId: rootThread },
  );
  assert.equal(opened.ok, true, JSON.stringify(opened.error));
  await page.getByTestId(`task-item-${rootThread}`).click();
  await page.waitForFunction(
    (id) => document.querySelector('[data-testid="areal-workbench"]')?.dataset.threadId === id,
    rootThread,
  );
  await page.locator("[data-side-item-id]").first().waitFor({ timeout: 30000 });
  evidence.checks.push({
    stage: "new-history-readable",
    elapsedMs: performance.now() - displayStart,
  });
  if (process.argv.includes("--web")) {
    const endpoint = JSON.parse(await readFile(join(registry, "host/endpoint.json"), "utf8"));
    const client = new HostClient();
    try {
      await client.connect(registry);
      assert.equal(endpoint.hostId, client.hostId, "Web endpoint belongs to another Host");
      assert.equal(endpoint.generation, client.generation, "Web endpoint generation changed");
      browser = await chromium.launch({ headless: true, channel: "chrome" });
      const web = await browser.newPage();
      const pairing = web.waitForResponse(
        (response) =>
          response.url().endsWith("/host/auth/challenge") && response.request().method() === "POST",
      );
      await web.goto(endpoint.origin);
      const challenge = await (await pairing).json();
      assert.equal(challenge.state, "pending");
      await client.request("web.approve", {
        requestId: challenge.requestId,
        expectedGeneration: client.generation,
        scopes: ["observe"],
      });
      await web.getByRole("button", { name: /检查批准状态|Check approval/i }).click();
      await web.getByTestId("areal-workbench").waitFor({ timeout: 60000 });
      const webStart = performance.now();
      const webThread = web.getByTestId(`task-item-${rootThread}`);
      const projectSection = web.getByRole("button", { name: /项目分类|Project section/i });
      await projectSection.waitFor();
      if ((await projectSection.getAttribute("aria-expanded")) === "false")
        await projectSection.click();
      const webProject = web.getByRole("button", { name: "harness-demo", exact: true });
      await webProject.waitFor();
      if ((await webProject.getAttribute("aria-expanded")) === "false") await webProject.click();
      await webThread.waitFor({ state: "visible", timeout: 30000 });
      await webThread.click();
      await web.waitForFunction(
        (id) => document.querySelector('[data-testid="areal-workbench"]')?.dataset.threadId === id,
        rootThread,
      );
      await web.locator("[data-side-item-id]").first().waitFor({ timeout: 30000 });
      evidence.checks.push({
        stage: "web-history-readable",
        elapsedMs: performance.now() - webStart,
        hostIdMatched: true,
      });
    } catch (error) {
      const web = browser?.contexts()[0]?.pages()[0];
      if (web) {
        await web.screenshot({ path: join(root, "web-failure.png") }).catch(() => {});
        const navigation = await web
          .evaluate(() => ({
            projectSection: document
              .querySelector('[aria-controls="sidebar-projects"]')
              ?.getAttribute("aria-expanded"),
            projects: [...document.querySelectorAll("[data-sidebar-project]")].map((section) => ({
              id: section.getAttribute("data-sidebar-project"),
              expanded: section.querySelector(".project-label")?.getAttribute("aria-expanded"),
            })),
          }))
          .catch(() => null);
        await writeFile(join(root, "web-navigation.json"), JSON.stringify(navigation), {
          mode: 0o600,
        });
      }
      throw error;
    } finally {
      client.close();
    }
  }
} catch (e) {
  evidence.error = { message: e.message, stack: e.stack };
} finally {
  if (browser) {
    try {
      await browser.close();
      evidence.cleanup.browser = "stopped";
    } catch (e) {
      evidence.cleanup.browser = e.message;
    }
  }
  if (old && old.exitCode === null && old.signalCode === null && oldMeta && !oldStopAttempted) {
    try {
      oldStopAttempted = true;
      const { ServiceConnection } = createRequire(join(legacy, "package.json"))(
        join(legacy, "src/core/service-connection.cjs"),
      );
      const c = new ServiceConnection();
      try {
        await c.connect(oldMeta);
        await c.request("hello", { protocol: oldMeta.protocol, identity: oldMeta.identity });
        const snapshot = await c.request("snapshot");
        evidence.cleanup.oldStop = await c.request(
          "stopService",
          {
            protocol: oldMeta.protocol,
            expectedTargets: snapshot.service.targets.sort((a, b) =>
              a.projectId.localeCompare(b.projectId),
            ),
          },
          true,
        );
      } finally {
        c.close();
      }
    } catch (e) {
      evidence.cleanup.oldStopError = e.message;
    }
  }
  if (app) {
    try {
      await closeSmokeApplication(app, 30000);
      evidence.cleanup.electron = "stopped";
    } catch (e) {
      evidence.cleanup.electron = e.message;
    }
  }
  try {
    const descriptor = JSON.parse(await readFile(join(registry, "host/host.json"), "utf8"));
    assert(Number.isSafeInteger(descriptor.pid) && descriptor.pid > 1);
    evidence.pids.host = descriptor.pid;
    host = new HostClient();
    await host.connect(registry);
    assert.equal(host.hostId, descriptor.hostId);
    assert.equal(host.generation, descriptor.generation);
    const result = await host.stop(randomUUID(), host.generation, "ifIdle");
    evidence.cleanup.host = result.state;
    assert.equal(result.state, "completed");
    await until(() => {
      try {
        process.kill(descriptor.pid, 0);
        return false;
      } catch (e) {
        if (e.code === "ESRCH") return true;
        throw e;
      }
    }, "Host PID exit");
    evidence.cleanup.hostPidExited = true;
  } catch (e) {
    evidence.cleanup.hostError = e.message;
  } finally {
    host?.close();
  }
  if (oldStopAttempted && evidence.oldStopConfirmed?.phase !== "completed")
    evidence.cleanup.old = "unsettled";
  if (old && old.exitCode === null && old.signalCode === null) {
    evidence.cleanup.old = "unsettled";
    old.stderr.unref?.();
    old.stdio[3]?.unref?.();
    old.unref();
  }
  if (
    newMeta &&
    evidence.cleanup.host === "completed" &&
    evidence.cleanup.hostPidExited &&
    evidence.cleanup.old !== "unsettled"
  ) {
    try {
      await assertApplicationStopped(newCore, { ...base, AREAL_CORE_BIN: newCore }, newMeta);
      evidence.cleanup.applicationStopped = true;
      evidence.cleanup.hostKeychain = await cleanupSyntheticHostKeychain(registry, root);
    } catch (e) {
      evidence.cleanup.hostKeychain = e.message;
    }
  }
  const cleanup = {
    entries: [],
    unsettledHostHomes:
      evidence.cleanup.applicationStopped &&
      evidence.cleanup.host === "completed" &&
      evidence.cleanup.hostPidExited &&
      evidence.cleanup.old !== "unsettled"
        ? []
        : [registry],
  };
  const security = async (args) => {
    try {
      const r = await run("/usr/bin/security", args);
      return { code: 0, ...r };
    } catch (e) {
      return { code: e.code, stdout: e.stdout || "", stderr: e.stderr || "" };
    }
  };
  try {
    await cleanIsolatedKeychainEntry({
      service: identity.service,
      account: identity.account,
      security,
      cleanup,
      save: async () => {},
    });
    evidence.cleanup.safeStorage = cleanup.entries;
  } catch (e) {
    evidence.cleanup.safeStorage = e.message;
  }
  if ((await sha(newCore)) !== expectedNewCore)
    evidence.error ??= { message: "new Core changed during run" };
  if (
    !evidence.error &&
    (evidence.cleanup.old === "unsettled" ||
      (process.argv.includes("--web") && evidence.cleanup.browser !== "stopped") ||
      evidence.cleanup.electron !== "stopped" ||
      evidence.cleanup.host !== "completed" ||
      !evidence.cleanup.hostPidExited ||
      !evidence.cleanup.applicationStopped ||
      !Array.isArray(evidence.cleanup.hostKeychain) ||
      !Array.isArray(evidence.cleanup.safeStorage) ||
      evidence.cleanup.safeStorage.some((x) => !["absent", "removed"].includes(x.state)))
  )
    evidence.error = { message: "isolated cleanup did not complete" };
  await save();
  console.log(
    JSON.stringify({
      root,
      error: evidence.error?.message,
      checks: evidence.checks,
      cleanup: evidence.cleanup,
    }),
  );
}
if (evidence.error) process.exitCode = 1;
