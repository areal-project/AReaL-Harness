import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createIdentity, identityId, secureChannel } from "../packages/remote/src/channel.mjs";
import { createRemoteWire } from "../packages/remote/src/wire.mjs";
import { parseRemoteConfig } from "@areal/workbench-service/desktop/core/remote-config.cjs";
import { browserDeviceName } from "../renderer/remote-web/device-name.mjs";
import { nativeRelayHostFixture as hostFixture, waitFor } from "./remote-relay-fixture.mjs";

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

async function connect(t, remote, { identity, inviteSecret, displayName = "Chrome · macOS" } = {}) {
  identity ??= await createIdentity();
  const origin = remote.state().directUrl;
  const socket = new WebSocket(origin.replace(/^http/, "ws") + "/remote/socket", { origin });
  t.after(() => socket.terminate());
  const { wire, ready } = createRemoteWire(socket);
  await ready;
  const secure = await secureChannel(wire, identity, identityId(remote.config.identity));
  const messages = secure.messages();
  secure.send({
    method: "hello",
    apiVersion: "areal.remote.v2",
    clientVersion: "device-management-test",
    displayName,
    ...(inviteSecret ? { inviteSecret } : {}),
  });
  return {
    socket,
    secure,
    messages,
    identity,
    peer: identityId(identity),
    first: await next(messages),
  };
}

async function pairDevice(t, f, displayName) {
  const { remote } = f;
  const inviteSecret = new URLSearchParams(
    new URL((await remote.control({ operation: "pair" })).payload).hash.slice(1),
  ).get("invite");
  const client = await connect(t, remote, { inviteSecret, displayName });
  assert.equal(client.first.event, "pairing");
  await remote.control({
    operation: "approve",
    id: client.peer,
    projects: [f.projectAlias],
    preset: "Observer",
  });
  client.active = await next(client.messages);
  assert.equal(client.active.event, "ready");
  await remote.refresh();
  return client;
}

const grantOf = (remote, peer) =>
  remote.state().deviceGrants.find((value) => value.devicePeerId === peer);

test("same-named devices get distinct names, pairing time and live presence", async (t) => {
  const f = await hostFixture(t);
  const { remote } = f;
  await remote.control({ operation: "enableDirect" });
  const before = Date.now();
  const first = await pairDevice(t, f, "Chrome · macOS");
  const second = await pairDevice(t, f, "Chrome · macOS");
  assert.equal(grantOf(remote, first.peer).displayName, "Chrome · macOS");
  assert.equal(grantOf(remote, second.peer).displayName, "Chrome · macOS (2)");
  const stored = (await f.persisted()).deviceGrants;
  assert.ok(stored.every((grant) => grant.pairedAt >= before));
  assert.deepEqual(parseRemoteConfig(await f.persisted()).deviceGrants, stored);

  await waitFor(async () => {
    await remote.refresh();
    return grantOf(remote, first.peer).online === true;
  });
  assert.ok(grantOf(remote, first.peer).lastSeenAt >= before);
  first.socket.terminate();
  await waitFor(async () => {
    await remote.refresh();
    return first.socket.readyState === 3 && grantOf(remote, first.peer).online === false;
  });
  assert.ok(grantOf(remote, first.peer).lastSeenAt >= before);

  const pairedAt = stored[0].pairedAt;
  await remote.control({
    operation: "updateGrant",
    id: first.peer,
    projects: [f.projectAlias],
    preset: "Operator",
  });
  assert.equal(grantOf(remote, first.peer).pairedAt, pairedAt, "updates keep pairing time");
  assert.ok(!grantOf(remote, first.peer).capabilities.includes("manage"));
  await remote.control({
    operation: "updateGrant",
    id: first.peer,
    projects: [f.projectAlias],
    preset: "Operator",
    manage: true,
  });
  assert.ok(grantOf(remote, first.peer).capabilities.includes("manage"));
  await assert.rejects(async () =>
    remote.control({
      operation: "updateGrant",
      id: first.peer,
      projects: [f.projectAlias],
      preset: "Observer",
      manage: true,
    }),
  );
  assert.ok(grantOf(remote, first.peer).capabilities.includes("submit"));
});

