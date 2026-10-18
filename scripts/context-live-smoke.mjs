// 显式使用真实模型配置；独立目录与服务，不接触已有生产任务。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";

const config = process.argv[2];
assert(config, "usage: node scripts/context-live-smoke.mjs /absolute/config.toml");
const root = process.argv[3]
  ? resolve(process.argv[3])
  : await mkdtemp(join(tmpdir(), "areal-context-live-"));
await mkdir(root, { recursive: true });
console.log(JSON.stringify({ root, phase: "starting" }));
const workspace = join(root, "workspace"),
  data = join(root, "state");
await mkdir(workspace);
const nonce = randomUUID();
const protectedText = `accepted-artifact-${randomUUID()}\n`;
await writeFile(join(workspace, "accepted.txt"), protectedText);
await writeFile(join(workspace, "input.json"), JSON.stringify({ values: [7, 11, 19, 23], nonce }));
for (let n = 0; n < 3; n++) {
  const lines = Array.from(
    { length: 140 },
    (_, i) =>
      `probe-${n}-${i}: observed deterministic sample ${createHash("sha256").update(`${nonce}/${n}/${i}`).digest("hex")}`,
  );
  await writeFile(join(workspace, `evidence-${n}.txt`), lines.join("\n"));
}
const events = [],
  stages = [];
const started = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = new Set();
let server;
async function start() {
  const child = spawn(
    "python3",
    [
      "scripts/launch.py",
      ...(process.env.AREAL_CONTEXT_LIVE_BIN_DIR
        ? ["--bin-dir", resolve(process.env.AREAL_CONTEXT_LIVE_BIN_DIR)]
        : []),
      "--config",
      resolve(config),
      "--listen",
      "127.0.0.1:0",
      "--data-dir",
      data,
      "--workspace",
      workspace,
      "--allow-write",
      "--allow-concurrent-writes",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  children.add(child);
  child.once("exit", () => children.delete(child));
  let log = "";
  child.stderr.on("data", (d) => {
    log += d;
  });
  child.stdout.on("data", (d) => {
    log += d;
  });
  const deadline = Date.now() + 60000;
  while (!log.match(/ws:\/\/127\.0\.0\.1:\d+/)) {
    if (child.exitCode !== null || Date.now() > deadline) throw Error(`startup failed: ${log}`);
    await sleep(100);
  }
  const endpoint = log.match(/ws:\/\/127\.0\.0\.1:\d+/)[0];
  const auth = JSON.parse(await readFile(join(data, "security/auth.json"), "utf8"));
  const ws = new WebSocket(endpoint, {
    headers: { Authorization: `Bearer ${auth.principals[0].token}` },
  });
  await once(ws, "open");
  let seq = 0;
  const pending = new Map();
  ws.on("message", (bytes) => {
    const msg = JSON.parse(bytes);
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    } else events.push(msg);
  });
  ws.on("close", () => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(Error("connection closed"));
    }
    pending.clear();
  });
  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error(`RPC timeout: ${method}`));
      }, 180000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  await call("initialize", { clientInfo: { name: "context-live-smoke", version: "1" } });
  ws.send(JSON.stringify({ method: "initialized", params: {} }));
  return { call, ws, child, log: () => log };
}
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
  child.kill("SIGTERM");
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}
async function stop() {
  if (!server) return;
  const owned = server;
  server = undefined;
  owned.ws.close();
  await stopChild(owned.child);
  await writeFile(join(root, `server-${stages.length}.log`), owned.log());
}
async function settled(id, goal = false) {
  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    const { thread } = await server.call("thread/read", { threadId: id, includeTurns: true });
    if (
      goal ? thread.goals?.goal?.status !== "active" : thread.turns.at(-1)?.status !== "inProgress"
    ) {
      assert.equal(
        thread.turns.at(-1)?.status,
        "completed",
        JSON.stringify(thread.turns.at(-1)?.error),
      );
      if (goal)
        assert.equal(thread.goals.goal.status, "completed", JSON.stringify(thread.goals.goal));
      return thread;
    }
    await sleep(500);
  }
  throw Error("task deadline exceeded");
}
async function turn(id, text) {
  await server.call("turn/start", { threadId: id, input: [{ type: "text", text }] });
  const thread = await settled(id);
  stages.push({
    turns: thread.turns.length,
    compactions: thread.contextCheckpoint?.compactions ?? 0,
  });
  console.log(JSON.stringify({ root, ...stages.at(-1) }));
  return thread;
}
const revision2 = `REPAIR_REVISION_2: only five checks are authorized: chord=true, release=true, opticalCenter=17, retryHud=0, drawBudget=120. Keep accepted.txt byte-for-byte. Final delivery.json must contain revision=2, these five fields, and nonce="${nonce}". Do not expand the scope.`;
const revision3 =
  "REPAIR_REVISION_3 supersedes revision 2 only for opticalCenter and revision: opticalCenter=23, revision=3. The other four check values and nonce remain required. No new features. accepted.txt remains protected. Do not persist this repair contract in another file; retain the conversation requirements until final delivery is requested.";
