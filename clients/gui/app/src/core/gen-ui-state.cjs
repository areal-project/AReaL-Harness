"use strict";
const { join } = require("node:path");
const { createGenUiStateStorage } = require("@areal/gen-ui/node");
function genUiScope(home, project, threadId) {
    const thread = project.state?.threads?.[threadId];
    const executionId = thread?.executionProjectId ?? project.id;
    const workspacePath = executionId === project.id ? project.root : thread.worktree?.directory;
    if (!workspacePath) throw Error("执行工作区身份尚未确认");
    return { workspacePath, workspaceIdentity: `${home}:${executionId}`, sessionId: threadId };
}
const createGenUiState = (home) => createGenUiStateStorage(join(home, "gen-ui-state"));
module.exports = { genUiScope, createGenUiState };
