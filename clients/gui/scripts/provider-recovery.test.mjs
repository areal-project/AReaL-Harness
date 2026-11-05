import test from "node:test";
import assert from "node:assert/strict";
import { ChatGPTAccount } from "../packages/chatgpt-provider/account.js";
import { AppProviders } from "@areal/workbench-service/desktop/core/providers.cjs";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fixture(oauth) {
  let record = {
    kind: "grant",
    payload: {
      type: "oauth",
      access: "fixture-access",
      refresh: "fixture-refresh",
      expires: 0,
      accountId: "fixture-account",
    },
  };
  let chain = Promise.resolve();
  const store = {
    readRecord: async () => structuredClone(record),
    modifyRecord(_key, mutate) {
      const work = chain.then(async () => {
        const next = await mutate(structuredClone(record));
        if (next !== undefined) record = next;
        return structuredClone(record);
      });
      chain = work.catch(() => {});
      return work;
    },
    deleteRecord: async () => {
      record = undefined;
    },
  };
  return {
    store,
    account: new ChatGPTAccount(store, { oauth }),
    get record() {
      return record;
    },
  };
}

test("temporary refresh failure shares one attempt and preserves the grant", async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    await new Promise((resolve) => setImmediate(resolve));
    throw new TypeError("fixture network");
  });
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => f.account.accessToken()),
  );
  assert.equal(calls, 1);
  assert.ok(
    results.every((r) => r.status === "rejected" && r.reason.state === "temporarily_unavailable"),
  );
  assert.equal(f.record.kind, "grant");
  assert.equal((await f.account.status()).state, "temporarily_unavailable");
});

test("terminal refresh error retains registration and stops using tokens", async () => {
  const f = fixture(async () => {
    throw Object.assign(new Error("secret upstream text"), {
      code: "invalid_grant",
      phase: "refresh",
    });
  });
  await assert.rejects(
    f.account.accessToken(),
    (e) => e.state === "reauth_required" && !e.message.includes("secret"),
  );
  assert.equal(f.record.kind, "registration");
  assert.equal(f.record.payload.access, undefined);
  assert.equal((await f.account.status()).state, "reauth_required");
});

test("cancelled initiating request still persists a rotation for concurrent waiters", async () => {
  let finish,
    calls = 0;
  const wait = new Promise((resolve) => {
    finish = resolve;
  });
  const f = fixture(async (_action, { credential }) => {
    calls++;
    await wait;
    return {
      ...credential,
      access: "rotated",
      refresh: "rotated-refresh",
      expires: Date.now() + 3600000,
    };
  });
  const controller = new AbortController();
  const cancelled = f.account.accessToken(controller.signal);
  const live = f.account.accessToken();
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  finish();
  await assert.rejects(cancelled);
  assert.equal(await live, "rotated");
  assert.equal(f.record.payload.refresh, "rotated-refresh");
  assert.equal(calls, 1);
});

test("locked storage is diagnosable without reporting logout", async () => {
  const f = fixture(async () => assert.fail("must not refresh"));
  f.store.readRecord = async () => {
    throw Object.assign(new Error("fixture storage"), { code: "storage_locked" });
  };
  const status = await f.account.status();
  assert.equal(status.state, "storage_locked");
  assert.equal(status.authenticated, false);
  assert.equal(status.diagnostic.code, "storage_locked");
});

