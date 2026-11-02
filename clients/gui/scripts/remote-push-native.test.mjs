import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as netServer, connect as connectNet } from "node:net";
import { createServer as tlsServer } from "node:tls";
import { createSecureServer, connect as connectHttp2 } from "node:http2";
import { certificates } from "./remote-relay-fixture.mjs";
import { nativeHostFixture, nativeCoreProject } from "./remote-native-host-fixture.mjs";
import { createIdentity, identityId, secureChannel } from "../packages/remote/src/channel.mjs";
import { createRemoteWire } from "../packages/remote/src/wire.mjs";
import { readConfig } from "../../../services/remote-relay/src/config.mjs";
import { openStore } from "../../../services/remote-relay/src/store.mjs";
import { serve } from "../../../services/remote-relay/src/server.mjs";

const require = createRequire(new URL("../app/package.json", import.meta.url));
const WebSocket = require("ws");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const POLL_MS = 5000;
const NEGATIVE_MS = POLL_MS * 2 + 500;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

async function until(read, label) {
  const deadline = performance.now() + 30000;
  while (performance.now() < deadline) {
    const value = await read();
    if (value) return value;
    await pause(25);
  }
  throw new Error(`Native push fixture deadline: ${label}`);
}
async function next(messages) {
  let timer;
  try {
    const result = await Promise.race([
      messages.next(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Native phone reply deadline")), 10000);
      }),
    ]);
    assert.equal(result.done, false, "the original Noise connection must remain open");
    return result.value;
  } finally {
    clearTimeout(timer);
  }
}
async function observeNone(read, label) {
  const deadline = performance.now() + NEGATIVE_MS;
  while (performance.now() < deadline) {
    assert.equal(await read(), 0, label);
    await pause(50);
  }
}

// 只旁读真实 TLS 解密后的 WebSocket 帧；不改变转发数据或 Host producer。
function tap(socket, isServer, receive) {
  const receiver = new WebSocket.Receiver({ isServer, maxPayload: 524288 });
  let header = Buffer.alloc(0);
  let upgraded = false;
  let ignored = false;
  receiver.on("error", () => receive({ type: "fixtureTapError" }));
  receiver.on("message", (bytes, binary) => {
    if (binary) return;
    try {
      receive(JSON.parse(bytes.toString("utf8")));
    } catch {
      receive({ type: "fixtureTapError" });
    }
  });
  socket.on("data", (chunk) => {
    if (ignored) return;
    if (upgraded) {
      receiver.write(Buffer.from(chunk));
      return;
    }
    header = Buffer.concat([header, chunk]);
    const end = header.indexOf("\r\n\r\n");
    if (end < 0) {
      if (header.length > 32768) ignored = true;
      return;
    }
    upgraded = /upgrade:\s*websocket/i.test(header.subarray(0, end).toString("ascii"));
    ignored = !upgraded;
    if (upgraded && header.length > end + 4) receiver.write(Buffer.from(header.subarray(end + 4)));
    header = Buffer.alloc(0);
  });
  socket.once("close", () => receiver.destroy());
}

