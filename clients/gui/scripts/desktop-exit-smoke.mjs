import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile, readdir, realpath } from "node:fs/promises";
import { join, resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { applicationFixture } from "./application-fixture.mjs";
import { persistentServiceFixture } from "./persistent-service-fixture.mjs";
import { createHash, randomUUID } from "node:crypto";

const script = fileURLToPath(import.meta.url);
const gui = resolve(dirname(script), ".."),
  root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const { executeCore } = createRequire(import.meta.url)("./support/core-process-fixture.cjs");
const binary = process.env.AREAL_CORE_BIN;
assert.ok(binary && isAbsolute(binary), "Set AREAL_CORE_BIN to an absolute fixed Core path");
const executable = process.env.AREAL_GUI_EXECUTABLE || require("electron");
const packaged = !!process.env.AREAL_GUI_EXECUTABLE;
const bundledRoot = packaged ? join(dirname(dirname(executable)), "Resources/areal-core") : null;
const productBinary = packaged ? join(bundledRoot, "bin/areal") : binary;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (read, label, ms = 90000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await sleep(100);
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
const records = async (env) => {
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
const metadata = (env) =>
  readFile(join(env.AREAL_CORE_HOME, "service.json"), "utf8").then(JSON.parse);
const cli = async (env, args) =>
  JSON.parse(
    (await executeCore(binary, ["service", ...args, "--json"], { env, timeout: 120000 })).stdout,
  );
const fixture = async (scratch, config, name) => {
  const base = join(scratch, name);
  await mkdir(join(base, "user/.areal"), { recursive: true });
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
  Object.assign(env, {
    ...(!packaged ? { AREAL_CORE_BIN: binary } : {}),
    AREAL_CORE_CONFIG: config,
    AREAL_GUI_USER_DATA: join(base, "electron"),
    AREAL_CORE_HOME: join(base, "core"),
    AREAL_CORE_USER_HOME: join(base, "user"),
    AREAL_HARNESS_SERVICE_HOME: join(base, "registry"),
  });
  const application = await applicationFixture(gui, join(base, "app"));
  return { env, appPath: application.path, pids: [], closeOwner: application.close };
};
const launch = async (entry) => {
  entry.app = await electron.launch({
    executablePath: executable,
    args: packaged ? [] : [entry.appPath],
    env: entry.env,
    timeout: 120000,
  });
  entry.process = entry.app.process();
  entry.log = "";
  entry.process.stderr?.on("data", (bytes) => {
    entry.log += bytes;
  });
  entry.page = await entry.app.firstWindow();
  entry.page.setDefaultTimeout(20000);
  await entry.page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await until(
    async () =>
      (await entry.page.evaluate(() => window.arealDesktop.snapshot())).connection?.state ===
      "ready",
    "GUI connected",
  );
  await entry.app.evaluate(({ dialog }) => {
    globalThis.__quitConfirm = false;
    globalThis.__quitDialogs = [];
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      globalThis.__quitDialogs.push(options);
      return {
        response:
          globalThis.__quitConfirm &&
          ["确认取消后台任务？", "退出 AReaL Harness？"].includes(options.message)
            ? 1
            : (options.cancelId ?? 0),
      };
    };
  });
  entry.metadata = await metadata(entry.env);
  entry.pids = descendants([entry.process.pid, entry.metadata.pid]);
};
const choose = async (entry, workspace) => {
  await entry.app.evaluate(({ dialog }, workspace) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
  }, workspace);
  await entry.page.evaluate(() => window.arealDesktop.chooseProject());
  const project = await until(
    async () =>
      (await entry.page.evaluate(() => window.arealDesktop.snapshot())).projects.find(
        (project) => project.root === workspace && project.state?.connected,
      ),
    "project Core ready",
  );
  assert.equal(
    await realpath(project.core.binary),
    await realpath(productBinary),
    "GUI chooses its expected bundled or source Core",
  );
  entry.coreBinary = project.core.binary;
  entry.pids = [
    ...new Set([...entry.pids, ...descendants([entry.process.pid, entry.metadata.pid])]),
  ];
  return project;
};
const quit = (entry) =>
  entry.app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu().items[0].submenu.items;
    const assertMenu = menu.find((item) => item.label === "退出 AReaL Harness");
    if (!assertMenu) throw new Error("Safe application quit menu is missing");
    assertMenu.click();
  });
