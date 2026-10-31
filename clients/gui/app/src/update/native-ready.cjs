// @ts-check
"use strict";

// 原生准备可能已经安排退出安装；所有终态释放监听器，失败交由控制器核对。
/** @param {import("electron").AutoUpdater} nativeUpdater @returns {Promise<void>} */
function prepareNativeInstall(nativeUpdater, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      nativeUpdater.removeListener("update-downloaded", ready);
      nativeUpdater.removeListener("error", failed);
      nativeUpdater.removeListener("update-not-available", unavailable);
    };
    const ready = () => {
      cleanup();
      resolve();
    };
    /** @param {unknown} error */
    const failed = (error) => {
      cleanup();
      reject(error);
    };
    const unavailable = () => failed(new Error("原生更新器未确认可安装的更新。"));
    const timer = setTimeout(() => failed(new Error("原生更新准备超时，结果待核对。")), timeoutMs);
    nativeUpdater.once("update-downloaded", ready);
    nativeUpdater.once("error", failed);
    nativeUpdater.once("update-not-available", unavailable);
    try {
      nativeUpdater.checkForUpdates();
    } catch (error) {
      failed(error);
    }
  });
}

module.exports = { prepareNativeInstall };