function providers() {
  const service = new AppProviders({ projects: new Map(), onChange() {} }, {});
  service.config.value = {
    revision: "fixture",
    data: [
      {
        id: "fixture",
        name: "Gateway",
        endpoint: "https://fixture.invalid/v1/responses",
        protocol: "responses",
        models: [{ id: "m", parameters: { contextWindowTokens: 131072 } }],
        parameters: { contextWindowTokens: 200000 },
        enabled: true,
      },
    ],
  };
  service.config.current = async () => service.config.value;
  service.config.execute = async (_op, next) => ({ ...next, projects: [], revision: "next" });
  service.config.public = () => service.config.value;
  return service;
}
test("provider save preserves Core context budgets and rejects unknown parameters", async (t) => {
  const service = providers();
  t.after(() => service.close());
  const provider = {
    ...service.value.data[0],
    name: "Renamed",
    baseUrl: "https://fixture.invalid/v1",
    protocol: "responses",
  };
  await service.command({ operation: "save", expectedRevision: "fixture", provider });
  assert.equal(service.value.data[0].parameters.contextWindowTokens, 200000);
  assert.equal(service.value.data[0].models[0].parameters.contextWindowTokens, 131072);
  const invalid = providers();
  t.after(() => invalid.close());
  await assert.rejects(
    invalid.command({
      operation: "save",
      expectedRevision: "fixture",
      provider: { ...provider, parameters: { unknown: 1 } },
    }),
    /参数/,
  );
});

test("rotation write failure retries the new token without a second exchange", async () => {
  let calls = 0;
  const f = fixture(async (_action, { credential }) => {
    calls++;
    return {
      ...credential,
      access: "next-access",
      refresh: "next-refresh",
      expires: Date.now() + 3600000,
    };
  });
  const modify = f.store.modifyRecord.bind(f.store);
  let fail = true;
  f.store.modifyRecord = (key, mutate) =>
    modify(key, async (current) => {
      const next = await mutate(current);
      if (fail) {
        fail = false;
        throw Object.assign(new Error("fixture disk full"), { code: "storage_write_failed" });
      }
      return next;
    });
  await assert.rejects(f.account.accessToken(), (e) => e.state === "storage_locked");
  assert.equal(f.record.payload.refresh, "fixture-refresh");
  assert.equal(await f.account.accessToken(), "next-access");
  assert.equal(calls, 1);
  assert.equal(f.record.payload.refresh, "next-refresh");
  const restarted = new ChatGPTAccount(f.store, {
    oauth: async () => assert.fail("saved token should be fresh"),
  });
  assert.equal(await restarted.accessToken(), "next-access");
});

test("restarted terminal session still requires reauthorization", async () => {
  const f = fixture(async () => {
    throw Object.assign(new Error("fixture"), { code: "refresh_token_reused" });
  });
  await assert.rejects(f.account.accessToken());
  const restarted = new ChatGPTAccount(f.store, {
    oauth: async () => assert.fail("terminal grant must not be reused"),
  });
  assert.equal((await restarted.status()).state, "reauth_required");
});

import { CoreSubscription } from "../packages/chatgpt-provider/core.js";
import { responseError, safeRefresh } from "../packages/chatgpt-provider/errors.js";
const event = (data) => `data: ${JSON.stringify(data)}\n\n`;
const successStream = () =>
  new Response(
    event({ type: "response.output_text.delta", delta: "OK" }) +
      event({
        type: "response.completed",
        response: { status: "completed", output: [], usage: { input_tokens: 3, output_tokens: 1 } },
      }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
async function relay(t, inference, catalog) {
  let refreshes = 0,
    sends = 0,
    catalogCalls = 0;
  const f = fixture();
  await f.store.modifyRecord("", (current) => ({
    ...current,
    payload: {
      ...current.payload,
      clientId: "fixture-client",
      subject: "fixture-account",
      hostId: "urn:uuid:fixture",
      issuer: "https://auth.openai.com",
      scopes: ["resource.invoke", "chatgpt.tokens.use.direct"],
      expires: Date.now() + 3600000,
    },
  }));
  const audits = [];
  const service = new CoreSubscription({
    store: f.store,
    token: "fixture-loopback",
    kind: "openai",
    onRequest: (audit) => audits.push(audit),
    fetch: async (url, options) => {
      if (url.endsWith("openid-configuration"))
        return Response.json({
          issuer: "https://auth.openai.com",
          authorization_endpoint: "https://auth.openai.com/authorize",
          token_endpoint: "https://auth.openai.com/token",
          jwks_uri: "https://auth.openai.com/keys",
          revocation_endpoint: "https://auth.openai.com/revoke",
        });
      if (url.endsWith("/token")) {
        refreshes++;
        return Response.json({
          token_type: "bearer",
          access_token: "next-access",
          refresh_token: "next-refresh",
          expires_in: 3600,
          scope: "resource.invoke chatgpt.tokens.use.direct",
        });
      }
      if (url.endsWith("/models"))
        return catalog
          ? catalog(++catalogCalls, options)
          : Response.json({
              models: [{ slug: "fixture-model", display_name: "Fixture", visibility: "list" }],
            });
      assert.equal(url, "https://api.openai.com/v1/responses");
      sends++;
      return inference({ sends, options });
    },
  });
  t.after(() => service.close());
  await service.discover();
  await service.ready();
  const send = () =>
    fetch(service.endpoint, {
      method: "POST",
      headers: { Authorization: "Bearer fixture-loopback", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "fixture-model", input: [], stream: true }),
    });
  return {
    service,
    send,
    audits,
    get sends() {
      return sends;
    },
    get refreshes() {
      return refreshes;
    },
  };
}

test("inference token rejection is diagnosed without automatic POST replay", async (t) => {
  const f = await relay(t, () =>
    Response.json(
      { error: { code: "invalid_token", message: "fixture-secret-text" } },
      { status: 401 },
    ),
  );
  const response = await f.send();
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "invalid_token");
  assert.equal(f.sends, 1);
  assert.equal(f.refreshes, 0);
});

