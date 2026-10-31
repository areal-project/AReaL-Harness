import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  writeFile,
  rm,
  realpath,
  stat,
  symlink,
  utimes,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";

const require = createRequire(import.meta.url);
const { CoreBackend } = require("../app/src/core/backend.cjs");
const { SharedCoreBackend } = require("../app/src/core/service-client.cjs");
const { PROTOCOL, COMMAND_CONTRACT } = require("../app/src/core/service-protocol.cjs");
const { serviceIdentity } = require("../app/src/core/service-config.cjs");
const { WebSocketServer } = require("../app/node_modules/ws");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const fails of [false, true]) {
  test(`concurrent initialization shares control read and ${fails ? "failure" : "connection"}`, async (t) => {
    const f = await fixture(t);
    let release,
      reads = 0,
      starts = 0;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    f.backend.readControl = async () => {
      reads++;
      await gate;
      return null;
    };
    const failure = new Error("fixture initialization failure");
    f.backend.initialize = async () => {
      starts++;
      await sleep(10);
      if (fails) throw failure;
    };
    const pending = Promise.allSettled(Array.from({ length: 8 }, () => f.backend.init()));
    await sleep(0);
    release();
    const results = await pending;
    assert.equal(reads, 1, "the shared attempt must cover asynchronous control-file reads");
    assert.equal(starts, 1, "concurrent callers must not replace each other's connection");
    assert.equal(f.backend.connecting, null);
    assert.equal(f.backend.initializing, false);
    assert.ok(
      results.every((result) =>
        fails
          ? result.status === "rejected" && result.reason === failure
          : result.status === "fulfilled",
      ),
    );
    if (fails) {
      f.backend.initialize = async () => {
        starts++;
      };
      await f.backend.init();
      assert.equal(starts, 2, "a later explicit retry is allowed after shared failure");
    }
  });
}

test("disposal during control read prevents initialization", async (t) => {
  const f = await fixture(t);
  let release,
    starts = 0;
  f.backend.readControl = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  f.backend.initialize = async () => {
    starts++;
  };
  const pending = assert.rejects(f.backend.init(), /GUI 连接已关闭/);
  f.backend.disposed = true;
  release(null);
  await pending;
  assert.equal(starts, 0);
  assert.equal(f.backend.connecting, null);
});

test("application shutdown preserves registered historical project identity and rejects crossed bindings", async () => {
  const local = require("../app/src/core/local-service.cjs");
  const original = local.serviceRequest;
  const owner = {
    kind: "gui",
    appRunId: "5c450fa8-b0af-492c-9c7b-2233736efbed",
    profile: "/fixture/profile",
  };
  const home = "/fixture/core",
    id = "111111111111111111111111",
    root = "/fixture/restored-workspace";
  const project = { id, root };
  const descriptor = {
    owner,
    serviceId: "instance",
    generation: "generation",
    configFingerprint: "fixture",
    workspace: root,
    dataDir: join(home, id, "state"),
    state: "running",
  };
  let descriptors = [descriptor];
  local.serviceRequest = async () => descriptors;
  const backend = Object.assign(Object.create(CoreBackend.prototype), {
    home,
    applicationOwner: owner,
    saved: [project],
    projects: new Map([[id, project]]),
    ownedEngines: new Map(),
    starting: new Map(),
  });
  try {
    await backend.refreshOwnedEngines();
    assert.equal(
      backend.ownedEngines.get(id).service,
      descriptor,
      "the registered ID owns its original data",
    );
    assert.equal(backend.ownedEngines.size, 1);
    for (const changed of [
      { dataDir: join(home, "another-project", "state") },
      { workspace: "/fixture/other-workspace" },
    ]) {
      descriptors = [{ ...descriptor, ...changed }];
      await assert.rejects(backend.refreshOwnedEngines(), /数据目录与登记不匹配/);
      assert.equal(
        backend.ownedEngines.get(id).service,
        descriptor,
        "invalid binding cannot replace the original generation",
      );
    }
    descriptors = [{ ...descriptor, generation: "replacement" }];
    await assert.rejects(backend.refreshOwnedEngines(), { code: "CONFIRMATION_STALE" });
    assert.equal(backend.ownedEngines.get(id).service, descriptor);
    descriptors = [
      {
        ...descriptor,
        owner: { ...owner, appRunId: "another-app" },
        dataDir: "/another-profile/state",
      },
    ];
    await backend.refreshOwnedEngines();
    assert.equal(backend.ownedEngines.size, 1, "another application remains outside this owner");
  } finally {
    local.serviceRequest = original;
  }
});

test("completed original shutdown clears GUI terminals after the transport disconnects", async (t) => {
  const f = await fixture(t);
  await f.publish();
  await f.backend.attach();
  f.backend.guiTerminals.set("terminal", { projectId: "p", threadId: "thread", id: "terminal" });
  f.backend.reconnectBlocked = true;
  f.drop();
  await until(() => !f.backend.status.connected);
  const reference = {
    requestId: "41b2ce45-08df-4b60-a2f7-cbbfdb6c12cb",
    kind: "stopDesktop",
    mode: "ifIdle",
    desktopGeneration: f.metadata.desktopGeneration,
    desktop: f.metadata,
    targets: [],
  };
  const receipt = {
    version: 1,
    ...reference,
    desktopExit: "notRequested",
    phase: "admissionUnconfirmed",
  };
  try {
    await f.backend.acceptLifecycleReceipt(reference, receipt);
    assert.equal(f.backend.guiTerminals.size, 1, "unknown shutdown never clears a terminal handle");
    const completed = await f.backend.acceptLifecycleReceipt(reference, {
      ...receipt,
      phase: "acceptedPending",
      desktopExit: "requested",
    });
    assert.equal(completed.phase, "completed");
    assert.equal(
      f.backend.guiTerminals.size,
      0,
      "the matching exited generation has already cleaned its terminals",
    );
    await f.backend.prepareQuit();
    assert.equal(
      f.calls.some((call) => call.method === "lifecycleRequest"),
      false,
      "receipt reconciliation never sends another stop",
    );
  } finally {
    f.backend.guiTerminals.clear();
  }
});

async function until(predicate) {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    assert.ok(
      Date.now() < deadline,
      "the existing compatible backend must reconnect automatically",
    );
    await sleep(10);
  }
}

