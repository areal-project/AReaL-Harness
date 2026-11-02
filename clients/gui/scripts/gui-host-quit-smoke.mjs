import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./support/temp.mjs";
import { applicationFixture } from "./application-fixture.mjs";
import { respondToSessionName } from "./model-fixture.mjs";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const { HostClient } = require("../app/src/core/host-client.cjs");
const remoteEnabled = process.env.AREAL_TEST_REMOTE_KEYCHAIN === "1";
const binary = process.env.AREAL_CORE_BIN;
assert.ok(binary && isAbsolute(binary), "AREAL_CORE_BIN must be an absolute fixed-bundle path");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashes = Object.fromEntries(
  await Promise.all(
    ["areal", "areal-runtime", "areal-runtime-fs"].map(async (name) => [
      name,
      sha(await readFile(join(dirname(binary), name))),
    ]),
  ),
);
const scratch = await makeTempDir("areal-host-quit-");
const workspace = join(scratch, "workspace");
await mkdir(workspace);
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
Object.assign(env, {
  AREAL_CORE_BIN: binary,
  AREAL_CORE_CONFIG: join(scratch, "config.toml"),
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: join(scratch, "user"),
  AREAL_HARNESS_HOME: join(scratch, "harness"),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  NO_PROXY: "127.0.0.1,localhost,::1",
  no_proxy: "127.0.0.1,localhost,::1",
});
const eventsPath = join(scratch, "events.jsonl");
const bootstrap = `
const { appendFileSync } = require('node:fs');
const record = value => appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(value) + '\\n');
globalThis.responses = [];
globalThis.holdStop = false;
require('electron').dialog.showMessageBox = async (...args) => {
 const options = args.at(-1);
 if (options.title === '允许本地开发站点') return { response: 1 };
 const response = globalThis.responses.shift();
 record({ event: 'dialog', options, response });
 if (response === undefined) throw new Error('Unexpected native dialog');
 return { response };
};
const { SharedCoreBackend } = require(${JSON.stringify(join(gui, "app/src/core/service-client.cjs"))});
const report = SharedCoreBackend.prototype.reportLifecycleError;
SharedCoreBackend.prototype.reportLifecycleError = function(error) {
 record({ event: 'lifecycle-error', message: error?.message, stack: error?.stack });
 return report.call(this, error);
};
const stop = SharedCoreBackend.prototype.requestHostStop;
SharedCoreBackend.prototype.requestHostStop = async function(...args) {
 record({ event: 'stop-held' });
 while (globalThis.holdStop) await new Promise(resolve => setTimeout(resolve, 20));
 const result = await stop.apply(this, args); record({ event: 'stop-receipt', result }); return result;
};
`;
const checks = [],
  errors = [],
  processes = [],
  streams = [];
