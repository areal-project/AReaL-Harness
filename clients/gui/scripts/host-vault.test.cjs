"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, writeFile, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { HostVault } = require("../app/src/core/host-vault.cjs");
const { ModelConfiguration } = require("../app/src/core/model-config.cjs");
const { SubscriptionStore } = require("../app/src/core/subscription.cjs");
const { AppProviders } = require("../app/src/core/providers.cjs");

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "areal-host-credentials-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const values = new Map(),
    operations = new Map(),
    writes = [];
  const sourceId = "00000000-0000-4000-a000-000000000001";
  const state = {
    source: { profile: home, coreHome: home, legacyServiceHome: home },
    sourceId,
    credentials: { references: [], migratedConfigPaths: [] },
  };
  const backend = {
    home,
    projects: new Map(),
    hooks: { environment: () => ({}) },
    async save(name, value) {
      assert(
        ![
          "provider-credentials.json",
          "providers.json",
          "openai-subscription.json",
          "subscription-transport.json",
        ].includes(name),
      );
      await writeFile(join(home, name), JSON.stringify(value), { mode: 0o600 });
    },
    host: {
      state,
      source: state.source,
      sourceId,
      resolve: () => ({ sourceId }),
      client: {
        async sourceState() {
          return state;
        },
        async vaultRead(slot) {
          return structuredClone(values.get(JSON.stringify(slot)) ?? { revision: 0, value: null });
        },
        async vaultReplace(requestId, slot, expectedRevision, value) {
          const key = JSON.stringify(slot),
            current = await this.vaultRead(slot);
          writes.push({ requestId, slot, expectedRevision });
          if (current.revision !== expectedRevision)
            throw Object.assign(new Error("revision changed"), { code: "revisionConflict" });
          values.set(key, { revision: current.revision + 1, value: structuredClone(value) });
          if (
            slot.kind === "providerCredential" &&
            !state.credentials.references.includes(slot.reference)
          )
            state.credentials.references.push(slot.reference);
          const receipt = { requestId, slot, revision: current.revision + 1, state: "completed" };
          operations.set(requestId, receipt);
          return receipt;
        },
        async operation(id) {
          return { operation: operations.get(id) ?? null };
        },
      },
    },
  };
  const vault = new HostVault(backend);
  await vault.init();
  return { backend, vault, values, operations, writes, home, state };
}

test("retired source credentials and legacy references restore from Host metadata", async (t) => {
  const f = await fixture(t);
  const reference = "AREAL_CREDENTIAL_disabled";
  f.state.credentials.references.push(reference);
  f.state.credentials.migratedConfigPaths.push("/fixture/config.toml");
  f.state.credentials.legacyProviders = {
    data: [
      {
        id: "disabled",
        name: "Saved",
        baseUrl: "https://model.invalid",
        protocol: "responses",
        enabled: false,
        models: [],
        parameters: {},
        apiKeyEnv: reference,
      },
    ],
    retired: ["retired"],
  };
  await writeFile(join(f.home, "provider-credentials.json"), "AREAL_HOST_MIGRATED\n");
  await writeFile(join(f.home, "providers.json"), "retired source must never be read");
  const slot = { kind: "providerCredential", sourceId: f.state.sourceId, reference };
  f.values.set(JSON.stringify(slot), { revision: 2, value: "synthetic-disabled-secret" });
  const model = new ModelConfiguration(f.backend, f.vault);
  await model.init();
  assert.equal(model.legacy.data[0].apiKeyEnv, reference);
  assert.deepEqual(model.environment(), { [reference]: "synthetic-disabled-secret" });
  let writes = 0;
  model.execute = async () => ({
    path: "/fixture/config.toml",
    data: [],
    revision: "original",
    defaultModel: null,
  });
  f.backend.save = async () => writes++;
  assert.deepEqual((await model.current()).data, []);
  assert.equal(writes, 0);
  f.values.set(JSON.stringify(slot), { revision: 3, value: null });
  await model.refreshCredentials();
  assert.deepEqual(model.environment(), {});
  assert.equal(model.key({ apiKeyEnv: reference }), "");
});

test("new configuration migration preserves exact legacy authentication and nonsecret receipt", async (t) => {
  const f = await fixture(t);
  f.state.credentials.legacyProviders = {
    data: [
      {
        id: "anonymous",
        name: "No key",
        baseUrl: "https://model.invalid",
        protocol: "responses",
        enabled: true,
        models: [],
        parameters: {},
      },
    ],
  };
  f.state.credentials.references.push("AREAL_CREDENTIAL_anonymous");
  const model = new ModelConfiguration(f.backend, f.vault);
  await model.init();
  const requests = [];
  model.execute = async (operation, request) => {
    requests.push({ operation, request });
    return {
      path: "/fixture/new.toml",
      data: request?.data ?? [],
      revision: "new",
      defaultModel: null,
    };
  };
  await model.current();
  assert.equal(requests[1].request.data[0].apiKeyEnv, undefined);
  assert.deepEqual(JSON.parse(await readFile(join(f.home, "model-config-migrations.json"))), [
    "/fixture/new.toml",
  ]);
  assert.equal(
    await readFile(join(f.home, "host-vault-operations.json"), "utf8").catch(() => "absent"),
    "absent",
  );
});

