"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { randomUUID } = require("node:crypto");
const { createRequire } = require("node:module");
const requireApp = createRequire(join(__dirname, "../app/package.json"));
const { CoreBackend } = requireApp("@areal/workbench-service/desktop/core/backend.cjs");

test("native Worktree binds the Host-prepared Core without recalculating its deployment", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "areal-prepared-worktree-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const { CoreWorktrees } = requireApp("@areal/workbench-service/desktop/core/worktrees.cjs");
  const requestId = randomUUID();
  const source = { id: "logical", root: "/isolated/source" };
  const execution = { id: "execution", root: "/isolated/worktree", logicalProjectId: source.id };
  const service = {
    serviceId: "prepared-instance",
    generation: "prepared-generation",
    configFingerprint: "prepared-deployment",
  };
  let bindState;
  let bindThread = true;
  let bindRequestId = requestId;
  let bindError;
  let opened = 0;
  const backend = {
    home,
    rustDomains: ["worktree-rust"],
    saved: [source],
    projects: new Map(),
    host: {
      sourceId: "source",
      list: async () => [source, execution],
      client: {
        status: async () => ({
          projects: [{ registration: { projectId: "canonical" }, state: "ready", service }],
        }),
      },
      rememberStatus() {},
      resolve: () => ({ projectId: "canonical", sourceId: "source" }),
    },
    loadProjectJournal: async () => execution,
    refreshHostProjects: CoreBackend.prototype.refreshHostProjects,
    start: async () => {
      throw new Error("service configuration conflict (configuration, deployment)");
    },
    connections: {
      reconnectProjectObserved: async (project) => {
        assert.equal(project.service, service);
        project.client = { ready: true };
        return project;
      },
    },
    prepareThreadInProject: async (project, _request, options) => {
      assert.equal(project.client.ready, true);
      assert.equal(project.resourceFingerprint, "external");
      assert.deepEqual(project.resourceProfile, { id: "fixture", revision: "v1" });
      assert.deepEqual(options, { preparedCore: true });
      return { current: () => true, params: { cwd: execution.root } };
    },
    openThread: async (_project, id) => {
      opened++;
      assert.equal(id, "thread");
    },
    hostCall: async (method, params) => {
      if (method === "worktree.thread.prepare")
        return {
          projectId: "canonical",
          alias: execution.id,
          root: execution.root,
          requestId,
          resourceFingerprint: "external",
          resourceProfile: { id: "fixture", revision: "v1" },
        };
      assert.equal(method, "worktree.thread.bind");
      assert.equal(params.requestId, requestId);
      assert.equal(params.executionProjectId, "canonical");
      assert.equal(params.coreInstanceId, service.serviceId);
      assert.equal(params.coreGeneration, service.generation);
      return {
        ...(bindThread ? { threadId: "thread" } : {}),
        requestId: bindRequestId,
        ...(bindState ? { state: bindState } : {}),
        ...(bindError ? { error: bindError } : {}),
      };
    },
  };
  const owner = new CoreWorktrees(backend);
  assert.deepEqual(await owner.createThread(source, { requestId }), {
    threadId: "thread",
    requestId,
  });
  for (const state of ["failed", "cancelled"]) {
    bindState = state;
    await assert.rejects(
      owner.createThread(source, { requestId }),
      (error) => error.requestId === requestId && error.submissionUnknown === false,
    );
    assert.equal(opened, 1, `${state} must not open the thread`);
  }
  bindState = "failed";
  bindThread = false;
  await assert.rejects(
    owner.createThread(source, { requestId }),
    (error) => error.requestId === requestId && error.submissionUnknown === false,
  );
  bindError = {
    code: -32602,
    message: "CREDENTIAL_UNAVAILABLE: configure credentials",
    data: { reason: "CREDENTIAL_UNAVAILABLE", outcome: { kind: "rejected" } },
  };
  await assert.rejects(
    owner.createThread(source, { requestId }),
    (error) =>
      error.message.startsWith("CREDENTIAL_UNAVAILABLE:") && error.submissionUnknown === false,
    "Core 的拒绝原文要带到界面，才能提示检查凭据",
  );
  bindError = undefined;
  bindRequestId = randomUUID();
  await assert.rejects(
    owner.createThread(source, { requestId }),
    (error) => error.submissionUnknown === true,
  );
  bindThread = true;
  bindRequestId = requestId;
  bindState = "unknown";
  await assert.rejects(
    owner.createThread(source, { requestId }),
    (error) => error.requestId === requestId && error.submissionUnknown === true,
  );
  assert.equal(opened, 1, "unknown must not open the thread");
  backend.host.resolve = () => ({ projectId: "foreign", sourceId: "source" });
  await assert.rejects(owner.createThread(source, { requestId }), /执行归属已变化/);
});
