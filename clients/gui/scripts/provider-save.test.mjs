import test from "node:test";
import assert from "node:assert/strict";
import { AppProviders } from "@areal/workbench-service/desktop/core/providers.cjs";
import { CoreBackend } from "@areal/workbench-service/desktop/core/backend.cjs";

const readMethod = "areal/server/modelConfiguration/read";
const applyMethod = "areal/server/modelConfiguration/apply";

function fixture({
  busy = false,
  writeFails = false,
  syncFails = false,
  lostApply = false,
  running = false,
  unsupported = false,
  unacceptedError,
  credentials = {},
} = {}) {
  const calls = [];
  const original = {
    revision: "old",
    data: [
      {
        id: "demo",
        name: "Original",
        enabled: true,
        endpoint: "http://fixture.invalid/v1/chat/completions",
        protocol: "chat-completions",
        models: [{ id: "old-model", enabled: true }],
        parameters: {},
      },
    ],
    defaultModel: null,
  };
  const operations = new Map();
  let applyAttempts = 0;
  let proof = {
    serviceId: "service-p",
    generation: "generation-p",
    applied: { revision: "old", sequence: 0 },
    modelRevision: "model-old",
    credentialStates: { demo: "notRequired" },
  };
  const project = {
    id: "p",
    root: "/fixture",
    service: { serviceId: "service-p", generation: "generation-p" },
    providerRevision: "old",
    models: [{ id: "old-model" }],
    configurations: { running: { model: "old-model" } },
    client: {
      ready: true,
      capabilities: { methods: unsupported ? [] : [readMethod, applyMethod] },
      async request(method, params) {
        calls.push([method, structuredClone(params)]);
        if (method === "areal/server/status") return { restartSafe: true };
        if (method === readMethod)
          return {
            ...structuredClone(proof),
            ...(params?.requestId
              ? {
                  operation: operations.get(params.requestId) ?? {
                    requestId: params.requestId,
                    state: "unknown",
                  },
                }
              : {}),
          };
        if (method === "areal/model/list")
          return { data: service.config.value.data.flatMap((v) => v.models) };
        assert.equal(method, applyMethod);
        assert.equal(params.expectedGeneration, "generation-p");
        assert.deepEqual(params.expectedApplied, proof.applied);
        assert.deepEqual(params.credentials, credentials);
        if (unacceptedError && applyAttempts++ === 0)
          throw Object.assign(new Error("fixture request rejected before admission"), {
            name: "CoreRpcError",
            ...unacceptedError,
          });
        if (syncFails && !operations.size) {
          const error = { code: -32000, message: "fixture synchronization failure" };
          operations.set(params.requestId, {
            requestId: params.requestId,
            state: "rejected",
            error,
          });
          throw Object.assign(new Error(error.message), { code: error.code });
        }
        if (running) {
          operations.set(params.requestId, { requestId: params.requestId, state: "running" });
          throw new Error("fixture receipt pending");
        }
        proof = {
          ...proof,
          applied: { revision: params.targetRevision, sequence: proof.applied.sequence + 1 },
        };
        const operation = {
          requestId: params.requestId,
          state: "applied",
          result: structuredClone(proof),
        };
        operations.set(params.requestId, operation);
        if (lostApply && operations.size === 1) throw new Error("fixture apply receipt lost");
        return { ...structuredClone(proof), operation };
      },
    },
  };
  let writes = 0,
    release;
  const backend = {
    host: { sourceId: "fixture", resolve: () => ({ sourceId: "fixture" }) },
    async hostCall(method, params) {
      assert.equal(method, "workbench.utility");
      assert.deepEqual(params, { operation: "modelsCatalog" });
      return {
        ...structuredClone(service.config.value),
        path: "/fixture/models.json",
        credentialStates: { demo: "notRequired" },
        credentialSources: { demo: "none" },
        effective: {},
      };
    },
    projects: new Map([["p", project]]),
    starting: new Set(),
    hasWork: () => busy,
    activeCommands: 0,
    resourcesUpdating: false,
    providerUpdating: false,
    onChange() {},
    async restartProject() {
      throw new Error("configuration must never restart Core");
    },
  };
  const service = new AppProviders(backend, {});
  service.config.value = structuredClone(original);
  backend.providers = service;
  service.config.current = async () => service.config.value;
  service.config.refreshCredentials = async () => {};
  service.config.execute = async (_operation, request) => {
    calls.push(["write", structuredClone(request)]);
    writes++;
    if (writeFails && writes === 1) throw new Error("fixture persistence failure");
    if (release) await release.promise;
    assert.equal(request.expectedRevision, service.config.value.revision);
    return {
      ...structuredClone(original),
      revision: `revision-${writes}`,
      data: structuredClone(request.data),
      defaultModel: request.defaultModel,
    };
  };
  const request = {
    operation: "saveAndApply",
    expectedRevision: "old",
    authentication: "none",
    provider: {
      id: "demo",
      name: "Updated",
      baseUrl: "http://fixture.invalid/v1",
      protocol: "chatCompletions",
      enabled: true,
      models: [{ id: "new-model", enabled: true }],
      parameters: { contextWindowTokens: 64000 },
    },
  };
  return {
    service,
    backend,
    project,
    calls,
    original,
    request,
    operations,
    holdWrite() {
      let resolve;
      release = {
        promise: new Promise((r) => {
          resolve = r;
        }),
        resolve: () => resolve(),
      };
      return release;
    },
  };
}

