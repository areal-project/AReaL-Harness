import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";

// 真实 IPC 验证按钮反馈；可选的已签名旧包验证公开下载与原生安装准备。
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = read("playwright-core");
const scratch = await makeTempDir("areal-update-smoke-");
console.log("GUI evidence: " + scratch);
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: gui,
  encoding: "utf8",
}).trim();
const scriptSha256 = createHash("sha256")
  .update(await readFile(fileURLToPath(import.meta.url)))
  .digest("hex");
const checks = [];
async function launch(executable, name, reopen = false) {
  const home = join(scratch, name);
  await mkdir(home, { recursive: reopen });
  await mkdir(join(home, "user"), { recursive: reopen });
  const config = join(home, "config.toml");
  if (!reopen)
    await writeFile(
      config,
      'schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:9/v1/chat/completions"\n',
    );
  const env = {
    ...process.env,
    HOME: join(home, "user"),
    AREAL_GUI_SMOKE: "1",
    AREAL_GUI_USER_DATA: join(home, "electron"),
    AREAL_CORE_HOME: join(home, "core"),
    AREAL_HARNESS_SERVICE_HOME: join(home, "registry"),
    AREAL_CORE_USER_HOME: join(home, "user"),
    AREAL_HARNESS_HOME: join(home, "runtime"),
    AREAL_CORE_CONFIG: config,
  };
  for (const key of [
    "AREAL_CORE_WORKSPACE",
    "AREAL_CORE_DESKTOP_CONFIG",
    "AREAL_UPDATE_FEED_URL",
    "ELECTRON_RUN_AS_NODE",
  ])
    delete env[key];
  if (executable) delete env.AREAL_CORE_BIN;
  const app = await electron.launch({
    executablePath: executable || read("electron"),
    args: executable ? [] : [join(gui, "app")],
    env,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState();
  await page.getByRole("button", { name: "设置", exact: true }).waitFor();
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 });
  });
  return { app, page };
}
async function close({ app, page }) {
  await page.evaluate(() => window.arealDesktop.command("stopService", {})).catch(() => {});
  await app.close();
}
async function openUpdate(page) {
  const trigger = page.locator('[data-testid="areal-update-trigger"]:visible');
  await trigger.waitFor();
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
}
let instance;
let candidateServer;
try {
  instance = await launch(process.env.AREAL_GUI_EXECUTABLE, "feedback");
  const { app, page } = instance;
  for (const targetVersion of ["0.1.12", "0.1.11"]) {
    await app.evaluate(async ({ app, ipcMain, BrowserWindow }, targetVersion) => {
      const read = process
        .getBuiltinModule("module")
        .createRequire(app.getAppPath() + "/package.json");
      const { EventEmitter } = read("node:events");
      const { createUpdater } = read(app.getAppPath() + "/src/update/controller.cjs");
      const { githubFeedUrl } = read(app.getAppPath() + "/src/update/config.cjs");
      const probe = { failCheck: true, checks: 0, downloads: 0, recoveries: 0 };
      const updater = new EventEmitter();
      updater.setFeedURL = () => {};
      updater.checkForUpdates = async () => {
        probe.checks++;
        if (probe.failCheck) throw new Error("net::ERR_NETWORK_CHANGED");
        return {
          updateInfo: {
            version: targetVersion,
            files: [
              {
                url: `https://github.com/areal-project/AReaL-Harness/releases/download/gui-v${targetVersion}/AReaLHarness-${targetVersion}-macos-arm64.zip`,
                size: 123,
                sha512: Buffer.alloc(64).toString("base64"),
              },
            ],
          },
        };
      };
      updater.downloadUpdate = async () => {
        probe.downloads++;
      };
      updater.quitAndInstall = () => {
        throw new Error("unexpected install");
      };
      const controller = createUpdater({
        updater,
        config: { feedUrl: githubFeedUrl },
        version: "0.1.11",
        platform: "darwin",
        arch: "arm64",
        onState: (state) =>
          BrowserWindow.getAllWindows()[0].webContents.send("areal-core:update-changed", state),
        hasWork: async () => true,
        prepareNativeInstall: async () => {},
        prepareInstall: async () => {
          throw new Error("unexpected Core shutdown");
        },
        log: { warn() {} },
      });
      globalThis.updateRetrySmoke = probe;
      ipcMain.removeHandler("areal-core:update-download");
      ipcMain.handle("areal-core:update-download", () => {
        void controller.download();
        return controller.state();
      });
      ipcMain.removeHandler("areal-core:update-recover-resources");
      ipcMain.handle("areal-core:update-recover-resources", () => {
        probe.recoveries++;
        return controller.state();
      });
      await controller.check();
    }, targetVersion);
    await openUpdate(page);
    await page.getByRole("alert").filter({ hasText: "网络发生变化，更新请求中断" }).waitFor();
    const retryButton = page.getByRole("button", { name: "重新检查更新", exact: true });
    await retryButton.waitFor();
    await page.screenshot({ path: join(scratch, `check-error-${targetVersion}.png`) });
    await app.evaluate(() => {
      globalThis.updateRetrySmoke.failCheck = false;
    });
    await retryButton.click();
    if (targetVersion === "0.1.12") {
      await page.getByRole("button", { name: "下载更新 0.1.12", exact: true }).waitFor();
    } else {
      await page.getByTestId("areal-update-status").waitFor({ state: "hidden" });
    }
    assert.equal(
      await page.getByRole("alert").filter({ hasText: "网络发生变化，更新请求中断" }).count(),
      0,
    );
    assert.deepEqual(
      await app.evaluate(() => ({
        checks: globalThis.updateRetrySmoke.checks,
        downloads: globalThis.updateRetrySmoke.downloads,
      })),
      { checks: 2, downloads: 0 },
    );
    await page.screenshot({ path: join(scratch, `check-recovered-${targetVersion}.png`) });
    if (targetVersion === "0.1.12") {
      await page.getByRole("button", { name: "下载更新 0.1.12", exact: true }).click();
      await page.locator('[data-testid="areal-update-status"][data-state="deferred"]').waitFor();
      assert.equal(await app.evaluate(() => globalThis.updateRetrySmoke.downloads), 1);
      assert.equal(await app.evaluate(() => globalThis.updateRetrySmoke.recoveries), 0);
      await page.getByRole("button", { name: "检查后台资源并继续安装更新", exact: true }).click();
      assert.deepEqual(
        await app.evaluate(() => ({
          downloads: globalThis.updateRetrySmoke.downloads,
          recoveries: globalThis.updateRetrySmoke.recoveries,
        })),
        { downloads: 1, recoveries: 1 },
      );
      await page.screenshot({ path: join(scratch, "deferred-update-action.png") });
    }
  }
  checks.push(
    "real update controller through preload/IPC: network-change check failure retries; new offer needs a second click to download; current version clears the error",
    "fast download completion keeps the newer deferred event over its stale downloading reply and exposes explicit recovery without re-downloading or automatically requesting recovery",
  );
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    ipcMain.removeHandler("areal-core:update-download");
    ipcMain.handle("areal-core:update-download", () => {
      throw new Error("测试下载连接失败");
    });
    BrowserWindow.getAllWindows()[0].webContents.send("areal-core:update-changed", {
      enabled: true,
      status: "available",
      version: "9.9.9",
    });
  });
  await openUpdate(page);
  await page.getByTestId("areal-update-download").click();
  await page
    .getByRole("alert")
    .filter({ hasText: "无法启动更新，请重试。" })
    .waitFor({ timeout: 10000 });
  await page.screenshot({ path: join(scratch, "download-error.png") });
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    ipcMain.removeHandler("areal-core:update-download");
    ipcMain.handle("areal-core:update-download", () => {
      const state = { enabled: true, status: "downloading", version: "9.9.9", percent: 12 };
      BrowserWindow.getAllWindows()[0].webContents.send("areal-core:update-changed", state);
      return state;
    });
  });
  await page.getByTestId("areal-update-download").click();
  await page.getByTestId("areal-update-progress").waitFor();
  assert.equal(await page.getByTestId("areal-update-progress").getAttribute("aria-valuenow"), "12");
  assert.equal(
    await page.getByRole("alert").filter({ hasText: "无法启动更新，请重试。" }).count(),
    0,
  );
  await page.screenshot({ path: join(scratch, "download-progress.png") });
  checks.push(
    "real preload/IPC rejection is visible; retry clears error and shows Main download progress",
  );
  const previews = [
    { id: "available", status: "available" },
    { id: "downloading", status: "downloading", percent: 42 },
    { id: "indeterminate", status: "downloading", percent: null },
    { id: "validating", status: "validating", downloaded: "0.1.16", installing: true },
    {
      id: "deferred",
      status: "deferred",
      downloaded: "0.1.16",
      detail: "还有活动任务，空闲后将自动重启安装。",
    },
    { id: "installing", status: "installing", downloaded: "0.1.16", installing: true },
    { id: "error", status: "error", detail: "下载连接中断，请重试。" },
    {
      id: "install-error",
      status: "error",
      downloaded: "0.1.16",
      detail: "后台已安全停止，安装准备结果待核对。",
    },
  ];
  const visualChecks = [];
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 860));
  for (const theme of ["dark", "light"]) {
    const nextTheme = await page.evaluate(
      (theme) => window.arealDesktop.theme(theme === "dark" ? "data-dense" : "soft-glass"),
      theme,
    );
    await app.evaluate(({ BrowserWindow }, theme) => {
      BrowserWindow.getAllWindows()[0].webContents.send("areal-core:theme-changed", theme);
    }, nextTheme);
    await page.waitForFunction(
      (dark) => document.documentElement.classList.contains("dark") === dark,
      theme === "dark",
    );
    for (const preview of previews.filter(
      (preview) =>
        theme === "dark" || ["available", "downloading", "deferred", "error"].includes(preview.id),
    )) {
      await app.evaluate(({ BrowserWindow }, preview) => {
        BrowserWindow.getAllWindows()[0].webContents.send("areal-core:update-changed", {
          enabled: true,
          version: "0.1.16",
          ...preview,
        });
      }, preview);
      await page
        .locator(`[data-testid="areal-update-status"][data-state="${preview.status}"]`)
        .waitFor();
      await openUpdate(page);
      await page.waitForFunction(() => {
        const panel = document.querySelector('[data-slot="popover-content"]');
        if (!panel) return false;
        const bounds = panel.getBoundingClientRect();
        return (
          bounds.width > 0 &&
          bounds.x >= 0 &&
          bounds.y >= 0 &&
          bounds.right <= innerWidth + 1 &&
          bounds.bottom <= innerHeight + 1
        );
      });
      const panel = page.locator('[data-slot="popover-content"]:visible');
      await panel.waitFor();
      const bounds = await panel.boundingBox();
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      assert.ok(
        bounds &&
          bounds.x >= 0 &&
          bounds.y >= 0 &&
          bounds.x + bounds.width <= viewport.width + 1 &&
          bounds.y + bounds.height <= viewport.height + 1,
        "Update popup must stay inside the window",
      );
      if (preview.id === "install-error")
        assert.equal(
          await panel.getByRole("button").count(),
          0,
          "Unconfirmed installation must not offer replay",
        );
      await page.screenshot({
        path: join(scratch, `update-${theme}-${preview.id}.png`),
        animations: "disabled",
      });
      await panel.screenshot({
        path: join(scratch, `panel-${theme}-${preview.id}.png`),
        animations: "disabled",
      });
      visualChecks.push({ theme, state: preview.id, bounds, viewport });
    }
  }
  await page.keyboard.press("Escape");
  await page.locator('[data-slot="popover-content"]:visible').waitFor({ state: "hidden" });
  assert.equal(
    await page
      .locator('[data-testid="areal-update-trigger"]:visible')
      .evaluate((node) => node === document.activeElement),
    true,
  );
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 700));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => document.documentElement.style.setProperty("--ui-font-size", "18px"));
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send("areal-core:update-changed", {
      enabled: true,
      status: "downloading",
      version: "0.1.16",
      percent: null,
    }),
  );
  await openUpdate(page);
  await page.waitForFunction(() => document.documentElement.dataset.reducedMotion === "true");
  assert.equal(
    await page
      .locator(".areal-update-ring:visible")
      .evaluate((node) => getComputedStyle(node).animationName),
    "none",
  );
  await page.screenshot({
    path: join(scratch, "update-narrow-reduced-motion.png"),
    animations: "disabled",
  });
  const panel = page.locator('[data-slot="popover-content"]:visible');
  const narrowBounds = await panel.boundingBox();
  const narrowViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.deepEqual(narrowViewport, { width: 980, height: 700 });
  assert.ok(
    narrowBounds &&
      narrowBounds.x >= 0 &&
      narrowBounds.y >= 0 &&
      narrowBounds.x + narrowBounds.width <= narrowViewport.width + 1,
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send("areal-core:update-changed", {
      enabled: true,
      status: "error",
      version: "0.1.16",
      detail: "无法连接到更新服务。请检查网络后重试。错误：net::ERR_CONNECTION_RESET。",
    }),
  );
  await panel.getByRole("alert").waitFor();
  assert.equal(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
  await page.screenshot({ path: join(scratch, "update-narrow-error.png"), animations: "disabled" });
  await writeFile(
    join(scratch, "visual-checks.json"),
    JSON.stringify(
      {
        syntheticUpdater: true,
        visualChecks,
        narrowBounds,
        narrowViewport,
        reducedMotion: "passed",
        keyboardDismissal: "passed",
      },
      null,
      2,
    ),
  );
  checks.push(
    "update state panels fit dark/light and supported minimum 980x700 window at 18px; reduced motion stops indeterminate rotation; Escape restores trigger focus; unconfirmed installation offers no replay",
  );
  await page.evaluate(() => {
    const key = "areal-gui:application-preferences";
    const newValue = JSON.stringify({
      ...JSON.parse(localStorage.getItem(key) ?? "{}"),
      locale: "en",
    });
    localStorage.setItem(key, newValue);
    window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
  });
  await page.waitForFunction(() => document.documentElement.lang === "en");
  await panel.getByRole("button", { name: /Retry/ }).waitFor();
  await page.screenshot({
    path: join(scratch, "update-narrow-english.png"),
    animations: "disabled",
  });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1952, 1272));
  await page.evaluate(() => document.documentElement.style.removeProperty("--ui-font-size"));
  await page.screenshot({ path: join(scratch, "update-user-1952.png"), animations: "disabled" });
  checks.push("English update copy renders at narrow and user screenshot window sizes");
  await close(instance);
  instance = null;

  const baseline = process.env.AREAL_GUI_UPDATE_BASELINE;
  if (baseline) {
    assert.ok(process.env.AREAL_GUI_EXECUTABLE, "Native smoke requires a candidate packaged app");
    const resources = resolve(dirname(process.env.AREAL_GUI_EXECUTABLE), "../Resources");
    const nativePath = join(resources, "app-update.yml");
    const native = read("yaml").parse(await readFile(nativePath, "utf8"));
    const { githubFeedUrl } = read("../app/src/update/config.cjs");
    assert.equal(native.provider, "generic");
    assert.equal(native.url, githubFeedUrl);
    assert.ok(
      typeof native.updaterCacheDirName === "string" && native.updaterCacheDirName.length > 0,
    );
    checks.push(
      "candidate contains electron-builder native update configuration and stable cache name",
    );
    const baselineApp = resolve(dirname(baseline), "../..");
    assert.ok(baselineApp.endsWith(".app"), "Baseline executable must belong to an app bundle");
    const appVersion = (path) =>
      execFileSync(
        "/usr/bin/plutil",
        ["-extract", "CFBundleShortVersionString", "raw", join(path, "Contents/Info.plist")],
        { encoding: "utf8" },
      ).trim();
    const expectedVersion = appVersion(resolve(dirname(process.env.AREAL_GUI_EXECUTABLE), "../.."));
    const { newer } = read("../app/src/update/config.cjs");
    assert.equal(
      newer(expectedVersion, appVersion(baselineApp)),
      true,
      "Use a lower formal baseline and a higher formal candidate",
    );
    const candidateAssets = process.env.AREAL_GUI_UPDATE_ASSETS;
    const transportRequests = [];
    let candidatePort;
    if (candidateAssets) {
      const manifest = await readFile(join(candidateAssets, "latest-mac.yml"));
      const info = read("yaml").parse(manifest.toString());
      read("../app/src/update/config.cjs").validateUpdate(info, githubFeedUrl, {
        engine: "electron",
      });
      assert.equal(info.version, expectedVersion);
      const archive = join(candidateAssets, `AReaLHarness-${expectedVersion}-macos-arm64.zip`);
      const bytes = await readFile(archive);
      assert.equal(bytes.length, info.files[0].size);
      assert.equal(createHash("sha512").update(bytes).digest("base64"), info.files[0].sha512);
      candidateServer = createServer((request, response) => {
        const path = new URL(request.url, "http://127.0.0.1").pathname;
        transportRequests.push(path);
        if (path === "/latest-mac.yml") {
          response.writeHead(200, { "Content-Length": manifest.length });
          response.end(manifest);
          return;
        }
        if (path === "/candidate.zip") {
          response.writeHead(200, {
            "Content-Type": "application/zip",
            "Content-Length": bytes.length,
          });
          createReadStream(archive).pipe(response);
          return;
        }
        response.writeHead(404);
        response.end();
      });
      await new Promise((resolve) => candidateServer.listen(0, "127.0.0.1", resolve));
      candidatePort = candidateServer.address().port;
    }
    const copiedApp = join(scratch, "baseline.app");
    execFileSync("/usr/bin/ditto", [baselineApp, copiedApp]);
    const copiedExecutable = join(copiedApp, "Contents/MacOS", baseline.split("/").at(-1));
    instance = await launch(copiedExecutable, "native");
    const { app, page } = instance;
    const configBefore = await readFile(join(scratch, "native/config.toml"));
    await page.evaluate(() => {
      window.updateTrace = [];
      window.arealDesktop.onUpdate((state) => window.updateTrace.push(state));
    });
    await app.evaluate(
      ({ app, Menu }, options) => {
        const read = process
          .getBuiltinModule("module")
          .createRequire(app.getAppPath() + "/package.json");
        const { autoUpdater } = read(app.getAppPath() + "/node_modules/electron-updater");
        // 已发布旧包缺配置，借用候选包的真实配置验证原生传输，不修改任何签名资源。
        autoUpdater.updateConfigPath = options.nativePath;
        if (options.candidatePort) {
          const executor = autoUpdater.httpExecutor;
          const createRequest = executor.createRequest.bind(executor);
          // 仅替换隔离测试的传输端点，保留正式清单、摘要与原生签名验证。
          executor.createRequest = (request, callback) => {
            const url = new URL(request.path, `${request.protocol}//${request.hostname}`);
            const localPath =
              url.href.split("?")[0] === options.feedUrl + "latest-mac.yml"
                ? "/latest-mac.yml"
                : url.href === options.assetUrl
                  ? "/candidate.zip"
                  : null;
            if (!localPath) return createRequest(request, callback);
            return createRequest(
              {
                ...request,
                protocol: "http:",
                hostname: "127.0.0.1",
                host: "127.0.0.1",
                port: options.candidatePort,
                path: localPath,
              },
              callback,
            );
          };
        }
        autoUpdater.autoRunAppAfterInstall = false;
        Object.defineProperty(autoUpdater.app, "baseCachePath", { get: () => options.cache });
        // 验证原生准备和 Core 安全停止；不触发用户安装替换。
        autoUpdater.quitAndInstall = () => {
          globalThis.updateSmokeInstall = true;
        };
        Menu.getApplicationMenu()
          .items[0].submenu.items.find((item) => item.label === "检查更新…")
          .click();
      },
      {
        nativePath,
        cache: join(scratch, "native-cache"),
        candidatePort,
        feedUrl: githubFeedUrl,
        assetUrl: `https://github.com/areal-project/AReaL-Harness/releases/download/gui-v${expectedVersion}/AReaLHarness-${expectedVersion}-macos-arm64.zip`,
      },
    );
    await page.getByTestId("areal-update-status").waitFor({ timeout: 30000 });
    // 旧版签名基线仍使用直接下载按钮，新版候选使用状态浮层。
    if (await page.getByTestId("areal-update-trigger").count()) await openUpdate(page);
    await page.getByTestId("areal-update-download").waitFor({ timeout: 30000 });
    assert.equal(
      (await page.evaluate(() => window.arealDesktop.updateState())).version,
      expectedVersion,
      "The public feed must offer the selected candidate before download",
    );
    await page.getByTestId("areal-update-download").click();
    await page.waitForFunction(
      () =>
        window.updateTrace.some(
          (state) => state.status === "installing" || state.status === "error",
        ),
      {},
      { timeout: 240000 },
    );
    const result = await app.evaluate(async ({ app }) => {
      const read = process
        .getBuiltinModule("module")
        .createRequire(app.getAppPath() + "/package.json");
      const { autoUpdater } = read(app.getAppPath() + "/node_modules/electron-updater");
      // installing 通知先于异步 Core 关闭；以实际安装调用作为准备完成的证据。
      const deadline = Date.now() + 20000;
      while (!globalThis.updateSmokeInstall && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        nativeReady: autoUpdater.squirrelDownloadedUpdate,
        installPrepared: globalThis.updateSmokeInstall === true,
      };
    });
    const trace = await page.evaluate(() => window.updateTrace);
    await writeFile(
      join(scratch, "native-download.json"),
      JSON.stringify({ ...result, trace }, null, 2),
    );
    assert.ok(!trace.some((state) => state.status === "error"), JSON.stringify(trace));
    assert.equal(result.nativeReady, true);
    assert.equal(result.installPrepared, true);
    assert.ok(trace.some((state) => state.status === "downloading" && state.percent > 0));
    assert.ok(trace.some((state) => state.status === "validating"));
    checks.push(
      `${candidateAssets ? "local candidate" : "public"} ZIP download, SHA-512 verification, Squirrel signed update staging and safe Core shutdown; final install intercepted`,
    );
    await writeFile(
      join(scratch, "update-transport.json"),
      JSON.stringify(
        {
          transport: candidateAssets ? "local-candidate" : "public-github",
          requests: transportRequests,
          version: expectedVersion,
        },
        null,
        2,
      ),
    );
    const target = trace.find((state) => state.status === "available").version;
    assert.equal(
      target,
      expectedVersion,
      "The public feed must offer the selected candidate version",
    );
    // Squirrel 在退出时也可能安装已准备的更新，因此始终只启动复制出的旧包。
    await close(instance);
    instance = null;
    let installed;
    const deadline = Date.now() + 30000;
    do {
      installed = execFileSync(
        "/usr/bin/plutil",
        ["-extract", "CFBundleShortVersionString", "raw", join(copiedApp, "Contents/Info.plist")],
        { encoding: "utf8" },
      ).trim();
      if (installed === target) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.equal(installed, target);
    await writeFile(
      join(scratch, "copy-replacement.json"),
      JSON.stringify({ target, installed, copiedApp }, null, 2),
    );
    checks.push(
      "Squirrel replaces only the isolated baseline copy with the expected candidate version after exit",
    );
    instance = await launch(copiedExecutable, "native", true);
    assert.equal(await instance.app.evaluate(({ app }) => app.getVersion()), target);
    assert.deepEqual(await readFile(join(scratch, "native/config.toml")), configBefore);
    await instance.page.screenshot({ path: join(scratch, "reopened.png") });
    await close(instance);
    instance = null;
    checks.push(
      "replaced isolated app reopens at the selected version with unchanged synthetic model configuration; no credential or history migration claim",
    );
  }
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify({ passed: true, checks, scratch, sourceRevision, scriptSha256 }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, checks, scratch }));
} catch (error) {
  if (instance)
    await instance.page.screenshot({ path: join(scratch, "failure.png") }).catch(() => {});
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      { passed: false, checks, scratch, sourceRevision, scriptSha256, error: error.stack },
      null,
      2,
    ),
  );
  throw error;
} finally {
  if (instance) await close(instance);
  if (candidateServer) await new Promise((resolve) => candidateServer.close(resolve));
}
