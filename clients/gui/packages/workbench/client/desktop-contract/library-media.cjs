// @ts-check
"use strict";
const { modelRecord } = require("../core-model-contract.js");
const { environmentDefinition } = require("./workspace-worktrees.cjs");
/** @typedef {{id:string,parentThreadId?:string,conversation?:{kind:string},name?:string,preview?:string,createdAt?:number,updatedAt?:number,desktop?:{archived:boolean}}} NavigationSummary */
/** @typedef {{name?:string,worktreeEnvironments?:import("./workspace-worktrees.cjs").EnvironmentDefinition[],worktreeEnvironmentRevision?:number,title?:string,pinned?:boolean,sectionId?:string|null,unread?:boolean,completionId?:string,scheduledCompletionId?:string,hidden?:boolean,threadOrder?:string[],navigationSummaries?:NavigationSummary[]}} LibraryMetadata */
/** @typedef {{projects:Record<string,LibraryMetadata>,threads:Record<string,LibraryMetadata>,projectOrder:string[],sections:Array<{id:string,title:string}>,sidebarThreadOrder:string[],sidebarRevision:number,settings:Record<string,unknown> & Partial<LibrarySettingValues> & {blockPrivatePreviewNetworks?:boolean,worktrees?:Partial<import("./workspace-worktrees.cjs").WorktreeSettings>,worktreeRevision?:number,projectlessDirectory?:string,browserLinkTarget?:'internal'|'external',browserLocalTarget?:'internal'|'external',browserFullAddress?:boolean}}} LibraryState */
/** @typedef {{type:string,id?:string,projectId?:string,group?:string}} SidebarItem */
/** @typedef {{projectId?:string,threadId?:string,title?:string,before?:string|null,sectionId?:string|null,hidden?:boolean,pinned?:boolean,read?:boolean,completionId?:string,key?:string,value?:unknown,order?:string[],source?:SidebarItem,target?:SidebarItem,anchor?:string|null,edge?:string,expectedSidebarRevision?:number} & ({operation:'dropSidebar',source:SidebarItem,target:SidebarItem,expectedSidebarRevision:number}|{operation:'renameProject',projectId:string,title:string}|{operation:'renameThread',projectId:string,threadId:string,title:string}|{operation:'pinThread',projectId:string,threadId:string,pinned:boolean}|{operation:'pinProject',projectId:string,pinned:boolean}|{operation:'createSection',title:string}|{operation:'renameSection',sectionId:string,title:string}|{operation:'removeSection'|'orderSection',sectionId:string}|{operation:'moveThread'|'orderThread'|'orderSidebarThread',projectId:string,threadId:string}|{operation:'moveProject'|'orderProject',projectId:string}|{operation:'readThread',projectId:string,threadId:string,read:boolean}|{operation:'markAllRead'}|{operation:'hideProject',projectId:string,hidden:boolean}|LibrarySettingRequest)} LibraryRequest */
/** @param {unknown} value @returns {value is string[]} */
function strings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
/** @param {unknown} value @returns {value is LibraryMetadata} */
function metadata(value) {
  return (
    modelRecord(value) &&
    ["name", "title", "completionId", "scheduledCompletionId"].every(
      (key) => value[key] === undefined || typeof value[key] === "string",
    ) &&
    ["pinned", "unread", "hidden"].every(
      (key) => value[key] === undefined || typeof value[key] === "boolean",
    ) &&
    (value.worktreeEnvironmentRevision === undefined ||
      typeof value.worktreeEnvironmentRevision === "number") &&
    (value.worktreeEnvironments === undefined ||
      (Array.isArray(value.worktreeEnvironments) &&
        value.worktreeEnvironments.every(environmentDefinition))) &&
    (value.sectionId == null || typeof value.sectionId === "string") &&
    (value.threadOrder === undefined || strings(value.threadOrder)) &&
    (value.navigationSummaries === undefined ||
      (Array.isArray(value.navigationSummaries) &&
        value.navigationSummaries.every(navigationSummary)))
  );
}
/** @param {unknown} value @returns {value is NavigationSummary} */
function navigationSummary(value) {
  return (
    modelRecord(value) &&
    typeof value.id === "string" &&
    ["parentThreadId", "name", "preview"].every(
      (key) => value[key] === undefined || typeof value[key] === "string",
    ) &&
    ["createdAt", "updatedAt"].every(
      (key) => value[key] === undefined || typeof value[key] === "number",
    ) &&
    (value.conversation === undefined ||
      (modelRecord(value.conversation) && typeof value.conversation.kind === "string")) &&
    (value.desktop === undefined ||
      (modelRecord(value.desktop) && typeof value.desktop.archived === "boolean"))
  );
}
/** @param {unknown} raw @param {LibraryState} defaults @returns {LibraryState} */
function readLibraryState(raw, defaults) {
  if (!modelRecord(raw)) throw new Error("无效侧栏整理记录");
  const value = { ...defaults, ...raw };
  if (!isLibraryState(value)) throw new Error("无效侧栏整理记录");
  return value;
}
/** @param {unknown} value @returns {value is LibraryState} */
function isLibraryState(value) {
  return (
    modelRecord(value) &&
    modelRecord(value.projects) &&
    Object.values(value.projects).every(metadata) &&
    modelRecord(value.threads) &&
    Object.values(value.threads).every(metadata) &&
    strings(value.projectOrder) &&
    strings(value.sidebarThreadOrder) &&
    typeof value.sidebarRevision === "number" &&
    modelRecord(value.settings) &&
    Object.entries(value.settings).every(
      ([key, item]) => !Object.hasOwn(librarySettingKinds, key) || librarySetting(key, item),
    ) &&
    (value.settings.blockPrivatePreviewNetworks === undefined ||
      typeof value.settings.blockPrivatePreviewNetworks === "boolean") &&
    (value.settings.projectlessDirectory === undefined ||
      typeof value.settings.projectlessDirectory === "string") &&
    (value.settings.worktreeRevision === undefined ||
      typeof value.settings.worktreeRevision === "number") &&
    (value.settings.worktrees === undefined ||
      (modelRecord(value.settings.worktrees) &&
        Object.entries(value.settings.worktrees).every(
          ([key, item]) =>
            ![
              "worktreeRoot",
              "branchPrefix",
              "fetchBeforeCreate",
              "autoCleanup",
              "keepCount",
            ].includes(key) ||
            typeof item ===
              (key === "keepCount"
                ? "number"
                : ["worktreeRoot", "branchPrefix"].includes(key)
                  ? "string"
                  : "boolean"),
        ))) &&
    Array.isArray(value.sections) &&
    value.sections.every(
      (item) => modelRecord(item) && typeof item.id === "string" && typeof item.title === "string",
    )
  );
}
/** @param {unknown} value @returns {value is SidebarItem} */
function sidebarItem(value) {
  return (
    modelRecord(value) &&
    typeof value.type === "string" &&
    ["id", "projectId", "group"].every(
      (key) => value[key] === undefined || typeof value[key] === "string",
    )
  );
}
/** @param {unknown} value @returns {LibraryRequest} */
function readLibraryRequest(value) {
  if (!isLibraryRequest(value)) throw new Error("无效整理操作");
  return value;
}
/** @param {unknown} value @returns {value is LibraryRequest} */
function isLibraryRequest(value) {
  return (
    modelRecord(value) &&
    libraryOperation(value) &&
    ["projectId", "threadId", "title", "completionId", "key", "edge"].every(
      (key) => value[key] === undefined || typeof value[key] === "string",
    ) &&
    ["sectionId", "before", "anchor"].every(
      (key) => value[key] == null || typeof value[key] === "string",
    ) &&
    ["hidden", "pinned", "read"].every(
      (key) => value[key] === undefined || typeof value[key] === "boolean",
    ) &&
    (value.order === undefined || strings(value.order)) &&
    (value.source === undefined || sidebarItem(value.source)) &&
    (value.target === undefined || sidebarItem(value.target)) &&
    (value.expectedSidebarRevision === undefined ||
      typeof value.expectedSidebarRevision === "number")
  );
}

