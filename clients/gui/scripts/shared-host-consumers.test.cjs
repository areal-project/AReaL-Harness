"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdir, readFile, writeFile, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const { makeTempDir } = require("./support/temp.mjs");
const { CoreBackend } = require("../app/src/core/backend.cjs");
const { snapshotProject } = require("../app/src/core/project-snapshot.cjs");
const { catalog } = require("../app/src/core/provider-model-catalog.cjs");
const { LifecycleOperations } = require("../app/src/core/lifecycle-operations.cjs");

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
  assert.deepEqual(ensured.slice(1), ["cli", undefined, undefined]);
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
    lifecycleOperations: { schedulingSuppressed: () => false },
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

test("legacy stop recovery queries the original registry and request identity", async (t) => {
  const root = await makeTempDir("areal-host-legacy-stop-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "core");
  const legacy = join(root, "legacy");
  await mkdir(join(home, "lifecycle-operations"), { recursive: true });
  await mkdir(legacy);
  const target = {
    projectId: "aaaaaaaaaaaaaaaaaaaaaaaa",
    serviceId: "old-service",
    generation: "old-generation",
    requestId: randomUUID(),
    phase: "admissionUnconfirmed",
  };
  const record = {
    version: 1,
    requestId: randomUUID(),
    kind: "stopProject",
    mode: "ifIdle",
    desktopGeneration: randomUUID(),
    harnessHome: legacy,
    targets: [target],
    phase: "admissionUnconfirmed",
    desktopExit: "notRequested",
  };
  await writeFile(
    join(home, "lifecycle-operations", `${record.requestId}.json`),
    JSON.stringify(record),
  );
  const receipt = {
    version: 1,
    requestId: target.requestId,
    serviceId: target.serviceId,
    generation: target.generation,
    cancel: false,
    state: "completed",
  };
  const calls = join(root, "calls.jsonl");
  const binary = join(root, "areal-fixture");
  await writeFile(
    binary,
    `#!${process.execPath}\nconst fs = require("node:fs");\nfs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv: process.argv.slice(2), registry: process.env.AREAL_HARNESS_SERVICE_HOME }) + "\\n");\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ operation: receipt }))});\n`,
    { mode: 0o700 },
  );
  const backend = {
    home,
    binary,
    harnessHome: join(root, "new-registry"),
    projects: new Map(),
    providers: { redact: (value) => value },
    hooks: { environment: () => ({ PATH: process.env.PATH }) },
    host: { operation: async () => assert.fail("old receipt must not query shared Host") },
  };
  const lifecycle = new LifecycleOperations(backend);
  await lifecycle.reconcileLoaded();
  assert.equal((await lifecycle.read(record.requestId)).phase, "completed");
  const call = JSON.parse((await readFile(calls, "utf8")).trim());
  assert.equal(call.registry, legacy);
  assert.ok(call.argv.includes(target.requestId));
});
