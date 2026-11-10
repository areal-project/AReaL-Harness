// @ts-check
"use strict";
const { execFile, execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { lstatSync, readFileSync, realpathSync, statSync } = require("node:fs");
const { isAbsolute, join, sep } = require("node:path");
const { resolveCoreBinary } = require("./bundle.cjs");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);

/** @param {NodeJS.ProcessEnv} env @param {string[]} sources */
function isolatedTest(env, sources) {
  if (!env.AREAL_SPACES_TEST_ROOT) return false;
  const root = env.AREAL_SPACES_TEST_ROOT;
  const metadata = statSync(root);
  const markerPath = join(root, ".areal-test-space-root.json");
  const marker = lstatSync(markerPath);
  if (
    realpathSync(root) !== root ||
    !metadata.isDirectory() ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o077) !== 0 ||
    !marker.isFile() ||
    marker.uid !== metadata.uid ||
    (marker.mode & 0o077) !== 0 ||
    JSON.stringify(JSON.parse(readFileSync(markerPath, "utf8"))) !==
      JSON.stringify({ version: 1, testOnly: true }) ||
    sources.some((source) => !realpathSync(source).startsWith(root + sep))
  )
    throw new Error("Invalid isolated upgrade test root");
  return true;
}

/** @param {string} binary @param {string[]} args @param {NodeJS.ProcessEnv} env */
function command(binary, args, env) {
  const output = execFileSync(binary, ["space", ...args], {
    env,
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(output);
}

/** @param {string} binary @param {string[]} args @param {NodeJS.ProcessEnv} env */
async function commandAsync(binary, args, env) {
  const { stdout } = await execFileAsync(binary, ["space", ...args], {
    env,
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout);
}

/** 仅 CLI 校验过的活动空间可影响原生启动路径。
 * @param {import('electron').App} app
 * @param {NodeJS.ProcessEnv} env
 * @param {typeof import('@areal/workbench-service/desktop/core/bundle.cjs').resolveCoreBinary} [resolveBinary]
 */
function selectActiveSpace(app, env, resolveBinary = resolveCoreBinary) {
  const test = env.AREAL_SPACES_TEST_ROOT
    ? isolatedTest(
        env,
        [env.AREAL_GUI_USER_DATA, env.AREAL_CORE_HOME, env.AREAL_HARNESS_HOME].filter(
          (value) => typeof value === "string",
        ),
      )
    : false;
  if (
    (!app.isPackaged && !test) ||
    (!test &&
      (env.AREAL_GUI_USER_DATA ||
        env.AREAL_CORE_HOME ||
        env.AREAL_CORE_USER_HOME ||
        env.AREAL_HARNESS_HOME ||
        env.AREAL_HARNESS_SERVICE_HOME))
  )
    return;
  const binary = resolveBinary({
    explicit: env.AREAL_CORE_BIN,
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  });
  let space;
  try {
    const active = command(binary, ["active"], env);
    if (active?.spaceId == null) return;
    space = command(binary, ["resolve", "--space-id", active.spaceId], env);
    if (
      space?.spaceId !== active.spaceId ||
      space?.manifestDigest !== active.manifestDigest ||
      ![space.profile, space.coreHome, space.hostHome, space.configHome].every(
        (value) => typeof value === "string" && isAbsolute(value),
      )
    )
      throw new Error("Active space identity is unavailable");
  } catch {
    env.AREAL_SPACE_BOOTSTRAP_ERROR = "1";
    return;
  }
  env.AREAL_GUI_USER_DATA = space.profile;
  env.AREAL_CORE_HOME = space.coreHome;
  env.AREAL_HARNESS_HOME = space.hostHome;
  env.AREAL_HARNESS_SERVICE_HOME = space.hostHome;
  env.AREAL_SPACE_ID = space.spaceId;
  delete env.AREAL_CORE_CONFIG;
  delete env.AREAL_HARNESS_CONFIG;
  delete env.AREAL_CORE_WORKSPACE;
  return space.profile;
}

/** @param {{app:import('electron').App,dialog:typeof import('electron').dialog,binary:string,profile:string,coreHome:string,hostHome:string,startupError:unknown}} options */
async function prepareUpgrade(options) {
  if (process.env.AREAL_SPACE_BOOTSTRAP_ERROR === "1")
    throw new Error(
      options.app.getLocale().toLowerCase().startsWith("zh")
        ? "新空间状态无法确认，请检查数据目录后重试。"
        : "The new space could not be verified. Check its data directory and try again.",
    );
  const test = process.env.AREAL_SPACES_TEST_ROOT
    ? isolatedTest(process.env, [options.profile, options.coreHome, options.hostHome])
    : false;
  if (
    process.env.AREAL_SPACE_ID ||
    (!test &&
      (process.env.AREAL_GUI_USER_DATA ||
        process.env.AREAL_CORE_HOME ||
        process.env.AREAL_CORE_USER_HOME ||
        process.env.AREAL_HARNESS_HOME ||
        process.env.AREAL_HARNESS_SERVICE_HOME)) ||
    (!options.app.isPackaged && !test)
  ) {
    if (options.startupError) throw options.startupError;
    return false;
  }
  const source = [
    "--source-profile",
    options.profile,
    "--source-core-home",
    options.coreHome,
    "--source-host-home",
    options.hostHome,
  ];
  let status;
  try {
    status = await commandAsync(options.binary, ["preflight", ...source], process.env);
  } catch {
    status = { kind: "blocked" };
  }
  if (status?.kind === "normal") {
    if (options.startupError) throw options.startupError;
    return false;
  }
  if (!["upgradeRequired", "blocked"].includes(status?.kind))
    throw new Error("Upgrade status is unavailable");
  const chinese = options.app.getLocale().toLowerCase().startsWith("zh");
  const choice = await options.dialog.showMessageBox({
    type: "info",
    message: chinese ? "开始使用新版" : "Start using the new version",
    detail: chinese
      ? "旧后台状态尚未确认。可以创建独立空工作区，检查模型配置后开始新会话。旧项目、历史和任务会保留。"
      : "The previous backend state is not confirmed. Create a separate empty workspace and check your model settings to start a new conversation. Existing projects, history and tasks are retained.",
    buttons: chinese ? ["创建独立空间", "稍后处理"] : ["Create separate space", "Not now"],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice.response !== 0) {
    if (options.startupError) throw options.startupError;
    return false;
  }
  // 相同来源反复启动必须查询同一准备事务，不能因响应丢失创建第二空间。
  const bytes = createHash("sha256").update(JSON.stringify(source)).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  while (true) {
    try {
      await commandAsync(options.binary, ["prepare", "--request-id", id, ...source], process.env);
      await commandAsync(options.binary, ["activate", "--space-id", id], process.env);
      break;
    } catch {
      const retry = await options.dialog.showMessageBox({
        type: "warning",
        message: chinese ? "新空间尚未准备好" : "The new space is not ready",
        detail: chinese
          ? "可以检查原准备请求后重试，或稍后再处理。旧数据仍然保留。"
          : "You can check the original preparation request and retry, or continue later. Previous data is retained.",
        buttons: chinese ? ["重试", "稍后处理"] : ["Retry", "Not now"],
        defaultId: 0,
        cancelId: 1,
      });
      if (retry.response !== 0) {
        options.app.exit(0);
        return true;
      }
    }
  }
  options.app.relaunch();
  options.app.exit(0);
  return true;
}
/** @param {import('electron').App} app @param {typeof import('electron').dialog} dialog @param {(app:import('electron').App)=>{binary:string,guiProfile:string,home:string,hostHome:string}} getOptions @param {unknown} startupError */
function upgrade(app, dialog, getOptions, startupError) {
  const options = getOptions(app);
  return prepareUpgrade({
    app,
    dialog,
    binary: options.binary,
    profile: options.guiProfile,
    coreHome: options.home,
    hostHome: options.hostHome,
    startupError,
  });
}
module.exports = { selectActiveSpace, prepareUpgrade, resolveCoreBinary, upgrade };