test("rename keeps the connection and revision; revoked devices can be forgotten", async (t) => {
  const f = await hostFixture(t);
  const { remote } = f;
  await remote.control({ operation: "enableDirect" });
  const phone = await pairDevice(t, f, "Safari · iOS");
  const laptop = await pairDevice(t, f, "Chrome · macOS");
  const revision = grantOf(remote, phone.peer).revision;

  await remote.control({ operation: "renameDevice", id: phone.peer, name: "  我的 iPhone  " });
  assert.equal(grantOf(remote, phone.peer).displayName, "我的 iPhone");
  assert.equal(grantOf(remote, phone.peer).revision, revision);
  assert.equal(grantOf(remote, phone.peer).online, true, "rename does not disconnect");
  assert.equal(phone.socket.readyState, 1);
  phone.secure.send({ id: "renamed", method: "host.describe", params: {} });
  const described = await next(phone.messages);
  assert.equal(described.id, "renamed");
  assert.equal(described.result.connectionId, phone.active.connectionId);
  await assert.rejects(remote.control({ operation: "renameDevice", id: phone.peer, name: "   " }), {
    code: "invalidRequest",
  });
  await assert.rejects(
    remote.control({ operation: "renameDevice", id: phone.peer, name: "x".repeat(81) }),
    { code: "invalidRequest" },
  );

  await remote.control({ operation: "revoke", id: laptop.peer });
  const revoked = grantOf(remote, laptop.peer);
  assert.equal(revoked.status, "revoked");
  assert.equal(typeof revoked.revokedAt, "number");
  assert.equal(revoked.online, false);
  await waitFor(() => laptop.socket.readyState === 3);
  await assert.rejects(
    remote.control({ operation: "renameDevice", id: laptop.peer, name: "旧电脑" }),
    { code: "invalidRequest" },
  );

  await remote.control({ operation: "forgetRevoked" });
  assert.equal(grantOf(remote, laptop.peer), undefined);
  assert.equal(grantOf(remote, phone.peer).status, "active");
  assert.deepEqual(
    (await f.persisted()).deviceGrants.map((grant) => grant.devicePeerId),
    [phone.peer],
  );
  const beforeForget = await f.client.request("remote.read", {});
  const requestId = randomUUID();
  await f.client.request("remote.gateway.control", {
    requestId,
    expectedGeneration: f.client.generation,
    sourceId: f.source.sourceId,
    request: { operation: "forgetRevoked" },
  });
  const { operation } = await f.client.operation(requestId);
  const afterForget = await f.client.request("remote.read", {});
  assert.equal(operation.requestId, requestId);
  assert.equal(operation.sourceId, f.source.sourceId);
  assert.equal(operation.method, "remote.replace");
  assert.equal(operation.state, "completed");
  assert.equal(operation.previousRevision, beforeForget.revision);
  assert.equal(operation.revision, afterForget.revision);
  assert.deepEqual(
    afterForget.config,
    beforeForget.config,
    "nothing to forget leaves grants unchanged",
  );
  t.diagnostic(
    "Host receipt and persisted configuration verified; physical write count is not measured",
  );
});

test("renamed and forgotten devices reject malformed requests", async (t) => {
  const f = await hostFixture(t);
  const beforeForget = await f.client.request("remote.read", {});
  assert.equal(Object.hasOwn(beforeForget.config, "deviceGrants"), false);
  assert.equal(Object.hasOwn(beforeForget.config, "pushCommands"), false);
  const requestId = randomUUID();
  await f.client.request("remote.gateway.control", {
    requestId,
    expectedGeneration: f.client.generation,
    sourceId: f.source.sourceId,
    request: { operation: "forgetRevoked" },
  });
  const { operation } = await f.client.operation(requestId);
  const afterForget = await f.client.request("remote.read", {});
  assert.equal(operation.requestId, requestId);
  assert.equal(operation.sourceId, f.source.sourceId);
  assert.equal(operation.method, "remote.replace");
  assert.equal(operation.state, "completed");
  assert.equal(operation.previousRevision, beforeForget.revision);
  assert.equal(operation.revision, afterForget.revision);
  assert.deepEqual(afterForget.config, beforeForget.config);
  assert.deepEqual(parseRemoteConfig(await f.persisted()), beforeForget.config);
  for (const request of [
    { operation: "renameDevice", id: "peer" },
    { operation: "renameDevice", id: "peer", name: 1 },
    { operation: "renameDevice", id: "peer", name: "a", extra: true },
    { operation: "forgetRevoked", id: "peer" },
  ])
    await assert.rejects(async () => f.remote.control(request), /无效手机设置参数/);
});

test("stored grants accept optional timestamps and reject malformed ones", () => {
  const grant = {
    devicePeerId: "peer",
    displayName: "Device",
    projectIds: ["project"],
    capabilities: ["observe"],
    revision: 1,
    status: "revoked",
    pairedAt: 1,
    revokedAt: 2,
  };
  assert.deepEqual(parseRemoteConfig({ deviceGrants: [grant] }).deviceGrants[0], grant);
  for (const value of [{ pairedAt: "1" }, { revokedAt: 1.5 }])
    assert.throws(() => parseRemoteConfig({ deviceGrants: [{ ...grant, ...value }] }));
});

test("browser device names name the browser and system", () => {
  const cases = [
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
      0,
      "Chrome · macOS",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      5,
      "Safari · iOS",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      5,
      "Safari · iPadOS",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0",
      0,
      "Edge · Windows",
    ],
    [
      "Mozilla/5.0 (Android 15; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0",
      5,
      "Firefox · Android",
    ],
    ["", 0, "浏览器"],
  ];
  for (const [userAgent, touchPoints, name] of cases)
    assert.equal(browserDeviceName(userAgent, touchPoints), name);
});