async function fixture(
  t,
  {
    helloErrors = [],
    commandContract = COMMAND_CONTRACT,
    commandResult,
    service = {},
    resources = [],
    resourceError,
    onStop,
    lifecycle = true,
    replyTransform = (value) => value,
  } = {},
) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "areal-service-observer-")));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const metadata = {
    protocol: PROTOCOL,
    endpoint: `ws://127.0.0.1:${server.address().port}`,
    token: "a".repeat(64),
    identity: "fixture",
    desktopGeneration: "e4ea8195-0087-4613-9eab-2ec874b0457c",
    pid: 2147483000,
  };
  const calls = [],
    receipts = new Map();
  let connections = 0,
    stop = "success",
    sequence = 0;
  const packet = () => ({
    sequence: ++sequence,
    snapshot: {
      library: {
        projects: {},
        threads: {},
        projectOrder: [],
        sections: [],
        sidebarThreadOrder: [],
        sidebarRevision: 0,
        settings: {},
      },
      desktopCapabilities: { currentCommands: commandContract !== COMMAND_CONTRACT },
      projects: [
        {
          id: "p",
          root: home,
          state: { threads: {} },
          desktopCapabilities: { currentCommands: commandContract !== COMMAND_CONTRACT },
        },
      ],
    },
    service: {
      connected: true,
      clients: 1,
      busy: false,
      providerUpdating: false,
      activeCommands: 0,
      starting: 0,
      pid: metadata.pid,
      lifecycleVersion: 1,
      targets: [],
      ...(lifecycle
        ? {
            lifecycle: {
              version: 2,
              desktopGeneration: metadata.desktopGeneration,
              capabilities: {
                request: true,
                read: true,
                reconcile: true,
                kinds: [
                  "stopDesktop",
                  "updateDesktop",
                  "stopProject",
                  "updateProject",
                  "interruptTurn",
                ],
              },
            },
          }
        : {}),
      ...service,
      ...(commandContract === null ? {} : { commandContract }),
    },
  });
  server.on("connection", (socket, request) => {
    connections++;
    assert.equal(request.headers.authorization, `Bearer ${metadata.token}`);
    socket.on("message", async (bytes) => {
      const message = JSON.parse(String(bytes));
      calls.push(message);
      if (message.method === "hello" && message.params.identity !== metadata.identity) {
        socket.send(
          JSON.stringify({
            id: message.id,
            error: { code: "SERVICE_INCOMPATIBLE", message: "fixture identity changed" },
          }),
        );
        return;
      }
      if (message.method === "hello" && helloErrors.length) {
        socket.send(JSON.stringify({ id: message.id, error: helloErrors.shift() }));
        return;
      }
      if (message.method === "resources" && resourceError) {
        socket.send(JSON.stringify({ id: message.id, error: resourceError }));
        return;
      }
      if (["lifecycleRead", "lifecycleReconcile"].includes(message.method)) {
        socket.send(
          JSON.stringify({
            id: message.id,
            result: receipts.get(message.params.requestId) ?? null,
          }),
        );
        return;
      }
      if (message.method === "lifecycleRequest") {
        const ref = JSON.parse(await readFile(join(home, "service-control.json"), "utf8"));
        assert.equal(
          ref.references.some((item) => item.requestId === message.params.requestId),
          true,
          "reference must precede submission",
        );
        if (stop === "admission-failed") {
          socket.send(
            JSON.stringify({
              id: message.id,
              error: {
                code: "LIFECYCLE_ADMISSION_FAILED",
                message: "initial receipt could not be persisted; no effects",
              },
            }),
          );
          return;
        }
        const {
          requestId,
          kind,
          mode,
          expectedDesktopGeneration,
          expectedTargets,
          threadId,
          turnId,
        } = message.params;
        const phase =
          stop === "refused"
            ? "blocked"
            : stop === "partial"
              ? "partial"
              : stop === "pending" || stop === "unknown" || stop === "receipt-failed"
                ? "acceptedPending"
                : "completed";
        const receipt = {
          version: 1,
          requestId,
          kind,
          mode,
          desktopGeneration: expectedDesktopGeneration,
          ...(service.harnessHome ? { harnessHome: service.harnessHome } : {}),
          targets: expectedTargets.map((target) => ({
            ...target,
            requestId,
            phase: phase === "partial" ? "settlementIncomplete" : phase,
            ...(phase === "partial"
              ? {
                  error: { code: "CORE_SETTLEMENT_INCOMPLETE", message: "fixture cleanup pending" },
                }
              : {}),
          })),
          phase,
          desktopExit: "notRequested",
          ...(threadId ? { threadId, turnId } : {}),
        };
        if (phase === "completed" && ["stopDesktop", "updateDesktop"].includes(kind)) {
          receipt.phase = "acceptedPending";
          receipt.desktopExit = stop === "crashed" ? "notRequested" : "requested";
          await onStop?.({ home, metadata });
          await rm(join(home, "service.json"));
        }
        receipts.set(requestId, receipt);
        await mkdir(join(home, "lifecycle-operations"), { recursive: true });
        await writeFile(
          join(home, "lifecycle-operations", `${requestId}.json`),
          JSON.stringify(receipt),
        );
        if (stop === "unknown") {
          socket.terminate();
          return;
        }
        if (stop === "receipt-failed") {
          socket.send(
            JSON.stringify({
              id: message.id,
              error: {
                code: "LIFECYCLE_RECEIPT_WRITE_FAILED",
                message: "receipt persistence failed after acceptance",
              },
            }),
          );
          return;
        }
        socket.send(JSON.stringify({ id: message.id, result: replyTransform(receipt) }));
        return;
      }
      if (
        (message.method === "command" && commandResult === undefined) ||
        (message.method === "stopService" && stop === "unknown")
      ) {
        socket.terminate();
        return;
      }
      if (message.method === "stopService" && stop === "refused") {
        socket.send(
          JSON.stringify({
            id: message.id,
            error: { code: "LIFECYCLE_BLOCKED", message: "fixture work started during inspection" },
          }),
        );
        return;
      }
      let result =
        message.method === "command"
          ? commandResult
          : message.method === "resources"
            ? resources
            : packet();
      if (message.method === "stopService") {
        await onStop?.({ home, metadata });
        await rm(join(home, "service.json"));
        result = { stopped: true };
      }
      socket.send(JSON.stringify({ id: message.id, result }));
    });
  });
  const backend = new SharedCoreBackend({ app: { getPath: () => home }, home });
  const publish = () =>
    writeFile(join(home, "service.json"), JSON.stringify(metadata), { mode: 0o600 });
  const drop = () => {
    for (const socket of server.clients) socket.terminate();
  };
  t.after(async () => {
    await backend.shutdown();
    drop();
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  });
  return {
    home,
    backend,
    metadata,
    calls,
    publish,
    drop,
    service,
    receipts,
    connections: () => connections,
    updateContract: (value) => {
      commandContract = value;
      const params = packet();
      for (const socket of server.clients) socket.send(JSON.stringify({ method: "state", params }));
    },
    setStop: (value) => {
      stop = value;
    },
  };
}

async function journalFixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "areal-correlated-receipt-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const calls = [];
  const reload = async () => {
    const backend = new CoreBackend({ binary: process.execPath, home });
    backend.saved = [{ id: "p", root: home }];
    const project = await backend.loadProjectJournal("p");
    project.client = {
      ready: true,
      request: async (method, params) => {
        calls.push({ method, params });
        if (["thread/list", "areal/request/read"].includes(method)) return { data: [] };
        assert.ok(
          ["areal/turn/start", "areal/turn/enqueue"].includes(method),
          `unexpected Core request ${method}`,
        );
        return { turn: { id: "accepted-turn" } };
      },
    };
    return { backend, project };
  };
  return { home, calls, reload, ...(await reload()) };
}

for (const method of ["areal/turn/start", "areal/turn/enqueue"]) {
  test(`caller-correlated ${method} survives a lost outer response and journal reload`, async (t) => {
    const f = await journalFixture(t);
    const requestId = "f12a0dbc-3375-43f8-a3f1-36f204ed4e8a";
    const parameters = { threadId: "t", input: [{ type: "text", text: "send once" }] };
    await assert.rejects(
      async () => {
        await f.backend.submit(f.project, method, parameters, { requestId });
        throw Object.assign(Error("outer response lost"), { submissionUnknown: true, requestId });
      },
      (error) => error.submissionUnknown === true && error.requestId === requestId,
    );
    const expectedOutcome = {
      accepted: true,
      status: "completed",
      method,
      threadId: "t",
      turnId: "accepted-turn",
      operation: { method, requestId, target: { kind: "thread", threadId: "t" } },
    };
    assert.deepEqual(JSON.parse(await readFile(join(f.home, "p-outcomes.json"), "utf8")), {
      [requestId]: expectedOutcome,
    });
    assert.deepEqual(JSON.parse(await readFile(join(f.home, "p-pending.json"), "utf8")), []);
    const recovered = await f.reload();
    assert.deepEqual(await recovered.backend.command("reconcile", { projectId: "p" }), {
      outcomes: { [requestId]: expectedOutcome },
    });
    assert.deepEqual(f.calls, [
      { method, params: { ...parameters, requestId } },
      { method: "thread/list", params: { limit: 100 } },
    ]);
  });

  test(`caller-correlated ${method} returns known acceptance and retains its journal when local outcome cannot persist`, async (t) => {
    const f = await journalFixture(t);
    const requestId = "f12a0dbc-3375-43f8-a3f1-36f204ed4e8a";
    const parameters = { threadId: "t", input: [{ type: "text", text: "send once" }] };
    await mkdir(join(f.home, "p-outcomes.json"));
    assert.deepEqual(await f.backend.submit(f.project, method, parameters, { requestId }), {
      turn: { id: "accepted-turn" },
    });
    const createdAt = f.project.pending[0].createdAt;
    assert.equal(new Date(createdAt).toISOString(), createdAt);
    assert.equal(f.project.refreshErrors[requestId].refreshPending, true);
    assert.equal(f.project.refreshErrors[requestId].operation.requestId, requestId);
    assert.deepEqual(JSON.parse(await readFile(join(f.home, "p-pending.json"), "utf8")), [
      {
        method,
        createdAt,
        params: { ...parameters, requestId },
        operation: { method, requestId, target: { kind: "thread", threadId: "t" } },
      },
    ]);
    await rm(join(f.home, "p-outcomes.json"), { recursive: true });
    const recovered = await f.reload();
    assert.deepEqual(await recovered.backend.command("reconcile", { projectId: "p" }), {
      outcomes: {},
    });
    assert.deepEqual(JSON.parse(await readFile(join(f.home, "p-pending.json"), "utf8")), [
      {
        method,
        createdAt,
        params: { ...parameters, requestId },
        operation: { method, requestId, target: { kind: "thread", threadId: "t" } },
      },
    ]);
    assert.deepEqual(f.calls, [
      { method, params: { ...parameters, requestId } },
      { method: "areal/request/read", params: { requestId, threadId: "t" } },
      { method: "thread/list", params: { limit: 100 } },
    ]);
  });

  test(`uncorrelated ${method} does not retain a generated acceptance receipt`, async (t) => {
    const f = await journalFixture(t);
    const parameters = { threadId: "t", input: [{ type: "text", text: "send once" }] };
    assert.deepEqual(await f.backend.submit(f.project, method, parameters), {
      turn: { id: "accepted-turn" },
    });
    assert.deepEqual(JSON.parse(await readFile(join(f.home, "p-pending.json"), "utf8")), []);
    await assert.rejects(readFile(join(f.home, "p-outcomes.json"), "utf8"), { code: "ENOENT" });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].method, method);
    assert.deepEqual(f.calls[0].params.input, [{ type: "text", text: "send once" }]);
  });
}

