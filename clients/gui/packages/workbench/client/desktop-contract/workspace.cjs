// @ts-check
"use strict";
const { modelRecord } = require("../core-model-contract.js");
const {
  isOperation,
  worktreeSettings,
  environmentDefinition,
  isWorktreeRequest,
  environmentAttempt,
} = require("./workspace-worktrees.cjs");
/** @typedef {{projectId:string} & ({operation:'list',path:string,showAll?:boolean}|{operation:'search',query:string}|{operation:'localDirectoryReference',path:string}|{operation:'read',path:string}|{operation:'save',path:string,text:string,revision:string}|{operation:'review',scope?:'task'|'uncommitted'|'unstaged'|'staged'|'branch'|'commit',ref?:string}|{operation:'reviewCommits'|'reviewBranches'|'status'|'info'|'gitState'}|{operation:'turnReview',threadId:string,turnId:string,itemId?:string}|{operation:'gitStage'|'gitUnstage',token:string}|{operation:'gitCommit',token:string,message:string}|{operation:'gitPush',token:string,remote:string,targetBranch:string})} FileRequest */
/** @typedef {{operation:'worktreeList',projectId?:string}|{operation:'worktreeSettings',projectId?:string,worktreeRoot:string,branchPrefix:string,fetchBeforeCreate?:boolean,autoCleanup?:boolean,keepCount?:number,expectedRevision?:number}|({projectId:string}&({operation:'worktreeOptions',sourceRoot?:string}|{operation:'worktreeEnvironmentSave',environment:import('./workspace-worktrees.cjs').EnvironmentDefinition,expectedRevision:number}|{operation:'worktreeEnvironmentDelete',environmentId:string,expectedRevision:number}|{operation:'worktreeCancel'|'worktreeRead'|'worktreeOpen',requestId:string}|{operation:'worktreeAction',requestId:string,worktreeRequestId:string,actionId:string}|{operation:'worktreeDelete',requestId:string,worktreeRequestId:string}|{operation:'worktreeCreate',requestId:string,source?:'head'|'branch',sourceRoot?:string,ref?:string,worktreeRoot?:string,branch?:string,branchPrefix?:string}))} WorktreeCommandRequest */
/** @typedef {FileRequest|WorktreeCommandRequest} WorkspaceRequest */
/** @typedef {{kind:'add'|'del'|'context'|'meta',text:string,oldLine:number|null,newLine:number|null}} ReviewLine */
/** @typedef {{oldStart:number,oldLines:number,newStart:number,newLines:number,lines:ReviewLine[]}} ReviewHunk */
/** @typedef {{path:string,additions:number,deletions:number,hunks:ReviewHunk[],binary:boolean,beforeText?:string,afterText?:string}} ReviewFile */
/** @typedef {{root:string,head:string,base:string,diff:string,files:ReviewFile[],scope:string,token:string,reference?:{id:string,label:string}|null,dirty?:boolean,target?:string|null,branch?:string,targetDirty?:boolean,conflicts?:string[],turnId?:string,itemId?:string,notice?:string,unavailableFiles?:Array<{path:string,reason:string}>}} Review */
/** @typedef {{worktreeRoot:string,branchPrefix:string,fetchBeforeCreate:boolean,autoCleanup:boolean,keepCount:number}} Settings */
/** @typedef {{environments:import('./workspace-worktrees.cjs').EnvironmentDefinition[],environmentRevision:number}} EnvironmentStore */
/** @typedef {{root:string,head:string,branch:string,staged:string[],unstaged:string[],remotes:string[],token:string}} GitState */
/** @typedef {{directory:string,root:string,git:false}|{directory:string,root:string,branch:string,head:string,dirty:boolean,target?:string,base?:string,source?:string,sourceRef?:string|null,createdAt?:string}} WorkspaceInfo */
/** @typedef {{root:string,head:string|null,branch:string|null,detached?:boolean,bare?:boolean,locked?:boolean,prunable?:boolean}} GitWorktree */
/** @typedef {{settings:Settings,defaultRoot:string,revision:number,projects:Array<{id:string,root:string,name:string}&EnvironmentStore>,worktrees:Array<import('./workspace-worktrees.cjs').WorktreeOperation&{directory:string,branch:string,deleted:boolean}>}} WorktreeList */
/** @typedef {{worktrees:GitWorktree[],branches:string[],settings:Settings,defaultRoot:string}&EnvironmentStore} WorktreeOptions */
/** @typedef {{
 * localDirectoryReference:{path:string,name:string,type:'directory'},
 * list:{path:string,entries:Array<{name:string,dir:boolean,size:number,hidden:boolean}>,truncated:boolean,total:number},
 * search:{entries:Array<{path:string,dir:boolean}>,truncated:boolean},read:{path:string,text:string,revision:string},save:{conflict:true,error:string}|{saved:true,revision:string},
 * review:Review,turnReview:Review,reviewCommits:{head:string,commits:Array<{id:string,subject:string,committedAt:number}>,truncated:boolean},reviewBranches:{branches:Array<{ref:string,name:string,id:string}>},
 * status:{available:boolean,entries:Array<{path:string,status:'U'|'C'|'D'|'R'|'A'|'M'}>},info:WorkspaceInfo,gitState:GitState,
 * gitStage:{applied:true},gitUnstage:{applied:true},gitCommit:{applied:true,head:string},gitPush:{applied:true,head:string,remote:string,targetBranch:string},
 * worktreeList:WorktreeList,worktreeSettings:Settings,worktreeOptions:WorktreeOptions,worktreeEnvironmentSave:EnvironmentStore,worktreeEnvironmentDelete:EnvironmentStore,
 * worktreeRead:import('./workspace-worktrees.cjs').WorktreeOperation|{state:'missing'},worktreeCreate:import('./workspace-worktrees.cjs').WorktreeOperation,
 * worktreeCancel:import('./workspace-worktrees.cjs').WorktreeOperation&{cancelResult?:'tooLate'},worktreeAction:import('./workspace-worktrees.cjs').EnvironmentAttempt|null,
 * worktreeDelete:import('./workspace-worktrees.cjs').WorktreeOperation,worktreeOpen:{projectId:string,root:string,threadId?:string,requestId?:string}
 * }} WorkspaceResponseMap */
