// @ts-check
"use strict";
const currentCommands = new Set([
  "send",
  "editMessage",
  "continue",
  "prepareCreator",
  "feedback",
  "create",
  "configure",
]);
const currentManagePrefixes = ["plugin", "marketplace", "mcpApp", "mcpForm"];
const currentManageOperations = new Set([
  "mcpExtensionCall",
  "mcpToolResult",
  "hookAcknowledge",
  "taskCreate",
  "taskUpdate",
  "taskPause",
  "taskResume",
  "taskStopRun",
  "taskResumeRun",
  "taskCancel",
  "taskDelete",
  "taskReply",
]);
/** @param {string} name @param {Record<string,unknown>} request */
function requiresCurrentCommands(name, request) {
  return (
    currentCommands.has(name) ||
    (name === "tasks" &&
      ["preview", "observe"].some((operation) => operation === request.operation)) ||
    (name === "side" && ["create", "close"].some((operation) => operation === request.operation)) ||
    (["steer", "queueEdit"].includes(name) &&
      Array.isArray(request.mcpContent) &&
      request.mcpContent.length > 0) ||
    (name === "trajectory" && request.operation === "setEnabled") ||
    (name === "providers" && request.operation === "defaultAndApply") ||
    (name === "manage" &&
      ((typeof request.operation === "string" && currentManageOperations.has(request.operation)) ||
        currentManagePrefixes.some(
          (prefix) => typeof request.operation === "string" && request.operation.startsWith(prefix),
        )))
  );
}

module.exports = { requiresCurrentCommands };
