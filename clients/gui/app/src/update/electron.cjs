// @ts-check
"use strict";
const { app, dialog, autoUpdater: nativeUpdater } = require("electron");
const { autoUpdater } = require("electron-updater");
const { readUpdateConfig } = require("./config.cjs");
const { createUpdater } = require("./controller.cjs");
const { prepareNativeInstall } = require("./native-ready.cjs");
// Squirrel 原生准备会安排退出安装，必须在安全停止和占用检查通过后调用。
/** @param {import('./controller.cjs').UpdateLifecycle} options */
function setupUpdater({ hasWork, prepareInstall, recoverInstall, onState }) {
  let config;
  try {
    config = readUpdateConfig({ packaged: app.isPackaged, resourcesPath: process.resourcesPath });
  } catch (error) {
    console.warn(
      "[areal-update] invalid configuration:",
      error instanceof Error ? error.message : String(error),
    );
  }
  const updater = autoUpdater;
  const controller = createUpdater({
    updater,
    config,
    version: app.getVersion(),
    hasWork,
    prepareInstall,
    recoverInstall,
    onState,
    // 由控制器在安全停止之后触发原生准备，避免拒绝安装后仍在退出时替换。
    prepareNativeInstall: onState ? () => prepareNativeInstall(nativeUpdater) : undefined,
    notify: (options) => dialog.showMessageBox(options),
  });
  /** @type {NodeJS.Timeout|undefined} */ let startup;
  /** @type {NodeJS.Timeout|undefined} */ let periodic;
  /** @type {NodeJS.Timeout|undefined} */ let idleRetry;
  if (onState)
    idleRetry = setInterval(() => {
      if (controller.state().status === "deferred") void controller.install();
    }, 5000);
  if (app.isPackaged && config && process.env.AREAL_GUI_SMOKE !== "1") {
    startup = setTimeout(() => {
      void controller.check();
    }, 8000);
    periodic = setInterval(
      () => {
        void controller.check();
      },
      10 * 60 * 1000,
    );
    startup.unref();
    periodic.unref();
  }
  app.once("will-quit", () => {
    clearTimeout(startup);
    clearInterval(periodic);
    clearInterval(idleRetry);
  });
  return controller;
}
module.exports = { setupUpdater };