for (const [status, body, state] of [
  [401, { detail: "fixture-secret-text" }, "temporarily_unavailable"],
  [
    403,
    { error: { code: "subscription_sharing_user_not_eligible", message: "fixture-secret-text" } },
    "permission_denied",
  ],
  [429, { error: { code: "subscription_sharing_usage_limit_exceeded" } }, "quota_exceeded"],
  [503, { error: { code: "subscription_sharing_usage_unavailable" } }, "temporarily_unavailable"],
])
  test(`admission ${status} preserves credentials without replay or billing fallback`, async (t) => {
    const f = await relay(t, () =>
      Response.json(body, { status, headers: { "x-request-id": "fixture-request" } }),
    );
    const response = await f.send();
    const text = await response.text();
    assert.equal(response.status, status);
    assert.equal(JSON.parse(text).error.state, state);
    assert.ok(!text.includes("fixture-secret-text") && !text.includes("fixture-access"));
    assert.equal(f.sends, 1);
    assert.equal(f.refreshes, 0);
    assert.equal((await f.service.account.status()).authenticated, true);
    assert.equal(f.audits[0].requestId, "fixture-request");
  });

test("accepted or partial response never qualifies for replay", async () => {
  const error = await responseError(
    Response.json({ id: "resp_fixture", error: { code: "invalid_token" } }, { status: 401 }),
    "admission",
  );
  assert.equal(safeRefresh(error), false);
});

test("terminal forced refresh plus failed persistence cannot revive a still-fresh old grant", async () => {
  let exchanges = 0;
  const f = fixture(async () => {
    exchanges++;
    throw Object.assign(new Error("fixture terminal"), { code: "invalid_grant" });
  });
  await f.store.modifyRecord("", (record) => ({
    ...record,
    payload: { ...record.payload, expires: Date.now() + 3600000 },
  }));
  const modify = f.store.modifyRecord.bind(f.store);
  let writes = 0;
  f.store.modifyRecord = (key, mutate) =>
    modify(key, async (current) => {
      const next = await mutate(current);
      if (++writes === 1)
        throw Object.assign(new Error("fixture disk failure"), { code: "storage_write_failed" });
      return next;
    });
  await assert.rejects(
    f.account.accessToken(undefined, { force: true, rejectedToken: "fixture-access" }),
    (error) => error.state === "storage_locked",
  );
  assert.equal(f.record.kind, "grant");
  await assert.rejects(f.account.accessToken(), (error) => error.state === "reauth_required");
  assert.equal(f.record.kind, "registration");
  assert.equal(f.record.payload.access, undefined);
  assert.equal(exchanges, 1);
  assert.equal((await f.account.status()).state, "reauth_required");
});

