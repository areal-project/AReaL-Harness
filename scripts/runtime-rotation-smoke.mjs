// 真实服务回归：容量预警、忙碌推迟、旧进程清理、原会话恢复与提交去重；仅使用本地模型。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { connect } from "../examples/desktop-api/client.mjs";
import { respondToSessionName } from "./model-fixture.mjs";
import { spawnNative } from "./native-child.mjs";

const binary = resolve(process.env.AREAL_TEST_BIN_DIR ?? "target/debug", "areal");
const results = [];
const exec = promisify(execFile);

async function runtimePid(hostPid) {
  const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,comm="]);
  const processes = stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [, pid, parent, name] = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      return { pid: Number(pid), parent: Number(parent), name };
    });
  const descendants = new Set([hostPid]);
  let size;
  do {
    size = descendants.size;
    for (const process of processes)
      if (descendants.has(process.parent)) descendants.add(process.pid);
  } while (size !== descendants.size);
  const runtimes = processes.filter(
    (process) => descendants.has(process.pid) && /(?:^|\/)areal-runtime$/.test(process.name),
  );
  assert.equal(runtimes.length, 1, "exactly one Runtime must belong to the service Host");
  return runtimes[0].pid;
}

async function until(check, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(25);
  }
  throw Error(`Timed out: ${label}`);
}

