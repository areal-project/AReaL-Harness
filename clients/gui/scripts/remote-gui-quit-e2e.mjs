import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { applicationFixture } from "./application-fixture.mjs";
import { readTurnToolDetails } from "./support/tool-history.mjs";
import { respondToSessionName } from "../../../scripts/model-fixture.mjs";
import { makeTempDir } from "./support/temp.mjs";
import { selectRemoteTransport, requireBrowserTransport } from "./remote-conformance-transport.mjs";
const transport = selectRemoteTransport();
await requireBrowserTransport(transport, "remote-gui-quit-e2e");
import assert from "node:assert/strict";
import { selectConversation, captureSmokeFailure } from "./smoke-navigation.mjs";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile, readdir, access, lstat, unlink } from "node:fs/promises";

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

const prompt = "RC13 approval continuity";
const effect = "approved once";
function modelStage(body) {
  assert.equal(body.stream, true);
  const messages = body.messages ?? [];
  // Core wraps areal_context as user-role text for Chat Completions.
  // Preserve original user-Turn scoping while excluding that explicit wrapper.
  const last = messages.findLastIndex(
    (message) =>
      message.role === "user" &&
      !(
        typeof message.content === "string" &&
        message.content.startsWith("AReaL runtime context (not a user request):\n")
      ),
  );
  assert.ok(
    JSON.stringify(messages[last]?.content).includes(prompt),
    "only original GUI turn may call model",
  );
  const tools = messages.slice(last + 1).filter((message) => message.role === "tool");
  assert.ok(tools.length <= 1, "one filesystem result");
  return tools.length ? "completion" : "approval";
}
function modelDelta(stage) {
  return stage === "approval"
    ? {
        tool_calls: [
          {
            index: 0,
            id: "rc13-write",
            type: "function",
            function: {
              name: "fs_create",
              arguments: JSON.stringify({ path: "approved.txt", text: effect }),
            },
          },
        ],
      }
    : { content: "RC13 original turn completed." };
}
// 纯模型检查不载入 Electron，也不启动网络或服务。
if (process.argv.includes("--self-test")) {
  const first = { stream: true, messages: [{ role: "user", content: prompt }] };
  assert.equal(modelStage(first), "approval");
  assert.equal(
    modelStage({ ...first, messages: [...first.messages, { role: "tool", content: "created" }] }),
    "completion",
  );
  assert.throws(() =>
    modelStage({ ...first, messages: [{ role: "user", content: "unexpected" }] }),
  );
  assert.throws(() =>
    modelStage({ ...first, messages: [...first.messages, { role: "tool" }, { role: "tool" }] }),
  );
  assert.deepEqual(JSON.parse(modelDelta("approval").tool_calls[0].function.arguments), {
    path: "approved.txt",
    text: effect,
  });
  console.log("PASS: deterministic two-stage model and rejection checks (source-only)");
} else await run();