test("status to Core sync retains provider while refreshing or storage is locked", async () => {
  let finish;
  const wait = new Promise((resolve) => {
    finish = resolve;
  });
  const f = fixture(async (_action, { credential }) => {
    await wait;
    return { ...credential, expires: Date.now() + 3600000 };
  });
  const calls = [];
  const app = new AppProviders(
    {
      host: { sourceId: "fixture", resolve: () => ({ sourceId: "fixture" }) },
      submit: async (...args) => calls.push(args),
    },
    {},
  );
  const project = {
    client: {
      ready: true,
      request: async () => ({
        data: [{ id: "areal_openai", revision: 1, models: ["fixture-model"] }],
      }),
    },
  };
  const service = { id: "areal_openai", account: f.account, models: [], ready: async () => {} };
  const rotation = f.account.accessToken();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await f.account.status()).state, "refreshing");
  await app.syncSubscription(project, service);
  assert.deepEqual(calls, []);
  finish();
  await rotation;
  f.store.readRecord = async () => {
    throw Object.assign(new Error("fixture lock"), { code: "storage_locked" });
  };
  assert.equal((await f.account.status()).state, "storage_locked");
  await app.syncSubscription(project, service);
  assert.deepEqual(calls, []);
});

test("Core sync removes subscription only on explicit sign-out or confirmed empty ready catalog", async () => {
  const calls = [];
  const app = new AppProviders(
    {
      host: { sourceId: "fixture", resolve: () => ({ sourceId: "fixture" }) },
      submit: async (_project, method) => calls.push(method),
    },
    {},
  );
  const project = {
    client: { ready: true, request: async () => ({ data: [{ id: "areal_openai", revision: 1 }] }) },
  };
  for (const status of [
    { state: "signed_out", authenticated: false },
    { state: "ready", authenticated: true, models: [] },
  ]) {
    const { account } = fixture();
    account.status = async () => status;
    await app.syncSubscription(project, {
      id: "areal_openai",
      account,
    });
    await account.close();
  }
  assert.deepEqual(calls, ["areal/provider/remove", "areal/provider/remove"]);
});

test("partial SSE followed by transport failure is not replayed or billed elsewhere", async (t) => {
  const f = await relay(
    t,
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                event({ type: "response.output_text.delta", delta: "partial fixture" }),
              ),
            );
            setTimeout(() => controller.error(new Error("fixture stream disconnect")), 25);
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  );
  const response = await f.send();
  assert.equal(response.status, 200);
  await assert.rejects(response.text());
  assert.equal(f.sends, 1);
  assert.equal(f.refreshes, 0);
});

test("stream EOF alone is not accepted as a successful connection probe", async (t) => {
  const f = await relay(
    t,
    () =>
      new Response(event({ type: "response.output_text.delta", delta: "partial fixture" }), {
        headers: { "Content-Type": "text/event-stream" },
      }),
  );
  await assert.rejects(f.service.probe("fixture-model"), /未完成/);
  assert.equal(f.sends, 1);
  assert.equal(f.refreshes, 0);
  assert.equal(f.audits[0].outcome, "forwarded");
});

for (const recover of [true, false])
  test(`catalog GET refreshes once and ${recover ? "recovers" : "stops on second 401"}`, async (t) => {
    let calls = 0;
    const models = () => Response.json({ models: [{ slug: "fixture-model", visibility: "list" }] });
    const f = await relay(
      t,
      () => successStream(),
      () => {
        calls++;
        return calls === 1 || (recover && calls === 3)
          ? models()
          : Response.json({ error: { code: "invalid_token" } }, { status: 401 });
      },
    );
    f.service.catalogExpires = 0;
    if (f.service.catalog) f.service.catalog.expiresAt = 0;
    if (recover) {
      await f.service.discover({ force: true });
      const response = await f.send();
      assert.equal(response.status, 200);
      assert.match(await response.text(), /input_tokens/);
    } else {
      await assert.rejects(f.service.discover({ force: true }));
      assert.deepEqual(f.service.models, []);
    }
    assert.equal(calls, 3);
    assert.equal(f.refreshes, 1);
    assert.equal(f.sends, recover ? 1 : 0);
  });

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));
const catalogResponse = (id = "fixture-model") =>
  Response.json({
    models: [{ slug: id, display_name: "Fixture", visibility: "list" }],
  });