test("explicit key reveal is revision-bound and never writes or publishes a secret", async () => {
  const f = fixture({ busy: true });
  f.service.config.value.data[0].apiKeyEnv = "AREAL_CREDENTIAL_fixture";
  f.service.config.key = (item) => {
    assert.equal(item.id, "demo");
    return "synthetic-reveal-key";
  };
  assert.deepEqual(
    await f.service.command({ operation: "revealKey", id: "demo", expectedRevision: "old" }),
    { apiKey: "synthetic-reveal-key" },
  );
  assert.equal(JSON.stringify(f.service.public()).includes("synthetic-reveal-key"), false);
  assert.deepEqual(f.calls, []);
  await assert.rejects(
    f.service.command({ operation: "revealKey", id: "demo", expectedRevision: "stale" }),
  );
  await assert.rejects(
    f.service.command({ operation: "revealKey", id: "missing", expectedRevision: "old" }),
  );
  await assert.rejects(
    f.service.command({
      operation: "revealKey",
      id: "demo",
      expectedRevision: "old",
      reference: "OTHER_SECRET",
    }),
  );
});

test("key reveal returns a safe failure for missing or locked credentials", async () => {
  const f = fixture();
  const request = { operation: "revealKey", id: "demo", expectedRevision: "old" };
  await assert.rejects(f.service.command(request));
  f.service.config.value.data[0].apiKeyEnv = "AREAL_CREDENTIAL_fixture";
  f.service.config.key = () => {
    throw new Error("untrusted-synthetic-secret");
  };
  await assert.rejects(
    f.service.command(request),
    (error) => !String(error.stack).includes("untrusted-synthetic-secret"),
  );
  assert.deepEqual(f.calls, []);
});

test("draft discovery uses unsaved normalized connection and transient key without persistence", async () => {
  const f = fixture({ busy: true });
  const secret = "synthetic-draft-discovery-key";
  const requests = [];
  f.service.config.credential = async () =>
    assert.fail("Discovery cannot allocate or persist a credential");
  f.service.network = async () => ({
    fetch: async (url, options) => {
      requests.push({
        url,
        method: options.method,
        authorization: options.headers.Authorization,
        redirect: options.redirect,
      });
      return Response.json({
        data: [{ id: "draft-model", context_window: 160000 }, { id: secret }],
      });
    },
  });
  const result = await f.service.command({
    operation: "discover",
    connection: {
      protocol: "responses",
      baseUrl: "https://unsaved.fixture.invalid/v1/responses/",
      credential: { kind: "draft", value: secret },
    },
  });
  assert.deepEqual(requests, [
    {
      url: "https://unsaved.fixture.invalid/v1/models",
      method: "GET",
      authorization: `Bearer ${secret}`,
      redirect: "error",
    },
  ]);
  assert.deepEqual(result, {
    models: ["draft-model"],
    modelParameters: { "draft-model": { contextWindowTokens: 160000 } },
  });
  assert.deepEqual(f.service.config.value, f.original);
  assert.deepEqual(f.service.config.vault.keys, {});
  assert.equal(
    f.calls.some(([method]) => method === "write" || method === applyMethod),
    false,
  );
});

