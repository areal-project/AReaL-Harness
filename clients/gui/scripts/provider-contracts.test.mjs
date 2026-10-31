import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { definitions, connectionMetadata } from "../packages/provider-config/connections.cjs";
import { ModelCatalog } from "../packages/chatgpt-provider/catalog.js";
import {
  openaiRequest,
  subscriptionRequest,
  subscriptionModelHints,
  protocolAdapters,
} from "../packages/chatgpt-provider/adapters.js";
import { providerError } from "../packages/chatgpt-provider/errors.js";

function session() {
  const value = new EventEmitter();
  Object.assign(value, {
    revision: 0,
    busy: false,
    lifetime: new AbortController(),
    accessToken: async () => "fixture-access",
    fail(error, phase) {
      this.failure = providerError(error, phase);
      return this.failure;
    },
  });
  return value;
}
test("one shared definition supplies API, custom gateway and SIWC connection metadata", () => {
  assert.equal(new Set(definitions.map((d) => d.id)).size, definitions.length);
  for (const d of definitions)
    assert.ok(
      d.authMethods.length &&
        d.protocols.includes(d.protocol) &&
        d.discovery.strategy &&
        d.configurationSchema &&
        d.capabilityDefaults,
    );
  const api = connectionMetadata({
    id: "api",
    endpoint: "https://api.openai.com/v1/responses",
    protocol: "responses",
    apiKeyEnv: "FIXTURE_KEY",
  });
  assert.equal(api.definitionId, "openai-api");
  assert.equal(api.billing, "api");
  const gateway = connectionMetadata({
    id: "gateway",
    endpoint: "http://127.0.0.1:1234/custom/chat/completions",
    protocol: "chat-completions",
  });
  assert.equal(gateway.definitionId, "custom-compatible");
  assert.equal(gateway.authentication, "none");
  assert.equal(definitions.find((d) => d.id === "chatgpt-siwc").billing, "subscription");
});
test("account catalog shares fetch, retains order, filters hidden models and tracks freshness", async () => {
  let calls = 0,
    now = 1000;
  const account = session();
  const catalog = new ModelCatalog(
    account,
    async () => {
      calls++;
      await new Promise((resolve) => setImmediate(resolve));
      return Response.json({
        models: [
          {
            slug: "b",
            visibility: "list",
            display_name: "B",
            context_window: 500000,
            max_context_window: 872000,
            supported_reasoning_levels: [
              { effort: "low" },
              { effort: "max" },
              { effort: "max" },
              { effort: "private-unknown" },
            ],
          },
          { slug: "hidden", visibility: "hide" },
          { slug: "a", visibility: "list", context_window: -1 },
          { slug: "b", visibility: "list" },
        ],
      });
    },
    { now: () => now, ttlMs: 100 },
  );
  const results = await Promise.all(Array.from({ length: 5 }, () => catalog.discover()));
  assert.equal(calls, 1);
  assert.deepEqual(
    results[0].map((m) => m.id),
    ["b", "a"],
  );
  assert.deepEqual(results[0][0].parameters, { contextWindowTokens: 500000 });
  assert.deepEqual(results[0][0].reasoningEffortOptions, ["low", "max"]);
  assert.equal(results[0][1].reasoningEffortOptions, undefined);
  assert.equal(results[0][1].parameters?.contextWindowTokens, undefined);
  assert.equal(catalog.metadata().source, "account");
  assert.equal(catalog.metadata().fresh, true);
  now += 101;
  assert.equal(catalog.metadata().fresh, false);
  await catalog.discover();
  assert.equal(calls, 2);
});
test("failed catalog drops account choices, preserves session and supports explicit retry", async () => {
  const account = session();
  let fail = true;
  const catalog = new ModelCatalog(account, async () =>
    fail
      ? Response.json({ detail: "fixture-secret" }, { status: 503 })
      : Response.json({ models: [{ slug: "m", visibility: "list" }] }),
  );
  await assert.rejects(catalog.discover(), (error) => error.state === "temporarily_unavailable");
  assert.deepEqual(catalog.models, []);
  assert.equal(catalog.metadata().fresh, false);
  fail = false;
  await catalog.discover({ force: true });
  assert.equal(account.failure, null);
});
test("late catalog from switched account cannot overwrite new choices", async () => {
  const account = session();
  let finish;
  const first = new Promise((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  const catalog = new ModelCatalog(account, async () =>
    ++calls === 1 ? first : Response.json({ models: [{ slug: "new", visibility: "list" }] }),
  );
  const old = catalog.discover();
  await new Promise((resolve) => setImmediate(resolve));
  account.revision++;
  account.emit("changed");
  await catalog.discover();
  finish(
    Response.json({ models: [{ slug: "old", visibility: "list", use_responses_lite: true }] }),
  );
  await assert.rejects(old, (error) => error.code === "account_changed");
  assert.deepEqual(
    catalog.models.map((m) => m.id),
    ["new"],
  );
  assert.deepEqual(catalog.hintsFor("old"), {});
});
test("subscription adapter preserves explicit parallel tool control in both directions", () => {
  const request = {
    model: "fixture",
    stream: true,
    input: [],
    tools: [{ type: "function", name: "read", parameters: {} }],
  };
  for (const parallel of [true, false]) {
    assert.equal(
      subscriptionRequest({ ...request, parallel_tool_calls: parallel }).parallel_tool_calls,
      parallel,
    );
  }
  assert.equal(Object.hasOwn(subscriptionRequest(request), "parallel_tool_calls"), false);
});
test("catalog capabilities supply supported defaults while explicit request controls win", () => {
  const hints = subscriptionModelHints({
    use_responses_lite: true,
    support_verbosity: true,
    default_verbosity: "low",
  });
  assert.deepEqual(hints, { reasoningContext: "all_turns", verbosity: "low" });
  assert.ok(Object.isFrozen(hints));
  assert.deepEqual(subscriptionModelHints({ slug: "gpt-anything", default_verbosity: "low" }), {});
  assert.deepEqual(
    subscriptionModelHints({
      use_responses_lite: false,
      support_verbosity: true,
      default_verbosity: "invalid",
    }),
    {},
  );
  const request = { model: "fixture", stream: true, input: [], reasoning: { effort: "xhigh" } };
  const original = structuredClone(request);
  for (const encode of [subscriptionRequest, openaiRequest]) {
    const encoded = encode(request, hints);
    assert.deepEqual(encoded.reasoning, { effort: "xhigh", context: "all_turns" });
    assert.deepEqual(encoded.text, { verbosity: "low" });
    const explicit = encode(
      { ...request, reasoning: { context: "current_turn" }, text: { verbosity: "high" } },
      hints,
    );
    assert.deepEqual(explicit.reasoning, { context: "current_turn" });
    assert.deepEqual(explicit.text, { verbosity: "high" });
    assert.deepEqual(
      encode({ ...request, reasoning: { context: null }, text: { verbosity: null } }, hints)
        .reasoning,
      { context: null },
    );
    assert.throws(() => encode({ ...request, text: [] }, hints), /对象/);
  }
  assert.deepEqual(request, original);
  assert.equal(Object.hasOwn(subscriptionRequest(request), "text"), false);
});
test("catalog hints obey visibility, account revision and clear boundaries", async () => {
  const account = session();
  const catalog = new ModelCatalog(account, async () =>
    Response.json({
      models: [
        {
          slug: "m",
          visibility: "list",
          use_responses_lite: true,
          support_verbosity: true,
          default_verbosity: "low",
        },
        { slug: "hidden", visibility: "hide", use_responses_lite: true },
      ],
    }),
  );
  await catalog.discover();
  assert.deepEqual(catalog.models, [{ id: "m", name: "m", source: "account" }]);
  assert.deepEqual(catalog.hintsFor("m"), { reasoningContext: "all_turns", verbosity: "low" });
  assert.deepEqual(catalog.hintsFor("hidden"), {});
  account.revision++;
  account.emit("changed");
  assert.deepEqual(catalog.hintsFor("m"), {});
});
test("SIWC adapter namespaces tools and keeps call IDs, history and supported controls", () => {
  const body = {
    model: "fixture",
    stream: true,
    input: [
      { role: "system", content: "System" },
      { type: "function_call", name: "run", call_id: "call_fixture", arguments: "{}" },
      { type: "function_call_output", call_id: "call_fixture", output: "fixture" },
    ],
    tools: [{ type: "function", name: "run", parameters: {} }],
    tool_choice: { type: "function", name: "run" },
    reasoning: { effort: "low" },
    parallel_tool_calls: true,
  };
  const encoded = openaiRequest(body);
  assert.equal(encoded.store, false);
  assert.equal(encoded.stream, true);
  assert.equal(encoded.instructions, "System");
  assert.equal(encoded.input[0].call_id, "call_fixture");
  assert.equal(encoded.input[0].namespace, "areal");
  assert.equal(encoded.tools[0].type, "namespace");
  assert.deepEqual(encoded.reasoning, body.reasoning);
  assert.equal(encoded.parallel_tool_calls, true);
  assert.equal(body.input.length, 3);
  assert.equal(body.input[1].namespace, undefined);
  assert.throws(() => openaiRequest({ ...body, temperature: 0.5 }), /参数/);
  assert.deepEqual(protocolAdapters.openai.adjustments({ ...body, max_output_tokens: 1000 }), [
    "max_output_tokens:core_budget_only",
  ]);
});

import { AuthSessionDirectory } from "../packages/chatgpt-provider/sessions.js";
test("secure session directory migrates legacy grant and separates same-email registrations", async () => {
  let record = {
    kind: "grant",
    payload: {
      hostId: "urn:uuid:fixture",
      clientId: "client-one",
      email: "same@fixture.invalid",
      access: "fixture-one",
      refresh: "refresh-one",
    },
  };
  let chain = Promise.resolve();
  const store = {
    readRecord: async () => structuredClone(record),
    modifyRecord(_key, mutate) {
      const work = chain.then(async () => {
        record = await mutate(structuredClone(record));
        return structuredClone(record);
      });
      chain = work.catch(() => {});
      return work;
    },
  };
  const directory = new AuthSessionDirectory(store);
  assert.equal((await directory.view().readRecord()).payload.access, "fixture-one");
  const id = await directory.add();
  assert.equal((await directory.public()).activeAccountId, "primary");
  assert.equal((await directory.view(id).readRecord()).payload.hostId, "urn:uuid:fixture");
  await directory.view(id).modifyRecord("", () => ({
    kind: "grant",
    payload: {
      clientId: "client-two",
      email: "same@fixture.invalid",
      access: "fixture-two",
      refresh: "refresh-two",
    },
  }));
  await directory.activate(id);
  assert.equal((await directory.view().readRecord()).payload.access, "fixture-two");
  assert.equal((await directory.view("primary").readRecord()).payload.clientId, "client-one");
  const publicState = JSON.stringify(await directory.public());
  assert.ok(
    !publicState.includes("fixture-one") &&
      !publicState.includes("refresh-one") &&
      !publicState.includes("client-two"),
  );
  assert.equal((await directory.public()).accounts.length, 2);
  const restarted = new AuthSessionDirectory(store);
  assert.equal((await restarted.public()).activeAccountId, id);
});

import { OpenAIAccount } from "../packages/chatgpt-provider/openai.js";
test("switching saved sessions validates each grant and cannot combine client IDs and tokens", async () => {
  const grant = (clientId) => ({
    kind: "grant",
    payload: {
      type: "oauth",
      hostId: "urn:uuid:fixture",
      clientId,
      subject: "subject-" + clientId,
      accountId: "subject-" + clientId,
      issuer: "https://auth.openai.com",
      access: "access-" + clientId,
      refresh: "refresh-" + clientId,
      expires: Date.now() + 3600000,
      scopes: ["resource.invoke", "chatgpt.tokens.use.direct"],
    },
  });
  let record = grant("one");
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
  };
  const account = new OpenAIAccount(store, {
    fetch: async () => assert.fail("fresh sessions do not need OAuth"),
  });
  const second = await account.directory.add();
  await account.directory.view(second).modifyRecord("", () => grant("two"));
  await account.selectAccount(second);
  assert.equal(await account.accessToken(), "access-two");
  await account.selectAccount("primary");
  assert.equal(await account.accessToken(), "access-one");
  await assert.rejects(
    account.selectAccount("missing"),
    (error) => error.state === "reauth_required",
  );
  assert.equal((await account.directory.public()).activeAccountId, "primary");
  await account.close();
});

import { createRequire } from "node:module";
const { generateKeyPair, exportJWK, SignJWT } = await import(
  createRequire(new URL("../packages/chatgpt-provider/package.json", import.meta.url)).resolve(
    "jose",
  )
);
test("fixture SIWC validates new identity before activation and keeps busy-host authorization inactive", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const key = await exportJWK(publicKey);
  key.kid = "fixture-key";
  let nonce,
    record = {
      kind: "grant",
      payload: {
        type: "oauth",
        hostId: "urn:uuid:fixture",
        clientId: "fixture-old",
        subject: "fixture-old-user",
        accountId: "fixture-old-user",
        issuer: "https://auth.openai.com",
        email: "same@fixture.invalid",
        access: "fixture-old-access",
        refresh: "fixture-old-refresh",
        expires: Date.now() + 3600000,
        scopes: ["resource.invoke", "chatgpt.tokens.use.direct"],
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
  };
  const account = new OpenAIAccount(store, {
    fetch: async (url, options) => {
      assert.equal(new URL(url).origin, "https://auth.openai.com");
      if (url.endsWith("openid-configuration"))
        return Response.json({
          issuer: "https://auth.openai.com",
          authorization_endpoint: "https://auth.openai.com/authorize",
          token_endpoint: "https://auth.openai.com/token",
          jwks_uri: "https://auth.openai.com/keys",
          revocation_endpoint: "https://auth.openai.com/revoke",
        });
      if (url.endsWith("/keys")) return Response.json({ keys: [key] });
      assert.ok(url.endsWith("/token"));
      assert.equal(options.body.get("client_id"), "fixture-issued");
      const idToken = await new SignJWT({
        sub: "fixture-new-user",
        nonce,
        email: "same@fixture.invalid",
      })
        .setProtectedHeader({ alg: "RS256", kid: "fixture-key" })
        .setIssuer("https://auth.openai.com")
        .setAudience("fixture-issued")
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(privateKey);
      return Response.json({
        token_type: "bearer",
        access_token: "fixture-new-access",
        refresh_token: "fixture-new-refresh",
        id_token: idToken,
        expires_in: 3600,
        scope: "resource.invoke chatgpt.tokens.use.direct",
      });
    },
  });
  account.activateAuthorized = async () => false;
  try {
    const login = await account.begin({ newAccount: true });
    const url = new URL(login.authUrl);
    nonce = url.searchParams.get("nonce");
    assert.equal(url.searchParams.get("client_id"), "dynamic_agent_client");
    assert.equal(url.searchParams.get("ext_agent_host_id"), "urn:uuid:fixture");
    assert.ok(url.searchParams.get("scope").includes("chatgpt.tokens.use.direct"));
    assert.equal((await account.directory.public()).activeAccountId, "primary");
    const completion = account.attempt.done;
    const callback = new URL(url.searchParams.get("redirect_uri"));
    callback.search = new URLSearchParams({
      state: url.searchParams.get("state"),
      code: "fixture-code",
      client_id: "fixture-issued",
    }).toString();
    const response = await fetch(callback);
    assert.equal(response.status, 200);
    await completion;
    const status = await account.directory.public();
    assert.equal(status.activeAccountId, "primary");
    const saved = status.accounts.find((entry) => entry.id !== "primary");
    assert.equal(saved.state, "saved");
    assert.equal(saved.email, "same@fixture.invalid");
    assert.equal(await account.accessToken(), "fixture-old-access");
    await account.selectAccount(saved.id);
    assert.equal(await account.accessToken(), "fixture-new-access");
    assert.equal(
      (await account.directory.view("primary").readRecord()).payload.clientId,
      "fixture-old",
    );
  } finally {
    await account.close();
  }
});

test("remembered model and effort survive checking or unavailable catalog entries", async () => {
  const { resolveNewConversationModel, resolveModelEffort } =
    await import("../packages/workbench/client/model-selection.js");
  const last = {
    model: { providerId: "areal_openai", modelId: "chosen" },
    modelId: "chosen",
    reasoningEffort: "high",
  };
  const fallback = { providerId: "local", modelId: "default", isDefault: true };
  for (const models of [
    [],
    [
      { providerId: "areal_openai", modelId: "chosen", available: false, availability: "checking" },
      fallback,
    ],
  ]) {
    const selected = resolveNewConversationModel(models, last);
    assert.equal(selected.candidate.modelId, "chosen");
    assert.equal(selected.rememberedEffort, "high");
    assert.equal(resolveModelEffort(selected.candidate, selected.rememberedEffort), "high");
    assert.equal(selected.notice, undefined);
  }
  assert.equal(resolveNewConversationModel([], last, true).candidate, undefined);
  assert.equal(resolveNewConversationModel([fallback], last, false).candidate.modelId, "chosen");
  const confirmed = resolveNewConversationModel([fallback], last);
  assert.equal(confirmed.candidate.modelId, "default");
  assert.equal(confirmed.notice, "model-unavailable");
});

test("known official effort rules do not apply to a custom gateway with the same model name", async () => {
  const { resolvedModelCapabilities } = await import("../packages/provider-config/connections.cjs");
  const model = { id: "gpt-6.1-sol" };
  assert.deepEqual(
    resolvedModelCapabilities({ endpoint: "https://api.openai.com/v1/responses" }, model)
      .reasoningEffortOptions,
    ["low", "medium", "high", "xhigh", "max"],
  );
  for (const endpoint of [
    "http://api.openai.com/v1/responses",
    "https://api.openai.com:8443/v1/responses",
    "https://gateway.invalid/v1/responses",
  ])
    assert.equal(resolvedModelCapabilities({ endpoint }, model), undefined);
  const custom = {
    ...model,
    capabilities: {
      tools: true,
      vision: false,
      reasoning: true,
      reasoningEffortOptions: ["minimal"],
    },
  };
  assert.deepEqual(
    resolvedModelCapabilities({ endpoint: "https://gateway.invalid/v1/responses" }, custom)
      .reasoningEffortOptions,
    ["minimal"],
  );
  assert.deepEqual(
    resolvedModelCapabilities({ endpoint: "https://api.openai.com/v1/responses" }, custom)
      .reasoningEffortOptions,
    [],
  );
});

test("effort selection preserves service default and distinguishes unknown from explicitly empty capabilities", async () => {
  const { resolveNewConversationModel, resolveModelEffort } =
    await import("../packages/workbench/client/model-selection.js");
  const base = {
    providerId: "custom",
    modelId: "opaque",
    isDefault: true,
    reasoningEffortOptions: [],
  };
  const explicit = {
    ...base,
    capabilities: { reasoning: true, reasoningEffortOptions: [] },
    parameters: { reasoningEffort: "minimal" },
  };
  assert.equal(
    resolveModelEffort({ ...base, reasoningEffortOptions: ["low", "medium"] }),
    undefined,
  );
  assert.equal(resolveModelEffort(base, "minimal"), "minimal");
  assert.equal(resolveModelEffort(explicit, "minimal"), "default");
  assert.equal(resolveModelEffort(explicit, "default"), "default");
  assert.equal(
    resolveModelEffort({ ...base, reasoningEffortOptions: ["low", "medium"] }, "minimal"),
    "medium",
  );
  assert.equal(resolveModelEffort({ ...base, reasoningEffortOptions: ["low"] }, "minimal"), "low");
  const last = { model: base, modelId: "opaque", reasoningEffort: "minimal" };
  assert.equal(resolveNewConversationModel([explicit], last).notice, "effort-unsupported");
  const historical = resolveNewConversationModel(
    [{ ...base, reasoningEffortOptions: ["low", "medium"] }],
    last,
  );
  assert.equal(historical.notice, "effort-unsupported");
  assert.equal(resolveModelEffort(historical.candidate, historical.rememberedEffort), "medium");
  assert.equal(resolveNewConversationModel([explicit], last).rememberedEffort, "default");
  assert.equal(
    resolveNewConversationModel([explicit], { ...last, reasoningEffort: "default" })
      .rememberedEffort,
    "default",
  );
});

test("projectless catalog uses declared API and fresh account efforts without a protocol-wide fallback", async () => {
  const { ProjectlessWorkspaces } = await import("../app/src/core/projectless.cjs");
  const caps = { tools: true, vision: true, reasoning: true, reasoningEffortOptions: [] };
  const providers = {
    config: {
      current: async () => ({
        effective: { model: {} },
        credentialStates: {},
        data: [
          {
            id: "official",
            enabled: true,
            endpoint: "https://api.openai.com/v1/responses",
            parameters: {},
            models: [{ id: "gpt-6.1-sol", enabled: true, parameters: {} }],
          },
          {
            id: "custom",
            enabled: true,
            endpoint: "http://127.0.0.1/v1/responses",
            parameters: {},
            models: [
              { id: "gpt-6.1-sol", enabled: true, parameters: {} },
              {
                id: "empty",
                enabled: true,
                parameters: { reasoningEffort: "minimal" },
                capabilities: caps,
              },
            ],
          },
        ],
      }),
    },
    openaiService: {
      catalog: { metadata: () => ({ fresh: true }) },
      models: [
        { id: "account-model", reasoningEffortOptions: ["high", "max"] },
        { id: "unknown-account-model" },
      ],
    },
  };
  const result = await new ProjectlessWorkspaces({ providers }).command({ operation: "catalog" });
  assert.deepEqual(
    result.models.map((model) => model.reasoningEffortOptions),
    [["low", "medium", "high", "xhigh", "max"], [], [], ["high", "max"], []],
  );
  assert.equal(
    result.models[2].parameters.reasoningEffort,
    "minimal",
    "historical intent remains available for correction",
  );
  assert.equal(result.models[2].available, true);
});

test("subscription transports encode Fast for their endpoint and preserve Off, omission and effort", () => {
  const request = { model: "opaque-model", input: [], stream: true, reasoning: { effort: "high" } };
  for (const [encode, fastTier] of [
    [protocolAdapters.codex.encode, "fast"],
    [protocolAdapters.openai.encode, "priority"],
  ]) {
    for (const [tier, expectedTier] of [
      ["fast", fastTier],
      ["default", "default"],
    ]) {
      const encoded = encode({ ...request, service_tier: tier });
      assert.equal(encoded.service_tier, expectedTier);
      assert.deepEqual(encoded.reasoning, { effort: "high" });
      assert.equal(encoded.model, "opaque-model");
    }
    assert.equal(Object.hasOwn(encode(request), "service_tier"), false);
  }
  assert.equal(Object.hasOwn(request, "service_tier"), false);
});

test("desktop provider parameter boundary preserves supported tiers and rejects other values", async () => {
  const { modelParameters, parameters } =
    await import("../packages/workbench/client/desktop-contract/provider.cjs");
  for (const serviceTier of ["fast", "default"]) {
    assert.deepEqual(modelParameters({ serviceTier, reasoningEffort: "max" }), {
      serviceTier,
      reasoningEffort: "max",
    });
    assert.equal(parameters({ serviceTier }), true);
  }
  assert.deepEqual(modelParameters({ serviceTier: null }), {});
  assert.deepEqual(modelParameters({}), {});
  for (const serviceTier of ["priority", "auto", "turbo", true, 1, {}]) {
    assert.throws(() => modelParameters({ serviceTier }), /模型参数/);
    assert.equal(parameters({ serviceTier }), false);
  }
});

test("projectless catalog carries selected tier into named and implicit defaults", async () => {
  const { ProjectlessWorkspaces } = await import("../app/src/core/projectless.cjs");
  for (const serviceTier of ["fast", "default"]) {
    const providers = {
      config: {
        current: async () => ({
          effective: { model: { provider: "local", name: "one", service_tier: serviceTier } },
          credentialStates: {},
          data: [
            {
              id: "local",
              enabled: true,
              endpoint: "http://fixture.invalid/v1/responses",
              parameters: { serviceTier: "fast" },
              models: [{ id: "one", enabled: true, parameters: {} }],
            },
          ],
        }),
      },
    };
    const result = await new ProjectlessWorkspaces({ providers }).command({ operation: "catalog" });
    assert.equal(result.models.length, 2);
    assert.equal(result.models[0].providerId, null);
    assert.equal(result.models[0].parameters.serviceTier, serviceTier);
    assert.equal(result.models[1].parameters.serviceTier, serviceTier);
  }
});
