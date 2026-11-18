"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { ModelConfiguration } = require("../src/desktop/core/model-config.cjs");
const { catalog } = require("../src/desktop/core/provider-model-catalog.cjs");

test("execution snapshots reuse Host credential reads without exposing them in public state", async () => {
  const reference = "AREAL_CREDENTIAL_saved";
  const snapshot = {
    path: "/fixture/config.toml",
    revision: "fixture",
    data: [],
    defaultModel: null,
    credentialStates: {},
    credentialSources: {},
    effective: {},
  };
  const config = new ModelConfiguration(
    {
      projects: new Map(),
      host: {
        sourceId: "source",
        client: {
          sourceState: async () => ({
            sourceId: "source",
            credentials: { references: [reference] },
          }),
        },
      },
      hostCall: async () => ({
        snapshot,
        credentials: {
          references: [reference],
          values: { [reference]: "synthetic-secret" },
          errors: {},
        },
      }),
    },
    { read: () => assert.fail("Host already read the credential") },
  );
  assert.deepEqual(await config.current(), snapshot);
  assert.equal(config.key({ apiKeyEnv: reference }), "synthetic-secret");
  assert.equal(JSON.stringify(config.public()).includes("synthetic-secret"), false);
});

test("initialization and catalog stay available before execution credentials can be read", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "areal-model-init-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const reference = "AREAL_CREDENTIAL_saved";
  const source = {
    sourceId: "source",
    credentials: { references: [reference], migratedConfigPaths: [] },
  };
  const snapshot = {
    path: join(home, "config.toml"),
    revision: "fixture",
    data: [],
    defaultModel: null,
    credentialStates: {},
    credentialSources: {},
    effective: {},
  };
  let vaultAvailable = false;
  const config = new ModelConfiguration(
    {
      home,
      host: {
        sourceId: source.sourceId,
        state: source,
        client: { sourceState: async () => source },
      },
      hostCall: async (_method, request) => {
        if (request.operation === "modelsCatalog") return structuredClone(snapshot);
        if (!vaultAvailable) throw new Error("credential service unavailable");
        return {
          snapshot: structuredClone(snapshot),
          credentials: {
            references: [reference],
            values: { [reference]: "synthetic-secret" },
            errors: {},
          },
        };
      },
      providers: { redact: (text) => text },
    },
    {
      read: async () => {
        if (!vaultAvailable) throw new Error("credential service unavailable");
        return { value: "synthetic-secret" };
      },
    },
  );

  await config.init();
  assert.equal(config.references.has(reference), true);
  assert.deepEqual(await config.catalog(), { ...snapshot, refreshing: true });
  assert.equal(config.value, undefined);
  await assert.rejects(config.current(), /credential service unavailable/);
  assert.equal(config.value, undefined);

  vaultAvailable = true;
  assert.deepEqual(await config.current(), snapshot);
  assert.equal(config.key({ apiKeyEnv: reference }), "synthetic-secret");
});

test("missing saved entry remains distinct from an unconfigured key and can be recovered", async () => {
  const reference = "AREAL_CREDENTIAL_saved";
  let missing = true;
  const config = new ModelConfiguration(
    { host: { sourceId: "source" }, projects: new Map() },
    {
      read: async () => {
        if (missing) throw Object.assign(new Error("entry missing"), { code: "storageMissing" });
        return { value: "synthetic-restored" };
      },
    },
  );
  config.value = {
    data: [
      {
        id: "saved",
        apiKeyEnv: reference,
        endpoint: "https://example.invalid/v1/responses",
        protocol: "responses",
      },
    ],
  };
  await config.refreshCredentials([reference]);
  assert.deepEqual(config.public().credentialErrors, { saved: "storageMissing" });
  assert.equal(config.references.has(reference), true);
  assert.equal(config.key(config.value.data[0]), "");
  missing = false;
  await config.refreshCredentials([reference]);
  assert.deepEqual(config.public().credentialErrors, {});
  assert.equal(config.key(config.value.data[0]), "synthetic-restored");
});

