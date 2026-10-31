import assert from "node:assert/strict";
import test from "node:test";
import {
  LocalRelaySocket,
  createMobileSocket,
  isLocalRelayOrigin,
} from "../renderer/src/mobile/local-socket.mjs";
import { DeviceStore, parsePairingLink } from "../renderer/src/mobile/device-store.mjs";
import { createRemoteWire } from "../packages/remote/src/wire.mjs";
import {
  byteChannel,
  createIdentity,
  identityId,
  secureChannel,
} from "../packages/remote/src/channel.mjs";

const host = "A".repeat(40),
  room = "b".repeat(64),
  invite = "c".repeat(64);
const link = (origin, local = true) =>
  `${origin}/#host=${host}&room=${room}&invite=${invite}${local ? "&local=1" : ""}`;
const tick = () => new Promise((resolve) => setImmediate(resolve));
function bridge() {
  let listener;
  const calls = [];
  return {
    calls,
    async addListener(_, fn) {
      listener = fn;
      return {
        remove: async () => {
          listener = null;
        },
      };
    },
    async connect(options) {
      calls.push(["connect", options]);
    },
    async send(options) {
      calls.push(["send", options]);
    },
    async close(options) {
      calls.push(["close", options]);
    },
    emit(socket, type, fields = {}) {
      listener?.({ id: socket.id, type, ...fields });
    },
    listening: () => !!listener,
  };
}

test("local invitation requires explicit mode and private numeric address, HTTPS still works", () => {
  for (const origin of [
    "http://10.2.3.4:7777",
    "http://172.31.0.2:80",
    "http://192.168.1.9:9876",
    "http://[fd12::1]:7777",
  ])
    assert.equal(parsePairingLink(link(origin)).relayOrigin, new URL(origin).origin);
  for (const origin of [
    "http://127.0.0.1:7777",
    "http://localhost:7777",
    "http://8.8.8.8:7777",
    "http://172.32.0.1",
    "http://[::1]",
    "http://[fe80::1]",
    "http://host.internal",
    "http://0x0a000001",
    "http://10.1",
    "http://010.0.0.1",
  ])
    assert.throws(() => parsePairingLink(link(origin)));
  assert.throws(() => parsePairingLink(link("http://10.2.3.4:7777", false)));
  assert.throws(() => parsePairingLink(link("http://user@10.2.3.4:7777")));
  assert.equal(
    parsePairingLink(link("https://relay.example", false)).relayOrigin,
    "https://relay.example",
  );
  assert.throws(() => createMobileSocket("ws://10.2.3.4:7777/remote/socket"), /NATIVE_APP/);
});

test("stored private relay is restored without widening public HTTP trust", async () => {
  for (const origin of ["http://10.2.3.4:7777", "http://[fd12::1]:7777", "https://relay.example"]) {
    let value = null;
    const store = new DeviceStore({
      load: async () => ({ value }),
      save: async (record) => {
        value = record.value;
      },
    });
    store.connection = { relayOrigin: origin, grantRevision: 4 };
    await store.transaction(true, () => ({ record: { identity: "opaque" }, result: null }));
    assert.equal((await store.load()).relayOrigin, origin);
    value = value.replace(origin, "http://8.8.8.8:7777");
    await assert.rejects(store.load(), /INVALID_DEVICE_RECORD/);
  }
  assert.equal(isLocalRelayOrigin("http://10.2.3.4:7777/"), false);
});

test("native adapter keeps text and binary frames ordered and bounds pending bytes", async () => {
  const plugin = bridge();
  const socket = new LocalRelaySocket("ws://10.2.3.4:7777/remote/socket", plugin);
  await socket.start;
  plugin.emit(socket, "open");
  const messages = [];
  socket.addEventListener("message", (event) => messages.push(event.data));
  plugin.emit(socket, "message", { data: btoa("hello"), text: true });
  plugin.emit(socket, "message", { data: btoa("\x00\xff"), text: false });
  assert.equal(messages[0], "hello");
  assert.deepEqual(new Uint8Array(messages[1]), new Uint8Array([0, 255]));
  socket.send(new Uint8Array(512 * 1024));
  await socket.queue;
  assert.equal(plugin.calls.at(-1)[1].data.length, Math.ceil((512 * 1024) / 3) * 4);
  assert.throws(() => socket.send(new Uint8Array(512 * 1024 + 1)), /BUFFER_LIMIT/);
  let release;
  plugin.send = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  socket.send(new Uint8Array(128 * 1024));
  await tick();
  for (let i = 1; i < 16; i++) socket.send(new Uint8Array(128 * 1024));
  assert.equal(socket.bufferedAmount, 2 * 1024 * 1024);
  assert.throws(() => socket.send(new Uint8Array(1)), /BUFFER_LIMIT/);
  let closed = 0;
  socket.onclose = () => closed++;
  socket.close();
  socket.close();
  release();
  await socket.queue;
  assert.equal(closed, 1);
  assert.equal(socket.bufferedAmount, 0);
  assert.equal(plugin.listening(), false);
});

test("close during listener registration cannot open a native connection", async () => {
  const plugin = bridge();
  let release,
    removed = false;
  plugin.addListener = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const socket = new LocalRelaySocket("ws://10.2.3.4:7777/remote/socket", plugin);
  socket.close();
  release({
    remove: async () => {
      removed = true;
    },
  });
  await socket.start;
  assert.equal(removed, true);
  assert.equal(
    plugin.calls.some(([name]) => name === "connect"),
    false,
  );
});

test("bridge failure closes wire once and rejects readiness", async () => {
  const plugin = bridge();
  const socket = new LocalRelaySocket("ws://10.2.3.4:7777/remote/socket", plugin);
  const transport = createRemoteWire(socket, { room });
  const failed = assert.rejects(transport.ready);
  await socket.start;
  plugin.emit(socket, "error");
  await failed;
  assert.equal(socket.readyState, 3);
  assert.equal(plugin.listening(), false);
});

test("native adapter carries real Noise handshake and rejects the wrong pinned Host", async () => {
  for (const mismatch of [false, true]) {
    const plugin = bridge();
    const socket = new LocalRelaySocket("ws://10.2.3.4:7777/remote/socket", plugin);
    const transport = createRemoteWire(socket);
    const server = byteChannel(
      (bytes) =>
        plugin.emit(socket, "message", {
          data: Buffer.from(bytes).toString("base64"),
          text: false,
        }),
      () => socket.close(),
    );
    plugin.send = async ({ data }) => server.receive(new Uint8Array(Buffer.from(data, "base64")));
    await socket.start;
    plugin.emit(socket, "open");
    await transport.ready;
    const hostIdentity = await createIdentity();
    const [outbound, inbound] = await Promise.allSettled([
      secureChannel(
        transport.wire,
        await createIdentity(),
        identityId(mismatch ? await createIdentity() : hostIdentity),
      ),
      secureChannel(server, hostIdentity),
    ]);
    if (mismatch) assert.equal(outbound.status, "rejected");
    else {
      assert.equal(outbound.status, "fulfilled");
      assert.equal(inbound.status, "fulfilled");
      const messages = inbound.value.messages();
      outbound.value.send({ grant: "secret" });
      assert.deepEqual((await messages.next()).value, { grant: "secret" });
      outbound.value.close();
    }
    server.close();
    socket.close();
  }
});