async function run() {
  const gui = process.env.AREAL_VERIFY_ROOT
    ? resolve(process.env.AREAL_VERIFY_ROOT, "clients/gui")
    : resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const desktop = join(gui, "app");
  const require = createRequire(join(desktop, "package.json"));
  const { _electron: electron, chromium } = require("playwright-core");
  const { HostClient } = require("../app/src/core/host-client.cjs");
  const { readHostReceipt, readOfflineHostReceipt } = require("../app/src/core/host-lifecycle.cjs");
  const isMac = process.platform === "darwin";
  assert.ok(
    !isMac || process.env.AREAL_TEST_HOST_KEYCHAIN === "1",
    "Requires isolated native safeStorage and synthetic Host vault authorization",
  );
  const scratch = await makeTempDir("rc13-quit-");
  const workspace = join(scratch, "workspace");
  await mkdir(workspace);
  await mkdir(join(scratch, "user-home"));
  const stages = [],
    modelErrors = [],
    checks = [];
  const report = {
    status: "failed",
    scratch,
    checks,
    cleanup: [],
    summaryRequests: 0,
    fixture: {
      nextPromptSuggestions: false,
      scope: "isolated GUI profile and PWA localStorage",
      reason:
        "Only original Solve approval/completion and separate session Summary are model requests in this fixture",
    },
    visualEvidence: [],
    providerStages: stages,
    coreRpcDispatchCount: "not observable through public GUI/PWA interfaces",
  };
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      if (respondToSessionName(body, response)) {
        report.summaryRequests++;
        return;
      }
      const stage = modelStage(body);
      assert.equal(stage, stages.length === 0 ? "approval" : "completion");
      assert.ok(stages.length < 2, "no provider replay");
      stages.push(stage);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const [delta, finish_reason] of [
        [modelDelta(stage), null],
        [{}, stage === "approval" ? "tool_calls" : "stop"],
      ])
        response.write(
          `data: ${JSON.stringify({ id: "rc13", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      response.end("data: [DONE]\n\n");
    } catch (error) {
      modelErrors.push(error.message);
      response.writeHead(500);
      response.end("fixture rejected unexpected model request");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await writeFile(
    join(scratch, "config.toml"),
    `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${server.address().port}/v1/chat/completions"\n`,
  );
  await writeFile(
    join(scratch, "desktop.json"),
    JSON.stringify({
      profiles: [
        {
          id: "standard",
          revision: "v1",
          displayName: "RC13",
          instructions: "Complete the task",
          approvalTools: ["fs_create"],
        },
      ],
    }),
  );
  const env = {
    ...process.env,
    AREAL_GUI: "workbench",
    AREAL_BACKEND: "areal",
    AREAL_CORE_BIN: process.env.AREAL_CORE_BIN || resolve(gui, "../../target/debug/areal"),
    AREAL_CORE_HOME: join(scratch, "core"),
    AREAL_CORE_USER_HOME: join(scratch, "user-home"),
    AREAL_HARNESS_HOME: join(scratch, "runtime"),
    AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
    AREAL_CORE_CONFIG: join(scratch, "config.toml"),
    AREAL_CORE_DESKTOP_CONFIG: join(scratch, "desktop.json"),
    AREAL_GUI_USER_DATA: join(scratch, "electron"),
  };
  if (!isMac) env.HOME = env.AREAL_CORE_USER_HOME;
  for (const key of [
    "AREAL_CORE_WORKSPACE",
    "AREAL_HARNESS_CONFIG",
    "AREAL_HARNESS_TOOL_EXTENSIONS",
    "AREAL_CORE_WORKGROUP_POLICY",
    "AREAL_CORE_WORKGROUP_TOOLCHAIN",
    "ELECTRON_RUN_AS_NODE",
  ])
    delete env[key];
  for (const key of ["NO_PROXY", "no_proxy"])
    env[key] = [env[key], "127.0.0.1", "localhost"].filter(Boolean).join(",");
  assert.equal(
    process.env.AREAL_GUI_EXECUTABLE,
    undefined,
    "This acceptance uses isolated source Electron, not an installed package",
  );
  const fixture = await applicationFixture(
    gui,
    join(scratch, "app"),
    `
globalThis.responses=[];
require("electron").dialog.showMessageBox=async (...args)=>{const options=args.at(-1);if(options.title==="允许本地开发站点")return {response:1};const response=globalThis.responses.shift();if(response===undefined)throw new Error("Unexpected native dialog");return {response};};
`,
  );
  const runId = randomUUID(),
    appName = `AReaL Remote SafeStorage Test ${runId}`;
  const keychainService = `${appName} Safe Storage`;
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  const hostService = `org.areal.host.v1.${digest(env.AREAL_HARNESS_SERVICE_HOME)}`;
  const installedElectron = process.env.AREAL_ELECTRON_EXECUTABLE || require("electron");
  const executablePath = isMac
    ? join(scratch, "Electron.app/Contents/MacOS/Electron")
    : installedElectron;
  if (isMac) {
    const electronBundle = join(scratch, "Electron.app");
    const plist = join(electronBundle, "Contents/Info.plist");
    execFileSync("/usr/bin/ditto", [resolve(installedElectron, "../../.."), electronBundle]);
    const appDirectory = join(electronBundle, "Contents/Resources/app");
    await mkdir(appDirectory, { recursive: true });
    // Main 的原资源生产者仍按 resourcesPath 提供已构建的 Remote 资源闭包。
    execFileSync("/usr/bin/ditto", [
      join(gui, "renderer/dist"),
      join(electronBundle, "Contents/Resources/areal-gui"),
    ]);
    await writeFile(
      join(appDirectory, "package.json"),
      JSON.stringify({
        name: "areal-remote-isolated-test",
        productName: appName,
        main: "main.cjs",
      }),
    );
    await writeFile(
      join(appDirectory, "main.cjs"),
      `const assert=require("node:assert/strict");
  const {app,safeStorage}=require("electron");
  assert.equal(app.isReady(),false);assert.equal(app.getName(),${JSON.stringify(appName)});assert.equal(process.defaultApp??false,false);
  const original={object:safeStorage,encrypt:safeStorage.encryptString,decrypt:safeStorage.decryptString};
  const setName=app.setName.bind(app);
  app.setName=name=>{assert(["AReaL Harness GUI",${JSON.stringify(appName)}].includes(name));setName(${JSON.stringify(appName)});};
  Object.defineProperty(app,"isPackaged",{value:false});app.setAppPath(${JSON.stringify(fixture.path)});
  app.once("ready",()=>{assert.equal(app.getName(),${JSON.stringify(appName)});assert.equal(require("electron").safeStorage,original.object);assert.equal(safeStorage.encryptString,original.encrypt);assert.equal(safeStorage.decryptString,original.decrypt);});
  require(${JSON.stringify(join(scratch, "app/bootstrap.cjs"))});\n`,
    );
    for (const [key, value] of [
      ["CFBundleName", appName],
      ["CFBundleDisplayName", appName],
      ["CFBundleIdentifier", `org.areal.remote.${runId}`],
    ])
      execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plist]);
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", electronBundle]);
    execFileSync("/usr/bin/codesign", ["--verify", "--strict", electronBundle]);
  }
  const security = (args) => spawnSync("/usr/bin/security", args, { encoding: "utf8", env });
  const missing = (result) => result.status === 44 && result.stderr.includes("could not be found");
  async function cleanEntry(service, account) {
    const found = security(["find-generic-password", "-s", service, "-a", account]);
    if (missing(found)) {
      report.cleanup.push({ service, account, state: "absent" });
      return;
    }
    assert.equal(found.status, 0, `Keychain lookup failed for ${service}/${account}`);
    const keychain = /^keychain: "([^"\n]+)"/m.exec(found.stdout)?.[1];
    assert.ok(keychain?.startsWith("/"));
    assert.equal(
      security(["delete-generic-password", "-s", service, "-a", account, keychain]).status,
      0,
    );
    assert.ok(missing(security(["find-generic-password", "-s", service, "-a", account, keychain])));
    report.cleanup.push({ service, account, keychain, state: "removed" });
  }
  if (isMac)
    for (const account of [appName, `${appName} Key`])
      assert.ok(missing(security(["find-generic-password", "-s", keychainService, "-a", account])));
  report.identity = {
    guiSourceRoot: resolve(gui, "../.."),
    mainSha256: digest(await readFile(join(gui, "app/src/core/main.cjs"))),
    rendererReceiptSha256: digest(
      await readFile(join(gui, "renderer/dist/verification-build.json")),
    ),
    remoteAssetsSha256: digest(await readFile(join(gui, "renderer/dist/remote-assets.json"))),
    binary: env.AREAL_CORE_BIN,
    binarySha256: digest(await readFile(env.AREAL_CORE_BIN)),
    harnessSha256: digest(await readFile(fileURLToPath(import.meta.url))),
    electronBinary: executablePath,
    electronSha256: digest(await readFile(executablePath)),
    ...(isMac
      ? { safeStorageService: keychainService, hostVaultService: hostService }
      : { hostVaultDirectory: join(env.AREAL_HARNESS_SERVICE_HOME, "host/vault") }),
  };
  let app, page, browser, remote, projectId, threadId, adapter, child;
  const json = async (path) => JSON.parse(await readFile(path, "utf8"));
  const exists = async (path) => {
    try {
      await access(path);
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
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
  const until = async (predicate, label, timeout = 30000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const value = await predicate();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timeout: ${label}`);
  };
  const state = () => page.evaluate(() => window.arealDesktop.snapshot());
  const call = async (name, params = {}) => {
    const result = await page.evaluate(
      async ({ name, params }) => window.arealDesktop.command(name, params),
      { name, params },
    );
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  };
  const project = (snapshot) => snapshot.projects.find((value) => value.id === projectId);
  const thread = (snapshot) => project(snapshot)?.state?.threads[threadId];
  const button = (name) => page.getByRole("button", { name, exact: true });
  const dump = async (target, name, region) => {
    report.visualCapturePending = name;
    const png = join(scratch, `${name}.png`),
      aria = join(scratch, `${name}.aria.txt`);
    if (region) await region.screenshot({ path: png });
    else await target.screenshot({ path: png, fullPage: true });
    await writeFile(aria, await (region ?? target.locator("body")).ariaSnapshot());
    report.visualEvidence.push({ name, png, aria });
    delete report.visualCapturePending;
  };
  const launch = async (expectedReady = true) => {
    app = await electron.launch({
      executablePath,
      args: isMac ? [] : [fixture.path],
      env,
      timeout: 120000,
    });
    child = app.process();
    page = await app.firstWindow();
    page.setDefaultTimeout(30000);
    await page.locator("[data-testid=areal-workbench]").waitFor({ timeout: 120000 });
    await page.evaluate(() => {
      const key = "areal-gui:application-preferences";
      const prefs = JSON.parse(localStorage.getItem(key) || "{}");
      localStorage.setItem(key, JSON.stringify({ ...prefs, nextPromptSuggestions: false }));
    });
    await page.reload();
    await page.locator("[data-testid=areal-workbench]").waitFor({ timeout: 120000 });
    const actual = await app.evaluate(({ app, BrowserWindow }) => {
      const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return {
        pid: process.pid,
        electron: process.versions.electron,
        userData: app.getPath("userData"),
        sandbox: preferences.sandbox,
        contextIsolation: preferences.contextIsolation,
        nodeIntegration: preferences.nodeIntegration,
        desktopLifetime: process.env.AREAL_GUI_DESKTOP_LIFETIME_FD,
      };
    });
    assert.equal(actual.pid, child.pid);
    assert.equal(actual.electron, require("electron/package.json").version);
    assert.equal(actual.userData, env.AREAL_GUI_USER_DATA);
    assert.equal(actual.sandbox, true);
    assert.equal(actual.contextIsolation, true);
    assert.equal(actual.nodeIntegration, false);
    assert.equal(actual.desktopLifetime, undefined);
    if (expectedReady) {
      await until(async () => (await state()).connection?.state === "ready", "Main instance ready");
      const client = new HostClient();
      try {
        await client.connect(env.AREAL_HARNESS_SERVICE_HOME);
        actual.host = { hostId: client.hostId, generation: client.generation };
        const status = await client.status();
        assert.equal(status.hostId, client.hostId);
        assert.equal(status.generation, client.generation);
      } finally {
        client.close();
      }
    } else
      assert.equal(await exists(join(env.AREAL_HARNESS_SERVICE_HOME, "host/host.json")), false);
    await noDesktopProcess(`Main launch ${child.pid}`);
    report.instanceDoctors ??= [];
    report.instanceDoctors.push(actual);
    await writeFile(join(scratch, `doctor-${child.pid}.json`), JSON.stringify(actual, null, 2));
  };
  const quit = async () => {
    const pid = child.pid;
    const closed = page.waitForEvent("close", { timeout: 60000 });
    report.cleanup.push({ kind: "application quit requested", pid });
    await app
      .evaluate(({ app }) => {
        globalThis.responses = [0];
        app.quit();
      })
      .catch((error) => {
        if (!/closed|destroyed|Target/.test(error.message)) throw error;
      });
    await closed;
    report.cleanup.push({ kind: "GUI window closed", pid });
    const driverClose = await Promise.race([
      app.close().then(() => "completed"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 5000)),
    ]);
    report.cleanup.push({ kind: "Playwright close", state: driverClose, pid });
    await until(
      () => child.exitCode !== null || child.signalCode !== null,
      "normal GUI process exit",
    );
    assert.equal(child.exitCode, 0, "normal GUI process completely exited");
    assert.equal(alive(pid), false);
    report.cleanup.push({ kind: "GUI process exited", pid, exitCode: child.exitCode });
    app = null;
  };
  // 只读取本测试独占注册目录的身份；不输出端点或凭据。
  const generation = async () => {
    const directory = join(env.AREAL_HARNESS_SERVICE_HOME, "services");
    const records = [];
    for (const name of await readdir(directory)) {
      const path = join(directory, name, "service.json");
      if (await exists(path)) {
        const record = await json(path);
        if (record.workspace === workspace) records.push(record);
      }
    }
    assert.equal(records.length, 1, "exactly one Core service for the isolated project workspace");
    assert.ok(records[0].generation);
    return records[0].generation;
  };
  const descriptorPath = join(env.AREAL_HARNESS_SERVICE_HOME, "host/host.json");
  const processes = () =>
    execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
      .split("\n")
      .flatMap((line) => {
        const row = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
        return row ? [{ pid: Number(row[1]), ppid: Number(row[2]), command: row[3] }] : [];
      });
  const noDesktopProcess = async (phase) => {
    assert.equal(await exists(join(env.AREAL_CORE_HOME, "service.json")), false);
    const legacy = processes().filter(
      (row) => row.command.includes(scratch) && row.command.includes("--areal-desktop-service"),
    );
    assert.deepEqual(legacy, []);
    report.mainOnly ??= [];
    report.mainOnly.push({ phase, desktopDescriptorAbsent: true, desktopProcesses: legacy });
  };
  let powerSource;
  const powerRead = async () => {
    const client = new HostClient();
    try {
      await client.connect(env.AREAL_HARNESS_SERVICE_HOME);
      client.requireCapability("powerV1");
      powerSource ??= (await client.request("remote.read", {})).sourceId;
      assert.equal(typeof powerSource, "string");
      return await client.request("host.power", { sourceId: powerSource });
    } finally {
      client.close();
    }
  };
  const powerActive = async (phase) => {
    const proof = await until(async () => {
      const state = await powerRead();
      if (!state.enabled || !state.active || state.error) return false;
      const helper = processes().find(
        (row) =>
          row.ppid === adapter.pid &&
          (isMac
            ? row.command === `/usr/bin/caffeinate -i -w ${adapter.pid}`
            : row.command.includes("/usr/bin/systemd-inhibit")),
      );
      if (!helper) return false;
      const assertions = isMac
        ? execFileSync("/usr/bin/pmset", ["-g", "assertions"], { encoding: "utf8" })
            .split("\n")
            .filter((line) => line.includes(`pid ${helper.pid}(`))
        : [];
      if (isMac && !assertions.some((line) => line.includes("PreventUserIdleSystemSleep")))
        return false;
      return { phase, state, helper, assertions };
    }, `Host sleep protection ${phase}`);
    report.power ??= [];
    report.power.push(proof);
    return proof;
  };
  const sameOwner = async () => {
    const current = await json(descriptorPath);
    assert.equal(current.pid, adapter.pid);
    assert.equal(current.hostId, adapter.hostId);
    assert.equal(current.generation, adapter.generation);
    assert.ok(alive(adapter.pid));
    assert.equal(await generation(), report.coreGeneration);
  };
  try {
    await launch();
    await app.evaluate(({ dialog }, workspace) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
    }, workspace);
    await button("不在项目中工作").click();
    await page.getByRole("menuitem", { name: "新建项目", exact: true }).click();
    await until(
      async () =>
        (await state()).projects.find((project) => project.root === workspace)?.state?.connected,
      "isolated project ready",
    );
    projectId = (await state()).projects.find((project) => project.root === workspace).id;
    await button("设置").click();
    await button("手机连接").click();
    // 生产后台 safeStorage gate 是唯一 oracle；不替换加密实现。
    try {
      await call("remoteControl", { operation: "enableDirect" });
    } catch (error) {
      report.status = "blocked";
      report.blockedAt = "production enableDirect gate";
      throw error;
    }
    await button("添加设备").click();
    const invite = await page.getByRole("textbox", { name: "配对链接", exact: true }).inputValue();
    browser = await chromium.launch({
      executablePath:
        process.env.AREAL_CHROME_EXECUTABLE ||
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
    });
    remote = await browser.newPage();
    await remote.addInitScript(() => {
      const key = "areal-gui:application-preferences";
      const prefs = JSON.parse(localStorage.getItem(key) || "{}");
      localStorage.setItem(key, JSON.stringify({ ...prefs, nextPromptSuggestions: false }));
    });
    await remote.goto(invite);
    await remote.getByRole("button", { name: "连接电脑", exact: true }).click();
    await remote
      .getByRole("status")
      .getByText(/等待桌面确认/)
      .waitFor();
    const pending = (await call("remoteControl", { operation: "status" })).pending;
    assert.equal(pending.length, 1);
    const approval = page.getByRole("group", { name: `确认设备 ${pending[0].id}`, exact: true });
    await approval.getByLabel("workspace", { exact: true }).check();
    await approval.getByRole("radio", { name: "可操作", exact: true }).check();
    await dump(page, "pair-pending-gui", approval);
    await dump(
      remote,
      "pair-pending-pwa",
      remote.getByRole("status").filter({ hasText: /等待桌面确认/ }),
    );
    await approval.getByRole("button", { name: "允许连接", exact: true }).click();
    await remote
      .getByRole("status")
      .getByText(/已连接/)
      .waitFor();
    await page.getByRole("textbox", { name: "配对链接", exact: true }).waitFor({ state: "hidden" });
    await dump(page, "pair-approved-gui");
    await dump(remote, "pair-approved-pwa");
    await button("返回应用").click();
    ({ threadId } = await call("create", {
      projectId,
      profile: { id: "standard", revision: "v1" },
    }));
    await selectConversation(page, threadId);
    await app.evaluate(({ app, BrowserWindow }) => {
      app.focus({ steal: true });
      BrowserWindow.getAllWindows()[0].focus();
    });
    await call("send", { projectId, threadId, text: prompt });
    const interaction = await until(
      async () =>
        project(await state())?.state?.interactions[threadId]?.data?.find(
          (item) => item.status === "pending",
        ),
      "original approval",
    );
    const original = thread(await state());
    assert.equal(original.turns.length, 1);
    const turnId = original.turns[0].id;
    assert.equal(interaction.turnId, turnId);
    report.original = { projectId, threadId, turnId, interactionId: interaction.requestId };
    adapter = await json(descriptorPath);
    report.hostPid = adapter.pid;
    report.hostId = adapter.hostId;
    report.hostGeneration = adapter.generation;
    report.coreGeneration = await generation();
    await noDesktopProcess("GUI active");
    assert.equal(await app.evaluate(() => process.env.AREAL_GUI_DESKTOP_LIFETIME_FD), undefined);
    const firstPower = await powerActive("original approval pending");
    await call("library", { operation: "settings", key: "preventSleep", value: false });
    await until(async () => {
      const power = await powerRead();
      return !power.enabled && !power.active && !alive(firstPower.helper.pid);
    }, "saved source opt-out releases the actual helper");
    report.power.push({
      phase: "saved source opt-out",
      state: await powerRead(),
      exitedPid: firstPower.helper.pid,
    });
    await call("library", { operation: "settings", key: "preventSleep", value: true });
    const headlessPower = await powerActive("source protection restored");
    const projectButton = remote.getByRole("button", { name: "workspace", exact: true });
    if ((await projectButton.getAttribute("aria-expanded")) === "true") await projectButton.click();
    await projectButton.click();
    await remote.locator(`.remote-session-row[data-thread-id="${threadId}"]`).click();
    await remote.getByRole("button", { name: "返回项目列表", exact: true }).click();
    await remote.getByRole("button", { name: "审阅待处理事项", exact: true }).click();
    await until(async () => {
      if (
        (await remote.locator("#attention-more").isVisible()) &&
        (await remote.locator("#attention-more").isEnabled())
      )
        await remote.locator("#attention-more").click();
      return !(await remote.locator("#attention-allow").isDisabled());
    }, "full authoritative review");
    assert.equal(
      await remote.locator("#attention-target").textContent(),
      `Thread ${threadId} · Turn ${turnId} · 交互 ${interaction.requestId}`,
    );
    assert.match(await remote.locator("#attention-body").textContent(), /approved.txt/);
    assert.equal(await exists(join(workspace, "approved.txt")), false);
    assert.deepEqual(stages, ["approval"]);
    await dump(page, "before-quit-original-pending-gui");
    await dump(remote, "before-quit-reviewed-approval-pwa");
    await quit();
    await sameOwner();
    await noDesktopProcess("GUI exited");
    const keptPower = await powerActive("GUI exited with original approval pending");
    assert.equal(keptPower.helper.pid, headlessPower.helper.pid);
    checks.push(
      "normal GUI exit preserves production Host identity and generation and original Core generation with approval pending",
    );
    await remote.locator("#attention-refresh").click();
    await until(
      async () => !(await remote.locator("#attention-allow").isDisabled()),
      "review after GUI exit",
    );
    await remote.locator("#attention-allow").click();
    await remote.getByRole("button", { name: "关闭审阅", exact: true }).click();
    await remote.locator(`.remote-session-row[data-thread-id="${threadId}"]`).click();
    await until(
      async () =>
        (await remote
          .locator(`#remote-session-ui [data-turn-id="${turnId}"]`)
          .getAttribute("data-turn-status")) === "completed",
      "original remote turn completed",
    );
    assert.equal(await remote.locator("#remote-session-ui [data-turn-id]").count(), 1);
    assert.equal(await readFile(join(workspace, "approved.txt"), "utf8"), effect);
    assert.deepEqual(stages, ["approval", "completion"]);
    assert.deepEqual(modelErrors, []);
    await sameOwner();
    await until(async () => {
      const power = await powerRead();
      return power.enabled && !power.active && !power.error && !alive(headlessPower.helper.pid);
    }, "original completion releases the actual Host sleep helper");
    report.power.push({
      phase: "original Core work completed",
      state: await powerRead(),
      exitedPid: headlessPower.helper.pid,
    });
    checks.push("PWA allowOnce after GUI exit completes the original turn and filesystem effect");
    await dump(remote, "after-quit-original-completed-pwa");
    await launch();
    await until(async () => project(await state())?.state?.connected, "reopened GUI connected");
    await call("open", { projectId, threadId });
    await until(
      async () => thread(await state())?.turns[0]?.status === "completed",
      "original history restored",
    );
    const restored = thread(await state());
    assert.deepEqual(
      restored.turns.map((turn) => turn.id),
      [turnId],
    );
    const originalDetails = await readTurnToolDetails({
      command: call,
      readThread: async () => thread(await state()),
      projectId,
      threadId,
      turnId,
    });
    const tools = originalDetails.items.filter(
      (item) => item.type === "dynamicToolCall" && item.tool === "fs_create",
    );
    assert.equal(tools.length, 1);
    assert.equal(tools[0].status, "completed");
    assert.equal(tools[0].success, true);
    const journalClient = new HostClient();
    let outcomes;
    try {
      await journalClient.connect(env.AREAL_HARNESS_SERVICE_HOME);
      const registrations = (await journalClient.request("projects.list", {})).projects.filter(
        (registration) =>
          registration.workspace === workspace &&
          registration.source.kind === "gui" &&
          registration.source.legacyProjectId === projectId,
      );
      assert.equal(
        registrations.length,
        1,
        "one authoritative Host binding for the original GUI project",
      );
      report.hostProjectId = registrations[0].projectId;
      const { snapshot } = await journalClient.journal(report.hostProjectId).read();
      outcomes = Object.values(snapshot.outcomes).filter((value) => value.remote);
    } finally {
      journalClient.close();
    }
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].method, "areal/interaction/respond");
    assert.equal(outcomes[0].accepted, true);
    assert.equal(outcomes[0].threadId, threadId);
    assert.equal(outcomes[0].turnId, turnId);
    assert.equal(typeof outcomes[0].remote.commandId, "string");
    assert.ok(outcomes[0].remote.commandId);
    assert.equal(outcomes[0].remote.projectId, projectId);
    report.remoteCommand = {
      commandId: outcomes[0].remote.commandId,
      persistedAcceptedCount: outcomes.length,
    };
    assert.equal(await readFile(join(workspace, "approved.txt"), "utf8"), effect);
    await sameOwner();
    assert.deepEqual(stages, ["approval", "completion"]);
    checks.push(
      "reopen restores one original turn and one completed fs_create without provider replay",
    );
    await dump(page, "reopened-original-history-gui");
    await until(async () => {
      const status = await call("serviceStatus");
      return !status.busy && !status.activeCommands && !status.starting && !status.providerUpdating;
    }, "service settled");
    // 仅为正常公开停止对话框提供显式选择，不改变服务实现。
    await app.evaluate(() => {
      globalThis.responses = [1];
    });
    assert.equal((await call("stopService")).stopped, true);
    const control = await json(join(env.AREAL_GUI_USER_DATA, "service-control.json"));
    assert.equal(control.version, 3);
    const references = control.references.filter(
      (reference) =>
        reference.kind === "stopHost" &&
        reference.hostId === adapter.hostId &&
        reference.generation === adapter.generation,
    );
    assert.equal(references.length, 1, "persisted original Host stop intent");
    const stopReceipt = await readOfflineHostReceipt(env.AREAL_CORE_BIN, references[0]);
    assert.equal(stopReceipt?.state, "completed");
    report.stopIntent = { reference: references[0], receipt: stopReceipt };
    for (const proof of report.power.filter((entry) => entry.helper))
      assert.equal(
        alive(proof.helper.pid),
        false,
        "tracked Host power helper no longer alive at normal Host stop",
      );
    await until(
      async () => !(await exists(descriptorPath)) && !alive(adapter.pid),
      "Host stopped and descriptor removed",
    );
    await remote
      .getByRole("status")
      .getByText(/已断开|不可用/)
      .waitFor();
    await quit();
    await launch(false);
    report.stoppedSnapshot = await until(async () => {
      const snapshot = await state();
      return (
        snapshot.connection?.state === "unavailable" &&
        snapshot.connection.recovery === "reconnect" && {
          connection: snapshot.connection,
          lifecycle: snapshot.lifecycle,
          serviceSummary: snapshot.serviceSummary,
        }
      );
    }, "persisted stop blocks automatic start");
    assert.equal(await exists(descriptorPath), false);
    assert.equal(alive(adapter.pid), false);
    assert.deepEqual(stages, ["approval", "completion"]);
    assert.deepEqual(modelErrors, []);
    checks.push(
      "public stopService persists stopped intent, disconnects Remote and prevents automatic restart",
    );
    await dump(page, "final-stopped-gui");
    await dump(remote, "final-disconnected-pwa");
    report.status = "passed";
  } catch (error) {
    report.error = error.message.replace(/#(?:host|invite)=[^\s"']+/g, "#[redacted]");
    report.modelErrors = modelErrors;
    if (page) await captureSmokeFailure(page, scratch, error);
    process.exitCode = report.status === "blocked" ? 2 : 1;
  } finally {
    // 失败时保留独占 scratch 与 PID 供人工恢复，绝不强杀未知或未结算工作。
    if (app)
      await quit().catch((error) => {
        report.cleanupError = error.message;
        report.status = "failed";
        process.exitCode = 1;
      });
    await browser?.close().catch((error) => {
      report.browserCleanupError = error.message;
      report.status = "failed";
      process.exitCode = 1;
    });
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    let hostStopped = false;
    let cleanupOwner = adapter;
    try {
      if (await exists(descriptorPath)) {
        cleanupOwner = await json(descriptorPath);
        const client = new HostClient();
        try {
          await client.connect(env.AREAL_HARNESS_SERVICE_HOME);
          const directory = join(env.AREAL_HARNESS_SERVICE_HOME, "host/operations");
          const unresolved = (receipt) =>
            ["acceptedPending", "admissionUnknown", "settlementIncomplete"].includes(
              receipt.state,
            ) ||
            receipt.migration?.phase === "draining" ||
            receipt.projects?.some(
              (target) => !["completed", "blocked"].includes(target.receipt?.state),
            );
          for (const name of await readdir(directory)) {
            const { receipt: original } = await json(join(directory, name));
            if (!unresolved(original)) continue;
            await until(async () => {
              const { operation } = await client.operation(original.requestId);
              assert.ok(operation, `UNKNOWN original lifecycle operation ${original.requestId}`);
              assert.equal(operation.requestId, original.requestId);
              assert.equal(operation.hostId, original.hostId);
              assert.equal(operation.generation, original.generation);
              return !unresolved(operation);
            }, "settle original Host operation without replay");
          }
          const reference = {
            kind: "stopHost",
            requestId: randomUUID(),
            home: env.AREAL_HARNESS_SERVICE_HOME,
            hostId: client.hostId,
            generation: client.generation,
            strategy: "cancel",
          };
          const observation = { kind: "fixture Host stop", reference };
          report.cleanup.push(observation);
          let receipt;
          try {
            receipt = readHostReceipt(
              reference,
              await client.stop(reference.requestId, reference.generation, "cancel"),
            );
          } catch (error) {
            observation.error = { code: error.code, message: error.message };
            client.close();
            receipt = await readOfflineHostReceipt(env.AREAL_CORE_BIN, reference);
          }
          observation.receipt = receipt ?? null;
          assert.ok(
            receipt,
            `UNKNOWN fixture stop ${reference.requestId}; original request not replayed`,
          );
          assert.equal(receipt.state, "completed");
        } finally {
          client.close();
        }
      }
      await until(
        async () => !(await exists(descriptorPath)) && (!cleanupOwner || !alive(cleanupOwner.pid)),
        "exact fixture Host exit",
      );
      const services = join(env.AREAL_HARNESS_SERVICE_HOME, "services");
      for (const name of await readdir(services).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      })) {
        const path = join(services, name, "service.json");
        if (!(await exists(path))) continue;
        const service = await json(path);
        if (
          service.workspace !== workspace ||
          service.owner?.hostId !== cleanupOwner?.hostId ||
          service.owner?.generation !== cleanupOwner?.generation
        )
          continue;
        await until(
          () => !alive(service.hostPid) && !alive(service.corePid),
          "exact fixture Core process exit",
        );
        report.cleanup.push({
          kind: "owned Core processes absent",
          hostPid: service.hostPid,
          corePid: service.corePid,
        });
      }
      hostStopped = true;
    } catch (error) {
      report.cleanupError ??= error.message;
      report.status = "failed";
      process.exitCode = 1;
    }
    report.hostStillAlive = cleanupOwner ? alive(cleanupOwner.pid) : await exists(descriptorPath);
    if (!hostStopped)
      report.cleanupRequired =
        "Inspect isolated Host original operations; UNKNOWN requests were retained, not replayed.";
    if (!app) await fixture.close();
    if (hostStopped && !app) {
      try {
        if (isMac)
          for (const account of [appName, `${appName} Key`])
            await cleanEntry(keychainService, account);
        for (const [directory, method] of [
          ["vault-operations", "vault.replace"],
          ["remote-operations", "remote.replace"],
        ]) {
          for (const name of await readdir(
            join(env.AREAL_HARNESS_SERVICE_HOME, "host", directory),
          ).catch((error) => {
            if (error.code === "ENOENT") return [];
            throw error;
          })) {
            const receipt = await json(
              join(env.AREAL_HARNESS_SERVICE_HOME, "host", directory, name),
            );
            assert.equal(name, `${receipt.requestId}.json`);
            if (
              directory === "remote-operations" &&
              receipt.method === "remote.gateway.control" &&
              receipt.ephemeral === true
            ) {
              assert.equal(receipt.entryId, undefined);
              continue;
            }
            assert.equal(receipt.method, method);
            assert.match(
              receipt.entryId,
              /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
            );
            if (isMac) await cleanEntry(hostService, receipt.entryId);
            else {
              const path = join(
                env.AREAL_HARNESS_SERVICE_HOME,
                "host/vault",
                `${receipt.entryId}.json`,
              );
              const stat = await lstat(path);
              assert.ok(stat.isFile() && stat.uid === process.getuid());
              assert.equal(stat.mode & 0o777, 0o600, "native Host file vault is private");
              await unlink(path);
              assert.equal(await exists(path), false);
              report.cleanup.push({ path, state: "removed", storage: "native file vault" });
            }
          }
        }
      } catch (error) {
        report.cleanupError ??= error.message;
        report.status = "failed";
        process.exitCode = 1;
      }
    }
    assert.equal(
      digest(await readFile(env.AREAL_CORE_BIN)),
      report.identity.binarySha256,
      "fixed Core binary remained unchanged",
    );
    await writeFile(join(scratch, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
}
