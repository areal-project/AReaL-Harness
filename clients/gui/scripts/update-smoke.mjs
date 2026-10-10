import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// 真实 IPC 验证按钮反馈；可选的已签名旧包验证公开下载与原生安装准备。
const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = createRequire(join(gui, 'app/package.json'));
const { _electron: electron } = read('playwright-core');
const scratch = await mkdtemp('/private/tmp/areal-update-smoke-');
console.log('GUI evidence: ' + scratch);
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gui, encoding: 'utf8' }).trim();
const scriptSha256 = createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex');
const checks = [];
async function launch(executable, name) {
  const home = join(scratch, name); await mkdir(home); await mkdir(join(home, 'user'));
  const config = join(home, 'config.toml');
  await writeFile(config, 'schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:9/v1/chat/completions"\n');
  const env = { ...process.env, HOME: join(home, 'user'), AREAL_GUI_SMOKE: '1', AREAL_GUI_USER_DATA: join(home, 'electron'),
    AREAL_CORE_HOME: join(home, 'core'), AREAL_CORE_USER_HOME: join(home, 'user'),
    AREAL_HARNESS_HOME: join(home, 'runtime'), AREAL_CORE_CONFIG: config };
  for (const key of ['AREAL_CORE_WORKSPACE', 'AREAL_CORE_DESKTOP_CONFIG', 'AREAL_UPDATE_FEED_URL', 'ELECTRON_RUN_AS_NODE']) delete env[key];
  if (executable) delete env.AREAL_CORE_BIN;
  const app = await electron.launch({ executablePath: executable || read('electron'), args: executable ? [] : [join(gui, 'app')], env });
  const page = await app.firstWindow(); await page.waitForLoadState();
  await page.getByRole('button', { name: '设置', exact: true }).waitFor();
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  return { app, page };
}
async function close({ app, page }) {
  await page.evaluate(() => window.arealDesktop.command('stopService', {})).catch(() => {});
  await app.close();
}
let instance;
try {
  instance = await launch(process.env.AREAL_GUI_EXECUTABLE, 'feedback');
  const { app, page } = instance;
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    ipcMain.removeHandler('areal-core:update-download');
    ipcMain.handle('areal-core:update-download', () => { throw new Error('测试下载连接失败'); });
    BrowserWindow.getAllWindows()[0].webContents.send('areal-core:update-changed', { enabled: true, status: 'available', version: '9.9.9' });
  });
  await page.getByTestId('areal-update-download').click();
  await page.getByRole('alert').filter({ hasText: '无法启动更新下载，请重试。' }).waitFor({ timeout: 10000 });
  await page.screenshot({ path: join(scratch, 'download-error.png') });
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    ipcMain.removeHandler('areal-core:update-download');
    ipcMain.handle('areal-core:update-download', () => {
      const state = { enabled: true, status: 'downloading', version: '9.9.9', percent: 12 };
      BrowserWindow.getAllWindows()[0].webContents.send('areal-core:update-changed', state);
      return state;
    });
  });
  await page.getByTestId('areal-update-download').click();
  await page.getByTestId('areal-update-progress').waitFor();
  assert.equal(await page.getByTestId('areal-update-progress').getAttribute('value'), '12');
  assert.equal(await page.getByRole('alert').filter({ hasText: '无法启动更新下载，请重试。' }).count(), 0);
  await page.screenshot({ path: join(scratch, 'download-progress.png') });
  checks.push('real preload/IPC rejection is visible; retry clears error and shows Main download progress');
  await close(instance); instance = null;

  const baseline = process.env.AREAL_GUI_UPDATE_BASELINE;
  if (baseline) {
    assert.ok(process.env.AREAL_GUI_EXECUTABLE, 'Native smoke requires a candidate packaged app');
    const resources = resolve(dirname(process.env.AREAL_GUI_EXECUTABLE), '../Resources');
    const nativePath = join(resources, 'app-update.yml');
    const native = read('yaml').parse(await readFile(nativePath, 'utf8'));
    const { githubFeedUrl } = read('../app/src/update/config.cjs');
    assert.equal(native.provider, 'generic'); assert.equal(native.url, githubFeedUrl);
    assert.ok(typeof native.updaterCacheDirName === 'string' && native.updaterCacheDirName.length > 0);
    checks.push('candidate contains electron-builder native update configuration and stable cache name');
    const baselineApp = resolve(dirname(baseline), '../..');
    assert.ok(baselineApp.endsWith('.app'), 'Baseline executable must belong to an app bundle');
    const copiedApp = join(scratch, 'baseline.app');
    execFileSync('/usr/bin/ditto', [baselineApp, copiedApp]);
    const copiedExecutable = join(copiedApp, 'Contents/MacOS', baseline.split('/').at(-1));
    instance = await launch(copiedExecutable, 'native');
    const { app, page } = instance;
    await page.evaluate(() => { window.updateTrace = []; window.arealDesktop.onUpdate(state => window.updateTrace.push(state)); });
    await app.evaluate(({ app, Menu }, options) => {
      const read = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
      const { autoUpdater } = read(app.getAppPath() + '/node_modules/electron-updater');
      // 已发布旧包缺配置，借用候选包的真实配置验证原生传输，不修改任何签名资源。
      autoUpdater.updateConfigPath = options.nativePath;
      autoUpdater.autoRunAppAfterInstall = false;
      Object.defineProperty(autoUpdater.app, 'baseCachePath', { get: () => options.cache });
      // 验证原生准备和 Core 安全停止；不触发用户安装替换。
      autoUpdater.quitAndInstall = () => { globalThis.updateSmokeInstall = true; };
      Menu.getApplicationMenu().items[0].submenu.items.find(item => item.label === '检查更新…').click();
    }, { nativePath, cache: join(scratch, 'native-cache') });
    await page.getByTestId('areal-update-download').waitFor({ timeout: 30000 });
    await page.getByTestId('areal-update-download').click();
    await page.waitForFunction(() => window.updateTrace.some(state => state.status === 'installing' || state.status === 'error'), {}, { timeout: 240000 });
    const result = await app.evaluate(async ({ app }) => {
      const read = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
      const { autoUpdater } = read(app.getAppPath() + '/node_modules/electron-updater');
      // installing 通知先于异步 Core 关闭；以实际安装调用作为准备完成的证据。
      const deadline = Date.now() + 20000;
      while (!globalThis.updateSmokeInstall && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      return { nativeReady: autoUpdater.squirrelDownloadedUpdate, installPrepared: globalThis.updateSmokeInstall === true };
    });
    const trace = await page.evaluate(() => window.updateTrace);
    await writeFile(join(scratch, 'native-download.json'), JSON.stringify({ ...result, trace }, null, 2));
    assert.ok(!trace.some(state => state.status === 'error'), JSON.stringify(trace));
    assert.equal(result.nativeReady, true); assert.equal(result.installPrepared, true);
    assert.ok(trace.some(state => state.status === 'downloading' && state.percent > 0));
    assert.ok(trace.some(state => state.status === 'validating'));
    checks.push('real public ZIP download, SHA-512 verification, Squirrel signed update staging and safe Core shutdown; final install intercepted');
    const target = trace.find(state => state.status === 'available').version;
    // Squirrel 在退出时也可能安装已准备的更新，因此始终只启动复制出的旧包。
    await close(instance); instance = null;
    let installed;
    const deadline = Date.now() + 30000;
    do {
      installed = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', join(copiedApp, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
      if (installed === target) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.equal(installed, target);
    await writeFile(join(scratch, 'copy-replacement.json'), JSON.stringify({ target, installed, copiedApp }, null, 2));
    checks.push('Squirrel replaces only the isolated baseline copy with the expected public version after exit');
  }
  await writeFile(join(scratch, 'manifest.json'), JSON.stringify({ passed: true, checks, scratch, sourceRevision, scriptSha256 }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, scratch }));
} catch (error) {
  if (instance) await instance.page.screenshot({ path: join(scratch, 'failure.png') }).catch(() => {});
  await writeFile(join(scratch, 'manifest.json'), JSON.stringify({ passed: false, checks, scratch, sourceRevision, scriptSha256, error: error.stack }, null, 2));
  throw error;
} finally { if (instance) await close(instance); }
