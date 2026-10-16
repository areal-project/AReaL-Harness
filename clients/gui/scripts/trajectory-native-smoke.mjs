import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 验证真实桌面控制、Core 安全重启及后台续传；不访问用户目录或外部模型。
const gui = resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(join(gui, "app/package.json"));
const { CoreBackend } = require("../app/src/core/backend.cjs");
const { executeCore } = require("../app/src/core/core-process.cjs");
const root = await mkdtemp("/private/tmp/areal-trajectory-native-");
const evidence = process.env.AREAL_TRAJECTORY_NATIVE_OUTPUT || root;
await mkdir(evidence, { recursive: true });
const binary = process.env.AREAL_CORE_BIN || resolve(gui, "../../target/debug/areal");
const binarySHA256 = createHash("sha256")
  .update(await readFile(binary))
  .digest("hex");
const config = join(root, "config.toml");
const checks = [],
  errors = [],
  bodies = [],
  queries = [];
let backend,
  project,
  release,
  responseCode = 401,
  passed = false,
  held = false;
const sse = (delta, reason) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
const model = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  queries.push(body);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const finish = () =>
    res.end(
      sse({ content: "TOGGLE_NATIVE_MODEL_REPLY" }, null) + sse({}, "stop") + "data: [DONE]\n\n",
    );
  if (!held) {
    held = true;
    release = finish;
    return;
  }
  if (!body.messages.some((message) => message.role === "tool")) {
    res.end(
      sse(
        {
          tool_calls: [
            {
              index: 0,
              id: "read-toggle-fixture",
              type: "function",
              function: {
                name: "fs_read",
                arguments: JSON.stringify({ path: "fixture.txt" }),
              },
            },
          ],
        },
        null,
      ) +
        sse({}, "tool_calls") +
        "data: [DONE]\n\n",
    );
  } else finish();
});
const collector = createServer(async (req, res) => {
  assert.equal(req.url, "/v1/logs");
  assert.equal(req.headers["content-type"], "application/x-protobuf");
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  if (responseCode === 200)
    bodies.push(req.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw);
  res.writeHead(responseCode, { "Content-Type": "application/x-protobuf" });
  res.end();
});
async function until(predicate, label) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Timeout: ${label}`);
}
const status = () => backend.command("trajectory", { operation: "status" });
async function toggle(enabled) {
  const current = await status();
  return backend.command("trajectory", {
    operation: "setEnabled",
    enabled,
    expectedRevision: current.config_revision,
  });
}
const fullyApplied = async () => {
  const value = await status();
  assert.ok(!value.capture_apply_error, value.capture_apply_error);
  return !value.capture_apply_pending && value;
};
try {
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => collector.listen(0, "127.0.0.1", resolve));
  const workspace = join(root, "workspace"),
    user = join(root, "user");
  await mkdir(workspace);
  await mkdir(user);
  await writeFile(join(workspace, "fixture.txt"), "TOGGLE_NATIVE_TOOL_RESULT\n");
  await writeFile(
    config,
    `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n[trajectory]\nenabled=false\nendpoint="http://127.0.0.1:${collector.address().port}"\nspool_dir=${JSON.stringify(join(root, "spool"))}\nupload_interval_ms=10\nrequest_timeout_seconds=1\n`,
  );
  backend = new CoreBackend({
    binary,
    home: join(root, "desktop"),
    harnessHome: join(root, "registry"),
    userHome: user,
    config,
  });
  await backend.init();
  const projectId = await backend.addProject(workspace);
  project = backend.projects.get(projectId);
  const { threadId } = await backend.command("create", { projectId });
  await backend.command("send", { projectId, threadId, text: "TOGGLE_NATIVE_FIRST_QUERY" });
  await until(() => release, "active model response");
  const endpointBefore = project.endpoint;
  const enabled = await toggle(true);
  assert.equal(enabled.capture_apply_pending, true);
  assert.equal(project.endpoint, endpointBefore);
  release();
  await until(
    () => project.model.state.threads[threadId]?.turns.at(-1)?.status === "completed",
    "original task completes",
  );
  await until(fullyApplied, "idle capture reassembly from disabled startup");
  assert.notEqual(project.endpoint, endpointBefore);
  assert.equal(project.model.state.threads[threadId].turns.at(-1).status, "completed");
  checks.push(
    "disabled-start Core: active task completes without cancellation, idle safe apply restarts capture assembly",
  );
  const next = await backend.command("create", { projectId });
  await backend.command("send", {
    projectId,
    threadId: next.threadId,
    text: "TOGGLE_NATIVE_CAPTURED_QUERY",
  });
  await until(
    () => project.model.state.threads[next.threadId]?.turns.at(-1)?.status === "completed",
    "captured tool turn completes",
  );
  const failed = await until(async () => {
    const value = await status();
    return value.queue.failed > 0 && !value.queue.pending && !value.queue.uploading && value;
  }, "retained unauthorized payloads");
  assert.equal(
    failed.queue.dropped_memory + failed.queue.dropped_oversize + failed.queue.evicted,
    0,
  );
  const ids = failed.records.map((record) => record.id).sort();
  await toggle(false);
  await until(fullyApplied, "disable safely applies");
  await until(async () => !(await status()).worker_running, "disabled worker exits");
  responseCode = 200;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(bodies.length, 0);
  assert.deepEqual((await status()).records.map((record) => record.id).sort(), ids);
  checks.push(
    "disable preserves failed copies and stops the independent worker and subsequent sends",
  );
  await toggle(true);
  await until(fullyApplied, "reenable capture applies");
  const delivered = await until(async () => {
    const value = await status();
    return (
      !value.queue.pending &&
      !value.queue.failed &&
      !value.queue.uploading &&
      value.queue.uploaded === ids.length &&
      value
    );
  }, "automatic failed-copy resumption");
  assert.equal(bodies.length, ids.length);
  const all = Buffer.concat(bodies);
  for (const marker of [
    "TOGGLE_NATIVE_CAPTURED_QUERY",
    "TOGGLE_NATIVE_MODEL_REPLY",
    "TOGGLE_NATIVE_TOOL_RESULT",
    "fs_read",
    "areal.model.request.body",
    "gen_ai.tool.call.arguments",
    "gen_ai.tool.call.result",
  ])
    assert.ok(all.includes(Buffer.from(marker)), marker);
  assert.deepEqual(delivered.records.map((record) => record.id).sort(), ids);
  for (const [index, body] of bodies.entries())
    await writeFile(join(evidence, `${index}.pb`), body);
  await writeFile(join(evidence, "delivery.json"), JSON.stringify(delivered, null, 2));
  checks.push(
    `reenable automatically delivers all ${ids.length} retained events with query, model reply, tool arguments and result`,
  );
  passed = true;
} catch (error) {
  errors.push(error.stack);
  process.exitCode = 1;
} finally {
  release?.();
  if (backend) {
    await executeCore(binary, ["trajectory", "suspend", "--config", config], {
      env: backend.hooks.environment(),
      timeout: 15000,
    }).catch((error) => errors.push(error.message));
    for (const value of backend.projects.values())
      await value.client
        ?.request("areal/server/drain", { strategy: "cancel", timeoutMs: 5000 })
        .catch((error) => errors.push(error.message));
    await backend.shutdown().catch((error) => errors.push(error.message));
  }
  for (const server of [model, collector]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (errors.length) {
    passed = false;
    process.exitCode = 1;
  }
  const manifest = {
    passed,
    checks,
    errors,
    binarySHA256,
    root,
    scope:
      "real GUI backend, public CLI, persistent Core, native file tool, worker and loopback mock model/receiver; excludes Electron IPC and remote Arena",
  };
  await writeFile(join(evidence, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ ...manifest, evidence }));
}
