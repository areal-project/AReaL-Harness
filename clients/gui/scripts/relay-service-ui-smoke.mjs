import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { closeSmokeApplication, assertApplicationStopped } from "./application-cleanup.mjs";
import { makeTempDir } from "./support/temp.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const gui = join(root, "clients/gui");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const { ServiceConnection } = require("../app/src/core/service-client.cjs");
const binary = resolve(process.env.AREAL_CORE_BIN || join(root, "target/debug/areal"));
const evidenceRoot = join(root, ".scratch/relay-service");
await mkdir(evidenceRoot, { recursive: true });
const evidence = await mkdtemp(join(evidenceRoot, "ui-"));
const state = await makeTempDir("av-");
const owner = randomUUID();
await writeFile(join(state, ".owner"), owner);
await writeFile(join(evidence, "run.json"), JSON.stringify({ evidence, state, owner }));
await mkdir(join(state, "user"));
await writeFile(join(state, "config.toml"), "schema_version=1\n");
await writeFile(join(state, "desktop.json"), JSON.stringify({ profiles: [] }));
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
Object.assign(env, {
  AREAL_GUI_USER_DATA: join(state, "electron"),
  AREAL_CORE_HOME: join(state, "core"),
  AREAL_CORE_USER_HOME: join(state, "user"),
  AREAL_HARNESS_HOME: join(state, "config-home"),
  AREAL_HARNESS_SERVICE_HOME: join(state, "registry"),
  AREAL_CORE_CONFIG: join(state, "config.toml"),
  AREAL_CORE_DESKTOP_CONFIG: join(state, "desktop.json"),
  AREAL_CORE_BIN: binary,
  NO_PROXY: "127.0.0.1,localhost,::1",
  no_proxy: "127.0.0.1,localhost,::1",
});
const sha = (b) => createHash("sha256").update(b).digest("hex");
const checks = [],
  screenshots = [],
  errors = [];
const manifest = {
  feature: "phone local Relay",
  started: new Date().toISOString(),
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  diffSHA256: sha(execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: root })),
  core: binary,
  coreSHA256: sha(await readFile(binary)),
  scope: "source Electron, real private Core and Relay; no SSH deployment or mobile client",
  evidence,
  checks,
  screenshots,
  errors,
};
let app, page, failure, cleanup, simulator, container, metadata;
const electronOutput = [];
const run = promisify(execFile);
const sim = async (...args) =>
  (
    await run("xcrun", ["simctl", ...args], { maxBuffer: 1024 * 1024, timeout: 120000 })
  ).stdout.trim();
