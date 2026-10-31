import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { createIdentity, identityId, secureChannel } from "../packages/remote/src/channel.mjs";
import { createRemoteWire } from "../packages/remote/src/wire.mjs";
import { parseRemoteConfig } from "../app/src/core/remote-config.cjs";
import { hostFixture, waitFor } from "./remote-relay-fixture.mjs";

const require = createRequire(new URL("../app/package.json", import.meta.url));
const WebSocket = require("ws");

async function next(messages) {
  let timer;
  try {
    return (
      await Promise.race([
        messages.next(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("hello response deadline")), 5000);
        }),
      ])
    ).value;
  } finally {
    clearTimeout(timer);
  }
}

async function connect(t, remote, { identity, inviteSecret, ...metadata } = {}) {
  identity ??= await createIdentity();
  const origin = remote.direct.origin;
  const socket = new WebSocket(origin.replace(/^http/, "ws") + "/remote/socket", { origin });
  t.after(() => socket.terminate());
  const { wire, ready } = createRemoteWire(socket);
  await ready;
  const secure = await secureChannel(wire, identity, identityId(remote.config.identity));
  const messages = secure.messages();
  secure.send({
    method: "hello",
    apiVersion: "areal.remote.v2",
    clientVersion: "client-kind-test",
    displayName: "Test device",
    ...(inviteSecret ? { inviteSecret } : {}),
    ...metadata,
  });
  return { socket, messages, identity, peer: identityId(identity), first: await next(messages) };
}

async function invitation(remote) {
  return new URLSearchParams(
    new URL((await remote.control({ operation: "pair" })).payload).hash.slice(1),
  ).get("invite");
}

for (const clientKind of [undefined, "web", "ios", "android"]) {
  test(`approved ${clientKind ?? "legacy"} metadata survives persistence and scope changes`, async (t) => {
    const f = await hostFixture(t);
    const { remote } = f;
    await remote.control({ operation: "enableDirect" });
    const inviteSecret = await invitation(remote);
    const writes = f.savedWrites.length;
    const client = await connect(t, remote, {
      inviteSecret,
      ...(clientKind ? { clientKind } : {}),
    });
    assert.equal(client.first.event, "pairing");
    assert.equal(remote.state().pending[0].clientKind, clientKind);
    assert.equal(f.savedWrites.length, writes, "hello does not persist pending metadata");
    assert.equal((await f.persisted()).deviceGrants?.length ?? 0, 0);
    await remote.control({
      operation: "approve",
      id: client.peer,
      projects: ["project"],
      preset: "Observer",
    });
    const active = await next(client.messages);
    assert.equal(active.event, "ready");
    assert.equal(remote.state().pending.length, 0);
    const grant = (await f.persisted()).deviceGrants[0];
    assert.equal(grant.clientKind, clientKind);
    assert.equal(Object.hasOwn(grant, "clientKind"), clientKind !== undefined);
    assert.deepEqual(grant.capabilities, ["observe", "review"]);
    assert.equal(remote.state().deviceGrants[0].clientKind, clientKind);
    assert.deepEqual(parseRemoteConfig(await f.persisted()).deviceGrants[0], grant);

    client.socket.terminate();
    await waitFor(() => remote.sessions.sockets.size === 0);
    const approvedWrites = f.savedWrites.length;
    const reconnect = await connect(t, remote, {
      identity: client.identity,
      clientKind: clientKind === "ios" ? "web" : "ios",
    });
    assert.equal(reconnect.first.event, "ready");
    assert.equal(f.savedWrites.length, approvedWrites, "reconnect does not save client metadata");
    assert.deepEqual((await f.persisted()).deviceGrants[0], grant);
    await remote.control({
      operation: "updateGrant",
      id: client.peer,
      projects: ["project"],
      preset: "Operator",
    });
    const updated = (await f.persisted()).deviceGrants[0];
    assert.equal(updated.clientKind, clientKind);
    assert.equal(updated.revision, 2);
    assert.deepEqual(updated.capabilities, [
      "observe",
      "review",
      "submit",
      "interrupt",
      "answer",
      "pauseTask",
    ]);
  });
}

test("unknown hello client kinds fail before invitation consumption or persistence", async (t) => {
  const f = await hostFixture(t);
  await f.remote.control({ operation: "enableDirect" });
  const inviteSecret = await invitation(f.remote);
  const writes = f.savedWrites.length;
  for (const clientKind of ["desktop", "", null, 1, {}]) {
    const client = await connect(t, f.remote, { inviteSecret, clientKind });
    assert.equal(client.first.error.code, "INVALID_PARAMS");
    assert.equal(f.remote.state().pending.length, 0);
    assert.equal(f.remote.invite.secret, inviteSecret);
    assert.equal(f.savedWrites.length, writes);
    client.socket.terminate();
    await waitFor(() => f.remote.sessions.sockets.size === 0);
  }
});

test("stored grants reject invalid client kinds and accept legacy absence", () => {
  const grant = {
    devicePeerId: "peer",
    displayName: "Device",
    projectIds: ["project"],
    capabilities: ["observe"],
    revision: 1,
    status: "active",
  };
  assert.equal(parseRemoteConfig({ deviceGrants: [grant] }).deviceGrants[0], grant);
  for (const clientKind of ["web", "ios", "android"])
    assert.equal(
      parseRemoteConfig({ deviceGrants: [{ ...grant, clientKind }] }).deviceGrants[0].clientKind,
      clientKind,
    );
  for (const clientKind of ["desktop", "", null, 1, {}])
    assert.throws(() => parseRemoteConfig({ deviceGrants: [{ ...grant, clientKind }] }));
});