test("subscription refresh unknown retains only its dispatched provider request across journal reload", async (t) => {
  const f = await journalFixture(t);
  const parameters = {
    threadId: "t",
    expectedConfigRevision: 1,
    intent: { type: "message", input: [{ type: "text", text: "keep my draft" }] },
  };
  const models = [{ id: "gpt", parameters: { contextWindowTokens: 500000 } }];
  const service = {
    id: "areal_openai",
    endpoint: "http://fixture.invalid/responses",
    models,
    ready: async () => {},
    account: {
      revision: 1,
      lifetime: new AbortController(),
      status: async () => ({ authenticated: true, state: "ready", models }),
      track: (promise) => promise,
    },
  };
  f.backend.providers.openaiPromise = Promise.resolve(service);
  f.project.configurations.t = { revision: 1, model: { providerId: service.id, modelId: "gpt" } };
  let recovered = false,
    providerRequest;
  const transport = async (method, params) => {
    f.calls.push({ method, params });
    if (method === "areal/provider/list")
      return {
        data: [
          {
            id: service.id,
            revision: 1,
            protocol: "responses",
            endpoint: service.endpoint,
            models: ["gpt"],
            parameters: {},
            modelParameters: { gpt: { contextWindowTokens: 1000000 } },
          },
        ],
      };
    if (method === "areal/provider/upsert") {
      providerRequest = {
        method,
        params,
        operation: { method, requestId: params.requestId, target: { kind: "project" } },
      };
      throw Object.assign(new Error("provider receipt unavailable after write"), { code: -32603 });
    }
    if (method === "areal/request/read") {
      if (!recovered) throw new Error("Core connection lost during receipt lookup");
      return {
        data:
          params.requestId === providerRequest.params.requestId
            ? [
                {
                  method: "areal/provider/upsert",
                  requestId: params.requestId,
                  state: "completed",
                  response: { result: { applied: true } },
                },
              ]
            : [],
      };
    }
    if (["areal/model/list", "thread/list"].includes(method)) return { data: [] };
    if (method === "areal/turn/submit") return { turn: { id: "accepted-turn" } };
    assert.fail(`unexpected Core request ${method}`);
  };
  f.project.client.request = transport;
  await assert.rejects(f.backend.providers.syncSubscription(f.project, service), (error) => {
    assert.equal(error.submissionUnknown, true);
    assert.equal(error.requestId, providerRequest.params.requestId);
    assert.deepEqual(error.outcome, { kind: "unconfirmed", operation: providerRequest.operation });
    assert.deepEqual(error.recovery, { kind: "queryOriginal" });
    return true;
  });
  assert.equal(
    f.calls.some((call) => call.method === "areal/turn/submit"),
    false,
    "explicit refresh never dispatches a turn",
  );
  providerRequest.createdAt = f.project.pending[0].createdAt;
  assert.equal(new Date(providerRequest.createdAt).toISOString(), providerRequest.createdAt);
  assert.deepEqual(
    f.project.pending,
    [providerRequest],
    "only the dispatched provider request needs recovery",
  );
  assert.deepEqual(JSON.parse(await readFile(join(f.home, "p-pending.json"), "utf8")), [
    providerRequest,
  ]);
  assert.deepEqual(f.project.outcomes, {}, "an unknown refresh cannot fabricate acceptance");

  recovered = true;
  const restored = await f.reload();
  restored.project.client.request = transport;
  await restored.backend.reconcile(restored.project);
  assert.deepEqual(restored.project.pending, []);
  assert.deepEqual(JSON.parse(await readFile(join(f.home, "p-pending.json"), "utf8")), []);
  assert.equal(
    f.calls.filter((call) => call.method === "areal/provider/upsert").length,
    1,
    "recovery reads the original receipt without resubmission",
  );
  assert.deepEqual(
    f.calls.filter((call) => call.method === "areal/request/read").map((call) => call.params),
    [
      { requestId: providerRequest.params.requestId },
      { requestId: providerRequest.params.requestId },
    ],
  );
  assert.equal(
    f.calls.some((call) => call.method === "areal/turn/submit"),
    false,
    "recovery never sends the preserved draft",
  );
  await restored.backend.submit(restored.project, "areal/turn/submit", parameters, {
    requestId: "22222222-2222-2222-2222-222222222222",
  });
  assert.equal(
    f.calls.filter((call) => call.method === "areal/turn/submit").length,
    1,
    "the user can explicitly send after provider recovery",
  );
});

test("subscription-selected turn submission uses its original receipt without refreshing the catalog or provider", async (t) => {
  const f = await journalFixture(t);
  const requestId = "11111111-1111-1111-1111-111111111111";
  const parameters = {
    threadId: "t",
    expectedConfigRevision: 1,
    intent: { type: "message", input: [{ type: "text", text: "send once" }] },
  };
  f.project.configurations.t = {
    revision: 1,
    model: { providerId: "areal_openai", modelId: "gpt" },
  };
  f.backend.providers.openaiPromise = Promise.resolve({
    account: {
      revision: 1,
      lifetime: new AbortController(),
      track: (promise) => promise,
      status: async () =>
        assert.fail("sending a message must not consult the subscription catalog"),
    },
  });
  const result = { turn: { id: "accepted-turn" } };
  f.project.client.request = async (method, params) => {
    f.calls.push({ method, params });
    assert.equal(
      method,
      "areal/turn/submit",
      "sending a message must not read or mutate providers",
    );
    return result;
  };
  assert.deepEqual(
    await f.backend.submit(f.project, "areal/turn/submit", parameters, { requestId }),
    result,
  );
  assert.deepEqual(f.calls, [
    { method: "areal/turn/submit", params: { ...parameters, requestId } },
  ]);
  assert.deepEqual(f.project.pending, []);
  assert.deepEqual(JSON.parse(await readFile(join(f.home, "p-pending.json"), "utf8")), []);
  assert.deepEqual(f.project.outcomes[requestId], {
    accepted: true,
    status: "completed",
    method: "areal/turn/submit",
    threadId: "t",
    turnId: "accepted-turn",
    operation: {
      method: "areal/turn/submit",
      requestId,
      target: { kind: "thread", threadId: "t" },
    },
  });
  await assert.rejects(
    f.backend.submit(f.project, "areal/turn/submit", parameters, { requestId }),
    (error) => {
      assert.notEqual(error.submissionUnknown, true);
      return true;
    },
  );
  assert.equal(f.calls.length, 1, "reusing a settled request ID never repeats the turn");
});

test("legacy task catalog is blocked without starting owners and recovers with the current contract", async (t) => {
  const result = { data: [], errors: [], owners: [], hasMore: false };
  const f = await fixture(t, {
    commandContract: "areal.desktop-commands.v2",
    commandResult: result,
  });
  await f.publish();
  await f.backend.attach();
  assert.equal(f.backend.snapshot().desktopCapabilities.currentCommands, false);
  for (const operation of ["preview", "observe"]) {
    await assert.rejects(f.backend.command("tasks", { operation, projectId: "p" }), {
      code: "SERVICE_COMMAND_UNSUPPORTED",
    });
  }
  assert.deepEqual(
    f.calls.map((call) => call.method),
    ["hello"],
  );
  assert.equal(f.backend.status.connected, true, "existing work stays connected");
  f.updateContract(COMMAND_CONTRACT);
  await until(() => f.backend.status.commandContract === COMMAND_CONTRACT);
  for (const operation of ["preview", "observe"]) {
    assert.deepEqual(await f.backend.command("tasks", { operation, projectId: "p" }), result);
  }
  assert.deepEqual(
    f.calls
      .filter((call) => call.method === "command")
      .map((call) => call.params.request.operation),
    ["preview", "observe"],
  );
  assert.equal(
    f.calls.some((call) => call.method === "lifecycleRequest"),
    false,
  );
});

