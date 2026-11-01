import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertApplicationStopped, closeSmokeApplication } from "./application-cleanup.mjs";
import { withSmokeDeadline } from "./smoke-deadline.mjs";

// 直接运行 runner 的收尾代码，外部应用边界用本测试持有的真实子进程替代。
const source = await readFile(new URL("./history-copy-smoke.mjs", import.meta.url), "utf8");
const body = source.slice(
  source.indexOf("} finally {") + "} finally {".length,
  source.lastIndexOf("}"),
);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const assertIdle = new Function(
  "assert",
  source.slice(
    source.indexOf("function assertIdle("),
    source.indexOf("async function unchanged("),
  ) + "return assertIdle;",
)(assert);

test("history preflight accepts retained closed processes with confirmed cleanup", () => {
  assert.doesNotThrow(() =>
    assertIdle({
      thread: {
        status: { type: "idle" },
        turns: [],
        desktop: { processes: [{ state: "closed", cleanupConfirmed: true }] },
      },
    }),
  );
});

test("history preflight accepts settled queue history and rejects executable or unknown entries", () => {
  const record = (status) => ({
    thread: { status: { type: "idle" }, turns: [], desktop: { queue: { items: [{ status }] } } },
  });
  for (const status of ["completed", "failed", "steered", "cancelled"])
    assert.doesNotThrow(() => assertIdle(record(status)));
  for (const status of ["pending", "running", "unknown"])
    assert.throws(() => assertIdle(record(status)), /History contains queued work/);
});

test("history preflight rejects active, unknown, or unconfirmed process cleanup", () => {
  for (const process of [
    { state: "running", cleanupConfirmed: false },
    { state: "unknown", cleanupConfirmed: false },
    { state: "running", cleanupConfirmed: true },
    { state: "unknown", cleanupConfirmed: true },
    { state: "closed", cleanupConfirmed: false },
    { state: "closed" },
  ]) {
    assert.throws(
      () =>
        assertIdle({
          thread: { status: { type: "idle" }, turns: [], desktop: { processes: [process] } },
        }),
      /History contains managed execution state/,
    );
  }
});

