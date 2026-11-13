// @ts-check
"use strict";
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const githubRepository = "areal-project/AReaL-Harness";
const githubReleaseUrl = `https://github.com/${githubRepository}/releases/download`;
const githubFeedUrl = `${githubReleaseUrl}/gui-update-channel/`;
// Beta 频道清单指向最新 Beta 与最新正式版中较高者；客户端只切换固定地址。
const githubBetaFeedUrl = `${githubReleaseUrl}/gui-beta-channel/`;
const githubTestFeedUrl = `${githubReleaseUrl}/update-test-channel/`;
const githubSparkleTestFeedUrl = `${githubReleaseUrl}/update-test-sparkle-channel/`;
/** @typedef {{feedUrl:string,development:boolean,engine?:string}} UpdateConfig */
/** @param {string} value */
function validateFeedUrl(value, { development = false } = {}) {
  const url = new URL(value);
  const local =
    development &&
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost"].includes(url.hostname) &&
    url.pathname.endsWith("/releases/latest/download/");
  const testTag = url.href.startsWith(`${githubReleaseUrl}/`) ? url.pathname.split("/").at(-2) : "";
  const github =
    url.href === githubFeedUrl ||
    url.href === githubBetaFeedUrl ||
    url.href === githubTestFeedUrl ||
    url.href === githubSparkleTestFeedUrl ||
    (testTag?.startsWith("update-test-v") &&
      releaseVersion(testTag.slice("update-test-v".length)) &&
      url.href === `${githubReleaseUrl}/${testTag}/`);
  if ((!local && !github) || url.username || url.password || url.search || url.hash) {
    throw new Error("更新源必须是 areal-project/AReaL-Harness 的 GUI 更新频道或隔离测试 Release");
  }
  return url.href;
}
/** @param {string} feedUrl @param {string} version */
function releaseAssetUrl(feedUrl, version) {
  const feed = new URL(feedUrl);
  const test = feed.pathname.split("/").at(-2)?.startsWith("update-test");
  const tag = `${test ? "update-test-v" : "gui-v"}${version}`;
  if (
    test &&
    feedUrl !== githubTestFeedUrl &&
    feedUrl !== githubSparkleTestFeedUrl &&
    feedUrl !== `${githubReleaseUrl}/${tag}/`
  )
    throw new Error("测试更新版本必须匹配隔离 Release");
  const root =
    feed.protocol === "http:"
      ? feedUrl.slice(0, -"/latest/download/".length) + "/download"
      : githubReleaseUrl;
  return `${root}/${tag}/AReaLHarness-${version}-macos-arm64.zip`;
}
/** @param {{packaged:boolean,resourcesPath:string,env?:NodeJS.ProcessEnv}} options @returns {UpdateConfig|null} */
function readUpdateConfig({ packaged, resourcesPath, env = process.env }) {
  const path = join(resourcesPath, "areal-update.json");
  /** @type {unknown} */
  const stored = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  if (stored != null && (typeof stored !== "object" || Array.isArray(stored)))
    throw new Error("更新配置无效");
  const feedUrl = stored && "feedUrl" in stored ? stored.feedUrl : undefined;
  const engine = stored && "engine" in stored ? stored.engine : undefined;
  const value = !packaged && env.AREAL_UPDATE_FEED_URL ? env.AREAL_UPDATE_FEED_URL : feedUrl;
  if (!value) return null;
  if (typeof value !== "string") throw new Error("更新源必须是字符串");
  if (engine && engine !== "electron") throw new Error("此客户端未配置原生更新分发");
  return {
    feedUrl: validateFeedUrl(value, { development: !packaged }),
    development: !packaged,
    engine: typeof engine === "string" ? engine : undefined,
  };
}
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*))?$/;
/** 只接受 X.Y.Z 与 X.Y.Z-beta.N。 @param {unknown} value @returns {value is string} */
const releaseVersion = (value) => typeof value === "string" && versionPattern.test(value);
/** @param {unknown} value @returns {value is string} */
const stableVersion = (value) => releaseVersion(value) && !value.includes("-");
/** @param {string} value semver 顺序：同号 Beta 低于正式版。 */
const order = (value) => {
  const [, ...parts] = /** @type {RegExpExecArray} */ (versionPattern.exec(value));
  return [parts[0], parts[1], parts[2], parts[3] ? "0" : "1", parts[3] ?? "0"].map(BigInt);
};
/** @param {unknown} version @param {unknown} current */
function newer(version, current) {
  if (!releaseVersion(version) || !releaseVersion(current)) return false;
  const a = order(version),
    b = order(current);
  const index = a.findIndex((part, i) => part !== b[i]);
  return index >= 0 && a[index] > b[index];
}
/** @param {UpdateConfig} config @param {'stable'|'beta'} channel 正式包切到 Beta 频道；测试与本地源保持原地址。 */
const channelFeedUrl = (config, channel) =>
  channel === "beta" && config.feedUrl === githubFeedUrl ? githubBetaFeedUrl : config.feedUrl;
/** @param {import('electron-updater').UpdateInfo} info @param {string} feedUrl @param {{engine?:string}} [options] */
function validateUpdate(info, feedUrl, { engine } = {}) {
  if (!releaseVersion(info?.version)) throw new Error("更新清单版本无效");
  if (feedUrl === githubFeedUrl && !stableVersion(info.version))
    throw new Error("正式更新频道只接受正式版本");
  const expected = releaseAssetUrl(validateFeedUrl(feedUrl, { development: true }), info.version);
  if (
    info.files?.length !== 1 ||
    info.files[0].url !== expected ||
    typeof info.files[0].size !== "number" ||
    !Number.isSafeInteger(info.files[0].size) ||
    info.files[0].size <= 0 ||
    (engine !== "sparkle" && !/^[A-Za-z0-9+/]{86}==$/.test(info.files[0].sha512 || ""))
  ) {
    throw new Error("更新清单必须指向同一 GitHub Release 版本中的 arm64 ZIP，并包含大小和 SHA-512");
  }
  return info;
}
module.exports = {
  githubRepository,
  githubFeedUrl,
  githubBetaFeedUrl,
  githubReleaseUrl,
  githubTestFeedUrl,
  githubSparkleTestFeedUrl,
  validateFeedUrl,
  readUpdateConfig,
  releaseVersion,
  stableVersion,
  channelFeedUrl,
  newer,
  validateUpdate,
};
