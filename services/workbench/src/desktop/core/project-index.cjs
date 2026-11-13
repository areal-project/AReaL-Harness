// @ts-check
"use strict";

/** @typedef {{id:string,root:string,logicalProjectId?:string,worktreeRequestId?:string,worktreeResources?:string,projectless?:boolean,projectlessRequestId?:string}} SavedProject */

/** @param {unknown} value @returns {SavedProject[]} */
function parseProjectIndex(value) {
  if (!Array.isArray(value) || !value.every(isSavedProject))
    throw new Error("Invalid project index");
  return value;
}

/** @param {unknown} value @returns {value is SavedProject} */
function isSavedProject(value) {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "id" in value &&
    typeof value.id === "string" &&
    "root" in value &&
    typeof value.root === "string" &&
    (!("logicalProjectId" in value) ||
      value.logicalProjectId === undefined ||
      typeof value.logicalProjectId === "string") &&
    (!("worktreeRequestId" in value) ||
      value.worktreeRequestId === undefined ||
      typeof value.worktreeRequestId === "string") &&
    (!("worktreeResources" in value) ||
      value.worktreeResources === undefined ||
      typeof value.worktreeResources === "string") &&
    (!("projectless" in value) ||
      value.projectless === undefined ||
      typeof value.projectless === "boolean") &&
    (!("projectlessRequestId" in value) ||
      value.projectlessRequestId === undefined ||
      typeof value.projectlessRequestId === "string")
  );
}

module.exports = { parseProjectIndex };
