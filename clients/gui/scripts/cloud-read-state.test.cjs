"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { CoreBackend } = require("../app/src/core/backend.cjs");
const { CloudConversations } = require("../app/src/core/cloud-conversations.cjs");
const { CoreLibrary } = require("../app/src/core/library.cjs");
test("Cloud read marks stay local and unknown threads remain rejected", async () => {
  const backend = {
    saved: [{ id: "project" }],
    projects: new Map(),
    lifecycleOperations: {
      blocking: () => null,
      activeTargets: new Map(),
      assertProject: () => {},
    },
    cloudConversations: { owns: (pid, tid) => pid === "project" && tid === "cloud-thread" },
    save: async () => {},
    onChange: () => {},
  };
  backend.cloudConversations.backend = backend;
  backend.cloudConversations.routes = CloudConversations.prototype.routes;
  backend.cloudConversations.route = CloudConversations.prototype.route;
  backend.library = new CoreLibrary(backend);
  await CoreBackend.prototype.command.call(backend, "library", {
    operation: "readThread",
    projectId: "project",
    threadId: "cloud-thread",
    read: false,
  });
  assert.equal(backend.library.value.threads["project:cloud-thread"].unread, true);
  await CoreBackend.prototype.command.call(backend, "library", {
    operation: "readThread",
    projectId: "project",
    threadId: "cloud-thread",
    read: true,
  });
  assert.equal(backend.library.value.threads["project:cloud-thread"].unread, false);
  await assert.rejects(
    backend.library.command({
      operation: "readThread",
      projectId: "project",
      threadId: "unknown",
      read: true,
    }),
    /未知会话/,
  );
  await assert.rejects(
    CoreBackend.prototype.command.call(backend, "manage", {
      operation: "goal",
      projectId: "project",
      threadId: "cloud-thread",
    }),
    /不支持 Cloud/,
  );
});

test("Cloud bridge bypasses local worktree routing while retaining conversation ownership", async () => {
  const { CoreWorktrees } = require("../app/src/core/worktrees.cjs");
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
