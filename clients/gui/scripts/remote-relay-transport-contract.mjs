import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { execFile, execFileSync } from "node:child_process";
import { rm, readFile, mkdtemp, readdir, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { createIdentity, identityId, secureChannel } from "../packages/remote/src/channel.mjs";
const require = createRequire(new URL("../app/package.json", import.meta.url));
const WebSocket = require("ws");
import { nativeHostFixture, nativeCoreProject } from "./remote-native-host-fixture.mjs";
import { nativeHistory } from "./remote-relay-native-history-fixture.mjs";
import { assertNativeRelaySaveFailure } from "./remote-relay-native-save-fixture.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  certificates,
  relayFixture,
  hostFixture,
  nativeRelayHostFixture,
  waitFor,
  nativeProject,
} from "./remote-relay-fixture.mjs";

async function next(messages) {
  let timer;
  try {
    return await Promise.race([
      messages.next(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("application response deadline")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function device(
  t,
  remote,
  {
    identity,
    transport = "relay",
    pair = false,
    preset = "Observer",
    hostPin,
    room,
    inviteSecret,
    apiVersion = "areal.remote.v2",
    coalesceClose = false,
    projects = ["project"],
  } = {},
) {
  const { createRemoteWire } = await import("../packages/remote/src/wire.mjs");
  identity ??= await createIdentity();
  const saved = remote.config;
  let invite = inviteSecret;
  if (pair && !invite)
    invite = new URLSearchParams(
      new URL((await remote.control({ operation: "pair", transport })).payload).hash.slice(1),
    ).get("invite");
  const origin = transport === "relay" ? saved.relay : remote.state().directUrl;
  const socket = new WebSocket(origin.replace(/^http/, "ws") + "/remote/socket", { origin });
  t.after(() => socket.terminate());
  let holdUntilClose = false;
  if (coalesceClose) {
    const listen = socket.addEventListener.bind(socket);
    const pending = [];
    socket.addEventListener = (type, listener, ...options) =>
      listen(
        type,
        type !== "message"
          ? listener
          : (event) => {
              if (!holdUntilClose) return listener(event);
              pending.push(event);
              if (JSON.parse(event.data).type !== "close") return;
              // 真实帧按原顺序同回调投递，复现接收数据尚在迭代队列时连接关闭。
              for (const item of pending.splice(0)) listener(item);
            },
        ...options,
      );
  }
  const { wire, ready } = createRemoteWire(socket, {
    room: transport === "relay" ? (room ?? saved.room) : null,
  });
  await ready;
  const secure = await secureChannel(wire, identity, hostPin ?? identityId(saved.identity), {
    maxMessageBytes: 256 * 1024,
  });
  const messages = secure.messages();
  holdUntilClose = coalesceClose;
  secure.send({
    method: "hello",
    apiVersion,
    clientVersion: "test",
    displayName: "Relay device",
    ...(invite ? { inviteSecret: invite } : {}),
  });
  const pairing = await next(messages);
  let active = pairing.value;
  if (pair) {
    assert.equal(active?.event, "pairing");
    await remote.control({
      operation: "approve",
      id: identityId(identity),
      projects,
      preset,
    });
    active = (await next(messages)).value;
  }
  return {
    socket,
    secure,
    messages,
    active,
    identity,
    peer: identityId(identity),
    async read(id = "read") {
      secure.send({ id, method: "project.list", params: {} });
      for (;;) {
        const message = (await next(messages)).value;
        if (message?.event === "session.updated") continue;
        assert.equal(message?.id, id);
        return message;
      }
    },
  };
}
async function rawRelay(t, remote) {
  const socket = new WebSocket(remote.config.relay.replace(/^https:/, "wss:") + "/remote/socket", {
    origin: remote.config.relay,
  });
  t.after(() => socket.terminate());
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const ready = new Promise((resolve) => socket.once("message", (raw) => resolve(JSON.parse(raw))));
  socket.send(
    JSON.stringify({ protocol: "areal.relay.v1", role: "client", room: remote.config.room }),
  );
  return { socket, ...(await ready) };
}
async function enrolledHost(t, relayOptions = {}, hostOptions = {}, createHost = hostFixture) {
  const relay = await relayFixture(t, { relayOptions }),
    host = await createHost(t, hostOptions);
  const enrollmentRequest = {
    operation: "enable",
    relay: relay.origin,
    code: relay.admin("enrollment").code,
    confirmed: true,
  };
  await host.remote.control(enrollmentRequest);
  await waitFor(() => host.remote.state().connected);
  return { relay, ...host, enrollmentRequest };
}

async function nativePacedFence(t, operation) {
  const relay = await relayFixture(t, {
    relayOptions: { framesPerSecond: 12, bytesPerSecond: 524288, maxFrameBytes: 16384 },
    observeHostFrames: true,
  });
  const f = await nativeHostFixture(t);
  f.evidence.relay = relay.resources;
  await f.remote.control({
    operation: "enable",
    relay: relay.origin,
    code: relay.admin("enrollment").code,
    confirmed: true,
  });
  await waitFor(() => f.remote.state().connected);
  const native = await nativeHistory(t, f);
  const reader = await device(t, f.remote, { pair: true, projects: [native.alias] });
  const healthy = await device(t, f.remote, { pair: true, projects: [native.alias] });
  const itemIds = native.thread.turns.flatMap((turn) => turn.items.map((item) => item.id));
  async function open(client, id) {
    client.secure.send({
      id,
      method: "session.open",
      context: { projectId: native.alias },
      params: { threadId: native.threadId },
    });
    const response = (await next(client.messages)).value;
    assert.equal(response?.id, id);
    assert.ok(response.result, JSON.stringify(response));
    assert.deepEqual(
      response.result.snapshot.turns.flatMap((turn) => turn.items.map((item) => item.id)),
      itemIds,
    );
    return response.result;
  }
  const opened = await open(reader, "open");
  assert.equal((await reader.read("before-history")).result.projects.length, 1);
  const journal = await f.client.journal(native.projectId).read();
  const threadIds = await native.readThreadIds();
  const historyId = randomUUID();
  const observation = {
    operation,
    projectId: native.projectId,
    threadId: native.threadId,
    historyId,
    originalConnectionId: reader.active.connectionId,
    originalGatewayGeneration: reader.active.gatewayGeneration,
    subscriptionId: opened.subscriptionId,
    barrierId: "before-history",
    originalHistoryTextBytes: f.evidence.nativeHistory.textBytes,
    historyState: "pending",
    receivedData: [],
    observedHostFrames: relay.hostFrames,
    observedHostRegistrations: relay.hostRegistrations,
    observation:
      "receiver data during the sole outstanding history request after a complete read barrier; Rust queue occupancy and physical sends unobserved",
  };
  f.evidence.pacedFence = observation;
  const firstData = new Promise((resolve) => {
    const receive = (bytes) => {
      const frame = JSON.parse(bytes.toString());
      if (frame.type !== "data") return;
      const received = { at: performance.now(), channel: frame.channel, bytes: bytes.length };
      observation.receivedData.push(received);
      if (received.bytes > 4096) resolve(received);
    };
    reader.socket.on("message", receive);
    t.after(() => reader.socket.off("message", receive));
  });
  reader.secure.send({
    id: historyId,
    method: "session.history",
    context: { projectId: native.alias },
    params: { threadId: native.threadId, limit: 100 },
  });
  const pending = next(reader.messages).then(
    (response) => {
      observation.historyState = response.done ? "eof" : "response";
      observation.historyResponseId = response.value?.id;
      return response;
    },
    (error) => {
      observation.historyState = "error";
      observation.historyErrorCode = error.code;
      return { error };
    },
  );
  const fragment = await Promise.race([
    firstData,
    pending.then(() => assert.fail("history ended before its first observed Relay data frame")),
  ]);
  assert.ok(fragment.bytes > 4096, "first frame carries a large history fragment");
  assert.ok(fragment.bytes < observation.originalHistoryTextBytes);
  assert.equal(observation.historyState, "pending");
  observation.originalHostSocketId = relay.hostFrames.findLast(
    (frame) => frame.channel === fragment.channel,
  ).socketId;
  observation.historyPendingAtFence = true;
  observation.fragmentBytesAtFence = fragment.bytes;
  observation.fenceRequestedAt = performance.now();
  const control =
    operation === "revoke"
      ? { operation, id: reader.peer }
      : { operation: "enable", relay: relay.origin, confirmed: true };
  await f.remote.control(control);
  observation.fenceCompletedAt = performance.now();
  await waitFor(() => reader.socket.readyState === 3);
  const terminal = await pending;
  if (terminal.error) assert.equal(terminal.error.code, "ERR_UNEXPECTED_EOF");
  else assert.equal(terminal.done, true, JSON.stringify(terminal));
  assert.equal((await next(reader.messages)).done, true);
  if (operation === "revoke") {
    const state = await f.remote.refresh();
    const revoked = state.deviceGrants.find((grant) => grant.devicePeerId === reader.peer);
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.online, false);
    assert.equal(revoked.revision, reader.active.grantRevision + 1);
    assert.equal(
      (await device(t, f.remote, { identity: reader.identity })).active.error.code,
      "FORBIDDEN",
    );
    assert.equal((await healthy.read("after-revoke")).result.projects.length, 1);
  } else {
    await waitFor(() => healthy.socket.readyState === 3);
    await waitFor(
      async () =>
        relay.hostRegistrations.some(
          (entry) => entry.socketId !== observation.originalHostSocketId,
        ) && (await f.remote.refresh()).connected,
    );
    const fresh = await device(t, f.remote, { identity: reader.identity });
    assert.equal(fresh.active.gatewayGeneration, reader.active.gatewayGeneration);
    assert.notEqual(fresh.active.connectionId, reader.active.connectionId);
    const freshChannels = new Set();
    const receive = (bytes) => {
      const frame = JSON.parse(bytes.toString());
      if (frame.type === "data") freshChannels.add(frame.channel);
    };
    fresh.socket.on("message", receive);
    t.after(() => fresh.socket.off("message", receive));
    assert.equal((await fresh.read("fresh-generation")).result.projects.length, 1);
    const restored = await open(fresh, "fresh-open");
    assert.equal(freshChannels.size, 1);
    const [freshChannel] = freshChannels;
    const freshHostSocketIds = new Set(
      relay.hostFrames
        .filter((frame) => frame.channel === freshChannel)
        .map((frame) => frame.socketId),
    );
    assert.equal(freshHostSocketIds.size, 1);
    const [freshHostSocketId] = freshHostSocketIds;
    assert.notEqual(freshHostSocketId, observation.originalHostSocketId);
    observation.freshHostSocketId = freshHostSocketId;
    observation.freshRelayChannel = freshChannel;
    assert.notEqual(restored.subscriptionId, opened.subscriptionId);
    const restoredHealthy = await device(t, f.remote, { identity: healthy.identity });
    assert.equal((await restoredHealthy.read("healthy-generation")).result.projects.length, 1);
    observation.freshGatewayGeneration = fresh.active.gatewayGeneration;
    observation.freshConnectionId = fresh.active.connectionId;
    observation.freshSubscriptionId = restored.subscriptionId;
  }
  assert.equal((await f.remote.refresh()).connected, true);
  assert.equal(relay.frameObservationErrors, 0);
  assert.deepEqual(await f.client.journal(native.projectId).read(), journal);
  assert.deepEqual(await native.readThread(), native.thread);
  assert.deepEqual(await native.readThreadIds(), threadIds);
  observation.oldConnectionClosed = true;
  observation.healthyReadSucceeded = true;
  observation.journalAndOriginalThreadUnchanged = true;
  observation.exactPendingCancellationCoverage = [
    "accepted_close_waits_for_queue_and_abort_invalidates_old_stream",
    "pending_socket_send_is_cancelled_before_old_generation_can_flush",
  ];
}

if (!process.env.RC12_TLS_HOME) {
  test("strict process-CA Relay Host contract", async () => {
    const home = await certificates();
    try {
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const output = execFileSync(process.execPath, ["--test", import.meta.filename], {
        env: { ...env, RC12_TLS_HOME: home, NODE_EXTRA_CA_CERTS: join(home, "ca.pem") },
        encoding: "utf8",
        timeout: 600000,
      });
      process.stdout.write(output);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
} else {
  for (const transport of ["direct", "relay"]) {
    async function budgetFixture(t, nativeOwner = false, approval = false) {
      let f, native;
      if (nativeOwner) {
        const relay = await relayFixture(t);
        f = await nativeHostFixture(t);
        f.relay = relay;
        f.evidence.relay = relay.resources;
        native = await nativeCoreProject(t, f, { approval });
        await f.remote.control({
          operation: "enable",
          relay: relay.origin,
          code: relay.admin("enrollment").code,
          confirmed: true,
        });
        await waitFor(() => f.remote.state().connected);
      } else {
        f = await enrolledHost(t, {}, { commands: true });
        native = await nativeProject(t, f, { commands: true });
      }
      await f.remote.control({ operation: "enableDirect" });
      if (!approval && !nativeOwner) {
        t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
        t.after(() => t.mock.timers.reset());
      }
      const projectId = nativeOwner ? native.alias : "project";
      const client = await device(t, f.remote, {
        pair: true,
        transport,
        preset: "Operator",
        projects: [projectId],
      });
      const context = (client) => ({
        projectId,
        gatewayGeneration: client.active.gatewayGeneration,
        grantRevision: client.active.grantRevision,
        serviceGeneration: nativeOwner ? native.service.generation : "generation-1",
      });
      async function rpc(client, request) {
        const id = randomUUID();
        client.secure.send({ id, ...request });
        const response = (await next(client.messages)).value;
        assert.equal(response.id, id);
        return response;
      }
      const write = (client, method = "session.create", params = {}, overrides = {}) =>
        rpc(client, {
          method,
          params,
          context: context(client),
          commandId: randomUUID(),
          ...overrides,
        });
      const read = (client, commandId = randomUUID()) =>
        rpc(client, {
          method: "command.read",
          context: { projectId },
          params: { commandId },
        });
      const accepted = (response) =>
        assert.equal(response.result?.admissionState, "accepted", JSON.stringify(response));
      const limited = (response) => {
        assert.equal(response.error?.code, "LIMIT_EXCEEDED", JSON.stringify(response));
        assert.equal(response.error.message, "命令超过允许的预算");
        assert.equal(response.error.submissionUnknown, false);
      };
      const starts = nativeOwner
        ? native.starts
        : () => native.calls.filter((method) => method === "areal/thread/start").length;
      return { f, native, client, context, rpc, write, read, accepted, limited, starts };
    }
    function budgetTest(name, reference, native) {
      test(name, async (t) => {
        await t.test("JS exact-clock reference", reference);
        await t.test("Rust Host real connection", native);
      });
    }
    async function nativeBudget(t) {
      const b = await budgetFixture(t, true);
      const state = async () => ({
        journal: await b.f.client.journal(b.native.projectId).read(),
        threads: (await b.native.core.call("thread/list", { limit: 100 })).data
          .map((thread) => thread.id)
          .sort(),
      });
      async function batch(client, requests) {
        const packets = requests.map((request) => ({
          id: randomUUID(),
          context:
            request.method === "command.read" ? { projectId: b.native.alias } : b.context(client),
          ...request,
        }));
        const started = performance.now();
        for (const packet of packets) client.secure.send(packet);
        const responses = [];
        for (const packet of packets) {
          const response = (await next(client.messages)).value;
          assert.equal(response.id, packet.id);
          responses.push(response);
        }
        b.f.evidence.nativeBudgetBatches ??= [];
        b.f.evidence.nativeBudgetBatches.push({
          elapsedMs: performance.now() - started,
          commandIds: requests.map((request) => request.commandId ?? null),
          responses,
        });
        return responses;
      }
      async function exhaust(client, requests) {
        const responses = await batch(client, [
          ...Array.from({ length: 19 }, () => ({
            method: "session.create",
            params: { unexpected: true },
            commandId: randomUUID(),
          })),
          ...requests,
        ]);
        for (const response of responses.slice(0, 10))
          assert.equal(response.error?.code, "INVALID_PARAMS", JSON.stringify(response));
        for (const response of responses.slice(10, 19)) {
          if (response.error?.code === "LIMIT_EXCEEDED") b.limited(response);
          else assert.equal(response.error?.code, "INVALID_PARAMS", JSON.stringify(response));
        }
        return responses.slice(19);
      }
      return { ...b, state, batch, exhaust };
    }
    test(`same peer overlapping session.create preserves one original command (${transport})`, async (t) => {
      const { f, native, client, write, read, starts } = await budgetFixture(t, true);
      const second = await device(t, f.remote, { identity: client.identity, transport });
      const commandId = randomUUID();
      const responses = await Promise.all([
        write(client, "session.create", {}, { commandId }),
        write(second, "session.create", {}, { commandId }),
      ]);
      const journal = await f.client.journal(native.projectId).read();
      const snapshot = journal.snapshot;
      const records = [...snapshot.pending, ...Object.values(snapshot.outcomes)].filter(
        (record) => record.remote?.commandId === commandId,
      );
      f.evidence.overlap = {
        commandId,
        peer: client.peer,
        responses,
        receipt: await read(client, commandId),
        records,
        starts: await starts(),
      };
      assert.equal(f.evidence.overlap.starts, 1, JSON.stringify(f.evidence.overlap));
      assert.equal(records.length, 1, JSON.stringify(f.evidence.overlap));
      for (const response of responses)
        assert.equal(response.result?.operationId, records[0].operationId);
    });
    test(`same peer overlapping interaction.respond preserves one original command (${transport})`, async (t) => {
      const { f, native, client, rpc, write } = await budgetFixture(t, true, true);
      const second = await device(t, f.remote, { identity: client.identity, transport });
      const created = await native.core.call("areal/thread/start", {
        requestId: randomUUID(),
        cwd: native.workspace,
        agentProfile: { id: "fixture", revision: "v1" },
      });
      const threadId = created.thread.id;
      const started = await native.core.call("areal/turn/start", {
        requestId: randomUUID(),
        threadId,
        input: [{ type: "text", text: "Create approved.txt with approved once, then finish." }],
        expectedConfigRevision: 1,
      });
      let interaction;
      await waitFor(async () => {
        interaction = (await native.core.call("areal/interaction/list", { threadId })).data.find(
          (item) => item.turnId === started.turn.id && item.status === "pending",
        );
        return interaction;
      });
      const target = { threadId, turnId: started.turn.id, interactionId: interaction.requestId };
      let detail = (
        await rpc(client, {
          method: "attention.read",
          context: { projectId: native.alias },
          params: target,
        })
      ).result;
      while (detail.nextCursor)
        detail = (
          await rpc(client, {
            method: "attention.read",
            context: { projectId: native.alias },
            params: { ...target, cursor: detail.nextCursor },
          })
        ).result;
      assert.equal(detail.complete, true);
      const params = {
        ...target,
        argumentsDigest: interaction.argumentsDigest,
        decision: "allowOnce",
        reviewToken: detail.reviewToken,
      };
      const commandId = randomUUID();
      const responses = await Promise.all([
        write(client, "interaction.respond", params, { commandId }),
        write(second, "interaction.respond", params, { commandId }),
      ]);
      const { snapshot } = await f.client.journal(native.projectId).read();
      const records = [...snapshot.pending, ...Object.values(snapshot.outcomes)].filter(
        (record) => record.remote?.commandId === commandId,
      );
      f.evidence.responseOverlap = { commandId, responses, records };
      assert.equal(records.length, 1, JSON.stringify(f.evidence.responseOverlap));
      for (const response of responses)
        assert.equal(
          response.result?.operationId,
          records[0].operationId,
          JSON.stringify(response),
        );
      await waitFor(async () => {
        try {
          return (
            (await readFile(join(native.workspace, "approved.txt"), "utf8")) === "approved once"
          );
        } catch (error) {
          if (error.code === "ENOENT") return false;
          throw error;
        }
      });
    });
    budgetTest(
      `connection write burst refuses the eleventh command before journal and RPC (${transport})`,
      async (t) => {
        const { f, client, rpc, write, read, accepted, limited, starts } = await budgetFixture(t);
        assert.equal(client.active.limits.writeRequestsPerSecond, 5);
        assert.equal(client.active.limits.writeBurst, 10);
        for (let n = 0; n < 10; n++) accepted(await write(client));
        const before = await readFile(join(f.home, "project-outcomes.json"), "utf8");
        const pending = await readFile(join(f.home, "project-pending.json"), "utf8");
        const saved = f.savedWrites.length;
        const refused = randomUUID();
        limited(await write(client, "session.create", {}, { commandId: refused }));
        assert.equal(starts(), 10);
        assert.equal(f.savedWrites.length, saved);
        assert.equal(await readFile(join(f.home, "project-outcomes.json"), "utf8"), before);
        assert.equal(await readFile(join(f.home, "project-pending.json"), "utf8"), pending);
        assert.equal((await read(client, refused)).result.admissionState, "notFound");
        const described = await rpc(client, { method: "host.describe", params: {} });
        assert.equal(described.result.limits.writeRequestsPerSecond, 5);
        assert.equal(described.result.limits.writeBurst, 10);
        assert.equal(described.result.limits.readRequestsPerSecond, 20);
        t.mock.timers.tick(199);
        limited(await write(client));
        t.mock.timers.tick(1);
        accepted(await write(client));
        limited(await write(client));
        assert.equal(starts(), 11);
        t.mock.timers.tick(5000);
        for (let n = 0; n < 10; n++) accepted(await write(client));
        limited(await write(client));
        assert.equal(starts(), 21);
        assert.equal(client.socket.readyState, 1);
      },
      async (t) => {
        const b = await nativeBudget(t);
        const before = await b.state();
        const commandId = randomUUID();
        const [refused] = await b.exhaust(b.client, [
          { method: "session.create", params: {}, commandId },
        ]);
        b.limited(refused);
        assert.equal(refused.error.commandId, commandId);
        const reader = await device(t, b.f.remote, {
          identity: b.client.identity,
          transport: transport === "direct" ? "relay" : "direct",
        });
        const original = await b.read(reader, commandId);
        assert.equal(original.result?.admissionState, "notFound");
        assert.deepEqual(await b.state(), before);
        assert.equal(await b.starts(), 0);
        const described = await b.rpc(reader, { method: "host.describe", params: {} });
        assert.equal(described.result.limits.writeRequestsPerSecond, 5);
        assert.equal(described.result.limits.writeBurst, 10);
        assert.equal(described.result.limits.readRequestsPerSecond, 20);
        b.f.evidence.nativeBudget = {
          group: "write burst",
          commandId,
          refusal: refused,
          original: original.result,
          journalAndThreadIdsUnchanged: true,
          timing:
            "real connection; exact 199/200ms boundary belongs to reference and Rust owner unit",
        };
      },
    );

    budgetTest(
      `receipt reads preserve write credit and mixed traffic retains the aggregate limit (${transport})`,
      async (t) => {
        const { client, write, read, accepted, starts } = await budgetFixture(t);
        for (let n = 0; n < 10; n++)
          assert.equal((await read(client)).result.admissionState, "notFound");
        for (let n = 0; n < 10; n++) accepted(await write(client));
        const over = await read(client);
        assert.equal(over.error?.code, "LIMIT_EXCEEDED");
        assert.equal(over.error.message, "请求过于频繁");
        assert.equal(starts(), 10);
        t.mock.timers.tick(999);
        assert.equal((await read(client)).error?.code, "LIMIT_EXCEEDED");
        t.mock.timers.tick(1);
        for (let n = 0; n < 20; n++)
          assert.equal((await read(client)).result.admissionState, "notFound");
        assert.equal((await read(client)).error?.code, "LIMIT_EXCEEDED");
        assert.equal(client.socket.readyState, 1);
      },
      async (t) => {
        const b = await nativeBudget(t);
        const before = await b.state();
        const commandId = randomUUID();
        const responses = await b.batch(b.client, [
          ...Array.from({ length: 10 }, () => ({
            method: "command.read",
            params: { commandId: randomUUID() },
          })),
          ...Array.from({ length: 10 }, () => ({
            method: "session.create",
            params: { unexpected: true },
            commandId: randomUUID(),
          })),
          { method: "session.create", params: {}, commandId },
        ]);
        for (const response of responses.slice(0, 10))
          assert.equal(response.result?.admissionState, "notFound");
        for (const response of responses.slice(10, 20))
          assert.equal(response.error?.code, "INVALID_PARAMS");
        const refused = responses[20];
        assert.equal(refused.error?.code, "LIMIT_EXCEEDED");
        assert.equal(refused.error.message, "请求过于频繁");
        assert.equal(refused.error.commandId, commandId);
        assert.equal(refused.error.submissionUnknown, false);
        const reader = await device(t, b.f.remote, {
          identity: b.client.identity,
          transport: transport === "direct" ? "relay" : "direct",
        });
        const original = await b.read(reader, commandId);
        assert.equal(original.result?.admissionState, "notFound");
        assert.deepEqual(await b.state(), before);
        assert.equal(await b.starts(), 0);
        b.f.evidence.nativeBudget = {
          group: "aggregate mixed traffic",
          commandId,
          refusal: refused,
          original: original.result,
          journalAndThreadIdsUnchanged: true,
          timing:
            "real connection; exact 999/1000ms boundary belongs to reference and Rust owner unit",
        };
      },
    );

    budgetTest(
      `all current write methods share the connection bucket while receipt reads remain available (${transport})`,
      async (t) => {
        const { client, write, read, accepted, limited, starts } = await budgetFixture(t);
        for (let n = 0; n < 10; n++) accepted(await write(client));
        for (const method of [
          "session.create",
          "session.send",
          "turn.stop",
          "interaction.respond",
          "task.question.reply",
          "task.pause",
        ]) {
          assert.ok(client.active.methods.includes(method));
          limited(await write(client, method));
        }
        assert.equal((await read(client)).result.admissionState, "notFound");
        assert.equal(starts(), 10);
      },
      async (t) => {
        const b = await nativeBudget(t);
        const before = await b.state();
        const requests = [
          "session.create",
          "session.send",
          "turn.stop",
          "interaction.respond",
          "task.question.reply",
          "task.pause",
        ].map((method) => ({ method, params: {}, commandId: randomUUID() }));
        const responses = [];
        let client = b.client;
        for (const request of requests) {
          const [response] = await b.exhaust(client, [request]);
          b.limited(response);
          responses.push(response);
          client.socket.close();
          await waitFor(() => client.socket.readyState === 3);
          if (request !== requests.at(-1))
            client = await device(t, b.f.remote, { identity: b.client.identity, transport });
        }
        const reader = await device(t, b.f.remote, {
          identity: b.client.identity,
          transport: transport === "direct" ? "relay" : "direct",
        });
        for (const request of requests) {
          assert.ok(b.client.active.methods.includes(request.method));
          assert.equal(
            (await b.read(reader, request.commandId)).result?.admissionState,
            "notFound",
          );
        }
        assert.deepEqual(await b.state(), before);
        assert.equal(await b.starts(), 0);
        b.f.evidence.nativeBudget = {
          group: "shared write bucket",
          requests,
          refusals: responses,
          journalAndThreadIdsUnchanged: true,
        };
      },
    );

    budgetTest(
      `write budgets isolate connections and devices and reconnect starts a new bucket (${transport})`,
      async (t) => {
        const { f, client, write, read, accepted, limited, starts } = await budgetFixture(t);
        for (let n = 0; n < 10; n++) accepted(await write(client));
        limited(await write(client));
        const sameDevice = await device(t, f.remote, {
          identity: client.identity,
          transport: transport === "direct" ? "relay" : "direct",
        });
        for (let n = 0; n < 10; n++) accepted(await write(sameDevice));
        limited(await write(sameDevice));
        const otherDevice = await device(t, f.remote, {
          pair: true,
          transport,
          preset: "Operator",
        });
        accepted(await write(otherDevice));
        client.socket.close();
        await new Promise((resolve) => client.socket.once("close", resolve));
        const reconnected = await device(t, f.remote, { identity: client.identity, transport });
        assert.notEqual(reconnected.active.connectionId, client.active.connectionId);
        accepted(await write(reconnected));
        assert.equal((await read(otherDevice)).result.admissionState, "notFound");
        assert.equal(starts(), 22);
      },
      async (t) => {
        const b = await nativeBudget(t);
        const before = await b.state();
        const commandId = randomUUID();
        const [refused] = await b.exhaust(b.client, [
          { method: "session.create", params: {}, commandId },
        ]);
        b.limited(refused);
        assert.deepEqual(await b.state(), before);
        const sameDevice = await device(t, b.f.remote, {
          identity: b.client.identity,
          transport: transport === "direct" ? "relay" : "direct",
        });
        assert.equal((await b.read(sameDevice, commandId)).result?.admissionState, "notFound");
        const one = await b.write(sameDevice);
        b.accepted(one);
        const otherDevice = await device(t, b.f.remote, {
          pair: true,
          transport,
          preset: "Operator",
          projects: [b.native.alias],
        });
        const two = await b.write(otherDevice);
        b.accepted(two);
        b.client.socket.close();
        await waitFor(() => b.client.socket.readyState === 3);
        const reconnected = await device(t, b.f.remote, { identity: b.client.identity, transport });
        assert.notEqual(reconnected.active.connectionId, b.client.active.connectionId);
        const three = await b.write(reconnected);
        b.accepted(three);
        assert.equal((await b.read(otherDevice)).result?.admissionState, "notFound");
        assert.equal(await b.starts(), 3);
        assert.equal(new Set([one, two, three].map((reply) => reply.result.operationId)).size, 3);
        b.f.evidence.nativeBudget = {
          group: "connection device and reconnect isolation",
          commandId,
          refusal: refused,
          accepted: [one.result, two.result, three.result],
          originalConnectionId: b.client.active.connectionId,
          reconnectedConnectionId: reconnected.active.connectionId,
          nativeStarts: await b.starts(),
        };
      },
    );

    budgetTest(
      `authentication and grant changes refuse writes before journal or dispatch (${transport})`,
      async (t) => {
        const { f, client, write, accepted, starts } = await budgetFixture(t);
        const unknown = await device(t, f.remote, { transport });
        assert.equal(unknown.active.error.code, "FORBIDDEN");
        const observer = await device(t, f.remote, { pair: true, transport });
        assert.equal((await write(observer)).error.code, "FORBIDDEN");
        const stale = await write(
          client,
          "session.create",
          {},
          {
            context: {
              projectId: "project",
              gatewayGeneration: client.active.gatewayGeneration,
              grantRevision: client.active.grantRevision + 1,
              serviceGeneration: "generation-1",
            },
          },
        );
        assert.equal(stale.error.code, "RESYNC_REQUIRED");
        assert.equal(starts(), 0);
        accepted(await write(client));
        const before = await readFile(join(f.home, "project-outcomes.json"), "utf8");
        // 模拟消息出队前已提交的撤权；验证 common acceptor 优先于写预算检查。
        f.remote.config.deviceGrants.find((grant) => grant.devicePeerId === client.peer).status =
          "revoked";
        client.secure.send({
          id: randomUUID(),
          method: "session.create",
          commandId: randomUUID(),
          context: {
            projectId: "project",
            gatewayGeneration: client.active.gatewayGeneration,
            grantRevision: client.active.grantRevision,
            serviceGeneration: "generation-1",
          },
          params: {},
        });
        const revoked = await next(client.messages);
        // 撤权沿用关闭通道语义；异步加密发送可能在关闭时被取消。
        assert.ok(revoked.done || revoked.value?.error?.code === "GRANT_CHANGED");
        assert.equal(starts(), 1);
        assert.equal(await readFile(join(f.home, "project-outcomes.json"), "utf8"), before);
      },
      async (t) => {
        const b = await nativeBudget(t);
        const before = await b.state();
        const unknown = await device(t, b.f.remote, { transport });
        assert.equal(unknown.active.error?.code, "FORBIDDEN");
        const observer = await device(t, b.f.remote, {
          pair: true,
          transport,
          projects: [b.native.alias],
        });
        assert.equal((await b.write(observer)).error?.code, "FORBIDDEN");
        const stale = await b.write(
          b.client,
          "session.create",
          {},
          {
            context: { ...b.context(b.client), grantRevision: b.client.active.grantRevision + 1 },
          },
        );
        assert.equal(stale.error?.code, "RESYNC_REQUIRED");
        assert.deepEqual(await b.state(), before);
        assert.equal(await b.starts(), 0);
        const accepted = await b.write(b.client);
        b.accepted(accepted);
        const afterAccepted = await b.state();
        await b.f.remote.control({ operation: "revoke", id: b.client.peer });
        await waitFor(() => b.client.socket.readyState === 3);
        const revoked = await device(t, b.f.remote, { identity: b.client.identity, transport });
        assert.equal(revoked.active.error?.code, "FORBIDDEN");
        assert.deepEqual(await b.state(), afterAccepted);
        assert.equal(await b.starts(), 1);
        assert.equal((await observer.read("healthy-after-revoke")).result.projects.length, 1);
        b.f.evidence.nativeBudget = {
          group: "authentication and grant fence",
          unauthorized: [unknown.active.error, stale.error, revoked.active.error],
          original: accepted.result,
          originalConnectionClosed: b.client.socket.readyState === 3,
          journalAndThreadIdsUnchangedAfterRevoke: true,
          observation:
            "public revocation and actual channel close; no synthetic queued-message barrier",
        };
      },
    );
  }
  test("real CLI enrollment persists encrypted capability before outbound Host registration", async (t) => {
    const relay = await relayFixture(t),
      f = await nativeHostFixture(t);
    f.evidence.relay = relay.resources;
    const { code } = relay.admin("enrollment");
    await f.remote.control({ operation: "enable", relay: relay.origin, code, confirmed: true });
    await waitFor(() => f.remote.state().connected);
    const saved = await f.persisted();
    assert.equal(saved.relay, relay.origin);
    assert.match(saved.room, /^[a-f0-9]{64}$/);
    const disk = JSON.stringify({
      state: JSON.parse(await readFile(join(f.home, "host/remote-state.json"), "utf8")),
      operations: await Promise.all(
        (await readdir(join(f.home, "host/remote-operations"))).map(async (name) =>
          JSON.parse(await readFile(join(f.home, "host/remote-operations", name), "utf8")),
        ),
      ),
    });
    for (const secret of [code, saved.capability]) {
      assert.ok(!disk.includes(secret));
      assert.ok(!JSON.stringify(f.remote.state()).includes(secret));
      assert.ok(!relay.logs().includes(secret));
    }
    await assert.rejects(
      f.remote.control({ operation: "enable", relay: relay.origin, code, confirmed: true }),
      { code: "enrollment-failed" },
    );
    assert.equal(f.remote.state().connected, true);
    await f.remote.control({ operation: "disable" });
    assert.equal(f.remote.state().connected, false);
    await f.remote.control({ operation: "enable", relay: relay.origin, confirmed: true });
    await waitFor(() => f.remote.state().connected);
  });
  test("production Relay client wire pairs with pinned Host and reads through the common v2 application", async (t) => {
    const { createRemoteWire } = await import("../packages/remote/src/wire.mjs");
    const relay = await relayFixture(t),
      f = await nativeHostFixture(t);
    f.evidence.relay = relay.resources;
    const workspace = join(f.evidence.root, "Project");
    await mkdir(workspace);
    const projectId = randomUUID().replaceAll("-", "").slice(0, 24);
    await f.source.register(randomUUID(), { id: projectId, root: workspace });
    await f.remote.control({
      operation: "enable",
      relay: relay.origin,
      code: relay.admin("enrollment").code,
      confirmed: true,
    });
    await waitFor(() => f.remote.state().connected);
    const invitation = await f.remote.control({ operation: "pair", transport: "relay" });
    const fragment = new URLSearchParams(new URL(invitation.payload).hash.slice(1));
    assert.equal(new URL(invitation.payload).origin, relay.origin);
    assert.equal(fragment.get("room"), (await f.persisted()).room);
    assert.ok(!invitation.payload.includes((await f.persisted()).capability));
    const identity = await createIdentity();
    const socket = new WebSocket(relay.origin.replace("https:", "wss:") + "/remote/socket", {
      origin: relay.origin,
    });
    t.after(() => socket.terminate());
    const { wire, ready } = createRemoteWire(socket, { room: fragment.get("room") });
    await ready;
    const secure = await secureChannel(wire, identity, fragment.get("host"), {
      maxMessageBytes: 256 * 1024,
    });
    secure.send({
      method: "hello",
      apiVersion: "areal.remote.v2",
      clientVersion: "test",
      displayName: "Relay fixture",
      inviteSecret: fragment.get("invite"),
    });
    const messages = secure.messages();
    assert.equal((await messages.next()).value.event, "pairing");
    await f.remote.control({
      operation: "approve",
      id: identityId(identity),
      projects: [projectId],
      preset: "Observer",
    });
    const active = (await messages.next()).value;
    assert.equal(active.event, "ready");
    assert.equal(active.hostId, fragment.get("host"));
    secure.send({ id: "read", method: "project.list", params: {} });
    assert.deepEqual((await messages.next()).value, {
      id: "read",
      result: {
        projects: [
          {
            projectId,
            name: "Project",
            connectionState: "offline",
            serviceGeneration: null,
          },
        ],
        nextCursor: null,
      },
    });
    secure.close();
  });

  test("pin mismatch and foreign room cannot request approval or consume an invitation", async (t) => {
    const f = await enrolledHost(t, {}, {}, nativeRelayHostFixture);
    f.evidence.relay = f.relay.resources;
    const invitation = await f.remote.control({ operation: "pair", transport: "relay" });
    const inviteSecret = new URLSearchParams(new URL(invitation.payload).hash.slice(1)).get(
      "invite",
    );
    await assert.rejects(
      device(t, f.remote, {
        pair: true,
        projects: [f.projectAlias],
        inviteSecret,
        hostPin: identityId(await createIdentity()),
      }),
    );
    await f.remote.refresh();
    assert.equal(f.remote.state().pending.length, 0);
    await assert.rejects(device(t, f.remote, { room: "f".repeat(64) }));
    assert.equal(f.remote.state().connected, true);
    assert.equal(
      (await device(t, f.remote, { pair: true, inviteSecret, projects: [f.projectAlias] })).active
        .event,
      "ready",
    );
  });
  test("Direct and Relay share device limits and grant shrink/revoke invalidates both", async (t) => {
    const f = await enrolledHost(t, {}, {}, nativeRelayHostFixture);
    f.evidence.relay = f.relay.resources;
    await f.remote.control({ operation: "enableDirect" });
    const first = await device(t, f.remote, { pair: true, projects: [f.projectAlias] });
    const direct = await device(t, f.remote, { identity: first.identity, transport: "direct" });
    assert.equal(direct.active.event, "ready");
    const extra = await device(t, f.remote, { identity: first.identity }).catch(() => null);
    assert.notEqual(extra?.active?.event, "ready");
    assert.equal((await first.read()).result.projects.length, 1);
    assert.equal((await direct.read()).result.projects.length, 1);
    await f.remote.control({
      operation: "updateGrant",
      id: first.peer,
      projects: [f.projectAlias],
      preset: "Observer",
    });
    await waitFor(() => first.socket.readyState === 3 && direct.socket.readyState === 3);
    const fresh = await device(t, f.remote, { identity: first.identity });
    assert.equal(fresh.active.grantRevision, 2);
    assert.notEqual(fresh.active.connectionId, first.active.connectionId);
    await f.remote.control({ operation: "revoke", id: first.peer });
    await waitFor(() => fresh.socket.readyState === 3);
    assert.equal(
      (await device(t, f.remote, { identity: first.identity })).active.error.code,
      "FORBIDDEN",
    );
  });
  test("Relay restart and Host restart create fresh connections without replaying requests", async (t) => {
    const f = await enrolledHost(t, {}, {}, nativeRelayHostFixture);
    f.evidence.relay = f.relay.resources;
    const first = await device(t, f.remote, { pair: true, projects: [f.projectAlias] });
    assert.equal((await first.read()).result.projects.length, 1);
    await f.relay.stop();
    await waitFor(() => first.socket.readyState === 3 && !f.remote.state().connected);
    await f.relay.start();
    await waitFor(() => f.remote.state().connected, 7000);
    const second = await device(t, f.remote, { identity: first.identity });
    assert.notEqual(second.active.connectionId, first.active.connectionId);
    assert.equal(second.active.gatewayGeneration, first.active.gatewayGeneration);
    const beforeRestart = await f.client.request("remote.read", {});
    f.remote = await f.restart();
    await waitFor(async () => (await f.remote.refresh()).connected);
    assert.deepEqual(await f.client.request("remote.read", {}), beforeRestart);
    const third = await device(t, f.remote, { identity: first.identity });
    assert.notEqual(third.active.gatewayGeneration, first.active.gatewayGeneration);
    assert.notEqual(third.active.connectionId, second.active.connectionId);
    assert.equal((await third.read()).result.projects.length, 1);
  });
  test("Host replacement closes old channels and requires explicit reclaim instead of fighting the replacement", async (t) => {
    const f = await enrolledHost(t, {}, {}, nativeRelayHostFixture);
    f.evidence.relay = f.relay.resources;
    const originalEnable = JSON.parse(
      await readFile(join(f.home, "host/remote-state.json"), "utf8"),
    ).receipt;
    assert.equal(originalEnable.state, "completed");
    const first = await device(t, f.remote, { pair: true, projects: [f.projectAlias] });
    const replacement = new WebSocket(f.relay.origin.replace("https:", "wss:") + "/remote/socket");
    t.after(() => replacement.terminate());
    await new Promise((resolve, reject) => {
      replacement.once("open", resolve);
      replacement.once("error", reject);
    });
    const ready = new Promise((resolve) =>
      replacement.once("message", (raw) => resolve(JSON.parse(raw))),
    );
    replacement.send(
      JSON.stringify({
        protocol: "areal.relay.v1",
        role: "host",
        room: f.remote.config.room,
        capability: f.remote.config.capability,
      }),
    );
    assert.equal((await ready).type, "ready");
    await waitFor(() => first.socket.readyState === 3 && !f.remote.state().connected);
    await new Promise((r) => setTimeout(r, 3200));
    assert.equal(replacement.readyState, 1);
    assert.match(f.remote.state().relayError, /替换/);
    const beforeReplay = await f.client.request("remote.read", {});
    const { operation } = await f.client.operation(originalEnable.requestId);
    assert.equal(operation.requestId, originalEnable.requestId);
    assert.equal(operation.state, "completed");
    assert.equal(operation.controlDigest, originalEnable.controlDigest);
    await f.client.request("remote.gateway.control", {
      requestId: originalEnable.requestId,
      expectedGeneration: f.client.generation,
      sourceId: f.source.sourceId,
      request: f.enrollmentRequest,
    });
    await new Promise((resolve) => setTimeout(resolve, 3200));
    assert.equal(replacement.readyState, 1);
    assert.equal((await f.remote.refresh()).connected, false);
    assert.deepEqual(await f.client.request("remote.read", {}), beforeReplay);
    f.evidence.completedEnableReplay = {
      requestId: originalEnable.requestId,
      state: operation.state,
      replacementRemainedConnected: true,
      configurationUnchanged: true,
    };
    await f.remote.control({ operation: "enable", relay: f.relay.origin, confirmed: true });
    await waitFor(() => f.remote.state().connected && replacement.readyState === 3);
    assert.equal((await device(t, f.remote, { identity: first.identity })).active.event, "ready");
  });
  test("failed durable save never starts a newly enrolled Host", async (t) => {
    await t.test("complete JS reference", async (t) => {
      const relay = await relayFixture(t),
        f = await hostFixture(t);
      f.rejectSave(true);
      await assert.rejects(
        f.remote.control({
          operation: "enable",
          relay: relay.origin,
          code: relay.admin("enrollment").code,
          confirmed: true,
        }),
        /storage unavailable/,
      );
      assert.equal(f.remote.state().enabled, false);
      assert.equal(f.remote.state().connected, false);
      assert.ok(!relay.logs().includes('"event":"closed"'));
    });
    await t.test("real Rust durable-save refusal", async (t) => {
      const relay = await relayFixture(t, { observeHostFrames: true });
      await assertNativeRelaySaveFailure(t, relay);
    });
  });

  test("noncanonical base64 from one client closes only that channel before Noise", async (t) => {
    const f = await enrolledHost(t, {}, {}, nativeRelayHostFixture);
    f.evidence.relay = f.relay.resources;
    const healthy = await device(t, f.remote, { pair: true, projects: [f.projectAlias] });
    const attacker = await rawRelay(t, f.remote);
    assert.equal(attacker.type, "ready");
    attacker.socket.send(JSON.stringify({ type: "data", channel: attacker.channel, data: "Zh==" }));
    await waitFor(() => attacker.socket.readyState === 3);
    assert.equal(f.remote.state().connected, true);
    assert.equal((await healthy.read()).result.projects.length, 1);
  });

  test("strict TLS rejects an untrusted CA, wrong SAN and expired certificate before enrollment", async (t) => {
    const trusted = await relayFixture(t);
    const env = { ...process.env };
    delete env.NODE_EXTRA_CA_CERTS;
    delete env.NODE_TEST_CONTEXT;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `try { await fetch(${JSON.stringify(trusted.origin)} + '/healthz'); process.exitCode = 2; } catch (error) { console.log(error.cause?.code); }`,
      ],
      { env, encoding: "utf8" },
    );
    assert.match(
      stdout.trim(),
      /SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY/,
    );
    for (const [certificate, expected] of [
      ["wrong.pem", "ERR_TLS_CERT_ALTNAME_INVALID"],
      ["expired.pem", "CERT_HAS_EXPIRED"],
    ]) {
      const relay = await relayFixture(t, { certificate });
      await assert.rejects(
        fetch(relay.origin + "/healthz"),
        (error) => error.cause?.code === expected,
      );
      const f = await hostFixture(t);
      await assert.rejects(
        f.remote.control({
          operation: "enable",
          relay: relay.origin,
          code: relay.admin("enrollment").code,
          confirmed: true,
        }),
        {
          code: "enrollment-failed",
          message: `Relay HTTPS 证书验证失败（${expected}）。请检查证书域名、有效期和桌面进程信任的 CA。`,
        },
      );
      assert.equal(f.remote.state().enabled, false);
    }
  });
  test("same-origin actual exported Remote shell serves hashed styles and excludes Desktop assets", async (t) => {
    const { exportRemoteAssets } = await import("./export-remote-assets.mjs");
    const root = await mkdtemp(join(tmpdir(), "rc12-deployed-shell-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const assetsDir = join(root, "shell");
    await exportRemoteAssets(new URL("../renderer/dist/", import.meta.url).pathname, assetsDir);
    const relay = await relayFixture(t, { assetsDir });
    const response = await fetch(relay.origin);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<link[^>]*rel="stylesheet"[^>]*href="\.\/assets\/remote-[^"/]+\.css"/);
    assert.match(
      response.headers.get("content-security-policy"),
      /style-src 'self' 'unsafe-inline'/,
    );
    assert.match(response.headers.get("content-security-policy"), /script-src 'self';/);
    const descriptor = JSON.parse(await readFile(join(assetsDir, "remote-assets.json"), "utf8"));
    let assetReads = 0;
    for (const asset of [...descriptor.assets, descriptor.worker]) {
      // Exhaustive closure checks also fetch lazy chunks and font fallbacks.
      // Respect the production 200-request/second HTTP budget.
      if (assetReads++ > 0 && assetReads % 100 === 0)
        await new Promise((resolve) => setTimeout(resolve, 1000));
      const res = await fetch(relay.origin + "/" + asset.path);
      assert.equal(res.status, 200);
      assert.deepEqual(
        Buffer.from(await res.arrayBuffer()),
        await readFile(join(assetsDir, asset.path)),
      );
    }
    for (const path of [
      "/index.html",
      "/remote.html?invite=secret",
      "/package.json",
      "/.private.json",
    ])
      assert.equal((await fetch(relay.origin + path)).status, 404);
  });
  test("Direct and Relay share one readonly Core observer and Relay recovery obtains a fresh native baseline", async (t) => {
    const f = await enrolledHost(t, {}, {}, nativeRelayHostFixture);
    f.evidence.relay = f.relay.resources;
    const native = await nativeCoreProject(t, f);
    const threadRequestId = randomUUID();
    const created = await native.core.call("areal/thread/start", {
      requestId: threadRequestId,
      cwd: native.workspace,
      options: { automaticSessionName: false, appendInstructions: "Baseline 1" },
    });
    const threadId = created.thread.id;
    const readThread = async () =>
      (await native.core.call("thread/read", { threadId, includeTurns: true })).thread;
    const readThreadIds = async () =>
      (await native.core.call("thread/list", { limit: 100 })).data
        .map((thread) => thread.id)
        .sort();
    const initialThread = await readThread();
    const threadIds = await readThreadIds();
    const journal = await f.client.journal(native.projectId).read();
    assert.equal(initialThread.desktop.configuration.revision, 1);
    assert.equal(initialThread.desktop.configuration.options.appendInstructions, "Baseline 1");
    await f.remote.control({ operation: "enableDirect" });
    const relay = await device(t, f.remote, { pair: true, projects: [native.alias] }),
      direct = await device(t, f.remote, { identity: relay.identity, transport: "direct" });
    async function reply(client, id) {
      for (;;) {
        const response = (await next(client.messages)).value;
        if (response?.event === "session.updated") continue;
        assert.equal(response?.id, id);
        return response;
      }
    }
    async function observe(client) {
      const id = randomUUID();
      client.secure.send({
        id,
        method: "session.open",
        context: { projectId: native.alias },
        params: { threadId },
      });
      const response = await reply(client, id);
      assert.ok(!response.error, JSON.stringify(response));
      return response.result;
    }
    const first = await observe(relay),
      second = await observe(direct);
    assert.equal(first.snapshot.threadId, threadId);
    assert.equal(first.snapshot.configRevision, 1);
    assert.equal(first.snapshot.configuration.options.appendInstructions, "Baseline 1");
    assert.deepEqual(second.snapshot, first.snapshot);
    assert.equal(first.sequence, 0);
    assert.equal(second.sequence, 0);
    assert.deepEqual(await f.client.journal(native.projectId).read(), journal);
    assert.deepEqual(await readThread(), initialThread);
    assert.deepEqual(await readThreadIds(), threadIds);
    await f.relay.stop();
    await waitFor(() => relay.socket.readyState === 3);
    assert.equal(direct.socket.readyState, 1);
    const configRequestId = randomUUID();
    const configured = await native.core.call("areal/thread/configure", {
      requestId: configRequestId,
      threadId,
      expectedRevision: 1,
      options: { automaticSessionName: false, appendInstructions: "Baseline 2" },
    });
    assert.equal(configured.revision, 2);
    const updatedThread = await readThread();
    assert.equal(updatedThread.desktop.configuration.revision, 2);
    assert.equal(updatedThread.desktop.configuration.options.appendInstructions, "Baseline 2");
    assert.deepEqual(updatedThread.turns, initialThread.turns);
    assert.deepEqual(await readThreadIds(), threadIds);
    assert.deepEqual(await f.client.journal(native.projectId).read(), journal);
    await f.relay.start();
    await waitFor(async () => (await f.remote.refresh()).connected, 7000);
    assert.deepEqual(await f.client.journal(native.projectId).read(), journal);
    assert.deepEqual(await readThread(), updatedThread);
    assert.deepEqual(await readThreadIds(), threadIds);
    const restored = await device(t, f.remote, { identity: relay.identity });
    const third = await observe(restored);
    assert.equal(third.snapshot.threadId, threadId);
    assert.equal(third.snapshot.configRevision, 2);
    assert.equal(third.snapshot.configuration.options.appendInstructions, "Baseline 2");
    assert.equal(third.sequence, 0);
    assert.notEqual(third.subscriptionId, first.subscriptionId);
    assert.notEqual(third.connectionId, first.connectionId);
    assert.equal((await direct.read("still-online")).result.projects[0].connectionState, "online");
    direct.secure.send({
      id: "still-observing",
      method: "session.history",
      context: { projectId: native.alias },
      params: { threadId, limit: 100 },
    });
    const history = await reply(direct, "still-observing");
    assert.equal(history.result?.subscriptionId, second.subscriptionId);
    assert.equal(history.result.connectionId, second.connectionId);
    restored.secure.send({ id: "legacy-write", method: "send", params: {} });
    const rejected = await reply(restored, "legacy-write");
    assert.equal(rejected.error?.code, "INVALID_PARAMS");
    assert.deepEqual(await f.client.journal(native.projectId).read(), journal);
    assert.deepEqual(await readThread(), updatedThread);
    assert.deepEqual(await readThreadIds(), threadIds);
    f.evidence.observerRecovery = {
      threadRequestId,
      configRequestId,
      threadId,
      projectId: native.projectId,
      alias: native.alias,
      baselineRevisions: [
        first.snapshot.configRevision,
        second.snapshot.configRevision,
        third.snapshot.configRevision,
      ],
      relay: { previous: first, restored: third },
      direct: { opened: second, history: history.result },
      journalUnchanged: true,
      nativeThreadUnchangedAfterConfiguration: true,
      threadAndTurnIdentitiesUnchanged: true,
      observation:
        "original Host journal, native thread, actual connections and subscriptions; physical Core RPC counts unobserved",
    };
  });

  test("unfinished Direct and Relay handshakes consume the same Host admission budget", async (t) => {
    const { createRemoteWire } = await import("../packages/remote/src/wire.mjs");
    const f = await enrolledHost(t, {}, {}, nativeRelayHostFixture);
    f.evidence.relay = f.relay.resources;
    await f.remote.control({ operation: "enableDirect" });
    const held = [];
    for (let n = 0; n < 4; n++) {
      const origin = f.remote.state().directUrl;
      const socket = new WebSocket(origin.replace(/^http/, "ws") + "/remote/socket", { origin });
      t.after(() => socket.terminate());
      await createRemoteWire(socket).ready;
      held.push(socket);
    }
    for (let n = 0; n < 4; n++) {
      const raw = await rawRelay(t, f.remote);
      assert.equal(raw.type, "ready");
      held.push(raw.socket);
    }
    // ready 由 Relay 发给 Client 后，再把 open 送给 Host；让独立 TCP 事件完成派发。
    await new Promise((resolve) => setTimeout(resolve, 50));
    const rejected = await rawRelay(t, f.remote);
    await waitFor(() => rejected.socket.readyState === 3);
    assert.ok(held.every((socket) => socket.readyState === 1));
    for (const socket of held) socket.terminate();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      (await device(t, f.remote, { pair: true, projects: [f.projectAlias] })).active.event,
      "ready",
    );
  });

  test("legacy encrypted Relay registration cannot reactivate without a new explicit enrollment", async (t) => {
    const relay = await relayFixture(t);
    const registration = await (
      await fetch(relay.origin + "/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: relay.admin("enrollment").code }),
      })
    ).json();
    const f = await nativeRelayHostFixture(t, {
      config: {
        enabled: true,
        relay: relay.origin,
        ...registration,
        identity: await createIdentity(),
      },
    });
    f.evidence.relay = relay.resources;
    await f.remote.refresh();
    assert.equal(f.remote.state().enabled, false);
    await assert.rejects(
      f.remote.control({ operation: "enable", relay: relay.origin, confirmed: true }),
      { code: "enrollment-required" },
    );
    await f.remote.control({
      operation: "enable",
      relay: relay.origin,
      code: relay.admin("enrollment").code,
      confirmed: true,
    });
    await waitFor(async () => (await f.remote.refresh()).connected);
    assert.notEqual((await f.persisted()).room, registration.room);
    f.evidence.legacyRegistration = {
      priorProtocol: "legacy without v2 marker",
      legacyWasDisabled: true,
      freshExplicitEnrollmentConnected: true,
      registrationReplaced: true,
    };
  });
  test("foreign channel injection is rejected without affecting another authorized device", async (t) => {
    const f = await enrolledHost(t, {}, {}, nativeRelayHostFixture);
    f.evidence.relay = f.relay.resources;
    const healthy = await device(t, f.remote, { pair: true, projects: [f.projectAlias] });
    const attacker = await rawRelay(t, f.remote),
      other = await rawRelay(t, f.remote);
    attacker.socket.send(JSON.stringify({ type: "data", channel: other.channel, data: "Zg==" }));
    await waitFor(() => attacker.socket.readyState === 3);
    assert.equal(other.socket.readyState, 1);
    assert.equal((await healthy.read()).result.projects.length, 1);
    other.socket.terminate();
  });
  test("paced orderly close delivers typed protocol/authentication refusals before closing only that channel", async (t) => {
    const f = await enrolledHost(
      t,
      { framesPerSecond: 8, bytesPerSecond: 524288 },
      {},
      nativeRelayHostFixture,
    );
    f.evidence.relay = f.relay.resources;
    const healthy = await device(t, f.remote, { pair: true, projects: [f.projectAlias] });
    for (const [options, code] of [
      [{}, "FORBIDDEN"],
      [{ apiVersion: "legacy" }, "PROTOCOL_UNSUPPORTED"],
    ]) {
      const rejected = await device(t, f.remote, options);
      assert.equal(rejected.active?.error?.code, code);
      await waitFor(() => rejected.socket.readyState === 3);
      assert.equal((await next(rejected.messages)).done, true);
      assert.equal((await healthy.read(code)).result.projects.length, 1);
    }
    const coalesced = await device(t, f.remote, { coalesceClose: true });
    assert.equal(coalesced.active?.error?.code, "FORBIDDEN");
    await waitFor(() => coalesced.socket.readyState === 3);
    assert.equal((await next(coalesced.messages)).done, true);
    assert.equal((await healthy.read("coalesced-close")).result.projects.length, 1);
    assert.equal(f.remote.state().connected, true);
    f.evidence.orderlyCloseObservation =
      "typed refusal before actual channel close and application EOF; private send buffer unobserved";
  });

  test(
    "revocation aborts already paced Relay bytes immediately and cannot publish them after the fence",
    { timeout: 180000 },
    async (t) => {
      await t.test("complete JS reference", async (t) => {
        const f = await enrolledHost(t, { framesPerSecond: 12, bytesPerSecond: 524288 });
        await nativeProject(t, f, { large: true });
        const reader = await device(t, f.remote, { pair: true });
        const healthy = await device(t, f.remote, { pair: true });
        reader.secure.send({
          id: "open",
          method: "session.open",
          context: { projectId: "project" },
          params: { threadId: "thread" },
        });
        assert.ok((await next(reader.messages)).value.result);
        const transport = f.remote.relayTransport;
        const endpoint = [...transport.channels.values()].find(
          (value) => value.remotePeer === reader.peer,
        );
        let sentData = 0;
        const send = transport.socket.send.bind(transport.socket);
        transport.socket.send = (text, ...args) => {
          const frame = JSON.parse(text);
          if (frame.type === "data" && frame.channel === endpoint.channel) sentData++;
          return send(text, ...args);
        };
        reader.secure.send({
          id: "pending",
          method: "session.history",
          context: { projectId: "project" },
          params: { threadId: "thread", limit: 100 },
        });
        await waitFor(() => endpoint.queue.length > 0 && transport.paceTimer);
        assert.ok(endpoint.bufferedAmount > 0);
        assert.ok(f.remote.sessions.sendBufferedBytes() >= endpoint.bufferedAmount);
        await f.remote.control({ operation: "revoke", id: reader.peer });
        const sentAtFence = sentData;
        assert.equal(endpoint.readyState, 3);
        assert.equal(endpoint.queue.length, 0);
        assert.equal(endpoint.bufferedAmount, 0);
        assert.throws(() => endpoint.send(Buffer.of(1)), /断开/);
        await waitFor(() => reader.socket.readyState === 3);
        assert.equal((await healthy.read("after-revoke")).result.projects.length, 1);
        assert.equal(sentData, sentAtFence);
        assert.equal(f.remote.state().connected, true);
      });
      await t.test("real Rust receiver and public fence", async (t) => {
        await nativePacedFence(t, "revoke");
      });
    },
  );

  test("Host fails closed on a valid but unusable service budget without a reconnect loop", async (t) => {
    const relay = await relayFixture(t, { relayOptions: { framesPerSecond: 2 } });
    const f = await nativeRelayHostFixture(t);
    f.evidence.relay = relay.resources;
    await f.remote.control({
      operation: "enable",
      relay: relay.origin,
      code: relay.admin("enrollment").code,
      confirmed: true,
    });
    await waitFor(() => f.remote.state().relayError.includes("传输限额"));
    const refused = await f.client.request("remote.read", {});
    const acceptedHandshakes = relay.acceptedTlsConnections;
    assert.equal(f.remote.state().connected, false);
    assert.equal((await f.remote.refresh()).deviceGrants.filter((grant) => grant.online).length, 0);
    await new Promise((resolve) => setTimeout(resolve, 3200));
    assert.equal((await f.remote.refresh()).connected, false);
    assert.equal(relay.acceptedTlsConnections, acceptedHandshakes);
    assert.deepEqual(await f.client.request("remote.read", {}), refused);
    f.evidence.unusableBudget = {
      diagnostic: f.remote.state().relayError,
      acceptedHandshakes,
      configurationUnchanged: true,
      observation:
        "actual TLS connections and persisted configuration; private retry timer unobserved",
    };
  });

  test(
    "re-enabling drops paced old-generation work and no old timer writes into a fresh connection",
    { timeout: 180000 },
    async (t) => {
      await t.test("complete JS reference", async (t) => {
        const f = await enrolledHost(t);
        await nativeProject(t, f, { large: true });
        const reader = await device(t, f.remote, { pair: true });
        reader.secure.send({
          id: "open",
          method: "session.open",
          context: { projectId: "project" },
          params: { threadId: "thread" },
        });
        assert.ok((await next(reader.messages)).value.result);
        const old = f.remote.relayTransport;
        let oldSends = 0;
        const send = old.socket.send.bind(old.socket);
        old.socket.send = (...args) => {
          oldSends++;
          return send(...args);
        };
        reader.secure.send({
          id: "pending",
          method: "session.history",
          context: { projectId: "project" },
          params: { threadId: "thread", limit: 100 },
        });
        await waitFor(() => old.paceTimer !== null && old.paceTimer !== undefined);
        await f.remote.control({ operation: "enable", relay: f.relay.origin, confirmed: true });
        const countAtClose = oldSends;
        await waitFor(() => f.remote.state().connected);
        assert.equal(old.closed, true);
        assert.equal(old.paceTimer, null);
        assert.equal(old.channels.size, 0);
        assert.equal(old.controls.size, 0);
        const fresh = await device(t, f.remote, { identity: reader.identity });
        assert.equal((await fresh.read()).result.projects.length, 1);
        assert.equal(oldSends, countAtClose);
      });
      await t.test("real Rust receiver and public fence", async (t) => {
        await nativePacedFence(t, "enable");
      });
    },
  );

  test(
    "sequential large history reads honor actual Relay Host rates without disconnecting another device",
    { timeout: 180000 },
    async (t) => {
      for (const limits of [
        {},
        { framesPerSecond: 12, bytesPerSecond: 524288, maxFrameBytes: 131072, idleTimeoutMs: 3000 },
      ]) {
        await t.test(
          Object.keys(limits).length ? "lowered operator limits" : "default limits",
          async (t) => {
            const relay = await relayFixture(t, { relayOptions: limits, observeHostFrames: true });
            const f = await nativeHostFixture(t);
            f.evidence.relay = relay.resources;
            await f.remote.control({
              operation: "enable",
              relay: relay.origin,
              code: relay.admin("enrollment").code,
              confirmed: true,
            });
            await waitFor(() => f.remote.state().connected);
            const native = await nativeHistory(t, f);
            const itemIds = native.thread.turns.flatMap((turn) =>
              turn.items.map((item) => item.id),
            );
            f.evidence.historyRates = {
              limits,
              completedTurns: native.thread.turns.length,
              itemIds,
              completedReads: [],
              observedHostFrames: relay.hostFrames,
              observation:
                "TLS proxy receive timestamps and JSON payload byte counts; no Rust physical-send inference",
            };
            const reader = await device(t, f.remote, { pair: true, projects: [native.alias] });
            const healthy = await device(t, f.remote, { pair: true, projects: [native.alias] });
            async function readHistory(id, method) {
              reader.secure.send({
                id,
                method,
                context: { projectId: native.alias },
                params: {
                  threadId: native.threadId,
                  ...(method === "session.history" ? { limit: 100 } : {}),
                },
              });
              for (;;) {
                const response = await next(reader.messages);
                if (response.value?.event === "session.updated") continue;
                assert.equal(
                  response.done,
                  false,
                  `Host=${f.remote.state().connected}; reader=${reader.socket.readyState}; healthy=${healthy.socket.readyState}`,
                );
                assert.equal(response.value.id, id);
                assert.ok(response.value.result, JSON.stringify(response.value));
                const turns =
                  method === "session.open"
                    ? response.value.result.snapshot.turns
                    : response.value.result.turns;
                assert.deepEqual(
                  turns.flatMap((turn) => turn.items.map((item) => item.id)),
                  itemIds,
                );
                f.evidence.historyRates.completedReads.push(id);
                return response.value;
              }
            }
            await readHistory("open", "session.open");
            await new Promise((resolve) => setTimeout(resolve, 1100));
            const loadStarted = performance.now();
            let totalBytes = 0;
            for (let index = 0; index < 20; index++) {
              totalBytes += Buffer.byteLength(
                JSON.stringify(await readHistory(`history-${index}`, "session.history")),
              );
              assert.equal((await healthy.read(`healthy-${index}`)).result.projects.length, 1);
              if (index % 5 === 0) {
                const invalid = await rawRelay(t, f.remote);
                invalid.socket.send(
                  JSON.stringify({ type: "data", channel: invalid.channel, data: "Zh==" }),
                );
                await waitFor(() => invalid.socket.readyState === 3);
              }
            }
            const frames = relay.hostFrames;
            const heartbeats = relay.hostPongs.filter((pong) => pong.at >= loadStarted).length;
            assert.equal(relay.frameObservationErrors, 0);
            const windows = frames.map((frame) =>
              frames.filter((other) => other.at >= frame.at && other.at < frame.at + 1000),
            );
            const maxFrames = Math.max(...windows.map((window) => window.length));
            const maxBytes = Math.max(
              ...windows.map((window) => window.reduce((sum, frame) => sum + frame.bytes, 0)),
            );
            Object.assign(f.evidence.historyRates, {
              sequentialReads: 20,
              totalBytes,
              maxFrames,
              maxBytes,
              heartbeatsDuringLoad: heartbeats,
              closeFrames: frames.filter((frame) => frame.type === "close").length,
              observedHostFrames: [...frames],
            });
            assert.ok(
              maxFrames <= (limits.framesPerSecond ?? 80) - 2,
              "automatic pong reserve remains available",
            );
            assert.ok(maxBytes <= (limits.bytesPerSecond ?? 2097152));
            assert.ok(frames.every((frame) => frame.bytes <= (limits.maxFrameBytes ?? 524288)));
            assert.equal(frames.filter((frame) => frame.type === "close").length, 4);
            if (limits.idleTimeoutMs)
              assert.ok(heartbeats > 0, "lowered policy includes actual automatic pongs");
            t.diagnostic(
              `observed Host frames at TLS proxy rolling-second: ${maxFrames} JSON frames / ${maxBytes} bytes; ${heartbeats} actual heartbeat pongs reserved`,
            );
            t.diagnostic(
              `20 sequential history responses, ${totalBytes} plaintext bytes; Host and both devices remain connected`,
            );
            assert.equal(f.remote.state().connected, true);
            assert.equal(reader.socket.readyState, 1);
            assert.equal(healthy.socket.readyState, 1);
          },
        );
      }
    },
  );

  test(
    "a real paused Relay TCP reader is isolated while a second device keeps reading Host state",
    { timeout: 180000 },
    async (t) => {
      const f = await enrolledHost(
        t,
        { maxBufferedBytesPerChannel: 131072 },
        {},
        nativeHostFixture,
      );
      f.evidence.relay = f.relay.resources;
      const native = await nativeHistory(t, f);
      const slow = await device(t, f.remote, { pair: true, projects: [native.alias] }),
        healthy = await device(t, f.remote, { pair: true, projects: [native.alias] });
      slow.secure.send({
        id: "open",
        method: "session.open",
        context: { projectId: native.alias },
        params: { threadId: native.threadId },
      });
      const opened = (await next(slow.messages)).value;
      assert.ok(opened.result, JSON.stringify(opened));
      const itemIds = native.thread.turns.flatMap((turn) => turn.items.map((item) => item.id));
      assert.deepEqual(
        opened.result.snapshot.turns.flatMap((turn) => turn.items.map((item) => item.id)),
        itemIds,
      );
      const beforeJournal = await f.client.journal(native.projectId).read();
      const threadIds = await native.readThreadIds();
      const online = async () =>
        (await f.remote.refresh()).deviceGrants.find((grant) => grant.devicePeerId === slow.peer)
          ?.online === true;
      assert.equal(await online(), true);
      slow.socket._socket.pause();
      let rounds = 0;
      try {
        for (; rounds < 16 && (await online()); rounds++) {
          for (let index = 0; index < 8; index++)
            slow.secure.send({
              id: `slow-${rounds}-${index}`,
              method: "session.history",
              context: { projectId: native.alias },
              params: { threadId: native.threadId, limit: 100 },
            });
          assert.equal(
            (await healthy.read(`healthy-${rounds}`)).result.projects.find(
              (project) => project.projectId === native.alias,
            ).connectionState,
            "online",
          );
          await new Promise((resolve) => setTimeout(resolve, 1050));
        }
        assert.equal(
          await online(),
          false,
          "the actual slow channel is isolated within the bounded backlog",
        );
        assert.equal((await f.remote.refresh()).connected, true);
        assert.equal((await healthy.read("after-isolation")).result.projects.length, 1);
      } finally {
        slow.socket._socket?.resume();
      }
      await waitFor(() => slow.socket.readyState === 3);
      assert.deepEqual(await f.client.journal(native.projectId).read(), beforeJournal);
      assert.deepEqual(await native.readThread(), native.thread);
      assert.deepEqual(await native.readThreadIds(), threadIds);
      f.evidence.slowReader = {
        projectId: native.projectId,
        threadId: native.threadId,
        subscriptionId: opened.result.subscriptionId,
        connectionId: opened.result.connectionId,
        itemIds,
        rounds,
        slowOffline: true,
        slowSocketClosed: true,
        healthyRemainedOnline: true,
        journalAndOriginalThreadUnchanged: true,
        observation:
          "actual TCP pause, public device presence and socket close; physical Core connection counts unobserved",
      };
    },
  );
}