test("saved-key draft discovery resolves only the requested current provider revision", async () => {
  const f = fixture();
  f.service.config.value.data[0].apiKeyEnv = "AREAL_CREDENTIAL_existing";
  const requests = [];
  f.service.config.key = (item) => {
    assert.equal(item.id, "demo");
    assert.equal(item.apiKeyEnv, "AREAL_CREDENTIAL_existing");
    return "synthetic-stored-key";
  };
  f.service.network = async () => ({
    fetch: async (url, options) => {
      requests.push({ url, authorization: options.headers.Authorization });
      return Response.json({ data: [{ id: "stored-model" }] });
    },
  });
  const connection = {
    protocol: "chatCompletions",
    baseUrl: "https://draft.fixture.invalid/v1",
    credential: { kind: "saved", providerId: "demo", expectedRevision: "old" },
  };
  assert.deepEqual(await f.service.command({ operation: "discover", connection }), {
    models: ["stored-model"],
  });
  assert.deepEqual(requests, [
    {
      url: "https://draft.fixture.invalid/v1/models",
      authorization: "Bearer synthetic-stored-key",
    },
  ]);
  await assert.rejects(
    f.service.command({
      operation: "discover",
      connection: {
        ...connection,
        credential: { ...connection.credential, expectedRevision: "stale" },
      },
    }),
  );
  assert.equal(requests.length, 1, "Stale credential metadata must fail before a network request");
  assert.equal(
    f.calls.some(([method]) => method === "write"),
    false,
  );
});

test("draft discovery redacts a transient key when response body iteration fails", async () => {
  const f = fixture();
  const secret = "synthetic-transient-stream-key";
  let consumed = false;
  f.service.network = async () => ({
    fetch: async () => ({
      ok: true,
      body: {
        async *[Symbol.asyncIterator]() {
          consumed = true;
          yield Promise.reject(new Error(`upstream failed for ${secret}`));
        },
      },
    }),
  });
  await assert.rejects(
    f.service.command({
      operation: "discover",
      connection: {
        protocol: "responses",
        baseUrl: "https://stream.fixture.invalid/v1",
        credential: { kind: "draft", value: secret },
      },
    }),
    (error) => {
      assert.equal(consumed, true, "The test must reach the response body failure");
      assert.equal(`${error.stack} ${JSON.stringify(error)}`.includes(secret), false);
      return true;
    },
  );
  assert.equal(
    f.calls.some(([method]) => method === "write"),
    false,
  );
});

test("discovery preserves endpoint context without using maximum opt-in capacity", async () => {
  const f = fixture();
  f.service.network = async () => ({
    fetch: async () =>
      Response.json({
        data: [
          { id: "openai/gpt-6.1-sol", context_window: 500000, max_context_window: 872000 },
          { id: "bad", context_window: "1050000" },
          { id: "negative", context_window: -1 },
          { id: "maximum-only", max_context_window: 872000 },
        ],
      }),
  });
  const result = await f.service.testConnection(f.service.config.value.data[0], {
    operation: "discover",
  });
  assert.deepEqual(result.models, ["openai/gpt-6.1-sol", "bad", "negative", "maximum-only"]);
  assert.deepEqual(result.modelParameters, {
    "openai/gpt-6.1-sol": { contextWindowTokens: 500000 },
  });
});

