// @ts-check
"use strict";
/** @type {typeof import("./desktop-contract/conversation.cjs")} */
const conversation = require("./desktop-contract/conversation.cjs");
/** @type {typeof import("./desktop-contract/desktop-control.cjs")} */
const desktopControl = require("./desktop-contract/desktop-control.cjs");
/** @type {typeof import("./desktop-contract/conversation.cjs").validateResponse} */
const validateConversationResponse = conversation.validateResponse;
/** @type {typeof import("./desktop-contract/desktop-control.cjs").validateResponse} */
const validateDesktopControlResponse = desktopControl.validateResponse;
const provider = require("./desktop-contract/provider.cjs");
const resourceContract = require("./desktop-contract/resource.cjs");
const catalog = require("./desktop-contract/catalog.cjs");
const trajectory = require("./desktop-contract/trajectory.cjs");
const feedback = require("./desktop-contract/feedback.cjs");
const management = require("./desktop-contract/management.cjs");
const cloud = require("./desktop-contract/cloud.cjs");
const workspace = require("./desktop-contract/workspace.cjs");
const libraryMedia = require("./desktop-contract/library-media.cjs");
const {
  commandDefinitions,
  commandSemantics,
  desktopError,
  commandResponseError,
  record,
  identifier,
} = require("./desktop-contract/transport.cjs");
/** @type {typeof import("./desktop-contract/transport.cjs").invalid} */
const invalid = require("./desktop-contract/transport.cjs").invalid;
const {
  validateMcpPageDeclaration,
  validateMcpPageCall,
  validateMcpPageReply,
} = require("./desktop-contract/mcp-page.cjs");

/** Raw Electron payloads have no precision until the receiving owner validates them.
 * @typedef {{
 * "areal-core:choose-project":[],
 * "areal-core:choose-projectless-directory":[],
 * "areal-core:choose-task-directory":[],
 * "areal-core:command":[name:unknown,params:unknown],
 * "areal-core:file-open":[request:unknown],
 * "areal-core:install-command-line-tools":[],
 * "areal-core:mcp-app":[request:unknown],
 * "areal-core:mcp-app-deep-link-consumed":[id:unknown],
 * "areal-core:mcp-app-deep-link-target":[],
 * "areal-core:mcp-form-resource":[operation:unknown,request:unknown],
 * "areal-core:notification-consumed":[id:unknown],
 * "areal-core:notification-target":[],
 * "areal-core:present-ready":[],
 * "areal-core:preview":[request:unknown],
 * "areal-core:snapshot":[],
 * "areal-core:theme":[id?:unknown],
 * "areal-core:update-download":[],
 * "areal-core:update-recover-resources":[],
 * "areal-core:update-state":[]
 * }} DesktopInvokeArguments */
/** @typedef {{
 * "areal-core:interface-locale":[locale:unknown],
 * "areal-core:projection-request":[requestId:unknown],
 * "areal-core:quit-decision":[decision:unknown]
 * }} DesktopSendArguments */
/** @typedef {{
 * "areal-core:mcp-app-deep-link":[],
 * "areal-core:mcp-app-event":[event:unknown],
 * "areal-core:notification-open":[],
 * "areal-core:preview-event":[event:unknown],
 * "areal-core:projection":[message:unknown],
 * "areal-core:quit-progress":[progress:unknown],
 * "areal-core:quit-request":[id:unknown],
 * "areal-core:theme-changed":[theme:unknown],
 * "areal-core:update-changed":[state:unknown]
 * }} DesktopEventArguments */
/** @typedef {<N extends keyof DesktopInvokeArguments>(channel:N,...args:DesktopInvokeArguments[N])=>Promise<unknown>} DesktopInvoke */
/** @typedef {<N extends keyof DesktopSendArguments>(channel:N,...args:DesktopSendArguments[N])=>void} DesktopSend */

/** @typedef {{state:'idle'}|{state:'quitting',phase:'checking'|'stopping'|'finishing'}} QuitProgress */
/** @typedef {{id:number,pluginId:string,marketplace?:string,toolName:string,path:string}} McpAppDeepLink */
/** @typedef {{projectId:string}&({threadId:string,taskId?:never}|{taskId:string,runId?:string,questionId?:string})} NotificationTarget */

