// @ts-check
"use strict";
const { join } = require("node:path");
const { createGenUiStateStorage } = require("@areal/gen-ui/node");
/** @typedef {{id:string,root:string,state?:unknown}} GenUiProject */
/** @param {string} home @param {GenUiProject} project @param {string} threadId */
function genUiScope(home, project, threadId) {
  const state = record(project.state) ? project.state : undefined;
  const threads = record(state?.threads) ? state.threads : undefined;
  const candidate = threads?.[threadId];
  if (candidate !== undefined && !record(candidate)) throw Error("执行工作区身份尚未确认");
  const thread = candidate;
  const worktree = record(thread?.worktree) ? thread.worktree : undefined;
  const executionId = thread?.executionProjectId ?? project.id;
  const workspacePath = executionId === project.id ? project.root : worktree?.directory;
  if (typeof executionId !== "string" || typeof workspacePath !== "string" || !workspacePath)
    throw Error("执行工作区身份尚未确认");
  return { workspacePath, workspaceIdentity: `${home}:${executionId}`, sessionId: threadId };
}
/** @param {string} home */
const createGenUiState = (home) => createGenUiStateStorage(join(home, "gen-ui-state"));
/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
module.exports = { genUiScope, createGenUiState };
