"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { AppProviders } = require("../app/src/core/providers.cjs");
const { mkdtemp, readFile, rm, stat } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

test("optional desktop audit preserves routing presence without persisting opaque state", async (t) => {
  const previous = process.env.AREAL_CORE_PROVIDER_AUDIT;
  process.env.AREAL_CORE_PROVIDER_AUDIT = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.AREAL_CORE_PROVIDER_AUDIT;
    else process.env.AREAL_CORE_PROVIDER_AUDIT = previous;
  });
  const home = await mkdtemp(join(tmpdir(), "areal-provider-audit-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const providers = new AppProviders({ home }, {});
  providers.transport = { port: 0 };
  const service = await providers.openai();
  t.after(() => service.close());
  await service.onRequest({
    providerId: "fixture",
    model: "model",
    outcome: "completed",
    sessionIdentitySent: true,
    turnStateSent: false,
    turnStateReceived: true,
    "x-codex-turn-state": "opaque-routing-value",
    headers: { Authorization: "fixture-secret" },
  });
  const filename = join(home, "provider-requests.jsonl");
  const text = await readFile(filename, "utf8");
  assert.deepEqual(JSON.parse(text), {
    providerId: "fixture",
    model: "model",
    outcome: "completed",
    sessionIdentitySent: true,
    turnStateSent: false,
    turnStateReceived: true,
  });
  assert(!text.includes("opaque-routing-value"));
  assert(!text.includes("fixture-secret"));
  assert.equal((await stat(filename)).mode & 0o077, 0);
  delete process.env.AREAL_CORE_PROVIDER_AUDIT;
  const disabled = new AppProviders({ home }, {});
  disabled.transport = { port: 0 };
  const quiet = await disabled.openai();
  t.after(() => quiet.close());
  assert.equal(quiet.onRequest, undefined);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const applications = [],
    reads = [],
    tracked = [];
  const backend = {
    submit: async (project, method, params) => {
      applications.push({ projectId: project.id, method, params });
      if (method === "areal/provider/upsert")
        return { ...params.provider, revision: params.expectedRevision + 1 };
    },
  };
  const providers = new AppProviders(backend, {});
  const account = {
    revision: 1,
    lifetime: new AbortController(),
    failure: null,
    refreshing: null,
    track: (promise) => {
      tracked.push(promise);
      return promise;
    },
  };
  const state = { calls: 0, fresh: true, catalogRevision: 1, read: null };
  const service = {
    id: "areal_openai",
    account,
    models: [{ id: "model-v1" }],
    endpoint: "http://127.0.0.1:9/responses",
    catalog: { metadata: () => ({ fresh: state.fresh, sessionRevision: state.catalogRevision }) },
    ready: async () => {},
    close: async () => {
      account.revision++;
      account.lifetime.abort();
      await Promise.allSettled(tracked);
    },
  };
  account.status = async () => {
    state.calls++;
    if (state.read) return state.read();
    state.fresh = true;
    state.catalogRevision = account.revision;
    return {
      authenticated: true,
      state: account.refreshing ? "refreshing" : (account.failure?.state ?? "ready"),
      models: service.models,
      diagnostic: account.failure?.diagnostic() ?? null,
    };
  };
  const project = (id, existing = []) => ({
    id,
    connectionGeneration: 1,
    service: { serviceId: `service-${id}`, generation: "generation-1" },
    client: {
      ready: true,
      request: async (method) => {
        assert.equal(method, "areal/provider/list");
        reads.push(id);
        return { data: existing };
      },
    },
  });
  const first = project("000000000000000000000001");
  const second = project("000000000000000000000002");
  return { providers, account, service, state, applications, reads, project, first, second };
}

function applied(projectId, model = "model-v1") {
  return {
    projectId,
    method: "areal/provider/upsert",
    params: {
      provider: {
        id: "areal_openai",
        contextSource: "account",
        protocol: "responses",
        endpoint: "http://127.0.0.1:9/responses",
        credentialRef: "areal_openai",
        models: [model],
        parameters: {},
        revision: 0,
      },
      expectedRevision: 0,
    },
  };
}

for (const prefetch of [true, false])
  test(`five owners share a coherent status with prefetch ${prefetch}`, async () => {
    const f = fixture();
    const gate = deferred(),
      entered = deferred();
    f.state.read = async () => {
      entered.resolve();
      await gate.promise;
      return {
        authenticated: true,
        state: "ready",
        models: f.service.models,
        diagnostic: null,
      };
    };
    if (prefetch) f.providers.prepareSubscriptionStatus(f.service);
    const projects = [
      f.first,
      f.second,
      f.project("000000000000000000000003"),
      f.project("000000000000000000000004"),
      f.project("000000000000000000000005"),
    ];
    const syncing = Promise.all(
      projects.map((project) => f.providers.syncSubscription(project, f.service)),
    );
    await entered.promise;
    gate.resolve();
    await syncing;
    assert.deepEqual(f.applications, [
      applied("000000000000000000000001"),
      applied("000000000000000000000002"),
      applied("000000000000000000000003"),
      applied("000000000000000000000004"),
      applied("000000000000000000000005"),
    ]);
    assert.deepEqual(f.reads, [
      "000000000000000000000001",
      "000000000000000000000002",
      "000000000000000000000003",
      "000000000000000000000004",
      "000000000000000000000005",
    ]);
    assert.equal(f.state.calls, 1, "one status result serves all current Core owners");
  });

test("revision, catalog expiry, catalog revision, and exact model identity refresh status", async () => {
  const f = fixture();
  await f.providers.syncSubscription(f.first, f.service);
  f.account.revision++;
  f.service.models = [{ id: "model-v2" }];
  await f.providers.syncSubscription(f.second, f.service);
  assert.equal(f.state.calls, 2);
  assert.deepEqual(f.applications.at(-1), applied("000000000000000000000002", "model-v2"));
  f.state.fresh = false;
  await f.providers.syncSubscription(f.first, f.service);
  assert.equal(f.state.calls, 3);
  f.state.catalogRevision = 1;
  await f.providers.syncSubscription(f.second, f.service);
  assert.equal(f.state.calls, 4);
  f.service.models = [{ id: "model-v3" }];
  await f.providers.syncSubscription(f.first, f.service);
  assert.equal(f.state.calls, 5);
  assert.deepEqual(f.applications.at(-1), applied("000000000000000000000001", "model-v3"));
  await f.providers.syncSubscription(f.second, f.service);
  assert.equal(f.state.calls, 5);
  assert.deepEqual(f.applications.at(-1), applied("000000000000000000000002", "model-v3"));
});

test("changed failure diagnostics and refreshing state invalidate a completed status", async () => {
  const f = fixture();
  let code = "catalog_unavailable";
  f.account.failure = { state: "temporarily_unavailable", diagnostic: () => ({ code }) };
  await f.providers.syncSubscription(f.first, f.service);
  await f.providers.syncSubscription(f.second, f.service);
  assert.equal(f.state.calls, 1);
  code = "credential_expired";
  await f.providers.syncSubscription(f.first, f.service);
  assert.equal(f.state.calls, 2);
  f.account.failure = null;
  f.account.refreshing = Promise.resolve();
  await f.providers.syncSubscription(f.second, f.service);
  assert.equal(f.state.calls, 3);
  f.account.refreshing = null;
  await f.providers.syncSubscription(f.first, f.service);
  await f.providers.syncSubscription(f.second, f.service);
  assert.equal(f.state.calls, 4);
  assert.deepEqual(f.applications, [
    applied("000000000000000000000001"),
    applied("000000000000000000000002"),
  ]);
});

test("signed out status removes each Core provider and expires after thirty seconds", async (t) => {
  const f = fixture();
  let now = 100_000;
  t.mock.method(Date, "now", () => now);
  f.state.read = async () => ({
    authenticated: false,
    state: "signed_out",
    models: [],
    diagnostic: null,
  });
  const one = f.project("000000000000000000000001", [{ id: "areal_openai", revision: 7 }]);
  const two = f.project("000000000000000000000002", [{ id: "areal_openai", revision: 9 }]);
  await f.providers.syncSubscription(one, f.service);
  now += 29_999;
  await f.providers.syncSubscription(two, f.service);
  assert.equal(f.state.calls, 1);
  now++;
  await f.providers.syncSubscription(one, f.service);
  assert.equal(f.state.calls, 2);
  assert.deepEqual(f.applications, [
    {
      projectId: "000000000000000000000001",
      method: "areal/provider/remove",
      params: { id: "areal_openai", expectedRevision: 7 },
    },
    {
      projectId: "000000000000000000000002",
      method: "areal/provider/remove",
      params: { id: "areal_openai", expectedRevision: 9 },
    },
    {
      projectId: "000000000000000000000001",
      method: "areal/provider/remove",
      params: { id: "areal_openai", expectedRevision: 7 },
    },
  ]);
});

test("one failed status read serves queued consumers until account failure changes", async () => {
  const f = fixture();
  const error = new Error("catalog failed");
  f.state.read = async () => {
    throw error;
  };
  f.providers.prepareSubscriptionStatus(f.service);
  const outcomes = await Promise.allSettled([
    f.providers.syncSubscription(f.first, f.service),
    f.providers.syncSubscription(f.second, f.service),
  ]);
  assert.deepEqual(
    outcomes.map((outcome) => ({ status: outcome.status, message: outcome.reason?.message })),
    [
      { status: "rejected", message: "catalog failed" },
      { status: "rejected", message: "catalog failed" },
    ],
  );
  assert.equal(f.state.calls, 1);
  f.account.failure = {
    state: "temporarily_unavailable",
    diagnostic: () => ({ code: "catalog_failed" }),
  };
  f.state.read = null;
  await f.providers.syncSubscription(f.first, f.service);
  f.account.failure = null;
  await f.providers.syncSubscription(f.second, f.service);
  assert.equal(f.state.calls, 3);
  assert.deepEqual(f.applications, [applied("000000000000000000000002")]);
});

for (const change of ["revision", "lifetime", "close"])
  test(`late status cannot apply after ${change}`, async () => {
    const f = fixture();
    const gate = deferred(),
      entered = deferred();
    f.state.read = async () => {
      const models = f.service.models;
      entered.resolve();
      await gate.promise;
      return { authenticated: true, state: "ready", models, diagnostic: null };
    };
    const syncing = f.providers.syncSubscription(f.first, f.service);
    await entered.promise;
    let closing;
    if (change === "revision") f.account.revision++;
    else if (change === "lifetime") {
      f.account.lifetime.abort();
      f.account.lifetime = new AbortController();
    } else {
      f.providers.openaiPromise = Promise.resolve(f.service);
      closing = f.providers.close();
    }
    f.service.models = [{ id: "model-v2" }];
    gate.resolve();
    await syncing;
    if (closing) await closing;
    assert.equal(f.state.calls, 1, "changed identity does not retry within the old application");
    assert.deepEqual(f.applications, []);
    if (change !== "close") {
      f.state.read = null;
      await f.providers.syncSubscription(f.second, f.service);
      assert.equal(f.state.calls, 2);
      assert.deepEqual(f.applications, [applied("000000000000000000000002", "model-v2")]);
    }
  });

test("account change during Core provider read prevents an old model application", async () => {
  const f = fixture();
  const gate = deferred(),
    entered = deferred();
  f.first.client.request = async (method) => {
    assert.equal(method, "areal/provider/list");
    entered.resolve();
    await gate.promise;
    return { data: [] };
  };
  const syncing = f.providers.syncSubscription(f.first, f.service);
  await entered.promise;
  f.account.revision++;
  f.service.models = [{ id: "model-v2" }];
  gate.resolve();
  await syncing;
  await f.providers.syncSubscription(f.second, f.service);
  assert.deepEqual(f.applications, [applied("000000000000000000000002", "model-v2")]);
});

test("a different subscription service cannot reuse the previous model catalog", async () => {
  const f = fixture();
  await f.providers.syncSubscription(f.first, f.service);
  const replacement = { ...f.service, models: [{ id: "model-v2" }] };
  f.state.read = async () => ({
    authenticated: true,
    state: "ready",
    models: replacement.models,
    diagnostic: null,
  });
  await f.providers.syncSubscription(f.second, replacement);
  assert.equal(f.state.calls, 2);
  assert.deepEqual(f.applications, [
    applied("000000000000000000000001"),
    applied("000000000000000000000002", "model-v2"),
  ]);
});

test("same-project writes serialize while another project's subscription becomes ready", async () => {
  const f = fixture();
  const gate = deferred(),
    entered = deferred();
  f.first.client.request = async () => {
    entered.resolve();
    await gate.promise;
    return { data: [] };
  };
  const first = f.providers.syncSubscription(f.first, f.service);
  await entered.promise;
  const secondOnFirst = f.providers.syncSubscription(f.first, f.service);
  await f.providers.syncSubscription(f.second, f.service);
  assert.deepEqual(
    f.applications.map((item) => item.projectId),
    [f.second.id],
  );
  assert.equal(f.state.calls, 1);
  gate.resolve();
  await Promise.all([first, secondOnFirst]);
  assert.deepEqual(
    f.applications.map((item) => item.projectId),
    [f.second.id, f.first.id, f.first.id],
  );
});

test("checking catalog retains the remembered subscription model and reuses its projection", () => {
  const f = fixture();
  f.providers.config.value = {
    data: [{ id: "fixture", name: "Configured provider", models: [] }],
    revision: "fixture",
  };
  f.providers.subscription = {
    ...f.providers.subscription,
    authenticated: true,
    availability: "checking",
  };
  f.providers.lastAcceptedModel = {
    model: { providerId: "areal_openai", modelId: "remembered" },
    modelId: "remembered",
    reasoningEffort: "high",
    acceptedAt: 1,
  };
  const source = [{ providerId: "fixture", modelId: "local", providerRevision: 1 }];
  const result = f.providers.catalog(source, f.first);
  assert.equal(
    result.find((model) => model.modelId === "local").providerName,
    "Configured provider",
  );
  assert.equal(result.find((model) => model.modelId === "remembered").providerName, "ChatGPT");
  assert.equal(result.find((model) => model.modelId === "remembered").availability, "checking");
  assert.equal(result.find((model) => model.modelId === "remembered").available, undefined);
  assert.equal(result.find((model) => model.modelId === "remembered").capabilities, undefined);
  assert.equal(f.providers.catalog(source, f.first), result);
  f.first.configurations = {
    historical: { model: { providerId: "areal_openai", modelId: "historical-model" } },
  };
  assert.equal(
    f.providers.catalog(source, f.first).find((model) => model.modelId === "historical-model")
      .availability,
    "checking",
  );
  f.providers.subscription = {
    ...f.providers.subscription,
    models: [
      {
        id: "remembered",
        name: "Remembered model",
        parameters: { contextWindowTokens: 200000 },
        reasoningEffortOptions: ["low", "high"],
      },
    ],
  };
  assert.equal(f.providers.catalog(source, f.first)[1].displayName, "Remembered model");
  assert.equal(f.providers.catalog(source, f.first)[1].contextWindowTokens, 200000);
  assert.deepEqual(f.providers.catalog(source, f.first)[1].reasoningEffortOptions, ["low", "high"]);
});

test("only a definitive Core model rejection invalidates its matching selection", () => {
  const f = fixture();
  f.providers.backend.onChange = () => {};
  f.first.models = [{ providerId: "areal_openai", modelId: "model-v1", providerRevision: 1 }];
  const model = { providerId: "areal_openai", modelId: "model-v1" };
  f.providers.rejectModel(f.first, model, { code: -32000, message: "network unavailable" });
  assert.equal(f.first.models[0].available, undefined);
  f.providers.rejectModel(f.first, model, { code: -32602, message: "unknown model" });
  assert.equal(f.first.models[0].availability, "unavailable");
  assert.equal(f.first.models[0].available, false);
});

test("unknown subscription provider writes are read back without automatic replay", async () => {
  const f = fixture();
  f.first.pending = [
    { method: "areal/provider/upsert", params: { provider: { id: "areal_openai" } } },
  ];
  await assert.rejects(f.providers.syncSubscription(f.first, f.service), /结果未知/);
  assert.deepEqual(f.applications, []);
});

test("refresh stays pending until project synchronization settles so the next explicit refresh runs", async () => {
  const f = fixture();
  const gate = deferred(),
    entered = deferred();
  f.providers.backend.projects = new Map([[f.first.id, f.first]]);
  f.providers.backend.onChange = () => {};
  f.providers.syncSubscription = async () => {
    entered.resolve();
    await gate.promise;
  };
  f.providers.publishSubscription = async () => {};
  const first = f.providers.refreshSubscriptionStatus(f.service);
  await entered.promise;
  const duringSynchronization = f.providers.subscription.refreshing;
  gate.resolve();
  await first;
  assert.equal(duringSynchronization, true);
  assert.equal(f.providers.subscription.refreshing, false);
  await f.providers.refreshSubscriptionStatus(f.service, { synchronize: false, force: true });
  assert.equal(f.state.calls, 2);
});

test("subscription publication supplies account effort constraints to Core without overwriting account metadata", async () => {
  const f = fixture();
  f.providers.backend.onChange = () => {};
  f.service.models = [{ id: "model-v1", reasoningEffortOptions: ["low", "max"] }];
  await f.providers.syncSubscription(f.first, f.service);
  assert.deepEqual(f.applications[0].params.provider.modelCapabilities, {
    "model-v1": {
      tools: true,
      vision: true,
      reasoning: true,
      reasoningEffortOptions: ["low", "max"],
    },
  });
  f.providers.subscription = { ...f.providers.subscription, models: f.service.models };
  f.first.client.request = async () => ({
    data: [
      { providerId: "areal_openai", modelId: "model-v1", reasoningEffortOptions: ["minimal"] },
    ],
  });
  await f.providers.publishSubscription(f.providers.subscriptionScope(f.first, f.service));
  assert.deepEqual(f.providers.subscription.models[0].reasoningEffortOptions, ["low", "max"]);
});