async function startupSubscription(t, { catalog, refresh, expired = false } = {}) {
  const f = fixture();
  await f.store.modifyRecord("", (current) => ({
    ...current,
    payload: {
      ...current.payload,
      clientId: "fixture-client",
      subject: "fixture-account",
      hostId: "urn:uuid:fixture",
      issuer: "https://auth.openai.com",
      scopes: ["resource.invoke", "chatgpt.tokens.use.direct"],
      expires: expired ? 0 : Date.now() + 3600000,
    },
  }));
  const home = await mkdtemp(join(tmpdir(), "areal-subscription-startup-"));
  await writeFile(join(home, "openai-subscription.json"), JSON.stringify({ secret: "synthetic" }));
  let gets = 0,
    exchanges = 0;
  const service = new CoreSubscription({
    store: f.store,
    token: "fixture-loopback",
    kind: "openai",
    fetch: async (url, options) => {
      if (url.endsWith("openid-configuration"))
        return Response.json({
          issuer: "https://auth.openai.com",
          authorization_endpoint: "https://auth.openai.com/authorize",
          token_endpoint: "https://auth.openai.com/token",
          jwks_uri: "https://auth.openai.com/keys",
          revocation_endpoint: "https://auth.openai.com/revoke",
        });
      if (url.endsWith("/token")) {
        exchanges++;
        await refresh?.(options);
        return Response.json({
          token_type: "bearer",
          access_token: "next-access",
          refresh_token: "next-refresh",
          expires_in: 3600,
          scope: "resource.invoke chatgpt.tokens.use.direct",
        });
      }
      assert.equal(url, "https://api.openai.com/v1/models");
      return catalog ? catalog(++gets, options) : (gets++, catalogResponse());
    },
  });
  const mutations = [];
  let provider = { id: "areal_openai", revision: 7, models: ["old-model"] };
  const backend = {
    host: { sourceId: "fixture", resolve: () => ({ sourceId: "fixture" }) },
    home,
    projects: new Map(),
    onChange() {},
    save: async (name, value) => writeFile(join(home, name), JSON.stringify(value)),
    submit: async (_project, method, params) => {
      mutations.push({ method, params });
      assert.equal(method, "areal/provider/upsert");
      provider = { ...params.provider, revision: provider.revision + 1 };
      return provider;
    },
  };
  const app = new AppProviders(backend, {});
  app.openai = async () => service;
  app.openaiPromise = Promise.resolve(service);
  const project = {
    id: "fixture",
    client: {
      ready: true,
      request: async (method) => {
        if (method === "areal/model/list") return { data: service.models };
        assert.equal(method, "areal/provider/list");
        await result.beforeRead?.();
        return { data: [provider] };
      },
    },
  };
  backend.projects.set(project.id, project);
  await app.readSubscription(service);
  const result = {
    app,
    service,
    project,
    mutations,
    get gets() {
      return gets;
    },
    get exchanges() {
      return exchanges;
    },
    settled: async () => {
      await turn();
      await Promise.allSettled(service.account.active);
    },
  };
  t.after(async () => {
    await app.close();
    await rm(home, { recursive: true, force: true });
  });
  return result;
}