async function trial(kind, capacity) {
  const root = await realpath(await mkdtemp("/tmp/ar-"));
  const workspace = join(root, "repo");
  const config = join(root, "config.toml");
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("AREAL_") && !key.startsWith("OTEL_"),
      ),
    ),
    HOME: join(root, "user"),
    AREAL_HARNESS_HOME: join(root, "home"),
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    OTEL_SDK_DISABLED: "true",
  };
  const clients = [],
    calls = [],
    held = [];
  let service;
  const model = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    if (respondToSessionName(request, res)) return;
    const text = request.messages.findLast(
      (message) =>
        message.role === "user" &&
        !message.content?.startsWith?.("AReaL runtime context (not a user request):"),
    ).content;
    calls.push(text);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const finish = () =>
      res.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `reply:${text}` }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    if (text === "held-at-warning") held.push(finish);
    else finish();
  });
  model.listen(0, "127.0.0.1");
  await once(model, "listening");
  async function cli(args) {
    const child = spawnNative(binary, ["service", ...args, "--json"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (value) => {
      stdout += value;
    });
    child.stderr.on("data", (value) => {
      stderr += value;
    });
    const deadline = setTimeout(() => child.kill("SIGTERM"), 65000);
    try {
      const [code] = await once(child, "close");
      assert.equal(code, 0, stderr);
      return JSON.parse(stdout);
    } finally {
      clearTimeout(deadline);
    }
  }
  async function client(descriptor) {
    const result = await connect(descriptor.endpoint, descriptor.authFile);
    clients.push(result);
    return result;
  }
  try {
    await mkdir(workspace);
    await writeFile(
      join(workspace, "AGENTS.md"),
      "Use the local fixture and preserve previous turns.\n",
    );
    await writeFile(
      config,
      `schema_version = 1\n[model]\nname = "fixture"\n[model.providers.default]\nprotocol = "chat-completions"\nendpoint = "http://127.0.0.1:${model.address().port}"\n`,
    );
    const limits =
      kind === "outputBytes"
        ? ["--command-output-bytes", String(capacity), "--runtime-output-bytes", String(capacity)]
        : [`--runtime-max-${kind}`, String(capacity)];
    service = await cli(["ensure", "--workspace", workspace, "--config", config, ...limits]);
    const original = service,
      first = await client(service);
    const { thread } = await first.call("areal/thread/start", {
      requestId: randomUUID(),
      cwd: workspace,
    });
    const originalQueue = (
      await first.call("thread/read", { threadId: thread.id, includeTurns: true })
    ).thread.desktop.queue;
    for (let n = 0; n < 3; n++) {
      await first.call("areal/turn/start", {
        requestId: randomUUID(),
        threadId: thread.id,
        input: [{ type: "text", text: `before-${n}` }],
      });
      const done = await first.waitEvent("turn/completed", (value) => value.threadId === thread.id);
      assert.equal(done.turn.status, "completed");
    }
    const before = await first.call("areal/server/status");
    assert.equal(before.runtime.rotationRecommended, false);
    const request = {
      requestId: randomUUID(),
      threadId: thread.id,
      input: [{ type: "text", text: "held-at-warning" }],
    };
    const accepted = await first.call("areal/turn/start", request);
    await until(() => held.length === 1, "held model request");
    const busy = await first.call("areal/server/status");
    const oldRuntimePid = await runtimePid(original.hostPid);
    assert.equal(busy.runtime.rotationRecommended, true, JSON.stringify(busy.runtime));
    assert(busy.runtime[kind].used < busy.runtime[kind].limit, "warning must precede exhaustion");
    // 跨过两个生产维护周期，确认预警期间不会取消、关闭或替换仍在执行的轮次。
    for (let n = 0; n < 2; n++) {
      await delay(1100);
      const current = await cli(["status", "--instance", service.serviceId]);
      assert.equal(current.corePid, original.corePid);
      assert.equal((await first.call("areal/server/status")).draining, false);
      assert.equal(calls.length, 4);
    }
    const originalConfig = await readFile(config, "utf8");
    if (kind === "scopes") {
      // 非模型部署配置必须继续等待显式更新，容量维护不能顺便应用它。
      await writeFile(config, `${originalConfig}\n[limits]\nmax_threads = 20001\n`);
    }
    held.shift()();
    assert.equal(
      (await first.waitEvent("turn/completed", (value) => value.threadId === thread.id)).turn
        .status,
      "completed",
    );
    if (kind === "scopes") {
      for (let n = 0; n < 2; n++) {
        await delay(1100);
        assert.equal(
          (await cli(["status", "--instance", original.serviceId])).corePid,
          original.corePid,
        );
        assert.equal((await first.call("areal/server/status")).draining, false);
      }
      await writeFile(config, originalConfig);
    }
    service = await until(async () => {
      const next = await cli(["status", "--instance", original.serviceId]);
      return next.corePid !== original.corePid ? next : null;
    }, "safe capacity rotation");
    assert.equal(
      service.generation,
      original.generation,
      "the live Host keeps its generation and lease",
    );
    assert.equal(service.hostPid, original.hostPid);
    assert.equal(service.dataDir, original.dataDir);
    assert.throws(() => process.kill(original.corePid, 0), { code: "ESRCH" });
    assert.throws(() => process.kill(oldRuntimePid, 0), { code: "ESRCH" });
    const next = await client(service);
    const status = await next.call("areal/server/status");
    assert.notEqual(status.runtime.runtimeEpoch, busy.runtime.runtimeEpoch);
    assert.equal(status.runtime.rotationRecommended, false);
    assert(status.runtime[kind].used < busy.runtime[kind].used);
    let restored = (await next.call("thread/resume", { threadId: thread.id })).thread;
    assert.equal(restored.turns.length, 4);
    assert(restored.turns.every((turn) => turn.status === "completed"));
    assert.deepEqual(
      restored.desktop.queue,
      originalQueue,
      "maintenance must preserve queue intent and revision",
    );
    const replayed = await next.call("areal/turn/start", request);
    assert.equal(replayed.turn.id, accepted.turn.id);
    assert.equal(calls.length, 4, "accepted requests must not be replayed after rotation");
    await next.call("areal/turn/start", {
      requestId: randomUUID(),
      threadId: thread.id,
      input: [{ type: "text", text: "after-rotation" }],
    });
    assert.equal(
      (await next.waitEvent("turn/completed", (value) => value.threadId === thread.id)).turn.status,
      "completed",
    );
    restored = (await next.call("thread/read", { threadId: thread.id, includeTurns: true })).thread;
    assert.equal(restored.turns.length, 5);
    assert.equal(calls.length, 5);
    results.push({
      kind,
      capacity,
      warningUsed: busy.runtime[kind].used,
      afterRotationUsed: status.runtime[kind].used,
      historyTurns: restored.turns.length,
      oldCoreExited: true,
      oldRuntimeExited: true,
      deduplicated: true,
      deploymentDriftProtected: kind === "scopes",
    });
  } catch (error) {
    if (service) console.error((await readFile(service.logFile, "utf8")).slice(-8000));
    throw error;
  } finally {
    for (const finish of held) finish();
    for (const c of clients) await c.close();
    if (service)
      await cli([
        "stop",
        "--instance",
        service.serviceId,
        "--expected-generation",
        service.generation,
        "--cancel",
      ]);
    await new Promise((resolve) => model.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

await trial("scopes", 11);
await trial("operations", 20);
await trial("outputBytes", 1024);
console.log(JSON.stringify({ passed: true, results }, null, 2));
