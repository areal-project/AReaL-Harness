import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  mkdir,
  rename,
  cp,
  lstat,
  realpath,
} from "node:fs/promises";
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
  for (const status of ["completed", "failed", "steered", "cancelled", "removed"])
    assert.doesNotThrow(() => assertIdle(record(status)));
  for (const status of ["pending", "running", "unknown"])
    assert.throws(() => assertIdle(record(status)), /History contains queued work/);
});

test("history preflight preserves inactive goals but refuses active or settling goals", () => {
  const record = (goal) => ({ thread: { status: { type: "idle" }, turns: [], goals: { goal } } });
  for (const status of ["blocked", "paused", "completed", "failed", "budgetLimited"])
    assert.doesNotThrow(() => assertIdle(record({ status, activeTurnId: null, settling: false })));
  for (const goal of [
    { status: "active", activeTurnId: null, settling: false },
    { status: "blocked", activeTurnId: "running-turn", settling: false },
    { status: "paused", activeTurnId: null, settling: true },
    { status: "unknown", activeTurnId: null, settling: false },
  ])
    assert.throws(() => assertIdle(record(goal)), /History contains an unfinished goal/);
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
  {
    blocked = false,
    businessFailure,
    inventoryFailure,
    hostStop = "completed",
    hostStopError,
  } = {},
) {
  const child = spawn(
    process.execPath,
    ["-e", "process.on('message', () => process.exit(0)); process.send('ready')"],
    {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  await once(child, "spawn");
  await once(child, "message");
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
    assert,
    app: {
      process: () => child,
      evaluate: async () => {},
      close: async () => {
        if (blocked) return new Promise(() => {});
        const exited = once(child, "exit");
        child.send("quit");
        await exited;
      },
    },
    readFile,
    randomUUID,
    historyOwner: {
      client: {
        generation: "original-generation",
        stop: async (_requestId, generation, strategy) => {
          assert.equal(generation, "original-generation");
          assert.equal(strategy, "ifIdle");
          if (hostStopError) throw Error(hostStopError);
          return { state: hostStop };
        },
      },
      close() {},
    },
    hostPid: undefined,
    cleanupSyntheticHostKeychain: async () => [],
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
  assert.equal(child.exitCode, 0);
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

test("history retains pending Host stop and original business failure", async (t) => {
  const { report, child, inventoryCalls } = await finish(t, {
    hostStop: "acceptedPending",
    businessFailure: { message: "history load failed" },
  });
  assert.equal(child.exitCode, 0);
  assert.equal(inventoryCalls, 1);
  assert.equal(report.passed, false);
  assert.equal(report.failure.message, "history load failed");
  assert.equal(report.cleanup.hostStop.state, "acceptedPending");
  assert.match(report.cleanup.errors[0], /Host stop: isolated Host stop is not settled/);
});

test("history keeps Electron, Host and inventory failures independently", async (t) => {
  const { report, child } = await finish(t, {
    blocked: true,
    hostStopError: "original Host disconnected",
    inventoryFailure: "Core is still alive",
  });
  assert.equal(child.signalCode, "SIGKILL");
  assert.equal(report.passed, false);
  assert.equal(report.cleanup.errors.length, 3);
  assert.match(report.cleanup.errors[0], /Electron cleanup timed out/);
  assert.match(report.cleanup.errors[1], /Host stop: original Host disconnected/);
  assert.match(report.cleanup.errors[2], /Core is still alive/);
});

const prepareHistorySource = new Function(
  "assert",
  "rename",
  "mkdir",
  "writeFile",
  "join",
  "randomUUID",
  "lstat",
  "cp",
  source.slice(
    source.indexOf("async function prepareHistorySource("),
    source.indexOf("async function call("),
  ) + "return prepareHistorySource;",
)(assert, rename, mkdir, writeFile, join, randomUUID, lstat, cp);

// 原迁移拒绝非空且无清理凭据的 Store；新夹具必须用全新 Host 登记来承载副本。
test(
  "history copy publishes a fresh Host source before installing idle bytes",
  {
    skip: !process.env.AREAL_CORE_BIN && "requires built AREAL_CORE_BIN",
  },
  async (t) => {
    const require = createRequire(new URL("../app/package.json", import.meta.url));
    const {
      GuiHostProjects,
    } = require("@areal/workbench-service/desktop/core/gui-host-projects.cjs");
    const root = await realpath(await mkdtemp(join(tmpdir(), "areal-history-source-test-")));
    const coreHome = join(root, "core");
    const project = { id: "a".repeat(24), root: join(root, "workspace") };
    await mkdir(project.root);
    await mkdir(join(coreHome, project.id, "state"), { recursive: true });
    const history = Buffer.from('{"fixture":"immutable idle history"}');
    const path = join(project.id, "state", randomUUID() + ".json");
    await writeFile(join(coreHome, path), history);
    await writeFile(join(coreHome, "projects.json"), JSON.stringify([project]));
    const owner = new GuiHostProjects({
      binary: process.env.AREAL_CORE_BIN,
      home: join(root, "host"),
      source: { profile: join(root, "profile"), coreHome, legacyServiceHome: join(root, "host") },
      singletonHeld: true,
    });
    t.after(async () => {
      try {
        if (owner.client.generation) {
          const receipt = await owner.client.stop(randomUUID(), owner.client.generation, "ifIdle");
          assert.equal(receipt.state, "completed");
        }
      } finally {
        owner.close();
      }
    });
    await prepareHistorySource(owner, [project]);
    assert.ok(owner.sourceId);
    assert.deepEqual(await readFile(join(coreHome, path)), history);
    assert.deepEqual(await readFile(join(coreHome + "-history-staging", path)), history);
    const binding = owner.resolve(project.id);
    assert.equal(binding.workspace, project.root);
    await assert.rejects(lstat(join(binding.dataDir, "service.lock")), { code: "ENOENT" });
    const observer = new GuiHostProjects({ ...owner.options, singletonHeld: false });
    try {
      await observer.init();
      assert.equal(observer.sourceId, owner.sourceId);
      assert.equal(observer.resolve(project.id).projectId, binding.projectId);
    } finally {
      observer.close();
    }
  },
);