test("startup prepares the real catalog before Core sync and waits before upsert", async (t) => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const f = await startupSubscription(t, {
    catalog: async () => {
      await gate.promise;
      return catalogResponse();
    },
  });
  await f.app.prepare();
  await turn();
  assert.equal(f.gets, 1, "prepare starts the catalog while Core may still be launching");
  assert.equal(f.service.server.listening, true);
  const applied = f.app.syncSubscription(f.project, f.service);
  await turn();
  assert.deepEqual(f.mutations, []);
  gate.resolve();
  await applied;
  assert.equal(f.gets, 1);
  assert.deepEqual(f.mutations, [
    {
      method: "areal/provider/upsert",
      params: {
        expectedRevision: 7,
        provider: {
          id: "areal_openai",
          revision: 7,
          protocol: "responses",
          endpoint: f.service.endpoint,
          credentialRef: "areal_openai",
          contextSource: "account",
          models: ["fixture-model"],
          parameters: {},
        },
      },
    },
  ]);
});

test("concurrent prepares join full status through OAuth refresh", async (t) => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const f = await startupSubscription(t, { expired: true, refresh: () => gate.promise });
  await f.app.prepare();
  await turn();
  assert.equal(f.exchanges, 1);
  await f.app.prepare();
  const applied = f.app.syncSubscription(f.project, f.service);
  await turn();
  assert.deepEqual(f.mutations, []);
  gate.resolve();
  await applied;
  assert.equal(f.exchanges, 1);
  assert.equal(f.gets, 1);
  assert.deepEqual(
    f.mutations.map(({ method, params }) => [method, params.provider.models]),
    [["areal/provider/upsert", ["fixture-model"]]],
  );
});

test("fast failed startup catalog is consumed once and explicit later status retries", async (t) => {
  const f = await startupSubscription(t, {
    catalog: (call) =>
      call === 1
        ? Response.json({ error: { code: "server_error" } }, { status: 503 })
        : catalogResponse(),
  });
  await f.app.prepare();
  await f.settled();
  assert.equal(f.gets, 1);
  await f.app.syncSubscription(f.project, f.service);
  assert.equal(f.gets, 1, "automatic consume retains the first failure without another GET");
  assert.deepEqual(f.mutations, []);
  await f.app.chatgpt({ operation: "status" });
  await f.settled();
  assert.equal(f.app.subscription.state, "ready");
  assert.equal(f.gets, 2);
  await f.app.syncSubscription(f.project, f.service);
  assert.deepEqual(
    f.mutations.map(({ method }) => method),
    ["areal/provider/upsert"],
  );
});

for (const stage of ["provider read", "local ready"])
  for (const change of ["revision", "close"])
    test(`account ${change} during ${stage} cannot upsert or remove stale startup status`, async (t) => {
      const f = await startupSubscription(t);
      await f.app.prepare();
      await f.settled();
      const invalidate = () =>
        change === "revision" ? f.service.account.changed() : f.service.account.close();
      if (stage === "provider read") f.beforeRead = invalidate;
      else {
        const ready = f.service.ready.bind(f.service);
        f.service.ready = async () => {
          await ready();
          await invalidate();
        };
      }
      await f.app.syncSubscription(f.project, f.service);
      assert.equal(f.gets, 1);
      assert.deepEqual(f.mutations, []);
    });

test("expired prepared ready catalog is refreshed before Core upsert", async (t) => {
  const f = await startupSubscription(t, {
    catalog: (call) => catalogResponse(call === 1 ? "old-model" : "new-model"),
  });
  await f.app.prepare();
  await f.settled();
  assert.equal(f.gets, 1);
  f.service.catalog.expiresAt = 0;
  await f.app.syncSubscription(f.project, f.service);
  assert.equal(f.gets, 2);
  assert.deepEqual(
    f.mutations.map(({ params }) => params.provider.models),
    [["new-model"]],
  );
});

test("a forced catalog replacement cannot restore the prepared models array", async (t) => {
  const f = await startupSubscription(t, {
    catalog: (call) => catalogResponse(call === 1 ? "old-model" : "new-model"),
  });
  await f.app.prepare();
  await f.settled();
  assert.equal(f.gets, 1);
  await f.service.discover({ force: true });
  await f.app.syncSubscription(f.project, f.service);
  assert.equal(f.gets, 2);
  assert.deepEqual(
    f.mutations.map(({ params }) => params.provider.models),
    [["new-model"]],
  );
});

