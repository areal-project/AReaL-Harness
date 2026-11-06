import test from "node:test";
import assert from "node:assert/strict";
import { AppProviders } from "../src/desktop/core/providers.cjs";
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

test("shared CLI project applies the saved model configuration", async () => {
  const f = fixture();
  f.backend.host.resolve = () => ({ sourceId: "cli", usesSharedModelConfig: true });
  await f.service.command(f.request);
  assert(f.calls.some(([method]) => method === applyMethod));
});
