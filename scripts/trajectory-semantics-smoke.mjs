// 真实 owned Core/Runtime、多轮、子 Agent、换模型、失败与取消；模型和接收端均为本地夹具。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawnNative } from "./native-child.mjs";

const directory = await mkdtemp(join(tmpdir(), "areal-trajectory-semantics-"));
const workspace = join(directory, "workspace");
const configPath = join(directory, "config.toml");
const spool = join(directory, "spool");
const output = resolve(process.env.AREAL_TRAJECTORY_SEMANTICS_OUTPUT || "out/trajectory-semantics");
await mkdir(workspace);
await mkdir(output, { recursive: true });
for (const name of await readdir(output)) {
  if (/^\d{3}\.pb$/.test(name)) await rm(join(output, name));
}
await writeFile(join(workspace, "fixture.txt"), "runtime-semantic-fixture\n");
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
const children = new Set();
const accepted = [];
const requests = [];
const modelErrors = [];
let cancellationStarted = false;
const collector = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  assert.equal(req.url, "/v1/logs");
  accepted.push(Buffer.concat(chunks));
  res.writeHead(200, { "Content-Type": "application/x-protobuf" });
  res.end();
});
const frame = (delta, finish = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const call = (id, name, args, index = 0) => ({
  index,
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const model = createServer(async (req, res) => {
  try {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    requests.push(input);
    assert(requests.length <= 50, "fixture model request limit");
    const user = input.messages.findLast(
      (message) =>
        message.role === "user" &&
        /ROOT_TOOL|CHILD_FIXTURE|MODEL_SWITCH|FAIL_FIXTURE|CANCEL_FIXTURE/.test(
          typeof message.content === "string" ? message.content : JSON.stringify(message.content),
        ),
    );
    const prompt = typeof user.content === "string" ? user.content : JSON.stringify(user.content);
    if (prompt.includes("FAIL_FIXTURE")) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          error: { message: "deterministic invalid request", type: "invalid_request_error" },
        }),
      );
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (prompt.includes("CANCEL_FIXTURE")) {
      res.write(frame({ content: "partial-before-cancel" }));
      cancellationStarted = true;
      const timer = setTimeout(
        () => res.end(frame({ content: "tail-after-cancel" }, "stop") + "data: [DONE]\n\n"),
        2000,
      );
      timer.unref();
      return;
    }
    const tools = input.messages.filter((message) => message.role === "tool");
    let delta;
    if (prompt.includes("CHILD_FIXTURE")) {
      delta = tools.some((message) => message.tool_call_id === "child-read")
        ? { content: "child done" }
        : { tool_calls: [call("child-read", "fs_read", { path: "fixture.txt" })] };
    } else if (prompt.includes("ROOT_TOOL")) {
      assert(input.tools.some((tool) => tool.function.name === "fs_read"));
      assert(input.tools.some((tool) => tool.function.name === "agent_spawn"));
      delta = tools.some((message) => message.tool_call_id === "root-read")
        ? { content: "root done" }
        : {
            tool_calls: [
              call("root-read", "fs_read", { path: "fixture.txt" }),
              call(
                "spawn-child",
                "agent_spawn",
                { prompt: "CHILD_FIXTURE read fixture.txt", maxModelRounds: 3 },
                1,
              ),
            ],
          };
    } else {
      assert(prompt.includes("MODEL_SWITCH"), prompt);
      delta = { content: "second done" };
    }
    res.end(
      frame(delta) +
        frame({}, delta.tool_calls ? "tool_calls" : "stop") +
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })}\n\ndata: [DONE]\n\n`,
    );
  } catch (error) {
    modelErrors.push(String(error));
    res.destroy(error);
  }
});
for (const server of [collector, model]) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
}
function launch(prompt, extra = []) {
  const child = spawnNative(
    resolve("target/debug/areal"),
    [
      "exec",
      "--config",
      configPath,
      "--workspace",
      workspace,
      "--output-format",
      "json",
      ...extra,
      prompt,
    ],
    { stdio: ["ignore", "pipe", "pipe"], env },
  );
  children.add(child);
  child.once("exit", () => children.delete(child));
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done, diagnostic: () => ({ stdout, stderr }) };
}
async function until(condition, label, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await condition();
    if (value) return value;
    await delay(100);
  }
  throw Error(`timed out: ${label}; model errors=${modelErrors.join("; ")}`);
}
async function run(prompt, extra = []) {
  const running = launch(prompt, extra);
  const value = await Promise.race([
    running.done,
    delay(45000, undefined, { ref: false }).then(() => {
      throw Error(
        `CLI timeout: ${prompt}; requests=${requests.length}; errors=${modelErrors.join(";")}; diagnostic=${JSON.stringify(running.diagnostic())}`,
      );
    }),
  ]);
  return { ...value, result: JSON.parse(value.stdout) };
}
async function queued() {
  return Promise.all(
    (await readdir(spool).catch(() => []))
      .filter((f) => /^record-.*\.json$/.test(f))
      .map(async (f) => JSON.parse(await readFile(join(spool, f), "utf8"))),
  );
}
try {
  await writeFile(
    configPath,
    `schema_version = 1\n[model]\ncatalog_version = 1\nprovider = "default"\nname = "trajectory-first"\n[model.providers.default]\nendpoint = "http://127.0.0.1:${model.address().port}/v1/chat/completions"\nmodels = [{ id = "trajectory-first" }, { id = "trajectory-second" }]\n[trajectory]\nenabled = true\nendpoint = "http://127.0.0.1:${collector.address().port}"\nspool_dir = ${JSON.stringify(spool)}\nupload_interval_ms = 100\n`,
  );
  const first = await run("ROOT_TOOL read fixture and delegate child");
  assert.equal(first.code, 0, first.stderr + first.stdout);
  assert(first.result.result.trim().endsWith("root done"));
  const second = await run("MODEL_SWITCH second turn", [
    "--resume",
    first.result.session_id,
    "--model",
    "trajectory-second",
  ]);
  assert.equal(second.code, 0, second.stderr + second.stdout);
  assert.equal(second.result.session_id, first.result.session_id);
  assert.equal(second.result.result, "second done");
  const failed = await run("FAIL_FIXTURE");
  assert.notEqual(failed.code, 0);
  assert.equal(failed.result.is_error, true);
  const cancel = launch("CANCEL_FIXTURE");
  await until(() => cancellationStarted, "first cancellation token");
  await delay(200);
  cancel.child.kill("SIGINT");
  const cancelled = await cancel.done;
  assert.notEqual(cancelled.code, 0, cancelled.stdout);
  const entries = await until(async () => {
    const entries = await queued();
    return entries.filter((entry) => entry.terminal).length >= 5 &&
      entries.every((entry) => entry.status === "uploaded")
      ? entries
      : false;
  }, "all five root/child/second/error/cancel terminal records uploaded");
  assert.deepEqual(modelErrors, []);
  assert(requests.some((request) => request.model === "trajectory-second"));
  assert(
    requests.some((request) =>
      request.messages.some(
        (message) =>
          message.role === "tool" &&
          JSON.stringify(message.content).includes("runtime-semantic-fixture"),
      ),
    ),
  );
  for (const [index, payload] of accepted.entries())
    await writeFile(join(output, `${String(index).padStart(3, "0")}.pb`), payload);
  await writeFile(join(output, "requests.json"), JSON.stringify(requests, null, 2));
  await writeFile(join(output, "records.json"), JSON.stringify(entries, null, 2));
  await writeFile(
    join(output, "results.json"),
    JSON.stringify({ first, second, failed, cancelled }, null, 2),
  );
  console.log(
    `semantic smoke passed: ${requests.length} actual model requests; ${entries.length} OTLP events; fixtures=${output}`,
  );
} finally {
  await writeFile(join(output, "requests.json"), JSON.stringify(requests, null, 2));
  for (const [index, payload] of accepted.entries())
    await writeFile(join(output, `${String(index).padStart(3, "0")}.pb`), payload);
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
