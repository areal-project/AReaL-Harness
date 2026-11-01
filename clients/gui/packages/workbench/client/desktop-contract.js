import contract from "./desktop-contract.cjs";
export const {
  commandDefinitions,
  commandSemantics,
  desktopError,
  commandResponseError,
  validateMcpPageDeclaration,
  validateMcpPageCall,
  validateMcpPageReply,
} = contract;
/** @typedef {import('./desktop-contract.cjs').CommandName} CommandName */
/** @typedef {import('./desktop-contract.cjs').DesktopError} DesktopError */
/** @template T @typedef {import('./desktop-contract.cjs').DesktopResult<T>} DesktopResult */
/** @template {CommandName} N @typedef {import('./desktop-contract.cjs').CommandParams<N>} CommandParams */
/** @typedef {import('./desktop-contract.cjs').PreviewRequest} PreviewRequest */
/** @typedef {import('./desktop-contract.cjs').OwnedPreviewOperation} OwnedPreviewOperation */
/** @typedef {import('./desktop-contract.cjs').TrajectoryStatus} TrajectoryStatus */
/** @typedef {import('./desktop-contract.cjs').HistoryRequest} HistoryRequest */

/** @template {CommandName} N @template {CommandParams<N>} [P=CommandParams<N>] @typedef {import('./desktop-contract.cjs').CommandResponse<N,P>} CommandResponse */

/** @type {typeof import('./desktop-contract.cjs').validateCommandResponse} */
export const validateCommandResponse = contract.validateCommandResponse;

/** @typedef {import("./desktop-contract.cjs").QuitProgress} QuitProgress */
/** @typedef {import("./desktop-contract.cjs").McpAppDeepLink} McpAppDeepLink */
/** @typedef {import("./desktop-contract.cjs").NotificationTarget} NotificationTarget */

/** @typedef {import("./desktop-contract.cjs").DesktopInvokeArguments} DesktopInvokeArguments */
/** @typedef {import("./desktop-contract.cjs").DesktopSendArguments} DesktopSendArguments */
/** @typedef {import("./desktop-contract.cjs").DesktopEventArguments} DesktopEventArguments */
/** @typedef {import("./desktop-contract.cjs").DesktopInvoke} DesktopInvoke */
/** @typedef {import("./desktop-contract.cjs").DesktopSend} DesktopSend */

/** @typedef {import("./desktop-contract.cjs").OwnedPreviewRequest} OwnedPreviewRequest */

/** @type {typeof import("./desktop-contract.cjs").validatePreview} */
export const validatePreview = contract.validatePreview;

/** @type {typeof import("./desktop-contract.cjs").validateCommand} */
export const validateCommand = contract.validateCommand;
/** @type {typeof import("./desktop-contract.cjs").readCommandInvocation} */
export const readCommandInvocation = contract.readCommandInvocation;
/** @typedef {import("./desktop-contract.cjs").CommandInvocation} CommandInvocation */

/** @typedef {import("./desktop-contract.cjs").DesktopBridge} DesktopBridge */

/** @typedef {import("./desktop-contract.cjs").PreviewViewport} PreviewViewport */
