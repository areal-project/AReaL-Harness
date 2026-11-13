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

test("until bounds a stalled read and safely observes a late rejection", async () => {
  let rejectRead;
  const read = new Promise((_resolve, reject) => {
    rejectRead = reject;
  });
  let guard;
  try {
    await assert.rejects(
      Promise.race([
        until(() => read, "stalled read", { timeout: 20 }),
        new Promise((_, reject) => {
          guard = setTimeout(() => reject(new Error("deadline did not fire")), 500);
        }),
      ]),
      /Timeout: stalled read/,
    );
    rejectRead(new Error("late read failure"));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    clearTimeout(guard);
  }
});

test("until clears its deadline timer when an observation succeeds", async () => {
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const timers = new Set();
  globalThis.setTimeout = (...args) => {
    const timer = originalSet(...args);
    timers.add(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    timers.delete(timer);
    return originalClear(timer);
  };
  try {
    assert.equal(await until(async () => "ready", "ready", { timeout: 1000 }), "ready");
    assert.equal(timers.size, 0);
  } finally {
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
    for (const timer of timers) originalClear(timer);
  }
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
