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
