// @ts-check
"use strict";
const { validateManagementResponse } = require("@areal/workbench/desktop-contract/management");

/** @param {InstanceType<typeof import('./backend.cjs').CoreBackend>} backend
 * @param {import('@areal/workbench/desktop-contract/management').ManagementRequestMap['pluginStoreSnapshot'|'pluginStoreDoctor']} request */
async function readPluginStore(backend, request) {
  if (!backend.hostCall) throw new Error("Host 插件目录能力不可用");
  const value = await backend.hostCall("workbench.utility", {
    operation: request.operation === "pluginStoreDoctor" ? "pluginDoctor" : "pluginSnapshot",
    ...(request.projectId ? { projectId: request.projectId } : {}),
    ...(request.operation === "pluginStoreSnapshot" && request.id ? { pluginId: request.id } : {}),
  });
  validateManagementResponse(request, value);
  return value;
}
module.exports = { readPluginStore };