async function finish(
  t,
  { blocked = false, businessFailure, inventoryFailure, metadata = "valid", metadataError } = {},
) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await once(child, "spawn");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  });
  const root = await mkdtemp(join(tmpdir(), "areal-history-cleanup-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "inventory");
  await writeFile(binary, `#!${process.execPath}\nconsole.log("[]");\n`, { mode: 0o700 });
  await chmod(binary, 0o700);
  let report;
  let inventoryCalls = 0;
  const deadlines = [];
  const context = {
    app: {
      process: () => child,
      evaluate: async () => {},
      close: async () => {
        if (blocked) return new Promise(() => {});
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      },
    },
    readFile: async (path, ...args) => {
      if (path.endsWith("service.json")) {
        if (metadataError) throw metadataError;
        if (metadata === "missing") throw Object.assign(Error("absent"), { code: "ENOENT" });
        return JSON.stringify(metadata === "valid" ? { pid: child.pid } : metadata);
      }
      return readFile(path, ...args);
    },
    join,
    scratch: "/isolated-history-test",
    env: process.env,
    binary,
    failure: businessFailure,
    closeSmokeApplication: (app, timeout) => {
      deadlines.push(timeout);
      return closeSmokeApplication(app, 50);
    },
    withSmokeDeadline: (label, operation, timeout) => {
      deadlines.push(timeout);
      return withSmokeDeadline(label, operation, 50);
    },
    assertApplicationStopped: async (_binary, _env, metadata) => {
      inventoryCalls++;
      if (inventoryFailure) throw Error(inventoryFailure);
      await assertApplicationStopped(_binary, _env, metadata);
    },
    server: { close: (callback) => callback() },
    stateDirectories: new Map(),
    source: "synthetic-fixture",
    unchanged: async () => true,
    projectIndexHash: undefined,
    sourceUnchanged: false,
    modelRequests: 0,
    fixtureMode: true,
    executablePath: undefined,
    hash: () => "test-binary-hash",
    checks: [],
    sessions: new Map(),
    copyUnchangedWhileOpen: true,
    writeFile: async (_path, bytes) => {
      report = JSON.parse(bytes);
    },
    console: { log() {} },
    process: {},
  };
  await new AsyncFunction(...Object.keys(context), body)(...Object.values(context));
  return { report, child, inventoryCalls, deadlines, exitCode: context.process.exitCode };
}

test("history failure cleanup kills only its owned child and preserves both errors", async (t) => {
  const { report, child, inventoryCalls, deadlines } = await finish(t, {
    blocked: true,
    businessFailure: { message: "stored agent parent is missing" },
  });
  assert.equal(child.signalCode, "SIGKILL");
  assert.equal(inventoryCalls, 1);
  assert.deepEqual(deadlines, [120000]);
  assert.equal(report.passed, false);
  assert.equal(report.failure.message, "stored agent parent is missing");
  assert.match(report.cleanup.errors[0], /Electron cleanup timed out/);
  assert.equal(report.cleanup.applicationStopped, true);
  assert.doesNotMatch(report.cleanupNote, /confirmed.*stopped/i);
});

test("history inventory failure is independently recorded after a successful child close", async (t) => {
  const { report, child, inventoryCalls } = await finish(t, {
    inventoryFailure: "Core is still alive",
  });
  assert.equal(child.signalCode, "SIGTERM");
  assert.equal(inventoryCalls, 1);
  assert.equal(report.passed, false);
  assert.equal(report.cleanup.applicationStopped, false);
  assert.match(report.cleanup.errors[0], /Core is still alive/);
  assert.doesNotMatch(report.cleanupNote, /confirmed.*stopped/i);
});

test("history successful cleanup requires independent service inventory evidence", async (t) => {
  const { report, inventoryCalls } = await finish(t);
  assert.equal(inventoryCalls, 1);
  assert.equal(report.passed, true);
  assert.deepEqual(report.cleanup.errors, []);
  assert.equal(report.cleanup.applicationStopped, true);
  assert.match(report.cleanupNote, /confirmed.*stopped/i);
});

test("history close and inventory errors both fail an otherwise successful run", async (t) => {
  const { report, inventoryCalls, exitCode } = await finish(t, {
    blocked: true,
    inventoryFailure: "Core is still alive",
  });
  assert.equal(inventoryCalls, 1);
  assert.equal(report.passed, false);
  assert.equal(exitCode, 1);
  assert.equal(report.failure, undefined);
  assert.equal(report.cleanup.errors.length, 2);
  assert.match(report.cleanup.errors[0], /Electron cleanup timed out/);
  assert.match(report.cleanup.errors[1], /Core is still alive/);
});

for (const metadata of ["missing", {}, { pid: "unverifiable" }, { pid: 1 }]) {
  test(`history does not confirm shutdown without valid Desktop metadata: ${JSON.stringify(metadata)}`, async (t) => {
    const { report, child, inventoryCalls, exitCode } = await finish(t, { metadata });
    assert.equal(child.signalCode, "SIGTERM");
    assert.equal(inventoryCalls, 1);
    assert.equal(report.passed, false);
    assert.equal(exitCode, 1);
    assert.equal(report.cleanup.applicationStopped, false);
    assert.match(report.cleanup.errors[0], /service metadata.*Desktop.*PID/i);
    assert.doesNotMatch(report.cleanupNote, /confirmed.*stopped/i);
  });
}

test("history metadata read failure still closes its child and checks inventory", async (t) => {
  const { report, child, inventoryCalls } = await finish(t, {
    metadataError: Object.assign(Error("permission denied"), { code: "EACCES" }),
  });
  assert.equal(child.signalCode, "SIGTERM");
  assert.equal(inventoryCalls, 1);
  assert.equal(report.passed, false);
  assert.equal(report.cleanup.applicationStopped, false);
  assert.match(report.cleanup.errors[0], /service metadata: permission denied/);
});

test("history retains business failure and every independent cleanup failure", async (t) => {
  const { report, child, inventoryCalls } = await finish(t, {
    metadataError: Object.assign(Error("permission denied"), { code: "EACCES" }),
    blocked: true,
    businessFailure: { message: "stored agent parent is missing" },
    inventoryFailure: "Core is still alive",
  });
  assert.equal(child.signalCode, "SIGKILL");
  assert.equal(inventoryCalls, 1);
  assert.equal(report.passed, false);
  assert.equal(report.failure.message, "stored agent parent is missing");
  assert.equal(report.cleanup.applicationStopped, false);
  assert.equal(report.cleanup.errors.length, 3);
  assert.match(report.cleanup.errors[0], /service metadata: permission denied/);
  assert.match(report.cleanup.errors[1], /Electron cleanup timed out/);
  assert.match(report.cleanup.errors[2], /Core is still alive/);
});