test("public command availability comes only from the current service contract", async (t) => {
  const f = await fixture(t, { commandContract: null });
  await f.publish();
  await f.backend.attach();
  const capabilities = () => {
    const snapshot = f.backend.snapshot();
    return [snapshot.desktopCapabilities, snapshot.projects[0].desktopCapabilities];
  };
  assert.deepEqual(capabilities(), [{ currentCommands: false }, { currentCommands: false }]);
  f.updateContract(COMMAND_CONTRACT);
  await until(() => f.backend.status.commandContract === COMMAND_CONTRACT);
  assert.deepEqual(capabilities(), [{ currentCommands: true }, { currentCommands: true }]);
  f.updateContract("areal.desktop-commands.future");
  await until(() => f.backend.status.commandContract === "areal.desktop-commands.future");
  assert.deepEqual(capabilities(), [{ currentCommands: false }, { currentCommands: false }]);
  f.updateContract(null);
  await until(() => f.backend.status.commandContract === undefined);
  assert.deepEqual(capabilities(), [{ currentCommands: false }, { currentCommands: false }]);
  assert.deepEqual(
    f.calls.map((c) => c.method),
    ["hello"],
  );
});

test("legacy Desktop contract cannot accept writes requiring original recovery identities", async (t) => {
  const f = await fixture(t, { commandContract: "areal.desktop-commands.v1" });
  await f.publish();
  await f.backend.attach();
  assert.equal(f.backend.snapshot().desktopCapabilities.currentCommands, false);
  for (const [name, request] of [
    ["create", { projectId: "p" }],
    ["configure", { projectId: "p", threadId: "t", parameters: {} }],
    ["manage", { projectId: "p", operation: "taskPause", taskId: "task", expectedRevision: 1 }],
  ]) {
    await assert.rejects(
      f.backend.command(name, request),
      (error) =>
        error.code === "SERVICE_COMMAND_UNSUPPORTED" &&
        error.submissionUnknown !== true &&
        error.requestId === undefined,
    );
  }
  assert.equal(
    f.calls.some((call) => call.method === "command"),
    false,
  );
});

test("an unadvertised backend rejects current commands before sending or inventing a receipt", async (t) => {
  const f = await fixture(t, { commandContract: null });
  await f.publish();
  await f.backend.attach();
  const thread = { projectId: "p", threadId: "t" };
  const requests = [
    ["send", { ...thread, text: "keep my draft" }],
    ["continue", { ...thread, expectedTurnId: "turn" }],
    ["prepareCreator", { projectId: "p" }],
    ["feedback", { operation: "status" }],
    ["feedback", { operation: "preference", enabled: true }],
    [
      "feedback",
      { ...thread, operation: "prepare", turnId: "turn", itemId: "answer", rating: "down" },
    ],
    ...["read", "draft", "refine", "submit", "close"].map((operation) => [
      "feedback",
      { ...thread, operation, id: "saved-draft" },
    ]),
    ["trajectory", { operation: "setEnabled", enabled: true, expectedRevision: "a".repeat(64) }],
    ["providers", { operation: "defaultAndApply", id: "provider" }],
    [
      "steer",
      { ...thread, expectedTurnId: "turn", mcpContent: [{ type: "text", text: "MCP input" }] },
    ],
    [
      "queueEdit",
      { ...thread, operation: "replace", mcpContent: [{ type: "text", text: "MCP input" }] },
    ],
    [
      "manage",
      {
        ...thread,
        operation: "pluginInstall",
        id: "plugin",
        scope: "project",
        source: "/fixture/plugin",
        expectedDigest: "a".repeat(64),
        expectedRevision: 1,
      },
    ],
    ["manage", { ...thread, operation: "marketplaceUpdate", expectedRevision: 1 }],
    ...[
      "plugins",
      "marketplaces",
      "mcpApps",
      "mcpAppOpen",
      "mcpForms",
      "mcpFormRespond",
      "mcpExtensionCall",
      "mcpToolResult",
    ].map((operation) => ["manage", { ...thread, operation }]),
    ...["connectorConfigure", "connectorCredential"].map((operation) => [
      "manage",
      {
        ...thread,
        operation,
        id: "plugin",
        connectorId: "github",
        provider: "github",
        expectedDigest: "a".repeat(64),
        requestId: "connector-request",
        credentialRef: "saved-ref",
        secret: "fixture-secret",
      },
    ]),
    [
      "manage",
      {
        ...thread,
        operation: "hookAcknowledge",
        requestId: "hook-request",
        invocationId: "invocation",
        inspection: "reviewed",
      },
    ],
  ];
  for (const [name, request] of requests) {
    await assert.rejects(f.backend.command(name, request), (error) => {
      assert.equal(error.code, "SERVICE_COMMAND_UNSUPPORTED", `${name}.${request.operation ?? ""}`);
      assert.equal(
        error.message,
        "当前运行中的后台不支持此操作。现有任务继续运行，输入已保留；请在任务完成后安全停止后台并重新连接。",
      );
      assert.notEqual(error.submissionUnknown, true);
      assert.equal(Object.hasOwn(error, "requestId"), false);
      return true;
    });
  }
  assert.equal(f.backend.status.connected, true);
  assert.deepEqual(
    f.calls.map((c) => c.method),
    ["hello"],
  );
});

test("an unadvertised backend keeps compatible observation and control commands", async (t) => {
  const f = await fixture(t, { commandContract: null, commandResult: { accepted: true } });
  await f.publish();
  await f.backend.attach();
  const thread = { projectId: "p", threadId: "t" };
  const requests = [
    ["list", { projectId: "p" }],
    ["open", thread],
    ["reconcile", { projectId: "p" }],
    ["queue", thread],
    ["steer", { ...thread, text: "compatible text", expectedTurnId: "turn", mcpContent: [] }],
    ["providers", { operation: "save", id: "provider" }],
    ["trajectory", { operation: "status" }],
    ["manage", { ...thread, operation: "processes" }],
  ];
  for (const [name, request] of requests)
    assert.deepEqual(await f.backend.command(name, request), { accepted: true });
  const commands = f.calls.filter((c) => c.method === "command").map((c) => c.params);
  for (const value of commands.filter((value) => ["steer", "configure"].includes(value.name))) {
    assert.match(value.request.requestId, /^[0-9a-f-]{36}$/);
    delete value.request.requestId;
  }
  assert.deepEqual(
    commands,
    requests.map(([name, request]) => ({ name, request })),
  );
});

test("legacy queue edits retain the original receipt after disconnect without replay", async (t) => {
  const f = await fixture(t, { commandContract: null });
  await f.publish();
  await f.backend.attach();
  const requestId = "62bedfab-f198-4d6a-b66d-46760b04e214";
  const request = {
    projectId: "p",
    threadId: "t",
    operation: "replace",
    itemId: "queued",
    text: "edited",
    requestId,
  };
  await assert.rejects(f.backend.command("queueEdit", request), (error) => {
    assert.equal(error.submissionUnknown, true);
    assert.equal(error.requestId, requestId);
    return true;
  });
  await until(() => f.backend.status.connected);
  assert.deepEqual(
    f.calls.filter((c) => c.method === "command").map((c) => c.params),
    [{ name: "queueEdit", request }],
  );
  assert.equal(f.calls.filter((c) => c.method === "hello").length, 2);
});

test("a backend published after startup timeout attaches without launching again", async (t) => {
  const f = await fixture(t);
  let launches = 0;
  // 启动器的外部边界注入超时；之后的发现、认证和快照使用真实 WebSocket。
  f.backend.initialize = async () => {
    launches++;
    f.backend.identity = "fixture";
    throw Object.assign(Error("not ready yet"), { code: "SERVICE_NOT_READY" });
  };
  await assert.rejects(f.backend.init(), /not ready yet/);
  await f.publish();
  await until(() => f.backend.status.connected);
  assert.equal(launches, 1);
  assert.deepEqual(
    f.calls.map((c) => c.method),
    ["hello"],
  );
});

test("passive reconnect publishes connecting until the original observer is ready", async (t) => {
  const f = await fixture(t);
  await f.publish();
  await f.backend.attach();
  const states = [];
  f.backend.onChange = () => states.push(f.backend.snapshot().connection.state);
  f.drop();
  await until(() => !f.backend.status.connected);
  assert.equal(f.backend.snapshot().connection.state, "connecting");
  assert.ok(f.backend.reconnectTimer);
  await until(() => f.backend.status.connected);
  assert.deepEqual([...new Set(states)], ["connecting", "ready"]);
  assert.equal(
    f.calls.some((call) => call.method === "command"),
    false,
  );
});

