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
  chmod,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { createServer as createNetServer } from "node:net";

const require = createRequire(import.meta.url);
const { CoreBackend } = require("@areal/workbench-service/desktop/core/backend.cjs");
const { SharedCoreBackend } = require("../app/src/core/service-client.cjs");
const { ServiceConnection } = require("../app/src/core/service-connection.cjs");
const { createOwner } = require("@areal/workbench-service/desktop/core/application-owner.cjs");
const {
  PROTOCOL,
  COMMAND_CONTRACT,
} = require("@areal/workbench-service/desktop/core/service-protocol.cjs");
const { serviceIdentity } = require("../app/src/core/service-config.cjs");
const { WebSocketServer } = require("../app/node_modules/ws");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("default GUI selects Host before initializing any in-process writer", async (t) => {
  const f = await startupOwnerFixture(t);
  let starts = 0;
  f.backend.initializeHostBackend = async () => {
    starts++;
  };
  f.backend.prerequisiteCheck = async () => assert.fail("must not initialize Main backend");
  await f.backend.initialize();
  assert.equal(starts, 1);
});

test("Host startup failure never falls back to a Main writer", async (t) => {
  const f = await startupOwnerFixture(t);
  const failure = new Error("fixture Host owner unavailable");
  f.backend.initializeHostBackend = async () => {
    throw failure;
  };
  f.backend.prerequisiteCheck = async () => assert.fail("must not initialize Main backend");
  await assert.rejects(f.backend.initialize(), (error) => error === failure);
});

/** 进程内适配器的连接步骤，与 Host 后台 attach 之后的握手一致。 */
async function connectAdapter(backend, adapter) {
  const connection = backend.createConnection();
  const metadata = connection.connectMain(adapter);
  backend.connection?.close();
  backend.connection = connection;
  backend.metadata = metadata;
  backend.identity = metadata.identity;
  backend.foreignOwner = null;
  backend.sequence = -1;
  backend.exitConfirmation = null;
  try {
    const packet = await connection.request("hello", {
      protocol: PROTOCOL,
      identity: metadata.identity,
      notifications: !!backend.onNotification,
      capabilities: { computerHost: 1 },
    });
    backend.computerHostOwned = packet?.computerHostOwned === true;
    backend.accept(packet, metadata);
    if (backend.lastActivity) await connection.request("activity", backend.lastActivity);
  } catch (error) {
    backend.connection = null;
    connection.close();
    throw error;
  }
}

async function startupOwnerFixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "areal-startup-owner-")));
  const backend = new SharedCoreBackend({ app: { getPath: () => home }, home });
  t.after(async () => {
    await backend.shutdown();
    await rm(home, { recursive: true, force: true });
  });
  return { home, backend };
}

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