try {
  server = await start();
  const id = (await server.call("thread/start", {})).thread.id;
  await turn(
    id,
    "Read input.json and accepted.txt using tools. Create draft.json containing revision=1, opticalCenter=0 and the input nonce. Read it back to verify. Do not create delivery.json yet; this is preparation for later repair instructions. Do not delegate.",
  );
  await turn(
    id,
    `${revision2}\nAcknowledge these requirements briefly; do not write delivery.json until requested.`,
  );
  for (let n = 0; n < 3; n++) {
    await turn(
      id,
      `Read evidence-${n}.txt using tools (all lines, paging if needed). Report the last line's probe identifier and SHA text. Do not change files or add tasks; keep the current repair requirements for later delivery.`,
    );
    const projected = await server.call("areal/context/compact", { threadId: id });
    const users = projected.data
      .filter((m) => m.role === "user")
      .map((m) => m.text)
      .join("\n");
    assert(
      users.includes(revision2) && (n === 0 || users.includes(revision3)),
      "repair contract lost after compaction",
    );
    if (n === 0)
      await turn(
        id,
        `${revision3}\nAcknowledge the correction briefly. Wait for final delivery instructions.`,
      );
    stages.push({ manualCompaction: n + 1, compactions: projected.checkpoint?.compactions });
  }
  const before = (await server.call("thread/read", { threadId: id, includeTurns: true })).thread;
  assert(before.contextCheckpoint.compactions >= 3);
  await stop();
  server = await start();
  await server.call("thread/resume", { threadId: id });
  const view = await server.call("areal/context/read", { threadId: id, offset: 0, limit: 32 });
  assert(view.data.some((m) => m.role === "user" && m.text.includes(revision3)));
  await server.call("areal/goal/create", {
    requestId: randomUUID(),
    threadId: id,
    expectedRevision: 0,
    objective:
      "Finish the current repair revision from our conversation. Read input.json and draft.json; create delivery.json with the current authorized fields and additionally sum equal to the sum of input.values. Verify by running an actual command that reads the output and checks every required value plus preservation of accepted.txt. Do not modify accepted.txt. Do not delegate. Report Goal completion with concrete file and command evidence, then finish.",
    maxTurns: 4,
    maxActiveSeconds: 600,
    tokenBudget: 250000,
  });
  const final = await settled(id, true);
  const result = JSON.parse(await readFile(join(workspace, "delivery.json"), "utf8"));
  assert.deepEqual(result, {
    revision: 3,
    chord: true,
    release: true,
    opticalCenter: 23,
    retryHud: 0,
    drawBudget: 120,
    nonce,
    sum: 60,
  });
  assert.equal(await readFile(join(workspace, "accepted.txt"), "utf8"), protectedText);
  const tools = final.turns.flatMap((t) => t.items).filter((i) => i.type === "dynamicToolCall");
  assert(
    tools.some(
      (t) =>
        ["run_command", "verify_command"].includes(t.tool) &&
        t.success &&
        t.contentItems?.some((c) => c.type === "inputText" && JSON.parse(c.text).exitCode === 0),
    ),
  );
  assert(tools.some((t) => /read/.test(t.tool) && t.success));
  const rows = await Promise.all(
    (await readdir(join(data, "model-requests")))
      .filter((f) => f.endsWith(".json"))
      .map(async (f) => JSON.parse(await readFile(join(data, "model-requests", f), "utf8"))),
  );
  const known = rows.filter((r) => r.usageObserved);
  const input = known.reduce((n, r) => n + r.usage.inputTokens, 0),
    cached = known.reduce((n, r) => n + r.usage.cachedInputTokens, 0);
  const summaryAudits = await Promise.all(
    (await readdir(join(data, "audit")))
      .filter((f) => f.endsWith(".json"))
      .map(async (f) => JSON.parse(await readFile(join(data, "audit", f), "utf8"))),
  );
  const summaries = summaryAudits.filter((a) => a.kind === "contextSummary");
  const validSummaries = summaries.filter((a) => !a.error);
  const summaryFailures = summaries.filter((a) => a.error).map((a) => a.error);
  const report = {
    verified: summaryFailures.length === 0 && validSummaries.length >= 3,
    functionalVerified: true,
    validSummaries: validSummaries.length,
    summaryAttempts: summaries.length,
    summaryFailures,
    root,
    threadId: id,
    seconds: (Date.now() - started) / 1000,
    stages,
    compactions: final.contextCheckpoint.compactions,
    toolCalls: tools.length,
    goalStatus: final.goals.goal.status,
    goalUsage: final.goals.goal.usage,
    requests: rows.length,
    unknownUsageRequests: rows.length - known.length,
    input,
    cached,
    cacheRate: input ? cached / input : null,
    output: result,
  };
  await writeFile(join(root, "result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  assert.equal(
    summaryFailures.length,
    0,
    "summary generation failed; fallback is not successful summarization",
  );
  assert(validSummaries.length >= 3, "expected at least three valid summaries");
} catch (error) {
  await writeFile(
    join(root, "failure.json"),
    JSON.stringify({ error: String(error), stages }, null, 2),
  );
  throw error;
} finally {
  try {
    await stop();
  } finally {
    await Promise.all([...children].map(stopChild));
  }
}
