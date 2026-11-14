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

test("deadline bounds a stalled predicate with deterministic time", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const waiting = until(() => ({ status: "completed" }), "projection predicate", {
    timeout: 100,
    accept: () => new Promise(() => {}),
  });
  const rejected = assert.rejects(waiting, /Timeout: projection predicate/);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  t.mock.timers.tick(100);
  await rejected;
});

test("failure observation retains terminal turns and identity without payloads", async () => {
  const { observationSummary } = await import("./desktop-fixture.mjs");
  const result = observationSummary({
    projects: [
      {
        id: "project",
        core: { serviceGeneration: "generation", token: "secret" },
        pending: [{ method: "thread/read", params: { token: "secret" } }],
        state: {
          connected: true,
          threads: {
            original: {
              executionCore: { serviceGeneration: "execution" },
              turns: [{ id: "turn", status: "completed", text: "secret" }],
            },
          },
          queues: { original: { paused: false, items: [{ status: "pending", text: "secret" }] } },
        },
      },
    ],
  });
  assert.deepEqual(result[0].threads, [
    {
      threadId: "original",
      serviceGeneration: "execution",
      turns: [{ id: "turn", status: "completed" }],
    },
  ]);
  assert.deepEqual(result[0].pending, ["thread/read"]);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("failure capture preserves the original error when observation and screenshot fail", async () => {
  const { captureSmokeFailure } = await import("../smoke-navigation.mjs");
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "failure-evidence-"));
  try {
    const page = {
      evaluate: async () => {
        throw Error("disconnected");
      },
      screenshot: async () => {
        throw Error("closed");
      },
    };
    assert.deepEqual(await captureSmokeFailure(page, directory, Error("original assertion")), [
      "failure-state.json",
    ]);
    const result = JSON.parse(await readFile(join(directory, "failure-state.json"), "utf8"));
    assert.match(result.error, /original assertion/);
    assert.equal(result.observationCaptureError, "disconnected");
    assert.equal(result.screenshotError, "closed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failure capture bounds a stalled projection and retains the original failure", async (t) => {
  const { captureSmokeFailure } = await import("../smoke-navigation.mjs");
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "failure-evidence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const page = {
    evaluate: () => (++calls === 1 ? Promise.resolve({}) : new Promise(() => {})),
    screenshot: () => Promise.reject(Error("closed")),
  };
  const capture = captureSmokeFailure(page, directory, Error("original idle timeout"));
  while (calls < 2) await Promise.resolve();
  t.mock.timers.tick(10000);
  await capture;
  const result = JSON.parse(await readFile(join(directory, "failure-state.json"), "utf8"));
  assert.match(result.error, /original idle timeout/);
  assert.match(
    result.observationCaptureError,
    /failure projection capture timed out after 10000ms/,
  );
});
