import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

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
let instance;
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
    await page.getByRole("alert").filter({ hasText: "网络发生变化，更新请求中断" }).waitFor();
    const retryButton = page.getByRole("button", { name: "重新检查更新", exact: true });
    await retryButton.waitFor();
    assert.ok(
      (await page.getByTestId("areal-update-status").getAttribute("title")).includes(
        "net::ERR_NETWORK_CHANGED",
      ),
    );
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
      await page.locator('[data-testid="areal-update-status"][title*="等待安装"]').waitFor();
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
  await page.getByTestId("areal-update-download").click();
  await page
    .getByRole("alert")
    .filter({ hasText: "无法启动更新下载，请重试。" })
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
  assert.equal(await page.getByTestId("areal-update-progress").getAttribute("value"), "12");
  assert.equal(
    await page.getByRole("alert").filter({ hasText: "无法启动更新下载，请重试。" }).count(),
    0,
  );
  await page.screenshot({ path: join(scratch, "download-progress.png") });
  checks.push(
    "real preload/IPC rejection is visible; retry clears error and shows Main download progress",
  );
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
      { nativePath, cache: join(scratch, "native-cache") },
    );
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
      "real public ZIP download, SHA-512 verification, Squirrel signed update staging and safe Core shutdown; final install intercepted",
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
      "Squirrel replaces only the isolated baseline copy with the expected public version after exit",
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
}