/** @template {keyof DesktopInvokeArguments} N @typedef {(...args:DesktopInvokeArguments[N])=>Promise<unknown>} BridgeInvoke */
/** The preload transport stays opaque; the renderer adapter owns response decoding. */
/** @typedef {{
 * command:BridgeInvoke<'areal-core:command'>,snapshot:BridgeInvoke<'areal-core:snapshot'>,
 * presentReady:BridgeInvoke<'areal-core:present-ready'>,installCommandLineTools:BridgeInvoke<'areal-core:install-command-line-tools'>,
 * chooseProject:BridgeInvoke<'areal-core:choose-project'>,chooseTaskDirectory:BridgeInvoke<'areal-core:choose-task-directory'>,
 * chooseProjectlessDirectory:BridgeInvoke<'areal-core:choose-projectless-directory'>,fileOpen:BridgeInvoke<'areal-core:file-open'>,
 * theme:BridgeInvoke<'areal-core:theme'>,preview:BridgeInvoke<'areal-core:preview'>,
 * updateState:BridgeInvoke<'areal-core:update-state'>,downloadUpdate:BridgeInvoke<'areal-core:update-download'>,
 * recoverUpdateResources:BridgeInvoke<'areal-core:update-recover-resources'>,
 * mcpApp:BridgeInvoke<'areal-core:mcp-app'>,mcpFormResource:BridgeInvoke<'areal-core:mcp-form-resource'>,
 * setInterfaceLocale:(locale:unknown)=>void,requestProjection:(requestId:unknown)=>void,
 * onProjection:(listener:(value:unknown)=>void)=>()=>void,
 * onPreviewEvent:(listener:(value:unknown)=>void)=>()=>void,onTheme:(listener:(value:unknown)=>void)=>()=>void,
 * onUpdate:(listener:(value:unknown)=>void)=>()=>void,onMcpAppEvent:(listener:(value:unknown)=>void)=>()=>void,
 * onQuitProgress:(listener:(value:QuitProgress)=>void)=>()=>void,
 * onQuitRequested:(listener:()=>boolean|Promise<boolean>)=>()=>void,
 * onNotificationOpen:(listener:(value:NotificationTarget)=>void)=>()=>void,
 * onMcpAppDeepLink:(listener:(value:McpAppDeepLink)=>void|Promise<void>)=>()=>void
 * }} DesktopBridge */

/** @typedef {{message:string, code?:string|number, reason?:string, submissionUnknown?:boolean, requestId?:string, delivery?:'resultUnavailable', outcome?:import('../../runtime-client/core.js').FailureOutcome, recovery?:import('../../runtime-client/core.js').Recovery}} DesktopError */
/** @template T @typedef {{ok:true,value:T}|{ok:false,error:DesktopError}} DesktopResult */
/** @typedef {import('./desktop-contract/conversation.cjs').ResourceRef} ResourceRef */
/** @typedef {import('./desktop-contract/conversation.cjs').Request<'prepareCreator'>} PrepareCreatorRequest */
/** @typedef {import('./desktop-contract/conversation.cjs').WorktreeSpec} WorktreeSpec */
/** @typedef {import('./desktop-contract/conversation.cjs').ConfigureRequest} ConfigureRequest */
/** @typedef {import('./desktop-contract/conversation.cjs').SideRequest} SideRequest */
/** @typedef {import('./desktop-contract/conversation.cjs').Request<'continue'>} ContinueRequest */
/** @typedef {import('./desktop-contract/conversation.cjs').ForkRequest} ForkRequest */
/** @typedef {import('./desktop-contract/conversation.cjs').HistoryRequest} HistoryRequest */
/** @typedef {import('./desktop-contract/trajectory.cjs').TrajectoryRequest} TrajectoryRequest */
/** @typedef {import('./desktop-contract/trajectory.cjs').TrajectoryRecord} TrajectoryRecord */
/** @typedef {import('./desktop-contract/trajectory.cjs').TrajectoryModelCallSummary} TrajectoryModelCallSummary */
/** @typedef {import('./desktop-contract/trajectory.cjs').TrajectoryStatus} TrajectoryStatus */

