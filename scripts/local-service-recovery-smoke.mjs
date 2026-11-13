import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect as unixConnect } from "node:net";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { mkdir, readFile, writeFile, realpath, rename, rm } from "node:fs/promises";
import { trackedMkdtemp } from "../clients/gui/scripts/support/host-cleanup.cjs";
import { join, resolve } from "node:path";
import { connect } from "../examples/desktop-api/client.mjs";
import { respondToSessionName } from "./model-fixture.mjs";
const exec = promisify(execFile);
const root = await realpath(await trackedMkdtemp("/tmp/ar-"));
const workspace = join(root, "workspace"),
  home = join(root, "home"),
  profile = join(root, "profile"),
  config = join(root, "config.toml");
for (const path of [workspace, home, profile]) await mkdir(path);
const binary = resolve(process.env.AREAL_TEST_BIN_DIR ?? "target/debug", "areal");
const evidence = process.env.AREAL_TEST_EVIDENCE ?? join(root, "evidence.json");
let calls = 0;
const model = createServer(async (req, res) => {
  let body = "";
  for await (const part of req) body += part;
  const request = JSON.parse(body);
  if (respondToSessionName(request, res)) return;
  calls++;
  const delta = {
    tool_calls: [
      {
        index: 0,
        id: "crash-effect",
        type: "function",
        function: {
          name: "run_command",
          arguments: JSON.stringify({
            argv: ["/bin/sh", "-c", "echo once >> effect; echo $$ > tool.pid; sleep 120"],
            cwd: ".",
            timeoutMs: 180000,
          }),
        },
      },
    ],
  };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
  );
});
model.listen(0, "127.0.0.1");
await once(model, "listening");
await writeFile(
  config,
  `schema_version = 1\n[model]\nname = "fixture"\n[model.providers.default]\nprotocol = "chat-completions"\nendpoint = "http://127.0.0.1:${model.address().port}"\n`,
);
const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith("AREAL_") && !k.startsWith("OTEL_")),
);
Object.assign(env, {
  AREAL_HARNESS_HOME: home,
  HOME: join(root, "user"),
  OTEL_SDK_DISABLED: "true",
  NO_PROXY: "127.0.0.1,localhost",
});
const broker = spawn(
  "/usr/bin/python3",
  [
    "-I",
    "-S",
    "-u",
    "-c",
    `
import os,sys,json,subprocess,concurrent.futures,threading
r,w=os.pipe()
os.environ['AREAL_GUI_OWNER']=json.dumps({'kind':'gui','appRunId':sys.argv[2],'profile':sys.argv[3]})
os.environ['AREAL_GUI_LIFETIME_FD']=str(r)
lock=threading.Lock()
def run(v):
 try:
  env=os.environ.copy(); env.update(v.get('env',{}))
  p=subprocess.run([sys.argv[1]]+v['args'],env=env,pass_fds=(r,),capture_output=True,text=True,timeout=90)
  result={'id':v['id'],'code':p.returncode,'stdout':'null' if v.get('discardReply') else p.stdout,'stderr':p.stderr}
 except Exception as e: result={'id':v['id'],'code':-1,'stderr':str(e)}
 with lock: print(json.dumps(result),flush=True)
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
 for line in sys.stdin:
  v=json.loads(line)
  if v.get('closeOwner'): os.close(w); print(json.dumps({'id':v['id'],'code':0,'stdout':'null'}),flush=True)
  else: pool.submit(run,v)
`,
    binary,
    crypto.randomUUID(),
    profile,
  ],
  { env, stdio: ["pipe", "pipe", "inherit"] },
);
let sequence = 0;
const pending = new Map();
createInterface({ input: broker.stdout }).on("line", (line) => {
  const v = JSON.parse(line);
  pending.get(v.id)?.(v);
  pending.delete(v.id);
});
async function command(args, extra = {}) {
  const id = ++sequence;
  const response = new Promise((r) => pending.set(id, r));
  broker.stdin.write(JSON.stringify({ id, args, ...extra }) + "\n");
  return response;
}
async function cli(args, extra = {}) {
  const r = await command(args, extra);
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const local = [
  "--workspace",
  workspace,
  "--config",
  config,
  "--permissions",
  "YOLO",
  "--allow-write",
];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30000) {
  const end = Date.now() + ms;
  let last;
  do {
    try {
      if (await fn()) return;
    } catch (e) {
      last = e;
    }
    await delay(75);
  } while (Date.now() < end);
  throw last ?? Error("condition timed out");
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === "ESRCH") return false;
    throw e;
  }
};
const statePath = (s) => join(home, "services", s.serviceId);
const checks = [];
let service,
  client,
  passed = false,
  ownerClosed = false;
