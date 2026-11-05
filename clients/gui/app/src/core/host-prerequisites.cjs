// @ts-check
"use strict";

const { execFile } = require("node:child_process");
const { access } = require("node:fs/promises");
const { constants } = require("node:fs");
const { isAbsolute, join } = require("node:path");
const { promisify } = require("node:util");
const { verifyCoreBundle } = require("@areal/workbench-service/desktop/core/bundle.cjs");
const { nativeText } = require("@areal/workbench-service/desktop/core/native-i18n.cjs");

const executeFile = promisify(execFile);
/** @param {string} path @param {string[]} args */
const execute = (path, args) =>
  executeFile(path, args, {
    timeout: 10000,
    killSignal: "SIGKILL",
    maxBuffer: 4096,
    env: {},
    windowsHide: true,
  });

/** @param {{app:{isPackaged:boolean},platform?:NodeJS.Platform,execute?:(path:string,args:string[])=>Promise<{stdout:string}>,accessible?:(path:string)=>Promise<void>,bundle?:(path:string)=>{manifest:{prerequisites?:{path:string}[]}}}} options */
async function checkHostPrerequisites({
  app,
  platform = process.platform,
  execute: run = execute,
  accessible = (path) => access(path, constants.X_OK),
  bundle = verifyCoreBundle,
}) {
  if (platform !== "darwin") return;
  if (
    app.isPackaged &&
    !bundle(process.resourcesPath).manifest.prerequisites?.some(
      (item) => item.path === "/usr/bin/python3",
    )
  ) {
    throw Object.assign(new Error(nativeText("prerequisite.undeclared")), {
      code: "HOST_PREREQUISITE_UNDECLARED",
    });
  }
  // A missing or stale developer selection can make /usr/bin/python3 open the
  // OS installer. Require evidence of the selected interpreter before running it.
  const developer = await run("/usr/bin/xcode-select", ["-p"]).catch(() => null);
  const selected = developer?.stdout.trim();
  if (!selected || !isAbsolute(selected)) throw unavailable("developer-tools-unavailable");
  const present = await accessible(join(selected, "usr/bin/python3")).then(
    () => true,
    () => false,
  );
  if (!present) throw unavailable("developer-tools-unavailable");
  const python = await run("/usr/bin/python3", [
    "-I",
    "-S",
    "-c",
    "import subprocess,sys; print(1)",
  ]).catch(() => null);
  if (python?.stdout.trim() !== "1") throw unavailable("python-unavailable");
}

/** @param {{platform?:NodeJS.Platform,execute?:(path:string,args:string[])=>Promise<unknown>}} [options] */
async function requestCommandLineToolsInstallation({
  platform = process.platform,
  execute: run = execute,
} = {}) {
  if (platform !== "darwin")
    return { started: false, message: nativeText("prerequisite.installUnavailable") };
  return run("/usr/bin/xcode-select", ["--install"]).then(
    () => ({ started: true }),
    () => ({ started: false, message: nativeText("prerequisite.installFailed") }),
  );
}

/** @param {'developer-tools-unavailable'|'python-unavailable'} reason */
function unavailable(reason) {
  return Object.assign(new Error(nativeText("prerequisite.detail")), {
    code: "HOST_PREREQUISITE_UNAVAILABLE",
    prerequisite: {
      kind: "macos-command-line-tools",
      reason,
      title: nativeText("prerequisite.title"),
      detail: nativeText("prerequisite.detail"),
      installLabel: nativeText("prerequisite.install"),
      retryLabel: nativeText("prerequisite.retry"),
      requestedMessage: nativeText("prerequisite.requested"),
    },
  });
}

module.exports = { checkHostPrerequisites, requestCommandLineToolsInstallation };
