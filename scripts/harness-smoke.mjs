import WebSocket from "ws";
// Real binaries and native sandbox, with a deterministic model HTTP fixture.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const runtimeArgs = process.argv.slice(2);
assert(
  runtimeArgs.length === 0 ||
    (runtimeArgs.length === 2 &&
      runtimeArgs[0] === "--sandbox-profile" &&
      ["native", "outer-container-perf"].includes(runtimeArgs[1])),
  "expected optional --sandbox-profile native|outer-container-perf",
);
const root = await mkdtemp(join(tmpdir(), "areal-harness-"));
const fixtureEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      !name.startsWith("AREAL_HARNESS_") &&
      !name.startsWith("AREAL_MODEL") &&
      name !== "AREAL_API_KEY",
  ),
);
const workspace = join(root, "workspace"),
  data = join(root, "data");
await mkdir(workspace);
await writeFile(join(workspace, "conflict-target"), "preserved");
await writeFile(join(workspace, "check.sh"), "test 1 -eq 2\n");
await writeFile(join(workspace, "AGENTS.md"), "Project rule: run check.sh after edits.\n");
await writeFile(join(workspace, "tool-hooks.sh"), await readFile("tests/fixtures/tool-hooks.sh"));
const extensionCommand = (mode) => ["/bin/sh", "./tool-hooks.sh", mode];
await writeFile(
  join(root, "tools.json"),
  JSON.stringify({
    policy: { commandWaitMs: 300000, readWaitMs: 300000 },
    tools: [
      {
        definition: {
          name: "fixture_echo",
          description: "Echo a fixture value",
          inputSchema: {
            type: "object",
            properties: { value: { type: "string" }, padding: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            properties: { echo: { const: "ok" } },
            required: ["echo"],
          },
        },
        argv: extensionCommand("echo"),
        timeoutMs: 5000,
      },
      {
        definition: {
          name: "fixture_failure",
          description: "Return an expected failure",
          inputSchema: { type: "object", additionalProperties: false },
        },
        argv: extensionCommand("failure"),
        timeoutMs: 5000,
      },
    ],
    mcpServers: {
      fixture: {
        transport: {
          type: "stdio",
          command: "python3",
          args: [resolve("tests/fixtures/mcp-server.py"), join(root, "mcp-calls.jsonl")],
        },
        enabledTools: ["echo"],
        callTimeoutMs: 300,
      },
    },
    hooks: [
      {
        name: "audit-mcp",
        event: "PostToolUse",
        matcher: "mcp__fixture__echo",
        argv: extensionCommand("post"),
        timeoutMs: 5000,
      },
      {
        name: "audit-mcp-failure",
        event: "PostToolUseFailure",
        matcher: "mcp__fixture__echo",
        argv: extensionCommand("post"),
        timeoutMs: 5000,
      },
      {
        name: "guard-echo",
        event: "PreToolUse",
        matcher: "fixture_echo",
        argv: extensionCommand("pre"),
        timeoutMs: 5000,
      },
      {
        name: "guard-write",
        event: "PreToolUse",
        matcher: "fs_write",
        argv: extensionCommand("pre"),
        timeoutMs: 5000,
      },
      {
        name: "audit-write-failure",
        event: "PostToolUseFailure",
        matcher: "fs_write",
        argv: extensionCommand("post"),
        timeoutMs: 5000,
      },
      {
        name: "audit-write",
        event: "PostToolUse",
        matcher: "fs_write",
        argv: extensionCommand("post"),
        timeoutMs: 60000,
      },
      {
        name: "audit-failure",
        event: "PostToolUseFailure",
        matcher: "fixture_failure",
        argv: extensionCommand("post"),
        timeoutMs: 5000,
      },
    ],
  }),
);
await writeFile(
  join(root, "config.toml"),
  'schema_version = 1\n[tools]\nextensions_file = "tools.json"\n',
);
const children = new Set(),
  sockets = new Set();
let modelCalls = 0,
  server;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const model = createServer(async (req, res) => {
  try {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    modelCalls++;
    assert(request.messages[0].role === "system");
    assert(request.messages[0].content.includes("Project rule: run check.sh after edits."));
    assert(request.tools.some((tool) => tool.function.name === "read_process"));
    assert.equal(request.parallel_tool_calls, true);
    const mode = request.messages.findLast((message) => message.role === "user").content;
    const results = request.messages.filter((message) => message.role === "tool");
    let name, args;
    if (mode === "delegate-files") {
      assert(request.tools.some((tool) => tool.function.name === "agent_spawn"));
      assert(!request.tools.some((tool) => tool.function.name === "workgroup_start"));
      if (results.length < 2) {
        name = "agent_spawn";
        args = { prompt: `child-file:${results.length}` };
      } else {
        const summary = request.messages.find(
          (message) =>
            typeof message.content === "string" &&
            message.content.startsWith("Settled child Agent results"),
        );
        if (summary) {
          const report = JSON.parse(summary.content.slice(summary.content.indexOf("{")));
          assert(report.settled > 0);
          assert.equal(report.settled + report.pending, 2);
          if (report.pending === 0) {
            assert.equal(await readFile(join(workspace, "child-0.txt"), "utf8"), "child 0");
            assert.equal(await readFile(join(workspace, "child-1.txt"), "utf8"), "child 1");
          }
        }
      }
    } else if (mode.startsWith("child-file:")) {
      if (!results.length) {
        const index = mode.slice("child-file:".length);
        name = "fs_create";
        args = { path: `child-${index}.txt`, text: `child ${index}` };
      } else if (results.length === 1) {
        name = "agent_report";
        args = {
          summary: "File created",
          evidence: [`child-${mode.slice("child-file:".length)}.txt`],
          remaining: [],
        };
      }
    } else if (mode === "create-only") {
      if (results.length < 2) {
        if (results.length === 1) assert(JSON.parse(results[0].content).sha256);
        name = "fs_create";
        args = { path: "./created.txt", text: results.length ? "must not overwrite" : "original" };
      } else {
        assert.equal(JSON.parse(results[1].content).error.code, "CONFLICT");
      }
    } else if (mode.startsWith("mcp:")) {
      const action = mode.slice(4);
      const definition = request.tools.find((t) => t.function.name === "mcp__fixture__echo");
      assert.equal(definition.function.parameters.properties.value.type, "string");
      if (!results.length) {
        name = "mcp__fixture__echo";
        args = { value: action === "invalid" ? 4 : action };
      } else {
        assert.equal(results.length, 1);
        assert(
          !["hang", "bad-output"].includes(action),
          "UNKNOWN MCP result must not reenter model",
        );
        assert(results[0].content.includes(action === "invalid" ? "INVALID_ARGUMENT" : action));
      }
    } else if (mode.startsWith("extension:")) {
      const action = mode.slice("extension:".length);
      if (results.length === 0) {
        if (action === "echo" || action === "echo-large") {
          name = "fixture_echo";
          args = { value: "ok" };
          if (action === "echo-large") args.padding = "x".repeat(60 * 1024);
        } else if (action === "failure") {
          name = "fixture_failure";
          args = {};
        } else {
          name = "fs_write";
          args = {
            path: action,
            text: "original",
            expectedSha256: action === "conflict-to-create" ? "a".repeat(64) : null,
          };
        }
      } else {
        assert.equal(results.length, 1);
        if (action === "echo" || action === "echo-large") {
          assert(results[0].content.includes("echo ok"));
          assert(results[0].content.includes('"echo":"ok"'));
        } else if (action === "failure") assert(results[0].content.includes("expected failure"));
        else if (action.startsWith("conflict-")) {
          const result = JSON.parse(results[0].content);
          assert.equal(result.error.code, "CONFLICT");
          assert.equal(
            typeof result.hint,
            action === "conflict-to-replace" ? "undefined" : "string",
          );
        } else if (action === "blocked") assert(results[0].content.includes("blockedByHook"));
        else if (action === "rewrite-invalid")
          assert(results[0].content.includes("INVALID_ARGUMENT"));
        else if (["post-fail", "post-crash"].includes(action))
          assert.fail("post-hook failure must not reenter model");
        else {
          assert(results[0].content.includes("sha256"));
          if (action === "rewrite")
            assert.equal(
              JSON.parse(
                request.messages.findLast((m) => m.tool_calls?.length).tool_calls[0].function
                  .arguments,
              ).path,
              "rewritten",
            );
        }
      }
    } else if (mode === "after-inspection") {
      assert(results.some((result) => result.content.includes("Operator inspection")));
    } else if (mode === "output-bounds") {
      if (results.length === 0) {
        name = "run_command";
        args = {
          argv: [
            "/bin/sh",
            "-c",
            "printf '\\344\\275'; /bin/sleep 0.02; printf '\\240\\345\\245\\275'; /usr/bin/head -c 7000 /dev/zero; printf '末尾' >&2",
          ],
          cwd: "workspace://repo",
          timeoutMs: 3000,
        };
      } else {
        const pages = results.map((item) => JSON.parse(item.content));
        const result = pages.at(-1);
        if (!result.outputClosed) {
          name = "read_process";
          args = { processId: result.processId };
        } else {
          const stdout = pages.map((page) => page.stdout ?? "").join("");
          const stderr = pages.map((page) => page.stderr ?? "").join("");
          assert(stdout.startsWith("你好"));
          assert.equal(Buffer.byteLength(stdout), 7006);
          assert.equal(stderr, "末尾");
          assert.equal(result.exitCode, 0);
          assert(pages.every((page) => !page.gap && !page.truncated));
          assert(pages.some((page) => page.returnReason === "outputLimit"));
          assert.equal(result.returnReason, "completed");
          assert(results.every((page) => Buffer.byteLength(page.content) <= 16384));
        }
      }
    } else if (mode === "process-wait") {
      if (results.length === 0) {
        name = "run_command";
        args = { argv: ["/bin/sleep", "2"], cwd: ".", timeoutMs: 5000 };
      } else {
        assert.equal(results.length, 1, "silent command needed an extra model poll");
        assert.equal(JSON.parse(results[0].content).exitCode, 0);
      }
    } else if (mode === "process-output-wait") {
      if (results.length === 0) {
        name = "run_command";
        args = {
          argv: ["/bin/sh", "-c", "sleep 0.1; printf ready; sleep 0.4"],
          cwd: ".",
          timeoutMs: 5000,
        };
      } else {
        assert.equal(results.length, 1, "early output caused an extra model poll");
        const result = JSON.parse(results[0].content);
        assert.equal(result.stdout, "ready");
        assert.equal(result.exitCode, 0);
        assert.equal(result.returnReason, "completed");
      }
    } else if (mode === "process-timeout") {
      if (results.length === 0) {
        name = "run_command";
        args = { argv: ["/bin/sleep", "60"], cwd: ".", timeoutMs: 200 };
      } else {
        assert.equal(results.length, 1);
        const result = JSON.parse(results[0].content);
        assert.equal(result.state, "exited");
        assert(result.stopReason);
      }
    } else if (mode === "process-interrupt") {
      assert.equal(results.length, 0, "cancelled wait must not reenter the model");
      name = "run_command";
      args = {
        argv: ["/bin/sh", "-c", "printf started > waiting; printf ready; exec /bin/sleep 60"],
        cwd: ".",
        timeoutMs: 60000,
      };
    } else if (mode === "process-session" || mode === "process-pty") {
      if (results.length === 0) {
        name = "run_command";
        args = {
          argv: ["/bin/sh", "-c", "printf ready; read answer; printf '<%s>' \"$answer\""],
          cwd: ".",
          timeoutMs: 60000,
          yieldMs: 0,
          tty: mode === "process-pty",
        };
      } else if (results.length === 1) {
        name = "write_process";
        args = { processId: JSON.parse(results[0].content).processId, text: "pong\n" };
      } else {
        const first = JSON.parse(results[0].content),
          last = JSON.parse(results.at(-1).content);
        if (results.length === 2 || !last.outputClosed) {
          name = "read_process";
          args = { processId: first.processId };
        } else {
          assert.equal(last.exitCode, 0);
          assert(
            results
              .map((result) => JSON.parse(result.content).stdout ?? "")
              .join("")
              .includes("<pong>"),
          );
        }
      }
    } else if (mode === "process-cancel") {
      if (results.length === 0) {
        name = "run_command";
        args = { argv: ["/bin/sleep", "60"], cwd: ".", timeoutMs: 60000, yieldMs: 0 };
      } else if (results.length === 1) {
        name = "terminate_process";
        args = { processId: JSON.parse(results[0].content).processId };
      } else {
        const result = JSON.parse(results.at(-1).content);
        assert.equal(result.state, "exited");
        assert(result.stopReason);
      }
    } else if (mode === "crash") {
      name = "run_command";
      args = {
        argv: [
          "/bin/sh",
          "-c",
          'printf started >> count; printf "%s" "$$" > leader; exec /bin/sleep 30',
        ],
        cwd: "workspace://repo",
        timeoutMs: 30000,
      };
    } else if (results.length === 0) {
      name = "fs_read";
      args = { path: "workspace://repo/check.sh" };
    } else if (results.length === 1) {
      name = "fs_apply_patch";
      args = {
        path: "workspace://repo/check.sh",
        oldText: "1 -eq 2",
        newText: "1 -eq 1",
        expectedSha256: JSON.parse(results[0].content).sha256,
      };
    } else if (results.length === 2) {
      name = "run_command";
      args = {
        argv: ["/bin/sh", "check.sh"],
        cwd: "workspace://repo",
        timeoutMs: 3000,
      };
    } else {
      assert.equal(JSON.parse(results.at(-1).content).exitCode, 0);
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const event = (delta, reason = null) =>
      res.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`,
      );
    if (name) {
      // Deliberately split the function name and JSON arguments across deltas.
      const text = JSON.stringify(args),
        mid = Math.floor(text.length / 2);
      event({
        tool_calls: [
          {
            index: 0,
            id: `call_${modelCalls}`,
            type: "function",
            function: { name: name.slice(0, 3), arguments: text.slice(0, mid) },
          },
        ],
      });
      event({
        tool_calls: [
          {
            index: 0,
            function: { name: name.slice(3), arguments: text.slice(mid) },
          },
        ],
      });
      event({}, "tool_calls");
    } else {
      event({ content: "Code fixed and test passed." });
      event({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  } catch (error) {
    res.destroy(error);
    console.error(error);
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
      "--listen",
      "127.0.0.1:0",
      "--data-dir",
      data,
      "--model-endpoint",
      `http://127.0.0.1:${model.address().port}/`,
      "--model",
      "fixture",
      "--workspace",
      workspace,
      "--allow-write",
      "--allow-concurrent-writes",
      ...runtimeArgs,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...fixtureEnv,
        HOME: join(root, "user"),
        AREAL_HARNESS_HOME: join(root, "home"),
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
      },
    },
  );
  children.add(child);
  child.once("exit", () => children.delete(child));
  let diagnostic = "";
  child.stderr.on("data", (chunk) => (diagnostic += chunk));
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`startup timeout: ${diagnostic}`)), 15000);
    child.stderr.on("data", () => {
      const url = diagnostic.match(/ws:\/\/127\.0\.0\.1:\d+/);
      if (url) {
        clearTimeout(timer);
        resolve(url[0]);
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(Error(`startup failed ${code}/${signal}: ${diagnostic}`));
    });
    child.once("error", reject);
  });
  const ws = new WebSocket(endpoint, {
    headers: {
      Authorization: `Bearer ${JSON.parse(await readFile(join(data, "security/auth.json"), "utf8")).principals[0].token}`,
    },
  });
  sockets.add(ws);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const pending = new Map(),
    events = [];
  let next = 0;
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id != null) {
      const reply = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reply.reject(Error(JSON.stringify(message.error)));
      else reply.resolve(message.result);
    } else events.push(message);
  };
  ws.onclose = () => {
    for (const waiter of pending.values()) waiter.reject(Error("closed"));
    pending.clear();
  };
  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error(`RPC timeout ${method}`));
      }, 15000);
      pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  await call("initialize", {
    clientInfo: { name: "harness-smoke", version: "1" },
  });
  ws.send(JSON.stringify({ method: "initialized", params: {} }));
  const corePid = Number(diagnostic.match(/AReaL launcher Core PID: (\d+)/)?.[1]);
  assert(corePid);
  return { child, corePid, call, events, ws };
}
async function completed(server, id) {
  for (let i = 0; i < 200; i++) {
    const { thread } = await server.call("thread/read", {
      threadId: id,
      includeTurns: true,
    });
    if (thread.turns.at(-1).status !== "inProgress") return thread;
    await wait(50);
  }
  throw Error("turn did not finish");
}
try {
  server = await start();
  const first = await server.call("thread/start", {});
  const id = first.thread.id;
  assert.equal(first.sandbox.type, "workspaceWrite");
  await server.call("turn/start", {
    threadId: id,
    input: [{ type: "text", text: "workflow" }],
  });
  const done = await completed(server, id);
  assert.equal(done.turns[0].status, "completed", JSON.stringify(done));
  assert.equal(await readFile(join(workspace, "check.sh"), "utf8"), "test 1 -eq 1\n");
  const tools = done.turns[0].items.filter((item) => item.type === "dynamicToolCall");
  assert.deepEqual(
    tools.map((item) => item.tool),
    ["fs_read", "fs_apply_patch", "run_command"],
  );
  assert(tools.every((item) => item.execution.outcome === "succeeded" && item.success));
  assert.equal(new Set(tools.map((item) => item.execution.operationId)).size, 3);
  assert.equal(new Set(tools.map((item) => item.execution.scopeId)).size, 1);
  assert.equal(
    server.events.filter(
      (event) => event.method === "item/completed" && event.params.item.type === "dynamicToolCall",
    ).length,
    3,
  );
  const stored = JSON.parse(await readFile(join(data, `${id}.json`), "utf8"));
  assert.equal(stored.version, 6);
  console.log("PASS model → read → patch → command → durable result");
  const created = (await server.call("thread/start", {})).thread.id;
  await server.call("turn/start", {
    threadId: created,
    input: [{ type: "text", text: "create-only" }],
  });
  assert.equal((await completed(server, created)).turns[0].status, "completed");
  assert.equal(await readFile(join(workspace, "created.txt"), "utf8"), "original");
  console.log("PASS relative fs_create conflicts without overwriting existing source");
  const delegation = (await server.call("thread/start", {})).thread.id;
  await server.call("turn/start", {
    threadId: delegation,
    input: [{ type: "text", text: "delegate-files" }],
  });
  const delegated = await completed(server, delegation);
  assert.equal(delegated.turns[0].status, "completed");
  const spawned = (await server.call("areal/agent/list", { parentThreadId: delegation })).data;
  assert.equal(spawned.length, 2);
  for (const agent of spawned) {
    const state = (await server.call("thread/read", { threadId: agent.id, includeTurns: true }))
      .thread;
    assert(
      state.turns[0].items.some(
        (item) =>
          item.type === "dynamicToolCall" && item.tool === "agent_report" && item.success === true,
      ),
    );
    assert.equal(state.turns[0].status, "completed");
    assert(
      state.turns[0].items.some(
        (item) => item.type === "dynamicToolCall" && item.tool === "fs_create" && item.success,
      ),
    );
  }
  assert.equal(await readFile(join(workspace, "child-0.txt"), "utf8"), "child 0");
  assert.equal(await readFile(join(workspace, "child-1.txt"), "utf8"), "child 1");
  console.log(
    "PASS default model delegation → two child Agents → shared workspace files → automatic join",
  );
  const bounded = (await server.call("thread/start", {})).thread.id;
  await server.call("turn/start", {
    threadId: bounded,
    input: [{ type: "text", text: "output-bounds" }],
  });
  assert.equal((await completed(server, bounded)).turns[0].status, "completed");
  console.log("PASS split UTF-8 and escaped output preserve bounded results and exit metadata");
  for (const mode of [
    "process-wait",
    "process-output-wait",
    "process-timeout",
    "process-session",
    "process-pty",
    "process-cancel",
  ]) {
    const before = modelCalls;
    const session = (await server.call("thread/start", {})).thread.id;
    await server.call("turn/start", { threadId: session, input: [{ type: "text", text: mode }] });
    const result = await completed(server, session);
    assert.equal(result.turns[0].status, "completed", JSON.stringify(result));
    if (["process-wait", "process-output-wait"].includes(mode))
      assert.equal(modelCalls - before, 2);
    console.log(`PASS managed ${mode}`);
  }
  const interrupted = (await server.call("thread/start", {})).thread.id;
  const { turn: waitingTurn } = await server.call("turn/start", {
    threadId: interrupted,
    input: [{ type: "text", text: "process-interrupt" }],
  });
  let waiting = false;
  for (let i = 0; i < 200; i++) {
    try {
      waiting = (await readFile(join(workspace, "waiting"), "utf8")) === "started";
    } catch {}
    if (waiting) break;
    await wait(20);
  }
  assert(waiting, "command never entered its managed wait");
  const callsBeforeInterrupt = modelCalls;
  await server.call("turn/interrupt", { threadId: interrupted, turnId: waitingTurn.id });
  const cancelled = await completed(server, interrupted);
  assert.equal(cancelled.turns[0].status, "failed");
  assert(cancelled.turns[0].items.some((item) => item.execution?.outcome === "unknown"));
  assert.equal(modelCalls, callsBeforeInterrupt);
  console.log("PASS interrupt automatic wait, preserve UNKNOWN and reclaim Turn scope");
  for (const action of [
    "echo",
    "echo-large",
    "failure",
    "blocked",
    "rewrite-invalid",
    "rewrite",
    "conflict-target",
    "conflict-to-create",
    "conflict-to-replace",
    "post-fail",
  ]) {
    const session = (await server.call("thread/start", {})).thread.id;
    await server.call("turn/start", {
      threadId: session,
      input: [{ type: "text", text: `extension:${action}` }],
    });
    const result = await completed(server, session);
    const item = result.turns[0].items.find((item) => item.type === "dynamicToolCall");
    assert.equal(
      result.turns[0].status,
      action === "post-fail" ? "failed" : "completed",
      JSON.stringify(result),
    );
    if (action === "echo" || action === "echo-large") {
      assert.equal(item.execution.backend, "command");
      assert(item.success);
    }
    if (action === "failure") {
      assert.equal(item.success, false);
      assert.equal(item.execution.hooks[0].event, "PostToolUseFailure");
    }
    if (action === "blocked" || action === "rewrite-invalid") {
      assert.equal(item.success, false);
      await assert.rejects(readFile(join(workspace, action)));
    }
    if (action === "rewrite") {
      assert.equal(await readFile(join(workspace, "rewritten"), "utf8"), "hook changed this");
      assert.equal(item.arguments.path, "rewrite");
      // 实际执行参数记录 hook 改写并规范化后的路径，原始模型参数仍保留在 arguments。
      assert.equal(item.execution.effectiveArguments.path, "workspace://repo/rewritten");
    }
    if (action.startsWith("conflict-")) {
      assert.equal(item.success, false);
      assert.equal(item.execution.hooks.at(-1).event, "PostToolUseFailure");
      assert.equal(await readFile(join(workspace, "conflict-target"), "utf8"), "preserved");
    }
    if (action === "post-fail") {
      assert.equal(await readFile(join(workspace, action), "utf8"), "original");
      assert.equal(item.success, true);
      assert.equal(item.execution.outcome, "succeeded");
      assert.equal(item.execution.hooks.at(-1).outcome, "unknown");
      await assert.rejects(
        server.call("turn/start", {
          threadId: session,
          input: [{ type: "text", text: "continue" }],
        }),
        /UNKNOWN/,
      );
    }
    console.log(`PASS custom tool/hooks ${action}`);
  }
  for (const action of ["ok", "failure", "invalid", "bad-output", "hang"]) {
    const session = (await server.call("thread/start", {})).thread.id;
    const callsBefore = modelCalls;
    await server.call("turn/start", {
      threadId: session,
      input: [{ type: "text", text: `mcp:${action}` }],
    });
    const result = await completed(server, session);
    const item = result.turns[0].items.find((item) => item.type === "dynamicToolCall");
    const unknown = ["bad-output", "hang"].includes(action);
    assert.equal(result.turns[0].status, unknown ? "failed" : "completed", JSON.stringify(result));
    assert.equal(item.execution.backend, "mcp");
    assert.equal(
      item.execution.outcome,
      unknown ? "unknown" : action === "ok" ? "succeeded" : "failed",
    );
    assert.equal(modelCalls - callsBefore, unknown ? 1 : 2);
    if (unknown)
      await assert.rejects(
        server.call("turn/start", {
          threadId: session,
          input: [{ type: "text", text: "continue" }],
        }),
        /UNKNOWN/,
      );
    if (action === "ok" || action === "failure")
      assert.equal(
        item.execution.hooks[0].event,
        action === "ok" ? "PostToolUse" : "PostToolUseFailure",
      );
    else assert.equal(item.execution.hooks?.length ?? 0, 0);
    console.log(`PASS MCP tool/schema/hooks ${action}`);
  }
  const mcpRecords = (await readFile(join(root, "mcp-calls.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(
    mcpRecords.filter((r) => r.method === "tools/call").length,
    4,
    "invalid arguments must not reach MCP",
  );
  assert(mcpRecords.some((r) => r.method === "notifications/cancelled"));
  const audit = await readFile(join(workspace, "hook-events"), "utf8");
  assert(audit.includes('"event":"PostToolUseFailure"'));
  assert(audit.includes('"path":"rewritten"'));
  const hookCrash = (await server.call("thread/start", {})).thread.id;
  await server.call("turn/start", {
    threadId: hookCrash,
    input: [{ type: "text", text: "extension:post-crash" }],
  });
  for (let i = 0; i < 200; i++) {
    try {
      if (await readFile(join(workspace, "hook-leader"), "utf8")) break;
    } catch {}
    await wait(20);
  }
  assert.equal(await readFile(join(workspace, "post-crash"), "utf8"), "original");
  assert.equal(await readFile(join(workspace, "hook-count"), "utf8"), "marker");
  const crash = (await server.call("thread/start", {})).thread.id;
  await server.call("turn/start", {
    threadId: crash,
    input: [{ type: "text", text: "crash" }],
  });
  let leader;
  for (let i = 0; i < 200; i++) {
    try {
      leader = Number(await readFile(join(workspace, "leader"), "utf8"));
      if (leader) break;
    } catch {}
    await wait(20);
  }
  assert(leader, "process never reached its side effect");
  const saved = JSON.parse(await readFile(join(data, `${crash}.json`), "utf8"));
  assert.equal(saved.thread.turns[0].items.at(-1).execution.outcome, "running");
  const killed = once(server.child, "exit");
  process.kill(server.corePid, "SIGKILL");
  await killed;
  server.ws.close();
  for (let i = 0; i < 200; i++) {
    try {
      process.kill(leader, 0);
    } catch {
      leader = null;
      break;
    }
    await wait(30);
  }
  assert.equal(leader, null, "managed process survived Core death and Runtime EOF cleanup");
  console.log("PASS Core death closes Runtime and managed process");
  const before = modelCalls;
  server = await start();
  const recoveredHook = (
    await server.call("thread/read", { threadId: hookCrash, includeTurns: true })
  ).thread;
  const hookItem = recoveredHook.turns[0].items.find((item) => item.type === "dynamicToolCall");
  assert.equal(recoveredHook.turns[0].status, "failed");
  assert.equal(hookItem.execution.outcome, "succeeded");
  assert.equal(hookItem.success, true);
  assert.equal(hookItem.execution.hooks.at(-1).outcome, "unknown");
  await assert.rejects(
    server.call("turn/start", { threadId: hookCrash, input: [{ type: "text", text: "continue" }] }),
    /UNKNOWN/,
  );
  assert.equal(await readFile(join(workspace, "hook-count"), "utf8"), "marker");
  console.log("PASS post-hook crash preserves the completed tool and prevents hook replay");
  const restored = (await server.call("thread/read", { threadId: crash, includeTurns: true }))
    .thread;
  assert.equal(restored.turns[0].status, "failed");
  const unknown = restored.turns[0].items.find((item) => item.type === "dynamicToolCall");
  assert.equal(unknown.execution.outcome, "unknown");
  await assert.rejects(
    server.call("turn/start", {
      threadId: crash,
      input: [{ type: "text", text: "continue" }],
    }),
    /UNKNOWN/,
  );
  assert.equal(modelCalls, before);
  assert.equal(await readFile(join(workspace, "count"), "utf8"), "started");
  await server.call("areal/tool/acknowledge", {
    threadId: crash,
    itemId: unknown.id,
    inspection:
      "Confirmed count contains one marker and the managed process exited; no replay needed.",
  });
  assert(
    (
      await server.call("thread/read", { threadId: crash, includeTurns: true })
    ).thread.turns[0].items.find((item) => item.id === unknown.id).execution.inspection,
  );
  await server.call("turn/start", {
    threadId: crash,
    input: [{ type: "text", text: "after-inspection" }],
  });
  const continued = await completed(server, crash);
  assert.equal(continued.turns.at(-1).status, "completed");
  assert.equal(
    continued.turns[0].items.find((item) => item.id === unknown.id).execution.outcome,
    "unknown",
  );
  assert.equal(await readFile(join(workspace, "count"), "utf8"), "started");
  const stopped = once(server.child, "exit");
  server.ws.close();
  server.child.kill("SIGTERM");
  assert.equal((await stopped)[0], 0);
  console.log(
    "PASS Harness: fragmented model tool calls → durable journal → Runtime read/patch/test → final answer; Core SIGKILL → process cleanup → UNKNOWN recovery → explicit inspection; no replay",
  );
} finally {
  for (const ws of sockets) ws.close();
  await Promise.all(
    [...children].map(async (child) => {
      const stopped = once(child, "exit");
      child.kill("SIGTERM");
      await stopped;
    }),
  );
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  await rm(root, { recursive: true, force: true });
}
