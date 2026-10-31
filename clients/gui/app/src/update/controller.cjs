// @ts-check
"use strict";
const { newer, validateUpdate } = require("./config.cjs");

// 下载和摘要校验可保持后台运行；Squirrel 原生准备只在安全停止和占用检查后触发。
/** @typedef {'idle'|'available'|'downloading'|'validating'|'deferred'|'installing'|'error'} UpdateStatus */
/** @typedef {{enabled:boolean,checking:boolean,downloading:boolean,installing:boolean,downloaded?:string,status:UpdateStatus,version?:string,percent:number|null,detail:string}} UpdateState */
/** @typedef {{hasWork:()=>boolean|Promise<boolean>,prepareInstall:()=>Promise<unknown>,recoverInstall?:()=>Promise<unknown>,onState?:(state:UpdateState)=>void}} UpdateLifecycle */
/** @param {UpdateLifecycle & {updater:import('electron-updater').AppUpdater,config?:import('./config.cjs').UpdateConfig|null,version:string,platform?:NodeJS.Platform,arch?:string,notify?:(options:import('electron').MessageBoxOptions)=>Promise<import('electron').MessageBoxReturnValue>,prepareNativeInstall?:()=>Promise<void>,log?:Pick<Console,'warn'>}} options */
function createUpdater({
  updater,
  config,
  version,
  platform = process.platform,
  arch = process.arch,
  notify,
  onState,
  hasWork,
  prepareInstall,
  prepareNativeInstall,
  recoverInstall,
  log = console,
}) {
  const enabled = !!config && platform === "darwin" && arch === "arm64";
  let checking = false,
    downloading = false,
    installing = false,
    installAttempt = false,
    installUnconfirmed = false,
    downloaded = /** @type {import('electron-updater').UpdateInfo|null} */ (null),
    available = /** @type {import('electron-updater').UpdateInfo|null} */ (null);
  let highWater = version,
    status = /** @type {UpdateStatus} */ ("idle"),
    percent = /** @type {number|null} */ (null),
    detail = "";
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowDowngrade = false;
  updater.allowPrerelease = false;
  if (enabled)
    updater.setFeedURL({
      provider: "generic",
      url: config.feedUrl,
      useMultipleRangeRequest: false,
    });
  const state = () => ({
    enabled,
    checking,
    downloading,
    installing,
    downloaded: downloaded?.version,
    status,
    version: downloaded?.version ?? available?.version,
    percent,
    detail,
  });
  const publish = () => onState?.(state());
  /** @param {UpdateStatus} next */
  const set = (next, nextDetail = "") => {
    status = next;
    detail = nextDetail;
    publish();
  };
  /** @param {string} message */
  const message = (message, detail = "") =>
    notify?.({ type: "info", message, detail, buttons: ["确定"] });
  updater.on("download-progress", (progress) => {
    if (!downloading) return;
    percent = Number.isFinite(progress?.percent)
      ? Math.max(0, Math.min(100, progress.percent))
      : null;
    publish();
  });
  updater.on("error", (error) => {
    log.warn("[areal-update]", error.message);
    if (installing) set("error", `更新安装出错，请核对后台状态和版本。${error.message}`);
    else if (downloading) set("error", error.message);
  });
  async function install() {
    if (!downloaded || installing || installAttempt || installUnconfirmed || downloading)
      return state();
    installAttempt = true;
    let prepared = false;
    try {
      if (await hasWork()) {
        set("deferred", "还有活动任务、排队消息或操作，空闲后将自动重启安装。");
        return state();
      }
      if (!onState) {
        const answer = await notify?.({
          type: "question",
          message: `版本 ${downloaded.version} 已下载`,
          detail: "现在重启并安装更新？",
          buttons: ["稍后", "重启安装"],
          defaultId: 0,
          cancelId: 0,
        });
        if (answer?.response !== 1) {
          set("deferred", "更新已下载，可在“检查更新…”中重试安装。");
          return state();
        }
      }
      installing = true;
      set("installing");
      // prepareInstall atomically closes command admission and checks activity again.
      await prepareInstall();
      prepared = true;
      set("validating");
      await prepareNativeInstall?.();
      set("installing");
      updater.quitAndInstall();
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      if (prepared) {
        installing = false;
        installUnconfirmed = true;
        set(
          "error",
          `后台已安全停止，安装准备结果待核对。请退出并重新打开应用后检查版本。${error.message}`,
        );
        // 安全退出进度仍覆盖主窗口，原生提示确保用户能看到重开说明。
        await message("更新安装尚未完成", detail);
        return state();
      }
      installing = false;
      if ("submissionUnknown" in error && error.submissionUnknown) {
        installUnconfirmed = true;
        set(
          "error",
          "后台停止结果待核对，不会重发安装。请检查后台资源后重新打开应用。" + error.message,
        );
        return state();
      }
      if (
        [
          "CORE_RESOURCES",
          "CORE_BUSY",
          "LIFECYCLE_BLOCKED",
          "LIFECYCLE_INCOMPLETE",
          "CONFIRMATION_STALE",
        ].includes("code" in error && typeof error.code === "string" ? error.code : "")
      ) {
        set("deferred", `后台尚未就绪：${error.message}。处理后将自动重试。`);
        if (!onState) {
          const answer = await notify?.({
            type: "warning",
            message: "需要先处理后台状态",
            detail: error.message,
            buttons: ["稍后", "检查后台资源"],
            defaultId: 0,
            cancelId: 0,
          });
          if (answer?.response === 1) await recoverInstall?.();
        }
      } else if (/活动任务|其他操作|完成任务|仍有任务/.test(error.message)) {
        set("deferred", `${error.message}。空闲后将自动重试。`);
      } else {
        set("error", error.message);
        if (!onState) await message("暂时无法安装更新", error.message);
      }
    } finally {
      installAttempt = false;
    }
    return state();
  }
  async function download() {
    if (downloaded) return install();
    if (!enabled || checking || downloading || installing) return state();
    // 首次检查失败时按钮仍走此入口；先恢复检查，发现版本后再由用户确认下载。
    if (!available) return check();
    downloading = true;
    percent = 0;
    set("downloading");
    try {
      await updater.downloadUpdate();
      percent = 100;
      downloaded = available;
      downloading = false;
      percent = 100;
      await install();
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      downloading = false;
      log.warn("[areal-update]", error.message);
      set("error", error.message);
    }
    return state();
  }
  async function check(manual = false) {
    if (checking || downloading || installing) {
      if (manual && !onState) await message("更新操作正在进行", "请等待当前更新操作完成。");
      return state();
    }
    if (!enabled || !config) {
      if (manual)
        await message("更新不可用", "首版仅支持配置了产品更新源的 macOS Apple Silicon 安装包。");
      return state();
    }
    if (downloaded) {
      if (manual) await install();
      return state();
    }
    // electron-updater remembers the latest check target; keep it aligned with the displayed offer.
    if (available) {
      if (manual && !onState) {
        const answer = await notify?.({
          type: "question",
          message: `发现新版本 ${available.version}`,
          detail: "是否下载更新？下载不会中断当前任务。",
          buttons: ["稍后", "下载更新"],
          defaultId: 0,
          cancelId: 0,
        });
        if (answer?.response === 1) await download();
      }
      return state();
    }
    checking = true;
    publish();
    try {
      const result = await updater.checkForUpdates();
      const info = result?.updateInfo;
      if (
        !info ||
        !newer(info.version, version) ||
        (info.version !== highWater && !newer(info.version, highWater))
      ) {
        checking = false;
        set("idle");
        if (manual && !available)
          await message("暂未发现新版本", `当前版本 ${version}，当前更新频道尚无可用的更高版本。`);
        return state();
      }
      validateUpdate(info, config.feedUrl, config);
      highWater = info.version;
      available = info;
      checking = false;
      set("available");
      if (!onState) {
        const answer = await notify?.({
          type: "question",
          message: `发现新版本 ${info.version}`,
          detail: "是否下载更新？下载不会中断当前任务。",
          buttons: ["稍后", "下载更新"],
          defaultId: 0,
          cancelId: 0,
        });
        if (answer?.response === 1) {
          checking = false;
          await download();
        }
      }
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      log.warn("[areal-update]", error.message);
      set("error", error.message);
      if (manual) await message("更新失败", error.message);
    } finally {
      checking = false;
      publish();
    }
    return state();
  }
  return { check, download, install, state };
}
module.exports = { createUpdater };
