import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(new URL("../renderer/package.json", import.meta.url));
const ts = require("typescript");
const source = await readFile(
  new URL("../renderer/src/lib/trajectory-polling.ts", import.meta.url),
  "utf8",
);
// 直接执行产品调度器，测试仅替换时钟与 IPC，不复制轮询实现。
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { createTrajectoryPoller } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fixture() {
  let now = 0,
    sequence = 0,
    active = 0,
    peak = 0;
  const timers = new Map(),
    requests = [];
  const clock = {
    now: () => now,
    setTimeout: (callback, delay) => {
      const id = ++sequence;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  const advance = async (milliseconds) => {
    const target = now + milliseconds;
    await flush();
    for (let steps = 0; ; steps++) {
      assert.ok(steps < 1000, "timer scheduling must not spin");
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
      await flush();
    }
    now = target;
    await flush();
  };
  const poller = createTrajectoryPoller((operation) => {
    active++;
    peak = Math.max(peak, active);
    return new Promise((resolve, reject) => {
      requests.push({
        operation,
        at: now,
        resolve: (value) => {
          active--;
          resolve(value);
        },
        reject: (error) => {
          active--;
          reject(error);
        },
      });
    });
  }, clock);
  const watch = (intervalMs) => {
    const results = [],
      errors = [],
      busy = [];
    return {
      results,
      errors,
      busy,
      control: poller.watch({
        intervalMs,
        onResult: (value, operation) => results.push({ value, operation }),
        onError: (error, operation) => errors.push({ error, operation }),
        onBusy: (operation) => busy.push(operation),
      }),
    };
  };
  return { poller, requests, timers, advance, watch, peak: () => peak, active: () => active };
}

test("slow requests remain serial and the next interval starts only after completion", async () => {
  const f = fixture(),
    page = f.watch(2500);
  await f.advance(0);
  assert.equal(f.requests.length, 1);
  await f.advance(31000);
  assert.equal(f.requests.length, 1);
  assert.equal(f.active(), 1);
  f.requests[0].resolve("first");
  await flush();
  assert.deepEqual(page.results, [{ value: "first", operation: "status" }]);
  await f.advance(2499);
  assert.equal(f.requests.length, 1);
  await f.advance(1);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].at, 33500);
  assert.equal(f.peak(), 1);
  page.control.stop();
  f.requests[1].resolve("late");
  await f.advance(60000);
  assert.equal(page.results.length, 1);
  assert.equal(f.requests.length, 2);
  assert.equal(f.timers.size, 0);
});

test("foreground and background observers share requests but new observers reject older responses", async () => {
  const f = fixture(),
    app = f.watch(15000);
  await f.advance(0);
  const page = f.watch(2500);
  await f.advance(31000);
  assert.equal(f.requests.length, 1);
  f.requests[0].resolve("before-page");
  await f.advance(0);
  assert.deepEqual(app.results, [{ value: "before-page", operation: "status" }]);
  assert.deepEqual(page.results, []);
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve("both");
  await flush();
  assert.equal(app.results.at(-1).value, "both");
  assert.equal(page.results.at(-1).value, "both");
  await f.advance(2500);
  assert.equal(f.requests.length, 3);
  f.requests[2].resolve("last-page");
  await flush();
  page.control.stop();
  await f.advance(14999);
  assert.equal(f.requests.length, 3);
  await f.advance(1);
  assert.equal(f.requests.length, 4);
  assert.equal(f.peak(), 1);
  app.control.stop();
  f.requests[3].resolve("stopped");
  await flush();
  assert.equal(app.results.at(-1).value, "last-page");
});

test("manual refresh and retry cannot overlap automatic requests", async () => {
  const f = fixture(),
    page = f.watch(2500);
  await f.advance(0);
  assert.equal(page.control.refresh(), false);
  assert.equal(page.control.refresh("retry"), false);
  f.requests[0].resolve("ready");
  await flush();
  assert.equal(page.control.refresh("retry"), true);
  await f.advance(0);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].operation, "retry");
  assert.equal(page.control.refresh("retry"), false);
  await f.advance(31000);
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve("scheduled");
  await flush();
  assert.deepEqual(page.results.at(-1), { value: "scheduled", operation: "retry" });
  assert.equal(page.busy.at(-1), null);
  assert.ok(page.busy.includes("retry"));
  assert.equal(f.peak(), 1);
  page.control.stop();
  assert.equal(page.control.refresh(), false);
});

test("stopping and reconnecting discard old errors before issuing a fresh serialized read", async () => {
  const f = fixture(),
    previous = f.watch(2500);
  await f.advance(0);
  previous.control.stop();
  await f.advance(31000);
  assert.equal(f.requests.length, 1);
  const current = f.watch(2500);
  await f.advance(31000);
  assert.equal(f.requests.length, 1);
  f.requests[0].reject(new Error("old connection"));
  await f.advance(0);
  assert.deepEqual(previous.errors, []);
  assert.deepEqual(current.errors, []);
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve("fresh");
  await flush();
  assert.deepEqual(current.results, [{ value: "fresh", operation: "status" }]);
  assert.equal(f.peak(), 1);
  current.control.stop();
});

test("read errors settle busy state and later polls can recover", async () => {
  const f = fixture(),
    app = f.watch(15000),
    page = f.watch(2500);
  await f.advance(0);
  const failure = new Error("status unavailable");
  f.requests[0].reject(failure);
  await flush();
  assert.deepEqual(app.errors, [{ error: failure, operation: "status" }]);
  assert.deepEqual(page.errors, [{ error: failure, operation: "status" }]);
  assert.equal(app.busy.at(-1), null);
  assert.equal(page.busy.at(-1), null);
  await f.advance(2500);
  f.requests[1].resolve("recovered");
  await flush();
  assert.deepEqual(app.results, [{ value: "recovered", operation: "status" }]);
  assert.deepEqual(page.results, [{ value: "recovered", operation: "status" }]);
  app.control.stop();
  page.control.stop();
  assert.equal(f.timers.size, 0);
});
