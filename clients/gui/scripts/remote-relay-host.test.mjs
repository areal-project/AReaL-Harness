import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeHostFixture } from "./remote-native-host-fixture.mjs";

async function host(t) {
  return (await nativeHostFixture(t)).remote;
}

test("Relay enrollment requires explicit local confirmation and exact HTTPS origin", async (t) => {
  const remote = await host(t);
  assert.throws(
    () =>
      remote.control({ operation: "enable", relay: "https://relay.example", code: "x".repeat(43) }),
    /无效手机设置参数/,
  );
  for (const relay of [
    "http://127.0.0.1:3000",
    "wss://relay.example",
    "https://relay.example/",
    "https://relay.example/path",
    "https://user:pass@relay.example",
  ]) {
    await assert.rejects(
      remote.control({ operation: "enable", relay, code: "x".repeat(43), confirmed: true }),
      { code: "invalid-origin" },
    );
  }
  assert.equal(remote.state().enabled, false);
});