const until = async (fn, label, timeout = 60000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw Error(`Timeout: ${label}`);
};
async function capture(name, action) {
  const path = join(evidence, `${name}.png`);
  await page.screenshot({ path, animations: "disabled" });
  await writeFile(join(evidence, `${name}.aria.txt`), await page.locator("body").ariaSnapshot());
  const style = await page.evaluate(() => ({
    viewport: { width: innerWidth, height: innerHeight },
    dpr: devicePixelRatio,
    font: getComputedStyle(document.body).font,
    theme: document.documentElement.className,
  }));
  screenshots.push({
    name,
    action,
    at: new Date().toISOString(),
    path,
    sha256: sha(await readFile(path)),
    ...style,
    rule: "R-EVIDENCE-003",
    reference: "implementation",
    observation: "visible state in source Electron",
    differences: "unknown; no reference comparison",
  });
}
try {
  app = await electron.launch({
    executablePath: require("electron"),
    args: [join(gui, "app")],
    env,
    timeout: 120000,
  });
  app.process().stdout?.on("data", (data) => electronOutput.push(String(data)));
  app.process().stderr?.on("data", (data) => electronOutput.push(String(data)));
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await page.waitForFunction(
    () => window.arealDesktop.snapshot().then((s) => s.connection?.state === "ready"),
    null,
    { timeout: 120000 },
  );
  const identity = await app.evaluate(({ app, BrowserWindow }) => {
    const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {
      pid: process.pid,
      userData: app.getPath("userData"),
      electron: process.versions.electron,
      sandbox: p.sandbox,
      contextIsolation: p.contextIsolation,
      nodeIntegration: p.nodeIntegration,
    };
  });
  assert.equal(identity.userData, env.AREAL_GUI_USER_DATA);
  assert.equal(identity.sandbox, true);
  assert.equal(identity.contextIsolation, true);
  assert.equal(identity.nodeIntegration, false);
  manifest.identity = identity;
  metadata = await until(
    () =>
      readFile(join(state, "core/service.json"), "utf8")
        .then(JSON.parse)
        .catch(() => null),
    "desktop service metadata",
  );
  assert.equal(metadata.applicationOwner.profile, env.AREAL_GUI_USER_DATA);
  process.kill(metadata.pid, 0);
  const service = new ServiceConnection();
  try {
    await service.connect(metadata);
    await service.request("hello", { protocol: metadata.protocol, identity: metadata.identity });
  } finally {
    service.close();
  }
  manifest.service = { pid: metadata.pid, applicationOwner: metadata.applicationOwner };
  const workspace = join(state, "workspace");
  await mkdir(workspace);
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
  await app.evaluate(({ BrowserWindow, dialog }, path) => {
    BrowserWindow.getAllWindows()[0].setSize(1440, 960);
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, workspace);
  await page.getByRole("button", { name: "不在项目中工作", exact: true }).click();
  await page.getByRole("menuitem", { name: "新建项目", exact: true }).click();
  await until(
    async () =>
      (await page.evaluate(() => window.arealDesktop.snapshot())).projects.some(
        (p) => p.root === workspace && p.state?.connected,
      ),
    "project connected",
  );
  checks.push("通过隔离目录选择器添加真实项目");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "手机连接", exact: true }).click();
  await capture("01-default", "打开设置与手机连接");
  assert.equal(await page.getByLabel("Relay HTTPS 来源", { exact: true }).isVisible(), false);
  assert.equal(await page.getByLabel("管理员一次性登记码", { exact: true }).isVisible(), false);
  checks.push("默认未展开外部 HTTPS 与登记码");
  await page
    .locator(".remote-status-card")
    .getByRole("button", { name: "开启内网连接", exact: true })
    .click();
  await page.getByText(/本机服务运行中/).waitFor({ timeout: 60000 });
  await page.getByText(/内网入口已就绪/).waitFor({ timeout: 60000 });
  const text = await page.getByText(/本机服务运行中/).innerText();
  const origin = text.match(/http:\/\/[^\s]+/)?.[0];
  assert.ok(origin);
  const health = await fetch(`${origin}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  manifest.origin = origin;
  checks.push("实际本机 Relay 健康检查成功，自动生成地址");
  await capture("02-running", "开启内网连接并等待 Relay 就绪");
  if (process.env.AREAL_UI_MOBILE_APP) {
    simulator = await sim(
      "create",
      `AReaL Relay acceptance ${Date.now()}`,
      "com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro",
      "com.apple.CoreSimulator.SimRuntime.iOS-17-5",
    );
    await sim("boot", simulator);
    await sim("bootstatus", simulator, "-b");
    await sim("install", simulator, process.env.AREAL_UI_MOBILE_APP);
    container = await sim("get_app_container", simulator, "com.example.arealharness", "data");
  }
  if (!(await page.getByRole("dialog").isVisible()))
    await page.getByRole("button", { name: "添加设备", exact: true }).click();
  await page.getByRole("img", { name: "手机配对二维码" }).waitFor();
  const invitation = await page.getByLabel("配对链接", { exact: true }).inputValue();
  const url = new URL(invitation);
  assert.equal(url.origin, origin);
  assert.equal(url.protocol, "http:");
  assert.equal(new URLSearchParams(url.hash.slice(1)).get("local"), "1");
  await page.waitForFunction(
    () => document.querySelector(".remote-invitation img")?.naturalWidth > 0,
  );
  assert.match(await page.getByRole("dialog").innerText(), /AReaL Remote App/);
  checks.push("真实邀请显示二维码且 HTTP 链接标记 local=1");
  await capture("03-invitation", "添加设备并显示邀请");
  if (process.env.AREAL_UI_MOBILE_APP) {
    const bundle = "com.example.arealharness";
    await run(
      "xcrun",
      [
        "simctl",
        "launch",
        "--terminate-running-process",
        `--stdout=${join(evidence, "ios-stdout.log")}`,
        `--stderr=${join(evidence, "ios-stderr.log")}`,
        simulator,
        bundle,
      ],
      {
        env: {
          ...process.env,
          SIMCTL_CHILD_AREAL_MOBILE_PRODUCT: JSON.stringify({ mode: "pair", link: invitation }),
        },
        timeout: 60000,
      },
    );
    const pending = await until(async () => {
      const result = await readFile(join(container, "Documents/product-result.json"), "utf8")
        .then(JSON.parse)
        .catch(() => null);
      if (result?.result?.status === "failure") {
        await writeFile(join(evidence, "ios-pair-result.json"), JSON.stringify(result, null, 2));
        await sim("io", simulator, "screenshot", join(evidence, "ios-failure.png"));
        throw new Error(`Native pairing failed: ${result.result.error}`);
      }
      return readFile(join(container, "Documents/product-pairing.json"), "utf8")
        .then(JSON.parse)
        .catch(() => null);
    }, "native pairing request");
    assert.ok(pending.peer);
    await page.getByRole("button", { name: "允许连接", exact: true }).waitFor({ timeout: 60000 });
    await page.getByRole("checkbox", { name: "workspace", exact: true }).check();
    await capture("05-review", "模拟器发送配对请求，桌面核对设备并选择隔离项目");
    await page.getByRole("button", { name: "允许连接", exact: true }).click();
    const result = await until(
      () =>
        readFile(join(container, "Documents/product-result.json"), "utf8")
          .then(JSON.parse)
          .catch(() => null),
      "native pairing result",
    );
    await writeFile(join(evidence, "ios-pair-result.json"), JSON.stringify(result, null, 2));
    assert.equal(result.result.status, "success");
    assert.equal(result.result.origin, "capacitor://localhost");
    assert.equal(result.result.state, "connected");
    await sim("io", simulator, "screenshot", join(evidence, "ios-connected.png"));
    checks.push("iOS 模拟器产品驱动经原生 Socket 配对，桌面人工路径授权并连接");
    manifest.mobile = {
      simulator,
      app: process.env.AREAL_UI_MOBILE_APP,
      mode: "product pair",
      image: join(evidence, "ios-connected.png"),
      imageSHA256: sha(await readFile(join(evidence, "ios-connected.png"))),
      capturedAt: new Date().toISOString(),
      viewport: "simulator screenshot pixels; see image",
      dpr: "unknown",
      font: "unknown",
      result: "ios-pair-result.json",
    };
  }
  await page.getByRole("button", { name: "关闭弹窗" }).click();
  await page.getByRole("button", { name: "停止本机 Relay", exact: true }).click();
  await page.getByRole("button", { name: "开启内网连接", exact: true }).first().waitFor();
  await assert.rejects(fetch(`${origin}/healthz`));
  checks.push("停止本机服务后健康检查连接失败");
  await page
    .locator(".remote-status-card")
    .getByRole("button", { name: "开启内网连接", exact: true })
    .click();
  await page.getByText(/内网入口已就绪/).waitFor({ timeout: 60000 });
  checks.push("重新启动后连接就绪");
  await page.locator("summary").filter({ hasText: "使用已有外部服务" }).click();
  await page.getByLabel("Relay HTTPS 来源", { exact: true }).waitFor();
  await page.getByLabel("管理员一次性登记码", { exact: true }).waitFor();
  checks.push("外部服务选项展开后显示 HTTPS 和一次性登记码");
  await page.locator("summary").filter({ hasText: "部署到 Linux 服务器" }).click();
  assert.equal(
    await page.getByRole("button", { name: "部署并连接", exact: true }).isDisabled(),
    true,
  );
  assert.equal(await page.getByLabel("SSH 端口", { exact: true }).inputValue(), "22");
  checks.push("SSH 表单空值禁用提交且默认端口为 22");
  await capture("04-options", "展开外部服务与 Linux 部署选项");
  await page.evaluate(() => {
    localStorage.setItem("areal-gui:theme", "soft-glass");
    localStorage.setItem("areal-gui:font-size", "18");
  });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 800));
  await page.reload();
  await page.getByTestId("areal-workbench").waitFor();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "手机连接", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.documentElement.classList.contains("theme-areal-light") &&
      getComputedStyle(document.documentElement).getPropertyValue("--ui-font-size").trim() ===
        "18px",
  );
  await capture("06-light-narrow-18", "切换浅色、900×800 和 18px UI 字号后打开手机设置");
  checks.push("浅色窄窗口与 18px 字号状态已截图");
} catch (e) {
  failure = e.stack || String(e);
  console.error(failure);
  if (page) {
    await capture("failure", "运行失败时状态").catch(() => {});
  }
} finally {
  if (simulator) {
    try {
      await sim("shutdown", simulator);
      await sim("delete", simulator);
      manifest.simulatorCleanup = "shutdown and deleted";
    } catch (e) {
      errors.push(`simulator cleanup: ${e.stack}`);
    }
  }
  if (app) {
    try {
      await app.evaluate(({ dialog, Menu }) => {
        dialog.showMessageBox = async () => ({ response: 1 });
        const quit = Menu.getApplicationMenu().items[0].submenu.items.find(
          (item) => item.label === "退出 AReaL Harness",
        );
        if (!quit) throw Error("quit menu missing");
        quit.click();
      });
      await closeSmokeApplication({ process: () => app.process(), close: () => app.close() });
    } catch (e) {
      errors.push(`quit: ${e.stack}`);
    }
  }
  try {
    const serviceLog = await readFile(join(state, "core/service.log"), "utf8").catch(() => "");
    await writeFile(join(evidence, "service.log"), serviceLog);
    assert.equal(await readFile(join(state, ".owner"), "utf8"), owner);
    assert.ok(metadata || !app, "Missing service identity; retaining state");
    if (metadata) await assertApplicationStopped(binary, env, metadata);
    assert.equal(sha(await readFile(binary)), manifest.coreSHA256);
    await rm(state, { recursive: true });
    cleanup = { adapterExited: true, coreStopped: true, stateRemoved: true };
  } catch (error) {
    cleanup = { stateRetained: state, error: String(error) };
    errors.push(`cleanup: ${error.stack}`);
  }
  await writeFile(join(evidence, "electron-output.log"), electronOutput.join(""));
  manifest.finished = new Date().toISOString();
  manifest.failure = failure;
  manifest.cleanup = cleanup;
  manifest.passed = !failure && errors.length === 0;
  await writeFile(join(evidence, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ passed: manifest.passed, evidence, checks, failure, errors }));
  if (!manifest.passed) process.exitCode = 1;
}