async function pushRelay(t, heldTokens) {
  const home = await mkdtemp(join(tmpdir(), "native-push-relay-"));
  let apns, proxy, store, server;
  const sessions = new Set(),
    records = [],
    frames = [],
    results = [],
    ready = [],
    sockets = new Set();
  t.after(async () => {
    await server?.close();
    store?.close();
    for (const socket of sockets) socket.destroy();
    if (proxy?.listening) await new Promise((done) => proxy.close(done));
    for (const session of sessions) session.destroy();
    if (apns?.listening) await new Promise((done) => apns.close(done));
    await rm(home, { recursive: true, force: true });
  });
  const ca = await readFile(join(process.env.RC12_TLS_HOME, "ca.pem"));
  const tlsOptions = {
    key: await readFile(join(process.env.RC12_TLS_HOME, "server.key")),
    cert: await readFile(join(process.env.RC12_TLS_HOME, "server.pem")),
  };
  apns = createSecureServer(tlsOptions);
  let sequence = 0,
    tapErrors = 0;
  apns.on("session", (session) => {
    sessions.add(session);
    session.on("error", () => {});
    session.once("close", () => sessions.delete(session));
  });
  apns.on("stream", (stream, headers) => {
    stream.on("error", () => {});
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => {
      const path = String(headers[":path"] ?? "");
      assert.equal(path.startsWith("/3/device/"), true, "real Relay uses the APNs device endpoint");
      assert.equal(
        typeof headers.authorization === "string",
        true,
        "real Relay signs APNs requests",
      );
      const token = path.slice("/3/device/".length);
      const record = {
        token,
        collapseId: headers["apns-collapse-id"],
        payload: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        replied: false,
        reply(status) {
          if (this.replied || stream.destroyed) return;
          this.replied = true;
          stream.respond({ ":status": status });
          stream.end(status === 410 ? JSON.stringify({ reason: "Unregistered" }) : "");
        },
      };
      records.push(record);
      if (!heldTokens.has(token)) record.reply(200);
    });
  });
  await new Promise((done) => apns.listen(0, "127.0.0.1", done));
  const probe = netServer();
  await new Promise((done) => probe.listen(0, "127.0.0.1", done));
  const backendPort = probe.address().port;
  await new Promise((done) => probe.close(done));
  proxy = tlsServer(tlsOptions, (socket) => {
    const upstream = connectNet(backendPort, "127.0.0.1");
    sockets.add(socket);
    sockets.add(upstream);
    let host = false;
    tap(socket, true, (message) => {
      if (message.type === "fixtureTapError") tapErrors++;
      if (message.role === "host") host = true;
      if (host && message.type === "push") frames.push({ sequence: ++sequence, message });
    });
    tap(upstream, false, (message) => {
      if (message.type === "fixtureTapError") tapErrors++;
      if (host && message.type === "ready") ready.push(message.push);
      if (host && message.type === "pushResult") results.push({ sequence: ++sequence, message });
    });
    socket.pipe(upstream).pipe(socket);
    for (const stream of [socket, upstream]) {
      stream.on("error", () => {
        socket.destroy();
        upstream.destroy();
      });
      stream.once("close", () => {
        sockets.delete(stream);
        socket.destroy();
        upstream.destroy();
      });
    }
  });
  await new Promise((done) => proxy.listen(0, "127.0.0.1", done));
  const origin = `https://127.0.0.1:${proxy.address().port}`;
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const keyFile = join(home, "apns.p8");
  await writeFile(keyFile, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const configPath = join(home, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      publicOrigin: origin,
      listen: `127.0.0.1:${backendPort}`,
      trustedLocalTlsProxy: true,
      allowedClientOrigins: [origin],
      dataDir: join(home, "data"),
      apns: {
        teamId: "ABCDEFGHIJ",
        keyId: "KLMNOPQRST",
        keyFile,
        bundleId: "org.example.nativepush",
      },
    }),
    { mode: 0o600 },
  );
  const config = readConfig(configPath);
  store = openStore(config);
  server = await serve(config, store, {
    connect: (origin) => {
      assert.equal(
        origin === "https://api.sandbox.push.apple.com",
        true,
        "development registration uses the original sandbox APNs origin",
      );
      return connectHttp2(`https://127.0.0.1:${apns.address().port}`, { ca });
    },
  });
  return {
    origin,
    enrollment: () => store.enrollment().code,
    frames,
    results,
    ready,
    records,
    release(token, status) {
      const pending = records.filter((record) => record.token === token && !record.replied);
      assert.equal(pending.length > 0, true, "the original real APNs request is held");
      for (const record of pending) record.reply(status);
    },
    evidence() {
      const summarize = (message) => ({
        tokenSha256: hash(message.token),
        kind: ["attention", "turnCompleted", "turnFailed"].includes(message.kind)
          ? message.kind
          : "invalid",
        count: Number.isSafeInteger(message.count) ? message.count : null,
        collapseIdSha256: hash(String(message.collapseId)),
        targetSha256: hash(JSON.stringify(message.target ?? null)),
      });
      return {
        pushReady: ready.map((value) => value === true),
        tapErrors,
        frames: frames.map(({ sequence, message }) => ({ sequence, ...summarize(message) })),
        results: results.map(({ sequence, message }) => ({
          sequence,
          tokenSha256: hash(message.token),
          status: message.status === "unregistered" ? "unregistered" : "invalid",
        })),
        apns: records.map((record) => ({
          tokenSha256: hash(record.token),
          collapseIdSha256: hash(String(record.collapseId)),
          targetSha256: hash(JSON.stringify(record.payload.target ?? null)),
          replied: record.replied,
        })),
      };
    },
  };
}

