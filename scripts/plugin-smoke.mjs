import WebSocket from "ws";
// Real DSH package -> SDK -> Core -> Runtime -> native file sandbox.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = await mkdtemp(join(tmpdir(), "areal-plugins-"));
const workspace = join(root, "workspace"),
  data = join(root, "data");
await mkdir(join(workspace, "src"), { recursive: true });
await writeFile(join(workspace, "src/greeting.ts"), 'export const greeting = "Hello";\n');
await writeFile(join(workspace, "private.txt"), "must not reach plugin");
const policy = {
  trusted: true,
  readRoots: ["workspace://repo/src"],
  writeRoots: ["workspace://repo/src"],
  timeoutMs: 5000,
};
const plugins = {
  editor: {
    ...policy,
    argv: [process.execPath, resolve("core/sdk-typescript/examples/editor.mjs")],
  },
};
for (const mode of ["denied", "forged", "write_crash", "hang", "timeout", "environment"])
  plugins[mode] = {
    ...policy,
    timeoutMs: mode === "timeout" ? 300 : 5000,
    argv: [process.execPath, resolve("tests/fixtures/plugin-host.mjs"), mode],
  };
await writeFile(join(root, "tools.json"), JSON.stringify({ plugins }));
await writeFile(
  join(root, "config.toml"),
  'schema_version = 1\n[tools]\nextensions_file = "tools.json"\n',
);
let modelError,
  child,
  ws,
  next = 0;
