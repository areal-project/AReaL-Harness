import { respondToSessionName } from "./model-fixture.mjs";
// 真实模型协议、Core、私有 Runtime 与父工作区交付；脚本模型只验证编排契约。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "../examples/desktop-api/client.mjs";

const root = await mkdtemp(join(tmpdir(), "areal-unified-execution-"));
const evidence = process.env.AREAL_UNIFIED_EVIDENCE_DIR
  ? resolve(process.env.AREAL_UNIFIED_EVIDENCE_DIR)
  : root;
await mkdir(evidence, { recursive: true });
const diagnosticPath = join(evidence, "core-runtime.stderr.log");
const diagnosticLog = createWriteStream(diagnosticPath);
let failed = false;
const workspace = join(root, "workspace");
const data = join(root, "data");
await mkdir(workspace);
await writeFile(join(workspace, "preserved.txt"), "existing user content\n");
await writeFile(join(root, "config.toml"), "schema_version = 1\n[model]\nmax_retries=0\n");
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
let server,
  activeParent,
  modelFailure,
  modelRequests = 0;
const barrier = [];
const workers = new Set();
const recoveredFailures = new Set();
const finalRequests = new Map();
let observeCancellationWorker;
const cancellationWorker = new Promise((resolve) => (observeCancellationWorker = resolve));