const gone = async (entry) => {
  try {
    await until(async () => {
      const services = await records(entry.env);
      const pids = [
        ...new Set([
          ...entry.pids,
          ...services.flatMap((service) => [service.hostPid, service.corePid]),
        ]),
      ];
      return pids.every((pid) => !alive(pid));
    }, "all owned Main/Desktop/Host/Core/Runtime/helpers/bridges exit");
  } catch (error) {
    const services = await records(entry.env);
    const pids = [
      ...new Set([
        ...entry.pids,
        ...services.flatMap((service) => [service.hostPid, service.corePid]),
      ]),
    ];
    const snapshot = await entry.page
      .evaluate(() => window.arealDesktop.snapshot())
      .catch((e) => ({ error: e.message }));
    const processes = execFileSync("ps", ["-ww", "-axo", "pid=,ppid=,state=,comm="], {
      encoding: "utf8",
    })
      .split("\n")
      .filter((line) => pids.includes(Number(line.trim().split(/\s+/)[0])));
    await writeFile(
      join(dirname(entry.env.AREAL_CORE_HOME), "exit-failure.json"),
      JSON.stringify({ pids, processes, services, snapshot, mainLog: entry.log }, null, 2),
    );
    throw error;
  }
};
const cleanupEntry = async (entry) => {
  if (entry.process && alive(entry.process.pid))
    await entry.app.evaluate(({ app }) => app.exit(1)).catch(() => entry.process.kill("SIGKILL"));
  await entry.closeOwner();
  if (entry.process) await gone(entry);
};
const runnerPath = process.argv
  .find((arg) => arg.startsWith("--runner-child="))
  ?.slice("--runner-child=".length);
if (runnerPath) {
  const config = join(runnerPath, "config.toml"),
    workspace = join(runnerPath, "workspace");
  const entry = await fixture(runnerPath, config, "child");
  const cliOwner = await persistentServiceFixture({
    binary,
    env: { AREAL_HARNESS_SERVICE_HOME: join(runnerPath, "cli-registry") },
    args: ["--workspace", workspace, "--config", config],
    evidence: join(runnerPath, "cli-cleanup.json"),
  });
  await launch(entry);
  await choose(entry, workspace);
  entry.pids.push(
    ...descendants([cliOwner.pid, cliOwner.descriptor.hostPid, cliOwner.descriptor.corePid]),
  );
  await writeFile(
    join(runnerPath, "owned.json"),
    JSON.stringify({
      pids: entry.pids,
      desktop: { pid: entry.metadata.pid, desktopGeneration: entry.metadata.desktopGeneration },
    }),
  );
  if (process.argv.includes("--injected-failure")) {
    try {
      throw new Error("injected assertion failure");
    } finally {
      await cliOwner.close();
      await cleanupEntry(entry);
    }
  }
  await new Promise(() => {});
}

const interruption = process.argv
  .find((arg) => arg.startsWith("--await-interruption="))
  ?.slice("--await-interruption=".length);
const scratch = interruption || (await makeTempDir("ae-"));
console.log("Application lifecycle evidence:", scratch);
const workspace = join(scratch, "workspace");
await mkdir(workspace);
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
const requests = [],
  held = new Set(),
  checks = [],
  errors = [],
  entries = [];
