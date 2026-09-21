import WebSocket from "ws";
// Real Core service, HTTP model transport, private Runtimes and verified artifacts.
// Scripted model output proves orchestration, not model quality or LLM throughput.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "areal-workgroup-smoke-"));
const workspace = join(root, "source");
await mkdir(workspace);
await writeFile(join(root, "config.toml"), "schema_version = 1\n");
await writeFile(
  join(workspace, "subprocess.py"),
  "raise AssertionError('untrusted launcher import')\n",
);
const policy = {
  allowedWrites: ["a.txt", "b.txt"],
  checks: [["/bin/sh", "-c", 'test "$(cat a.txt)" = a && test "$(cat b.txt)" = b']],
  workers: 2,
  verifiers: 1,
  activeGroups: 2,
  timeoutSeconds: 30,
  commandTimeoutMs: 7000,
  maxModelRequests: 8,
};
await writeFile(join(root, "policy.json"), JSON.stringify(policy));
let requests = 0,
  modelFailure;
const initial = [];
const model = createServer(async (request, response) => {
  try {
    let bytes = "";
    for await (const part of request) bytes += part;
    const input = JSON.parse(bytes);
    requests++;
    assert.equal(
      input.tools.find((t) => t.function.name === "run_command").function.parameters.properties
        .timeoutMs.maximum,
      7000,
    );
    assert(!input.tools.some((t) => t.function.name === "workgroup_start"));
    const worker = input.messages
      .findLast((m) => m.role === "user")
      .content.match(/WORKER:([ab])/)[1];
    const results = input.messages.filter((m) => m.role === "tool");
    const reply = () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const delta = results.length
        ? { content: "ready for independent verification" }
        : {
            tool_calls: [
              {
                index: 0,
                id: "create-" + worker,
                type: "function",
                function: {
                  name: "fs_create",
                  arguments: JSON.stringify({ path: worker + ".txt", text: worker }),
                },
              },
            ],
          };
      response.write(
        "data: " + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) + "\n\n",
      );
      response.write(
        "data: " +
          JSON.stringify({
            choices: [
              { index: 0, delta: {}, finish_reason: results.length ? "stop" : "tool_calls" },
            ],
          }) +
          "\n\n",
      );
      response.end("data: [DONE]\n\n");
    };
    if (results.length) {
      assert.equal(results.length, 1);
      assert(JSON.parse(results[0].content).sha256);
      reply();
    } else {
      initial.push(reply);
      // Both workers must reach the real HTTP boundary before either can finish.
      if (initial.length === 2) initial.forEach((send) => send());
    }
  } catch (error) {
    modelFailure = error;
    response.destroy(error);
  }
});
model.listen(0, "127.0.0.1");
await once(model, "listening");
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      !name.startsWith("AREAL_") && !["http_proxy", "https_proxy", "all_proxy"].includes(name),
  ),
);
const children = new Set(),
  sockets = new Set();
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
      join(root, "data"),
      "--workspace",
      workspace,
      "--allow-write",
      "--workgroup-policy",
      join(root, "policy.json"),
      "--model-endpoint",
      "http://127.0.0.1:" + model.address().port + "/",
      "--model",
      "fixture",
      "--model-concurrency",
      "2",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...environment,
        HOME: join(root, "user"),
        AREAL_HARNESS_HOME: join(root, "home"),
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
      },
    },
  );
  children.add(child);
  child.once("exit", () => children.delete(child));
  child.stdout.resume();
  let diagnostic = "";
  child.stderr.on("data", (chunk) => {
    diagnostic = (diagnostic + chunk).slice(-16384);
  });
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("startup timeout: " + diagnostic)), 15000);
    child.stderr.on("data", () => {
      const match = diagnostic.match(/ws:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(Error("startup failed: " + diagnostic));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  const socket = new WebSocket(endpoint, {
    headers: {
      Authorization: `Bearer ${JSON.parse(await readFile(join(root, "data", "security/auth.json"), "utf8")).principals[0].token}`,
    },
  });
  sockets.add(socket);
  await once(socket, "open");
  const pending = new Map();
  let next = 0;
  socket.onmessage = ({ data }) => {
    const value = JSON.parse(data),
      waiter = pending.get(value.id);
    if (!waiter) return;
    pending.delete(value.id);
    if (value.error) waiter.reject(Error(JSON.stringify(value.error)));
    else waiter.resolve(value.result);
  };
  socket.onclose = () => {
    for (const waiter of pending.values()) waiter.reject(Error("closed"));
    pending.clear();
  };
  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error("RPC timeout: " + method));
      }, 15000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  await call("initialize", { clientInfo: { name: "workgroup-smoke", version: "1" } });
  socket.send(JSON.stringify({ method: "initialized" }));
  return { child, socket, call };
}
async function stop(server) {
  server.socket.close();
  const exited = once(server.child, "exit");
  server.child.kill("SIGTERM");
  const [code] = await exited;
  assert.equal(code, 0);
}
try {
  let server = await start();
  assert.deepEqual(await server.call("areal/workgroup/policy", {}), {
    allowedDirectories: [],
    ...policy,
  });
  const request = {
    requestId: "native-service",
    workers: 2,
    admission: "auto",
    plan: {
      objective: "Implement two independent files against the agreed interface",
      tasks: ["a", "b"].map((id) => ({
        id,
        instruction: "WORKER:" + id,
        writes: [id + ".txt"],
        integrationDepends: id === "b" ? ["a"] : [],
      })),
    },
  };
  let view = await server.call("areal/workgroup/start", request);
  const id = view.id;
  assert.equal((await server.call("areal/workgroup/start", request)).id, id);
  while (view.record.status === "running")
    view = await server.call("areal/workgroup/wait", {
      id,
      afterRevision: view.record.revision,
      timeoutMs: 1000,
    });
  assert.equal(view.record.status, "completed", JSON.stringify(view.record));
  assert.equal(view.record.cleanupConfirmed, true);
  assert.equal(view.record.finalCheck.passed, true);
  assert.equal(view.record.peakWorkers, 2);
  assert(view.record.tasks.every((task) => task.status === "integrated"));
  assert.equal(requests, 4);
  assert.equal(modelFailure, undefined);
  for (const name of ["a", "b"]) {
    await assert.rejects(access(join(workspace, name + ".txt")), { code: "ENOENT" });
    assert.equal(await readFile(join(view.candidatePath, name + ".txt"), "utf8"), name);
  }
  await stop(server);
  server = await start();
  view = await server.call("areal/workgroup/start", request);
  assert.equal(view.id, id);
  assert.equal(view.record.status, "completed");
  assert.deepEqual((await server.call("areal/workgroup/artifact", { id })).paths, [
    "a.txt",
    "b.txt",
  ]);
  const artifact = await server.call("areal/workgroup/artifact", { id, path: "a.txt" });
  assert.equal(artifact.baseSha256, null);
  assert.equal(artifact.text, "a");
  assert.equal(Buffer.from(artifact.dataBase64, "base64").toString(), "a");
  assert.equal(requests, 4, "restart or retry replayed model work");
  await stop(server);
  console.log(
    "PASS native Workgroup service: two concurrent HTTP workers, private Runtimes, exact-version final gate, artifact broker, deployment timeout, restart and deduplication",
  );
} finally {
  for (const socket of sockets) socket.close();
  const settled = [...children].map((child) => {
    const done = once(child, "exit");
    child.kill("SIGTERM");
    return done;
  });
  await Promise.all(settled);
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  await rm(root, { recursive: true, force: true });
}