test("locked orphan does not appear in current providers, active lock appears in catalog", async () => {
  const names = ["AREAL_CREDENTIAL_old", "AREAL_CREDENTIAL_active"];
  const state = { sourceId: "source", credentials: { references: names } };
  const backend = {
    host: { sourceId: "source", state },
    projects: new Map(),
    providers: { manages: () => true },
  };
  const config = new ModelConfiguration(backend, {
    read: async () => {
      throw Object.assign(new Error(), { code: "storageLocked" });
    },
  });
  await config.refreshCredentials(names);
  config.value = {
    data: [
      {
        id: "active",
        apiKeyEnv: names[1],
        endpoint: "https://example.invalid",
        protocol: "responses",
      },
    ],
  };
  assert.deepEqual(config.public().credentialErrors, { active: "storageLocked" });
  const providers = {
    config,
    manages: () => true,
    catalogs: new WeakMap(),
    subscription: { models: [], authenticated: false },
    model: () => null,
  };
  const models = catalog(providers, [{ providerId: "active", modelId: "m", available: false }], {});
  assert.equal(models[0].unavailableReason, "storageLocked");
  await config.refreshCredentials([]);
  assert.deepEqual(config.public().credentialErrors, {});
});

test("explicit API key reveal retries a locked credential interactively", async () => {
  const calls = [];
  const backend = {
    host: {
      sourceId: "source",
      state: { credentials: { references: ["AREAL_CREDENTIAL_active"] } },
    },
  };
  const config = new ModelConfiguration(backend, {
    read: async (slot, options) => {
      calls.push({ slot, options });
      if (options.interactionAllowed === false)
        throw Object.assign(new Error(), { code: "storageLocked" });
      return { value: "interactive-secret" };
    },
  });
  await config.refreshCredentials(["AREAL_CREDENTIAL_active"]);
  config.value = {
    data: [{ id: "active", apiKeyEnv: "AREAL_CREDENTIAL_active" }],
  };

  assert.equal(await config.reveal(config.value.data[0]), "interactive-secret");
  assert.equal(config.vault.locked.has("AREAL_CREDENTIAL_active"), false);
  assert.deepEqual(calls.at(-1).options, { interactionAllowed: true });
});

test("projectless catalog exposes the active locked provider", async () => {
  const { ProjectlessWorkspaces } = require("../src/desktop/core/projectless.cjs");
  const reference = "AREAL_CREDENTIAL_active";
  const providers = {
    config: {
      vault: { locked: new Set([reference]) },
      current: async () => ({
        effective: { model: {} },
        credentialStates: { active: "unavailable" },
        data: [
          {
            id: "active",
            name: "Active",
            enabled: true,
            apiKeyEnv: reference,
            endpoint: "https://example.invalid/v1",
            parameters: {},
            models: [{ id: "m", enabled: true, parameters: {} }],
          },
        ],
      }),
    },
  };
  const result = await new ProjectlessWorkspaces({ providers }).command({ operation: "catalog" });
  assert.equal(result.models[0].unavailableReason, "storageLocked");
});

test("catalog uses fresh configuration without waiting for credential reads or replacing the execution snapshot", async () => {
  const snapshot = {
    path: "/fixture/config.toml",
    revision: "new",
    data: [],
    defaultModel: null,
    credentialStates: { active: "checking" },
    credentialSources: { active: "stored" },
    effective: {},
  };
  const config = new ModelConfiguration(
    {
      hostCall: async (method, request) => {
        assert.equal(method, "workbench.utility");
        assert.deepEqual(request, { operation: "modelsCatalog" });
        return structuredClone(snapshot);
      },
    },
    {
      read: () => {
        throw new Error("catalog must not open the vault");
      },
    },
  );
  const prior = { ...snapshot, revision: "old", credentialStates: { active: "available" } };
  config.value = prior;
  assert.equal((await config.catalog()).credentialStates.active, "checking");
  assert.equal(config.value, prior);
  config.value = { ...prior, revision: "new" };
  assert.equal((await config.catalog()).credentialStates.active, "available");
});
