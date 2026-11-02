import assert from "node:assert/strict";
import { test } from "node:test";
import {
  byteChannel,
  createIdentity,
  identityId,
  secureChannel,
} from "../packages/remote/src/channel.mjs";
import {
  decodeRelayMessage,
  decodeRelayData,
  encodeRelayData,
} from "../packages/remote/src/relay-codec.mjs";
import { fixtureCall, rustWireFixture } from "./remote-rust-wire-fixture.mjs";

const identity =
  "CAESQBPbDgaE5lv/gqyv4asbL64lRUmBU9DHlIHKMIx6hCRk0hf/zGyqVa15cPAWASCqiyTwkvIcLwn8n7ipLs5dEIs=";
const channel = "11111111-1111-4111-8111-111111111111";

test("Rust imports the existing Ed25519 protobuf without replacing its peer identity", () => {
  assert.equal(fixtureCall({ op: "identity", identity }).peer, identityId(identity));
  for (const invalid of ["", "bad", Buffer.from([8, 0, 18, 1, 0]).toString("base64")])
    assert.throws(() => fixtureCall({ op: "identity", identity: invalid }));
});

test("Rust Relay codec matches original JS acceptance, canonical data and envelope bytes", () => {
  const limits = {
    framesPerSecond: 12,
    bytesPerSecond: 524288,
    maxFrameBytes: 131072,
    heartbeatIntervalMs: 15000,
  };
  const corpus = [
    { type: "ready", channel },
    { type: "ready", limits },
    { type: "ready", limits: { ...limits, heartbeatIntervalMs: 0.5 }, push: true },
    { type: "open", channel },
    { type: "close", channel },
    { type: "data", channel, data: "Zg==" },
    { type: "data", channel, data: "Zh==" },
    { type: "data", channel: "foreign", data: "Zg==" },
    { type: "data", channel, data: "Zg==", room: "a".repeat(64) },
    { type: "pushResult", token: "A".repeat(64), status: "unregistered" },
    ...[
      "UNAVAILABLE",
      "REPLACED",
      "CAPACITY_EXCEEDED",
      "LIMIT_EXCEEDED",
      "INVALID_FRAME",
      "TIMEOUT",
      "UNKNOWN",
    ].map((code) => ({ type: "error", code })),
    { type: "ready" },
    { type: "ready", limits: {} },
    { type: "ready", channel, limits },
    ...[
      { framesPerSecond: 81 },
      { framesPerSecond: 0 },
      { framesPerSecond: 1.5 },
      { bytesPerSecond: 0 },
      { maxFrameBytes: 524289 },
      { heartbeatIntervalMs: 0 },
      { heartbeatIntervalMs: "15000" },
      { unknown: 1 },
    ].map((change) => ({ type: "ready", limits: { ...limits, ...change } })),
  ];
  for (const message of corpus) {
    const text = JSON.stringify(message);
    let expected;
    try {
      expected = decodeRelayMessage(text);
    } catch {
      assert.throws(() => fixtureCall({ op: "codec", method: "decodeMessage", text }));
      continue;
    }
    assert.deepEqual(fixtureCall({ op: "codec", method: "decodeMessage", text }), expected);
  }
  for (const data of ["Zg==", "Zh==", "Zg", " Zg==", "AA==", "", "YWJjZA=="]) {
    let expected;
    try {
      expected = Buffer.from(decodeRelayData(data)).toString("base64");
    } catch {
      assert.throws(() => fixtureCall({ op: "codec", method: "decodeData", data }));
      continue;
    }
    assert.equal(fixtureCall({ op: "codec", method: "decodeData", data }), expected);
  }
  for (const length of [1, 8193, 49152]) {
    const bytes = Buffer.alloc(length, 173);
    assert.equal(
      fixtureCall({ op: "codec", method: "encodeData", channel, data: bytes.toString("base64") }),
      encodeRelayData(channel, bytes),
    );
  }
  assert.throws(() =>
    fixtureCall({
      op: "codec",
      method: "decodeMessage",
      text: JSON.stringify(corpus[0]),
      binary: true,
    }),
  );
});

async function pair(
  t,
  { rustInitiator = false, fragment = false, wrongPin = false, corrupt = false, corruption } = {},
) {
  const rust = rustWireFixture();
  const jsIdentity = await createIdentity();
  let rustWire, jsWire;
  let damaged = false;
  const forward = (target, bytes) => {
    if ((corrupt || corruption?.damage) && !damaged && bytes.length > 100) {
      bytes = Uint8Array.from(bytes);
      bytes[bytes.length - 1] ^= 1;
      damaged = true;
    }
    if (fragment) {
      for (const byte of bytes) target.receive(Uint8Array.of(byte));
    } else target.receive(bytes);
  };
  rustWire = byteChannel(
    (bytes) => forward(jsWire, bytes),
    () => jsWire.close(),
  );
  jsWire = byteChannel(
    (bytes) => forward(rustWire, bytes),
    () => rustWire.close(),
  );
  t.after(async () => {
    rust.close();
    jsWire.close();
    await rust.drained();
    t.diagnostic(JSON.stringify({ fixtureExits: rust.exits }));
    assert.ok(
      rust.exits.every(
        (exit) =>
          exit.code === 0 ||
          exit.signal === "SIGTERM" ||
          ((corrupt || corruption?.damage) && exit.code === 1),
      ),
    );
  });
  const expected = wrongPin
    ? identityId(await createIdentity())
    : identityId(rustInitiator ? jsIdentity : identity);
  return Promise.all([
    rust.secureChannel(rustWire, identity, rustInitiator ? expected : undefined),
    secureChannel(jsWire, jsIdentity, rustInitiator ? undefined : expected, {
      maxMessageBytes: 256 * 1024,
      maxBufferedBytes: 1024 * 1024,
    }),
  ]);
}

for (const rustInitiator of [false, true])
  test(
    `Rust ${rustInitiator ? "initiator" : "responder"} exchanges pinned JSON with the unchanged JS Noise implementation`,
    { timeout: 20000 },
    async (t) => {
      const [rust, js] = await pair(t, { rustInitiator });
      const readRust = rust.messages(),
        readJs = js.messages();
      const values = [
        { text: "你好 🥔", nested: [1, null, true], loneSurrogate: "\ud800" },
        { payload: "x".repeat(240 * 1024) },
        { final: true },
      ];
      for (const value of values) js.send(value);
      for (const value of values) assert.deepEqual((await readRust.next()).value, value);
      for (const value of values) rust.send(value);
      for (const value of values) assert.deepEqual((await readJs.next()).value, value);
      rust.close();
      await rust.done;
    },
  );

test("Rust Noise accepts single-byte transport fragments", { timeout: 20000 }, async (t) => {
  const [rust, js] = await pair(t, { fragment: true });
  js.send({ split: "length headers and encrypted bytes" });
  assert.deepEqual((await rust.messages().next()).value, {
    split: "length headers and encrypted bytes",
  });
});

test("existing JS Host pin rejects a different Rust identity", { timeout: 20000 }, async (t) => {
  await assert.rejects(pair(t, { wrongPin: true }));
});

test("damaged Noise identity payload is rejected", { timeout: 20000 }, async (t) => {
  await assert.rejects(pair(t, { corrupt: true }));
});

test("Rust rejects modified ciphertext after authentication", { timeout: 20000 }, async (t) => {
  const corruption = { damage: false };
  const [rust, js] = await pair(t, { corruption });
  corruption.damage = true;
  js.send({ payload: "x".repeat(200) });
  await assert.rejects(rust.messages().next());
});