function reply(response, name, args, text = "completed") {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const delta = name
    ? {
        tool_calls: [
          {
            index: 0,
            id: `call_${modelRequests}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      }
    : { content: text };
  response.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: name ? "tool_calls" : "stop" }] })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}
const model = createServer(async (request, response) => {
  try {
    let bytes = "";
    for await (const part of request) bytes += part;
    const input = JSON.parse(bytes);
    if (respondToSessionName(input, response)) return;
    modelRequests++;
    const userText = input.messages
      .filter(
        (message) =>
          message.role === "user" &&
          !(
            typeof message.content === "string" &&
            message.content.startsWith("AReaL runtime context (not a user request):")
          ),
      )
      .map((message) =>
        typeof message.content === "string" ? message.content : JSON.stringify(message.content),
      )
      .join("\n");
    const results = input.messages
      .filter((message) => message.role === "tool")
      .map((message) => JSON.parse(message.content));
    const worker = userText.match(/UNIFIED_WORKER:([ab])/);
    if (worker) {
      assert(!input.tools.some((tool) => tool.function.name === "workgroup_start"));
      if (results.length) {
        assert(results[0].sha256, JSON.stringify(results));
        if (results.length === 1) {
          assert(input.tools.some((tool) => tool.function.name === "agent_report"));
          assert(!input.tools.some((tool) => tool.function.name === "agent_spawn"));
          return reply(response, "agent_report", {
            summary: `candidate ${worker[1]} written`,
            evidence: [`${worker[1]}.txt`],
            remaining: ["independent integration verification"],
          });
        }
        assert.equal(results[1].recorded, true);
        if (results.length === 2) {
          return reply(response, "run_command", {
            argv: [
              "/usr/bin/python3",
              "-I",
              "-B",
              "-c",
              "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print('inherited-network-ok'); s.close()",
            ],
            timeoutMs: 5000,
          });
        }
        assert.equal(results.length, 3);
        assert.equal(results[2].exitCode, 0, JSON.stringify(results[2]));
        assert(results[2].stdout.includes("inherited-network-ok"));
        // 请求层重试已关闭，必须由同一 Engine 恢复；历史失败不得重启整个 worker。
        if (worker[1] === "a" && !recoveredFailures.has("a")) {
          recoveredFailures.add("a");
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "fixture temporary unavailable" } }));
          return;
        }
        return reply(
          response,
          null,
          null,
          "candidate ready; no trusted checks configured\n" + "交接证据。".repeat(1200),
        );
      }
      assert(!workers.has(worker[1]), "worker request was replayed");
      workers.add(worker[1]);
      barrier.push(() =>
        reply(response, "fs_create", { path: `${worker[1]}.txt`, text: `${worker[1]} result\n` }),
      );
      // 两个组都冻结同一父基线并到达 HTTP 边界，才放行任一写入。
      if (barrier.length === 2) barrier.splice(0).forEach((send) => send());
      return;
    }
    if (userText.includes("UNIFIED_CANCEL_WORKER")) {
      if (!results.length)
        return reply(response, "agent_report", {
          summary: "checkpoint before cancellation",
          evidence: ["no source writes"],
          remaining: ["integration not performed"],
        });
      assert.equal(results.length, 1, "cancelled response executed a stale tool");
      assert.equal(results[0].recorded, true);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "awaiting cancellation" }, finish_reason: null }] })}\n\n`,
      );
      observeCancellationWorker();
      return; // 持续流由取消关闭，禁止靠自然完成假装验证取消。
    }
    assert(input.tools.some((tool) => tool.function.name === "agent_spawn"));
    assert(!input.tools.some((tool) => tool.function.name === "workgroup_start"));
    if (userText.includes("UNIFIED_PARENT")) {
      if (results.length < 2) {
        const name = ["a", "b"][results.length];
        return reply(response, "agent_spawn", {
          prompt: `UNIFIED_WORKER:${name}`,
          intent: "modify",
          delivery: "changes",
          writes: [`${name}.txt`],
          independent: true,
        });
      }
      for (const result of results.slice(0, 2)) {
        assert(result.executionId, JSON.stringify(result));
        assert.equal(result.strategy, "isolated", JSON.stringify(result));
      }
      if (results.length < 4) {
        return reply(response, "agent_wait", {
          executionId: results[results.length - 2].executionId,
          timeoutMs: 10000,
        });
      }
      for (const result of results.slice(2, 4)) {
        assert.equal(result.status, "completed", JSON.stringify(result));
        assert.equal(result.delivery.status, "applied", JSON.stringify(result));
        assert.equal(result.verification.status, "notRun");
        assert.equal(result.delivery.verified, false);
        assert.equal(result.capabilities.sendInput, false);
        assert.equal(result.source, "message");
        assert(result.sourceItemId && result.text.includes("candidate ready"));
      }
      // 两个最终报告均跨页；父模型实际读取全部页后才允许完成。
      const cursor = results.length % 2;
      const initial = results[2 + cursor];
      const latest = [...results.slice(2)]
        .reverse()
        .find((result) => result.executionId === initial.executionId);
      if (latest.nextOffset != null)
        return reply(response, "agent_read", {
          executionId: latest.executionId,
          offset: latest.nextOffset,
        });
      const other = results[2 + (1 - cursor)];
      const otherLatest = [...results.slice(2)]
        .reverse()
        .find((result) => result.executionId === other.executionId);
      if (otherLatest.nextOffset != null)
        return reply(response, "agent_read", {
          executionId: otherLatest.executionId,
          offset: otherLatest.nextOffset,
        });
      finalRequests.set("normal", (finalRequests.get("normal") ?? 0) + 1);
      return reply(
        response,
        null,
        null,
        "both independent changes are applied; trusted verification not run",
      );
    }
    assert(userText.includes("UNIFIED_CANCEL_PARENT"), userText);
    if (!results.length)
      return reply(response, "agent_spawn", {
        prompt: "UNIFIED_CANCEL_WORKER",
        intent: "modify",
        delivery: "changes",
        writes: ["cancelled.txt"],
        independent: true,
      });
    const executionId = results[0].executionId;
    assert(executionId, JSON.stringify(results[0]));
    if (results.length === 1) {
      await Promise.race([
        cancellationWorker,
        delay(10000).then(() => {
          throw Error("cancellation worker never started");
        }),
      ]);
      // 等待已提交交接进入只读投影，避免用固定延迟掩盖竞态。
      const end = Date.now() + 10000;
      while (true) {
        const snapshot = await server.rpc.call("areal/execution/read", {
          parentThreadId: activeParent,
          executionId,
        });
        if (snapshot.text.includes("checkpoint before cancellation")) {
          const trace = await server.rpc.call("areal/execution/trace", {
            threadId: activeParent,
            executionId,
          });
          assert.equal(trace.stateConfirmed, true);
          assert(trace.activeTurn?.trace.activities.some((activity) => activity.kind === "model"));
          await writeFile(
            join(evidence, "running-worker-trace.json"),
            JSON.stringify(trace, null, 2),
          );
          break;
        }
        assert(Date.now() < end, "running isolated checkpoint was not exposed");
        await delay(10);
      }
      return reply(response, "agent_read", { executionId });
    }
    if (results.length === 2) {
      assert.equal(results[1].status, "running");
      assert.equal(results[1].source, "checkpoint");
      assert.equal(results[1].partial, true);
      assert.equal(results[1].capabilities.sendInput, false);
      return reply(response, "agent_send_input", { executionId, prompt: "changed contract" });
    }
    if (results.length === 3) {
      assert(results[2].error, "frozen isolated contracts must reject live steering");
      return reply(response, "agent_cancel", { executionId, mode: "force" });
    }
    if (results.length === 4)
      return reply(response, "agent_wait", { executionId, timeoutMs: 10000 });
    assert.equal(results[4].status, "cancelled", JSON.stringify(results[4]));
    assert.equal(results[4].resourcesReleased, true);
    assert.equal(results[4].delivery.status, "cancelled");
    assert.equal(results[4].source, "checkpoint");
    assert(results[4].text.includes("checkpoint before cancellation"));
    finalRequests.set("cancelled", (finalRequests.get("cancelled") ?? 0) + 1);
    reply(response, null, null, "cancelled and released without source writes");
  } catch (error) {
    modelFailure ??= error;
    response.destroy(error);
  }
});
model.listen(0, "127.0.0.1");
await once(model, "listening");

