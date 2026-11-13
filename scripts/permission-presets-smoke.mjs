import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, writeFile, readFile, readdir, access, rm } from "node:fs/promises";
import { trackedMkdtemp } from "../clients/gui/scripts/support/host-cleanup.cjs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { connect } from "../examples/desktop-api/client.mjs";
import { respondToSessionName } from "./model-fixture.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const evidenceRoot = join(repo, ".scratch/permission-presets");
await mkdir(evidenceRoot, { recursive: true });
const evidence = await trackedMkdtemp(join(evidenceRoot, "run-"));
const root = await trackedMkdtemp(join(tmpdir(), "areal-permission-presets-"));
const workspace = join(root, "workspace");
await mkdir(workspace);
// 项目规则的预读取不能收窄后续单次权限审批的可信上限。
await writeFile(join(workspace, "AGENTS.md"), "Preserve unrelated files.\n");
const toolConfig = join(root, "tools.json");
await writeFile(toolConfig, JSON.stringify({ policy: { parallelReadCalls: 4 } }));
const config = join(root, "config.toml");
await writeFile(config, 'schema_version = 1\n[tools]\nextensions_file = "tools.json"\n');
const reviews = [];
const requests = [];
let reviewDecision = "allow";
let holdNextSolve = false;
let releaseHeld;
let holdNextReview = false;
let releaseReview;
let retryReviewFailures = 0;
let retryReviewObserved = false;
const capacityFirstMarker = " [ ] ";
const capacitySecondMarker = " [  ] ";
let capacityFirstStarted;
let capacitySecondStarted = false;
let capacityGate;
let releaseCapacity;
function event(response, delta, finish = null) {
  response.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
  );
}
const fixture = createServer(async (request, response) => {
  if (request.method === "GET") return response.end("NETWORK_REACHED");
  let raw = "";
  for await (const part of request) raw += part;
  const body = JSON.parse(raw);
  if (respondToSessionName(body, response)) return;
  requests.push(body);
  const reviewing = body.messages.some(
    (message) =>
      message.role === "system" &&
      typeof message.content === "string" &&
      message.content.includes("AReaL permission review"),
  );
  if (reviewing && retryReviewFailures > 0) {
    retryReviewFailures--;
    reviews.push(body);
    retryReviewObserved = true;
    response.writeHead(503, { "retry-after": "2" });
    response.end("Temporary local review fixture failure");
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  if (reviewing) {
    assert.ok(!body.tools?.length, "the reviewer cannot execute tools");
    reviews.push(body);
    if (holdNextReview) {
      holdNextReview = false;
      await new Promise((resolve) => (releaseReview = resolve));
    }
    const packet = JSON.parse(body.messages.findLast((message) => message.role === "user").content);
    event(response, {
      content:
        reviewDecision === "malformed"
          ? "not a verdict"
          : JSON.stringify({
              decision: reviewDecision,
              reason: "Local deterministic review fixture",
              digest: packet.digest,
            }),
    });
    event(response, {}, "stop");
  } else {
    if (holdNextSolve) {
      holdNextSolve = false;
      await new Promise((resolve) => (releaseHeld = resolve));
    }
    const index = body.messages.findLastIndex((message) => message.role === "user");
    const content = body.messages[index].content;
    const text =
      typeof content === "string"
        ? content
        : content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("");
    if (text === capacityFirstMarker) {
      capacityFirstStarted?.();
      await capacityGate;
    }
    if (text === capacitySecondMarker) capacitySecondStarted = true;
    const calls = JSON.parse(text);
    const results = body.messages.slice(index + 1).filter((message) => message.role === "tool");
    if (results.length < calls.length) {
      const call = calls[results.length];
      const batch = call.parallel
        ? calls.slice(results.length).filter((entry) => entry.parallel)
        : [call];
      const args = structuredClone(call.args);
      if (call.name === "agent_wait" && args.executionId === "previousExecution") {
        args.executionId = JSON.parse(results.at(-1).content).executionId;
      }
      event(response, {
        tool_calls: batch.map((entry, index) => ({
          index,
          id: `call_${results.length + index}`,
          type: "function",
          function: {
            name: entry.name,
            arguments: JSON.stringify(index === 0 ? args : entry.args),
          },
        })),
      });
      event(response, {}, "tool_calls");
    } else {
      event(response, { content: "Fixture complete" });
      event(response, {}, "stop");
    }
  }
  response.end("data: [DONE]\n\n");
});
fixture.listen(0, "127.0.0.1");
await once(fixture, "listening");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );
let child;
let rpc;
let exited;
let diagnostics = "";
async function start() {
  let launchDiagnostics = "";
  child = spawn(
    "python3",
    [
      "-I",
      "-S",
      join(repo, "scripts/launch.py"),
      "--bin-dir",
      process.env.AREAL_TEST_BIN_DIR ||
        dirname(process.env.AREAL_CORE_BIN || join(repo, "target/debug/areal")),
      "--workspace",
      workspace,
      "--data-dir",
      join(root, "data"),
      "--config",
      config,
      "--runtime-max-processes",
      "2",
      "--allow-concurrent-writes",
      "--listen",
      "127.0.0.1:0",
      "--model",
      "fixture",
      "--model-endpoint",
      `http://127.0.0.1:${fixture.address().port}/`,
    ],
    {
      cwd: repo,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        AREAL_HARNESS_HOME: join(root, "home"),
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  exited = once(child, "exit");
  child.stderr.on("data", (part) => {
    diagnostics += part;
    launchDiagnostics += part;
  });
  let endpoint;
  for (let i = 0; i < 200; i++) {
    endpoint = launchDiagnostics.match(/ws:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (endpoint) break;
    assert.equal(child.exitCode, null, diagnostics);
    await delay(50);
  }
  assert.ok(endpoint, diagnostics);
  rpc = await connect(endpoint, join(root, "data/security/auth.json"));
  await writeFile(
    join(evidence, "capabilities.json"),
    JSON.stringify(await rpc.call("areal/capabilities"), null, 2),
  );
}
async function stop() {
  await rpc?.close();
  rpc = undefined;
  if (!child) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
  await exited;
  clearTimeout(timer);
  child = undefined;
}
async function thread(preset, cwd = workspace) {
  return (
    await rpc.call("areal/thread/start", {
      requestId: randomUUID(),
      cwd,
      options: { permissionPreset: preset },
    })
  ).thread.id;
}
async function turn(threadId, calls) {
  return (
    await rpc.call("turn/start", {
      threadId,
      input: [{ type: "text", text: JSON.stringify(calls) }],
    })
  ).turn.id;
}
async function complete(threadId, turnId) {
  const result = await rpc.waitEvent(
    "turn/completed",
    (params) => params.threadId === threadId && params.turn.id === turnId,
    30000,
  );
  assert.equal(result.turn.status, "completed", JSON.stringify(result));
  await writeFile(
    join(evidence, `history-${threadId}.json`),
    JSON.stringify(await rpc.call("thread/read", { threadId, includeTurns: true }), null, 2),
  );
}
const command = (script, args = {}) => ({
  name: "run_command",
  args: { argv: ["/bin/sh", "-c", script], cwd: ".", timeoutMs: 4000, ...args },
});
const checks = [];
let passed = false;
try {
  await start();
  for (const preset of ["ask", "autoReview", "fullAccess"]) {
    const id = await thread(preset);
    const inspection = await rpc.call("areal/thread/inspect", { threadId: id });
    assert.equal(inspection.configuration.options.permissionPreset, preset);
    const eventStart = rpc.events.length;
    const outside = join(root, `${preset}-outside.txt`);
    const script = `printf local > ${preset}.txt; printf outside > '${outside}'`;
    await complete(id, await turn(id, [command(script)]));
    assert.equal(await readFile(join(workspace, `${preset}.txt`), "utf8"), "local");
    assert.equal(
      await exists(outside),
      preset === "fullAccess",
      "preset must control actual outside writes",
    );
    assert.equal(
      rpc.events.slice(eventStart).filter((item) => item.method === "areal/interaction/requested")
        .length,
      0,
      "routine workspace commands do not require approval",
    );
    checks.push({ preset, workspaceWrite: true, outsideWrite: await exists(outside) });
  }
  const parallelId = await thread("autoReview");
  await writeFile(join(workspace, "read-fixture.txt"), "fixture content\n".repeat(32));
  const parallelTurn = await turn(parallelId, [
    command("sleep 0.5", { yieldMs: 0 }),
    ...Array.from({ length: 16 }, (_, index) => ({
      name: index % 2 ? "search_files" : "read_file",
      parallel: true,
      args:
        index % 2
          ? { path: "read-fixture.txt", pattern: "fixture", limit: 4 }
          : { path: "read-fixture.txt", limit: 4 },
    })),
  ]);
  await complete(parallelId, parallelTurn);
  const parallelHistory = (
    await rpc.call("thread/read", { threadId: parallelId, includeTurns: true })
  ).thread;
  const parallelCalls = parallelHistory.turns
    .at(-1)
    .items.filter((item) => item.type === "dynamicToolCall");
  assert.equal(parallelCalls.length, 17);
  assert.ok(
    parallelCalls.every((call) => call.success === true),
    JSON.stringify(parallelCalls),
  );
  checks.push({
    sameTurnParallelNavigation: 16,
    concurrentBackgroundCommand: true,
    processLimit: 2,
  });

  const additional = (path, network = false) => ({
    readRoots: [],
    writeRoots: [dirname(path)],
    network,
    justification: "Write the explicitly requested fixture output",
  });
  async function answer(interaction, decision) {
    await rpc.call("areal/interaction/respond", {
      threadId: interaction.threadId,
      turnId: interaction.turnId,
      requestId: interaction.requestId,
      argumentsDigest: interaction.argumentsDigest,
      decision,
    });
  }
  const askId = await thread("ask");
  await mkdir(join(root, "one-operation"));
  const allowed = join(root, "one-operation/output.txt");
  const sameTurn = join(root, "one-operation/unrequested.txt");
  let turnId = await turn(askId, [
    command(`printf approved > '${allowed}'`, { permissionRequest: additional(allowed) }),
    command(`printf forbidden > '${sameTurn}'`),
  ]);
  const { interaction } = await rpc.waitEvent(
    "areal/interaction/requested",
    (params) => params.interaction.threadId === askId,
  );
  assert.equal(await exists(allowed), false, "no external side effect before approval");
  await answer(interaction, "allowOnce");
  await complete(askId, turnId);
  assert.equal(await readFile(allowed, "utf8"), "approved");
  assert.equal(
    await exists(sameTurn),
    false,
    "operation scope never widens another command in the same Turn",
  );
  const after = join(root, "unrequested-after-approval.txt");
  await complete(askId, await turn(askId, [command(`printf forbidden > '${after}'`)]));
  assert.equal(await exists(after), false, "one operation does not widen the next Turn");
  checks.push({ oneOperationGrant: true, followingTurnRestricted: true });

  const autoId = await thread("autoReview");
  await mkdir(join(root, "reviewed"));
  const reviewed = join(root, "reviewed/output.txt");
  const reviewStart = reviews.length;
  await complete(
    autoId,
    await turn(autoId, [
      command(`printf reviewed > '${reviewed}'`, { permissionRequest: additional(reviewed) }),
    ]),
  );
  assert.equal(await readFile(reviewed, "utf8"), "reviewed");
  assert.equal(
    reviews.length,
    reviewStart + 1,
    "automatic approval uses a separate reviewer request",
  );
  reviewDecision = "deny";
  await mkdir(join(root, "review-denied"));
  const denied = join(root, "review-denied/output.txt");
  await complete(
    autoId,
    await turn(autoId, [
      command(`printf forbidden > '${denied}'`, { permissionRequest: additional(denied) }),
    ]),
  );
  assert.equal(await exists(denied), false, "reviewer denial cannot execute the operation");
  reviewDecision = "malformed";
  await mkdir(join(root, "malformed-review"));
  const invalid = join(root, "malformed-review/output.txt");
  turnId = await turn(autoId, [
    command(`printf forbidden > '${invalid}'`, { permissionRequest: additional(invalid) }),
  ]);
  const fallback = (
    await rpc.waitEvent(
      "areal/interaction/requested",
      (params) => params.interaction.threadId === autoId && params.interaction.turnId === turnId,
    )
  ).interaction;
  assert.equal(await exists(invalid), false, "invalid reviewer output must not grant permissions");
  await answer(fallback, "deny");
  await complete(autoId, turnId);
  checks.push({ separateReviewer: true, denialBlocked: true, malformedReviewManualFallback: true });
  reviewDecision = "allow";
  const cancelId = await thread("autoReview");
  await mkdir(join(root, "cancelled-review"));
  const cancelledOutput = join(root, "cancelled-review/output.txt");
  holdNextReview = true;
  turnId = await turn(cancelId, [
    command(`printf forbidden > '${cancelledOutput}'`, {
      permissionRequest: additional(cancelledOutput),
    }),
  ]);
  for (let i = 0; i < 200 && !releaseReview; i++) await delay(10);
  assert.ok(releaseReview, "review is held before cancellation");
  await rpc.call("turn/interrupt", { threadId: cancelId, turnId });
  releaseReview();
  releaseReview = undefined;
  const cancelled = await rpc.waitEvent(
    "turn/completed",
    (params) => params.threadId === cancelId && params.turn.id === turnId,
  );
  assert.equal(cancelled.turn.status, "interrupted");
  assert.equal(
    await exists(cancelledOutput),
    false,
    "a late reviewer result cannot dispatch after cancellation",
  );
  checks.push({ cancelledReviewNoDispatch: true });

  for (const preset of ["ask", "autoReview", "fullAccess"]) {
    const id = await thread(preset);
    const before = requests.length;
    await complete(
      id,
      await turn(id, [
        command(`/usr/bin/curl -s --max-time 2 http://127.0.0.1:${fixture.address().port}/`),
      ]),
    );
    const resultText = JSON.stringify(
      requests
        .slice(before)
        .flatMap((body) => body.messages.filter((message) => message.role === "tool")),
    );
    assert.equal(
      resultText.includes("NETWORK_REACHED"),
      preset === "fullAccess",
      "command network follows the effective preset",
    );
  }
  checks.push({ commandNetworkBoundary: true });
  await stop();
  await start();
  const restored = await rpc.call("areal/thread/inspect", { threadId: autoId });
  assert.equal(restored.configuration.options.permissionPreset, "autoReview");
  checks.push({ coreRestartPreservesPreset: true });

  const queuedId = await thread("ask");
  holdNextSolve = true;
  const activeTurn = await turn(queuedId, []);
  for (let i = 0; i < 200 && !releaseHeld; i++) await delay(10);
  assert.ok(releaseHeld, "model fixture holds the active Turn before queue admission");
  const queuedOutside = join(root, "queued-outside.txt");
  const submitted = await rpc.call("areal/turn/enqueue", {
    requestId: randomUUID(),
    threadId: queuedId,
    expectedConfigRevision: 1,
    input: [
      { type: "text", text: JSON.stringify([command(`printf forbidden > '${queuedOutside}'`)]) },
    ],
  });
  const queue = await rpc.call("areal/queue/list", { threadId: queuedId });
  const queued = queue.items.find((item) => item.id === submitted.queueItemId);
  assert.equal(queued.configuration.options.permissionPreset, "ask");
  releaseHeld();
  releaseHeld = undefined;
  await complete(queuedId, activeTurn);
  const next = await rpc.waitEvent(
    "turn/completed",
    (params) => params.threadId === queuedId && params.turn.id !== activeTurn,
  );
  assert.equal(next.turn.configuration.options.permissionPreset, "ask");
  assert.equal(
    await exists(queuedOutside),
    false,
    "queued execution retains the restricted snapshot",
  );
  checks.push({ queueSnapshotRestricted: true });
  const parentId = await thread("ask");
  const childCalls = [
    { name: "fs_read", args: { path: "parent.txt" } },
    command('printf private-scratch > "$TMPDIR/child-proof.txt"; cat "$TMPDIR/child-proof.txt"'),
  ];
  await complete(
    parentId,
    await turn(parentId, [
      command("printf parent > parent.txt"),
      {
        name: "agent_spawn",
        args: { prompt: JSON.stringify(childCalls), intent: "inspect", delivery: "report" },
      },
      { name: "agent_wait", args: { executionId: "previousExecution", timeoutMs: 10000 } },
    ]),
  );
  const { data: children } = await rpc.call("areal/execution/list", { parentThreadId: parentId });
  assert.equal(children.length, 1);
  assert.equal(children[0].status, "completed");
  const childProofs = (await readdir(join(root, "scratch"), { recursive: true })).filter((path) =>
    path.endsWith("child-proof.txt"),
  );
  assert.equal(childProofs.length, 1);
  assert.equal(
    await readFile(join(root, "scratch", childProofs[0]), "utf8"),
    "private-scratch",
    "a child retains its own private scratch inside the inherited authority boundary",
  );
  checks.push({ restrictedChildPrivateScratch: true });

  // 新增模型用途也必须遵守同一请求容量；退避不挡健康请求，在途流仍占名额。
  await stop();
  await writeFile(config, "schema_version = 1\n[limits]\nmodel_concurrency = 1\n");
  await start();
  const retryId = await thread("autoReview");
  // 不共享源码租约，探针只判断 Engine 模型容量，不把工作区一致性等待算成容量阻塞。
  const healthyWorkspace = join(workspace, "healthy-workspace");
  await mkdir(healthyWorkspace);
  const healthyId = await thread("fullAccess", healthyWorkspace);
  const outside = join(root, "review-backoff/output.txt");
  await mkdir(dirname(outside), { recursive: true });
  retryReviewFailures = 1;
  retryReviewObserved = false;
  const reviewAt = reviews.length;
  const waitingReview = await turn(retryId, [
    command(`printf forbidden > '${outside}'`, { permissionRequest: additional(outside) }),
  ]);
  for (let i = 0; i < 500 && !retryReviewObserved; i++) await delay(10);
  assert.equal(retryReviewObserved, true, "the real HTTP reviewer entered retry backoff");
  const healthyStarted = new Promise((resolve) => {
    capacityFirstStarted = resolve;
  });
  capacityGate = new Promise((resolve) => {
    releaseCapacity = resolve;
  });
  const healthyTurn = (
    await rpc.call("turn/start", {
      threadId: healthyId,
      input: [{ type: "text", text: capacityFirstMarker }],
    })
  ).turn.id;
  const progressed = await Promise.race([
    healthyStarted.then(() => true),
    delay(900).then(() => false),
  ]);
  let secondHealthy;
  if (progressed) {
    const id = await thread("fullAccess", healthyWorkspace);
    secondHealthy = {
      id,
      turn: (
        await rpc.call("turn/start", {
          threadId: id,
          input: [{ type: "text", text: capacitySecondMarker }],
        })
      ).turn.id,
    };
    await delay(80);
  }
  const boundedWhileLive = !capacitySecondStarted;
  await rpc.call("turn/interrupt", { threadId: retryId, turnId: waitingReview });
  releaseCapacity();
  const interrupted = await rpc.waitEvent(
    "turn/completed",
    (params) => params.threadId === retryId && params.turn.id === waitingReview,
  );
  assert.equal(interrupted.turn.status, "interrupted");
  await complete(healthyId, healthyTurn);
  if (secondHealthy) await complete(secondHealthy.id, secondHealthy.turn);
  assert.equal(
    await exists(outside),
    false,
    "cancelled reviewer backoff cannot dispatch the operation",
  );
  assert.equal(reviews.length - reviewAt, 1, "cancellation prevents the next review HTTP attempt");
  checks.push({
    reviewBackoffReleasesCapacity: progressed,
    liveRequestLimitPreserved: boundedWhileLive,
    cancelledBackoffNoDispatch: true,
  });
  assert.equal(progressed, true, "review retry backoff retained the sole Engine model slot");
  assert.equal(boundedWhileLive, true, "an active response stream must retain its model slot");
  passed = true;
  console.log(JSON.stringify({ checks, reviews: reviews.length, evidence }, null, 2));
} finally {
  releaseHeld?.();
  releaseReview?.();
  releaseCapacity?.();
  await stop();
  fixture.closeAllConnections();
  await new Promise((resolve) => fixture.close(resolve));
  await writeFile(join(evidence, "model-requests.json"), JSON.stringify(requests, null, 2));
  await writeFile(join(evidence, "core.stderr.log"), diagnostics);
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify({ root, checks, reviews: reviews.length, cleaned: passed }, null, 2),
  );
  if (passed) await rm(root, { recursive: true, force: true });
}
