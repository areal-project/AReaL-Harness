import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { applicationFixture } from "./application-fixture.mjs";
import { respondToSessionName } from "./model-fixture.mjs";
import { lockVerificationSlot, verificationDoctor } from "./verification-build.mjs";

assert.ok(
  process.platform !== "darwin" || process.env.AREAL_TEST_HOST_KEYCHAIN === "1",
  "GUI startup writes an isolated subscription transport token to macOS Keychain. Obtain authorization before setting AREAL_TEST_HOST_KEYCHAIN=1.",
);

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const binary = join(root, ".local/shared-host-bin/areal");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const { HostClient } = require("../app/src/core/host-client.cjs");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bundleNames = ["areal", "areal-runtime", "areal-runtime-fs"];
const bundle = async () =>
  Object.fromEntries(
    await Promise.all(
      bundleNames.map(async (n) => [n, sha(await readFile(join(dirname(binary), n)))]),
    ),
  );
const source = async () => {
  const paths = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root })
    .toString()
    .split("\0")
    .filter(Boolean)
    .sort();
  const entries = await Promise.all(
    paths.map(async (path) => [path, sha(await readFile(join(root, path)))]),
  );
  return {
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    files: Object.fromEntries(entries),
  };
};
const evidenceRoot = join(root, ".scratch/shared-host/h2-gui-tui-handoff");
await mkdir(evidenceRoot, { recursive: true });
const evidence = await mkdtemp(join(evidenceRoot, "run-"));
const state = await realpath(await mkdtemp("/private/tmp/ah-handoff-"));
const workspace = join(state, "workspace");
const cliWorkspace = join(state, "cli-workspace");
const exec = promisify(execFile);
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
Object.assign(env, {
  AREAL_CORE_BIN: binary,
  AREAL_CORE_CONFIG: join(state, "config.toml"),
  AREAL_CORE_HOME: join(state, "core"),
  AREAL_CORE_USER_HOME: join(state, "user"),
  AREAL_HARNESS_HOME: join(state, "harness"),
  AREAL_HARNESS_SERVICE_HOME: join(state, "host"),
  AREAL_GUI_USER_DATA: join(state, "profile"),
  XDG_CONFIG_HOME: join(state, "xdg"),
  OTEL_SDK_DISABLED: "true",
  NO_PROXY: "127.0.0.1,localhost,::1",
  no_proxy: "127.0.0.1,localhost,::1",
  LANG: "zh_CN.UTF-8",
});
const clientEnv = { ...env, HOME: env.AREAL_CORE_USER_HOME };
const checks = [],
  requests = [],
  errors = [],
  processes = [];
