import test from "node:test";
import assert from "node:assert/strict";
import {
  discoveredModels,
  subscriptionProjection,
  connectionBilling,
} from "../renderer/src/settings/provider-ui-state.js";

test("temporary or unreadable subscription status never presents a login-expired action", () => {
  for (const state of ["refreshing", "temporarily_unavailable", "storage_locked"]) {
    const projection = subscriptionProjection({ state, authenticated: false, models: [] });
    assert.equal(projection.temporary, true);
    assert.equal(projection.canSignIn, false);
    assert.equal(projection.canTest, false);
  }
});
test("only signed-out or confirmed terminal states offer sign-in; permission and quota stop tests", () => {
  for (const state of ["signed_out", "reauth_required"])
    assert.equal(subscriptionProjection({ state }).canSignIn, true);
  for (const state of ["permission_denied", "quota_exceeded"]) {
    const projection = subscriptionProjection({
      state,
      authenticated: true,
      models: [{ id: "fixture" }],
    });
    assert.equal(projection.canSignIn, false);
    assert.equal(projection.canTest, false);
  }
  assert.equal(
    subscriptionProjection({ state: "ready", authenticated: true, models: [{ id: "fixture" }] })
      .canTest,
    true,
  );
  assert.equal(subscriptionProjection({ state: "unknown", authenticated: true }).canTest, false);
});
test("API billing and custom-service billing are explicitly distinguished", () => {
  assert.match(connectionBilling({ connection: { billing: "api" } }), /与 ChatGPT 订阅独立/);
  assert.equal(
    connectionBilling({ kind: "compatible", authentication: "none" }),
    "计费由服务商决定",
  );
});

import { AppProviders } from "../app/src/core/providers.cjs";
test("busy provider application rejects before changing configuration or restarting projects", async () => {
  let restarted = false;
  const backend = {
    providerUpdating: false,
    resourcesUpdating: false,
    activeCommands: 0,
    starting: new Set(),
    hasWork: () => true,
    restartProject: async () => {
      restarted = true;
    },
  };
  const app = new AppProviders(backend, {});
  const saved = { revision: "fixture", data: [{ id: "fixture" }] };
  app.config.value = saved;
  app.config.current = async () => assert.fail("busy operation must not read/write configuration");
  await assert.rejects(app.apply({ expectedRevision: "fixture" }), /等待任务/);
  assert.equal(app.config.value, saved);
  assert.equal(restarted, false);
  assert.equal(backend.providerUpdating, false);
});

import { newConnectionDraft } from "../renderer/src/settings/provider-ui-state.js";
test("service definition identity never becomes a saved connection identity", () => {
  const definition = {
    id: "fixture-definition",
    name: "Fixture",
    models: [{ id: "fixture-model" }],
  };
  const draft = newConnectionDraft(definition, "apiKey", "revision");
  assert.deepEqual(draft.models[0].capabilities, { tools: true, vision: false, reasoning: true });
  assert.equal(
    definition.models[0].capabilities,
    undefined,
    "defaults must not mutate the shared provider template",
  );
  assert.equal(draft.id, undefined);
  assert.equal(draft.definitionId, "fixture-definition");
  assert.equal(
    newConnectionDraft({ definitionId: "fixture-definition", models: [] }, "none", "revision")
      .definitionId,
    "fixture-definition",
  );
  draft.models[0].id = "edited";
  assert.equal(definition.models[0].id, "fixture-model");
});

test("new provider models retain declared capabilities and provider/model effort defaults", () => {
  const capabilities = {
    tools: true,
    vision: true,
    reasoning: true,
    reasoningEffortOptions: ["low", "max"],
  };
  const definition = {
    parameters: { reasoningEffort: "max" },
    models: [
      { id: "known", capabilities, parameters: { reasoningEffort: "low" } },
      { id: "off", capabilities: { tools: true, vision: false, reasoning: false } },
      { id: "unknown" },
    ],
  };
  const draft = newConnectionDraft(definition, "none", "revision");
  assert.deepEqual(draft.parameters, { reasoningEffort: "max" });
  assert.deepEqual(draft.models[0].capabilities, capabilities);
  assert.equal(draft.models[0].parameters.reasoningEffort, "low");
  assert.equal(draft.models[1].capabilities.reasoning, false);
  assert.deepEqual(draft.models[2].capabilities.reasoningEffortOptions, undefined);
  assert.equal(
    draft.models[2].parameters?.reasoningEffort,
    undefined,
    "An inherited supplier default must not become a forced per-model override",
  );
  assert.equal(definition.models[2].capabilities, undefined);
});

test("discovered model limits remain reported facts, not user parameter overrides", () => {
  const provider = {
    models: [{ id: "saved", parameters: { contextWindowTokens: 100 } }],
    parameters: { contextWindowTokens: 200, reasoningEffort: "high" },
  };
  const facts = { saved: { contextWindowTokens: 300 }, reported: { contextWindowTokens: 400 } };
  const before = structuredClone(provider);
  const added = discoveredModels(provider, ["saved", "reported", "unknown"], facts);
  assert.deepEqual(
    added.map(({ id }) => id),
    ["reported", "unknown"],
  );
  assert.equal(added[0].reportedContextWindowTokens, 400);
  assert.equal(Object.hasOwn(added[1], "reportedContextWindowTokens"), false);
  for (const model of added) {
    assert.deepEqual(model.parameters, {});
    assert.equal(model.enabled, true);
    assert.deepEqual(model.capabilities, { tools: true, vision: false, reasoning: true });
  }
  assert.deepEqual(provider, before);
  assert.equal(facts.reported.contextWindowTokens, 400);
  assert.deepEqual(discoveredModels(provider, ["unknown"])[0].parameters, {});
  assert.deepEqual(discoveredModels(provider, ["unknown"], null)[0].parameters, {});
});
