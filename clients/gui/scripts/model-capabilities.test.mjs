import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { modelCatalog } from "../packages/chatgpt-provider/catalog.js";
import { CoreSubscription } from "../packages/chatgpt-provider/core.js";
import { reasoningEfforts } from "../packages/workbench/client/reasoning-effort.js";
const require = createRequire(new URL("../app/package.json", import.meta.url));
const { AppProviders } = require("../app/src/core/providers.cjs");
const efforts = ["low", "medium", "high", "xhigh", "max", "ultra"];
const upstream = (slug = "fixture-sol", options = efforts) => ({
  slug,
  display_name: "Fixture Sol",
  visibility: "list",
  default_reasoning_level: "low",
  supported_reasoning_levels: options.map((effort) => ({ effort, description: effort })),
});

test("account catalog preserves ordered per-model efforts, defaults and empty capabilities", () => {
  const data = modelCatalog([
    upstream(),
    upstream("fixture-luna", efforts.slice(0, -1)),
    { slug: "plain", visibility: "list" },
    { ...upstream("hidden"), visibility: "hide" },
  ]);
  assert.deepEqual(
    data.map((m) => m.id),
    ["fixture-sol", "fixture-luna", "plain"],
  );
  assert.deepEqual(data[0].reasoningEffortOptions, efforts);
  assert.equal(data[0].defaultReasoningEffort, "low");
  assert.equal(data[1].reasoningEffortOptions.includes("ultra"), false);
  assert.deepEqual(data[2].reasoningEffortOptions, []);
  assert.throws(() => modelCatalog([{ ...upstream(), supported_reasoning_levels: "max" }]));
  assert.throws(() => modelCatalog([{ ...upstream(), default_reasoning_level: "none" }]));
});

test("discovery refreshes capabilities with unchanged model IDs and scopes in-flight requests to the account", async () => {
  let data = [upstream("fixture-sol", efforts.slice(0, -2))],
    calls = 0,
    release;
  const service = new CoreSubscription({
    kind: "openai",
    store: {},
    fetch: async () => {
      calls++;
      if (release)
        await new Promise((resolve) => {
          release.resolve = resolve;
        });
      return new Response(JSON.stringify({ models: data }));
    },
  });
  service.account.accessToken = async () => "fixture-token";
  try {
    const initial = await service.discover();
    assert.deepEqual(initial[0].reasoningEffortOptions, efforts.slice(0, -2));
    await service.discover();
    assert.equal(calls, 1);
    data = [upstream()];
    service.catalog.expiresAt = 0;
    assert.deepEqual((await service.discover())[0].reasoningEffortOptions, efforts);
    service.catalog.expiresAt = 0;
    release = {};
    const old = service.discover();
    await new Promise((resolve) => setImmediate(resolve));
    service.account.changed();
    const unblock = release.resolve;
    release = null;
    const fresh = service.discover();
    unblock();
    await assert.rejects(old, (error) => error.code === "account_changed");
    assert.deepEqual((await fresh)[0].reasoningEffortOptions, efforts);
  } finally {
    await service.close();
  }
});

test("provider sync updates same-model capabilities without rewriting accepted task snapshots", async () => {
  let existing,
    writes = 0,
    models = modelCatalog([upstream("fixture-sol", efforts.slice(0, -2))]);
  const frozen = {
    model: "fixture-sol",
    parameters: { reasoningEffort: "high" },
    providerRevision: 1,
  };
  const project = {
    configurations: { running: frozen },
    client: { request: async () => ({ data: existing ? [existing] : [] }) },
  };
  const backend = {
    submit: async (_project, method, request) => {
      assert.equal(method, "areal/provider/upsert");
      existing = structuredClone({ ...request.provider, revision: ++writes });
      existing.parameters = { temperature: null, maxOutputTokens: null, reasoningEffort: null };
      // Core 按 Rust 字段顺序序列化，JSON 对象键序不能导致空刷新持续增加版本。
      existing.modelCapabilities = Object.fromEntries(
        Object.entries(existing.modelCapabilities).map(([id, value]) => [
          id,
          {
            reasoningEffortOptions: value.reasoningEffortOptions,
            defaultReasoningEffort: value.defaultReasoningEffort,
            displayName: value.displayName,
          },
        ]),
      );
    },
  };
  const providers = new AppProviders(backend);
  const service = {
    id: "areal_openai",
    endpoint: "http://127.0.0.1:1234/responses",
    ready: async () => {},
    account: { status: async () => ({ authenticated: true, models }) },
  };
  await providers.applySubscription(project, service);
  await providers.applySubscription(project, service);
  assert.equal(writes, 1);
  models = modelCatalog([upstream()]);
  await providers.applySubscription(project, service);
  assert.equal(writes, 2);
  assert.deepEqual(existing.modelCapabilities["fixture-sol"].reasoningEffortOptions, efforts);
  assert.deepEqual(project.configurations.running, {
    model: "fixture-sol",
    parameters: { reasoningEffort: "high" },
    providerRevision: 1,
  });
  models = modelCatalog([upstream("fixture-sol", ["low", "medium"])]);
  await providers.applySubscription(project, service);
  assert.deepEqual(existing.modelCapabilities["fixture-sol"].reasoningEffortOptions, [
    "low",
    "medium",
  ]);
  service.account.status = async () => ({ authenticated: true, modelError: "offline", models: [] });
  await providers.applySubscription(project, service);
  assert.equal(writes, 3, "failed discovery must not replace the last catalog");
});

test("Core and all GUI effort editors share the same supported vocabulary", async () => {
  const source = await readFile(
    new URL("../../../core/config/src/lib.rs", import.meta.url),
    "utf8",
  );
  const values = source.match(/REASONING_EFFORTS:.*?=\s*&\[([\s\S]*?)\]/)[1];
  assert.deepEqual(
    [...values.matchAll(/"([a-z]+)"/g)].map((match) => match[1]),
    reasoningEfforts,
  );
});

test("background refresh invalidates cached capabilities every 30 seconds, coalesces work and stops on close", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const providers = new AppProviders({});
  providers.transport = { port: 0 };
  providers.openaiToken = "fixture-token";
  let release,
    calls = 0;
  try {
    const service = await providers.openai();
    providers.refreshSubscription = async (current) => {
      assert.equal(current, service);
      calls++;
      await new Promise((resolve) => {
        release = resolve;
      });
    };
    service.catalog.expiresAt = Date.now() + 60_000;
    t.mock.timers.tick(30_000);
    assert.equal(calls, 1);
    assert.equal(
      service.catalog.expiresAt,
      0,
      "timer refresh must not extend the catalog TTL by another interval",
    );
    t.mock.timers.tick(30_000);
    assert.equal(calls, 1, "an in-flight refresh must not overlap");
    release();
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(30_000);
    assert.equal(calls, 2);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    await providers.close();
    t.mock.timers.tick(30_000);
    assert.equal(calls, 2, "closed adapters must not keep polling");
  } finally {
    release?.();
    await providers.close();
    t.mock.timers.reset();
  }
});
