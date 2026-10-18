import WebSocket from "ws";
// Real Core/Runtime permissions, using only local deterministic HTTP fixtures.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "areal-permissions-"));
const target = createServer((req, res) => res.end("NETWORK_FIXTURE_REACHABLE"));
target.listen(0, "127.0.0.1");
await once(target, "listening");
let toolResult;
const model = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  const results = request.messages.filter((m) => m.role === "tool");
  res.writeHead(200, { "content-type": "text/event-stream" });
  const event = (delta, finish_reason = null) => {
    res.write(
      "data: " + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + "\n\n",
    );
  };
  if (!results.length) {
    event({
      tool_calls: [
        {
          index: 0,
          id: "fixture_network",
          type: "function",
          function: {
            name: "run_command",
            arguments: JSON.stringify({
              argv: [
                "/bin/sh",
                "-c",
                `printf 'GET /marker HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n' | /usr/bin/nc -w 2 127.0.0.1 ${target.address().port}`,
              ],
              cwd: ".",
              timeoutMs: 4000,
            }),
          },
        },
      ],
    });
    event({}, "tool_calls");
  } else {
    toolResult = JSON.parse(results.at(-1).content);
    event({ content: "fixture complete" });
    event({}, "stop");
  }
  res.end("data: [DONE]\n\n");
});
model.listen(0, "127.0.0.1");
await once(model, "listening");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const observations = [];
try {
  for (const writable of [false, true])
    for (const allowNetwork of [false, true]) {
      const state = join(
        root,
        `${writable ? "write" : "read"}-${allowNetwork ? "allowed" : "denied"}`,
      );
      const workspace = join(state, "workspace");
      await mkdir(workspace, { recursive: true });
      const config = join(state, "config.toml");
      await writeFile(config, "schema_version = 1\n");
      const child = spawn(
        "python3",
        [
          "-I",
          "-S",
          join(repo, "scripts/launch.py"),
          "--bin-dir",
          join(repo, "target/debug"),
          "--sandbox-profile",
          "native",
          "--workspace",
          workspace,
          "--data-dir",
          join(state, "data"),
          "--config",
          config,
          "--listen",
          "127.0.0.1:0",
          "--model",
          "fixture",
          "--model-endpoint",
          `http://127.0.0.1:${model.address().port}/`,
          ...(writable ? ["--allow-write"] : []),
          ...(allowNetwork ? ["--allow-network"] : []),
        ],
        {
          cwd: repo,
          env: {
            PATH: process.env.PATH,
            HOME: state,
            AREAL_HARNESS_HOME: join(state, "home"),
            NO_PROXY: "127.0.0.1,localhost",
            no_proxy: "127.0.0.1,localhost",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let diagnostics = "",
        ws;
      child.stderr.on("data", (chunk) => (diagnostics += chunk));
      const exited = once(child, "exit");
      try {
        let endpoint;
        for (let i = 0; i < 150; i++) {
          endpoint = diagnostics.match(/ws:\/\/127\.0\.0\.1:\d+/)?.[0];
          if (endpoint) break;
          if (child.exitCode !== null) throw Error(diagnostics);
          await delay(100);
        }
        assert(endpoint, diagnostics);
        ws = new WebSocket(endpoint, {
          headers: {
            Authorization: `Bearer ${JSON.parse(await readFile(join(state, "data", "security/auth.json"), "utf8")).principals[0].token}`,
          },
        });
        await new Promise((resolve, reject) => {
          ws.onopen = resolve;
          ws.onerror = reject;
        });
        let next = 0;
        const pending = new Map();
        ws.onmessage = ({ data }) => {
          const message = JSON.parse(data),
            waiter = pending.get(message.id);
          if (!waiter) return;
          pending.delete(message.id);
          clearTimeout(waiter.timer);
          if (message.error) waiter.reject(Error(JSON.stringify(message.error)));
          else waiter.resolve(message.result);
        };
        const rpc = (method, params) =>
          new Promise((resolve, reject) => {
            const id = ++next;
            const timer = setTimeout(() => {
              pending.delete(id);
              reject(Error(method + " timed out"));
            }, 10000);
            pending.set(id, { resolve, reject, timer });
            ws.send(JSON.stringify({ id, method, params }));
          });
        await rpc("initialize", { clientInfo: { name: "permissions-smoke", version: "1" } });
        ws.send(JSON.stringify({ method: "initialized", params: {} }));
        const started = await rpc("thread/start", {});
        toolResult = undefined;
        await rpc("turn/start", {
          threadId: started.thread.id,
          input: [{ type: "text", text: "fixture" }],
        });
        let finished;
        for (let i = 0; i < 150; i++) {
          const { thread } = await rpc("thread/read", {
            threadId: started.thread.id,
            includeTurns: true,
          });
          if (thread.turns.at(-1).status !== "inProgress") {
            finished = thread;
            break;
          }
          await delay(100);
        }
        assert.equal(finished?.turns.at(-1).status, "completed", JSON.stringify(finished));
        observations.push({
          writable,
          allowNetwork,
          reportedSandbox: started.sandbox,
          exitCode: toolResult.exitCode,
        });
        assert.equal(started.sandbox.networkAccess, allowNetwork);
        assert.equal(started.sandbox.type, writable ? "workspaceWrite" : "readOnly");
        for (const method of ["thread/read", "thread/resume"]) {
          const result = await rpc(method, { threadId: started.thread.id });
          if (result.sandbox) assert.equal(result.sandbox.networkAccess, allowNetwork);
        }
        assert.equal(
          toolResult.stdout?.includes("NETWORK_FIXTURE_REACHABLE") ?? false,
          allowNetwork,
        );
      } finally {
        ws?.close();
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
        await exited;
        clearTimeout(timer);
      }
    }
  console.log(
    "PASS effective network grants and sandbox projections: " + JSON.stringify(observations),
  );
} finally {
  model.closeAllConnections();
  target.closeAllConnections();
  await Promise.all([
    new Promise((resolve) => model.close(resolve)),
    new Promise((resolve) => target.close(resolve)),
  ]);
  await rm(root, { recursive: true, force: true });
}
