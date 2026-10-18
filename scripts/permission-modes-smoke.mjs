// 真实 Core/Runtime：默认全开放、交互授权记忆、取消和只读边界。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../examples/desktop-api/client.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "areal-modes-"));
const workspace = join(root, "workspace");
await mkdir(workspace);
const config = join(root, "config.toml");
await writeFile(config, "schema_version = 1\n");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );
let results = [];
const model = createServer(async (req, res) => {
  if (req.method === "GET") return res.end("NETWORK_OK");
  let body = "";
  for await (const part of req) body += part;
  const messages = JSON.parse(body).messages;
  const index = messages.findLastIndex((m) => m.role === "user");
  let content = messages[index].content;
  if (Array.isArray(content))
    content = content
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");
  const calls = JSON.parse(content);
  results = messages
    .slice(index + 1)
    .filter((m) => m.role === "tool")
    .map((m) => JSON.parse(m.content));
  res.writeHead(200, { "content-type": "text/event-stream" });
  const event = (delta, finish_reason = null) =>
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (results.length < calls.length) {
    const call = calls[results.length];
    event({
      tool_calls: [
        {
          index: 0,
          id: `call_${results.length}`,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        },
      ],
    });
    event({}, "tool_calls");
  } else {
    event({ content: "done" });
    event({}, "stop");
  }
  res.end("data: [DONE]\n\n");
});
model.listen(0, "127.0.0.1");
await once(model, "listening");
let child, exited, rpc;
async function stop() {
  await rpc?.close();
  rpc = undefined;
  if (child) {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    await exited;
    clearTimeout(timer);
    child = undefined;
  }
}
async function start(mode) {
  let diagnostics = "";
  child = spawn(
    "python3",
    [
      "-I",
      "-S",
      join(repo, "scripts/launch.py"),
      "--bin-dir",
      join(repo, "target/debug"),
      "--workspace",
      workspace,
      "--data-dir",
      join(root, "data"),
      "--config",
      config,
      "--listen",
      "127.0.0.1:0",
      "--model",
      "fixture",
      "--model-endpoint",
      `http://127.0.0.1:${model.address().port}/`,
    ],
    {
      cwd: repo,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        AREAL_HARNESS_HOME: join(root, "home"),
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
        ...(mode ? { ASK_PERMISSIONS: "1" } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  exited = once(child, "exit");
  child.stderr.on("data", (chunk) => (diagnostics += chunk));
  let endpoint;
  for (let i = 0; i < 200; i++) {
    endpoint = diagnostics.match(/ws:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (endpoint) break;
    if (child.exitCode !== null) throw Error(diagnostics);
    await delay(50);
  }
  assert(endpoint, diagnostics);
  rpc = await connect(endpoint, join(root, "data/security/auth.json"));
  await rpc.call("areal/capabilities");
}
const command = (script, ...args) => ({
  name: "run_command",
  args: { argv: ["/bin/sh", "-c", script, "fixture", ...args], cwd: ".", timeoutMs: 4000 },
});
async function thread() {
  return (await rpc.call("thread/start")).thread.id;
}
async function turn(id, calls) {
  const { turn } = await rpc.call("turn/start", {
    threadId: id,
    input: [{ type: "text", text: JSON.stringify(calls) }],
  });
  return turn.id;
}
async function completed(id, turnId) {
  const result = await rpc.waitEvent(
    "turn/completed",
    (p) => p.threadId === id && p.turn.id === turnId,
  );
  assert.equal(result.turn.status, "completed", JSON.stringify(result));
}
async function approval(id) {
  return (await rpc.waitEvent("areal/interaction/requested", (p) => p.interaction.threadId === id))
    .interaction;
}
function answer(request, decision, digest = request.argumentsDigest) {
  return rpc.call("areal/interaction/respond", {
    threadId: request.threadId,
    turnId: request.turnId,
    requestId: request.requestId,
    argumentsDigest: digest,
    decision,
  });
}
try {
  await start(false);
  let id = await thread();
  const view = await rpc.call("areal/permissions/read", { threadId: id });
  assert.equal(view.configuration.mode, "YOLO");
  assert.equal(view.sandbox.type, "dangerFullAccess");
  assert.equal(view.sandbox.networkAccess, true);
  const hostFile = join(root, "outside.txt");
  const t = await turn(id, [
    command(
      'printf workspace > local.txt; printf host > "$1"; printf scratch > "$TMPDIR/probe"; /usr/bin/curl -s --max-time 2 "$2"',
      hostFile,
      `http://127.0.0.1:${model.address().port}/`,
    ),
    { name: "read_file", args: { path: hostFile } },
  ]);
  await completed(id, t);
  assert.equal(await readFile(join(workspace, "local.txt"), "utf8"), "workspace");
  assert.equal(await readFile(hostFile, "utf8"), "host");
  assert.match(JSON.stringify(results), /NETWORK_OK/);
  assert.match(JSON.stringify(results.at(-1)), /host/);
  assert.equal(
    rpc.events.some((e) => e.method === "areal/interaction/requested"),
    false,
  );
  assert.equal(await readFile(join(root, "scratch", `agent-${id}`, "probe"), "utf8"), "scratch");
  const cfg = await rpc.call("areal/thread/configure", {
    threadId: id,
    expectedRevision: 1,
    options: { readOnly: true },
  });
  assert(cfg);
  const readonly = await turn(id, [
    command('printf ok > "$TMPDIR/readonly"'),
    command("printf forbidden > readonly.txt"),
    command('printf forbidden > "$1"', join(root, "forbidden")),
  ]);
  await completed(id, readonly);
  assert.equal(await readFile(join(root, "scratch", `agent-${id}`, "readonly"), "utf8"), "ok");
  assert.equal(await exists(join(workspace, "readonly.txt")), false);
  assert.equal(await exists(join(root, "forbidden")), false);
  await stop();

  await start(true);
  id = await thread();
  const info = await rpc.call("areal/permissions/read", { threadId: id });
  assert.equal(info.configuration.mode, "ASK_PERMISSIONS");
  const exact = command("printf x >> remembered.txt");
  let tid = await turn(id, [exact]);
  let request = await approval(id);
  assert.equal(await exists(join(workspace, "remembered.txt")), false);
  await assert.rejects(answer(request, "allowSession", "invalid-digest"));
  assert.equal(await exists(join(workspace, "remembered.txt")), false);
  await answer(request, "allowSession");
  await completed(id, tid);
  tid = await turn(id, [exact]);
  await completed(id, tid);
  assert.equal(await readFile(join(workspace, "remembered.txt"), "utf8"), "xx");
  assert.equal((await rpc.call("areal/permissions/read", { threadId: id })).session.length, 1);
  // 修改参数不复用批准，拒绝不会提交命令。
  tid = await turn(id, [command("printf denied > denied.txt")]);
  request = await approval(id);
  await answer(request, "deny");
  await completed(id, tid);
  assert.equal(await exists(join(workspace, "denied.txt")), false);
  // 只读工作区访问自动放行，外部读取仍需询问。
  tid = await turn(id, [{ name: "read_file", args: { path: "local.txt" } }]);
  await completed(id, tid);
  tid = await turn(id, [{ name: "read_file", args: { path: hostFile } }]);
  request = await approval(id);
  await answer(request, "allowOnce");
  await completed(id, tid);
  tid = await turn(id, [{ name: "read_file", args: { path: hostFile } }]);
  request = await approval(id);
  await answer(request, "deny");
  await completed(id, tid);
  // 取消后的迟到批准不能执行；旧 digest 同样不能授权其他请求。
  tid = await turn(id, [command("printf cancelled > cancelled.txt")]);
  request = await approval(id);
  await rpc.call("turn/interrupt", { threadId: id, turnId: tid });
  await assert.rejects(answer(request, "allowOnce"));
  await rpc.waitEvent("turn/completed", (p) => p.threadId === id && p.turn.id === tid);
  assert.equal(await exists(join(workspace, "cancelled.txt")), false);
  const project = command("printf p >> project.txt");
  tid = await turn(id, [project]);
  request = await approval(id);
  await answer(request, "allowProject");
  await completed(id, tid);
  await stop();
  await start(true);
  id = await thread();
  tid = await turn(id, [project]);
  await completed(id, tid);
  assert.equal(await readFile(join(workspace, "project.txt"), "utf8"), "pp");
  await rpc.call("areal/permissions/forget", { threadId: id, project: true });
  tid = await turn(id, [project]);
  request = await approval(id);
  await answer(request, "deny");
  await completed(id, tid);
  await stop();
  // 全局显式 deny/ask 优先于 allow 和 YOLO；强制询问不能记住。
  await writeFile(
    config,
    'schema_version = 1\n[permissions]\nmode = "YOLO"\nallow = ["*"]\nask = ["read_file"]\ndeny = ["run_command"]\n',
  );
  await start(false);
  id = await thread();
  tid = await turn(id, [
    command("printf forbidden > global-deny.txt"),
    { name: "read_file", args: { path: "local.txt" } },
  ]);
  request = await approval(id);
  assert.equal(request.tool, "read_file");
  assert.equal(request.effectivePermissions.rememberAllowed, false);
  await assert.rejects(answer(request, "allowProject"));
  await answer(request, "allowOnce");
  await completed(id, tid);
  assert.equal(await exists(join(workspace, "global-deny.txt")), false);
  console.log(
    "PASS default YOLO host/workspace/network/scratch; ASK digest, once/session/project, restart, revocation, cancellation; read-only and global rules",
  );
} finally {
  await stop();
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  await rm(root, { recursive: true, force: true });
}
