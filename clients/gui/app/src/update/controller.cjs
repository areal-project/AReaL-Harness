'use strict';
const { newer, validateUpdate } = require('./config.cjs');

// Electron owns transport, SHA-512 verification and native signature validation.
// Main owns consent and safe shutdown; native staging precedes Core shutdown.
function createUpdater({ updater, config, version, platform = process.platform, arch = process.arch,
  notify, onState, hasWork, prepareInstall, prepareNativeInstall, recoverInstall, log = console }) {
  const enabled = !!config && platform === 'darwin' && arch === 'arm64';
  let checking = false, downloading = false, installing = false, installAttempt = false, downloaded = null, available = null;
  let highWater = version, status = 'idle', percent = null, detail = '';
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowDowngrade = false;
  updater.allowPrerelease = false;
  if (enabled) updater.setFeedURL({ provider: 'generic', url: config.feedUrl, useMultipleRangeRequest: false });
  const state = () => ({ enabled, checking, downloading, installing, downloaded: downloaded?.version,
    status, version: downloaded?.version ?? available?.version, percent, detail });
  const publish = () => onState?.(state());
  const set = (next, nextDetail = '') => { status = next; detail = nextDetail; publish(); };
  const message = (message, detail = '') => notify?.({ type: 'info', message, detail, buttons: ['确定'] });
  updater.on('download-progress', progress => {
    if (!downloading) return;
    percent = Number.isFinite(progress?.percent) ? Math.max(0, Math.min(100, progress.percent)) : null;
    publish();
  });
  updater.on('download-validating', () => {
    if (downloading) { percent = 100; set('validating'); }
  });
  updater.on('error', error => {
    log.warn('[areal-update]', error.message);
    if (installing) set('error', `安装程序已接管重启；若应用没有重新打开，请手动退出并打开。${error.message}`);
    else if (downloading) set('error', error.message);
  });
  async function install() {
    if (!downloaded || installing || installAttempt || downloading) return state();
    installAttempt = true;
    let prepared = false;
    try {
      if (await hasWork()) { set('deferred', '还有活动任务、排队消息或操作，空闲后将自动重启安装。'); return state(); }
      if (!onState) {
        const answer = await notify?.({ type: 'question', message: `版本 ${downloaded.version} 已下载`,
          detail: '现在重启并安装更新？', buttons: ['稍后', '重启安装'], defaultId: 0, cancelId: 0 });
        if (answer?.response !== 1) { set('deferred', '更新已下载，可在“检查更新…”中重试安装。'); return state(); }
      }
      installing = true;
      set('installing');
      // prepareInstall atomically closes command admission and checks activity again.
      await prepareInstall();
      prepared = true;
      updater.quitAndInstall();
    } catch (error) {
      if (prepared) {
        set('error', `安装程序已接管重启；若应用没有重新打开，请手动退出并打开。${error.message}`);
        return state();
      }
      installing = false;
      if (error.code === 'CORE_RESOURCES') {
        set('deferred', `后台资源尚未清理：${error.message}。处理后将自动重试。`);
        if (!onState) {
          const answer = await notify?.({ type: 'warning', message: '需要先处理后台资源', detail: error.message,
            buttons: ['稍后', '检查后台资源'], defaultId: 0, cancelId: 0 });
          if (answer?.response === 1) await recoverInstall?.();
        }
      } else if (/活动任务|其他操作|完成任务|仍有任务/.test(error.message)) {
        set('deferred', `${error.message}。空闲后将自动重试。`);
      } else {
        set('error', error.message);
        if (!onState) await message('暂时无法安装更新', error.message);
      }
    } finally { installAttempt = false; }
    return state();
  }
  async function download() {
    if (downloaded) return install();
    if (!enabled || !available || checking || downloading || installing) return state();
    downloading = true;
    percent = 0;
    set('downloading');
    try {
      await updater.downloadUpdate();
      percent = 100; set('validating');
      // ZIP download is not Squirrel readiness: validate/stage while Core is alive.
      await prepareNativeInstall?.();
      downloaded = available;
      downloading = false;
      percent = 100;
      await install();
    } catch (error) {
      downloading = false;
      log.warn('[areal-update]', error.message);
      set('error', error.message);
    }
    return state();
  }
  async function check(manual = false) {
    if (checking || downloading || installing) {
      if (manual && !onState) await message('更新操作正在进行', '请等待当前更新操作完成。');
      return state();
    }
    if (!enabled) { if (manual) await message('更新不可用', '首版仅支持配置了产品更新源的 macOS Apple Silicon 安装包。'); return state(); }
    if (downloaded) { if (manual) await install(); return state(); }
    // electron-updater remembers the latest check target; keep it aligned with the displayed offer.
    if (available) {
      if (manual && !onState) {
        const answer = await notify?.({ type: 'question', message: `发现新版本 ${available.version}`,
          detail: '是否下载更新？下载不会中断当前任务。', buttons: ['稍后', '下载更新'], defaultId: 0, cancelId: 0 });
        if (answer?.response === 1) await download();
      }
      return state();
    }
    checking = true;
    publish();
    try {
      const result = await updater.checkForUpdates();
      const info = result?.updateInfo;
      if (!info || !newer(info.version, version) || (info.version !== highWater && !newer(info.version, highWater))) {
        if (manual && !available) await message('暂未发现新版本', `当前版本 ${version}，当前更新频道尚无可用的更高版本。`);
        return state();
      }
      validateUpdate(info, config.feedUrl, config);
      highWater = info.version;
      available = info;
      checking = false;
      set('available');
      if (!onState) {
        const answer = await notify?.({ type: 'question', message: `发现新版本 ${info.version}`,
          detail: '是否下载更新？下载不会中断当前任务。', buttons: ['稍后', '下载更新'], defaultId: 0, cancelId: 0 });
        if (answer?.response === 1) { checking = false; await download(); }
      }
    } catch (error) {
      log.warn('[areal-update]', error.message);
      if (manual) await message('更新失败', error.message);
    } finally { checking = false; publish(); }
    return state();
  }
  return { check, download, install, state };
}
module.exports = { createUpdater };
