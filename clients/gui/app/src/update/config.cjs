'use strict';
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const githubRepository = 'areal-project/AReaL-Harness';
const githubFeedUrl = `https://github.com/${githubRepository}/releases/download/gui-update-channel/`;
const githubReleaseUrl = `https://github.com/${githubRepository}/releases/download`;
const githubTestFeedUrl = `${githubReleaseUrl}/update-test-channel/`;
const githubSparkleTestFeedUrl = `${githubReleaseUrl}/update-test-sparkle-channel/`;
function validateFeedUrl(value, { development = false } = {}) {
  const url = new URL(value);
  const local = development && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)
    && url.pathname.endsWith('/releases/latest/download/');
  const testTag = url.href.startsWith(`${githubReleaseUrl}/`) ? url.pathname.split('/').at(-2) : '';
  const github = url.href === githubFeedUrl || url.href === githubTestFeedUrl || url.href === githubSparkleTestFeedUrl || (testTag?.startsWith('update-test-v')
    && stableVersion(testTag.slice('update-test-v'.length)) && url.href === `${githubReleaseUrl}/${testTag}/`);
  if ((!local && !github) || url.username || url.password || url.search || url.hash) {
    throw new Error('更新源必须是 areal-project/AReaL-Harness 的 GUI 更新频道或隔离测试 Release');
  }
  return url.href;
}
function releaseAssetUrl(feedUrl, version) {
  const feed = new URL(feedUrl);
  const test = feed.pathname.split('/').at(-2)?.startsWith('update-test');
  const tag = `${test ? 'update-test-v' : 'gui-v'}${version}`;
  if (test && feedUrl !== githubTestFeedUrl && feedUrl !== githubSparkleTestFeedUrl && feedUrl !== `${githubReleaseUrl}/${tag}/`) throw new Error('测试更新版本必须匹配隔离 Release');
  const root = feed.protocol === 'http:' ? feedUrl.slice(0, -'/latest/download/'.length) + '/download' : githubReleaseUrl;
  return `${root}/${tag}/AReaLHarness-${version}-macos-arm64.zip`;
}
function readUpdateConfig({ packaged, resourcesPath, env = process.env }) {
  const path = join(resourcesPath, 'areal-update.json');
  const stored = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  const value = !packaged && env.AREAL_UPDATE_FEED_URL ? env.AREAL_UPDATE_FEED_URL : stored?.feedUrl;
  if (!value) return null;
  if (stored?.engine && stored.engine !== 'electron') throw new Error('此客户端未配置原生更新分发');
  return { feedUrl: validateFeedUrl(value, { development: !packaged }), development: !packaged, engine: stored?.engine };
}
function stableVersion(value) { return typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value); }
function newer(version, current) {
  if (!stableVersion(version) || !stableVersion(current)) return false;
  const a = version.split('.').map(BigInt), b = current.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
function validateUpdate(info, feedUrl, { engine } = {}) {
  if (!stableVersion(info?.version)) throw new Error('更新清单版本无效');
  const expected = releaseAssetUrl(validateFeedUrl(feedUrl, { development: true }), info.version);
  if (info.files?.length !== 1 || info.files[0].url !== expected
    || !Number.isSafeInteger(info.files[0].size) || info.files[0].size <= 0
    || (engine !== 'sparkle' && !/^[A-Za-z0-9+/]{86}==$/.test(info.files[0].sha512 || ''))) {
    throw new Error('更新清单必须指向同一 GitHub Release 版本中的 arm64 ZIP，并包含大小和 SHA-512');
  }
  return info;
}
module.exports = { githubRepository, githubFeedUrl, githubReleaseUrl, githubTestFeedUrl, githubSparkleTestFeedUrl, validateFeedUrl, readUpdateConfig, stableVersion, newer, validateUpdate };