/** @template {WorkspaceRequest} P @typedef {WorkspaceResponseMap[P['operation']]} WorkspaceResponse */
/** @param {unknown} value @returns {value is string[]} */
const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
/** @param {unknown} value @returns {value is number} */
const number = (value) => typeof value === "number" && Number.isFinite(value);
/** @param {unknown} value @returns {value is EnvironmentStore & Record<string,unknown>} */
function environmentStore(value) {
  return (
    modelRecord(value) &&
    Array.isArray(value.environments) &&
    value.environments.every(environmentDefinition) &&
    number(value.environmentRevision)
  );
}
/** @param {unknown} value @returns {value is GitWorktree} */
function gitWorktree(value) {
  return (
    modelRecord(value) &&
    typeof value.root === "string" &&
    (value.head === null || typeof value.head === "string") &&
    (value.branch === null || typeof value.branch === "string") &&
    ["detached", "bare", "locked", "prunable"].every(
      (key) => value[key] === undefined || typeof value[key] === "boolean",
    )
  );
}
/** @param {unknown} value @returns {value is Review} */
function review(value) {
  return (
    modelRecord(value) &&
    ["root", "head", "base", "diff", "scope", "token"].every(
      (key) => typeof value[key] === "string",
    ) &&
    (value.unavailableFiles === undefined ||
      (Array.isArray(value.unavailableFiles) &&
        value.unavailableFiles.every(
          (file) =>
            modelRecord(file) && typeof file.path === "string" && typeof file.reason === "string",
        ))) &&
    Array.isArray(value.files) &&
    value.files.every(
      (file) =>
        modelRecord(file) &&
        typeof file.path === "string" &&
        number(file.additions) &&
        number(file.deletions) &&
        typeof file.binary === "boolean" &&
        ["beforeText", "afterText"].every(
          (key) => file[key] === undefined || typeof file[key] === "string",
        ) &&
        Array.isArray(file.hunks) &&
        file.hunks.every(
          (hunk) =>
            modelRecord(hunk) &&
            ["oldStart", "oldLines", "newStart", "newLines"].every((key) => number(hunk[key])) &&
            Array.isArray(hunk.lines) &&
            hunk.lines.every(
              (line) =>
                modelRecord(line) &&
                typeof line.kind === "string" &&
                ["add", "del", "context", "meta"].includes(line.kind) &&
                typeof line.text === "string" &&
                (line.oldLine === null || number(line.oldLine)) &&
                (line.newLine === null || number(line.newLine)),
            ),
        ),
    ) &&
    (value.reference == null ||
      (modelRecord(value.reference) &&
        typeof value.reference.id === "string" &&
        typeof value.reference.label === "string")) &&
    ["dirty", "targetDirty"].every(
      (key) => value[key] === undefined || typeof value[key] === "boolean",
    ) &&
    (value.target == null || typeof value.target === "string") &&
    ["branch", "turnId", "itemId", "notice"].every(
      (key) => value[key] === undefined || typeof value[key] === "string",
    ) &&
    (value.conflicts === undefined || strings(value.conflicts))
  );
}
/** @param {unknown} value @returns {value is WorkspaceRequest} */
function isWorkspaceRequest(value) {
  if (!modelRecord(value) || typeof value.operation !== "string") return false;
  if (
    value.operation !== "worktreeList" &&
    value.operation !== "worktreeSettings" &&
    typeof value.projectId !== "string"
  )
    return false;
  if (value.operation.startsWith("worktree")) {
    if (!isWorktreeRequest(value)) return false;
    switch (value.operation) {
      case "worktreeList":
        return true;
      case "worktreeSettings":
        return (
          typeof value.worktreeRoot === "string" &&
          value.worktreeRoot.length <= 4096 &&
          typeof value.branchPrefix === "string" &&
          value.branchPrefix.length > 0 &&
          value.branchPrefix.length <= 128 &&
          ![...value.worktreeRoot, ...value.branchPrefix].some(
            (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          ) &&
          (value.keepCount === undefined ||
            (Number.isSafeInteger(value.keepCount) &&
              value.keepCount >= 1 &&
              value.keepCount <= 1000)) &&
          (value.expectedRevision === undefined ||
            (Number.isSafeInteger(value.expectedRevision) && value.expectedRevision >= 0)) &&
          Object.keys(value).every((key) =>
            [
              "projectId",
              "operation",
              "worktreeRoot",
              "branchPrefix",
              "fetchBeforeCreate",
              "autoCleanup",
              "keepCount",
              "expectedRevision",
            ].includes(key),
          )
        );
      case "worktreeOptions":
        return value.sourceRoot === undefined || typeof value.sourceRoot === "string";
      case "worktreeEnvironmentSave":
        return environmentDefinition(value.environment) && number(value.expectedRevision);
      case "worktreeEnvironmentDelete":
        return typeof value.environmentId === "string" && number(value.expectedRevision);
      case "worktreeCreate":
        return (
          typeof value.requestId === "string" &&
          (value.source === undefined || value.source === "head" || value.source === "branch")
        );
      case "worktreeRead":
      case "worktreeCancel":
      case "worktreeOpen":
        return typeof value.requestId === "string";
      case "worktreeAction":
        return (
          typeof value.requestId === "string" &&
          typeof value.worktreeRequestId === "string" &&
          typeof value.actionId === "string"
        );
      case "worktreeDelete":
        return typeof value.requestId === "string" && typeof value.worktreeRequestId === "string";
      default:
        return false;
    }
  }
  switch (value.operation) {
    case "list":
      return (
        typeof value.path === "string" &&
        (value.showAll === undefined || typeof value.showAll === "boolean")
      );
    case "search":
      return typeof value.query === "string";
    case "localDirectoryReference":
    case "read":
      return typeof value.path === "string";
    case "save":
      return ["path", "text", "revision"].every((key) => typeof value[key] === "string");
    case "review":
      return (
        (value.scope === undefined ||
          (typeof value.scope === "string" &&
            ["task", "uncommitted", "unstaged", "staged", "branch", "commit"].includes(
              value.scope,
            ))) &&
        (value.ref === undefined || typeof value.ref === "string")
      );
    case "reviewCommits":
    case "reviewBranches":
    case "status":
    case "info":
    case "gitState":
      return true;
    case "turnReview":
      return (
        typeof value.threadId === "string" &&
        typeof value.turnId === "string" &&
        (value.itemId === undefined || typeof value.itemId === "string")
      );
    case "gitStage":
    case "gitUnstage":
      return typeof value.token === "string";
    case "gitCommit":
      return typeof value.token === "string" && typeof value.message === "string";
    case "gitPush":
      return ["token", "remote", "targetBranch"].every((key) => typeof value[key] === "string");
    default:
      return false;
  }
}
/** @param {unknown} value @returns {WorkspaceRequest} */
function readWorkspaceRequest(value) {
  if (!isWorkspaceRequest(value)) throw new Error("工作区请求结构无效");
  return value;
}
/** @param {WorkspaceRequest} request @param {unknown} value */
function validateWorkspaceResponse(request, value) {
  if (request.operation === "worktreeAction" && value === null) return;
  if (!modelRecord(value)) throw new Error("工作区响应结构无效");
  const operation = request.operation;
  const valid = (() => {
    switch (operation) {
      case "worktreeList":
        return (
          worktreeSettings(value.settings) &&
          typeof value.defaultRoot === "string" &&
          number(value.revision) &&
          Array.isArray(value.projects) &&
          value.projects.every(
            (project) =>
              environmentStore(project) &&
              modelRecord(project) &&
              ["id", "root", "name"].every((key) => typeof project[key] === "string"),
          ) &&
          Array.isArray(value.worktrees) &&
          value.worktrees.every(
            (tree) =>
              isOperation(tree) &&
              typeof tree.directory === "string" &&
              typeof tree.branch === "string" &&
              typeof tree.deleted === "boolean",
          )
        );
      case "worktreeOptions":
        return (
          environmentStore(value) &&
          worktreeSettings(value.settings) &&
          typeof value.defaultRoot === "string" &&
          strings(value.branches) &&
          Array.isArray(value.worktrees) &&
          value.worktrees.every(gitWorktree)
        );
      case "worktreeSettings":
        return worktreeSettings(value);
      case "worktreeEnvironmentSave":
      case "worktreeEnvironmentDelete":
        return environmentStore(value);
      case "worktreeRead":
        return value.state === "missing" || isOperation(value);
      case "worktreeCreate":
      case "worktreeDelete":
        return isOperation(value);
      case "worktreeAction":
        return environmentAttempt(value);
      case "worktreeCancel":
        return (
          isOperation(value) &&
          (value.cancelResult === undefined || value.cancelResult === "tooLate")
        );
      case "worktreeOpen":
        return (
          typeof value.projectId === "string" &&
          typeof value.root === "string" &&
          ["threadId", "requestId"].every(
            (key) => value[key] === undefined || typeof value[key] === "string",
          )
        );
      case "localDirectoryReference":
        return (
          value.type === "directory" &&
          typeof value.name === "string" &&
          value.path === request.path
        );
      case "read":
        return ["path", "text", "revision"].every((key) => typeof value[key] === "string");
      case "save":
        return (
          (value.conflict === true && typeof value.error === "string") ||
          (value.saved === true && typeof value.revision === "string")
        );
      case "list":
        return (
          typeof value.path === "string" &&
          typeof value.truncated === "boolean" &&
          number(value.total) &&
          Array.isArray(value.entries) &&
          value.entries.every(
            (entry) =>
              modelRecord(entry) &&
              typeof entry.name === "string" &&
              typeof entry.dir === "boolean" &&
              number(entry.size) &&
              typeof entry.hidden === "boolean",
          )
        );
      case "search":
        return (
          typeof value.truncated === "boolean" &&
          Array.isArray(value.entries) &&
          value.entries.every(
            (entry) =>
              modelRecord(entry) &&
              typeof entry.path === "string" &&
              typeof entry.dir === "boolean",
          )
        );
      case "review":
      case "turnReview":
        return review(value);
      case "reviewCommits":
        return (
          typeof value.head === "string" &&
          typeof value.truncated === "boolean" &&
          Array.isArray(value.commits) &&
          value.commits.every(
            (commit) =>
              modelRecord(commit) &&
              typeof commit.id === "string" &&
              typeof commit.subject === "string" &&
              number(commit.committedAt),
          )
        );
      case "reviewBranches":
        return (
          Array.isArray(value.branches) &&
          value.branches.every(
            (branch) =>
              modelRecord(branch) &&
              ["ref", "name", "id"].every((key) => typeof branch[key] === "string"),
          )
        );
      case "status":
        return (
          typeof value.available === "boolean" &&
          Array.isArray(value.entries) &&
          value.entries.every(
            (entry) =>
              modelRecord(entry) &&
              typeof entry.path === "string" &&
              typeof entry.status === "string" &&
              ["U", "C", "D", "R", "A", "M"].includes(entry.status),
          )
        );
      case "info":
        return (
          typeof value.directory === "string" &&
          typeof value.root === "string" &&
          (value.git === false ||
            (typeof value.branch === "string" &&
              typeof value.head === "string" &&
              typeof value.dirty === "boolean" &&
              ["target", "base", "source", "createdAt"].every(
                (key) => value[key] === undefined || typeof value[key] === "string",
              ) &&
              (value.sourceRef == null || typeof value.sourceRef === "string")))
        );
      case "gitState":
        return (
          ["root", "head", "branch", "token"].every((key) => typeof value[key] === "string") &&
          strings(value.staged) &&
          strings(value.unstaged) &&
          strings(value.remotes)
        );
      case "gitStage":
      case "gitUnstage":
        return value.applied === true;
      case "gitCommit":
        return value.applied === true && typeof value.head === "string";
      case "gitPush":
        return (
          value.applied === true &&
          ["head", "remote", "targetBranch"].every((key) => typeof value[key] === "string")
        );
    }
  })();
  if (!valid) throw new Error("工作区响应结构无效");
}
module.exports = { isWorkspaceRequest, readWorkspaceRequest, validateWorkspaceResponse, review };
