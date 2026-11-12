import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { trackedMkdtemp } from "../clients/gui/scripts/support/host-cleanup.cjs";
import { createServer } from "node:http";
import { connect as unixConnect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { connect } from "../examples/desktop-api/client.mjs";
import { respondToSessionName } from "./model-fixture.mjs";

const exec = promisify(execFile);
const repository = await realpath(new URL("..", import.meta.url).pathname);
const root = await realpath(await trackedMkdtemp("/tmp/ah-"));
const home = join(root, "home");
const evidencePath = resolve(
  process.env.AREAL_TEST_EVIDENCE ??
    join(repository, ".scratch/shared-host", `backend-${Date.now()}.json`),
);
const binaryDirectory = resolve(
  process.env.AREAL_TEST_BIN_DIR ?? join(repository, ".local/shared-host-bin"),
);
const binary = join(binaryDirectory, "areal");
const legacyDirectory =
  process.env.AREAL_LEGACY_TEST_BIN_DIR && resolve(process.env.AREAL_LEGACY_TEST_BIN_DIR);
const legacyBinary = legacyDirectory && join(legacyDirectory, "areal");
const scenarios = [
  ["prerequisites", "完整固定真实产物、隔离 home/workspace、源码和产物身份"],
  ["legacy-start", "旧无 owner 服务先运行活动 Turn"],
  ["host-lock-and-auth", "并发启动单赢家、UID/权限、握手、错误 token 与非法帧拒绝"],
  ["registration-receipts", "登记幂等冲突、回复丢失后只查询原 requestId"],
  ["legacy-migration", "忙时保留原 generation，空闲清理后重启并保留历史"],
  ["disconnect-reconnect", "原生 API 客户端断开后同一 Turn 继续且工具副作用仅一次"],
  ["project-isolation", "不同 cwd/配置/合成凭据独立，状态和耐久记录无秘密"],
  ["host-crash", "杀死本次 Host，EOF 清理全部后代并释放锁后才能恢复"],
  ["busy-and-cancel-stop", "活动 Turn 的 ifIdle 拒绝，cancel 清理并保存耐久回执"],
  ["offline-operation", "停止后只读查询原回执不重新启动 Host"],
].map(([id, contract]) => ({ id, contract, state: "notRun" }));
const evidence = {
  version: 1,
  scope: "H1 backend integration with deterministic local model",
  root,
  home,
  platform: process.platform,
  scenarios,
  securityPromptObservation: "notObservedByRunner",
  peerUidCoverage: "same UID accepted; cross-UID connection not executed",
  excluded: [
    "actual interactive TUI acceptance",
    "GUI",
    "Remote",
    "real provider",
    "package",
    "launchd/systemd",
  ],
  processes: [],
  operations: [],
  modelRequests: [],
  cleanup: [],
};
const secrets = new Set();
const clients = [];
const hosts = [];
const services = new Map();
const held = new Map();
const projects = [];
let pausedServiceHost;
let activeScenario;
let descriptor;
let hostClient;
let modelFailure;
let passed = false;
const env = {
  PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
  LANG: "C.UTF-8",
  HOME: join(root, "user"),
  AREAL_HARNESS_HOME: home,
  OTEL_SDK_DISABLED: "true",
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
};
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const digest = (value) => createHash("sha256").update(value).digest("hex");
function sanitized(value) {
  let text = JSON.stringify(value);
  for (const secret of secrets) text = text.replaceAll(secret, "<redacted>");
  return JSON.parse(text);
}
async function phase(id, run) {
  activeScenario = scenarios.find((entry) => entry.id === id);
  activeScenario.state = "running";
  activeScenario.startedAt = new Date().toISOString();
  console.log(`Phase ${id}`);
  await run();
  if (modelFailure) throw modelFailure;
  activeScenario.state = "passed";
}
async function until(check, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (modelFailure) throw modelFailure;
    const result = await check();
    if (result) return result;
    await delay(50);
  }
  throw Error(`Timed out waiting for ${message}`);
}
async function cli(args, options = {}) {
  const { stdout } = await exec(options.binary ?? binary, args, {
    env: { ...env, ...options.env },
    cwd: options.cwd ?? root,
    timeout: 90000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}
async function processTable() {
  const { stdout } = await exec("/bin/ps", ["-axo", "pid=,ppid=,stat=,comm="]);
  return stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [, pid, parent, state, command] = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      return { pid: Number(pid), parent: Number(parent), state, command };
    });
}
async function descendants(pid) {
  const rows = await processTable();
  const ids = new Set([pid]);
  for (let size = 0; size !== ids.size;) {
    size = ids.size;
    for (const row of rows) if (ids.has(row.parent)) ids.add(row.pid);
  }
  return rows.filter((row) => ids.has(row.pid));
}
async function exited(pids) {
  await until(
    async () => {
      const rows = await processTable();
      return pids.every(
        (pid) => !rows.some((row) => row.pid === pid && !row.state.startsWith("Z")),
      );
    },
    `owned PIDs to exit: ${pids.join(",")}`,
    60000,
  );
}
async function lockAvailable(path) {
  const source =
    "import os,fcntl,sys\nf=os.open(sys.argv[1],os.O_RDWR|os.O_NOFOLLOW)\ntry:\n fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\n print('true')\nexcept BlockingIOError:\n print('false')\nfinally:\n os.close(f)";
  const { stdout } = await exec("/usr/bin/python3", ["-I", "-S", "-c", source, path]);
  return JSON.parse(stdout);
}
async function serviceLocks(service, available) {
  for (const filename of ["service.lock", "owner.lock"])
    assert.equal(
      await lockAvailable(join(service.dataDir, filename)),
      available,
      `${filename} availability`,
    );
}
function ownService(service, fixtureBinary = binary) {
  assert(service && service.serviceId && service.generation && service.hostPid && service.corePid);
  services.set(`${service.serviceId}:${service.generation}`, { service, binary: fixtureBinary });
  return service;
}
async function coreClient(service) {
  const client = await connect(service.endpoint, service.authFile);
  secrets.add(client.token);
  clients.push(client);
  return client;
}
async function startTurn(client, workspace, text, threadId) {
  const thread =
    threadId ??
    (await client.call("areal/thread/start", { requestId: randomUUID(), cwd: workspace })).thread
      .id;
  const requestId = randomUUID();
  const result = await client.call("areal/turn/start", {
    requestId,
    threadId: thread,
    input: [{ type: "text", text }],
  });
  return { threadId: thread, requestId, turnId: result.turn.id };
}
function reply(response, delta, finishReason = "stop") {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`,
  );
}
const model = createServer(async (request, response) => {
  try {
    let bytes = "";
    for await (const part of request) bytes += part;
    const input = JSON.parse(bytes);
    if (respondToSessionName(input, response)) return;
    const text = input.messages.findLast(
      (message) =>
        message.role === "user" &&
        !(
          typeof message.content === "string" &&
          message.content.startsWith("AReaL runtime context (not a user request):")
        ),
    ).content;
    const results = input.messages.filter((message) => message.role === "tool");
    evidence.modelRequests.push({
      text,
      model: input.model,
      toolResults: results.length,
      authorizationDigest: digest(request.headers.authorization ?? ""),
    });
    if (text === "runtime-crash" && !results.length) {
      return reply(
        response,
        {
          tool_calls: [
            {
              index: 0,
              id: "call-runtime-crash",
              type: "function",
              function: {
                name: "run_command",
                arguments: JSON.stringify({
                  argv: [
                    "/bin/sh",
                    "-c",
                    "printf 'started\\n' > crash-command-started; exec /bin/sleep 300",
                  ],
                  cwd: ".",
                  timeoutMs: 300000,
                }),
              },
            },
          ],
        },
        "tool_calls",
      );
    }
    if (text.startsWith("effect-") && !results.length) {
      return reply(
        response,
        {
          tool_calls: [
            {
              index: 0,
              id: `call-${text}`,
              type: "function",
              function: {
                name: "run_command",
                arguments: JSON.stringify({
                  argv: [
                    "/bin/sh",
                    "-c",
                    "pwd > observed-cwd; printf '%s\\n' \"$TERM\" > observed-env; printf 'once\\n' >> effect-count",
                  ],
                  cwd: ".",
                  timeoutMs: 10000,
                }),
              },
            },
          ],
        },
        "tool_calls",
      );
    }
    if (text.startsWith("hang-") || text === "effect-reconnect") {
      const finish = () => {
        held.delete(text);
        reply(response, { content: `reply:${text}` });
      };
      assert(!held.has(text), `duplicate live fixture request ${text}`);
      held.set(text, finish);
      response.once("close", () => {
        if (held.get(text) === finish) held.delete(text);
      });
      return;
    }
    reply(response, { content: `reply:${text}` });
  } catch (error) {
    modelFailure = error;
    response.destroy(error);
  }
});

class HostConnection {
  constructor(socket) {
    this.socket = socket;
    this.pending = new Map();
    this.events = [];
    this.next = 0;
    let buffered = "";
    socket.on("data", (chunk) => {
      buffered += chunk.toString();
      for (let newline; (newline = buffered.indexOf("\n")) >= 0;) {
        const frame = JSON.parse(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        if (frame.id === undefined) this.events.push(frame);
        else {
          const pending = this.pending.get(frame.id);
          if (!pending) continue;
          this.pending.delete(frame.id);
          clearTimeout(pending.timer);
          if (frame.error) pending.reject(Object.assign(Error(frame.error.message), frame.error));
          else pending.resolve(frame.result);
        }
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(Error("Host connection closed; acceptance may be UNKNOWN"));
      }
      this.pending.clear();
    });
  }
  call(method, params = {}) {
    const id = `smoke-${++this.next}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error(`Host RPC timeout ${method}; acceptance may be UNKNOWN`));
      }, 90000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ version: 1, id, method, params }) + "\n");
    });
  }
  async close() {
    if (this.socket.destroyed) return;
    const closed = once(this.socket, "close");
    this.socket.destroy();
    await closed;
  }
}
async function hostConnection(identity = descriptor) {
  const token = JSON.parse(await readFile(identity.authFile, "utf8"));
  assert.equal(typeof token, "string");
  secrets.add(token);
  const socket = unixConnect(identity.socketPath);
  await once(socket, "connect");
  const client = new HostConnection(socket);
  clients.push(client);
  client.hello = await client.call("hello", {
    protocolVersions: [1],
    capabilities: ["projects", "stopOperations", "subscriptions", "legacyMigration"],
    authToken: token,
  });
  assert.equal(client.hello.hostId, identity.hostId);
  assert.equal(client.hello.generation, identity.generation);
  return client;
}
async function rejectedFrame(frame) {
  const socket = unixConnect(descriptor.socketPath);
  await once(socket, "connect");
  socket.on("error", () => {});
  let output = "";
  socket.on("data", (chunk) => {
    output += chunk;
    if (output.includes("\n")) socket.destroy();
  });
  let timedOut = false;
  const closed = new Promise((done) => socket.once("close", done));
  const timer = setTimeout(() => {
    timedOut = true;
    socket.destroy();
  }, 5000);
  socket.write(frame);
  await closed;
  clearTimeout(timer);
  assert.equal(timedOut, false, "Host must reject invalid frames without a client timeout");
  if (output.trim())
    assert(JSON.parse(output.trim()).error, "invalid frame must never return a result");
  else assert(socket.destroyed, "invalid frame must close connection");
}
function runHost() {
  const child = spawn(binary, ["host", "run"], {
    env,
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const record = { child, output: "", error: "", exit: null };
  hosts.push(record);
  child.stdout.on("data", (chunk) => {
    record.output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    record.error += chunk;
  });
  record.done = new Promise((done, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      record.exit = { code, signal };
      done(record.exit);
    });
  });
  return record;
}
async function discover() {
  return until(
    async () => {
      try {
        const value = JSON.parse(await readFile(join(home, "host/host.json"), "utf8"));
        const probe = await hostConnection(value);
        await probe.close();
        return value;
      } catch (error) {
        if (["ENOENT", "ECONNREFUSED", "ECONNRESET"].includes(error.code)) return false;
        throw error;
      }
    },
    "live Host descriptor",
    30000,
  );
}
function registration(project) {
  return {
    projectId: project.id,
    workspace: project.workspace,
    dataDir: project.dataDir,
    source: { kind: "cli" },
    defaultBinding: true,
  };
}
async function ensureProject(project) {
  const result = await cli(
    [
      "host",
      "ensure",
      "--json",
      "--project-id",
      project.id,
      "--workspace",
      project.workspace,
      "--data-dir",
      project.dataDir,
      "--config",
      project.config,
      "--allow-write",
      "--permissions",
      "YOLO",
    ],
    {
      cwd: project.workspace,
      env: {
        TERM: project.name,
        ...(project.secret ? { SHARED_HOST_FIXTURE_KEY: project.secret } : {}),
      },
    },
  );
  if (result.service) ownService(result.service);
  return result;
}
async function freshProject(name, secret) {
  const project = {
    name,
    id: randomUUID(),
    workspace: join(root, name),
    dataDir: join(root, `${name}-data`),
    config: join(root, `${name}.toml`),
    secret,
  };
  await mkdir(project.workspace);
  await mkdir(project.dataDir);
  if (secret) secrets.add(secret);
  await writeFile(
    project.config,
    `schema_version = 1\n[model]\nname = "fixture-${name}"\nmax_retries = 0\n[model.providers.default]\n${secret ? 'api_key_env = "SHARED_HOST_FIXTURE_KEY"\n' : ""}protocol = "chat-completions"\nendpoint = "http://127.0.0.1:${model.address().port}"\n`,
  );
  projects.push(project);
  return project;
}
async function register(project, client = hostClient) {
  return client.call("projects.register", {
    requestId: randomUUID(),
    expectedGeneration: descriptor.generation,
    registration: registration(project),
  });
}
function assertOwner(service) {
  assert.deepEqual(service.owner, {
    kind: "host",
    hostId: descriptor.hostId,
    generation: descriptor.generation,
  });
  assert.equal(service.state, "ready");
}
async function completedOperation(requestId) {
  return until(
    async () => {
      const result = await cli(["host", "operation", requestId, "--json"]);
      return result.operation?.state === "completed" && result.operation;
    },
    `durable completed operation ${requestId}`,
    90000,
  );
}
async function assertNoSecrets(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "auth.json" || entry.name === "control.sock") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await assertNoSecrets(path);
    else if (entry.isFile() && /\.(json|log)$/.test(entry.name)) {
      const content = await readFile(path, "utf8");
      for (const secret of secrets) assert(!content.includes(secret), `secret leaked into ${path}`);
    }
  }
}

