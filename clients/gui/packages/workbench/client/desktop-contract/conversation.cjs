// @ts-check
"use strict";
const {
  modelRecord,
  count,
  resourceRef,
  isDesktopSnapshot,
  isLifecycleReceipt,
  admission,
  isSubmissionOutcomes,
  isOperationRef,
  clientOptions,
  isQueue,
} = require("./shared.cjs");
const { isCoreTurn } = require("../core-model-contract.js");
const { historyPage, historySummary } = require("./conversation-history.cjs");
const { modelRef, parameters, strings } = require("./provider.cjs");
/** @typedef {{projectId:string}} ProjectRequest */
/** @typedef {ProjectRequest & {requestId?:string}} ReconcileRequest */
/** @typedef {ProjectRequest & {threadId:string}} ThreadRequest */
/** @typedef {{id:string,revision:string}} ResourceRef */
/** @typedef {import("./shared.cjs").ClientOptions} ClientOptions */
/** @typedef {{type:'image'|'audio'|'file',url:string,name?:string,mimeType?:string,_meta?:Record<string,unknown>}} Attachment */
/** @typedef {{type:'text',text:string,_meta?:Record<string,unknown>}|{type:'resource_link',uri:string,name:string,mimeType?:string,_meta?:Record<string,unknown>}|{type:'resource',resource:{uri:string,text?:string,blob?:string,mimeType?:string},_meta?:Record<string,unknown>}} MessageContent */
/** @typedef {{pluginId:string,componentId:string,installedDigest:string,arguments:string}} PluginCommandRef */
/** @typedef {{command?:PluginCommandRef,text?:string,attachments?:Attachment[],mcpContent?:MessageContent[],conversationQuotes?:Array<{text:string}>}} Message */
/** @typedef {{sourceRoot?:string,ref?:string,worktreeRoot?:string,branch?:string,branchPrefix?:string,environmentId?:string,environmentRevision?:number,mode?:'source'|'worktree'}} WorktreeSpec */
/** @typedef {ProjectRequest & {requestId?:string,browserEnabled?:boolean,options?:ClientOptions,model?:import('./provider.cjs').ModelRef|null,parameters?:import('./provider.cjs').ModelParameters,profile?:ResourceRef,worktree?:WorktreeSpec}} CreateRequest */
/** @typedef {ThreadRequest & {requestId?:string,expectedRevision?:number,model?:import('./provider.cjs').ModelRef|null,profile?:ResourceRef,options?:ClientOptions,parameters?:import('./provider.cjs').ModelParameters,selectedSkills?:ResourceRef[]}} ConfigureRequest */
/** @typedef {ProjectRequest & {sourceThreadId:string,requestId?:string,workspaceMode:'sharedCurrent',anchor:{turnId:string,boundary:'before'|'after'},target?:{agentProfile?:ResourceRef|null,model?:import('./provider.cjs').ModelRef|null,parameters?:import('./provider.cjs').ModelParameters|null}}} ForkRequest */
/** @typedef {{kind:'itemRange',turnId:string,itemId:string,startUtf8:number,endUtf8:number,textSha256:string}|{kind:'userQuote',text:string,claimedTurnId?:string|null,claimedItemId?:string|null}} SideSelection */
/** @typedef {{kind:string,turnId?:string|null,boundary?:string|null}} SideAnchor */
/** @typedef {ProjectRequest & ({operation:'start',sourceThreadId:string,requestId?:string,text:string,workspaceAccess?:'none'|'readOnly',model?:import('./provider.cjs').ModelRef,resetModel?:boolean,anchor?:SideAnchor,selection?:SideSelection,parameters?:import('./provider.cjs').ModelParameters}|{operation:'create',sourceThreadId:string,requestId:string,firstInput?:{text:string}}|{operation:'close',threadId:string,requestId:string}|{operation:'recover',requestId:string,sourceThreadId?:string,threadId?:string,method?:'areal/side/start'|'areal/side/create'|'areal/side/close'}|{operation:'send',threadId:string,text:string,requestId?:string}|{operation:'context',threadId:string,cursor?:string,evidenceRef?:string,maxBytes?:number}|{operation:'list',sourceThreadId:string,includeArchived?:boolean,cursor?:string})} SideRequest */
/** @typedef {ThreadRequest & {viewId:string} & ({operation:'acquire'}|{operation:'loadOlder',pageId?:string}|{operation:'release'}|{operation:'loadItem',itemId:string})} HistoryRequest */
/** @typedef {ThreadRequest & ({requestId?:never,operation?:never}|{requestId:string,operation:'update'|'remove'|'reorder'|'pause'|'resume'|'steer'})} QueueRequest */
/** @typedef {ThreadRequest & {expectedRevision:number,requestId?:string} & ({operation:'update',queueItemId:string,retainedInput?:Array<Record<string,unknown>>}&Message|{operation:'remove',queueItemId:string}|{operation:'steer',queueItemId:string,expectedTurnId:string}|{operation:'reorder',queueItemIds:string[]}|{operation:'pause'|'resume'})} QueueEditRequest */
/** @typedef {ThreadRequest & ({requestId:string,decision:'deny'|'allowOnce'|'allowSession'|'allowProject',answers?:never}|{requestId:string,answers:Record<string,string>,decision?:never})} RespondRequest */
/** @typedef {{connect:ProjectRequest & {resumeScheduling?:boolean,threadId?:string},list:ProjectRequest,open:ThreadRequest,history:HistoryRequest,create:CreateRequest,prepareCreator:ProjectRequest & {profile?:ResourceRef},fork:ForkRequest,side:SideRequest,prediction:ThreadRequest & {sourceTurnId:string,operation:'request'|'cancel'},send:ThreadRequest & Message & {requestId?:string},editMessage:ThreadRequest & Message & {expectedTurnId:string,itemId:string,text:string,expectedConfigRevision:number,requestId:string},"continue":ThreadRequest & {expectedTurnId:string,expectedConfigRevision?:number,requestId?:string},stop:ThreadRequest & {turnId:string,requestId:string},attachBrowser:ThreadRequest & {expectedToolsetRevision:number,requestId?:string},respond:RespondRequest,reconcile:ReconcileRequest,configure:ConfigureRequest,queue:QueueRequest,queueEdit:QueueEditRequest,steer:ThreadRequest & Message & {expectedTurnId:string,requestId?:string},dismissRecovery:ProjectRequest & {requestId:string}}} Requests */
/** @typedef {keyof Requests} Name */
/** @template {Name} N @typedef {Requests[N]} Request */
/** @typedef {{threadId:string,requestId:string}} Created */
/** @typedef {{turn:import('../core-model-contract.js').CoreTurn & {status:string},requestId?:string,threadId?:string}|{queueRevision:number,configRevision:number,queueItemId:string|null,requestId?:string,threadId?:string}} TurnAdmission */
/** @typedef {{status:'pending'|'unavailable',sourceTurnId:string,configurationRevision:number}|{status:'ready',sourceTurnId:string,configurationRevision:number,text:string}} Prediction */
/** @typedef {{confirmed:false,state:string}|{confirmed:true,accepted:true,status:string,operation?:import('../../../runtime-client/core.js').OperationRef,error?:{message:string,code?:string|number,[key:string]:unknown},message?:string,result?:unknown}} SubmissionRead */
/** @typedef {{queueRevision:number,queueItemId:string,turnId:string,itemId:string}} QueueSteer */
/** @typedef {{snapshotId:string,evidence:Array<{evidenceRef:string,sourceTurnId:string,sourceItemId:string,sourceTurnStatus:string,text:string,range:{startUtf8:number,endUtf8:number,totalBytes:number}}>,nextCursor:string|null,complete:boolean}} SideContext */
/** @template P @typedef {P extends {operation:'release'} ? {released:true} : {supported:false,message:string}|(P extends {operation:'acquire'} ? {supported:true,complete:boolean} : P extends {operation:'loadItem'} ? {loaded:true,itemId:string} : import('./conversation-history.cjs').HistoryPage|{data:[],complete:true,nextCursor:null})} HistoryResponse */
/** @template P @typedef {P extends {operation:'start'} ? Created & {requestId:string,turnId?:string} : P extends {operation:'create'} ? Created & {requestId:string,turnId?:string} : P extends {operation:'close'} ? {threadId:string,requestId:string,accepted:boolean,cleanupConfirmed:boolean} : P extends {operation:'recover'} ? {confirmed:false}|{confirmed:true,requestId:string,threadId:string,turnId?:string,accepted?:boolean,cleanupConfirmed?:boolean} : P extends {operation:'context'} ? SideContext : P extends {operation:'list'} ? {data:import('./conversation-history.cjs').HistorySummary[],nextCursor?:string|null} : TurnAdmission} SideResponse */
/** @typedef {{projectId:string,profile:ResourceRef,skill:ResourceRef&{name:string,description:string},provenance:{upstream:string,revision:string,contentDigest:string}}} PrepareCreatorResponse */
/** @template {Name} N @template [P=Requests[N]] @typedef {N extends 'connect'|'list'|'open'|'configure'|'respond'|'steer'|'dismissRecovery' ? import('./shared.cjs').DesktopSnapshot : N extends 'history' ? HistoryResponse<P> : N extends 'create' ? Created : N extends 'fork' ? Created & {requestId:string} : N extends 'prepareCreator' ? PrepareCreatorResponse : N extends 'side' ? SideResponse<P> : N extends 'prediction' ? Prediction|null : N extends 'send' ? TurnAdmission|{threadId:string,turnId?:string} : N extends 'continue'|'editMessage' ? TurnAdmission : N extends 'stop' ? import('./desktop-control.cjs').LifecycleResult : N extends 'attachBrowser' ? {threadId:string,toolsetRevision:number,bundleId:string} : N extends 'reconcile' ? {outcomes:Record<string,import('./shared.cjs').SubmissionOutcome>} : N extends 'queue' ? P extends {requestId:string} ? SubmissionRead : import('./shared.cjs').Queue : N extends 'queueEdit' ? P extends {operation:'steer'} ? QueueSteer : import('./shared.cjs').Queue : never} Response */
/** @param {unknown} value @returns {value is string} */
function identifier(value) {
  return typeof value === "string" && !!value.trim() && value.length <= 256;
}
/** @param {unknown} value @returns {value is string} */
function uuid(value) {
  return typeof value === "string" && /^[0-9a-f-]{36}$/.test(value);
}
/** @param {Record<string,unknown>} value @param {string[]} keys */
function only(value, keys) {
  return Object.keys(value).every((key) => keys.includes(key));
}
/** @param {unknown} value @returns {value is MessageContent} */
function messageContent(value) {
  if (!modelRecord(value) || (value._meta !== undefined && !modelRecord(value._meta))) return false;
  if (value.type === "text") return typeof value.text === "string" && !!value.text;
  if (value.type === "resource_link")
    return (
      typeof value.uri === "string" &&
      typeof value.name === "string" &&
      (value.mimeType === undefined || typeof value.mimeType === "string")
    );
  return (
    value.type === "resource" &&
    modelRecord(value.resource) &&
    typeof value.resource.uri === "string" &&
    (typeof value.resource.text === "string" || typeof value.resource.blob === "string") &&
    (value.resource.text === undefined || typeof value.resource.text === "string") &&
    (value.resource.blob === undefined || typeof value.resource.blob === "string") &&
    (value.resource.mimeType === undefined || typeof value.resource.mimeType === "string")
  );
}
/** @param {unknown} value @returns {value is Message & Record<string,unknown>} */
function message(value) {
  return (
    modelRecord(value) &&
    (value.text === undefined || typeof value.text === "string") &&
    (value.command === undefined || pluginCommand(value.command)) &&
    (value.attachments === undefined ||
      (Array.isArray(value.attachments) &&
        value.attachments.length <= 16 &&
        value.attachments.every(
          (item) =>
            modelRecord(item) &&
            ["image", "audio", "file"].some((type) => item.type === type) &&
            typeof item.url === "string" &&
            /^areal:\/\/blob\/[A-Za-z0-9_-]+$/.test(item.url) &&
            ["name", "mimeType"].every(
              (key) => item[key] === undefined || typeof item[key] === "string",
            ) &&
            (item._meta === undefined || modelRecord(item._meta)),
        ))) &&
    (value.mcpContent === undefined ||
      (Array.isArray(value.mcpContent) &&
        value.mcpContent.length <= 32 &&
        value.mcpContent.every(messageContent))) &&
    (value.conversationQuotes === undefined ||
      (Array.isArray(value.conversationQuotes) &&
        value.conversationQuotes.length <= 8 &&
        value.conversationQuotes.every(
          (quote) =>
            modelRecord(quote) &&
            only(quote, ["text"]) &&
            typeof quote.text === "string" &&
            !!quote.text.trim() &&
            quote.text.length <= 8000,
        ) &&
        value.conversationQuotes.reduce((total, quote) => total + quote.text.length, 0) <= 16000))
  );
}
/** @param {unknown} value @returns {value is WorktreeSpec} */
function worktree(value) {
  return (
    modelRecord(value) &&
    only(value, [
      "sourceRoot",
      "ref",
      "worktreeRoot",
      "branch",
      "branchPrefix",
      "environmentId",
      "environmentRevision",
      "mode",
    ]) &&
    Object.entries(value).every(([key, item]) =>
      key === "environmentRevision"
        ? count(item)
        : typeof item === "string" &&
          item.length <= 4096 &&
          ![...item].some(
            (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          ),
    ) &&
    (value.mode === undefined || value.mode === "source" || value.mode === "worktree")
  );
}
/** @param {unknown} value @returns {value is SideSelection} */
function sideSelection(value) {
  if (!modelRecord(value)) return false;
  if (value.kind === "itemRange")
    return (
      identifier(value.turnId) &&
      identifier(value.itemId) &&
      count(value.startUtf8) &&
      count(value.endUtf8) &&
      value.endUtf8 >= value.startUtf8 &&
      typeof value.textSha256 === "string" &&
      /^[a-f0-9]{64}$/.test(value.textSha256)
    );
  return (
    value.kind === "userQuote" &&
    typeof value.text === "string" &&
    ["claimedTurnId", "claimedItemId"].every(
      (key) => value[key] == null || typeof value[key] === "string",
    )
  );
}
/** @param {unknown} value @returns {value is SideAnchor} */
function sideAnchor(value) {
  return (
    modelRecord(value) &&
    typeof value.kind === "string" &&
    ["turnId", "boundary"].every((key) => value[key] == null || typeof value[key] === "string")
  );
}
/** @template {Name} N @param {N} name @param {unknown} value @returns {value is Requests[N]} */
function isRequest(name, value) {
  if (!modelRecord(value) || !identifier(value.projectId)) return false;
  if (
    [
      "open",
      "history",
      "prediction",
      "send",
      "editMessage",
      "continue",
      "stop",
      "attachBrowser",
      "respond",
      "configure",
      "queue",
      "queueEdit",
      "steer",
    ].includes(name) &&
    !identifier(value.threadId)
  )
    return false;
  if (
    [
      "create",
      "configure",
      "fork",
      "attachBrowser",
      "continue",
      "send",
      "queueEdit",
      "steer",
    ].includes(name) &&
    value.requestId !== undefined &&
    !uuid(value.requestId)
  )
    return false;
  if (["send", "editMessage", "steer", "queueEdit"].includes(name) && !message(value)) return false;
  if (value.command !== undefined && !["send", "editMessage"].includes(name)) return false;
  switch (name) {
    case "connect":
      return (
        (value.resumeScheduling === undefined || typeof value.resumeScheduling === "boolean") &&
        (value.threadId === undefined || identifier(value.threadId)) &&
        only(value, ["projectId", "resumeScheduling", "threadId"])
      );
    case "list":
      return only(value, ["projectId"]);
    case "reconcile":
      return (
        (value.requestId === undefined || identifier(value.requestId)) &&
        only(value, ["projectId", "requestId"])
      );
    case "open":
      return only(value, ["projectId", "threadId"]);
    case "dismissRecovery":
      return identifier(value.requestId) && only(value, ["projectId", "requestId"]);
    case "prepareCreator":
      return (
        only(value, ["projectId", "profile"]) &&
        (value.profile === undefined ||
          (resourceRef(value.profile) && only(value.profile, ["id", "revision"])))
      );
    case "history":
      return (
        identifier(value.viewId) &&
        ["acquire", "release", "loadItem", "loadOlder"].some(
          (entry) => value.operation === entry,
        ) &&
        (value.operation !== "loadItem" || identifier(value.itemId)) &&
        (value.pageId === undefined || identifier(value.pageId)) &&
        only(value, [
          "projectId",
          "threadId",
          "viewId",
          "operation",
          ...(value.operation === "loadItem" ? ["itemId"] : []),
          ...(value.operation === "loadOlder" ? ["pageId"] : []),
        ])
      );
    case "create":
    case "configure":
      return (
        (value.model == null || modelRef(value.model)) &&
        (value.parameters === undefined || parameters(value.parameters)) &&
        (value.options === undefined || clientOptions(value.options)) &&
        (value.profile === undefined || resourceRef(value.profile)) &&
        (name === "create"
          ? (value.browserEnabled === undefined || typeof value.browserEnabled === "boolean") &&
            (value.worktree === undefined || worktree(value.worktree))
          : ["model", "profile", "options", "parameters", "selectedSkills"].some(
              (key) => value[key] !== undefined,
            ) &&
            (value.expectedRevision === undefined || count(value.expectedRevision)) &&
            (value.selectedSkills === undefined ||
              (Array.isArray(value.selectedSkills) && value.selectedSkills.every(resourceRef))))
      );
    case "fork":
      return (
        identifier(value.sourceThreadId) &&
        value.workspaceMode === "sharedCurrent" &&
        modelRecord(value.anchor) &&
        identifier(value.anchor.turnId) &&
        (value.anchor.boundary === "before" || value.anchor.boundary === "after") &&
        (value.target === undefined ||
          (modelRecord(value.target) &&
            (value.target.agentProfile == null || resourceRef(value.target.agentProfile)) &&
            (value.target.model == null || modelRef(value.target.model)) &&
            (value.target.parameters == null || parameters(value.target.parameters))))
      );
    case "side":
      return sideRequest(value);
    case "prediction":
      return (
        identifier(value.sourceTurnId) &&
        ["request", "cancel"].some((entry) => value.operation === entry) &&
        only(value, ["projectId", "threadId", "sourceTurnId", "operation"])
      );
    case "send":
      return true;
    case "editMessage":
      return (
        identifier(value.expectedTurnId) &&
        identifier(value.itemId) &&
        typeof value.text === "string" &&
        (!!value.text.trim() || value.command !== undefined) &&
        count(value.expectedConfigRevision) &&
        uuid(value.requestId) &&
        only(value, [
          "projectId",
          "threadId",
          "expectedTurnId",
          "itemId",
          "expectedConfigRevision",
          "requestId",
          "text",
          "attachments",
          "mcpContent",
          "conversationQuotes",
          "command",
        ])
      );
    case "continue":
      return (
        identifier(value.expectedTurnId) &&
        (value.expectedConfigRevision === undefined || count(value.expectedConfigRevision)) &&
        only(value, [
          "projectId",
          "threadId",
          "expectedTurnId",
          "expectedConfigRevision",
          "requestId",
        ])
      );
    case "stop":
      return (
        identifier(value.turnId) &&
        uuid(value.requestId) &&
        only(value, ["projectId", "threadId", "turnId", "requestId"])
      );
    case "attachBrowser":
      return count(value.expectedToolsetRevision);
    case "respond":
      return (
        identifier(value.requestId) &&
        (value.answers === undefined
          ? ["deny", "allowOnce", "allowSession", "allowProject"].some(
              (entry) => value.decision === entry,
            )
          : value.decision === undefined &&
            modelRecord(value.answers) &&
            Object.values(value.answers).every((answer) => typeof answer === "string"))
      );
    case "queue":
      return value.requestId === undefined
        ? value.operation === undefined
        : uuid(value.requestId) &&
            ["update", "remove", "reorder", "pause", "resume", "steer"].some(
              (entry) => value.operation === entry,
            );
    case "queueEdit":
      return (
        count(value.expectedRevision) &&
        (["pause", "resume"].some((entry) => value.operation === entry) ||
          (value.operation === "reorder" &&
            strings(value.queueItemIds) &&
            value.queueItemIds.length <= 128 &&
            new Set(value.queueItemIds).size === value.queueItemIds.length) ||
          (["update", "remove", "steer"].some((entry) => value.operation === entry) &&
            identifier(value.queueItemId) &&
            (value.operation !== "steer" || identifier(value.expectedTurnId)) &&
            (value.retainedInput === undefined ||
              (Array.isArray(value.retainedInput) && value.retainedInput.every(modelRecord)))))
      );
    case "steer":
      return identifier(value.expectedTurnId);
  }
  return false;
}
/** @param {Record<string,unknown>} value */
function sideRequest(value) {
  if (
    (value.requestId !== undefined && !identifier(value.requestId)) ||
    (value.resetModel !== undefined && typeof value.resetModel !== "boolean") ||
    (value.resetModel === true && value.model !== undefined) ||
    (value.model !== undefined && !modelRef(value.model)) ||
    (value.parameters !== undefined && !parameters(value.parameters))
  )
    return false;
  switch (value.operation) {
    case "start":
      return (
        identifier(value.sourceThreadId) &&
        typeof value.text === "string" &&
        !!value.text.trim() &&
        (value.workspaceAccess === undefined ||
          value.workspaceAccess === "none" ||
          value.workspaceAccess === "readOnly") &&
        (value.anchor === undefined || sideAnchor(value.anchor)) &&
        (value.selection === undefined || sideSelection(value.selection))
      );
    case "send":
      return identifier(value.threadId) && typeof value.text === "string" && !!value.text.trim();
    case "create":
      return (
        identifier(value.sourceThreadId) &&
        identifier(value.requestId) &&
        (value.firstInput === undefined ||
          (modelRecord(value.firstInput) &&
            typeof value.firstInput.text === "string" &&
            !!value.firstInput.text.trim() &&
            only(value.firstInput, ["text"]))) &&
        only(value, ["projectId", "operation", "sourceThreadId", "requestId", "firstInput"])
      );
    case "close":
      return (
        identifier(value.threadId) &&
        identifier(value.requestId) &&
        only(value, ["projectId", "operation", "threadId", "requestId"])
      );
    case "recover":
      return (
        identifier(value.requestId) &&
        ["sourceThreadId", "threadId"].every(
          (key) => value[key] === undefined || identifier(value[key]),
        ) &&
        (value.method === undefined ||
          ["areal/side/start", "areal/side/create", "areal/side/close"].some(
            (entry) => value.method === entry,
          ))
      );
    case "context":
      return (
        identifier(value.threadId) &&
        ["cursor", "evidenceRef"].every(
          (key) => value[key] === undefined || typeof value[key] === "string",
        ) &&
        (value.maxBytes === undefined ||
          (count(value.maxBytes) && value.maxBytes >= 64 && value.maxBytes <= 16384))
      );
    case "list":
      return (
        identifier(value.sourceThreadId) &&
        (value.includeArchived === undefined || typeof value.includeArchived === "boolean") &&
        (value.cursor === undefined || typeof value.cursor === "string")
      );
  }
  return false;
}
/** @param {unknown} value @returns {value is TurnAdmission} */
function turnAdmission(value) {
  return (
    admission(value) &&
    ((isCoreTurn(value.turn) && typeof value.turn.status === "string") ||
      (count(value.queueRevision) &&
        count(value.configRevision) &&
        (value.queueItemId === null || typeof value.queueItemId === "string")))
  );
}
/** @param {unknown} value @returns {value is SideContext} */
function sideContext(value) {
  return (
    modelRecord(value) &&
    typeof value.snapshotId === "string" &&
    typeof value.complete === "boolean" &&
    (value.nextCursor === null || typeof value.nextCursor === "string") &&
    Array.isArray(value.evidence) &&
    value.evidence.every(
      (entry) =>
        modelRecord(entry) &&
        ["evidenceRef", "sourceTurnId", "sourceItemId", "sourceTurnStatus", "text"].every(
          (key) => typeof entry[key] === "string",
        ) &&
        modelRecord(entry.range) &&
        count(entry.range.startUtf8) &&
        count(entry.range.endUtf8) &&
        count(entry.range.totalBytes),
    )
  );
}
/** @param {unknown} value @returns {value is SubmissionRead} */
function submissionRead(value) {
  return (
    modelRecord(value) &&
    (value.confirmed === false
      ? typeof value.state === "string"
      : value.confirmed === true &&
        value.accepted === true &&
        typeof value.status === "string" &&
        (value.operation === undefined || isOperationRef(value.operation)) &&
        (value.message === undefined || typeof value.message === "string") &&
        (value.error === undefined ||
          (modelRecord(value.error) &&
            typeof value.error.message === "string" &&
            (value.error.code === undefined ||
              typeof value.error.code === "number" ||
              typeof value.error.code === "string"))))
  );
}
/** @param {Name} name @param {Record<string,unknown>} request @param {unknown} value */
function response(name, request, value) {
  if (
    ["connect", "list", "open", "configure", "respond", "steer", "dismissRecovery"].includes(name)
  )
    return isDesktopSnapshot(value);
  if (name === "stop")
    return (
      modelRecord(value) &&
      typeof value.stopped === "boolean" &&
      isLifecycleReceipt(value.operation) &&
      value.operation.requestId === request.requestId &&
      value.operation.threadId === request.threadId &&
      value.operation.turnId === request.turnId &&
      (value.kind === undefined || typeof value.kind === "string")
    );
  if (name === "prediction")
    return (
      value === null ||
      (modelRecord(value) &&
        ["pending", "ready", "unavailable"].some((status) => value.status === status) &&
        typeof value.sourceTurnId === "string" &&
        count(value.configurationRevision) &&
        (value.status !== "ready" || typeof value.text === "string"))
    );
  if (name === "continue" || name === "editMessage") return turnAdmission(value);
  if (name === "send")
    return turnAdmission(value) || require("./management-tasks.cjs").isTaskDraftSend(value);
  if (!modelRecord(value)) return false;
  if (name === "create" || name === "fork")
    return (
      typeof value.threadId === "string" &&
      typeof value.requestId === "string" &&
      (request.requestId === undefined || value.requestId === request.requestId)
    );
  if (name === "attachBrowser")
    return (
      value.threadId === request.threadId &&
      count(value.toolsetRevision) &&
      typeof value.bundleId === "string"
    );
  if (name === "reconcile") return isSubmissionOutcomes(value.outcomes);
  if (name === "queue")
    return request.requestId === undefined ? isQueue(value) : submissionRead(value);
  if (name === "queueEdit")
    return request.operation === "steer"
      ? count(value.queueRevision) &&
          ["queueItemId", "turnId", "itemId"].every((key) => typeof value[key] === "string")
      : isQueue(value);
  if (name === "history") {
    if (request.operation === "release") return value.released === true;
    if (value.supported === false) return typeof value.message === "string";
    if (request.operation === "acquire")
      return value.supported === true && typeof value.complete === "boolean";
    if (request.operation === "loadItem")
      return value.loaded === true && value.itemId === request.itemId;
    return (
      historyPage(value) ||
      (Array.isArray(value.data) &&
        value.data.length === 0 &&
        value.complete === true &&
        value.nextCursor === null)
    );
  }
  if (name === "side") {
    if (request.operation === "context") return sideContext(value);
    if (request.operation === "list")
      return (
        Array.isArray(value.data) &&
        value.data.every(historySummary) &&
        (value.nextCursor == null || typeof value.nextCursor === "string")
      );
    if (request.operation === "recover")
      return (
        value.confirmed === false ||
        (value.confirmed === true &&
          typeof value.threadId === "string" &&
          typeof value.requestId === "string" &&
          (value.turnId === undefined || typeof value.turnId === "string") &&
          ["accepted", "cleanupConfirmed"].every(
            (key) => value[key] === undefined || typeof value[key] === "boolean",
          ))
      );
    if (request.operation === "send") return turnAdmission(value);
    return (
      typeof value.threadId === "string" &&
      typeof value.requestId === "string" &&
      (value.turnId === undefined || typeof value.turnId === "string") &&
      (request.operation !== "close" ||
        (typeof value.requestId === "string" &&
          typeof value.accepted === "boolean" &&
          typeof value.cleanupConfirmed === "boolean"))
    );
  }
  if (name === "prepareCreator")
    return (
      value.projectId === request.projectId &&
      resourceRef(value.profile) &&
      modelRecord(value.skill) &&
      resourceRef(value.skill) &&
      typeof value.skill.name === "string" &&
      !!value.skill.name.trim() &&
      value.skill.name.length <= 256 &&
      typeof value.skill.description === "string" &&
      value.skill.description.length <= 8192 &&
      modelRecord(value.provenance) &&
      identifier(value.provenance.upstream) &&
      identifier(value.provenance.revision) &&
      typeof value.provenance.contentDigest === "string" &&
      /^[a-f0-9]{64}$/.test(value.provenance.contentDigest) &&
      only(value, ["projectId", "profile", "skill", "provenance"]) &&
      only(value.profile, ["id", "revision"]) &&
      only(value.skill, ["id", "revision", "name", "description"]) &&
      only(value.provenance, ["upstream", "revision", "contentDigest"])
    );
  return false;
}
/** @template {Name} N @template {Requests[N]} P @param {N} name @param {P} request @param {unknown} value @returns {asserts value is Response<N,P>} */
function validateResponse(name, request, value) {
  if (!response(name, request, value))
    throw Object.assign(new Error("Invalid Desktop conversation response"), {
      code: "DESKTOP_RESPONSE_INVALID",
    });
}
module.exports = {
  sideSelection,
  sideAnchor,
  isRequest,
  validateResponse,
  clientOptions,
  message,
  messageContent,
  turnAdmission,
  sideContext,
  submissionRead,
};

/** @param {unknown} value @returns {value is PluginCommandRef} */
function pluginCommand(value) {
  return (
    modelRecord(value) &&
    ["pluginId", "componentId", "installedDigest"].every(
      (key) => typeof value[key] === "string" && value[key].length > 0,
    ) &&
    typeof value.arguments === "string" &&
    new TextEncoder().encode(value.arguments).length <= 65536 &&
    only(value, ["pluginId", "componentId", "installedDigest", "arguments"])
  );
}