test("a read-only hello timeout recovers without a manual reconnect or command replay", async (t) => {
  const helloErrors = [];
  const f = await fixture(t, { helloErrors });
  await f.publish();
  await f.backend.attach();
  helloErrors.push({
    code: "TIMEOUT",
    message: "Injected hello read timeout",
    submissionUnknown: false,
    recovery: { kind: "retryRead" },
  });
  f.drop();
  await until(() => f.calls.filter((call) => call.method === "hello").length >= 2);
  await until(() => f.backend.status.connected);
  assert.equal(f.calls.filter((call) => call.method === "hello").length, 3);
  assert.notEqual(f.backend.reconnectBlocked, true);
  assert.equal(
    f.calls.some((call) => call.method === "command"),
    false,
  );
});

test("a persisted user stop discovered during retry ends connecting with an actionable state", async (t) => {
  const f = await fixture(t);
  await f.publish();
  await f.backend.attach();
  await writeFile(f.backend.controlPath, JSON.stringify({ home: f.home, state: "stopped" }));
  f.drop();
  await until(() => f.backend.reconnectBlocked);
  assert.equal(f.backend.snapshot().connection.state, "unavailable");
  assert.equal(f.backend.snapshot().connection.recovery, "check");
  assert.equal(f.connections(), 1);
});

test("an unknown command is never replayed when its observer reconnects", async (t) => {
  const f = await fixture(t);
  await f.publish();
  await f.backend.attach();
  const requestId = "e99d906b-7912-4e95-81dc-a3fd3c967779";
  const request = { projectId: "p", threadId: "t", text: "once", requestId };
  await assert.rejects(
    f.backend.command("send", request),
    (error) => error.submissionUnknown === true && error.requestId === requestId,
  );
  await until(() => f.backend.status.connected);
  assert.deepEqual(
    f.calls.filter((c) => c.method === "command").map((c) => c.params),
    [{ name: "send", request }],
  );
  assert.equal(f.calls.filter((c) => c.method === "hello").length, 2);
});

for (const state of ["stopped", "unconfirmed"]) {
  test(`persisted ${state} intent prevents passive reconnection`, async (t) => {
    const f = await fixture(t);
    await f.publish();
    await f.backend.attach();
    await f.backend.saveControl(state);
    f.drop();
    await sleep(700);
    assert.equal(f.backend.status.connected, false);
    assert.equal(f.backend.snapshot().connection.state, "unavailable");
    assert.equal(f.connections(), 1);
  });
}

test("a changed backend identity needs explicit recovery instead of automatic retirement", async (t) => {
  const f = await fixture(t);
  await f.publish();
  await f.backend.attach();
  f.metadata.identity = "other-build";
  await f.publish();
  f.drop();
  await until(() => f.connections() === 2);
  await sleep(700);
  assert.equal(f.backend.status.connected, false);
  assert.equal(f.connections(), 2);
  assert.equal(f.backend.snapshot().connection.state, "unavailable");
  assert.equal(f.calls.filter((c) => c.method !== "hello").length, 0);
});

for (const forUpdate of [false, true]) {
  test(`confirmed explicit stop (forUpdate=${forUpdate}) blocks automatic attachment`, async (t) => {
    const f = await fixture(t);
    await f.publish();
    await f.backend.attach();
    assert.equal((await f.backend.stopService(forUpdate)).stopped, true);
    await f.publish();
    f.drop();
    await sleep(700);
    assert.equal(f.backend.status.connected, false);
    assert.equal(f.backend.snapshot().connection.state, "unavailable");
    assert.equal(f.connections(), 1);
    assert.equal(f.calls.filter((c) => c.method === "lifecycleRequest").length, 1);
    assert.equal(
      f.calls.some((c) => c.method === "stopService"),
      false,
    );
  });
}

test("closing the GUI cancels pending observer recovery", async (t) => {
  const f = await fixture(t);
  await f.publish();
  await f.backend.attach();
  f.drop();
  await sleep(25);
  await f.backend.shutdown();
  await sleep(700);
  assert.equal(f.connections(), 1);
});

test("an explicit reconnect can reopen observation after a persisted user stop", async (t) => {
  const f = await fixture(t);
  await f.publish();
  await f.backend.attach();
  await f.backend.saveControl("stopped");
  f.drop();
  await sleep(25);
  let starts = 0;
  f.backend.initialize = async () => {
    starts++;
    assert.equal(await f.backend.attach(), true);
  };
  await f.backend.init({ automatic: true });
  assert.equal(f.backend.status.connected, false);
  assert.equal(starts, 0);
  await f.backend.init();
  assert.equal(f.backend.status.connected, true);
  assert.equal(starts, 1);
});

for (const automatic of [false, true]) {
  test(`completed update resumes after GUI reopen (automatic=${automatic})`, async (t) => {
    const f = await fixture(t);
    await f.publish();
    await f.backend.attach();
    const stopped = await f.backend.stopService(true);
    assert.equal(stopped.operation.phase, "completed");
    const journal = join(f.home, "lifecycle-operations", `${stopped.operation.requestId}.json`);
    const before = await readFile(journal);
    await f.backend.shutdown();
    const reopened = new SharedCoreBackend({ app: { getPath: () => f.home }, home: f.home });
    t.after(() => reopened.shutdown());
    let starts = 0;
    reopened.initialize = async () => {
      starts++;
    };
    await reopened.init({ automatic });
    assert.equal(starts, 1, "an already authorized update resumes the new Desktop");
    assert.equal(reopened.lifecycleReferences.size, 0);
    await assert.rejects(readFile(reopened.controlPath), { code: "ENOENT" });
    assert.deepEqual(await readFile(journal), before, "recovery retains the original receipt");
    assert.equal(f.calls.filter((call) => call.method === "lifecycleRequest").length, 1);
  });
}

for (const scenario of [
  "stopped",
  "missing receipt",
  "unfinished target",
  "live Desktop",
  "mixed unknown",
]) {
  test(`GUI reopen retains ${scenario} lifecycle intent without starting a replacement`, async (t) => {
    const f = await fixture(t, {
      service:
        scenario === "unfinished target"
          ? { targets: [{ projectId: "p", serviceId: "s", generation: "g" }] }
          : {},
    });
    if (scenario === "live Desktop") {
      f.metadata.pid = process.pid;
      f.setStop("crashed");
    }
    if (scenario === "unfinished target") f.setStop("pending");
    await f.publish();
    await f.backend.attach();
    const stopped = await f.backend.stopService(scenario !== "stopped");
    if (scenario === "missing receipt")
      await rm(join(f.home, "lifecycle-operations", `${stopped.operation.requestId}.json`));
    if (scenario === "mixed unknown") {
      const control = JSON.parse(await readFile(f.backend.controlPath, "utf8"));
      control.references.push({
        ...control.references[0],
        requestId: "7af130a1-5a89-4c9b-9001-7592bc2166c5",
      });
      await writeFile(f.backend.controlPath, JSON.stringify(control));
    }
    await f.backend.shutdown();
    const reopened = new SharedCoreBackend({ app: { getPath: () => f.home }, home: f.home });
    t.after(() => reopened.shutdown());
    let starts = 0;
    reopened.initialize = async () => {
      starts++;
    };
    await reopened.init({ automatic: true });
    assert.equal(starts, 0);
    assert.ok(reopened.lifecycleReferences.size > 0);
    assert.ok(JSON.parse(await readFile(reopened.controlPath, "utf8")).references.length > 0);
    assert.equal(f.calls.filter((call) => call.method === "lifecycleRequest").length, 1);
  });
}

async function startupFixture(t, options = {}) {
  let replacementIdentity, controlAtStop;
  const f = await fixture(t, {
    ...options,
    onStop: async ({ home, metadata }) => {
      controlAtStop = JSON.parse(await readFile(join(home, "service-control.json"), "utf8"));
      const capabilities = await readFile(join(home, "capabilities.log"), "utf8");
      assert.ok(
        capabilities.includes("config models --help"),
        "inspect the replacement before stopping the retained service",
      );
      metadata.identity = replacementIdentity;
    },
  });
  const binary = join(f.home, "areal");
  await writeFile(
    binary,
    `#!/bin/sh
printf '%s\n' "$*" >> '${join(f.home, "capabilities.log")}'
printf 'fixture model help\n'
`,
    { mode: 0o700 },
  );
  for (const name of ["areal-runtime", "areal-runtime-fs"])
    await writeFile(join(f.home, name), name);
  f.backend.options = { home: f.home, binary, configHome: join(f.home, "config") };
  replacementIdentity = await serviceIdentity(f.backend.options);
  const launcher = join(f.home, "desktop-fixture.cjs");
  await writeFile(
    launcher,
    `const fs = require('node:fs');
const home = ${JSON.stringify(f.home)};
fs.appendFileSync(home + '/launches.log', 'launch\\n');
fs.writeFileSync(home + '/service.json', fs.readFileSync(home + '/replacement.json'));
`,
  );
  await writeFile(
    join(f.home, "replacement.json"),
    JSON.stringify({ ...f.metadata, identity: replacementIdentity }),
  );
  f.backend.app.getAppPath = () => launcher;
  await f.publish();
  return {
    ...f,
    binary,
    identity: replacementIdentity,
    controlAtStop: () => controlAtStop,
    launches: async () => {
      try {
        return (await readFile(join(f.home, "launches.log"), "utf8")).trim().split("\n").length;
      } catch (error) {
        if (error.code === "ENOENT") return 0;
        throw error;
      }
    },
  };
}