const server = createServer(async (request, response) => {
  try {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    if (respondToSessionName(input, response)) return;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "QUIT_FIXTURE_STREAM" }, finish_reason: null }] })}\n\n`,
    );
    streams.push(response);
  } catch (error) {
    errors.push(error.stack);
    response.destroy();
  }
});
let application,
  app,
  page,
  child,
  host,
  hostPid,
  hostPids = [],
  corePids = [],
  passed = false,
  cleanup;
let remoteSocket, remoteClient, remoteIdentity, remoteBefore, desktopPid;
let remoteResult = remoteEnabled ? "not reached" : "not run; requires authorization";
const until = async (read, label, timeout = 60000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`Timeout: ${label}`);
};
const events = async () =>
  (await readFile(eventsPath, "utf8").catch(() => "")).split("\n").filter(Boolean).map(JSON.parse);
const snapshot = () => page.evaluate(() => window.arealDesktop.snapshot());
const project = (value) => value.projects.find((item) => item.root === workspace);
const thread = (value) =>
  project(value)?.state?.threads[
    value.activeThreadId ?? Object.keys(project(value)?.state?.threads ?? {})[0]
  ];
const quit = () =>
  app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu().items[0].submenu.items.find(
      (item) => item.accelerator === "CmdOrCtrl+Q",
    );
    if (!item) throw new Error("Missing quit menu");
    item.click();
  });
const launch = async () => {
  app = await electron.launch({
    executablePath: require("electron"),
    args: [application.path],
    env,
    timeout: 120000,
  });
  child = app.process();
  processes.push(child);
  child.stderr.on(
    "data",
    (chunk) => void writeFile(join(scratch, "electron.log"), chunk, { flag: "a" }),
  );
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => errors.push(error.stack));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await until(async () => (await snapshot()).connection?.state === "ready", "GUI ready");
};
const exited = async () => {
  await until(() => child.exitCode !== null || child.signalCode !== null, "GUI exit");
  assert.equal(child.exitCode, 0);
  app = null;
};
const responses = (values) =>
  app.evaluate((_electron, values) => {
    globalThis.responses = values;
  }, values);
const activity = () => host.activity();
const remoteControl = async (params) => {
  const result = await page.evaluate(
    (params) => window.arealDesktop.command("remoteControl", params),
    params,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};
const remoteConnect = async (origin, identity, hostId, inviteSecret) => {
  const { RemoteConnection } = await import("../packages/remote-client/src/index.mjs");
  const WebSocket = require("ws");
  remoteSocket = new WebSocket(origin.replace(/^http/, "ws") + "/remote/socket", { origin });
  remoteClient = new RemoteConnection({
    socket: remoteSocket,
    identity,
    host: hostId,
    hello: { displayName: "Isolated quit fixture", ...(inviteSecret ? { inviteSecret } : {}) },
    isCurrent: () => true,
    onClose: () => {},
  });
  return remoteClient.connect({ onHandshake() {}, async onReady() {}, onSession() {} });
};
const send = async (text) => {
  await page.getByTestId("chat-input").fill(text);
  await page.getByTestId("chat-send-button").click();
  await until(
    async () =>
      thread(await snapshot())
        ?.turns.at(-1)
        ?.items.some(
          (item) => item.type === "agentMessage" && item.text?.includes("QUIT_FIXTURE_STREAM"),
        ),
    "stream visible",
  );
  await until(
    async () =>
      (await activity()).projects.some((item) => item.state === "observed" && item.activeTurns > 0),
    "Host observes active turn",
  );
  return thread(await snapshot()).id;
};
const cleanupHost = async () => {
  const observer = new HostClient();
  try {
    if (!hostPid)
      hostPid = JSON.parse(
        await readFile(join(env.AREAL_HARNESS_SERVICE_HOME, "host/host.json"), "utf8"),
      ).pid;
    try {
      await observer.connect(env.AREAL_HARNESS_SERVICE_HOME);
      const state = await observer.status();
      corePids.push(
        ...state.projects
          .flatMap((item) => (item.service ? [item.service.hostPid, item.service.corePid] : []))
          .filter(Boolean),
      );
      const result = await observer.stop(randomUUID(), observer.generation, "cancel");
      assert.equal(result.state, "completed");
    } catch (error) {
      const receipt = JSON.parse(
        await readFile(join(env.AREAL_HARNESS_SERVICE_HOME, "host/stop.json"), "utf8"),
      );
      if (receipt.state !== "completed") throw error;
    }
    for (const pid of [...hostPids, hostPid, ...corePids].filter(Boolean))
      await until(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          if (error.code === "ESRCH") return true;
          throw error;
        }
      }, `owned process ${pid} exits`);
    cleanup = { hostPids, corePids, exited: true };
  } catch (error) {
    cleanup = { hostPid, corePids, error: error.stack };
    passed = false;
  } finally {
    observer.close();
  }
};
console.log("Host quit evidence:", scratch);
try {
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  await writeFile(
    env.AREAL_CORE_CONFIG,
    `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nname="Fixture"\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${server.address().port}/v1/chat/completions"\nmodels=[{id="fixture",enabled=true}]\n`,
  );
  application = await applicationFixture(gui, join(scratch, "app"), bootstrap);
  await launch();
  host = new HostClient();
  await host.connect(env.AREAL_HARNESS_SERVICE_HOME);
  hostPid = JSON.parse(
    await readFile(join(env.AREAL_HARNESS_SERVICE_HOME, "host/host.json"), "utf8"),
  ).pid;
  hostPids.push(hostPid);
  await until(async () => {
    const a = await activity();
    return a.complete && a.projects.every((p) => p.state === "observed" && p.idleAllowed);
  }, "idle");
  await quit();
  await exited();
  assert.equal((await events()).filter((e) => e.event === "dialog").length, 0);
  await activity();
  checks.push("idle quit exits without native confirmation and Host remains reachable");
  await launch();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.locator(".provider-catalog-row").filter({ hasText: "Fixture" }).click();
  const name = page.getByRole("textbox", { name: "供应商名称", exact: true });
  await name.fill("Fixture draft");
  await quit();
  const guard = page.getByRole("dialog", { name: "供应商有未保存的修改", exact: true });
  await guard.waitFor();
  await page.screenshot({ path: join(scratch, "draft-confirmation.png") });
  await guard.getByRole("button", { name: "继续编辑", exact: true }).click();
  assert.equal(await name.inputValue(), "Fixture draft");
  assert.equal(child.exitCode, null);
  checks.push("draft cancellation preserves edits and GUI");
  await guard.waitFor({ state: "hidden" });
  await name.fill("Fixture");
  await page.getByRole("button", { name: "后台服务", exact: true }).click();
  const quitDescription = page.getByText(
    "默认保持共享后台运行。有活动任务时可选择停止任务并退出，停止需要再次确认。",
    { exact: true },
  );
  await quitDescription.waitFor();
  await quitDescription.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(scratch, "settings-quit.png") });
  await page.getByRole("button", { name: "返回应用", exact: true }).click();
  await app.evaluate(({ dialog }, workspace) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
  }, workspace);
  await page.getByRole("button", { name: "不在项目中工作", exact: true }).click();
  await page.getByRole("menuitem", { name: "新建项目", exact: true }).click();
  await until(async () => project(await snapshot())?.state?.connected, "project ready");
  const first = await send("Keep this turn running while GUI quits.");
  const status = await host.status();
  corePids = status.projects
    .flatMap((item) => (item.service ? [item.service.hostPid, item.service.corePid] : []))
    .filter(Boolean);
  assert.ok(corePids.length, "Host status records the owned Core PID");
  await responses([0]);
  await quit();
  await exited();
  let dialogs = (await events()).filter((e) => e.event === "dialog");
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].options.defaultId, 0);
  assert.equal(dialogs[0].options.cancelId, 2);
  assert.ok(
    (await activity()).projects.some((item) => item.state === "observed" && item.activeTurns > 0),
  );
  await launch();
  await until(async () => thread(await snapshot())?.id === first, "same thread restored");
  assert.equal(thread(await snapshot()).turns.at(-1).status, "inProgress");
  streams[0].end(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
  );
  await until(
    async () => thread(await snapshot())?.turns.at(-1)?.status === "completed",
    "same turn completes",
  );
  assert.equal(streams.length, 1);
  checks.push("busy keep exits and original turn continues to completion after GUI relaunch");
  const oldGeneration = host.generation;
  const projectId = project(await snapshot()).id;
  if (remoteEnabled) {
    remoteResult = "attempted";
    const { createIdentity, identityId } = await import("../packages/remote/src/channel.mjs");
    await remoteControl({ operation: "enableDirect" });
    const invitation = await remoteControl({ operation: "pair", transport: "direct" });
    const url = new URL(invitation.payload);
    const fragment = new URLSearchParams(url.hash.slice(1));
    const hostId = fragment.get("host");
    const invite = fragment.get("invite");
    assert.ok(hostId && invite);
    remoteIdentity = await createIdentity();
    const connected = remoteConnect(url.origin, remoteIdentity, hostId, invite);
    const peer = identityId(remoteIdentity);
    await until(
      async () =>
        (await remoteControl({ operation: "status" })).pending.some((item) => item.id === peer),
      "Remote pairing request",
    );
    await remoteControl({
      operation: "approve",
      id: peer,
      projects: [projectId],
      preset: "Observer",
    });
    await connected;
    await remoteClient.request({ method: "host.describe", params: {} });
    const state = await remoteControl({ operation: "status" });
    const grant = state.deviceGrants.find((item) => item.devicePeerId === peer);
    assert.ok(grant);
    remoteBefore = {
      origin: url.origin,
      hostId,
      peer,
      grant: {
        projectIds: grant.projectIds,
        capabilities: grant.capabilities,
        revision: grant.revision,
        status: grant.status,
      },
    };
    desktopPid = JSON.parse(await readFile(join(env.AREAL_CORE_HOME, "service.json"), "utf8")).pid;
    await writeFile(
      join(scratch, "remote-public-before.json"),
      JSON.stringify(remoteBefore, null, 2),
    );
  }
  await responses([1]);
  await app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu().items[0].submenu;
    const index = menu.items.findIndex((item) => item.id === "shared-host-activity");
    if (index < 0) throw new Error("Missing Host menu");
    menu.items[index + 1].click();
  });
  await until(
    async () =>
      (await events()).some(
        (e) => e.event === "stop-receipt" && e.result?.operation?.phase === "completed",
      ),
    "menu stop completed",
  );
  assert.equal(child.exitCode, null, "menu stop retains GUI");
  await until(() => {
    try {
      process.kill(hostPid, 0);
      return false;
    } catch (error) {
      if (error.code === "ESRCH") return true;
      throw error;
    }
  }, "original Host exits");
  if (remoteEnabled) {
    await until(() => remoteSocket.readyState === 3, "old Remote socket closes");
    await assert.rejects(
      fetch(new URL("/health", remoteBefore.origin), { signal: AbortSignal.timeout(3000) }),
    );
  }
  host.close();
  const reconnect = await page.evaluate(() => window.arealDesktop.command("connectService", {}));
  assert.equal(reconnect.ok, true, JSON.stringify(reconnect));
  host = new HostClient();
  await host.connect(env.AREAL_HARNESS_SERVICE_HOME);
  assert.notEqual(host.generation, oldGeneration);
  hostPid = JSON.parse(
    await readFile(join(env.AREAL_HARNESS_SERVICE_HOME, "host/host.json"), "utf8"),
  ).pid;
  hostPids.push(hostPid);
  const opened = await page.evaluate(
    ({ projectId, threadId }) => window.arealDesktop.command("open", { projectId, threadId }),
    { projectId, threadId: first },
  );
  assert.equal(opened.ok, true, JSON.stringify(opened));
  await until(
    async () => project(await snapshot())?.state?.connected,
    "explicit project open after reconnect",
  );
  if (remoteEnabled) {
    assert.equal(
      JSON.parse(await readFile(join(env.AREAL_CORE_HOME, "service.json"), "utf8")).pid,
      desktopPid,
    );
    const state = await until(async () => {
      const value = await remoteControl({ operation: "status" });
      return value.directUrl ? value : null;
    }, "Remote Direct restored");
    assert.equal(new URL(state.directUrl).origin, remoteBefore.origin);
    const grant = state.deviceGrants.find((item) => item.devicePeerId === remoteBefore.peer);
    assert.deepEqual(
      {
        projectIds: grant.projectIds,
        capabilities: grant.capabilities,
        revision: grant.revision,
        status: grant.status,
      },
      remoteBefore.grant,
    );
    await remoteConnect(remoteBefore.origin, remoteIdentity, remoteBefore.hostId);
    const description = await remoteClient.request({ method: "host.describe", params: {} });
    assert.equal(description.hostId, remoteBefore.hostId);
    assert.ok(description.methods.includes("host.describe"));
    remoteSocket.terminate();
    checks.push(
      "Remote Direct and grant recover on retained Desktop after Host restart; authenticated readonly request succeeds",
    );
    remoteResult = "passed";
  }
  const reopenedStatus = await host.status();
  corePids.push(
    ...reopenedStatus.projects
      .flatMap((item) => (item.service ? [item.service.hostPid, item.service.corePid] : []))
      .filter(Boolean),
  );
  checks.push(
    "menu stop keeps GUI; explicit reconnect creates successor Host and explicit open reconnects project",
  );
  await send("Stop this running turn.");
  await responses([1, 0]);
  await quit();
  await until(
    async () => (await events()).filter((e) => e.event === "dialog").length === 4,
    "stop second confirmation canceled",
  );
  assert.equal(child.exitCode, null);
  assert.ok(
    (await activity()).projects.some((item) => item.state === "observed" && item.activeTurns > 0),
  );
  await responses([1, 1]);
  await app.evaluate(() => {
    globalThis.holdStop = true;
  });
  await quit();
  await until(
    async () => (await events()).filter((e) => e.event === "stop-held").length === 2,
    "stop progress visible",
  );
  await page.getByRole("dialog", { name: "正在退出 AReaL Harness", exact: true }).waitFor();
  await page.screenshot({ path: join(scratch, "quit-progress.png") });
  await app.evaluate(() => {
    globalThis.holdStop = false;
  });
  await exited();
  const receipt = (await events()).filter((e) => e.event === "stop-receipt").at(-1);
  assert.equal(receipt?.result?.operation?.phase, "completed");
  assert.equal(receipt.result.stopped, true);
  dialogs = (await events()).filter((e) => e.event === "dialog");
  assert.equal(dialogs.length, 6);
  assert.equal(dialogs[1].options.cancelId, 0);
  assert.equal(dialogs[2].options.cancelId, 2);
  assert.equal(dialogs[3].options.cancelId, 0);
  assert.equal(dialogs[5].options.cancelId, 0);
  checks.push(
    "busy stop requires second confirmation; cancel keeps turn, confirm returns completed Host receipt and exits",
  );
  passed = true;
} catch (error) {
  errors.push(error.stack);
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(scratch, "failure.png") }).catch(() => {});
    await writeFile(
      join(scratch, "failure.txt"),
      await page
        .locator("body")
        .innerText()
        .catch(() => ""),
    );
  }
} finally {
  remoteSocket?.terminate();
  if (app && child?.exitCode === null) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await until(
      () => child.exitCode !== null || child.signalCode !== null,
      "owned GUI cleanup",
    ).catch((e) => errors.push(e.message));
  }
  host?.close();
  await cleanupHost();
  for (const stream of streams) stream.destroy();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await application?.close();
  for (const [name, hash] of Object.entries(hashes))
    assert.equal(sha(await readFile(join(dirname(binary), name))), hash);
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed,
        checks,
        remote: remoteResult,
        errors,
        cleanup,
        binary,
        hashes,
        processes: processes.map((p) => ({
          pid: p.pid,
          exitCode: p.exitCode,
          signalCode: p.signalCode,
        })),
        source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
        diffSha256: sha(execFileSync("git", ["diff", "HEAD"], { cwd: root })),
        scope:
          "Isolated source Electron and fixed Core, deterministic loopback SSE; injected native folder picker and dialog responses; application menu callback, no physical input or native dialog visual acceptance; no provider or package.",
      },
      null,
      2,
    ),
  );
  console.log(passed ? "PASS" : "FAIL", checks, errors, cleanup);
  if (!passed) process.exitCode = 1;
}