/** @typedef {import("./desktop-contract/transport.cjs").CommandEffect} CommandEffect */
/** @typedef {keyof typeof commandDefinitions} CommandName */
/** @typedef {import('./desktop-contract/conversation.cjs').Requests & import('./desktop-contract/desktop-control.cjs').Requests & {
 * providers:import('./desktop-contract/provider.cjs').Request<'providers'>,
 * chatgpt:import('./desktop-contract/provider.cjs').Request<'chatgpt'>,
 * resources:import('./desktop-contract/resource.cjs').Request<'resources'>,
 * analytics:import('./desktop-contract/catalog.cjs').Request<'analytics'>,
 * projectless:import('./desktop-contract/catalog.cjs').Request<'projectless'>,
 * tasks:import('./desktop-contract/catalog.cjs').Request<'tasks'>,
 * trajectory:TrajectoryRequest,feedback:import('./desktop-contract/feedback.cjs').Request<'feedback'>,
 * manage:import('./desktop-contract/management.cjs').ManagementRequest,
 * workspace:import('./desktop-contract/workspace.cjs').WorkspaceRequest,
 * library:import('./desktop-contract/library-media.cjs').LibraryRequest,
 * cloud:import('./desktop-contract/cloud.cjs').SettingsRequest,
 * cloudSession:import('./desktop-contract/cloud.cjs').SessionRequest,
 * media:import('./desktop-contract/library-media.cjs').MediaRequest
 * }} Requests */
/** @template {string} N @typedef {N extends keyof Requests ? Requests[N] : never} CommandParams */
/** @typedef {{[N in CommandName]:{name:N,request:CommandParams<N>}}[CommandName]} CommandInvocation */
/** @param {string} name @param {unknown} request @param {{serviceOnly?:boolean}} [options] @returns {CommandInvocation} */
function readCommandInvocation(name, request, options = { serviceOnly: true }) {
  const invocation = { name, request };
  if (!isCommandInvocation(invocation, options)) invalid();
  return invocation;
}
/** @param {{name:string,request:unknown}} invocation @param {{serviceOnly?:boolean}} options @returns {invocation is CommandInvocation} */
function isCommandInvocation(invocation, options) {
  validateCommand(invocation.name, invocation.request, options);
  return true;
}
/** @typedef {import('./desktop-contract/conversation.cjs').PrepareCreatorResponse} PrepareCreatorResponse */
/** @typedef {import('./desktop-contract/conversation.cjs').TurnAdmission} ContinueResponse */
/** @typedef {import('./desktop-contract/conversation.cjs').Created} ForkResponse */
/** @template {SideRequest} P @typedef {import('./desktop-contract/conversation.cjs').SideResponse<P>} SideResponse */
/** @template {CommandName} N @template {CommandParams<N>} [P=CommandParams<N>]
 * @typedef {N extends import('./desktop-contract/conversation.cjs').Name ? import('./desktop-contract/conversation.cjs').Response<N,P>
 * : N extends import('./desktop-contract/desktop-control.cjs').Name ? import('./desktop-contract/desktop-control.cjs').Response<N,P>
 * : N extends 'providers'|'chatgpt' ? import('./desktop-contract/provider.cjs').Response<N,P>
 * : N extends 'resources' ? import('./desktop-contract/resource.cjs').Response<N,P>
 * : N extends 'analytics'|'projectless'|'tasks' ? import('./desktop-contract/catalog.cjs').Response<N,P>
 * : N extends 'trajectory' ? import('./desktop-contract/trajectory.cjs').Response<N,P>
 * : N extends 'feedback' ? import('./desktop-contract/feedback.cjs').Response<N,P>
 * : N extends 'manage' ? import('./desktop-contract/management.cjs').ManagementResponse<Extract<P,Requests['manage']>>
 * : N extends 'workspace' ? import('./desktop-contract/workspace.cjs').WorkspaceResponse<Extract<P,Requests['workspace']>>
 * : N extends 'library' ? import('./desktop-contract/library-media.cjs').LibraryState
 * : N extends 'cloud' ? import('./desktop-contract/cloud.cjs').SettingsResponse
 * : N extends 'cloudSession' ? import('./desktop-contract/cloud.cjs').SessionResponse<Extract<P,Requests['cloudSession']>>
 * : N extends 'media' ? import('./desktop-contract/library-media.cjs').MediaResponse<Extract<P,Requests['media']>> : never} CommandResponse */