async function start() {
  const child = spawn(
    "python3",
    [
      "scripts/launch.py",
      "--config",
      join(root, "config.toml"),
      "--bin-dir",
      resolve(process.env.AREAL_UNIFIED_BIN_DIR ?? "target/debug"),
      "--listen",
      "127.0.0.1:0",
      "--data-dir",
      data,
      "--workspace",
      workspace,
      "--allow-write",
      "--allow-network",
      "--permissions",
      "yolo",
      "--model-endpoint",
      `http://127.0.0.1:${model.address().port}/`,
      "--model",
      "fixture",
      "--model-concurrency",
      "3",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: join(root, "user"),
        AREAL_HARNESS_HOME: join(root, "home"),
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
      },
    },
  );
  const exited = once(child, "exit");
  child.stdout.resume();
  let diagnostic = "";
  child.stderr.on("data", (chunk) => {
    diagnosticLog.write(chunk);
    diagnostic = (diagnostic + chunk).slice(-32768);
  });
  server = { child, exited, diagnostic: () => diagnostic };
  let endpoint;
  for (let attempt = 0; attempt < 300; attempt++) {
    endpoint = diagnostic.match(/ws:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (endpoint) break;
    assert.equal(child.exitCode, null, diagnostic);
    await delay(50);
  }
  assert(endpoint, `startup timeout: ${diagnostic}`);
  server.rpc = await connect(endpoint, join(data, "security/auth.json"));
  await server.rpc.call("areal/capabilities");
  return server;
}
async function stop() {
  if (!server) return;
  await server.rpc?.close();
  server.child.kill("SIGTERM");
  const timer = setTimeout(() => server.child.kill("SIGKILL"), 10000);
  const [code] = await server.exited;
  clearTimeout(timer);
  assert.equal(code, 0, server.diagnostic());
  server = undefined;
}
async function turn(prompt) {
  const { thread } = await server.rpc.call("thread/start");
  activeParent = thread.id;
  const { turn } = await server.rpc.call("turn/start", {
    threadId: thread.id,
    input: [{ type: "text", text: prompt }],
  });
  const event = await server.rpc.waitEvent(
    "turn/completed",
    (event) => event.threadId === thread.id && event.turn.id === turn.id,
  );
  assert.equal(modelFailure, undefined, modelFailure?.stack);
  assert.equal(event.turn.status, "completed", JSON.stringify(event));
  return thread.id;
}
try {
  await start();
  const parentThreadId = await turn("UNIFIED_PARENT");
  assert.equal(
    finalRequests.get("normal"),
    1,
    "already observed reports triggered another final answer",
  );
  const { data: executions } = await server.rpc.call("areal/execution/list", { parentThreadId });
  assert.equal(executions.length, 2);
  assert.equal(workers.size, 2);
  assert.equal(recoveredFailures.size, 1, "transient failure injection did not execute");
  assert.equal(await readFile(join(workspace, "preserved.txt"), "utf8"), "existing user content\n");
  assert(
    executions.some((execution) => execution.delivery.head !== execution.delivery.sourceHead),
    "second candidate was not composed onto the first delivery",
  );
  for (const execution of executions) {
    assert.equal(execution.status, "completed");
    assert.equal(execution.settled, true);
    assert.equal(execution.resourcesReleased, true);
    assert.equal(execution.verification.kind, "none");
    assert.equal(execution.verification.status, "notRun");
    assert.equal(execution.verification.head, execution.delivery.head);
    assert.equal(execution.delivery.status, "applied");
    const trace = await server.rpc.call("areal/execution/trace", {
      threadId: parentThreadId,
      executionId: execution.executionId,
    });
    assert.equal(trace.page.complete, true);
    assert.equal(trace.stateConfirmed, true);
    assert(trace.sources.length >= 1, "isolated execution has no trace source");
    assert(
      trace.page.data.some((entry) => entry.item?.type === "dynamicToolCall"),
      "isolated tools missing from durable trace",
    );
    assert(
      trace.page.data.some((entry) =>
        entry.turn?.trace?.activities?.some(
          (activity) => activity.kind === "model" && activity.durationMs != null,
        ),
      ),
      "isolated model timing missing",
    );
    assert(execution.elapsedMs > 0, "isolated lifecycle timing missing");
    await writeFile(
      join(evidence, `worker-trace-${execution.executionId}.json`),
      JSON.stringify(trace, null, 2),
    );
    const original = trace.page.data.find((entry) => entry.item?.execution?.resultSnapshot?.uri);
    if (original) {
      const result = await server.rpc.call("areal/execution/traceResult", {
        threadId: parentThreadId,
        executionId: execution.executionId,
        workerThreadId: trace.threadId,
        uri: original.item.execution.resultSnapshot.uri,
      });
      assert(result.bytes.length > 0, "saved worker original result is empty");
    }
    const artifact = await server.rpc.call("areal/execution/artifact", {
      parentThreadId,
      executionId: execution.executionId,
    });
    assert.equal(artifact.verified, false);
    const path = artifact.paths[0];
    assert.equal(await readFile(join(workspace, path), "utf8"), `${path[0]} result\n`);
    const journal = JSON.parse(
      await readFile(
        join(data, "executions", execution.artifact.workgroupId, "delivery.json"),
        "utf8",
      ),
    );
    assert.equal(journal.sourceHead, artifact.head);
    assert.equal(journal.head, execution.delivery.head);
    assert(journal.steps.length >= 2);
    assert(journal.steps.every((step) => step.state === "succeeded" && step.receipt));
  }
  const outsider = (await server.rpc.call("thread/start")).thread.id;
  for (const method of ["read", "artifact", "apply"])
    await assert.rejects(
      server.rpc.call(`areal/execution/${method}`, {
        parentThreadId: outsider,
        executionId: executions[0].executionId,
      }),
    );
  await assert.rejects(
    server.rpc.call("areal/execution/trace", {
      threadId: outsider,
      executionId: executions[0].executionId,
    }),
  );
  await assert.rejects(
    server.rpc.call("areal/execution/traceResult", {
      threadId: outsider,
      executionId: executions[0].executionId,
      workerThreadId: "foreign",
      uri: "areal://blob/foreign",
    }),
  );
  const callsBeforeRetry = modelRequests;
  await server.rpc.call("areal/execution/apply", {
    parentThreadId,
    executionId: executions[1].executionId,
  });
  assert.equal(modelRequests, callsBeforeRetry);
  console.log(
    "PASS unified agent_spawn/agent_wait: concurrent isolated candidates compose, Runtime receipts apply both files, no trusted-check claim, parent ownership enforced",
  );

  const cancelledParent = await turn("UNIFIED_CANCEL_PARENT");
  assert.equal(
    finalRequests.get("cancelled"),
    1,
    "already observed cancellation triggered another final answer",
  );
  const cancelled = (
    await server.rpc.call("areal/execution/list", { parentThreadId: cancelledParent })
  ).data[0];
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.resourcesReleased, true);
  await assert.rejects(access(join(workspace, "cancelled.txt")), { code: "ENOENT" });
  console.log(
    "PASS frozen-contract steering rejection and live-model cancellation settle private Runtime without applying files",
  );

  const beforeRestart = modelRequests;
  await stop();
  await start();
  const restored = (await server.rpc.call("areal/execution/list", { parentThreadId })).data;
  assert.equal(restored.length, 2);
  assert(
    restored.every(
      (execution) => execution.status === "completed" && execution.delivery.status === "applied",
    ),
  );
  for (const execution of restored) {
    const original = executions.find((before) => before.executionId === execution.executionId);
    assert.equal(execution.sourceItemId, original.sourceItemId);
    assert.equal(execution.text, original.text);
    const trace = await server.rpc.call("areal/execution/trace", {
      threadId: parentThreadId,
      executionId: execution.executionId,
    });
    assert.equal(trace.stateConfirmed, true);
    assert.equal(trace.activeTurn, null);
    assert(
      trace.page.data.some((entry) =>
        entry.turn?.trace?.activities?.some((activity) => activity.status === "completed"),
      ),
    );
  }
  await server.rpc.call("areal/execution/apply", {
    parentThreadId,
    executionId: executions[1].executionId,
  });
  assert.equal(modelRequests, beforeRestart, "restart or duplicate delivery replayed model work");
  await stop();
  console.log(
    "PASS restart preserves execution identity and durable delivery receipts without replay",
  );
} catch (error) {
  failed = true;
  console.error(`Full Core/Runtime diagnostics: ${diagnosticPath}`);
  console.error(modelFailure?.stack ?? error.stack);
  console.error(server?.diagnostic().slice(-3000) ?? "");
  throw error;
} finally {
  if (server) {
    await server.rpc?.close().catch(() => {});
    server.child.kill("SIGTERM");
    const child = server.child;
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    await server.exited;
    clearTimeout(timer);
  }
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  diagnosticLog.end();
  await finished(diagnosticLog);
  if (!failed) await rm(root, { recursive: true, force: true });
}
