// 实际 Core/Runtime、脚本模型、公开 schema 和重启持久化验收。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "../examples/desktop-api/client.mjs";
import { rsiModel } from "../tests/fixtures/rsi-model.mjs";
const root = await mkdtemp(join(tmpdir(), "areal-rsi-smoke-"));
const evidence = resolve(process.env.AREAL_RSI_EVIDENCE_DIR ?? root);
await mkdir(evidence, { recursive: true });
const workspace = join(root, "workspace"),
  data = join(root, "data");
await mkdir(workspace);
await writeFile(join(workspace, "input.txt"), "preserved input\n");
await writeFile(join(root, "config.toml"), "schema_version=1\n");
const model = await rsiModel();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let current;
async function start() {
  const child = spawn(
    "/usr/bin/python3",
    [
      "scripts/launch.py",
      "--config",
      join(root, "config.toml"),
      "--bin-dir",
      resolve("target/debug"),
      "--listen",
      "127.0.0.1:0",
      "--data-dir",
      data,
      "--workspace",
      workspace,
      "--allow-write",
      "--permissions",
      "yolo",
      "--model-endpoint",
      model.endpoint,
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
    diagnostic += chunk;
  });
  current = { child, exited, diagnostic: () => diagnostic };
  for (let i = 0; i < 300; i++) {
    const endpoint = diagnostic.match(/ws:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (endpoint) {
      current.endpoint = endpoint;
      current.rpc = await connect(endpoint, join(data, "security/auth.json"));
      return;
    }
    assert.equal(child.exitCode, null, diagnostic);
    await delay(50);
  }
  throw Error(`startup timeout: ${diagnostic}`);
}
async function stop() {
  if (!current) return;
  await current.rpc?.close();
  current.child.kill("SIGTERM");
  const timer = setTimeout(() => current.child.kill("SIGKILL"), 10000);
  const [code] = await current.exited;
  clearTimeout(timer);
  await writeFile(join(evidence, "core-runtime.stderr.log"), current.diagnostic());
  assert.equal(code, 0, current.diagnostic());
  current = null;
}
async function ready(threadId) {
  for (let i = 0; i < 500; i++) {
    const view = await current.rpc.call("areal/goal/get", { threadId });
    if (view.goal.rsi.phase !== "running") return view;
    await delay(50);
  }
  throw Error("RSI candidates did not settle");
}
try {
  await start();
  const caps = await current.rpc.call("areal/capabilities");
  assert(caps.methods.includes("areal/goal/selectCandidate"));
  const { thread } = await current.rpc.call("thread/start");
  const request = {
    threadId: thread.id,
    requestId: "rsi-create",
    expectedRevision: 0,
    objective: "Compare candidate artifacts",
    workflow: "rsiArtifact",
  };
  const first = await current.rpc.call("areal/goal/create", request);
  assert.equal(first.goal.rsi.candidates.length, 3);
  assert.deepEqual(await current.rpc.call("areal/goal/create", request), first);
  const view = await ready(thread.id);
  assert.equal(view.goal.rsi.phase, "awaitingSelection", JSON.stringify(view));
  assert.deepEqual(
    view.goal.rsi.candidates.map((c) => c.status),
    ["completed", "failed", "completed"],
  );
  assert.equal(model.groups.get(view.goal.id).starts.length, 3);
  const roots = new Set(view.goal.rsi.candidates.map((c) => c.workspacePath).filter(Boolean));
  assert.equal(roots.size, 3);
  const isolation = [];
  for (const candidate of view.goal.rsi.candidates) {
    assert.equal(candidate.workspaceMode, "isolatedWrite");
    const runRoot = join(data, "executions", candidate.runId);
    const record = JSON.parse(await readFile(join(runRoot, "run.json"), "utf8"));
    assert.equal(record.cleanupConfirmed, true);
    const bindingRoot = join(runRoot, "bindings", `${candidate.taskId}-1-0`);
    const binding = JSON.parse(await readFile(join(bindingRoot, "binding.json"), "utf8"));
    assert(binding.runtimeEpoch && binding.rootScopeId && binding.workspace);
    assert.equal(binding.base, binding.initial);
    const history = JSON.parse(
      await readFile(join(bindingRoot, "history", `${binding.threadId}.json`), "utf8"),
    );
    const tool = history.thread.turns
      .flatMap((t) => t.items)
      .find((i) => i.type === "dynamicToolCall");
    assert.equal(tool.execution.backend, "runtime");
    assert.equal(tool.execution.outcome, candidate.status === "failed" ? "failed" : "succeeded");
    isolation.push({
      candidateId: candidate.id,
      binding,
      cleanupConfirmed: record.cleanupConfirmed,
      outputPath: tool.execution.effectiveArguments.path,
      toolOutcome: tool.execution.outcome,
      diagnostic: tool.success === false ? tool.contentItems : undefined,
    });
    await assert.rejects(
      access(join(binding.workspace, "rsi-artifacts", view.goal.id, "candidate-1", "forbidden.md")),
    );
    if (candidate.status === "failed") continue;
    const result = await current.rpc.call("areal/goal/candidateArtifact", {
      threadId: thread.id,
      goalId: view.goal.id,
      candidateId: candidate.id,
    });
    assert(Buffer.from(result.dataBase64, "base64").toString().includes("RSI_NATIVE_ARTIFACT_OK"));
    assert(result.bytes > 4096 && !result.complete);
    await assert.rejects(
      access(
        join(candidate.workspacePath, "rsi-artifacts", view.goal.id, "candidate-1", "forbidden.md"),
      ),
    );
  }
  assert.equal(new Set(isolation.map((i) => i.binding.runtimeEpoch)).size, 3);
  assert.equal(new Set(isolation.map((i) => i.binding.workspace)).size, 3);
  assert.equal(new Set(isolation.map((i) => i.binding.base)).size, 1);
  await assert.rejects(access(join(workspace, "rsi-artifacts")));
  const selection = {
    requestId: "select",
    threadId: thread.id,
    goalId: view.goal.id,
    expectedRevision: view.revision,
    candidateId: "candidate-3",
  };
  const winner = await current.rpc.call("areal/goal/selectCandidate", selection);
  assert.equal(winner.goal.rsi.selectedCandidateId, "candidate-3");
  assert.deepEqual(await current.rpc.call("areal/goal/selectCandidate", selection), winner);
  await assert.rejects(
    current.rpc.call("areal/goal/selectCandidate", {
      ...selection,
      requestId: "stale",
      candidateId: "candidate-1",
    }),
  );
  assert.deepEqual(
    await current.rpc.call("areal/goal/selectCandidate", {
      ...selection,
      requestId: "same",
      expectedRevision: winner.revision,
    }),
    winner,
  );
  await stop();
  await start();
  const restored = await current.rpc.call("areal/goal/get", { threadId: thread.id });
  assert.deepEqual(restored.goal.rsi, winner.goal.rsi);
  assert.equal(model.groups.get(view.goal.id).starts.length, 3);
  // 真实终端客户端只读取已选结果，确认状态与分页命令能跨过传输边界。
  const tui = spawn(
    "/usr/bin/python3",
    [
      "-c",
      `
import os, pty, subprocess, fcntl, termios, struct, select, time, sys, re
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 160, 240, 0, 0))
env = os.environ.copy(); env["TERM"] = "xterm-256color"
p = subprocess.Popen([sys.argv[1], "--endpoint", sys.argv[2], "--auth-file", sys.argv[3], "--resume", sys.argv[4], "--no-logo", "--ascii", "--mouse=false"], stdin=slave, stdout=slave, stderr=slave, env=env)
os.close(slave); chunks=[]
def collect(seconds):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if select.select([master], [], [], .1)[0]:
            try: chunks.append(os.read(master, 65536))
            except OSError: break
try:
    collect(3)
    os.write(master, b"/rsi-refresh\\r"); collect(1)
    os.write(master, b"/rsi-artifact candidate-3\\r"); collect(2)
    os.write(master, b"/tasks\\r"); collect(1)
    text = b"".join(chunks).decode("utf-8", errors="replace")
    text = re.sub(r"\\x1b\\[[0-?]*[ -/]*[@-~]", "", text)
    with open(sys.argv[5], "w") as out: out.write(text)
    compact = re.sub(r"\\s+", "", text)
    assert "RSI" in text and "Selected" in text and "critic-and-revise" in text
    assert "Winner:candidate-3" in compact
    assert "Next page:" in text and "4096" in text
    os.write(master, bytes([17])); collect(1)
    assert p.wait(timeout=10) == 0
finally:
    if p.poll() is None: p.terminate(); p.wait(timeout=10)
    os.close(master)
`,
      resolve("target/debug/areal"),
      current.endpoint,
      join(data, "security/auth.json"),
      thread.id,
      join(evidence, "tui-live.txt"),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let tuiError = "";
  tui.stdout.resume();
  tui.stderr.on("data", (chunk) => {
    tuiError += chunk;
  });
  const [tuiCode] = await once(tui, "exit");
  assert.equal(tuiCode, 0, tuiError);
  const ordinary = await current.rpc.call("thread/start");
  const accepted = await current.rpc.call("areal/goal/create", {
    requestId: "ordinary",
    threadId: ordinary.thread.id,
    expectedRevision: 0,
    objective: "Return ORDINARY_GOAL_OK",
  });
  assert(accepted.turnId && accepted.taskId && accepted.runId);
  await current.rpc.waitEvent("turn/completed", (event) => event.threadId === ordinary.thread.id);
  assert.deepEqual(model.failures, []);
  await writeFile(
    join(evidence, "native-receipt.json"),
    JSON.stringify(
      {
        root,
        workspace,
        data,
        initial: first,
        settled: view,
        selected: winner,
        restored,
        ordinaryGoal: accepted,
        isolation,
        tui: {
          nativePty: true,
          selectedStateRead: true,
          artifactPageRead: true,
          exitCode: tuiCode,
        },
        model: "scripted fixture; native Core/Runtime",
        candidatesAtModelBoundary: model.groups
          .get(view.goal.id)
          .starts.map(({ candidate, at }) => ({ candidate, at })),
      },
      null,
      2,
    ),
  );
  console.log(`RSI_NATIVE_OK ${evidence}`);
} finally {
  await stop();
  model.server.closeAllConnections();
  await new Promise((resolve) => model.server.close(resolve));
}