test("admission failure after preparation retains the existing Core provider", async (t) => {
  const f = await startupSubscription(t);
  await f.app.prepare();
  await f.settled();
  assert.equal(f.gets, 1);
  f.service.account.fail(
    Object.assign(new Error("fixture denied"), {
      code: "subscription_sharing_usage_limit_exceeded",
    }),
    "admission",
  );
  await f.app.syncSubscription(f.project, f.service);
  assert.deepEqual(f.mutations, []);
  assert.equal(f.gets, 2);
});

for (const change of ["admission failure", "refresh starting", "refresh completing"])
  test(`${change} during account directory read cannot reuse stale prepared status`, async (t) => {
    const directoryGate = deferred(),
      directoryEntered = deferred(),
      refreshGate = deferred();
    t.after(() => {
      directoryGate.resolve();
      refreshGate.resolve();
    });
    const f = await startupSubscription(t, { refresh: () => refreshGate.promise });
    const account = f.service.account;
    const publicDirectory = account.directory.public.bind(account.directory);
    let held = false;
    account.directory.public = async () => {
      if (!held) {
        held = true;
        directoryEntered.resolve();
        await directoryGate.promise;
      }
      return publicDirectory();
    };
    let refreshing;
    if (change === "refresh completing") {
      refreshing = account.accessToken(undefined, { force: true });
      await turn();
      assert.equal(f.exchanges, 1);
    }
    await f.app.prepare();
    await directoryEntered.promise;
    if (change === "admission failure") {
      account.fail(
        Object.assign(new Error("fixture denied"), {
          code: "subscription_sharing_usage_limit_exceeded",
        }),
        "admission",
      );
    } else if (change === "refresh starting") {
      refreshing = account.accessToken(undefined, { force: true });
      await turn();
      assert.equal(f.exchanges, 1);
    } else {
      refreshGate.resolve();
      assert.equal(await refreshing, "next-access");
    }
    directoryGate.resolve();
    await f.app.syncSubscription(f.project, f.service);
    if (change === "refresh completing") {
      assert.deepEqual(
        f.mutations.map(({ method, params }) => [method, params.provider.models]),
        [["areal/provider/upsert", ["fixture-model"]]],
      );
    } else {
      assert.deepEqual(f.mutations, []);
      if (refreshing) {
        refreshGate.resolve();
        assert.equal(await refreshing, "next-access");
      }
    }
  });

test("nonready preparation expires and a later Core sync retries the catalog", async (t) => {
  const f = await startupSubscription(t, {
    catalog: (call) =>
      call === 1
        ? Response.json({ error: { code: "server_error" } }, { status: 503 })
        : catalogResponse(),
  });
  await f.app.prepare();
  await f.settled();
  assert.equal(f.gets, 1);
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 30_001);
  await f.app.syncSubscription(f.project, f.service);
  assert.equal(f.gets, 2);
  assert.deepEqual(
    f.mutations.map(({ method }) => method),
    ["areal/provider/upsert"],
  );
});

