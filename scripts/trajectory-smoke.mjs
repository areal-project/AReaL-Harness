// 验证真实 Core 返回、独立补传、快速重启与并发重试；全程只使用本地 fixture。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { spawnNative } from "./native-child.mjs";

const directory = await realpath(await mkdtemp(join(tmpdir(), "areal-trajectory-smoke-")));
const binary = await realpath(resolve("target/debug/areal"));
const execute = promisify(execFile);
const configPath = join(directory, "config.toml");
const spool = join(directory, "spool");
const version = (await readFile("Cargo.toml", "utf8")).match(/^version = "([^"]+)"/m)[1];
const children = new Set();
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("AREAL_") && !key.startsWith("OTEL_"),
    ),
  ),
  HOME: join(directory, "user"),
  AREAL_HARNESS_HOME: join(directory, "home"),
  AREAL_CORE_USER_HOME: join(directory, "user"),
  NO_PROXY: "127.0.0.1,localhost,::1",
  no_proxy: "127.0.0.1,localhost,::1",
  RUST_LOG: "warn",
};
let rejected = 0;
const accepted = [];
const report = { passed: false, directory, scenarios: [], receivers: [] };
function collectorPhase(name, status, delayMs = 0) {
  const phase = { name, status, delayMs, active: 0, maxConcurrent: 0, requests: [] };
  report.receivers.push(phase);
  return phase;
}
let receiver = collectorPhase("offline", 503);
const collector = createServer(async (req, res) => {
  const phase = receiver;
  phase.maxConcurrent = Math.max(phase.maxConcurrent, ++phase.active);
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.equal(req.url, "/v1/logs");
    assert.equal(req.headers["content-type"], "application/x-protobuf");
    assert.equal(req.headers.authorization, "Bearer fixture+secret");
    const body = Buffer.concat(chunks);
    phase.requests.push({
      sha256: createHash("sha256").update(body).digest("hex"),
      status: phase.status,
    });
    if (phase.delayMs) await delay(phase.delayMs);
    if (phase.status === 200) {
      accepted.push(body);
      res.writeHead(200, { "Content-Type": "application/x-protobuf" });
    } else {
      if (phase.status === 503) rejected++;
      res.writeHead(phase.status, { "Retry-After": "1" });
    }
    res.end();
  } finally {
    phase.active--;
  }
});
const model = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  assert.equal(request.model, "trajectory-fixture");
  assert.equal(request.stream, true);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "fixture response" }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
  );
});
for (const server of [collector, model]) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
}
function launch(args) {
  const child = spawnNative(binary, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done, stderr: () => stderr };
}
async function until(condition, label, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await condition();
    if (result) return result;
    await delay(100);
  }
  throw Error(`timed out: ${label}; directory=${directory}`);
}
async function records() {
  const files = await readdir(spool).catch(() => []);
  return Promise.all(
    files
      .filter((file) => /^record-.*\.json$/.test(file))
      .map(async (file) => JSON.parse(await readFile(join(spool, file), "utf8"))),
  );
}
async function configure(enabled) {
  await writeFile(
    configPath,
    `schema_version = 1\n[model]\nname = "trajectory-fixture"\n[model.providers.default]\nendpoint = "http://127.0.0.1:${model.address().port}/v1/chat/completions"\n[trajectory]\nenabled = ${enabled}\nendpoint = "http://127.0.0.1:${collector.address().port}"\nspool_dir = ${JSON.stringify(spool)}\nheaders_file = ${JSON.stringify(join(directory, "headers"))}\nretry_initial_seconds = 1\nretry_max_seconds = 2\nrequest_timeout_seconds = 1\nupload_interval_ms = 100\n`,
  );
}
async function management(operation) {
  const running = launch(["trajectory", operation, "--config", configPath]);
  try {
    const result = await Promise.race([
      running.done,
      delay(15000, undefined, { ref: false }).then(() => {
        throw Error(`trajectory ${operation} timed out`);
      }),
    ]);
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout);
  } catch (error) {
    running.child.kill("SIGKILL");
    throw error;
  }
}
async function workerPids() {
  const { stdout } = await execute("/bin/ps", ["-axo", "pid=,command="], {
    maxBuffer: 8 * 1024 * 1024,
  });
  const command = `${binary} trajectory-worker --spool-dir ${spool}`;
  // 精确匹配本测试随机目录的 Rust 子进程，不匹配包含相同参数的 Python 中转。
  return stdout.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    return match && match[2] === command && Number(match[1]) > 1 ? [Number(match[1])] : [];
  });
}
async function disable() {
  await configure(false);
  await management("sync-config");
  await until(
    async () => !(await management("status")).worker_running && (await workerPids()).length === 0,
    "disabled worker exit",
  );
}
async function stopCore(server) {
  server.child.kill("SIGINT");
  await Promise.race([
    server.done,
    delay(5000, undefined, { ref: false }).then(() => {
      throw Error("Core shutdown blocked on remote");
    }),
  ]);
}
async function failedTurn(name) {
  await disable();
  receiver = collectorPhase(`${name}-unauthorized`, 401);
  const previous = new Set((await records()).map((record) => record.id));
  await configure(true);
  const state = join(directory, `state-${name}`);
  const server = launch([
    "app-server",
    "--config",
    configPath,
    "--listen",
    "127.0.0.1:0",
    "--data-dir",
    state,
  ]);
  const endpoint = await until(
    () => server.stderr().match(/ws:\/\/127\.0\.0\.1:\d+/)?.[0],
    `${name} Core startup`,
  );
  await management("sync-config");
  const request = launch([
    "--auth-file",
    join(state, "security/auth.json"),
    "--endpoint",
    endpoint,
    "--prompt",
    `${name} trajectory fixture`,
  ]);
  const result = await Promise.race([
    request.done,
    delay(15000, undefined, { ref: false }).then(() => {
      throw Error(`${name} Agent response blocked`);
    }),
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), "fixture response");
  await until(
    async () => (await records()).some((record) => !previous.has(record.id) && record.terminal),
    `${name} terminal persistence`,
  );
  await stopCore(server);
  const rows = await until(async () => {
    const rows = (await records()).filter((record) => !previous.has(record.id));
    return (
      rows.length > 0 &&
      rows.every(
        (record) => record.status === "failed" && record.error === "authentication_rejected",
      ) &&
      rows
    );
  }, `${name} unauthorized records`);
  assert.equal((await workerPids()).length, 1, `${name} must have exactly one Rust worker`);
  return rows;
}
async function spawnedAt() {
  return JSON.parse(await readFile(join(spool, "spawned_at.json"), "utf8"));
}
async function killOwnWorker() {
  const pids = await workerPids();
  assert.equal(pids.length, 1, "expected exactly one owned Rust worker before SIGKILL");
  process.kill(pids[0], "SIGKILL");
  await until(
    async () => (await workerPids()).length === 0 && !(await management("status")).worker_running,
    "owned worker SIGKILL exit",
  );
  return pids[0];
}
async function deliveredOnce(rows, phase) {
  const ids = new Set(rows.map((record) => record.id));
  await until(async () => {
    const current = (await records()).filter((record) => ids.has(record.id));
    return (
      current.length === rows.length && current.every((record) => record.status === "uploaded")
    );
  }, `${phase.name} backlog delivery`);
  assert.deepEqual(
    phase.requests.map((request) => request.sha256).sort(),
    rows.map((record) => record.sha256).sort(),
    "each queued payload must be accepted exactly once in a fault-free recovery",
  );
  assert.equal(phase.maxConcurrent, 1, "only one worker may send at a time");
}
async function evidence() {
  if (!process.env.AREAL_TRAJECTORY_SMOKE_OUTPUT) return;
  await mkdir(process.env.AREAL_TRAJECTORY_SMOKE_OUTPUT, { recursive: true });
  await writeFile(
    join(process.env.AREAL_TRAJECTORY_SMOKE_OUTPUT, "manifest.json"),
    JSON.stringify(report, null, 2),
  );
}
try {
  await writeFile(join(directory, "headers"), "authorization=Bearer%20fixture+secret", {
    mode: 0o600,
  });
  await configure(true);
  const server = launch([
    "app-server",
    "--config",
    configPath,
    "--listen",
    "127.0.0.1:0",
    "--data-dir",
    join(directory, "state"),
  ]);
  const endpoint = await until(
    () => server.stderr().match(/ws:\/\/127\.0\.0\.1:\d+/)?.[0],
    "Core startup",
  );
  const started = Date.now();
  const request = launch([
    "--auth-file",
    join(directory, "state/security/auth.json"),
    "--endpoint",
    endpoint,
    "--prompt",
    "trajectory fixture",
  ]);
  const result = await Promise.race([
    request.done,
    delay(15000, undefined, { ref: false }).then(() => {
      throw Error("Agent response blocked");
    }),
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), "fixture response");
  assert.equal(accepted.length, 0, "Agent must return before collector recovers");
  const responseMs = Date.now() - started;
  await until(
    async () => (await records()).some((record) => record.terminal),
    "durable terminal event",
  );
  await until(() => rejected > 0, "offline collector attempt");
  await stopCore(server);
  const pending = await records();
  assert(pending.some((record) => record.status === "pending"));
  assert(pending.every((record) => record.harness_version === version));
  assert(pending.some((record) => record.model_name === "trajectory-fixture"));
  receiver = collectorPhase("after-core-exit", 200);
  await until(
    async () => {
      const entries = await records();
      return entries.length > 0 && entries.every((record) => record.status === "uploaded");
    },
    "independent worker drains after Core exits",
    30000,
  );
  const completed = await records();
  assert(completed.some((record) => record.execution_duration_ms != null));
  assert(completed.every((record) => record.uploaded_at >= record.created_at));
  const fixtureOutput = process.env.AREAL_TRAJECTORY_FIXTURE_OUTPUT;
  if (fixtureOutput) {
    await mkdir(fixtureOutput, { recursive: true });
    for (const [index, body] of accepted.entries())
      await writeFile(join(fixtureOutput, `${String(index).padStart(3, "0")}.pb`), body);
  }
  report.scenarios.push({
    name: "offline-core-exit",
    responseMs,
    rejected,
    uploaded: completed.length,
  });
  const rapidRows = await failedTurn("rapid-reenable");
  await disable();
  const rapidSpawnedAt = await spawnedAt();
  const rapid = {
    name: "rapid-reenable",
    processSpawnedAt: rapidSpawnedAt,
    spawnAgeBeforeEnableMs: Date.now() - rapidSpawnedAt,
    retryCalls: 1,
  };
  report.scenarios.push(rapid);
  assert(
    rapid.spawnAgeBeforeEnableMs >= 0 && rapid.spawnAgeBeforeEnableMs < 5000,
    "fixture must re-enable within the real five-second spawn throttle",
  );
  receiver = collectorPhase("rapid-reenable-recovery", 200, 120);
  await configure(true);
  rapid.enabled = await management("sync-config");
  assert.equal(rapid.enabled.worker_running, true, "explicit enable must acquire the worker lease");
  rapid.retry = await management("retry");
  await deliveredOnce(rapidRows, receiver);
  rapid.uploaded = rapidRows.length;

  const crashRows = await failedTurn("worker-crash");
  const crashPid = await killOwnWorker();
  const crashSpawnedAt = await spawnedAt();
  const crash = {
    name: "worker-crash",
    killedWorkerPid: crashPid,
    processSpawnedAt: crashSpawnedAt,
    spawnAgeBeforeRetryMs: Date.now() - crashSpawnedAt,
    retryCalls: 1,
  };
  report.scenarios.push(crash);
  assert(
    crash.spawnAgeBeforeRetryMs >= 0 && crash.spawnAgeBeforeRetryMs < 5000,
    "fixture must retry a killed worker before the automatic throttle expires",
  );
  receiver = collectorPhase("worker-crash-recovery", 200, 120);
  crash.retry = await management("retry");
  assert.equal(
    crash.retry.worker_running,
    true,
    "the first explicit retry must restore the worker",
  );
  await deliveredOnce(crashRows, receiver);
  crash.uploaded = crashRows.length;

  const concurrentRows = await failedTurn("concurrent-retry");
  const concurrentPid = await killOwnWorker();
  const concurrentSpawnedAt = await spawnedAt();
  const concurrent = {
    name: "concurrent-retry",
    killedWorkerPid: concurrentPid,
    processSpawnedAt: concurrentSpawnedAt,
    spawnAgeBeforeRetryMs: Date.now() - concurrentSpawnedAt,
    retryCalls: 6,
    maxWorkers: 0,
  };
  report.scenarios.push(concurrent);
  assert(
    concurrent.spawnAgeBeforeRetryMs >= 0 && concurrent.spawnAgeBeforeRetryMs < 5000,
    "concurrent retries must exercise the startup window",
  );
  receiver = collectorPhase("concurrent-retry-recovery", 200, 120);
  let observing = true;
  let observationError;
  const observation = (async () => {
    while (observing) {
      const count = (await workerPids()).length;
      concurrent.maxWorkers = Math.max(concurrent.maxWorkers, count);
      await delay(10);
    }
  })().catch((error) => {
    observationError = error;
  });
  try {
    concurrent.retries = await Promise.all(
      Array.from({ length: concurrent.retryCalls }, () => management("retry")),
    );
    await deliveredOnce(concurrentRows, receiver);
  } finally {
    observing = false;
    await observation;
  }
  if (observationError) throw observationError;
  assert.equal(concurrent.maxWorkers, 1, "concurrent retries must retain one actual Rust worker");
  concurrent.uploaded = concurrentRows.length;
  await disable();
  report.passed = true;
  await evidence();
  console.log(
    `trajectory smoke passed: Agent ${responseMs} ms; ${rejected} offline attempts; Core-exit, rapid re-enable, SIGKILL and concurrent retry recovery verified`,
  );
  console.log(
    JSON.stringify({
      passed: report.passed,
      scenarios: report.scenarios.map(({ enabled, retry, retries, ...summary }) => summary),
      evidence: process.env.AREAL_TRAJECTORY_SMOKE_OUTPUT || null,
    }),
  );
} catch (error) {
  report.error = error.stack || String(error);
  await evidence();
  throw error;
} finally {
  // 控制快照先停上传器，再删除临时目录，避免在测试结束后遗留后台进程。
  try {
    const path = join(spool, "control.json");
    const control = JSON.parse(await readFile(path, "utf8"));
    control.enabled = false;
    await writeFile(path, JSON.stringify(control));
    await delay(1200);
  } catch {}
  for (const child of children) child.kill("SIGKILL");
  // 只清理精确匹配本测试随机 spool 的 Rust worker，Python 父进程自行回收退出状态。
  for (const pid of await workerPids()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  for (const server of [model, collector]) {
    server.closeAllConnections();
    server.close();
  }
  await rm(directory, { recursive: true, force: true });
}