async function phone(t, remote, projectId, identity = undefined, pair = false) {
  identity ??= await createIdentity();
  const invite = pair
    ? new URLSearchParams(
        new URL(
          (await remote.control({ operation: "pair", transport: "relay" })).payload,
        ).hash.slice(1),
      ).get("invite")
    : null;
  const origin = remote.config.relay;
  const socket = new WebSocket(origin.replace(/^http/, "ws") + "/remote/socket", { origin });
  t.after(() => socket.terminate());
  const { wire, ready } = createRemoteWire(socket, { room: remote.config.room });
  await ready;
  const secure = await secureChannel(wire, identity, identityId(remote.config.identity));
  const messages = secure.messages();
  secure.send({
    method: "hello",
    apiVersion: "areal.remote.v2",
    clientVersion: "native-push-fixture",
    displayName: "Native push phone",
    clientKind: "ios",
    ...(invite ? { inviteSecret: invite } : {}),
  });
  let active = await next(messages);
  if (pair) {
    assert.equal(active.event, "pairing");
    await remote.control({
      operation: "approve",
      id: identityId(identity),
      projects: [projectId],
      preset: "Operator",
    });
    active = await next(messages);
  }
  return {
    identity,
    peer: identityId(identity),
    active,
    close: () => socket.terminate(),
    async rpc(method, params = {}, commandId) {
      const id = randomUUID();
      secure.send({ id, method, params, ...(commandId ? { commandId } : {}) });
      for (;;) {
        const result = await next(messages);
        if (result.id === id) return result;
      }
    },
  };
}
async function grant(remote, peer) {
  await remote.refresh();
  return remote.state().deviceGrants.find((value) => value.devicePeerId === peer);
}
function privateFree(value, tokens) {
  const text = JSON.stringify(value);
  assert.equal(
    tokens.some((token) => text.includes(token)),
    false,
    "public evidence must not contain a push token",
  );
}
function attentionFrame(relay, target) {
  return relay.frames.find(({ message }) => message.target?.attentionRef === target.attentionRef)
    ?.message;
}
function verifyAttention(message, target, projectId, token) {
  assert.equal(message.type === "push", true);
  assert.equal(message.kind === "attention", true);
  assert.equal(message.environment === "development", true);
  assert.equal(message.token === token, true, "the frame uses the exact current synthetic token");
  assert.equal(
    message.target.projectId === projectId,
    true,
    "push project matches the original public alias",
  );
  assert.equal(
    message.target.threadId === target.threadId,
    true,
    "push thread matches the real approval",
  );
  assert.equal(
    message.target.attentionRef === target.attentionRef,
    true,
    "push attention matches the real approval",
  );
  assert.equal(Number.isSafeInteger(message.count) && message.count > 0, true);
  assert.equal(typeof message.collapseId === "string" && message.collapseId.length > 0, true);
  const text = JSON.stringify(message);
  for (const secret of ["PRIVATE_PUSH_APPROVAL", "approved.txt", "approved once"])
    assert.equal(text.includes(secret), false, "push frame contains opaque references only");
}
function registered(response, expected) {
  assert.equal(response.error === undefined, true, "device command has a successful response");
  assert.equal(
    response.result?.registered === expected,
    true,
    "device command has the original registration result",
  );
  assert.equal(
    Object.keys(response.result).join(",") === "registered",
    true,
    "device result contains no credential fields",
  );
}