test("historical project aliases authenticate Host ownership and explicit stop receipts", async (t) => {
  const local = require("@areal/workbench-service/desktop/core/local-service.cjs");
  const home = await realpath(await mkdtemp(join(tmpdir(), "areal-host-ownership-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const id = "111111111111111111111111";
  const root = join(home, "restored-workspace"),
    dataDir = join(home, id, "state"),
    authFile = join(dataDir, "auth.json");
  await mkdir(root);
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    authFile,
    JSON.stringify({
      principals: [{ token: "fixture-token", permissions: ["observe", "interact", "manage"] }],
    }),
  );
  const backend = new CoreBackend({ binary: process.execPath, home });
  const host = backend.host;
  host.client.hostId = "fixture-host";
  host.client.generation = "fixture-host-generation";
  const binding = {
    alias: { profile: host.source.profile, legacyProjectId: id },
    projectId: "fixture-host-project",
    workspace: root,
    dataDir,
    scratchDir: join(home, id, "scratch"),
  };
  host.bindings.set(id, binding);
  const descriptor = {
    protocolVersion: 1,
    owner: { kind: "host", hostId: host.client.hostId, generation: host.client.generation },
    serviceId: "222222222222222222222222",
    generation: "fixture-core-generation",
    configFingerprint: "fixture",
    workspace: root,
    dataDir,
    state: "ready",
    endpoint: "ws://127.0.0.1:1",
    authFile,
  };
  const authenticated = await local.authenticateService(host, id, descriptor);
  assert.deepEqual(authenticated, { descriptor, token: "" });
  assert.equal(
    JSON.stringify(authenticated).includes("fixture-token"),
    false,
    "Core authentication credentials remain inside Host",
  );
  for (const changed of [
    { dataDir: join(home, "another-project", "state") },
    { workspace: join(home, "another-workspace") },
  ]) {
    await assert.rejects(local.authenticateService(host, id, { ...descriptor, ...changed }), {
      code: "CORE_INCOMPATIBLE",
    });
    assert.equal(
      host.resolve(id),
      binding,
      "invalid descriptors cannot replace historical ownership",
    );
  }
  for (const owner of [
    { ...descriptor.owner, hostId: "another-host" },
    { ...descriptor.owner, generation: "replacement-host-generation" },
  ])
    await assert.rejects(local.authenticateService(host, id, { ...descriptor, owner }), {
      code: "CORE_OWNER_MISMATCH",
    });
  const target = {
    projectId: id,
    serviceId: descriptor.serviceId,
    generation: descriptor.generation,
    requestId: "5c450fa8-b0af-492c-9c7b-2233736efbed",
  };
  let receipt = {
    version: 1,
    requestId: target.requestId,
    projectId: binding.projectId,
    serviceId: target.serviceId,
    serviceGeneration: target.generation,
    strategy: "ifIdle",
    state: "completed",
  };
  host.client.request = async (method, params) => {
    assert.equal(method, "project.stop");
    assert.deepEqual(params, {
      requestId: target.requestId,
      expectedGeneration: host.client.generation,
      projectId: binding.projectId,
      serviceGeneration: target.generation,
      strategy: "ifIdle",
    });
    return receipt;
  };
  assert.deepEqual(await local.requestStop(backend, target, false), {
    ...receipt,
    generation: target.generation,
    cancel: false,
  });
  for (const changed of [
    { projectId: "another-host-project" },
    { serviceId: "333333333333333333333333" },
    { serviceGeneration: "replacement-core-generation" },
  ]) {
    const original = receipt;
    receipt = { ...original, ...changed };
    await assert.rejects(local.requestStop(backend, target, false), {
      code: "LIFECYCLE_RECEIPT_INVALID",
    });
    receipt = original;
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
    projectState = {},
    commandState,
    deferredCommandState = false,
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
          ...projectState,
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
        if (message.method === "command" && deferredCommandState) {
          socket.send(
            JSON.stringify({
              id: message.id,
              error: {
                message: "fixture lost response",
                submissionUnknown: true,
                requestId: message.params.request.requestId,
              },
            }),
          );
        } else if (message.method === "command" && commandState) {
          Object.assign(projectState, commandState);
          await new Promise((resolve) =>
            socket.send(JSON.stringify({ method: "state", params: packet() }), resolve),
          );
          socket.close();
        } else socket.terminate();
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
      if (message.method === "snapshot" && deferredCommandState && commandState)
        Object.assign(projectState, commandState);
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
  // 夹具直接接上进程内适配器，覆盖连接、恢复与回执语义；后台归属由 Host 测试单独覆盖。
  let mainFailure;
  const hostCapabilityChecks = [];
  const connectMain = async () => {
    let closed = false;
    const transports = new Set();
    const mainBackend = new CoreBackend({ binary: process.execPath, home });
    mainBackend.host.client.capabilities = ["workbenchUtilities"];
    const requireCapability = mainBackend.host.client.requireCapability.bind(
      mainBackend.host.client,
    );
    mainBackend.host.client.requireCapability = (capability) => {
      requireCapability(capability);
      hostCapabilityChecks.push(capability);
    };
    mainBackend.hostCall = async () =>
      assert.fail("Capability preflight must not dispatch a Core action");
    const desktop = {
      backend: mainBackend,
      adapter: {
        connectMain(onMessage, onClose) {
          const transport = new ServiceConnection(
            (params) => onMessage({ method: "state", params }),
            onClose,
          );
          transports.add(transport);
          const failure = mainFailure;
          mainFailure = undefined;
          const ready = failure ? Promise.reject(failure) : transport.connect(metadata);
          return {
            metadata: { ...metadata },
            request: async (method, params) => {
              await ready;
              return transport.request(method, params, method === "command");
            },
            close: () => {
              transports.delete(transport);
              transport.close();
            },
          };
        },
      },
      get closed() {
        return closed;
      },
      async close() {
        closed = true;
        for (const transport of transports) transport.close();
        transports.clear();
      },
    };
    backend.mainDesktop = desktop;
    backend.initializeHostBackend = () => connectAdapter(backend, desktop.adapter);
    await backend.initialize();
  };
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
    connectMain,
    hostCapabilityChecks,
    failNextMain: (error) => {
      mainFailure = error;
    },
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
  const journalPath = join(home, "host-journal-fixture.json");
  await writeFile(journalPath, JSON.stringify({ version: 1, pending: [], outcomes: {} }));
  const reload = async () => {
    const backend = new CoreBackend({ binary: process.execPath, home });
    backend.saved = [{ id: "p", root: home }];
    const journal = {
      read: async () => ({ snapshot: JSON.parse(await readFile(journalPath, "utf8")) }),
      change: async (mutate) => {
        const { snapshot } = await journal.read();
        await writeFile(journalPath, JSON.stringify(await mutate(snapshot)));
        return { state: "completed" };
      },
    };
    backend.host.sourceId = "fixture-source";
    backend.host.bindings.set("p", {
      alias: { profile: backend.host.source.profile, legacyProjectId: "p" },
      sourceId: backend.host.sourceId,
      projectId: "fixture-project",
      workspace: home,
      dataDir: join(home, "p", "state"),
      scratchDir: join(home, "p", "scratch"),
    });
    backend.host.client.journal = (id) => {
      assert.equal(id, "fixture-project");
      return journal;
    };
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
    return { backend, project, journal };
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
    assert.deepEqual((await f.journal.read()).snapshot.outcomes, {
      [requestId]: expectedOutcome,
    });
    assert.deepEqual((await f.journal.read()).snapshot.pending, []);
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
    const change = f.journal.change;
    f.journal.change = async (mutate) => {
      const { snapshot } = await f.journal.read();
      const next = await mutate(snapshot);
      if (Object.keys(next.outcomes).length) throw new Error("fixture: outcome disk unavailable");
      return change(() => next);
    };
    assert.deepEqual(await f.backend.submit(f.project, method, parameters, { requestId }), {
      turn: { id: "accepted-turn" },
    });
    const createdAt = f.project.pending[0].createdAt;
    assert.equal(new Date(createdAt).toISOString(), createdAt);
    assert.equal(f.project.refreshErrors[requestId].refreshPending, true);
    assert.equal(f.project.refreshErrors[requestId].operation.requestId, requestId);
    assert.deepEqual((await f.journal.read()).snapshot.pending, [
      {
        method,
        createdAt,
        params: { ...parameters, requestId },
        operation: { method, requestId, target: { kind: "thread", threadId: "t" } },
      },
    ]);
    f.journal.change = change;
    const recovered = await f.reload();
    assert.deepEqual(await recovered.backend.command("reconcile", { projectId: "p" }), {
      outcomes: {},
    });
    assert.deepEqual((await f.journal.read()).snapshot.pending, [
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
    assert.deepEqual((await f.journal.read()).snapshot.pending, []);
    assert.deepEqual((await f.journal.read()).snapshot.outcomes, {});
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
  assert.deepEqual((await f.journal.read()).snapshot.pending, [providerRequest]);
  assert.deepEqual(f.project.outcomes, {}, "an unknown refresh cannot fabricate acceptance");

  recovered = true;
  const restored = await f.reload();
  restored.project.client.request = transport;
  await restored.backend.reconcile(restored.project);
  assert.deepEqual(restored.project.pending, []);
  assert.deepEqual((await f.journal.read()).snapshot.pending, []);
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
  assert.deepEqual((await f.journal.read()).snapshot.pending, []);
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
  await f.connectMain();
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

test("legacy Desktop contract cannot accept writes requiring original recovery identities", async (t) => {
  const f = await fixture(t, { commandContract: "areal.desktop-commands.v1" });
  await f.connectMain();
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
  await f.connectMain();
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
  await f.connectMain();
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
  await f.connectMain();
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

for (const mismatch of [null, "request", "target", "generation", "instance"]) {
  test(`lost GUI response retains only the matching observed operation (${mismatch ?? "matching"})`, async (t) => {
    const requestId = "e99d906b-7912-4e95-81dc-a3fd3c967779";
    const core = {
      binary: "fixture",
      apiVersion: null,
      runtimeEpoch: null,
      runtimeAvailable: null,
      features: null,
      instanceId: "core-1",
      connectionGeneration: 1,
    };
    const operation = {
      method: "areal/turn/submit",
      requestId: mismatch === "request" ? "other-request" : requestId,
      target: { kind: "thread", threadId: mismatch === "target" ? "other-thread" : "t" },
    };
    const f = await fixture(t, {
      projectState: { core },
      commandState: {
        core: {
          ...core,
          ...(mismatch === "generation" ? { connectionGeneration: 2 } : {}),
          ...(mismatch === "instance" ? { instanceId: "core-2" } : {}),
        },
        outcomes: { [requestId]: { status: "completed", accepted: true, operation } },
      },
    });
    await f.connectMain();
    await assert.rejects(
      f.backend.command("send", { projectId: "p", threadId: "t", text: "once", requestId }),
      (error) => {
        assert.equal(error.submissionUnknown, true);
        assert.equal(error.requestId, requestId);
        assert.deepEqual(error.outcome?.operation, mismatch ? undefined : operation);
        return true;
      },
    );
    assert.equal(f.calls.filter((call) => call.method === "command").length, 1);
  });
}

for (const scenario of [
  "matching",
  "logical-core-changed",
  "execution-generation-changed",
  "missing-receipt",
  "invalid-snapshot",
]) {
  test(`lost worktree response reads one fresh snapshot (${scenario})`, async (t) => {
    const requestId = "b6fdd8bc-29eb-4c07-9121-e04f427dc8cb";
    const core = {
      binary: "fixture",
      apiVersion: null,
      runtimeEpoch: null,
      runtimeAvailable: null,
      features: null,
      instanceId: null,
      connectionGeneration: 0,
    };
    const executionCore = { instanceId: "worktree-core", connectionGeneration: 5 };
    const operation = {
      requestId,
      method: "areal/turn/submit",
      target: { kind: "thread", threadId: "t" },
    };
    const f = await fixture(t, {
      projectState: { core, state: { threads: { t: { id: "t", turns: [], executionCore } } } },
      commandState: {
        core:
          scenario === "logical-core-changed"
            ? { ...core, instanceId: "logical-core", connectionGeneration: 1 }
            : core,
        state:
          scenario === "invalid-snapshot"
            ? { threads: null }
            : {
                threads: {
                  t: {
                    id: "t",
                    turns: [],
                    executionCore:
                      scenario === "execution-generation-changed"
                        ? { ...executionCore, connectionGeneration: 6 }
                        : executionCore,
                  },
                },
              },
        outcomes:
          scenario === "missing-receipt"
            ? {}
            : { [requestId]: { status: "completed", accepted: true, operation } },
      },
      deferredCommandState: true,
    });
    await f.connectMain();
    await assert.rejects(
      f.backend.command("send", { projectId: "p", threadId: "t", text: "once", requestId }),
      (error) => {
        assert.equal(error.submissionUnknown, true);
        assert.deepEqual(
          error.outcome?.operation,
          ["matching", "logical-core-changed"].includes(scenario) ? operation : undefined,
        );
        return true;
      },
    );
    assert.equal(f.calls.filter((call) => call.method === "command").length, 1);
    assert.equal(f.calls.filter((call) => call.method === "snapshot").length, 1);
  });
}

test("an unknown command is never replayed when its observer reconnects", async (t) => {
  const f = await fixture(t);
  await f.publish();
  await f.connectMain();
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

for (const forUpdate of [false, true]) {
  test(`confirmed explicit stop (forUpdate=${forUpdate}) blocks automatic attachment`, async (t) => {
    const f = await fixture(t);
    await f.publish();
    await f.connectMain();
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

for (const automatic of [false, true]) {
  test(`completed update resumes after GUI reopen (automatic=${automatic})`, async (t) => {
    const f = await fixture(t);
    await f.publish();
    await f.connectMain();
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

async function startupFixture(t, options = {}) {
  let replacementIdentity, controlAtStop;
  const f = await fixture(t, {
    ...options,
    onStop: async ({ home, metadata }) => {
      controlAtStop = JSON.parse(await readFile(join(home, "service-control.json"), "utf8"));
      assert.ok(
        f.hostCapabilityChecks.includes("workbenchUtilities"),
        "inspect Host configuration capability before stopping the retained service",
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

test("deployment identity includes split contracts and relocated workbench domains", async (t) => {
  const f = await startupFixture(t);
  const deployment = join(f.home, "deployment");
  const core = join(deployment, "src/core");
  await mkdir(core, { recursive: true });
  for (const name of ["service-config.cjs"])
    await cp(require.resolve("../app/src/core/" + name), join(core, name));
  await cp(
    require.resolve("@areal/workbench-service/desktop/workspace-files.js"),
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
    } else if (name === "workbench-service") {
      await mkdir(join(modules, name));
      await cp(join(originalModules, name, "src"), join(modules, name, "src"), { recursive: true });
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
  const domain = join(modules, "workbench-service/src/domains/feedback.cjs");
  const original = await readFile(domain, "utf8");
  await writeFile(domain, original + "\n// 兼容性回归：迁出领域仍参与后台身份。\n");
  assert.notEqual(await identity(f.backend.options), before);
  await writeFile(domain, original);
  assert.equal(await identity(f.backend.options), before);
});

test("known blocked update stays connected and permits unrelated reads and writes", async (t) => {
  const f = await startupFixture(t, { commandResult: { accepted: true } });
  f.setStop("refused");
  await f.connectMain();
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

test("legacy lifecycle stays readable but unsupported stop never probes or persists intent", async (t) => {
  const f = await fixture(t, { lifecycle: false });
  await f.connectMain();
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
  await f.connectMain();
  f.setStop("unknown");
  const result = await f.backend.command("stop", {
    projectId: "p",
    threadId: "t",
    turnId: "turn-original",
    requestId: "db7fbfc7-161c-4bf1-a633-cc8421518571",
  });
  assert.equal(result.operation.phase, "acceptedPending");
  await f.connectMain();
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

test("a completed target receipt and original Desktop exit settle the crash before exit intent", async (t) => {
  const target = { projectId: "p", serviceId: "s", generation: "g" };
  const f = await fixture(t, { service: { targets: [target] } });
  await f.publish();
  await f.connectMain();
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
  await f.connectMain();
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
  await f.connectMain();
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
  await f.connectMain();
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

test("explicit update finalizes a live Desktop after read-only reconciliation completes every target", async (t) => {
  const target = { projectId: "p", serviceId: "s", generation: "g" };
  const f = await startupFixture(t, { service: { targets: [target] } });
  f.metadata.pid = process.pid;
  await f.publish();
  await f.connectMain();
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
  await f.connectMain();
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
  await f.connectMain();
  f.setStop("pending");
  const first = await f.backend.stopService();
  const target = first.operation.targets[0];
  const path = join(f.home, "lifecycle-operations", `${first.operation.requestId}.json`);
  const original = await readFile(path, "utf8");
  const operation = {
    version: 1,
    requestId: target.requestId,
    serviceId: target.serviceId,
    serviceGeneration: target.generation,
    strategy: "ifIdle",
    state: "completed",
  };
  // 沿用 host-lifecycle 的有限本机 Host socket；原 ID 只读核查，不启动 CLI。
  const socketRoot = await realpath(await mkdtemp("/tmp/ah-receipt-"));
  const socketPath = join(socketRoot, "host.sock");
  const hostId = "fixture-original-host",
    generation = "fixture-original-generation";
  const authFile = join(originalRegistry, "host/auth.json");
  await mkdir(join(originalRegistry, "host"), { recursive: true, mode: 0o700 });
  await writeFile(authFile, JSON.stringify("original-host-token"), { mode: 0o600 });
  await writeFile(
    join(originalRegistry, "host/host.json"),
    JSON.stringify({
      version: 1,
      hostId,
      generation,
      socketPath,
      authFile,
      pid: process.pid,
    }),
    { mode: 0o600 },
  );
  const hostCalls = [],
    hostSockets = new Set();
  const hostServer = createNetServer((socket) => {
    hostSockets.add(socket);
    socket.on("close", () => hostSockets.delete(socket));
    socket.on("error", () => {});
    let bytes = "";
    socket.on("data", (chunk) => {
      bytes += chunk;
      for (;;) {
        const end = bytes.indexOf("\n");
        if (end < 0) break;
        const request = JSON.parse(bytes.slice(0, end));
        bytes = bytes.slice(end + 1);
        hostCalls.push(request);
        let result;
        if (request.method === "hello") {
          assert.equal(request.params.authToken, "original-host-token");
          result = { version: 1, hostId, generation, capabilities: ["stopOperations"] };
        } else {
          assert.equal(request.method, "host.operation", "Recovery never dispatches stop/ensure");
          assert.deepEqual(request.params, { requestId: target.requestId });
          result = { operation };
        }
        socket.write(JSON.stringify({ version: 1, id: request.id, result }) + "\n");
      }
    });
  });
  hostServer.listen(socketPath);
  await once(hostServer, "listening");
  await chmod(socketPath, 0o600);
  t.after(async () => {
    for (const socket of hostSockets) socket.destroy();
    await new Promise((done) => hostServer.close(done));
    await rm(socketRoot, { recursive: true, force: true });
  });
  f.backend.options.binary = process.execPath;
  f.backend.options.harnessHome = join(f.home, "harness");
  f.backend.reconnectBlocked = true;
  f.drop();
  await until(() => !f.backend.status.connected);
  await rm(join(f.home, "service.json"));
  const checked = await f.backend.checkLifecycle();
  assert.equal(checked.phase, "completed");
  assert.deepEqual(
    hostCalls.map((request) => request.method),
    ["hello", "host.operation"],
  );
  assert.deepEqual(hostCalls[1].params, { requestId: target.requestId });
  assert.equal(await readFile(path, "utf8"), original);
  assert.equal(f.calls.filter((call) => call.method === "lifecycleRequest").length, 1);
  assert.equal(f.backend.status.connected, false);
});

test("proven initial admission failure releases its reference and allows a new explicit intent", async (t) => {
  const f = await fixture(t, {
    service: { targets: [{ projectId: "p", serviceId: "s", generation: "g" }] },
  });
  await f.connectMain();
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
  await f.connectMain();
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
    await f.connectMain();
    await f.backend.command("connect", { projectId: "p", threadId: "t" });
    const command = f.calls.find((call) => call.method === "command");
    assert.deepEqual(
      command.params.request,
      supported ? { projectId: "p", threadId: "t" } : { projectId: "p" },
    );
  });
}
