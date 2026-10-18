// 官方 Collector 实际解码/扇出：一个后端故障不能阻塞另一端，持久队列重启后补传。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { spawnNative } from "./native-child.mjs";

const execute = promisify(execFile);
const pins = JSON.parse(await readFile("examples/telemetry/collector-pins.json", "utf8"));
const pin = pins.archives[`${process.platform}-${process.arch}`];
assert(pin, "no pinned Collector archive for this platform");
assert(
  process.env.AREAL_OTELCOL_ARCHIVE,
  "set AREAL_OTELCOL_ARCHIVE to the pinned official archive",
);
const archive = await realpath(process.env.AREAL_OTELCOL_ARCHIVE);
async function fileHash(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
assert.equal(await fileHash(archive), pin.sha256, "official Collector archive SHA256 mismatch");
const directory = await realpath(await mkdtemp(join(tmpdir(), "areal-collector-fanout-")));
const output =
  process.env.AREAL_COLLECTOR_SMOKE_OUTPUT && resolve(process.env.AREAL_COLLECTOR_SMOKE_OUTPUT);
const binary = await realpath(resolve("target/debug/areal"));
const spool = join(directory, "spool");
const config = join(directory, "config.toml");
const collectorConfig = join(directory, "collector.yaml");
const children = new Set();
const errors = [];
const received = { a: [], b: [] };
const modelRequests = [];
const wirePayloads = [];
let collectorPort;
let recovering = false;
let rejected = 0;
let core;
let collector;
let collectorVersionProbe;
let configured = false;
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("AREAL_") && !key.startsWith("OTEL_"),
    ),
  ),
  HOME: join(directory, "user"),
  AREAL_HARNESS_HOME: join(directory, "home"),
  NO_PROXY: "127.0.0.1,localhost,::1",
  no_proxy: "127.0.0.1,localhost,::1",
  RUST_LOG: "warn",
};
const report = {
  passed: false,
  collectorVersion: pins.version,
  archiveSha256: pin.sha256,
  directory,
};
const deadline = Date.now() + 150000;
async function until(check, label, timeout = 20000) {
  const end = Math.min(deadline, Date.now() + timeout);
  while (Date.now() < end) {
    assert.equal(errors.length, 0, errors.join("; "));
    const value = await check();
    if (value) return value;
    await delay(100);
  }
  throw Error(`timeout: ${label}`);
}
function launch(path, args, environment = env) {
  const started = Date.now();
  const child = spawnNative(path, args, { stdio: ["ignore", "pipe", "pipe"], env: environment });
  children.add(child);
  let stdout = "",
    stderr = "";
  let outcome;
  child.stdout.on("data", (chunk) => {
    stdout = (stdout + chunk).slice(-1048576);
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-1048576);
  });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      children.delete(child);
      outcome = { code, signal, elapsedMs: Date.now() - started };
      resolve({ code, signal, stdout, stderr });
    });
  });
  return {
    child,
    done,
    stderr: () => stderr,
    snapshot: () => ({
      ...outcome,
      elapsedMs: outcome?.elapsedMs ?? Date.now() - started,
      stdout,
      stderr,
    }),
  };
}
async function complete(process, timeout = 20000, label = "child") {
  const timer = new AbortController();
  try {
    return await Promise.race([
      process.done,
      delay(timeout, undefined, { ref: false, signal: timer.signal }).then(() => {
        process.timedOut = true;
        process.child.kill("SIGKILL");
        throw Error(`${label} deadline exceeded (${timeout} ms)`);
      }),
    ]);
  } finally {
    timer.abort();
  }
}
async function stop(process) {
  if (!process) return;
  // PID 握手之前 kill 会排队；清理不能把已排队的强制终止降为 SIGTERM。
  if (!process.timedOut) process.child.kill("SIGTERM");
  await complete(process, 10000);
}
async function records() {
  const names = await readdir(spool).catch(() => []);
  return Promise.all(
    names
      .filter((name) => /^record-.*\.json$/.test(name))
      .map(async (name) => JSON.parse(await readFile(join(spool, name), "utf8"))),
  );
}
async function management(action) {
  const result = await complete(launch(binary, ["trajectory", action, "--config", config]), 15000);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}
