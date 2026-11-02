import assert from "node:assert/strict";
import { test, after } from "node:test";
import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createIdentity, identityId, secureChannel } from "../packages/remote/src/channel.mjs";
import { createRemoteWire } from "../packages/remote/src/wire.mjs";
import { certificates, relayFixture, waitFor } from "./remote-relay-fixture.mjs";
import {
  nativeRelay,
  observedRelay,
  rollingWindows,
  nativeResources,
  observerResources,
} from "./remote-rust-relay-fixture.mjs";
const require = createRequire(new URL("../app/package.json", import.meta.url));
const WebSocket = require("ws");
const { enrollRelay } = require("../app/src/core/remote-enrollment.cjs");

const relayResources = [];
async function enrolled(t, relayOptions = {}, monitorCertificate = "server.pem") {
  const relay = await relayFixture(t, { relayOptions });
  relayResources.push(relay.resources);
  const registration = await enrollRelay(relay.origin, relay.admin("enrollment").code);
  const observed = await observedRelay(t, relay, monitorCertificate);
  const identity = await createIdentity();
  return { relay, observed, identity, config: { url: observed.url, identity, ...registration } };
}
async function device(t, fixture, { pin = identityId(fixture.identity) } = {}) {
  const socket = new WebSocket(fixture.relay.origin.replace(/^https:/, "wss:") + "/remote/socket", {
    origin: fixture.relay.origin,
  });
  socket.on("error", () => {});
  t.after(() => socket.terminate());
  const { wire, ready } = createRemoteWire(socket, { room: fixture.config.room });
  await ready;
  const secure = await secureChannel(wire, await createIdentity(), pin, {
    maxMessageBytes: 256 * 1024,
  });
  return { socket, secure, messages: secure.messages() };
}
async function next(messages, timeout = 10000) {
  let timer;
  try {
    const item = await Promise.race([
      messages.next(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("native Relay response deadline")), timeout);
      }),
    ]);
    assert.equal(item.done, false);
    return item.value;
  } finally {
    clearTimeout(timer);
  }
}
async function read(client, id = "read") {
  client.secure.send({ id, method: "read" });
  const result = await next(client.messages);
  assert.equal(result.id, id);
  assert.equal(result.scope, "native-relay-fixture-read");
}