let legacy;
let legacyThread;
let migrated;
let reconnectThread;
let lastStop;
let partialStop;
try {
  await phase("prerequisites", async () => {
    assert(
      legacyDirectory,
      "AREAL_LEGACY_TEST_BIN_DIR is required; missing legacy fixture is not a passing migration test",
    );
    assert.notEqual(
      binaryDirectory,
      legacyDirectory,
      "new and legacy artifacts require separate complete fixed slots",
    );
    await mkdir(home, { mode: 0o700 });
    await mkdir(env.HOME);
    await mkdir(dirname(evidencePath), { recursive: true });
    evidence.artifacts = [];
    for (const directory of [binaryDirectory, legacyDirectory]) {
      const components = {};
      for (const name of [
        "areal",
        "areal-runtime",
        "areal-runtime-fs",
        ...(process.platform === "linux" ? ["areal-runtime-reaper"] : []),
      ]) {
        const path = join(directory, name);
        const metadata = await lstat(path);
        assert(
          metadata.isFile() && !metadata.isSymbolicLink(),
          `fixed artifact must be a real file: ${path}`,
        );
        components[name] = digest(await readFile(path));
      }
      evidence.artifacts.push({
        directory,
        components,
        buildInfo: await cli(["build-info"], { binary: join(directory, "areal") }),
      });
    }
    evidence.source = {
      commit: (await exec("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim(),
      status: (await exec("git", ["status", "--short"], { cwd: repository })).stdout.trim(),
    };
    model.listen(0, "127.0.0.1");
    await once(model, "listening");
  });
  await phase("legacy-start", async () => {
    legacy = await freshProject("legacy");
    const service = ownService(
      await cli(
        [
          "service",
          "ensure",
          "--json",
          "--workspace",
          legacy.workspace,
          "--data-dir",
          legacy.dataDir,
          "--config",
          legacy.config,
          "--allow-write",
          "--permissions",
          "YOLO",
        ],
        { binary: legacyBinary, cwd: legacy.workspace },
      ),
      legacyBinary,
    );
    assert.equal(service.owner, undefined, "legacy fixture must really have no owner");
    legacy.service = service;
    await serviceLocks(service, false);
    legacy.client = await coreClient(service);
    legacyThread = await startTurn(legacy.client, legacy.workspace, "hang-legacy");
    await until(() => held.has("hang-legacy"), "legacy Turn model barrier");
  });
  await phase("host-lock-and-auth", async () => {
    const contenders = [runHost(), runHost()];
    descriptor = await discover();
    assert(
      contenders.some((record) => record.child.pid === descriptor.pid),
      "descriptor must identify our actual Host child",
    );
    const loser = contenders.find((record) => record.child.pid !== descriptor.pid);
    await until(() => loser.exit, "Host lock contender exit");
    assert.deepEqual(loser.exit, { code: process.platform === "darwin" ? 0 : 73, signal: null });
    assert.equal(await lockAvailable(join(home, "host.lock")), false);
    assert.equal(
      JSON.parse(await readFile(join(home, "host/host.json"), "utf8")).pid,
      descriptor.pid,
      "loser must not delete winner descriptor",
    );
    for (const [path, mode] of [
      [home, 0o700],
      [descriptor.socketPath, 0o600],
      [descriptor.authFile, 0o600],
    ]) {
      const metadata = await lstat(path);
      assert.equal(metadata.mode & 0o777, mode);
      assert.equal(metadata.uid, process.getuid());
      assert(!metadata.isSymbolicLink());
    }
    hostClient = await hostConnection();
    assert.equal(hostClient.hello.version, 1);
    for (const capability of ["projects", "stopOperations", "legacyMigration"])
      assert(
        hostClient.hello.capabilities.includes(capability),
        `required H1 capability ${capability}`,
      );
    await rejectedFrame(
      JSON.stringify({
        version: 1,
        id: "wrong-token",
        method: "hello",
        params: { protocolVersions: [1], capabilities: [], authToken: "incorrect-fixture-token" },
      }) + "\n",
    );
    await rejectedFrame(
      JSON.stringify({ version: 1, id: "unknown", method: "hello", params: {}, unknown: true }) +
        "\n",
    );
    await rejectedFrame(
      JSON.stringify({ version: 1, id: "before-hello", method: "host.status", params: {} }) + "\n",
    );
    const token = JSON.parse(await readFile(descriptor.authFile, "utf8"));
    await rejectedFrame(
      JSON.stringify({
        version: 1,
        id: "unknown-param",
        method: "hello",
        params: { protocolVersions: [1], capabilities: [], authToken: token, unknown: true },
      }) + "\n",
    );
    await rejectedFrame("x".repeat(1024 * 1024 + 1) + "\n");
    assert.equal((await hostClient.call("host.status")).generation, descriptor.generation);
    evidence.hostIdentity = descriptor;
  });
  await phase("registration-receipts", async () => {
    const requestId = randomUUID();
    const params = {
      requestId,
      expectedGeneration: descriptor.generation,
      registration: registration(legacy),
    };
    const first = await hostClient.call("projects.register", params);
    assert.deepEqual(await hostClient.call("projects.register", params), first);
    await assert.rejects(
      hostClient.call("projects.register", {
        ...params,
        registration: { ...params.registration, defaultBinding: false },
      }),
      (error) => error.code === "requestConflict",
    );
    const dropped = await freshProject("dropped");
    dropped.requestId = randomUUID();
    const connection = await hostConnection();
    const frame = {
      version: 1,
      id: "discarded-response",
      method: "projects.register",
      params: {
        requestId: dropped.requestId,
        expectedGeneration: descriptor.generation,
        registration: registration(dropped),
      },
    };
    await new Promise((done, reject) =>
      connection.socket.write(JSON.stringify(frame) + "\n", (error) =>
        error ? reject(error) : done(),
      ),
    );
    await connection.close();
    const receipt = await until(
      async () =>
        (await hostClient.call("host.operation", { requestId: dropped.requestId })).operation,
      "original dropped-response registration receipt",
    );
    assert.equal(receipt.requestId, dropped.requestId);
    assert.equal(receipt.state, "completed");
    const registrations = (await hostClient.call("projects.list")).projects;
    assert.equal(registrations.filter((item) => item.projectId === dropped.id).length, 1);
    assert.deepEqual(await hostClient.call("host.operation", { requestId: randomUUID() }), {
      operation: null,
    });
    evidence.operations.push({
      fault: "response-discarded",
      requestId: dropped.requestId,
      receipt,
    });
  });
  await phase("legacy-migration", async () => {
    const pending = await ensureProject(legacy);
    assert.equal(pending.project.state, "legacyPending");
    assert.equal(pending.service, undefined);
    assert.equal(
      pending.project.service?.generation ?? pending.project.migration?.generation,
      legacy.service.generation,
    );
    assert.equal((await legacy.client.call("areal/server/status")).acceptingWork, true);
    await serviceLocks(legacy.service, false);
    held.get("hang-legacy")();
    await legacy.client.waitEvent(
      "turn/completed",
      (event) => event.threadId === legacyThread.threadId,
    );
    await until(
      async () => (await legacy.client.call("areal/server/status")).restartSafe,
      "legacy idle settlement",
    );
    migrated = (await ensureProject(legacy)).service;
    assertOwner(migrated);
    assert.equal(migrated.serviceId, legacy.service.serviceId);
    assert.equal(migrated.dataDir, legacy.dataDir);
    assert.notEqual(migrated.generation, legacy.service.generation);
    await exited([legacy.service.hostPid, legacy.service.corePid]);
    const operationsDirectory = join(home, "services", legacy.service.serviceId, "operations");
    const receipts = await Promise.all(
      (await readdir(operationsDirectory))
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => JSON.parse(await readFile(join(operationsDirectory, name), "utf8"))),
    );
    const cleanupReceipt = receipts.find(
      (receipt) =>
        receipt.service?.generation === legacy.service.generation &&
        receipt.cleanupConfirmed === true,
    );
    assert(
      cleanupReceipt,
      "legacy migration requires a durable original-generation cleanup receipt",
    );
    const settled = await cli([
      "service",
      "operation",
      "--json",
      "--instance",
      legacy.service.serviceId,
      "--expected-generation",
      legacy.service.generation,
      "--request-id",
      cleanupReceipt.operation.requestId,
    ]);
    assert.equal(settled.operation.state, "completed");
    const client = await coreClient(migrated);
    const history = await client.call("thread/resume", { threadId: legacyThread.threadId });
    assert.equal(history.thread.turns.length, 1);
    assert.equal(evidence.modelRequests.filter((item) => item.text === "hang-legacy").length, 1);
    await serviceLocks(migrated, false);
    assert.equal((await ensureProject(legacy)).service.generation, migrated.generation);
  });
  await phase("disconnect-reconnect", async () => {
    const first = await coreClient(migrated);
    reconnectThread = await startTurn(first, legacy.workspace, "effect-reconnect");
    await until(() => held.has("effect-reconnect"), "post-tool model barrier");
    assert.equal(await readFile(join(legacy.workspace, "effect-count"), "utf8"), "once\n");
    await first.close();
    const second = await coreClient(migrated);
    const snapshot = await second.call("thread/resume", { threadId: reconnectThread.threadId });
    assert.equal(snapshot.thread.turns.length, 1);
    held.get("effect-reconnect")();
    await second.waitEvent(
      "turn/completed",
      (event) => event.threadId === reconnectThread.threadId,
    );
    assert.equal(await readFile(join(legacy.workspace, "effect-count"), "utf8"), "once\n");
    assert.equal(
      (await second.call("thread/read", { threadId: reconnectThread.threadId, includeTurns: true }))
        .thread.turns.length,
      1,
    );
    assert.equal(
      evidence.modelRequests.filter(
        (item) => item.text === "effect-reconnect" && item.toolResults === 0,
      ).length,
      1,
    );
  });
  await phase("project-isolation", async () => {
    for (const name of ["alpha", "beta"]) {
      const project = await freshProject(name, `synthetic-${name}-${randomUUID()}`);
      await register(project);
      project.service = (await ensureProject(project)).service;
      assertOwner(project.service);
      const client = await coreClient(project.service);
      const turn = await startTurn(client, project.workspace, `effect-${name}`);
      await client.waitEvent("turn/completed", (event) => event.threadId === turn.threadId);
      assert.equal(
        (await readFile(join(project.workspace, "observed-cwd"), "utf8")).trim(),
        project.workspace,
      );
      assert.equal(await readFile(join(project.workspace, "effect-count"), "utf8"), "once\n");
      assert.equal((await readFile(join(project.workspace, "observed-env"), "utf8")).trim(), name);
      const requests = evidence.modelRequests.filter(
        (request) => request.text === `effect-${name}`,
      );
      assert(requests.length >= 2);
      assert(
        requests.every(
          (request) => request.authorizationDigest === digest(`Bearer ${project.secret}`),
        ),
      );
      assert(requests.every((request) => request.model === `fixture-${name}`));
      await serviceLocks(project.service, false);
    }
    assert.notEqual(projects.find((item) => item.secret)?.service.serviceId, migrated.serviceId);
    const status = await hostClient.call("host.status");
    for (const secret of secrets) assert(!JSON.stringify(status).includes(secret));
    await assertNoSecrets(home);
    if (hostClient.hello.capabilities.includes("subscriptions")) {
      const subscription = await hostClient.call("host.subscribe");
      assert.equal(subscription.sequence, 0);
      assert.equal(subscription.generation, descriptor.generation);
      const project = await freshProject("subscription");
      await register(project);
      await until(
        () =>
          hostClient.events.some(
            (event) =>
              event.method === "host.statusChanged" &&
              event.params.subscriptionId === subscription.subscriptionId &&
              event.params.status.projects.some(
                (item) => item.registration.projectId === project.id,
              ),
          ),
        "Host subscription update",
      );
      const events = hostClient.events.filter(
        (event) => event.params?.subscriptionId === subscription.subscriptionId,
      );
      for (let index = 0; index < events.length; index++)
        assert.equal(events[index].params.sequence, index + 1);
    } else evidence.subscription = "notAdvertised";
  });
  await phase("host-crash", async () => {
    const old = descriptor;
    const crashClient = await coreClient(migrated);
    const crashTurn = await startTurn(crashClient, legacy.workspace, "runtime-crash");
    await until(
      () =>
        readFile(join(legacy.workspace, "crash-command-started"), "utf8")
          .then(() => true)
          .catch(() => false),
      "active Runtime command",
    );
    const activeThread = await crashClient.call("thread/read", {
      threadId: crashTurn.threadId,
      includeTurns: true,
    });
    const activeTurn = activeThread.thread.turns.find((turn) => turn.id === crashTurn.turnId);
    assert.equal(activeTurn?.status, "inProgress");
    const activeTool = activeTurn.items.find((item) => item.callId === "call-runtime-crash");
    assert.equal(activeTool?.status, "inProgress");
    assert.equal(activeTool.execution.outcome, "running");
    assert(activeTool.execution.operationId, "active Runtime operation must have an identity");
    const active = [...services.values()]
      .filter(({ service }) => service.owner?.generation === old.generation)
      .map(({ service }) => service);
    const topology = await descendants(old.pid);
    evidence.processes.push({ fault: "Host SIGKILL", hostGeneration: old.generation, topology });
    assert(
      topology.some((row) => row.command.endsWith("areal-runtime")),
      "real Runtime must be in Host-owned process chain",
    );
    const serviceHost = topology.find((row) => row.pid === migrated.hostPid);
    assert(
      serviceHost && serviceHost.command === binary,
      "service host must belong to this Host topology",
    );
    const serviceTree = await descendants(serviceHost.pid);
    assert(
      serviceTree.some((row) => row.pid === migrated.corePid),
      "Core must belong to the project",
    );
    const runtimes = serviceTree.filter((row) => row.command.endsWith("areal-runtime"));
    assert.equal(runtimes.length, 1, "project must have one Runtime");
    const runtimeTree = await descendants(runtimes[0].pid);
    const command = runtimeTree.find((row) => row.command.endsWith("/sleep"));
    assert(command, "active command must belong to this project's Runtime");
    evidence.processes.push({
      fault: "active Runtime command",
      threadId: crashTurn.threadId,
      requestId: crashTurn.requestId,
      turnId: crashTurn.turnId,
      turnStatus: activeTurn.status,
      callId: activeTool.callId,
      toolStatus: activeTool.status,
      runtimeOperationId: activeTool.execution.operationId,
      runtimeOutcome: activeTool.execution.outcome,
      corePid: migrated.corePid,
      runtimePid: runtimes[0].pid,
      commandPid: command.pid,
    });
    await serviceLocks(migrated, false);
    process.kill(serviceHost.pid, "SIGSTOP");
    pausedServiceHost = serviceHost.pid;
    await until(
      async () =>
        (await processTable()).some(
          (row) => row.pid === serviceHost.pid && row.state.startsWith("T"),
        ),
      "service host paused",
    );
    await serviceLocks(migrated, false);
    evidence.processes.push({
      fault: "paused old service host",
      pid: serviceHost.pid,
      turn: crashTurn,
    });
    const owner = hosts.find((record) => record.child.pid === old.pid && !record.exit);
    assert(owner, "fault injection requires our still-live Host child");
    owner.child.kill("SIGKILL");
    await owner.done;
    assert.equal(await lockAvailable(join(home, "host.lock")), true);
    const successor = runHost();
    await until(async () => {
      const candidate = await readFile(join(home, "host/host.json"), "utf8")
        .then(JSON.parse)
        .catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
      return candidate?.pid === successor.child.pid && candidate.generation !== old.generation;
    }, "successor Host descriptor");
    descriptor = await discover();
    assert.equal(descriptor.hostId, old.hostId);
    assert.notEqual(descriptor.generation, old.generation);
    hostClient = await hostConnection();
    await serviceLocks(migrated, false);
    const blockedId = randomUUID();
    await assert.rejects(
      hostClient.call("project.ensure", {
        requestId: blockedId,
        expectedGeneration: descriptor.generation,
        projectId: legacy.id,
      }),
      (error) => error.code === "migrationBlocked",
    );
    const blocked = (await hostClient.call("host.operation", { requestId: blockedId })).operation;
    assert.equal(blocked.state, "blocked");
    assert.equal(blocked.requestId, blockedId);
    assert.equal(blocked.hostId, descriptor.hostId);
    assert.equal(blocked.generation, descriptor.generation);
    assert.equal(blocked.projectId, legacy.id);
    evidence.operations.push({ fault: "old service locks held", receipt: blocked });
    await serviceLocks(migrated, false);
    const retained = JSON.parse(
      await readFile(join(home, "services", migrated.serviceId, "service.json"), "utf8"),
    );
    assert.equal(retained.generation, migrated.generation);
    process.kill(serviceHost.pid, "SIGCONT");
    pausedServiceHost = undefined;
    await exited(topology.map((row) => row.pid));
    for (const service of active) await serviceLocks(service, true);
    migrated = (await ensureProject(legacy)).service;
    assertOwner(migrated);
    assert.equal(migrated.serviceId, legacy.service.serviceId);
    assert.equal(migrated.dataDir, legacy.dataDir);
    assert.notEqual(
      migrated.generation,
      active.find((service) => service.serviceId === migrated.serviceId).generation,
    );
    const client = await coreClient(migrated);
    assert.equal(
      (await client.call("thread/resume", { threadId: reconnectThread.threadId })).thread.turns
        .length,
      1,
    );
    assert.equal(await readFile(join(legacy.workspace, "effect-count"), "utf8"), "once\n");
  });
  await phase("busy-and-cancel-stop", async () => {
    const client = await coreClient(migrated);
    const turn = await startTurn(client, legacy.workspace, "hang-stop");
    await until(() => held.has("hang-stop"), "busy stop barrier");
    const busyRequest = randomUUID();
    const blocked = await cli([
      "host",
      "stop",
      "--json",
      "--request-id",
      busyRequest,
      "--expected-generation",
      descriptor.generation,
    ]);
    assert.equal(blocked.state, "blocked");
    assert.equal(blocked.requestId, busyRequest);
    assert.equal((await client.call("areal/server/status")).acceptingWork, true);
    assert(held.has("hang-stop"), "ifIdle must not cancel the writer");
    await serviceLocks(migrated, false);
    assert.equal(
      (await client.call("thread/read", { threadId: turn.threadId, includeTurns: true })).thread
        .turns.length,
      1,
    );
    const idle = await freshProject("idle-stop");
    await register(idle);
    idle.service = (await ensureProject(idle)).service;
    const partialId = randomUUID();
    const lost = await hostConnection();
    await new Promise((done, reject) =>
      lost.socket.write(
        JSON.stringify({
          version: 1,
          id: "lost-partial-stop",
          method: "host.stop",
          params: {
            requestId: partialId,
            expectedGeneration: descriptor.generation,
            strategy: "ifIdle",
          },
        }) + "\n",
        (error) => (error ? reject(error) : done()),
      ),
    );
    await lost.close();
    partialStop = await until(async () => {
      const receipt = (await hostClient.call("host.operation", { requestId: partialId })).operation;
      return receipt?.state === "partial" ? receipt : null;
    }, "partial stop original receipt after lost response");
    assert.equal(
      partialStop.projects.find((target) => target.projectId === idle.id).receipt.state,
      "completed",
    );
    assert.equal(
      partialStop.projects.find((target) => target.projectId === legacy.id).receipt.state,
      "blocked",
    );
    await serviceLocks(idle.service, true);
    await serviceLocks(migrated, false);
    assert.equal((await client.call("areal/server/status")).acceptingWork, true);
    assert(held.has("hang-stop"), "partial ifIdle must leave the busy Turn running");
    assert.deepEqual(
      (await hostClient.call("host.operation", { requestId: partialId })).operation,
      partialStop,
      "read-only reconciliation must not redispatch completed targets",
    );
    const topology = await descendants(descriptor.pid);
    const requestId = randomUUID();
    await cli([
      "host",
      "stop",
      "--json",
      "--cancel",
      "--request-id",
      requestId,
      "--expected-generation",
      descriptor.generation,
    ]);
    lastStop = await completedOperation(requestId);
    assert.equal(lastStop.requestId, requestId);
    assert.equal(lastStop.generation, descriptor.generation);
    assert(lastStop.projects.length > 0);
    for (const target of lastStop.projects) {
      assert.equal(target.receipt.state, "completed");
      const stored = JSON.parse(
        await readFile(
          join(
            home,
            "services",
            target.serviceId,
            "operations",
            `${digest(target.requestId)}.json`,
          ),
          "utf8",
        ),
      );
      assert.equal(stored.cleanupConfirmed, true);
      assert.equal(stored.service.generation, target.serviceGeneration);
    }
    await exited(topology.map((row) => row.pid));
    await serviceLocks(migrated, true);
    assert.equal(await lockAvailable(join(home, "host.lock")), true);
    evidence.operations.push(
      { fault: "busy-ifIdle", receipt: blocked },
      { fault: "lost-partial-stop-response", receipt: partialStop },
      { fault: "cancel", receipt: lastStop },
    );
  });
  await phase("offline-operation", async () => {
    const before = await processTable();
    assert.deepEqual(
      (await cli(["host", "operation", lastStop.requestId, "--json"])).operation,
      lastStop,
    );
    assert.deepEqual(
      (await cli(["host", "operation", partialStop.requestId, "--json"])).operation,
      partialStop,
    );
    assert.equal(await lockAvailable(join(home, "host.lock")), true);
    const after = await processTable();
    assert(
      !after.some((row) => row.command === binary && !before.some((old) => old.pid === row.pid)),
      "offline query must not spawn a Host",
    );
    await assertNoSecrets(home);
    for (const artifact of evidence.artifacts)
      for (const [name, sha256] of Object.entries(artifact.components))
        assert.equal(
          digest(await readFile(join(artifact.directory, name))),
          sha256,
          "tested artifact changed during run",
        );
  });
  passed = true;
} catch (error) {
  if (activeScenario) {
    activeScenario.state = "failed";
    activeScenario.failure = { message: error.message, stack: error.stack };
  }
  process.exitCode = 1;
  console.error(sanitized({ error: error.message, phase: activeScenario?.id }));
} finally {
  if (pausedServiceHost !== undefined) {
    try {
      process.kill(pausedServiceHost, "SIGCONT");
      evidence.cleanup.push({ resumedServiceHost: pausedServiceHost });
    } catch (error) {
      if (error.code !== "ESRCH") {
        passed = false;
        process.exitCode = 1;
        evidence.cleanup.push({ resumeServiceHostError: error.message });
      }
    }
  }
  for (const client of clients)
    await client
      .close()
      .catch((error) => evidence.cleanup.push({ clientCloseError: error.message }));
  for (const record of hosts.filter((record) => !record.exit)) {
    const current = await readFile(join(home, "host/host.json"), "utf8")
      .then(JSON.parse)
      .catch(() => null);
    if (current?.pid === record.child.pid) {
      await cli([
        "host",
        "stop",
        "--json",
        "--cancel",
        "--request-id",
        randomUUID(),
        "--expected-generation",
        current.generation,
      ]).catch((error) => evidence.cleanup.push({ hostStopError: error.message }));
    }
    if (!record.exit) record.child.kill("SIGTERM");
    await Promise.race([record.done, delay(10000)]);
    if (!record.exit) {
      record.child.kill("SIGKILL");
      await record.done;
    }
    evidence.cleanup.push({ hostPid: record.child.pid, exit: record.exit });
  }
  for (const { service, binary: serviceBinary } of services.values()) {
    const available = await lockAvailable(join(service.dataDir, "service.lock")).catch(() => false);
    if (!available && service.owner === undefined) {
      await cli(
        [
          "service",
          "stop",
          "--json",
          "--instance",
          service.serviceId,
          "--expected-generation",
          service.generation,
          "--request-id",
          randomUUID(),
          "--cancel",
        ],
        { binary: serviceBinary },
      ).catch((error) =>
        evidence.cleanup.push({
          serviceId: service.serviceId,
          generation: service.generation,
          stopError: error.message,
        }),
      );
    }
    await until(
      async () =>
        (await lockAvailable(join(service.dataDir, "service.lock"))) &&
        (await lockAvailable(join(service.dataDir, "owner.lock"))),
      `cleanup locks for ${service.serviceId}`,
      60000,
    )
      .then(() => {
        evidence.cleanup.push({
          serviceId: service.serviceId,
          generation: service.generation,
          locksReleased: true,
        });
      })
      .catch((error) => {
        passed = false;
        process.exitCode = 1;
        evidence.cleanup.push({
          serviceId: service.serviceId,
          generation: service.generation,
          lockReleaseError: error.message,
        });
      });
  }
  if (model.listening) {
    model.closeAllConnections();
    await new Promise((done) => model.close(done));
  }
  evidence.passed = passed;
  evidence.finishedAt = new Date().toISOString();
  evidence.hostProcesses = hosts.map((record) => ({
    pid: record.child.pid,
    exit: record.exit,
    stdout: record.output,
    stderr: record.error,
  }));
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, JSON.stringify(sanitized(evidence), null, 2));
  console.log(`${passed ? "PASS" : "FAIL"} H1 backend integration. Evidence ${evidencePath}`);
}
