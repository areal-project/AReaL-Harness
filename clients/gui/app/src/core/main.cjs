'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, nativeTheme, WebContentsView, shell, powerMonitor, Notification } = require('electron');
const { readFile, realpath, writeFile } = require('node:fs/promises');
const { join, resolve, extname, sep } = require('node:path');
const { createResourceRecovery } = require('./resource-recovery.cjs');
const { setupUpdater } = require('../update/electron.cjs');
const { showCoreNotification } = require('./notifications.cjs');
const { MenuBar } = require('./menu-bar.cjs');
const { fileOpen } = require('./file-open.cjs');
const { validateCommand, desktopError } = require('@areal/workbench/desktop-contract');
const { CorePreview } = require('./preview.cjs');
const { configureUserData, serviceOptions } = require('./service-config.cjs');
const { SharedCoreBackend } = require('./service-client.cjs');
const { recoverStartupService } = require('./startup-recovery.cjs');
const { loadThemes, engineCss, panelCss } = require('../themes');

app.setName('AReaL Harness GUI');
configureUserData(app);
// Acquire before loading resources or registering shutdown hooks. The userData
// directory scopes the lock, so explicitly isolated development/test homes coexist.
if (!app.requestSingleInstanceLock()) { app.exit(0); return; }
protocol.registerSchemesAsPrivileged([{ scheme: 'areal-ui', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const guiRoot = app.isPackaged ? join(process.resourcesPath, 'areal-gui') : resolve(__dirname, '../../../renderer/dist');
const mime = { '.wasm': 'application/wasm', '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png' };
let window, backend, preview, updates, quitting = false, exitReady = false, themeId = 'system';
let startupPending = true, startupPainted = false, startupReady = false;
// The renderer owns first-screen readiness; Main alone owns native visibility.
// Consume this gate once so late data cannot reopen a window the user hid.
function presentStartup() {
  if (!startupPending || quitting || !window || window.isDestroyed()
    || !startupPainted || !startupReady) return;
  startupPending = false;
  window.show();
}
const menuBar = new MenuBar(() => quitting || startupPending ? null : window);
app.on('will-quit', () => menuBar?.close());
let notificationTarget = null, notificationSequence = 0;
function openNotificationTarget(target) {
  notificationTarget = { ...target, id: ++notificationSequence };
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  if (!startupPending) { window.show(); window.focus(); }
  window.webContents.send('areal-core:notification-open');
}
const themes = loadThemes();
app.on('second-instance', () => {
  if (startupPending || !window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
});

function theme() {
  const id = themeId === 'system' ? (nativeTheme.shouldUseDarkColors ? 'data-dense' : 'soft-glass') : themeId;
  const selected = themes.find(item => item.id === id) ?? themes[0];
  return { platform: process.platform, id: themeId, dark: selected.dark, css: engineCss(selected) + panelCss(selected),
    options: themes.map(item => ({ id: item.id, name: item.name, author: item.author,
      swatch: [item.colors.bg, item.colors.bgRaised, item.colors.accent] })) };
}
function publish() {
  preview?.releaseInvalidOwners();
  if (window && !window.isDestroyed()) window.webContents.send('areal-core:state', desktopSnapshot());
}
function desktopSnapshot() {
  const state = backend.snapshot();
  // Wait for the authoritative saved Library before applying the default.
  // A temporary disconnect must not reset the native preference.
  if (state.connection?.state === 'ready' && state.library && !quitting) menuBar?.sync(state.library.settings?.showInMenuBar !== false);
  return { ...state, menuBar: menuBar?.snapshot() ?? null };
}
function trusted(event) {
  if (quitting) throw new Error('应用正在退出或安装更新');
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
    || !event.senderFrame.url.startsWith('areal-ui://app/')) throw new Error('拒绝非主视图请求');
}

async function createWindow() {
  window = new BrowserWindow({ width: 1440, height: 900, minWidth: 980, minHeight: 620,
    show: false,
    title: 'AReaL Harness', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 15 }, backgroundColor: '#1b1b1c',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  {
    // Native recovery dialogs may reveal their parent before the normal gate.
    window.once('show', () => { startupPending = false; });
    window.once('ready-to-show', () => { startupPainted = true; presentStartup(); });
  }
  preview = new CorePreview(window, WebContentsView, (projectId, threadId) => backend.ownsThread(projectId, threadId), () => backend.snapshot().library?.settings ?? {});
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('close', event => { if (!exitReady) { event.preventDefault(); window.hide(); } });
  await window.loadURL('areal-ui://app/');
  return window;
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock.setIcon(join(__dirname, '../../assets/icon-1024.png'));
  protocol.handle('areal-ui', async request => {
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response('Not found', { status: 404 });
    const path = resolve(guiRoot, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!path.startsWith(guiRoot + sep)) return new Response('Not found', { status: 404 });
    try { return new Response(await readFile(path), { headers: { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; frame-src 'none'" } }); }
    catch { return new Response('GUI 未构建，请先执行 make gui-build', { status: 404 }); }
  });
  backend = new SharedCoreBackend({ app, ...serviceOptions(app), onChange: publish,
    onNotification: notice => showCoreNotification(Notification, window, notice, openNotificationTarget),
    onNotificationOpen: openNotificationTarget,
    recoverIncompatible: (metadata, home) => recoverStartupService({ metadata, home, notify: options => dialog.showMessageBox(window, options) }) });
  ipcMain.handle('areal-core:preview', (event, request) => { trusted(event); if (!preview) throw new Error('预览不可用'); return preview.command(request); });
  ipcMain.handle('areal-core:notification-target', event => { trusted(event); return notificationTarget; });
  ipcMain.handle('areal-core:notification-consumed', (event, id) => { trusted(event); if (notificationTarget?.id === id) notificationTarget = null; });
  ipcMain.handle('areal-core:snapshot', event => { trusted(event); return desktopSnapshot(); });
  ipcMain.handle('areal-core:present-ready', event => {
    trusted(event);
    startupReady = true;
    presentStartup();
  });
  ipcMain.handle('areal-core:theme', (event, id) => {
    trusted(event);
    if (id !== undefined) {
      if (id !== 'system' && !themes.some(item => item.id === id)) throw new Error('未知主题');
      themeId = id;
    }
    return theme();
  });
  nativeTheme.on('updated', () => window?.webContents.send('areal-core:theme-changed', theme()));
  ipcMain.handle('areal-core:choose-project', async event => {
    trusted(event);
    const result = await dialog.showOpenDialog(window, { title: '打开项目', properties: ['openDirectory'] });
    if (result.canceled) return null;
    const path = await realpath(result.filePaths[0]);
    trusted(event);
    return backend.addProject(path);
  });
  ipcMain.handle('areal-core:choose-projectless-directory', async event => {
    trusted(event);
    const result = await dialog.showOpenDialog(window, { title: '选择无项目任务文件夹', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled) return null;
    trusted(event);
    return backend.command('projectless', { operation: 'directory', path: result.filePaths[0] });
  });
  ipcMain.handle('areal-core:file-open', async (event, request) => {
    trusted(event);
    return fileOpen({ backend, shell, home: app.getPath('home'), authorize: () => trusted(event), chooseSave: options => dialog.showSaveDialog(window, options) }, request);
  });
  ipcMain.handle('areal-core:command', async (event, name, params) => {
    trusted(event);
    try {
      validateCommand(name, params);
      if (name === 'remoteControl') return { ok: true, value: await backend.remoteControl(params) };
      if (name === 'serviceStatus') return { ok: true, value: await backend.serviceStatus() };
      if (name === 'stopService') return { ok: true, value: await requestStopService() };
      if (name === 'recoverResources') { await recoverResources(); return { ok: true, value: null }; }
      if (name === 'connectService') { await backend.init(); return { ok: true, value: null }; }
      if (name === 'manage' && params.operation === 'archive') {
        const answer = await dialog.showMessageBox(window, { type: 'question', message: '归档此会话？', detail: '历史仍可查看。当前 Core 不支持取消归档，归档后无法继续发送消息。', buttons: ['取消', '归档会话'], defaultId: 0, cancelId: 0 });
        if (answer.response !== 1) return { ok: true, value: { canceled: true } };
      }
      if (name === 'export') {
        await backend.command('open', params);
        const project = backend.snapshot().projects.find(item => item.id === params.projectId);
        const thread = project?.state?.threads[params.threadId];
        if (!thread) throw new Error('请选择需要导出的会话');
        const result = await dialog.showSaveDialog(window, { title: '导出会话记录与执行轨迹', defaultPath: `areal-${thread.id}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
        if (result.canceled || !result.filePath) return { ok: true, value: { canceled: true } };
        await writeFile(result.filePath, JSON.stringify({ format: 'areal-harness-thread-v1', exportedAt: new Date().toISOString(), project: { id: project.id, root: project.root }, thread, queue: project.state.queues[thread.id] }, null, 2), { mode: 0o600 });
        return { ok: true, value: { path: result.filePath } };
      }
      trusted(event);
      const value = await backend.command(name, params);
      if (name === 'chatgpt' && params.operation === 'login') {
        try { await shell.openExternal(value.authUrl); }
        catch { await backend.command('chatgpt', { operation: 'cancel', provider: params.provider }); throw new Error('无法打开浏览器，请重试 ChatGPT 登录'); }
      }
      return { ok: true, value };
    }
    catch (error) { return { ok: false, error: desktopError(error) }; }
  });
  let recoveryPending = 0;
  const hasUpdateWork = () => recoveryPending > 0 || backend.hasWork() || backend.activeCommands > 0 || backend.providerUpdating || backend.starting.size > 0;
  const nativeRecoverResources = createResourceRecovery({ backend, notify: options => dialog.showMessageBox(window, options) });
  const recoverResources = async () => {
    recoveryPending++;
    try { await nativeRecoverResources(); }
    finally {
      recoveryPending--;
      if (recoveryPending === 0 && updates?.state().status === 'deferred') void updates.install();
    }
  };
  updates = setupUpdater({ recoverInstall: recoverResources, hasWork: hasUpdateWork,
    onState: state => { if (window && !window.isDestroyed()) window.webContents.send('areal-core:update-changed', state); },
    prepareInstall: async () => {
    if (quitting || hasUpdateWork()) throw new Error('仍有活动任务，请完成后重试');
    quitting = true;
    try { await backend.stopService(true); preview?.dispose(); await backend.shutdown(); exitReady = true; }
    catch (error) { quitting = false; throw error; }
  } });
  ipcMain.handle('areal-core:update-state', event => { trusted(event); return updates.state(); });
  ipcMain.handle('areal-core:update-download', event => { trusted(event); void updates.download(); return updates.state(); });
  ipcMain.handle('areal-core:update-recover-resources', async event => { trusted(event); await recoverResources(); return updates.state(); });
  const requestStopService = async () => {
    const answer = await dialog.showMessageBox(window, { type: 'question', message: '停止共享后台服务？', detail: '所有连接此服务的 GUI 都会断开。只有没有活动任务、可执行的排队消息和终端时才能停止。已暂停的待发送消息会保留。', buttons: ['取消', '停止后台服务'], defaultId: 0, cancelId: 0 });
    if (answer.response !== 1) return { canceled: true };
    return backend.stopService();
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'AReaL Harness', submenu: [{ role: 'about' }, { label: '检查更新…', click: () => { void updates.check(true); } }, { label: '检查后台资源…', click: () => { void recoverResources(); } }, { label: '停止后台 Core 服务…', click: async () => {
      try { await requestStopService(); } catch (error) { await dialog.showMessageBox(window, { type: 'warning', message: '后台服务未停止', detail: error.message }); }
    } }, { type: 'separator' }, { role: 'quit' }] },
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]));
  // Build the hidden first screen while the existing service connection starts.
  // Incompatible services keep their recovery dialog; failures remain retryable.
  const windowLoaded = createWindow();
  const serviceStarted = (async () => {
    try {
      await backend.init({ automatic: true });
      if (backend.status.connected && process.env.AREAL_CORE_WORKSPACE) await backend.addProject(process.env.AREAL_CORE_WORKSPACE);
    } catch { /* 错误由后台连接快照展示，用户显式重试。 */ }
    publish();
  })();
  await windowLoaded;
  const activityPauses = new Set();
  const sampleActivity = () => backend.analytics.sample({ focused: !!window && !window.isDestroyed() && window.isFocused() && window.isVisible() && !window.isMinimized(), idleSeconds: powerMonitor.getSystemIdleTime(), suspended: activityPauses.size > 0 });
  const activityTimer = setInterval(sampleActivity, 5000);
  const saveTimer = setInterval(() => { void backend.analytics.flush(); }, 30000);
  for (const event of ['focus', 'blur', 'hide', 'minimize', 'restore']) window.on(event, sampleActivity);
  for (const event of ['suspend', 'lock-screen']) powerMonitor.on(event, () => { sampleActivity(); activityPauses.add(event); sampleActivity(); void backend.analytics.flush(); });
  for (const [event, pause] of [['resume', 'suspend'], ['unlock-screen', 'lock-screen']]) powerMonitor.on(event, () => { activityPauses.delete(pause); sampleActivity(); });
  app.on('before-quit', () => { sampleActivity(); void backend.analytics.flush(); });
  app.on('will-quit', () => { clearInterval(activityTimer); clearInterval(saveTimer); });
  sampleActivity();
  await serviceStarted;
  sampleActivity();
}).catch(error => { if (error.code !== 'STARTUP_CANCELLED') { console.error(error); dialog.showErrorBox('AReaL 启动失败', error.message); } app.exit(error.code === 'STARTUP_CANCELLED' ? 0 : 1); });

app.on('activate', () => { if (!startupPending && window && !window.isDestroyed()) window.show(); });
app.on('window-all-closed', () => {});
app.on('before-quit', event => {
  if (exitReady) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  void (async () => {
    // 窗口只拥有连接和交互终端；退出不是停止共享 Core 的授权。
    try { await backend?.prepareQuit(); }
    catch (error) {
      window?.show(); window?.focus();
      await dialog.showMessageBox(window, { type: 'warning', message: '界面终端尚未完成清理', detail: error.message, buttons: ['返回应用'] });
      quitting = false;
      return;
    }
    preview?.dispose();
    try { await backend?.shutdown(); }
    catch (error) { await dialog.showMessageBox(window, { type: 'warning', message: '退出清理未完全确认', detail: error.message }); }
    exitReady = true;
    app.quit();
  })();
});
