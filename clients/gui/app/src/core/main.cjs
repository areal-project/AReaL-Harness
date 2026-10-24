'use strict';
const { startupTrace } = require('./startup-timing.cjs');
const startupTraceMain = startupTrace('gui.startup');
startupTraceMain.advance('imports');

const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, nativeTheme, WebContentsView, shell, powerMonitor, Notification, crashReporter, session } = require('electron');
const { readFile, realpath, stat, writeFile } = require('node:fs/promises');
const { join, resolve, extname, sep } = require('node:path');
const { randomUUID } = require('node:crypto');
const { ProjectionEncoder } = require('@areal/workbench/state-projection');
const { createOwner } = require('./application-owner.cjs');
const { setupUpdater } = require('../update/electron.cjs');
const { showCoreNotification } = require('./notifications.cjs');
const { MenuBar } = require('./menu-bar.cjs');
const { fileOpen } = require('./file-open.cjs');
const { PluginArchives } = require('./plugin-archives.cjs');
const { McpFormResources } = require('./mcp-form-resources.cjs');
const { McpAppsHost, parseDeepLink } = require('./mcp-apps.cjs');
const { McpMetadataImages } = require('./mcp-apps-images.cjs');
const { validateCommand, validatePreview, desktopError } = require('@areal/workbench/desktop-contract');
const { CorePreview } = require('./preview.cjs');
const { ComputerControl } = require('./computer-control.cjs');
const { ExternalCua, upstream: cuaUpstream } = require('./external-cua.cjs');
const diagnostics = require('./diagnostics.cjs');
const { configureUserData, serviceOptions, serviceHome } = require('./service-config.cjs');
const { readLibraryStartupSettings } = require('./library.cjs');
const { applyDesktopSessionNetworkPolicy } = require('./desktop-network.cjs');
const { SharedCoreBackend } = require('./service-client.cjs');
const { recoverConnectedService } = require('./startup-recovery.cjs');
const { setNativeLocale, nativeText } = require('./native-i18n.cjs');
const { loadThemes, engineCss, panelCss } = require('../themes');

