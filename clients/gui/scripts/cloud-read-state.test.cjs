"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { CoreBackend } = require("@areal/workbench-service/desktop/core/backend.cjs");
const {
  CloudConversations,
} = require("@areal/workbench-service/desktop/core/cloud-conversations.cjs");
test("Cloud bridge bypasses local worktree routing while retaining conversation ownership", async () => {
  const { CoreWorktrees } = require("@areal/workbench-service/desktop/core/worktrees.cjs");
  const calls = [];
  const backend = {
    saved: [
      { id: "project", root: "/fixture-project" },
      { id: "wt", root: "/fixture-worktree", logicalProjectId: "project" },
    ],
    projects: new Map(),
    library: { value: { projects: {} } },
    lifecycleOperations: {
      blocking: () => null,
      activeTargets: new Map(),
      assertProject: () => {},
    },
    cloudConversations: {
      owns: (pid, tid) => pid === "project" && tid === "cloud-thread",
      command: async (request) => {
        calls.push(request.operation);
        return {};
      },
      media: async (request) => {
        calls.push(request.operation);
        return {};
      },
    },
  };
  backend.cloudConversations.backend = backend;
  backend.cloudConversations.routes = CloudConversations.prototype.routes;
  backend.cloudConversations.route = CloudConversations.prototype.route;
  backend.worktrees = new CoreWorktrees(backend);
  await assert.rejects(
    backend.worktrees.resolveRequest("open", { projectId: "project", threadId: "cloud-thread" }),
    (error) => error.code === "WORKTREE_BINDING_UNAVAILABLE",
  );
  await CoreBackend.prototype.command.call(backend, "open", {
    projectId: "project",
    threadId: "cloud-thread",
  });
  for (const operation of ["reconnect", "send"])
    await CoreBackend.prototype.command.call(backend, "cloudSession", {
      projectId: "project",
      threadId: "cloud-thread",
      operation,
      ...(operation === "send" ? { text: "hello" } : {}),
    });
  await CoreBackend.prototype.command.call(backend, "media", {
    projectId: "project",
    threadId: "cloud-thread",
    operation: "list",
  });
  assert.deepEqual(calls, ["open", "reconnect", "send", "list"]);
  await assert.rejects(
    CoreBackend.prototype.command.call(backend, "open", {
      projectId: "project",
      threadId: "unknown",
    }),
    (error) => error.code === "WORKTREE_BINDING_UNAVAILABLE",
  );
  assert.equal(calls.length, 4);
});