/** @typedef {'show'|'navigate'|'back'|'forward'|'reload'|'stop'|'state'|'external'|'devtools'|'openLink'|'release'|'claim'|'takeover'|'captureRegion'|'captureElement'|'selectElement'|'cancelElementSelection'|'checkElement'|'endRegion'|'beginStyleTrial'|'applyStyleTrial'|'undoStyleTrial'|'redoStyleTrial'|'styleTrialState'|'captureStyleTrialAfter'|'clearStyleTrial'|'newPage'|'selectPage'|'subscribe'|'unsubscribe'|'allowNextDownload'|'cancelFileHandoff'|'cancelDownload'|'authorizeFrameOrigin'|'reloadFrameOrigin'|'revokeFrameOrigin'} OwnedPreviewOperation */
/** @typedef {{projectId:string,threadId:string,pageId?:string,captureId?:string,downloadId?:string,url?:string,userIntent?:boolean,visible?:boolean,bounds?:{x:number,y:number,width:number,height:number},[key:string]:unknown}} PreviewOwner */
/** @typedef {PreviewOwner & (
 * {operation:'show'|'back'|'forward'|'reload'|'stop'|'state'|'external'|'devtools'|'claim'|'takeover'|'captureRegion'|'captureElement'|'cancelElementSelection'|'newPage'|'subscribe'|'unsubscribe'}
 * | {operation:'navigate'|'openLink',url:string}
 * | {operation:'release',userIntent:true}
 * | {operation:'selectPage'|'cancelFileHandoff',pageId:string}
 * | {operation:'authorizeFrameOrigin'|'reloadFrameOrigin'|'revokeFrameOrigin'|'allowNextDownload',pageId:string,userIntent:true}
 * | {operation:'cancelDownload',pageId:string,downloadId:string,userIntent:true}
 * | {operation:'endRegion',pageId:string,captureId:string}
 * | {operation:'checkElement'|'beginStyleTrial',pageId:string,captureId:string,elementId:string}
 * | {operation:'selectElement',pageId:string,captureId:string,x:number,y:number}
 * | {operation:'applyStyleTrial',pageId:string,trialId:string,property:string,value:string}
 * | {operation:'undoStyleTrial'|'redoStyleTrial'|'styleTrialState'|'captureStyleTrialAfter'|'clearStyleTrial',pageId:string,trialId:string}
 * )} OwnedPreviewRequest */
/** Hide without a capture deliberately allows unscoped owner fields; Main decides global hiding.
 * @typedef {OwnedPreviewRequest | {operation:'hide',captureId:string,projectId:string,threadId:string,pageId:string,[key:string]:unknown}
 * | {operation:'hide',captureId?:undefined,projectId?:unknown,threadId?:unknown,pageId?:unknown,[key:string]:unknown}} PreviewRequest */
/** @template {string} N @overload @param {N} name @param {unknown} params @param {{serviceOnly?:boolean}} [options] @returns {asserts params is CommandParams<N>} */
/** @param {string} name @param {unknown} params @param {{serviceOnly?:boolean}} [options] */
function validateCommand(name, params, { serviceOnly = false } = {}) {
  if (!Object.hasOwn(commandDefinitions, name) || !record(params)) invalid();
  const [layer, scope] = commandDefinitions[/** @type {CommandName} */ (name)];
  if (serviceOnly && layer !== "service") invalid();
  if (
    scope !== "app" &&
    !(
      name === "workspace" &&
      ["worktreeList", "worktreeSettings"].includes(String(params.operation))
    ) &&
    !identifier(params.projectId)
  )
    invalid();
  if (scope === "thread" && !identifier(params.threadId)) invalid();
  switch (name) {
    case "cloud":
    case "cloudSession":
      cloud.validateRequest(name, params);
      return;
    case "connect":
    case "list":
    case "open":
    case "history":
    case "create":
    case "prepareCreator":
    case "fork":
    case "side":
    case "prediction":
    case "send":
    case "editMessage":
    case "continue":
    case "stop":
    case "attachBrowser":
    case "respond":
    case "reconcile":
    case "configure":
    case "queue":
    case "queueEdit":
    case "steer":
    case "dismissRecovery":
      if (!conversation.isRequest(name, params)) invalid();
      return;
    case "serviceLifecycle":
    case "serviceStatus":
    case "stopService":
    case "recoverResources":
    case "browserData":
    case "computerControl":
    case "exportDiagnostics":
    case "connectService":
    case "export":
    case "remoteControl":
      if (!desktopControl.isRequest(name, params)) invalid();
      return;
    case "resources":
      if (!resourceContract.isRequest(name, params)) invalid();
      return;
    case "analytics":
    case "projectless":
    case "tasks":
      if (!catalog.isRequest(name, params)) invalid();
      return;
    case "trajectory":
      if (!trajectory.isRequest(name, params)) invalid();
      return;
    case "feedback":
      if (!feedback.isRequest(name, params)) invalid();
      return;
    case "providers":
    case "chatgpt":
      provider.readRequest(name, params);
      return;
    case "manage":
      if (!management.isManagementRequest(params)) invalid();
      return;
    case "workspace":
      if (!workspace.isWorkspaceRequest(params)) invalid();
      return;
    case "library":
      if (!libraryMedia.isLibraryRequest(params)) invalid();
      return;
    case "media":
      if (!libraryMedia.isMediaRequest(params)) invalid();
      return;
    default:
      invalid();
  }
}

