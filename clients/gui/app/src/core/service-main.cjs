'use strict';
const { startupTrace } = require('./startup-timing.cjs');
const startupTraceService = startupTrace('service.startup', { servicePid: process.pid });
startupTraceService.advance('imports');
const { app, safeStorage, dialog, Notification, powerSaveBlocker, crashReporter } = require('electron');
const diagnostics = require('./diagnostics.cjs');
const childProcess = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { mkdir, realpath, writeFile, rename, readFile, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { CoreBackend } = require('./backend.cjs');
const { DesktopService, PROTOCOL } = require('./service-protocol.cjs');
const { configureUserData, serviceHome, serviceOptions, serviceIdentity } = require('./service-config.cjs');
const { ServiceConnection, waitForServiceProcessExit } = require('./service-client.cjs');
const { createResourceRecovery } = require('./resource-recovery.cjs');
const { BackgroundNotifications } = require('./notifications.cjs');
const { SharedPowerMonitor } = require('./power.cjs');
const { resolveDesktopNetwork } = require('./desktop-network.cjs');
const { readLibraryStartupSettings } = require('./library.cjs');
const { proxyRelay } = require('./proxy-relay.cjs');
const { RemoteControl } = require('./remote.cjs');
const { desktopExecutables } = require('./desktop-executables.cjs');
app.setName('AReaL Harness GUI');
const guiUserData = configureUserData(app);
let backend, service, descriptor, home, power;
const FINALIZATION_TIMEOUT_MS = 5000;
let finalization, finalizationTimer, exited = false;
let applicationLifetime;
const { parseOwner, watchApplicationLifetime, scrubOwnerEnvironment } = require('./application-owner.cjs');

function exitProcess(exitCode) {
  if (exited) return;
  exited = true;
  clearTimeout(finalizationTimer);
  try {
    for (const entry of backend?.ownedEngines?.values() ?? []) {
      for (const lifetime of entry.lifetimes ?? []) {
        try { lifetime.destroy(); } catch { exitCode = 1; }
      }
    }
  } finally {
    try { applicationLifetime?.destroy(); } catch { exitCode = 1; }
    try { diagnostics.record({ type: 'exit-requested', exitCode }); }
    finally { app.exit(exitCode); }
  }
}
function finish(cause) {
  if (finalization || exited) return finalization;
  let stage = 'disconnect';
  finalizationTimer = setTimeout(() => {
    try { diagnostics.record({ type: 'desktop-exit-timeout', cause, stage }); }
    finally { exitProcess(1); }
  }, FINALIZATION_TIMEOUT_MS);
  finalization = Promise.resolve().then(async () => {
    power?.close();
    service?.close();
    await backend?.disconnect();
    stage = 'metadata';
    if (descriptor) {
      try {
        const path = join(home, 'service.json');
        if (JSON.parse(await readFile(path, 'utf8')).token === descriptor.token) await rm(path);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    exitProcess(0);
  }).catch(() => { exitProcess(1); });
  return finalization;
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
      let packet = await connection.request('hello', { protocol: PROTOCOL, identity: metadata.identity });
      if (packet.service.lifecycle?.version !== 2 || packet.service.lifecycle.capabilities?.request !== true)
        throw Object.assign(new Error('原 Desktop 不支持持久生命周期操作，请使用其支持的安全管理入口'), { code: 'LIFECYCLE_UNSUPPORTED' });
      if (recover) {
        await app.whenReady();
        await createResourceRecovery({
          backend: { resources: request => connection.request('resources', request, request.operation !== 'inspect') },
          notify: options => dialog.showMessageBox(options),
        })();
        packet = await connection.request('snapshot');
      }
      const receipt = await connection.request('lifecycleRequest', { protocol: PROTOCOL, requestId: randomUUID(), kind: 'stopDesktop', mode: 'ifIdle',
        expectedDesktopGeneration: packet.service.lifecycle.desktopGeneration, expectedTargets: packet.service.targets }, true);
      if (receipt.desktopExit !== 'requested') throw Object.assign(new Error('后台停止尚未完成，请检查原生命周期请求'), { lifecycle: receipt });
      await waitForServiceProcessExit(serviceHome(app), metadata);
    } finally { connection.close(); }
    startupTraceService.finish('skipped');
    app.exit(0); return;
  }
  parseOwner(process.env.AREAL_GUI_OWNER);
  applicationLifetime = watchApplicationLifetime(() => {
    try { diagnostics.record({ type: 'application-owner-lost' }); }
    finally { exitProcess(1); }
  });
  startupTraceService.advance('prepare_home');
  const options = serviceOptions(app);
  await mkdir(options.home, { recursive: true, mode: 0o700 });
  home = options.home = await realpath(options.home);
  // Scope the OS-backed single-instance lock to the shared Core home, independent
  // of any GUI profile. Concurrent launchers converge on one writer.
  app.setPath('userData', join(home, '.service-user-data'));
  await mkdir(app.getPath('userData'), { recursive: true, mode: 0o700 });
  if (!app.requestSingleInstanceLock()) { startupTraceService.finish('skipped'); app.exit(0); return; }
  diagnostics.start({ role: 'desktop', root: join(home, 'diagnostics', 'desktop'), appRunId: parseOwner(process.env.AREAL_GUI_OWNER)?.appRunId, version: app.getVersion() });
  diagnostics.startCrashReporter({ app, crashReporter });
  app.on('child-process-gone', (_event, details) => diagnostics.record({ type: 'child-process-gone', processType: details.type, reason: details.reason, exitCode: details.exitCode }));
  // This process owns background work and notifications, never windows. Dock
  // hiding alone leaves a duplicate entry in macOS Force Quit Applications.
  // The separate recovery entry above remains able to show native dialogs.
  if (process.platform === 'darwin') app.setActivationPolicy('prohibited');
  startupTraceService.advance('app_ready');
  await app.whenReady();
  startupTraceService.advance('proxy_discovery');
  const network = await resolveDesktopNetwork(readLibraryStartupSettings(home), process.env, { caBundleDirectory: join(home, 'network-ca') });
  backend = new CoreBackend({ ...options, proxyEnvironment: network, encryption: safeStorage });
  startupTraceService.advance('proxy_relay');
  let ports;
  try { ports = JSON.parse(await readFile(join(home, 'proxy-relays.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  backend.proxyRelay = await proxyRelay(backend.proxyEnvironment, { ports, save: ports => backend.save('proxy-relays.json', ports) });
  backend.proxyEnvironment = backend.proxyRelay.environment;
  startupTraceService.advance('backend_init');
  await backend.init();
  startupTraceService.advance('service_identity');
  const notifications = new BackgroundNotifications(Notification, () => {
    const env = { ...scrubOwnerEnvironment(), AREAL_BACKEND: 'areal', AREAL_CORE_HOME: home, AREAL_GUI_USER_DATA: guiUserData };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = childProcess.spawn(desktopExecutables({ packaged: app.isPackaged }).gui, app.isPackaged ? [] : [app.getAppPath()], {
      detached: true, stdio: 'ignore', env, windowsHide: false,
    });
    child.once('error', error => console.warn(backend.providers.redact(`通知打开界面失败：${error.message}`)));
    child.unref();
  });
  power = new SharedPowerMonitor(backend, powerSaveBlocker);
  service = new DesktopService(backend, await serviceIdentity(options), () => { void finish('completed-lifecycle'); }, notifications, power);
  service.remote = new RemoteControl(service, safeStorage);
  startupTraceService.advance('remote_init');
  await service.remote.init();
  power.start();
  startupTraceService.advance('listen');
  descriptor = await service.listen();
  startupTraceService.advance('metadata');
  const temporary = join(home, `service-${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify(descriptor), { mode: 0o600 });
  await rename(temporary, join(home, 'service.json'));
  startupTraceService.finish('ok');
}
app.on('window-all-closed', () => {});
app.on('before-quit', event => { event.preventDefault(); void finish('external-quit'); });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  void finish('signal');
});
void start().catch(async error => { startupTraceService.finish('error', error); console.error(backend?.providers.redact(error.message) ?? error.message); service?.close(); await backend?.proxyRelay?.close(); diagnostics.record({ type: 'exit-requested', exitCode: 1 }); app.exit(1); });
