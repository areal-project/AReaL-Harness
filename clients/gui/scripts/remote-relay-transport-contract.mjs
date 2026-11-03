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

if (!process.env.RC12_TLS_HOME) {
  test("strict process-CA Relay Host contract", async () => {
    const home = await certificates();
    try {
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const output = execFileSync(process.execPath, ["--test", import.meta.filename], {
        env: { ...env, RC12_TLS_HOME: home, NODE_EXTRA_CA_CERTS: join(home, "ca.pem") },
        encoding: "utf8",
        timeout: 180000,
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
      if (!approval) {
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
      return { f, native, client, rpc, write, read, accepted, limited, starts };
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
    test(`connection write burst refuses the eleventh command before journal and RPC (${transport})`, async (t) => {
      const { f, client, rpc, write, read, accepted, limited, starts } = await budgetFixture(
        t,
        true,
      );
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
    });
    test(`receipt reads preserve write credit and mixed traffic retains the aggregate limit (${transport})`, async (t) => {
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
    });
    test(`all current write methods share the connection bucket while receipt reads remain available (${transport})`, async (t) => {
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
    });
    test(`write budgets isolate connections and devices and reconnect starts a new bucket (${transport})`, async (t) => {
      const { f, client, write, read, accepted, limited, starts } = await budgetFixture(t);
      for (let n = 0; n < 10; n++) accepted(await write(client));
      limited(await write(client));
      const sameDevice = await device(t, f.remote, {
        identity: client.identity,
        transport: transport === "direct" ? "relay" : "direct",
      });
      for (let n = 0; n < 10; n++) accepted(await write(sameDevice));
      limited(await write(sameDevice));
      const otherDevice = await device(t, f.remote, { pair: true, transport, preset: "Operator" });
      accepted(await write(otherDevice));
      client.socket.close();
      await new Promise((resolve) => client.socket.once("close", resolve));
      const reconnected = await device(t, f.remote, { identity: client.identity, transport });
      assert.notEqual(reconnected.active.connectionId, client.active.connectionId);
      accepted(await write(reconnected));
      assert.equal((await read(otherDevice)).result.admissionState, "notFound");
      assert.equal(starts(), 22);
    });
    test(`authentication and grant changes refuse writes before journal or dispatch (${transport})`, async (t) => {
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
    });
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
    const f = await enrolledHost(t),
      native = await nativeProject(t, f);
    await f.remote.control({ operation: "enableDirect" });
    const relay = await device(t, f.remote, { pair: true }),
      direct = await device(t, f.remote, { identity: relay.identity, transport: "direct" });
    async function observe(device) {
      device.secure.send({
        id: "observe",
        method: "session.open",
        context: { projectId: "project" },
        params: { threadId: "thread" },
      });
      const response = (await next(device.messages)).value;
      assert.ok(!response.error, JSON.stringify(response));
      return response.result;
    }
    const first = await observe(relay),
      second = await observe(direct);
    assert.equal(first.snapshot.title, "Baseline 1");
    assert.equal(second.snapshot.title, "Baseline 1");
    assert.equal(
      native.calls.filter((method) => method === "initialize").length,
      2,
      "Desktop plus one shared readonly observer",
    );
    await f.relay.stop();
    await waitFor(() => relay.socket.readyState === 3);
    const observations = native.calls.filter((method) => method === "areal/thread/observe").length;
    native.setVersion(2);
    await f.relay.start();
    await waitFor(() => f.remote.state().connected, 7000);
    assert.equal(
      native.calls.filter((method) => method === "areal/thread/observe").length,
      observations,
      "transport restart does not replay application requests",
    );
    const restored = await device(t, f.remote, { identity: relay.identity });
    const third = await observe(restored);
    assert.equal(third.snapshot.title, "Baseline 2");
    assert.equal(third.sequence, 0);
    assert.notEqual(third.subscriptionId, first.subscriptionId);
    assert.notEqual(third.connectionId, first.connectionId);
    assert.equal((await direct.read("still-online")).result.projects[0].connectionState, "online");
    const count = native.calls.length;
    restored.secure.send({ id: "legacy-write", method: "send", params: {} });
    assert.equal((await next(restored.messages)).value.error.code, "INVALID_PARAMS");
    assert.equal(native.calls.length, count);
    assert.ok(
      native.calls.every((method) =>
        [
          "initialize",
          "initialized",
          "areal/capabilities",
          "areal/thread/observe",
          "areal/subscription/remove",
          "thread/read",
        ].includes(method),
      ),
    );
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
    const f = await hostFixture(t, {
      config: {
        enabled: true,
        relay: relay.origin,
        ...registration,
        identity: await createIdentity(),
      },
    });
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
    await waitFor(() => f.remote.state().connected);
    assert.notEqual((await f.persisted()).room, registration.room);
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

  test("revocation aborts already paced Relay bytes immediately and cannot publish them after the fence", async (t) => {
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

  test("re-enabling drops paced old-generation work and no old timer writes into a fresh connection", async (t) => {
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

  test(
    "sequential large history reads honor actual Relay Host rates without disconnecting another device",
    { timeout: 60000 },
    async (t) => {
      for (const limits of [
        {},
        { framesPerSecond: 12, bytesPerSecond: 524288, maxFrameBytes: 131072, idleTimeoutMs: 3000 },
      ]) {
        await t.test(
          Object.keys(limits).length ? "lowered operator limits" : "default limits",
          async (t) => {
            const f = await enrolledHost(t, limits);
            const frames = [];
            let heartbeats = 0;
            const socket = f.remote.relayTransport.socket,
              send = socket.send.bind(socket);
            socket.on("ping", () => heartbeats++);
            socket.send = (text, ...args) => {
              frames.push({
                at: performance.now(),
                bytes: Buffer.byteLength(text),
                type: JSON.parse(text).type,
              });
              return send(text, ...args);
            };
            await nativeProject(t, f, { large: true });
            const reader = await device(t, f.remote, { pair: true });
            const healthy = await device(t, f.remote, { pair: true });
            async function readHistory(id, method) {
              reader.secure.send({
                id,
                method,
                context: { projectId: "project" },
                params: {
                  threadId: "thread",
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
                return response.value;
              }
            }
            await readHistory("open", "session.open");
            await new Promise((resolve) => setTimeout(resolve, 1100));
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
            const windows = frames.map((frame) =>
              frames.filter((other) => other.at >= frame.at && other.at < frame.at + 1000),
            );
            const maxFrames = Math.max(...windows.map((window) => window.length));
            const maxBytes = Math.max(
              ...windows.map((window) => window.reduce((sum, frame) => sum + frame.bytes, 0)),
            );
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
              `maximum outbound rolling-second: ${maxFrames} JSON frames / ${maxBytes} bytes; ${heartbeats} actual heartbeat pongs reserved`,
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
    { timeout: 30000 },
    async (t) => {
      const f = await enrolledHost(t, { maxBufferedBytesPerChannel: 131072 });
      const native = await nativeProject(t, f, { large: true });
      const slow = await device(t, f.remote, { pair: true }),
        healthy = await device(t, f.remote, { pair: true });
      slow.secure.send({
        id: "open",
        method: "session.open",
        context: { projectId: "project" },
        params: { threadId: "thread" },
      });
      assert.equal((await next(slow.messages)).value.result.snapshot.turns[0].items.length, 100);
      assert.equal(native.connections(), 2);
      slow.socket._socket.pause();
      t.after(() => slow.socket._socket?.resume());
      for (let round = 0; round < 16 && native.connections() > 1; round++) {
        for (let index = 0; index < 8; index++)
          slow.secure.send({
            id: `slow-${round}-${index}`,
            method: "session.history",
            context: { projectId: "project" },
            params: { threadId: "thread", limit: 100 },
          });
        assert.equal(
          (await healthy.read(`healthy-${round}`)).result.projects[0].connectionState,
          "online",
        );
        await new Promise((resolve) => setTimeout(resolve, 1050));
      }
      assert.equal(
        native.connections(),
        1,
        "slow channel releases its only Core observer within the bounded service backlog",
      );
      assert.equal(f.remote.state().connected, true);
      assert.equal((await healthy.read("after-isolation")).result.projects.length, 1);
      slow.socket._socket.resume();
      await waitFor(() => slow.socket.readyState === 3);
    },
  );
}