checks.push = (...items) => {
  console.log("CHECK", ...items);
  return Array.prototype.push.apply(checks, items);
};
const model = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "APPLICATION_RUNNING" }, finish_reason: null }] })}\n\n`,
    );
    held.add(response);
    response.on("close", () => held.delete(response));
  } catch (error) {
    errors.push(error.stack);
    response.destroy();
  }
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const config = join(scratch, "config.toml");
await writeFile(
  config,
  `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`,
);
const sourceHashes = Object.fromEntries(
  await Promise.all(
    [
      "app/src/core/main.cjs",
      "app/src/core/startup-recovery.cjs",
      "../../services/workbench/src/desktop/core/service-main.cjs",
      "app/src/core/service-client.cjs",
      "../../services/workbench/src/desktop/core/backend.cjs",
      "scripts/support/core-process-fixture.cjs",
      "scripts/desktop-exit-smoke.mjs",
      "renderer/dist/index.html",
    ].map(async (path) => [path, sha(await readFile(join(gui, path)))]),
  ),
);
const binaryHashes = Object.fromEntries(
  await Promise.all(
    ["areal", "areal-runtime", "areal-runtime-fs"].map(async (name) => [
      name,
      sha(await readFile(join(dirname(binary), name))),
    ]),
  ),
);
const productHashes = packaged
  ? Object.fromEntries(
      await Promise.all(
        ["bin/areal", "libexec/areal/areal-runtime", "libexec/areal/areal-runtime-fs"].map(
          async (path) => [path, sha(await readFile(join(bundledRoot, path)))],
        ),
      ),
    )
  : binaryHashes;
const cliEnv = {
  ...process.env,
  AREAL_HARNESS_HOME: join(scratch, "cli-home"),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "cli-registry"),
};
for (const key of ["AREAL_GUI_OWNER", "AREAL_GUI_LIFETIME_FD", "AREAL_GUI_DESKTOP_LIFETIME_FD"])
  delete cliEnv[key];
let independent,
  cliOwner,
  passed = false;
try {
  cliOwner = await persistentServiceFixture({
    binary,
    env: cliEnv,
    args: ["--workspace", workspace, "--config", config],
    evidence: join(scratch, "cli-cleanup.json"),
  });
  independent = cliOwner.descriptor;
  assert.equal(independent.owner, undefined, "independent persistent CLI has no GUI owner");
  const peer = await fixture(scratch, config, "peer");
  entries.push(peer);
  await launch(peer);
  await choose(peer, workspace);
  const peerBefore = await records(peer.env);
  const main = await fixture(scratch, config, "normal");
  entries.push(main);
  await launch(main);
  const hiddenWorkspace = join(scratch, "hidden-workspace");
  await mkdir(hiddenWorkspace);
  const hiddenProject = await choose(main, hiddenWorkspace);
  const hidden = await main.page.evaluate(
    (projectId) =>
      window.arealDesktop.command("library", { operation: "hideProject", projectId, hidden: true }),
    hiddenProject.id,
  );
  assert.equal(hidden.ok, true, JSON.stringify(hidden));
  await choose(main, workspace);
  const services = await records(main.env);
  assert.ok(services.length > 0);
  assert.ok(
    services.every(
      (service) =>
        service.owner?.kind === "gui" &&
        service.owner.appRunId === main.metadata.applicationOwner.appRunId,
    ),
  );
  await main.page.getByTestId("chat-input").fill("hold application lifecycle");
  await main.page.getByRole("button", { name: "发送", exact: true }).click();
  await until(() => held.size === 1, "active model request");
  if (interruption) {
    const pids = descendants([
      cliOwner.pid,
      independent.hostPid,
      independent.corePid,
      ...entries.flatMap((entry) => [entry.process.pid, entry.metadata.pid]),
    ]);
    await writeFile(
      join(scratch, "owned.json"),
      JSON.stringify({ pids, modelRequestActive: held.size === 1 }),
    );
    await new Promise(() => {});
  }
  const draft = "UNSENT_APPLICATION_DRAFT";
  await main.page.getByTestId("chat-input").fill(draft);
  await sleep(300);
  const before = await records(main.env);
  await main.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert.equal(
    await main.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
    false,
  );
  await main.app.evaluate(({ app }) => app.emit("activate"));
  await until(
    () => main.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
    "Dock activation restores window",
  );
  assert.equal((await metadata(main.env)).pid, main.metadata.pid);
  assert.equal(await main.page.getByTestId("chat-input").innerText(), draft);
  assert.deepEqual(
    (await records(main.env)).map((service) => service.generation),
    before.map((service) => service.generation),
  );
  assert.equal(requests.length, 1);
  checks.push(
    "window close and Dock reopen retain application owner, engine generations, model request and draft",
  );
  await quit(main);
  await until(
    () => main.app.evaluate(() => globalThis.__quitDialogs.length > 0),
    "active quit confirmation",
  );
  assert.equal(main.process.exitCode, null);
  assert.equal(held.size, 1);
  const dialogs = await main.app.evaluate(() => globalThis.__quitDialogs);
  assert.equal(dialogs[0].message, "退出 AReaL Harness？");
  checks.push(
    "ordinary application quit asks before cancelling active work; cancel preserves the running request",
  );
  await main.app.evaluate(() => {
    globalThis.__quitConfirm = true;
  });
  main.pids = [...new Set([...main.pids, ...descendants([main.process.pid, main.metadata.pid])])];
  await quit(main);
  await gone(main);
  assert.equal(
    (await cli(cliEnv, ["status", "--instance", independent.serviceId])).generation,
    independent.generation,
  );
  assert.equal((await cli(cliEnv, ["status", "--instance", independent.serviceId])).state, "ready");
  assert.ok((await records(main.env)).every((service) => service.state === "stopped"));
  assert.equal(alive(peer.process.pid), true);
  assert.equal(alive(peer.metadata.pid), true);
  assert.deepEqual(
    (await records(peer.env)).map((service) => service.generation),
    peerBefore.map((service) => service.generation),
  );
  assert.ok(peerBefore.every((service) => alive(service.hostPid) && alive(service.corePid)));
  checks.push("normal quit preserves another GUI profile using the same executable");
  await peer.app.evaluate(() => {
    globalThis.__quitConfirm = true;
  });
  await quit(peer);
  await gone(peer);
  checks.push(
    "confirmed quit cleans hidden-project engines and the whole owned process chain; persistent CLI remains ready",
  );

  const restarted = await fixture(scratch, config, "idle");
  entries.push(restarted);
  await launch(restarted);
  await choose(restarted, workspace);
  await quit(restarted);
  await until(
    () => restarted.app.evaluate(() => globalThis.__quitDialogs.length === 1),
    "idle quit confirmation",
  );
  assert.equal(restarted.process.exitCode, null, "Canceling idle quit preserves the application");
  await until(
    async () =>
      (
        await restarted.page.evaluate(() =>
          window.arealDesktop.command("providers", { operation: "list" }),
        )
      ).ok,
    "idle quit cancellation preserves IPC",
  );
  await restarted.app.evaluate(() => {
    globalThis.__quitConfirm = true;
  });
  await quit(restarted);
  await gone(restarted);
  checks.push(
    "idle application quit asks for confirmation; cancel preserves the application and approval completes physical cleanup",
  );
  const stopped = await fixture(scratch, config, "stopped");
  entries.push(stopped);
  await launch(stopped);
  await until(async () => {
    const status = await stopped.page.evaluate(() =>
      window.arealDesktop.command("serviceStatus", {}),
    );
    return status.ok && status.value.canStop;
  }, "backend is idle before the explicit stop");
  const stopResult = await stopped.page.evaluate(() =>
    window.arealDesktop.command("serviceLifecycle", { operation: "stop" }),
  );
  assert.equal(stopResult.ok, true, JSON.stringify(stopResult));
  assert.equal(stopResult.value.stopped, true, JSON.stringify(stopResult));
  await quit(stopped);
  await until(
    () => stopped.app.evaluate(() => globalThis.__quitDialogs.length === 1),
    "quit confirms with the backend already stopped",
  );
  assert.equal(stopped.process.exitCode, null, "Canceling local-only quit preserves the window");
  await stopped.app.evaluate(() => {
    globalThis.__quitConfirm = true;
  });
  await quit(stopped);
  await gone(stopped);
  checks.push("quit still confirms and supports cancellation after the owned backend has stopped");
  const scheduled = await fixture(scratch, config, "scheduled");
  entries.push(scheduled);
  await launch(scheduled);
  const prepared = await scheduled.page.evaluate(
    (requestId) => window.arealDesktop.command("projectless", { operation: "prepare", requestId }),
    randomUUID(),
  );
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const connected = await scheduled.page.evaluate(
    (projectId) => window.arealDesktop.command("connect", { projectId }),
    prepared.value.projectId,
  );
  assert.equal(connected.ok, true, JSON.stringify(connected));
  const scheduledProject = await until(
    async () =>
      (await scheduled.page.evaluate(() => window.arealDesktop.snapshot())).projects.find(
        (project) => project.id === prepared.value.projectId && project.state?.connected,
      ),
    "independent scheduled project Core ready",
  );
  assert.equal(
    await realpath(scheduledProject.core.binary),
    await realpath(productBinary),
    "independent scheduled project uses the expected Core",
  );
  scheduled.coreBinary = scheduledProject.core.binary;
  scheduled.pids = [
    ...new Set([
      ...scheduled.pids,
      ...descendants([scheduled.process.pid, scheduled.metadata.pid]),
    ]),
  ];
  const task = await scheduled.page.evaluate(
    (projectId) =>
      window.arealDesktop.command("manage", {
        projectId,
        operation: "taskCreate",
        mode: "scheduled",
        objective: "FUTURE_APPLICATION_SCHEDULE",
        interactionMode: "interactive",
        schedule: { at: Math.floor(Date.now() / 1000) + 3600, timeZone: "UTC" },
      }),
    scheduledProject.id,
  );
  assert.equal(task.ok, true, JSON.stringify(task));
  await quit(scheduled);
  await until(
    () => scheduled.app.evaluate(() => globalThis.__quitDialogs.length > 0),
    "scheduled service quit impact",
  );
  const scheduleDialog = await scheduled.app.evaluate(() => globalThis.__quitDialogs.at(-1));
  assert.equal(
    scheduleDialog.detail,
    "正在运行的对话和任务将中断。应用关闭期间，定时任务不会运行，手机连接也将断开。",
  );
  assert.equal(scheduled.process.exitCode, null);
  await scheduled.app.evaluate(() => {
    globalThis.__quitConfirm = true;
  });
  await quit(scheduled);
  await gone(scheduled);
  checks.push(
    "idle enabled schedules display quit impact and permit cancel; confirmation stops triggering without deleting definitions",
  );

  for (const signal of ["SIGTERM", "SIGKILL"])
    for (const target of ["Main", "Desktop"]) {
      const entry = await fixture(scratch, config, `${signal}-${target}`);
      entries.push(entry);
      await launch(entry);
      await choose(entry, workspace);
      const old = await records(entry.env);
      if (signal === "SIGTERM" && target === "Main")
        await entry.app.evaluate(() => {
          globalThis.__quitConfirm = true;
        });
      process.kill(target === "Main" ? entry.process.pid : entry.metadata.pid, signal);
      if (target === "Main") await gone(entry);
      else {
        const enginePids = descendants(
          old.flatMap((service) => [service.hostPid, service.corePid]),
        );
        await until(
          () => enginePids.every((pid) => !alive(pid)),
          "Desktop crash releases owned Host/Core/Runtime",
        );
        await cleanupEntry(entry);
        entry.cleaned = true;
      }
      assert.ok(old.every((service) => !alive(service.hostPid) && !alive(service.corePid)));
      checks.push(
        signal === "SIGTERM" && target === "Main"
          ? "Main SIGTERM follows confirmed quit and releases the owned engines"
          : `${target} ${signal} closes owner lifetime and reclaims the owned engines`,
      );
    }

  if (!packaged)
    for (const ending of ["failure", "SIGTERM", "SIGKILL"]) {
      const base = join(scratch, `runner-${ending}`);
      await mkdir(base);
      if (ending === "failure") {
        await mkdir(join(base, "workspace"));
        await writeFile(join(base, "config.toml"), await readFile(config));
      }
      const args =
        ending === "failure"
          ? [`--runner-child=${base}`, "--injected-failure"]
          : [`--await-interruption=${base}`];
      const child = spawn(process.execPath, [script, ...args], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (bytes) => (output += bytes));
      child.stderr.on("data", (bytes) => (output += bytes));
      let owned;
      try {
        owned = await until(async () => {
          try {
            return JSON.parse(await readFile(join(base, "owned.json"), "utf8"));
          } catch (error) {
            if (child.exitCode !== null) throw new Error(output);
            if (error.code === "ENOENT") return null;
            throw error;
          }
        }, "runner owns ready engine");
        if (ending !== "failure") {
          assert.equal(owned.modelRequestActive, true);
          child.kill(ending);
        }
        await until(() => child.exitCode !== null || child.signalCode !== null, "runner exits");
        await until(
          () => owned.pids.every((pid) => !alive(pid)),
          "runner-owned process chain exits",
        );
        assert.equal(
          JSON.parse(await readFile(join(base, "cli-cleanup.json"), "utf8")).passed,
          true,
        );
        checks.push(
          `test runner ${ending} releases its Electron, GUI engines and independently persistent CLI chain`,
        );
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await writeFile(join(base, "runner.log"), output);
        if (owned)
          await until(
            () => owned.pids.every((pid) => !alive(pid)),
            "runner teardown verifies its processes",
          );
      }
    }
  passed = true;
} catch (error) {
  errors.push(error.stack);
} finally {
  for (const entry of entries) {
    if (entry.cleaned) continue;
    await cleanupEntry(entry).catch((error) => {
      errors.push(`cleanup: ${error.stack}`);
      passed = false;
    });
  }
  if (cliOwner)
    await cliOwner.close().catch((error) => {
      errors.push(error.stack);
      passed = false;
    });
  for (const response of held) response.destroy();
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  for (const [path, hash] of Object.entries(sourceHashes))
    if (sha(await readFile(join(gui, path))) !== hash) {
      errors.push(`source changed: ${path}`);
      passed = false;
    }
  for (const [name, hash] of Object.entries(binaryHashes))
    if (sha(await readFile(join(dirname(binary), name))) !== hash) {
      errors.push(`binary changed: ${name}`);
      passed = false;
    }
  if (packaged)
    for (const [path, hash] of Object.entries(productHashes))
      if (sha(await readFile(join(bundledRoot, path))) !== hash) {
        errors.push(`bundled binary changed: ${path}`);
        passed = false;
      }
  passed = passed && errors.length === 0;
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed,
        checks,
        errors,
        sourceHashes,
        binaryHashes,
        binary,
        productHashes,
        productBinary,
        loadedCorePaths: entries.map((entry) => entry.coreBinary).filter(Boolean),
        executable,
        packaged,
        commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
        diffSha256: sha(
          execFileSync("git", ["diff", "HEAD"], { cwd: root, maxBuffer: 16 * 1024 * 1024 }),
        ),
        scope:
          "isolated real Electron/Core/Runtime; local held model; directory picker and cancellation response injected; process liveness verified; package runner-kill mode requires source fixture",
      },
      null,
      2,
    ),
  );
}
assert.ok(passed, errors.join("\n"));
console.log("PASS", checks);
