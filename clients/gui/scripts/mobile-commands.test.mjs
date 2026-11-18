import assert from "node:assert/strict";
import test from "node:test";
import { MobileCommands } from "../renderer/src/mobile/mobile-commands.mjs";
import { ClientState } from "@areal/remote-client";

async function fixture() {
  let record = null;
  const identities = new ClientState({
    createIdentity: async () => "identity",
    identityId: () => "peer",
    store: {
      transaction: async (_, action) => {
        const next = action(structuredClone(record));
        record = next.record;
        return next.result;
      },
    },
  });
  const guest = await identities.guest();
  await identities.remember(await identities.prepareRemember(guest), "host");
  const ready = {
    hostId: "host",
    gatewayGeneration: "gateway",
    grantRevision: 1,
    capabilities: ["submit"],
  };
  const snapshot = {
    threadId: "thread",
    ownership: { kind: "ordinary" },
    activeTurnId: null,
    configRevision: 3,
    models: [{ providerId: "provider", modelId: "other", reasoningEffortOptions: ["high"] }],
    configuration: { permissions: { fullAccessAvailable: true } },
  };
  const requests = [],
    receipts = new Map();
  const workspaceListeners = new Set();
  const clientListeners = new Set();
  let connectionState = { kind: "connected", ready };
  const workspace = {
    state: {
      page: { kind: "new", projectId: "project" },
      catalog: { serviceGeneration: "service" },
      detail: null,
    },
    subscribe(listener) {
      workspaceListeners.add(listener);
      return () => workspaceListeners.delete(listener);
    },
    update(values) {
      Object.assign(this.state, values);
      for (const listener of workspaceListeners) listener();
    },
    async activate() {
      return "service";
    },
    async navigate(page) {
      this.update({
        page,
        detail: { projectId: "project", serviceGeneration: "service", snapshot },
      });
      requests.push({ method: "session.open" });
    },
    async refresh() {
      snapshot.configRevision++;
    },
  };
  const client = {
    identities,
    connection: {},
    subscribe(listener) {
      clientListeners.add(listener);
      return () => clientListeners.delete(listener);
    },
    snapshot: () => connectionState,
    update(state) {
      connectionState = state;
      for (const listener of clientListeners) listener();
    },
    remember: async () => identities.current(),
    async request(request) {
      requests.push(request);
      if (request.method === "command.read") return receipts.get(request.params.commandId);
      const result = {
        commandId: request.commandId,
        admissionState: "accepted",
        ...(request.method === "session.create" ? { threadId: "thread" } : {}),
      };
      receipts.set(request.commandId, result);
      return result;
    },
  };
  const commands = new MobileCommands(client, workspace);
  return { client, workspace, commands, requests, receipts, snapshot, ready, record: () => record };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function pendingDecision(kind) {
  const f = await fixture();
  f.ready.capabilities.push("answer");
  await f.workspace.navigate({ kind: "session", projectId: "project", threadId: "thread" });
  const ref = {
    threadId: "thread",
    turnId: "turn",
    interactionId: "decision",
    kind,
    status: "pending",
  };
  f.snapshot.attentionRefs = [ref];
  const request = f.client.request;
  const digest = "f".repeat(64);
  const body =
    kind === "approval"
      ? { tool: "fs_create", effectiveArguments: { path: "测试.txt" } }
      : { questions: [{ id: "q", title: "继续吗？", options: ["是", "否"] }] };
  const encoded = JSON.stringify(body);
  const split = encoded.indexOf(kind === "approval" ? "试" : "续");
  const chunks = [encoded.slice(0, split), encoded.slice(split)];
  f.client.request = async (envelope) => {
    if (envelope.method !== "attention.read") return request(envelope);
    f.requests.push(envelope);
    const complete = envelope.params.cursor === "cursor";
    return {
      ...ref,
      projectId: "project",
      serviceGeneration: "service",
      argumentsDigest: digest,
      complete,
      ...(complete ? { reviewToken: "complete-review" } : { nextCursor: "cursor" }),
      review: {
        encoding: "json-utf8",
        totalBytes: Buffer.byteLength(encoded),
        offset: complete ? Buffer.byteLength(chunks[0]) : 0,
        chunk: chunks[Number(complete)],
      },
    };
  };
  return { ...f, ref, body, digest };
}

test("approves only after loading all review bytes and binds the write to the original target", async () => {
  const f = await pendingDecision("approval");
  const review = await f.commands.readDecision(f.ref);
  assert.deepEqual(review.body, f.body);
  assert.equal(await f.commands.respond(review, "allowOnce"), true);
  const [, first, second, write] = f.requests;
  assert.equal(first.params.cursor, undefined);
  assert.equal(second.params.cursor, "cursor");
  assert.equal(write.method, "interaction.respond");
  assert.deepEqual(write.params, {
    threadId: "thread",
    turnId: "turn",
    interactionId: "decision",
    argumentsDigest: f.digest,
    reviewToken: "complete-review",
    decision: "allowOnce",
  });
  assert.equal(write.context.serviceGeneration, "service");
  assert.equal(await f.commands.respond(review, "allowOnce"), true);
  assert.equal(f.requests.filter((event) => event.method === "interaction.respond").length, 1);
});

test("sends an explicit question answer but never writes with a review from a replaced connection", async () => {
  const f = await pendingDecision("syncQuestion");
  const oldReview = await f.commands.readDecision(f.ref);
  f.client.connection = {};
  assert.equal(await f.commands.respond(oldReview, { q: "是" }), false);
  assert.equal(f.commands.snapshot().error, "TARGET_CHANGED");
  assert.equal(f.requests.filter((event) => event.method === "interaction.respond").length, 0);
  const review = await f.commands.readDecision(f.ref);
  assert.equal(await f.commands.respond(review, { q: "是" }), true);
  assert.deepEqual(f.requests.at(-1).params, {
    threadId: "thread",
    turnId: "turn",
    interactionId: "decision",
    reviewToken: "complete-review",
    answers: { q: "是" },
  });
});

for (const resume of ["same conversation", "another grant", "another conversation"]) {
  test(`connection changes before dispatch: ${resume}`, async () => {
    const f = await fixture();
    await f.workspace.navigate({ kind: "session", projectId: "project", threadId: "thread" });
    const saved = Promise.withResolvers();
    const finishSave = Promise.withResolvers();
    const persist = f.client.identities.persistLocator.bind(f.client.identities);
    f.client.identities.persistLocator = async (...args) => {
      await persist(...args);
      saved.resolve();
      await finishSave.promise;
    };
    f.commands.setDraft("project", "thread", "send after recovery");
    const sending = f.commands.send();
    await saved.promise;
    f.workspace.update({ stale: true });
    f.client.connection = null;
    f.client.update({ kind: "offline", hostId: "host" });
    await f.client.identities.restore();
    f.client.connection = {};
    f.client.update({
      kind: "connected",
      ready: {
        ...f.ready,
        gatewayGeneration: "new-gateway",
        grantRevision: resume === "another grant" ? 2 : 1,
      },
    });
    finishSave.resolve();
    await sending;
    await flush();
    assert.equal(f.requests.filter((r) => r.method === "session.send").length, 0);
    if (resume === "another conversation") {
      f.workspace.update({ page: { kind: "session", projectId: "project", threadId: "other" } });
    }
    f.snapshot.configRevision = 5;
    f.workspace.update({
      stale: false,
      detail: { ...f.workspace.state.detail, serviceGeneration: "new-service" },
    });
    await flush();
    const sends = f.requests.filter((r) => r.method === "session.send");
    assert.equal(sends.length, resume === "same conversation" ? 1 : 0);
    assert.equal(f.requests.filter((r) => r.method === "command.read").length, 0);
    if (resume === "same conversation") {
      assert.equal(sends[0].params.text, "send after recovery");
      assert.equal(sends[0].params.expectedConfigRevision, 5);
      assert.equal(sends[0].context.serviceGeneration, "new-service");
      assert.equal(sends[0].context.gatewayGeneration, "new-gateway");
    } else assert.equal(f.commands.draft("project", "thread"), "send after recovery");
    assert.deepEqual(f.record().locators, []);
  });
}

test("connection lost after dispatch checks the original command before accepting, without resending", async () => {
  const f = await fixture();
  await f.workspace.navigate({ kind: "session", projectId: "project", threadId: "thread" });
  const request = f.client.request;
  f.client.request = async (envelope) => {
    const result = await request(envelope);
    if (envelope.method === "session.send") {
      f.workspace.update({ stale: true });
      f.client.connection = null;
      f.client.update({ kind: "offline", hostId: "host" });
      throw new Error("lost response");
    }
    return result;
  };
  f.commands.setDraft("project", "thread", "never replay");
  await f.commands.send();
  assert.equal(f.record().locators.length, 1);
  await f.client.identities.restore();
  f.client.connection = {};
  f.client.update({ kind: "connected", ready: f.ready });
  f.workspace.update({ stale: false });
  await flush();
  const [, sent, checked, ...more] = f.requests;
  assert.equal(sent.method, "session.send");
  assert.equal(checked.method, "command.read");
  assert.equal(checked.params.commandId, sent.commandId);
  assert.deepEqual(more, []);
  assert.deepEqual(f.record().locators, []);
  assert.equal(f.commands.draft("project", "thread"), "");
});
test("keeps the draft while the conversation is stale and sends only after a fresh read", async () => {
  const f = await fixture();
  await f.workspace.navigate({ kind: "session", projectId: "project", threadId: "thread" });
  f.commands.setDraft("project", "thread", "继续修改这段草稿");
  f.workspace.state.stale = true;
  await f.commands.send();
  assert.equal(f.commands.draft("project", "thread"), "继续修改这段草稿");
  assert.deepEqual(
    f.requests.map((request) => request.method),
    ["session.open"],
  );
  f.workspace.state.stale = false;
  await f.commands.send();
  assert.equal(f.requests[1].params.text, "继续修改这段草稿");
  assert.equal(f.commands.draft("project", "thread"), "");
});
test("first send applies an explicit model only after create and baseline, with durable locators", async () => {
  const f = await fixture();
  f.commands.setDraft("project", "", "first message");
  f.commands.setIntent("project", "", {
    model: { providerId: "provider", modelId: "other" },
    parameters: { reasoningEffort: "high" },
  });
  f.workspace.refresh = () =>
    assert.fail("sending must not re-open the session after configuration");
  await f.commands.send();
  assert.deepEqual(
    f.requests.map((r) => r.method),
    ["session.create", "session.open", "session.control", "session.send"],
  );
  assert.equal(f.requests[2].params.expectedRevision, 3);
  assert.deepEqual(f.requests[0].params, {});
  assert.equal(f.requests[3].params.expectedConfigRevision, 4);
  assert.equal(f.commands.draft("project", "thread"), "");
  assert.deepEqual(f.record().locators, []);
});
test("shows the outgoing bubble before opening a new session and hands off by accepted turn ID", async () => {
  const f = await fixture();
  const create = Promise.withResolvers();
  const send = Promise.withResolvers();
  const request = f.client.request;
  f.client.request = async (envelope) => {
    const result = await request(envelope);
    if (envelope.method === "session.create") await create.promise;
    if (envelope.method === "session.send") {
      await send.promise;
      return { ...result, turnId: "own-turn" };
    }
    return result;
  };
  f.commands.setDraft("project", "", "test from phone");
  const sending = f.commands.send();
  assert.equal(f.commands.outgoingFor("project", "").text, "test from phone");
  create.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.commands.outgoingFor("project", "thread").text, "test from phone");
  assert.equal(f.commands.outgoingFor("project", "thread").turnId, null);
  send.resolve();
  await sending;
  const message = { type: "userMessage" };
  assert.equal(
    f.commands.outgoingFor("project", "thread", [{ id: "other-turn", items: [message] }]).turnId,
    "own-turn",
  );
  assert.equal(
    f.commands.outgoingFor("project", "thread", [{ id: "own-turn", items: [message] }]),
    null,
  );
  assert.equal(f.commands.draft("project", "thread"), "");
});
test("first send uses the current generation even when the draft catalog is stale", async () => {
  const f = await fixture();
  f.workspace.activate = async (projectId) => {
    assert.equal(projectId, "project");
    f.requests.push({ method: "project.activate" });
    return "new-service";
  };
  f.commands.setDraft("project", "", "first from a stopped project");
  await f.commands.send();
  assert.deepEqual(
    f.requests.map((request) => request.method),
    ["project.activate", "session.create", "session.open", "session.send"],
  );
  assert.equal(f.requests[1].context.serviceGeneration, "new-service");
});
test("lost create is queried, never automatically followed by a send, and preserves draft", async () => {
  const f = await fixture(),
    request = f.client.request;
  f.client.request = async (r) => {
    const v = await request(r);
    if (r.method === "session.create")
      throw Object.assign(new Error("lost"), { submissionUnknown: true });
    return v;
  };
  f.commands.setDraft("project", "", "retain me");
  await f.commands.send();
  await f.commands.send();
  assert.deepEqual(
    f.requests.map((r) => r.method),
    ["session.create"],
  );
  assert.equal(f.record().locators.length, 1);
  await f.commands.query(f.commands.unresolved("project")[0]);
  assert.deepEqual(
    f.requests.map((r) => r.method),
    ["session.create", "command.read", "session.open"],
  );
  assert.equal(f.commands.draft("project", "thread"), "retain me");
  assert.equal(f.record().locators.length, 0);
});
test("relaunch restores only original locator and queries its receipt without payload replay", async () => {
  const f = await fixture();
  await f.workspace.navigate({ kind: "session", projectId: "project", threadId: "thread" });
  const request = f.client.request;
  let canReadReceipt = false;
  f.client.request = async (r) => {
    const v = await request(r);
    if (r.method === "session.send")
      throw Object.assign(new Error("lost"), { submissionUnknown: true });
    if (r.method === "command.read" && !canReadReceipt) throw new Error("disconnected");
    return v;
  };
  f.commands.setDraft("project", "thread", "private draft");
  await f.commands.send();
  assert.equal(JSON.stringify(f.record()).includes("private draft"), false);
  canReadReceipt = true;
  const restored = new MobileCommands(f.client, f.workspace);
  await restored.recover();
  assert.equal(f.requests.filter((r) => r.method === "session.send").length, 1);
  assert.equal(f.requests.filter((r) => r.method === "command.read").length, 2);
  assert.equal(f.record().locators.length, 0);
  assert.equal(restored.draft("project", "thread"), "");
});
test("pending send reads the original receipt and clears the draft after acceptance", async () => {
  const f = await fixture();
  await f.workspace.navigate({ kind: "session", projectId: "project", threadId: "thread" });
  const request = f.client.request;
  f.client.request = async (envelope) => {
    const receipt = await request(envelope);
    return envelope.method === "session.send" ? { ...receipt, admissionState: "pending" } : receipt;
  };
  f.commands.setDraft("project", "thread", "send once");
  await f.commands.send();
  const requests = f.requests.slice(1);
  assert.deepEqual(
    requests.map((request) => request.method),
    ["session.send", "command.read"],
  );
  assert.equal(requests[1].params.commandId, requests[0].commandId);
  assert.equal(f.commands.draft("project", "thread"), "");
  assert.deepEqual(f.record().locators, []);
});
test("an unresolved send stops checking and retains the original draft and locator", async () => {
  const f = await fixture();
  await f.workspace.navigate({ kind: "session", projectId: "project", threadId: "thread" });
  const request = f.client.request;
  f.client.request = async (envelope) => ({
    ...(await request(envelope)),
    admissionState: "pending",
  });
  f.commands.setDraft("project", "thread", "keep until accepted");
  await f.commands.send();
  const [, sent, ...checks] = f.requests;
  assert.equal(sent.method, "session.send");
  assert.equal(checks.length, 3);
  assert.ok(
    checks.every(
      (check) => check.method === "command.read" && check.params.commandId === sent.commandId,
    ),
  );
  assert.equal(f.commands.state.busy, false);
  assert.equal(f.commands.draft("project", "thread"), "keep until accepted");
  assert.equal(f.record().locators[0].commandId, sent.commandId);
});
test("unknown exact stop remains inspectable but authoritative idle allows new send", async () => {
  const f = await fixture();
  await f.workspace.navigate({ kind: "session", projectId: "project", threadId: "thread" });
  f.snapshot.activeTurnId = "turn";
  const request = f.client.request;
  f.client.request = async (r) => {
    if (r.method === "turn.stop") {
      f.requests.push(r);
      throw Object.assign(new Error("lost"), { submissionUnknown: true });
    }
    return request(r);
  };
  await f.commands.stop();
  assert.equal(f.commands.blocksSend("project", "thread"), true);
  f.snapshot.activeTurnId = null;
  assert.equal(f.commands.blocksSend("project", "thread"), false);
  f.commands.setDraft("project", "thread", "new turn");
  await f.commands.send();
  assert.equal(f.requests.filter((r) => r.method === "session.send").length, 1);
  assert.equal(f.record().locators.length, 1);
  assert.equal(f.record().locators[0].method, "turn.stop");
});
test("navigation during device persistence cannot dispatch a stale write", async () => {
  const f = await fixture(),
    gate = Promise.withResolvers();
  f.client.remember = () => gate.promise;
  f.commands.setDraft("project", "", "do not send");
  const sending = f.commands.send();
  f.workspace.state.page = { kind: "projects" };
  gate.resolve(f.client.identities.current());
  await sending;
  assert.equal(f.requests.length, 0);
  assert.equal(f.commands.draft("project"), "do not send");
});
test("unknown configure stops first-send pipeline until receipt query and an explicit later send", async () => {
  const f = await fixture(),
    request = f.client.request;
  f.client.request = async (r) => {
    const result = await request(r);
    if (r.method === "session.control")
      throw Object.assign(new Error("lost"), { submissionUnknown: true });
    return result;
  };
  f.commands.setDraft("project", "", "keep first draft");
  f.commands.setIntent("project", "", { model: { providerId: "provider", modelId: "other" } });
  await f.commands.send();
  assert.deepEqual(
    f.requests.map((r) => r.method),
    ["session.create", "session.open", "session.control"],
  );
  assert.equal(f.commands.draft("project", "thread"), "keep first draft");
  await f.commands.query(f.commands.unresolved("project", "thread")[0]);
  assert.equal(f.requests.filter((r) => r.method === "session.send").length, 0);
  await f.commands.send();
  assert.equal(f.requests.filter((r) => r.method === "session.send").length, 1);
});
test("device save failure preserves first draft and prevents all command dispatch", async () => {
  const f = await fixture();
  f.client.remember = async () => {
    throw Object.assign(new Error("storage"), { code: "DEVICE_SAVE_FAILED" });
  };
  f.commands.setDraft("project", "", "keep private text");
  await f.commands.send();
  assert.equal(f.requests.length, 0);
  assert.equal(f.commands.draft("project"), "keep private text");
  assert.equal(f.commands.state.error, "DEVICE_SAVE_FAILED");
});
for (const delayed of ["session.create", "session.control"])
  test(`send freezes clicked text while ${delayed} is pending`, async () => {
    const f = await fixture(),
      gate = Promise.withResolvers(),
      entered = Promise.withResolvers(),
      request = f.client.request;
    if (delayed === "session.control") {
      await f.workspace.navigate({ kind: "session", projectId: "project", threadId: "thread" });
      f.commands.setIntent("project", "thread", {
        model: { providerId: "provider", modelId: "other" },
      });
    }
    const target = delayed === "session.create" ? "" : "thread";
    f.client.request = async (r) => {
      if (r.method === delayed) {
        entered.resolve();
        await gate.promise;
      }
      return request(r);
    };
    f.commands.setDraft("project", target, "clicked message");
    const sending = f.commands.send();
    await entered.promise;
    f.commands.setDraft("project", target, "new draft typed while waiting");
    gate.resolve();
    await sending;
    assert.equal(
      f.requests.find((r) => r.method === "session.send").params.text,
      "clicked message",
    );
    assert.equal(f.commands.draft("project", "thread"), "new draft typed while waiting");
  });

test("explicit service default is accepted independently of supported efforts and retained in the command", async () => {
  const f = await fixture();
  f.commands.setDraft("project", "", "service default");
  f.commands.setIntent("project", "", {
    model: { providerId: "provider", modelId: "other" },
    parameters: { reasoningEffort: "default" },
  });
  await f.commands.send();
  assert.equal(
    f.requests.find((request) => request.method === "session.control").params.values.parameters
      .reasoningEffort,
    "default",
  );
  assert.equal(f.requests.at(-1).method, "session.send");
});
