// @ts-check
"use strict";
/** @param {InstanceType<typeof import('./backend.cjs').CoreBackend>} backend */
async function inspectCoreCapabilities(backend) {
  backend.host.client.requireCapability("workbenchUtilities");
  if (!backend.hostCall) throw new Error("Host 配置能力不可用，请更新后台。");
}

// Project only the current connection's public declaration. This does not
// grant permissions, start a workspace, or infer support from source/version.
/** @param {string} binary @param {import('../../../../../clients/gui/packages/runtime-client/capabilities.js').CoreCapabilities|null|undefined} capabilities */
function projectCoreCapabilities(binary, capabilities) {
  const methods = new Set(capabilities?.methods ?? []);
  /** @param {...string} required */
  const supports = (...required) => required.every((method) => methods.has(method));
  return {
    binary,
    apiVersion: capabilities?.apiVersion ?? null,
    runtimeEpoch: capabilities?.runtime?.epoch ?? null,
    runtimeAvailable: capabilities ? capabilities.runtime != null : null,
    features: capabilities
      ? {
          conversation: supports("thread/start", "turn/start"),
          promptPrediction: supports("areal/thread/prediction"),
          ordinaryTurnSubmit:
            supports("areal/turn/submit") && capabilities?.features?.ordinaryTurnSubmit === true,
          editLastMessage:
            supports("areal/turn/submit") && capabilities?.features?.editLastMessage === true,
          permissionPresets: capabilities?.features?.permissionPresets === true,
          permissionFullAccess: capabilities?.features?.permissionFullAccess === true,
          browserToolAttachment:
            supports("areal/thread/tools/attach") &&
            capabilities?.features?.browserToolAttachment === true &&
            capabilities?.browserToolBundles?.some(
              (bundle) => bundle.bundleId === "areal.browser.v1",
            ) === true,
          forkPreview:
            supports("areal/thread/fork", "areal/conversation/history") &&
            capabilities?.features?.conversationDerivationV1?.workspaceModes?.includes(
              "sharedCurrent",
            ) === true,
          sideExecutableV2:
            supports("areal/side/create", "areal/side/close") &&
            capabilities?.features?.sideExecutableV2 === true,
          sidePreview:
            supports("areal/side/start", "areal/side/context/read") &&
            capabilities?.features?.conversationDerivationV1?.sideWorkspaceAccess?.includes(
              "none",
            ) === true,
          sideWorkspaceRead:
            supports("areal/side/start") &&
            capabilities?.features?.conversationDerivationV1?.sideWorkspaceAccess?.includes(
              "readOnly",
            ) === true,
          goals: supports("areal/goal/create", "areal/goal/get"),
          tasks: supports("areal/task/create", "areal/inbox/list"),
          processes: supports(
            "areal/process/start",
            "areal/process/list",
            "areal/process/get",
            "areal/process/read",
            "areal/process/write",
            "areal/process/closeStdin",
            "areal/process/wait",
            "areal/process/terminate",
            "areal/process/resize",
          ),
          executions: supports(
            "areal/agent/delegate",
            "areal/execution/list",
            "areal/execution/read",
          ),
          workgroups: supports("areal/workgroup/start", "areal/workgroup/list"),
        }
      : null,
  };
}

module.exports = { inspectCoreCapabilities, projectCoreCapabilities };
