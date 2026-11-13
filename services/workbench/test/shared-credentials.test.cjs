"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ModelConfiguration } = require("../src/desktop/core/model-config.cjs");
const { catalog } = require("../src/desktop/core/provider-model-catalog.cjs");
const { configurePluginValues } = require("../src/desktop/core/plugin-configuration.cjs");

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
    host: { sourceId: "source", state: { credentials: { references: ["AREAL_CREDENTIAL_active"] } } },
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

test("clearing sensitive plugin configuration saves without restarting peers", async () => {
  const calls = [];
  const detail = {
    id: "p",
    name: "p",
    displayName: "p",
    description: "",
    source: "/source",
    sourceDigest: "d",
    revision: 1,
    components: [],
    skills: [],
    diagnostics: [],
    installed: true,
    enabled: true,
    installedDigest: "d",
    userConfiguration: {
      fields: {
        TOKEN: {
          definition: {
            type: "string",
            title: null,
            description: null,
            required: false,
            sensitive: true,
            default: null,
          },
          configured: true,
          value: null,
        },
      },
      missingRequired: [],
      revision: 1,
    },
  };
  const project = {
    id: "p",
    client: {
      ready: true,
      request: async (method, _params, options) =>
        method === "areal/plugin/read" ? options.decode(detail) : { restartSafe: true },
    },
  };
  const idle = {
    id: "idle",
    client: { ready: true, request: async () => ({ restartSafe: true }) },
  };
  const busy = {
    id: "busy",
    client: { ready: true, request: async () => ({ restartSafe: false }) },
  };
  const backend = {
    projects: new Map([
      ["p", project],
      ["idle", idle],
      ["busy", busy],
    ]),
    starting: new Map(),
    hasWork: () => false,
    onChange() {},
    providers: { config: {} },
    restartProject: async (p) => calls.push(`restart:${p.id}`),
    submit: async () => {
      calls.push("save");
      return { revision: 2 };
    },
  };
  const result = await configurePluginValues(backend, project, {
    id: "p",
    expectedDigest: "d",
    expectedRevision: 1,
    requestId: "r",
    values: {},
    secrets: {},
    clearKeys: ["TOKEN"],
  });
  assert.deepEqual(calls, ["save"]);
  assert.equal(result.reloadDeferred, undefined);
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
