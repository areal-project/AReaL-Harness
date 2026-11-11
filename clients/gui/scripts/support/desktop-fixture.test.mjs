import assert from "node:assert/strict";
import test from "node:test";
import { desktopBridge, until } from "./desktop-fixture.mjs";

test("until returns the first accepted observation and reports the last one on timeout", async () => {
  let reads = 0;
  assert.equal(await until(async () => ++reads >= 3 && reads, "third read", { interval: 1 }), 3);
  await assert.rejects(
    until(async () => ({ state: "pending" }), "never", {
      timeout: 5,
      interval: 1,
      accept: (value) => value.state === "done",
    }),
    /Timeout: never\. Last observation \{"state":"pending"\}/,
  );
  await assert.rejects(
    until(async () => true, "aborted", {
      abort: () => {
        throw new Error("model failed");
      },
    }),
    /model failed/,
  );
});

test("desktop bridge follows the current page and rejects failed commands", async () => {
  const replies = { ok: { ok: true, value: 7 }, bad: { ok: false, error: { message: "no" } } };
  let page = {
    evaluate: async (_fn, args) => (args ? replies[args.name] : { connection: { state: "ready" } }),
  };
  const bridge = desktopBridge(() => page);
  assert.equal(await bridge.call("ok"), 7);
  await assert.rejects(bridge.call("bad"), /"ok":false/);
  page = { evaluate: async () => ({ connection: { state: "restarted" } }) };
  assert.deepEqual(await bridge.untilState((s) => s.connection.state === "restarted", "new page"), {
    connection: { state: "restarted" },
  });
});
