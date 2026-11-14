// 付费验证只由调用者显式启动；结果与含认证信息的运行状态分开保存。
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { connect } from "../examples/desktop-api/client.mjs";

const config = process.argv[2];
assert(
  config && process.argv.length === 3,
  "usage: node scripts/model-live-scenarios.mjs /absolute/model.toml",
);
assert(
  process.env.AREAL_LIVE_API_KEY?.trim(),
  "Set AREAL_LIVE_API_KEY in the invoking environment",
);
const root = await mkdtemp(join(tmpdir(), "areal-model-live-"));
await chmod(root, 0o700);
const workspace = join(root, "workspace"),
  data = join(root, "state"),
  evidence = join(root, "evidence");
await Promise.all([mkdir(workspace), mkdir(evidence)]);
const nonce = randomUUID();
await writeFile(join(workspace, "input.txt"), nonce + "\n");
const report = {
  startedAt: new Date().toISOString(),
  configSha256: createHash("sha256")
    .update(await readFile(config))
    .digest("hex"),
  binarySha256: Object.fromEntries(
    ["areal", "areal-runtime"].map((name) => [
      name,
      execFileSync(
        "shasum",
        ["-a", "256", join(resolve(process.env.AREAL_LIVE_BIN_DIR ?? "target/debug"), name)],
        { encoding: "utf8" },
      ).split(" ")[0],
    ]),
  ),
  verifierSha256: createHash("sha256")
    .update(await readFile(new URL(import.meta.url)))
    .digest("hex"),
  status: "failed",
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  dirtyFiles: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean),
  stages: [],
  cleanup: "pending",
};
let server;
let phase = "startup";
async function start() {
  const env = {
    ...Object.fromEntries(
      [
        "PATH",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "no_proxy",
      ]
        .filter((name) => process.env[name])
        .map((name) => [name, process.env[name]]),
    ),
    AREAL_LIVE_API_KEY: process.env.AREAL_LIVE_API_KEY,
    HOME: join(root, "home"),
    AREAL_HARNESS_HOME: join(root, "harness"),
    AREAL_CORE_HOME: join(root, "core-home"),
    AREAL_HARNESS_SERVICE_HOME: join(root, "service-home"),
  };
  const args = [
    "scripts/launch.py",
    ...(process.env.AREAL_LIVE_BIN_DIR
      ? ["--bin-dir", resolve(process.env.AREAL_LIVE_BIN_DIR)]
      : []),
    "--config",
    resolve(config),
    "--api-key-env",
    "AREAL_LIVE_API_KEY",
    "--listen",
    "127.0.0.1:0",
    "--data-dir",
    data,
    "--workspace",
    workspace,
    "--allow-write",
  ];
  const child = spawn("python3", args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  server = { child };
  const deadline = Date.now() + 60000;
  while (!/ws:\/\/127\.0\.0\.1:\d+/.test(output)) {
    if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline)
      throw Error("Core startup failed; inspect the private state directory");
    await delay(100);
  }
  server.client = await connect(
    output.match(/ws:\/\/127\.0\.0\.1:\d+/)[0],
    join(data, "security/auth.json"),
    async () => ({}),
  );
}
async function stop() {
  if (!server) return;
  const current = server;
  let closeError;
  try {
    if (current.client) await current.client.close();
  } catch (error) {
    closeError = error;
  }
  if (current.child.exitCode === null && current.child.signalCode === null) {
    const exited = once(current.child, "exit");
    const timer = setTimeout(() => current.child.kill("SIGKILL"), 30000);
    current.child.kill("SIGTERM");
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }
  server = undefined;
  if (closeError) throw closeError;
}
async function waitEvent(method, predicate) {
  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    const index = server.client.events.findIndex(
      (event) => event.method === method && predicate(event.params),
    );
    if (index >= 0) return server.client.events.splice(index, 1)[0].params;
    if (server.child.exitCode !== null || server.client.socket.readyState !== 1)
      throw Error(`Connection lost waiting for ${method}`);
    await delay(100);
  }
  throw Error(`Timed out waiting for ${method}`);
}
function requireTurn(thread, expected) {
  const turn = thread.turns.find((item) => item.id === expected);
  assert.equal(turn?.status, "completed", "Turn did not complete");
  const items = turn.items;
  assert(
    items.some(
      (item) =>
        item.type === "dynamicToolCall" &&
        item.success === true &&
        item.tool === "fs_read" &&
        item.arguments?.path === "input.txt",
    ),
    "No successful read tool",
  );
  assert(
    items.some((item) => item.type === "agentMessage" && item.text.includes(nonce)),
    "Final conversation does not include the input value",
  );
  return {
    turnId: turn.id,
    status: turn.status,
    tools: items
      .filter((item) => item.type === "dynamicToolCall")
      .map(({ tool, success }) => ({ tool, success })),
    responseContainsInput: true,
  };
}
try {
  console.log(`Private run directory: ${root}`);
  await start();
  phase = "conversation";
  const { thread } = await server.client.call("thread/start", {});
  const { turn } = await server.client.call("turn/start", {
    threadId: thread.id,
    input: [
      {
        type: "text",
        text: "Read input.txt using fs_read and reply with its exact content. Do not delegate or change files.",
      },
    ],
  });
  await waitEvent(
    "turn/completed",
    (event) => event.threadId === thread.id && event.turn.id === turn.id,
  );
  const initial = (
    await server.client.call("thread/read", { threadId: thread.id, includeTurns: true })
  ).thread;
  report.stages.push({
    scenario: "conversation",
    threadId: thread.id,
    ...requireTurn(initial, turn.id),
  });
  phase = "background";
  await server.client.call("areal/task/host/ready", {});
  const task = await server.client.call("areal/task/create", {
    requestId: randomUUID(),
    mode: "background",
    objective:
      "Use fs_read to read input.txt and fs_create to create background.txt containing exactly the same bytes. Verify the file and finish. Do not delegate.",
    interactionMode: "headless",
    tokenBudget: 50000,
    maxTurns: 4,
    maxActiveSeconds: 300,
  });
  let snapshot = await server.client.call("areal/task/subscribe", { taskId: task.id });
  const terminal = (value) =>
    ["completed", "failed", "blocked", "cancelled"].includes(value.runs.at(-1)?.status);
  if (!terminal(snapshot))
    snapshot = (
      await waitEvent(
        "areal/task/updated",
        (event) => event.taskId === task.id && terminal(event.task),
      )
    ).task;
  const run = snapshot.runs.at(-1);
  assert.equal(run.status, "completed", "Background run did not complete");
  assert.equal(await readFile(join(workspace, "background.txt"), "utf8"), nonce + "\n");
  const backgroundThread = (
    await server.client.call("thread/read", { threadId: run.threadId, includeTurns: true })
  ).thread;
  const backgroundTools = backgroundThread.turns
    .flatMap((value) => value.items)
    .filter((item) => item.type === "dynamicToolCall");
  assert(
    backgroundTools.some(
      (item) =>
        item.tool === "fs_read" && item.success === true && item.arguments?.path === "input.txt",
    ),
    "Background input was not read",
  );
  assert(
    backgroundTools.some(
      (item) =>
        item.tool === "fs_create" &&
        item.success === true &&
        item.arguments?.path === "background.txt",
    ),
    "Background output was not created",
  );
  report.stages.push({
    scenario: "background",
    taskId: task.id,
    runId: run.id,
    threadId: run.threadId,
    status: run.status,
    outputSha256: createHash("sha256")
      .update(nonce + "\n")
      .digest("hex"),
    usage: run.usage,
    tools: backgroundTools.map(({ tool, success }) => ({ tool, success })),
  });
  phase = "clean-restart";
  await stop();
  await start();
  const resumed = (await server.client.call("thread/resume", { threadId: thread.id })).thread;
  const recovered = (
    await server.client.call("thread/read", { threadId: resumed.id, includeTurns: true })
  ).thread;
  requireTurn(recovered, turn.id);
  const recoveredTask = await server.client.call("areal/task/read", { taskId: task.id });
  assert.equal(recoveredTask.runs.at(-1)?.id, run.id);
  assert.equal(recoveredTask.runs.at(-1)?.status, "completed");
  assert.equal(await readFile(join(workspace, "background.txt"), "utf8"), nonce + "\n");
  report.stages.push({
    scenario: "clean-restart",
    threadId: thread.id,
    turnId: turn.id,
    taskId: task.id,
    runId: run.id,
    status: "passed",
  });
  report.status = "passed";
} catch (error) {
  report.failure = {
    name: error.name,
    stage: phase,
  };
  console.error(
    `Scenario failed (${report.failure.stage}): ${error.name}. Inspect the private state directory.`,
  );
  process.exitCode = 1;
} finally {
  try {
    await stop();
    report.cleanup = "completed";
  } catch {
    report.cleanup = "failed";
    report.status = "failed";
    process.exitCode = 1;
  }
  await writeFile(join(evidence, "result.json"), JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(`Evidence: ${join(evidence, "result.json")} (${report.status})`);
}
