// 使用构建后的两个二进制验证真实入口、HTTP 模型流、持久化和强杀恢复。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { spawnNative } from "./native-child.mjs";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { connect } from "../examples/desktop-api/client.mjs";

const directory = await mkdtemp(join(tmpdir(), "areal-smoke-"));
const children = new Set();
const requests = [];
// 本地 fixture 必须直连，避免宿主代理缓冲 SSE 或把测试请求转发到外部。
const fixtureEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("AREAL_HARNESS_") &&
        !key.startsWith("AREAL_MODEL") &&
        key !== "AREAL_API_KEY",
    ),
  ),
  HOME: join(directory, "user"),
  AREAL_HARNESS_HOME: join(directory, "home"),
  NO_PROXY: "127.0.0.1,localhost,::1",
  no_proxy: "127.0.0.1,localhost,::1",
};
const traces = [];
let hanging;
const collector = createServer(async (req, res) => {
  const body = [];
  for await (const chunk of req) body.push(chunk);
  traces.push({
    url: req.url,
    type: req.headers["content-type"],
    bytes: Buffer.concat(body).length,
  });
  res.writeHead(200);
  res.end();
});
collector.listen(0, "127.0.0.1");
await once(collector, "listening");
const model = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  requests.push(request);
  assert.equal(
    req.headers.authorization,
    request.model === "alternate" ? undefined : "Bearer fixture-key",
  );
  assert.equal(req.url, "/v1/chat/completions");
  assert.equal(request.stream, true);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const text = request.messages.at(-1).content;
  res.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "reply:" + text }, finish_reason: null }] })}\n\n`,
  );
  if (text === "hang") {
    hanging?.();
    return;
  }
  res.end(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
  );
});
model.listen(0, "127.0.0.1");
await once(model, "listening");
function launch(binary, args, env = {}) {
  return track(
    spawnNative(resolve("target/debug", binary), args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...fixtureEnv, ...env },
    }),
  );
}
function track(child) {
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}
async function start() {
  const configPath = join(directory, "config.toml");
  await writeFile(
    configPath,
    `schema_version = 1\n[model]\nname = "test"\n[model.providers.default]\nendpoint = "http://127.0.0.1:${model.address().port}/v1/chat/completions"\napi_key_env = "SMOKE_MODEL_KEY"\n`,
  );
  const child = launch(
    "areal-server",
    ["--config", configPath, "--listen", "127.0.0.1:0", "--data-dir", directory],
    {
      SMOKE_MODEL_KEY: "fixture-key",
      RUST_LOG: "warn",
      OTEL_SDK_DISABLED: "false",
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collector.address().port}`,
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/protobuf",
      OTEL_SERVICE_NAME: "areal-smoke",
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("server startup timed out")), 15000);
    child.stderr.on("data", (chunk) => {
      const found = stderr.match(/ws:\/\/127\.0\.0\.1:\d+/);
      if (found) {
        clearTimeout(timer);
        resolve(found[0]);
      }
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(Error(`server exited code=${code} signal=${signal}: ${stderr}`));
    });
  });
  // File changes during a process lifetime must not replace its model snapshot.
  await writeFile(configPath, "invalid TOML until the next restart");
  return { child, endpoint, stderr: () => stderr };
}
function prompt(endpoint, text, resume) {
  const child = launch("areal-tui", [
    "--auth-file",
    join(directory, "security/auth.json"),
    "--endpoint",
    endpoint,
    "--prompt",
    text,
    ...(resume ? ["--resume", resume] : []),
  ]);
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) =>
      resolve({ code, stdout, stderr: signal ? `${signal}: ${stderr}` : stderr }),
    );
  });
  return { child, done };
}
try {
  let server = await start();
  const first = await prompt(server.endpoint, "hello").done;
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.stdout.trim(), "reply:hello");
  const id = first.stderr.match(/Thread: ([a-f0-9-]+)/)[1];
  const second = await prompt(server.endpoint, "again", id).done;
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(
    requests[1].messages.map((m) => m.role),
    ["system", "user", "assistant", "user"],
  );
  assert.match(requests[1].messages[0].content, /Multi-agent delegation is available by default/);
  assert(requests[1].tools.some((tool) => tool.function.name === "agent_spawn"));
  const management = await connect(server.endpoint, join(directory, "security/auth.json"));
  await management.call("areal/provider/upsert", {
    expectedRevision: 0,
    provider: {
      id: "pty",
      revision: 0,
      endpoint: `http://127.0.0.1:${model.address().port}/v1/chat/completions`,
      protocol: "chatCompletions",
      models: ["alternate"],
    },
  });
  await management.close();
  const pty = track(
    spawn(
      "python3",
      [
        "scripts/tui-pty-smoke.py",
        resolve("target/debug/areal-tui"),
        "--endpoint",
        server.endpoint,
        "--auth-file",
        join(directory, "security/auth.json"),
      ],
      { env: { ...process.env, AREAL_PTY_MODEL_SWITCH: "1" } },
    ),
  );
  let ptyOutput = "";
  pty.stdout.on("data", (c) => (ptyOutput += c));
  pty.stderr.on("data", (c) => (ptyOutput += c));
  const [ptyCode] = await once(pty, "close");
  assert.equal(ptyCode, 0, ptyOutput);
  process.stdout.write(ptyOutput);
  assert(
    requests.some((r) => r.model === "alternate" && r.messages.at(-1).content === "switched-model"),
  );
  assert(requests.some((r) => r.model === "test" && r.messages.at(-1).content === "reset-model"));
  const hangStarted = new Promise((resolve) => (hanging = resolve));
  const interrupted = prompt(server.endpoint, "hang", id);
  await hangStarted;
  const stopped = once(server.child, "exit");
  server.child.kill("SIGKILL");
  await stopped;
  assert.notEqual((await interrupted.done).code, 0);
  server = await start();
  const recovered = JSON.parse(await readFile(join(directory, `${id}.json`), "utf8"));
  assert.equal(recovered.thread.turns.at(-1).status, "interrupted");
  const resumed = await prompt(server.endpoint, "after-restart", id).done;
  assert.equal(resumed.code, 0, resumed.stderr);
  const persisted = JSON.parse(await readFile(join(directory, `${id}.json`), "utf8"));
  assert.equal(persisted.thread.turns.length, 4);
  assert.equal(persisted.thread.turns.at(-1).status, "completed");
  const finalStopped = once(server.child, "exit");
  server.child.kill("SIGTERM");
  await finalStopped;
  assert.ok(
    traces.some(
      (trace) =>
        trace.url === "/v1/traces" && trace.type === "application/x-protobuf" && trace.bytes > 0,
    ),
    JSON.stringify({ traces, stderr: server.stderr() }),
  );
  console.log(
    "PASS built TUI → WebSocket → Core → HTTP/SSE; multi-turn persistence; SIGKILL recovery; OTLP traces",
  );
} finally {
  await Promise.all(
    [...children].map((child) => {
      const done = once(child, "exit");
      child.kill("SIGTERM");
      return done;
    }),
  );
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  collector.closeAllConnections();
  await new Promise((resolve) => collector.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
