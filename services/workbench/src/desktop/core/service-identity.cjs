// @ts-check
"use strict";
const { createHash } = require("node:crypto");
const {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  createReadStream,
} = require("node:fs");
const { join, dirname, basename, resolve } = require("node:path");
const { homedir } = require("node:os");
const { executables } = require("./bundle.cjs");
/** @param {string} path */
function configurationIdentity(path) {
  // 默认文件可以尚不存在；规范已有祖先，使首次保存和目录别名不改变身份。
  const suffix = [];
  for (let current = resolve(path); ;) {
    try {
      return join(realpathSync(current), ...suffix);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        (error.code !== "ENOENT" && error.code !== "ENOTDIR")
      )
        throw error;
    }
    const parent = dirname(current);
    if (parent === current) return resolve(path);
    suffix.unshift(basename(current));
    current = parent;
  }
}
/** @param {import('./backend.cjs').CoreBackendOptions & {configHome?:string}} options */
async function serviceIdentity(options) {
  const hash = createHash("sha256");
  for (const name of readdirSync(__dirname)
    .filter((n) => /\.(cjs|json)$/.test(n))
    .sort())
    hash.update(name).update(readFileSync(join(__dirname, name)));
  const subscriptionRoot = dirname(require.resolve("@areal/chatgpt-provider/package.json"));
  for (const name of readdirSync(subscriptionRoot)
    .filter((n) => /\.(js|json)$/.test(n))
    .sort())
    hash.update(name).update(readFileSync(join(subscriptionRoot, name)));
  const { HostCoreClient } = require("@areal/workbench-service/host-core-client");
  const { CoreRpcError } = require("@areal/runtime-client/errors");
  hash.update(HostCoreClient.toString()).update(CoreRpcError.toString());
  hash.update(readFileSync(require.resolve("@areal/runtime-client/capabilities")));
  hash.update(readFileSync(require.resolve("@areal/workbench/core-model")));
  hash.update(readFileSync(require.resolve("@areal/workbench/core-model-contract")));
  hash.update(readFileSync(require.resolve("@areal/workbench/desktop-contract")));
  // 入口只负责转接；拆分协议同样决定旧后台能否接收新界面的请求。
  const contracts = join(
    dirname(require.resolve("@areal/workbench/desktop-contract")),
    "desktop-contract",
  );
  /** @param {string} directory */
  function hashContracts(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name, "en"),
    )) {
      const path = join(directory, entry.name);
      hash.update(entry.name);
      if (entry.isDirectory()) hashContracts(path);
      else if (entry.isFile() && /\.(cjs|js|json)$/.test(entry.name))
        hash.update(readFileSync(path));
    }
  }
  hashContracts(contracts);
  // 迁出 Main 的领域仍决定后台部署身份，保留进程不能漏判业务更新。
  hashContracts(dirname(require.resolve("@areal/workbench-service/feedback")));
  hashContracts(dirname(require.resolve("@areal/workbench-service/host-library-store")));
  hash.update(readFileSync(require.resolve("@areal/workbench/state-projection")));
  hash.update(readFileSync(require.resolve("@areal/remote")));
  hash.update(readFileSync(require.resolve("../workspace-files.js")));
  hash.update(readFileSync(require.resolve("@areal/workspace-git")));
  hash.update(readFileSync(require.resolve("@areal/gen-ui/node")));
  hash.update(
    readFileSync(
      join(dirname(require.resolve("@areal/workspace-git/package.json")), "worktrees.js"),
    ),
  );
  for (const name of executables) {
    const packagedHelper = join(dirname(options.binary), "..", "libexec", "areal", name);
    const path =
      name !== "areal" && existsSync(packagedHelper)
        ? packagedHelper
        : join(dirname(options.binary), name);
    let actual;
    try {
      actual = realpathSync(path);
    } catch (e) {
      if (
        name === "areal" ||
        !(e instanceof Error) ||
        !("code" in e) ||
        (e.code !== "ENOENT" && e.code !== "ENOTDIR")
      )
        throw e;
      hash.update(name + ":absent");
      continue;
    }
    hash.update(JSON.stringify([actual]));
    const content = createHash("sha256");
    for await (const chunk of createReadStream(actual)) content.update(chunk);
    hash.update(content.digest());
  }
  // Core owns mutable model configuration and its revisions. Saving it must
  // not make a later window incompatible with the still-running service;
  // applying pending configuration retains the explicit safe restart path.
  const configHome =
    options.configHome ||
    resolve(process.env.AREAL_HARNESS_HOME || join(options.userHome || homedir(), ".areal"));
  hash.update(
    JSON.stringify({
      config: configurationIdentity(options.config || join(configHome, "config.toml")),
      configHome: configurationIdentity(configHome),
    }),
  );
  for (const path of [options.desktopConfig, options.workgroupPolicy])
    if (path) hash.update(readFileSync(path));
  if (options.workgroupToolchain) hash.update(realpathSync(options.workgroupToolchain));
  hash.update(
    JSON.stringify({
      harnessHome: options.harnessHome,
      hostHome: options.hostHome,
      guiProfile: options.guiProfile,
      userHome: options.userHome,
      toolExtensions: options.toolExtensions,
      sandboxProfile: options.sandboxProfile || "full-access",
      desktopProcesses: options.desktopProcesses,
      defaultProfile: options.defaultProfile,
    }),
  );
  return hash.digest("hex");
}
module.exports = { serviceIdentity };