// Host 投影会按目录契约校验 Core 回执，夹具给出完整的目录行。
const catalogEntry = (id) => ({ id, providerId: null, modelId: id, providerRevision: null });
async function connectFixture(t, { catalogFailure = false, replaceOwner = false } = {}) {
  const f = fixture();
  const native = f.project.client.request;
  const connected = [];
  let releaseSubscription, subscriptionRefresh;
  const subscriptionReady = new Promise((resolve) => {
    releaseSubscription = resolve;
  });
  const refreshSubscription = f.service.refreshSubscription.bind(f.service);
  f.service.refreshSubscription = (...args) => (subscriptionRefresh = refreshSubscription(...args));
  let providers = [
    { id: "demo", models: [{ id: "old-model" }] },
    { id: "areal_chatgpt", revision: "retired", models: [{ id: "retired-model" }] },
  ];
  const catalog = () =>
    providers.flatMap((provider) => provider.models.map((model) => catalogEntry(model.id)));
  Object.setPrototypeOf(f.backend, CoreBackend.prototype);
  Object.assign(f.backend, {
    providers: f.service,
    starting: new Map(),
    stopReconciliation() {},
    scheduleReconciliation() {},
    listThreads: async () => {},
    resources: {
      syncMcp: async () => {
        f.calls.push(["mcp-sync"]);
      },
    },
    analytics: { syncProject: async () => {} },
    // This provider fixture has no task rows or pending lifecycle operations.
    ownerTasks: { attach: () => ({ start: async () => {}, stop() {} }) },
    lifecycleOperations: {
      assertProject: (id) => assert.equal(id, f.project.id),
      schedulingSuppressed: () => false,
    },
    notifications: { publish() {} },
    library: { value: { threads: {} } },
    submit: async (_project, method, params) => {
      f.calls.push([method, params]);
      if (method === "areal/provider/remove")
        providers = providers.filter((provider) => provider.id !== params.id);
      else if (method === "areal/provider/upsert") providers.push(params);
      else assert.fail(method);
    },
  });
  f.project.client.close = () => {};
  f.project.model = { state: { threads: {} }, connection: (value) => connected.push(value) };
  f.service.syncSubscription = async (project) => {
    await subscriptionReady;
    return f.backend.submit(project, "areal/provider/upsert", {
      id: "subscription",
      models: [{ id: "subscription-model" }],
    });
  };
  // 连接经 Host 投影建立；夹具回答 Host 一侧，Core 请求仍由下面的表决定。
  f.backend.host = { ...f.backend.host, sourceId: "fixture-source" };
  f.backend.hostCoreClients = new Map();
  f.backend.hostCall = async (hostMethod, input) => {
    if (hostMethod === "core.attach")
      return {
        lease: "fixture-lease",
        coreInstanceId: "fixture-core",
        coreGeneration: "fixture-generation",
        connectionId: "fixture-connection",
        capabilities: { methods: [readMethod, applyMethod] },
      };
    if (hostMethod === "core.detach") return {};
    assert.equal(hostMethod, "core.request");
    return { result: await coreRequest(input.method, input.params), sequence: 0 };
  };
  const coreRequest = async (method, params) => {
    if ([readMethod, applyMethod, "areal/server/status"].includes(method))
      return native(method, params);
    f.calls.push([method, params]);
    if (method === "areal/provider/list") return { data: providers };
    if (method === "areal/model/list") {
      if (catalogFailure) throw new Error("fixture final catalog unavailable");
      const result = { data: catalog() };
      if (replaceOwner) {
        f.project.client = { ready: true };
        f.project.models = [{ id: "replacement-model" }];
      }
      return result;
    }
    if (["areal/profile/list", "areal/task/list", "areal/inbox/list"].includes(method))
      return { data: [] };
    assert.fail(method);
  };
  t.after(async () => {
    releaseSubscription();
    await subscriptionRefresh;
    f.project.taskNotificationMonitor?.stop();
    await f.service.close();
  });
  return { ...f, connected, releaseSubscription, subscriptionRefresh: () => subscriptionRefresh };
}

test("connect refuses readiness when the final catalog fails", async (t) => {
  const f = await connectFixture(t, { catalogFailure: true });
  await assert.rejects(f.backend.connect(f.project), /final catalog unavailable/);
  assert.deepEqual(f.connected, []);
  assert.deepEqual(f.project.models, [{ id: "old-model" }]);
  assert.equal(f.project.providerRevision, "old");
  assert.equal(f.service.applicationState(f.project).kind, "applied");
});

test("a stale catalog callback cannot install models or mark the replacement connection ready", async (t) => {
  const f = await connectFixture(t, { replaceOwner: true });
  await assert.rejects(f.backend.connect(f.project), { code: "STALE_CONNECTION" });
  assert.deepEqual(f.project.models, [{ id: "replacement-model" }]);
  assert.deepEqual(f.connected, []);
});

test("a stale default-refresh response cannot overwrite a replacement owner's catalog", async (t) => {
  const f = fixture();
  t.after(() => f.service.close());
  const native = f.project.client.request;
  f.project.client.request = async (method, params) => {
    const result = await native(method, params);
    if (method === "areal/model/list") {
      f.project.client = { ready: true };
      f.project.models = [{ id: "replacement-model" }];
    }
    return result;
  };
  await f.service.reconcileProject(f.project);
  assert.deepEqual(f.project.models, [{ id: "replacement-model" }]);
});
