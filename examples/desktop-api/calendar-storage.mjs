import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { trackedMkdtemp } from "../../clients/gui/scripts/support/host-cleanup.cjs";
import { isAbsolute, join, resolve } from "node:path";
import { spawnNative } from "../../scripts/native-child.mjs";
import { connect } from "./client.mjs";

const oldBinary = process.env.AREAL_COMPAT_OLD_BIN;
const newBinary = process.env.AREAL_CORE_BIN;
assert.ok(
  oldBinary && isAbsolute(oldBinary),
  "AREAL_COMPAT_OLD_BIN must select the qualified v4 Core",
);
assert.ok(newBinary && isAbsolute(newBinary), "AREAL_CORE_BIN must select the qualified new Core");
const scratch = await trackedMkdtemp("/private/tmp/areal-calendar-storage-");
console.log(`Evidence: ${scratch}`);
const state = join(scratch, "state");
await mkdir(state);
await writeFile(join(scratch, "config.toml"), "schema_version=1\n");
const observerPrincipal = {
  id: "calendar-observer",
  token: randomUUID(),
  permissions: ["observe"],
};
await writeFile(
  join(scratch, "observer-auth.json"),
  JSON.stringify({ version: 1, principals: [observerPrincipal] }),
  { mode: 0o600 },
);
await writeFile(
  join(scratch, "auth.json"),
  JSON.stringify({
    version: 1,
    principals: [
      {
        id: "calendar-storage-owner",
        token: randomUUID(),
        permissions: ["observe", "interact", "manage", "tools"],
      },
      observerPrincipal,
    ],
  }),
  { mode: 0o600 },
);
const children = new Set();
const clients = new Set();
const checks = [];
const instances = [];
const logs = new Map();
const processAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};
const binaryHash = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const binaries = {
  old: { path: oldBinary, sha256: await binaryHash(oldBinary) },
  current: { path: newBinary, sha256: await binaryHash(newBinary) },
};
let passed = false;
let failure;
let sequence = 0;