test("GUI leaves subscription transport with Host and stores ordinary provider credentials", async (t) => {
  const f = await fixture(t);
  const native = {
    owner: "nativeV1",
    generation: "fixture-generation",
    accountEpoch: 0,
    transportRevision: 1,
    endpoint: "http://127.0.0.1:12345/responses",
    authenticated: false,
    availability: "unavailable",
    refreshing: false,
    state: "signed_out",
    email: null,
    planType: null,
    modelError: null,
    models: [],
    diagnostic: null,
    login: null,
    error: null,
    billing: "subscription",
    catalog: null,
  };
  const calls = [];
  f.backend.host.client.requireCapability = (name) => assert.equal(name, "subscriptionOwnerV1");
  f.backend.host.client.request = async (method, params) => {
    calls.push({ method, params });
    assert.equal(params.sourceId, f.state.sourceId);
    if (method === "subscription.read") return structuredClone(native);
    assert.equal(method, "subscription.command");
    assert.equal(params.action.kind, "configureNetwork");
    return { requestId: params.requestId, state: "completed", result: structuredClone(native) };
  };
  const app = new AppProviders(f.backend);
  f.backend.providers = app;
  await app.init();
  t.after(() => app.close());
  assert.equal(app.openaiToken, "");
  assert.equal(app.transport, undefined);
  assert.equal((await app.openai()).endpoint, native.endpoint);
  assert(calls.some((call) => call.method === "subscription.command"));
  const reference = await app.config.credential("synthetic-api-key");
  assert.equal(app.key({ apiKeyEnv: reference }), "synthetic-api-key");
  const reopened = new ModelConfiguration(f.backend, f.vault);
  await reopened.init();
  assert.equal(reopened.key({ apiKeyEnv: reference }), "synthetic-api-key");
  const metadata = await readFile(join(f.home, "host-vault-operations.json"), "utf8");
  assert(!metadata.includes("synthetic-api-key"));
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].slot.kind, "providerCredential");
  assert.deepEqual(
    [...f.values.values()].map((slot) => slot.value),
    ["synthetic-api-key"],
  );
});

test("subscription refresh loses CAS to logout without rerunning the callback", async (t) => {
  const f = await fixture(t);
  const first = new SubscriptionStore(f.backend, f.vault);
  const secondVault = new HostVault(f.backend);
  await secondVault.init();
  const second = new SubscriptionStore(f.backend, secondVault);
  await first.modifyRecord("", () => ({
    kind: "directory",
    payload: { access: "old", refresh: "old-refresh", otherAccount: { access: "kept" } },
  }));
  let release, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let refreshes = 0;
  const refresh = first.modifyRecord("", async (current) => {
    refreshes++;
    entered();
    await gate;
    return {
      ...current,
      payload: { ...current.payload, access: "rotated", refresh: "rotated-refresh" },
    };
  });
  await started;
  await second.deleteRecord();
  release();
  await assert.rejects(refresh, { code: "account_changed" });
  assert.equal(refreshes, 1);
  assert.equal(await first.readRecord(), undefined);
  assert.equal(f.writes.length, 3);
});

test("lost vault response queries its original receipt and never replays replacement", async (t) => {
  const f = await fixture(t);
  const replace = f.backend.host.client.vaultReplace;
  f.backend.host.client.vaultReplace = async function (...args) {
    await replace.apply(this, args);
    throw new Error("lost response");
  };
  const store = new SubscriptionStore(f.backend, f.vault);
  const record = {
    kind: "directory",
    payload: {
      access: "synthetic-secret",
      refresh: "synthetic-refresh",
      records: { other: { secret: "preserved" } },
    },
  };
  assert.deepEqual(await store.modifyRecord("", () => record), record);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.vault.pending, []);
  assert(
    !JSON.stringify(
      JSON.parse(await readFile(join(f.home, "host-vault-operations.json"))),
    ).includes("synthetic-secret"),
  );
});

test("UNKNOWN write survives restart and blocks only its slot without rerunning refresh", async (t) => {
  const f = await fixture(t);
  const store = new SubscriptionStore(f.backend, f.vault);
  await store.modifyRecord("", () => ({ kind: "grant", payload: { access: "old" } }));
  const replace = f.backend.host.client.vaultReplace;
  f.backend.host.client.vaultReplace = async () => {
    throw new Error("disconnected");
  };
  let refreshes = 0;
  await assert.rejects(
    store.modifyRecord("", () => {
      refreshes++;
      return { kind: "grant", payload: { access: "new" } };
    }),
    { code: "storage_write_failed" },
  );
  const originalId = f.vault.pending[0].requestId;
  const restarted = new HostVault(f.backend);
  await restarted.init();
  const reopened = new SubscriptionStore(f.backend, restarted);
  assert.deepEqual(await reopened.readRecord(), { kind: "grant", payload: { access: "old" } });
  await assert.rejects(
    reopened.modifyRecord("", () => {
      refreshes++;
    }),
    { code: "storage_write_failed", requestId: originalId },
  );
  assert.equal(refreshes, 1);
  assert.equal(restarted.pending[0].requestId, originalId);
  f.backend.host.client.vaultReplace = replace;
  await restarted.replace(
    {
      kind: "providerCredential",
      sourceId: f.state.sourceId,
      reference: "AREAL_CREDENTIAL_unrelated",
    },
    0,
    "unrelated-value",
  );
  assert.equal(restarted.pending[0].requestId, originalId);
});

test("foreign Host projects retain their own model and subscription authorities", async (t) => {
  const f = await fixture(t);
  f.backend.host.resolve = () => ({ sourceId: undefined });
  const project = {
    id: "foreign",
    client: { ready: true, request: () => assert.fail("foreign Core must not be mutated") },
  };
  const app = new AppProviders(f.backend);
  f.backend.providers = app;
  f.backend.projects.set(project.id, project);
  await app.syncLocal(project);
  await app.reconcileProject(project);
  await app.refreshSubscription(project);
  assert.deepEqual(await app.prepareProjects(), []);
  assert.throws(() => app.target(project), /其他来源/);
});
