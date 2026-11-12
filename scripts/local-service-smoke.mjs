import { respondToSessionName } from "./model-fixture.mjs";
// 真实 Core/Runtime 验证跨进程复用、客户端独立生命周期和故障恢复。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { connect as unixConnect } from "node:net";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, realpath, rm, symlink } from "node:fs/promises";
import { trackedMkdtemp } from "../clients/gui/scripts/support/host-cleanup.cjs";
import { basename, join, resolve } from "node:path";
import { connect } from "../examples/desktop-api/client.mjs";
import { waitForFaultStatus } from "./local-service-wait.mjs";
const exec = promisify(execFile);
const root = await realpath(await trackedMkdtemp("/tmp/as-"));
const workspace = join(root, "workspace"),
  home = join(root, "home"),
  config = join(root, "config.toml");
const bin = resolve(process.env.AREAL_TEST_BIN_DIR ?? "target/debug", "areal");
const evidence = resolve(
  process.env.AREAL_TEST_EVIDENCE ?? `/tmp/areal-local-service-${Date.now()}.json`,
);
const lifecycleChecks = [];
const faultStatusWaits = [];
let phase;
const smokeStartedAt = Date.now();
function setPhase(value) {
  phase = value;
  console.log(`Phase: ${JSON.stringify({ phase, elapsedMs: Date.now() - smokeStartedAt })}`);
}
setPhase("startup");
let passed = false;
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("AREAL_") && !key.startsWith("OTEL_"),
    ),
  ),
  AREAL_HARNESS_HOME: home,
  HOME: join(root, "user"),
  OTEL_SDK_DISABLED: "true",
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
};
const requests = [];
const clients = [],
  held = [];