const pending = new Map();
const model = createServer(async (request, response) => {
  try {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    const mode = input.messages.findLast((m) => m.role === "user").content;
    const results = input.messages.filter((m) => m.role === "tool");
    const editor = input.tools.find((t) => t.function.name === "str_replace_editor");
    assert.deepEqual(editor.function.parameters.properties.command.enum, ["view", "str_replace"]);
    let tool, args;
    if (mode === "edit" && results.length < 2) {
      tool = "str_replace_editor";
      args =
        results.length === 0
          ? { command: "view", path: "/repo/src/greeting.ts" }
          : {
              command: "str_replace",
              path: "/repo/src/greeting.ts",
              old_str: "Hello",
              new_str: "你好",
            };
    } else if (mode === "unobserved" && results.length === 0) {
      tool = "str_replace_editor";
      args = {
        command: "str_replace",
        path: "/repo/src/greeting.ts",
        old_str: "你好",
        new_str: "bad",
      };
    } else if (mode === "unsupported" && results.length === 0) {
      tool = "str_replace_editor";
      args = { command: "create", path: "/repo/src/new.ts", file_text: "bad" };
    } else if (mode === "out_of_scope" && results.length === 0) {
      tool = "str_replace_editor";
      args = { command: "view", path: "/repo/private.txt" };
    } else if (
      !["edit", "unobserved", "unsupported", "out_of_scope"].includes(mode) &&
      results.length === 0
    ) {
      tool = `fixture_${mode}`;
      args = {};
    } else {
      assert(
        !["forged", "write_crash", "hang", "timeout"].includes(mode),
        "UNKNOWN call reentered model",
      );
      if (mode === "edit") {
        assert.match(results[0].content, /Hello/);
        assert.match(results[1].content, /edited/);
      }
      if (mode === "unobserved")
        assert.match(results.at(-1).content, /Read the file before editing/);
      if (mode === "unsupported") assert.match(results.at(-1).content, /INVALID_ARGUMENT/);
      if (mode === "denied") assert.match(results.at(-1).content, /PERMISSION_DENIED/);
      if (mode === "environment") assert.equal(results.at(-1).content, 'clean\n"clean"');
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (delta, finish_reason) =>
      response.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    if (tool) {
      emit(
        {
          tool_calls: [
            {
              index: 0,
              id: `call_${++next}`,
              type: "function",
              function: { name: tool, arguments: JSON.stringify(args) },
            },
          ],
        },
        null,
      );
      emit({}, "tool_calls");
    } else {
      emit({ content: "done" }, null);
      emit({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  } catch (error) {
    modelError = error;
    response.destroy(error);
  }
});

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`RPC timeout: ${method}`));
    }, 15000);
    pending.set(id, {
      resolve(value) {
        clearTimeout(timer);
        resolve(value);
      },
      reject(error) {
        clearTimeout(timer);
        reject(error);
      },
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function startTurn(mode) {
  const { thread } = await rpc("thread/start", {});
  const { turn } = await rpc("turn/start", {
    threadId: thread.id,
    input: [{ type: "text", text: mode }],
  });
  return { threadId: thread.id, turnId: turn.id };
}
async function readThread(threadId) {
  return (await rpc("thread/read", { threadId, includeTurns: true })).thread;
}
async function complete(threadId) {
  for (let i = 0; i < 300; i++) {
    if (modelError) throw modelError;
    const thread = await readThread(threadId);
    if (thread.turns.at(-1).status !== "inProgress") return thread;
    await delay(30);
  }
  throw new Error("plugin turn did not complete");
}

try {
  model.listen(0, "127.0.0.1");
  await once(model, "listening");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("AREAL_")),
  );
  child = spawn(
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
      "plugin-fixture",
      "--workspace",
      workspace,
      "--allow-write",
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...env,
        HOME: join(root, "user"),
        AREAL_HARNESS_HOME: join(root, "home"),
        AREAL_PLUGIN_TEST_SECRET: "must not be inherited",
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
      },
    },
  );
  let diagnostics = "";
  child.stderr.on("data", (chunk) => (diagnostics += chunk));
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`startup timeout: ${diagnostics}`)), 15000);
    child.stderr.on("data", () => {
      const match = diagnostics.match(/ws:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Core exited (${code}/${signal}): ${diagnostics}`));
    });
    child.once("error", reject);
  });
  ws = new WebSocket(endpoint, {
    headers: {
      Authorization: `Bearer ${JSON.parse(await readFile(join(data, "security/auth.json"), "utf8")).principals[0].token}`,
    },
  });
  await once(ws, "open");
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      message.error
        ? waiter.reject(new Error(JSON.stringify(message.error)))
        : waiter.resolve(message.result);
    }
  };
  await rpc("initialize", { clientInfo: { name: "plugin-smoke", version: "1" } });
  ws.send(JSON.stringify({ method: "initialized", params: {} }));
  const edit = await startTurn("edit");
  const finished = await complete(edit.threadId);
  assert.equal(finished.turns[0].status, "completed", JSON.stringify(finished));
  assert.equal(
    await readFile(join(workspace, "src/greeting.ts"), "utf8"),
    'export const greeting = "你好";\n',
  );
  const items = finished.turns[0].items.filter((i) => i.type === "dynamicToolCall");
  assert.equal(items.length, 2);
  for (const item of items) {
    assert.equal(item.execution.backend, "plugin");
    assert.equal(item.execution.plugin.pluginId, "editor");
    assert.notEqual(item.execution.scopeId, item.execution.plugin.scopeId);
    assert(item.execution.plugin.operations.every((o) => o.outcome === "succeeded"));
  }
  assert.equal(items[1].execution.plugin.operations.at(-1).kind, "write");
  const stored = JSON.parse(await readFile(join(data, `${edit.threadId}.json`), "utf8"));
  assert.equal(stored.version, 6);
  assert(
    stored.thread.turns[0].items.some((i) =>
      i.execution?.plugin?.operations.some((o) => o.kind === "write" && o.outcome === "succeeded"),
    ),
  );
  for (const mode of ["unobserved", "unsupported", "out_of_scope", "denied", "environment"]) {
    const { threadId } = await startTurn(mode);
    const thread = await complete(threadId);
    assert.equal(thread.turns[0].status, "completed", JSON.stringify(thread));
    const item = thread.turns[0].items.find((i) => i.type === "dynamicToolCall");
    assert.equal(item.success, mode === "environment", `${mode}: ${JSON.stringify(item)}`);
  }
  for (const mode of ["forged", "write_crash", "timeout"]) {
    const { threadId } = await startTurn(mode);
    const thread = await complete(threadId);
    const item = thread.turns[0].items.find((i) => i.type === "dynamicToolCall");
    assert.equal(item.execution.outcome, "unknown", JSON.stringify(item));
    if (mode === "write_crash") {
      assert.equal(item.execution.plugin.operations.at(-1).outcome, "succeeded");
      assert.equal(
        await readFile(join(workspace, "src/unknown.txt"), "utf8"),
        "committed before Host crash",
      );
    }
    await assert.rejects(
      rpc("turn/start", { threadId, input: [{ type: "text", text: "do not replay" }] }),
    );
    const retry = await startTurn(mode);
    const retried = (await complete(retry.threadId)).turns[0].items.find(
      (i) => i.type === "dynamicToolCall",
    );
    assert.equal(retried.execution.outcome, "unknown");
    assert.match(retried.contentItems[0].text, /Host closed|generation is closed/);
  }
  const hang = await startTurn("hang");
  for (let i = 0; i < 100; i++) {
    const thread = await readThread(hang.threadId);
    if (thread.turns[0].items.some((i) => i.execution?.plugin)) break;
    await delay(20);
  }
  await rpc("turn/interrupt", hang);
  assert.notEqual((await complete(hang.threadId)).turns[0].status, "inProgress");
  if (modelError) throw modelError;
  const exit = once(child, "exit");
  child.kill("SIGTERM");
  const [code] = await exit;
  assert.equal(code, 0, diagnostics);
  console.log(
    "PASS real DSH plugin/Core/Runtime: read/edit, nested journal, schema/path/service bounds, session isolation, sanitized environment, forged identity, committed write + Host crash, UNKNOWN, timeout, generation closure and cancellation cleanup",
  );
} finally {
  ws?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    const exit = once(child, "exit");
    child.kill("SIGTERM");
    await Promise.race([exit, delay(15000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  await rm(root, { recursive: true, force: true });
}