test("deployment identity tracks actual executable content and ignores mtime alone", async (t) => {
  const f = await startupFixture(t);
  for (const name of ["areal", "areal-runtime", "areal-runtime-fs"]) {
    const path = join(f.home, name),
      before = await stat(path);
    const identity = await serviceIdentity(f.backend.options);
    await utimes(path, before.atime, new Date(before.mtimeMs + 10_000));
    assert.equal(
      await serviceIdentity(f.backend.options),
      identity,
      `${name} timestamp is not deployment content`,
    );
    const original = await readFile(path);
    await writeFile(path, Buffer.concat([original, Buffer.from("changed content")]));
    await utimes(path, before.atime, before.mtime);
    assert.notEqual(
      await serviceIdentity(f.backend.options),
      identity,
      `${name} same-path replacement must change identity`,
    );
    await writeFile(path, original);
  }
});

test("deployment identity includes split desktop contract content", async (t) => {
  const f = await startupFixture(t);
  const deployment = join(f.home, "deployment");
  const core = join(deployment, "src/core");
  await mkdir(core, { recursive: true });
  for (const name of ["bundle.cjs", "service-config.cjs"])
    await cp(require.resolve("../app/src/core/" + name), join(core, name));
  await cp(
    require.resolve("../app/src/workspace-files"),
    join(deployment, "src/workspace-files.js"),
  );
  const modules = join(deployment, "node_modules/@areal");
  await mkdir(modules, { recursive: true });
  const originalModules = require
    .resolve("../app/package.json")
    .replace(/package\.json$/, "node_modules/@areal");
  for (const name of await readdir(originalModules)) {
    if (name === "workbench") {
      await mkdir(join(modules, name));
      await cp(join(originalModules, name, "client"), join(modules, name, "client"), {
        recursive: true,
      });
      await cp(join(originalModules, name, "package.json"), join(modules, name, "package.json"));
    } else await symlink(join(originalModules, name), join(modules, name), "dir");
  }
  const { serviceIdentity: identity } = require(join(core, "service-config.cjs"));
  const before = await identity(f.backend.options);
  const catalog = join(modules, "workbench/client/desktop-contract/catalog.cjs");
  const content = await readFile(catalog, "utf8");
  await writeFile(catalog, content + "\n// 兼容性回归：模拟拆分协议变更。\n");
  assert.notEqual(
    await identity(f.backend.options),
    before,
    "split protocol edits must mark the retained backend for update",
  );
  await writeFile(catalog, content);
  assert.equal(await identity(f.backend.options), before);
});

test("automatic same-deployment reopen silently retains the existing service", async (t) => {
  const f = await startupFixture(t);
  f.metadata.identity = f.identity;
  await f.publish();
  await f.backend.init({ automatic: true });
  assert.deepEqual(f.backend.snapshot().connection, { state: "ready" });
  assert.equal(f.backend.snapshot().backendUpdate, undefined);
  assert.equal(await f.launches(), 0);
  assert.deepEqual(
    f.calls.map((call) => call.method),
    ["hello"],
  );
});

test("automatic idle reopen retains the old deployment with an explicit update pending", async (t) => {
  const f = await startupFixture(t);
  await f.backend.init({ automatic: true });
  assert.equal(f.backend.metadata.identity, "fixture");
  assert.equal(await f.launches(), 0);
  assert.deepEqual(f.backend.snapshot().connection, { state: "ready" });
  assert.deepEqual(f.backend.snapshot().backendUpdate, { state: "pending" });
  assert.deepEqual(
    f.calls.map((call) => call.method),
    ["hello"],
  );
  await assert.rejects(readFile(f.backend.controlPath), { code: "ENOENT" });
});

test("explicit update persists its reference and launches only after confirmed exit", async (t) => {
  const f = await startupFixture(t);
  await f.backend.init({ automatic: true });
  assert.equal(
    (
      await f.backend.applyUpdate({
        notify: async () => {
          throw Error("idle update needs no dialog");
        },
      })
    ).stopped,
    true,
  );
  assert.equal(f.controlAtStop().references[0].kind, "updateDesktop");
  assert.equal(f.backend.metadata.identity, f.identity);
  assert.equal(await f.launches(), 1);
  assert.deepEqual(f.backend.snapshot().connection, { state: "ready" });
  assert.equal(f.backend.snapshot().backendUpdate, undefined);
  assert.equal(f.calls.filter((call) => call.method === "lifecycleRequest").length, 1);
  await assert.rejects(readFile(f.backend.controlPath), { code: "ENOENT" });
});

for (const [label, service, resources] of [
  ["active Turn", { busy: true }, []],
  ["other GUI", { clients: 2 }, []],
  [
    "pending Queue",
    {},
    [{ projectId: "p", root: "/fixture", restartSafe: true, resources: [], waitingMessages: 1 }],
  ],
  [
    "UNKNOWN",
    {},
    [{ projectId: "p", root: "/fixture", restartSafe: false, resources: [], unresolvedTools: 1 }],
  ],
]) {
  test(`automatic changed deployment retains ${label} and never watches for idle`, async (t) => {
    const f = await startupFixture(t, { service, resources });
    await f.backend.init({ automatic: true });
    assert.equal(f.backend.status.connected, true);
    assert.deepEqual(f.backend.snapshot().backendUpdate, { state: "pending" });
    assert.equal(f.backend.metadata.identity, "fixture");
    Object.assign(f.service, { busy: false, clients: 1 });
    await f.backend.init({ automatic: true });
    await sleep(30);
    assert.equal(
      f.calls.some((call) => call.method === "stopService"),
      false,
    );
    assert.equal(await f.launches(), 0);
  });
}

test("explicit connect observes a changed deployment without automatic replacement", async (t) => {
  const f = await startupFixture(t);
  await f.backend.init();
  assert.equal(f.backend.status.connected, true);
  assert.deepEqual(f.backend.snapshot().backendUpdate, { state: "pending" });
  assert.equal(
    f.calls.some((call) => call.method === "stopService"),
    false,
  );
  assert.equal(await f.launches(), 0);
});

test("replacement capability failure keeps the original connected service", async (t) => {
  const f = await startupFixture(t);
  await writeFile(f.binary, '#!/bin/sh\nprintf "unrecognized subcommand\\n"\n');
  await f.backend.init({ automatic: true });
  await assert.rejects(f.backend.applyUpdate(), /当前 Core 不支持/);
  assert.equal(f.backend.status.connected, true);
  assert.equal(f.backend.snapshot().connection.state, "ready");
  assert.equal(f.backend.snapshot().backendUpdate.state, "failed");
  assert.match(f.backend.snapshot().backendUpdate.message, /当前 Core 不支持/);
  assert.equal(
    f.calls.some((call) => call.method === "stopService"),
    false,
  );
  assert.equal(await f.launches(), 0);
});

test("identity read failure leaves a retained observer usable with an update error", async (t) => {
  const f = await startupFixture(t);
  await rm(f.binary);
  await f.backend.init({ automatic: true });
  assert.equal(f.backend.status.connected, true);
  assert.equal(f.backend.snapshot().connection.state, "ready");
  assert.equal(f.backend.snapshot().backendUpdate.state, "failed");
  assert.equal(
    f.calls.some((call) => call.method === "stopService"),
    false,
  );
  assert.equal(await f.launches(), 0);
});

test("known blocked update stays connected and permits unrelated reads and writes", async (t) => {
  const f = await startupFixture(t, { commandResult: { accepted: true } });
  f.setStop("refused");
  await f.backend.init({ automatic: true });
  const result = await f.backend.applyUpdate();
  assert.equal(result.operation.phase, "blocked");
  assert.equal(f.backend.status.connected, true);
  assert.equal(f.backend.snapshot().connection.state, "ready");
  assert.deepEqual(
    await f.backend.command("send", { projectId: "other", threadId: "t", text: "allowed" }),
    { accepted: true },
  );
  assert.equal(await f.launches(), 0);
  assert.equal(f.calls.filter((call) => call.method === "lifecycleRequest").length, 1);
});