const recoverArgs = (s) => [
  "service",
  "recover",
  "--instance",
  s.serviceId,
  "--expected-generation",
  s.generation,
  ...local,
];
async function refuses(s, name, args = recoverArgs(s), extra = {}) {
  const result = await command(args, extra);
  assert.notEqual(result.code, 0, name);
  checks.push({ name, rejected: true, error: result.stderr });
}
async function topology(s) {
  const { stdout } = await exec("/bin/ps", ["-axo", "pid=,ppid=,comm="]);
  const rows = stdout
    .trim()
    .split("\n")
    .map((l) => {
      const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      return { pid: +m[1], ppid: +m[2], name: m[3] };
    });
  const owned = [s.hostPid];
  for (let i = 0; i < owned.length; i++)
    owned.push(...rows.filter((r) => r.ppid === owned[i]).map((r) => r.pid));
  const runtime = rows.find((r) => owned.includes(r.pid) && r.name.endsWith("/areal-runtime"));
  const launchers = [];
  for (const row of rows.filter(
    (r) =>
      owned.includes(r.pid) &&
      r.name.endsWith("/areal") &&
      r.pid !== s.hostPid &&
      r.pid !== s.corePid,
  )) {
    const args = (await exec("/bin/ps", ["-p", String(row.pid), "-o", "args="])).stdout;
    if (args.includes(" launcher ")) launchers.push(row);
  }
  assert(runtime);
  assert.equal(launchers.length, 1);
  return { runtime: runtime.pid, launcher: launchers[0].pid };
}
async function recover(s, extra = []) {
  return cli([
    "service",
    "recover",
    "--instance",
    s.serviceId,
    "--expected-generation",
    s.generation,
    ...local,
    ...extra,
  ]);
}
try {
  service = await cli(["service", "ensure", ...local]);
  client = await connect(service.endpoint, service.authFile);
  const { thread } = await client.call("areal/thread/start", {
    requestId: crypto.randomUUID(),
    cwd: workspace,
  });
  await client.call("areal/turn/start", {
    requestId: crypto.randomUUID(),
    threadId: thread.id,
    input: [{ type: "text", text: "write once and wait" }],
  });
  await until(async () => (await readFile(join(workspace, "effect"), "utf8")) === "once\n");
  const toolPid = Number(await readFile(join(workspace, "tool.pid"), "utf8"));
  const owned = await topology(service);
  const runtime = { pid: owned.runtime };
  assert(alive(toolPid));
  process.kill(service.corePid, "SIGKILL");
  await until(() => !alive(toolPid) && !alive(runtime.pid) && !alive(service.hostPid), 45000);
  const old = service;
  const log = await readFile(join(statePath(old), "host.log"), "utf8");
  checks.push({
    name: "active Core fault cleans owned Runtime/tool",
    corePid: old.corePid,
    runtimePid: runtime.pid,
    toolPid,
    log,
  });
  console.log(JSON.stringify(checks.at(-1)));
  const recoveredStatus = await cli([
    "service",
    "status",
    "--instance",
    old.serviceId,
    "--recovery",
  ]);
  assert.equal(recoveredStatus.recovery.eligible, true, "positive Host proof required");
  const proofPath = join(statePath(old), "crash.json");
  const proof = JSON.parse(await readFile(proofPath, "utf8"));
  await rename(proofPath, proofPath + ".saved");
  await refuses(old, "missing cleanup proof");
  assert.equal(
    (await cli(["service", "status", "--instance", old.serviceId, "--recovery"])).recovery.eligible,
    false,
  );
  await rename(proofPath + ".saved", proofPath);
  for (const [name, value] of [
    [
      "wrong generation cleanup proof",
      { ...proof, identity: { ...proof.identity, generation: crypto.randomUUID() } },
    ],
    ["malformed cleanup proof", { ...proof, unexpected: true }],
    ["non-crash cleanup proof", { ...proof, unexpectedCoreExit: false }],
    ["unconfirmed Runtime resources", { ...proof, cleanupConfirmed: false }],
    [
      "changed binary component",
      { ...proof, components: { ...proof.components, binaries: "changed" } },
    ],
  ]) {
    await writeFile(proofPath, JSON.stringify(value));
    await refuses(old, name);
  }
  await writeFile(proofPath, JSON.stringify(proof));
  await refuses(old, "changed owner", recoverArgs(old), {
    env: { AREAL_GUI_OWNER: JSON.stringify({ ...old.owner, appRunId: crypto.randomUUID() }) },
  });
  await refuses(old, "changed Runtime configuration", [
    ...recoverArgs(old),
    "--runtime-max-processes",
    "8",
  ]);
  const originalConfig = await readFile(config, "utf8");
  await writeFile(config, originalConfig.replace('"fixture"', '"changed-model"'));
  await refuses(old, "changed model configuration");
  await writeFile(config, originalConfig);
  const operationDir = join(statePath(old), "operations");
  await mkdir(operationDir, { recursive: true, mode: 0o700 });
  const requestId = crypto.randomUUID(),
    receiptPath = join(
      operationDir,
      createHash("sha256").update(requestId).digest("hex") + ".json",
    );
  const receipt = {
    operation: {
      version: 1,
      requestId,
      serviceId: old.serviceId,
      generation: old.generation,
      cancel: true,
      state: "acceptedPending",
    },
    service: old,
    cleanupConfirmed: false,
  };
  for (const state of [
    "acceptedPending",
    "admissionUnknown",
    "settlementIncomplete",
    "completed",
  ]) {
    receipt.operation.state = state;
    await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
    await refuses(old, "durable stop " + state);
  }
  receipt.operation.state = "blocked";
  await writeFile(receiptPath, JSON.stringify(receipt));
  const [lostReply, first, second] = await Promise.all([
    cli(recoverArgs(old), { discardReply: true }),
    recover(old),
    recover(old),
  ]);
  assert.equal(lostReply, null, "one successful recover response is intentionally lost");
  service = first;
  assert.notEqual(first.generation, old.generation);
  assert.equal(first.generation, second.generation);
  assert.equal(
    (await recover(old)).generation,
    first.generation,
    "lost reply returns recorded successor",
  );
  await client.close();
  client = await connect(first.endpoint, first.authFile);
  const restored = await client.call("thread/read", { threadId: thread.id, includeTurns: true });
  await delay(1500);
  assert.equal(calls, 1, "no model replay");
  assert.equal(await readFile(join(workspace, "effect"), "utf8"), "once\n", "no tool replay");
  assert.equal(restored.thread.id, thread.id);
  assert.equal(restored.thread.turns.length, 1);
  assert.equal(restored.thread.turns[0].status, "failed");
  assert.equal(restored.thread.turns[0].interruption, "coreRecovery");
  assert.equal(restored.thread.turns[0].error.outcome.source, "core_recovery");
  const effect = restored.thread.turns[0].items.find(
    (item) => item.type === "dynamicToolCall" && item.tool === "run_command",
  );
  assert(effect);
  assert.equal(effect.execution.outcome, "unknown", "unfinished side effect remains UNKNOWN");
  checks.push({
    name: "one successor preserves history without replay",
    original: old.generation,
    successor: first.generation,
    modelCalls: calls,
    restored,
  });
  const changed = await command([
    "service",
    "recover",
    "--instance",
    old.serviceId,
    "--expected-generation",
    old.generation,
    ...local,
    "--runtime-max-processes",
    "8",
  ]);
  assert.notEqual(changed.code, 0, "changed spec cannot attach recorded successor");
  process.kill(service.corePid, "SIGKILL");
  await until(() => !alive(service.hostPid) && !alive(service.corePid), 45000);
  await refuses(old, "old generation cannot chain a second crashed successor");
  service = await cli(["service", "ensure", ...local]);
  await cli([
    "service",
    "stop",
    "--instance",
    service.serviceId,
    "--expected-generation",
    service.generation,
    "--cancel",
  ]);
  const stoppedStatus = await cli([
    "service",
    "status",
    "--instance",
    service.serviceId,
    "--recovery",
  ]);
  assert.equal(stoppedStatus.recovery.eligible, false);
  assert.equal(
    stoppedStatus.recovery.reason,
    "explicitStopIntent",
    "known stop intent outranks missing crash proof",
  );
  const stopped = await command([
    "service",
    "recover",
    "--instance",
    service.serviceId,
    "--expected-generation",
    service.generation,
    ...local,
  ]);
  assert.notEqual(stopped.code, 0, "explicitly stopped generation cannot recover");
  for (const kind of ["host", "launcher", "runtime"]) {
    service = await cli(["service", "ensure", ...local]);
    const processes = await topology(service);
    const target = kind === "host" ? service.hostPid : processes[kind];
    process.kill(target, "SIGKILL");
    await until(
      () =>
        !alive(service.hostPid) &&
        !alive(service.corePid) &&
        !alive(processes.runtime) &&
        !alive(processes.launcher),
      55000,
    );
    await refuses(service, `${kind} death has no positive cleanup authority`);
    assert.equal(
      (await cli(["service", "status", "--instance", service.serviceId, "--recovery"])).recovery
        .eligible,
      false,
    );
  }
  service = await cli(["service", "ensure", ...local]);
  const stopId = crypto.randomUUID(),
    stopPath = join(
      statePath(service),
      "operations",
      createHash("sha256").update(stopId).digest("hex") + ".json",
    );
  const socket = unixConnect(join(statePath(service), "control.sock"));
  await once(socket, "connect");
  await new Promise((resolve, reject) =>
    socket.write(
      JSON.stringify({
        method: "stopOperation",
        version: 1,
        generation: service.generation,
        requestId: stopId,
        cancel: true,
      }) + "\n",
      (error) => (error ? reject(error) : resolve()),
    ),
  );
  socket.destroy();
  await until(
    async () => JSON.parse(await readFile(stopPath, "utf8")).operation.state !== "blocked",
  );
  try {
    process.kill(service.corePid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  await refuses(service, "accepted stop with lost control reply");
  await until(() => !alive(service.hostPid), 45000);
  await refuses(service, "lost-reply stop remains fenced after Host exit");
  service = await cli(["service", "ensure", ...local]);
  await command([], { closeOwner: true });
  ownerClosed = true;
  await until(() => !alive(service.hostPid), 45000);
  await refuses(service, "closed application lifetime");
  passed = true;
} finally {
  if (client) await client.close().catch(() => {});
  if (!ownerClosed) await command([], { closeOwner: true });
  if (service) await until(() => !alive(service.hostPid), 45000).catch(() => {});
  broker.stdin.end();
  await once(broker, "exit");
  model.closeAllConnections();
  model.close();
  await writeFile(evidence, JSON.stringify({ passed, root, binary, checks }, null, 2));
  console.log(`Evidence: ${evidence}`);
}