/** @typedef {{snapShot:import("./snapshots.cjs").SnapShotSettings,showPinned:boolean,showCompleted:boolean,permissionNotifications:boolean,questionNotifications:boolean,preventSleep:boolean,showInMenuBar:boolean,terminalInheritSystemProfile:boolean,hardwareAcceleration:boolean,taskNotifications:boolean,computerControlEnabled:boolean,computerControlShowEntry:boolean,browserFullAddress:boolean,terminalFontFamily:string,httpProxy:string,httpProxyNoProxy:string,httpProxyCaCertPath:string,computerControlExecutable:string,busyEnter:'queue'|'steer',sidebarSort:'manual'|'updated_at'|'priority',sidebarSortChats:'manual'|'updated_at'|'priority',sidebarSortProjects:'manual'|'updated_at'|'priority',sidebarSortPinned:'manual'|'updated_at'|'priority',turnNotifications:'always'|'unfocused'|'never',notificationSound:'default'|'silent',fileOpenTarget:'system'|'finder'|'zed'|'vscode'|'cursor',computerControlProvider:'native'|'lcu',browserLinkTarget:'internal'|'external',browserLocalTarget:'internal'|'external'}} LibrarySettingValues */
/** @typedef {{[K in keyof LibrarySettingValues]:{operation:'settings',key:K,value:LibrarySettingValues[K],order?:string[]}}[keyof LibrarySettingValues]} LibrarySettingRequest */
/** @typedef {'snapShot'|'showPinned'|'showCompleted'|'busyEnter'|'sidebarSort'|'sidebarSortChats'|'sidebarSortProjects'|'sidebarSortPinned'|'turnNotifications'|'permissionNotifications'|'questionNotifications'|'notificationSound'|'preventSleep'|'showInMenuBar'|'fileOpenTarget'|'terminalInheritSystemProfile'|'hardwareAcceleration'|'taskNotifications'|'computerControlEnabled'|'computerControlShowEntry'|'computerControlProvider'|'browserLinkTarget'|'browserLocalTarget'|'browserFullAddress'|'terminalFontFamily'|'httpProxy'|'httpProxyNoProxy'|'httpProxyCaCertPath'|'computerControlExecutable'} LibrarySettingKey */
/** @typedef {string|boolean} LibrarySettingValue */
/** @param {Record<string,unknown>} value */
function libraryOperation(value) {
  const required = {
    dropSidebar: ["source", "target", "expectedSidebarRevision"],
    renameProject: ["projectId", "title"],
    renameThread: ["projectId", "threadId", "title"],
    pinThread: ["projectId", "threadId", "pinned"],
    pinProject: ["projectId", "pinned"],
    createSection: ["title"],
    renameSection: ["sectionId", "title"],
    removeSection: ["sectionId"],
    orderSection: ["sectionId"],
    moveThread: ["projectId", "threadId"],
    moveProject: ["projectId"],
    readThread: ["projectId", "threadId", "read"],
    markAllRead: [],
    orderSidebarThread: ["projectId", "threadId"],
    hideProject: ["projectId", "hidden"],
    orderProject: ["projectId"],
    orderThread: ["projectId", "threadId"],
    settings: ["key", "value"],
  };
  if (typeof value.operation !== "string" || !Object.hasOwn(required, value.operation))
    return false;
  const fields = Object.entries(required).find(([name]) => name === value.operation)?.[1];
  if (!fields || !fields.every((key) => value[key] !== undefined)) return false;
  return (
    value.operation !== "settings" ||
    (typeof value.key === "string" && librarySetting(value.key, value.value))
  );
}
/** @param {string} key @param {unknown} value */
function librarySetting(key, value) {
  if (key === "snapShot") return require("./snapshots.cjs").isSnapShotSettings(value);
  const kind = Object.entries(librarySettingKinds).find(([name]) => name === key)?.[1];
  return Array.isArray(kind)
    ? kind.some((candidate) => candidate === value)
    : kind === "string"
      ? typeof value === "string"
      : kind === "boolean" && typeof value === "boolean";
}
/** @typedef {{uri:string,mimeType:string,sizeBytes:number}} MediaReference */
/** @typedef {{projectId:string,threadId:string} & ({operation:'list'}|{operation:'read',uri:string}|{operation:'release',uri:string,requestId?:string}|{operation:'upload',bytes:Uint8Array,mime:string})} MediaRequest */
/** @template {MediaRequest} P @typedef {P extends {operation:'list'} ? {uploads:MediaReference[],archived:boolean} : P extends {operation:'read'} ? {bytes:Uint8Array,mime:string|null} : P extends {operation:'release'} ? {released:true} : MediaReference} MediaResponse */
/** @param {unknown} value @returns {value is MediaReference} */
function mediaReference(value) {
  return (
    modelRecord(value) &&
    typeof value.uri === "string" &&
    typeof value.mimeType === "string" &&
    typeof value.sizeBytes === "number" &&
    Number.isSafeInteger(value.sizeBytes) &&
    value.sizeBytes >= 0
  );
}
/** @param {unknown} value @returns {value is MediaRequest} */
function isMediaRequest(value) {
  if (
    !modelRecord(value) ||
    typeof value.projectId !== "string" ||
    typeof value.threadId !== "string"
  )
    return false;
  if (value.operation === "list") return true;
  if (value.operation === "read" || value.operation === "release")
    return (
      typeof value.uri === "string" &&
      (value.requestId === undefined || typeof value.requestId === "string")
    );
  return (
    value.operation === "upload" &&
    value.bytes instanceof Uint8Array &&
    typeof value.mime === "string"
  );
}
/** @param {unknown} value @returns {MediaRequest} */
function readMediaRequest(value) {
  if (!isMediaRequest(value)) throw new Error("附件请求结构无效");
  return value;
}
/** @param {MediaRequest} request @param {unknown} value */
function validateMediaResponse(request, value) {
  const valid =
    request.operation === "upload"
      ? mediaReference(value)
      : request.operation === "read"
        ? modelRecord(value) &&
          value.bytes instanceof Uint8Array &&
          (value.mime === null || typeof value.mime === "string")
        : request.operation === "release"
          ? modelRecord(value) && value.released === true
          : modelRecord(value) &&
            Array.isArray(value.uploads) &&
            value.uploads.every(mediaReference) &&
            typeof value.archived === "boolean";
  if (!valid) throw new Error("附件响应结构无效");
}
module.exports = {
  isLibraryState,
  readLibraryState,
  readLibraryRequest,
  isLibraryRequest,
  isMediaRequest,
  readMediaRequest,
  validateMediaResponse,
  mediaReference,
};