async function taskFiles(directory) {
  const files = {};
  async function visit(path, name) {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = `${name}/${entry.name}`;
      if (entry.isDirectory()) await visit(join(path, entry.name), relative);
      else if (entry.isFile()) files[relative] = await binaryHash(join(path, entry.name));
      else throw Error(`Unexpected Task state entry ${relative}`);
    }
  }
  files["task-mode.json"] = await binaryHash(join(directory, "desktop/task-mode.json"));
  await visit(join(directory, "desktop/task-ledger"), "task-ledger");
  await visit(join(directory, "desktop/task-legacy"), "task-legacy");
  return files;
}
async function start(binary, directory, expectFailure = false) {
  const label = String(++sequence).padStart(2, "0");
  const ready = join(scratch, `${label}-ready.json`);
  const child = spawnNative(
    binary,
    [
      "app-server",
      "--listen",
      "127.0.0.1:0",
      "--data-dir",
      directory,
      "--config",
      join(scratch, "config.toml"),
      "--auth-file",
      join(scratch, "auth.json"),
      "--ready-metadata-file",
      ready,
      "--model",
      "fixture",
      "--model-endpoint",
      "http://127.0.0.1:9",
    ],
    {
      cwd: scratch,
      env: {
        PATH: process.env.PATH,
        HOME: scratch,
        AREAL_HARNESS_HOME: scratch,
        NO_PROXY: "127.0.0.1,localhost",
        OTEL_SDK_DISABLED: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.add(child);
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (value) => {
    stdout += value;
  });
  child.stderr.on("data", (value) => {
    stderr += value;
  });
  logs.set(label, () => ({ stdout, stderr }));
  const identity = { label, binary, wrapperPid: child.pid, corePid: null };
  instances.push(identity);
  const exited = once(child, "exit");
  const deadline = Date.now() + 20000;
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        assert.ok(expectFailure, `Core exited before ready: ${stderr}`);
        assert.notEqual(child.exitCode, 0, "Old reader must explicitly fail");
        assert.equal(child.signalCode, null, "A security kill is not a compatibility refusal");
        assert.match(
          stderr,
          /unsupported task store|missing field|invalid type|unknown field/i,
          "Failure must identify state parsing, not execution environment",
        );
        return { child, exited, refused: true, label };
      }
      let meta;
      try {
        meta = JSON.parse(await readFile(ready, "utf8"));
      } catch {}
      if (meta) {
        assert.equal(
          expectFailure,
          false,
          "Old Core must never become ready against v5 Task state",
        );
        identity.corePid = meta.pid;
        assert.equal(processAlive(meta.pid), true);
        const client = await connect(meta.endpoint, join(scratch, "auth.json"));
        clients.add(client);
        return { child, exited, client, endpoint: meta.endpoint, label };
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw Error(`Core readiness deadline exceeded: ${stderr}`);
  } finally {
    await writeFile(join(scratch, `${label}-stdout.log`), stdout);
    await writeFile(join(scratch, `${label}-stderr.log`), stderr);
  }
}
async function stop(instance) {
  if (instance.client) {
    await instance.client.close();
    clients.delete(instance.client);
  }
  if (instance.child.exitCode === null && instance.child.signalCode === null) {
    instance.child.kill("SIGTERM");
    await Promise.race([
      instance.exited,
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(Error("Owned Core did not stop after SIGTERM")),
          15000,
        );
        timer.unref();
      }),
    ]);
  }
  children.delete(instance.child);
}
try {
  let instance = await start(oldBinary, state);
  const anchor = (
    await instance.client.call("areal/thread/start", { requestId: "legacy-anchor", cwd: scratch })
  ).thread.id;
  const legacyRequest = {
    requestId: "legacy-original-receipt",
    mode: "scheduled",
    objective: "Preserve fixed seconds",
    threadId: anchor,
    schedule: { at: 2208988800, intervalSeconds: 86400, timeZone: "America/New_York" },
  };
  const original = await instance.client.call("areal/task/create", legacyRequest);
  await stop(instance);
  const v4Bytes = await readFile(join(state, "desktop/task-mode.json"));
  assert.equal(JSON.parse(v4Bytes).version, 4, "The old binary must create a real v4 fixture");
  await writeFile(join(scratch, "v4-root.json"), v4Bytes);
  const v4Files = await taskFiles(state);
  await writeFile(join(scratch, "v4-files.json"), JSON.stringify(v4Files, null, 2));
  checks.push("Qualified old binary creates v4 state and a durable legacy receipt");

  instance = await start(newBinary, state);
  const migrated = await instance.client.call("areal/task/read", { taskId: original.id });
  assert.deepEqual(migrated.schedule, original.schedule);
  assert.equal(migrated.nextRunAt, original.nextRunAt);
  assert.equal(migrated.schedule.intervalSeconds, 86400);
  assert.deepEqual(
    await instance.client.call("areal/task/create", legacyRequest),
    original,
    "Original receipt bytes decode identically after migration",
  );
  const v5 = JSON.parse(await readFile(join(state, "desktop/task-mode.json"), "utf8"));
  assert.equal(v5.version, 5, "New binary must install the v5 fence before new rules");
  assert.equal(v5.index_version, 3);
  await writeFile(join(scratch, "v5-root.json"), JSON.stringify(v5, null, 2));
  const legacyDirectory = join(state, "desktop/task-legacy");
  const backups = await readdir(legacyDirectory);
  assert.ok(
    (await Promise.all(backups.map((name) => readFile(join(legacyDirectory, name))))).some(
      (bytes) => bytes.equals(v4Bytes),
    ),
    "Migration retains the exact committed v4 root",
  );
  for (const [name, digest] of Object.entries(v4Files)) {
    if (name.startsWith("task-ledger/"))
      assert.equal(
        await binaryHash(join(state, "desktop", name)),
        digest,
        `Original referenced immutable file remains ${name}`,
      );
  }
  checks.push(
    "v4 migrates behind v5 with exact legacy seconds, cursor, receipt, root backup and immutable references",
  );
  const calendarRequest = {
    requestId: "new-calendar",
    mode: "scheduled",
    objective: "Month end",
    threadId: anchor,
    scheduleV2: {
      version: 1,
      rule: {
        kind: "calendar",
        frequency: "monthly",
        interval: 1,
        timeZone: "Asia/Shanghai",
        localTime: "09:00",
        anchorDate: "2050-01-01",
        monthDays: ["last"],
      },
      misfire: { kind: "skip", maxLatenessSeconds: 300 },
      overlap: "skip",
    },
  };
  const observer = await connect(instance.endpoint, join(scratch, "observer-auth.json"));
  clients.add(observer);
  const capabilities = await observer.call("areal/capabilities", {});
  for (const method of [
    "areal/task/schedule/context",
    "areal/task/schedule/preview",
    "areal/mcp/app/openFromResult",
  ])
    assert.ok(capabilities.methods.includes(method), `Production registry advertises ${method}`);
  const context = await observer.call("areal/task/schedule/context", { timeZone: "Asia/Shanghai" });
  assert.equal(Number.isInteger(context.coreNow), true);
  assert.equal(context.timeZone, "Asia/Shanghai");
  assert.match(context.localDate, /^\d{4}-\d{2}-\d{2}$/);
  const preview = await observer.call("areal/task/schedule/preview", {
    schedule: calendarRequest.scheduleV2,
    from: 2524608000,
    count: 5,
  });
  const literalTimes = [
    "2050-01-31T01:00:00Z",
    "2050-02-28T01:00:00Z",
    "2050-03-31T01:00:00Z",
    "2050-04-30T01:00:00Z",
    "2050-05-31T01:00:00Z",
  ].map((value) => Date.parse(value) / 1000);
  assert.deepEqual(
    preview.occurrences.map((value) => value.at),
    literalTimes,
  );
  assert.deepEqual(preview.schedule, calendarRequest.scheduleV2);
  await assert.rejects(
    observer.call("areal/task/create", { ...legacyRequest, requestId: "observer-denied" }),
    (error) => error.code === -32003,
  );
  await observer.close();
  clients.delete(observer);
  await writeFile(
    join(scratch, "public-route-proof.json"),
    JSON.stringify(
      { methods: capabilities.methods, context, preview, literalTimes, observerCreateDenied: true },
      null,
      2,
    ),
  );
  checks.push(
    "Production registry and schemas expose preview/context to an observe-only principal while rejecting writes",
  );
  const calendar = await instance.client.call("areal/task/create", calendarRequest);
  assert.deepEqual(calendar.scheduleV2, calendarRequest.scheduleV2);
  await stop(instance);
  await writeFile(
    join(scratch, "receipt-proof.json"),
    JSON.stringify({ original, migrated, calendar, legacyRequest, calendarRequest }, null, 2),
  );
  const protectedFiles = await taskFiles(state);
  await writeFile(join(scratch, "v5-files.json"), JSON.stringify(protectedFiles, null, 2));
  const downgradeState = join(scratch, "downgrade-copy");
  await cp(state, downgradeState, { recursive: true });
  const refused = await start(oldBinary, downgradeState, true);
  await stop(refused);
  assert.deepEqual(
    await taskFiles(downgradeState),
    protectedFiles,
    "Refused old reader leaves every committed Task file unchanged",
  );
  checks.push(
    "Qualified v4 binary refuses the v5 state without changing any Task root, leaf or backup",
  );
  instance = await start(newBinary, state);
  assert.deepEqual(await instance.client.call("areal/task/create", legacyRequest), original);
  assert.deepEqual(await instance.client.call("areal/task/create", calendarRequest), calendar);
  await stop(instance);
  checks.push("Both original request receipts survive a subsequent current-binary restart");
  passed = true;
} catch (error) {
  failure = error;
} finally {
  const cleanupErrors = [];
  for (const client of clients)
    await client.close().catch((error) => cleanupErrors.push(error.message));
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 15000))]);
      if (child.exitCode === null && child.signalCode === null) {
        cleanupErrors.push("Owned Core required forced cleanup");
        child.kill("SIGKILL");
        await exited;
      }
    }
  }
  for (const [key, value] of Object.entries(binaries))
    assert.equal(
      await binaryHash(value.path),
      value.sha256,
      `${key} binary changed during acceptance`,
    );
  for (const instance of instances) {
    instance.wrapperStopped = !processAlive(instance.wrapperPid);
    instance.coreStopped = instance.corePid === null ? null : !processAlive(instance.corePid);
    if (!instance.wrapperStopped || instance.coreStopped === false)
      cleanupErrors.push(`Owned process remained alive for ${instance.label}`);
  }
  for (const [label, read] of logs) {
    const value = read();
    await writeFile(join(scratch, `${label}-stdout.log`), value.stdout);
    await writeFile(join(scratch, `${label}-stderr.log`), value.stderr);
  }
  const manifest = {
    passed: passed && cleanupErrors.length === 0,
    checks,
    instances,
    failure: failure?.stack,
    cleanupErrors,
    binaries,
    sourceRoot: resolve("."),
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    scriptSha256: await binaryHash(new URL(import.meta.url)),
    state,
    boundaries: "Real Core public WS, deterministic storage only, no Host/model execution or GUI",
  };
  await writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2));
  await writeFile(
    join(scratch, "cleanup.json"),
    JSON.stringify(
      {
        ownedChildrenStopped: [...children].every(
          (child) => child.exitCode !== null || child.signalCode !== null,
        ),
        errors: cleanupErrors,
      },
      null,
      2,
    ),
  );
  if (manifest.passed) await rm(state, { recursive: true });
  if (!manifest.passed && !failure) failure = Error("Cleanup failed");
}
if (failure) throw failure;
console.log(JSON.stringify({ passed, checks, evidence: scratch }, null, 2));