test("lost update response reads the original receipt and never replays on startup", async (t) => {
  const f = await startupFixture(t, {
    service: { targets: [{ projectId: "p", serviceId: "s", generation: "g" }] },
  });
  f.setStop("unknown");
  await f.backend.init({ automatic: true });
  const result = await f.backend.applyUpdate();
  assert.equal(result.operation.phase, "acceptedPending");
  const control = JSON.parse(await readFile(f.backend.controlPath, "utf8"));
  assert.equal(control.references[0].kind, "updateDesktop");
  assert.equal(control.references[0].requestId, result.operation.requestId);
  await f.backend.init({ automatic: true });
  assert.equal(f.backend.status.connected, true);
  assert.equal(f.backend.snapshot().lifecycle.phase, "acceptedPending");
  assert.equal(f.calls.filter((call) => call.method === "lifecycleRequest").length, 1);
  assert.equal(await f.launches(), 0);
  f.drop();
  await until(() => !f.backend.status.connected);
  await rm(join(f.home, "service.json"));
  await f.backend.checkLifecycle();
  assert.equal(f.backend.snapshot().lifecycle.phase, "acceptedPending");
  assert.equal(await f.launches(), 0);
});

test("confirmed update exit followed by launch failure retains the update reference", async (t) => {
  const f = await startupFixture(t);
  await f.backend.init({ automatic: true });
  const appPath = f.backend.app.getAppPath;
  f.backend.app.getAppPath = () => {
    throw Error("replacement launch unavailable");
  };
  await assert.rejects(f.backend.applyUpdate(), /replacement launch unavailable/);
  const control = JSON.parse(await readFile(f.backend.controlPath, "utf8"));
  assert.equal(control.references[0].kind, "updateDesktop");
  await f.backend.init({ automatic: true });
  assert.equal(f.calls.filter((call) => call.method === "lifecycleRequest").length, 1);
  assert.equal(await f.launches(), 0);
  assert.equal(JSON.parse(await readFile(f.backend.controlPath, "utf8")).references.length, 1);
  f.backend.app.getAppPath = appPath;
  await f.backend.init();
  assert.equal(await f.launches(), 1);
  assert.equal(f.calls.filter((call) => call.method === "lifecycleRequest").length, 1);
});

test("legacy lifecycle stays readable but unsupported stop never probes or persists intent", async (t) => {
  const f = await fixture(t, { lifecycle: false });
  await f.publish();
  await f.backend.attach();
  await assert.rejects(f.backend.stopService(), (error) => error.code === "LIFECYCLE_UNSUPPORTED");
  assert.equal(f.backend.snapshot().connection.state, "ready");
  assert.equal((await f.backend.serviceStatus()).connected, true);
  assert.equal(
    f.calls.some((call) => ["stopService", "lifecycleRequest"].includes(call.method)),
    false,
  );
  await assert.rejects(readFile(f.backend.controlPath), { code: "ENOENT" });
});

test("single-turn cancellation persists fixed identity without blocking unrelated commands", async (t) => {
  const target = { projectId: "p", serviceId: "s", generation: "g" };
  const f = await fixture(t, { commandResult: { accepted: true }, service: { targets: [target] } });
  await f.publish();
  await f.backend.attach();
  f.setStop("unknown");
  const result = await f.backend.command("stop", {
    projectId: "p",
    threadId: "t",
    turnId: "turn-original",
    requestId: "db7fbfc7-161c-4bf1-a633-cc8421518571",
  });
  assert.equal(result.operation.phase, "acceptedPending");
  await f.backend.checkLifecycle();
  assert.deepEqual(
    await f.backend.command("send", {
      projectId: "other",
      threadId: "unrelated",
      text: "continue",
    }),
    { accepted: true },
  );
  const writes = f.calls.filter((call) => call.method === "lifecycleRequest");
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].params, {
    protocol: PROTOCOL,
    requestId: result.operation.requestId,
    kind: "interruptTurn",
    mode: "cancel",
    expectedDesktopGeneration: f.metadata.desktopGeneration,
    expectedTargets: [target],
    threadId: "t",
    turnId: "turn-original",
  });
  assert.equal(
    f.calls.some((call) => call.method === "command" && call.params.name === "stop"),
    false,
  );
});

test("legacy unconfirmed startup attaches for observation without a permanent global freeze", async (t) => {
  const f = await fixture(t, { commandResult: { accepted: true } });
  await f.publish();
  await f.backend.saveControl("unconfirmed");
  await f.backend.init({ automatic: true });
  assert.equal(f.backend.status.connected, true);
  assert.equal(f.backend.snapshot().connection.state, "ready");
  assert.equal(f.backend.snapshot().lifecycle.phase, "admissionUnconfirmed");
  assert.deepEqual(await f.backend.command("list", { projectId: "p" }), { accepted: true });
  assert.equal(
    f.calls.some((call) => ["stopService", "lifecycleRequest"].includes(call.method)),
    false,
  );
});

test("restoring a project on a connected legacy backend does not restart connection recovery", async (t) => {
  const f = await fixture(t, { commandResult: { accepted: true } });
  await f.publish();
  await f.backend.saveControl("unconfirmed");
  await f.backend.init({ automatic: true });
  const states = [];
  f.backend.onChange = () => states.push(f.backend.snapshot().connection.state);
  const original = await readFile(f.backend.controlPath, "utf8");
  assert.deepEqual(await f.backend.command("connect", { projectId: "p" }), { accepted: true });
  assert.deepEqual(await f.backend.command("open", { projectId: "p", threadId: "t" }), {
    accepted: true,
  });
  assert.deepEqual(states, [], "project restoration must not invalidate its own ready connection");
  assert.equal(f.calls.filter((call) => call.method === "hello").length, 1);
  assert.equal(
    await readFile(f.backend.controlPath, "utf8"),
    original,
    "legacy outcome remains unacknowledged",
  );
  assert.equal(
    f.calls.some((call) => ["stopService", "lifecycleRequest"].includes(call.method)),
    false,
  );
});

test("a completed target receipt and original Desktop exit settle the crash before exit intent", async (t) => {
  const target = { projectId: "p", serviceId: "s", generation: "g" };
  const f = await fixture(t, { service: { targets: [target] } });
  await f.publish();
  await f.backend.attach();
  f.setStop("crashed");
  const result = await f.backend.stopService();
  assert.equal(result.stopped, true);
  assert.equal(result.operation.phase, "completed");
  assert.equal(result.operation.desktopExit, "notRequested");
  assert.equal(f.backend.status.connected, false);
});

test("a missing descriptor and completed target never prove a live Desktop has exited", async (t) => {
  const f = await fixture(t, {
    service: { targets: [{ projectId: "p", serviceId: "s", generation: "g" }] },
  });
  f.metadata.pid = process.pid;
  await f.publish();
  await f.backend.attach();
  f.setStop("crashed");
  const result = await f.backend.stopService();
  assert.equal(result.stopped, false);
  assert.equal(result.operation.phase, "acceptedPending");
  assert.equal(f.backend.status.connected, true);
});

test("a corrupted immediate receipt is reconciled against the original request identity", async (t) => {
  const f = await fixture(t, {
    service: { targets: [{ projectId: "p", serviceId: "s", generation: "g" }] },
    replyTransform: (receipt) => ({
      ...receipt,
      requestId: "0de45cd4-1d08-4390-afb6-5cef5633b838",
    }),
  });
  await f.publish();
  await f.backend.attach();
  f.setStop("pending");
  const result = await f.backend.stopService();
  const request = f.calls.find((call) => call.method === "lifecycleRequest").params;
  assert.equal(result.operation.requestId, request.requestId);
  assert.equal(result.operation.phase, "acceptedPending");
  assert.equal(f.calls.filter((call) => call.method === "lifecycleRequest").length, 1);
});

test("a fixed single-turn request ID cannot be rebound to a later turn", async (t) => {
  const f = await fixture(t, {
    service: { targets: [{ projectId: "p", serviceId: "s", generation: "g" }] },
  });
  await f.publish();
  await f.backend.attach();
  f.setStop("pending");
  const request = {
    projectId: "p",
    threadId: "t",
    turnId: "original",
    requestId: "3ef06098-7ba1-4400-b60d-cb53f3070bb0",
  };
  assert.equal((await f.backend.command("stop", request)).operation.phase, "acceptedPending");
  await assert.rejects(
    f.backend.command("stop", { ...request, turnId: "newer" }),
    (error) => error.code === "LIFECYCLE_REQUEST_CONFLICT",
  );
  assert.equal(f.calls.filter((call) => call.method === "lifecycleRequest").length, 1);
});

