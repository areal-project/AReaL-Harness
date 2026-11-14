"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { rm } = require("node:fs/promises");
const { join } = require("node:path");
const { makeTempDir } = require("./support/temp.mjs");
const { CoreBackend } = require("@areal/workbench-service/desktop/core/backend.cjs");
const { snapshotProject } = require("@areal/workbench-service/desktop/core/project-snapshot.cjs");
const { catalog } = require("@areal/workbench-service/desktop/core/provider-model-catalog.cjs");

test("launch keeps named environment credentials outside persistent launch inputs", async (t) => {
  const home = await makeTempDir("areal-host-credentials-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const project = { id: "project", root: join(home, "workspace") };
  const binding = {
    workspace: project.root,
    dataDir: join(home, "original-store"),
    scratchDir: join(home, project.id, "scratch"),
  };
  const backend = {
    home,
    host: { resolve: () => binding },
    configHome: home,
    config: join(home, "config.toml"),
    userHome: home,
    resources: { deployment: async () => ({}) },
    providers: {
      prepare: async () => {},
      config: { current: async () => ({}) },
      snapshot: () => ({ data: [{ apiKeyEnv: "FIXTURE_API_KEY" }] }),
      environment: () => ({ AREAL_CREDENTIAL_areal_openai: "dummy-transport-token" }),
    },
    hooks: {
      launch: async () => ({ value: {}, revision: "fixture" }),
      environment: () => ({ PATH: process.env.PATH, FIXTURE_API_KEY: "dummy-api-key" }),
    },
  };
  const launch = await CoreBackend.prototype.prepareServiceLaunch.call(backend, project, {
    advance() {},
  });
  assert.deepEqual(launch.launchInputs.credentialNames, [
    "AREAL_CREDENTIAL_areal_openai",
    "FIXTURE_API_KEY",
  ]);
  assert.deepEqual(launch.credentials, { FIXTURE_API_KEY: "dummy-api-key" });
  assert.equal(JSON.stringify(launch.launchInputs).includes("dummy-api-key"), false);
  assert.equal(JSON.stringify(launch.launchInputs).includes("dummy-transport-token"), false);
  assert.equal(launch.launchInputs.options.data_dir, binding.dataDir);
});

test("foreign CLI launch and thread creation retain Core configuration ownership", async () => {
  const project = { id: "cli", root: "/fixture/workspace", pending: [] };
  const descriptor = { endpoint: "ws://fixture", generation: "original-generation" };
  let ensured;
  let submitted;
  const backend = {
    providers: { manages: () => false },
    prepareServiceLaunch: () => assert.fail("foreign Core must not prepare GUI resources"),
    host: {
      ensure: async (...args) => {
        ensured = args;
        return { descriptor, token: "fixture" };
      },
    },
    resources: { beforeCreate: async () => {} },
    assertThreadCreationAvailable() {},
    prepareThreadInProject: CoreBackend.prototype.prepareThreadInProject,
    desktopTools: () => [],
    library: { value: { settings: {} } },
    defaultProfile: { id: "gui-only-profile", revision: "gui-revision" },
    submit: async (_project, method, params) => {
      submitted = { method, params };
      return { thread: { id: "created-thread" } };
    },
    refreshAfterAdmission: async () => {},
  };
  await CoreBackend.prototype.launch.call(backend, project);
  assert.deepEqual(ensured.slice(1), ["cli", undefined, undefined, false]);
  assert.equal(project.service, descriptor);
  assert.equal(
    (await CoreBackend.prototype.createThreadInProject.call(backend, project, {})).threadId,
    "created-thread",
  );
  assert.equal(submitted.method, "areal/thread/start");
  assert.equal(submitted.params.agentProfile, undefined);
  const explicit = { id: "cli-profile", revision: "cli-revision" };
  await CoreBackend.prototype.createThreadInProject.call(backend, project, { profile: explicit });
  assert.deepEqual(submitted.params.agentProfile, explicit);
});

test("Host discovery schedules only ready foreign projects for passive observation", async (t) => {
  const sourceId = "gui-source";
  const entries = [
    { id: "cli", state: "ready" },
    { id: "gui", state: "ready", sourceId },
    { id: "stopped", state: "stopped" },
    { id: "stopping", state: "stopping" },
    { id: "unavailable", state: "unavailable" },
    { id: "pending", state: "pending" },
    { id: "without-service", state: "ready", noService: true },
    { id: "user-stopped", state: "ready" },
  ];
  const loaded = [];
  const projects = new Map();
  const backend = Object.assign(Object.create(CoreBackend.prototype), {
    closing: false,
    starting: new Map(),
    projects,
    host: {
      sourceId,
      rememberStatus() {},
      list: async () => entries.map(({ id }) => ({ id, root: `/fixture/${id}` })),
      resolve: (id) => ({
        projectId: id,
        sourceId: entries.find((entry) => entry.id === id).sourceId,
      }),
      client: {
        status: async () => ({
          projects: entries.map(({ id, state, noService }) => ({
            registration: { projectId: id },
            state,
            ...(noService ? {} : { service: { generation: "original" } }),
          })),
        }),
      },
      ensure: () => assert.fail("discovery must not start a Core"),
    },
    lifecycleOperations: { schedulingSuppressed: (id) => id === "user-stopped" },
    loadProjectJournal: async (id) => {
      loaded.push(id);
      // 本来源已连上的项目不需要再排重连；没连上的和外来项目一样被动观察。
      const project = id === "gui" ? { id, client: { ready: true } } : { id };
      projects.set(id, project);
      return project;
    },
  });
  t.after(() => {
    for (const project of projects.values()) clearTimeout(project.reconnectTimer);
  });
  await backend.refreshHostProjects();
  assert.deepEqual(loaded, ["cli", "gui", "user-stopped"]);
  assert.equal(projects.get("cli").reconnectTimer, undefined);
  loaded.length = 0;
  await backend.refreshHostProjects({ observeForeign: true });
  assert.deepEqual(loaded, ["cli", "gui", "user-stopped"]);
  assert.ok(projects.get("cli").reconnectTimer);
  assert.equal(projects.get("gui").reconnectTimer, undefined);
  assert.equal(projects.get("user-stopped").reconnectTimer, undefined);
});

test("rediscovering the same Core generation preserves an in-flight observer identity", async (t) => {
  const previous = {
    generation: "original",
    serviceId: "cli-core",
    configFingerprint: "cli-config",
  };
  const project = { id: "cli", service: previous, client: null };
  let descriptor = { ...previous, endpoint: "ws://fixture" };
  let finishObservation;
  const observation = new Promise((resolve) => {
    finishObservation = resolve;
  });
  const connections = [];
  const backend = Object.assign(Object.create(CoreBackend.prototype), {
    closing: false,
    starting: new Map(),
    projects: new Map([[project.id, project]]),
    host: {
      sourceId: "gui-source",
      rememberStatus() {},
      list: async () => [{ id: project.id, root: "/fixture/cli" }],
      resolve: () => ({ projectId: project.id }),
      client: {
        status: async () => ({
          projects: [
            { registration: { projectId: project.id }, state: "ready", service: descriptor },
          ],
        }),
      },
      observe: () => observation,
    },
    lifecycleOperations: { assertProject() {}, schedulingSuppressed: () => false },
    loadProjectJournal: async () => project,
    reconcile: async () => {},
  });
  backend.connections.connect = async (owner, options) => connections.push({ owner, options });
  t.after(() => clearTimeout(project.reconnectTimer));
  const reconnecting = backend.reconnectProject(project);
  await backend.refreshHostProjects();
  assert.equal(project.service, previous);
  finishObservation({ descriptor, token: "fixture" });
  assert.equal(await reconnecting, project);
  assert.deepEqual(connections, [{ owner: project, options: { observeOnly: true } }]);
  assert.equal(project.endpoint, descriptor.endpoint);

  let closed = 0;
  project.client = { close: () => closed++ };
  descriptor = { ...descriptor, generation: "replacement" };
  await backend.refreshHostProjects();
  assert.equal(closed, 1);
  assert.equal(project.client, null);
  assert.equal(project.service, descriptor);
});

test("foreign project snapshot exposes only Core profiles and models", () => {
  const project = {
    id: "cli",
    root: "/fixture/workspace",
    model: { getSnapshot: () => null },
    models: [
      {
        providerId: "cli-provider",
        modelId: "fixture",
        displayName: "CLI fixture",
        providerRevision: "cli-revision",
      },
    ],
    profiles: [{ id: "cli-profile", revision: "cli-revision" }],
  };
  const providers = {
    manages: () => false,
    config: { value: { data: [] } },
    catalogs: new WeakMap(),
    subscription: {
      authenticated: true,
      availability: "ready",
      models: [{ id: "gui-only-chatgpt" }],
    },
    model: () => undefined,
  };
  providers.catalog = (models, owner) => catalog(providers, models, owner);
  const backend = {
    binary: "/fixture/areal",
    projects: new Map([[project.id, project]]),
    providers,
    ownerTasks: { revision: () => 0 },
    host: {
      scheduling: () => ({ suppressed: false, activationError: null }),
      migrationError: () => undefined,
    },
    cloudConversations: {
      mergeSnapshot: (_id, state) => state,
      projection: () => ({ summaries: [] }),
    },
    awaitingResponses: new Set(),
    defaultProfile: { id: "gui-profile", revision: "gui-revision" },
  };
  const view = snapshotProject(backend, { id: project.id, root: project.root }, new Set());
  assert.equal(view.defaultProfile, null);
  assert.deepEqual(view.models, project.models);
  assert.deepEqual(view.profiles, project.profiles);
});

test("managed binary upgrade settles the original service before retrying launch", async () => {
  const events = [];
  const old = { serviceId: "service", generation: "old" };
  const fresh = { serviceId: "service", generation: "new", endpoint: "fixture" };
  let attempts = 0;
  const backend = Object.assign(Object.create(CoreBackend.prototype), {
    providers: { manages: () => true },
    prepareServiceLaunch: async () => ({
      launchInputs: {},
      credentials: {},
      hookDeployment: { revision: "hooks" },
    }),
    hooks: { current: async () => ({ revision: "hooks" }) },
    host: {
      ensure: async () => {
        events.push("ensure");
        if (++attempts === 1)
          throw Object.assign(new Error("version mismatch"), {
            code: "CORE_BINARY_UPDATE_REQUIRED",
          });
        return { descriptor: fresh, token: "fixture" };
      },
      observe: async () => {
        events.push("observe");
        return { descriptor: old };
      },
    },
    lifecycleOperations: {
      generation: "desktop",
      assertProject() {},
      request: async (request) => {
        events.push("update");
        assert.equal(request.mode, "ifIdle");
        assert.deepEqual(request.expectedTargets, [{ projectId: "gui", ...old }]);
        return { phase: "completed" };
      },
    },
  });
  const project = { id: "gui" };
  await backend.launch(project);
  assert.deepEqual(events, ["ensure", "observe", "update", "ensure"]);
  assert.equal(project.service, fresh);
});

test("binary recovery never bypasses an unsettled update or unrelated conflict", async () => {
  for (const scenario of ["busy", "unknown", "configuration", "foreign"]) {
    let attempts = 0;
    let updates = 0;
    const failure = Object.assign(
      new Error(
        `service configuration conflict (${scenario === "configuration" ? "binaries, permissions" : "binaries"}) for instance service`,
      ),
      {
        submissionUnknown: scenario === "unknown",
        code: ["busy", "foreign"].includes(scenario)
          ? "CORE_BINARY_UPDATE_REQUIRED"
          : "internalError",
      },
    );
    const backend = Object.assign(Object.create(CoreBackend.prototype), {
      providers: { manages: () => scenario !== "foreign" },
      prepareServiceLaunch: async () => ({ launchInputs: {} }),
      host: {
        ensure: async () => {
          attempts++;
          throw failure;
        },
        observe: async () => ({ descriptor: { serviceId: "service", generation: "old" } }),
      },
      lifecycleOperations: {
        generation: "desktop",
        assertProject() {},
        request: async () => {
          updates++;
          return { phase: "blocked", requestId: "original" };
        },
      },
    });
    await assert.rejects(
      backend.launch({ id: "gui" }),
      scenario === "busy"
        ? { code: "LIFECYCLE_INCOMPLETE", requestId: "original" }
        : (error) => error === failure,
    );
    assert.equal(attempts, 1);
    assert.equal(updates, scenario === "busy" ? 1 : 0);
  }
});

test("a definitively busy old service stays readable while its upgrade waits", async () => {
  const old = { serviceId: "service", generation: "old", endpoint: "fixture" };
  let attempts = 0;
  const backend = Object.assign(Object.create(CoreBackend.prototype), {
    providers: { manages: () => true },
    prepareServiceLaunch: async () => ({ launchInputs: {}, hookDeployment: { revision: "hooks" } }),
    hooks: { current: async () => ({ revision: "hooks" }) },
    host: {
      ensure: async () => {
        attempts++;
        throw Object.assign(new Error("version mismatch"), { code: "CORE_BINARY_UPDATE_REQUIRED" });
      },
      observe: async () => ({ descriptor: old, token: "fixture" }),
    },
    lifecycleOperations: {
      generation: "desktop",
      assertProject() {},
      request: async () => ({ phase: "blocked", targets: [{ phase: "blocked" }] }),
    },
  });
  const project = { id: "gui" };
  await backend.launch(project);
  assert.equal(attempts, 1);
  assert.equal(project.service, old);
  assert.equal(project.binaryUpdatePending, true);
});

test("the existing reconnect scheduler completes a deferred upgrade while the old observer is ready", async (t) => {
  const {
    ProjectConnections,
  } = require("@areal/workbench-service/desktop/core/project-connections.cjs");
  let run;
  t.mock.method(globalThis, "setTimeout", (callback) => {
    run = callback;
    return { unref() {} };
  });
  let complete;
  const finished = new Promise((resolve) => {
    complete = resolve;
  });
  const project = {
    id: "gui",
    service: { generation: "old" },
    client: { ready: true },
    binaryUpdatePending: true,
  };
  const host = {
    lifecycleOperations: { schedulingSuppressed: () => false },
    projects: new Map([[project.id, project]]),
    starting: new Map(),
    startProject: async (id) => {
      assert.equal(id, project.id);
      project.binaryUpdatePending = false;
      complete();
      return project;
    },
  };
  const connections = new ProjectConnections(host);
  connections.reconnectProject = () =>
    assert.fail("a deferred upgrade must use the controlled launch path");
  connections.scheduleReconnect(project);
  assert.equal(typeof run, "function");
  run();
  await finished;
  await host.starting.get(project.id);
  assert.equal(project.binaryUpdatePending, false);
  assert.equal(host.starting.size, 0);
  assert.equal(project.reconnectTimer, null);
});

test("binary upgrade classification requires the original Host rejection receipt", async () => {
  const {
    GuiHostProjects,
  } = require("@areal/workbench-service/desktop/core/gui-host-projects.cjs");
  const failure = new Error("service configuration conflict (binaries) for instance service");
  const original = {
    state: "blocked",
    method: "project.ensure",
    requestId: "request",
    projectId: "canonical",
    hostId: "host",
    generation: "generation",
    error: { message: failure.message },
  };
  for (const override of [
    null,
    {},
    { state: "admissionUnknown" },
    { hostId: "other" },
    { generation: "other" },
    { projectId: "other" },
    { requestId: "other" },
    { method: "project.stop" },
  ]) {
    const host = {
      sourceId: "source",
      migrationError: () => null,
      resolve: () => ({ projectId: "canonical", sourceId: "source" }),
      client: {
        hostId: "host",
        generation: "generation",
        ensureProject: async () => {
          throw failure;
        },
      },
      operation: async () => (override === null ? null : { ...original, ...override }),
    };
    await assert.rejects(
      GuiHostProjects.prototype.ensure.call(host, "request", "alias", {}),
      override && Object.keys(override).length === 0
        ? { code: "CORE_BINARY_UPDATE_REQUIRED", requestId: "request" }
        : (error) => error === failure,
    );
  }
});
