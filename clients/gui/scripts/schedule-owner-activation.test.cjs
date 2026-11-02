"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { randomUUID } = require("node:crypto");
const { GuiHostProjects } = require("../app/src/core/gui-host-projects.cjs");
const { HostClient } = require("../app/src/core/host-client.cjs");
const { LifecycleOperations } = require("../app/src/core/lifecycle-operations.cjs");
const { CoreBackend } = require("../app/src/core/backend.cjs");
const { ProjectConnections } = require("../app/src/core/project-connections.cjs");

const owner = () => {
  const host = new GuiHostProjects({
    binary: "/unused",
    home: "/fixture/host",
    source: {
      profile: "/fixture/profile",
      coreHome: "/fixture/core",
      legacyServiceHome: "/fixture/legacy",
    },
    singletonHeld: true,
  });
  host.bindings.set("owner", { projectId: "host-owner" });
  return host;
};
const status = (suppressed, error) => ({
  projects: [
    {
      registration: { projectId: "host-owner" },
      scheduleActivationSuppressed: suppressed,
      ...(error ? { scheduleActivationError: error } : {}),
    },
  ],
});

test("Host scheduling errors and suppression refresh without activating an owner", async () => {
  const host = owner();
  let observed = status(true, "catalogRequiresCore");
  host.client.status = async () => observed;
  host.client.ensureProject = () => assert.fail("schedule projection must not activate a Core");
  assert.equal(await host.refreshScheduling(), true);
  assert.deepEqual(host.scheduling("owner"), {
    suppressed: true,
    activationError: "catalogRequiresCore",
  });
  assert.equal(await host.refreshScheduling(), false);
  observed = status(false);
  assert.equal(await host.refreshScheduling(), true);
  assert.deepEqual(host.scheduling("owner"), { suppressed: false, activationError: null });
});

test("historical Desktop receipts do not override the Host scheduling projection", () => {
  const host = owner();
  const lifecycle = new LifecycleOperations({ home: "/fixture/core", host });
  lifecycle.records.set("legacy", {
    targets: [{ projectId: "owner", scheduleActivationSuppressed: true }],
  });
  host.rememberStatus(status(false));
  assert.equal(lifecycle.schedulingSuppressed("owner"), false);
  host.rememberStatus(status(true));
  assert.equal(lifecycle.schedulingSuppressed("owner"), true);
});

test("explicit resume reaches Host ensure for an already connected owner", async () => {
  const project = { id: "owner", client: { ready: true } };
  const descriptor = { endpoint: "ws://fixture", generation: "current" };
  const requests = [];
  const backend = {
    home: "/fixture/core",
    projects: new Map([[project.id, project]]),
    starting: new Map(),
    worktrees: { assertAvailable() {} },
    providers: { manages: () => false },
    host: {
      ensure: async (...args) => {
        requests.push(args);
        return { descriptor, token: "fixture" };
      },
    },
    loadProjectJournal: async () => project,
    launch: (...args) => CoreBackend.prototype.launch.call(backend, ...args),
    startProject: (...args) => CoreBackend.prototype.startProject.call(backend, ...args),
    start: (...args) => CoreBackend.prototype.start.call(backend, ...args),
  };
  backend.host.scheduling = () => ({ suppressed: true, activationError: null });
  backend.connections = new ProjectConnections(backend);
  const lifecycle = new LifecycleOperations(backend);
  backend.lifecycleOperations = lifecycle;
  await assert.rejects(backend.start(project.id), { code: "CORE_STOPPED" });
  await lifecycle.resumeScheduling(project.id);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].slice(1), [project.id, undefined, undefined, true]);
  assert.equal(project.service, descriptor);
});

test("ordinary ensure omits resume intent and explicit ensure forwards it", async () => {
  const client = new HostClient();
  client.generation = randomUUID();
  client.capabilities = ["scheduledActivation"];
  const requests = [];
  client.request = async (method, params) => requests.push({ method, params });
  await client.ensureProject(randomUUID(), "owner", undefined);
  await client.ensureProject(randomUUID(), "owner", undefined, undefined, true);
  assert.equal(requests[0].method, "project.ensure");
  assert.equal(Object.hasOwn(requests[0].params, "resumeScheduling"), false);
  assert.equal(requests[1].params.resumeScheduling, true);
});

test("maintenance stops preserve scheduling intent and explicit project stop suppresses activation", async () => {
  for (const kind of ["stopProject", "updateProject", "stopDesktop", "updateDesktop"]) {
    const host = owner();
    host.client.capabilities = ["stopOperations"];
    const target = {
      projectId: "owner",
      serviceId: "original-service",
      generation: "original-generation",
      requestId: randomUUID(),
      phase: "notAttempted",
    };
    const calls = [];
    host.client.request = async (method, params) => {
      if (method === "host.status") return status(true);
      assert.equal(method, "project.stop");
      calls.push(params);
      return {
        version: 1,
        requestId: params.requestId,
        projectId: params.projectId,
        serviceId: target.serviceId,
        serviceGeneration: params.serviceGeneration,
        strategy: params.strategy,
        state: "completed",
      };
    };
    const project = {
      id: target.projectId,
      service: { serviceId: target.serviceId, generation: target.generation },
      model: { connection() {} },
    };
    const backend = {
      home: "/fixture/core",
      host,
      projects: new Map([[project.id, project]]),
      providers: { redact: (text) => text },
    };
    const lifecycle = new LifecycleOperations(backend);
    lifecycle.store = async () => {};
    await lifecycle.stopTarget({ version: 1, kind, mode: "ifIdle" }, target);
    assert.equal(target.phase, "completed", kind);
    assert.equal(calls.length, 1, kind);
    assert.equal(calls[0].suppressScheduling, kind === "stopProject" ? undefined : false, kind);
    assert.equal(host.scheduling(project.id).suppressed, true, kind);
  }
});