if (!process.env.RC12_TLS_HOME) {
  test("native Rust Relay uses real isolated TLS roots", async () => {
    const home = await certificates("Native Rust Relay isolated CA");
    try {
      const env = {
        ...process.env,
        RC12_TLS_HOME: home,
        NODE_EXTRA_CA_CERTS: join(home, "ca.pem"),
      };
      delete env.NODE_TEST_CONTEXT;
      process.stdout.write(
        execFileSync(process.execPath, ["--test", import.meta.filename], {
          env,
          encoding: "utf8",
          timeout: 180000,
        }),
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
} else {
  after(() => {
    for (const resource of nativeResources) {
      assert.equal(resource.exited, true);
      assert.equal(resource.code, 0);
    }
    for (const resource of observerResources) assert.equal(resource.closed, true);
    for (const resource of relayResources) {
      assert.equal(resource.proxy.closed, true);
      for (const child of resource.cli) {
        assert.equal(child.exited, true);
        assert.equal(child.code, 0);
      }
    }
    console.log(
      JSON.stringify({
        cleanup: "all owned native/Relay processes exited and TLS observers closed",
        nativeResources,
        observerResources,
        relayResources,
      }),
    );
  });
  test("native Relay owns WSS registration and shares Noise/framing with the original JS client", async (t) => {
    const f = await enrolled(t);
    const host = await nativeRelay(t, f.config);
    await host.event((event) => event.event === "ready");
    const client = await device(t, f);
    client.secure.send({ id: "echo", method: "echo", params: { text: "真实原客户端", value: 7 } });
    const response = await next(client.messages);
    assert.deepEqual(response, {
      id: "echo",
      scope: "native-relay-fixture-echo",
      result: { text: "真实原客户端", value: 7 },
    });
    await read(client);
    const channel = await host.event((event) => event.event === "channel");
    assert.ok(f.observed.frames.some((frame) => frame.type === "host"));
    assert.ok(
      f.observed.frames.some((frame) => frame.type === "data" && frame.channel === channel.channel),
    );
    t.diagnostic(
      JSON.stringify({
        scope: "native WSS/Noise echo/read only",
        host: host.resources,
        relay: f.relay.resources,
        observer: f.observed.resources,
      }),
    );
    await host.stop();
    assert.equal(host.resources.code, 0);
  });

  test("native Relay rejects untrusted roots, wrong hostnames and expired certificates", async (t) => {
    for (const [certificate, trusted, pattern] of [
      ["server.pem", false, /UnknownIssuer|root CA|certificate/i],
      ["wrong.pem", true, /NotValidForName|certificate/i],
      ["expired.pem", true, /Expired|certificate/i],
    ]) {
      const f = await enrolled(t, {}, certificate);
      const host = await nativeRelay(t, f.config, { trusted });
      const rejected = await host.event((event) => event.event === "disconnected");
      assert.match(rejected.reason, pattern);
      assert.equal(
        host.events.some((event) => event.event === "ready"),
        false,
      );
      await host.stop();
      assert.equal(host.resources.code, 0);
      t.diagnostic(JSON.stringify({ certificate, trusted, rejected, process: host.resources }));
    }
  });

  test("native Relay paces real rolling windows and serves a second healthy device during a large response", async (t) => {
    const limits = {
      framesPerSecond: 12,
      bytesPerSecond: 65536,
      maxFrameBytes: 16384,
      idleTimeoutMs: 1500,
    };
    const f = await enrolled(t, limits);
    const host = await nativeRelay(t, f.config);
    await host.event((event) => event.event === "ready");
    const slow = await device(t, f),
      healthy = await device(t, f);
    slow.secure.send({ id: "large", method: "large", params: { bytes: 220 * 1024 } });
    const start = Date.now();
    await read(healthy, "healthy-during-large");
    const healthyMs = Date.now() - start;
    assert.ok(healthyMs < 3500, `healthy read delayed ${healthyMs}ms`);
    const response = await next(slow.messages, 30000);
    assert.equal(response.result.length, 220 * 1024);
    await read(healthy, "healthy-after-large");
    const windows = rollingWindows(f.observed.frames);
    assert.ok(windows.maxFrames <= limits.framesPerSecond, JSON.stringify(windows));
    assert.ok(windows.maxBytes <= limits.bytesPerSecond, JSON.stringify(windows));
    assert.ok(
      f.observed.frames.filter((frame) => frame.opcode === 10).length >= 3,
      "real heartbeat pong traffic missing",
    );
    assert.equal(host.events.filter((event) => event.event === "ready").length, 1);
    t.diagnostic(JSON.stringify({ limits, windows, healthyMs, frames: f.observed.frames }));
  });

  test("native Relay flush-close delivers accepted ciphertext before close while abort drops queued writes", async (t) => {
    const f = await enrolled(t, {
      framesPerSecond: 12,
      bytesPerSecond: 65536,
      maxFrameBytes: 16384,
    });
    const host = await nativeRelay(t, f.config);
    await host.event((event) => event.event === "ready");
    const normal = await device(t, f);
    normal.secure.send({ id: "close", method: "close" });
    assert.deepEqual(await next(normal.messages), { id: "close", result: "flushed" });
    await waitFor(() => normal.socket.readyState === 3);
    const slow = await device(t, f),
      healthy = await device(t, f);
    const session = host.events.filter((event) => event.event === "channel").at(-2);
    slow.secure.send({ id: "discard", method: "large", params: { bytes: 220 * 1024 } });
    await host.event(
      (event) =>
        event.event === "queued" && event.channel === session.channel && event.bytes > 200000,
    );
    host.send({ op: "abort", generation: session.generation, channel: session.channel });
    await waitFor(() => slow.socket.readyState === 3);
    const close = f.observed.frames.findIndex(
      (frame) => frame.type === "close" && frame.channel === session.channel,
    );
    assert.ok(close >= 0);
    assert.equal(
      f.observed.frames
        .slice(close + 1)
        .some((frame) => frame.type === "data" && frame.channel === session.channel),
      false,
    );
    assert.ok(
      f.observed.frames
        .filter((frame) => frame.type === "data" && frame.channel === session.channel)
        .reduce((sum, frame) => sum + frame.bytes, 0) < 100000,
    );
    await read(healthy);
    t.diagnostic(JSON.stringify({ aborted: session, close, frames: f.observed.frames }));
  });

  test("native Relay reconnect generations reject old handles and service interruption recovers", async (t) => {
    const f = await enrolled(t);
    const host = await nativeRelay(t, f.config);
    const ready = await host.event((event) => event.event === "ready");
    const old = await device(t, f);
    await read(old);
    const oldChannel = host.events.find((event) => event.event === "channel");
    const start = host.events.length;
    host.send({ op: "reconnect" });
    const replacement = await host.event(
      (event) => event.event === "ready" && event.generation !== ready.generation,
      start,
    );
    await waitFor(() => old.socket.readyState === 3);
    const healthy = await device(t, f);
    host.send({ op: "abort", generation: oldChannel.generation, channel: oldChannel.channel });
    await read(healthy, "old-handle-cannot-abort-new-generation");
    const stoppedAt = host.events.length;
    await f.relay.stop();
    await host.event(
      (event) => event.event === "disconnected" && event.generation === replacement.generation,
      stoppedAt,
    );
    await f.relay.start();
    await host.event(
      (event) => event.event === "ready" && event.generation > replacement.generation,
      stoppedAt,
      10000,
    );
    const recovered = await device(t, f);
    await read(recovered, "after-restart");
    assert.equal(
      f.observed.frames.some(
        (frame) => frame.connection === 1 && frame.at >= replacement.at && frame.type === "data",
      ),
      false,
    );
    t.diagnostic(
      JSON.stringify({
        generations: host.events.filter((event) => ["ready", "disconnected"].includes(event.event)),
        resources: f.relay.resources,
      }),
    );
  });

  test("native Relay replacement is terminal and does not fight the new Host", async (t) => {
    const f = await enrolled(t);
    const old = await nativeRelay(t, f.config);
    await old.event((event) => event.event === "ready");
    const replacement = await nativeRelay(t, f.config);
    await replacement.event((event) => event.event === "ready");
    const replaced = await old.event(
      (event) => event.event === "disconnected" && event.reason === "REPLACED",
    );
    assert.equal(replaced.retry, false);
    const healthy = await device(t, f);
    await read(healthy);
    await old.stop();
    assert.equal(old.events.filter((event) => event.event === "ready").length, 1);
  });
}
