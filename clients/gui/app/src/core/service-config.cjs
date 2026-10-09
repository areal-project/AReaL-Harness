'use strict';
const { createHash } = require('node:crypto');
const { existsSync, readFileSync, readdirSync, statSync, realpathSync } = require('node:fs');
const { join, dirname, resolve } = require('node:path');
const { resolveCoreBinary, executables } = require('./bundle.cjs');
// 独立应用身份避免接管旧安装；开发版按工作树隔离。
function configureUserData(app, env = process.env) {
  const explicit = env.AREAL_GUI_USER_DATA;
  if (explicit) app.setPath('userData', explicit);
  else if (!app.isPackaged) {
    const checkout = createHash('sha256').update(realpathSync(app.getAppPath())).digest('hex').slice(0, 12);
    app.setPath('userData', join(app.getPath('appData'), 'AReaL Harness GUI Dev', checkout));
  }
  else app.setPath('userData', join(app.getPath('appData'), 'AReaL Harness GUI'));
  return app.getPath('userData');
}
function serviceHome(app) {
  return process.env.AREAL_CORE_HOME || join(app.getPath('userData'), 'areal-core');
}
function serviceOptions(app) {
  return { binary: resolveCoreBinary({ explicit: process.env.AREAL_CORE_BIN || (!app.isPackaged ? resolve(__dirname, '../../../../../target/debug/areal') : undefined), packaged: app.isPackaged, resourcesPath: process.resourcesPath }),
    home: serviceHome(app),
    // macOS Unix socket 长度有限，注册目录不能嵌入较长的 userData 路径。
    harnessHome: process.env.AREAL_HARNESS_HOME || join(app.getPath('home'), '.areal', 'gui', createHash('sha256').update(resolve(serviceHome(app))).digest('hex').slice(0, 12)),
    userHome: process.env.AREAL_CORE_USER_HOME, config: process.env.AREAL_CORE_CONFIG,
    toolExtensions: process.env.AREAL_HARNESS_TOOL_EXTENSIONS,
    workgroupPolicy: process.env.AREAL_CORE_WORKGROUP_POLICY,
    workgroupToolchain: process.env.AREAL_CORE_WORKGROUP_TOOLCHAIN,
    desktopConfig: process.env.AREAL_CORE_DESKTOP_CONFIG || join(__dirname, 'desktop-profile.json'),
    desktopProcesses: true, defaultProfile: !process.env.AREAL_CORE_DESKTOP_CONFIG ? { id: 'areal-standard', revision: 'v1' } : undefined };
}
async function serviceIdentity(options) {
  const hash = createHash('sha256');
  // Source changes must not silently attach a new GUI to old backend code. GUI
  // assets are deliberately excluded. Binary stamps also cover sibling helpers.
  for (const name of readdirSync(__dirname).filter(n => /\.(cjs|json)$/.test(n)).sort()) hash.update(name).update(readFileSync(join(__dirname, name)));
  const subscriptionRoot = dirname(require.resolve('@areal/chatgpt-provider/package.json'));
  for (const name of readdirSync(subscriptionRoot).filter(n => /\.(js|json)$/.test(n)).sort()) hash.update(name).update(readFileSync(join(subscriptionRoot, name)));
  const { CoreClient, CoreRpcError } = await import('@areal/runtime-client/core');
  hash.update(CoreClient.toString()).update(CoreRpcError.toString());
  hash.update(readFileSync(require.resolve('@areal/workbench/core-model')));
  hash.update(readFileSync(require.resolve('@areal/workbench/desktop-contract')));
  hash.update(readFileSync(require.resolve('@areal/remote')));
  hash.update(readFileSync(require.resolve('../workspace-files')));
  hash.update(readFileSync(require.resolve('@areal/workspace-git')));
  for (const name of executables) {
    const packagedHelper = join(dirname(options.binary), '..', 'libexec', 'areal', name);
    const path = name !== 'areal' && existsSync(packagedHelper)
      ? packagedHelper : join(dirname(options.binary), name);
    try { const stat = statSync(path); hash.update(JSON.stringify([realpathSync(path), stat.size, stat.mtimeMs])); }
    catch (e) { if (name === 'areal') throw e; hash.update(name + ':absent'); }
  }
  // Core owns mutable model configuration and its revisions. Saving it must
  // not make a later window incompatible with the still-running service;
  // applying pending configuration retains the explicit safe restart path.
  hash.update(JSON.stringify({ config: options.config ? realpathSync(options.config) : null }));
  for (const path of [options.desktopConfig, options.workgroupPolicy]) if (path) hash.update(readFileSync(path));
  if (options.workgroupToolchain) hash.update(realpathSync(options.workgroupToolchain));
  hash.update(JSON.stringify({ harnessHome: options.harnessHome, userHome: options.userHome, toolExtensions: options.toolExtensions, desktopProcesses: options.desktopProcesses, defaultProfile: options.defaultProfile }));
  return hash.digest('hex');
}
module.exports = { configureUserData, serviceHome, serviceOptions, serviceIdentity };