startupTraceMain.advance('app_ready');
app.setName('AReaL Harness GUI');
configureUserData(app);
const applicationOwner = createOwner(app.getPath('userData'));
app.setPath('userData', applicationOwner.profile);
let startupSettings, startupSettingsError;
try {
  startupSettings = readLibraryStartupSettings(serviceHome(app));
  if (startupSettings.hardwareAcceleration === false) app.disableHardwareAcceleration();
} catch (error) { startupSettingsError = error; console.error('Desktop startup settings could not be read', error); }
// Acquire before loading resources or registering shutdown hooks. The userData
// directory scopes the lock, so explicitly isolated development/test homes coexist.
if (!app.requestSingleInstanceLock()) {
  console.info('AReaL Harness 界面已在运行，已请求显示已有窗口。');
  startupTraceMain.finish('skipped'); app.exit(0); return;
}
const diagnosticsRoots = { mainRoot: join(applicationOwner.profile, 'diagnostics', 'main'), desktopRoot: join(serviceHome(app), 'diagnostics', 'desktop') };
diagnostics.start({ role: 'main', root: diagnosticsRoots.mainRoot, appRunId: applicationOwner.appRunId, version: app.getVersion() });
diagnostics.startCrashReporter({ app, crashReporter });
app.on('child-process-gone', (_event, details) => diagnostics.record({ type: 'child-process-gone', processType: details.type, reason: details.reason, exitCode: details.exitCode }));
app.on('render-process-gone', (_event, _contents, details) => diagnostics.record({ type: 'renderer-gone', reason: details.reason, exitCode: details.exitCode }));
app.on('will-quit', () => diagnostics.record({ type: 'exit-requested', exitCode: 0 }));
protocol.registerSchemesAsPrivileged([{ scheme: 'areal-mcp', privileges: { standard: true, secure: true, supportFetchAPI: true } }, { scheme: 'areal-ui', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const guiRoot = app.isPackaged ? join(process.resourcesPath, 'areal-gui') : resolve(__dirname, '../../../renderer/dist');
const mime = { '.wasm': 'application/wasm', '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png' };
let computer, externalCua, computerActivity = null, computerWasEnabled = false, computerAdmissionSuspended = false, computerUiAvailable = false, computerSystemPaused = false;
const computerRequests = new Map();
const computerSelection = () => {
  const settings = backend?.snapshot().library?.settings ?? {};
  return { enabled: settings.computerControlEnabled === true, provider: settings.computerControlProvider ?? 'native', executable: settings.computerControlExecutable ?? '' };
};
const computerAvailable = () => backend?.computerHostOwned === true && !quitting && !browserWindowClosed
  && computerUiAvailable && !computerSystemPaused && !computerAdmissionSuspended;
const stopComputer = reason => Promise.all([computer?.stop(reason), externalCua?.stop(reason)]);
const closeComputer = () => Promise.all([computer?.close(), externalCua?.close()]);
let window, backend, preview, mcpApps, updates, quitting = false, exitReady = false, themeId = 'system';
let browserWindowClosed = false, windowClosePromise = null;
const previewSubscriptions = new Map();
const projections = new WeakMap();
let startupPresentation = 'requested', startupPainted = false, startupReady = false;
let focusRequested = false, quitAttempt = null, quitRequestSequence = 0;
let startupShowTrace, startupPaintTrace, startupPresentTrace;
function presentStartup() {
  if (startupPresentation !== 'requested' || quitting || windowClosePromise || !window || window.isDestroyed()
    || !startupPainted || !startupReady) return;
  startupPresentation = 'presented';
  browserWindowClosed = false; backend.guiWindowClosed = false;
  window.show();
  if (focusRequested) { focusRequested = false; window.focus(); }
}
function revealWindow() {
  if (quitting || exitReady) return;
  if (windowClosePromise) {
    const owner = window;
    void windowClosePromise.then(() => { if (window === owner && !owner.isDestroyed()) revealWindow(); });
    return;
  }
  if (!window || window.isDestroyed()) { focusRequested = true; return; }
  if (startupPresentation !== 'presented') {
    startupPresentation = 'requested'; focusRequested = true; presentStartup(); return;
  }
  browserWindowClosed = false; backend.guiWindowClosed = false;
  if (window.isMinimized()) window.restore();
  window.show(); window.focus();
}
function confirmRendererQuit(attempt) {
  if (!window || window.isDestroyed()) return Promise.resolve(false);
  const owner = window.webContents, frame = owner.mainFrame;
  if (owner.isDestroyed() || !frame.url.startsWith('areal-ui://app/')) return Promise.resolve(false);
  attempt.owner = owner; attempt.frame = frame;
  return new Promise(resolveDecision => {
    const cancel = () => finish(false);
    const navigate = (_event, _url, _inPlace, mainFrame) => { if (mainFrame) cancel(); };
    const finish = allowed => {
      if (attempt.decide !== finish) return;
      attempt.decide = null;
      owner.removeListener('destroyed', cancel);
      owner.removeListener('render-process-gone', cancel);
      owner.removeListener('did-start-navigation', navigate);
      resolveDecision(allowed);
    };
    attempt.decide = finish;
    owner.once('destroyed', cancel);
    owner.once('render-process-gone', cancel);
    owner.on('did-start-navigation', navigate);
    revealWindow();
    owner.send('areal-core:quit-request', attempt.id);
  });
}
function setQuitProgress(attempt, phase) {
  if (quitAttempt !== attempt || attempt.intent === 'install') return;
  attempt.phase = phase;
  if (attempt.owner && !attempt.owner.isDestroyed() && attempt.owner.mainFrame === attempt.frame)
    attempt.owner.send('areal-core:quit-progress', phase ? { state: 'quitting', phase } : { state: 'idle' });
}
function recordQuitStage(attempt, stage) {
  if (quitAttempt !== attempt) return;
  diagnostics.record({ type: 'quit-stage', attempt: attempt.id, elapsedMs: Math.floor(performance.now() - attempt.startedAt), stage });
}
function requestQuit(intent = 'application') {
  if (quitAttempt) return quitAttempt.promise;
  if (quitting) return Promise.resolve({ canceled: true });
  const attempt = { id: ++quitRequestSequence, intent, owner: null, frame: null, decide: null, approved: false,
    phase: null, startedAt: performance.now(), promise: null };
  quitAttempt = attempt;
  const beginQuit = phase => {
    attempt.approved = true;
    quitting = true;
    if (intent !== 'install') preview?.setPresentationSuppressed(true);
    setQuitProgress(attempt, phase);
  };
  const notify = async options => {
    recordQuitStage(attempt, 'native-confirmation');
    const answer = await (process.platform === 'darwin' && intent !== 'install' ? dialog.showMessageBox(options) : dialog.showMessageBox(window, options));
    if (answer.response === 1) { beginQuit('stopping'); recordQuitStage(attempt, 'stop'); }
    return answer;
  };
  attempt.promise = (async () => {
    if (!backend) throw new Error(nativeText('lifecycle.preparing'));
    if (!await confirmRendererQuit(attempt)) { recordQuitStage(attempt, 'canceled'); return { canceled: true }; }
    if (quitting) { recordQuitStage(attempt, 'canceled'); return { canceled: true }; }
    await backend.closeWindowSideChats();
    if (intent === 'install') { beginQuit('checking'); recordQuitStage(attempt, 'checking'); }
    recordQuitStage(attempt, 'readiness');
    await backend.waitForApplicationReady();
    recordQuitStage(attempt, 'reconcile');
    await backend.checkLifecycle();
    if (backend.foreignOwner && (intent === 'install' || backend.desktopLifetimes.size))
      throw Object.assign(new Error(nativeText('lifecycle.foreignOwner')), { code: 'APPLICATION_OWNER_MISMATCH' });
    if (!backend.foreignOwner && !backend.serviceExited && (backend.status.connected || backend.metadata || backend.desktopLifetimes.size)) {
      recordQuitStage(attempt, 'stop');
      const result = await recoverConnectedService({ backend, notify,
        purpose: intent === 'install' ? 'update' : 'quit', forUpdate: intent === 'install' });
      if (result.stopped !== true) {
        recordQuitStage(attempt, result.canceled ? 'canceled' : 'incomplete');
        if (!result.canceled) backend.reportLifecycleError(new Error(nativeText('lifecycle.stopIncomplete')));
        return result;
      }
    } else if (intent !== 'install') {
      const answer = await notify({ type: 'question', message: nativeText('quit.question'),
        detail: nativeText('quit.interfaceDetail'),
        buttons: [nativeText('common.cancel'), nativeText('common.quit')], defaultId: 1, cancelId: 0, noLink: true });
      if (answer.response !== 1) { recordQuitStage(attempt, 'canceled'); return { canceled: true }; }
    }
    setQuitProgress(attempt, 'finishing');
    recordQuitStage(attempt, 'terminal');
    await backend.prepareQuit();
    if (intent === 'install') await require('../update/package-users.cjs').assertPackageUsersReleased({ packaged: app.isPackaged });
    recordQuitStage(attempt, 'finalizing');
    if (!backend.foreignOwner) await backend.completeApplicationQuit();
    recordQuitStage(attempt, 'disconnect');
    await backend.shutdown();
    await preview?.dispose();
    await closeComputer();
    exitReady = true;
    recordQuitStage(attempt, 'exit-ready');
    if (intent !== 'install') setImmediate(() => app.quit());
    return { stopped: true, quitting: true };
  })().catch(error => { recordQuitStage(attempt, 'failed'); throw error; }).finally(() => {
    if (!exitReady && quitAttempt === attempt) {
      if (backend) backend.guiWindowClosed = false;
      if (attempt.approved) quitting = false;
      setQuitProgress(attempt, null);
      if (intent !== 'install') preview?.setPresentationSuppressed(false);
      quitAttempt = null;
    }
  });
  return attempt.promise;
}
async function exportDiagnostics() {
  try {
    const options = { title: nativeText('diagnostics.exportTitle'), defaultPath: `areal-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] };
    const result = await (window && !window.isDestroyed() ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options));
    if (result.canceled || !result.filePath) return { canceled: true };
    await diagnostics.exportTo(result.filePath, diagnosticsRoots);
    return { path: result.filePath };
  } catch { throw Object.assign(new Error(nativeText('diagnostics.saveFailed')), { code: 'DIAGNOSTICS_EXPORT_FAILED' }); }
}
const requestStopAndQuit = () => requestQuit('stop');
const stopAndQuitFromMenu = () => { void requestStopAndQuit().catch(error => { backend?.reportLifecycleError(error); revealWindow(); }); };
const menuBar = new MenuBar(() => { if (startupPresentation === 'presented') revealWindow(); }, stopAndQuitFromMenu);
app.on('will-quit', () => menuBar?.close());
let notificationTarget = null, notificationSequence = 0;
function openNotificationTarget(target) {
  notificationTarget = { ...target, id: ++notificationSequence };
  if (!window || window.isDestroyed()) return;
  if (startupPresentation === 'presented') revealWindow();
  window.webContents.send('areal-core:notification-open');
}
let mcpAppDeepLink = null, mcpAppDeepLinkSequence = 0;
function receiveMcpAppDeepLink(raw) {
  try { mcpAppDeepLink = { ...parseDeepLink(raw), id: ++mcpAppDeepLinkSequence }; }
  catch { return false; }
  if (window && !window.isDestroyed()) window.webContents.send('areal-core:mcp-app-deep-link');
  return true;
}
app.on('open-url', (event, url) => { if (receiveMcpAppDeepLink(url)) event.preventDefault(); });
app.on('second-instance', (_event, argv) => { for (const arg of argv) if (/^(areal|codex):\/\/plugins\//.test(arg)) receiveMcpAppDeepLink(arg); });
for (const arg of process.argv) if (/^(areal|codex):\/\/plugins\//.test(arg)) receiveMcpAppDeepLink(arg);
const themes = loadThemes();
app.on('second-instance', revealWindow);

function theme() {
  const id = themeId === 'system' ? (nativeTheme.shouldUseDarkColors ? 'data-dense' : 'soft-glass') : themeId;
  const selected = themes.find(item => item.id === id) ?? themes[0];
  return { platform: process.platform, id: themeId, dark: selected.dark, css: engineCss(selected) + panelCss(selected),
    options: themes.map(item => ({ id: item.id, name: item.name, author: item.author,
      swatch: [item.colors.bg, item.colors.bgRaised, item.colors.accent] })) };
}
function publish() {
  preview?.releaseInvalidOwners();
  mcpApps?.revokeInvalid();
  if (!window || window.isDestroyed()) return;
  const owner = window.webContents, projection = projections.get(owner);
  if (projection?.frame === owner.mainFrame)
    owner.send('areal-core:projection', { frame: projection.encoder.encode(desktopSnapshot()) });
}
function desktopSnapshot() {
  const state = backend.snapshot();
  // Wait for the authoritative saved Library before applying the default.
  // A temporary disconnect must not reset the native preference.
  if (state.connection?.state === 'ready' && state.library && !quitting) menuBar?.sync(state.library.settings?.showInMenuBar !== false);
  const enabled = state.library?.settings?.computerControlEnabled === true;
  const wasEnabled = computerWasEnabled; computerWasEnabled = enabled;
  if (wasEnabled && !enabled) void stopComputer('disabled').catch(() => {});
  return { ...state, menuBar: menuBar?.snapshot() ?? null, computerControl: computerActivity };
}
function trustedSender(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
    || !event.senderFrame.url.startsWith('areal-ui://app/')) throw new Error(nativeText('boundary.untrustedSender'));
}
function trusted(event) {
  if (quitting) throw new Error(nativeText('boundary.quitting'));
  trustedSender(event);
}
ipcMain.on('areal-core:interface-locale', (event, locale) => {
  try { trustedSender(event); } catch { return; }
  setNativeLocale(locale);
});
ipcMain.on('areal-core:quit-decision', (event, decision) => {
  const attempt = quitAttempt;
  if (!attempt?.decide || !decision || decision.id !== attempt.id || typeof decision.allowed !== 'boolean'
    || event.sender !== attempt.owner || event.senderFrame !== attempt.frame
    || event.senderFrame !== event.sender.mainFrame || !event.senderFrame.url.startsWith('areal-ui://app/')) return;
  attempt.decide(decision.allowed);
});

async function createWindow() {
  const trace = startupTrace('gui.window');
  trace.advance('create');
  startupShowTrace = startupTrace('gui.first_show');
  startupShowTrace.advance('show');
  startupPaintTrace = startupTrace('gui.ready_to_show');
  startupPaintTrace.advance('ready_to_show');
  startupPresentTrace = startupTrace('gui.present_ready');
  startupPresentTrace.advance('present_ready');
  try {
    browserWindowClosed = false;
    window = new BrowserWindow({ width: 1440, height: 900, minWidth: 980, minHeight: 620,
      show: false,
      title: 'AReaL Harness', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 15 }, backgroundColor: '#1b1b1c',
      webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    {
      // Native recovery dialogs may reveal their parent before the normal gate.
      window.once('show', () => { startupPresentation = 'presented'; startupShowTrace.finish('ok'); });
      window.once('ready-to-show', () => { startupPainted = true; startupPaintTrace.finish('ok'); presentStartup(); });
    }
    preview = new CorePreview(window, WebContentsView,
      (projectId, threadId) => backend.ownsThread(projectId, threadId),
      () => backend.snapshot().library?.settings ?? {},
      (projectId, threadId) => backend.snapshot().projects.find(project => project.id === projectId)?.state?.threads?.[threadId]?.executionCore?.instanceId
        ?? backend.status.browserCore?.[projectId] ?? null,
      () => [backend.metadata?.endpoint, ...(backend.status.browserControlEndpoints ?? [])].filter(Boolean),
      async ({ origin, page, fence, kind }) => {
        const current = () => !quitting && !!backend.metadata?.endpoint
          && window && !window.isDestroyed() && window.isVisible() && !window.isMinimized()
          && window.isFocused() && preview?.currentDevelopmentPrompt(page, fence);
        if (!current()) return false;
        const { response } = await dialog.showMessageBox(window, {
          type: 'question', title: kind === 'frame' ? nativeText('browser.frameTitle') : nativeText('browser.developmentTitle'),
          message: kind === 'frame' ? nativeText('browser.frameQuestion', { origin }) : nativeText('browser.developmentQuestion', { origin }),
          detail: kind === 'frame'
            ? nativeText('browser.frameDetail')
            : nativeText('browser.developmentDetail'),
          buttons: [nativeText('common.cancel'), kind === 'frame' ? nativeText('browser.allowFrame') : nativeText('browser.allowWorkspace')], defaultId: 0, cancelId: 0, noLink: true,
        });
        return response === 1 && current();
      }, (projectId, threadId) => backend.retainsThreadResources(projectId, threadId));
    preview.onRevoke = identity => { void backend.browserRevoke(identity).catch(() => {}); };
    window.on('unresponsive', () => { computerUiAvailable = false; void stopComputer('ui_unresponsive').catch(() => {}); diagnostics.record({ type: 'renderer-unresponsive' }); });
    window.on('responsive', () => { computerUiAvailable = window.webContents.mainFrame.url.startsWith('areal-ui://app/'); diagnostics.record({ type: 'renderer-responsive' }); });
    const owner = window.webContents;
    owner.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) {
        computerUiAvailable = false; void stopComputer('ui_navigation').catch(() => {});
        projections.delete(owner); mcpApps?.dispose();
      }
    });
    owner.on('did-finish-load', () => { computerUiAvailable = owner.mainFrame.url.startsWith('areal-ui://app/'); });
    owner.on('destroyed', () => { computerUiAvailable = false; void stopComputer('ui_destroyed').catch(() => {}); projections.delete(owner); });
    owner.on('render-process-gone', () => { computerUiAvailable = false; void stopComputer('ui_crashed').catch(() => {}); projections.delete(owner); mcpApps?.dispose(); });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-frame-navigate', event => {
      const from = event.initiator?.url ?? event.frame?.url ?? '';
      if (from.startsWith('areal-mcp:') && !event.url.startsWith('areal-mcp:')) event.preventDefault();
    });
    window.webContents.on('will-prevent-unload', event => {
      if (exitReady && quitAttempt?.approved && quitAttempt.owner === window.webContents
        && quitAttempt.frame === window.webContents.mainFrame) event.preventDefault();
    });
    window.on('show', () => { browserWindowClosed = false; backend.guiWindowClosed = false; });
    window.on('close', event => {
      if (exitReady) return;
      event.preventDefault();
      if (quitting || windowClosePromise) return;
      // A close-to-background still ends this window's Browser ownership. Fence
      // native callbacks before hiding; reopening creates fresh Pages on demand.
      browserWindowClosed = true;
      if (startupPresentation !== 'presented') { startupPresentation = 'suppressed'; focusRequested = false; }
      const owner = window;
      void stopComputer('window_closed').catch(() => {});
      windowClosePromise = backend.closeWindowSideChats().then(async () => {
        await preview?.dispose();
        mcpApps?.dispose();
        if (!owner.isDestroyed()) owner.hide();
      }).catch(error => { browserWindowClosed = false; backend.guiWindowClosed = false; backend.reportLifecycleError(error); }).finally(() => { windowClosePromise = null; });
    });
    trace.advance('load');
    await window.loadURL('areal-ui://app/');
    trace.finish('ok');
    return window;
  } catch (error) { trace.finish('error', error); throw error; }
}

app.whenReady().then(async () => {
  if (startupSettingsError) throw startupSettingsError;
  await Promise.all([session.defaultSession, session.fromPartition('persist:areal-embedded-browser')]
    .map(target => applyDesktopSessionNetworkPolicy(target, startupSettings)));
  startupTraceMain.finish('ok');
  if (process.platform === 'darwin') app.dock.setIcon(join(__dirname, '../../assets/icon-1024.png'));
  protocol.handle('areal-ui', async request => {
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response('Not found', { status: 404 });
    const path = resolve(guiRoot, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!path.startsWith(guiRoot + sep)) return new Response('Not found', { status: 404 });
    try { return new Response(await readFile(path), { headers: { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; frame-src areal-mcp:" } }); }
    catch { return new Response(nativeText('gui.notBuilt'), { status: 404 }); }
  });
  backend = new SharedCoreBackend({ app, ...serviceOptions(app), applicationOwner, onChange: publish,
    onNotification: notice => showCoreNotification(Notification, window, notice, openNotificationTarget),
    onNotificationOpen: openNotificationTarget,
    onRecoveryAttention: attention => dialog.showMessageBox(window, { type: 'warning', message: nativeText('recovery.attention'),
      detail: attention.join('\n\n') + nativeText('recovery.attentionDetail'), buttons: [nativeText('recovery.review')], defaultId: 0, cancelId: 0 }) });
  computer = new ComputerControl({
    helperPath: app.isPackaged ? join(process.resourcesPath, 'computer-helper/AReaL Computer Helper.app')
      : join(__dirname, '../../../native/computer-helper/build/AReaL Computer Helper.app'),
    getEnabled: () => computerAvailable() && computerSelection().enabled && computerSelection().provider === 'native',
    onActivity: status => { if (computerSelection().provider === 'native') { computerActivity = status; publish(); } },
  });
  externalCua = new ExternalCua({ getSelection: computerSelection, getAvailable: computerAvailable,
    onActivity: status => { if (computerSelection().provider === 'lcu') { computerActivity = status; publish(); } },
    onElicitation: async (params, { signal, owner }) => {
      const { nativeAppApprovalOptions, nativeAppApprovalResponse } = await cuaUpstream();
      const { declineAgentHostApp, detectHostApps, appBundleOf, plistBundleId } = await import('../vendor/lcu/host-guard.mjs');
      const bundle = appBundleOf(process.execPath), bundleId = bundle && plistBundleId(bundle);
      const refusal = declineAgentHostApp(params, { env: {}, report() {},
        hosts: [...detectHostApps(), ...(bundleId ? [{ bundleId, name: app.getName() }] : [])] });
      if (refusal) return refusal;
      const approval = nativeAppApprovalOptions(params);
      if (!approval || signal.aborted || !computerAvailable() || !window || window.isDestroyed()) return { action: 'cancel' };
      const choices = [...approval.choices, { value: 'cancel', label: 'Cancel' }];
      const result = await dialog.showMessageBox(window, { type: 'question', title: 'External computer control',
        message: approval.message, detail: [approval.resource, typeof params._meta?.warning === 'string' ? params._meta.warning : '',
          `Chat ${owner.threadId}`].filter(Boolean).join('\n\n'), buttons: choices.map(choice => choice.label),
        defaultId: choices.length - 1, cancelId: choices.length - 1, noLink: true, signal });
      return signal.aborted ? { action: 'cancel' } : nativeAppApprovalResponse(params, choices[result.response]?.value);
    },
  });
  backend.onBrowserDisconnected = () => {
    preview?.revokeAll();
    for (const controller of computerRequests.values()) controller.abort();
    void stopComputer('desktop_disconnected').catch(() => {});
  };
  backend.onBrowserCancel = request => {
    if (['computer_v1', 'external_cua'].includes(request.tool)) computerRequests.get(request.requestId)?.abort();
    else preview?.cancelRead(request);
  };
  backend.onBrowserRequest = async request => {
    if (request.tool === 'external_cua') {
      const controller = new AbortController(); computerRequests.set(request.requestId, controller);
      try {
        const input = { ...request, tool: request.cuaTool, signal: controller.signal };
        if (request.phase === 'catalog') return await externalCua.catalog({ ...input, threadId: '__catalog__' });
        if (request.phase === 'call') return await externalCua.call(input);
        if (request.phase === 'endTurn') return await externalCua.endTurn(input);
        if (request.phase === 'revokeProject') { await externalCua.revokeProject(input); return {}; }
        throw new Error('Unsupported external CUA request');
      } catch (error) {
        if (request.phase === 'catalog') return { error: error.message };
        throw error;
      } finally { computerRequests.delete(request.requestId); }
    }
    if (request.tool === 'computer_v1') {
      if (quitting || !window || window.isDestroyed() || browserWindowClosed) throw new Error('Computer host unavailable');
      const controller = new AbortController(); computerRequests.set(request.requestId, controller);
      try {
        const input = { ...request, signal: controller.signal };
        return await (request.phase === 'prepare'
          ? request.discardPreparedPlan === true ? computer.discard(input) : computer.prepare(input)
          : computer.execute(input));
      } catch (error) {
        if (request.phase === 'prepare') return { ...error.structuredContent, code: error.code ?? 'computer_unavailable',
          message: error.message, error: error.code ?? 'computer_unavailable', dispatch: 'not_sent',
          dispatch_status: 'not_sent', action_sent: false };
        const dispatch = error.dispatch_status ?? error.dispatchStatus;
        if (dispatch === 'not_sent' && error.actionSent !== true && error.action_sent !== true)
          return { isError: true, content: [{ type: 'text', text: error.message }],
            structuredContent: { code: error.code ?? 'computer_unavailable', dispatch_status: 'not_sent', action_sent: false } };
        throw error;
      } finally { if (computerRequests.get(request.requestId) === controller) computerRequests.delete(request.requestId); }
    }
    if (quitting || !preview || !window || window.isDestroyed()) throw new Error('Browser host unavailable');
    try {
      if (request.operation === 'describe') {
        if (request.phase === 'prepare') return preview.prepareDiscovery(request);
        if (request.browserApproval?.plan) preview.consumeDiscovery(request);
        const identity = await preview.ensureAgentPage(request.projectId, request.threadId);
        try {
          if (!request.browserApproval?.plan?.alreadyControlled)
            await backend.browserClaim({ ...identity, bootstrapRequestId: request.requestId });
          const page = preview.page(request.projectId, request.threadId, identity.pageId);
          if (!page || !preview.pageStillOwned(page) || page.control !== 'agent'
            || preview.page(request.projectId, request.threadId) !== page
            || page.controlEpoch !== identity.controlEpoch || page.pageGeneration !== identity.pageGeneration)
            throw new Error('Browser entry was revoked');
        }
        catch (error) {
          const page = preview.page(request.projectId, request.threadId, identity.pageId);
          if (page?.controlEpoch === identity.controlEpoch && page.control === 'agent')
            preview.takeover(request.projectId, request.threadId, identity.pageId);
          throw error;
        }
        if (!window.isDestroyed()) window.webContents.send('areal-core:preview-event', {
          kind: 'reveal', projectId: request.projectId, threadId: request.threadId, pageId: identity.pageId });
        return { ...identity, coreGeneration: request.coreGeneration, turnId: request.turnId, callId: request.callId,
          claimed: true, controlPermit: preview.controlPermit(request.projectId, request.threadId, identity.pageId) };
      }
      const result = await (request.phase === 'prepare' ? preview.prepare(request) : preview.execute(request));
      if (request.phase !== 'prepare' && !result.error) {
        result.controlPermit = preview.controlPermit(request.projectId, request.threadId, request.pageId);
        if (result.createdPage) result.controlPermits = [result.controlPermit,
          preview.controlPermit(request.projectId, request.threadId, result.createdPage.pageId)];
      }
      return result;
    }
    catch (error) {
      if (error.message === 'outcome_unknown') throw error;
      return { coreInstanceId: request.coreInstanceId, coreGeneration: request.coreGeneration, projectId: request.projectId,
      threadId: request.threadId, turnId: request.turnId, callId: request.callId, pageId: request.pageId,
      browserHostId: request.browserHostId, hostGeneration: request.hostGeneration,
      pageGeneration: request.pageGeneration, controlEpoch: request.controlEpoch,
      error: error.message === 'human_control' || /Human controls|revoked/.test(error.message) ? 'human_control'
        : error.message === 'stale_ref' ? 'stale_ref'
        : /plan_stale/.test(error.message) ? 'plan_stale'
        : error.message === 'human_takeover_required' ? 'human_takeover_required'
        : error.message === 'condition_timeout' ? 'condition_timeout'
        : /not_sent|target_unavailable/.test(error.message) ? 'not_sent'
        : /budget exceeded|Sensitive field|viewport changed|content changed during capture|capture guard unavailable/.test(error.message) ? 'evidence_unavailable' : 'page_unavailable' }; }
  };
  app.on('will-quit', () => { mcpApps?.dispose(); void closeComputer().catch(() => {}); });
  mcpApps = new McpAppsHost({ backend, ownerId: () => window && !window.isDestroyed() && !window.webContents.isDestroyed() ? window.webContents.id : undefined,
    notify: value => { if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('areal-core:mcp-app-event', value); },
    openFile: (request, current) => fileOpen({ backend, shell, home: app.getPath('home'), authorize: current,
      chooseSave: options => dialog.showSaveDialog(window, options) }, request) });
  backend.onMcpAppNotification = event => mcpApps?.notification(event);
  backend.onMcpPageToolNotice = event => { void mcpApps?.pageToolNotice(event).catch(() => {}); };
  backend.onMcpPageToolsDisconnected = event => mcpApps?.pageToolsDisconnected(event);
  protocol.handle('areal-mcp', request => mcpApps.resource(request));
  ipcMain.handle('areal-core:mcp-app-deep-link-target', event => { trusted(event); return mcpAppDeepLink; });
  ipcMain.handle('areal-core:mcp-app-deep-link-consumed', (event, id) => { trusted(event); if (mcpAppDeepLink?.id === id) mcpAppDeepLink = null; });
  const mcpMetadataImages = new McpMetadataImages(backend);
  const mcpFormResources = new McpFormResources({ backend,
    choose: options => dialog.showOpenDialog(window, options),
    confirm: options => dialog.showMessageBox(window, options) });
  app.on('will-quit', () => mcpFormResources.dispose());
  ipcMain.handle('areal-core:mcp-form-resource', async (event, operation, request) => {
    trusted(event);
    const ownerWindow = window;
    const current = () => { trusted(event); if (window !== ownerWindow || ownerWindow.isDestroyed()) throw new Error('Form window expired'); };
    if (operation === 'pick') return mcpFormResources.pick(request, current);
    if (operation === 'release') return mcpFormResources.release(request, current);
    throw new Error('Invalid form resource operation');
  });
  ipcMain.handle('areal-core:mcp-app', async (event, request) => {
    trusted(event);
    if (!request || typeof request !== 'object') throw new Error('Invalid app request');
    if (request.operation === 'metadataImage') return mcpMetadataImages.load(request.source).catch(() => { throw new Error('Metadata image unavailable'); });
    if (request.operation === 'openGenUi') return mcpApps.openGenUi(request, event.sender.id);
    if (request.operation === 'genUiVisibility') return mcpApps.genUiVisibility(request, event.sender.id);
    if (request.operation === 'openFromResult') return mcpApps.openFromResult(request, event.sender.id);
    if (request.operation === 'open') return mcpApps.open(request, event.sender.id).catch(() => { throw new Error('MCP App could not be opened'); });
    if (request.operation === 'request') return mcpApps.request(request.token, request.request, event.sender.id).catch(() => { throw new Error('MCP App request rejected or incomplete'); });
    if (request.operation === 'pageToolsReady') return mcpApps.pageToolsReady(request.token, request.mountId, request.declaration, event.sender.id);
    if (request.operation === 'pageToolsUnmount') return mcpApps.pageToolsUnmount(request.token, request.mountId, event.sender.id);
    if (request.operation === 'pageToolResult') return mcpApps.pageToolResult(request.token, request.mountId, request.callId, request.reply, event.sender.id);
    if (request.operation === 'close') return mcpApps.close(request.token, event.sender.id);
    throw new Error('Unsupported app operation');
  });
  ipcMain.handle('areal-core:preview', async (event, request) => {
    trustedSender(event);
    validatePreview(request);
    if (quitting) {
      if (preview?.suppressedPresentation && request.operation === 'show') return null;
      throw new Error(nativeText('boundary.quitting'));
    }
    if (!preview) throw new Error(nativeText('browser.previewUnavailable'));
    if (request?.operation === 'subscribe') {
      if (!backend.ownsThread(request.projectId, request.threadId)) throw new Error(nativeText('browser.selectTask'));
      const key = JSON.stringify([request.projectId, request.threadId]);
      previewSubscriptions.get(key)?.();
      const subscription = preview.subscribe(request.projectId, request.threadId, update => {
        if (!window.isDestroyed()) window.webContents.send('areal-core:preview-event', update);
      });
      previewSubscriptions.set(key, subscription.unsubscribe);
      return subscription.snapshot;
    }
    if (request?.operation === 'unsubscribe') {
      const key = JSON.stringify([request.projectId, request.threadId]);
      previewSubscriptions.get(key)?.(); previewSubscriptions.delete(key);
      return null;
    }
    if (browserWindowClosed && ['show', 'newPage', 'navigate', 'reload'].includes(request?.operation))
      throw new Error(nativeText('browser.windowClosed'));
    if (request?.operation === 'claim') {
      const identity = await preview.claim(request.projectId, request.threadId, request.pageId);
      const currentClaimPage = () => {
        const page = preview.page(request.projectId, request.threadId, request.pageId);
        return page && preview.pageStillOwned(page) && page.view && !page.view.webContents.isDestroyed()
          && page.control === 'agent' && page.coreInstanceId === identity.coreInstanceId
          && preview.browserHostId === identity.browserHostId && preview.hostGeneration === identity.hostGeneration
          && page.pageGeneration === identity.pageGeneration && page.controlEpoch === identity.controlEpoch ? page : null;
      };
      try {
        await backend.browserClaim(identity);
        trusted(event);
        if (!currentClaimPage()) throw new Error(nativeText('browser.claimExpired'));
      }
      catch (error) { if (currentClaimPage()) preview.takeover(request.projectId, request.threadId, request.pageId); throw error; }
      return preview.state(preview.page(request.projectId, request.threadId, request.pageId));
    }
    if (request?.operation === 'takeover') {
      const value = preview.takeover(request.projectId, request.threadId, request.pageId);
      void backend.browserRevoke({ projectId: request.projectId, threadId: request.threadId, pageId: request.pageId }).catch(() => {});
      return value;
    }
    return preview.command(request);
  });
  ipcMain.handle('areal-core:notification-target', event => { trusted(event); return notificationTarget; });
  ipcMain.handle('areal-core:notification-consumed', (event, id) => { trusted(event); if (notificationTarget?.id === id) notificationTarget = null; });
  ipcMain.handle('areal-core:snapshot', event => { trusted(event); return desktopSnapshot(); });
  ipcMain.on('areal-core:projection-request', (event, requestId) => {
    try { trusted(event); } catch { return; }
    if (!Number.isSafeInteger(requestId) || requestId <= 0) return;
    let projection = projections.get(event.sender);
    if (!projection || projection.frame !== event.senderFrame) {
      projection = { frame: event.senderFrame, encoder: new ProjectionEncoder(randomUUID()) };
      projections.set(event.sender, projection);
    }
    event.sender.send('areal-core:projection', { requestId, frame: projection.encoder.encode(desktopSnapshot(), true) });
  });
  ipcMain.handle('areal-core:present-ready', event => {
    trusted(event);
    startupReady = true;
    startupPresentTrace?.finish('ok');
    presentStartup();
  });
  ipcMain.handle('areal-core:theme', (event, id) => {
    trusted(event);
    if (id !== undefined) {
      if (id !== 'system' && !themes.some(item => item.id === id)) throw new Error(nativeText('gui.unknownTheme'));
      themeId = id;
    }
    return theme();
  });
  nativeTheme.on('updated', () => window?.webContents.send('areal-core:theme-changed', theme()));
  ipcMain.handle('areal-core:choose-project', async event => {
    trusted(event);
    const result = await dialog.showOpenDialog(window, { title: nativeText('picker.project'), properties: ['openDirectory'] });
    if (result.canceled) return null;
    const path = await realpath(result.filePaths[0]);
    trusted(event);
    return backend.addProject(path);
  });
  ipcMain.handle('areal-core:choose-task-directory', async event => {
    trusted(event);
    const result = await dialog.showOpenDialog(window, { title: nativeText('picker.taskDirectory'), properties: ['openDirectory'] });
    if (result.canceled) return null;
    const cwd = await realpath(result.filePaths[0]);
    if (!(await stat(cwd)).isDirectory()) throw new Error(nativeText('picker.existingDirectory'));
    trusted(event);
    return { cwd };
  });
  ipcMain.handle('areal-core:choose-projectless-directory', async event => {
    trusted(event);
    const result = await dialog.showOpenDialog(window, { title: nativeText('picker.projectlessDirectory'), properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled) return null;
    trusted(event);
    return backend.command('projectless', { operation: 'directory', path: result.filePaths[0] });
  });
  ipcMain.handle('areal-core:file-open', async (event, request) => {
    trusted(event);
    return fileOpen({ backend, shell, home: app.getPath('home'), authorize: () => trusted(event), chooseSave: options => dialog.showSaveDialog(window, options) }, request);
  });
  const pluginArchives = new PluginArchives({ backend, choose: options => dialog.showOpenDialog(window, options) });
  ipcMain.handle('areal-core:command', async (event, name, params) => {
    trusted(event);
    try {
      validateCommand(name, params);
      if (name === 'browserData') {
        const value = await preview.browserData(params.operation, { importChrome: options =>
          require('@areal/browser-data').importChromeBrowserData({ ...options, logger: console }) });
        trusted(event);
        return { ok: true, value };
      }
      if (name === 'computerControl') {
        let value;
        if (computerSelection().provider === 'lcu') {
          if (params.operation === 'status') value = externalCua.status();
          else if (params.operation === 'restart') value = await externalCua.check();
          else if (params.operation === 'stop') { await externalCua.stop('user_stop'); value = externalCua.status(); }
          else throw new Error('LCU installation and OS permissions are managed outside AReaL Harness');
        } else if (params.operation === 'status') value = await computer.status();
        else if (params.operation === 'stop') { await computer.stop('user_stop'); value = await computer.status(); }
        else if (params.operation === 'restart') { await computer.restart(); value = await computer.status(); }
        else {
          if (process.platform !== 'darwin') throw new Error('Computer control is unavailable on this platform');
          if (params.operation === 'requestAccess') value = await computer.requestAccess(params.capability);
          else {
            const panes = { accessibility: 'Privacy_Accessibility', screenRecording: 'Privacy_ScreenCapture', inputMonitoring: 'Privacy_ListenEvent' };
            await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${panes[params.capability]}`);
            value = await computer.status();
          }
        }
        trusted(event);
        if (backend.computerHostOwned !== true) value = { ...value, ready: false, code: 'host_busy', reason: 'Computer control belongs to another GUI window. Reconnect after that host closes.' };
        return { ok: true, value };
      }
      if (name === 'library' && params.operation === 'settings' && ['computerControlEnabled', 'computerControlProvider', 'computerControlExecutable'].includes(params.key)) {
        computerAdmissionSuspended = true;
        try { await stopComputer('configuration_changed'); return { ok: true, value: await backend.command(name, params) }; }
        finally { computerAdmissionSuspended = false; }
      }
      if (name === 'exportDiagnostics') return { ok: true, value: await exportDiagnostics() };
      if (name === 'manage' && ['pluginArchivePick', 'pluginArchiveImport'].includes(params.operation))
        return { ok: true, value: await pluginArchives.command(params, () => trusted(event)) };
      if (name === 'remoteControl') return { ok: true, value: await backend.remoteControl(params) };
      if (name === 'serviceLifecycle') {
        if (params.operation === 'quitInterface') return { ok: true, value: await requestQuit() };
        if (params.operation === 'stopAndQuit') return { ok: true, value: await requestStopAndQuit() };
        const value = params.operation === 'update' ? await backend.applyUpdate({ notify: options => dialog.showMessageBox(window, options) })
          : params.operation === 'stop' ? await requestStopService()
          : params.operation === 'recover' ? await backend.recoverBackend({ notify: options => dialog.showMessageBox(window, options) }) : await backend.checkLifecycle();
        return { ok: true, value };
      }
      if (name === 'serviceStatus') return { ok: true, value: await backend.serviceStatus() };
      if (name === 'stopService') return { ok: true, value: await requestStopService() };
      if (name === 'recoverResources') return { ok: true, value: await backend.recoverBackend({ notify: options => dialog.showMessageBox(window, options) }) };
      if (name === 'connectService') { await backend.init(); return { ok: true, value: null }; }
      if (name === 'manage' && params.operation === 'archive') {
        const answer = await dialog.showMessageBox(window, { type: 'question', message: nativeText('archive.question'), detail: nativeText('archive.detail'), buttons: [nativeText('common.cancel'), nativeText('archive.confirm')], defaultId: 0, cancelId: 0 });
        if (answer.response !== 1) return { ok: true, value: { canceled: true } };
      }
      if (name === 'export') {
        await backend.command('open', params);
        const project = backend.snapshot().projects.find(item => item.id === params.projectId);
        const thread = project?.state?.threads[params.threadId];
        if (!thread) throw new Error(nativeText('export.selectConversation'));
        const result = await dialog.showSaveDialog(window, { title: nativeText('export.title'), defaultPath: `areal-${thread.id}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
        if (result.canceled || !result.filePath) return { ok: true, value: { canceled: true } };
        await writeFile(result.filePath, JSON.stringify({ format: 'areal-harness-thread-v1', exportedAt: new Date().toISOString(), project: { id: project.id, root: project.root }, thread, queue: project.state.queues[thread.id] }, null, 2), { mode: 0o600 });
        return { ok: true, value: { path: result.filePath } };
      }
      trusted(event);
      const value = await backend.command(name, params);
      // Renderer records the selected conversation before requesting its
      // authoritative snapshot. Checkpoint that existing DOMStorage after the
      // open succeeds so a forced GUI exit can retain the accepted navigation.
      if (name === 'open' && window && !window.isDestroyed() && event.sender === window.webContents)
        event.sender.session.flushStorageData();
      if (name === 'manage') mcpMetadataImages.remember(params, value);
      if (name === 'manage' && params.operation === 'pluginAuth' && params.authOperation === 'start' && value?.status === 'pending') {
        const authUrl=new URL(value.authorizationUrl);
        if (authUrl.protocol !== 'https:' && !(authUrl.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(authUrl.hostname))) throw new Error(nativeText('auth.unsupportedUrl'));
        try { await shell.openExternal(authUrl.href); }
        catch { throw new Error(nativeText('auth.openFailed')); }
      }
      if (name === 'chatgpt' && params.operation === 'login') {
        try { await shell.openExternal(value.authUrl); }
        catch { await backend.command('chatgpt', { operation: 'cancel', provider: params.provider }); throw new Error(nativeText('auth.chatgptOpenFailed')); }
      }
      return { ok: true, value };
    }
    catch (error) { return { ok: false, error: desktopError(error) }; }
  });
  let recoveryPending = 0;
  const hasUpdateWork = async () => {
    const lifecycle = backend.snapshot().lifecycle;
    const unsettled = lifecycle?.phase === 'admissionUnconfirmed'
      || lifecycle?.operations?.some(operation => !['completed', 'blocked'].includes(operation.phase));
    return recoveryPending > 0 || unsettled || !backend.serviceExited && !(await backend.observeLifecycle()).ifIdle;
  };
  const recoverInstall = async () => {
    recoveryPending++;
    try { await recoverConnectedService({ backend, notify: options => dialog.showMessageBox(window, options), purpose: 'update', forUpdate: true }); }
    finally {
      recoveryPending--;
      if (recoveryPending === 0 && updates?.state().status === 'deferred') void updates.install();
    }
  };
  updates = setupUpdater({ recoverInstall, hasWork: hasUpdateWork,
    onState: state => { if (window && !window.isDestroyed()) window.webContents.send('areal-core:update-changed', state); },
    prepareInstall: async () => {
    if (quitting || await hasUpdateWork()) throw Object.assign(new Error(nativeText('lifecycle.activeWork')), { code: 'LIFECYCLE_BLOCKED' });
    const result = await requestQuit('install');
    if (result.stopped !== true) throw Object.assign(new Error(nativeText('lifecycle.installCanceled')), { code: 'LIFECYCLE_BLOCKED' });
  } });
  ipcMain.handle('areal-core:update-state', event => { trusted(event); return updates.state(); });
  ipcMain.handle('areal-core:update-download', event => { trusted(event); void updates.download(); return updates.state(); });
  ipcMain.handle('areal-core:update-recover-resources', async event => { trusted(event); await recoverInstall(); return updates.state(); });
  const requestStopService = () => recoverConnectedService({ backend,
    notify: options => dialog.showMessageBox(window, options), purpose: 'stop' });

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'AReaL Harness', submenu: [{ role: 'about' }, { label: '检查更新…', click: () => { void updates.check(true); } }, { label: '导出诊断包…', click: async () => { try { await exportDiagnostics(); } catch { dialog.showErrorBox(nativeText('diagnostics.saveFailedTitle'), nativeText('diagnostics.retryLocation')); } } }, { label: '检查后台资源…', click: () => { void backend.checkLifecycle().catch(error => backend.reportLifecycleError(error)); } }, { label: '停止后台 Core 服务…', click: async () => {
      try { await requestStopService(); } catch (error) { backend.reportLifecycleError(error); }
    } }, { type: 'separator' },
    { label: '退出 AReaL Harness', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }] },
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]));
  // 后台连接与隐藏首屏并行；状态由快照展示，启动不触发维护弹窗。
  const windowLoaded = createWindow();
  const serviceStarted = (async () => {
    const trace = startupTrace('gui.backend_init');
    trace.advance('initialize');
    try {
      await backend.init({ automatic: true });
      trace.advance('initial_project');
      if (backend.status.connected && process.env.AREAL_CORE_WORKSPACE) await backend.addProject(process.env.AREAL_CORE_WORKSPACE);
      trace.finish(backend.status.connected ? 'ok' : 'skipped');
    } catch (error) { trace.finish('error', error); } /* 错误由后台连接快照展示，用户显式重试。 */
    publish();
  })();
  await windowLoaded;
  const activityPauses = new Set();
  const sampleActivity = () => backend.analytics.sample({ focused: !!window && !window.isDestroyed() && window.isFocused() && window.isVisible() && !window.isMinimized(), idleSeconds: powerMonitor.getSystemIdleTime(), suspended: activityPauses.size > 0 });
  const activityTimer = setInterval(sampleActivity, 5000);
  const saveTimer = setInterval(() => { void backend.analytics.flush(); }, 30000);
  for (const event of ['focus', 'blur', 'hide', 'minimize', 'restore']) window.on(event, sampleActivity);
  for (const event of ['suspend', 'lock-screen']) powerMonitor.on(event, () => { computerSystemPaused = true; void stopComputer(event).catch(() => {}); sampleActivity(); activityPauses.add(event); sampleActivity(); void backend.analytics.flush(); });
  for (const [event, pause] of [['resume', 'suspend'], ['unlock-screen', 'lock-screen']]) powerMonitor.on(event, () => { activityPauses.delete(pause); computerSystemPaused = activityPauses.size > 0; sampleActivity(); });
  app.on('before-quit', () => { sampleActivity(); void backend.analytics.flush(); });
  app.on('will-quit', () => { clearInterval(activityTimer); clearInterval(saveTimer); });
  sampleActivity();
  await serviceStarted;
  sampleActivity();
}).catch(error => { startupTraceMain.finish('error', error); if (error.code !== 'STARTUP_CANCELLED') { console.error(error); dialog.showErrorBox(nativeText('gui.startupFailed'), error.message); } diagnostics.record({ type: 'exit-requested', exitCode: error.code === 'STARTUP_CANCELLED' ? 0 : 1 }); app.exit(error.code === 'STARTUP_CANCELLED' ? 0 : 1); });

app.on('activate', revealWindow);
app.on('window-all-closed', () => {});
app.on('before-quit', event => {
  if (exitReady) return;
  event.preventDefault();
  if (quitting) return;
  void requestQuit().catch(error => { backend?.reportLifecycleError(error); revealWindow(); });
});