const librarySettingKinds = {
  showPinned: "boolean",
  showCompleted: "boolean",
  permissionNotifications: "boolean",
  questionNotifications: "boolean",
  preventSleep: "boolean",
  showInMenuBar: "boolean",
  terminalInheritSystemProfile: "boolean",
  hardwareAcceleration: "boolean",
  taskNotifications: "boolean",
  computerControlEnabled: "boolean",
  computerControlShowEntry: "boolean",
  browserFullAddress: "boolean",
  terminalFontFamily: "string",
  httpProxy: "string",
  httpProxyNoProxy: "string",
  httpProxyCaCertPath: "string",
  computerControlExecutable: "string",
  busyEnter: ["queue", "steer"],
  sidebarSort: ["manual", "updated_at", "priority"],
  sidebarSortChats: ["manual", "updated_at", "priority"],
  sidebarSortProjects: ["manual", "updated_at", "priority"],
  sidebarSortPinned: ["manual", "updated_at", "priority"],
  turnNotifications: ["always", "unfocused", "never"],
  notificationSound: ["default", "silent"],
  fileOpenTarget: ["system", "finder", "zed", "vscode", "cursor"],
  computerControlProvider: ["native", "lcu"],
  browserLinkTarget: ["internal", "external"],
  browserLocalTarget: ["internal", "external"],
};