const model = createServer(async (req, res) => {
  let body = "";
  for await (const part of req) body += part;
  const request = JSON.parse(body);
  if (respondToSessionName(request, res)) return;
  const text = request.messages.findLast(
    (message) =>
      message.role === "user" &&
      !(
        typeof message.content === "string" &&
        message.content.startsWith("AReaL runtime context (not a user request):")
      ),
  ).content;
  requests.push({ model: request.model, text, authorization: req.headers.authorization });
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "reply:" + text }, finish_reason: null }] })}\n\n`,
  );
  const finish = () =>
    res.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  if (text === "hang") {
    held.push(finish);
    // watchdog 或取消关闭的响应不能继续占用待释放队列。
    res.once("close", () => {
      const index = held.indexOf(finish);
      if (index >= 0) held.splice(index, 1);
    });
  } else finish();
});
model.listen(0, "127.0.0.1");
await once(model, "listening");
async function cli(args, { timeout = 80000 } = {}) {
  // 与产品及其他原生夹具一样，由系统父进程启动本地 Mach-O；共享服务的真实 PID 不变。
  const [command, argv] =
    process.platform === "darwin"
      ? [
          "/usr/bin/python3",
          [
            "-I",
            "-S",
            "-c",
            "import signal,subprocess,sys; p=subprocess.Popen(sys.argv[1:]); signal.signal(signal.SIGTERM,lambda *_:p.terminate()); signal.signal(signal.SIGINT,lambda *_:p.send_signal(signal.SIGINT)); r=p.wait(); sys.exit(r if r>=0 else 128-r)",
            bin,
            ...args,
          ],
        ]
      : [bin, args];
  const { stdout } = await exec(command, argv, { env, timeout, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout);
}
const local = ["--workspace", workspace, "--config", config];
const ensure = (extra = []) =>
  cli([
    "service",
    "ensure",
    "--json",
    ...local.filter((_, i) => !extra.includes(local[i - (i % 2)])),
    ...extra,
  ]);
const stop = (s, cancel = false) =>
  cli(["service", "stop", "--json", "--instance", s.serviceId, ...(cancel ? ["--cancel"] : [])]);
const operation = (s, requestId) =>
  cli([
    "service",
    "operation",
    "--json",
    "--instance",
    s.serviceId,
    "--expected-generation",
    s.generation,
    "--request-id",
    requestId,
  ]);
const requestStop = (s, requestId, cancel = false) =>
  cli([
    "service",
    "stop",
    "--json",
    "--instance",
    s.serviceId,
    "--expected-generation",
    s.generation,
    "--request-id",
    requestId,
    ...(cancel ? ["--cancel"] : []),
  ]);
async function client(s) {
  const c = await connect(s.endpoint, s.authFile);
  clients.push(c);
  return c;
}
async function until(fn, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error("condition timed out");
}
async function faultStatus(service, expectedState) {
  const check = { phase, expectedState, refusedConnections: 0, settled: false };
  faultStatusWaits.push(check);
  const result = await waitForFaultStatus(
    (timeout) => cli(["service", "status", "--instance", service.serviceId], { timeout }),
    expectedState,
    { onRefused: () => check.refusedConnections++ },
  );
  assert.equal(
    result.generation,
    service.generation,
    "fault recovery must observe the same generation",
  );
  check.settled = true;
}
async function rejected(fn, pattern) {
  await assert.rejects(fn, (e) => pattern.test(e.stderr ?? e.message));
}
async function children(pid, recursive = false) {
  const { stdout } = await exec("/bin/ps", ["-axo", "pid=,ppid="]);
  const rows = stdout
    .trim()
    .split("\n")
    .map((s) => s.trim().split(/\s+/).map(Number));
  const found = rows.filter(([, parent]) => parent === pid).map(([id]) => id);
  if (recursive)
    for (let i = 0; i < found.length; i++)
      found.push(...rows.filter(([, parent]) => parent === found[i]).map(([id]) => id));
  return found;
}
async function serviceProcesses(service) {
  const executable = await realpath(bin);
  const descendants = await children(service.hostPid, true);
  const rows = await Promise.all(
    descendants.map(async (pid) => {
      const { stdout } = await exec("/bin/ps", ["-p", String(pid), "-o", "pid=,ppid=,comm="]);
      const fields = stdout.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      assert(fields, `missing owned process ${pid}`);
      const row = {
        pid: Number(fields[1]),
        parent: Number(fields[2]),
        executable: basename(fields[3]),
      };
      if (row.executable === basename(executable)) {
        row.args = (await exec("/bin/ps", ["-p", String(pid), "-o", "args="])).stdout.trim();
      }
      return row;
    }),
  );
  // 系统 Python 是持有者而非故障目标；按实际可执行文件和参数识别受控后代。
  const launchers = rows.filter(
    (row) =>
      row.executable === basename(executable) &&
      (row.args === `${executable} launcher` || row.args?.startsWith(`${executable} launcher `)),
  );
  const runtimes = rows.filter((row) => row.executable === "areal-runtime");
  assert.equal(launchers.length, 1, "exactly one actual launcher belongs to this host");
  assert.equal(runtimes.length, 1, "exactly one actual Runtime belongs to this host");
  const launcher = launchers[0].pid;
  const processes = await children(launcher, true);
  assert(processes.includes(service.corePid));
  assert(processes.includes(runtimes[0].pid));
  return {
    launcher,
    launcherBridge: launchers[0].parent,
    runtime: runtimes[0].pid,
    runtimeOwner: runtimes[0].parent,
    processes,
  };
}
async function dead(pid, timeoutMs = 20000) {
  await until(async () => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (e) {
      if (e.code === "ESRCH") return true;
      throw e;
    }
  }, timeoutMs);
}
async function control(s, request) {
  const socket = unixConnect(join(home, "services", s.serviceId, "control.sock"));
  await once(socket, "connect");
  socket.end(JSON.stringify(request) + "\n");
  let output = "";
  for await (const b of socket) output += b;
  return JSON.parse(output);
}
async function discardControlResponse(s, request) {
  const socket = unixConnect(join(home, "services", s.serviceId, "control.sock"));
  await once(socket, "connect");
  await new Promise((resolve, reject) => {
    socket.write(JSON.stringify(request) + "\n", (error) => (error ? reject(error) : resolve()));
  });
  socket.destroy();
}
let current;
try {
  await mkdir(workspace);
  setPhase("managed-model-reconnect");
  const managedWorkspace = join(root, "managed-workspace");
  const managedConfig = join(root, "managed-config.toml");
  await mkdir(managedWorkspace);
  const managedModel = (name) =>
    `schema_version = 1\n[model]\ncatalog_version = 1\nprovider = "fixture"\nname = "${name}"\n[model.providers.fixture]\nprotocol = "chat-completions"\nendpoint = "http://127.0.0.1:${model.address().port}"\nmodels = [{id="first",enabled=true},{id="second",enabled=true}]\n`;
  await writeFile(managedConfig, managedModel("first"));
  const managedArgs = ["--workspace", managedWorkspace, "--config", managedConfig];
  const managed = await cli(["service", "ensure", "--json", ...managedArgs]);
  await writeFile(managedConfig, managedModel("second"));
  const reconnected = await cli([
    "service",
    "ensure",
    "--json",
    ...managedArgs,
    "--no-auto-restart",
  ]);
  assert.equal(
    reconnected.generation,
    managed.generation,
    "托管模型目录尚未应用时，重新连接必须保留现有 Core",
  );
  await stop(managed);
  await writeFile(
    config,
    `schema_version = 1\n[model]\nname = "fixture"\n[model.providers.default]\nprotocol = "chat-completions"\nendpoint = "http://127.0.0.1:${model.address().port}"\n`,
  );
  const services = await Promise.all(Array.from({ length: 4 }, () => ensure()));
  current = services[0];
  setPhase("discovery-and-ownership");
  assert(
    services.every(
      (s) =>
        s.serviceId === current.serviceId &&
        s.generation === current.generation &&
        s.corePid === current.corePid,
    ),
  );
  const webEndpoint = await cli(["web", "--json", ...local]);
  assert.equal(webEndpoint.hostId, current.owner.hostId);
  assert.equal(webEndpoint.generation, current.owner.generation);
  assert.equal((await ensure(["--runtime-max-processes", "4"])).generation, current.generation);
  assert.equal((await ensure(["--no-auto-restart"])).generation, current.generation);
  await rejected(
    () => ensure(["--no-auto-restart", "--runtime-max-processes", "32"]),
    /configuration conflict|explicit lifecycle restart/s,
  );
  assert.equal(
    (await cli(["service", "status", "--instance", current.serviceId])).generation,
    current.generation,
    "GUI discovery cannot replace an existing service for configuration drift",
  );
  assert.equal((await ensure(["--sandbox-profile", "full-access"])).generation, current.generation);
  await rejected(
    () => ensure(["--sandbox-profile", "native"]),
    /configuration conflict.*permissions/s,
  );
  await assert.rejects(
    () => ensure(["--runtime-max-processes", "32"]),
    (error) => {
      const message = JSON.parse(error.stderr.trim()).error.message;
      assert.match(message, /configuration conflict.*runtime/s);
      assert(message.includes(`${bin} service restart`));
      assert(message.includes(`--workspace ${workspace}`));
      assert(message.includes(`--config ${config}`));
      assert(message.includes("--runtime-max-processes=32"));
      return true;
    },
  );
  await symlink(workspace, join(root, "alias"));
  assert.equal((await ensure(["--workspace", join(root, "alias")])).generation, current.generation);
  await rejected(
    () => ensure(["--permissions", "ASK_PERMISSIONS"]),
    /configuration conflict.*permissions/s,
  );
  assert.equal((await fetch(current.webUrl)).status, 200);
  const url = new URL("/areal/service", current.webUrl);
  assert.equal((await fetch(url)).status, 401);
  const auth = JSON.parse(await readFile(current.authFile, "utf8")).principals[0].token;
  assert.equal(
    (
      await fetch(url, {
        headers: { Authorization: `Bearer ${auth}`, Origin: "https://untrusted.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await (await fetch(url, { headers: { Authorization: `Bearer ${auth}` } })).json()).generation,
    current.generation,
  );
  assert(!JSON.stringify(current).includes(auth));
  setPhase("stop-operation-capabilities");
  assert.deepEqual(
    await cli([
      "service",
      "capabilities",
      "--json",
      "--instance",
      current.serviceId,
      "--expected-generation",
      current.generation,
    ]),
    { version: 1, stopOperations: 1 },
  );
  assert.deepEqual(await operation(current, crypto.randomUUID()), { operation: null });
  assert.equal(
    (await control(current, { method: "stop", version: 1, generation: "stale", cancel: true }))
      .result,
    "error",
  );
  for (const cancel of [false, true]) {
    const response = await control(current, {
      method: "stop",
      version: 1,
      generation: current.generation,
      cancel,
    });
    assert.equal(response.result, "error");
    assert.match(response.message, /legacy stop requests are disabled/);
    const observed = await cli(["service", "status", "--instance", current.serviceId]);
    assert.equal(observed.state, "ready");
    assert.equal(observed.generation, current.generation);
    assert.equal(observed.corePid, current.corePid);
  }
  const first = await client(current),
    second = await client(current);
  setPhase("busy-service-and-shared-windows");
  const { thread } = await first.call("areal/thread/start", {
    requestId: crypto.randomUUID(),
    cwd: workspace,
  });
  await second.call("thread/resume", { threadId: thread.id });
  await first.call("areal/turn/start", {
    requestId: crypto.randomUUID(),
    threadId: thread.id,
    input: [{ type: "text", text: "hang" }],
  });
  await until(() => held.length > 0);
  await first.close();
  await rejected(() => stop(current), /service is busy/);
  const blockedRequestId = crypto.randomUUID();
  const blockedStop = await requestStop(current, blockedRequestId);
  assert.equal(blockedStop.state, "blocked");
  assert.equal(blockedStop.requestId, blockedRequestId);
  assert.equal(blockedStop.generation, current.generation);
  assert.equal(blockedStop.cancel, false);
  assert.deepEqual((await operation(current, blockedRequestId)).operation, blockedStop);
  assert.deepEqual(await requestStop(current, blockedRequestId), blockedStop);
  await rejected(() => requestStop(current, blockedRequestId, true), /request.*conflict/i);
  assert.equal(held.length, 1, "conflicting request must not cancel the active turn");
  held.shift()();
  const completed = await second.waitEvent("turn/completed", (p) => p.threadId === thread.id);
  assert.equal(completed.turn.status, "completed");
  await exec("python3", ["-I", "-S", resolve("scripts/local-service-pty.py"), bin, ...local], {
    env,
    timeout: 45000,
  });
  assert.equal(
    (await cli(["service", "status", "--instance", current.serviceId])).generation,
    current.generation,
  );
  const ws2 = join(root, "other");
  setPhase("workspace-isolation");
  await mkdir(ws2);
  const other = await ensure(["--workspace", ws2]);
  assert.notEqual(other.serviceId, current.serviceId);
  await rejected(
    () => ensure(["--workspace", ws2, "--data-dir", current.dataDir]),
    /bound to a different workspace|dataDir already registered/s,
  );
  await stop(other);
  // 没有配置模型的 Web 管理入口仍须能启动并输出发现信息。
  const empty = join(root, "empty.toml");
  await writeFile(empty, "schema_version = 1\n");
  const unconfigured = await ensure(["--workspace", ws2, "--config", empty, "--no-auto-restart"]);
  await stop(unconfigured);
  setPhase("cancel-stop-and-history-recovery");
  await second.call("areal/turn/start", {
    requestId: crypto.randomUUID(),
    threadId: thread.id,
    input: [{ type: "text", text: "hang" }],
  });
  await until(() => held.length > 0);
  const stopRequestId = crypto.randomUUID();
  const stoppedTopology = await serviceProcesses(current);
  process.kill(stoppedTopology.launcher, "SIGSTOP");
  try {
    await discardControlResponse(current, {
      method: "stopOperation",
      version: 1,
      generation: current.generation,
      requestId: stopRequestId,
      cancel: true,
    });
    await until(
      async () =>
        (await operation(current, stopRequestId)).operation?.lifecycle?.settled?.allowed === true,
    );
    assert.equal(
      (await operation(current, stopRequestId)).operation?.state,
      "acceptedPending",
      "Core settlement must not complete a stop while the launcher still holds the service lease",
    );
  } finally {
    try {
      process.kill(stoppedTopology.launcher, "SIGCONT");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  let completedStop;
  await until(async () => {
    completedStop = (await operation(current, stopRequestId)).operation;
    return completedStop?.state === "completed";
  }, 60000);
  assert.equal(completedStop.requestId, stopRequestId);
  assert.equal(completedStop.generation, current.generation);
  assert.equal(completedStop.cancel, true);
  assert.equal(
    (await cli(["service", "status", "--instance", current.serviceId])).state,
    "stopped",
  );
  assert.deepEqual(await requestStop(current, stopRequestId, true), completedStop);
  await dead(current.corePid);
  const old = current;
  current = await ensure();
  assert.equal(current.serviceId, old.serviceId);
  assert.notEqual(current.generation, old.generation);
  assert.deepEqual((await operation(old, stopRequestId)).operation, completedStop);
  await rejected(() => requestStop(current, stopRequestId, true), /request.*conflict/i);
  assert.equal((await cli(["service", "status", "--instance", current.serviceId])).state, "ready");
  lifecycleChecks.push({
    fault: "stop-response-discarded",
    requestId: stopRequestId,
    generation: old.generation,
    observedState: completedStop.state,
    replacementGeneration: current.generation,
  });
  const resumed = await client(current);
  const snapshot = await resumed.call("thread/resume", { threadId: thread.id });
  assert.equal(snapshot.thread.turns.length, 2);
  await resumed.close();
  // 强杀启动器和宿主均须关闭旧 Core/Runtime，然后才能产生下一代实例。
  for (const victim of ["launcher", "host"]) {
    setPhase(`${victim}-killed`);
    const { launcher, runtime, processes } = await serviceProcesses(current);
    let interruptedRequestId;
    if (victim === "host") {
      // 让 Runtime 清理停在可观测窗口：Core 锁已释放，launcher 仍须阻止替代实例。
      process.kill(runtime, "SIGSTOP");
      try {
        interruptedRequestId = crypto.randomUUID();
        await discardControlResponse(current, {
          method: "stopOperation",
          version: 1,
          generation: current.generation,
          requestId: interruptedRequestId,
          cancel: true,
        });
        await until(
          async () =>
            (await operation(current, interruptedRequestId)).operation?.state === "acceptedPending",
        );
        process.kill(current.hostPid, "SIGKILL");
        try {
          process.kill(current.corePid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
        await dead(current.hostPid);
        await dead(current.corePid);
        await rejected(() => ensure(), /active owner but cannot be reached/);
      } finally {
        process.kill(runtime, "SIGCONT");
      }
    } else {
      process.kill(launcher, "SIGKILL");
    }
    for (const pid of processes) await dead(pid);
    const lifecycleCheck = { fault: `${victim}-killed`, descendantsExited: processes };
    lifecycleChecks.push(lifecycleCheck);
    await faultStatus(current, "stopped");
    const previous = current;
    // 恢复期间并发查询发现状态，探测不能临时抢走新宿主的实例锁。
    const [replacement, ...statuses] = await Promise.all([
      ensure(),
      ...Array.from({ length: 3 }, () =>
        cli(["service", "status", "--instance", previous.serviceId]),
      ),
    ]);
    current = replacement;
    assert.notEqual(current.generation, previous.generation);
    if (interruptedRequestId) {
      const interrupted = (await operation(previous, interruptedRequestId)).operation;
      assert.equal(interrupted.state, "admissionUnknown");
      assert.deepEqual(await requestStop(previous, interruptedRequestId, true), interrupted);
      assert.equal(
        (await cli(["service", "status", "--instance", current.serviceId])).state,
        "ready",
      );
      lifecycleCheck.interruptedOperation = interrupted;
    }
    for (const status of statuses) {
      assert.equal(status.serviceId, current.serviceId);
      if (status.generation === previous.generation) assert.equal(status.state, "stopped");
      else {
        assert.equal(status.generation, current.generation);
        assert.equal(status.state, "ready");
      }
    }
    lifecycleCheck.concurrentStatuses = statuses.map(({ generation, state }) => ({
      generation,
      state,
    }));
  }
  if (process.platform === "darwin") {
    setPhase("launcher-bridge-killed");
    // 强杀桥没有真实 wait/reap 回执，必须保留 unavailable，不能冒充干净停止。
    const topology = await serviceProcesses(current);
    assert.notEqual(topology.launcherBridge, current.hostPid);
    process.kill(topology.launcherBridge, "SIGKILL");
    await dead(topology.launcherBridge);
    for (const pid of [topology.launcher, ...topology.processes]) await dead(pid);
    await faultStatus(current, "unavailable");
    lifecycleChecks.push({
      fault: "launcher-bridge-killed",
      state: "unavailable",
      descendantsExited: [topology.launcher, ...topology.processes],
    });
    const previousBridgeGeneration = current.generation;
    current = await ensure();
    assert.notEqual(current.generation, previousBridgeGeneration);
    setPhase("runtime-stalled");
    const { launcher, runtimeOwner, runtime, processes } = await serviceProcesses(current);
    assert.notEqual(
      runtimeOwner,
      launcher,
      "macOS Runtime must have a waiting system Python parent",
    );
    const { stdout } = await exec("/bin/ps", ["-p", `${runtimeOwner},${runtime}`, "-o", "pgid="]);
    assert.deepEqual(stdout.trim().split(/\s+/).map(Number), [runtimeOwner, runtimeOwner]);
    // Runtime 停住时启动器必须强制清理整组，不能只杀中转进程就释放实例锁。
    process.kill(runtime, "SIGSTOP");
    try {
      process.kill(launcher, "SIGTERM");
      for (const pid of processes) await dead(pid, 60000);
      await dead(launcher);
    } finally {
      try {
        process.kill(runtime, "SIGCONT");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    lifecycleChecks.push({ fault: "runtime-stalled", descendantsExited: processes });
    const previous = current;
    current = await ensure();
    assert.notEqual(current.generation, previous.generation);
  }
  setPhase("explicit-stop-with-open-window");
  await exec("python3", ["-I", "-S", resolve("scripts/local-service-pty.py"), bin, ...local], {
    env: { ...env, TEST_EXPLICIT_STOP: "1" },
    timeout: 45000,
  });
  assert.equal(
    (await cli(["service", "status", "--instance", current.serviceId])).state,
    "stopped",
  );
  await cli(["service", "bind", ...local.slice(0, 2), "--data-dir", current.dataDir]);
  assert.equal((await ensure()).serviceId, current.serviceId);
  assert(
    (await cli(["service", "list", "--json"])).some(
      (s) => s.serviceId === current.serviceId && s.state === "ready",
    ),
  );
  held.splice(0);
  setPhase("model-hot-reload");
  current = await ensure();
  const hot = await client(current);
  const hotConfig = (name, extra = "") =>
    `schema_version = 1\n[model]\nname = "${name}"\n[model.providers.default]\nprotocol = "chat-completions"\nendpoint = "http://127.0.0.1:${model.address().port}"\n${extra}`;
  const { thread: hotThread } = await hot.call("areal/thread/start", {
    requestId: crypto.randomUUID(),
    cwd: workspace,
  });
  await hot.call("areal/turn/start", {
    requestId: crypto.randomUUID(),
    threadId: hotThread.id,
    input: [{ type: "text", text: "hang" }],
  });
  await until(() => held.length > 0);
  await hot.call("areal/turn/enqueue", {
    requestId: crypto.randomUUID(),
    threadId: hotThread.id,
    input: [{ type: "text", text: "queued-before-reload" }],
  });
  await writeFile(config, hotConfig("fixture-new"));
  await until(async () =>
    (await hot.call("areal/model/list", {})).data.some((m) => m.modelId === "fixture-new"),
  );
  assert.equal((await ensure()).generation, current.generation);
  assert.equal(
    (await cli(["service", "status", "--workspace", workspace])).generation,
    current.generation,
  );
  await rejected(() => cli(["service", "restart", ...local]), /service is busy/);
  assert.equal((await hot.call("areal/server/status", {})).acceptingWork, true);
  held.shift()();
  await until(() => requests.some((r) => r.text === "queued-before-reload"));
  assert.equal(requests.find((r) => r.text === "queued-before-reload").model, "fixture");
  await until(
    async () =>
      (await hot.call("thread/read", { threadId: hotThread.id, includeTurns: true })).thread.status
        .type === "idle",
  );
  await hot.call("areal/turn/start", {
    requestId: crypto.randomUUID(),
    threadId: hotThread.id,
    input: [{ type: "text", text: "after-reload" }],
  });
  await until(() => requests.some((r) => r.text === "after-reload"));
  assert.equal(requests.find((r) => r.text === "after-reload").model, "fixture");
  await until(async () => (await hot.call("areal/server/status", {})).restartSafe);
  const { thread: newHotThread } = await hot.call("areal/thread/start", {
    requestId: crypto.randomUUID(),
    cwd: workspace,
  });
  await hot.call("areal/turn/start", {
    requestId: crypto.randomUUID(),
    threadId: newHotThread.id,
    input: [{ type: "text", text: "new-thread-after-reload" }],
  });
  await until(() => requests.some((r) => r.text === "new-thread-after-reload"));
  assert.equal(requests.find((r) => r.text === "new-thread-after-reload").model, "fixture-new");
  await until(async () => (await hot.call("areal/server/status", {})).restartSafe);
  const { thread: beforeReset } = await hot.call("thread/read", {
    threadId: hotThread.id,
    includeTurns: true,
  });
  await hot.call("areal/thread/configure", {
    requestId: crypto.randomUUID(),
    threadId: hotThread.id,
    expectedRevision: beforeReset.desktop.configuration.revision,
    resetModel: true,
  });
  await hot.call("areal/turn/start", {
    requestId: crypto.randomUUID(),
    threadId: hotThread.id,
    input: [{ type: "text", text: "after-default-reset" }],
  });
  await until(() => requests.some((r) => r.text === "after-default-reset"));
  assert.equal(requests.find((r) => r.text === "after-default-reset").model, "fixture-new");
  await until(async () => (await hot.call("areal/server/status", {})).restartSafe);
  // 非法编辑保留旧配置，修复后无需重启即可再次更新。
  await writeFile(config, "schema_version = 1\n[model\n");
  await until(async () => (await hot.call("areal/server/status", {})).configuration.error);
  assert((await hot.call("areal/model/list", {})).data.some((m) => m.modelId === "fixture-new"));
  await rejected(() => ensure(), /Parse/);
  assert.equal(
    (await cli(["service", "status", "--workspace", workspace])).generation,
    current.generation,
  );
  await writeFile(config, hotConfig("fixture-new"));
  await until(async () => !(await hot.call("areal/server/status", {})).configuration.error);
  // 暂停队列跨重启恢复，仍使用提交时的默认模型版本。
  setPhase("queue-restart");
  const q = await hot.call("areal/queue/list", { threadId: hotThread.id });
  await hot.call("areal/queue/pause", { threadId: hotThread.id, expectedRevision: q.revision });
  await hot.call("areal/turn/enqueue", {
    requestId: crypto.randomUUID(),
    threadId: hotThread.id,
    input: [{ type: "text", text: "queued-across-restart" }],
  });
  await writeFile(config, hotConfig("fixture-third"));
  await until(async () =>
    (await hot.call("areal/model/list", {})).data.some((m) => m.modelId === "fixture-third"),
  );
  const beforeRestart = current;
  current = await cli(["service", "restart", ...local, "--cancel"]);
  assert.notEqual(current.generation, beforeRestart.generation);
  const restored = await client(current);
  await restored.call("thread/resume", { threadId: hotThread.id });
  const paused = await restored.call("areal/queue/list", { threadId: hotThread.id });
  await restored.call("areal/queue/resume", {
    threadId: hotThread.id,
    expectedRevision: paused.revision,
  });
  await until(() => requests.some((r) => r.text === "queued-across-restart"));
  assert.equal(requests.find((r) => r.text === "queued-across-restart").model, "fixture-new");
  await until(async () => (await restored.call("areal/server/status", {})).restartSafe);
  // 新凭据仅存在于客户端环境时，先保留忙碌服务，空闲后由 ensure 自动继承。
  setPhase("credential-restart");
  await restored.call("areal/turn/start", {
    requestId: crypto.randomUUID(),
    threadId: hotThread.id,
    input: [{ type: "text", text: "hang" }],
  });
  await until(() => held.length > 0);
  await writeFile(
    config,
    hotConfig("fixture-credentials", 'api_key_env = "TEST_MODEL_ROTATED_KEY"\n'),
  );
  await until(async () => {
    const { configuration } = await restored.call("areal/server/status", {});
    return configuration.restartRequired && configuration.error;
  });
  // 缺密钥允许解析管理连接；忙碌服务仍不可被重启或替换。
  await rejected(() => ensure(), /service is busy/);
  env.TEST_MODEL_ROTATED_KEY = "fixture-rotated-key";
  await rejected(() => ensure(), /service is busy/);
  assert.equal((await restored.call("areal/server/status", {})).acceptingWork, true);
  assert.equal(
    (await cli(["service", "status", "--workspace", workspace])).generation,
    current.generation,
  );
  // 慢速宿主可能已触发流重试，等待当前仍连接的响应再释放。
  await until(() => held.length > 0);
  held.shift()();
  await until(async () => (await restored.call("areal/server/status", {})).restartSafe);
  const beforeCredentialRestart = current;
  const applied = await Promise.all([ensure(), ensure()]);
  current = applied[0];
  assert.notEqual(current.generation, beforeCredentialRestart.generation);
  assert.equal(applied[1].generation, current.generation);
  const refreshed = await client(current);
  const { thread: beforeCredentialReset } = await refreshed.call("thread/resume", {
    threadId: hotThread.id,
  });
  await refreshed.call("areal/thread/configure", {
    requestId: crypto.randomUUID(),
    threadId: hotThread.id,
    expectedRevision: beforeCredentialReset.desktop.configuration.revision,
    resetModel: true,
  });
  await refreshed.call("areal/turn/start", {
    requestId: crypto.randomUUID(),
    threadId: hotThread.id,
    input: [{ type: "text", text: "after-credential-restart" }],
  });
  await until(() => requests.some((r) => r.text === "after-credential-restart"));
  const authenticated = requests.find((r) => r.text === "after-credential-restart");
  assert.equal(authenticated.model, "fixture-credentials");
  assert.equal(authenticated.authorization, "Bearer fixture-rotated-key");
  await until(async () => (await refreshed.call("areal/server/status", {})).restartSafe);
  assert.equal((await ensure()).generation, current.generation);
  // 不可热更新的限额由 ensure 在空闲时自动重启，保留会话。
  setPhase("limit-restart-and-open-window");
  await writeFile(config, hotConfig("fixture-third", "[limits]\nmax_threads = 1234\n"));
  const previousGeneration = current.generation;
  await rejected(() => ensure(["--no-auto-restart"]), /explicit lifecycle restart/);
  assert.equal(
    (await cli(["service", "status", "--instance", current.serviceId])).generation,
    previousGeneration,
    "configuration drift cannot make GUI discovery stop a live service",
  );
  current = await ensure();
  assert.notEqual(current.generation, previousGeneration);
  const finalClient = await client(current);
  assert.equal((await finalClient.call("areal/server/status", {})).capacity.maxThreads, 1234);
  assert(
    (await finalClient.call("thread/resume", { threadId: hotThread.id })).thread.turns.length >= 4,
  );
  await exec("python3", ["-I", "-S", resolve("scripts/local-service-pty.py"), bin, ...local], {
    env: { ...env, TEST_RELOAD_CONFIG: config },
    timeout: 60000,
  });
  await cli(["service", "stop", "--workspace", workspace]);
  setPhase("complete");
  passed = true;
  console.log(
    "PASS shared local service: concurrent ensure, TUI windows, Web discovery, auth, busy/cancel stop, workspace isolation, history and crash recovery",
  );
} finally {
  for (const c of clients) await c.close().catch(() => {});
  for (const s of await cli(["service", "list"]).catch(() => []))
    if (s.state === "ready") await stop(s, true).catch((e) => console.error(e.stderr ?? e));
  model.closeAllConnections();
  model.close();
  await writeFile(
    evidence,
    JSON.stringify(
      {
        passed,
        platform: process.platform,
        binary: bin,
        binarySha256: createHash("sha256")
          .update(await readFile(bin))
          .digest("hex"),
        lifecycleChecks,
        phase,
        faultStatusWaits,
        service: current ? { serviceId: current.serviceId, generation: current.generation } : null,
      },
      null,
      2,
    ),
  );
  console.log(`Evidence: ${evidence}`);
  if (passed) await rm(root, { recursive: true, force: true });
}
