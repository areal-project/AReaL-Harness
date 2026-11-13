import assert from "node:assert/strict";
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
import { createIdentity, identityId, secureChannel } from "../packages/remote/src/channel.mjs";
import { createRemoteWire } from "../packages/remote/src/wire.mjs";
import { readConfig } from "../../../services/remote-relay/src/config.mjs";
import { openStore } from "../../../services/remote-relay/src/store.mjs";
import { serve } from "../../../services/remote-relay/src/server.mjs";

const require = createRequire(new URL("../app/package.json", import.meta.url));
const WebSocket = require("ws");
export const hash = (value) => createHash("sha256").update(value).digest("hex");
const POLL_MS = 5000;
export const NEGATIVE_MS = POLL_MS * 2 + 500;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

export async function until(read, label) {
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
export async function observeNone(read, label) {
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

export async function pushRelay(t, heldTokens = new Set()) {
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

export async function phone(t, remote, projectId, identity = undefined, pair = false) {
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
    socket,
    identity,
    peer: identityId(identity),
    active,
    close: () => socket.terminate(),
    nextMessage: () => next(messages),
    send(method, params = {}, commandId, context) {
      const id = randomUUID();
      secure.send({
        id,
        method,
        params,
        ...(commandId ? { commandId } : {}),
        ...(context ? { context } : {}),
      });
      return id;
    },
    async rpc(method, params = {}, commandId, context) {
      const id = this.send(method, params, commandId, context);
      for (;;) {
        const result = await next(messages);
        if (result.id === id) return result;
      }
    },
  };
}
export async function grant(remote, peer) {
  await remote.refresh();
  return remote.state().deviceGrants.find((value) => value.devicePeerId === peer);
}
export function privateFree(value, tokens) {
  const text = JSON.stringify(value);
  assert.equal(
    tokens.some((token) => text.includes(token)),
    false,
    "public evidence must not contain a push token",
  );
}
export async function runWithIsolatedCA(filename) {
  const home = await certificates("Native push isolated CA");
  try {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    process.stdout.write(
      execFileSync(process.execPath, ["--test", filename], {
        env: { ...env, RC12_TLS_HOME: home, NODE_EXTRA_CA_CERTS: join(home, "ca.pem") },
        encoding: "utf8",
        timeout: 300000,
      }),
    );
  } catch (error) {
    if (error.stdout) process.stdout.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    throw error;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
