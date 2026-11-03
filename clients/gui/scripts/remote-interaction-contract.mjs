import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { makeTempDir } from "./support/temp.mjs";
import { join } from "node:path";
import { taskContractHost, taskContractProject as PROJECT } from "./remote-task-contract-host.mjs";
const require = createRequire(import.meta.url);
const { InteractionReviews } = require("../app/src/core/remote-interactions.cjs");
const { SessionObservers } = require("../app/src/core/remote-session-observer.cjs");
const { CoreBackend } = require("../app/src/core/backend.cjs");
const { sessionCommand } = require("../app/src/core/remote-session-commands.cjs");
const { RemotePush } = require("../app/src/core/remote-push.cjs");
const rustOwner = process.env.AREAL_REMOTE_OWNER === "rust";
const home = rustOwner ? undefined : await makeTempDir("rc07-contract-");
const checks = [];
const owner = rustOwner ? undefined : await taskContractHost();
const defer = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
async function fixture(name) {
  const root = join(home, name);
  await mkdir(root);
  const backend = new CoreBackend({ home: root, binary: "/unused", onChange() {} });
  backend.saved = [{ id: PROJECT, root }];
  const storage = await owner.register(backend, root);
  const project = await backend.loadProjectJournal(PROJECT);
  project.service = { generation: "g", serviceId: "s" };
  project.endpoint = "ws://fixture";
  project.token = "fixture";
  project.model.connection(true);
  let afterRead;
  let item = {
    threadId: "t",
    turnId: "turn",
    requestId: "interaction",
    kind: "approval",
    status: "pending",
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    tool: "write_file",
    effectiveArguments: { path: "approved.txt", content: "exact" },
    effectivePermissions: { readOnly: false },
    argumentsDigest: "d".repeat(64),
    questions: [],
  };
  const calls = [];
  const client = (project.client = {
    ready: true,
    capabilities: {
      features: { atomicObserve: true, atomicObserveOwnership: true, subscriptionRemoval: true },
      methods: ["areal/interaction/list", "areal/interaction/respond"],
    },
    onClose: () => () => {},
    request: async (method, params) => {
      calls.push({ method, params: structuredClone(params) });
      assert.equal(method, "areal/interaction/respond");
      if (
        params.threadId !== item.threadId ||
        params.turnId !== item.turnId ||
        params.requestId !== item.requestId ||
        item.status !== "pending"
      )
        throw Object.assign(new Error("target changed"), { code: -32009 });
      item.status = "answered";
      return { revision: 2, interaction: structuredClone(item) };
    },
  });
  const remote = {
    backend,
    config: {
      identity: {},
      deviceGrants: ["a", "b"].map((devicePeerId) => ({
        devicePeerId,
        status: "active",
        revision: 1,
        projectIds: [PROJECT],
        capabilities: ["observe", "answer"],
      })),
    },
    crypto: { identityId: () => "h" },
    gatewayGeneration: "gw",
  };
  remote.push = new RemotePush(remote);
  const connection = {
    connectionId: "c",
    peer: "a",
    grantRevision: 1,
    gatewayGeneration: "gw",
    alive: () => true,
    send() {},
    close() {},
  };
  const observers = new SessionObservers(remote);
  observers.connect = async (entry) => {
    entry.client = {
      closed: false,
      close() {},
      request: async (method, params, options) => {
        let result;
        if (method === "areal/interaction/list") {
          result = { revision: 1, data: [structuredClone(item)] };
          await afterRead?.();
        } else if (method === "areal/thread/observe")
          result = { ownership: { kind: "ordinary" }, thread: { id: params.threadId, turns: [] } };
        else {
          assert.equal(method, "areal/subscription/remove");
          result = {};
        }
        options?.onResult?.(result);
        return result;
      },
    };
  };
  const reviews = new InteractionReviews(observers);
  const target = () => ({
    threadId: item.threadId,
    turnId: item.turnId,
    interactionId: item.requestId,
  });
  const read = (params = target(), conn = connection) =>
    reviews.read(conn, PROJECT, params, (x) => x);
  const request = (params, commandId = randomUUID()) => ({
    id: randomUUID(),
    method: "interaction.respond",
    commandId,
    context: {
      projectId: PROJECT,
      gatewayGeneration: "gw",
      grantRevision: 1,
      serviceGeneration: "g",
    },
    params,
  });
  const run = (req, conn = connection) =>
    sessionCommand(remote, conn, req, (x) => x, observers.admission.bind(observers), reviews);
  const commandRead = (commandId, conn = connection) =>
    run(
      {
        id: randomUUID(),
        method: "command.read",
        context: { projectId: PROJECT },
        params: { commandId },
      },
      conn,
    );
  const approval = async (decision) => {
    const page = await read();
    return {
      ...target(),
      argumentsDigest: page.argumentsDigest,
      decision,
      ...(page.reviewToken ? { reviewToken: page.reviewToken } : {}),
    };
  };
  return {
    ...storage,
    backend,
    project,
    remote,
    client,
    connection,
    observers,
    reviews,
    read,
    target,
    request,
    run,
    commandRead,
    approval,
    calls,
    set afterRead(value) {
      afterRead = value;
    },
    get item() {
      return item;
    },
    set item(value) {
      item = value;
    },
  };
}
async function check(name, test) {
  if (rustOwner) return;
  try {
    const f = await fixture(name);
    try {
      await test(f);
      checks.push(name);
    } finally {
      f.observers.close();
      f.remote.push.close();
    }
  } catch (error) {
    await owner.close();
    throw error;
  }
}
await check("bounded-authoritative-detail-preserves-session", async (f) => {
  await f.observers.open(f.connection, PROJECT, "t", () => {});
  const viewer = f.observers.viewers.get("c");
  const page = await f.read();
  assert.equal(page.threadId, "t");
  assert.equal(page.turnId, "turn");
  assert.equal(page.interactionId, "interaction");
  assert.equal(page.argumentsDigest, "d".repeat(64));
  assert.deepEqual(page.effectiveArguments, { path: "approved.txt", content: "exact" });
  assert.equal(page.complete, true);
  assert.ok(page.reviewToken);
  assert.equal(f.observers.viewers.get("c"), viewer);
  assert.equal(viewer.entry.closed, false);
  assert.equal(f.calls.length, 0);
});
await check("reviewed-approval-exact-native-identity-and-durable-dedup", async (f) => {
  const req = f.request(await f.approval("allowOnce"));
  const response = await f.run(req);
  assert.equal(response.admissionState, "accepted");
  assert.equal(response.turnId, "turn");
  assert.notEqual(response.operationId, "interaction");
  assert.deepEqual(f.calls[0].params, {
    threadId: "t",
    turnId: "turn",
    requestId: "interaction",
    decision: "allowOnce",
    argumentsDigest: "d".repeat(64),
  });
  assert.equal(
    (await f.run({ ...req, params: { ...req.params, reviewToken: "expired" } })).operationId,
    response.operationId,
  );
  assert.equal((await f.commandRead(req.commandId)).admissionState, "accepted");
  assert.equal(f.calls.length, 1);
  const saved = (await f.journal.read()).snapshot.outcomes;
  assert.equal(saved[response.operationId].remote.target.interactionId, "interaction");
});
await check("partial-pages-forged-review-and-deny", async (f) => {
  f.item.effectiveArguments.content = "界".repeat(20000);
  const first = await f.read();
  assert.equal(first.complete, false);
  assert.equal(first.reviewToken, null);
  assert.equal(first.effectiveArguments, undefined);
  let page = first,
    all = first.review.chunk;
  const params = { ...f.target(), decision: "allowOnce", argumentsDigest: first.argumentsDigest };
  await assert.rejects(f.run(f.request(params)), { code: "REVIEW_INCOMPLETE" });
  await assert.rejects(f.run(f.request({ ...params, reviewToken: first.nextCursor })), {
    code: "REVIEW_INCOMPLETE",
  });
  while (page.nextCursor) {
    const previous = page;
    page = await f.read({ ...f.target(), cursor: page.nextCursor });
    assert.equal(page.review.offset, Buffer.byteLength(all));
    assert.equal(page.argumentsDigest, first.argumentsDigest);
    assert.equal(page.threadId, first.threadId);
    assert.equal(page.turnId, first.turnId);
    assert.equal(page.interactionId, first.interactionId);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 128 * 1024);
    all += page.review.chunk;
    assert.ok(page.review.offset > previous.review.offset);
  }
  assert.equal(JSON.parse(all).effectiveArguments.content, "界".repeat(20000));
  assert.equal(
    (await f.run(f.request({ ...params, reviewToken: page.reviewToken }))).admissionState,
    "accepted",
  );
  f.item.status = "pending";
  f.item.requestId = "second";
  const partial = await f.read();
  assert.equal(
    (
      await f.run(
        f.request({ ...f.target(), decision: "deny", argumentsDigest: partial.argumentsDigest }),
      )
    ).admissionState,
    "accepted",
  );
});
await check("stale-pages-bind-content-identity-grant-and-target", async (f) => {
  f.item.effectiveArguments.content = "x".repeat(40000);
  const page = await f.read(),
    params = { ...f.target(), cursor: page.nextCursor };
  for (const change of [
    () => (f.item.effectiveArguments.content += "changed without digest"),
    () => (f.item.argumentsDigest = "e".repeat(64)),
    () => (f.item.turnId = "replacement"),
    () => (f.project.service.generation = "replacement"),
  ]) {
    const item = structuredClone(f.item),
      generation = f.project.service.generation;
    change();
    await assert.rejects(f.read(params), { code: "TARGET_CHANGED" });
    f.item = item;
    f.project.service.generation = generation;
  }
  await assert.rejects(f.read(params, { ...f.connection, connectionId: "other" }), {
    code: "TARGET_CHANGED",
  });
  await assert.rejects(f.read(params, { ...f.connection, peer: "b" }), { code: "TARGET_CHANGED" });
  f.remote.config.deviceGrants[0].revision++;
  await assert.rejects(f.read(params), { code: "GRANT_CHANGED" });
});
await check("wrong-original-target-digest-expiry-and-permanent-decisions", async (f) => {
  const params = await f.approval("allowOnce");
  for (const patch of [
    { threadId: "other" },
    { turnId: "other" },
    { interactionId: "other" },
    { argumentsDigest: "f".repeat(64) },
  ])
    await assert.rejects(f.run(f.request({ ...params, ...patch })), { code: "TARGET_CHANGED" });
  for (const decision of ["allowSession", "allowProject", "allow"])
    await assert.rejects(f.run(f.request({ ...params, decision })), { code: "INVALID_PARAMS" });
  f.item.expiresAt = Math.floor(Date.now() / 1000) - 1;
  await assert.rejects(f.run(f.request(params)), { code: "TARGET_CHANGED" });
  assert.equal(f.calls.length, 0);
});
await check("native-read-budget-keeps-original-deny-available", async (f) => {
  const params = await f.approval("deny");
  f.item.effectiveArguments.content = "x".repeat(4 * 1024 * 1024);
  await assert.rejects(f.read(), { code: "RESOURCE_UNAVAILABLE" });
  assert.equal((await f.run(f.request(params))).admissionState, "accepted");
  assert.equal(f.calls[0].params.requestId, "interaction");
});
await check("questions-exact-core-keys-options-and-utf8-bounds", async (f) => {
  f.item.kind = "question";
  f.item.argumentsDigest = null;
  f.item.questions = [
    { id: "choice", title: "Pick", options: ["a", "b"], allowFreeText: false },
    { id: "text", title: "Explain", options: [], allowFreeText: true },
  ];
  const page = await f.read();
  assert.deepEqual(page.questions, f.item.questions);
  const base = { ...f.target(), reviewToken: page.reviewToken };
  for (const answers of [
    { choice: "a" },
    { choice: "a", text: "ok", extra: "bad" },
    { choice: "other", text: "ok" },
    { choice: "a", text: "界".repeat(1365) + "ab" },
  ])
    await assert.rejects(f.run(f.request({ ...base, answers })), { code: "INVALID_PARAMS" });
  assert.equal(f.calls.length, 0);
  const answers = { choice: "a", text: "界".repeat(1365) + "a" };
  assert.equal(Buffer.byteLength(answers.text), 4096);
  const req = f.request({ ...base, answers });
  const running = f.run(req);
  answers.text = "caller changed after start";
  const value = await running;
  assert.equal(value.admissionState, "accepted");
  assert.equal(f.calls[0].params.answers.text, "界".repeat(1365) + "a");
  assert.equal(Object.hasOwn(f.calls[0].params, "argumentsDigest"), false);
  await assert.rejects(f.run(req), { code: "COMMAND_CONFLICT" });
  assert.equal((await f.commandRead(req.commandId)).admissionState, "accepted");
});
await check("lost-response-no-receipt-no-replay-independent-observation", async (f) => {
  const native = f.client.request;
  f.client.request = async (...args) => {
    await native(...args);
    throw Object.assign(new Error("lost"), { submissionUnknown: true });
  };
  const req = f.request(await f.approval("allowOnce"));
  const first = await f.run(req);
  assert.equal(first.admissionState, "unknown");
  assert.equal(first.observedState.status, "answered");
  assert.equal(first.observedState.provesCommandAdmission, false);
  for (let n = 0; n < 3; n++) {
    const value = await f.commandRead(req.commandId);
    assert.equal(value.admissionState, "unknown");
    assert.equal(value.operationId, first.operationId);
  }
  assert.equal(
    (await f.run({ ...req, params: { ...req.params, reviewToken: "expired" } })).admissionState,
    "unknown",
  );
  assert.equal(f.calls.length, 1);
  const other = await f.commandRead(req.commandId, { ...f.connection, peer: "b" });
  assert.equal(other.admissionState, "notFound");
  f.remote.config.deviceGrants[0].capabilities = ["observe"];
  await assert.rejects(f.commandRead(req.commandId), { code: "FORBIDDEN" });
});
await check("outcome-loss-and-host-restart-stays-unknown", async (f) => {
  f.failJournal("outcome");
  const req = f.request(await f.approval("deny"));
  const result = await f.run(req);
  assert.equal(result.admissionState, "unknown");
  const backend = new CoreBackend({ home: f.backend.home, binary: "/unused" });
  backend.saved = f.backend.saved;
  backend.host = f.backend.host;
  f.remote.backend = backend;
  const recovered = await f.commandRead(req.commandId);
  assert.equal(recovered.operationId, result.operationId);
  assert.equal(recovered.admissionState, "unknown");
  assert.equal(recovered.observedState.status, "unavailable");
  assert.equal(f.calls.length, 1);
});
await check("two-devices-one-core-answer-original-associations", async (f) => {
  const a = f.request(await f.approval("allowOnce"));
  const other = { ...f.connection, peer: "b", connectionId: "other" };
  const page = await f.read(f.target(), other);
  const b = f.request({ ...a.params, reviewToken: page.reviewToken });
  const [one, two] = await Promise.all([f.run(a), f.run(b, other)]);
  assert.deepEqual([one.admissionState, two.admissionState].sort(), ["accepted", "rejected"]);
  assert.notEqual(one.operationId, two.operationId);
  assert.equal(two.error.code, "TARGET_CHANGED");
  assert.equal((await f.commandRead(a.commandId, other)).admissionState, "notFound");
});
await check("final-revoke-fences-before-and-after-native-dispatch", async (f) => {
  const req = f.request(await f.approval("allowOnce"));
  const change = f.journal.change.bind(f.journal);
  f.journal.change = async (mutate) => {
    let pending;
    const receipt = await change(async (snapshot) => {
      const next = await mutate(snapshot);
      pending = next.pending.length > 0;
      return next;
    });
    if (pending)
      f.remote.writes = Promise.resolve().then(
        () => (f.remote.config.deviceGrants[0].status = "revoked"),
      );
    return receipt;
  };
  await assert.rejects(f.run(req), { code: "GRANT_CHANGED" });
  assert.equal(f.calls.length, 0);
  f.journal.change = change;
  f.remote.config.deviceGrants[0].status = "active";
  const held = defer(),
    entered = defer(),
    native = f.client.request;
  f.client.request = async (...args) => {
    const result = await native(...args);
    entered.resolve();
    await held.promise;
    return result;
  };
  const second = f.request(await f.approval("allowOnce")),
    running = f.run(second);
  await entered.promise;
  await (f.remote.writes = f.remote.writes.then(
    () => (f.remote.config.deviceGrants[0].status = "revoked"),
  ));
  held.resolve();
  await assert.rejects(running, { code: "GRANT_CHANGED" });
  f.remote.config.deviceGrants[0].status = "active";
  assert.equal((await f.commandRead(second.commandId)).admissionState, "accepted");
  assert.equal(f.calls.length, 1);
});
await check("delayed-duplicate-preflight-keeps-original-outcome", async (f) => {
  const req = f.request(await f.approval("allowOnce"));
  const prepare = f.reviews.prepare.bind(f.reviews),
    entered = defer(),
    held = defer();
  let calls = 0;
  f.reviews.prepare = async (...args) => {
    if (++calls === 1) {
      entered.resolve();
      await held.promise;
    }
    return prepare(...args);
  };
  const delayed = f.run(req);
  await entered.promise;
  const accepted = await f.run(req);
  assert.equal(accepted.admissionState, "accepted");
  held.resolve();
  assert.equal((await delayed).operationId, accepted.operationId);
  assert.equal(f.calls.length, 1);
});
await check("unknown-answer-does-not-block-settled-desktop-operations", async (f) => {
  const native = f.client.request;
  f.client.request = async (method, params) => {
    if (method === "areal/interaction/respond") {
      await native(method, params);
      throw Object.assign(new Error("lost"), { submissionUnknown: true });
    }
    if (method === "areal/thread/inspect")
      return { configuration: { revision: 1 }, activeTurnId: null };
    if (method === "areal/thread/configure") return { revision: 2 };
    if (method === "areal/turn/start") return { turn: { id: "later" } };
    throw new Error("unexpected request " + method);
  };
  const req = f.request(await f.approval("deny")),
    original = await f.run(req);
  f.project.model.state.threads.t = {
    id: "t",
    status: { type: "idle" },
    turns: [{ id: "turn", status: "completed", items: [] }],
  };
  assert.equal(f.backend.hasWork(), false);
  assert.equal(f.backend.snapshot().projects[0].pending.length, 0);
  await f.backend.configureThread(f.project, "t", { options: {}, expectedRevision: 1 });
  assert.equal(
    (
      await f.backend.submit(f.project, "areal/turn/start", {
        threadId: "t",
        input: [{ type: "text", text: "later" }],
        expectedConfigRevision: 2,
      })
    ).turn.id,
    "later",
  );
  assert.deepEqual(await f.commandRead(req.commandId), original);
  await f.backend.changePending(f.project, (pending) => [
    ...pending,
    { method: "areal/turn/start", params: { threadId: "t", requestId: randomUUID() } },
  ]);
  await assert.rejects(
    f.backend.submit(f.project, "areal/turn/start", { threadId: "t" }),
    /结果未知/,
  );
});
await check("detail-publication-fences-revocation-and-service-replacement", async (f) => {
  let published = 0;
  f.afterRead = () => {
    f.remote.config.deviceGrants[0].status = "revoked";
  };
  await assert.rejects(
    f.reviews.read(f.connection, PROJECT, f.target(), () => published++),
    { code: "GRANT_CHANGED" },
  );
  assert.equal(published, 0);
  f.remote.config.deviceGrants[0].status = "active";
  f.afterRead = () => {
    f.project.service.generation = "new";
  };
  await assert.rejects(
    f.reviews.read(f.connection, PROJECT, f.target(), () => published++),
    { code: "RESYNC_REQUIRED" },
  );
  assert.equal(published, 0);
});
await check("command-observation-final-identity-and-capability-fence", async (f) => {
  const req = f.request(await f.approval("deny"));
  await f.run(req);
  f.afterRead = () => {
    f.project.endpoint = "ws://changed";
  };
  await assert.rejects(f.commandRead(req.commandId), { code: "RESYNC_REQUIRED" });
  f.afterRead = () => {
    f.remote.config.deviceGrants[0].capabilities = ["observe"];
  };
  await assert.rejects(f.commandRead(req.commandId), { code: "FORBIDDEN" });
  assert.equal(f.calls.length, 1);
});
await check("bounded-observer-queue-and-active-viewer-survive-detail-read", async (f) => {
  await f.observers.open(f.connection, PROJECT, "t", () => {});
  const viewer = f.observers.viewers.get("c"),
    held = defer(),
    entered = defer();
  f.afterRead = async () => {
    entered.resolve();
    await held.promise;
  };
  const first = f.read();
  await entered.promise;
  const waiting = Array.from({ length: 15 }, () => f.read());
  await assert.rejects(f.read(), { code: "LIMIT_EXCEEDED" });
  assert.equal(f.observers.viewers.get("c"), viewer);
  held.resolve();
  await Promise.all([first, ...waiting]);
  assert.equal(f.observers.viewers.get("c"), viewer);
  assert.equal(viewer.entry.closed, false);
});
await check("actual-noise-direct-reviewed-route-and-schema", async (f) => {
  const crypto = await import("../packages/remote/src/channel.mjs");
  const { once } = await import("node:events");
  const WebSocket = require("../app/node_modules/ws");
  const { startDirect } = require("../app/src/core/remote-direct.cjs");
  const device = await crypto.createIdentity();
  f.remote.crypto = crypto;
  f.remote.config.identity = await crypto.createIdentity();
  f.remote.config.directEnabled = true;
  f.remote.config.deviceGrants[0].devicePeerId = crypto.identityId(device);
  const connect = SessionObservers.prototype.connect;
  SessionObservers.prototype.connect = f.observers.connect;
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
      clientVersion: "rc07-fixture",
      displayName: "fixture",
    });
    const ready = (await messages.next()).value;
    assert.ok(ready.capabilities.includes("answer"));
    assert.ok(ready.methods.includes("attention.read"));
    assert.ok(ready.methods.includes("interaction.respond"));
    secure.send({
      id: "review",
      method: "attention.read",
      context: { projectId: PROJECT },
      params: f.target(),
    });
    const page = (await messages.next()).value.result;
    assert.equal(page.complete, true);
    assert.equal(page.effectiveArguments.path, "approved.txt");
    const req = f.request({
      ...f.target(),
      decision: "allowOnce",
      argumentsDigest: page.argumentsDigest,
      reviewToken: page.reviewToken,
    });
    secure.send(req);
    const value = (await messages.next()).value;
    assert.equal(value.result.admissionState, "accepted");
    assert.equal(value.result.observedState.status, "answered");
    assert.equal(f.calls[0].params.requestId, "interaction");
    secure.send({ ...req, id: "duplicate", params: { ...req.params, reviewToken: "expired" } });
    assert.equal((await messages.next()).value.result.operationId, value.result.operationId);
    secure.send({
      ...req,
      id: "permanent",
      commandId: randomUUID(),
      params: { ...req.params, decision: "allowProject" },
    });
    assert.equal((await messages.next()).value.error.code, "INVALID_PARAMS");
    secure.send({
      id: "injected",
      method: "attention.read",
      context: { projectId: PROJECT },
      params: { ...f.target(), endpoint: "ws://injected" },
    });
    assert.equal((await messages.next()).value.error.code, "INVALID_PARAMS");
    assert.equal(f.calls.length, 1);
  } finally {
    secure?.close();
    direct.close();
    f.remote.sessions.close();
    SessionObservers.prototype.connect = connect;
  }
});
if (!rustOwner) {
  await owner.close();
  console.log(
    JSON.stringify(
      {
        kind: "fixture-contract",
        storageOwner: "Rust Host",
        gatewayOwner: "JS reference",
        coreRPC: "deterministic fixture",
        checks,
        passed: checks.length,
        home,
      },
      null,
      2,
    ),
  );
}

if (process.env.AREAL_REMOTE_OWNER !== "reference") {
  const { nativeInteractionContract } = await import("./remote-interaction-native-fixture.mjs");
  const { test } = await import("node:test");
  await test(
    "original RC07 real-Core subset through Rust Gateway",
    { timeout: 240000 },
    nativeInteractionContract,
  );
}
