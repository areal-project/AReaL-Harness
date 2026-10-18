'use strict';
const { app, dialog, autoUpdater: nativeUpdater } = require('electron');
const { autoUpdater } = require('electron-updater');
const { readUpdateConfig } = require('./config.cjs');
const { createUpdater } = require('./controller.cjs');
// electron-updater serves the verified ZIP on its local proxy. With automatic
// install disabled, explicitly await Squirrel's validation before stopping Core.
function prepareNativeInstall() {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      nativeUpdater.removeListener('update-downloaded', ready);
      nativeUpdater.removeListener('error', failed);
      nativeUpdater.removeListener('update-not-available', unavailable);
    };
    const ready = () => { cleanup(); resolve(); };
    const failed = error => { cleanup(); reject(error); };
    const unavailable = () => failed(new Error('原生更新器未找到可安装的更新，请重试。'));
    nativeUpdater.once('update-downloaded', ready);
    nativeUpdater.once('error', failed);
    nativeUpdater.once('update-not-available', unavailable);
    try { nativeUpdater.checkForUpdates(); } catch (error) { failed(error); }
  });
}
function setupUpdater({ hasWork, prepareInstall, recoverInstall, onState }) {
  let config;
  try { config = readUpdateConfig({ packaged: app.isPackaged, resourcesPath: process.resourcesPath }); }
  catch (error) { console.warn('[areal-update] invalid configuration:', error.message); }
  const updater = autoUpdater;
  const controller = createUpdater({ updater, config, version: app.getVersion(), hasWork, prepareInstall, recoverInstall, onState,
    // 显式准备通过后才能停止后台并安装。
    prepareNativeInstall: onState ? prepareNativeInstall : undefined,
    notify: options => dialog.showMessageBox(options) });
  let startup, periodic, idleRetry;
  if (onState) idleRetry = setInterval(() => { if (controller.state().status === 'deferred') void controller.install(); }, 5000);
  if (app.isPackaged && config && process.env.AREAL_GUI_SMOKE !== '1') {
    startup = setTimeout(() => { void controller.check(); }, 8000);
    periodic = setInterval(() => { void controller.check(); }, 10 * 60 * 1000);
    startup.unref(); periodic.unref();
  }
  app.once('will-quit', () => { clearTimeout(startup); clearInterval(periodic); clearInterval(idleRetry); });
  return controller;
}
module.exports = { setupUpdater };