test("known incomplete update permits a fresh explicit intent after rechecking remaining targets", async (t) => {
  const target = { projectId: "p", serviceId: "s", generation: "g" };
  const f = await startupFixture(t, { service: { targets: [target] } });
  await f.backend.init({ automatic: true });
  f.setStop("partial");
  assert.equal((await f.backend.applyUpdate()).operation.phase, "partial");
  assert.equal(f.backend.snapshot().lifecycle.targets[0].message, "fixture cleanup pending");
  f.setStop("success");
  assert.equal((await f.backend.applyUpdate()).stopped, true);
  const requests = f.calls.filter((call) => call.method === "lifecycleRequest");
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].params.requestId, requests[1].params.requestId);
  assert.equal(await f.launches(), 1);
});

test("completed single-turn references do not prevent an explicit reconnect after Desktop stop", async (t) => {
  const f = await fixture(t, {
    service: { targets: [{ projectId: "p", serviceId: "s", generation: "g" }] },
  });
  await f.publish();
  await f.backend.attach();
  assert.equal(
    (
      await f.backend.command("stop", {
        projectId: "p",
        threadId: "t",
        turnId: "finished",
        requestId: "6b1f801e-d322-45a1-af47-5fc07c1664e7",
      })
    ).operation.phase,
    "completed",
  );
  assert.equal((await f.backend.stopService()).stopped, true);
  await f.publish();
  let starts = 0;
  f.backend.initialize = async () => {
    starts++;
    assert.equal(await f.backend.attach(), true);
  };
  await f.backend.init();
  assert.equal(starts, 1);
  assert.equal(f.backend.status.connected, true);
});

test("explicit update finalizes a live Desktop after read-only reconciliation completes every target", async (t) => {
  const target = { projectId: "p", serviceId: "s", generation: "g" };
  const f = await startupFixture(t, { service: { targets: [target] } });
  f.metadata.pid = process.pid;
  await f.publish();
  await f.backend.init({ automatic: true });
  f.setStop("pending");
  const first = await f.backend.applyUpdate();
  const receipt = f.receipts.get(first.operation.requestId);
  receipt.targets[0].phase = "completed";
  f.service.targets = [];
  const checked = await f.backend.checkLifecycle();
  assert.equal(checked.phase, "acceptedPending");
  assert.equal(f.calls.filter((call) => call.method === "lifecycleRequest").length, 1);
  const second = await f.backend.applyUpdate();
  const writes = f.calls.filter((call) => call.method === "lifecycleRequest");
  assert.equal(writes.length, 2);
  assert.notEqual(second.operation.requestId, first.operation.requestId);
  assert.deepEqual(writes[1].params.expectedTargets, []);
  assert.equal(await f.launches(), 0);
});

test("receipt persistence failure after admission retains and reads the original reference", async (t) => {
  const f = await fixture(t, {
    service: { targets: [{ projectId: "p", serviceId: "s", generation: "g" }] },
  });
  await f.publish();
  await f.backend.attach();
  f.setStop("receipt-failed");
  const result = await f.backend.stopService();
  assert.equal(result.operation.phase, "acceptedPending");
  const request = f.calls.find((call) => call.method === "lifecycleRequest").params;
  const control = JSON.parse(await readFile(f.backend.controlPath, "utf8"));
  assert.equal(control.references[0].requestId, request.requestId);
  assert.equal(result.operation.requestId, request.requestId);
  assert.equal(f.calls.filter((call) => call.method === "lifecycleRequest").length, 1);
  assert.equal(
    f.calls.some(
      (call) => call.method === "lifecycleReconcile" && call.params.requestId === request.requestId,
    ),
    true,
  );
});

test("offline recovery queries the original Host receipt without relaunching or rewriting Desktop history", async (t) => {
  const f = await fixture(t, {
    service: { targets: [{ projectId: "p", serviceId: "s", generation: "g" }] },
  });
  const originalRegistry = join(f.home, "original-harness");
  f.service.harnessHome = originalRegistry;
  await f.publish();
  await f.backend.attach();
  f.setStop("pending");
  const first = await f.backend.stopService();
  const target = first.operation.targets[0];
  const path = join(f.home, "lifecycle-operations", `${first.operation.requestId}.json`);
  const original = await readFile(path, "utf8");
  const binary = join(f.home, "areal-receipt");
  const operation = {
    version: 1,
    requestId: target.requestId,
    serviceId: target.serviceId,
    generation: target.generation,
    cancel: false,
    state: "completed",
  };
  await writeFile(
    binary,
    `#!${process.execPath}\nconst fs=require('node:fs');\nfs.appendFileSync(${JSON.stringify(join(f.home, "host-reads.jsonl"))}, JSON.stringify({args:process.argv.slice(2),registry:process.env.AREAL_HARNESS_SERVICE_HOME})+'\\n');\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ operation }))});\n`,
    { mode: 0o700 },
  );
  f.backend.options.binary = binary;
  f.backend.options.harnessHome = join(f.home, "harness");
  f.backend.reconnectBlocked = true;
  f.drop();
  await until(() => !f.backend.status.connected);
  await rm(join(f.home, "service.json"));
  const checked = await f.backend.checkLifecycle();
  assert.equal(checked.phase, "completed");
  assert.deepEqual(JSON.parse((await readFile(join(f.home, "host-reads.jsonl"), "utf8")).trim()), {
    args: [
      "service",
      "operation",
      "--instance",
      "s",
      "--expected-generation",
      "g",
      "--request-id",
      target.requestId,
      "--json",
    ],
    registry: originalRegistry,
  });
  assert.equal(await readFile(path, "utf8"), original);
  assert.equal(f.calls.filter((call) => call.method === "lifecycleRequest").length, 1);
  assert.equal(f.backend.status.connected, false);
});

test("proven initial admission failure releases its reference and allows a new explicit intent", async (t) => {
  const f = await fixture(t, {
    service: { targets: [{ projectId: "p", serviceId: "s", generation: "g" }] },
  });
  await f.publish();
  await f.backend.attach();
  f.setStop("admission-failed");
  await assert.rejects(
    f.backend.stopService(),
    (error) => error.code === "LIFECYCLE_ADMISSION_FAILED",
  );
  await assert.rejects(readFile(f.backend.controlPath), { code: "ENOENT" });
  f.setStop("pending");
  assert.equal((await f.backend.stopService()).operation.phase, "acceptedPending");
  assert.equal(f.calls.filter((call) => call.method === "lifecycleRequest").length, 2);
});

test("single-turn cancellation uses the healthy target snapshot when another Core cannot be inspected", async (t) => {
  const healthy = {
    projectId: "p",
    serviceId: "healthy-service",
    generation: "healthy-generation",
  };
  const disconnected = {
    projectId: "other",
    serviceId: "unavailable-service",
    generation: "unavailable-generation",
  };
  const f = await fixture(t, {
    service: { targets: [healthy, disconnected] },
    resourceError: { code: "DISCONNECTED", message: "unrelated Core is disconnected" },
  });
  await f.publish();
  await f.backend.attach();
  const requestId = "79a29f4e-a52a-439d-8e2b-336406883293";
  const result = await f.backend.command("stop", {
    projectId: "p",
    threadId: "healthy-thread",
    turnId: "healthy-turn",
    requestId,
  });
  assert.equal(result.operation.phase, "completed");
  assert.equal(result.operation.turnId, "healthy-turn");
  const writes = f.calls.filter((call) => call.method === "lifecycleRequest");
  assert.deepEqual(
    writes.map((call) => call.params),
    [
      {
        protocol: PROTOCOL,
        requestId,
        kind: "interruptTurn",
        mode: "cancel",
        expectedDesktopGeneration: f.metadata.desktopGeneration,
        expectedTargets: [healthy],
        threadId: "healthy-thread",
        turnId: "healthy-turn",
      },
    ],
  );
  assert.equal(
    f.calls.some((call) => call.method === "resources"),
    false,
  );
});

for (const supported of [false, true]) {
  test(`selected thread hint is ${supported ? "forwarded to a supporting" : "omitted for a legacy"} Desktop`, async (t) => {
    const f = await fixture(t, {
      commandResult: { accepted: true },
      service: supported ? { selectedThreadObservation: true } : {},
    });
    await f.publish();
    await f.backend.attach();
    await f.backend.command("connect", { projectId: "p", threadId: "t" });
    const command = f.calls.find((call) => call.method === "command");
    assert.deepEqual(
      command.params.request,
      supported ? { projectId: "p", threadId: "t" } : { projectId: "p" },
    );
  });
}
