import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 真实 Core、Side、CLI 和本地接收器；所有配置与服务登记均使用隔离目录。
const gui = resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(join(gui, "app/package.json"));
const { CoreBackend } = require("@areal/workbench-service/desktop/core/backend.cjs");
const { executeCore } = createRequire(import.meta.url)("./support/core-process-fixture.cjs");
const root = await makeTempDir("auf-");
const evidence = process.env.AREAL_FEEDBACK_EVIDENCE_DIR || root;
await mkdir(evidence, { recursive: true });
const binary = process.env.AREAL_CORE_BIN || resolve(gui, "../../target/debug/areal");
const binarySHA256 = createHash("sha256")
  .update(await readFile(binary))
  .digest("hex");
const checks = [],
  requests = [],
  submissions = [],
  cleanupErrors = [];
const telemetry = { batches: 0, contains_feedback_reason: false };
let release,
  held = false,
  passed = false,
  backend,
  project;
const sse = (text) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`;
const model = createServer(async (req, res) => {
  // fixture 显式结束每个 SSE 连接；业务验收与共享模型传输层的空闲连接复用分别验证。
  res.setHeader("Connection", "close");
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(body);
  const last = body.messages.findLast(
    (message) =>
      message.role === "user" &&
      !String(message.content).startsWith("AReaL runtime context (not a user request):"),
  );
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  if (!held && String(last?.content).includes("<frozen-feedback-context>")) {
    held = true;
    release = () =>
      res.end(sse("已结合用户意见分析：需要补充兼容性验证，不能把自报完成作为验收。"));
  } else
    res.end(
      sse(
        String(last?.content).includes("补充")
          ? "补充分析：保留用户原始意见，并明确未验证项。"
          : "主会话已完成。",
      ),
    );
});
const collector = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/openapi/v1/external-feedback/capabilities")
    return res.end(
      JSON.stringify({
        schema_version: "arena.user-feedback/v1",
        enabled: true,
        owner: "isolated-owner",
        max_context_bytes: 16 << 20,
      }),
    );
  let raw = Buffer.alloc(0);
  for await (const chunk of req) raw = Buffer.concat([raw, chunk]);
  if (req.url === "/openapi/v1/otlp/v1/logs") {
    const body = req.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw;
    telemetry.batches++;
    telemetry.contains_feedback_reason ||= body.includes(Buffer.from("尚未确认兼容性"));
    res.setHeader("Content-Type", "application/x-protobuf");
    return res.end();
  }
  assert.equal(req.url, "/openapi/v1/external-feedback");
  const body = JSON.parse(raw);
  submissions.push(body);
  res.statusCode = 201;
  res.end(
    JSON.stringify({
      feedback_id: body.feedback_id,
      rating: body.rating,
      source_id: "isolated-source",
    }),
  );
});
async function until(predicate, label) {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timeout: ${label}`);
}
try {
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => collector.listen(0, "127.0.0.1", resolve));
  const user = join(root, "user"),
    workspace = join(root, "workspace"),
    spool = join(root, "spool");
  await mkdir(user);
  await mkdir(workspace);
  const config = join(root, "config.toml");
  await writeFile(
    config,
    `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n[limits]\nmodel_concurrency=2\n[trajectory]\nenabled=true\nendpoint="http://127.0.0.1:${collector.address().port}/openapi/v1/otlp/v1/logs"\nspool_dir=${JSON.stringify(spool)}\n`,
  );
  backend = new CoreBackend({
    binary,
    home: join(root, "desktop"),
    harnessHome: join(root, "registry"),
    userHome: user,
    config,
  });
  await backend.init();
  const env = backend.hooks.environment();
  await executeCore(binary, ["trajectory", "sync-config", "--config", config], {
    env,
    timeout: 30000,
  });
  const projectId = await backend.addProject(workspace);
  project = backend.projects.get(projectId);
  const { threadId } = await backend.command("create", { projectId });
  await backend.command("send", { projectId, threadId, text: "原始任务：兼容旧接口" });
  await until(
    () => project.model.state.threads[threadId]?.turns.at(-1)?.status === "completed",
    "source completes",
  );
  const turn = project.model.state.threads[threadId].turns.at(-1);
  const reply = turn.items.findLast(
    (item) => item.type === "agentMessage" && item.phase === "final_answer",
  );
  assert.ok(reply);
  const availability = await backend.command("feedback", { operation: "status" });
  assert.equal(availability.connected, true);
  const draft = await backend.command("feedback", {
    operation: "prepare",
    projectId,
    threadId,
    turnId: turn.id,
    itemId: reply.id,
    rating: "down",
  });
  assert.equal(submissions.length, 0);
  const refined = await backend.command("feedback", {
    operation: "refine",
    projectId,
    threadId,
    id: draft.id,
    reason: "尚未确认兼容性。",
  });
  assert.notEqual(refined.sideThreadId, threadId);
  await until(() => release, "independent model request starts");
  const sideRequest = requests.find((body) =>
    JSON.stringify(body).includes("<frozen-feedback-context>"),
  );
  assert.match(JSON.stringify(sideRequest), /原始任务/);
  assert.match(JSON.stringify(sideRequest), /尚未确认兼容性/);
  await backend.command("send", { projectId, threadId, text: "后续主任务：继续提问" });
  await until(
    () =>
      project.model.state.threads[threadId]?.turns.length === 2 &&
      project.model.state.threads[threadId]?.turns.at(-1)?.status === "completed",
    "main continues while Side held",
  );
  assert.equal(project.model.state.threads[refined.sideThreadId].turns.at(-1).status, "inProgress");
  checks.push("native main Turn completes while independent Side generation remains in progress");
  release();
  await until(
    () => project.model.state.threads[refined.sideThreadId]?.turns.at(-1)?.status === "completed",
    "Side completes",
  );
  await until(
    () => telemetry.contains_feedback_reason,
    "polishing obeys enabled trajectory capture before formal feedback submission",
  );
  assert.equal(submissions.length, 0);
  checks.push(
    "ordinary polishing telemetry follows flywheel settings; formal vote waits for explicit submission",
  );
  await backend.command("feedback", {
    operation: "refine",
    projectId,
    threadId,
    id: draft.id,
    text: "补充：明确哪些没有验证。",
  });
  await until(
    () =>
      project.model.state.threads[refined.sideThreadId]?.turns.length === 2 &&
      project.model.state.threads[refined.sideThreadId]?.turns.at(-1)?.status === "completed",
    "Side follow-up completes",
  );
  const result = await backend.command("feedback", {
    operation: "submit",
    projectId,
    threadId,
    id: draft.id,
    reason: "尚未确认兼容性。",
    analysis: "用户确认后的分析：需要补充验证。",
  });
  assert.equal(result.state, "submitted");
  assert.equal(submissions.length, 1);
  const sent = submissions[0];
  assert.equal(sent.rating, "down");
  assert.equal(sent.context.turns.length, 1);
  assert.doesNotMatch(JSON.stringify(sent.context.turns), /后续主任务/);
  assert.equal(sent.context.refinement.thread_id, refined.sideThreadId);
  assert.equal(sent.context.refinement.turns.length, 2);
  assert.equal(
    sent.installation_id,
    JSON.parse(await readFile(join(spool, "installation.json"), "utf8")),
  );
  assert.equal(sent.expected_owner, undefined);
  assert.equal(sent.expected_destination, undefined);
  assert.equal(sent.expected_installation, undefined);
  checks.push(
    "real CLI binds persisted installation and submits only frozen source prefix plus full multi-turn refinement",
  );
  passed = true;
} catch (error) {
  await writeFile(join(evidence, "failure.txt"), error.stack || String(error));
  throw error;
} finally {
  release?.();
  if (project?.service)
    await executeCore(
      binary,
      ["service", "stop", "--instance", project.service.serviceId, "--cancel", "--json"],
      { env: backend.hooks.environment(), timeout: 30000 },
    )
      .then((value) =>
        writeFile(join(evidence, "service-stop-receipt.json"), JSON.stringify(value, null, 2)),
      )
      .catch((error) => cleanupErrors.push({ stage: "service-stop", message: error.message }));
  if (backend) {
    await executeCore(binary, ["trajectory", "suspend", "--config", join(root, "config.toml")], {
      env: backend.hooks.environment(),
      timeout: 30000,
    })
      .then((value) =>
        writeFile(
          join(evidence, "trajectory-suspend-receipt.json"),
          JSON.stringify(value, null, 2),
        ),
      )
      .catch((error) =>
        cleanupErrors.push({ stage: "trajectory-suspend", message: error.message }),
      );
    await backend.disconnect();
  }
  for (const server of [model, collector]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  const binaryAfterSHA256 = createHash("sha256")
    .update(await readFile(binary))
    .digest("hex");
  if (binaryAfterSHA256 !== binarySHA256 || cleanupErrors.length) passed = false;
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(
      {
        passed,
        checks,
        isolatedRoot: root,
        binarySHA256,
        binaryAfterSHA256,
        cleanupErrors,
        telemetry,
      },
      null,
      2,
    ),
  );
  await writeFile(join(evidence, "model-requests.json"), JSON.stringify(requests, null, 2));
  await writeFile(join(evidence, "submitted-feedback.json"), JSON.stringify(submissions, null, 2));
}
if (!passed) throw new Error("Native feedback acceptance or cleanup failed; see saved evidence");
console.log(JSON.stringify({ passed, checks, evidence }));