if (!process.env.RC12_TLS_HOME) {
  test("native push uses the isolated process CA", async () => {
    const home = await certificates("Native push isolated CA");
    try {
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      process.stdout.write(
        execFileSync(process.execPath, ["--test", import.meta.filename], {
          env: { ...env, RC12_TLS_HOME: home, NODE_EXTRA_CA_CERTS: join(home, "ca.pem") },
          encoding: "utf8",
          timeout: 300000,
        }),
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
} else {
  test(
    "native approval attention reaches real Relay and fences token rotation, online state and revocation",
    { timeout: 240000 },
    async (t) => {
      const tokenA = "a".repeat(64),
        tokenB = "b".repeat(64),
        tokenC = "c".repeat(64);
      const tokens = [tokenA, tokenB, tokenC];
      const relay = await pushRelay(t, new Set([tokenA, tokenB]));
      const f = await nativeHostFixture(t);
      const native = await nativeCoreProject(t, f, { approval: true });
      const proof = { negativeObservationMs: NEGATIVE_MS, checks: [] };
      f.evidence.nativePush = proof;
      t.after(() => {
        proof.relay = relay.evidence();
        proof.modelRequests = native.modelRequests;
        privateFree(proof, tokens);
        return writeFile(
          join(f.evidence.root, "native-push-evidence.json"),
          JSON.stringify(proof, null, 2),
          { mode: 0o600 },
        );
      });
      await f.remote.control({
        operation: "enable",
        relay: relay.origin,
        code: relay.enrollment(),
        confirmed: true,
      });
      await until(async () => (await f.remote.refresh()).connected, "native Relay connected");
      const first = await phone(t, f.remote, native.alias, undefined, true);
      assert.equal(first.active.capabilities.includes("push"), true);
      await until(() => relay.ready.includes(true), "actual Relay ready push capability");
      const registration = randomUUID();
      registered(
        await first.rpc(
          "device.push.register",
          { platform: "apns", token: tokenA, environment: "development" },
          registration,
        ),
        true,
      );
      registered(
        await first.rpc(
          "device.push.register",
          { environment: "development", token: tokenA.toUpperCase(), platform: "apns" },
          registration,
        ),
        true,
      );
      assert.equal(
        (
          await first.rpc(
            "device.push.register",
            { platform: "apns", token: tokenB, environment: "development" },
            registration,
          )
        ).error?.code === "COMMAND_CONFLICT",
        true,
      );
      const original = (await first.rpc("command.read", { commandId: registration })).result;
      assert.equal(original.admissionState, "accepted");
      assert.equal(original.receipt.registered, true);
      const savedDigest = (await f.persisted()).pushCommands.find(
        (command) => command.devicePeerId === first.peer && command.commandId === registration,
      )?.semanticDigest;
      assert.equal(
        savedDigest ===
          hash(
            JSON.stringify({
              method: "device.push.register",
              params: { platform: "apns", token: tokenA, environment: "development" },
            }),
          ),
        true,
        "native encrypted command digest preserves the original JS field ordering",
      );
      const fresh = await f.make();
      const stored = await grant(fresh, first.peer);
      assert.equal(stored.pushRegistered, true);
      assert.equal(stored.revision, first.active.grantRevision);
      privateFree(fresh.state(), tokens);
      proof.checks.push(
        "Noise registration original receipt, canonical replay, conflict and fresh public state",
      );

      const online = await native.createApproval();
      await observeNone(
        () => relay.frames.length,
        "online phone suppresses native attention wire sends within two product periods",
      );
      await native.denyApproval(online);
      first.close();
      await until(
        async () => (await grant(f.remote, first.peer)).online === false,
        "native phone offline authority",
      );
      await observeNone(
        () => relay.frames.length,
        "offline baseline does not invent a notification for old attention",
      );

      const a = await native.createApproval();
      const frameA = await until(
        () => attentionFrame(relay, a),
        "new real Core approval reaches actual Relay wire",
      );
      verifyAttention(frameA, a, native.alias, tokenA);
      await until(
        () => relay.records.find((record) => record.token === tokenA),
        "actual APNs request for original token",
      );
      const rotated = await phone(t, f.remote, native.alias, first.identity);
      const rotation = randomUUID();
      registered(
        await rotated.rpc(
          "device.push.register",
          { platform: "apns", token: tokenB, environment: "development" },
          rotation,
        ),
        true,
      );
      relay.release(tokenA, 410);
      await until(
        () =>
          relay.results.some(
            ({ message }) => message.token === tokenA && message.status === "unregistered",
          ),
        "real Relay returns the late original-token 410",
      );
      assert.equal((await grant(fresh, first.peer)).pushRegistered, true);
      await native.denyApproval(a);
      rotated.close();
      await until(
        async () => (await grant(f.remote, first.peer)).online === false,
        "rotated phone offline authority",
      );
      const b = await native.createApproval();
      const frameB = await until(
        () => attentionFrame(relay, b),
        "late original-token 410 preserves actual current-token delivery",
      );
      verifyAttention(frameB, b, native.alias, tokenB);
      assert.equal(
        frameB.collapseId === frameA.collapseId,
        true,
        "fresh approval shares the current collapse window",
      );
      assert.equal(
        frameB.count === frameA.count + 1,
        true,
        "collapse count advances once for the next original approval",
      );
      await until(
        () => relay.records.find((record) => record.token === tokenB),
        "actual APNs current token request",
      );
      relay.release(tokenB, 410);
      await until(
        () => relay.results.some(({ message }) => message.token === tokenB),
        "current-token 410 reaches the native owner",
      );
      const after410 = await f.make();
      await until(
        async () => (await grant(after410, first.peer)).pushRegistered === false,
        "current-token removal persists through a fresh public facade",
      );
      privateFree(after410.state(), tokens);
      await native.denyApproval(b);
      proof.checks.push(
        "real approval Relay/APNs frames, collapse increment, late old-token 410 and persisted current-token removal",
      );

      const finalPhone = await phone(t, f.remote, native.alias, first.identity);
      assert.equal(
        (await finalPhone.rpc("command.read", { commandId: rotation })).result.receipt.registered,
        true,
        "historical original registration receipt survives token removal",
      );
      const unregister = randomUUID();
      registered(await finalPhone.rpc("device.push.unregister", {}, unregister), false);
      registered(await finalPhone.rpc("device.push.unregister", {}, unregister), false);
      assert.equal(
        (await finalPhone.rpc("command.read", { commandId: unregister })).result.receipt.registered,
        false,
      );
      assert.equal(
        (await finalPhone.rpc("command.read", { commandId: registration })).result.receipt
          .registered,
        true,
        "unregister does not rewrite historical registration receipts",
      );
      registered(
        await finalPhone.rpc(
          "device.push.register",
          { platform: "apns", token: tokenC, environment: "development" },
          randomUUID(),
        ),
        true,
      );
      const pending = await native.createApproval();
      await f.remote.control({ operation: "revoke", id: first.peer });
      await until(
        async () => (await grant(f.remote, first.peer)).status === "revoked",
        "native revocation authority",
      );
      const before = relay.frames.length;
      await observeNone(
        () => relay.frames.length - before,
        "revocation fences pre-existing Core attention without sending the revoked token",
      );
      await native.denyApproval(pending);
      const revokedFresh = await native.createApproval();
      await observeNone(
        () => relay.frames.length - before,
        "revocation fences newly observed Core attention",
      );
      await native.denyApproval(revokedFresh);
      assert.equal(relay.evidence().tapErrors, 0);
      privateFree(f.remote.state(), tokens);
      proof.checks.push(
        "bounded online/offline baseline and revocation observations; no completion or queue-watch claim",
      );
    },
  );
}