let app, page, fixture, host, pty, release, descriptor, registration, failure, desktopPid;
const save = (name, value) => writeFile(join(evidence, name), JSON.stringify(value, null, 2));
const until = async (fn, label, ms = 60000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error(`Timeout: ${label}`);
};
const snapshot = () => page.evaluate(() => window.arealDesktop.snapshot());
const project = (s) => s.projects.find((p) => p.root === workspace);
const capture = async (name) => {
  await page.screenshot({ path: join(evidence, `${name}.png`) });
  await writeFile(join(evidence, `${name}.aria.txt`), await page.locator("body").ariaSnapshot());
};
const model = createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (respondToSessionName(body, res)) return;
    requests.push(body);
    const messages = body.messages ?? [];
    const index = messages.findLastIndex(
      (m) =>
        m.role === "user" &&
        !JSON.stringify(m.content).includes("AReaL runtime context (not a user request):"),
    );
    const user = JSON.stringify(messages[index]?.content);
    const done = messages.slice(index + 1).some((m) => m.role === "tool");
    const guiTurn = user.includes("HANDOFF_GUI_INPUT");
    const tuiTurn = user.includes("HANDOFF_TUI_INPUT");
    assert.ok(guiTurn || tuiTurn, `unexpected model input ${user}`);
    const delta =
      guiTurn && !done
        ? {
            tool_calls: [
              {
                index: 0,
                id: "handoff-write",
                type: "function",
                function: {
                  name: "run_command",
                  arguments: JSON.stringify({
                    argv: ["/bin/sh", "-c", "printf 'HANDOFF_ONCE\\n' >> proof.txt"],
                    permissionRequest: {
                      network: true,
                      justification: "Approve the isolated handoff fixture operation",
                    },
                  }),
                },
              },
            ],
          }
        : { content: guiTurn ? "HANDOFF_GUI_COMPLETE" : "HANDOFF_TUI_COMPLETE" };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: guiTurn && !done ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  } catch (error) {
    errors.push(error.stack);
    res.destroy(error);
  }
});
async function launch() {
  app = await electron.launch({
    executablePath: require("electron"),
    args: [fixture.path],
    env,
    timeout: 120000,
  });
  const child = app.process();
  processes.push({ kind: "electron", pid: child.pid });
  child.stderr.on(
    "data",
    (chunk) => void writeFile(join(evidence, "electron.log"), chunk, { flag: "a" }),
  );
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => errors.push(error.stack));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await page.evaluate(() => {
    const key = "areal-gui:application-preferences";
    const prefs = JSON.parse(localStorage.getItem(key) || "{}");
    localStorage.setItem(key, JSON.stringify({ ...prefs, nextPromptSuggestions: false }));
  });
  await page.reload();
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await until(async () => (await snapshot()).connection?.state === "ready", "GUI ready");
  const actual = await app.evaluate(({ app, BrowserWindow }) => {
    const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {
      pid: process.pid,
      userData: app.getPath("userData"),
      sandbox: p.sandbox,
      contextIsolation: p.contextIsolation,
      nodeIntegration: p.nodeIntegration,
    };
  });
  const desktop = JSON.parse(await readFile(join(env.AREAL_CORE_HOME, "service.json"), "utf8"));
  desktopPid = desktop.pid;
  assert.ok(Number.isSafeInteger(desktopPid) && desktopPid > 1);
  processes.push({ kind: "desktop", pid: desktopPid });
  assert.equal(actual.pid, child.pid);
  assert.equal(actual.userData, env.AREAL_GUI_USER_DATA);
  assert.equal(actual.sandbox, true);
  assert.equal(actual.contextIsolation, true);
  assert.equal(actual.nodeIntegration, false);
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, workspace);
}
async function startPty(args) {
  const child = spawn(
    "/usr/bin/python3",
    ["-I", "-S", join(root, "scripts/shared-host-client-pty.py"), binary, ...args],
    { env: clientEnv, cwd: workspace, stdio: ["pipe", "pipe", "pipe"] },
  );
  processes.push({ kind: "pty-wrapper", pid: child.pid });
  child.stderr.on(
    "data",
    (chunk) => void writeFile(join(evidence, "pty.stderr.log"), chunk, { flag: "a" }),
  );
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const first = await lines.next();
  assert.equal(first.done, false);
  const ready = JSON.parse(first.value);
  assert.equal(ready.ready, true);
  processes.push({ kind: "tui", pid: ready.pid });
  let id = 0;
  return {
    child,
    tuiPid: ready.pid,
    async call(operation, text) {
      child.stdin.write(
        JSON.stringify({
          id: ++id,
          operation,
          ...(text === undefined ? {} : { text }),
          timeout: 60,
        }) + "\n",
      );
      const line = await lines.next();
      assert.equal(line.done, false);
      const result = JSON.parse(line.value);
      await writeFile(
        join(evidence, "pty.jsonl"),
        JSON.stringify({ operation, text, ...result }) + "\n",
        { flag: "a" },
      );
      assert.equal(result.id, id);
      if (result.error) throw Error(`${operation}: ${result.error}\n${result.screen}`);
      return result;
    },
  };
}
console.log(`Evidence: ${evidence}`);
try {
  release = await lockVerificationSlot(binary);
  const initialSource = await source(),
    initialBundle = await bundle();
  await save("source.json", initialSource);
  await save("bundle.json", initialBundle);
  await verificationDoctor({ root, binary, evidence });
  await mkdir(workspace);
  await mkdir(cliWorkspace);
  await mkdir(env.AREAL_CORE_USER_HOME);
  await mkdir(env.XDG_CONFIG_HOME);
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
  await new Promise((r) => model.listen(0, "127.0.0.1", r));
  await writeFile(
    env.AREAL_CORE_CONFIG,
    `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`,
  );
  fixture = await applicationFixture(gui, join(state, "fixture"));
  await launch();
  await page.getByRole("button", { name: "不在项目中工作", exact: true }).click();
  await page.getByRole("menuitem", { name: "新建项目", exact: true }).click();
  await until(async () => project(await snapshot())?.state?.connected, "project connected");
  await page.getByRole("button", { name: "更改权限", exact: true }).click();
  await page.getByRole("menuitemradio", { name: /^请求审批/ }).click();
  await page.getByTestId("chat-input").fill("HANDOFF_GUI_INPUT");
  await page.getByTestId("chat-send-button").click();
  const tid = await until(
    async () => (await page.getByTestId("areal-workbench").getAttribute("data-thread-id")) || null,
    "GUI thread",
  );
  const pending = await until(
    async () =>
      (project(await snapshot()).state.interactions?.[tid]?.data ?? []).find(
        (i) => i.kind === "approval" && i.status === "pending",
      ),
    "GUI approval",
  );
  assert.equal(pending.tool, "run_command");
  await page.getByRole("button", { name: "允许一次", exact: true }).waitFor();
  assert.equal(
    await readFile(join(workspace, "proof.txt"), "utf8").catch((e) =>
      e.code === "ENOENT" ? null : Promise.reject(e),
    ),
    null,
  );
  const before = project(await snapshot()).state.threads[tid];
  const turnId = before.turns.at(-1).id;
  await capture("gui-pending");
  await save("gui-pending.json", { tid, turnId, pending, thread: before });
  host = new HostClient();
  await host.connect(env.AREAL_HARNESS_SERVICE_HOME);
  const status = await host.status();
  const matches = status.projects.filter((p) => p.registration?.workspace === workspace);
  assert.equal(matches.length, 1);
  ({ registration, service: descriptor } = matches[0]);
  assert.ok(descriptor?.endpoint && descriptor.authFile);
  assert.equal(descriptor.owner.kind, "host");
  assert.equal(descriptor.owner.generation, host.generation);
  assert.ok(registration.dataDir.startsWith(env.AREAL_CORE_HOME + "/"));
  assert.equal(descriptor.dataDir, registration.dataDir);
  assert.equal(descriptor.workspace, workspace);
  const hostInfo = JSON.parse(
    await readFile(join(env.AREAL_HARNESS_SERVICE_HOME, "host/host.json"), "utf8"),
  );
  assert.equal(descriptor.owner.hostId, hostInfo.hostId);
  processes.push(
    { kind: "host", pid: hostInfo.pid },
    { kind: "core", pid: descriptor.corePid },
    { kind: "service", pid: descriptor.hostPid },
  );
  await save("binding.json", {
    registration,
    descriptor,
    hostPid: hostInfo.pid,
    hostGeneration: host.generation,
  });
  assert.ok(
    requests[0].tools.some((t) => t.function?.name === "browser_v1"),
    "GUI-origin model context includes browser bundle",
  );
  const guiPid = app.process().pid;
  app.process().kill("SIGKILL");
  await until(() => app.process().signalCode === "SIGKILL", "GUI Main killed");
  app = null;
  const afterKill = await host.status();
  const retained = afterKill.projects.find(
    (p) => p.registration.projectId === registration.projectId,
  );
  assert.equal(afterKill.hostId, hostInfo.hostId);
  assert.equal(afterKill.generation, host.generation);
  assert.equal(retained.service.generation, descriptor.generation);
  assert.equal(retained.service.corePid, descriptor.corePid);
  checks.push(`GUI Main ${guiPid} killed while original Host and Core remain alive`);
  const requestCount = requests.length;
  pty = await startPty([
    "--endpoint",
    descriptor.endpoint,
    "--auth-file",
    descriptor.authFile,
    "--resume",
    tid,
    "--mouse=false",
  ]);
  await pty.call("expect", "Permission required");
  assert.equal(requests.length, requestCount, "attach does not replay model");
  await pty.call("expect", "> Deny");
  await pty.call("send", "\u001b[B");
  await pty.call("expect", "> Allow once");
  await pty.call("send", "\r");
  await pty.call("expect", "HANDOFF_GUI_INPUT");
  await pty.call("expect", "HANDOFF_GUI_COMPLETE");
  await pty.call("expect", "Completed");
  assert.equal(await readFile(join(workspace, "proof.txt"), "utf8"), "HANDOFF_ONCE\n");
  assert.equal(requests.length, requestCount + 1);
  checks.push("TUI observes GUI history and approves original turn; Runtime appends once");
  await pty.call("send", "/new\r");
  const tuiPrefix = await until(async () => {
    const view = await pty.call("send", "");
    const selected = view.screen.match(/Conversation\s*·\s*([a-f0-9]{8})/i)?.[1];
    return selected && selected !== tid.slice(0, 8) ? selected : null;
  }, "new TUI thread selected");
  await pty.call("send", "HANDOFF_TUI_INPUT\r");
  await pty.call("expect", "HANDOFF_TUI_COMPLETE");
  await pty.call("expect", "Completed");
  assert.equal(requests.length, requestCount + 2);
  checks.push("TUI creates a second thread in the GUI project");
  await pty.call("exit");
  pty.child.stdin.end();
  await new Promise((r) => pty.child.once("exit", r));
  pty = null;
  assert.equal(requests.length, requestCount + 2);
  const cliRun = exec(
    binary,
    [
      "exec",
      "HANDOFF_TUI_INPUT",
      "--workspace",
      cliWorkspace,
      "--config",
      env.AREAL_CORE_CONFIG,
      "--output-format",
      "json",
      "--no-session-name",
      "--allow-write",
      "--permissions",
      "YOLO",
    ],
    { cwd: cliWorkspace, env: clientEnv, timeout: 120000 },
  );
  cliRun.child.stdin.end();
  const cli = await cliRun;
  const cliResult = JSON.parse(cli.stdout);
  assert.equal(cliResult.is_error, false);
  assert.match(JSON.stringify(cliResult), /HANDOFF_TUI_COMPLETE/);
  const cliId = cliResult.session_id;
  assert.match(cliId, /^[a-f0-9-]+$/);
  const cliStatus = await host.status();
  const cliProject = cliStatus.projects.filter((p) => p.registration.workspace === cliWorkspace);
  assert.equal(cliProject.length, 1);
  assert.equal(cliProject[0].registration.source.kind, "cli");
  assert.equal(cliProject[0].service.dataDir, cliProject[0].registration.dataDir);
  processes.push(
    { kind: "core", pid: cliProject[0].service.corePid },
    { kind: "service", pid: cliProject[0].service.hostPid },
  );
  await save("cli-binding.json", {
    registration: cliProject[0].registration,
    service: cliProject[0].service,
    threadId: cliId,
    stdout: cli.stdout,
    stderr: cli.stderr,
  });
  assert.equal(requests.length, requestCount + 3);
  checks.push("ordinary CLI Host path creates a distinct registered project and conversation");
  const beforeReopen = requests.length;
  await launch();
  await until(async () => project(await snapshot())?.state?.connected, "reopened project");
  await page.getByTestId(`task-item-${tid}`).click();
  await page.getByText("HANDOFF_GUI_COMPLETE", { exact: true }).waitFor();
  const reopened = project(await snapshot()).state.threads[tid];
  assert.equal(reopened.turns.at(-1).id, turnId);
  assert.equal(reopened.turns.at(-1).status, "completed");
  const tuiItem = page.locator(`[data-testid^="task-item-${tuiPrefix}"]`);
  await tuiItem.waitFor();
  assert.equal(await tuiItem.count(), 1);
  const tuiId = (await tuiItem.getAttribute("data-testid")).slice("task-item-".length);
  await tuiItem.click();
  await page.getByText("HANDOFF_TUI_COMPLETE", { exact: true }).waitFor();
  const tuiThread = project(await snapshot()).state.threads[tuiId];
  assert.ok(JSON.stringify(tuiThread).includes("HANDOFF_TUI_INPUT"));
  assert.equal(tuiThread.turns.at(-1).status, "completed");
  const cliGuiProject = await until(
    async () => (await snapshot()).projects.find((p) => p.root === cliWorkspace),
    "CLI registered project visible in GUI",
  );
  await until(
    async () =>
      (await snapshot()).projects.find((p) => p.id === cliGuiProject.id)?.state?.connected,
    "CLI project connected",
  );
  const cliProjectButton = page.getByRole("button", { name: "cli-workspace", exact: true });
  if ((await cliProjectButton.getAttribute("aria-expanded")) !== "true")
    await cliProjectButton.click();
  await page.getByTestId(`task-item-${cliId}`).click();
  await page.getByText("HANDOFF_TUI_COMPLETE", { exact: true }).waitFor();
  const other = (await snapshot()).projects.find((p) => p.id === cliGuiProject.id).state.threads[
    cliId
  ];
  assert.ok(JSON.stringify(other).includes("HANDOFF_TUI_INPUT"));
  assert.equal(requests.length, beforeReopen, "GUI reopen does not replay input");
  assert.equal(await readFile(join(workspace, "proof.txt"), "utf8"), "HANDOFF_ONCE\n");
  const registrations = (await host.listProjects()).projects;
  assert.deepEqual(
    registrations.find((p) => p.projectId === registration.projectId),
    registration,
  );
  assert.deepEqual(
    registrations.find((p) => p.projectId === cliProject[0].registration.projectId),
    cliProject[0].registration,
  );
  await capture("gui-tui-history");
  await save("history.json", { gui: reopened, tui: tuiThread, cli: other });
  assert.deepEqual(await source(), initialSource, "source changed during run");
  assert.deepEqual(await bundle(), initialBundle, "fixed bundle changed during run");
  assert.deepEqual(errors, []);
  checks.push(
    "GUI reopens original turn, TUI-created thread, and ordinary CLI project history without replay; registrations and dataDirs remain identical",
  );
} catch (error) {
  failure = error.stack ?? String(error);
  process.exitCode = 1;
  if (page && app) {
    try {
      await capture("failure");
    } catch {}
  }
} finally {
  if (pty) {
    pty.child.stdin.end();
    await until(
      () => pty.child.exitCode !== null || pty.child.signalCode !== null,
      "PTY cleanup",
      15000,
    ).catch((e) => {
      errors.push(e.stack);
      try {
        process.kill(pty.tuiPid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") errors.push(error.stack);
      }
      pty.child.kill("SIGKILL");
    });
  }
  if (app) {
    const child = app.process();
    try {
      await app.evaluate(({ dialog, Menu }) => {
        dialog.showMessageBox = async () => ({ response: 0 });
        const quit = Menu.getApplicationMenu().items[0].submenu.items.find(
          (item) => item.accelerator === "CmdOrCtrl+Q",
        );
        if (!quit) throw Error("Missing quit menu");
        quit.click();
      });
      await until(() => child.exitCode !== null || child.signalCode !== null, "GUI cleanup", 15000);
    } catch (error) {
      errors.push(error.stack);
      child.kill("SIGKILL");
      await until(
        () => child.exitCode !== null || child.signalCode !== null,
        "GUI forced cleanup",
        15000,
      ).catch((e) => errors.push(e.stack));
    }
  }
  if (desktopPid) {
    try {
      process.kill(desktopPid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") errors.push(error.stack);
    }
    await until(
      () => {
        try {
          process.kill(desktopPid, 0);
          return false;
        } catch (error) {
          if (error.code === "ESRCH") return true;
          throw error;
        }
      },
      "owned Desktop exits",
      15000,
    ).catch((error) => errors.push(error.stack));
  }
  if (!host) {
    try {
      await readFile(join(env.AREAL_HARNESS_SERVICE_HOME, "host/host.json"));
      host = new HostClient();
      await host.connect(env.AREAL_HARNESS_SERVICE_HOME);
    } catch (e) {
      if (e.code !== "ENOENT") errors.push(e.stack);
      host = null;
    }
  }
  if (host) {
    try {
      const current = await host.status();
      assert.ok(
        current.projects.every(
          (p) =>
            p.registration.workspace.startsWith(state + "/") &&
            p.registration.dataDir.startsWith(state + "/"),
        ),
        "refuse to stop unowned project",
      );
      for (const p of current.projects)
        if (p.service)
          processes.push(
            { kind: "core", pid: p.service.corePid },
            { kind: "service", pid: p.service.hostPid },
          );
      const info = JSON.parse(
        await readFile(join(env.AREAL_HARNESS_SERVICE_HOME, "host/host.json"), "utf8"),
      );
      processes.push({ kind: "host", pid: info.pid });
      const result = await host.stop(randomUUID(), host.generation, "cancel");
      assert.equal(result.state, "completed");
    } catch (e) {
      errors.push(e.stack);
    } finally {
      host.close();
    }
  }
  await fixture?.close();
  await new Promise((r) => model.close(r));
  for (const p of processes.filter((p) =>
    ["host", "core", "service", "tui", "pty-wrapper", "electron", "desktop"].includes(p.kind),
  ))
    await until(
      () => {
        try {
          process.kill(p.pid, 0);
          return false;
        } catch (e) {
          if (e.code === "ESRCH") return true;
          throw e;
        }
      },
      `${p.kind} exits`,
      15000,
    ).catch((e) => errors.push(e.stack));
  await release?.();
  if (errors.length) process.exitCode = 1;
  await save("result.json", {
    passed: !failure && !errors.length,
    evidence,
    state,
    checks,
    failure,
    errors,
    processes,
    requests: requests.length,
    scope:
      "isolated source Electron, actual TUI PTY, shared Host and Runtime; deterministic loopback model; native picker injected",
  });
  await save("model-requests.json", requests);
  console.log(JSON.stringify({ evidence, state, checks, failure, errors }, null, 2));
}