test("close aborts real prepared catalog work without an unhandled rejection", async (t) => {
  let aborted = false;
  const f = await startupSubscription(t, {
    catalog: (_call, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  });
  const unhandled = [];
  const capture = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", capture);
  t.after(() => process.off("unhandledRejection", capture));
  await f.app.prepare();
  await turn();
  assert.equal(f.gets, 1);
  await f.app.close();
  await turn();
  assert.equal(aborted, true);
  assert.equal(f.service.account.active.size, 0);
  assert.deepEqual(unhandled, []);
  assert.deepEqual(f.mutations, []);
});

test("unconsumed rejected status is handled when launch stops before sync", async (t) => {
  const f = await startupSubscription(t);
  let statuses = 0;
  f.service.account.status = async () => {
    statuses++;
    throw new Error("synthetic status rejection");
  };
  const unhandled = [];
  const capture = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", capture);
  t.after(() => process.off("unhandledRejection", capture));
  await f.app.prepare();
  await turn();
  assert.equal(statuses, 1);
  await f.app.close();
  assert.deepEqual(unhandled, []);
  assert.deepEqual(f.mutations, []);
});

test("status returns local account immediately while one shared background catalog read is held", async (t) => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const f = await startupSubscription(t, {
    catalog: async () => {
      await gate.promise;
      return catalogResponse();
    },
  });
  const status = await f.app.chatgpt({ operation: "status" });
  assert.equal(status.authenticated, true);
  assert.equal(status.availability, "checking");
  await turn();
  assert.equal(f.gets, 1);
  assert.equal((await f.app.chatgpt({ operation: "status" })).refreshing, true);
  assert.deepEqual(f.mutations, []);
  gate.resolve();
  await f.settled();
  assert.equal(f.app.subscription.refreshing, false);
  assert.equal(f.app.subscription.availability, "available");
  assert.deepEqual(
    f.app.subscription.models.map((model) => model.id),
    ["fixture-model"],
  );
  assert.equal(f.gets, 1);
});

test("public catalog restores without network and is isolated by registration identity and logout", async (t) => {
  const f = await startupSubscription(t);
  await f.app.prepare();
  await f.settled();
  const filename = join(f.app.backend.home, "subscription-catalog.json");
  const saved = JSON.parse(await readFile(filename, "utf8"));
  assert.deepEqual(saved.models, [{ id: "fixture-model", name: "Fixture", source: "account" }]);
  assert(!JSON.stringify(saved).includes("fixture-access"));
  assert(!JSON.stringify(saved).includes("fixture-refresh"));
  const reopened = new AppProviders(f.app.backend, {});
  await reopened.readSubscription(f.service, true);
  assert.equal(reopened.subscription.authenticated, true);
  assert.equal(reopened.subscription.availability, "checking");
  assert.deepEqual(reopened.subscription.models, saved.models);
  assert.equal(f.gets, 1);
  await f.service.account.store.modifyRecord("", (current) => ({
    ...current,
    payload: { ...current.payload, clientId: "new-registration" },
  }));
  const otherRegistration = new AppProviders(f.app.backend, {});
  await otherRegistration.readSubscription(f.service, true);
  assert.deepEqual(otherRegistration.subscription.models, []);
  await f.service.account.store.modifyRecord("", (current) => ({
    kind: "registration",
    payload: {
      hostId: current.payload.hostId,
      clientId: current.payload.clientId,
      subject: current.payload.subject,
      issuer: current.payload.issuer,
    },
  }));
  await reopened.readSubscription(f.service);
  assert.equal(reopened.subscription.authenticated, false);
  assert.equal(reopened.subscription.availability, "unavailable");
  assert.deepEqual(reopened.subscription.models, []);
  assert.deepEqual(JSON.parse(await readFile(filename, "utf8")).models, []);
});

test("temporary secure-storage lock preserves the authenticated group and public catalog", async (t) => {
  const f = await startupSubscription(t);
  await f.app.prepare();
  await f.settled();
  const cached = f.app.subscription.models;
  const status = f.service.account.status.bind(f.service.account);
  f.service.account.status = async () => ({
    authenticated: false,
    state: "storage_locked",
    email: null,
    planType: null,
    modelError: null,
    models: [],
    diagnostic: null,
    login: null,
    error: "Locked",
  });
  await f.app.chatgpt({ operation: "status" });
  await f.settled();
  assert.equal(f.app.subscription.state, "storage_locked");
  assert.equal(f.app.subscription.authenticated, true);
  assert.deepEqual(f.app.subscription.models, cached);
  f.service.account.status = status;
  await f.app.chatgpt({ operation: "status" });
  await f.settled();
  assert.equal(f.app.subscription.authenticated, true);
  assert.equal(f.app.subscription.availability, "available");
  assert.deepEqual(f.app.subscription.models, cached);
});
