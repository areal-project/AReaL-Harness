// 磁盘 journal + 生产 Gateway/Backend；原生 RPC 为确定性 fixture，不是原生验收。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const { CoreBackend } = require("../app/src/core/backend.cjs");
const { sessionCommand } = require("../app/src/core/remote-session-commands.cjs");
const home = await mkdtemp("/private/tmp/rc05-fixture-");
const checks = [];
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
async function fixture(name) {
  const root = join(home, name);
  await mkdir(root);
  const backend = new CoreBackend({ home: root, binary: "/unused", onChange() {} });
  backend.saved = [
    { id: "p", root },
    { id: "q", root },
  ];
  backend.start =
    backend.launch =
    backend.connect =
    backend.openThread =
    backend.reconcileConfiguration =
      () => {
        throw new Error("forbidden side effect");
      };
  let calls = [],
    receipts = new Map();
  const client = {
    ready: true,
    capabilities: {
      features: { threadStartAdmissionGuard: true, turnStartAdmissionGuard: true, permissionPresets: true },
      methods: ["areal/thread/start", "areal/turn/start"],
    },
    request(method, params) {
      calls.push({ method, params });
      if (method === "areal/request/read")
        return Promise.resolve({ data: receipts.get(params.requestId) ?? [] });
      const result =
        method === "areal/thread/start"
          ? { thread: { id: randomUUID() } }
          : { turn: { id: randomUUID() } };
      receipts.set(params.requestId, [
        {
          method, requestId: params.requestId,
          threadId: result.thread?.id ?? params.threadId,
          result: method === "areal/thread/start" ? null : result,
        },
      ]);
      return Promise.resolve(result);
    },
  };
  for (const id of ["p", "q"]) {
    const project = await backend.loadProjectJournal(id);
    project.client = client;
    project.model.connection(true);
    project.service = { generation: "g", serviceId: "s" };
  }
  const remote = {
    backend,
    config: {
      identity: {},
      deviceGrants: ["a", "b"].map((devicePeerId) => ({
        devicePeerId,
        status: "active",
        revision: 1,
        projectIds: ["p", "q"],
        capabilities: ["observe", "submit"],
      })),
    },
    crypto: { identityId: () => "h" },
    gatewayGeneration: "gw",
  };
  const connection = { peer: "a", grantRevision: 1, gatewayGeneration: "gw", alive: () => true };
  const request = (
    method = "session.create",
    params = {},
    commandId = randomUUID(),
    projectId = "p",
  ) => ({
    id: randomUUID(),
    method,
    commandId,
    context: {
      projectId,
      grantRevision: connection.grantRevision,
      gatewayGeneration: "gw",
      serviceGeneration: "g",
    },
    params,
  });
  const run = (request, conn = connection) =>
    sessionCommand(
      remote,
      conn,
      request,
      (result) => result,
      async () => ({
        ownership: { kind: "ordinary" },
        status: request.method === "turn.stop" ? "active" : "idle",
        activeTurnId: request.params.expectedTurnId,
        configRevision: request.params.expectedConfigRevision,
        queue: {},
      }),
    );
  const read = (id, projectId = "p", conn = connection) =>
    run(
      {
        id: randomUUID(),
        method: "command.read",
        context: { projectId },
        params: { commandId: id },
      },
      conn,
    );
  return {
    backend,
    project: backend.projects.get("p"),
    client,
    calls,
    receipts,
    remote,
    connection,
    request,
    run,
    read,
  };
}
async function check(name, test) {
  await test(await fixture(name));
  checks.push(name);
}
await check("same-key-concurrent-scoped-and-conflict", async (f) => {
  const req = f.request();
  const [a, b] = await Promise.all([f.run(req), f.run(req)]);
  assert.equal(a.operationId, b.operationId);
  assert.equal(f.calls.filter((x) => x.method === "areal/thread/start").length, 1);
  assert.equal((await f.read(req.commandId)).threadId, a.threadId);
  await assert.rejects(
    f.run({
      ...req,
      method: "session.send",
      params: { threadId: "t", expectedConfigRevision: 1, text: "x" },
    }),
    { code: "COMMAND_CONFLICT" },
  );
  const other = await f.run(req, { ...f.connection, peer: "b" });
  assert.notEqual(other.operationId, a.operationId);
  const project = await f.run({ ...req, context: { ...req.context, projectId: "q" } });
  assert.notEqual(project.operationId, a.operationId);
});
await check("create-missing-configuration-is-actionable-and-durable", async (f) => {
  f.client.request = async () => {
    throw Object.assign(new Error("PRIVATE_PROVIDER_OR_PROFILE"), { code: -32004 });
  };
  const request = f.request();
  const result = await f.run(request);
  assert.equal(result.admissionState, "rejected");
  assert.equal(result.error.code, "CONFIGURATION_UNAVAILABLE");
  assert.match(result.error.message, /桌面.*默认模型/);
  assert.ok(!JSON.stringify(result).includes("PRIVATE_PROVIDER_OR_PROFILE"));
  assert.deepEqual((await f.read(request.commandId)).error, result.error);
});
await check("pending-write-failure-no-dispatch", async (f) => {
  const save = f.backend.save.bind(f.backend);
  f.backend.save = (name, value) =>
    name.endsWith("-pending.json") ? Promise.reject(new Error("disk failed")) : save(name, value);
  await assert.rejects(f.run(f.request()), /disk failed/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.project.pending.length, 0);
});
await check("pending-durability-before-rpc-and-revoke", async (f) => {
  const save = f.backend.save.bind(f.backend),
    held = deferred(),
    entered = deferred();
  f.backend.save = async (name, value) => {
    if (name.endsWith("-pending.json") && value.length) {
      entered.resolve();
      await held.promise;
    }
    return save(name, value);
  };
  const run = f.run(f.request());
  await entered.promise;
  f.remote.writes = Promise.resolve().then(() => {
    f.remote.config.deviceGrants[0].status = "revoked";
  });
  await f.remote.writes;
  held.resolve();
  await assert.rejects(run, { code: "GRANT_CHANGED" });
  assert.equal(f.calls.length, 0);
  const outcomes = JSON.parse(await readFile(join(f.backend.home, "p-outcomes.json")));
  assert.equal(Object.values(outcomes)[0].admissionState, "rejected");
});
await check("revoke-not-blocked-by-response-outcome-saved", async (f) => {
  const entered = deferred(),
    held = deferred();
  const original = f.client.request;
  f.client.request = async (method, params) => {
    const result = await original(method, params);
    if (method !== "areal/request/read") {
      entered.resolve();
      await held.promise;
    }
    return result;
  };
  const req = f.request(),
    running = f.run(req);
  await entered.promise;
  await f.remote.writes.then(() => {
    f.remote.config.deviceGrants[0].status = "revoked";
  });
  held.resolve();
  await assert.rejects(running, { code: "GRANT_CHANGED" });
  assert.equal(Object.values(f.project.outcomes)[0].admissionState, "accepted");
  f.remote.config.deviceGrants[0].status = "active";
  f.remote.config.deviceGrants[0].revision = 2;
  f.connection.grantRevision = 2;
  const recovered = await f.read(req.commandId);
  assert.equal(recovered.admissionState, "accepted");
  assert.equal(Object.values(f.project.outcomes)[0].remote.admittedGrantRevision, 1);
  assert.equal(f.calls.length, 1);
});
await check("outcome-before-pending-removal-and-offline-restart", async (f) => {
  const save = f.backend.save.bind(f.backend);
  f.backend.save = (name, value) =>
    name.endsWith("-pending.json") && !value.length
      ? Promise.reject(new Error("crash"))
      : save(name, value);
  const req = f.request(),
    result = await f.run(req);
  assert.equal(result.admissionState, "accepted");
  assert.equal(f.project.pending.length, 1);
  const next = new CoreBackend({ home: f.backend.home, binary: "/unused" });
  next.saved = f.backend.saved;
  f.remote.backend = next;
  const [p, q] = await Promise.all([next.loadProjectJournal("p"), next.loadProjectJournal("p")]);
  assert.equal(p, q);
  const recovered = await f.read(req.commandId);
  assert.equal(recovered.operationId, result.operationId);
  assert.equal(recovered.threadId, result.threadId);
  assert.equal(f.calls.length, 1);
  assert.equal(p.client, undefined);
});
await check("outcome-write-failed-receipt-only-recovery-and-dismiss-race", async (f) => {
  const save = f.backend.save.bind(f.backend);
  let fail = true;
  f.backend.save = (name, value) =>
    fail && name.endsWith("-outcomes.json")
      ? Promise.reject(new Error("disk failed"))
      : save(name, value);
  const req = f.request(),
    unknown = await f.run(req);
  assert.equal(unknown.admissionState, "unknown");
  assert.equal(f.project.pending.length, 1);
  fail = false;
  f.backend.listThreads = async () => {};
  f.backend.requireConnection = () => {};
  f.backend.start = async () => f.project;
  const [result] = await Promise.all([
    f.read(req.commandId),
    f.backend.reconcile(f.project),
    f.backend.command("dismissRecovery", { projectId: "p", requestId: unknown.operationId }),
  ]);
  assert.equal(result.admissionState, "accepted");
  await f.backend.command("dismissRecovery", { projectId: "p", requestId: unknown.operationId });
  assert.equal(f.project.outcomes[unknown.operationId].remote.commandId, req.commandId);
  assert.equal(f.calls.filter((x) => x.method === "areal/thread/start").length, 1);
  assert.ok(f.calls.every((x) => ["areal/thread/start", "areal/request/read"].includes(x.method)));
});
await check("send-unknown-missing-receipt-blocks-and-native-guards", async (f) => {
  const params = { threadId: "t", expectedConfigRevision: 7, text: "hello" };
  const req = f.request("session.send", params);
  const original = f.client.request;
  f.client.request = (method, params) =>
    method === "areal/turn/start"
      ? (f.calls.push({ method, params }),
        Promise.reject(Object.assign(new Error("lost"), { submissionUnknown: true })))
      : original(method, params);
  const result = await f.run(req);
  assert.equal(result.admissionState, "unknown");
  assert.deepEqual(f.calls[0].params.admissionGuard, { ordinarySession: true, configRevision: 7 });
  assert.equal((await f.read(req.commandId)).admissionState, "unknown");
  await assert.rejects(f.run(f.request("session.send", params)), { code: "SUBMISSION_UNKNOWN" });
  await assert.rejects(f.run({ ...req, params: { ...params, text: "changed" } }), {
    code: "COMMAND_CONFLICT",
  });
  assert.equal(f.calls.filter((x) => x.method === "areal/turn/start").length, 1);
});
await check("send-authoritative-ownership-precedes-cached-busy-without-writes", async (f) => {
  let admissions = 0,
    writes = 0;
  const submit = f.backend.submit.bind(f.backend);
  f.backend.submit = (...args) => {
    admissions++;
    return submit(...args);
  };
  const save = f.backend.save.bind(f.backend);
  f.backend.save = (...args) => {
    writes++;
    return save(...args);
  };
  const results = [];
  for (const scenario of [
    "task-cached-busy",
    "ordinary-cached-busy",
    "task-busy-during-observation",
  ]) {
    const entered = deferred(),
      release = deferred();
    const delayed = scenario === "task-busy-during-observation";
    const thread = { id: scenario, turns: delayed ? [] : [{ id: "held", status: "inProgress" }] };
    f.project.model.state.threads[scenario] = thread;
    const request = f.request("session.send", {
      threadId: scenario,
      expectedConfigRevision: 1,
      text: "retained draft",
    });
    const result = sessionCommand(
      f.remote,
      f.connection,
      request,
      (value) => value,
      async () => {
        entered.resolve();
        if (delayed) await release.promise;
        return {
          ownership:
            scenario === "ordinary-cached-busy"
              ? { kind: "ordinary" }
              : { kind: "task", taskId: "task", runId: "queued-run" },
          status: "active",
          activeTurnId: "held",
          configRevision: 1,
          queue: {},
        };
      },
    ).then(
      () => "unexpected acceptance",
      (error) => error.code,
    );
    if (delayed) {
      await entered.promise;
      thread.turns = [{ id: "held", status: "inProgress" }];
      release.resolve();
    }
    results.push(await result);
  }
  assert.equal(admissions, 0);
  assert.equal(writes, 0);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.project.pending, []);
  assert.deepEqual(f.project.outcomes, {});
  assert.deepEqual(results, ["TASK_CONTROL_REQUIRED", "TURN_BUSY", "TASK_CONTROL_REQUIRED"]);
});
await check("paused-empty-queue-allows-explicit-send-but-pending-queue-stays-blocked", async (f) => {
  const send = (queue) => sessionCommand(f.remote, f.connection,
    f.request("session.send", {threadId:"t",expectedConfigRevision:1,text:"explicit follow-up"}),
    value => value, async () => ({ownership:{kind:"ordinary"},status:"idle",configRevision:1,queue}));
  const accepted = await send({paused:true,pendingCount:0});
  assert.equal(accepted.admissionState,"accepted");
  const calls = f.calls.length;
  for (const paused of [true,false]) {
    await assert.rejects(send({paused,pendingCount:1}),{code:"TARGET_CHANGED"});
    assert.equal(f.calls.length,calls,"pending queue must never reach native dispatch");
  }
});
await check("utf8-invalid-grants-capabilities-and-configuration", async (f) => {
  const params = { threadId: "t", expectedConfigRevision: 1, text: "界".repeat(21846) };
  await assert.rejects(f.run(f.request("session.send", params)), { code: "INVALID_PARAMS" });
  delete f.client.capabilities.features.threadStartAdmissionGuard;
  await assert.rejects(f.run(f.request()), { code: "CORE_INCOMPATIBLE" });
  f.project.configurationChanges.set("t", true);
  await assert.rejects(f.run(f.request("session.send", { ...params, text: "ok" })), {
    code: "TARGET_CHANGED",
  });
  f.remote.config.deviceGrants[0].capabilities = ["observe"];
  assert.equal((await f.read(randomUUID())).admissionState, "notFound");
  assert.equal(f.calls.length, 0);
});
await check("serialized-read-never-sees-newer-provisional-association", async (f) => {
  const first = deferred(),
    outcome = deferred(),
    second = deferred(),
    entered = deferred();
  const save = f.backend.save.bind(f.backend);
  const association = { hostId: "h", devicePeerId: "a", projectId: "p", commandId: randomUUID() };
  const entry = {
    operationId: randomUUID(),
    method: "areal/thread/start",
    params: { requestId: randomUUID() },
    remote: association,
  };
  f.backend.save = async (name, value) => {
    if (name.endsWith("-pending.json")) {
      if (value.length) {
        entered.resolve();
        await second.promise;
        throw new Error("second save failed");
      }
      await first.promise;
    }
    return save(name, value);
  };
  const p1 = f.backend.changePending(f.project, () => []);
  f.project.outcomeWrite = outcome.promise;
  const reader = f.backend.readRemoteRecord(f.project, association);
  const p2 = f.backend.changePending(f.project, () => [entry]);
  const failed = assert.rejects(p2, /second save failed/);
  first.resolve();
  await p1;
  await Promise.resolve();
  outcome.resolve();
  assert.equal(await reader, null);
  await entered.promise;
  second.resolve();
  await failed;
  assert.equal(f.project.pending.length, 0);
  assert.equal(f.calls.length, 0);
});
await check("terminal-duplicate-does-not-block-next-send", async (f) => {
  const save = f.backend.save.bind(f.backend);
  let fail = true;
  f.backend.save = (name, value) =>
    fail && name.endsWith("-pending.json") && !value.length
      ? Promise.reject(new Error("remove failed"))
      : save(name, value);
  const first = f.request("session.send", {
    threadId: "t",
    expectedConfigRevision: 1,
    text: "one",
  });
  const result = await f.run(first);
  assert.equal(result.admissionState, "accepted");
  assert.equal(f.project.pending.length, 1);
  const next = await f.run(
    f.request("session.send", { threadId: "t", expectedConfigRevision: 1, text: "two" }),
  );
  assert.equal(next.admissionState, "accepted");
  fail = false;
  await f.read(first.commandId);
  assert.equal(f.project.pending.length, 0);
});
await check("journal-project-replacement-and-unregister", async (f) => {
  const old = f.project;
  f.backend.projects.delete("p");
  const replacement = await f.backend.loadProjectJournal("p");
  assert.notEqual(replacement, old);
  assert.equal(await f.backend.loadProjectJournal("p"), replacement);
  f.backend.saved = f.backend.saved.filter((value) => value.id !== "p");
  await assert.rejects(f.backend.loadProjectJournal("p"), /未知项目/);
});
await check("admission-observer-preserves-current-detail", async (f) => {
  const { SessionObservers } = require("../app/src/core/remote-session-observer.cjs");
  Object.assign(f.client.capabilities.features, {
    atomicObserve: true,
    atomicObserveOwnership: true,
    subscriptionRemoval: true,
  });
  Object.assign(f.project, { endpoint: "ws://fixture", token: "fixture" });
  const observers = new SessionObservers(f.remote),
    events = [];
  const connection = {
    ...f.connection,
    connectionId: "detail",
    send: (value) => events.push(value),
    close() {
      throw new Error("must not close detail");
    },
  };
  const entry = {
    projectId: "p",
    project: f.project,
    desktop: f.client,
    endpoint: f.project.endpoint,
    token: f.project.token,
    serviceId: "s",
    generation: "g",
    gatewayGeneration: "gw",
    threads: new Map(),
    pending: 0,
    tail: Promise.resolve(),
    ready: Promise.resolve(),
    closed: false,
    client: { close() {} },
  };
  observers.projects.set("p", entry);
  let reads = 0;
  observers.rpc = async (_entry, method, params, onResult) => {
    if (method === "areal/thread/observe") {
      reads++;
      onResult({
        thread: {
          id: params.threadId,
          status: { type: "idle" },
          turns: [],
          desktop: { configuration: { revision: 1 }, queue: { items: [] } },
        },
        ownership: { kind: "ordinary" },
      });
    }
  };
  try {
    let baseline;
    await observers.open(connection, "p", "t", (value) => (baseline = value));
    const viewer = observers.viewers.get("detail");
    const admission = await observers.admission(connection, "p", "t");
    assert.equal(admission.ownership.kind, "ordinary");
    assert.equal(observers.viewers.get("detail"), viewer);
    assert.equal(viewer.id, baseline.subscriptionId);
    assert.equal(viewer.thread.viewers.size, 1);
    observers.event(entry, "areal/queue/updated", {
      threadId: "t",
      queue: { items: [], paused: true },
    });
    assert.equal(events.at(-1).subscriptionId, baseline.subscriptionId);
    assert.equal(events.at(-1).snapshot.queue.paused, true);
    assert.equal(reads, 2);
  } finally {
    observers.close();
  }
});
await check("recovery-identity-change-and-bounded-outcomes", async (f) => {
  const original = f.client.request;
  f.client.request = (method, params) =>
    method === "areal/thread/start"
      ? Promise.resolve({ thread: { id: "x".repeat(129) } })
      : original(method, params);
  const req = f.request();
  assert.equal((await f.run(req)).admissionState, "unknown");
  assert.equal(Object.keys(f.project.outcomes).length, 0);
  f.client.request = async (method, params) => {
    if (method === "areal/request/read") {
      f.project.service.generation = "changed";
      return { data: [] };
    }
    return original(method, params);
  };
  await assert.rejects(f.read(req.commandId), { code: "RESYNC_REQUIRED" });
});
await check("actual-noise-direct-create-schema-and-offline-query", async (f) => {
  const crypto = await import("../packages/remote/src/channel.mjs");
  const { once } = await import("node:events");
  const WebSocket = require("../app/node_modules/ws");
  const { startDirect } = require("../app/src/core/remote-direct.cjs");
  const device = await crypto.createIdentity();
  f.remote.crypto = crypto;
  f.remote.config.identity = await crypto.createIdentity();
  f.remote.config.directEnabled = true;
  enableStop(f);
  f.remote.config.deviceGrants[0].devicePeerId = crypto.identityId(device);
  f.remote.sessions = new (require("../app/src/core/remote-session-acceptor.cjs").SessionAcceptor)(
    f.remote,
  );
  const direct = await startDirect(f.remote);
  let secure;
  try {
    const socket = new WebSocket(direct.ws, { origin: direct.origin });
    await once(socket, "open");
    const wire = crypto.byteChannel(
      (bytes) => socket.send(bytes),
      () => socket.close(),
    );
    socket.on("message", (bytes) => wire.receive(bytes));
    socket.on("close", () => wire.close());
    secure = await crypto.secureChannel(wire, device, crypto.identityId(f.remote.config.identity));
    const messages = secure.messages();
    secure.send({
      method: "hello",
      apiVersion: "areal.remote.v2",
      clientVersion: "fixture",
      displayName: "fixture",
    });
    const ready = (await messages.next()).value;
    assert.ok(ready.capabilities.includes("submit"));
    assert.ok(ready.capabilities.includes("interrupt"));
    const request = f.request();
    request.id = "create";
    secure.send(request);
    const result = (await messages.next()).value.result;
    assert.equal(result.admissionState, "accepted");
    secure.send({ ...request, id: "duplicate" });
    assert.equal((await messages.next()).value.result.operationId, result.operationId);
    secure.send({ ...request, id: "bad", params: { cwd: "/injected" } });
    assert.equal((await messages.next()).value.error.code, "INVALID_PARAMS");
    // 真正的文件写入失败产生带绝对路径的 ENOENT；Noise 响应只能含固定协议文案。
    const originalHome = f.backend.home;
    f.backend.home = join(originalHome, "PRIVATE_HOST_PATH_SECRET");
    secure.send({ ...f.request(), id: "disk-write" });
    const disk = (await messages.next()).value;
    assert.equal(disk.error.code, "CORE_UNAVAILABLE");
    assert.equal(disk.error.submissionUnknown, true);
    assert.ok(!JSON.stringify(disk).includes(originalHome));
    assert.ok(!JSON.stringify(disk).includes("PRIVATE_HOST_PATH_SECRET"));
    f.backend.home = originalHome;
    const load = f.backend.loadProjectJournal.bind(f.backend);
    for (const code of ["EACCES", "ENOSPC", "TARGET_CHANGED"]) {
      f.backend.loadProjectJournal = async () => {
        throw Object.assign(new Error(`${code}: open ${originalHome}/JOURNAL_SECRET_TOKEN`), {
          code,
        });
      };
      secure.send({ ...f.request(), id: code });
      const refusal = (await messages.next()).value;
      assert.equal(refusal.error.code, code === "TARGET_CHANGED" ? code : "CORE_UNAVAILABLE");
      assert.ok(!JSON.stringify(refusal).includes(originalHome));
      assert.ok(!JSON.stringify(refusal).includes("JOURNAL_SECRET_TOKEN"));
    }
    f.backend.loadProjectJournal = load;
    const stop = f.request("turn.stop", { threadId: "t", expectedTurnId: "A" });
    const savedStop = await f.run(stop, { ...f.connection, peer: crypto.identityId(device) });
    secure.send({ ...stop, id: "stop-duplicate" });
    const stopReceipt = (await messages.next()).value.result;
    assert.equal(stopReceipt.operationId, savedStop.operationId);
    assert.equal(Object.hasOwn(stopReceipt, "nativeRequestId"), false);
    secure.send({ ...stop, id: "stop-missing-target", params: { threadId: "t" } });
    assert.equal((await messages.next()).value.error.code, "INVALID_PARAMS");
    secure.send({ ...stop, id: "stop-conflict", params: { threadId: "t", expectedTurnId: "B" } });
    assert.equal((await messages.next()).value.error.code, "COMMAND_CONFLICT");
    f.project.client.ready = false;
    f.project.model.connection(false);
    secure.send({
      id: "read",
      method: "command.read",
      context: { projectId: "p" },
      params: { commandId: request.commandId },
    });
    assert.equal((await messages.next()).value.result.threadId, result.threadId);
    assert.equal(f.calls.length, 2);
  } finally {
    secure?.close();
    direct.close();
    f.remote.sessions.close();
  }
});
await check("capacity-no-eviction-and-immutable-native-params", async (f) => {
  f.project.outcomes = Object.fromEntries(
    Array.from({ length: 4096 }, (_, i) => [String(i), { accepted: true }]),
  );
  await assert.rejects(f.run(f.request()), { code: "CAPACITY_EXCEEDED" });
  assert.equal(Object.keys(f.project.outcomes).length, 4096);
  assert.equal(f.calls.length, 0);
  f.project.outcomes = {};
  f.backend.defaultProfile = { id: "profile", revision: "v1" };
  const save = f.backend.save.bind(f.backend),
    held = deferred(),
    entered = deferred();
  f.backend.save = async (name, value) => {
    if (name.endsWith("-pending.json") && value.length) {
      entered.resolve();
      await held.promise;
    }
    return save(name, value);
  };
  const req = f.request(),
    result = f.run(req);
  await entered.promise;
  f.backend.defaultProfile.revision = "v2";
  held.resolve();
  const accepted = await result;
  assert.equal(f.calls[0].params.agentProfile.revision, "v1");
  assert.equal("params" in f.project.outcomes[accepted.operationId], false);
  const duplicate = await f.run({ ...req, commandId: req.commandId.toUpperCase() });
  assert.equal(duplicate.operationId, accepted.operationId);
  assert.equal(f.calls.length, 1);
});
// 两个请求先同时读到无关联；第二个观察延迟到第一条命令持久受理之后。
async function delayedSendPair(f, suffix, refusal, expectedError, changedText = false) {
  const entered = deferred(),
    release = deferred();
  const request = f.request("session.send", {
    threadId: `delayed-${suffix}`,
    expectedConfigRevision: 1,
    text: "original",
  });
  const idle = { ownership: { kind: "ordinary" }, status: "idle", configRevision: 1, queue: {} };
  let observations = 0;
  const observe = async () => {
    if (++observations === 1) {
      await entered.promise;
      return idle;
    }
    entered.resolve();
    await release.promise;
    return refusal(idle);
  };
  const before = f.calls.filter((value) => value.method === "areal/turn/start").length;
  const run = (value) => sessionCommand(f.remote, f.connection, value, (result) => result, observe);
  const first = run(request);
  const second = run(
    changedText ? { ...request, params: { ...request.params, text: "changed" } } : request,
  );
  await entered.promise;
  const accepted = await first;
  assert.equal(accepted.admissionState, "accepted");
  release.resolve();
  if (expectedError) await assert.rejects(second, { code: expectedError });
  else {
    const original = await second;
    assert.equal(original.admissionState, "accepted");
    assert.equal(original.operationId, accepted.operationId);
    assert.equal(original.turnId, accepted.turnId);
  }
  assert.equal(f.calls.filter((value) => value.method === "areal/turn/start").length, before + 1);
}
await check("delayed-send-dedup-precedes-all-new-admission-refusals", async (f) => {
  await delayedSendPair(f, "busy", (state) => ({
    ...state,
    status: "active",
    activeTurnId: "native-turn",
  }));
  await delayedSendPair(f, "config", (state) => ({ ...state, configRevision: 2 }));
  await delayedSendPair(f, "queue", (state) => ({ ...state, queue: { paused: true } }));
  await delayedSendPair(f, "task", (state) => ({ ...state, ownership: { kind: "task" } }));
  await delayedSendPair(f, "observer", () => {
    throw Object.assign(new Error("observer full"), { code: "LIMIT_EXCEEDED" });
  });
  await delayedSendPair(f, "changing", (state) => {
    f.project.configurationChanges.set("delayed-changing", true);
    return state;
  });
  f.project.configurationChanges.clear();
  await delayedSendPair(f, "capability", (state) => {
    f.client.capabilities.features.turnStartAdmissionGuard = false;
    return state;
  });
  f.client.capabilities.features.turnStartAdmissionGuard = true;
  await delayedSendPair(f, "offline", (state) => {
    f.client.ready = false;
    f.project.model.connection(false);
    return state;
  });
});
await check("delayed-send-keeps-semantic-conflict-and-auth-identity-fences", async (f) => {
  await delayedSendPair(
    f,
    "changed",
    (state) => ({ ...state, status: "active" }),
    "COMMAND_CONFLICT",
    true,
  );
  await delayedSendPair(
    f,
    "grant",
    (state) => {
      f.remote.config.deviceGrants[0].status = "revoked";
      return state;
    },
    "GRANT_CHANGED",
  );
  f.remote.config.deviceGrants[0].status = "active";
  await delayedSendPair(
    f,
    "identity",
    (state) => {
      f.project.service.generation = "replaced";
      return state;
    },
    "RESYNC_REQUIRED",
  );
});
await check("stop-exact-target-durable-and-no-native-request-id", async (f) => {
  f.remote.config.deviceGrants[0].capabilities = ["observe", "interrupt"];
  f.client.capabilities.features.turnInterruptAdmissionGuard = true;
  f.client.capabilities.methods.push("turn/interrupt");
  const req = f.request("turn.stop", { threadId: "t", expectedTurnId: "A" });
  const native = f.client.request;
  f.client.request = async (method, params) => {
    if (method === "turn/interrupt") {
      assert.deepEqual(params, {
        threadId: "t",
        turnId: "A",
        admissionGuard: { ordinarySession: true },
      });
      const pending = JSON.parse(await readFile(join(f.backend.home, "p-pending.json"), "utf8"));
      assert.equal(pending[0].operationId.length, 36);
      f.calls.push({ method, params });
      return {};
    }
    return native(method, params);
  };
  const result = await f.run(req);
  assert.equal(result.admissionState, "accepted");
  assert.equal(result.turnId, "A");
  assert.equal(Object.hasOwn(result, "nativeRequestId"), false);
  assert.deepEqual(result.target, req.params);
  assert.equal((await f.run(req)).operationId, result.operationId);
  assert.equal((await f.read(req.commandId)).operationId, result.operationId);
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.run({ ...req, params: { ...req.params, expectedTurnId: "B" } }), {
    code: "COMMAND_CONFLICT",
  });
});
function enableStop(f) {
  for (const grant of f.remote.config.deviceGrants) grant.capabilities.push("interrupt");
  f.client.capabilities.features.turnInterruptAdmissionGuard = true;
  f.client.capabilities.methods.push("turn/interrupt");
}
await check("stop-strict-schema-target-change-and-task-ownership", async (f) => {
  enableStop(f);
  for (const params of [
    {},
    { threadId: "t" },
    { threadId: "t", expectedTurnId: "" },
    { threadId: "t", expectedTurnId: "A", turnId: "B" },
    { threadId: "t", expectedTurnId: "界".repeat(129) },
  ])
    await assert.rejects(f.run(f.request("turn.stop", params)), { code: "INVALID_PARAMS" });
  const req = f.request("turn.stop", { threadId: "t", expectedTurnId: "A" });
  for (const state of [
    { ownership: { kind: "ordinary" }, activeTurnId: "B" },
    {
      ownership: { kind: "ordinary" },
      activeTurnId: null,
      turns: [{ id: "A", status: "completed" }],
    },
    { ownership: { kind: "task" }, activeTurnId: "A" },
  ])
    await assert.rejects(
      sessionCommand(
        f.remote,
        f.connection,
        req,
        (x) => x,
        async () => state,
      ),
      {
        code: state.ownership.kind === "ordinary" ? "TARGET_CHANGED" : "TASK_CONTROL_REQUIRED",
      },
    );
  assert.equal(f.calls.length, 0);
  f.client.capabilities.features.turnInterruptAdmissionGuard = false;
  await assert.rejects(f.run(req), { code: "CORE_INCOMPATIBLE" });
  f.remote.config.deviceGrants[0].capabilities = ["observe", "submit"];
  await assert.rejects(f.run(req), { code: "FORBIDDEN" });
});
await check("stop-unknown-never-queries-replays-or-blocks-another-device", async (f) => {
  enableStop(f);
  const req = f.request("turn.stop", { threadId: "t", expectedTurnId: "A" });
  const held = deferred(),
    entered = deferred();
  f.client.request = async (method, params) => {
    assert.equal(method, "turn/interrupt");
    f.calls.push({ method, params });
    entered.resolve();
    await held.promise;
    throw Object.assign(new Error("lost response"), { code: -32603 });
  };
  const first = f.run(req);
  await entered.promise;
  const duplicate = await f.run(req);
  assert.equal(duplicate.admissionState, "pending");
  const other = f.run(req, { ...f.connection, peer: "b" });
  while (f.calls.length < 2) await new Promise((r) => setTimeout(r, 1));
  held.resolve();
  const result = await first;
  assert.equal(result.admissionState, "unknown");
  assert.notEqual((await other).operationId, result.operationId);
  f.project.model.state.threads.t = {
    id: "t",
    turns: [
      { id: "A", status: "interrupted" },
      { id: "B", status: "inProgress" },
    ],
  };
  assert.equal((await f.read(req.commandId)).admissionState, "unknown");
  assert.equal((await f.run(req)).operationId, result.operationId);
  assert.equal(f.calls.length, 2);
  f.client.ready = false;
  assert.equal((await f.read(req.commandId)).admissionState, "unknown");
  f.remote.config.deviceGrants[0].capabilities = ["observe", "submit"];
  await assert.rejects(f.read(req.commandId), { code: "FORBIDDEN" });
  f.remote.config.deviceGrants[0].capabilities = ["observe", "interrupt"];
  assert.equal((await f.read(req.commandId)).operationId, result.operationId);
});
await check("stop-final-fences-revoke-and-native-race", async (f) => {
  enableStop(f);
  const req = f.request("turn.stop", { threadId: "t", expectedTurnId: "A" });
  const save = f.backend.save.bind(f.backend);
  f.backend.save = async (name, value) => {
    await save(name, value);
    if (name.endsWith("-pending.json") && value.length)
      f.remote.writes = Promise.resolve().then(() => {
        f.remote.config.deviceGrants[0].status = "revoked";
      });
  };
  await assert.rejects(f.run(req), { code: "GRANT_CHANGED" });
  assert.equal(f.calls.length, 0);
  f.backend.save = save;
  f.remote.config.deviceGrants[0].status = "active";
  const held = deferred(),
    entered = deferred();
  f.client.request = async (method, params) => {
    f.calls.push({ method, params });
    assert.equal(params.turnId, "A");
    entered.resolve();
    await held.promise;
    throw Object.assign(new Error("native target changed"), { code: -32009 });
  };
  const racing = f.request("turn.stop", req.params);
  const running = f.run(racing);
  await entered.promise;
  await (f.remote.writes = f.remote.writes.then(() => {
    f.remote.config.deviceGrants[0].status = "revoked";
  }));
  held.resolve();
  await assert.rejects(running, { code: "GRANT_CHANGED" });
  f.remote.config.deviceGrants[0].status = "active";
  const saved = await f.read(racing.commandId);
  assert.equal(saved.admissionState, "rejected");
  assert.equal(saved.error.code, "TARGET_CHANGED");
  assert.equal(saved.target.expectedTurnId, "A");
  assert.equal(f.calls.length, 1);
});
await check("unknown-stop-preserves-journal-without-blocking-desktop", async (f) => {
  enableStop(f);
  const req = f.request("turn.stop", { threadId: "t", expectedTurnId: "A" });
  f.client.request = async (method, params) => {
    f.calls.push({ method, params });
    if (method === "turn/interrupt")
      throw Object.assign(new Error("disconnect"), { submissionUnknown: true });
    if (method === "areal/thread/inspect")
      return { configuration: { revision: 1 }, activeTurnId: null };
    if (method === "areal/thread/configure") return { revision: 2 };
    if (method === "areal/turn/start") return { turn: { id: "B" } };
    throw new Error(`Unexpected native request: ${method}`);
  };
  const original = await f.run(req);
  f.project.model.state.threads.t = {
    id: "t",
    status: { type: "idle" },
    turns: [{ id: "A", status: "interrupted", items: [] }],
  };
  assert.equal(f.backend.snapshot().projects[0].pending.length, 0);
  assert.equal(f.backend.hasWork(), false);
  await f.backend.configureThread(f.project, "t", { options: {}, expectedRevision: 1 });
  const later = await f.backend.submit(f.project, "areal/turn/start", {
    threadId: "t",
    input: [{ type: "text", text: "later desktop send" }],
    expectedConfigRevision: 2,
  });
  assert.equal(later.turn.id, "B");
  assert.deepEqual(await f.read(req.commandId), original);
  assert.equal(f.calls.filter((call) => call.method === "turn/interrupt").length, 1);
  const unknownSend = {
    method: "areal/turn/start",
    params: { threadId: "t", requestId: randomUUID() },
  };
  await f.backend.changePending(f.project, (pending) => [...pending, unknownSend]);
  assert.equal(f.backend.snapshot().projects[0].pending.length, 1);
  await assert.rejects(
    f.backend.submit(f.project, "areal/turn/start", { threadId: "t" }),
    /结果未知/,
  );
});
console.log(
  JSON.stringify({ kind: "fixture-contract", checks, passed: checks.length, home }, null, 2),
);