async function bytes(req) {
  let size = 0;
  const parts = [];
  for await (const part of req) {
    size += part.length;
    assert(size <= 4194304, "bounded fixture request");
    parts.push(part);
  }
  return Buffer.concat(parts);
}
// 字节不变的回环取证代理；所有 ACK 均来自实际官方 Collector，不自行模拟成功。
const ingress = createServer(async (req, res) => {
  try {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/logs");
    assert.equal(req.headers["content-type"], "application/x-protobuf");
    assert.equal(req.headers.authorization, undefined);
    const body = await bytes(req);
    wirePayloads.push(body);
    assert(wirePayloads.length <= 20, "bounded wire requests");
    const response = await fetch(`http://127.0.0.1:${collectorPort}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/x-protobuf" },
      body,
      signal: AbortSignal.timeout(10000),
    });
    const responseBody = Buffer.from(await response.arrayBuffer());
    assert(responseBody.length <= 32768);
    res.writeHead(response.status, {
      "content-type": response.headers.get("content-type") || "application/octet-stream",
    });
    res.end(responseBody);
  } catch (error) {
    errors.push(error.message);
    res.writeHead(503);
    res.end();
  }
});
const sinks = ["a", "b"].map((name) =>
  createServer(async (req, res) => {
    try {
      assert.equal(req.url, "/v1/logs");
      // Collector 使用官方 OTLP JSON 编码输出，避免在夹具中重写 protobuf 解码器。
      assert.equal(req.headers["content-type"], "application/json");
      assert.equal(req.headers.authorization, undefined);
      const body = await bytes(req);
      const value = JSON.parse(body);
      if (name === "b" && !recovering) {
        rejected++;
        assert(rejected <= 100, "bounded unavailable-backend attempts");
        res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "1" });
        res.end(JSON.stringify({ code: 14, message: "fixture temporarily unavailable" }));
      } else {
        received[name].push(value);
        assert(received[name].length <= 20, "bounded received batches");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      }
    } catch (error) {
      errors.push(error.message);
      res.writeHead(400);
      res.end();
    }
  }),
);
const model = createServer(async (req, res) => {
  try {
    const raw = await bytes(req);
    const body = JSON.parse(raw);
    assert.equal(body.model, "collector-fixture");
    assert.equal(body.stream, true);
    assert(modelRequests.length < 2, "only two controlled model requests");
    modelRequests.push({ body, sha256: createHash("sha256").update(raw).digest("hex") });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const frame = (delta, finish_reason) =>
      `data: ${JSON.stringify({ id: `collector-${modelRequests.length}`, model: "collector-fixture-snapshot", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.end(
      frame({ content: "collector fixture response" }, null) +
        frame({}, "stop") +
        "data: [DONE]\n\n",
    );
  } catch (error) {
    errors.push(error.message);
    res.writeHead(400);
    res.end();
  }
});
function values(attributes = []) {
  const value = (v) => {
    if ("stringValue" in v) return v.stringValue;
    if ("intValue" in v) return Number(v.intValue);
    if ("doubleValue" in v) return v.doubleValue;
    if ("boolValue" in v) return v.boolValue;
    if ("arrayValue" in v) return (v.arrayValue.values || []).map(value);
    if ("kvlistValue" in v)
      return Object.fromEntries((v.kvlistValue.values || []).map((x) => [x.key, value(x.value)]));
    if ("bytesValue" in v) return v.bytesValue;
    return null;
  };
  return Object.fromEntries(attributes.map((a) => [a.key, value(a.value)]));
}
function events(batches) {
  return batches.flatMap((batch) =>
    batch.resourceLogs.flatMap((resource) =>
      resource.scopeLogs.flatMap((scope) =>
        scope.logRecords.map((record) => ({
          resource: values(resource.resource.attributes),
          scope: scope.scope,
          record,
          attributes: values(record.attributes),
        })),
      ),
    ),
  );
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
function eventContent(row) {
  const { attributes: _attributes, ...record } = row.record;
  return canonical({
    resource: row.resource,
    scope: row.scope,
    record,
    attributes: row.attributes,
  });
}
function verify(rows, installation) {
  assert.equal(rows.length, 6);
  assert.equal(new Set(rows.map((row) => row.attributes["areal.event.id"])).size, 6);
  for (const row of rows) {
    assert.equal(row.resource["service.name"], "areal-core");
    assert.equal(row.resource["service.instance.id"], installation);
    assert(row.resource["service.version"]);
    assert(row.resource["service.build.revision"]);
    assert.equal(row.attributes["areal.trajectory.schema_version"], "areal.trajectory/v1");
    assert.notEqual(row.attributes["areal.capture.truncated"], true);
    assert.match(row.record.traceId, /^[a-f0-9]{32}$/i);
    assert.match(row.record.spanId, /^[a-f0-9]{16}$/i);
  }
  const turns = Map.groupBy(rows, (row) => row.attributes["areal.turn.id"]);
  assert.equal(turns.size, 2);
  for (const turn of turns.values()) {
    turn.sort(
      (a, b) => a.attributes["areal.event.sequence"] - b.attributes["areal.event.sequence"],
    );
    assert.deepEqual(
      turn.map((row) => row.attributes["areal.event.sequence"]),
      [1, 2, 3],
    );
    assert.deepEqual(
      turn.map((row) => row.record.eventName),
      ["areal.user_prompt", "gen_ai.client.inference.operation.details", "areal.turn.completed"],
    );
    const terminal = turn.at(-1).attributes;
    assert.equal(terminal["areal.turn.event_count"], 3);
    assert.equal(
      terminal["areal.turn.events_sha256"],
      createHash("sha256")
        .update(
          turn
            .map(
              (row) =>
                `${row.attributes["areal.event.sequence"]}:${row.attributes["areal.event.id"]}\n`,
            )
            .join(""),
        )
        .digest("hex"),
    );
  }
  const calls = rows.filter(
    (row) => row.record.eventName === "gen_ai.client.inference.operation.details",
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((row) => row.attributes["areal.model.request.sha256"]).sort(),
    modelRequests.map((row) => row.sha256).sort(),
  );
  for (const call of calls) {
    const body = call.attributes["areal.model.request.body"];
    assert.equal(typeof body, "string");
    assert.equal(
      createHash("sha256").update(body).digest("hex"),
      call.attributes["areal.model.request.sha256"],
    );
    assert.deepEqual(
      JSON.parse(body),
      modelRequests.find((row) => row.sha256 === call.attributes["areal.model.request.sha256"])
        .body,
    );
    assert.equal(call.attributes["gen_ai.response.model"], "collector-fixture-snapshot");
    assert(
      JSON.stringify(call.attributes["gen_ai.output.messages"]).includes(
        "collector fixture response",
      ),
    );
  }
}
try {
  await execute("tar", ["-xzf", archive, "-C", directory, "otelcol-contrib"], { timeout: 20000 });
  const collectorBinary = join(directory, "otelcol-contrib");
  report.collectorBinarySha256 = await fileHash(collectorBinary);
  collectorVersionProbe = launch(collectorBinary, ["--version"]);
  // 官方发行二进制冷启动有本地加载开销；只扩大版本预检，整体期限与行为断言不变。
  const version = await complete(collectorVersionProbe, 30000, "Collector version");
  assert.equal(version.code, 0, version.stderr);
  assert(version.stdout.includes(pins.version));
  for (const server of [...sinks, model, ingress]) {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
  }
  const lease = createSocketServer();
  lease.listen(0, "127.0.0.1");
  await once(lease, "listening");
  const port = lease.address().port;
  collectorPort = port;
  await new Promise((resolve) => lease.close(resolve));
  // 仅将出站编码改为 OTLP JSON 以独立核对语义；入站仍是 Harness 原生 protobuf。
  const template = await readFile("examples/telemetry/collector-fanout.yaml", "utf8");
  await writeFile(collectorConfig, template.replaceAll("encoding: proto", "encoding: json"));
  const collectorEnv = {
    ...env,
    OTEL_FANOUT_LISTEN: `127.0.0.1:${port}`,
    OTEL_FANOUT_STORAGE: join(directory, "collector-storage"),
    OTEL_BACKEND_A_LOGS_ENDPOINT: `http://127.0.0.1:${sinks[0].address().port}/v1/logs`,
    OTEL_BACKEND_B_LOGS_ENDPOINT: `http://127.0.0.1:${sinks[1].address().port}/v1/logs`,
  };
  const startCollector = async () => {
    collector = launch(collectorBinary, ["--config", collectorConfig], collectorEnv);
    await until(async () => {
      try {
        return (
          (await fetch(`http://127.0.0.1:${port}/v1/logs`, { signal: AbortSignal.timeout(500) }))
            .status === 405
        );
      } catch {
        return false;
      }
    }, "Collector ready");
  };
  await startCollector();
  const content = `schema_version = 1\n[model]\nname = "collector-fixture"\n[model.providers.default]\nendpoint = "http://127.0.0.1:${model.address().port}/v1/chat/completions"\n[trajectory]\nenabled = true\nendpoint = "http://127.0.0.1:${ingress.address().port}"\nspool_dir = ${JSON.stringify(spool)}\nupload_interval_ms = 100\n`;
  await writeFile(config, content);
  configured = true;
  core = launch(binary, [
    "app-server",
    "--config",
    config,
    "--listen",
    "127.0.0.1:0",
    "--data-dir",
    join(directory, "state"),
  ]);
  const endpoint = await until(
    () => core.stderr().match(/ws:\/\/127\.0\.0\.1:\d+/)?.[0],
    "Core ready",
  );
  for (const prompt of ["collector first", "collector second"]) {
    const result = await complete(
      launch(binary, [
        "--auth-file",
        join(directory, "state/security/auth.json"),
        "--endpoint",
        endpoint,
        "--prompt",
        prompt,
      ]),
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), "collector fixture response");
  }
  await until(async () => {
    const rows = await records();
    return (
      rows.length === 6 &&
      rows.every((row) => row.status === "uploaded") &&
      events(received.a).length === 6 &&
      rejected > 0
    );
  }, "healthy backend and Collector ACK while B unavailable");
  assert.equal(received.b.length, 0);
  report.healthyDeliveredBeforeRecovery = events(received.a).length;
  report.harnessRecords = await records();
  report.wireSha256 = wirePayloads.map((body) => createHash("sha256").update(body).digest("hex"));
  assert.deepEqual(
    report.wireSha256.slice().sort(),
    report.harnessRecords.map((row) => row.sha256).sort(),
    "Collector ingress bytes must match the durable queue",
  );
  await stop(core);
  core = null;
  collector.child.kill("SIGKILL");
  await complete(collector, 10000);
  collector = null;
  // Harness 已释放 ACK 正文，此后补传必须来自 Collector 的独立持久队列。
  await startCollector();
  recovering = true;
  await until(
    () => events(received.b).length === 6,
    "restarted Collector recovers failed backend",
    30000,
  );
  const installation = JSON.parse(await readFile(join(spool, "installation.json"), "utf8"));
  const a = events(received.a),
    b = events(received.b);
  verify(a, installation);
  verify(b, installation);
  const sorted = (rows) =>
    rows
      .map(eventContent)
      .sort((x, y) => x.attributes["areal.event.id"].localeCompare(y.attributes["areal.event.id"]));
  assert.deepEqual(
    sorted(a),
    sorted(b),
    "resources, records, IDs and contents must survive both branches",
  );
  report.semanticSha256 = createHash("sha256")
    .update(JSON.stringify(sorted(a)))
    .digest("hex");
  report.rejectedByB = rejected;
  report.eventsPerBackend = { a: a.length, b: b.length };
  report.requestSha256 = modelRequests.map((row) => row.sha256);
  report.collectorRestartRecovery = true;
  report.passed = true;
} catch (error) {
  report.error = error.message;
  report.collectorStderr = collector?.stderr();
  report.coreStderr = core?.stderr();
  throw error;
} finally {
  const cleanupErrors = [];
  const cleanup = async (action) => {
    try {
      await action();
    } catch (error) {
      cleanupErrors.push(error.message);
    }
  };
  await cleanup(() => stop(collectorVersionProbe));
  report.collectorVersionProbe = collectorVersionProbe?.snapshot();
  await cleanup(() => stop(core));
  if (configured) {
    await cleanup(async () => {
      await writeFile(
        config,
        (await readFile(config, "utf8")).replace("enabled = true", "enabled = false"),
      );
      await management("sync-config");
      const end = Date.now() + 15000;
      while ((await management("status")).worker_running) {
        assert(Date.now() < end, "owned exporter cleanup deadline");
        await delay(100);
      }
    });
  }
  await cleanup(() => stop(collector));
  for (const child of children) child.kill("SIGKILL");
  for (const server of [...sinks, model, ingress]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  report.cleanupErrors = cleanupErrors;
  report.passed &&= cleanupErrors.length === 0;
  if (output) {
    await mkdir(output, { recursive: true });
    await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
    await writeFile(join(output, "received-a.json"), JSON.stringify(received.a, null, 2));
    await writeFile(join(output, "received-b.json"), JSON.stringify(received.b, null, 2));
    await writeFile(join(output, "model-requests.json"), JSON.stringify(modelRequests, null, 2));
    for (const [index, body] of wirePayloads.entries())
      await writeFile(join(output, `${String(index).padStart(3, "0")}.pb`), body);
  }
  if (cleanupErrors.length === 0) await rm(directory, { recursive: true, force: true });
  assert.deepEqual(cleanupErrors, [], "cleanup must finish before reporting success");
}
console.log(
  JSON.stringify({
    passed: report.passed,
    eventsPerBackend: report.eventsPerBackend,
    semanticSha256: report.semanticSha256,
  }),
);
