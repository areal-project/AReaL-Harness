'use strict';
const { app, safeStorage, dialog, Notification, powerSaveBlocker } = require('electron');
const childProcess = require('node:child_process');
const { mkdir, realpath, writeFile, rename, readFile, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { CoreBackend } = require('./backend.cjs');
const { DesktopService, PROTOCOL } = require('./service-protocol.cjs');
const { configureUserData, serviceHome, serviceOptions, serviceIdentity } = require('./service-config.cjs');
const { ServiceConnection } = require('./service-client.cjs');
const { createResourceRecovery } = require('./resource-recovery.cjs');
const { BackgroundNotifications } = require('./notifications.cjs');
const { SharedPowerMonitor } = require('./power.cjs');
const { RemoteControl } = require('./remote.cjs');
app.setName('AReaL Harness GUI');
const guiUserData = configureUserData(app);
let backend, service, descriptor, home, power;
let exiting = false;
async function finish() {
  if (exiting) return; exiting = true;
  power?.close();
  service?.close();
  if (descriptor) {
    try {
      const path = join(home, 'service.json');
      if (JSON.parse(await readFile(path, 'utf8')).token === descriptor.token) await rm(path);
    } catch (e) { if (e.code !== 'ENOENT') console.error('后台连接元数据清理失败'); }
  }
  app.exit(0);
}
async function start() {
  // Stopping an existing service needs only its private connection metadata,
  // not the binary or launch configuration used to start a replacement.
  const recover = process.argv.includes('--areal-core-service-recover');
  if (recover || process.argv.includes('--areal-core-service-stop')) {
    const connection = new ServiceConnection();
    try {
      const metadata = JSON.parse(await readFile(join(serviceHome(app), 'service.json'), 'utf8'));
      await connection.connect(metadata);
      if (recover) {
        // Recovery uses the existing v1 service's identity only for its narrow
        // resource API. The GUI still requires its own build identity to attach.
        await connection.request('hello', { protocol: PROTOCOL, identity: metadata.identity });
        await app.whenReady();
        await createResourceRecovery({
          backend: { resources: request => connection.request('resources', request, request.operation !== 'inspect') },
          notify: options => dialog.showMessageBox(options),
        })();
      }
      await connection.request('stopService', { protocol: PROTOCOL }, true);
    } finally { connection.close(); }
    app.exit(0); return;
  }
  const options = serviceOptions(app);
  await mkdir(options.home, { recursive: true, mode: 0o700 });
  home = options.home = await realpath(options.home);
  // Scope the OS-backed single-instance lock to the shared Core home, independent
  // of any GUI profile. Concurrent launchers converge on one writer.
  app.setPath('userData', join(home, '.service-user-data'));
  await mkdir(app.getPath('userData'), { recursive: true, mode: 0o700 });
  if (!app.requestSingleInstanceLock()) { app.exit(0); return; }
  // This process owns background work and notifications, never windows. Dock
  // hiding alone leaves a duplicate entry in macOS Force Quit Applications.
  // The separate recovery entry above remains able to show native dialogs.
  if (process.platform === 'darwin') app.setActivationPolicy('prohibited');
  await app.whenReady();
  backend = new CoreBackend({ ...options, encryption: safeStorage });
  await backend.init();
  const notifications = new BackgroundNotifications(Notification, () => {
    const env = { ...process.env, AREAL_BACKEND: 'areal', AREAL_CORE_HOME: home, AREAL_GUI_USER_DATA: guiUserData };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = childProcess.spawn(process.execPath, app.isPackaged ? [] : [app.getAppPath()], {
      detached: true, stdio: 'ignore', env, windowsHide: false,
    });
    child.once('error', error => console.warn(backend.providers.redact(`通知打开界面失败：${error.message}`)));
    child.unref();
  });
  power = new SharedPowerMonitor(backend, powerSaveBlocker);
  service = new DesktopService(backend, await serviceIdentity(options), () => { void finish(); }, notifications, power);
  service.remote = new RemoteControl(service, safeStorage);
  await service.remote.init();
  power.start();
  descriptor = await service.listen();
  const temporary = join(home, `service-${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify(descriptor), { mode: 0o600 });
  await rename(temporary, join(home, 'service.json'));
}
app.on('window-all-closed', () => {});
app.on('before-quit', event => { event.preventDefault(); });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  void (async () => { try { await backend?.disconnect(); } finally { await finish(); } })();
});
void start().catch(error => { console.error(backend?.providers.redact(error.message) ?? error.message); service?.close(); app.exit(1); });