/** @type {(request:unknown)=>asserts request is PreviewRequest} */
const validatePreview = (request) => {
  if (!record(request) || typeof request.operation !== "string") invalid();
  if (request.operation === "hide") {
    if (
      request.captureId !== undefined &&
      (!identifier(request.captureId) ||
        !identifier(request.projectId) ||
        !identifier(request.threadId) ||
        !identifier(request.pageId))
    )
      invalid();
    return;
  }
  if (
    ![
      "show",
      "navigate",
      "back",
      "forward",
      "reload",
      "stop",
      "state",
      "external",
      "devtools",
      "openLink",
      "release",
      "claim",
      "takeover",
      "captureRegion",
      "captureElement",
      "selectElement",
      "cancelElementSelection",
      "checkElement",
      "endRegion",
      "beginStyleTrial",
      "applyStyleTrial",
      "undoStyleTrial",
      "redoStyleTrial",
      "styleTrialState",
      "captureStyleTrialAfter",
      "clearStyleTrial",
      "newPage",
      "selectPage",
      "subscribe",
      "unsubscribe",
      "allowNextDownload",
      "cancelFileHandoff",
      "cancelDownload",
      "authorizeFrameOrigin",
      "reloadFrameOrigin",
      "revokeFrameOrigin",
    ].includes(String(request.operation)) ||
    !identifier(request.projectId) ||
    !identifier(request.threadId)
  )
    invalid();
  if (
    ["authorizeFrameOrigin", "reloadFrameOrigin", "revokeFrameOrigin"].includes(
      String(request.operation),
    ) &&
    (!identifier(request.pageId) ||
      request.userIntent !== true ||
      Object.keys(request).some(
        (key) => !["operation", "projectId", "threadId", "pageId", "userIntent"].includes(key),
      ))
  )
    invalid();
  if (request.url !== undefined && typeof request.url !== "string") invalid();
  if (request.pageId !== undefined && !identifier(request.pageId)) invalid();
  if (request.captureId !== undefined && !identifier(request.captureId)) invalid();
  if (request.downloadId !== undefined && !identifier(request.downloadId)) invalid();
  if (
    ["allowNextDownload", "cancelFileHandoff", "cancelDownload"].includes(
      String(request.operation),
    ) &&
    Object.keys(request).some(
      (key) =>
        !["operation", "projectId", "threadId", "pageId", "downloadId", "userIntent"].includes(key),
    )
  )
    invalid();
  if (
    ["allowNextDownload", "cancelFileHandoff", "cancelDownload"].includes(
      String(request.operation),
    ) &&
    !identifier(request.pageId)
  )
    invalid();
  if (request.operation === "cancelDownload" && !identifier(request.downloadId)) invalid();
  if (
    ["allowNextDownload", "cancelDownload"].includes(String(request.operation)) &&
    request.userIntent !== true
  )
    invalid();
  if (
    request.operation === "endRegion" &&
    (!identifier(request.pageId) || !identifier(request.captureId))
  )
    invalid();
  if (
    request.operation === "checkElement" &&
    (!identifier(request.pageId) || !identifier(request.captureId))
  )
    invalid();
  if (request.operation === "checkElement" && !identifier(request.elementId)) invalid();
  if (
    request.operation === "selectElement" &&
    (!identifier(request.pageId) ||
      !identifier(request.captureId) ||
      ![request.x, request.y].every(
        (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
      ))
  )
    invalid();
  if (
    request.operation === "beginStyleTrial" &&
    (!identifier(request.pageId) ||
      !identifier(request.captureId) ||
      !identifier(request.elementId))
  )
    invalid();
  if (
    [
      "applyStyleTrial",
      "undoStyleTrial",
      "redoStyleTrial",
      "styleTrialState",
      "captureStyleTrialAfter",
      "clearStyleTrial",
    ].includes(String(request.operation)) &&
    (!identifier(request.pageId) || !identifier(request.trialId))
  )
    invalid();
  if (
    request.operation === "applyStyleTrial" &&
    (typeof request.property !== "string" ||
      typeof request.value !== "string" ||
      request.property.length > 40 ||
      request.value.length > 500)
  )
    invalid();
  if (request.userIntent !== undefined && typeof request.userIntent !== "boolean") invalid();
  if (request.operation === "release" && request.userIntent !== true) invalid();
  if (request.operation === "selectPage" && !identifier(request.pageId)) invalid();
  if (
    ["navigate", "openLink"].includes(String(request.operation)) &&
    typeof request.url !== "string"
  )
    invalid();
  if (request.visible !== undefined && typeof request.visible !== "boolean") invalid();
  const bounds = request.bounds;
  if (
    bounds !== undefined &&
    (!record(bounds) ||
      !["x", "y", "width", "height"].every(
        (key) => typeof bounds[key] === "number" && Number.isFinite(bounds[key]),
      ))
  )
    invalid();
};

/** @template {CommandName} N @template {CommandParams<N>} P @overload
 * @param {N} name @param {P} params @param {unknown} value @returns {asserts value is CommandResponse<N,P>} */
/** @param {string} name @param {unknown} params @param {unknown} value */
function validateCommandResponse(name, params, value) {
  const invocation = readCommandInvocation(name, params, { serviceOnly: false });
  switch (invocation.name) {
    case "connect":
    case "list":
    case "open":
    case "history":
    case "create":
    case "prepareCreator":
    case "fork":
    case "side":
    case "prediction":
    case "send":
    case "editMessage":
    case "continue":
    case "stop":
    case "attachBrowser":
    case "respond":
    case "reconcile":
    case "configure":
    case "queue":
    case "queueEdit":
    case "steer":
    case "dismissRecovery":
      validateConversationResponse(invocation.name, invocation.request, value);
      return;
    case "serviceLifecycle":
    case "serviceStatus":
    case "stopService":
    case "recoverResources":
    case "browserData":
    case "computerControl":
    case "exportDiagnostics":
    case "connectService":
    case "export":
    case "remoteControl":
      validateDesktopControlResponse(invocation.name, invocation.request, value);
      return;
    case "providers":
    case "chatgpt":
      if (provider.isResponse(invocation.name, invocation.request, value)) return;
      break;
    case "resources":
      if (resourceContract.isResponse(invocation.name, invocation.request, value)) return;
      break;
    case "analytics":
    case "projectless":
    case "tasks":
      if (catalog.isResponse(invocation.name, invocation.request, value)) return;
      break;
    case "trajectory":
      if (trajectory.isResponse(invocation.name, invocation.request, value)) return;
      break;
    case "feedback":
      if (feedback.isResponse(invocation.name, invocation.request, value)) return;
      break;
    case "manage":
      management.validateManagementResponse(invocation.request, value);
      return;
    case "workspace":
      workspace.validateWorkspaceResponse(invocation.request, value);
      return;
    case "cloud":
    case "cloudSession":
      if (cloud.isResponse(invocation.name, invocation.request, value)) return;
      break;
    case "library":
      if (libraryMedia.isLibraryState(value)) return;
      break;
    case "media":
      libraryMedia.validateMediaResponse(invocation.request, value);
      return;
  }
  throw Object.assign(new Error("Invalid Desktop command response"), {
    code: "DESKTOP_RESPONSE_INVALID",
  });
}
module.exports = {
  commandDefinitions,
  commandSemantics,
  validateCommand,
  readCommandInvocation,
  validateCommandResponse,
  commandResponseError,
  /** @type {(request:unknown)=>asserts request is PreviewRequest} */
  validatePreview: validatePreview,
  desktopError,
  validateMcpPageDeclaration,
  validateMcpPageCall,
  validateMcpPageReply,
};
