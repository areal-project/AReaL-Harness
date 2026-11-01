import { attachRemoteHostFixture } from "./remote-host-fixture.cjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteControl } from "../app/src/core/remote.cjs";

async function host(t) {
  const home = await mkdtemp(join(tmpdir(), "rc12-host-"));
  const remote = new RemoteControl({
    schedule() {},
    backend: {
      home,
      saved: [],
      async save(name, value) {
        await writeFile(join(home, name), JSON.stringify(value));
      },
    },
  });
  attachRemoteHostFixture(remote, {
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString(),
  });
  t.after(async () => {
    remote.close();
    await rm(home, { recursive: true, force: true });
  });
  await remote.init();
  return remote;
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
