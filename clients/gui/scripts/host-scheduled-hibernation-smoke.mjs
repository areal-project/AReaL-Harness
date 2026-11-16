import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "../../../examples/desktop-api/client.mjs";
import { respondToSessionName } from "../../../scripts/model-fixture.mjs";
import { HostClient } from "../packages/client/node/host-client.cjs";
import { trackedMkdtemp } from "./support/host-cleanup.cjs";

const binary = resolve(process.env.AREAL_CORE_BIN || "../../target/debug/areal");
const root = await realpath(await trackedMkdtemp(join(tmpdir(), "areal-scheduled-idle-")));
const home = join(root, "host"),
  user = join(root, "user"),
  workspace = join(root, "workspace"),
  data = join(root, "data");
for (const path of [home, user, workspace, join(root, "scratch")])
  await mkdir(path, { mode: 0o700 });
const host = new HostClient();
const evidence = { passed: false, reached: [], cleanup: null, modelRequests: 0 };
let core, hostPid, modelFailure;
const corePids = new Set();
const model = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    if (respondToSessionName(body, response)) return;
    evidence.modelRequests++;
    const text = (message) =>
      typeof message.content === "string"
        ? message.content
        : (message.content ?? []).map((part) => part.text ?? "").join("\n");
    const context = (body.messages ?? [])
      .map(text)
      .filter((value) => value.includes("Current authoritative goal: "))
      .at(-1);
    const goal = context && JSON.parse(context.split("Current authoritative goal: ").at(-1));
    const tool = goal?.goal?.limitsPending
      ? { name: "goal_set_limits", args: { expectedRevision: goal.revision, sources: {} } }
      : goal && goal.goal.report?.status !== "complete"
        ? {
            name: "goal_update",
            args: {
              expectedRevision: goal.revision,
              status: "complete",
              summary: "SCHEDULE_HIBERNATION_DONE",
              evidence: ["Local deterministic fixture"],
              remaining: [],
            },
          }
        : null;
    const delta = tool
      ? {
          tool_calls: [
            {
              index: 0,
              id: randomUUID(),
              type: "function",
              function: { name: tool.name, arguments: JSON.stringify(tool.args) },
            },
          ],
        }
      : { content: "SCHEDULE_HIBERNATION_DONE" };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const frame of [
      { choices: [{ index: 0, delta, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] },
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } },
    ])
      response.write(`data: ${JSON.stringify(frame)}\n\n`);
    response.end("data: [DONE]\n\n");
  } catch (error) {
    modelFailure = error;
    response.destroy(error);
  }
});
async function until(check, label, budget = 120000) {
  const deadline = Date.now() + budget;
  for (;;) {
    if (modelFailure) throw modelFailure;
    const result = await check();
    if (result) return result;
    assert.ok(Date.now() < deadline, label);
    await new Promise((done) => setTimeout(done, 100));
  }
}
async function waitExit(pid) {
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    assert.ok(Date.now() < deadline, `owned process ${pid} has not exited`);
    await new Promise((done) => setTimeout(done, 100));
  }
}
await new Promise((done) => model.listen(0, "127.0.0.1", done));
try {
  const config = join(user, "config.toml");
  await writeFile(
    config,
    `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n[permissions]\nmode="YOLO"\n`,
    { mode: 0o600 },
  );
  await host.connectOrStart(home, binary);
  hostPid = host.identity.pid;
  const generation = host.generation;
  const projectId = randomUUID();
  await host.registerProject(randomUUID(), {
    projectId,
    workspace,
    dataDir: data,
    source: { kind: "cli" },
    defaultBinding: true,
  });
  const initial = await host.ensureProject(randomUUID(), projectId, {
    workspace,
    cwd: workspace,
    configHome: user,
    homedir: user,
    configPath: config,
    environment: { PATH: process.env.PATH, NO_PROXY: "127.0.0.1,localhost,::1" },
    credentialNames: [],
    options: {
      workspace,
      data_dir: data,
      scratch: join(root, "scratch"),
      allow_write: true,
      allow_network: false,
      allow_concurrent_writes: false,
      read_only_path: [],
      task_credential_command: [],
      no_deployment_mcp: false,
      sandbox_profile: "native",
    },
  });
  corePids.add(initial.service.corePid);
  core = await connect(initial.service.endpoint, initial.service.authFile);
  const source = await core.call("areal/thread/start", { requestId: randomUUID(), cwd: workspace });
  const anchor = await core.call("areal/thread/start", { requestId: randomUUID(), cwd: workspace });
  const due = Math.floor(Date.now() / 1000) + 90;
  const task = await core.call("areal/task/create", {
    requestId: randomUUID(),
    sourceThreadId: source.thread.id,
    threadId: anchor.thread.id,
    mode: "scheduled",
    objective: "SCHEDULE_HIBERNATION",
    interactionMode: "interactive",
    scheduleV2: {
      version: 1,
      rule: { kind: "onceIso", atIso: new Date(due * 1000).toISOString().replace(".000Z", "Z") },
      misfire: { kind: "coalesce" },
      overlap: "skip",
    },
  });
  await core.close();
  core = undefined;
  await host.releaseWhenUnused(randomUUID());
  host.close();
  const servicePath = join(
    home,
    "services",
    createHash("sha256").update(data).digest("hex").slice(0, 24),
    "service.json",
  );
  const service = async () => JSON.parse(await readFile(servicePath, "utf8"));
  await until(
    async () => (await service()).state === "stopped",
    "release must hibernate future schedule Core",
    20000,
  );
  await waitExit(initial.service.corePid);
  process.kill(hostPid, 0);
  assert.equal(evidence.modelRequests, 0);
  evidence.reached.push(
    "last client release stops the idle Core while the future schedule retains Host",
  );
  const awakened = await until(async () => {
    const current = await service();
    return (
      current.state === "ready" && current.generation !== initial.service.generation && current
    );
  }, "Host timer must wake the hibernated schedule");
  corePids.add(awakened.corePid);
  assert.ok(Date.now() / 1000 >= due - 61, "future schedule woke too early");
  assert.ok(Date.now() / 1000 < due, "Host should prepare Core before the occurrence");
  assert.equal(evidence.modelRequests, 0);
  await host.connect(home);
  assert.equal(host.generation, generation);
  const status = (await host.status()).projects.find(
    (row) => row.registration.projectId === projectId,
  );
  assert.equal(status.scheduleActivationSuppressed, false);
  assert.equal((await host.request("backend.status", {})).owned, false);
  core = await connect(awakened.endpoint, awakened.authFile);
  const completed = await until(async () => {
    const current = await core.call("areal/task/read", { taskId: task.id });
    return current.runCount === 1 && current.runs[0]?.status === "completed" && current;
  }, "hibernated schedule must complete its original occurrence");
  assert.equal(completed.runs.length, 1);
  assert.equal(completed.runs[0].scheduledAt, due);
  assert.equal(completed.nextRunAt, null);
  assert.ok(evidence.modelRequests > 0);
  evidence.reached.push(
    "Host wakes a new Core generation near the original occurrence without Workbench",
    "Core admits and completes exactly one scheduled Run",
  );
  evidence.passed = true;
} catch (error) {
  evidence.firstFailure = error.message;
  process.exitCode = 1;
} finally {
  await core?.close();
  try {
    if (!host.socket || host.socket.destroyed) {
      host.close();
      await host.connect(home);
    }
    const receipt = await host.stop(randomUUID(), host.generation, "cancel");
    assert.equal(receipt.state, "completed");
    host.close();
    await waitExit(hostPid);
    for (const pid of corePids) await waitExit(pid);
    evidence.cleanup = "original Host stop completed; owned Host and Core processes exited";
  } catch (error) {
    evidence.cleanup = error.message;
    evidence.passed = false;
    process.exitCode = 1;
  }
  host.close();
  model.closeAllConnections();
  await new Promise((done) => model.close(done));
  const path = join(root, "result.json");
  await writeFile(path, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ...evidence, evidence: path }));
}
