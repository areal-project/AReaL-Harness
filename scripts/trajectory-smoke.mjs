// 验证真实 Core 返回、离线积压、独立进程补传与关闭开关；全程只使用本地 fixture。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawnNative } from "./native-child.mjs";

const directory = await mkdtemp(join(tmpdir(), "areal-trajectory-smoke-"));
const configPath = join(directory, "config.toml");
const spool = join(directory, "spool");
const version = (await readFile("Cargo.toml", "utf8")).match(/^version = "([^"]+)"/m)[1];
const children = new Set();
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("AREAL_HARNESS_") &&
        !key.startsWith("AREAL_MODEL") &&
        !key.startsWith("OTEL_") &&
        key !== "AREAL_API_KEY",
    ),
  ),
  HOME: join(directory, "user"),
  AREAL_HARNESS_HOME: join(directory, "home"),
  NO_PROXY: "127.0.0.1,localhost,::1",
  no_proxy: "127.0.0.1,localhost,::1",
  RUST_LOG: "warn",
};
let online = false;
let rejected = 0;
const accepted = [];
const collector = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  assert.equal(req.url, "/v1/logs");
  assert.equal(req.headers["content-type"], "application/x-protobuf");
  assert.equal(req.headers.authorization, "Bearer fixture+secret");
  if (!online) {
    rejected++;
    res.writeHead(503, { "Retry-After": "1" });
  } else {
    accepted.push(Buffer.concat(chunks));
    res.writeHead(200, { "Content-Type": "application/x-protobuf" });
  }
  res.end();
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
  const child = spawnNative(resolve("target/debug/areal"), args, {
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
  server.child.kill("SIGINT");
  await Promise.race([
    server.done,
    delay(5000, undefined, { ref: false }).then(() => {
      throw Error("Core shutdown blocked on remote");
    }),
  ]);
  const pending = await records();
  assert(pending.some((record) => record.status === "pending"));
  assert(pending.every((record) => record.harness_version === version));
  assert(pending.some((record) => record.model_name === "trajectory-fixture"));
  online = true;
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
  await configure(false);
  const disabled = await launch(["trajectory", "sync-config", "--config", configPath]).done;
  assert.equal(disabled.code, 0, disabled.stderr);
  await until(async () => {
    const status = await launch(["trajectory", "status", "--config", configPath]).done;
    return !JSON.parse(status.stdout).worker_running;
  }, "disabled worker exit");
  console.log(
    `trajectory smoke passed: Agent ${responseMs} ms; ${rejected} offline attempts; ${completed.length} events uploaded after Core exit`,
  );
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
  for (const server of [model, collector]) {
    server.closeAllConnections();
    server.close();
  }
  await rm(directory, { recursive: true, force: true });
}
