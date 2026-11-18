// @ts-check
"use strict";
const { validateWorkspaceResponse } = require("@areal/workbench/desktop-contract/workspace");
const { commandResponseError } = require("@areal/workbench/desktop-contract");

/** @param {InstanceType<typeof import('./backend.cjs').CoreBackend>} backend @param {import('@areal/workbench/desktop-contract/workspace').WorkspaceRequest} request */
async function workspaceCommand(backend, request) {
  if (!request.operation.startsWith("worktree"))
    throw new Error("Workspace operations require Host protocol");
  const reading = ["worktreeList", "worktreeOptions", "worktreeRead"].includes(request.operation);
  const result = await backend.hostCall(
    reading ? "worktree.read" : "worktree.command",
    reading ? request : { commandId: require("node:crypto").randomUUID(), request },
  );
  backend.saved = await backend.host.list();
  await backend.library.reload();
  await backend.worktrees.reloadNative();
  backend.onChange();
  try {
    validateWorkspaceResponse(request, result);
  } catch (cause) {
    throw commandResponseError("workspace", request, cause);
  }
  return result;
}
module.exports = { workspaceCommand };
