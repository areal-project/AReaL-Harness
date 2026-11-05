// @ts-check
"use strict";
const { join, isAbsolute } = require("node:path");
const { homedir } = require("node:os");
const { executeCore } = require("./core-process.cjs");
const { validateManagementResponse } = require("@areal/workbench/desktop-contract/management");

/** @param {InstanceType<typeof import('./backend.cjs').CoreBackend>} backend
 * @param {import('@areal/workbench/desktop-contract/management').ManagementRequestMap['pluginStoreSnapshot'|'pluginStoreDoctor']} request */
async function readPluginStore(backend, request) {
  /** @type {NodeJS.ProcessEnv} */
  const environment = backend.hooks.environment();
  const configHome =
    environment.AREAL_HARNESS_HOME || join(environment.HOME || homedir(), ".areal");
  if (!isAbsolute(configHome)) throw new Error("插件配置目录必须是绝对路径");
  const workspace =
    request.projectId === undefined
      ? undefined
      : (backend.projects.get(request.projectId)?.root ??
        backend.saved.find((row) => row.id === request.projectId)?.root);
  if (request.projectId !== undefined && !workspace) throw new Error("插件读取项目不存在");
  const args = [
    "plugin",
    request.operation === "pluginStoreDoctor" ? "doctor" : "snapshot",
    "--config-home",
    configHome,
    "--json",
    ...(workspace ? ["--workspace", workspace] : []),
    ...(request.operation === "pluginStoreSnapshot" && request.id ? ["--id", request.id] : []),
  ];
  const { stdout } = await executeCore(backend.binary, args, {
    env: environment,
    timeout: 15000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  const value = JSON.parse(stdout);
  validateManagementResponse(request, value);
  return value;
}
module.exports = { readPluginStore };
