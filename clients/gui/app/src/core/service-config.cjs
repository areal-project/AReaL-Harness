// @ts-check
"use strict";
const { createHash } = require("node:crypto");
const { realpathSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { homedir } = require("node:os");
const { resolveCoreBinary } = require("@areal/workbench-service/desktop/core/bundle.cjs");
// 独立应用身份避免接管旧安装；开发版按工作树隔离。
/** @param {import('electron').App} app @param {NodeJS.ProcessEnv} [env] */
function configureUserData(app, env = process.env) {
  const explicit = env.AREAL_GUI_USER_DATA;
  if (explicit) app.setPath("userData", explicit);
  else if (!app.isPackaged) {
    const checkout = createHash("sha256")
      .update(realpathSync(app.getAppPath()))
      .digest("hex")
      .slice(0, 12);
    app.setPath("userData", join(app.getPath("appData"), "AReaL Harness GUI Dev", checkout));
  } else app.setPath("userData", join(app.getPath("appData"), "AReaL Harness GUI"));
  return app.getPath("userData");
}
/** @param {import('electron').App} app */
function serviceHome(app) {
  return process.env.AREAL_CORE_HOME || join(app.getPath("userData"), "areal-core");
}
/** @param {import('electron').App} app */
function serviceOptions(app) {
  // 配置文件参与后台身份；环境变量选择也必须固定，避免新窗口复用另一份配置的后台。
  const config = process.env.AREAL_CORE_CONFIG || process.env.AREAL_HARNESS_CONFIG;
  const configHome = resolve(
    process.env.AREAL_HARNESS_HOME || join(process.env.AREAL_CORE_USER_HOME || homedir(), ".areal"),
  );
  return {
    binary: resolveCoreBinary({
      explicit:
        process.env.AREAL_CORE_BIN ||
        (!app.isPackaged ? resolve(__dirname, "../../../../../target/debug/areal") : undefined),
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    }),
    home: serviceHome(app),
    guiProfile: app.getPath("userData"),
    hostHome: resolve(
      process.env.AREAL_HARNESS_SERVICE_HOME ||
        process.env.AREAL_HARNESS_HOME ||
        join(process.env.AREAL_CORE_USER_HOME || homedir(), ".areal"),
    ),
    applicationOwner: process.env.AREAL_GUI_OWNER
      ? require("@areal/workbench-service/desktop/core/application-owner.cjs").parseOwner(
          process.env.AREAL_GUI_OWNER,
        )
      : undefined,
    // macOS Unix socket 长度有限，注册目录不能嵌入较长的 userData 路径。
    harnessHome:
      process.env.AREAL_HARNESS_SERVICE_HOME ||
      process.env.AREAL_HARNESS_HOME ||
      join(
        app.getPath("home"),
        ".areal",
        "gui",
        createHash("sha256")
          .update(resolve(serviceHome(app)))
          .digest("hex")
          .slice(0, 12),
      ),
    userHome: process.env.AREAL_CORE_USER_HOME,
    config: config ? resolve(config) : undefined,
    configHome,
    toolExtensions: process.env.AREAL_HARNESS_TOOL_EXTENSIONS,
    sandboxProfile: process.env.AREAL_CORE_SANDBOX_PROFILE,
    workgroupPolicy: process.env.AREAL_CORE_WORKGROUP_POLICY,
    workgroupToolchain: process.env.AREAL_CORE_WORKGROUP_TOOLCHAIN,
    desktopConfig:
      process.env.AREAL_CORE_DESKTOP_CONFIG ||
      require.resolve("@areal/workbench-service/desktop/core/desktop-profile.json"),
    desktopProcesses: true,
    defaultProfile: !process.env.AREAL_CORE_DESKTOP_CONFIG
      ? { id: "areal-standard", revision: "v1" }
      : undefined,
  };
}
const { serviceIdentity } = require("@areal/workbench-service/desktop/core/service-identity.cjs");
module.exports = { configureUserData, serviceHome, serviceOptions, serviceIdentity };
